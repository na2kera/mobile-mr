// Phase 9 (09-person-id) の WebSocket プロトコル定義。
// クライアント（demos/09-person-id/person-client.ts）とサーバー（server/person.ts）の両方から import する。
// サーバーは Player 一覧（id・名前・色）を持ち、pose（頭の姿勢 + 「誰をどこで見たか」）を中継するだけで、
// 人物とのの対応づけ（Spatial Matching）は各端末が自分のカメラ座標系で行う（person-match.ts）。
// 座標系は 04 と同じマーカー座標系（shared-room-protocol.ts の PoseData 参照）
import type { SpaceConfig } from "./shared-room-protocol.ts";

export const PERSON_PATH = "/api/person";

/** メッセージや座標系の意味を変えたら上げる（不一致は入室拒否） */
export const PERSON_PROTOCOL_VERSION = 1;

export const NAME_MAX_LENGTH = 12;
export const MAX_PLAYERS = 8;

/** Player の色（参加順に 1..8。08 のパレットと同じ） */
export const PLAYER_COLORS = [0xff7a1a, 0x2bd4ff, 0x81c995, 0xf28b82, 0xfdd663, 0xc58af9, 0xe8eaed, 0xff8bcb];
export const PLAYER_COLOR_NAMES = ["オレンジ", "ブルー", "グリーン", "レッド", "イエロー", "パープル", "ホワイト", "ピンク"];
if (PLAYER_COLORS.length !== MAX_PLAYERS || PLAYER_COLOR_NAMES.length !== MAX_PLAYERS) {
  throw new Error("PLAYER_COLORS / PLAYER_COLOR_NAMES と MAX_PLAYERS が一致していない");
}
export function playerColorHex(color: number): number {
  return PLAYER_COLORS[Math.min(MAX_PLAYERS, Math.max(1, Math.round(color))) - 1];
}
export function playerColorName(color: number): string {
  return PLAYER_COLOR_NAMES[Math.min(MAX_PLAYERS, Math.max(1, Math.round(color))) - 1];
}

export type V3 = [number, number, number];

export type PersonRoomConfig = SpaceConfig;

export type PlayerInfo = {
  id: string;
  name: string;
  /** 1..MAX_PLAYERS */
  color: number;
};

/**
 * 「カメラに映っていた人をどこで見たか」。pos は検出した頭（両目の中点）のマーカー座標系での位置、
 * id は対応づけた Player（未対応は null）。相手の端末はこれで「自分がどこに見えているか」を知る
 */
export type Sighting = {
  id: string | null;
  pos: V3;
};

/** マーカー座標系での自分のカメラ姿勢 + 見えている人 */
export type PersonPose = {
  pos: V3;
  quat: [number, number, number, number];
  tracking: boolean;
  seen?: Sighting[];
};

export type ClientMessage = { type: "pose" } & PersonPose;

export type ServerMessage =
  /** 入室完了。自分の id と、その時点の Player 一覧（自分を含む） */
  | { type: "welcome"; id: string; players: PlayerInfo[] }
  | { type: "join"; player: PlayerInfo }
  | { type: "leave"; id: string }
  | ({ type: "pose"; id: string } & PersonPose)
  | { type: "error"; reason: string };
