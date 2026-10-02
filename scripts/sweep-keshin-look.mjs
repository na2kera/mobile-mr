// ex9-1-keshin 段階 3 の C: 他人用の化身の「背中からビヨーンと出る」見え方を、パラメータを振って 1 枚のコンタクトシートにする。
// `node scripts/sweep-keshin-look.mjs` で実行する（ヘッドレス Chrome。モデルは local-assets/keshin/ にあれば実モデル）。
// 鏡モード（mirror.html?fakeperson=1。iPad の前面カメラのまね: 水平の画角 106°・画面 1180×820）に合成の人を 1 人立たせ、
// Node の WebSocket の仮想プレイヤー 4 人（参加順で化身 0・1・2・3。人数 = NAMES の数）のうち 1 人だけ化身を出して撮る。
// 行 = 設定（下の SETTINGS）、列 = 化身 × 人の距離（1.3m / 2.5m）。各コマに設定値と数値:
//   人の上 = 人の形で隠す処理を切った状態で、化身（モデル）が人の画素に重なった画素数（本人の頭・肩に被らないなら 0 に近い）
//   頭 = 化身のいちばん上が画面の上で切れているか（切 = 切れている / 入 = 入っている）
// 出力: logs/keshin-check/look-sweep.png と look-sweep.json
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { KESHIN_PATH, KESHIN_PROTOCOL_VERSION } from "../src/shared/keshin-protocol.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 5224;
const CDP_PORT = 9363;
const BASE = `https://localhost:${PORT}/demos/ex9-1-keshin/`;
const ROOM = `look${Date.now() % 100000}`;
const OUT_DIR = join(ROOT, "logs", "keshin-check");
/** 人の距離 [m]（カメラ座標系の頭の z）。頭の高さはカメラより 0.3m 上（スタンドの iPad が胸の高さ）。SWEEP_DISTANCES（JSON）で差し替えられる */
const DISTANCES = process.env.SWEEP_DISTANCES ? JSON.parse(process.env.SWEEP_DISTANCES) : [1.3, 2.5];
/** 設定（look=0 は段階 2 までの見え方。比較用） */
// showBelowM / dissolveM を書かない行は化身ごとの既定（KESHIN_SPECS の below）。書くと全員を上書きする
const SETTINGS = process.env.SWEEP_SETTINGS ? JSON.parse(process.env.SWEEP_SETTINGS) : [
  { key: "L0", label: "段階 2 まで（腰で切る・頭の高さ）", q: "look=0" },
  { key: "D", label: "既定（切り口・溶けは化身ごと）", q: "" },
  { key: "L1", label: "腰 頭+0.3 / 間隔 0.4 / 溶け 0.4 / 流れ 0.06-0.25", q: "waistAboveHeadM=0.3&backClearM=0.4&dissolveM=0.4&streamR0=0.06&streamR1=0.25" },
  { key: "L2", label: "腰 頭+0.5 / 間隔 0.7 / 溶け 0.6 / 流れ 0.07-0.32", q: "waistAboveHeadM=0.5&backClearM=0.7&dissolveM=0.6&streamR0=0.07&streamR1=0.32" },
  { key: "L3", label: "腰 頭+0.7 / 間隔 1.0 / 溶け 0.8 / 流れ 0.08-0.4", q: "waistAboveHeadM=0.7&backClearM=1.0&dissolveM=0.8&streamR0=0.08&streamR1=0.4" },
];
const NAMES = ["魔神", "ペガサス", "ランスロット", "マエストロ"];
const TILE_W = 236;
const TILE_H = 164;

