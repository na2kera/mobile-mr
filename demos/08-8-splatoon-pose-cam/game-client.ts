// 08-8（PC カメラ + MediaPipe Pose）版スプラトゥーンサーバー（server/splatoon-pose-cam.ts。08-3 のサーバーの spec を別パスで登録したもの）
// へのクライアント側接続。08-3 の game-client.ts のコピーで、違いは接続先のパス（SPLATOON_POSE_CAM_PATH）だけ。
// 08-3 と同じく、08 の game-client.ts に役割 tracker・track の送信・tracked の受信・welcome / join の trackId を足したもの。
// 08-8 の trackId はゴーグルのマーカーではなく「トラッカーが手を挙げた人物に割り当てたプレイヤーの番号」として使う
import {
  SPLATOON_OUTSIDE_IN_PROTOCOL_VERSION,
  SPLATOON_POSE_CAM_PATH,
  type ClientMessage,
  type ClientRole,
  type FieldConfig,
  type FieldSize,
  type GameSnapshot,
  type MarkerPlacement,
  type PlayerPose,
  type ServerMessage,
  type Shot,
  type SplatoonRoomConfig,
  type TrackEntry,
  type TrackedPlayer,
  type TrackerStatus,
  type V3,
} from "../../src/shared/splatoon-pose-cam-protocol";

const RECONNECT_DELAY_MS = 2000;

export type WelcomeInfo = {
  /** 自分の番号（player のときだけ。08-8 ではトラッカーの割当の番号。ゴーグルには何も貼らない） */
  trackId?: number;
  /** 全プレイヤーの割当（俯瞰画面・トラッカーの表示用） */
  trackIds: Record<string, number>;
  tracker: TrackerStatus;
};

export type GameClientEvents = {
  onStatus: (status: string) => void;
  /** 入室完了。再接続でも毎回呼ばれ、そのたび自分の id は変わる。peerIds はプレイヤーだけ */
  onWelcome: (selfId: string, role: ClientRole, peerIds: string[], config: FieldConfig, state: GameSnapshot, info: WelcomeInfo) => void;
  onPeerJoin: (id: string, trackId: number) => void;
  onPeerLeave: (id: string) => void;
  onPeerPose: (id: string, pose: PlayerPose) => void;
  onShot: (shot: Shot, serverT: number) => void;
  onRejected: (reason: string) => void;
  onState: (state: GameSnapshot) => void;
  /** フィールドの寸法が変わった（俯瞰画面の field）。config で壁と床を作り直してから state（格子付き）を反映する */
  onField: (config: FieldConfig, state: GameSnapshot) => void;
  /** 追加マーカーの配置が変わった（俯瞰画面の markers）。枠を作り直す（トラッカーは原点合わせの候補を作り直す） */
  onMarkers: (config: FieldConfig) => void;
  /** トラッカーの観測（全員に届く）。players は今回見えていた人だけ */
  onTracked: (tracker: TrackerStatus, players: TrackedPlayer[]) => void;
  onError: (reason: string) => void;
};

export type GameClient = {
  /** 送れたら true */
  sendPose: (pose: PlayerPose) => boolean;
  /** 送れたら true */
  sendShot: (pos: V3, vel: V3, radius: number) => boolean;
  /** トラッカーの観測（tracker だけ。送れたら true） */
  sendTrack: (locked: boolean, players: TrackEntry[]) => boolean;
  /** 対戦開始（俯瞰画面だけ。送れたら true） */
  sendStart: () => boolean;
  /** 途中終了（俯瞰画面だけ。試合中は即座に結果、カウントダウン中は中止。送れたら true） */
  sendStop: () => boolean;
  /** 練習中のインクリセット（俯瞰画面だけ。送れたら true） */
  sendReset: () => boolean;
  /** 結果を閉じて練習に戻る（俯瞰画面だけ。結果表示中だけ。送れたら true。issue #45） */
  sendDismiss: () => boolean;
  /** フィールドの寸法の変更（俯瞰画面だけ。送れたら true） */
  sendField: (size: FieldSize) => boolean;
  /** 追加マーカーの配置の変更（俯瞰画面だけ。送れたら true） */
  sendMarkers: (markers: MarkerPlacement[]) => boolean;
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
    v: String(SPLATOON_OUTSIDE_IN_PROTOCOL_VERSION),
    markerId: String(config.markerId),
    markerMm: String(config.markerMm),
    gravity: String(config.gravity),
    matchSec: String(config.matchSec),
    waitSec: String(config.waitSec),
  });
  if (name) query.set("name", name);
  const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${SPLATOON_POSE_CAM_PATH}?${query}`;
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
        events.onWelcome(msg.id, msg.role, msg.peers, msg.config, msg.state, { trackId: msg.trackId, trackIds: msg.trackIds, tracker: msg.tracker });
        break;
      case "join":
        events.onPeerJoin(msg.id, msg.trackId);
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
      case "markers":
        events.onMarkers(msg.config);
        break;
      case "tracked":
        events.onTracked(msg.tracker, msg.players);
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
    sendTrack(locked, players) {
      return send({ type: "track", locked, players });
    },
    sendStart() {
      return send({ type: "start" });
    },
    sendStop() {
      return send({ type: "stop" });
    },
    sendReset() {
      return send({ type: "reset" });
    },
    sendDismiss() {
      return send({ type: "dismiss" });
    },
    sendField(size) {
      return send({ type: "field", wallW: size.wallW, wallH: size.wallH, floorDepth: size.floorDepth, floorDrop: size.floorDrop });
    },
    sendMarkers(markers) {
      return send({ type: "markers", markers });
    },
    dispose() {
      disposed = true;
      ws?.close();
    },
  };
}
