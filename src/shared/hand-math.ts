// Phase 5: MediaPipe の手ランドマークを three.js のカメラ座標系へ変換する純粋関数群。
// three.js に依存させない（Node の回帰テスト scripts/test-hand-math.mjs から
// そのまま import して、座標変換の式だけを検証するため。実機でしか動かない
// MediaPipe 部分と切り離しておく）

export type Vec3 = { x: number; y: number; z: number };

// ---- MediaPipe HandLandmarker の 21 点（index の意味） ----
export const WRIST = 0;
export const THUMB_TIP = 4;
export const INDEX_MCP = 5;
export const MIDDLE_MCP = 9;
export const PINKY_MCP = 17;
export const INDEX_PIP = 6;
export const INDEX_TIP = 8;
export const MIDDLE_PIP = 10;
export const MIDDLE_TIP = 12;
export const RING_PIP = 14;
export const RING_TIP = 16;
export const PINKY_PIP = 18;
export const PINKY_TIP = 20;
export const LANDMARK_COUNT = 21;

/** 5本の指先（親指・人差し指・中指・薬指・小指） */
export const FINGER_TIPS: readonly number[] = [
  THUMB_TIP,
  INDEX_TIP,
  MIDDLE_TIP,
  RING_TIP,
  PINKY_TIP,
];

/** 骨格描画用の接続（MediaPipe の HAND_CONNECTIONS と同じ 21 本） */
export const HAND_CONNECTIONS: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 4],
  [0, 5],
  [5, 6],
  [6, 7],
  [7, 8],
  [5, 9],
  [9, 10],
  [10, 11],
  [11, 12],
  [9, 13],
  [13, 14],
  [14, 15],
  [15, 16],
  [13, 17],
  [17, 18],
  [18, 19],
  [19, 20],
  [0, 17],
];

/**
 * 「画像のどこに映っているか」→「仮想カメラから見てどの方向か」の対応。
 * パススルー背景は映像を片目ビューポートに cover 切り抜き（texture.repeat/offset）で
 * 貼っているので、その逆変換 + 仮想カメラの FOV で方向が決まる。
 * 実カメラの FOV（機種ごとに違い、ブラウザからは取得できない。PAIN_POINTS 参照）には
 * 依存させない: 背景に映っている手の真上に骨格が重なることを優先し、
 * 仮想 FOV が現実とズレていても「背景と仮想物体が同じだけズレる」ようにする
 */
export type ViewMapping = {
  /** 仮想カメラの垂直 FOV の半分の tan */
  tanHalfFov: number;
  /** 片目ビューポートのアスペクト比（幅 / 高さ） */
  eyeAspect: number;
  /** 背景テクスチャの repeat（cover 切り抜き後に残る割合。updateBackgroundCover と同じ値） */
  repeatX: number;
  repeatY: number;
};

/**
 * 画像の正規化座標（0..1、y は下向き）→ カメラ座標系で深度 1 の平面上の点（x 右・y 上）。
 * 深度 d にある点は (x*d, y*d, -d) になる
 */
export function imageToRay(
  nx: number,
  ny: number,
  m: ViewMapping,
): { x: number; y: number } {
  // 画像座標 → テクスチャ UV（three の VideoTexture は flipY なので v は上向き）
  // → 片目ビューポートの NDC（背景は offset + uv*repeat で貼られているので逆算）
  const sx = ((nx - 0.5) * 2) / m.repeatX;
  const sy = ((1 - ny - 0.5) * 2) / m.repeatY;
  return { x: sx * m.tanHalfFov * m.eyeAspect, y: sy * m.tanHalfFov };
}

/** 置ける最小深度 [m]。これより手前は描画側の near で切れる（main.ts の camera.near と合わせる） */
export const MIN_DEPTH_M = 0.05;

export type HandPlacement = {
  /** 手の中心（worldLandmarks の原点）のカメラ座標系での位置 [m]（x 右・y 上） */
  x: number;
  y: number;
  /** カメラからの深度 [m]（正。three の z は -depth） */
  depth: number;
  /** 最小二乗の残差 RMS（深度 1 の平面上の長さ。大きいほど形と見え方が合っていない） */
  residual: number;
};

