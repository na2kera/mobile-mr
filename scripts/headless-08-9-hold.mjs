// demos/08-9-splatoon-hold（08-4 の board + solvePnP + 08-7 の SLAM + 静止中はアンカーを止める）のブラウザ経路をヘッドレス Chrome で確認する。
// `npm run check:08-9-hold` で実行する（既定 PORT=5213 CDP_PORT=9352。回す前に lsof -nP -iTCP:5213 -sTCP:LISTEN / :9352 で空きを確かめる）。
// 仕組みは headless-08-7-alva.mjs と同じ（CDP を ws で直接叩く。Chrome が無ければスキップ）。確認すること:
//   (1) OpenCV.js の経路（HUD の pose=opencv）で位置合わせしている（フォールバックしていない）
//   (2) ページ内で __fakeMarkers.camPos に毎フレーム ±1cm のノイズを入れても、1 秒後からは自分の位置（__hold.self = HUD の self= の mm 版）が
//       1mm も変わらず（表示用アンカーの回転もビット単位で変わらず）hold=hold のまま
//   (3) マーカーを見たまま合成カメラを 0.5m 動かすと self= が追従して follow になり、止めると hold に戻る
//   (4) 原点マーカーを隠して動かす（SLAM 駆動。先にマーカーを見ながら動いて SLAM → field を較正する）と self= が追従し、止めると hold
//   (5) 対照: ?hold=0 のウィンドウでは (2) の間 self= がノイズぶんぶれる（hold=off）
//   (6) 俯瞰画面（overview.html）が開けて全員が見えている / 例外が出ていない
// opencv.js / alva_ar.js は無くても (1)(4) 以外は走るが、準備（npm run fetch:opencv）が済んでいる前提で FAIL にする。
// フェイクの SLAM（?fakeslam=1）は合成カメラの正解の姿勢から作るので、SLAM の追跡の質（初期化・ドリフト・リセット）は PC では確かめられない
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
// 別の worktree で同時に走らせるときは PORT / CDP_PORT で変える（同じポートだと別のコードを確認してしまう）
const PORT = Number(process.env.PORT ?? "") || 5213;
const CDP_PORT = Number(process.env.CDP_PORT ?? "") || 9352;
const BASE = `https://localhost:${PORT}/demos/08-9-splatoon-hold/`;
// markerMm=100 / fakeMarkerPx=80: 08-7 の確認と同じ幾何（合成カメラは原点マーカーの正面 0.74m）
const MARKER_MM = 100;
const ROOM = "check-hold";
const COMMON = `fov=70&camZoom=1&fakecam=1&fakeslam=1&autostart=1&fakehands=1&fakeMarkerPx=80&handSmooth=1&room=${ROOM}&waitSec=1&markerMm=${MARKER_MM}`;
const START_POS = [0, 0, 0.74];

if (!existsSync(CHROME)) {
  console.log(`SKIP: Chrome が見つかりません (${CHROME})。CHROME=/path/to/chrome で指定できます`);
  process.exit(0);
}
if (!existsSync(new URL("../public/vendor/opencv/opencv.js", import.meta.url))) console.log("注意: public/vendor/opencv/opencv.js が無い（npm run fetch:opencv）。(1) は FAIL になる");

const results = [];
function check(name, cond, detail = "") {
  results.push([name, cond]);
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${detail ? ` (${detail})` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dist = (a, b) => (a && b ? Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) : Infinity);
const fmt = (v) => (v ? `(${v.map((x) => x.toFixed(3)).join(",")})` : "-");

const server = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], { stdio: ["ignore", "pipe", "pipe"] });
server.stderr.on("data", (d) => process.stderr.write(d));
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

