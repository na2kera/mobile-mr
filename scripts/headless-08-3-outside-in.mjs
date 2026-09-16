// demos/08-3-splatoon-outside-in のブラウザ経路をヘッドレス Chrome で確認する。`npm run check:outside-in` で実行する。
// 仕組みは headless-splatoon.mjs と同じ（CDP を ws で直接叩く。Chrome が無ければスキップ）。
//
// 確認内容: スマホ側 2 ウィンドウ（フェイクカメラ = チェッカーボード + 合成の手）+ 俯瞰画面 1 ウィンドウ + トラッカー 1 ウィンドウ
// （俯瞰画面の ?tracker=1&fakecam=1。フェイクカメラに原点マーカー + 床のマーカー + 2 人のゴーグルのマーカー（ID 10 / 11）を
// 部屋座標系に置いてピンホール投影する）で、
//   - スマホは入室しても位置が来るまで撃てない（トラッカー待ち → 原点未確定 → 位置待ち の案内）
//   - 俯瞰画面で床のマーカーの配置を配り、トラッカーがそれを見て「原点を確定」できる
//   - 両方の位置がサーバーから届き（HUD の track=id=10 / 11、self= が置いた位置に 5cm 以内）、向き（ヨー）も合う
//   - 相手が正しい相対位置に見える（ピアの表示位置 = 相手の置いた位置）
//   - 発射が着弾して得点が入る（練習）。俯瞰画面の一覧に「トラッカー ID n」が出る
//   - トラッカーがゴーグルを見失うと最後の位置を保持し HUD に "tracked (x.xs ago)"、また見えれば復帰する
//   - 対戦開始 → 試合 → 途中終了 → 結果を閉じる（08 と同じ進行）
//   - 例外が出ていない
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
// 別の worktree で同時に走らせるときは PORT / CDP_PORT で変える
const PORT = Number(process.env.PORT ?? "") || 5197;
const CDP_PORT = Number(process.env.CDP_PORT ?? "") || 9342;
/** 原点を確定してから練習の HUD を読むまでの待ち [s]（発射 2〜3 回） */
const WAIT_SEC = Number(process.env.WAIT_SEC ?? "") || 12;
/** 対戦開始を押してから試合中の HUD を読むまでの待ち [s] */
const PLAY_WAIT_SEC = Number(process.env.PLAY_WAIT_SEC ?? "") || 10;
const BASE = `https://localhost:${PORT}/demos/08-3-splatoon-outside-in/`;
const MARKER_MM = 150;
const TRACK_MARKER_MM = 100;
const COMMON = `fov=70&camZoom=1&fakecam=1&autostart=1&fakehands=1&handSmooth=1&room=check&waitSec=1&markerMm=${MARKER_MM}`;
const OVERVIEW = `${BASE}overview.html?room=check&waitSec=1&markerMm=${MARKER_MM}`;
// トラッカー: フェイクカメラは正面の壁の原点マーカーの 0.5m 上・0.2m 手前から部屋を 35° 見下ろす（水平 FOV 68° に 2 人とも入る）。床のマーカー（ID 1、(0,-1.2,1.25)）で原点合わせ。
// ゴーグル: p1 = ID 10 が (-0.5, 0, 1.5) で正面（ヨー 0）、p2 = ID 11 が (0.5, 0, 1.5) で 15° 左を向く
const P1_POS = [-0.5, 0, 1.5];
const P2_POS = [0.5, 0, 1.5];
const P2_YAW_DEG = 15;
const TRACKER = `${OVERVIEW}&tracker=1&fakecam=1&trackMarkerMm=${TRACK_MARKER_MM}&fakeTrackCam=0,0.5,0.2,180,35&fakePlayers=10:${P1_POS.join(",")},0;11:${P2_POS.join(",")},${P2_YAW_DEG}`;

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
const dist = (a, b) => (a && b ? Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) : Infinity);

