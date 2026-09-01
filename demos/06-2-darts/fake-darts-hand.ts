// Phase 6-2: デバッグ用の「合成の手」。06 の fake-volley-hand.ts のダーツ版で、自分の手番になったら
// 顔の前の定位置から指定の速度で 0.25 秒だけ前へ振り、止める（速度が落ちる = 手を離した、を
// main.ts の投げ検出が拾う）。MediaPipe 抜きで「振る → throw を送る → サーバーが着地を決める →
// 次の手番」の一周を PC（ヘッドレス含む）で回すための入力源（?fakecam=1&autostart=1&fakehands=1）
import { fakeHandResult, syntheticHandShape } from "../../src/shared/fake-hands";
import type { FakeHandResult } from "../../src/shared/fake-hands";
import type { Vec3, ViewMapping } from "../../src/shared/hand-math";

/** 定位置（カメラ座標系。顔の前 40cm、やや右下） */
export const FAKE_REST: Vec3 = { x: 0.12, y: -0.12, z: -0.4 };
/** 手番になってから振り始めるまで [s]・振る時間 [s]・止めて見せる時間 [s] */
const WINDUP_SEC = 1.5;
// 0.25 だと main.ts が渡す速度（仰角 throwLoft を打ち消して下向きに寝ている）で振り始めが
// 顔に近すぎ、最初の数投が検出のならし中に外れる。短くして振りを定位置の周りに収める
const SWING_SEC = 0.15;
const HOLD_SEC = 0.6;
/** 1 投のサイクル [s]。投げが刺さって次の投げに移る（settle 0.9s）より長く */
export const FAKE_CYCLE_SEC = WINDUP_SEC + SWING_SEC + HOLD_SEC + 1.2;

/**
 * @param turnSec 自分の手番になってからの経過秒（手番でなければ null）
 * @param swingVel 振る速度（カメラ座標系 [m/s]。main.ts がボードの中心へ届く速度を計算して渡す）
 */
export function scriptedDartsHand(
  turnSec: number | null,
  swingVel: Vec3,
  tSec: number,
  m: ViewMapping,
): FakeHandResult {
  const open = syntheticHandShape("open");
  let center: Vec3 = {
    x: FAKE_REST.x + 0.01 * Math.sin(tSec * 2),
    y: FAKE_REST.y + 0.01 * Math.cos(tSec * 1.7),
    z: FAKE_REST.z,
  };
  if (turnSec !== null) {
    const t = turnSec % FAKE_CYCLE_SEC;
    if (t >= WINDUP_SEC && t < WINDUP_SEC + SWING_SEC + HOLD_SEC) {
      // 振りの終点（= 離す位置）が定位置になるよう、手前に引いた位置から振る
      // （main.ts は定位置からボードへ届く速度を渡してくるので、離す位置がずれると外れる）
      const dt = Math.min(SWING_SEC, t - WINDUP_SEC) - SWING_SEC;
      center = {
        x: FAKE_REST.x + swingVel.x * dt,
        y: FAKE_REST.y + swingVel.y * dt,
        z: FAKE_REST.z + swingVel.z * dt,
      };
    }
  }
  return fakeHandResult(open, center, m, "Right");
}
