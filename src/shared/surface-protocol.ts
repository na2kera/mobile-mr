// Phase 7 (07-surface-mapping) の WebSocket プロトコル定義。
// クライアント（demos/07-surface-mapping/paint-client.ts）とサーバー（server/surface.ts）の両方から
// import する（04 / 06 / 06-2 と同じ役割）。サーバーがペイントの権威（検証・順序・保持）を持つ。
// 座標系は surface.ts 参照（Surface = 壁のマーカー座標系。面 = Z=0）
import type { SpaceConfig } from "./shared-room-protocol.ts";
import type { SurfaceDef, V2, V3 } from "./surface.ts";
import type { PaintSnapshot, PaintStroke } from "./surface-paint.ts";

export const SURFACE_PATH = "/api/surface";

/** メッセージや座標系の意味を変えたら上げる（不一致は入室拒否） */
export const SURFACE_PROTOCOL_VERSION = 1;

/** 表示名の上限（文字数） */
export const NAME_MAX_LENGTH = 12;

/** プレイヤーの色の数（サーバーが割り当てる color は 0..この値-1。クライアントの palette と一致させる） */
export const PLAYER_COLOR_COUNT = 6;

/**
 * Room の設定。マーカー（SpaceConfig）に加えて Surface の大きさも一致が必要
 * （UV は Surface の大きさで決まるので、違う端末は同じ UV を別の場所に描いてしまう）
 */
export type SurfaceRoomConfig = SpaceConfig & {
  surfaceW: number;
  surfaceH: number;
};

export type PlayerInfo = { id: string; name: string; color: number };

/** Surface 座標系での自分のカメラ姿勢 + いま指している場所（あれば） */
export type PlayerPose = {
  pos: V3;
  quat: [number, number, number, number];
  tracking: boolean;
  /** いま指している場所。radius は相手の端末でカーソルの大きさを合わせるため（ペイントの半径と同じ） */
  cursor?: { surfaceId: string; uv: V2; radius: number };
};

export type ClientMessage =
  | ({ type: "pose" } & PlayerPose)
  | { type: "paint"; surfaceId: string; uv: V2; radius: number }
  | { type: "clear" };

export type ServerMessage =
  | {
      type: "welcome";
      id: string;
      players: PlayerInfo[];
      snapshot: PaintSnapshot;
    }
  | { type: "join"; player: PlayerInfo }
  | { type: "leave"; id: string }
  | ({ type: "pose"; id: string } & PlayerPose)
  | { type: "paint"; stroke: PaintStroke }
  | { type: "clear"; by: string }
  | { type: "error"; reason: string };

export type { SurfaceDef, PaintStroke, PaintSnapshot, V2, V3 };
