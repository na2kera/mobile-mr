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
//   - 1 枚ずつの姿勢も診断用に出し、08 と同じ定義の spread（候補の位置の最大距離）を返す。単体解は board と独立に IPPE の最良解と鏡像の 2 解を作り、
//     誤差の比が明確（2 倍以上）なら誤差の小さい方、僅差なら board の姿勢に回転が近い方を採る（pnp-board.ts の chooseSingleSolution）。
//     鏡像（ヨーの曖昧さ）で spread が膨らまず、配置の誤り（位置のずれ）は spread に残る
//   - board が解けたが再投影誤差が大きい（複数枚の配置と観測が合わない = 配置の入力ミス・貼りズレ）ときは、同じ不正な配置で原点に直す
//     1 枚ずつの平均は使わず、原点マーカーが見えていれば原点だけで解き、見えていなければ直前の姿勢を維持する（HUD に inconsistent spread=…m）
//   - usedIds は最終の姿勢に実際に寄与した ID だけ（board なら全枚、原点だけで解いたら原点、single なら誤差で捨てなかった候補）
// OpenCV.js の読み込み（opencv-loader.ts）は非同期で、失敗したら marker-anchor.ts（js-aruco2）にフォールバックする。
// 読み込めた後も、検出・solvePnP の例外（WASM の abort など。以後毎フレーム throw する）が 30 回連続したら js-aruco2 に切り替える。
// src/shared/marker-anchor.ts は変更しない（08 のもの）
import * as THREE from "three";
import { createMarkerAnchor } from "./marker-anchor";
import type { MarkerAnchor, MarkerAnchorOptions } from "./marker-anchor";
import { fusePoseCandidates, levelRotation, tiltDegOf } from "./marker-layout";
import type { PoseCandidate } from "./marker-layout";
import { loadOpenCv } from "./opencv-loader";
import type { CvMat, OpenCv } from "./opencv-loader";
import { createArucoDetector, detectMarkers, guessFromCameraMatrix, solveBoardPnP, solveSingleMarkerPair } from "./opencv-pose";
import type { ArucoDetectorLike, PnpGuess, PnpMethod, PnpResult } from "./opencv-pose";
import { buildBoard, cameraMatrix, chooseSingleSolution, focalPxOf, meanV3, reprojLimitPx } from "./pnp-board";
import type { Board, MarkerDetection } from "./pnp-board";
import type { V3 } from "./surface";

