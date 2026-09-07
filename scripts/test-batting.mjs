// Phase 10-2 (10-2-batting) の純粋ロジック + WebSocket 回帰テスト。
import { spawn } from "node:child_process";
import WebSocket from "ws";
import {
  DEFAULT_BATTING,
  PITCH_TYPES,
  hitAt,
  pitchAt,
  pitchTypeFromButtons,
  resolveSwing,
  simulatePitch,
} from "../src/shared/batting-sim.ts";
import { BattingGame } from "../src/shared/batting-game.ts";
import {
  BATTING_PATH,
  BATTING_PROTOCOL_VERSION,
} from "../src/shared/batting-protocol.ts";

const results = [];
function check(name, condition, detail = "") {
  results.push([name, Boolean(condition)]);
  console.log(
    `${condition ? "PASS" : "FAIL"}: ${name}${detail ? ` (${detail})` : ""}`,
  );
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ================= sim / pitch selection =================
{
  const reports = {
    fastball: { up: true, right: false, left: false, down: false },
    curve: { up: false, right: true, left: false, down: false },
    slider: { up: false, right: false, left: true, down: false },
    fork: { up: false, right: false, left: false, down: true },
  };
  for (const type of PITCH_TYPES) {
    check(
      `方向ボタンから ${type} を選ぶ`,
      pitchTypeFromButtons(reports[type]) === type,
    );
  }
  check(
    "方向を押さない場合はストレート",
    pitchTypeFromButtons({
      up: false,
      right: false,
      left: false,
      down: false,
    }) === "fastball",
  );

  const paths = Object.fromEntries(
    PITCH_TYPES.map((type) => [type, simulatePitch(type, 5)]),
  );
  check(
    "球速が速いほどホーム到達が早い",
    simulatePitch("fastball", 7).duration <
      simulatePitch("fastball", 4).duration,
  );
  check(
    "ストレートは中央、カーブは右、スライダーは左へ変化",
    near(paths.fastball.plate[0], 0) &&
      paths.curve.plate[0] > 0.15 &&
      paths.slider.plate[0] < -0.12,
  );
  check(
    "フォークは終盤に落ちる",
    paths.fork.plate[1] < paths.fastball.plate[1] - 0.2,
  );
  check(
    "pitchAt は始点と終点を返す",
    pitchAt(paths.curve, 0)[2] === DEFAULT_BATTING.moundZ &&
      near(
        pitchAt(paths.curve, paths.curve.duration)[2],
        DEFAULT_BATTING.plateZ,
      ),
  );
  check(
    "同じ入力の投球軌道は決定的",
    JSON.stringify(simulatePitch("slider", 5.5)) ===
      JSON.stringify(simulatePitch("slider", 5.5)),
  );

  const pitch = simulatePitch("fastball", 5);
  const contact = resolveSwing(pitch, pitch.duration, 8, 0);
  check(
    "ホーム到達時の十分なスイングはヒット",
    contact.kind === "hit" &&
      contact.hit !== null &&
      contact.hit.distance > 1,
    JSON.stringify(contact),
  );
  check(
    "早すぎる・遅すぎるスイングは空振り",
    resolveSwing(pitch, pitch.duration - 0.3, 8, 0).reason === "early" &&
      resolveSwing(pitch, pitch.duration + 0.3, 8, 0).reason === "late",
  );
  check(
    "弱いスイングは空振り",
    resolveSwing(pitch, pitch.duration, 0.2, 0).reason === "weak",
  );
  check(
    "打球の補間は着地点で止まる",
    contact.hit &&
      JSON.stringify(hitAt(contact.hit, 99)) ===
        JSON.stringify(contact.hit.end),
  );
}

// ================= game =================
{
  const game = new BattingGame(
    {},
    { botDelayMs: 100, resultMs: 50, hitSettleMs: 50 },
  );
  let now = 1000;
  check("初期状態は lobby", game.phase === "lobby");
  game.join("p1", "Alice", now);
  check(
    "1人目は打者になりフリーバッティング",
    game.mode === "free" &&
      game.phase === "waitingPitch" &&
      game.batterId === "p1" &&
      game.pitcherId === null &&
      game.players.get("p1")?.role === "batter",
  );
  const bot = game.tick(now + 100);
  check(
    "1人時は bot が自動で投球する",
    bot[0]?.kind === "pitch" &&
      bot[0].by === "bot" &&
      game.phase === "pitching" &&
      game.stats.pitches === 1,
  );
  now = game.pitch.startedAt + game.pitch.duration * 1000;
  const hit = game.swing("p1", 8, 0, now);
  check(
    "打者が到達時に振ると打球と記録を権威状態に持つ",
    hit?.kind === "hit" &&
      game.phase === "hit" &&
      game.hit?.distance > 1 &&
      game.stats.hits === 1,
  );
  const hitEnd = game.hit.startedAt + game.hit.duration * 1000 + 51;
  game.tick(hitEnd);
  check(
    "打球を見せた後は次の bot 投球待ち",
    game.phase === "waitingPitch" && game.nextPitchAt > hitEnd,
  );

  game.join("p2", "Bob", hitEnd);
  check(
    "2人目は投手になり対戦へ切り替わる",
    game.mode === "duel" &&
      game.pitcherId === "p2" &&
      game.players.get("p2")?.role === "pitcher" &&
      game.phase === "waitingPitch",
  );
  check(
    "打者からの投球は拒否",
    game.pitchBall("p1", "fastball", 5, hitEnd) === null &&
      /not pitcher/.test(game.lastRejectReason),
  );
  const pitch = game.pitchBall("p2", "curve", 5.5, hitEnd);
  check(
    "投手の球種・球速を受理",
    pitch?.kind === "pitch" &&
      game.pitch?.type === "curve" &&
      near(game.pitch.speed, 5.5),
  );
  check(
    "投手からのスイングは拒否",
    game.swing("p2", 8, 0, hitEnd) === null &&
      /not batter/.test(game.lastRejectReason),
  );
  const tooLate =
    game.pitch.startedAt +
    game.pitch.duration * 1000 +
    game.config.contactWindowMs +
    1;
  const take = game.tick(tooLate);
  check(
    "振らずにホームを通過すると見逃し/ボール判定",
    take[0]?.kind === "take" &&
      game.phase === "result" &&
      game.lastResult?.pitchType === "curve",
  );
  game.restart(tooLate);
  check(
    "restart で記録を消し同じ役割で再開",
    game.stats.pitches === 0 &&
      game.stats.hits === 0 &&
      game.phase === "waitingPitch" &&
      game.batterId === "p1" &&
      game.pitcherId === "p2",
  );
  game.leave("p1", tooLate);
  check(
    "打者退出時は残った人が打者になりフリーバッティング",
    game.mode === "free" &&
      game.batterId === "p2" &&
      game.players.get("p2")?.role === "batter",
  );
  game.leave("p2", tooLate);
  check("全員退出で lobby", game.phase === "lobby");
}

// ================= server =================
const PORT = 5195;
const server = spawn(
  "npx",
  ["vite", "--port", String(PORT), "--strictPort"],
  { stdio: ["ignore", "pipe", "pipe"] },
);
let serverExited = false;
let portInUse = false;
server.on("exit", () => {
  serverExited = true;
});
server.stderr.on("data", (data) => {
  const text = data.toString();
  if (/already in use/i.test(text)) portInUse = true;
  process.stderr.write(text);
});
server.stdout.on("data", (data) => {
  for (const line of data.toString().split("\n")) {
    if (line.startsWith("[batting]")) console.log(line);
  }
});
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

async function waitForServer(timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (serverExited || portInUse) return false;
    const response = await fetch(`https://localhost:${PORT}/`).catch(
      () => null,
    );
    if (response?.ok) return true;
    await sleep(250);
  }
  return false;
}

