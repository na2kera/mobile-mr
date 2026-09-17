// 08-4（OpenCV.js の ArUco board + solvePnP）の純粋な数学。three.js にも OpenCV にも依存させない
// （Node の回帰テスト scripts/test-08-4-opencv.mjs から import するため。import に .ts を付けているのも Node の ESM 解決のため）。
//   - 見えている全マーカーの 4 隅を「アンカー（原点マーカー = field）座標系」に置いて 1 つの board の対応点にする
//   - OpenCV の姿勢（rvec / tvec。カメラは X 右・Y 下・Z 前）を three.js のカメラ座標系（X 右・Y 上・-Z 前）の 4x4 に直す
//   - 再投影誤差（HUD の err= と足切りに使う）
// 行列は three.js の Matrix4.elements と同じ列優先 16 要素（marker-layout.ts と同じ）。3x3 は行優先 9 要素（OpenCV の Mat と同じ並び）
import type { V3 } from "./surface.ts";
import { transformPoint } from "./marker-layout.ts";

/** 検出器が返す 1 枚ぶん（OpenCV の corners の並び: 左上・右上・右下・左下。画像は左上原点・Y 下） */
export type MarkerDetection = {
  id: number;
  corners: [number, number][];
};

/** solvePnP に渡す対応点（object = アンカー座標系 [m]、image = 検出画像 [px]。どちらも平坦な配列） */
export type Board = {
  ids: number[];
  /** 3n 要素（x, y, z の並び） */
  objectPoints: number[];
  /** 2n 要素（x, y の並び） */
  imagePoints: number[];
  /** 各マーカーの中心（アンカー座標系）。水平化のときの「位置の基準点」に使う */
  centersAnchor: V3[];
  /** 各マーカーの画面上の平均辺長 [px] */
  sidesPx: number[];
};

/**
 * マーカー座標系での 4 隅（X 右・Y 上・Z = 面から視点側。marker-detector.ts / marker-layout.ts と同じ）。
 * 並びは OpenCV の ArucoDetector が返す corners と同じ「左上・右上・右下・左下」。
 * OpenCV の DICT_ARUCO_MIP_36h12 と js-aruco2 の ARUCO_MIP_36h12 はビット配列が同じ向きで一致することを Node で確認済みなので、
 * 「左上」は印刷ページ（markers.html）の左上と同じ
 */
export function markerCorners(sizeM: number): V3[] {
  const h = sizeM / 2;
  return [
    [-h, h, 0],
    [h, h, 0],
    [h, -h, 0],
    [-h, -h, 0],
  ];
}

/** 画面上のマーカーの平均辺長 [px]（marker-detector.ts の sidePx と同じ定義） */
export function meanSidePx(corners: readonly [number, number][]): number {
  let perimeter = 0;
  for (let i = 0; i < 4; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % 4];
    perimeter += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return perimeter / 4;
}

/**
 * 見えているマーカーのうち配置が分かっているもの（toAnchorOf が行列を返すもの）を 1 つの board にする。
 * 同じ ID が複数見えたら最初の 1 つ。配置が無い ID は無視する。1 枚も無ければ null
 * @param toAnchorOf ID → その マーカー座標系 → アンカー座標系 の 4x4（列優先）。原点マーカーなら単位行列
 */
export function buildBoard(
  detections: readonly MarkerDetection[],
  toAnchorOf: (id: number) => number[] | null,
  markerSizeM: number,
): Board | null {
  const local = markerCorners(markerSizeM);
  const board: Board = { ids: [], objectPoints: [], imagePoints: [], centersAnchor: [], sidesPx: [] };
  for (const d of detections) {
    if (d.corners.length !== 4 || board.ids.includes(d.id)) continue;
    const toAnchor = toAnchorOf(d.id);
    if (!toAnchor) continue;
    board.ids.push(d.id);
    for (let i = 0; i < 4; i++) {
      const p = transformPoint(toAnchor, local[i]);
      board.objectPoints.push(p[0], p[1], p[2]);
      board.imagePoints.push(d.corners[i][0], d.corners[i][1]);
    }
    board.centersAnchor.push(transformPoint(toAnchor, [0, 0, 0]));
    board.sidesPx.push(meanSidePx(d.corners));
  }
  return board.ids.length > 0 ? board : null;
}

/**
 * 対応点がすべて 1 つの平面上にあるか（SOLVEPNP_IPPE は平面の点にしか使えない。壁 + 床のように面が違えば false）。
 * 最初の 3 点で平面を作り、残りの点の距離が tolM 以内なら平面
 */
