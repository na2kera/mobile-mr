// Room サーバーの共通部分。04（shared-room）/ 06（volleyball）/ 06-2（darts）で 3 回写した
// 「Vite の HTTPS サーバーに WebSocket を同居させ、Origin 検証・プロトコルバージョン・Room 設定の
// 一致検証・heartbeat・メンバー 0 の後始末・welcome / join / leave」を、4 本目（07 surface）で
// 抽出した（PAIN_POINTS「Room サーバーのボイラープレートが 3 本目になった」の案そのもの）。
// 差分は「Room 設定のスキーマ」「メッセージのスキーマ」「Room の状態と tick」の 3 点で、それを
// spec として受け取る。04 / 06 / 06-2 のサーバーは過去のデモとして手を付けず、07 以降がこれを使う
import process from "node:process";
import type { HttpServer, Plugin } from "vite";
import { WebSocketServer, type WebSocket, type RawData } from "ws";
import { ROOM_ID_PATTERN } from "../src/shared/shared-room-protocol.ts";
import { RoomCore, admit, type MemberConn, type WireData } from "./room-core.ts";

// 型と判定はコア（server/room-core.ts）に移した。既存の import（surface.ts など）のためにここからも出す
export type { MemberSocket, RoomContext, RoomServerSpec, WireData } from "./room-core.ts";
export { isVec, parseName, wireText } from "./room-core.ts";
import type { RoomServerSpec } from "./room-core.ts";

const HEARTBEAT_INTERVAL_MS = Number(process.env.SHARED_ROOM_HEARTBEAT_MS ?? "") || 10000;

type LiveWebSocket = WebSocket & { isAlive?: boolean };

/**
 * 送信キューがこれを超えたクライアントは切る（遅い接続にメッセージが溜まり続けるのを防ぐ。
 * 切られたクライアントは再接続して welcome の snapshot で追いつく）
 */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

/** ws の RawData をコアの WireData にする（Buffer[] は連結。Buffer は ArrayBufferView なので spec の toString() もそのまま動く） */
function toWireData(data: RawData): WireData {
  return Array.isArray(data) ? Buffer.concat(data) : data;
}

/** Node（ws）のアダプタ。複数の Room を 1 プロセスで持ち、heartbeat と送信キューの監視と maxRooms はここで行う */
function attach<C, S, M>(httpServer: HttpServer, spec: RoomServerSpec<C, S, M>) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: spec.maxPayloadBytes });
  type Room = RoomCore<C, S, M>;
  const rooms = new Map<string, Room>();
  /** heartbeat で見る接続（Room をまたいで全部） */
  const sockets = new Set<LiveWebSocket>();
  let nextPlayerNumber = 1;

  const heartbeat = setInterval(() => {
    for (const ws of sockets) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);
  httpServer.on("close", () => {
    clearInterval(heartbeat);
    for (const room of rooms.values()) room.stopTimers();
  });

  function sendOrDrop(id: string, ws: WebSocket, data: string) {
    if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      console.warn(`${spec.tag} ${id} is too slow (${ws.bufferedAmount} bytes queued); terminating`);
      ws.terminate();
      return;
    }
    ws.send(data);
  }

  function reject(ws: WebSocket, reason: string) {
    console.warn(`${spec.tag} rejected: ${reason}`);
    // close 中に不正フレームが来ると 'error' が出る。リスナーが無いと EventEmitter が throw して dev サーバーごと落ちる
    ws.on("error", () => {});
    ws.send(JSON.stringify({ type: "error", reason }));
    ws.close();
  }

  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "", "http://localhost");
    if (url.pathname !== spec.path) return;
    const roomName = url.searchParams.get("room") ?? "";
    if (!ROOM_ID_PATTERN.test(roomName)) {
      socket.destroy();
      return;
    }
    // Origin 検証: ブラウザからの接続はページと同じホストに限る（LAN の他ページからの相乗りを防ぐ）
    const origin = req.headers.origin;
    if (origin) {
      let originHost: string | null = null;
      try {
        originHost = new URL(origin).host;
      } catch {
        // 不正な Origin はホスト不一致と同じ扱い
      }
      if (originHost !== req.headers.host) {
        console.warn(`${spec.tag} rejected connection from origin "${origin}" (host: ${req.headers.host})`);
        socket.destroy();
        return;
      }
    }
    wss.handleUpgrade(req, socket, head, (ws: LiveWebSocket) => {
      const existing = rooms.get(roomName);
      const admission = admit(spec, url, roomName, existing, () =>
        spec.maxRooms !== undefined && rooms.size >= spec.maxRooms
          ? `room の数が上限 (${spec.maxRooms}) に達しています。既存の room に入ってください`
          : null,
      );
      if (!admission.ok) {
        reject(ws, admission.reason);
        return;
      }
      let r = existing;
      if (!r) {
        const created: Room = new RoomCore(spec, roomName, admission.config, {
          nextId: () => `p${nextPlayerNumber++}`,
          onDestroy: () => rooms.delete(roomName),
        });
        rooms.set(roomName, created);
        r = created;
      }
      const room = r;
      ws.isAlive = true;
      ws.on("pong", () => {
        ws.isAlive = true;
      });
      sockets.add(ws);
      let id = "";
      const conn: MemberConn = {
        send: (data) => {
          if (ws.readyState === ws.OPEN) sendOrDrop(id, ws, data);
        },
        close: (code, reason) => ws.close(code, reason),
        terminate: () => ws.terminate(),
      };
      id = room.join(conn, url);

      ws.on("message", (data) => room.message(id, toWireData(data)));
      const leave = () => {
        sockets.delete(ws);
        room.leave(id);
      };
      ws.on("close", leave);
      ws.on("error", (e) => {
        console.warn(`${spec.tag} ${id} socket error:`, e.message);
        ws.close();
        leave();
      });
    });
  });
}

/** dev / preview の両方に同居させる Vite プラグインを作る */
export function roomServerPlugin<C, S, M>(name: string, spec: RoomServerSpec<C, S, M>): Plugin {
  return {
    name,
    configureServer(server) {
      if (server.httpServer) attach(server.httpServer, spec);
    },
    configurePreviewServer(server) {
      if (server.httpServer) attach(server.httpServer, spec);
    },
  };
}
