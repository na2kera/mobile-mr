// demos/08-8-splatoon-pose-cam のブラウザ経路をヘッドレス Chrome で確認する。`npm run check:pose-cam` で実行する。
// 仕組みは headless-08-3-outside-in.mjs と同じ（CDP を ws で直接叩く。Chrome が無ければスキップ）。
//
// 確認内容: スマホ側 2 ウィンドウ（フェイクカメラ = チェッカーボード + 合成の手）+ 俯瞰画面 1 ウィンドウ + トラッカー 1 ウィンドウ
// （俯瞰画面の ?tracker=1&fakecam=1。フェイクカメラに原点マーカー + 床のマーカーを投影し、部屋座標系に置いた 2 人ぶんの合成の体
// （fake-body.ts。ゴーグルで目は隠れる）を PoseLandmarker の代わりに返す）で、
//   - スマホは入室しても位置が来るまで撃てない（トラッカー待ち → 原点未確定 → 手を挙げる案内）
//   - 床のマーカーで「原点を確定」→ 2 人を検出して一覧に「検出中（未割当）」、案内「次の人（入室順の 1 人目）は手を挙げてください」
//   - 1 人目の体が手を挙げると入室順の 1 人目に割り当たり、その人だけ位置が届く。2 人目の体が挙げると 2 人目に
//   - 頭の位置 → 部屋座標系の変換: 自分の位置（self）が合成の体の頭の中心 + 正面へ eyeFwdM に 5cm 以内、ヨー（肩の向き）が 2° 以内、
//     相手が正しい相対位置に見える
//   - 発射が着弾して得点が入る。俯瞰画面の一覧に「人物 #n」が出る
//   - 0.3 秒隠しても割当は残る / 3 秒隠すと割当は外れて「手を挙げる番」に戻り（案内に「見失ったので割当を外しました」）、
//     スマホは最後の位置を表示に保持（tracked (x.xs ago)）するが撃てない（サーバーの dropMissing。案内「手を挙げて割り当ててもらって」）→
//     再び見えても自動では戻らず、手を挙げると戻る
//   - 対戦開始 → 試合 → 途中終了 → 結果を閉じる（08 と同じ進行）
//   - 「割当をやり直す」で全員が未割当に戻り、入室順に挙げ直せる
//   - 原点を確定し直すとずらしたヨー（φ）もスナップして戻る / 再接続すると位置が届くまで案内が出て撃たず、手を挙げると戻る
//   - 本物の PoseLandmarker（?fakePoseModel=1）: 別の room でフェイクカメラの映像に推論を回し、モデルが読み込めて推論が回り（人は映っていないので 0 人）、
//     例外で検出が止まらないこと（観測は合成の体のまま割り当たる）
//   - 例外が出ていない
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
// 別の worktree で同時に走らせるときは PORT / CDP_PORT で変える
const PORT = Number(process.env.PORT ?? "") || 5199;
const CDP_PORT = Number(process.env.CDP_PORT ?? "") || 9343;
/** 割り当ててから練習の HUD を読むまでの待ち [s]（発射 2〜3 回） */
const WAIT_SEC = Number(process.env.WAIT_SEC ?? "") || 10;
/** 対戦開始を押してから試合中の HUD を読むまでの待ち [s] */
const PLAY_WAIT_SEC = Number(process.env.PLAY_WAIT_SEC ?? "") || 8;
const BASE = `https://localhost:${PORT}/demos/08-8-splatoon-pose-cam/`;
const MARKER_MM = 150;
const COMMON = `fov=70&camZoom=1&fakecam=1&autostart=1&fakehands=1&handSmooth=1&room=check&waitSec=1&markerMm=${MARKER_MM}`;
const OVERVIEW = `${BASE}overview.html?room=check&waitSec=1&markerMm=${MARKER_MM}`;
// トラッカー: フェイクカメラは正面の壁の原点マーカーの 0.5m 上・0.2m 手前から部屋を 35° 見下ろす。床のマーカー（ID 1、(0,-1.2,1.25)）で原点合わせ。
// 合成の体（頭の中心 x,y,z とヨー）: 体 0 = (-0.5, 0, 1.5) で正面（ヨー 0）、体 1 = (0.5, 0, 1.5) で 15° 左を向く。
// 送る位置は頭の中心から正面へ eyeFwdM（既定 0.1m）
const EYE_FWD_M = 0.1;
const BODY_HEADS = [[-0.5, 0, 1.5], [0.5, 0, 1.5]];
const BODY_YAWS = [0, 15];
const expectPos = (i) => {
  const y = (BODY_YAWS[i] * Math.PI) / 180;
  return [BODY_HEADS[i][0] - Math.sin(y) * EYE_FWD_M, BODY_HEADS[i][1], BODY_HEADS[i][2] - Math.cos(y) * EYE_FWD_M];
};
const TRACKER = `${OVERVIEW}&tracker=1&fakecam=1&fakeTrackCam=0,0.5,0.2,180,35&fakeBodies=${BODY_HEADS.map((h, i) => `${h.join(",")},${BODY_YAWS[i]}`).join(";")}`;

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
    if (!line.startsWith("[splatoon-pose-cam]")) continue;
    serverLines.push(line);
    const m = line.match(/^\[splatoon-pose-cam\] (p\d+) shot #\d+: (\S+)/);
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

/** 俯瞰画面の HUD のうち 08-8 のトラッカー固有（persons= next= assigns=） */
function parsePoseHud(hud) {
  return {
    /** "1:p1:up,2:-:down" → [{ key: 1, player: "p1", raised: true }, ...] */
    persons: (hud.match(/\bpersons=(\S+)/)?.[1] ?? "-")
      .split(",")
      .filter((e) => e && e !== "-")
      .map((e) => {
        const [key, player, up] = e.split(":");
        return { key: Number(key), player: player === "-" ? null : player, raised: up === "up" };
      }),
    next: hud.match(/\bnext=(\S+)/)?.[1] ?? "",
    assigns: Number(hud.match(/\bassigns=(\d+)/)?.[1] ?? -1),
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
  const pa = await newWindow("One");
  await pa.send("Page.navigate", { url: `${BASE}?${COMMON}&name=One` });
  const pb = await newWindow("Two");
  await pb.send("Page.navigate", { url: `${BASE}?${COMMON}&name=Two` });

  const readHud = async (p) => parseHud((await p.eval("document.querySelector('#hud')?.textContent")) ?? "");
  const readOverview = async (p = p3) => parseOverviewHud((await p.eval("document.querySelector('#hud')?.textContent")) ?? "");
  const show = (h) => `me=${h.me} track=${h.track} self=${JSON.stringify(h.self)} phase=${h.phase} color=${h.color} players=${h.players.join("|")} scores=${JSON.stringify(h.scores)}/${h.total} shots=${h.sent}/${h.accepted}`;
  const waitUntil = async (fn, timeoutMs, stepMs = 250) => {
    const t0 = Date.now();
    let v = await fn();
    while (!v && Date.now() - t0 < timeoutMs) {
      await sleep(stepMs);
      v = await fn();
    }
    return v;
  };

  const t0 = Date.now();
  while (Date.now() - t0 < 40000) {
    const [ha, hb, ov] = await Promise.all([readHud(pa), readHud(pb), readOverview()]);
    if (ha.me.startsWith("p") && hb.me.startsWith("p") && ov.players.length === 2) break;
    await sleep(500);
  }
  console.log(`両ウィンドウの入室まで ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  await sleep(3000);
  // 入室順（サーバーの番号 10 = 1 人目）で p1 / p2 を決める（ウィンドウの読み込み順は前後し得る）
  const idA = await pa.eval("window.__poseCam?.trackId()");
  const [p1, p2] = idA === 10 ? [pa, pb] : [pb, pa];
  console.log(`入室順: 1 人目 = ${p1.name}（番号 ${await p1.eval("window.__poseCam?.trackId()")}）、2 人目 = ${p2.name}`);
  // 体 0 は 1 人目、体 1 は 2 人目に割り当てる
  const P1_POS = expectPos(0);
  const P2_POS = expectPos(1);

  // ---- トラッカー待ち: 位置が来るまで撃てない ----
  const w1 = await readHud(p1);
  const w2 = await readHud(p2);
  const wOv = await readOverview();
  console.log(`waiting window1: ${show(w1)}`);
  console.log(`waiting window2: ${show(w2)}`);
  check("両方が同じ room に入り 2 人になっている", w1.players.length === 2 && w2.players.length === 2);
  check("個人戦: 別の色が割り当たっている", w1.color > 0 && w2.color > 0 && w1.color !== w2.color, `${w1.color} vs ${w2.color}`);
  check("トラッカーが居ない間は HUD が track=no-tracker で、位置が無いので撃たない", w1.track === "no-tracker" && w2.track === "no-tracker" && w1.sent === 0 && w2.sent === 0 && w1.self === null, `${w1.track} shots=${w1.sent}`);
  check("サーバーは入室順に番号 10 / 11 を付ける（08-3 と同じ枠。俯瞰画面は「トラッカー待ち」）", wOv.peerTrack[w1.me]?.[0] === "10" && wOv.peerTrack[w2.me]?.[0] === "11" && wOv.peerTrack[w1.me]?.[1] === "wait" && wOv.tracker === "0/unlocked", JSON.stringify(wOv.peerTrack));
  const listText = await p3.eval("document.querySelector('#players')?.textContent");
  check("俯瞰画面のプレイヤー一覧に「位置合わせ: 割当待ち」の行がある", /位置合わせ: 割当待ち/.test(listText ?? ""), (listText ?? "").slice(0, 120));

  // ---- 床のマーカーの配置を配る（トラッカーの原点合わせ用）----
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
  check("床のマーカー（ID 1）の配置が全員に届く", mkOv.markers === "1:floor" && (await readHud(p1)).layout === "1:floor", mkOv.markers);

  // ---- トラッカーのウィンドウ（俯瞰画面 + ?tracker=1&fakecam=1&fakeBodies=）----
  const p4 = await newWindow("tracker");
  await p4.send("Page.navigate", { url: TRACKER });
  const readPose = async () => parsePoseHud((await p4.eval("document.querySelector('#hud')?.textContent")) ?? "");
  let tOv = await waitUntil(async () => {
    const o = await readOverview(p4);
    return /^on\/unlocked\/origin=1\//.test(o.local) ? o : null;
  }, 40000);
  tOv = tOv ?? (await readOverview(p4));
  check("トラッカーがカメラを開き、フェイクカメラの床のマーカー（ID 1）を原点候補として見ている", /^on\/unlocked\/origin=1\//.test(tOv.local), tOv.local);
  const c1 = await readHud(p1);
  check("トラッカーが接続すると全員の HUD が track=unlocked（原点未確定）になり、まだ撃たない", c1.track === "unlocked" && c1.sent === 0, `${c1.track} shots=${c1.sent}`);
  check("原点が未確定の間は人物を検出しない（persons=-・next=-）", (await readPose()).persons.length === 0 && (await readPose()).next === "-");
  const readLockButton = () => p4.eval("(() => { const b = document.querySelector('#tracker-lock'); return b && !b.disabled ? b.textContent : null; })()");
  const lockEnabled = await waitUntil(readLockButton, 5000, 200);
  check("原点マーカーが見えていると「原点を確定」が押せる", lockEnabled === "原点を確定", String(lockEnabled));
  await sleep(1200);
  await p4.eval("document.querySelector('#tracker-lock').click()");
  await sleep(1000);
  check("トラッカーが原点の確定をログに出す（カメラの位置 ≈ (0,0.5,0.2)）", p4.logs.some((l) => /\[tracker\] origin locked from \d+ samples: cam at \(-?0\.0\d,0\.[45]\d,0\.[12]\d\)/.test(l)), p4.logs.filter((l) => l.startsWith("[tracker]")).slice(-1).join(" | "));

  // ---- 原点確定後: 2 人を検出、未割当。案内は入室順の 1 人目 ----
  const me1 = (await readHud(p1)).me;
  const me2 = (await readHud(p2)).me;
  const pz = await waitUntil(async () => {
    const h = await readPose();
    return h.persons.length === 2 ? h : null;
  }, 5000);
  check("原点を確定すると合成の体 2 人を検出し、どちらも未割当・次は入室順の 1 人目", pz && pz.persons.every((p) => p.player === null) && pz.next === me1 && pz.assigns === 0, JSON.stringify(pz));
  const promptText = await p4.eval("document.querySelector('#tracker-prompt')?.textContent");
  check("トラッカーの枠に「次の人（One / Two の 1 人目）は手を挙げてください」", new RegExp(`次の人（${p1.name}）は手を挙げてください`).test(promptText ?? ""), promptText);
  const personsText = await p4.eval("document.querySelector('#tracker-persons')?.textContent");
  check("人物一覧に 2 人とも「検出中（未割当）」", (personsText?.match(/検出中（未割当）/g) ?? []).length === 2, personsText);
  await sleep(1000);
  const nw1 = await readHud(p1);
  check("割当前は位置が届かず（waiting）撃たない。案内は「手を挙げてください」", /^waiting id=10/.test(nw1.track) && nw1.sent === 0 && /手を挙げてください/.test((await p1.eval("window.__poseCam.message()")) ?? ""), `${nw1.track} shots=${nw1.sent}`);

  /** 体 i に手を挙げさせ、割当が増えるまで待って下ろす */
  const raise = async (i) => {
    const before = (await readPose()).assigns;
    await p4.eval(`window.__fakePose.bodies[${i}].raised = true`);
    const after = await waitUntil(async () => {
      const h = await readPose();
      return h.assigns > before ? h : null;
    }, 4000, 100);
    await p4.eval(`window.__fakePose.bodies[${i}].raised = false`);
    await sleep(300);
    return after;
  };

  // ---- 体 0 が手を挙げる → 1 人目に割り当たる。2 人目はまだ ----
  await p4.eval("window.__fakePose.bodies[0].raised = true");
  await sleep(250);
  const early = await readPose();
  check("手を挙げて 0.5 秒経つまでは割り当てない", early.assigns === 0 && early.persons.some((p) => p.raised), JSON.stringify(early));
  await p4.eval("window.__fakePose.bodies[0].raised = false");
  await sleep(300);
  const a1 = await raise(0);
  check("体 0 が手を挙げ続けると入室順の 1 人目に割り当たり、次は 2 人目", a1 && a1.assigns === 1 && a1.persons.filter((p) => p.player === me1).length === 1 && a1.next === me2, JSON.stringify(a1));
  const got1 = await waitUntil(async () => {
    const h = await readHud(p1);
    return h.trackId === 10 && h.self ? h : null;
  }, 5000);
  const still2 = await readHud(p2);
  check("1 人目にだけ位置が届く（2 人目は waiting のまま撃たない）", got1 && /^waiting id=11/.test(still2.track) && still2.sent === 0, `${got1?.track} / ${still2.track}`);
  const a2 = await raise(1);
  check("体 1 が手を挙げると 2 人目に割り当たり、全員の割当が済む（next=none）", a2 && a2.assigns === 2 && a2.persons.every((p) => p.player !== null) && a2.next === "none", JSON.stringify(a2));
  const doneText = await p4.eval("document.querySelector('#tracker-prompt')?.textContent");
  check("案内が「全員の割当が済みました」になる", doneText === "全員の割当が済みました", doneText);

  // ---- 位置が届く → 撃てる → 得点 ----
  const tp = Date.now();
  await waitUntil(async () => {
    const [h1, h2] = [await readHud(p1), await readHud(p2)];
    return h1.accepted >= 3 && h2.accepted >= 3;
  }, 30000, 500);
  await sleep(Math.max(0, WAIT_SEC * 1000 - (Date.now() - tp)));
  const h1 = await readHud(p1);
  const h2 = await readHud(p2);
  const hOv = await readOverview();
  const tOv2 = await readOverview(p4);
  console.log(`practice window1: ${show(h1)}`);
  console.log(`practice window2: ${show(h2)}`);
  console.log(`practice tracker: local=${tOv2.local}`);
  check("両方の位置がサーバーから届いている（HUD の track=id=10 / 11、品質あり）", h1.trackId === 10 && h2.trackId === 11 && h1.quality > 0 && h2.quality > 0 && !h1.holding && !h2.holding, `${h1.track} / ${h2.track}`);
  check("1 人目の自分の位置（self）が体 0 の頭の中心 + 正面 10cm (-0.5,0,1.4) に 5cm 以内（頭 → 部屋座標系）", dist(h1.self, P1_POS) < 0.05, `self=${JSON.stringify(h1.self)} err=${dist(h1.self, P1_POS).toFixed(3)}m`);
  check("2 人目の自分の位置が体 1 の頭の中心 + 正面 10cm に 5cm 以内", dist(h2.self, P2_POS) < 0.05, `self=${JSON.stringify(h2.self)} expect=${P2_POS.map((v) => v.toFixed(3))} err=${dist(h2.self, P2_POS).toFixed(3)}m`);
  check("トラッカーのヨー（肩と耳の向き）が置いた向き（0° / 15°）に 2° 以内で届く", Math.abs(h1.yawDeg - 0) <= 2 && Math.abs(h2.yawDeg - BODY_YAWS[1]) <= 2, `yaw1=${h1.yawDeg} yaw2=${h2.yawDeg}`);
  const yawOf = (f) => (Array.isArray(f) ? (Math.atan2(-f[0], -f[2]) * 180) / Math.PI : NaN);
  const fwd1 = await p1.eval("window.__poseCam?.selfForward()");
  const fwd2 = await p2.eval("window.__poseCam?.selfForward()");
  check("自分の正面を field 座標系に直すとトラッカーのヨーと一致する（φ が効いている）", Math.abs(yawOf(fwd1) - 0) <= 2 && Math.abs(yawOf(fwd2) - BODY_YAWS[1]) <= 2, `fwd1=${yawOf(fwd1).toFixed(1)}° fwd2=${yawOf(fwd2).toFixed(1)}°`);
  const peers1 = await p1.eval("window.__poseCam?.peers()");
  const peers2 = await p2.eval("window.__poseCam?.peers()");
  check("1 人目から見た相手の表示位置が相手の位置に 5cm 以内（相対位置が合う）", dist(peers1?.[h2.me], P2_POS) < 0.05, `peer=${JSON.stringify(peers1?.[h2.me])}`);
  check("2 人目から見た相手の表示位置が相手の位置に 5cm 以内", dist(peers2?.[h1.me], P1_POS) < 0.05, `peer=${JSON.stringify(peers2?.[h1.me])}`);
  check("練習中に連射が送られ受理されている（位置が届いたので撃てる）", h1.sent >= 3 && h1.accepted >= 3 && h2.accepted >= 3, `${h1.sent}/${h1.accepted}, ${h2.sent}/${h2.accepted}`);
  check("練習中の塗りが得点に出る", (h1.scores[h1.me] ?? 0) > 0 && (h2.scores[h2.me] ?? 0) > 0, JSON.stringify(h1.scores));
  const hits = landings.filter((l) => l.where !== "miss");
  check("着弾のほとんどが壁か床に当たっている（外れが半分未満）", landings.length >= 4 && hits.length > landings.length / 2, `${hits.length}/${landings.length} hit`);
  check("俯瞰画面の HUD で両プレイヤーが追跡中（ok）", hOv.peerTrack[h1.me]?.[1] === "ok" && hOv.peerTrack[h2.me]?.[1] === "ok" && hOv.tracker === "1/locked" && hOv.tracked > 10, JSON.stringify(hOv.peerTrack));
  const listText2 = await p3.eval("document.querySelector('#players')?.textContent");
  const listText4 = await p4.eval("document.querySelector('#players')?.textContent");
  check("俯瞰画面のプレイヤー一覧: トラッカーの画面は「位置合わせ: 人物 #n q=」、別の俯瞰画面は「位置合わせ: 追跡中 q=」", (listText4?.match(/位置合わせ: 人物 #\d+ q=0\.\d+/g) ?? []).length === 2 && (listText2?.match(/位置合わせ: 追跡中 q=0\.\d+/g) ?? []).length === 2, `${(listText4 ?? "").slice(0, 120)} / ${(listText2 ?? "").slice(0, 120)}`);
  check("トラッカーの送る観測にプレイヤーと番号が付いている（local= の players）", tOv2.local.includes(`${h1.me}:10:`) && tOv2.local.includes(`${h2.me}:11:`), tOv2.local);

  // ---- 短い隠れ（0.3 秒）: 割当は残り、見えればそのまま追跡が続く（復帰は 0.5 秒以内だけ）----
  await p4.eval("window.__fakePose.hidden.add(1)");
  await sleep(250);
  await p4.eval("window.__fakePose.hidden.delete(1)");
  await sleep(800);
  const short = await readPose();
  check("0.3 秒隠れても割当は残る（再び見えた人物に同じプレイヤーが付いたまま）", short.persons.length === 2 && short.persons.some((p) => p.player === me2) && short.next === "none", JSON.stringify(short));

  // ---- 長い隠れ（3 秒）: 割当は外れ、スマホは最後の位置を表示に保持するが撃てない → 見えても自動では戻らず、手を挙げると戻る ----
  await p4.eval("window.__fakePose.hidden.add(1)");
  await sleep(1500);
  const mid2 = await readHud(p2);
  const midPrompt = (await p4.eval("document.querySelector('#tracker-prompt')?.textContent")) ?? "";
  await sleep(1500);
  const lost2 = await readHud(p2);
  const lostPose = await readPose();
  const lostMsg = (await p2.eval("window.__poseCam.message()")) ?? "";
  console.log(`hidden window2: ${show(lost2)} holding=${lost2.holding} ago=${lost2.agoSec} message=${JSON.stringify(lostMsg)}`);
  check("3 秒隠すと 2 人目は最後の位置を表示に保持し HUD に tracked (x.xs ago)・holding last pose", lost2.holding && lost2.agoSec >= 2 && dist(lost2.self, P2_POS) < 0.05, `${lost2.track} self=${JSON.stringify(lost2.self)}`);
  check("0.5 秒を超えて見失うと 2 人目は未割当に戻り（次に手を挙げるのは 2 人目）、2 秒を超えた人物は一覧から消える", lostPose.persons.length === 1 && lostPose.next === me2, JSON.stringify(lostPose));
  check("トラッカーの案内に「見失ったので割当を外しました」と次に手を挙げる人が出る", new RegExp(`${p2.name} を見失ったので割当を外しました。次の人（${p2.name}）は手を挙げてください`).test(midPrompt), midPrompt);
  check("割当が外れている間は撃てない（発射も受理も増えない。サーバーの dropMissing とスマホの canShoot）", lost2.sent === mid2.sent && lost2.accepted === mid2.accepted, `sent ${mid2.sent} → ${lost2.sent}, accepted ${mid2.accepted} → ${lost2.accepted}`);
  check("スマホの案内が「…手を挙げて割り当ててもらってください（撃てません）」", /手を挙げて割り当ててもらってください/.test(lostMsg) && /撃てません/.test(lostMsg), lostMsg);
  const ovLost = await readOverview();
  check("俯瞰画面はウィンドウ 2 を「見失い」と出す", ovLost.peerTrack[h2.me]?.[1] === "lost" && ovLost.peerTrack[h1.me]?.[1] === "ok", JSON.stringify(ovLost.peerTrack));
  await p4.eval("window.__fakePose.hidden.delete(1)");
  await sleep(1500);
  const back = await readPose();
  const notBack2 = await readHud(p2);
  check("再び見えても自動では割り当たらない（未割当の人物として検出・2 人目は holding のまま）", back.persons.length === 2 && back.persons.some((p) => p.player === null) && back.next === me2 && notBack2.holding, `${JSON.stringify(back)} ${notBack2.track}`);
  const re2 = await raise(1);
  const back2 = await waitUntil(async () => {
    const h = await readHud(p2);
    return !h.holding && h.trackId === 11 ? h : null;
  }, 4000);
  check("手を挙げると 2 人目に割り当て直され、位置の追跡に戻る", re2 && re2.next === "none" && back2 && dist(back2.self, P2_POS) < 0.05, back2?.track ?? "no");

  // ---- 対戦開始 → 試合 → 途中終了 → 結果を閉じる ----
  await p3.eval("document.querySelector('#start-match').click()");
  await sleep(PLAY_WAIT_SEC * 1000);
  const play1 = await readHud(p1);
  const play2 = await readHud(p2);
  const playOv = await readOverview();
  console.log(`play window1: ${show(play1)}`);
  check("俯瞰画面の start が送られ、試合（play）になっている", playOv.starts === 1 && play1.phase === "play" && play2.phase === "play" && playOv.phase === "play");
  check("試合中も両プレイヤーが得点している", (play1.scores[play1.me] ?? 0) > 0 && (play2.scores[play2.me] ?? 0) > 0, JSON.stringify(play1.scores));
  check("試合中も位置の追跡が続いている", !play1.holding && !play2.holding && dist(play1.self, P1_POS) < 0.05, `${play1.track}`);
  await p3.eval("document.querySelector('#stop-match').click()");
  await sleep(1500);
  const stOv = await readOverview();
  check("「対戦を終了」で結果（result）になる", stOv.stops === 1 && (await readHud(p1)).phase === "result" && stOv.phase === "result");
  await p3.eval("document.querySelector('#stop-match').click()");
  await sleep(1500);
  const dmOv = await readOverview();
  check("「結果を閉じる」で練習に戻る", dmOv.dismisses === 1 && (await readHud(p1)).phase === "practice" && dmOv.phase === "practice");

  // ---- 割当をやり直す: 全員未割当 → 入室順に挙げ直す ----
  const resetEnabled = await p4.eval("!document.querySelector('#tracker-reset').disabled");
  await p4.eval("document.querySelector('#tracker-reset').click()");
  await sleep(500);
  const rs = await readPose();
  check("「割当をやり直す」で全員が未割当に戻り、次は入室順の 1 人目", resetEnabled === true && rs.persons.length === 2 && rs.persons.every((p) => p.player === null) && rs.next === me1, JSON.stringify(rs));
  // 入室順を逆にした体で挙げる: 体 1 が先に挙げると 1 人目に付く（割当は「挙げた順 × 入室順」で、体の位置には依らない）
  const r1 = await raise(1);
  const r2 = await raise(0);
  check("やり直し後は挙げた順に入室順で割り当たる（体 1 → 1 人目、体 0 → 2 人目）", r1 && r2 && r2.next === "none", JSON.stringify(r2));
  const swapped = await waitUntil(async () => {
    const h = await readHud(p1);
    return dist(h.self, P2_POS) < 0.05 ? h : null;
  }, 5000);
  check("入れ替えた割当で 1 人目の位置が体 1 の位置になる", swapped !== null, (await readHud(p1)).track);
  // 元に戻す
  await p4.eval("document.querySelector('#tracker-reset').click()");
  await sleep(300);
  await raise(0);
  await raise(1);
  const restored = await waitUntil(async () => {
    const h = await readHud(p1);
    return dist(h.self, P1_POS) < 0.05 ? h : null;
  }, 5000);
  check("もう一度やり直すと元の割当（体 0 → 1 人目）に戻せる", restored !== null, (await readHud(p1)).track);

  // ---- 原点を確定し直すと、位置だけでなくヨーもスナップする（08-3 と同じ）----
  await p4.eval("document.querySelector('#tracker-lock').click()");
  await sleep(800);
  const unlockedText = await p4.eval("document.querySelector('#tracker-lock')?.textContent");
  const snapsBefore = await p1.eval("window.__poseCam.yawSnaps()");
  await p1.eval("window.__poseCam.shiftPhiDeg(40)");
  await sleep(300);
  const shifted = yawOf(await p1.eval("window.__poseCam.selfForward()"));
  await waitUntil(async () => (await readLockButton()) === "原点を確定", 5000, 200);
  await sleep(600);
  await p4.eval("document.querySelector('#tracker-lock').click()");
  await sleep(500);
  // 確定し直すまでに 2 秒を超えていたら人物は消えて未割当に戻るので、挙げ直す
  for (let i = 0; i < 2; i++) {
    const h = await readPose();
    if (h.next === me1) await raise(0);
    else if (h.next === me2) await raise(1);
  }
  const relock1 = await waitUntil(async () => {
    const h = await readHud(p1);
    return dist(h.self, P1_POS) < 0.05 && !h.holding ? h : null;
  }, 5000);
  const snapsAfter = await p1.eval("window.__poseCam.yawSnaps()");
  const relockYaw = yawOf(await p1.eval("window.__poseCam.selfForward()"));
  check("「原点を解除」→「原点を確定」し直すと、ずらした φ（40°）が次の観測でスナップして戻る", unlockedText === "原点を確定" && Math.abs(shifted) > 30 && snapsAfter > snapsBefore && Math.abs(relockYaw) <= 2 && relock1 !== null, `shifted=${shifted.toFixed(1)}° → ${relockYaw.toFixed(1)}° snaps ${snapsBefore}→${snapsAfter}`);

  // ---- 再接続: id が変わるので割当が外れ、位置が届くまで案内を出して撃たない。手を挙げると戻る ----
  const oldMe = (await readHud(p1)).me;
  await p1.eval("window.__poseCam.reconnect()");
  const re1 = await waitUntil(async () => {
    const h = await readHud(p1);
    return h.me.startsWith("p") && h.me !== oldMe ? h : null;
  }, 10000, 300);
  await sleep(1500);
  const reHud = await readHud(p1);
  const reMsg = (await p1.eval("window.__poseCam.message()")) ?? "";
  const rePose = await readPose();
  console.log(`reconnect window1: ${show(reHud)} message=${JSON.stringify(reMsg)} tracker=${JSON.stringify(rePose)}`);
  check("再接続（id が変わる）で割当が外れ、案内「…手を挙げてください（届くまで撃てません）」が出る", re1 !== null && /^waiting id=10/.test(reHud.track) && /手を挙げてください/.test(reMsg) && /撃てません/.test(reMsg) && rePose.next === reHud.me, `${reHud.me} ${reHud.track} next=${rePose.next}`);
  const reSent = reHud.sent;
  await sleep(1000);
  check("位置が届くまでは撃たない（発射数が増えない）", (await readHud(p1)).sent === reSent, `${reSent}`);
  await raise(0);
  const reBack = await waitUntil(async () => {
    const h = await readHud(p1);
    return h.trackId === 10 && dist(h.self, P1_POS) < 0.05 ? h : null;
  }, 5000);
  check("手を挙げると再接続後の 1 人目に割り当たり、位置が届いて追跡に戻る", reBack !== null, (await readHud(p1)).track);

  // ---- 本物の PoseLandmarker の経路（別の room。フェイクカメラは正面の壁の原点マーカーを 2m 手前から見る。合成の体は 1m 手前でカメラを向く）----
  const p5 = await newWindow("model");
  const MODEL_URL = `${BASE}overview.html?room=model&waitSec=1&markerMm=${MARKER_MM}&tracker=1&fakecam=1&fakePoseModel=1&fakeTrackCam=0,0,2,0,0&fakeBodies=0,0,1,180`;
  await p5.send("Page.navigate", { url: MODEL_URL });
  const readModelLock = () => p5.eval("(() => { const b = document.querySelector('#tracker-lock'); return b && !b.disabled ? b.textContent : null; })()");
  const modelLock = await waitUntil(async () => ((await readModelLock()) === "原点を確定" ? true : null), 30000, 300);
  await sleep(1200);
  await p5.eval("document.querySelector('#tracker-lock').click()");
  const modelInfo = await waitUntil(async () => {
    const t = (await p5.eval("document.querySelector('#tracker-status')?.textContent")) ?? "";
    const m = t.match(/model=(-?\d+)\/(\d+)/);
    return m && Number(m[2]) >= 5 && /ready (GPU|CPU)/.test(t) ? t : null;
  }, 90000, 1000);
  const modelText = (await p5.eval("document.querySelector('#tracker-status')?.textContent")) ?? "";
  console.log(`model tracker: ${modelText.split("\n")[0]}`);
  check("?fakePoseModel=1: 本物の PoseLandmarker が読み込めて（ready GPU/CPU）推論が 5 回以上回り、映像に人が居ないので 0 人", modelLock === true && modelInfo !== null && /model=0\//.test(modelInfo) && /errors=0/.test(modelInfo), modelText.split("\n")[0]);
  await p5.eval("window.__fakePose.bodies[0].raised = true");
  await sleep(300);
  // この room にプレイヤーは居ないので割当は起きず、人物として検出されるだけ
  const modelPose = parsePoseHud((await p5.eval("document.querySelector('#hud')?.textContent")) ?? "");
  check("?fakePoseModel=1 でも合成の体は人物として検出され続ける（推論を回しても検出のループが止まらない）", modelPose.persons.length === 1 && modelPose.persons[0].raised === true, JSON.stringify(modelPose));

  check("例外が出ていない", [p1, p2, p3, p4, p5].every((p) => p.exceptions.length === 0), [p1, p2, p3, p4, p5].flatMap((p) => p.exceptions).slice(0, 2).join(" | "));
  for (const l of p4.logs.filter((l) => l.startsWith("[tracker]") || l.startsWith("[overview]")).slice(0, 6)) console.log(`tracker log: ${l}`);

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
