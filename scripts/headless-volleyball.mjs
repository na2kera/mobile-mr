// demos/06-volleyball のブラウザ経路（マーカー → コート変換・手とボールの当たり判定・
// クライアント予測と権威への復帰・2 ウィンドウ対戦）をヘッドレス Chrome で確認する。
// `npm run check:volley` で実行する。Node の回帰テスト（test-volleyball.mjs）は three.js を
// 使う main.ts を動かせないので、それを補う。
// 依存は追加しない（Chrome 本体と、導入済みの ws だけ）: Chrome DevTools Protocol を ws で直接叩く。
// Chrome が見つからなければスキップ（exit 0）する。CHROME 環境変数でパスを指定できる。
//
// 確認内容: フェイクカメラ（マーカー入り）+ 合成の手で 2 つのウィンドウを別々の側に立たせ、
//   - 両方が違うサイドに割り当てられる（court 座標変換が動いている）
//   - 両方で hit が送られ、受理される（当たり判定 → サーバー検証 → 権威への復帰の経路）
//   - 例外が出ていない
// 注意: 同じウィンドウの裏タブは requestAnimationFrame が止まるので、2 つ目は別ウィンドウで開く
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const CHROME =
  process.env.CHROME ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 5181;
const CDP_PORT = 9333;
/** ページを開いてから HUD を読むまでの待ち [s]。サーブ 1.5s + ラリー数往復ぶん */
const WAIT_SEC = 25;
const BASE = `https://localhost:${PORT}/demos/06-volleyball/`;
const COMMON =
  "fov=70&camZoom=1&fakecam=1&autostart=1&fakehands=1&fakeMarkerPx=80&room=check";

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

// ---- dev サーバー（test-volleyball.mjs と同じ起動方法） ----
const server = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], {
  stdio: ["ignore", "ignore", "pipe"],
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
      // 自己署名証明書なので検証を切る
      const res = await fetch(BASE, { dispatcher: undefined }).catch(() => null);
      if (res?.ok) return true;
    } catch {
      // まだ起動していない
    }
    await sleep(300);
  }
  return false;
}

// ---- CDP ----
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

/** HUD の "side=A" と "hits=送信/受理" を読む */
function parseHud(hud) {
  const side = hud.match(/\bside=([AB-])/)?.[1] ?? null;
  const hits = hud.match(/hits=(\d+)\/(\d+)/);
  const sides = hud.match(/sides=A:(\S+) B:(\S+)/);
  return {
    side,
    sent: hits ? Number(hits[1]) : 0,
    accepted: hits ? Number(hits[2]) : 0,
    sidesA: sides?.[1] ?? "-",
    sidesB: sides?.[2] ?? "-",
    marker: hud.match(/marker=(\S+)/)?.[1] ?? "",
  };
}

const profile = mkdtempSync(join(tmpdir(), "mobile-mr-chrome-"));
let chrome = null;
let exitCode = 1;
try {
  // Node の fetch は自己署名証明書を拒否するので、起動確認は WebSocket 経由の代わりに
  // 環境変数で TLS 検証を切って行う（このプロセス内だけ）
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
  // ウィンドウ 1: マーカーを下に寄せて B 側（court -Z）に立つ幾何
  const p1 = await openPage(first, "B");
  await p1.send("Page.navigate", { url: `${BASE}?${COMMON}&fakeShiftY=190` });
  // ウィンドウ 2: 別ウィンドウで A 側
  const version = await cdpJson("/json/version");
  const browser = new Page(version.webSocketDebuggerUrl, "browser");
  await browser.ready();
  const created = await browser.send("Target.createTarget", { url: "about:blank", newWindow: true });
  const t2 = (await cdpJson("/json")).find((t) => t.id === created.result.targetId);
  const p2 = await openPage(t2, "A");
  await p2.send("Page.navigate", { url: `${BASE}?${COMMON}&fakeShiftY=-190` });

  await sleep(WAIT_SEC * 1000);

  const hud1 = parseHud((await p1.eval("document.querySelector('#hud')?.textContent")) ?? "");
  const hud2 = parseHud((await p2.eval("document.querySelector('#hud')?.textContent")) ?? "");
  console.log(`window1: side=${hud1.side} hits=${hud1.sent}/${hud1.accepted} marker=${hud1.marker}`);
  console.log(`window2: side=${hud2.side} hits=${hud2.sent}/${hud2.accepted} marker=${hud2.marker}`);
  check("両ウィンドウでマーカーが検出されている", hud1.marker.startsWith("id=") && hud2.marker.startsWith("id="));
  check("ウィンドウ 1 は B 側、ウィンドウ 2 は A 側に割り当てられる（court 座標変換）", hud1.side === "B" && hud2.side === "A", `${hud1.side}/${hud2.side}`);
  check("両方の HUD で同じサイド割当が見えている（権威状態の配信）", hud1.sidesA === hud2.sidesA && hud1.sidesB === hud2.sidesB);
  check("ウィンドウ 1 で hit が送られ受理されている（当たり判定 → サーバー検証 → 復帰）", hud1.accepted >= 1, `${hud1.sent}/${hud1.accepted}`);
  check("ウィンドウ 2 でも hit が受理されている", hud2.accepted >= 1, `${hud2.sent}/${hud2.accepted}`);
  check("例外が出ていない", p1.exceptions.length === 0 && p2.exceptions.length === 0, [...p1.exceptions, ...p2.exceptions].slice(0, 2).join(" | "));
  const events = p1.logs.filter((l) => l.startsWith("[game] event")).length;
  check("試合のイベント（serve / hit / bot-hit / ground）が流れている", events >= 3, `${events} events`);

  const failed = results.filter(([, ok]) => !ok);
  console.log(failed.length === 0 ? "\nALL PASS" : `\n${failed.length} FAILED`);
  exitCode = failed.length === 0 ? 0 : 1;
} catch (e) {
  console.error("確認の実行エラー:", e.message ?? e);
} finally {
  chrome?.kill();
  server.kill();
  rmSync(profile, { recursive: true, force: true });
}
process.exit(exitCode);
