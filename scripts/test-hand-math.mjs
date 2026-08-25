// src/shared/hand-math.ts（手ランドマーク → カメラ座標系の変換）の回帰テスト。
// `npm run test:hand` で実行する。MediaPipe 本体は実機でしか動かせないので、
// 「正解の 3D 位置から作った入力を与えたら元の位置が復元されるか」を Node で検証する。
// テストフレームワークは使わない（依存追加はスタック変更なので相談が要る）。
// Node 22.18+ は .ts を型消去してそのまま import できる（tsconfig の erasableSyntaxOnly と対応）
//
// 検証しているもの / していないもの:
//   - 検証済み: imageToRay が背景の cover 切り抜き（repeat/offset）の逆変換になっていること、
//     最小二乗ソルバが「合成した入力から並進を厳密に復元する」こと、指差し判定、合成の手の台本
//   - 未検証（仮定）: MediaPipe の worldLandmarks の規約（y 下向き・z はカメラから遠いほど大きい・
//     軸が画像に揃っている）。生成側（fake-hands.ts）とソルバ（hand-math.ts）に同じ仮定を
//     置いているので、仮定が違っていてもここは通る。実機で「手の上下・奥行きの向き」を確認すること
import {
  HAND_CONNECTIONS,
  INDEX_TIP,
  LANDMARK_COUNT,
  MIN_DEPTH_M,
  fingerCurled,
  fingerExtended,
  imageToRay,
  isPointingPose,
  placeLandmarks,
  solveHandPlacement,
} from "../src/shared/hand-math.ts";
import {
  centered,
  fakeHandResult,
  projectToImage,
  scriptedHand,
  syntheticHandShape,
} from "../src/shared/fake-hands.ts";

