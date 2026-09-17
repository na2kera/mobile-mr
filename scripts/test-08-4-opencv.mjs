// 08-4（demos/08-4-splatoon-opencv。OpenCV.js の ArUco board + solvePnP）の回帰テスト。`npm run test:08-4-opencv` で実行する。
//   1. src/shared/pnp-board.ts — board の組み立て・平面判定・rvec/tvec ↔ 4x4 の変換・座標系の向き（three.js ⇔ OpenCV）・再投影誤差。
//      OpenCV 無しの純粋な数学で、合成カメラ（fake-markers.ts）の投影と整合することを確かめる
//   2. OpenCV.js（public/vendor/opencv/opencv.js。`npm run fetch:opencv`）を Node で動かし（Emscripten の Node 対応ビルド）、
//      - 辞書 DICT_ARUCO_MIP_36h12 の ID とビットの向きが js-aruco2 の ARUCO_MIP_36h12 と一致する（印刷したマーカーがそのまま読める）
//      - 合成画像（field 座標系のマーカーをピンホール投影して描く）→ ArucoDetector → solvePnP で元のカメラ姿勢に戻る（平面・非平面・前フレーム初期値）
//      - 誤り訂正の厳しさ（4 ビット反転は読む・5 ビットは読まない = js-aruco2 と同じ）
//      - createOpenCvMarkerAnchor（DOM は最小のスタブ）: 配置の不整合で 1 枚ずつの平均に落ちない・実行時の例外が続くと js-aruco2 に切り替わる
//      - 同じ合成入力を js-aruco2 + POSIT（08）と OpenCV + solvePnP（08-4）の両方に流し、斜め（0 / 30 / 45 / 60°）での原点の位置の
//        ばらつきと誤差を比べる（README の表の元データ。数値はそのまま出力する）
//      opencv.js が無ければ 2 は SKIP（1 だけで pass にはしない: 取得してから流すこと）
// テストフレームワークは使わない（04〜08 と同じ方針）。Node 22.18+ は .ts をそのまま import できる
import { existsSync, readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildBoard,
  cameraMatrix,
  cameraMatrixToCvPose,
  cvPoseToCameraMatrix,
  DEFAULT_MAX_REPROJ_PX,
  focalPxOf,
  isCoplanar,
  markerCorners,
  markerErrorsL1,
  matrixToRodrigues,
  meanSidePx,
  meanV3,
  reprojectionErrorPx,
  reprojLimitPx,
  rodriguesToMatrix,
} from "../src/shared/pnp-board.ts";
import { createArucoDetector, detectMarkers, guessFromCameraMatrix, solveBoardPnP, solveSingleMarker } from "../src/shared/opencv-pose.ts";
import { fakeCameraToField, projectFakeMarkers } from "../src/shared/fake-markers.ts";
import { fusePoseCandidates, invertRigid, levelRotation, markerToFieldMatrix, mulMat4, tiltDegOf, transformPoint } from "../src/shared/marker-layout.ts";

const require = createRequire(import.meta.url);
const { AR } = require("js-aruco2");
const { POS } = require("js-aruco2/src/posit1.js");

