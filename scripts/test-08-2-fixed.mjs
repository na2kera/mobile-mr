// 08-2（一度合わせて固定）の純粋な数学の回帰テスト。`npm run test:08-2-fixed` で実行する。
//   demos/08-2-splatoon-fixed/fixed-anchor-math.ts — 観測の信頼判定・位置合わせの窓（連続 N・ばらつき）・中央値 / 平均・EMA
//   demos/08-2-splatoon-fixed/fixed-anchor.ts の maxErrOf（marker-anchor.ts の info から再投影誤差を読む）は three を import するので、
//   同じ正規表現の挙動を info の文字列で確かめる（本体は Node からは読まない）
// テストフレームワークは使わない（既存の scripts/test-*.mjs と同じ方針）。Node 22.18+ は .ts をそのまま import できる
import assert from "node:assert/strict";
import {
  AlignWindow,
  DEFAULT_TRUST_LIMITS,
  averageQuat,
  distance3,
  emaPose,
  markerQuality,
  medianPose,
  quatAngleDeg,
  refineStep,
  slerp,
  untrustedReason,
} from "../demos/08-2-splatoon-fixed/fixed-anchor-math.ts";

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
test("quatAngleDeg / averageQuat / slerp: ヨー 10° と 20° の差は 10°、平均は 15°、slerp の中点も 15°", () => {
  // acos は 1 付近で精度が落ちる（差 0° の判定は 1e-4° 程度まで）
  near(quatAngleDeg(yawQuat(10), yawQuat(20)), 10, 1e-4);
  near(quatAngleDeg(yawQuat(10), yawQuat(10).map((v) => -v)), 0, 1e-4, "符号が逆でも同じ回転");
  const avg = averageQuat([yawQuat(10), yawQuat(20), yawQuat(15)]);
  near(quatAngleDeg(avg, yawQuat(15)), 0, 1e-3);
  const negated = yawQuat(20).map((v) => -v);
  near(quatAngleDeg(averageQuat([yawQuat(10), negated]), yawQuat(15)), 0, 1e-3, "符号の違う四元数も揃えてから平均する");
  near(quatAngleDeg(slerp(yawQuat(10), yawQuat(20), 0.5), yawQuat(15)), 0, 1e-4);
  near(quatAngleDeg(slerp(yawQuat(10), yawQuat(20), 0), yawQuat(10)), 0, 1e-4);
  near(quatAngleDeg(slerp(yawQuat(10), yawQuat(20), 1), yawQuat(20)), 0, 1e-4);
});

// ---- 中央値 / 平均 ----
test("medianPose: 位置は成分ごとの中央値なので 1 つの外れ値（鏡像解の跳び）に引きずられない", () => {
  const samples = [];
  for (let i = 0; i < 9; i++) samples.push({ pos: [0.01 * (i % 3), 1.2 + 0.005 * i, 0.001 * i], quat: yawQuat(0.2 * i) });
  samples.push({ pos: [1.5, 0.3, 2.0], quat: yawQuat(90) });
  const m = medianPose(samples);
  assert.ok(distance3(m.pos, [0.01, 1.22, 0.004]) < 0.02, `median=${m.pos}`);
  // 回転は平均なので外れ値の影響は受けるが、9 対 1 なら 10° 未満
  assert.ok(quatAngleDeg(m.quat, yawQuat(0.8)) < 10, `angle=${quatAngleDeg(m.quat, yawQuat(0.8))}`);
});

// ---- EMA ----
test("emaPose: alpha=0 で動かず、alpha=1 で観測に一致し、0.02 なら 1 回で 2% だけ寄る", () => {
  const cur = { pos: [0, 0, 0], quat: yawQuat(0) };
  const obs = { pos: [1, 0, 0], quat: yawQuat(10) };
  assert.deepEqual(emaPose(cur, obs, 0).pos, [0, 0, 0]);
  near(quatAngleDeg(emaPose(cur, obs, 0).quat, yawQuat(0)), 0, 1e-4);
  assert.deepEqual(emaPose(cur, obs, 1).pos, [1, 0, 0]);
  near(quatAngleDeg(emaPose(cur, obs, 1).quat, yawQuat(10)), 0, 1e-4);
  const r = emaPose(cur, obs, 0.02);
  near(r.pos[0], 0.02, 1e-9);
  near(quatAngleDeg(r.quat, yawQuat(0)), 0.2, 1e-3);
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
  near(quatAngleDeg(r.quat, yawQuat(0.1)), 0, 1e-3);
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
  assert.ok(quatAngleDeg(r.quat, yawQuat(1)) < 0.5);
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

// ---- marker-anchor.ts の info から再投影誤差を読む正規表現（fixed-anchor.ts の maxErrOf と同じ式） ----
test("info の err= の読み取り: 複数なら最大、無ければ Infinity（信頼しない側に倒す）", () => {
  const maxErrOf = (info) => {
    const m = info.match(/err=([\d.,]+)/);
    if (!m) return Infinity;
    const values = m[1].split(",").map(Number).filter(Number.isFinite);
    return values.length === 0 ? Infinity : Math.max(...values);
  };
  assert.equal(maxErrOf("id=0 err=0.03 tilt=3deg Δ=0.02m 18ms"), 0.03);
  assert.equal(maxErrOf("id=0+5 err=0.03,0.12 spread=0.02m tilt=3deg Δ=0.02m 18ms"), 0.12);
  assert.equal(maxErrOf("lost (1.2s)"), Infinity);
  assert.equal(maxErrOf("searching"), Infinity);
});

console.log(`\n${process.exitCode ? "FAILED" : "ALL PASS"} (${passed} passed)`);
