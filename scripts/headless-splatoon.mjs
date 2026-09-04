// demos/08-splatoon のブラウザ経路（マーカー → field 座標変換・手の形（グー → パー）からの発射・
// サーバーの着弾と格子 → 2 ウィンドウで同じ得点）をヘッドレス Chrome で確認する。
// `npm run check:splatoon` で実行する。仕組みは headless-darts.mjs と同じ（CDP を ws で直接叩く。
// Chrome が無ければスキップ）。
//
// 確認内容: フェイクカメラ（マーカー入り。2 つ目はマーカーの位置をずらす）+ 合成の手（パー → グーを繰り返す）で
// 2 つのウィンドウを同じ room に入れ、3 つ目のウィンドウで俯瞰画面（overview.html）を開いて、
//   - 両方でマーカーが検出されている
//   - 入室直後は練習（practice）で、両方の発射が受理されて得点が入る（issue #20「入室したら自由に塗れる」）
//   - 俯瞰画面の「対戦開始」を押すと（issue #19 / #21）カウントダウン → 試合（play）になり、練習の塗りは消えて得点が入り直す
//   - 両ウィンドウと俯瞰画面の HUD で同じ得点が見えている（権威状態の配信）
//   - インクタンクが手元（合成の手のそば）に出ている（issue #31。合成の手が消える休みの間は視界の下）
//   - マルチマーカー（issue #30）: 俯瞰画面で追加マーカーの配置（床 ID 1・正面 2 枚目 ID 5）を配ると、
//     ウィンドウ 1 は 2 枚同時に使い（spread が小さい）、原点マーカーを隠しても ID 5 だけで位置が変わらず追跡が続く。
//     床のマーカーしか見えない 4 つ目のウィンドウ（見下ろすフェイクカメラ）も位置合わせできて入室・発射できる
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
/** ページを開いてから練習の HUD を読むまでの待ち [s]（起動 + 発射 2〜3 回） */
const WAIT_SEC = Number(process.env.WAIT_SEC ?? "") || 14;
/** 対戦開始を押してから試合中の HUD を読むまでの待ち [s]（カウントダウン 1s + 発射 3〜4 回） */
const PLAY_WAIT_SEC = Number(process.env.PLAY_WAIT_SEC ?? "") || 12;
const BASE = `https://localhost:${PORT}/demos/08-splatoon/`;
// tankHoldMs=0: 合成の手が消える約 200ms の間にタンクが視界の下へ移るのを見るため（既定 800ms の猶予は切る）
const COMMON =
  "fov=70&camZoom=1&fakecam=1&autostart=1&fakehands=1&fakeMarkerPx=80&handSmooth=1&room=check&waitSec=1&tankHoldMs=0";
