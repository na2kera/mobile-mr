// Phase 9: MediaPipe PoseLandmarker の全身 33 点を three.js のカメラ座標系へ変換する純粋関数群。
// 05 の hand-math.ts と同じ考え方（worldLandmarks の実寸の形を、画像上の見え方に当てはめて
// カメラからの並進を最小二乗で解く）を体に流用する。three.js に依存させない
// （Node の回帰テスト scripts/test-person.mjs から import する）
import { MIN_DEPTH_M, imageToRay, placeLandmarks, solveHandPlacement } from "./hand-math.ts";
import type { HandPlacement, Vec3, ViewMapping } from "./hand-math.ts";

/** MediaPipe の Landmark（visibility 付き。手のときは 0 が入っているので省略可にしておく） */
export type BodyLandmark = Vec3 & { visibility?: number };

// ---- MediaPipe PoseLandmarker の 33 点（index の意味） ----
export const NOSE = 0;
export const LEFT_EYE_INNER = 1;
export const LEFT_EYE = 2;
export const LEFT_EYE_OUTER = 3;
export const RIGHT_EYE_INNER = 4;
export const RIGHT_EYE = 5;
export const RIGHT_EYE_OUTER = 6;
export const LEFT_EAR = 7;
export const RIGHT_EAR = 8;
export const MOUTH_LEFT = 9;
export const MOUTH_RIGHT = 10;
export const LEFT_SHOULDER = 11;
export const RIGHT_SHOULDER = 12;
export const LEFT_ELBOW = 13;
export const RIGHT_ELBOW = 14;
export const LEFT_WRIST = 15;
export const RIGHT_WRIST = 16;
export const LEFT_PINKY = 17;
export const RIGHT_PINKY = 18;
export const LEFT_INDEX = 19;
export const RIGHT_INDEX = 20;
export const LEFT_THUMB = 21;
export const RIGHT_THUMB = 22;
export const LEFT_HIP = 23;
export const RIGHT_HIP = 24;
export const LEFT_KNEE = 25;
export const RIGHT_KNEE = 26;
export const LEFT_ANKLE = 27;
export const RIGHT_ANKLE = 28;
export const LEFT_HEEL = 29;
export const RIGHT_HEEL = 30;
export const LEFT_FOOT_INDEX = 31;
export const RIGHT_FOOT_INDEX = 32;
export const BODY_LANDMARK_COUNT = 33;

/** 骨格描画用の接続（MediaPipe の PoseLandmarker.POSE_CONNECTIONS と同じ 35 本） */
export const BODY_CONNECTIONS: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 7], [0, 4], [4, 5], [5, 6], [6, 8], [9, 10],
  [11, 12], [11, 13], [13, 15], [15, 17], [15, 19], [15, 21], [17, 19],
  [12, 14], [14, 16], [16, 18], [16, 20], [16, 22], [18, 20],
  [11, 23], [12, 24], [23, 24], [23, 25], [24, 26], [25, 27], [26, 28],
  [27, 29], [28, 30], [29, 31], [30, 32], [27, 31], [28, 32],
];

/** 並進を解くのに最低限必要な可視点の数（3 未満は退化。少なすぎると深度が暴れる） */
export const MIN_VISIBLE_POINTS = 6;

export type BodyPlacement = HandPlacement & {
  /** 解くのに使った可視点の数 */
  used: number;
};

/** worldLandmarks の実寸補正（05 の handScale と同じ役割。1 で補正なし） */
export function scaleBody(world: readonly BodyLandmark[], scale: number): BodyLandmark[] {
  if (scale === 1) return [...world];
  return world.map((w) => ({ x: w.x * scale, y: w.y * scale, z: w.z * scale, visibility: w.visibility }));
}

/**
 * 体の「カメラからの位置」を推定する。hand-math.ts の solveHandPlacement と同じ式で、
 * MediaPipe が visibility の低い点（画面外・遮蔽）も座標を返してくるので、それを除いてから解く。
 * worldLandmarks の原点は腰の中点（両股関節の中点）、単位 m
 *
 * @returns 可視点が足りない・深度が正で有限でなければ null
 */
export function solveBodyPlacement(
  landmarks: readonly BodyLandmark[],
  world: readonly BodyLandmark[],
  m: ViewMapping,
  minVisibility: number,
): BodyPlacement | null {
  const n = Math.min(landmarks.length, world.length);
  const li: BodyLandmark[] = [];
  const wi: BodyLandmark[] = [];
  for (let i = 0; i < n; i++) {
    if (visibilityOf(landmarks[i]) < minVisibility || visibilityOf(world[i]) < minVisibility) continue;
    li.push(landmarks[i]);
    wi.push(world[i]);
  }
  if (li.length < MIN_VISIBLE_POINTS) return null;
  const p = solveHandPlacement(li, wi, m);
  if (!p) return null;
  return { ...p, used: li.length };
}

function visibilityOf(l: BodyLandmark): number {
  return l.visibility ?? 1;
}

/**
 * 33 点をカメラ座標系（three: x 右・y 上・z 手前、原点 = カメラ）へ置く。
 * 各点は「画像上の位置の視線方向」に沿って、深度 = 体の深度 + その点の相対深度の所（hand-math の placeLandmarks と同じ）
 */
export function placeBodyLandmarks(
  landmarks: readonly BodyLandmark[],
  world: readonly BodyLandmark[],
  placement: BodyPlacement,
  m: ViewMapping,
): Vec3[] {
  return placeLandmarks(landmarks, world, placement, m);
}

/**
 * 頭の位置（カメラ座標系）: 両目の中点。ネットワーク上のピアの pose は「相手のカメラ（= ゴーグルの
 * スマホ ≈ 目の位置）」なので、対応づけの比較点は目にする。目が見えていなければ両耳、それも無ければ鼻。
 * placed は placeBodyLandmarks の結果（33 点すべて座標を持つ）、landmarks は visibility の判定用
 */
export function bodyHeadPoint(
  placed: readonly Vec3[],
  landmarks: readonly BodyLandmark[],
  minVisibility: number,
): Vec3 {
  const pairs: [number, number][] = [
    [LEFT_EYE, RIGHT_EYE],
    [LEFT_EAR, RIGHT_EAR],
  ];
  for (const [a, b] of pairs) {
    if (visibilityOf(landmarks[a]) >= minVisibility && visibilityOf(landmarks[b]) >= minVisibility) {
      return mid(placed[a], placed[b]);
    }
  }
  return { ...placed[NOSE] };
}

function mid(a: Vec3, b: Vec3): Vec3 {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
}

/**
 * 画像の正規化座標（体の中心など）→ カメラ座標系での方向（深度 1 の平面上）。
 * imageToRay の再エクスポート（デモ側が hand-math を意識しなくて済むように）
 */
export { imageToRay, MIN_DEPTH_M };
