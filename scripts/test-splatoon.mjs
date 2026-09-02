// Phase 8 (08-splatoon) の回帰テスト。`npm run test:splatoon` で実行する。
//   1. src/shared/splatoon-sim.ts — Surface（壁 + 床）の UV・視線の交点・放物線の着弾・塗りの格子
//   2. src/shared/hand-math.ts — グー / パー / 指差しの判定（合成の手の形で）
//   3. src/shared/splatoon-game.ts — チーム割当・試合の時間・発射の検証・得点
//   4. server/splatoon.ts — WebSocket の受け付け・shot の配信・state の配信（Vite dev サーバーを起動して叩く）
// テストフレームワークは使わない（04〜07 と同じ方針）。Node 22.18+ は .ts をそのまま import できる
import { spawn } from "node:child_process";
import WebSocket from "ws";
import {
  BACK_ID,
  DEFAULT_FIELD,
  FLOOR_ID,
  LEFT_ID,
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
import { SHOT_RATE_PER_SEC, SplatoonGame, inkRegenPerSec } from "../src/shared/splatoon-game.ts";
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
  const all = fieldSurfaces(cfg);
  const [wall, floor, left, right, back] = all;
  check("5 枚（正面・床・左・右・背面）", all.length === 5 && left.id === LEFT_ID && back.id === BACK_ID);
  check("壁の法線は +Z、床の法線は +Y", wall.normal[2] === 1 && floor.normal[1] === 1);
  check("左右の法線はコートの内側（+X / -X）", left.normal[0] === 1 && right.normal[0] === -1);
  check("背面の法線は -Z（マーカー側）", back.normal[2] === -1);
  // 左の壁: 正面の壁際・上端 = UV (1, 0)
  const ltl = frameUvToPoint(left, [1, 0]);
  check("左の壁: UV (1,0) は正面の壁際の上端 (-1, -floorDrop + wallH, 0)", near(ltl[0], -1) && near(ltl[1], 0) && near(ltl[2], 0));
  const wtl = frameUvToPoint(wall, [0, 0]);
  check("壁: 下端は床に固定。UV (0,0) は左上 (-w/2, -floorDrop + wallH, 0)", near(wtl[0], -1) && near(wtl[1], 0) && near(wtl[2], 0));
  const wbl = frameUvToPoint(wall, [0, 1]);
  check("壁: UV (0,1) の高さは床（-floorDrop）", near(wbl[1], -1));
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
  check("壁に当たる（t=0.4s、y=-0.32。v は壁上端からの距離）", l1 && l1.surfaceId === WALL_ID && near(l1.hitT, 0.4) && near(l1.point[1], -0.32) && near(l1.uv[1], 0.32));
  // 遅い球は壁の手前で床へ: 1m/s → 壁まで 2s、床（y=-1）へは 0.5·4·t² = 1 → t = 0.707s
  const l2 = simulateInk([0, 0, 2], [0, 0, -1], [wall, floor], cfg);
  check("遅い球は先に床へ落ちる（t≈0.707s）", l2 && l2.surfaceId === FLOOR_ID && near(l2.hitT, Math.sqrt(0.5), 1e-6) && near(l2.point[2], 2 - Math.sqrt(0.5)));
  check("床の UV: 壁からの距離 / floorDepth", l2 && near(l2.uv[1], (2 - Math.sqrt(0.5)) / 1.5) && near(l2.uv[0], 0.5));
  // 上向きに撃つと放物線の下りで床へ（上りで面をまたがない）
  const l3 = simulateInk([0, 0, 1], [0, 2, -0.5], [wall, floor], cfg);
  check("山なりで床へ", l3 && l3.surfaceId === FLOOR_ID && l3.hitT > 1);
  // 左の壁への着弾: 真横へ撃つと x=-1（左の壁）に t=0.2 で当たる
  const lw = simulateInk([0, 0, 1], [-5, 0, 0], all, cfg);
  check("左の壁に当たる", lw && lw.surfaceId === LEFT_ID && near(lw.hitT, 0.2) && lw.hit);
  // 背面への着弾: 部屋の中から +Z へ
  const bw = simulateInk([0, 0, 0.5], [0, 0, 5], all, cfg);
  check("背面の壁に当たる", bw && bw.surfaceId === BACK_ID && near(bw.hitT, 0.2) && bw.hit);
  // 背面の外側（z > floorDepth）から -Z へ撃っても背面には塗れない（表側からだけ）
  const bw2 = simulateInk([0, 0, 3], [0, 0, -5], [back], cfg);
  check("背面の外側からは当たらない", bw2 === null);
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
  const g = new SplatoonGame({ matchSec: 30, resultSec: 2, wallW: 2, wallH: 1, waitSec: 1 });
  check("誰もいなくても tick は何も起こさない（練習のまま）", g.tick(0).length === 0 && g.phase === "practice");
  check("プレイヤーがいないと start は拒否", g.start(0).length === 0 && g.lastRejectReason === "no players" && g.phase === "practice");
  const e1 = g.join("p1", "A", 1000);
  check("入室しても練習のまま（自動では始まらない。issue #20）", e1.length === 0 && g.players.get("p1").color === 1 && g.phase === "practice" && g.phaseEndsAt === Infinity);
  check("snapshot の phaseEndsAt は練習中 null（JSON に Infinity は載らない）", g.snapshot(1000).phaseEndsAt === null);
  g.updatePose("p1", [0, 0.1, 1], 1100);
  // 壁の上端は床から wallH（この設定では y=-0.2）なので、下向きに撃って壁に当てる
  const practiceShot = g.shoot("p1", [0, 0, 1], [0, -2, -4.5], 0.09, 1100);
  check("練習中は撃てて塗れる", practiceShot !== null && practiceShot.landing?.hit === true && g.scores().p1 > 0, g.lastRejectReason);
  check("練習中はいくら tick しても始まらない", g.tick(100000).length === 0 && g.phase === "practice");
  const ec = g.start(1200);
  check("俯瞰画面の start でカウントダウン（waiting。waitSec 後に開始予定）", ec[0]?.kind === "countdown" && g.phase === "waiting" && g.phaseEndsAt === 2200);
  check("カウントダウン中の start は無視", g.start(1300).length === 0 && /waiting/.test(g.lastRejectReason) && g.phase === "waiting");
  check("カウントダウン中は撃てない", g.shoot("p1", [0, 0, 1], [0, 0, -5], 0.09, 1300) === null && g.lastRejectReason === "not playing");
  check("カウントダウンの前は tick しても始まらない", g.tick(1500).length === 0 && g.phase === "waiting");
  const es = g.tick(2200);
  check("カウントダウンが過ぎると開始（matchSec の計測はここから）。練習の塗りは消える", es[0]?.kind === "start" && g.phase === "play" && g.phaseEndsAt === 32200 && g.scores().p1 === 0);
  check("試合中の start は無視", g.start(2300).length === 0 && /play/.test(g.lastRejectReason));
  g.join("p2", "B", 2100);
  g.join("p3", "C", 2200);
  check("個人戦: 参加順に別の色（2, 3）", g.players.get("p2").color === 2 && g.players.get("p3").color === 3);
  g.leave("p1");
  g.join("p4", "D", 2300);
  check("試合中は退出者の色（1）を使い回さず、未使用の色（4）を割り当てる", g.players.get("p4").color === 4 && !g.lastJoinClearedColor);

  // レート制限（9/s）は検証より先に数えるので、検証のテストは 1.1 秒ずつ離して呼ぶ
  let tm = 2300;
  const next = () => (tm += 1100);
  check("発射: pose が届く前は拒否", g.shoot("p2", [0, 0, 2], [0, 0, -5], 0.09, next()) === null && g.lastRejectReason === "no pose yet");
  g.updatePose("p2", [0, 0.1, 2.3], 1500);
  g.updatePose("p3", [0, 0, 2.3], 1500);
  g.updatePose("p4", [1.5, 0, 0.8], 1500);
  check("発射: 頭から 1.2m 以上離れた位置からは拒否", g.shoot("p2", [0, 0, 0.3], [0, 0, -5], 0.09, next()) === null && g.lastRejectReason === "too far from head");
  const shot = g.shoot("p2", [0, 0, 2], [0, 0, -5], 0.09, next());
  check("発射: 受理され着弾（壁）と自分の色の塗りが起きる", shot && shot.color === 2 && shot.landing?.surfaceId === WALL_ID && g.scores().p2 > 0);
  check("発射: 速すぎる", g.shoot("p2", [0, 0, 2], [0, 0, -(g.config.shotSpeed * 1.5)], 0.09, next()) === null && g.lastRejectReason === "bad velocity/radius");
  check("発射: 半径が違う", g.shoot("p2", [0, 0, 2], [0, 0, -3], 0.2, next()) === null && g.lastRejectReason === "bad velocity/radius");
  g.updatePose("p2", [0, 0, -0.5], 1500);
  check("発射: 壁の裏（z<0）から", g.shoot("p2", [0, 0, -1], [0, 0, 3], 0.09, next()) === null && g.lastRejectReason === "bad position");
  g.updatePose("p2", [0, 0.1, 2.3], 1500);
  check("発射: 知らないプレイヤー", g.shoot("zz", [0, 0, 2], [0, 0, -3], 0.09, next()) === null);
  let ok = 0;
  const t0 = next();
  for (let i = 0; i < SHOT_RATE_PER_SEC + 3; i++) if (g.shoot("p3", [0, 0, 2], [0, 0, -3], 0.09, t0 + i)) ok++;
  check(`発射: 1 人 ${SHOT_RATE_PER_SEC}/s まで`, ok === SHOT_RATE_PER_SEC && g.lastRejectReason === "rate limited");
  const scoreBefore = JSON.stringify(g.scores());
  const miss = g.shoot("p4", [1.5, 0, 0.5], [3, 0, -1], 0.09, next());
  check("外れた発射も受理される（hit=false、塗らない）", miss && miss.landing?.hit === false && JSON.stringify(g.scores()) === scoreBefore);

  check("ここまでの発射は試合時間内", tm < 32200, `${tm}`);
  const ev = g.tick(32200);
  const sc = g.scores();
  const maxSc = Math.max(...Object.values(sc));
  check("時間切れで result（勝者 = 最多セルの人。同点は複数・名前つき）", ev[0]?.kind === "result" && g.phase === "result" && ev[0].winners.length >= 1 && ev[0].winners.every((id) => sc[id] === maxSc && maxSc > 0) && ev[0].winnerNames.length === ev[0].winners.length);
  // 勝者が result 中に退出しても、確定時の名前は snapshot に残る
  const winId = ev[0].winners[0];
  const winName = ev[0].winnerNames[0];
  g.leave(winId);
  const snapAfterLeave = g.snapshot(32500);
  check("勝者が退出しても winnerNames は確定時のまま", snapAfterLeave.winners.includes(winId) && snapAfterLeave.winnerNames[0] === winName);
  const survivor = [...g.players.keys()][0];
  check("result 中は発射できない", g.shoot(survivor, [0, 0, 2], [0, 0, -3], 0.09, 32500) === null && g.lastRejectReason === "not playing");
  const ev2 = g.tick(34200);
  check("結果表示が終わると練習に戻る（格子は消える・自動では次の試合にならない）", ev2[0]?.kind === "practice" && g.phase === "practice" && g.phaseEndsAt === Infinity && Object.values(g.scores()).every((v) => v === 0));
  const snap = g.snapshot(34200, true);
  check("snapshot: grids は 5 枚、totalCells は全部の和", Object.keys(snap.grids).length === 5 && snap.totalCells === Object.values(snap.grids).reduce((a, gs) => a + gs.length, 0));
  const inks = Object.values(snap.ink);
  check("snapshot: ink に残っている全員の残量", Object.keys(snap.ink).length === g.players.size && inks.every((v) => typeof v === "number" && v <= 1));
  check("練習に戻るとインクは満タン", inks.every((v) => v === 1));
  // 結果表示中にも start できる（次の対戦へ）
  const g2 = new SplatoonGame({ matchSec: 10, resultSec: 5, waitSec: 1 });
  g2.join("q1", "Q", 0);
  g2.start(0);
  g2.tick(1000);
  g2.tick(11000);
  check("result 中の start は受け付ける（結果表示を待たずに次の対戦へ）。勝者の表示は消える", g2.phase === "result" && g2.winners !== null && g2.start(12000)[0]?.kind === "countdown" && g2.phase === "waiting" && g2.winners === null && g2.snapshot(12000).winnerNames === null);
}

