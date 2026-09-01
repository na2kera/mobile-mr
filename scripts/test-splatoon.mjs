// Phase 8 (08-splatoon) の回帰テスト。`npm run test:splatoon` で実行する。
//   1. src/shared/splatoon-sim.ts — Surface（壁 + 床）の UV・視線の交点・放物線の着弾・塗りの格子
//   2. src/shared/hand-math.ts — グー / パー / 指差しの判定（合成の手の形で）
//   3. src/shared/splatoon-game.ts — チーム割当・試合の時間・発射の検証・得点
//   4. server/splatoon.ts — WebSocket の受け付け・shot の配信・state の配信（Vite dev サーバーを起動して叩く）
// テストフレームワークは使わない（04〜07 と同じ方針）。Node 22.18+ は .ts をそのまま import できる
import { spawn } from "node:child_process";
import WebSocket from "ws";
import {
  DEFAULT_FIELD,
  FLOOR_ID,
  InkGrid,
  WALL_ID,
  fieldSurfaces,
  inkPerShot,
  framePointToUv,
  frameUvToPoint,
  inkAt,
  rayFrameHit,
  simulateInk,
} from "../src/shared/splatoon-sim.ts";
import { SHOT_RATE_PER_SEC, SplatoonGame } from "../src/shared/splatoon-game.ts";
import { handShape } from "../src/shared/hand-math.ts";
import { centered, syntheticHandShape } from "../src/shared/fake-hands.ts";
import { SPLATOON_PATH, SPLATOON_PROTOCOL_VERSION } from "../src/shared/splatoon-protocol.ts";

