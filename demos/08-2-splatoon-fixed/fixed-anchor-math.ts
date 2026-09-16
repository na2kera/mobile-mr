// 08-2「一度合わせて固定」の純粋な数学（docs/space-stability-options.md §4 の 5b）。
// three.js に依存しない（配列だけ）ので Node の回帰テスト（scripts/test-08-2-fixed.mjs）から直接 import できる。
//   - 観測の「信頼できる度合い」: マーカーがカメラの正面・近距離・画面の中央にあり、傾きと再投影誤差が小さいか
//   - 位置合わせの窓: 信頼できる観測が N 回連続し、その間の位置とヨーのばらつきが小さければ確定
//   - 確定の姿勢: 位置は成分ごとの中央値、回転は符号を揃えた四元数の平均
//   - 確定後の緩やかな補正: 位置は lerp、回転は slerp（係数 refine。0 で完全固定）
// 相対 import を持たないのは、Node から .ts のまま import するとき拡張子無しの相対 import が解決できないため

export type V3 = [number, number, number];
/** 四元数 [x, y, z, w]（three.js と同じ並び） */
export type Quat = [number, number, number, number];
export type Pose = { pos: V3; quat: Quat };

/** 1 回の観測の質（マーカー 1 枚ぶん。複数見えたときは最も条件の良い 1 枚） */
export type Quality = {
  /** カメラからマーカー中心までの距離 [m] */
  distM: number;
  /** カメラの光軸（画面の中央）からマーカー中心までの角度 [deg]。0 = 画面のど真ん中 */
  offAxisDeg: number;
  /** マーカーの法線と「マーカー → カメラ」の向きの角度 [deg]。0 = 真正面から見ている */
  facingDeg: number;
  /** 水平化する前のアンカーの傾き [deg]（marker-anchor.ts の tiltDeg。worldUp が無ければ 0） */
  tiltDeg: number;
  /** 正規化再投影誤差（marker-detector.ts の error。複数なら最大） */
  err: number;
};

export type TrustLimits = {
  maxDistM: number;
  maxOffAxisDeg: number;
  maxFacingDeg: number;
  maxTiltDeg: number;
  maxErr: number;
};

/**
 * 既定の閾値。「正面 1m に立つ」誘導で自然に満たせ、斜め（30° 超）や遠い（2m 超）観測は落とす値。
 * tilt は issue #54 の計測で正面付近の POSIT が 10〜30° 外すことがあるので 15° まで許す（水平化で消える誤差なので位置には効かない）
 */
export const DEFAULT_TRUST_LIMITS: TrustLimits = {
  maxDistM: 1.6,
  maxOffAxisDeg: 20,
  maxFacingDeg: 25,
  maxTiltDeg: 15,
  maxErr: 0.15,
};

export type UntrustedReason = "far" | "off" | "face" | "tilt" | "err";

/** 観測が信頼できなければ最初に引っかかった理由を、信頼できれば null を返す */
export function untrustedReason(q: Quality, limits: TrustLimits = DEFAULT_TRUST_LIMITS): UntrustedReason | null {
  if (!Number.isFinite(q.err) || q.err > limits.maxErr) return "err";
  if (q.distM > limits.maxDistM) return "far";
  if (q.offAxisDeg > limits.maxOffAxisDeg) return "off";
  if (q.facingDeg > limits.maxFacingDeg) return "face";
  if (q.tiltDeg > limits.maxTiltDeg) return "tilt";
  return null;
}

/**
 * マーカー → カメラ座標系の 4x4（列優先 16 要素。カメラは three.js 規約で -Z 前方）から観測の質を出す。
 * 位置（列 3）から距離と画面中央からの角度、法線（列 2 = マーカーの +Z、面から視点側）から正対の度合い
 */
export function markerQuality(markerToCam: readonly number[], tiltDeg: number, err: number): Quality {
  const c: V3 = [markerToCam[12], markerToCam[13], markerToCam[14]];
  const distM = Math.hypot(c[0], c[1], c[2]);
  if (distM < 1e-9) return { distM: 0, offAxisDeg: 0, facingDeg: 0, tiltDeg, err };
  const toCam: V3 = [-c[0] / distM, -c[1] / distM, -c[2] / distM];
  // 光軸は -Z。カメラの後ろ（c.z > 0）なら 180° に近づく
  const offAxisDeg = degOf(clamp(-c[2] / distM));
  const n = normalize([markerToCam[8], markerToCam[9], markerToCam[10]]);
  const facingDeg = degOf(clamp(n[0] * toCam[0] + n[1] * toCam[1] + n[2] * toCam[2]));
  return { distM, offAxisDeg, facingDeg, tiltDeg, err };
}

/** 2 つの回転の差 [deg]（0〜180） */
export function quatAngleDeg(a: Quat, b: Quat): number {
  const d = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  return degOf(clamp(d)) * 2;
}