const server = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], { stdio: ["ignore", "pipe", "pipe"] });
server.stderr.on("data", (d) => process.stderr.write(d));
const landings = [];
const serverLines = [];
server.stdout.on("data", (d) => {
  for (const line of d.toString().split("\n")) {
    if (!line.startsWith("[splatoon-oi]")) continue;
    serverLines.push(line);
    const m = line.match(/^\[splatoon-oi\] (p\d+) shot #\d+: (\S+)/);
    if (m) landings.push({ by: m[1], where: m[2] });
    else console.log(line);
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

/** スマホの HUD */
function parseHud(hud) {
  const g = hud.match(/game: phase=(\S+) left=(\S+) color=(\S+) players=(\S*) scores=(\S*) total=(\d+) shots=(\d+)\/(\d+)/);
  const scores = {};
  for (const m of (g?.[5] ?? "").matchAll(/(p\d+):(\d+)/g)) scores[m[1]] = Number(m[2]);
  const self = hud.match(/self=\(([^)]*)\)/)?.[1].split(",").map(Number);
  const track = hud.match(/track=(.*?) layout=/)?.[1] ?? "";
  return {
    me: hud.match(/\bme=(\S+)/)?.[1] ?? "-",
    track,
    trackId: Number(track.match(/^id=(\d+)/)?.[1] ?? -1),
    quality: Number(track.match(/\bq=([\d.]+)/)?.[1] ?? NaN),
    yawDeg: Number(track.match(/\byaw=(-?[\d.]+)deg/)?.[1] ?? NaN),
    phiDeg: Number(track.match(/\bphi=(-?[\d.]+)deg/)?.[1] ?? NaN),
    holding: /holding last pose/.test(hud),
    agoSec: Number(track.match(/tracked \(([\d.]+)s ago\)/)?.[1] ?? NaN),
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

/** 俯瞰画面の HUD */
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
    markers: hud.match(/\bmarkers=(\S+)/)?.[1] ?? "",
    markersSent: Number(hud.match(/markersSent=(\d+)/)?.[1] ?? -1),
    /** 各プレイヤーの割当と状態（"p1:10:ok,p2:11:lost" → {p1: ["10","ok"], ...}） */
    peerTrack: Object.fromEntries((hud.match(/peerTrack=(\S*)/)?.[1] ?? "").split(",").filter(Boolean).map((e) => {
      const [id, marker, state] = e.split(":");
      return [id, [marker, state]];
    })),
    tracker: hud.match(/\btracker=(\S+)/)?.[1] ?? "",
    tracked: Number(hud.match(/\btracked=(\d+)/)?.[1] ?? -1),
    local: hud.match(/\blocal=(\S+)/)?.[1] ?? "",
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
  const first = targets.find((t) => t.type === "page");
  const version = await cdpJson("/json/version");
  const browser = new Page(version.webSocketDebuggerUrl, "browser");
  await browser.ready();
  const newWindow = async (name) => {
    const created = await browser.send("Target.createTarget", { url: "about:blank", newWindow: true });
    const t = (await cdpJson("/json")).find((x) => x.id === created.result.targetId);
    return openPage(t, name);
  };
  // 俯瞰画面を先に開く（トラッカーの前に床のマーカーの配置を配る）
  const p3 = await openPage(first, "overview");
  await p3.send("Page.navigate", { url: OVERVIEW });
  const p1 = await newWindow("1");
  await p1.send("Page.navigate", { url: `${BASE}?${COMMON}&name=One` });
  const p2 = await newWindow("2");
  await p2.send("Page.navigate", { url: `${BASE}?${COMMON}&name=Two` });

  const readHud = async (p) => parseHud((await p.eval("document.querySelector('#hud')?.textContent")) ?? "");
  const readOverview = async (p = p3) => parseOverviewHud((await p.eval("document.querySelector('#hud')?.textContent")) ?? "");
  const show = (h) => `me=${h.me} track=${h.track} self=${JSON.stringify(h.self)} phase=${h.phase} color=${h.color} players=${h.players.join("|")} scores=${JSON.stringify(h.scores)}/${h.total} shots=${h.sent}/${h.accepted}`;

  const t0 = Date.now();
  while (Date.now() - t0 < 40000) {
    const [h1, h2, ov] = await Promise.all([readHud(p1), readHud(p2), readOverview()]);
    if (h1.me.startsWith("p") && h2.me.startsWith("p") && ov.players.length === 2) break;
    await sleep(500);
  }
  console.log(`両ウィンドウの入室まで ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  await sleep(3000);

  // ---- トラッカー待ち: 位置が来るまで撃てない ----
  const w1 = await readHud(p1);
  const w2 = await readHud(p2);
  const wOv = await readOverview();
  console.log(`waiting window1: ${show(w1)}`);
  console.log(`waiting window2: ${show(w2)}`);
  console.log(`waiting overview: players=${wOv.players.join("|")} peerTrack=${JSON.stringify(wOv.peerTrack)} tracker=${wOv.tracker}`);
  check("両方が同じ room に入り 2 人になっている", w1.players.length === 2 && w2.players.length === 2);
  check("個人戦: 別の色が割り当たっている", w1.color > 0 && w2.color > 0 && w1.color !== w2.color, `${w1.color} vs ${w2.color}`);
  check("トラッカーが居ない間は HUD が track=no-tracker で、位置が無いので撃たない（pose も送らない）", w1.track === "no-tracker" && w2.track === "no-tracker" && w1.sent === 0 && w2.sent === 0 && w1.self === null, `${w1.track} shots=${w1.sent}`);
  const waitMsg = await p1.eval("document.querySelector('#hud')?.textContent") ?? "";
  check("俯瞰画面の一覧は各プレイヤーに入室順のマーカー ID（p1 → 10、p2 → 11）を「トラッカー待ち」で出す", wOv.peerTrack[w1.me]?.[0] === "10" && wOv.peerTrack[w2.me]?.[0] === "11" && wOv.peerTrack[w1.me]?.[1] === "wait" && wOv.tracker === "0/unlocked", JSON.stringify(wOv.peerTrack));
  const listText = await p3.eval("document.querySelector('#players')?.textContent");
  check("俯瞰画面のプレイヤー一覧に「位置合わせ: トラッカー待ち（ID 10）」の行がある", /位置合わせ: トラッカー待ち（ID 10）/.test(listText ?? ""), (listText ?? "").slice(0, 120));
  void waitMsg;

  // ---- 床のマーカーの配置を配る（トラッカーの原点合わせ用。カメラは壁側から部屋を向くので正面の壁のマーカーは見えない）----
  const setRows = await p3.eval(`(() => {
    const rows = document.querySelectorAll('#marker-rows .row');
    const set = (row, vals) => {
      const cb = row.querySelector('input[type=checkbox]');
      cb.checked = true;
      cb.dispatchEvent(new Event('change'));
      const nums = row.querySelectorAll('input[type=number]');
      vals.forEach((v, i) => { if (v !== null) { nums[i].value = String(v); nums[i].dispatchEvent(new Event('input')); } });
      return !cb.disabled;
    };
    return [set(rows[0], [1, 0, null, 1.25])];
  })()`);
  check("練習中は追加マーカーの行が有効", Array.isArray(setRows) && setRows[0] === true, JSON.stringify(setRows));
  await sleep(300);
  await p3.eval("document.querySelector('#apply-markers').click()");
  await sleep(2000);
  const mkOv = await readOverview();
  const mk1 = await readHud(p1);
  check("床のマーカー（ID 1）の配置が全員に届く", mkOv.markers === "1:floor" && mk1.layout === "1:floor" && mkOv.markersSent === 1, `${mkOv.markers} / ${mk1.layout}`);

  // ---- トラッカーのウィンドウ（俯瞰画面 + ?tracker=1&fakecam=1）----
  const p4 = await newWindow("tracker");
  await p4.send("Page.navigate", { url: TRACKER });
  const t4 = Date.now();
  let tOv = await readOverview(p4);
  while (Date.now() - t4 < 40000 && !/^on\/unlocked\/origin=1\//.test(tOv.local)) {
    await sleep(500);
    tOv = await readOverview(p4);
  }
  console.log(`tracker: local=${tOv.local} tracker=${tOv.tracker} (${((Date.now() - t4) / 1000).toFixed(1)}s)`);
  check("トラッカーがカメラを開き、フェイクカメラの床のマーカー（ID 1）を原点候補として見ている", /^on\/unlocked\/origin=1\//.test(tOv.local), tOv.local);
  const c1 = await readHud(p1);
  check("トラッカーが接続すると全員の HUD が track=unlocked（原点未確定）になり、まだ撃たない", c1.track === "unlocked" && c1.sent === 0, `${c1.track} shots=${c1.sent}`);
  // パネルは 250ms ごとに描き直すので、原点が見えてからボタンが有効になるまで少し待つ
  const readLockButton = () => p4.eval("(() => { const b = document.querySelector('#tracker-lock'); return b && !b.disabled ? b.textContent : null; })()");
  let lockEnabled = await readLockButton();
  const tLock = Date.now();
  while (lockEnabled === null && Date.now() - tLock < 5000) {
    await sleep(200);
    lockEnabled = await readLockButton();
  }
  check("原点マーカーが見えていると「原点を確定」が押せる", lockEnabled === "原点を確定", String(lockEnabled));
  // 確定は直近のサンプルの平均なので、数フレームぶん溜まってから押す（フェイクカメラは 10fps）
  await sleep(1200);
  await p4.eval("document.querySelector('#tracker-lock').click()");
  await sleep(500);
  const lockedText = await p4.eval("document.querySelector('#tracker-lock')?.textContent");
  check("確定後はボタンが「原点を解除」になる", lockedText === "原点を解除", String(lockedText));
  check("トラッカーが原点の確定をログに出す（サンプルの平均・カメラの位置）", p4.logs.some((l) => /\[tracker\] origin locked from \d+ samples: cam at \(-?0\.0\d,0\.[45]\d,0\.[12]\d\)/.test(l)), p4.logs.filter((l) => l.startsWith("[tracker]")).slice(-1).join(" | "));

  // ---- 位置が届く → 撃てる → 得点 ----
  const tp = Date.now();
  let h1 = await readHud(p1);
  let h2 = await readHud(p2);
  while (Date.now() - tp < 30000 && !(h1.trackId === 10 && h2.trackId === 11 && h1.accepted >= 3 && h2.accepted >= 3)) {
    await sleep(500);
    h1 = await readHud(p1);
    h2 = await readHud(p2);
  }
  await sleep(Math.max(0, WAIT_SEC * 1000 - (Date.now() - tp)));
  h1 = await readHud(p1);
  h2 = await readHud(p2);
  const hOv = await readOverview();
  const tOv2 = await readOverview(p4);
  console.log(`practice window1: ${show(h1)}`);
  console.log(`practice window2: ${show(h2)}`);
  console.log(`practice overview: peerTrack=${JSON.stringify(hOv.peerTrack)} tracker=${hOv.tracker} tracked=${hOv.tracked}`);
  console.log(`practice tracker: local=${tOv2.local}`);
  check("両方の位置がサーバーから届いている（HUD の track=id=10 / 11、品質あり）", h1.trackId === 10 && h2.trackId === 11 && h1.quality > 0 && h2.quality > 0 && !h1.holding && !h2.holding, `${h1.track} / ${h2.track}`);
  check("ウィンドウ 1 の自分の位置（self）がゴーグルを置いた位置 (-0.5,0,1.5) に 5cm 以内", dist(h1.self, P1_POS) < 0.05, `self=${JSON.stringify(h1.self)} err=${dist(h1.self, P1_POS).toFixed(3)}m`);
  check("ウィンドウ 2 の自分の位置（self）がゴーグルを置いた位置 (0.5,0,1.5) に 5cm 以内", dist(h2.self, P2_POS) < 0.05, `self=${JSON.stringify(h2.self)} err=${dist(h2.self, P2_POS).toFixed(3)}m`);
  check("トラッカーのヨーが置いた向き（p1 = 0°、p2 = 15°）に 2° 以内で届く", Math.abs(h1.yawDeg - 0) <= 2 && Math.abs(h2.yawDeg - P2_YAW_DEG) <= 2, `yaw1=${h1.yawDeg} yaw2=${h2.yawDeg}`);
  const fwd1 = await p1.eval("window.__outsideIn?.selfForward()");
  const fwd2 = await p2.eval("window.__outsideIn?.selfForward()");
  const yawOf = (f) => (Array.isArray(f) ? (Math.atan2(-f[0], -f[2]) * 180) / Math.PI : NaN);
  check("自分の正面を field 座標系に直すとトラッカーのヨーと一致する（ヨーの補正 φ が効いている）", Math.abs(yawOf(fwd1) - 0) <= 2 && Math.abs(yawOf(fwd2) - P2_YAW_DEG) <= 2, `fwd1=${yawOf(fwd1).toFixed(1)}° fwd2=${yawOf(fwd2).toFixed(1)}°`);
  const peers1 = await p1.eval("window.__outsideIn?.peers()");
  const peers2 = await p2.eval("window.__outsideIn?.peers()");
  check("ウィンドウ 1 から見た相手（p2）の表示位置が相手のゴーグルの位置 (0.5,0,1.5) に 5cm 以内（相対位置が合う）", dist(peers1?.[h2.me], P2_POS) < 0.05, `peer=${JSON.stringify(peers1?.[h2.me])}`);
  check("ウィンドウ 2 から見た相手（p1）の表示位置が (-0.5,0,1.5) に 5cm 以内", dist(peers2?.[h1.me], P1_POS) < 0.05, `peer=${JSON.stringify(peers2?.[h1.me])}`);
  check("入室直後は練習（practice）で、俯瞰画面もそう見えている", h1.phase === "practice" && h2.phase === "practice" && hOv.phase === "practice");
  check("練習中に連射が送られ受理されている（位置が届いたので撃てる）", h1.sent >= 3 && h1.accepted >= 3 && h2.accepted >= 3, `${h1.sent}/${h1.accepted}, ${h2.sent}/${h2.accepted}`);
  check("練習中の塗りが得点に出る", (h1.scores[h1.me] ?? 0) > 0 && (h2.scores[h2.me] ?? 0) > 0, JSON.stringify(h1.scores));
  const hits = landings.filter((l) => l.where !== "miss");
  check("着弾のほとんどが壁か床に当たっている（外れが半分未満）", landings.length >= 4 && hits.length > landings.length / 2, `${hits.length}/${landings.length} hit`);
  check("俯瞰画面の一覧が両プレイヤーを「トラッカー ID 10 / 11」で追跡中と出す", hOv.peerTrack[h1.me]?.[0] === "10" && hOv.peerTrack[h1.me]?.[1] === "ok" && hOv.peerTrack[h2.me]?.[1] === "ok" && hOv.tracker === "1/locked" && hOv.tracked > 10, JSON.stringify(hOv.peerTrack));
  const listText2 = await p3.eval("document.querySelector('#players')?.textContent");
  check("俯瞰画面のプレイヤー一覧に「位置合わせ: トラッカー ID 10 q=」の行がある", /位置合わせ: トラッカー ID 10 q=0\.\d+/.test(listText2 ?? ""), (listText2 ?? "").slice(0, 160));
  check("サーバーがプレイヤーにマーカー 10 / 11 を割り当てたと記録している", serverLines.some((l) => /"One" color \d marker 10/.test(l)) && serverLines.some((l) => /"Two" color \d marker 11/.test(l)));
  check("トラッカーのウィンドウは俯瞰 + トラッカーの 2 本の接続を持つ（HUD の local= に sent=）", /sent=\d+/.test(tOv2.local) && Number(tOv2.local.match(/sent=(\d+)/)?.[1]) > 10, tOv2.local);

  // ---- 見失い: p2 のゴーグルを隠す → 最後の位置を保持し HUD に "tracked (x.xs ago)"。撃ち続けられる。再び見えれば復帰 ----
  await p4.eval("window.__fakeTrack.hidden.add(11)");
  await sleep(3000);
  const lost2 = await readHud(p2);
  const lost1 = await readHud(p1);
  console.log(`hidden window2: ${show(lost2)} holding=${lost2.holding} ago=${lost2.agoSec}`);
  check("隠すとウィンドウ 2 は最後の位置を保持し HUD に tracked (x.xs ago)・holding last pose が出る", lost2.holding && lost2.agoSec >= 2 && dist(lost2.self, P2_POS) < 0.05, `${lost2.track} self=${JSON.stringify(lost2.self)}`);
  check("隠している間もウィンドウ 1 は追跡が続く", !lost1.holding && lost1.trackId === 10, lost1.track);
  const ovLost = await readOverview();
  check("俯瞰画面の一覧はウィンドウ 2 を「見失い」と出す", ovLost.peerTrack[h2.me]?.[1] === "lost" && ovLost.peerTrack[h1.me]?.[1] === "ok", JSON.stringify(ovLost.peerTrack));
  check("見失っている間も最後の位置から撃てて受理される", lost2.accepted > h2.accepted, `${h2.accepted} → ${lost2.accepted}`);
  await p4.eval("window.__fakeTrack.hidden.delete(11)");
  await sleep(1500);
  const back2 = await readHud(p2);
  check("再び見えると復帰する（holding が消える）", !back2.holding && back2.trackId === 11 && dist(back2.self, P2_POS) < 0.05, back2.track);

  // ---- 対戦開始 → 試合 → 途中終了 → 結果を閉じる（08 と同じ進行）----
  await p3.eval("document.querySelector('#start-match').click()");
  await sleep(PLAY_WAIT_SEC * 1000);
  const play1 = await readHud(p1);
  const play2 = await readHud(p2);
  const playOv = await readOverview();
  console.log(`play window1: ${show(play1)}`);
  console.log(`play window2: ${show(play2)}`);
  check("俯瞰画面の start が送られ、試合（play）になっている", playOv.starts === 1 && play1.phase === "play" && play2.phase === "play" && playOv.phase === "play");
  check("試合中も両プレイヤーが得点している（着弾と塗りが field 座標で合っている）", (play1.scores[play1.me] ?? 0) > 0 && (play2.scores[play2.me] ?? 0) > 0, JSON.stringify(play1.scores));
  const diff = Object.keys({ ...play1.scores, ...play2.scores }).reduce((a, k) => a + Math.abs((play1.scores[k] ?? 0) - (play2.scores[k] ?? 0)), 0);
  check("両ウィンドウの HUD でほぼ同じ得点が見えている（権威状態の配信）", diff <= Math.max(200, play1.total * 0.02), `${JSON.stringify(play1.scores)} vs ${JSON.stringify(play2.scores)}`);
  check("試合中も位置の追跡が続いている", !play1.holding && !play2.holding && dist(play1.self, P1_POS) < 0.05, `${play1.track}`);
  await p3.eval("document.querySelector('#stop-match').click()");
  await sleep(1500);
  const st1 = await readHud(p1);
  const stOv = await readOverview();
  check("「対戦を終了」で結果（result）になる", stOv.stops === 1 && st1.phase === "result" && stOv.phase === "result");
  await p3.eval("document.querySelector('#stop-match').click()");
  await sleep(1500);
  const dm1 = await readHud(p1);
  const dmOv = await readOverview();
  check("「結果を閉じる」で練習に戻る", dmOv.dismisses === 1 && dm1.phase === "practice" && dmOv.phase === "practice");
  check("例外が出ていない", [p1, p2, p3, p4].every((p) => p.exceptions.length === 0), [p1, p2, p3, p4].flatMap((p) => p.exceptions).slice(0, 2).join(" | "));
  for (const l of p1.logs.filter((l) => l.startsWith("[game] joined")).slice(0, 1)) console.log(`window1 log: ${l}`);
  for (const l of p4.logs.filter((l) => l.startsWith("[tracker]")).slice(0, 3)) console.log(`tracker log: ${l}`);

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
