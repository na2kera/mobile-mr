// demos/08-7-splatoon-alva（08 + AlvaAR の単眼 SLAM）のブラウザ経路をヘッドレス Chrome で確認する。
// `npm run check:splatoon-alva` で実行する。仕組みは headless-splatoon.mjs と同じ（CDP を ws で直接叩く。Chrome が無ければスキップ）。
// 実カメラが無いので SLAM の追跡そのものは PC で確かめられない。代わりに:
//   - ウィンドウ A（?fakeslam=1）: 合成カメラの姿勢に既知の別原点・スケール・回転を掛けてノイズを足した「AlvaAR 形式の姿勢」を注入する。
//     マーカーが見えている間に合成カメラを動かして変換を推定させ（スケールが 1/fakeSlamScale に近い・off= が小さい）、
//     原点マーカーを隠してから合成カメラを動かすと、field 上の自分の位置（self=）が合成カメラに追従する
//   - ウィンドウ B（?slam=0。08 と同じ）: 同じ動きで、マーカーを隠している間は位置が止まる（holding last pose）
//   - ウィンドウ A の例外の経路: window.__fakeSlam.throw で例外を出し続けると、slamMaxFail 回で SLAM が止まり（slam=failed）、
//     マーカーのみに落ちて描画も発射も続く
//   - ウィンドウ C（実 AlvaAR。public/vendor/alva/ が要る）: チェッカーボードのフェイクカメラ映像で、初期化が通り findCameraPose が呼べる
//     （姿勢は null でもよい）。未取得（npm run fetch:alva していない）なら FAIL にする
//   - ウィンドウ D（alva_ar.js の読み込みを CDP でブロック）: HUD に読み込み失敗が出て、マーカーのみで入室・発射できる
//   - 俯瞰画面（overview.html）が開けて全員が見えている / 例外が出ていない
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
// 別の worktree で同時に走らせるときは PORT / CDP_PORT で変える
const PORT = Number(process.env.PORT ?? "") || 5207;
const CDP_PORT = Number(process.env.CDP_PORT ?? "") || 9347;
const BASE = `https://localhost:${PORT}/demos/08-7-splatoon-alva/`;
// markerMm=100 / fakeMarkerPx=80: 08 の確認と同じ幾何（合成カメラは原点マーカーの正面 0.74m）
const MARKER_MM = 100;
const ROOM = "check-alva";
const COMMON = `fov=70&camZoom=1&fakecam=1&autostart=1&fakehands=1&fakeMarkerPx=80&handSmooth=1&room=${ROOM}&waitSec=1&markerMm=${MARKER_MM}`;
const FAKE_SLAM_SCALE = 0.37;
const START_POS = [0, 0, 0.74];

if (!existsSync(CHROME)) {
  console.log(`SKIP: Chrome が見つかりません (${CHROME})。CHROME=/path/to/chrome で指定できます`);
  process.exit(0);
}
if (!existsSync(new URL("../public/vendor/alva/alva_ar.js", import.meta.url))) {
  console.log("FAIL: public/vendor/alva/alva_ar.js が無い（npm run fetch:alva を先に実行）");
  process.exit(1);
}

const results = [];
function check(name, cond, detail = "") {
  results.push([name, cond]);
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${detail ? ` (${detail})` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dist = (a, b) => (a && b ? Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) : Infinity);

const server = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], { stdio: ["ignore", "pipe", "pipe"] });
server.stderr.on("data", (d) => process.stderr.write(d));
const serverLines = [];
server.stdout.on("data", (d) => {
  for (const line of d.toString().split("\n")) if (line.startsWith("[splatoon]")) serverLines.push(line);
});
let serverExited = false;
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

async function openPage(target, name) {
  const page = new Page(target.webSocketDebuggerUrl, name);
  await page.ready();
  await page.send("Runtime.enable");
  await page.send("Page.enable");
  return page;
}

