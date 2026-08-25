// マーカー検出 → アンカー（マーカー座標系 → ワールド）の更新。03/04 の
// detectAndUpdateAnchor / applyObservations を Phase 6 で抽出した。
// ロスト時に anchor をどうするか（04: 非表示 / 06: 最後の姿勢を維持）は呼び出し側の方針なので
// ここでは扱わず、isTracking() で判断材料だけ返す。
// 03/04 は過去のデモとして手を付けず、06 以降がこれを使う
import * as THREE from "three";
import { createMarkerDetector } from "./marker-detector";
import type { MarkerObservation } from "./marker-detector";

export type MarkerAnchorOptions = {
  video: HTMLVideoElement;
  camera: THREE.Camera;
  /** マーカー座標系 → ワールドの変換を持たせる Object3D（子にマーカー基準の物体を置く） */
  anchor: THREE.Object3D;
  markerSizeM: number;
  markerId: number;
  /** 正規化再投影誤差（marker-detector.ts 参照）の上限。超える観測は捨てる */
  maxPoseError: number;
  /** 検出画像の長辺 [px]。大きいほど遠くまで検出できるが重い（04: 960 で 2.5m / 20ms） */
  detW: number;
  /** 観測を anchor に馴染ませる指数移動平均係数（1 で平滑化なし） */
  smooth: number;
  /** 検出の最小間隔 [ms]（0 = カメラの新フレームごと）。手の推論と同居させるときの間引き用 */
  minIntervalMs: number;
  /** 実カメラの水平 FOV [deg]（長辺方向）。焦点距離の換算に使う */
  camHFovDeg: () => number;
  /**
   * 前回の採用からこの時間 [ms] 以上空いて再検出したときは lerp せずスナップする
   * （ロスト中に姿勢がずれていた場合、古い位置から滑ってくるのを防ぐ）
   */
  resnapAfterMs: number;
  /** 前回の採用位置からこの距離 [m] を超える観測もスナップする */
  snapDistanceM: number;
};

export type MarkerAnchor = {
  /** 描画ループから毎フレーム呼ぶ。新しい映像フレームがあり間引き条件を満たせば検出する */
  update(now: number): void;
  /** HUD 用（"id=0 err=0.03 18ms" / "lost (1.2s)" / "searching"） */
  readonly info: string;
  /** 直近に観測を採用した時刻 [ms]。一度も無ければ -Infinity */
  readonly lastAcceptedMs: number;
  /** 直近の検出処理時間 [ms] */
  readonly detMs: number;
  /** 一度でも検出できたか（= anchor の姿勢に意味があるか） */
  readonly everDetected: boolean;
  /** lostMs 以内に観測を採用していれば true */
  isTracking(now: number, lostMs: number): boolean;
};

export function createMarkerAnchor(opts: MarkerAnchorOptions): MarkerAnchor {
  const { video, camera, anchor } = opts;
  const detector = createMarkerDetector(opts.markerSizeM);
  const detCanvas = document.createElement("canvas");
  const detCtx = detCanvas.getContext("2d", { willReadFrequently: true })!;

  let lastDetVideoTime = -1;
  let lastDetMs = -Infinity;
  let lastRejectLogMs = -Infinity;
  const targetPos = new THREE.Vector3();
  const targetQuat = new THREE.Quaternion();
  const targetScale = new THREE.Vector3();
  const markerWorld = new THREE.Matrix4();

  const self = {
    info: "searching",
    lastAcceptedMs: -Infinity,
    detMs: 0,
    everDetected: false,
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
      // 長辺が detW になるよう縮小する（幅基準だと縦持ち時に検出画像が縦に伸びて
      // 検出コストが倍増する。横持ちでは幅基準と同じ結果になる）
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
      // 焦点距離 [px] は向きに依存しない値なので、水平 FOV が対応する長辺から換算する
      // （iOS はデバイス回転で映像の縦横が入れ替わるため w ではなく max を使う）
      const focalPx =
        Math.max(w, h) /
        2 /
        Math.tan(THREE.MathUtils.degToRad(opts.camHFovDeg()) / 2);
      const observations = detector.detect(image, focalPx);
      self.detMs = performance.now() - t0;
      apply(observations, now);
    },
  };

  function apply(observations: MarkerObservation[], now: number) {
    const obs = observations.find(
      (o) =>
        o.id === opts.markerId &&
        Number.isFinite(o.error) &&
        o.error <= opts.maxPoseError,
    );
    if (!obs) {
      if (observations.length > 0 && now - lastRejectLogMs > 2000) {
        console.log(
          `[marker] observed but rejected: ${observations.map((o) => `id=${o.id} err=${o.error.toFixed(2)}`).join(", ")}`,
        );
        lastRejectLogMs = now;
      }
      if (self.everDetected) {
        self.info = `lost (${((now - self.lastAcceptedMs) / 1000).toFixed(1)}s)`;
      }
      return;
    }
    // マーカーのカメラ座標系での姿勢 × カメラのワールド姿勢 = マーカー座標系 → ワールド
    camera.updateMatrixWorld();
    markerWorld.multiplyMatrices(camera.matrixWorld, obs.matrix);
    markerWorld.decompose(targetPos, targetQuat, targetScale);
    const snap =
      !self.everDetected ||
      now - self.lastAcceptedMs > opts.resnapAfterMs ||
      anchor.position.distanceTo(targetPos) > opts.snapDistanceM;
    if (snap) {
      anchor.position.copy(targetPos);
      anchor.quaternion.copy(targetQuat);
    } else {
      anchor.position.lerp(targetPos, opts.smooth);
      anchor.quaternion.slerp(targetQuat, opts.smooth);
    }
    self.everDetected = true;
    self.lastAcceptedMs = now;
    self.info = `id=${obs.id} err=${obs.error.toFixed(2)} ${self.detMs.toFixed(0)}ms`;
  }

  return self;
}
