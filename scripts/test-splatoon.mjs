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
  MAX_FIELD_CELLS,
  WALL_ID,
  fieldCellCount,
  fieldSurfaces,
  inkPerShot,
  validateFieldSize,
  framePointToUv,
  frameUvToPoint,
  inkAt,
  rayFrameHit,
  simulateInk,
} from "../src/shared/splatoon-sim.ts";
import { FIST_STALE_MS, SHOT_RATE_PER_SEC, SplatoonGame, inkRegenPerSec } from "../src/shared/splatoon-game.ts";
import { handShape } from "../src/shared/hand-math.ts";
import {
  MAX_DROPS,
  MAX_EDGE_SCALE,
  MIN_DROPS,
  edgePoint,
  edgeScale,
  impactDirUv,
  insideCore,
  insideSplat,
  isWallSurface,
  splatExtent,
  splatShape,
} from "../src/shared/splat-shape.ts";
import { centered, syntheticHandShape } from "../src/shared/fake-hands.ts";
import { SPLATOON_PATH, SPLATOON_PROTOCOL_VERSION } from "../src/shared/splatoon-protocol.ts";
import { dragAxes, draggedMarkerPos, faceNormal, rayPlaneHit, roundCm } from "../src/shared/marker-drag.ts";
import {
  MAX_EXTRA_MARKERS,
  MARKER_FACES,
  MARKER_POS_LIMIT_M,
  describeMarkers,
  fusePoseCandidates,
  invertRigid,
  markerAxes,
  markerToFieldMatrix,
  mulMat4,
  suggestedMarkerPos,
  transformPoint,
  validateMarkerLayout,
  withFloorDrop,
} from "../src/shared/marker-layout.ts";
import { fakeCameraToField, parseFakeMarkersParam, projectFakeMarker, projectFakeMarkers } from "../src/shared/fake-markers.ts";
import { Matrix4, Quaternion, Vector3 } from "three";

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

// ================= 1c. フィールドの寸法の検証（サーバーと俯瞰画面で共有）=================
{
  const g = new SplatoonGame();
  check("fieldCellCount は InkGrid の合計と一致", fieldCellCount(DEFAULT_FIELD) === g.totalCells, `${fieldCellCount(DEFAULT_FIELD)} vs ${g.totalCells}`);
  check("既定の寸法は有効", validateFieldSize({ wallW: 3, wallH: 2.4, floorDepth: 2.5, floorDrop: 1.2 }) === null);
  check("範囲外（0.1m / 21m / NaN / マーカー 6m）は理由付きで拒否", /wallW/.test(validateFieldSize({ wallW: 0.1, wallH: 2.4, floorDepth: 2.5, floorDrop: 1.2 }) ?? "") && /floorDepth/.test(validateFieldSize({ wallW: 3, wallH: 2.4, floorDepth: 21, floorDrop: 1.2 }) ?? "") && /wallH/.test(validateFieldSize({ wallW: 3, wallH: NaN, floorDepth: 2.5, floorDrop: 1.2 }) ?? "") && /floorDrop/.test(validateFieldSize({ wallW: 3, wallH: 2.4, floorDepth: 2.5, floorDrop: 6 }) ?? ""));
  check("マーカーの高さが壁の高さより上は拒否（マーカーの真下に塗れない帯ができる）", /floorDrop/.test(validateFieldSize({ wallW: 3, wallH: 1, floorDepth: 2.5, floorDrop: 1.5 }) ?? "") && validateFieldSize({ wallW: 3, wallH: 1, floorDepth: 2.5, floorDrop: 1 }) === null);
  check("セル数の上限を超える寸法は拒否", /大きすぎ/.test(validateFieldSize({ wallW: 20, wallH: 20, floorDepth: 20, floorDrop: 1.2 }) ?? "") && fieldCellCount({ wallW: 20, wallH: 20, floorDepth: 20, floorDrop: 1.2, cellM: DEFAULT_FIELD.cellM }) > MAX_FIELD_CELLS);
}

