// 08-5（demos/08-5-splatoon-apriltag。候補 1c AprilTag）の純粋な数学の回帰テスト。`npm run test:splatoon-apriltag` で実行する。
//   1. tag36h11.ts — 絵柄が公式の画像（AprilRobotics/apriltag-imgs の tag36h11/tag36_11_0000N.png を 10×10 のセルに読んだもの）と一致する
//   2. apriltag-pose.ts — AprilTag の R, t（カメラ X 右・Y 下・Z 前 / タグ X 右・Y 下・Z 奥）→ 08 の Matrix4（three.js カメラ / マーカー Y 上・+Z 視点側）の
//      往復: 合成の姿勢 → AprilTag の流儀で 4 隅を投影 → 変換した Matrix4 で 4 隅を投影、が角の順序込みで一致する。
//      変換を間違えた（js-aruco2 の F = diag(1,1,-1) を使った）場合は再投影誤差が大きくなることも見る（テストが間違いを検出できる証拠）
// テストフレームワークは使わない（既存の scripts/test-*.mjs と同じ素の assert）。Node 22.18+ は .ts をそのまま import できる
import assert from "node:assert/strict";
import { TAG36H11_COUNT, tag36h11Ascii, tag36h11Bits, tag36h11Svg } from "../demos/08-5-splatoon-apriltag/tag36h11.ts";
import {
  applyMatrix,
  aprilPoseFromMatrix,
  aprilPoseToMatrix,
  focalPxFromFov,
  markerCornersLocal,
  normalizedReprojectionError,
  projectMarkerCorners,
  sidePxOf,
} from "../demos/08-5-splatoon-apriltag/apriltag-pose.ts";

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS: ${name}`);
  } catch (e) {
    console.log(`FAIL: ${name}\n  ${e.message ?? e}`);
    process.exitCode = 1;
  }
}
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ""} ${a} vs ${b} (eps ${eps})`);

// ---- 1. tag36h11 の絵柄 ----
// 公式 PNG（10×10 px。"#" = 黒、"." = 白）。scratchpad で PNG を復号して写した（ID 0 / 1 / 5）
const OFFICIAL = {
  0: ["..........", ".########.", ".#..#.#.#.", ".##...#.#.", ".##..####.", ".#.#.####.", ".##.#..##.", ".####.###.", ".########.", ".........."],
  1: ["..........", ".########.", ".#..#..##.", ".##.#...#.", ".#....###.", ".##..####.", ".#.#..#.#.", ".###.##.#.", ".########.", ".........."],
  5: ["..........", ".########.", ".#....###.", ".#..###.#.", ".#..#..##.", ".#.#.#..#.", ".###...##.", ".#.#..###.", ".########.", ".........."],
};
test("tag36h11: ID 0 / 1 / 5 の絵柄が公式の画像とセル単位で一致する", () => {
  for (const [id, rows] of Object.entries(OFFICIAL)) {
    assert.equal(tag36h11Ascii(Number(id)), rows.join("\n"), `ID ${id}`);
  }
});
test("tag36h11: 表は 0〜249（08 の MAX_MARKER_ID と同じ範囲）で、範囲外は例外", () => {
  assert.equal(TAG36H11_COUNT, 250);
  assert.equal(tag36h11Bits(249).length, 6);
  assert.throws(() => tag36h11Bits(250));
});
test("tag36h11: 隣り合う ID の絵柄は違う（符号表の写し間違いの検出。全 250 個が互いに異なる）", () => {
  const seen = new Set();
  for (let id = 0; id < TAG36H11_COUNT; id++) {
    const key = tag36h11Ascii(id);
    assert.ok(!seen.has(key), `ID ${id} の絵柄が重複`);
    seen.add(key);
  }
});
test("tag36h11: SVG は 10×10 の viewBox、白地 + 8×8 の黒 + 白いビットの rect（08 の markerSvg と同じ描き方）", () => {
  const svg = tag36h11Svg(0);
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"'));
  assert.ok(svg.includes('<rect x="1" y="1" width="8" height="8" fill="black"/>'));
  const whiteCells = (svg.match(/width="1" height="1" fill="white"/g) ?? []).length;
  const bits = tag36h11Bits(0).flat().filter(Boolean).length;
  assert.equal(whiteCells, bits);
  // ID 0 の 1 行目（ビットの行 0）は公式の "#..#.#.#" → 白は x=2,4,6,8 の 4 つ… の内側 6 セル ".#.#.#" → 白 3 つ
  assert.ok(svg.includes('<rect x="3" y="2" width="1" height="1" fill="white"/>'));
});

