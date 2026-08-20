// Phase 5: デバッグ用の「合成の手」。MediaPipe の代わりに台本どおりに動く手の
// ランドマークを生成する（?fakehands=1）。PC にはカメラに映す手が無い（ヘッドレスでは
// そもそもカメラが無い）ため、「MediaPipe が手を返したあと」の経路 —— 3D 化・骨格描画・
// ボール/ボタン/指差しの判定 —— をブラウザ上で決定的に確認するための入力源。
// hand-math.ts の回帰テスト（scripts/test-hand-math.mjs）も同じ形状生成を使う。
// three.js に依存させない（Node から import するため）。import に .ts を付けているのも
// Node の ESM 解決のため（Vite/TS は拡張子なしでも解決するが、Node は付けないと見つけられない）
import { LANDMARK_COUNT } from "./hand-math.ts";
import type { Vec3, ViewMapping } from "./hand-math.ts";

export type HandPose = "open" | "point" | "fist";

/**
 * 手の形状（実寸 [m]）。手首が原点、指は +y（上）方向、z は手のひらの法線方向（+ が奥）。
 * 大人の手の概算値。MediaPipe の worldLandmarks に渡すときは y を反転する（画像系は下向き）
 */
export function syntheticHandShape(pose: HandPose): Vec3[] {
  const p: Vec3[] = new Array(LANDMARK_COUNT);
  p[0] = { x: 0, y: 0, z: 0 }; // wrist
  // 親指: 横へ広げる
  p[1] = { x: -0.03, y: 0.02, z: 0.01 };
  p[2] = { x: -0.055, y: 0.04, z: 0.015 };
  p[3] = { x: -0.07, y: 0.06, z: 0.02 };
  p[4] = { x: -0.08, y: 0.075, z: 0.025 };
  // [MCP の index, x, MCP の y, 関節ピッチ]
  const fingers: [number, number, number, number][] = [
    [5, -0.025, 0.085, 0.04], // index
    [9, 0.0, 0.09, 0.045], // middle
    [13, 0.025, 0.085, 0.04], // ring
    [17, 0.05, 0.075, 0.03], // pinky
  ];
  for (const [base, x, y0, pitch] of fingers) {
    const curl =
      pose === "fist" || (pose === "point" && base !== 5);
    for (let k = 0; k < 4; k++) {
      if (curl && k >= 2) {
        // DIP・TIP を手のひら側へ折る（指先は PIP より手首に近くなる）
        p[base + k] = { x, y: y0 + (k === 2 ? 0.01 : -0.01), z: k === 2 ? 0.03 : 0.035 };
      } else {
        p[base + k] = { x, y: y0 + pitch * k, z: -0.005 * k };
      }
    }
  }
  return p;
}

/** 重心を原点へ（MediaPipe の worldLandmarks は手の中心が原点） */
export function centered(points: readonly Vec3[]): Vec3[] {
  const c = { x: 0, y: 0, z: 0 };
  for (const p of points) {
    c.x += p.x / points.length;
    c.y += p.y / points.length;
    c.z += p.z / points.length;
  }
  return points.map((p) => ({ x: p.x - c.x, y: p.y - c.y, z: p.z - c.z }));
}

/**
 * imageToRay の逆: カメラ座標系の点（x 右・y 上・z 手前 = 負）→ 画像の正規化座標（y 下向き）。
 * カメラより手前（z >= 0）の点は投影できないので null
 */
export function projectToImage(
  p: Vec3,
  m: ViewMapping,
): { x: number; y: number } | null {
  const depth = -p.z;
  if (!(depth > 0)) return null;
  const sx = p.x / depth / (m.tanHalfFov * m.eyeAspect);
  const sy = p.y / depth / m.tanHalfFov;
  return {
    x: 0.5 + (sx * m.repeatX) / 2,
    y: 1 - (0.5 + (sy * m.repeatY) / 2),
  };
}

/** MediaPipe の HandLandmarkerResult と同じ形（使う部分だけ） */
export type FakeHandResult = {
  landmarks: Vec3[][];
  worldLandmarks: Vec3[][];
  handedness: { categoryName: string; score: number }[][];
};

/**
 * 「カメラ座標系で手の中心をここに、この形で」→ MediaPipe 形式の結果に変換する。
 * @param center 手の中心（worldLandmarks の原点）のカメラ座標系での位置
 * @param handedness MediaPipe が返す値（鏡像前提なので、背面カメラでは左右が逆に見える）
 */
export function fakeHandResult(
  shapeYUp: readonly Vec3[],
  center: Vec3,
  m: ViewMapping,
  handedness: "Left" | "Right" = "Left",
): FakeHandResult {
  // 形状（y 上）→ worldLandmarks（y 下・重心原点）
  const world = centered(shapeYUp).map((p) => ({ x: p.x, y: -p.y, z: p.z }));
  const landmarks: Vec3[] = [];
  for (const w of world) {
    const cam = { x: center.x + w.x, y: center.y - w.y, z: center.z - w.z };
    const img = projectToImage(cam, m) ?? { x: 0.5, y: 0.5 };
    landmarks.push({ x: img.x, y: img.y, z: w.z - world[0].z });
  }
  return {
    landmarks: [landmarks],
    worldLandmarks: [world],
    handedness: [[{ categoryName: handedness, score: 0.99 }]],
  };
}

/**
 * 台本: 12 秒周期で 4 場面を繰り返す。
 *   0〜3 秒: 開いた手が左から右へボールの位置（カメラ座標 ballCam）を通過する
 *   3〜6 秒: 開いた手が手前から奥へ進み、人差し指の先がボタン（buttonCam）を通過する
 *   6〜10 秒: 指差しポーズで、人差し指の先を「視点 → 的（targetCam）」の線上に止める
 *   10〜12 秒: 手を出さない（ロスト → 非表示の経路）
 * 戻り値が null のときは手が見えていない
 */
export function scriptedHand(
  tSec: number,
  scene: { ballCam: Vec3; buttonCam: Vec3; targetCam: Vec3 },
  m: ViewMapping,
): FakeHandResult | null {
  const t = tSec % 12;
  const open = syntheticHandShape("open");
  const point = syntheticHandShape("point");
  // 重心 → 人差し指の先のオフセット（カメラ座標系。y は形状のまま上向き）
  const tipOffset = (shape: readonly Vec3[]): Vec3 => {
    const c = centered(shape)[8];
    return { x: c.x, y: c.y, z: -c.z };
  };
  if (t < 3) {
    const k = t / 3;
    const center = {
      x: scene.ballCam.x - 0.25 + 0.5 * k,
      y: scene.ballCam.y,
      z: scene.ballCam.z,
    };
    return fakeHandResult(open, center, m);
  }
  if (t < 6) {
    const k = (t - 3) / 3;
    const off = tipOffset(open);
    const center = {
      x: scene.buttonCam.x - off.x,
      y: scene.buttonCam.y - off.y,
      z: scene.buttonCam.z + 0.12 - 0.24 * k - off.z,
    };
    return fakeHandResult(open, center, m);
  }
  if (t < 10) {
    const off = tipOffset(point);
    // 指先を「原点 → 的」の線上、深度 0.45m の所に置く
    const s = 0.45 / -scene.targetCam.z;
    const tip = {
      x: scene.targetCam.x * s,
      y: scene.targetCam.y * s,
      z: scene.targetCam.z * s,
    };
    const center = { x: tip.x - off.x, y: tip.y - off.y, z: tip.z - off.z };
    return fakeHandResult(point, center, m);
  }
  return null;
}
