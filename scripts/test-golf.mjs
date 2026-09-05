// Phase 10 (10-golf) の回帰テスト。`npm run test:golf` で実行する。
//   1. src/shared/golf-sim.ts — 転がり（減速・クッション・カップイン / リップアウト）・ホールの配置・向きの回転
//   2. src/shared/joycon-report.ts — Joy-Con の入力レポート 0x30 の解析（ボタン・IMU の 3 サンプル）・サブコマンドのパケット
//   3. src/shared/swing-detector.ts — ジャイロの時系列から「構え → バックスイング → インパクト」を検出する状態機械
//   4. src/shared/golf-game.ts — ルール（参加順・一打制・残り距離・順位点・ラウンド進行・離脱・タイムアウト）
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
  greenHeight,
  intersectGreen,
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
import { scoreTotal, shotLabel } from "../src/shared/golf-score.ts";
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
  check("反発があると壁から戻ってきて 2 度目にゆっくり入る（物理として自然。既定の反発 0.5 のとき）", r3b.holed && r3b.bounces === 1 && r3b.holedAt > 0.5, `holed=${r3b.holed} holedAt=${r3b.holedAt}`);
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
  check("正面の遠いカップへ、平坦・横勾配・障害物の順で進む", holes.every(h => h.tee[0] === 0 && h.cup[0] === 0 && h.tee[1] - h.cup[1] > cfg.floorDepth * 0.65) && holes[0].slope[0] === 0 && holes[0].obstacles.length === 0 && holes[1].slope[0] > 0 && holes[1].obstacles.length === 0 && holes[2].slope[0] === 0 && holes[2].obstacles.length === 1);
  for (const size of [{ ...DEFAULT_GOLF }, { ...DEFAULT_GOLF, wallW: 0.4, floorDepth: 0.5 }, { ...DEFAULT_GOLF, wallW: 1, floorDepth: 8 }]) {
    const all = makeHoles(size, 9);
    check("9 配置すべて正面・異なる地形・カップと障害物がコート内", new Set(all.map(h => JSON.stringify(h))).size === 9 && all.every(h => h.cup[0] === 0 && h.cup[1] > CUP_R && h.cup[1] < h.tee[1] && h.obstacles.every(o => o.radius + 2 * BALL_R < size.wallW / 2 && o.center[1] - o.radius > h.cup[1] + CUP_R && o.center[1] + o.radius < h.tee[1] - BALL_R)), `${size.wallW}x${size.floorDepth}`);
  }
  check("5 ホールは繰り返し", makeHoles({ wallW: 3, wallH: 2.4, floorDepth: 2.5, floorDrop: 1.2 }, 5).length === 5);
  check("小さいコートでも配置がコートの中", (() => { const h = makeHoles({ wallW: 0.4, wallH: 1, floorDepth: 0.5, floorDrop: 1 }, 3); return h.every((x) => Math.abs(x.tee[0]) < 0.2 && x.tee[1] < 0.5 && x.cup[1] > 0); })());

  // 向きの回転: 壁に向かう (0,-1) を +10° 回すと上から見て左（-X）へ
  const d = rotate2([0, -1], 10);
  check("rotate2: +deg で上から見て左（-X）へ振れる", d[0] < 0 && d[1] < 0 && near(Math.hypot(d[0], d[1]), 1));
  check("rotate2: 0° は恒等", near(rotate2([0.6, -0.8], 0)[0], 0.6));

  check("validateGolfRules: 範囲外と非整数を弾く", validateGolfRules({ decel: 0.8, cupMaxSpeed: 1.4, holes: 3 }) === null && validateGolfRules({ decel: 0, cupMaxSpeed: 1.4, holes: 3 }) !== null && validateGolfRules({ decel: 0.8, cupMaxSpeed: 1.4, holes: 2.5 }) !== null);
}

