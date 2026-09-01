// ex8-1: デバッグ用の「合成の手」（?fakehands=1）。普段は開いた手を定位置に置き、
// main.ts が「ボールが近い」と判断したタイミングで 0.15 秒だけ前へ速く突き出す
// （開いたままの突き出し = ゴッドハンドの発動条件を満たす）。
// MediaPipe 抜きで「突き出し検出 → 実体化 → キャッチ」を PC（ヘッドレス含む）で回す入力源
import { fakeHandResult, syntheticHandShape } from "../../src/shared/fake-hands";
import type { FakeHandResult } from "../../src/shared/fake-hands";
import type { Vec3, ViewMapping } from "../../src/shared/hand-math";

export const FAKE_REST: Vec3 = { x: 0.1, y: -0.1, z: -0.38 };
/** 突き出しの時間 [s] と速さ [m/s] */
export const FAKE_THRUST_SEC = 0.15;
const FAKE_THRUST_SPEED = 3.2;

/**
 * @param thrustSec 突き出し開始からの経過 [s]（突き出していないときは null）
 */
export function scriptedGodHand(thrustSec: number | null, tSec: number, m: ViewMapping): FakeHandResult {
  const open = syntheticHandShape("open");
  let center: Vec3 = {
    x: FAKE_REST.x + 0.008 * Math.sin(tSec * 2),
    y: FAKE_REST.y + 0.008 * Math.cos(tSec * 1.7),
    z: FAKE_REST.z,
  };
  if (thrustSec !== null && thrustSec < FAKE_THRUST_SEC + 0.25) {
    const t = Math.min(FAKE_THRUST_SEC, thrustSec);
    center = { x: FAKE_REST.x, y: FAKE_REST.y, z: FAKE_REST.z - FAKE_THRUST_SPEED * t };
  }
  return fakeHandResult(open, center, m, "Right");
}
