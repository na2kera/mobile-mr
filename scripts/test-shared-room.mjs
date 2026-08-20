// server/shared-room.ts（Room 中継 WebSocket サーバー）の回帰テスト。
// `npm run test:room` で実行する。Vite dev サーバーを自分で起動してから
// ws クライアントで叩くので、事前準備は不要。
// テストフレームワークは使わない（依存追加はスタック変更なので相談が要る。
// 現状は導入済みの ws と Node 標準だけで書く）
import { spawn } from "node:child_process";
import WebSocket from "ws";

const PORT = 5178;
const URL_BASE = `wss://localhost:${PORT}/api/shared-room`;
const PAGE_ORIGIN = `https://localhost:${PORT}`;
/** ハートビート間隔 [ms]。half-open 切断のテストが実時間で待てるよう短縮する */
const HEARTBEAT_MS = 300;
/** 接続・メッセージ待ちの上限 [ms]。超えたら失敗にする（テスト全体を止めない） */
const WAIT_TIMEOUT_MS = 5000;
/** 「届かないこと」を確認するときの観察時間 [ms] */
const NEGATIVE_WAIT_MS = 400;

const results = [];
function check(name, cond) {
  results.push([name, cond]);
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- dev サーバー起動（起動完了は接続が通るまでポーリングで待つ） ----
const server = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, SHARED_ROOM_HEARTBEAT_MS: String(HEARTBEAT_MS) },
});
server.stderr.on("data", (d) => process.stderr.write(d));
let serverExited = false;
server.on("exit", () => {
  serverExited = true;
});

/**
 * 接続クエリを組む。空間設定はクライアント（04 の既定値）と同じ既定を使い、
 * テストごとに上書きできる
 */
function buildQuery(room, { v = 1, markerId = 0, markerMm = 100 } = {}) {
  const q = new URLSearchParams({
    room,
    v: String(v),
    markerId: String(markerId),
    markerMm: String(markerMm),
  });
  return q.toString();
}