if (!existsSync(CHROME)) {
  console.log(`SKIP: Chrome が見つかりません (${CHROME})`);
  process.exit(0);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
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
    this.ws = new WebSocket(wsUrl, { maxPayload: 256 * 1024 * 1024 });
    this.id = 0;
    this.pending = new Map();
    this.exceptions = [];
    this.ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      if (m.id && this.pending.has(m.id)) {
        this.pending.get(m.id)(m);
        this.pending.delete(m.id);
      } else if (m.method === "Runtime.exceptionThrown") {
        this.exceptions.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
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
    const r = await this.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(`${this.name}: ${r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text}`);
    return r.result?.result?.value ?? null;
  }
}
async function cdpJson(path) {
  for (let i = 0; i < 50; i++) {
    try {
      return await (await fetch(`http://127.0.0.1:${CDP_PORT}${path}`)).json();
    } catch {
      await sleep(200);
    }
  }
  throw new Error("Chrome の DevTools ポートに接続できない");
}
async function waitUntil(fn, timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await sleep(200);
  }
  return null;
}
/** 仮想プレイヤー（化身の on/off だけ送る） */
function virtualPlayer(name, session) {
  const q = new URLSearchParams({ room: ROOM, role: "player", v: String(KESHIN_PROTOCOL_VERSION), markerId: "0", markerMm: "150", name, session });
  const ws = new WebSocket(`wss://localhost:${PORT}${KESHIN_PATH}?${q}`, { rejectUnauthorized: false, headers: { origin: `https://localhost:${PORT}` } });
  const msgs = [];
  ws.on("message", (d) => msgs.push(JSON.parse(d.toString())));
  ws.on("error", () => {});
  return {
    ws,
    msgs,
    welcome: () => waitUntil(async () => msgs.find((m) => m.type === "welcome"), 8000),
    keshin: (on) => ws.send(JSON.stringify({ type: "keshin", on })),
  };
}

