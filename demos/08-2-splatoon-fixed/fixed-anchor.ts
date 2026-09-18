// 08-2「一度合わせて固定」の three.js 側の薄い層。
// src/shared/marker-anchor.ts（createMarkerAnchor）は触らず、その出力先を field のアンカーではなく
// 「観測用の Object3D（observed）」にして（smooth=1・常にスナップ = 生の観測がそのまま入る）、
// ここが公開値（lastAcceptedMs / usedIds / tiltDeg / info の err=）と observed の姿勢を読み取り、
// 本物のアンカー（field）に書くかどうかを決める。
//   - 使うのはマーカーを 1 枚だけ使った観測（usedIds.length === 1）だけ。marker-anchor.ts の tiltDeg / err は見えている全マーカーの最大で、
//     姿勢は全マーカーの重み付き融合なので、複数枚の観測では「質を測ったマーカー」と「採用する姿勢」が一致しない。
//     複数枚の観測は信頼しない扱いではなくスキップする（窓を進めない・捨てない）
//   - 確定前（aligning）: 直近 windowLen 回の観測のうち信頼できる観測（fixed-anchor-math.ts の untrustedReason が null）が N 回あり、
//     その N 回の位置とヨーのばらつきが小さいときだけ、その中央値 / 平均でアンカーを確定する（それまで field は非表示）。
//     確定は canLock が許すときだけ（練習中など。対戦中に正面に来ても確定しない）
//   - 確定後（locked）: 観測でアンカーを動かさない。ロスト・再検出・別マーカーへの切り替えでも動かさない。
//     信頼できる観測のときだけ refine（EMA 係数。0 で完全固定）で緩やかに寄せる。観測がアンカーから
//     refineMaxM / refineMaxDeg 以上離れていれば（POSIT の鏡像解など）寄せない。回転だけ離れた信頼できる観測が続けば
//     ジャイロのヨーのドリフトを疑う（yawDriftSuspected）
//   - 合わせ直し（realign）: locked のまま窓を集め直し、確定したらその時点で置き換える（集めている間もいまの位置で遊べる）
import * as THREE from "three";
import type { MarkerAnchor } from "../../src/shared/marker-anchor";
import { AlignWindow, markerQuality, maxErrOf, quatAngleDeg, refineStep, untrustedReason } from "./fixed-anchor-math";
import type { Pose, Quality, TrustLimits, UntrustedReason, V3 } from "./fixed-anchor-math";

/** 信頼できない理由（fixed-anchor-math.ts）に「複数枚を同時に使った観測（スキップ）」を足したもの */
export type ObservationReason = UntrustedReason | "multi";

/** 信頼できる観測なのに回転が refineMaxDeg を超えて補正を弾いた回数がこれだけ続いたら、ヨーのドリフトを疑う */
export const YAW_DRIFT_STREAK = 5;

export type FixedAnchorOptions = {
  camera: THREE.Camera;
  /** field のアンカー（ここだけが書く） */
  anchor: THREE.Object3D;
  /** createMarkerAnchor の出力先（生の観測。scene に入れなくて良い） */
  observed: THREE.Object3D;
  markerAnchor: () => MarkerAnchor | null;
  /** 観測に使ったマーカー ID → そのマーカー → アンカー座標系の変換（原点なら単位行列、配置が無ければ null） */
  toAnchorOf: (id: number) => THREE.Matrix4 | null;
  /** ワールド座標系での重力の上（gravityAlign が on のとき。壁のマーカーの正対を水平面で測る）。null なら 3D の角度 */
  worldUp?: () => THREE.Vector3 | null;
  /** 確定に必要な「信頼できる観測」の数 */
  samples: number;
  /** 直近何回の観測の中に samples 回の信頼できる観測があれば良いか（samples 未満なら samples = 連続） */
  windowLen: number;
  trust: TrustLimits;
  maxSpreadM: number;
  maxAngleDeg: number;
  /** 確定後の補正の EMA 係数（0 で完全固定） */
  refine: number;
  /** 観測がアンカーからこの距離 [m] 以上離れていれば補正しない */
  refineMaxM: number;
  /** 観測の回転がアンカーからこの角度 [deg] 以上ずれていれば補正しない（位置は近いが回転だけ誤った鏡像解を除く） */
  refineMaxDeg: number;
  /** 位置合わせ中、この時間 [ms] 観測が無ければ窓を捨てる */
  lostMs: number;
  /**
   * 確定を許すか。窓が揃った瞬間に呼ぶ（initial = 最初の確定か、合わせ直しか）。省略時は常に許す。
   * 最初の確定で false なら確定せずに窓を滑らせ続ける（許されたら次の観測で確定する）。
   * 合わせ直しで false なら集めた観測を捨てて合わせ直しを取り消す（長押しの計時中に対戦が始まった等）
   */
  canLock?: (initial: boolean) => boolean;
};

