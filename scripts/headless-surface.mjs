// demos/07-surface-mapping のブラウザ経路（マーカー → Surface 座標変換・指差しの視線と Surface の交点 →
// paint 送信 → サーバー配信 → 2 ウィンドウで同じ絵）をヘッドレス Chrome で確認する。
// `npm run check:surface` で実行する。仕組みは headless-darts.mjs と同じ（CDP を ws で直接叩く。
// Chrome が無ければスキップ）。
//
// 確認内容: フェイクカメラ（マーカー入り。2 つ目はマーカーの位置をずらす）+ 合成の手（指差しで Surface の
// UV 上に円を描く）で 2 つのウィンドウを同じ room に入れ、
//   - 両方でマーカーが検出されている
//   - 両方で指差しが Surface に当たり（hit=...hand）、paint が送られ受理されている
//   - 両方の HUD で見えているストローク数が一致している（権威状態の配信 + 2 人目の snapshot）
//   - 自分の hit の UV が、合成の手の目標（中心から fakeUvR の円）に乗っている（座標変換の精度）
//   - 例外が出ていない
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const CHROME =
  process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 5185;
const CDP_PORT = 9335;
/** ページを開いてから HUD を読むまでの待ち [s]。起動 + 円 1 周（6s）分 */
const WAIT_SEC = Number(process.env.WAIT_SEC ?? "") || 20;
const FAKE_UV_R = 0.3;
const BASE = `https://localhost:${PORT}/demos/07-surface-mapping/`;
const COMMON =
  `fov=70&camZoom=1&fakecam=1&autostart=1&fakehands=1&fakeMarkerPx=80&handSmooth=1&room=check&fakeUvR=${FAKE_UV_R}`;

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
server.stdout.on("data", (d) => {
  for (const line of d.toString().split("\n")) if (line.startsWith("[surface]")) console.log(line);
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

/** HUD の me / players / hit / paint 行を読む */
function parseHud(hud) {
  const hit = hud.match(/hit=(-?[\d.]+),(-?[\d.]+)(?: \(out\))? (hand|gaze)/);
  const paint = hud.match(/paint: strokes=(\d+) seen=(\d+) sent=(\d+) acked=(\d+)/);
  return {
    me: hud.match(/\bme=(\S+)/)?.[1] ?? "-",
    players: (hud.match(/players=(\S*)/)?.[1] ?? "").split(",").filter((s) => s !== "-" && s !== ""),
    marker: hud.match(/marker=(\S+)/)?.[1] ?? "",
    hit: hit ? { u: Number(hit[1]), v: Number(hit[2]), by: hit[3] } : null,
    strokes: paint ? Number(paint[1]) : -1,
    seen: paint ? Number(paint[2]) : -1,
    sent: paint ? Number(paint[3]) : -1,
    acked: paint ? Number(paint[4]) : -1,
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

  const readHud = async (p) => parseHud((await p.eval("document.querySelector('#hud')?.textContent")) ?? "");
  const hud1 = await readHud(p1);
  const hud2 = await readHud(p2);
  const show = (h) => `me=${h.me} players=${h.players.join("|")} marker=${h.marker} hit=${h.hit ? `${h.hit.u},${h.hit.v} ${h.hit.by}` : "-"} strokes=${h.strokes} seen=${h.seen} sent=${h.sent} acked=${h.acked}`;
  console.log(`window1: ${show(hud1)}`);
  console.log(`window2: ${show(hud2)}`);
  check("両ウィンドウでマーカーが検出されている", hud1.marker.startsWith("id=") && hud2.marker.startsWith("id="));
  check("両方が同じ room に入り 2 人になっている", hud1.players.length === 2 && hud2.players.length === 2);
  check("ウィンドウ 1 で指差しが Surface に当たっている", hud1.hit?.by === "hand", hud1.hit ? `${hud1.hit.u},${hud1.hit.v}` : "-");
  check("ウィンドウ 2 でも指差しが Surface に当たっている（マーカーの位置が違っても UV は Surface 固有）", hud2.hit?.by === "hand", hud2.hit ? `${hud2.hit.u},${hud2.hit.v}` : "-");
  check("ウィンドウ 1 で paint が送られ受理されている", hud1.sent >= 5 && hud1.acked >= 5, `${hud1.sent}/${hud1.acked}`);
  check("ウィンドウ 2 でも paint が受理されている", hud2.sent >= 5 && hud2.acked >= 5, `${hud2.sent}/${hud2.acked}`);
  check("両方が相手のストロークも受け取っている（seen > acked）", hud1.seen > hud1.acked && hud2.seen > hud2.acked);
  // 描画済み数は受信タイミングで 1〜2 ずれ得るので、少しの差は許す
  check("両方の HUD で描いたストローク数がほぼ一致している（権威状態の配信）", Math.abs(hud1.strokes - hud2.strokes) <= 3, `${hud1.strokes} vs ${hud2.strokes}`);
  // 合成の手は中心から半径 fakeUvR（UV）の円上を指す。指先は視線上に置くので交点はその円に乗るはず。
  // フェイクの手の EMA とマーカーの平滑化で多少ずれる → 半径の誤差 0.05（UV）まで許す
  const r1 = hud1.hit ? Math.hypot(hud1.hit.u - 0.5, hud1.hit.v - 0.5) : NaN;
  const r2 = hud2.hit ? Math.hypot(hud2.hit.u - 0.5, hud2.hit.v - 0.5) : NaN;
  check(`指している UV が目標の円（半径 ${FAKE_UV_R}）に乗っている（座標変換の精度）`, Math.abs(r1 - FAKE_UV_R) < 0.05 && Math.abs(r2 - FAKE_UV_R) < 0.05, `r1=${r1.toFixed(3)} r2=${r2.toFixed(3)}`);
  check("例外が出ていない", p1.exceptions.length === 0 && p2.exceptions.length === 0, [...p1.exceptions, ...p2.exceptions].slice(0, 2).join(" | "));
  for (const l of p1.logs.filter((l) => l.startsWith("[paint]")).slice(0, 4)) console.log(`window1 log: ${l}`);

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