const profile = mkdtempSync(join(tmpdir(), "mobile-mr-chrome-"));
let chrome = null;
let exitCode = 1;
const players = [];
try {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  mkdirSync(OUT_DIR, { recursive: true });
  if (!(await waitForServer())) throw new Error(`dev サーバーが起動しなかった（ポート ${PORT}）`);
  for (let i = 0; i < NAMES.length; i++) {
    const p = virtualPlayer(`K${i}`, `lookSweepPlayer${i}xx`);
    const w = await p.welcome();
    const me = w.players.find((x) => x.id === w.id);
    console.log(`player ${w.id}: keshin=${me?.keshin}`);
    p.id = w.id;
    p.index = me?.keshin;
    players.push(p);
  }
  chrome = spawn(
    CHROME,
    ["--headless=new", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, "--ignore-certificate-errors", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required", "--no-first-run", "--window-size=1180,820", "--enable-unsafe-swiftshader", "about:blank"],
    { stdio: "ignore" },
  );
  const first = (await cdpJson("/json")).find((t) => t.type === "page");
  const page = new Page(first.webSocketDebuggerUrl, "mirror");
  await page.ready();
  await page.send("Runtime.enable");
  await page.send("Page.enable");
  const tiles = [];
  const results = [];
  for (const st of SETTINGS) {
    await page.send("Page.navigate", { url: `${BASE}mirror.html?room=${ROOM}&fakecam=1&fakeperson=1&autostart=1&remoteLog=0&camFov=106&${st.q}` });
    const ok = await waitUntil(async () => {
      const s = await page.eval("window.__keshinMirror?.state() ?? null").catch(() => null);
      return s && s.me && s.persons.length === 1 && s.entries.length === NAMES.length ? s : null;
    });
    if (!ok) throw new Error(`${st.key}: 鏡が準備できない`);
    await page.eval("for (const s of ['#hud', '#mirror-message', '#fs-button']) { const e = document.querySelector(s); if (e) e.style.display = 'none'; }");
    // SWEEP_NO_OCCLUSION=1: 人の形で隠す処理を切って撮る（人の後ろに隠れた化身の切り口を確かめる用）
    if (process.env.SWEEP_NO_OCCLUSION) await page.eval("window.__keshinMirror.setOcclusionDisabled(true)");
    for (const pl of players.sort((a, b) => a.index - b.index)) {
      pl.keshin(true);
      for (const d of DISTANCES) {
        await page.eval(`window.__keshinMirror.setFakePeople([{ head: [0, 0.3, ${-d}], yawDeg: 0 }])`);
        await waitUntil(async () => {
          const s = await page.eval("window.__keshinMirror.state()");
          const e = s.entries.find((x) => x.id === pl.id);
          return e && e.drawn && e.head && Math.abs(e.head[2] + d) < 0.02 ? e : null;
        }, 10000);
        await sleep(1900);
        const px = await page.eval(`window.__keshinMirror.pixelDiff(${JSON.stringify(pl.id)}, false)`);
        const shot = await page.send("Page.captureScreenshot", { format: "jpeg", quality: 85 });
        const r = { setting: st.key, model: pl.index, dist: d, over: px?.inside ?? -1, cut: px ? px.topY <= 0 : null, topY: px?.topY, personTopY: px?.personTopY, px: px?.changed };
        results.push(r);
        tiles.push({ ...r, data: shot.result.data });
        if (process.env.SWEEP_SAVE_TILES) {
          mkdirSync(join(OUT_DIR, "look-tiles"), { recursive: true });
          writeFileSync(join(OUT_DIR, "look-tiles", `${st.key}-${pl.index}-${d}.jpg`), Buffer.from(shot.result.data, "base64"));
        }
        console.log(`${st.key} ${NAMES[pl.index]} ${d}m: 人の上=${r.over} 頭=${r.cut ? "切" : "入"} top=${r.topY} personTop=${r.personTopY} px=${r.px}`);
      }
      pl.keshin(false);
      await sleep(1300);
    }
  }
  const sheet = await page.eval(`(async () => {
    const tiles = ${JSON.stringify(tiles)};
    const settings = ${JSON.stringify(SETTINGS)};
    const names = ${JSON.stringify(NAMES)};
    const dists = ${JSON.stringify(DISTANCES)};
    const TW = ${TILE_W}, TH = ${TILE_H}, LABEL = 20, LEFT = 250, TOP = 60, GAP = 6;
    const cols = names.length * dists.length;
    const c = document.createElement('canvas');
    c.width = LEFT + cols * (TW + GAP);
    c.height = TOP + settings.length * (TH + LABEL + GAP);
    const g = c.getContext('2d');
    g.fillStyle = '#14161a'; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#e8eaed'; g.font = 'bold 16px system-ui, sans-serif';
    g.fillText('ex9-1 鏡モード（iPad 前面 106°）: 行 = 設定、列 = 化身 × 人の距離。人の上 = 隠す処理なしで化身が人に重なった画素（0 に近いほど良い）/ 頭 = 化身の頭が画面の上で切れているか', 10, 24);
    for (let m = 0; m < names.length; m++) for (let a = 0; a < dists.length; a++) {
      g.font = 'bold 15px system-ui, sans-serif';
      g.fillText(names[m] + ' ' + dists[a] + 'm', LEFT + (m * dists.length + a) * (TW + GAP) + 6, 50);
    }
    const load = (d) => new Promise((res) => { const im = new Image(); im.onload = () => res(im); im.src = 'data:image/jpeg;base64,' + d; });
    for (let r = 0; r < settings.length; r++) {
      const y0 = TOP + r * (TH + LABEL + GAP);
      g.fillStyle = '#e8eaed'; g.font = 'bold 14px system-ui, sans-serif';
      const parts = (settings[r].key + ' ' + settings[r].label).split(' / ');
      parts.forEach((p, i) => g.fillText(p, 8, y0 + 22 + i * 20));
      for (const t of tiles.filter((t) => t.setting === settings[r].key)) {
        const col = t.model * dists.length + dists.indexOf(t.dist);
        const x0 = LEFT + col * (TW + GAP);
        const im = await load(t.data);
        g.drawImage(im, x0, y0, TW, TH);
        g.fillStyle = t.over > 200 ? '#f28b82' : '#81c995';
        g.font = '12px system-ui, sans-serif';
        g.fillText('人の上 ' + t.over + ' / 頭 ' + (t.cut ? '切' : '入'), x0 + 2, y0 + TH + 14);
      }
    }
    return c.toDataURL('image/png').split(',')[1];
  })()`);
  const out = join(OUT_DIR, "look-sweep.png");
  writeFileSync(out, Buffer.from(sheet, "base64"));
  writeFileSync(join(OUT_DIR, "look-sweep.json"), JSON.stringify({ settings: SETTINGS, distances: DISTANCES, results }, null, 2));
  console.log(`SHEET: ${out}`);
  if (page.exceptions.length) console.log(`exceptions: ${page.exceptions.slice(0, 3).join(" | ")}`);
  exitCode = page.exceptions.length ? 1 : 0;
} catch (e) {
  console.error("実行エラー:", e.message ?? e);
} finally {
  for (const p of players) p.ws.close();
  chrome?.kill();
  server.kill();
  await sleep(500);
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // 一時ディレクトリ
  }
}
process.exit(exitCode);
