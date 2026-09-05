// Phase 10 (10-golf) の回帰テスト。`npm run test:golf` で実行する。
//   1. src/shared/golf-sim.ts — 転がり（減速・クッション・カップイン / リップアウト）・ホールの配置・向きの回転
//   2. src/shared/joycon-report.ts — Joy-Con の入力レポート 0x30 の解析（ボタン・IMU の 3 サンプル）・サブコマンドのパケット
//   3. src/shared/swing-detector.ts — ジャイロの時系列から「構え → バックスイング → インパクト」を検出する状態機械
//   4. src/shared/golf-game.ts — ルール（参加順の手番・構え・1 打・カップイン・打ち切り・ホール進行・結果・離脱・タイムアウト）
//   5. server/golf.ts — WebSocket の受け付け・俯瞰画面の代理 stroke・putter の中継・config の配信（Vite dev サーバーを起動して叩く）
// テストフレームワークは使わない（04〜09 と同じ方針）。Node 22.18+ は .ts をそのまま import できる
import { spawn } from "node:child_process";
import WebSocket from "ws";
import {
  BALL_R,
  CUP_R,
  DEFAULT_GOLF,
  STEP_SEC,
  makeHoles,
  rollAt,
  rollDistance,
  rotate2,
  simulateRoll,
  speedForDistance,
  validateGolfRules,
} from "../src/shared/golf-sim.ts";
import {
  ACCEL_G_PER_LSB,
  GYRO_DPS_PER_LSB,
  INPUT_REPORT_STANDARD_FULL,
  RUMBLE_NEUTRAL,
  SUBCMD_ENABLE_IMU,
  parseStandardReport,
  pressedNames,
  subcommandPacket,
} from "../src/shared/joycon-report.ts";
import { DEFAULT_SWING_OPTIONS, SwingDetector, impactSpeed } from "../src/shared/swing-detector.ts";
import { GolfGame } from "../src/shared/golf-game.ts";
import { GOLF_PATH, GOLF_PROTOCOL_VERSION } from "../src/shared/golf-protocol.ts";

