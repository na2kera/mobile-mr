// 08-9（demos/08-9-splatoon-hold）の「静止中はアンカーを動かさない」状態機械（anchor-hold.ts）の回帰テスト。
// `npm run test:08-9-hold` で実行する。three.js もブラウザも使わず、合成の raw（アンカーの姿勢）の列を流して出力を見る。
//   (a) 固定姿勢に ±1cm・±0.5° の一様ノイズ（60fps、3 秒）→ inMs 経過後は出力が一切変わらない、固定位置はノイズの中心 ±3mm
//   (b) 0.5m/s で 2 秒直進（ノイズ付き）→ 出力の raw からの遅れが常に 3cm 以内、hold に落ちない
//       (b') 止まって hold に入ってから歩き出した場合の遅れ（歩き始めの遅れの実測。README に書く値）
//   (c) hold 中に 1 フレームだけ 10cm 飛ぶ → 出力不変
//   (d) hold 中に 5cm ずれた raw が 0.3 秒続く → follow に移り 0.5 秒以内に追いつく
//   (e) 直進後に停止 → inMs + 数フレームで hold に戻る
//   (f) 0.5m の飛び → 即 follow・出力即 raw
//   (g) enabled:false → 常に出力 = raw
//   (h) dt が不均一（16ms と 100ms 混在）でも (a)(b) が成り立つ
// 乱数は種を固定する（再現できるように）。(a) は種を 20 通り変えて最悪値も出す。
// テストフレームワークは使わない（他の test-*.mjs と同じ方針）。Node 22.18+ は .ts をそのまま import できる
import { DEFAULT_ANCHOR_HOLD, createAnchorHold, quatAngleDeg } from "../demos/08-9-splatoon-hold/anchor-hold.ts";

