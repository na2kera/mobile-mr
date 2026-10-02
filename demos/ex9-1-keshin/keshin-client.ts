// 化身サーバー（server/keshin.ts）へのクライアント側接続。09 の person-client.ts と同じ役割
// （WebSocket の生死・再接続・メッセージの振り分け）で、プロトコルが化身用になったもの。スマホと俯瞰画面で共有する
import {
  KESHIN_PATH,
  KESHIN_PROTOCOL_VERSION,
  SESSION_PATTERN,
  type ClientMessage,
  type ClientRole,
  type KeshinIndex,
  type KeshinPlayer,
  type KeshinPose,
  type KeshinRoomConfig,
  type ServerMessage,
} from "../../src/shared/keshin-protocol";

const RECONNECT_DELAY_MS = 2000;


/**
 * 再接続の鍵（タブごと・役割ごと。sessionStorage に持つので再読み込み・bfcache の復帰でも同じ）。
 * サーバーは同じ役割・同じ鍵の古い接続を切って化身の番号・on・色を引き継ぐ。sessionStorage が使えなければこのページの間だけの鍵。
 * タブを複製すると sessionStorage も複製されて同じ鍵になるが、置き換えられた側は REPLACED を受けて再接続をやめる
 */
const memorySession = new Map<string, string>();
/**
 * kind は鍵の種類（既定は役割名）。鏡モードは俯瞰画面と同じ overview 役で入るが、鍵は "mirror" で分ける
 * （同じ鍵だと、俯瞰画面のタブを複製して鏡を開いたときに、サーバーが同じ人の再接続とみなして俯瞰画面を切る）
 */
function sessionKey(kind: string): string {
  const storageKey = `keshin-session-${kind}`;
  try {
    const v = sessionStorage.getItem(storageKey);
    if (v && SESSION_PATTERN.test(v)) return v;
  } catch {
    // プライベートブラウズ等で使えない
  }
  let v = memorySession.get(kind);
  if (!v) {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    v = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    memorySession.set(kind, v);
  }
  try {
    sessionStorage.setItem(storageKey, v);
  } catch {
    // 保存できなくても、このページの間の再接続には効く
  }
  return v;
}

export type KeshinClientEvents = {
  onStatus: (status: string) => void;
  /** 入室完了。再接続でも毎回呼ばれ、そのたび自分の id は変わる。players は自分を含む（俯瞰画面は含まない）。now はサーバー時刻 */
  onWelcome: (selfId: string, role: ClientRole, players: KeshinPlayer[], now: number) => void;
  /** 入室（再接続の引き継ぎで on / changedAt を持っていることがある。now はサーバー時刻） */
  onJoin: (player: KeshinPlayer, now: number) => void;
  onLeave: (id: string) => void;
  onPose: (id: string, pose: KeshinPose) => void;
  /** 化身の状態が確定した（押した本人にも届く）。経過 = now − changedAt [ms] */
  onKeshin: (id: string, on: boolean, keshin: KeshinIndex, changedAt: number, now: number) => void;
  onError: (reason: string) => void;
};

export type KeshinClient = {
  /** 送れたら true */
  sendPose: (pose: KeshinPose) => boolean;
  /** 化身を出す / 消す（送れたら true。確定はサーバーの keshin で届く） */
  sendKeshin: (on: boolean) => boolean;
  dispose: () => void;
};

export function connectKeshin(
  room: string,
  name: string,
  config: KeshinRoomConfig,
  events: KeshinClientEvents,
  role: ClientRole = "player",
  /** 再接続の鍵の種類（sessionStorage のキー。既定は役割名。鏡モードは "mirror"） */
  sessionKind: string = role,
  /** 入室のときに選んだ化身（プレイヤーだけ。null = おまかせ = サーバーが参加順に割り当てる） */
  keshin: KeshinIndex | null = null,
): KeshinClient {
  const query = new URLSearchParams({
    room,
    role,
    v: String(KESHIN_PROTOCOL_VERSION),
    markerId: String(config.markerId),
    markerMm: String(config.markerMm),
    session: sessionKey(sessionKind),
  });
  if (name) query.set("name", name);
  if (keshin !== null) query.set("keshin", String(keshin));
  const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${KESHIN_PATH}?${query}`;
  let ws: WebSocket | null = null;
  let disposed = false;

  function handleMessage(raw: string) {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(raw) as ServerMessage;
    } catch {
      return;
    }
    switch (msg.type) {
      case "welcome":
        events.onWelcome(msg.id, msg.role, msg.players, msg.now);
        break;
      case "join":
        events.onJoin(msg.player, msg.now);
        break;
      case "leave":
        events.onLeave(msg.id);
        break;
      case "pose":
        events.onPose(msg.id, msg);
        break;
      case "keshin":
        events.onKeshin(msg.id, msg.on, msg.keshin, msg.changedAt, msg.now);
        break;
      case "error":
        // バージョン・設定の不一致は再接続しても同じ結果なのでループを止める。同じ鍵の別のタブに置き換えられたときも止める
        // （2 つのタブが再接続で奪い合わないように）。
        // 満員（役割別の上限）は、半切断した古い接続が heartbeat で消えれば入れるので再接続を続ける（08 と同じ）
        if (!/満員|台まで/.test(msg.reason)) disposed = true;
        events.onError(msg.reason);
        break;
    }
  }

  function open() {
    if (disposed) return;
    events.onStatus("connecting");
    ws = new WebSocket(url);
    ws.addEventListener("open", () => events.onStatus("open"));
    ws.addEventListener("message", (ev) => {
      if (typeof ev.data === "string") handleMessage(ev.data);
    });
    ws.addEventListener("close", () => {
      ws = null;
      if (disposed) return;
      events.onStatus(`reconnecting in ${RECONNECT_DELAY_MS / 1000}s`);
      setTimeout(open, RECONNECT_DELAY_MS);
    });
  }
  open();

  const send = (msg: ClientMessage): boolean => {
    if (ws?.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(msg));
    return true;
  };

  return {
    sendPose(pose) {
      return send({ type: "pose", ...pose });
    },
    sendKeshin(on) {
      return send({ type: "keshin", on });
    },
    dispose() {
      disposed = true;
      ws?.close();
    },
  };
}
