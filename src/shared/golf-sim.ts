// Phase 10 (10-golf): パターゴルフのボールの転がり・カップイン・コートの壁（純粋関数）。
// サーバー（権威）とクライアント（転がりの描画）が同じ式を使う。
// three.js に依存させない（Node の回帰テスト scripts/test-golf.mjs から import するため。
// import に .ts を付けているのも Node の ESM 解決のため）。
//
// 座標系（field 座標系）: 08 と同じ、壁に貼ったマーカーのマーカー座標系そのもの。
//   X = マーカーの右, Y = マーカーの上（= 鉛直上。天地を合わせて貼る前提）, +Z = 壁から部屋側。
//   壁面 = Z=0。床（グリーン）= Y = -floorDrop の水平面（X: ±wallW/2、Z: 0〜floorDepth）。単位 m
// ボールは床の上を転がるだけなので、位置と速度は床の 2 次元 [x, z] で持つ（V2）。
// 転がりは「一定の減速度で直線に減速」（摩擦だけ。芝の傾斜は無い）。コートの四方の壁はクッション（反発係数 restitution）で、
// 場外には出ない。カップは半径 cupR の円で、中心からの距離が capture 以内を通過したときの速さが cupMaxSpeed 以下なら入る
// （速すぎると「リップアウト」して通過する）。
// 転がりの経過は固定刻み（STEP_SEC）で積分して全サンプルを返す（両端で同じ結果になる決定的な計算）。
// 撃つ人の入力は「向き（床の単位ベクトル）+ 速さ」だけで、当たった瞬間のボールの初速をそのまま表す
import type { V3 } from "./surface.ts";
import { DEFAULT_FIELD, FIELD_SIZE_KEYS, FIELD_SIZE_LIMITS, validateFieldSize } from "./splatoon-sim.ts";
import type { FieldSize } from "./splatoon-sim.ts";
import type { MarkerPlacement } from "./marker-layout.ts";

export type { V3, FieldSize };
export { FIELD_SIZE_KEYS, FIELD_SIZE_LIMITS, validateFieldSize };

/** validateFieldSize に渡すセルの大きさ [m]。ゴルフは格子を持たないので、08 のセル数上限が効かない大きな値にする */
export const GOLF_SIZE_CELL_M = 1;

/** 床の 2 次元座標 [x, z]（field 座標系の X と Z。Y は床の高さで固定） */
export type V2 = [number, number];

/** ゴルフボールの半径 [m]（直径 42.67mm） */
export const BALL_R = 0.02135;
/** カップの半径 [m]（直径 108mm） */
export const CUP_R = 0.054;

/** 転がりの積分刻み [s]（200Hz。1 打の最長 maxRollSec=20 で 4000 サンプル） */
export const STEP_SEC = 0.005;

/**
 * 俯瞰画面から変えられるゴルフの設定（コートの寸法は 08 と同じ FieldSize。ゴルフ固有の値もサーバーの状態で全員に配る）
 */
export type GolfRules = {
  /** 転がりの減速度 [m/s²]（芝の速さ。実物のグリーンは 0.6〜1.0 程度） */
  decel: number;
  /** カップに入れる速さの上限 [m/s]（これより速いと通過する） */
  cupMaxSpeed: number;
  /** 1 ホールの打数の上限（超えたらそのホールはこの打数で打ち切り） */
  maxStrokes: number;
  /** ホール数 */
  holes: number;
};

export type GolfConfig = FieldSize & GolfRules & {
  /** 壁（クッション）の反発係数 0〜1 */
  restitution: number;
  /** 1 打の速さの上限 [m/s]（これより速い stroke は拒否） */
  maxStrokeSpeed: number;
  /** 1 打の速さの下限 [m/s]（これより遅い振りは空振り扱い = 打数に数えない） */
  minStrokeSpeed: number;
  /** 転がりの打ち切り [s] */
  maxRollSec: number;
  /** 追加マーカーの配置（08 と同じ。位置合わせだけ） */
  markers: MarkerPlacement[];
};

export const DEFAULT_GOLF: GolfConfig = {
  wallW: DEFAULT_FIELD.wallW,
  wallH: DEFAULT_FIELD.wallH,
  floorDepth: DEFAULT_FIELD.floorDepth,
  floorDrop: DEFAULT_FIELD.floorDrop,
  decel: 0.8,
  cupMaxSpeed: 1.4,
  maxStrokes: 6,
  holes: 3,
  restitution: 0.5,
  maxStrokeSpeed: 6,
  minStrokeSpeed: 0.15,
  maxRollSec: 20,
  markers: [],
};