// ---- 2. AprilTag の姿勢 → Matrix4 ----
/** 軸まわりの回転（列優先 4×4）。three.js の Matrix4.makeRotationAxis と同じ */
function rotation(axis, angle) {
  const [x, y, z] = axis;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1 - c;
  return [t * x * x + c, t * x * y + s * z, t * x * z - s * y, 0, t * x * y - s * z, t * y * y + c, t * y * z + s * x, 0, t * x * z + s * y, t * y * z - s * x, t * z * z + c, 0, 0, 0, 0, 1];
}
/** AprilTag の流儀で 4 隅を投影する: 物体点 (-s/2, s/2), (s/2, s/2), (s/2, -s/2), (-s/2, -s/2)（apriltag_pose.c）、p_Ca = R p + t、px = cx + fx X/Z、py = cy + fy Y/Z */
function projectAprilCorners(Rcols, t, size, f, cx, cy) {
  const h = size / 2;
  const pts = [[-h, h, 0], [h, h, 0], [h, -h, 0], [-h, -h, 0]];
  return pts.map((p) => {
    const X = Rcols[0][0] * p[0] + Rcols[1][0] * p[1] + Rcols[2][0] * p[2] + t[0];
    const Y = Rcols[0][1] * p[0] + Rcols[1][1] * p[1] + Rcols[2][1] * p[2] + t[1];
    const Z = Rcols[0][2] * p[0] + Rcols[1][2] * p[1] + Rcols[2][2] * p[2] + t[2];
    return { x: cx + (f * X) / Z, y: cy + (f * Y) / Z };
  });
}
const F_PX = focalPxFromFov(640, 68);
const CX = 320;
const CY = 240;
const SIZE = 0.1;

