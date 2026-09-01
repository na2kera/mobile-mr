// Phase 8 (08-splatoon) の WebSocket プロトコル定義。
// クライアント（demos/08-splatoon/game-client.ts）とサーバー（server/splatoon.ts）の両方から import する。
// サーバーが試合（チーム・時間・着弾・塗りの格子・得点）の権威を持つ。座標系は splatoon-sim.ts 参照
import type { SpaceConfig } from "./shared-room-protocol.ts";
import type { FieldConfig, V3 } from "./splatoon-sim.ts";
import type { GameSnapshot, Shot } from "./splatoon-game.ts";

export const SPLATOON_PATH = "/api/splatoon";

/** メッセージや座標系の意味を変えたら上げる（不一致は入室拒否） */
export const SPLATOON_PROTOCOL_VERSION = 2;

export const NAME_MAX_LENGTH = 12;

/**
 * Room の設定。マーカーに加えて、フィールドの形と飛行に効く値は全員一致が必要
 * （違うと同じ発射が端末ごとに別の場所に着弾する）
 */
export type SplatoonRoomConfig = SpaceConfig & {
  wallW: number;
  wallH: number;
  floorDrop: number;
  floorDepth: number;
  gravity: number;
  matchSec: number;
};

/** field 座標系での自分のカメラ姿勢 + 手の 21 点（06-2 と同じ形） */
export type PlayerPose = {
  pos: V3;
  quat: [number, number, number, number];
  tracking: boolean;
  hands?: number[][];
};

export const HAND_FLAT_LENGTH = 63;

export type ClientMessage =
  | ({ type: "pose" } & PlayerPose)
  /** 発射（パーにした瞬間）。位置・速度・半径は field 座標系。着弾はサーバーが決める */
  | { type: "shot"; pos: V3; vel: V3; radius: number };

export type ServerMessage =
  | { type: "welcome"; id: string; peers: string[]; config: FieldConfig; state: GameSnapshot }
  | { type: "join"; id: string }
  | { type: "leave"; id: string }
  | ({ type: "pose"; id: string } & PlayerPose)
  /** 受理した発射（着弾込み）。全員に配る */
  | { type: "shot"; shot: Shot; t: number }
  /** 自分の発射が拒否された */
  | { type: "rejected"; reason: string }
  /** 権威状態。出来事があったとき + 低頻度。grids は試合の開始・結果のときだけ */
  | { type: "state"; state: GameSnapshot }
  | { type: "error"; reason: string };

export type { V3, FieldConfig, GameSnapshot, Shot };
