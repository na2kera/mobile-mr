// 08-7: AlvaAR（単眼 SLAM）の姿勢を field 座標系に写す純粋な数学。three.js に依存しない（Node の回帰テスト
// scripts/test-08-7-alva.mjs から直接 import する）。
//
// ■ AlvaAR の姿勢の形式（alanross/AlvaAR コミット 7796af5 の src/slam/src/utils.cpp `Utils::toPoseArray(Sophus::SE3d Twc, …)`）
//   findCameraPose が返す 16 要素は **Twc（カメラ → SLAM ワールド）** で、
//     [0..2] = R の 0 行目、[4..6] = 1 行目、[8..10] = 2 行目（= 行優先。three の Matrix4.fromArray（列優先）で読むと転置になる）
//     [12..14] = カメラの位置 t（SLAM ワールド座標系）
//   座標系は OpenCV の流儀（カメラの X 右・Y 下・Z 前。SLAM ワールドは初期化したときのカメラの向きに依存し、重力とは無関係）。
//   単眼なのでスケールは任意（初期化時の視差で決まる）。
// ■ three.js の流儀（X 右・Y 上・-Z 前）へ: S = diag(1, -1, -1) で両側を挟む。
//   位置 p = S t = (t.x, -t.y, -t.z)、回転 R3 = S R S（カメラの軸も S で three の軸に直すので右からも S）。
//   AlvaAR 同梱の alva_ar_three.js は quaternion.set(-r.x, r.y, r.z, r.w)（r は転置行列の四元数 = R の逆）と
//   position.set(t.x, -t.y, -t.z) で、同じ変換になる（四元数 (x,y,z,w) の S·S 挟みは (x,-y,-z,w)、その逆は (-x,y,z,w)）。
// ■ ハイブリッドの推定: マーカーが見えている間に「field 座標系でのカメラ姿勢（マーカー + ジャイロ）」と
//   「SLAM の姿勢（three 流儀に直したもの）」の組を集め、SLAM → field の相似変換 field = s·R·slam + T を推定する。
//     R: 各組の Q_field · Q_slam⁻¹ の平均（回転は 1 組でも決まる。マーカーの推定は位置よりヨーが揺れるので平均する）
//     s: 重心からの変位の最小二乗 s = Σ d_field·(R d_slam) / Σ |d_slam|²（歩いた距離 = 基線が要る。基線が短いと null）
//     T: 重心どうしを合わせる T = c_field − s·R·c_slam
//   Umeyama（位置だけで回転も出す）は、ゴーグルを付けて横に数十 cm 動く程度の「ほぼ直線の軌道」では回転が決まらないので使わない
// ■ 採用の判定（SlamFusion.add）: 推定 → 各組の残差が中央値の 3 倍を超える組を除いて 1 回だけ推定し直す（robustEstimate）→
//   「残差 ≤ 0.35 × 基線（RMS）」「組の数 ≥ 10」「前回採用からのスケールの変化 ≤ 20%（初回を除く）」を満たしたら採用し、
//   スケールと回転は前回から EMA で寄せる。満たさなければ前回の推定を維持する（HUD に rejected(res|n|scale)）。
//   正常なら 残差 / 基線 ≈ 0.2、マーカーの遅れ・鏡像・反射相当では 0.5〜1.0 に分かれる（scripts/test-08-7-alva.mjs）
export type V3 = [number, number, number];
/** 四元数 [x, y, z, w]（three.js の Quaternion と同じ並び） */
export type Quat = [number, number, number, number];

export type Pose = { pos: V3; quat: Quat };

/** SLAM 座標系 → field 座標系の相似変換（field = scale · rotate(quat, slam) + trans） */
export type Similarity = { scale: number; quat: Quat; trans: V3 };

export type Correspondence = {
  /** SLAM の姿勢（three 流儀。alvaPoseToThree の戻り値） */
  slam: Pose;
  /** 同じ瞬間の field 座標系でのカメラの姿勢（three 流儀） */
  field: Pose;
};