export const GOLF_RULE_KEYS = ["decel", "cupMaxSpeed", "maxStrokes", "holes"] as const;
/** ルールの許容範囲（サーバーの検証と俯瞰画面の入力欄で共有） */
export const GOLF_RULE_LIMITS: Record<keyof GolfRules, { min: number; max: number; integer?: boolean }> = {
  // 下限は maxRollSec（20s）で 6 m/s が止まりきる値（6 / 0.3 = 20s）
  decel: { min: 0.3, max: 5 },
  cupMaxSpeed: { min: 0.2, max: 5 },
  maxStrokes: { min: 1, max: 20, integer: true },
  holes: { min: 1, max: 9, integer: true },
};

/** ルールの検証。不正なら理由（サーバーの rejected の文言と俯瞰画面の表示で共有）、正しければ null */
export function validateGolfRules(rules: GolfRules): string | null {
  for (const key of GOLF_RULE_KEYS) {
    const v = rules[key];
    const { min, max, integer } = GOLF_RULE_LIMITS[key];
    if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) return `${key} は ${min}〜${max}`;
    if (integer && !Number.isInteger(v)) return `${key} は整数`;
  }
  return null;
}

/** ホールの定義（カップとティーの床の位置） */
export type HoleDef = { cup: V2; tee: V2 };

/**
 * コートの寸法からホールを作る。ティーは部屋側（奥）、カップは壁側で、ホールごとに左右へ振る。
 * 3 ホール: 真っ直ぐ → 右奥から左手前 → 左奥から右手前。4 ホール目以降は繰り返し
 */
export function makeHoles(size: FieldSize, count: number): HoleDef[] {
  const halfW = size.wallW / 2;
  const d = size.floorDepth;
  // 壁・端から少し内側に置く（ボールがクッションに触れない余裕）
  const margin = Math.min(0.25, halfW * 0.5, d * 0.15);
  const teeZ = round3(d - margin);
  const cupZ = round3(Math.max(margin, Math.min(d * 0.25, d - margin)));
  const side = round3(Math.max(0, halfW - margin) * 0.7);
  const patterns: HoleDef[] = [
    { cup: [0, cupZ], tee: [0, teeZ] },
    { cup: [-side, cupZ], tee: [side, teeZ] },
    { cup: [side, cupZ], tee: [-side, teeZ] },
  ];
  return Array.from({ length: Math.max(1, count) }, (_, i) => patterns[i % patterns.length]);
}

/** 床の点を field 座標系（3 次元）に上げる（ボールの中心 = 床 + 半径） */
export function floorToField(p: V2, floorDrop: number, height = BALL_R): V3 {
  return [p[0], -floorDrop + height, p[1]];
}

export function len2(v: V2): number {
  return Math.hypot(v[0], v[1]);
}

export function norm2(v: V2): V2 {
  const l = len2(v);
  return l > 0 ? [v[0] / l, v[1] / l] : [0, -1];
}

/** 向きを鉛直軸まわりに回す（+deg で左 = 反時計回り、上から見て。壁に向かう -Z を 0 とする） */
export function rotate2(v: V2, deg: number): V2 {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  // 上から見た X-Z 平面。Y 軸まわりの右手回転: x' = x cos + z sin, z' = -x sin + z cos
  return [v[0] * c + v[1] * s, -v[0] * s + v[1] * c];
}

export type RollResult = {
  /** STEP_SEC ごとのボールの位置（最初 = 打った位置、最後 = 止まった位置 or カップイン位置） */
  samples: V2[];
  /** 転がっていた時間 [s] */
  duration: number;
  end: V2;
  holed: boolean;
  /** カップインした時刻 [s]（holed のときだけ） */
  holedAt: number | null;
  /** 壁に当たった回数 */
  bounces: number;
  /** 打ち切り（maxRollSec）で止めたか */
  truncated: boolean;
};

/**
 * 1 打の転がり。from（床の位置）から vel（床の速度 [m/s]）で転がり、摩擦で止まるかカップインするまで。
 * 固定刻みで積分するので、同じ入力なら両端で同じ結果になる
 */
