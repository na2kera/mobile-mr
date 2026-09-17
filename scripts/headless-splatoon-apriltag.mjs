// demos/08-5-splatoon-apriltag（候補 1c AprilTag）のブラウザ経路をヘッドレス Chrome で確認する。
// `npm run check:splatoon-apriltag` で実行する（先に `npm run fetch:apriltag` と `npm run fetch:models`）。
// 仕組みは headless-splatoon.mjs と同じ（CDP を ws で直接叩く。Chrome が無ければスキップ）。
//
// 確認内容:
//   1. 検出器の比較（同じ合成映像で AprilTag と js-aruco2 を順に）: 正面 / 斜め 45°・1.5 倍の距離 / 斜め 60°・2 倍 / 正面 2.5 倍 で
//      検出率（HUD を 20 回読んで追跡中だった割合）・自分の位置（self=）のフェイクカメラの位置からの誤差・検出 1 回の処理時間。
//      結果は表で出す（README の表はここから写す）。正面は 08 と同じ位置（8cm 以内）に来ることを PASS 条件にする
//   2. WASM が読めているか（HUD の detector=apriltag apriltag=ready）と、?detector=aruco2 で 08 と同じ js-aruco2 に切り替わること（marker= の行）
//   3. 2 ウィンドウ + 俯瞰画面で 入室 → 練習で連射が受理され得点 → 対戦開始 → 試合中の得点 → 途中終了 → 結果を閉じる（08 の流れが AprilTag でも通る）
//   4. 例外が出ていない
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
// 他の headless-*.mjs と被らない値（同時に走らせたとき相手のサーバーに繋がらないように）
const PORT = Number(process.env.PORT ?? "") || 5198;
const CDP_PORT = Number(process.env.CDP_PORT ?? "") || 9345;
/** 入室後に練習の HUD を読むまでの待ち [s] */
const WAIT_SEC = Number(process.env.WAIT_SEC ?? "") || 12;
/** 対戦開始を押してから試合中の HUD を読むまでの待ち [s] */
const PLAY_WAIT_SEC = Number(process.env.PLAY_WAIT_SEC ?? "") || 12;
const BASE = `https://localhost:${PORT}/demos/08-5-splatoon-apriltag/`;
// markerMm=100 / fakeMarkerPx=80: 08 の headless と同じ合成カメラの幾何（原点マーカーが 80px に映る距離 d0 = 0.74m）
const MARKER_MM = 100;
const FAKE_FOCAL = 640 / 2 / Math.tan((68 * Math.PI) / 180 / 2);
const D0 = ((MARKER_MM / 1000) * FAKE_FOCAL) / (0.8 * 80);
const COMMON = `fov=70&camZoom=1&fakecam=1&autostart=1&fakeMarkerPx=80&handSmooth=1&waitSec=1&tankHoldMs=0&markerMm=${MARKER_MM}`;

if (!existsSync(CHROME)) {
  console.log(`SKIP: Chrome が見つかりません (${CHROME})。CHROME=/path/to/chrome で指定できます`);
  process.exit(0);
}
if (!existsSync(new URL("../public/vendor/apriltag/apriltag_wasm.wasm", import.meta.url))) {
  console.log("FAIL: public/vendor/apriltag/apriltag_wasm.wasm が無い。先に npm run fetch:apriltag を実行してください");
  process.exit(1);
}