// ================= 1b. splat shape（飛沫の形）=================
{
  const cfg = { ...DEFAULT_FIELD, wallW: 2, wallH: 1, floorDrop: 1, floorDepth: 1.5 };
  const [wall, floor] = fieldSurfaces(cfg);
  const a = splatShape(42, 0.09, [0, 1]);
  const b = splatShape(42, 0.09, [0, 1]);
  const c = splatShape(43, 0.09, [0, 1]);
  check("同じ seed なら同じ形（全端末とサーバーで一致する）", JSON.stringify(a) === JSON.stringify(b));
  check("seed が違えば形が違う", JSON.stringify(a) !== JSON.stringify(c));
  check(`滴は ${MIN_DROPS + 1}〜${MAX_DROPS + 2} 個（後ろ側の 1〜2 個込み）`, a.drops.length >= MIN_DROPS + 1 && a.drops.length <= MAX_DROPS + 2, `${a.drops.length}`);
  check("向きがあれば進行方向に伸びる（stretch > 1）", a.stretch > 1 && splatShape(42, 0.09, null).stretch === 1);
  let edgeOk = true;
  let coreOk = true;
  for (let i = 0; i < 36; i++) {
    const th = (i / 36) * Math.PI * 2;
    const es = edgeScale(a, th);
    if (es < 0.6 || es > MAX_EDGE_SCALE) edgeOk = false;
    const [du, dv] = edgePoint(a, th);
    if (!insideCore(a, du * 0.98, dv * 0.98) || insideCore(a, du * 1.02, dv * 1.02)) coreOk = false;
  }
  check("縁の倍率は 0.6〜1.4 の範囲", edgeOk);
  check("insideCore は edgePoint と同じパラメータ化（縁のすぐ内側は中、すぐ外側は外）", coreOk);
  check("中心は中、遠くは外", insideCore(a, 0, 0) && !insideSplat(a, 1, 1));
  const d0 = a.drops[0];
  check("滴の中は insideSplat で中", insideSplat(a, d0.du, d0.dv) && splatExtent(a) >= Math.hypot(d0.du, d0.dv) + d0.r);
  // 垂れ: 壁のときだけ 1〜3 本。帯と先端の玉が insideSplat に入り、extent にも含まれる
  const aw = splatShape(42, 0.09, [0, 1], true);
  check("壁なら垂れが 1〜3 本、床（wall=false）なら無し", aw.drips.length >= 1 && aw.drips.length <= 3 && a.drips.length === 0);
  const dr = aw.drips[0];
  check("垂れの帯と先端の玉は insideSplat で中、帯の横は外", insideSplat(aw, dr.du, dr.dv + dr.len * 0.5) && insideSplat(aw, dr.du, dr.dv + dr.len + dr.w * 0.5) && !insideSplat(aw, dr.du + dr.w * 2 + aw.r * 2, dr.dv + dr.len * 0.5));
  check("垂れは extent に含まれる", splatExtent(aw) >= Math.hypot(dr.du, dr.dv + dr.len) + dr.w);
  check("壁の形は垂れ以外は床と同じ（seed が同じなら本体・滴が一致）", JSON.stringify(aw.drops) === JSON.stringify(a.drops) && JSON.stringify(aw.waves) === JSON.stringify(a.waves));
  check("向きなしの後方滴（配列の末尾）も上に偏らない（全方向）", (() => { let up = 0, n = 0; for (let sd = 1; sd <= 60; sd++) { const d = splatShape(sd, 0.09, null).drops.at(-1); n++; if (d.dv < 0) up++; } return up > n * 0.3 && up < n * 0.7; })());
  check("isWallSurface: 壁は true、床は false", isWallSurface(wall) && !isWallSurface(floor));
  // 進行方向: 壁に正面から撃つと重力で下向き成分だけが残り、壁の yAxis（下）方向 = [0, 1]
  const lw = simulateInk([0, 0, 2], [0, 0, -5], [wall, floor], cfg);
  const dirW = impactDirUv(lw, [0, 0, -5], wall, cfg.gravity);
  check("壁に正面から当たると飛沫は下向き（[0, 1]）", dirW && near(dirW[0], 0) && near(dirW[1], 1));
  // 斜め（右へ）に撃つと右下
  const lw2 = simulateInk([-0.5, 0, 2], [1.2, 0, -5], [wall, floor], cfg);
  const dirW2 = impactDirUv(lw2, [1.2, 0, -5], wall, cfg.gravity);
  check("右へ撃つと飛沫は右下", dirW2 && dirW2[0] > 0.4 && dirW2[1] > 0.4);
  // 真下に落とすと面内成分が無い → null（向きなし）
  const lf = simulateInk([0, 0, 1], [0, -3, 0], [wall, floor], cfg);
  check("床に真上から落ちると向きなし（null）", lf && impactDirUv(lf, [0, -3, 0], floor, cfg.gravity) === null);
  // 格子: 円より広く塗れる（滴の分）が、極端に広くはない
  const g1 = new InkGrid(wall, 0.02);
  const nCircle = g1.stamp([0.5, 0.5], 0.09, 1);
  const g2 = new InkGrid(wall, 0.02);
  const nSplat = g2.stampSplat([0.5, 0.5], a, 1);
  check("stampSplat は円の 0.7〜4 倍のセルを塗る", nSplat > nCircle * 0.7 && nSplat < nCircle * 4, `${nSplat} vs ${nCircle}`);
  check("stampSplat: 同じ色で塗り直しは 0", g2.stampSplat([0.5, 0.5], a, 1) === 0);
  const stats = { overwritten: 0 };
  const nOver = g2.stampSplat([0.5, 0.5], a, 2, stats);
  check("stampSplat: 他の色を塗り替えたセル数が stats に入る（クライアントのフラッシュ判定）", stats.overwritten === nOver && nOver > 0);
  const stats2 = { overwritten: 0 };
  new InkGrid(wall, 0.02).stampSplat([0.5, 0.5], a, 2, stats2);
  check("stampSplat: 未塗装なら overwritten は 0", stats2.overwritten === 0);
  check("stampSplat: 角（UV 0,0）でもはみ出さない", new InkGrid(wall, 0.02).stampSplat([0, 0], a, 2) > 0);
  // サーバー側: shoot で同じ形が格子に入る（shot.seq を種にする）
  const game = new SplatoonGame({ matchSec: 300, wallW: 2, wallH: 1, waitSec: 0 });
  game.join("s1", "S", 0);
  game.updatePose("s1", [0, 0.1, 1], 10);
  const sh = game.shoot("s1", [0, 0, 1], [0, -2, -4.5], 0.09, 100);
  const sf = game.surfaces.find((x) => x.id === sh.landing.surfaceId);
  const expectShape = splatShape(sh.seq, sh.radius, impactDirUv(sh.landing, sh.vel, sf, game.config.gravity), isWallSurface(sf));
  const g3 = new InkGrid(sf, game.config.cellM);
  const nExpect = g3.stampSplat(sh.landing.uv, expectShape, sh.color);
  check("サーバーの格子は shot.seq 由来の飛沫の形（壁なので垂れ込み）で塗られている（クライアントと同じ形 = 得点）", game.scores().s1 === nExpect && nExpect > 0 && expectShape.drips.length > 0, `${game.scores().s1} vs ${nExpect}`);
  check("サーバーの格子の中身（encode）がクライアントの再現と完全一致", game.grids.get(sf.id).encode() === g3.encode());
  // 着弾順の再現: サーバーは seq 順（1 → 2）に塗るが、クライアントには近い 2 が先に着く。
  // 遅れて 1 が来たら 1 を塗ってから 2 を塗り直せばサーバーと同じ格子になる（InkView.splat の手順）
  const s1 = splatShape(1, 0.09, [0, 1], true);
  const s2 = splatShape(2, 0.09, [0.3, 1], true);
  const gServer = new InkGrid(wall, 0.02);
  gServer.stampSplat([0.5, 0.5], s1, 1);
  gServer.stampSplat([0.52, 0.5], s2, 2);
  const gClient = new InkGrid(wall, 0.02);
  gClient.stampSplat([0.52, 0.5], s2, 2); // 2 が先に着弾
  const naive = gClient.encode();
  gClient.stampSplat([0.5, 0.5], s1, 1); // 遅れて 1
  check("順序が逆転すると格子が違う（そのままでは 1 が 2 を上書きしてしまう）", gClient.encode() !== gServer.encode() && naive !== gServer.encode());
  gClient.stampSplat([0.52, 0.5], s2, 2); // 後ろの seq を塗り直す
  check("後ろの seq を塗り直すとサーバーの格子と完全一致", gClient.encode() === gServer.encode());
}

