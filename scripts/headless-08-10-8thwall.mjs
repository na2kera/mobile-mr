// demos/08-10-splatoon-8thwall（08 + 8th Wall Engine Binary の SLAM）のブラウザ経路をヘッドレス Chrome で確認する。
// `npm run check:8thwall` で実行する。仕組みは headless-08-7-alva.mjs と同じ（CDP を ws で直接叩く。Chrome が無ければスキップ）。
// PC では実 SLAM が動かないので、?fakecam=1&fakexr=1 で window.XR8 にモック（demos/08-10-splatoon-8thwall/fake-xr8.ts）を差し込み、
// 実機と同じ startXrSource() → main.ts の XR 経路（姿勢適用・再ロック・発射停止・tracking:false・投影更新）を通す:
//   - A・B（?fakexr=1）: 入室・xr=NORMAL・マーカー検出・relock=ready・練習で連射が受理され得点。俯瞰画面に 2 人と peerMarkers
//   - 追従: 原点マーカーを隠して合成カメラを動かすと、8th Wall の姿勢でコートが留まり self= が合成カメラに追従、連射も続く
//   - LIMITED / 姿勢欠損 / 不正 intrinsics / 例外: relock=required・発射停止・相手と俯瞰画面に lost。NORMAL に戻すだけでは戻らず、
//     マーカーを再観測すると ready
//   - 再ロック待ちの間も tracking:false の姿勢を送り続ける（3 秒以上たっても相手・俯瞰画面で消えずに lost）
//   - main スレッドの停止（800ms）だけでは再ロック要求にしない
//   - 映像停止（repeatFrame）・端末の向き変更・映像サイズ変更・ウィンドウ resize・タブ復帰・bfcache 復帰
//   - C（fakecam 無し）: 実バイナリ（/vendor/8thwall/）の配信と読み込みの smoke。desktop では allowedDevices: MOBILE で起動しない想定
//   - D（fakecam 無し・autostart 無し）: 開始ボタンの前に xr.js / xr-slam.js の読み込みが始まっている（先行読み込み）
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
// 別の worktree で同時に走らせるときは PORT / CDP_PORT で変える（5210 は手動の dev server 用なので使わない）
const PORT = Number(process.env.PORT ?? "") || 5213;
const CDP_PORT = Number(process.env.CDP_PORT ?? "") || 9353;
const ORIGIN = `https://localhost:${PORT}`;
const BASE = `${ORIGIN}/demos/08-10-splatoon-8thwall/`;
// markerMm=100 / fakeMarkerPx=80: 08-7 の確認と同じ幾何（合成カメラは原点マーカーの正面 0.74m）
const MARKER_MM = 100;
const ROOM = "check-8thwall";
const ROOM_REAL = "check-8thwall-real";
const COMMON = `fov=70&camZoom=1&fakecam=1&fakexr=1&autostart=1&fakehands=1&fakeMarkerPx=80&handSmooth=1&room=${ROOM}&waitSec=1&markerMm=${MARKER_MM}`;
const START_POS = [0, 0, 0.74];

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

