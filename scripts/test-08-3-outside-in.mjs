// 08-3（アウトサイドイン）の回帰テスト。`npm run test:outside-in` で実行する。
//   1. src/shared/outside-in-track.ts — 原点合わせ（カメラ → field）・ゴーグルのマーカーの観測 → 位置とヨー・スマホ側のアンカーの姿勢
//      （フェイクカメラの投影（fake-markers.ts）と往復して、置いた位置とヨーが戻ることを確かめる）
//   2. server/splatoon-outside-in.ts — tracker の役割・trackId の割当・track の受理と tracked の配信・pose の pos の上書き・
//      発射位置の検証がトラッカーの位置で行われること（Vite dev サーバーを起動して叩く。scripts/test-splatoon.mjs の 4 番目と同じ形）
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
import { SPLATOON_OUTSIDE_IN_PATH, SPLATOON_OUTSIDE_IN_PROTOCOL_VERSION, TRACK_ID_FIRST } from "../src/shared/splatoon-outside-in-protocol.ts";

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

// ---- 原点合わせ + ゴーグルの観測の往復（フェイクカメラの姿勢で作った観測から、置いた位置とヨーが戻る）----
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

  // マーカーの割当: 退室すると番号が空き、次の人が使う
  b.ws.close();
  const leave = await a.waitFor((m) => m.type === "leave" && m.id === wb.id);
  check("leave が届く", leave !== null);
  const c = connect(cfg, "Carol");
  const wc = await c.waitFor((m) => m.type === "welcome");
  check("退室で空いた trackId（11）を次の入室者が使う", wc && wc.trackId === 11 && wc.tracker.connected === 1 && wc.tracker.locked === true, JSON.stringify({ trackId: wc?.trackId, tracker: wc?.tracker }));

  // 俯瞰画面は start を送れ、トラッカーは送れない
  const ov = connect({ ...cfg, role: "overview" });
  const wov = await ov.waitFor((m) => m.type === "welcome");
  check("俯瞰画面の welcome に trackIds と tracker の状態", wov && wov.role === "overview" && wov.trackIds[wc.id] === 11 && wov.tracker.connected === 1);
  tr.send({ type: "start" });
  const rejStart = await tr.waitFor((m) => m.type === "rejected" && /overview/.test(m.reason));
  check("トラッカーからの start は rejected: not overview", rejStart !== null);
  ov.send({ type: "start" });
  const cd = await a.waitFor((m) => m.type === "state" && m.state.phase === "waiting");
  check("俯瞰画面の start でカウントダウンが配られる（08 と同じ進行）", cd !== null);

  // トラッカーの退室: 全員に tracked（connected=0・未確定）
  tr.ws.close();
  const trackedGone = await a.waitFor((m) => m.type === "tracked" && m.tracker.connected === 0);
  check("トラッカーの退室で tracked（connected=0・未確定）が届く", trackedGone && trackedGone.tracker.locked === false);
  const leavesTr = a.msgs.filter((m) => m.type === "leave" && m.id === wtr.id).length;
  check("トラッカーの退室で leave は配られない", leavesTr === 0);

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
