// 実機のブラウザのログを dev サーバーへ送ってファイルに残す（サーバー側は server/client-log.ts）。
// PAIN_POINTS「実機では console が見えない」への対処。iPhone をゴーグルに入れたまま、あとから
// 「いつ何が起きたか」を PC 側のファイル（logs/client.log）で読めるようにする。
//   - console.log / warn / error を横取りして（元の出力はそのまま）貯め、1 秒ごとにまとめて送る
//   - window の error / unhandledrejection も拾う
//   - snapshot（HUD の 1 行など）を定期的に送れる（状態の履歴が残る）
//   - ページを閉じるときは sendBeacon で取りこぼさない
// ?remoteLog=0 で無効化。送信そのものは失敗しても無視する（ゲームを止めない）
import { CLIENT_LOG_PATH } from "./log-path";

export type RemoteLogOptions = {
  /** ログの出所（"golf-phone" など。ファイルの行頭に出る） */
  tag: string;
  /** 定期的に送る 1 行（HUD の要約など）。同じ内容なら送らない */
  snapshot?: () => string;
  /** snapshot の間隔 [ms]（既定 3000） */
  snapshotMs?: number;
  /** まとめて送る間隔 [ms]（既定 1000） */
  flushMs?: number;
};

type Entry = { t: string; tag: string; level: string; msg: string };

const MAX_QUEUE = 500;

function textOf(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return `${a.name}: ${a.message}`;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
}

/**
 * 開始する。返り値の log() で任意の行を足せる。
 * 二重に呼んでも 1 回だけ効く（複数のモジュールから呼んでも安全）
 */
export function startRemoteLog(opts: RemoteLogOptions): (level: string, msg: string) => void {
  const w = window as Window & { __remoteLog?: (level: string, msg: string) => void };
  if (w.__remoteLog) return w.__remoteLog;
  const params = new URLSearchParams(location.search);
  if (params.get("remoteLog") === "0") {
    const noop = () => {};
    w.__remoteLog = noop;
    return noop;
  }
  const queue: Entry[] = [];
  const push = (level: string, msg: string) => {
    if (queue.length >= MAX_QUEUE) queue.shift();
    queue.push({ t: new Date().toISOString(), tag: opts.tag, level, msg: msg.slice(0, 4000) });
  };

  // console を横取り（元の出力は残す）
  const original: Record<string, (...args: unknown[]) => void> = {};
  for (const level of ["log", "warn", "error"] as const) {
    const orig = console[level].bind(console);
    original[level] = orig;
    console[level] = (...args: unknown[]) => {
      orig(...args);
      push(level, textOf(args));
    };
  }
  addEventListener("error", (e) => push("error", `${e.message} @ ${e.filename}:${e.lineno}`));
  addEventListener("unhandledrejection", (e) => push("error", `unhandled rejection: ${textOf([e.reason])}`));

  const url = `${location.origin}${CLIENT_LOG_PATH}`;
  const send = (entries: Entry[], beacon: boolean) => {
    const body = JSON.stringify(entries);
    try {
      if (beacon && navigator.sendBeacon) {
        navigator.sendBeacon(url, new Blob([body], { type: "application/json" }));
        return;
      }
      void fetch(url, { method: "POST", body, keepalive: true, headers: { "content-type": "application/json" } }).catch(() => {});
    } catch {
      // 送信の失敗は無視（ゲームを止めない）
    }
  };
  const flush = (beacon = false) => {
    if (queue.length === 0) return;
    const entries = queue.splice(0, queue.length);
    send(entries, beacon);
  };

  push("log", `--- start ${opts.tag} ${location.href} ${navigator.userAgent} ---`);
  setInterval(() => flush(), opts.flushMs ?? 1000);
  addEventListener("pagehide", () => {
    push("log", `--- pagehide ${opts.tag} ---`);
    flush(true);
  });
  addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") flush(true);
  });

  if (opts.snapshot) {
    let last = "";
    setInterval(() => {
      let text = "";
      try {
        text = opts.snapshot!();
      } catch (e: unknown) {
        text = `snapshot 失敗: ${e instanceof Error ? e.message : String(e)}`;
      }
      if (text && text !== last) {
        last = text;
        push("state", text);
      }
    }, opts.snapshotMs ?? 3000);
  }

  const api = (level: string, msg: string) => push(level, msg);
  w.__remoteLog = api;
  return api;
}
