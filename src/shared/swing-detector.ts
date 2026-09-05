// Phase 10: Joy-Con のジャイロ（角速度）の時系列から「パターの振り」を検出する状態機械（純粋）。
// 06-2 の ThrowDetector と同じ立ち位置（three.js に依存させず、Node の回帰テストから叩く）。
//
// 考え方: Joy-Con の位置は取れない（IMU だけ）ので、振りを「構えた向きからの回転角」で表す。
//   - 静止（角速度が小さい状態が stillMs 続く）で「構え」= 回転の積分をゼロにする。A ボタンでも同じ
//   - 角速度を本体座標系のまま積分して回転ベクトル θ（小角近似。パターの振りは ±60° 程度なので十分）を持つ
//   - バックスイングで |θ| が伸び、その最大のときの向きを「振りの軸 n」とする（持ち方に依存しない）
//   - 戻りで θ·n が 0 を横切った瞬間がインパクト。速さは そのときの角速度の n 成分 |ω·n| [deg/s]
//     （ボールの速さは呼ぶ側が armLength × ω で出す。実機で strokeGain として合わせ込む）
//   - フェイスの開き（左右のずれ）は、構えのときの重力方向（加速度の平均）まわりの回転 θ·g
//   - バックスイングが minBackswingDeg 未満なら振りとみなさない（持ち直しや手ブレ）
// 3 サンプル × 5ms が 15ms ごとに来る（レポート 0x30）ので、サンプルごとに dt=5ms として積分する
import type { V3 } from "./joycon-report.ts";

export type SwingDetectorOptions = {
  /** 「静止」とみなす角速度 [deg/s] */
  stillDps: number;
  /** この時間 [ms] 静止したら構え直す（積分をゼロにする） */
  stillMs: number;
  /** 振りとみなすバックスイングの最小角 [deg] */
  minBackswingDeg: number;
  /** インパクトとみなす角速度の最小 [deg/s]（これより遅い戻りは素振り） */
  minImpactDps: number;
  /** バックスイングを始めてからこの時間 [ms] 戻ってこなければ捨てる */
  maxSwingMs: number;
};

export const DEFAULT_SWING_OPTIONS: SwingDetectorOptions = {
  stillDps: 25,
  stillMs: 250,
  minBackswingDeg: 6,
  // 短い寄せ（振幅 8°・周期 1.6s で最大 30 deg/s 程度）も拾えるよう低め。速さの下限は golf-sim の minStrokeSpeed が別に縛る
  minImpactDps: 20,
  maxSwingMs: 3000,
};

export type Impact = {
  /** インパクト時の角速度の振り軸成分 [deg/s]（正） */
  dps: number;
  /** バックスイングの最大角 [deg] */
  backswingDeg: number;
  /** フェイスの開き [deg]（構えのときの鉛直軸まわりの回転。+ は反時計回り = 上から見て左） */
  faceDeg: number;
  /** バックスイングを始めてからインパクトまで [ms] */
  swingMs: number;
};

export type SwingPhase = "idle" | "address" | "backswing" | "forward";