/**
 * 手の「カメラからの位置」を推定する。
 *
 * MediaPipe が返すのは「画像上の位置（正規化 2D）」と「手の中心を原点とした実寸 3D
 * （worldLandmarks, m 単位）」で、カメラからの絶対距離は返さない。そこで worldLandmarks の
 * 形を、画像上の見え方（各点の視線方向）に当てはめて、手の中心の並進 (X, Y, D) を解く。
 *
 * 各点 i（視線方向 (u_i, v_i) = imageToRay、実寸 (wx_i, wy_i, wz_i)）について
 *   u_i * (D + wz_i) = X + wx_i
 *   v_i * (D + wz_i) = Y - wy_i      （画像系の y は下向きなので符号反転。
 *                                     wz は「カメラから遠いほど大きい」= 深度と同じ向き）
 * これは X, Y, D について線形:
 *   X - u_i * D = u_i * wz_i - wx_i
 *   Y - v_i * D = v_i * wz_i + wy_i
 * 42 本の式を正規方程式（3x3）で最小二乗する。
 *
 * 前提: worldLandmarks の軸が画像の軸と揃っている（MediaPipe は手の向きに合わせた
 * クロップで推定した 3D を画像の向きに戻して返す）。手の回転は worldLandmarks に
 * 含まれているので並進だけ解けばよい。
 *
 * @returns 深度が正で有限でなければ null（退化・誤検出）
 */
export function solveHandPlacement(
  landmarks: readonly Vec3[],
  world: readonly Vec3[],
  m: ViewMapping,
): HandPlacement | null {
  const n = Math.min(landmarks.length, world.length);
  if (n < 3) return null;
  // 正規方程式 AtA p = Atb（p = [X, Y, D]）。行は [1, 0, -u] と [0, 1, -v]
  let su = 0;
  let sv = 0;
  let suv2 = 0;
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  const rays: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i++) {
    const r = imageToRay(landmarks[i].x, landmarks[i].y, m);
    rays.push(r);
    const w = world[i];
    const rhs0 = r.x * w.z - w.x;
    const rhs1 = r.y * w.z + w.y;
    su += r.x;
    sv += r.y;
    suv2 += r.x * r.x + r.y * r.y;
    b0 += rhs0;
    b1 += rhs1;
    b2 += -r.x * rhs0 - r.y * rhs1;
  }
  const p = solve3(
    [
      [n, 0, -su],
      [0, n, -sv],
      [-su, -sv, suv2],
    ],
    [b0, b1, b2],
  );
  if (!p) return null;
  const [x, y, depth] = p;
  if (!Number.isFinite(depth) || depth <= 0) return null;
  // 残差: 各点の視線方向と、解いた位置から計算した方向との差
  let ss = 0;
  for (let i = 0; i < n; i++) {
    const w = world[i];
    const d = depth + w.z;
    if (d <= 0) return null;
    const du = (x + w.x) / d - rays[i].x;
    const dv = (y - w.y) / d - rays[i].y;
    ss += du * du + dv * dv;
  }
  return { x, y, depth, residual: Math.sqrt(ss / n) };
}

/** 3x3 連立一次方程式を部分ピボット付きガウス消去で解く。特異なら null */
function solve3(a: number[][], b: number[]): number[] | null {
  const m = a.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < 3; col++) {
    let pivot = col;
    for (let r = col + 1; r < 3; r++) {
      if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    }
    if (Math.abs(m[pivot][col]) < 1e-12) return null;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const f = m[r][col] / m[col][col];
      for (let c = col; c < 4; c++) m[r][c] -= f * m[col][c];
    }
  }
  return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
}

