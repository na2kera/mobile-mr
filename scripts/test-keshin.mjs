// ex9-1-keshin（化身）の回帰テスト。`npm run test:keshin` で実行する。
//   1. keshin-math.ts — 体の向き（正面・見上げ 80°・見下ろし 60°・首を横に向けた・首を傾けて水平を横切る）、送信側の平滑化
//   2. keshin-math.ts — 化身の配置（頭の姿勢 → モデル行列・背中からの距離・腰のクリッピング平面・せり上がり・主観の前傾）
//   3. keshin-math.ts — 主観の見上げフェード、受信側の信用度による薄さ
//   4. keshin-timeline.ts — 出現・消去・途中反転の連続性（純粋関数で隠れた状態が無い）
//   5. keshin-protocol.ts — 化身の割り当て（最初の 4 人は別々・抜けた番号を次の人へ）、本人が選んだ化身の読み取り（issue #90）
//   6. server/keshin.ts — メッセージの検証（NaN・巨大値・退化クォータニオン・不正な向き）
//   7. server/keshin.ts — サーバーの流れ（Vite dev サーバーを起動して WebSocket で: 入室 → 割り当て → keshin on → 全員に配られる →
//      途中入室者のスナップショット → 途中反転 → 退室 → 番号の再利用、役割ごとの上限）
//      KESHIN_TEST_SERVER=worker（`npm run test:keshin:worker`）のときは Vite の代わりに
//      `wrangler dev`（deploy/cloudflare/ の Worker + Durable Object）を起動して同じ検査を回す
// テストフレームワークは使わない（04〜09 と同じ方針）。Node 22.18+ は .ts をそのまま import できる
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import WebSocket from "ws";
import {
  BACK_CLEARANCE_M,
  autoBack,
  bodyForward,
  effectiveTrack,
  isPositionFrozen,
  keshinCutPlane,
  keshinModelMatrix,
  keshinModelToWorld,
  keshinScale,
  resolveKeshinBelow,
  lookUpDeg,
  markerFwdToWorldYaw,
  markerToWorld,
  maskUvFromFragment,
  poseReceivedLocal,
  remoteDisplay,
  smoothToward,
  rotateByQuat,
  selfAutoBack,
  selfLookFade,
  smoothYaw,
  stageStartLocal,
  trackFade,
  wrapAngle,
  yawOfForward,
} from "../demos/ex9-1-keshin/keshin-math.ts";
import { APPEAR_SEC, AURA_SUSTAIN, RISE_M, VANISH_SEC, elapsedForProgress, keshinTimeline, progressOf, retargetElapsed, visualAt } from "../src/shared/keshin-timeline.ts";
import { KESHIN_COUNT, KESHIN_NAMES, KESHIN_PATH, KESHIN_PROTOCOL_VERSION, MAX_OVERVIEWS, MAX_PLAYERS, REPLACED_REASON, assignKeshin, parseKeshinChoice } from "../src/shared/keshin-protocol.ts";
import { parseClientMessage } from "../server/keshin.ts";
import { invertRigid, levelRotation, markerAxes, mulMat4, transformPoint } from "../src/shared/marker-layout.ts";
import { fakeCameraToField } from "../src/shared/fake-markers.ts";
import { coverUvTransform, pickBackUltraWide } from "../src/shared/passthrough-camera.ts";
import * as THREE from "three";
import { assignMirror, assignMirrorTracked, mirrorImgGate, mirrorVisibility, fakeMirrorPose, mirrorBodyFacing, mirrorDir, mirrorHoldFade, mirrorImageX, mirrorPersonFromPose, withNearImg } from "../demos/ex9-1-keshin/mirror-math.ts";
import { projectToImage } from "../src/shared/fake-hands.ts";
import { decideMaskSource, maskStats, skeletonPersonShape } from "../demos/ex9-1-keshin/keshin-occlusion.ts";
import { angleFromEyeDeg, blendDistance, correctionAt, detectionToWorld, facingDiffDeg, hybridHead, matchRemotes, matchRemotesDiag, planRemote, pruneCorr, robustMeanV3 } from "../demos/ex9-1-keshin/keshin-hybrid.ts";
import { poseFromCamPoints, fakeMirrorPoints } from "../demos/ex9-1-keshin/mirror-math.ts";
import { worldToMarker } from "../demos/ex9-1-keshin/keshin-math.ts";
import { MaskHzGovernor, PersonMask, createMaskUniforms, decideMaskHzLevel, maskHzLevels } from "../demos/ex9-1-keshin/keshin-occlusion.ts";