export type SimilarityEstimate = {
  sim: Similarity;
  /** 推定に使った組での位置の残差の RMS [m]（field 座標系） */
  residualM: number;
  /** field 側の基線（重心からの距離の RMS）[m]。採用条件の残差の比の分母 */
  baselineM: number;
  /** field 側の軌道の最大点間距離（直径）[m]。minBaselineM と比べる（「これだけ動けば較正」と一致させる） */
  spanM: number;
  /** 使った組の数（外れ値を除いた後） */
  count: number;
  /** 外れ値として除いた組の数 */
  outliers: number;
  /** 各組の位置の残差 [m]（推定に使った組の順） */
  residuals: number[];
  /** 重心（field / SLAM）。平滑化した回転・スケールから平行移動を出し直すのに使う */
  centroidField: V3;
  centroidSlam: V3;
};

// ---- 四元数・ベクトルの小道具 ----
export function quatMul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export function quatConj(q: Quat): Quat {
  return [-q[0], -q[1], -q[2], q[3]];
}

export function quatNormalize(q: Quat): Quat {
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

export function rotateVec(q: Quat, v: V3): V3 {
  // v' = v + 2w(u×v) + 2u×(u×v)
  const [x, y, z, w] = q;
  const cx = y * v[2] - z * v[1];
  const cy = z * v[0] - x * v[2];
  const cz = x * v[1] - y * v[0];
  const ccx = y * cz - z * cy;
  const ccy = z * cx - x * cz;
  const ccz = x * cy - y * cx;
  return [v[0] + 2 * (w * cx + ccx), v[1] + 2 * (w * cy + ccy), v[2] + 2 * (w * cz + ccz)];
}

/** 2 つの回転の差の角度 [deg] */
export function quatAngleDeg(a: Quat, b: Quat): number {
  const d = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  return (2 * Math.acos(Math.min(1, d)) * 180) / Math.PI;
}

/** 回転行列（m[行][列]）→ 四元数 */
export function quatFromRows(m: number[][]): Quat {
  const [m00, m01, m02] = m[0];
  const [m10, m11, m12] = m[1];
  const [m20, m21, m22] = m[2];
  const trace = m00 + m11 + m22;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    return quatNormalize([(m21 - m12) * s, (m02 - m20) * s, (m10 - m01) * s, 0.25 / s]);
  }
  if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    return quatNormalize([0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s]);
  }
  if (m11 > m22) {
    const s = 2 * Math.sqrt(1 - m00 + m11 - m22);
    return quatNormalize([(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s]);
  }
  const s = 2 * Math.sqrt(1 - m00 - m11 + m22);
  return quatNormalize([(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s]);
}

/** 四元数 → 回転行列（m[行][列]） */
export function rowsFromQuat(q: Quat): number[][] {
  const [x, y, z, w] = q;
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ];
}

/** HUD 用: three 流儀の姿勢の向き（YXZ のオイラー角 [deg]: ヨー + で左、ピッチ + で上、ロール） */
export function yawPitchRollDeg(q: Quat): V3 {
  const m = rowsFromQuat(q);
  const pitch = Math.asin(Math.max(-1, Math.min(1, -m[1][2])));
  const yaw = Math.atan2(m[0][2], m[2][2]);
  const roll = Math.atan2(m[1][0], m[1][1]);
  const d = 180 / Math.PI;
  return [yaw * d, pitch * d, roll * d];
}

// ---- AlvaAR ⇄ three の変換 ----
const S = [1, -1, -1];

/** AlvaAR の findCameraPose の 16 要素（Twc、行優先の回転 + [12..14] の位置、OpenCV 流儀）→ three 流儀のカメラ姿勢 */
export function alvaPoseToThree(pose: ArrayLike<number>): Pose {
  const rows: number[][] = [];
  for (let i = 0; i < 3; i++) {
    const row: number[] = [];
    for (let j = 0; j < 3; j++) row.push(S[i] * pose[i * 4 + j] * S[j]);
    rows.push(row);
  }
  return { pos: [pose[12], -pose[13], -pose[14]], quat: quatFromRows(rows) };
}

/** alvaPoseToThree の逆（フェイクの SLAM が AlvaAR と同じ形式の値を作るため） */
export function threePoseToAlva(p: Pose): number[] {
  const r = rowsFromQuat(p.quat);
  const out = new Array<number>(16).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) out[i * 4 + j] = S[i] * r[i][j] * S[j];
  out[12] = p.pos[0];
  out[13] = -p.pos[1];
  out[14] = -p.pos[2];
  out[15] = 1;
  return out;
}

