// Chrome での開始導線（src/shared/start-flow.ts）をヘッドレス Chrome で確認する。
// `npm run check:chrome-flow` で実行する。仕組みは headless-splatoon.mjs と同じ（CDP を ws で直接叩く。
// Chrome が無ければスキップ）。08 のページを題材に、
//   A. タッチ端末（縦持ち）を模擬 → Android Chrome 相当の経路:
//      - Chrome の DeviceOrientationEvent.requestPermission はダイアログ無しで granted を返し、
//        HUD に sensor= が出る。Mac にはセンサーが無いので 3 秒後に no-events が付く
//        （Chrome の「モーションセンサー」ブロックを実機で見分けるための表示）
//      - 全画面化 fs= と横向き固定 lock= の結果、Wake Lock の wake= が HUD に出る
//      - 縦持ちなので「横向きにしてください」が出る / 長押しの contextmenu が抑止される
//   B. PC（マウス）の縦長ウィンドウ: 「横向きにしてください」が出ず（OrbitControls のドラッグを塞がない）、
//      タッチ端末向けの表示（wake= / sensor=）も出ない
//   - 例外が出ていない
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const CHROME =
  process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 5193;
const CDP_PORT = 9340;
const BASE = `https://localhost:${PORT}/demos/08-splatoon/`;
const COMMON = "fov=70&camZoom=1&fakecam=1&fakehands=1&room=chromeflow";

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

const profile = mkdtempSync(join(tmpdir(), "mobile-mr-chrome-flow-"));
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
      "--use-fake-ui-for-media-stream",
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
  await pa.send("Page.navigate", { url: `${BASE}?${COMMON}&name=Touch` });
  await sleep(2500);
  check("A: pointer: coarse が真（タッチ端末として扱われる）", await pa.eval(`matchMedia("(pointer: coarse)").matches`));
  console.log(`A: typeof DeviceOrientationEvent.requestPermission = ${await pa.eval(`typeof DeviceOrientationEvent.requestPermission`)}`);
  check("A: 開始前は「横向きにしてください」が出ていない", (await pa.display("#rotate-hint")) === "none");
  await pa.clickStart();
  await sleep(800);
  check("A: 開始できた（body.started）", await pa.eval(`document.body.classList.contains('started')`));
  let hud = await pa.hud();
  check("A: sensor= が HUD に出る（許可 API 無し or 即 granted）", /sensor=(no-permission-api|granted)/.test(hud), hud.match(/sensor=[^\n]*/)?.[0]);
  check("A: mode=gyro（タッチ経路）", /mode=gyro/.test(hud));
  check("A: wake= が HUD に出る", /wake=/.test(hud), hud.match(/wake=\S+/)?.[0]);
  await sleep(3500);
  hud = await pa.hud();
  check("A: 3 秒でイベントが来なければ no-events（Mac にはセンサーが無い）", /sensor=(no-permission-api|granted) no-events/.test(hud), hud.match(/sensor=[^\n]*/)?.[0]);
  check("A: fs= と lock= の結果が HUD に出る", /fs=\S+ lock=/.test(hud), hud.match(/fs=[^\n]*/)?.[0]);
  check("A: 縦持ちなので「横向きにしてください」が出る", (await pa.display("#rotate-hint")) === "flex");
  check("A: contextmenu が抑止される（長押しで押し続けが切れない）", await pa.eval(`!document.querySelector('#app').dispatchEvent(new MouseEvent('contextmenu', { cancelable: true, bubbles: true }))`));
  check("A: 例外なし", pa.exceptions.length === 0, pa.exceptions.join(" | "));

  // ---- B: PC（マウス）の縦長ウィンドウ ----
  const pb = await newPage(browser, { width: 500, height: 900 });
  await pb.send("Emulation.setDeviceMetricsOverride", { width: 500, height: 900, deviceScaleFactor: 1, mobile: false });
  await pb.send("Page.navigate", { url: `${BASE}?${COMMON}&autostart=1&name=PC` });
  await sleep(4000);
  check("B: pointer: coarse が偽（PC）", !(await pb.eval(`matchMedia("(pointer: coarse)").matches`)));
  check("B: 縦長ウィンドウは portrait 判定", await pb.eval(`matchMedia("(orientation: portrait)").matches`));
  check("B: 開始済み", await pb.eval(`document.body.classList.contains('started')`));
  check("B: PC では「横向きにしてください」が出ない", (await pb.display("#rotate-hint")) === "none");
  hud = await pb.hud();
  check("B: mode=orbit", /mode=orbit/.test(hud));
  check("B: PC では wake= / sensor= を出さない", !/wake=|sensor=/.test(hud));
  check("B: 例外なし", pb.exceptions.length === 0, pb.exceptions.join(" | "));

  const failed = results.filter(([, ok]) => !ok).length;
  console.log(failed ? `${failed} FAILED` : "ALL PASS");
  exitCode = failed ? 1 : 0;
} catch (e) {
  console.error(e);
} finally {
  chrome?.kill();
  server.kill();
  rmSync(profile, { recursive: true, force: true });
}
process.exit(exitCode);
