// issue #54 の調査用の合成実験（回帰テストではない。`node scripts/experiment-posit-tilt.mjs [size m] [dist m] [camAbove m] [noise px]`）。
// 単一マーカーの POSIT（js-aruco2 posit1）がほぼ正面のマーカーの「傾き（ピッチ）」をどれだけ外すかを、
// 検出側（marker-anchor.ts）と同じ焦点距離の換算（長辺 960 / 2 / tan(106°/2)）で合成した角にノイズを乗せて測る。
// 結果の例（150mm を 1.5m から、カメラはマーカー中心より 0.4m 上、角に ±1px）: 傾きの誤差は中央値 9°・p90 35°、
// best が鏡像側（alternative のほうが真値に近い）が 2 割、距離の誤差は −1%。傾きが 20° ずれると壁の下端は 0.4m 手前・
// 足元の床は 0.5m 浮く（= issue #54 の症状）。PAIN_POINTS「[2026-09-11] 1 枚のマーカーから出した「傾き」は信用できず…」参照
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { POS } = require("js-aruco2/src/posit1.js");

const W = 960;
const HFOV = 106;
const focal = W / 2 / Math.tan((HFOV * Math.PI) / 180 / 2);
const size = Number(process.argv[2] ?? 0.15);
const dist = Number(process.argv[3] ?? 1.5);
/** カメラがマーカー中心より上にいる高さ [m]（0 なら真正面） */
const camAbove = Number(process.argv[4] ?? 0.4);
const noisePx = Number(process.argv[5] ?? 1);
const N = 2000;

// マーカー座標系（X 右 / Y 上 / Z = 面から視点側）→ POSIT のカメラ座標系（X 右 / Y 上 / Z 奥）。
// カメラはマーカー正面から dist 離れ camAbove 上にいて、マーカー中心を向く（ピッチ = atan(camAbove / dist)）
const pitch = Math.atan2(camAbove, dist);
function toCam(p) {
  const dx = p[0];
  const dy = p[1] - camAbove;
  const dz = p[2] - dist;
  return [dx, dy * Math.cos(pitch) - dz * Math.sin(pitch), -dy * Math.sin(pitch) - dz * Math.cos(pitch)];
}
const half = size / 2;
const model = [
  [-half, half, 0],
  [half, half, 0],
  [half, -half, 0],
  [-half, -half, 0],
];
const proj = model.map(toCam).map(([x, y, z]) => ({ x: (focal * x) / z, y: (focal * y) / z }));
const sidePx = Math.hypot(proj[1].x - proj[0].x, proj[1].y - proj[0].y);
console.log(
  `focal=${focal.toFixed(1)}px size=${size}m dist=${dist}m camAbove=${camAbove}m truePitch=${((pitch * 180) / Math.PI).toFixed(1)}deg sidePx=${sidePx.toFixed(1)} noise=±${noisePx}px`,
);

const posit = new POS.Posit(size, focal);
const dir = (p) => {
  const a = toCam(p);
  const b = toCam([0, 0, 0]);
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
};
const trueUp = dir([0, 1, 0]);
function angle(a, b) {
  const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return (Math.acos(Math.max(-1, Math.min(1, d / Math.hypot(...a) / Math.hypot(...b)))) * 180) / Math.PI;
}
// 再現性のため固定シードの擬似乱数（Box-Muller）
let rng = 12345;
const rand = () => {
  rng = (rng * 1664525 + 1013904223) >>> 0;
  return rng / 2 ** 32;
};
const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());

const errs = [];
const dists = [];
let mirrored = 0;
let compared = 0;
for (let i = 0; i < N; i++) {
  const pts = proj.map((p) => ({ x: p.x + gauss() * noisePx, y: p.y + gauss() * noisePx }));
  const pose = posit.pose(pts);
  const R = pose.bestRotation;
  const t = pose.bestTranslation;
  if (!R.length || !t.every(Number.isFinite)) continue;
  const tiltBest = angle([R[0][1], R[1][1], R[2][1]], trueUp);
  errs.push(tiltBest);
  dists.push(Math.hypot(...t));
  const Ra = pose.alternativeRotation;
  if (Ra.length) {
    compared++;
    if (angle([Ra[0][1], Ra[1][1], Ra[2][1]], trueUp) + 2 < tiltBest) mirrored++;
  }
}
errs.sort((a, b) => a - b);
const q = (p) => errs[Math.floor(p * (errs.length - 1))];
const trueDist = Math.hypot(camAbove, dist);
const dmean = dists.reduce((a, b) => a + b, 0) / dists.length;
console.log(`tilt error [deg]: median=${q(0.5).toFixed(1)} p90=${q(0.9).toFixed(1)} max=${q(1).toFixed(1)} (n=${errs.length})`);
console.log(`distance: true=${trueDist.toFixed(3)} mean=${dmean.toFixed(3)} (err ${((dmean / trueDist - 1) * 100).toFixed(1)}%)`);
console.log(`best が鏡像側（alternative のほうが真値に近い）: ${((mirrored / compared) * 100).toFixed(1)}%`);
const t90 = (q(0.9) * Math.PI) / 180;
console.log(
  `p90 の傾きで: 壁の下端（マーカーの 1.2m 下）の前後ずれ ≈ ${(1.2 * Math.sin(t90)).toFixed(2)}m, 足元（壁から ${dist}m）の床の高さずれ ≈ ${(dist * Math.sin(t90)).toFixed(2)}m`,
);