// ================= 1d. マルチマーカーの配置（marker-layout.ts）と合成カメラの投影（fake-markers.ts）=================
{
  const cfg = { ...DEFAULT_FIELD, wallW: 2, wallH: 1, floorDrop: 1, floorDepth: 1.5 };
  const surfaces = fieldSurfaces(cfg);
  const nearV = (a, b) => a.every((v, i) => near(v, b[i]));
  const crossV = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  // 面ごとの軸: 右手系で、コートの面（SurfaceFrame）と同じ向き（x = xAxis, y = -yAxis（上）, z = normal）
  for (const face of MARKER_FACES) {
    const ax = markerAxes(face);
    const surface = surfaces.find((s) => s.id === face);
    check(`markerAxes(${face}): 右手系（x = y × z）で SurfaceFrame の向きと一致`, nearV(ax.x, crossV(ax.y, ax.z)) && nearV(ax.x, surface.xAxis) && nearV(ax.y, surface.yAxis.map((v) => -v)) && nearV(ax.z, surface.normal), JSON.stringify(ax));
  }
  check("床のマーカーの「上」は正面の壁の向き（-Z）", nearV(markerAxes("floor").y, [0, 0, -1]));
  // 4x4: 原点と軸
  const floorM = markerToFieldMatrix({ id: 1, face: "floor", pos: [0.2, -1, 0.6] });
  check("markerToFieldMatrix: マーカーの原点は pos、X 軸は右 (+X)", nearV(transformPoint(floorM, [0, 0, 0]), [0.2, -1, 0.6]) && nearV(transformPoint(floorM, [0.1, 0, 0]), [0.3, -1, 0.6]));
  check("markerToFieldMatrix: 床マーカーの Y（上）は正面の壁へ（-Z）、Z（法線）は上（+Y）", nearV(transformPoint(floorM, [0, 0.1, 0]), [0.2, -1, 0.5]) && nearV(transformPoint(floorM, [0, 0, 0.1]), [0.2, -0.9, 0.6]));
  const inv = invertRigid(floorM);
  const ident = mulMat4(floorM, inv);
  check("invertRigid: M × M⁻¹ = I", ident.every((v, i) => near(v, i % 5 === 0 ? 1 : 0)));
  // アンカーの式（marker-anchor.ts）: 観測 obs = camera⁻¹ × M のとき anchor = camWorld × obs × M⁻¹ = camWorld × camera⁻¹、
  // 送る pose = anchor⁻¹ × camWorld = camera（フェイクカメラの field 座標系での姿勢そのもの）
  const camToField = fakeCameraToField([0.15, -0.5, 0.75], 10, 65);
  const obs = mulMat4(invertRigid(camToField), floorM);
  const camWorld = fakeCameraToField([0, 1.6, 0], 0, 0);
  const anchor = mulMat4(camWorld, mulMat4(obs, invertRigid(floorM)));
  const pose = mulMat4(invertRigid(anchor), camWorld);
  check("invertRigid / mulMat4 の整合: アンカーの式（camWorld × obs × M⁻¹）で送る pose がフェイクカメラの field 姿勢に戻る", pose.every((v, i) => near(v, camToField[i], 1e-9)));
  // three.js との整合（marker-anchor.ts は Matrix4 で同じ式を計算する）: 列優先の 16 要素を fromArray でそのまま読め、
  // 点の変換・積・逆行列・decompose が純粋関数と一致する
  const t3 = (m) => new Matrix4().fromArray(m);
  const p3 = new Vector3(0.1, 0.2, 0.3).applyMatrix4(t3(floorM));
  const pp = transformPoint(floorM, [0.1, 0.2, 0.3]);
  check("three.js: Matrix4.fromArray（列優先）で読んだ行列の点の変換が transformPoint と一致", near(p3.x, pp[0]) && near(p3.y, pp[1]) && near(p3.z, pp[2]));
  const anchor3 = t3(camWorld).multiply(t3(obs)).multiply(t3(floorM).clone().invert());
  check("three.js: multiply / invert で計算したアンカーが mulMat4 / invertRigid と一致", anchor3.elements.every((v, i) => near(v, anchor[i], 1e-9)));
  const dp = new Vector3();
  const dq = new Quaternion();
  const ds = new Vector3();
  anchor3.decompose(dp, dq, ds);
  const rebuilt = new Matrix4().compose(dp, dq, ds);
  check("three.js: decompose → compose で元に戻る（回転が正規直交 = markerAxes が右手系の単位ベクトル）", rebuilt.elements.every((v, i) => near(v, anchor[i], 1e-9)) && near(ds.x, 1) && near(ds.y, 1) && near(ds.z, 1));
  // 候補の合成
  const one = fusePoseCandidates([{ pos: [1, 2, 3], quat: [0, 0, 0, 1], weight: 4 }]);
  check("fusePoseCandidates: 1 つならそのまま、spread=0", one && nearV(one.pos, [1, 2, 3]) && nearV(one.quat, [0, 0, 0, 1]) && one.spread === 0);
  const two = fusePoseCandidates([
    { pos: [0, 0, 0], quat: [0, 0, 0, 1], weight: 1 },
    { pos: [0.1, 0, 0], quat: [0, 0, 0, -1], weight: 3 },
  ]);
  check("fusePoseCandidates: 重み付き平均（3:1 で 0.075）、反対符号の四元数も同じ半球に揃える、spread=0.1", two && near(two.pos[0], 0.075) && nearV(two.quat, [0, 0, 0, 1]) && near(two.spread, 0.1));
  const s = Math.SQRT1_2;
  const rot = fusePoseCandidates([
    { pos: [0, 0, 0], quat: [0, 0, 0, 1], weight: 1 },
    { pos: [0, 0, 0], quat: [0, s, 0, s], weight: 1 },
  ]);
  check("fusePoseCandidates: 0° と 90°（Y）の等重み → 45°", rot && near(rot.quat[1], Math.sin(Math.PI / 8), 1e-9) && near(rot.quat[3], Math.cos(Math.PI / 8), 1e-9));
  check("fusePoseCandidates: 空なら null、重み 0 だけでも null", fusePoseCandidates([]) === null && fusePoseCandidates([{ pos: [0, 0, 0], quat: [0, 0, 0, 1], weight: 0 }]) === null);
  // 検証
  const ok = [
    { id: 1, face: "floor", pos: [0, -1, 0.75] },
    { id: 2, face: "left", pos: [-1, 0, 0.75] },
  ];
  check("validateMarkerLayout: 正しい配置は null", validateMarkerLayout(ok, 0, 1) === null);
  check("validateMarkerLayout: 空でも良い", validateMarkerLayout([], 0, 1) === null);
  check("validateMarkerLayout: 原点と同じ ID は拒否", /原点/.test(validateMarkerLayout([{ id: 0, face: "left", pos: [0, 0, 0] }], 0, 1) ?? ""));
  check("validateMarkerLayout: ID の重複は拒否", /重複/.test(validateMarkerLayout([ok[0], { ...ok[1], id: 1 }], 0, 1) ?? ""));
  check("validateMarkerLayout: 知らない面は拒否", /face/.test(validateMarkerLayout([{ id: 1, face: "ceiling", pos: [0, 0, 0] }], 0, 1) ?? ""));
  check("validateMarkerLayout: 範囲外の位置・数値でない位置は拒否", /位置/.test(validateMarkerLayout([{ id: 1, face: "left", pos: [99, 0, 0] }], 0, 1) ?? "") && /位置/.test(validateMarkerLayout([{ id: 1, face: "left", pos: ["0", 0, 0] }], 0, 1) ?? ""));
  check("validateMarkerLayout: 床のマーカーは床の高さ（-floorDrop）でないと拒否", /床/.test(validateMarkerLayout([{ id: 1, face: "floor", pos: [0, -1.2, 0.5] }], 0, 1) ?? ""));
  check("validateMarkerLayout: 辞書に無い ID・枚数の上限超えは拒否", /ID/.test(validateMarkerLayout([{ id: 250, face: "left", pos: [0, 0, 0] }], 0, 1) ?? "") && /枚まで/.test(validateMarkerLayout(Array.from({ length: MAX_EXTRA_MARKERS + 1 }, (_, i) => ({ id: i + 1, face: "left", pos: [0, 0, 0] })), 0, 1) ?? ""));
  check("withFloorDrop: 床のマーカーだけ高さが追従する", JSON.stringify(withFloorDrop(ok, 0.8)) === JSON.stringify([{ id: 1, face: "floor", pos: [0, -0.8, 0.75] }, ok[1]]));
  check("suggestedMarkerPos: 床は床の高さ・コートの中央、左右は壁の位置、背面は奥", nearV(suggestedMarkerPos("floor", cfg), [0, -1, 0.75]) && nearV(suggestedMarkerPos("left", cfg), [-1, 0, 0.75]) && nearV(suggestedMarkerPos("right", cfg), [1, 0, 0.75]) && nearV(suggestedMarkerPos("back", cfg), [0, 0, 1.5]));
  check("describeMarkers", describeMarkers(ok) === "1:floor,2:left" && describeMarkers([]) === "-");
  // 合成カメラの投影: 正面の原点マーカーを距離 d から見ると、一辺 s·f/d [px] の正方形が中央に映る
  const bits = Array.from({ length: 6 }, (_, y) => Array.from({ length: 6 }, (_, x) => (x + y) % 2 === 0));
  const f = 320 / Math.tan((68 / 2) * (Math.PI / 180));
  const d = (0.1 * f) / 80;
  const origin = { id: 0, bits, toField: markerToFieldMatrix({ id: 0, face: "wall", pos: [0, 0, 0] }) };
  const front = fakeCameraToField([0, 0, d], 0, 0);
  const pj = projectFakeMarker(origin, invertRigid(front), f, 640, 480, 0.1);
  check("projectFakeMarker: 正面から距離 d で一辺 80px・中央（fakeMarkerPx と同じ見え方）", pj && near(pj.sidePx, 80, 1e-6) && near(pj.black[0][0], 280, 1e-6) && near(pj.black[0][1], 200, 1e-6) && near(pj.black[2][0], 360, 1e-6) && near(pj.black[2][1], 280, 1e-6), JSON.stringify(pj?.black));
  check("projectFakeMarker: 白いセルの数 = ビットの 1 の数、余白は黒枠の 10/8 倍", pj && pj.cells.length === 18 && near(Math.hypot(pj.quiet[1][0] - pj.quiet[0][0], pj.quiet[1][1] - pj.quiet[0][1]), 100, 1e-6));
  const shifted = fakeCameraToField([(-40 * d) / f, (24 * d) / f, d], 0, 0);
  const pjs = projectFakeMarker(origin, invertRigid(shifted), f, 640, 480, 0.1);
  check("projectFakeMarker: fakeShift=40 / fakeShiftY=24 に相当するカメラ位置で、右に 40px・下に 24px ずれる", pjs && near(pjs.black[0][0], 320, 1e-6) && near(pjs.black[0][1], 224, 1e-6));
  check("projectFakeMarker: カメラの後ろのマーカーは描かない", projectFakeMarker(origin, invertRigid(fakeCameraToField([0, 0, -1], 0, 0)), f, 640, 480, 0.1) === null);
  // 床のマーカーを見下ろすカメラ: 画面内に映り、上下が正しい（マーカーの「上」= 正面の壁側 = 画面の上）
  const floorMarker = { id: 1, bits, toField: floorM };
  const down = fakeCameraToField([0.15, -0.5, 0.75], 0, 65);
  const pjf = projectFakeMarker(floorMarker, invertRigid(down), f, 640, 480, 0.1);
  check("projectFakeMarker: 見下ろした床のマーカーが画面内に映り、上辺（壁側）が画面の上に来る", pjf && pjf.black.every(([u, v]) => u >= 0 && u <= 640 && v >= 0 && v <= 480) && pjf.black[0][1] < pjf.black[3][1] && pjf.sidePx > 60, JSON.stringify(pjf?.black.map((c) => c.map(Math.round))));
  const all = projectFakeMarkers([origin, floorMarker], down, f, 640, 480, 0.1);
  check("projectFakeMarkers: 見下ろしていると原点は視野外で、床のマーカーだけ", all.length === 1 && all[0].id === 1);
  check("fakeCameraToField: pitch 90 で真下、yaw 90 で左を向く", nearV(fakeCameraToField([0, 0, 0], 0, 90).slice(8, 11).map((v) => -v), [0, -1, 0]) && nearV(fakeCameraToField([0, 0, 0], 90, 0).slice(8, 11).map((v) => -v), [-1, 0, 0]));
  check("parseFakeMarkersParam: 不正な要素（形・辞書の範囲外の ID）は捨てる", JSON.stringify(parseFakeMarkersParam("1:floor:0,-1.2,0.6;5:wall:0.25,0,0;bad;7:left:x,0,0;250:left:0,0,0;-1:left:0,0,0")) === JSON.stringify([{ id: 1, face: "floor", pos: [0, -1.2, 0.6] }, { id: 5, face: "wall", pos: [0.25, 0, 0] }]) && parseFakeMarkersParam(null).length === 0);
}

