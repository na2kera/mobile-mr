// 08-2「一度合わせて固定」の three.js 側の薄い層。
// src/shared/marker-anchor.ts（createMarkerAnchor）は触らず、その出力先を field のアンカーではなく
// 「観測用の Object3D（observed）」にして（smooth=1・常にスナップ = 生の観測がそのまま入る）、
// ここが公開値（lastAcceptedMs / usedIds / tiltDeg / info の err=）と observed の姿勢を読み取り、
// 本物のアンカー（field）に書くかどうかを決める。
//   - 確定前（aligning）: 信頼できる観測（fixed-anchor-math.ts の untrustedReason が null）が N 回連続し、
//     位置とヨーのばらつきが小さいときだけ、その中央値 / 平均でアンカーを確定する（それまで field は非表示）
//   - 確定後（locked）: 観測でアンカーを動かさない。ロスト・再検出・別マーカーへの切り替えでも動かさない。
//     信頼できる観測のときだけ refine（EMA 係数。0 で完全固定）で緩やかに寄せる。観測がアンカーから
//     refineMaxM 以上離れていれば（POSIT の鏡像解など）寄せない
//   - 合わせ直し（realign）: locked のまま窓を集め直し、確定したらその時点で置き換える（集めている間もいまの位置で遊べる）
import * as THREE from "three";
import type { MarkerAnchor } from "../../src/shared/marker-anchor";
import { AlignWindow, markerQuality, untrustedReason } from "./fixed-anchor-math";
import type { Pose, Quality, TrustLimits, UntrustedReason, V3 } from "./fixed-anchor-math";

export type FixedAnchorOptions = {
  camera: THREE.Camera;
  /** field のアンカー（ここだけが書く） */
  anchor: THREE.Object3D;
  /** createMarkerAnchor の出力先（生の観測。scene に入れなくて良い） */
  observed: THREE.Object3D;
  markerAnchor: () => MarkerAnchor | null;
  /** 観測に使ったマーカー ID → そのマーカー → アンカー座標系の変換（原点なら単位行列、配置が無ければ null） */
  toAnchorOf: (id: number) => THREE.Matrix4 | null;
  /** 確定に必要な連続観測の数 */
  samples: number;
  trust: TrustLimits;
  maxSpreadM: number;
  maxAngleDeg: number;
  /** 確定後の補正の EMA 係数（0 で完全固定） */
  refine: number;
  /** 観測がアンカーからこの距離 [m] 以上離れていれば補正しない */
  refineMaxM: number;
  /** 位置合わせ中、この時間 [ms] 観測が無ければ窓を捨てる */
  lostMs: number;
};

export type FixedAnchor = {
  /** 描画ループで markerAnchor.update(now) の後に毎フレーム呼ぶ */
  update(now: number): void;
  /** 合わせ直しを始める（確定前なら何もしない）。locked のまま窓を集め直す */
  realign(): boolean;
  readonly locked: boolean;
  readonly realigning: boolean;
  /** 位置合わせの窓に溜まっている観測の数 / 必要数 */
  readonly count: number;
  readonly samplesNeeded: number;
  /** 窓のばらつきが閾値内か */
  readonly stable: boolean;
  /** 直近の観測の質と、信頼できなかった理由（null = 信頼できた） */
  readonly lastQuality: Quality | null;
  readonly lastReason: UntrustedReason | null;
  /** 直近の観測がアンカーからどれだけ離れていたか [m]（08 ならこのぶん動いていた。確定前は 0） */
  readonly obsDeltaM: number;
  /** 直近の観測の回転がアンカーからどれだけずれていたか [deg]（斜めから見たときはヨーがこのぶん違う。確定前は 0） */
  readonly obsRotDeg: number;
  /** 確定時の位置からの累積の補正量 [m] */
  readonly driftM: number;
  /** 確定した回数（合わせ直しを含む） */
  readonly locks: number;
  /** 直近に確定した時刻 [ms]。無ければ -Infinity */
  readonly lockedAtMs: number;
  /** 確定後に補正を適用した回数 */
  readonly refined: number;
  /** HUD 用の 1 行 */
  readonly info: string;
};

