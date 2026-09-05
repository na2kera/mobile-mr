// 実機（iPhone / PC）のブラウザのログを dev サーバーのファイルに書き出す。
// PAIN_POINTS「実機では console が見えない」への対処で、HUD に出すだけでは追えない
// 「いつ何が起きたか」の履歴を後から読めるようにする（開発者が実機の前を離れても調べられる）。
// クライアント側は src/shared/remote-log.ts。dev / preview サーバーにだけ付ける（本番の口ではない）
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Connect, Plugin } from "vite";
import { CLIENT_LOG_PATH } from "../src/shared/log-path.ts";

export { CLIENT_LOG_PATH };

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_DIR = join(ROOT, "logs");
const LOG_FILE = join(LOG_DIR, "client.log");
/** これを超えたら client.log.1 に退避して新しく始める [バイト] */
const MAX_BYTES = 8 * 1024 * 1024;
/** 1 リクエストの上限 [バイト] */
const MAX_BODY_BYTES = 256 * 1024;

function rotateIfNeeded() {
  try {
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > MAX_BYTES) {
      renameSync(LOG_FILE, `${LOG_FILE}.1`);
    }
  } catch {
    // 退避に失敗しても書き込みは続ける
  }
}

/** 制御文字を落として 1 行に潰す（ログの行がずれないように） */
function sanitize(text: string, maxLen = 4000): string {
  return text.replace(/[\r\n]+/g, " ⏎ ").replace(/\p{Cc}/gu, "").slice(0, maxLen);
}

export function clientLogServer(): Plugin {
  const handler: Connect.NextHandleFunction = (req, res, next) => {
    if (!req.url?.startsWith(CLIENT_LOG_PATH)) return next();
    if (req.method === "DELETE") {
      try {
        mkdirSync(LOG_DIR, { recursive: true });
        writeFileSync(LOG_FILE, "");
        console.log("[client-log] cleared");
      } catch (e) {
        console.warn("[client-log] clear failed:", e);
      }
      res.statusCode = 204;
      res.end();
      return;
    }
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end();
      return;
    }
    let body = "";
    let tooBig = false;
    req.on("data", (chunk: Buffer) => {
      if (tooBig) return;
      body += chunk.toString("utf8");
      if (body.length > MAX_BODY_BYTES) {
        tooBig = true;
        body = body.slice(0, MAX_BODY_BYTES);
      }
    });
    req.on("end", () => {
      // 204 は先に返す（クライアントを待たせない。sendBeacon は応答を見ない）
      res.statusCode = 204;
      res.end();
      let entries: { t?: string; tag?: string; level?: string; msg?: string }[];
      try {
        const parsed: unknown = JSON.parse(body);
        entries = Array.isArray(parsed) ? parsed : [parsed as Record<string, string>];
      } catch {
        console.warn("[client-log] 壊れた JSON を受け取った");
        return;
      }
      const ip = (req.socket.remoteAddress ?? "?").replace(/^::ffff:/, "");
      const lines = entries
        .filter((e): e is { t?: string; tag?: string; level?: string; msg?: string } => typeof e === "object" && e !== null)
        .map((e) => `${e.t ?? new Date().toISOString()} [${sanitize(String(e.tag ?? "?"), 40)}@${ip}] ${sanitize(String(e.level ?? "log"), 12)}: ${sanitize(String(e.msg ?? ""))}`);
      if (lines.length === 0) return;
      try {
        mkdirSync(LOG_DIR, { recursive: true });
        rotateIfNeeded();
        appendFileSync(LOG_FILE, lines.join("\n") + "\n");
      } catch (e) {
        console.warn("[client-log] 書き込み失敗:", e);
      }
    });
  };
  return {
    name: "client-log-server",
    configureServer(server) {
      server.middlewares.use(handler);
      console.log(`[client-log] ${LOG_FILE} に書き出します（クライアントは ?remoteLog=0 で無効化）`);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
  };
}
