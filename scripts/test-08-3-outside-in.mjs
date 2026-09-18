// 08-3（アウトサイドイン）の回帰テスト。`npm run test:outside-in` で実行する。
//   1. src/shared/outside-in-track.ts — 原点合わせ（カメラ → field）・ゴーグルのマーカーの観測 → 位置とヨー・スマホ側のアンカーの姿勢
//      （フェイクカメラの投影（fake-markers.ts）と往復して、置いた位置とヨーが戻ることを確かめる）
//   2. server/splatoon-outside-in.ts — tracker の役割・trackId の割当・track の受理と tracked の配信・pose の pos の上書き・
//      発射位置の検証がトラッカーの位置で行われること・未測定の shot の拒否・2 台目のトラッカーの拒否と引き継ぎ
//      （Vite dev サーバーを起動して叩く。scripts/test-splatoon.mjs の 4 番目と同じ形）
// テストフレームワークは使わない（04〜08 と同じ方針）。Node 22.18+ は .ts をそのまま import できる
import { spawn } from "node:child_process";
import WebSocket from "ws";
import {
  anchorPose,
  anchorYaw,
  approachAngle,
  camToFieldFromOrigin,
  forwardOfYaw,
  goggleMarkerToField,
  matrixOfQuat,
  parseFakePlayersParam,
  parseFakeTrackCamParam,
  quatOfMatrix,
  trackFromObservation,
  trackQuality,
  wrapAngle,
  yawOfForward,
} from "../src/shared/outside-in-track.ts";
import { fakeCameraToField } from "../src/shared/fake-markers.ts";
import { invertRigid, markerToFieldMatrix, mulMat4, transformPoint } from "../src/shared/marker-layout.ts";
import { SPLATOON_OUTSIDE_IN_PATH, SPLATOON_OUTSIDE_IN_PROTOCOL_VERSION, TRACK_ID_FIRST, TRACK_STALE_MS } from "../src/shared/splatoon-outside-in-protocol.ts";

