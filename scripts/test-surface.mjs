// Phase 7 (07-surface-mapping) の回帰テスト。`npm run test:surface` で実行する。
//   1. src/shared/surface.ts — UV ↔ Surface 座標・視線と面の交点（純粋関数）
//   2. src/shared/surface-paint.ts — ペイントの検証・順序・上限・レート制限
//   3. server/surface.ts（+ server/room-server.ts）— WebSocket の受け付け・snapshot・paint の配信・
//      clear・設定不一致の拒否（Vite dev サーバーを起動して叩く）
// テストフレームワークは使わない（04〜06-2 と同じ方針）。Node 22.18+ は .ts をそのまま import できる
import { spawn } from "node:child_process";
import WebSocket from "ws";
import {
  makeSurface,
  localToUv,
  raySurfaceHit,
  uvDistanceM,
  uvToLocal,
  surfaceIdFor,
} from "../src/shared/surface.ts";
import { PAINT_RATE_PER_SEC, PaintBoard } from "../src/shared/surface-paint.ts";
import { SURFACE_PATH, SURFACE_PROTOCOL_VERSION } from "../src/shared/surface-protocol.ts";

const results = [];
function check(name, cond, detail = "") {
  results.push([name, cond]);
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${detail ? ` (${detail})` : ""}`);
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ================= 1. surface =================
{
  const s = makeSurface(3, 1.0, 0.8);
  check("surfaceIdFor: wall-<markerId>", s.id === "wall-3" && surfaceIdFor(0) === "wall-0");
  const c = uvToLocal(s, [0.5, 0.5]);
  check("uvToLocal: 中心 (0.5,0.5) はマーカー中心", near(c[0], 0) && near(c[1], 0));
  const tl = uvToLocal(s, [0, 0]);
  check("uvToLocal: 左上 (0,0) は (-w/2, +h/2)", near(tl[0], -0.5) && near(tl[1], 0.4));
  const br = uvToLocal(s, [1, 1]);
  check("uvToLocal: 右下 (1,1) は (+w/2, -h/2)", near(br[0], 0.5) && near(br[1], -0.4));
  const rt = localToUv(s, uvToLocal(s, [0.3, 0.9]));
  check("localToUv ∘ uvToLocal は恒等", near(rt[0], 0.3) && near(rt[1], 0.9));
  check("uvDistanceM: 縦横比を反映", near(uvDistanceM(s, [0, 0], [1, 0]), 1.0) && near(uvDistanceM(s, [0, 0], [0, 1]), 0.8));

  // 視線: 面の 2m 手前から中心をまっすぐ
  const h0 = raySurfaceHit(s, [0, 0, 2], [0, 0, -1]);
  check("raySurfaceHit: 正面から中心", h0 && near(h0.uv[0], 0.5) && near(h0.uv[1], 0.5) && near(h0.distance, 2) && h0.inside);
  // 斜め: 原点 (0.2, 0.1, 1) から (-0.2, -0.1, -1) 方向 → 交点 (0, 0)
  const h1 = raySurfaceHit(s, [0.2, 0.1, 1], [-0.2, -0.1, -1]);
  check("raySurfaceHit: 斜めの視線", h1 && near(h1.point[0], 0) && near(h1.point[1], 0) && near(h1.distance, Math.hypot(0.2, 0.1, 1)));
  const h2 = raySurfaceHit(s, [0.9, 0, 1], [0, 0, -1]);
  check("raySurfaceHit: 矩形の外は inside=false（uv は返る）", h2 && !h2.inside && near(h2.uv[0], 1.4));
  check("raySurfaceHit: 面から遠ざかる視線は null", raySurfaceHit(s, [0, 0, 1], [0, 0, 1]) === null);
  check("raySurfaceHit: 面と平行は null", raySurfaceHit(s, [0, 0, 1], [1, 0, 0]) === null);
  check("raySurfaceHit: 裏側からは null", raySurfaceHit(s, [0, 0, -1], [0, 0, 1]) === null);
}

// ================= 2. PaintBoard =================
{
  const s = makeSurface(0, 1, 0.8);
  const b = new PaintBoard([s], 5);
  const st = b.paint("p1", 0, { surfaceId: "wall-0", uv: [0.25, 0.75], radius: 0.03 }, 1000);
  check("paint: 受理され seq=1・色と by が付く", st && st.seq === 1 && st.color === 0 && st.by === "p1" && st.t === 1000);
  check("paint: 不明な surface は拒否", b.paint("p1", 0, { surfaceId: "wall-9", uv: [0.5, 0.5], radius: 0.03 }, 1001) === null && b.lastRejectReason.startsWith("unknown"));
  check("paint: uv の範囲外は拒否", b.paint("p1", 0, { surfaceId: "wall-0", uv: [1.2, 0.5], radius: 0.03 }, 1002) === null);
  check("paint: 半径の範囲外は拒否", b.paint("p1", 0, { surfaceId: "wall-0", uv: [0.5, 0.5], radius: 5 }, 1003) === null && b.paint("p1", 0, { surfaceId: "wall-0", uv: [0.5, 0.5], radius: 0 }, 1003) === null);
  for (let i = 0; i < 4; i++) b.paint("p2", 1, { surfaceId: "wall-0", uv: [0.1 * i, 0.5], radius: 0.03 }, 1100 + i);
  check("上限（5 件）までは保持し clearedByLimit=false", b.strokes.length === 5 && !b.clearedByLimit);
  const sixth = b.paint("p2", 1, { surfaceId: "wall-0", uv: [0.9, 0.5], radius: 0.03 }, 1200);
  check("上限を超えたら全消去して新しい 1 件だけ残し clearedByLimit=true", sixth && b.strokes.length === 1 && b.strokes[0].seq === 6 && b.clearedByLimit);
  b.paint("p2", 1, { surfaceId: "wall-0", uv: [0.9, 0.6], radius: 0.03 }, 1201);
  check("次の paint では clearedByLimit が戻る", b.strokes.length === 2 && !b.clearedByLimit);
  const seqs = b.strokes.map((x) => x.seq);
  check("seq は単調増加", seqs.every((v, i) => i === 0 || v > seqs[i - 1]));
  const snap = b.snapshot();
  check("snapshot: surfaces と strokes と seq", snap.surfaces.length === 1 && snap.strokes.length === 2 && snap.seq === 7);
  // レート制限: 1 秒に PAINT_RATE_PER_SEC まで
  const rb = new PaintBoard([s]);
  let ok = 0;
  for (let i = 0; i < PAINT_RATE_PER_SEC + 5; i++) {
    if (rb.paint("p1", 0, { surfaceId: "wall-0", uv: [0.5, 0.5], radius: 0.03 }, 5000 + i)) ok++;
  }
  check(`レート制限: 1 秒に ${PAINT_RATE_PER_SEC} 件まで`, ok === PAINT_RATE_PER_SEC && rb.lastRejectReason === "rate limited");
  check("レート制限: 1 秒経てば再び受理", rb.paint("p1", 0, { surfaceId: "wall-0", uv: [0.5, 0.5], radius: 0.03 }, 6100) !== null);
  check("レート制限は人ごと", rb.paint("p2", 1, { surfaceId: "wall-0", uv: [0.5, 0.5], radius: 0.03 }, 5010) !== null);
  rb.clear();
  check("clear で空", rb.strokes.length === 0);
}

// ================= 3. server =================
const PORT = 5184;
const server = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], { stdio: ["ignore", "pipe", "pipe"] });
server.stderr.on("data", (d) => process.stderr.write(d));
server.stdout.on("data", (d) => {
  for (const line of d.toString().split("\n")) if (line.startsWith("[surface]")) console.log(line);
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
  const q = new URLSearchParams({ v: String(SURFACE_PROTOCOL_VERSION), ...query });
  if (name) q.set("name", name);
  const ws = new WebSocket(`wss://localhost:${PORT}${SURFACE_PATH}?${q}`, {
    rejectUnauthorized: false,
    headers: { origin: `https://localhost:${PORT}` },
  });
  const client = { ws, msgs: [], closed: false };
  ws.on("message", (d) => client.msgs.push(JSON.parse(d.toString())));
  ws.on("close", () => {
    client.closed = true;
  });
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
  const cfg = { room: "test", markerId: "0", markerMm: "100", surfaceW: "1", surfaceH: "0.8" };
  const a = connect(cfg, "Alice");
  const wa = await a.waitFor((m) => m.type === "welcome");
  check("welcome: 自分の id・players・空の snapshot", wa && wa.id === "p1" && wa.players.length === 1 && wa.snapshot.strokes.length === 0 && wa.snapshot.surfaces[0].id === "wall-0");
  check("welcome: 表示名と色", wa && wa.players[0].name === "Alice" && wa.players[0].color === 0);

  a.send({ type: "paint", surfaceId: "wall-0", uv: [0.25, 0.5], radius: 0.03 });
  const pa = await a.waitFor((m) => m.type === "paint");
  check("paint: 送信者にも配信される（seq・色・by 付き）", pa && pa.stroke.seq === 1 && pa.stroke.by === "p1" && pa.stroke.color === 0 && pa.stroke.uv[0] === 0.25);
  a.send({ type: "paint", surfaceId: "wall-0", uv: [1.5, 0.5], radius: 0.03 });
  a.send({ type: "paint", surfaceId: "wall-0", uv: "x", radius: 0.03 });
  a.send("not json");
  await sleep(200);
  check("不正な paint は捨てられる（配信されない）", a.msgs.filter((m) => m.type === "paint").length === 1);

  const b = connect(cfg, "Bob");
  const wb = await b.waitFor((m) => m.type === "welcome");
  check("2 人目の welcome: snapshot に既存のストローク・players に 2 人", wb && wb.snapshot.strokes.length === 1 && wb.players.length === 2 && wb.players[1].color === 1);
  const ja = await a.waitFor((m) => m.type === "join");
  check("join が 1 人目に届く（色付き）", ja && ja.player.id === "p2" && ja.player.color === 1);
  b.send({ type: "paint", surfaceId: "wall-0", uv: [0.75, 0.5], radius: 0.05 });
  const pab = await a.waitFor((m) => m.type === "paint" && m.stroke.by === "p2");
  check("相手の paint が届く（seq=2・色 1）", pab && pab.stroke.seq === 2 && pab.stroke.color === 1);

  b.send({ type: "pose", pos: [0, 0, 1.5], quat: [0, 0, 0, 2], tracking: true, cursor: { surfaceId: "wall-0", uv: [0.1, 0.2] } });
  const pose = await a.waitFor((m) => m.type === "pose" && m.id === "p2");
  check("pose が中継され quat は正規化・cursor 付き", pose && Math.abs(pose.quat[3] - 1) < 1e-9 && pose.cursor.uv[1] === 0.2);
  b.send({ type: "pose", pos: [0, 0, 1.5], quat: [0, 0, 0, 1], tracking: true, cursor: { surfaceId: "wall-0", uv: [0.1] } });
  await sleep(100);
  check("cursor が不正な pose は捨てられる", a.msgs.filter((m) => m.type === "pose").length === 1);

  b.send({ type: "pose", pos: [0, 0, 1.5], quat: [0, 0, 0, 1], tracking: true, cursor: { surfaceId: "wall-9", uv: [0.1, 0.2] } });
  const poseUnknown = await a.waitFor((m) => m.type === "pose" && m.id === "p2" && !("cursor" in m));
  check("知らない Surface の cursor は落として中継", poseUnknown !== null);

  b.send({ type: "clear" });
  const ca = await a.waitFor((m) => m.type === "clear");
  check("clear が全員に届く（by 付き）", ca && ca.by === "p2");
  b.send({ type: "clear" });
  await sleep(150);
  check("clear は 1 秒に 1 回まで（連打は無視）", a.msgs.filter((m) => m.type === "clear").length === 1);
  const c = connect(cfg, "Carol");
  const wc = await c.waitFor((m) => m.type === "welcome");
  check("clear 後の入室は空の snapshot", wc && wc.snapshot.strokes.length === 0 && wc.players.length === 3);

  const bad = connect({ ...cfg, surfaceW: "2" });
  const err = await bad.waitFor((m) => m.type === "error");
  check("Surface の大きさが違う端末は入室拒否", err && /不一致/.test(err.reason));
  const badV = connect({ ...cfg, v: "99" });
  const errV = await badV.waitFor((m) => m.type === "error");
  check("プロトコルバージョン不一致は拒否", errV && /バージョン/.test(errV.reason));
  const badCfg = connect({ ...cfg, surfaceH: "0" });
  const errCfg = await badCfg.waitFor((m) => m.type === "error");
  check("Room 設定が不正なら拒否", errCfg && /不正/.test(errCfg.reason));

  b.ws.close();
  const la = await a.waitFor((m) => m.type === "leave");
  check("leave が届く", la && la.id === "p2");
  a.ws.close();
  c.ws.close();
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
