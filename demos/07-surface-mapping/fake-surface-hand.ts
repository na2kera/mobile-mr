// Phase 7: デバッグ用の「合成の手」（?fakehands=1）。指差しポーズで、人差し指の先を
// 「視点 → Surface 上の目標点」の視線上（深度 0.45m）に置く。目標点は main.ts が Surface の UV で
// 円を描くように動かして渡す（05 の scriptedHand の指差し場面をペイント用にしたもの）。
// MediaPipe 抜きで「指差し → 視線と Surface の交点 → paint 送信 → 全員に配信」を PC で回す入力源
import { centered, fakeHandResult, syntheticHandShape } from "../../src/shared/fake-hands";
import type { FakeHandResult } from "../../src/shared/fake-hands";
import { INDEX_TIP } from "../../src/shared/hand-math";
import type { Vec3, ViewMapping } from "../../src/shared/hand-math";

const TIP_DEPTH_M = 0.45;

/**
 * @param targetCam 指したい点（カメラ座標系）。null なら開いた手を定位置に出す（ペイントしない）
 */
export function scriptedSurfaceHand(targetCam: Vec3 | null, tSec: number, m: ViewMapping): FakeHandResult {
  if (!targetCam || !(targetCam.z < -0.1)) {
    const open = syntheticHandShape("open");
    return fakeHandResult(open, { x: 0.12 + 0.01 * Math.sin(tSec * 2), y: -0.12, z: -0.4 }, m, "Right");
  }
  const point = syntheticHandShape("point");
  // 重心 → 人差し指の先のオフセット（カメラ座標系。y は形状のまま上向き、z は奥が負）
  const c = centered(point)[INDEX_TIP];
  const off: Vec3 = { x: c.x, y: c.y, z: -c.z };
  const s = TIP_DEPTH_M / -targetCam.z;
  const tip = { x: targetCam.x * s, y: targetCam.y * s, z: targetCam.z * s };
  return fakeHandResult(point, { x: tip.x - off.x, y: tip.y - off.y, z: tip.z - off.z }, m, "Right");
}
