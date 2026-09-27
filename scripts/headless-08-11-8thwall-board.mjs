// demos/08-11-splatoon-8thwall-board（8th Wall SLAM + OpenCV board + 窓平均）のブラウザ経路をヘッドレス Chrome で確認する。
// `npm run check:8thwall-board` で実行する。仕組みは headless-08-10-8thwall.mjs と同じ（CDP を ws で直接叩く。Chrome が無ければスキップ）。
// PC では実 SLAM が動かないので、?fakecam=1&fakexr=1 で window.XR8 にモック（fake-xr8.ts）を差し込み、実機と同じ startXrSource() を通す:
//   1. A・B（?fakexr=1）: 入室・xr=NORMAL・OpenCV が実際に使われている（det=opencv）・relock=ready・コートが出る・練習で連射が受理され得点。
//      俯瞰画面に 2 人と peerMarkers
//   2. 追従: 原点マーカーを隠して合成カメラを動かすと、8th Wall の姿勢でコートが留まり self= が合成カメラに追従、連射も続く
//   3. LIMITED（08-10 と逆）: コートが消えず relock=ready のまま、発射も続く。LIMITED 中も「いまの姿勢」を送る（self= が追従し、B で stale にならない）。
//      送る tracking は false（B で lost）。1 秒以上続くと直接モード（avg=direct）。NORMAL に戻っても再ロック不要（relock=required を経由しない）。
//      1 秒未満の LIMITED では窓を捨てない（ign= が増え direct= は増えない）
//   4. 姿勢欠損・不正 intrinsics・例外: どれも再ロック不要でコートが出たまま。例外は画面の主表示に出る
//   5. main スレッドの停止・映像停止（repeatFrame）: 再ロック不要（姿勢の鮮度切れで invalidate しない）
//   6. 端末の向き変更・映像サイズ変更・ウィンドウ resize・タブ復帰・bfcache 復帰: 再ロックが要求され、マーカーを見ると戻る（inv= に原因別の回数）
//   7. 実バイナリ（/vendor/8thwall/）の配信と読み込みの smoke・先行読み込み（08-10 と同じ）
//   8. ぶれの比較: 合成映像を描くカメラだけにノイズ（?fakeMarkerNoise=）+ 8th Wall のモックの姿勢にもノイズ（?fakeXrNoise=）を入れ、
//      ?avg=1 と ?avg=0 でアンカー（コートのワールド位置）と self=（field 座標系の自分の位置）の変動を数値で比べる
//   9. logs/client.log に A の snapshot（xr= … avg= …）とイベント（[08-11] event=…）が書かれている
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
// 5173 / 5210 は手動の dev server、5213 は 08-10 の確認が使うので避ける（PORT / CDP_PORT で変更可）
const PORT = Number(process.env.PORT ?? "") || 5214;
const CDP_PORT = Number(process.env.CDP_PORT ?? "") || 9354;
const ORIGIN = `https://localhost:${PORT}`;
const BASE = `${ORIGIN}/demos/08-11-splatoon-8thwall-board/`;
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLIENT_LOG = join(ROOT, "logs", "client.log");
// markerMm=100 / fakeMarkerPx=80: 08-10 の確認と同じ幾何（合成カメラは原点マーカーの正面 0.74m）
const MARKER_MM = 100;
const ROOM = "check-8thwall-board";
const ROOM_REAL = "check-8thwall-board-real";
const ROOM_NOISE = "check-8thwall-board-noise";
// 実機ログ（logs/client.log）はユーザーの実機確認と同じファイルなので、書くのは A だけにする（他は ?remoteLog=0）
const COMMON = `fov=70&camZoom=1&fakecam=1&fakexr=1&autostart=1&fakehands=1&fakeMarkerPx=80&handSmooth=1&room=${ROOM}&waitSec=1&markerMm=${MARKER_MM}`;
const START_POS = [0, 0, 0.74];
const TEST_START_ISO = new Date().toISOString();

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
const dist = (a, b) => (a && b ? Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) : Infinity);

const server = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], { stdio: ["ignore", "pipe", "pipe"] });
server.stderr.on("data", (d) => process.stderr.write(d));
server.stdout.on("data", () => {});
let serverExited = false;
server.on("exit", () => {
  serverExited = true;
});
async function waitForServer(timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (serverExited) return false;
    const res = await fetch(BASE).catch(() => null);
    if (res?.ok) return true;
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
    this.waiters = [];
    this.logs = [];
    this.exceptions = [];
    this.responses = [];
    this.ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      if (m.id && this.pending.has(m.id)) {
        this.pending.get(m.id)(m);
        this.pending.delete(m.id);
        return;
      }
      if (m.method === "Runtime.consoleAPICalled") {
        this.logs.push(m.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
      } else if (m.method === "Runtime.exceptionThrown") {
        this.exceptions.push(`${m.params.exceptionDetails.text} ${m.params.exceptionDetails.exception?.description ?? ""}`);
      } else if (m.method === "Network.responseReceived") {
        const r = m.params.response;
        this.responses.push({ url: r.url, status: r.status, mime: r.mimeType });
      } else if (m.method === "Network.loadingFailed") {
        this.responses.push({ url: m.params.requestId, status: -1, mime: m.params.errorText });
      }
      for (const w of [...this.waiters]) {
        if (w.method === m.method) {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          w.resolve(m.params);
        }
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
  waitEvent(method, timeoutMs = 20000) {
    return new Promise((resolve) => {
      const w = { method, resolve };
      this.waiters.push(w);
      setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) {
          this.waiters.splice(i, 1);
          resolve(null);
        }
      }, timeoutMs);
    });
  }
  async eval(expr) {
    const r = await this.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result?.result?.value ?? null;
  }
}

