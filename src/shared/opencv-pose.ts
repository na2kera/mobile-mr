// OpenCV.js（WASM）で ArUco を検出し、見えている全マーカーを 1 つの board として solvePnP で 1 つの姿勢にする（08-4 の中核）。
// DOM にも three.js にも依存させない: cv（読み込み済みの OpenCV.js モジュール）と灰色画像の Mat を受け取り、
// 数値（rvec / tvec / 再投影誤差）を返す。Node（Emscripten の Node 対応ビルド）でも同じコードが動くので、
// scripts/test-08-4-opencv.mjs は合成画像でこの往復（投影 → 検出 → solvePnP → 元の姿勢）を確かめる。
// OpenCV.js の型定義は同梱していない（package.json に依存を足さない方針）ので、使う範囲だけを opencv-loader.ts の OpenCv 型で宣言する
import type { V3 } from "./surface.ts";
import type { CvMat, OpenCv } from "./opencv-loader.ts";
import {
  cameraMatrixToCvPose,
  cvPoseToCameraMatrix,
  isCoplanar,
  markerCorners,
  markerErrorsL1,
  matrixToRodrigues,
  meanSidePx,
  mirrorPoseGuess,
  reprojectionErrorPx,
  rodriguesToMatrix,
  rotationDiffDeg,
} from "./pnp-board.ts";
import type { Board, MarkerDetection } from "./pnp-board.ts";

/** solvePnP の使い分け（?pnp=）。auto: 平面なら IPPE → ITERATIVE で仕上げ（前フレームがあれば初期値ありの解も出して連続性を優先）、非平面なら ITERATIVE（前フレームを初期値） */
export type PnpMethod = "auto" | "ippe" | "iterative";

export type ArucoDetectorLike = {
  detectMarkers(image: CvMat, corners: unknown, ids: CvMat, rejected: unknown): void;
  delete(): void;
};

/**
 * ArucoDetector を作る。辞書は js-aruco2 と同じ ARUCO_MIP_36h12（ID とビットの向きが一致することを Node で確認済み。
 * 印刷ページ markers.html のマーカーがそのまま読める）。コーナーはサブピクセル精錬（CORNER_REFINE_SUBPIX）
 */
export function createArucoDetector(cv: OpenCv): ArucoDetectorLike {
  const dict = cv.getPredefinedDictionary(cv.DICT_ARUCO_MIP_36h12);
  const params = new cv.aruco_DetectorParameters();
  params.cornerRefinementMethod = cv.CORNER_REFINE_SUBPIX;
  // 誤検出の足切り: detectMarkers が許す誤りビット数は int(辞書の maxCorrectionBits × errorCorrectionRate)。
  // 36h12 の maxCorrectionBits は 12 で、既定の 0.6 だと 7 ビット反転しても ID として読む（Node で確認）。
  // 0.34 で int(12 × 0.34) = 4 ビット = js-aruco2（08 の maxHammingDistance 4）と同じ厳しさにする（4 ビット反転は検出・5 ビットは不検出をテストで確認）
  params.errorCorrectionRate = 0.34;
  // RefineParameters は refineDetectedMarkers（使っていない）用。この JS バインディングは引数無しで作れないので C++ の既定値（10, 3, true）を渡すだけ
  const refine = new cv.aruco_RefineParameters(10, 3, true);
  try {
    // ArucoDetector は辞書・パラメータを値でコピーして持つので、JS 側のハンドルはすぐ消してよい
    return new cv.aruco_ArucoDetector(dict, params, refine) as unknown as ArucoDetectorLike;
  } finally {
    dict.delete();
    params.delete();
    refine.delete();
  }
}

/** 灰色画像（CV_8UC1）からマーカーを検出する。Mat は毎回作って消す（Emscripten のヒープなので GC されない） */
export function detectMarkers(cv: OpenCv, detector: ArucoDetectorLike, gray: CvMat): MarkerDetection[] {
  const corners = new cv.MatVector();
  const ids = new cv.Mat();
  const rejected = new cv.MatVector();
  const out: MarkerDetection[] = [];
  try {
    detector.detectMarkers(gray, corners, ids, rejected);
    const n = ids.rows;
    for (let i = 0; i < n; i++) {
      const c = corners.get(i);
      try {
        const d = c.data32F;
        out.push({
          id: ids.data32S[i],
          corners: [
            [d[0], d[1]],
            [d[2], d[3]],
            [d[4], d[5]],
            [d[6], d[7]],
          ],
        });
      } finally {
        c.delete();
      }
    }
  } finally {
    corners.delete();
    ids.delete();
    rejected.delete();
  }
  return out;
}

