// ex9-1-keshin（化身）を Cloudflare で配る Worker の入口。役割は振り分けだけ:
//   ・KESHIN_PATH（WebSocket）: room 名と Origin を検査して、Room ごとの Durable Object（keshin-room.ts）へ渡す
//   ・POST CLIENT_LOG_PATH: 実機のログを console.log に流す（`npx wrangler tail` で読む。Workers はファイルに書けない）
//   ・GET /: 化身のページへ
//   ・それ以外: 静的ファイル（dist-keshin/。Workers Static Assets）
import { KESHIN_PATH } from "../../src/shared/keshin-protocol.ts";
import { ROOM_ID_PATTERN } from "../../src/shared/shared-room-protocol.ts";
import { CLIENT_LOG_PATH } from "../../src/shared/log-path.ts";
import type { KeshinRoom } from "./keshin-room.ts";

export { KeshinRoom } from "./keshin-room.ts";

type Env = {
  ASSETS: Fetcher;
  KESHIN_ROOM: DurableObjectNamespace<KeshinRoom>;
};

const KESHIN_PAGE = "/demos/ex9-1-keshin/";
/** 実機ログの 1 リクエストの上限 [バイト]（server/client-log.ts と同じ） */
const MAX_LOG_BODY_BYTES = 256 * 1024;
/** 実機ログの 1 リクエストで受け付けるエントリ数の上限（`[{},{},…]` の洪水で Workers Logs を埋められないように） */
const MAX_LOG_ENTRIES = 200;

/**
 * Origin 検証: ブラウザからの接続・送信はページと同じホストに限る（server/room-server.ts と同じ意図。他サイトからの相乗りを防ぐ）。
 * Origin ヘッダが無い（同一オリジンの GET・curl 等）ときは通す。dev サーバーは LAN 限定だったが、こちらはインターネットに公開される
 */
function sameOrigin(request: Request, url: URL): boolean {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === url.host;
  } catch {
    return false; // 不正な Origin はホスト不一致と同じ扱い
  }
}

/** 制御文字を落として 1 行に潰す（server/client-log.ts と同じ） */
function sanitize(text: string, maxLen = 4000): string {
  return text.replace(/[\r\n]+/g, " ⏎ ").replace(/\p{Cc}/gu, "").slice(0, maxLen);
}

/** 本文を上限まで読む（超えた分は捨てる） */
async function readCapped(request: Request, maxBytes: number): Promise<string> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value.subarray(0, maxBytes - total));
    total += Math.min(value.byteLength, maxBytes - total);
  }
  void reader.cancel().catch(() => {});
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(buf);
}

async function handleClientLog(request: Request, url: URL): Promise<Response> {
  // DELETE（dev サーバーではログファイルを空にする）は、ファイルが無いので何もしない
  if (request.method === "DELETE") return new Response(null, { status: 204 });
  if (request.method !== "POST") return new Response(null, { status: 405 });
  // 公開 URL なので他サイトからの sendBeacon は受けない。訪問者全員の console がここに来る（remote-log.ts は ?remoteLog=0 以外で常に有効）
  if (!sameOrigin(request, url)) return new Response("forbidden origin", { status: 403 });
  const body = await readCapped(request, MAX_LOG_BODY_BYTES);
  let entries: { t?: string; tag?: string; level?: string; msg?: string }[];
  try {
    const parsed: unknown = JSON.parse(body);
    entries = Array.isArray(parsed) ? parsed : [parsed as Record<string, string>];
  } catch {
    console.warn("[client-log] 壊れた JSON を受け取った");
    return new Response(null, { status: 204 });
  }
  const ip = request.headers.get("CF-Connecting-IP") ?? "?";
  if (entries.length > MAX_LOG_ENTRIES) {
    console.warn(`[client-log] ${ip} から ${entries.length} 件。先頭 ${MAX_LOG_ENTRIES} 件だけ出す`);
    entries = entries.slice(0, MAX_LOG_ENTRIES);
  }
  for (const e of entries) {
    if (typeof e !== "object" || e === null) continue;
    console.log(`[client-log] ${e.t ?? new Date().toISOString()} [${sanitize(String(e.tag ?? "?"), 40)}@${ip}] ${sanitize(String(e.level ?? "log"), 12)}: ${sanitize(String(e.msg ?? ""))}`);
  }
  return new Response(null, { status: 204 });
}

function handleKeshinSocket(request: Request, url: URL, env: Env): Response | Promise<Response> {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected WebSocket", { status: 426 });
  }
  const room = url.searchParams.get("room") ?? "";
  if (!ROOM_ID_PATTERN.test(room)) return new Response("bad room", { status: 400 });
  if (!sameOrigin(request, url)) {
    console.warn(`[keshin] rejected connection from origin "${request.headers.get("Origin")}" (host: ${url.host})`);
    return new Response("forbidden origin", { status: 403 });
  }
  const stub = env.KESHIN_ROOM.get(env.KESHIN_ROOM.idFromName(room));
  return stub.fetch(request);
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === KESHIN_PATH) return handleKeshinSocket(request, url, env);
    if (url.pathname === CLIENT_LOG_PATH) return handleClientLog(request, url);
    if (url.pathname === "/" && (request.method === "GET" || request.method === "HEAD")) {
      return Response.redirect(new URL(KESHIN_PAGE, url).toString(), 302);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