async function cdpJson(path) {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}${path}`);
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

/** HUD を読む（08 の行 + 08-11 の xr= / det= / avg= / inv= / jump= 行） */
function parseHud(hud) {
  const g = hud.match(/game: phase=(\S+) left=(\S+) color=(\S+) players=(\S*) scores=(\S*) total=(\d+) shots=(\d+)\/(\d+)/);
  const scores = {};
  for (const m of (g?.[5] ?? "").matchAll(/(p\d+):(\d+)/g)) scores[m[1]] = Number(m[2]);
  const self = hud.match(/self=\(([^)]*)\)/)?.[1].split(",").map(Number);
  const xrLine = hud.match(/^xr=.*$/m)?.[0] ?? "";
  const avgLine = hud.match(/^avg=.*$/m)?.[0] ?? "";
  const invLine = hud.match(/inv=(\S+)/)?.[1] ?? "";
  const inv = {};
  for (const m of invLine.matchAll(/(\w+):(\d+)/g)) inv[m[1]] = Number(m[2]);
  const peerTracking = {};
  for (const m of (hud.match(/peerTracking=(\S+)/)?.[1] ?? "").matchAll(/(p\d+):(\w+)/g)) peerTracking[m[1]] = m[2];
  return {
    raw: hud,
    mode: hud.match(/\bmode=(\S+)/)?.[1] ?? "",
    me: hud.match(/\bme=(\S+)/)?.[1] ?? "-",
    cam: hud.match(/^cam=.*$/m)?.[0] ?? "",
    marker: hud.match(/^marker=(\S+)/m)?.[1] ?? "",
    markerLine: hud.match(/^marker=.*$/m)?.[0] ?? "",
    det: hud.match(/^det=(\S+)/m)?.[1] ?? "",
    detLine: hud.match(/^det=.*$/m)?.[0] ?? "",
    fallback: /^!! FALLBACK/m.test(hud),
    self: self && self.length === 3 && self.every(Number.isFinite) ? self : null,
    xrLine,
    xr: xrLine.match(/^xr=(\S+)/)?.[1] ?? "",
    relock: xrLine.match(/relock=(\S+)/)?.[1] ?? "",
    sq: Number(xrLine.match(/ sq=([\d.]+)/)?.[1] ?? NaN),
    avgLine,
    avgMode: avgLine.match(/^avg=(\S+)/)?.[1] ?? "",
    avgN: Number(avgLine.match(/ n=(\d+)/)?.[1] ?? NaN),
    ign: Number(avgLine.match(/ ign=(\d+)/)?.[1] ?? NaN),
    direct: Number(avgLine.match(/ direct=(\d+)/)?.[1] ?? NaN),
    inv,
    jumpLine: hud.match(/^jump=.*$/m)?.[0] ?? "",
    peerTracking,
    phase: g?.[1] ?? "",
    scores,
    sent: g ? Number(g[7]) : -1,
    accepted: g ? Number(g[8]) : -1,
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
      "--use-fake-device-for-media-stream",
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
  const pA = await openPage(targets.find((t) => t.type === "page"), "A");
  const version = await cdpJson("/json/version");
  const browser = new Page(version.webSocketDebuggerUrl, "browser");
  await browser.ready();
  async function newWindow(name) {
    const created = await browser.send("Target.createTarget", { url: "about:blank", newWindow: true });
    const t = (await cdpJson("/json")).find((x) => x.id === created.result.targetId);
    const page = await openPage(t, name);
    page.targetId = t.id;
    return page;
  }
  await pA.send("Page.navigate", { url: `${BASE}?${COMMON}&name=BoardA` });
  const pB = await newWindow("B");
  await pB.send("Page.navigate", { url: `${BASE}?${COMMON}&name=BoardB&remoteLog=0` });
  // C: 実バイナリ。fakecam 無し（Chrome のフェイクデバイスでカメラ自体は開ける）。別 room で A・B の対戦に混ぜない
  const pC = await newWindow("C");
  await pC.send("Network.enable");
  const tC0 = Date.now();
  await pC.send("Page.navigate", { url: `${BASE}?fakehands=1&autostart=1&name=Real&room=${ROOM_REAL}&remoteLog=0` });
  const pO = await newWindow("O");
  await pO.send("Page.navigate", { url: `${BASE}overview.html?room=${ROOM}&waitSec=1&markerMm=${MARKER_MM}` });
  const pages = [pA, pB, pO];
  const players = [pA, pB];

  const readHud = async (p) => parseHud((await p.eval("document.querySelector('#hud')?.textContent")) ?? "");
  const readOverview = async () => (await pO.eval("document.querySelector('#hud')?.textContent")) ?? "";
  const setCam = (p, pos) => p.eval(`window.__fakeMarkers.camPos = ${JSON.stringify(pos)}; true`);
  const fakeXr = (p, js) => p.eval(`(() => { const x = window.__fakeXr; ${js} })()`);
  const board = (p, js) => p.eval(`(() => { const b = window.__board; ${js} })()`);
  const show = (h) => `me=${h.me} ${h.xrLine} | ${h.detLine} | ${h.avgLine} | ${h.markerLine} | shots=${h.sent}/${h.accepted}`;
  /** HUD の relock= の遷移を記録し始める（MutationObserver で取りこぼさない） */
  const watchRelock = (p) =>
    p.eval(`(() => {
      const hud = document.querySelector('#hud');
      window.__relockSeen?.observer.disconnect();
      const seen = { values: [], lines: [], observer: null };
      const read = () => {
        const m = hud.textContent.match(/relock=(\\w+)/);
        if (m && seen.values.at(-1) !== m[1]) {
          seen.values.push(m[1]);
          seen.lines.push(\`\${performance.now().toFixed(0)} \${hud.textContent.match(/xr=[^\\n]*/)?.[0] ?? ""}\`);
        }
      };
      seen.observer = new MutationObserver(read);
      seen.observer.observe(hud, { childList: true, characterData: true, subtree: true });
      read();
      window.__relockSeen = seen;
      return true;
    })()`);
  const relockSeen = (p) => p.eval("window.__relockSeen?.values ?? []");
  /** コート（anchor.visible）が一度でも消えたかを毎フレーム見張る */
  const watchVisible = (p) =>
    p.eval(`(() => {
      if (window.__visWatch) cancelAnimationFrame(window.__visWatch.raf);
      const w = { hidden: 0, frames: 0, raf: 0 };
      const tick = () => { w.frames++; if (!window.__board.visible()) w.hidden++; w.raf = requestAnimationFrame(tick); };
      w.raf = requestAnimationFrame(tick);
      window.__visWatch = w;
      return true;
    })()`);
  const visibleSeen = (p) => p.eval("({ hidden: window.__visWatch?.hidden ?? -1, frames: window.__visWatch?.frames ?? -1 })");
  /** 条件を満たすまで HUD を読み直す */
  async function waitHud(p, pred, timeoutMs = 10000) {
    const t0 = Date.now();
    let h = await readHud(p);
    while (Date.now() - t0 < timeoutMs && !pred(h)) {
      await sleep(200);
      h = await readHud(p);
    }
    return h;
  }

  // ---- 1. 入室・XR・OpenCV・練習 ----
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    const hs = await Promise.all(players.map(readHud));
    if (hs.every((h) => h.me.startsWith("p") && h.marker.startsWith("id=") && h.relock === "ready" && h.det === "opencv")) break;
    await sleep(500);
  }
  console.log(`A・B の入室 + OpenCV + マーカー検出 + relock=ready まで ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  await sleep(6000);
  const [a0, b0] = await Promise.all([readHud(pA), readHud(pB)]);
  console.log(`A: ${show(a0)}`);
  console.log(`B: ${show(b0)}`);
  check("A・B: HUD の mode=fakexr・avg=1", a0.mode === "fakexr" && b0.mode === "fakexr" && /avg=1 detector=opencv/.test(a0.raw), `${a0.mode}/${b0.mode}`);
  check("A・B: xr=NORMAL", a0.xr === "NORMAL" && b0.xr === "NORMAL", `${a0.xrLine} / ${b0.xrLine}`);
  {
    const backend = await board(pA, "return b.backend();");
    const counters = await board(pA, "return b.counters();");
    check("A・B: OpenCV が実際に使われている（det=opencv・backend=opencv・FALLBACK 表示なし・試行/検出/採用のカウンタが進む）", a0.det === "opencv" && b0.det === "opencv" && backend === "opencv" && !a0.fallback && counters?.attempts > 10 && counters.detectedFrames > 10 && counters.accepts > 10, `${a0.detLine} counters=${JSON.stringify(counters)}`);
  }
  check("A・B: マーカー検出（marker=id=）と relock=ready・コートが出ている（anchor.visible）", a0.marker.startsWith("id=") && b0.marker.startsWith("id=") && a0.relock === "ready" && b0.relock === "ready" && (await board(pA, "return b.visible();")) === true, `${a0.marker} ${a0.relock} / ${b0.marker} ${b0.relock}`);
  check("A・B: 窓平均が働いている（avg=avg n>=10）", a0.avgMode === "avg" && a0.avgN >= 10 && b0.avgN >= 10, a0.avgLine);
  check("A・B: 練習で連射が受理され得点している", a0.phase === "practice" && a0.accepted >= 2 && b0.accepted >= 2 && (a0.scores[a0.me] ?? 0) > 0 && (b0.scores[b0.me] ?? 0) > 0, `${a0.accepted}/${b0.accepted} ${JSON.stringify(a0.scores)}`);
  check("A: HUD の p= に sq=1.000（モックは正方画素）・cam= に映像の実寸とトラック", a0.sq === 1 && /video=640x480 track=/.test(a0.cam), `${a0.xrLine} | ${a0.cam}`);
  const xrInfo = await fakeXr(pA, "return { configured: x.configured, run: { ownRunLoop: x.runOptions?.ownRunLoop, allowedDevices: x.runOptions?.allowedDevices }, projection: x.projection, pre: x.preRenders, post: x.postRenders, canvas: [document.querySelector('#xr-canvas').width, document.querySelector('#xr-canvas').height] };");
  check("A: xr-source が XR8 を scale:absolute・ownRunLoop:false・MOBILE で起動し、runPreRender / runPostRender が毎フレーム呼ばれる", xrInfo?.configured?.scale === "absolute" && xrInfo.run.ownRunLoop === false && xrInfo.run.allowedDevices === "mobile" && xrInfo.pre > 100 && xrInfo.post > 100, JSON.stringify(xrInfo?.run));
  check("A: 投影の pixelRect と XR 用 canvas が映像寸法（640x480）・開始時の投影設定は inv= に数えない", xrInfo?.projection?.cam?.pixelRectWidth === 640 && xrInfo.projection.cam.pixelRectHeight === 480 && xrInfo.canvas[0] === 640 && a0.inv.projection === 0, `${JSON.stringify(xrInfo?.projection)} inv=${JSON.stringify(a0.inv)}`);
  check("A・B: self= が合成カメラの位置（原点の正面 ±5cm）", dist(a0.self, START_POS) < 0.05 && dist(b0.self, START_POS) < 0.05, `${JSON.stringify(a0.self)} / ${JSON.stringify(b0.self)}`);
  {
    const ov = await readOverview();
    const ovPlayers = (ov.match(/players=(\S*)/)?.[1] ?? "").split(",").filter(Boolean);
    const pm = ov.match(/peerMarkers=(\S*)/)?.[1] ?? "";
    check("俯瞰画面: 2 人が見えている", /ws=open/.test(ov) && ovPlayers.length === 2, ov.split("\n")[0].slice(0, 160));
    check("俯瞰画面: peerMarkers に A・B のマーカー ID（0）が出る", new RegExp(`\\b${a0.me}:0\\b`).test(pm) && new RegExp(`\\b${b0.me}:0\\b`).test(pm), `peerMarkers=${pm}`);
  }

  // ---- 2. 追従: 原点マーカーを隠して歩く ----
  await Promise.all([pA.eval("window.__fakeMarkers.hidden.add(0); true"), pB.eval("window.__fakeMarkers.hidden.add(0); true")]);
  await sleep(1000);
  const aHidden = await readHud(pA);
  const acceptedBeforeWalk = aHidden.accepted;
  const walk = [[0.4, 0.1, 1.2], [-0.3, -0.1, 1.6], [0.2, 0.3, 2.0]];
  for (const [i, pos] of walk.entries()) {
    await Promise.all([setCam(pA, pos), setCam(pB, pos)]);
    await sleep(2000);
    const [a, b] = await Promise.all([readHud(pA), readHud(pB)]);
    console.log(`walk${i + 1} A: ${show(a)} 正解=${JSON.stringify(pos)}`);
    check(`歩行 ${i + 1}: A・B はマーカーが見えなくても relock=ready のまま（holding last pose）`, a.relock === "ready" && b.relock === "ready" && /holding last pose/.test(a.markerLine), `${a.relock}/${b.relock} ${a.markerLine}`);
    check(`歩行 ${i + 1}: A・B の self= が合成カメラに追従する（±10cm）`, dist(a.self, pos) < 0.1 && dist(b.self, pos) < 0.1, `A=${JSON.stringify(a.self)} B=${JSON.stringify(b.self)} 正解=${JSON.stringify(pos)}`);
  }
  const aWalk = await readHud(pA);
  check("A: マーカーが見えない間も連射が受理され続ける", aWalk.accepted > acceptedBeforeWalk, `${acceptedBeforeWalk} → ${aWalk.accepted}`);
  await setCam(pB, START_POS);
  await pB.eval("window.__fakeMarkers.hidden.delete(0); true");
  await setCam(pA, START_POS);
  await pA.eval("window.__fakeMarkers.hidden.delete(0); true");
  await sleep(2000);

  // ---- 3. LIMITED: コートを出し続け、発射も止めない ----
  {
    // 3a. 1 秒未満の LIMITED: 窓を捨てない（ign= が増え、direct= は増えない）
    const h0 = await readHud(pA);
    await watchRelock(pA);
    await watchVisible(pA);
    await fakeXr(pA, "x.status = 'LIMITED'; x.reason = 'EXCESSIVE_MOTION'; return true;");
    await sleep(600);
    await fakeXr(pA, "x.status = 'NORMAL'; x.reason = ''; return true;");
    await sleep(800);
    const h1 = await readHud(pA);
    const vis = await visibleSeen(pA);
    const seen = await relockSeen(pA);
    console.log(`短い LIMITED A: ${show(h1)} vis=${JSON.stringify(vis)} relock遷移=${JSON.stringify(seen)}`);
    check("短い LIMITED（0.6 秒）: 観測は使わず（ign= が増える）直接モードに入らない（direct= 同じ）・窓はそのまま続く（avg=avg）", h1.ign > h0.ign && h1.direct === h0.direct && h1.avgMode === "avg" && h1.avgN >= 5, `ign ${h0.ign} → ${h1.ign} direct ${h0.direct} → ${h1.direct} ${h1.avgLine}`);
    check("短い LIMITED: コートは一度も消えず relock=required を経由しない", vis.hidden === 0 && vis.frames > 10 && !seen.includes("required"), `${JSON.stringify(vis)} ${JSON.stringify(seen)}`);

    // 3b. 長い LIMITED（4 秒）
    await watchRelock(pA);
    await watchVisible(pA);
    const hBefore = await readHud(pA);
    await fakeXr(pA, "x.status = 'LIMITED'; x.reason = 'EXCESSIVE_MOTION'; return true;");
    await sleep(1600);
    const aLim = await readHud(pA);
    console.log(`LIMITED A: ${show(aLim)}`);
    check("LIMITED: A の xr=LIMITED・生の trackingReason（EXCESSIVE_MOTION）・relock=ready のまま", aLim.xr === "LIMITED" && /xr=LIMITED EXCESSIVE_MOTION/.test(aLim.xrLine) && aLim.relock === "ready", aLim.xrLine);
    check("LIMITED が 1 秒以上続いてマーカーの観測がある: 直接モード（avg=direct・direct= が増える・窓 n=0）", aLim.avgMode === "direct" && aLim.direct === hBefore.direct + 1 && aLim.avgN === 0, aLim.avgLine);
    // LIMITED 中に歩く: いまの姿勢を送る（self= が追従する）
    const limWalk = [0.3, 0.05, 1.1];
    await pA.eval("window.__fakeMarkers.hidden.add(0); true");
    await setCam(pA, limWalk);
    await sleep(1500);
    const aLim2 = await readHud(pA);
    console.log(`LIMITED 中に歩く A: ${show(aLim2)}`);
    check("LIMITED 中も self=（送る姿勢）が合成カメラに追従する（08-10 のように凍結しない。±10cm）", dist(aLim2.self, limWalk) < 0.1, `self=${JSON.stringify(aLim2.self)} 正解=${JSON.stringify(limWalk)}`);
    await setCam(pA, START_POS);
    await pA.eval("window.__fakeMarkers.hidden.delete(0); true");
    await sleep(1500);
    const aLim3 = await readHud(pA);
    check("LIMITED: A の発射が受理され続ける（LIMITED の 4.6 秒で accepted が増える）", aLim3.accepted > aLim.accepted || aLim3.accepted > hBefore.accepted + 2, `${hBefore.accepted} → ${aLim.accepted} → ${aLim3.accepted}`);
    {
      const b = await readHud(pB);
      const pm = (await readOverview()).match(/peerMarkers=(\S*)/)?.[1] ?? "";
      console.log(`LIMITED B: peerTracking=${JSON.stringify(b.peerTracking)} overview peerMarkers=${pm}`);
      check("LIMITED: B の HUD で A は lost（送る tracking は NORMAL のときだけ true）だが stale にならない（姿勢は送り続けている）", b.peerTracking[aLim.me] === "lost", JSON.stringify(b.peerTracking));
    }
    await fakeXr(pA, "x.status = 'NORMAL'; x.reason = ''; return true;");
    await sleep(2500);
    const aNorm = await readHud(pA);
    const vis2 = await visibleSeen(pA);
    const seen2 = await relockSeen(pA);
    console.log(`NORMAL に戻す A: ${show(aNorm)} vis=${JSON.stringify(vis2)} relock遷移=${JSON.stringify(seen2)}`);
    check("LIMITED の間ずっとコートが出ていて（anchor.visible）、relock=required を一度も経由しない", vis2.hidden === 0 && vis2.frames > 30 && !seen2.includes("required"), `${JSON.stringify(vis2)} 遷移=${JSON.stringify(seen2)}`);
    check("NORMAL に戻ると再ロック不要で新しい窓（avg=avg・n が増える）・self= が原点正面（±5cm）", aNorm.xr === "NORMAL" && aNorm.relock === "ready" && aNorm.avgMode === "avg" && aNorm.avgN >= 5 && dist(aNorm.self, START_POS) < 0.05, `${aNorm.avgLine} self=${JSON.stringify(aNorm.self)}`);
    const b = await readHud(pB);
    check("NORMAL に戻ると B の HUD で A が ok に戻る", b.peerTracking[aNorm.me] === "ok", JSON.stringify(b.peerTracking));
  }

  // ---- 4. 姿勢欠損・不正 intrinsics・例外: どれも再ロック不要 ----
  for (const [label, on, off, expectXr, extra] of [
    ["姿勢欠損（lost）", "x.lost = true", "x.lost = false", (h) => h.xr === "NO_REALITY", null],
    ["不正 intrinsics（badIntrinsics）", "x.badIntrinsics = true", "x.badIntrinsics = false", (h) => /badK/.test(h.xrLine), null],
    ["onException（throw）", "x.throw = true", "x.throw = false", (h) => h.xr === "failed", async () => {
      const msg = await board(pA, "return b.message();");
      check("onException: 画面の主表示に 8th Wall のエラーが出る（HUD だけでなく）", /カメラを開けません/.test(msg ?? "") && /8th Wall/.test(msg ?? ""), JSON.stringify(msg));
    }],
  ]) {
    const exBefore = pA.exceptions.length;
    await watchRelock(pA);
    await watchVisible(pA);
    await fakeXr(pA, `${on}; return true;`);
    await sleep(1500);
    const h1 = await readHud(pA);
    console.log(`${label} A: ${show(h1)}`);
    check(`${label}: xr の状態が変わるが relock=ready のまま・コートが出たまま`, expectXr(h1) && h1.relock === "ready" && (await board(pA, "return b.visible();")) === true, h1.xrLine);
    if (extra) await extra();
    await fakeXr(pA, `${off}; return true;`);
    const h2 = await waitHud(pA, (h) => h.xr === "NORMAL" && !/badK/.test(h.xrLine), 8000);
    const vis = await visibleSeen(pA);
    const seen = await relockSeen(pA);
    check(`${label}: 戻すと xr=NORMAL、その間コートは消えず relock=required を経由しない、未捕捉例外なし`, h2.relock === "ready" && vis.hidden === 0 && !seen.includes("required") && pA.exceptions.length === exBefore, `${h2.xrLine} vis=${JSON.stringify(vis)} 遷移=${JSON.stringify(seen)} exceptions=${pA.exceptions.slice(exBefore).join(" | ")}`);
  }
  {
    const msg = await board(pA, "return b.message();");
    check("onException から戻ると主表示のエラーが消える", !/カメラを開けません/.test(msg ?? ""), JSON.stringify(msg));
  }

  // ---- 5. main スレッドの停止・映像停止: 再ロック不要 ----
  {
    await watchRelock(pA);
    const h0 = await readHud(pA);
    await pA.eval("(() => { const t = performance.now(); while (performance.now() - t < 800) {} return true; })()");
    await sleep(2500);
    const h1 = await readHud(pA);
    const seen = await relockSeen(pA);
    check("main スレッドを 800ms 塞いでも relock=ready のまま・発射が続く", !seen.includes("required") && h1.relock === "ready" && h1.accepted > h0.accepted, `遷移=${JSON.stringify(seen)} shots ${h0.accepted} → ${h1.accepted}`);
  }
  {
    await watchRelock(pA);
    await watchVisible(pA);
    const paused = await fakeXr(pA, "return x.pauseVideo();");
    await sleep(1500);
    const h1 = await readHud(pA);
    const age = Number(h1.xrLine.match(/age=(\d+)ms/)?.[1] ?? NaN);
    console.log(`pauseVideo A: ${show(h1)}`);
    check("映像停止（pauseVideo）: 姿勢の鮮度（age=）は古くなるが invalidate しない（relock=ready・コートが出たまま）", paused === true && age >= 1000 && h1.relock === "ready" && (await board(pA, "return b.visible();")) === true, `paused=${paused} ${h1.xrLine}`);
    const b = await readHud(pB);
    check("映像停止: 姿勢が古いので送る tracking は false（B で lost）", b.peerTracking[h1.me] === "lost", JSON.stringify(b.peerTracking));
    const resumed = await fakeXr(pA, "return x.resumeVideo();");
    await sleep(2000);
    const h2 = await readHud(pA);
    const vis = await visibleSeen(pA);
    const seen = await relockSeen(pA);
    check("映像再開（resumeVideo）: 再ロックなしで age= が戻り、コートは消えず、未捕捉例外なし", resumed === true && Number(h2.xrLine.match(/age=(\d+)ms/)?.[1] ?? 9999) < 500 && vis.hidden === 0 && !seen.includes("required") && pA.exceptions.length === 0, `${h2.xrLine} vis=${JSON.stringify(vis)} 遷移=${JSON.stringify(seen)}`);
  }

  // ---- 6. 原点が変わる出来事: 再ロックが要求され、マーカーを見ると戻る ----
  {
    await watchRelock(pA);
    const rotated = await fakeXr(pA, "return x.rotateDevice();");
    await sleep(300);
    const h = await waitHud(pA, (h) => h.relock === "ready", 8000);
    const seen = await relockSeen(pA);
    console.log(`rotateDevice A: ${show(h)} relock遷移=${JSON.stringify(seen)}`);
    check("端末の向き変更（rotateDevice）: relock=required → マーカー再観測で ready・inv= の orientation が 1", rotated === true && seen.includes("required") && h.relock === "ready" && h.inv.orientation === 1, `遷移=${JSON.stringify(seen)} inv=${JSON.stringify(h.inv)}`);
    // マーカーを隠したまま向きを変えると、見るまで戻らない
    await pA.eval("window.__fakeMarkers.hidden.add(0); true");
    await sleep(500);
    await fakeXr(pA, "return x.rotateDevice();");
    await sleep(2000);
    const hHidden = await readHud(pA);
    check("向き変更の後、マーカーが見えない間は relock=required・コートが出ない", hHidden.relock === "required" && (await board(pA, "return b.visible();")) === false, hHidden.xrLine);
    await pA.eval("window.__fakeMarkers.hidden.delete(0); true");
    const hBack = await waitHud(pA, (h) => h.relock === "ready", 8000);
    check("マーカーを見ると relock=ready に戻り、self= が原点正面（±5cm）", hBack.relock === "ready" && dist(hBack.self, START_POS) < 0.05, `${hBack.relock} self=${JSON.stringify(hBack.self)}`);
  }
  {
    await watchRelock(pA);
    const r = await fakeXr(pA, "return x.setVideoSize(800, 600);");
    await sleep(2500);
    const after = await waitHud(pA, (h) => h.relock === "ready", 8000);
    const seen = await relockSeen(pA);
    const info = await fakeXr(pA, "return { projection: x.projection?.cam, video: [x.video?.videoWidth, x.video?.videoHeight], canvas: [document.querySelector('#xr-canvas').width, document.querySelector('#xr-canvas').height] };");
    console.log(`video size A: ${show(after)} relock遷移=${JSON.stringify(seen)} ${JSON.stringify(info)}`);
    check("setVideoSize(800x600): relock=required を経て、マーカー再観測で ready・inv= の projection が 1", r === "800x600" && seen.includes("required") && after.relock === "ready" && after.inv.projection === 1, `遷移=${JSON.stringify(seen)} inv=${JSON.stringify(after.inv)}`);
    check("setVideoSize: 投影の pixelRect と XR 用 canvas が 800x600・sq=1.000・self= が原点正面（±5cm）", info?.projection?.pixelRectWidth === 800 && info.canvas[0] === 800 && after.sq === 1 && dist(after.self, START_POS) < 0.05, `${JSON.stringify(info)} self=${JSON.stringify(after.self)}`);
    await watchRelock(pA);
    await pA.send("Emulation.setDeviceMetricsOverride", { width: 900, height: 500, deviceScaleFactor: 1, mobile: false });
    await sleep(1500);
    const afterResize = await waitHud(pA, (h) => h.relock === "ready", 8000);
    const infoR = await fakeXr(pA, "return { projection: x.projection?.cam, canvasSizeChanges: x.canvasSizeChanges, canvas: [document.querySelector('#xr-canvas').width, document.querySelector('#xr-canvas').height] };");
    check("resize: モックが XR 用 canvas と pixelRect を表示寸法で上書きしても映像寸法（800x600）へ戻し、relock=ready", infoR?.canvasSizeChanges >= 1 && infoR.projection?.pixelRectWidth === 800 && infoR.canvas[0] === 800 && afterResize.relock === "ready", JSON.stringify(infoR));
    await pA.send("Emulation.clearDeviceMetricsOverride");
    await sleep(1500);
    await waitHud(pA, (h) => h.relock === "ready", 8000);
  }
  {
    await watchRelock(pA);
    await pA.eval("Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange', { bubbles: true })); true");
    await sleep(300);
    const h = await waitHud(pA, (h) => h.relock === "ready", 8000);
    const seen = await relockSeen(pA);
    check("タブ復帰（visibilitychange → visible）: relock=required → マーカー再観測で ready・inv= の visibility が 1", seen.includes("required") && h.relock === "ready" && h.inv.visibility === 1, `遷移=${JSON.stringify(seen)} inv=${JSON.stringify(h.inv)}`);
    const hEnd = await readHud(pA);
    console.log(`A 最後の診断: ${hEnd.jumpLine} inv=${JSON.stringify(hEnd.inv)}`);
  }

  // ---- 9. 実機ログ（A だけが書く）: bfcache で再読み込みする前に確かめる ----
  await sleep(2500);
  {
    const text = existsSync(CLIENT_LOG) ? readFileSync(CLIENT_LOG, "utf8") : "";
    const rotated = existsSync(`${CLIENT_LOG}.1`) ? readFileSync(`${CLIENT_LOG}.1`, "utf8") : "";
    const lines = `${rotated}\n${text}`.split("\n").filter((l) => l.slice(0, 24) >= TEST_START_ISO && l.includes("[8thwall-board-phone@"));
    const states = lines.filter((l) => / state: xr=/.test(l) && / avg=/.test(l) && / det=/.test(l) && / inv=/.test(l) && / jump=/.test(l) && / fps=/.test(l));
    const has = (re) => lines.some((l) => re.test(l));
    const kinds = ["filter-config", "opencv backend=opencv", "camera video=", "intrinsics p=", "relock ", "limited-start", "limited-end", "direct-enter", "window-restart", "invalidate cause=orientation", "invalidate cause=projection", "invalidate cause=visibility", "relock-required", "xr-exception"];
    const missing = kinds.filter((k) => !has(new RegExp(`\\[08-11\\] event=${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)));
    console.log(`logs/client.log: 08-11 の行 ${lines.length}（snapshot ${states.length}）。例: ${states.at(-1)?.slice(0, 220) ?? "(なし)"}`);
    check("logs/client.log に A の snapshot（xr= jump= inv= det= avg= fps=）が 1 秒ごとに書かれている（10 行以上）", states.length >= 10, `${states.length} 行`);
    check("logs/client.log に [08-11] event= のイベント（設定・OpenCV・カメラ・投影・再ロック・LIMITED・直接モード・invalidate の原因・例外）が書かれている", missing.length === 0, missing.length ? `無い: ${missing.join(", ")}` : `${lines.filter((l) => /event=/.test(l)).length} 行`);
  }

  // ---- 6b. bfcache 復帰 → invalidate として数えてから再読み込み ----
  let aMe = "";
  {
    const loaded = pA.waitEvent("Page.loadEventFired", 20000);
    const navigated = pA.waitEvent("Page.frameNavigated", 20000);
    await pA.eval("dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })); true");
    const [nav, load] = await Promise.all([navigated, loaded]);
    const h = await waitHud(pA, (h) => h.me.startsWith("p") && h.xr === "NORMAL" && h.relock === "ready", 30000);
    const reloaded = await pA.eval("performance.getEntriesByType('navigation')[0]?.type");
    console.log(`bfcache A after reload: ${show(h)}`);
    check("bfcache 復帰（pageshow persisted）: location.reload() で再初期化され、再入室して xr=NORMAL・relock=ready", Boolean(nav && load) && reloaded === "reload" && h.me.startsWith("p") && h.relock === "ready", `navigation=${reloaded} me=${h.me} ${h.xrLine}`);
    aMe = h.me;
    await sleep(3000);
  }

  // ---- 7. 実バイナリ smoke（C）・先行読み込み（D） ----
  {
    const get = async (path) => {
      const r = await fetch(`${ORIGIN}${path}`).catch((e) => ({ ok: false, status: -1, headers: new Headers(), text: async () => String(e) }));
      return { status: r.status, type: r.headers.get("content-type") ?? "", body: r.status === 200 ? await r.text() : "" };
    };
    const [xrJs, slamJs, lic, cvJs] = await Promise.all(["/vendor/8thwall/xr.js", "/vendor/8thwall/xr-slam.js", "/vendor/8thwall/LICENSE", "/vendor/opencv/opencv.js"].map(get));
    check("実バイナリ: /vendor/8thwall/xr.js・xr-slam.js が 200 で text/javascript", xrJs.status === 200 && /text\/javascript/.test(xrJs.type) && slamJs.status === 200 && /text\/javascript/.test(slamJs.type), `xr.js ${xrJs.status} ${xrJs.body.length}B / xr-slam.js ${slamJs.status} ${slamJs.body.length}B`);
    check("実バイナリ: /vendor/8thwall/LICENSE が先頭に Niantic・/vendor/opencv/opencv.js が 200", lic.status === 200 && /Niantic/.test(lic.body.slice(0, 200)) && cvJs.status === 200 && cvJs.body.length > 5e6, `LICENSE ${lic.status} / opencv.js ${cvJs.status} ${cvJs.body.length}B`);
    let c = await readHud(pC);
    while (Date.now() - tC0 < 45000 && !/^cam=.*(Error|失敗|タイムアウト)/m.test(c.raw) && !/^xr=failed/m.test(c.raw)) {
      await sleep(1000);
      c = await readHud(pC);
    }
    const xr8 = await pC.eval("({ hasXR8: Boolean(window.XR8), hasXrController: Boolean(window.XR8?.XrController) })");
    console.log(`C（実バイナリ, ${((Date.now() - tC0) / 1000).toFixed(1)}s）: ${c.cam} | ${c.xrLine} | XR8=${JSON.stringify(xr8)} exceptions=${pC.exceptions.length}`);
    check("実バイナリ: xrloaded 後に window.XR8.XrController が存在（SLAM chunk が読めた）", xr8?.hasXrController === true, JSON.stringify(xr8));
    check("実バイナリ: desktop では起動せず、HUD の cam= か xr= に失敗理由が出る", /^cam=.*(Error|失敗|タイムアウト)/m.test(c.raw) || /^xr=failed/m.test(c.raw), `${c.cam} | ${c.xrLine}`);
    check("実バイナリ: C のページに未捕捉例外が無い", pC.exceptions.length === 0, pC.exceptions.slice(0, 2).join(" | "));
    await browser.send("Target.closeTarget", { targetId: pC.targetId });

    const pD = await newWindow("D");
    await pD.send("Network.enable");
    await pD.send("Page.navigate", { url: `${BASE}?fakehands=1&name=Pre&room=${ROOM_REAL}&remoteLog=0` });
    const tD0 = Date.now();
    let d = null;
    while (Date.now() - tD0 < 30000) {
      d = await pD.eval("({ started: document.body.classList.contains('started'), hasXrController: Boolean(window.XR8?.XrController) })");
      if (d?.hasXrController) break;
      await sleep(500);
    }
    const urls = pD.responses.filter((r) => /\/vendor\/8thwall\//.test(r.url)).map((r) => `${r.status} ${r.url.replace(ORIGIN, "")}`);
    check("先行読み込み: 開始ボタンの前に xr.js と xr-slam.js が読み込まれ、XR8.XrController がある・未捕捉例外なし", d?.started === false && d.hasXrController === true && urls.some((u) => /^200 .*\/xr\.js/.test(u)) && urls.some((u) => /^200 .*\/xr-slam\.js/.test(u)) && pD.exceptions.length === 0, JSON.stringify(urls));
    await browser.send("Target.closeTarget", { targetId: pD.targetId });
  }

  // ---- 俯瞰画面と例外（A・B の対戦の最後） ----
  {
    const ov = await readOverview();
    const ovPlayers = (ov.match(/players=(\S*)/)?.[1] ?? "").split(",").filter(Boolean);
    const pm = ov.match(/peerMarkers=(\S*)/)?.[1] ?? "";
    check("最後に俯瞰画面が 2 人を表示し、再入室した A もマーカーで追跡中", /ws=open/.test(ov) && ovPlayers.length === 2 && new RegExp(`\\b${aMe}:0\\b`).test(pm), `players=${ovPlayers.join(",")} peerMarkers=${pm}`);
  }
  const exceptions = pages.flatMap((p) => p.exceptions.map((e) => `${p.name}: ${e}`));
  check("A・B・俯瞰画面で未捕捉例外が出ていない", exceptions.length === 0, exceptions.slice(0, 2).join(" | "));
  // CPU を空けるため、ぶれの比較の前に A・B・俯瞰画面を閉じる
  for (const p of [pB, pO]) await browser.send("Target.closeTarget", { targetId: p.targetId });
  await pA.send("Page.navigate", { url: "about:blank" });

  // ---- 8. ぶれの比較: ?avg=1 と ?avg=0 ----
  // 手は出さない（撃たない = canSnap が常に true。連射中の制限と混ぜない）。合成カメラは原点マーカーの正面で静止
  const NOISE_BASE = `fov=70&camZoom=1&fakecam=1&fakexr=1&autostart=1&fakeMarkerPx=80&room=${ROOM_NOISE}&waitSec=1&markerMm=${MARKER_MM}&remoteLog=0`;
  const noisePages = [];
  for (const [i, avg] of [[1, 1], [0, 0]]) {
    const p = await newWindow(`N${avg}`);
    noisePages.push(p);
    await p.send("Page.navigate", { url: `${BASE}?${NOISE_BASE}&avg=${avg}&name=Noise${i}` });
  }
  /** 1 条件: URL の追加パラメータで読み直し、窓が埋まるまで待ってから 100ms ごとに 8 秒サンプルする */
  async function measure(extra, label) {
    // 読み直す前のページの HUD を読まないよう、古いページに印を付けてから遷移し、印の無い新しいページで
    // 再ロック済み・観測を 50 回以上採用した（10Hz で約 5 秒 = 窓の 3 秒が埋まった）ところから測る
    await Promise.all(noisePages.map((p) => p.eval("window.__stalePage = true; true")));
    await Promise.all(noisePages.map((p, i) => p.send("Page.navigate", { url: `${BASE}?${NOISE_BASE}&avg=${i === 0 ? 1 : 0}&name=Noise${i}&${extra}` })));
    const settled = async (p) => {
      const t0 = Date.now();
      while (Date.now() - t0 < 60000) {
        const ok = await p.eval("!window.__stalePage && Boolean(window.__board?.ready()) && (window.__board.counters()?.accepts ?? 0) >= 50 && window.__board.backend() === 'opencv'");
        if (ok) return true;
        await sleep(300);
      }
      return false;
    };
    const ok = await Promise.all(noisePages.map(settled));
    const samples = noisePages.map(() => ({ anchor: [], self: [] }));
    for (let k = 0; k < 80; k++) {
      const vals = await Promise.all(noisePages.map((p) => p.eval("[window.__board.anchor(), window.__board.self()]")));
      vals.forEach((v, i) => {
        if (!v) return;
        samples[i].anchor.push(v[0].slice(0, 3));
        samples[i].self.push(v[1]);
      });
      await sleep(100);
    }
    const spread = (pts) => {
      const mean = [0, 1, 2].map((j) => pts.reduce((s, p) => s + p[j], 0) / pts.length);
      const d = pts.map((p) => dist(p, mean));
      return { rms: Math.sqrt(d.reduce((s, x) => s + x * x, 0) / d.length) * 1000, max: Math.max(...d) * 1000 };
    };
    const [a1, a0] = samples.map((s) => spread(s.anchor));
    const [s1, s0] = samples.map((s) => spread(s.self));
    const huds = await Promise.all(noisePages.map(readHud));
    console.log(`ぶれ（${label}）: anchor RMS avg=1 ${a1.rms.toFixed(1)}mm（最大 ${a1.max.toFixed(1)}mm） / avg=0 ${a0.rms.toFixed(1)}mm（最大 ${a0.max.toFixed(1)}mm）`);
    console.log(`                 self=  RMS avg=1 ${s1.rms.toFixed(1)}mm（最大 ${s1.max.toFixed(1)}mm） / avg=0 ${s0.rms.toFixed(1)}mm（最大 ${s0.max.toFixed(1)}mm）`);
    console.log(`  N1: ${huds[0].avgLine} | ${huds[0].detLine}`);
    console.log(`  N0: ${huds[1].avgLine} | ${huds[1].detLine}`);
    return { ok: ok.every(Boolean) && huds[0].avgMode === "avg" && huds[1].avgMode === "lerp", a1, a0, s1, s0, n: samples.map((s) => s.anchor.length) };
  }
  {
    const m = await measure("fakeMarkerNoise=0.01&fakeXrNoise=0.002", "マーカー側 σ=1cm + 8th Wall σ=2mm");
    check("ぶれの比較（マーカー側 σ=1cm + 8th Wall σ=2mm）: 両方 relock=ready・avg=avg / avg=lerp で 80 サンプル", m.ok && m.n.every((n) => n >= 70), `n=${m.n}`);
    check("ぶれの比較（マーカー側 σ=1cm）: avg=1 のアンカーの変動（RMS）が avg=0 の半分未満", m.a1.rms < m.a0.rms * 0.5, `avg=1 ${m.a1.rms.toFixed(1)}mm vs avg=0 ${m.a0.rms.toFixed(1)}mm`);
    check("ぶれの比較（マーカー側 σ=1cm）: avg=1 の self= の変動（RMS）が avg=0 より明確に小さい（0.7 倍未満）", m.s1.rms < m.s0.rms * 0.7, `avg=1 ${m.s1.rms.toFixed(1)}mm vs avg=0 ${m.s0.rms.toFixed(1)}mm`);
  }
  {
    const m = await measure("fakeMarkerNoise=0&fakeXrNoise=0.01", "8th Wall σ=1cm のみ");
    check("ぶれの比較（8th Wall σ=1cm のみ）: 両方 relock=ready で 80 サンプル", m.ok && m.n.every((n) => n >= 70), `n=${m.n}`);
    check("ぶれの比較（8th Wall σ=1cm のみ）: avg=1 のアンカー（コートのワールド位置）の変動が avg=0 の半分未満", m.a1.rms < m.a0.rms * 0.5, `avg=1 ${m.a1.rms.toFixed(1)}mm vs avg=0 ${m.a0.rms.toFixed(1)}mm（self= は avg=1 ${m.s1.rms.toFixed(1)}mm / avg=0 ${m.s0.rms.toFixed(1)}mm。カメラ自体のノイズは self= に残る）`);
  }
  const noiseEx = noisePages.flatMap((p) => p.exceptions.map((e) => `${p.name}: ${e}`));
  check("ぶれの比較のページに未捕捉例外が無い", noiseEx.length === 0, noiseEx.slice(0, 2).join(" | "));

  const failed = results.filter(([, ok]) => !ok);
  console.log(failed.length === 0 ? `\nALL PASS (${results.length})` : `\n${failed.length} FAILED / ${results.length}:\n${failed.map(([n]) => `  - ${n}`).join("\n")}`);
  exitCode = failed.length === 0 ? 0 : 1;
} catch (e) {
  console.error("確認の実行エラー:", e?.stack ?? e);
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