const results = [];
function check(name, cond, detail = "") {
  results.push([name, cond]);
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${detail ? ` (${detail})` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], { stdio: ["ignore", "pipe", "pipe"] });
server.stderr.on("data", (d) => process.stderr.write(d));
const landings = [];
const serverLines = [];
server.stdout.on("data", (d) => {
  for (const line of d.toString().split("\n")) {
    if (!line.startsWith("[splatoon]")) continue;
    serverLines.push(line);
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

/** HUD を読む。位置合わせの行は AprilTag なら april=、aruco2 に落ちていれば marker= */
function parseHud(hud) {
  const g = hud.match(/game: phase=(\S+) left=(\S+) color=(\S+) players=(\S*) scores=(\S*) total=(\d+) shots=(\d+)\/(\d+)/);
  const scores = {};
  for (const m of (g?.[5] ?? "").matchAll(/(p\d+):(\d+)/g)) scores[m[1]] = Number(m[2]);
  const self = hud.match(/self=\(([^)]*)\)/)?.[1].split(",").map(Number);
  const line = hud.match(/\b(april|marker)=(.*?) layout=/);
  const info = line?.[2] ?? "";
  return {
    me: hud.match(/\bme=(\S+)/)?.[1] ?? "-",
    /** 位置合わせの行の名前（april / marker） */
    lineName: line?.[1] ?? "",
    info,
    detector: hud.match(/\bdetector=(\S+)/)?.[1] ?? "",
    apriltag: hud.match(/\bapriltag=(\S+)/)?.[1] ?? "",
    markerIds: new Set((info.match(/^id=([\d+]+)/)?.[1] ?? "").split("+").filter(Boolean).map(Number)),
    err: Number(info.match(/err=([\d.]+)/)?.[1] ?? NaN),
    spread: Number(info.match(/spread=([\d.]+)m/)?.[1] ?? 0),
    tilt: info.match(/tilt=([\d.]+)deg/) ? Number(info.match(/tilt=([\d.]+)deg/)[1]) : null,
    correction: Number(info.match(/Δ=([\d.]+)m/)?.[1] ?? NaN),
    /** 検出 1 回の処理時間 [ms]（info の末尾） */
    detMs: Number(info.match(/(\d+)ms$/)?.[1] ?? NaN),
    tracking: /^id=/.test(info) && !/holding last pose/.test(hud),
    layout: hud.match(/layout=(\S+)/)?.[1] ?? "",
    self: self && self.length === 3 && self.every(Number.isFinite) ? self : null,
    field: hud.match(/field=(\S+)/)?.[1] ?? "",
    phase: g?.[1] ?? "",
    left: g ? Number(g[2].replace(/s$/, "")) : -1,
    color: g ? Number(g[3]) : 0,
    players: (g?.[4] ?? "").split(",").filter(Boolean),
    scores,
    total: g ? Number(g[6]) : 0,
    sent: g ? Number(g[7]) : -1,
    accepted: g ? Number(g[8]) : -1,
  };
}

function parseOverviewHud(hud) {
  const scores = {};
  for (const m of (hud.match(/scores=(\S*)/)?.[1] ?? "").matchAll(/(p\d+):(\d+)/g)) scores[m[1]] = Number(m[2]);
  return {
    me: hud.match(/\bme=(\S+)/)?.[1] ?? "-",
    ws: hud.match(/ws=(\S+)/)?.[1] ?? "",
    phase: hud.match(/phase=(\S+)/)?.[1] ?? "",
    players: (hud.match(/players=(\S*)/)?.[1] ?? "").split(",").filter(Boolean),
    scores,
    total: Number(hud.match(/total=(\d+)/)?.[1] ?? -1),
    starts: Number(hud.match(/starts=(\d+)/)?.[1] ?? -1),
    stops: Number(hud.match(/stops=(\d+)/)?.[1] ?? -1),
    dismisses: Number(hud.match(/dismisses=(\d+)/)?.[1] ?? -1),
    peerMarkers: Object.fromEntries((hud.match(/peerMarkers=(\S*)/)?.[1] ?? "").split(",").filter(Boolean).map((e) => e.split(":"))),
  };
}

const profile = mkdtempSync(join(tmpdir(), "mobile-mr-chrome-"));
let chrome = null;
let exitCode = 1;
const pages = [];
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
  const first = targets.find((t) => t.type === "page");
  const version = await cdpJson("/json/version");
  const browser = new Page(version.webSocketDebuggerUrl, "browser");
  await browser.ready();
  let firstUsed = false;
  const newWindow = async (name) => {
    let target = first;
    if (firstUsed) {
      const created = await browser.send("Target.createTarget", { url: "about:blank", newWindow: true });
      target = (await cdpJson("/json")).find((t) => t.id === created.result.targetId);
    }
    firstUsed = true;
    const p = await openPage(target, name);
    pages.push(p);
    return p;
  };
  const readHud = async (p) => parseHud((await p.eval("document.querySelector('#hud')?.textContent")) ?? "");
  const waitFor = async (p, cond, timeoutMs = 40000) => {
    const t0 = Date.now();
    let h = await readHud(p);
    while (Date.now() - t0 < timeoutMs && !cond(h)) {
      await sleep(400);
      h = await readHud(p);
    }
    return h;
  };

  // ---- 1. 検出器の比較（同じ合成映像で AprilTag / AprilTag decimate=1 / js-aruco2 を順に）----
  // カメラは原点マーカー（正面の壁、Z=0、法線 +Z）を見る位置: 距離 d・水平角 θ で (d sinθ, 0, d cosθ)、yaw = θ（+ で左を向く = 原点の方）
  const conditions = [
    { name: "正面 1.0d0", dist: 1, yaw: 0 },
    { name: "斜め 45° 1.5d0", dist: 1.5, yaw: 45 },
    { name: "斜め 60° 2.0d0", dist: 2, yaw: 60 },
    { name: "正面 2.5d0", dist: 2.5, yaw: 0 },
  ];
  const detectors = [
    { name: "apriltag dec2", query: "" },
    { name: "apriltag dec1", query: "&aprilDecimate=1" },
    { name: "aruco2", query: "&detector=aruco2" },
  ];
  const table = [];
  const cmpPage = await newWindow("cmp");
  let cmpIndex = 0;
  for (const c of conditions) {
    const th = (c.yaw * Math.PI) / 180;
    const pos = [D0 * c.dist * Math.sin(th), 0, D0 * c.dist * Math.cos(th)];
    for (const d of detectors) {
      cmpIndex++;
      // fakehands=1: MediaPipe の読み込み（GPU 初期化で数百 ms メインスレッドが止まり、lostMs=500 を超えて一瞬 "holding last pose" になる）を避ける
      const url = `${BASE}?${COMMON}&fakehands=1&name=C${cmpIndex}&room=cmp${cmpIndex}&fakeCamPos=${pos.map((v) => v.toFixed(3)).join(",")}&fakeYaw=${c.yaw}${d.query}`;
      await cmpPage.send("Page.navigate", { url });
      // 入室して（self= が出るには pose を送る必要がある）検出器の状態が決まるまで待つ。検出できない条件では検出を待たない
      const h0 = await waitFor(cmpPage, (h) => h.me.startsWith("p") && (h.apriltag.startsWith("ready") || h.apriltag === "unused" || h.apriltag.startsWith("error")), 40000);
      await waitFor(cmpPage, (h) => h.tracking && h.self !== null, 6000);
      // 20 回読んで追跡率・誤差・時間
      const samples = [];
      for (let i = 0; i < 20; i++) {
        samples.push(await readHud(cmpPage));
        await sleep(150);
      }
      const tracked = samples.filter((h) => h.tracking);
      const rejected = cmpPage.logs.filter((l) => l.startsWith("[marker] observed but rejected")).length;
      cmpPage.logs.length = 0;
      const selfErr = tracked.filter((h) => h.self).map((h) => Math.hypot(h.self[0] - pos[0], h.self[1] - pos[1], h.self[2] - pos[2]));
      const row = {
        condition: c.name,
        detector: d.name,
        detectorActive: h0.detector,
        apriltag: h0.apriltag,
        lineName: samples.at(-1)?.lineName ?? "",
        rate: tracked.length / samples.length,
        selfErrMax: selfErr.length ? Math.max(...selfErr) : NaN,
        selfErrMean: selfErr.length ? selfErr.reduce((a, b) => a + b, 0) / selfErr.length : NaN,
        err: tracked.length ? Math.max(...tracked.map((h) => h.err)) : NaN,
        detMs: tracked.length ? tracked.reduce((a, h) => a + h.detMs, 0) / tracked.length : NaN,
        /** 検出はしたが姿勢の誤差（maxPoseError）で捨てた回数（console のログ） */
        rejected,
        lastInfo: samples.at(-1)?.info ?? "",
      };
      table.push(row);
      console.log(`cmp ${c.name} / ${d.name}: detector=${row.detectorActive} apriltag=${row.apriltag} line=${row.lineName} rate=${row.rate.toFixed(2)} self err mean=${row.selfErrMean.toFixed(3)} max=${row.selfErrMax.toFixed(3)} reproj=${row.err.toFixed(2)} ${row.detMs.toFixed(0)}ms rejected=${row.rejected} last="${row.lastInfo}"`);
    }
  }
  await cmpPage.send("Page.navigate", { url: "about:blank" });
  console.log("\n| 条件 | 検出器 | 検出率 | 自分の位置の誤差 平均 / 最大 [m] | 再投影誤差 | 検出時間 [ms] |");
  console.log("| --- | --- | --- | --- | --- | --- |");
  for (const r of table) {
    console.log(`| ${r.condition} | ${r.detector} | ${(r.rate * 100).toFixed(0)}% | ${Number.isFinite(r.selfErrMean) ? `${r.selfErrMean.toFixed(3)} / ${r.selfErrMax.toFixed(3)}` : "-"} | ${Number.isFinite(r.err) ? r.err.toFixed(2) : "-"} | ${Number.isFinite(r.detMs) ? r.detMs.toFixed(0) : "-"} |`);
  }
  console.log("");
  const front = (name) => table.find((r) => r.condition === "正面 1.0d0" && r.detector === name);
  check("AprilTag の WASM が読めて既定で使われている（HUD に detector=apriltag apriltag=ready、行は april=）", front("apriltag dec2").detectorActive === "apriltag" && front("apriltag dec2").apriltag.startsWith("ready") && front("apriltag dec2").lineName === "april", `${front("apriltag dec2").detectorActive} ${front("apriltag dec2").apriltag}`);
  check("?detector=aruco2 で 08 と同じ js-aruco2 に切り替わる（detector=aruco2 apriltag=unused、行は marker=）", front("aruco2").detectorActive === "aruco2" && front("aruco2").apriltag === "unused" && front("aruco2").lineName === "marker", `${front("aruco2").detectorActive} ${front("aruco2").apriltag}`);
  check("正面: AprilTag がほぼ常に検出し（≥ 90%）、自分の位置がフェイクカメラの位置 (0,0,d0) に 8cm 以内で一致（08 と同じ位置）", front("apriltag dec2").rate >= 0.9 && front("apriltag dec2").selfErrMax < 0.08, `rate=${front("apriltag dec2").rate} err=${front("apriltag dec2").selfErrMax.toFixed(3)}`);
  check("正面: js-aruco2（比較の基準）も同じ位置に来る", front("aruco2").rate >= 0.9 && front("aruco2").selfErrMax < 0.08, `err=${front("aruco2").selfErrMax.toFixed(3)}`);
  check("正面: AprilTag の正規化再投影誤差が小さい（座標系の変換が合っている。間違っていれば 1 前後）", front("apriltag dec2").err < 0.1, `reproj=${front("apriltag dec2").err.toFixed(3)}`);
  const oblique = table.filter((r) => r.condition.startsWith("斜め") && r.detector === "apriltag dec2");
  check("斜め 45° / 60°: AprilTag が検出できて（検出率 > 0.8）自分の位置が 15cm 以内", oblique.every((r) => r.rate > 0.8 && r.selfErrMax < 0.15), oblique.map((r) => `${r.condition}: rate=${r.rate.toFixed(2)} err=${r.selfErrMax.toFixed(3)}`).join(", "));
  check("AprilTag の検出時間が 1 回 200ms 未満（ヘッドレスの swiftshader でも実用の範囲）", table.filter((r) => r.detector.startsWith("apriltag") && Number.isFinite(r.detMs)).every((r) => r.detMs < 200), table.filter((r) => r.detector.startsWith("apriltag")).map((r) => `${r.detMs.toFixed(0)}ms`).join(","));

  // ---- 2. ゲームの流れ（2 ウィンドウ + 俯瞰画面。08 と同じ手順を AprilTag で）----
  const GAME = `${COMMON}&fakehands=1&room=check`;
  const p1 = await newWindow("1");
  await p1.send("Page.navigate", { url: `${BASE}?${GAME}&name=One&fakeOpenSec=9&fakeMarkers=5:wall:0.25,0,0` });
  const p2 = await newWindow("2");
  await p2.send("Page.navigate", { url: `${BASE}?${GAME}&name=Two&fakeShift=40&tankShow=always` });
  const p3 = await newWindow("3");
  await p3.send("Page.navigate", { url: `${BASE}overview.html?room=check&waitSec=1&markerMm=${MARKER_MM}` });
  const t0 = Date.now();
  while (Date.now() - t0 < 40000) {
    const [h1, h2] = await Promise.all([readHud(p1), readHud(p2)]);
    if (h1.me.startsWith("p") && h2.me.startsWith("p") && h1.tracking && h2.tracking) break;
    await sleep(500);
  }
  console.log(`両ウィンドウの入室 + マーカー検出まで ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  await sleep(WAIT_SEC * 1000);
  const readOverview = async () => parseOverviewHud((await p3.eval("document.querySelector('#hud')?.textContent")) ?? "");
  const show = (h) => `me=${h.me} ${h.lineName}=${h.info} phase=${h.phase} color=${h.color} players=${h.players.join("|")} scores=${JSON.stringify(h.scores)}/${h.total} shots=${h.sent}/${h.accepted}`;
  const pr1 = await readHud(p1);
  const pr2 = await readHud(p2);
  const prOv = await readOverview();
  console.log(`practice window1: ${show(pr1)}`);
  console.log(`practice window2: ${show(pr2)}`);
  console.log(`practice overview: me=${prOv.me} phase=${prOv.phase} players=${prOv.players.join("|")} scores=${JSON.stringify(prOv.scores)}`);
  check("両ウィンドウで AprilTag がマーカー（tag36h11 の合成映像）を検出している", pr1.detector === "apriltag" && pr2.detector === "apriltag" && pr1.tracking && pr2.tracking, `${pr1.info} / ${pr2.info}`);
  check("両方が同じ room に入り 2 人になっている", pr1.players.length === 2 && pr2.players.length === 2);
  check("個人戦: 別の色が割り当たっている", pr1.color > 0 && pr2.color > 0 && pr1.color !== pr2.color, `${pr1.color} vs ${pr2.color}`);
  check("入室直後は練習（practice）で、俯瞰画面もそう見えている", pr1.phase === "practice" && pr2.phase === "practice" && prOv.phase === "practice");
  check("練習中に連射が送られ受理されている（手 → 目 → 手の向きへ発射 → サーバー検証、が AprilTag の姿勢でも通る）", pr1.sent >= 3 && pr1.accepted >= 3 && pr2.accepted >= 3, `${pr1.sent}/${pr1.accepted}, ${pr2.sent}/${pr2.accepted}`);
  check("練習中の塗りが得点に出る", (pr1.scores[pr1.me] ?? 0) > 0 && (pr2.scores[pr2.me] ?? 0) > 0, JSON.stringify(pr1.scores));
  check("俯瞰画面はプレイヤーではなく、2 人を見ている", prOv.me.startsWith("p") && prOv.players.length === 2, `${prOv.me} / ${prOv.players.join("|")}`);

  // 追加マーカー（正面 2 枚目 ID 5）を配ると 2 枚同時に使い、spread が小さい（tag36h11 でも複数マーカーの合成が効く）
  const setRows = await p3.eval(`(() => {
    const rows = document.querySelectorAll('#marker-rows .row');
    const row = rows[4];
    const cb = row.querySelector('input[type=checkbox]');
    cb.checked = true;
    cb.dispatchEvent(new Event('change'));
    const nums = row.querySelectorAll('input[type=number]');
    [5, 0.25, 0, 0].forEach((v, i) => { nums[i].value = String(v); nums[i].dispatchEvent(new Event('input')); });
    return !cb.disabled;
  })()`);
  await sleep(300);
  await p3.eval("document.querySelector('#apply-markers').click()");
  await sleep(3000);
  const mk1 = await readHud(p1);
  console.log(`markers window1: ${show(mk1)} layout=${mk1.layout}`);
  check("追加マーカー（正面 2 枚目 ID 5）を配ると、ウィンドウ 1 は 2 枚同時に使って位置合わせする", setRows === true && mk1.layout === "5:wall" && mk1.markerIds.size === 2 && mk1.markerIds.has(0) && mk1.markerIds.has(5), `${mk1.info} layout=${mk1.layout}`);
  check("2 枚から出した原点の位置のばらつき（spread）が 5cm 未満", mk1.markerIds.size === 2 && mk1.spread < 0.05, `spread=${mk1.spread}`);
  await p1.eval("window.__fakeMarkers.hidden.add(0)");
  await sleep(1500);
  const hid1 = await readHud(p1);
  check("原点マーカーを隠すと ID 5 だけで位置合わせが続く", hid1.markerIds.size === 1 && hid1.markerIds.has(5) && hid1.tracking, hid1.info);
  const selfDrift = mk1.self && hid1.self ? Math.hypot(...mk1.self.map((v, i) => v - hid1.self[i])) : Infinity;
  check("ID 5 だけになっても自分の位置（self）が 5cm 以上動かない", selfDrift < 0.05, `drift=${selfDrift.toFixed(3)}m`);
  await p1.eval("window.__fakeMarkers.hidden.delete(0)");

  // 対戦開始 → 試合 → 途中終了 → 結果を閉じる
  await p3.eval("document.querySelector('#start-match').click()");
  await sleep(PLAY_WAIT_SEC * 1000);
  const hud1 = await readHud(p1);
  const hud2 = await readHud(p2);
  const hudOv = await readOverview();
  console.log(`play window1: ${show(hud1)}`);
  console.log(`play window2: ${show(hud2)}`);
  check("俯瞰画面の start が送られ、試合（play）になっている", hudOv.starts === 1 && hud1.phase === "play" && hud2.phase === "play" && hudOv.phase === "play");
  check("試合中も両ウィンドウで連射が受理され続けている", hud1.accepted > pr1.accepted && hud2.accepted > pr2.accepted, `${pr1.accepted} → ${hud1.accepted}, ${pr2.accepted} → ${hud2.accepted}`);
  check("両プレイヤーが得点している（着弾と塗りが field 座標で合っている）", (hud1.scores[hud1.me] ?? 0) > 0 && (hud2.scores[hud2.me] ?? 0) > 0, JSON.stringify(hud1.scores));
  const diff = Object.keys({ ...hud1.scores, ...hud2.scores }).reduce((a, k) => a + Math.abs((hud1.scores[k] ?? 0) - (hud2.scores[k] ?? 0)), 0);
  check("両ウィンドウの HUD でほぼ同じ得点が見えている（権威状態の配信）", diff <= Math.max(200, hud1.total * 0.02), `${JSON.stringify(hud1.scores)} vs ${JSON.stringify(hud2.scores)}`);
  const hits = landings.filter((l) => l.where !== "miss");
  check("着弾のほとんどが壁か床に当たっている（外れが半分未満）", landings.length >= 6 && hits.length > landings.length / 2, `${hits.length}/${landings.length} hit`);
  await p3.eval("document.querySelector('#stop-match').click()");
  await sleep(1500);
  const st1 = await readHud(p1);
  const stOv = await readOverview();
  check("「対戦を終了」で結果（result）になる", stOv.stops === 1 && st1.phase === "result" && stOv.phase === "result");
  await p3.eval("document.querySelector('#stop-match').click()");
  await sleep(1500);
  const dm1 = await readHud(p1);
  const dmOv = await readOverview();
  check("「結果を閉じる」で練習に戻る", dmOv.dismisses === 1 && dm1.phase === "practice" && dmOv.phase === "practice", `${dm1.phase}/${dmOv.phase}`);
  check("例外が出ていない", pages.every((p) => p.exceptions.length === 0), pages.flatMap((p) => p.exceptions).slice(0, 2).join(" | "));
  for (const l of p1.logs.filter((l) => l.startsWith("[game] shot sent")).slice(0, 2)) console.log(`window1 log: ${l}`);
  for (const l of pages.flatMap((p) => p.logs).filter((l) => /\[apriltag\]|\[marker\] observed but rejected/.test(l)).slice(0, 4)) console.log(`log: ${l}`);

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