/** 上から見て反時計回りが + になるよう、鉛直軸（重力の逆）まわりの回転成分を返す */
function dot(a: V3, b: V3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export class SwingDetector {
  readonly opts: SwingDetectorOptions;
  phase: SwingPhase = "idle";
  /** 構えからの回転ベクトル [deg]（本体座標系） */
  readonly theta: V3 = [0, 0, 0];
  /** 構えたときの「上」（重力の逆。本体座標系。加速度の平均から） */
  private up: V3 = [0, 0, 1];
  private accelSum: V3 = [0, 0, 0];
  private accelCount = 0;
  /** 静止中の角速度の積算（構えでバイアスにする。積分の漂いと偽のバックスイングを防ぐ） */
  private gyroSum: V3 = [0, 0, 0];
  /** ジャイロのバイアス [deg/s]（構えのときの静止時の平均。sample で引く） */
  readonly bias: V3 = [0, 0, 0];
  private stillSinceMs: number | null = null;
  private axis: V3 = [0, 0, 0];
  private peakDeg = 0;
  private backswingStartMs = 0;
  /** 直前のサンプルの振り軸成分（0 を横切ったかの判定） */
  private prevAlong = 0;
  /** 静止して構えた回数（HUD 用） */
  addresses = 0;

  constructor(opts: Partial<SwingDetectorOptions> = {}) {
    this.opts = { ...DEFAULT_SWING_OPTIONS, ...opts };
  }

  /** 現在の振り角 [deg]（振り軸に沿って。バックスイング側が正。構え前は |θ|） */
  get angleDeg(): number {
    const a = this.axis;
    const n = Math.hypot(a[0], a[1], a[2]);
    if (n === 0) return Math.hypot(this.theta[0], this.theta[1], this.theta[2]);
    return dot(this.theta, a) / n;
  }

  /** 構え直す（A ボタン）。積分をゼロにし、直近の静止中の加速度から「上」、角速度からバイアスを取る */
  address(now: number) {
    this.theta[0] = this.theta[1] = this.theta[2] = 0;
    if (this.accelCount > 0) {
      const n = Math.hypot(this.accelSum[0], this.accelSum[1], this.accelSum[2]);
      if (n > 0) this.up = [this.accelSum[0] / n, this.accelSum[1] / n, this.accelSum[2] / n];
      this.bias[0] = this.gyroSum[0] / this.accelCount;
      this.bias[1] = this.gyroSum[1] / this.accelCount;
      this.bias[2] = this.gyroSum[2] / this.accelCount;
    }
    this.accelSum = [0, 0, 0];
    this.gyroSum = [0, 0, 0];
    this.accelCount = 0;
    this.axis = [0, 0, 0];
    this.peakDeg = 0;
    this.prevAlong = 0;
    this.phase = "address";
    this.stillSinceMs = now;
    this.addresses++;
  }

  /**
   * 1 サンプル（角速度 [deg/s]・加速度 [g]、dt [s]）。インパクトを検出したらその情報を返す。
   * now は呼ぶ側の時計 [ms]（静止時間と振りの長さの判定にだけ使う）
   */
  sample(now: number, rawGyro: V3, accel: V3, dt: number): Impact | null {
    // 静止の判定は生の角速度で（バイアスを引く前。バイアスは数 deg/s なので stillDps より小さい）
    const rawSpeed = Math.hypot(rawGyro[0], rawGyro[1], rawGyro[2]);
    const gyro: V3 = [rawGyro[0] - this.bias[0], rawGyro[1] - this.bias[1], rawGyro[2] - this.bias[2]];
    // 静止の監視: 静止が続いたら構え直す（積分の漂いも消える）。ただし振りの途中（バックスイングの頂点で止まる・ゆっくりの
    // 切り返し）では構え直さない（外部レビュー指摘: 頂点で 0.3s 止まると振りを丸ごと捨てていた）。戻ってこない振りは maxSwingMs が捨てる
    if (rawSpeed < this.opts.stillDps) {
      this.accelSum[0] += accel[0];
      this.accelSum[1] += accel[1];
      this.accelSum[2] += accel[2];
      this.gyroSum[0] += rawGyro[0];
      this.gyroSum[1] += rawGyro[1];
      this.gyroSum[2] += rawGyro[2];
      this.accelCount++;
      if (this.stillSinceMs === null) this.stillSinceMs = now;
      else if (now - this.stillSinceMs >= this.opts.stillMs && (this.phase === "idle" || (this.phase === "address" && Math.hypot(this.theta[0], this.theta[1], this.theta[2]) > 1))) {
        // idle → 構え。address で漂っていたら（1° 以上）構え直して漂いを消す
        this.address(now);
        return null;
      }
    } else {
      this.stillSinceMs = null;
      if (this.phase === "idle") return null;
    }
    if (this.phase === "idle") return null;
    // 積分（本体座標系の回転ベクトル。小角近似）
    this.theta[0] += gyro[0] * dt;
    this.theta[1] += gyro[1] * dt;
    this.theta[2] += gyro[2] * dt;
    const mag = Math.hypot(this.theta[0], this.theta[1], this.theta[2]);
    if (this.phase === "address") {
      if (mag >= this.opts.minBackswingDeg) {
        this.phase = "backswing";
        this.backswingStartMs = now;
        this.peakDeg = mag;
        this.axis = [this.theta[0] / mag, this.theta[1] / mag, this.theta[2] / mag];
        this.prevAlong = mag;
      }
      return null;
    }
    if (now - this.backswingStartMs > this.opts.maxSwingMs) {
      // 戻ってこない: 捨てて構え待ちに（静止すれば構え直す）
      this.phase = "idle";
      return null;
    }
    const along = dot(this.theta, this.axis);
    if (this.phase === "backswing") {
      if (mag > this.peakDeg) {
        // まだ上げている: 軸を更新（バックスイングの頂点の向き）
        this.peakDeg = mag;
        this.axis = [this.theta[0] / mag, this.theta[1] / mag, this.theta[2] / mag];
        this.prevAlong = mag;
        return null;
      }
      // 頂点を過ぎて戻り始めた
      if (dot(gyro, this.axis) < 0) this.phase = "forward";
      this.prevAlong = along;
      return null;
    }
    // forward: 振り軸成分が 0 を横切ったらインパクト
    if (this.prevAlong > 0 && along <= 0) {
      const dps = -dot(gyro, this.axis);
      const faceDeg = dot(this.theta, this.up);
      const impact: Impact = { dps, backswingDeg: this.peakDeg, faceDeg, swingMs: now - this.backswingStartMs };
      this.phase = "idle";
      this.prevAlong = along;
      return dps >= this.opts.minImpactDps ? impact : null;
    }
    this.prevAlong = along;
    return null;
  }
}

/**
 * 角速度 [deg/s] とパターの長さ（支点からヘッドまで）[m] からボールの初速 [m/s]。
 * 実物のパットはヘッドの速さより少し速く飛び出す（反発）ので gain で合わせ込む
 */
export function impactSpeed(dps: number, armM: number, gain: number): number {
  return ((dps * Math.PI) / 180) * armM * gain;
}
