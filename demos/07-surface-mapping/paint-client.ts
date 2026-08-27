// Surface サーバー（server/surface.ts）へのクライアント側接続。06 / 06-2 の game-client.ts と
// 同じ役割（WebSocket の生死・再接続・メッセージの振り分け）で、プロトコルが Surface 用
// （paint / clear + snapshot）になったもの
import {
  SURFACE_PATH,
  SURFACE_PROTOCOL_VERSION,
  type ClientMessage,
  type PaintSnapshot,
  type PaintStroke,
  type PlayerInfo,
  type PlayerPose,
  type ServerMessage,
  type SurfaceRoomConfig,
  type V2,
} from "../../src/shared/surface-protocol";

const RECONNECT_DELAY_MS = 2000;

export type PaintClientEvents = {
  onStatus: (status: string) => void;
  /** 入室完了。再接続でも毎回呼ばれ、そのたび自分の id は変わる。snapshot で全ストロークを置き換える */
  onWelcome: (selfId: string, players: PlayerInfo[], snapshot: PaintSnapshot) => void;
  onPeerJoin: (player: PlayerInfo) => void;
  onPeerLeave: (id: string) => void;
  onPeerPose: (id: string, pose: PlayerPose) => void;
  onPaint: (stroke: PaintStroke) => void;
  /** 上限到達で切り詰められた。全 Surface を置き換える */
  onSnapshot: (snapshot: PaintSnapshot) => void;
  onClear: (by: string) => void;
  onError: (reason: string) => void;
};

export type PaintClient = {
  sendPose: (pose: PlayerPose) => void;
  /** 送れたら true（未接続・CLOSING 中は false） */
  sendPaint: (surfaceId: string, uv: V2, radius: number) => boolean;
  sendClear: () => void;
  dispose: () => void;
};

export function connectPaint(
  room: string,
  name: string,
  config: SurfaceRoomConfig,
  events: PaintClientEvents,
): PaintClient {
  const query = new URLSearchParams({
    room,
    v: String(SURFACE_PROTOCOL_VERSION),
    markerId: String(config.markerId),
    markerMm: String(config.markerMm),
    surfaceW: String(config.surfaceW),
    surfaceH: String(config.surfaceH),
  });
  if (name) query.set("name", name);
  const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${SURFACE_PATH}?${query}`;
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
        events.onWelcome(msg.id, msg.players, msg.snapshot);
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
      case "paint":
        events.onPaint(msg.stroke);
        break;
      case "snapshot":
        events.onSnapshot(msg.snapshot);
        break;
      case "clear":
        events.onClear(msg.by);
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
      send({ type: "pose", ...pose });
    },
    sendPaint(surfaceId, uv, radius) {
      return send({ type: "paint", surfaceId, uv, radius });
    },
    sendClear() {
      send({ type: "clear" });
    },
    dispose() {
      disposed = true;
      ws?.close();
    },
  };
}
