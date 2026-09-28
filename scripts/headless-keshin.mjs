// demos/ex9-1-keshin（化身）のブラウザ経路をヘッドレス Chrome で確認する。`npm run check:keshin` で実行する。
// 仕組みは headless-person.mjs と同じ（CDP を ws で直接叩く。Chrome が無ければスキップ）。
// モデルが local-assets/keshin/ にあれば実モデルで、無ければ代わりの人型で確認する（どちらだったかを出力する）。
//
// 確認内容:
//   1. スマホ 1（フェイクカメラ・マーカー入り）と俯瞰画面を同じ room に入れる。スマホ 1 は化身 0（魔神）、track = marker
//   2. スマホ 1 の「化身」ボタンを押す → 俯瞰画面で化身がせり上がる途中（0 < u < 1.5）→ 出切る（u = 1.5・描画あり）。
//      化身は本人の背後（壁と反対側）で本人と同じ向き（fwd ≈ マーカーの方 = −Z）。画素でも化身の有無の差が出る
//   3. スマホ 1 は正面では自分の化身を描かず（オーラだけ）、見上げる（55°）と描く（画素の差あり・track は gyro になる）
//   4. スマホ 2・3 が入ると化身 1・2 が割り当てられる。後から開いた俯瞰画面 2 はスマホ 1 の化身を演出なしで出切った状態で持つ
//   5. 3 人とも出して俯瞰画面のスクリーンショット。消す（途中で出し直す）と俯瞰画面の見え方が連続（u が飛ばない）
//   6. 例外なし、logs/client.log に keshin-phone の 1 秒ごとの行と出来事が書かれる
// スクリーンショットは logs/keshin-check/ に保存する（logs は git 管理外）
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { rotateByQuat } from "../demos/ex9-1-keshin/keshin-math.ts";
import { KESHIN_PATH, KESHIN_PROTOCOL_VERSION } from "../src/shared/keshin-protocol.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 5222;
const CDP_PORT = 9361;
const BASE = `https://localhost:${PORT}/demos/ex9-1-keshin/`;
const ROOM = `check${Date.now() % 100000}`;
// 段階 1 の確認では人の形で隠す処理（MediaPipe）は止める（?occlude=0）。段階 2 の確認は別の room で行う
const PHONE = `fov=70&camZoom=1&fakecam=1&autostart=1&fakeMarkerPx=80&occlude=0&room=${ROOM}&posMode=declared`;
const ROOM2 = `${ROOM}s2`;
const SHOT_DIR = join(ROOT, "logs", "keshin-check");
const LOG_FILE = join(ROOT, "logs", "client.log");
const MODELS_PRESENT = ["majin_the_hand.glb", "majin_pegasus_arc.glb", "kensei_lancelot.glb"].every((f) => existsSync(join(ROOT, "local-assets", "keshin", f)));

if (!existsSync(CHROME)) {
  console.log(`SKIP: Chrome が見つかりません (${CHROME})。CHROME=/path/to/chrome で指定できます`);
  process.exit(0);
}

