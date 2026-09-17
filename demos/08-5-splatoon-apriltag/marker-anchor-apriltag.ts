// 検出器を差し替えられるアンカー（マーカー座標系 → ワールド）。src/shared/marker-anchor.ts の createMarkerAnchor は
// 中で js-aruco2 の検出器を作る（差し替え口が無い）ので、同じ MarkerAnchor interface を満たす実装をここに写し、
// 検出器（apriltag-detector.ts の AprilTag、または比較用に js-aruco2）を外から渡す形にした。
// 08 のループ（update / info / usedIds / spreadM / tiltDeg / correctionM / isTracking）はそのまま使える。
// 観測 → アンカーの数学（重力での水平化・複数マーカーの重み付き平均・スナップ / lerp）は 08 と同じ
// （marker-layout.ts の fusePoseCandidates / levelRotation / tiltDegOf を import。既存ファイルは変更しない）。
// 違いは検出器だけ、が比較の前提なのでここは 08 の写しに留める（差分は info の先頭に検出器名を出すことと、詳細な時間の内訳だけ）
// もう 1 つの差分: 検出器の例外をここで止める。WASM の実行時例外（WebAssembly.RuntimeError / RangeError）が update() から
// three.js の描画コールバックまで伝播すると次のフレームが予約されず、画面・HUD・通信が全部止まる。例外が出たフレームは
// ロスト扱いにし（info に error を出す = HUD の april= の行）、ログは間引く。同じ失敗が maxConsecutiveFailures 回続いたら
// fallbackDetector（js-aruco2）に切り替える
import * as THREE from "three";
import type { MarkerDetector, MarkerObservation } from "../../src/shared/marker-detector";
import type { MarkerAnchor, MarkerAnchorOptions } from "../../src/shared/marker-anchor";
import { fusePoseCandidates, levelRotation, tiltDegOf } from "../../src/shared/marker-layout";
import type { PoseCandidate } from "../../src/shared/marker-layout";

export type DetectorAnchorOptions = Omit<MarkerAnchorOptions, "markerSizeM"> & {
  /** 検出器（AprilTag か js-aruco2）。detect(image, focalPx) の形は 08 の MarkerDetector と同じ */
  detector: MarkerDetector;
  /** detect() が連続でこの回数だけ例外を投げたら fallbackDetector に切り替える（既定 30） */
  maxConsecutiveFailures?: number;
  /** 切り替え先の検出器を作る（js-aruco2）。無ければ切り替えずに毎フレームロスト扱いを続ける */
  fallbackDetector?: () => MarkerDetector;
  /** fallbackDetector に切り替えた直後に呼ばれる（main.ts が HUD の detector= / apriltag= を更新する） */
  onFallback?: (lastError: string, failures: number) => void;
};

export type DetectorAnchor = MarkerAnchor & {
  /** 直近の検出で受け取った観測の数（姿勢の検証で捨てる前） */
  readonly lastObservedCount: number;
  /** 直近の検出の例外（成功したら空に戻る） */
  readonly lastDetectError: string;
  /** detect() が連続で例外を投げた回数（成功したら 0） */
  readonly consecutiveFailures: number;
  /** fallbackDetector に切り替え済みか */
  readonly fellBack: boolean;
};

/** 例外ログの間引き [ms] */
const ERROR_LOG_INTERVAL_MS = 2000;