export function isCoplanar(objectPoints: readonly number[], tolM = 1e-3): boolean {
  const n = objectPoints.length / 3;
  if (n < 4) return true;
  const p = (i: number): V3 => [objectPoints[i * 3], objectPoints[i * 3 + 1], objectPoints[i * 3 + 2]];
  const a = p(0);
  // 退化しない 2 本の辺を探す（最初の 3 点が一直線のとき用）
  let normal: V3 | null = null;
  for (let j = 1; j < n && !normal; j++) {
    for (let k = j + 1; k < n && !normal; k++) {
      const u = sub(p(j), a);
      const v = sub(p(k), a);
      const c = cross(u, v);
      const len = Math.hypot(c[0], c[1], c[2]);
      if (len > 1e-9) normal = [c[0] / len, c[1] / len, c[2] / len];
    }
  }
  if (!normal) return true;
  for (let i = 1; i < n; i++) {
    const d = sub(p(i), a);
    if (Math.abs(d[0] * normal[0] + d[1] * normal[1] + d[2] * normal[2]) > tolM) return false;
  }
  return true;
}

/** カメラ行列（行優先 9 要素）。主点は画像中心、歪みは 0 として扱う */
export function cameraMatrix(focalPx: number, width: number, height: number): number[] {
  return [focalPx, 0, width / 2, 0, focalPx, height / 2, 0, 0, 1];
}

/** 検出画像の焦点距離 [px]（marker-anchor.ts と同じ換算: 長辺 / 2 / tan(水平 FOV / 2)。向きに依存しない） */
export function focalPxOf(width: number, height: number, hFovDeg: number): number {
  return Math.max(width, height) / 2 / Math.tan((hFovDeg * Math.PI) / 180 / 2);
}

/** Rodrigues ベクトル → 3x3 回転（行優先 9 要素）。OpenCV の cv.Rodrigues と同じ */
export function rodriguesToMatrix(rvec: V3): number[] {
  const theta = Math.hypot(rvec[0], rvec[1], rvec[2]);
  if (theta < 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const [kx, ky, kz] = [rvec[0] / theta, rvec[1] / theta, rvec[2] / theta];
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const v = 1 - c;
  return [
    c + kx * kx * v,
    kx * ky * v - kz * s,
    kx * kz * v + ky * s,
    ky * kx * v + kz * s,
    c + ky * ky * v,
    ky * kz * v - kx * s,
    kz * kx * v - ky * s,
    kz * ky * v + kx * s,
    c + kz * kz * v,
  ];
}

/** 3x3 回転（行優先 9 要素）→ Rodrigues ベクトル（solvePnP の初期値に渡す用） */
export function matrixToRodrigues(R: readonly number[]): V3 {
  const trace = R[0] + R[4] + R[8];
  const cosTheta = Math.max(-1, Math.min(1, (trace - 1) / 2));
  const theta = Math.acos(cosTheta);
  if (theta < 1e-9) return [0, 0, 0];
  if (Math.PI - theta < 1e-6) {
    // 180° 付近: 軸は R + I の最大の列から
    const col = [
      [R[0] + 1, R[3], R[6]],
      [R[1], R[4] + 1, R[7]],
      [R[2], R[5], R[8] + 1],
    ].reduce((best, c) => (Math.hypot(c[0], c[1], c[2]) > Math.hypot(best[0], best[1], best[2]) ? c : best));
    const len = Math.hypot(col[0], col[1], col[2]);
    return [(col[0] / len) * theta, (col[1] / len) * theta, (col[2] / len) * theta];
  }
  const k = theta / (2 * Math.sin(theta));
  return [(R[7] - R[5]) * k, (R[2] - R[6]) * k, (R[3] - R[1]) * k];
}

/**
 * OpenCV の姿勢 [R|t]（object 座標系 → OpenCV のカメラ座標系: X 右・Y 下・Z 前）を、
 * three.js のカメラ座標系（X 右・Y 上・-Z 前）での object → camera の 4x4（列優先）に直す。
 * F = diag(1, -1, -1) を左から掛けるだけ（object 側は field 座標系（three.js の規約）で与えているので右からは掛けない。
 * marker-detector.ts の POSIT は「モデルの Z 前」の規約だったので F・M・F だったが、ここでは対応点の側で規約を揃えてある）
 * @param R 行優先 9 要素 @param t [tx, ty, tz]
 */
export function cvPoseToCameraMatrix(R: readonly number[], t: V3): number[] {
  // 列優先: 列 j = (R[0][j], -R[1][j], -R[2][j], 0)
  return [R[0], -R[3], -R[6], 0, R[1], -R[4], -R[7], 0, R[2], -R[5], -R[8], 0, t[0], -t[1], -t[2], 1];
}

/** cvPoseToCameraMatrix の逆（テストと初期値用）: three.js のカメラ座標系での object → camera の 4x4 → OpenCV の R（行優先 9）と t */
export function cameraMatrixToCvPose(m: readonly number[]): { R: number[]; t: V3 } {
  return {
    R: [m[0], m[4], m[8], -m[1], -m[5], -m[9], -m[2], -m[6], -m[10]],
    t: [m[12], -m[13], -m[14]],
  };
}

/**
 * 再投影誤差の平均 [px]。objectPoints（3n）を R, t（OpenCV の規約）と K で投影して imagePoints（2n）と比べる。
 * カメラの後ろに来る点（z <= 0）があれば Infinity
 */
export function reprojectionErrorPx(
  objectPoints: readonly number[],
  imagePoints: readonly number[],
  R: readonly number[],
  t: V3,
  K: readonly number[],
): number {
  const n = objectPoints.length / 3;
  if (n === 0) return Infinity;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const x = objectPoints[i * 3];
    const y = objectPoints[i * 3 + 1];
    const z = objectPoints[i * 3 + 2];
    const cx = R[0] * x + R[1] * y + R[2] * z + t[0];
    const cy = R[3] * x + R[4] * y + R[5] * z + t[1];
    const cz = R[6] * x + R[7] * y + R[8] * z + t[2];
    if (cz <= 0) return Infinity;
    const u = (K[0] * cx) / cz + K[2];
    const v = (K[4] * cy) / cz + K[5];
    sum += Math.hypot(u - imagePoints[i * 2], v - imagePoints[i * 2 + 1]);
  }
  return sum / n;
}