export type PnpResult = {
  /** object（アンカー）座標系 → OpenCV のカメラ座標系。R は行優先 9 要素 */
  R: number[];
  t: V3;
  rvec: V3;
  tvec: V3;
  /** object → three.js のカメラ座標系の 4x4（列優先。cvPoseToCameraMatrix） */
  cameraMatrix: number[];
  /** 再投影誤差の平均 [px] */
  errPx: number;
  /** マーカーごとの正規化誤差（08 の POSIT と同じ尺度。pnp-board.ts の markerErrorsL1。board.ids と同じ並び） */
  markerErrors: number[];
  /** 実際に使った方法（HUD 用: "ippe+lm" / "iter" / "iter(guess)"） */
  method: string;
};

export type PnpGuess = { rvec: V3; tvec: V3 };

/** solveSingleMarker の結果（マーカー → three.js カメラの 4x4、再投影誤差の平均 [px]、08 と同じ尺度の正規化誤差） */
export type SinglePose = { cameraMatrix: number[]; errPx: number; error: number };

/**
 * board の対応点を solvePnP で 1 つの姿勢にする。解が無い（solvePnP が false・非有限・カメラの後ろ）なら null。
 * OpenCV.js の例外（WASM の abort・メモリ不足など）は握りつぶさずそのまま throw する（「解なし」の null と区別するため。
 * 呼び出し側の marker-anchor-opencv.ts が連続回数を数えて js-aruco2 に切り替える）
 * @param K カメラ行列（行優先 9。pnp-board.ts の cameraMatrix）
 * @param guess 前フレームの姿勢（ITERATIVE の初期値。無ければ無しで解く）
 */
export function solveBoardPnP(cv: OpenCv, board: Board, K: readonly number[], method: PnpMethod, guess: PnpGuess | null): PnpResult | null {
  const n = board.objectPoints.length / 3;
  if (n < 4) return null;
  const planar = isCoplanar(board.objectPoints);
  const obj = cv.matFromArray(n, 3, cv.CV_32F, board.objectPoints);
  const img = cv.matFromArray(n, 2, cv.CV_32F, board.imagePoints);
  const kMat = cv.matFromArray(3, 3, cv.CV_64F, K);
  const dist = cv.Mat.zeros(4, 1, cv.CV_64F);
  // rvec / tvec は 3x1 CV_64F で先に確保しておく（useExtrinsicGuess=true のときは中身が初期値として読まれる）
  const rvec = cv.Mat.zeros(3, 1, cv.CV_64F);
  const tvec = cv.Mat.zeros(3, 1, cv.CV_64F);
  type Candidate = { rvec: V3; tvec: V3; errPx: number; method: string };
  const candidates: Candidate[] = [];
  try {
    const solve = (flags: number, useGuess: boolean, label: string) => {
      const ok = cv.solvePnP(obj, img, kMat, dist, rvec, tvec, useGuess, flags);
      if (!ok) return;
      const rv = Array.from(rvec.data64F) as V3;
      const tv = Array.from(tvec.data64F) as V3;
      if (rv.length !== 3 || tv.length !== 3 || !rv.every(Number.isFinite) || !tv.every(Number.isFinite)) return;
      const errPx = reprojectionErrorPx(board.objectPoints, board.imagePoints, rodriguesToMatrix(rv), tv, K);
      if (Number.isFinite(errPx)) candidates.push({ rvec: rv, tvec: tv, errPx, method: label });
    };
    const setGuess = (g: PnpGuess) => {
      rvec.data64F.set(g.rvec);
      tvec.data64F.set(g.tvec);
    };
    // 平面（1 枚、または同じ壁の複数枚）: IPPE（2 解から再投影誤差の小さい方）→ auto ならその解を初期値に LM（ITERATIVE）で仕上げ。
    // 加えて auto で前フレームがあれば、前フレームを初期値にした ITERATIVE も解く（下の候補の選び方で「誤差が同程度なら連続性を優先」）。
    // 正面付近の小さい 1 枚は IPPE の 2 解（鏡像）の誤差が僅差でどちらが選ばれるかが揺れるので、複数枚が見えていた直前のフレーム
    // （鏡像の無い board の解）からの連続性で 1 枚になっても正しい側に留まる。逆に最初の取得が鏡像なら居座る（README の既知の制約。
    // ロストが resnapAfterMs を超えたら呼び出し側が初期値を捨てて IPPE から取り直す）
    if (planar && method !== "iterative") {
      solve(cv.SOLVEPNP_IPPE, false, "ippe");
      const ippe = candidates.at(-1);
      if (method === "auto" && ippe && ippe.method === "ippe") {
        setGuess(ippe);
        solve(cv.SOLVEPNP_ITERATIVE, true, "ippe+lm");
      }
      if (method === "auto" && guess) {
        setGuess(guess);
        solve(cv.SOLVEPNP_ITERATIVE, true, "iter(guess)");
      }
    }
    // 非平面（壁 + 床など）か iterative 指定: ITERATIVE。前フレームがあれば初期値にし、無ければ初期値無し（非平面は DLT、平面はホモグラフィ）。
    // 両方解いて再投影誤差の小さい方を採る（初期値ありが同程度なら連続性を優先）
    if (method === "iterative" || (!planar && method !== "ippe") || candidates.length === 0) {
      if (guess) {
        setGuess(guess);
        solve(cv.SOLVEPNP_ITERATIVE, true, "iter(guess)");
      }
      solve(cv.SOLVEPNP_ITERATIVE, false, "iter");
    }
    if (candidates.length === 0) return null;
    const minErr = Math.min(...candidates.map((c) => c.errPx));
    const best =
      candidates.find((c) => c.method === "iter(guess)" && c.errPx <= minErr * 1.05) ??
      candidates.find((c) => c.method === "ippe+lm" && c.errPx <= minErr * 1.05) ??
      candidates.find((c) => c.errPx === minErr)!;
    const R = rodriguesToMatrix(best.rvec);
    return {
      R,
      t: best.tvec,
      rvec: best.rvec,
      tvec: best.tvec,
      cameraMatrix: cvPoseToCameraMatrix(R, best.tvec),
      errPx: best.errPx,
      markerErrors: markerErrorsL1(board.objectPoints, board.imagePoints, board.sidesPx, R, best.tvec, K),
      method: best.method,
    };
  } finally {
    obj.delete();
    img.delete();
    kMat.delete();
    dist.delete();
    rvec.delete();
    tvec.delete();
  }
}