/** HUD を読む（08 の行 + 08-7 の slam= 行） */
function parseHud(hud) {
  const g = hud.match(/game: phase=(\S+) left=(\S+) color=(\S+) players=(\S*) scores=(\S*) total=(\d+) shots=(\d+)\/(\d+)/);
  const scores = {};
  for (const m of (g?.[5] ?? "").matchAll(/(p\d+):(\d+)/g)) scores[m[1]] = Number(m[2]);
  const self = hud.match(/self=\(([^)]*)\)/)?.[1].split(",").map(Number);
  const slamLine = hud.match(/^slam=.*$/m)?.[0] ?? "";
  return {
    raw: hud,
    me: hud.match(/\bme=(\S+)/)?.[1] ?? "-",
    marker: hud.match(/marker=(\S+)/)?.[1] ?? "",
    markerLine: hud.match(/^marker=.*$/m)?.[0] ?? "",
    self: self && self.length === 3 && self.every(Number.isFinite) ? self : null,
    slamLine,
    slamState: slamLine.match(/^slam=(\S+?)(?:\s|$)/)?.[1] ?? "",
    slamMs: Number(slamLine.match(/ t=([\d.]+)ms/)?.[1] ?? NaN),
    slamOff: Number(slamLine.match(/ off=([\d.]+)m/)?.[1] ?? NaN),
    slamScale: Number(slamLine.match(/ fix=s=([\d.]+)/)?.[1] ?? NaN),
    slamCalls: Number(slamLine.match(/ n=(\d+) resets=/)?.[1] ?? -1),
    slamFocal: Number(slamLine.match(/ f=(\d+)px/)?.[1] ?? NaN),
    rotErr: Number(slamLine.match(/ rotErr=([\d.]+)deg/)?.[1] ?? NaN),
    phase: g?.[1] ?? "",
    players: (g?.[4] ?? "").split(",").filter(Boolean),
    scores,
    sent: g ? Number(g[7]) : -1,
    accepted: g ? Number(g[8]) : -1,
  };
}

