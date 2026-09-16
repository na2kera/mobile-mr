// 08-3（アウトサイドイン）の WebSocket プロトコル。08 のプロトコル（splatoon-protocol.ts）をそのまま土台にして、
// 「部屋に固定した PC の Web カメラ（トラッカー）が各プレイヤーのゴーグルのマーカーを検出し、部屋（field）座標系での
// 位置とヨーをサーバーへ送り、サーバーがプレイヤーに紐づけて全員に配る」ためのメッセージを足す。
// サーバーは server/splatoon-outside-in.ts（server/splatoon.ts は触らない）。クライアントは demos/08-3-splatoon-outside-in/。
//   - 役割: player（スマホ）/ overview（俯瞰画面）/ tracker（俯瞰画面と同じ PC の Web カメラ。?role=tracker）
//   - プレイヤーごとにゴーグルへ貼るマーカーの ID（trackId）をサーバーが入室順に割り当て、welcome / join で全員に伝える
//   - tracker → server: track（検出した各マーカーの field 座標系での位置・ヨー・品質）
//   - server → 全員: tracked（プレイヤー id に紐づけた位置・ヨー・品質）。スマホは自分の位置をここから受け取る
//   - player の pose はこれまでどおり受け取る（手の 21 点は field 座標系で要る）が、pos はサーバーがトラッカーの測定値で
//     上書きして配る（自己申告ではなく測定値を配る。発射位置の検証もその値で行う）
import {
  HAND_FLAT_LENGTH,
  MAX_POSE_MARKER_IDS,
  NAME_MAX_LENGTH,
  type ClientMessage as BaseClientMessage,
  type PlayerPose,
  type ServerMessage as BaseServerMessage,
  type SplatoonRoomConfig,
} from "./splatoon-protocol.ts";
import type { FieldConfig, FieldSize, GameSnapshot, MarkerPlacement, Shot, V3 } from "./splatoon-protocol.ts";

export const SPLATOON_OUTSIDE_IN_PATH = "/api/splatoon-outside-in";

/**
 * 08 とは別のサーバーなので別の番号で数える（08 の v11 を土台にした v1）。
 * v1: track / tracked、welcome / join の trackId、pose の pos をトラッカーの値で上書き
 */
export const SPLATOON_OUTSIDE_IN_PROTOCOL_VERSION = 1;

export { HAND_FLAT_LENGTH, MAX_POSE_MARKER_IDS, NAME_MAX_LENGTH };
export type { FieldConfig, FieldSize, GameSnapshot, MarkerPlacement, PlayerPose, Shot, SplatoonRoomConfig, V3 };

/** 接続の役割。tracker は俯瞰画面と同じ権限（state を受け取る）に加えて track を送れる。プレイヤーではない */
export type ClientRole = "player" | "overview" | "tracker";

/**
 * プレイヤーのゴーグルに貼るマーカーの ID の最小値。0 は原点（room 設定の markerId）、1〜9 は 08 の追加マーカー
 * （床・左右・背面。トラッカーの原点合わせにも使う）に譲り、プレイヤーは 10 から入室順に空いている番号を使う
 */
export const TRACK_ID_FIRST = 10;
/** track に載せられる観測の上限（プレイヤー 8 人 + 余り） */
export const MAX_TRACK_ENTRIES = 16;
/** トラッカーの送信レートの上限 [回/s]（検出間隔 50ms = 20Hz に余裕） */
export const TRACK_RATE_PER_SEC = 40;
/**
 * トラッカーの観測がこれより古ければ「見失った」扱い [ms]（pose の pos の上書きをやめ、スマホは最後の位置を保持して
 * HUD に "tracked (0.8s ago)" を出す）
 */
export const TRACK_STALE_MS = 2000;

/** トラッカーが検出した 1 枚のマーカー（field 座標系） */
export type TrackEntry = {
  /** マーカーの ID（プレイヤーの trackId。サーバーがプレイヤー id に引き当てる。知らない ID は捨てる） */
  id: number;
  /** マーカーの中心（≒ ゴーグル前面 = スマホのカメラ）[m] */
  pos: V3;
  /** 向き（マーカーの法線を水平面に射影した向き）[rad]。0 = 正面の壁（-Z）を向く、+ で左（three.js の Y 回転と同じ向き） */
  yaw: number;
  /** 品質 0..1（画面上の大きさ × 正対の度合い）。スマホはこれが高いときだけヨーを補正する */
  quality: number;
};

/** サーバーがプレイヤーに紐づけて配る観測 */
export type TrackedPlayer = TrackEntry & {
  /** プレイヤー id（id はマーカーの ID のまま。両方持たせるのは俯瞰画面の表示のため） */
  player: string;
  /** サーバーがこの観測を受けてからの経過 [ms]（tracked を配った時点。見失った人は載せない） */
  ageMs: number;
};

export type ClientMessage =
  | BaseClientMessage
  /**
   * トラッカーの観測（tracker だけが送れる）。locked = 原点（部屋座標系）が確定しているか。確定前の players は捨てられる。
   * 見えていないマーカーは載せない（サーバーは最後の観測を TRACK_STALE_MS 保持する）
   */
  | { type: "track"; locked: boolean; players: TrackEntry[] };

export type ServerMessage =
  | Exclude<BaseServerMessage, { type: "welcome" } | { type: "join" }>
  /**
   * 入室完了。trackId = 自分のゴーグルに貼るマーカーの ID（player だけ）。trackIds = 全プレイヤーの割当（俯瞰画面・トラッカーの表示用）。
   * tracker = トラッカーが接続しているか・原点が確定しているか
   */
  | {
      type: "welcome";
      id: string;
      role: ClientRole;
      peers: string[];
      config: FieldConfig;
      state: GameSnapshot;
      trackId?: number;
      trackIds: Record<string, number>;
      tracker: TrackerStatus;
    }
  | { type: "join"; id: string; trackId: number }
  /**
   * トラッカーの観測（全員に配る。tracker が track を送るたび）。players は今回見えていた人だけ
   * （見失った人は載らないので、受け取る側は最後の値を保持する）
   */
  | { type: "tracked"; t: number; tracker: TrackerStatus; players: TrackedPlayer[] };

export type TrackerStatus = {
  /** 接続しているトラッカーの数（0 なら誰の位置も来ない） */
  connected: number;
  /** 原点が確定しているか（確定前は位置が来ない） */
  locked: boolean;
};