// ---- 相似変換 ----
export function applySimilarity(sim: Similarity, p: V3): V3 {
  const r = rotateVec(sim.quat, p);
  return [sim.scale * r[0] + sim.trans[0], sim.scale * r[1] + sim.trans[1], sim.scale * r[2] + sim.trans[2]];
}

/** 逆変換（field → SLAM）。フェイクの SLAM（?fakeslam=1）が「別の原点・スケール・回転の SLAM 座標系」を作るのに使う */
export function invertSimilarity(sim: Similarity): Similarity {
  const qi = quatConj(sim.quat);
  const t = rotateVec(qi, sim.trans);
  return { scale: 1 / sim.scale, quat: qi, trans: [-t[0] / sim.scale, -t[1] / sim.scale, -t[2] / sim.scale] };
}

/** SLAM のカメラ姿勢を field 座標系に写す（位置は相似変換、向きは R を掛ける） */
export function mapSlamPose(sim: Similarity, p: Pose): Pose {
  return { pos: applySimilarity(sim, p.pos), quat: quatNormalize(quatMul(sim.quat, p.quat)) };
}

export type EstimateOptions = {
  /** field 側の軌道の最大点間距離（直径）がこれ未満ならスケールが決まらないとして null [m]（「これだけ動けば較正」） */
  minBaselineM: number;
};

/**
 * 組から SLAM → field の相似変換を推定する（ヘッダのコメント参照）。組が 2 つ未満・基線不足・スケールが正にならないときは null
 */