export type FixedAnchor = {
  /** 描画ループで markerAnchor.update(now) の後に毎フレーム呼ぶ */
  update(now: number): void;
  /** 合わせ直しを始める（確定前なら何もしない）。locked のまま窓を集め直す */
  realign(): boolean;
  /** 合わせ直しを取り消す（いまのアンカーのまま。合わせ直し中でなければ何もしない） */
  cancelRealign(): boolean;
  readonly locked: boolean;
  readonly realigning: boolean;
  /** 位置合わせの窓に溜まっている信頼できる観測の数 / 必要数 */
  readonly count: number;
  readonly samplesNeeded: number;
  /** 窓のばらつきが閾値内か */
  readonly stable: boolean;
  /** 窓は揃っているが canLock が許さず確定を待っているか */
  readonly lockBlocked: boolean;
  /** 直近の観測の質と、信頼できなかった理由（null = 信頼できた。"multi" = 複数枚の観測でスキップ） */
  readonly lastQuality: Quality | null;
  readonly lastReason: ObservationReason | null;
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
  /** 直近の確定に使った観測のマーカー ID（昇順） */
  readonly lockedIds: readonly number[];
  /** 確定後に補正を適用した回数 */
  readonly refined: number;
  /** 取り消した合わせ直しの回数（確定の瞬間の canLock と cancelRealign） */
  readonly cancelled: number;
  /** 信頼できる観測なのに回転が refineMaxDeg を超えて補正を弾いた連続回数 */
  readonly rotRejectStreak: number;
  /** rotRejectStreak が YAW_DRIFT_STREAK 以上（ジャイロのヨーのドリフトを疑う。確定・合わせ直しで解除） */
  readonly yawDriftSuspected: boolean;
  /** HUD 用の 1 行 */
  readonly info: string;
};