// ================= 1e. 俯瞰画面のマーカーのドラッグ（marker-drag.ts。issue #43）=================
{
  const nearV = (a, b) => a.every((v, i) => near(v, b[i]));
  check("dragAxes: 正面 / 背面は X・Y、左右は Z・Y、床は X・Z", JSON.stringify([dragAxes("wall"), dragAxes("back"), dragAxes("left"), dragAxes("right"), dragAxes("floor")]) === JSON.stringify([[0, 1], [0, 1], [2, 1], [2, 1], [0, 2]]));
  check("faceNormal: markerAxes の Z と同じ（壁は +Z、床は +Y、左は +X）", nearV(faceNormal("wall"), [0, 0, 1]) && nearV(faceNormal("floor"), [0, 1, 0]) && nearV(faceNormal("left"), [1, 0, 0]));
  // 視点 (0, 0, 2) から正面の壁（Z = 0 の平面）へ: 斜めのレイが壁の上の点に当たる
  const hit = rayPlaneHit([0, 0, 2], [0.25, 0.1, -1], [0, 0, 0], [0, 0, 1]);
  check("rayPlaneHit: レイと平面の交点（Z = 0 に t = 2 で当たる）", hit && nearV(hit, [0.5, 0.2, 0]), JSON.stringify(hit));
  check("rayPlaneHit: 平面に平行なレイ・視点の後ろの平面は null", rayPlaneHit([0, 0, 2], [1, 0, 0], [0, 0, 0], [0, 0, 1]) === null && rayPlaneHit([0, 0, 2], [0, 0, 1], [0, 0, 0], [0, 0, 1]) === null);
  check("roundCm: cm に丸める", roundCm(0.12345) === 0.12 && roundCm(0.126) === 0.13 && roundCm(-0.126) === -0.13);
  // 正面の壁のマーカー (0.25, 0, 0) を掴んだ点から右 0.3・上 0.1 動かす → X・Y だけ変わり Z は 0 のまま
  const pos0 = [0.25, 0, 0];
  const moved = draggedMarkerPos("wall", pos0, [0.3, 0.02, 0], [0.6, 0.12, 0], false);
  check("draggedMarkerPos: 正面の壁は掴んだ点からの差だけ X・Y が動く（枠の中心に吸い付かない）、Z はそのまま", nearV(moved, [0.55, 0.1, 0]), JSON.stringify(moved));
  const lockedX = draggedMarkerPos("wall", pos0, [0.3, 0.02, 0], [0.6, 0.12, 0], true);
  const lockedY = draggedMarkerPos("wall", pos0, [0.3, 0.02, 0], [0.35, 0.42, 0], true);
  check("draggedMarkerPos: Shift（lockAxis）は動きの大きい軸だけ（右 0.3 > 上 0.1 なら水平、上 0.4 > 右 0.05 なら垂直）", nearV(lockedX, [0.55, 0, 0]) && nearV(lockedY, [0.25, 0.4, 0]), JSON.stringify([lockedX, lockedY]));
  const floor = draggedMarkerPos("floor", [0, -1, 0.75], [0.1, -1, 0.7], [0.4, -1, 1.2], false);
  check("draggedMarkerPos: 床は X・Z が動き Y（床の高さ）はそのまま", nearV(floor, [0.3, -1, 1.25]), JSON.stringify(floor));
  const left = draggedMarkerPos("left", [-1, 0, 0.75], [-1, 0.1, 0.5], [-1, 0.3, 0.9], false);
  check("draggedMarkerPos: 左の壁は Z・Y が動き X（壁の位置）はそのまま", nearV(left, [-1, 0.2, 1.15]), JSON.stringify(left));
  check("draggedMarkerPos: cm に丸め、上限（±20m）で止まる", nearV(draggedMarkerPos("wall", [0, 0, 0], [0, 0, 0], [0.123456, 0.0049, 0], false), [0.12, 0, 0]) && nearV(draggedMarkerPos("wall", [0, 0, 0], [0, 0, 0], [50, -50, 0], false), [MARKER_POS_LIMIT_M, -MARKER_POS_LIMIT_M, 0]));
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
  // 途中終了（issue #32）: 試合中の stop は即座に結果、カウントダウン中の stop は中止して練習、それ以外は拒否
  {
    const gs = new SplatoonGame({ matchSec: 60, resultSec: 5, waitSec: 1, wallW: 2, wallH: 1 });
    check("練習中の stop は拒否（終えるものが無い）", gs.stop(0).length === 0 && /practice/.test(gs.lastRejectReason) && gs.phase === "practice");
    gs.join("p1", "A", 0);
    gs.join("p2", "B", 0);
    gs.updatePose("p1", [0, 0, 1.5], 50);
    gs.updatePose("p2", [0.5, 0, 1.5], 50);
    check("練習中に塗ってからカウントダウン", gs.shoot("p1", [0, 0, 1], [0, -2, -4.5], 0.09, 100) !== null && gs.start(200)[0]?.kind === "countdown");
    const seqBefore = gs.snapshot(250).seq;
    const cancel = gs.stop(300);
    check("カウントダウン中の stop は中止（cancel）で練習に戻り、練習の塗りは残る。seq は進む", cancel[0]?.kind === "cancel" && gs.phase === "practice" && gs.phaseEndsAt === Infinity && gs.scores().p1 > 0 && gs.snapshot(300).seq > seqBefore);
    check("中止後は tick しても始まらない", gs.tick(5000).length === 0 && gs.phase === "practice");
    gs.start(6000);
    gs.tick(7000);
    check("再び開始できる（waitSec 後に play。塗りは消える）", gs.phase === "play" && gs.scores().p1 === 0 && gs.phaseEndsAt === 67000);
    check("試合中に p2 が塗る", gs.shoot("p2", [0.5, 0, 1], [0, -2, -4.5], 0.09, 7100)?.landing?.hit === true, gs.lastRejectReason);
    const stopped = gs.stop(8000);
    check("試合中の stop は時間切れを待たず result（stopped 付き・勝者は最多セル = p2・結果表示は resultSec）", stopped[0]?.kind === "result" && stopped[0].stopped === true && stopped[0].winners.length === 1 && stopped[0].winners[0] === "p2" && gs.phase === "result" && gs.phaseEndsAt === 13000);
    check("result 中の stop は拒否", gs.stop(8100).length === 0 && /result/.test(gs.lastRejectReason) && gs.phase === "result");
    check("stop 後の result は時間で練習に戻る", gs.tick(13000)[0]?.kind === "practice" && gs.phase === "practice");
    gs.start(14000);
    gs.tick(15000);
    check("2 戦目で p1 が塗る", gs.shoot("p1", [0, 0, 1], [0, -2, -4.5], 0.09, 15100)?.landing?.hit === true, gs.lastRejectReason);
    const timeUp = gs.tick(75000);
    check("時間切れの result には stopped が付かない", timeUp[0]?.kind === "result" && timeUp[0].stopped === undefined);
    // 結果表示中に「次の対戦を開始」→ 中止: 前試合の盤面が練習に漏れないよう格子は新品（外部レビュー指摘）
    check("結果表示中から start でカウントダウン（前試合の塗りはまだ残る）", gs.start(76000)[0]?.kind === "countdown" && gs.scores().p1 > 0);
    const cancel2 = gs.stop(76500);
    check("結果表示から始めたカウントダウンの中止は、格子を新品にして練習に戻る（前試合の得点は消える）", cancel2[0]?.kind === "cancel" && gs.phase === "practice" && Object.values(gs.scores()).every((v) => v === 0) && gs.winners === null);
    check("中止後の練習で撃てる（インクも新品）", gs.inkOf("p1", 76600) === 1 && gs.shoot("p1", [0, 0, 1], [0, -2, -4.5], 0.09, 76600) !== null, gs.lastRejectReason);
  }
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
  // グーの申告は pose が止まると FIST_STALE_MS で失効する（外部レビューの反例: 一度 true を送って黙るクライアント）
  {
    const gf = new SplatoonGame({ matchSec: 300, wallW: 2, wallH: 1, waitSec: 0 });
    gf.join("f1", "F", 0);
    gf.start(0);
    gf.tick(1);
    gf.updatePose("f1", [0, 0.1, 1], 2);
    for (let i = 0; i < 30; i++) gf.shoot("f1", [0, 0, 1], [0, 0, -5], 0.09, 100 + i * 200);
    const tEmpty = 100 + 29 * 200;
    const base = gf.inkOf("f1", tEmpty + 1000); // 回復の遅延（1s）が明けた時点
    gf.updatePose("f1", [0, 0.1, 1], tEmpty + 1000, true); // ここで最後の pose（グー）
    const after3 = gf.inkOf("f1", tEmpty + 4000); // 3 秒後: 最初の 1 秒だけ速く、残り 2 秒は通常
    const expect = base + 1 * inkRegenPerSec(gf.config, true) + 2 * inkRegenPerSec(gf.config, false);
    check(`pose が止まると ${FIST_STALE_MS}ms でグーが失効し通常速度に戻る（境界をまたぐ区間は分けて積分）`, near(after3, Math.min(1, expect), 0.01), `${after3.toFixed(3)} vs ${expect.toFixed(3)}`);
    const gf2 = new SplatoonGame({ matchSec: 300, wallW: 2, wallH: 1, waitSec: 0 });
    gf2.join("f2", "F", 0);
    gf2.start(0);
    gf2.tick(1);
    gf2.updatePose("f2", [0, 0.1, 1], 2);
    // 45 発撃って残量 0.1 にしてから（満タンで頭打ちにならないように）、1 秒間 15Hz でグーを送り続ける
    for (let i = 0; i < 45; i++) gf2.shoot("f2", [0, 0, 1], [0, 0, -5], 0.09, 100 + i * 200);
    const tEmpty2 = 100 + 44 * 200;
    const b2 = gf2.inkOf("f2", tEmpty2 + 1000);
    for (let t = tEmpty2 + 1000; t <= tEmpty2 + 2000; t += 66) gf2.updatePose("f2", [0, 0.1, 1], t, true);
    const a2 = gf2.inkOf("f2", tEmpty2 + 2000);
    check("pose を送り続けていれば失効しない（1 秒ずっと速い）", b2 < 0.2 && near(a2 - b2, 1 * inkRegenPerSec(gf2.config, true), 0.02), `${b2.toFixed(3)} → ${a2.toFixed(3)}`);
  }
  // コートを広げても奥から撃てる（発射位置の上限はコートの対角 + 1m）
  const wide = new SplatoonGame({ matchSec: 300, floorDepth: 8, waitSec: 0 });
  wide.join("w1", "W", 0);
  wide.start(0);
  wide.tick(1);
  wide.updatePose("w1", [0, 0.1, 7.5], 10);
  check("広いコートの奥からも発射できる", wide.shoot("w1", [0, 0, 7.4], [0, 0, -5], 0.09, 100) !== null);
}