const results = [];
function check(name, cond, detail = "") {
  results.push([name, !!cond]);
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${detail ? ` (${detail})` : ""}`);
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DEG = Math.PI / 180;

// ---- クォータニオンの小道具（three.js の座標系: カメラは −Z を見る、Y 上）----
const qAxis = (ax, ay, az, deg) => {
  const h = (deg * DEG) / 2;
  const s = Math.sin(h);
  return [ax * s, ay * s, az * s, Math.cos(h)];
};
const qMul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
/** 頭の姿勢: ヨー（左が +）→ ピッチ（上が +）→ ロール（右に傾けるのが −） の順（DeviceOrientation の YXZ と同じ） */
const headQuat = (yawDeg, pitchDeg, rollDeg = 0) => qMul(qMul(qAxis(0, 1, 0, yawDeg), qAxis(1, 0, 0, pitchDeg)), qAxis(0, 0, 1, rollDeg));
const fwdNear = (f, x, z, eps = 1e-6) => f && near(f[0], x, eps) && near(f[1], z, eps);

// ================= 1. 体の向き =================
{
  const f0 = bodyForward(headQuat(0, 0));
  check("正面: 体の向きは −Z（マーカーの方）", fwdNear(f0, 0, -1), JSON.stringify(f0));
  check("正面: ヨーは ±π（モデルの +Z が −Z を向く）", near(Math.abs(yawOfForward(f0)), Math.PI));
  const up80 = bodyForward(headQuat(0, 80));
  check("見上げ 80°: 前方の水平成分が小さくても体の向きは −Z のまま", fwdNear(up80, 0, -1), JSON.stringify(up80));
  const up90 = bodyForward(headQuat(0, 89.99));
  check("真上（89.99°）でも −Z", fwdNear(up90, 0, -1, 1e-6), JSON.stringify(up90));
  const down60 = bodyForward(headQuat(0, -60));
  check("見下ろし 60°: 体の向きは −Z（画面の下向きの水平成分は後ろを指すので s = −1 で反転）", fwdNear(down60, 0, -1), JSON.stringify(down60));
  const down89 = bodyForward(headQuat(0, -89.99));
  check("真下（−89.99°）でも −Z", fwdNear(down89, 0, -1, 1e-6), JSON.stringify(down89));
  const side = bodyForward(headQuat(90, 0));
  check("首を左に 90° 向けた: 体の向きは −X", fwdNear(side, -1, 0), JSON.stringify(side));
  const sideUp = bodyForward(headQuat(30, 80));
  check("左 30° を向いて見上げ 80°: 左 30° のまま", fwdNear(sideUp, -Math.sin(30 * DEG), -Math.cos(30 * DEG)), JSON.stringify(sideUp));
  const sideDown = bodyForward(headQuat(-45, -60));
  check("右 45° を向いて見下ろし 60°: 右 45° のまま", fwdNear(sideDown, Math.sin(45 * DEG), -Math.cos(45 * DEG)), JSON.stringify(sideDown));
  // 首を 15° 傾けたまま水平を横切る: 向きが飛ばない（s を ±10° で混ぜているので連続）
  let maxStep = 0;
  let prev = null;
  for (let p = -20; p <= 20; p += 0.5) {
    const y = yawOfForward(bodyForward(headQuat(0, p, 15)));
    if (prev !== null) maxStep = Math.max(maxStep, Math.abs(wrapAngle(y - prev)));
    prev = y;
  }
  check("首を 15° 傾けて水平を横切っても体の向きが飛ばない（0.5° 刻みで 1.5° 以内）", maxStep < 1.5 * DEG, `${(maxStep / DEG).toFixed(2)}deg`);
  check("lookUpDeg: 見上げ 40° / 見下ろし 60°", near(lookUpDeg(headQuat(20, 40)), 40, 1e-9) && near(lookUpDeg(headQuat(0, -60)), -60, 1e-9));
  check("rotateByQuat: Y 軸 90° で −Z → −X", (() => {
    const v = rotateByQuat(qAxis(0, 1, 0, 90), [0, 0, -1]);
    return near(v[0], -1) && near(v[1], 0) && near(v[2], 0);
  })());
  // 送信側の平滑化（状態は前回の値 1 つだけ）
  check("smoothYaw: 初回は目標そのまま", near(smoothYaw(null, 1.2, 0.016, 0.25), 1.2));
  let y = 0;
  for (let i = 0; i < 60; i++) y = smoothYaw(y, 1, 1 / 60, 0.25);
  check("smoothYaw: 時定数 0.25s → 1s 後に 98% 近づく", near(y, 1 - Math.exp(-4), 1e-9), y.toFixed(4));
  const wrap = smoothYaw(170 * DEG, -170 * DEG, 0.25, 0.25);
  check("smoothYaw: ±180° をまたぐときは近い側（180° 側）へ回る", Math.abs(wrap) > 170 * DEG, `${(wrap / DEG).toFixed(1)}deg`);
  check("smoothYaw: 時定数 0 なら平滑化なし", near(smoothYaw(0.3, 2, 0.016, 0), 2));
}

// ================= 2. 化身の配置 =================
{
  const scale = keshinScale(3);
  check("大きさ: keshinH=3 → scale 0.6", near(scale, 0.6));
  const frontZ = 0.935; // 魔神の上半身の前面（モデル座標。実測値の例）
  const back = autoBack(frontZ, scale);
  check("背中からの距離 = 前面 × scale + 0.25", near(back, frontZ * 0.6 + BACK_CLEARANCE_M));
  for (const yawDeg of [180, 0, 90, -37]) {
    const yaw = yawDeg * DEG;
    const head = [0.3, 1.62, 1.4];
    const frame = { head, yaw, eyeH: 1.5, back, cutY: 2.77, scale, riseM: 0, leanDeg: 0 };
    const f = [Math.sin(yaw), Math.cos(yaw)];
    const feet = keshinModelToWorld(frame, [0, 0, 0]);
    check(`yaw ${yawDeg}°: 足元（原点）の高さ = 頭 − eyeH`, near(feet[1], head[1] - 1.5));
    const behind = (head[0] - feet[0]) * f[0] + (head[2] - feet[2]) * f[1];
    check(`yaw ${yawDeg}°: 原点は頭の真下から back だけ後ろ（横ずれなし）`, near(behind, back) && near((feet[0] - head[0]) * f[1] - (feet[2] - head[2]) * f[0], 0));
    const front = keshinModelToWorld(frame, [0, 3.5, frontZ]);
    const gap = (head[0] - front[0]) * f[0] + (head[2] - front[2]) * f[1];
    check(`yaw ${yawDeg}°: 上半身の前面は頭の中心から 0.25m 後ろ`, near(gap, BACK_CLEARANCE_M, 1e-9), gap.toFixed(4));
    const nose = keshinModelToWorld(frame, [0, 0, 1]);
    const dir = [nose[0] - feet[0], nose[2] - feet[2]];
    check(`yaw ${yawDeg}°: モデルの正面 +Z が本人の体の向き`, near(dir[0] / scale, f[0]) && near(dir[1] / scale, f[1]));
  }
  // せり上がり: クリッピング平面は腰に残り、モデルだけ下がる
  const base = { head: [0, 1.6, 1], yaw: Math.PI, eyeH: 1.5, back: 0.8, cutY: 2.77, scale: 0.6, riseM: 0, leanDeg: 0 };
  const risen = { ...base, riseM: -RISE_M };
  const cut0 = keshinCutPlane(base);
  const cut1 = keshinCutPlane(risen);
  check("腰のクリッピング平面の高さ = 床 + cutY × scale（上向き）", near(cut0.point[1], 0.1 + 2.77 * 0.6) && near(cut0.normal[1], 1));
  check("せり上がり中もクリッピング平面は動かない", cut0.point.every((v, i) => near(v, cut1.point[i])) && cut0.normal.every((v, i) => near(v, cut1.normal[i])));
  check("せり上がり中はモデルが RISE_M 下にある", near(keshinModelToWorld(risen, [0, 4, 0])[1], keshinModelToWorld(base, [0, 4, 0])[1] - RISE_M));
  // 段階 3 の C（他人用）: showBelow は切り口だけを支点から下げ、モデル行列（化身の位置）は変えない
  const lookFrame = { ...base, waistAboveHead: 0.3 };
  const lower = { ...lookFrame, showBelow: 0.6 };
  const cutPivot = keshinCutPlane(lookFrame);
  const cutLow = keshinCutPlane(lower);
  check("showBelow: 支点は頭 + waistAboveHead（未指定と 0 は同じ）", near(cutPivot.point[1], 1.6 + 0.3) && keshinCutPlane({ ...lookFrame, showBelow: 0 }).point.every((v, i) => near(v, cutPivot.point[i])));
  check("showBelow: 切り口は支点の showBelow 下（水平位置・法線は同じ）", near(cutLow.point[1], cutPivot.point[1] - 0.6) && near(cutLow.point[0], cutPivot.point[0]) && near(cutLow.point[2], cutPivot.point[2]) && cutLow.normal.every((v, i) => near(v, cutPivot.normal[i])));
  check("showBelow: モデル行列は変わらない（体が下へ伸びるだけ）", keshinModelMatrix(lower).every((v, i) => near(v, keshinModelMatrix(lookFrame)[i])));
  // 他人用の切り口の既定は化身ごと（KESHIN_SPECS の below）。URL で明示した値（null 以外）だけが全員を上書きする
  const specBelow = { showM: 0.6, dissolveM: 0.4 };
  const none = resolveKeshinBelow(specBelow, { showBelowM: null, dissolveM: null });
  check("切り口の既定: URL 未指定なら化身ごとの値", none.showM === 0.6 && none.dissolveM === 0.4, JSON.stringify(none));
  const both = resolveKeshinBelow(specBelow, { showBelowM: 0, dissolveM: 0.8 });
  check("切り口の既定: URL で指定した値は上書き（0 も上書きになる）", both.showM === 0 && both.dissolveM === 0.8, JSON.stringify(both));
  const one = resolveKeshinBelow(specBelow, { showBelowM: 0.2, dissolveM: null });
  check("切り口の既定: 片方だけ指定ならもう片方は化身ごとの値", one.showM === 0.2 && one.dissolveM === 0.4, JSON.stringify(one));
  // 行列は剛体 × 一様スケール
  const m = keshinModelMatrix({ ...base, yaw: 0.4, leanDeg: 20 });
  const colLen = (c) => Math.hypot(m[c * 4], m[c * 4 + 1], m[c * 4 + 2]);
  check("モデル行列は一様スケール（各軸の長さ = scale）", [0, 1, 2].every((c) => near(colLen(c), 0.6)));
  // 主観の前傾: 腰を支点に倒し、自動の後ろずらしで顔が目の faceAhead 前に来る
  const headLocal = { y: 4.16, z: 0.1 };
  const selfBack = selfAutoBack(headLocal, 2.77, 0.6, 35, 0.25);
  const self = { ...base, back: selfBack, leanDeg: 35 };
  const face = keshinModelToWorld(self, [0, headLocal.y, headLocal.z]);
  const ahead = (face[0] - self.head[0]) * Math.sin(self.yaw) + (face[2] - self.head[2]) * Math.cos(self.yaw);
  check("主観: 化身の顔は本人の目の 0.25m 前・頭上（目より上）", near(ahead, 0.25, 1e-9) && face[1] > self.head[1] + 0.3, `ahead=${ahead.toFixed(3)} h=${(face[1] - self.head[1]).toFixed(2)}`);
  const selfCut = keshinCutPlane(self);
  const tilt = Math.acos(selfCut.normal[1] / Math.hypot(...selfCut.normal)) / DEG;
  const lean0 = keshinCutPlane({ ...self, leanDeg: 0 });
  check("主観: 前傾は腰の切断面が支点（支点の位置は同じ・平面は 35° 傾く）", selfCut.point.every((v, i) => near(v, lean0.point[i])) && near(tilt, 35, 1e-9));
  const topLean = keshinModelToWorld(self, [0, 5, 0]);
  const topStraight = keshinModelToWorld({ ...self, leanDeg: 0 }, [0, 5, 0]);
  const fwdMove = (topLean[0] - topStraight[0]) * Math.sin(self.yaw) + (topLean[2] - topStraight[2]) * Math.cos(self.yaw);
  check("主観: 前傾で頭のてっぺんは前（体の向き）へ出る", fwdMove > 0.5, fwdMove.toFixed(3));
}

// ================= 2b. マーカー座標系の「上」（共有する座標の約束をテストで固定する）=================
// 壁のマーカー（原点）の座標系は X 右・Y 上・Z 壁から部屋側（marker-layout.ts の markerAxes("wall")）。
// 重力で水平化（marker-anchor.ts の worldUp → levelRotation）すると、アンカーの Y 軸 = ワールドの上になる。
// つまりマーカー座標系の +Y が鉛直上で、化身の足元 = 頭 − eyeH は Y を引けばよい。マーカーを見ている人の体の向きは −Z
{
  const ax = markerAxes("wall");
  check("マーカー座標系: 壁のマーカーは Y = 上・Z = 部屋側（単位行列）", ax.y.join() === "0,1,0" && ax.z.join() === "0,0,1" && ax.x.join() === "1,0,0");
  // マーカーの 1.2m 正面・同じ高さからマーカーを見る合成カメラ（カメラ → field）。カメラのワールド姿勢は単位行列（ジャイロの初期）
  const camToField = fakeCameraToField([0, 0, 1.2], 0, 0);
  const fieldToCam = invertRigid(camToField);
  // POSIT が 20° 傾いて推定した場合（X 軸まわり）: 水平化で Y 軸がワールドの上に戻る
  const t = 20 * DEG;
  const tilt = [1, 0, 0, 0, 0, Math.cos(t), Math.sin(t), 0, 0, -Math.sin(t), Math.cos(t), 0, 0, 0, 0, 1];
  const observed = mulMat4(fieldToCam, tilt);
  const level = levelRotation(observed, [0, 1, 0]);
  check("水平化: アンカー（マーカー座標系）の Y 軸 = ワールドの上（傾いた推定でも）", near(level[4], 0) && near(level[5], 1) && near(level[6], 0));
  check("水平化: マーカー座標系の Z（部屋側）は水平でカメラの方を向く", near(level[9], 0) && level[10] > 0.99);
  // 頭（カメラ）の姿勢をマーカー座標系で表すと位置は +Z 側、正面を見た体の向きは −Z → 化身は +Z 側（壁と反対）に立つ
  const headInField = transformPoint(camToField, [0, 0, 0]);
  check("マーカーを正面に見る人の頭は +Z 側（z = 1.2）", near(headInField[2], 1.2) && near(headInField[1], 0));
  const frame = { head: headInField, yaw: yawOfForward(bodyForward([0, 0, 0, 1])), eyeH: 1.5, back: 0.8, cutY: 2.77, scale: 0.6, riseM: 0, leanDeg: 0 };
  check("その人の化身は壁と反対側（z > 頭の z）に立つ", keshinModelToWorld(frame, [0, 0, 0])[2] > headInField[2] + 0.5);
}

// ================= 2c. 段階 2: 相手の化身の配置・なめらかさ・信用度・人の形のマスク =================
{
  // 自分のアンカー: ワールドの (0.4, 1.6, −1.0) にあり、ヨー 30°（重力で水平化済み）
  const anchorPos = [0.4, 1.6, -1.0];
  const anchorQuat = qAxis(0, 1, 0, 30);
  // 相手の申告（マーカー座標系）: 頭 (−0.4, 0.05, 1.3)、体の向き（マーカーの方 = −Z から少し右）
  const head = [-0.4, 0.05, 1.3];
  const fwdM = [0.29, -0.957];
  const hw = markerToWorld(anchorPos, anchorQuat, head);
  const c = Math.cos(30 * DEG);
  const sn = Math.sin(30 * DEG);
  // ヨー 30°: x' = c x + s z、z' = −s x + c z
  const expectHead = [0.4 + c * head[0] + sn * head[2], 1.6 + head[1], -1.0 - sn * head[0] + c * head[2]];
  check("相手の頭: マーカー座標系 → 自分のワールド（アンカーの位置 + ヨー回転）", hw.every((v, i) => near(v, expectHead[i], 1e-9)), JSON.stringify(hw));
  const yaw = markerFwdToWorldYaw(anchorQuat, fwdM);
  const fwdW = [c * fwdM[0] + sn * fwdM[1], -sn * fwdM[0] + c * fwdM[1]];
  check("相手の体の向き: マーカー座標系の水平 → 自分のワールドのヨー", near(Math.sin(yaw), fwdW[0] / Math.hypot(...fwdW), 1e-9) && near(Math.cos(yaw), fwdW[1] / Math.hypot(...fwdW), 1e-9));
  // その頭と向きで置いた化身: 原点は頭の背後（体の向きの逆）、正面 +Z は体の向き
  const frame = { head: hw, yaw, eyeH: 1.5, back: 1.05, cutY: 1.72, scale: 0.6, riseM: 0, leanDeg: 0 };
  const o = keshinModelToWorld(frame, [0, 0, 0]);
  const z1 = keshinModelToWorld(frame, [0, 0, 1]);
  const f = [Math.sin(yaw), Math.cos(yaw)];
  const behind = (o[0] - hw[0]) * f[0] + (o[2] - hw[2]) * f[1];
  const frontDir = [(z1[0] - o[0]) / 0.6, (z1[2] - o[2]) / 0.6];
  check("相手の化身: 頭の背後 1.05m・同じ向き（自分のワールドで）", near(behind, -1.05, 1e-9) && near(frontDir[0], f[0], 1e-9) && near(frontDir[1], f[1], 1e-9), `behind=${behind.toFixed(3)}`);
  check("相手の化身: 足元 = 相手の頭 − eyeH", near(o[1], hw[1] - 1.5, 1e-9));

  // なめらかさ（持つ状態は表示中の値だけ）
  const first = smoothToward(null, [1, 2, 3], 0.016, 0.25, 3);
  check("smoothToward: 最初は目標へ即座に置く", first.snapped && first.pos.join() === "1,2,3");
  let shown = [0, 0, 0];
  let maxStep = 0;
  for (let i = 0; i < 60; i++) {
    const r = smoothToward(shown, [1.6, 0, 0], 1 / 60, 0.25, 3);
    maxStep = Math.max(maxStep, Math.hypot(r.pos[0] - shown[0], r.pos[1] - shown[1], r.pos[2] - shown[2]));
    shown = r.pos;
  }
  check("smoothToward: 1.6m の跳び（マーカーの見直し）は時定数 0.25s で寄る（1s 後に 98%・行き過ぎない）", near(shown[0], 1.6 * (1 - Math.exp(-4)), 1e-9) && shown[0] <= 1.6, shown[0].toFixed(4));
  check("smoothToward: 1 フレーム（60fps）の動きは跳びの 7% 以下", maxStep <= 1.6 * (1 - Math.exp(-1 / 15)) + 1e-9, maxStep.toFixed(4));
  const far = smoothToward([0, 0, 0], [3.2, 0, 0], 1 / 60, 0.25, 3);
  check("smoothToward: snapM（3m）以上離れたら即座に移す・差を返す", far.snapped && far.pos[0] === 3.2 && near(far.gap, 3.2));
  const g = smoothToward([0, 0, 0], [0, 0.3, 0.4], 1 / 60, 0.25, 3);
  check("smoothToward: 跳びの大きさ gap = 目標と表示の差", near(g.gap, 0.5) && !g.snapped);
  check("smoothToward: 時定数 0 なら平滑化なし", smoothToward([0, 0, 0], [1, 0, 0], 0.01, 0, 3).pos[0] === 1);

  // 信用度による表示
  const o2 = { noPoseMs: 1000, lostMs: 5000, staleMs: 3000 };
  const mk = { track: "marker", ageMs: 0 };
  check("表示: 自分のアンカーが無いと描かない", remoteDisplay(false, mk, 100, o2).draw === false && remoteDisplay(false, mk, 100, o2).reason === "self-no-anchor");
  check("表示: marker は通常（薄さ 1）", (() => { const r = remoteDisplay(true, mk, 100, o2); return r.draw && r.fade === 1 && !r.freeze; })());
  check("表示: gyro 1.5s は 0.75 の薄さ", near(remoteDisplay(true, { track: "gyro", ageMs: 1400 }, 100, o2).fade, 0.75));
  check("表示: gyro が staleMs を過ぎたら 0.5 で位置を止める", (() => { const r = remoteDisplay(true, { track: "gyro", ageMs: 3500 }, 100, o2); return r.draw && r.fade === 0.5 && r.freeze; })());
  check("表示: marker でも 2 秒次が来なければ gyro 扱い（2s → 0.667）", (() => { const r = remoteDisplay(true, mk, 2000, o2); return r.track === "gyro" && near(r.fade, 1 - 0.5 * 2000 / 3000); })());
  check("表示: none・pose 無しは描かない", remoteDisplay(true, { track: "none", ageMs: null }, 0, o2).reason === "peer-none" && remoteDisplay(true, undefined, 0, o2).reason === "no-pose");
  check("表示: pose が lostMs（5s）届かない = 通信切れは描かない", (() => { const r = remoteDisplay(true, mk, 5001, o2); return !r.draw && r.reason === "lost"; })());
  // 長く見失った相手（stage2-fix2 の 2）: gyro の経過が staleHideMs（8s）を超えたら HIDE_FADE_MS（0.8s）かけて消し、以降は描かない
  const o3 = { ...o2, staleHideMs: 8000 };
  const gy = (age) => remoteDisplay(true, { track: "gyro", ageMs: age }, 100, o3);
  check("消す: gyro 7.9s（staleHideMs 手前）は今までどおり 0.5 の薄さで描く", (() => { const r = gy(7800); return r.draw && r.fade === 0.5 && r.reason === "ok" && r.freeze; })());
  check("消す: 超えた直後はフェード中（0.4s で 0.25 = 半分の半分・reason=stale-hiding）", (() => { const r = gy(8300); return r.draw && near(r.fade, 0.25) && r.reason === "stale-hiding"; })(), JSON.stringify(gy(8300)));
  check("消す: フェードは経過に対して単調に下がる（途中で戻らない）", (() => { let prev = 1; for (let a = 7000; a <= 9000; a += 50) { const f = gy(a - 100).fade; if (f > prev + 1e-12) return false; prev = f; } return true; })());
  check("消す: 8.8s 以降は描かない（reason=stale）。40s（実機の B）も同じ", (() => { const a = gy(8800); const b = gy(39800); return !a.draw && a.reason === "stale" && a.fade === 0 && !b.draw && b.reason === "stale"; })());
  check("消す: マーカーを見直した pose（marker）が届けばまた描く（状態を持たない）", (() => { const r = remoteDisplay(true, { track: "marker", ageMs: 0 }, 50, o3); return r.draw && r.fade === 1 && r.reason === "ok"; })());
  check("消す: marker の pose が途絶えて gyro 扱いになった経過（sinceMs）でも同じく消す", (() => { const r = remoteDisplay(true, { track: "marker", ageMs: 0 }, 4900, { ...o3, staleHideMs: 3000 }); return !r.draw && r.reason === "stale"; })());
  check("消す: staleHideMs を渡さなければ（俯瞰画面）今までどおり 0.5 のまま", (() => { const r = remoteDisplay(true, { track: "gyro", ageMs: 39800 }, 100, o2); return r.draw && r.fade === 0.5; })());

  // 人の形のマスクの座標: 背景と同じ UV 変換（cover・camZoom）で、眼ごとのビューポートの中の位置から出す
  const cov = coverUvTransform(16 / 9, 640 / 720, 1);
  check("cover: 横長の映像を縦長の片目に → 横を切り抜く（repeat.x < 1、縦は 1）", near(cov.repeat[0], (640 / 720) / (16 / 9)) && cov.repeat[1] === 1 && near(cov.offset[0], (1 - cov.repeat[0]) / 2) && cov.offset[1] === 0);
  const L = [0, 0, 640, 720];
  const R = [640, 0, 640, 720];
  const cL = maskUvFromFragment([320, 360], L, cov.repeat, cov.offset);
  const cR = maskUvFromFragment([960, 360], R, cov.repeat, cov.offset);
  check("マスクの座標: 左右の眼の中心はどちらも画像の中心（0.5, 0.5）", near(cL[0], 0.5) && near(cL[1], 0.5) && near(cR[0], 0.5) && near(cR[1], 0.5));
  const edge = maskUvFromFragment([0, 720], L, cov.repeat, cov.offset);
  check("マスクの座標: 眼の左上の角 = 切り抜いた範囲の左端・画像の上端（マスクは左上原点）", near(edge[0], cov.offset[0]) && near(edge[1], 0), JSON.stringify(edge));
  const bot = maskUvFromFragment([640 + 639.5, 0.5], R, cov.repeat, cov.offset);
  check("マスクの座標: 右の眼の右下 = 切り抜いた範囲の右端・画像の下端", near(bot[0], cov.offset[0] + cov.repeat[0] * (639.5 / 640)) && near(bot[1], 1 - 0.5 / 720));
  const zoom = coverUvTransform(16 / 9, 640 / 720, 0.7);
  check("camZoom 0.7（広く表示）: 背景の上下の縁は映像の外（縦は切り抜いていないので余白）→ マスクの外（null）", maskUvFromFragment([320, 1], L, zoom.repeat, zoom.offset) === null && maskUvFromFragment([320, 719], L, zoom.repeat, zoom.offset) === null && maskUvFromFragment([320, 360], L, zoom.repeat, zoom.offset) !== null);
  const zc = maskUvFromFragment([320 + 64, 360 + 72], L, zoom.repeat, zoom.offset);
  check("camZoom 0.7: 中心からのずれは 1/0.7 倍に広がる", near(zc[0] - 0.5, 0.1 * zoom.repeat[0], 1e-9) && near(0.5 - zc[1], 0.1 * zoom.repeat[1], 1e-9));
  const tall = coverUvTransform(3 / 4, 640 / 720, 1);
  check("cover: 縦長の映像（3:4）→ 縦を切り抜く（repeat.y < 1）", tall.repeat[0] === 1 && near(tall.repeat[1], (3 / 4) / (640 / 720)));
  // シェーダーは uMaskUv に three の texture.matrix（offset / repeat から updateMatrix）を入れる。それが p × repeat + offset と同じこと
  const tex = new THREE.Texture();
  tex.repeat.set(zoom.repeat[0], zoom.repeat[1]);
  tex.offset.set(zoom.offset[0], zoom.offset[1]);
  tex.updateMatrix();
  const pv = new THREE.Vector3(0.3, 0.8, 1).applyMatrix3(tex.matrix);
  const mu = maskUvFromFragment([0.3 * 640, 0.8 * 720], L, zoom.repeat, zoom.offset);
  check("three の texture.matrix（背景と同じ変換）でも同じ座標になる（上下の反転だけ違う）", near(pv.x, mu[0], 1e-9) && near(1 - pv.y, mu[1], 1e-9));
}

// ================= 2c'. 共有コード: 背面の超広角だけ選ぶ（stage2-fix2 の 1。iPad で「前面超広角カメラ」が選ばれていた）=================
{
  const cam = (label, id = label) => ({ kind: "videoinput", label, deviceId: id });
  const mic = { kind: "audioinput", label: "iPhone マイク", deviceId: "mic" };
  const iphoneJa = [cam("前面カメラ"), cam("背面カメラ"), cam("背面超広角カメラ", "uw"), cam("背面デュアル広角カメラ"), cam("背面望遠カメラ"), mic];
  const r1 = pickBackUltraWide(iphoneJa);
  check("カメラ選び: iPhone（日本語）→ 背面超広角カメラ", r1.device?.deviceId === "uw" && r1.reason === "back-ultra-wide", JSON.stringify(r1));
  const iphoneEn = [cam("Front Camera"), cam("Back Camera"), cam("Back Ultra Wide Camera", "uw"), cam("Back Dual Wide Camera"), cam("Back Triple Camera")];
  const r2 = pickBackUltraWide(iphoneEn);
  check("カメラ選び: iPhone（英語）→ Back Ultra Wide Camera", r2.device?.deviceId === "uw", JSON.stringify(r2));
  // 前面の超広角（Center Stage 対応の iPad）が先に並んでいても背面を選ぶ
  const both = [cam("Front Ultra Wide Camera", "fuw"), cam("Back Ultra Wide Camera", "buw")];
  check("カメラ選び: 前面と背面の超広角があれば背面（前面が先に並んでいても）", pickBackUltraWide(both).device?.deviceId === "buw");
  const ipadJa = [cam("前面超広角カメラ", "fuw"), cam("背面カメラ")];
  const r3 = pickBackUltraWide(ipadJa);
  check("カメラ選び: iPad（超広角が前面だけ「前面超広角カメラ」）→ 選ばない（facingMode: environment のまま）", r3.device === null && r3.reason.startsWith("front-only"), JSON.stringify(r3));
  const ipadEn = [cam("Front Ultra Wide Camera", "fuw"), cam("Back Camera")];
  check("カメラ選び: iPad（英語 Front Ultra Wide Camera）→ 選ばない", pickBackUltraWide(ipadEn).device === null);
  const none = [cam("前面カメラ"), cam("背面カメラ"), cam("FaceTime HD Camera")];
  const r4 = pickBackUltraWide(none);
  check("カメラ選び: 超広角が無い → 選ばない（reason=no-ultra-wide）", r4.device === null && r4.reason === "no-ultra-wide");
  check("カメラ選び: 許可前（ラベルが空）→ 選ばない", pickBackUltraWide([cam(""), cam("")]).device === null);
  const unknownSide = [cam("Ultra Wide Camera", "uw")];
  const r5 = pickBackUltraWide(unknownSide);
  check("カメラ選び: 前後を名乗らない超広角は次点で選ぶ（開いた後の facingMode で確かめる）", r5.device?.deviceId === "uw" && r5.reason.startsWith("ultra-wide"), JSON.stringify(r5));
  check("カメラ選び: 音声入力は対象外", pickBackUltraWide([{ kind: "audioinput", label: "超広角", deviceId: "x" }]).device === null);
}

// ================= 2d. 段階 2: 人の形のマスク（MediaPipe の confidence mask → 1 枚の R8）=================
// MediaPipe の MPMask.getAsFloat32Array は行 0 が画像の上（vision_bundle の MPImage.getAsImageData も同じ readPixels で
// 上下を反転せずに ImageData にしているので、同じ並び）。ここでは「入力の i 番目 = 出力の i 番目」（並びを変えない）ことを確かめる
{
  const u = createMaskUniforms(3, 0.15);
  const pm = new PersonMask(u, [0.3, 0.7]);
  const w = 5;
  const h = 3;
  // 人 1: 左上の画素だけ 1.0、人 2: 右下 0.9 と中央 0.5。裾 0.2 は切れる
  const m1 = new Float32Array(w * h);
  m1[0] = 1.0;
  m1[7] = 0.2;
  const m2 = new Float32Array(w * h);
  m2[w * h - 1] = 0.9;
  m2[7] = 0.5;
  pm.setFromFloat([m1, m2], w, h);
  const px = pm.pixels;
  check("マスク: 大きさ（幅・高さ）と uniform の 1 画素（1 / 幅, 1 / 高さ）", pm.size[0] === w && pm.size[1] === h && px.length === w * h && near(u.uMaskTexel.value.x, 1 / w) && near(u.uMaskTexel.value.y, 1 / h));
  check("マスク: 並びは変えない（行 0 = 画像の上。左上は 0 番、右下は最後）", px[0] === 255 && px[w * h - 1] === 255 && px[w - 1] === 0);
  check("マスク: 裾を切る（確信度 0.2 → 0、0.5 → 中間 128 前後、0.9 → 255）", px[1] === 0 && Math.abs(px[7] - 128) <= 1 && px[w * h - 1] === 255, `mid=${px[7]}`);
  check("マスク: 複数人は画素ごとの最大（中央は人 1 の 0.2 と人 2 の 0.5 の大きい方）", px[7] > 100);
  check("マスク: 人が写っているか（127 を超える画素があるか）", pm.hasPerson === true);
  check("マスク: テクスチャは R8・1 バイト境界（幅が 4 の倍数でなくても行がずれない）", u.uMaskTex.value.format === THREE.RedFormat && u.uMaskTex.value.unpackAlignment === 1 && u.uMaskTex.value.image.width === w);
  pm.setFromFloat([new Float32Array(w * h).fill(0.25)], w, h);
  check("マスク: 裾（0.3 未満）だけなら人はいない（点状の穴を作らない）", pm.hasPerson === false && pm.pixels.every((v) => v === 0));
  pm.edge = [0.1, 0.9];
  pm.setFromFloat([new Float32Array(w * h).fill(0.5)], w, h);
  check("マスク: 裾の切り方は変えられる（?maskEdge=。0.1〜0.9 で 0.5 → 128 前後）", Math.abs(pm.pixels[0] - 128) <= 1);
  pm.setFromFloat([new Float32Array(8 * 2).fill(1)], 8, 2);
  check("マスク: 大きさが変わったらテクスチャを作り直す", pm.size[0] === 8 && pm.size[1] === 2 && u.uMaskTex.value.image.width === 8);
}

// ================= 2d'. 段階 3 の A: マスクの中身の診断・骨格から描く人の形・source の切り替え =================
{
  const zeros = new Float32Array(100);
  const st0 = maskStats([zeros]);
  check("マスクの診断: 全部 0（実機の poses=1 masks=1 person=0 の状態）→ mmax 0・mfrac 0", st0.max === 0 && st0.frac === 0 && st0.scale === 1 && st0.nan === 0);
  const nanM = new Float32Array(100).fill(NaN);
  const stN = maskStats([nanM]);
  check("マスクの診断: NaN は mnan に数える（setFromFloat では NaN は人にならない）", stN.nan === 1 && stN.max === 0);
  const half = new Float32Array(100);
  for (let i = 0; i < 30; i++) half[i] = 0.9;
  const stH = maskStats([half]);
  check("マスクの診断: 3 割が 0.9 → mmax 0.9・mfrac 0.3・mmean 0.27", near(stH.max, 0.9, 1e-6) && near(stH.frac, 0.3) && near(stH.mean, 0.27, 1e-6));
  const b255 = new Float32Array(100);
  for (let i = 0; i < 40; i++) b255[i] = 230;
  const stB = maskStats([b255]);
  check("マスクの診断: 0..255 の float で来ていたら scale = 1/255（mfrac 0.4）", near(stB.scale, 1 / 255) && near(stB.frac, 0.4));
  {
    const u = createMaskUniforms(3, 0.15);
    const pm = new PersonMask(u, [0.3, 0.7]);
    pm.setFromFloat([b255], 10, 10, stB.scale);
    check("setFromFloat: 0..255 の値も scale を掛ければ人になる（40 画素が 255）", pm.hasPerson && pm.pixels.filter((v) => v === 255).length === 40);
    pm.setFromFloat([b255], 10, 10);
    check("setFromFloat: 0..1 の想定で 0..255 を入れても人にはなる（裾を切って 1 に張り付く。実機の person=0 の原因ではない）", pm.hasPerson);
  }
  const st = (source, run = 0) => ({ source, run });
  // 修正 9: 1 回の結果では切り替えない（5 回続いたら）
  let ms = st("seg");
  const seq = [];
  for (let i = 0; i < 5; i++) {
    ms = decideMaskSource(ms, "auto", 1, 0, 0.1);
    seq.push(ms.source);
  }
  check("source: auto で人がいてマスクが空（mmax < 0.1）が 5 回続いたら skel（4 回までは seg のまま）", seq.join(",") === "seg,seg,seg,seg,skel", seq.join(","));
  let ms2 = st("skel");
  const seq2 = [];
  for (const v of [0.8, 0.8, 0.05, 0.8, 0.8, 0.8, 0.8, 0.8]) {
    ms2 = decideMaskSource(ms2, "auto", 1, v, 0.1);
    seq2.push(ms2.source);
  }
  check("source: seg に値が出るのが 5 回続いたら seg に戻す（途中で空が 1 回出たら数え直し。0.1 付近でばたつかない）", seq2.join(",") === "skel,skel,skel,skel,skel,skel,skel,seg", seq2.join(","));
  check("source: 人がいない結果では変えない・数も進めない", JSON.stringify(decideMaskSource(st("skel", 3), "auto", 0, 0, 0.1)) === JSON.stringify(st("skel", 3)) && decideMaskSource(st("seg", 2), "auto", 0, 0, 0.1).source === "seg");
  check("source: ?maskSource=seg / skel は強制（すぐ）", decideMaskSource(st("skel"), "seg", 1, 0, 0.1).source === "seg" && decideMaskSource(st("seg"), "skel", 1, 0.9, 0.1).source === "skel");
  // 修正 8: 0..255 で来て最大 5（0..1 に直すと 0.02）のときは空とみなす（生の値 5 で判定しない）
  const b5 = new Float32Array(100);
  b5[0] = 5;
  const st5 = maskStats([b5]);
  let ms5 = st("seg");
  for (let i = 0; i < 5; i++) ms5 = decideMaskSource(ms5, "auto", 1, st5.max * st5.scale, 0.1);
  check("source: 0..255 で最大 5 → 0..1 に直すと 0.02 なので skel（値の範囲の判定と source の判定を揃える）", near(st5.scale, 1 / 255) && ms5.source === "skel", `${(st5.max * st5.scale).toFixed(3)}`);
  // 骨格から描く人の形: カメラの方を向いた合成の人（2.5m）を 512×384 のマスクの座標で
  const m = { tanHalfFov: Math.tan(34 * DEG) * 0.75, eyeAspect: 4 / 3, repeatX: 1, repeatY: 1 };
  const r = fakeMirrorPose([{ head: [0, 0.2, -2.5], fwd: [0, 1] }], m);
  const lm = r.landmarks[0];
  const W = 512;
  const H = 384;
  const sh = skeletonPersonShape(lm, W, H);
  const sw = Math.hypot((lm[11].x - lm[12].x) * W, (lm[11].y - lm[12].y) * H);
  const earMid = [((lm[7].x + lm[8].x) / 2) * W, ((lm[7].y + lm[8].y) / 2) * H];
  check("骨格の人の形: 頭 = 両耳の中点の円（半径は両耳の間隔 × 0.55 か肩幅 × 0.3 の大きい方）", sh && near(sh.head.x, earMid[0], 1e-6) && near(sh.head.y, earMid[1], 1e-6) && sh.head.r >= 0.3 * sw - 1e-9, JSON.stringify(sh?.head));
  check("骨格の人の形: 胴 = 両肩・両腰の四角形（画像の座標 = 正規化座標 × マスクの大きさ）", sh && near(sh.torso[0][0], lm[11].x * W, 1e-6) && near(sh.torso[0][1], lm[11].y * H, 1e-6) && near(sh.torso[2][0], lm[24].x * W, 1e-6));
  const arm = sh?.limbs.find((l) => near(l.a[0], lm[11].x * W, 1e-6) && near(l.b[0], lm[13].x * W, 1e-6));
  const leg = sh?.limbs.find((l) => near(l.a[0], lm[23].x * W, 1e-6) && near(l.b[0], lm[25].x * W, 1e-6));
  check("骨格の人の形: 腕・脚はカプセル（太さは肩幅 × 0.32 / 0.42）・首もつなぐ", arm && leg && near(arm.w, 0.32 * sw, 1e-6) && near(leg.w, 0.42 * sw, 1e-6) && sh.limbs.length === 9, `sw=${sw.toFixed(1)}`);
  const far = skeletonPersonShape(fakeMirrorPose([{ head: [0, 0.2, -5], fwd: [0, 1] }], m).landmarks[0], W, H);
  check("骨格の人の形: 遠い人は小さく（太さも肩幅に比例して半分）", far && near(far.limbs[1].w / sh.limbs[1].w, (Math.hypot((fakeMirrorPose([{ head: [0, 0.2, -5], fwd: [0, 1] }], m).landmarks[0][11].x - fakeMirrorPose([{ head: [0, 0.2, -5], fwd: [0, 1] }], m).landmarks[0][12].x) * W, 0)) / sw, 1e-6) && far.limbs[1].w < sh.limbs[1].w * 0.6);
  check("骨格の人の形: 肩が見えなければ描かない", skeletonPersonShape(lm.map((l, i) => (i === 11 ? { ...l, visibility: 0.1 } : l)), W, H) === null);
  const noHip = skeletonPersonShape(lm.map((l, i) => (i === 23 || i === 24 ? { ...l, visibility: 0 } : l)), W, H);
  check("骨格の人の形: 腰が見えなければ肩から肩幅 × 1.3 下までを胴にする（上半身だけ写っているとき）", noHip && near(noHip.torso[3][1] - noHip.torso[0][1], 1.3 * sw, 1e-6));
}

// ================= 2g. 段階 3 の B: カメラで見た人で相手の化身の位置を決める（ハイブリッド）=================
{
  const m = { tanHalfFov: Math.tan(34 * DEG) * 0.75, eyeAspect: 4 / 3, repeatX: 1, repeatY: 1 };
  const opts = { bodyScale: 1, minVisibility: 0.5, maxDepthM: 8 };
  // カメラ（自分の目）をワールドの (1, 1.6, 2) に置き、右へ 30° 向ける（ヨー）。相手はカメラ座標で正面 2.5m・カメラの方を向く
  const yaw = 30 * DEG;
  const cam = new THREE.Matrix4().makeRotationY(yaw).setPosition(1, 1.6, 2);
  const camPts = fakeMirrorPoints({ head: [0, 0.1, -2.5], fwd: [0, 1] }).cam;
  const r = poseFromCamPoints([camPts], m);
  const det = detectionToWorld(r.landmarks[0], r.worldLandmarks[0], m, cam.elements, opts);
  const expHead = new THREE.Vector3(0, 0.1, -2.5).applyMatrix4(cam);
  check("段階 3・3D 化: カメラ座標の頭 → ジャイロの回転 + カメラの位置で自分のワールドへ（差 < 1cm・距離 2.5m）", det && Math.hypot(det.head[0] - expHead.x, det.head[1] - expHead.y, det.head[2] - expHead.z) < 0.01 && near(det.camDist, Math.hypot(0.1, 2.5), 0.01), JSON.stringify(det));
  // カメラの方（カメラ座標 +Z）を向いた人の前は、ワールドではカメラの向きを 180° 回した向き
  const expFwd = new THREE.Vector3(0, 0, 1).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  check("段階 3・3D 化: 体の向きはワールドの水平面で（カメラが右へ 30° 向いていても、相手はカメラの方）", det && Math.hypot(det.fwd[0] - expFwd.x, det.fwd[1] - expFwd.z) < 0.01 && det.fwdSource === "shoulders", JSON.stringify(det?.fwd));
  // 対応づけ
  const eye = [0, 1.6, 0];
  const dets = [{ head: [-0.5, 1.6, -2] }, { head: [0.8, 1.6, -3] }];
  const m1 = matchRemotes(dets, [{ id: "B", declared: [0.9, 1.6, -3.2], fresh: true, last: null }, { id: "C", declared: [-0.6, 1.6, -2.3], fresh: true, last: null }], eye, { matchDeg: 15, matchM: 0.5, onlyOneMaxDeg: 45 });
  check("段階 3・対応づけ: 申告の方向が一番近い人と 1 対 1（B → 右奥、C → 左手前・declared-dir）", m1.get("B")?.index === 1 && m1.get("C")?.index === 0 && m1.get("B")?.reason === "declared-dir");
  const m2 = matchRemotes(dets, [{ id: "B", declared: [0.9, 1.6, -3.2], fresh: true, last: null }, { id: "C", declared: [1.0, 1.6, -3.4], fresh: true, last: null }], eye, { matchDeg: 15, matchM: 0.5, onlyOneMaxDeg: 45 });
  check("段階 3・対応づけ: 2 人が同じ人を指しても 1 対 1（近い方だけ）", [...m2.values()].filter((v) => v.index === 1).length === 1);
  const m3 = matchRemotes(dets, [{ id: "B", declared: [3, 1.6, 1], fresh: false, last: [0.7, 1.6, -2.9] }], eye, { matchDeg: 15, matchM: 0.5, onlyOneMaxDeg: 45 });
  check("段階 3・対応づけ: 申告が古い（方向が合わない）ときは前の結果の人と位置で（tracked）", m3.get("B")?.index === 1 && m3.get("B")?.reason === "tracked");
  // 体の向き: 検出はこちら（+Z）を向いている（鼻で前後も決まる）。申告の向きも同じ
  const FW = { fwd: [0, 1], fwdFrontKnown: true };
  const m4 = matchRemotes([{ head: [0.2, 1.6, -2], ...FW }], [{ id: "B", declared: [3, 1.6, 1], fresh: false, last: null, declFwd: [0, 1] }], eye, { matchDeg: 15, matchM: 0.5, onlyOneMaxDeg: 45 });
  check("段階 3・対応づけ: 相手 1 人・検出 1 人なら、体の向きが合えば申告がずれていてもそのまま結ぶ（only-one）", m4.get("B")?.reason === "only-one");
  const m5 = matchRemotes(dets, [{ id: "B", declared: [3, 1.6, 1], fresh: false, last: null }], eye, { matchDeg: 15, matchM: 0.5, onlyOneMaxDeg: 45 });
  check("段階 3・対応づけ: 相手 1 人でも検出が 2 人で手掛かりが無ければ結ばない", !m5.has("B"));
  const m6 = matchRemotes(dets, [{ id: "B", declared: [0.85, 1.6, -3.1], fresh: false, last: null }], eye, { matchDeg: 15, matchM: 0.5, onlyOneMaxDeg: 45 });
  check("段階 3・対応づけ（修正 4）: 古い申告の方向だけでは結ばない（前回の位置が無い複数人は結ばないまま）", !m6.has("B"));
  // 修正 3: 貪欲だと成り立つ 2 組のうち 1 組を失う例（A=0°・B=10°、検出 4°・−5°、しきい値 8°）→ 全探索で 2 組
  const dirAt = (deg) => [Math.sin(deg * DEG) * 3, 1.6, -Math.cos(deg * DEG) * 3];
  const m7 = matchRemotes([{ head: dirAt(4) }, { head: dirAt(-5) }], [{ id: "A", declared: dirAt(0), fresh: true, last: null }, { id: "B", declared: dirAt(10), fresh: true, last: null }], [0, 1.6, 0], { matchDeg: 8, matchM: 0.5, onlyOneMaxDeg: 45 });
  check("段階 3・対応づけ（修正 3）: 組の数が最大になるように選ぶ（A → −5°、B → 4° の 2 組。貪欲だと A → 4° の 1 組だけ）", m7.get("A")?.index === 1 && m7.get("B")?.index === 0, JSON.stringify([...m7]));
  const m7b = matchRemotes([{ head: dirAt(2) }, { head: dirAt(9) }], [{ id: "A", declared: dirAt(0), fresh: true, last: null }, { id: "B", declared: dirAt(10), fresh: true, last: null }], [0, 1.6, 0], { matchDeg: 15, matchM: 0.5, onlyOneMaxDeg: 45 });
  check("段階 3・対応づけ: 組の数が同じなら角度の合計が最小（A → 2°、B → 9°）", m7b.get("A")?.index === 0 && m7b.get("B")?.index === 1);
  // 2 人が並び、アンカーの誤差で申告の方向が隣の人の方にずれて見える: 前回の位置（tracked）と申告の方向（declared-dir）を 1 回の全探索で
  const m9 = matchRemotes([{ head: dirAt(-20) }, { head: dirAt(10) }], [{ id: "P", declared: dirAt(5), fresh: true, last: dirAt(-20) }, { id: "Q", declared: dirAt(24), fresh: true, last: null }], [0, 1.6, 0], { matchDeg: 30, matchM: 0.5, onlyOneMaxDeg: 45 });
  check("段階 3・対応づけ: 前回の位置と申告の方向を 1 回の全探索で（P は前回の人 −20° に tracked、Q は申告の方向で 10° に。段ごとだと P が 10° を取って Q が結べない）", m9.get("P")?.index === 0 && m9.get("P")?.reason === "tracked" && m9.get("Q")?.index === 1 && m9.get("Q")?.reason === "declared-dir", JSON.stringify([...m9]));
  // 修正 5: 相手 1 人・検出 1 人でも、新しい申告と方向が大きく外れた人（プレイヤーでない人）には付けない
  const m8 = matchRemotes([{ head: dirAt(70), ...FW }], [{ id: "B", declared: dirAt(0), fresh: true, last: null, declFwd: [0, 1] }], [0, 1.6, 0], { matchDeg: 15, matchM: 0.5, onlyOneMaxDeg: 45 });
  const m8b = matchRemotes([{ head: dirAt(30), ...FW }], [{ id: "B", declared: dirAt(0), fresh: true, last: null, declFwd: [0, 1] }], [0, 1.6, 0], { matchDeg: 15, matchM: 0.5, onlyOneMaxDeg: 45 });
  const m8c = matchRemotes([{ head: dirAt(70), ...FW }], [{ id: "B", declared: dirAt(0), fresh: false, last: null, declFwd: [0, 1] }], [0, 1.6, 0], { matchDeg: 15, matchM: 0.5, onlyOneMaxDeg: 45 });
  check("段階 3・対応づけ（修正 5）: only-one は新しい申告と 45° 以内のときだけ（70° は結ばない・30° は結ぶ・申告が古ければ結ぶ）", !m8.has("B") && m8b.get("B")?.reason === "only-one" && m8c.get("B")?.reason === "only-one");
  // ---- 実機の不具合（2026-09-28）: 化身を出していない人 1 人だけが映ると、申告が古いときは only-one でその人に付き、その差を補正として学んでいた ----
  {
    const E = [0, 1.6, 0];
    const O = { matchDeg: 15, matchM: 0.5, onlyOneMaxDeg: 45, facingMaxDeg: 60, corrGateM: 1.5 };
    const yawV = (deg) => [Math.sin(deg * DEG), Math.cos(deg * DEG)];
    // 申告は古い（壁を見てから 30 秒）。申告の体の向きは 0°（+Z）。映った人は正面 2.5m
    const R = (extra = {}) => ({ id: "B", declared: [2, 1.6, 1], fresh: false, last: null, declFwd: yawV(0), ...extra });
    const det = (fwdDeg, frontKnown = true, head = [0, 1.6, -2.5]) => ({ head, fwd: yawV(fwdDeg), fwdFrontKnown: frontKnown });
    const d90 = matchRemotesDiag([det(90)], [R()], E, O);
    check("段階 3・体の向き: 向きが 90° 違う 1 人には only-one で結ばない（理由 facing・値 90°）", !d90.matches.has("B") && d90.info.get("B").reject === "facing" && near(d90.info.get("B").facingDeg[0], 90, 1e-6), JSON.stringify(d90.info.get("B")));
    const d20 = matchRemotesDiag([det(20)], [R()], E, O);
    check("段階 3・体の向き: 向きが合う人（20° = アンカーの誤差の範囲）には only-one で結ぶ", d20.matches.get("B")?.reason === "only-one" && d20.info.get("B").reject === null);
    const d55 = matchRemotesDiag([det(55)], [R()], E, O);
    const d65 = matchRemotesDiag([det(65)], [R()], E, O);
    check("段階 3・体の向き: しきい値は ?facingMaxDeg=60（55° は結ぶ・65° は結ばない）", d55.matches.has("B") && !d65.matches.has("B"));
    // 顔が隠れて前後が決まらない（背中から見た・ゴーグル）: 線の向きだけで比べる（180° 反対でも同じ線 = 0°、90° は 90°）
    const back = matchRemotesDiag([det(180, false)], [R()], E, O);
    const side = matchRemotesDiag([det(90, false)], [R()], E, O);
    const backKnown = matchRemotesDiag([det(180, true)], [R()], E, O);
    check("段階 3・体の向き: 前後が決まらない人は線の向きだけで比べる（180° 反対は結ぶ・90° は結ばない）。前後が決まる人の 180° 反対は結ばない", back.matches.get("B")?.reason === "only-one" && near(back.info.get("B").facingDeg[0], 0, 1e-6) && !side.matches.has("B") && !backKnown.matches.has("B"));
    check("段階 3・体の向き: 向きの差の式（線の向きだけなら 0〜90）", near(facingDiffDeg([0, 1], [1, 0], false), 90, 1e-9) && near(facingDiffDeg([0, 1], [0, -1], false), 180, 1e-9) && near(facingDiffDeg([0, 1], [0, -1], true), 0, 1e-9) && near(facingDiffDeg([0, 1], yawV(135), true), 45, 1e-9));
    const noFwd = matchRemotesDiag([det(0)], [R({ declFwd: null })], E, O);
    check("段階 3・体の向き: 申告の向きが無い（自分のアンカーが無い）と比べられないので only-one で結ばない（理由 no-facing）", !noFwd.matches.has("B") && noFwd.info.get("B").reject === "no-facing");
    // 初めての tracked（前回の結果では結んでいない = 見失っていた人の近く）にも関門を掛ける。続けて追いかけている tracked には掛けない
    const trNew = matchRemotesDiag([det(90)], [R({ last: [0.1, 1.6, -2.5], continuing: false })], E, O);
    const trCont = matchRemotesDiag([det(90)], [R({ last: [0.1, 1.6, -2.5], continuing: true })], E, O);
    check("段階 3・体の向き: 初めての tracked は向きが 90° 違えば結ばない・続けて追いかけている tracked は結んだまま（振り向く途中で手放さない）", !trNew.matches.has("B") && trNew.info.get("B").reject === "facing" && trCont.matches.get("B")?.reason === "tracked");
    // declared-dir にも掛ける
    const dd = matchRemotesDiag([det(90, true, [0, 1.6, -2.5])], [R({ declared: [0.1, 1.6, -2.4], fresh: true })], E, { ...O, onlyOneMaxDeg: 45 });
    check("段階 3・体の向き: 申告の方向が合っても（declared-dir）、向きが 90° 違えば結ばない", !dd.matches.has("B") && dd.info.get("B").reject === "facing");
    // 補正の関門: 補正を学べている相手は、申告 + 補正から 1.5m を超えて離れた人に結ばない
    const cgFar = matchRemotesDiag([det(0, true, [0, 1.6, -2.5])], [R({ corrPred: [2.2, 1.6, -2.5] })], E, O);
    const cgNear = matchRemotesDiag([det(0, true, [0, 1.6, -2.5])], [R({ corrPred: [0.8, 1.6, -2.2] })], E, O);
    check("段階 3・補正の関門: 申告 + 補正から 2.2m 離れた人には結ばない（理由 corr-gate）・0.85m なら結ぶ", !cgFar.matches.has("B") && cgFar.info.get("B").reject === "corr-gate" && near(cgFar.info.get("B").corrM[0], 2.2, 1e-9) && cgNear.matches.get("B")?.reason === "only-one", JSON.stringify(cgFar.info.get("B")));
    // 2 人: 向きの合う方にだけ結ぶ（declared-dir の候補が両方にあっても）
    const two = matchRemotesDiag([det(90, true, [-0.2, 1.6, -2.5]), det(10, true, [0.2, 1.6, -2.5])], [R({ declared: [0, 1.6, -2.5], fresh: true })], E, O);
    check("段階 3・体の向き: 方向で両方が候補でも、向きの合う人に結ぶ", two.matches.get("B")?.index === 1 && two.matches.get("B")?.reason === "declared-dir", JSON.stringify([...two.matches]));
    check("段階 3・判断に使った値: 検出ごとの向きの差と補正からの距離（無ければ null）", two.info.get("B").facingDeg.length === 2 && near(two.info.get("B").facingDeg[0], 90, 1e-6) && two.info.get("B").corrM.every((v) => v === null));
  }
  // ---- Codex の指摘（中）: 自分のアンカーが跳んだ直後に本人を見失うと、補正の関門が本人を断っていた（最大約 10 秒）----
  {
    const E = [0, 1.6, 0];
    const O = { matchDeg: 15, matchM: 0.5, onlyOneMaxDeg: 45, facingMaxDeg: 60, corrGateM: 1.5 };
    const yawV = (deg) => [Math.sin(deg * DEG), Math.cos(deg * DEG)];
    const det = (fwdDeg, head) => ({ head, fwd: yawV(fwdDeg), fwdFrontKnown: true });
    // 本人 B は自分のワールドの T に立つ（カメラで見た位置。アンカーに依らない）。申告 D（マーカー座標系）は 1m ずれていて、見えていた間にその差を補正として学んだ
    const T = [0, 1.6, -2.5];
    const qId = [0, 0, 0, 1];
    const A0 = { pos: [0, 0, 0], quat: qId };
    const D = [1, 1.6, -2.5];
    const corr = [];
    for (let t = 0; t < 3000; t += 100) {
      const hm = worldToMarker(A0.pos, A0.quat, T);
      corr.push({ t, c: [hm[0] - D[0], hm[1] - D[1], hm[2] - D[2]] });
    }
    // 見失った直後（3.1 秒）に自分のアンカーが 2.2m 跳ぶ（マーカーを見直した。Δ = 2.2m）
    const A1 = { pos: [2.2, 0, 0], quat: qId };
    const now = 4000;
    const c = correctionAt(corr, now, 3, 10, 0.5, 2900);
    const predOld = markerToWorld(A1.pos, A1.quat, [D[0] + c.raw[0], D[1] + c.raw[1], D[2] + c.raw[2]]);
    const R = (extra = {}) => ({ id: "B", declared: markerToWorld(A1.pos, A1.quat, D), fresh: false, last: null, declFwd: yawV(0), corrPred: predOld, ...extra });
    const d = Math.hypot(predOld[0] - T[0], predOld[1] - T[1], predOld[2] - T[2]);
    // 修正前と同じ条件（前回の頭の位置が無い = 再捕捉が効かない）なら、学んだ補正の予測が 2.2m ずれて本人を corr-gate で断る
    const before = matchRemotesDiag([det(0, T)], [R()], E, O);
    check("段階 3・アンカーの跳び（再現）: 古い補正の予測は本人から 2.2m ずれ、関門だけなら本人を断る（corr-gate）", near(d, 2.2, 1e-9) && !before.matches.has("B") && before.info.get("B").reject === "corr-gate", `d=${d.toFixed(3)} ${JSON.stringify(before.info.get("B"))}`);
    // b: 前回結んだ頭の位置（自分のワールド）から matchM 以内で向きも合う人なら、関門を掛けずに結ぶ（tracked）
    const lastT = [T[0] + 0.1, T[1], T[2] + 0.05];
    const re = matchRemotesDiag([det(10, T)], [R({ last: lastT, continuing: false })], E, O);
    check("段階 3・アンカーの跳びの後に見失い、本人がまた映った: 前回の頭の位置から 0.5m 以内・向きが合えば補正の関門を掛けずにすぐ結ぶ（tracked）", re.matches.get("B")?.reason === "tracked" && re.info.get("B").reject === null, JSON.stringify([...re.matches]));
    // 別の人は今までどおり断る: 同じ所でも向きが 90° 違う人（facing）・前回の位置から離れた所の人（corr-gate）
    const other = matchRemotesDiag([det(90, T)], [R({ last: lastT, continuing: false })], E, O);
    const farOther = matchRemotesDiag([det(0, [-1.2, 1.6, -2.5])], [R({ last: lastT, continuing: false })], E, O);
    check("段階 3・アンカーの跳びの後: 前回の位置でも向きが 90° 違う人は結ばない（facing）・前回の位置から離れた人は補正の関門で結ばない（corr-gate）", !other.matches.has("B") && other.info.get("B").reject.split("+").includes("facing") && !farOther.matches.has("B") && farOther.info.get("B").reject === "corr-gate", JSON.stringify({ other: other.info.get("B").reject, far: farOther.info.get("B").reject }));
    // a: 自分のアンカーが跳んだら補正の窓を捨てる（remote-keshins.ts の resetCorrections）→ 予測が無くなり、前回の位置が古くても（3 秒超）only-one で本人に結ぶ
    const cleared = correctionAt([], now, 3, 10, 0.5, 2900);
    const reset = matchRemotesDiag([det(0, T)], [R({ corrPred: cleared.n > 0 && cleared.k > 0 ? predOld : null })], E, O);
    check("段階 3・アンカーの跳び: 補正の窓を捨てれば、前回の位置が無くても本人に結ぶ（only-one）", cleared.n === 0 && reset.matches.get("B")?.reason === "only-one", JSON.stringify([...reset.matches]));
  }
  // ---- Codex の指摘（中）: 自分のアンカーが無いうちは、相手 1 人・検出 1 人でも向きを比べられず化身が出なかった（no-facing）----
  {
    const E = [0, 1.6, 0];
    const O = { matchDeg: 15, matchM: 0.5, onlyOneMaxDeg: 45, facingMaxDeg: 60, corrGateM: 1.5 };
    const yawV = (deg) => [Math.sin(deg * DEG), Math.cos(deg * DEG)];
    const det = (fwdDeg, head = [0, 1.6, -2.5]) => ({ head, fwd: yawV(fwdDeg), fwdFrontKnown: true });
    // アンカーが無い: 申告を自分のワールドに直せない（declared / declFwd = null）
    const noA = (extra = {}) => ({ id: "B", declared: null, fresh: false, last: null, declFwd: null, on: true, ...extra });
    const u = matchRemotesDiag([det(90)], [noA()], E, { ...O, selfAnchor: false });
    check("段階 3・アンカーなし: 化身を出している相手 1 人・検出 1 人なら、向きを確かめずに結ぶ（only-one-unchecked）", u.matches.get("B")?.reason === "only-one-unchecked" && u.info.get("B").reject === null, JSON.stringify([...u.matches]));
    const u2 = matchRemotesDiag([det(0)], [noA(), noA({ id: "C", on: false })], E, { ...O, selfAnchor: false });
    const u3 = matchRemotesDiag([det(0)], [noA(), noA({ id: "C" })], E, { ...O, selfAnchor: false });
    const u4 = matchRemotesDiag([det(0), det(0, [1, 1.6, -2.5])], [noA()], E, { ...O, selfAnchor: false });
    check("段階 3・アンカーなし: 化身を出している相手が 1 人なら（出していない相手がいても）結ぶ・2 人か検出が 2 人なら結ばない", u2.matches.get("B")?.reason === "only-one-unchecked" && !u2.matches.has("C") && u3.matches.size === 0 && u4.matches.size === 0, JSON.stringify({ u2: [...u2.matches], u3: [...u3.matches], u4: [...u4.matches] }));
    // アンカーができた後は、今の向きの関門に戻る
    const withA = (extra = {}) => ({ id: "B", declared: [2, 1.6, 1], fresh: false, last: null, declFwd: yawV(0), on: true, ...extra });
    const a90 = matchRemotesDiag([det(90)], [withA()], E, { ...O, selfAnchor: true });
    const a10 = matchRemotesDiag([det(10)], [withA()], E, { ...O, selfAnchor: true });
    check("段階 3・アンカーあり: 向きが 90° 違えば結ばない（facing）・合えば only-one（今の関門）", !a90.matches.has("B") && a90.info.get("B").reject === "facing" && a10.matches.get("B")?.reason === "only-one", JSON.stringify({ a90: a90.info.get("B").reject, a10: [...a10.matches] }));
    const aNoFwd = matchRemotesDiag([det(0)], [withA({ declFwd: null })], E, { ...O, selfAnchor: true });
    check("段階 3・アンカーあり: 相手の向きが無ければ今までどおり結ばない（no-facing）", !aNoFwd.matches.has("B") && aNoFwd.info.get("B").reject === "no-facing");
  }
  check("段階 3・対応づけ: 方向の角度（目から見て）", near(angleFromEyeDeg([0, 0, 0], [1, 0, 0], [0, 0, -1]), 90, 1e-9));
  // 距離の混ぜ方
  check("段階 3・距離: 申告が新しければ 申告 × 0.7 + カメラ × 0.3", near(blendDistance(3, 2, true, 0.7), 2.3));
  check("段階 3・距離: 申告が古い・無いならカメラの推定", blendDistance(3, 2, false, 0.7) === 3 && blendDistance(3, null, true, 0.7) === 3);
  const hh = hybridHead([0, 1.6, 0], [0, 1.6, -3], [1, 1.6, -2], true, 0.7);
  check("段階 3・位置: 方向はカメラの値（真っすぐ前）・距離は混ぜた値（申告までの √5 × 0.7 + 3 × 0.3）", near(hh[0], 0) && near(hh[1], 1.6) && near(-hh[2], Math.sqrt(5) * 0.7 + 0.9, 1e-9), JSON.stringify(hh));
  // 補正の窓の平均と外れ値
  const base = [0.5, 0, -0.3];
  const samples = [];
  for (let i = 0; i < 20; i++) samples.push({ t: 1000 + i * 100, c: [base[0] + (i % 3 - 1) * 0.01, base[1] + (i % 2) * 0.01, base[2] - (i % 4) * 0.005] });
  const clean = robustMeanV3(samples.map((x) => x.c));
  const withJump = [...samples.slice(0, 10), { t: 2050, c: [2.5, 0, 1.5] }, ...samples.slice(10)];
  const jumped = robustMeanV3(withJump.map((x) => x.c));
  check("段階 3・補正: 跳びが 1 回入っても平均が動かない（外れ値を除く。差 < 5mm・使った件数 20）", Math.hypot(jumped.mean[0] - clean.mean[0], jumped.mean[1] - clean.mean[1], jumped.mean[2] - clean.mean[2]) < 0.005 && jumped.used === 20, JSON.stringify({ clean: clean.mean, jumped: jumped.mean, used: jumped.used }));
  const pr = pruneCorr([{ t: -500, c: [9, 9, 9] }, ...samples], 3);
  check("段階 3・補正: 窓（最後の観測から 3 秒）より古い観測は捨てる", pr.length === 20 && pr[0].t === 1000);
  const lastT = samples[samples.length - 1].t;
  const c0 = correctionAt(samples, lastT, 3, 10);
  const c5 = correctionAt(samples, lastT + 5000, 3, 10);
  const c10 = correctionAt(samples, lastT + 10000, 3, 10);
  check("段階 3・補正の弱まり: 見えなくなった直後は 1 倍、5 秒で 0.5 倍、10 秒で 0（線形）", near(c0.k, 1) && near(c5.k, 0.5) && c10.k === 0 && near(c5.c[0], c0.c[0] * 0.5, 1e-9) && c10.c[0] === 0 && c5.n === 20);
  check("段階 3・補正: 観測が無ければ 0", correctionAt([], 0, 3, 10).k === 0 && correctionAt([], 0, 3, 10).n === 0);
  // 画面の端での出入り: 見えている間の位置（ハイブリッド）と、見えなくなった瞬間の位置（申告 + 補正）が同じ → 表示が飛ばない
  {
    const q = [0, Math.sin(0.2), 0, Math.cos(0.2)];
    const aPos = [0.3, 1.4, 3.6];
    const declMarker = [1.2, 0.1, 2.0];
    const eye2 = [0.2, 1.5, 0.3];
    const camHeadWorld = [-0.4, 1.55, -1.8];
    const declWorld = markerToWorld(aPos, q, declMarker);
    const corrS = [];
    let visHead = null;
    for (let i = 0; i < 15; i++) {
      // カメラの推定は ±2cm ぶれる
      const noisy = [camHeadWorld[0] + ((i * 7) % 5 - 2) * 0.01, camHeadWorld[1], camHeadWorld[2] + ((i * 3) % 5 - 2) * 0.01];
      visHead = hybridHead(eye2, noisy, declWorld, false, 0.7);
      const hm = worldToMarker(aPos, q, visHead);
      corrS.push({ t: i * 100, c: [hm[0] - declMarker[0], hm[1] - declMarker[1], hm[2] - declMarker[2]] });
    }
    const cc = correctionAt(corrS, 1400, 3, 10);
    const hidden = markerToWorld(aPos, q, [declMarker[0] + cc.c[0], declMarker[1] + cc.c[1], declMarker[2] + cc.c[2]]);
    const jump = Math.hypot(hidden[0] - visHead[0], hidden[1] - visHead[1], hidden[2] - visHead[2]);
    const declJump = Math.hypot(declWorld[0] - visHead[0], declWorld[1] - visHead[1], declWorld[2] - visHead[2]);
    check("段階 3・画面の端: 見えなくなった瞬間の位置（申告 + 補正）と見えていた位置の差は 3cm 以内（補正なしなら申告まで跳ぶ）", jump < 0.03 && declJump > 1, `jump=${jump.toFixed(3)}m 補正なし=${declJump.toFixed(2)}m`);
  }
}

// ================= 2h. 段階 3 の B（修正 1・2・6・7・11）: RemoteKeshins.plan の中身（planRemote）を時刻を進めて通す =================
{
  // 自分のアンカーは単位（マーカー座標系 = ワールド）。目 E、相手の本当の頭 T、申告 D（1m ずれ）
  const anchorI = { pos: [0, 0, 0], quat: [0, 0, 0, 1] };
  const E = [0, 1.6, 3];
  const D = [0.5, 1.6, 1];
  const dispOpts = { noPoseMs: 1000, lostMs: 5000, staleMs: 3000, staleHideMs: 8000 };
  const planOpts = { distW: 0.7, corrWindowSec: 3, corrDecaySec: 10, corrRecentSec: 0.5, cameraFadeMs: 200, ...dispOpts };
  /**
   * 60fps で時刻を進める。visible(t) = その時刻の Pose の結果（10Hz）に写っているか、trueHead(t) = 本当の頭。
   * declared = 申告（track と ageMs。100ms ごとに届く）。表示は smoothToward（0.25s・3m）で寄せる（RemoteKeshins.update と同じ）
   */
  const simulate = ({ mode = "hybrid", durMs, visible, trueHead, declared, selfFresh = true, opts = {} }) => {
    const frames = [];
    let shown = null;
    let corr = [];
    let lastResult = -Infinity;
    let cam = null;
    let camAt = -Infinity;
    let lastSeen = -Infinity;
    let lastHead = null;
    let frozen = null;
    for (let t = 0; t <= durMs; t += 1000 / 60) {
      const pose = { track: declared.track, ageMs: declared.ageMs, pos: D, fwd: [0, 1] };
      const since = t % 100;
      const disp = remoteDisplay(true, pose, since, dispOpts);
      const fresh = selfFresh && (declared.track === "marker" || declared.ageMs < 3000);
      if (disp.draw && (!disp.freeze || !frozen)) frozen = D;
      // Pose の結果（10Hz）
      if (Math.floor(t / 100) !== Math.floor((t - 1000 / 60) / 100) || t === 0) {
        lastResult = t;
        if (visible(t)) {
          const h = trueHead(t);
          cam = { head: h, fwd: [0, 1], fwdSource: "shoulders", camDist: Math.hypot(h[0] - E[0], h[1] - E[1], h[2] - E[2]) };
          camAt = t;
          lastSeen = t;
          lastHead = h;
          const hy = hybridHead(E, h, D, fresh, 0.7);
          corr.push({ t, c: [hy[0] - D[0], hy[1] - D[1], hy[2] - D[2]] });
          corr = pruneCorr(corr, 3);
        } else cam = null;
      }
      const seen = cam !== null && camAt === lastResult;
      const plan = planRemote({
        mode, now: t, disp, anchor: anchorI, declMarker: D, declMarkerFrozen: frozen, declYaw: 0, fresh, seen, cam,
        lastCamSeenMs: lastSeen, lastCamHead: lastHead, lastCamFwd: [0, 1], corr, eye: E, opts: { ...planOpts, ...opts },
        display: (q) => remoteDisplay(true, q, 0, dispOpts), markerToWorld,
      });
      if (!plan.target) {
        shown = null;
        frames.push({ t, drawn: false, reason: plan.reason, source: plan.source });
        continue;
      }
      const prev = shown;
      shown = smoothToward(shown, plan.target, 1 / 60, 0.25, 3).pos;
      frames.push({ t, drawn: true, pos: shown, step: prev ? Math.hypot(shown[0] - prev[0], shown[1] - prev[1], shown[2] - prev[2]) : 0, fade: plan.fade, source: plan.source, reason: plan.reason, target: plan.target });
    }
    return frames;
  };
  const at = (frames, ms) => frames.reduce((b, f) => (Math.abs(f.t - ms) < Math.abs(b.t - ms) ? f : b));
  const T0 = [-0.5, 1.6, 1];
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const maxStep = (frames, from, to) => frames.filter((f) => f.drawn && f.t > from && f.t <= to).reduce((m, f) => Math.max(m, f.step), 0);

  // 修正 1: 申告が古い相手（gyro で最後にマーカーを見てから 30 秒）。見える 0〜3s → 見えない。補正付きで残り、弱まり、最後に見えてから staleHideMs で消える
  const stale = simulate({ durMs: 15000, visible: (t) => t < 3000, trueHead: () => T0, declared: { track: "gyro", ageMs: 30000 } });
  const s31 = at(stale, 3300);
  check("段階 3・plan（修正 1）: 申告が古い相手も、見えなくなった直後は消えずに補正付きで見えていた位置に残る（src=declared+corr・T から 5cm 以内）", s31.drawn && s31.source === "declared+corr" && dist(s31.pos, T0) < 0.05, JSON.stringify({ drawn: s31.drawn, src: s31.source, d: s31.pos && dist(s31.pos, T0).toFixed(3) }));
  const s8 = at(stale, 8000);
  check("段階 3・plan（修正 1）: 見えなくなって 5 秒後は補正が半分に弱まり、T と申告の間（半分だけ申告へ）・薄く", s8.drawn && Math.abs(dist(s8.pos, T0) - 0.5) < 0.06 && s8.fade < 0.6, JSON.stringify({ dT: s8.pos && dist(s8.pos, T0).toFixed(3), fade: s8.fade?.toFixed(2) }));
  const s13 = at(stale, 13000);
  check("段階 3・plan（修正 1）: 申告が古い相手は、最後に見えてから staleHideMs（8s）+ フェードで消える", !s13.drawn && s13.reason !== "ok", JSON.stringify(s13));
  check("段階 3・plan: 申告が古い相手が見え → 見えない → 消えるまで、表示は 1 フレームで 3cm 以上動かない", maxStep(stale, 100, 13000) < 0.03, maxStep(stale, 100, 13000).toFixed(4));
  // 修正 2: 申告が新しい相手（marker）。見えなくなって 12 秒経っても消えない・跳ばない
  const fresh = simulate({ durMs: 15000, visible: (t) => t < 3000, trueHead: () => T0, declared: { track: "marker", ageMs: 0 } });
  const drawnAll = fresh.filter((f) => f.t >= 3000).every((f) => f.drawn);
  check("段階 3・plan（修正 2）: 申告が新しい相手は、見えなくなって 12 秒経っても消えない（以前は 8.5 秒で消えていた）", drawnAll, JSON.stringify(fresh.find((f) => f.t >= 3000 && !f.drawn) ?? null));
  check("段階 3・plan（修正 2）: 補正が弱まり切る 13 秒の前後でも表示は跳ばない（1 フレーム 3cm 未満）・最後は申告位置", maxStep(fresh, 100, 15000) < 0.03 && dist(at(fresh, 15000).pos, D) < 0.02, `${maxStep(fresh, 100, 15000).toFixed(4)} end=${dist(at(fresh, 15000).pos, D).toFixed(3)}`);
  check("段階 3・plan（修正 2）: 見えている間の申告が新しいので薄さは 1 のまま（max(申告側, 見えてから側)）", at(fresh, 12000).fade === 1, String(at(fresh, 12000).fade));
  // 修正 7・画面の端: 申告が止まっている相手が 0.5 m/s で歩き、0.3 秒ごとに見え隠れする。見えなくなるたびに歩いた分だけ戻らない
  const walkHead = (t) => [-0.5 + 0.5 * (t / 1000), 1.6, 1];
  const edge = simulate({ durMs: 6000, visible: (t) => Math.floor(t / 300) % 2 === 0, trueHead: walkHead, declared: { track: "gyro", ageMs: 30000 } });
  const lagOf = (fr) => fr.filter((f) => f.drawn && f.t > 1000).reduce((m, f) => Math.max(m, dist(f.pos, walkHead(f.t))), 0);
  const lag = lagOf(edge);
  // 比較: 窓全体（3 秒）の平均を補正に使うと、見えなくなるたびに約 1.5 秒前の位置へ戻る
  const lagWin = lagOf(simulate({ durMs: 6000, visible: (t) => Math.floor(t / 300) % 2 === 0, trueHead: walkHead, declared: { track: "gyro", ageMs: 30000 }, opts: { corrRecentSec: 3 } }));
  check("段階 3・plan（修正 7）: 画面の端で見え隠れしながら 0.5m/s で歩いても、表示は途切れず・1 フレーム 3cm 未満・本当の位置から 35cm 以内（表示のなめらかさ 0.25s の遅れ込み。窓全体の平均なら遅れがもっと大きい）", edge.filter((f) => f.t > 300).every((f) => f.drawn) && lag < 0.35 && lag < lagWin && maxStep(edge, 100, 6000) < 0.03, `直近 0.5s: ${lag.toFixed(3)}m / 窓全体: ${lagWin.toFixed(3)}m step=${maxStep(edge, 100, 6000).toFixed(4)}`);
  // 修正 6: camera モードは、最新の結果で見えなくなったら 0.2 秒で消す
  const camOnly = simulate({ mode: "camera", durMs: 4000, visible: (t) => t < 2000, trueHead: () => T0, declared: { track: "marker", ageMs: 0 } });
  // 最後に見えた結果は 1900ms（2000ms の結果から見えない）
  const c21 = at(camOnly, 2000);
  const c23 = at(camOnly, 2150);
  check("段階 3・plan（修正 6）: camera モードは見えなくなってから 0.2 秒で消す（以前は最大 1 秒）", c21.drawn && c21.fade < 1 && !c23.drawn, JSON.stringify({ c21: { drawn: c21.drawn, fade: c21.fade }, c23: { drawn: c23.drawn, reason: c23.reason } }));
  const dcl = simulate({ mode: "declared", durMs: 3000, visible: () => true, trueHead: () => T0, declared: { track: "marker", ageMs: 0 } });
  check("段階 3・plan: declared モードは見えていても申告位置（段階 2 と同じ）", dist(at(dcl, 3000).pos, D) < 0.01 && at(dcl, 3000).source === "declared");
}

// ================= 2e. 遅い端末では人の形の検出の回数を自動で下げる（stage2-fix2 の 4）=================
{
  check("maskHz の段: 上限 15 → 15/10/6/4、上限 8 → 8/6/4、上限 3 → 3、上限 20 → 20/15/10/6/4", JSON.stringify(maskHzLevels(15)) === "[15,10,6,4]" && JSON.stringify(maskHzLevels(8)) === "[8,6,4]" && JSON.stringify(maskHzLevels(3)) === "[3]" && JSON.stringify(maskHzLevels(20)) === "[20,15,10,6,4]");
  check("段の判定: 直近 2 秒の平均 fps が 30 未満なら 1 段下げる（理由付き）", (() => { const d = decideMaskHzLevel(0, 4, [20, 18]); return d.level === 1 && /fps2s=19<30/.test(d.reason); })(), JSON.stringify(decideMaskHzLevel(0, 4, [20, 18])));
  check("段の判定: 1 秒だけでは下げない（2 秒ぶん要る）", decideMaskHzLevel(0, 4, [10]).level === 0);
  check("段の判定: 平均が 30 以上なら下げない（35 と 26 → 30.5）", decideMaskHzLevel(0, 4, [35, 26]).level === 0);
  check("段の判定: 一番下（4Hz）からは下げない", decideMaskHzLevel(3, 4, [10, 10]).level === 3);
  check("段の判定: 5 秒続けて 45 超なら 1 段戻す", (() => { const d = decideMaskHzLevel(2, 4, [50, 55, 60, 46, 58]); return d.level === 1 && /fps>45 for 5s/.test(d.reason); })());
  check("段の判定: 4 秒ではまだ戻さない・1 秒でも 45 以下なら戻さない", decideMaskHzLevel(2, 4, [50, 55, 60, 46]).level === 2 && decideMaskHzLevel(2, 4, [50, 55, 45, 46, 58]).level === 2);
  check("段の判定: 一番上（上限）からは上げない", decideMaskHzLevel(0, 4, [60, 60, 60, 60, 60]).level === 0);
  // 描画の fps を与えて、実機の iPad（Pose を回すと 14〜20fps）の流れを再現: 下げた後は新しい 2 秒を見てから次を決める
  const runGov = (gov, fpsAt, fromMs, toMs, running = true) => {
    const changes = [];
    let t = fromMs;
    while (t < toMs) {
      const c = gov.frame(t, running);
      if (c) changes.push([Math.round(t), c]);
      t += 1000 / fpsAt(t);
    }
    return changes;
  };
  const g = new MaskHzGovernor(15, true);
  const down = runGov(g, () => 17, 0, 12000);
  check("回数の自動調整: fps 17 が続くと 15 → 10 → 6 → 4 と 1 段ずつ（段ごとに 2 秒以上見てから）下げる", g.hz === 4 && down.length === 3 && down.every(([, c], i) => c.startsWith(`${[15, 10, 6][i]}→${[10, 6, 4][i]}`)) && down[1][0] - down[0][0] >= 2000 && down[2][0] - down[1][0] >= 2000, JSON.stringify(down));
  const up = runGov(g, () => 58, 12000, 30000);
  check("回数の自動調整: fps 58 に戻ると 5 秒ごとに 1 段ずつ戻す（4 → 6 → 10 → 15）", g.hz === 15 && up.length === 3 && up[1][0] - up[0][0] >= 5000, JSON.stringify(up));
  const g2 = new MaskHzGovernor(15, true);
  runGov(g2, () => 17, 0, 5000, false);
  check("回数の自動調整: 検出を回していない間の fps では変えない", g2.hz === 15);
  const g3 = new MaskHzGovernor(8, true);
  runGov(g3, () => 17, 0, 12000);
  check("回数の自動調整: ?maskHz=8 は上限（8 → 6 → 4）", g3.levels[0] === 8 && g3.hz === 4);
  const g4 = new MaskHzGovernor(15, false);
  runGov(g4, () => 10, 0, 10000);
  check("回数の自動調整: ?maskHzAuto=0 なら変えない", g4.hz === 15);
  const g5 = new MaskHzGovernor(15, true);
  const osc = runGov(g5, (t) => (Math.floor(t / 500) % 2 ? 33 : 50), 0, 20000);
  check("回数の自動調整: 30〜45 の間（33 と 50 を交互）では動かない", osc.length === 0 && g5.hz === 15, JSON.stringify(osc));
}

// ================= 2f. 鏡モード（mirror.html）: 検出した骨格 → 頭・体の向き、割り当て、見失ったとき、反転 =================
{
  // iPad の前面カメラ（水平 68°、4:3）。カメラ座標系 = ワールド（x 右・y 上・z 手前、カメラは −Z を見る）
  const m = { tanHalfFov: Math.tan(34 * DEG) * 0.75, eyeAspect: 4 / 3, repeatX: 1, repeatY: 1 };
  const opts = { bodyScale: 1, minVisibility: 0.5, maxDepthM: 8 };
  const person = (head, yawDeg) => ({ head, fwd: [Math.sin(yawDeg * DEG), Math.cos(yawDeg * DEG)] });
  const solve = (p) => {
    const r = fakeMirrorPose([p], m);
    return mirrorPersonFromPose(r.landmarks[0], r.worldLandmarks[0], m, opts);
  };
  const front = solve(person([0.1, 0.25, -3.2], 0));
  check("鏡: カメラの方を向いた人 → 頭（両目の中点）は合成の位置（差 < 1cm）・体の前はカメラの方 [0, 1]（肩の線から）", front && Math.hypot(front.head[0] - 0.1, front.head[1] - 0.25, front.head[2] + 3.2) < 0.01 && front.fwd[1] > 0.999 && front.fwdSource === "shoulders", JSON.stringify(front));
  check("鏡: 足首が画面に入っていれば床の高さが出る（頭 − 床 = 合成の体の目の高さ 1.68m）", front && front.floorY !== null && near(front.head[1] - front.floorY, 1.68, 0.02), front && String(front.floorY));
  const side = solve(person([0.4, 0.25, -2.6], 90));
  check("鏡: 横（+x、画面の右）を向いた人 → 体の前は [1, 0]（肩の線が奥行き方向でも向きが出る）", side && side.fwd[0] > 0.99 && side.fwdSource === "shoulders", JSON.stringify(side?.fwd));
  const side2 = solve(person([-0.4, 0.25, -2.6], -90));
  check("鏡: 逆の横（−x）を向いた人 → [−1, 0]", side2 && side2.fwd[0] < -0.99, JSON.stringify(side2?.fwd));
  const diag = solve(person([0, 0.25, -3], 45));
  check("鏡: 斜め 45° → yaw 45°（± 1°）", diag && Math.abs(Math.atan2(diag.fwd[0], diag.fwd[1]) / DEG - 45) < 1, diag && String(Math.atan2(diag.fwd[0], diag.fwd[1]) / DEG));
  // MediaPipe が左右の肩を取り違えた（真横に近いとき）: 鼻が前にあれば鼻の側を前にする
  {
    const r = fakeMirrorPose([person([0, 0.25, -3], 0)], m);
    const L = r.landmarks[0].map((l) => ({ ...l }));
    const W = r.worldLandmarks[0].map((l) => ({ ...l }));
    [[L[11], L[12]], [W[11], W[12]]].forEach(([a, b]) => { const t = { ...a }; Object.assign(a, b); Object.assign(b, t); });
    const sw = mirrorPersonFromPose(L, W, m, opts);
    check("鏡: 左右の肩を取り違えても、鼻が前に出ている側を前にする（カメラの方のまま）", sw && sw.fwd[1] > 0.99, JSON.stringify(sw?.fwd));
  }
  // 肩の線が短い（肩が重なる）ときは鼻で決める
  {
    const placed = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: -3 }));
    placed[11] = { x: 0.02, y: 0.5, z: -3 };
    placed[12] = { x: -0.02, y: 0.5, z: -3 };
    placed[0] = { x: 0.1, y: 0.7, z: -3 };
    const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 1 }));
    const f = mirrorBodyFacing(placed, lm, 0.5);
    check("鏡: 肩の線が 12cm 未満なら鼻の向き（鼻が +x に出ている → [1, 0]）", f.source === "nose" && f.fwd[0] > 0.99, JSON.stringify(f));
    const lm2 = lm.map((l, i) => (i === 0 || i === 11 || i === 12 ? { ...l, visibility: 0.1 } : l));
    check("鏡: 肩も鼻も見えなければカメラの方を向いているとみなす", mirrorBodyFacing(placed, lm2, 0.5).source === "default");
  }
  check("鏡: 可視点が足りない（全部 visibility 0）なら人として扱わない", (() => { const r = fakeMirrorPose([person([0, 0.25, -3], 0)], m); return mirrorPersonFromPose(r.landmarks[0].map((l) => ({ ...l, visibility: 0 })), r.worldLandmarks[0], m, opts) === null; })());
  check("鏡: maxDepth より遠い人は扱わない", (() => { const r = fakeMirrorPose([person([0, 0.25, -9], 0)], m); return mirrorPersonFromPose(r.landmarks[0], r.worldLandmarks[0], m, opts) === null; })());
  // 割り当て
  const a1 = assignMirror([3.1, 2.2, 4.0], ["pA"]);
  check("割り当て: 化身が 1 人なら一番近い（深度の小さい）人に付ける", a1.get("pA") === 1 && a1.size === 1);
  const a2 = assignMirror([3.1, 2.2, 4.0], ["pA", "pB"]);
  check("割り当て: 複数なら近い順に参加順（1 番目 → 一番近い、2 番目 → 2 番目に近い）", a2.get("pA") === 1 && a2.get("pB") === 0);
  const a3 = assignMirror([2.5], ["pA", "pB"]);
  check("割り当て: 人が足りなければ後のプレイヤーは付かない", a3.get("pA") === 0 && !a3.has("pB"));
  check("割り当て: 人がいなければ誰も付かない", assignMirror([], ["pA"]).size === 0);
  // 見失ったとき
  check("見失い: 見えている間は濃さ 1", (() => { const r = mirrorHoldFade(0, 500, 500); return r.draw && r.fade === 1 && r.phase === "seen"; })());
  check("見失い: 0.5 秒までは最後の位置で保持（濃さ 1）", (() => { const r = mirrorHoldFade(480, 500, 500); return r.draw && r.fade === 1 && r.phase === "hold"; })());
  check("見失い: その後 0.5 秒でフェード（0.75 秒で 0.5）", (() => { const r = mirrorHoldFade(750, 500, 500); return r.draw && near(r.fade, 0.5) && r.phase === "fading"; })());
  check("見失い: 1 秒で消える・見つけ直したらすぐ出す（経過 0 で濃さ 1）", !mirrorHoldFade(1000, 500, 500).draw && mirrorHoldFade(-Infinity, 500, 500).fade === 1 && !mirrorHoldFade(Infinity, 500, 500).draw);
  // Pose が止まったとき（修正 1）: 濃さは「いま − 最後に見た時刻」で決まる。結果が来なくなっても保持 → フェード → 消える
  {
    const o = { holdMs: 500, fadeMs: 500, staleResultMs: 1000 };
    const lastSeen = 10000; // 最後の結果（人が写っていた）= 最後に見た時刻。以後、結果が来ない
    const at = (t) => mirrorVisibility(lastSeen + t, lastSeen, lastSeen, o);
    check("Pose が止まる: 最後の結果の直後は見えている（seen・濃さ 1）", at(0).phase === "seen" && at(60).phase === "seen" && at(60).fade === 1);
    check("Pose が止まる: 結果が来なくても 0.5 秒までは濃さ 1（結果と結果の間と同じ）", at(450).draw && at(450).fade === 1);
    check("Pose が止まる: 0.75 秒で濃さ 0.5（フェード）・1 秒で消える（最後の位置に残り続けない）", near(at(750).fade, 0.5) && at(750).phase === "fading" && !at(1000).draw && !at(60000).draw);
    check("Pose が動いている: 新しい結果に写っていれば seen（lastSeen = 最新の結果の時刻）", mirrorVisibility(20000, 20000, 20000, o).phase === "seen");
    check("Pose が動いている: 新しい結果に写っていなければ最後に見た時刻からの経過（0.3 秒で hold）", mirrorVisibility(20300, 20000, 20250, o).phase === "hold");
  }
  // 人数が減ったとき（修正 2）: 1 人の人には化身を 1 体だけ。前の結果の人と画像の上の位置で対応づけて入れ替わりにくく
  {
    const imgOf = (h) => {
      const q = projectToImage({ x: h[0], y: h[1], z: h[2] }, m);
      return [q.x, q.y];
    };
    const P = (head) => ({ head, depth: -head[2], img: imgOf(head) });
    const L = (p) => ({ img: p.img, head: p.head });
    const ao = { matchImg: 0.15, holdMs: 500 };
    const A = P([-0.6, 0.25, -2.8]);
    const B = P([0.6, 0.25, -3.4]);
    const r1 = assignMirrorTracked([A, B], [{ id: "p1", last: null, sinceSeenMs: Infinity }, { id: "p2", last: null, sinceSeenMs: Infinity }], ao);
    check("割り当て（対応づけ）: 初めは近い順 × 参加順（p1 → A、p2 → B・new）", r1.assign.get("p1") === 0 && r1.assign.get("p2") === 1 && r1.info.get("p1").reason === "new");
    // A が画面から消えた: B は p2 のまま（p1 に付け替えない）
    const r2 = assignMirrorTracked([B], [{ id: "p1", last: L(A), sinceSeenMs: 100 }, { id: "p2", last: L(B), sinceSeenMs: 100 }], ao);
    check("割り当て（対応づけ）: 2 人 → 1 人（A が消えた）で B は p2 のまま（tracked）・p1 はどの人にも付かない（hold）", r2.assign.get("p2") === 0 && !r2.assign.has("p1") && r2.displaced.size === 0 && r2.info.get("p2").reason === "tracked" && r2.info.get("p1").reason === "hold");
    // 描かれる化身の数を数える（p1 は A の位置で保持 → フェード、p2 は B）。B の所（0.5m 以内）に描かれる化身は常に 1 体、1 秒後には全体で 1 体
    const o = { holdMs: 500, fadeMs: 500, staleResultMs: 1000 };
    const drawnAt = (t) => {
      const lastSeen = { p1: 0, p2: t };
      const target = { p1: A.head, p2: B.head };
      return ["p1", "p2"].filter((id) => mirrorVisibility(t, lastSeen[id], t, o).draw).map((id) => target[id]);
    };
    const nearB = (t) => drawnAt(t).filter((h) => Math.hypot(h[0] - B.head[0], h[1] - B.head[1], h[2] - B.head[2]) <= 0.5).length;
    check("2 人 → 1 人: B の所に描かれる化身はいつも 1 体・1 秒後に描かれる化身は全体で 1 体", [100, 400, 700, 999].every((t) => nearB(t) === 1) && drawnAt(1000).length === 1);
    // 対応づけ無しの旧方式（近い順 × 参加順）だと、p1 が B に付け替わる（= B に 2 体重なっていた原因）
    check("（旧方式の確認）対応づけ無しだと 2 人 → 1 人で p1 が B に付け替わる", assignMirror([B.depth], ["p1", "p2"]).get("p1") === 0);
    // 2 人が近くにいて、前の人を取られた化身: 保持せずにすぐフェード（displaced）
    const C = P([0.1, 0.25, -3]);
    const r3 = assignMirrorTracked([C], [{ id: "p1", last: L(P([0.35, 0.25, -3])), sinceSeenMs: 300 }, { id: "p2", last: L(P([0.05, 0.25, -3])), sinceSeenMs: 300 }], ao);
    check("割り当て（対応づけ）: 1 人を 2 体が指していたら近い方だけ付け、もう一方は displaced（すぐフェード）", r3.assign.get("p2") === 0 && !r3.assign.has("p1") && r3.displaced.has("p1"));
    const far = P([1.8, 0.25, -3]);
    const r4 = assignMirrorTracked([far], [{ id: "p1", last: L(P([-0.5, 0.25, -3])), sinceSeenMs: 600 }], ao);
    check("割り当て（対応づけ）: 1 体・1 人で、前の人を見失って保持（0.5 秒）を過ぎ、遠くに別の人がいれば付け替える（new）", r4.assign.get("p1") === 0 && r4.info.get("p1").reason === "new");
    const r4b = assignMirrorTracked([far], [{ id: "p1", last: L(P([-0.5, 0.25, -3])), sinceSeenMs: 400 }], ao);
    check("割り当て（対応づけ）: 保持の時間（0.5 秒）の間は、別の人がいても付け替えない（hold）", !r4b.assign.has("p1") && r4b.info.get("p1").reason === "hold");
    const r5 = assignMirrorTracked([P([0, 0.25, -3.1]), P([0.1, 0.25, -2.2])], [{ id: "p1", last: L(P([0.05, 0.25, -3.05])), sinceSeenMs: 60 }], ao);
    check("割り当て（対応づけ）: 前の人がいれば、より近い（手前の）人が現れても付け替えない", r5.assign.get("p1") === 0 && r5.info.get("p1").reason === "tracked");
  }
  // Pose が付けた人を 1 回だけ取りこぼした（隣に並んだ人は画像の上で 0.12 離れている）: 隣の人へ移らず、戻ったら同じ人
  {
    const imgOf = (h) => {
      const q = projectToImage({ x: h[0], y: h[1], z: h[2] }, m);
      return [q.x, q.y];
    };
    const P = (head) => ({ head, depth: -head[2], img: imgOf(head) });
    const ao = { matchImg: 0.15, holdMs: 500 };
    const A = P([-0.24, 0.25, -3.0]);
    const B = P([0.24, 0.25, -3.0]);
    const sep = Math.hypot(A.img[0] - B.img[0], A.img[1] - B.img[1]);
    const lastA = { img: A.img, head: A.head };
    const drop1 = assignMirrorTracked([B], [{ id: "p1", last: lastA, sinceSeenMs: 67 }], ao);
    const drop2 = assignMirrorTracked([B], [{ id: "p1", last: lastA, sinceSeenMs: 200 }], ao);
    const back = assignMirrorTracked([B, A], [{ id: "p1", last: lastA, sinceSeenMs: 267 }], ao);
    check(
      "鏡: 付けた人を Pose が 1〜2 回取りこぼしても、隣の人（画像の上で 0.12）へ移らない（しきい値は最後に見えてからの時間で広がる: 67ms で 0.05・200ms で 0.1）。戻れば同じ人",
      near(sep, 0.119, 0.01) && !drop1.assign.has("p1") && drop1.info.get("p1").reason === "hold" && !drop2.assign.has("p1") && back.assign.get("p1") === 1 && back.info.get("p1").reason === "tracked",
      `sep=${sep.toFixed(3)} gate67=${mirrorImgGate(0.15, 67)} gate200=${mirrorImgGate(0.15, 200)}`,
    );
    check("鏡: しきい値は 0.05 から時間で広がり、0.3 秒で ?mirrorMatchImg=0.15 に届く（見失ったままならそれ以上は広げない）", near(mirrorImgGate(0.15, 0), 0.05) && near(mirrorImgGate(0.15, 300), 0.15) && near(mirrorImgGate(0.15, 60000), 0.15) && near(mirrorImgGate(0.15, Infinity), 0.15));
    // Codex の指摘（高）: 元の人 A が消えて、画像の上で 0.12 離れた隣の人 B だけが残る。修正前は 300ms で範囲が 0.15 に広がり、保持（500ms）を待たずに B を tracked にしていた
    const [An, Bn] = withNearImg([A, B]);
    const lastAn = { img: An.img, head: An.head, nearImg: An.nearImg };
    const onlyB = withNearImg([B]);
    const at = (ms) => assignMirrorTracked(onlyB, [{ id: "p1", last: lastAn, sinceSeenMs: ms }], ao);
    const holds = [100, 300, 450].map((ms) => at(ms));
    const after = at(550);
    check(
      "鏡（Codex の指摘）: 元の人が消えて 0.12 離れた隣の人だけが残っても、保持の間（100 / 300 / 450ms）は付け替えない（hold）・保持を過ぎたら付け替わる",
      near(An.nearImg, sep, 1e-12) && holds.every((r) => !r.assign.has("p1") && r.info.get("p1").reason === "hold" && r.displaced.size === 0) && after.assign.get("p1") === 0,
      JSON.stringify({ holds: holds.map((r) => `${r.info.get("p1").reason}/gate=${r.info.get("p1").gate?.toFixed(3)}`), after: after.info.get("p1").reason }),
    );
    check("鏡（Codex の指摘・修正前の再現）: 前回の隣の人までの距離を渡さないと、300ms で隣の人を tracked にする", assignMirrorTracked(onlyB, [{ id: "p1", last: { img: A.img, head: A.head }, sinceSeenMs: 300 }], ao).info.get("p1").reason === "tracked");
    // 保持の間でも、本人が戻れば（隣の人がいても・いなくても）捕まえ直す。隣の人がいなかった人は、今までどおり広げた範囲で追いかける
    const backA = assignMirrorTracked(withNearImg([B, A]), [{ id: "p1", last: lastAn, sinceSeenMs: 300 }], ao);
    const moved = P([0.12, 0.25, -3.0]);
    const alone = withNearImg([A])[0];
    const movedAlone = assignMirrorTracked(withNearImg([moved]), [{ id: "p1", last: { img: alone.img, head: alone.head, nearImg: alone.nearImg }, sinceSeenMs: 300 }], ao);
    const dMove = Math.hypot(moved.img[0] - A.img[0], moved.img[1] - A.img[1]);
    check("鏡: 保持の間に本人が戻れば捕まえ直す（tracked）・隣の人がいなかった人は保持の間も広げた範囲で追いかける", backA.assign.get("p1") === 1 && backA.info.get("p1").reason === "tracked" && movedAlone.info.get("p1").reason === "tracked" && dMove > 0.06, `dMove=${dMove.toFixed(3)}`);
  }
  // 実機の不具合（2026-09-28。assign p28→1 / p28→0 が 0.1 秒おきに交互）: 2 人が同じくらいの距離に並び、Pose の距離の推定が ±0.3m ぶれる。
  // 本物の経路（合成の骨格 → mirrorPersonFromPose）で、体の大きさの仮定（bodyScale）を毎回 0.9〜1.1 でぶらし（3m で ±0.3m）、結果の中の人の順番も毎回入れ替える
  {
    const ao = { matchImg: 0.15, holdMs: 500 };
    const HOLD = 500;
    const FADE = 500;
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const detect = (people) => {
      const out = [];
      for (const pp of people) {
        const r = fakeMirrorPose([pp], m);
        // 画像の上の点も揺らす（人全体で ±0.01・点ごとに ±0.003。体の揺れと推定のぶれ）
        const ox = (rnd() - 0.5) * 0.02;
        const oy = (rnd() - 0.5) * 0.02;
        const lm = r.landmarks[0].map((l) => ({ ...l, x: l.x + ox + (rnd() - 0.5) * 0.006, y: l.y + oy + (rnd() - 0.5) * 0.006 }));
        const q = mirrorPersonFromPose(lm, r.worldLandmarks[0], m, { ...opts, bodyScale: 0.9 + rnd() * 0.2 });
        if (q) out.push(q);
      }
      if (out.length === 2 && rnd() < 0.5) out.reverse();
      return out;
    };
    const X = person([-0.35, 0.25, -3.0], 0);
    const Y = person([0.35, 0.25, -3.0], 0);
    /** mirror.ts の assignNow と同じ使い方（状態は化身の「前回の人」と「最後に見えた時刻」だけ）で、10Hz の結果を流す */
    const run = (steps, peopleAt) => {
      const st = { target: null, lastSeen: -Infinity };
      const log = [];
      let depthMin = Infinity;
      let depthMax = -Infinity;
      for (let k = 0; k < steps; k++) {
        const now = k * 100;
        const ps = withNearImg(detect(peopleAt(now)));
        for (const q of ps) {
          depthMin = Math.min(depthMin, q.depth);
          depthMax = Math.max(depthMax, q.depth);
        }
        const alive = st.target && now - st.lastSeen <= HOLD + FADE;
        const res = assignMirrorTracked(ps, [{ id: "p28", last: alive ? { img: st.target.img, head: st.target.head, nearImg: st.target.nearImg } : null, sinceSeenMs: now - st.lastSeen }], ao);
        const idx = res.assign.get("p28");
        if (idx !== undefined) {
          st.target = ps[idx];
          st.lastSeen = now;
        }
        // 付いている人（画像の x で左 = X、右 = Y を見分ける。鏡の反転前）
        log.push({ now, who: idx === undefined ? "-" : ps[idx].img[0] < 0.5 ? "X" : "Y", reason: res.info.get("p28").reason, dImg: res.info.get("p28").dImg, dImg2: res.info.get("p28").dImg2 });
      }
      return { log, depthMin, depthMax };
    };
    const r = run(600, () => [X, Y]);
    const first = r.log[0].who;
    const switches = r.log.filter((x, i) => i > 0 && x.who !== r.log[i - 1].who).length;
    check(
      "鏡（実機の不具合）: 2 人が同じ距離（3m）で推定距離が ±0.3m ぶれ、画像の上の点も揺れ、結果の順番も入れ替わっても、60 秒間（600 回）付け替わらない",
      first !== "-" && switches === 0 && r.log.every((x) => x.who === first) && r.depthMax - r.depthMin > 0.45,
      `付け替え=${switches} 推定距離=${r.depthMin.toFixed(2)}〜${r.depthMax.toFixed(2)}m dImg最大=${Math.max(...r.log.slice(1).map((x) => x.dImg ?? 0)).toFixed(3)} dImg2最小=${Math.min(...r.log.slice(1).map((x) => x.dImg2 ?? 9)).toFixed(3)}`,
    );
    // 旧方式（近い順 × 参加順）は、推定距離のぶれで近い人が入れ替わるたびに付け替わる（実機の 228 回の原因の再現）
    {
      seed = 12345;
      let prev = null;
      let oldSwitches = 0;
      for (let k = 0; k < 600; k++) {
        const ps = detect([X, Y]);
        const i = assignMirror(ps.map((q) => q.depth), ["p28"]).get("p28");
        const who = ps[i].img[0] < 0.5 ? "X" : "Y";
        if (prev && who !== prev) oldSwitches++;
        prev = who;
      }
      check("（旧方式の確認）近い順 × 参加順だけだと、同じ条件で何度も付け替わる", oldSwitches > 50, `付け替え=${oldSwitches}`);
    }
    // 付けた人が画面から出る: 最初の 1 秒は X だけ（X に付く）→ Y も入る → 3 秒目に X が出ていく。保持（0.5 秒）の間は付け替えず、その後に残った Y へ移る
    const leaverName = "X";
    const stayerName = "Y";
    seed = 999;
    const r2 = run(60, (now) => (now < 1000 ? [X] : now < 3000 ? [X, Y] : [Y]));
    const who = (t) => r2.log.find((x) => x.now === t);
    const before = r2.log.filter((x) => x.now < 3000);
    // X を最後に見たのは 2.9 秒の結果（3 秒の結果から X がいない）。保持はそこから数える
    const lastX = 2900;
    const during = r2.log.filter((x) => x.now >= 3000 && x.now <= lastX + HOLD);
    const moved = r2.log.find((x) => x.now > lastX + HOLD && x.who !== "-");
    check(
      "鏡: 付けた人が画面から出たら、保持（0.5 秒）の間は残った人へ付け替えず（hold）、保持を過ぎたら残った人へ移る（new → 以後 tracked）",
      before.every((x) => x.who === leaverName) && during.every((x) => x.who === "-" && x.reason === "hold") && moved && moved.who === stayerName && moved.now <= lastX + HOLD + 100 && moved.reason === "new" && during.length >= 4 && who(5900).who === stayerName && who(5900).reason === "tracked",
      JSON.stringify({ during: during.map((x) => `${x.now}:${x.who}/${x.reason}`), moved: moved && `${moved.now}:${moved.who}/${moved.reason}` }),
    );
  }
  // 反転: 背景と 3D をまとめて左右反転しても、化身は人の背後・同じ向きに見える
  {
    const p = person([0.3, 0.25, -3], 60);
    const back = 0.6;
    const origin = [p.head[0] - p.fwd[0] * back, p.head[1] - 1.5, p.head[2] - p.fwd[1] * back];
    const ih = projectToImage({ x: p.head[0], y: p.head[1], z: p.head[2] }, m);
    const io = projectToImage({ x: origin[0], y: origin[1], z: origin[2] }, m);
    const same = Math.sign(io.x - ih.x) === -Math.sign(mirrorImageX(io.x) - mirrorImageX(ih.x));
    const pf = mirrorDir(p.fwd);
    const kf = mirrorDir(p.fwd);
    check("反転: 画面上の左右は入れ替わるが、化身の原点は人より奥（深度は変わらない）で、人と化身の向きは同じまま（反転後の内積 1）", same && -origin[2] > -p.head[2] && near(pf[0] * kf[0] + pf[1] * kf[1], 1) && pf[0] < 0, JSON.stringify({ ih, io, pf }));
    // カメラの方を向いた人の本人の左手は、反転前の画像では右（x > 頭）、鏡では左（x < 頭）に写る
    const r = fakeMirrorPose([person([0, 0.25, -3], 0)], m);
    const lw = r.landmarks[0][15];
    const hd = r.landmarks[0][0];
    check("反転: カメラの方を向いた人の左手は、反転前は頭の右・鏡（反転後）では頭の左に写る", lw.x > hd.x && mirrorImageX(lw.x) < mirrorImageX(hd.x));
  }
}

// ================= 3. フェードと信用度 =================
{
  check("見上げフェード: 40° 以上で 1", selfLookFade(40, 40) === 1 && selfLookFade(75, 40) === 1);
  check("見上げフェード: 30°（= 40 − 10）以下で 0", selfLookFade(30, 40) === 0 && selfLookFade(0, 40) === 0 && selfLookFade(-50, 40) === 0);
  check("見上げフェード: 35° で 0.5（線形）", near(selfLookFade(35, 40), 0.5));
  check("信用度: marker は 1、none は出さない", trackFade("marker", 0, 3000) === 1 && trackFade("none", null, 3000) === null);
  check("信用度: gyro は ageMs 0 で 1、staleMs で 0.5、以降 0.5", near(trackFade("gyro", 0, 3000), 1) && near(trackFade("gyro", 1500, 3000), 0.75) && near(trackFade("gyro", 3000, 3000), 0.5) && near(trackFade("gyro", 60000, 3000), 0.5));
  check("信用度: gyro で staleMs を過ぎたら位置を止める", !isPositionFrozen("gyro", 2999, 3000) && isPositionFrozen("gyro", 3000, 3000) && !isPositionFrozen("marker", 99999, 3000));
  check("stageStartLocal: 経過 = サーバーの now − changedAt を受信時刻から引く / null はずっと前", stageStartLocal(1000, 1600, 50000) === 49400 && stageStartLocal(null, 1600, 50000) === -Infinity);
  check("poseReceivedLocal: スナップショットの pose は poseAgeMs だけ前に届いたもの / 通常の pose は受信時刻", poseReceivedLocal(50000, 4000) === 46000 && poseReceivedLocal(50000, undefined) === 50000 && poseReceivedLocal(50000, -5) === 50000);
  const mk = { track: "marker", ageMs: 0 };
  check("effectiveTrack: 届いたばかりの marker は marker", JSON.stringify(effectiveTrack(mk, 200, 1000)) === JSON.stringify({ track: "marker", ageMs: 0 }));
  // welcome で受けた 4 秒前の marker の pose: 受信時刻を 4 秒前にずらすので、いま届いた marker ではなく gyro 4s として扱う
  const snapRecv = poseReceivedLocal(50000, 4000);
  const snapTrack = effectiveTrack(mk, 50000 - snapRecv, 1000);
  check("effectiveTrack: 途中入室で受けた 4 秒前の marker は gyro・ageMs 4000", snapTrack.track === "gyro" && snapTrack.ageMs === 4000, JSON.stringify(snapTrack));
  const oldMarker = effectiveTrack({ track: "marker", ageMs: 450 }, 2000, 1000);
  check("effectiveTrack: 古い marker（送信元の ageMs 450）を gyro に移すときは ageMs 450 + 経過 2000", oldMarker.track === "gyro" && oldMarker.ageMs === 2450, JSON.stringify(oldMarker));
  check("effectiveTrack: gyro は送信側の ageMs + 経過、none / pose 無しは位置未確定", effectiveTrack({ track: "gyro", ageMs: 700 }, 300, 1000).ageMs === 1000 && effectiveTrack({ track: "none", ageMs: null }, 0, 1000).track === "none" && effectiveTrack(undefined, 0, 1000).track === "nopose");
}

// ================= 4. 演出の時刻表 =================
{
  const a0 = keshinTimeline(0, "appear");
  check("出現 t=0: 何も出ていない（hidden・オーラ 0・不透明度 0・RISE_M 下）", a0.hidden && a0.auraK === 0 && a0.opacityK === 0 && near(a0.riseM, -RISE_M));
  const a02 = keshinTimeline(0.2, "appear");
  check("出現 0.2s: オーラの柱が吹き上がり中、化身はまだ透明", a02.pillarK > 0.5 && a02.pillarK < 1 && a02.burstK > 0.5 && a02.opacityK === 0);
  const a04 = keshinTimeline(0.4, "appear");
  check("出現 0.4s: 柱が伸び切る", near(a04.pillarK, 1) && near(a04.auraK, 1));
  const a07 = keshinTimeline(0.7, "appear");
  check("出現 0.7s: せり上がり途中（下にずれて半透明）", a07.riseM < 0 && a07.riseM > -RISE_M && a07.opacityK > 0.2 && a07.opacityK < 0.8);
  const a11 = keshinTimeline(1.1, "appear");
  check("出現 1.1s: せり上がり完了・不透明度 1・ポーズ開始", near(a11.riseM, 0) && near(a11.opacityK, 1) && a11.poseK > 0 && a11.poseK < 0.3);
  const a15 = keshinTimeline(1.5, "appear");
  check("出現 1.5s: 決めポーズ完了・オーラは揺らめき続ける強さ", a15.poseK === 1 && near(a15.auraK, AURA_SUSTAIN) && !a15.hidden);
  check("出現 1.5s 以降は同じ見え方（100s 後も）", JSON.stringify(keshinTimeline(100, "appear")) === JSON.stringify(a15));
  check("消去 t=0 は出切った見え方", JSON.stringify(keshinTimeline(0, "vanish")) === JSON.stringify(a15));
  check("消去は出現の逆再生（t → u = 1.5 − 1.5t）", [0.1, 0.33, 0.5, 0.8].every((t) => JSON.stringify(keshinTimeline(t, "vanish")) === JSON.stringify(visualAt(APPEAR_SEC - (t * APPEAR_SEC) / VANISH_SEC))));
  check(`消去 ${VANISH_SEC}s で消え切る`, keshinTimeline(VANISH_SEC, "vanish").hidden && keshinTimeline(50, "vanish").hidden);
  check("純粋関数（同じ入力なら同じ出力。隠れた状態なし）", JSON.stringify(keshinTimeline(0.77, "appear")) === JSON.stringify(keshinTimeline(0.77, "appear")));
  check("不正な t（NaN・負）は安全側（NaN は時間切れ扱い、負は 0）", keshinTimeline(NaN, "appear").u === APPEAR_SEC && keshinTimeline(-1, "appear").u === 0 && keshinTimeline(NaN, "vanish").hidden);
  // 連続性: 細かい刻みで見え方が飛ばない
  const keys = ["auraK", "pillarK", "riseM", "opacityK", "poseK"];
  let maxJump = 0;
  for (const mode of ["appear", "vanish"]) {
    let prev = null;
    for (let t = 0; t <= 1.6; t += 0.001) {
      const v = keshinTimeline(t, mode);
      if (prev) for (const k of keys) maxJump = Math.max(maxJump, Math.abs(v[k] - prev[k]));
      prev = v;
    }
  }
  check("見え方は 1ms 刻みで飛ばない（各値の変化 < 0.02）", maxJump < 0.02, maxJump.toFixed(4));
  let monotone = true;
  for (let t = 0; t < 1.6; t += 0.01) if (keshinTimeline(t + 0.01, "appear").opacityK + 1e-12 < keshinTimeline(t, "appear").opacityK) monotone = false;
  check("出現中の不透明度は減らない", monotone);
  // 途中反転: 新しいステージの経過時間 = いまの見え方と同じになる時刻
  let reverseErr = 0;
  for (const [prevMode, prevT, newMode] of [["appear", 0.2, "vanish"], ["appear", 0.8, "vanish"], ["appear", 1.3, "vanish"], ["vanish", 0.1, "appear"], ["vanish", 0.5, "appear"], ["vanish", 0.9, "appear"]]) {
    const e = retargetElapsed(prevMode, prevT, newMode);
    const after = keshinTimeline(e, newMode);
    const before = keshinTimeline(prevT, prevMode);
    for (const k of [...keys, "u", "burstK"]) reverseErr = Math.max(reverseErr, Math.abs(after[k] - before[k]));
  }
  check("途中反転: 切り替えた瞬間の見え方が同じ（出現→消去・消去→出現の 6 通り。差 < 1e-9）", reverseErr < 1e-9, reverseErr.toExponential(1));
  check("途中反転: 消え切っていれば 0 から・出切っていれば消去は 0 から", retargetElapsed("vanish", Infinity, "appear") === 0 && retargetElapsed("appear", 99, "vanish") === 0);
  check("progressOf / elapsedForProgress は逆関数", [0, 0.3, 0.9, 1.5].every((u) => near(progressOf(elapsedForProgress(u, "vanish"), "vanish"), u) && near(progressOf(elapsedForProgress(u, "appear"), "appear"), u)));
}

// ================= 5. 割り当て =================
{
  check("化身は 4 種類（番号と名前の数が一致）", KESHIN_COUNT === 4 && KESHIN_NAMES.length === KESHIN_COUNT && KESHIN_NAMES[3] === "奏者マエストロ");
  {
    // keshin-assets.ts は three / GLTFLoader と Vite の拡張子なし import に依存して Node から読めないので、ソースから index と name を拾って照合する
    const src = readFileSync(new URL("../demos/ex9-1-keshin/keshin-assets.ts", import.meta.url), "utf8");
    const specs = [...src.matchAll(/^\s+index: (\d+),\s*\n\s+name: "([^"]+)",/gm)].map((m) => [Number(m[1]), m[2]]);
    check(
      "KESHIN_SPECS（モデルの仕様）は KESHIN_COUNT / KESHIN_NAMES と同期している（index が並び順・名前が一致）",
      specs.length === KESHIN_COUNT && specs.every(([i, n], k) => i === k && n === KESHIN_NAMES[k]),
      JSON.stringify(specs),
    );
  }
  {
    // 他人用の切り口の既定（below）: 4 体ともあり、魔神は切り口を下げない（胴の底の蓋が出るため）・マエストロは下段の手が見える 0.6 以上
    const src = readFileSync(new URL("../demos/ex9-1-keshin/keshin-assets.ts", import.meta.url), "utf8");
    const below = [...src.matchAll(/^\s+below: \{ showM: ([\d.]+), dissolveM: ([\d.]+) \},/gm)].map((m) => [Number(m[1]), Number(m[2])]);
    check(
      "KESHIN_SPECS の below: 4 体ぶん・範囲内（0〜3）、魔神 0 / マエストロ 0.6 以上",
      below.length === KESHIN_COUNT && below.every(([a, b]) => a >= 0 && a <= 3 && b >= 0 && b <= 3) && below[0][0] === 0 && below[3][0] >= 0.6,
      JSON.stringify(below),
    );
  }
  check("割り当て: 1 人目 0・2 人目 1・3 人目 2・4 人目 3", assignKeshin([]) === 0 && assignKeshin([0]) === 1 && assignKeshin([0, 1]) === 2 && assignKeshin([0, 1, 2]) === 3);
  check("割り当て: 5 人目は 0（全部 1 回ずつ → 最小）、6 人目は 1", assignKeshin([0, 1, 2, 3]) === 0 && assignKeshin([0, 1, 2, 3, 0]) === 1);
  check("割り当て: 0 の人が抜けたら次の人は 0", assignKeshin([1, 2, 3]) === 0 && assignKeshin([2]) === 0 && assignKeshin([0, 2]) === 1);
  check("割り当て: 使われている数が最少の番号のうち最小", assignKeshin([0, 0, 1, 2, 2, 3]) === 1 && assignKeshin([1, 1, 0, 0, 3, 3]) === 2 && assignKeshin([0, 1, 2]) === 3);
  check("割り当て: 範囲外・整数でない番号は数えない", assignKeshin([0, 1, 2, 4, -1, 1.5]) === 3);
  // 本人が選んだ化身（issue #90）
  check("選択: 0〜3 はその番号", [0, 1, 2, 3].every((k) => parseKeshinChoice(String(k)) === k));
  check("選択: 無し・範囲外・整数でない・空はおまかせ（null）", [null, "4", "-1", "1.5", "", "auto", " 2", "1e0"].every((raw) => parseKeshinChoice(raw) === null));
}

// ================= 6. メッセージの検証 =================
{
  const P = (o) => parseClientMessage(JSON.stringify(o));
  const good = { type: "pose", pos: [0.1, -0.2, 1.3], quat: [0, 0, 0, 2], fwd: [0, -2], track: "marker", ageMs: 12.4 };
  const g = P(good);
  check("pose: 正しいものは通り、quat と fwd を正規化・ageMs は整数", g && near(g.quat[3], 1) && near(g.fwd[1], -1) && g.ageMs === 12 && g.track === "marker");
  check("pose: gyro も通る", P({ ...good, track: "gyro", ageMs: 5000 })?.track === "gyro");
  check("pose: NaN（JSON では null）を捨てる", P({ ...good, pos: [null, 0, 0] }) === null && P({ ...good, fwd: [null, 1] }) === null);
  check("pose: 巨大な位置（> 100m）・巨大な quat を捨てる", P({ ...good, pos: [0, 0, 1e9] }) === null && P({ ...good, quat: [1e7, 0, 0, 1] }) === null);
  check("pose: 退化クォータニオン（長さ < 0.5）を捨てる", P({ ...good, quat: [0, 0, 0, 0] }) === null && P({ ...good, quat: [0.1, 0.1, 0.1, 0.1] }) === null);
  check("pose: 向きが決まらない fwd（長さ < 0.1）を捨てる", P({ ...good, fwd: [0, 0] }) === null && P({ ...good, fwd: [0.01, 0.02] }) === null);
  check("pose: 形が違う（要素数・文字列）を捨てる", P({ ...good, pos: [0, 0] }) === null && P({ ...good, fwd: [0, 1, 0] }) === null && P({ ...good, quat: "x" }) === null);
  check("pose: track と ageMs の不正を捨てる", P({ ...good, track: "slam" }) === null && P({ ...good, ageMs: -1 }) === null && P({ ...good, ageMs: undefined }) === null && P({ ...good, ageMs: "3" }) === null);
  const none = P({ type: "pose", track: "none", pos: [1e9, 0, 0], ageMs: 99 });
  check("pose: track = none は位置を付けずに通す（付いていても捨てる）", none && none.track === "none" && none.pos === undefined && none.ageMs === null);
  check("keshin: on は真偽値だけ", P({ type: "keshin", on: true })?.on === true && P({ type: "keshin", on: 1 }) === null && P({ type: "keshin" }) === null);
  check("不明な type・配列・壊れた JSON を捨てる", P({ type: "shot" }) === null && P([1, 2]) === null && parseClientMessage("{bad") === null);
}

// ================= 7. サーバーの流れ =================
// 既定は Vite の dev サーバー（Node の ws。HTTPS）。KESHIN_TEST_SERVER=worker なら wrangler dev（Worker + Durable Object。HTTP）
const WORKER = process.env.KESHIN_TEST_SERVER === "worker";
/** 空いているポート（wrangler dev 用。Vite は従来どおり 5221 固定） */
async function freePort() {
  return await new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}
const PORT = WORKER ? await freePort() : 5221;
const HTTP = WORKER ? "http" : "https";
const WS = WORKER ? "ws" : "wss";
// wrangler は assets のディレクトリ（dist-keshin/）が無いと起動できないので、無ければ空で作り、終わったら消す
// （WebSocket と実機ログの検査には静的ファイルは要らない）
const ASSETS_DIR = new URL("../dist-keshin/", import.meta.url);
const createdAssetsDir = WORKER && !existsSync(ASSETS_DIR);
if (createdAssetsDir) {
  mkdirSync(ASSETS_DIR, { recursive: true });
  console.log("  (dist-keshin/ が無いので、wrangler dev のために空のディレクトリを作った。終了時に消す)");
}
if (WORKER) {
  console.log(`  (worker モード: wrangler dev を 127.0.0.1:${PORT} で起動する。初回は workerd の取得で時間がかかる)`);
  // 7 章に Node 固有の検査（maxRooms・heartbeat・送信キューの監視）は無いので、スキップする検査は無い。
  // それらは DO 版では意図的に持たない（deploy/cloudflare/keshin-room.ts の冒頭を参照）
  console.log("  (worker モード: 7 章に Node 固有の検査（maxRooms・heartbeat）は無いのでスキップなし。DO 版はそれらを持たない)");
}
const server = WORKER
  ? spawn("npx", ["wrangler", "dev", "--config", "deploy/cloudflare/wrangler.jsonc", "--port", String(PORT), "--ip", "127.0.0.1"], {
      stdio: ["ignore", "pipe", "pipe"],
      // npx → wrangler → workerd の子孫ごと止めるため、プロセスグループを分ける
      detached: true,
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    })
  : spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], { stdio: ["ignore", "pipe", "pipe"] });
let portInUse = false;
/** サーバーの標準出力の行（worker モードの実機ログの検査で使う） */
const serverLines = [];
server.stderr.on("data", (d) => {
  process.stderr.write(d);
  if (/already in use/i.test(d.toString())) portInUse = true;
});
server.stdout.on("data", (d) => {
  for (const line of d.toString().split("\n")) {
    serverLines.push(line);
    // wrangler は console.warn に色と接頭辞を付けるので、行の途中の [keshin] も拾う
    const i = line.indexOf("[keshin]");
    if (i === 0 || (WORKER && i > 0)) console.log(`  server: ${line.slice(i)}`);
  }
});
let serverExited = false;
server.on("exit", () => {
  serverExited = true;
});
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

function stopServer() {
  if (WORKER) {
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {
      server.kill();
    }
    if (createdAssetsDir) rmSync(ASSETS_DIR, { recursive: true, force: true });
  } else {
    server.kill();
  }
}

async function waitForServer(timeoutMs = WORKER ? 180000 : 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (serverExited || portInUse) return false;
    // worker モードの "/" は化身のページへの 302（dist-keshin が空でも返る）
    const res = await fetch(`${HTTP}://localhost:${PORT}/`, { redirect: "manual" }).catch(() => null);
    if (res && (res.ok || (WORKER && res.status === 302))) return true;
    await sleep(300);
  }
  return false;
}