// ================= 3c. 全色使用時の再利用はセルを消す =================
{
  const g = new SplatoonGame({ matchSec: 300, wallW: 2, wallH: 1, waitSec: 0 });
  for (let i = 1; i <= 8; i++) g.join(`p${i}`, `P${i}`, 0);
  g.start(0);
  g.tick(1);
  g.updatePose("p1", [0, 0.1, 1], 10);
  // 壁の上端は床から wallH（この設定では y=-0.2）なので、下向きに撃って壁に当てる
  g.shoot("p1", [0, 0, 1], [0, -2, -4.5], 0.09, 100);
  const before = g.scores().p1;
  check("p1 が塗った", before > 0);
  g.leave("p1");
  const e = g.join("p9", "P9", 200);
  check("8 色使用済みなら退出者の色を再利用し、そのセルを消してから割り当てる", e.length === 0 && g.players.get("p9").color === 1 && g.lastJoinClearedColor && g.scores().p9 === 0);
}

// ================= 3d. 練習中の色の再利用 =================
{
  const g = new SplatoonGame({ matchSec: 300, wallW: 2, wallH: 1, waitSec: 0 });
  g.join("p1", "A", 0);
  g.updatePose("p1", [0, 0.1, 1], 10);
  g.shoot("p1", [0, 0, 1], [0, -2, -4.5], 0.09, 100);
  check("練習中に p1 が塗った", g.scores().p1 > 0);
  g.leave("p1");
  g.join("p2", "B", 200);
  check("練習中は退出者の色（1）をすぐ再利用し、その塗りは消す（再接続で色が増えていかない）", g.players.get("p2").color === 1 && g.lastJoinClearedColor && g.scores().p2 === 0);
  g.leave("p2");
  g.join("p3", "C", 300);
  check("消すセルが無ければ格子の配り直しは要らない", g.players.get("p3").color === 1 && !g.lastJoinClearedColor);
}