/** 検出・solvePnP の例外がこの回数連続したら js-aruco2 に切り替える（WASM の abort 後は毎フレーム throw するため） */
export const OPENCV_MAX_CONSECUTIVE_ERRORS = 30;

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
  /**
   * board の平均再投影誤差の上限 [px]。**検出画像の長辺 960px（08 の既定 detW）のときの px** で指定し、実際の検出画像の長辺に比例して換算する
   * （pnp-board.ts の reprojLimitPx）。maxPoseError（08 の POSIT と同じ尺度の正規化誤差）でもマーカーごとに足切りする
   */
  maxReprojPx: number;
  /** テスト用: OpenCV.js の読み込みを差し替える（Node では fetch → Blob の import が使えないため）。省略時は loadOpenCv(opencvUrl) */
  loadCv?: (onProgress: (step: string) => void) => Promise<OpenCv>;
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
  /** 検出・solvePnP の例外の連続回数（成功したフレームで 0 に戻す） */
  let consecutiveErrors = 0;
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
  const markerCenter = new THREE.Vector3();
  const anchorOffset = new THREE.Vector3();
  const predictedMarker = new THREE.Matrix4();
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
      let rgba: CvMat | null = null;
      let gray: CvMat | null = null;
      try {
        detCtx.drawImage(video, 0, 0, w, h);
        const image = detCtx.getImageData(0, 0, w, h);
        const focalPx = focalPxOf(w, h, opts.camHFovDeg());
        const K = cameraMatrix(focalPx, w, h);
        rgba = cv.matFromImageData(image);
        gray = new cv.Mat();
        cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
        const detections = detectMarkers(cv, detector, gray);
        self.detMs = performance.now() - t0;
        apply(detections, K, Math.max(w, h), now);
        consecutiveErrors = 0;
      } catch (e: unknown) {
        runtimeError(e, now, t0);
      } finally {
        // abort 後は delete 自体も throw しうるので、ここで外に出さない
        try {
          rgba?.delete();
          gray?.delete();
        } catch {
          /* 次のフレームの例外として数える */
        }
      }
    },
  };

  /**
   * 検出・solvePnP の例外（WASM の abort・メモリ不足・OpenCV の cv::Exception）。update の外には出さない。
   * そのフレームはロスト扱い（lastAcceptedMs を進めない・前フレームの初期値を捨てる）で HUD に error(N 回連続)=理由 を出し、
   * OPENCV_MAX_CONSECUTIVE_ERRORS 回連続したら js-aruco2 に切り替える
   */
  function runtimeError(e: unknown, now: number, t0: number) {
    consecutiveErrors++;
    self.detMs = performance.now() - t0;
    lastGuess = null;
    const msg = (e instanceof Error ? e.message : String(e)).slice(0, 80);
    self.info = `error(${consecutiveErrors}x)=${msg}`;
    if (consecutiveErrors === 1 || now - lastRejectLogMs > 2000) {
      console.warn(`[opencv] 検出でエラー（${consecutiveErrors} 回連続）:`, e);
      lastRejectLogMs = now;
    }
    if (consecutiveErrors >= OPENCV_MAX_CONSECUTIVE_ERRORS) {
      console.warn(`[opencv] エラーが ${consecutiveErrors} 回連続したので js-aruco2 に切り替える`);
      try {
        detector?.delete();
      } catch {
        /* abort 後は delete も失敗しうる */
      }
      detector = null;
      cv = null;
      useFallback(`opencv runtime error: ${msg}`);
    }
  }

  /** 1 枚ずつ解いた姿勢（board と独立の 2 解から選ぶ。08 の POSIT と同じ「1 枚ずつ」）をアンカーの候補にしたもの */
  type SingleCandidate = PoseCandidate & { id: number; error: number; tilt: number };

  /** 1 枚ずつの姿勢 → アンカーの候補（08 の apply と同じ式。水平化するなら「マーカー中心 − R_level・pos」） */
  /** @param boardCam board の解（アンカー → three.js カメラの 4x4）。2 解が僅差のときだけ、これから予測したマーカーの姿勢に近い方を選ぶのに使う */
  function singleCandidates(detections: readonly MarkerDetection[], board: Board, K: number[], upArr: V3 | null, boardCam: readonly number[] | null): SingleCandidate[] {
    const out: SingleCandidate[] = [];
    for (const d of detections) {
      const toAnchor = toAnchorOf(d.id);
      if (!toAnchor || !board.ids.includes(d.id) || out.some((c) => c.id === d.id)) continue;
      const pair = solveSingleMarkerPair(cv!, d.corners, opts.markerSizeM, K);
      if (!pair) continue;
      let reference: number[] | null = null;
      if (boardCam) {
        objToCam.fromArray(boardCam);
        predictedMarker.multiplyMatrices(objToCam, toAnchor);
        reference = predictedMarker.elements;
      }
      const single = chooseSingleSolution(pair.best, pair.mirror, reference).pick;
      const sidePx = board.sidesPx[board.ids.indexOf(d.id)];
      objToCam.fromArray(single.cameraMatrix);
      markerWorld.multiplyMatrices(camera.matrixWorld, objToCam);
      if (toAnchor !== identity) markerWorld.multiply(inverseOf(toAnchor));
      let tilt = 0;
      if (upArr) {
        tilt = tiltDegOf(markerWorld.elements, upArr);
        levelWorld.fromArray(levelRotation(markerWorld.elements, upArr));
        markerCenter.setFromMatrixPosition(objToCam).applyMatrix4(camera.matrixWorld);
        anchorOffset.setFromMatrixPosition(toAnchor).applyMatrix4(levelWorld);
        targetPos.copy(markerCenter).sub(anchorOffset);
        targetQuat.setFromRotationMatrix(levelWorld);
      } else {
        markerWorld.decompose(targetPos, targetQuat, targetScale);
      }
      out.push({
        id: d.id,
        error: single.error,
        tilt,
        pos: [targetPos.x, targetPos.y, targetPos.z],
        quat: [targetQuat.x, targetQuat.y, targetQuat.z, targetQuat.w],
        weight: sidePx * sidePx,
      });
    }
    return out;
  }

  /** board（アンカー座標系の対応点）の solvePnP の解を targetPos / targetQuat に入れる。戻り値は水平化前の傾き [deg] */
  function boardPoseToTarget(result: PnpResult, board: Board, upArr: V3 | null): number {
    objToCam.fromArray(result.cameraMatrix);
    anchorWorld.multiplyMatrices(camera.matrixWorld, objToCam);
    if (!upArr) {
      anchorWorld.decompose(targetPos, targetQuat, targetScale);
      return 0;
    }
    // 水平化: 回転は Y = up（ヨーは PnP の Z 軸から）、位置は「見えているマーカーの中心の平均（ワールド） − R_level・(その平均のアンカー座標)」。
    // マーカーの中心は傾きの推定に依らずほぼ正しいので、原点までのオフセットだけ水平化した回転で戻す（08 と同じ考え方の複数枚版）
    const tilt = tiltDegOf(anchorWorld.elements, upArr);
    levelWorld.fromArray(levelRotation(anchorWorld.elements, upArr));
    const c = meanV3(board.centersAnchor);
    centroidWorld.set(c[0], c[1], c[2]).applyMatrix4(anchorWorld);
    centroidOffset.set(c[0], c[1], c[2]).applyMatrix4(levelWorld);
    targetPos.copy(centroidWorld).sub(centroidOffset);
    targetQuat.setFromRotationMatrix(levelWorld);
    return tilt;
  }

  /** board の解を採用してよいか（平均再投影誤差 ≤ 検出画像の解像度に換算した上限、かつ全マーカーの正規化誤差 ≤ maxPoseError） */
  function boardOk(result: PnpResult, limitPx: number): boolean {
    return result.errPx <= limitPx && Math.max(...result.markerErrors) <= opts.maxPoseError;
  }

  function apply(detections: MarkerDetection[], K: number[], detLongPx: number, now: number) {
    const up = opts.worldUp?.() ?? null;
    const upArr: V3 | null = up ? [up.x, up.y, up.z] : null;
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
    // ---- 1 枚ずつの候補。spread（08 と同じ「候補の原点の位置のばらつき」）と ?pose=single に使う ----
    const singlesWith = (boardCam: readonly number[] | null) => {
      const goodSingles = singleCandidates(detections, board, K, upArr, boardCam).filter((c) => Number.isFinite(c.error) && c.error <= opts.maxPoseError);
      const fused = fusePoseCandidates(goodSingles);
      return { goodSingles, fused, spreadM: fused?.spread ?? 0 };
    };

    let usedIds: number[] = [];
    let errText = "";
    let tilt = 0;
    let inconsistent = false;
    let spreadM = 0;
    if (opts.poseSource === "single") {
      // single: 08 と同じ重み付き平均（POSIT を IPPE_SQUARE に替えただけ。誤差の大きい候補は 1 枚ずつ捨てる）。board が無いので 2 解は誤差の小さい方
      const { goodSingles, fused } = singlesWith(null);
      spreadM = fused?.spread ?? 0;
      if (!fused) {
        lost(now);
        return;
      }
      targetPos.set(fused.pos[0], fused.pos[1], fused.pos[2]);
      targetQuat.set(fused.quat[0], fused.quat[1], fused.quat[2], fused.quat[3]);
      usedIds = goodSingles.map((c) => c.id);
      errText = goodSingles.map((c) => c.error.toFixed(2)).join(",");
      tilt = Math.max(0, ...goodSingles.map((c) => c.tilt));
      self.reprojPx = 0;
      self.pnpUsed = "single";
    } else {
      // ---- board（全マーカー同時）の姿勢 ----
      // ロストが長かったら前フレームの初期値は捨てる（古い姿勢や鏡像の解に引きずられないよう IPPE / DLT から取り直す）
      if (now - self.lastAcceptedMs > opts.resnapAfterMs) lastGuess = null;
      const limitPx = reprojLimitPx(opts.maxReprojPx, detLongPx);
      let result = solveBoardPnP(cv!, board, K, opts.pnpMethod, lastGuess);
      if (!result) {
        // 解なし（solvePnP が false・カメラの後ろ）。配置の不整合とは区別してロスト扱い
        lastGuess = null;
        lost(now);
        return;
      }
      self.reprojPx = result.errPx;
      self.pnpUsed = result.method;
      // 単体解の 2 解が僅差のときは、棄却される board でも（姿勢は解けているので）それに近い方を選ぶ。配置の誤りは位置のずれとして spread に残る
      spreadM = singlesWith(result.cameraMatrix).spreadM;
      let solvedBoard = board;
      if (!boardOk(result, limitPx)) {
        if (board.ids.length < 2) {
          // 1 枚で誤差が大きい = 誤検出・ブレ。配置の問題ではないのでロスト扱い
          logReject(now, `rejected: id=${board.ids[0]} reproj=${result.errPx.toFixed(1)}px err=${result.markerErrors[0].toFixed(2)}`);
          lastGuess = null;
          lost(now);
          return;
        }
        // 解けたが複数枚の配置と観測が合わない（配置の入力ミス・貼りズレ）。1 枚ずつの平均は同じ不正な配置で原点に直すので使わない:
        // 原点マーカーが見えていれば原点だけで解き、見えていなければ直前の姿勢を維持する（ロストとは別の「配置不整合」）
        inconsistent = true;
        logReject(now, `inconsistent: ids=${board.ids.join("+")} reproj=${result.errPx.toFixed(1)}px spread=${spreadM.toFixed(2)}m → ${board.ids.includes(opts.markerId) ? "原点だけで解く" : "直前の姿勢を維持"}`);
        const originDet = detections.find((d) => d.id === opts.markerId);
        const originBoard = originDet ? buildBoard([originDet], () => identity.elements, opts.markerSizeM) : null;
        const originResult = originBoard ? solveBoardPnP(cv!, originBoard, K, opts.pnpMethod, lastGuess) : null;
        if (!originBoard || !originResult || !boardOk(originResult, limitPx)) {
          self.info = `inconsistent spread=${spreadM.toFixed(2)}m ids=${board.ids.join("+")} reproj=${result.errPx.toFixed(1)}px (${originDet ? "origin rejected" : "no origin"}, holding pose) cv=${self.detMs.toFixed(0)}ms`;
          self.spreadM = spreadM;
          return;
        }
        result = originResult;
        solvedBoard = originBoard;
        self.reprojPx = result.errPx;
        self.pnpUsed = `${result.method}(origin only)`;
      }
      lastGuess = guessFromCameraMatrix(result.cameraMatrix);
      tilt = boardPoseToTarget(result, solvedBoard, upArr);
      usedIds = [...solvedBoard.ids];
      errText = result.markerErrors.map((e) => e.toFixed(2)).join(",");
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
    self.usedIds = usedIds;
    self.spreadM = spreadM;
    self.tiltDeg = tilt;
    const showSpread = inconsistent || board.ids.length > 1;
    self.info = `id=${usedIds.join("+")} err=${errText}${opts.poseSource === "board" ? ` reproj=${self.reprojPx.toFixed(1)}px ${self.pnpUsed}` : ""}${inconsistent ? " inconsistent" : ""}${showSpread ? ` spread=${spreadM.toFixed(2)}m` : ""}${upArr ? ` tilt=${tilt.toFixed(0)}deg` : ""} Δ=${self.correctionM.toFixed(2)}m cv=${self.detMs.toFixed(0)}ms`;
  }

  function logReject(now: number, text: string) {
    if (now - lastRejectLogMs > 2000) {
      console.log(`[opencv] ${text}`);
      lastRejectLogMs = now;
    }
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
    const onProgress = (step: string) => {
      self.loadStatus = step;
      if (self.backend === "loading") self.info = `loading opencv.js ${step}`;
    };
    void (opts.loadCv ? opts.loadCv(onProgress) : loadOpenCv(opts.opencvUrl, onProgress))
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