const results = [];
function check(name, cond, detail = "") {
  results.push([name, cond]);
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${detail ? ` (${detail})` : ""}`);
}
const near = (a, b, eps) => Math.abs(a - b) <= eps;

// ---- 合成データ: 形状の生成と投影は demos/05 の fake-hands.ts と共有する ----
// （?fakehands=1 でブラウザに入れる合成の手と同じ式をここで検証する）
const openHand = () => syntheticHandShape("open");
const pointingHand = () => syntheticHandShape("point");
const fist = () => syntheticHandShape("fist");

// 形状（y 上）→ worldLandmarks（y 下・重心原点）。fakeHandResult と同じ変換
const toWorld = (shape) => centered(shape).map((p) => ({ x: p.x, y: -p.y, z: p.z }));

// カメラ座標（x 右・y 上・深度 d）→ 画像の正規化座標（y 下向き）
function project(x, y, d, m) {
  return { ...projectToImage({ x, y, z: -d }, m), z: 0 };
}

const mapping = {
  tanHalfFov: Math.tan((70 / 2) * (Math.PI / 180)),
  eyeAspect: 0.8, // 片目が縦長になる 16:10 の横持ちを想定
  repeatX: 0.45, // 16:9 の映像を 0.8 の片目に cover
  repeatY: 1,
};

// ---- imageToRay ----
{
  const c = imageToRay(0.5, 0.5, mapping);
  check("画像中心は正面（0,0）", near(c.x, 0, 1e-12) && near(c.y, 0, 1e-12));
  const top = imageToRay(0.5, 0, mapping);
  check("画像の上端は上向き（y > 0）", top.y > 0 && near(top.x, 0, 1e-12));
  const right = imageToRay(1, 0.5, mapping);
  check("画像の右端は右向き（x > 0）", right.x > 0);
  // cover で横が切れている（repeatX < 1）ので、見えている範囲の端は画像の端より内側
  const edge = imageToRay(0.5 + mapping.repeatX / 2, 0.5, mapping);
  check(
    "ビューポート右端 = tan(半FOV)*aspect",
    near(edge.x, mapping.tanHalfFov * mapping.eyeAspect, 1e-12),
  );
}

// ---- solveHandPlacement: ノイズなしなら厳密に復元 ----
{
  const world = toWorld(openHand());
  const truth = { x: 0.05, y: -0.12, depth: 0.45 };
  const landmarks = world.map((w) =>
    project(truth.x + w.x, truth.y - w.y, truth.depth + w.z, mapping),
  );
  const p = solveHandPlacement(landmarks, world, mapping);
  check("並進を復元（深度）", p && near(p.depth, truth.depth, 1e-6), p && `depth=${p.depth}`);
  check("並進を復元（x, y）", p && near(p.x, truth.x, 1e-6) && near(p.y, truth.y, 1e-6));
  check("残差がほぼ 0", p && p.residual < 1e-9, p && `residual=${p.residual}`);

  // 置き直した 21 点が元の 3D 位置（three 座標: z = -深度）と一致する
  const placed = placeLandmarks(landmarks, world, p, mapping);
  const maxErr = Math.max(
    ...placed.map((q, i) =>
      Math.hypot(
        q.x - (truth.x + world[i].x),
        q.y - (truth.y - world[i].y),
        q.z - -(truth.depth + world[i].z),
      ),
    ),
  );
  check("placeLandmarks が元の 3D 位置を再現", maxErr < 1e-6, `maxErr=${maxErr}`);
  check("HAND_CONNECTIONS は 21 本で index が範囲内", HAND_CONNECTIONS.length === 21 && HAND_CONNECTIONS.every(([a, b]) => a >= 0 && a < LANDMARK_COUNT && b >= 0 && b < LANDMARK_COUNT));
}

// ---- 遠い手・近い手・画面端でも復元できる ----
for (const truth of [
  { x: -0.2, y: 0.05, depth: 0.25 },
  { x: 0.3, y: -0.25, depth: 0.9 },
  { x: 0, y: 0, depth: 2.0 },
]) {
  const world = toWorld(pointingHand());
  const landmarks = world.map((w) =>
    project(truth.x + w.x, truth.y - w.y, truth.depth + w.z, mapping),
  );
  const p = solveHandPlacement(landmarks, world, mapping);
  check(
    `深度 ${truth.depth}m・位置 (${truth.x}, ${truth.y}) を復元`,
    p && near(p.depth, truth.depth, 1e-6) && near(p.x, truth.x, 1e-6) && near(p.y, truth.y, 1e-6),
    p && `depth=${p.depth.toFixed(4)}`,
  );
}

// ---- ランドマークの観測ノイズに対する頑健さ（画像上 ±0.3% 程度のブレ） ----
{
  const world = toWorld(openHand());
  const truth = { x: 0.05, y: -0.12, depth: 0.45 };
  // 再現性のため固定シードの疑似乱数
  let seed = 12345;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  const landmarks = world.map((w) => {
    const q = project(truth.x + w.x, truth.y - w.y, truth.depth + w.z, mapping);
    return { x: q.x + rand() * 0.003, y: q.y + rand() * 0.003, z: 0 };
  });
  const p = solveHandPlacement(landmarks, world, mapping);
  check(
    "ノイズ入りでも深度誤差 5% 以内",
    p && Math.abs(p.depth - truth.depth) / truth.depth < 0.05,
    p && `depth=${p.depth.toFixed(4)} (truth ${truth.depth})`,
  );
  check("ノイズ入りでは残差が 0 より大きい（残差が機能している）", p && p.residual > 1e-6);
}

// ---- 退化入力 ----
{
  const world = toWorld(openHand());
  const same = world.map(() => ({ x: 0.5, y: 0.5, z: 0 }));
  const p = solveHandPlacement(same, world, mapping);
  // 全点が同じ画像位置 = 手の大きさが 0 に見える → 正規方程式が特異になり null
  check("全点同一位置（画像中心）は null", p === null, p && `depth=${p.depth}`);
  check("点が足りなければ null", solveHandPlacement([], [], mapping) === null);
  for (const [u, v] of [[0.3, 0.7], [0.9, 0.1], [0.51, 0.49]]) {
    const off = world.map(() => ({ x: u, y: v, z: 0 }));
    check(`全点同一位置 (${u}, ${v}) も null`, solveHandPlacement(off, world, mapping) === null);
  }
  // 手の一部がカメラより手前（深度 0 以下）になる入力: 残差計算で弾かれて null
  // （手の厚み ≈ 1.3cm より浅い 5mm に置くと、いくつかの点の深度が負になる）
  {
    const near = world.map((w) => project(0.02 + w.x, -0.01 - w.y, 0.005 + w.z, mapping));
    const pn = solveHandPlacement(near, world, mapping);
    check("一部がカメラより手前に来る手は null", pn === null, pn && `depth=${pn.depth}`);
  }
  // 手のサイズを 0 にする（worldLandmarks が全部原点）: 形が無いので解けない
  const zero = world.map(() => ({ x: 0, y: 0, z: 0 }));
  const landmarks = world.map((w) => project(0.05 + w.x, -0.12 - w.y, 0.45 + w.z, mapping));
  const pz = solveHandPlacement(landmarks, zero, mapping);
  check("実寸が 0 の手は null（深度 0 に解けてしまうので弾く）", pz === null, pz && `depth=${pz.depth}`);
}

// ---- 指差し判定 ----
{
  check("指差しポーズを検出", isPointingPose(toWorld(pointingHand())));
  check("開いた手は指差しではない", !isPointingPose(toWorld(openHand())));
  check("握り拳は指差しではない", !isPointingPose(toWorld(fist())));
  check("点が足りなければ false", !isPointingPose([]));
  // 人差し指の先端だけ曲げた手（= 指差しの条件が崩れる）
  const bent = toWorld(pointingHand());
  bent[INDEX_TIP] = { ...bent[INDEX_TIP - 2] };
  check("人差し指が曲がっていれば指差しではない", !isPointingPose(bent));
}


// ---- fake-hands.ts: 投影の往復と、合成結果からの復元 ----
{
  const r = imageToRay(0.3, 0.7, mapping);
  const back = projectToImage({ x: r.x * 0.5, y: r.y * 0.5, z: -0.5 }, mapping);
  check("projectToImage は imageToRay の逆", near(back.x, 0.3, 1e-12) && near(back.y, 0.7, 1e-12));
  check("カメラより手前の点は投影できない（null）", projectToImage({ x: 0, y: 0, z: 0.1 }, mapping) === null);

  const center = { x: -0.1, y: 0.05, z: -0.4 };
  const fake = fakeHandResult(syntheticHandShape("open"), center, mapping, "Left");
  check("fakeHandResult は 21 点 × 1 手", fake.landmarks[0].length === 21 && fake.worldLandmarks[0].length === 21);
  check("worldLandmarks の重心は原点", (() => { const w = fake.worldLandmarks[0]; const c = w.reduce((a, p) => a + p.x + p.y + p.z, 0); return Math.abs(c) < 1e-9; })());
  const p = solveHandPlacement(fake.landmarks[0], fake.worldLandmarks[0], mapping);
  check(
    "合成結果から手の中心を復元（x, y, depth）",
    p && near(p.x, center.x, 1e-6) && near(p.y, center.y, 1e-6) && near(p.depth, -center.z, 1e-6),
    p && `(${p.x.toFixed(3)}, ${p.y.toFixed(3)}, ${p.depth.toFixed(3)})`,
  );
  // 開いた手は画像の上方向に指が向く（指先 y < 手首 y、画像系は下向き）
  check("合成の手は指が画像の上を向く", fake.landmarks[0][INDEX_TIP].y < fake.landmarks[0][0].y);
}

// ---- scriptedHand の台本: 各場面で狙った位置に指先が来る ----
{
  const sceneCam = {
    ballCam: { x: 0, y: -0.15, z: -0.45 },
    buttonCam: { x: 0, y: -0.3, z: -0.4 },
    targetCam: { x: 0, y: 0.6, z: -2.2 },
  };
  const tipAt = (t) => {
    const r = scriptedHand(t, sceneCam, mapping);
    if (!r) return null;
    const p = solveHandPlacement(r.landmarks[0], r.worldLandmarks[0], mapping);
    if (!p) return null;
    return placeLandmarks(r.landmarks[0], r.worldLandmarks[0], p, mapping);
  };
  const tipOrNaN = (t, i) => tipAt(t)?.[i] ?? { x: NaN, y: NaN, z: NaN };
  // 場面1（1.5 秒 = 掃引の中央）: 手の中心がボールの位置
  {
    const r = scriptedHand(1.5, sceneCam, mapping);
    const p = solveHandPlacement(r.landmarks[0], r.worldLandmarks[0], mapping);
    check("場面1: 手の中心がボール位置を通る", p && near(p.x, 0, 1e-6) && near(p.y, -0.15, 1e-6) && near(p.depth, 0.45, 1e-6));
  }
  // 場面2（4.5 秒 = 奥行き掃引の中央）: 人差し指の先がボタン位置
  {
    const tip = tipOrNaN(4.5, INDEX_TIP);
    check("場面2: 人差し指の先がボタン位置を通る", near(tip.x, 0, 1e-6) && near(tip.y, -0.3, 1e-6) && near(tip.z, -0.4, 1e-6), `tip=(${tip.x.toFixed(3)}, ${tip.y.toFixed(3)}, ${tip.z.toFixed(3)})`);
  }
  // 場面3（8 秒）: 指差しポーズで、指先が「原点 → 的」の線上
  {
    const r = scriptedHand(8, sceneCam, mapping);
    check("場面3: 指差しポーズ", isPointingPose(r.worldLandmarks[0]));
    const tip = tipOrNaN(8, INDEX_TIP);
    const s = tip.z / sceneCam.targetCam.z;
    check("場面3: 指先が視点と的を結ぶ線上", near(tip.x, sceneCam.targetCam.x * s, 1e-6) && near(tip.y, sceneCam.targetCam.y * s, 1e-6));
  }
  check("場面4: 手なし（null）", scriptedHand(11, sceneCam, mapping) === null);
  check("12 秒で周期が戻る", scriptedHand(12.5, sceneCam, mapping) !== null);
}


// ---- repeatY < 1（映像が片目より縦長 / camZoom < 1）のマッピングでも往復できる ----
{
  const m2 = { tanHalfFov: Math.tan((60 / 2) * (Math.PI / 180)), eyeAspect: 1.2, repeatX: 0.8, repeatY: 0.7 };
  const r = imageToRay(0.2, 0.35, m2);
  const back = projectToImage({ x: r.x * 0.8, y: r.y * 0.8, z: -0.8 }, m2);
  check("repeatY<1 でも projectToImage∘imageToRay = id", near(back.x, 0.2, 1e-12) && near(back.y, 0.35, 1e-12));
  const edgeTop = imageToRay(0.5, 0.5 - m2.repeatY / 2, m2);
  check("repeatY<1: 見えている上端 = tan(半FOV)", near(edgeTop.y, m2.tanHalfFov, 1e-12) && near(edgeTop.x, 0, 1e-12));
  const world = toWorld(openHand());
  const truth = { x: -0.08, y: 0.06, depth: 0.55 };
  const landmarks = world.map((w) => project(truth.x + w.x, truth.y - w.y, truth.depth + w.z, m2));
  const p = solveHandPlacement(landmarks, world, m2);
  check("repeatY<1 でも並進を復元", p && near(p.x, truth.x, 1e-6) && near(p.y, truth.y, 1e-6) && near(p.depth, truth.depth, 1e-6));
}

// ---- worldLandmarks 側のノイズ（実機で支配的: 形の実寸が ±3mm ぶれる） ----
{
  const world = toWorld(openHand());
  const truth = { x: 0.05, y: -0.12, depth: 0.45 };
  const landmarks = world.map((w) => project(truth.x + w.x, truth.y - w.y, truth.depth + w.z, mapping));
  let seed = 777;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  const noisy = world.map((w) => ({ x: w.x + rand() * 0.003, y: w.y + rand() * 0.003, z: w.z + rand() * 0.003 }));
  const p = solveHandPlacement(landmarks, noisy, mapping);
  check("world ±3mm のノイズでも深度誤差 5% 以内", p && Math.abs(p.depth - truth.depth) / truth.depth < 0.05, p && `depth=${p.depth.toFixed(4)}`);
}

// ---- 指の伸び/曲げの中間帯は「伸びている」でも「曲がっている」でもない ----
{
  const world = toWorld(openHand());
  // 人差し指の先を PIP より 1cm だけ遠い位置に（閾値 0.5cm〜1.5cm の間）
  const wrist = world[0];
  const pip = world[INDEX_TIP - 2];
  const dir = { x: pip.x - wrist.x, y: pip.y - wrist.y, z: pip.z - wrist.z };
  const len = Math.hypot(dir.x, dir.y, dir.z);
  const mid = world.map((w) => ({ ...w }));
  mid[INDEX_TIP] = { x: wrist.x + (dir.x / len) * (len + 0.01), y: wrist.y + (dir.y / len) * (len + 0.01), z: wrist.z + (dir.z / len) * (len + 0.01) };
  check("中間帯: extended でも curled でもない", !fingerExtended(mid, INDEX_TIP - 2, INDEX_TIP) && !fingerCurled(mid, INDEX_TIP - 2, INDEX_TIP));
  check("中間帯の人差し指では指差しにならない", !isPointingPose(mid));
}

// ---- 生成関数に依存しない性質: 同じ見え方で実寸を s 倍すると深度も s 倍になる ----
// 「手の実寸で深度を決める」の核心。入力（画像座標）は固定し、worldLandmarks だけ拡大する
{
  const world = toWorld(openHand());
  const landmarks = world.map((w) => project(0.05 + w.x, -0.12 - w.y, 0.45 + w.z, mapping));
  const base = solveHandPlacement(landmarks, world, mapping);
  for (const s of [0.5, 2, 3]) {
    const scaled = world.map((w) => ({ x: w.x * s, y: w.y * s, z: w.z * s }));
    const p = solveHandPlacement(landmarks, scaled, mapping);
    check(`実寸 ×${s} → 深度 ×${s}`, base && p && near(p.depth, base.depth * s, 1e-6) && near(p.x, base.x * s, 1e-6) && near(p.y, base.y * s, 1e-6), p && `depth=${p.depth.toFixed(4)}`);
  }
}

// ---- placeLandmarks の最小深度クランプ ----
{
  const world = toWorld(openHand());
  const deep = world.map((w) => ({ ...w, z: w.z - 0.2 })); // 全点を 20cm 手前に
  const landmarks = world.map((w) => project(0 + w.x, 0 - w.y, 0.3 + w.z, mapping));
  const pts = placeLandmarks(landmarks, deep, { x: 0, y: 0, depth: 0.1, residual: 0 }, mapping);
  check("手前に出過ぎた点は MIN_DEPTH_M でクランプ", pts.every((q) => -q.z >= MIN_DEPTH_M - 1e-12));
}

const failed = results.filter(([, ok]) => !ok);
console.log(failed.length ? `\n${failed.length} FAILED` : "\nALL PASS");
process.exit(failed.length ? 1 : 0);
