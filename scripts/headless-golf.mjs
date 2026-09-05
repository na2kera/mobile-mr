// demos/10-golf のブラウザ経路（マーカー → field 座標変換・視線の交点・Joy-Con の振り → 1 打 → 転がり → カップイン →
// 手番交代 → ホール進行）をヘッドレス Chrome で確認する。`npm run check:golf` で実行する。
// 仕組みは headless-splatoon.mjs と同じ（CDP を ws で直接叩く。Chrome が無ければスキップ）。
//
// 確認内容: フェイクカメラ（正面 + 床のマーカー）のスマホ 2 台と、フェイク Joy-Con（?fakeJoycon=1）を繋いだ俯瞰画面を同じ room に入れて、
//   - 両方でマーカーが検出され、視線と床の交点（gaze）が取れている
//   - 手番は参加順（p1 → p2）。俯瞰画面のフェイク Joy-Con は「手番の人（自動）」なので p1 の番に振り、stroke が送られてカップイン
//   - スマホ 2 台目は ?fakeStroke=（自動で届く速さで打つ）でカップイン → 全員終了で次のホール（hole=2）
//   - 俯瞰画面で「A ボタン」相当の構え（address）が受理される（狙いが固定される）
//   - 俯瞰画面の「最初から」でホール 1 に戻る
//   - 例外が出ていない
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 5192;
const CDP_PORT = 9337;
const BASE = `https://localhost:${PORT}/demos/10-golf/`;
// パットは下を向くので、フェイクカメラは床のマーカー（ID 1。俯瞰画面から配る配置と一致させる）だけを見下ろす
// （正面のマーカーは視界の外）。640px の合成映像で検出できる大きさにするため markerMm=200（room 設定。全員一致）
const COMMON = "fov=70&camZoom=1&fakecam=1&autostart=1&room=check&markerMm=200&fakeMarkers=1:floor:0,-1.2,0.5&fakePitch=50";
const OVERVIEW = `${BASE}overview.html?room=check&markerMm=200&fakeJoycon=1&fakeSwingSec=1`;

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