export function createFixedAnchor(opts: FixedAnchorOptions): FixedAnchor {
  const { camera, anchor, observed } = opts;
  const window = new AlignWindow({ samples: opts.samples, maxSpreadM: opts.maxSpreadM, maxAngleDeg: opts.maxAngleDeg });
  const camInv = new THREE.Matrix4();
  const markerWorld = new THREE.Matrix4();
  const markerCam = new THREE.Matrix4();
  const lockedPos = new THREE.Vector3();
  const targetPos = new THREE.Vector3();
  const targetQuat = new THREE.Quaternion();
  let seenAcceptedMs = -Infinity;
  let lastObsMs = -Infinity;

  const self = {
    locked: false,
    realigning: false,
    count: 0,
    samplesNeeded: opts.samples,
    stable: true,
    lastQuality: null as Quality | null,
    lastReason: null as UntrustedReason | null,
    obsDeltaM: 0,
    obsRotDeg: 0,
    driftM: 0,
    locks: 0,
    lockedAtMs: -Infinity,
    refined: 0,
    info: "aligning n=0",
    realign(): boolean {
      if (!self.locked) return false;
      self.realigning = true;
      window.reset();
      self.count = 0;
      return true;
    },
    update(now: number) {
      const ma = opts.markerAnchor();
      if (!ma) return;
      if (ma.lastAcceptedMs !== seenAcceptedMs && ma.everDetected) {
        seenAcceptedMs = ma.lastAcceptedMs;
        lastObsMs = now;
        onObservation(ma, now);
      } else if ((!self.locked || self.realigning) && window.count > 0 && now - lastObsMs > opts.lostMs) {
        // 位置合わせ中のロスト: 連続が途切れたので集め直す
        window.reset();
        self.count = 0;
      }
      self.driftM = self.locked ? lockedPos.distanceTo(anchor.position) : 0;
      self.info = describe(now);
    },
  };

  /** 観測の質: 使ったマーカーのうち、条件（距離・中央・正対）の合計が最も良い 1 枚で評価する */
  function qualityOf(ma: MarkerAnchor): Quality | null {
    observed.updateMatrixWorld(true);
    camera.updateMatrixWorld();
    camInv.copy(camera.matrixWorld).invert();
    const err = maxErrOf(ma.info);
    let best: Quality | null = null;
    let bestScore = Infinity;
    for (const id of ma.usedIds) {
      const toAnchor = opts.toAnchorOf(id);
      if (!toAnchor) continue;
      markerWorld.multiplyMatrices(observed.matrixWorld, toAnchor);
      markerCam.multiplyMatrices(camInv, markerWorld);
      const q = markerQuality(markerCam.elements, ma.tiltDeg, err);
      const score = q.distM / opts.trust.maxDistM + q.offAxisDeg / opts.trust.maxOffAxisDeg + q.facingDeg / opts.trust.maxFacingDeg;
      if (score < bestScore) {
        bestScore = score;
        best = q;
      }
    }
    return best;
  }

  function onObservation(ma: MarkerAnchor, now: number) {
    const q = qualityOf(ma);
    self.lastQuality = q;
    const reason = q ? untrustedReason(q, opts.trust) : "err";
    self.lastReason = reason;
    self.obsDeltaM = self.locked ? anchor.position.distanceTo(observed.position) : 0;
    self.obsRotDeg = self.locked ? THREE.MathUtils.radToDeg(anchor.quaternion.angleTo(observed.quaternion)) : 0;
    const sample: Pose = {
      pos: [observed.position.x, observed.position.y, observed.position.z],
      quat: [observed.quaternion.x, observed.quaternion.y, observed.quaternion.z, observed.quaternion.w],
    };
    if (!self.locked || self.realigning) {
      if (reason === null) window.push(sample);
      else window.reset();
      self.count = window.count;
      self.stable = window.stable;
      if (window.ready) {
        const pose = window.result()!;
        setAnchor(pose);
        lockedPos.copy(anchor.position);
        self.locked = true;
        self.realigning = false;
        self.locks++;
        self.lockedAtMs = now;
        window.reset();
        self.count = 0;
        console.log(`[fixed-anchor] locked #${self.locks} pos=(${pose.pos.map((v) => v.toFixed(3)).join(",")}) after ${opts.samples} samples`);
      }
      return;
    }
    // 確定後: 信頼できる観測のときだけ緩やかに寄せる（遠すぎる観測は鏡像解などの疑いがあるので無視）
    if (reason === null && opts.refine > 0 && self.obsDeltaM <= opts.refineMaxM) {
      targetPos.set(sample.pos[0], sample.pos[1], sample.pos[2]);
      targetQuat.set(sample.quat[0], sample.quat[1], sample.quat[2], sample.quat[3]);
      anchor.position.lerp(targetPos, opts.refine);
      anchor.quaternion.slerp(targetQuat, opts.refine);
      self.refined++;
    }
  }

  function setAnchor(pose: Pose) {
    anchor.position.set(pose.pos[0], pose.pos[1], pose.pos[2]);
    anchor.quaternion.set(pose.quat[0], pose.quat[1], pose.quat[2], pose.quat[3]);
    anchor.updateMatrixWorld(true);
  }

  function describe(now: number): string {
    const q = self.lastQuality;
    const quality = q
      ? ` dist=${q.distM.toFixed(2)}m off=${q.offAxisDeg.toFixed(0)}deg face=${q.facingDeg.toFixed(0)}deg tilt=${q.tiltDeg.toFixed(0)}deg err=${q.err.toFixed(2)} trusted=${self.lastReason === null ? "yes" : `no(${self.lastReason})`}`
      : "";
    if (!self.locked) return `aligning n=${self.count}/${opts.samples}${self.stable ? "" : " unstable"}${quality}`;
    const head = self.realigning ? `realigning n=${self.count}/${opts.samples}${self.stable ? "" : " unstable"}` : `locked (${((now - self.lockedAtMs) / 1000).toFixed(1)}s)`;
    return `${head} locks=${self.locks} refine=${opts.refine} refined=${self.refined} drift=${self.driftM.toFixed(3)}m obsΔ=${self.obsDeltaM.toFixed(2)}m/${self.obsRotDeg.toFixed(0)}deg${quality}`;
  }

  return self;
}

/** marker-anchor.ts の info（"id=0+5 err=0.03,0.05 ..."）から再投影誤差の最大を読む。無ければ Infinity（信頼しない） */
export function maxErrOf(info: string): number {
  const m = info.match(/err=([\d.,]+)/);
  if (!m) return Infinity;
  const values = m[1].split(",").map(Number).filter(Number.isFinite);
  return values.length === 0 ? Infinity : Math.max(...values);
}

export type { Pose, Quality, TrustLimits, UntrustedReason, V3 };