// 地形: 勾配を読んだ狙い・障害物の回避が実際に攻略として成立すること
{
  const cfg = { ...DEFAULT_GOLF };
  const [flat, slope, blocked] = makeHoles(cfg, 3);
  const speed = speedForDistance(flat.tee[1] - flat.cup[1], cfg.decel) + 0.2;
  const shoot = (hole, angle, v = speed, config = cfg) => {
    const dir = rotate2([0, -1], angle);
    return simulateRoll(hole.tee, dir.map(x => Math.round(x * v * 1000) / 1000), hole.cup, config, hole);
  };
  check("平坦コースでは正面への適切な強さで入る", shoot(flat, 0).holed);
  const drift = shoot(slope, 0);
  check("横勾配では同じ正面ショットが左へ曲がって外れる", !drift.holed && drift.end[0] < -0.15 && !drift.truncated);
  check("横勾配でも右4度に狙うとカップインできる", shoot(slope, -4).holed);
  const mirror = shoot({ ...slope, slope: [-slope.slope[0], 0] }, 0);
  check("反対向きの勾配では右へ同じだけ曲がる", near(mirror.end[0], -drift.end[0]) && near(mirror.end[1], drift.end[1]));
  const stopped = simulateRoll(drift.end, [0, 0], slope.cup, cfg, slope);
  check("止まった球は勾配上でも滑り続けない", stopped.duration === 0 && JSON.stringify(stopped.end) === JSON.stringify(drift.end));
  check("最小摩擦でも最大勾配上で通常ショットが停止する", !shoot({ ...slope, slope: [0.025, 0] }, 0, 1, { ...cfg, decel: 0.3 }).truncated);
  const bump = shoot(blocked, 0);
  const obstacle = blocked.obstacles[0];
  check("正面の障害物がボールを手前へ跳ね返す", !bump.holed && bump.bounces === 1 && bump.end[1] > obstacle.center[1] + obstacle.radius + BALL_R);
  for (const v of [0.15, 2, cfg.maxStrokeSpeed]) {
    for (const angle of [0, -16, 16, -45, 45]) {
      const r = shoot(blocked, angle, v);
      check("高速・斜めの衝突でも障害物へ侵入せずコート内に収まる", r.samples.every(p => Math.hypot(p[0] - obstacle.center[0], p[1] - obstacle.center[1]) >= obstacle.radius + BALL_R - 1e-8 && Math.abs(p[0]) <= cfg.wallW / 2 - BALL_R + 1e-8 && p[1] >= BALL_R - 1e-8 && p[1] <= cfg.floorDepth - BALL_R + 1e-8), `${v}m/s ${angle}deg`);
    }
  }
  const bank = shoot(blocked, -57, 3.5);
  check("障害物コースも右へ狙い壁反射でカップインできる", bank.holed && bank.bounces >= 1);
  check("障害物の左側にも同じ攻略ルートがある", shoot(blocked, 57, 3.5).holed);
  check("勾配と障害物を含む軌道はJSONで配信した地形から同じ結果に復元できる", [slope, blocked].every(h => JSON.stringify(shoot(h, -12)) === JSON.stringify(shoot(JSON.parse(JSON.stringify(h)), -12))));
  const target = [0.8, 1];
  const origin = [0, 0, 2.4];
  const direction = [target[0], -cfg.floorDrop + greenHeight(target, slope), target[1] - origin[2]];
  const hit = intersectGreen(origin, direction, cfg, slope);
  check("視線が実際に描かれた勾配の高さで交差する", hit && near(hit[0], target[0]) && near(hit[1], target[1]));
  check("視線が上向き・範囲外・地面の裏からの場合は狙いを作らない", intersectGreen(origin, [0, 1, 0], cfg, slope) === null && intersectGreen(origin, [10, -1, 0], cfg, slope) === null && intersectGreen([0, -cfg.floorDrop - 1, 1], [0, -1, 0], cfg, slope) === null);
  const g = new GolfGame();
  const snapshot = g.snapshot(0);
  snapshot.holes[1].slope[0] = 10;
  snapshot.holes[2].obstacles[0].center[0] = 10;
  check("配信用地形を変更してもサーバーの勾配と障害物を変えない", g.holes[1].slope[0] === 0.02 && g.holes[2].obstacles[0].center[0] === 0);
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
  const r5 = runSwing(det5, { impactDps: 10 });
  check("戻りが遅い（10 < 20 deg/s）と空振り扱い", r5.impact === null);
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
  // 頂点で止まる振り（0.3s）: 構え直さずに戻りを検出する（外部レビュー指摘）
  const det9 = new SwingDetector();
  {
    let now = 0;
    let impact = null;
    const step = (g) => {
      const r = det9.sample(now, g, [0, 0, 1], DT);
      if (r) impact = r;
      now += DT * 1000;
    };
    for (let t = 0; t < 0.4; t += DT) step([0, 0, 0]);
    for (let t = 0; t < 15 / 120; t += DT) step([120, 0, 0]);
    for (let t = 0; t < 0.3; t += DT) step([0.5, 0, 0]);
    for (let t = 0; t < 0.25; t += DT) step([-120, 0, 0]);
    check("バックスイングの頂点で 0.3s 止まっても構え直さず、戻りをインパクトにする", impact !== null && near(impact.dps, 120, 1) && near(impact.backswingDeg, 15, 1), JSON.stringify(impact));
  }
  // ジャイロのバイアス: 構えの静止で平均を取り、以後引く。構えたまま待っても偽のバックスイングにならない
  const det10 = new SwingDetector();
  {
    let now = 0;
    let impact = null;
    const bias = [3, -2, 1];
    const step = (g) => {
      const r = det10.sample(now, [g[0] + bias[0], g[1] + bias[1], g[2] + bias[2]], [0, 0, 1], DT);
      if (r) impact = r;
      now += DT * 1000;
    };
    for (let t = 0; t < 0.5; t += DT) step([0, 0, 0]);
    check("構えでバイアスを推定する", near(det10.bias[0], 3, 0.01) && near(det10.bias[1], -2, 0.01));
    for (let t = 0; t < 3; t += DT) step([0, 0, 0]);
    check("バイアスがあっても 3 秒待って偽のバックスイングに入らない（角 1° 未満）", Math.abs(det10.angleDeg) < 1 && det10.phase === "address", `angle=${det10.angleDeg.toFixed(2)} phase=${det10.phase}`);
    for (let t = 0; t < 20 / 120; t += DT) step([120, 0, 0]);
    for (let t = 0; t < 0.2; t += DT) step([-300, 0, 0]);
    check("バイアスを引いた上で振りを検出し、フェイスの開きにバイアスが混ざらない", impact !== null && near(impact.dps, 300, 2) && Math.abs(impact.faceDeg) < 1, JSON.stringify(impact));
  }
  // 小さな持ち直し（6° 超をゆっくり）→ 0.5s 静止 → 本当の振り: 持ち直しの戻りを偽インパクトにしない（検証サブエージェント指摘）
  const det12 = new SwingDetector();
  {
    let now = 0;
    const impacts = [];
    const step = (g) => {
      const r = det12.sample(now, g, [0, 0, 1], DT);
      if (r) impacts.push(r);
      now += DT * 1000;
    };
    for (let t = 0; t < 0.4; t += DT) step([0, 0, 0]); // 構え
    for (let t = 0; t < 0.2; t += DT) step([-40, 0, 0]); // 持ち直し -8°
    for (let t = 0; t < DEFAULT_SWING_OPTIONS.swingStillMs / 1000 + 0.1; t += DT) step([0, 0, 0]); // swingStillMs 超の静止 → 構え直し
    for (let t = 0; t < 20 / 120; t += DT) step([120, 0, 0]); // 本当のバックスイング
    for (let t = 0; t < 0.2; t += DT) step([-300, 0, 0]); // 戻り
    check("持ち直し → 0.5s 静止 → 本当の振り: インパクトは 1 回で 300 deg/s（持ち直しの戻りではない）", impacts.length === 1 && near(impacts[0].dps, 300, 2), JSON.stringify(impacts));
  }
  // 頂点で長く止めた（maxSwingMs 超）あと、次の振りは検出できる
  const det13 = new SwingDetector({ maxSwingMs: 1000 });
  {
    let now = 0;
    const impacts = [];
    const step = (g) => {
      const r = det13.sample(now, g, [0, 0, 1], DT);
      if (r) impacts.push(r);
      now += DT * 1000;
    };
    for (let t = 0; t < 0.4; t += DT) step([0, 0, 0]);
    for (let t = 0; t < 20 / 120; t += DT) step([120, 0, 0]);
    for (let t = 0; t < 2.0; t += DT) step([0, 0, 0]); // 頂点で 2s（swingStillMs で構え直し = その振りは捨てる。maxSwingMs より先に起きる）
    for (let t = 0; t < 0.2; t += DT) step([-300, 0, 0]); // 戻し（構え直した位置からの動きなので新しいバックスイング）
    for (let t = 0; t < DEFAULT_SWING_OPTIONS.swingStillMs / 1000 + 0.15; t += DT) step([0, 0, 0]);
    for (let t = 0; t < 20 / 120; t += DT) step([120, 0, 0]);
    for (let t = 0; t < 0.2; t += DT) step([-300, 0, 0]);
    check("頂点で長く止めた振りは捨て、次の振りだけを検出する（1 回）", impacts.length === 1 && near(impacts[0].dps, 300, 2), JSON.stringify(impacts));
  }
  // 静止 → 持ち替え（動く）→ 別の姿勢で静止 → 構え: 「上」は直近の静止だけから決まる（外部レビュー指摘）
  const det11 = new SwingDetector();
  {
    let now = 0;
    const step = (g, a) => {
      det11.sample(now, g, a, DT);
      now += DT * 1000;
    };
    for (let t = 0; t < 0.5; t += DT) step([0, 0, 0], [0, 0, 1]); // 上 = +Z で構え
    for (let t = 0; t < 0.3; t += DT) step([200, 0, 0], [0, 0, 1]); // 持ち替え（動く）
    for (let t = 0; t < DEFAULT_SWING_OPTIONS.swingStillMs / 1000 + 0.3; t += DT) step([0, 0, 0], [1, 0, 0]); // 上 = +X で静止（swingStillMs 超）→ 構え直し
    check("持ち替え（振りの途中扱い）のあと長めに静止すると構え直す", det11.phase === "address" && det11.addresses === 2, `phase=${det11.phase} addresses=${det11.addresses}`);
    // +X まわりに回す（新しい「上」まわり = フェイスの開き）。古い上（+Z）が混ざっていれば faceDeg が小さくなる
    let impact = null;
    for (let t = 0; t < 20 / 120; t += DT) { const r = det11.sample(now, [0, 120, 0], [1, 0, 0], DT); if (r) impact = r; now += DT * 1000; }
    for (let t = 0; t < 0.2; t += DT) { const r = det11.sample(now, [50, -300, 0], [1, 0, 0], DT); if (r) impact = r; now += DT * 1000; }
    check("持ち替えた後の構えは直近の静止の姿勢だけで「上」を決める（faceDeg に持ち替え前が混ざらない）", impact !== null && impact.faceDeg > 3, JSON.stringify(impact));
  }
  // 角速度 → 速さ: 300 deg/s × 0.9m × gain 1 = 4.71 m/s
  check("impactSpeed = ω[rad/s] × 腕の長さ × gain", near(impactSpeed(300, 0.9, 1), (300 * Math.PI / 180) * 0.9));
  // 滑らかに減速する振り（半正弦のバックスイング 20°/0.5s → 頂点で 0.35s → 戻り）も検出する（頂点の前後の減速を静止に数えない）
  const det14 = new SwingDetector();
  {
    let now = 0;
    const impacts = [];
    const step = (g) => {
      const r = det14.sample(now, g, [0, 0, 1], DT);
      if (r) impacts.push(r);
      now += DT * 1000;
    };
    for (let t = 0; t < 0.4; t += DT) step([0, 0, 0]);
    const backSec = 0.5;
    const amp = 20;
    for (let t = 0; t < backSec; t += DT) step([(amp * Math.PI) / (2 * backSec) * Math.sin((Math.PI * t) / backSec), 0, 0]); // 半正弦（積分 = amp）
    for (let t = 0; t < 0.35; t += DT) step([0, 0, 0]);
    for (let t = 0; t < 0.25; t += DT) step([-200, 0, 0]);
    check("滑らかに減速して頂点で 0.35s 止まる振りも検出する", impacts.length === 1 && near(impacts[0].dps, 200, 2) && near(impacts[0].backswingDeg, amp, 1), JSON.stringify(impacts));
  }
}

