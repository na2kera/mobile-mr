// ex9-1-keshin（化身）の回帰テスト。`npm run test:keshin` で実行する。
//   1. keshin-math.ts — 体の向き（正面・見上げ 80°・見下ろし 60°・首を横に向けた・首を傾けて水平を横切る）、送信側の平滑化
//   2. keshin-math.ts — 化身の配置（頭の姿勢 → モデル行列・背中からの距離・腰のクリッピング平面・せり上がり・主観の前傾）
//   3. keshin-math.ts — 主観の見上げフェード、受信側の信用度による薄さ
//   4. keshin-timeline.ts — 出現・消去・途中反転の連続性（純粋関数で隠れた状態が無い）
//   5. keshin-protocol.ts — 化身の割り当て（最初の 3 人は別々・抜けた番号を次の人へ）
//   6. server/keshin.ts — メッセージの検証（NaN・巨大値・退化クォータニオン・不正な向き）
//   7. server/keshin.ts — サーバーの流れ（Vite dev サーバーを起動して WebSocket で: 入室 → 割り当て → keshin on → 全員に配られる →
//      途中入室者のスナップショット → 途中反転 → 退室 → 番号の再利用、役割ごとの上限）
// テストフレームワークは使わない（04〜09 と同じ方針）。Node 22.18+ は .ts をそのまま import できる
import { spawn } from "node:child_process";
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
import { KESHIN_PATH, KESHIN_PROTOCOL_VERSION, MAX_OVERVIEWS, MAX_PLAYERS, REPLACED_REASON, assignKeshin } from "../src/shared/keshin-protocol.ts";
import { parseClientMessage } from "../server/keshin.ts";
import { invertRigid, levelRotation, markerAxes, mulMat4, transformPoint } from "../src/shared/marker-layout.ts";
import { fakeCameraToField } from "../src/shared/fake-markers.ts";
import { coverUvTransform, pickBackUltraWide } from "../src/shared/passthrough-camera.ts";
import * as THREE from "three";
import { assignMirror, assignMirrorTracked, mirrorVisibility, fakeMirrorPose, mirrorBodyFacing, mirrorDir, mirrorHoldFade, mirrorImageX, mirrorPersonFromPose } from "../demos/ex9-1-keshin/mirror-math.ts";
import { projectToImage } from "../src/shared/fake-hands.ts";
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
  // 人数が減ったとき（修正 2）: 1 人の人には化身を 1 体だけ。前の結果の人と位置で対応づけて入れ替わりにくく
  {
    const A = { head: [-0.6, 0.25, -2.8], depth: 2.8 };
    const B = { head: [0.6, 0.25, -3.4], depth: 3.4 };
    const r1 = assignMirrorTracked([A, B], [{ id: "p1", last: null }, { id: "p2", last: null }], 0.5);
    check("割り当て（対応づけ）: 初めは近い順 × 参加順（p1 → A、p2 → B）", r1.assign.get("p1") === 0 && r1.assign.get("p2") === 1);
    // A が画面から消えた: B は p2 のまま（p1 に付け替えない）
    const r2 = assignMirrorTracked([B], [{ id: "p1", last: A.head }, { id: "p2", last: B.head }], 0.5);
    check("割り当て（対応づけ）: 2 人 → 1 人（A が消えた）で B は p2 のまま・p1 はどの人にも付かない", r2.assign.get("p2") === 0 && !r2.assign.has("p1") && r2.displaced.size === 0);
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
    const r3 = assignMirrorTracked([{ head: [0.1, 0.25, -3], depth: 3 }], [{ id: "p1", last: [0.35, 0.25, -3] }, { id: "p2", last: [0.05, 0.25, -3] }], 0.5);
    check("割り当て（対応づけ）: 1 人を 2 体が指していたら近い方だけ付け、もう一方は displaced（すぐフェード）", r3.assign.get("p2") === 0 && !r3.assign.has("p1") && r3.displaced.has("p1"));
    const r4 = assignMirrorTracked([{ head: [1.8, 0.25, -3], depth: 3 }], [{ id: "p1", last: [-0.5, 0.25, -3] }], 0.5);
    check("割り当て（対応づけ）: 1 体・1 人で、人が遠くへ移った（見失い中に別の人）なら付け替える", r4.assign.get("p1") === 0);
    const r5 = assignMirrorTracked([{ head: [0, 0.25, -3.1], depth: 3.1 }, { head: [0.1, 0.25, -2.2], depth: 2.2 }], [{ id: "p1", last: [0.05, 0.25, -3.05] }], 0.5);
    check("割り当て（対応づけ）: 前の人がいれば、より近い（手前の）人が現れても付け替えない", r5.assign.get("p1") === 0);
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
  check("割り当て: 1 人目 0・2 人目 1・3 人目 2", assignKeshin([]) === 0 && assignKeshin([0]) === 1 && assignKeshin([0, 1]) === 2);
  check("割り当て: 4 人目は 0（全部 1 回ずつ → 最小）、5 人目は 1", assignKeshin([0, 1, 2]) === 0 && assignKeshin([0, 1, 2, 0]) === 1);
  check("割り当て: 0 の人が抜けたら次の人は 0", assignKeshin([1, 2]) === 0 && assignKeshin([2]) === 0 && assignKeshin([0, 2]) === 1);
  check("割り当て: 使われている数が最少の番号のうち最小", assignKeshin([0, 0, 1, 2, 2]) === 1 && assignKeshin([1, 1, 0, 0]) === 2);
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
const PORT = 5221;
const server = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], { stdio: ["ignore", "pipe", "pipe"] });
let portInUse = false;
server.stderr.on("data", (d) => {
  process.stderr.write(d);
  if (/already in use/.test(d.toString())) portInUse = true;
});
server.stdout.on("data", (d) => {
  for (const line of d.toString().split("\n")) if (line.startsWith("[keshin]")) console.log(`  server: ${line}`);
});
let serverExited = false;
server.on("exit", () => {
  serverExited = true;
});
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

async function waitForServer(timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (serverExited || portInUse) return false;
    const res = await fetch(`https://localhost:${PORT}/`).catch(() => null);
    if (res?.ok) return true;
    await sleep(300);
  }
  return false;
}

const clients = [];
function connect(query, name = "") {
  const q = new URLSearchParams({ v: String(KESHIN_PROTOCOL_VERSION), ...query });
  if (name) q.set("name", name);
  const ws = new WebSocket(`wss://localhost:${PORT}${KESHIN_PATH}?${q}`, {
    rejectUnauthorized: false,
    headers: { origin: `https://localhost:${PORT}` },
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
  if (!(await waitForServer())) throw new Error(`dev サーバーが起動しなかった（ポート ${PORT} が使用中でないか確認）`);
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
  check("2 人目は化身 1、3 人目は化身 2（最初の 3 人は別々）", kb === 1 && kc === 2, `${kb} ${kc}`);
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
  check("4 人目は化身 0（全部 1 回ずつ使われていれば最小）", wd?.players.find((p) => p.id === wd.id)?.keshin === 0);

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
  const counts = [0, 0, 0];
  for (const x of [a, c, d, e, ...more]) {
    const w = x.msgs.find((m) => m.type === "welcome");
    counts[w.players.find((p) => p.id === w.id).keshin]++;
  }
  check("8 人の割り当ては偏らない（各番号 2〜3 人）", counts.every((n) => n >= 2 && n <= 3), JSON.stringify(counts));

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
  server.kill();
}
process.exit(exitCode);