export function simulateRoll(from: V2, vel: V2, cup: V2, cfg: GolfConfig): RollResult {
  const halfW = cfg.wallW / 2;
  const minX = -halfW + BALL_R;
  const maxX = halfW - BALL_R;
  const minZ = BALL_R;
  const maxZ = cfg.floorDepth - BALL_R;
  let x = clamp(from[0], minX, maxX);
  let z = clamp(from[1], minZ, maxZ);
  let vx = vel[0];
  let vz = vel[1];
  const samples: V2[] = [[x, z]];
  let bounces = 0;
  const maxSteps = Math.ceil(cfg.maxRollSec / STEP_SEC);
  // カップの縁の内側（中心からこの距離以内）を通ると落ちる。半径いっぱいだと縁をかすめただけで入るので少し内側
  const capture = CUP_R - BALL_R * 0.5;
  let steps = 0;
  // Math.hypot はエンジン間で同じ値が保証されない（正しく丸められない）ので、両端で同じ結果にするため sqrt(x²+z²) で書く（外部レビュー指摘）
  while (steps < maxSteps) {
    const speed = Math.sqrt(vx * vx + vz * vz);
    if (speed <= 1e-6) break;
    // 減速（摩擦は速度と逆向きに一定）。この刻みで止まるならそこまで
    const drop = cfg.decel * STEP_SEC;
    const newSpeed = Math.max(0, speed - drop);
    const k = newSpeed / speed;
    // 位置は平均速度で進める
    const avg = (1 + k) / 2;
    x += vx * avg * STEP_SEC;
    z += vz * avg * STEP_SEC;
    vx *= k;
    vz *= k;
    // 壁（クッション）: はみ出したら折り返して反発
    if (x < minX) {
      x = minX + (minX - x);
      vx = -vx * cfg.restitution;
      bounces++;
    } else if (x > maxX) {
      x = maxX - (x - maxX);
      vx = -vx * cfg.restitution;
      bounces++;
    }
    if (z < minZ) {
      z = minZ + (minZ - z);
      vz = -vz * cfg.restitution;
      bounces++;
    } else if (z > maxZ) {
      z = maxZ - (z - maxZ);
      vz = -vz * cfg.restitution;
      bounces++;
    }
    steps++;
    samples.push([x, z]);
    // カップ: 縁の内側にいて遅ければ落ちる
    const dx = x - cup[0];
    const dz = z - cup[1];
    if (dx * dx + dz * dz <= capture * capture && vx * vx + vz * vz <= cfg.cupMaxSpeed * cfg.cupMaxSpeed) {
      samples[samples.length - 1] = [cup[0], cup[1]];
      return { samples, duration: steps * STEP_SEC, end: [cup[0], cup[1]], holed: true, holedAt: steps * STEP_SEC, bounces, truncated: false };
    }
  }
  const truncated = steps >= maxSteps;
  // 終点は丸めない（丸めると壁の内側に丸めた位置が半径ぶんの余裕を割ることがある）
  const end: V2 = [x, z];
  samples[samples.length - 1] = end;
  return { samples, duration: steps * STEP_SEC, end, holed: false, holedAt: null, bounces, truncated };
}

/** 転がりの途中の位置（描画用。samples を線形補間。t が範囲外なら端） */
export function rollAt(result: RollResult, t: number): V2 {
  const s = result.samples;
  if (t <= 0 || s.length === 1) return s[0];
  const f = t / STEP_SEC;
  const i = Math.floor(f);
  if (i >= s.length - 1) return s[s.length - 1];
  const a = s[i];
  const b = s[i + 1];
  const u = f - i;
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
}

/** 一定減速で止まるまでの距離 [m]（狙いの目安。壁が無ければ） */
export function rollDistance(speed: number, decel: number): number {
  return (speed * speed) / (2 * decel);
}

/** 距離 [m] を転がすのに要る初速 [m/s]（壁が無ければ） */
export function speedForDistance(distance: number, decel: number): number {
  return Math.sqrt(2 * decel * Math.max(0, distance));
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** プレイヤーの色（参加順。08 の 8 色と同じ並び。番号 1〜8） */
export const PLAYER_COLORS: readonly number[] = [0xffb300, 0x00b8d4, 0xe040fb, 0x76ff03, 0xff5252, 0x448aff, 0xff9100, 0x18ffff];
export const PLAYER_COLOR_NAMES: readonly string[] = ["黄", "水色", "紫", "黄緑", "赤", "青", "橙", "シアン"];

export function playerColorHex(color: number): number {
  return PLAYER_COLORS[(color - 1 + PLAYER_COLORS.length) % PLAYER_COLORS.length] ?? 0xe8eaed;
}
export function playerColorName(color: number): string {
  return PLAYER_COLOR_NAMES[(color - 1 + PLAYER_COLOR_NAMES.length) % PLAYER_COLOR_NAMES.length] ?? "-";
}
export function playerColorCss(color: number): string {
  return `#${playerColorHex(color).toString(16).padStart(6, "0")}`;
}
