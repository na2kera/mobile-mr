// Phase 6-2 (06-2-darts) の回帰テスト。`npm run test:darts` で実行する。
//   1. src/shared/darts-sim.ts — 飛行と採点（純粋関数）
//   2. src/shared/darts-game.ts — ルール（参加順の手番・3 投・ラウンド・結果・タイムアウト・離脱）
//   3. src/shared/throw-detector.ts — 手のひらの速度から「離した」を検出する状態機械（手番境界を含む）
//   4. server/darts.ts — WebSocket の受け付け・中継・権威状態の配信（Vite dev サーバーを起動して叩く）
// テストフレームワークは使わない（04〜06 と同じ方針）。Node 22.18+ は .ts をそのまま import できる
import { spawn } from "node:child_process";
import WebSocket from "ws";
import { BOARD, DEFAULT_DARTS, SEGMENTS, dartAt, scoreAt, simulateDart } from "../src/shared/darts-sim.ts";
import { DartsGame } from "../src/shared/darts-game.ts";
import { ThrowDetector } from "../src/shared/throw-detector.ts";
import { launchVelocity } from "../src/shared/volleyball-sim.ts";

const results = [];
function check(name, cond, detail = "") {
  results.push([name, cond]);
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${detail ? ` (${detail})` : ""}`);
}
const near = (a, b, eps) => Math.abs(a - b) <= eps;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ================= 1. sim =================
{
  check("scoreAt: 中心はブル 50", scoreAt(0, 0).points === 50 && scoreAt(0, 0).label === "BULL");
  check("scoreAt: アウターブル 25", scoreAt(0.012, 0).points === 25);
  check("scoreAt: 真上のシングルは 20", scoreAt(0, 0.05).points === 20 && scoreAt(0, 0.05).label === "20");
  check("scoreAt: 真上のトリプルは T20 = 60", scoreAt(0, 0.103).points === 60 && scoreAt(0, 0.103).label === "T20");
  check("scoreAt: 真上のダブルは D20 = 40", scoreAt(0, 0.166).points === 40);
  check("scoreAt: 真下は 3", scoreAt(0, -0.05).points === 3);
  check("scoreAt: 右（時計回り 90°）は 6", scoreAt(0.05, 0).points === 6);
  check("scoreAt: 左は 11", scoreAt(-0.05, 0).points === 11);
  // 20 と 1 の境界（9°）
  const b = (9.5 * Math.PI) / 180;
  check("scoreAt: 20 の右隣は 1", scoreAt(Math.sin(b) * 0.05, Math.cos(b) * 0.05).points === 1);
  check("scoreAt: ダブルの外は 0", scoreAt(0, 0.18).points === 0 && scoreAt(0, 0.18).ring === "out");
  check("SEGMENTS の合計は 210", SEGMENTS.reduce((a, c) => a + c, 0) === 210 && SEGMENTS.length === 20);

  const cfg = DEFAULT_DARTS;
  // 2m 手前、目の高さがボード中心（y=0）から 0.45 s でブルへ届く速度
  const from = [0.1, 0.05, 2];
  const v = launchVelocity(from, [0, 0, 0], 0.45, cfg.gravity);
  const l = simulateDart(from, v, cfg);
  check("simulateDart: 壁面に 0.45s で届く", near(l.hitT, 0.45, 1e-9), `hitT=${l.hitT}`);
  check("simulateDart: 着地はブル", l.stuck && l.score.points === 50, `end=${l.end.map((x) => x.toFixed(3))}`);
  const p = dartAt(from, v, 0.2, cfg.gravity);
  check("dartAt: 途中の位置は壁の手前", p[2] > 0 && p[2] < 2);

  // 遅い球は床へ（壁に届かない）
  const slow = simulateDart([0, 0, 2], [0, 0, -0.5], cfg);
  check("simulateDart: 遅い球は壁に届かず miss", !slow.stuck && slow.score.ring === "miss" && slow.hitT < cfg.maxFlightSec, `hitT=${slow.hitT.toFixed(2)} end=${slow.end.map((x) => x.toFixed(2))}`);
  check("simulateDart: miss の落下点は床の高さ", near(slow.end[1], cfg.floorY, 1e-6));
  // 壁から遠ざかる球
  const back = simulateDart([0, 0, 2], [0, 1, 1], cfg);
  check("simulateDart: 壁から遠ざかる球は miss", back.score.ring === "miss");
  // 壁に届くがボードの外（ワイヤーの外）
  const wide = simulateDart([1, 0, 1], [0, 2.5, -2], cfg);
  check("simulateDart: ボードの外に刺さって 0 点", wide.hitT === 0.5 && wide.score.points === 0, `end=${wide.end.map((x) => x.toFixed(2))} stuck=${wide.stuck} r=${Math.hypot(wide.end[0], wide.end[1]).toFixed(2)} wallStickR=${cfg.wallStickR}`);
  check("BOARD: リングの半径が単調", BOARD.bullR < BOARD.outerBullR && BOARD.outerBullR < BOARD.tripleInR && BOARD.tripleInR < BOARD.tripleOutR && BOARD.tripleOutR < BOARD.doubleInR && BOARD.doubleInR < BOARD.doubleOutR && BOARD.doubleOutR < BOARD.boardR);
}

// ================= 2. game =================
{
  const g = new DartsGame({ config: { ...DEFAULT_DARTS, rounds: 2 }, settleMs: 100, turnEndMs: 200, resultMs: 300, turnTimeoutMs: 1000 });
  let t = 1000;
  check("初期は lobby", g.state.phase === "lobby");
  g.join("a", "Alice", t);
  check("1 人目の参加で aim・手番は本人", g.state.phase === "aim" && g.state.turn?.playerId === "a" && g.state.turn.index === 0);
  g.join("b", "Bob", t);
  check("2 人目は手番を奪わない", g.state.turn?.playerId === "a" && g.state.players.map((p) => p.id).join() === "a,b");
  check("手番でない人の throw は拒否", g.throw("b", [0, 0, 2], [0, 2, -4], t) === false);
  check("壁の向こうからの throw は拒否", g.throw("a", [0, 0, -1], [0, 2, -4], t) === false);
  check("速すぎる throw は拒否", g.throw("a", [0, 0, 2], [0, 0, -40], t) === false);
  const v = launchVelocity([0, 0, 2], [0, 0, 0], 0.45, DEFAULT_DARTS.gravity);
  check("手番の throw は受理", g.throw("a", [0, 0, 2], v, t) === true);
  check("受理で flight・ダーツ 1 本・得点 50", g.state.phase === "flight" && g.state.darts.length === 1 && g.state.scores.a === 50);
  check("flight 中の throw は拒否", g.throw("a", [0, 0, 2], v, t) === false);
  const snap = g.snapshot(t);
  check("snapshot に throw イベントが 1 回だけ載る", snap.event?.kind === "throw" && g.snapshot(t).event === undefined);
  t += 450 + 100 + 10;
  let ev = g.tick(t);
  check("settle 後に 2 投目へ（同じ人）", ev.some((e) => e.kind === "turn") && g.state.phase === "aim" && g.state.turn?.index === 1);
  g.throw("a", [0, 0, 2], [0, 0, -0.5], t); // 届かない
  check("届かない球は 0 点", g.state.scores.a === 50 && g.state.darts.length === 2);
  const miss = g.state.darts[1].landing;
  t += miss.hitT * 1000 + 100 + 10;
  g.tick(t);
  check("3 投目", g.state.turn?.index === 2 && g.state.turn.playerId === "a");
  g.throw("a", [0, 0, 2], v, t);
  t += 450 + 200 + 10;
  ev = g.tick(t);
  check("3 投目の後は次の人（b）へ移り、ダーツが抜かれる", g.state.turn?.playerId === "b" && g.state.turn.index === 0 && g.state.darts.length === 0 && g.state.round === 0);
  // b は投げずにタイムアウト
  t += 1000 + 10;
  ev = g.tick(t);
  check("タイムアウトで次のラウンドの a へ", ev.some((e) => e.kind === "timeout" && e.by === "b") && g.state.turn?.playerId === "a" && g.state.round === 1);
  // a が 3 投、b が 3 投 → 結果
  for (const who of ["a", "b"]) {
    for (let i = 0; i < 3; i++) {
      check(`${who} の ${i + 1} 投目が受理`, g.throw(who, [0, 0, 2], v, t) === true);
      t += 450 + (i === 2 ? 200 : 100) + 10;
      g.tick(t);
    }
  }
  check("全ラウンド終了で result", g.state.phase === "result" && g.state.turn === null, `phase=${g.state.phase}`);
  check("勝者は a（250 対 150）", g.state.winners?.join() === "a" && g.state.scores.a === 250 && g.state.scores.b === 150, `a=${g.state.scores.a} b=${g.state.scores.b}`);
  t += 300 + 10;
  ev = g.tick(t);
  check("result の後は同じメンバーで最初から", ev.some((e) => e.kind === "restart") && g.state.phase === "aim" && g.state.round === 0 && g.state.turn?.playerId === "a" && g.state.scores.a === 0);
  // 手番の人が離脱
  g.leave("a", t);
  check("手番の人が抜けたら次の人へ", g.state.turn?.playerId === "b" && g.state.players.length === 1);
  g.leave("b", t);
  check("全員抜けたら lobby", g.state.phase === "lobby" && g.state.players.length === 0);
  // 真ん中の人が手番中に抜けたら、先頭ではなく次の人へ
  const trio = new DartsGame({ config: { ...DEFAULT_DARTS, rounds: 3 } });
  trio.join("a", "A", 0);
  trio.join("b", "B", 0);
  trio.join("c", "C", 0);
  trio.throw("a", [0, 0, 2], v, 0);
  trio.tick(5000);
  trio.throw("a", [0, 0, 2], v, 5000);
  trio.tick(10000);
  trio.throw("a", [0, 0, 2], v, 10000);
  trio.tick(20000);
  check("3 人: a の 3 投の後は b", trio.state.turn?.playerId === "b");
  trio.leave("b", 20000);
  check("3 人: 手番の b が抜けたら c へ（先頭の a に戻らない）", trio.state.turn?.playerId === "c" && trio.state.round === 0, `turn=${trio.state.turn?.playerId} round=${trio.state.round}`);
  trio.leave("c", 20000);
  check("3 人: 最後の c が抜けたら次のラウンドの a へ", trio.state.turn?.playerId === "a" && trio.state.round === 1, `turn=${trio.state.turn?.playerId} round=${trio.state.round}`);
  // 結果表示中に勝者が抜けたら winners を決め直す
  const duo = new DartsGame({ config: { ...DEFAULT_DARTS, rounds: 1 }, settleMs: 0, turnEndMs: 0 });
  duo.join("a", "A", 0);
  duo.join("b", "B", 0);
  for (let i = 0; i < 3; i++) {
    duo.throw("a", [0, 0, 2], v, 0);
    duo.tick(1000);
  }
  for (let i = 0; i < 3; i++) {
    duo.throw("b", [0, 0, 2], [0, 0, -0.5], 1000);
    duo.tick(5000);
  }
  check("2 人: result で勝者は a", duo.state.phase === "result" && duo.state.winners?.join() === "a", `phase=${duo.state.phase} winners=${duo.state.winners}`);
  duo.leave("a", 5000);
  check("2 人: 結果表示中に勝者 a が抜けたら winners は b", duo.state.phase === "result" && duo.state.winners?.join() === "b", `winners=${duo.state.winners}`);
  // 1 人だけで最後まで
  const solo = new DartsGame({ config: { ...DEFAULT_DARTS, rounds: 1 }, settleMs: 0, turnEndMs: 0 });
  solo.join("s", "Solo", 0);
  for (let i = 0; i < 3; i++) {
    solo.throw("s", [0, 0, 2], v, 0);
    solo.tick(1000);
  }
  check("1 人でも結果まで進む", solo.state.phase === "result" && solo.state.winners?.join() === "s");
}

// ================= 3. throw-detector =================
{
  const mk = () => new ThrowDetector({ minSpeed: 1.5, releaseRatio: 0.5, maxSwingMs: 800 });
  const fwd = (k) => [0, 0.5 * k, -2 * k]; // 壁方向（-Z）+ 少し上
  // 通常の投げ: 加速 → ピーク → 減速で release。速度はピーク、位置は減速検出時
  let d = mk();
  check("detector: 遅い動きでは振りにならない", d.sample(0, [0, 0, 2], fwd(0.5), true) === null && d.swing === null);
  check("detector: 閾値を超えた壁方向の動きで振り開始", d.sample(33, [0, 0, 1.9], fwd(1), true) === null && d.swing !== null);
  d.sample(66, [0, 0.1, 1.8], fwd(2), true);
  const r = d.sample(99, [0, 0.2, 1.7], fwd(0.5), true);
  check("detector: ピークの半分に減速したら release（速度 = ピーク、位置 = 減速検出時）", !!r && r.why === "slowed" && r.vel[2] === -4 && r.pos[1] === 0.2, JSON.stringify(r));
  check("detector: release 後は振りが消える", d.swing === null);
  // 壁と反対向きに動いたら backward
  d = mk();
  d.sample(0, [0, 0, 2], fwd(1), true);
  check("detector: 壁から遠ざかったら release（backward）", d.sample(33, [0, 0, 2], [0, 0, 2], true)?.why === "backward");
  // 長すぎる振りは timeout
  d = mk();
  d.sample(0, [0, 0, 2], fwd(1), true);
  for (let t = 33; t < 800; t += 33) d.sample(t, [0, 0, 2], fwd(1), true);
  check("detector: 長すぎる振りは timeout で release", d.sample(850, [0, 0, 2], fwd(1), true)?.why === "timeout");
  // 手を見失ったら lost
  d = mk();
  d.sample(0, [0, 0, 2], fwd(1), true);
  check("detector: 手を見失ったら release（lost）", d.lost()?.why === "lost" && d.lost() === null);
  // 手番境界: 手番外（allowed=false）に始めた振りは、手番に切り替わっても投げにならない
  d = mk();
  check("detector: 手番外では振りを始めない", d.sample(0, [0, 0, 2], fwd(2), false) === null && d.swing === null);
  check("detector: 手番に切り替わった直後の減速は release にならない（開始前の動作を消費しない）", d.sample(33, [0, 0, 2], fwd(0.5), true) === null && d.swing === null);
  // 手番中に始めた振りの途中で手番外になったら捨てる
  d = mk();
  d.sample(0, [0, 0, 2], fwd(2), true);
  check("detector: 振りの途中で手番外になったら捨てる", d.sample(33, [0, 0, 2], fwd(0.5), false) === null && d.swing === null);
  // 新たに手番中に始めた振りは普通に release
  check("detector: その後の手番中の振りは普通に投げになる", d.sample(66, [0, 0, 2], fwd(2), true) === null && d.sample(99, [0, 0, 2], fwd(0.5), true)?.why === "slowed");
}

// ================= 4. server =================
const PORT = 5182;
const URL_BASE = `wss://localhost:${PORT}/api/darts`;
const PAGE_ORIGIN = `https://localhost:${PORT}`;
const WAIT_TIMEOUT_MS = 5000;

const server = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, SHARED_ROOM_HEARTBEAT_MS: "300" },
});
server.stderr.on("data", (d) => process.stderr.write(d));
let serverExited = false;
server.on("exit", () => {
  serverExited = true;
});

