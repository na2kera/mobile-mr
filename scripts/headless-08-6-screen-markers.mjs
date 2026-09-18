// demos/08-6-splatoon-screen-markers のブラウザ経路をヘッドレス Chrome で確認する。`npm run check:08-6-screen-markers` で実行する。
// 仕組みは headless-splatoon.mjs と同じ（CDP を ws で直接叩く。Chrome が無ければスキップ）。
//
// 確認内容:
//   - 画面マーカー（markers-screen.html）が ?pxPerMm= と ?markerMm= の指定どおりの大きさ（黒い正方形 80mm × 2 px/mm = 160px、余白込み 200px）で
//     原点を中央に、追加マーカー 4 枚を周りに描く。単一モードなら 1 枚、収まらない一辺は最大に丸めて描くが接続も反映もしない（HUD の clamped=1 blocked=1）
//   - 空の room に「丸める設定」（multi 4 枚・150mm を 1280x720 / 2 px/mm）で開くと接続せず反映ボタンが disabled。
//     表示領域を広げる（resize）と収まって接続し、狭めると再び切断する
//   - 較正線（100mm）が 100 × pxPerMm の CSS px で、マーカーの余白に重ならずに描かれている
//   - 画面の配置（window.__screenMarkers.placements()）と同じ配置をフェイクカメラ（fake-markers.ts の 3D 版）に描いた 2 つのスマホ窓 + 俯瞰画面を
//     同じ room に入れ、画面マーカーの「room に反映」を押すと全員の layout= / markers= に同じ配置が届く
//   - スマホ窓 1 は原点 + 追加マーカーを同時に使い（marker=id=0+1+...）、原点の候補のばらつき spread が小さい
//   - 2 窓で入室・発射・得点し、俯瞰画面の「対戦開始」で試合になり、両方の得点が入る
//   - 例外が出ていない
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
// 他の headless-*.mjs と被らない値（同時に走らせたとき相手のサーバーに繋がないため）
const PORT = Number(process.env.PORT ?? "") || 5211;
const CDP_PORT = Number(process.env.CDP_PORT ?? "") || 9351;
/** 配置を配ってから複数マーカーの合成を読むまでの待ち [s] */
const WAIT_SEC = Number(process.env.WAIT_SEC ?? "") || 6;
/** 対戦開始を押してから試合中の HUD を読むまでの待ち [s]（カウントダウン 1s + 発射 3〜4 回） */
const PLAY_WAIT_SEC = Number(process.env.PLAY_WAIT_SEC ?? "") || 12;
const BASE = `https://localhost:${PORT}/demos/08-6-splatoon-screen-markers/`;
// 一辺 80mm（room 設定。画面マーカー・俯瞰画面・スマホで同じ値）。フェイクカメラは原点が fakeMarkerPx=80 に映る距離
// （80mm × 焦点 474px / (0.8 × 80px) ≈ 0.59m）に置く: 合成の手はカメラの 0.45m 前なので、これより近いと発射位置が壁の裏（Z < 0）になり
// サーバーが "bad position" で弾く。画面上 ±116mm の追加マーカーは視軸から約 11° に映る。
// 画面マーカーのウィンドウは Emulation で 1280x720 に固定する（ヘッドレスの既定はウィンドウ枠ぶん低く、収まる最大が変わって配置がずれる）
const MARKER_MM = 80;
const PX_PER_MM = 2;
const BOARD_W = 1280;
const BOARD_H = 720;
const COMMON = `fov=70&camZoom=1&fakecam=1&autostart=1&fakehands=1&fakeMarkerPx=80&handSmooth=1&room=check&waitSec=1&tankHoldMs=0&markerMm=${MARKER_MM}`;
const OVERVIEW = `${BASE}overview.html?room=check&waitSec=1&markerMm=${MARKER_MM}`;
const SCREEN = `${BASE}markers-screen.html?room=check&waitSec=1&markerMm=${MARKER_MM}&pxPerMm=${PX_PER_MM}&mode=multi&count=4`;

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