/** HUD を読む（08-4 の pose= 行 + 08-7 の slam= 行 + 08-9 の hold= 行） */
function parseHud(hud) {
  const g = hud.match(/game: phase=(\S+) left=(\S+) color=(\S+) players=(\S*) scores=(\S*) total=(\d+) shots=(\d+)\/(\d+)/);
  const poseLine = hud.match(/^pose=.*$/m)?.[0] ?? "";
  const slamLine = hud.match(/^slam=.*$/m)?.[0] ?? "";
  const holdLine = hud.match(/^hold=.*$/m)?.[0] ?? "";
  return {
    raw: hud,
    base: hud.split("\n")[0] ?? "",
    me: hud.match(/\bme=(\S+)/)?.[1] ?? "-",
    backend: poseLine.match(/^pose=(\S+)/)?.[1] ?? "",
    marker: poseLine.match(/^pose=\S+ (\S+)/)?.[1] ?? "",
    poseLine,
    slamLine,
    slamState: slamLine.match(/^slam=(\S+?)(?:\s|$)/)?.[1] ?? "",
    slamScale: Number(slamLine.match(/ fix=s=([\d.]+)/)?.[1] ?? NaN),
    holdLine,
    holdState: holdLine.match(/^hold=(\S+)/)?.[1] ?? "",
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
  await pA.send("Page.navigate", { url: `${BASE}?${COMMON}&name=Hold` });
  const pB = await newWindow("B");
  await pB.send("Page.navigate", { url: `${BASE}?${COMMON}&name=NoHold&hold=0` });
  const pO = await newWindow("O");
  await pO.send("Page.navigate", { url: `${BASE}overview.html?room=${ROOM}&waitSec=1&markerMm=${MARKER_MM}` });
  const pages = [pA, pB, pO];
  const players = [pA, pB];

  const readHud = async (p) => parseHud((await p.eval("document.querySelector('#hud')?.textContent")) ?? "");
  const readHold = async (p) => p.eval("window.__hold ? { state: window.__hold.state, dev: window.__hold.devPosM, deg: window.__hold.devDeg, info: window.__hold.info, self: window.__hold.self ? [...window.__hold.self] : null, quat: [...window.__hold.anchorQuat] } : null");
  const setCam = (p, pos) => p.eval(`window.__fakeMarkers.camPos = ${JSON.stringify(pos)}; true`);
  /**
   * ページ内で合成カメラを動かす（setInterval 16ms）。from → to を speed [m/s] で直線に動かし、各フレーム ±noise [m] の一様ノイズを足す。
   * to が null なら from に留まってノイズだけ。window.__camMotion.stop() で止める（最後の位置はノイズ無しの到達点にする）
   */
  const startMotion = (p, from, to, speed, noise) =>
    p.eval(`(() => {
      window.__camMotion?.stop();
      const from = ${JSON.stringify(from)}, to = ${JSON.stringify(to)}, speed = ${speed}, noise = ${noise};
      const len = to ? Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]) : 0;
      const t0 = performance.now();
      const at = () => {
        const k = to && len > 0 ? Math.min(1, ((performance.now() - t0) / 1000) * speed / len) : 0;
        return to ? from.map((v, i) => v + (to[i] - v) * k) : [...from];
      };
      const id = setInterval(() => {
        const c = at();
        window.__fakeMarkers.camPos = c.map((v) => v + (Math.random() * 2 - 1) * noise);
      }, 16);
      window.__camMotion = { stop() { clearInterval(id); window.__fakeMarkers.camPos = at(); window.__camMotion = null; }, at };
      return true;
    })()`);
  const stopMotion = (p) => p.eval("window.__camMotion?.stop(); true");
  const truthNow = (p) => p.eval("window.__camMotion ? window.__camMotion.at() : window.__fakeMarkers.camPos");
  /** 一定時間、間隔を置いて __hold を読む */
  async function sampleHold(p, ms, every = 100) {
    const out = [];
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      out.push(await readHold(p));
      await sleep(every);
    }
    return out;
  }
  /** 表示用アンカーの回転のばらつき（サンプルどうしの最大角 [deg]）と、ビット単位で全部同じか */
  const rotSpread = (samples) => {
    const qs = samples.map((s) => s?.quat).filter(Boolean);
    const ang = (a, b) => {
      const d = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
      return (2 * Math.acos(Math.min(1, d)) * 180) / Math.PI;
    };
    const same = qs.length === samples.length && qs.every((q) => q.every((v, i) => v === qs[0][i]));
    return { deg: qs.length ? Math.max(...qs.map((a) => Math.max(...qs.map((b) => ang(a, b))))) : Infinity, same };
  };
  const spreadMm = (samples) => {
    const ss = samples.map((s) => s?.self).filter(Boolean);
    if (ss.length === 0) return Infinity;
    return Math.max(...ss.map((a) => Math.max(...ss.map((b) => dist(a, b))))) * 1000;
  };

  // 全員の入室と OpenCV の経路での検出を待つ（OpenCV.js 約 11MB の読み込みがある）
  const t0 = Date.now();
  while (Date.now() - t0 < 90000) {
    const hs = await Promise.all(players.map(readHud));
    if (hs.every((h) => h.me.startsWith("p") && h.marker.startsWith("id=") && h.backend !== "loading")) break;
    await sleep(500);
  }
  console.log(`${players.length} ウィンドウの入室 + マーカー検出まで ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  await Promise.all(players.map((p) => setCam(p, START_POS)));
  await sleep(4000);

  // ---- (1) OpenCV の経路 ----
  const [a0, b0] = await Promise.all([readHud(pA), readHud(pB)]);
  console.log(`A: ${a0.poseLine}\n   ${a0.slamLine}\n   ${a0.holdLine}`);
  console.log(`B: ${b0.poseLine}\n   ${b0.holdLine}`);
  check("(1) A・B が OpenCV.js の経路（pose=opencv）で位置合わせしている", a0.backend === "opencv" && b0.backend === "opencv" && a0.marker.startsWith("id=") && b0.marker.startsWith("id="), `${a0.backend} / ${b0.backend}`);
  check("HUD の 1 行目に detector= pnp= poseSource= と hold=1(pos=0.02 deg=2 drift=0.5 exit=1.5 out=250ms in=600ms) が出る（B は hold=0）", /detector=opencv pnp=auto poseSource=board hold=1\(pos=0\.02 deg=2 drift=0\.5 exit=1\.5 out=250ms in=600ms\) slam=fake/.test(a0.base) && /hold=0\(/.test(b0.base), a0.base.slice(0, 200));
  check("A: フェイクの SLAM が追跡中（slam=tracking）", a0.slamState.startsWith("tracking"), a0.slamLine);
  check("A: 止まっていれば hold=hold、B（?hold=0）は hold=off", a0.holdState === "hold" && b0.holdState === "off", `${a0.holdLine} / ${b0.holdLine}`);
  check("A・B とも練習で発射が受理されている（08 と同じ仕様）", a0.accepted >= 1 && b0.accepted >= 1, `${a0.accepted} / ${b0.accepted}`);

  // ---- (2) + (5) 毎フレーム ±1cm のノイズ ----
  await Promise.all(players.map((p) => startMotion(p, START_POS, null, 0, 0.01)));
  await sleep(1000);
  const [sa, sb] = await Promise.all([sampleHold(pA, 4000), sampleHold(pB, 4000)]);
  const aSpread = spreadMm(sa);
  const bSpread = spreadMm(sb);
  const aStates = new Set(sa.map((s) => s?.state));
  const aDevMax = Math.max(...sa.map((s) => s?.dev ?? Infinity));
  const aDegMax = Math.max(...sa.map((s) => s?.deg ?? Infinity));
  console.log(`noise A: self=${fmt(sa.at(-1)?.self)} spread=${aSpread.toFixed(1)}mm states=${[...aStates].join(",")} 推定と表示の差の最大 dev=${aDevMax.toFixed(3)}m/${aDegMax.toFixed(2)}deg（${sa.length} 回読んだ）`);
  console.log(`noise B: self=${fmt(sb.at(-1)?.self)} spread=${bSpread.toFixed(1)}mm info=${sb.at(-1)?.info}`);
  check("(2) ±1cm のノイズを入れて 1 秒後から 4 秒間、A の self= が 1mm も変わらず hold=hold のまま", aSpread === 0 && aStates.size === 1 && aStates.has("hold"), `spread=${aSpread.toFixed(1)}mm states=${[...aStates].join(",")}`);
  const aRot = rotSpread(sa);
  const bRot = rotSpread(sb);
  console.log(`noise rot: A spread=${aRot.deg.toFixed(4)}deg same=${aRot.same} / B spread=${bRot.deg.toFixed(3)}deg`);
  check("(2) 同じ間、A の表示用アンカーの回転もビット単位で変わらない", aRot.same && aRot.deg === 0, `A ${aRot.deg}deg（B は ${bRot.deg.toFixed(3)}deg）`);
  check("(5) 対照: ?hold=0 の B は同じノイズで self= がぶれる（1mm 超）", bSpread > 1 && sb.every((s) => s?.state === "follow"), `spread=${bSpread.toFixed(1)}mm`);
  await Promise.all(players.map(stopMotion));
  await Promise.all(players.map((p) => setCam(p, START_POS)));
  await sleep(1500);

  // ---- (3) マーカーを見たまま 0.5m 動かす ----
  // 合成カメラの向きは固定（正面）なので、横にずれるほどマーカーを斜めに見る。原点の正面から ±10° 程度に収まる斜めの線で 0.5m 動かす
  const walkFrom = [-0.1, 0.08, 0.85];
  const walkTo = [0.1, -0.08, 0.42];
  await Promise.all(players.map((p) => setCam(p, walkFrom)));
  await sleep(3000);
  const w0 = await readHold(pA);
  console.log(`walk start A: ${w0.info} self=${fmt(w0.self)} 正解=${fmt(walkFrom)}`);
  // 対照の B（?hold=0）にも同じ動きを流し、真値からの遅れを A と比べる。2 つのページはマーカー検出（100ms ごと）の位相が別々なので、
  // 1 回だけ読むと検出 1 回分（0.25m/s × 100ms ≈ 2.5cm）ずれることがある。歩いている途中で 8 回読んだ平均で比べる
  const tWalk = Date.now();
  await Promise.all([startMotion(pA, walkFrom, walkTo, 0.25, 0), startMotion(pB, walkFrom, walkTo, 0.25, 0)]); // 0.5m を 2 秒
  await sleep(900);
  const lagsA = [];
  const lagsB = [];
  let wMid = null;
  let wMidTruth = null;
  let wMidHud = null;
  for (let k = 0; k < 8; k++) {
    const [ha, ta, hb, tb] = await Promise.all([readHold(pA), truthNow(pA), readHold(pB), truthNow(pB)]);
    lagsA.push(dist(ha.self, ta));
    lagsB.push(dist(hb.self, tb));
    if (k === 3) [wMid, wMidTruth, wMidHud] = [ha, ta, await readHud(pA)];
    await sleep(80);
  }
  console.log(`walk mid A: ${wMid.info} self=${fmt(wMid.self)} 正解=${fmt(wMidTruth)} | ${wMidHud.poseLine}`);
  const mean = (xs) => xs.reduce((a, x) => a + x, 0) / xs.length;
  const lagA = mean(lagsA);
  const lagB = mean(lagsB);
  console.log(`walk mid 遅れ（8 回の平均）A=${lagA.toFixed(3)}m B=${lagB.toFixed(3)}m（A: ${lagsA.map((x) => x.toFixed(3)).join(",")} / B: ${lagsB.map((x) => x.toFixed(3)).join(",")}）`);
  check("(3) 動いている間は follow で、表示は推定そのまま（推定と表示の差 dev < 1cm = 遅れの原因は hold ではない）", wMid.state === "follow" && wMid.dev < 0.01, `dev=${wMid.dev.toFixed(4)}m`);
  check("(3) 動いている間の真値からの遅れ（8 回の平均）が ?hold=0 の B と同じ（差 < 2cm = 遅れはマーカー検出 + lerp のもので hold のせいではない）", Math.abs(lagA - lagB) < 0.02, `A=${lagA.toFixed(3)}m B=${lagB.toFixed(3)}m 差=${Math.abs(lagA - lagB).toFixed(3)}m`);
  check("(3) 動いている間 self= が合成カメラに追従している（真値から ±10cm。マーカー検出 + lerp の遅れ込み）", dist(wMid.self, wMidTruth) < 0.1 && dist(wMid.self, w0.self) > 0.1, `self=${fmt(wMid.self)} 正解=${fmt(wMidTruth)} 差=${dist(wMid.self, wMidTruth).toFixed(3)}m 動いた量=${dist(wMid.self, w0.self).toFixed(3)}m`);
  await sleep(Math.max(0, 2700 - (Date.now() - tWalk)));
  await Promise.all([stopMotion(pA), stopMotion(pB)]);
  await sleep(2500);
  const wEnd = await readHold(pA);
  console.log(`walk end A: ${wEnd.info} self=${fmt(wEnd.self)} 正解=${fmt(walkTo)}`);
  // 固定姿勢が減速の尾で歩いてきた側に寄ると、止まった後の dev（推定と表示の差）が 1.5〜2cm 残っていた（ドリフト条件を足す前）
  check("(3) 0.5m 動いて止まると hold に戻り、固定姿勢が推定から 1cm 以内（減速の尾を平均に混ぜない）、self= が到達点（±2cm）", wEnd.state === "hold" && wEnd.dev < 0.01 && dist(wEnd.self, walkTo) < 0.02 && dist(w0.self, walkFrom) < 0.03, `dev=${wEnd.dev.toFixed(4)}m start 差=${dist(w0.self, walkFrom).toFixed(3)}m end 差=${dist(wEnd.self, walkTo).toFixed(3)}m`);

  // ---- SLAM の較正（08-7 の確認と同じ動き。マーカーを見ながら 15cm 以上動く）----
  const calib = [[0, 0, 0.5], [0, 0.04, 0.8], [0.04, -0.03, 0.55], [-0.04, 0.03, 0.8], [0, -0.04, 0.6], [0.03, 0.03, 0.5], START_POS];
  for (const pos of calib) {
    await setCam(pA, pos);
    await sleep(3000);
  }
  await sleep(1000);
  const c1 = await readHud(pA);
  const c1h = await readHold(pA);
  console.log(`calibrated A: ${c1.slamLine}\n   ${c1h.info} self=${fmt(c1h.self)}`);
  check("A: マーカーを見ながら動くと SLAM → field の変換が推定される（fix=s= が出る。スケールは 1/0.37 の ±15%）", Number.isFinite(c1.slamScale) && Math.abs(c1.slamScale * 0.37 - 1) < 0.15, `s=${c1.slamScale}`);
  check("A: 較正の後、原点の正面で止まれば hold（self= が ±5cm）", c1h.state === "hold" && dist(c1h.self, START_POS) < 0.05, `${c1h.info} self=${fmt(c1h.self)}`);

  // ---- (4) 原点マーカーを隠して動かす（SLAM 駆動）----
  await pA.eval("window.__fakeMarkers.hidden.add(0); true");
  await sleep(1500);
  const h0 = await readHold(pA);
  const h0Hud = await readHud(pA);
  console.log(`hidden A: ${h0.info} self=${fmt(h0.self)} | ${h0Hud.poseLine}`);
  const slamTo = [0.4, 0.1, 1.2];
  await startMotion(pA, START_POS, slamTo, 0.3, 0); // 約 0.72m を 2.4 秒
  await sleep(1200);
  const [sMid, sMidTruth, sMidHud] = await Promise.all([readHold(pA), truthNow(pA), readHud(pA)]);
  console.log(`slam walk mid A: ${sMid.info} self=${fmt(sMid.self)} 正解=${fmt(sMidTruth)} | ${sMidHud.slamLine}`);
  check("(4) マーカーを隠して動くと SLAM 駆動（pose= 行が (slam)、slam=tracking+drive）で follow、self= が追従（±10cm）", /\(slam\)/.test(sMidHud.poseLine) && sMidHud.slamState === "tracking+drive" && sMid.state === "follow" && dist(sMid.self, sMidTruth) < 0.1, `self=${fmt(sMid.self)} 正解=${fmt(sMidTruth)} 差=${dist(sMid.self, sMidTruth).toFixed(3)}m`);
  await sleep(1800);
  await stopMotion(pA);
  await sleep(2500);
  const [sEnd, sEndHud] = await Promise.all([readHold(pA), readHud(pA)]);
  console.log(`slam walk end A: ${sEnd.info} self=${fmt(sEnd.self)} 正解=${fmt(slamTo)} | ${sEndHud.poseLine}`);
  check("(4) SLAM 駆動で止まると hold に戻り、固定姿勢が推定から 1cm 以内、self= が到達点（±3cm）", sEnd.state === "hold" && sEnd.dev < 0.01 && /\(slam\)/.test(sEndHud.poseLine) && dist(sEnd.self, slamTo) < 0.03, `${sEnd.info} 差=${dist(sEnd.self, slamTo).toFixed(3)}m`);
  // SLAM 駆動で止まっている間もノイズ（fakeSlamNoise）が乗るが、hold なら self= は変わらない
  const sHeld = await sampleHold(pA, 2000);
  const sRot = rotSpread(sHeld);
  check("(4) SLAM 駆動で止まっている間 self= が 1mm も変わらず、表示用アンカーの回転もビット単位で変わらない", spreadMm(sHeld) === 0 && sHeld.every((s) => s?.state === "hold") && sRot.same, `spread=${spreadMm(sHeld).toFixed(1)}mm rot=${sRot.deg}deg`);
  // マーカーを戻す → マーカーの追跡に戻る
  await setCam(pA, START_POS);
  await pA.eval("window.__fakeMarkers.hidden.delete(0); true");
  await sleep(3000);
  const back = await readHold(pA);
  const backHud = await readHud(pA);
  console.log(`back A: ${back.info} self=${fmt(back.self)} | ${backHud.poseLine}`);
  check("マーカーを戻して原点の正面に戻ると、マーカーの追跡で self= が原点の正面（±5cm）", backHud.marker.startsWith("id=") && !/\(slam\)/.test(backHud.poseLine) && dist(back.self, START_POS) < 0.05, `self=${fmt(back.self)}`);
  const aFinal = await readHud(pA);
  check("A: 動いている間も発射が受理され続ける", aFinal.accepted > a0.accepted, `${a0.accepted} → ${aFinal.accepted}`);

  // ---- (6) 俯瞰画面 / 例外 ----
  const ov = (await pO.eval("document.querySelector('#hud')?.textContent")) ?? "";
  const ovPlayers = (ov.match(/players=(\S*)/)?.[1] ?? "").split(",").filter(Boolean);
  check(`(6) 俯瞰画面が開けて ${players.length} 人が見えている`, /ws=open/.test(ov) && ovPlayers.length === players.length, ov.split("\n")[0]);
  const exceptions = pages.flatMap((p) => p.exceptions.map((e) => `${p.name}: ${e}`));
  check("(6) 例外が出ていない", exceptions.length === 0, exceptions.slice(0, 2).join(" | "));

  const failed = results.filter(([, ok]) => !ok);
  console.log(failed.length === 0 ? `\nALL PASS (${results.length})` : `\n${failed.length} FAILED / ${results.length}`);
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