const results = [];
function check(name, cond, detail = "") {
  results.push([name, cond]);
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${detail ? ` (${detail})` : ""}`);
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const nearV = (a, b, eps = 1e-6) => a.length === b.length && a.every((v, i) => near(v, b[i], eps));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const deg = (d) => (d * Math.PI) / 180;

// ================= 1. outside-in-track.ts =================
// ---- ヨーと向きの往復 ----
check("yawOfForward: -Z（正面の壁）を向くと 0、-X（左）を向くと +90°", near(yawOfForward([0, 0, -1]), 0) && near(yawOfForward([-1, 0, 0]), Math.PI / 2));
check("forwardOfYaw は yawOfForward の逆", [0, 0.3, -1.2, 2.5, -3].every((y) => near(wrapAngle(yawOfForward(forwardOfYaw(y)) - y), 0)));
check("wrapAngle は (-π, π] に畳む", near(wrapAngle(3 * Math.PI), Math.PI) && near(wrapAngle(-3 * Math.PI), Math.PI) && near(wrapAngle(0.5), 0.5));
check("approachAngle は畳んだ差で回る（179° → -179° へは +2° 側から）", near(approachAngle(deg(179), deg(-179), 0.5), wrapAngle(deg(180))));

// ---- クォータニオン ⇄ 行列 ----
{
  const m = fakeCameraToField([1, 2, 3], 40, -20);
  const q = quatOfMatrix(m);
  const back = matrixOfQuat(q, [1, 2, 3]);
  check("quatOfMatrix → matrixOfQuat で回転 + 並進が戻る", m.every((v, i) => near(v, back[i], 1e-9)));
}

// ---- 手計算した固定値（Codex レビューの指摘: 生成側と同じ規約の関数で戻すと符号の取り違えを見逃す）----
// 行列は列優先 16 要素。カメラ座標系は three.js（X 右・Y 上・-Z 前方）、マーカー座標系は +Z = 面から視点側
{
  const nearAngle = (a, b, eps = 1e-6) => Math.abs(wrapAngle(a - b)) <= eps;
  // A. カメラは原点マーカーの正面 2m・同じ高さで壁（-Z）を向く: 回転は単位、位置 (0,0,2)。
  //    ゴーグルはカメラ座標で右 0.3・下 0.2・手前 1.5m にあり、面をカメラへ向けている（回転は単位）
  //    → 部屋座標は (0.3, -0.2, 0.5)。正面（マーカーの +Z）は部屋の +Z（壁と反対）なのでヨーは 180°。
  //    正対の度合い = 1.5 / |t| = 1.5 / 1.54272 = 0.97231
  const camA = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 2, 1];
  const obsA = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.3, -0.2, -1.5, 1];
  const tA = trackFromObservation(obsA, camA, 0);
  check("固定値 A: 正面 2m のカメラ、右下 1.5m 手前のゴーグル → (0.3,-0.2,0.5)・ヨー 180°・正対 0.972", nearV(tA.pos, [0.3, -0.2, 0.5], 1e-9) && nearAngle(tA.yaw, Math.PI) && near(tA.facing, 0.97231, 1e-5), `pos=${tA.pos} yaw=${tA.yaw} facing=${tA.facing}`);
  const tA2 = trackFromObservation(obsA, camA, 0.03);
  check("固定値 A: eyeBackM=0.03 はマーカーの裏（正面 +Z の逆 = 壁側）へ 3cm → (0.3,-0.2,0.47)", nearV(tA2.pos, [0.3, -0.2, 0.47], 1e-9), `${tA2.pos}`);
  // B. カメラは壁側（原点の 0.5m 上・0.2m 手前）から部屋（+Z）を向く: カメラの X = 部屋の -X、Z = 部屋の -Z。
  //    ゴーグルはカメラ座標で左 0.5・下 0.5・手前 1.3m、面をカメラへ向けている
  //    → 部屋座標 (0.5, 0, 1.5)、正面は部屋の -Z（壁）なのでヨー 0、正対 = 1.3 / 1.47986 = 0.87846
  const camB = [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0.5, 0.2, 1];
  const obsB = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -0.5, -0.5, -1.3, 1];
  const tB = trackFromObservation(obsB, camB, 0);
  check("固定値 B: 壁側のカメラ、左下 1.3m 手前のゴーグル → (0.5,0,1.5)・ヨー 0°・正対 0.878", nearV(tB.pos, [0.5, 0, 1.5], 1e-9) && nearAngle(tB.yaw, 0) && near(tB.facing, 0.87846, 1e-5), `pos=${tB.pos} yaw=${tB.yaw} facing=${tB.facing}`);
  // C. B のカメラで、ゴーグルがカメラ座標で Y まわりに +30° 回っている（列: x=(cos30,0,-sin30), y=(0,1,0), z=(sin30,0,cos30)）、
  //    位置は真下 0.5・手前 1.5 → 部屋座標 (0, 0, 1.7)。正面は部屋で (-sin30, 0, -cos30) = 左 30° → ヨー +30°。
  //    正対 = z・(-t/|t|) = (0.5·0 + 0 + 0.866025·1.5) / 1.58114 = 0.82158
  const c30 = Math.cos(deg(30));
  const s30 = Math.sin(deg(30));
  const obsC = [c30, 0, -s30, 0, 0, 1, 0, 0, s30, 0, c30, 0, 0, -0.5, -1.5, 1];
  const tC = trackFromObservation(obsC, camB, 0);
  check("固定値 C: ゴーグルが 30° 左を向く → (0,0,1.7)・ヨー +30°・正対 0.822", nearV(tC.pos, [0, 0, 1.7], 1e-9) && nearAngle(tC.yaw, deg(30)) && near(tC.facing, 0.82158, 1e-5), `pos=${tC.pos} yaw=${tC.yaw} facing=${tC.facing}`);
  // D. カメラは原点マーカーの正面 2m・1.2m 上から 20° 見下ろす（壁向き）。カメラの軸（部屋座標）: X=(1,0,0)、Y=(0,cos20,-sin20)、Z=(0,sin20,cos20)。
  //    ゴーグルはカメラ座標で右 0.4・下 0.3・手前 2.0（回転はカメラと同じ）
  //    → 部屋座標 = R·t + p = (0.4, 1.2 + (cos20·(-0.3) + sin20·(-2.0)), 2.0 + (-sin20·(-0.3) + cos20·(-2.0))) = (0.4, 0.234052, 0.223221)。
  //    正面（マーカーの +Z = カメラの Z）は水平面で +Z なのでヨー 180°
  const c20 = Math.cos(deg(20));
  const s20 = Math.sin(deg(20));
  const camD = [1, 0, 0, 0, 0, c20, -s20, 0, 0, s20, c20, 0, 0, 1.2, 2.0, 1];
  const obsD = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.4, -0.3, -2.0, 1];
  const tD = trackFromObservation(obsD, camD, 0);
  check("固定値 D: 20° 見下ろすカメラ、右下 2m 手前のゴーグル → (0.4,0.234,0.223)・ヨー 180°", nearV(tD.pos, [0.4, 0.234052, 0.223221], 1e-5) && nearAngle(tD.yaw, Math.PI), `pos=${tD.pos} yaw=${tD.yaw}`);
  //    原点合わせ: そのカメラから見た壁の原点マーカー（マーカー → カメラ）は、回転がカメラの回転の転置（列: (1,0,0), (0,cos20,sin20), (0,-sin20,cos20)）、
  //    並進が -Rᵀp = (0, -(1.2cos20 - 2sin20), -(1.2sin20 + 2cos20)) = (0, -0.443591, -2.289809)。ここから camD が戻る
  const originObsD = [1, 0, 0, 0, 0, c20, s20, 0, 0, -s20, c20, 0, 0, -0.443591, -2.289809, 1];
  const lockD = camToFieldFromOrigin(originObsD, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  check("固定値 D: 壁の原点マーカーの観測（手計算）からカメラ → 部屋が戻る（原点合わせ）", lockD.every((v, i) => near(v, camD[i], 1e-5)), lockD.map((v) => v.toFixed(3)).join(","));
  //    床のマーカー（配置 (0,-1.2,1.25)。「上」を壁へ向けて置くので マーカーの X=(1,0,0)、Y=(0,0,-1)、Z=(0,1,0)。marker-layout.ts の
  //    markerAxes("floor") と同じ）を同じカメラで見た観測 = Rᵀ·(markerToField) の手計算。Rᵀv = (c0·v, c1·v, c2·v)、c1=(0,cos20,-sin20)、c2=(0,sin20,cos20):
  //    回転列: x = Rᵀ(1,0,0) = (1,0,0)、y = Rᵀ(0,0,-1) = (0,sin20,-cos20)（ほぼ前方 = 壁の方）、z = Rᵀ(0,1,0) = (0,cos20,sin20)（ほぼ上、少しカメラ側）。
  //    並進: Rᵀ((0,-1.2,1.25) - p) = Rᵀ(0,-2.4,-0.75) = (0, -2.4cos20 + 0.75sin20, -2.4sin20 - 0.75cos20) = (0, -1.998748, -1.525618)（下・前方 = 映る）
  const floorObsD = [1, 0, 0, 0, 0, s20, -c20, 0, 0, c20, s20, 0, 0, -1.998748, -1.525618, 1];
  const floorToField = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, -1.2, 1.25, 1];
  const lockD2 = camToFieldFromOrigin(floorObsD, floorToField);
  check("固定値 D: 床のマーカーの観測（手計算）からも同じカメラ → 部屋が戻る", lockD2.every((v, i) => near(v, camD[i], 1e-5)), lockD2.map((v) => v.toFixed(3)).join(","));
  // スマホ側のアンカー（手計算）: φ = 90°、カメラ (0,1.6,0)、自分の位置 (-0.5,0,1.5)。
  // R_y(90°)·p = (c·x + s·z, y, -s·x + c·z) = (1.5, 0, 0.5) → アンカーの位置 = (0,1.6,0) - (1.5,0,0.5) = (-1.5, 1.6, -0.5)、クォータニオン (0, sin45, 0, cos45)
  const ap = anchorPose(deg(90), [0, 1.6, 0], [-0.5, 0, 1.5]);
  check("固定値: anchorPose(φ=90°) の位置 (-1.5,1.6,-0.5) とクォータニオン (0,0.7071,0,0.7071)", nearV(ap.pos, [-1.5, 1.6, -0.5], 1e-9) && nearV(ap.quat, [0, Math.SQRT1_2, 0, Math.SQRT1_2], 1e-9), `${ap.pos} ${ap.quat}`);
  check("固定値: yawOfForward — +X（右）を向くと -90°、(−0.5, 0, −0.866) は +30°", nearAngle(yawOfForward([1, 0, 0]), -Math.PI / 2) && nearAngle(yawOfForward([-0.5, 0, -0.866025]), deg(30)));
}

// ---- 原点合わせ + ゴーグルの観測の往復（フェイクカメラの姿勢で作った観測から、置いた位置とヨーが戻る。生成側との整合の確認）----
{
  // トラッカーのカメラ: 正面の壁のそば、右寄り、少し上から部屋を見下ろす（headless の既定と同じ）
  const camToField = fakeCameraToField([0.5, 0.5, 0.2], 180, 35);
  const fieldToCam = invertRigid(camToField);
  // 原点候補 = 床のマーカー ID 1（配置 (0, -1.2, 1.25)）。観測（マーカー → カメラ）= fieldToCam × markerToField
  const floor = markerToFieldMatrix({ id: 1, face: "floor", pos: [0, -1.2, 1.25] });
  const floorObs = mulMat4(fieldToCam, floor);
  const recovered = camToFieldFromOrigin(floorObs, floor);
  check("床のマーカーの観測からカメラ → field が戻る（原点合わせ）", recovered.every((v, i) => near(v, camToField[i], 1e-9)));
  // 正面の壁の原点（ID 0）でも同じ
  const wall = markerToFieldMatrix({ id: 0, face: "wall", pos: [0, 0, 0] });
  const recovered2 = camToFieldFromOrigin(mulMat4(fieldToCam, wall), wall);
  check("正面の壁の原点の観測からも同じカメラ → field が戻る", recovered2.every((v, i) => near(v, camToField[i], 1e-9)));
  // ゴーグル: (-0.5, 0, 1.5) でヨー 15°（左を向く）
  const goggle = goggleMarkerToField([-0.5, 0, 1.5], deg(15));
  const goggleObs = mulMat4(fieldToCam, goggle);
  const t = trackFromObservation(goggleObs, recovered, 0);
  check("ゴーグルのマーカーの観測 → field の位置とヨーが戻る", nearV(t.pos, [-0.5, 0, 1.5], 1e-9) && near(t.yaw, deg(15), 1e-9), `pos=${t.pos.map((v) => v.toFixed(3))} yaw=${((t.yaw * 180) / Math.PI).toFixed(2)}`);
  check("ゴーグルの +Z（正面）はヨーの向き、Y は上（右手系）", nearV([goggle[8], goggle[9], goggle[10]], forwardOfYaw(deg(15))) && nearV([goggle[4], goggle[5], goggle[6]], [0, 1, 0]) && near(goggle[0] * goggle[4] + goggle[1] * goggle[5] + goggle[2] * goggle[6], 0));
  // eyeBackM: マーカーの裏（-Z）へ 3cm
  const t2 = trackFromObservation(goggleObs, recovered, 0.03);
  const f = forwardOfYaw(deg(15));
  check("eyeBackM でマーカーの裏へずれる（スマホのカメラの位置）", nearV(t2.pos, [-0.5 - f[0] * 0.03, 0, 1.5 - f[2] * 0.03], 1e-9));
  // 正対の度合い: カメラの方を向いているゴーグル（法線がカメラ向き）は facing > 0.5、背を向けたら 0
  const facingCam = yawOfForward([0.5 - -0.5, 0, 0.2 - 1.5].map((v) => v / Math.hypot(1, 1.3)));
  const tFace = trackFromObservation(mulMat4(fieldToCam, goggleMarkerToField([-0.5, 0, 1.5], facingCam)), recovered, 0);
  const tBack = trackFromObservation(mulMat4(fieldToCam, goggleMarkerToField([-0.5, 0, 1.5], facingCam + Math.PI)), recovered, 0);
  check("カメラの方を向いたゴーグルは facing が高く、背を向けると 0", tFace.facing > 0.85 && tBack.facing === 0, `face=${tFace.facing.toFixed(2)} back=${tBack.facing}`);
  check("品質 = 大きさ（fullPx で頭打ち）× 正対", near(trackQuality(30, 1, 60), 0.5) && near(trackQuality(200, 0.8, 60), 0.8) && trackQuality(30, -0.2, 60) === 0);
  // 実寸の比: 検出器は原点の実寸（150mm）で作るので、60mm のゴーグルの並進は 60/150 倍される想定 → 並進を k 倍して戻す
  const k = 0.06 / 0.15;
  const scaledObs = goggleObs.slice();
  scaledObs[12] /= k;
  scaledObs[13] /= k;
  scaledObs[14] /= k;
  const fixed = scaledObs.slice();
  fixed[12] *= k;
  fixed[13] *= k;
  fixed[14] *= k;
  check("実寸の比で並進を直すと元の位置に戻る（1 つの検出器で 2 種類の実寸を扱う根拠）", nearV(trackFromObservation(fixed, recovered, 0).pos, [-0.5, 0, 1.5], 1e-9));
}

// ---- スマホ側のアンカー: φ とアンカーの姿勢 ----
{
  // ワールド（ジャイロ）でカメラが -X（左、ヨー +90°）を向いていて、トラッカーは「正面の壁を向いている（ヨー 0）」と言う → φ = 90°
  const phi = anchorYaw(deg(90), 0);
  check("anchorYaw = ワールドのヨー − トラッカーのヨー", near(phi, deg(90)));
  // アンカー × posField = カメラ位置
  const camPos = [0, 1.6, 0];
  const posField = [-0.5, 0, 1.5];
  const a = anchorPose(phi, camPos, posField);
  const m = matrixOfQuat(a.quat, a.pos);
  check("anchorPose: アンカー × 自分の field 位置 = カメラのワールド位置", nearV(transformPoint(m, posField), camPos, 1e-9));
  // field の -Z（正面の壁の向き）をワールドへ回すと、カメラの向き（-X）になる
  const fw = transformPoint(m, [posField[0], posField[1], posField[2] - 1]);
  check("anchorPose: field の正面（-Z）がワールドでカメラの向き（-X）になる", nearV([fw[0] - camPos[0], fw[1] - camPos[1], fw[2] - camPos[2]], [-1, 0, 0], 1e-9));
  // 上は変わらない（Y 回転だけ）
  const up = transformPoint(m, [posField[0], posField[1] + 1, posField[2]]);
  check("anchorPose は Y 回転だけ（field の上 = ワールドの上）", nearV([up[0] - camPos[0], up[1] - camPos[1], up[2] - camPos[2]], [0, 1, 0], 1e-9));
  // ジャイロのヨーがドリフトした（ワールドのカメラのヨーが +5° ずれた）とき、目標の φ は 5° 増え、approachAngle で 10% ずつ寄る
  const target = anchorYaw(deg(95), 0);
  const step = approachAngle(phi, target, 0.1);
  check("ヨーの補正は角度差の alpha ぶんだけ（ドリフト 5° → 1 回で 0.5°）", near(step, deg(90.5), 1e-9));
}

// ---- URL パラメータ ----
{
  const fp = parseFakePlayersParam("10:-0.5,0,1.5,0;11:0.5,0,1.5,15;x:1,2,3,4;12:1,2");
  check("parseFakePlayersParam: 正しい要素だけ", fp.length === 2 && fp[0].id === 10 && nearV(fp[0].pos, [-0.5, 0, 1.5]) && fp[1].yawDeg === 15);
  const fc = parseFakeTrackCamParam("0.5,0.5,0.2,180,35", { pos: [0, 0, 0], yawDeg: 0, pitchDeg: 0 });
  const fcBad = parseFakeTrackCamParam("1,2", { pos: [9, 9, 9], yawDeg: 1, pitchDeg: 2 });
  check("parseFakeTrackCamParam: 5 つの数値、足りなければ既定", nearV(fc.pos, [0.5, 0.5, 0.2]) && fc.yawDeg === 180 && fc.pitchDeg === 35 && fcBad.pos[0] === 9);
}

// ================= 2. server =================
const PORT = 5198;
const server = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], { stdio: ["ignore", "pipe", "pipe"] });
server.stderr.on("data", (d) => process.stderr.write(d));
const serverLines = [];
server.stdout.on("data", (d) => {
  for (const line of d.toString().split("\n")) {
    if (!line.startsWith("[splatoon-oi]")) continue;
    serverLines.push(line);
    console.log(line);
  }
});
let serverExited = false;
server.on("exit", () => {
  serverExited = true;
});
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

async function waitForServer(timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (serverExited) return false;
    const res = await fetch(`https://localhost:${PORT}/`).catch(() => null);
    if (res?.ok) return true;
    await sleep(300);
  }
  return false;
}