const results = [];
function check(name, cond, detail = "") {
  results.push([name, cond]);
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${detail ? ` (${detail})` : ""}`);
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const nearV = (a, b, eps = 1e-6) => a.length === b.length && a.every((v, i) => near(v, b[i], eps));
const identity16 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
/** 2 つの回転（列優先 4x4）の角度差 [deg] */
function rotationDiffDeg(a, b) {
  // trace(Ra^T Rb) = 1 + 2cosθ
  const t =
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2] +
    a[4] * b[4] + a[5] * b[5] + a[6] * b[6] +
    a[8] * b[8] + a[9] * b[9] + a[10] * b[10];
  return (Math.acos(Math.max(-1, Math.min(1, (t - 1) / 2))) * 180) / Math.PI;
}
const posOf = (m) => [m[12], m[13], m[14]];
const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const p90 = (a) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * 0.9))];
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const max = (a) => Math.max(...a);

// 検出側と同じ幾何: フェイクカメラ 640x480、水平 FOV 68°（CAM_FOV_WIDE）、マーカー 150mm
const W = 640;
const H = 480;
const HFOV = 68;
const FOCAL = focalPxOf(W, H, HFOV);
const K = cameraMatrix(FOCAL, W, H);
const MARKER_M = 0.15;
const jsDict = new AR.Dictionary("ARUCO_MIP_36h12");
const bitsOf = (id) => {
  const code = jsDict.codeList[id];
  const rows = [];
  for (let y = 0; y < 6; y++) rows.push([...code.slice(y * 6, y * 6 + 6)].map((c) => c === "1"));
  return rows;
};
const ORIGIN = { id: 0, face: "wall", pos: [0, 0, 0] };
const WALL2 = { id: 5, face: "wall", pos: [0.6, 0, 0] };
const FLOOR = { id: 1, face: "floor", pos: [0, -1.2, 1.0] };
const fakeMarker = (p) => ({ id: p.id, bits: bitsOf(p.id), toField: markerToFieldMatrix(p) });

// ================= 1. pnp-board.ts（OpenCV 無し）=================
{
  const c = markerCorners(0.2);
  check("markerCorners: 左上・右上・右下・左下（X 右・Y 上・Z=0）", nearV(c[0], [-0.1, 0.1, 0]) && nearV(c[1], [0.1, 0.1, 0]) && nearV(c[2], [0.1, -0.1, 0]) && nearV(c[3], [-0.1, -0.1, 0]));
  check("meanSidePx: 正方形 100px の平均辺長は 100", near(meanSidePx([[0, 0], [100, 0], [100, 100], [0, 100]]), 100));
  const floorM = markerToFieldMatrix(FLOOR);
  const layout = (id) => (id === 0 ? identity16 : id === 1 ? floorM : id === 5 ? markerToFieldMatrix(WALL2) : null);
  const det = (id, x0 = 100) => ({ id, corners: [[x0, 100], [x0 + 40, 100], [x0 + 40, 140], [x0, 140]] });
  const board = buildBoard([det(0), det(9), det(1, 300), det(0, 500)], layout, MARKER_M);
  check("buildBoard: 配置の無い ID（9）と重複（2 つ目の 0）は無視し、原点と床の 2 枚 8 点になる", board && board.ids.join("+") === "0+1" && board.objectPoints.length === 24 && board.imagePoints.length === 16, board?.ids.join("+"));
  const h = MARKER_M / 2;
  check("buildBoard: 原点マーカーの 4 隅はアンカー座標系そのまま、床のマーカーの左上は toField で変換した点", nearV(board.objectPoints.slice(0, 3), [-h, h, 0]) && nearV(board.objectPoints.slice(12, 15), transformPoint(floorM, [-h, h, 0])));
  check("buildBoard: 中心はマーカーの原点（床は pos）、辺長は画面上の平均辺長", nearV(board.centersAnchor[1], FLOOR.pos) && near(board.sidesPx[0], 40));
  check("buildBoard: 配置が 1 枚も無ければ null", buildBoard([det(9)], layout, MARKER_M) === null);
  check("isCoplanar: 同じ壁の 2 枚は平面、壁 + 床は非平面", isCoplanar(buildBoard([det(0), det(5, 300)], layout, MARKER_M).objectPoints) && !isCoplanar(board.objectPoints));
  check("isCoplanar: 点が 3 つ以下・一直線でも壊れない", isCoplanar([0, 0, 0, 1, 0, 0, 2, 0, 0]) && isCoplanar([]));
  check("meanV3: 平均", nearV(meanV3([[0, 0, 0], [2, 4, 6]]), [1, 2, 3]));
  // Rodrigues
  const rx = rodriguesToMatrix([Math.PI, 0, 0]);
  check("rodriguesToMatrix: X 軸まわり 180° は diag(1,-1,-1)", nearV(rx, [1, 0, 0, 0, -1, 0, 0, 0, -1], 1e-9));
  check("rodriguesToMatrix: 零ベクトルは単位行列", nearV(rodriguesToMatrix([0, 0, 0]), [1, 0, 0, 0, 1, 0, 0, 0, 1]));
  let roundtripOk = true;
  for (const rv of [[0.3, -0.2, 0.9], [0, 0, 1e-4], [1.2, 1.1, -0.7], [2.5, 0.4, 0.1]]) {
    const back = matrixToRodrigues(rodriguesToMatrix(rv));
    if (!nearV(back, rv, 1e-7)) roundtripOk = false;
  }
  check("matrixToRodrigues: rodriguesToMatrix の逆（往復で戻る）", roundtripOk);
  const r180 = matrixToRodrigues([1, 0, 0, 0, -1, 0, 0, 0, -1]);
  check("matrixToRodrigues: 180° も軸を取れる（X 軸・π）", near(Math.hypot(...r180), Math.PI, 1e-6) && near(Math.abs(r180[0]), Math.PI, 1e-6));
  // 座標系の向き: OpenCV の [R|t] ↔ three.js のカメラ座標系
  const camThree = cvPoseToCameraMatrix([1, 0, 0, 0, -1, 0, 0, 0, -1], [0, 0, 1]);
  check("cvPoseToCameraMatrix: 正対したマーカー（OpenCV: R=diag(1,-1,-1), t=(0,0,1)）は three.js では単位回転で (0,0,-1)（1m 前方）", nearV(camThree, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -1, 1]));
  // 手計算の固定期待値（生成側の関数を使わない。符号の取り違えを往復テストだけでは見逃すため）:
  // three.js でカメラが field の (1,0,0) に居て原点（-X 方向）を向く = Y 軸まわり +90°。
  //   camToField の回転 R_y(90) = [[0,0,1],[0,1,0],[-1,0,0]] → fieldToCam の回転は転置 [[0,0,-1],[0,1,0],[1,0,0]]、t = -Rᵀ(1,0,0) = (0,0,-1)
  //   OpenCV は F=diag(1,-1,-1) を左から: R_cv = [[0,0,-1],[0,-1,0],[-1,0,0]]、t_cv = (0,0,1)
  const yawCv = [0, 0, -1, 0, -1, 0, -1, 0, 0];
  check(
    "cvPoseToCameraMatrix（手計算）: (1,0,0) から原点を向くカメラ（OpenCV R=[[0,0,-1],[0,-1,0],[-1,0,0]], t=(0,0,1)）は three.js の列優先 [0,0,1,0, 0,1,0,0, -1,0,0,0, 0,0,-1,1]",
    nearV(cvPoseToCameraMatrix(yawCv, [0, 0, 1]), [0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, -1, 1]),
  );
  // 同じ姿勢・f=500・640x480 で: field (0,0,0.1) はカメラの左 0.1m・前 1m → u = 320 − 50 = 270、v = 240。
  // field (0,0.1,0) は上 0.1m → 画像の Y は下向きなので v = 240 − 50 = 190
  check(
    "reprojectionErrorPx（手計算）: field (0,0,0.1) → (270,240)、(0,0.1,0) → (320,190) で誤差 0、u を 3px ずらすと平均 1.5px",
    near(reprojectionErrorPx([0, 0, 0.1, 0, 0.1, 0], [270, 240, 320, 190], yawCv, [0, 0, 1], cameraMatrix(500, 640, 480)), 0) &&
      near(reprojectionErrorPx([0, 0, 0.1, 0, 0.1, 0], [273, 240, 320, 190], yawCv, [0, 0, 1], cameraMatrix(500, 640, 480)), 1.5),
  );
  // 08 の POSIT と同じ尺度の正規化誤差: 4 隅の |du|+|dv| の合計 ÷ 辺長。1 隅の u を 3px・v を 1px ずらすと (3+1)/40 = 0.1
  {
    const obj = markerCorners(0.1).flat(); // 1m 前方で f=400 なら 40px 角
    const R0 = [1, 0, 0, 0, -1, 0, 0, 0, -1];
    const img = [300, 220, 340, 220, 340, 260, 300, 260];
    const K0 = cameraMatrix(400, 640, 480);
    const e0 = markerErrorsL1(obj, img, [40], R0, [0, 0, 1], K0);
    const shifted = [...img];
    shifted[0] += 3;
    shifted[1] -= 1;
    const e1 = markerErrorsL1(obj, shifted, [40], R0, [0, 0, 1], K0);
    check("markerErrorsL1（手計算）: 投影どおりなら 0、1 隅を (3, −1)px ずらすと (3+1)/40 = 0.1（08 の POSIT の err= と同じ尺度）", near(e0[0], 0, 1e-9) && near(e1[0], 0.1, 1e-9), `${e0[0]} ${e1[0]}`);
  }
  check("reprojLimitPx: ?maxReprojPx= は検出画像の長辺 960px 基準（既定 4 → 640px では 2.67px、1920px では 8px）", DEFAULT_MAX_REPROJ_PX === 4 && near(reprojLimitPx(4, 640), 8 / 3, 1e-9) && near(reprojLimitPx(4, 1920), 8));
  const back = cameraMatrixToCvPose(camThree);
  check("cameraMatrixToCvPose: cvPoseToCameraMatrix の逆", nearV(back.R, [1, 0, 0, 0, -1, 0, 0, 0, -1]) && nearV(back.t, [0, 0, 1]));
  // 合成カメラ（fake-markers.ts）の投影と整合するか: field → camera(three) = (camToField)⁻¹ の OpenCV 姿勢で board の対応点を再投影すると誤差 0
  const camToField = fakeCameraToField([0.3, 0.1, 1.5], 25, 10);
  const fieldToCam = invertRigid(camToField);
  const projected = projectFakeMarkers([fakeMarker(ORIGIN), fakeMarker(FLOOR)], camToField, FOCAL, W, H, MARKER_M);
  check("合成カメラ: 原点と床の両方が映る", projected.length === 2);
  const detections = projected.map((p) => ({ id: p.id, corners: p.black }));
  const board2 = buildBoard(detections, layout, MARKER_M);
  const { R, t } = cameraMatrixToCvPose(fieldToCam);
  const err0 = reprojectionErrorPx(board2.objectPoints, board2.imagePoints, R, t, K);
  check("座標系の整合: 合成カメラの真の姿勢（three.js の field → camera）を OpenCV の [R|t] に直して再投影すると誤差 ≈ 0px（左上 = 印刷の左上、Y 下の画像座標）", err0 < 1e-6, `err=${err0.toExponential(2)}px`);
  const wrongT = reprojectionErrorPx(board2.objectPoints, board2.imagePoints, R, [t[0], t[1], t[2] + 0.1], K);
  check("再投影誤差: 姿勢がずれれば増える（Z を 10cm ずらすと数 px）", wrongT > 1);
  check("再投影誤差: カメラの後ろに来る姿勢は Infinity", reprojectionErrorPx(board2.objectPoints, board2.imagePoints, R, [t[0], t[1], -5], K) === Infinity);
  check("focalPxOf: 長辺基準（縦持ちでも同じ値）", near(focalPxOf(480, 640, HFOV), FOCAL) && near(cameraMatrix(FOCAL, W, H)[2], 320));
  // guessFromCameraMatrix → rodriguesToMatrix / cvPoseToCameraMatrix で元の 4x4 に戻る
  const g = guessFromCameraMatrix(fieldToCam);
  const rebuilt = cvPoseToCameraMatrix(rodriguesToMatrix(g.rvec), g.tvec);
  check("guessFromCameraMatrix: 4x4 → rvec/tvec → 4x4 で戻る", nearV(rebuilt, fieldToCam, 1e-9));
}

// ================= 2. OpenCV.js（Node）=================
const opencvPath = fileURLToPath(new URL("../public/vendor/opencv/opencv.js", import.meta.url));
if (!existsSync(opencvPath)) {
  console.log(`SKIP: ${opencvPath} が無い。npm run fetch:opencv で取得してから流す（この節は pass にならない）`);
  results.push(["OpenCV.js の節（opencv.js 未取得）", false]);
} else {
  const tLoad = Date.now();
  const cv = await loadOpenCvNode(opencvPath);
  console.log(`opencv.js 読み込み ${Date.now() - tLoad}ms`);
  check("OpenCV.js を Node で読み込めた（ArucoDetector / solvePnP あり）", typeof cv.aruco_ArucoDetector === "function" && typeof cv.solvePnP === "function");

  // ---- 辞書の一致 ----
  {
    const dict = cv.getPredefinedDictionary(cv.DICT_ARUCO_MIP_36h12);
    let same = 0;
    let total = 0;
    for (const id of [0, 1, 2, 3, 4, 5, 17, 100, 200, 249]) {
      const img = new cv.Mat();
      cv.generateImageMarker(dict, id, 8, img, 1);
      const js = bitsOf(id);
      let ok = true;
      for (let y = 0; y < 6; y++) for (let x = 0; x < 6; x++) if ((img.ucharAt(y + 1, x + 1) > 127) !== js[y][x]) ok = false;
      if (ok) same++;
      total++;
      img.delete();
    }
    check("辞書: OpenCV の DICT_ARUCO_MIP_36h12 と js-aruco2 の ARUCO_MIP_36h12 は同じ ID で同じ向きのビット（回転なしで一致。印刷ページのマーカーがそのまま読める）", same === total, `${same}/${total}`);
    check("辞書: 250 ID・6x6 ビット", dict.bytesList.rows === 250 && dict.markerSize === 6);
    dict.delete();
  }

  const detector = createArucoDetector(cv);

  // ---- 誤り訂正の厳しさ: 印刷したマーカーの内側のセルを k 個反転しても ID 0 と読むか（js-aruco2 の maxHammingDistance 4 と同じ）----
  {
    const dict = cv.getPredefinedDictionary(cv.DICT_ARUCO_MIP_36h12);
    const CELL = 20;
    const PAD = 60;
    const flips = [[0, 0], [1, 3], [2, 5], [3, 1], [4, 4], [5, 2], [0, 5]];
    const detectedWith = (k) => {
      const marker = new cv.Mat();
      cv.generateImageMarker(dict, 0, 8 * CELL, marker, 1);
      const img = new cv.Mat();
      cv.copyMakeBorder(marker, img, PAD, PAD, PAD, PAD, cv.BORDER_CONSTANT, new cv.Scalar(255));
      marker.delete();
      for (const [r, c] of flips.slice(0, k)) {
        for (let y = (1 + r) * CELL; y < (2 + r) * CELL; y++) {
          for (let x = (1 + c) * CELL; x < (2 + c) * CELL; x++) {
            const i = (PAD + y) * img.cols + PAD + x;
            img.data[i] = 255 - img.data[i];
          }
        }
      }
      const ids = detectMarkers(cv, detector, img).map((d) => d.id);
      img.delete();
      return ids;
    };
    const res = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => detectedWith(k));
    const text = res.map((ids, k) => `${k}:${ids.join("+") || "-"}`).join(" ");
    check("誤り訂正: 内側のセルを 4 ビットまで反転しても ID 0 として検出する", res.slice(0, 5).every((ids) => ids.length === 1 && ids[0] === 0), text);
    check("誤り訂正: 5 ビット以上反転すると検出しない（errorCorrectionRate 0.34 = int(12×0.34) = 4 ビット。既定 0.6 だと 7 ビットでも読んでいた）", res.slice(5).every((ids) => ids.length === 0), text);
    dict.delete();
  }

  const arucoDetector = new AR.Detector({ maxHammingDistance: 4 });
  const posit = new POS.Posit(MARKER_M, FOCAL);
  // marker-detector.ts と同じ POSIT → three.js の変換（列優先）
  const positToMatrix = (r, t) => [r[0][0], r[1][0], -r[2][0], 0, r[0][1], r[1][1], -r[2][1], 0, -r[0][2], -r[1][2], r[2][2], 0, t[0], t[1], -t[2], 1];
  const validPose = (e, r, t) => e >= 0 && r.length === 3 && r.every((row) => row.length === 3 && row.every(Number.isFinite)) && t.length === 3 && t.every(Number.isFinite);
  /** 08 の marker-detector.ts と同じ: POSIT の best が無効なら alternative */
  function positPose(corners) {
    const centered = corners.map((c) => ({ x: c[0] - W / 2, y: H / 2 - c[1] }));
    const pose = posit.pose(centered);
    if (validPose(pose.bestError, pose.bestRotation, pose.bestTranslation)) return positToMatrix(pose.bestRotation, pose.bestTranslation);
    if (validPose(pose.alternativeError, pose.alternativeRotation, pose.alternativeTranslation)) return positToMatrix(pose.alternativeRotation, pose.alternativeTranslation);
    return null;
  }

  /**
   * field 座標系のマーカーをフェイクカメラと同じピンホール投影で灰色画像（CV_8UC1）に描く。
   * 4 倍で描いて INTER_AREA で縮小（画素の被覆率どおりのアンチエイリアス。ブラウザの canvas 2D の fill に近い）+ 軽いぼかしで実写に寄せる。
   * fillPoly をそのまま 1 倍で使うと縁の画素が両端とも塗られて黒い正方形が 1px 大きくなり、距離が 3% 近くなる（角の誤差 0.7px）。
   * 縮小後の画素 j の中心は 4 倍画像の 4j + 1.5 なので座標を +1.5 する（しないと −0.375px ずれる）。
   * ぼかしは σ=1.2: js-aruco2 は縁が鋭い合成画像だと候補は見つけても ID を読めない（σ 0.6 以下で 24 回中 1〜2 回しか検出しない。
   * 実写のレンズのぼけ相当を入れると 24/24）。両方の検出器に同じ画像を流すので条件は同じ
   */
  function renderImage(markers, camToField, sizeM = MARKER_M, blurSigma = 1.2) {
    const SS = 4;
    const big = new cv.Mat(H * SS, W * SS, cv.CV_8UC1, new cv.Scalar(140));
    const projected = projectFakeMarkers(markers, camToField, FOCAL, W, H, sizeM);
    const fill = (quad, value) => {
      const pts = cv.matFromArray(4, 1, cv.CV_32SC2, quad.flatMap(([x, y]) => [Math.round((x * SS + 1.5) * 16), Math.round((y * SS + 1.5) * 16)]));
      const vec = new cv.MatVector();
      vec.push_back(pts);
      cv.fillPoly(big, vec, new cv.Scalar(value), cv.LINE_8, 4);
      vec.delete();
      pts.delete();
    };
    for (const m of projected) {
      fill(m.quiet, 255);
      fill(m.black, 0);
      for (const q of m.cells) fill(q, 255);
    }
    const img = new cv.Mat();
    cv.resize(big, img, new cv.Size(W, H), 0, 0, cv.INTER_AREA);
    big.delete();
    if (blurSigma > 0) {
      const blurred = new cv.Mat();
      cv.GaussianBlur(img, blurred, new cv.Size(0, 0), blurSigma);
      img.delete();
      return { img: blurred, projected };
    }
    return { img, projected };
  }
  /** js-aruco2 用の ImageData 相当（RGBA） */
  function toImageData(gray) {
    const data = new Uint8ClampedArray(W * H * 4);
    const src = gray.data;
    for (let i = 0; i < W * H; i++) {
      data[i * 4] = src[i];
      data[i * 4 + 1] = src[i];
      data[i * 4 + 2] = src[i];
      data[i * 4 + 3] = 255;
    }
    return { width: W, height: H, data };
  }
  const layoutOf = (placements) => (id) => (id === 0 ? identity16 : placements.find((p) => p.id === id)?.toField ?? null);

  // ---- 検出 → solvePnP の往復（平面: 原点 1 枚）----
  {
    const camToField = fakeCameraToField([0.2, 0.15, 1.4], 20, 8);
    const { img, projected } = renderImage([fakeMarker(ORIGIN)], camToField);
    const dets = detectMarkers(cv, detector, img);
    check("検出: 合成画像から原点マーカー（ID 0）が 1 枚検出される", dets.length === 1 && dets[0].id === 0, JSON.stringify(dets.map((d) => d.id)));
    if (dets.length === 1) {
      const truth = projected[0].black;
      const cornerErr = Math.max(...dets[0].corners.map((c, i) => Math.hypot(c[0] - truth[i][0], c[1] - truth[i][1])));
      check("検出: 4 隅が投影した黒い正方形の角と同じ並び（左上から時計回り）で 0.5px 以内（サブピクセル精錬）", cornerErr < 0.5, `max=${cornerErr.toFixed(3)}px`);
      const board = buildBoard(dets, layoutOf([]), MARKER_M);
      const r = solveBoardPnP(cv, board, K, "auto", null);
      const truthM = invertRigid(camToField);
      check("solvePnP(auto, 平面): IPPE → LM で解け、再投影誤差 < 0.5px", r !== null && r.method === "ippe+lm" && r.errPx < 0.5, r ? `${r.method} ${r.errPx.toFixed(3)}px` : "null");
      if (r) {
        const pe = dist3(posOf(r.cameraMatrix), posOf(truthM));
        const re = rotationDiffDeg(r.cameraMatrix, truthM);
        check("solvePnP(平面 1 枚): カメラ姿勢が真値に位置 1cm・回転 3° 以内で戻る（座標系の向きが合っている。47px の 1 枚をぼかした画像なので角 0.4px の誤差で 2° 前後）", pe < 0.01 && re < 3, `pos=${(pe * 100).toFixed(2)}cm rot=${re.toFixed(2)}deg`);
      }
      const single = solveSingleMarker(cv, dets[0].corners, MARKER_M, K);
      check("solveSingleMarker(IPPE_SQUARE): 原点 1 枚なら board と同じ姿勢", single !== null && r !== null && dist3(posOf(single.cameraMatrix), posOf(r.cameraMatrix)) < 0.005 && rotationDiffDeg(single.cameraMatrix, r.cameraMatrix) < 0.5);
      const ippe = solveBoardPnP(cv, board, K, "ippe", null);
      const iter = solveBoardPnP(cv, board, K, "iterative", null);
      check("solvePnP(ippe / iterative 指定): どちらも解け、真値に 2cm・3° 以内", ippe && iter && ippe.method === "ippe" && iter.method === "iter" && dist3(posOf(ippe.cameraMatrix), posOf(truthM)) < 0.02 && dist3(posOf(iter.cameraMatrix), posOf(truthM)) < 0.02 && rotationDiffDeg(iter.cameraMatrix, truthM) < 3, `${ippe?.method} ${iter?.method} rot=${iter ? rotationDiffDeg(iter.cameraMatrix, truthM).toFixed(2) : "-"}deg`);
    }
    img.delete();
  }
  // ---- 非平面（原点 + 床）: ITERATIVE。前フレームを初期値にすると iter(guess) ----
  // 床のマーカーは壁際（原点の 1.2m 下・0.5m 手前）。カメラは床から 0.9m の高さ・壁から 2m で 11° 見下ろす（両方が縦 54° の視野に入る）
  {
    const FLOOR_NEAR = { id: 1, face: "floor", pos: [0, -1.2, 0.5] };
    const camToField = fakeCameraToField([0.05, -0.3, 2.0], 4, 11);
    const { img } = renderImage([fakeMarker(ORIGIN), fakeMarker(FLOOR_NEAR)], camToField);
    const dets = detectMarkers(cv, detector, img);
    check("検出: 原点 + 床（見下ろし）の 2 枚が検出される", dets.length === 2 && dets.some((d) => d.id === 0) && dets.some((d) => d.id === 1), JSON.stringify(dets.map((d) => d.id)));
    const board = buildBoard(dets, layoutOf([fakeMarker(FLOOR_NEAR)]), MARKER_M);
    const truthM = invertRigid(camToField);
    if (board) {
      check("board: 壁 + 床は非平面", !isCoplanar(board.objectPoints));
      const r = solveBoardPnP(cv, board, K, "auto", null);
      check("solvePnP(auto, 非平面): ITERATIVE（初期値無し）で解け、位置 1cm・回転 2° 以内", r !== null && r.method === "iter" && dist3(posOf(r.cameraMatrix), posOf(truthM)) < 0.01 && rotationDiffDeg(r.cameraMatrix, truthM) < 2, r ? `${r.method} pos=${(dist3(posOf(r.cameraMatrix), posOf(truthM)) * 100).toFixed(2)}cm rot=${rotationDiffDeg(r.cameraMatrix, truthM).toFixed(2)}deg err=${r.errPx.toFixed(3)}px` : "null");
      if (r) {
        const r2 = solveBoardPnP(cv, board, K, "auto", guessFromCameraMatrix(r.cameraMatrix));
        check("solvePnP(auto, 非平面, 前フレーム初期値): iter(guess) が採用され同じ解", r2 !== null && r2.method === "iter(guess)" && dist3(posOf(r2.cameraMatrix), posOf(r.cameraMatrix)) < 0.002, r2?.method);
        // 初期値が大きく外れていても、初期値無しの解のほうが良ければそちらに戻る
        const bad = guessFromCameraMatrix(fakeCameraToField([2, 1, 0.5], 120, -40));
        const r3 = solveBoardPnP(cv, board, K, "auto", bad);
        check("solvePnP: 外れた初期値から収束しなければ初期値無しの解を採る（再投影誤差で選ぶ）", r3 !== null && dist3(posOf(r3.cameraMatrix), posOf(truthM)) < 0.02, r3 ? `${r3.method} pos=${(dist3(posOf(r3.cameraMatrix), posOf(truthM)) * 100).toFixed(2)}cm` : "null");
        const ippeOnly = solveBoardPnP(cv, board, K, "ippe", null);
        check("solvePnP(ippe 指定, 非平面): IPPE は使えないので ITERATIVE に落ちて解ける", ippeOnly !== null && ippeOnly.method === "iter", ippeOnly?.method);
      }
      // 配置が実際と違う（床が 30cm ずれている）と再投影誤差が大きくなる（HUD の reproj= の意味）
      const wrong = buildBoard(dets, layoutOf([fakeMarker({ ...FLOOR_NEAR, pos: [0.3, -1.2, 0.5] })]), MARKER_M);
      const rw = solveBoardPnP(cv, wrong, K, "auto", null);
      check("配置の入力ミス（床を 30cm ずらす）は board の再投影誤差に出る（> 3px）", rw !== null && rw.errPx > 3, rw ? `${rw.errPx.toFixed(1)}px` : "null");
      // 既定の上限（?maxReprojPx=4 は 960px 基準。この画像は 640px なので 2.67px）で、正しい配置は通り、30cm ずれた配置は棄却される
      const limit = reprojLimitPx(DEFAULT_MAX_REPROJ_PX, Math.max(W, H));
      const rOk = solveBoardPnP(cv, board, K, "auto", null);
      check("既定の上限: 正しい配置の board は再投影誤差の上限と maxPoseError 0.5 の両方を通る", rOk !== null && rOk.errPx <= limit && Math.max(...rOk.markerErrors) <= 0.5, rOk ? `${rOk.errPx.toFixed(2)}px <= ${limit.toFixed(2)}px err=${rOk.markerErrors.map((e) => e.toFixed(2))}` : "null");
      check("既定の上限: 床を 30cm ずらした board は棄却される（再投影誤差が上限を超える）", rw !== null && rw.errPx > limit, rw ? `${rw.errPx.toFixed(1)}px > ${limit.toFixed(2)}px` : "null");
    }
    img.delete();
  }
  // ---- 08 の headless と同じ幾何（原点 + 正面 2 枚目 ID 5 が右 0.25m。100mm）で、spread が小さいこと ----
  {
    const size = 0.1;
    const d = (size * FOCAL) / (0.8 * 80);
    const camToField = fakeCameraToField([0, 0, d], 0, 0);
    const wall2 = { id: 5, face: "wall", pos: [0.25, 0, 0] };
    const markers = [{ id: 0, bits: bitsOf(0), toField: markerToFieldMatrix(ORIGIN) }, { id: 5, bits: bitsOf(5), toField: markerToFieldMatrix(wall2) }];
    const { img } = renderImage(markers, camToField, size);
    const dets = detectMarkers(cv, detector, img);
    const k2 = cameraMatrix(FOCAL, W, H);
    const cands = [];
    for (const dt of dets) {
      const s = solveSingleMarker(cv, dt.corners, size, k2);
      if (!s) {
        console.log(`solveSingleMarker が null: id=${dt.id} corners=${JSON.stringify(dt.corners)}`);
        continue;
      }
      const toField = dt.id === 0 ? identity16 : markerToFieldMatrix(wall2);
      const anchorM = mulMat4(s.cameraMatrix, invertRigid(toField));
      cands.push({ pos: posOf(anchorM), quat: [0, 0, 0, 1], weight: 1 });
    }
    const fused = fusePoseCandidates(cands);
    check("08 の headless と同じ幾何（原点 + ID 5）: 1 枚ずつの IPPE_SQUARE から出した原点の候補の spread < 5cm", dets.length === 2 && fused && fused.spread < 0.05, `ids=${dets.map((x) => x.id).join("+")} spread=${fused?.spread.toFixed(3)}m`);
    img.delete();
  }

  // ---- createOpenCvMarkerAnchor（08-4 のループがそのまま使う実装）を合成画像で動かす ----
  // marker-anchor-opencv.ts は Vite 向けに拡張子無しで import しているので、Node の解決に「.ts を補う」フックを足す。
  // フォールバック先の marker-detector.ts は CommonJS の js-aruco2 を名前付きで import する（Vite は変換するが Node は読めない）ので、
  // require した結果を名前付きで export する薄い ES モジュールに差し替える。
  // DOM は検出に使う分だけのスタブ（canvas の getImageData が合成画像を返す）。カメラはワールド原点・単位回転なので anchor = field → カメラ
  {
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === "js-aruco2" || specifier.startsWith("js-aruco2/")) return { url: `cjs-shim:${specifier}`, shortCircuit: true };
        try {
          return nextResolve(specifier, context);
        } catch (e) {
          if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier)) return nextResolve(`${specifier}.ts`, context);
          throw e;
        }
      },
      load(url, context, nextLoad) {
        if (!url.startsWith("cjs-shim:")) return nextLoad(url, context);
        const spec = url.slice("cjs-shim:".length);
        const names = Object.keys(require(spec)).filter((k) => /^[A-Za-z_$][\w$]*$/.test(k));
        const source = `import { createRequire } from "node:module"; const m = createRequire(${JSON.stringify(import.meta.url)})(${JSON.stringify(spec)}); export default m; ${names.map((k) => `export const ${k} = m.${k};`).join(" ")}`;
        return { format: "module", source, shortCircuit: true };
      },
    });
    let frame = null;
    globalThis.HTMLMediaElement ??= { HAVE_CURRENT_DATA: 2 };
    globalThis.document ??= {
      createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage() {}, getImageData: () => frame }) }),
    };
    const THREE = await import("three");
    const { createOpenCvMarkerAnchor, OPENCV_MAX_CONSECUTIVE_ERRORS } = await import("../src/shared/marker-anchor-opencv.ts");
    const extraOf = (p) => ({ id: p.id, toAnchor: new THREE.Matrix4().fromArray(markerToFieldMatrix(p)) });
    async function makeAnchor(extras, cvImpl = cv) {
      const video = { readyState: 4, currentTime: 0, videoWidth: W, videoHeight: H };
      const anchor = new THREE.Object3D();
      const a = createOpenCvMarkerAnchor({
        opencvUrl: "",
        detector: "opencv",
        pnpMethod: "auto",
        poseSource: "board",
        maxReprojPx: DEFAULT_MAX_REPROJ_PX,
        loadCv: async () => cvImpl,
        video,
        camera: new THREE.PerspectiveCamera(),
        anchor,
        markerSizeM: MARKER_M,
        markerId: 0,
        extraMarkers: () => extras,
        maxPoseError: 0.5,
        detW: 960,
        smooth: 1,
        minIntervalMs: 0,
        camHFovDeg: () => HFOV,
        resnapAfterMs: 2000,
        snapDistanceM: 0.3,
      });
      await new Promise((r) => setTimeout(r, 0));
      let now = 1000;
      const step = (img) => {
        frame = toImageData(img);
        video.currentTime += 1 / 30;
        now += 100;
        a.update(now);
      };
      return { a, anchor, step };
    }

    // 配置の不整合（ID 5 は実物が右 0.6m、配置は右 1.2m = 0.6m ずれ）: board は棄却されるが、1 枚ずつの平均（同じ不正な配置で原点に直す）には落とさず原点だけで解く
    {
      const camToField = fakeCameraToField([0.3, 0.1, 1.6], 0, 4);
      const { img } = renderImage([fakeMarker(ORIGIN), fakeMarker(WALL2)], camToField);
      const ref = await makeAnchor([]);
      const bad = await makeAnchor([extraOf({ id: 5, face: "wall", pos: [1.2, 0, 0] })]);
      for (let i = 0; i < 3; i++) {
        ref.step(img);
        bad.step(img);
      }
      const truth = posOf(invertRigid(camToField));
      const refPos = ref.anchor.position.toArray();
      const badPos = bad.anchor.position.toArray();
      const moved = dist3(refPos, badPos);
      console.log(`inconsistent layout: ref=${ref.a.info} / bad=${bad.a.info} moved=${(moved * 100).toFixed(2)}cm`);
      check("配置の不整合（0.6m ずれ）: 原点マーカー単体のアンカーは真値に 3cm 以内（基準の確認）", ref.a.backend === "opencv" && dist3(refPos, truth) < 0.03, `${(dist3(refPos, truth) * 100).toFixed(2)}cm`);
      check("配置の不整合（0.6m ずれ）: アンカーが原点マーカー単体の位置から 2cm 以上動かない（1 枚ずつの平均に落ちない）", bad.a.everDetected && moved < 0.02, `moved=${(moved * 100).toFixed(2)}cm`);
      check("配置の不整合: usedIds は実際に寄与した原点だけ、HUD に inconsistent と spread（独立の 1 枚ずつの解のばらつき ≈ 0.6m）が出る", bad.a.usedIds.join("+") === "0" && /inconsistent/.test(bad.a.info) && bad.a.spreadM > 0.45 && bad.a.spreadM < 0.75, `usedIds=${bad.a.usedIds} spread=${bad.a.spreadM.toFixed(2)} info=${bad.a.info}`);
      img.delete();
    }
    // 原点が見えないときの不整合: 直前の姿勢を維持（lastAcceptedMs を進めない。ロストではなく inconsistent と出す）
    {
      const camToField = fakeCameraToField([0, 0.1, 1.8], 0, 3);
      const WALL7 = { id: 7, face: "wall", pos: [-0.6, 0, 0] };
      const extras = [extraOf(WALL2), extraOf(WALL7)];
      const t = await makeAnchor(extras);
      const all = renderImage([fakeMarker(ORIGIN), fakeMarker(WALL2), fakeMarker(WALL7)], camToField);
      t.step(all.img);
      t.step(all.img);
      const ok = t.a.everDetected && t.a.usedIds.length === 3;
      const before = t.anchor.position.toArray();
      const acceptedBefore = t.a.lastAcceptedMs;
      extras[1] = extraOf({ ...WALL7, pos: [-1.2, 0, 0] });
      const hidden = renderImage([fakeMarker(WALL2), fakeMarker(WALL7)], camToField);
      t.step(hidden.img);
      t.step(hidden.img);
      const held = dist3(before, t.anchor.position.toArray());
      console.log(`inconsistent without origin: info=${t.a.info}`);
      check("原点が見えない不整合: 3 枚が正しい配置で見えている間は board（usedIds=0+5+7）", ok, `usedIds=${t.a.usedIds}`);
      check("原点が見えない不整合: 直前の姿勢を維持し（アンカーが動かない・lastAcceptedMs を進めない）、HUD は inconsistent spread=…m", held === 0 && t.a.lastAcceptedMs === acceptedBefore && /^inconsistent spread=[\d.]+m/.test(t.a.info), `held=${held} info=${t.a.info}`);
      all.img.delete();
      hidden.img.delete();
    }
    // 実行時の例外（WASM の abort 後は毎フレーム throw）: 30 回連続で js-aruco2 に切り替わり、update は例外を外に出さない
    {
      const throwingCv = Object.create(cv);
      throwingCv.aruco_ArucoDetector = class {
        detectMarkers() {
          throw new Error("fake abort");
        }
        delete() {}
      };
      const t = await makeAnchor([], throwingCv);
      const camToField = fakeCameraToField([0.1, 0.1, 1.4], 0, 4);
      const { img } = renderImage([fakeMarker(ORIGIN)], camToField);
      let escaped = null;
      let backendAt29 = "";
      let infoAt29 = "";
      let acceptedAt29 = 0;
      for (let i = 1; i <= OPENCV_MAX_CONSECUTIVE_ERRORS + 5; i++) {
        try {
          t.step(img);
        } catch (e) {
          escaped = e;
        }
        if (i === OPENCV_MAX_CONSECUTIVE_ERRORS - 1) {
          backendAt29 = t.a.backend;
          infoAt29 = t.a.info;
          acceptedAt29 = t.a.lastAcceptedMs;
        }
      }
      console.log(`runtime errors: at ${OPENCV_MAX_CONSECUTIVE_ERRORS - 1}: ${backendAt29} ${infoAt29} / after: ${t.a.backend} (${t.a.loadStatus}) ${t.a.info}`);
      check("実行時の例外: update は例外を外に出さない", escaped === null, String(escaped));
      check("実行時の例外: 29 回目までは opencv のまま、HUD は error(29x)=理由 でロスト扱い（一度も採用しない）", OPENCV_MAX_CONSECUTIVE_ERRORS === 30 && backendAt29 === "opencv" && /^error\(29x\)=fake abort/.test(infoAt29) && acceptedAt29 === -Infinity, infoAt29);
      check("実行時の例外: 30 回連続で js-aruco2 に切り替わり（loadStatus に理由）、以後は js-aruco2 で原点を検出する", t.a.backend === "aruco2" && t.a.loadStatus === "opencv runtime error: fake abort" && t.a.info.startsWith("id=0"), `${t.a.backend} ${t.a.loadStatus} ${t.a.info}`);
      img.delete();
    }
  }

  // ---- 比較: 同じ合成入力を js-aruco2 + POSIT（08）と OpenCV + solvePnP（08-4）に流す ----
  // 原点マーカー 150mm を 1.5m から、ヨー 0 / 30 / 45 / 60°（カメラは原点を向く）。試行ごとに位置を ±3cm・向きを ±1.5° 揺らして
  // ラスタライズの位相を変え（角の量子化 = 実写のノイズの代わり）、原点の推定位置の真値からの誤差を集める。
  // 出すもの: 位置の誤差の中央値 / p90（水平化なし = 生の姿勢、水平化あり = 08 と同じ worldUp の式）、傾きの誤差の p90。
  // 2 枚（原点 + 同じ壁の ID 5 が右 0.6m）では 08 の重み付き平均と 08-4 の board を比べる
  {
    let seed = 20260916;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const N = 24;
    const DIST = 1.5;
    const rows = [];
    /** アンカー（field → world）の推定から、世界 = field なので真値は原点 0・回転 I。水平化は marker-anchor.ts の式 */
    const evalAnchor = (anchorM, centerWorld, centerAnchor) => {
      const raw = dist3(posOf(anchorM), [0, 0, 0]);
      const tilt = tiltDegOf(anchorM, [0, 1, 0]);
      const lvl = levelRotation(anchorM, [0, 1, 0]);
      const off = transformPoint(lvl, centerAnchor);
      const leveled = dist3([centerWorld[0] - off[0], centerWorld[1] - off[1], centerWorld[2] - off[2]], [0, 0, 0]);
      return { raw, tilt, leveled };
    };
    for (const twoMarkers of [false, true]) {
      const placements = twoMarkers ? [fakeMarker(WALL2)] : [];
      const markers = [fakeMarker(ORIGIN), ...placements];
      const layout = layoutOf(placements);
      for (const yaw of [0, 30, 45, 60]) {
        const stats = { posit: { raw: [], leveled: [], tilt: [] }, pnp: { raw: [], leveled: [], tilt: [] }, detectedA: 0, detectedC: 0, n: 0 };
        for (let i = 0; i < N; i++) {
          // カメラ: 原点から DIST 離れた位置をヨーだけ回した円周上（camera は原点を向く）。少し揺らす
          const y = ((yaw + (rand() - 0.5) * 3) * Math.PI) / 180;
          const pos = [Math.sin(y) * DIST + (rand() - 0.5) * 0.06, 0.1 + (rand() - 0.5) * 0.06, Math.cos(y) * DIST + (rand() - 0.5) * 0.06];
          // fakeCameraToField の yaw は + で左を向く。原点を向くには視線を -pos 方向へ: yawDeg = atan2(pos.x, pos.z)（右にいれば右を向く = 負）
          const yawDeg = (Math.atan2(pos[0], pos[2]) * 180) / Math.PI;
          const pitchDeg = (Math.atan2(pos[1], Math.hypot(pos[0], pos[2])) * 180) / Math.PI;
          const camToField = fakeCameraToField(pos, yawDeg, pitchDeg);
          const { img } = renderImage(markers, camToField);
          stats.n++;
          // 08: js-aruco2 + POSIT（1 枚ずつ → 辺長² の重み付き平均）
          const aMarkers = arucoDetector.detect(toImageData(img));
          const aCands = [];
          let aCenterW = [0, 0, 0];
          let aCenterA = [0, 0, 0];
          for (const m of aMarkers) {
            const toAnchor = layout(m.id);
            if (!toAnchor || aCands.some((c) => c.id === m.id)) continue;
            const corners = m.corners.map((c) => [c.x, c.y]);
            const mw = positPose(corners);
            if (!mw) continue;
            const anchorM = mulMat4(camToField, mulMat4(mw, invertRigid(toAnchor)));
            const side = meanSidePx(corners);
            aCands.push({ id: m.id, pos: posOf(anchorM), quat: [0, 0, 0, 1], weight: side * side, anchorM, centerW: posOf(mulMat4(camToField, mw)), centerA: posOf(toAnchor) });
          }
          if (aCands.length > 0) {
            stats.detectedA++;
            // 位置は重み付き平均（08）。傾きは各候補の最大（08 の tiltDeg）。水平化は候補ごとに行って平均（08 の apply と同じ順）
            let wsum = 0;
            const rawP = [0, 0, 0];
            const lvlP = [0, 0, 0];
            let tiltMax = 0;
            for (const c of aCands) {
              const e = evalAnchor(c.anchorM, c.centerW, c.centerA);
              tiltMax = Math.max(tiltMax, e.tilt);
              const lvl = levelRotation(c.anchorM, [0, 1, 0]);
              const off = transformPoint(lvl, c.centerA);
              wsum += c.weight;
              for (let k = 0; k < 3; k++) {
                rawP[k] += c.pos[k] * c.weight;
                lvlP[k] += (c.centerW[k] - off[k]) * c.weight;
              }
            }
            stats.posit.raw.push(Math.hypot(...rawP.map((v) => v / wsum)));
            stats.posit.leveled.push(Math.hypot(...lvlP.map((v) => v / wsum)));
            stats.posit.tilt.push(tiltMax);
            aCenterW = aCands[0].centerW;
            aCenterA = aCands[0].centerA;
          }
          // 08-4: OpenCV + board solvePnP
          const dets = detectMarkers(cv, detector, img);
          const board = buildBoard(dets, layout, MARKER_M);
          const r = board ? solveBoardPnP(cv, board, K, "auto", null) : null;
          if (r) {
            stats.detectedC++;
            const anchorM = mulMat4(camToField, r.cameraMatrix);
            const cA = meanV3(board.centersAnchor);
            const cW = transformPoint(anchorM, cA);
            const e = evalAnchor(anchorM, cW, cA);
            stats.pnp.raw.push(e.raw);
            stats.pnp.leveled.push(e.leveled);
            stats.pnp.tilt.push(e.tilt);
          }
          void aCenterW;
          void aCenterA;
          img.delete();
        }
        rows.push({ twoMarkers, yaw, stats });
        console.log(`比較 ${twoMarkers ? "2 枚" : "1 枚"} ${yaw}°: 検出 08 ${stats.detectedA}/${stats.n}, 08-4 ${stats.detectedC}/${stats.n}`);
      }
    }
    console.log("\n比較（原点 150mm を 1.5m から。位置の誤差 [cm]・傾きの誤差 [deg]。raw = 水平化なし、lvl = 重力で水平化（08 と同じ式）。n=検出できた試行/全試行）");
    console.log("| マーカー | 角度 | 検出 08 / 08-4 | 08 POSIT raw 中央値 / p90 | 08-4 PnP raw 中央値 / p90 | 08 lvl 中央値 / p90 | 08-4 lvl 中央値 / p90 | 傾き p90 08 / 08-4 |");
    console.log("| --- | --- | --- | --- | --- | --- | --- | --- |");
    const cm = (a) => (a.length ? `${(median(a) * 100).toFixed(1)} / ${(p90(a) * 100).toFixed(1)}` : "-");
    const deg = (a) => (a.length ? p90(a).toFixed(1) : "-");
    for (const { twoMarkers, yaw, stats: s } of rows) {
      console.log(`| ${twoMarkers ? "原点 + ID 5（同じ壁）" : "原点 1 枚"} | ${yaw}° | ${s.detectedA} / ${s.detectedC} (n=${s.n}) | ${cm(s.posit.raw)} | ${cm(s.pnp.raw)} | ${cm(s.posit.leveled)} | ${cm(s.pnp.leveled)} | ${deg(s.posit.tilt)} / ${deg(s.pnp.tilt)} |`);
    }
    console.log("");
    const at = (two, yaw) => rows.find((r) => r.twoMarkers === two && r.yaw === yaw).stats;
    // 判定（2026-09-17 の結果に基づく。1 枚では PnP と POSIT はほぼ同等で、複数枚を 1 つの board にしたときに差が出る）
    for (const yaw of [0, 30, 45]) {
      const s = at(false, yaw);
      check(`比較 ${yaw}°: 両方の検出器が全試行で原点を検出する`, s.detectedA === s.n && s.detectedC === s.n, `${s.detectedA} / ${s.detectedC} of ${s.n}`);
    }
    {
      const s = at(false, 60);
      check("比較 60°: OpenCV は全試行で検出し、js-aruco2 も 7 割以上は検出する（60° の細い台形は js-aruco2 が落とし始める）", s.detectedC === s.n && s.detectedA >= s.n * 0.7, `${s.detectedA} / ${s.detectedC} of ${s.n}`);
    }
    for (const yaw of [45, 60]) {
      const s = at(false, yaw);
      check(`比較 ${yaw}°（1 枚）: 08-4 の PnP（生の姿勢）の原点位置の p90 誤差が 08 の POSIT の 1.2 倍以内（1 枚では同等。悪化していない）`, s.pnp.raw.length > 0 && p90(s.pnp.raw) <= p90(s.posit.raw) * 1.2, `PnP ${(p90(s.pnp.raw) * 100).toFixed(1)}cm vs POSIT ${(p90(s.posit.raw) * 100).toFixed(1)}cm`);
      const s2 = at(true, yaw);
      check(`比較 ${yaw}°（2 枚）: 08-4 の board の原点位置の p90 誤差が 08 の重み付き平均の半分以下（複数枚の同時最適化が効く）`, s2.pnp.raw.length > 0 && p90(s2.pnp.raw) <= p90(s2.posit.raw) * 0.5, `board ${(p90(s2.pnp.raw) * 100).toFixed(1)}cm vs POSIT 平均 ${(p90(s2.posit.raw) * 100).toFixed(1)}cm`);
    }
    const s0 = at(false, 0);
    check("比較 0°（1 枚）: 08-4 の PnP は正面でも原点位置の p90 誤差 < 3cm（08 と同じ位置が出る）", s0.pnp.raw.length > 0 && p90(s0.pnp.raw) < 0.03, `${(p90(s0.pnp.raw) * 100).toFixed(1)}cm`);
    const s0b = at(true, 0);
    check("比較 0°（2 枚）: 正面の 2 枚目（右 0.6m を斜めに見る）は POSIT だと鏡像の解で原点が 10cm 超飛ぶ（issue #55 の機序）が、board なら 2cm 未満", p90(s0b.posit.raw) > 0.1 && p90(s0b.pnp.raw) < 0.02, `POSIT 平均 ${(p90(s0b.posit.raw) * 100).toFixed(1)}cm vs board ${(p90(s0b.pnp.raw) * 100).toFixed(1)}cm`);
  }
  detector.delete();
}

const failed = results.filter(([, ok]) => !ok);
console.log(`\n${((performance.now()) / 1000).toFixed(1)}s`);
console.log(failed.length === 0 ? "ALL PASS" : `${failed.length} FAILED`);
process.exit(failed.length === 0 ? 0 : 1);

/**
 * opencv.js（UMD。Emscripten の Node 対応ビルド）を Node で読み込む。package.json が "type": "module" なので .js を require すると
 * ESM 扱いになり __dirname が無いと落ちる。CommonJS の関数でくるんで評価する（Node が CJS を読むときと同じ形）
 */
async function loadOpenCvNode(path) {
  const src = readFileSync(path, "utf8");
  const mod = { exports: {} };
  const fn = new Function("module", "exports", "require", "__dirname", "__filename", src);
  fn(mod, mod.exports, createRequire(path), dirname(path), path);
  let cv = mod.exports;
  if (cv instanceof Promise) cv = await cv;
  // Module.then（古い Emscripten の thenable）を消す。残したまま async 関数から返すと Promise の解決が無限ループする（opencv-loader.ts 参照）
  delete cv.then;
  if (typeof cv.Mat !== "function") {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("OpenCV.js の初期化がタイムアウト")), 60_000);
      cv.onRuntimeInitialized = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
  return cv;
}
