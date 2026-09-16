// demos/08-2-splatoon-fixed（一度合わせて固定）のブラウザ経路をヘッドレス Chrome で確認する。
// `npm run check:08-2-fixed` で実行する。仕組みは headless-splatoon.mjs と同じ（CDP を ws で直接叩く。Chrome が無ければスキップ）。
//
// 確認内容: フェイクカメラ（field 座標系のマーカーをピンホール投影。実行中に window.__fakeCam で姿勢を変えられる）+ 合成の手で
// 2 つのウィンドウを同じ room に入れ、3 つ目で俯瞰画面を開いて、
//   - 正面の観測が N 回続くとアンカーが確定する（HUD の align=locked、console の "[fixed-anchor] locked #1"）。自分の位置がカメラの位置に一致
//   - 確定後にカメラを斜め（マーカーの正面から 39°）にしても、マーカーを隠しても、アンカー（ワールド座標）が 1µm も動かない。
//     観測は信頼されず（trusted=no(face)）、obsΔ=（08 ならこのぶん動いていた量）に回転 30° 以上が出る。その間も連射は受理される
//   - 信頼できる観測（正面のまま 10cm 横へ）でも refine=0 なら動かない
//   - refine=0.1 のウィンドウでは、正面のまま 10cm 横へ動かすと跳ばずに（最初の読みは 5cm 未満）単調に寄っていき 7cm 以上進む
//   - 練習中に Space を 2 秒押し続けると合わせ直し（realigning → locked #2）になり、新しいカメラ位置に一致する
//   - 対戦中は Space を押し続けても合わせ直さない
//   - 床の追加マーカーだけが見える 4 つ目のウィンドウも（俯瞰画面で配置を配ると）確定して入室・連射できる
//   - 俯瞰画面の「対戦開始」で試合になり、両ウィンドウと俯瞰画面の得点が一致する（08 と同じ経路が生きている）
//   - 例外が出ていない
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
// 他の headless-*.mjs と被らない値（同時に走らせても相手のサーバーに繋がらないように）
const PORT = Number(process.env.PORT ?? "") || 5197;
const CDP_PORT = Number(process.env.CDP_PORT ?? "") || 9342;
/** 両ウィンドウが確定してから練習の HUD を読むまでの待ち [s]（発射 2〜3 回） */
const WAIT_SEC = Number(process.env.WAIT_SEC ?? "") || 8;
/** 対戦開始を押してから試合中の HUD を読むまでの待ち [s] */
const PLAY_WAIT_SEC = Number(process.env.PLAY_WAIT_SEC ?? "") || 10;
const BASE = `https://localhost:${PORT}/demos/08-2-splatoon-fixed/`;
// markerMm=100: 合成カメラの幾何（原点マーカーが 80px に映る距離 0.74m）はこの実寸で調整してある（headless-splatoon.mjs と同じ）
const MARKER_MM = 100;
const COMMON = `fov=70&camZoom=1&fakecam=1&autostart=1&fakehands=1&fakeMarkerPx=80&handSmooth=1&room=fixedcheck&waitSec=1&markerMm=${MARKER_MM}`;
const OVERVIEW = `${BASE}overview.html?room=fixedcheck&waitSec=1&markerMm=${MARKER_MM}`;
/** 既定のフェイクカメラの位置: 原点マーカーが fakeMarkerPx=80 で正面に映る距離 d = markerSize × focal / (0.8 × 80) */
const FAKE_FOCAL = 640 / 2 / Math.tan((68 * Math.PI) / 180 / 2);
const D0 = ((MARKER_MM / 1000) * FAKE_FOCAL) / (0.8 * 80);

if (!existsSync(CHROME)) {
  console.log(`SKIP: Chrome が見つかりません (${CHROME})。CHROME=/path/to/chrome で指定できます`);
  process.exit(0);
}

