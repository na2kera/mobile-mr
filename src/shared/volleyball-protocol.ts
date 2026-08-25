// Phase 6 (06-volleyball) の WebSocket プロトコル定義。
// クライアント（demos/06-volleyball/game-client.ts）とサーバー（server/volleyball.ts）の
// 両方から import する（04 の shared-room-protocol.ts と同じ役割）。
// 04 のサーバーは「pose を中継するだけ」だったが、06 はサーバーがボールの物理と得点の
// 権威を持つ（CONCEPT.md Phase 6 の Server Authoritative）。
//
// 座標系（court 座標系）: マーカー座標系（X=マーカー右 / Y=マーカー上 / +Z=面から視点側）を
// X 軸まわりに +90° 回したもの。マーカーを机に水平に置いたとき
//   X = マーカーの右, Y = 上（マーカー面の法線）, Z = マーカーの下辺側（= -マーカー Y）
// になる。ネットは Z=0 の面（マーカーの真上）、A 側 = Z>0、B 側 = Z<0。単位 m
import type { SpaceConfig } from "./shared-room-protocol.ts";
import type { CourtConfig, GameState, Side, V3 } from "./volleyball-sim.ts";

export const VOLLEYBALL_PATH = "/api/volleyball";

/** メッセージや座標系の意味を変えたら上げる（04 と同じく不一致は入室拒否） */
export const VOLLEYBALL_PROTOCOL_VERSION = 1;

/**
 * Room の設定。04 の SpaceConfig（マーカー）に加えて、コートの寸法（ネットの高さ）も
 * Room 内で一致していないと「同じボールを違う高さのネットで見る」ことになるので一致を要求する
 */
export type VolleyballRoomConfig = SpaceConfig & {
  /** ネット上端の高さ [m]（マーカー面から）。"auto" はサーバーが頭の高さから決める */
  netTop: number | "auto";
};

/** court 座標系での自分のカメラ姿勢 + 手の 21 点（見えているときだけ） */
export type PlayerPose = {
  pos: V3;
  quat: [number, number, number, number];
  /** マーカーが視界にあり姿勢が現実に追従しているか（ロスト中は最後の姿勢で送り続ける） */
  tracking: boolean;
  /**
   * 手の 21 点（court 座標系、x,y,z を平坦化した 63 個）。手ごとに 1 配列。
   * 相手の手を描くためだけに使い、当たり判定には使わない（判定は本人の端末で行う）
   */
  hands?: number[][];
};

/** 1 手あたりの数値数（21 点 × 3） */
export const HAND_FLAT_LENGTH = 63;

export type ClientMessage =
  | ({ type: "pose" } & PlayerPose)
  /**
   * 「自分の手がボールに触れた」。当たり判定は手を持つ本人の端末でしか行えないので
   * クライアントが検出し、サーバーが妥当性（ボールが本当にその近くにあるか）を検証する
   */
  | {
      type: "hit";
      /** 接触時のボール位置（クライアントの推定。court 座標系） */
      pos: V3;
      /** 接触した指先の速度 [m/s]（court 座標系。打ち返しの強さに使う） */
      handVel: V3;
    };

export type ServerMessage =
  | {
      type: "welcome";
      id: string;
      peers: string[];
      court: CourtConfig;
      state: GameState;
    }
  | { type: "join"; id: string }
  | { type: "leave"; id: string }
  | ({ type: "pose"; id: string } & PlayerPose)
  /** 権威状態。ラリー中は 20Hz、それ以外は変化時 + 低頻度。court はネット高さが変わったとき用 */
  | { type: "state"; state: GameState; court: CourtConfig }
  | { type: "error"; reason: string };

export type { Side, V3, GameState, CourtConfig };