test("正面のタグ（R = I、t = (0,0,d)）は three.js カメラの -Z 方向 d にあり、マーカーの +Z 軸が視点側を向く", () => {
  const m = aprilPoseToMatrix([[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, 1.5]);
  assert.deepEqual(m.slice(12, 15), [0, -0, -1.5]);
  near(m[0], 1, 1e-12);
  near(m[5], 1, 1e-12, "Y 軸は上のまま");
  near(m[10], 1, 1e-12, "+Z は視点側");
  // 4 隅: AprilTag の corners[0] = 左下 → 画像では中心より左・下（y が大きい）
  const proj = projectMarkerCorners(m, SIZE, F_PX, CX, CY);
  assert.ok(proj[0][0] < CX && proj[0][1] > CY, "corners[0] は左下");
  assert.ok(proj[2][0] > CX && proj[2][1] < CY, "corners[2] は右上");
});

test("上端を視点側へ θ 傾けたタグ: 手で導いた AprilTag の R から、マーカーの Y 軸が (0, cosθ, sinθ) になる", () => {
  const th = (25 * Math.PI) / 180;
  // タグ座標系（Y 下・Z 奥）の各軸をカメラ座標系（Y 下・Z 前）で: X = (1,0,0)、Y = (0, cosθ, sinθ)、Z = (0, -sinθ, cosθ)。JSON は列優先
  const Rcols = [[1, 0, 0], [0, Math.cos(th), Math.sin(th)], [0, -Math.sin(th), Math.cos(th)]];
  const m = aprilPoseToMatrix(Rcols, [0, 0, 1]);
  near(m[4], 0, 1e-12);
  near(m[5], Math.cos(th), 1e-12, "Y 軸の Y");
  near(m[6], Math.sin(th), 1e-12, "Y 軸の Z（上端が視点側 = +Z）");
  // 上の隅は下の隅より視点に近い（Z が大きい）
  const [, , tr, tl] = markerCornersLocal(SIZE).map((c) => applyMatrix(m, c));
  const [bl] = markerCornersLocal(SIZE).map((c) => applyMatrix(m, c));
  assert.ok(tl[2] > bl[2] && tr[2] > bl[2]);
});

test("往復: 合成の姿勢 → AprilTag の R,t → Matrix4 が元に戻り、AprilTag の流儀で投影した 4 隅と角の順序込みで一致する（100 通り）", () => {
  let seed = 12345;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let k = 0; k < 100; k++) {
    // マーカーの姿勢（three.js カメラ座標系）: ランダムな軸まわりの回転（±70° まで。正面向きから大きく外れない）+ カメラの前方の位置
    const axis = [rand() - 0.5, rand() - 0.5, rand() - 0.5];
    const len = Math.hypot(...axis);
    const m = rotation(axis.map((v) => v / len), (rand() - 0.5) * ((140 * Math.PI) / 180));
    m[12] = (rand() - 0.5) * 1.0;
    m[13] = (rand() - 0.5) * 0.8;
    m[14] = -(0.5 + rand() * 2.5);
    const { R, t } = aprilPoseFromMatrix(m);
    const back = aprilPoseToMatrix(R, t);
    for (let i = 0; i < 16; i++) near(back[i], m[i], 1e-12, `elements[${i}]`);
    // R は回転行列のまま（直交・行列式 +1）
    const det = R[0][0] * (R[1][1] * R[2][2] - R[2][1] * R[1][2]) - R[1][0] * (R[0][1] * R[2][2] - R[2][1] * R[0][2]) + R[2][0] * (R[0][1] * R[1][2] - R[1][1] * R[0][2]);
    near(det, 1, 1e-9, "det R");
    // t の Z は AprilTag の流儀で正（カメラの前）
    assert.ok(t[2] > 0);
    const ours = projectMarkerCorners(m, SIZE, F_PX, CX, CY);
    const theirs = projectAprilCorners(R, t, SIZE, F_PX, CX, CY);
    assert.ok(ours, "投影できる");
    for (let i = 0; i < 4; i++) {
      near(ours[i][0], theirs[i].x, 1e-9, `corner ${i} x`);
      near(ours[i][1], theirs[i].y, 1e-9, `corner ${i} y`);
    }
    // 検出した 4 隅（= AprilTag の投影）に対する正規化再投影誤差は 0
    near(normalizedReprojectionError(m, theirs, SIZE, F_PX, CX, CY), 0, 1e-9, "reprojection");
    assert.ok(sidePxOf(theirs) > 5);
  }
});

test("変換を間違えると再投影誤差が大きい（js-aruco2 の F = diag(1,1,-1) で挟んだ場合。テストが取り違えを検出できる）", () => {
  const th = (30 * Math.PI) / 180;
  const Rcols = [[1, 0, 0], [0, Math.cos(th), Math.sin(th)], [0, -Math.sin(th), Math.cos(th)]];
  const t = [0.2, 0.1, 1.0];
  const corners = projectAprilCorners(Rcols, t, SIZE, F_PX, CX, CY);
  const right = normalizedReprojectionError(aprilPoseToMatrix(Rcols, t), corners, SIZE, F_PX, CX, CY);
  // 間違い: 08 の marker-detector.ts と同じ F = diag(1,1,-1)（Y を反転しない）
  const R = (i, j) => Rcols[j][i];
  const wrong = [R(0, 0), R(1, 0), -R(2, 0), 0, R(0, 1), R(1, 1), -R(2, 1), 0, -R(0, 2), -R(1, 2), R(2, 2), 0, t[0], t[1], -t[2], 1];
  const wrongErr = normalizedReprojectionError(wrong, corners, SIZE, F_PX, CX, CY);
  near(right, 0, 1e-9);
  assert.ok(wrongErr > 0.5, `wrong=${wrongErr}`);
});

test("焦点距離の換算は 08 の marker-anchor.ts と同じ（640px・68° → 474.4px）", () => {
  near(focalPxFromFov(640, 68), 640 / 2 / Math.tan((68 * Math.PI) / 360), 1e-9);
});

console.log(process.exitCode ? `\n${passed} passed, some FAILED` : `\nALL PASS (${passed})`);
