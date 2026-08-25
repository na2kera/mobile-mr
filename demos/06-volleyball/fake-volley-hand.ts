// Phase 6: デバッグ用の「合成の手」。05 の fake-hands.ts（台本で動く手）の 06 版で、
// ボールがカメラの近く（手の届く範囲）に来たらそこに開いた手を出して触れさせ、
// 遠いときは顔の前の定位置に戻す。MediaPipe 抜きで
// 「手がボールに触れる → hit を送る → サーバーが打ち返す → bot が返す → …」の一周を
// PC（ヘッドレス含む）で回すための入力源（?fakecam=1&autostart=1&fakehands=1）
import { fakeHandResult, syntheticHandShape } from "../../src/shared/fake-hands";
import type { FakeHandResult } from "../../src/shared/fake-hands";
import type { Vec3, ViewMapping } from "../../src/shared/hand-math";

/** 手を出す範囲: カメラからの深度 [m]（下限は hand-math の MIN_DEPTH_M と同じ） */
const REACH_MIN = 0.05;
const REACH_MAX = 0.75;
/** 定位置（カメラ座標系。顔の前 45cm、やや右下） */
const REST: Vec3 = { x: 0.15, y: -0.2, z: -0.45 };

/**
 * @param ballCam ボールのカメラ座標系での位置（見えていなければ null）
 * @param tSec 経過秒（定位置で少し揺らして速度を持たせる）
 */
export function scriptedVolleyHand(
  ballCam: Vec3 | null,
  tSec: number,
  m: ViewMapping,
): FakeHandResult {
  const open = syntheticHandShape("open");
  let center: Vec3;
  if (
    ballCam &&
    -ballCam.z >= REACH_MIN &&
    -ballCam.z <= REACH_MAX &&
    Math.abs(ballCam.x) <= 0.6 &&
    Math.abs(ballCam.y) <= 0.6
  ) {
    // 手の中心をボールの中心に重ねる（指先がボールの中に入る = 接触）
    center = { x: ballCam.x, y: ballCam.y, z: ballCam.z };
  } else {
    center = {
      x: REST.x + 0.02 * Math.sin(tSec * 2),
      y: REST.y + 0.02 * Math.cos(tSec * 1.7),
      z: REST.z,
    };
  }
  return fakeHandResult(open, center, m, "Right");
}
