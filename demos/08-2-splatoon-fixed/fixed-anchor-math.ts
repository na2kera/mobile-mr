// 08-2「一度合わせて固定」の純粋な数学（docs/space-stability-options.md §4 の 5b）。
// three.js に依存しない（配列だけ）ので Node の回帰テスト（scripts/test-08-2-fixed.mjs）から直接 import できる。
//   - 観測の「信頼できる度合い」: マーカーがカメラの正面・近距離・画面の中央にあり、傾きと再投影誤差が小さいか
//   - 位置合わせの窓: 直近 windowLen 回の観測のうち信頼できる観測が N 回あり、その N 回の位置とヨーのばらつきが小さければ確定
//   - 確定の姿勢: 位置は成分ごとの中央値、回転は符号を揃えた四元数の平均
//   - 確定後の緩やかな補正: 位置は lerp、回転は slerp（係数 refine。0 で完全固定）
// 相対 import を持たないのは、Node から .ts のまま import するとき拡張子無しの相対 import が解決できないため

export type V3 = [number, number, number];
/** 四元数 [x, y, z, w]（three.js と同じ並び） */
export type Quat = [number, number, number, number];
export type Pose = { pos: V3; quat: Quat };

/** 1 回の観測の質（マーカー 1 枚ぶん。複数枚を同時に使った観測は fixed-anchor.ts が評価せずにスキップする） */
export type Quality = {
  /** カメラからマーカー中心までの距離 [m] */
  distM: number;
  /** カメラの光軸（画面の中央）からマーカー中心までの角度 [deg]。0 = 画面のど真ん中 */
  offAxisDeg: number;
  /**
   * マーカーの法線と「マーカー → カメラ」の向きの角度 [deg]。0 = 真正面から見ている。
   * 上向き（upCam）が分かっていて壁のマーカー（法線が水平に近い）なら、両方を水平面に投影した角度（目とマーカーの高さの差で落ちない）
   */
  facingDeg: number;
  /** 壁のマーカーで上向きが分かっているとき、「マーカー → カメラ」が水平面から上下に何度ずれているか [deg]（高さの差の目安）。それ以外は 0 */
  elevationDeg: number;
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
 * 既定の閾値（gravityAlign が off のとき）。「正面 1m に立つ」誘導で自然に満たせ、斜め（30° 超）や遠い（2m 超）観測は落とす値。
 * tilt は issue #54 の計測で正面付近の POSIT が 10〜30° 外すことがあるので 15° まで許す
 */
export const DEFAULT_TRUST_LIMITS: TrustLimits = {
  maxDistM: 1.6,
  maxOffAxisDeg: 20,
  maxFacingDeg: 25,
  maxTiltDeg: 15,
  maxErr: 0.15,
};

/**
 * gravityAlign が on のときの tilt の上限 [deg]。水平化（marker-anchor.ts の worldUp）ではアンカーの Y 軸をジャイロの上に固定し、
 * マーカーからは位置（画像上の位置と大きさでほぼ決まる）とヨー（法線を水平面に投影）だけを採るので、傾きの推定誤差は位置に効かない。
 * 150mm・1.0m・角 ±1px のノイズで tilt > 15° が 11.7%、1.6m で 38.3%（Fable の合成実験）あり、15° では実機で確定に数十秒かかるため 30° に緩める
 */
export const LEVELED_MAX_TILT_DEG = 30;

/**
 * gravityAlign が on のときの位置合わせの窓の回転のばらつき（平均からの最大角度）の上限 [deg]。off のときは DEFAULT_ALIGN_ANGLE_DEG（3°）。
 * 水平化では回転はヨーだけで、POSIT のヨーは 150mm・1.0m・角 ±1px で ±15° ばらつく（10 回の最大ずれの中央値 12°）ので、3° では
 * 実機でほぼ確定しない（合成実験で 30 観測以内 0/300）。15° なら 300/300 がほぼ 10 観測目で確定し、10 回の平均を取るので
 * 確定後のヨー誤差は中央値 1.7°・p90 3.7°（scripts/test-08-2-fixed.mjs の合成テスト、README の表）
 */
export const LEVELED_ALIGN_ANGLE_DEG = 15;
export const DEFAULT_ALIGN_ANGLE_DEG = 3;

/** gravityAlign の有無に応じた窓の回転のばらつきの上限の既定 [deg] */
export function defaultAlignAngleDeg(gravityAlign: boolean): number {
  return gravityAlign ? LEVELED_ALIGN_ANGLE_DEG : DEFAULT_ALIGN_ANGLE_DEG;
}

/** gravityAlign の有無に応じた既定の閾値 */
export function defaultTrustLimits(gravityAlign: boolean): TrustLimits {
  return gravityAlign ? { ...DEFAULT_TRUST_LIMITS, maxTiltDeg: LEVELED_MAX_TILT_DEG } : { ...DEFAULT_TRUST_LIMITS };
}

export type UntrustedReason = "far" | "off" | "face" | "tilt" | "err" | "nan";

/** 観測が信頼できなければ最初に引っかかった理由を、信頼できれば null を返す。数値が壊れている（NaN / Infinity）観測は "nan" */
export function untrustedReason(q: Quality, limits: TrustLimits = DEFAULT_TRUST_LIMITS): UntrustedReason | null {
  if (!Number.isFinite(q.distM) || !Number.isFinite(q.offAxisDeg) || !Number.isFinite(q.facingDeg) || !Number.isFinite(q.tiltDeg)) return "nan";
  if (!Number.isFinite(q.err) || q.err > limits.maxErr) return "err";
  if (q.distM > limits.maxDistM) return "far";
  if (q.offAxisDeg > limits.maxOffAxisDeg) return "off";
  if (q.facingDeg > limits.maxFacingDeg) return "face";
  if (q.tiltDeg > limits.maxTiltDeg) return "tilt";
  return null;
}

/** 法線と上向きの角度の余弦がこれ未満なら「壁のマーカー」（法線が水平から 45° 以内）として水平面で正対を評価する */
const WALL_NORMAL_MAX_UP_COS = Math.SQRT1_2;

/**
 * マーカー → カメラ座標系の 4x4（列優先 16 要素。カメラは three.js 規約で -Z 前方）から観測の質を出す。
 * 位置（列 3）から距離と画面中央からの角度、法線（列 2 = マーカーの +Z、面から視点側）から正対の度合い。
 * upCam（カメラ座標系での重力の上。gravityAlign が on のとき）を渡すと、壁のマーカーの正対は水平面に投影した角度で測る
 * （水平化ではヨーだけを法線から採るので、効くのは水平面内の角度。目とマーカーの高さの差は elevationDeg に分けて出す）。
 * 床のマーカー（法線が上に近い）は投影が潰れるので 3D の角度のまま
 */
export function markerQuality(markerToCam: readonly number[], tiltDeg: number, err: number, upCam: V3 | null = null): Quality {
  const c: V3 = [markerToCam[12], markerToCam[13], markerToCam[14]];
  const distM = Math.hypot(c[0], c[1], c[2]);
  if (distM < 1e-9) return { distM: 0, offAxisDeg: 0, facingDeg: 0, elevationDeg: 0, tiltDeg, err };
  const toCam: V3 = [-c[0] / distM, -c[1] / distM, -c[2] / distM];
  // 光軸は -Z。カメラの後ろ（c.z > 0）なら 180° に近づく
  const offAxisDeg = degOf(clamp(-c[2] / distM));
  const n = normalize([markerToCam[8], markerToCam[9], markerToCam[10]]);
  let facingDeg = degOf(clamp(dot3(n, toCam)));
  let elevationDeg = 0;
  const upLen = upCam ? Math.hypot(upCam[0], upCam[1], upCam[2]) : 0;
  if (upCam && upLen > 1e-9) {
    const u: V3 = [upCam[0] / upLen, upCam[1] / upLen, upCam[2] / upLen];
    if (Math.abs(dot3(n, u)) < WALL_NORMAL_MAX_UP_COS) {
      const nh = sub3(n, scale3(u, dot3(n, u)));
      const th = sub3(toCam, scale3(u, dot3(toCam, u)));
      const nhLen = Math.hypot(nh[0], nh[1], nh[2]);
      const thLen = Math.hypot(th[0], th[1], th[2]);
      elevationDeg = 90 - degOf(clamp(Math.abs(dot3(toCam, u))));
      // 真上 / 真下から見ている（水平成分が無い）ときは 3D の角度のまま
      if (nhLen > 1e-6 && thLen > 1e-6) facingDeg = degOf(clamp(dot3(nh, th) / (nhLen * thLen)));
    }
  }
  return { distM, offAxisDeg, facingDeg, elevationDeg, tiltDeg, err };
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

/**
 * 確定後の緩やかな補正 1 回ぶん（observation を anchor に alpha で馴染ませる）。観測が anchor から位置で maxM・回転で maxDeg 以上
 * 離れていれば（POSIT の鏡像解などの疑い。回転だけ大きく誤る解も含む）null を返して補正しない
 */
export function refineStep(anchor: Pose, observation: Pose, alpha: number, maxM: number, maxDeg: number): Pose | null {
  if (!(alpha > 0)) return null;
  if (distance3(anchor.pos, observation.pos) > maxM) return null;
  if (quatAngleDeg(anchor.quat, observation.quat) > maxDeg) return null;
  return emaPose(anchor, observation, alpha);
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
  /** 確定に必要な「信頼できる観測」の数 */
  samples: number;
  /** 直近何回の観測（信頼できない観測も数える）の中に samples 回の信頼できる観測があれば良いか。省略時・samples 未満なら samples（= 連続） */
  windowLen?: number;
  /** 窓の中の位置のばらつき（中央値からの最大距離）の上限 [m] */
  maxSpreadM: number;
  /** 窓の中の回転のばらつき（平均からの最大角度）の上限 [deg] */
  maxAngleDeg: number;
};

/**
 * 位置合わせの窓。観測ごとに、信頼できれば push、信頼できなければ pushUntrusted を呼ぶ（ロストでは呼び出し側が reset する）。
 * 直近 windowLen 回の観測のうち信頼できる観測が samples 回あり、その直近 samples 回の位置と回転のばらつきが小さければ ready。
 * 信頼できない観測 1 回で窓を捨てない（実機では tilt などで数回に 1 回落ちるので、連続を要求すると確定に数十秒かかる）。
 * ばらつきが大きいときは古いものから捨てて滑らせる
 */
export class AlignWindow {
  /** 直近 windowLen 回の観測。null = 信頼できなかった観測 */
  private readonly buf: (Pose | null)[] = [];
  private readonly windowLen: number;
  /** 直近の push で測ったばらつき（HUD 用） */
  spreadM = 0;
  angleDeg = 0;

  readonly opts: AlignWindowOptions;

  constructor(opts: AlignWindowOptions) {
    if (!(opts.samples >= 1)) throw new Error("AlignWindow: samples は 1 以上");
    this.opts = opts;
    this.windowLen = Math.max(opts.samples, Math.round(opts.windowLen ?? opts.samples));
  }

  /** 窓の中の信頼できる観測の数（samples で頭打ち。「合わせ中 n/N」の n） */
  get count(): number {
    return Math.min(this.opts.samples, this.trusted().length);
  }

  /** 窓が満杯で、ばらつきが閾値内か */
  get ready(): boolean {
    return this.trusted().length >= this.opts.samples && this.stable;
  }

  /** いまの窓のばらつきが閾値内か（満杯でなくても評価する） */
  get stable(): boolean {
    return this.spreadM <= this.opts.maxSpreadM && this.angleDeg <= this.opts.maxAngleDeg;
  }

  /** 信頼できる観測 */
  push(sample: Pose): void {
    this.append({ pos: [...sample.pos] as V3, quat: [...sample.quat] as Quat });
  }

  /** 信頼できなかった観測（窓の長さだけ進める。捨てない） */
  pushUntrusted(): void {
    this.append(null);
  }

  private append(entry: Pose | null): void {
    this.buf.push(entry);
    while (this.buf.length > this.windowLen) this.buf.shift();
    this.measure();
  }

  /** 窓の中の信頼できる観測のうち直近 samples 個 */
  private trusted(): Pose[] {
    const out = this.buf.filter((s): s is Pose => s !== null);
    return out.length > this.opts.samples ? out.slice(out.length - this.opts.samples) : out;
  }

  reset(): void {
    this.buf.length = 0;
    this.spreadM = 0;
    this.angleDeg = 0;
  }

  /** 確定の姿勢（中央値 / 平均）。空なら null */
  result(): Pose | null {
    const t = this.trusted();
    return t.length === 0 ? null : medianPose(t);
  }

  private measure(): void {
    const t = this.trusted();
    if (t.length < 2) {
      this.spreadM = 0;
      this.angleDeg = 0;
      return;
    }
    const m = medianPose(t);
    this.spreadM = Math.max(...t.map((s) => distance3(s.pos, m.pos)));
    this.angleDeg = Math.max(...t.map((s) => quatAngleDeg(s.quat, m.quat)));
  }
}

/** marker-anchor.ts の info（"id=0+5 err=0.03,0.05 ..."）から再投影誤差の最大を読む。無ければ Infinity（信頼しない） */
export function maxErrOf(info: string): number {
  const m = info.match(/err=([\d.,]+)/);
  if (!m) return Infinity;
  const values = m[1].split(",").map(Number).filter(Number.isFinite);
  return values.length === 0 ? Infinity : Math.max(...values);
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function dot3(a: V3, b: V3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function sub3(a: V3, b: V3): V3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function scale3(a: V3, s: number): V3 {
  return [a[0] * s, a[1] * s, a[2] * s];
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