/**
 * 21 点をカメラ座標系（three: x 右・y 上・z 手前、原点 = カメラ）へ置く。
 * 各点は「画像上の位置の視線方向」に沿って、深度 = 手の深度 + その点の相対深度
 * （worldLandmarks の z）の所に置く。x/y を視線方向から取るので、背景に映っている
 * 実際の手の上に骨格が重なる（解いた X/Y ではなく画像位置を優先する）。
 * 厳密に重なるのは中心カメラで見たときで、左右の目（StereoEffect の eyeSep 分の
 * 平行移動）では骨格だけが実深度の視差を持ち、視差ゼロの背景から少しずれる。
 * これは単眼パススルーの構造的な限界（CONCEPT.md Phase 5 の既知の制約を参照）
 */
export function placeLandmarks(
  landmarks: readonly Vec3[],
  world: readonly Vec3[],
  placement: HandPlacement,
  m: ViewMapping,
): Vec3[] {
  const out: Vec3[] = [];
  const n = Math.min(landmarks.length, world.length);
  for (let i = 0; i < n; i++) {
    const r = imageToRay(landmarks[i].x, landmarks[i].y, m);
    // 相対深度で手前側に出過ぎても、カメラの裏側には回さない（main.ts の camera.near と同じ値）
    const d = Math.max(MIN_DEPTH_M, placement.depth + world[i].z);
    out.push({ x: r.x * d, y: r.y * d, z: -d });
  }
  return out;
}

function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/**
 * 指が伸びているか: 指先が第二関節（PIP）より手首から遠ければ伸びている、
 * 近ければ曲がっている。どちらとも言えない中間（±閾値内）は両方 false
 */
export function fingerExtended(
  world: readonly Vec3[],
  pip: number,
  tip: number,
): boolean {
  return dist(world[tip], world[WRIST]) - dist(world[pip], world[WRIST]) > 0.015;
}

export function fingerCurled(
  world: readonly Vec3[],
  pip: number,
  tip: number,
): boolean {
  return dist(world[tip], world[WRIST]) - dist(world[pip], world[WRIST]) < 0.005;
}

/**
 * 指差しポーズか: 人差し指だけ伸びていて、中指・薬指・小指が曲がっている
 * （親指は人によって開き方が違うので見ない）。実寸の worldLandmarks で判定するので
 * 手の大きさ・カメラからの距離に依存しない
 */
export function isPointingPose(world: readonly Vec3[]): boolean {
  if (world.length < LANDMARK_COUNT) return false;
  return (
    fingerExtended(world, INDEX_PIP, INDEX_TIP) &&
    fingerCurled(world, MIDDLE_PIP, MIDDLE_TIP) &&
    fingerCurled(world, RING_PIP, RING_TIP) &&
    fingerCurled(world, PINKY_PIP, PINKY_TIP)
  );
}

/** 4 指（人差し指〜小指）がすべて曲がっている = グー（親指は見ない） */
export function isFistPose(world: readonly Vec3[]): boolean {
  if (world.length < LANDMARK_COUNT) return false;
  return (
    fingerCurled(world, INDEX_PIP, INDEX_TIP) &&
    fingerCurled(world, MIDDLE_PIP, MIDDLE_TIP) &&
    fingerCurled(world, RING_PIP, RING_TIP) &&
    fingerCurled(world, PINKY_PIP, PINKY_TIP)
  );
}

/** 4 指がすべて伸びている = パー */
export function isOpenPose(world: readonly Vec3[]): boolean {
  if (world.length < LANDMARK_COUNT) return false;
  return (
    fingerExtended(world, INDEX_PIP, INDEX_TIP) &&
    fingerExtended(world, MIDDLE_PIP, MIDDLE_TIP) &&
    fingerExtended(world, RING_PIP, RING_TIP) &&
    fingerExtended(world, PINKY_PIP, PINKY_TIP)
  );
}

export type HandShape = "fist" | "open" | "point" | "other";

/** 手の形（排他）。08 のチャージ（グー）→ 発射（パー）が使う */
export function handShape(world: readonly Vec3[]): HandShape {
  if (isFistPose(world)) return "fist";
  if (isOpenPose(world)) return "open";
  if (isPointingPose(world)) return "point";
  return "other";
}
