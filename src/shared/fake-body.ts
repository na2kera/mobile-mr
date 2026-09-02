// Phase 9: デバッグ用の「合成の体」。MediaPipe PoseLandmarker の代わりに、指定した位置に立つ人の
// 33 点を生成する（?fakebody=1）。PC にはカメラに映す人が居ない（ヘッドレスではカメラも無い）ため、
// 「PoseLandmarker が体を返したあと」の経路 —— 3D 化・骨格描画・ピアとの対応づけ・seen の送信 —— を
// ブラウザ上で決定的に確認するための入力源。body-math.ts の回帰テスト（scripts/test-person.mjs）も使う。
// 05 の fake-hands.ts と同じ方針で three.js に依存させない
import { BODY_LANDMARK_COUNT, LEFT_HIP, RIGHT_HIP } from "./body-math.ts";
import type { BodyLandmark } from "./body-math.ts";
import { projectToImage } from "./fake-hands.ts";
import type { Vec3, ViewMapping } from "./hand-math.ts";

/**
 * 直立してカメラの方を向いている大人の体（実寸 [m]）。腰の中点が原点、y は上、z はカメラから
 * 遠ざかる向きが +（MediaPipe の worldLandmarks と同じ）。x は「本人の左」が +（カメラに向き合って
 * いるので画像では右に映る）。目は腰から約 0.75m 上（身長 1.7m 相当）
 */
export function syntheticBodyShape(): Vec3[] {
  const p: Vec3[] = new Array(BODY_LANDMARK_COUNT);
  const L = (i: number, x: number, y: number, z: number) => {
    p[i] = { x, y, z };
  };
  L(0, 0, 0.72, -0.08); // nose
  L(1, 0.02, 0.75, -0.06); // left eye inner
  L(2, 0.035, 0.75, -0.06); // left eye
  L(3, 0.05, 0.75, -0.055); // left eye outer
  L(4, -0.02, 0.75, -0.06); // right eye inner
  L(5, -0.035, 0.75, -0.06); // right eye
  L(6, -0.05, 0.75, -0.055); // right eye outer
  L(7, 0.08, 0.73, 0); // left ear
  L(8, -0.08, 0.73, 0); // right ear
  L(9, 0.02, 0.68, -0.07); // mouth left
  L(10, -0.02, 0.68, -0.07); // mouth right
  L(11, 0.18, 0.5, 0); // left shoulder
  L(12, -0.18, 0.5, 0); // right shoulder
  L(13, 0.22, 0.25, 0.02); // left elbow
  L(14, -0.22, 0.25, 0.02); // right elbow
  L(15, 0.24, 0.0, 0.0); // left wrist
  L(16, -0.24, 0.0, 0.0); // right wrist
  L(17, 0.26, -0.08, 0.0); // left pinky
  L(18, -0.26, -0.08, 0.0); // right pinky
  L(19, 0.24, -0.09, -0.02); // left index
  L(20, -0.24, -0.09, -0.02); // right index
  L(21, 0.22, -0.05, -0.03); // left thumb
  L(22, -0.22, -0.05, -0.03); // right thumb
  L(23, 0.09, 0, 0); // left hip
  L(24, -0.09, 0, 0); // right hip
  L(25, 0.1, -0.45, 0.01); // left knee
  L(26, -0.1, -0.45, 0.01); // right knee
  L(27, 0.1, -0.85, 0.02); // left ankle
  L(28, -0.1, -0.85, 0.02); // right ankle
  L(29, 0.1, -0.9, 0.05); // left heel
  L(30, -0.1, -0.9, 0.05); // right heel
  L(31, 0.1, -0.9, -0.1); // left foot index
  L(32, -0.1, -0.9, -0.1); // right foot index
  return p;
}

/** 腰の中点（worldLandmarks の原点）から両目の中点までのオフセット（y 上）。ピアの頭に合わせて置くときに使う */
export function eyesAboveHip(shapeYUp: readonly Vec3[]): Vec3 {
  const a = shapeYUp[2];
  const b = shapeYUp[5];
  const hip = { x: (shapeYUp[LEFT_HIP].x + shapeYUp[RIGHT_HIP].x) / 2, y: (shapeYUp[LEFT_HIP].y + shapeYUp[RIGHT_HIP].y) / 2, z: (shapeYUp[LEFT_HIP].z + shapeYUp[RIGHT_HIP].z) / 2 };
  return { x: (a.x + b.x) / 2 - hip.x, y: (a.y + b.y) / 2 - hip.y, z: (a.z + b.z) / 2 - hip.z };
}

/** MediaPipe の PoseLandmarkerResult と同じ形（使う部分だけ） */
export type FakePoseResult = {
  landmarks: BodyLandmark[][];
  worldLandmarks: BodyLandmark[][];
};

export type FakeBody = {
  shapeYUp: readonly Vec3[];
  /** 腰の中点（worldLandmarks の原点）のカメラ座標系での位置 */
  hip: Vec3;
};

/**
 * 「カメラ座標系で腰をここに、この形で」→ MediaPipe 形式の結果に変換する（複数人）。
 * カメラの後ろに回った点は投影できないので visibility 0 にする（画像座標は中央）
 */
export function fakePoseResult(bodies: readonly FakeBody[], m: ViewMapping): FakePoseResult {
  const landmarks: BodyLandmark[][] = [];
  const worldLandmarks: BodyLandmark[][] = [];
  for (const { shapeYUp, hip } of bodies) {
    // 形状（y 上）→ worldLandmarks（y 下・腰原点はそのまま）
    const world: BodyLandmark[] = shapeYUp.map((p) => ({ x: p.x, y: -p.y, z: p.z, visibility: 1 }));
    const img: BodyLandmark[] = [];
    for (const w of world) {
      const cam = { x: hip.x + w.x, y: hip.y - w.y, z: hip.z - w.z };
      const proj = projectToImage(cam, m);
      img.push(proj ? { x: proj.x, y: proj.y, z: w.z - world[LEFT_HIP].z, visibility: 1 } : { x: 0.5, y: 0.5, z: 0, visibility: 0 });
    }
    landmarks.push(img);
    worldLandmarks.push(world);
  }
  return { landmarks, worldLandmarks };
}
