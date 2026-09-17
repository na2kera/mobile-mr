// 08-2（一度合わせて固定）の純粋な数学の回帰テスト。`npm run test:08-2-fixed` で実行する。
//   demos/08-2-splatoon-fixed/fixed-anchor-math.ts — 観測の信頼判定・位置合わせの窓（直近 windowLen 回のうち N 回・ばらつき）・中央値 / 平均・EMA・
//   marker-anchor.ts の info から再投影誤差を読む maxErrOf
// 期待値は実装の関数で作らない（回転の差はこのファイルで書いた式、合成の観測は js-aruco2 の POSIT に自前の角ノイズを入れて作る）。
// テストフレームワークは使わない（既存の scripts/test-*.mjs と同じ方針）。Node 22.18+ は .ts をそのまま import できる
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  AlignWindow,
  DEFAULT_ALIGN_ANGLE_DEG,
  DEFAULT_TRUST_LIMITS,
  LEVELED_ALIGN_ANGLE_DEG,
  LEVELED_MAX_TILT_DEG,
  averageQuat,
  defaultAlignAngleDeg,
  defaultTrustLimits,
  distance3,
  emaPose,
  markerQuality,
  maxErrOf,
  medianPose,
  quatAngleDeg,
  refineStep,
  slerp,
  untrustedReason,
} from "../demos/08-2-splatoon-fixed/fixed-anchor-math.ts";

const require = createRequire(import.meta.url);
// js-aruco2 の posit1.js はグローバルの SVD を使う（marker-detector.ts と同じ POSIT）
require("js-aruco2/src/svd.js");
const { POS } = require("js-aruco2/src/posit1.js");

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS: ${name}`);
  } catch (e) {
    console.log(`FAIL: ${name}\n  ${e.message}`);
    process.exitCode = 1;
  }
}
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ""} expected ${b} ± ${eps}, got ${a}`);

