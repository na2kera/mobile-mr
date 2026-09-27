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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 5222;
const CDP_PORT = 9361;
const BASE = `https://localhost:${PORT}/demos/ex9-1-keshin/`;
const ROOM = `check${Date.now() % 100000}`;
const PHONE = `fov=70&camZoom=1&fakecam=1&autostart=1&fakeMarkerPx=80&room=${ROOM}`;
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
    return { ok: !!me, me };
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
