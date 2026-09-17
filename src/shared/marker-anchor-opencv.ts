// 08-4: OpenCV.js（ArUco board + solvePnP）でアンカー（マーカー座標系 = field → ワールド）を更新する。
// marker-anchor.ts（js-aruco2 の検出 + POSIT で 1 枚ずつ推定 → 重み付き平均）と同じ MarkerAnchor interface を満たすので、
// 08 のループ（update / info / usedIds / spreadM / tiltDeg / correctionM / isTracking）はそのまま使える。
// 違いは「姿勢の出し方」だけ:
//   - 検出: OpenCV の ArucoDetector（辞書 DICT_ARUCO_MIP_36h12 = js-aruco2 と同じ ID。コーナーはサブピクセル精錬）
//   - 姿勢: 見えている全マーカー（原点 + 配置が分かっている追加マーカー）の 4 隅を 1 つの board にして solvePnP で 1 つの姿勢
//     （pnp-board.ts / opencv-pose.ts）。1 枚ずつ出して平均する代わりに全点を同時に最適化するので、斜め・遠い観測で
//     1 枚の平面 4 点の不良条件（issue #54 / #55）が「複数枚の合成」に変わる
//   - 重力での水平化（worldUp）は 08 と同じ考え方で残す（PnP の傾きも信用しない場合の保険。?gravityAlign=0 で切れる）。
//     位置は「見えているマーカーの中心の平均 − R_level・(その平均のアンカー座標)」（08 の「マーカー中心 − R・pos」の複数枚版）
//   - 1 枚ずつの姿勢（SOLVEPNP_IPPE_SQUARE）も診断用に出し、08 と同じ定義の spread（候補の位置の最大距離）を返す
// OpenCV.js の読み込み（opencv-loader.ts）は非同期で、失敗したら marker-anchor.ts（js-aruco2）にフォールバックする。
// src/shared/marker-anchor.ts は変更しない（08 のもの）
import * as THREE from "three";
import { createMarkerAnchor } from "./marker-anchor";
import type { MarkerAnchor, MarkerAnchorOptions } from "./marker-anchor";
import { fusePoseCandidates, levelRotation, tiltDegOf } from "./marker-layout";
import type { PoseCandidate } from "./marker-layout";
import { loadOpenCv } from "./opencv-loader";
import type { CvMat, OpenCv } from "./opencv-loader";
import { createArucoDetector, detectMarkers, guessFromCameraMatrix, solveBoardPnP, solveSingleMarker } from "./opencv-pose";
import type { ArucoDetectorLike, PnpGuess, PnpMethod } from "./opencv-pose";
import { buildBoard, cameraMatrix, focalPxOf, meanV3 } from "./pnp-board";

export type PoseSource = "board" | "single";

export type OpenCvMarkerAnchorOptions = MarkerAnchorOptions & {
  /** OpenCV.js の URL（opencv-loader.ts の defaultOpenCvUrl） */
  opencvUrl: string;
  /** "opencv"（既定）か "aruco2"（読み込まずに 08 と同じ js-aruco2 経路） */
  detector: "opencv" | "aruco2";
  /** solvePnP の方法（?pnp=） */
  pnpMethod: PnpMethod;
  /** "board"（既定。全マーカーを 1 つの board で解く）か "single"（1 枚ずつ IPPE_SQUARE → 08 と同じ重み付き平均。数学だけ替えた比較用） */
  poseSource: PoseSource;
  /** 再投影誤差の上限 [px]（board の平均。超えたら捨てる。maxPoseError は正規化誤差（px / 辺長）で、両方で足切りする） */
  maxReprojPx: number;
};

export type OpenCvMarkerAnchor = MarkerAnchor & {
  /** いま使っている経路（HUD の pose= の先頭）。loading → opencv、失敗なら aruco2 */
  readonly backend: "loading" | "opencv" | "aruco2";
  /** 読み込みの進捗や失敗理由（HUD 用） */
  readonly loadStatus: string;
  /** 直近の board の再投影誤差 [px]（opencv のとき） */
  readonly reprojPx: number;
  /** 直近に solvePnP で使った方法（"ippe+lm" / "iter" / "iter(guess)"） */
  readonly pnpUsed: string;
};

