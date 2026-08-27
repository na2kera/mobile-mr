// Phase 6-2: 手のひらの位置・速度の時系列から「投げた（離した）」瞬間を検出する状態機械（純粋）。
// MediaPipe は手の 21 点しか返さず「離した」は無いので、
//   速さが閾値を超えて壁方向（-Z）へ動き始めた → 振り（swing）
//   ピークの速さから releaseRatio まで落ちた / 壁方向の成分が無くなった / 長すぎる / 手を見失った → 離した
// とみなす。three.js に依存させず、main.ts からは board 座標系に直したサンプルを渡す
// （Node の回帰テスト scripts/test-darts.mjs から直接叩くため）。
//
// 投げの位置と速度の組み合わせ（設計判断。CONCEPT.md Phase 6-2 参照）:
//   速度 = ピーク時の速度、位置 = 減速を検出した時点（直近サンプル）の位置。
//   位置は EMA 平滑化の遅れでピーク時点では実際より手前に出るが、ピークの後も手は進行方向へ進む
//   （フォロースルー）ので、減速検出時の位置の方が実際に離した位置に近い。速度は減速後では
//   小さすぎるのでピークを使う。両者の時刻差は 1〜2 サンプル（30〜60ms）で、その間の移動は
//   進行方向に沿うため着弾のずれは重力落下 g·δ·T ≈ 数 cm に収まる
import type { V3 } from "./darts-sim.ts";

export type ThrowDetectorOptions = {
  /** 「振り始め」とみなす手のひらの速さ [m/s] */
  minSpeed: number;
  /** ピークからこの割合まで落ちたら「離した」とみなす */
  releaseRatio: number;
  /** 振りがこれ以上続いたら打ち切って離した扱い [ms] */
  maxSwingMs: number;
};

export type Swing = {
  startMs: number;
  peakSpeed: number;
  peakVel: V3;
  /** 直近のサンプルの位置（= 離す位置） */
  lastPos: V3;
};

export type Release = {
  pos: V3;
  vel: V3;
  peakSpeed: number;
  why: "slowed" | "backward" | "timeout" | "lost";
};

export class ThrowDetector {
  swing: Swing | null = null;
  readonly opts: ThrowDetectorOptions;
  constructor(opts: ThrowDetectorOptions) {
    this.opts = opts;
  }

  /**
   * 手のひらの新しいサンプル（board 座標系）を与える。離したと判定したらその情報を返す
   * @param allowed 投げが受け付けられる状態か（自分の手番の aim 中）。false の間は振りを
   *   開始せず、進行中の振りも捨てる（手番外や飛行中に始めた動作が、手番に切り替わった直後の
   *   1 投として受理されないように。レビュー指摘）
   */
  sample(now: number, pos: V3, vel: V3, allowed: boolean): Release | null {
    if (!allowed) {
      this.swing = null;
      return null;
    }
    const speed = Math.hypot(vel[0], vel[1], vel[2]);
    const s = this.swing;
    if (!s) {
      if (speed >= this.opts.minSpeed && vel[2] < 0) {
        this.swing = { startMs: now, peakSpeed: speed, peakVel: [...vel], lastPos: [...pos] };
      }
      return null;
    }
    s.lastPos = [...pos];
    if (speed > s.peakSpeed) {
      s.peakSpeed = speed;
      s.peakVel = [...vel];
      if (now - s.startMs > this.opts.maxSwingMs) return this.release("timeout");
      return null;
    }
    if (speed < s.peakSpeed * this.opts.releaseRatio) return this.release("slowed");
    if (vel[2] >= 0) return this.release("backward");
    if (now - s.startMs > this.opts.maxSwingMs) return this.release("timeout");
    return null;
  }

  /** 手を見失った。振りの途中なら最後のサンプルで離した扱い */
  lost(): Release | null {
    return this.swing ? this.release("lost") : null;
  }

  /** 手番や phase が変わったときに進行中の振りを捨てる */
  reset() {
    this.swing = null;
  }

  private release(why: Release["why"]): Release {
    const s = this.swing!;
    this.swing = null;
    return { pos: s.lastPos, vel: s.peakVel, peakSpeed: s.peakSpeed, why };
  }
}
