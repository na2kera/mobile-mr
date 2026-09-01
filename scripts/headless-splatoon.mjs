// demos/08-splatoon のブラウザ経路（マーカー → field 座標変換・手の形（グー → パー）からの発射・
// サーバーの着弾と格子 → 2 ウィンドウで同じ得点）をヘッドレス Chrome で確認する。
// `npm run check:splatoon` で実行する。仕組みは headless-darts.mjs と同じ（CDP を ws で直接叩く。
// Chrome が無ければスキップ）。
//
// 確認内容: フェイクカメラ（マーカー入り。2 つ目はマーカーの位置をずらす）+ 合成の手（グー → パーを繰り返す）で
// 2 つのウィンドウを同じ room に入れ、
//   - 両方でマーカーが検出されている
//   - 両方が別チーム（オレンジ / ブルー）に入っている
//   - 両方で発射が送られ受理されている（形の判定 → チャージ → 発射 → サーバー検証）
//   - 両チームの得点が入り、両ウィンドウの HUD で同じ得点が見えている（権威状態の配信）
//   - 例外が出ていない
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const CHROME =
  process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 5189;
const CDP_PORT = 9336;
/** ページを開いてから HUD を読むまでの待ち [s]。起動 + 発射 5〜6 回（1 回 2.5s） */
const WAIT_SEC = Number(process.env.WAIT_SEC ?? "") || 20;
const BASE = `https://localhost:${PORT}/demos/08-splatoon/`;
const COMMON =
  "fov=70&camZoom=1&fakecam=1&autostart=1&fakehands=1&fakeMarkerPx=80&handSmooth=1&room=check";

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
/** サーバーが決めた着弾（"[splatoon] p1 shot #3: wall uv=(0.61,0.72) t=0.12 ..."） */
const landings = [];
server.stdout.on("data", (d) => {
  for (const line of d.toString().split("\n")) {
    if (!line.startsWith("[splatoon]")) continue;
    console.log(line);
    const m = line.match(/^\[splatoon\] (p\d+) shot #\d+: (\S+)/);
    if (m) landings.push({ by: m[1], where: m[2] });
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

/** HUD の me / game 行を読む（個人戦: scores は p1:107,p2:324 形式） */
function parseHud(hud) {
  const g = hud.match(/game: phase=(\S+) left=(\S+) color=(\S+) players=(\S*) scores=(\S*) total=(\d+) shots=(\d+)\/(\d+)/);
  const scores = {};
  for (const m of (g?.[5] ?? "").matchAll(/(p\d+):(\d+)/g)) scores[m[1]] = Number(m[2]);
  return {
    me: hud.match(/\bme=(\S+)/)?.[1] ?? "-",
    marker: hud.match(/marker=(\S+)/)?.[1] ?? "",
    phase: g?.[1] ?? "",
    color: g ? Number(g[3]) : 0,
    players: (g?.[4] ?? "").split(",").filter(Boolean),
    scores,
    total: g ? Number(g[6]) : 0,
    sent: g ? Number(g[7]) : -1,
    accepted: g ? Number(g[8]) : -1,
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
  const show = (h) => `me=${h.me} marker=${h.marker} phase=${h.phase} color=${h.color} players=${h.players.join("|")} scores=${JSON.stringify(h.scores)}/${h.total} shots=${h.sent}/${h.accepted}`;
  console.log(`window1: ${show(hud1)}`);
  console.log(`window2: ${show(hud2)}`);
  check("両ウィンドウでマーカーが検出されている", hud1.marker.startsWith("id=") && hud2.marker.startsWith("id="));
  check("両方が同じ room に入り 2 人になっている", hud1.players.length === 2 && hud2.players.length === 2);
  check("個人戦: 別の色が割り当たっている", hud1.color > 0 && hud2.color > 0 && hud1.color !== hud2.color, `${hud1.color} vs ${hud2.color}`);
  check("ウィンドウ 1 で連射が送られ受理されている（形の判定 → 連射 → サーバー検証）", hud1.sent >= 5 && hud1.accepted >= 5, `${hud1.sent}/${hud1.accepted}`);
  check("ウィンドウ 2 でも連射が受理されている", hud2.sent >= 5 && hud2.accepted >= 5, `${hud2.sent}/${hud2.accepted}`);
  check("両プレイヤーが得点している（着弾と塗りが field 座標で合っている）", (hud1.scores[hud1.me] ?? 0) > 0 && (hud2.scores[hud2.me] ?? 0) > 0, JSON.stringify(hud1.scores));
  // 得点は 1 秒ごとの state で更新されるので、読み取りタイミングで少し違い得る
  const diff = Object.keys({ ...hud1.scores, ...hud2.scores }).reduce((a, k) => a + Math.abs((hud1.scores[k] ?? 0) - (hud2.scores[k] ?? 0)), 0);
  check("両ウィンドウの HUD でほぼ同じ得点が見えている（権威状態の配信）", diff <= Math.max(200, hud1.total * 0.02), `${JSON.stringify(hud1.scores)} vs ${JSON.stringify(hud2.scores)}`);
  const hits = landings.filter((l) => l.where !== "miss");
  check("着弾のほとんどが壁か床に当たっている（外れが半分未満）", landings.length >= 6 && hits.length > landings.length / 2, `${hits.length}/${landings.length} hit`);
  check("例外が出ていない", p1.exceptions.length === 0 && p2.exceptions.length === 0, [...p1.exceptions, ...p2.exceptions].slice(0, 2).join(" | "));
  for (const l of p1.logs.filter((l) => l.startsWith("[game] shot sent")).slice(0, 3)) console.log(`window1 log: ${l}`);

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
