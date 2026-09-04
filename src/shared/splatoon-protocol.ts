// Phase 8 (08-splatoon) の WebSocket プロトコル定義。
// クライアント（demos/08-splatoon/game-client.ts）とサーバー（server/splatoon.ts）の両方から import する。
// サーバーが試合（チーム・時間・着弾・塗りの格子・得点）の権威を持つ。座標系は splatoon-sim.ts 参照
import type { SpaceConfig } from "./shared-room-protocol.ts";
import type { FieldConfig, FieldSize, V3 } from "./splatoon-sim.ts";
import type { GameSnapshot, Shot } from "./splatoon-game.ts";
import type { MarkerPlacement } from "./marker-layout.ts";

export const SPLATOON_PATH = "/api/splatoon";

/**
 * メッセージや座標系の意味を変えたら上げる（不一致は入室拒否）。
 * v5: 練習 / 俯瞰画面からの開始 / グーで補充。v6: 着弾を飛沫の形で塗る（shot.radius は円ではなく飛沫の基準半径。得点もその形）。
 * v7: フィールドの寸法（幅・高さ・奥行き・マーカーの高さ）を URL クエリからサーバーの状態に移し、俯瞰画面の field で変える。
 * v8: 俯瞰画面の stop（対戦を途中で終える / カウントダウンを中止する。issue #32）と cancel イベント
 * v9: マルチマーカー（issue #30）。追加マーカーの配置（config.markers）を俯瞰画面の markers で変えて全員に配る。
 *     pose に markerIds（いまどのマーカーで位置合わせしているか）
 */
export const SPLATOON_PROTOCOL_VERSION = 9;

export const NAME_MAX_LENGTH = 12;

/**
 * Room の設定（接続クエリ）。マーカーに加えて、飛行・時間は全員一致が必要
 * （違うと同じ発射が端末ごとに別の場所に着弾する）。
 * フィールドの寸法（幅・高さ・奥行き・マーカーの高さ）はここに無い: サーバーの状態で、俯瞰画面の field メッセージで変える
 * （welcome / field でサーバーの config が配られ、クライアントはそれで壁と床を作る）
 */
export type SplatoonRoomConfig = SpaceConfig & {
  gravity: number;
  matchSec: number;
  waitSec: number;
};

/** field 座標系での自分のカメラ姿勢 + 手の 21 点（06-2 と同じ形）+ グーにしているか（インクの回復が速くなる） */
export type PlayerPose = {
  pos: V3;
  quat: [number, number, number, number];
  tracking: boolean;
  hands?: number[][];
  fist?: boolean;
  /** 直近の位置合わせに使ったマーカーの ID（追跡中だけ。俯瞰画面の診断表示用。issue #30） */
  markerIds?: number[];
};

/** pose の markerIds の上限（原点 + 追加マーカー） */
export const MAX_POSE_MARKER_IDS = 9;

/**
 * 接続の役割。"overview" は PC の俯瞰画面（プレイヤーではない。色も得点も無く、pose も送らない。
 * 全員の pose / shot / state を受け取って全体を描き、「対戦開始」を送る）
 */
export type ClientRole = "player" | "overview";

export const HAND_FLAT_LENGTH = 63;

export type ClientMessage =
  | ({ type: "pose" } & PlayerPose)
  /** 発射（パーにした瞬間）。位置・速度・半径は field 座標系。着弾はサーバーが決める */
  | { type: "shot"; pos: V3; vel: V3; radius: number }
  /** 対戦開始（俯瞰画面だけが送れる。練習中か結果表示中に受け付ける） */
  | { type: "start" }
  /** 対戦を途中で終える（俯瞰画面だけが送れる。試合中は即座に結果へ、カウントダウン中は中止して練習に戻る。issue #32） */
  | { type: "stop" }
  /** フィールドの寸法の変更（俯瞰画面だけが送れる。練習中か結果表示中に受け付ける。格子は作り直す = 塗りは消える） */
  | ({ type: "field" } & FieldSize)
  /** 追加マーカーの配置の変更（俯瞰画面だけが送れる。練習中か結果表示中に受け付ける。塗りは消えない。issue #30） */
  | { type: "markers"; markers: MarkerPlacement[] };

export type ServerMessage =
  /** 入室完了。peers はプレイヤーの id だけ（俯瞰画面は含まない） */
  | { type: "welcome"; id: string; role: ClientRole; peers: string[]; config: FieldConfig; state: GameSnapshot }
  | { type: "join"; id: string }
  | { type: "leave"; id: string }
  | ({ type: "pose"; id: string } & PlayerPose)
  /** 受理した発射（着弾込み）。全員に配る */
  | { type: "shot"; shot: Shot; t: number }
  /** 自分の発射が拒否された */
  | { type: "rejected"; reason: string }
  /** 権威状態。出来事があったとき + 低頻度。grids は試合の開始・結果のときだけ */
  | { type: "state"; state: GameSnapshot }
  /** フィールドの寸法が変わった（全員に配る）。config で壁と床を作り直し、state（格子付き）で描き直す */
  | { type: "field"; config: FieldConfig; state: GameSnapshot }
  /** 追加マーカーの配置が変わった（全員に配る）。config.markers でアンカーの候補を作り直す。格子は変わらない */
  | { type: "markers"; config: FieldConfig }
  | { type: "error"; reason: string };

export type { V3, FieldConfig, FieldSize, GameSnapshot, Shot, MarkerPlacement };
