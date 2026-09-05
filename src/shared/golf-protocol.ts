// Phase 10 (10-golf) の WebSocket プロトコル定義。
// クライアント（demos/10-golf/game-client.ts）とサーバー（server/golf.ts）の両方から import する。
// サーバーがゲーム（手番・ボールの位置・転がり・打数）の権威を持つ。座標系は golf-sim.ts 参照。
// 接続の役割: player（スマホ）と overview（PC の俯瞰画面 + Joy-Con のハブ）。
// Joy-Con はスマホ（iOS Safari）からは IMU が読めない（Gamepad API はボタンとスティックだけ、WebHID 無し）ので、
// PC の Chrome が WebHID で読み、振りを検出して「誰の 1 打か」を付けてサーバーへ送る（CONCEPT.md の
// 「外付けハードはスマホに繋がず、サーバーで合流させる」そのもの）
import type { SpaceConfig } from "./shared-room-protocol.ts";
import type { GolfConfig, GolfRules, FieldSize, V2, V3 } from "./golf-sim.ts";
import type { GameSnapshot } from "./golf-game.ts";
import { MAX_EXTRA_MARKERS } from "./marker-layout.ts";
import type { MarkerPlacement } from "./marker-layout.ts";

export const GOLF_PATH = "/api/golf";

/** メッセージや座標系の意味を変えたら上げる（不一致は入室拒否） */
export const GOLF_PROTOCOL_VERSION = 1;

export const NAME_MAX_LENGTH = 12;

/** Room の設定（接続クエリ）: マーカーだけ。物理・ルール・寸法はサーバーの状態（GolfConfig）で welcome から配る */
export type GolfRoomConfig = SpaceConfig;

/** field 座標系での自分のカメラ姿勢 + 視線と床の交点（構えの狙い。床を見ていなければ無し） */
export type PlayerPose = {
  pos: V3;
  quat: [number, number, number, number];
  tracking: boolean;
  /** 直近の位置合わせに使ったマーカーの ID（追跡中だけ。俯瞰画面の診断表示用） */
  markerIds?: number[];
  /** 視線（カメラの -Z）と床の交点（床の 2 次元）。床を見ていなければ省略 */
  gaze?: V2;
};

export const MAX_POSE_MARKER_IDS = MAX_EXTRA_MARKERS + 1;

export type ClientRole = "player" | "overview";

export type ClientMessage =
  | ({ type: "pose" } & PlayerPose)
  /**
   * 構え（狙いを決める）。playerId は俯瞰画面（Joy-Con のハブ）が誰かの代わりに送るときだけ（スマホは自分）。
   * target は床の点（省略時はサーバーが持つその人の直近の視線の交点）
   */
  | { type: "address"; playerId?: string; target?: V2 }
  /** 狙いを消す（カップの方向に戻す） */
  | { type: "clearAim"; playerId?: string }
  /** 1 打: 速さ [m/s] とフェイスの開き [deg]。向きはサーバーが狙いから決める */
  | { type: "stroke"; playerId?: string; speed: number; faceDeg: number }
  /** パターの振り角（俯瞰画面だけ。表示用に全員へ中継。角速度は HUD 用） */
  | { type: "putter"; playerId: string; angleDeg: number; dps: number }
  /** 最初から（俯瞰画面だけ） */
  | { type: "restart" }
  /** コートの寸法の変更（俯瞰画面だけ。転がっていないとき。最初からになる） */
  | ({ type: "field" } & FieldSize)
  /** ルール（減速・カップの速さ・打数の上限・ホール数）の変更（俯瞰画面だけ。最初からになる） */
  | ({ type: "rules" } & GolfRules)
  /** 追加マーカーの配置の変更（俯瞰画面だけ） */
  | { type: "markers"; markers: MarkerPlacement[] };

export type ServerMessage =
  | { type: "welcome"; id: string; role: ClientRole; peers: string[]; config: GolfConfig; state: GameSnapshot }
  | { type: "join"; id: string }
  | { type: "leave"; id: string }
  | ({ type: "pose"; id: string } & PlayerPose)
  /** 権威状態。出来事があったとき + 低頻度 */
  | { type: "state"; state: GameSnapshot }
  /** 誰かのパターの振り角（俯瞰画面から中継） */
  | { type: "putter"; id: string; angleDeg: number; dps: number }
  | { type: "rejected"; reason: string }
  /** 寸法 / ルールが変わった（全員に配る。最初からになるので state 付き） */
  | { type: "config"; config: GolfConfig; state: GameSnapshot }
  /** 追加マーカーの配置が変わった */
  | { type: "markers"; config: GolfConfig }
  | { type: "error"; reason: string };

export type { V2, V3, GolfConfig, GolfRules, FieldSize, GameSnapshot, MarkerPlacement };
