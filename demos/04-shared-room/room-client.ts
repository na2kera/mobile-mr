// Room 中継サーバー（server/shared-room.ts）へのクライアント側接続。
// WebSocket の生死・再接続・メッセージの振り分けをこのファイルに閉じ込め、
// main.ts は「pose を送る / 相手のイベントを受ける」だけにする。
import {
  SHARED_ROOM_PATH,
  PROTOCOL_VERSION,
  type ClientMessage,
  type PoseData,
  type ServerMessage,
  type SpaceConfig,
} from "../../src/shared/shared-room-protocol";

/** 切断から再接続を試みるまでの待ち時間 [ms] */
const RECONNECT_DELAY_MS = 2000;

export type RoomClientEvents = {
  /** HUD 表示用の接続状態（connecting / open / reconnecting など） */
  onStatus: (status: string) => void;
  /**
   * 入室完了。再接続でも毎回呼ばれ、そのたび自分の id は変わる。
   * 受け手は既存のピア表示を捨てて peers から作り直すこと
   */
  onWelcome: (selfId: string, peerIds: string[]) => void;
  onPeerJoin: (id: string) => void;
  onPeerLeave: (id: string) => void;
  onPeerPose: (id: string, pose: PoseData) => void;
  /**
   * サーバーによる入室拒否（バージョン不一致・空間設定不一致）。
   * 再接続しても同じ結果になるため、これを受けたら再接続ループは止まる
   */
  onError: (reason: string) => void;
};

export type RoomClient = {
  /** 接続が開いていれば pose を送る（閉じていれば黙って捨てる。姿勢は使い捨てなので再送しない） */
  sendPose: (pose: PoseData) => void;
  /** 接続を閉じ、再接続ループも止める（これが無いと再接続の setTimeout 連鎖を誰も止められない） */
  dispose: () => void;
};

export function connectRoom(
  room: string,
  config: SpaceConfig,
  events: RoomClientEvents,
): RoomClient {
  // ページと同一オリジンに繋ぐ（dev サーバー同居の理由は server/shared-room.ts 参照）。
  // プロトコルバージョンと空間設定をクエリで申告し、Room 内での一致をサーバーに
  // 検証してもらう（不一致だと通信が正常でも座標が合わない。protocol の SpaceConfig 参照）
  const query = new URLSearchParams({
    room,
    v: String(PROTOCOL_VERSION),
    markerId: String(config.markerId),
    markerMm: String(config.markerMm),
  });
  const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${SHARED_ROOM_PATH}?${query}`;
  let ws: WebSocket | null = null;
  let disposed = false;

  function handleMessage(raw: string) {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(raw) as ServerMessage;
    } catch {
      return;
    }
    // 中身の詳細な検証はサーバー側（parsePoseMessage）で済んでいる前提で、
    // ここでは型の振り分けだけを行う
    switch (msg.type) {
      case "welcome":
        events.onWelcome(msg.id, msg.peers);
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
      case "error":
        // 再接続しても同じ拒否を繰り返すだけなのでループを止める
        disposed = true;
        events.onError(msg.reason);
        break;
    }
  }

  function open() {
    if (disposed) return; // 再接続待ちの間に dispose された場合
    events.onStatus("connecting");
    ws = new WebSocket(url);
    ws.addEventListener("open", () => events.onStatus("open"));
    ws.addEventListener("message", (ev) => {
      if (typeof ev.data === "string") handleMessage(ev.data);
    });
    // error は直後に close が来るので、通知と再接続は close に一本化する
    ws.addEventListener("close", () => {
      ws = null;
      if (disposed) return;
      events.onStatus(`reconnecting in ${RECONNECT_DELAY_MS / 1000}s`);
      setTimeout(open, RECONNECT_DELAY_MS);
    });
  }
  open();

  return {
    sendPose(pose) {
      if (ws?.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: "pose", ...pose } satisfies ClientMessage));
    },
    dispose() {
      disposed = true;
      ws?.close();
    },
  };
}
