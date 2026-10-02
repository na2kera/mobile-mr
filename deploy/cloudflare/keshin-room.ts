// 化身の Room の Durable Object（Cloudflare のアダプタ。Room 1 つ = DO 1 つ。docs/CONCEPT.md の RoomDurableObject）。
// 入室の判定・id の採番・spec の呼び出し・空 Room の破棄予約はコア（server/room-core.ts）、化身の中身は server/keshin-spec.ts で、
// Node の attach()（server/room-server.ts）と同じものを使う。ここは WebSocketPair の実 API を知る薄い皮だけ。
//
// ハイバネーションしない標準の WebSocket API（server.accept() + addEventListener）を使う。Room の状態（players 等）はメモリ上に
// あり、接続が開いている間は DO がメモリに留まる（Cloudflare が保証するのはここまで）ので、状態と接続の整合が取れる。
// 全員が切れた後の 60 秒（空 Room の破棄予約の setTimeout）の間にメモリから追い出されることは保証されていない。追い出されると
// departed（再読み込みの引き継ぎ）と採番が消えるだけで、次の入室は新しい Room として普通に動く（確実にしたければ ctx.storage.setAlarm）。
// ハイバネーション（ctx.acceptWebSocket + webSocketMessage）に移ると接続が開いたまま DO がメモリから消えうるので、
// 状態を serializeAttachment / storage に逃がす作り直しが要る（料金は下がる）。将来の改善として残す。
//
// Node のアダプタとの違い（意図的）:
//   ・maxRooms は数えない（DO は他の Room を知らない。Room の総数は Cloudflare 側の DO の数）
//   ・heartbeat（ws の ping/pong）はしない（Workers の WebSocket に ping の API が無い。切れた接続は close / error で分かる）。
//     スマホのスリープ・Wi-Fi 切断の半開きの接続は検出まで数分かかりうる（その間は Player として残る。同じ session 鍵で戻れば置き換わる）。
//     アプリ層の ping（クライアントの変更が要る）か、ハイバネーション API の setWebSocketAutoResponse が将来の改善
//   ・送信キューの監視（bufferedAmount）はしない（Workers の WebSocket に無い）
//   ・terminate は無い（MemberSocket.terminate が undefined。keshin-spec は close で代用する）
//   ・id は DO ごとに p1 から（Node は全 Room で通し番号）
import { DurableObject } from "cloudflare:workers";
import { RoomCore, admit, type MemberConn } from "../../server/room-core.ts";
import { keshinSpec } from "../../server/keshin-spec.ts";

const spec = keshinSpec();

/** 受信データのバイト数（ws の maxPayload と同じ上限を掛けるため） */
function byteLength(data: string | ArrayBuffer): number {
  return typeof data === "string" ? new TextEncoder().encode(data).byteLength : data.byteLength;
}

export class KeshinRoom extends DurableObject {
  /** この DO の Room（メンバー 0 の破棄予約が切れたら null に戻る。次の入室で作り直す） */
  private room: ReturnType<typeof createRoom> | null = null;
  private nextPlayerNumber = 1;

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    const url = new URL(request.url);
    // room 名と Origin は Worker（worker.ts）で検査済み
    const roomName = url.searchParams.get("room") ?? "";
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    server.accept();
    // 閉じた後にも error（"Network connection lost."）が来る（wrangler dev 4.145 で確認）。退室は close で済んでいるので捨てる。
    // なお、一度もメッセージを送らずに閉じた接続では、この error がリスナーに届かず「Uncaught Error: Network connection lost.」
    // として wrangler のログに出る（最小の Worker でも再現する実行環境側の挙動。Room の状態には影響しない）
    let closed = false;
    server.addEventListener("close", () => {
      closed = true;
    });

    const admission = admit(spec, url, roomName, this.room);
    if (!admission.ok) {
      console.warn(`${spec.tag} rejected: ${admission.reason}`);
      server.addEventListener("error", () => {});
      server.send(JSON.stringify({ type: "error", reason: admission.reason }));
      server.close();
      return new Response(null, { status: 101, webSocket: client });
    }
    if (!this.room) {
      this.room = createRoom(roomName, admission.config, () => `p${this.nextPlayerNumber++}`, () => {
        this.room = null;
      });
    }
    const room = this.room;
    const conn: MemberConn = {
      send(data) {
        if (server.readyState !== WebSocket.OPEN) return;
        try {
          server.send(data);
        } catch {
          // 閉じる途中の送信は捨てる（close イベントで退室する）
        }
      },
      close(code, reason) {
        try {
          if (code === undefined) server.close();
          else server.close(code, reason);
        } catch {
          // 閉じ済み
        }
      },
    };
    const id = room.join(conn, url);
    const leave = () => room.leave(id);
    server.addEventListener("message", (event) => {
      if (byteLength(event.data) > spec.maxPayloadBytes) {
        // ws の maxPayload と同じく 1009 で切る
        console.warn(`${spec.tag} ${id} message too big; closing`);
        conn.close(1009, "Max payload size exceeded");
        leave();
        return;
      }
      room.message(id, event.data);
    });
    server.addEventListener("close", leave);
    server.addEventListener("error", (event) => {
      if (closed) return;
      console.warn(`${spec.tag} ${id} socket error:`, (event as ErrorEvent).message);
      conn.close();
      leave();
    });
    return new Response(null, { status: 101, webSocket: client });
  }
}

function createRoom(name: string, config: Parameters<typeof spec.sameConfig>[0], nextId: () => string, onDestroy: () => void) {
  return new RoomCore(spec, name, config, { nextId, onDestroy });
}
