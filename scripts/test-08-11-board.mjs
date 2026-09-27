// 08-11（demos/08-11-splatoon-8thwall-board）の Node 単体テスト。`npm run test:8thwall-board` で実行する。
//   1. 窓平均フィルタ（anchor-filter.ts。three に依存しない純粋な計算なので直接 import する）
//      (a) 静止したコートの観測に ±1cm の一様ノイズ（10Hz・20 秒・種 20 通り）→ 窓が埋まった後の表示の変動（自分の平均からの RMS）が 3mm 以下。
//          対照の lerp（?avg=0 = 08-4 と同じ）では真値からの最大のずれが 10mm 以上（種の中央値）。両モードの RMS・最大のずれ・1 回の最大の動きも出す
//      (b) 外れ値: 窓が埋まった後、1 件だけ 0.5m（または 30°）ずれた観測が来ても推定が 5mm 以上動かない
//      (c) 持続的なずれ: 0.3m 平行移動した観測が続くと、作り直しで 5 件以内に新しい位置へ移る。低い頻度（2Hz）なら 3 件・1000ms で作り直す
//      (d) LIMITED: 1 秒未満の LIMITED の観測は窓にも表示にも使わない（窓はそのまま）。1 秒以上続いた LIMITED の観測で直接モードに入り、
//          窓が空になり、目標は lerp で生の観測に寄る。NORMAL に戻ると新しい窓
//      (e) reset() で目標・表示が消える。clearWindow()（配置変更）は窓だけ捨てて表示を残す
//      (f) 回転: ヨー ±2° の一様ノイズで変動（RMS）が 0.5° 以下。半球が反転した四元数（-q）が混ざっても結果が同じで壊れない
//      (g) 連射中（canSnap=false）は表示が 1 フレームあたり最大 5mm・0.3° しか動かない（作り直し・直接モードでも）。初回は制限なし
//      (h) lerp モードは 08-4 と同じ（初回スナップ・0.5 の lerp・0.3m 超はスナップ・連射中はスナップしない）
//      (i) 窓が 1〜2 件のときの外れ値（0.5m・30°）で目標が動かない（レビュー R1）
//      (j) 観測が途切れた後の再取得（reacquire）で目標が 1 件の観測に置き換わらず、差が lastReacquire に残る（R1・R2）
//      (k) σ=5cm・10Hz・120 秒のノイズで作り直しが起きない。0.3m の段差では従来どおり 5 件前後で作り直す（R5）
//      (l) ±1cm のノイズの中の 3〜4cm の外れ値が窓の平均に入らない（R6）
//      (m) 頭を速く回している間の観測（fastMotion）は窓に入れず fast= に数える。目標が無ければ直接モードでも再ロックしない（R7・S6）
//      (n) 空白（5 秒）・clearWindow・直接モードの後に 0.15m / ヨー 8° ずれた観測が続くと、reacquire はちょうど 1 回、5 件前後で作り直して
//          新しい位置へ移り、lastReacquire は最初の値のまま（再レビュー S1。以前は reacquire が毎回やり直されて永遠に固着した）
//      (o) ノイズあり（各軸 σ 2cm / 0.15m・3cm / 0.25m・5cm / 0.2m、種 20 通り、空白後 20 秒）で固着 0 件（S1）
//      (p) 窓が 3 件未満のまま（まとまらない遠い観測だけが）3 秒続いたら、まとまりの条件なしで作り直す（S2）
//      (q) ?avgMaxN= の下限 3（1 / 2 を渡しても 3 になり目標が更新される。S3）
//      (r) 角速度（xr-motion.ts）: 世代の最初の姿勢は未測定（null）、2 つ目で測れる、同じ時刻は変えない、世代が変わると未測定に戻る（S4）
//      (s) 2 解が交互に出る列（目標から 11cm と 19cm）: 二峰として作り直さず、目標が観測ごとに往復しない（1 観測あたり 1cm 未満。S5）
//      (t) 回転ノイズあり（位置 1〜3cm・回転 1.5°）で空白の後の 15cm ずれ: 作り直しまで中央 ≤ 7 件・最悪 ≤ 15 件（最終レビュー T1）
//      (u) 保険は遠い観測が 3 件以上かつ過半数のときだけ（低頻度の近い観測だけでは発動しない）。遠い観測が二峰なら中間へ（T2）
//      (v) 別解が混ざる窓: 30%@4cm で最悪 ≤ 5mm、45%@6cm で往復しない（T3）
//      (w) 保険の観測は時間（windowMs）で間引く（2.9 秒おきの遠い観測では発動しない。T4）
//      (x) 配置変更の直後の長い LIMITED で再取得の理由が layout のまま・直接モード中の clearWindow で directEntries を二重に数えない（T5）
//      (y) 通常の使い方（σ1〜3cm・0.4〜10Hz・見る / 見ないの繰り返し・たまに LIMITED、180 秒 × 20 本）で保険は σ≤2cm で 0 回、
//          σ3cm で発動したときは必ず目標の誤差が減る（T6）
//      (z) isFastMotion（main.ts の配線）: XR 無しは false、未測定（null）は true、上限超えは true（T6）
//   2. xr-source.ts のコピー（08-10 の scripts/test-08-10-xr.mjs を元に、XR8 の pipeline callback 境界をモック）:
//      LIMITED で invalidate しない・有効なら姿勢を更新 / 無効なら保持・生の trackingReason が残る・LIMITED の回数と長さ・
//      姿勢の飛び（LIMITED 復帰直後を区別）・向き変更 / 投影更新 / failed で invalidate（原因別の回数）・invalidate 後は次の有効な reality まで
//      pose が null（追補 A1）・invalidate の後は reality を 2 フレームかつ 150ms 捨てる（R3）・開始時の投影設定が姿勢の採用の後に
//      ずれ込んだら invalidate（R8）・onException は invalidate せず lastError（3 秒は残す）・カメラの状態は status と別（R9）・
//      不正 intrinsics は姿勢を捨てない・repeatFrame・先行読み込み・タイムアウト
// テストフレームワークは使わない（他の test-*.mjs と同じ方針）。乱数は種を固定する
import assert from "node:assert/strict";
import { createServer } from "vite";
import * as THREE from "three";
import { MIN_WINDOW, createAnchorFilter, distV3, quatAngleDeg } from "../demos/08-11-splatoon-8thwall-board/anchor-filter.ts";
import { createAngularRateMeter, isFastMotion } from "../demos/08-11-splatoon-8thwall-board/xr-motion.ts";

