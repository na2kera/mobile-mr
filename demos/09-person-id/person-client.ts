// Person サーバー（server/person.ts）へのクライアント側接続。04 / 06 / 06-2 / 07 / 08 の *-client.ts と
// 同じ役割（WebSocket の生死・再接続・メッセージの振り分け）で、プロトコルが Phase 9 用になったもの
import {
  PERSON_PATH,
  PERSON_PROTOCOL_VERSION,
  type ClientMessage,
  type PersonPose,
  type PersonRoomConfig,
  type PlayerInfo,
  type ServerMessage,
} from "../../src/shared/person-protocol";

const RECONNECT_DELAY_MS = 2000;

export type PersonClientEvents = {
  onStatus: (status: string) => void;
  /** 入室完了。再接続でも毎回呼ばれ、そのたび自分の id は変わる。players は自分を含む */
  onWelcome: (selfId: string, players: PlayerInfo[]) => void;
  onPeerJoin: (player: PlayerInfo) => void;
  onPeerLeave: (id: string) => void;
  onPeerPose: (id: string, pose: PersonPose) => void;
  onError: (reason: string) => void;
};

export type PersonClient = {
  /** 送れたら true */
  sendPose: (pose: PersonPose) => boolean;
  dispose: () => void;
};

export function connectPerson(room: string, name: string, config: PersonRoomConfig, events: PersonClientEvents): PersonClient {
  const query = new URLSearchParams({
    room,
    v: String(PERSON_PROTOCOL_VERSION),
    markerId: String(config.markerId),
    markerMm: String(config.markerMm),
  });
  if (name) query.set("name", name);
  const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${PERSON_PATH}?${query}`;
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
        events.onWelcome(msg.id, msg.players);
        break;
      case "join":
        events.onPeerJoin(msg.player);
        break;
      case "leave":
        events.onPeerLeave(msg.id);
        break;
      case "pose":
        events.onPeerPose(msg.id, msg);
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

  const send = (msg: ClientMessage): boolean => {
    if (ws?.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(msg));
    return true;
  };

  return {
    sendPose(pose) {
      return send({ type: "pose", ...pose });
    },
    dispose() {
      disposed = true;
      ws?.close();
    },
  };
}