/**
 * 1 枚のマーカーだけの姿勢（SOLVEPNP_IPPE_SQUARE。マーカー座標系 → three.js のカメラ座標系の 4x4）。
 * 08 の POSIT と同じ「1 枚ずつ」の推定で、複数見えたときの候補のばらつき（spread）の診断と、?pose=single の比較用。
 * 解が無ければ null、OpenCV.js の例外は throw（solveBoardPnP と同じ）。error は 08 の POSIT と同じ尺度の正規化誤差
 * @param guess board の解から予測したこのマーカーの姿勢（マーカー → three.js カメラの 4x4）。渡すとそれを初期値にした ITERATIVE も解き、
 *   再投影誤差が IPPE_SQUARE の 1.5 倍以内ならそちらを採る（正面付近の小さい 1 枚は IPPE の 2 解（鏡像）の誤差が僅差で、
 *   1 枚ずつだと鏡像を拾って spread が 0.16m になる。board の予測に近い局所解を選べば spread は「配置と実物のずれ」だけを表す）
 */
export function solveSingleMarker(
  cv: OpenCv,
  corners: readonly [number, number][],
  markerSizeM: number,
  K: readonly number[],
  guess: readonly number[] | null = null,
): SinglePose | null {
  const local = markerCorners(markerSizeM);
  const obj = cv.matFromArray(4, 3, cv.CV_32F, local.flat());
  const img = cv.matFromArray(4, 2, cv.CV_32F, corners.flat());
  const kMat = cv.matFromArray(3, 3, cv.CV_64F, K);
  const dist = cv.Mat.zeros(4, 1, cv.CV_64F);
  const rvec = cv.Mat.zeros(3, 1, cv.CV_64F);
  const tvec = cv.Mat.zeros(3, 1, cv.CV_64F);
  try {
    const solve = (flags: number, useGuess: boolean): SinglePose | null => {
      const ok = cv.solvePnP(obj, img, kMat, dist, rvec, tvec, useGuess, flags);
      if (!ok) return null;
      const rv = Array.from(rvec.data64F) as V3;
      const tv = Array.from(tvec.data64F) as V3;
      if (rv.length !== 3 || tv.length !== 3 || !rv.every(Number.isFinite) || !tv.every(Number.isFinite)) return null;
      const R = rodriguesToMatrix(rv);
      const errPx = reprojectionErrorPx(local.flat(), corners.flat(), R, tv, K);
      if (!Number.isFinite(errPx)) return null;
      const error = markerErrorsL1(local.flat(), corners.flat(), [meanSidePx(corners)], R, tv, K)[0];
      return { cameraMatrix: cvPoseToCameraMatrix(R, tv), errPx, error };
    };
    const ippe = solve(cv.SOLVEPNP_IPPE_SQUARE, false);
    if (!guess) return ippe;
    const g = guessFromCameraMatrix(guess);
    rvec.data64F.set(g.rvec);
    tvec.data64F.set(g.tvec);
    const near = solve(cv.SOLVEPNP_ITERATIVE, true);
    if (!near) return ippe;
    if (!ippe) return near;
    return near.errPx <= ippe.errPx * 1.5 ? near : ippe;
  } finally {
    obj.delete();
    img.delete();
    kMat.delete();
    dist.delete();
    rvec.delete();
    tvec.delete();
  }
}

