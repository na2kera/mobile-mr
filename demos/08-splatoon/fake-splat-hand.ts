// Phase 8: デバッグ用の「合成の手」（?fakehands=1）。顔の前で パー（連射）→ グー（撃たない）→ 休み を
// 繰り返す。手の位置は左右にゆっくり振って、発射の向き（目 → 手のひら）が壁の上をなぞるようにする。
// MediaPipe 抜きで「形の判定 → 連射 → インク消費 → サーバーの着弾 → 全員の格子」を PC で回す入力源
import { fakeHandResult, syntheticHandShape } from "../../src/shared/fake-hands";
import type { FakeHandResult } from "../../src/shared/fake-hands";
import type { Vec3, ViewMapping } from "../../src/shared/hand-math";

/** パー（連射）の時間 [s]・グー（イカ）の時間 [s]・休み [s] */
export const FAKE_OPEN_SEC = 2.5;
export const FAKE_FIST_SEC = 2.0;
export const FAKE_REST_SEC = 0.5;
export const FAKE_CYCLE_SEC = FAKE_OPEN_SEC + FAKE_FIST_SEC + FAKE_REST_SEC;

export function scriptedSplatHand(tSec: number, m: ViewMapping): FakeHandResult | null {
  const t = tSec % FAKE_CYCLE_SEC;
  const center: Vec3 = {
    x: 0.1 + 0.08 * Math.sin(tSec * 0.7),
    y: -0.1 + 0.03 * Math.cos(tSec * 0.9),
    z: -0.45,
  };
  if (t < FAKE_OPEN_SEC) return fakeHandResult(syntheticHandShape("open"), center, m, "Right");
  if (t < FAKE_OPEN_SEC + FAKE_FIST_SEC) return fakeHandResult(syntheticHandShape("fist"), center, m, "Right");
  return null;
}