export function createFixedAnchor(opts: FixedAnchorOptions): FixedAnchor {
  const { camera, anchor, observed } = opts;
  const window = new AlignWindow({ samples: opts.samples, windowLen: opts.windowLen, maxSpreadM: opts.maxSpreadM, maxAngleDeg: opts.maxAngleDeg });
  const camInv = new THREE.Matrix4();
  const markerWorld = new THREE.Matrix4();
  const markerCam = new THREE.Matrix4();
  const lockedPos = new THREE.Vector3();
  const upCam = new THREE.Vector3();
  let seenAcceptedMs = -Infinity;
  let lastObsMs = -Infinity;
  /** 窓を集め始めてから使ったマーカー ID（確定したら lockedIds になる） */
  let windowIds = new Set<number>();

  function resetWindow() {
    window.reset();
    windowIds = new Set();
    self.count = 0;
    self.stable = true;
    self.lockBlocked = false;
  }

  const self = {
    locked: false,
    realigning: false,
    count: 0,
    samplesNeeded: opts.samples,
    stable: true,
    lockBlocked: false,
    lastQuality: null as Quality | null,
    lastReason: null as ObservationReason | null,
    obsDeltaM: 0,
    obsRotDeg: 0,
    driftM: 0,
    locks: 0,
    lockedAtMs: -Infinity,
    lockedIds: [] as number[],
    refined: 0,
    cancelled: 0,
    rotRejectStreak: 0,
    yawDriftSuspected: false,
    info: "aligning n=0",
    realign(): boolean {
      if (!self.locked) return false;
      self.realigning = true;
      resetWindow();
      return true;
    },
    cancelRealign(): boolean {
      if (!self.realigning) return false;
      self.realigning = false;
      resetWindow();
      self.cancelled++;
      console.log(`[fixed-anchor] realign cancelled (#${self.cancelled})`);
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
        // 位置合わせ中のロスト: 集め直す
        resetWindow();
      }
      self.driftM = self.locked ? lockedPos.distanceTo(anchor.position) : 0;
      self.info = describe(now);
    },
  };

  /** 観測の質（1 枚だけ使った観測のそのマーカー）。配置が無ければ null */
  function qualityOf(ma: MarkerAnchor, id: number): Quality | null {
    const toAnchor = opts.toAnchorOf(id);
    if (!toAnchor) return null;
    observed.updateMatrixWorld(true);
    camera.updateMatrixWorld();
    camInv.copy(camera.matrixWorld).invert();
    markerWorld.multiplyMatrices(observed.matrixWorld, toAnchor);
    markerCam.multiplyMatrices(camInv, markerWorld);
    const up = opts.worldUp?.() ?? null;
    const upArr: V3 | null = up ? (upCam.copy(up).transformDirection(camInv), [upCam.x, upCam.y, upCam.z]) : null;
    return markerQuality(markerCam.elements, ma.tiltDeg, maxErrOf(ma.info), upArr);
  }

  function onObservation(ma: MarkerAnchor, now: number) {
    if (ma.usedIds.length !== 1) {
      // 複数枚を同時に使った観測: tilt / err は全マーカーの最大、姿勢は融合なので評価も採用もしない（窓は捨てない）
      self.lastReason = "multi";
      self.lastQuality = null;
      return;
    }
    const id = ma.usedIds[0];
    const q = qualityOf(ma, id);
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
      if (reason === null) {
        window.push(sample);
        windowIds.add(id);
      } else {
        window.pushUntrusted();
      }
      self.count = window.count;
      self.stable = window.stable;
      self.lockBlocked = false;
      if (window.ready) {
        const initial = !self.locked;
        if (opts.canLock && !opts.canLock(initial)) {
          if (initial) {
            // 対戦中など: 確定せずに窓を滑らせ続ける（練習・結果に戻ったら次の観測で確定する）
            self.lockBlocked = true;
          } else {
            // 集めている間に対戦が始まった等: いまのアンカーを守り、合わせ直しを取り消す
            self.cancelRealign();
          }
          return;
        }
        const pose = window.result()!;
        setAnchor(pose);
        lockedPos.copy(anchor.position);
        self.locked = true;
        self.realigning = false;
        self.locks++;
        self.lockedAtMs = now;
        self.lockedIds = [...windowIds].sort((a, b) => a - b);
        self.rotRejectStreak = 0;
        self.yawDriftSuspected = false;
        resetWindow();
        console.log(`[fixed-anchor] locked #${self.locks} pos=(${pose.pos.map((v) => v.toFixed(3)).join(",")}) ids=${self.lockedIds.join("+")} after ${opts.samples} samples`);
      }
      return;
    }
    // 確定後: 信頼できる観測のときだけ緩やかに寄せる（位置・回転のどちらかが遠すぎる観測は鏡像解などの疑いがあるので無視）
    if (reason !== null) return;
    const current: Pose = {
      pos: [anchor.position.x, anchor.position.y, anchor.position.z],
      quat: [anchor.quaternion.x, anchor.quaternion.y, anchor.quaternion.z, anchor.quaternion.w],
    };
    // 回転だけが大きく外れる観測が続くのは、1 回きりの鏡像解よりジャイロのヨーのドリフトを疑う（refine=0 でも数える）
    if (quatAngleDeg(current.quat, sample.quat) > opts.refineMaxDeg) {
      self.rotRejectStreak++;
      if (self.rotRejectStreak >= YAW_DRIFT_STREAK && !self.yawDriftSuspected) {
        self.yawDriftSuspected = true;
        console.log(`[fixed-anchor] yaw drift suspected (${self.rotRejectStreak} trusted observations > ${opts.refineMaxDeg}deg)`);
      }
    } else {
      self.rotRejectStreak = 0;
    }
    const next = refineStep(current, sample, opts.refine, opts.refineMaxM, opts.refineMaxDeg);
    if (next) {
      setAnchor(next);
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
    const quality =
      self.lastReason === "multi"
        ? " trusted=no(multi)"
        : q
          ? ` dist=${q.distM.toFixed(2)}m off=${q.offAxisDeg.toFixed(0)}deg face=${q.facingDeg.toFixed(0)}deg elev=${q.elevationDeg.toFixed(0)}deg tilt=${q.tiltDeg.toFixed(0)}deg err=${q.err.toFixed(2)} trusted=${self.lastReason === null ? "yes" : `no(${self.lastReason})`}`
          : "";
    const progress = `n=${self.count}/${opts.samples}${self.stable ? "" : " unstable"}${self.lockBlocked ? " blocked" : ""}`;
    if (!self.locked) return `aligning ${progress}${quality}`;
    const head = self.realigning ? `realigning ${progress}` : `locked (${((now - self.lockedAtMs) / 1000).toFixed(1)}s)`;
    return `${head} locks=${self.locks} lockIds=${self.lockedIds.join("+") || "-"} refine=${opts.refine} refined=${self.refined}${self.cancelled ? ` cancelled=${self.cancelled}` : ""} rotRejects=${self.rotRejectStreak}${self.yawDriftSuspected ? " yawDrift" : ""} drift=${self.driftM.toFixed(3)}m obsΔ=${self.obsDeltaM.toFixed(2)}m/${self.obsRotDeg.toFixed(0)}deg${quality}`;
  }

  return self;
}

export type { Pose, Quality, TrustLimits, UntrustedReason, V3 };
