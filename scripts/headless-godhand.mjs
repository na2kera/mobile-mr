// demos/ex8-1-god-hand のブラウザ経路（マーカー → board 座標変換・パーの突き出し検出 → 実体化 →
// キャッチ / 失点 → スコア）をヘッドレス Chrome で確認する。`npm run check:godhand` で実行する。
// ローカルのみのデモなので 1 ウィンドウ（仕組みは headless-darts.mjs と同じ。Chrome が無ければスキップ）。
//
// 確認内容: フェイクカメラ（マーカー入り）+ 合成の手（ボールが近づくとパーのまま突き出す）で、
//   - マーカーが検出されている
//   - シュートが撃たれている
//   - ゴッドハンドが複数回実体化し、キャッチが起きている
//   - 例外が出ていない
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const CHROME =
  process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 5190;
const CDP_PORT = 9338;
/** ページを開いてから HUD を読むまでの待ち [s]。起動 + シュート 6〜8 本 */
const WAIT_SEC = Number(process.env.WAIT_SEC ?? "") || 25;
const BASE = `https://localhost:${PORT}/demos/ex8-1-god-hand/`;
const COMMON = "fov=70&camZoom=1&fakecam=1&autostart=1&fakehands=1&fakeMarkerPx=80&handSmooth=1";

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
  stdio: ["ignore", "pipe", "pipe"],
});
server.stderr.on("data", (d) => process.stderr.write(d));
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
    const r = await this.send("Runtime.evaluate", { expression: expr, returnByValue: true });
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

/** HUD の game 行を読む */
function parseHud(hud) {
  const g = hud.match(
    /game: phase=(\S+) score=(\d+) combo=(\d+) best=(\d+) conceded=(\d+)\/(\d+) shots=(\d+) activations=(\d+) hand=(\S+) balls=(\d+) caught=(\d+)/,
  );
  return {
    marker: hud.match(/marker=(\S+)/)?.[1] ?? "",
    phase: g?.[1] ?? "",
    score: g ? Number(g[2]) : -1,
    best: g ? Number(g[4]) : -1,
    conceded: g ? Number(g[5]) : -1,
    shots: g ? Number(g[7]) : -1,
    activations: g ? Number(g[8]) : -1,
    caught: g ? Number(g[11]) : -1,
  };
}

const profile = mkdtempSync(join(tmpdir(), "mobile-mr-chrome-"));
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
  const targets = await cdpJson("/json");
  const first = targets.find((t) => t.type === "page");
  const p1 = new Page(first.webSocketDebuggerUrl, "1");
  await p1.ready();
  await p1.send("Runtime.enable");
  await p1.send("Page.enable");
  await p1.send("Page.navigate", { url: `${BASE}?${COMMON}` });

  await sleep(WAIT_SEC * 1000);

  const hud = parseHud((await p1.eval("document.querySelector('#hud')?.textContent")) ?? "");
  console.log(
    `window1: marker=${hud.marker} phase=${hud.phase} score=${hud.score} best=${hud.best} conceded=${hud.conceded} shots=${hud.shots} activations=${hud.activations} caught=${hud.caught}`,
  );
  check("マーカーが検出されている", hud.marker.startsWith("id="));
  check("シュートが撃たれている", hud.shots >= 4, `${hud.shots} shots`);
  check("ゴッドハンドが複数回実体化している（突き出しの検出）", hud.activations >= 3, `${hud.activations}`);
  check("キャッチが起きている（board 座標変換と判定）", hud.caught >= 2, `${hud.caught}`);
  const catches = p1.logs.filter((l) => l.startsWith("[gh] catch")).length;
  check("キャッチのログが出ている", catches >= 2, `${catches} logs`);
  check("例外が出ていない", p1.exceptions.length === 0, p1.exceptions.slice(0, 2).join(" | "));
  for (const l of p1.logs.filter((l) => l.startsWith("[gh]")).slice(0, 6)) console.log(`log: ${l}`);

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