/**
 * マーカーごとの正規化誤差（08 の marker-detector.ts の POSIT と同じ尺度: 4 隅の |du|+|dv| の合計 [px] ÷ 画面上の平均辺長 [px]）。
 * objectPoints / imagePoints は 1 枚 4 点ずつの並び（buildBoard と同じ）、sidesPx はマーカーごとの平均辺長。
 * ?maxPoseError= はこの値で足切りし、HUD の err= もこの値なので 08 の err= と比べられる（POSIT は投影を整数に丸めてから比べるが、ここは丸めない）。
 * カメラの後ろに来る点があればそのマーカーは Infinity
 */
export function markerErrorsL1(
  objectPoints: readonly number[],
  imagePoints: readonly number[],
  sidesPx: readonly number[],
  R: readonly number[],
  t: V3,
  K: readonly number[],
): number[] {
  const out: number[] = [];
  for (let m = 0; m < sidesPx.length; m++) {
    let sum = 0;
    for (let k = 0; k < 4; k++) {
      const i = m * 4 + k;
      const x = objectPoints[i * 3];
      const y = objectPoints[i * 3 + 1];
      const z = objectPoints[i * 3 + 2];
      const cx = R[0] * x + R[1] * y + R[2] * z + t[0];
      const cy = R[3] * x + R[4] * y + R[5] * z + t[1];
      const cz = R[6] * x + R[7] * y + R[8] * z + t[2];
      if (cz <= 0) {
        sum = Infinity;
        break;
      }
      sum += Math.abs((K[0] * cx) / cz + K[2] - imagePoints[i * 2]) + Math.abs((K[4] * cy) / cz + K[5] - imagePoints[i * 2 + 1]);
    }
    out.push(sidesPx[m] > 0 ? sum / sidesPx[m] : Infinity);
  }
  return out;
}

/** ?maxReprojPx= の基準の検出画像の長辺 [px]（08 の既定 detW）。上限はこの解像度での px として指定する */
export const REPROJ_REFERENCE_LONG_PX = 960;
/**
 * ?maxReprojPx= の既定（検出画像の長辺 960px のときの平均再投影誤差 [px]）。正常な配置なら 1〜2px、配置の入力ミス・貼りズレで 5px 超
 * （Node のテストで床の配置を 30cm ずらした board は 640px の画像で 5.2px = 960px 換算 7.8px）
 */
export const DEFAULT_MAX_REPROJ_PX = 4;
/** 実際の検出画像（長辺 detLongPx）での再投影誤差の上限 [px]。誤差の px は画像の解像度に比例するので detW=960 基準の値を換算する */
export function reprojLimitPx(maxReprojPxAt960: number, detLongPx: number): number {
  return (maxReprojPxAt960 * detLongPx) / REPROJ_REFERENCE_LONG_PX;
}

/** 平均（centersAnchor など V3 の配列） */
export function meanV3(points: readonly V3[]): V3 {
  const out: V3 = [0, 0, 0];
  for (const p of points) {
    out[0] += p[0];
    out[1] += p[1];
    out[2] += p[2];
  }
  const n = points.length || 1;
  return [out[0] / n, out[1] / n, out[2] / n];
}

function sub(a: V3, b: V3): V3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