const results = [];
function check(name, cond, detail = "") {
  results.push([name, cond]);
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${detail ? ` (${detail})` : ""}`);
}
const OPTS = { ...DEFAULT_ANCHOR_HOLD };
const cm = (m) => `${(m * 100).toFixed(2)}cm`;
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

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

/** ヨー・ピッチ・ロール [deg] → 四元数（Y → X → Z の順。値の意味はノイズの大きさだけなので順番は問わない） */
function quatFromEulerDeg(yaw, pitch, roll) {
  const r = Math.PI / 360;
  const qy = [0, Math.sin(yaw * r), 0, Math.cos(yaw * r)];
  const qx = [Math.sin(pitch * r), 0, 0, Math.cos(pitch * r)];
  const qz = [0, 0, Math.sin(roll * r), Math.cos(roll * r)];
  return mul(mul(qy, qx), qz);
}
function mul(a, b) {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
}

const BASE_POS = [0.1, -0.2, -0.8];
const BASE_QUAT = quatFromEulerDeg(20, 3, -2);

/** ノイズの作り手: 位置は各軸 ±posNoise の一様、回転は各軸 ±degNoise の一様 */
function noiser(seed, posNoise = 0.01, degNoise = 0.5) {
  const r = rng(seed);
  const u = (a) => (r() * 2 - 1) * a;
  return (pos, quat) => ({
    pos: [pos[0] + u(posNoise), pos[1] + u(posNoise), pos[2] + u(posNoise)],
    quat: mul(quatFromEulerDeg(u(degNoise), u(degNoise), u(degNoise)), quat),
  });
}

/** 時刻の列: 60fps か、16ms と 100ms の混在 */
function times(durMs, mixed, seed = 7, t0 = 0) {
  const r = rng(seed);
  const out = [];
  let t = t0;
  while (t <= t0 + durMs) {
    out.push(t);
    t += mixed ? (r() < 0.5 ? 16 : 100) : 1000 / 60;
  }
  return out;
}

/** raw(t) を流して各フレームの { t, raw, out, state } を返す */
function run(hold, ts, rawAt) {
  const frames = [];
  for (const t of ts) {
    const raw = rawAt(t);
    const out = hold.update(raw, t);
    frames.push({ t, raw, out: { pos: [...out.pos], quat: [...out.quat] }, state: hold.state, info: hold.info });
  }
  return frames;
}
const samePose = (a, b) => a.pos.every((v, i) => v === b.pos[i]) && a.quat.every((v, i) => v === b.quat[i]);

// ---- (a) 止まっている（ノイズだけ）----
function caseA(mixed, seed) {
  const hold = createAnchorHold(OPTS);
  const noise = noiser(seed);
  const frames = run(hold, times(3000, mixed, seed + 100), () => noise(BASE_POS, BASE_QUAT));
  const firstHold = frames.findIndex((f) => f.state === "hold");
  if (firstHold < 0) return { ok: false, firstHoldMs: NaN, maxChange: Infinity, centerErr: Infinity, stayed: false };
  const after = frames.slice(firstHold);
  // 差 0 はビット単位の一致で見る（quatAngleDeg は同じ四元数でも acos の丸めで 1e-6 度ほど出るので使わない）
  const maxChange = Math.max(...after.map((f) => dist(f.out.pos, after[0].out.pos)));
  const allSame = after.every((f) => samePose(f.out, after[0].out));
  const stayed = after.every((f) => f.state === "hold");
  const centerErr = dist(after[0].out.pos, BASE_POS);
  const centerDeg = quatAngleDeg(after[0].out.quat, BASE_QUAT);
  const holdT = frames[firstHold].t;
  /** hold に入ったときの窓の点の数（平均に使った raw の数） */
  const nWin = frames.filter((f) => f.t >= holdT - OPTS.inMs && f.t <= holdT).length;
  return { firstHoldMs: holdT, allSame, maxChange, stayed, centerErr, centerDeg, nWin, first: frames[0] };
}
for (const mixed of [false, true]) {
  const tag = mixed ? "(h)(a) dt 不均一" : "(a) 60fps";
  const r = caseA(mixed, 1);
  check(`${tag}: 最初の update は follow で出力 = raw（初検出でいきなり固定しない）`, r.first.state === "follow" && samePose(r.first.out, r.first.raw));
  check(`${tag}: inMs（600ms）経過後すぐに hold に入る（inMs + 最大 1 フレーム）`, r.firstHoldMs >= OPTS.inMs && r.firstHoldMs <= OPTS.inMs + (mixed ? 100 : 17), `hold に入った時刻 ${r.firstHoldMs.toFixed(0)}ms`);
  check(`${tag}: hold に入った後は出力が一切変わらない（ビット単位で同じ、3 秒の終わりまで hold のまま）`, r.allSame && r.stayed && r.maxChange === 0, `位置の最大変化 ${r.maxChange}m`);
  // 固定位置 = 窓の平均なので、中心からの差は窓の点の数 n で決まる（各軸 ±1cm の一様ノイズの標準偏差 5.8mm / √n）。
  // 60fps（n = 37）では ±3mm。16ms と 100ms の混在では n ≈ 10 しか無いので、同じ信頼度の上限 3mm × √(37 / n) で見る（README / 報告に明記）
  const bound = mixed ? 0.003 * Math.sqrt(37 / r.nWin) : 0.003;
  check(`${tag}: 固定位置はノイズの中心 ±${(bound * 1000).toFixed(1)}mm（窓の点 ${r.nWin} 個の平均）`, r.centerErr <= bound, `中心からの差 ${(r.centerErr * 1000).toFixed(2)}mm / ${r.centerDeg.toFixed(3)}deg`);
  // 種を 20 通り変える（1 つの種に頼っていないことの確認）。止まっている限り hold のまま出力が変わらないことを見る
  const many = Array.from({ length: 20 }, (_, i) => caseA(mixed, 1000 + i));
  const allHeld = many.every((x) => x.allSame && x.stayed && x.firstHoldMs <= OPTS.inMs + (mixed ? 100 : 17));
  const errs = many.map((x) => x.centerErr * 1000).sort((a, b) => a - b);
  console.log(`INFO: ${tag}: 種 20 通りの固定位置の中心からの差 中央値 ${errs[10].toFixed(2)}mm / 最悪 ${errs[19].toFixed(2)}mm（窓の点 ${many[0].nWin} 個前後）`);
  check(`${tag}: 種 20 通りすべてで inMs 後に hold に入り、以後出力が一切変わらない`, allHeld);
}

// ---- (b) 0.5m/s で直進 ----
function caseB(mixed, seed) {
  const hold = createAnchorHold(OPTS);
  const noise = noiser(seed);
  const v = [0.5 / Math.SQRT2, 0, 0.5 / Math.SQRT2];
  const frames = run(hold, times(2000, mixed, seed + 200), (t) => noise([BASE_POS[0] + (v[0] * t) / 1000, BASE_POS[1], BASE_POS[2] + (v[2] * t) / 1000], BASE_QUAT));
  const maxLag = Math.max(...frames.map((f) => dist(f.out.pos, f.raw.pos)));
  const everHold = frames.some((f) => f.state === "hold");
  return { maxLag, everHold };
}
for (const mixed of [false, true]) {
  const tag = mixed ? "(h)(b) dt 不均一" : "(b) 60fps";
  const r = caseB(mixed, 2);
  check(`${tag}: 0.5m/s で 2 秒直進 → 出力の raw からの遅れが常に 3cm 以内`, r.maxLag <= 0.03, `最大 ${cm(r.maxLag)}`);
  check(`${tag}: 直進中は hold に落ちない`, !r.everHold);
}

// ---- (b') 止まって hold → 歩き出す（歩き始めの遅れ）----
{
  const hold = createAnchorHold(OPTS);
  const noise = noiser(3);
  const walkStart = 1500;
  const posAt = (t) => [BASE_POS[0] + (Math.max(0, t - walkStart) * 0.5) / 1000, BASE_POS[1], BASE_POS[2]];
  const frames = run(hold, times(3500, false), (t) => noise(posAt(t), BASE_QUAT));
  const holdBefore = frames.filter((f) => f.t < walkStart).at(-1).state === "hold";
  const followAt = frames.find((f) => f.t >= walkStart && f.state === "follow")?.t ?? NaN;
  const lagOf = (f) => dist(f.out.pos, posAt(f.t)); // ノイズの無い真の位置からの遅れ
  const maxLag = Math.max(...frames.filter((f) => f.t >= walkStart).map(lagOf));
  const lagAfter600 = Math.max(...frames.filter((f) => f.t >= walkStart + 600).map((f) => dist(f.out.pos, f.raw.pos)));
  console.log(`INFO: (b') hold から歩き出す: follow に入るまで ${(followAt - walkStart).toFixed(0)}ms、真の位置からの遅れの最大 ${cm(maxLag)}、歩き出して 0.6s 以降の raw との差の最大 ${cm(lagAfter600)}`);
  check("(b') hold 中に 0.5m/s で歩き出すと outMs 前後で follow に移る", holdBefore && followAt - walkStart <= OPTS.outMs + 100, `${(followAt - walkStart).toFixed(0)}ms`);
  check("(b') 歩き出して 0.6 秒以降は raw から 3cm 以内（切り替え時の差は時定数で縮む。速度ぶんの遅れは残らない）", lagAfter600 <= 0.03, cm(lagAfter600));
}

/** 止まって hold に入った状態の hold を作る（1.5 秒ノイズ付きで流す） */
function heldHold(seed, mixed = false) {
  const hold = createAnchorHold(OPTS);
  const noise = noiser(seed);
  const frames = run(hold, times(1500, mixed, seed + 300), () => noise(BASE_POS, BASE_QUAT));
  return { hold, noise, t: frames.at(-1).t, heldOut: frames.at(-1).out, state: frames.at(-1).state };
}

// ---- (c) hold 中に 1 フレームだけ 10cm 飛ぶ ----
{
  const { hold, noise, t, heldOut, state } = heldHold(4);
  const ts = times(1500, false, 7, t + 1000 / 60);
  const jumpT = ts[10];
  const frames = run(hold, ts, (tt) => noise(tt === jumpT ? [BASE_POS[0] + 0.1, BASE_POS[1], BASE_POS[2]] : BASE_POS, BASE_QUAT));
  const unchanged = frames.every((f) => samePose(f.out, heldOut) && f.state === "hold");
  check("(c) hold 中に 1 フレームだけ 10cm 飛んでも出力は不変・hold のまま", state === "hold" && unchanged);
}

// ---- (d) hold 中に 5cm ずれた raw が続く ----
{
  const { hold, noise, t, state } = heldHold(5);
  const stepT = t + 1000 / 60;
  const shifted = [BASE_POS[0], BASE_POS[1], BASE_POS[2] + 0.05];
  const frames = run(hold, times(1000, false, 7, stepT), () => noise(shifted, BASE_QUAT));
  const followAt = frames.find((f) => f.state === "follow")?.t ?? NaN;
  const in03 = frames.filter((f) => f.t < stepT + OPTS.outMs - 1);
  // 追いつき = follow 中の「出力 − raw」（寄せの差。raw のノイズとは無関係）。0.85 秒あたりで止まった位置で hold に戻るので follow の区間だけ見る
  const fol = frames.filter((f) => f.state === "follow");
  const gap05 = Math.max(...fol.filter((f) => f.t >= stepT + 500).map((f) => dist(f.out.pos, f.raw.pos)));
  const exactAt = fol.find((f, i) => fol.slice(i).every((g) => samePose(g.out, g.raw)))?.t ?? NaN;
  const reHoldAt = frames.find((f) => f.t > followAt && f.state === "hold")?.t ?? NaN;
  check("(d) 5cm ずれてから outMs までは hold のまま（出力は固定）", state === "hold" && in03.every((f) => f.state === "hold"));
  check("(d) 5cm ずれた raw が 0.3 秒続くと follow に移る", followAt - stepT <= 300 && followAt - stepT >= OPTS.outMs, `${(followAt - stepT).toFixed(0)}ms`);
  check("(d) ずれてから 0.5 秒以内に追いつく（0.5 秒以降の寄せの差が 1cm 以内、0.8 秒までに出力 = raw）", gap05 <= 0.01 && exactAt - stepT <= 800, `0.5s 以降の差 ${cm(gap05)} / 出力 = raw になった時刻 ${(exactAt - stepT).toFixed(0)}ms`);
  check("(d) ずれた先で止まっていれば follow に入ってから inMs 後に hold に戻る", reHoldAt - followAt >= OPTS.inMs && reHoldAt - followAt <= OPTS.inMs + 20, `${(reHoldAt - stepT).toFixed(0)}ms`);
  const jumps = frames.slice(1).map((f, i) => dist(f.out.pos, frames[i].out.pos) - dist(f.raw.pos, frames[i].raw.pos));
  check("(d) 寄せる間に出力が飛ばない（1 フレームの動きが raw の動き + 1.5cm 以内）", Math.max(...jumps) <= 0.015, `最大 ${cm(Math.max(...jumps))}`);
}

// ---- (e) 直進後に停止 → hold に戻る ----
for (const mixed of [false, true]) {
  const tag = mixed ? "(h)(e) dt 不均一" : "(e) 60fps";
  const hold = createAnchorHold(OPTS);
  const noise = noiser(6);
  const stopT = 1500;
  const posAt = (t) => [BASE_POS[0] + (Math.min(t, stopT) * 0.5) / 1000, BASE_POS[1], BASE_POS[2]];
  const frames = run(hold, times(3000, mixed, 11), (t) => noise(posAt(t), BASE_QUAT));
  const holdAt = frames.find((f) => f.t >= stopT && f.state === "hold")?.t ?? NaN;
  const fin = frames.at(-1);
  // 窓の平均から posM 以内なら「止まっている」なので、止まる直前の数十 ms（0.5m/s で 2cm 以内）の歩きは窓に入ってよい → inMs より少し早いこともある
  check(`${tag}: 0.5m/s で歩いて止まると inMs + 数フレームで hold に戻る`, holdAt - stopT >= OPTS.inMs - 100 && holdAt - stopT <= OPTS.inMs + (mixed ? 200 : 100), `止まってから ${(holdAt - stopT).toFixed(0)}ms`);
  check(`${tag}: 戻った固定位置は止まった位置の ±5mm（歩いていた区間を平均に混ぜない）`, dist(fin.out.pos, posAt(stopT)) <= 0.005 && fin.state === "hold", `${(dist(fin.out.pos, posAt(stopT)) * 1000).toFixed(2)}mm`);
}

// ---- (f) 0.5m の飛び → 即 follow・出力即 raw ----
{
  const { hold, noise, t, state } = heldHold(8);
  const jumpRaw = noise([BASE_POS[0] + 0.5, BASE_POS[1], BASE_POS[2]], BASE_QUAT);
  const out = hold.update(jumpRaw, t + 16);
  check("(f) hold 中に 0.5m 飛ぶと、そのフレームで follow・出力 = raw", state === "hold" && hold.state === "follow" && samePose(out, jumpRaw));
  const out2 = hold.update(noise([BASE_POS[0] + 0.5, BASE_POS[1], BASE_POS[2]], BASE_QUAT), t + 32);
  check("(f) 飛んだ後も寄せの差は残らない（出力 = raw）", hold.devPosM === 0 && hold.devDeg < 1e-4, `dev=${hold.devPosM}m/${hold.devDeg}deg`);
  void out2;
}

// ---- (g) enabled:false ----
{
  const hold = createAnchorHold({ ...OPTS, enabled: false });
  const noise = noiser(9);
  const posAt = (t) => (t < 1500 ? BASE_POS : t < 2000 ? [BASE_POS[0] + 0.05, BASE_POS[1], BASE_POS[2]] : [BASE_POS[0] + 0.6, BASE_POS[1], BASE_POS[2]]);
  const frames = run(hold, times(3000, true, 12), (t) => noise(posAt(t), BASE_QUAT));
  check("(g) enabled:false では常に出力 = raw（止まっていても・ずれても・飛んでも）、hold に入らない", frames.every((f) => samePose(f.out, f.raw) && f.state === "follow" && f.info === "off"));
}

// ---- その他: dt ≤ 0（同じ時刻が続く）でも壊れない / reset ----
{
  const hold = createAnchorHold(OPTS);
  const raw = { pos: [...BASE_POS], quat: [...BASE_QUAT] };
  hold.update(raw, 100);
  const o = hold.update({ pos: [BASE_POS[0] + 0.05, BASE_POS[1], BASE_POS[2]], quat: [...BASE_QUAT] }, 100);
  const o2 = hold.update(raw, 50); // 戻った時刻（dt < 0 は 0 として扱う）
  check("dt ≤ 0（同じ時刻・戻った時刻）でも NaN を出さない", [...o.pos, ...o.quat, ...o2.pos, ...o2.quat].every(Number.isFinite) && Number.isFinite(hold.devPosM));
  const { hold: h2 } = heldHold(10);
  h2.reset();
  const r = { pos: [1, 2, 3], quat: [0, 0, 0, 1] };
  const o3 = h2.update(r, 5000);
  check("reset() の後の最初の update は follow で出力 = raw", h2.state === "follow" && samePose(o3, r) && Number.isNaN(h2.heldSinceMs));
  const { hold: h3 } = heldHold(11);
  check("HUD の info は hold dev=…m/…deg held=…s の形", /^hold dev=\d+\.\d{3}m\/\d+\.\d deg held=\d+\.\ds$/.test(h3.info.replace("deg", " deg")), h3.info);
}

const failed = results.filter(([, ok]) => !ok);
console.log(failed.length === 0 ? `\nALL PASS (${results.length})` : `\n${failed.length} FAILED / ${results.length}`);
process.exit(failed.length === 0 ? 0 : 1);