const results = [];
function check(name, cond, detail = "") {
  results.push([name, cond]);
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${detail ? ` (${detail})` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dist3 = (a, b) => (a && b ? Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) : Infinity);
const fmt = (v) => (Array.isArray(v) ? `(${v.map((x) => x.toFixed(3)).join(",")})` : String(v));

const server = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], { stdio: ["ignore", "pipe", "pipe"] });
server.stderr.on("data", (d) => process.stderr.write(d));
const serverLines = [];
server.stdout.on("data", (d) => {
  for (const line of d.toString().split("\n")) {
    if (!line.startsWith("[splatoon]")) continue;
    serverLines.push(line);
    if (!/ shot #\d+:/.test(line)) console.log(line);
  }
});
let serverExited = false;
server.on("exit", () => {
  serverExited = true;
});
async function waitForServer(timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (serverExited) return false;
    try {
      const res = await fetch(BASE).catch(() => null);
      if (res?.ok) return true;
    } catch {
      // まだ起動していない
    }
    await sleep(300);
  }
  return false;
}

class Page {
  constructor(wsUrl, name) {
    this.name = name;
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.logs = [];
    this.exceptions = [];
    this.ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      if (m.id && this.pending.has(m.id)) {
        this.pending.get(m.id)(m);
        this.pending.delete(m.id);
      } else if (m.method === "Runtime.consoleAPICalled") {
        this.logs.push(m.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
      } else if (m.method === "Runtime.exceptionThrown") {
        this.exceptions.push(`${m.params.exceptionDetails.text} ${m.params.exceptionDetails.exception?.description ?? ""}`);
      }
    });
  }
  ready() {
    return new Promise((r) => this.ws.on("open", r));
  }
  send(method, params = {}) {
    return new Promise((resolve) => {
      const id = ++this.id;
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expr) {
    const r = await this.send("Runtime.evaluate", { expression: expr, returnByValue: true });
    return r.result?.result?.value ?? null;
  }
}

async function cdpJson(path, method = "GET") {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}${path}`, { method });
      return await r.json();
    } catch {
      await sleep(200);
    }
  }
  throw new Error("Chrome の DevTools ポートに接続できない");
}

async function openPage(target, name) {
  const page = new Page(target.webSocketDebuggerUrl, name);
  await page.ready();
  await page.send("Runtime.enable");
  await page.send("Page.enable");
  return page;
}

/** HUD の align / game 行を読む */
function parseHud(hud) {
  const g = hud.match(/game: phase=(\S+) left=(\S+) color=(\S+) players=(\S*) scores=(\S*) total=(\d+) shots=(\d+)\/(\d+)/);
  const scores = {};
  for (const m of (g?.[5] ?? "").matchAll(/(p\d+):(\d+)/g)) scores[m[1]] = Number(m[2]);
  const self = hud.match(/self=\(([^)]*)\)/)?.[1].split(",").map(Number);
  return {
    me: hud.match(/\bme=(\S+)/)?.[1] ?? "-",
    /** locked / aligning / realigning */
    align: hud.match(/align=(locked|aligning|realigning)/)?.[1] ?? "",
    alignLine: hud.match(/align=[^\n]*/)?.[0] ?? "",
    locks: Number(hud.match(/locks=(\d+)/)?.[1] ?? 0),
    refined: Number(hud.match(/refined=(\d+)/)?.[1] ?? 0),
    drift: Number(hud.match(/drift=([\d.]+)m/)?.[1] ?? NaN),
    obsDelta: Number(hud.match(/obsΔ=([\d.]+)m/)?.[1] ?? NaN),
    /** 直近の観測とアンカーの回転の差 [deg] */
    obsRot: Number(hud.match(/obsΔ=[\d.]+m\/([\d.]+)deg/)?.[1] ?? NaN),
    trusted: hud.match(/trusted=(yes|no\([a-z]+\))/)?.[1] ?? "",
    realigns: Number(hud.match(/realigns=(\d+)/)?.[1] ?? 0),
    obs: hud.match(/\bobs=(\S+)/)?.[1] ?? "",
    /** 生の観測に使っている ID の集合（"obs=id=0+5" → {0, 5}） */
    obsIds: new Set((hud.match(/\bobs=id=([\d+]+)/)?.[1] ?? "").split("+").filter(Boolean).map(Number)),
    lost: /\(lost\)/.test(hud),
    layout: hud.match(/layout=(\S+)/)?.[1] ?? "",
    self: self && self.length === 3 && self.every(Number.isFinite) ? self : null,
    phase: g?.[1] ?? "",
    color: g ? Number(g[3]) : 0,
    players: (g?.[4] ?? "").split(",").filter(Boolean),
    scores,
    total: g ? Number(g[6]) : 0,
    sent: g ? Number(g[7]) : -1,
    accepted: g ? Number(g[8]) : -1,
  };
}

function parseOverviewHud(hud) {
  const scores = {};
  for (const m of (hud.match(/scores=(\S*)/)?.[1] ?? "").matchAll(/(p\d+):(\d+)/g)) scores[m[1]] = Number(m[2]);
  return {
    me: hud.match(/\bme=(\S+)/)?.[1] ?? "-",
    phase: hud.match(/phase=(\S+)/)?.[1] ?? "",
    players: (hud.match(/players=(\S*)/)?.[1] ?? "").split(",").filter(Boolean),
    scores,
    starts: Number(hud.match(/starts=(\d+)/)?.[1] ?? -1),
    markers: hud.match(/\bmarkers=(\S+)/)?.[1] ?? "",
    markersSent: Number(hud.match(/markersSent=(\d+)/)?.[1] ?? -1),
    peerMarkers: Object.fromEntries((hud.match(/peerMarkers=(\S*)/)?.[1] ?? "").split(",").filter(Boolean).map((e) => e.split(":"))),
  };
}

const profile = mkdtempSync(join(tmpdir(), "mobile-mr-chrome-"));
let chrome = null;
let exitCode = 1;
try {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  if (!(await waitForServer())) throw new Error(`dev サーバーが起動しなかった（ポート ${PORT} が使用中でないか確認）`);
  chrome = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`,
      "--ignore-certificate-errors",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
      "--no-first-run",
      "--window-size=1280,720",
      "--enable-unsafe-swiftshader",
      ...(process.env.CHROME_ARGS ?? "").split(" ").filter(Boolean),
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const targets = await cdpJson("/json");
  const first = targets.find((t) => t.type === "page");
  const p1 = await openPage(first, "1");
  // ウィンドウ 1: 正面（既定の位置）。refine=0 で完全固定
  await p1.send("Page.navigate", { url: `${BASE}?${COMMON}&name=One&refine=0` });
  const version = await cdpJson("/json/version");
  const browser = new Page(version.webSocketDebuggerUrl, "browser");
  await browser.ready();
  const newWindow = async (name) => {
    const created = await browser.send("Target.createTarget", { url: "about:blank", newWindow: true });
    const t = (await cdpJson("/json")).find((x) => x.id === created.result.targetId);
    return openPage(t, name);
  };
  // ウィンドウ 2: 中央から 40px 右にずれた正面（信頼できる範囲内）。refine=0.1 で緩やかな補正を見る
  const p2 = await newWindow("2");
  await p2.send("Page.navigate", { url: `${BASE}?${COMMON}&name=Two&fakeShift=40&refine=0.1` });
  const p3 = await newWindow("3");
  await p3.send("Page.navigate", { url: OVERVIEW });

  const readHud = async (p) => parseHud((await p.eval("document.querySelector('#hud')?.textContent")) ?? "");
  const readOverview = async () => parseOverviewHud((await p3.eval("document.querySelector('#hud')?.textContent")) ?? "");
  const anchorPos = (p) => p.eval("window.__fixedDebug?.anchorPos()");
  const anchorQuat = (p) => p.eval("window.__fixedDebug?.anchorQuat()");
  const quatDeg = (a, b) => (a && b ? (2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]))) * 180) / Math.PI : NaN);
  const setCam = (p, pos, yaw = 0, pitch = 0) => p.eval(`(() => { const c = window.__fakeCam; c.pos = ${JSON.stringify(pos)}; c.yaw = ${yaw}; c.pitch = ${pitch}; return true; })()`);
  const show = (h) => `me=${h.me} align=${h.align} locks=${h.locks} phase=${h.phase} color=${h.color} players=${h.players.join("|")} scores=${JSON.stringify(h.scores)} shots=${h.sent}/${h.accepted} self=${h.self ? fmt(h.self) : "-"}`;

  // ---- 位置合わせ → 確定 ----
  const t0 = Date.now();
  let seenAligning = false;
  let h1 = await readHud(p1);
  let h2 = await readHud(p2);
  while (Date.now() - t0 < 60000) {
    [h1, h2] = await Promise.all([readHud(p1), readHud(p2)]);
    if (/align=aligning n=[1-9]/.test(h1.alignLine) || /align=aligning n=[1-9]/.test(h2.alignLine)) seenAligning = true;
    if (h1.me.startsWith("p") && h2.me.startsWith("p") && h1.align === "locked" && h2.align === "locked" && h1.self && h2.self) break;
    await sleep(200);
  }
  console.log(`両ウィンドウの入室 + 確定まで ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`window1: ${h1.alignLine}`);
  console.log(`window2: ${h2.alignLine}`);
  check("両ウィンドウで位置合わせが確定している（align=locked、locks=1）", h1.align === "locked" && h2.align === "locked" && h1.locks === 1 && h2.locks === 1, `${h1.align}/${h2.align}`);
  check("確定前に「合わせ中 n/N」の段階を通っている（HUD の aligning n= か console の locked #1 after N samples）", seenAligning || p1.logs.some((l) => /\[fixed-anchor\] locked #1 .* after 10 samples/.test(l)), `seenAligning=${seenAligning}`);
  check("確定時の観測は信頼できる条件（正面・近距離・中央）を満たしている（trusted=yes）", h1.trusted === "yes" && h2.trusted === "yes", `${h1.trusted}/${h2.trusted}`);
  const self1Err = h1.self ? dist3(h1.self, [0, 0, D0]) : Infinity;
  check(`確定したアンカーから出した自分の位置がフェイクカメラの位置 (0,0,${D0.toFixed(3)}) に 5cm 以内で一致`, self1Err < 0.05, `self=${fmt(h1.self)} err=${self1Err.toFixed(3)}m`);
  check("確定直後は補正が入っていない（drift=0、refined=0）", h1.drift === 0 && h1.refined === 0 && h2.drift < 0.005, `drift=${h1.drift}/${h2.drift} refined=${h1.refined}/${h2.refined}`);
  await sleep(WAIT_SEC * 1000);

  // ---- 練習（入室直後）----
  const pr1 = await readHud(p1);
  const pr2 = await readHud(p2);
  const prOv = await readOverview();
  console.log(`practice window1: ${show(pr1)}`);
  console.log(`practice window2: ${show(pr2)}`);
  check("両方が同じ room に入り 2 人になっている", pr1.players.length === 2 && pr2.players.length === 2);
  check("個人戦: 別の色が割り当たっている", pr1.color > 0 && pr2.color > 0 && pr1.color !== pr2.color, `${pr1.color} vs ${pr2.color}`);
  check("入室直後は練習（practice）で、俯瞰画面もそう見えている", pr1.phase === "practice" && pr2.phase === "practice" && prOv.phase === "practice");
  check("確定後に連射が送られ受理されている（pose は確定後に送られる）", pr1.sent >= 3 && pr1.accepted >= 3 && pr2.accepted >= 3, `${pr1.sent}/${pr1.accepted}, ${pr2.sent}/${pr2.accepted}`);
  check("練習中の塗りが得点に出る", (pr1.scores[pr1.me] ?? 0) > 0 && (pr2.scores[pr2.me] ?? 0) > 0, JSON.stringify(pr1.scores));

  // ---- 確定後にカメラを斜めにしてもアンカーが動かない ----
  const a0 = await anchorPos(p1);
  const selfLocked = pr1.self;
  // 右へ回り込み（距離 0.71m）、マーカーが画面の中央に来るよう左（+yaw）を向く: 中央（off≈0）だが正対から 39°（face）。
  // 合成カメラ（640x480）では 0.9m 以遠のマーカー（50px 未満）は角の量子化で位置が 5〜12cm ずれる（08 でも同じ）ので、近い幾何で見る
  const qLocked = await anchorQuat(p1);
  const yawSide = (Math.atan2(0.45, 0.55) * 180) / Math.PI;
  await setCam(p1, [0.45, 0, 0.55], yawSide);
  await sleep(3000);
  const sd1 = await readHud(p1);
  const a1 = await anchorPos(p1);
  console.log(`side window1: ${sd1.alignLine}\n  anchor ${fmt(a0)} → ${fmt(a1)} self=${fmt(sd1.self)}`);
  check("斜め（正対から 39°）からの観測は検出されるが信頼されない（trusted=no(face)）", sd1.obs.startsWith("id=") && sd1.trusted === "no(face)", `obs=${sd1.obs} ${sd1.trusted}`);
  check("斜めにしてもアンカー（ワールド座標）が動かない（位置 1µm 未満・回転 0.001° 未満）", dist3(a0, a1) < 1e-6 && quatDeg(qLocked, await anchorQuat(p1)) < 1e-3, `moved ${dist3(a0, a1).toExponential(2)}m`);
  check("観測とアンカーの差 obsΔ=（08 ならこのぶん動いていた量）に回転 30° 以上が出ている", sd1.obsRot >= 30, `obsΔ=${sd1.obsDelta}m/${sd1.obsRot}deg`);
  check("自分の位置（self）も確定時のまま（斜めの観測で飛ばない）", dist3(sd1.self, selfLocked) < 0.02, `${fmt(selfLocked)} → ${fmt(sd1.self)}`);
  check("斜めの間も locked のまま連射が受理されている", sd1.align === "locked" && sd1.accepted > pr1.accepted, `${pr1.accepted} → ${sd1.accepted}`);
  // 正面に戻してから、マーカーを隠す（ロスト）→ 戻す（再検出）でも動かない
  await setCam(p1, [0, 0, D0], 0);
  await sleep(1200);
  await p1.eval("window.__fakeMarkers.hidden.add(0)");
  await sleep(1500);
  const lost1 = await readHud(p1);
  const aLost = await anchorPos(p1);
  await p1.eval("window.__fakeMarkers.hidden.delete(0)");
  await sleep(1500);
  const back1 = await readHud(p1);
  const aBack = await anchorPos(p1);
  console.log(`lost window1: obs=${lost1.obs} lost=${lost1.lost} → back obs=${back1.obs}`);
  check("マーカーを隠すと生の観測は lost になるが、アンカーは動かず locked のまま", lost1.lost && lost1.align === "locked" && dist3(a0, aLost) < 1e-6, `lost=${lost1.lost} moved ${dist3(a0, aLost).toExponential(2)}m`);
  check("再検出しても再スナップせずアンカーは動かない", !back1.lost && back1.obs.startsWith("id=") && dist3(a0, aBack) < 1e-6, `moved ${dist3(a0, aBack).toExponential(2)}m`);
  // 正面のまま 10cm 横（信頼できる観測）でも refine=0 なら動かない
  await setCam(p1, [0.1, 0, D0], 0);
  await sleep(2500);
  const tr1 = await readHud(p1);
  const aTrusted = await anchorPos(p1);
  console.log(`trusted-shift window1: ${tr1.alignLine}`);
  check("正面のまま 10cm 横の観測は信頼される（trusted=yes、obsΔ≈0.1m）", tr1.trusted === "yes" && tr1.obsDelta > 0.05 && tr1.obsDelta < 0.2, `${tr1.trusted} obsΔ=${tr1.obsDelta}`);
  check("refine=0 なら信頼できる観測でもアンカーは動かない（refined=0）", dist3(a0, aTrusted) < 1e-6 && tr1.refined === 0, `moved ${dist3(a0, aTrusted).toExponential(2)}m refined=${tr1.refined}`);

  // ---- refine=0.1（ウィンドウ 2）: 正面のまま 10cm 横へ → 跳ばずに単調に寄っていく ----
  const b0 = await anchorPos(p2);
  const x2 = (-40 * D0) / FAKE_FOCAL; // fakeShift=40 の既定位置
  await setCam(p2, [x2 + 0.1, 0, D0], 0);
  const moved = [];
  for (let i = 0; i < 60; i++) {
    moved.push(dist3(b0, await anchorPos(p2)));
    await sleep(100);
  }
  const rf2 = await readHud(p2);
  const monotonic = moved.every((v, i) => i === 0 || v >= moved[i - 1] - 0.001);
  console.log(`refine window2: first=${moved[0].toFixed(3)} mid=${moved[Math.floor(moved.length / 2)].toFixed(3)} last=${moved.at(-1).toFixed(3)} refined=${rf2.refined} drift=${rf2.drift}`);
  check("refine=0.1: 最初の読みでは 5cm 未満しか動いていない（スナップしない）", moved[0] < 0.05, `first=${moved[0].toFixed(3)}`);
  check("refine=0.1: 観測のたびに単調に寄っていく（戻らない・跳ばない）", monotonic && moved.some((v) => v > 0.02 && v < 0.08), `samples=${moved.filter((_, i) => i % 10 === 0).map((v) => v.toFixed(3)).join(",")}`);
  check("refine=0.1: 6 秒で 7cm 以上寄り、10cm を超えない（HUD の refined と drift も進んでいる）", moved.at(-1) >= 0.07 && moved.at(-1) <= 0.11 && rf2.refined > 0 && rf2.drift >= 0.07, `last=${moved.at(-1).toFixed(3)} refined=${rf2.refined} drift=${rf2.drift}`);
  check("refine で寄っている間も locks は 1 のまま（確定し直していない）", rf2.locks === 1 && rf2.align === "locked", `locks=${rf2.locks}`);

  // ---- 合わせ直し（練習中に Space を 2 秒押し続ける）----
  // ウィンドウ 1 のカメラを別の正面寄りの位置（右 0.25m・奥 0.7m、マーカーを中央に = 正対から 20°）へ。refine=0 なのでアンカーは古いまま
  const RE_POS = [0.25, 0, 0.7];
  const yawRe = (Math.atan2(RE_POS[0], RE_POS[2]) * 180) / Math.PI;
  await setCam(p1, RE_POS, yawRe);
  await sleep(1500);
  const pre1 = await readHud(p1);
  check("合わせ直す前: 新しい位置の観測は信頼できる（face 20°）が、アンカーは古いまま（obsΔ の回転 ≥ 15°、位置は不動）", pre1.trusted === "yes" && pre1.obsRot >= 15 && dist3(a0, await anchorPos(p1)) < 1e-6, `${pre1.trusted} obsΔ=${pre1.obsDelta}m/${pre1.obsRot}deg`);
  const key = (type) => p1.send("Input.dispatchKeyEvent", { type, key: " ", code: "Space", windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
  await key("keyDown");
  await sleep(800);
  const mid1 = await readHud(p1);
  await sleep(1900);
  await key("keyUp");
  const tRe = Date.now();
  let re1 = await readHud(p1);
  let sawRealigning = re1.align === "realigning";
  while (Date.now() - tRe < 15000 && !(re1.locks >= 2 && re1.align === "locked" && re1.self)) {
    await sleep(200);
    re1 = await readHud(p1);
    if (re1.align === "realigning") sawRealigning = true;
  }
  const aRe = await anchorPos(p1);
  console.log(`realign window1: ${re1.alignLine}\n  anchor ${fmt(a0)} → ${fmt(aRe)} self=${fmt(re1.self)}`);
  check("押し始めて 0.8 秒ではまだ合わせ直していない（2 秒の押し続けが要る）", mid1.realigns === 0 && mid1.locks === 1, `realigns=${mid1.realigns}`);
  check("2 秒押し続けると合わせ直しが始まり（realigns=1、console の realign requested）、確定し直す（locks=2）", re1.realigns === 1 && re1.locks === 2 && re1.align === "locked" && p1.logs.some((l) => /\[fixed-anchor\] realign requested \(#1\)/.test(l)), `realigns=${re1.realigns} locks=${re1.locks} align=${re1.align}`);
  check("合わせ直しの途中は realigning（いまの位置を保持したまま集め直す）を通っている", sawRealigning || p1.logs.some((l) => /\[fixed-anchor\] locked #2/.test(l)), `sawRealigning=${sawRealigning}`);
  const selfReErr = re1.self ? dist3(re1.self, RE_POS) : Infinity;
  check(`合わせ直し後の自分の位置が新しいカメラの位置 (${RE_POS.join(",")}) に 5cm 以内で一致`, selfReErr < 0.05, `self=${fmt(re1.self)} err=${selfReErr.toFixed(3)}m`);
  const reRot = quatDeg(qLocked, await anchorQuat(p1));
  check("合わせ直しでアンカーが新しい姿勢へ置き換わった（回転 15° 以上・自分の位置 0.2m 以上）", reRot >= 15 && dist3(selfLocked, re1.self) >= 0.2, `rot=${reRot.toFixed(1)}deg self moved ${dist3(selfLocked, re1.self).toFixed(3)}m`);

  // ---- 床の追加マーカーだけが見えるウィンドウでも確定できる（俯瞰画面で配置を配る）----
  const setRows = await p3.eval(`(() => {
    const rows = document.querySelectorAll('#marker-rows .row');
    const row = rows[0];
    const cb = row.querySelector('input[type=checkbox]');
    cb.checked = true;
    cb.dispatchEvent(new Event('change'));
    const nums = row.querySelectorAll('input[type=number]');
    [[0, 1], [1, 0], [3, 0.6]].forEach(([i, v]) => { nums[i].value = String(v); nums[i].dispatchEvent(new Event('input')); });
    return !cb.disabled;
  })()`);
  check("練習中は追加マーカーの行が有効", setRows === true);
  await sleep(300);
  await p3.eval("document.querySelector('#apply-markers').click()");
  await sleep(2500);
  const mkOv = await readOverview();
  const mk1 = await readHud(p1);
  check("反映で全員に配置（床 1）が届く", mk1.layout === "1:floor" && mkOv.markers === "1:floor", `${mk1.layout} / ${mkOv.markers}`);
  check("配置が配られてもアンカーは動かない（locks=2 のまま）", mk1.locks === 2 && dist3(aRe, await anchorPos(p1)) < 1e-6, `locks=${mk1.locks}`);
  // 床のマーカー（field (0,-1.2,0.6)。Y は既定の床の高さ）を見下ろすカメラ: 距離 0.52m、正対から 17°、中央から 5° 程度
  const p4 = await newWindow("4");
  await p4.send("Page.navigate", { url: `${BASE}?${COMMON}&name=Four&refine=0&fakeMarkers=1:floor:0,-1.2,0.6&fakeCamPos=0.05,-0.7,0.75&fakePitch=65&fakeHideOrigin=1` });
  const t4 = Date.now();
  let h4 = await readHud(p4);
  while (Date.now() - t4 < 40000 && !(h4.me.startsWith("p") && h4.align === "locked" && h4.accepted >= 2)) {
    await sleep(500);
    h4 = await readHud(p4);
  }
  console.log(`floor-only window4: ${show(h4)}\n  ${h4.alignLine} (${((Date.now() - t4) / 1000).toFixed(1)}s)`);
  check("床のマーカーだけで確定できる（obs=id=1、trusted=yes）", h4.align === "locked" && h4.obsIds.size === 1 && h4.obsIds.has(1) && h4.trusted === "yes", `${h4.align} obs=${h4.obs} ${h4.trusted}`);
  check("配置を配った後もウィンドウ 1 のアンカーは動いていない（切り替えで飛ばない）", dist3(aRe, await anchorPos(p1)) < 1e-6);
  const self4Err = h4.self ? dist3(h4.self, [0.05, -0.7, 0.75]) : Infinity;
  check("床のマーカーから確定した自分の位置がフェイクカメラの位置 (0.05,-0.7,0.75) に 8cm 以内で一致", self4Err < 0.08, `self=${fmt(h4.self)} err=${self4Err.toFixed(3)}m`);
  check("床のマーカーだけの端末も入室して連射が受理される", h4.me.startsWith("p") && h4.accepted >= 2 && h4.phase === "practice", `${h4.sent}/${h4.accepted}`);
  const ov4 = await readOverview();
  check("俯瞰画面でも 4 つ目の端末は床のマーカー（1）で位置合わせしていると見える", ov4.peerMarkers[h4.me] === "1", JSON.stringify(ov4.peerMarkers));

  // ---- 対戦開始（俯瞰画面のボタン）→ 対戦中は合わせ直さない → 得点の一致 ----
  await p3.eval("document.querySelector('#start-match').click()");
  await sleep(PLAY_WAIT_SEC * 1000);
  const hud1 = await readHud(p1);
  const hud2 = await readHud(p2);
  const hudOv = await readOverview();
  console.log(`play window1: ${show(hud1)}`);
  console.log(`play window2: ${show(hud2)}`);
  check("俯瞰画面の start が送られ、試合（play）になっている", hudOv.starts === 1 && hud1.phase === "play" && hud2.phase === "play" && hudOv.phase === "play");
  const locksPlay = hud1.locks;
  await key("keyDown");
  await sleep(2800);
  await key("keyUp");
  await sleep(500);
  const noRe1 = await readHud(p1);
  check("対戦中に Space を 2 秒押し続けても合わせ直さない（realigns / locks が増えない）", noRe1.realigns === 1 && noRe1.locks === locksPlay && noRe1.phase === "play", `realigns=${noRe1.realigns} locks=${noRe1.locks} phase=${noRe1.phase}`);
  check("両プレイヤーが得点している（着弾と塗りが field 座標で合っている）", (hud1.scores[hud1.me] ?? 0) > 0 && (hud2.scores[hud2.me] ?? 0) > 0, JSON.stringify(hud1.scores));
  const diff = Object.keys({ ...hud1.scores, ...hud2.scores }).reduce((a, k) => a + Math.abs((hud1.scores[k] ?? 0) - (hud2.scores[k] ?? 0)), 0);
  check("両ウィンドウの HUD でほぼ同じ得点が見えている（権威状態の配信）", diff <= Math.max(200, hud1.total * 0.02), `${JSON.stringify(hud1.scores)} vs ${JSON.stringify(hud2.scores)}`);
  const diffOv = Object.keys({ ...hud1.scores, ...hudOv.scores }).reduce((a, k) => a + Math.abs((hud1.scores[k] ?? 0) - (hudOv.scores[k] ?? 0)), 0);
  check("俯瞰画面でもほぼ同じ得点が見えている", diffOv <= Math.max(200, hud1.total * 0.02), `${JSON.stringify(hud1.scores)} vs ${JSON.stringify(hudOv.scores)}`);
  const landings = serverLines.filter((l) => / shot #\d+: /.test(l));
  const hits = landings.filter((l) => !/ shot #\d+: miss/.test(l));
  check("着弾のほとんどが壁か床に当たっている（外れが半分未満）", landings.length >= 6 && hits.length > landings.length / 2, `${hits.length}/${landings.length} hit`);
  check("例外が出ていない", [p1, p2, p3, p4].every((p) => p.exceptions.length === 0), [p1, p2, p3, p4].flatMap((p) => p.exceptions).slice(0, 2).join(" | "));
  for (const l of p1.logs.filter((l) => l.startsWith("[fixed-anchor]"))) console.log(`window1 log: ${l}`);

  const failed = results.filter(([, ok]) => !ok);
  console.log(failed.length === 0 ? "\nALL PASS" : `\n${failed.length} FAILED`);
  exitCode = failed.length === 0 ? 0 : 1;
} catch (e) {
  console.error("確認の実行エラー:", e.message ?? e);
} finally {
  chrome?.kill();
  server.kill();
  await sleep(500);
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // 一時ディレクトリなので残っても害はない
  }
}
process.exit(exitCode);
