// マーカー検出 → アンカー（マーカー座標系 → ワールド）の更新。03/04 の
// detectAndUpdateAnchor / applyObservations を Phase 6 で抽出した。
// ロスト時に anchor をどうするか（04: 非表示 / 06: 最後の姿勢を維持）は呼び出し側の方針なので
// ここでは扱わず、isTracking() で判断材料だけ返す。
// 03/04 は過去のデモとして手を付けず、06 以降がこれを使う。
//
// マルチマーカー（issue #30、08 で使用）: markerId の原点マーカーに加えて extraMarkers（原点座標系での姿勢が
// 分かっている追加マーカー）を渡すと、どれが見えてもアンカー（= 原点マーカーの姿勢）に直して採用する。
// アンカーは 1 つのままなので、呼び出し側（field = anchor）は枚数を意識しない。
// 同じフレームで複数見えたときは画面上の大きさで重み付き平均し、候補のばらつき（spread）を診断用に返す
import * as THREE from "three";
import { createMarkerDetector } from "./marker-detector";
import type { MarkerObservation } from "./marker-detector";
import { fusePoseCandidates } from "./marker-layout";
import type { PoseCandidate } from "./marker-layout";

export type ExtraMarker = {
  id: number;
  /** このマーカーの座標系 → アンカー（原点マーカー）座標系の変換。中身を書き換えず、配置が変わったら新しい Matrix4 に差し替えること（逆行列をキャッシュする） */
  toAnchor: THREE.Matrix4;
};

export type MarkerAnchorOptions = {
  video: HTMLVideoElement;
  camera: THREE.Camera;
  /** マーカー座標系 → ワールドの変換を持たせる Object3D（子にマーカー基準の物体を置く） */
  anchor: THREE.Object3D;
  markerSizeM: number;
  /** 原点マーカーの ID（anchor の座標系 = このマーカーの座標系） */
  markerId: number;
  /**
   * 追加マーカー（省略時は原点マーカーだけ）。毎回の検出で呼ぶので、配置が変わったら返す配列を差し替えれば良い。
   * 追加マーカーの実寸は原点と同じ markerSizeM
   */
  extraMarkers?: () => readonly ExtraMarker[];
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
  /**
   * 初検出以外のスナップを許すか（省略時は常に許す）。06 はラリー中に false にして、
   * 目の前のボールごとコートが飛ぶのを避ける（当たり判定が壊れる）
   */
  canSnap?: () => boolean;
};

export type MarkerAnchor = {
  /** 描画ループから毎フレーム呼ぶ。新しい映像フレームがあり間引き条件を満たせば検出する */
  update(now: number): void;
  /** HUD 用（"id=0+1 err=0.03,0.05 spread=0.02m 18ms" / "lost (1.2s)" / "searching"） */
  readonly info: string;
  /** 直近に観測を採用した時刻 [ms]。一度も無ければ -Infinity */
  readonly lastAcceptedMs: number;
  /** 直近の検出処理時間 [ms] */
  readonly detMs: number;
  /** 一度でも検出できたか（= anchor の姿勢に意味があるか） */
  readonly everDetected: boolean;
  /** 直近の検出で採用したマーカーの ID（ロスト中は直近に採用したもののまま。isTracking と併用する） */
  readonly usedIds: readonly number[];
  /** 直近の採用で複数マーカーが見えたときの、原点の位置の候補のばらつき [m]（1 枚なら 0）。貼りズレの診断用 */
  readonly spreadM: number;
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
  const identity = new THREE.Matrix4();
  /** toAnchor の逆行列（アンカー → マーカー）。検出のたびに invert しないようキャッシュ */
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

  /** 観測した ID が原点か追加マーカーなら、そのマーカー → アンカー座標系の変換を返す */
  function toAnchorOf(id: number): THREE.Matrix4 | null {
    if (id === opts.markerId) return identity;
    const extra = opts.extraMarkers?.().find((m) => m.id === id);
    return extra ? extra.toAnchor : null;
  }

  function apply(observations: MarkerObservation[], now: number) {
    // 姿勢が信用できる観測のうち、配置が分かっているマーカーだけを候補にする（同じ ID が複数見えたら最初の 1 つ）
    const candidates: PoseCandidate[] = [];
    const used: { id: number; error: number }[] = [];
    camera.updateMatrixWorld();
    for (const o of observations) {
      if (!Number.isFinite(o.error) || o.error > opts.maxPoseError) continue;
      if (used.some((u) => u.id === o.id)) continue;
      const toAnchor = toAnchorOf(o.id);
      if (!toAnchor) continue;
      // マーカーのカメラ座標系での姿勢 × カメラのワールド姿勢 = マーカー座標系 → ワールド。
      // 追加マーカーなら、さらに（マーカー → アンカー）の逆を掛けてアンカー座標系 → ワールドに直す
      markerWorld.multiplyMatrices(camera.matrixWorld, o.matrix);
      if (toAnchor !== identity) markerWorld.multiply(inverseOf(toAnchor));
      markerWorld.decompose(targetPos, targetQuat, targetScale);
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
    targetPos.set(fused.pos[0], fused.pos[1], fused.pos[2]);
    targetQuat.set(fused.quat[0], fused.quat[1], fused.quat[2], fused.quat[3]);
    const snap =
      !self.everDetected ||
      ((opts.canSnap?.() ?? true) &&
        (now - self.lastAcceptedMs > opts.resnapAfterMs ||
          anchor.position.distanceTo(targetPos) > opts.snapDistanceM));
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
    self.info = `id=${used.map((u) => u.id).join("+")} err=${used.map((u) => u.error.toFixed(2)).join(",")}${used.length > 1 ? ` spread=${fused.spread.toFixed(2)}m` : ""} ${self.detMs.toFixed(0)}ms`;
  }

  return self;
}
