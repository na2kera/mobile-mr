// 08-5（demos/08-5-splatoon-apriltag。候補 1c AprilTag）の純粋な数学の回帰テスト。`npm run test:splatoon-apriltag` で実行する。
//   1. tag36h11.ts — 絵柄が公式の画像（AprilRobotics/apriltag-imgs の tag36h11/tag36_11_0000N.png を 10×10 のセルに読んだもの）と一致する
//   2. apriltag-pose.ts — AprilTag の R, t（カメラ X 右・Y 下・Z 前 / タグ X 右・Y 下・Z 奥）→ 08 の Matrix4（three.js カメラ / マーカー Y 上・+Z 視点側）の
//      往復: 合成の姿勢 → AprilTag の流儀で 4 隅を投影 → 変換した Matrix4 で 4 隅を投影、が角の順序込みで一致する。
//      変換を間違えた（js-aruco2 の F = diag(1,1,-1) を使った）場合は再投影誤差が大きくなることも見る（テストが間違いを検出できる証拠）
//   3. tag36h11.ts の符号表 250 件すべてが upstream の tag36h11.c（npm run fetch:apriltag が public/vendor/apriltag/ に置く。
//      apriltag-js-standalone のサブモジュールが指すコミットのもの）と一致する。C の codes[] / bit_x[] / bit_y[] を正規表現で読み、
//      tag36h11Bits の 6×6 から 36 bit 符号を組み直して突き合わせる（bit の座標も同時に検証）。ファイルが無ければ SKIP
//   4. marker-anchor-apriltag.ts — 検出器が例外（WASM の RuntimeError / RangeError）を投げても update() が例外を外に出さず、
//      そのフレームはロスト扱い・info に error・ログは間引き・連続 N 回で fallbackDetector に切り替わる
// テストフレームワークは使わない（既存の scripts/test-*.mjs と同じ素の assert）。Node 22.18+ は .ts をそのまま import できる
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { register } from "node:module";
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
async function testAsync(name, fn) {
  try {
    await fn();
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

// ---- 3. 符号表 250 件を upstream の tag36h11.c と照合 ----
const UPSTREAM_C = new URL("../public/vendor/apriltag/tag36h11.c", import.meta.url);
if (!existsSync(UPSTREAM_C)) {
  console.log("SKIP: tag36h11: 符号表 250 件と upstream の tag36h11.c の照合（public/vendor/apriltag/tag36h11.c が無い。npm run fetch:apriltag で取得）");
} else {
  test("tag36h11: 符号表 0〜249 の全件と bit の座標が upstream の tag36h11.c（サブモジュールの固定コミット）と一致する", () => {
    const c = readFileSync(UPSTREAM_C, "utf8");
    const codes = new Map();
    for (const m of c.matchAll(/tf->codes\[(\d+)\]\s*=\s*0x([0-9a-fA-F]+)UL\s*;/g)) codes.set(Number(m[1]), BigInt(`0x${m[2]}`));
    const readBits = (name) => {
      const arr = [];
      for (const m of c.matchAll(new RegExp(`tf->${name}\\[(\\d+)\\]\\s*=\\s*(\\d+)\\s*;`, "g"))) arr[Number(m[1])] = Number(m[2]);
      return arr;
    };
    const bitX = readBits("bit_x");
    const bitY = readBits("bit_y");
    assert.equal(Number(c.match(/tf->ncodes\s*=\s*(\d+)/)?.[1]), 587, "ncodes");
    assert.equal(codes.size, 587, "codes[] を全部読めた");
    assert.equal(Number(c.match(/tf->nbits\s*=\s*(\d+)/)?.[1]), 36, "nbits");
    assert.equal(bitX.filter(Number.isFinite).length, 36, "bit_x を全部読めた");
    assert.equal(bitY.filter(Number.isFinite).length, 36, "bit_y を全部読めた");
    // bit_x / bit_y は黒枠の左上を (0,0) とするセル座標で中身は 1〜6（tag36h11.ts のコメントと同じ）なので -1 して 6×6 の添字にする
    let checked = 0;
    for (let id = 0; id < TAG36H11_COUNT; id++) {
      const bits = tag36h11Bits(id);
      let code = 0n;
      for (let i = 0; i < 36; i++) code = (code << 1n) | (bits[bitY[i] - 1][bitX[i] - 1] ? 1n : 0n);
      assert.equal(code, codes.get(id), `ID ${id}: ours 0x${code.toString(16)} vs upstream 0x${codes.get(id)?.toString(16)}`);
      checked++;
    }
    assert.equal(checked, 250);
  });
}

// ---- 4. 検出器の例外でアンカーの update が止まらない ----
// marker-anchor-apriltag.ts は src/shared を拡張子なしで import する（Vite の流儀）。Node の型除去はそれを解決しないので、
// 解決に失敗したら .ts を足して再試行するフックを入れる（追加依存なし）
register(
  "data:text/javascript," +
    encodeURIComponent(`export async function resolve(specifier, context, next) {
  try { return await next(specifier, context); }
  catch (e) {
    if ((specifier.startsWith(".") || specifier.startsWith("/")) && !/\\.[cm]?[jt]s$/.test(specifier)) return next(specifier + ".ts", context);
    throw e;
  }
}`),
);
// DOM の最小限のスタブ（検出用 canvas と readyState の定数だけ使う）
globalThis.HTMLMediaElement ??= { HAVE_CURRENT_DATA: 2 };
globalThis.document ??= {
  createElement: () => ({
    width: 0,
    height: 0,
    getContext: () => ({ drawImage() {}, getImageData: (_x, _y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }) }),
  }),
};
const THREE = await import("three");
const { createDetectorAnchor } = await import("../demos/08-5-splatoon-apriltag/marker-anchor-apriltag.ts");

function makeAnchor(detector, extra = {}) {
  const video = { readyState: 4, currentTime: 0, videoWidth: 640, videoHeight: 480 };
  const a = createDetectorAnchor({
    detector,
    video,
    camera: new THREE.PerspectiveCamera(60, 4 / 3, 0.01, 100),
    anchor: new THREE.Object3D(),
    markerId: 0,
    maxPoseError: 0.3,
    detW: 640,
    smooth: 0.5,
    minIntervalMs: 0,
    camHFovDeg: () => 68,
    resnapAfterMs: 2000,
    snapDistanceM: 0.3,
    ...extra,
  });
  let now = 1000;
  /** 1 フレーム進めて update（動画の時刻も進める） */
  const step = (dtMs = 33) => {
    now += dtMs;
    video.currentTime += dtMs / 1000;
    a.update(now);
    return now;
  };
  return { a, step, now: () => now };
}
/** 正面 1m の原点マーカーの観測 */
const goodObservation = () => [
  { id: 0, corners: [{ x: 300, y: 260 }, { x: 340, y: 260 }, { x: 340, y: 220 }, { x: 300, y: 220 }], matrix: new THREE.Matrix4().makeTranslation(0, 0, -1), error: 0.01, sidePx: 40 },
];
/** console.warn を数えながら黙らせる */
async function withWarns(fn) {
  const orig = console.warn;
  const warns = [];
  console.warn = (...args) => warns.push(args.join(" "));
  try {
    await fn(warns);
  } finally {
    console.warn = orig;
  }
}

await testAsync("検出器が WebAssembly.RuntimeError / RangeError を投げても update() は例外を外に出さず、そのフレームはロスト扱いで info に error が出る", () =>
  withWarns((warns) => {
    let mode = "ok";
    const detector = {
      detect() {
        if (mode === "wasm") throw new WebAssembly.RuntimeError("memory access out of bounds");
        if (mode === "range") throw new RangeError("offset is out of bounds");
        return goodObservation();
      },
    };
    const { a, step } = makeAnchor(detector);
    const t0 = step();
    assert.ok(a.everDetected && a.isTracking(t0, 500), `最初は検出できる: ${a.info}`);
    const acceptedAt = a.lastAcceptedMs;
    mode = "wasm";
    for (let i = 0; i < 20; i++) assert.doesNotThrow(() => step(), `RuntimeError のフレーム ${i}`);
    assert.equal(a.lastAcceptedMs, acceptedAt, "例外のフレームは受理されない");
    assert.ok(!a.isTracking(step(), 500), "ロスト扱い");
    assert.match(a.info, /^lost \(.*\) error\(\d+x\)=RuntimeError: memory access out of bounds$/, a.info);
    mode = "range";
    assert.doesNotThrow(() => step());
    assert.match(a.info, /error\(22x\)=RangeError: offset is out of bounds/, a.info);
    assert.equal(a.consecutiveFailures, 22);
    assert.equal(a.lastObservedCount, 0);
    // 22 フレーム × 33ms ≈ 0.7s の間のログは間引かれて 1 回だけ
    assert.equal(warns.filter((w) => w.includes("detect threw")).length, 1, warns.join("\n"));
    // 成功したら error 表示と連続回数が消え、追跡に戻る
    mode = "ok";
    const t1 = step();
    assert.ok(a.isTracking(t1, 500), a.info);
    assert.equal(a.consecutiveFailures, 0);
    assert.equal(a.lastDetectError, "");
    assert.ok(!a.info.includes("error"), a.info);
  }),
);

await testAsync("一度も検出できないうちに例外が続いても info は searching + error で、表示が積み重ならない", () =>
  withWarns(() => {
    const { a, step } = makeAnchor({
      detect() {
        throw new WebAssembly.RuntimeError("unreachable");
      },
    });
    for (let i = 0; i < 5; i++) assert.doesNotThrow(() => step());
    assert.equal(a.info, "searching error(5x)=RuntimeError: unreachable");
    assert.ok(!a.everDetected);
  }),
);

await testAsync("同じ失敗が連続 maxConsecutiveFailures（30）回で fallbackDetector に切り替わり、onFallback が 1 回呼ばれる。以後は切り替え先で検出する", () =>
  withWarns((warns) => {
    let wasmCalls = 0;
    let fallbackCalls = 0;
    const fallbacks = [];
    const { a, step } = makeAnchor(
      {
        detect() {
          wasmCalls++;
          throw new WebAssembly.RuntimeError("unreachable");
        },
      },
      {
        maxConsecutiveFailures: 30,
        fallbackDetector: () => ({
          detect() {
            fallbackCalls++;
            return goodObservation();
          },
        }),
        onFallback: (msg, failures) => fallbacks.push({ msg, failures }),
      },
    );
    for (let i = 0; i < 29; i++) assert.doesNotThrow(() => step());
    assert.equal(fallbacks.length, 0, "29 回ではまだ切り替えない");
    assert.ok(!a.fellBack);
    assert.doesNotThrow(() => step());
    assert.equal(fallbacks.length, 1);
    assert.deepEqual(fallbacks[0], { msg: "RuntimeError: unreachable", failures: 30 });
    assert.ok(a.fellBack);
    assert.match(a.info, /error\(30x → fallback\)/, a.info);
    assert.ok(warns.some((w) => w.includes("switched to fallback detector")), warns.join("\n"));
    const t = step();
    assert.equal(wasmCalls, 30, "切り替え後は WASM の検出器を呼ばない");
    assert.equal(fallbackCalls, 1);
    assert.ok(a.everDetected && a.isTracking(t, 500), a.info);
    for (let i = 0; i < 40; i++) step();
    assert.equal(fallbacks.length, 1, "onFallback は 1 回だけ");
  }),
);

await testAsync("fallbackDetector が無ければ切り替えずにロスト扱いを続ける（例外は外に出さない）", () =>
  withWarns(() => {
    const { a, step } = makeAnchor({
      detect() {
        throw new RangeError("bad");
      },
    });
    for (let i = 0; i < 60; i++) assert.doesNotThrow(() => step());
    assert.ok(!a.fellBack);
    assert.equal(a.consecutiveFailures, 60);
  }),
);

console.log(process.exitCode ? `\n${passed} passed, some FAILED` : `\nALL PASS (${passed})`);