const results = [];
function check(name, cond, detail = "") {
  results.push([name, cond]);
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${detail ? ` (${detail})` : ""}`);
}

/** 種つきの一様乱数 [0, 1)（mulberry32） */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const yawQuat = (deg) => [0, Math.sin((deg * Math.PI) / 360), 0, Math.cos((deg * Math.PI) / 360)];
const TRUE_POS = [0.7, -0.3, 1.6];
const TRUE_Q = yawQuat(140);
/** ヨー 140° に yaw [deg] を足した四元数 */
const qTimes = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const obsAt = (tMs, pos, quat = TRUE_Q, xrNormal = true, limitedMs = 0) => ({ tMs, pos, quat, xrNormal, limitedMs });
const mm = (m) => `${(m * 1000).toFixed(2)}mm`;
const sorted = (a) => [...a].sort((x, y) => x - y);
const medianOf = (a) => sorted(a)[a.length >> 1];

// ================= 1. 窓平均フィルタ =================

/** 静止したコートにノイズを乗せた観測を 10Hz で 20 秒流し、窓が埋まった後（4s 以降）の表示を記録する */
function runStatic(mode, seed, { posNoise = 0.01, yawNoiseDeg = 0, hz = 10, flipSign = false } = {}) {
  const r = rng(seed);
  const f = createAnchorFilter({ mode });
  const out = [];
  let prev = null;
  let maxStep = 0;
  for (let i = 0; i < hz * 20; i++) {
    const t = (i * 1000) / hz;
    const pos = TRUE_POS.map((v) => v + (r() * 2 - 1) * posNoise);
    let quat = qTimes(TRUE_Q, yawQuat((r() * 2 - 1) * yawNoiseDeg));
    if (flipSign && r() < 0.5) quat = quat.map((v) => -v);
    f.add(obsAt(t, pos, quat), true);
    const d = f.step(true);
    if (t >= 4000) {
      out.push(d);
      if (prev) maxStep = Math.max(maxStep, distV3(prev.pos, d.pos));
      prev = d;
    }
  }
  const mean = [0, 1, 2].map((k) => out.reduce((s, p) => s + p.pos[k], 0) / out.length);
  const rms = Math.sqrt(out.reduce((s, p) => s + distV3(p.pos, mean) ** 2, 0) / out.length);
  const maxDev = Math.max(...out.map((p) => distV3(p.pos, TRUE_POS)));
  const angles = out.map((p) => quatAngleDeg(p.quat, TRUE_Q));
  const rmsDeg = Math.sqrt(angles.reduce((s, a) => s + a * a, 0) / angles.length);
  const finite = out.every((p) => [...p.pos, ...p.quat].every(Number.isFinite));
  return { rms, maxDev, maxStep, rmsDeg, maxDeg: Math.max(...angles), finite, stats: f.stats, last: out[out.length - 1] };
}

// ---- (a) 位置のノイズ ----
{
  const seeds = Array.from({ length: 20 }, (_, i) => i + 1);
  const avg = seeds.map((s) => runStatic("avg", s));
  const lerp = seeds.map((s) => runStatic("lerp", s));
  const fmt = (rs) =>
    `RMS 中央値 ${mm(medianOf(rs.map((r) => r.rms)))} 最悪 ${mm(Math.max(...rs.map((r) => r.rms)))} / 真値からの最大のずれ 中央値 ${mm(medianOf(rs.map((r) => r.maxDev)))} 最悪 ${mm(Math.max(...rs.map((r) => r.maxDev)))} / 1 回の最大の動き 最悪 ${mm(Math.max(...rs.map((r) => r.maxStep)))}`;
  console.log(`  avg : ${fmt(avg)}（窓 n=${avg[0].stats.n}）`);
  console.log(`  lerp: ${fmt(lerp)}`);
  check("(a) avg: ±1cm のノイズで窓が埋まった後の表示の変動（RMS）が全種で 3mm 以下", avg.every((r) => r.rms <= 0.003), `最悪 ${mm(Math.max(...avg.map((r) => r.rms)))}`);
  // 窓の端の観測が外れ値の閾値（2cm）の際で出入りすると 1mm 強動くことがある（R6 で閾値を 3σ に直した結果）
  check("(a) avg: 1 回の観測で表示が動く量が全種で 2mm 以下（ちょこちょこ動かない。lerp は 1 回で 1cm 前後）", avg.every((r) => r.maxStep <= 0.002), `最悪 ${mm(Math.max(...avg.map((r) => r.maxStep)))}`);
  check("(a) 対照の lerp（?avg=0）: 真値からの最大のずれが 10mm 以上（種の中央値）", medianOf(lerp.map((r) => r.maxDev)) >= 0.01, mm(medianOf(lerp.map((r) => r.maxDev))));
  check("(a) avg の RMS は lerp の 1/2.5 未満（全種）", avg.every((r, i) => r.rms * 2.5 < lerp[i].rms), `avg ${mm(medianOf(avg.map((r) => r.rms)))} vs lerp ${mm(medianOf(lerp.map((r) => r.rms)))}`);
}

// ---- (b) 外れ値 ----
{
  for (const [label, bad] of [
    ["位置 0.5m", (t) => obsAt(t, [TRUE_POS[0] + 0.5, TRUE_POS[1], TRUE_POS[2]])],
    ["回転 30°", (t) => obsAt(t, TRUE_POS, qTimes(TRUE_Q, yawQuat(30)))],
  ]) {
    const r = rng(7);
    const f = createAnchorFilter();
    let t = 0;
    for (; t < 4000; t += 100) f.add(obsAt(t, TRUE_POS.map((v) => v + (r() * 2 - 1) * 0.01)), true);
    f.step(true);
    const before = f.target;
    const outBefore = f.stats.outliers;
    f.add(bad(t), true);
    const after = f.step(true);
    const moved = distV3(before.pos, after.pos);
    const turned = quatAngleDeg(before.quat, after.quat);
    check(`(b) 外れ値（${label}）が 1 件来ても推定が 5mm 以上・0.5° 以上動かず、外れ値として数える`, moved < 0.005 && turned < 0.5 && f.stats.outliers === outBefore + 1, `${mm(moved)} ${turned.toFixed(3)}° outliers=${f.stats.outliers}`);
    // 次の普通の観測で連続が切れる（作り直さない）
    f.add(obsAt(t + 100, TRUE_POS), true);
    check(`(b) 外れ値（${label}）の後に普通の観測が来れば作り直さない`, f.stats.reseeds === 0, `reseeds=${f.stats.reseeds}`);
  }
}

// ---- (c) 持続的なずれ ----
{
  const r = rng(11);
  const f = createAnchorFilter();
  let t = 0;
  for (; t < 4000; t += 100) f.add(obsAt(t, TRUE_POS.map((v) => v + (r() * 2 - 1) * 0.01)), true);
  const shifted = [TRUE_POS[0] + 0.3, TRUE_POS[1], TRUE_POS[2]];
  let movedAt = -1;
  for (let k = 1; k <= 8; k++, t += 100) {
    const ev = f.add(obsAt(t, shifted.map((v) => v + (r() * 2 - 1) * 0.01)), true);
    f.step(true);
    if (movedAt < 0 && distV3(f.target.pos, shifted) < 0.02) movedAt = k;
    if (ev === "reseed") console.log(`  (c) ${k} 件目で作り直し（窓 n=${f.stats.n}）`);
  }
  check("(c) 0.3m 平行移動した観測が続くと 5 件以内に新しい位置（±2cm）へ移る（作り直し 1 回）", movedAt > 0 && movedAt <= 5 && f.stats.reseeds === 1, `movedAt=${movedAt} reseeds=${f.stats.reseeds} target=${f.target.pos.map((v) => v.toFixed(3))}`);
  // 低い頻度（2Hz）: 3 件・1000ms で作り直す
  const g = createAnchorFilter();
  for (t = 0; t < 4000; t += 500) g.add(obsAt(t, TRUE_POS), true);
  const events = [];
  for (let k = 0; k < 3; k++, t += 500) events.push(g.add(obsAt(t, shifted), true));
  check("(c) 2Hz の観測では 3 件目（1000ms 続いた時点）で作り直す", events[2] === "reseed" && distV3(g.target.pos, shifted) < 1e-9, JSON.stringify(events));
  // 回転の持続的なずれ（5° 以上）でも作り直す
  const h = createAnchorFilter();
  for (t = 0; t < 4000; t += 100) h.add(obsAt(t, TRUE_POS), true);
  const turned = qTimes(TRUE_Q, yawQuat(10));
  const evs = [];
  for (let k = 0; k < 5; k++, t += 100) evs.push(h.add(obsAt(t, TRUE_POS, turned), true));
  check("(c) 回転が 10° ずれた観測が 5 件続くと作り直す", evs[4] === "reseed" && quatAngleDeg(h.target.quat, turned) < 1e-6, JSON.stringify(evs));
}

// ---- (d) LIMITED ----
{
  const f = createAnchorFilter();
  let t = 0;
  for (; t < 3000; t += 100) f.add(obsAt(t, TRUE_POS), true);
  f.step(true);
  const n0 = f.stats.n;
  const target0 = f.target;
  // 1 秒未満の LIMITED: 窓にも表示にも使わない
  const far = [TRUE_POS[0] + 0.2, TRUE_POS[1], TRUE_POS[2]];
  const evShort = [];
  for (let k = 0; k < 5; k++, t += 100) evShort.push(f.add(obsAt(t, far, TRUE_Q, false, k * 100), true));
  f.step(true);
  check("(d) 1 秒未満の LIMITED の観測は使わない（ignored・窓の件数と目標がそのまま）", evShort.every((e) => e === "ignored") && f.stats.n === n0 && distV3(f.target.pos, target0.pos) < 1e-12 && f.stats.ignored === 5, `${JSON.stringify(evShort)} n=${f.stats.n}`);
  // 短い LIMITED から NORMAL に戻ったら窓はそのまま続く
  const evBack = f.add(obsAt(t, TRUE_POS), true);
  t += 100;
  // LIMITED の 500ms の間に窓の古い側（3000ms より前）は時間で落ちるので、件数は n0 - 5 + 1 になる
  check("(d) 1 秒未満の LIMITED の後に NORMAL の観測が来たら窓を捨てずに続ける（update・LIMITED 前の観測が窓に残る）", evBack === "update" && f.stats.n === n0 - 5 + 1 && distV3(f.target.pos, TRUE_POS) < 1e-12, `${evBack} n=${n0} → ${f.stats.n}`);
  // 1 秒以上続いた LIMITED: 直接モード。窓が空になり、目標は生の観測へ lerp（0.5）
  const before = f.target;
  const evLong = f.add(obsAt(t, far, TRUE_Q, false, 1200), true);
  t += 100;
  const d1 = distV3(f.target.pos, far);
  const expected = distV3(before.pos, far) * 0.5;
  check("(d) 1 秒以上続いた LIMITED の観測で直接モード（窓が空・mode=direct・目標が生の観測へ 0.5 の lerp）", evLong === "direct" && f.stats.n === 0 && f.stats.mode === "direct" && Math.abs(d1 - expected) < 1e-9 && f.stats.directEntries === 1, `${evLong} n=${f.stats.n} 残り ${mm(d1)} 期待 ${mm(expected)}`);
  f.add(obsAt(t, far, TRUE_Q, false, 1300), true);
  t += 100;
  check("(d) 直接モード中は観測ごとに生の観測へ寄る", distV3(f.target.pos, far) < d1 * 0.51, mm(distV3(f.target.pos, far)));
  const targetDirect = f.target;
  const evNormal = f.add(obsAt(t, far), true);
  t += 100;
  check("(d) NORMAL に戻ると新しい窓（reacquire・after=direct・n=1・mode=avg）、目標は 3 件そろうまで直接モードの値のまま", evNormal === "reacquire" && f.lastReacquire?.reason === "direct" && f.stats.n === 1 && f.stats.mode === "avg" && distV3(f.target.pos, targetDirect.pos) < 1e-12, `${evNormal} n=${f.stats.n}`);
  f.add(obsAt(t, far), true);
  t += 100;
  f.add(obsAt(t, far), true);
  check("(d) 新しい窓が 3 件そろうと目標は窓の平均", f.stats.n === 3 && distV3(f.target.pos, far) < 1e-12, `n=${f.stats.n}`);
}

// ---- (e) reset / clearWindow ----
{
  const f = createAnchorFilter();
  for (let t = 0; t < 2000; t += 100) f.add(obsAt(t, TRUE_POS), true);
  f.step(true);
  f.clearWindow();
  check("(e) clearWindow(): 窓は空・目標と表示は残る", f.stats.n === 0 && f.target !== null && f.display !== null);
  const ev = f.add(obsAt(2100, TRUE_POS), true);
  check("(e) clearWindow() の後の観測で新しい窓（reacquire・after=layout）", ev === "reacquire" && f.lastReacquire?.reason === "layout" && f.stats.n === 1, ev);
  f.reset();
  check("(e) reset(): 目標・表示が消え、step() も null", f.target === null && f.display === null && f.step(true) === null && f.stats.n === 0);
  const ev2 = f.add(obsAt(2200, TRUE_POS), false);
  const d = f.step(false);
  check("(e) reset() の後の最初の観測は連射中（canSnap=false）でも制限なしで表示される（再ロック直後は発射できない）", ev2 === "init" && d && distV3(d.pos, TRUE_POS) < 1e-12, ev2);
}

// ---- (f) 回転 ----
{
  const seeds = Array.from({ length: 20 }, (_, i) => i + 101);
  const avg = seeds.map((s) => runStatic("avg", s, { posNoise: 0, yawNoiseDeg: 2 }));
  const lerp = seeds.map((s) => runStatic("lerp", s, { posNoise: 0, yawNoiseDeg: 2 }));
  console.log(`  回転 avg : RMS 中央値 ${medianOf(avg.map((r) => r.rmsDeg)).toFixed(3)}° 最悪 ${Math.max(...avg.map((r) => r.rmsDeg)).toFixed(3)}° / 最大のずれ 最悪 ${Math.max(...avg.map((r) => r.maxDeg)).toFixed(3)}°`);
  console.log(`  回転 lerp: RMS 中央値 ${medianOf(lerp.map((r) => r.rmsDeg)).toFixed(3)}° / 最大のずれ 中央値 ${medianOf(lerp.map((r) => r.maxDeg)).toFixed(3)}°`);
  check("(f) ヨー ±2° のノイズで回転の変動（RMS）が全種で 0.5° 以下", avg.every((r) => r.rmsDeg <= 0.5), `最悪 ${Math.max(...avg.map((r) => r.rmsDeg)).toFixed(3)}°`);
  // 同じ種で -q を混ぜても同じ結果（半球をそろえる）
  const plain = runStatic("avg", 5, { posNoise: 0.01, yawNoiseDeg: 2 });
  const flipped = runStatic("avg", 5, { posNoise: 0.01, yawNoiseDeg: 2, flipSign: true });
  // flipSign は乱数を 1 つ多く使うので種の列がずれる。比較は「壊れない（有限・真値に近い・RMS が同程度）」で見る
  check("(f) 半球が反転した四元数（-q）が半分混ざっても壊れない（有限・真値から 0.5° 以内・RMS 0.5° 以下）", flipped.finite && quatAngleDeg(flipped.last.quat, TRUE_Q) < 0.5 && flipped.rmsDeg <= 0.5, `plain ${plain.rmsDeg.toFixed(3)}° flipped ${flipped.rmsDeg.toFixed(3)}° last=${quatAngleDeg(flipped.last.quat, TRUE_Q).toFixed(3)}°`);
  // 同じ観測列の符号だけ変えたものを直接比べる
  const r = rng(9);
  const f1 = createAnchorFilter();
  const f2 = createAnchorFilter();
  for (let i = 0; i < 60; i++) {
    const q = qTimes(TRUE_Q, yawQuat((r() * 2 - 1) * 2));
    const o = obsAt(i * 100, TRUE_POS, q);
    f1.add(o, true);
    f2.add({ ...o, quat: i % 3 === 0 ? q.map((v) => -v) : q }, true);
  }
  check("(f) 同じ観測列の一部を -q にしても推定は同じ回転（浮動小数の誤差 1e-4° 以内）", quatAngleDeg(f1.target.quat, f2.target.quat) < 1e-4, `${quatAngleDeg(f1.target.quat, f2.target.quat)}°`);
}

// ---- (g) 連射中の表示の制限 ----
{
  const f = createAnchorFilter();
  let t = 0;
  for (; t < 3000; t += 100) {
    f.add(obsAt(t, TRUE_POS), true);
    f.step(true);
  }
  const shifted = [TRUE_POS[0] + 0.3, TRUE_POS[1], TRUE_POS[2]];
  const turned = qTimes(TRUE_Q, yawQuat(10));
  for (let k = 0; k < 5; k++, t += 100) f.add(obsAt(t, shifted, turned), false);
  check("(g) 作り直した（目標が 0.3m・10° 動いた）", f.stats.reseeds === 1 && distV3(f.target.pos, shifted) < 1e-9);
  let prev = f.display;
  let maxStep = 0;
  let maxTurn = 0;
  let frames = 0;
  while (f.stats.catchingUp || frames === 0) {
    const d = f.step(false);
    maxStep = Math.max(maxStep, distV3(prev.pos, d.pos));
    maxTurn = Math.max(maxTurn, quatAngleDeg(prev.quat, d.quat));
    prev = d;
    if (++frames > 1000) break;
  }
  check("(g) 連射中は表示が 1 フレーム最大 5mm・0.3° しか動かず、やがて目標に追いつく", maxStep <= 0.005 + 1e-9 && maxTurn <= 0.3 + 1e-6 && distV3(prev.pos, shifted) < 1e-9 && frames >= 60, `frames=${frames} maxStep=${mm(maxStep)} maxTurn=${maxTurn.toFixed(3)}°`);
  // 撃つのをやめたら（canSnap=true）目標へそのまま
  f.add(obsAt(t, TRUE_POS), true);
  for (let k = 0; k < 5; k++, t += 100) f.add(obsAt(t, TRUE_POS), false);
  const d1 = f.step(false);
  const d2 = f.step(true);
  check("(g) canSnap=true に戻ると目標をそのまま反映する", distV3(d1.pos, f.target.pos) > 0.004 && distV3(d2.pos, f.target.pos) < 1e-12, `${mm(distV3(d1.pos, f.target.pos))} → ${mm(distV3(d2.pos, f.target.pos))}`);
  // 直接モードの変化にも制限が掛かる
  const g = createAnchorFilter();
  for (t = 0; t < 2000; t += 100) {
    g.add(obsAt(t, TRUE_POS), true);
    g.step(true);
  }
  g.add(obsAt(t, shifted, TRUE_Q, false, 1500), false);
  const before = g.display;
  const after = g.step(false);
  check("(g) 直接モードで目標が 0.15m 動いても、連射中の表示は 5mm だけ動く", Math.abs(distV3(before.pos, after.pos) - 0.005) < 1e-9, mm(distV3(before.pos, after.pos)));
}

// ---- (h) lerp モード（08-4 と同じ） ----
{
  const f = createAnchorFilter({ mode: "lerp" });
  f.add(obsAt(0, TRUE_POS), false);
  check("(h) lerp: 初回は canSnap=false でもスナップ", distV3(f.step(false).pos, TRUE_POS) < 1e-12);
  const p1 = [TRUE_POS[0] + 0.1, TRUE_POS[1], TRUE_POS[2]];
  f.add(obsAt(100, p1), true);
  check("(h) lerp: 0.1m 先の観測で 0.5 だけ寄る", Math.abs(distV3(f.step(true).pos, TRUE_POS) - 0.05) < 1e-9);
  const p2 = [TRUE_POS[0] + 1, TRUE_POS[1], TRUE_POS[2]];
  f.add(obsAt(200, p2), false);
  check("(h) lerp: 連射中は 0.3m 超でもスナップしない", distV3(f.step(false).pos, p2) > 0.3);
  f.add(obsAt(300, p2), true);
  check("(h) lerp: 撃っていなければ 0.3m 超はスナップ", distV3(f.step(true).pos, p2) < 1e-12);
  f.add(obsAt(3000, TRUE_POS), true);
  check("(h) lerp: 前回の観測から 2000ms 超はスナップ", distV3(f.step(true).pos, TRUE_POS) < 1e-12);
  check("(h) lerp: 表示は step の制限を受けない（add で決まる）", f.stats.mode === "lerp");
}

// ---- (i) 窓が 1〜2 件のときの外れ値（R1） ----
{
  for (const [label, bad] of [
    ["位置 0.5m", (t) => obsAt(t, [TRUE_POS[0] + 0.5, TRUE_POS[1], TRUE_POS[2]])],
    ["回転 30°", (t) => obsAt(t, TRUE_POS, qTimes(TRUE_Q, yawQuat(30)))],
  ]) {
    for (const goodBefore of [1, 2]) {
      const f = createAnchorFilter();
      let t = 0;
      for (let k = 0; k < goodBefore; k++, t += 100) f.add(obsAt(t, TRUE_POS), true);
      const before = f.target;
      const ev = f.add(bad(t), true);
      const after = f.step(true);
      check(`(i) 正しい観測 ${goodBefore} 件（窓 < ${MIN_WINDOW}）の次に外れ値（${label}）が来ても目標が動かない・窓に入れない`, distV3(before.pos, after.pos) < 1e-9 && quatAngleDeg(before.quat, after.quat) < 1e-3 && f.stats.n === goodBefore && f.stats.heldOut === 1, `${ev} n=${f.stats.n} ${mm(distV3(before.pos, after.pos))} ${quatAngleDeg(before.quat, after.quat).toFixed(3)}°`);
    }
  }
  // 初回（目標なし）は 1 件目で目標を作る（再ロックを遅らせない）
  const g = createAnchorFilter();
  const ev = g.add(obsAt(0, TRUE_POS), false);
  check("(i) 目標が無いときは 1 件目で目標を作り、表示も出る（init）", ev === "init" && distV3(g.step(false).pos, TRUE_POS) < 1e-12);
}

// ---- (j) 空白の後の再取得（R1・R2） ----
{
  const r = rng(21);
  const f = createAnchorFilter();
  let t = 0;
  for (; t < 3000; t += 100) f.add(obsAt(t, TRUE_POS.map((v) => v + (r() * 2 - 1) * 0.005)), true);
  f.step(true);
  const held = f.target;
  // 4 秒見なかった後、5cm ずれた観測が 1 件
  t += 4000;
  const shifted = [TRUE_POS[0] + 0.05, TRUE_POS[1], TRUE_POS[2]];
  const ev = f.add(obsAt(t, shifted), true);
  const rq = f.lastReacquire;
  check("(j) 3 秒超の空白の後の最初の観測は reacquire・目標は 1 件の観測に置き換わらない（保持）", ev === "reacquire" && distV3(f.target.pos, held.pos) < 1e-12 && f.stats.n === 1, `${ev} n=${f.stats.n}`);
  check("(j) lastReacquire に空白の長さと、保持していた目標との差（約 50mm）が残る", rq && rq.reason === "gap" && rq.gapMs >= 4000 && Math.abs(rq.residualMm - 50) < 6, JSON.stringify(rq));
  // 空白の後の 1 件目が外れ値（0.5m）でも目標は動かない
  const g = createAnchorFilter();
  for (t = 0; t < 3000; t += 100) g.add(obsAt(t, TRUE_POS), true);
  t += 4000;
  g.add(obsAt(t, [TRUE_POS[0] + 0.5, TRUE_POS[1], TRUE_POS[2]]), true);
  check("(j) 空白の後の 1 件目が 0.5m の外れ値でも目標は動かず、窓に入れない", distV3(g.target.pos, TRUE_POS) < 1e-12 && g.stats.n === 0 && g.stats.heldOut === 1, `n=${g.stats.n}`);
  // その後に正しい観測が 3 件来れば新しい窓から目標を作る（5cm ずれた位置に移る）
  for (let k = 1; k <= 3; k++) f.add(obsAt(t + k * 100, shifted), true);
  check("(j) 空白の後に 3 件そろうと新しい窓の平均へ移る", f.stats.n === 4 && distV3(f.target.pos, shifted) < 1e-9, `n=${f.stats.n} ${f.target.pos.map((v) => v.toFixed(3))}`);
}

// ---- (k) 大きなノイズで作り直しが誤って起きない（R5） ----
{
  let totalReseeds = 0;
  let worstDev = 0;
  let rejected = 0;
  for (const seed of [31, 32, 33]) {
    const r = rng(seed);
    const gauss = () => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
    const f = createAnchorFilter();
    for (let i = 0; i < 1200; i++) {
      f.add(obsAt(i * 100, TRUE_POS.map((v) => v + 0.05 * gauss())), true);
      if (i > 50) worstDev = Math.max(worstDev, distV3(f.target.pos, TRUE_POS));
    }
    totalReseeds += f.stats.reseeds;
    rejected += f.stats.reseedRejected;
  }
  check("(k) σ=5cm・10Hz・120 秒（種 3 通り）で作り直しが起きない", totalReseeds === 0, `reseeds=${totalReseeds} 候補がまとまらず見送った=${rejected} 目標の真値からの最大のずれ ${mm(worstDev)}`);
  // 0.3m の段差（±1cm）は 5 件前後で作り直す
  const r = rng(34);
  const f = createAnchorFilter();
  let t = 0;
  for (; t < 3000; t += 100) f.add(obsAt(t, TRUE_POS.map((v) => v + (r() * 2 - 1) * 0.01)), true);
  const shifted = [TRUE_POS[0] + 0.3, TRUE_POS[1], TRUE_POS[2]];
  let at = -1;
  for (let k = 1; k <= 10 && at < 0; k++, t += 100) if (f.add(obsAt(t, shifted.map((v) => v + (r() * 2 - 1) * 0.01)), true) === "reseed") at = k;
  check("(k) 0.3m の段差（±1cm のノイズ）は 5 件目で作り直す", at === 5, `at=${at}`);
}

// ---- (l) 3〜4cm の外れ値（R6） ----
{
  for (const off of [0.03, 0.04]) {
    const r = rng(41);
    const f = createAnchorFilter();
    let t = 0;
    for (; t < 3000; t += 100) f.add(obsAt(t, TRUE_POS.map((v) => v + (r() * 2 - 1) * 0.01)), true);
    const before = f.target;
    const out0 = f.stats.outliers;
    f.add(obsAt(t, [TRUE_POS[0] + off, TRUE_POS[1], TRUE_POS[2]]), true);
    check(`(l) ±1cm のノイズの中の ${off * 100}cm の外れ値は窓の平均に入らない（外れ値として数え、目標は 0.1mm 未満しか動かない）`, f.stats.outliers === out0 + 1 && distV3(before.pos, f.target.pos) < 0.0001, `outliers ${out0} → ${f.stats.outliers} moved=${mm(distV3(before.pos, f.target.pos))}`);
  }
}

// ---- (m) 頭を速く回している間の観測（R7） ----
{
  const f = createAnchorFilter();
  let t = 0;
  for (; t < 1000; t += 100) f.add(obsAt(t, TRUE_POS), true);
  const n0 = f.stats.n;
  const ev = f.add({ ...obsAt(t, [TRUE_POS[0] + 0.05, TRUE_POS[1], TRUE_POS[2]]), fastMotion: true }, true);
  check("(m) fastMotion の観測は窓に入れず fast= に数える（ign= とは別）", ev === "fast" && f.stats.n === n0 && f.stats.fast === 1 && f.stats.ignored === 0 && distV3(f.target.pos, TRUE_POS) < 1e-12, `${ev} n=${f.stats.n}`);
  const g = createAnchorFilter();
  const e1 = g.add({ ...obsAt(0, TRUE_POS), fastMotion: true }, true);
  const e2 = g.add({ ...obsAt(100, TRUE_POS, TRUE_Q, false, 2000), fastMotion: true }, true);
  check("(m) 目標が無いときは fastMotion の観測で再ロックしない（NORMAL でも直接モードでも）", e1 === "fast" && e2 === "fast" && g.target === null && g.step(true) === null, `${e1} ${e2}`);
  g.add(obsAt(200, TRUE_POS), true);
  const e3 = g.add({ ...obsAt(300, [TRUE_POS[0] + 0.1, TRUE_POS[1], TRUE_POS[2]], TRUE_Q, false, 2000), fastMotion: true }, true);
  check("(m) 目標があれば直接モード（LIMITED が 1 秒以上）では fastMotion の観測も使う", e3 === "direct", e3);
}

// ---- (n) 空白・配置変更・直接モードの後のずれ（再レビュー S1） ----
{
  const scenarios = [
    ["空白 5 秒", (f, t) => t + 5000],
    ["clearWindow（配置変更）", (f, t) => { f.clearWindow(); return t; }],
    ["直接モード（LIMITED 1.5 秒）", (f, t) => { for (let k = 0; k < 15; k++, t += 100) f.add(obsAt(t, TRUE_POS, TRUE_Q, false, 1000 + k * 100), true); return t; }],
  ];
  const shifts = [
    ["0.15m", [TRUE_POS[0] + 0.15, TRUE_POS[1], TRUE_POS[2]], TRUE_Q],
    ["ヨー 8°", TRUE_POS, qTimes(TRUE_Q, yawQuat(8))],
  ];
  for (const [sLabel, pre] of scenarios) {
    for (const [dLabel, pos, quat] of shifts) {
      const f = createAnchorFilter();
      let t = 0;
      for (let i = 0; i < 30; i++, t += 100) f.add(obsAt(t, TRUE_POS), true);
      t = pre(f, t);
      let reacq = 0;
      let reseedAt = -1;
      let first = null;
      for (let i = 1; i <= 60; i++, t += 100) {
        const ev = f.add(obsAt(t, pos, quat), true);
        if (ev === "reacquire") reacq++;
        if (i === 1) first = f.lastReacquire;
        if (ev === "reseed" && reseedAt < 0) reseedAt = i;
      }
      const last = f.lastReacquire;
      const moved = distV3(f.target.pos, pos) < 0.001 && quatAngleDeg(f.target.quat, quat) < 0.1;
      check(`(n) ${sLabel}の後に ${dLabel} ずれた観測: reacquire はちょうど 1 回・5 件前後で作り直して新しい姿勢へ移る・lastReacquire は最初の値のまま`, reacq === 1 && reseedAt >= 4 && reseedAt <= 6 && moved && first && JSON.stringify(first) === JSON.stringify(last), `reacquire=${reacq} reseedAt=${reseedAt} moved=${moved} first=${JSON.stringify(first)} last=${JSON.stringify(last)}`);
    }
  }
}

// ---- (o) ノイズありで固着しない（再レビュー S1） ----
{
  for (const [sig, off] of [[0.02, 0.15], [0.03, 0.25], [0.05, 0.2]]) {
    let stuck = 0;
    const errs = [];
    for (let seed = 1; seed <= 20; seed++) {
      const r = rng(1000 + seed);
      const gauss = () => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
      const f = createAnchorFilter();
      let t = 0;
      for (let i = 0; i < 30; i++, t += 100) f.add(obsAt(t, TRUE_POS), true);
      t += 5000;
      const T = [TRUE_POS[0] + off, TRUE_POS[1], TRUE_POS[2]];
      for (let i = 0; i < 200; i++, t += 100) f.add(obsAt(t, T.map((v) => v + sig * gauss())), true);
      const e = distV3(f.target.pos, T);
      errs.push(e);
      if (e > off / 2) stuck++;
    }
    check(`(o) 各軸 σ=${sig * 100}cm・空白の後に ${off * 100}cm ずれた観測を 20 秒: 固着（誤差 > ずれの半分）0 件（種 20 通り）`, stuck === 0, `固着 ${stuck}/20 誤差 中央値 ${mm(medianOf(errs))} 最悪 ${mm(Math.max(...errs))}`);
  }
}

// ---- (p) 固着の保険（再レビュー S2） ----
{
  // 空白の後、目標から 15cm と 25cm の観測が交互（まとまらない = 作り直しの条件を満たさない）
  const f = createAnchorFilter();
  let t = 0;
  for (let i = 0; i < 30; i++, t += 100) f.add(obsAt(t, TRUE_POS), true);
  t += 5000;
  const t0 = t;
  let at = -1;
  for (let i = 0; i < 50 && at < 0; i++, t += 100) {
    const off = i % 2 ? 0.25 : 0.15;
    if (f.add(obsAt(t, [TRUE_POS[0] + off, TRUE_POS[1], TRUE_POS[2]]), true) === "reseed") at = t - t0;
  }
  check("(p) 窓が 3 件未満のまま（まとまらない遠い観測だけ）3 秒続いたら、まとまりの条件なしで作り直す（fallbackReseeds）", at >= 3000 && at <= 3200 && f.stats.fallbackReseeds === 1 && f.target.pos[0] - TRUE_POS[0] > 0.1, `at=${at}ms fallback=${f.stats.fallbackReseeds} target.x-${(f.target.pos[0] - TRUE_POS[0]).toFixed(3)}`);
}

// ---- (q) ?avgMaxN= の下限（再レビュー S3） ----
{
  for (const maxN of [1, 2, 3]) {
    const f = createAnchorFilter({ maxN });
    let t = 0;
    for (let i = 0; i < 10; i++, t += 100) f.add(obsAt(t, TRUE_POS), true);
    const p2 = [TRUE_POS[0] + 0.05, TRUE_POS[1], TRUE_POS[2]];
    for (let i = 0; i < 10; i++, t += 100) f.add(obsAt(t, p2), true);
    check(`(q) maxN=${maxN} を渡しても上限は 3 で、目標が新しい位置へ更新される`, f.options.maxN === 3 && f.stats.n === 3 && distV3(f.target.pos, p2) < 0.001, `options.maxN=${f.options.maxN} n=${f.stats.n} ${mm(distV3(f.target.pos, p2))}`);
  }
}

// ---- (r) 角速度（xr-motion.ts。再レビュー S4） ----
{
  const m = createAngularRateMeter();
  const v1 = m.update(3, 1000, [0, 0, 0, 1]);
  const v2 = m.update(3, 1100, yawQuat(10));
  const v3 = m.update(3, 1100, yawQuat(50));
  const v4 = m.update(4, 1200, yawQuat(10));
  const v5 = m.update(4, 1300, yawQuat(10));
  check("(r) 角速度: 世代の最初の姿勢は未測定（null）・2 つ目で 10°/0.1s = 100°/s・同じ時刻は変えない・世代が変わると未測定・止まっていれば 0", v1 === null && Math.abs(v2 - 100) < 1e-6 && v3 === v2 && v4 === null && m.value === 0 && v5 === 0, JSON.stringify([v1, v2, v3, v4, v5]));
}

// ---- (s) 2 解が交互に出る列（再レビュー S5） ----
{
  for (const pre of ["窓がある", "空白の後"]) {
    const r = rng(77);
    const f = createAnchorFilter();
    let t = 0;
    for (let i = 0; i < 30; i++, t += 100) f.add(obsAt(t, TRUE_POS), true);
    if (pre === "空白の後") t += 5000;
    let prev = f.target.pos;
    let maxStepLate = 0;
    let normalReseeds = 0;
    for (let i = 0; i < 80; i++, t += 100) {
      const off = i % 2 ? 0.19 : 0.11;
      const ev = f.add(obsAt(t, [TRUE_POS[0] + off + (r() * 2 - 1) * 0.003, TRUE_POS[1] + (r() * 2 - 1) * 0.003, TRUE_POS[2]]), true);
      if (ev === "reseed" && f.stats.fallbackReseeds === 0) normalReseeds++;
      if (i >= 40) maxStepLate = Math.max(maxStepLate, distV3(prev, f.target.pos));
      prev = f.target.pos;
    }
    // 最終確認 U1 以降: 窓が二峰（8 件以上・各群 3 件以上・0.05m）なら単純平均なので、窓がある場合は作り直しの前に窓が中間へ移る（作り直しは起きない）
    check(`(s) ${pre}: 11cm / 19cm が交互の列は通常の作り直しにならず、目標が観測ごとに往復しない（後半 40 件の 1 観測あたりの変化 < 1cm）・窓は二峰として単純平均（中間）`, normalReseeds === 0 && maxStepLate < 0.01 && f.stats.bimodalWindows > 0 && Math.abs(f.target.pos[0] - TRUE_POS[0] - 0.15) < 0.005, `二峰で見送り ${f.stats.bimodalRejected} 回 二峰の窓 ${f.stats.bimodalWindows} 回 通常の作り直し ${normalReseeds} 保険 ${f.stats.fallbackReseeds} 後半の最大の変化 ${mm(maxStepLate)} 目標 x+${(f.target.pos[0] - TRUE_POS[0]).toFixed(3)}`);
  }
}

// 小さな乱数の回転（各軸 sd [deg] の正規分布。yawDeg を足す）
function smallRot(g, sd, yawDeg = 0) {
  const x = (g() * sd * Math.PI) / 360;
  const y = ((g() * sd + yawDeg) * Math.PI) / 360;
  const z = (g() * sd * Math.PI) / 360;
  const w = Math.sqrt(Math.max(0, 1 - x * x - y * y - z * z));
  return [x, y, z, w];
}
const gaussOf = (r) => () => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());

// ---- (t) 回転ノイズありでの追従（最終レビュー T1・最終確認 U2） ----
// U2 でまとまりの上限を固定の 0.05m / 2.5° に戻したので、ノイズが大きいと作り直しにならないことがある。そのときは窓の更新か保険（3 秒）で
// 追いつく。判定は「作り直しの件数」ではなく「目標が新しい位置の 3cm 以内に来るまでの件数」（10Hz で 30 件 = 3 秒以内）
{
  for (const sig of [0.01, 0.02, 0.03]) {
    const at = [];
    let reseeds = 0;
    let fallbacks = 0;
    for (let s = 1; s <= 50; s++) {
      const r = rng(s * 17);
      const g = gaussOf(r);
      const f = createAnchorFilter();
      let t = 0;
      for (let i = 0; i < 30; i++, t += 100) f.add(obsAt(t, TRUE_POS, [0, 0, 0, 1]), true);
      t += 5000;
      const T = [TRUE_POS[0] + 0.15, TRUE_POS[1], TRUE_POS[2]];
      let a = -1;
      for (let i = 1; i <= 60; i++, t += 100) {
        f.add(obsAt(t, T.map((v) => v + sig * g()), smallRot(g, 1.5)), true);
        if (a < 0 && distV3(f.target.pos, T) < 0.03) a = i;
      }
      at.push(a < 0 ? 999 : a);
      reseeds += f.stats.reseeds - f.stats.fallbackReseeds;
      fallbacks += f.stats.fallbackReseeds;
    }
    const srt = sorted(at);
    check(`(t) 各軸 σ=${sig * 100}cm・回転 1.5° のノイズで空白の後の 15cm ずれ: 目標が 3cm 以内に来るまで中央 ≤ 7 件・最悪 ≤ 30 件（3 秒。50 本）`, srt[25] <= 7 && srt[49] <= 30, `中央 ${srt[25]} 最悪 ${srt[49]} 作り直し ${reseeds} 保険 ${fallbacks}`);
  }
}

// ---- (u) 保険の条件（最終レビュー T2） ----
{
  // (a) 空白の後に 11cm / 19cm が交互（二峰）→ 保険は片方の峰ではなく中間（約 15cm）へ
  const f = createAnchorFilter();
  let t = 0;
  for (let i = 0; i < 30; i++, t += 100) f.add(obsAt(t, TRUE_POS), true);
  t += 5000;
  for (let i = 0; i < 40; i++, t += 100) f.add(obsAt(t, [TRUE_POS[0] + (i % 2 ? 0.19 : 0.11), TRUE_POS[1], TRUE_POS[2]]), true);
  const x = f.target.pos[0] - TRUE_POS[0];
  check("(u) 空白の後に 11cm / 19cm が交互: 保険で作り直し、窓は二峰なので単純平均（中間 13〜17cm）", f.stats.fallbackReseeds === 1 && x > 0.13 && x < 0.17, `fallback=${f.stats.fallbackReseeds} x=${x.toFixed(3)}`);
  // (b) 低頻度（0.4〜0.8Hz）の近い観測だけ: 窓は 3 件にならないが保険は発動しない
  let fb = 0;
  let maxStep = 0;
  for (const hz of [0.4, 0.6, 0.8]) {
    for (let s = 1; s <= 20; s++) {
      const r = rng(s * 31 + Math.round(hz * 10));
      const g = gaussOf(r);
      const h = createAnchorFilter();
      let tt = 0;
      for (let i = 0; i < 20; i++, tt += 100) h.add(obsAt(tt, TRUE_POS), true);
      let prev = h.target.pos;
      while (tt < 120000) {
        tt += (1000 / hz) * (0.8 + 0.4 * r());
        h.add(obsAt(tt, TRUE_POS.map((v) => v + 0.01 * g())), true);
        maxStep = Math.max(maxStep, distV3(prev, h.target.pos));
        prev = h.target.pos;
      }
      fb += h.stats.fallbackReseeds;
    }
  }
  check("(u) 低頻度（0.4〜0.8Hz）の近い観測（σ1cm）だけでは 120 秒 × 60 本で保険が一度も発動しない", fb === 0, `fallback=${fb} 目標の 1 観測あたりの最大の変化 ${mm(maxStep)}`);
}

// ---- (v) 窓の推定は状態を持たない（最終確認 U1。T3 の群の選択・ヒステリシスのテストを置き換え） ----
{
  // (v1) ヨー σ2°（奥行 σ2〜3cm・横 σ1cm）、3Hz と 5Hz: 1 観測あたり 1° 超のヨーの変化の割合と最大（Fable の検証で 163733e は 3Hz 1.05%）
  const yawRun = (hz, depthSig, seed) => {
    const r = rng(seed);
    const g = gaussOf(r);
    const f = createAnchorFilter();
    let t = 0;
    let prev = null;
    let big = 0;
    let n = 0;
    let maxDeg = 0;
    while (t < 120000) {
      t += (1000 / hz) * (0.8 + 0.4 * r());
      f.add(obsAt(t, [TRUE_POS[0] + 0.01 * g(), TRUE_POS[1] + 0.01 * g(), TRUE_POS[2] + depthSig * g()], qTimes(TRUE_Q, yawQuat(2 * g()))), true);
      const q = f.target.quat;
      if (prev && t > 5000) {
        const d = quatAngleDeg(prev, q);
        n++;
        if (d > 1) big++;
        maxDeg = Math.max(maxDeg, d);
      }
      prev = q;
    }
    return { big, n, maxDeg, bi: f.stats.bimodalWindows };
  };
  for (const [hz, limit] of [[3, 0.015], [5, 0.003]]) {
    let big = 0;
    let n = 0;
    let maxDeg = 0;
    let bi = 0;
    for (const depthSig of [0.02, 0.03]) {
      for (let seed = 1; seed <= 20; seed++) {
        const o = yawRun(hz, depthSig, seed * 131 + hz);
        big += o.big;
        n += o.n;
        maxDeg = Math.max(maxDeg, o.maxDeg);
        bi += o.bi;
      }
    }
    check(`(v) ヨー σ2°・奥行 σ2〜3cm・横 σ1cm・${hz}Hz（120 秒 × 40 本）: 1 観測あたり 1° 超のヨーの変化が ${limit * 100}% 以下・最大 2.7° 以下`, big / n <= limit && maxDeg <= 2.7, `1° 超 ${((big / n) * 100).toFixed(2)}%（${big}/${n}）最大 ${maxDeg.toFixed(2)}° 二峰の窓 ${bi} 回`);
  }
  // 単峰のノイズを窓の二峰と誤判定する割合（U1: 8 件以上・各群 3 件以上にした目的。4 件・各群 2 件だと増える）
  for (const [hz, limit] of [[2, 0.02], [3, 0.035]]) {
    let bi = 0;
    let n = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const o = yawRun(hz, 0.03, seed * 131 + hz);
      bi += o.bi;
      n += o.n;
    }
    // 参考: 4 件・各群 2 件で判定すると 2Hz で約 10%、3Hz で約 5%
    check(`(v) 単峰のノイズ（ヨー σ2°・奥行 σ3cm・${hz}Hz）で窓を二峰と誤判定する割合が ${(limit * 100).toFixed(1)}% 以下`, bi / n <= limit, `${((bi / n) * 100).toFixed(2)}%（${bi}/${n}）`);
  }
  // 大きな外れ値は位置と回転の両方から除く（追補 A6 の意図）: 15% の観測が位置 8cm・ヨー 3° ずれても、ヨーは引かれない
  {
    const r = rng(77);
    const g = gaussOf(r);
    const f = createAnchorFilter();
    let t = 0;
    for (let i = 0; i < 300; i++, t += 100) {
      const bad = i > 0 && r() < 0.08;
      f.add(obsAt(t, bad ? [TRUE_POS[0] + 0.08, TRUE_POS[1], TRUE_POS[2]] : TRUE_POS.map((v) => v + 0.005 * g()), qTimes(TRUE_Q, yawQuat(bad ? 2.5 : 1 * g()))), true);
    }
    const yawBias = quatAngleDeg(f.target.quat, TRUE_Q);
    // 両方から除かないと約 0.12°
    check("(v) 位置で大きく外れた観測（8cm。閾値の 2 倍超）は回転からも除く: 8% が 8cm・ヨー 2.5° ずれてもヨーの偏りが 0.08° 以下", yawBias <= 0.08 && distV3(f.target.pos, TRUE_POS) < 0.005, `ヨーの偏り ${yawBias.toFixed(3)}° 位置 ${mm(distV3(f.target.pos, TRUE_POS))}`);
  }
  // (v2) Codex 高 1: 空白の後に 11 / 19cm が 6:4 → 保険の後の次の観測で目標が 1cm 超動かない（片方の解へ飛ばない）
  {
    const f = createAnchorFilter();
    let t = 0;
    for (let i = 0; i < 30; i++, t += 100) f.add(obsAt(t, TRUE_POS), true);
    t += 5000;
    let afterFb = null;
    let nextMove = null;
    for (let i = 0; i < 60 && nextMove === null; i++, t += 100) {
      f.add(obsAt(t, [TRUE_POS[0] + [0.11, 0.11, 0.19, 0.11, 0.19][i % 5], TRUE_POS[1], TRUE_POS[2]]), true);
      if (afterFb) nextMove = distV3(afterFb, f.target.pos);
      else if (f.stats.fallbackReseeds > 0) afterFb = f.target.pos;
    }
    check("(v) 空白の後に 11 / 19cm が 6:4: 保険の後の次の観測で目標が 1cm 超動かない（保険と窓の推定が同じ）", nextMove !== null && nextMove < 0.01, `保険の後 x=${afterFb ? (afterFb[0] - TRUE_POS[0]).toFixed(3) : "-"} 次の観測での変化 ${nextMove === null ? "-" : mm(nextMove)}`);
  }
  // (v3) Codex 高 2: 誤解（8cm）が一時 8 割 → 正解 6 割・誤解 4 割が続くと、10 秒以内に目標の誤差が 4cm 以下（張り付かない）
  {
    const r = rng(55);
    const g = gaussOf(r);
    const f = createAnchorFilter();
    let t = 0;
    for (let i = 0; i < 30; i++, t += 100) f.add(obsAt(t, TRUE_POS), true);
    const wrongAt = (tt) => [TRUE_POS[0] + 0.08 + 0.005 * g(), TRUE_POS[1] + 0.005 * g(), TRUE_POS[2] + 0.005 * g()];
    const rightAt = () => TRUE_POS.map((v) => v + 0.005 * g());
    for (let i = 0; i < 50; i++, t += 100) f.add(obsAt(t, r() < 0.8 ? wrongAt(t) : rightAt()), true);
    const errWrong = distV3(f.target.pos, TRUE_POS);
    let within = -1;
    for (let i = 0; i < 300; i++, t += 100) {
      f.add(obsAt(t, r() < 0.4 ? wrongAt(t) : rightAt()), true);
      if (within < 0 && i >= 0 && distV3(f.target.pos, TRUE_POS) <= 0.04) within = i;
    }
    const errEnd = distV3(f.target.pos, TRUE_POS);
    check("(v) 誤解（8cm）が一時 8 割の後に正解 6 割・誤解 4 割: 10 秒以内に目標の誤差が 4cm 以下、30 秒後も 4cm 以下（張り付かない）", within >= 0 && within <= 100 && errEnd <= 0.04, `誤解 8 割の後 ${mm(errWrong)} → ${within} 件目で 4cm 以下 → 30 秒後 ${mm(errEnd)}`);
  }
  // (v4) Codex 高 3: 真値 0 のまま 10・14・18・22・26cm のランプ（RMS 5.7cm）では作り直さない
  {
    const f = createAnchorFilter();
    let t = 0;
    for (let i = 0; i < 30; i++, t += 100) f.add(obsAt(t, TRUE_POS), true);
    for (const off of [0.1, 0.14, 0.18, 0.22, 0.26]) {
      f.add(obsAt(t, [TRUE_POS[0] + off, TRUE_POS[1], TRUE_POS[2]]), true);
      t += 100;
    }
    check("(v) 真値のまま 10・14・18・22・26cm のランプ（まとまらない）では作り直さない", f.stats.reseeds === 0 && distV3(f.target.pos, TRUE_POS) < 0.001, `reseeds=${f.stats.reseeds} 見送り=${f.stats.reseedRejected} 目標のずれ ${mm(distV3(f.target.pos, TRUE_POS))}`);
  }
  // (v5) Fable の sim-mix と同じ作り: 別解 30%@4cm（二峰の閾値 5cm 未満 = 頑健平均で除ける）は偏らない
  for (const firstWrong of [false, true]) {
    const errs = [];
    for (let seed = 1; seed <= 20; seed++) {
      const r = rng(seed * 101);
      const g = gaussOf(r);
      const f = createAnchorFilter();
      let t = 0;
      for (let i = 0; i < 300; i++, t += 100) {
        const wrong = i === 0 ? firstWrong : r() < 0.3;
        f.add(obsAt(t, [TRUE_POS[0] + (wrong ? 0.04 : 0) + 0.005 * g(), TRUE_POS[1] + 0.005 * g(), TRUE_POS[2] + 0.005 * g()], wrong ? [0, 0, 0, 1] : yawQuat(0.2 * g())), true);
      }
      errs.push(distV3(f.target.pos, TRUE_POS));
    }
    check(`(v) 別解 30%@4cm が混ざる（1 件目が${firstWrong ? "別解" : "正解"}。sim-mix と同じ作り）: 30 秒後の目標の誤差が最悪 ≤ 5mm`, Math.max(...errs) <= 0.005, `中央 ${mm(medianOf(errs))} 最悪 ${mm(Math.max(...errs))}`);
  }
  // (v6) 別解 30%@15cm が続く（窓は二峰 → 単純平均）: 偏りは 3 割 × 15cm ≈ 4.5cm 程度で、往復しない（README の「数 cm の偏り」）
  {
    let maxStep = 0;
    const errs = [];
    for (let seed = 1; seed <= 20; seed++) {
      const r = rng(seed * 101);
      const g = gaussOf(r);
      const f = createAnchorFilter();
      let t = 0;
      let prev = null;
      for (let i = 0; i < 300; i++, t += 100) {
        const wrong = i > 0 && r() < 0.3;
        f.add(obsAt(t, [TRUE_POS[0] + (wrong ? 0.15 : 0) + 0.005 * g(), TRUE_POS[1] + 0.005 * g(), TRUE_POS[2] + 0.005 * g()]), true);
        if (i >= 100 && prev) maxStep = Math.max(maxStep, distV3(prev, f.target.pos));
        prev = f.target.pos;
      }
      errs.push(distV3(f.target.pos, TRUE_POS));
    }
    console.log(`  参考 別解 30%@15cm が持続: 30 秒後の偏り 中央 ${mm(medianOf(errs))} 最悪 ${mm(Math.max(...errs))}・後半の 1 観測あたりの最大の変化 ${mm(maxStep)}`);
    check("(v) 別解 30%@15cm が持続: 偏りは最悪 8cm 以下（単純平均で 3 割 × 15cm 前後。README の既知の制約）", Math.max(...errs) <= 0.08, `中央 ${mm(medianOf(errs))} 最悪 ${mm(Math.max(...errs))}`);
  }
  // (v7) 45%@6cm: 往復しない（1cm 超の変化の後、1 秒以内に逆向きへ 1cm 超で戻らない）
  let backForth = 0;
  let changes = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const r = rng(seed * 101);
    const g = gaussOf(r);
    const f = createAnchorFilter();
    let t = 0;
    let prev = null;
    const big = [];
    for (let i = 0; i < 300; i++, t += 100) {
      const w = i > 0 && r() < 0.45;
      f.add(obsAt(t, [TRUE_POS[0] + (w ? 0.06 : 0) + 0.005 * g(), TRUE_POS[1] + 0.005 * g(), TRUE_POS[2] + 0.005 * g()]), true);
      if (i >= 100 && prev && distV3(prev, f.target.pos) > 0.01) big.push({ i, dx: f.target.pos[0] - prev[0] });
      prev = f.target.pos;
    }
    changes += big.length;
    for (let k = 1; k < big.length; k++) if (big[k].i - big[k - 1].i <= 10 && Math.sign(big[k].dx) !== Math.sign(big[k - 1].dx)) backForth++;
  }
  check("(v) 別解 45%@6cm が混ざる: 往復しない（1 秒以内の往復 0 回）", backForth === 0, `1cm 超の変化 ${changes} 回（20 本 × 200 観測）・1 秒以内の往復 ${backForth} 回`);
}

// ---- (w) 保険の観測の数え方（最終レビュー T4・T2） ----
{
  // 目標の反対側に 15cm ずつ（まとまらない = 通常の作り直しにならない）遠い観測が 2.9 秒おき: windowMs より前は数えないので発動しない
  const opp = (i) => [TRUE_POS[0] + (i % 2 ? 0.15 : -0.15), TRUE_POS[1], TRUE_POS[2]];
  const f = createAnchorFilter();
  let t = 0;
  for (let i = 0; i < 30; i++, t += 100) f.add(obsAt(t, TRUE_POS), true);
  t += 5000;
  for (let i = 0; i < 10; i++, t += 2900) f.add(obsAt(t, opp(i)), true);
  check("(w) 2.9 秒おきの遠い観測（まとまらない）では、windowMs より前の観測を数えないので保険が発動しない", f.stats.fallbackReseeds === 0 && f.stats.reseeds === 0, `fallback=${f.stats.fallbackReseeds} reseeds=${f.stats.reseeds}`);
  // 3 秒は「窓が 3 件未満になった時」から数える: 空白の後に遠い観測（まとまらない）が 1 秒 → 空白 → 再取得の後に同じ遠い観測が続いても、
  // 保険は 2 回目の再取得から 3 秒たつまで発動しない（前の 3 件未満の状態の開始時刻を引きずらない）
  const g = createAnchorFilter();
  t = 0;
  for (let i = 0; i < 30; i++, t += 100) g.add(obsAt(t, TRUE_POS), true);
  t += 5000;
  for (let i = 0; i < 10; i++, t += 100) g.add(obsAt(t, opp(i)), true);
  t += 5000;
  const t2 = t;
  let at = -1;
  for (let i = 0; i < 40 && at < 0; i++, t += 100) {
    g.add(obsAt(t, opp(i)), true);
    if (g.stats.fallbackReseeds > 0) at = t - t2;
  }
  check("(w) 保険の 3 秒は、いまの 3 件未満の状態が始まった時（再取得）から数える（前の状態の開始時刻を引きずらない）", at >= 3000, `2 回目の再取得から ${at}ms で発動`);
  // 窓が 3 件に戻ったら数え直す: 空白の後に遠い 2 件 → 近い 3 件（窓が 3 件）→ 10Hz で近い観測 → 観測の間隔が 1.2 秒に落ちて遠い観測だけ
  const h = createAnchorFilter();
  t = 0;
  for (let i = 0; i < 30; i++, t += 100) h.add(obsAt(t, TRUE_POS), true);
  t += 5000;
  h.add(obsAt(t, opp(0)), true);
  t += 100;
  h.add(obsAt(t, opp(1)), true);
  t += 100;
  for (let i = 0; i < 10; i++, t += 100) h.add(obsAt(t, TRUE_POS), true);
  let lowStart = -1;
  let fbAt = -1;
  for (let i = 0; i < 12 && fbAt < 0; i++, t += 1200) {
    h.add(obsAt(t, opp(i)), true);
    if (lowStart < 0 && h.stats.n < MIN_WINDOW) lowStart = t;
    if (h.stats.fallbackReseeds > 0) fbAt = t;
  }
  check("(w) 窓が 3 件に戻ったら保険の数え方をやり直す（3 件未満の状態が 3 秒続くまで発動しない）", lowStart >= 0 && (fbAt < 0 || fbAt - lowStart >= 3000), `3 件未満になった ${lowStart}ms・保険 ${fbAt}ms（差 ${fbAt < 0 ? "-" : fbAt - lowStart}ms）`);
}

// ---- (w2) 保険の推定: 遠い観測が二峰なら多数派でも全体の平均（最終レビュー T2） ----
{
  const f = createAnchorFilter();
  let t = 0;
  for (let i = 0; i < 30; i++, t += 100) f.add(obsAt(t, TRUE_POS), true);
  t += 5000;
  let atFallback = null;
  for (let i = 0; i < 45 && !atFallback; i++, t += 100) {
    // 11, 11, 19, 11, 19 の繰り返し（多数派の群がちょうど 6 割。連続 5 件にいつも 19cm が 2 件あるので通常の作り直しは二峰で見送られる）
    f.add(obsAt(t, [TRUE_POS[0] + ([0.11, 0.11, 0.19, 0.11, 0.19][i % 5]), TRUE_POS[1], TRUE_POS[2]]), true);
    if (f.stats.fallbackReseeds > 0) atFallback = f.target.pos[0] - TRUE_POS[0];
  }
  check("(w2) 保険の時点の目標は、窓（期間中の観測）が二峰なら（多数派が 6 割でも）片方の峰（11cm）ではなく単純平均（約 14.2cm）", atFallback !== null && Math.abs(atFallback - (3 * 0.11 + 2 * 0.19) / 5) < 0.005, `保険の時点の x=${atFallback?.toFixed(4)}`);
}

// ---- (x) 再取得の理由と直接モードの回数（最終レビュー T5） ----
{
  const f = createAnchorFilter();
  let t = 0;
  for (let i = 0; i < 30; i++, t += 100) f.add(obsAt(t, TRUE_POS), true);
  f.clearWindow();
  for (let k = 0; k < 15; k++, t += 100) f.add(obsAt(t, TRUE_POS, TRUE_Q, false, 1000 + k * 100), true);
  f.add(obsAt(t, TRUE_POS), true);
  check("(x) 配置変更の直後に長い LIMITED（直接モード）が来ても、再取得の理由は最初の layout のまま", f.lastReacquire?.reason === "layout", JSON.stringify(f.lastReacquire));
  const g = createAnchorFilter();
  t = 0;
  for (let i = 0; i < 30; i++, t += 100) g.add(obsAt(t, TRUE_POS), true);
  for (let k = 0; k < 5; k++, t += 100) g.add(obsAt(t, TRUE_POS, TRUE_Q, false, 1200 + k * 100), true);
  g.clearWindow();
  for (let k = 0; k < 5; k++, t += 100) g.add(obsAt(t, TRUE_POS, TRUE_Q, false, 1700 + k * 100), true);
  g.add(obsAt(t, TRUE_POS), true);
  check("(x) 直接モード中に clearWindow しても directEntries を二重に数えない（1 回）・再取得の理由は direct", g.stats.directEntries === 1 && g.lastReacquire?.reason === "direct", `directEntries=${g.stats.directEntries} ${JSON.stringify(g.lastReacquire)}`);
}

// ---- (y) 通常の使い方で保険が発動しない（最終レビュー T6） ----
{
  const run = (sig, hz, seed) => {
    const r = rng(seed);
    const g = gaussOf(r);
    const f = createAnchorFilter();
    let t = 0;
    let lookingUntil = 0;
    let looking = true;
    let limitedUntil = -1;
    let limitedStart = 0;
    let justified = 0;
    let unjustified = 0;
    while (t < 180000) {
      t += (-Math.log(r() || 1e-9) * 1000) / hz;
      if (t > lookingUntil) {
        looking = !looking;
        lookingUntil = t + (looking ? 300 + r() * 4700 : 200 + r() * 5800);
      }
      if (!looking) continue;
      if (t > limitedUntil && r() < 0.03) {
        limitedStart = t;
        limitedUntil = t + 200 + r() * 2300;
      }
      const lim = t < limitedUntil;
      const before = f.target;
      const fb0 = f.stats.fallbackReseeds;
      f.add({ tMs: t, pos: TRUE_POS.map((v) => v + sig * g()), quat: yawQuat(0.3 * g()), xrNormal: !lim, limitedMs: lim ? t - limitedStart : 0 }, true);
      if (f.stats.fallbackReseeds > fb0) {
        if (before && distV3(f.target.pos, TRUE_POS) < distV3(before.pos, TRUE_POS)) justified++;
        else unjustified++;
      }
    }
    return { justified, unjustified };
  };
  for (const sig of [0.01, 0.02, 0.03]) {
    let j = 0;
    let u = 0;
    for (const hz of [0.4, 2, 5, 10]) {
      for (let s = 1; s <= 20; s++) {
        const o = run(sig, hz, s * 977 + hz * 10);
        j += o.justified;
        u += o.unjustified;
      }
    }
    const ok = sig <= 0.02 ? j + u === 0 : u === 0;
    check(`(y) 通常の使い方（σ=${sig * 100}cm・0.4〜10Hz・見る / 見ない・たまに LIMITED、180 秒 × 80 本）: 保険は ${sig <= 0.02 ? "一度も発動しない" : "発動したら必ず目標の誤差が減る"}`, ok, `発動 ${j + u} 回（誤差が減った ${j}・減らなかった ${u}）`);
  }
}

// ---- (z) isFastMotion（最終レビュー T6） ----
check("(z) isFastMotion: XR 無しは false・未測定（null）は true・上限超えは true・上限以下は false", isFastMotion(null, 90, false) === false && isFastMotion(500, 90, false) === false && isFastMotion(null, 90, true) === true && isFastMotion(91, 90, true) === true && isFastMotion(90, 90, true) === false && isFastMotion(0, 90, true) === false);

// ================= 2. xr-source.ts（08-11 のコピー） =================
const vite = await createServer({ server: { middlewareMode: true }, logLevel: "silent" });
const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
try {
  const { startXrSource, loadEngine } = await vite.ssrLoadModule("/demos/08-11-splatoon-8thwall-board/xr-source.ts");
  const normal = (x = 0) => ({
    position: { x, y: 1, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 },
    intrinsics: [1.5, 0, 0, 0, 0, 2, 0, 0, 0, 0, -1, -1, 0, 0, -0.1, 0],
    trackingStatus: "NORMAL", trackingReason: "UNSPECIFIED",
  });
  const limited = (x = 0, reason = "EXCESSIVE_MOTION") => ({ ...normal(x), trackingStatus: "LIMITED", trackingReason: reason });
  const { STALE_FRAMES, STALE_MS, ERROR_SHOW_MS } = await vite.ssrLoadModule("/demos/08-11-splatoon-8thwall-board/xr-source.ts");
  /** 08-10 のテストと同じ XR8 のモック（callback の順序と引数は実機に合わせる） */
  const makeXr = () => {
    const m = {
      video: { videoWidth: 640, videoHeight: 480, readyState: 2 },
      bridge: null, configured: null, projection: null, projections: 0, runOptions: null,
      preRenders: 0, postRenders: 0, stopped: false, nextReality: undefined, repeatFrame: false, canvas: null,
    };
    m.engine = {
      XrController: {
        configure: (value) => { m.configured = value; },
        pipelineModule: () => ({ name: "reality" }),
        updateCameraProjectionMatrix: (value) => { m.projection = value; m.projections++; },
      },
      XrConfig: { device: () => ({ MOBILE: "mobile" }) },
      addCameraPipelineModules: (modules) => { m.bridge = modules[1]; },
      run: (value) => {
        m.runOptions = value;
        const { canvas } = value;
        m.canvas = canvas;
        m.bridge.onCameraStatusChange({ status: "hasVideo", video: m.video });
        m.bridge.onStart({ canvas, canvasWidth: canvas.width, canvasHeight: canvas.height });
        m.bridge.onAttach({ framework: {}, canvas, videoWidth: m.video.videoWidth, videoHeight: m.video.videoHeight });
      },
      runPreRender: () => {
        m.preRenders++;
        m.bridge.onUpdate({ frameStartResult: { repeatFrame: m.repeatFrame }, processCpuResult: { reality: m.nextReality } });
      },
      runPostRender: () => { m.postRenders++; },
      stop: () => { m.stopped = true; },
    };
    return m;
  };
  globalThis.HTMLMediaElement = { HAVE_CURRENT_DATA: 2 };
  const logs = [];
  const x1 = makeXr();
  globalThis.window = { XR8: x1.engine };
  const canvas1 = { width: 300, height: 150 };
  const source = await startXrSource(canvas1, undefined, { log: (line) => logs.push(line), afterLimitedMs: 1000 });
  assert.equal(await source.waitForVideo(), x1.video);
  assert.equal(x1.configured.scale, "absolute");
  assert.equal(x1.runOptions.ownRunLoop, false);
  assert.equal(x1.projection.cam.pixelRectWidth, 640);
  check("xr: 開始時の 1 回目の投影設定（まだ姿勢が無い）は invalidate として数えない", source.invalidateCounts.projection === 0 && source.generation === 0 && x1.projections === 1, JSON.stringify(source.invalidateCounts));

  // ---- NORMAL ----
  x1.nextReality = normal(0.2);
  source.preRender();
  check("xr: NORMAL の姿勢を採用し、生の trackingReason が残る", source.status === "NORMAL" && source.pose.position.x === 0.2 && source.trackingReason === "UNSPECIFIED" && source.intrinsicsOk);
  const firstPose = source.pose;
  x1.nextReality.position.x = 99;
  check("xr: XR8 の内部オブジェクトを参照保持しない", firstPose.position.x === 0.2);

  // ---- LIMITED: invalidate しない・有効なら更新・無効なら保持 ----
  const gen0 = source.generation;
  const inv0 = source.invalidatedAt;
  x1.nextReality = limited(0.25);
  source.preRender();
  check("xr: LIMITED で invalidate しない（世代・invalidatedAt が同じ）", source.generation === gen0 && source.invalidatedAt === inv0);
  check("xr: LIMITED でも有効な姿勢なら pose を更新し、status と trackingReason は生の値", source.pose?.position.x === 0.25 && source.status === "LIMITED" && source.trackingReason === "EXCESSIVE_MOTION", `${source.status} ${source.trackingReason}`);
  check("xr: NORMAL → LIMITED で limitedCount=1・limitedSinceMs が入り、event=limited-start をログに出す", source.limitedCount === 1 && source.limitedSinceMs !== null && logs.some((l) => /event=limited-start status=LIMITED reason=EXCESSIVE_MOTION/.test(l)), logs.at(-1));
  x1.nextReality = { ...limited(Number.NaN, "INITIALIZING") };
  source.preRender();
  check("xr: LIMITED で姿勢が無効（NaN）なら最後の有効な姿勢を保持し、trackingReason は更新", source.pose?.position.x === 0.25 && source.trackingReason === "INITIALIZING" && source.generation === gen0);
  x1.nextReality = { ...limited(0.3), rotation: { x: 0, y: 0, z: 0, w: 2 } };
  source.preRender();
  check("xr: 単位四元数でない姿勢も無効として保持", source.pose?.position.x === 0.25);
  x1.nextReality = undefined;
  source.preRender();
  check("xr: reality が無ければ status=NO_REALITY・姿勢は保持・invalidate しない", source.status === "NO_REALITY" && source.pose?.position.x === 0.25 && source.generation === gen0);
  await new Promise((r) => setTimeout(r, 20));
  x1.nextReality = normal(0.26);
  source.preRender();
  check("xr: NORMAL に戻ると limited-end（続いた時間）をログに出し、lastLimitedMs が入る", source.status === "NORMAL" && source.limitedSinceMs === null && source.lastLimitedMs >= 15 && logs.some((l) => /event=limited-end from=NO_REALITY .*durationMs=\d+/.test(l)), `${source.lastLimitedMs.toFixed(0)}ms ${logs.filter((l) => /limited-end/.test(l)).at(-1)}`);

  // ---- 姿勢の飛び（診断のみ） ----
  x1.nextReality = limited(0.3);
  source.preRender();
  x1.nextReality = normal(0.9);
  source.preRender();
  check("xr: LIMITED → NORMAL の直後に 0.6m 飛ぶと jump（afterLimited）として数え、姿勢はそのまま採用（振る舞いは変えない）", source.jumps.count === 1 && source.jumps.afterLimited === 1 && source.pose.position.x === 0.9 && Math.abs(source.jumps.maxPosM - 0.6) < 1e-9 && source.jumps.last.afterLimited === true && logs.some((l) => /event=jump posM=0\.600 .*afterLimited=1/.test(l)), JSON.stringify(source.jumps));
  await new Promise((r) => setTimeout(r, 1050));
  x1.nextReality = { ...normal(0.9), rotation: { x: 0, y: Math.sin(Math.PI / 18), z: 0, w: Math.cos(Math.PI / 18) } };
  source.preRender();
  check("xr: NORMAL が続いている間の 20° の回転の飛びは afterLimited ではない jump", source.jumps.count === 2 && source.jumps.afterLimited === 1 && Math.abs(source.jumps.last.deg - 20) < 1e-6 && source.jumps.last.afterLimited === false, JSON.stringify(source.jumps.last));
  x1.nextReality = normal(0.95);
  source.preRender();
  check("xr: 回転が 20° 戻るのも飛び（count=3）", source.jumps.count === 3, `count=${source.jumps.count}`);
  x1.nextReality = normal(1.0);
  source.preRender();
  check("xr: 位置 5cm の変化は飛びではない", source.jumps.count === 3);

  // ---- repeatFrame ----
  {
    const frameMs = source.frameMs;
    await new Promise((r) => setTimeout(r, 5));
    x1.repeatFrame = true;
    x1.nextReality = limited(5);
    for (let i = 0; i < 3; i++) source.preRender();
    check("xr: repeatFrame では姿勢・鮮度・status を更新しない", source.frameMs === frameMs && source.pose.position.x === 1.0 && source.status === "NORMAL");
    x1.repeatFrame = false;
  }

  // ---- 鮮度切れで invalidate しない ----
  {
    const gen = source.generation;
    await new Promise((r) => setTimeout(r, 600));
    x1.repeatFrame = true;
    source.preRender();
    x1.repeatFrame = false;
    check("xr: 姿勢が 600ms 古くなっても invalidate しない（pose は最後の値のまま）", source.generation === gen && source.pose?.position.x === 1.0 && performance.now() - source.frameMs >= 590);
  }

  // ---- 不正 intrinsics: 姿勢は捨てない ----
  {
    const gen = source.generation;
    const k = source.intrinsics;
    x1.nextReality = { ...normal(1.1), intrinsics: [1] };
    source.preRender();
    check("xr: 不正な intrinsics は intrinsicsOk=false・intrinsics は最後の有効な値・姿勢は更新・invalidate しない", !source.intrinsicsOk && source.intrinsics === k && source.pose.position.x === 1.1 && source.generation === gen);
    x1.nextReality = normal(1.1);
    source.preRender();
    check("xr: intrinsics が戻ると intrinsicsOk=true", source.intrinsicsOk);
  }

  // ---- 向き変更: invalidate（A1: 次の有効な reality まで pose=null。R3: 直後の reality は 2 フレームかつ 150ms 捨てる） ----
  {
    const before = source.invalidatedAt;
    const gen = source.generation;
    await new Promise((r) => setTimeout(r, 2));
    x1.bridge.onDeviceOrientationChange({ orientation: 90, videoWidth: 640, videoHeight: 480 });
    check("xr: 端末の向き変更で invalidate（orientation）・pose=null・世代が進む", source.pose === null && source.invalidatedAt > before && source.generation === gen + 1 && source.invalidateCounts.orientation === 1 && logs.some((l) => /event=invalidate cause=orientation/.test(l)));
    x1.nextReality = undefined;
    source.preRender();
    check("xr: invalidate の後、reality が無いフレームでは pose は null のまま（古い原点の姿勢を戻さない）", source.pose === null);
    const tInv = performance.now();
    x1.nextReality = limited(9.9);
    for (let k = 0; k < STALE_FRAMES; k++) source.preRender();
    check(`xr: invalidate の直後の ${STALE_FRAMES} フレームの reality は（古い原点で計算済みかもしれないので）姿勢に使わない`, source.pose === null && source.status === "LIMITED");
    for (let k = 0; k < 3; k++) source.preRender();
    check(`xr: ${STALE_FRAMES} フレームを過ぎても ${STALE_MS}ms 経つまでは姿勢に使わない`, source.pose === null && performance.now() - tInv < STALE_MS, `${(performance.now() - tInv).toFixed(0)}ms`);
    await new Promise((r) => setTimeout(r, STALE_MS + 10));
    x1.nextReality = limited(0.7);
    source.preRender();
    check("xr: 2 フレームかつ 150ms を過ぎた有効な reality（LIMITED でも）で pose が戻り、invalidate 前の姿勢（1.1）とは比べない（飛びにしない）", source.pose?.position.x === 0.7 && source.jumps.count === 3, `count=${source.jumps.count}`);
    x1.nextReality = normal(3.0);
    source.preRender();
    check("xr: invalidate の後の姿勢同士（0.7 → 3.0）は飛びとして数える", source.jumps.count === 4, `count=${source.jumps.count}`);
  }
  /** invalidate の後の捨てる期間を通す */
  const passStale = async (reality) => {
    x1.nextReality = reality;
    for (let k = 0; k < STALE_FRAMES; k++) source.preRender();
    await new Promise((r) => setTimeout(r, STALE_MS + 10));
    source.preRender();
  };

  // ---- 映像サイズ変更: 投影の更新で invalidate、同じフレームの reality は捨てる ----
  {
    const projections = x1.projections;
    const gen = source.generation;
    x1.video.videoWidth = 800;
    x1.video.videoHeight = 600;
    x1.nextReality = normal(0.8);
    source.preRender();
    check("xr: 映像サイズ変更で投影を送り直し、invalidate（projection）・同じフレームの reality は捨てる", x1.projections === projections + 1 && x1.projection.cam.pixelRectWidth === 800 && source.pose === null && source.generation === gen + 1 && source.invalidateCounts.projection === 1 && canvas1.width === 800);
    source.preRender();
    check("xr: 投影更新の後も次のフレームはまだ捨てる（R3）", source.pose === null);
    await passStale(normal(0.8));
    check("xr: 捨てる期間の後に採用", source.pose?.position.x === 0.8);
  }

  // ---- onCameraStatusChange("failed"): invalidate + lastError（3 秒は残す）。カメラの状態は status と別（R9） ----
  {
    const gen = source.generation;
    const limitedCount = source.limitedCount;
    x1.bridge.onCameraStatusChange({ status: "failed" });
    check("xr: カメラ失敗（failed）で invalidate（cameraFailed）・cameraStatus=failed（status は NORMAL のまま = LIMITED の集計に入れない）・lastError", source.generation === gen + 1 && source.invalidateCounts.cameraFailed === 1 && source.cameraStatus === "failed" && source.status === "NORMAL" && source.limitedCount === limitedCount && /カメラ取得に失敗/.test(source.lastError) && source.pose === null);
    await passStale(normal(0.5));
    check("xr: reality が届けば姿勢は戻るが、lastError は 3 秒たつまで残る（主表示が 1 フレームで消えない）", source.pose?.position.x === 0.5 && /カメラ取得に失敗/.test(source.lastError));
  }

  // ---- onException: invalidate しないが lastError（3 秒は残す） ----
  {
    const gen = source.generation;
    const limitedCount = source.limitedCount;
    x1.bridge.onException(new Error("テストの例外"));
    check("xr: onException は invalidate しない（原点が変わったとは限らない）が cameraStatus=exception・lastError に残し、ログに出す。status と LIMITED の集計は変えない", source.generation === gen && source.cameraStatus === "exception" && source.status === "NORMAL" && source.limitedCount === limitedCount && /テストの例外/.test(source.lastError) && source.pose?.position.x === 0.5 && logs.some((l) => /event=xr-exception/.test(l)));
    x1.nextReality = normal(0.5);
    source.preRender();
    check("xr: onException の直後に reality が届いても lastError は残り、cameraStatus は hasVideo に戻る", /テストの例外/.test(source.lastError) && source.cameraStatus === "hasVideo");
    await new Promise((r) => setTimeout(r, ERROR_SHOW_MS + 50));
    source.preRender();
    check(`xr: ${ERROR_SHOW_MS}ms たった後の reality で lastError が消える`, source.lastError === "");
  }

  // ---- main.ts からの invalidate（タブ復帰・bfcache） ----
  source.invalidate("visibility", "タブ復帰");
  source.invalidate("bfcache", "bfcache 復帰");
  check("xr: invalidate の原因ごとの回数", JSON.stringify(source.invalidateCounts) === JSON.stringify({ orientation: 1, projection: 1, visibility: 1, bfcache: 1, cameraFailed: 1 }), JSON.stringify(source.invalidateCounts));
  source.postRender();
  source.stop();
  check("xr: stop で XR8.stop", x1.stopped === true && x1.postRenders === 1);

  // ---- R8: 開始時の投影設定が姿勢の採用の後にずれ込んだら invalidate する ----
  {
    const x5 = makeXr();
    x5.video.videoWidth = 0;
    x5.video.videoHeight = 0;
    globalThis.window = { XR8: x5.engine };
    const s5 = await startXrSource({ width: 300, height: 150 }, undefined, { log: () => {} });
    x5.nextReality = normal(0.3);
    s5.preRender();
    const posedBefore = s5.pose?.position.x === 0.3 && x5.projections === 0;
    x5.video.videoWidth = 640;
    x5.video.videoHeight = 480;
    s5.preRender();
    check("xr: 映像の寸法が遅れて届き、開始時の投影設定が姿勢の採用の後になったら invalidate（projection）として数える（R8）", posedBefore && x5.projections === 1 && s5.invalidateCounts.projection === 1 && s5.pose === null, `projections=${x5.projections} inv=${JSON.stringify(s5.invalidateCounts)}`);
    s5.stop();
  }

  // ---- 先行読み込み・タイムアウト（08-10 と同じ） ----
  {
    const x2 = makeXr();
    globalThis.window = {};
    const s2 = await startXrSource({ width: 300, height: 150 }, Promise.resolve(x2.engine), { log: () => {} });
    assert.equal(await s2.waitForVideo(), x2.video);
    s2.stop();
    globalThis.window = { XR8: makeXr().engine };
    assert.ok(await loadEngine(), "window.XR8 があればそれを使う");
    const failed = Promise.reject(new Error("読み込み失敗（テスト）"));
    failed.catch(() => {});
    await assert.rejects(startXrSource({ width: 300, height: 150 }, failed), /読み込み失敗/);
    globalThis.window = {};
    await assert.rejects(startXrSource({ width: 300, height: 150 }, new Promise(() => {}), { timeoutMs: 50, log: () => {} }), /タイムアウト/);
    const x4 = makeXr();
    globalThis.window = {};
    const s4 = await startXrSource({ width: 300, height: 150 }, new Promise((r) => setTimeout(() => r(x4.engine), 20)), { timeoutMs: 200, log: () => {} });
    assert.equal(await s4.waitForVideo(), x4.video);
    s4.stop();
    check("xr: 先行読み込み・読み込みエラーの再スロー・開始時からのタイムアウト（08-10 と同じ）", true);
  }

  // ---- 映像共有（08-10 と同じ: 既存の video を使い getUserMedia を呼ばない） ----
  {
    const { startPassthrough } = await vite.ssrLoadModule("/src/shared/passthrough-camera.ts");
    let gumCalls = 0;
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
      mediaDevices: { getUserMedia: () => { gumCalls++; throw Error("二重カメラ起動"); } },
    } });
    const video = { videoWidth: 640, videoHeight: 480, readyState: 2, srcObject: { getVideoTracks: () => [{ label: "Back Camera" }] }, addEventListener: () => {} };
    const scene = new THREE.Scene();
    const passthrough = await startPassthrough(scene, { existingVideo: video, camRes: [1280, 720], preferUltraWide: false, eyeAspect: () => 0.8, zoom: 1 }, () => {});
    passthrough.setCamHFovDeg(75);
    check("passthrough: 8th Wall の video を共有し getUserMedia を呼ばない・setCamHFovDeg が効く", passthrough.video === video && gumCalls === 0 && passthrough.camHFovDeg === 75);
    passthrough.texture.dispose();
  }
} catch (e) {
  check(`xr-source の確認で例外: ${e?.stack ?? e}`, false);
} finally {
  await vite.close();
  delete globalThis.window;
  delete globalThis.HTMLMediaElement;
  if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
}

const failed = results.filter(([, ok]) => !ok);
console.log(failed.length === 0 ? `\nALL PASS (${results.length})` : `\n${failed.length} FAILED / ${results.length}:\n${failed.map(([n]) => `  - ${n}`).join("\n")}`);
process.exit(failed.length === 0 ? 0 : 1);