const OVERVIEW = `${BASE}overview.html?room=check&waitSec=1`;

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
const serverLines = [];
server.stdout.on("data", (d) => {
  for (const line of d.toString().split("\n")) {
    if (!line.startsWith("[splatoon]")) continue;
    serverLines.push(line);
    const m = line.match(/^\[splatoon\] (p\d+) shot #\d+: (\S+)/);
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
  const self = hud.match(/self=\(([^)]*)\)/)?.[1].split(",").map(Number);
  return {
    me: hud.match(/\bme=(\S+)/)?.[1] ?? "-",
    marker: hud.match(/marker=(\S+)/)?.[1] ?? "",
    /** 位置合わせに使っている ID の集合（"id=0+5" → {0, 5}） */
    markerIds: new Set((hud.match(/marker=id=([\d+]+)/)?.[1] ?? "").split("+").filter(Boolean).map(Number)),
    spread: Number(hud.match(/spread=([\d.]+)m/)?.[1] ?? 0),
    tracking: /marker=id=/.test(hud) && !/holding last pose/.test(hud),
    layout: hud.match(/layout=(\S+)/)?.[1] ?? "",
    self: self && self.length === 3 && self.every(Number.isFinite) ? self : null,
    field: hud.match(/field=(\S+)/)?.[1] ?? "",
    tank: hud.match(/\btank=(\S+)/)?.[1] ?? "",
    phase: g?.[1] ?? "",
    color: g ? Number(g[3]) : 0,
    players: (g?.[4] ?? "").split(",").filter(Boolean),
    scores,
    total: g ? Number(g[6]) : 0,
    sent: g ? Number(g[7]) : -1,
    accepted: g ? Number(g[8]) : -1,
  };
}

/** 俯瞰画面の HUD（overview: room=check me=p3 ws=open phase=play left=170s players=p1:1,p2:2 scores=p1:12,p2:30 total=... starts=1） */
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
    field: hud.match(/field=(\S+)/)?.[1] ?? "",
    starts: Number(hud.match(/starts=(\d+)/)?.[1] ?? -1),
    stops: Number(hud.match(/stops=(\d+)/)?.[1] ?? -1),
    fields: Number(hud.match(/fields=(\d+)/)?.[1] ?? -1),
    markers: hud.match(/\bmarkers=(\S+)/)?.[1] ?? "",
    markersSent: Number(hud.match(/markersSent=(\d+)/)?.[1] ?? -1),
    /** 各プレイヤーが位置合わせに使っている ID（"p1:0+5,p2:0" → {p1: "0+5", p2: "0"}） */
    peerMarkers: Object.fromEntries((hud.match(/peerMarkers=(\S*)/)?.[1] ?? "").split(",").filter(Boolean).map((e) => e.split(":"))),
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
      // 追加のフラグ（root のコンテナでは CHROME_ARGS=--no-sandbox が要る）
      ...(process.env.CHROME_ARGS ?? "").split(" ").filter(Boolean),
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const targets = await cdpJson("/json");
  const first = targets.find((t) => t.type === "page");
  const p1 = await openPage(first, "1");
  // ウィンドウ 1 のフェイクカメラには正面の壁の 2 枚目（ID 5、原点の右 0.25m）も映す（配置が配られるまでは無視される）
  await p1.send("Page.navigate", { url: `${BASE}?${COMMON}&name=One&fakeMarkers=5:wall:0.25,0,0` });
  const version = await cdpJson("/json/version");
  const browser = new Page(version.webSocketDebuggerUrl, "browser");
  await browser.ready();
  const created = await browser.send("Target.createTarget", { url: "about:blank", newWindow: true });
  const t2 = (await cdpJson("/json")).find((t) => t.id === created.result.targetId);
  const p2 = await openPage(t2, "2");
  await p2.send("Page.navigate", { url: `${BASE}?${COMMON}&name=Two&fakeShift=40` });
  // 俯瞰画面（PC 用。カメラ無し）。同じ room に role=overview で入る
  const created3 = await browser.send("Target.createTarget", { url: "about:blank", newWindow: true });
  const t3 = (await cdpJson("/json")).find((t) => t.id === created3.result.targetId);
  const p3 = await openPage(t3, "3");
  await p3.send("Page.navigate", { url: OVERVIEW });

  const readHud = async (p) => parseHud((await p.eval("document.querySelector('#hud')?.textContent")) ?? "");
  // 3 ページの起動は CPU 次第で数秒ずれる（並走する他のテストや初回のシェーダ構築）。固定の待ちだけだと
  // 遅い方のウィンドウが入室前で HUD が空のまま読んでしまうので、両方が入室してマーカーを検出するまで先に待つ
  const t0 = Date.now();
  while (Date.now() - t0 < 40000) {
    const [h1, h2] = await Promise.all([readHud(p1), readHud(p2)]);
    if (h1.me.startsWith("p") && h2.me.startsWith("p") && h1.marker.startsWith("id=") && h2.marker.startsWith("id=")) break;
    await sleep(500);
  }
  console.log(`両ウィンドウの入室 + マーカー検出まで ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  await sleep(WAIT_SEC * 1000);

  const readOverview = async () => parseOverviewHud((await p3.eval("document.querySelector('#hud')?.textContent")) ?? "");
  const show = (h) => `me=${h.me} marker=${h.marker} phase=${h.phase} color=${h.color} players=${h.players.join("|")} scores=${JSON.stringify(h.scores)}/${h.total} shots=${h.sent}/${h.accepted}`;
  const showOv = (h) => `me=${h.me} ws=${h.ws} phase=${h.phase} players=${h.players.join("|")} scores=${JSON.stringify(h.scores)} starts=${h.starts}`;

  // ---- 練習（入室直後）----
  const pr1 = await readHud(p1);
  const pr2 = await readHud(p2);
  const prOv = await readOverview();
  console.log(`practice window1: ${show(pr1)}`);
  console.log(`practice window2: ${show(pr2)}`);
  console.log(`practice overview: ${showOv(prOv)}`);
  check("両ウィンドウでマーカーが検出されている", pr1.marker.startsWith("id=") && pr2.marker.startsWith("id="));
  check("両方が同じ room に入り 2 人になっている", pr1.players.length === 2 && pr2.players.length === 2);
  check("個人戦: 別の色が割り当たっている", pr1.color > 0 && pr2.color > 0 && pr1.color !== pr2.color, `${pr1.color} vs ${pr2.color}`);
  check("入室直後は練習（practice）で、俯瞰画面もそう見えている", pr1.phase === "practice" && pr2.phase === "practice" && prOv.phase === "practice");
  check("練習中に連射が送られ受理されている（入室したら自由に塗れる）", pr1.sent >= 3 && pr1.accepted >= 3 && pr2.accepted >= 3, `${pr1.sent}/${pr1.accepted}, ${pr2.sent}/${pr2.accepted}`);
  check("練習中の塗りが得点に出る", (pr1.scores[pr1.me] ?? 0) > 0 && (pr2.scores[pr2.me] ?? 0) > 0, JSON.stringify(pr1.scores));
  check("俯瞰画面はプレイヤーではなく（players に含まれない）、2 人を見ている", prOv.me.startsWith("p") && !pr1.players.some((p) => p.startsWith(prOv.me + ":")) && prOv.players.length === 2, `${prOv.me} / ${prOv.players.join("|")}`);
  // 合成の手は 5s 周期で 0.5s 消えるが、手の表示は handLostMs（300ms）残るので view になるのは約 200ms だけ（tankHoldMs=0 のとき）。
  // 周期（5s）の倍数の間隔で読むと位相によっては毎回外すので、100ms 間隔で 2 周期ぶん追って両方を見る
  const tankPlaces = new Set();
  for (let i = 0; i < 120 && !(tankPlaces.has("hand") && tankPlaces.has("view")); i++) {
    tankPlaces.add((await readHud(p1)).tank);
    await sleep(100);
  }
  check("インクタンクが手元（合成の手のそば）に出ている", tankPlaces.has("hand"), [...tankPlaces].join(","));
  check("合成の手が消えている間は視界の下に出る", tankPlaces.has("view"), [...tankPlaces].join(","));
  const buttonEnabled = await p3.eval("(() => { const b = document.querySelector('#start-match'); return b && !b.disabled; })()");
  check("俯瞰画面の「対戦開始」が押せる状態", buttonEnabled === true);
  check("寸法は URL に無く、既定（3x2.4x2.5、マーカー 1.2）で全員が一致している", pr1.field === "3x2.4x2.5/1.2" && pr2.field === "3x2.4x2.5/1.2" && prOv.field === "3x2.4x2.5/1.2", `${pr1.field} / ${pr2.field} / ${prOv.field}`);

  // ---- 塗れる空間の大きさとマーカーの高さを俯瞰画面で変える（練習中。入力欄 → 反映）----
  const setSize = (id, v) => p3.eval(`(() => { const i = document.querySelector('#size-${id}'); i.value = '${v}'; i.dispatchEvent(new Event('input')); return !i.disabled; })()`);
  const editable = await Promise.all([setSize("wallW", 2), setSize("wallH", 1.5), setSize("floorDepth", 4), setSize("floorDrop", 1)]);
  check("練習中は寸法の入力欄が有効", editable.every(Boolean));
  await sleep(300);
  const applyEnabled = await p3.eval("(() => { const b = document.querySelector('#apply-size'); return b && !b.disabled; })()");
  check("値を変えると「反映」が押せる", applyEnabled === true);
  await p3.eval("document.querySelector('#apply-size').click()");
  await sleep(4000);
  const sz1 = await readHud(p1);
  const sz2 = await readHud(p2);
  const szOv = await readOverview();
  console.log(`resized window1: ${show(sz1)} field=${sz1.field}`);
  console.log(`resized overview: ${showOv(szOv)} field=${szOv.field} total=${szOv.total}`);
  check("反映で全員（俯瞰画面も）の寸法が 2x1.5x4、マーカーの高さ 1 になる", sz1.field === "2x1.5x4/1" && sz2.field === "2x1.5x4/1" && szOv.field === "2x1.5x4/1" && szOv.fields === 1, `${sz1.field} / ${sz2.field} / ${szOv.field}`);
  check("寸法の変更でセル数が変わり、練習のまま", szOv.total !== pr1.total && sz1.phase === "practice" && szOv.phase === "practice", `${pr1.total} → ${szOv.total}`);
  check("変更後も連射が受理され、新しいフィールドに塗れている", sz1.accepted > pr1.accepted && (sz1.scores[sz1.me] ?? 0) > 0, `${pr1.accepted} → ${sz1.accepted}, ${JSON.stringify(sz1.scores)}`);
  check("サーバーが field → 2x1.5x4/1 を記録している", serverLines.some((l) => /field → 2x1\.5x4\/1 /.test(l)));
  const hint = await p3.eval("document.querySelector('#size-hint')?.textContent");
  check("入力欄がサーバーの値に揃い、いまの寸法が表示される", /2m × 高さ 1\.5m × 奥行き 4m、マーカーの高さ 1m/.test(hint ?? ""), hint);

  // ---- マルチマーカー（issue #30）: 俯瞰画面で追加マーカーの配置を配る ----
  check("配置を配る前は原点マーカーだけで位置合わせしている（映っている ID 5 は無視）", sz1.markerIds.size === 1 && sz1.markerIds.has(0) && sz1.layout === "-", `${sz1.marker} layout=${sz1.layout}`);
  const selfBefore = sz1.self;
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
    // 行 0 = 床（ID 1。Y は床の高さ -1 に自動）: 壁から 0.6m。行 4 = 正面 2 枚目（ID 5）: 右 0.25m
    return [set(rows[0], [1, 0, null, 0.6]), set(rows[4], [5, 0.25, 0, 0]), rows.length];
  })()`);
  check("練習中は追加マーカーの行が有効（上限の 8 行）", Array.isArray(setRows) && setRows[0] === true && setRows[1] === true && setRows[2] === 8, JSON.stringify(setRows));
  await sleep(300);
  const applyMarkersEnabled = await p3.eval("(() => { const b = document.querySelector('#apply-markers'); return b && !b.disabled; })()");
  check("行を変えると配置の「反映」が押せる", applyMarkersEnabled === true);
  await p3.eval("document.querySelector('#apply-markers').click()");
  await sleep(3000);
  const mk1 = await readHud(p1);
  const mk2 = await readHud(p2);
  const mkOv = await readOverview();
  console.log(`markers window1: ${show(mk1)} marker=${mk1.marker} layout=${mk1.layout} self=${JSON.stringify(mk1.self)}`);
  console.log(`markers overview: markers=${mkOv.markers} peerMarkers=${JSON.stringify(mkOv.peerMarkers)}`);
  check("反映で全員に配置（床 1・正面 5）が届く（HUD の layout / 俯瞰画面の markers）", mk1.layout === "1:floor,5:wall" && mk2.layout === "1:floor,5:wall" && mkOv.markers === "1:floor,5:wall" && mkOv.markersSent === 1, `${mk1.layout} / ${mk2.layout} / ${mkOv.markers}`);
  check("サーバーが markers → 1:floor,5:wall を記録している", serverLines.some((l) => /markers → 1:floor,5:wall/.test(l)));
  check("ウィンドウ 1 は原点と ID 5 の 2 枚を同時に使って位置合わせしている", mk1.markerIds.size === 2 && mk1.markerIds.has(0) && mk1.markerIds.has(5), mk1.marker);
  check("2 枚から出した原点の位置のばらつき（spread）が 5cm 未満（配置と合成カメラの幾何が一致）", mk1.markerIds.size === 2 && mk1.spread < 0.05, `spread=${mk1.spread}`);
  check("配置を配っても塗りは消えず、練習のまま連射が受理され続けている", mk1.phase === "practice" && mk1.accepted > sz1.accepted && (mk1.scores[mk1.me] ?? 0) >= (sz1.scores[sz1.me] ?? 0), `${sz1.accepted} → ${mk1.accepted}`);
  check("俯瞰画面の一覧に各プレイヤーが使っているマーカーが出る（p1 は 0+5、p2 は 0）", /^(0\+5|5\+0)$/.test(mkOv.peerMarkers[mk1.me] ?? "") && mkOv.peerMarkers[mk2.me] === "0", JSON.stringify(mkOv.peerMarkers));
  const markerListText = await p3.eval("document.querySelector('#players')?.textContent");
  check("俯瞰画面のプレイヤー一覧に「位置合わせ: マーカー」の行がある", /位置合わせ: マーカー (0\+5|5\+0)/.test(markerListText ?? ""), (markerListText ?? "").slice(0, 120));
  // 原点マーカーを隠す → ID 5 だけで追跡が続き、位置（self）は変わらない
  await p1.eval("window.__fakeMarkers.hidden.add(0)");
  await sleep(1500);
  let hid1 = await readHud(p1);
  // 合成の手はパー → グー → 休みの周期（5 秒）なので、隠している間に連射が受理されるまで最大 1 周期ぶん待つ
  const tHide = Date.now();
  while (hid1.accepted <= mk1.accepted && Date.now() - tHide < 6000) {
    await sleep(300);
    hid1 = await readHud(p1);
  }
  console.log(`hidden-origin window1: marker=${hid1.marker} self=${JSON.stringify(hid1.self)} (before ${JSON.stringify(selfBefore)})`);
  check("原点マーカーを隠すと ID 5 だけで位置合わせが続く（ロストしない）", hid1.markerIds.size === 1 && hid1.markerIds.has(5) && hid1.tracking, hid1.marker);
  const selfDrift = selfBefore && hid1.self ? Math.hypot(...selfBefore.map((v, i) => v - hid1.self[i])) : Infinity;
  check("ID 5 だけになっても自分の位置（self）が 5cm 以上動かない", selfDrift < 0.05, `drift=${selfDrift.toFixed(3)}m`);
  check("原点が見えない間も連射が受理されている", hid1.accepted > mk1.accepted, `${mk1.accepted} → ${hid1.accepted}`);
  await p1.eval("window.__fakeMarkers.hidden.delete(0)");
  await sleep(1000);
  const back1 = await readHud(p1);
  check("原点マーカーが戻ると再び 2 枚で位置合わせする", back1.markerIds.size === 2 && back1.markerIds.has(0), back1.marker);
  // 床のマーカーしか見えない 4 つ目のウィンドウ（見下ろすフェイクカメラ。原点は描かない）。welcome の config.markers で配置を受け取る
  const created4 = await browser.send("Target.createTarget", { url: "about:blank", newWindow: true });
  const t4 = (await cdpJson("/json")).find((t) => t.id === created4.result.targetId);
  const p4 = await openPage(t4, "4");
  await p4.send("Page.navigate", { url: `${BASE}?${COMMON}&name=Four&fakeMarkers=1:floor:0,-1,0.6&fakeCamPos=0.15,-0.5,0.75&fakePitch=65&fakeHideOrigin=1` });
  const t4start = Date.now();
  let h4 = await readHud(p4);
  while (Date.now() - t4start < 40000 && !(h4.me.startsWith("p") && h4.marker.startsWith("id=") && h4.accepted >= 2)) {
    await sleep(500);
    h4 = await readHud(p4);
  }
  console.log(`floor-only window4: ${show(h4)} marker=${h4.marker} layout=${h4.layout} self=${JSON.stringify(h4.self)} (${((Date.now() - t4start) / 1000).toFixed(1)}s)`);
  check("床のマーカーだけで位置合わせできる（welcome の配置で ID 1 を受け付ける）", h4.markerIds.size === 1 && h4.markerIds.has(1) && h4.layout === "1:floor,5:wall", h4.marker);
  const self4err = h4.self ? Math.hypot(h4.self[0] - 0.15, h4.self[1] + 0.5, h4.self[2] - 0.75) : Infinity;
  check("床のマーカーから出した自分の位置がフェイクカメラの位置 (0.15,-0.5,0.75) に 8cm 以内で一致", self4err < 0.08, `self=${JSON.stringify(h4.self)} err=${self4err.toFixed(3)}m`);
  check("床のマーカーだけの端末も入室して連射が受理される", h4.me.startsWith("p") && h4.accepted >= 2 && h4.phase === "practice", `${h4.sent}/${h4.accepted}`);
  const ov4 = await readOverview();
  check("俯瞰画面でも 4 つ目の端末は床のマーカー（1）で位置合わせしていると見える", ov4.peerMarkers[h4.me] === "1", JSON.stringify(ov4.peerMarkers));

  // ---- 対戦開始（俯瞰画面のボタン）----
  await p3.eval("document.querySelector('#start-match').click()");
  await sleep(PLAY_WAIT_SEC * 1000);
  const hud1 = await readHud(p1);
  const hud2 = await readHud(p2);
  const hudOv = await readOverview();
  console.log(`play window1: ${show(hud1)}`);
  console.log(`play window2: ${show(hud2)}`);
  console.log(`play overview: ${showOv(hudOv)}`);
  check("俯瞰画面の start が送られ、試合（play）になっている", hudOv.starts === 1 && hud1.phase === "play" && hud2.phase === "play" && hudOv.phase === "play");
  check("試合の得点は練習の塗りが消えてから入り直している（練習より小さい）", (hud1.scores[hud1.me] ?? 0) > 0 && (hud1.scores[hud1.me] ?? 0) < (pr1.scores[pr1.me] ?? 0) + (hud1.sent - pr1.sent) * 200, JSON.stringify([pr1.scores, hud1.scores]));
  check("ウィンドウ 1 で連射が受理され続けている（形の判定 → 連射 → サーバー検証）", hud1.accepted > pr1.accepted, `${pr1.accepted} → ${hud1.accepted}`);
  check("ウィンドウ 2 でも連射が受理され続けている", hud2.accepted > pr2.accepted, `${pr2.accepted} → ${hud2.accepted}`);
  check("両プレイヤーが得点している（着弾と塗りが field 座標で合っている）", (hud1.scores[hud1.me] ?? 0) > 0 && (hud2.scores[hud2.me] ?? 0) > 0, JSON.stringify(hud1.scores));
  // 得点は 1 秒ごとの state で更新されるので、読み取りタイミングで少し違い得る
  const diff = Object.keys({ ...hud1.scores, ...hud2.scores }).reduce((a, k) => a + Math.abs((hud1.scores[k] ?? 0) - (hud2.scores[k] ?? 0)), 0);
  check("両ウィンドウの HUD でほぼ同じ得点が見えている（権威状態の配信）", diff <= Math.max(200, hud1.total * 0.02), `${JSON.stringify(hud1.scores)} vs ${JSON.stringify(hud2.scores)}`);
  const diffOv = Object.keys({ ...hud1.scores, ...hudOv.scores }).reduce((a, k) => a + Math.abs((hud1.scores[k] ?? 0) - (hudOv.scores[k] ?? 0)), 0);
  check("俯瞰画面でもほぼ同じ得点が見えている", diffOv <= Math.max(200, hud1.total * 0.02), `${JSON.stringify(hud1.scores)} vs ${JSON.stringify(hudOv.scores)}`);
  const hits = landings.filter((l) => l.where !== "miss");
  check("着弾のほとんどが壁か床に当たっている（外れが半分未満）", landings.length >= 6 && hits.length > landings.length / 2, `${hits.length}/${landings.length} hit`);
  check("サーバーが start → countdown 1s を記録している（?waitSec= が room 設定として届いている）", serverLines.some((l) => /start → countdown 1s/.test(l)));

  // ---- 途中終了（issue #32。俯瞰画面の「対戦を終了」）----
  const stopEnabled = await p3.eval("(() => { const b = document.querySelector('#stop-match'); return b && !b.disabled ? b.textContent : null; })()");
  check("試合中は俯瞰画面の「対戦を終了」が押せる", stopEnabled === "対戦を終了", String(stopEnabled));
  await p3.eval("document.querySelector('#stop-match').click()");
  await sleep(1500);
  const st1 = await readHud(p1);
  const stOv = await readOverview();
  console.log(`stopped window1: ${show(st1)}`);
  console.log(`stopped overview: ${showOv(stOv)} stops=${stOv.stops}`);
  check("「対戦を終了」で時間切れ（matchSec 既定 60 秒）を待たず結果（result）になる", stOv.stops === 1 && st1.phase === "result" && stOv.phase === "result");
  check("サーバーが stop → result を記録している", serverLines.some((l) => /stop → result/.test(l)));
  const stopDisabled = await p3.eval("(() => { const b = document.querySelector('#stop-match'); return b && b.disabled; })()");
  check("結果表示中は「対戦を終了」が押せない", stopDisabled === true);
  check("スマホ側にも result イベントが届いている（視界に「そこまで！」）", p1.logs.some((l) => /\[game\] event result phase=result/.test(l)));
  check("例外が出ていない", p1.exceptions.length === 0 && p2.exceptions.length === 0 && p3.exceptions.length === 0 && p4.exceptions.length === 0, [...p1.exceptions, ...p2.exceptions, ...p3.exceptions, ...p4.exceptions].slice(0, 2).join(" | "));
  for (const l of p1.logs.filter((l) => l.startsWith("[game] shot sent")).slice(0, 2)) console.log(`window1 log: ${l}`);
  for (const l of p3.logs.filter((l) => l.startsWith("[overview]")).slice(0, 4)) console.log(`overview log: ${l}`);

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