const landings = [];
const serverLines = [];
const server = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], { stdio: ["ignore", "pipe", "pipe"] });
server.stderr.on("data", (d) => {
  process.stderr.write(d);
  // 入室の拒否（room-server.ts の reject）は console.warn なので stderr に出る
  for (const line of d.toString().split("\n")) if (line.startsWith("[splatoon]")) serverLines.push(line);
});
server.stdout.on("data", (d) => {
  for (const line of d.toString().split("\n")) {
    if (!line.startsWith("[splatoon]")) continue;
    serverLines.push(line);
    const m = line.match(/^\[splatoon\] (p\d+) shot #\d+: (\S+)/);
    if (m) landings.push({ by: m[1], where: m[2] });
    else console.log(line);
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

/** スマホ窓の HUD（headless-splatoon.mjs と同じ形。main.ts は 08 のコピーなので HUD も同じ） */
function parseHud(hud) {
  const g = hud.match(/game: phase=(\S+) left=(\S+) color=(\S+) players=(\S*) scores=(\S*) total=(\d+) shots=(\d+)\/(\d+)/);
  const scores = {};
  for (const m of (g?.[5] ?? "").matchAll(/(p\d+):(\d+)/g)) scores[m[1]] = Number(m[2]);
  const self = hud.match(/self=\(([^)]*)\)/)?.[1].split(",").map(Number);
  return {
    me: hud.match(/\bme=(\S+)/)?.[1] ?? "-",
    marker: hud.match(/marker=(\S+)/)?.[1] ?? "",
    markerIds: new Set((hud.match(/marker=id=([\d+]+)/)?.[1] ?? "").split("+").filter(Boolean).map(Number)),
    spread: Number(hud.match(/spread=([\d.]+)m/)?.[1] ?? 0),
    tracking: /marker=id=/.test(hud) && !/holding last pose/.test(hud),
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
/** 画面マーカーの HUD（screen: room=check me=p3 ws=open joined=true phase=practice pxPerMm=2.000 board=1280x720 mode=multi markerMm=80/80 max=86 clamped=0 tiles=... layout=1:wall,... room=... applies=1 ...） */
function parseScreenHud(hud) {
  return {
    me: hud.match(/\bme=(\S+)/)?.[1] ?? "-",
    // 拒否の理由は空白を含む（"ws=error: room ... joined=false"）
    ws: hud.match(/ws=(.*?) joined=/)?.[1] ?? "",
    joined: /joined=true/.test(hud),
    phase: hud.match(/phase=(\S+)/)?.[1] ?? "",
    pxPerMm: Number(hud.match(/pxPerMm=([\d.]+)/)?.[1] ?? NaN),
    board: hud.match(/board=(\S+)/)?.[1] ?? "",
    mode: hud.match(/mode=(\S+)/)?.[1] ?? "",
    markerMm: Number(hud.match(/markerMm=([\d.]+)\//)?.[1] ?? NaN),
    roomMm: Number(hud.match(/markerMm=[\d.]+\/([\d.]+)/)?.[1] ?? NaN),
    max: Number(hud.match(/max=(\d+)/)?.[1] ?? NaN),
    clamped: hud.match(/clamped=(\d)/)?.[1] === "1",
    tiles: (hud.match(/tiles=(\S+)/)?.[1] ?? "").split(";").filter(Boolean),
    layout: hud.match(/layout=(\S+)/)?.[1] ?? "",
    room: hud.match(/\broom=(\S+) applies/)?.[1] ?? "",
    applies: Number(hud.match(/applies=(\d+)/)?.[1] ?? -1),
    pending: hud.match(/pending=(\d)/)?.[1] === "1",
    blocked: hud.match(/blocked=(\d)/)?.[1] === "1",
    sizeWarn: hud.match(/sizeWarn=(\d)/)?.[1] === "1",
    ruler: Number(hud.match(/ruler=([\d.]+)/)?.[1] ?? NaN),
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
  const version = await cdpJson("/json/version");
  const browser = new Page(version.webSocketDebuggerUrl, "browser");
  await browser.ready();
  const newPage = async (name) => {
    const created = await browser.send("Target.createTarget", { url: "about:blank", newWindow: true });
    const t = (await cdpJson("/json")).find((x) => x.id === created.result.targetId);
    const page = await openPage(t, name);
    page.targetId = created.result.targetId;
    return page;
  };

  // ---- 丸める設定で空の room に開く（ウィンドウ C）: 接続せず、反映ボタンは disabled ----
  const CLAMP_ROOM = "clampcheck";
  const pC = await newPage("C");
  await pC.send("Emulation.setDeviceMetricsOverride", { width: BOARD_W, height: BOARD_H, deviceScaleFactor: 1, mobile: false });
  await pC.send("Page.navigate", { url: `${BASE}markers-screen.html?room=${CLAMP_ROOM}&pxPerMm=${PX_PER_MM}&mode=multi&count=4&markerMm=150` });
  const readClamp = async () => parseScreenHud((await pC.eval("document.querySelector('#hud')?.textContent")) ?? "");
  const tC = Date.now();
  let hc = await readClamp();
  while (Date.now() - tC < 20000 && hc.tiles.length === 0) {
    await sleep(300);
    hc = await readClamp();
  }
  await sleep(3000);
  hc = await readClamp();
  const clampHintC = (await pC.eval("document.querySelector('#marker-hint')?.textContent")) ?? "";
  const clampColor = await pC.eval("getComputedStyle(document.querySelector('#marker-hint')).color");
  console.log(`clamp-open: ws=${hc.ws} joined=${hc.joined} markerMm=${hc.markerMm}/${hc.roomMm} max=${hc.max} clamped=${hc.clamped} blocked=${hc.blocked} hint=${clampHintC.slice(0, 60)} color=${clampColor}`);
  check("丸める設定（multi 4 枚・150mm・最大 86mm）で空の room に開くと接続しない（サーバーに入室の記録が無い）", hc.clamped && hc.blocked && !hc.joined && hc.max === 86 && !serverLines.some((l) => l.includes(`"${CLAMP_ROOM}"`)), `joined=${hc.joined} ws=${hc.ws}`);
  check("その間「room に反映」は disabled で、パネルに赤で「一辺 150mm は画面に収まりません。86mm 以下にするか、1 枚モードにしてください」", (await pC.eval("document.querySelector('#apply').disabled")) === true && clampHintC.includes("一辺 150mm は画面に収まりません。86mm 以下にするか、1 枚モードにしてください") && clampColor === "rgb(242, 139, 130)", clampColor);
  // 表示領域を広げる（resize）→ 2560x1440 なら最大 173mm で収まる → 接続する
  await pC.send("Emulation.setDeviceMetricsOverride", { width: 2560, height: 1440, deviceScaleFactor: 1, mobile: false });
  const tW = Date.now();
  hc = await readClamp();
  while (Date.now() - tW < 15000 && !hc.joined) {
    await sleep(300);
    hc = await readClamp();
  }
  check("resize で収まるようになると丸めをやめて接続する（2560x1440 で最大 173mm）", hc.joined && !hc.clamped && !hc.blocked && hc.max === 173 && hc.markerMm === 150, `joined=${hc.joined} max=${hc.max}`);
  await pC.send("Emulation.setDeviceMetricsOverride", { width: BOARD_W, height: BOARD_H, deviceScaleFactor: 1, mobile: false });
  await sleep(1500);
  hc = await readClamp();
  check("resize で再び収まらなくなると切断して反映できない", !hc.joined && hc.clamped && hc.blocked && (await pC.eval("document.querySelector('#apply').disabled")) === true, `joined=${hc.joined} ws=${hc.ws}`);
  await browser.send("Target.closeTarget", { targetId: pC.targetId });

  // ---- 画面マーカー（ウィンドウ S）。先に開いて画面上の配置を読み、同じ配置をフェイクカメラに描く ----
  const pS = await openPage(first, "S");
  await pS.send("Emulation.setDeviceMetricsOverride", { width: BOARD_W, height: BOARD_H, deviceScaleFactor: 1, mobile: false });
  await pS.send("Page.navigate", { url: SCREEN });
  const readScreen = async () => parseScreenHud((await pS.eval("document.querySelector('#hud')?.textContent")) ?? "");
  const tS = Date.now();
  let hs = await readScreen();
  while (Date.now() - tS < 30000 && !(hs.joined && hs.tiles.length > 0)) {
    await sleep(300);
    hs = await readScreen();
  }
  console.log(`screen: joined=${hs.joined} me=${hs.me} board=${hs.board} pxPerMm=${hs.pxPerMm} markerMm=${hs.markerMm}/${hs.roomMm} max=${hs.max} tiles=${hs.tiles.join(" ")} layout=${hs.layout}`);
  check("画面マーカーが room に入る（役割 overview）", hs.joined && hs.me.startsWith("p") && hs.phase === "practice", `${hs.me} ${hs.ws} ${hs.phase}`);
  check("?pxPerMm=2 と ?markerMm=80 がそのまま使われ、丸めていない（最大 86mm）", hs.pxPerMm === 2 && hs.markerMm === 80 && hs.roomMm === 80 && !hs.clamped && hs.max === 86, `${hs.pxPerMm} ${hs.markerMm} max=${hs.max}`);
  check("原点 + 追加 4 枚のタイル", hs.tiles.length === 5, hs.tiles.join(" "));
  const [bw, bh] = await pS.eval("[innerWidth, innerHeight]");
  check("表示領域は 1280x720（Emulation で固定）", bw === BOARD_W && bh === BOARD_H, `${bw}x${bh}`);
  const tiles = await pS.eval("window.__screenMarkers.tiles()");
  const placements = await pS.eval("window.__screenMarkers.placements()");
  console.log(`screen: board ${bw}x${bh} placements=${JSON.stringify(placements)}`);
  check("原点（ID 0）は表示領域の中央", tiles[0].id === 0 && tiles[0].origin && Math.abs(tiles[0].cx - bw / 2) < 0.5 && Math.abs(tiles[0].cy - bh / 2) < 0.5, `${tiles[0].cx},${tiles[0].cy} vs ${bw / 2},${bh / 2}`);
  const domSizes = await pS.eval(`Array.from(document.querySelectorAll('#board .tile')).map((el) => { const r = el.getBoundingClientRect(); const svg = el.querySelector('svg').getBoundingClientRect(); return { id: el.dataset.id, w: r.width, h: r.height, svgW: svg.width, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; })`);
  console.log(`screen: DOM ${JSON.stringify(domSizes.map((d) => `${d.id}:${d.w.toFixed(0)}x${d.h.toFixed(0)}@(${d.cx.toFixed(0)},${d.cy.toFixed(0)})`))}`);
  check("DOM の各タイルは余白込み 200px（黒い正方形 160px = 80mm × 2px/mm × 10/8）で描かれている", domSizes.length === 5 && domSizes.every((d) => Math.abs(d.w - 200) < 1 && Math.abs(d.h - 200) < 1 && Math.abs(d.svgW - 200) < 1), JSON.stringify(domSizes.map((d) => d.w)));
  check("DOM のタイルの中心が計算どおりの位置（左右 ±232px・上下 ±232px）", domSizes.every((d) => { const t = tiles.find((x) => String(x.id) === d.id); return t && Math.abs(d.cx - t.cx) < 1 && Math.abs(d.cy - t.cy) < 1; }) && Math.abs(domSizes[1].cx - (bw / 2 - 232)) < 1 && Math.abs(domSizes[3].cy - (bh / 2 - 232)) < 1);
  check("配置は 4 枚とも正面の壁（wall）で、画面上の px 差 ÷ 2 = ±0.116m", placements.length === 4 && placements.every((p) => p.face === "wall") && placements[0].pos[0] === -0.116 && placements[1].pos[0] === 0.116 && placements[2].pos[1] === 0.116 && placements[3].pos[1] === -0.116, JSON.stringify(placements));
  const expectedLayout = placements.map((p) => `${p.id}:${p.face}`).join(",");
  // 較正線: 100mm × 2 px/mm = 200 CSS px。タイル（余白込み）に重ならない
  const rulerBox = await pS.eval(`(() => { const r = document.querySelector('#ruler'); const bar = r.querySelector('.bar').getBoundingClientRect(); const box = r.getBoundingClientRect(); const tiles = Array.from(document.querySelectorAll('#board .tile')).map((el) => el.getBoundingClientRect()); const overlap = tiles.some((t) => box.left < t.right && box.right > t.left && box.top < t.bottom && box.bottom > t.top); return { hidden: r.hidden, vertical: r.classList.contains('vertical'), barW: bar.width, barH: bar.height, left: box.left, top: box.top, right: box.right, bottom: box.bottom, overlap, text: r.textContent }; })()`);
  console.log(`ruler: ${JSON.stringify(rulerBox)}`);
  const rulerLen = rulerBox.vertical ? rulerBox.barH : rulerBox.barW;
  check("較正線が 100mm × 2 px/mm = 200 CSS px で描かれ、両端の目盛りと「定規を当てて 100mm か確かめる」がある", !rulerBox.hidden && Math.abs(rulerLen - 200) < 0.5 && hs.ruler === 200 && /定規を当てて 100mm か確かめる/.test(rulerBox.text), `len=${rulerLen} hud=${hs.ruler}`);
  check("較正線は画面内で、マーカーの余白に重ならない", !rulerBox.overlap && rulerBox.left >= 0 && rulerBox.top >= 0 && rulerBox.right <= bw && rulerBox.bottom <= bh, JSON.stringify(rulerBox));
  check("画面の実寸（1280 px ÷ 2 = 640mm）は範囲内で警告しない", !hs.sizeWarn);
  check("反映前: room の配置は空で「room に反映」が押せる", hs.room === "-" && hs.applies === 0 && (await pS.eval("!document.querySelector('#apply').disabled")) === true, `room=${hs.room}`);

  // ---- スマホ窓 1・2（フェイクカメラに画面と同じ配置を描く）+ 俯瞰画面 ----
  const fakeMarkers = placements.map((p) => `${p.id}:${p.face}:${p.pos.join(",")}`).join(";");
  const p1 = await newPage("1");
  await p1.send("Page.navigate", { url: `${BASE}?${COMMON}&name=One&fakeMarkers=${encodeURIComponent(fakeMarkers)}` });
  const p2 = await newPage("2");
  await p2.send("Page.navigate", { url: `${BASE}?${COMMON}&name=Two&fakeShift=40&fakeMarkers=${encodeURIComponent(fakeMarkers)}` });
  const p3 = await newPage("3");
  await p3.send("Page.navigate", { url: OVERVIEW });
  const readHud = async (p) => parseHud((await p.eval("document.querySelector('#hud')?.textContent")) ?? "");
  const readOverview = async () => parseOverviewHud((await p3.eval("document.querySelector('#hud')?.textContent")) ?? "");
  const t0 = Date.now();
  while (Date.now() - t0 < 40000) {
    const [h1, h2, ov] = await Promise.all([readHud(p1), readHud(p2), readOverview()]);
    if (h1.me.startsWith("p") && h2.me.startsWith("p") && h1.marker.startsWith("id=") && h2.marker.startsWith("id=") && ov.me.startsWith("p") && h1.accepted >= 2 && h2.accepted >= 2 && (h1.scores[h1.me] ?? 0) > 0 && (h2.scores[h2.me] ?? 0) > 0) break;
    await sleep(500);
  }
  console.log(`両ウィンドウの入室 + マーカー検出 + 発射まで ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const show = (h) => `me=${h.me} marker=${h.marker} phase=${h.phase} color=${h.color} players=${h.players.join("|")} scores=${JSON.stringify(h.scores)}/${h.total} shots=${h.sent}/${h.accepted} layout=${h.layout}`;
  const pr1 = await readHud(p1);
  const pr2 = await readHud(p2);
  const prOv = await readOverview();
  console.log(`practice window1: ${show(pr1)}`);
  console.log(`practice window2: ${show(pr2)}`);
  check("両ウィンドウでマーカーが検出されている", pr1.marker.startsWith("id=") && pr2.marker.startsWith("id="), `${pr1.marker} / ${pr2.marker}`);
  check("両方が同じ room に入り 2 人（画面マーカーと俯瞰画面はプレイヤーではない）", pr1.players.length === 2 && pr2.players.length === 2 && prOv.players.length === 2 && !pr1.players.some((p) => p.startsWith(hs.me + ":")), `${pr1.players.join("|")} screen=${hs.me}`);
  check("個人戦: 別の色が割り当たっている", pr1.color > 0 && pr2.color > 0 && pr1.color !== pr2.color, `${pr1.color} vs ${pr2.color}`);
  check("入室直後は練習（practice）で連射が受理され、得点が入る（スマホ側は 08 のまま）", pr1.phase === "practice" && pr1.accepted >= 2 && pr2.accepted >= 2 && (pr1.scores[pr1.me] ?? 0) > 0 && (pr2.scores[pr2.me] ?? 0) > 0, `${pr1.sent}/${pr1.accepted}, ${pr2.sent}/${pr2.accepted} ${JSON.stringify(pr1.scores)}`);
  check("配置を配る前は原点だけで位置合わせ（映っている追加マーカーは無視）", pr1.markerIds.size === 1 && pr1.markerIds.has(0) && pr1.layout === "-", `${pr1.marker} layout=${pr1.layout}`);
  const selfBefore = pr1.self;

  // ---- 画面マーカーの「room に反映」→ 全員に同じ配置が届く ----
  await pS.eval("document.querySelector('#apply').click()");
  await sleep(2500);
  const ap = await readScreen();
  const apOv = await readOverview();
  const ap1 = await readHud(p1);
  const ap2 = await readHud(p2);
  console.log(`applied screen: applies=${ap.applies} pending=${ap.pending} room=${ap.room}`);
  console.log(`applied overview: markers=${apOv.markers} markersSent=${apOv.markersSent} peerMarkers=${JSON.stringify(apOv.peerMarkers)}`);
  console.log(`applied window1: ${show(ap1)}`);
  check("画面マーカーの反映が送られ、サーバーが受理して記録している", ap.applies === 1 && !ap.pending && ap.room === expectedLayout && serverLines.some((l) => new RegExp(`markers → ${expectedLayout.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(l)), `applies=${ap.applies} room=${ap.room}`);
  check("俯瞰画面・スマホ窓 1・2 に同じ配置（layout=）が届く（俯瞰画面は送っていない: markersSent=0）", ap1.layout === expectedLayout && ap2.layout === expectedLayout && apOv.markers === expectedLayout && apOv.markersSent === 0, `${ap1.layout} / ${ap2.layout} / ${apOv.markers}`);
  const applyHint = await pS.eval("document.querySelector('#apply-hint')?.textContent");
  check("反映後は「room の配置はこの画面と同じ」になり、ボタンは押せない", /同じ/.test(applyHint ?? "") && (await pS.eval("document.querySelector('#apply').disabled")) === true, applyHint);
  const overviewRows = await p3.eval(`Array.from(document.querySelectorAll('#marker-rows .row')).filter((r) => r.querySelector('input[type=checkbox]').checked).map((r) => Array.from(r.querySelectorAll('input[type=number]')).map((i) => i.valueAsNumber).join(','))`);
  check("俯瞰画面の「追加マーカーの配置」の行に画面の配置（ID, X, Y, Z）が入る", Array.isArray(overviewRows) && overviewRows.length === 4 && overviewRows.includes("1,-0.116,0,0") && overviewRows.includes("3,0,0.116,0"), JSON.stringify(overviewRows));

  // ---- 複数枚が同時に使われ、spread が小さい ----
  await sleep(WAIT_SEC * 1000);
  let mk1 = await readHud(p1);
  const tMk = Date.now();
  while (Date.now() - tMk < 10000 && mk1.markerIds.size < 3) {
    await sleep(300);
    mk1 = await readHud(p1);
  }
  const mk2 = await readHud(p2);
  const mkOv = await readOverview();
  console.log(`multi window1: marker=${mk1.marker} ids=${[...mk1.markerIds]} spread=${mk1.spread} self=${JSON.stringify(mk1.self)} (before ${JSON.stringify(selfBefore)})`);
  console.log(`multi window2: marker=${mk2.marker} ids=${[...mk2.markerIds]} spread=${mk2.spread}`);
  check("ウィンドウ 1 は原点 + 画面の追加マーカーを 3 枚以上同時に使って位置合わせしている", mk1.markerIds.size >= 3 && mk1.markerIds.has(0), mk1.marker);
  check("複数枚から出した原点の位置のばらつき（spread）が 8cm 未満（画面の配置とフェイクカメラの幾何が一致）", mk1.markerIds.size >= 2 && mk1.spread < 0.08, `spread=${mk1.spread}`);
  const selfDrift = selfBefore && mk1.self ? Math.hypot(...selfBefore.map((v, i) => v - mk1.self[i])) : Infinity;
  check("配置を配っても自分の位置（self）が 5cm 以上動かない（追加マーカーが原点と矛盾しない）", selfDrift < 0.05, `drift=${selfDrift.toFixed(3)}m`);
  check("ウィンドウ 2 も複数枚で位置合わせしている", mk2.markerIds.size >= 2 && mk2.markerIds.has(0), mk2.marker);
  check("俯瞰画面の一覧に各プレイヤーが使っている複数の ID が出る", /\+/.test(mkOv.peerMarkers[mk1.me] ?? ""), JSON.stringify(mkOv.peerMarkers));
  check("配置を配っても塗りは消えず、練習のまま連射が受理され続けている", mk1.phase === "practice" && mk1.accepted > pr1.accepted && (mk1.scores[mk1.me] ?? 0) >= (pr1.scores[pr1.me] ?? 0), `${pr1.accepted} → ${mk1.accepted}`);
  // 原点を隠す → 画面の追加マーカーだけで追跡が続く
  await p1.eval("window.__fakeMarkers.hidden.add(0)");
  await sleep(1500);
  const hid1 = await readHud(p1);
  console.log(`hidden-origin window1: marker=${hid1.marker} self=${JSON.stringify(hid1.self)}`);
  check("原点を隠しても画面の追加マーカーだけで位置合わせが続く", hid1.tracking && hid1.markerIds.size >= 1 && !hid1.markerIds.has(0), hid1.marker);
  const hidDrift = selfBefore && hid1.self ? Math.hypot(...selfBefore.map((v, i) => v - hid1.self[i])) : Infinity;
  check("追加マーカーだけになっても自分の位置が 8cm 以上動かない", hidDrift < 0.08, `drift=${hidDrift.toFixed(3)}m`);
  await p1.eval("window.__fakeMarkers.hidden.delete(0)");

  // ---- 画面マーカーの表示の切り替え（単一モード・丸め）。room の一辺は変えない ----
  await pS.eval("(() => { const s = document.querySelector('#mode'); s.value = 'single'; s.dispatchEvent(new Event('input')); })()");
  await sleep(300);
  const single = await readScreen();
  const singleDom = await pS.eval("Array.from(document.querySelectorAll('#board .tile')).map((el) => el.dataset.id)");
  console.log(`single: tiles=${single.tiles.join(" ")} max=${single.max} layout=${single.layout} dom=${JSON.stringify(singleDom)}`);
  check("単一モードにすると原点 1 枚だけを中央に描き、最大は 288mm に増える", single.mode === "single" && single.tiles.length === 1 && singleDom.length === 1 && singleDom[0] === "0" && single.max === 288 && single.layout === "-", `tiles=${single.tiles.length} max=${single.max}`);
  check("単一モードの配置（原点だけ）は room と違うので「room に反映」が押せる（押すと追加マーカーが消える）", (await pS.eval("!document.querySelector('#apply').disabled")) === true);
  await pS.eval("(() => { const i = document.querySelector('#marker-mm'); i.value = '5000'; i.dispatchEvent(new Event('input')); })()");
  await sleep(300);
  const big = await readScreen();
  const bigDom = await pS.eval("(() => { const r = document.querySelector('#board .tile').getBoundingClientRect(); return [r.width, r.height]; })()");
  console.log(`clamped: markerMm=${big.markerMm}/${big.roomMm} clamped=${big.clamped} blocked=${big.blocked} joined=${big.joined} dom=${JSON.stringify(bigDom)}`);
  check("収まらない一辺（5000mm）は最大 288mm に丸めて描き（余白込み 720px）、HUD に clamped=1", big.clamped && big.markerMm === 288 && Math.abs(bigDom[0] - 720) < 1, `${big.markerMm} ${bigDom}`);
  const clampHint = await pS.eval("document.querySelector('#marker-hint')?.textContent");
  check("丸めたことをパネルに出す（1 枚モードなので「1 枚モードに」とは言わない）", (clampHint ?? "").startsWith("一辺 5000mm は画面に収まりません。288mm 以下にするか") && !/1 枚モードに/.test(clampHint ?? ""), (clampHint ?? "").slice(0, 80));
  // 丸めている間は切断し、入力が落ち着いても（5000mm で）入り直さない
  await sleep(2000);
  const blockedS = await readScreen();
  console.log(`blocked: ws=${blockedS.ws} joined=${blockedS.joined} blocked=${blockedS.blocked}`);
  check("丸めている間は切断し、入力が落ち着いても入り直さない（サーバーに markerMm=5000 の入室が来ない）", !blockedS.joined && blockedS.blocked && (await pS.eval("document.querySelector('#apply').disabled")) === true && !serverLines.some((l) => /markerMm=5000/.test(l)), `${blockedS.ws}`);
  // 収まるが room と違う一辺（200mm）→ 入力が落ち着く（600ms）と新しい値で入り直す → room（80mm）と食い違うのでサーバーが拒否し、案内が出る
  await pS.eval("(() => { const i = document.querySelector('#marker-mm'); i.value = '200'; i.dispatchEvent(new Event('input')); })()");
  await sleep(2500);
  const mismatch = await readScreen();
  const mismatchHint = await pS.eval("document.querySelector('#apply-hint')?.textContent");
  console.log(`mismatch: ws=${mismatch.ws} joined=${mismatch.joined} hint=${(mismatchHint ?? "").slice(0, 60)}`);
  check("一辺を room と違う（収まる）値に変えると入り直してサーバーに拒否され、「全員の URL に ?markerMm= を付けて入り直す」案内が出る", !mismatch.joined && !mismatch.clamped && /設定と不一致/.test(mismatch.ws) && /markerMm/.test(mismatchHint ?? "") && serverLines.some((l) => /設定と不一致.*markerMm=200/.test(l)), `${mismatch.ws} / ${mismatchHint}`);
  check("入力が落ち着く前の古い一辺（5000mm）では入り直していない", !serverLines.some((l) => /markerMm=5000/.test(l)));
  // 元に戻す → 80mm で入り直し（id は新しくなる）、配置は同じに戻る
  await pS.eval("(() => { const i = document.querySelector('#marker-mm'); i.value = '80'; i.dispatchEvent(new Event('input')); const s = document.querySelector('#mode'); s.value = 'multi'; s.dispatchEvent(new Event('input')); })()");
  const tBack = Date.now();
  let back = await readScreen();
  while (Date.now() - tBack < 10000 && !back.joined) {
    await sleep(300);
    back = await readScreen();
  }
  console.log(`back: me=${back.me} joined=${back.joined} markerMm=${back.markerMm}/${back.roomMm} layout=${back.layout} room=${back.room}`);
  check("元に戻すと 80mm で入り直し、同じ配置に戻る（room の配置は反映したまま）", back.joined && back.me !== hs.me && back.roomMm === 80 && back.tiles.length === 5 && back.layout === expectedLayout && back.room === expectedLayout, `me=${back.me} (was ${hs.me})`);
  check("白黒の反転は載せていない（今の検出器では検出できない）", (await pS.eval("document.querySelector('#invert') === null")) === true);

  // ---- 対戦開始（俯瞰画面のボタン）→ 両方が得点 ----
  await p3.eval("document.querySelector('#start-match').click()");
  await sleep(PLAY_WAIT_SEC * 1000);
  const hud1 = await readHud(p1);
  const hud2 = await readHud(p2);
  const hudOv = await readOverview();
  console.log(`play window1: ${show(hud1)}`);
  console.log(`play window2: ${show(hud2)}`);
  check("俯瞰画面の start で試合（play）になっている", hudOv.starts === 1 && hud1.phase === "play" && hud2.phase === "play" && hudOv.phase === "play");
  check("両プレイヤーが試合で得点している（着弾と塗りが field 座標で合っている）", (hud1.scores[hud1.me] ?? 0) > 0 && (hud2.scores[hud2.me] ?? 0) > 0, JSON.stringify(hud1.scores));
  check("両ウィンドウで連射が受理され続けている", hud1.accepted > mk1.accepted && hud2.accepted > mk2.accepted, `${mk1.accepted} → ${hud1.accepted}, ${mk2.accepted} → ${hud2.accepted}`);
  const diff = Object.keys({ ...hud1.scores, ...hud2.scores }).reduce((a, k) => a + Math.abs((hud1.scores[k] ?? 0) - (hud2.scores[k] ?? 0)), 0);
  check("両ウィンドウの HUD でほぼ同じ得点が見えている", diff <= Math.max(200, hud1.total * 0.02), `${JSON.stringify(hud1.scores)} vs ${JSON.stringify(hud2.scores)}`);
  const hits = landings.filter((l) => l.where !== "miss");
  check("着弾のほとんどが壁か床に当たっている", landings.length >= 6 && hits.length > landings.length / 2, `${hits.length}/${landings.length} hit`);
  check("試合中は画面マーカーの「room に反映」が押せない（配置を変えても）", (await readScreen()).phase === "play" && (await pS.eval("document.querySelector('#apply').disabled")) === true);
  check("例外が出ていない", [p1, p2, p3, pS].every((p) => p.exceptions.length === 0), [p1, p2, p3, pS].flatMap((p) => p.exceptions).slice(0, 2).join(" | "));
  for (const l of pS.logs.filter((l) => l.startsWith("[screen]")).slice(0, 4)) console.log(`screen log: ${l}`);

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
