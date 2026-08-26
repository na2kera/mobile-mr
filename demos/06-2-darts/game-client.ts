// ダーツサーバー（server/darts.ts）へのクライアント側接続。06 の game-client.ts と同じ役割
// （WebSocket の生死・再接続・メッセージの振り分けをここに閉じ込める）で、プロトコルが
// ダーツ用（throw / state）になったもの
import {
  DARTS_PATH,
  DARTS_PROTOCOL_VERSION,
  type ClientMessage,
  type DartsConfig,
  type DartsRoomConfig,
  type GameState,
  type PlayerPose,
  type ServerMessage,
  type V3,
} from "../../src/shared/darts-protocol";

const RECONNECT_DELAY_MS = 2000;

export type GameClientEvents = {
  onStatus: (status: string) => void;
  /** 入室完了。再接続でも毎回呼ばれ、そのたび自分の id は変わる */
  onWelcome: (selfId: string, peerIds: string[], config: DartsConfig, state: GameState) => void;
  onPeerJoin: (id: string) => void;
  onPeerLeave: (id: string) => void;
  onPeerPose: (id: string, pose: PlayerPose) => void;
  onState: (state: GameState) => void;
  onError: (reason: string) => void;
};

export type GameClient = {
  sendPose: (pose: PlayerPose) => void;
  sendThrow: (pos: V3, vel: V3) => void;
  dispose: () => void;
};

export function connectGame(
  room: string,
  name: string,
  config: DartsRoomConfig,
  events: GameClientEvents,
): GameClient {
  const query = new URLSearchParams({
    room,
    v: String(DARTS_PROTOCOL_VERSION),
    markerId: String(config.markerId),
    markerMm: String(config.markerMm),
    gravity: String(config.gravity),
    rounds: String(config.rounds),
  });
  if (name) query.set("name", name);
  const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${DARTS_PATH}?${query}`;
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
        events.onWelcome(msg.id, msg.peers, msg.config, msg.state);
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
        events.onState(msg.state);
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
    sendThrow(pos, vel) {
      send({ type: "throw", pos, vel });
    },
    dispose() {
      disposed = true;
      ws?.close();
    },
  };
}