// ================= 4. game =================
{
  const g = new GolfGame({ holes: 2 }, { settleMs: 100, turnTimeoutMs: 1000 });
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
  check("構えが無ければ正面（勾配や障害物の自動補正はしない）", (() => { g.clearAim("p1"); return JSON.stringify(g.aimOf("p1")) === "[0,-1]" && g.holes[0].cup[0] === 0; })());
  check("手番でなくても自分の構えはできる", g.address("p2", [0, 0]) === true);
  // 1 打（弱い）: 転がり → rolling → settle 後に p2 の手番
  const e1 = g.stroke("p1", 0.5, 0, now);
  check("1 打を受理: rolling・roll に from/vel/end・打数 1", e1?.[0]?.kind === "stroke" && g.phase === "rolling" && g.roll?.by === "p1" && g.balls.get("p1").strokes === 1 && !g.balls.get("p1").holed);
  check("外しても一打で終了し、確定距離を記録", g.balls.get("p1").done && g.balls.get("p1").distanceMm > 0);
  check("表示は転がり中に確定済みの距離を先出ししない", shotLabel(g.snapshot(now), "p1") === "転がり中" && scoreTotal(g.snapshot(now), "p1") === 0);
  check("転がっている間の stroke は拒否", g.stroke("p2", 1, 0, now) === null && /phase=rolling/.test(g.lastRejectReason));
  check("転がりの途中の tick では何も起きない", g.tick(now + 10).length === 0);
  now += g.roll.duration * 1000 + 200;
  const e2 = g.tick(now);
  check("止まって settle 後に次の手番（p2）", e2[0]?.kind === "turn" && e2[0].playerId === "p2" && g.phase === "aim" && g.turn === "p2");
  // p2 がカップイン（カップへ明示的に構え、届く速さ）
  const ball2 = g.balls.get("p2");
  const cup = g.holes[0].cup;
  const dist = Math.hypot(cup[0] - ball2.pos[0], cup[1] - ball2.pos[1]);
  g.address("p2", cup);
  const e3 = g.stroke("p2", speedForDistance(dist, g.config.decel) + 0.2, 0, now);
  check("p2 が適度な速さでカップの方向に打つとカップイン（done）", e3?.[0]?.holed === true && g.balls.get("p2").holed && g.balls.get("p2").done, JSON.stringify(g.roll));
  now += g.roll.duration * 1000 + 200;
  const e4 = g.tick(now);
  check("全員の一打後はラウンド結果（同じボール位置を維持）", e4[0]?.kind === "roundResult" && g.phase === "roundResult" && g.hole === 0 && g.turn === null && g.balls.get("p1").strokes === 1);
  check("カップインが1位2点、外した人が2位1点", g.balls.get("p2").rank === 1 && g.cards.get("p2")[0] === 2 && g.balls.get("p1").rank === 2 && g.cards.get("p1")[0] === 1);
  check("二打目は拒否され、得点が増えない", g.stroke("p1", 0.4, 0, now) === null && g.cards.get("p1")[0] === 1 && g.balls.get("p1").strokes === 1);
  const snapRound = g.snapshot(now);
  check("確定結果の表示は距離・順位・加点、合計は二重加算しない", /2位.*残り.*1点/.test(shotLabel(snapRound, "p1")) && scoreTotal(snapRound, "p2") === 2);
  check("時間が経っても結果を保持し、再採点しない", g.tick(now + 60000).length === 0 && g.phase === "roundResult" && g.cards.get("p1").length === 1);
  now += 60000;
  const e6 = g.advanceRound(now);
  check("マスター進行で次の配置、手番は参加順の先頭", e6?.[0]?.kind === "hole" && e6[0].hole === 1 && e6[1]?.playerId === "p1");
  check("結果表示中以外の進行要求は拒否", g.advanceRound(now) === null && /phase=aim/.test(g.lastRejectReason));
  check("新ラウンドは全員ティー・未打・狙い解除・距離と順位とrollをクリア", [...g.balls.values()].every(b => b.strokes === 0 && !b.done && b.distanceMm === null && b.rank === null && JSON.stringify(b.pos) === JSON.stringify(g.holes[1].tee)) && g.aims.size === 0 && g.roll === null);
  // タイムアウト: 打っていないまま0点、次の人へ
  const e7 = g.tick(now + 1001);
  check("手番のタイムアウトは未打・距離なしで次の人へ", e7[0]?.kind === "timeout" && e7[0].by === "p1" && g.balls.get("p1").strokes === 0 && g.balls.get("p1").distanceMm === null && g.balls.get("p1").done && e7[1]?.playerId === "p2");
  now += 1001;
  // 途中参加: いまのホールのティーから、手番はそのまま
  g.join("p3", "Carol", now);
  check("途中参加はいまのホールのティーから・色 3・手番は変わらない", g.players.get("p3").color === 3 && g.balls.get("p3").pos[1] === g.holes[1].tee[1] && g.turn === "p2" && g.cards.get("p3").length === 0);
  // p2 がカップイン → p3 の手番 → p3 が抜ける → ホール終了 → 結果
  const b2 = g.balls.get("p2");
  const d2 = Math.hypot(g.holes[1].cup[0] - b2.pos[0], g.holes[1].cup[1] - b2.pos[1]);
  g.address("p2", g.holes[1].cup);
  g.stroke("p2", speedForDistance(d2, g.config.decel) + 0.2, -4, now);
  check("p2 は横勾配を見越して右4度を狙うとカップイン", g.balls.get("p2").holed);
  now += g.roll.duration * 1000 + 200;
  const e8 = g.tick(now);
  check("次は途中参加の p3", e8[0]?.playerId === "p3");
  const leaveRound = g.leave("p3", now);
  check("未打の人が退出しても残り全員終了ならラウンド結果へ", leaveRound[0]?.kind === "roundResult" && g.phase === "roundResult");
  const e9 = g.advanceRound(now);
  check("最終ラウンドをマスターが進めると総合結果、最多点のp2が勝ち", e9?.[0]?.kind === "result" && g.phase === "result" && g.winners.length === 1 && g.winners[0] === "p2" && g.winnerNames[0] === "Bob", JSON.stringify(e9));
  check("合計: p1 = 1 + 0、p2 = 2 + 2", g.totalOf("p1") === 1 && g.totalOf("p2") === 4);
  const snap = g.snapshot(now, e9[0]);
  check("snapshot: players・balls・cards・holes・winners・event", snap.players.length === 2 && snap.balls.p1.strokes === 0 && snap.cards.p2.length === 2 && snap.holes.length === 2 && snap.winners[0] === "p2" && snap.event.kind === "result" && snap.turn === null);
  check("総合結果も時間では消えない", g.tick(now + 60000).length === 0 && g.phase === "result");
  const e10 = g.restart(now + 60000);
  check("マスターの最初からで再開（restart + 手番 p1、ラウンド 1、カード空）", e10[0]?.kind === "restart" && e10[1]?.kind === "turn" && g.hole === 0 && g.cards.get("p1").length === 0 && g.phase === "aim");
  // 全員抜けると lobby
  g.leave("p1", now);
  check("手番の p1 が抜けると p2 の手番", g.turn === "p2");
  g.leave("p2", now);
  check("全員抜けると lobby", g.phase === "lobby" && g.turn === null);
  // 転がしている本人が抜けると、止まったあとの手番は「抜けた人の次」（先頭に戻らない。外部レビュー指摘）
  const g4 = new GolfGame({}, { settleMs: 100 });
  for (const [id, n] of [["p1", "A"], ["p2", "B"], ["p3", "C"], ["p4", "D"]]) g4.join(id, n, 0);
  g4.stroke("p1", 0.5, 0, 0);
  g4.tick(g4.roll.duration * 1000 + 200);
  check("p2 の番", g4.turn === "p2");
  g4.stroke("p2", 0.5, 0, 0);
  const rollDur = g4.roll.duration;
  g4.leave("p2", 0);
  const e4l = g4.tick(rollDur * 1000 + 200);
  check("p2 が転がし中に抜けると、止まった後は p3 の番（p1 に戻らない）", e4l[0]?.kind === "turn" && e4l[0].playerId === "p3", JSON.stringify(e4l));
  // 結果表示中に参加した（一度も打っていない）人は勝者にならない
  const g5 = new GolfGame({ holes: 1 }, { settleMs: 100 });
  g5.join("p1", "A", 0);
  {
    const cup = g5.holes[0].cup;
    const b = g5.balls.get("p1");
    g5.address("p1", cup);
    g5.stroke("p1", speedForDistance(Math.hypot(cup[0] - b.pos[0], cup[1] - b.pos[1]), g5.config.decel) + 0.2, 0, 0);
    g5.tick(g5.roll.duration * 1000 + 200);
    g5.advanceRound(g5.roll.startedAt + g5.roll.duration * 1000 + 200);
    check("1 人でも 1 ホール終えれば結果（勝者は本人）", g5.phase === "result" && g5.winners[0] === "p1");
    check("結果表示中はカードに最終ホールが入り、roll は消えている", g5.cards.get("p1").length === 1 && g5.roll === null);
    g5.join("p9", "Z", 0);
    g5.leave("p1", 0);
    check("結果表示中に参加した人だけが残っても勝者にはならない（空）", g5.phase === "result" && g5.winners.length === 0, JSON.stringify(g5.winners));
    check("終えた人の構えは拒否（already done）", (() => { const g6 = new GolfGame(); g6.join("p1", "A", 0); g6.stroke("p1", 0.4, 0, 0); return g6.address("p1", [0, 0]) === false && /done/.test(g6.lastRejectReason); })());
  }
  // 3 人で手番の人が抜けると、直後の人（参加順の次）の手番になる（外部レビュー指摘: 配列が詰まるぶん 1 人飛ばしていた）
  const g3 = new GolfGame();
  g3.join("p1", "A", 0);
  g3.join("p2", "B", 0);
  g3.join("p3", "C", 0);
  const e3l = g3.leave("p1", 0);
  check("3 人で手番の p1 が抜けると次は p2（p3 を飛ばさない）", e3l[0]?.kind === "turn" && e3l[0].playerId === "p2" && g3.turn === "p2");
  g3.leave("p2", 0);
  check("続けて p2 が抜けると p3", g3.turn === "p3");
  // 寸法とルールの変更で最初から
  const g2 = new GolfGame({ holes: 1 });
  g2.join("p1", "A", 0);
  const es = g2.setFieldSize({ wallW: 2, wallH: 1.5, floorDepth: 4, floorDrop: 1 }, 0);
  check("寸法の変更: field + restart + turn。ホールは新しい寸法で作り直し", es?.[0]?.kind === "field" && es[1]?.kind === "restart" && g2.config.wallW === 2 && g2.holes[0].tee[1] > 3);
  check("不正な寸法は拒否", g2.setFieldSize({ wallW: 0, wallH: 1.5, floorDepth: 4, floorDrop: 1 }, 0) === null);
  const er = g2.setRules({ decel: 1.2, cupMaxSpeed: 1, holes: 2 }, 0);
  check("ルールの変更: ホール数が変わり最初から", er?.[0]?.kind === "rules" && g2.holes.length === 2 && g2.config.decel === 1.2);
  g2.stroke("p1", 0.5, 0, 0);
  check("転がっている間の寸法・ルールの変更は拒否", g2.setFieldSize({ wallW: 2, wallH: 1.5, floorDepth: 4, floorDrop: 1 }, 0) === null && g2.setRules({ decel: 1.2, cupMaxSpeed: 1, holes: 2 }, 0) === null);
  check("マーカーの配置はいつでも変えられる（ゲームは進めない）", g2.setMarkers([{ id: 1, face: "floor", pos: [0, -1, 2] }]) && g2.config.markers.length === 1 && g2.phase === "rolling");
}

