// スプラトゥーンサーバー（server/splatoon.ts）へのクライアント側接続。06 / 06-2 / 07 の *-client.ts と
// 同じ役割（WebSocket の生死・再接続・メッセージの振り分け）で、プロトコルがスプラトゥーン用になったもの
import {
  SPLATOON_PATH,
  SPLATOON_PROTOCOL_VERSION,
  type ClientMessage,
  type ClientRole,
  type FieldConfig,
  type FieldSize,
  type GameSnapshot,
  type PlayerPose,
  type ServerMessage,
  type Shot,
  type SplatoonRoomConfig,
  type V3,
} from "../../src/shared/splatoon-protocol";

const RECONNECT_DELAY_MS = 2000;

export type GameClientEvents = {
  onStatus: (status: string) => void;
  /** 入室完了。再接続でも毎回呼ばれ、そのたび自分の id は変わる。peerIds はプレイヤーだけ */
  onWelcome: (selfId: string, role: ClientRole, peerIds: string[], config: FieldConfig, state: GameSnapshot) => void;
  onPeerJoin: (id: string) => void;
  onPeerLeave: (id: string) => void;
  onPeerPose: (id: string, pose: PlayerPose) => void;
  onShot: (shot: Shot, serverT: number) => void;
  onRejected: (reason: string) => void;
  onState: (state: GameSnapshot) => void;
  /** フィールドの寸法が変わった（俯瞰画面の field）。config で壁と床を作り直してから state（格子付き）を反映する */
  onField: (config: FieldConfig, state: GameSnapshot) => void;
  onError: (reason: string) => void;
};

export type GameClient = {
  /** 送れたら true */
  sendPose: (pose: PlayerPose) => boolean;
  /** 送れたら true */
  sendShot: (pos: V3, vel: V3, radius: number) => boolean;
  /** 対戦開始（俯瞰画面だけ。送れたら true） */
  sendStart: () => boolean;
  /** フィールドの寸法の変更（俯瞰画面だけ。送れたら true） */
  sendField: (size: FieldSize) => boolean;
  dispose: () => void;
};

export function connectGame(
  room: string,
  name: string,
  config: SplatoonRoomConfig,
  events: GameClientEvents,
  role: ClientRole = "player",
): GameClient {
  const query = new URLSearchParams({
    room,
    role,
    v: String(SPLATOON_PROTOCOL_VERSION),
    markerId: String(config.markerId),
    markerMm: String(config.markerMm),
    gravity: String(config.gravity),
    matchSec: String(config.matchSec),
    waitSec: String(config.waitSec),
  });
  if (name) query.set("name", name);
  const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${SPLATOON_PATH}?${query}`;
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
        events.onWelcome(msg.id, msg.role, msg.peers, msg.config, msg.state);
        break;
      case "join":
        events.onPeerJoin(msg.id);
        break;
      case "leave":
        events.onPeerLeave(msg.id);
        break;
      case "pose":
        events.onPeerPose(msg.id, msg);
        break;
      case "shot":
        events.onShot(msg.shot, msg.t);
        break;
      case "rejected":
        events.onRejected(msg.reason);
        break;
      case "state":
        events.onState(msg.state);
        break;
      case "field":
        events.onField(msg.config, msg.state);
        break;
      case "error":
        // バージョン・設定の不一致は再接続しても同じ結果なのでループを止める。
        // 満員（役割別の上限）は、半切断した古い接続が heartbeat で消えれば入れるので再接続を続ける
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
    sendShot(pos, vel, radius) {
      return send({ type: "shot", pos, vel, radius });
    },
    sendStart() {
      return send({ type: "start" });
    },
    sendField(size) {
      return send({ type: "field", wallW: size.wallW, wallH: size.wallH, floorDepth: size.floorDepth, floorDrop: size.floorDrop });
    },
    dispose() {
      disposed = true;
      ws?.close();
    },
  };
}
