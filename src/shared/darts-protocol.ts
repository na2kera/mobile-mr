// Phase 6-2 (06-2-darts) の WebSocket プロトコル定義。
// クライアント（demos/06-2-darts/game-client.ts）とサーバー（server/darts.ts）の両方から import する
// （06 の volleyball-protocol.ts と同じ役割）。サーバーが手番・採点・ダーツの着地の権威を持つ。
// 座標系（board 座標系）は darts-sim.ts 参照（壁のマーカー座標系そのもの。壁面 = Z=0）
import type { SpaceConfig } from "./shared-room-protocol.ts";
import type { DartsConfig, V3 } from "./darts-sim.ts";
import type { GameState } from "./darts-game.ts";

export const DARTS_PATH = "/api/darts";

/** メッセージや座標系の意味を変えたら上げる（不一致は入室拒否） */
export const DARTS_PROTOCOL_VERSION = 1;

/** 表示名の上限（文字数） */
export const NAME_MAX_LENGTH = 12;

/**
 * Room の設定。マーカー（SpaceConfig）に加えて、飛行に効く重力とラウンド数は
 * 全員で一致していないと「同じダーツが端末ごとに違う所へ飛ぶ」ので一致を要求する
 */
export type DartsRoomConfig = SpaceConfig & {
  gravity: number;
  rounds: number;
};

/** board 座標系での自分のカメラ姿勢 + 手の 21 点（06 の PlayerPose と同じ形） */
export type PlayerPose = {
  pos: V3;
  quat: [number, number, number, number];
  tracking: boolean;
  hands?: number[][];
};

export const HAND_FLAT_LENGTH = 63;

export type ClientMessage =
  | ({ type: "pose" } & PlayerPose)
  /** 「投げた」。手を離した瞬間の位置と速度（board 座標系）。着地はサーバーが計算する */
  | { type: "throw"; pos: V3; vel: V3 };

export type ServerMessage =
  | {
      type: "welcome";
      id: string;
      peers: string[];
      config: DartsConfig;
      state: GameState;
    }
  | { type: "join"; id: string }
  | { type: "leave"; id: string }
  | ({ type: "pose"; id: string } & PlayerPose)
  /** 権威状態。出来事があったとき + 低頻度 */
  | { type: "state"; state: GameState }
  | { type: "error"; reason: string };

export type { V3, DartsConfig, GameState };