// ================= 3e. フィールドの寸法の変更（俯瞰画面から。練習中か結果表示中だけ）=================
{
  const g = new SplatoonGame({ matchSec: 10, resultSec: 5, waitSec: 1 });
  g.join("p1", "A", 0);
  g.updatePose("p1", [0, 0.1, 1], 10);
  g.shoot("p1", [0, 0, 1], [0, 0, -5], 0.09, 20);
  const before = g.totalCells;
  check("変更前: 練習の塗りがある", g.scores().p1 > 0);
  // 奥行き 4m: 変更前なら z=3.5 の発射位置はコート外（対角 + 1m の上限内だが床に当たらない）
  const ev = g.setFieldSize({ wallW: 2, wallH: 1.5, floorDepth: 4, floorDrop: 1 }, 100);
  const floorSurface = g.surfaces.find((s) => s.id === FLOOR_ID);
  check("練習中の setFieldSize: event field・config と surfaces が新しい寸法", ev[0]?.kind === "field" && g.config.wallW === 2 && g.config.wallH === 1.5 && g.config.floorDepth === 4 && g.config.floorDrop === 1 && floorSurface.heightM === 4 && g.surfaces.find((s) => s.id === WALL_ID).heightM === 1.5);
  check("マーカーの高さも変わり、床が y=-floorDrop に動く", floorSurface.origin[1] === -1);
  check("格子は作り直され（セル数が変わる）、塗りは消える。練習のまま", g.totalCells !== before && g.totalCells === fieldCellCount({ ...g.config }) && g.scores().p1 === 0 && g.phase === "practice" && g.phaseEndsAt === Infinity);
  check("変更後の config は他の値（matchSec / cellM）を保つ", g.config.matchSec === 10 && g.config.cellM === DEFAULT_FIELD.cellM);
  g.updatePose("p1", [0, 0.1, 3.5], 200);
  const far = g.shoot("p1", [0, 0, 3.5], [0, -3, -2], 0.09, 300);
  check("広げた床の奥にも着弾できる（surfaces と maxShotDist が更新されている）", far !== null && far.landing?.surfaceId === FLOOR_ID, g.lastRejectReason);
  g.start(400);
  const base = { wallW: 3, wallH: 2.4, floorDepth: 2.5, floorDrop: 1.2 };
  check("カウントダウン中の setFieldSize は拒否", g.setFieldSize(base, 500).length === 0 && /waiting/.test(g.lastRejectReason) && g.config.wallW === 2);
  g.tick(1500);
  check("試合中の setFieldSize は拒否", g.phase === "play" && g.setFieldSize(base, 1600).length === 0 && /play/.test(g.lastRejectReason));
  g.tick(11500);
  check("結果表示中の setFieldSize は受け付け、練習に戻る（勝者の表示も消える）", g.phase === "result" && g.setFieldSize(base, 11600)[0]?.kind === "field" && g.phase === "practice" && g.winners === null && g.totalCells === before);
}