// 一打勝負の境界条件: 残り距離・同順位・時間切れ・参加/退出・結果保持
{
  const g = new GolfGame({ holes: 2 }, { settleMs: 0, turnTimeoutMs: 1000 });
  for (const id of ["p1", "p2", "p3", "p4"]) g.join(id, id, 0);
  let now = 0;
  for (const [id, speed] of [["p1", 0.4], ["p2", 0.8], ["p3", 0.8]]) {
    g.address(id, g.holes[0].cup);
    g.stroke(id, speed, 0, now);
    now += g.roll.duration * 1000 + 1;
    g.tick(now);
  }
  check("未終了者がいる間は既に打った人の二打目を拒否", g.turn === "p4" && g.stroke("p1", 1, 0, now) === null);
  now = g.turnEndsAt;
  g.tick(now);
  check("残り距離で同順位: 1位・1位・3位、タイムアウト0点", g.balls.get("p2").rank === 1 && g.balls.get("p3").rank === 1 && g.balls.get("p1").rank === 3 && g.cards.get("p2")[0] === 4 && g.cards.get("p3")[0] === 4 && g.cards.get("p1")[0] === 2 && g.cards.get("p4")[0] === 0);
  const oldEnd = [...g.balls.get("p1").pos];
  g.join("p5", "Late", now);
  check("結果中の入室者は次から参加、既存点数は変わらない", g.balls.get("p5").done && g.cards.get("p5").length === 0 && g.cards.get("p2")[0] === 4 && shotLabel(g.snapshot(now), "p5") === "次から参加");
  g.leave("p3", now);
  check("結果中の退出で再採点しない・停止位置を維持", g.cards.get("p2")[0] === 4 && JSON.stringify(g.balls.get("p1").pos) === JSON.stringify(oldEnd));
  g.tick(now + 60000);
  check("長時間経過してもラウンド結果と停止位置を保持", g.phase === "roundResult" && JSON.stringify(g.balls.get("p1").pos) === JSON.stringify(oldEnd));
  g.advanceRound(now + 60000);
  check("結果中の参加者も次ラウンドで打てる", !g.balls.get("p5").done && g.balls.get("p5").distanceMm === null);
  g.stroke("p1", 0.5, 0, now + 60000);
  g.restart(now + 60001);
  check("転がり中のリスタートで得点・距離・順位・待機時間をリセット", g.phase === "aim" && g.roll === null && [...g.balls.values()].every(b => !b.done && b.distanceMm === null && b.rank === null) && [...g.cards.values()].every(c => c.length === 0) && g.hole === 0);

  const tied = new GolfGame({ holes: 1 }, { settleMs: 0 });
  tied.join("p1", "A", 0); tied.join("p2", "B", 0);
  now = 0;
  for (const id of ["p1", "p2"]) {
    tied.stroke(id, 0.4, 0, now);
    now += tied.roll.duration * 1000 + 1;
    tied.tick(now);
  }
  tied.advanceRound(now);
  check("合計同点は同時優勝", tied.phase === "result" && tied.winners.join(",") === "p1,p2");

  const solo = new GolfGame({ holes: 1 }, { settleMs: 0 });
  solo.join("p1", "A", 0);
  solo.stroke("p1", 0.4, 0, 0);
  now = solo.roll.duration * 1000;
  solo.tick(now);
  check("一人プレイでも外した一打でラウンド終了", solo.phase === "roundResult" && !solo.balls.get("p1").holed && solo.cards.get("p1")[0] === 1);
  solo.advanceRound(now);
  check("一人プレイの総合結果", solo.phase === "result" && solo.winners[0] === "p1");

  const timeout = new GolfGame({ holes: 1 }, { turnTimeoutMs: 100 });
  timeout.join("p1", "A", 0);
  timeout.tick(100); timeout.advanceRound(100);
  check("全員時間切れは0点・勝者なし", timeout.phase === "result" && timeout.winners.length === 0 && timeout.cards.get("p1")[0] === 0);
}