/** 接続してハンドシェイク完了を待つ。タイムアウトつき（pending で全体を止めない） */
function tryConnect(query, extraOpts = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${URL_BASE}?${query}`, {
      rejectUnauthorized: false, // basicSsl の自己署名証明書を許可
      origin: PAGE_ORIGIN, // ブラウザと同じくページの Origin を名乗る（上書き可）
      handshakeTimeout: WAIT_TIMEOUT_MS,
      ...extraOpts,
    });
    const msgs = [];
    ws.on("message", (d) => msgs.push(JSON.parse(d.toString())));
    const timer = setTimeout(
      () => reject(new Error("connect timeout")),
      WAIT_TIMEOUT_MS,
    );
    ws.on("open", () => {
      clearTimeout(timer);
      resolve({ ws, msgs });
    });
    ws.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

/** conn.msgs に predicate を満たすメッセージが現れるまでポーリングで待つ */
async function waitForMsg(conn, predicate, timeoutMs = WAIT_TIMEOUT_MS) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const found = conn.msgs.find(predicate);
    if (found) return found;
    await sleep(50);
  }
  return null;
}

async function waitForServer(timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (serverExited) return false;
    try {
      const probe = await tryConnect(buildQuery("probe"));
      probe.ws.close();
      return true;
    } catch {
      await sleep(300);
    }
  }
  return false;
}

let exitCode = 1;
try {
  if (!(await waitForServer())) {
    throw new Error(
      `dev サーバーが起動しなかった（ポート ${PORT} が使用中でないか確認）`,
    );
  }

  // ---- 正常系: join / welcome / pose 中継 ----
  const a = await tryConnect(buildQuery("t1"));
  const aWelcome = await waitForMsg(a, (m) => m.type === "welcome");
  const b = await tryConnect(buildQuery("t1"));
  const bWelcome = await waitForMsg(b, (m) => m.type === "welcome");
  check("A が welcome を受信", !!aWelcome);
  check("A の welcome は peers 空", aWelcome?.peers.length === 0);
  check(
    "B の welcome の peers に A が入る",
    bWelcome?.peers.includes(aWelcome?.id),
  );
  check(
    "A に B の join が届く",
    !!(await waitForMsg(a, (m) => m.type === "join" && m.id === bWelcome?.id)),
  );

  const pose = {
    type: "pose",
    pos: [0.1, 1.6, 0.7],
    quat: [0, 0, 0, 1],
    tracking: true,
  };
  a.ws.send(JSON.stringify(pose));
  const relayed = await waitForMsg(b, (m) => m.type === "pose");
  check("B に pose が中継される", !!relayed);
  check("pose の送信元 id はサーバーが付ける", relayed?.id === aWelcome?.id);
  check(
    "pose の中身が一致",
    JSON.stringify(relayed?.pos) === JSON.stringify(pose.pos) &&
      relayed?.tracking === true,
  );
  check("A 自身に pose は返らない", !a.msgs.some((m) => m.type === "pose"));

  // ---- クォータニオンの境界検証 ----
  // 非正規化（長さ2）は正規化されてから中継される。
  // pos を最初の pose と変えて、待ち条件が最初の中継と混ざらないようにする
  a.ws.send(
    JSON.stringify({ ...pose, pos: [0.5, 0.5, 0.5], quat: [0, 0, 0, 2] }),
  );
  const normalized = await waitForMsg(
    b,
    (m) => m.type === "pose" && m.pos[0] === 0.5,
  );
  check(
    "非正規化 quat は正規化されて中継される",
    JSON.stringify(normalized?.quat) === JSON.stringify([0, 0, 0, 1]),
  );
  // 退化（長さ ~0.28）・零・オーバーフローは捨てられる。
  // [1e308,...] は各成分が有限でも Math.hypot が Infinity になり、
  // 正規化すると零クォータニオンが生まれてしまうケース（コードレビュー指摘で再現）
  const poseCountBefore = b.msgs.filter((m) => m.type === "pose").length;
  a.ws.send(JSON.stringify({ ...pose, quat: [0.2, 0, 0, 0.2] }));
  a.ws.send(JSON.stringify({ ...pose, quat: [0, 0, 0, 0] }));
  a.ws.send(JSON.stringify({ ...pose, quat: [1e308, 1e308, 1e308, 1e308] }));
  // ---- 不正メッセージも中継されない ----
  a.ws.send("not json");
  a.ws.send(JSON.stringify({ ...pose, pos: [1, 2] }));
  a.ws.send(JSON.stringify({ ...pose, pos: ["x", 2, 3] }));
  a.ws.send(JSON.stringify({ ...pose, pos: [1000, 0, 0] }));
  await sleep(NEGATIVE_WAIT_MS);
  check(
    "退化/零/オーバーフロー quat・不正メッセージ・位置100m超は中継されない",
    b.msgs.filter((m) => m.type === "pose").length === poseCountBefore,
  );

  // ---- Room 隔離 ----
  const c = await tryConnect(buildQuery("t2"));
  await waitForMsg(c, (m) => m.type === "welcome");
  a.ws.send(JSON.stringify(pose));
  await sleep(NEGATIVE_WAIT_MS);
  check(
    "別 room の C に pose は届かない",
    !c.msgs.some((m) => m.type === "pose"),
  );
  check(
    "別 room の C の welcome は peers 空",
    c.msgs.find((m) => m.type === "welcome")?.peers.length === 0,
  );

  // ---- 日本語 room 名（URL 上は percent-encoding） ----
  const d = await tryConnect(buildQuery("会議室"));
  check(
    "日本語 room 名で接続できる",
    !!(await waitForMsg(d, (m) => m.type === "welcome")),
  );
  d.ws.close();

  // ---- 空間設定・バージョンの一致検証 ----
  const mismatch = await tryConnect(buildQuery("t1", { markerMm: 200 }));
  const mmError = await waitForMsg(mismatch, (m) => m.type === "error");
  check(
    "markerMm 不一致は error で入室拒否",
    !!mmError && mmError.reason.includes("空間設定と不一致"),
  );
  const badVersion = await tryConnect(buildQuery("t1", { v: 999 }));
  const vError = await waitForMsg(badVersion, (m) => m.type === "error");
  check(
    "プロトコルバージョン不一致は error で入室拒否",
    !!vError && vError.reason.includes("バージョン不一致"),
  );
  const noConfig = await tryConnect(`room=t1&v=1`);
  const cfgError = await waitForMsg(noConfig, (m) => m.type === "error");
  check("空間設定なしは error で入室拒否", !!cfgError);
  // この時点で A に届いた join は B の1件だけのはず（拒否された3接続は通知されない）
  check(
    "拒否された接続は join として通知されない",
    a.msgs.filter((m) => m.type === "join").length === 1,
  );

  // ---- Heartbeat: pong を返さない half-open 接続は切断され leave が届く ----
  // socket を pause() すると ping が読まれず pong が返らない = half-open 相当
  const ghost = await tryConnect(buildQuery("t1"));
  const ghostWelcome = await waitForMsg(ghost, (m) => m.type === "welcome");
  await waitForMsg(a, (m) => m.type === "join" && m.id === ghostWelcome?.id);
  ghost.ws._socket.pause();
  check(
    "half-open 接続が heartbeat で切断され leave が届く",
    !!(await waitForMsg(
      a,
      (m) => m.type === "leave" && m.id === ghostWelcome?.id,
      HEARTBEAT_MS * 10,
    )),
  );

  // ---- leave 通知 ----
  a.ws.close();
  check(
    "B に A の leave が届く",
    !!(await waitForMsg(b, (m) => m.type === "leave" && m.id === aWelcome?.id)),
  );

  // ---- ハンドシェイク拒否系 ----
  const rejectedRoom = await tryConnect(buildQuery("bad room!")).then(
    () => false,
    () => true,
  );
  check("不正な room 名は接続拒否", rejectedRoom);

  const rejectedOrigin = await tryConnect(buildQuery("t1"), {
    origin: "https://evil.example",
  }).then(
    () => false,
    () => true,
  );
  check("別オリジンのブラウザ接続は拒否", rejectedOrigin);

  const noOrigin = await tryConnect(buildQuery("t1"), { origin: undefined });
  check(
    "Origin なし（非ブラウザクライアント）は接続できる",
    !!(await waitForMsg(noOrigin, (m) => m.type === "welcome")),
  );
  noOrigin.ws.close();

  b.ws.close();
  c.ws.close();
  const failed = results.filter(([, ok]) => !ok);
  console.log(failed.length === 0 ? "\nALL PASS" : `\n${failed.length} FAILED`);
  exitCode = failed.length === 0 ? 0 : 1;
} catch (e) {
  console.error("テスト実行エラー:", e.message ?? e);
} finally {
  server.kill();
}
process.exit(exitCode);
