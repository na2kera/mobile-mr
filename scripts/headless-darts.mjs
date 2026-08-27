// demos/06-2-darts のブラウザ経路（マーカー → board 座標変換・手の振りから投げの検出・
// サーバーの採点 → 手番の交代・2 ウィンドウでの交互の投げ）をヘッドレス Chrome で確認する。
// `npm run check:darts` で実行する。仕組みは headless-volleyball.mjs と同じ（CDP を ws で直接叩く。
// Chrome が無ければスキップ）。
//
// 確認内容: フェイクカメラ（マーカー入り）+ 合成の手で 2 つのウィンドウを同じ room に入れ、
//   - 両方でマーカーが検出されている
//   - 両方で throw が送られ、受理されている（振りの検出 → サーバー検証）
//   - 両方が得点している（合成の手はブルを狙う速度で振るので、座標変換が合っていれば当たる）
//   - 手番が両者の間で交代している
//   - 例外が出ていない
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const CHROME =
  process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 5183;
const CDP_PORT = 9334;
/** ページを開いてから HUD を読むまでの待ち [s]。起動 + 2 人 × 3 投（1 投 ≈ 3.5s）+ 手番交代 */
const WAIT_SEC = Number(process.env.WAIT_SEC ?? "") || 45;
const BASE = `https://localhost:${PORT}/demos/06-2-darts/`;
const COMMON =
  "fov=70&camZoom=1&fakecam=1&autostart=1&fakehands=1&fakeMarkerPx=80&handSmooth=1&room=check" +
  (process.env.FAKE_DEBUG ? "&fakeDebug=1" : "");

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
/** サーバーが決めた着弾（"[darts] p1 throw #1: 17 (17) end=(0.01,-0.04,0.00) ..."）*/
const landings = [];
server.stdout.on("data", (d) => {
  for (const line of d.toString().split("\n")) {
    if (!line.startsWith("[darts]")) continue;
    console.log(line);
    const m = line.match(/^\[darts\] (p\d+) throw #\d+: (\S+) \((\d+)\) end=\(([-\d.]+),([-\d.]+),/);
    if (m) landings.push({ by: m[1], label: m[2], points: Number(m[3]), r: Math.hypot(Number(m[4]), Number(m[5])) });
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

/** HUD の "me=p1" "throws=送信/受理" "players=p1:50,p2:0" を読む */
function parseHud(hud) {
  const throws = hud.match(/throws=(\d+)\/(\d+)/);
  const players = {};
  for (const m of (hud.match(/players=(\S*)/)?.[1] ?? "").matchAll(/(p\d+):(-?\d+)/g)) {
    players[m[1]] = Number(m[2]);
  }
  return {
    me: hud.match(/\bme=(\S+)/)?.[1] ?? "-",
    sent: throws ? Number(throws[1]) : 0,
    accepted: throws ? Number(throws[2]) : 0,
    players,
    phase: hud.match(/phase=(\S+)/)?.[1] ?? "",
    marker: hud.match(/marker=(\S+)/)?.[1] ?? "",
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
  const p1 = await openPage(first, "1");
  await p1.send("Page.navigate", { url: `${BASE}?${COMMON}&name=One` });
  const version = await cdpJson("/json/version");
  const browser = new Page(version.webSocketDebuggerUrl, "browser");
  await browser.ready();
  const created = await browser.send("Target.createTarget", { url: "about:blank", newWindow: true });
  const t2 = (await cdpJson("/json")).find((t) => t.id === created.result.targetId);
  const p2 = await openPage(t2, "2");
  await p2.send("Page.navigate", { url: `${BASE}?${COMMON}&name=Two&fakeShift=40` });

  await sleep(WAIT_SEC * 1000);

  const hud1 = parseHud((await p1.eval("document.querySelector('#hud')?.textContent")) ?? "");
  const hud2 = parseHud((await p2.eval("document.querySelector('#hud')?.textContent")) ?? "");
  console.log(`window1: me=${hud1.me} throws=${hud1.sent}/${hud1.accepted} players=${JSON.stringify(hud1.players)} phase=${hud1.phase} marker=${hud1.marker}`);
  console.log(`window2: me=${hud2.me} throws=${hud2.sent}/${hud2.accepted} players=${JSON.stringify(hud2.players)} phase=${hud2.phase} marker=${hud2.marker}`);
  check("両ウィンドウでマーカーが検出されている", hud1.marker.startsWith("id=") && hud2.marker.startsWith("id="));
  check("両方が同じ room に入り 2 人になっている", Object.keys(hud1.players).length === 2 && Object.keys(hud2.players).length === 2);
  check("ウィンドウ 1 で throw が送られ受理されている（振りの検出 → サーバー検証）", hud1.accepted >= 1, `${hud1.sent}/${hud1.accepted}`);
  check("ウィンドウ 2 でも throw が受理されている（手番が交代した）", hud2.accepted >= 1, `${hud2.sent}/${hud2.accepted}`);
  check("両方が得点している（board 座標変換と速度の向きが合っている）", (hud1.players[hud1.me] ?? 0) > 0 && (hud2.players[hud2.me] ?? 0) > 0, JSON.stringify(hud1.players));
  check("両方の HUD で同じ得点が見えている（権威状態の配信）", JSON.stringify(hud1.players) === JSON.stringify(hud2.players));
  // 合成の手はブル（中心）を狙う速度で振る。手のひらは手の中心より数 cm 下、EMA の遅れも
  // あるので厳密にブルにはならないが、着弾は中心から 8cm 以内（シングルの内側）に収まるはず
  const LANDING_R_MAX = 0.08;
  const far = landings.filter((l) => l.r > LANDING_R_MAX);
  check(`全投の着弾が中心から ${LANDING_R_MAX * 100}cm 以内（座標変換と速度の精度）`, landings.length >= 6 && far.length === 0, `${landings.length} throws, r=${landings.map((l) => l.r.toFixed(3)).join("/")}`);
  check("例外が出ていない", p1.exceptions.length === 0 && p2.exceptions.length === 0, [...p1.exceptions, ...p2.exceptions].slice(0, 2).join(" | "));
  for (const l of p1.logs.filter((l) => l.startsWith("[game] throw sent")).slice(0, 3)) console.log(`window1 log: ${l}`);
  if (process.env.FAKE_DEBUG) {
    for (const l of p1.logs.filter((l) => l.startsWith("[fake]") || l.startsWith("[game]"))) console.log(`window1 log: ${l}`);
    for (const l of p2.logs.filter((l) => l.startsWith("[fake]") || l.startsWith("[game]"))) console.log(`window2 log: ${l}`);
  }
  const turns = p1.logs.filter((l) => l.startsWith("[game] event turn")).length;
  check("手番のイベントが流れている", turns >= 2, `${turns} turn events`);

  const failed = results.filter(([, ok]) => !ok);
  console.log(failed.length === 0 ? "\nALL PASS" : `\n${failed.length} FAILED`);
  exitCode = failed.length === 0 ? 0 : 1;
} catch (e) {
  console.error("確認の実行エラー:", e.message ?? e);
} finally {
  chrome?.kill();
  server.kill();
  // Chrome の終了直後はプロファイルにまだ書き込みがあり ENOTEMPTY になることがある
  await sleep(500);
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // 一時ディレクトリなので残っても害はない
  }
}
process.exit(exitCode);