const clients = [];
function connect(query, name = "") {
  const q = new URLSearchParams({ v: String(KESHIN_PROTOCOL_VERSION), ...query });
  if (name) q.set("name", name);
  const ws = new WebSocket(`${WS}://localhost:${PORT}${KESHIN_PATH}?${q}`, {
    rejectUnauthorized: false,
    headers: { origin: `${HTTP}://localhost:${PORT}` },
  });
  const client = { ws, msgs: [] };
  ws.on("message", (d) => client.msgs.push(JSON.parse(d.toString())));
  ws.on("error", () => {});
  client.waitFor = async (pred, timeoutMs = 3000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const m = client.msgs.find(pred);
      if (m) return m;
      await sleep(20);
    }
    return null;
  };
  client.send = (m) => ws.send(JSON.stringify(m));
  client.count = (pred) => client.msgs.filter(pred).length;
  clients.push(client);
  return client;
}

let exitCode = 1;
try {
  if (!(await waitForServer())) throw new Error(`${WORKER ? "wrangler dev" : "dev サーバー"}が起動しなかった（ポート ${PORT} が使用中でないか確認）`);
  if (WORKER) {
    // Worker の振り分け: "/" はページへ、実機ログは console.log へ（wrangler tail で読む）、room 名と Origin の検査
    const root = await fetch(`${HTTP}://localhost:${PORT}/`, { redirect: "manual" });
    check("worker: GET / は化身のページへ 302", root.status === 302 && new URL(root.headers.get("location"), `${HTTP}://localhost:${PORT}`).pathname === "/demos/ex9-1-keshin/", `${root.status} ${root.headers.get("location")}`);
    const marker = `keshin-worker-log-${Date.now()}`;
    const logRes = await fetch(`${HTTP}://localhost:${PORT}/api/client-log`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([{ t: new Date().toISOString(), tag: "test", level: "log", msg: `${marker}\n2 行目` }]),
    });
    let logged = false;
    for (let i = 0; i < 50 && !logged; i++) {
      logged = serverLines.some((l) => l.includes(marker) && l.includes("[client-log]") && l.includes("⏎"));
      if (!logged) await sleep(100);
    }
    check("worker: 実機ログの POST は 204 で、1 行に潰して console.log に出る", logRes.status === 204 && logged, `status=${logRes.status} logged=${logged}`);
    const upgrade = (query, origin) =>
      new Promise((resolve) => {
        const ws = new WebSocket(`${WS}://localhost:${PORT}${KESHIN_PATH}?${new URLSearchParams(query)}`, origin ? { headers: { origin } } : {});
        ws.on("unexpected-response", (_req, res) => {
          resolve(res.statusCode);
          ws.terminate();
        });
        ws.on("open", () => {
          resolve(101);
          ws.close();
        });
        ws.on("error", () => resolve(-1));
      });
    const v = String(KESHIN_PROTOCOL_VERSION);
    check("worker: 不正な room 名は 400", (await upgrade({ v, room: "bad room!", markerId: "0", markerMm: "150" })) === 400);
    check("worker: ページと違う Origin は 403", (await upgrade({ v, room: "ktestorigin", markerId: "0", markerMm: "150" }, "https://evil.example")) === 403);
  }
  const cfg = { room: "ktest", markerId: "0", markerMm: "150" };
  const a = connect(cfg, "Alice");
  const wa = await a.waitFor((m) => m.type === "welcome");
  const me = wa?.players.find((p) => p.id === wa.id);
  check("welcome: 自分の id・役割 player・化身 0・消えている・changedAt null・サーバー時刻", wa && wa.role === "player" && me?.keshin === 0 && me.on === false && me.changedAt === null && typeof wa.now === "number" && me.name === "Alice" && me.color === 1);
  const b = connect(cfg, "Bob");
  const wb = await b.waitFor((m) => m.type === "welcome");
  const c = connect(cfg, "Carol");
  const wc = await c.waitFor((m) => m.type === "welcome");
  const kb = wb?.players.find((p) => p.id === wb.id)?.keshin;
  const kc = wc?.players.find((p) => p.id === wc.id)?.keshin;
  check("2 人目は化身 1、3 人目は化身 2（最初の 4 人は別々）", kb === 1 && kc === 2, `${kb} ${kc}`);
  const ja = await a.waitFor((m) => m.type === "join" && m.player.id === wc?.id);
  check("join に化身の番号が付く", ja && ja.player.keshin === 2 && ja.player.on === false);
  const o = connect({ ...cfg, role: "overview" });
  const wo = await o.waitFor((m) => m.type === "welcome");
  check("俯瞰画面: role overview で入り、Player 一覧（3 人・俯瞰画面は含まない）を受け取る", wo && wo.role === "overview" && wo.players.length === 3);
  check("俯瞰画面の入室は Player の join として配られない", (await a.waitFor((m) => m.type === "join" && m.player.id === wo?.id, 300)) === null);

  // keshin on → 全員（押した本人も）に確定が届く
  a.send({ type: "keshin", on: true });
  const onSentAt = Date.now();
  const got = await Promise.all([a, b, c, o].map((x) => x.waitFor((m) => m.type === "keshin" && m.id === wa.id)));
  check("keshin on: 押した本人・他のプレイヤー・俯瞰画面の全員に確定が届く", got.every((m) => m && m.on === true && m.keshin === 0));
  check("keshin on: 経過 = now − changedAt ≈ 0（その時点から演出を始める）", got[0] && got[0].now - got[0].changedAt >= 0 && got[0].now - got[0].changedAt < 1);
  a.send({ type: "keshin", on: true });
  await sleep(200);
  check("同じ状態の keshin は配らない", a.count((m) => m.type === "keshin") === 1);

  // pose の中継
  a.send({ type: "pose", pos: [0.2, 0.1, 1.5], quat: [0, 0, 0, 3], fwd: [0, -3], track: "marker", ageMs: 20 });
  const pb = await b.waitFor((m) => m.type === "pose" && m.id === wa.id);
  check("pose: 検証・正規化して他の全員に中継（送り主には返さない）", pb && near(pb.quat[3], 1) && near(pb.fwd[1], -1) && pb.track === "marker" && (await o.waitFor((m) => m.type === "pose" && m.id === wa.id)) && (await a.waitFor((m) => m.type === "pose", 200)) === null);
  const beforeBad = b.count((m) => m.type === "pose");
  a.send({ type: "pose", pos: [0, 0, 1e9], quat: [0, 0, 0, 1], fwd: [0, -1], track: "marker", ageMs: 0 });
  a.send({ type: "pose", pos: [0, 0, 1], quat: [0, 0, 0, 0], fwd: [0, -1], track: "marker", ageMs: 0 });
  a.send({ type: "pose", pos: [0, 0, 1], quat: [0, 0, 0, 1], fwd: [0, 0], track: "marker", ageMs: 0 });
  a.send({ type: "pose", track: "none", ageMs: null });
  const pn = await b.waitFor((m) => m.type === "pose" && m.track === "none");
  check("不正な pose は捨て、track = none は位置なしで届く", pn && pn.pos === undefined && b.count((m) => m.type === "pose") === beforeBad + 1);
  a.send({ type: "pose", pos: [0.2, 0.1, 1.5], quat: [0, 0, 0, 1], fwd: [0, -1], track: "gyro", ageMs: 700 });
  const gyroSentAt = Date.now();
  await b.waitFor((m) => m.type === "pose" && m.track === "gyro");
  // 俯瞰画面からの keshin / pose は無視
  o.send({ type: "keshin", on: true });
  o.send({ type: "pose", pos: [0, 0, 1], quat: [0, 0, 0, 1], fwd: [0, -1], track: "marker", ageMs: 0 });
  await sleep(200);
  check("俯瞰画面の keshin / pose は配らない", b.count((m) => m.id === wo.id) === 0);

  // 途中入室者のスナップショット（on の人の経過時間が分かる + 直近の pose とその古さ）。出し切る 1.5s を過ぎてから入る
  await sleep(Math.max(300, 1600 - (Date.now() - onSentAt)));
  const d = connect(cfg, "Dave");
  const wd = await d.waitFor((m) => m.type === "welcome");
  const aliceSnap = wd?.players.find((p) => p.id === wa.id);
  const snapVisual = aliceSnap ? keshinTimeline((wd.now - aliceSnap.changedAt) / 1000, "appear") : null;
  check(
    "途中入室: Alice は on・経過 ≥ 1.5s で、時刻表では出切った状態（演出なしで描ける）",
    aliceSnap && aliceSnap.on === true && wd.now - aliceSnap.changedAt >= 1500 && snapVisual.u === APPEAR_SEC && snapVisual.opacityK === 1 && snapVisual.poseK === 1 && !snapVisual.hidden,
    `${wd && aliceSnap ? (wd.now - aliceSnap.changedAt).toFixed(0) : "-"}ms u=${snapVisual?.u}`,
  );
  check("途中入室: 直近の pose（gyro・ageMs）もスナップショットに載る", aliceSnap?.pose?.track === "gyro" && aliceSnap.pose.ageMs === 700 && aliceSnap.pose.pos[2] === 1.5);
  const sinceGyro = Date.now() - gyroSentAt;
  check(
    "途中入室: スナップショットの pose に受け取ってからの経過 poseAgeMs が付く（今届いた pose と誤解しない）",
    typeof aliceSnap?.poseAgeMs === "number" && aliceSnap.poseAgeMs >= sinceGyro - 150 && aliceSnap.poseAgeMs <= sinceGyro + 50,
    `poseAgeMs=${aliceSnap?.poseAgeMs} 送ってから=${sinceGyro}ms`,
  );
  check("4 人目は化身 3（最初の 4 人は別々）", wd?.players.find((p) => p.id === wd.id)?.keshin === 3);

  // 途中反転: 出切ったあと消し、0.2s 後に出し直す → 開始時刻は u = 1.5 − 0.2×1.5 = 1.2 になる時刻（経過 ≈ 1.2s）
  await sleep(Math.max(0, APPEAR_SEC * 1000 + 100 - (wd.now - aliceSnap.changedAt)));
  a.send({ type: "keshin", on: false });
  const off = await b.waitFor((m) => m.type === "keshin" && m.id === wa.id && m.on === false);
  check("keshin off: 出切っていれば消去は経過 0 から", off && off.now - off.changedAt < 1);
  await sleep(200);
  a.send({ type: "keshin", on: true });
  const reon = await b.waitFor((m) => m.type === "keshin" && m.id === wa.id && m.on === true && m.now - m.changedAt > 100);
  const elapsed = reon ? (reon.now - reon.changedAt) / 1000 : NaN;
  // 期待値はサーバーの関数を使わず手で: 消去を dt 秒進めた見え方は u = 1.5 − dt × (1.5 / 1.0)、出現でその u になる経過は u 秒
  const vanishDt = (reon?.now - off?.changedAt) / 1000;
  const expected = 1.5 - vanishDt * (1.5 / 1.0);
  check("途中反転: 出し直しの経過 = 1.5 − 消去の経過 × 1.5（≈ 1.2s）", near(elapsed, expected, 1e-6) && elapsed > 1.05 && elapsed < 1.25, `elapsed=${elapsed.toFixed(3)} expected=${expected.toFixed(3)} vanishDt=${vanishDt.toFixed(3)}`);

  // 退室と番号の再利用
  b.ws.close();
  const lb = await a.waitFor((m) => m.type === "leave" && m.id === wb.id);
  check("leave が全員に届く", lb && (await o.waitFor((m) => m.type === "leave" && m.id === wb.id)));
  const e = connect(cfg, "Eve");
  const we = await e.waitFor((m) => m.type === "welcome");
  check("抜けた人の化身（1）は次の人に回る", we?.players.find((p) => p.id === we.id)?.keshin === 1);

  // 設定の不一致・役割ごとの上限
  const bad = connect({ ...cfg, markerMm: "100" });
  const err = await bad.waitFor((m) => m.type === "error");
  check("空間設定が違う端末は入室拒否", err && /不一致/.test(err.reason));
  const o2 = connect({ ...cfg, role: "overview" });
  await o2.waitFor((m) => m.type === "welcome");
  const o3 = connect({ ...cfg, role: "overview" });
  const e3 = await o3.waitFor((m) => m.type === "error");
  check(`俯瞰画面は ${MAX_OVERVIEWS} 台まで`, e3 && /台まで/.test(e3.reason));
  // いまプレイヤーは a, c, d, e の 4 人。あと 4 人で 8 人、9 人目は満員
  const more = [1, 2, 3, 4].map((i) => connect(cfg, `P${i}`));
  await Promise.all(more.map((x) => x.waitFor((m) => m.type === "welcome")));
  const ninth = connect(cfg, "Nine");
  const e9 = await ninth.waitFor((m) => m.type === "error");
  check(`プレイヤーは ${MAX_PLAYERS} 人まで（俯瞰画面は数えない）`, e9 && /満員/.test(e9.reason), e9?.reason);
  const counts = Array.from({ length: KESHIN_COUNT }, () => 0);
  for (const x of [a, c, d, e, ...more]) {
    const w = x.msgs.find((m) => m.type === "welcome");
    counts[w.players.find((p) => p.id === w.id).keshin]++;
  }
  check(`8 人の割り当ては偏らない（${KESHIN_COUNT} 種類で各番号 2 人）`, counts.every((n) => n === 2), JSON.stringify(counts));

  // 再接続（v2）: 同じ session 鍵で入り直すと、古い接続を切って番号・on・changedAt を引き継ぐ（別の room で確かめる）
  {
    const cfg2 = { room: "ktest2", markerId: "0", markerMm: "150" };
    const first = connect(cfg2, "First");
    await first.waitFor((m) => m.type === "welcome");
    const ov = connect({ ...cfg2, role: "overview", session: "overviewKey123" });
    const wov = await ov.waitFor((m) => m.type === "welcome");
    /** 俯瞰画面が思っている Player 一覧（welcome + join − leave） */
    const ovPlayers = () => {
      const ids = new Set(wov.players.map((p) => p.id));
      for (const m of ov.msgs) {
        if (m.type === "join") ids.add(m.player.id);
        if (m.type === "leave") ids.delete(m.id);
      }
      return ids;
    };
    const KEY = "rinSession_0001";
    const r1 = connect({ ...cfg2, session: KEY }, "Rin");
    const w1 = await r1.waitFor((m) => m.type === "welcome");
    const k1 = w1.players.find((p) => p.id === w1.id).keshin;
    r1.send({ type: "keshin", on: true });
    const on1 = await ov.waitFor((m) => m.type === "keshin" && m.id === w1.id);
    r1.send({ type: "pose", pos: [0.3, 0, 1.2], quat: [0, 0, 0, 1], fwd: [0, -1], track: "marker", ageMs: 0 });
    await ov.waitFor((m) => m.type === "pose" && m.id === w1.id);
    // 半分切れた接続が残っている状態で、同じ鍵の再接続
    const r2 = connect({ ...cfg2, session: KEY }, "Rin");
    const w2 = await r2.waitFor((m) => m.type === "welcome");
    const me2 = w2?.players.find((p) => p.id === w2.id);
    check("再接続（同じ鍵・古い接続が残っている）: 化身の番号と on と changedAt を引き継ぐ", me2 && me2.keshin === k1 && me2.on === true && me2.changedAt === on1.changedAt, JSON.stringify(me2 && { keshin: me2.keshin, on: me2.on }));
    check("再接続: 本人の welcome に古い id は残らない（自分は 1 人）", w2.players.filter((p) => p.name === "Rin").length === 1);
    const leaveOld = await ov.waitFor((m) => m.type === "leave" && m.id === w1.id);
    const joinNew = await ov.waitFor((m) => m.type === "join" && m.player.id === w2.id);
    check("再接続: 古い id の leave と新しい id の join（on・now 付き）が届く", leaveOld && joinNew && joinNew.player.on === true && typeof joinNew.now === "number" && joinNew.player.pose?.track === "marker" && typeof joinNew.player.poseAgeMs === "number");
    await sleep(300);
    const names = [...ovPlayers()].map((id) => (id === w2.id ? "Rin(new)" : id === w1.id ? "Rin(old)" : id));
    check("再接続: 俯瞰画面の Rin は 1 人（2 体にならない）", ovPlayers().has(w2.id) && !ovPlayers().has(w1.id) && ovPlayers().size === 2, names.join(","));
    check("再接続: 古い接続はサーバーが切る", r1.ws.readyState === WebSocket.CLOSED || r1.ws.readyState === WebSocket.CLOSING);
    check("再接続: 古い id の leave は 1 回だけ", ov.count((m) => m.type === "leave" && m.id === w1.id) === 1);
    // きれいに切れた後の再入室（ページの再読み込み）も、猶予内なら引き継ぐ
    r2.ws.close();
    await ov.waitFor((m) => m.type === "leave" && m.id === w2.id);
    const r3 = connect({ ...cfg2, session: KEY }, "Rin");
    const w3 = await r3.waitFor((m) => m.type === "welcome");
    const me3 = w3?.players.find((p) => p.id === w3.id);
    check("再入室（きれいに切れた後・同じ鍵）: 番号と on を引き継ぐ", me3 && me3.keshin === k1 && me3.on === true && me3.changedAt === on1.changedAt);
    const other = connect({ ...cfg2, session: "otherSession99" }, "Other");
    const wo2 = await other.waitFor((m) => m.type === "welcome");
    check("別の鍵は別の人（引き継がない）", wo2.players.find((p) => p.id === wo2.id).on === false && wo2.players.length === 3);
    // 満員でも同じ鍵なら戻れる
    const fill = [];
    for (let i = 0; i < MAX_PLAYERS - 3; i++) fill.push(connect(cfg2, `F${i}`));
    await Promise.all(fill.map((x) => x.waitFor((m) => m.type === "welcome")));
    const r4 = connect({ ...cfg2, session: KEY }, "Rin");
    const w4 = await r4.waitFor((m) => m.type === "welcome" || m.type === "error");
    check("満員（8 人）でも同じ鍵の再接続は入れる", w4?.type === "welcome" && w4.players.length === MAX_PLAYERS, w4?.type === "error" ? w4.reason : `players=${w4?.players?.length}`);
  }

  // 化身を選んで入室（issue #90）: 選んだ番号はそのまま（重複してよい）、選ばなければ従来どおり参加順
  {
    const cfg90 = { room: "ktest90", markerId: "0", markerMm: "150" };
    const keshinOf = (w) => w?.players.find((p) => p.id === w.id)?.keshin;
    const s1 = connect({ ...cfg90, keshin: "2" }, "Sel1");
    const ws1 = await s1.waitFor((m) => m.type === "welcome");
    check("選択: 1 人目が 2 を選ぶと 2 になる（参加順なら 0）", keshinOf(ws1) === 2, `keshin=${keshinOf(ws1)}`);
    const s2 = connect({ ...cfg90, keshin: "2" }, "Sel2");
    const ws2 = await s2.waitFor((m) => m.type === "welcome");
    const js2 = await s1.waitFor((m) => m.type === "join" && m.player.id === ws2?.id);
    check("選択: 2 人目も同じ 2 を選べる（重複 OK）・join にも載る", keshinOf(ws2) === 2 && js2?.player.keshin === 2, `keshin=${keshinOf(ws2)} join=${js2?.player.keshin}`);
    const a1 = connect(cfg90, "Auto1");
    const wa1 = await a1.waitFor((m) => m.type === "welcome");
    check("選択: おまかせ（?keshin= 無し）は使われていない番号のうち最小（0）", keshinOf(wa1) === 0, `keshin=${keshinOf(wa1)}`);
    const bad5 = connect({ ...cfg90, keshin: "9" }, "Bad");
    const wbad = await bad5.waitFor((m) => m.type === "welcome");
    check("選択: 範囲外の番号はおまかせ扱い（1）で入室できる", keshinOf(wbad) === 1, `keshin=${keshinOf(wbad)}`);
    s1.send({ type: "keshin", on: true });
    const on5 = await s2.waitFor((m) => m.type === "keshin" && m.id === ws1.id);
    check("選択: 化身を出すと選んだ番号で全員に配られる", on5?.on === true && on5.keshin === 2);
    // 再接続: 同じ鍵・同じ選択なら番号と on を保つ。選び直した（再読み込みして別の化身）なら新しい番号が優先
    const KEY90 = "selSession_0090";
    const r1 = connect({ ...cfg90, session: KEY90, keshin: "3" }, "Re");
    const wr1 = await r1.waitFor((m) => m.type === "welcome");
    r1.send({ type: "keshin", on: true });
    await s1.waitFor((m) => m.type === "keshin" && m.id === wr1.id);
    const r2 = connect({ ...cfg90, session: KEY90, keshin: "3" }, "Re");
    const wr2 = await r2.waitFor((m) => m.type === "welcome");
    const me5 = wr2?.players.find((p) => p.id === wr2.id);
    check("選択: 同じ鍵・同じ選択の再接続は番号（3）と on を保つ", me5?.keshin === 3 && me5.on === true, JSON.stringify(me5 && { keshin: me5.keshin, on: me5.on }));
    const r3 = connect({ ...cfg90, session: KEY90, keshin: "1" }, "Re");
    const wr3 = await r3.waitFor((m) => m.type === "welcome");
    check("選択: 同じ鍵で選び直すと新しい番号（1）になる（引き継ぎより優先）", keshinOf(wr3) === 1, `keshin=${keshinOf(wr3)}`);
  }

  // タブの複製（同じ鍵の 2 つのタブが自動で再接続し合う）: 置き換えられた側は REPLACED を受けて再接続をやめ、奪い合いは 1 回で止まる
  {
    const cfg4 = { room: "ktest4", markerId: "0", markerMm: "150" };
    const ov4 = connect({ ...cfg4, role: "overview" });
    await ov4.waitFor((m) => m.type === "welcome");
    /** 08 以降のクライアントと同じ振る舞い: 閉じたら 200ms 後に再接続。満員以外の error を受けたら止める */
    const autoClient = (query, name) => {
      const st = { welcomes: [], errors: [], stopped: false, cur: null };
      const open = () => {
        if (st.stopped) return;
        const c = connect(query, name);
        st.cur = c;
        c.ws.on("message", (d) => {
          const m = JSON.parse(d.toString());
          if (m.type === "welcome") st.welcomes.push(m.id);
          if (m.type === "error") {
            st.errors.push(m.reason);
            if (!/満員|台まで/.test(m.reason)) st.stopped = true;
          }
        });
        c.ws.on("close", () => {
          if (!st.stopped) setTimeout(open, 200);
        });
      };
      open();
      return st;
    };
    const DUP = "duplicatedTab01";
    const tabA = autoClient({ ...cfg4, session: DUP }, "Tab");
    await sleep(400);
    const tabB = autoClient({ ...cfg4, session: DUP }, "Tab");
    await sleep(2500);
    check("タブの複製: 置き換えられた古いタブは REPLACED を受けて再接続をやめる", tabA.stopped && tabA.errors.includes(REPLACED_REASON) && tabA.welcomes.length === 1, JSON.stringify({ a: tabA.welcomes, err: tabA.errors }));
    check("タブの複製: 新しいタブは 1 回入ったまま（奪い合いが 1 回で止まる）", !tabB.stopped && tabB.welcomes.length === 1 && tabB.cur.ws.readyState === WebSocket.OPEN, JSON.stringify({ b: tabB.welcomes }));
    const leaves = ov4.msgs.filter((m) => m.type === "leave").map((m) => m.id);
    check("タブの複製: 俯瞰画面に届いた leave は古いタブの 1 回だけ", leaves.length === 1 && leaves[0] === tabA.welcomes[0], JSON.stringify(leaves));
    tabB.stopped = true;
    tabB.cur.ws.close();
  }

  // 役割をまたいだ同じ鍵は別人（俯瞰画面の鍵で player として入っても満員を超えられない。俯瞰画面も置き換えない）
  {
    const cfg5 = { room: "ktest5", markerId: "0", markerMm: "150" };
    const K = "crossRoleKey01";
    const ov5 = connect({ ...cfg5, role: "overview", session: K });
    await ov5.waitFor((m) => m.type === "welcome");
    const ps = [];
    for (let i = 0; i < MAX_PLAYERS; i++) ps.push(connect({ ...cfg5, session: `crossPlayer${String(i).padStart(3, "0")}` }, `C${i}`));
    await Promise.all(ps.map((x) => x.waitFor((m) => m.type === "welcome")));
    const intruder = connect({ ...cfg5, session: K }, "Intruder");
    const ei = await intruder.waitFor((m) => m.type === "welcome" || m.type === "error");
    check("役割をまたいだ同じ鍵: 俯瞰画面の鍵で player として入っても 9 人目は満員で断る", ei?.type === "error" && /満員/.test(ei.reason), ei?.type === "error" ? ei.reason : `入れてしまった (${ei?.type})`);
    await sleep(200);
    check("役割をまたいだ同じ鍵: 俯瞰画面は置き換えられず繋がったまま", ov5.ws.readyState === WebSocket.OPEN && !ov5.msgs.some((m) => m.type === "error"));
    // 逆向き: player の鍵で俯瞰画面として入っても、その player は置き換えない
    const ovP = connect({ ...cfg5, role: "overview", session: "crossPlayer000" });
    const wP = await ovP.waitFor((m) => m.type === "welcome" || m.type === "error");
    await sleep(200);
    check("役割をまたいだ同じ鍵: player の鍵の俯瞰画面は別の俯瞰画面として入り、player は残る", wP?.type === "welcome" && wP.role === "overview" && ps[0].ws.readyState === WebSocket.OPEN && wP.players.length === MAX_PLAYERS);
  }

  // きれいに切れた人の色と番号は猶予中は予約扱い: A → C → C が切れる → D → C が戻る、で番号も色も重複しない
  {
    const cfg6 = { room: "ktest6", markerId: "0", markerMm: "150" };
    const A = connect({ ...cfg6, session: "reserveA00001" }, "A");
    const wA = await A.waitFor((m) => m.type === "welcome");
    const C = connect({ ...cfg6, session: "reserveC00001" }, "C");
    const wC = await C.waitFor((m) => m.type === "welcome");
    C.ws.close();
    await A.waitFor((m) => m.type === "leave" && m.id === wC.id);
    const D = connect({ ...cfg6, session: "reserveD00001" }, "D");
    const wD = await D.waitFor((m) => m.type === "welcome");
    const C2 = connect({ ...cfg6, session: "reserveC00001" }, "C");
    const wC2 = await C2.waitFor((m) => m.type === "welcome");
    const mine = (w) => w.players.find((p) => p.id === w.id);
    const a = mine(wA);
    const c = mine(wC);
    const d = mine(wD);
    const c2 = mine(wC2);
    check("予約: 猶予中の C の番号・色は D に渡らない", d.keshin !== c.keshin && d.color !== c.color, JSON.stringify({ a: [a.keshin, a.color], c: [c.keshin, c.color], d: [d.keshin, d.color] }));
    const final = wC2.players.map((p) => [p.name, p.keshin, p.color]);
    check("予約: C が戻ると元の番号・色で、3 人の番号も色も別々", c2.keshin === c.keshin && c2.color === c.color && new Set(wC2.players.map((p) => p.keshin)).size === 3 && new Set(wC2.players.map((p) => p.color)).size === 3, JSON.stringify(final));
  }

  // 空になった Room を 60 秒残す: 全員が出て空になっても、同じ鍵で戻れば化身の番号と on を引き継ぐ
  {
    const cfg7 = { room: "ktest7", markerId: "0", markerMm: "150" };
    const solo = connect({ ...cfg7, session: "soloPlayer0001" }, "Solo");
    const ws1 = await solo.waitFor((m) => m.type === "welcome");
    solo.send({ type: "keshin", on: true });
    const on7 = await solo.waitFor((m) => m.type === "keshin" && m.on === true);
    solo.ws.close();
    await sleep(500); // Room のメンバーは 0（空）
    const back = connect({ ...cfg7, session: "soloPlayer0001" }, "Solo");
    const wb2 = await back.waitFor((m) => m.type === "welcome");
    const me7 = wb2.players.find((p) => p.id === wb2.id);
    check("空になった Room（全員が出た）も猶予中は残り、戻れば番号・on・changedAt を引き継ぐ", wb2.players.length === 1 && me7.id !== ws1.id && me7.on === true && me7.changedAt === on7.changedAt && me7.keshin === ws1.players[0].keshin);
  }

  for (const x of clients) x.ws.close();
  await sleep(200);
  const failed = results.filter(([, ok]) => !ok);
  console.log(failed.length === 0 ? "\nALL PASS" : `\n${failed.length} FAILED`);
  exitCode = failed.length === 0 ? 0 : 1;
} catch (e) {
  console.error("テストの実行エラー:", e.message ?? e);
} finally {
  stopServer();
}
process.exit(exitCode);
