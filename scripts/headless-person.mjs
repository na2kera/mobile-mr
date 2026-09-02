// demos/09-person-id のブラウザ経路（マーカー → 共通座標・合成の体の 3D 化 → ピアとの対応づけ → seen の中継 →
// 相手の端末で「見えています」）をヘッドレス Chrome で確認する。`npm run check:person` で実行する。
// 仕組みは headless-splatoon.mjs と同じ（CDP を ws で直接叩く。Chrome が無ければスキップ）。
//
// 確認内容: フェイクカメラ（マーカー入り）で 2 つのウィンドウを同じ room に入れる。
//   - ウィンドウ 1 は ?camFov=25 でマーカーから遠く（約 1.8m）、ウィンドウ 2 は既定（約 0.6m）に立つので、
//     ウィンドウ 1 から見てウィンドウ 2（p2）は約 1.2m 前にいる
//   - ウィンドウ 1 の合成の体は p2 の頭の位置 + 0.15m にもう 1 人（1.5m 横）→ 前者に p2 の名札、後者は「？」
//   - ウィンドウ 2 の HUD に「p1 から見えている（ずれ ≈ 0.15m）」が出る（seen の中継と座標変換）
//   - 3 つ目のウィンドウで本物の PoseLandmarker を初期化する（wasm・モデル・デリゲートの経路。人は映らない）
//   - 例外が出ていない
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const CHROME =
  process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 5192;