export function createOpenCvMarkerAnchor(opts: OpenCvMarkerAnchorOptions): OpenCvMarkerAnchor {
  const { video, camera, anchor } = opts;
  /** フォールバック先（js-aruco2）。読み込みに失敗したとき、または detector=aruco2 のときだけ作る */
  let fallback: MarkerAnchor | null = null;
  let cv: OpenCv | null = null;
  let detector: ArucoDetectorLike | null = null;

  const detCanvas = document.createElement("canvas");
  const detCtx = detCanvas.getContext("2d", { willReadFrequently: true })!;
  let lastDetVideoTime = -1;
  let lastDetMs = -Infinity;
  let lastRejectLogMs = -Infinity;
  /** 前フレームの board の姿勢（object → three.js カメラ。ITERATIVE の初期値） */
  let lastGuess: PnpGuess | null = null;

  const targetPos = new THREE.Vector3();
  const targetQuat = new THREE.Quaternion();
  const targetScale = new THREE.Vector3();
  const anchorWorld = new THREE.Matrix4();
  const objToCam = new THREE.Matrix4();
  const levelWorld = new THREE.Matrix4();
  const centroidWorld = new THREE.Vector3();
  const centroidOffset = new THREE.Vector3();
  const markerWorld = new THREE.Matrix4();
  const predicted = new THREE.Matrix4();
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
  /** 観測した ID が原点か追加マーカーなら、そのマーカー → アンカー座標系の変換を返す */
  function toAnchorOf(id: number): THREE.Matrix4 | null {
    if (id === opts.markerId) return identity;
    const extra = opts.extraMarkers?.().find((m) => m.id === id);
    return extra ? extra.toAnchor : null;
  }

  const self = {
    backend: "loading" as OpenCvMarkerAnchor["backend"],
    loadStatus: "",
    reprojPx: 0,
    pnpUsed: "",
    info: "searching",
    lastAcceptedMs: -Infinity,
    detMs: 0,
    everDetected: false,
    usedIds: [] as number[],
    spreadM: 0,
    tiltDeg: 0,
    correctionM: 0,
    isTracking(now: number, lostMs: number) {
      if (fallback) return fallback.isTracking(now, lostMs);
      return now - self.lastAcceptedMs <= lostMs;
    },
    update(now: number) {
      if (fallback) {
        fallback.update(now);
        // フォールバック中は js-aruco2 側の値をそのまま見せる
        self.info = fallback.info;
        self.lastAcceptedMs = fallback.lastAcceptedMs;
        self.detMs = fallback.detMs;
        self.everDetected = fallback.everDetected;
        self.usedIds = fallback.usedIds as number[];
        self.spreadM = fallback.spreadM;
        self.tiltDeg = fallback.tiltDeg;
        self.correctionM = fallback.correctionM;
        return;
      }
      if (!cv || !detector) return;
      if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
      if (video.currentTime === lastDetVideoTime) return;
      if (now - lastDetMs < opts.minIntervalMs) return;
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh) return;
      lastDetVideoTime = video.currentTime;
      lastDetMs = now;
      // 長辺が detW になるよう縮小（marker-anchor.ts と同じ）
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
      const focalPx = focalPxOf(w, h, opts.camHFovDeg());
      const K = cameraMatrix(focalPx, w, h);
      let rgba: CvMat | null = null;
      let gray: CvMat | null = null;
      try {
        rgba = cv.matFromImageData(image);
        gray = new cv.Mat();
        cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
        const detections = detectMarkers(cv, detector, gray);
        self.detMs = performance.now() - t0;
        apply(detections, K, now);
      } catch (e: unknown) {
        // WASM 側の例外（メモリ不足など）で毎フレーム落ちないよう、ログだけ出して次のフレームへ
        if (now - lastRejectLogMs > 2000) {
          console.warn("[opencv] 検出でエラー:", e);
          lastRejectLogMs = now;
        }
        self.detMs = performance.now() - t0;
      } finally {
        rgba?.delete();
        gray?.delete();
      }
    },
  };

  function apply(detections: ReturnType<typeof detectMarkers>, K: number[], now: number) {
    const up = opts.worldUp?.() ?? null;
    const upArr: [number, number, number] | null = up ? [up.x, up.y, up.z] : null;
    camera.updateMatrixWorld();
    const board = buildBoard(
      detections,
      (id) => toAnchorOf(id)?.elements ?? null,
      opts.markerSizeM,
    );
    if (!board) {
      if (detections.length > 0 && now - lastRejectLogMs > 2000) {
        console.log(`[opencv] observed but no layout: ${detections.map((d) => `id=${d.id}`).join(", ")}`);
        lastRejectLogMs = now;
      }
      lost(now);
      return;
    }
    // ---- board（全マーカー同時）の姿勢。再投影誤差で捨てられたら null（配置の入力ミス・誤検出）----
    let maxTilt = 0;
    let boardResult: ReturnType<typeof solveBoardPnP> = null;
    let errNorm = Infinity;
    const meanSide = board.sidesPx.reduce((a, b) => a + b, 0) / board.sidesPx.length;
    if (opts.poseSource === "board") {
      // ロストが長かったら前フレームの初期値は捨てる（古い姿勢や鏡像の解に引きずられないよう IPPE / DLT から取り直す）
      if (now - self.lastAcceptedMs > opts.resnapAfterMs) lastGuess = null;
      const result = cv ? solveBoardPnP(cv, board, K, opts.pnpMethod, lastGuess) : null;
      if (result) {
        errNorm = meanSide > 0 ? result.errPx / meanSide : Infinity;
        self.reprojPx = result.errPx;
        self.pnpUsed = result.method;
      }
      if (result && result.errPx <= opts.maxReprojPx && errNorm <= opts.maxPoseError) {
        boardResult = result;
        lastGuess = guessFromCameraMatrix(result.cameraMatrix);
      } else {
        lastGuess = null;
        if (now - lastRejectLogMs > 2000) {
          console.log(`[opencv] board rejected: ids=${board.ids.join("+")} reproj=${result ? result.errPx.toFixed(1) : "fail"}px err=${Number.isFinite(errNorm) ? errNorm.toFixed(2) : "-"} → 1 枚ずつの平均に落とす`);
          lastRejectLogMs = now;
        }
      }
    }
    // ---- 1 枚ずつの候補（診断の spread と、poseSource=single / board が捨てられたときに採用する姿勢）。08 の apply と同じ式。
    // board が解けていればその予測を初期値にして鏡像でない側の局所解を採る（solveSingleMarker の guess）----
    const candidates: PoseCandidate[] = [];
    const singleErrs: number[] = [];
    for (const d of detections) {
      const toAnchor = toAnchorOf(d.id);
      if (!toAnchor || !board.ids.includes(d.id)) continue;
      let guess: number[] | null = null;
      if (boardResult) {
        objToCam.fromArray(boardResult.cameraMatrix);
        predicted.multiplyMatrices(objToCam, toAnchor);
        guess = predicted.elements;
      }
      const single = cv ? solveSingleMarker(cv, d.corners, opts.markerSizeM, K, guess) : null;
      if (!single) continue;
      const sidePx = board.sidesPx[board.ids.indexOf(d.id)];
      singleErrs.push(sidePx > 0 ? single.errPx / sidePx : Infinity);
      objToCam.fromArray(single.cameraMatrix);
      markerWorld.multiplyMatrices(camera.matrixWorld, objToCam);
      if (toAnchor !== identity) markerWorld.multiply(inverseOf(toAnchor));
      if (upArr) {
        maxTilt = Math.max(maxTilt, tiltDegOf(markerWorld.elements, upArr));
        levelWorld.fromArray(levelRotation(markerWorld.elements, upArr));
        markerCenter.setFromMatrixPosition(objToCam).applyMatrix4(camera.matrixWorld);
        anchorOffset.setFromMatrixPosition(toAnchor).applyMatrix4(levelWorld);
        targetPos.copy(markerCenter).sub(anchorOffset);
        targetQuat.setFromRotationMatrix(levelWorld);
      } else {
        markerWorld.decompose(targetPos, targetQuat, targetScale);
      }
      candidates.push({
        pos: [targetPos.x, targetPos.y, targetPos.z],
        quat: [targetQuat.x, targetQuat.y, targetQuat.z, targetQuat.w],
        weight: sidePx * sidePx,
      });
    }
    const fused = fusePoseCandidates(candidates);

    // ---- 採用する姿勢: board が解けていればそれ、無ければ（single 指定か board が捨てられた）1 枚ずつの重み付き平均 ----
    let accepted = false;
    const usedBoard = boardResult !== null;
    if (boardResult) {
      objToCam.fromArray(boardResult.cameraMatrix);
      anchorWorld.multiplyMatrices(camera.matrixWorld, objToCam);
      if (upArr) {
        maxTilt = Math.max(maxTilt, tiltDegOf(anchorWorld.elements, upArr));
        // 水平化: 回転は Y = up（ヨーは PnP の Z 軸から）、位置は「見えているマーカーの中心の平均（ワールド） − R_level・(その平均のアンカー座標)」。
        // マーカーの中心は傾きの推定に依らずほぼ正しいので、原点までのオフセットだけ水平化した回転で戻す（08 と同じ考え方の複数枚版）
        levelWorld.fromArray(levelRotation(anchorWorld.elements, upArr));
        const c = meanV3(board.centersAnchor);
        centroidWorld.set(c[0], c[1], c[2]).applyMatrix4(anchorWorld);
        centroidOffset.set(c[0], c[1], c[2]).applyMatrix4(levelWorld);
        targetPos.copy(centroidWorld).sub(centroidOffset);
        targetQuat.setFromRotationMatrix(levelWorld);
      } else {
        anchorWorld.decompose(targetPos, targetQuat, targetScale);
      }
      accepted = true;
    } else if (fused) {
      // single: 08 と同じ重み付き平均（POSIT を IPPE_SQUARE に替えただけ）。board が捨てられたとき（配置の入力ミスなど）もここに落ちる
      const worst = Math.max(...singleErrs);
      if (worst <= opts.maxPoseError) {
        targetPos.set(fused.pos[0], fused.pos[1], fused.pos[2]);
        targetQuat.set(fused.quat[0], fused.quat[1], fused.quat[2], fused.quat[3]);
        if (opts.poseSource === "single") self.reprojPx = 0;
        self.pnpUsed = opts.poseSource === "single" ? "single" : "single(board rejected)";
        accepted = true;
      }
    }
    if (!accepted) {
      lost(now);
      return;
    }
    self.correctionM = self.everDetected ? anchor.position.distanceTo(targetPos) : 0;
    const snap =
      !self.everDetected ||
      ((opts.canSnap?.() ?? true) &&
        (now - self.lastAcceptedMs > opts.resnapAfterMs || anchor.position.distanceTo(targetPos) > opts.snapDistanceM));
    if (snap) {
      anchor.position.copy(targetPos);
      anchor.quaternion.copy(targetQuat);
    } else {
      anchor.position.lerp(targetPos, opts.smooth);
      anchor.quaternion.slerp(targetQuat, opts.smooth);
    }
    self.everDetected = true;
    self.lastAcceptedMs = now;
    self.usedIds = [...board.ids];
    self.spreadM = fused?.spread ?? 0;
    self.tiltDeg = maxTilt;
    const errText = usedBoard ? errNorm.toFixed(2) : singleErrs.map((e) => e.toFixed(2)).join(",");
    self.info = `id=${board.ids.join("+")} err=${errText}${opts.poseSource === "board" ? ` reproj=${self.reprojPx.toFixed(1)}px ${self.pnpUsed}` : ""}${board.ids.length > 1 ? ` spread=${self.spreadM.toFixed(2)}m` : ""}${upArr ? ` tilt=${maxTilt.toFixed(0)}deg` : ""} Δ=${self.correctionM.toFixed(2)}m cv=${self.detMs.toFixed(0)}ms`;
  }

  function lost(now: number) {
    if (self.everDetected) self.info = `lost (${((now - self.lastAcceptedMs) / 1000).toFixed(1)}s)`;
  }

  function useFallback(reason: string) {
    self.backend = "aruco2";
    self.loadStatus = reason;
    fallback = createMarkerAnchor(opts);
  }

  if (opts.detector === "aruco2") {
    useFallback("detector=aruco2");
  } else {
    self.loadStatus = "loading";
    void loadOpenCv(opts.opencvUrl, (step) => {
      self.loadStatus = step;
      if (self.backend === "loading") self.info = `loading opencv.js ${step}`;
    })
      .then((loaded) => {
        cv = loaded;
        detector = createArucoDetector(loaded);
        self.backend = "opencv";
        self.loadStatus = "ready";
        self.info = "searching";
        console.log(`[opencv] ready (${loaded.getBuildInformation?.().match(/Version control:\s*(\S+)/)?.[1] ?? "version unknown"})`);
      })
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn("[opencv] 読み込みに失敗。js-aruco2 にフォールバック:", msg);
        useFallback(`opencv failed: ${msg}`);
      });
  }

  return self;
}