function connect(query, name = "") {
  const search = new URLSearchParams({
    v: String(BATTING_PROTOCOL_VERSION),
    ...query,
  });
  if (name) search.set("name", name);
  const ws = new WebSocket(
    `wss://localhost:${PORT}${BATTING_PATH}?${search}`,
    {
      rejectUnauthorized: false,
      headers: { origin: `https://localhost:${PORT}` },
    },
  );
  const client = { ws, messages: [] };
  ws.on("message", (data) =>
    client.messages.push(JSON.parse(data.toString())),
  );
  ws.on("error", () => {});
  client.send = (message) => ws.send(JSON.stringify(message));
  client.waitFor = async (predicate, timeoutMs = 4000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const message = client.messages.find(predicate);
      if (message) return message;
      await sleep(20);
    }
    return null;
  };
  return client;
}

let exitCode = 1;
try {
  if (!(await waitForServer())) {
    throw new Error(`dev サーバーが起動しません（port ${PORT}）`);
  }
  const room = { room: "bat-test", markerId: "0", markerMm: "100" };
  const batter = connect(room, "Alice");
  const welcomeA = await batter.waitFor((m) => m.type === "welcome");
  check(
    "server welcome: 1人目は free の batter",
    welcomeA?.role === "player" &&
      welcomeA.playerRole === "batter" &&
      welcomeA.state.mode === "free",
  );
  const pitcher = connect(room, "Bob");
  const welcomeB = await pitcher.waitFor((m) => m.type === "welcome");
  check(
    "server welcome: 2人目は duel の pitcher",
    welcomeB?.playerRole === "pitcher" &&
      welcomeB.state.mode === "duel" &&
      welcomeB.peers.includes(welcomeA.id),
  );
  const overview = connect({ ...room, role: "overview" });
  const welcomeO = await overview.waitFor((m) => m.type === "welcome");
  check(
    "overview はプレイヤーに含まれず2人を peers で受け取る",
    welcomeO?.role === "overview" &&
      welcomeO.playerRole === null &&
      welcomeO.peers.length === 2 &&
      welcomeO.state.players.length === 2,
  );

  overview.send({
    type: "pitch",
    playerId: welcomeB.id,
    pitchType: "slider",
    speed: 5,
  });
  const pitching = await batter.waitFor(
    (m) => m.type === "state" && m.state.event?.kind === "pitch",
  );
  check(
    "overview が投手の代理で球種・球速を送れる",
    pitching?.state.pitch.type === "slider" &&
      near(pitching.state.pitch.speed, 5),
  );
  overview.send({
    type: "motion",
    playerId: welcomeA.id,
    kind: "bat",
    angleDeg: 20,
    dps: 100,
  });
  const motion = await pitcher.waitFor((m) => m.type === "motion");
  check(
    "Joy-Con のバット角が他端末へ中継される",
    motion?.id === welcomeA.id &&
      motion.kind === "bat" &&
      motion.angleDeg === 20,
  );
  await sleep(pitching.state.pitch.duration * 1000);
  overview.send({
    type: "swing",
    playerId: welcomeA.id,
    speed: 8,
    faceDeg: 0,
  });
  const contact = await pitcher.waitFor(
    (m) =>
      m.type === "state" &&
      (m.state.event?.kind === "hit" ||
        m.state.event?.kind === "miss"),
  );
  check(
    "overview が打者の代理で振り、サーバーが時刻から判定する",
    contact !== null && contact.state.stats.swings === 1,
    contact?.state.event?.kind ?? "none",
  );

  pitcher.send({
    type: "pitch",
    playerId: welcomeA.id,
    pitchType: "fastball",
    speed: 5,
  });
  const rejectedOther = await pitcher.waitFor(
    (m) => m.type === "rejected" && /another/.test(m.reason),
  );
  check("スマホは他人の代理操作ができない", rejectedOther !== null);
  batter.send({
    type: "motion",
    playerId: welcomeA.id,
    kind: "bat",
    angleDeg: 1,
    dps: 1,
  });
  const rejectedMotion = await batter.waitFor(
    (m) => m.type === "rejected" && /overview/.test(m.reason),
  );
  check("motion と restart は overview だけ", rejectedMotion !== null);

  const third = connect(room, "Carol");
  const full = await third.waitFor((m) => m.type === "error");
  check("プレイヤー3人目は満員で拒否", full && /2人まで/.test(full.reason));

  overview.send({ type: "restart" });
  const restarted = await batter.waitFor(
    (m) => m.type === "state" && m.state.event?.kind === "restart",
  );
  check(
    "overview の restart が全員へ届く",
    restarted?.state.stats.pitches === 0,
  );

  batter.ws.close();
  pitcher.ws.close();
  overview.ws.close();
  third.ws.close();
  await sleep(150);

  const failed = results.filter(([, ok]) => !ok);
  console.log(failed.length ? `\n${failed.length} FAILED` : "\nALL PASS");
  exitCode = failed.length ? 1 : 0;
} catch (error) {
  console.error("テスト実行エラー:", error);
} finally {
  server.kill();
}
process.exit(exitCode);
