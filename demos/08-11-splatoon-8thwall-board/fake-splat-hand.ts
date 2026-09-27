// Phase 8: デバッグ用の「合成の手」（?fakehands=1）。顔の前で パー（連射）→ グー（撃たない）→ 休み を
// 繰り返す。手の位置は左右にゆっくり振って、発射の向き（目 → 手のひら）が壁の上をなぞるようにする。
// MediaPipe 抜きで「形の判定 → 連射 → インク消費 → サーバーの着弾 → 全員の格子」を PC で回す入力源
import { fakeHandResult, syntheticHandShape } from "../../src/shared/fake-hands";
import type { FakeHandResult } from "../../src/shared/fake-hands";
import type { Vec3, ViewMapping } from "../../src/shared/hand-math";

/** パー（連射）の時間 [s]・グー（イカ）の時間 [s]・休み [s]（既定。?fakeOpenSec= 等で変えられる） */
export const FAKE_OPEN_SEC = 2.5;
export const FAKE_FIST_SEC = 2.0;
export const FAKE_REST_SEC = 0.5;
export const FAKE_CYCLE_SEC = FAKE_OPEN_SEC + FAKE_FIST_SEC + FAKE_REST_SEC;

export interface FakeSplatTiming {
  openSec: number;
  fistSec: number;
  restSec: number;
}
export const DEFAULT_FAKE_TIMING: FakeSplatTiming = { openSec: FAKE_OPEN_SEC, fistSec: FAKE_FIST_SEC, restSec: FAKE_REST_SEC };

/**
 * @param timing パー → グー → 休み の各時間 [s]。パーを 9s 以上にするとタンク（既定 50 発、6 発/s）が空になる
 */
export function scriptedSplatHand(tSec: number, m: ViewMapping, timing: FakeSplatTiming = DEFAULT_FAKE_TIMING): FakeHandResult | null {
  const cycle = timing.openSec + timing.fistSec + timing.restSec;
  const t = tSec % cycle;
  const center: Vec3 = {
    x: 0.1 + 0.08 * Math.sin(tSec * 0.7),
    y: -0.1 + 0.03 * Math.cos(tSec * 0.9),
    z: -0.45,
  };
  if (t < timing.openSec) return fakeHandResult(syntheticHandShape("open"), center, m, "Right");
  if (t < timing.openSec + timing.fistSec) return fakeHandResult(syntheticHandShape("fist"), center, m, "Right");
  return null;
}