const profile = mkdtempSync(join(tmpdir(), "mobile-mr-chrome-"));
let chrome = null;
let exitCode = 1;
try {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  if (!(await waitForServer())) throw new Error(`dev サーバーが起動しなかった（ポート ${PORT} が使用中でないか確認）`);
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
  const pA = await openPage(targets.find((t) => t.type === "page"), "A");
  const version = await cdpJson("/json/version");
  const browser = new Page(version.webSocketDebuggerUrl, "browser");
  await browser.ready();
  async function newWindow(name) {
    const created = await browser.send("Target.createTarget", { url: "about:blank", newWindow: true });
    const t = (await cdpJson("/json")).find((x) => x.id === created.result.targetId);
    return openPage(t, name);
  }
  await pA.send("Page.navigate", { url: `${BASE}?${COMMON}&name=Alva&fakeslam=1&slamMinBaseline=0.06` });
  const pB = await newWindow("B");
  await pB.send("Page.navigate", { url: `${BASE}?${COMMON}&name=NoSlam&slam=0` });
  const pC = await newWindow("C");
  await pC.send("Page.navigate", { url: `${BASE}?${COMMON}&name=Real` });
  const pD = await newWindow("D");
  await pD.send("Network.enable");
  await pD.send("Network.setBlockedURLs", { urls: ["*alva_ar.js*"] });
  await pD.send("Page.navigate", { url: `${BASE}?${COMMON}&name=Blocked` });
  const pO = await newWindow("O");
  await pO.send("Page.navigate", { url: `${BASE}overview.html?room=${ROOM}&waitSec=1&markerMm=${MARKER_MM}` });
  const pages = [pA, pB, pC, pD, pO];

  const readHud = async (p) => parseHud((await p.eval("document.querySelector('#hud')?.textContent")) ?? "");
  const setCam = (p, pos) => p.eval(`window.__fakeMarkers.camPos = ${JSON.stringify(pos)}; true`);
  const show = (h) => `me=${h.me} ${h.markerLine} | ${h.slamLine} | shots=${h.sent}/${h.accepted}`;

  // 全員の入室とマーカーの検出を待つ
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    const hs = await Promise.all([pA, pB, pC, pD].map(readHud));
    if (hs.every((h) => h.me.startsWith("p") && h.marker.startsWith("id="))) break;
    await sleep(500);
  }
  console.log(`4 ウィンドウの入室 + マーカー検出まで ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  await sleep(6000);

  // ---- 練習（08 と同じく塗れる）----
  const [a0, b0] = await Promise.all([readHud(pA), readHud(pB)]);
  console.log(`A: ${show(a0)}`);
  console.log(`B: ${show(b0)}`);
  check("A・B でマーカーが検出されている", a0.marker.startsWith("id=") && b0.marker.startsWith("id="));
  check("A・B が練習で連射が受理され得点している（08 と同じ仕様）", a0.phase === "practice" && a0.accepted >= 2 && b0.accepted >= 2 && (a0.scores[a0.me] ?? 0) > 0 && (b0.scores[b0.me] ?? 0) > 0, `${a0.accepted}/${b0.accepted} ${JSON.stringify(a0.scores)}`);
  check("A: フェイクの SLAM が追跡中", a0.slamState.startsWith("tracking"), a0.slamLine);
  check("B（?slam=0）: SLAM は off", b0.slamState === "off(?slam=0)", b0.slamLine);

  // ---- マーカーを見ながら動いて変換を推定させる ----
  // マーカーの視軸からの角度は 5° 前後に抑える（それ以上横にずれると単一マーカーの POSIT が鏡像のヨーを拾い、
  // マーカー側の姿勢が 30° 回って組が壊れる。08 の既知の弱点（issue #54 / #55）で、この確認の対象ではない）。
  // 距離は 0.5〜0.8m（フェイクカメラの 100mm マーカーは 0.9m 以上で小さすぎて検出されない）。基線が短いので A は slamMinBaseline=0.06
  const calib = [[0, 0, 0.5], [0, 0.04, 0.8], [0.04, -0.03, 0.55], [-0.04, 0.03, 0.8], [0, -0.04, 0.6], [0.03, 0.03, 0.5], [0, 0, 0.74]];
  // 各位置で 3 秒止まる（アンカーは lerp で追いつくまで 0.5 秒ほど補正量 Δ が大きく、その間は組にしない。slamPairMaxCorr）
  for (const pos of calib) {
    await Promise.all([setCam(pA, pos), setCam(pB, pos)]);
    await sleep(3000);
    if (process.env.DEBUG_PAIRS) console.log(`calib ${JSON.stringify(pos)}: ${show(await readHud(pA))}`);
  }
  await sleep(1000);
  const [a1, b1] = await Promise.all([readHud(pA), readHud(pB)]);
  if (process.env.DEBUG_PAIRS) console.log(await pA.eval("JSON.stringify(window.__slamFusion.pairs.map((p) => [p.field.pos.map((v) => +v.toFixed(3)), p.slam.pos.map((v) => +v.toFixed(3))]))"));
  console.log(`calibrated A: ${show(a1)} self=${JSON.stringify(a1.self)}`);
  const scaleErr = Math.abs(a1.slamScale * FAKE_SLAM_SCALE - 1);
  check("A: マーカーを見ながら動くと SLAM → field の変換が推定される（スケールが 1/fakeSlamScale の ±15%）", Number.isFinite(a1.slamScale) && scaleErr < 0.15, `s=${a1.slamScale} 正解=${(1 / FAKE_SLAM_SCALE).toFixed(2)} 誤差=${(scaleErr * 100).toFixed(1)}%`);
  check("A: マーカーが見えている間の off=（マーカーの位置と SLAM を写した位置の差）が 5cm 未満", a1.slamOff < 0.05, `off=${a1.slamOff}`);
  check("A: SLAM の向きを写したものとジャイロ（合成カメラ）の向きの差 rotErr が 5° 未満", a1.rotErr < 5, `rotErr=${a1.rotErr}`);
  check("A: 原点に戻ると self= が合成カメラの位置（±5cm）", dist(a1.self, START_POS) < 0.05, JSON.stringify(a1.self));
  const bSelfBefore = b1.self;

  // ---- 原点マーカーを隠して歩く ----
  await Promise.all([pA.eval("window.__fakeMarkers.hidden.add(0); true"), pB.eval("window.__fakeMarkers.hidden.add(0); true")]);
  await sleep(1000);
  const acceptedBeforeWalk = (await readHud(pA)).accepted;
  const walk = [[0.4, 0.1, 1.2], [-0.3, -0.1, 1.6]];
  for (const [i, pos] of walk.entries()) {
    await Promise.all([setCam(pA, pos), setCam(pB, pos)]);
    await sleep(2000);
    const [a, b] = await Promise.all([readHud(pA), readHud(pB)]);
    console.log(`walk${i + 1} A: ${show(a)} self=${JSON.stringify(a.self)} 正解=${JSON.stringify(pos)}`);
    console.log(`walk${i + 1} B: ${show(b)} self=${JSON.stringify(b.self)}`);
    check(`歩行 ${i + 1}: A はマーカーが見えない間 SLAM で動いている（marker 行が (slam)、slam=tracking+drive）`, /\(slam\)/.test(a.markerLine) && a.slamState === "tracking+drive", `${a.markerLine} | ${a.slamLine}`);
    check(`歩行 ${i + 1}: A の field 上の自分の位置 self= が合成カメラに追従する（±10cm）`, dist(a.self, pos) < 0.1, `self=${JSON.stringify(a.self)} 正解=${JSON.stringify(pos)} 差=${dist(a.self, pos).toFixed(3)}m`);
    check(`歩行 ${i + 1}: B（08 と同じ）はロスト中に位置が止まる（holding last pose、self が動かない）`, /holding last pose/.test(b.markerLine) && dist(b.self, bSelfBefore) < 0.02, `self=${JSON.stringify(b.self)} before=${JSON.stringify(bSelfBefore)}`);
  }
  const aWalk = await readHud(pA);
  check("A: SLAM で動いている間も連射が受理され続ける", aWalk.accepted > acceptedBeforeWalk, `${acceptedBeforeWalk} → ${aWalk.accepted}`);

  // ---- マーカーを戻す → マーカーの追跡に戻る ----
  await Promise.all([setCam(pA, START_POS), setCam(pB, START_POS)]);
  await Promise.all([pA.eval("window.__fakeMarkers.hidden.delete(0); true"), pB.eval("window.__fakeMarkers.hidden.delete(0); true")]);
  await sleep(2500);
  const a2 = await readHud(pA);
  console.log(`back A: ${show(a2)} self=${JSON.stringify(a2.self)}`);
  check("A: マーカーが見えるとマーカーの追跡に戻る（drive が外れ、self が原点の正面 ±5cm）", a2.marker.startsWith("id=") && !/\(slam\)/.test(a2.markerLine) && a2.slamState === "tracking" && dist(a2.self, START_POS) < 0.05, `${a2.markerLine} | ${a2.slamLine}`);

  // ---- 例外が続いたら SLAM を止めてマーカーのみに落ちる ----
  await pA.eval("window.__fakeSlam.throw = true; true");
  const tf = Date.now();
  let aFail = await readHud(pA);
  while (Date.now() - tf < 15000 && !aFail.slamState.startsWith("failed")) {
    await sleep(500);
    aFail = await readHud(pA);
  }
  console.log(`failed A: ${show(aFail)} (${((Date.now() - tf) / 1000).toFixed(1)}s)`);
  check("A: 例外が slamMaxFail（30）回続くと SLAM を止める（slam=failed、理由付き）", aFail.slamState.startsWith("failed") && /30 回続いた/.test(aFail.slamLine), aFail.slamLine);
  await pA.eval("window.__fakeMarkers.hidden.add(0); true");
  await setCam(pA, [0.4, 0, 1.2]);
  await sleep(2000);
  const a3 = await readHud(pA);
  console.log(`failed+hidden A: ${show(a3)} self=${JSON.stringify(a3.self)}`);
  check("A: SLAM を止めた後は 08 と同じマーカーのみ（隠すと holding last pose で位置が止まる）", /holding last pose/.test(a3.markerLine) && dist(a3.self, START_POS) < 0.05, `${a3.markerLine} self=${JSON.stringify(a3.self)}`);
  check("A: SLAM を止めた後も描画ループと発射が続く", a3.accepted > aFail.accepted, `${aFail.accepted} → ${a3.accepted}`);

  // ---- 実 AlvaAR（チェッカーボードの映像）----
  const tc = Date.now();
  let c = await readHud(pC);
  while (Date.now() - tc < 30000 && !(c.slamCalls > 5)) {
    await sleep(500);
    c = await readHud(pC);
  }
  console.log(`real AlvaAR C: ${show(c)}`);
  for (const l of pC.logs.filter((l) => l.startsWith("[slam]")).slice(0, 3)) console.log(`C log: ${l}`);
  check("C: 実 AlvaAR の読み込みと初期化が通る（console に AlvaAR initialized、失敗していない）", pC.logs.some((l) => /\[slam\] AlvaAR initialized/.test(l)) && !c.slamState.startsWith("failed") && c.slamState !== "loading", c.slamLine);
  check("C: findCameraPose が呼べている（n= が増え、処理時間 t= が出る。姿勢は null でもよい）", c.slamCalls > 5 && Number.isFinite(c.slamMs), `n=${c.slamCalls} t=${c.slamMs}ms state=${c.slamState}`);
  const expectedF = 360 / 2 / Math.tan((68 * Math.PI) / 360);
  check("C: AlvaAR に渡した焦点距離がマーカー検出と同じ換算（長辺 360px / 水平 68° → ±2px）", Math.abs(c.slamFocal - expectedF) <= 2, `f=${c.slamFocal} 期待=${expectedF.toFixed(1)}`);
  check("C: 実 AlvaAR と同居しても入室・マーカー・発射は動く", c.marker.startsWith("id=") && c.accepted >= 1, `${c.marker} shots=${c.sent}/${c.accepted}`);

  // ---- alva_ar.js が無い（読み込みをブロック）----
  const d = await readHud(pD);
  console.log(`blocked D: ${show(d)}`);
  check("D: alva_ar.js が読めなければ HUD に読み込み失敗が出る", /^failed\(読み込み失敗/.test(d.slamState + d.slamLine.slice(d.slamState.length)), d.slamLine);
  check("D: 読み込み失敗でもマーカーのみで入室・発射できる", d.marker.startsWith("id=") && d.accepted >= 1, `${d.marker} shots=${d.sent}/${d.accepted}`);

  // ---- 俯瞰画面 ----
  const ov = (await pO.eval("document.querySelector('#hud')?.textContent")) ?? "";
  const ovPlayers = (ov.match(/players=(\S*)/)?.[1] ?? "").split(",").filter(Boolean);
  check("俯瞰画面が開けて 4 人が見えている", /ws=open/.test(ov) && ovPlayers.length === 4, ov.split("\n")[0]);

  const exceptions = pages.flatMap((p) => p.exceptions.map((e) => `${p.name}: ${e}`));
  check("例外が出ていない", exceptions.length === 0, exceptions.slice(0, 2).join(" | "));

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
