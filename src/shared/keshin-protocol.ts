// ex9-1-keshin（化身）の WebSocket プロトコル定義。
// クライアント（demos/ex9-1-keshin/keshin-client.ts）とサーバー（server/keshin.ts）の両方から import する。
// サーバーは Player 一覧（id・名前・色・化身の番号・出ているか・状態が変わった時刻）を持ち、pose を検証して中継する。
// 化身の on/off はサーバーが確定して全員に配り、全員（押した本人も）がその時点から演出を始める。
// 座標系は 04 / 09 と同じマーカー座標系（X 右・Y 上・Z 壁から部屋側。重力で水平化するので Y = 鉛直上）
import type { SpaceConfig } from "./shared-room-protocol.ts";

export const KESHIN_PATH = "/api/keshin";

/**
 * メッセージや座標系の意味を変えたら上げる（不一致は入室拒否）。
 * v2: session 鍵での再接続の引き継ぎ、welcome / join の poseAgeMs、join の now
 * v3: 化身が 4 種類（index 3 = 奏者マエストロ）。3 体しか知らない古いページが index 3 を受けて落ちないよう入室で弾く
 */
export const KESHIN_PROTOCOL_VERSION = 3;

/**
 * 再接続の鍵（WS の URL の ?session=）。クライアントがタブごとに sessionStorage に持つランダムな文字列。
 * 同じ鍵で入ってきたら、サーバーは古い接続を切って化身の番号・on・changedAt・色を引き継ぐ
 * （画面ロックや Wi-Fi の瞬断で半分切れた接続が heartbeat で消えるまで残る間に、再接続が「新しい人」にならないように）
 */
export const SESSION_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * 同じ鍵の新しい接続に置き換えられた古い接続へ送る error の理由。クライアントはこれを受けたら再接続しない
 * （タブを複製すると sessionStorage も複製されて同じ鍵になり、2 つのタブが再接続で奪い合うのを 1 回で止める）
 */
export const REPLACED_REASON = "別のタブ・端末に置き換えました";

export const NAME_MAX_LENGTH = 12;
/** プレイヤー（スマホ）の上限 */
export const MAX_PLAYERS = 8;
/** 俯瞰画面（PC）の上限（運営 + 予備） */
export const MAX_OVERVIEWS = 2;

/** 化身の種類の数（0: マジン・ザ・ハンド / 1: 魔神ペガサスアーク / 2: 剣聖ランスロット / 3: 奏者マエストロ） */
export const KESHIN_COUNT = 4;
export type KeshinIndex = 0 | 1 | 2 | 3;
export const KESHIN_NAMES = ["マジン・ザ・ハンド", "魔神ペガサスアーク", "剣聖ランスロット", "奏者マエストロ"] as const;

export type V3 = [number, number, number];
export type Quat = [number, number, number, number];

export type ClientRole = "player" | "overview";

/**
 * 位置を信用できるか（教訓 2: 受け取った側が「どこまで信じてよいか」を知らずに描くと、古い位置の化身が本物に見える）。
 *   marker = 直近 ?trackOkMs= 以内にマーカーを見た（位置も向きも信用できる）
 *   gyro   = アンカーはあるがマーカーを見ていない（頭の回転はジャイロで正しいが、位置は最後の値のまま）
 *   none   = まだアンカーが無い（位置は無意味。pos / quat / fwd を付けない）
 */
export type Track = "marker" | "gyro" | "none";
export const TRACKS: readonly Track[] = ["marker", "gyro", "none"];

/** マーカー座標系での自分の頭の姿勢 + 体の向き */
export type KeshinPose = {
  /** 頭（カメラ）の位置 [m]（track = none なら無し） */
  pos?: V3;
  /** 頭（カメラ）の姿勢（track = none なら無し） */
  quat?: Quat;
  /**
   * 体の向き（マーカー座標系の水平面の単位ベクトル [x, z]。送信側で平滑化済み。受信側はそのまま使う）。
   * track = none なら無し
   */
  fwd?: [number, number];
  track: Track;
  /** 最後にマーカーを見てからの経過 [ms]（track = none なら null） */
  ageMs: number | null;
};

export type KeshinPlayer = {
  id: string;
  name: string;
  /** 1..MAX_PLAYERS（09 と同じ参加順の色） */
  color: number;
  /** 化身の番号（参加順にサーバーが割り当てる。assignKeshin） */
  keshin: KeshinIndex;
  /** 化身が出ているか（サーバーが確定した状態） */
  on: boolean;
  /**
   * いまのステージ（on なら出現、off なら消去）の開始時刻（サーバーの performance.now() [ms]）。
   * 途中反転ではいまの見え方と同じになる時刻にずらしてある（keshin-timeline.ts の retargetElapsed）。
   * 一度も出していなければ null（消え切っている）
   */
  changedAt: number | null;
  /** 直近の pose（途中入室者がすぐ描けるように welcome / join に載せる） */
  pose?: KeshinPose;
  /**
   * pose をサーバーが受け取ってからの経過 [ms]（welcome / join のときだけ付く）。受信側は受信時刻をこれだけ過去にずらして
   * 「いつ届いた pose か」を扱う（keshin-math.ts の poseReceivedLocal。古い pose を今届いた marker と誤解しない）
   */
  poseAgeMs?: number;
};

export type ClientMessage =
  | ({ type: "pose" } & KeshinPose)
  /** 化身を出す（on = true）/ 消す。サーバーが確定した状態を keshin で全員に配る */
  | { type: "keshin"; on: boolean };

export type ServerMessage =
  /** 入室完了。自分の id・役割・その時点の Player 一覧（自分を含む。俯瞰画面は含まない）とサーバー時刻 */
  | { type: "welcome"; id: string; role: ClientRole; players: KeshinPlayer[]; now: number }
  /** 入室（再接続の引き継ぎで on / changedAt を持っていることがあるので now も付ける） */
  | { type: "join"; player: KeshinPlayer; now: number }
  | { type: "leave"; id: string }
  | ({ type: "pose"; id: string } & KeshinPose)
  /** 化身の状態が確定した（押した本人にも届く）。経過 = now − changedAt */
  | { type: "keshin"; id: string; on: boolean; keshin: KeshinIndex; changedAt: number; now: number }
  | { type: "error"; reason: string };

export type KeshinRoomConfig = SpaceConfig;

/**
 * 化身の割り当て: 今いるプレイヤーの中で使われている数が最も少ない番号のうち最小。
 * 最初の 4 人は必ず別々になり、抜けた人の番号は次の人に回る
 */
export function assignKeshin(used: readonly number[]): KeshinIndex {
  const counts = Array.from({ length: KESHIN_COUNT }, () => 0);
  for (const k of used) if (Number.isInteger(k) && k >= 0 && k < KESHIN_COUNT) counts[k]++;
  let best = 0;
  for (let k = 1; k < KESHIN_COUNT; k++) if (counts[k] < counts[best]) best = k;
  return best as KeshinIndex;
}
