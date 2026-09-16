// 01-stereo-box を mobile-mr-sdk/core（createSession）へ置き換えた開始導線をヘッドレス Chrome で確認する。
// `npm run check:stereo-box` で実行する。仕組みは headless-chrome-flow.mjs と同じ（CDP を ws で直接叩く。
// Chrome が無ければスキップ）。
//   A. タッチ端末（縦持ち）を模擬 → Android Chrome 相当の経路:
//      - 開始タップで sensor=（granted or no-permission-api）→ 3 秒でイベントが来なければ no-events
//      - fs= / lock= / wake= が HUD に出る。fs が needs-tap のときだけ #fs-button が出る
//      - 縦持ちなので「横向きにしてください」が出る / 長押しの contextmenu が抑止される
//   B. PC（マウス）: 許可・全画面・Wake Lock を飛ばし mode=orbit で開始する
//   - どちらも例外が出ていない（file: で参照した SDK が Vite から読めていることの確認を兼ねる）
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const CHROME =
  process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 5194;
const CDP_PORT = 9341;
const BASE = `https://localhost:${PORT}/demos/01-stereo-box/`;

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

const server = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], {
  stdio: ["ignore", "ignore", "pipe"],
});
let serverExited = false;
server.stderr.on("data", (d) => {
  const text = d.toString();
  process.stderr.write(text);
  if (/already in use/i.test(text)) serverExited = true;
});
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
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.exceptions = [];
    this.ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      if (m.id && this.pending.has(m.id)) {
        this.pending.get(m.id)(m);
        this.pending.delete(m.id);
      } else if (m.method === "Runtime.exceptionThrown") {
        this.exceptions.push(
          `${m.params.exceptionDetails.text} ${m.params.exceptionDetails.exception?.description ?? ""}`,
        );
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
    const r = await this.send("Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    return r.result?.result?.value ?? null;
  }
  hud() {
    return this.eval(`document.querySelector('#hud').textContent`);
  }
  display(selector) {
    return this.eval(`getComputedStyle(document.querySelector('${selector}')).display`);
  }
  /** 開始ボタンを本物のクリック（user activation 付き）で押す */
  async clickStart() {
    await this.eval(`document.querySelector('#start-button').scrollIntoView({ block: 'center' })`);
    const box = await this.eval(
      `(() => { const r = document.querySelector('#start-button').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
    );
    for (const type of ["mousePressed", "mouseReleased"]) {
      await this.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
    }
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

async function newPage(browser, opts = {}) {
  const created = await browser.send("Target.createTarget", { url: "about:blank", newWindow: true, ...opts });
  const targets = await cdpJson("/json");
  const page = new Page(targets.find((t) => t.id === created.result.targetId).webSocketDebuggerUrl);
  await page.ready();
  await page.send("Runtime.enable");
  await page.send("Page.enable");
  return page;
}

const profile = mkdtempSync(join(tmpdir(), "mobile-mr-stereo-box-"));
let chrome = null;
let exitCode = 1;
try {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  if (!(await waitForServer())) {
    throw new Error(`dev サーバーが起動しなかった（ポート ${PORT} が使用中でないか確認）`);
  }
  chrome = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`,
      "--ignore-certificate-errors",
      "--autoplay-policy=no-user-gesture-required",
      "--no-first-run",
      "--window-size=1280,720",
      "--enable-unsafe-swiftshader",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const version = await cdpJson("/json/version");
  const browser = new Page(version.webSocketDebuggerUrl);
  await browser.ready();

  // ---- A: タッチ端末（縦持ち）を模擬 → Android Chrome 相当の経路 ----
  const pa = await newPage(browser);
  await pa.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await pa.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await pa.send("Page.navigate", { url: `${BASE}?fov=70` });
  await sleep(2500);
  check("A: ページが読み込めた（SDK の import を含めて例外なし）", pa.exceptions.length === 0, pa.exceptions.join(" | "));
  check("A: pointer: coarse が真（タッチ端末として扱われる）", await pa.eval(`matchMedia("(pointer: coarse)").matches`));
  check("A: 開始前は「横向きにしてください」が出ていない", (await pa.display("#rotate-hint")) === "none");
  check("A: 開始前は #fs-button が隠れている", await pa.eval(`document.querySelector('#fs-button').hidden`));
  await pa.clickStart();
  await sleep(800);
  check("A: 開始できた（body.started）", await pa.eval(`document.body.classList.contains('started')`));
  let hud = await pa.hud();
  check("A: mode=gyro（タッチ経路）", /mode=gyro/.test(hud));
  check("A: sensor= が HUD に出る（許可 API 無し or 即 granted）", /sensor=(no-permission-api|granted)/.test(hud), hud.match(/sensor=[^\n]*/)?.[0]);
  check("A: wake= が HUD に出る", /wake=/.test(hud), hud.match(/wake=\S+/)?.[0]);
  await sleep(3500);
  hud = await pa.hud();
  check("A: 3 秒でイベントが来なければ no-events（Mac にはセンサーが無い）", /sensor=(no-permission-api|granted) no-events/.test(hud), hud.match(/sensor=[^\n]*/)?.[0]);
  check("A: fs= の結果が HUD に出る", /fs=\S+/.test(hud), hud.match(/fs=[^\n]*/)?.[0]);
  const fsLine = hud.match(/fs=([^\n]*)/)?.[1] ?? "";
  const fsOk = /^(ok|unsupported)/.test(fsLine);
  const buttonHidden = await pa.eval(`document.querySelector('#fs-button').hidden`);
  check("A: fs が ok / unsupported なら #fs-button は隠れ、それ以外（needs-tap）なら出る", fsOk === buttonHidden, `fs=${fsLine} hidden=${buttonHidden}`);
  if (fsOk && /^ok/.test(fsLine)) check("A: 全画面化に成功したら lock= が続く", /lock=/.test(fsLine), fsLine);
  check("A: 縦持ちなので「横向きにしてください」が出る", (await pa.display("#rotate-hint")) === "flex");
  check("A: contextmenu が抑止される（長押しで押し続けが切れない）", await pa.eval(`!document.querySelector('#app').dispatchEvent(new MouseEvent('contextmenu', { cancelable: true, bubbles: true }))`));
  check("A: 描画ループが回っている（canvas がある）", await pa.eval(`Boolean(document.querySelector('#app canvas'))`));
  check("A: loop-error が出ていない", !/loop-error/.test(hud), hud.match(/loop-error[^\n]*/)?.[0]);
  check("A: 例外なし", pa.exceptions.length === 0, pa.exceptions.join(" | "));

  // ---- B: PC（マウス） ----
  const pb = await newPage(browser, { width: 1280, height: 720 });
  await pb.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await pb.send("Page.navigate", { url: `${BASE}` });
  await sleep(2500);
  check("B: pointer: coarse が偽（PC）", !(await pb.eval(`matchMedia("(pointer: coarse)").matches`)));
  await pb.clickStart();
  await sleep(800);
  check("B: 開始済み", await pb.eval(`document.body.classList.contains('started')`));
  hud = await pb.hud();
  check("B: mode=orbit", /mode=orbit/.test(hud));
  check("B: PC では sensor= / fs= / wake= を出さない", !/sensor=|fs=|wake=/.test(hud), hud);
  check("B: #fs-button は隠れたまま", await pb.eval(`document.querySelector('#fs-button').hidden`));
  check("B: 例外なし", pb.exceptions.length === 0, pb.exceptions.join(" | "));

  const failed = results.filter(([, ok]) => !ok).length;
  console.log(failed ? `${failed} FAILED` : "ALL PASS");
  exitCode = failed ? 1 : 0;
} catch (e) {
  console.error(e);
} finally {
  if (chrome && chrome.exitCode === null && chrome.signalCode === null) {
    const exited = new Promise((resolve) => chrome.once("exit", resolve));
    chrome.kill();
    await Promise.race([exited, sleep(2000)]);
  }
  server.kill();
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
process.exit(exitCode);