// ================= 5. server =================
const PORT = 5194;
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
  const old = connect({ ...cfg, v: "1" });
  check("旧ゴルフv1は入室拒否（一打ルール・得点の誤表示を防止）", (await old.waitFor(m => m.type === "error")) !== null);
  old.ws.close();
  const oldTerrain = connect({ ...cfg, v: "2" });
  check("地形を描けない旧v2は入室拒否", (await oldTerrain.waitFor(m => m.type === "error")) !== null);
  oldTerrain.ws.close();

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
  ov.send({ type: "address", playerId: "p2", target: cup });
  ov.send({ type: "stroke", playerId: "p2", speed: speedForDistance(dist, wa.config.decel) + 0.2, faceDeg: 0 });
  const stHoled = await a.waitFor((m) => m.type === "state" && m.state.event?.kind === "stroke" && m.state.event.by === "p2");
  check("俯瞰画面が p2 の代わりに打ち、カップイン", stHoled !== null && stHoled.state.event.holed === true && stHoled.state.balls.p2.holed, JSON.stringify(stHoled?.state.roll));
  // ルール変更（転がっている間は拒否 → 止まってから OK）
  ov.send({ type: "rules", decel: 1, cupMaxSpeed: 1.2, holes: 2 });
  const rejRules = await ov.waitFor((m) => m.type === "rejected" && /rolling/.test(m.reason));
  check("転がっている間のルール変更は rejected", rejRules !== null);
  const roundResult = await a.waitFor(m => m.type === "state" && m.state.phase === "roundResult", 6000);
  check("全員の一打後に距離・順位点付きのラウンド結果が配信される", roundResult && roundResult.state.balls.p1.distanceMm > 0 && roundResult.state.balls.p2.rank === 1 && roundResult.state.cards.p1[0] === 1 && roundResult.state.cards.p2[0] === 2);
  a.send({ type: "stroke", speed: 1, faceDeg: 0 });
  check("結果表示中の二打目はサーバーでも拒否", (await a.waitFor(m => m.type === "rejected" && /roundResult/.test(m.reason))) !== null);
  await sleep(500);
  check("時間が経ってもサーバーはラウンド結果を保持", !a.msgs.some(m => m.type === "state" && m.state.hole === 1));
  a.send({ type: "advanceRound" });
  check("プレイヤーからの進行は拒否", (await a.waitFor(m => m.type === "rejected" && /not overview/.test(m.reason))) !== null);
  ov.send({ type: "advanceRound" });
  const nextRound = await a.waitFor(m => m.type === "state" && m.state.event?.kind === "hole" && m.state.hole === 1);
  check("俯瞰画面の進行で正面の横勾配コース、全員未打・点数を保持", nextRound && nextRound.state.holes[1].cup[0] === 0 && nextRound.state.holes[1].slope[0] > 0 && nextRound.state.balls.p1.strokes === 0 && nextRound.state.balls.p1.distanceMm === null && nextRound.state.cards.p2[0] === 2);
  for (const holeIndex of [1, 2]) {
    for (const id of ["p1", "p2"]) {
      const speed = holeIndex === 2 && id === "p2" ? 3.5 : 1.932;
      const faceDeg = id === "p1" ? 0 : holeIndex === 1 ? -4 : -57;
      ov.send({ type: "stroke", playerId: id, speed, faceDeg });
      const message = await a.waitFor(m => m.type === "state" && m.state.hole === holeIndex && m.state.event?.kind === "stroke" && m.state.event.by === id);
      if (!message) throw new Error(`地形ラウンド ${holeIndex + 1} の ${id} のショットが届かない`);
      const s = message.state, r = s.roll, h = s.holes[s.hole];
      const replay = simulateRoll(r.from, r.vel, h.cup, wa.config, h);
      check("配信された地形と初速だけでサーバーの軌道・判定を再現できる", JSON.stringify(replay.end) === JSON.stringify(r.end) && replay.holed === r.holed && replay.duration === r.duration && replay.bounces === r.bounces, `round=${holeIndex + 1} player=${id}`);
      check("地形を見越して狙ったp2だけがカップイン", r.holed === (id === "p2"), `round=${holeIndex + 1} player=${id}`);
      const settled = await a.waitFor(m => m.type === "state" && m.state.hole === holeIndex && (id === "p1" ? m.state.phase === "aim" && m.state.turn === "p2" : m.state.phase === "roundResult"), 10000);
      if (!settled) throw new Error("転がりが完了しない");
    }
    ov.send({ type: "advanceRound" });
    const advanced = await a.waitFor(m => m.type === "state" && (holeIndex === 1 ? m.state.hole === 2 : m.state.phase === "result"));
    check("地形ラウンドもマスター操作でのみ次へ進む", advanced !== null, `round=${holeIndex + 1}`);
  }
  ov.send({ type: "rules", decel: 1, cupMaxSpeed: 1.2, holes: 2 });
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
