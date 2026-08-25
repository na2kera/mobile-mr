// Phase 6 (06-volleyball) の回帰テスト。`npm run test:volley` で実行する。
//   1. src/shared/volleyball-sim.ts — ボール物理・打ち返し計算（純粋関数）
//   2. src/shared/volleyball-game.ts — ルール（サイド割当・サーブ・得点・bot・hit の受理）
//   3. server/volleyball.ts — WebSocket の受け付け・中継・権威状態の配信（Vite dev サーバーを起動して叩く）
// テストフレームワークは使わない（依存追加はスタック変更なので相談が要る。04/05 と同じ方針）。
// Node 22.18+ は .ts を型消去してそのまま import できる
import { spawn } from "node:child_process";
import WebSocket from "ws";
import {
  DEFAULT_COURT,
  aimPoint,
  botShouldHit,
  extrapolateBall,
  flightTimeForHandSpeed,
  launchVelocity,
  otherSide,
  sideOfZ,
  stepBall,
} from "../src/shared/volleyball-sim.ts";
import { VolleyballGame } from "../src/shared/volleyball-game.ts";

const results = [];
function check(name, cond, detail = "") {
  results.push([name, cond]);
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${detail ? ` (${detail})` : ""}`);
}
const near = (a, b, eps) => Math.abs(a - b) <= eps;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ================= 1. sim =================
{
  const g = DEFAULT_COURT.gravity;
  const from = [0, 1, 1.5];
  const to = [0.3, 0.8, -1.5];
  const v = launchVelocity(from, to, 1.0, g);
  // 1 秒後に to に着くことを解析的に確認
  const x = from[0] + v[0] * 1;
  const y = from[1] + v[1] * 1 - 0.5 * g * 1;
  const z = from[2] + v[2] * 1;
  check("launchVelocity: 指定時間後に目標へ着く", near(x, to[0], 1e-9) && near(y, to[1], 1e-9) && near(z, to[2], 1e-9));

  // stepBall を細かく積分しても同じ所へ着く（積分誤差は小さい）
  let ball = { pos: from, vel: v, lastHit: null };
  const court = { ...DEFAULT_COURT, netTop: 0.01, netHalfWidth: 0 }; // ネットに当たらないように
  for (let i = 0; i < 120; i++) ball = stepBall(ball, 1 / 120, court).ball;
  check("stepBall の積分が解析解と一致（1cm 以内）", near(ball.pos[0], to[0], 0.01) && near(ball.pos[1], to[1], 0.01) && near(ball.pos[2], to[2], 0.01), `pos=${ball.pos.map((n) => n.toFixed(3))}`);

  // ネットに当たる: 低い球（ネット上端 0.6 より下で Z=0 を横切る）
  {
    const low = { pos: [0, 0.4, 0.2], vel: [0, 0, -2], lastHit: "A" };
    const r = stepBall(low, 0.2, DEFAULT_COURT);
    check("ネットの高さ未満で横切ると net イベント", r.event === "net");
    check("net 後は手前側（A 側）に戻り Z 速度が反転", r.ball.pos[2] > 0 && r.ball.vel[2] > 0);
  }
  // ネットの上を通る: 高い球
  {
    const high = { pos: [0, 1.5, 0.2], vel: [0, 0, -2], lastHit: "A" };
    const r = stepBall(high, 0.2, DEFAULT_COURT);
    check("ネットより高ければ通過（イベントなし）", r.event === null && r.ball.pos[2] < 0);
  }
  // ネットの横（幅の外）は通過
  {
    const wide = { pos: [1.0, 0.5, 0.2], vel: [0, 0, -2], lastHit: "A" };
    const r = stepBall(wide, 0.2, DEFAULT_COURT);
    check("ネットの幅の外なら低くても通過", r.event === null);
  }
  // 地面
  {
    const falling = { pos: [0, 0.12, -1], vel: [0, -1, 0], lastHit: "A" };
    const r = stepBall(falling, 0.1, DEFAULT_COURT);
    check("地面に着くと ground イベントで停止", r.event === "ground" && near(r.ball.pos[1], DEFAULT_COURT.ballR, 1e-9) && r.ball.vel.every((n) => n === 0));
  }
  // アウト
  {
    const far = { pos: [0, 1, 3.95], vel: [0, 0, 5], lastHit: "B" };
    const r = stepBall(far, 0.1, DEFAULT_COURT);
    check("境界を越えると out イベント", r.event === "out");
  }
  // 純粋関数（入力を変更しない）
  {
    const b = { pos: [0, 1, 0.5], vel: [0, 0, -1], lastHit: null };
    const copy = JSON.stringify(b);
    stepBall(b, 0.1, DEFAULT_COURT);
    check("stepBall は入力を変更しない", JSON.stringify(b) === copy);
  }
  // extrapolateBall は ground で止まる
  {
    const b = { pos: [0, 0.5, -1], vel: [0, 0, 0], lastHit: null };
    const r = extrapolateBall(b, 5, DEFAULT_COURT);
    check("extrapolateBall は地面で止まる", near(r.pos[1], DEFAULT_COURT.ballR, 1e-6) && near(r.pos[2], -1, 1e-6));
  }
  check("sideOfZ: 正は A、負は B、0 は A", sideOfZ(0.1) === "A" && sideOfZ(-0.1) === "B" && sideOfZ(0) === "A");
  check("otherSide", otherSide("A") === "B" && otherSide("B") === "A");
  const ap = aimPoint([0.2, 0.9, 1.6], "A", DEFAULT_COURT);
  check("aimPoint は頭からネット側（A なら -Z）へ reach、少し下", near(ap[0], 0.2, 1e-9) && near(ap[1], 0.9 - DEFAULT_COURT.aimDrop, 1e-9) && near(ap[2], 1.6 - DEFAULT_COURT.reach, 1e-9));
  const near1 = aimPoint([0, 0.9, 0.5], "A", DEFAULT_COURT);
  check("aimPoint: 机の縁（0.5m）なら狙いは頭の 0.45m 前で自陣側", near(near1[2], 0.05, 1e-9));
  const near2 = aimPoint([0, 0.9, 0.35], "A", DEFAULT_COURT);
  check("aimPoint: ネット際でも頭から 0.3m は離す", near(near2[2], 0.05, 1e-9));
  const nearB = aimPoint([0, 0.9, -0.35], "B", DEFAULT_COURT);
  check("aimPoint: B 側でも同様（負側）", near(nearB[2], -0.05, 1e-9));
  const low = aimPoint([0, 0.15, 1.5], "A", DEFAULT_COURT);
  check("aimPoint: 頭が低くても狙いはボール半径 + 0.1 より上", low[1] >= DEFAULT_COURT.ballR + 0.1);
  // extrapolateBall はネットの反射を含む
  {
    const b = { pos: [0, 0.4, 0.3], vel: [0, 0, -2], lastHit: "A" };
    const r = extrapolateBall(b, 0.3, DEFAULT_COURT);
    check("extrapolateBall はネットで跳ね返る（A 側に留まる）", r.pos[2] > 0);
  }
  check("flightTime: 手が止まっていれば基準、速いほど短い、下限あり", flightTimeForHandSpeed(0, 1.1) === 1.1 && flightTimeForHandSpeed(2, 1.1) < 1.1 && flightTimeForHandSpeed(100, 1.1) === 0.65 && flightTimeForHandSpeed(NaN, 1.1) === 1.1);
  check("botShouldHit: bot 側で落下中・低ければ true", botShouldHit({ pos: [0, 0.8, -1.4], vel: [0, -1, -1], lastHit: "A" }, "B", DEFAULT_COURT));
  check("botShouldHit: 上昇中は false", !botShouldHit({ pos: [0, 0.8, -1.4], vel: [0, 1, -1], lastHit: "A" }, "B", DEFAULT_COURT));
  check("botShouldHit: 相手側なら false", !botShouldHit({ pos: [0, 0.8, 1.4], vel: [0, -1, -1], lastHit: "A" }, "B", DEFAULT_COURT));
  check("botShouldHit: 自分（bot）の打球は打ち直さない", !botShouldHit({ pos: [0, 0.8, -1.4], vel: [0, -1, -1], lastHit: "B" }, "B", DEFAULT_COURT));
}

// ================= 2. game =================
/**
 * now を進めながら tick を回す補助。poses に [id, head] を渡すと毎ステップ姿勢を送り直す
 * （実機のクライアントは 15Hz で送り続ける。送らないと poseStaleMs でサイドを失う）
 */
function runFor(game, ms, now, onEvent, poses = []) {
  const step = 1000 / 60;
  let t = now;
  const end = now + ms;
  while (t < end) {
    t += step;
    for (const [id, head] of poses) game.updatePose(id, head, true, t);
    for (const e of game.tick(step / 1000, t)) onEvent?.(e, t);
  }
  return t;
}

{
  // 乱数固定: bot は常に返す（random() = 0 < botReturnRate）
  const game = new VolleyballGame({ random: () => 0 });
  let now = 1000;
  check("初期状態は waiting", game.state.phase === "waiting" && game.state.bot === null);
  game.join("p1", now);
  now = runFor(game, 3000, now);
  check("姿勢が無いうちはサーブされない", game.state.phase === "waiting");
  // A 側（Z>0）で追跡開始 → 数回同じ側なら A に割当、B は bot
  for (let i = 0; i < 3; i++) game.updatePose("p1", [0, 0.9, 1.6], true, now + i);
  check("追跡姿勢が続いたら Z の符号からサイド割当", game.state.sides.A === "p1" && game.state.sides.B === null);
  check("相手がいなければ反対側が bot", game.state.bot === "B");
  const HEAD_A = [0, 0.9, 1.6];
  const events = [];
  now = runFor(game, 2000, now, (e) => events.push(e.kind), [["p1", HEAD_A]]);
  check("待機から serveDelay 後にサーブ", events.includes("serve") && game.state.phase === "rally");
  const serveEvent = events.indexOf("serve");
  check("サーブは人のいる側（A）へ", serveEvent >= 0);
  // ボールが A の頭の前（aimPoint）付近に来るまで進め、その位置で hit
  let hitAt = null;
  const target = aimPoint(HEAD_A, "A", game.court);
  for (let i = 0; i < 200 && !hitAt; i++) {
    now += 1000 / 60;
    game.updatePose("p1", HEAD_A, true, now);
    game.tick(1 / 60, now);
    const d = Math.hypot(...game.state.ball.pos.map((v, k) => v - target[k]));
    if (d < 0.15) hitAt = [...game.state.ball.pos];
  }
  check("サーブは A の頭の前に届く", hitAt !== null, hitAt && `ball=${hitAt.map((n) => n.toFixed(2))}`);
  // 遠い位置からの hit は拒否
  check("ボールから遠い hit は拒否", !game.hit("p1", [hitAt[0] + 1, hitAt[1], hitAt[2]], [0, 0, 0], now));
  check("サイド未割当（未参加）の hit は拒否", !game.hit("nobody", hitAt, [0, 0, 0], now));
  // 遅延ぶん過去の位置（直近 400ms の軌跡上）での申告は受理される: 300ms 進めてから
  // 300ms 前の位置で申告する（別インスタンスで同じ状況を作る）
  {
    const g2 = new VolleyballGame({ random: () => 0 });
    let t = 0;
    g2.join("p1", t);
    t = runFor(g2, 2000, t, null, [["p1", HEAD_A]]);
    let at = null;
    for (let i = 0; i < 200 && !at; i++) {
      t += 1000 / 60;
      g2.updatePose("p1", HEAD_A, true, t);
      g2.tick(1 / 60, t);
      if (Math.hypot(...g2.state.ball.pos.map((v, k) => v - target[k])) < 0.15) at = [...g2.state.ball.pos];
    }
    // 顔の前を通過したボールは 0.3s ほどで机に落ちる（サーブの落下速度 ≈ 2.6m/s）ので、
    // RTT 相当の 150ms だけ進める
    t = runFor(g2, 150, t, null, [["p1", HEAD_A]]);
    const moved = Math.hypot(...g2.state.ball.pos.map((v, k) => v - at[k]));
    check("150ms でボールは申告位置から動いている（前提）", moved > 0.05 && g2.state.phase === "rally", `moved=${moved.toFixed(3)} phase=${g2.state.phase}`);
    check("150ms 前の位置での申告は軌跡との距離で受理される", g2.hit("p1", at, [0, 0, 0], t));
  }
  const accepted = game.hit("p1", hitAt, [0, 0, -1], now);
  check("ボールの近くでの hit は受理", accepted);
  check("受理後の速度は B 側（-Z）へ向かう", game.state.ball.vel[2] < 0 && game.state.ball.lastHit === "A");
  check("直後の連続 hit は cooldown で拒否", !game.hit("p1", game.state.ball.pos, [0, 0, 0], now + 10));
  check("rejectionSnapshot は hit-rejected イベント付きで seq を進めない", (() => {
    const seq = game.state.seq;
    const r = game.rejectionSnapshot("p1", now);
    return r.event?.kind === "hit-rejected" && r.event.by === "p1" && r.seq === seq && game.state.seq === seq;
  })());
  // bot が返し、人が返さなければ A 側に落ちて B（bot）の得点（最初の ground まで進める）
  const events2 = [];
  for (let i = 0; i < 80 && !events2.includes("ground"); i++) {
    now = runFor(game, 100, now, (e) => events2.push(e.kind), [["p1", HEAD_A]]);
  }
  check("bot が打ち返す（bot-hit）", events2.includes("bot-hit"), events2.join(","));
  check("bot の返球後、返さなければ落下して B の得点", events2.includes("ground") && game.state.score.B === 1 && game.state.score.A === 0, `score=${JSON.stringify(game.state.score)} events=${events2.join(",")}`);
  check("落下後は point フェーズ", game.state.phase === "point" && game.state.lastPoint?.winner === "B" && game.state.lastPoint?.reason === "ground");
  check("失点した側（A）が次のサーブを受ける", game.state.serveTo === "A");
  check("point フェーズ中の hit は拒否", !game.hit("p1", game.state.ball.pos, [0, 0, 0], now));
  // 2 人目: 同じ側（Z>0）で追跡開始しても反対側（B）に割り当てられ、bot は消える
  game.join("p2", now);
  game.updatePose("p2", [0, 0.9, 1.2], true, now);
  check("1 回の姿勢ではまだ割り当てない（投票）", game.players.get("p2").side === null);
  for (let i = 0; i < 3; i++) game.updatePose("p2", [0, 0.9, 1.2], true, now + i);
  check("2 人目が同じ側にいても反対側へ割当", game.state.sides.B === "p2");
  check("両側に人がいれば bot なし", game.state.bot === null);
  // 3 人目は観戦（どちらにも割り当てられない）
  game.join("p3", now);
  for (let i = 0; i < 3; i++) game.updatePose("p3", [0, 0.9, -1.2], true, now + i);
  check("3 人目は観戦（サイド null）", game.players.get("p3").side === null);
  check("観戦者の hit は拒否", !game.hit("p3", game.state.ball.pos, [0, 0, 0], now));
  // p2 が抜けると B が空き、再び bot。観戦者 p3 は次の姿勢で B に昇格する
  game.leave("p2");
  check("退室でサイドが空き bot が戻る", game.state.sides.B === null && game.state.bot === "B");
  for (let i = 0; i < 3; i++) game.updatePose("p3", [0, 0.9, -1.2], true, now + 10 + i);
  check("観戦者は空いた側に昇格する", game.state.sides.B === "p3" && game.state.bot === null);
  game.leave("p3");
  // 姿勢が途絶えると（poseStaleMs）サイドが空く → 全員いなくなれば waiting
  now = runFor(game, 4000, now);
  check("姿勢が途絶えたプレイヤーはサイドを失い waiting に戻る", game.state.sides.A === null && game.state.phase === "waiting", `phase=${game.state.phase} sides=${JSON.stringify(game.state.sides)}`);
  // snapshot が内部状態と配列を共有しない
  const snap = game.snapshot();
  snap.ball.pos[0] = 999;
  check("snapshot は内部の配列を共有しない", game.state.ball.pos[0] !== 999);
}

// 再接続のゴースト: 旧 id の姿勢が途絶えた側は、新 id が同じ側に立てば奪える
{
  const game = new VolleyballGame({ random: () => 0 });
  let now = 0;
  game.join("old", now);
  for (let i = 0; i < 3; i++) game.updatePose("old", [0, 0.9, 1.6], true, now + i);
  check("旧接続が A 側", game.state.sides.A === "old");
  now += 1500; // 旧接続は切断されたが leave はまだ届いていない（evictStaleMs=1000 は超えた）
  game.join("new", now);
  for (let i = 0; i < 3; i++) game.updatePose("new", [0, 0.9, 1.6], true, now + i);
  check("姿勢が途絶えた占有者を追い出して同じ側（A）に割当", game.state.sides.A === "new" && game.players.get("old").side === null);
  // 試合前なら反対側へ歩けば付け替わる
  for (let i = 0; i < 3; i++) game.updatePose("new", [0, 0.9, -1.6], true, now + 10 + i);
  check("waiting 中に反対側へ移動すると付け替え", game.state.sides.B === "new" && game.state.sides.A === null);
  // ラリー中は固定
  now = runFor(game, 2000, now + 20, null, [["new", [0, 0.9, -1.6]]]);
  check("サーブ後はラリー", game.state.phase === "rally");
  for (let i = 0; i < 3; i++) game.updatePose("new", [0, 0.9, 1.6], true, now + i);
  check("試合中は側を変えない", game.state.sides.B === "new");
  // 相手陣のボールは打てない
  game.state.ball = { pos: [0, 0.8, 1.0], vel: [0, 0, 0], lastHit: null };
  check("相手陣（A 側）にあるボールは B のプレイヤーが打てない", !game.hit("new", [0, 0.8, 1.0], [0, 0, 0], now + 100));
}

// ネットに掛けて自陣に落ちた失点は reason=net
{
  const game = new VolleyballGame({ random: () => 0 });
  const HEAD = [0, 0.9, 1.6];
  let now = 0;
  game.join("p1", now);
  for (let i = 0; i < 3; i++) game.updatePose("p1", HEAD, true, now + i);
  now = runFor(game, 2000, now, null, [["p1", HEAD]]);
  // ボールを自陣の低い位置に置き、ネットへ向けて低く打った状態にする
  game.state.ball = { pos: [0, 0.4, 0.5], vel: [0, 0.5, -2], lastHit: "A" };
  const events = [];
  for (let i = 0; i < 40 && !events.includes("ground"); i++) {
    now = runFor(game, 100, now, (e) => events.push(e.kind), [["p1", HEAD]]);
  }
  check("ネットに当たって自陣に落ちると reason=net で失点（イベント種別は ground）", events.includes("net") && events.includes("ground") && game.state.lastPoint?.reason === "net" && game.state.lastPoint.winner === "B", `events=${events.join(",")} lastPoint=${JSON.stringify(game.state.lastPoint)}`);
}

// bot の見送り（random() >= botReturnRate なら返さない → 人の得点）
{
  const game = new VolleyballGame({ random: () => 0.99 });
  const HEAD = [0, 0.9, 1.6];
  let now = 0;
  game.join("p1", now);
  for (let i = 0; i < 3; i++) game.updatePose("p1", HEAD, true, now + i);
  now = runFor(game, 2000, now, null, [["p1", HEAD]]);
  // ボールを待ち受けて hit
  const target = aimPoint(HEAD, "A", game.court);
  let hit = false;
  for (let i = 0; i < 300 && !hit; i++) {
    now += 1000 / 60;
    game.updatePose("p1", HEAD, true, now);
    game.tick(1 / 60, now);
    const d = Math.hypot(...game.state.ball.pos.map((v, k) => v - target[k]));
    if (d < 0.15) hit = game.hit("p1", game.state.ball.pos, [0, 0, 0], now);
  }
  const events = [];
  now = runFor(game, 4000, now, (e) => events.push(e.kind), [["p1", HEAD]]);
  check("bot が見送ると人（A）の得点", hit && !events.includes("bot-hit") && game.state.score.A === 1, `events=${events.join(",")} score=${JSON.stringify(game.state.score)}`);
}

// ネット高さの自動調整（頭の高さ - 0.35）
{
  const game = new VolleyballGame({ random: () => 0 });
  const HEAD = [0, 1.6, 1.6]; // 床のマーカー + 立位
  let now = 0;
  game.join("p1", now);
  now = runFor(game, 2000, now, null, [["p1", HEAD]]);
  check("netTop=auto: 頭 1.6m なら 1.25m", near(game.court.netTop, 1.25, 1e-9), `netTop=${game.court.netTop}`);
  const fixed = new VolleyballGame({ random: () => 0, autoNetTop: false, court: { ...DEFAULT_COURT, netTop: 0.8 } });
  fixed.join("p1", 0);
  runFor(fixed, 2000, 0, null, [["p1", HEAD]]);
  check("netTop 固定なら変わらない", fixed.court.netTop === 0.8);
}

// ================= 3. server =================
const PORT = 5179;
const URL_BASE = `wss://localhost:${PORT}/api/volleyball`;
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

function buildQuery(room, { v = 1, markerId = 0, markerMm = 100, netTop = "auto", gravity = DEFAULT_COURT.gravity, flightSec = DEFAULT_COURT.baseFlightSec } = {}) {
  return new URLSearchParams({ room, v: String(v), markerId: String(markerId), markerMm: String(markerMm), netTop: String(netTop), gravity: String(gravity), flightSec: String(flightSec) }).toString();
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

/** 条件を満たす最新の state を待つ */
async function waitForState(conn, predicate, timeoutMs = WAIT_TIMEOUT_MS) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const states = conn.msgs.filter((m) => m.type === "state");
    const last = states[states.length - 1];
    if (last && predicate(last.state, last.court)) return last;
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

  // ---- welcome / join / state ----
  const a = await tryConnect(buildQuery("v1"));
  const aWelcome = await waitForMsg(a, (m) => m.type === "welcome");
  check("A が welcome（court と state 付き）を受信", !!aWelcome && aWelcome.court && aWelcome.state?.phase === "waiting");
  const b = await tryConnect(buildQuery("v1"));
  const bWelcome = await waitForMsg(b, (m) => m.type === "welcome");
  check("B の welcome の peers に A", bWelcome?.peers.includes(aWelcome.id));
  check("A に B の join", !!(await waitForMsg(a, (m) => m.type === "join" && m.id === bWelcome.id)));

  // ---- pose（hands 付き）の中継とサイド割当 ----
  const hands = [Array.from({ length: 63 }, (_, i) => i / 100)];
  a.ws.send(JSON.stringify({ type: "pose", pos: [0, 0.9, 1.5], quat: [0, 0, 0, 1], tracking: true, hands }));
  const relayed = await waitForMsg(b, (m) => m.type === "pose");
  check("B に A の pose（hands 付き）が中継される", relayed?.id === aWelcome.id && relayed.hands?.[0]?.length === 63);
  b.ws.send(JSON.stringify({ type: "pose", pos: [0, 0.9, -1.5], quat: [0, 0, 0, 1], tracking: true }));
  // 実機のクライアントと同じく姿勢を送り続ける（サイド割当は数回の姿勢が要り、途絶えると失う）
  const keepAlive = setInterval(() => {
    a.ws.send(JSON.stringify({ type: "pose", pos: [0, 0.9, 1.5], quat: [0, 0, 0, 1], tracking: true }));
    b.ws.send(JSON.stringify({ type: "pose", pos: [0, 0.9, -1.5], quat: [0, 0, 0, 1], tracking: true }));
  }, 100);
  const assigned = await waitForState(a, (s) => s.sides.A === aWelcome.id && s.sides.B === bWelcome.id);
  check("両者の姿勢からサイドが割り当てられ state で配られる", !!assigned);
  check("両側に人がいるので bot なし", assigned?.state.bot === null);

  // ---- サーブ → ラリー中は高頻度で state が来る ----
  const rally = await waitForState(a, (s) => s.phase === "rally");
  check("サーブでラリーが始まる", !!rally && rally.state.event?.kind === "serve");
  const countBefore = a.msgs.filter((m) => m.type === "state").length;
  await sleep(500);
  const countAfter = a.msgs.filter((m) => m.type === "state").length;
  check("ラリー中は state が高頻度で届く（0.5 秒で 5 通以上 = 10Hz 以上。設計値は 20Hz）", countAfter - countBefore >= 5, `${countAfter - countBefore} msgs`);

  // ---- hit: 受理されたら即 state（event=hit, by=自分） ----
  // A の頭の前（aimPoint）にボールが来るのを待つ
  const targetA = aimPoint([0, 0.9, 1.5], "A", DEFAULT_COURT);
  const arrived = await waitForState(a, (s) => s.phase === "rally" && Math.hypot(...s.ball.pos.map((v, k) => v - targetA[k])) < 0.2, 4000);
  check("サーブが A の顔の前に届く", !!arrived, arrived && `ball=${arrived.state.ball.pos.map((n) => n.toFixed(2))}`);
  if (arrived) {
    a.ws.send(JSON.stringify({ type: "hit", pos: arrived.state.ball.pos, handVel: [0, 0, -1.5] }));
    const hitState = await waitForState(a, (s) => s.event?.kind === "hit" && s.event.by === aWelcome.id, 1000);
    check("hit が受理され event=hit（by=A）の state が届く", !!hitState);
    check("受理後のボールは B 側へ向かう", hitState?.state.ball.vel[2] < 0 && hitState?.state.ball.lastHit === "A");
    check("B にも同じ state が届く", !!(await waitForState(b, (s) => s.event?.kind === "hit" && s.event.by === aWelcome.id, 1000)));
  }
  // 遠い hit は拒否され、申告者にだけ hit-rejected が返る（不正な hit は無視）
  const seqBefore = a.msgs.filter((m) => m.type === "state").at(-1)?.state.seq ?? 0;
  const bRejBefore = b.msgs.filter((m) => m.type === "state" && m.state.event?.kind === "hit-rejected").length;
  a.ws.send(JSON.stringify({ type: "hit", pos: [50, 50, 50], handVel: [0, 0, 0] }));
  a.ws.send(JSON.stringify({ type: "hit", pos: ["x", 0, 0], handVel: [0, 0, 0] }));
  a.ws.send("not json");
  const rejected = await waitForMsg(a, (m) => m.type === "state" && m.state.event?.kind === "hit-rejected" && m.state.event.by === aWelcome.id, 1000);
  await sleep(200);
  const hitsAfter = a.msgs.filter((m) => m.type === "state" && m.state.seq > seqBefore && m.state.event?.kind === "hit").length;
  check("遠い hit・不正な hit は受理されない", hitsAfter === 0);
  check("遠い hit には申告者へ hit-rejected が返る", !!rejected);
  check("hit-rejected は他のプレイヤーには送られない", b.msgs.filter((m) => m.type === "state" && m.state.event?.kind === "hit-rejected").length === bRejBefore);
  clearInterval(keepAlive);

  // ---- 設定不一致・バージョン不一致は拒否 ----
  const mismatch = await tryConnect(buildQuery("v1", { netTop: 1.2 }));
  const mmError = await waitForMsg(mismatch, (m) => m.type === "error");
  check("netTop 不一致は error で入室拒否", !!mmError && mmError.reason.includes("不一致"));
  const gravMismatch = await tryConnect(buildQuery("v1", { gravity: 9.8 }));
  check("gravity 不一致も入室拒否", !!(await waitForMsg(gravMismatch, (m) => m.type === "error")));
  const badVersion = await tryConnect(buildQuery("v1", { v: 999 }));
  check("プロトコルバージョン不一致は拒否", !!(await waitForMsg(badVersion, (m) => m.type === "error")));
  const badNet = await tryConnect(buildQuery("v2", { netTop: "abc" }));
  check("不正な netTop は拒否", !!(await waitForMsg(badNet, (m) => m.type === "error")));

  // ---- 不正 pose（hands の長さ違い）は捨てられ、中継されない ----
  const poseCount = b.msgs.filter((m) => m.type === "pose").length;
  a.ws.send(JSON.stringify({ type: "pose", pos: [0, 0.9, 1.5], quat: [0, 0, 0, 1], tracking: true, hands: [[1, 2, 3]] }));
  await sleep(300);
  check("hands の長さが不正な pose は中継されない", b.msgs.filter((m) => m.type === "pose").length === poseCount);

  // ---- Heartbeat: pong を返さない half-open 接続は切断され leave が届く（04 と同じ。SHARED_ROOM_HEARTBEAT_MS=300） ----
  const ghost = await tryConnect(buildQuery("v1"));
  const ghostWelcome = await waitForMsg(ghost, (m) => m.type === "welcome");
  await waitForMsg(b, (m) => m.type === "join" && m.id === ghostWelcome?.id);
  ghost.ws._socket.pause();
  check("half-open 接続が heartbeat で切断され leave が届く", !!(await waitForMsg(b, (m) => m.type === "leave" && m.id === ghostWelcome?.id, 3000)));

  // ---- Room 隔離 ----
  const c = await tryConnect(buildQuery("v-other"));
  const cWelcome = await waitForMsg(c, (m) => m.type === "welcome");
  check("別 room は別の試合（waiting から）", cWelcome?.state.phase === "waiting" && cWelcome.peers.length === 0);
  c.ws.close();

  // ---- leave: A が抜けると B に leave と state ----
  a.ws.close();
  check("B に A の leave が届く", !!(await waitForMsg(b, (m) => m.type === "leave" && m.id === aWelcome.id)));
  check("A が抜けると A 側が空き bot になる", !!(await waitForState(b, (s) => s.sides.A === null && s.bot === "A")));

  // ---- Origin 検証 ----
  const rejectedOrigin = await tryConnect(buildQuery("v1"), { origin: "https://evil.example" }).then(() => false, () => true);
  check("別オリジンのブラウザ接続は拒否", rejectedOrigin);

  b.ws.close();
  const failed = results.filter(([, ok]) => !ok);
  console.log(failed.length === 0 ? "\nALL PASS" : `\n${failed.length} FAILED`);
  exitCode = failed.length === 0 ? 0 : 1;
} catch (e) {
  console.error("テスト実行エラー:", e.message ?? e, e.stack);
} finally {
  server.kill();
}
process.exit(exitCode);