const results = [];
function check(name, cond, detail = "") {
  results.push([name, !!cond]);
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${detail ? ` (${detail})` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 別の check:keshin（同じ固定のポート）が動いていると、ページや仮想のプレイヤーが相手の実行のサーバーにつながって結果が混ざる。先に確かめて止める
{
  const { connect } = await import("node:net");
  const busy = (port) =>
    new Promise((resolve) => {
      const sock = connect({ port, host: "127.0.0.1" });
      sock.once("connect", () => {
        sock.destroy();
        resolve(true);
      });
      sock.once("error", () => resolve(false));
    });
  const used = [];
  for (const port of [PORT, CDP_PORT]) if (await busy(port)) used.push(port);
  if (used.length) {
    console.log(`FAIL: ポート ${used.join(", ")} が使われています。別の check:keshin が動いていないか確かめてください（同時に回すと結果が混ざる）`);
    process.exit(1);
  }
}
const server = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
let portInUse = false;
server.stderr.on("data", (d) => {
  process.stderr.write(d);
  if (/already in use/.test(d.toString())) portInUse = true;
});
server.stdout.on("data", (d) => {
  for (const line of d.toString().split("\n")) if (line.startsWith("[keshin]")) console.log(`  server: ${line}`);
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
        this.exceptions.push(`${m.params.exceptionDetails.text} ${m.params.exceptionDetails.exception?.description ?? ""}`);
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
  async shot(file) {
    const r = await this.send("Page.captureScreenshot", { format: "png" });
    if (!r.result?.data) throw new Error(`スクリーンショット取得失敗: ${file}`);
    const path = join(SHOT_DIR, file);
    writeFileSync(path, Buffer.from(r.result.data, "base64"));
    console.log(`SCREENSHOT: ${path}`);
    return path;
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

async function openPage(target, name) {
  const page = new Page(target.webSocketDebuggerUrl, name);
  page.targetId = target.id;
  await page.ready();
  await page.send("Runtime.enable");
  await page.send("Page.enable");
  return page;
}

/** 条件が true を返すまで待つ（返り値を返す） */
async function waitUntil(fn, timeoutMs = 20000, stepMs = 250) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    last = await fn();
    if (last?.ok) return last;
    await sleep(stepMs);
  }
  return last;
}

const phoneState = (p) => p.eval("window.__keshin?.state() ?? null");
const overviewState = (p) => p.eval("window.__keshinOverview?.state() ?? []");

mkdirSync(SHOT_DIR, { recursive: true });
const logSizeBefore = existsSync(LOG_FILE) ? statSync(LOG_FILE).size : 0;
const profile = mkdtempSync(join(tmpdir(), "mobile-mr-chrome-"));
let chrome = null;
let exitCode = 1;
const pages = [];
try {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  if (!(await waitForServer())) throw new Error(`dev サーバーが起動しなかった（ポート ${PORT} が使用中でないか確認）`);
  console.log(`モデル: ${MODELS_PRESENT ? "local-assets/keshin/ にあり（実モデルで確認）" : "未配置（代わりの人型で確認）"}`);
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
      ...(process.env.CHROME_ARGS ?? "").split(" ").filter(Boolean),
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const targets = await cdpJson("/json");
  const first = targets.find((t) => t.type === "page");
  const p1 = await openPage(first, "phone1");
  pages.push(p1);
  const version = await cdpJson("/json/version");
  const browser = new Page(version.webSocketDebuggerUrl, "browser");
  await browser.ready();
  const newWindow = async (name, url) => {
    const created = await browser.send("Target.createTarget", { url: "about:blank", newWindow: true });
    const t = (await cdpJson("/json")).find((x) => x.id === created.result.targetId);
    const page = await openPage(t, name);
    pages.push(page);
    await page.send("Page.navigate", { url });
    return page;
  };
  // ログを書くのはスマホ 1 だけ（他は ?remoteLog=0）
  await p1.send("Page.navigate", { url: `${BASE}?${PHONE}&name=One` });
  const ov = await newWindow("overview", `${BASE}overview.html?room=${ROOM}&remoteLog=0`);

  // ---- 1. 入室・マーカー・モデル ----
  const s1 = await waitUntil(async () => {
    const s = await phoneState(p1);
    return { ok: s && s.me && s.track === "marker" && (s.model === "loaded" || s.model === "missing"), s };
  }, 40000);
  console.log(`phone1: ${JSON.stringify(s1?.s)}`);
  check("スマホ 1 が入室して化身 0 が割り当てられる", s1?.s?.keshin === 0, `keshin=${s1?.s?.keshin}`);
  check("スマホ 1 がマーカーを見ている（track = marker）", s1?.s?.track === "marker");
  check(
    MODELS_PRESENT ? "実モデル（魔神）を読み込めた" : "モデル未配置 → 代わりの人型（missing）",
    MODELS_PRESENT ? s1?.s?.model === "loaded" && s1?.s?.fallback === false : s1?.s?.model === "missing",
    `model=${s1?.s?.model} fallback=${s1?.s?.fallback}`,
  );
  const o1 = await waitUntil(async () => {
    const st = await overviewState(ov);
    const me = st.find((x) => x.id === s1?.s?.me);
    return { ok: me && me.track === "marker" && me.head, st, me };
  });
  check("俯瞰画面にスマホ 1 が marker で出る（化身はまだ無し）", o1?.me && o1.me.track === "marker" && o1.me.drawn === false, JSON.stringify(o1?.me));
  const p1id = s1?.s?.me;

  // ---- 2. 化身ボタン → 俯瞰画面でせり上がる ----
  // シェーダーの先行コンパイル: 化身を出す前・初めて見上げる前にプログラムが揃っていること（新しくリンクされる本数を数える）
  const warmExpect = MODELS_PRESENT ? "model" : "fallback";
  const phoneWarm = await waitUntil(async () => {
    const s = await phoneState(p1);
    return { ok: s.warmup.startsWith(warmExpect), s };
  }, 10000);
  const ovWarm = await waitUntil(async () => {
    const pr = await ov.eval("window.__keshinOverview.programs()");
    return { ok: pr.pending === 0 && pr.warmup.includes(warmExpect), pr };
  }, 10000);
  console.log(`warmup: phone=${phoneWarm?.s?.warmup} overview=${ovWarm?.pr?.warmup}`);
  const progPhone0 = (await phoneState(p1)).programs;
  const progOv0 = (await ov.eval("window.__keshinOverview.programs()")).programs;
  const clicked = await p1.eval("(() => { const b = document.querySelector('#keshin-button'); if (!b || b.disabled) return false; b.click(); return true; })()");
  check("化身ボタンを押せる", clicked === true);
  const pend = await phoneState(p1);
  await sleep(550);
  const mid = (await overviewState(ov)).find((x) => x.id === p1id);
  console.log(`overview mid: ${JSON.stringify(mid)}`);
  check("俯瞰画面: 押して約 0.5s 後はせり上がりの途中（0 < u < 1.5）", mid && mid.on === true && mid.u > 0.1 && mid.u < 1.45, `u=${mid?.u} pending(直後)=${pend?.pending}`);
  await sleep(1600);
  const done = (await overviewState(ov)).find((x) => x.id === p1id);
  console.log(`overview done: ${JSON.stringify(done)}`);
  check("俯瞰画面: 出切って描画されている（u = 1.5・不透明度 > 0.5）", done && done.u === 1.5 && done.drawn && done.opacity > 0.5, `u=${done?.u} drawn=${done?.drawn} opacity=${done?.opacity}`);
  check(MODELS_PRESENT ? "俯瞰画面も実モデル" : "俯瞰画面は代わりの人型", done && done.fallback === !MODELS_PRESENT, `fallback=${done?.fallback}`);
  const progOv1 = (await ov.eval("window.__keshinOverview.programs()")).programs;
  check("俯瞰画面: 化身が初めて出たときに新しくリンクされたシェーダープログラムは 0 本（先行コンパイル済み）", progOv1 === progOv0, `programs ${progOv0}→${progOv1}`);
  // 本人はマーカー（壁 = z 0）の方を向いている → 体の向きは −Z、化身は本人の背後（+Z 側）で同じ向き（yaw ≈ ±π）
  const yawOk = done && Math.abs(Math.abs(done.yaw) - Math.PI) < 0.2;
  check("化身は本人と同じ向き（マーカーの方 = −Z、yaw ≈ ±180°）", yawOk && done.fwd && done.fwd[1] < -0.95, `yaw=${done?.yaw} fwd=${JSON.stringify(done?.fwd)}`);
  // 実際に描いているモデルから確かめる: 原点は頭から fwd の逆向き（内積 < 0）、モデルの正面 +Z は fwd と同じ向き
  const w = done?.world;
  const rel = w && done.head ? [w.origin[0] - done.head[0], w.origin[2] - done.head[2]] : null;
  const behindDot = rel && done.fwd ? rel[0] * done.fwd[0] + rel[1] * done.fwd[1] : NaN;
  const frontDot = w && done.fwd ? w.front[0] * done.fwd[0] + w.front[1] * done.fwd[1] : NaN;
  check("化身は本人の背後（描いているモデルの原点 − 頭 と fwd の内積 < −0.25m）", behindDot < -0.25, `dot=${behindDot.toFixed?.(3)} back=${done?.back}`);
  check("化身の正面 +Z は本人の体の向き fwd と同じ（内積 > 0.99）", frontDot > 0.99, `dot=${frontDot.toFixed?.(4)}`);
  const pxOv = await ov.eval(`window.__keshinOverview.pixelDiff(${JSON.stringify(p1id)})`);
  check("俯瞰画面: 化身の有無で画素が変わる（> 0.5%）", pxOv && pxOv.changed / pxOv.total > 0.005, `${pxOv?.changed}/${pxOv?.total}`);
  await ov.eval("window.__keshinOverview.setView([2.6, 1.2, 4.6], [0, 0.2, 1.2])");
  await sleep(400);
  await ov.shot("overview-1-majin.png");
  const phone1After = await phoneState(p1);
  check("スマホ 1: 確定が届いて送信中が消え、on になっている", phone1After.on === true && phone1After.pending === null);

  // ---- 3. 主観: 正面では描かない・見上げると描く ----
  check("スマホ 1: 正面（見上げ 0°）では化身を描かない（オーラだけ）", phone1After.drawn === false && phone1After.fade === 0, `look=${phone1After.look} fade=${phone1After.fade}`);
  const pxFwd = await p1.eval("window.__keshin.pixelDiff(true)");
  check(
    "スマホ 1: 正面ではオーラが視界の周りに出て、各眼の中心 50% はほぼ空（変わった画素の 5% 未満）・外周 20% の帯に大半（50% 超）",
    pxFwd && pxFwd.changed / pxFwd.total > 0.002 && pxFwd.center / Math.max(1, pxFwd.changed) < 0.05 && pxFwd.band / Math.max(1, pxFwd.changed) > 0.5,
    `changed=${pxFwd?.changed} center=${pxFwd?.center} band=${pxFwd?.band} total=${pxFwd?.total}`,
  );
  await p1.shot("phone1-forward.png");
  const progPhone1 = (await phoneState(p1)).programs;
  check("スマホ 1: 化身を出したとき（オーラ）に新しくリンクされたプログラムは 0 本", progPhone1 === progPhone0, `programs ${progPhone0}→${progPhone1}`);
  await p1.eval("window.__keshin.setLook(55)");
  // マーカーが画面外に出て gyro になるまで待つ（フェイクカメラは映像が 100ms ごとなので、見上げた直後は古い映像のマーカーで
  // アンカーが一瞬ずれ、枠がずれた位置に出ることがある。枠は track = marker のときだけ描く）
  const up = await waitUntil(async () => {
    const s = await phoneState(p1);
    return { ok: s.drawn && s.fade === 1 && s.track === "gyro", s };
  }, 5000);
  console.log(`phone1 look up: ${JSON.stringify(up?.s)}`);
  await sleep(300);
  const progPhone2 = (await phoneState(p1)).programs;
  check("スマホ 1: 初めて見上げて化身を描いたときに新しくリンクされたプログラムは 0 本（先行コンパイル済み）", up?.ok && progPhone2 === progPhone1, `programs ${progPhone1}→${progPhone2}`);
  check("スマホ 1: 見上げ 55° で自分の化身を描く（fade = 1）", up?.ok, `look=${up?.s?.look} fade=${up?.s?.fade}`);
  const pxUp = await p1.eval("window.__keshin.pixelDiff()");
  check("スマホ 1: 見上げたとき化身の有無で画素が変わる（> 1%）", pxUp && pxUp.changed / pxUp.total > 0.01, `${pxUp?.changed}/${pxUp?.total}`);
  await p1.shot("phone1-lookup.png");
  // 目から 0.6m 以内を消している: 化身の胸〜肩が目の近くに来る旧既定（35° / +0.25）にして、消さない設定
  // （(0, 0) = d < 0 だけ捨てる = 何も捨てない）と比べると化身の画素が増える。既定値（モデルごと）は目の近くに来る部分が少ないので比べられない
  await p1.eval("window.__keshin.setSelfTuning(35, 0.25, null)");
  await sleep(300);
  const pxNear35 = await p1.eval("window.__keshin.pixelDiff()");
  await p1.eval(`window.__keshin.setNearFade(0, 0)`);
  const pxNoNear = await p1.eval("window.__keshin.pixelDiff()");
  await p1.eval(`window.__keshin.setNearFade(0.6, 0.75)`);
  // 目の近くを消す帯（0.6〜0.75m）で内側が透けないこと（深度と色を同じ画素で捨てる）の確認用にも撮る
  await p1.shot("phone1-lookup-lean35.png");
  await p1.eval("window.__keshin.setSelfTuning(...window.__keshinDefaultTuning)");
  check("スマホ 1: 目から 0.6m 以内を消している（35° / +0.25 で、消さない設定より化身の画素が少ない）", pxNear35 && pxNoNear && pxNoNear.changed > pxNear35.changed * 1.1, `near=0.6: ${pxNear35?.changed} / near=0: ${pxNoNear?.changed}`);
  const trackUp = await waitUntil(async () => {
    const s = await phoneState(p1);
    return { ok: s.track === "gyro", s };
  }, 3000);
  check("スマホ 1: 見上げるとマーカーが画面外になり track = gyro", trackUp?.ok, `track=${trackUp?.s?.track}`);
  const ovGyro = await waitUntil(async () => {
    const me = (await overviewState(ov)).find((x) => x.id === p1id);
    return { ok: me && me.track === "gyro" && me.fade < 1, me };
  }, 5000);
  check("俯瞰画面: gyro の間は化身が薄くなる（fade < 1）", ovGyro?.ok, JSON.stringify(ovGyro?.me && { track: ovGyro.me.track, fade: ovGyro.me.fade }));
  await p1.eval("window.__keshin.setLook(30)");
  await sleep(600);
  const mid30 = await phoneState(p1);
  check("スマホ 1: 見上げ 30°（= lookUpDeg − 10）以下では描かない", mid30.drawn === false && mid30.fade === 0, `look=${mid30.look} fade=${mid30.fade}`);
  await p1.eval("window.__keshin.setLook(0)");
  const back0 = await waitUntil(async () => {
    const s = await phoneState(p1);
    return { ok: s.track === "marker", s };
  }, 8000);
  check("スマホ 1: 正面に戻すとマーカーを見つけて marker に戻る", back0?.ok, `track=${back0?.s?.track}`);

  // ---- 4. 2・3 人目の割り当て・途中入室 ----
  const p2 = await newWindow("phone2", `${BASE}?${PHONE}&name=Two&fakeShift=60&remoteLog=0`);
  const p3 = await newWindow("phone3", `${BASE}?${PHONE}&name=Three&fakeShift=-60&remoteLog=0`);
  const s23 = await waitUntil(async () => {
    const a = await phoneState(p2);
    const b = await phoneState(p3);
    return { ok: a?.me && b?.me && a.track === "marker" && b.track === "marker" && a.model !== "loading" && b.model !== "loading" && a.model !== "idle" && b.model !== "idle", a, b };
  }, 40000);
  const ks = [s23?.a?.keshin, s23?.b?.keshin].sort();
  check("スマホ 2・3 に化身 1・2 が割り当てられる（最初の 3 人は別々）", ks[0] === 1 && ks[1] === 2, JSON.stringify(ks));
  const ov2 = await newWindow("overview2", `${BASE}overview.html?room=${ROOM}&remoteLog=0`);
  const late = await waitUntil(async () => {
    const me = (await overviewState(ov2)).find((x) => x.id === p1id);
    return { ok: !!me && me.u !== null, me };
  }, 10000);
  check("後から開いた俯瞰画面 2: スマホ 1 の化身は演出なしで出切った状態（u = 1.5）", late?.me && late.me.on === true && late.me.u === 1.5, JSON.stringify(late?.me && { on: late.me.on, u: late.me.u }));

  // ---- 5. 3 人とも出して俯瞰画面のスクリーンショット ----
  // せり上がりの途中（押して約 0.75s: 腰の渦から上半身が生えてくる）も撮る
  await ov.eval("window.__keshinOverview.setView([3.4, 1.9, 5.6], [0, 0.1, 1.2])");
  for (const p of [p2, p3]) await p.eval("document.querySelector('#keshin-button').click()");
  await sleep(750);
  await ov.shot("overview-2-rising.png");
  const all = await waitUntil(async () => {
    const st = await overviewState(ov);
    return { ok: st.length === 3 && st.every((x) => x.drawn && x.u === 1.5), st };
  }, 8000);
  check("俯瞰画面: 3 人の化身（0・1・2）が出ている", all?.ok, JSON.stringify(all?.st?.map((x) => [x.name, x.keshin, x.u, x.drawn, x.fallback])));
  await ov.eval("window.__keshinOverview.setView([3.4, 1.9, 5.6], [0, 0.1, 1.2])");
  await sleep(500);
  await ov.shot("overview-2-all.png");
  await ov.eval("window.__keshinOverview.setView([-2.6, 1.4, -1.4], [0, 0.3, 1.2])");
  await sleep(500);
  await ov.shot("overview-3-front.png");
  // 各化身をスマホ側の主観でも撮る（見上げ）
  for (const [p, name] of [[p2, "phone2"], [p3, "phone3"]]) {
    await p.eval("window.__keshin.setLook(55)");
    await waitUntil(async () => {
      const st = await phoneState(p);
      return { ok: st.drawn && st.track === "gyro" };
    }, 4000);
    await p.shot(`${name}-lookup.png`);
    await p.eval("window.__keshin.setLook(0)");
  }

  // ---- 途中反転: 消している途中で出し直すと、俯瞰画面の見え方が飛ばない ----
  await p1.eval("document.querySelector('#keshin-button').click()");
  await sleep(450);
  const before = (await overviewState(ov)).find((x) => x.id === p1id);
  await p1.eval("document.querySelector('#keshin-button').click()");
  const flipped = await waitUntil(async () => {
    const me = (await overviewState(ov)).find((x) => x.id === p1id);
    return { ok: me && me.on === true, me };
  }, 3000, 30);
  console.log(`reverse: before=${JSON.stringify(before && { on: before.on, u: before.u })} after=${JSON.stringify(flipped?.me && { on: flipped.me.on, u: flipped.me.u })}`);
  check(
    "途中反転: 消去の途中（0 < u < 1.5）で出し直すと u がその続きから（差 < 0.35）",
    before && before.on === false && before.u > 0 && before.u < 1.5 && flipped?.me && Math.abs(flipped.me.u - before.u) < 0.35,
    `before u=${before?.u} after u=${flipped?.me?.u}`,
  );

  console.log(`models (overview): ${JSON.stringify(await ov.eval("window.__keshinOverview.models()"))}`);
  // ---- 6. 例外・実機ログ ----
  await sleep(1500);
  const exceptions = pages.flatMap((p) => p.exceptions.map((e) => `${p.name}: ${e}`));
  check("例外が出ていない", exceptions.length === 0, exceptions.slice(0, 3).join(" | "));
  // シェーダーのコンパイル失敗（onBeforeCompile の差し込み・オーラの粒子）は例外ではなく console に出るので別に見る
  const shaderErrors = pages.flatMap((p) => p.logs.filter((l) => /Shader Error|WebGLProgram|THREE\.WebGLRenderer/.test(l)).map((l) => `${p.name}: ${l.slice(0, 200)}`));
  check("シェーダーのエラーが出ていない", shaderErrors.length === 0, shaderErrors.slice(0, 2).join(" | "));
  const hud1 = await p1.eval("document.querySelector('#hud')?.textContent ?? ''");
  console.log(`phone1 HUD:\n${hud1}`);
  check("HUD に fps・マーカー検出・描画・三角形・draw calls・track・化身・見上げ・モデルが出る", /fps=\d+ det=\d+ms render=[\d.]+ms\(2眼\) tris=\d+ calls=\d+/.test(hud1) && /track=/.test(hud1) && /keshin=#0on/.test(hud1) && /look=/.test(hud1) && /model=/.test(hud1));
  // client.log はこの確認の前からの追記ぶんを見る（バイト数で切ってから UTF-8 にする。日本語があるので文字数とずれる）
  await sleep(1500);
  const logText = existsSync(LOG_FILE) ? readFileSync(LOG_FILE).subarray(statSync(LOG_FILE).size < logSizeBefore ? 0 : logSizeBefore).toString("utf8") : "";
  const stateLines = logText.split("\n").filter((l) => l.includes("keshin-phone") && /fps=\d+ det=/.test(l));
  const eventLines = logText.split("\n").filter((l) => l.includes("keshin-phone") && /event=(welcome|keshin-on|marker-first|model-(loaded|failed))/.test(l));
  check("logs/client.log に keshin-phone の snapshot（1 秒ごと）が書かれる", stateLines.length >= 5, `${stateLines.length} 行`);
  check("logs/client.log に出来事（入室・化身 on・マーカー・モデル）が書かれる", eventLines.length >= 4, `${eventLines.length} 行`);
  if (stateLines.length > 0) console.log(`log sample: ${stateLines.at(-1)}`);

  // ================= 段階 2: 相手の化身をスマホに描く・人の形で隠す =================
  // 段階 1 のページは閉じて軽くする
  for (const p of [...pages]) await browser.send("Target.closeTarget", { targetId: p.targetId });
  pages.length = 0;
  await sleep(500);
  // 段階 2 は部屋を広く使うので、フェイクカメラのマーカーを 600mm にする（3.6m 先でも確実に検出できる大きさ）
  // 段階 2 の確認は段階 2 の位置の決め方（申告位置）で。段階 3 の B は下の「段階 3」で確かめる
  const S2 = `fov=70&camZoom=1&fakecam=1&autostart=1&markerMm=600&room=${ROOM2}&remoteLog=0&posMode=declared`;
  const ovS2 = await newWindow("overview-s2", `${BASE}overview.html?room=${ROOM2}&markerMm=600&remoteLog=0`);
  // A: マーカーの右 0.3m・3.6m 手前。?fakeperson=1 で相手の申告位置に合成の体を描き、同じ形をマスクに使う（化身 0）
  // A は人の形で隠す仕組みの確認用に段階 2 の見え方（?look=0: 化身が人に重なる配置）。段階 3 の C の見え方は鏡と段階 3 で確かめる
  const pA = await newWindow("A", `${BASE}?${S2}&fakeperson=1&fakeCamPos=0.3,0,3.6&name=A&look=0`);
  const sA = await waitUntil(async () => {
    const s = await phoneState(pA);
    return { ok: s && s.me && s.track === "marker" && s.warmup !== "-" && s.model !== "loading" && s.model !== "idle", s };
  }, 40000);
  check("段階 2: A が入室してマーカーを見ている（化身 0）", sA?.ok && sA.s.keshin === 0, JSON.stringify(sA?.s && { keshin: sA.s.keshin, track: sA.s.track }));
  // 化身 1 は Node の WebSocket で埋める（あとで gyro / none / 通信切れの確認に使う仮想のプレイヤー V）
  const vq = new URLSearchParams({ room: ROOM2, role: "player", v: String(KESHIN_PROTOCOL_VERSION), markerId: "0", markerMm: "600", name: "V", session: "virtualPlayerV1" });
  const vws = new WebSocket(`wss://localhost:${PORT}${KESHIN_PATH}?${vq}`, { rejectUnauthorized: false, headers: { origin: `https://localhost:${PORT}` } });
  const vMsgs = [];
  vws.on("message", (d) => vMsgs.push(JSON.parse(d.toString())));
  vws.on("error", () => {});
  await waitUntil(async () => ({ ok: vMsgs.some((m) => m.type === "welcome") }), 5000);
  const vId = vMsgs.find((m) => m.type === "welcome")?.id;
  // B: A とマーカーを結ぶ線の上、マーカーの 1.3m 手前からマーカーの方を向く（= A に背を向ける）。3 人目なので化身 2
  // （ランスロット。腰の切断面が頭より下）。B の化身は B の背後 = A と B の間に立ち、A から見ると B の上半身に重なる（人より手前）。
  // A からはマーカーが B の陰になるので、A は B が入る前にマーカーを見ておく（以後はアンカーを保ったまま gyro）
  const pB = await newWindow("B", `${BASE}?${S2}&occlude=0&fakeCamPos=0.108,0,1.3&fakeYaw=-4.75&name=B`);
  const sB = await waitUntil(async () => {
    const s = await phoneState(pB);
    return { ok: s && s.me && s.track === "marker", s };
  }, 40000);
  const bId = sB?.s?.me;
  check("段階 2: B が入室してマーカーを見ている（化身 2）", sB?.ok && sB.s.keshin === 2, JSON.stringify(sB?.s && { keshin: sB.s.keshin, track: sB.s.track }));
  // A 側の B のビューの先行コンパイルが済むまで待ってから、B が化身を出す
  await waitUntil(async () => {
    const r = (await pA.eval("window.__keshin.remoteState()")).find((x) => x.id === bId);
    return { ok: r && r.warmPending === null && !(await phoneState(pA)).warmup.startsWith("-") };
  }, 20000);
  await sleep(500);
  const progA0 = (await phoneState(pA)).programs;
  await pB.eval("document.querySelector('#keshin-button').click()");
  const rB = await waitUntil(async () => {
    const r = (await pA.eval("window.__keshin.remoteState()")).find((x) => x.id === bId);
    return { ok: r && r.drawn, r };
  }, 10000);
  await sleep(1800);
  const progA1 = (await phoneState(pA)).programs;
  check("段階 2: A の画面に B の化身が出る（marker・薄さ 1）", rB?.ok && rB.r.track === "marker" && rB.r.fade === 1, JSON.stringify(rB?.r && { drawn: rB.r.drawn, track: rB.r.track, fade: rB.r.fade, fallback: rB.r.fallback }));
  check("段階 2: 相手の化身が初めて出たときに新しくリンクされたプログラムは 0 本", progA1 === progA0, `programs ${progA0}→${progA1}`);
  // 配置: B の申告（マーカー座標系）→ A のアンカーで A のワールドへ。化身は B の頭の背後・同じ向き
  const ovB = (await ovS2.eval("window.__keshinOverview.state()")).find((x) => x.id === bId);
  const anc = await pA.eval("window.__keshin.anchorWorld()");
  const rB2 = (await pA.eval("window.__keshin.remoteState()")).find((x) => x.id === bId);
  if (ovB && anc && rB2?.world) {
    const rp = rotateByQuat(anc.quat, ovB.head);
    const expectHead = [anc.pos[0] + rp[0], anc.pos[1] + rp[1], anc.pos[2] + rp[2]];
    const headErr = Math.hypot(...expectHead.map((v, i) => v - rB2.head[i]));
    const fw = rotateByQuat(anc.quat, [ovB.fwd[0], 0, ovB.fwd[1]]);
    const fl = Math.hypot(fw[0], fw[2]);
    const fwd = [fw[0] / fl, fw[2] / fl];
    const rel = [rB2.world.origin[0] - rB2.head[0], rB2.world.origin[2] - rB2.head[2]];
    const behind = rel[0] * fwd[0] + rel[1] * fwd[1];
    const same = rB2.world.front[0] * fwd[0] + rB2.world.front[1] * fwd[1];
    check("段階 2: B の頭 = B の申告位置をマーカー座標系から A のワールドへ直した位置（差 < 2cm）", headErr < 0.02, `${headErr.toFixed(4)}m`);
    check("段階 2: B の化身は B の背後（原点 − 頭 と fwd の内積 < −0.25m）で同じ向き（> 0.99）", behind < -0.25 && same > 0.99, `behind=${behind.toFixed(3)} same=${same.toFixed(4)}`);
  } else {
    check("段階 2: 配置を確かめるための状態が取れる", false, JSON.stringify({ ovB: !!ovB, anc: !!anc, world: !!rB2?.world }));
  }
  // B と B の化身は A の視野の中央にある
  const occ = await waitUntil(async () => {
    const o = await pA.eval("window.__keshin.occlusionState()");
    return { ok: o.on === 1 && o.person, o };
  }, 10000);
  console.log(`A occlusion: ${occ?.o?.text}`);
  check("段階 2: 相手の化身が視野に入ると人の形のマスク（フェイクの人）で隠し始める", occ?.ok, occ?.o?.text);
  await sleep(600);
  const progA2 = (await phoneState(pA)).programs;
  if (progA2 !== progA1) {
    const names = await pA.eval("window.__keshin.programNames()");
    console.log(`A programs:\n  ${names.slice(progA1).join("\n  ")}`);
  }
  check("段階 2: 初めてマスクで隠したときに新しくリンクされたプログラムは 0 本", progA2 === progA1, `programs ${progA1}→${progA2}`);
  // B は A に背を向けている（B の化身は A と B の間 = 人より手前）。人の形の上でも化身の手前の部分は消えない（モデルだけで比べる）
  const pxOn = await pA.eval(`window.__keshin.pixelDiffRemote(${JSON.stringify(bId)}, true, "model")`);
  const pxOff = await pA.eval(`window.__keshin.pixelDiffRemote(${JSON.stringify(bId)}, false, "model")`);
  console.log(`A pixels（背を向けた B の化身のモデル。人の中 / 外は背景の色で判定）: occlude=on ${JSON.stringify(pxOn)} / off ${JSON.stringify(pxOff)}`);
  check("段階 2・背を向けた: 人の形の上にも化身が描かれる配置（確認の前提）", pxOff && pxOff.inside > 300, `inside=${pxOff?.inside}`);
  check("段階 2・背を向けた: 化身は人より手前なので、人の形の上でも消えない（隠さないときの 80% 以上残る）", pxOn && pxOff && pxOn.inside >= pxOff.inside * 0.8, `on=${pxOn?.inside} off=${pxOff?.inside}`);
  check("段階 2・背を向けた: 人のいない所の化身も残る（90% 以上）", pxOn && pxOff && pxOn.outside > 1000 && pxOn.outside >= pxOff.outside * 0.9, `on=${pxOn?.outside} off=${pxOff?.outside}`);
  await pA.shot("stage2-back-occluded.png");
  await pA.eval("window.__keshin.setOcclusionDisabled(true)");
  await sleep(300);
  await pA.shot("stage2-back-no-occlusion.png");
  await pA.eval("window.__keshin.setOcclusionDisabled(false)");
  // 自分の化身は隠さない: A も化身を出して見上げ、隠す処理の有無で自分の化身の画素が変わらない
  await pA.eval("document.querySelector('#keshin-button').click()");
  await sleep(1800);
  await pA.eval("window.__keshin.setLook(55, 0)");
  await sleep(500);
  // 相手の化身と重なると自分の化身の見え方（深度・半透明）が変わるので、相手の化身は描かずに比べる（自分の化身のシェーダーに隠す処理が無いこと）
  const selfOn = await pA.eval("window.__keshin.pixelDiff(false, true)");
  await pA.eval("window.__keshin.setOcclusionDisabled(true)");
  const selfOff = await pA.eval("window.__keshin.pixelDiff(false, true)");
  await pA.eval("window.__keshin.setOcclusionDisabled(false)");
  check("段階 2: 自分の化身（見上げ）はマスクで欠けない（隠す処理の有無で画素が同じ ±1%）", selfOn && selfOff && selfOn.changed > 1000 && Math.abs(selfOn.changed - selfOff.changed) <= selfOff.changed * 0.01, `on=${selfOn?.changed} off=${selfOff?.changed}`);
  await pA.eval("window.__keshin.setLook(0, 0)");
  // 俯瞰画面
  await ovS2.eval("window.__keshinOverview.setView([4.6, 3.4, 2.6], [-0.2, -0.4, 2.3])");
  await sleep(500);
  await ovS2.shot("stage2-overview.png");

  // ?occlude=0: 隠さない（Pose も読み込まない）
  const pA0 = await newWindow("A-occlude0", `${BASE}?${S2}&occlude=0&fakeCamPos=0.8,0,3.6&name=A0`);
  await waitUntil(async () => {
    const s = await phoneState(pA0);
    return { ok: s && s.track === "marker" };
  }, 40000);
  await pA0.eval("window.__keshin.setLook(0, 25)");
  const r0 = await waitUntil(async () => {
    const r = (await pA0.eval("window.__keshin.remoteState()")).find((x) => x.id === bId);
    return { ok: r && r.drawn, r };
  }, 10000);
  await sleep(800);
  const o0 = await pA0.eval("window.__keshin.occlusionState()");
  const px0 = await pA0.eval(`window.__keshin.pixelDiffRemote(${JSON.stringify(bId)}, true)`);
  check("段階 2: ?occlude=0 では隠さない（隠す処理が off・uMaskOn 0・Pose を読み込まない）で相手の化身は描く", r0?.ok && o0.status === "off" && o0.on === 0 && px0?.changed > 1000, `${o0.text} pixels=${JSON.stringify(px0)}`);
  await browser.send("Target.closeTarget", { targetId: pA0.targetId });
  pages.splice(pages.indexOf(pA0), 1);

  // 向き合った配置（仮想のプレイヤー V が A の方を向く = V の化身は V の向こう側）: 人の形の上の化身は隠れる。
  // あわせて信用度: marker → gyro（経過で薄く）→ none（描かない）→ 通信切れ（描かない）。B の化身は重ならないよう消しておく
  await pB.eval("document.querySelector('#keshin-button').click()");
  const vSend = (pose) => vws.send(JSON.stringify({ type: "pose", ...pose }));
  vws.send(JSON.stringify({ type: "keshin", on: true }));
  // V: A から見て左前（A が左へ 25° 向くと視野の中央）。A の方（+Z）を向く = V の化身は V の向こう側（壁の側）
  await pA.eval("window.__keshin.setLook(0, 25)");
  const vHead = [-0.8, 0, 2.0];
  // A（0.3, 3.6）の方を真っすぐ向く = V の化身は A から見て V の真後ろ（化身の大きさ・背中からの距離によらず V に重なる）
  const vFwd = (() => {
    const d = [0.3 - vHead[0], 3.6 - vHead[2]];
    const l = Math.hypot(...d);
    return [d[0] / l, d[1] / l];
  })();
  const vPoseTimer = setInterval(() => vSend({ pos: vHead, quat: [0, 1, 0, 0], fwd: vFwd, track: "marker", ageMs: 0 }), 100);
  const vm = await waitUntil(async () => {
    const r = (await pA.eval("window.__keshin.remoteState()")).find((x) => x.id === vId);
    return { ok: r && r.drawn && r.track === "marker", r };
  }, 8000);
  await sleep(1800);
  await waitUntil(async () => {
    const o = await pA.eval("window.__keshin.occlusionState()");
    return { ok: o.on === 1 && o.person };
  }, 5000);
  const vOn = await pA.eval(`window.__keshin.pixelDiffRemote(${JSON.stringify(vId)}, true, "model")`);
  const vOff = await pA.eval(`window.__keshin.pixelDiffRemote(${JSON.stringify(vId)}, false, "model")`);
  console.log(`A pixels（向き合った V の化身のモデル）: occlude=on ${JSON.stringify(vOn)} / off ${JSON.stringify(vOff)}`);
  check("段階 2・向き合った: 人の形の上にも化身が描かれる配置（確認の前提）", vOff && vOff.inside > 300, `inside=${vOff?.inside}`);
  check("段階 2・向き合った: 化身は人の向こう側なので、人の形の上では隠れる（隠さないときの 5% 未満）", vOn && vOff && vOn.inside < vOff.inside * 0.05, `on=${vOn?.inside} off=${vOff?.inside}`);
  check("段階 2・向き合った: 人のいない所の化身は残る（90% 以上）", vOn && vOff && vOn.outside > 1000 && vOn.outside >= vOff.outside * 0.9, `on=${vOn?.outside} off=${vOff?.outside}`);
  await pA.shot("stage2-facing-occluded.png");
  await pA.eval("window.__keshin.setOcclusionDisabled(true)");
  await sleep(300);
  await pA.shot("stage2-facing-no-occlusion.png");
  // 段階 3 の A: 骨格から描いた人の形（?maskSource=skel。フェイクの骨格から描く）でも、人の上の化身は隠れる
  await pA.eval("window.__keshin.setOcclusionDisabled(false)");
  await pA.eval("window.__keshin.setMaskSource('skel')");
  await sleep(500);
  const vSkel = await pA.eval(`window.__keshin.pixelDiffRemote(${JSON.stringify(vId)}, true, "model")`);
  const occSkel = await pA.eval("window.__keshin.occlusionState()");
  console.log(`A pixels（骨格から描いた人の形）: ${JSON.stringify(vSkel)} ${occSkel.text}`);
  check("段階 3・A: 骨格から描いた人の形（msrc=skel）でも、人の上の化身は隠れる（隠さないときの 5% 未満）・人のいない所は残る", vSkel && vOff && /msrc=skel/.test(occSkel.text) && vSkel.inside < vOff.inside * 0.05 && vSkel.outside >= vOff.outside * 0.85, `skel on=${vSkel?.inside}/${vSkel?.outside} off=${vOff?.inside}/${vOff?.outside}`);
  await pA.shot("stage3-skel-mask.png");
  await pA.eval("window.__keshin.setMaskSource('auto')");
  await pA.eval("window.__keshin.setOcclusionDisabled(false)");
  clearInterval(vPoseTimer);
  check("段階 2: 相手が marker のとき描く（薄さ 1）", vm?.ok && vm.r.fade === 1, JSON.stringify(vm?.r && { track: vm.r.track, fade: vm.r.fade }));
  const vg = setInterval(() => vSend({ pos: vHead, quat: [0, 1, 0, 0], fwd: vFwd, track: "gyro", ageMs: 1500 }), 100);
  await sleep(700);
  const rg = (await pA.eval("window.__keshin.remoteState()")).find((x) => x.id === vId);
  check("段階 2: 相手が gyro（最後にマーカーを見てから 1.5s）のとき薄く描く（0.6〜0.8）", rg && rg.drawn && rg.track === "gyro" && rg.fade > 0.6 && rg.fade < 0.8, JSON.stringify(rg && { track: rg.track, fade: rg.fade, ageMs: rg.ageMs }));
  clearInterval(vg);
  const vgs = setInterval(() => vSend({ pos: [vHead[0] + 0.5, 0, vHead[2]], quat: [0, 1, 0, 0], fwd: vFwd, track: "gyro", ageMs: 5000 }), 100);
  await sleep(700);
  const rgs = (await pA.eval("window.__keshin.remoteState()")).find((x) => x.id === vId);
  check("段階 2: gyro が staleMs を過ぎたら半分の薄さで位置を止める（申告が 0.5m 動いても表示は動かない）", rgs && rgs.drawn && Math.abs(rgs.fade - 0.5) < 1e-6 && Math.abs(rgs.head[0] - vm.r.head[0]) < 0.05, JSON.stringify(rgs && { fade: rgs.fade, head: rgs.head, before: vm?.r?.head }));
  clearInterval(vgs);
  // 長く見失った相手（gyro の経過が ?staleHideMs=8000 を超えた）: フェードで消す → マーカーを見直したらまた出す
  const vgf = setInterval(() => vSend({ pos: vHead, quat: [0, 1, 0, 0], fwd: vFwd, track: "gyro", ageMs: 8300 }), 100);
  await sleep(600);
  const rgf = (await pA.eval("window.__keshin.remoteState()")).find((x) => x.id === vId);
  clearInterval(vgf);
  check("段階 2: gyro が staleHideMs（8s）を超えるとフェードで薄くなっていく（0.5 より薄い・reason=stale-hiding）", rgf && rgf.drawn && rgf.fade > 0.02 && rgf.fade < 0.45 && rgf.reason === "stale-hiding", JSON.stringify(rgf && { drawn: rgf.drawn, fade: rgf.fade, reason: rgf.reason, ageMs: rgf.ageMs }));
  const vgh = setInterval(() => vSend({ pos: vHead, quat: [0, 1, 0, 0], fwd: vFwd, track: "gyro", ageMs: 9500 }), 100);
  const rgh = await waitUntil(async () => {
    const r = (await pA.eval("window.__keshin.remoteState()")).find((x) => x.id === vId);
    return { ok: r && !r.drawn && r.reason === "stale", r };
  }, 4000);
  clearInterval(vgh);
  const hiddenLog = pA.logs.find((l) => /event=remote-hidden/.test(l) && l.includes(vId) && /reason=stale\b/.test(l)) ?? "";
  check("段階 2: 長く見失った相手（gyro 9.5s）の化身は消える（reason=stale）・ログに remote-hidden reason=stale", rgh?.ok && hiddenLog !== "", `${JSON.stringify(rgh?.r && { drawn: rgh.r.drawn, reason: rgh.r.reason })} | ${hiddenLog}`);
  const vmk = setInterval(() => vSend({ pos: vHead, quat: [0, 1, 0, 0], fwd: vFwd, track: "marker", ageMs: 0 }), 100);
  const rgm = await waitUntil(async () => {
    const r = (await pA.eval("window.__keshin.remoteState()")).find((x) => x.id === vId);
    return { ok: r && r.drawn && r.fade === 1, r };
  }, 4000);
  clearInterval(vmk);
  const shownLog = pA.logs.find((l) => /event=remote-shown/.test(l) && l.includes(vId) && /after=stale/.test(l)) ?? "";
  check("段階 2: マーカーを見直した pose が届くと、また出す（薄さ 1・ログに remote-shown after=stale）", rgm?.ok && shownLog !== "", `${JSON.stringify(rgm?.r && { drawn: rgm.r.drawn, fade: rgm.r.fade })} | ${shownLog}`);
  vSend({ track: "none", ageMs: null });
  await sleep(500);
  const rn = (await pA.eval("window.__keshin.remoteState()")).find((x) => x.id === vId);
  check("段階 2: 相手が none のとき描かない", rn && !rn.drawn && rn.reason === "peer-none", JSON.stringify(rn && { drawn: rn.drawn, reason: rn.reason }));
  vSend({ pos: vHead, quat: [0, 1, 0, 0], fwd: vFwd, track: "marker", ageMs: 0 });
  await sleep(6000);
  const rl = (await pA.eval("window.__keshin.remoteState()")).find((x) => x.id === vId);
  check("段階 2: 相手の pose が 5 秒届かない（通信切れ）と描かない", rl && !rl.drawn && rl.reason === "lost", JSON.stringify(rl && { drawn: rl.drawn, reason: rl.reason, track: rl.track }));

  // 自分のアンカーが無い間は相手の化身を描かず、視界内メッセージで知らせる
  const pN = await newWindow("A-noanchor", `${BASE}?${S2}&occlude=0&fakeCamPos=0,0,3.6&fakeYaw=180&name=N`);
  const rN = await waitUntil(async () => {
    const st = await phoneState(pN);
    const r = st?.me ? (await pN.eval("window.__keshin.remoteState()")).find((x) => x.id === bId) : null;
    return { ok: st?.track === "none" && r && !r.drawn && r.reason === "self-no-anchor", st, r };
  }, 30000);
  const msgN = await pN.eval("window.__keshin.messageText?.() ?? ''");
  check("段階 2: 自分のアンカーが無い間は相手の化身を描かない（理由 self-no-anchor）", rN?.ok, JSON.stringify(rN?.r && { drawn: rN.r.drawn, reason: rN.r.reason, track: rN.st?.track }));
  check("段階 2: そのとき「相手の化身の位置が分かりません」を出す", /相手の化身の位置が分かりません/.test(msgN), msgN);
  await browser.send("Target.closeTarget", { targetId: pN.targetId });
  pages.splice(pages.indexOf(pN), 1);

  // 本物の PoseLandmarker（segmentation mask 付き）: 相手が入室していれば、相手の化身が出ていなくても読み込みだけ先に済ませる
  // （B の化身はいま消えている・A の化身も消す = 回す条件はまだ満たさない）
  await pA.eval("document.querySelector('#keshin-button').click()");
  await sleep(1300);
  const pR = await newWindow("A-realpose", `${BASE}?${S2}&fakeCamPos=0.9,0,3.6&name=R`);
  await waitUntil(async () => ((await phoneState(pR))?.track === "marker" ? { ok: true } : null), 40000);
  const pre = await waitUntil(async () => {
    const o = await pR.eval("window.__keshin.occlusionState()");
    return { ok: o.status === "ready" || o.status === "failed", o };
  }, 90000, 1000);
  const readyLog = pR.logs.find((l) => /event=mask-ready/.test(l)) ?? "";
  console.log(`real pose preload: ${pre?.o?.text} / ${readyLog}`);
  check("段階 2: 相手が入室していれば、化身が視野に入る前に Pose の読み込みを済ませる（回してはいない）", pre?.o?.status === "ready" && /run=0/.test(pre.o.text) && /load=\d+ms/.test(readyLog), `${pre?.o?.text} | ${readyLog}`);
  // B の化身を出し直す → 視野に入るので回し始める
  await pB.eval("document.querySelector('#keshin-button').click()");
  await pR.eval("window.__keshin.setLook(0, 25)");
  const oR = await waitUntil(async () => {
    const o = await pR.eval("window.__keshin.occlusionState()");
    return { ok: (o.status === "ready" && o.hz > 0) || o.status === "failed", o };
  }, 90000, 1000);
  console.log(`real pose: ${oR?.o?.text}`);
  check("段階 2: 本物の PoseLandmarker（segmentation mask）が初期化でき、相手の化身が視野にある間マスクを更新する", oR?.o?.status === "ready" && oR.o.hz > 0 && oR.o.poseMs > 0, oR?.o?.text);
  // B は化身を出し直したばかりなので、出現の演出（不透明度が上がるまで約 0.3 秒）を待ってから見る
  const rRw = await waitUntil(async () => {
    const r = (await pR.eval("window.__keshin.remoteState()")).find((x) => x.id === bId);
    return { ok: r && r.drawn, r };
  }, 8000);
  const rR = rRw?.r;
  check("段階 2: 人が写っていなければ隠さず描く", rR && rR.drawn, JSON.stringify(rR && { drawn: rR.drawn, reason: rR.reason }));
  const hudA = await pA.eval("document.querySelector('#hud')?.textContent ?? ''");
  console.log(`A HUD:\n${hudA}`);
  check("段階 2: HUD に相手ごとの行（track・距離・描画・薄さ・跳び）と occlusion（Pose の ms・Hz・段・マスクの古さ・人数・マスクの枚数・入力・明るさ・delegate）", /remote B\(p\d+\) #2o(n|ff) marker( [\d.]+s)? dist=[\d.]+m drawn=[01]\(\w+\) fade=[\d.]+ jump=[\d.]+m/.test(hudA) && /occlude=fake .* pose=\d+ms mask=\d+ms hz=\d+ maskHz=\d+\/15 age=\d+ms person=[01] poses=\d masks=\d mmax=\S+ mmean=\S+ mfrac=\S+ msrc=\w+ in=\d+x\d+ lum=\d+ dg=fake found=/.test(hudA));
  check("段階 2: HUD の cam= に facingMode と選んだ理由（フェイクカメラは facing=fake）", /cam=\d+x\d+ .*facing=fake/.test(hudA), (hudA.match(/cam=.*/) ?? [""])[0]);
  // 本物の Pose の診断（1 回の結果の人数・マスクの枚数・入力の大きさ・明るさ・delegate）
  const oRd = await pR.eval("window.__keshin.occlusionState()");
  console.log(`real pose diag: ${oRd.text}`);
  check("段階 2: 本物の Pose の診断が出る（入力は長辺 ?maskDetW=512・明るさは真っ黒でない・delegate・人数とマスクの枚数）", oRd.lastInput === "512x384" && oRd.lastLuma > 20 && /^(GPU|CPU)$/.test(oRd.delegate) && Number.isInteger(oRd.lastPoses) && Number.isInteger(oRd.lastMasks) && /poses=\d masks=\d mmax=[\d.]+ mmean=[\d.]+ mfrac=[\d.]+ msrc=\w+ in=512x384 lum=\d+ dg=(GPU|CPU) found=\d+\/\d+/.test(oRd.text), JSON.stringify({ in: oRd.lastInput, lum: oRd.lastLuma, dg: oRd.delegate, poses: oRd.lastPoses, masks: oRd.lastMasks }));
  const hzLogs = pages.flatMap((p) => p.logs.filter((l) => /event=mask-hz/.test(l)).map((l) => `${p.name}: ${l}`));
  console.log(`mask-hz events: ${hzLogs.length ? hzLogs.join(" | ") : "(none)"}`);
  await browser.send("Target.closeTarget", { targetId: pR.targetId });
  pages.splice(pages.indexOf(pR), 1);

  // ?maskDebug=1（本物の Pose）: 相手の化身が視野に無くても回し、入力の縮小画像とマスクを画面の隅に出す。
  // あわせて GPU → CPU の比べ方（?maskProbeAfterMs=3000 に縮める）: フェイクカメラの映像には人がいないので GPU も CPU も 0 人 → GPU のまま。
  // 実機ログ（logs/client.log）の 1 行に診断が全部入ることも確かめる（このページだけ remoteLog を有効にする）
  const logSize2 = existsSync(LOG_FILE) ? statSync(LOG_FILE).size : 0;
  const S2log = S2.replace("&remoteLog=0", "");
  const pD = await newWindow("A-maskdebug", `${BASE}?${S2log}&maskDebug=1&maskProbeAfterMs=3000&fakeCamPos=0.9,0,3.6&fakeYaw=180&name=D`);
  const oD = await waitUntil(async () => {
    const o = await pD.eval("window.__keshin?.occlusionState() ?? null");
    return { ok: o && ((o.status === "ready" && o.runs > 3 && o.lastLuma !== null) || o.status === "failed"), o };
  }, 90000, 1000);
  const dbg = await pD.eval(`(() => {
    const box = document.querySelector("#mask-debug");
    if (!box) return null;
    const [inp, mask] = box.querySelectorAll("canvas");
    const nonBlack = (c) => { const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 60) n++; return n; };
    return { inW: inp.width, inH: inp.height, inLit: nonBlack(inp), maskW: mask.width, maskH: mask.height };
  })()`);
  check("段階 2: ?maskDebug=1 は相手の化身が視野に無くても Pose を回し（run=1）、画面の隅に入力の縮小画像とマスクを出す", oD?.o?.status === "ready" && /run=1/.test(oD.o.text) && dbg && dbg.inLit > 500 && dbg.maskW > 0, `${oD?.o?.text} | ${JSON.stringify(dbg)}`);
  await pD.shot("stage2-maskdebug-realpose.png");
  if (oD?.o?.delegate === "GPU") {
    const pr = await waitUntil(async () => {
      const o = await pD.eval("window.__keshin.occlusionState()");
      return { ok: o.probe === "kept-gpu" || o.probe === "switched-cpu" || o.probe === "failed", o };
    }, 60000, 1000);
    const probeLogs = pD.logs.filter((l) => /event=mask-delegate/.test(l));
    console.log(`probe: ${pr?.o?.probe} / ${probeLogs.join(" | ")}`);
    check("段階 2: GPU で 0 人が続くと CPU でも同じフレームを回して比べ、両方 0 人なら GPU のまま（ログに理由）", pr?.o?.probe === "kept-gpu" && probeLogs.some((l) => /keep=GPU reason=both-0/.test(l)), `${pr?.o?.probe} | ${probeLogs.join(" | ")}`);
  } else {
    console.log(`probe: delegate=${oD?.o?.delegate} なので比べない（GPU のときだけ）`);
  }
  await sleep(2500);
  const logText2 = existsSync(LOG_FILE) ? readFileSync(LOG_FILE).subarray(logSize2).toString("utf8") : "";
  const diagLine = logText2.split("\n").filter((l) => l.includes("keshin-phone") && /poses=/.test(l)).at(-1) ?? "";
  console.log(`diag log line: ${diagLine}`);
  check("段階 2: 実機ログの 1 行に診断が全部入る（人数・マスクの枚数・入力の大きさ・明るさ・delegate・段・カメラ）", /poses=\d masks=\d mmax=[\d.]+ mmean=[\d.]+ mfrac=[\d.]+ msrc=\w+ in=512x384 lum=\d+ dg=(GPU|CPU)/.test(diagLine) && /maskHz=\d+\/15/.test(diagLine) && /cam=facing=fake/.test(diagLine), diagLine.slice(0, 400));
  await browser.send("Target.closeTarget", { targetId: pD.targetId });
  pages.splice(pages.indexOf(pD), 1);
  // ?maskDebug=1（フェイクの人）: マスクが人の形に出るところの画面
  const pF = await newWindow("A-maskdebug-fake", `${BASE}?${S2}&maskDebug=1&fakeperson=1&fakeCamPos=0.3,0,3.6&name=F`);
  await waitUntil(async () => ((await phoneState(pF))?.track === "marker" ? { ok: true } : null), 40000);
  const oF = await waitUntil(async () => {
    const o = await pF.eval("window.__keshin?.occlusionState() ?? null");
    return { ok: o && o.person === true, o };
  }, 30000);
  await sleep(500);
  const maskLit = await pF.eval(`(() => { const c = document.querySelectorAll("#mask-debug canvas")[1]; if (!c) return -1; const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] > 200 && d[i + 2] > 200) n++; return n; })()`);
  check("段階 2: ?maskDebug=1 のマスクの縮小画像に人の形（白）が出る（フェイクの人）", oF?.ok && maskLit > 200, `${oF?.o?.text} | white=${maskLit}`);
  await pF.shot("stage2-maskdebug-fake.png");
  await browser.send("Target.closeTarget", { targetId: pF.targetId });
  pages.splice(pages.indexOf(pF), 1);
  // ================= 鏡モード（mirror.html）: iPad の前面カメラを鏡に。写った人（Pose）の背後にその人の化身 =================
  // 別の room で、スマホ 1 台（フェイク）と鏡（?fakeperson=1: 合成の人を映像に描き、Pose の代わりに同じ骨格と人の形のマスク）
  const ROOMM = `${ROOM}m`;
  const pP = await newWindow("M-phone", `${BASE}?fov=70&camZoom=1&fakecam=1&autostart=1&occlude=0&room=${ROOMM}&remoteLog=0&name=P`);
  const sP = await waitUntil(async () => {
    const st = await phoneState(pP);
    return { ok: st && st.me, st };
  }, 40000);
  const pId = sP?.st?.me;
  // 人の形で隠す仕組みの確認は段階 2 の見え方（?look=0）で。段階 3 の C の見え方は下の「鏡: 見え方」で
  const pM = await newWindow("mirror", `${BASE}mirror.html?room=${ROOMM}&fakecam=1&fakeperson=1&autostart=1&remoteLog=0&look=0`);
  const mirrorState = () => pM.eval("window.__keshinMirror?.state() ?? null");
  const m0 = await waitUntil(async () => {
    const st = await mirrorState();
    return { ok: st && st.me && st.persons.length === 1 && st.entries.some((e) => e.id === pId), st };
  }, 40000);
  console.log(`mirror: ${JSON.stringify(m0?.st && { me: m0.st.me, cam: m0.st.cam, persons: m0.st.persons, message: m0.st.message })}`);
  const mp = m0?.st?.persons?.[0];
  check("鏡: 見る専用で入室し、合成の人を 1 人見つける（頭 ≈ (0, 0.25, −3.2)・カメラの方を向く）", m0?.ok && mp && Math.hypot(mp.head[0], mp.head[1] - 0.25, mp.head[2] + 3.2) < 0.05 && mp.fwd[1] > 0.99, JSON.stringify(mp));
  check("鏡: 化身が 1 人も出ていないとき画面の下に「ゴーグルの人が化身ボタンを押すと出ます」", m0?.st?.message === "ゴーグルの人が化身ボタンを押すと出ます", m0?.st?.message);
  const tf = await pM.eval("window.__keshinMirror.transforms()");
  check("鏡: canvas（背景と 3D）は左右反転（scaleX(-1)）、HUD と案内は反転しない", tf && tf.canvas === "matrix(-1, 0, 0, 1, 0, 0)" && tf.hud === "none" && !tf.hudInsideApp && tf.message !== "matrix(-1, 0, 0, 1, 0, 0)" && !/^matrix\(-1/.test(tf.message), JSON.stringify(tf));
  // 画面（合成後のスクリーンショット）で左右を確かめる: 本人の左手首の赤い印は、反転前の画像では人の右、鏡では人の左に写る
  const scr = await pM.send("Page.captureScreenshot", { format: "png" });
  const lr = await pM.eval(`new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let rx = 0, rn = 0, px = 0, pn = 0;
      for (let i = 0; i < d.length; i += 4) {
        const x = (i / 4) % c.width;
        if (d[i] > 190 && d[i + 1] < 90 && d[i + 2] < 90) { rx += x; rn++; }
        else if (Math.abs(d[i] - 0x5a) + Math.abs(d[i + 1] - 0x6b) + Math.abs(d[i + 2] - 0x86) <= 24) { px += x; pn++; }
      }
      resolve({ red: rn ? rx / rn : null, redN: rn, person: pn ? px / pn : null, personN: pn, width: c.width });
    };
    img.src = "data:image/png;base64,${scr.result?.data ?? ""}";
  })`);
  check("鏡: 画面は左右反転している（合成の人の左手の赤い印が、人の中心より画面の左に写る）", lr && lr.redN > 20 && lr.personN > 1000 && lr.red < lr.person, JSON.stringify(lr));
  await pM.shot("mirror-1-waiting.png");
  // スマホが化身を出す → 鏡で合成の人の背後に出る
  await pP.eval("document.querySelector('#keshin-button').click()");
  const m1 = await waitUntil(async () => {
    const st = await mirrorState();
    const e = st?.entries.find((x) => x.id === pId);
    return { ok: e && e.drawn && e.world, e, st };
  }, 15000);
  await sleep(1800);
  const m1b = await mirrorState();
  const me1 = m1b?.entries.find((x) => x.id === pId);
  console.log(`mirror keshin: ${JSON.stringify(me1)}`);
  const behind = me1?.world && me1.head ? me1.head[2] - me1.world.origin[2] : NaN;
  check("鏡: 化身が出たら合成の人に割り当て（person 0）、人の背後（原点が頭より 0.2m 以上奥）に・カメラの方を向いて（同じ向き）出る", m1?.ok && me1?.personIndex === 0 && behind > 0.2 && me1.world.front[1] > 0.95 && Math.abs(me1.world.origin[0] - me1.head[0]) < 0.05, JSON.stringify({ behind, front: me1?.world?.front, head: me1?.head }));
  check("鏡: 足首が見えているので床は足首から（頭 − 床 ≈ 1.68m）", me1 && Math.abs(me1.eyeH - 1.68) < 0.05, String(me1?.eyeH));
  check("鏡: 化身が出ている間は案内を出さない", m1b?.message === "", m1b?.message);
  const mOn = await pM.eval(`window.__keshinMirror.pixelDiff(${JSON.stringify(pId)}, true)`);
  const mOff = await pM.eval(`window.__keshinMirror.pixelDiff(${JSON.stringify(pId)}, false)`);
  console.log(`mirror pixels（カメラの方を向いた人の背後の化身）: occlude=on ${JSON.stringify(mOn)} / off ${JSON.stringify(mOff)}`);
  check("鏡: 人の形の上にも化身が描かれる配置（確認の前提）", mOff && mOff.inside > 300, `inside=${mOff?.inside}`);
  check("鏡: 人の頭・体の上の化身は隠れる（隠さないときの 5% 未満）", mOn && mOff && mOn.inside < mOff.inside * 0.05, `on=${mOn?.inside} off=${mOff?.inside}`);
  check("鏡: 人のいない所の化身は残る（90% 以上）", mOn && mOff && mOn.outside > 1000 && mOn.outside >= mOff.outside * 0.9, `on=${mOn?.outside} off=${mOff?.outside}`);
  // 足元・腰のオーラにも濃さ（fade）が掛かる（見失ったときにオーラだけ突然消えない。スマホ・俯瞰画面の他人用も同じ）
  const aura1 = await pM.eval(`window.__keshinMirror.auraIntensity(${JSON.stringify(pId)}, 1)`);
  const aura05 = await pM.eval(`window.__keshinMirror.auraIntensity(${JSON.stringify(pId)}, 0.5)`);
  const aura01 = await pM.eval(`window.__keshinMirror.auraIntensity(${JSON.stringify(pId)}, 0.1)`);
  check("鏡: オーラの画素も濃さに合わせて薄くなる（fade 1 > 0.5 > 0.1。0.5 で 7 割未満）", aura1 > 10000 && aura05 < aura1 * 0.7 && aura01 < aura05 * 0.5, `fade1=${aura1} fade0.5=${aura05} fade0.1=${aura01}`);
  await pM.shot("mirror-2-keshin.png");
  await pM.eval("window.__keshinMirror.setOcclusionDisabled(true)");
  await sleep(300);
  await pM.shot("mirror-3-no-occlusion.png");
  await pM.eval("window.__keshinMirror.setOcclusionDisabled(false)");
  // 段階 3 の C（既定の見え方）: 腰を頭より上・後ろへ、下端を光に溶かし、背中から腰へ光の流れ。鏡をもう 1 つ開いて同じ人・同じ化身で確かめる
  const pML = await newWindow("mirror-look", `${BASE}mirror.html?room=${ROOMM}&fakecam=1&fakeperson=1&autostart=1&remoteLog=0`);
  const ml = await waitUntil(async () => {
    const st = await pML.eval("window.__keshinMirror?.state() ?? null");
    const e = st?.entries.find((x) => x.id === pId);
    return { ok: e && e.drawn && e.world, e };
  }, 30000);
  await sleep(1900);
  const mlOver = await pML.eval(`window.__keshinMirror.pixelDiff(${JSON.stringify(pId)}, false)`);
  const probe = await pML.eval(`window.__keshinMirror.lookProbe(${JSON.stringify(pId)})`);
  console.log(`mirror look: over=${JSON.stringify(mlOver)} dissolve=${JSON.stringify(probe?.dissolve)} stream=${JSON.stringify(probe?.stream && { hits: probe.stream.hits, total: probe.stream.total })}`);
  check("鏡・見え方: 化身の体が本人の頭・肩に被らない（人の形で隠す処理を切っても、人の画素に重なる化身の画素が 50 未満）", ml?.ok && mlOver && mlOver.inside < 50 && mlOver.changed > 3000, `inside=${mlOver?.inside} changed=${mlOver?.changed}`);
  const bands = probe?.dissolve?.bands ?? [];
  check("鏡・見え方: 切り口が無い（腰の近くほど化身の画素が疎ら: 溶ける範囲の上 > 範囲の上半分 > 腰の近く、腰の近くは上の半分未満）", bands.length === 3 && bands[0] > bands[1] && bands[1] > bands[2] && bands[2] < bands[0] * 0.5, JSON.stringify(bands.map((b) => b.toFixed(3))));
  check("鏡・見え方: 背中から化身の腰まで光の流れがつながって描かれている（曲線上の 7 点すべてに流れの画素）", probe?.stream && probe.stream.hits === probe.stream.total, JSON.stringify(probe?.stream?.samples?.map((q) => `${q.t.toFixed(2)}:${q.hit ? 1 : 0}`)));
  await pML.shot("mirror-look.png");
  await browser.send("Target.closeTarget", { targetId: pML.targetId });
  pages.splice(pages.indexOf(pML), 1);
  // 見失う → 0.5 秒保持 → 0.5 秒で消える → 見つけ直したらすぐ出す
  // 毎フレームの見え方をページの中で記録する（確認側からの問い合わせの遅れは重い環境で数百 ms になり、0.35 秒後に 1 回読むだけだと
  // 保持の間を読めないことがあった）。濃さは「最後に見えてからの時間」だけで決まるので、その時間で分けて確かめる
  const rec = await pM.eval(`window.__keshinMirror.recordAfterRemove(${JSON.stringify(pId)}, 1800)`);
  const inHold = rec.filter((x) => x.sinceSeenMs <= 480);
  const inFade = rec.filter((x) => x.sinceSeenMs >= 520 && x.sinceSeenMs <= 980);
  const afterAll = rec.filter((x) => x.sinceSeenMs >= 1020);
  const gone = await waitUntil(async () => {
    const e = (await mirrorState())?.entries.find((x) => x.id === pId);
    return { ok: e && !e.drawn && e.reason === "lost", e };
  }, 4000, 100);
  check(
    "鏡: 見失っても 0.5 秒は保持し（濃さ 1）、その後フェードで消える（reason=lost）",
    inHold.length > 0 && inHold.every((x) => x.drawn && x.fade === 1) && inFade.every((x) => x.fade < 1 && x.fade > 0) && afterAll.length > 0 && afterAll.every((x) => !x.drawn && x.reason === "lost") && gone?.ok,
    JSON.stringify({ frames: rec.length, hold: inHold.length, holdFade: [...new Set(inHold.map((x) => x.fade))], fade: inFade.map((x) => x.fade.toFixed(2)).filter((_, i) => i % 5 === 0), after: afterAll.length, afterReasons: [...new Set(afterAll.map((x) => x.reason))] }),
  );
  await pM.eval("window.__keshinMirror.setFakePeople([{ head: [0.3, 0.25, -3.0], yawDeg: 0 }])");
  const back = await waitUntil(async () => {
    const e = (await mirrorState())?.entries.find((x) => x.id === pId);
    return { ok: e && e.drawn && e.fade === 1, e };
  }, 3000, 100);
  check("鏡: 見つけ直したらすぐ出す（新しい位置へ即座に・濃さ 1）", back?.ok && Math.abs(back.e.head[0] - 0.3) < 0.05, JSON.stringify(back?.e && { head: back.e.head, fade: back.e.fade }));
  // Pose が止まる（カメラの停止・推論の失敗）: 新しい結果が来なくても、保持 → フェード → 消える（最後の位置に残り続けない）
  await sleep(400);
  await pM.eval("window.__keshinMirror.setPoseStopped(true)");
  await sleep(300);
  const st0 = (await mirrorState())?.entries.find((x) => x.id === pId);
  const stGone = await waitUntil(async () => {
    const st = await mirrorState();
    const e = st?.entries.find((x) => x.id === pId);
    return { ok: e && !e.drawn && e.reason === "lost" && st.poseStalled, e, st };
  }, 4000, 100);
  const stallLog = pM.logs.find((l) => /event=pose-stalled/.test(l)) ?? "";
  const hudStall = await pM.eval("document.querySelector('#hud')?.textContent ?? ''");
  check("鏡: Pose が止まっても化身は保持 → フェードで消える（reason=lost）・HUD とログに Pose が止まったこと", st0?.drawn && stGone?.ok && stallLog !== "" && /pose=STALLED/.test(hudStall) && stGone.st.message.startsWith("人の検出が止まっています"), JSON.stringify({ before: st0 && { drawn: st0.drawn, fade: st0.fade }, after: stGone?.e && { drawn: stGone.e.drawn, reason: stGone.e.reason }, stalled: stGone?.st?.poseStalled, message: stGone?.st?.message, stallLog }));
  await pM.eval("window.__keshinMirror.setPoseStopped(false)");
  const stBack = await waitUntil(async () => {
    const st = await mirrorState();
    const e = st?.entries.find((x) => x.id === pId);
    return { ok: e && e.drawn && !st.poseStalled, e };
  }, 4000, 100);
  check("鏡: Pose が戻ると化身もすぐ出る（ログに pose-resumed）", stBack?.ok && pM.logs.some((l) => /event=pose-resumed/.test(l)), JSON.stringify(stBack?.e && { drawn: stBack.e.drawn }));
  // 2 人 → 1 人（修正 2）: 2 台目のスマホも化身を出し、2 人に割り当ててから手前の人（A）だけ画面から消す。B に化身が 2 体重ならない
  const pP2 = await newWindow("M-phone2", `${BASE}?fov=70&camZoom=1&fakecam=1&autostart=1&occlude=0&room=${ROOMM}&remoteLog=0&name=Q`);
  const sQ = await waitUntil(async () => {
    const st = await phoneState(pP2);
    return { ok: st && st.me, st };
  }, 40000);
  const qId = sQ?.st?.me;
  // P の化身が付いている人を先に A の位置へ（一度付けた人は画像の上の位置で追いかけるので、人が瞬間移動すると「見失った」扱いで
  // 保持の後に付け直す）。そこへ B が入り、Q が化身を出す
  await pM.eval("window.__keshinMirror.setFakePeople([{ head: [-0.7, 0.25, -2.8], yawDeg: 0 }])");
  await waitUntil(async () => {
    const e = (await mirrorState())?.entries.find((x) => x.id === pId);
    return { ok: e && e.drawn && e.head && e.head[0] < -0.5 && e.assign?.reason === "tracked" };
  }, 5000, 100);
  await pM.eval("window.__keshinMirror.setFakePeople([{ head: [-0.7, 0.25, -2.8], yawDeg: 0 }, { head: [0.7, 0.25, -3.6], yawDeg: 0 }])");
  await sleep(300);
  await pP2.eval("document.querySelector('#keshin-button').click()");
  const two = await waitUntil(async () => {
    const st = await mirrorState();
    const a = st?.entries.find((x) => x.id === pId);
    const b = st?.entries.find((x) => x.id === qId);
    return { ok: a?.drawn && b?.drawn && a.personIndex !== null && b.personIndex !== null, a, b };
  }, 15000);
  await sleep(1500);
  const twoSt = await mirrorState();
  const aE = twoSt.entries.find((x) => x.id === pId);
  const bE = twoSt.entries.find((x) => x.id === qId);
  check("鏡: 2 人・化身 2 体（P は付いていた A のまま、後から出した Q は残った B）", two?.ok && aE.head[0] < -0.5 && bE.head[0] > 0.5, JSON.stringify({ a: aE?.head, b: bE?.head }));
  await pM.shot("mirror-4-two.png");
  await pM.eval("window.__keshinMirror.setFakePeople([{ head: [0.7, 0.25, -3.6], yawDeg: 0 }])");
  const samples = [];
  for (let i = 0; i < 12; i++) {
    const st = await mirrorState();
    const drawn = st.entries.filter((x) => x.drawn && x.head);
    const atB = drawn.filter((x) => Math.hypot(x.head[0] - 0.7, x.head[1] - 0.25, x.head[2] + 3.6) <= 0.5);
    // q: Q の化身が B（0.5m 以内）に描かれているか（personIndex は結果の中の順番なので、人数が変わると番号は変わる）
    const qe = st.entries.find((x) => x.id === qId);
    samples.push({ t: i, drawn: drawn.length, atB: atB.length, q: !!(qe?.drawn && qe.head && Math.hypot(qe.head[0] - 0.7, qe.head[1] - 0.25, qe.head[2] + 3.6) <= 0.5) });
    await sleep(120);
  }
  await sleep(600);
  const after = await mirrorState();
  const drawnAfter = after.entries.filter((x) => x.drawn);
  console.log(`mirror 2→1: ${JSON.stringify(samples)} after=${JSON.stringify(drawnAfter.map((x) => ({ id: x.id, head: x.head })))}`);
  check("鏡: 2 人 → 1 人で B の所の化身はいつも 1 体（Q のまま）・消えた A の化身は保持 → フェードで消え、最後は 1 体", samples.every((x) => x.atB === 1 && x.q) && drawnAfter.length === 1 && drawnAfter[0].id === qId, JSON.stringify(samples.map((x) => `${x.drawn}/${x.atB}`)));
  await pP2.eval("document.querySelector('#keshin-button').click()");
  await pM.eval("window.__keshinMirror.setFakePeople([{ head: [0.3, 0.25, -3.0], yawDeg: 0 }])");
  // 化身を消すと消える
  await pP.eval("document.querySelector('#keshin-button').click()");
  const m2 = await waitUntil(async () => {
    const st = await mirrorState();
    const e = st?.entries.find((x) => x.id === pId);
    return { ok: e && !e.drawn && e.reason === "off" && st.message === "ゴーグルの人が化身ボタンを押すと出ます", e, st };
  }, 8000);
  check("鏡: スマホが化身を消すと鏡でも消える（消える演出の後。案内が戻る）", m2?.ok, JSON.stringify(m2?.e && { drawn: m2.e.drawn, reason: m2.e.reason, message: m2.st?.message }));
  const mLogs = pM.logs.filter((l) => /\[keshin-mirror\] event=(camera|person-found|assign|keshin-on|keshin-shown|keshin-hidden|keshin-off)/.test(l));
  console.log(`mirror events: ${mLogs.slice(0, 14).join(" | ")}`);
  check("鏡: 出来事のログ（カメラ・人を見つけた・割り当て・化身の on / off・表示 / 非表示）", ["camera", "person-found", "assign", "keshin-on", "keshin-shown", "keshin-hidden", "keshin-off"].every((k) => mLogs.some((l) => l.includes(`event=${k}`))), mLogs.length + " 件");
  const hudM = await pM.eval("document.querySelector('#hud')?.textContent ?? ''");
  console.log(`mirror HUD:\n${hudM}`);
  // 俯瞰画面のタブを複製して鏡を開いても（sessionStorage が同じ）、俯瞰画面を切らない（修正 4。鍵は keshin-session-mirror で分ける）
  const ROOMD = `${ROOM}d`;
  const pO = await newWindow("dup-overview", `${BASE}overview.html?room=${ROOMD}&remoteLog=0`);
  await waitUntil(async () => ({ ok: /ws=open/.test((await pO.eval("document.querySelector('#status')?.textContent ?? ''")) ?? "") }), 15000);
  const ss = await pO.eval("JSON.stringify(Object.fromEntries(Object.keys(sessionStorage).map((k) => [k, sessionStorage.getItem(k)])))");
  const pD2 = await newWindow("dup-mirror", `https://localhost:${PORT}/`);
  await sleep(800);
  await pD2.eval(`(() => { const s = ${ss}; for (const k of Object.keys(s)) sessionStorage.setItem(k, s[k]); return Object.keys(s); })()`);
  await pD2.send("Page.navigate", { url: `${BASE}mirror.html?room=${ROOMD}&fakecam=1&fakeperson=1&autostart=1&remoteLog=0` });
  const dupM = await waitUntil(async () => {
    const st = await pD2.eval("window.__keshinMirror?.state() ?? null");
    return { ok: st && st.ws === "open" && st.me, st };
  }, 20000);
  await sleep(2500);
  const ovStatus = await pO.eval("document.querySelector('#status')?.textContent ?? ''");
  const dupSt = await pD2.eval("window.__keshinMirror?.state() ?? null");
  const keys = await pD2.eval("Object.keys(sessionStorage).filter((k) => k.startsWith('keshin-session-')).sort().join(',')");
  check("鏡: 俯瞰画面のタブを複製して鏡を開いても、互いに切断しない（鍵は keshin-session-mirror で別）", dupM?.ok && /ws=open/.test(ovStatus) && dupSt?.ws === "open" && keys === "keshin-session-mirror,keshin-session-overview", `overview=${ovStatus.split("\n")[0]} mirror=${dupSt?.ws} keys=${keys} copied=${ss}`);
  check("鏡: HUD にカメラ（facing・画角）・Pose の診断・人（画像の上の頭）・割り当て（付け方と画像の上の距離）が出る", /cam=\d+x\d+ .*facing=fake fov=68\(fake\)/.test(hudM) && /occlude=fake .* poses=1 masks=1 mmax=\S+ mmean=\S+ mfrac=\S+ msrc=fake in=\d+x\d+ lum=\d+ dg=fake/.test(hudM) && /persons=1 #0:d[\d.]+\/yaw-?\d+\(shoulders\)\/floor\S+\/img[\d.]+,[\d.]+/.test(hudM) && /→person\d+\((tracked|new) dImg=\S+ dImg2=\S+ gate=\S+ d3=\S+\)/.test(hudM), (hudM.match(/→person.*?\)/) ?? [""])[0]);
  // ================= 段階 3 の B: カメラで見た人で相手の化身の位置を決める（ハイブリッド）=================
  {
  // A3（スマホ、?fakeperson=1）の前に合成の人を「本当の位置」T に立たせ、仮想のプレイヤー V3 の申告位置 D は 1m 横にずらす。
  // まずユーザーの場面そのもの（V3 は壁を見てから 30 秒 = gyro の ageMs 30000。申告が古い）→ 次に申告が新しい場合 → 2 人が並ぶ場合。
  // 補正の弱まりは既定（?corrDecaySec=10）のまま。方向で結ぶしきい値は、フェイクのマーカーから推定したアンカーの向きの誤差（約 14°）を見込んで ?matchDeg=30
  const ROOM3 = `${ROOM}s3`;
  const T3 = [-0.3, 0, 2.2];
  const D3 = [0.7, 0, 2.2];
  const E3 = [0.3, 0, 3.6];
  const faceTo = (from, to) => {
    const d = [to[0] - from[0], to[2] - from[2]];
    const l = Math.hypot(...d);
    return [d[0] / l, d[1] / l];
  };
  const f3 = faceTo(T3, E3);
  const ov3 = await newWindow("overview-s3", `${BASE}overview.html?room=${ROOM3}&markerMm=600&remoteLog=0`);
  const pA3 = await newWindow("A3", `${BASE}?fov=70&camZoom=1&fakecam=1&autostart=1&markerMm=600&room=${ROOM3}&remoteLog=0&fakeperson=1&fakeCamPos=${E3.join(",")}&name=A3&matchDeg=30`);
  const sA3 = await waitUntil(async () => {
    const st = await phoneState(pA3);
    return { ok: st && st.me && st.track === "marker" && st.model !== "loading" && st.model !== "idle", st };
  }, 40000);
  check("段階 3: A3 が入室してマーカーを見ている（位置の決め方 hybrid・見え方は既定）", sA3?.ok, JSON.stringify(sA3?.st && { track: sA3.st.track }));
  await pA3.eval(`window.__keshin.setFakeBodies([{ head: ${JSON.stringify(T3)}, fwd: ${JSON.stringify(f3)} }])`);
  const virtual = async (name, session) => {
    const q = new URLSearchParams({ room: ROOM3, role: "player", v: String(KESHIN_PROTOCOL_VERSION), markerId: "0", markerMm: "600", name, session });
    const ws = new WebSocket(`wss://localhost:${PORT}${KESHIN_PATH}?${q}`, { rejectUnauthorized: false, headers: { origin: `https://localhost:${PORT}` } });
    const msgs = [];
    ws.on("message", (d) => msgs.push(JSON.parse(d.toString())));
    ws.on("error", () => {});
    await waitUntil(async () => ({ ok: msgs.some((m) => m.type === "welcome") }), 5000);
    const v = { ws, id: msgs.find((m) => m.type === "welcome")?.id, pose: null, timer: null };
    v.timer = setInterval(() => v.pose && ws.send(JSON.stringify({ type: "pose", ...v.pose })), 100);
    return v;
  };
  const v3 = await virtual("V3", "virtualPlayerV3x");
  const v3Id = v3.id;
  // 壁を見てから 30 秒経った相手（申告は古い）
  v3.pose = { pos: D3, quat: [0, 1, 0, 0], fwd: f3, track: "gyro", ageMs: 30000 };
  await waitUntil(async () => {
    const r = (await pA3.eval("window.__keshin.remoteState()")).find((x) => x.id === v3Id);
    return { ok: r && r.warmPending === null };
  }, 20000);
  await sleep(600);
  const prog3a = (await phoneState(pA3)).programs;
  v3.ws.send(JSON.stringify({ type: "keshin", on: true }));
  const st3 = async () => (await pA3.eval("window.__keshin.remoteState()")).find((x) => x.id === v3Id);
  const r3 = await waitUntil(async () => {
    const r = await st3();
    return { ok: r && r.drawn && r.source === "camera", r };
  }, 15000);
  await sleep(1800);
  const prog3b = (await phoneState(pA3)).programs;
  const dist = (a, b) => (a && b ? Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) : NaN);
  // 比べるのは自分のワールド（画面に映っている合成の人の本当の位置 = フェイクカメラから直した点）。マーカー座標系で比べると、
  // フェイクのマーカーから推定したアンカーの向きの誤差（この配置で約 14°）が入るため
  const Tw = await pA3.eval(`window.__keshin.fakeTrueWorld(${JSON.stringify(T3)})`);
  const eye3 = await pA3.eval("window.__keshin.eyeWorld()");
  const angTo = (p, q) => {
    const a = [p[0] - eye3[0], p[1] - eye3[1], p[2] - eye3[2]];
    const b = [q[0] - eye3[0], q[1] - eye3[1], q[2] - eye3[2]];
    const c = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (Math.hypot(...a) * Math.hypot(...b));
    return (Math.acos(Math.min(1, Math.max(-1, c))) * 180) / Math.PI;
  };
  const h0 = await st3();
  console.log(`stage3 stale-visible: ${JSON.stringify(h0 && { source: h0.source, match: h0.matchReason, head: h0.head, Tw, camDist: h0.camDist, declDist: h0.declDist, dirDeg: h0.dirDeg, track: h0.track, ageMs: h0.ageMs })}`);
  const firstMatch = pA3.logs.find((l) => /event=remote-match/.test(l) && l.includes(`${v3Id}:`) && !l.includes(`${v3Id}:-`)) ?? "";
  check("段階 3・申告が古い相手（壁を見てから 30 秒）: カメラで見た人に結び（最初は only-one、以後は tracked）、本当の位置に出る（自分のワールドで T から 5cm 以内・src=camera）", r3?.ok && /only-one/.test(firstMatch) && (h0.matchReason === "only-one" || h0.matchReason === "tracked") && dist(h0.head, Tw) < 0.05, `T=${dist(h0?.head, Tw).toFixed(3)} src=${h0?.source} match=${h0?.matchReason} first=${firstMatch}`);
  check("段階 3: 化身が初めて出たときに新しくリンクされたプログラムは 0 本（光の流れ・溶ける下端を含む）", prog3a === prog3b, `programs ${prog3a}→${prog3b}`);
  await pA3.shot("stage3-hybrid.png");
  // 画面から外れる（合成の人を消す）→ 補正付きで残る → 薄くなる → 最後に見えてから staleHideMs（8s）+ フェードで消える（補正の弱まりは既定 10s）
  const hVis = await st3();
  await pA3.eval("window.__keshin.setFakeBodies([])");
  await sleep(1000);
  const q1 = await st3();
  const q1Anchor = q1?.corrState;
  await sleep(4000);
  const q5 = await st3();
  await sleep(4800);
  const q10 = await st3();
  console.log(`stage3 stale-hidden: +1s ${JSON.stringify(q1 && { src: q1.source, drawn: q1.drawn, fade: q1.fade })} +5s ${JSON.stringify(q5 && { src: q5.source, drawn: q5.drawn, fade: q5.fade })} +9.8s ${JSON.stringify(q10 && { drawn: q10.drawn, reason: q10.reason })}`);
  // 補正は最後に見えてから 10 秒で 0 へ線形に弱まる（1m の補正なら 10cm/秒）。重い環境では「1 秒後」の読み取りが遅れるので、固定の 15cm ではなく
  // 読んだ時点の弱まり k で確かめる: 位置 ≒ 申告 + 補正 × k（マーカー座標系で 6cm 以内。表示のなめらかさの遅れ込み）、見えていた位置からは 6cm + 補正 × (1 − k) 以内
  const cs = q1Anchor;
  const expM = cs ? [D3[0] + cs.raw[0] * cs.k, D3[1] + cs.raw[1] * cs.k, D3[2] + cs.raw[2] * cs.k] : null;
  const rawLen = cs ? Math.hypot(...cs.raw) : NaN;
  const allowVis = 0.06 + rawLen * (1 - (cs?.k ?? 0));
  const declJump = dist(hVis?.headMarker, D3);
  check(
    "段階 3・申告が古い相手が見えなくなって約 1 秒: 消えずに補正付きで見えていた位置の近くに残る（位置 = 申告 + 補正 × 弱まり ±6cm・見えていた位置から 6cm + 弱まった分以内・src=declared+corr）",
    q1 && q1.drawn && q1.source === "declared+corr" && cs && cs.sinceSeenMs > 500 && dist(q1.headMarker, expM) < 0.06 && dist(q1.head, hVis.head) < allowVis && declJump > 0.5,
    `d=${dist(q1?.head, hVis?.head).toFixed(3)} 許容=${allowVis.toFixed(3)} 式との差=${dist(q1?.headMarker, expM).toFixed(3)} k=${cs?.k?.toFixed(3)} since=${cs?.sinceSeenMs?.toFixed(0)}ms 補正=${rawLen.toFixed(2)}m src=${q1?.source}`,
  );
  check("段階 3・5 秒: まだ出ていて薄くなっている（最後に見えてから数える）", q5 && q5.drawn && q5.fade < 0.7 && q5.fade > 0.3, `fade=${q5?.fade?.toFixed(2)}`);
  check("段階 3・9.8 秒: 最後に見えてから staleHideMs + フェードで消える（申告が古いので）", q10 && !q10.drawn, JSON.stringify(q10 && { drawn: q10.drawn, reason: q10.reason }));
  // 見つけ直したら、また本当の位置に出る
  await pA3.eval(`window.__keshin.setFakeBodies([{ head: ${JSON.stringify(T3)}, fwd: ${JSON.stringify(f3)} }])`);
  const back3 = await waitUntil(async () => {
    const r = await st3();
    return { ok: r && r.drawn && dist(r.head, Tw) < 0.05, r };
  }, 5000);
  check("段階 3・見つけ直したら、また本当の位置に出る", back3?.ok, JSON.stringify(back3?.r && { head: back3.r.head, src: back3.r.source, match: back3.r.matchReason }));
  // 化身を出していない人（体の向きが V3 の申告と 90° 違う）だけが同じ所に映る: 見失ってから（続けて追いかけていない）なので関門が掛かり、結ばない（why=facing）
  await pA3.eval("window.__keshin.setFakeBodies([])");
  await sleep(500);
  const fSide = [f3[1], -f3[0]];
  await pA3.eval(`window.__keshin.setFakeBodies([{ head: ${JSON.stringify(T3)}, fwd: ${JSON.stringify(fSide)} }])`);
  const rej = await waitUntil(async () => {
    const r = await st3();
    const det = await pA3.eval("window.__keshin.detections().length");
    return { ok: r && det === 1 && r.matchReason === "-" && r.matchInfo?.reject === "facing", r, det };
  }, 5000, 100);
  await sleep(400);
  const rejStill = await st3();
  const hudRej = await pA3.eval("document.querySelector('#hud')?.textContent ?? ''");
  const rejLog = pA3.logs.find((l) => /event=remote-match/.test(l) && l.includes(`${v3Id}:-(facing)`)) ?? "";
  check(
    "段階 3・体の向きが 90° 違う人だけが映る: 結ばない（why=facing）・化身はその人に付かない・HUD とログに理由と向きの差（fDeg）",
    rej?.ok && rejStill.matchReason === "-" && !(rejStill.drawn && rejStill.source === "camera") && /match=- why=facing fDeg=\d+/.test(hudRej) && /-\(facing\) persons=1 \S+\[fDeg=\d+ corrM=\S+\]/.test(rejLog),
    JSON.stringify({ reject: rej?.r?.matchInfo, det: rej?.det, drawn: rejStill?.drawn, src: rejStill?.source, hud: (hudRej.match(/match=\S+ why=\S+ fDeg=\S+ corrM=\S+/) ?? [""])[0], log: rejLog.slice(0, 160) }),
  );
  // 本人（向きが合う）に戻すと、また結ぶ
  await pA3.eval(`window.__keshin.setFakeBodies([{ head: ${JSON.stringify(T3)}, fwd: ${JSON.stringify(f3)} }])`);
  const reb = await waitUntil(async () => {
    const r = await st3();
    return { ok: r && r.drawn && r.matchReason !== "-" && dist(r.head, Tw) < 0.05, r };
  }, 5000);
  check("段階 3・向きの合う本人に戻すと、また結ぶ（本当の位置に出る）", reb?.ok, JSON.stringify(reb?.r && { match: reb.r.matchReason, why: reb.r.matchInfo?.reject }));
  // 申告が新しい場合（V3 がマーカーを見ている。申告は 0.3m ずれ）: 方向はカメラ、距離は申告 0.7 + カメラ 0.3
  const D3b = [T3[0] + 0.3, 0, T3[2]];
  v3.pose = { pos: D3b, quat: [0, 1, 0, 0], fwd: f3, track: "marker", ageMs: 0 };
  await sleep(1800);
  const h1 = await st3();
  const blendD = h1 ? 0.7 * h1.declDist + 0.3 * h1.camDist : NaN;
  console.log(`stage3 fresh: ${JSON.stringify(h1 && { source: h1.source, match: h1.matchReason, head: h1.head, camDist: h1.camDist, declDist: h1.declDist, dirDeg: h1.dirDeg })}`);
  check("段階 3・申告が新しい相手: 方向はカメラで見た人（本当の位置との方向の差 < 1.5°）・距離は申告 0.7 + カメラ 0.3 の混ぜた値 ±5cm（src=hybrid）", h1 && h1.source === "hybrid" && angTo(h1.head, Tw) < 1.5 && Math.abs(dist(h1.head, eye3) - blendD) < 0.05, `方向の差=${angTo(h1?.head, Tw).toFixed(2)}° 距離=${dist(h1?.head, eye3).toFixed(3)} 混ぜた値=${blendD.toFixed(3)} match=${h1?.matchReason}`);
  const hudA3 = await pA3.eval("document.querySelector('#hud')?.textContent ?? ''");
  check("段階 3: HUD に相手ごとの出どころ・カメラの推定距離・申告距離・補正・方向のずれ・結び方・結ばなかった理由・体の向きの差・補正からの距離", /src=hybrid camD=[\d.]+ decD=[\d.]+ corr=[\d.]+m×[\d.]+ n=\d+ dAng=\d+deg match=(declared-dir|tracked|only-one) why=- fDeg=\d+ corrM=\S+/.test(hudA3), (hudA3.match(/src=.*/) ?? [""])[0]);
  await pA3.eval("window.__keshin.setPosMode('camera')");
  await sleep(1500);
  const h2 = await st3();
  check("段階 3・camera: カメラだけなら本当の位置に出る（自分のワールドで T から 5cm 以内）", h2 && h2.drawn && h2.source === "camera" && dist(h2.head, Tw) < 0.05, `T=${dist(h2?.head, Tw).toFixed(3)} src=${h2?.source}`);
  await pA3.eval("window.__keshin.setPosMode('declared')");
  await sleep(1500);
  const h3 = await st3();
  check("段階 3・declared: 段階 2 と同じく申告位置の方に出る（D から 5cm 以内）", h3 && h3.drawn && h3.source === "declared" && dist(h3.headMarker, D3b) < 0.05, `D=${dist(h3?.headMarker, D3b).toFixed(3)}`);
  await pA3.shot("stage3-declared.png");
  await pA3.eval("window.__keshin.setPosMode('hybrid')");
  await sleep(1500);
  // 申告が新しい相手は、見えなくなっても消えない（補正付き → 申告位置へ）
  await pA3.eval("window.__keshin.setFakeBodies([])");
  await sleep(1200);
  const hf = await st3();
  check("段階 3・申告が新しい相手は見えなくなっても出続ける（src=declared+corr・薄さ 1）", hf && hf.drawn && hf.source === "declared+corr" && hf.fade === 1, JSON.stringify(hf && { drawn: hf.drawn, src: hf.source, fade: hf.fade }));
  // 本当の位置の人の形で化身が隠れる（hybrid の位置 = 人の背後、持ち主の頭 = hybrid の頭）。人の形で隠す仕組みの確認なので見え方は段階 2（化身が人に重なる配置）
  // 1.5m だと化身の翼・腕が人より手前に来て隠さない（正しい）ので、2m ほど離れた位置で確かめる
  const T5 = [-0.5, 0, 1.8];
  const f5 = faceTo(T5, E3);
  v3.pose = { pos: [T5[0] + 0.2, 0, T5[2]], quat: [0, 1, 0, 0], fwd: f5, track: "marker", ageMs: 0 };
  await pA3.eval(`window.__keshin.setFakeBodies([{ head: ${JSON.stringify(T5)}, fwd: ${JSON.stringify(f5)} }])`);
  await pA3.eval("window.__keshin.setRemoteLook(false)");
  // 人を視野の中央に（段階 2 の向き合った確認と同じく左へ見回す。画面の端では化身の腕・翼が人より手前に来る部分が多い）
  await pA3.eval("window.__keshin.setLook(0, 22)");
  const rlook = await waitUntil(async () => {
    const r = await st3();
    return { ok: r && r.drawn && r.warmPending === null && (r.source === "hybrid" || r.source === "camera"), r };
  }, 10000);
  await sleep(1500);
  const mOn = await pA3.eval(`window.__keshin.pixelDiffRemote(${JSON.stringify(v3Id)}, true, "model")`);
  const mOff = await pA3.eval(`window.__keshin.pixelDiffRemote(${JSON.stringify(v3Id)}, false, "model")`);
  // 前後の判定を外した（余裕 5m = 持ち主の頭の 5m 手前より奥は全部 = 人の形の上は全部隠す）ときの残り: 人の形と化身の位置が合っていれば 0 に近い。
  // 通常の余裕（0.15m）で残る分は、化身のうち持ち主の頭より手前に来る部分（翼・腕・髪。アンカーの向きの誤差で化身が少し回っている）
  await pA3.eval("window.__keshin.setMaskDepthMargin(5)");
  const mAll = await pA3.eval(`window.__keshin.pixelDiffRemote(${JSON.stringify(v3Id)}, true, "model")`);
  await pA3.eval("window.__keshin.setMaskDepthMargin(0.15)");
  console.log(`stage3 mask: on=${mOn?.inside}/${mOn?.outside} all=${mAll?.inside}/${mAll?.outside} off=${mOff?.inside}/${mOff?.outside}`);
  check("段階 3・hybrid: 本当の位置にいる人の形と化身の位置が合う（前後の判定を外すと人の上の化身は隠れる: 隠さないときの 5% 未満）・人のいない所は残る", rlook?.ok && mOff && mOff.inside > 300 && mAll.inside < mOff.inside * 0.05 && mAll.outside >= mOff.outside * 0.85, `all=${mAll?.inside}/${mAll?.outside} off=${mOff?.inside}/${mOff?.outside}`);
  check("段階 3・hybrid: 通常の前後の判定（持ち主の頭より奥だけ隠す）でも、人の上の化身の大半が隠れる（隠さないときの 30% 未満。残りは頭より手前の部分）", mOn && mOn.inside < mOff.inside * 0.3, `on=${mOn?.inside} off=${mOff?.inside}`);
  await pA3.shot("stage3-hybrid-mask.png");
  await pA3.eval("window.__keshin.setLook(0, 0)");
  await pA3.eval("window.__keshin.setRemoteLook(true)");
  v3.pose = { pos: D3b, quat: [0, 1, 0, 0], fwd: f3, track: "marker", ageMs: 0 };
  await pA3.eval(`window.__keshin.setFakeBodies([{ head: ${JSON.stringify(T3)}, fwd: ${JSON.stringify(f3)} }])`);
  // ビューを作り直したので、V3 を T の人に結び直してから V4 を入れる（相手 1 人・検出 1 人 → 以後は前回の位置で追う）
  await waitUntil(async () => {
    const r = await st3();
    return { ok: r && r.drawn && r.source === "hybrid" && angTo(r.head, Tw) < 1.5 };
  }, 10000);
  await sleep(500);
  // 2 人が並ぶ: V4（本当の位置 T4・申告は新しく 0.1m ずれ）と V3（申告は新しく 0.3m ずれ）。1 対 1 で、それぞれ自分の体の方向に出る
  const T4 = [0.6, 0, 2.0];
  const f4 = faceTo(T4, E3);
  const v4 = await virtual("V4", "virtualPlayerV4x");
  v4.pose = { pos: [T4[0] + 0.1, 0, T4[2]], quat: [0, 1, 0, 0], fwd: f4, track: "marker", ageMs: 0 };
  await pA3.eval(`window.__keshin.setFakeBodies([{ head: ${JSON.stringify(T3)}, fwd: ${JSON.stringify(f3)} }, { head: ${JSON.stringify(T4)}, fwd: ${JSON.stringify(f4)} }])`);
  v4.ws.send(JSON.stringify({ type: "keshin", on: true }));
  const T4w = await pA3.eval(`window.__keshin.fakeTrueWorld(${JSON.stringify(T4)})`);
  const two = await waitUntil(async () => {
    const list = await pA3.eval("window.__keshin.remoteState()");
    const a = list.find((x) => x.id === v3Id);
    const b = list.find((x) => x.id === v4.id);
    return { ok: a?.drawn && b?.drawn && a.source === "hybrid" && b.source === "hybrid" && angTo(a.head, Tw) < 1.5 && angTo(b.head, T4w) < 1.5, a, b };
  }, 12000);
  console.log(`stage3 two: ${JSON.stringify(two && { a: two.a && { match: two.a.matchReason, ang: angTo(two.a.head, Tw).toFixed(2) }, b: two.b && { match: two.b.matchReason, ang: angTo(two.b.head, T4w).toFixed(2) } })}`);
  check("段階 3・2 人が並ぶ: それぞれ自分の体の方向に 1 対 1 で出る（方向の差 < 1.5°）", two?.ok, JSON.stringify(two && { a: two.a && { match: two.a.matchReason, src: two.a.source }, b: two.b && { match: two.b.matchReason, src: two.b.source } }));
  await pA3.shot("stage3-two.png");
  // 結ばなかったときの理由は上の「体の向きが 90° 違う人」の確認で見ている（最初の pose が届く前の no-facing は届く順番次第なので確かめない）
  const matchLog = pA3.logs.find((l) => /event=remote-match/.test(l) && new RegExp(`${v3Id}:(only-one|declared-dir|tracked) `).test(l)) ?? "";
  check("段階 3: 結び方と判断に使った値（fDeg / corrM）がログに出る（event=remote-match）", /persons=\d+ \S+\[fDeg=\S+ corrM=\S+\]/.test(matchLog), matchLog);
  await ov3.eval("window.__keshinOverview.setView([3.6, 2.6, 5.4], [0.2, -0.3, 1.8])");
  await sleep(400);
  await ov3.shot("stage3-overview.png");
  for (const v of [v3, v4]) {
    clearInterval(v.timer);
    v.ws.close();
  }

  }
  const ex2 = pages.flatMap((p) => p.exceptions.map((e) => `${p.name}: ${e}`));
  check("段階 2: 例外が出ていない", ex2.length === 0, ex2.slice(0, 3).join(" | "));
  const shader2 = pages.flatMap((p) => p.logs.filter((l) => /Shader Error|WebGLProgram|THREE\.WebGLRenderer/.test(l)).map((l) => `${p.name}: ${l.slice(0, 200)}`));
  check("段階 2: シェーダーのエラーが出ていない", shader2.length === 0, shader2.slice(0, 2).join(" | "));
  vws.close();

  const failed = results.filter(([, ok]) => !ok);
  console.log(failed.length === 0 ? "\nALL PASS" : `\n${failed.length} FAILED`);
  exitCode = failed.length === 0 ? 0 : 1;
} catch (e) {
  console.error("確認の実行エラー:", e.message ?? e);
  for (const p of pages) for (const ex of p.exceptions.slice(0, 3)) console.error(`  ${p.name} exception: ${ex}`);
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