const results = [];
function check(name, cond, detail = "") {
  results.push([name, cond]);
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${detail ? ` (${detail})` : ""}`);
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ================= 1. sim =================
{
  const cfg = { ...DEFAULT_GOLF, wallW: 3, floorDepth: 2.5, decel: 0.8, restitution: 0.5, cupMaxSpeed: 1.4 };
  const cup = [0, 0.6];
  // 減速だけ: 1 m/s なら 1/(2·0.8) = 0.625m 進んで止まる（カップから離れた向きに撃つ）
  const r1 = simulateRoll([0, 2], [0.5, 0], cup, cfg);
  check("摩擦で止まる: 距離 = v²/2a（誤差 1cm 以内）", near(r1.end[0], 0.5 * 0.5 / (2 * 0.8), 0.01) && near(r1.end[1], 2, 1e-9) && !r1.holed && r1.bounces === 0, `end=${r1.end} t=${r1.duration}`);
  check("転がりの時間 = v/a", near(r1.duration, 0.5 / 0.8, STEP_SEC * 1.01), `${r1.duration}`);
  check("rollDistance / speedForDistance は互いに逆", near(speedForDistance(rollDistance(1.3, 0.8), 0.8), 1.3));
  check("rollAt: 0 で始点、終わりで終点、途中は単調", rollAt(r1, 0)[0] === 0 && near(rollAt(r1, 99)[0], r1.end[0]) && rollAt(r1, 0.2)[0] > 0 && rollAt(r1, 0.2)[0] < r1.end[0]);
  check("samples は STEP_SEC ごと（duration / STEP + 1 個）", r1.samples.length === Math.round(r1.duration / STEP_SEC) + 1, `${r1.samples.length}`);
  // カップイン: ティーからカップへ真っ直ぐ、届く速さ（距離 1.4m → v = sqrt(2·0.8·1.4) ≈ 1.5 に少し足す）
  const v = speedForDistance(1.4, 0.8) + 0.2;
  const r2 = simulateRoll([0, 2], [0, -v], cup, cfg);
  check("カップに向かって適度な速さ → カップイン（終点 = カップの中心）", r2.holed && r2.end[0] === cup[0] && r2.end[1] === cup[1] && r2.holedAt !== null && r2.holedAt < r2.duration + 1e-9, `holed=${r2.holed} end=${r2.end}`);
  // リップアウト: 速すぎると通過する（3 m/s でカップを通るとき 1.4 m/s より速い）
  // （反発 0.5 だと壁から戻ってきて 2 度目にゆっくり入るので、ここは反発 0 で「通過した」ことだけ見る）
  const r3 = simulateRoll([0, 2], [0, -3], cup, { ...cfg, restitution: 0 });
  const passedCup = r3.samples.some((p) => Math.hypot(p[0] - cup[0], p[1] - cup[1]) < CUP_R - BALL_R);
  check("速すぎると通過（リップアウト）して壁まで行く", !r3.holed && passedCup && r3.bounces >= 1, `holed=${r3.holed} passed=${passedCup} bounces=${r3.bounces} end=${r3.end}`);
  const r3b = simulateRoll([0, 2], [0, -3], cup, cfg);
  check("反発があると壁から戻ってきて 2 度目にゆっくり入ることもある（物理として自然）", r3b.holed && r3b.bounces === 1 && r3b.holedAt > 0.5, `holedAt=${r3b.holedAt}`);
  // 縁をかすめるだけ（中心から CUP_R より外）は入らない
  const r4 = simulateRoll([CUP_R + 0.01, 2], [0, -v], cup, cfg);
  check("カップの縁の外側を通ると入らない", !r4.holed, `end=${r4.end}`);
  // 届かない
  const r5 = simulateRoll([0, 2], [0, -0.5], cup, cfg);
  check("弱いと届かずに止まる（カップの手前）", !r5.holed && r5.end[1] > cup[1] + CUP_R, `end=${r5.end}`);
  // 壁で跳ね返る: 右へ 3 m/s → 右の壁 (x=1.5-BALL_R) で反発 0.5
  const r6 = simulateRoll([0, 2], [3, 0], cup, cfg);
  check("右の壁で跳ね返り、場外に出ない", r6.bounces >= 1 && r6.end[0] < 1.5 - BALL_R + 1e-9 && r6.end[0] > -1.5, `end=${r6.end} bounces=${r6.bounces}`);
  check("跳ね返った後は反発係数ぶん遅いので、壁の手前で止まる（左の壁まで届かない）", r6.end[0] > 0, `end=${r6.end}`);
  // 場外の始点はコートの内側に丸める
  const r7 = simulateRoll([5, -1], [0, 0], cup, cfg);
  check("始点がコートの外なら内側に丸める", r7.samples[0][0] <= 1.5 - BALL_R && r7.samples[0][1] >= BALL_R, `${r7.samples[0]}`);
  // 打ち切り: 減速 0（設定の下限より小さいが式の確認）
  const r8 = simulateRoll([0, 2], [0.3, 0], cup, { ...cfg, decel: 1e-9, restitution: 1, maxRollSec: 2 });
  check("maxRollSec で打ち切る", r8.truncated && near(r8.duration, 2, STEP_SEC), `${r8.duration}`);
  // 決定性: 同じ入力で同じ出力
  const a = simulateRoll([0.3, 1.9], [-0.7, -1.2], cup, cfg);
  const b = simulateRoll([0.3, 1.9], [-0.7, -1.2], cup, cfg);
  check("同じ入力なら同じ結果（決定的）", JSON.stringify(a) === JSON.stringify(b));

  // ホールの配置
  const holes = makeHoles({ wallW: 3, wallH: 2.4, floorDepth: 2.5, floorDrop: 1.2 }, 3);
  check("3 ホール: ティーは奥（z 大）、カップは壁側（z 小）、コートの中", holes.length === 3 && holes.every((h) => h.tee[1] > h.cup[1] && h.cup[1] > 0 && h.tee[1] < 2.5 && Math.abs(h.tee[0]) < 1.5 && Math.abs(h.cup[0]) < 1.5), JSON.stringify(holes));
  check("2・3 ホール目は斜め（ティーとカップの x が逆）", holes[1].tee[0] * holes[1].cup[0] < 0 && holes[2].tee[0] * holes[2].cup[0] < 0 && holes[1].tee[0] === -holes[2].tee[0]);
  check("5 ホールは繰り返し", makeHoles({ wallW: 3, wallH: 2.4, floorDepth: 2.5, floorDrop: 1.2 }, 5).length === 5);
  check("小さいコートでも配置がコートの中", (() => { const h = makeHoles({ wallW: 0.4, wallH: 1, floorDepth: 0.5, floorDrop: 1 }, 3); return h.every((x) => Math.abs(x.tee[0]) < 0.2 && x.tee[1] < 0.5 && x.cup[1] > 0); })());

  // 向きの回転: 壁に向かう (0,-1) を +10° 回すと上から見て左（-X）へ
  const d = rotate2([0, -1], 10);
  check("rotate2: +deg で上から見て左（-X）へ振れる", d[0] < 0 && d[1] < 0 && near(Math.hypot(d[0], d[1]), 1));
  check("rotate2: 0° は恒等", near(rotate2([0.6, -0.8], 0)[0], 0.6));

  check("validateGolfRules: 範囲外と非整数を弾く", validateGolfRules({ decel: 0.8, cupMaxSpeed: 1.4, maxStrokes: 6, holes: 3 }) === null && validateGolfRules({ decel: 0, cupMaxSpeed: 1.4, maxStrokes: 6, holes: 3 }) !== null && validateGolfRules({ decel: 0.8, cupMaxSpeed: 1.4, maxStrokes: 2.5, holes: 3 }) !== null);
}

// ================= 2. joycon-report =================
{
  const bytes = new Uint8Array(49);
  bytes[0] = INPUT_REPORT_STANDARD_FULL;
  bytes[1] = 0x7b; // timer
  bytes[2] = 0x8e; // battery 8 (full), connection
  bytes[3] = 0x08 | 0x80; // A + ZR
  bytes[4] = 0x02; // plus
  bytes[5] = 0x40; // L
  // スティック: 中心（2048, 2048）→ 0x00 0x80 0x80
  bytes[6] = 0x00; bytes[7] = 0x08; bytes[8] = 0x80;
  bytes[9] = 0x00; bytes[10] = 0x08; bytes[11] = 0x80;
  const put16 = (o, v) => { const u = v < 0 ? v + 0x10000 : v; bytes[o] = u & 0xff; bytes[o + 1] = (u >> 8) & 0xff; };
  // サンプル 0: 加速度 (0, 0, 4096 = 1g), ジャイロ (100, -200, 300)
  put16(13, 0); put16(15, 0); put16(17, 4096); put16(19, 100); put16(21, -200); put16(23, 300);
  // サンプル 2: ジャイロ x = -1000
  put16(37 + 6, -1000);
  const r = parseStandardReport(bytes);
  check("0x30 を解析: timer / battery（充電中の奇数を落とす）", r && r.timer === 0x7b && r.battery === 8 && r.charging === false);
  check("バッテリー 0x9e = 充電中の 8", (() => { const c = Uint8Array.from(bytes); c[2] = 0x9e; const q = parseStandardReport(c); return q && q.battery === 8 && q.charging === true; })());
  check("ボタン: A・ZR・+・L が押されている", r && r.buttons.a && r.buttons.zr && r.buttons.plus && r.buttons.l && !r.buttons.b && !r.buttons.zl, r && pressedNames(r.buttons).join(","));
  check("スティック中心は (0, 0)", r && near(r.leftStick[0], 0) && near(r.leftStick[1], 0) && near(r.rightStick[0], 0));
  check("IMU 3 サンプル。加速度 1g・ジャイロは deg/s に換算", r && r.imu.length === 3 && near(r.imu[0].accel[2], 4096 * ACCEL_G_PER_LSB) && near(r.imu[0].gyro[0], 100 * GYRO_DPS_PER_LSB) && near(r.imu[0].gyro[1], -200 * GYRO_DPS_PER_LSB), r && JSON.stringify(r.imu[0]));
  check("3 つ目のサンプルは別の値（負の int16 も読める）", r && near(r.imu[2].gyro[0], -1000 * GYRO_DPS_PER_LSB) && near(r.imu[1].gyro[0], 0));
  check("短い・別の reportId は null", parseStandardReport(new Uint8Array(10)) === null && parseStandardReport(new Uint8Array(49).fill(0x3f)) === null);
  const pkt = subcommandPacket(17, SUBCMD_ENABLE_IMU, [0x01]);
  check("サブコマンドのパケット: カウンタは下位 4 ビット、無振動 8 バイト、サブコマンド + 引数", pkt.length === 11 && pkt[0] === 1 && [...pkt.slice(1, 9)].every((v, i) => v === RUMBLE_NEUTRAL[i]) && pkt[9] === 0x40 && pkt[10] === 0x01);
}

// ================= 3. swing-detector =================
{
  const DT = 0.005;
  /** 静止 → バックスイング（軸 axis に沿って backDeg まで）→ 戻り（impactDps で 0 を横切る）の合成ジャイロ列を流す */
  function runSwing(det, { axis = [1, 0, 0], backDeg = 20, backDps = 120, impactDps = 300, stillSec = 0.4, upAxis = [0, 0, 1], yawDpsDuringForward = 0 } = {}) {
    let now = 0;
    let impact = null;
    const step = (gyro) => {
      const accel = [upAxis[0], upAxis[1], upAxis[2]];
      const r = det.sample(now, gyro, accel, DT);
      if (r) impact = r;
      now += DT * 1000;
    };
    // 静止
    for (let t = 0; t < stillSec; t += DT) step([0.5, -0.3, 0.2]);
    // バックスイング（一定の角速度）
    const backSec = backDeg / backDps;
    for (let t = 0; t < backSec; t += DT) step(axis.map((a) => a * backDps));
    // 戻り（一定の角速度で 0 を通り過ぎ、フォロースルーまで）
    const fwdSec = (backDeg * 1.5) / impactDps;
    for (let t = 0; t < fwdSec; t += DT) step([axis[0] * -impactDps + upAxis[0] * yawDpsDuringForward, axis[1] * -impactDps + upAxis[1] * yawDpsDuringForward, axis[2] * -impactDps + upAxis[2] * yawDpsDuringForward]);
    return { impact, now };
  }
  const det = new SwingDetector();
  const { impact } = runSwing(det);
  check("静止 → バックスイング 20° → 300deg/s で戻る → インパクト 1 回", impact !== null && near(impact.dps, 300, 1) && near(impact.backswingDeg, 20, 1.5), JSON.stringify(impact));
  check("インパクト後は idle（二重検出しない）", det.phase === "idle");
  check("フェイスの開き: 鉛直軸まわりの回転が無ければ 0", impact !== null && near(impact.faceDeg, 0, 0.5), `${impact?.faceDeg}`);
  // 持ち方が違っても（別の軸でも）検出する
  const det2 = new SwingDetector();
  const r2 = runSwing(det2, { axis: [0, 0.6, -0.8], upAxis: [1, 0, 0] });
  check("振りの軸が違っても検出する（持ち方に依存しない）", r2.impact !== null && near(r2.impact.dps, 300, 1), JSON.stringify(r2.impact));
  // 戻りの途中で鉛直軸まわりに回すとフェイスの開きに出る（戻り 0.1s × 50 deg/s = 5°）
  const det3 = new SwingDetector();
  const r3 = runSwing(det3, { yawDpsDuringForward: 50 });
  check("戻りの間の鉛直軸まわりの回転がフェイスの開き（約 +3〜5°）に出る", r3.impact !== null && r3.impact.faceDeg > 2 && r3.impact.faceDeg < 6, `${r3.impact?.faceDeg}`);
  // 小さすぎる動き（手ブレ）は振りにならない
  const det4 = new SwingDetector();
  const r4 = runSwing(det4, { backDeg: 3, impactDps: 300 });
  check("バックスイングが小さい（3° < 6°）と振りにならない", r4.impact === null);
  // 遅い戻り（素振り）
  const det5 = new SwingDetector();
  const r5 = runSwing(det5, { impactDps: 30 });
  check("戻りが遅い（30 < 40 deg/s）と空振り扱い", r5.impact === null);
  // 静止せずに始めた動きは無視、その後静止すれば構え直して検出する
  const det6 = new SwingDetector();
  const r6a = runSwing(det6, { stillSec: 0 });
  check("構え（静止）の前の動きは無視", r6a.impact === null && det6.addresses === 0);
  const r6b = runSwing(det6);
  check("その後に静止すれば構えて検出する", r6b.impact !== null && det6.addresses >= 1);
  // A ボタンでの構え直し: 静止せずに address() を呼べば直後の振りを検出する
  const det7 = new SwingDetector();
  det7.address(0);
  const r7 = runSwing(det7, { stillSec: 0 });
  check("address() で静止を待たずに構えられる", r7.impact !== null);
  // 長すぎる振り（戻ってこない）は捨てる
  const det8 = new SwingDetector({ maxSwingMs: 200 });
  const r8 = runSwing(det8, { backDps: 30, backDeg: 20 });
  check("バックスイングが maxSwingMs より長いと捨てる", r8.impact === null);
  // 角速度 → 速さ: 300 deg/s × 0.9m × gain 1 = 4.71 m/s
  check("impactSpeed = ω[rad/s] × 腕の長さ × gain", near(impactSpeed(300, 0.9, 1), (300 * Math.PI / 180) * 0.9));
  check("既定のしきい値（HUD で見せる）", DEFAULT_SWING_OPTIONS.minBackswingDeg === 6 && DEFAULT_SWING_OPTIONS.stillMs === 250);
}

// ================= 4. game =================
{
  const g = new GolfGame({ holes: 2, maxStrokes: 3 }, { settleMs: 100, resultMs: 500, turnTimeoutMs: 1000 });
  let now = 1000;
  check("最初は lobby", g.phase === "lobby" && g.holes.length === 2);
  const ej = g.join("p1", "Alice", now);
  check("1 人目の参加で aim・手番は本人・色 1・ボールはティー", g.phase === "aim" && g.turn === "p1" && ej[0]?.kind === "turn" && g.players.get("p1").color === 1 && g.balls.get("p1").pos[1] === g.holes[0].tee[1]);
  g.join("p2", "Bob", now);
  check("2 人目は色 2、手番は変わらない", g.players.get("p2").color === 2 && g.turn === "p1");
  // 手番でない人の stroke は拒否
  check("手番でない人の stroke は拒否", g.stroke("p2", 1, 0, now) === null && /not your turn/.test(g.lastRejectReason));
  // 遅すぎ・速すぎ
  check("遅すぎる stroke は空振り扱いで拒否（打数に数えない）", g.stroke("p1", 0.05, 0, now) === null && /whiff/.test(g.lastRejectReason) && g.balls.get("p1").strokes === 0);
  check("速すぎる stroke は拒否", g.stroke("p1", 50, 0, now) === null);
  // 構え: 視線が無ければ拒否、target を渡せば OK
  check("視線が無い構えは拒否", g.address("p1", undefined) === false && /gaze/.test(g.lastRejectReason));
  g.updateGaze("p1", [0.5, 0.2]);
  check("視線の交点から構えられる（狙い = ボール → 交点）", g.address("p1", undefined) === true && g.aims.get("p1")[0] > 0 && g.aims.get("p1")[1] < 0);
  check("構えが無ければ狙いはカップの方向", (() => { g.clearAim("p1"); const a = g.aimOf("p1"); const cup = g.holes[0].cup; const ball = g.balls.get("p1"); return near(a[0], (cup[0] - ball.pos[0]) / Math.hypot(cup[0] - ball.pos[0], cup[1] - ball.pos[1]), 1e-9); })());
  check("手番でなくても自分の構えはできる", g.address("p2", [0, 0]) === true);
  // 1 打（弱い）: 転がり → rolling → settle 後に p2 の手番
  const e1 = g.stroke("p1", 0.5, 0, now);
  check("1 打を受理: rolling・roll に from/vel/end・打数 1", e1?.[0]?.kind === "stroke" && g.phase === "rolling" && g.roll?.by === "p1" && g.balls.get("p1").strokes === 1 && !g.balls.get("p1").holed);
  check("転がっている間の stroke は拒否", g.stroke("p2", 1, 0, now) === null && /phase=rolling/.test(g.lastRejectReason));
  check("転がりの途中の tick では何も起きない", g.tick(now + 10).length === 0);
  now += g.roll.duration * 1000 + 200;
  const e2 = g.tick(now);
  check("止まって settle 後に次の手番（p2）", e2[0]?.kind === "turn" && e2[0].playerId === "p2" && g.phase === "aim" && g.turn === "p2");
  // p2 がカップイン（狙いはカップの方向のまま、届く速さ）
  const ball2 = g.balls.get("p2");
  const cup = g.holes[0].cup;
  const dist = Math.hypot(cup[0] - ball2.pos[0], cup[1] - ball2.pos[1]);
  g.clearAim("p2");
  const e3 = g.stroke("p2", speedForDistance(dist, g.config.decel) + 0.2, 0, now);
  check("p2 が適度な速さでカップの方向に打つとカップイン（done）", e3?.[0]?.holed === true && g.balls.get("p2").holed && g.balls.get("p2").done, JSON.stringify(g.roll));
  now += g.roll.duration * 1000 + 200;
  const e4 = g.tick(now);
  check("次は p1（p2 は終えたので飛ばす）", e4[0]?.kind === "turn" && e4[0].playerId === "p1");
  // p1 は 3 打まで（maxStrokes=3）: 2 打目・3 打目を外し続けると打ち切り → ホール 2 へ
  g.stroke("p1", 0.4, 60, now);
  now += g.roll.duration * 1000 + 200;
  const e5 = g.tick(now);
  check("p1 の 2 打目の後もまだ p1 の手番（p2 は終えている）", e5[0]?.playerId === "p1" && g.balls.get("p1").strokes === 2);
  g.stroke("p1", 0.4, -60, now);
  check("3 打目で打ち切り（done, holed でない）", g.balls.get("p1").done && !g.balls.get("p1").holed && g.balls.get("p1").strokes === 3);
  now += g.roll.duration * 1000 + 200;
  const e6 = g.tick(now);
  check("全員が終えたので次のホール（hole イベント + 手番は参加順の先頭 p1）。カードに打数", e6[0]?.kind === "hole" && e6[0].hole === 1 && e6[1]?.kind === "turn" && e6[1].playerId === "p1" && g.cards.get("p1")[0] === 3 && g.cards.get("p2")[0] === 1);
  check("新しいホールではボールがティーに戻り、打数 0", g.balls.get("p1").strokes === 0 && !g.balls.get("p1").done && g.balls.get("p1").pos[0] === g.holes[1].tee[0]);
  // タイムアウト: p1 が打たない → 打ち切り（maxStrokes）で p2 へ
  const e7 = g.tick(now + 1001);
  check("手番のタイムアウトで打ち切り（maxStrokes）にして次の人へ", e7[0]?.kind === "timeout" && e7[0].by === "p1" && g.balls.get("p1").strokes === 3 && g.balls.get("p1").done && e7[1]?.kind === "turn" && e7[1].playerId === "p2");
  now += 1001;
  // 途中参加: いまのホールのティーから、手番はそのまま
  g.join("p3", "Carol", now);
  check("途中参加はいまのホールのティーから・色 3・手番は変わらない", g.players.get("p3").color === 3 && g.balls.get("p3").pos[1] === g.holes[1].tee[1] && g.turn === "p2" && g.cards.get("p3").length === 0);
  // p2 がカップイン → p3 の手番 → p3 が抜ける → ホール終了 → 結果
  const b2 = g.balls.get("p2");
  const d2 = Math.hypot(g.holes[1].cup[0] - b2.pos[0], g.holes[1].cup[1] - b2.pos[1]);
  g.stroke("p2", speedForDistance(d2, g.config.decel) + 0.2, 0, now);
  check("p2 の 2 ホール目カップイン", g.balls.get("p2").holed);
  now += g.roll.duration * 1000 + 200;
  const e8 = g.tick(now);
  check("次は途中参加の p3", e8[0]?.playerId === "p3");
  const e9 = g.leave("p3", now);
  check("手番の人が抜けると全員終了 → 結果。勝者は全ホール打った中で最少の p2", e9[0]?.kind === "result" && g.phase === "result" && g.winners.length === 1 && g.winners[0] === "p2" && g.winnerNames[0] === "Bob", JSON.stringify(e9));
  check("合計: p1 = 3 + 3、p2 = 1 + 1", g.totalOf("p1") === 6 && g.totalOf("p2") === 2);
  const snap = g.snapshot(now, e9[0]);
  check("snapshot: players・balls・cards・holes・winners・event", snap.players.length === 2 && snap.balls.p1.strokes === 3 && snap.cards.p2.length === 2 && snap.holes.length === 2 && snap.winners[0] === "p2" && snap.event.kind === "result" && snap.phaseEndsAt !== null && snap.turn === null);
  // 結果表示の終わりで最初から
  const e10 = g.tick(now + 600);
  check("結果表示の終わりで最初から（restart + 手番 p1、ホール 1、カード空）", e10[0]?.kind === "restart" && e10[1]?.kind === "turn" && g.hole === 0 && g.cards.get("p1").length === 0 && g.phase === "aim");
  // 全員抜けると lobby
  g.leave("p1", now);
  check("手番の p1 が抜けると p2 の手番", g.turn === "p2");
  g.leave("p2", now);
  check("全員抜けると lobby", g.phase === "lobby" && g.turn === null);
  // 寸法とルールの変更で最初から
  const g2 = new GolfGame({ holes: 1 });
  g2.join("p1", "A", 0);
  const es = g2.setFieldSize({ wallW: 2, wallH: 1.5, floorDepth: 4, floorDrop: 1 }, 0);
  check("寸法の変更: field + restart + turn。ホールは新しい寸法で作り直し", es?.[0]?.kind === "field" && es[1]?.kind === "restart" && g2.config.wallW === 2 && g2.holes[0].tee[1] > 3);
  check("不正な寸法は拒否", g2.setFieldSize({ wallW: 0, wallH: 1.5, floorDepth: 4, floorDrop: 1 }, 0) === null);
  const er = g2.setRules({ decel: 1.2, cupMaxSpeed: 1, maxStrokes: 4, holes: 2 }, 0);
  check("ルールの変更: ホール数が変わり最初から", er?.[0]?.kind === "rules" && g2.holes.length === 2 && g2.config.decel === 1.2);
  g2.stroke("p1", 0.5, 0, 0);
  check("転がっている間の寸法・ルールの変更は拒否", g2.setFieldSize({ wallW: 2, wallH: 1.5, floorDepth: 4, floorDrop: 1 }, 0) === null && g2.setRules({ decel: 1.2, cupMaxSpeed: 1, maxStrokes: 4, holes: 2 }, 0) === null);
  check("マーカーの配置はいつでも変えられる（ゲームは進めない）", g2.setMarkers([{ id: 1, face: "floor", pos: [0, -1, 2] }]) && g2.config.markers.length === 1 && g2.phase === "rolling");
}

// ================= 5. server =================
const PORT = 5191;
const server = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], { stdio: ["ignore", "pipe", "pipe"] });
let portInUse = false;
server.stderr.on("data", (d) => {
  const s = d.toString();
  if (/already in use/i.test(s)) portInUse = true;
  process.stderr.write(s);
});
server.stdout.on("data", (d) => {
  for (const line of d.toString().split("\n")) if (line.startsWith("[golf]")) console.log(line);
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

function connect(query, name = "") {
  const q = new URLSearchParams({ v: String(GOLF_PROTOCOL_VERSION), ...query });
  if (name) q.set("name", name);
  const ws = new WebSocket(`wss://localhost:${PORT}${GOLF_PATH}?${q}`, { rejectUnauthorized: false, headers: { origin: `https://localhost:${PORT}` } });
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
  const cfg = { room: "test", markerId: "0", markerMm: "100" };
  const a = connect(cfg, "Alice");
  const wa = await a.waitFor((m) => m.type === "welcome");
  check("welcome: id・role・config（既定のルール）・state（aim・手番は本人）", wa && wa.id === "p1" && wa.role === "player" && wa.config.decel === DEFAULT_GOLF.decel && wa.config.holes === 3 && wa.state.phase === "aim" && wa.state.turn === "p1" && wa.state.players[0].color === 1);
  const b = connect(cfg, "Bob");
  const wb = await b.waitFor((m) => m.type === "welcome");
  check("2 人目は色 2・peers に p1・手番は p1 のまま", wb && wb.state.players.find((p) => p.id === wb.id).color === 2 && wb.peers.includes("p1") && wb.state.turn === "p1");
  const stA = await a.waitFor((m) => m.type === "state" && m.state.players.length === 2);
  check("入室で state が配られる", stA !== null);
  // 別の room 設定は拒否
  const bad = connect({ ...cfg, markerMm: "150" });
  const badMsg = await bad.waitFor((m) => m.type === "error");
  check("markerMm が違うと入室拒否", badMsg !== null && /不一致/.test(badMsg.reason));

  // スマホから: 視線付き pose → 構え → 1 打
  b.send({ type: "stroke", speed: 1, faceDeg: 0 });
  const rejTurn = await b.waitFor((m) => m.type === "rejected");
  check("手番でない人の stroke は rejected", rejTurn && /not your turn/.test(rejTurn.reason));
  a.send({ type: "pose", pos: [0, 0, 2.6], quat: [0, 0, 0, 1], tracking: true, gaze: [0.3, 0.5] });
  const poseB = await b.waitFor((m) => m.type === "pose" && m.id === "p1");
  check("pose（視線の交点 gaze 付き）が中継される", poseB && poseB.gaze[0] === 0.3);
  a.send({ type: "address" });
  const stAim = await a.waitFor((m) => m.type === "state" && m.state.aims.p1 !== null);
  check("address（target 無し）は直近の視線で狙いが決まり state に出る", stAim !== null && stAim.state.aims.p1[1] < 0);
  a.send({ type: "address", target: [-0.5, 0.5] });
  const stAim2 = await a.waitFor((m) => m.type === "state" && m.state.aims.p1 && m.state.aims.p1[0] < 0);
  check("address（target 付き）で狙いが変わる", stAim2 !== null);
  a.send({ type: "stroke", playerId: "p2", speed: 1, faceDeg: 0 });
  const rejOther = await a.waitFor((m) => m.type === "rejected" && /another/.test(m.reason));
  check("スマホが他人の分を打つのは rejected", rejOther !== null);
  a.send({ type: "stroke", speed: 0.6, faceDeg: 5 });
  const stRoll = await b.waitFor((m) => m.type === "state" && m.state.phase === "rolling" && m.state.event?.kind === "stroke");
  check("1 打が受理され、全員に rolling（roll の from/vel/end）が届く", stRoll !== null && stRoll.state.roll.by === "p1" && stRoll.state.balls.p1.strokes === 1 && stRoll.state.aims.p1 === null, JSON.stringify(stRoll?.state.roll));
  const stTurn = await b.waitFor((m) => m.type === "state" && m.state.phase === "aim" && m.state.turn === "p2", 6000);
  check("止まったら p2 の手番", stTurn !== null);

  // 俯瞰画面（role=overview）: 代理で構え・打つ、putter の中継
  const ov = connect({ ...cfg, role: "overview" });
  const wov = await ov.waitFor((m) => m.type === "welcome");
  check("俯瞰画面の welcome: role=overview・peers はプレイヤー 2 人", wov && wov.role === "overview" && wov.peers.length === 2);
  await sleep(200);
  check("俯瞰画面の入室で join は配られず、プレイヤー一覧にも入らない", !a.msgs.some((m) => m.type === "join" && m.id === wov.id) && !a.msgs.some((m) => m.type === "state" && m.state.players.some((p) => p.id === wov.id)));
  ov.send({ type: "stroke", speed: 1, faceDeg: 0 });
  const rejNoId = await ov.waitFor((m) => m.type === "rejected" && /playerId/.test(m.reason));
  check("俯瞰画面の stroke は playerId 必須", rejNoId !== null);
  ov.send({ type: "putter", playerId: "p2", angleDeg: 12.5, dps: 80 });
  const putterA = await a.waitFor((m) => m.type === "putter");
  check("putter（振り角）が他の端末に中継される", putterA && putterA.id === "p2" && putterA.angleDeg === 12.5);
  b.send({ type: "putter", playerId: "p2", angleDeg: 1, dps: 1 });
  const rejPutter = await b.waitFor((m) => m.type === "rejected" && /not overview/.test(m.reason));
  check("スマホからの putter は rejected", rejPutter !== null);
  ov.send({ type: "address", playerId: "p2", target: [0, 0.2] });
  const stAimB = await b.waitFor((m) => m.type === "state" && m.state.aims.p2 !== null);
  check("俯瞰画面が p2 の代わりに構えられる", stAimB !== null);
  const cup = stTurn.state.holes[0].cup;
  const ball = stTurn.state.balls.p2.pos;
  const dist = Math.hypot(cup[0] - ball[0], cup[1] - ball[1]);
  ov.send({ type: "clearAim", playerId: "p2" });
  await b.waitFor((m) => m.type === "state" && m.state.aims.p2 === null);
  ov.send({ type: "stroke", playerId: "p2", speed: speedForDistance(dist, wa.config.decel) + 0.2, faceDeg: 0 });
  const stHoled = await a.waitFor((m) => m.type === "state" && m.state.event?.kind === "stroke" && m.state.event.by === "p2");
  check("俯瞰画面が p2 の代わりに打ち、カップイン", stHoled !== null && stHoled.state.event.holed === true && stHoled.state.balls.p2.holed, JSON.stringify(stHoled?.state.roll));
  // ルール変更（転がっている間は拒否 → 止まってから OK）
  ov.send({ type: "rules", decel: 1, cupMaxSpeed: 1.2, maxStrokes: 4, holes: 2 });
  const rejRules = await ov.waitFor((m) => m.type === "rejected" && /rolling/.test(m.reason));
  check("転がっている間のルール変更は rejected", rejRules !== null);
  await a.waitFor((m) => m.type === "state" && m.state.phase === "aim" && m.state.t > stHoled.state.t, 6000);
  ov.send({ type: "rules", decel: 1, cupMaxSpeed: 1.2, maxStrokes: 4, holes: 2 });
  const cfgMsg = await a.waitFor((m) => m.type === "config");
  check("ルール変更で config + state（最初から。ホール 2 つ）が全員に届く", cfgMsg && cfgMsg.config.decel === 1 && cfgMsg.config.holes === 2 && cfgMsg.state.holes.length === 2 && cfgMsg.state.event?.kind === "rules" && cfgMsg.state.balls.p1.strokes === 0);
  ov.send({ type: "field", wallW: 2, wallH: 1.5, floorDepth: 4, floorDrop: 1 });
  const fieldMsg = await a.waitFor((m) => m.type === "config" && m.config.wallW === 2);
  check("寸法の変更で config が届き、ティーが新しい奥行きに", fieldMsg && fieldMsg.state.holes[0].tee[1] > 3);
  ov.send({ type: "markers", markers: [{ id: 1, face: "floor", pos: [0, -1, 2] }] });
  const mk = await a.waitFor((m) => m.type === "markers");
  check("追加マーカーの配置が全員に届く（床の Y は寸法に合わせる）", mk && mk.config.markers[0].id === 1);
  ov.send({ type: "markers", markers: [{ id: 0, face: "floor", pos: [0, -1, 2] }] });
  const rejMk = await ov.waitFor((m) => m.type === "rejected" && /原点/.test(m.reason));
  check("原点と同じ ID の追加マーカーは rejected", rejMk !== null);
  b.send({ type: "restart" });
  const rejRestart = await b.waitFor((m) => m.type === "rejected" && /not overview/.test(m.reason));
  check("スマホからの restart は rejected", rejRestart !== null);
  ov.send({ type: "restart" });
  const stRestart = await a.waitFor((m) => m.type === "state" && m.state.event?.kind === "restart");
  check("俯瞰画面の restart が全員に届く", stRestart !== null);
  b.send("garbage");
  b.send(JSON.stringify({ type: "stroke", speed: "fast", faceDeg: 0 }));
  await sleep(100);
  check("壊れたメッセージは無視される（接続は生きている）", b.ws.readyState === WebSocket.OPEN);
  a.ws.close();
  const leave = await b.waitFor((m) => m.type === "leave" && m.id === "p1");
  check("退室で leave が配られ、手番が p2 へ", leave !== null && (await b.waitFor((m) => m.type === "state" && m.state.turn === "p2" && m.state.players.length === 1)) !== null);
  b.ws.close();
  ov.ws.close();
  bad.ws.close();
  await sleep(200);

  const failed = results.filter(([, ok]) => !ok);
  console.log(failed.length === 0 ? "\nALL PASS" : `\n${failed.length} FAILED`);
  exitCode = failed.length === 0 ? 0 : 1;
} catch (e) {
  console.error("テストの実行エラー:", e);
} finally {
  server.kill();
}
process.exit(exitCode);
