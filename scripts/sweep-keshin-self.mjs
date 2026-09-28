// ex9-1-keshin: 主観（見上げたときの自分の化身）の見え方を、パラメータを振って 1 枚のコンタクトシートにする。
// `node scripts/sweep-keshin-self.mjs` で実行する（ヘッドレス Chrome。モデルは local-assets/keshin/ にあれば実モデル）。
// 3 体 × 見上げ角 45° / 60° / 75° × 設定（下の SETTINGS）を、スマホのページ（フェイクカメラ）の左目で撮って並べ、
// 各コマに設定値と数値（化身の画素・目の近くを消した割合・視界の中心 50% を覆う割合）を入れる。
// 出力: logs/keshin-check/self-sweep.png と self-sweep.json
// 数値の意味:
//   px     = 化身（とそのオーラ）を描いたときと描かないときで変わった画素（左右 2 眼込み）
//   lost   = 目から 0.6m 以内を消したことで欠けた画素の割合（1 − px / 消さないときの px）。目のすぐ前の部分は画面を大きく覆うので大きく出る
//   nearV  = 描いている部分（腰より上）の頂点のうち目から 0.6m 以内の割合（モデルのどれだけが消えたか）。基準は 1 割程度まで
//   center = 各眼の中心 50%（幅・高さとも）のうち化身が覆っている割合（視界の中心を完全には塞がない）
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 5223;
const CDP_PORT = 9362;
const BASE = `https://localhost:${PORT}/demos/ex9-1-keshin/`;
const ROOM = `sweep${Date.now() % 100000}`;
const PHONE = `fov=70&camZoom=1&fakecam=1&autostart=1&fakeMarkerPx=80&room=${ROOM}&remoteLog=0`;
const OUT_DIR = join(ROOT, "logs", "keshin-check");
const ANGLES = [45, 60, 75];
/** 設定（back: null = 顔の位置から自動） */
const SETTINGS = process.env.SWEEP_SETTINGS ? JSON.parse(process.env.SWEEP_SETTINGS) : [
  { key: "S1", label: "lean 35 / face +0.25（旧既定）", lean: 35, face: 0.25, back: null },
  { key: "S2", label: "lean 15 / face 0（頭をもっと後ろ・上）", lean: 15, face: 0, back: null },
  { key: "S3", label: "lean 0 / back 0.6（直立・後ろへ）", lean: 0, face: 0, back: 0.6 },
  { key: "S4", label: "lean 35 / face +0.7（前へ出す。ペガサス・ランスロットの既定）", lean: 35, face: 0.7, back: null },
  { key: "S5", label: "lean 50 / face +1.0（前へ大きく出して倒す。魔神の既定）", lean: 50, face: 1.0, back: null },
  { key: "S6", label: "lean 20 / face +1.0（前に立つ・背中を見る）", lean: 20, face: 1.0, back: null },
];
const NAMES = ["魔神", "ペガサス", "ランスロット"];
const TILE_W = 256;
/** 片目（640×577 前後）を縮めたときの高さ（コマの枠。実際の画像は縦横比を保って上に置く） */
const TILE_H = 232;

