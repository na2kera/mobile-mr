// 10-2-batting のスマホ / 俯瞰画面共通 WebSocket クライアント。
import {
  BATTING_PATH,
  BATTING_PROTOCOL_VERSION,
  type BattingConfig,
  type BattingRoomConfig,
  type ClientMessage,
  type ClientRole,
  type GameSnapshot,
  type MotionKind,
  type PitchType,
  type PlayerPose,
  type PlayerRole,
  type ServerMessage,
} from "../../src/shared/batting-protocol";

const RECONNECT_DELAY_MS = 2000;

export type GameClientEvents = {
  onStatus: (status: string) => void;
  onWelcome: (
    selfId: string,
    role: ClientRole,
    playerRole: PlayerRole | null,
    peerIds: string[],
    config: BattingConfig,
    state: GameSnapshot,
  ) => void;
  onPeerJoin: (id: string) => void;
  onPeerLeave: (id: string) => void;
  onPeerPose: (id: string, pose: PlayerPose) => void;
  onState: (state: GameSnapshot) => void;
  onMotion: (
    id: string,
    kind: MotionKind,
    angleDeg: number,
    dps: number,
  ) => void;
  onRejected: (reason: string) => void;
  onError: (reason: string) => void;
};

export type GameClient = {
  sendPose: (pose: PlayerPose) => boolean;
  sendPitch: (
    pitchType: PitchType,
    speed: number,
    playerId?: string,
  ) => boolean;
  sendSwing: (
    speed: number,
    faceDeg: number,
    playerId?: string,
  ) => boolean;
  sendMotion: (
    playerId: string,
    kind: MotionKind,
    angleDeg: number,
    dps: number,
  ) => boolean;
  sendRestart: () => boolean;
  dispose: () => void;
};

export function connectGame(
  room: string,
  name: string,
  config: BattingRoomConfig,
  events: GameClientEvents,
  role: ClientRole = "player",
): GameClient {
  const query = new URLSearchParams({
    room,
    role,
    v: String(BATTING_PROTOCOL_VERSION),
    markerId: String(config.markerId),
    markerMm: String(config.markerMm),
  });
  if (name) query.set("name", name);
  const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${BATTING_PATH}?${query}`;
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
        events.onWelcome(
          msg.id,
          msg.role,
          msg.playerRole,
          msg.peers,
          msg.config,
          msg.state,
        );
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
      case "motion":
        events.onMotion(msg.id, msg.kind, msg.angleDeg, msg.dps);
        break;
      case "rejected":
        events.onRejected(msg.reason);
        break;
      case "error":
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
    ws.addEventListener("message", (event) => {
      if (typeof event.data === "string") handleMessage(event.data);
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
    sendPose: (pose) => send({ type: "pose", ...pose }),
    sendPitch: (pitchType, speed, playerId) => {
      const msg: ClientMessage = { type: "pitch", pitchType, speed };
      if (playerId !== undefined) msg.playerId = playerId;
      return send(msg);
    },
    sendSwing: (speed, faceDeg, playerId) => {
      const msg: ClientMessage = { type: "swing", speed, faceDeg };
      if (playerId !== undefined) msg.playerId = playerId;
      return send(msg);
    },
    sendMotion: (playerId, kind, angleDeg, dps) =>
      send({ type: "motion", playerId, kind, angleDeg, dps }),
    sendRestart: () => send({ type: "restart" }),
    dispose() {
      disposed = true;
      ws?.close();
    },
  };
}
