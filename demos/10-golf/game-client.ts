// ゴルフサーバー（server/golf.ts）へのクライアント側接続。08 の game-client.ts と同じ役割
// （WebSocket の生死・再接続・メッセージの振り分け）で、プロトコルがゴルフ用になったもの。スマホと俯瞰画面の両方が使う
import {
  GOLF_PATH,
  GOLF_PROTOCOL_VERSION,
  type ClientMessage,
  type ClientRole,
  type FieldSize,
  type GameSnapshot,
  type GolfConfig,
  type GolfRoomConfig,
  type GolfRules,
  type MarkerPlacement,
  type PlayerPose,
  type ServerMessage,
  type V2,
} from "../../src/shared/golf-protocol";

const RECONNECT_DELAY_MS = 2000;

export type GameClientEvents = {
  onStatus: (status: string) => void;
  /** 入室完了。再接続でも毎回呼ばれ、そのたび自分の id は変わる。peerIds はプレイヤーだけ */
  onWelcome: (selfId: string, role: ClientRole, peerIds: string[], config: GolfConfig, state: GameSnapshot) => void;
  onPeerJoin: (id: string) => void;
  onPeerLeave: (id: string) => void;
  onPeerPose: (id: string, pose: PlayerPose) => void;
  onState: (state: GameSnapshot) => void;
  /** 誰かのパターの振り角（Joy-Con のハブから） */
  onPutter: (id: string, angleDeg: number, dps: number) => void;
  onRejected: (reason: string) => void;
  /** 寸法かルールが変わった（最初からになる） */
  onConfig: (config: GolfConfig, state: GameSnapshot) => void;
  /** 追加マーカーの配置が変わった */
  onMarkers: (config: GolfConfig) => void;
  onError: (reason: string) => void;
};

export type GameClient = {
  sendPose: (pose: PlayerPose) => boolean;
  /** 構え。playerId は俯瞰画面が誰かの代わりに送るとき。target は床の点（省略時はサーバーが持つ視線の交点） */
  sendAddress: (playerId?: string, target?: V2) => boolean;
  sendClearAim: (playerId?: string) => boolean;
  sendStroke: (speed: number, faceDeg: number, playerId?: string) => boolean;
  /** パターの振り角（俯瞰画面だけ） */
  sendPutter: (playerId: string, angleDeg: number, dps: number) => boolean;
  sendRestart: () => boolean;
  sendField: (size: FieldSize) => boolean;
  sendRules: (rules: GolfRules) => boolean;
  sendMarkers: (markers: MarkerPlacement[]) => boolean;
  dispose: () => void;
};

export function connectGame(room: string, name: string, config: GolfRoomConfig, events: GameClientEvents, role: ClientRole = "player"): GameClient {
  const query = new URLSearchParams({
    room,
    role,
    v: String(GOLF_PROTOCOL_VERSION),
    markerId: String(config.markerId),
    markerMm: String(config.markerMm),
  });
  if (name) query.set("name", name);
  const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${GOLF_PATH}?${query}`;
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
      case "state":
        events.onState(msg.state);
        break;
      case "putter":
        events.onPutter(msg.id, msg.angleDeg, msg.dps);
        break;
      case "rejected":
        events.onRejected(msg.reason);
        break;
      case "config":
        events.onConfig(msg.config, msg.state);
        break;
      case "markers":
        events.onMarkers(msg.config);
        break;
      case "error":
        // バージョン・設定の不一致は再接続しても同じ結果なのでループを止める。満員は再接続を続ける
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
    sendPose: (pose) => send({ type: "pose", ...pose }),
    sendAddress: (playerId, target) => {
      const m: ClientMessage = { type: "address" };
      if (playerId !== undefined) m.playerId = playerId;
      if (target !== undefined) m.target = target;
      return send(m);
    },
    sendClearAim: (playerId) => send(playerId !== undefined ? { type: "clearAim", playerId } : { type: "clearAim" }),
    sendStroke: (speed, faceDeg, playerId) => {
      const m: ClientMessage = { type: "stroke", speed, faceDeg };
      if (playerId !== undefined) m.playerId = playerId;
      return send(m);
    },
    sendPutter: (playerId, angleDeg, dps) => send({ type: "putter", playerId, angleDeg, dps }),
    sendRestart: () => send({ type: "restart" }),
    sendField: (size) => send({ type: "field", wallW: size.wallW, wallH: size.wallH, floorDepth: size.floorDepth, floorDrop: size.floorDrop }),
    sendRules: (rules) => send({ type: "rules", decel: rules.decel, cupMaxSpeed: rules.cupMaxSpeed, maxStrokes: rules.maxStrokes, holes: rules.holes }),
    sendMarkers: (markers) => send({ type: "markers", markers }),
    dispose() {
      disposed = true;
      ws?.close();
    },
  };
}
