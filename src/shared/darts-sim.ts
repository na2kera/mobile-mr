// Phase 6-2 (06-2-darts): ダーツの飛行と採点（純粋関数）。
// サーバー（権威）とクライアント（飛行の描画・投げた瞬間の予測）が同じ式を使う。
// three.js に依存させない（Node の回帰テスト scripts/test-darts.mjs から import するため。
// import に .ts を付けているのも Node の ESM 解決のため）。
//
// 座標系（board 座標系）: 壁に貼ったマーカーのマーカー座標系そのもの。
//   X = マーカーの右, Y = マーカーの上（= 鉛直上。マーカーは天地を合わせて貼る前提）,
//   +Z = 壁から部屋側（マーカー面の法線）。ボードの中心 = マーカーの中心、壁面 = Z=0。
//   プレイヤーは Z>0 に立ち、-Z 方向へ投げる。重力は -Y。単位 m

export type V3 = [number, number, number];

/** 標準ダーツボードの寸法（半径 [m]）。ブル中心 = 原点 */
export const BOARD = {
  /** インナーブル（50 点） */
  bullR: 0.00635,
  /** アウターブル（25 点） */
  outerBullR: 0.0159,
  /** トリプルリング（内側 / 外側） */
  tripleInR: 0.099,
  tripleOutR: 0.107,
  /** ダブルリング（内側 / 外側）。これより外は 0 点 */
  doubleInR: 0.162,
  doubleOutR: 0.17,
  /** 数字リングまで含めたボード全体の半径（見た目用。直径 451mm） */
  boardR: 0.2255,
} as const;

/** セクターの点数（真上の 20 から時計回り） */
export const SEGMENTS: readonly number[] = [
  20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5,
];
export const SEGMENT_DEG = 360 / SEGMENTS.length;

export type DartsConfig = {
  /** 重力 [m/s²]。既定は現実の 9.8（部屋で投げるので実物のダーツと同じ感覚を狙う。URL で調整可） */
  gravity: number;
  /** 飛行の打ち切り [s]。壁に届かなければ床へ落ちた扱い */
  maxFlightSec: number;
  /** 床の高さ（board 座標系。ボード中心からの相対）[m]。これより下に落ちたら壁に届かない */
  floorY: number;
  /** 壁面のこの半径 [m] より内側なら壁に刺さって残る（外は 0 点で落下） */
  wallStickR: number;
  /** 1 人あたりの 1 ターンの投数 */
  dartsPerTurn: number;
  /** ラウンド数（全員が dartsPerTurn 投げて 1 ラウンド） */
  rounds: number;
};

export const DEFAULT_DARTS: DartsConfig = {
  gravity: 9.8,
  maxFlightSec: 2,
  floorY: -1.6,
  wallStickR: 0.6,
  dartsPerTurn: 3,
  rounds: 3,
};

export type Ring = "bull" | "outerBull" | "single" | "double" | "triple" | "out" | "miss";

export type Score = {
  points: number;
  ring: Ring;
  /** セクターの数字（1〜20）。ブル・場外は 0 */
  segment: number;
  /** "T20" / "D5" / "BULL" / "25" / "0" のような表記 */
  label: string;
};

export type Landing = {
  /** 壁面（Z=0）に届いた時刻 [s]（届かなければ床に落ちた時刻） */
  hitT: number;
  /** 最終位置（壁面上の点、または床に落ちた点） */
  end: V3;
  /** 壁に刺さって残るか */
  stuck: boolean;
  score: Score;
};

export function dist2(x: number, y: number): number {
  return Math.hypot(x, y);
}

/** 壁面上の点 (x, y) [m] の得点 */
export function scoreAt(x: number, y: number): Score {
  const r = dist2(x, y);
  if (r <= BOARD.bullR) return { points: 50, ring: "bull", segment: 0, label: "BULL" };
  if (r <= BOARD.outerBullR) return { points: 25, ring: "outerBull", segment: 0, label: "25" };
  if (r > BOARD.doubleOutR) return { points: 0, ring: "out", segment: 0, label: "0" };
  // 真上から時計回りの角度（x 右・y 上）
  let deg = (Math.atan2(x, y) * 180) / Math.PI;
  if (deg < 0) deg += 360;
  const k = Math.round(deg / SEGMENT_DEG) % SEGMENTS.length;
  const seg = SEGMENTS[k];
  if (r >= BOARD.tripleInR && r <= BOARD.tripleOutR) {
    return { points: seg * 3, ring: "triple", segment: seg, label: `T${seg}` };
  }
  if (r >= BOARD.doubleInR) {
    return { points: seg * 2, ring: "double", segment: seg, label: `D${seg}` };
  }
  return { points: seg, ring: "single", segment: seg, label: `${seg}` };
}

