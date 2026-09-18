// AprilTag（apriltag C ライブラリの estimate_tag_pose）が返す姿勢 R, t を、08 の marker-detector.ts と同じ
// 「three.js のカメラ座標系でのマーカーの姿勢（Matrix4）」に直す純粋な数学。three.js に依存させない
// （Node の回帰テスト scripts/test-08-5-apriltag.mjs で往復テストするため。行列は Matrix4.elements と同じ列優先 16 要素）。
//
// 座標系（apriltag_pose.h）:
//   - カメラ座標系 C_a: 原点はカメラ中心。X = 画像の右、Y = 画像の下、Z = レンズの前方（奥）
//   - タグ座標系 T_a: 原点はタグの中心。X = タグの右、Y = タグの下、Z = タグの面に垂直で「奥」（視点から離れる向き）
//   - p_Ca = R・p_Ta + t（t の単位はタグの実寸と同じ = メートル）
// 08 の規約（marker-detector.ts の MarkerObservation.matrix）:
//   - カメラ座標系 C_t（three.js）: X 右・Y 上・-Z 前方 → p_Ct = F・p_Ca、F = diag(1, -1, -1)
//   - マーカー座標系 M: X = マーカー右・Y = マーカー上・+Z = 面から視点側 → p_Ta = F・p_M（Y と Z を反転）
//   よって p_Ct = F・(R・F・p_M + t) = (F・R・F)・p_M + F・t。F・R・F は「行 1,2 と列 1,2 のどちらか一方だけが含まれる要素」の符号反転
//   （js-aruco2 の POSIT は Y 上の画像座標で計算するので F = diag(1, 1, -1) だった。ここが一番間違えやすい）
// JSON の R は apriltag_js.c が「列優先」で書く（R[j][i] = R の i 行 j 列）。t は [t0, t1, t2]

export type Vec3 = [number, number, number];
export type Vec2 = [number, number];

/**
 * AprilTag の姿勢（JSON の R = 列優先の 3×3、t）→ マーカー座標系 → three.js カメラ座標系 の 4×4（列優先 16 要素）
 * @param rColumns apriltag_js.c の JSON の "R"（rColumns[j][i] = R の i 行 j 列）
 * @param t apriltag_js.c の JSON の "t"
 */
export function aprilPoseToMatrix(rColumns: readonly (readonly number[])[], t: readonly number[]): number[] {
  const R = (i: number, j: number) => rColumns[j][i];
  const F = [1, -1, -1];
  const out = new Array<number>(16).fill(0);
  for (let col = 0; col < 3; col++) {
    for (let row = 0; row < 3; row++) {
      out[col * 4 + row] = F[row] * R(row, col) * F[col];
    }
  }
  out[12] = t[0];
  out[13] = -t[1];
  out[14] = -t[2];
  out[15] = 1;
  return out;
}

/**
 * 逆変換（テスト用）: three.js 規約の 4×4（列優先）→ AprilTag の R（列優先の 3×3）と t。
 * aprilPoseToMatrix(aprilPoseFromMatrix(m)) = m
 */
export function aprilPoseFromMatrix(m: readonly number[]): { R: number[][]; t: Vec3 } {
  const F = [1, -1, -1];
  const R: number[][] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let col = 0; col < 3; col++) {
    for (let row = 0; row < 3; row++) {
      // 同じ F で挟むと元に戻る（F・F = I）
      R[col][row] = F[row] * m[col * 4 + row] * F[col];
    }
  }
  return { R, t: [m[12], -m[13], -m[14]] };
}

/**
 * マーカー（黒い正方形。一辺 sizeM）の 4 隅をマーカー座標系で返す。順序は AprilTag の検出結果 corners[0..3] と同じ:
 * 左下 → 右下 → 右上 → 左上（apriltag.c: タグ座標 (-1,+1), (1,1), (1,-1), (-1,-1) で Y 下向き。マーカー座標系は Y 上なので左下から）
 */
export function markerCornersLocal(sizeM: number): Vec3[] {
  const h = sizeM / 2;
  return [
    [-h, -h, 0],
    [h, -h, 0],
    [h, h, 0],
    [-h, h, 0],
  ];
}

/** 点に 4×4（列優先）を掛ける（w = 1） */
export function applyMatrix(m: readonly number[], p: Vec3): Vec3 {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}

/**
 * three.js カメラ座標系の点をピンホールで画像座標（左上原点・Y 下）へ。カメラの後ろ（Z >= 0）なら null。
 * 検出画像の主点は画像の中心（cx, cy）、焦点距離は fx = fy = focalPx（08 と同じ「水平 FOV からの換算」）
 */
export function projectPoint(p: Vec3, focalPx: number, cx: number, cy: number): Vec2 | null {
  if (p[2] >= -1e-6) return null;
  return [cx + (focalPx * p[0]) / -p[2], cy - (focalPx * p[1]) / -p[2]];
}

/** マーカーの 4 隅を画像へ投影する（順序は markerCornersLocal と同じ）。どれかがカメラの後ろなら null */
export function projectMarkerCorners(matrix: readonly number[], sizeM: number, focalPx: number, cx: number, cy: number): Vec2[] | null {
  const out: Vec2[] = [];
  for (const c of markerCornersLocal(sizeM)) {
    const q = projectPoint(applyMatrix(matrix, c), focalPx, cx, cy);
    if (!q) return null;
    out.push(q);
  }
  return out;
}

/** 4 隅（画像座標）の平均辺長 [px]（08 の MarkerObservation.sidePx と同じ定義） */
export function sidePxOf(corners: readonly { x: number; y: number }[]): number {
  let perimeter = 0;
  for (let i = 0; i < 4; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % 4];
    perimeter += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return perimeter / 4;
}

/**
 * 正規化再投影誤差（08 の MarkerObservation.error と同じ流儀: ピクセル誤差の和 ÷ 平均辺長）。
 * 姿勢で 4 隅を投影し直し、検出した 4 隅との距離の和を辺長で割る。きれいな検出で 0.0x、姿勢と座標系の変換が
 * 合っていなければ 1 前後になるので、変換の間違いにも気づける。投影できなければ Infinity
 */
export function normalizedReprojectionError(
  matrix: readonly number[],
  corners: readonly { x: number; y: number }[],
  sizeM: number,
  focalPx: number,
  cx: number,
  cy: number,
): number {
  const proj = projectMarkerCorners(matrix, sizeM, focalPx, cx, cy);
  const side = sidePxOf(corners);
  if (!proj || !(side > 0)) return Infinity;
  let sum = 0;
  for (let i = 0; i < 4; i++) sum += Math.hypot(proj[i][0] - corners[i].x, proj[i][1] - corners[i].y);
  return sum / side;
}

/** 焦点距離 [px]（08 の marker-anchor.ts と同じ換算: 長辺 / 2 / tan(水平 FOV / 2)） */
export function focalPxFromFov(longSidePx: number, hFovDeg: number): number {
  return longSidePx / 2 / Math.tan((hFovDeg * Math.PI) / 180 / 2);
}
