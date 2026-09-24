// 08-9（demos/08-9-splatoon-hold）の「静止中はアンカーを動かさない」状態機械（anchor-hold.ts）の回帰テスト。
// `npm run test:08-9-hold` で実行する。three.js もブラウザも使わず、合成の raw（アンカーの姿勢）の列を流して出力を見る。
//   (a) 固定姿勢に ±1cm・±0.5° の一様ノイズ（60fps、3 秒）→ inMs で hold、直後に固定姿勢へ滑ってから出力が一切変わらない、
//       固定位置は種 20 通りでノイズの中心から中央値 ≤ 3mm・最悪 ≤ 5mm
//   (b) 0.5m/s で 2 秒直進（ノイズ付き）→ 出力の raw からの遅れが常に 3cm 以内、hold に落ちない
//       (b') 止まって hold に入ってから歩き出した場合の遅れ（歩き始めの遅れの実測。README に書く値）
//   (c) hold 中に 1 フレームだけ 10cm 飛ぶ → 出力不変
//   (d) hold 中に 5cm ずれた raw が 0.3 秒続く → follow に移り 0.5 秒以内に追いつく
//   (e) 直進後に停止 → inMs + 数フレームで hold に戻る
//   (f) 0.5m の飛び → 即 follow・出力即 raw
//   (g) enabled:false → 常に出力 = raw
//   (h) dt が不均一（16ms と 100ms 混在）でも (a)(b) が成り立つ
//   ほか: 回転だけで抜ける / hold に入る瞬間の連続性 / ?holdTau=1000 / NaN / 窓の点の数 / 長いフレーム落ち /
//   実機に近い raw（検出 100ms ごと + lerp 0.5 の減速の尾）で止まったときの偏りと往復、ゆっくり動き続けたときの往復（3 / 5 / 10cm/s）
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
// hold に入る判定は「窓の平均からのばらつきの RMS ≤ posM / deg」（最大値判定から変更）。hold に入る瞬間は直前の出力との差を持ち越して
// τ で縮めるので、入った直後の数フレームは出力が固定姿勢へ滑り、差が 1mm / 0.05° 未満になった時点からビット単位で変わらなくなる
function caseA(mixed, seed) {
  const hold = createAnchorHold(OPTS);
  const noise = noiser(seed);
  const frames = run(hold, times(3000, mixed, seed + 100), () => noise(BASE_POS, BASE_QUAT));
  const firstHold = frames.findIndex((f) => f.state === "hold");
  if (firstHold < 0) return { firstHoldMs: NaN, settledMs: NaN, stayed: false, centerErr: Infinity, centerDeg: Infinity, first: frames[0], frames };
  const after = frames.slice(firstHold);
  const fin = frames.at(-1);
  // 出力が最後まで変わらなくなった最初のフレーム（差 0 はビット単位の一致で見る）
  let settled = frames.length - 1;
  while (settled > firstHold && samePose(frames[settled - 1].out, fin.out)) settled--;
  const stayed = after.every((f) => f.state === "hold");
  return {
    firstHoldMs: frames[firstHold].t,
    settledMs: frames[settled].t,
    stayed,
    centerErr: dist(fin.out.pos, BASE_POS),
    centerDeg: quatAngleDeg(fin.out.quat, BASE_QUAT),
    first: frames[0],
    frames,
    firstHold,
  };
}
for (const mixed of [false, true]) {
  const tag = mixed ? "(h)(a) dt 不均一" : "(a) 60fps";
  const r = caseA(mixed, 1);
  check(`${tag}: 最初の update は follow で出力 = raw（初検出でいきなり固定しない）`, r.first.state === "follow" && samePose(r.first.out, r.first.raw));
  // 窓が inMs に満たないうちは判定しないので、止まっていれば inMs（+ 最大 1 フレーム）で入る（RMS 判定でも最大値判定と同じ）
  check(`${tag}: inMs（600ms）経過後すぐに hold に入る（inMs + 最大 1 フレーム）`, r.firstHoldMs >= OPTS.inMs && r.firstHoldMs <= OPTS.inMs + (mixed ? 100 : 17), `hold に入った時刻 ${r.firstHoldMs.toFixed(0)}ms`);
  check(`${tag}: hold に入ってから 0.5 秒以内に出力が固定姿勢に落ち着き、以後はビット単位で変わらない（3 秒の終わりまで hold のまま）`, r.stayed && r.settledMs - r.firstHoldMs <= 500, `落ち着いた時刻 ${r.settledMs.toFixed(0)}ms（hold から ${(r.settledMs - r.firstHoldMs).toFixed(0)}ms）`);
  console.log(`INFO: ${tag}: 種 1 の固定位置の中心からの差 ${(r.centerErr * 1000).toFixed(2)}mm / ${r.centerDeg.toFixed(3)}deg`);
  if (!mixed) {
    // 入る瞬間の連続性: 入ったフレームの出力は follow のままの出力（= raw。follow の寄せの差は無い）で、以後 1 フレームの出力の変化は数 mm
    const f = r.frames;
    const i = r.firstHold;
    const steps = f.slice(i, i + 40).map((x, k) => dist(x.out.pos, f[i + k - 1].out.pos));
    check(`${tag}: hold に入る瞬間に出力が飛ばない（入ったフレームの出力 = そのフレームの raw、以後 1 フレームの変化 ≤ 3mm）`, samePose(f[i].out, f[i].raw) && Math.max(...steps.slice(1)) <= 0.003, `入った後の 1 フレームの変化の最大 ${(Math.max(...steps.slice(1)) * 1000).toFixed(2)}mm`);
  }
  // 固定位置 = 窓の平均なので、中心からの差は窓の点の数で決まる（各軸 ±1cm の一様ノイズ → 標準偏差 5.8mm / √n）。
  // 種 1 つでは運で決まるので、種 20 通りの中央値 ≤ 3mm かつ最悪 ≤ 5mm で見る（dt 不均一は窓の点が約 10 個しかないので最悪値が大きい）
  const many = Array.from({ length: 20 }, (_, i) => caseA(mixed, 1000 + i));
  const allHeld = many.every((x) => x.stayed && x.firstHoldMs <= OPTS.inMs + (mixed ? 100 : 17) && x.settledMs - x.firstHoldMs <= 500);
  const errs = many.map((x) => x.centerErr * 1000).sort((a, b) => a - b);
  const med = (errs[9] + errs[10]) / 2;
  check(`${tag}: 種 20 通りの固定位置の中心からの差が 中央値 ≤ 3mm かつ 最悪 ≤ 5mm`, med <= 3 && errs[19] <= 5, `中央値 ${med.toFixed(2)}mm / 最悪 ${errs[19].toFixed(2)}mm`);
  check(`${tag}: 種 20 通りすべてで inMs 後に hold に入り、0.5 秒以内に落ち着いて以後出力が変わらない`, allHeld);
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

/** 止まって hold に入り、出力が固定姿勢に落ち着いた状態の hold を作る（2 秒ノイズ付きで流す） */
function heldHold(seed, mixed = false) {
  const hold = createAnchorHold(OPTS);
  const noise = noiser(seed);
  const frames = run(hold, times(2000, mixed, seed + 300), () => noise(BASE_POS, BASE_QUAT));
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
  // RMS 判定だけだと止まる直前の歩きを含んだ窓で入り、固定姿勢が歩いてきた側に寄った（60fps で 483ms・6.0mm）。
  // ドリフト条件（窓の前半と後半の平均の差 ≤ posM × 0.5）を足して、歩きがほぼ窓から抜けるまで待つ（517ms・3.0mm。dt 不均一は 624ms・2.5mm）
  console.log(`INFO: ${tag}: 止まってから hold まで ${(holdAt - stopT).toFixed(0)}ms、固定位置と止まった位置の差 ${(dist(fin.out.pos, posAt(stopT)) * 1000).toFixed(2)}mm`);
  check(`${tag}: 0.5m/s で歩いて止まると inMs + 数フレーム以内に hold に戻る`, holdAt - stopT >= 0 && holdAt - stopT <= OPTS.inMs + (mixed ? 200 : 100), `止まってから ${(holdAt - stopT).toFixed(0)}ms`);
  check(`${tag}: 戻った固定位置は止まった位置の ±4mm（歩いていた区間を平均にほとんど混ぜない）`, dist(fin.out.pos, posAt(stopT)) <= 0.004 && fin.state === "hold", `${(dist(fin.out.pos, posAt(stopT)) * 1000).toFixed(2)}mm`);
}

// ---- (f) 0.5m の飛び → 即 follow・出力即 raw ----
{
  const { hold, noise, t, state } = heldHold(8);
  const jumpRaw = noise([BASE_POS[0] + 0.5, BASE_POS[1], BASE_POS[2]], BASE_QUAT);
  const out = hold.update(jumpRaw, t + 16);
  check("(f) hold 中に 0.5m 飛ぶと、そのフレームで follow・出力 = raw", state === "hold" && hold.state === "follow" && samePose(out, jumpRaw));
  const next = noise([BASE_POS[0] + 0.5, BASE_POS[1], BASE_POS[2]], BASE_QUAT);
  check("(f) 飛んだ後も寄せの差は残らない（出力 = raw）", samePose(hold.update(next, t + 32), next) && hold.devPosM === 0 && hold.devDeg < 1e-9, `dev=${hold.devPosM}m/${hold.devDeg}deg`);
}

// ---- (g) enabled:false ----
{
  const hold = createAnchorHold({ ...OPTS, enabled: false });
  const noise = noiser(9);
  const posAt = (t) => (t < 1500 ? BASE_POS : t < 2000 ? [BASE_POS[0] + 0.05, BASE_POS[1], BASE_POS[2]] : [BASE_POS[0] + 0.6, BASE_POS[1], BASE_POS[2]]);
  const frames = run(hold, times(3000, true, 12), (t) => noise(posAt(t), BASE_QUAT));
  check("(g) enabled:false では常に出力 = raw（止まっていても・ずれても・飛んでも）、hold に入らない", frames.every((f) => samePose(f.out, f.raw) && f.state === "follow" && f.info === "off"));
}

// ---- 回転だけで抜ける: 位置は動かず、向きが 4° ずれ続ける（deg = 2°、離脱は deg × exitRatio 1.5 = 3° を超えたとき）----
{
  const { hold, noise, t, state } = heldHold(12);
  const turned = mul(quatFromEulerDeg(4, 0, 0), BASE_QUAT);
  const stepT = t + 1000 / 60;
  const frames = run(hold, times(1200, false, 7, stepT), () => noise(BASE_POS, turned));
  const followAt = frames.find((f) => f.state === "follow")?.t ?? NaN;
  const fol = frames.filter((f) => f.state === "follow" && f.t >= followAt + 500);
  const gapDeg = Math.max(...fol.map((f) => quatAngleDeg(f.out.quat, f.raw.quat)));
  check("回転だけ: 位置は同じで向きが 4° ずれ続けると outMs 前後で follow に移り、0.5 秒後には出力の向きが raw に追いついている（0.3° 以内）", state === "hold" && followAt - stepT >= OPTS.outMs && followAt - stepT <= OPTS.outMs + 50 && gapDeg <= 0.3, `follow まで ${(followAt - stepT).toFixed(0)}ms、0.5s 後の向きの差 ${gapDeg.toFixed(3)}deg`);
}

// ---- follow の寄せが残ったまま止まる（?holdTau=1000）: hold に入る瞬間も飛ばない ----
{
  const hold = createAnchorHold({ ...OPTS, catchUpTauMs: 1000 });
  // ノイズ無しで 1 秒止まって hold → 5cm ずれてそのまま止まる。follow に入ってから 600ms では寄せの差が 5cm × e^(−0.6) ≈ 2.7cm 残っている
  const shifted = [BASE_POS[0] + 0.05, BASE_POS[1], BASE_POS[2]];
  // 寄せの差 2.7cm が 1mm 未満になるまで τ × ln(27) ≈ 3.3 秒かかるので 7 秒流す
  const frames = run(hold, times(7000, false), (t) => ({ pos: t < 1500 ? [...BASE_POS] : [...shifted], quat: [...BASE_QUAT] }));
  const reHold = frames.findIndex((f, i) => i > 0 && f.t > 1500 && f.state === "hold" && frames[i - 1].state === "follow");
  const residual = reHold > 0 ? dist(frames[reHold - 1].out.pos, frames[reHold - 1].raw.pos) : NaN;
  const steps = frames.slice(1).map((f, i) => dist(f.out.pos, frames[i].out.pos));
  // 1 フレームの変化は寄せ（5cm × (1 − e^(−16.7/1000)) ≈ 0.8mm）と、差が 1mm 未満になって 0 にする最後の 1 回（≈ 1mm）が最大
  check("?holdTau=1000: 寄せの差が残ったまま hold に入っても出力は飛ばない（1 フレームの変化 ≤ 1.5mm）、最後は固定姿勢 = 止まった位置", reHold > 0 && Math.max(...steps) <= 0.0015 && dist(frames.at(-1).out.pos, shifted) < 0.001, `hold に入る直前の寄せの差 ${cm(residual)}、1 フレームの変化の最大 ${(Math.max(...steps) * 1000).toFixed(3)}mm`);
}

// ---- 非有限の raw・窓の点が少ない ----
{
  const { hold, noise, t, heldOut, state } = heldHold(13);
  // hold 中に閾値超え（5cm）→ NaN → 閾値超え … と続けても、NaN のフレームで継続時間がリセットされず outMs で follow に移る
  const shifted = [BASE_POS[0], BASE_POS[1] + 0.05, BASE_POS[2]];
  const ts = times(400, false, 7, t + 1000 / 60);
  const frames = run(hold, ts, (tt, ) => (Math.round((tt - t) / (1000 / 60)) % 3 === 0 ? { pos: [NaN, 0, 0], quat: [0, 0, 0, 1] } : noise(shifted, BASE_QUAT)));
  const nanFrames = frames.filter((f) => !Number.isFinite(f.raw.pos[0]));
  const nanOk = nanFrames.every((f) => f.out.pos.every(Number.isFinite));
  const followAt = frames.find((f) => f.state === "follow")?.t ?? NaN;
  check("非有限の raw: hold 中に NaN が混ざっても出力は有限のまま、閾値超えの継続時間はリセットされず outMs で follow に移る", state === "hold" && nanFrames.length > 0 && nanOk && samePose(frames[0].out, heldOut) && followAt - (t + 1000 / 60) <= OPTS.outMs + 20, `follow まで ${(followAt - t).toFixed(0)}ms`);
  // 窓の点が 3 個未満なら、窓が inMs を満たしていても hold に入らない（0ms と 600ms の 2 点では入らず、650ms の 3 点目で入る）
  const h2 = createAnchorHold(OPTS);
  h2.update({ pos: [...BASE_POS], quat: [...BASE_QUAT] }, 0);
  h2.update({ pos: [...BASE_POS], quat: [...BASE_QUAT] }, 600);
  const s2 = h2.state;
  h2.update({ pos: [...BASE_POS], quat: [...BASE_QUAT] }, 650);
  check("窓の点が 2 個（0ms と 600ms）では hold に入らず、3 個目で入る", s2 === "follow" && h2.state === "hold", `${s2} → ${h2.state}`);
  // 長いフレーム落ち: 0 / 100 / 200ms に止まる → 3 秒空く → 3cm 先で止まる。窓を作り直すので固定姿勢は新しい位置（修正前は 3 秒前の点が混ざって 10mm ずれた）
  const h3 = createAnchorHold(OPTS);
  for (const tt of [0, 100, 200]) h3.update({ pos: [...BASE_POS], quat: [...BASE_QUAT] }, tt);
  const moved = [BASE_POS[0] + 0.03, BASE_POS[1], BASE_POS[2]];
  let gapOut = null;
  for (let tt = 3200; tt <= 6000; tt += 100) gapOut = h3.update({ pos: [...moved], quat: [...BASE_QUAT] }, tt);
  check("長いフレーム落ちの後は窓を作り直す（固定姿勢は落ちた後の位置 ±1mm）", h3.state === "hold" && dist(gapOut.pos, moved) <= 0.001, `差 ${(dist(gapOut.pos, moved) * 1000).toFixed(2)}mm`);
  // 最初のフレームが非有限なら単位姿勢を返す（NaN の姿勢を表示に写さない）
  const h4 = createAnchorHold(OPTS);
  const o4 = h4.update({ pos: [NaN, 0, 0], quat: [0, 0, 0, 1] }, 0);
  check("最初のフレームの raw が非有限なら単位姿勢（pos 0、quat [0,0,0,1]）を返す", samePose(o4, { pos: [0, 0, 0], quat: [0, 0, 0, 1] }));
}

// ---- 実機に近い raw: マーカー検出は 100ms ごと、raw は検出のたびに lerp 0.5 で寄る（marker-anchor の smooth=0.5）----
// 検出値には各軸 ±1cm・±0.5° の一様ノイズ。raw は検出の間は一定で、止まると減速の尾（0.5 倍ずつ縮む）を引く
function realisticRaw(seed, truthAt, noisePos = 0.01, noiseDeg = 0.5) {
  const noise = noiser(seed, noisePos, noiseDeg);
  let raw = null;
  let nextDet = 0;
  return (t) => {
    while (t >= nextDet) {
      const m = noise(truthAt(nextDet), BASE_QUAT);
      if (!raw) raw = m;
      else {
        raw = {
          pos: raw.pos.map((v, i) => v + 0.5 * (m.pos[i] - v)),
          quat: (() => {
            const d = raw.quat.reduce((a, v, i) => a + v * m.quat[i], 0) < 0 ? -1 : 1;
            const q = raw.quat.map((v, i) => v + 0.5 * (m.quat[i] * d - v));
            const n = Math.hypot(...q);
            return q.map((v) => v / n);
          })(),
        };
      }
      nextDet += 100;
    }
    return { pos: [...raw.pos], quat: [...raw.quat] };
  };
}
/** follow → hold に入った回数（時刻 from 以降） */
const holdEntries = (frames, from = 0) => frames.filter((f, i) => i > 0 && f.t >= from && f.state === "hold" && frames[i - 1].state === "follow").length;
const median = (xs) => {
  const a = [...xs].sort((x, y) => x - y);
  return a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2;
};
/** 0.5m/s で 1.5 秒歩いて止まる。止まってから hold までの時間・固定位置の偏り・止まった後の hold に入り直した回数 */
function caseStop(seed) {
  const stopT = 1500;
  const truthAt = (t) => [BASE_POS[0] + (Math.min(t, stopT) * 0.5) / 1000, BASE_POS[1], BASE_POS[2]];
  const hold = createAnchorHold(OPTS);
  const frames = run(hold, times(9000, false), realisticRaw(seed, truthAt));
  const first = frames.findIndex((f) => f.t >= stopT && f.state === "hold");
  const holdAt = first >= 0 ? frames[first].t - stopT : NaN;
  // 固定姿勢に落ち着いた後（hold に入って 700ms 後）の出力と、止まった位置の差
  const settled = first >= 0 ? frames.find((f) => f.t >= frames[first].t + 700) : null;
  const bias = settled && settled.state === "hold" ? dist(settled.out.pos, truthAt(stopT)) : NaN;
  return { holdAt, bias, reentries: Math.max(0, holdEntries(frames, stopT) - 1) };
}
/** v [m/s] でゆっくり 8 秒動き続ける。hold に入った回数（= hold と follow の往復） */
function caseSlow(seed, v) {
  const truthAt = (t) => [BASE_POS[0] + (v * t) / 1000, BASE_POS[1], BASE_POS[2]];
  const hold = createAnchorHold(OPTS);
  const frames = run(hold, times(8000, false), realisticRaw(seed, truthAt));
  return holdEntries(frames, 1000);
}
{
  const stops = Array.from({ length: 20 }, (_, i) => caseStop(2000 + i));
  // 偏りは hold に入って 700ms 後も hold のままの種だけで測る（その前に follow に戻った種の数も出す = 閾値の際で往復している）
  const biasMm = stops.filter((x) => Number.isFinite(x.bias)).map((x) => x.bias * 1000);
  const leftEarly = stops.filter((x) => !Number.isFinite(x.bias)).length;
  const holdMs = stops.map((x) => x.holdAt);
  const re = stops.reduce((a, x) => a + x.reentries, 0);
  console.log(`INFO: 実機相当の停止（種 20）: 止まってから hold まで 中央値 ${median(holdMs).toFixed(0)}ms / 最大 ${Math.max(...holdMs).toFixed(0)}ms、固定位置の偏り 中央値 ${median(biasMm).toFixed(1)}mm / 最悪 ${Math.max(...biasMm).toFixed(1)}mm、hold に入って 700ms 以内に follow に戻った種 ${leftEarly}、止まった後 7.5 秒で hold に入り直した回数 計 ${re}`);
  const st = { biasMed: median(biasMm), biasMax: Math.max(...biasMm), holdMed: median(holdMs), holdMax: Math.max(...holdMs), re, leftEarly };

  const slow = {};
  for (const v of [0.03, 0.05, 0.1]) slow[v] = Array.from({ length: 20 }, (_, i) => caseSlow(3000 + i, v)).reduce((a, x) => a + x, 0);
  console.log(`INFO: ゆっくり動き続ける 8 秒（種 20 の合計）で hold に入った回数: 3cm/s ${slow[0.03]}、5cm/s ${slow[0.05]}、10cm/s ${slow[0.1]}`);
  // 修正前（RMS だけ・離脱は posM）: 停止から hold まで 中央値 600ms、偏り 中央値 15.8mm / 最悪 21.7mm、700ms 以内に戻った種 1、入り直し計 11、
  // ゆっくり動く 3 / 5 / 10cm/s で hold に入った回数 114 / 140 / 153。ドリフト条件 + 離脱のヒステリシスでの期待値を下で見る
  check("実機相当の停止: 固定位置の偏りが 中央値 ≤ 8mm・最悪 ≤ 12mm（減速の尾を平均に混ぜない）", st.biasMed <= 8 && st.biasMax <= 12, `中央値 ${st.biasMed.toFixed(1)}mm / 最悪 ${st.biasMax.toFixed(1)}mm`);
  check("実機相当の停止: hold に入った後、閾値の際で follow と往復しない（700ms 以内に戻る種 0、7.5 秒で入り直し 0）", st.leftEarly === 0 && st.re === 0, `戻った種 ${st.leftEarly}、入り直し ${st.re}`);
  check("実機相当の停止: 止まってから 1 秒以内に hold に入る", st.holdMax <= 1000, `中央値 ${st.holdMed.toFixed(0)}ms / 最大 ${st.holdMax.toFixed(0)}ms`);
  check("ゆっくり動き続ける: 10cm/s では一度も hold に入らない、5cm/s は種 20 の合計 20 回以下", slow[0.1] === 0 && slow[0.05] <= 20, `3cm/s ${slow[0.03]}、5cm/s ${slow[0.05]}、10cm/s ${slow[0.1]}`);
}

// ---- 離脱のヒステリシス: hold 中に raw が固定姿勢から 2.5cm（posM と posM × exitRatio の間）ずれ続けても出ない、3.5cm なら出る ----
{
  for (const [off, expect] of [[0.025, "hold"], [0.035, "follow"]]) {
    const hold = createAnchorHold(OPTS);
    const frames = run(hold, times(3000, false), (t) => ({ pos: [BASE_POS[0] + (t < 1500 ? 0 : off), BASE_POS[1], BASE_POS[2]], quat: [...BASE_QUAT] }));
    check(`離脱のヒステリシス: 固定姿勢から ${(off * 100).toFixed(1)}cm ずれ続けると ${expect === "hold" ? "hold のまま" : "follow に移る"}（離脱は posM × 1.5 = 3cm 超）`, frames.find((f) => f.t >= 1500 + OPTS.outMs + 50)?.state === expect);
  }
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
  check("HUD の info は hold dev=…m/…deg held=…s の形", /^hold dev=\d+\.\d{3}m\/\d+\.\ddeg held=\d+\.\ds$/.test(h3.info), h3.info);
}

const failed = results.filter(([, ok]) => !ok);
console.log(failed.length === 0 ? `\nALL PASS (${results.length})` : `\n${failed.length} FAILED / ${results.length}`);
process.exit(failed.length === 0 ? 0 : 1);