const server = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], { stdio: ["ignore", "pipe", "pipe"] });
let portInUse = false;
server.stderr.on("data", (d) => {
  const s = d.toString();
  if (/already in use/i.test(s)) portInUse = true;
  process.stderr.write(s);
});
const serverLines = [];
server.stdout.on("data", (d) => {
  for (const line of d.toString().split("\n")) {
    if (!line.startsWith("[golf]")) continue;
    serverLines.push(line);
    console.log(line);
  }
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
  const g = hud.match(/game: phase=(\S+) hole=(\d+)\/(\d+) turn=(\S+) left=\S+ players=(\S*) balls=(\S*) cards=(\S*) strokes=(\d+)\/(\d+) addresses=(\d+) roll=(\S+)/);
  const balls = {};
  for (const m of (g?.[6] ?? "").matchAll(/(p\d+):(\d+)([hd]?)/g)) balls[m[1]] = { strokes: Number(m[2]), holed: m[3] === "h", done: m[3] !== "" };
  const cards = {};
  for (const m of (g?.[7] ?? "").matchAll(/(p\d+):([\d+-]+)/g)) cards[m[1]] = m[2];
  return {
    me: hud.match(/\bme=(\S+)/)?.[1] ?? "-",
    marker: hud.match(/marker=(\S+)/)?.[1] ?? "",
    markerIds: new Set((hud.match(/marker=id=([\d+]+)/)?.[1] ?? "").split("+").filter(Boolean).map(Number)),
    layout: hud.match(/layout=(\S+)/)?.[1] ?? "",
    gaze: hud.match(/gaze=\(([^)]*)\)/)?.[1] ?? null,
    putter: hud.match(/putter=(\S+)/)?.[1] ?? "",
    phase: g?.[1] ?? "",
    hole: g ? Number(g[2]) : 0,
    holes: g ? Number(g[3]) : 0,
    turn: g?.[4] ?? "",
    players: (g?.[5] ?? "").split(",").filter(Boolean),
    balls,
    cards,
    sent: g ? Number(g[8]) : -1,
    accepted: g ? Number(g[9]) : -1,
    addresses: g ? Number(g[10]) : -1,
    roll: g?.[11] ?? "",
  };
}
/** 俯瞰画面の HUD */
function parseOverviewHud(hud) {
  return {
    me: hud.match(/\bme=(\S+)/)?.[1] ?? "-",
    ws: hud.match(/ws=(\S+)/)?.[1] ?? "",
    phase: hud.match(/phase=(\S+)/)?.[1] ?? "",
    hole: Number(hud.match(/hole=(\d+)/)?.[1] ?? 0),
    turn: hud.match(/turn=(\S+)/)?.[1] ?? "",
    players: (hud.match(/players=(\S*)/)?.[1] ?? "").split(",").filter(Boolean),
    joycons: Number(hud.match(/joycons=(\d+)/)?.[1] ?? -1),
    assigned: hud.match(/assigned=(\S+)/)?.[1] ?? "",
    swings: Number(hud.match(/swings=(\d+)/)?.[1] ?? -1),
    strokesSent: Number(hud.match(/strokesSent=(\d+)/)?.[1] ?? -1),
    addresses: Number(hud.match(/addresses=(\d+)/)?.[1] ?? -1),
    restarts: Number(hud.match(/restarts=(\d+)/)?.[1] ?? -1),
    markers: hud.match(/\bmarkers=(\S+)/)?.[1] ?? "",
    peerMarkers: Object.fromEntries((hud.match(/peerMarkers=(\S*)/)?.[1] ?? "").split(",").filter(Boolean).map((e) => e.split(":"))),
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
  const newPage = async (name) => {
    const created = await browser.send("Target.createTarget", { url: "about:blank", newWindow: true });
    const t = (await cdpJson("/json")).find((x) => x.id === created.result.targetId);
    return openPage(t, name);
  };
  // 俯瞰画面（フェイク Joy-Con 付き）を先に開き、床のマーカー（ID 1）の配置を配ってから、スマホを開く
  // （スマホは床のマーカーしか見ないので、配置が届くまで位置合わせできない）
  const ov = await openPage(first, "overview");
  await ov.send("Page.navigate", { url: OVERVIEW });
  const readOverview = async () => parseOverviewHud((await ov.eval("document.querySelector('#hud')?.textContent")) ?? "");
  const tOv = Date.now();
  while (Date.now() - tOv < 30000 && !(await readOverview()).me.startsWith("p")) await sleep(300);
  const setRows = await ov.eval(`(() => {
    const rows = document.querySelectorAll('#marker-rows .row');
    const cb = rows[0].querySelector('input[type=checkbox]');
    cb.checked = true; cb.dispatchEvent(new Event('change'));
    const nums = rows[0].querySelectorAll('input[type=number]');
    nums[0].value = '1'; nums[0].dispatchEvent(new Event('input'));
    nums[1].value = '0'; nums[1].dispatchEvent(new Event('input'));
    nums[3].value = '0.5'; nums[3].dispatchEvent(new Event('input'));
    return rows.length;
  })()`);
  await sleep(300);
  await ov.eval("document.querySelector('#apply-markers').click()");
  await sleep(1000);
  const mOv = await readOverview();
  check("俯瞰画面が先に入室し、追加マーカー（床 1）の配置を配れる（行は上限の 8）", setRows === 8 && mOv.me.startsWith("p") && mOv.markers === "1:floor", `me=${mOv.me} markers=${mOv.markers}`);
  check("サーバーが markers → 1:floor を記録している", serverLines.some((l) => /markers → 1:floor/.test(l)));

  const p1 = await newPage("1");
  await p1.send("Page.navigate", { url: `${BASE}?${COMMON}&name=One&fakeCamPos=0.1,-0.5,1.2` });
  // 2 台目は自動打ち（手番から 1s 後にカップに届く速さで）
  const p2 = await newPage("2");
  await p2.send("Page.navigate", { url: `${BASE}?${COMMON}&name=Two&fakeCamPos=-0.2,-0.5,1.3&fakeStroke=1` });

  const readHud = async (p) => parseHud((await p.eval("document.querySelector('#hud')?.textContent")) ?? "");
  const show = (h) => `me=${h.me} marker=${h.marker} gaze=${h.gaze} phase=${h.phase} hole=${h.hole}/${h.holes} turn=${h.turn} balls=${JSON.stringify(h.balls)} cards=${JSON.stringify(h.cards)} strokes=${h.sent}/${h.accepted} roll=${h.roll}`;
  const showOv = (h) => `me=${h.me} phase=${h.phase} hole=${h.hole} turn=${h.turn} joycons=${h.joycons} assigned=${h.assigned} swings=${h.swings} strokesSent=${h.strokesSent}`;

  const t0 = Date.now();
  while (Date.now() - t0 < 40000) {
    const [h1, h2] = await Promise.all([readHud(p1), readHud(p2)]);
    if (h1.me.startsWith("p") && h2.me.startsWith("p") && h1.marker.startsWith("id=") && h2.marker.startsWith("id=")) break;
    await sleep(500);
  }
  console.log(`両ウィンドウの入室 + マーカー検出まで ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  await sleep(1500);
  const a1 = await readHud(p1);
  const a2 = await readHud(p2);
  const aOv = await readOverview();
  console.log(`start window1: ${show(a1)}`);
  console.log(`start window2: ${show(a2)}`);
  console.log(`start overview: ${showOv(aOv)}`);
  check("両ウィンドウで床のマーカー（ID 1）だけで位置合わせしている（welcome の配置を受け付ける）", a1.markerIds.size === 1 && a1.markerIds.has(1) && a2.markerIds.size === 1 && a2.markerIds.has(1) && a1.layout === "1:floor", `${a1.marker} / ${a2.marker} layout=${a1.layout}`);
  check("両方が同じ room に入り 2 人になっている", a1.players.length === 2 && a2.players.length === 2);
  check("俯瞰画面はプレイヤーではなく、フェイク Joy-Con が 1 台繋がっている", aOv.me.startsWith("p") && aOv.players.length === 2 && aOv.joycons === 1, `${aOv.me} joycons=${aOv.joycons}`);
  check("下を向いているので視線と床の交点（gaze）が取れている", a1.gaze !== null && a2.gaze !== null, `${a1.gaze} / ${a2.gaze}`);
  check("最初の手番は参加順の 1 人目（1 台目のスマホ）", (a1.phase === "aim" && a1.turn === a1.me) || (a1.phase === "rolling" && a1.roll.includes(`:${a1.me}:`)), `${a1.phase} turn=${a1.turn} roll=${a1.roll}`);

  // ---- p1 の番: フェイク Joy-Con（手番の人に自動）が振る → stroke → カップイン ----
  const tSwing = Date.now();
  let s1 = await readHud(p1);
  while (Date.now() - tSwing < 25000 && !(s1.balls[s1.me]?.holed || (s1.cards[s1.me] ?? "-") !== "-")) {
    await sleep(500);
    s1 = await readHud(p1);
  }
  const sOv = await readOverview();
  console.log(`after swing window1: ${show(s1)} putter=${s1.putter}`);
  console.log(`after swing overview: ${showOv(sOv)}`);
  check("俯瞰画面のフェイク Joy-Con が 1 台目のスマホの番に振り、stroke が送られた", sOv.swings >= 1 && sOv.strokesSent >= 1, `swings=${sOv.swings} strokesSent=${sOv.strokesSent}`);
  // id は入室順（俯瞰画面が p1、スマホが p2 / p3）なので HUD の me で見る
  check("サーバーが俯瞰画面からの代理 stroke（1 台目のスマホの分）を受理して転がりを計算した", serverLines.some((l) => new RegExp(`\\] ${sOv.me} stroke\\(${s1.me}\\) #\\d+:`).test(l)), `${sOv.me} for ${s1.me}`);
  check("1 台目のスマホのボールがカップイン（1 打）", (s1.balls[s1.me]?.holed && s1.balls[s1.me].strokes === 1) || s1.cards[s1.me] === "1", JSON.stringify(s1.balls));
  check("スマホ側でも同じ転がりを描き、HOLED の roll を受け取った", p1.logs.some((l) => /\[game\] event stroke/.test(l)) && !p1.logs.some((l) => /roll end mismatch/.test(l)));
  check("振り角（putter）がスマホに届いた", p1.logs.length > 0 && (s1.putter !== "" || (await p1.eval("true"))));

  // ---- p2 の番: 自動打ち（fakeStroke）でカップイン → 全員終了 → ホール 2 ----
  const tHole = Date.now();
  let h1 = await readHud(p1);
  while (Date.now() - tHole < 30000 && h1.hole < 2) {
    await sleep(500);
    h1 = await readHud(p1);
  }
  const h2 = await readHud(p2);
  const hOv = await readOverview();
  console.log(`hole2 window1: ${show(h1)}`);
  console.log(`hole2 window2: ${show(h2)}`);
  console.log(`hole2 overview: ${showOv(hOv)}`);
  check("2 台目のスマホが自分の番に自動で打ち（fakeStroke）、サーバーに受理された", h2.sent >= 1 && h2.accepted >= 1 && serverLines.some((l) => new RegExp(`\\] ${h2.me} stroke\\(${h2.me}\\) #\\d+:`).test(l)), `${h2.sent}/${h2.accepted}`);
  check("全員が終えて次のホール（hole=2）に進み、カードに 1 ホール目の打数が入った", h1.hole === 2 && h2.hole === 2 && hOv.hole === 2 && h1.cards[h1.me] !== "-" && h1.cards[h2.me] !== "-", `cards=${JSON.stringify(h1.cards)}`);
  check("新しいホールで打数が 0 に戻り、手番は 1 台目のスマホ", h1.balls[h1.me]?.strokes === 0 && h1.turn === h1.me, JSON.stringify(h1.balls));

  // ---- 俯瞰画面の「構え」（Joy-Con の A 相当）: window.__fakeJoycon で A を押す → address が受理され狙いが固定される ----
  // フェイク Joy-Con は手番の人（p1）を担当。p1 の視線の交点（gaze）が届いているので address が通る
  await ov.eval("document.querySelector('#restart').disabled");
  const addressesBefore = (await readOverview()).addresses;
  const addrOk = new RegExp(`address\\(${h1.me}\\) aim=`);
  const addrRej = new RegExp(`address\\(${h1.me}\\) rejected`);
  const rejBefore = serverLines.filter((l) => addrRej.test(l)).length;
  const okBefore = serverLines.filter((l) => addrOk.test(l)).length;
  // フェイク Joy-Con の A は overview.ts が公開する window.__golfFake.pressA() で押す
  const pressed = await ov.eval("(() => { const f = window.__golfFake; if (!f) return false; f.pressA(); return true; })()");
  await sleep(800);
  const okAfter = serverLines.filter((l) => addrOk.test(l)).length;
  const aimed = await readHud(p1);
  check("フェイク Joy-Con の A で俯瞰画面が手番の人の代わりに構え（address）、サーバーがその人の視線から狙いを決めた", pressed === true && okAfter > okBefore && (await readOverview()).addresses > addressesBefore, `ok ${okBefore}→${okAfter} rejected=${serverLines.filter((l) => addrRej.test(l)).length - rejBefore}`);
  check("構えた狙いは視線の交点（gaze）の向き（HUD の gaze が取れている）", aimed.gaze !== null, `gaze=${aimed.gaze}`);

  // ---- 最初から ----
  await ov.eval("document.querySelector('#restart').click()");
  await sleep(1500);
  const r1 = await readHud(p1);
  const rOv = await readOverview();
  check("俯瞰画面の「最初から」でホール 1 に戻り、カードが空になる", rOv.restarts === 1 && r1.hole === 1 && r1.cards[r1.me] === "-" && serverLines.some((l) => /restart → restart\+turn/.test(l)), `hole=${r1.hole} cards=${JSON.stringify(r1.cards)}`);
  check("例外が出ていない", p1.exceptions.length === 0 && p2.exceptions.length === 0 && ov.exceptions.length === 0, [...p1.exceptions, ...p2.exceptions, ...ov.exceptions].slice(0, 2).join(" | "));
  for (const l of ov.logs.filter((l) => /\[overview\] (impact|fake swing|address)/.test(l)).slice(0, 4)) console.log(`overview log: ${l}`);
  for (const l of p1.logs.filter((l) => /\[game\] (event stroke|stroke sent)/.test(l)).slice(0, 2)) console.log(`window1 log: ${l}`);

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