if (!existsSync(CHROME)) {
  console.log(`SKIP: Chrome が見つかりません (${CHROME})`);
  process.exit(0);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
let portInUse = false;
server.stderr.on("data", (d) => {
  if (/already in use/.test(d.toString())) portInUse = true;
});
let serverExited = false;
server.on("exit", () => {
  serverExited = true;
});
async function waitForServer(timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (serverExited || portInUse) return false;
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
async function openPage(target, name) {
  const page = new Page(target.webSocketDebuggerUrl, name);
  await page.ready();
  await page.send("Runtime.enable");
  await page.send("Page.enable");
  return page;
}
async function waitUntil(fn, timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await sleep(250);
  }
  return null;
}

const profile = mkdtempSync(join(tmpdir(), "mobile-mr-chrome-"));
let chrome = null;
let exitCode = 1;
try {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  mkdirSync(OUT_DIR, { recursive: true });
  if (!(await waitForServer())) throw new Error(`dev サーバーが起動しなかった（ポート ${PORT}）`);
  chrome = spawn(
    CHROME,
    ["--headless=new", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, "--ignore-certificate-errors", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required", "--no-first-run", "--window-size=1280,720", "--enable-unsafe-swiftshader", "about:blank"],
    { stdio: "ignore" },
  );
  const first = (await cdpJson("/json")).find((t) => t.type === "page");
  const browser = new Page((await cdpJson("/json/version")).webSocketDebuggerUrl, "browser");
  await browser.ready();
  const newWindow = async (name) => {
    const created = await browser.send("Target.createTarget", { url: "about:blank", newWindow: true });
    return openPage((await cdpJson("/json")).find((x) => x.id === created.result.targetId), name);
  };
  // 参加順で化身 0・1・2 が割り当てられる
  const phones = [];
  for (let i = 0; i < 3; i++) {
    const p = i === 0 ? await openPage(first, `phone${i}`) : await newWindow(`phone${i}`);
    await p.send("Page.navigate", { url: `${BASE}?${PHONE}&name=S${i}` });
    const s = await waitUntil(async () => {
      const st = await p.eval("window.__keshin?.state() ?? null");
      return st && st.me && st.keshin === i && (st.model === "loaded" || st.model === "missing") && st.track === "marker" ? st : null;
    });
    if (!s) throw new Error(`phone${i} が準備できない`);
    console.log(`phone${i}: keshin=${s.keshin} model=${s.model}`);
    await p.eval("document.querySelector('#keshin-button').click()");
    phones.push(p);
  }
  await sleep(3000); // 出現の演出と視界内メッセージ（2.5s）が終わるまで
  const results = [];
  const tiles = [];
  for (const [mi, p] of phones.entries()) {
    // 撮影の邪魔になる DOM（HUD・ボタン）を消す
    await p.eval("for (const s of ['#hud', '#keshin-button', '#fs-button']) { const e = document.querySelector(s); if (e) e.style.display = 'none'; }");
    for (const st of SETTINGS) {
      await p.eval(`window.__keshin.setSelfTuning(${st.lean}, ${st.face}, ${st.back === null ? "null" : st.back})`);
      for (const ang of ANGLES) {
        await p.eval(`window.__keshin.setLook(${ang})`);
        await sleep(350);
        const px = await p.eval("window.__keshin.pixelDiff()");
        await p.eval("window.__keshin.setNearFade(0, 0)");
        const pxNo = await p.eval("window.__keshin.pixelDiff()");
        await p.eval("window.__keshin.setNearFade(0.6, 0.75)");
        await sleep(120);
        // 左目（ページの左半分）だけを撮る
        const vw = await p.eval("[innerWidth, innerHeight]");
        const shot = await p.send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: vw[0] / 2, height: vw[1], scale: TILE_W / (vw[0] / 2) } });
        const back = await p.eval("window.__keshin.state().back");
        const nearV = await p.eval("window.__keshin.nearVertexFraction(0.6)");
        const r = {
          model: mi,
          setting: st.key,
          angle: ang,
          back: Math.round(back * 1000) / 1000,
          px: px.changed,
          lost: pxNo.changed > 0 ? Math.max(0, 1 - px.changed / pxNo.changed) : 0,
          center: px.center / (0.25 * px.total),
          nearV,
        };
        results.push(r);
        tiles.push({ ...r, data: shot.result.data });
        console.log(`${NAMES[mi]} ${st.key} ${ang}°: back=${r.back} px=${r.px} lost=${(r.lost * 100).toFixed(0)}% nearV=${(r.nearV * 100).toFixed(0)}% center=${(r.center * 100).toFixed(0)}%`);
      }
    }
  }
  // コンタクトシート: 行 = 設定、列 = 化身 × 見上げ角
  const sheet = await phones[0].eval(`(async () => {
    const tiles = ${JSON.stringify(tiles)};
    const settings = ${JSON.stringify(SETTINGS)};
    const names = ${JSON.stringify(NAMES)};
    const angles = ${JSON.stringify(ANGLES)};
    const TW = ${TILE_W}, TH = ${TILE_H}, LABEL = 34, LEFT = 230, TOP = 60, GAP = 6;
    const cols = names.length * angles.length;
    const c = document.createElement('canvas');
    c.width = LEFT + cols * (TW + GAP);
    c.height = TOP + settings.length * (TH + LABEL + GAP);
    const g = c.getContext('2d');
    g.fillStyle = '#14161a'; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#e8eaed'; g.font = 'bold 18px system-ui, sans-serif';
    g.fillText('ex9-1 主観（見上げ・左目）: 行 = 設定、列 = 化身 × 見上げ角。back = 原点の後ろへのずれ[m] / 欠 = 目から 0.6m で消えた画素の割合 / 頂点 = 消えた頂点の割合（緑 ≤ 15%）/ 中心 = 各眼の中心 50% を覆う割合 / px = 化身の画素', 10, 24);
    for (let m = 0; m < names.length; m++) for (let a = 0; a < angles.length; a++) {
      g.font = 'bold 16px system-ui, sans-serif';
      g.fillText(names[m] + ' 見上げ ' + angles[a] + '°', LEFT + (m * angles.length + a) * (TW + GAP) + 6, 50);
    }
    const load = (d) => new Promise((res) => { const im = new Image(); im.onload = () => res(im); im.src = 'data:image/png;base64,' + d; });
    for (let r = 0; r < settings.length; r++) {
      const y0 = TOP + r * (TH + LABEL + GAP);
      g.fillStyle = '#e8eaed'; g.font = 'bold 15px system-ui, sans-serif';
      const words = (settings[r].key + ' ' + settings[r].label).split('（');
      g.fillText(words[0], 8, y0 + 30);
      if (words[1]) g.fillText('（' + words[1], 8, y0 + 52);
      for (const t of tiles.filter((t) => t.setting === settings[r].key)) {
        const col = t.model * angles.length + angles.indexOf(t.angle);
        const x0 = LEFT + col * (TW + GAP);
        const im = await load(t.data);
        g.drawImage(im, x0, y0, TW, Math.min(TH, im.height * TW / im.width));
        g.fillStyle = t.nearV > 0.15 ? '#f28b82' : '#81c995';
        g.font = '12px system-ui, sans-serif';
        g.fillText('back ' + t.back.toFixed(2) + ' 欠 ' + Math.round(t.lost * 100) + '% 頂点 ' + Math.round(t.nearV * 100) + '% 中心 ' + Math.round(t.center * 100) + '%', x0 + 2, y0 + TH + 16);
        g.fillText('px ' + t.px, x0 + 2, y0 + TH + 30);
      }
    }
    return c.toDataURL('image/png').split(',')[1];
  })()`);
  const out = join(OUT_DIR, "self-sweep.png");
  writeFileSync(out, Buffer.from(sheet, "base64"));
  writeFileSync(join(OUT_DIR, "self-sweep.json"), JSON.stringify({ settings: SETTINGS, angles: ANGLES, results }, null, 2));
  console.log(`SHEET: ${out}`);
  const ex = phones.flatMap((p) => p.exceptions);
  if (ex.length) console.log(`exceptions: ${ex.slice(0, 3).join(" | ")}`);
  exitCode = ex.length ? 1 : 0;
} catch (e) {
  console.error("実行エラー:", e.message ?? e);
} finally {
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