/** 放物線上の位置（t [s] 後） */
export function dartAt(pos: V3, vel: V3, t: number, g: number): V3 {
  return [pos[0] + vel[0] * t, pos[1] + vel[1] * t - 0.5 * g * t * t, pos[2] + vel[2] * t];
}

/** 放物線上の速度（t [s] 後）。刺さる向きの計算用 */
export function dartVelAt(vel: V3, t: number, g: number): V3 {
  return [vel[0], vel[1] - g * t, vel[2]];
}

/** y(t) = floorY となる最初の t（無ければ Infinity） */
function timeToFloor(pos: V3, vel: V3, g: number, floorY: number): number {
  // pos.y + vy t - g/2 t² = floorY → (g/2) t² - vy t + (floorY - y0) = 0
  const a = g / 2;
  const b = -vel[1];
  const c = floorY - pos[1];
  if (a <= 0) {
    if (b === 0) return Infinity;
    const t = -c / b;
    return t > 0 ? t : Infinity;
  }
  const disc = b * b - 4 * a * c;
  if (disc < 0) return Infinity;
  const s = Math.sqrt(disc);
  const t1 = (-b - s) / (2 * a);
  const t2 = (-b + s) / (2 * a);
  if (t1 > 0) return t1;
  if (t2 > 0) return t2;
  return Infinity;
}

/**
 * 投げた位置・速度から着地を求める。壁面（Z=0）に届けば採点、届かなければ床に落ちて miss
 * @param pos 投げた位置（board 座標系。Z>0）
 * @param vel 投げた速度 [m/s]（-Z が壁方向）
 */
export function simulateDart(pos: V3, vel: V3, cfg: DartsConfig): Landing {
  const g = cfg.gravity;
  const miss = (t: number): Landing => ({
    hitT: t,
    end: dartAt(pos, vel, t, g),
    stuck: false,
    score: { points: 0, ring: "miss", segment: 0, label: "0" },
  });
  const tFloor = timeToFloor(pos, vel, g, cfg.floorY);
  if (vel[2] >= 0 || pos[2] <= 0) {
    // 壁から遠ざかる / 壁の向こう: 床に落ちる
    return miss(Math.min(tFloor, cfg.maxFlightSec));
  }
  const tWall = -pos[2] / vel[2];
  if (tWall > cfg.maxFlightSec || tWall >= tFloor) {
    return miss(Math.min(tFloor, cfg.maxFlightSec));
  }
  const end = dartAt(pos, vel, tWall, g);
  end[2] = 0;
  const score = scoreAt(end[0], end[1]);
  const stuck = dist2(end[0], end[1]) <= cfg.wallStickR;
  return { hitT: tWall, end, stuck, score };
}

export function len3(v: V3): number {
  return Math.hypot(v[0], v[1], v[2]);
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** 仰角を足した後の打ち出しの仰角の上限 [deg]（真上を越えて裏返らせないため） */
export const MAX_LOFT_ELEVATION_DEG = 89;

/**
 * 打ち出しの速度ベクトルを仰角ぶんだけ上向きへ回す（board 座標系。速さは変えない）。
 *
 * 手の速度方向をそのまま打ち出し方向にすると、水平に振ったダーツは重力で必ず手前に落ちる
 * （距離 2m・重力 9.8 で山なりに届かせるには約 27° の上向きが要る）。実際のダーツも上へ投げるが、
 * 手のトラッキングでその仰角まで正確に出すのは難しいので、離した瞬間の速度を一律で上へ回して補う。
 * 回すのは仰角だけで左右（水平面内の向き）は手の向きのまま = 左右の狙いには補正を入れない。
 *
 * 水平成分が無い（真上・真下）ときは回す軸が定まらないのでそのまま返す。
 */
export function loftVelocity(vel: V3, deg: number): V3 {
  const h = Math.hypot(vel[0], vel[2]);
  if (deg === 0 || h < 1e-6) return [...vel];
  // 既に上を向いている振りを真上より先まで回すと水平の向きが裏返って手前へ飛ぶので、
  // 回した後の仰角が MAX_LOFT_ELEVATION_DEG を超えないところで頭打ちにする
  const elevation = (Math.atan2(vel[1], h) * 180) / Math.PI;
  const applied = clamp(deg, -MAX_LOFT_ELEVATION_DEG - elevation, MAX_LOFT_ELEVATION_DEG - elevation);
  if (applied === 0) return [...vel];
  const rad = (applied * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  // (水平成分, Y) の平面での回転。水平の向きは保ったまま大きさだけ付け替える
  const h2 = h * c - vel[1] * s;
  const y2 = h * s + vel[1] * c;
  return [(vel[0] / h) * h2, y2, (vel[2] / h) * h2];
}