/** 四元数の平均（最初の要素と同じ半球に符号を揃えてから足して正規化。ばらつきが小さい前提の近似） */
export function averageQuat(quats: readonly Quat[]): Quat {
  if (quats.length === 0) throw new Error("averageQuat: 空");
  const ref = quats[0];
  const sum: Quat = [0, 0, 0, 0];
  for (const q of quats) {
    const s = q[0] * ref[0] + q[1] * ref[1] + q[2] * ref[2] + q[3] * ref[3] < 0 ? -1 : 1;
    for (let i = 0; i < 4; i++) sum[i] += q[i] * s;
  }
  return normalizeQuat(sum);
}

/** 位置は成分ごとの中央値、回転は平均 */
export function medianPose(samples: readonly Pose[]): Pose {
  if (samples.length === 0) throw new Error("medianPose: 空");
  const pos: V3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) pos[i] = median(samples.map((s) => s.pos[i]));
  return { pos, quat: averageQuat(samples.map((s) => s.quat)) };
}

/** 確定後の緩やかな補正 1 回ぶん（位置 lerp・回転 slerp。alpha 0 で動かない） */
export function emaPose(current: Pose, target: Pose, alpha: number): Pose {
  const a = Math.max(0, Math.min(1, alpha));
  return {
    pos: [
      current.pos[0] + (target.pos[0] - current.pos[0]) * a,
      current.pos[1] + (target.pos[1] - current.pos[1]) * a,
      current.pos[2] + (target.pos[2] - current.pos[2]) * a,
    ],
    quat: slerp(current.quat, target.quat, a),
  };
}

export function slerp(a: Quat, b: Quat, t: number): Quat {
  let cos = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  let bb: Quat = b;
  if (cos < 0) {
    cos = -cos;
    bb = [-b[0], -b[1], -b[2], -b[3]];
  }
  if (cos > 0.9995) {
    return normalizeQuat([
      a[0] + (bb[0] - a[0]) * t,
      a[1] + (bb[1] - a[1]) * t,
      a[2] + (bb[2] - a[2]) * t,
      a[3] + (bb[3] - a[3]) * t,
    ]);
  }
  const theta = Math.acos(clamp(cos));
  const s = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / s;
  const wb = Math.sin(t * theta) / s;
  return [a[0] * wa + bb[0] * wb, a[1] * wa + bb[1] * wb, a[2] * wa + bb[2] * wb, a[3] * wa + bb[3] * wb];
}

export function distance3(a: V3, b: V3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export type AlignWindowOptions = {
  /** 確定に必要な連続観測の数 */
  samples: number;
  /** 窓の中の位置のばらつき（中央値からの最大距離）の上限 [m] */
  maxSpreadM: number;
  /** 窓の中の回転のばらつき（平均からの最大角度）の上限 [deg] */
  maxAngleDeg: number;
};

/**
 * 位置合わせの窓。信頼できる観測だけを push し（信頼できない観測やロストでは呼び出し側が reset する）、
 * 直近 samples 個が揃って位置と回転のばらつきが小さければ ready。ばらつきが大きいときは古いものから捨てて滑らせる
 */
export class AlignWindow {
  private readonly buf: Pose[] = [];
  /** 直近の push で測ったばらつき（HUD 用） */
  spreadM = 0;
  angleDeg = 0;

  readonly opts: AlignWindowOptions;

  constructor(opts: AlignWindowOptions) {
    if (!(opts.samples >= 1)) throw new Error("AlignWindow: samples は 1 以上");
    this.opts = opts;
  }

  get count(): number {
    return this.buf.length;
  }

  /** 窓が満杯で、ばらつきが閾値内か */
  get ready(): boolean {
    return this.buf.length >= this.opts.samples && this.stable;
  }

  /** いまの窓のばらつきが閾値内か（満杯でなくても評価する） */
  get stable(): boolean {
    return this.spreadM <= this.opts.maxSpreadM && this.angleDeg <= this.opts.maxAngleDeg;
  }

  push(sample: Pose): void {
    this.buf.push({ pos: [...sample.pos] as V3, quat: [...sample.quat] as Quat });
    while (this.buf.length > this.opts.samples) this.buf.shift();
    this.measure();
  }

  reset(): void {
    this.buf.length = 0;
    this.spreadM = 0;
    this.angleDeg = 0;
  }

  /** 確定の姿勢（中央値 / 平均）。空なら null */
  result(): Pose | null {
    return this.buf.length === 0 ? null : medianPose(this.buf);
  }

  private measure(): void {
    if (this.buf.length < 2) {
      this.spreadM = 0;
      this.angleDeg = 0;
      return;
    }
    const m = medianPose(this.buf);
    this.spreadM = Math.max(...this.buf.map((s) => distance3(s.pos, m.pos)));
    this.angleDeg = Math.max(...this.buf.map((s) => quatAngleDeg(s.quat, m.quat)));
  }
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function normalize(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

function normalizeQuat(q: Quat): Quat {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

function clamp(v: number): number {
  return Math.max(-1, Math.min(1, v));
}

function degOf(cos: number): number {
  return (Math.acos(cos) * 180) / Math.PI;
}