function buildQuery(room, { v = 1, markerId = 0, markerMm = 100, gravity = DEFAULT_DARTS.gravity, rounds = 1, name } = {}) {
  const q = new URLSearchParams({ room, v: String(v), markerId: String(markerId), markerMm: String(markerMm), gravity: String(gravity), rounds: String(rounds) });
  if (name) q.set("name", name);
  return q.toString();
}

function tryConnect(query, extraOpts = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${URL_BASE}?${query}`, {
      rejectUnauthorized: false,
      origin: PAGE_ORIGIN,
      handshakeTimeout: WAIT_TIMEOUT_MS,
      ...extraOpts,
    });
    const msgs = [];
    ws.on("message", (d) => msgs.push(JSON.parse(d.toString())));
    const timer = setTimeout(() => reject(new Error("connect timeout")), WAIT_TIMEOUT_MS);
    ws.on("open", () => {
      clearTimeout(timer);
      resolve({ ws, msgs });
    });
    ws.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

async function waitForMsg(conn, predicate, timeoutMs = WAIT_TIMEOUT_MS) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const found = conn.msgs.find(predicate);
    if (found) return found;
    await sleep(30);
  }
  return null;
}

async function waitForState(conn, predicate, timeoutMs = WAIT_TIMEOUT_MS) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const states = conn.msgs.filter((m) => m.type === "state");
    const last = states[states.length - 1];
    if (last && predicate(last.state)) return last;
    await sleep(30);
  }
  return null;
}

async function waitForServer(timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (serverExited) return false;
    try {
      const probe = await tryConnect(buildQuery("probe"));
      probe.ws.close();
      return true;
    } catch {
      await sleep(300);
    }
  }
  return false;
}

let exitCode = 1;
try {
  if (!(await waitForServer())) {
    throw new Error(`dev サーバーが起動しなかった（ポート ${PORT} が使用中でないか確認）`);
  }
  const a = await tryConnect(buildQuery("t1", { name: "Alice" }));
  const aWelcome = await waitForMsg(a, (m) => m.type === "welcome");
  check("A に welcome（config 付き）", !!aWelcome && aWelcome.config.gravity === DEFAULT_DARTS.gravity && aWelcome.state.turn?.playerId === aWelcome.id);
  check("表示名が state に載る", aWelcome.state.players[0].name === "Alice");
  const b = await tryConnect(buildQuery("t1"));
  const bWelcome = await waitForMsg(b, (m) => m.type === "welcome");
  check("B の welcome には A が peers にいる", bWelcome.peers.includes(aWelcome.id));
  check("A に B の join", !!(await waitForMsg(a, (m) => m.type === "join" && m.id === bWelcome.id)));
  check("参加で A にも state が配られ、B が players に増えている", !!(await waitForState(a, (s) => s.players.length === 2)));
  // pose の中継
  a.ws.send(JSON.stringify({ type: "pose", pos: [0, 0, 2], quat: [0, 0, 0, 1], tracking: true }));
  const relayed = await waitForMsg(b, (m) => m.type === "pose" && m.id === aWelcome.id);
  check("pose が B へ中継される", !!relayed && relayed.pos[2] === 2);
  // 手番でない B の throw は拒否（本人にだけ rejected）
  const v = launchVelocity([0, 0, 2], [0, 0, 0], 0.45, DEFAULT_DARTS.gravity);
  b.ws.send(JSON.stringify({ type: "throw", pos: [0, 0, 2], vel: v }));
  const rej = await waitForMsg(b, (m) => m.type === "state" && m.state.event?.kind === "throw-rejected");
  check("手番でない throw は本人に rejected", !!rej && rej.state.rejectedFor === bWelcome.id);
  await sleep(200);
  check("rejected は A には届かない", !a.msgs.some((m) => m.type === "state" && m.state.event?.kind === "throw-rejected"));
  // A の throw
  a.ws.send(JSON.stringify({ type: "throw", pos: [0, 0, 2], vel: v }));
  const thrown = await waitForState(a, (s) => s.event?.kind === "throw" && s.event.by === aWelcome.id);
  check("A の throw が受理され state が来る", !!thrown && thrown.state.phase === "flight" && thrown.state.darts.length === 1);
  check("着地がブルで 50 点", thrown?.state.darts[0].landing.score.points === 50 && thrown.state.scores[aWelcome.id] === 50);
  check("B にも同じ throw が届く", !!(await waitForState(b, (s) => s.darts.length === 1 && s.darts[0].by === aWelcome.id)));
  check("settle 後に 2 投目へ", !!(await waitForState(a, (s) => s.phase === "aim" && s.turn?.index === 1)));
  // 不正な入力は無視
  a.ws.send("not json");
  a.ws.send(JSON.stringify({ type: "throw", pos: [0, 0, 2], vel: [0, 0, "x"] }));
  await sleep(200);
  check("壊れた throw は無視される（接続は生きている）", a.ws.readyState === WebSocket.OPEN);
  // 設定不一致は拒否
  const bad = await tryConnect(buildQuery("t1", { gravity: 4 }));
  const err = await waitForMsg(bad, (m) => m.type === "error");
  check("gravity が違う端末は入室拒否", !!err && /不一致/.test(err.reason));
  const badV = await tryConnect(buildQuery("t2", { v: 99 }));
  const errV = await waitForMsg(badV, (m) => m.type === "error");
  check("プロトコルバージョン不一致は拒否", !!errV && /バージョン/.test(errV.reason));
  // Origin 不一致
  let originRejected = false;
  try {
    await tryConnect(buildQuery("t1"), { origin: "https://evil.example" });
  } catch {
    originRejected = true;
  }
  check("Origin 不一致は接続拒否", originRejected);
  // 離脱
  a.ws.close();
  check("B に A の leave", !!(await waitForMsg(b, (m) => m.type === "leave" && m.id === aWelcome.id)));
  check("A が抜けたら手番は B", !!(await waitForState(b, (s) => s.turn?.playerId === bWelcome.id && s.players.length === 1)));
  b.ws.close();
  bad.ws.close();
  badV.ws.close();

  const failed = results.filter(([, ok]) => !ok);
  console.log(failed.length === 0 ? "\nALL PASS" : `\n${failed.length} FAILED`);
  exitCode = failed.length === 0 ? 0 : 1;
} catch (e) {
  console.error("テストの実行エラー:", e.message ?? e);
} finally {
  server.kill();
}
process.exit(exitCode);
