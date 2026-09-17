// 08-7（demos/08-7-splatoon-alva）の純粋な数学の回帰テスト。`npm run test:splatoon-alva` で実行する。
//   1. 手計算の固定期待値（生成側の関数 threePoseToAlva / invertSimilarity を使わない）:
//      AlvaAR の姿勢（OpenCV 流儀・行優先の Twc）→ three 流儀、相似変換の推定
//   2. 合成の往復: 正解の軌道 → 別の原点・スケール・回転の SLAM 軌道（+ ノイズ）→ 最初の数フレームの対応から推定 →
//      残りのフレーム（遠くまで歩いた先）が正解に戻る
//   3. SlamFusion（組の間引き・窓・clear）
// テストフレームワークは使わない（他の test-*.mjs と同じ方針）。Node 22.18+ は .ts をそのまま import できる
import {
  SlamFusion,
  alvaPoseToThree,
  applySimilarity,
  estimateSimilarity,
  invertSimilarity,
  mapSlamPose,
  quatAngleDeg,
  quatMul,
  quatNormalize,
  rotateVec,
  threePoseToAlva,
  yawPitchRollDeg,
} from "../demos/08-7-splatoon-alva/slam-fusion.ts";

const results = [];
function check(name, cond, detail = "") {
  results.push([name, cond]);
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${detail ? ` (${detail})` : ""}`);
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const nearVec = (a, b, eps = 1e-6) => a.length === b.length && a.every((v, i) => near(v, b[i], eps));
/** 四元数は q と -q が同じ回転 */
const nearQuat = (a, b, eps = 1e-6) => nearVec(a, b, eps) || nearVec(a, b.map((v) => -v), eps);
const fmt = (v) => `(${v.map((x) => x.toFixed(4)).join(",")})`;
const H = Math.SQRT1_2;

// ---- 1. 手計算の固定期待値 ----
{
  // (a) 回転なし・位置 (1,2,3)。OpenCV の Y 下・Z 前 → three の Y 上・Z 後ろなので位置は (1,-2,-3)
  const pose = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1];
  const p = alvaPoseToThree(pose);
  check("手計算(a): 回転なしの位置は Y・Z が反転する", nearVec(p.pos, [1, -2, -3]), fmt(p.pos));
  check("手計算(a): 回転なしの向きは単位四元数", nearQuat(p.quat, [0, 0, 0, 1]), fmt(p.quat));
}
{
  // (b) OpenCV の Y 軸（下）まわり +90°: Rwc = [[0,0,1],[0,1,0],[-1,0,0]]（行優先で [0..2]=0 行目 …）。
  // カメラの前（OpenCV の +Z = Rwc の 2 列目）は SLAM ワールドの +X。three でもワールドの X は同じ向きなので
  // three のカメラは +X を向く = three の Y 軸（上）まわり -90°（(0,0,-1) を Ry(-90°) で回すと (1,0,0)）→ 四元数 (0,-√½,0,√½)
  const pose = [0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 0, 1];
  const p = alvaPoseToThree(pose);
  check("手計算(b): OpenCV の Y まわり +90° は three の Y まわり -90°（右を向く）", nearQuat(p.quat, [0, -H, 0, H]), fmt(p.quat));
  const fwd = rotateVec(p.quat, [0, 0, -1]);
  check("手計算(b): three のカメラの前方 (0,0,-1) はワールドの +X", nearVec(fwd, [1, 0, 0]), fmt(fwd));
}
{
  // (c) OpenCV の X 軸まわり +90°: Rwc = [[1,0,0],[0,0,-1],[0,1,0]]。カメラの前（2 列目）は (0,-1,0) = OpenCV で「上」
  // → three では上を見上げる = three の X 軸まわり +90° → (√½,0,0,√½)。
  // カメラの下（OpenCV の +Y = 1 列目）は (0,0,1) = OpenCV で前 → three のカメラの上 (+Y) は three のワールドで +Z
  const pose = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0.5, -1, 2, 1];
  const p = alvaPoseToThree(pose);
  check("手計算(c): OpenCV の X まわり +90° は three で見上げる（X まわり +90°）", nearQuat(p.quat, [H, 0, 0, H]), fmt(p.quat));
  check("手計算(c): three のカメラの上 (0,1,0) はワールドの +Z", nearVec(rotateVec(p.quat, [0, 1, 0]), [0, 0, 1]));
  check("手計算(c): 位置 (0.5,-1,2) → (0.5,1,-2)", nearVec(p.pos, [0.5, 1, -2]), fmt(p.pos));
  const ypr = yawPitchRollDeg(p.quat);
  check("手計算(c): HUD の向きはピッチ +90°", near(ypr[1], 90, 1e-3), fmt(ypr));
}
{
  // (d) 相似変換の推定: field = 0.5 · Ry(+90°) · slam + (1,2,3)。
  // field の 4 点 (0,0,0),(1,0,0),(0,0,1),(1,0,1) に対する slam は slam = 2 · Ry(-90°)(field − (1,2,3))、
  // Ry(-90°)(x,y,z) = (-z, y, x) なので (6,-4,-2),(6,-4,0),(4,-4,-2),(4,-4,0)。
  // 向き: SLAM のカメラは単位、field のカメラは Ry(+90°) = (0,√½,0,√½)
  const field = [[0, 0, 0], [1, 0, 0], [0, 0, 1], [1, 0, 1]];
  const slam = [[6, -4, -2], [6, -4, 0], [4, -4, -2], [4, -4, 0]];
  const pairs = field.map((f, i) => ({ slam: { pos: slam[i], quat: [0, 0, 0, 1] }, field: { pos: f, quat: [0, H, 0, H] } }));
  const e = estimateSimilarity(pairs, { minBaselineM: 0.1 });
  check("手計算(d): 推定できる", e !== null);
  if (e) {
    check("手計算(d): スケール 0.5", near(e.sim.scale, 0.5), e.sim.scale.toFixed(6));
    check("手計算(d): 回転 Ry(+90°)", nearQuat(e.sim.quat, [0, H, 0, H]), fmt(e.sim.quat));
    check("手計算(d): 平行移動 (1,2,3)", nearVec(e.sim.trans, [1, 2, 3]), fmt(e.sim.trans));
    check("手計算(d): 残差 0", e.residualM < 1e-9, String(e.residualM));
    // 新しい点: slam (0,0,0) → (1,2,3)、slam (2,0,0) → 0.5·Ry(90°)(2,0,0) = 0.5·(0,0,-2) = (0,0,-1) → (1,2,2)
    check("手計算(d): slam (0,0,0) は field (1,2,3)", nearVec(applySimilarity(e.sim, [0, 0, 0]), [1, 2, 3]));
    check("手計算(d): slam (2,0,0) は field (1,2,2)", nearVec(applySimilarity(e.sim, [2, 0, 0]), [1, 2, 2]), fmt(applySimilarity(e.sim, [2, 0, 0])));
  }
  // 基線が足りない（全部同じ点）ならスケールは決まらない
  const still = field.map(() => ({ slam: { pos: [6, -4, -2], quat: [0, 0, 0, 1] }, field: { pos: [0, 0, 0], quat: [0, H, 0, H] } }));
  check("手計算(d): 動いていなければ推定しない（null）", estimateSimilarity(still, { minBaselineM: 0.1 }) === null);
  check("手計算(d): 組が 1 つなら null", estimateSimilarity(pairs.slice(0, 1), { minBaselineM: 0 }) === null);
}

// ---- 2. 合成の往復 ----
// 乱数は固定シード（mulberry32）
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
const axisAngle = (axis, deg) => {
  const h = ((deg * Math.PI) / 180) / 2;
  const n = Math.hypot(...axis);
  return [(axis[0] / n) * Math.sin(h), (axis[1] / n) * Math.sin(h), (axis[2] / n) * Math.sin(h), Math.cos(h)];
};
function roundTrip({ seed, slamNoiseM, fieldNoiseM, yawNoiseDeg, calibFrames }) {
  const rand = rng(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
  // SLAM 座標系（field → slam の相似変換。AlvaAR の初期化時のカメラの向き・任意スケールに相当）
  const fieldToSlam = { scale: 0.37, quat: quatNormalize(quatMul(axisAngle([0, 1, 0], 140), axisAngle([1, 0.3, 0], 25))), trans: [0.8, -0.4, 1.9] };
  const frames = [];
  for (let i = 0; i < 200; i++) {
    const t = i / 199;
    // マーカーの前 1.2m から横に揺れつつ、後半は 2.5m 後ろ・横 1.5m まで歩く（しゃがむ・見回す）
    const truePos = i < calibFrames ? [0.3 * Math.sin(i * 0.7), 1.5 + 0.05 * Math.sin(i * 1.3), 1.2 + 0.1 * Math.cos(i * 0.5)] : [1.5 * t, 1.4 + 0.2 * Math.sin(t * 9), 1.2 + 2.5 * t];
    const trueQuat = quatNormalize(quatMul(axisAngle([0, 1, 0], 60 * Math.sin(i * 0.1)), axisAngle([1, 0, 0], -20 * Math.cos(i * 0.13))));
    // SLAM が返す値: slam 座標系の姿勢を AlvaAR の形式（OpenCV 流儀）にして、変換関数で three 流儀に戻す（実機と同じ経路）
    const sp = applySimilarity(fieldToSlam, truePos).map((v) => v + slamNoiseM * gauss());
    const sq = quatMul(fieldToSlam.quat, trueQuat);
    const slam = alvaPoseToThree(threePoseToAlva({ pos: sp, quat: sq }));
    // マーカー由来の field 姿勢: 位置のノイズ + ヨーのノイズ
    const fieldPos = truePos.map((v) => v + fieldNoiseM * gauss());
    const fieldQuat = quatNormalize(quatMul(axisAngle([0, 1, 0], yawNoiseDeg * gauss()), trueQuat));
    frames.push({ truePos, trueQuat, slam, field: { pos: fieldPos, quat: fieldQuat } });
  }
  const est = estimateSimilarity(frames.slice(0, calibFrames).map((f) => ({ slam: f.slam, field: f.field })), { minBaselineM: 0.1 });
  if (!est) return null;
  let maxErr = 0;
  let maxFar = 0;
  let maxRot = 0;
  for (const f of frames.slice(calibFrames)) {
    const m = mapSlamPose(est.sim, f.slam);
    const err = Math.hypot(m.pos[0] - f.truePos[0], m.pos[1] - f.truePos[1], m.pos[2] - f.truePos[2]);
    maxErr = Math.max(maxErr, err);
    maxFar = Math.max(maxFar, Math.hypot(f.truePos[0], f.truePos[2] - 1.2));
    maxRot = Math.max(maxRot, quatAngleDeg(m.quat, f.trueQuat));
  }
  return { est, maxErr, maxFar, maxRot, truth: invertSimilarity(fieldToSlam) };
}
{
  const r = roundTrip({ seed: 1, slamNoiseM: 0, fieldNoiseM: 0, yawNoiseDeg: 0, calibFrames: 30 });
  check("往復(ノイズ無し): 推定できる", r !== null);
  if (r) {
    check("往復(ノイズ無し): スケールが正解（1/0.37）", near(r.est.sim.scale, 1 / 0.37, 1e-6), `${r.est.sim.scale.toFixed(5)} vs ${r.truth.scale.toFixed(5)}`);
    check("往復(ノイズ無し): 回転が正解", quatAngleDeg(r.est.sim.quat, r.truth.quat) < 1e-4);
    check("往復(ノイズ無し): 平行移動が正解", nearVec(r.est.sim.trans, r.truth.trans, 1e-6), `${fmt(r.est.sim.trans)} vs ${fmt(r.truth.trans)}`);
    check("往復(ノイズ無し): 校正後に最大 2.9m 歩いても位置が正解に戻る（< 1mm）", r.maxErr < 1e-3, `max=${r.maxErr.toExponential(2)}m far=${r.maxFar.toFixed(2)}m`);
    check("往復(ノイズ無し): 向きも正解に戻る", r.maxRot < 1e-3, `${r.maxRot.toExponential(2)}deg`);
  }
  // ノイズあり: SLAM 1cm 相当（field 換算 0.37 倍で 3.7mm × 1/0.37）・マーカー位置 2cm・ヨー 3° を 30 フレームで平均
  const n = roundTrip({ seed: 7, slamNoiseM: 0.37 * 0.01, fieldNoiseM: 0.02, yawNoiseDeg: 3, calibFrames: 30 });
  check("往復(ノイズあり): 推定できる", n !== null);
  if (n) {
    const scaleErr = Math.abs(n.est.sim.scale / n.truth.scale - 1);
    check("往復(ノイズあり): スケール誤差 10% 未満", scaleErr < 0.1, `${(scaleErr * 100).toFixed(1)}%`);
    check("往復(ノイズあり): 回転誤差 2° 未満（ヨー 3° のノイズを平均）", quatAngleDeg(n.est.sim.quat, n.truth.quat) < 2, `${quatAngleDeg(n.est.sim.quat, n.truth.quat).toFixed(2)}deg`);
    check("往復(ノイズあり): 最大 2.9m 歩いた先の位置誤差 < 0.4m", n.maxErr < 0.4, `max=${n.maxErr.toFixed(3)}m`);
  }
  // 手計算の符号の取り違え検出: AlvaAR の値を変換せずにそのまま three として読むと戻らない
  const rand = rng(3);
  const fieldToSlam = { scale: 0.5, quat: axisAngle([0, 1, 0], 30), trans: [0.2, 0.1, -0.3] };
  const raw = [];
  for (let i = 0; i < 20; i++) {
    const truePos = [rand() - 0.5, 1.5 + 0.3 * (rand() - 0.5), 1 + rand() - 0.5];
    const trueQuat = axisAngle([0, 1, 0], 90 * (rand() - 0.5));
    const alva = threePoseToAlva({ pos: applySimilarity(fieldToSlam, truePos), quat: quatMul(fieldToSlam.quat, trueQuat) });
    const wrong = { pos: [alva[12], alva[13], alva[14]], quat: trueQuat };
    raw.push({ truePos, pair: { slam: wrong, field: { pos: truePos, quat: trueQuat } } });
  }
  const wrongEst = estimateSimilarity(raw.map((r) => r.pair), { minBaselineM: 0.1 });
  const wrongErr = wrongEst ? Math.max(...raw.map((r) => Math.hypot(...applySimilarity(wrongEst.sim, r.pair.slam.pos).map((v, k) => v - r.truePos[k])))) : Infinity;
  check("変換を飛ばすと戻らない（テスト自体が符号の誤りを検出できる）", wrongErr > 0.05, `max=${Number.isFinite(wrongErr) ? wrongErr.toFixed(3) : "null"}m`);
}

// ---- 3. SlamFusion ----
{
  const fusion = new SlamFusion({ minBaselineM: 0.1, maxPairs: 5, minPairIntervalMs: 100 });
  const pair = (x) => ({ slam: { pos: [x * 2, 0, 0], quat: [0, 0, 0, 1] }, field: { pos: [x, 1, 0], quat: [0, 0, 0, 1] } });
  check("SlamFusion: 最初の組は足す", fusion.add(pair(0), 0));
  check("SlamFusion: 間隔が短い組は足さない", !fusion.add(pair(0.5), 50));
  check("SlamFusion: 基線不足の間は推定なし", fusion.estimate === null && fusion.toField([0, 0, 0]) === null && fusion.describe() === "calib n=1");
  for (let i = 1; i <= 6; i++) fusion.add(pair(i * 0.1), i * 100);
  check("SlamFusion: 窓の上限で古い組を捨てる", fusion.pairs.length === 5);
  const f = fusion.toField([2, 0, 0]);
  check("SlamFusion: 推定後は SLAM の位置を field に写せる（slam x=2 → field x=1, y=1）", f !== null && nearVec(f, [1, 1, 0], 1e-9), f ? fmt(f) : "null");
  check("SlamFusion: describe に s= が出る", /^s=0\.50 res=0\.000m/.test(fusion.describe()), fusion.describe());
  fusion.clear();
  check("SlamFusion: clear で推定が消える（SLAM のリセット時）", fusion.estimate === null && fusion.pairs.length === 0);
}

const failed = results.filter(([, ok]) => !ok);
console.log(failed.length === 0 ? "\nALL PASS" : `\n${failed.length} FAILED`);
process.exit(failed.length === 0 ? 0 : 1);