/** 2 つの回転の差 [deg]（実装の quatAngleDeg を使わずにこのファイルで書いた式: 2·acos(|q1·q2|)） */
const angleDeg = (a, b) => (2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]))) * 180) / Math.PI;
/** 軸 axis まわりに deg 回す四元数 [x,y,z,w] */
const axisAngleQuat = (axis, deg) => {
  const l = Math.hypot(...axis);
  const h = (deg * Math.PI) / 360;
  return [(axis[0] / l) * Math.sin(h), (axis[1] / l) * Math.sin(h), (axis[2] / l) * Math.sin(h), Math.cos(h)];
};
/** 四元数の積 a·b（Hamilton。[x,y,z,w]） */
const quatMul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
/** Y 軸まわりのヨー [deg] の四元数 [x,y,z,w] */
const yawQuat = (deg) => {
  const h = (deg * Math.PI) / 360;
  return [0, Math.sin(h), 0, Math.cos(h)];
};
/** マーカー → カメラの列優先 4x4。カメラ座標系（-Z 前方）でマーカー中心を c に置き、法線（+Z 列）を n に向ける（x・y は法線に直交する適当な軸） */
function markerToCam(c, n) {
  const l = Math.hypot(...n);
  const z = n.map((v) => v / l);
  const up = Math.abs(z[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const x = [up[1] * z[2] - up[2] * z[1], up[2] * z[0] - up[0] * z[2], up[0] * z[1] - up[1] * z[0]];
  const lx = Math.hypot(...x);
  const xn = x.map((v) => v / lx);
  const y = [z[1] * xn[2] - z[2] * xn[1], z[2] * xn[0] - z[0] * xn[2], z[0] * xn[1] - z[1] * xn[0]];
  return [xn[0], xn[1], xn[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, c[0], c[1], c[2], 1];
}

// ---- 観測の質（距離・画面中央からの角度・正対の角度） ----
test("markerQuality: 正面 1m のマーカー（画面中央・法線がカメラを向く）は dist=1 / off=0 / face=0", () => {
  const q = markerQuality(markerToCam([0, 0, -1], [0, 0, 1]), 2, 0.03);
  near(q.distM, 1, 1e-9);
  near(q.offAxisDeg, 0, 1e-6);
  near(q.facingDeg, 0, 1e-6);
  assert.equal(q.tiltDeg, 2);
  assert.equal(q.err, 0.03);
});
test("markerQuality: 右 0.5m・奥 1m にあるマーカーは off ≈ 26.6°、法線がカメラを向いていれば face は 0", () => {
  const c = [0.5, 0, -1];
  const q = markerQuality(markerToCam(c, [-0.5, 0, 1]), 0, 0);
  near(q.distM, Math.hypot(0.5, 1), 1e-9);
  near(q.offAxisDeg, (Math.atan2(0.5, 1) * 180) / Math.PI, 1e-6);
  near(q.facingDeg, 0, 1e-6);
});
test("markerQuality: 画面中央にあっても法線が 40° 横を向いている（斜めから見ている）と face=40", () => {
  const a = (40 * Math.PI) / 180;
  const q = markerQuality(markerToCam([0, 0, -1], [Math.sin(a), 0, Math.cos(a)]), 0, 0);
  near(q.offAxisDeg, 0, 1e-6);
  near(q.facingDeg, 40, 1e-6);
});
test("markerQuality: 床のマーカー（法線が上）を 65° 見下ろすと face は視線と法線の角度になる", () => {
  // カメラから見て 0.6m 前・0.5m 下: マーカー → カメラの向きは (0, 0.5, 0.6) を正規化。法線を上 (0,1,0) にすると face = acos(0.5/|..|)
  const c = [0, -0.5, -0.6];
  const q = markerQuality(markerToCam(c, [0, 1, 0]), 0, 0);
  near(q.facingDeg, (Math.acos(0.5 / Math.hypot(0.5, 0.6)) * 180) / Math.PI, 1e-6);
});

// ---- 信頼判定 ----
const good = { distM: 1.0, offAxisDeg: 5, facingDeg: 8, tiltDeg: 3, err: 0.05 };
test("untrustedReason: 正面 1m の良い観測は信頼できる（null）", () => {
  assert.equal(untrustedReason(good), null);
  assert.equal(untrustedReason(good, DEFAULT_TRUST_LIMITS), null);
});
test("untrustedReason: 遠い / 画面の端 / 斜め / 傾き / 再投影誤差 のどれかで落ち、理由が返る", () => {
  assert.equal(untrustedReason({ ...good, distM: 2.5 }), "far");
  assert.equal(untrustedReason({ ...good, offAxisDeg: 30 }), "off");
  assert.equal(untrustedReason({ ...good, facingDeg: 40 }), "face");
  assert.equal(untrustedReason({ ...good, tiltDeg: 25 }), "tilt");
  assert.equal(untrustedReason({ ...good, err: 0.5 }), "err");
  assert.equal(untrustedReason({ ...good, err: NaN }), "err");
  assert.equal(untrustedReason({ ...good, err: Infinity }), "err", "info に err= が無い（Infinity）ときは信頼しない");
});
test("untrustedReason: 距離・角度・傾きが NaN / Infinity の観測は信頼しない（reason は nan。err の NaN は err）", () => {
  assert.equal(untrustedReason({ ...good, distM: NaN }), "nan");
  assert.equal(untrustedReason({ ...good, offAxisDeg: NaN }), "nan");
  assert.equal(untrustedReason({ ...good, facingDeg: Infinity }), "nan");
  assert.equal(untrustedReason({ ...good, tiltDeg: NaN }), "nan");
  assert.equal(untrustedReason({ ...good, err: NaN }), "err");
  // markerQuality に壊れた行列を渡しても null（信頼）にはならない
  const broken = markerQuality([NaN, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, NaN, 0, -1, 1], 0, 0);
  assert.notEqual(untrustedReason(broken), null);
});
test("untrustedReason: 閾値は上書きできる（緩めれば通る・きつくすれば落ちる）", () => {
  assert.equal(untrustedReason({ ...good, distM: 2.5 }, { ...DEFAULT_TRUST_LIMITS, maxDistM: 3 }), null);
  assert.equal(untrustedReason(good, { ...DEFAULT_TRUST_LIMITS, maxOffAxisDeg: 2 }), "off");
});

// ---- 回転の道具 ----
test("quatAngleDeg: 任意の軸で既知の角度だけ回した 2 つの回転の差がその角度（テスト内の四元数の積で作る）", () => {
  const base = axisAngleQuat([0.3, -0.8, 0.52], 37);
  for (const [axis, deg] of [
    [[1, 0, 0], 5],
    [[0, 1, 0], 90],
    [[1, 1, 1], 30],
    [[-0.2, 0.7, -0.4], 135],
    [[0, 0, 1], 179],
  ]) {
    const rotated = quatMul(base, axisAngleQuat(axis, deg));
    near(quatAngleDeg(base, rotated), deg, 1e-6, `axis=${axis} deg=${deg}`);
    near(quatAngleDeg(rotated, base), deg, 1e-6, "順序を入れ替えても同じ");
    near(quatAngleDeg(base, rotated.map((v) => -v)), deg, 1e-6, "符号を反転しても同じ回転");
  }
  // 200° 回すのは逆向きに 160° 回すのと同じ
  near(quatAngleDeg(base, quatMul(base, axisAngleQuat([0, 1, 0], 200))), 160, 1e-6);
});
test("averageQuat / slerp: ヨー 10° と 20° の平均は 15°、slerp の中点も 15°", () => {
  // acos は 1 付近で精度が落ちる（差 0° の判定は 1e-4° 程度まで）
  near(angleDeg(yawQuat(10), yawQuat(20)), 10, 1e-4);
  near(angleDeg(yawQuat(10), yawQuat(10).map((v) => -v)), 0, 1e-4, "符号が逆でも同じ回転");
  const avg = averageQuat([yawQuat(10), yawQuat(20), yawQuat(15)]);
  near(angleDeg(avg, yawQuat(15)), 0, 1e-3);
  const negated = yawQuat(20).map((v) => -v);
  near(angleDeg(averageQuat([yawQuat(10), negated]), yawQuat(15)), 0, 1e-3, "符号の違う四元数も揃えてから平均する");
  near(angleDeg(slerp(yawQuat(10), yawQuat(20), 0.5), yawQuat(15)), 0, 1e-4);
  near(angleDeg(slerp(yawQuat(10), yawQuat(20), 0), yawQuat(10)), 0, 1e-4);
  near(angleDeg(slerp(yawQuat(10), yawQuat(20), 1), yawQuat(20)), 0, 1e-4);
});

// ---- 中央値 / 平均 ----
test("medianPose: 位置は成分ごとの中央値なので 1 つの外れ値（鏡像解の跳び）に引きずられない", () => {
  const samples = [];
  for (let i = 0; i < 9; i++) samples.push({ pos: [0.01 * (i % 3), 1.2 + 0.005 * i, 0.001 * i], quat: yawQuat(0.2 * i) });
  samples.push({ pos: [1.5, 0.3, 2.0], quat: yawQuat(90) });
  const m = medianPose(samples);
  assert.ok(distance3(m.pos, [0.01, 1.22, 0.004]) < 0.02, `median=${m.pos}`);
  // 回転は平均なので外れ値の影響は受けるが、9 対 1 なら 10° 未満
  assert.ok(angleDeg(m.quat, yawQuat(0.8)) < 10, `angle=${angleDeg(m.quat, yawQuat(0.8))}`);
});

// ---- EMA ----
test("emaPose: alpha=0 で動かず、alpha=1 で観測に一致し、0.02 なら 1 回で 2% だけ寄る", () => {
  const cur = { pos: [0, 0, 0], quat: yawQuat(0) };
  const obs = { pos: [1, 0, 0], quat: yawQuat(10) };
  assert.deepEqual(emaPose(cur, obs, 0).pos, [0, 0, 0]);
  near(angleDeg(emaPose(cur, obs, 0).quat, yawQuat(0)), 0, 1e-4);
  assert.deepEqual(emaPose(cur, obs, 1).pos, [1, 0, 0]);
  near(angleDeg(emaPose(cur, obs, 1).quat, yawQuat(10)), 0, 1e-4);
  const r = emaPose(cur, obs, 0.02);
  near(r.pos[0], 0.02, 1e-9);
  near(angleDeg(r.quat, yawQuat(0)), 0.2, 1e-3);
  // 100 回で 1 - 0.98^100 ≈ 87%
  let p = cur;
  for (let i = 0; i < 100; i++) p = emaPose(p, obs, 0.02);
  near(p.pos[0], 1 - 0.98 ** 100, 1e-9);
});

test("refineStep: 位置は近くても回転だけ大きくずれた観測（鏡像解）は無視し、位置・回転とも近ければ EMA、alpha=0 なら null", () => {
  const cur = { pos: [0, 1.6, -0.75], quat: yawQuat(0) };
  const mirror = { pos: [0.05, 1.6, -0.75], quat: yawQuat(40) }; // 位置差 5cm・回転差 40°
  assert.equal(refineStep(cur, mirror, 0.02, 0.5, 20), null, "回転 40° > 20° は無視");
  const far = { pos: [0.8, 1.6, -0.75], quat: yawQuat(1) };
  assert.equal(refineStep(cur, far, 0.02, 0.5, 20), null, "位置 0.8m > 0.5m は無視");
  const close = { pos: [0.05, 1.6, -0.75], quat: yawQuat(5) };
  const r = refineStep(cur, close, 0.02, 0.5, 20);
  assert.ok(r);
  near(r.pos[0], 0.001, 1e-9);
  near(angleDeg(r.quat, yawQuat(0.1)), 0, 1e-3);
  assert.equal(refineStep(cur, close, 0, 0.5, 20), null, "alpha=0（完全固定）は null");
});

// ---- 位置合わせの窓 ----
test("AlignWindow: 信頼できる観測が N 回揃い、ばらつきが小さければ ready。結果は中央値 / 平均", () => {
  const w = new AlignWindow({ samples: 5, maxSpreadM: 0.05, maxAngleDeg: 3 });
  assert.equal(w.ready, false);
  for (let i = 0; i < 4; i++) {
    w.push({ pos: [0.01 * i, 1.2, 0], quat: yawQuat(0.5 * i) });
    assert.equal(w.ready, false, `${i + 1} 回では確定しない`);
    assert.equal(w.count, i + 1);
    assert.equal(w.stable, true);
  }
  w.push({ pos: [0.02, 1.2, 0.01], quat: yawQuat(1) });
  assert.equal(w.count, 5);
  assert.equal(w.ready, true);
  const r = w.result();
  near(r.pos[0], 0.02, 1e-9);
  near(r.pos[1], 1.2, 1e-9);
  assert.ok(angleDeg(r.quat, yawQuat(1)) < 0.5);
});
test("AlignWindow: reset で最初から（信頼できない観測やロストは呼び出し側が reset する）", () => {
  const w = new AlignWindow({ samples: 3, maxSpreadM: 0.05, maxAngleDeg: 3 });
  w.push({ pos: [0, 0, 0], quat: yawQuat(0) });
  w.push({ pos: [0, 0, 0], quat: yawQuat(0) });
  w.reset();
  assert.equal(w.count, 0);
  assert.equal(w.ready, false);
  w.push({ pos: [0, 0, 0], quat: yawQuat(0) });
  assert.equal(w.ready, false, "reset 後は連続が 1 から数え直し");
});
test("AlignWindow: ぶれている（位置 5cm 超 / 回転 3° 超）間は満杯でも確定せず、古いものが抜けて落ち着けば確定する", () => {
  const w = new AlignWindow({ samples: 4, maxSpreadM: 0.05, maxAngleDeg: 3 });
  w.push({ pos: [0.3, 0, 0], quat: yawQuat(0) }); // 跳んだ観測
  for (let i = 0; i < 3; i++) w.push({ pos: [0, 0, 0], quat: yawQuat(0) });
  assert.equal(w.count, 4);
  assert.equal(w.stable, false);
  assert.equal(w.ready, false, "跳んだ観測が窓に残っている間は確定しない");
  assert.ok(w.spreadM > 0.2, `spread=${w.spreadM}`);
  w.push({ pos: [0, 0, 0], quat: yawQuat(0) });
  assert.equal(w.ready, true, "跳んだ観測が窓から抜けたら確定する");
  // 回転だけぶれる場合も同じ
  const w2 = new AlignWindow({ samples: 3, maxSpreadM: 0.05, maxAngleDeg: 3 });
  w2.push({ pos: [0, 0, 0], quat: yawQuat(0) });
  w2.push({ pos: [0, 0, 0], quat: yawQuat(0) });
  w2.push({ pos: [0, 0, 0], quat: yawQuat(8) });
  assert.equal(w2.ready, false);
  assert.ok(w2.angleDeg > 3, `angle=${w2.angleDeg}`);
});
test("AlignWindow: samples=1 なら信頼できる観測 1 回で確定（?alignN=1 の動作）", () => {
  const w = new AlignWindow({ samples: 1, maxSpreadM: 0.05, maxAngleDeg: 3 });
  w.push({ pos: [1, 2, 3], quat: yawQuat(5) });
  assert.equal(w.ready, true);
  assert.deepEqual(w.result().pos, [1, 2, 3]);
});

// ---- marker-anchor.ts の info から再投影誤差を読む（fixed-anchor-math.ts の maxErrOf） ----
test("maxErrOf: 複数なら最大、無ければ Infinity（信頼しない側に倒す）", () => {
  assert.equal(maxErrOf("id=0 err=0.03 tilt=3deg Δ=0.02m 18ms"), 0.03);
  assert.equal(maxErrOf("id=0+5 err=0.03,0.12 spread=0.02m tilt=3deg Δ=0.02m 18ms"), 0.12);
  assert.equal(maxErrOf("lost (1.2s)"), Infinity);
  assert.equal(maxErrOf("searching"), Infinity);
});

// ---- 中央値（偶数個）と、先頭が外れ値のときの平均 ----
test("medianPose: 偶数個なら中央の 2 つの平均（成分ごと）", () => {
  const m = medianPose([
    { pos: [4, 0, -1], quat: yawQuat(0) },
    { pos: [1, 10, -3], quat: yawQuat(0) },
    { pos: [3, 20, -2], quat: yawQuat(0) },
    { pos: [2, 30, 100], quat: yawQuat(0) },
  ]);
  assert.deepEqual(m.pos, [2.5, 15, -1.5]);
});
test("AlignWindow: 先頭が外れ値（ヨー 170°）だと符号合わせの基準がずれて平均が壊れるが、ばらつきで弾かれ ready にならない", () => {
  const w = new AlignWindow({ samples: 5, maxSpreadM: 0.05, maxAngleDeg: 3 });
  w.push({ pos: [0, 0, 0], quat: yawQuat(170) });
  for (const yaw of [-1, 1, -0.5, 0.5]) w.push({ pos: [0, 0, 0], quat: yawQuat(yaw) });
  assert.equal(w.count, 5);
  assert.equal(w.ready, false, "外れ値が先頭にあるうちは確定しない");
  assert.ok(w.angleDeg > 3, `angle=${w.angleDeg}`);
  w.push({ pos: [0, 0, 0], quat: yawQuat(0) });
  assert.equal(w.ready, true, "外れ値が抜ければ確定する");
  assert.ok(angleDeg(w.result().quat, yawQuat(0)) < 0.5);
});

// ---- 直近 windowLen 回のうち samples 回 ----
const still = (i = 0) => ({ pos: [0.001 * (i % 3), 0, 0], quat: yawQuat(0.1 * (i % 3)) });
test("AlignWindow(windowLen): 信頼できない観測が混ざっても窓は捨てず、直近 14 回のうち 10 回が信頼できれば確定する", () => {
  const w = new AlignWindow({ samples: 10, windowLen: 14, maxSpreadM: 0.05, maxAngleDeg: 3 });
  // 信頼 3 → 不信 1 を繰り返す: 12 観測目で信頼 9、13 観測目で 10（直近 14 回の中）
  const pattern = [];
  for (let i = 0; i < 13; i++) pattern.push(i % 4 !== 3);
  let lockedAt = -1;
  pattern.forEach((trusted, i) => {
    if (trusted) w.push(still(i));
    else w.pushUntrusted();
    if (lockedAt < 0 && w.ready) lockedAt = i + 1;
  });
  assert.equal(lockedAt, 13, `lockedAt=${lockedAt}`);
  assert.equal(w.count, 10);
});
test("AlignWindow(windowLen): 直近 14 回のうち信頼できる観測が 9 回しかなければ確定しない（古い信頼は窓から抜ける）", () => {
  const w = new AlignWindow({ samples: 10, windowLen: 14, maxSpreadM: 0.05, maxAngleDeg: 3 });
  // 信頼 9・不信 5 を 14 回ずつ繰り返す
  for (let r = 0; r < 4; r++) {
    for (let i = 0; i < 14; i++) {
      if (i < 9) w.push(still(i));
      else w.pushUntrusted();
      assert.equal(w.ready, false, `round ${r} i=${i} count=${w.count}`);
    }
  }
  assert.ok(w.count <= 9);
});
test("AlignWindow(windowLen): 窓が長くても、ばらつきは直近 samples 回の信頼できる観測だけで測る", () => {
  const w = new AlignWindow({ samples: 3, windowLen: 6, maxSpreadM: 0.05, maxAngleDeg: 3 });
  w.push({ pos: [0.5, 0, 0], quat: yawQuat(0) }); // 古い跳んだ観測
  for (let i = 0; i < 3; i++) w.push(still(i));
  assert.equal(w.ready, true, "跳んだ観測は直近 3 回の外");
  assert.ok(w.result().pos[0] < 0.01);
});
test("AlignWindow: windowLen を省略するか samples 未満なら従来どおり連続（信頼できない観測 1 回で揃わない）", () => {
  for (const windowLen of [undefined, 2]) {
    const w = new AlignWindow({ samples: 3, windowLen, maxSpreadM: 0.05, maxAngleDeg: 3 });
    w.push(still());
    w.push(still());
    w.pushUntrusted();
    w.push(still());
    assert.equal(w.ready, false, `windowLen=${windowLen}`);
    w.push(still());
    w.push(still());
    assert.equal(w.ready, true, `windowLen=${windowLen}`);
  }
});

// ---- gravityAlign が on のときの正対と傾きの門 ----
test("defaultTrustLimits: gravityAlign が on なら tilt の門は 30°、off なら 15°（他は同じ）", () => {
  assert.equal(LEVELED_MAX_TILT_DEG, 30);
  assert.equal(defaultTrustLimits(true).maxTiltDeg, 30);
  assert.equal(defaultTrustLimits(false).maxTiltDeg, 15);
  assert.equal(defaultTrustLimits(true).maxFacingDeg, DEFAULT_TRUST_LIMITS.maxFacingDeg);
  assert.equal(untrustedReason({ ...good, tiltDeg: 25 }, defaultTrustLimits(true)), null);
  assert.equal(untrustedReason({ ...good, tiltDeg: 35 }, defaultTrustLimits(true)), "tilt");
});
test("markerQuality(upCam): 壁のマーカーを 0.6m 見下ろしても（3D の正対 31°）、水平面の正対は 0° で elevation に分かれる", () => {
  // マーカーは水平に 1m 前・0.6m 下の壁（法線は水平に視点側）。カメラはマーカーを画面の中央に入れるよう下を向く（X 軸まわり）
  const p = -Math.atan2(0.6, 1);
  const rot = (v) => [v[0], v[1] * Math.cos(p) + v[2] * Math.sin(p), -v[1] * Math.sin(p) + v[2] * Math.cos(p)];
  const m = markerToCam(rot([0, -0.6, -1]), rot([0, 0, 1]));
  const q3d = markerQuality(m, 0, 0);
  const qh = markerQuality(m, 0, 0, rot([0, 1, 0]));
  near(qh.offAxisDeg, 0, 1e-6, "画面の中央");
  const expected = (Math.atan2(0.6, 1) * 180) / Math.PI;
  near(q3d.facingDeg, expected, 1e-6, "upCam 無しは 3D の角度");
  assert.equal(q3d.elevationDeg, 0);
  near(qh.facingDeg, 0, 1e-6, "水平面では正面");
  near(qh.elevationDeg, expected, 1e-6);
  assert.equal(untrustedReason({ ...qh, err: 0.02 }, defaultTrustLimits(true)), null);
});
test("markerQuality(upCam): 横に回り込んだ角度は水平面でもそのまま（39°）、カメラが傾いていても up で測る", () => {
  const a = (39 * Math.PI) / 180;
  // 画面中央・0.4m 下、法線が水平に 39° 横
  const m = markerToCam([0, -0.4, -1], [Math.sin(a), 0, Math.cos(a)]);
  near(markerQuality(m, 0, 0, [0, 1, 0]).facingDeg, 39, 1e-6);
  // カメラを X 軸まわりに 20° 下へ向けた: カメラ座標系での上は (0, cos20, sin20)。同じ幾何を回して与える
  const p = (20 * Math.PI) / 180;
  const rot = (v) => [v[0], v[1] * Math.cos(p) + v[2] * Math.sin(p), -v[1] * Math.sin(p) + v[2] * Math.cos(p)];
  const m2 = markerToCam(rot([0, -0.4, -1]), rot([Math.sin(a), 0, Math.cos(a)]));
  near(markerQuality(m2, 0, 0, rot([0, 1, 0])).facingDeg, 39, 1e-6);
});
test("markerQuality(upCam): 床のマーカー（法線が上に近い）は投影せず 3D の角度のまま、elevation は 0", () => {
  const c = [0, -0.5, -0.6];
  const q = markerQuality(markerToCam(c, [0, 1, 0]), 0, 0, [0, 1, 0]);
  near(q.facingDeg, (Math.acos(0.5 / Math.hypot(0.5, 0.6)) * 180) / Math.PI, 1e-6);
  assert.equal(q.elevationDeg, 0);
});

// ---- 角ノイズ入りの合成観測で、既定の閾値のまま確定までの観測数 ----
// 実機の検出側（marker-detector.ts / marker-anchor.ts）と同じ幾何: 超広角（長辺 960px・水平 106°）、js-aruco2 の POSIT、
// three.js のカメラ座標系への変換は F=diag(1,1,-1) で挟む、水平化（gravityAlign）では位置はマーカー中心・回転は法線を水平面に投影したヨー。
// ノイズは実装の関数を使わず、固定シードの擬似乱数で角に ±1px（一様）を足す
function simulateAlign({ sizeM, distM, camAboveM, seed, maxObs, windowLen = 14, samples = 10, limits = defaultTrustLimits(true), maxSpreadM = 0.05, maxAngleDeg = defaultAlignAngleDeg(true) }) {
  const W = 960;
  const focal = W / 2 / Math.tan((106 * Math.PI) / 180 / 2);
  // マーカー座標系（X 右 / Y 上 / Z 視点側）→ POSIT のカメラ座標系（X 右 / Y 上 / Z 奥）。カメラは正面 distM・camAboveM 上からマーカー中心を向く
  const pitch = Math.atan2(camAboveM, distM);
  const toPositCam = (p) => {
    const dy = p[1] - camAboveM;
    const dz = p[2] - distM;
    return [p[0], dy * Math.cos(pitch) - dz * Math.sin(pitch), -dy * Math.sin(pitch) - dz * Math.cos(pitch)];
  };
  const h = sizeM / 2;
  const corners = [
    [-h, h, 0],
    [h, h, 0],
    [h, -h, 0],
    [-h, -h, 0],
  ]
    .map(toPositCam)
    .map(([x, y, z]) => ({ x: (focal * x) / z, y: (focal * y) / z }));
  let state = seed >>> 0;
  const rand = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  const posit = new POS.Posit(sizeM, focal);
  // three.js のカメラ座標系（-Z 前方）での重力の上と、真のマーカー中心
  const o = toPositCam([0, 0, 0]);
  const u = toPositCam([0, 1, 0]);
  const up = [u[0] - o[0], u[1] - o[1], -(u[2] - o[2])];
  const right = [1, 0, 0];
  const back = [right[1] * up[2] - right[2] * up[1], right[2] * up[0] - right[0] * up[2], right[0] * up[1] - right[1] * up[0]];
  const toWorld = (v) => [v[0] * right[0] + v[1] * right[1] + v[2] * right[2], v[0] * up[0] + v[1] * up[1] + v[2] * up[2], v[0] * back[0] + v[1] * back[1] + v[2] * back[2]];
  const truePos = toWorld([o[0], o[1], -o[2]]);
  const w = new AlignWindow({ samples, windowLen, maxSpreadM, maxAngleDeg });
  const reasons = {};
  for (let i = 1; i <= maxObs; i++) {
    const noisy = corners.map((c) => ({ x: c.x + (rand() * 2 - 1), y: c.y + (rand() * 2 - 1) }));
    const pose = posit.pose(noisy);
    const r = pose.bestRotation;
    const t = pose.bestTranslation;
    // M = F·[R|t]·F（列優先）
    const m = [r[0][0], r[1][0], -r[2][0], 0, r[0][1], r[1][1], -r[2][1], 0, -r[0][2], -r[1][2], r[2][2], 0, t[0], t[1], -t[2], 1];
    const yAxis = [m[4], m[5], m[6]];
    const tilt = (Math.acos(Math.max(-1, Math.min(1, (yAxis[0] * up[0] + yAxis[1] * up[1] + yAxis[2] * up[2]) / Math.hypot(...yAxis)))) * 180) / Math.PI;
    let sidePx = 0;
    for (let k = 0; k < 4; k++) sidePx += Math.hypot(noisy[(k + 1) % 4].x - noisy[k].x, noisy[(k + 1) % 4].y - noisy[k].y) / 4;
    const q = markerQuality(m, tilt, pose.bestError / sidePx, up);
    const reason = untrustedReason(q, limits);
    reasons[reason ?? "ok"] = (reasons[reason ?? "ok"] ?? 0) + 1;
    if (reason === null) {
      const n = toWorld([m[8], m[9], m[10]]);
      const yaw = Math.atan2(n[0], n[2]);
      w.push({ pos: toWorld([t[0], t[1], -t[2]]), quat: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)] });
    } else {
      w.pushUntrusted();
    }
    if (w.ready) return { lockedAt: i, pose: w.result(), truePos, reasons, spreadM: w.spreadM, angleDeg: w.angleDeg };
  }
  return { lockedAt: -1, pose: null, truePos, reasons, spreadM: w.spreadM, angleDeg: w.angleDeg };
}
test("defaultAlignAngleDeg: gravityAlign が on なら 15°、off なら 3°", () => {
  assert.equal(LEVELED_ALIGN_ANGLE_DEG, 15);
  assert.equal(DEFAULT_ALIGN_ANGLE_DEG, 3);
  assert.equal(defaultAlignAngleDeg(true), 15);
  assert.equal(defaultAlignAngleDeg(false), 3);
});
test("合成観測（150mm・正面 1.0m・角 ±1px）: 既定の閾値（gravityAlign on・回転 15°）で 30 観測以内に確定し、位置は真値から 5cm 以内・ヨーは 5° 以内", () => {
  const results = [11, 22, 33, 44, 55].map((seed) => ({ seed, ...simulateAlign({ sizeM: 0.15, distM: 1.0, camAboveM: 0.1, seed, maxObs: 30 }) }));
  for (const r of results) {
    console.log(`  seed=${r.seed} lockedAt=${r.lockedAt} spread=${r.spreadM.toFixed(3)}m angle=${r.angleDeg.toFixed(1)}deg reasons=${JSON.stringify(r.reasons)}`);
  }
  for (const r of results) {
    assert.ok(r.lockedAt > 0 && r.lockedAt <= 30, `seed=${r.seed} lockedAt=${r.lockedAt} angle=${r.angleDeg.toFixed(1)}deg`);
    assert.ok(distance3(r.pose.pos, r.truePos) < 0.05, `seed=${r.seed} pos err=${distance3(r.pose.pos, r.truePos).toFixed(3)}m`);
    // 真のマーカーの法線は水平にカメラ側 = ヨー 0
    assert.ok(angleDeg(r.pose.quat, [0, 0, 0, 1]) < 5, `seed=${r.seed} yaw err=${angleDeg(r.pose.quat, [0, 0, 0, 1]).toFixed(1)}deg`);
  }
});
test("合成観測（150mm・正面 1.0m・角 ±1px）: 回転の上限が 3°（gravityAlign off の既定）だと 30 観測以内に確定しない（15° にした根拠）", () => {
  for (const seed of [11, 22, 33, 44, 55]) {
    const r = simulateAlign({ sizeM: 0.15, distM: 1.0, camAboveM: 0.1, seed, maxObs: 30, maxAngleDeg: DEFAULT_ALIGN_ANGLE_DEG });
    assert.equal(r.lockedAt, -1, `seed=${seed} lockedAt=${r.lockedAt} angle=${r.angleDeg.toFixed(1)}deg`);
    assert.ok(r.reasons.ok >= 20, `信頼できる観測は十分ある（確定しないのは回転のばらつきのせい） reasons=${JSON.stringify(r.reasons)}`);
  }
});

console.log(`\n${process.exitCode ? "FAILED" : "ALL PASS"} (${passed} passed)`);