const results = [];
function check(name, cond, detail = "") {
  results.push([name, cond]);
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${detail ? ` (${detail})` : ""}`);
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ================= 1. sim =================
{
  const cfg = { ...DEFAULT_FIELD, wallW: 2, wallH: 1, floorDrop: 1, floorDepth: 1.5 };
  const [wall, floor] = fieldSurfaces(cfg);
  check("壁の法線は +Z、床の法線は +Y", wall.normal[2] === 1 && floor.normal[1] === 1);
  const wtl = frameUvToPoint(wall, [0, 0]);
  check("壁: UV (0,0) は左上 (-w/2, +h/2, 0)", near(wtl[0], -1) && near(wtl[1], 0.5) && near(wtl[2], 0));
  const ftl = frameUvToPoint(floor, [0, 0]);
  check("床: UV (0,0) は壁際の左 (-w/2, -floorDrop, 0)", near(ftl[0], -1) && near(ftl[1], -1) && near(ftl[2], 0));
  const fbr = frameUvToPoint(floor, [1, 1]);
  check("床: UV (1,1) は部屋側の右 (+w/2, -floorDrop, floorDepth)", near(fbr[0], 1) && near(fbr[1], -1) && near(fbr[2], 1.5));
  const rt = framePointToUv(floor, frameUvToPoint(floor, [0.3, 0.8]));
  check("床: UV → 点 → UV は恒等", near(rt[0], 0.3) && near(rt[1], 0.8));

  const h = rayFrameHit(floor, [0, 0, 1], [0, -1, 0]);
  check("視線: 真下を見ると床の (0.5, 1/1.5) に当たる", h && h.inside && near(h.uv[0], 0.5) && near(h.uv[1], 1 / 1.5));
  check("視線: 裏側（床の下）からは当たらない", rayFrameHit(floor, [0, -2, 1], [0, 1, 0]) === null);

  // 放物線: 壁の 2m 手前、目の高さ（y=0）から水平に 5m/s → 0.4s で壁、その間に落ちる分は 0.5·4·0.16 = 0.32m
  const l1 = simulateInk([0, 0, 2], [0, 0, -5], [wall, floor], cfg);
  check("壁に当たる（t=0.4s、y=-0.32）", l1 && l1.surfaceId === WALL_ID && near(l1.hitT, 0.4) && near(l1.point[1], -0.32) && near(l1.uv[1], 0.5 + 0.32));
  // 遅い球は壁の手前で床へ: 1m/s → 壁まで 2s、床（y=-1）へは 0.5·4·t² = 1 → t = 0.707s
  const l2 = simulateInk([0, 0, 2], [0, 0, -1], [wall, floor], cfg);
  check("遅い球は先に床へ落ちる（t≈0.707s）", l2 && l2.surfaceId === FLOOR_ID && near(l2.hitT, Math.sqrt(0.5), 1e-6) && near(l2.point[2], 2 - Math.sqrt(0.5)));
  check("床の UV: 壁からの距離 / floorDepth", l2 && near(l2.uv[1], (2 - Math.sqrt(0.5)) / 1.5) && near(l2.uv[0], 0.5));
  // 上向きに撃つと放物線の下りで床へ（上りで面をまたがない）
  const l3 = simulateInk([0, 0, 1], [0, 2, -0.5], [wall, floor], cfg);
  check("山なりで床へ", l3 && l3.surfaceId === FLOOR_ID && l3.hitT > 1);
  // 範囲外（壁の横）は当たらず、床の範囲も外れれば null
  const l4 = simulateInk([3, 0, 0.5], [0, 0, -5], [wall, floor], cfg);
  check("矩形の外で面を横切ると hit=false の着弾（突き抜けない）", l4 && l4.hit === false && l4.surfaceId === WALL_ID && near(l4.hitT, 0.1));
  const l4b = simulateInk([0, 3, 2], [0, 5, 0], [wall, floor], cfg);
  check("どの面にも届かなければ null", l4b === null);
  // 壁の裏（z<0）から +Z へ撃っても壁には当たらない（表側からだけ）
  const l5 = simulateInk([0, 0, -1], [0, 0, 5], [wall, floor], cfg);
  check("壁の裏側からは当たらない", l5 === null || l5.surfaceId !== WALL_ID);
  const p = inkAt([0, 0, 2], [0, 0, -5], 0.4, 4);
  check("inkAt の放物線", near(p[1], -0.32) && near(p[2], 0));

  check("inkPerShot: タンク = tankShots 発", near(inkPerShot(cfg) * cfg.tankShots, 1));

  // 格子
  const g = new InkGrid(wall, 0.1);
  check("格子の大きさ: 2m × 1m / 0.1m = 20 × 10", g.cols === 20 && g.rows === 10);
  const n = g.stamp([0.5, 0.5], 0.1, 1);
  check("中心に半径 0.1（1 セル）を塗ると数セル", n >= 1 && n <= 5, `${n} cells`);
  const c1 = g.counts();
  check("counts: A が塗った分", c1[1] === n && c1[2] === 0 && c1[0] === 200 - n);
  const n2 = g.stamp([0.5, 0.5], 0.1, 2);
  check("同じ場所を B が塗ると上書き（塗り替え数 = 同じ）", n2 === n && g.counts()[1] === 0 && g.counts()[2] === n);
  const n3 = g.stamp([0.5, 0.5], 0.1, 2);
  check("同じ色で塗り直しは 0", n3 === 0);
  g.stamp([0, 0], 0.15, 1);
  const enc = g.encode();
  const g2 = new InkGrid(wall, 0.1);
  g2.decode(enc);
  check("encode / decode で同じ格子", enc.length === 200 && g2.counts().join() === g.counts().join());
  check("角（UV 0,0）を塗ってもはみ出さない", g.counts()[1] > 0);
}

// ================= 2. hand shape =================
{
  const toWorld = (pose) => centered(syntheticHandShape(pose)).map((p) => ({ x: p.x, y: -p.y, z: p.z }));
  check("合成の手: open → パー", handShape(toWorld("open")) === "open");
  check("合成の手: fist → グー", handShape(toWorld("fist")) === "fist");
  check("合成の手: point → 指差し", handShape(toWorld("point")) === "point");
}

// ================= 3. game =================
{
  const g = new SplatoonGame({ matchSec: 30, resultSec: 2, wallW: 2, wallH: 1 });
  check("開始前は tick しても何も起きない", g.tick(0).length === 0);
  const e1 = g.join("p1", "A", 1000);
  check("最初の入室で試合開始（A チーム）", e1[0]?.kind === "start" && g.players.get("p1").team === 1 && g.phase === "play" && g.phaseEndsAt === 31000);
  g.join("p2", "B", 1100);
  g.join("p3", "C", 1200);
  check("参加順に交互（B → A）", g.players.get("p2").team === 2 && g.players.get("p3").team === 1);
  g.leave("p1");
  g.join("p4", "D", 1300);
  check("少ない方のチームへ（A が抜けたので A）", g.players.get("p4").team === 1);

  // レート制限（6/s）は検証より先に数えるので、検証のテストは 1.1 秒ずつ離して呼ぶ
  let tm = 2000;
  const next = () => (tm += 1100);
  check("発射: pose が届く前は拒否", g.shoot("p2", [0, 0, 2], [0, 0, -5], 0.06, next()) === null && g.lastRejectReason === "no pose yet");
  g.updatePose("p2", [0, 0.1, 2.3], 1500);
  g.updatePose("p3", [0, 0, 2.3], 1500);
  g.updatePose("p4", [1.5, 0, 0.8], 1500);
  check("発射: 頭から 1.2m 以上離れた位置からは拒否", g.shoot("p2", [0, 0, 0.3], [0, 0, -5], 0.06, next()) === null && g.lastRejectReason === "too far from head");
  const shot = g.shoot("p2", [0, 0, 2], [0, 0, -5], 0.06, next());
  check("発射: 受理され着弾（壁）と格子への塗りが起きる", shot && shot.team === 2 && shot.landing?.surfaceId === WALL_ID && g.scores()[1] > 0);
  check("発射: 速すぎる", g.shoot("p2", [0, 0, 2], [0, 0, -(g.config.shotSpeed * 1.5)], 0.06, next()) === null && g.lastRejectReason === "bad velocity/radius");
  check("発射: 半径が違う", g.shoot("p2", [0, 0, 2], [0, 0, -3], 0.2, next()) === null && g.lastRejectReason === "bad velocity/radius");
  g.updatePose("p2", [0, 0, -0.5], 1500);
  check("発射: 壁の裏（z<0）から", g.shoot("p2", [0, 0, -1], [0, 0, 3], 0.06, next()) === null && g.lastRejectReason === "bad position");
  g.updatePose("p2", [0, 0.1, 2.3], 1500);
  check("発射: 知らないプレイヤー", g.shoot("zz", [0, 0, 2], [0, 0, -3], 0.06, next()) === null);
  let ok = 0;
  const t0 = next();
  for (let i = 0; i < SHOT_RATE_PER_SEC + 3; i++) if (g.shoot("p3", [0, 0, 2], [0, 0, -3], 0.06, t0 + i)) ok++;
  check(`発射: 1 人 ${SHOT_RATE_PER_SEC}/s まで`, ok === SHOT_RATE_PER_SEC && g.lastRejectReason === "rate limited");
  const scoreBefore = g.scores().join();
  const miss = g.shoot("p4", [1.5, 0, 0.5], [3, 0, -1], 0.06, next());
  check("外れた発射も受理される（hit=false、塗らない）", miss && miss.landing?.hit === false && g.scores().join() === scoreBefore);

  const before = g.scores();
  check("ここまでの発射は試合時間内", tm < 31000, `${tm}`);
  const ev = g.tick(31000);
  check("時間切れで result（勝者は多い方）", ev[0]?.kind === "result" && g.phase === "result" && ev[0].winner === (before[0] > before[1] ? 1 : 2));
  check("result 中は発射できない", g.shoot("p2", [0, 0, 2], [0, 0, -3], 0.06, 31500) === null && g.lastRejectReason === "not playing");
  const ev2 = g.tick(33000);
  check("結果表示が終わると次の試合（格子は消える）", ev2[0]?.kind === "start" && g.phase === "play" && g.scores()[0] === 0 && g.scores()[1] === 0);
  const snap = g.snapshot(33000, true);
  check("snapshot: grids は壁と床、totalCells は両方の和", Object.keys(snap.grids).length === 2 && snap.totalCells === snap.grids.wall.length + snap.grids.floor.length);
  check("snapshot: ink に各プレイヤーの残量", typeof snap.ink.p2 === "number" && snap.ink.p2 <= 1);
}

// ================= 3b. インクタンク =================
{
  const g = new SplatoonGame({ matchSec: 300, wallW: 2, wallH: 1 });
  g.join("p1", "A", 0);
  g.updatePose("p1", [0, 0.1, 1], 0);
  const cost = inkPerShot(g.config);
  // 満タンから「拒否されるまで」連射（250ms 間隔 = 4/s なのでレート制限には当たらない）。
  // 撃っている間も自然回復（満タン 20s = 1 発間隔で 0.0125）するので tankShots より数発多く撃てる
  let fired = 0;
  let t = 1000;
  for (let i = 0; i < 30; i++) {
    if (g.shoot("p1", [0, 0, 1], [0, 0, -5], 0.06, t)) fired++;
    else break;
    t += 250;
  }
  check(`満タンで約 ${g.config.tankShots} 発（自然回復ぶん +5 まで）で "no ink"`, fired >= g.config.tankShots && fired <= g.config.tankShots + 5 && g.lastRejectReason === "no ink", `${fired} shots`);
  const empty = g.inkOf("p1", t);
  check("撃ち切った直後は 1 発ぶん未満", empty < cost + 0.05, empty.toFixed(3));
  // 自然回復（自分の色の上ではない）: 満タンまで inkFullStandSec
  const later = g.inkOf("p1", t + 4000);
  check("自然回復は遅い（4 秒で +0.2）", near(later - empty, 4 / g.config.inkFullStandSec, 0.01), (later - empty).toFixed(3));
  // 自分の色の床の上: 頭の真下の床セルを自分のチームで塗ってから測る
  g.grids.get("floor").stamp([0.5, 1 / 1.5], 0.1, 1);
  check("onOwnFloorInk: 頭の真下が自分の色", g.onOwnFloorInk("p1") === true);
  const rec = g.inkOf("p1", t + 4000 + 1500);
  check("自分の色の床の上では速く回復（1.5 秒で +0.5）", near(rec - later, 1.5 / g.config.inkFullOwnInkSec, 0.01), (rec - later).toFixed(3));
  // 相手の色に塗り替えられると遅い回復に戻る
  g.grids.get("floor").stamp([0.5, 1 / 1.5], 0.1, 2);
  check("onOwnFloorInk: 相手の色なら false", g.onOwnFloorInk("p1") === false);
}

// ================= 4. server =================
const PORT = 5187;
const server = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], { stdio: ["ignore", "pipe", "pipe"] });
server.stderr.on("data", (d) => process.stderr.write(d));
server.stdout.on("data", (d) => {
  for (const line of d.toString().split("\n")) if (line.startsWith("[splatoon]")) console.log(line);
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
  const q = new URLSearchParams({ v: String(SPLATOON_PROTOCOL_VERSION), ...query });
  if (name) q.set("name", name);
  const ws = new WebSocket(`wss://localhost:${PORT}${SPLATOON_PATH}?${q}`, {
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
  const cfg = { room: "test", markerId: "0", markerMm: "100", matchSec: "20" };
  const a = connect(cfg, "Alice");
  const wa = await a.waitFor((m) => m.type === "welcome");
  check("welcome: id・config・格子付きの state・開始イベント", wa && wa.id === "p1" && wa.config.matchSec === 20 && wa.state.grids && wa.state.event?.kind === "start" && wa.state.players[0].team === 1);
  const b = connect(cfg, "Bob");
  const wb = await b.waitFor((m) => m.type === "welcome");
  check("2 人目は B チーム・peers に p1", wb && wb.state.players.find((p) => p.id === wb.id).team === 2 && wb.peers.includes("p1"));
  const stA = await a.waitFor((m) => m.type === "state" && m.state.players.length === 2);
  check("入室で state が配られる", stA !== null);

  b.send({ type: "shot", pos: [0, 0, 2], vel: [0, 0, -5], radius: 0.06 });
  const rejNoPose = await b.waitFor((m) => m.type === "rejected");
  check("pose を送る前の shot は拒否（発射位置の検証に頭の位置が要る）", rejNoPose && /pose/.test(rejNoPose.reason));
  b.send({ type: "pose", pos: [0, 0.1, 2.3], quat: [0, 0, 0, 1], tracking: true });
  await sleep(50);
  b.send({ type: "shot", pos: [0, 0, 2], vel: [0, 0, -5], radius: 0.06 });
  const sa = await a.waitFor((m) => m.type === "shot");
  check("shot が全員に配られ、着弾（壁）とチームが付く", sa && sa.shot.by === "p2" && sa.shot.team === 2 && sa.shot.landing?.surfaceId === "wall" && typeof sa.t === "number");
  b.send({ type: "shot", pos: [0, 0, 2], vel: [0, 0, -50], radius: 0.06 });
  const rej = await b.waitFor((m) => m.type === "rejected" && /velocity/.test(m.reason));
  check("不正な shot は本人に rejected", rej !== null);
  const bigField = connect({ ...cfg, room: "big", wallW: "20", wallH: "20", floorDepth: "20" });
  const errBig = await bigField.waitFor((m) => m.type === "error");
  check("格子が大きすぎるフィールドは拒否", errBig && /不正/.test(errBig.reason));
  const st = await a.waitFor((m) => m.type === "state" && m.state.scores[1] > 0, 2500);
  check("state に得点が反映される（B が塗った）", st !== null && st.state.scores[0] === 0);
  check("state にインク残量（B は 1 発ぶん減っている）", st && st.state.ink.p2 < 1 && st.state.ink.p1 === 1, JSON.stringify(st?.state.ink));

  b.send({ type: "pose", pos: [0.5, 0, 1.5], quat: [0, 0, 0, 2], tracking: true });
  const pose = await a.waitFor((m) => m.type === "pose" && m.id === "p2" && m.pos[0] === 0.5);
  check("pose が中継され quat は正規化", pose && Math.abs(pose.quat[3] - 1) < 1e-9);

  const bad = connect({ ...cfg, gravity: "9.8" });
  const err = await bad.waitFor((m) => m.type === "error");
  check("フィールド設定が違う端末は入室拒否", err && /不一致/.test(err.reason));

  b.ws.close();
  const la = await a.waitFor((m) => m.type === "leave");
  check("leave が届く", la && la.id === "p2");
  a.ws.close();
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
