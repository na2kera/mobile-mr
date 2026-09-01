// 番外編 ex8-1（ゴッドハンド）の回帰テスト。`npm run test:godhand` で実行する。
// 対象は demos/ex8-1-god-hand/god-hand-game.ts（純粋クラス。ローカルのみでサーバーは無い）。
// テストフレームワークは使わない（04〜08 と同じ方針）。Node 22.18+ は .ts をそのまま import できる
import { DEFAULT_GH, GodHandGame, segmentSphereT } from "../demos/ex8-1-god-hand/god-hand-game.ts";

const results = [];
function check(name, cond, detail = "") {
  results.push([name, cond]);
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${detail ? ` (${detail})` : ""}`);
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

/** now を dt 刻みで進めながら update し、出来事を集める */
function run(game, fromMs, toMs, stepMs = 16) {
  const events = [];
  for (let t = fromMs; t <= toMs; t += stepMs) {
    events.push(...game.update(t, stepMs / 1000));
  }
  return events;
}

// ================= 1. 予告 → 発射 → 失点 =================
{
  const g = new GodHandGame({ telegraphSec: 0.5, lives: 2, resultSec: 1 });
  // プレイヤーは (0, 0, 2) に立っている想定。壁 (z=0.2) からまっすぐ飛んでくる
  const ball = g.spawnShot([0, 0, 0.2], [0, 0, 2.5], 2.6, 1000);
  check("spawnShot: telegraph 状態で積まれ、発射時刻は telegraphSec 後", ball.state === "telegraph" && ball.launchAt === 1500);
  let evs = run(g, 1000, 1400);
  check("予告中は発射されない", evs.length === 0 && ball.state === "telegraph");
  evs = run(g, 1400, 1600);
  check("telegraphSec 経過で launch", evs.some((e) => e.kind === "launch") && ball.state === "flying");
  // 2.6m / 2.5m/s ≈ 1.04s で goalZ を跨いで失点（手は出していない）
  evs = run(g, 1600, 2800);
  check("通されると goal（手なし）", evs.some((e) => e.kind === "goal") && g.conceded === 1 && ball.state === "conceded");
  check("重力で落ちている", ball.pos[1] < 0, ball.pos[1].toFixed(3));
}

// ================= 2. キャッチとコンボ =================
{
  const g = new GodHandGame({ telegraphSec: 0.1, handActiveSec: 1.5, handCooldownSec: 0.5 });
  g.spawnShot([0, 0, 0.2], [0, 0, 3], 2.6, 1000);
  run(g, 1000, 1200);
  check("activate: 発動できる", g.activate([0, -0.1, 1.2], 1250) === true && g.hand !== null);
  check("activate: 実体化中は再発動できない", g.activate([0, 0, 1], 1300) === false);
  const evs = run(g, 1250, 1800);
  const caught = evs.find((e) => e.kind === "catch");
  check("手の球にボールが触れるとキャッチ（スコアとコンボ）", caught && caught.combo === 1 && g.score === 1 && g.combo === 1);
  // 2 本目もキャッチしてコンボ 2
  g.spawnShot([0, 0, 0.2], [0, 0, 3], 2.6, 3500);
  run(g, 3500, 3700);
  check("実体化が切れたあと、クールダウンを過ぎれば再発動できる", g.activate([0, -0.1, 1.2], 3700) === true);
  const evs2 = run(g, 3700, 4400);
  const c2 = evs2.find((e) => e.kind === "catch");
  check("連続キャッチでコンボが増える", c2 && c2.combo === 2 && g.bestCombo === 2);
}

// ================= 3. クールダウン =================
{
  const g = new GodHandGame({ handActiveSec: 0.5, handCooldownSec: 1.0 });
  check("発動", g.activate([0, 0, 1], 1000) === true);
  run(g, 1000, 1600); // 実体化が切れる（1500）
  check("実体化は handActiveSec で終わる", g.hand === null);
  check("クールダウン中は発動できない", g.activate([0, 0, 1], 1700) === false);
  check("クールダウン後は発動できる", g.activate([0, 0, 1], 2700) === true);
}

// ================= 4. 破られた（手が出ているのに失点） =================
{
  const g = new GodHandGame({ telegraphSec: 0.1, handActiveSec: 2, handRadius: 0.3 });
  // 手は脇（x=1.5）に出す = ボールは触れずに通る
  g.spawnShot([0, 0, 0.2], [0, 0, 3], 1.6, 1000);
  run(g, 1000, 1150);
  g.activate([1.5, 0, 1.0], 1200);
  const evs = run(g, 1200, 1800);
  check("手が出ているのに通されると broken", evs.some((e) => e.kind === "broken") && g.conceded === 1);
  check("失点でコンボはリセット", g.combo === 0);
}

// ================= 5. ゲームオーバー → 自動リスタート =================
{
  const g = new GodHandGame({ telegraphSec: 0.05, lives: 2, resultSec: 0.5 });
  g.spawnShot([0, 0, 0.2], [0, 0, 4], 1.0, 1000);
  g.spawnShot([0, 0, 0.2], [0, 0, 4], 1.0, 1100);
  const evs = run(g, 1000, 1600);
  const over = evs.find((e) => e.kind === "gameover");
  check("lives 失点で gameover（スコアと最高コンボ付き）", over && g.phase === "result" && typeof over.score === "number");
  check("result 中は発動できない", g.activate([0, 0, 1], 1650) === false);
  const evs2 = run(g, 1650, 2400);
  check("resultSec 後に自動リスタート（カウンタが戻る）", evs2.some((e) => e.kind === "restart") && g.phase === "play" && g.conceded === 0 && g.score === 0 && g.balls.length === 0);
}

// ================= 5b. 低 FPS でもすり抜けない（線分 vs 球） =================
{
  check("segmentSphereT: 線分が球を貫くと入口の t", near(segmentSphereT([0, 0, 0], [0, 0, 2], [0, 0, 1], 0.5), 0.25));
  check("segmentSphereT: 始点が球の中なら 0", segmentSphereT([0, 0, 1], [0, 0, 2], [0, 0, 1], 0.5) === 0);
  check("segmentSphereT: かすらなければ null", segmentSphereT([0, 1, 0], [0, 1, 2], [0, 0, 1], 0.5) === null);
  // 9m/s のボールを 100ms 刻み（0.9m/フレーム）で進めても、判定球（半径 0.7）を跳び越えない
  const g = new GodHandGame({ telegraphSec: 0.05, handActiveSec: 3, gravity: 0 });
  g.spawnShot([0, 0, 0.2], [0, 0, 9], 2.6, 1000);
  g.activate([0, 0, 1.4], 1000);
  const evs = run(g, 1000, 1600, 100);
  check("低 FPS（100ms 刻み）でも高速のボールをキャッチできる", evs.some((e) => e.kind === "catch"), JSON.stringify(g.balls[0]?.pos));
  // 手がゴール面の直前でも「先に触れた方」が勝つ（同一フレームで両方起きる場合）
  const g2 = new GodHandGame({ telegraphSec: 0.05, handActiveSec: 3, gravity: 0 });
  g2.spawnShot([0, 0, 0.2], [0, 0, 9], 1.6, 1000);
  g2.activate([0, 0, 1.3], 1000);
  const evs2 = run(g2, 1000, 1600, 200);
  check("同一フレームでゴール面も跨ぐときはキャッチが先", evs2.some((e) => e.kind === "catch") && !evs2.some((e) => e.kind === "goal" || e.kind === "broken"));
}

// ================= 5c. breakHand（破られたとき）のクールダウン =================
{
  const g = new GodHandGame({ handActiveSec: 5, handCooldownSec: 1 });
  g.activate([0, 0, 1], 1000);
  g.breakHand(1500);
  check("breakHand で実体化が終わる", g.hand === null);
  check("breakHand 直後は再発動できない（クールダウン）", g.activate([0, 0, 1], 1600) === false);
  check("クールダウン後は再発動できる", g.activate([0, 0, 1], 2600) === true);
}

// ================= 6. 難易度の上がり方 =================
{
  const g = new GodHandGame({});
  const s0 = g.shotSpeed();
  const i0 = g.shotInterval();
  for (let i = 0; i < 100; i++) g.spawnShot([0, 0, 0.2], [0, 0, 3], 2.6, 1000 + i);
  check("シュートは速く・間隔は短くなり、上限で止まる", g.shotSpeed() === g.cfg.speedMax && g.shotInterval() === g.cfg.intervalMinSec && s0 === g.cfg.speedStart && near(i0, g.cfg.intervalStartSec));
}

// ================= 7. 片付け =================
{
  const g = new GodHandGame({ telegraphSec: 0.05, maxFlightSec: 0.3 });
  const ball = g.spawnShot([0, 0, 0.2], [0, 0, 0.1], 50, 1000); // ほぼ止まっている = ゴールに届かない
  run(g, 1000, 1500);
  check("maxFlightSec を超えたボールは gone", ball.state === "gone");
  run(g, 1500, 3200);
  check("終わったボールはしばらく見せてから捨てられる", g.balls.length === 0);
}

// ================= 8. moveHand の追従 =================
{
  const g = new GodHandGame({ handActiveSec: 2 });
  g.activate([0, 0, 1], 1000);
  g.moveHand([0.5, 0.1, 1.1]);
  check("moveHand で中心が動く", g.hand && near(g.hand.center[0], 0.5));
  check("既定値: 満タン構成が妥当", DEFAULT_GH.lives > 0 && DEFAULT_GH.handRadius > DEFAULT_GH.ballR);
}

const failed = results.filter(([, ok]) => !ok);
console.log(failed.length === 0 ? "\nALL PASS" : `\n${failed.length} FAILED`);
process.exit(failed.length === 0 ? 0 : 1);