// ================= 3b. インクタンク =================
{
  const g = new SplatoonGame({ matchSec: 300, wallW: 2, wallH: 1, waitSec: 0 });
  g.join("p1", "A", 0);
  g.start(0);
  g.tick(1);
  g.updatePose("p1", [0, 0.1, 1], 2);
  const cost = inkPerShot(g.config);
  // 満タンから「拒否されるまで」連射（250ms 間隔 = 4/s なのでレート制限には当たらない）。
  // 撃った直後 inkRegenDelaySec（1s）は回復しないので、連射中は回復せずちょうど tankShots 発で切れる
  let fired = 0;
  let t = 1000;
  for (let i = 0; i < g.config.tankShots + 10; i++) {
    if (g.shoot("p1", [0, 0, 1], [0, 0, -5], 0.09, t)) fired++;
    else break;
    t += 250;
  }
  check(`満タンでちょうど ${g.config.tankShots} 発で "no ink"（連射中は回復しない）`, fired === g.config.tankShots && g.lastRejectReason === "no ink", `${fired} shots`);
  const empty = g.inkOf("p1", t);
  check("撃ち切った直後は 1 発ぶん未満", empty < cost + 0.05, empty.toFixed(3));
  check("snapshot の ink は 0..1 にクランプ（-0.01 にならない）", g.snapshot(t).ink.p1 >= 0);
  // 回復の基準点（撃ってから delay 経過後）を過ぎてから測る。場所に依存しない単一レート
  const t1 = t + g.config.inkRegenDelaySec * 1000 + 500;
  const e1 = g.inkOf("p1", t1);
  const e2 = g.inkOf("p1", t1 + 2000);
  check("回復（2 秒で 2/inkFullSec）", near(e2 - e1, 2 / g.config.inkFullSec, 0.01), (e2 - e1).toFixed(3));
  // グーで補充（issue #20）: グーの間は inkFistFullSec で満タン。形の切り替えは pose で届く
  const t2 = t1 + 2000;
  g.updatePose("p1", [0, 0.1, 1], t2, true);
  const f1 = g.inkOf("p1", t2);
  const f2 = g.inkOf("p1", t2 + 500);
  check("グーの間は速く回復（0.5 秒で 0.5/inkFistFullSec）", near(f2 - f1, 0.5 * inkRegenPerSec(g.config, true), 0.01) && inkRegenPerSec(g.config, true) > inkRegenPerSec(g.config, false), (f2 - f1).toFixed(3));
  g.updatePose("p1", [0, 0.1, 1], t2 + 500, false);
  const f3 = g.inkOf("p1", t2 + 1000);
  check("グーをやめると元の速さに戻る", near(f3 - f2, 0.5 / g.config.inkFullSec, 0.01), (f3 - f2).toFixed(3));
  check("グーでも満タンは超えない", g.inkOf("p1", t2 + 60000) === 1);
  // コートを広げても奥から撃てる（発射位置の上限はコートの対角 + 1m）
  const wide = new SplatoonGame({ matchSec: 300, floorDepth: 8, waitSec: 0 });
  wide.join("w1", "W", 0);
  wide.start(0);
  wide.tick(1);
  wide.updatePose("w1", [0, 0.1, 7.5], 10);
  check("広いコートの奥からも発射できる", wide.shoot("w1", [0, 0, 7.4], [0, 0, -5], 0.09, 100) !== null);
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
  const cfg = { room: "test", markerId: "0", markerMm: "100", matchSec: "20", waitSec: "1" };
  const a = connect(cfg, "Alice");
  const wa = await a.waitFor((m) => m.type === "welcome");
  check("welcome: id・role・config・格子付きの state・練習フェーズから", wa && wa.id === "p1" && wa.role === "player" && wa.config.matchSec === 20 && wa.config.waitSec === 1 && wa.state.grids && wa.state.phase === "practice" && wa.state.phaseEndsAt === null && wa.state.players[0].color === 1);
  const b = connect(cfg, "Bob");
  const wb = await b.waitFor((m) => m.type === "welcome");
  check("2 人目は色 2・peers に p1", wb && wb.state.players.find((p) => p.id === wb.id).color === 2 && wb.peers.includes("p1"));
  const stA = await a.waitFor((m) => m.type === "state" && m.state.players.length === 2);
  check("入室で state が配られる", stA !== null);

  // 練習中に撃てる
  b.send({ type: "shot", pos: [0, 0, 2], vel: [0, 0, -5], radius: 0.09 });
  const rejNoPose = await b.waitFor((m) => m.type === "rejected");
  check("pose を送る前の shot は拒否（発射位置の検証に頭の位置が要る）", rejNoPose && /pose/.test(rejNoPose.reason));
  b.send({ type: "pose", pos: [0, 0.1, 2.3], quat: [0, 0, 0, 1], tracking: true, fist: false });
  await sleep(50);
  b.send({ type: "shot", pos: [0, 0, 2], vel: [0, 0, -5], radius: 0.09 });
  const sa = await a.waitFor((m) => m.type === "shot");
  check("練習中の shot が全員に配られ、着弾（壁）と色が付く", sa && sa.shot.by === "p2" && sa.shot.color === 2 && sa.shot.landing?.surfaceId === "wall" && typeof sa.t === "number");
  const practiceScore = await a.waitFor((m) => m.type === "state" && (m.state.scores.p2 ?? 0) > 0, 2500);
  check("練習中の塗りも state の得点に出る", practiceScore !== null && practiceScore.state.phase === "practice");

  // 俯瞰画面（role=overview）: プレイヤーではない・join を配らない・start を送れる唯一の端末
  const ov = connect({ ...cfg, role: "overview" });
  const wov = await ov.waitFor((m) => m.type === "welcome");
  check("俯瞰画面の welcome: role=overview・peers はプレイヤー 2 人・格子付き state", wov && wov.role === "overview" && wov.peers.length === 2 && wov.peers.includes("p1") && wov.state.grids && wov.state.players.length === 2);
  await sleep(200);
  check("俯瞰画面の入室で join は配られず、プレイヤー一覧にも入らない", !a.msgs.some((m) => m.type === "join" && m.id === wov.id) && !a.msgs.some((m) => m.type === "state" && m.state.players.some((p) => p.id === wov.id)));
  const stBefore = a.msgs.filter((m) => m.type === "state").length;
  b.send({ type: "start" });
  await sleep(300);
  check("スマホからの start は無視される（練習のまま）", !a.msgs.slice(stBefore).some((m) => m.type === "state" && m.state.phase !== "practice"));
  ov.send({ type: "pose", pos: [0, 0, 1], quat: [0, 0, 0, 1], tracking: true });
  await sleep(100);
  check("俯瞰画面の pose は中継されない", !a.msgs.some((m) => m.type === "pose" && m.id === wov.id));
  ov.send({ type: "start" });
  const cd = await a.waitFor((m) => m.type === "state" && m.state.phase === "waiting" && m.state.event?.kind === "countdown");
  check("俯瞰画面の start でカウントダウン（waiting）が全員に配られる", cd !== null && typeof cd.state.phaseEndsAt === "number");
  ov.send({ type: "start" });
  const rejStart = await ov.waitFor((m) => m.type === "rejected");
  check("カウントダウン中の start は俯瞰画面に rejected", rejStart && /waiting/.test(rejStart.reason));
  const playSt = await a.waitFor((m) => m.type === "state" && m.state.phase === "play" && m.state.event?.kind === "start", 4000);
  check("waitSec 後に start が配られ play になる（格子付き・練習の得点は消える）", playSt !== null && playSt.state.grids && (playSt.state.scores.p2 ?? 0) === 0);
  const ovPlay = await ov.waitFor((m) => m.type === "state" && m.state.phase === "play", 1000);
  check("俯瞰画面にも state が届く", ovPlay !== null);
  b.send({ type: "shot", pos: [0, 0, 2], vel: [0, 0, -5], radius: 0.09 });
  const ovShot = await ov.waitFor((m) => m.type === "shot" && m.shot.by === "p2" && m.shot.launchedAt > playSt.state.t);
  check("試合中の shot が俯瞰画面にも届く", ovShot !== null);
  b.send({ type: "shot", pos: [0, 0, 2], vel: [0, 0, -50], radius: 0.09 });
  const rej = await b.waitFor((m) => m.type === "rejected" && /velocity/.test(m.reason));
  check("不正な shot は本人に rejected", rej !== null);
  const bigField = connect({ ...cfg, room: "big", wallW: "20", wallH: "20", floorDepth: "20" });
  const errBig = await bigField.waitFor((m) => m.type === "error");
  check("格子が大きすぎるフィールドは拒否", errBig && /不正/.test(errBig.reason));
  // 練習中の state を拾わないよう、試合開始後の state に限定する
  const st = await a.waitFor((m) => m.type === "state" && m.state.phase === "play" && m.state.t > playSt.state.t && (m.state.scores.p2 ?? 0) > 0, 2500);
  check("試合中の state に得点が反映される（p2 が塗った。練習の分は消えている）", st !== null && (st.state.scores.p1 ?? 0) === 0);
  check("state にインク残量（B は 1 発ぶん減っている）", st && st.state.ink.p2 < 1 && st.state.ink.p1 === 1, JSON.stringify(st?.state.ink));
  // fist を付けない pose は中継にも fist が付かない（true のときだけ載せる）
  b.send({ type: "pose", pos: [0.25, 0, 1.5], quat: [0, 0, 0, 1], tracking: true });
  const poseNoFist = await a.waitFor((m) => m.type === "pose" && m.id === "p2" && m.pos[0] === 0.25);
  check("fist を付けない pose には fist が付かない", poseNoFist && poseNoFist.fist === undefined);
  b.send({ type: "start" });
  const rejPhone = await b.waitFor((m) => m.type === "rejected" && /overview/.test(m.reason));
  check("スマホからの start には rejected: not overview が返る", rejPhone !== null);
  // 俯瞰画面の再接続: 新しい id で welcome、peers に古い id は残らない
  ov.ws.close();
  await sleep(100);
  const ov2 = connect({ ...cfg, role: "overview" });
  const wov2 = await ov2.waitFor((m) => m.type === "welcome");
  check("俯瞰画面の再接続: 新しい id・peers はプレイヤー 2 人だけ（古い俯瞰 id は残らない）", wov2 && wov2.id !== wov.id && wov2.role === "overview" && wov2.peers.length === 2 && !wov2.peers.includes(wov.id) && wov2.state.grids);
  // 俯瞰だけの room で start → no players
  const solo = connect({ ...cfg, room: "solo", role: "overview" });
  await solo.waitFor((m) => m.type === "welcome");
  solo.send({ type: "start" });
  const rejSolo = await solo.waitFor((m) => m.type === "rejected");
  check("プレイヤーがいない room の start は rejected: no players", rejSolo && /no players/.test(rejSolo.reason));
  solo.ws.close();
  // 役割別の上限: プレイヤー 8 人 / 俯瞰 2 台（room-server の canJoin）
  const full = "full";
  const fullPlayers = Array.from({ length: 8 }, (_, i) => connect({ ...cfg, room: full }, `F${i}`));
  await Promise.all(fullPlayers.map((c) => c.waitFor((m) => m.type === "welcome")));
  const ninth = connect({ ...cfg, room: full }, "Ninth");
  const errNinth = await ninth.waitFor((m) => m.type === "error");
  check("プレイヤー 9 人目は満員で拒否", errNinth && /満員/.test(errNinth.reason));
  const fov1 = connect({ ...cfg, room: full, role: "overview" });
  const wf1 = await fov1.waitFor((m) => m.type === "welcome");
  check("満員でも俯瞰画面は入れる（役割別に数える）", wf1 && wf1.role === "overview" && wf1.peers.length === 8);
  const fov2 = connect({ ...cfg, room: full, role: "overview" });
  await fov2.waitFor((m) => m.type === "welcome");
  const fov3 = connect({ ...cfg, room: full, role: "overview" });
  const errOv3 = await fov3.waitFor((m) => m.type === "error");
  check("俯瞰画面 3 台目は拒否", errOv3 && /俯瞰画面/.test(errOv3.reason));
  for (const c of [...fullPlayers, fov1, fov2]) c.ws.close();
  await sleep(100);

  b.send({ type: "pose", pos: [0.5, 0, 1.5], quat: [0, 0, 0, 2], tracking: true, fist: true });
  const pose = await a.waitFor((m) => m.type === "pose" && m.id === "p2" && m.pos[0] === 0.5);
  check("pose が中継され quat は正規化・fist も付く", pose && Math.abs(pose.quat[3] - 1) < 1e-9 && pose.fist === true);
  const ovPose = await ov2.waitFor((m) => m.type === "pose" && m.id === "p2" && m.pos[0] === 0.5);
  check("pose は俯瞰画面にも届く（再接続後の俯瞰画面）", ovPose !== null);

  const bad = connect({ ...cfg, gravity: "9.8" });
  const err = await bad.waitFor((m) => m.type === "error");
  check("フィールド設定が違う端末は入室拒否", err && /不一致/.test(err.reason));

  b.ws.close();
  const la = await a.waitFor((m) => m.type === "leave");
  check("leave が届く", la && la.id === "p2");
  const leavesBefore = a.msgs.filter((m) => m.type === "leave").length;
  ov2.ws.close();
  await sleep(200);
  check("俯瞰画面の退室で leave は配られない", a.msgs.filter((m) => m.type === "leave").length === leavesBefore);
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