/** HUD を読む（08 の行 + 08-10 の xr= 行） */
function parseHud(hud) {
  const g = hud.match(/game: phase=(\S+) left=(\S+) color=(\S+) players=(\S*) scores=(\S*) total=(\d+) shots=(\d+)\/(\d+)/);
  const scores = {};
  for (const m of (g?.[5] ?? "").matchAll(/(p\d+):(\d+)/g)) scores[m[1]] = Number(m[2]);
  const self = hud.match(/self=\(([^)]*)\)/)?.[1].split(",").map(Number);
  const xrLine = hud.match(/^xr=.*$/m)?.[0] ?? "";
  const peerTracking = {};
  for (const m of (hud.match(/peerTracking=(\S+)/)?.[1] ?? "").matchAll(/(p\d+):(\w+)/g)) peerTracking[m[1]] = m[2];
  return {
    raw: hud,
    mode: hud.match(/\bmode=(\S+)/)?.[1] ?? "",
    me: hud.match(/\bme=(\S+)/)?.[1] ?? "-",
    cam: hud.match(/^cam=.*$/m)?.[0] ?? "",
    marker: hud.match(/marker=(\S+)/)?.[1] ?? "",
    markerLine: hud.match(/^marker=.*$/m)?.[0] ?? "",
    self: self && self.length === 3 && self.every(Number.isFinite) ? self : null,
    xrLine,
    xr: xrLine.match(/^xr=(\S+)/)?.[1] ?? "",
    relock: xrLine.match(/relock=(\S+)/)?.[1] ?? "",
    sq: Number(xrLine.match(/ sq=([\d.]+)/)?.[1] ?? NaN),
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
  await pA.send("Page.navigate", { url: `${BASE}?${COMMON}&name=XrA` });
  const pB = await newWindow("B");
  await pB.send("Page.navigate", { url: `${BASE}?${COMMON}&name=XrB` });
  // C: 実バイナリ。fakecam 無し（Chrome のフェイクデバイスでカメラ自体は開ける）。別 room で A・B の対戦に混ぜない
  const pC = await newWindow("C");
  await pC.send("Network.enable");
  const tC0 = Date.now();
  await pC.send("Page.navigate", { url: `${BASE}?fakehands=1&autostart=1&name=Real&room=${ROOM_REAL}` });
  const pO = await newWindow("O");
  await pO.send("Page.navigate", { url: `${BASE}overview.html?room=${ROOM}&waitSec=1&markerMm=${MARKER_MM}` });
  const pages = [pA, pB, pO];
  const players = [pA, pB];

  const readHud = async (p) => parseHud((await p.eval("document.querySelector('#hud')?.textContent")) ?? "");
  const readOverview = async () => (await pO.eval("document.querySelector('#hud')?.textContent")) ?? "";
  const setCam = (p, pos) => p.eval(`window.__fakeMarkers.camPos = ${JSON.stringify(pos)}; true`);
  const fakeXr = (p, js) => p.eval(`(() => { const x = window.__fakeXr; ${js} })()`);
  const show = (h) => `me=${h.me} ${h.xrLine} | ${h.markerLine} | shots=${h.sent}/${h.accepted}`;
  /** HUD の relock= の遷移を記録し始める（再ロックは数百 ms で終わるので、ポーリングではなく MutationObserver で取りこぼさない） */
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
      window.__relockSeen = seen;
      return true;
    })()`);
  const relockSeen = (p) => p.eval("window.__relockSeen?.values ?? []");
  /** watchRelock からの遷移ごとの HUD の xr= 行（時刻付き。失敗時の理由の確認用） */
  const relockLines = (p) => p.eval("window.__relockSeen?.lines ?? []");
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

  // ---- 1. 入室・XR・マーカー・練習 ----
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    const hs = await Promise.all(players.map(readHud));
    if (hs.every((h) => h.me.startsWith("p") && h.marker.startsWith("id=") && h.relock === "ready")) break;
    await sleep(500);
  }
  console.log(`A・B の入室 + マーカー検出 + relock=ready まで ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  await sleep(6000);
  const [a0, b0] = await Promise.all([readHud(pA), readHud(pB)]);
  console.log(`A: ${show(a0)}`);
  console.log(`B: ${show(b0)}`);
  check("A・B: HUD の mode=fakexr", a0.mode === "fakexr" && b0.mode === "fakexr", `${a0.mode}/${b0.mode}`);
  check("A・B: xr=NORMAL", a0.xr === "NORMAL" && b0.xr === "NORMAL", `${a0.xrLine} / ${b0.xrLine}`);
  check("A・B: マーカー検出（marker=id=）と relock=ready", a0.marker.startsWith("id=") && b0.marker.startsWith("id=") && a0.relock === "ready" && b0.relock === "ready", `${a0.marker} ${a0.relock} / ${b0.marker} ${b0.relock}`);
  check("A・B: 練習で連射が受理され得点している", a0.phase === "practice" && a0.accepted >= 2 && b0.accepted >= 2 && (a0.scores[a0.me] ?? 0) > 0 && (b0.scores[b0.me] ?? 0) > 0, `${a0.accepted}/${b0.accepted} ${JSON.stringify(a0.scores)}`);
  check("A: HUD の p= に sq=1.000（モックは正方画素）", a0.sq === 1, a0.xrLine);
  const xrInfo = await fakeXr(pA, "return { configured: x.configured, run: { ownRunLoop: x.runOptions?.ownRunLoop, allowedDevices: x.runOptions?.allowedDevices }, projection: x.projection, pre: x.preRenders, post: x.postRenders, canvas: [document.querySelector('#xr-canvas').width, document.querySelector('#xr-canvas').height] };");
  console.log(`A __fakeXr: ${JSON.stringify(xrInfo)}`);
  check("A: xr-source が XR8 を scale:absolute・ownRunLoop:false・MOBILE で起動し、runPreRender / runPostRender が毎フレーム呼ばれる", xrInfo?.configured?.scale === "absolute" && xrInfo.run.ownRunLoop === false && xrInfo.run.allowedDevices === "mobile" && xrInfo.pre > 100 && xrInfo.post > 100, JSON.stringify(xrInfo?.run));
  check("A: 投影の pixelRect と XR 用 canvas が映像寸法（640x480）", xrInfo?.projection?.cam?.pixelRectWidth === 640 && xrInfo.projection.cam.pixelRectHeight === 480 && xrInfo.canvas[0] === 640 && xrInfo.canvas[1] === 480, JSON.stringify(xrInfo?.projection));
  check("A・B: self= が合成カメラの位置（原点の正面 ±5cm）", dist(a0.self, START_POS) < 0.05 && dist(b0.self, START_POS) < 0.05, `${JSON.stringify(a0.self)} / ${JSON.stringify(b0.self)}`);
  {
    const ov = await readOverview();
    const ovPlayers = (ov.match(/players=(\S*)/)?.[1] ?? "").split(",").filter(Boolean);
    const pm = ov.match(/peerMarkers=(\S*)/)?.[1] ?? "";
    check("俯瞰画面: 2 人が見えている", /ws=open/.test(ov) && ovPlayers.length === 2, ov.split("\n")[0].slice(0, 160));
    check("俯瞰画面: peerMarkers に A・B のマーカー ID（0）が出る", new RegExp(`\\b${a0.me}:0\\b`).test(pm) && new RegExp(`\\b${b0.me}:0\\b`).test(pm), `peerMarkers=${pm}`);
  }

  // ---- 2. 追従: 原点マーカーを隠して歩く（8th Wall の姿勢でコートが留まる、の PC 版） ----
  await Promise.all([pA.eval("window.__fakeMarkers.hidden.add(0); true"), pB.eval("window.__fakeMarkers.hidden.add(0); true")]);
  await sleep(1000);
  const aHidden = await readHud(pA);
  const acceptedBeforeWalk = aHidden.accepted;
  const walk = [[0.4, 0.1, 1.2], [-0.3, -0.1, 1.6], [0.2, 0.3, 2.0]];
  for (const [i, pos] of walk.entries()) {
    await Promise.all([setCam(pA, pos), setCam(pB, pos)]);
    await sleep(2000);
    const [a, b] = await Promise.all([readHud(pA), readHud(pB)]);
    console.log(`walk${i + 1} A: ${show(a)} self=${JSON.stringify(a.self)} 正解=${JSON.stringify(pos)}`);
    check(`歩行 ${i + 1}: A・B はマーカーが見えなくても relock=ready のまま（holding last pose）`, a.relock === "ready" && b.relock === "ready" && /holding last pose/.test(a.markerLine), `${a.relock}/${b.relock} ${a.markerLine}`);
    check(`歩行 ${i + 1}: A・B の self= が合成カメラに追従する（±10cm）`, dist(a.self, pos) < 0.1 && dist(b.self, pos) < 0.1, `A=${JSON.stringify(a.self)} B=${JSON.stringify(b.self)} 正解=${JSON.stringify(pos)} 差=${dist(a.self, pos).toFixed(3)}/${dist(b.self, pos).toFixed(3)}m`);
  }
  const aWalk = await readHud(pA);
  check("A: マーカーが見えない間も連射が受理され続ける", aWalk.accepted > acceptedBeforeWalk, `${acceptedBeforeWalk} → ${aWalk.accepted}`);
  // B は原点に戻してマーカーを見せる（以後の確認で A のロストを見る側）
  await setCam(pB, START_POS);
  await pB.eval("window.__fakeMarkers.hidden.delete(0); true");

  // ---- 3. LIMITED ----
  await setCam(pA, START_POS);
  await sleep(1000);
  await fakeXr(pA, "x.status = 'LIMITED'; x.reason = 'EXCESSIVE_MOTION'; return true;");
  const tLimited = Date.now();
  await sleep(1500);
  const aLim = await readHud(pA);
  console.log(`LIMITED A: ${show(aLim)}`);
  check("LIMITED: A が xr=LIMITED・relock=required", aLim.xr === "LIMITED" && aLim.relock === "required", aLim.xrLine);
  await sleep(2000);
  const aLim2 = await readHud(pA);
  check("LIMITED: A の発射が受理されなくなる（2 秒間 accepted が増えない）", aLim2.accepted === aLim.accepted && aLim2.sent === aLim.sent, `${aLim.sent}/${aLim.accepted} → ${aLim2.sent}/${aLim2.accepted}`);
  {
    const b = await readHud(pB);
    const pm = (await readOverview()).match(/peerMarkers=(\S*)/)?.[1] ?? "";
    console.log(`LIMITED B: peerTracking=${JSON.stringify(b.peerTracking)} overview peerMarkers=${pm}`);
    check("LIMITED: B の HUD（peerTracking）で A が lost", b.peerTracking[aLim.me] === "lost", JSON.stringify(b.peerTracking));
    check("LIMITED: 俯瞰画面の peerMarkers で A が lost（tracking:false が伝わる）", new RegExp(`\\b${aLim.me}:lost\\b`).test(pm), `peerMarkers=${pm}`);
  }
  // 再ロック待ちの間も tracking:false の姿勢が送られ続けるか（PEER_STALE_MS=2s を超えても B・俯瞰画面から A が消えない）
  await sleep(Math.max(0, tLimited + 4000 - Date.now()));
  {
    const elapsed = ((Date.now() - tLimited) / 1000).toFixed(1);
    const b = await readHud(pB);
    const pm = (await readOverview()).match(/peerMarkers=(\S*)/)?.[1] ?? "";
    const ranking = (await pO.eval("document.body.innerText")) ?? "";
    console.log(`LIMITED ${elapsed}s B: peerTracking=${JSON.stringify(b.peerTracking)} overview peerMarkers=${pm} ranking ロスト表示=${ranking.includes("ロスト（最後の姿勢を維持）")}`);
    check(`LIMITED ${elapsed}s 後: B の HUD で A が lost のまま（stale にならない = tracking:false が送られ続ける）`, b.peerTracking[aLim.me] === "lost", JSON.stringify(b.peerTracking));
    check(`LIMITED ${elapsed}s 後: 俯瞰画面の peerMarkers で A が lost のまま、順位表が「ロスト（最後の姿勢を維持）」（「-」にならない）`, new RegExp(`\\b${aLim.me}:lost\\b`).test(pm) && ranking.includes("ロスト（最後の姿勢を維持）"), `peerMarkers=${pm}`);
  }
  await fakeXr(pA, "x.status = 'NORMAL'; x.reason = ''; return true;");
  await sleep(2000);
  const aNorm = await readHud(pA);
  console.log(`NORMAL (marker hidden) A: ${show(aNorm)}`);
  check("LIMITED → NORMAL に戻しただけでは relock=required のまま（マーカー未観測）", aNorm.xr === "NORMAL" && aNorm.relock === "required", aNorm.xrLine);
  await pA.eval("window.__fakeMarkers.hidden.delete(0); true");
  const aBack = await waitHud(pA, (h) => h.relock === "ready" && dist(h.self, START_POS) < 0.05, 8000);
  console.log(`marker back A: ${show(aBack)} self=${JSON.stringify(aBack.self)}`);
  check("マーカー再観測で relock=ready に戻り、self= が原点正面（±5cm）", aBack.relock === "ready" && dist(aBack.self, START_POS) < 0.05, `${aBack.relock} self=${JSON.stringify(aBack.self)}`);
  await sleep(2500);
  const aFire = await readHud(pA);
  check("再ロック後に発射が再開する", aFire.accepted > aBack.accepted, `${aBack.accepted} → ${aFire.accepted}`);
  {
    const b = await readHud(pB);
    check("再ロック後: B の HUD で A が ok に戻る", b.peerTracking[aFire.me] === "ok", JSON.stringify(b.peerTracking));
  }

  // ---- 4. 姿勢欠損・不正 intrinsics・例外 ----
  for (const [label, on, off, expectXr] of [
    ["姿勢欠損（lost）", "x.lost = true", "x.lost = false", (h) => h.xr !== "NORMAL"],
    ["不正 intrinsics（badIntrinsics）", "x.badIntrinsics = true", "x.badIntrinsics = false", (h) => h.xr === "INVALID_INTRINSICS"],
    ["onException（throw）", "x.throw = true", "x.throw = false", (h) => h.xr === "failed"],
  ]) {
    const exBefore = pA.exceptions.length;
    await fakeXr(pA, `${on}; return true;`);
    await sleep(1500);
    const h1 = await readHud(pA);
    await sleep(1000);
    const h1b = await readHud(pA);
    console.log(`${label} A: ${show(h1)}`);
    check(`${label}: relock=required になり、発射が止まる`, h1.relock === "required" && expectXr(h1) && h1b.accepted === h1.accepted, `${h1.xrLine} shots ${h1.accepted} → ${h1b.accepted}`);
    await fakeXr(pA, `${off}; return true;`);
    const h2 = await waitHud(pA, (h) => h.relock === "ready" && h.xr === "NORMAL", 8000);
    check(`${label}: 戻すとマーカー再観測で relock=ready、未捕捉例外なし`, h2.relock === "ready" && h2.xr === "NORMAL" && pA.exceptions.length === exBefore, `${h2.xrLine} exceptions=${pA.exceptions.slice(exBefore).join(" | ")}`);
  }

  // ---- 4a. main スレッドの停止（MediaPipe 初期化・シェーダコンパイル・GC 相当）: 映像も SLAM も止まっていないので再ロック要求にしない ----
  // 止まった直後の tick に新しいフレームがあれば frameMs はそこで更新されるので、holdFrames=1 で「直後の tick は
  // repeatFrame（まだ新しいカメラフレームが処理されていない）」も確認する（こちらは修正前の main.ts だと required になる）
  for (const [label, hold] of [["main スレッドを 800ms 塞ぐ", 0], ["main スレッドを 800ms 塞ぎ、直後の tick は repeatFrame", 1]]) {
    const exBefore = pA.exceptions.length;
    await watchRelock(pA);
    const h0 = await readHud(pA);
    const repBefore = await fakeXr(pA, "return x.repeatFrames;");
    const blocked = await pA.eval(`(() => { window.__fakeXr.holdFrames = ${hold}; const t = performance.now(); while (performance.now() - t < 800) {} return Math.round(performance.now()); })()`);
    const h1 = await readHud(pA);
    await sleep(300);
    const h2 = await readHud(pA);
    await sleep(2000);
    const h3 = await readHud(pA);
    const seen = await relockSeen(pA);
    const repAfter = await fakeXr(pA, "return x.repeatFrames;");
    console.log(`${label} A: ${show(h2)} relock遷移=${JSON.stringify(seen)} repeatFrames ${repBefore} → ${repAfter}`);
    if (seen.includes("required")) console.log(`  停止の終わり=${blocked} 遷移時の xr 行: ${JSON.stringify(await relockLines(pA))}`);
    check(`${label}: 直後と 300ms 後も relock=ready のまま（required を経由しない）`, typeof blocked === "number" && h0.relock === "ready" && h1.relock === "ready" && h2.relock === "ready" && !seen.includes("required"), `${h0.relock} → ${h1.relock} → ${h2.relock} 遷移=${JSON.stringify(seen)}`);
    check(`${label}: その後も発射が続く、未捕捉例外なし`, h3.relock === "ready" && h3.accepted > h0.accepted && pA.exceptions.length === exBefore, `shots ${h0.accepted} → ${h3.accepted}`);
  }

  // ---- 4b. 映像停止（repeatFrame）: 前回の reality が繰り返されるだけなので鮮度が切れて再ロック要求 ----
  {
    const exBefore = pA.exceptions.length;
    const paused = await fakeXr(pA, "return x.pauseVideo();");
    await sleep(1000);
    const h1 = await readHud(pA);
    console.log(`pauseVideo A: ${show(h1)}`);
    check("映像停止（pauseVideo）: 約 1 秒後に relock=required", paused === true && h1.relock === "required", `paused=${paused} ${h1.xrLine}`);
    await sleep(2000);
    const h1b = await readHud(pA);
    const rep = await fakeXr(pA, "return x.repeatFrames;");
    check("映像停止: 発射が受理されなくなる（2 秒間 accepted が増えない）", h1b.accepted === h1.accepted, `${h1.accepted} → ${h1b.accepted} repeatFrames=${rep}`);
    const b = await readHud(pB);
    const pm = (await readOverview()).match(/peerMarkers=(\S*)/)?.[1] ?? "";
    check("映像停止: B の HUD と俯瞰画面の peerMarkers で A が lost", b.peerTracking[h1.me] === "lost" && new RegExp(`\\b${h1.me}:lost\\b`).test(pm), `peerTracking=${JSON.stringify(b.peerTracking)} peerMarkers=${pm}`);
    const resumed = await fakeXr(pA, "return x.resumeVideo();");
    const h2 = await waitHud(pA, (h) => h.relock === "ready" && h.xr === "NORMAL", 8000);
    console.log(`resumeVideo A: ${show(h2)}`);
    await sleep(2500);
    const h3 = await readHud(pA);
    check("映像再開（resumeVideo）: マーカー再観測で relock=ready、発射が再開、未捕捉例外なし", resumed === true && h2.relock === "ready" && h3.accepted > h2.accepted && pA.exceptions.length === exBefore, `${h2.xrLine} shots ${h2.accepted} → ${h3.accepted}`);
  }

  // ---- 4c. 端末の向き変更: origin がリセットされるので再ロック ----
  {
    await watchRelock(pA);
    const rotated = await fakeXr(pA, "return x.rotateDevice();");
    await sleep(500);
    const h = await waitHud(pA, (h) => h.relock === "ready", 8000);
    const seen = await relockSeen(pA);
    console.log(`rotateDevice A: ${show(h)} relock遷移=${JSON.stringify(seen)}`);
    check("端末の向き変更（rotateDevice）: relock=required → マーカー再観測で ready", rotated === true && seen.includes("required") && h.relock === "ready", `遷移=${JSON.stringify(seen)}`);
  }

  // ---- 5. 映像サイズ変更とウィンドウ resize ----
  {
    await watchRelock(pA);
    const r = await fakeXr(pA, "return x.setVideoSize(800, 600);");
    console.log(`setVideoSize → ${r}`);
    const h = await waitHud(pA, (h) => h.relock === "ready", 1000);
    await sleep(2500);
    const after = await waitHud(pA, (h) => h.relock === "ready", 8000);
    const seen = await relockSeen(pA);
    const info = await fakeXr(pA, "return { projection: x.projection?.cam, videoSizeChanges: x.videoSizeChanges, video: [x.video?.videoWidth, x.video?.videoHeight], canvas: [document.querySelector('#xr-canvas').width, document.querySelector('#xr-canvas').height] };");
    console.log(`video size A: ${show(after)} relock遷移=${JSON.stringify(seen)} ${JSON.stringify(info)} (直後 ${h.relock})`);
    check("setVideoSize: フェイクカメラの captureStream の解像度が変わり video が 800x600 になる", r === "800x600" && info?.videoSizeChanges >= 1 && info.video[0] === 800 && info.video[1] === 600, `${r} video=${JSON.stringify(info?.video)} videoSizeChanges=${info?.videoSizeChanges}`);
    check("setVideoSize: relock=required を経て、マーカー再観測で ready", seen.includes("required") && after.relock === "ready", `遷移=${JSON.stringify(seen)}`);
    check("setVideoSize: 投影の pixelRect と XR 用 canvas が新しい映像寸法（800x600）", info?.projection?.pixelRectWidth === 800 && info.projection.pixelRectHeight === 600 && info.canvas[0] === 800 && info.canvas[1] === 600, JSON.stringify(info));
    check("setVideoSize 後も sq=1.000・self= が原点正面（±5cm。長辺の焦点係数から出した FOV でマーカー距離が合う）", after.sq === 1 && dist(after.self, START_POS) < 0.05, `${after.xrLine} self=${JSON.stringify(after.self)}`);

    await watchRelock(pA);
    await pA.send("Emulation.setDeviceMetricsOverride", { width: 900, height: 500, deviceScaleFactor: 1, mobile: false });
    await sleep(1500);
    const afterResize = await waitHud(pA, (h) => h.relock === "ready", 8000);
    const seenR = await relockSeen(pA);
    const infoR = await fakeXr(pA, "return { projection: x.projection?.cam, canvasSizeChanges: x.canvasSizeChanges, inner: [innerWidth, innerHeight], canvas: [document.querySelector('#xr-canvas').width, document.querySelector('#xr-canvas').height] };");
    console.log(`resize A: ${show(afterResize)} relock遷移=${JSON.stringify(seenR)} ${JSON.stringify(infoR)}`);
    check("resize: モックが XR 用 canvas と pixelRect を表示寸法で上書きしても、xr-source が映像寸法（800x600）へ戻す", infoR?.canvasSizeChanges >= 1 && infoR.inner[0] === 900 && infoR.projection?.pixelRectWidth === 800 && infoR.projection.pixelRectHeight === 600 && infoR.canvas[0] === 800 && infoR.canvas[1] === 600, JSON.stringify(infoR));
    check("resize 後もマーカー再観測で relock=ready", afterResize.relock === "ready", `${afterResize.xrLine} 遷移=${JSON.stringify(seenR)}`);
    await pA.send("Emulation.clearDeviceMetricsOverride");
    await sleep(1500);
    await waitHud(pA, (h) => h.relock === "ready", 8000);
  }

  // ---- 6. タブ復帰 ----
  {
    await watchRelock(pA);
    await pA.eval("Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange', { bubbles: true })); true");
    await sleep(500);
    const h = await waitHud(pA, (h) => h.relock === "ready", 8000);
    const seen = await relockSeen(pA);
    console.log(`visibility A: ${show(h)} relock遷移=${JSON.stringify(seen)}`);
    check("タブ復帰（visibilitychange → visible）: relock=required → マーカー再観測で ready", seen.includes("required") && h.relock === "ready", `遷移=${JSON.stringify(seen)}`);
  }

  // ---- 7. bfcache 復帰 → 再読み込みで再初期化 ----
  let aMe = aFire.me;
  {
    const loaded = pA.waitEvent("Page.loadEventFired", 20000);
    const navigated = pA.waitEvent("Page.frameNavigated", 20000);
    await pA.eval("dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })); true");
    const [nav, load] = await Promise.all([navigated, loaded]);
    console.log(`bfcache A: frameNavigated=${nav ? nav.frame.url.slice(0, 80) : "timeout"} loadEventFired=${load ? "yes" : "timeout"}`);
    const h = await waitHud(pA, (h) => h.me.startsWith("p") && h.xr === "NORMAL" && h.relock === "ready", 30000);
    console.log(`bfcache A after reload: ${show(h)}`);
    const reloaded = await pA.eval("performance.getEntriesByType('navigation')[0]?.type");
    check("bfcache 復帰（pageshow persisted）: location.reload() で再初期化され、再入室して xr=NORMAL・relock=ready", Boolean(nav && load) && reloaded === "reload" && h.me.startsWith("p") && h.xr === "NORMAL" && h.relock === "ready", `navigation=${reloaded} me=${h.me} ${h.xrLine}`);
    aMe = h.me;
    await sleep(4000);
  }

  // ---- 8. 実バイナリ smoke（C） ----
  {
    const get = async (path) => {
      const r = await fetch(`${ORIGIN}${path}`).catch((e) => ({ ok: false, status: -1, headers: new Headers(), text: async () => String(e) }));
      return { status: r.status, type: r.headers.get("content-type") ?? "", body: r.status === 200 ? await r.text() : "" };
    };
    const [xrJs, slamJs, lic, res] = await Promise.all(["/vendor/8thwall/xr.js", "/vendor/8thwall/xr-slam.js", "/vendor/8thwall/LICENSE", "/vendor/8thwall/resources/powered-by.svg"].map(get));
    check("実バイナリ: /vendor/8thwall/xr.js・xr-slam.js が 200 で text/javascript", xrJs.status === 200 && /text\/javascript/.test(xrJs.type) && slamJs.status === 200 && /text\/javascript/.test(slamJs.type), `xr.js ${xrJs.status} ${xrJs.type} ${xrJs.body.length}B / xr-slam.js ${slamJs.status} ${slamJs.type} ${slamJs.body.length}B`);
    check("実バイナリ: /vendor/8thwall/LICENSE が text/plain で先頭に Niantic", lic.status === 200 && /text\/plain/.test(lic.type) && /Niantic/.test(lic.body.slice(0, 200)), `${lic.status} ${lic.type} "${lic.body.slice(0, 60).replace(/\n/g, " ")}"`);
    check("実バイナリ: resources/ の 1 ファイル（powered-by.svg）が 200", res.status === 200, `${res.status} ${res.type}`);

    // 起動を待つ（xr-source の映像待ちタイムアウトは 30s）
    let c = await readHud(pC);
    while (Date.now() - tC0 < 45000 && !/^cam=.*(Error|失敗|タイムアウト|x\d+)/m.test(c.raw)) {
      await sleep(1000);
      c = await readHud(pC);
    }
    const xr8 = await pC.eval("({ hasXR8: Boolean(window.XR8), hasXrController: Boolean(window.XR8?.XrController), version: window.XR8?.version ?? null, keys: window.XR8 ? Object.keys(window.XR8).slice(0, 40) : [] })");
    const vendorResponses = pC.responses.filter((r) => /8thwall|^\d/.test(r.url)).map((r) => `${r.status} ${r.mime} ${r.url.replace(ORIGIN, "")}`);
    console.log(`--- C（実バイナリ, ${((Date.now() - tC0) / 1000).toFixed(1)}s） ---`);
    console.log(`C HUD:\n${c.raw}`);
    console.log(`C XR8: ${JSON.stringify(xr8)}`);
    console.log(`C 8thwall responses:\n  ${vendorResponses.join("\n  ") || "(なし)"}`);
    console.log(`C console (${pC.logs.length}):\n  ${pC.logs.slice(0, 20).join("\n  ") || "(なし)"}`);
    console.log(`C exceptions: ${pC.exceptions.length ? pC.exceptions.join(" | ") : "(なし)"}`);
    check("実バイナリ: xrloaded 後に window.XR8.XrController が存在（SLAM chunk が読めた）", xr8?.hasXrController === true, JSON.stringify({ hasXR8: xr8?.hasXR8, version: xr8?.version }));
    check("実バイナリ: desktop では起動せず、HUD の cam= か xr= に失敗理由が出る", /^cam=.*(Error|失敗|タイムアウト)/m.test(c.raw) || /^xr=failed/m.test(c.raw), `${c.cam} | ${c.xrLine}`);
    check("実バイナリ: C のページに未捕捉例外が無い", pC.exceptions.length === 0, pC.exceptions.slice(0, 2).join(" | "));
  }

  // ---- 8b. 先行読み込み（D: autostart 無しで開始ボタンを押さない） ----
  {
    const pD = await newWindow("D");
    await pD.send("Network.enable");
    await pD.send("Page.navigate", { url: `${BASE}?fakehands=1&name=Pre&room=${ROOM_REAL}` });
    const tD0 = Date.now();
    let d = null;
    while (Date.now() - tD0 < 30000) {
      d = await pD.eval("({ started: document.body.classList.contains('started'), hasXrController: Boolean(window.XR8?.XrController) })");
      if (d?.hasXrController) break;
      await sleep(500);
    }
    const urls = pD.responses.filter((r) => /\/vendor\/8thwall\//.test(r.url)).map((r) => `${r.status} ${r.url.replace(ORIGIN, "")}`);
    console.log(`D（開始前, ${((Date.now() - tD0) / 1000).toFixed(1)}s）: ${JSON.stringify(d)} vendor=${JSON.stringify(urls)}`);
    check("先行読み込み: 開始ボタンの前に xr.js と xr-slam.js が読み込まれ、XR8.XrController がある", d?.started === false && d.hasXrController === true && urls.some((u) => /^200 .*\/xr\.js/.test(u)) && urls.some((u) => /^200 .*\/xr-slam\.js/.test(u)), JSON.stringify(urls));
    check("先行読み込み: D のページに未捕捉例外が無い", pD.exceptions.length === 0, pD.exceptions.slice(0, 2).join(" | "));
    await browser.send("Target.closeTarget", { targetId: pD.targetId });
  }

  // ---- 9. 俯瞰画面と例外 ----
  {
    const ov = await readOverview();
    const ovPlayers = (ov.match(/players=(\S*)/)?.[1] ?? "").split(",").filter(Boolean);
    const pm = ov.match(/peerMarkers=(\S*)/)?.[1] ?? "";
    check("最後に俯瞰画面が 2 人を表示し、再入室した A もマーカーで追跡中", /ws=open/.test(ov) && ovPlayers.length === 2 && new RegExp(`\\b${aMe}:0\\b`).test(pm), `players=${ovPlayers.join(",")} peerMarkers=${pm}`);
  }
  const exceptions = pages.flatMap((p) => p.exceptions.map((e) => `${p.name}: ${e}`));
  check("A・B・俯瞰画面で例外が出ていない", exceptions.length === 0, exceptions.slice(0, 2).join(" | "));

  const failed = results.filter(([, ok]) => !ok);
  console.log(failed.length === 0 ? "\nALL PASS" : `\n${failed.length} FAILED:\n${failed.map(([n]) => `  - ${n}`).join("\n")}`);
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