/**
 * 1 枚のマーカーの 2 解（board と独立）: IPPE_SQUARE の最良解と、その鏡像（pnp-board.ts の mirrorPoseGuess を初期値にした ITERATIVE）。
 * 鏡像が最良解と同じ局所解に落ちた（回転差 < 1°）なら mirror は null。解が無ければ null、OpenCV.js の例外は throw
 */
export function solveSingleMarkerPair(
  cv: OpenCv,
  corners: readonly [number, number][],
  markerSizeM: number,
  K: readonly number[],
): { best: SinglePose; mirror: SinglePose | null } | null {
  const local = markerCorners(markerSizeM);
  const obj = cv.matFromArray(4, 3, cv.CV_32F, local.flat());
  const img = cv.matFromArray(4, 2, cv.CV_32F, corners.flat());
  const kMat = cv.matFromArray(3, 3, cv.CV_64F, K);
  const dist = cv.Mat.zeros(4, 1, cv.CV_64F);
  const rvec = cv.Mat.zeros(3, 1, cv.CV_64F);
  const tvec = cv.Mat.zeros(3, 1, cv.CV_64F);
  try {
    const solve = (flags: number, useGuess: boolean): (SinglePose & { R: number[]; t: V3 }) | null => {
      const ok = cv.solvePnP(obj, img, kMat, dist, rvec, tvec, useGuess, flags);
      if (!ok) return null;
      const rv = Array.from(rvec.data64F) as V3;
      const tv = Array.from(tvec.data64F) as V3;
      if (rv.length !== 3 || tv.length !== 3 || !rv.every(Number.isFinite) || !tv.every(Number.isFinite)) return null;
      const R = rodriguesToMatrix(rv);
      const errPx = reprojectionErrorPx(local.flat(), corners.flat(), R, tv, K);
      if (!Number.isFinite(errPx)) return null;
      const error = markerErrorsL1(local.flat(), corners.flat(), [meanSidePx(corners)], R, tv, K)[0];
      return { cameraMatrix: cvPoseToCameraMatrix(R, tv), errPx, error, R, t: tv };
    };
    const ippe = solve(cv.SOLVEPNP_IPPE_SQUARE, false);
    if (!ippe) return null;
    rvec.data64F.set(matrixToRodrigues(mirrorPoseGuess(ippe.R, ippe.t)));
    tvec.data64F.set(ippe.t);
    const m = solve(cv.SOLVEPNP_ITERATIVE, true);
    const strip = (x: SinglePose & { R: number[]; t: V3 }): SinglePose => ({ cameraMatrix: x.cameraMatrix, errPx: x.errPx, error: x.error });
    const mirror = m && rotationDiffDeg(m.cameraMatrix, ippe.cameraMatrix) >= 1 ? strip(m) : null;
    return { best: strip(ippe), mirror };
  } finally {
    obj.delete();
    img.delete();
    kMat.delete();
    dist.delete();
    rvec.delete();
    tvec.delete();
  }
}

/** three.js のカメラ座標系での object → camera の 4x4 から、次のフレームの初期値（rvec / tvec）を作る */
export function guessFromCameraMatrix(m: readonly number[]): PnpGuess {
  const { R, t } = cameraMatrixToCvPose(m);
  return { rvec: matrixToRodrigues(R), tvec: t };
}