const CDP_PORT = 9339;
/** ページを開いてから HUD を読むまでの待ち [s] */
const WAIT_SEC = Number(process.env.WAIT_SEC ?? "") || 15;
const BASE = `https://localhost:${PORT}/demos/09-person-id/`;
const COMMON = "fov=70&camZoom=1&fakecam=1&autostart=1&fakeMarkerPx=80&bodySmooth=1&room=check";

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
let portInUse = false;
server.stderr.on("data", (d) => {
  process.stderr.write(d);
  // 別の dev サーバーが同じポートに居残っていると、そちらに繋がって誤判定する（古いコードを叩く）ので止める
  if (/already in use/.test(d.toString())) portInUse = true;
});
server.stdout.on("data", (d) => {
  for (const line of d.toString().split("\n")) if (line.startsWith("[person]")) console.log(line);
});
let serverExited = false;
server.on("exit", () => {
  serverExited = true;
});
async function waitForServer(timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (serverExited || portInUse) return false;
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

/** HUD の tracks / seenBy 行を読む: tracks=[p2:1.20m/7.1deg/0.00m/vis33/res0.000,?:1.85m/vis33/res0.000] */
function parseHud(hud) {
  const tracks = [];
  for (const m of (hud.match(/tracks=\[([^\]]*)\]/)?.[1] ?? "").matchAll(/([^,:]+):([\d.]+)m(?:\/([\d.]+)deg\/([\d.]+)m)?\/vis(\d+)/g)) {
    tracks.push({ id: m[1], depth: Number(m[2]), angle: m[3] === undefined ? null : Number(m[3]), depthDiff: m[4] === undefined ? null : Number(m[4]), vis: Number(m[5]) });
  }
  const seenBy = {};
  for (const m of (hud.match(/seenBy=(\S+)/)?.[1] ?? "").matchAll(/(p\d+):([\d.]+)m/g)) seenBy[m[1]] = Number(m[2]);
  return {
    me: hud.match(/\bme=(\S+)/)?.[1] ?? "-",
    marker: hud.match(/marker=(\S+)/)?.[1] ?? "",
    tracker: hud.match(/tracker=([^\n]*)/)?.[1] ?? "",
    peers: (hud.match(/peers=(\S+)/)?.[1] ?? "").split(",").filter((p) => p !== "-" && p !== ""),
    bodies: Number(hud.match(/bodies=(\d+)/)?.[1] ?? -1),
    tracks,
    seenBy,
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
  await p1.send("Page.navigate", { url: `${BASE}?${COMMON}&fakebody=1&camFov=25&fakeBodyErr=0.15&name=One` });
  const version = await cdpJson("/json/version");
  const browser = new Page(version.webSocketDebuggerUrl, "browser");
  await browser.ready();
  const newWindow = async (name) => {
    const created = await browser.send("Target.createTarget", { url: "about:blank", newWindow: true });
    const t = (await cdpJson("/json")).find((x) => x.id === created.result.targetId);
    return openPage(t, name);
  };
  const p2 = await newWindow("2");
  await p2.send("Page.navigate", { url: `${BASE}?${COMMON}&fakebody=1&fakeShift=40&name=Two` });
  // 本物の PoseLandmarker（合成の体なし）。別 room で 1 人
  const p3 = await newWindow("3");
  await p3.send("Page.navigate", { url: `${BASE}?fov=70&camZoom=1&fakecam=1&autostart=1&fakeMarkerPx=80&room=check3&name=Three` });

  await sleep(WAIT_SEC * 1000);

  const readHud = async (p) => parseHud((await p.eval("document.querySelector('#hud')?.textContent")) ?? "");
  const hud1 = await readHud(p1);
  const hud2 = await readHud(p2);
  const show = (h) => `me=${h.me} marker=${h.marker} peers=${h.peers.join("|")} bodies=${h.bodies} tracks=${JSON.stringify(h.tracks)} seenBy=${JSON.stringify(h.seenBy)}`;
  console.log(`window1: ${show(hud1)}`);
  console.log(`window2: ${show(hud2)}`);
  check("両ウィンドウでマーカーが検出されている", hud1.marker.startsWith("id=") && hud2.marker.startsWith("id="));
  check("両方が同じ room に入り互いをピアとして持つ", hud1.peers.includes(hud2.me) && hud2.peers.includes(hud1.me), `${hud1.peers} / ${hud2.peers}`);
  check("ウィンドウ 1 に合成の体が 2 人映っている", hud1.bodies === 2 && hud1.tracks.length === 2, `${hud1.bodies} / ${hud1.tracks.length}`);
  const matched = hud1.tracks.find((t) => t.id === hud2.me);
  const unknown = hud1.tracks.find((t) => t.id === "?");
  check("p2 の頭の位置に立つ体に p2 の名札が付く（角度 < 12°・距離差 < 0.3m）", matched && matched.angle !== null && matched.angle < 12 && matched.depthDiff < 0.3, JSON.stringify(matched));
  check("1.5m 横の体は「？」のまま", unknown && unknown.angle === null, JSON.stringify(unknown));
  check("体は 33 点すべて可視で解けている", hud1.tracks.every((t) => t.vis === 33));
  const seen = hud2.seenBy[hud1.me];
  check("ウィンドウ 2 に「p1 から見えている」（ずれ ≈ 0.15m）が届く", seen !== undefined && seen > 0.05 && seen < 0.3, `${seen}`);
  const msg2 = await p2.eval("document.querySelector('#hud')?.textContent && ''");
  void msg2;
  const label1 = await p1.eval("(() => { const m = document.body.textContent; return m.includes('Two') ? 'has-name' : 'no-name'; })()");
  void label1;
  check("例外が出ていない", p1.exceptions.length === 0 && p2.exceptions.length === 0, [...p1.exceptions, ...p2.exceptions].slice(0, 2).join(" | "));

  // 本物の PoseLandmarker の初期化（wasm・モデル・デリゲート）。GPU が無ければ CPU に落ちる
  let hud3 = await readHud(p3);
  for (let i = 0; i < 6 && !/^(ready|error)/.test(hud3.tracker); i++) {
    await sleep(5000);
    hud3 = await readHud(p3);
  }
  console.log(`window3: tracker=${hud3.tracker} bodies=${hud3.bodies}`);
  // モデルは Git 管理外（npm run fetch:models）なので、未取得の環境では公式 URL へのフォールバック（model=remote）も正常
  check("本物の PoseLandmarker が初期化できる（ローカルのモデル、無ければ公式 URL）", /^ready (GPU|CPU) model=(local|remote)/.test(hud3.tracker), hud3.tracker);
  check("人が映っていないので検出 0", hud3.bodies === 0 && hud3.tracks.length === 0);
  check("ウィンドウ 3 でも例外なし", p3.exceptions.length === 0, p3.exceptions.slice(0, 2).join(" | "));
  for (const l of p1.logs.filter((l) => l.startsWith("[person]")).slice(0, 3)) console.log(`window1 log: ${l}`);

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