function connect(query, name = "") {
  const q = new URLSearchParams({ v: String(SPLATOON_OUTSIDE_IN_PROTOCOL_VERSION), ...query });
  if (name) q.set("name", name);
  const ws = new WebSocket(`wss://localhost:${PORT}${SPLATOON_OUTSIDE_IN_PATH}?${q}`, {
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
  return client;
}

let exitCode = 1;
try {
  if (!(await waitForServer())) throw new Error(`dev サーバーが起動しなかった（ポート ${PORT} が使用中でないか確認）`);
  const cfg = { room: "test", markerId: "0", markerMm: "150", matchSec: "20", waitSec: "1" };
  const a = connect(cfg, "Alice");
  const wa = await a.waitFor((m) => m.type === "welcome");
  check("welcome: player に trackId（入室順に 10 から）と trackIds・tracker の状態（未接続）", wa && wa.role === "player" && wa.trackId === TRACK_ID_FIRST && wa.trackIds[wa.id] === TRACK_ID_FIRST && wa.tracker.connected === 0 && wa.tracker.locked === false && wa.state.phase === "practice", JSON.stringify({ trackId: wa?.trackId, tracker: wa?.tracker }));
  const b = connect(cfg, "Bob");
  const wb = await b.waitFor((m) => m.type === "welcome");
  check("2 人目は trackId 11、trackIds に 2 人ぶん", wb && wb.trackId === TRACK_ID_FIRST + 1 && wb.trackIds[wa.id] === TRACK_ID_FIRST && wb.trackIds[wb.id] === TRACK_ID_FIRST + 1);
  const joinB = await a.waitFor((m) => m.type === "join" && m.id === wb.id);
  check("join に trackId が付く", joinB && joinB.trackId === TRACK_ID_FIRST + 1);

  // トラッカー以外の track は拒否
  b.send({ type: "track", locked: true, players: [{ id: 10, pos: [0, 0, 1], yaw: 0, quality: 1 }] });
  const rejTrack = await b.waitFor((m) => m.type === "rejected" && /tracker/.test(m.reason));
  check("プレイヤーからの track は rejected: not tracker", rejTrack !== null);

  // 未測定のプレイヤー（Codex レビューの指摘）: 自己申告の pose は配られず、shot は "not tracked yet" で拒否される
  b.send({ type: "pose", pos: [0, 0, 2.3], quat: [0, 0, 0, 1], tracking: true, fist: false });
  await sleep(100);
  b.send({ type: "shot", pos: [0, 0, 2], vel: [0, 0, -5], radius: 0.09 });
  const rejUntracked = await b.waitFor((m) => m.type === "rejected" && /tracked/.test(m.reason));
  check("一度も測定されていないプレイヤーの shot は rejected: not tracked yet（自己申告の pose で頭位置を作れない）", rejUntracked !== null && rejUntracked.reason === "not tracked yet", rejUntracked?.reason);
  check("一度も測定されていないプレイヤーの pose は配られない", !a.msgs.some((m) => m.type === "pose" && m.id === wb.id));

  // トラッカーの接続: welcome に trackIds、全員に tracked（未確定）が届く
  const tr = connect({ ...cfg, role: "tracker" });
  const wtr = await tr.waitFor((m) => m.type === "welcome");
  check("トラッカーの welcome: role=tracker・trackIds に 2 人・peers はプレイヤー 2 人", wtr && wtr.role === "tracker" && wtr.trackIds[wa.id] === 10 && wtr.trackIds[wb.id] === 11 && wtr.peers.length === 2);
  const trackedConn = await a.waitFor((m) => m.type === "tracked" && m.tracker.connected === 1);
  check("トラッカーの接続で tracked（connected=1・未確定・players 空）が全員に届く", trackedConn && trackedConn.tracker.locked === false && trackedConn.players.length === 0);
  await sleep(100);
  check("トラッカーの入室で join は配られず、プレイヤー一覧にも入らない", !a.msgs.some((m) => m.type === "join" && m.id === wtr.id) && !a.msgs.some((m) => m.type === "state" && m.state.players.some((p) => p.id === wtr.id)));

  // 未確定の track: players は捨てられ、locked=false のまま
  tr.send({ type: "track", locked: false, players: [{ id: 10, pos: [-0.5, 0, 1.5], yaw: 0, quality: 0.9 }] });
  const unlocked = await tr.waitFor((m) => m.type === "tracked" && m.players.length === 0 && m.tracker.connected === 1, 1000);
  await sleep(100);
  check("原点未確定の track は位置を配らない", unlocked !== null && !a.msgs.some((m) => m.type === "tracked" && m.players.length > 0));

  // 確定後の track: マーカー 10 → p1、11 → p2、知らない 12 は捨てる
  tr.send({ type: "track", locked: true, players: [{ id: 10, pos: [-0.5, 0, 1.5], yaw: 0, quality: 0.9 }, { id: 11, pos: [0.5, 0, 1.5], yaw: 0.26, quality: 0.7 }, { id: 12, pos: [0, 0, 2], yaw: 0, quality: 1 }] });
  const trackedA = await a.waitFor((m) => m.type === "tracked" && m.players.length > 0);
  check("track がプレイヤーに引き当てられて全員に tracked で届く（知らない ID は捨てる）", trackedA && trackedA.tracker.locked === true && trackedA.players.length === 2 && trackedA.players.find((p) => p.player === wa.id)?.id === 10 && trackedA.players.find((p) => p.player === wb.id)?.pos[0] === 0.5, JSON.stringify(trackedA?.players));
  const trackedB = await b.waitFor((m) => m.type === "tracked" && m.players.length > 0);
  const trackedTr = await tr.waitFor((m) => m.type === "tracked" && m.players.length > 0);
  check("tracked は他のプレイヤーとトラッカー自身にも届く", trackedB !== null && trackedTr !== null);

  // 不正な track は捨てられる（quality 範囲外・pos の要素数・yaw が数値でない）
  tr.send({ type: "track", locked: true, players: [{ id: 10, pos: [9, 9, 9], yaw: 0, quality: 2 }] });
  tr.send({ type: "track", locked: true, players: [{ id: 10, pos: [9, 9], yaw: 0, quality: 1 }] });
  tr.send({ type: "track", locked: true, players: [{ id: 10, pos: [9, 9, 9], yaw: "0", quality: 1 }] });
  await sleep(150);
  check("不正な track（quality > 1・pos の長さ・yaw の型）は捨てられる", !a.msgs.some((m) => m.type === "tracked" && m.players.some((p) => p.pos[0] === 9)));

  // pose: pos がトラッカーの値で上書きされて配られる。発射位置の検証もその位置で
  b.send({ type: "pose", pos: [3, 3, 3], quat: [0, 0, 0, 1], tracking: true, fist: false });
  const poseB = await a.waitFor((m) => m.type === "pose" && m.id === wb.id);
  check("pose の pos はトラッカーの測定値（0.5,0,1.5）で上書きされて配られる（自己申告 (3,3,3) ではない）", poseB && nearV(poseB.pos, [0.5, 0, 1.5]), JSON.stringify(poseB?.pos));
  // 頭（測定値 (0.5,0,1.5)）から 1.2m 以内なら受理、自己申告の (3,3,3) の近くは拒否
  b.send({ type: "shot", pos: [2.9, 2.9, 2.5], vel: [0, 0, -5], radius: 0.09 });
  const rejFar = await b.waitFor((m) => m.type === "rejected" && /head/.test(m.reason));
  check("自己申告の位置の近くからの発射は「too far from head」（検証は測定値で行われる）", rejFar !== null, rejFar?.reason);
  b.send({ type: "shot", pos: [0.5, 0, 1.3], vel: [0, 0, -5], radius: 0.09 });
  const shotB = await a.waitFor((m) => m.type === "shot" && m.shot.by === wb.id);
  check("測定値の近くからの発射は受理され、着弾（壁）が全員に配られる", shotB && shotB.shot.landing?.surfaceId === "wall");

  // 見失った後（TRACK_STALE_MS = 2s 超過）も最後の測定値を基準にする（自己申告には戻らない）
  await sleep(TRACK_STALE_MS + 300);
  b.send({ type: "pose", pos: [3, 3, 3], quat: [0, 0, 0, 1], tracking: false, fist: false });
  const poseStale = await a.waitFor((m) => m.type === "pose" && m.id === wb.id && m.tracking === false);
  check("見失って 2 秒過ぎた後の pose も最後の測定値 (0.5,0,1.5) で配られる（自己申告 (3,3,3) には戻らない）", poseStale && nearV(poseStale.pos, [0.5, 0, 1.5]), JSON.stringify(poseStale?.pos));
  b.send({ type: "shot", pos: [2.9, 2.9, 2.5], vel: [0, 0, -5], radius: 0.09 });
  const rejFarStale = await b.waitFor((m) => m.type === "rejected" && /head/.test(m.reason) && b.msgs.indexOf(m) > b.msgs.indexOf(rejFar));
  check("見失った後も自己申告の位置からの発射は too far from head（最後の測定位置が基準）", rejFarStale !== null, rejFarStale?.reason);
  b.send({ type: "shot", pos: [0.5, 0, 1.3], vel: [0, 0, -5], radius: 0.09 });
  const shotStale = await a.waitFor((m) => m.type === "shot" && m.shot.by === wb.id && m.shot.seq !== shotB.shot.seq);
  check("見失った後も最後の測定位置の近くからは撃てる", shotStale !== null);

  // 2 台目のトラッカー（Codex レビューの指摘）: 接続はできるが track は "not active tracker" で拒否され、所有者が切断したら引き継ぐ
  const tr2 = connect({ ...cfg, role: "tracker" });
  const wtr2 = await tr2.waitFor((m) => m.type === "welcome");
  check("2 台目のトラッカーも welcome を受け取り、connected=2", wtr2 && wtr2.role === "tracker" && wtr2.tracker.connected === 2);
  tr2.send({ type: "track", locked: true, players: [{ id: 10, pos: [9, 0, 9], yaw: 0, quality: 1 }] });
  const rejTr2 = await tr2.waitFor((m) => m.type === "rejected" && /active tracker/.test(m.reason));
  await sleep(100);
  check("2 台目の track は rejected: not active tracker で、位置は配られない", rejTr2 !== null && !a.msgs.some((m) => m.type === "tracked" && m.players.some((p) => p.pos[0] === 9)), rejTr2?.reason);
  check("2 台目の track で locked は変わらない（1 台目のまま確定）", (await a.waitFor((m) => m.type === "tracked" && m.tracker.connected === 2))?.tracker.locked === true);

  // マーカーの割当: 退室すると番号が空き、次の人が使う
  b.ws.close();
  const leave = await a.waitFor((m) => m.type === "leave" && m.id === wb.id);
  check("leave が届く", leave !== null);
  const c = connect(cfg, "Carol");
  const wc = await c.waitFor((m) => m.type === "welcome");
  check("退室で空いた trackId（11）を次の入室者が使う", wc && wc.trackId === 11 && wc.tracker.connected === 2 && wc.tracker.locked === true, JSON.stringify({ trackId: wc?.trackId, tracker: wc?.tracker }));

  // 俯瞰画面は start を送れ、トラッカーは送れない
  const ov = connect({ ...cfg, role: "overview" });
  const wov = await ov.waitFor((m) => m.type === "welcome");
  check("俯瞰画面の welcome に trackIds と tracker の状態", wov && wov.role === "overview" && wov.trackIds[wc.id] === 11 && wov.tracker.connected === 2);
  tr.send({ type: "start" });
  const rejStart = await tr.waitFor((m) => m.type === "rejected" && /overview/.test(m.reason));
  check("トラッカーからの start は rejected: not overview", rejStart !== null);
  ov.send({ type: "start" });
  const cd = await a.waitFor((m) => m.type === "state" && m.state.phase === "waiting");
  check("俯瞰画面の start でカウントダウンが配られる（08 と同じ進行）", cd !== null);

  // 所有者のトラッカーの退室: 2 台目が引き継ぎ（原点は未確定から）、その track が受理されるようになる
  // waitFor は全メッセージを探すので、退室前の tracked（connected=1）に当たらないよう退室後の分だけ見る
  const idxBeforeLeave = a.msgs.length;
  tr.ws.close();
  const trackedHandover = await a.waitFor((m) => m.type === "tracked" && m.tracker.connected === 1 && a.msgs.indexOf(m) >= idxBeforeLeave);
  check("所有者の退室で tracked（connected=1・未確定）が届く（2 台目が引き継ぐ）", trackedHandover && trackedHandover.tracker.locked === false);
  await sleep(200);
  check("サーバーが引き継ぎを記録している", serverLines.some((l) => new RegExp(`${wtr2.id} is now the active tracker`).test(l)));
  tr2.send({ type: "track", locked: true, players: [{ id: 11, pos: [0.7, 0, 1.6], yaw: 0.1, quality: 0.8 }] });
  const trackedByTr2 = await a.waitFor((m) => m.type === "tracked" && m.players.some((p) => p.player === wc.id && p.pos[0] === 0.7));
  check("引き継いだ 2 台目の track が受理されて配られる", trackedByTr2 !== null && trackedByTr2.tracker.locked === true);
  const leavesTr = a.msgs.filter((m) => m.type === "leave" && m.id === wtr.id).length;
  check("トラッカーの退室で leave は配られない", leavesTr === 0);
  tr2.ws.close();
  const trackedGone = await a.waitFor((m) => m.type === "tracked" && m.tracker.connected === 0);
  check("最後のトラッカーの退室で tracked（connected=0・未確定）が届く", trackedGone && trackedGone.tracker.locked === false);

  // マーカー ID の衝突（Fable レビューの指摘）: ゴーグル用の trackId は原点マーカー（room 設定の markerId）を避け、
  // 追加マーカーの配置は TRACK_ID_FIRST 以上・割当済みの trackId と重なるものを拒否する
  {
    const cfgClash = { ...cfg, room: "clash", markerId: String(TRACK_ID_FIRST) };
    const d = connect(cfgClash, "Dave");
    const wd = await d.waitFor((m) => m.type === "welcome");
    const e = connect(cfgClash, "Eve");
    const we = await e.waitFor((m) => m.type === "welcome");
    check("trackId の割当は原点マーカーの ID（markerId=10）を避ける（10 は飛ばして 11, 12）", wd && we && wd.trackId === TRACK_ID_FIRST + 1 && we.trackId === TRACK_ID_FIRST + 2, JSON.stringify({ d: wd?.trackId, e: we?.trackId }));
    const ovc = connect({ ...cfgClash, role: "overview" });
    await ovc.waitFor((m) => m.type === "welcome");
    ovc.send({ type: "markers", markers: [{ id: TRACK_ID_FIRST + 1, face: "floor", pos: [0, -1.2, 1.25] }] });
    const rejAssigned = await ovc.waitFor((m) => m.type === "rejected" && /ゴーグル/.test(m.reason));
    ovc.send({ type: "markers", markers: [{ id: 1, face: "floor", pos: [0, -1.2, 1.25] }, { id: 20, face: "left", pos: [-1.5, 0, 1] }] });
    await sleep(200);
    const rejCount = ovc.msgs.filter((m) => m.type === "rejected" && /ゴーグル/.test(m.reason)).length;
    check("割当済みの trackId（11）や TRACK_ID_FIRST 以上（20）の追加マーカーの配置は rejected で、配られない", rejAssigned !== null && rejCount === 2 && !d.msgs.some((m) => m.type === "markers"), `${rejAssigned?.reason} count=${rejCount}`);
    ovc.send({ type: "markers", markers: [{ id: 1, face: "floor", pos: [0, -1.2, 1.25] }] });
    const okMarkers = await d.waitFor((m) => m.type === "markers");
    check("衝突しない配置（ID 1）は受理されて配られる", okMarkers && okMarkers.config.markers.length === 1 && okMarkers.config.markers[0].id === 1);
    d.ws.close();
    e.ws.close();
    ovc.ws.close();
  }

  // プロトコルバージョン / 08 のサーバーとは別パス
  const bad = connect({ ...cfg, v: "99" });
  const err = await bad.waitFor((m) => m.type === "error");
  check("バージョン不一致は入室拒否", err && /バージョン/.test(err.reason));

  a.ws.close();
  c.ws.close();
  ov.ws.close();
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