export function estimateSimilarity(pairs: readonly Correspondence[], opts: EstimateOptions): SimilarityEstimate | null {
  const n = pairs.length;
  if (n < 2) return null;
  // 回転: Q_field · Q_slam⁻¹ の平均（符号を 1 つ目に揃えて足し、正規化。回転の差が小さい前提の近似平均）
  let acc: Quat = [0, 0, 0, 0];
  let ref: Quat | null = null;
  for (const p of pairs) {
    const q = quatMul(p.field.quat, quatConj(p.slam.quat));
    if (!ref) ref = q;
    const sign = q[0] * ref[0] + q[1] * ref[1] + q[2] * ref[2] + q[3] * ref[3] < 0 ? -1 : 1;
    acc = [acc[0] + sign * q[0], acc[1] + sign * q[1], acc[2] + sign * q[2], acc[3] + sign * q[3]];
  }
  const quat = quatNormalize(acc);
  // 重心
  const cf: V3 = [0, 0, 0];
  const cs: V3 = [0, 0, 0];
  for (const p of pairs) {
    for (let k = 0; k < 3; k++) {
      cf[k] += p.field.pos[k] / n;
      cs[k] += p.slam.pos[k] / n;
    }
  }
  let num = 0;
  let den = 0;
  let fieldSq = 0;
  const ds: V3[] = [];
  const df: V3[] = [];
  for (const p of pairs) {
    const s = rotateVec(quat, [p.slam.pos[0] - cs[0], p.slam.pos[1] - cs[1], p.slam.pos[2] - cs[2]]);
    const f: V3 = [p.field.pos[0] - cf[0], p.field.pos[1] - cf[1], p.field.pos[2] - cf[2]];
    num += s[0] * f[0] + s[1] * f[1] + s[2] * f[2];
    den += s[0] * s[0] + s[1] * s[1] + s[2] * s[2];
    fieldSq += f[0] * f[0] + f[1] * f[1] + f[2] * f[2];
    ds.push(s);
    df.push(f);
  }
  const baselineM = Math.sqrt(fieldSq / n);
  // 直径（最大点間距離）。n ≤ 数百なので O(n²) で足りる
  let spanSq = 0;
  for (let i = 0; i < n; i++) {
    const a = pairs[i].field.pos;
    for (let j = i + 1; j < n; j++) {
      const b = pairs[j].field.pos;
      spanSq = Math.max(spanSq, (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
    }
  }
  const spanM = Math.sqrt(spanSq);
  if (spanM < opts.minBaselineM || den <= 1e-12) return null;
  const scale = num / den;
  if (!(scale > 0) || !Number.isFinite(scale)) return null;
  const rc = rotateVec(quat, cs);
  const trans: V3 = [cf[0] - scale * rc[0], cf[1] - scale * rc[1], cf[2] - scale * rc[2]];
  let res = 0;
  const residuals: number[] = [];
  for (let i = 0; i < n; i++) {
    const r2 = (scale * ds[i][0] - df[i][0]) ** 2 + (scale * ds[i][1] - df[i][1]) ** 2 + (scale * ds[i][2] - df[i][2]) ** 2;
    res += r2;
    residuals.push(Math.sqrt(r2));
  }
  return {
    sim: { scale, quat, trans },
    residualM: Math.sqrt(res / n),
    baselineM,
    spanM,
    count: n,
    outliers: 0,
    residuals,
    centroidField: cf,
    centroidSlam: cs,
  };
}

/** 外れ値とみなす残差 = 中央値のこの倍数を超える組 */
export const OUTLIER_MEDIAN_FACTOR = 3;
/** 外れ値の閾値の下限 [m]（ノイズが無いと中央値がほぼ 0 になり、正しい組まで外れ値になるのを防ぐ） */
export const OUTLIER_FLOOR_M = 0.002;

/**
 * estimateSimilarity → 各組の残差が中央値の 3 倍（下限 OUTLIER_FLOOR_M）を超える組を除いて 1 回だけ推定し直す。
 * 除いた後に推定できなければ（基線不足など）最初の推定を返す（採用の判定で弾かれる）
 */
export function robustEstimate(pairs: readonly Correspondence[], opts: EstimateOptions): SimilarityEstimate | null {
  const first = estimateSimilarity(pairs, opts);
  if (!first) return null;
  const sorted = [...first.residuals].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const limit = Math.max(OUTLIER_MEDIAN_FACTOR * median, OUTLIER_FLOOR_M);
  const inliers = pairs.filter((_, i) => first.residuals[i] <= limit);
  if (inliers.length === pairs.length) return first;
  const second = estimateSimilarity(inliers, opts);
  if (!second) return first;
  return { ...second, outliers: pairs.length - inliers.length };
}

/** 採用条件: 残差（RMS）≤ この比 × 基線（RMS） */
export const ACCEPT_MAX_RESIDUAL_RATIO = 0.35;
/** 採用条件: 外れ値を除いた組の数の下限 */
export const ACCEPT_MIN_PAIRS = 10;
/** 採用条件: 前回採用したスケールからの変化率の上限（初回を除く） */
export const ACCEPT_MAX_SCALE_CHANGE = 0.2;
/**
 * スケールの変化だけで弾かれた推定がこの回数続いたら、前回の採用の方が誤っていたとみなして新しい推定をそのまま採用する
 * （初回に少しずれた推定を採用すると、以後の正しい推定を全部弾き続けるのを防ぐ。組を足すのは 100ms 間隔なので約 3 秒）
 */
export const SCALE_RELOCK_STREAK = 30;
/** 採用した推定のスケールと回転を前回から寄せる割合（EMA。1 で寄せない = 新しい推定そのまま） */
export const ADOPT_SMOOTHING = 0.3;

export type RejectReason = "res" | "n" | "scale";

export type FusionOptions = EstimateOptions & {
  /** 保持する組の数（古いものから捨てる） */
  maxPairs: number;
  /** 組を足す最小の間隔 [ms]（止まっている間に同じ点で埋まらないように） */
  minPairIntervalMs: number;
  /** 以下は省略時に上の定数 */
  maxResidualRatio?: number;
  minPairs?: number;
  maxScaleChange?: number;
  smoothing?: number;
};

/** 四元数の正規化線形補間（a から b へ t。符号を揃える） */
function quatNlerp(a: Quat, b: Quat, t: number): Quat {
  const sign = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3] < 0 ? -1 : 1;
  return quatNormalize([
    a[0] + t * (sign * b[0] - a[0]),
    a[1] + t * (sign * b[1] - a[1]),
    a[2] + t * (sign * b[2] - a[2]),
    a[3] + t * (sign * b[3] - a[3]),
  ]);
}

/**
 * 組を溜めて相似変換を更新する。SLAM がリセットされたら（座標系が変わる）clear() する。
 * 位置の推定値（estimate）は、採用条件を満たした推定だけで更新し、弾いたときや組が足りなくなったときは直前のものを残す（clear() で消える）
 */
export class SlamFusion {
  readonly opts: FusionOptions;
  pairs: Correspondence[] = [];
  /** 採用した推定（スケール・回転は EMA 済み） */
  estimate: SimilarityEstimate | null = null;
  /** 直近の推定を弾いた理由（直近で採用した・推定できなかったときは null） */
  lastRejection: RejectReason | null = null;
  /** 採用した回数 */
  adopted = 0;
  private lastAddMs = -Infinity;
  private scaleRejectStreak = 0;

  constructor(opts: FusionOptions) {
    this.opts = opts;
  }

  /** 組を足して推定し直す。間隔が短くて足さなかったら false */
  add(pair: Correspondence, nowMs: number): boolean {
    if (nowMs - this.lastAddMs < this.opts.minPairIntervalMs) return false;
    this.lastAddMs = nowMs;
    this.pairs.push(pair);
    if (this.pairs.length > this.opts.maxPairs) this.pairs.splice(0, this.pairs.length - this.opts.maxPairs);
    this.update();
    return true;
  }

  private update() {
    const e = robustEstimate(this.pairs, this.opts);
    if (!e) {
      this.lastRejection = null;
      return;
    }
    const maxRatio = this.opts.maxResidualRatio ?? ACCEPT_MAX_RESIDUAL_RATIO;
    const minPairs = this.opts.minPairs ?? ACCEPT_MIN_PAIRS;
    const maxScaleChange = this.opts.maxScaleChange ?? ACCEPT_MAX_SCALE_CHANGE;
    const alpha = this.opts.smoothing ?? ADOPT_SMOOTHING;
    const prev = this.estimate;
    let reason: RejectReason | null = null;
    if (e.residualM > maxRatio * e.baselineM) reason = "res";
    else if (e.count < minPairs) reason = "n";
    else if (prev && Math.abs(e.sim.scale / prev.sim.scale - 1) > maxScaleChange) reason = "scale";
    if (reason === "scale" && ++this.scaleRejectStreak >= SCALE_RELOCK_STREAK) {
      // 同じ向きに外れた推定が続く = 前回の採用の方が誤り。平滑化せずに取り直す
      this.scaleRejectStreak = 0;
      this.estimate = e;
      this.lastRejection = null;
      this.adopted++;
      return;
    }
    if (reason) {
      if (reason !== "scale") this.scaleRejectStreak = 0;
      this.lastRejection = reason;
      return;
    }
    this.scaleRejectStreak = 0;
    this.lastRejection = null;
    this.adopted++;
    if (!prev) {
      this.estimate = e;
      return;
    }
    // スケールと回転は前回から寄せ、平行移動はその回転・スケールで今回の重心どうしを合わせ直す（写像を重心で一致させる）
    const scale = prev.sim.scale + alpha * (e.sim.scale - prev.sim.scale);
    const quat = quatNlerp(prev.sim.quat, e.sim.quat, alpha);
    const rc = rotateVec(quat, e.centroidSlam);
    const cf = e.centroidField;
    this.estimate = { ...e, sim: { scale, quat, trans: [cf[0] - scale * rc[0], cf[1] - scale * rc[1], cf[2] - scale * rc[2]] } };
  }

  clear() {
    this.pairs = [];
    this.estimate = null;
    this.lastRejection = null;
    this.lastAddMs = -Infinity;
    this.scaleRejectStreak = 0;
  }

  /** SLAM の位置（three 流儀）→ field 座標系。まだ推定できていなければ null */
  toField(slamPos: V3): V3 | null {
    return this.estimate ? applySimilarity(this.estimate.sim, slamPos) : null;
  }

  /** HUD 用（"s=2.70 res=0.012m base=0.21m span=0.62m n=40(-1)" / "calib n=3"。弾いたら末尾に " rejected(res)"） */
  describe(): string {
    const e = this.estimate;
    const rej = this.lastRejection ? ` rejected(${this.lastRejection})` : "";
    if (!e) return `calib n=${this.pairs.length}${rej}`;
    return `s=${e.sim.scale.toFixed(2)} res=${e.residualM.toFixed(3)}m base=${e.baselineM.toFixed(2)}m span=${e.spanM.toFixed(2)}m n=${e.count}${e.outliers ? `(-${e.outliers})` : ""}${rej}`;
  }
}