export function createDetectorAnchor(opts: DetectorAnchorOptions): DetectorAnchor {
  const { video, camera, anchor } = opts;
  let detector = opts.detector;
  const maxFailures = opts.maxConsecutiveFailures ?? 30;
  let lastErrorLogMs = -Infinity;
  const detCanvas = document.createElement("canvas");
  const detCtx = detCanvas.getContext("2d", { willReadFrequently: true })!;

  let lastDetVideoTime = -1;
  let lastDetMs = -Infinity;
  let lastRejectLogMs = -Infinity;
  const targetPos = new THREE.Vector3();
  const targetQuat = new THREE.Quaternion();
  const targetScale = new THREE.Vector3();
  const markerWorld = new THREE.Matrix4();
  const levelWorld = new THREE.Matrix4();
  const markerCenter = new THREE.Vector3();
  const anchorOffset = new THREE.Vector3();
  const identity = new THREE.Matrix4();
  const inverseCache = new WeakMap<THREE.Matrix4, THREE.Matrix4>();
  function inverseOf(m: THREE.Matrix4): THREE.Matrix4 {
    let inv = inverseCache.get(m);
    if (!inv) {
      inv = m.clone().invert();
      inverseCache.set(m, inv);
    }
    return inv;
  }

  const self = {
    info: "searching",
    lastAcceptedMs: -Infinity,
    detMs: 0,
    everDetected: false,
    usedIds: [] as number[],
    spreadM: 0,
    tiltDeg: 0,
    correctionM: 0,
    lastObservedCount: 0,
    lastDetectError: "",
    consecutiveFailures: 0,
    fellBack: false,
    isTracking(now: number, lostMs: number) {
      return now - self.lastAcceptedMs <= lostMs;
    },
    update(now: number) {
      if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
      if (video.currentTime === lastDetVideoTime) return;
      if (now - lastDetMs < opts.minIntervalMs) return;
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh) return;
      lastDetVideoTime = video.currentTime;
      lastDetMs = now;
      // 長辺が detW になるよう縮小する（08 と同じ）
      const scale = Math.min(1, opts.detW / Math.max(vw, vh));
      const w = Math.round(vw * scale);
      const h = Math.round(vh * scale);
      if (detCanvas.width !== w || detCanvas.height !== h) {
        detCanvas.width = w;
        detCanvas.height = h;
      }
      const t0 = performance.now();
      detCtx.drawImage(video, 0, 0, w, h);
      const image = detCtx.getImageData(0, 0, w, h);
      // 焦点距離 [px] は長辺から換算（08 と同じ。iOS はデバイス回転で縦横が入れ替わる）
      const focalPx = Math.max(w, h) / 2 / Math.tan(THREE.MathUtils.degToRad(opts.camHFovDeg()) / 2);
      let observations: MarkerObservation[];
      try {
        observations = detector.detect(image, focalPx);
      } catch (e: unknown) {
        self.detMs = performance.now() - t0;
        onDetectError(e, now);
        return;
      }
      self.detMs = performance.now() - t0;
      self.lastObservedCount = observations.length;
      self.consecutiveFailures = 0;
      if (self.lastDetectError) {
        self.lastDetectError = "";
        // 例外の表示を消す（検出済みなら apply が info を書き直す）
        if (!self.everDetected) self.info = "searching";
      }
      apply(observations, now);
    },
  };

  /** 検出器が例外を投げたフレーム: ロスト扱い（観測 0 と同じ）にして、info に error を足す。連続したら fallbackDetector へ */
  function onDetectError(e: unknown, now: number) {
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    self.consecutiveFailures++;
    self.lastDetectError = msg;
    self.lastObservedCount = 0;
    if (now - lastErrorLogMs > ERROR_LOG_INTERVAL_MS) {
      console.warn(`[marker] detect threw (${self.consecutiveFailures} in a row): ${msg}`);
      lastErrorLogMs = now;
    }
    apply([], now);
    // 未検出のときは apply が info を書き直さないので、前回の error 表示に重ねないよう基準を戻す
    const base = self.everDetected ? self.info : "searching";
    const failures = self.consecutiveFailures;
    if (failures >= maxFailures && opts.fallbackDetector && !self.fellBack) {
      try {
        detector = opts.fallbackDetector();
      } catch (e2: unknown) {
        console.warn(`[marker] fallback detector could not be created: ${e2 instanceof Error ? e2.message : String(e2)}`);
        return;
      }
      self.fellBack = true;
      self.consecutiveFailures = 0;
      console.warn(`[marker] detect threw ${failures} times in a row; switched to fallback detector: ${msg}`);
      self.info = `${base} error(${failures}x → fallback)=${msg}`;
      opts.onFallback?.(msg, failures);
      return;
    }
    self.info = `${base} error(${failures}x)=${msg}`;
  }

  function toAnchorOf(id: number): THREE.Matrix4 | null {
    if (id === opts.markerId) return identity;
    const extra = opts.extraMarkers?.().find((m) => m.id === id);
    return extra ? extra.toAnchor : null;
  }

  function apply(observations: MarkerObservation[], now: number) {
    const candidates: PoseCandidate[] = [];
    const used: { id: number; error: number }[] = [];
    const up = opts.worldUp?.() ?? null;
    const upArr: [number, number, number] | null = up ? [up.x, up.y, up.z] : null;
    let maxTilt = 0;
    camera.updateMatrixWorld();
    for (const o of observations) {
      if (!Number.isFinite(o.error) || o.error > opts.maxPoseError) continue;
      if (used.some((u) => u.id === o.id)) continue;
      const toAnchor = toAnchorOf(o.id);
      if (!toAnchor) continue;
      markerWorld.multiplyMatrices(camera.matrixWorld, o.matrix);
      if (toAnchor !== identity) markerWorld.multiply(inverseOf(toAnchor));
      if (upArr) {
        maxTilt = Math.max(maxTilt, tiltDegOf(markerWorld.elements, upArr));
        levelWorld.fromArray(levelRotation(markerWorld.elements, upArr));
        markerCenter.setFromMatrixPosition(o.matrix).applyMatrix4(camera.matrixWorld);
        anchorOffset.setFromMatrixPosition(toAnchor).applyMatrix4(levelWorld);
        targetPos.copy(markerCenter).sub(anchorOffset);
        targetQuat.setFromRotationMatrix(levelWorld);
      } else {
        markerWorld.decompose(targetPos, targetQuat, targetScale);
      }
      candidates.push({
        pos: [targetPos.x, targetPos.y, targetPos.z],
        quat: [targetQuat.x, targetQuat.y, targetQuat.z, targetQuat.w],
        weight: o.sidePx * o.sidePx,
      });
      used.push({ id: o.id, error: o.error });
    }
    const fused = fusePoseCandidates(candidates);
    if (!fused) {
      if (observations.length > 0 && now - lastRejectLogMs > 2000) {
        console.log(`[marker] observed but rejected: ${observations.map((o) => `id=${o.id} err=${o.error.toFixed(2)}`).join(", ")}`);
        lastRejectLogMs = now;
      }
      if (self.everDetected) {
        self.info = `lost (${((now - self.lastAcceptedMs) / 1000).toFixed(1)}s)`;
      }
      return;
    }
    targetPos.set(fused.pos[0], fused.pos[1], fused.pos[2]);
    targetQuat.set(fused.quat[0], fused.quat[1], fused.quat[2], fused.quat[3]);
    self.correctionM = self.everDetected ? anchor.position.distanceTo(targetPos) : 0;
    const snap =
      !self.everDetected ||
      ((opts.canSnap?.() ?? true) && (now - self.lastAcceptedMs > opts.resnapAfterMs || anchor.position.distanceTo(targetPos) > opts.snapDistanceM));
    if (snap) {
      anchor.position.copy(targetPos);
      anchor.quaternion.copy(targetQuat);
    } else {
      anchor.position.lerp(targetPos, opts.smooth);
      anchor.quaternion.slerp(targetQuat, opts.smooth);
    }
    self.everDetected = true;
    self.lastAcceptedMs = now;
    self.usedIds = used.map((u) => u.id);
    self.spreadM = fused.spread;
    self.tiltDeg = maxTilt;
    self.info = `id=${used.map((u) => u.id).join("+")} err=${used.map((u) => u.error.toFixed(2)).join(",")}${used.length > 1 ? ` spread=${fused.spread.toFixed(2)}m` : ""}${upArr ? ` tilt=${maxTilt.toFixed(0)}deg` : ""} Δ=${self.correctionM.toFixed(2)}m ${self.detMs.toFixed(0)}ms`;
  }

  return self;
}