// ================= 3f. 追加マーカーの配置（俯瞰画面から。練習中か結果表示中だけ。塗りは消えない）=================
{
  const g = new SplatoonGame({ matchSec: 10, resultSec: 5, waitSec: 1 });
  g.join("p1", "A", 0);
  g.updatePose("p1", [0, 0.1, 1], 10);
  g.shoot("p1", [0, 0, 1], [0, 0, -5], 0.09, 20);
  const scoreBefore = g.scores().p1;
  check("既定の配置は空（原点のマーカーだけ）", Array.isArray(g.config.markers) && g.config.markers.length === 0 && DEFAULT_FIELD.markers.length === 0);
  const layout = [{ id: 1, face: "floor", pos: [0, -1.2, 1.25] }, { id: 2, face: "left", pos: [-1.5, 0, 1.25] }];
  check("練習中の setMarkers は受け付け、config.markers に入る（塗りは消えない・練習のまま）", g.setMarkers(layout, 100) === true && describeMarkers(g.config.markers) === "1:floor,2:left" && g.scores().p1 === scoreBefore && g.phase === "practice");
  layout[0].pos[0] = 9;
  check("setMarkers は配列をコピーする（呼び出し側の配列を書き換えても影響しない）", g.config.markers[0].pos[0] === 0);
  g.setFieldSize({ wallW: 2, wallH: 1.5, floorDepth: 4, floorDrop: 1 }, 200);
  check("寸法の変更で床のマーカーは新しい床の高さに追従し、壁のマーカーはそのまま", g.config.markers[0].pos[1] === -1 && g.config.markers[1].pos[1] === 0 && g.config.markers.length === 2);
  g.start(400);
  check("カウントダウン中の setMarkers は拒否", g.setMarkers([], 500) === false && /waiting/.test(g.lastRejectReason) && g.config.markers.length === 2);
  g.tick(1500);
  check("試合中の setMarkers は拒否", g.phase === "play" && g.setMarkers([], 1600) === false && /play/.test(g.lastRejectReason));
  g.tick(11500);
  check("結果表示中の setMarkers は受け付け（結果表示のまま）", g.phase === "result" && g.setMarkers([], 11600) === true && g.config.markers.length === 0 && g.phase === "result");
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
  ov.send({ type: "field", wallW: 2, wallH: 1.5, floorDepth: 4, floorDrop: 1 });
  const rejFieldPlay = await ov.waitFor((m) => m.type === "rejected" && /resize/.test(m.reason));
  check("試合中の field は俯瞰画面に rejected: cannot resize during play", rejFieldPlay && /play/.test(rejFieldPlay.reason));
  ov.send({ type: "markers", markers: [{ id: 1, face: "floor", pos: [0, -1.2, 1.25] }] });
  const rejMarkersPlay = await ov.waitFor((m) => m.type === "rejected" && /markers/.test(m.reason));
  check("試合中の markers は俯瞰画面に rejected: cannot change markers during play", rejMarkersPlay && /play/.test(rejMarkersPlay.reason));
  // pose の markerIds（いまどのマーカーで位置合わせしているか）は中継される。不正なら pose ごと捨てる
  b.send({ type: "pose", pos: [0.3, 0, 1.5], quat: [0, 0, 0, 1], tracking: true, markerIds: [0, 1] });
  const poseIds = await a.waitFor((m) => m.type === "pose" && m.id === "p2" && m.pos[0] === 0.3);
  check("pose の markerIds が中継される", poseIds && JSON.stringify(poseIds.markerIds) === "[0,1]");
  b.send({ type: "pose", pos: [0.31, 0, 1.5], quat: [0, 0, 0, 1], tracking: true, markerIds: ["0"] });
  b.send({ type: "pose", pos: [0.32, 0, 1.5], quat: [0, 0, 0, 1], tracking: true, markerIds: Array.from({ length: 10 }, (_, i) => i) });
  b.send({ type: "pose", pos: [0.33, 0, 1.5], quat: [0, 0, 0, 1], tracking: true, markerIds: [] });
  const poseEmptyIds = await a.waitFor((m) => m.type === "pose" && m.id === "p2" && m.pos[0] === 0.33);
  check("markerIds が数値でない・多すぎる pose は捨てられ、空の markerIds は付けずに中継", poseEmptyIds && poseEmptyIds.markerIds === undefined && !a.msgs.some((m) => m.type === "pose" && (m.pos[0] === 0.31 || m.pos[0] === 0.32)));
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
  // 途中終了（issue #32）: スマホからは拒否、俯瞰画面からは試合中でも即座に result（格子付き）が全員に配られる
  const rejCountBefore = b.msgs.filter((m) => m.type === "rejected" && /overview/.test(m.reason)).length;
  b.send({ type: "stop" });
  const rejPhoneStop = await b.waitFor(() => b.msgs.filter((m) => m.type === "rejected" && /overview/.test(m.reason)).length > rejCountBefore);
  check("スマホからの stop には rejected: not overview が返る", rejPhoneStop !== null);
  check("stop を送る前はまだ試合中（matchSec=20 のうち数秒）", !a.msgs.some((m) => m.type === "state" && m.state.phase === "result"));
  ov.send({ type: "stop" });
  const stoppedSt = await a.waitFor((m) => m.type === "state" && m.state.phase === "result" && m.state.event?.kind === "result");
  check("俯瞰画面の stop で時間切れを待たず result が全員に配られる（stopped 付き・格子付き・勝者は塗った p2）", stoppedSt !== null && stoppedSt.state.event.stopped === true && stoppedSt.state.grids && stoppedSt.state.winners?.[0] === "p2", JSON.stringify(stoppedSt?.state.event));
  const ovStopped = await ov.waitFor((m) => m.type === "state" && m.state.phase === "result", 1000);
  check("俯瞰画面にも result が届く", ovStopped !== null);
  ov.send({ type: "stop" });
  const rejStopResult = await ov.waitFor((m) => m.type === "rejected" && /nothing to stop/.test(m.reason));
  check("結果表示中の stop は俯瞰画面に rejected: nothing to stop during result", rejStopResult !== null);
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
  // フィールドの寸法は URL ではなく俯瞰画面の field で変える（練習中の room で）
  {
    const sz = connect({ ...cfg, room: "size" }, "Sz");
    const wsz = await sz.waitFor((m) => m.type === "welcome");
    check("寸法は URL に無くても既定（3.0 × 2.4 × 2.5、マーカー 1.2）で入室できる", wsz && wsz.config.wallW === DEFAULT_FIELD.wallW && wsz.config.wallH === DEFAULT_FIELD.wallH && wsz.config.floorDepth === DEFAULT_FIELD.floorDepth && wsz.config.floorDrop === DEFAULT_FIELD.floorDrop);
    const ignored = connect({ ...cfg, room: "size", wallW: "9", floorDrop: "3" }, "Ign");
    const wign = await ignored.waitFor((m) => m.type === "welcome");
    check("URL の wallW= / floorDrop= は無視される（サーバーの寸法のまま入室できる）", wign && wign.config.wallW === DEFAULT_FIELD.wallW && wign.config.floorDrop === DEFAULT_FIELD.floorDrop);
    ignored.ws.close();
    sz.send({ type: "field", wallW: 2, wallH: 1.5, floorDepth: 4, floorDrop: 1 });
    const rejPhoneField = await sz.waitFor((m) => m.type === "rejected");
    check("スマホからの field は rejected: not overview", rejPhoneField && /not overview/.test(rejPhoneField.reason));
    const szOv = connect({ ...cfg, room: "size", role: "overview" });
    await szOv.waitFor((m) => m.type === "welcome");
    szOv.send({ type: "field", wallW: 20, wallH: 20, floorDepth: 20, floorDrop: 1.2 });
    const rejBig = await szOv.waitFor((m) => m.type === "rejected");
    check("大きすぎる寸法は rejected（セル数の上限）", rejBig && /大きすぎ/.test(rejBig.reason));
    szOv.send({ type: "field", wallW: 0.05, wallH: 2, floorDepth: 2, floorDrop: 1 });
    const rejRange = await szOv.waitFor((m) => m.type === "rejected" && /wallW/.test(m.reason));
    check("範囲外の寸法は rejected（理由に項目名）", rejRange !== null);
    szOv.send({ type: "field", wallW: 2, wallH: 1, floorDepth: 2, floorDrop: 1.5 });
    const rejDrop = await szOv.waitFor((m) => m.type === "rejected" && /floorDrop/.test(m.reason));
    check("マーカーの高さが壁より上は rejected", rejDrop !== null);
    szOv.send({ type: "field", wallW: 2, wallH: 1.5, floorDepth: 4 });
    szOv.send({ type: "field", wallW: "2", wallH: 1.5, floorDepth: 4, floorDrop: 1 });
    await sleep(150);
    check("項目が足りない・数値でない field は黙って捨てる", !szOv.msgs.some((m) => m.type === "field"));
    // 練習の塗りを作ってから変える → 消える
    sz.send({ type: "pose", pos: [0, 0.1, 1], quat: [0, 0, 0, 1], tracking: true });
    await sleep(50);
    sz.send({ type: "shot", pos: [0, 0, 1], vel: [0, 0, -5], radius: 0.09 });
    await sz.waitFor((m) => m.type === "shot");
    await sz.waitFor((m) => m.type === "state" && (m.state.scores[wsz.id] ?? 0) > 0, 2500);
    szOv.send({ type: "field", wallW: 2, wallH: 1.5, floorDepth: 4, floorDrop: 1 });
    const fPhone = await sz.waitFor((m) => m.type === "field");
    const fOv = await szOv.waitFor((m) => m.type === "field");
    check("俯瞰画面の field で全員（俯瞰画面も）に field が届く: 新しい config・格子付き state・event field", fPhone && fOv && fPhone.config.wallW === 2 && fPhone.config.wallH === 1.5 && fPhone.config.floorDepth === 4 && fPhone.config.floorDrop === 1 && fPhone.config.matchSec === 20 && fPhone.state.grids && fPhone.state.event?.kind === "field");
    check("寸法の変更で塗りは消え、セル数が変わる", (fPhone.state.scores[wsz.id] ?? 0) === 0 && fPhone.state.totalCells === fieldCellCount({ wallW: 2, wallH: 1.5, floorDepth: 4, floorDrop: 1, cellM: DEFAULT_FIELD.cellM }) && fPhone.state.phase === "practice");
    const late = connect({ ...cfg, room: "size" }, "Late");
    const wlate = await late.waitFor((m) => m.type === "welcome");
    check("あとから入った人の welcome は新しい寸法（マーカーの高さも）", wlate && wlate.config.wallW === 2 && wlate.config.floorDepth === 4 && wlate.config.floorDrop === 1 && wlate.state.totalCells === fPhone.state.totalCells);
    // 追加マーカーの配置（issue #30）: 俯瞰画面だけが変えられ、検証の理由が rejected で返り、全員（あとから入る人も）に配られる
    check("welcome の config.markers は既定で空", Array.isArray(wlate.config.markers) && wlate.config.markers.length === 0);
    sz.send({ type: "markers", markers: [{ id: 1, face: "floor", pos: [0, -1, 2] }] });
    const rejPhoneMarkers = await sz.waitFor((m) => m.type === "rejected" && /not overview/.test(m.reason) && m !== rejPhoneField);
    check("スマホからの markers は rejected: not overview", rejPhoneMarkers !== null);
    szOv.send({ type: "markers", markers: [{ id: 0, face: "left", pos: [-1, 0, 2] }] });
    const rejOrigin = await szOv.waitFor((m) => m.type === "rejected" && /原点/.test(m.reason));
    check("原点と同じ ID の markers は rejected（理由付き）", rejOrigin !== null);
    szOv.send({ type: "markers", markers: [{ id: 1, face: "floor", pos: [0, -1.2, 2] }] });
    const rejFloorY = await szOv.waitFor((m) => m.type === "rejected" && /床/.test(m.reason));
    check("床のマーカーの高さが床（-floorDrop=-1）と違う markers は rejected", rejFloorY !== null);
    szOv.send({ type: "markers", markers: [{ id: 1, face: "floor", pos: [0, -1, 2] }, { id: 1, face: "left", pos: [-1, 0, 2] }] });
    const rejDup = await szOv.waitFor((m) => m.type === "rejected" && /重複/.test(m.reason));
    check("ID が重複する markers は rejected", rejDup !== null);
    szOv.send({ type: "markers", markers: [{ id: 1, face: "roof", pos: [0, 0, 2] }] });
    szOv.send({ type: "markers", markers: "x" });
    szOv.send({ type: "markers", markers: [{ id: 1, face: "left", pos: [0, 0] }] });
    await sleep(150);
    check("形が不正な markers（面が文字列でも配列でない・位置が 3 要素でない）は黙って捨てる / 知らない面は rejected", !szOv.msgs.some((m) => m.type === "markers") && szOv.msgs.some((m) => m.type === "rejected" && /face/.test(m.reason)));
    // 寸法の変更で塗りは消えているので、塗り直してから配置を変える（配置の変更で塗りが残ることを見るため）
    sz.send({ type: "pose", pos: [0, 0.1, 1], quat: [0, 0, 0, 1], tracking: true });
    await sleep(50);
    sz.send({ type: "shot", pos: [0, 0, 1], vel: [0, 0, -5], radius: 0.09 });
    const scoreBeforeMarkers = (await sz.waitFor((m) => m.type === "state" && (m.state.scores[wsz.id] ?? 0) > 0 && sz.msgs.indexOf(m) > sz.msgs.indexOf(fPhone), 2500))?.state.scores[wsz.id];
    szOv.send({ type: "markers", markers: [{ id: 1, face: "floor", pos: [0, -1, 2] }, { id: 2, face: "left", pos: [-1, 0, 2] }] });
    const mkPhone = await sz.waitFor((m) => m.type === "markers");
    const mkOv = await szOv.waitFor((m) => m.type === "markers");
    const mkLate = await late.waitFor((m) => m.type === "markers");
    check("俯瞰画面の markers で全員（俯瞰画面も）に markers が届く: config.markers に配置、寸法はそのまま", mkPhone && mkOv && mkLate && describeMarkers(mkPhone.config.markers) === "1:floor,2:left" && mkPhone.config.wallW === 2 && mkPhone.config.floorDrop === 1);
    // markers より後に届いた state（1 秒ごとの定期配信）で得点を見る
    const stateAfterMarkers = await sz.waitFor((m) => m.type === "state" && sz.msgs.indexOf(m) > sz.msgs.indexOf(mkPhone), 2500);
    check("配置の変更で塗りは消えない（field は配られず、直後の state の得点もそのまま）", !sz.msgs.some((m) => m.type === "field" && m !== fPhone) && stateAfterMarkers !== null && stateAfterMarkers.state.scores[wsz.id] === scoreBeforeMarkers && scoreBeforeMarkers > 0, `${scoreBeforeMarkers} → ${stateAfterMarkers?.state.scores[wsz.id]}`);
    const later = connect({ ...cfg, room: "size" }, "Later");
    const wlater = await later.waitFor((m) => m.type === "welcome");
    check("あとから入った人の welcome にも配置が入っている", wlater && describeMarkers(wlater.config.markers) === "1:floor,2:left");
    szOv.send({ type: "field", wallW: 2, wallH: 1.5, floorDepth: 4, floorDrop: 0.8 });
    const fDrop = await later.waitFor((m) => m.type === "field" && m.config.floorDrop === 0.8);
    check("マーカーの高さを変えると床のマーカーが新しい床の高さに追従して配られる", fDrop && fDrop.config.markers[0].pos[1] === -0.8 && fDrop.config.markers[1].pos[1] === 0);
    later.ws.close();
    // 広げた床の奥（z=3.5）から撃つ → 床に着弾（変更前の 2.5m の床なら当たらない位置）
    late.send({ type: "pose", pos: [0, 0.1, 3.5], quat: [0, 0, 0, 1], tracking: true });
    await sleep(50);
    late.send({ type: "shot", pos: [0, 0, 3.5], vel: [0, -3, -2], radius: 0.09 });
    const farShot = await late.waitFor((m) => m.type === "shot" && m.shot.by === wlate.id);
    check("広げた床の奥からの発射が床に着弾する", farShot && farShot.shot.landing?.surfaceId === FLOOR_ID, JSON.stringify(farShot?.shot.landing));
    sz.ws.close();
    late.ws.close();
    szOv.ws.close();
  }
  // 試合 → 結果 → 練習の一周（サーバー経由。各境界で格子付きの state が配られる）。matchSec の下限 10 秒
  {
    const cyc = connect({ ...cfg, room: "cycle", matchSec: "10", waitSec: "0" }, "Cyc");
    await cyc.waitFor((m) => m.type === "welcome");
    const cycOv = connect({ ...cfg, room: "cycle", matchSec: "10", waitSec: "0", role: "overview" });
    await cycOv.waitFor((m) => m.type === "welcome");
    cyc.send({ type: "pose", pos: [0, 0.1, 1], quat: [0, 0, 0, 1], tracking: true });
    await sleep(50);
    cyc.send({ type: "shot", pos: [0, 0, 1], vel: [0, -2, -4.5], radius: 0.09 });
    await cyc.waitFor((m) => m.type === "shot");
    cycOv.send({ type: "start" });
    const cStart = await cyc.waitFor((m) => m.type === "state" && m.state.event?.kind === "start", 2000);
    check("一周: start（格子付き・練習の得点は 0）", cStart && cStart.state.grids && (cStart.state.scores[cStart.state.players[0].id] ?? 0) === 0);
    const cResult = await cyc.waitFor((m) => m.type === "state" && m.state.event?.kind === "result", 13000);
    check("一周: 10 秒後に result（格子付き・winners は空 = だれも塗れず）", cResult && cResult.state.grids && Array.isArray(cResult.state.winners) && cResult.state.phase === "result" && typeof cResult.state.phaseEndsAt === "number");
    const cPractice = await cyc.waitFor((m) => m.type === "state" && m.state.event?.kind === "practice", 10000);
    check("一周: 結果表示のあと練習に戻る（格子付き・phaseEndsAt は null・インクは満タン）", cPractice && cPractice.state.grids && cPractice.state.phase === "practice" && cPractice.state.phaseEndsAt === null && cPractice.state.ink[cPractice.state.players[0].id] === 1);
    // 俯瞰画面のソケットは別なので、届くまで少し待つ（同時判定だとレースで落ちることがあった）
    check("一周: 俯瞰画面にも同じ event が届く", (await cycOv.waitFor((m) => m.type === "state" && m.state.event?.kind === "practice", 1000)) !== null);
    cyc.ws.close();
    cycOv.ws.close();
  }
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
