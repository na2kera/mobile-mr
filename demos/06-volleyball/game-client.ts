// 対戦サーバー（server/volleyball.ts）へのクライアント側接続。04 の room-client.ts と同じ
// 役割（WebSocket の生死・再接続・メッセージの振り分けをここに閉じ込める）で、
// プロトコルがバレーボール用（hit / state）になったもの
import {
  VOLLEYBALL_PATH,
  VOLLEYBALL_PROTOCOL_VERSION,
  type ClientMessage,
  type CourtConfig,
  type GameState,
  type PlayerPose,
  type ServerMessage,
  type V3,
  type VolleyballRoomConfig,
} from "../../src/shared/volleyball-protocol";

const RECONNECT_DELAY_MS = 2000;

export type GameClientEvents = {
  onStatus: (status: string) => void;
  /** 入室完了。再接続でも毎回呼ばれ、そのたび自分の id は変わる */
  onWelcome: (selfId: string, peerIds: string[], court: CourtConfig, state: GameState) => void;
  onPeerJoin: (id: string) => void;
  onPeerLeave: (id: string) => void;
  onPeerPose: (id: string, pose: PlayerPose) => void;
  /** 権威状態（ラリー中 20Hz） */
  onState: (state: GameState, court: CourtConfig) => void;
  /** 入室拒否。再接続しても同じなのでループは止まる */
  onError: (reason: string) => void;
};

export type GameClient = {
  sendPose: (pose: PlayerPose) => void;
  sendHit: (pos: V3, handVel: V3) => void;
  dispose: () => void;
};

export function connectGame(
  room: string,
  config: VolleyballRoomConfig,
  events: GameClientEvents,
): GameClient {
  const query = new URLSearchParams({
    room,
    v: String(VOLLEYBALL_PROTOCOL_VERSION),
    markerId: String(config.markerId),
    markerMm: String(config.markerMm),
    netTop: String(config.netTop),
    gravity: String(config.gravity),
    flightSec: String(config.flightSec),
    reach: String(config.reach),
    netW: String(config.netW),
  });
  const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${VOLLEYBALL_PATH}?${query}`;
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
        events.onWelcome(msg.id, msg.peers, msg.court, msg.state);
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
      case "state":
        events.onState(msg.state, msg.court);
        break;
      case "error":
        disposed = true;
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

  const send = (msg: ClientMessage) => {
    if (ws?.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(msg));
  };

  return {
    sendPose(pose) {
      send({ type: "pose", ...pose });
    },
    sendHit(pos, handVel) {
      send({ type: "hit", pos, handVel });
    },
    dispose() {
      disposed = true;
      ws?.close();
    },
  };
}
