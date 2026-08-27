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

const HEARTBEAT_INTERVAL_MS = Number(process.env.SHARED_ROOM_HEARTBEAT_MS ?? "") || 10000;

type LiveWebSocket = WebSocket & { isAlive?: boolean };

/** 1 Room のコンテキスト。spec のフックに渡す */
export type RoomContext<C, S> = {
  readonly name: string;
  readonly config: C;
  readonly state: S;
  readonly members: ReadonlyMap<string, WebSocket>;
  send(id: string, msg: unknown): void;
  broadcast(msg: unknown, excludeId?: string): void;
};

export type RoomServerSpec<C, S, M> = {
  /** ログの接頭辞（"[surface]" 等） */
  tag: string;
  /** WebSocket のアップグレード先パス（Vite の HMR と衝突しない値） */
  path: string;
  protocolVersion: number;
  maxPayloadBytes: number;
  /** 接続クエリから Room 設定を読む。不正なら null（入室拒否） */
  parseConfig(url: URL): C | null;
  sameConfig(a: C, b: C): boolean;
  describeConfig(c: C): string;
  /** parseConfig が null のときに返す理由 */
  configErrorReason: string;
  /** 受信メッセージの検証。不正なら null（黙って捨てる） */
  parseMessage(data: RawData): M | null;
  createState(name: string, config: C): S;
  /** tick の間隔 [ms]。省略時は tick しない */
  tickMs?: number;
  onTick?(room: RoomContext<C, S>, now: number): void;
  /**
   * 入室。welcome の送信と全員への join の通知は spec が行う（内容がデモごとに違うため）。
   * 呼ばれた時点で本人は既に members に入っているので、join を broadcast するときは excludeId=id を渡す
   * （04/06/06-2 は members に入れる前に broadcast していたので、そこから写すときは注意）
   */
  onJoin(room: RoomContext<C, S>, id: string, url: URL, now: number): void;
  onMessage(room: RoomContext<C, S>, id: string, msg: M, now: number): void;
  /** 退室（切断）。leave の通知は spec が行う。members からは既に消えている */
  onLeave(room: RoomContext<C, S>, id: string, now: number): void;
  /** メンバーが 0 になり Room を捨てるとき */
  destroyState?(state: S): void;
  /**
   * メンバーが 0 になってから Room を捨てるまでの猶予 [ms]（省略時 0 = 即捨てる）。
   * 状態を持つ Room（07 のペイント）は、1 人利用中の Wi-Fi 瞬断・bfcache で全部消えないようにここを長くする
   */
  emptyRoomTtlMs?: number;
  /** Room の人数上限（省略時は無制限）。全員に fan-out するので人数の二乗で重くなる */
  maxMembers?: number;
  /** maxMembers で断るときの理由 */
  fullReason?: string;
};

/** 表示名。無ければ fallback。長さと制御文字だけ弾く */
export function parseName(url: URL, fallback: string, maxLength: number): string {
  const raw = (url.searchParams.get("name") ?? "").trim();
  if (raw === "") return fallback;
  const cleaned = raw.replace(/\p{Cc}/gu, "");
  return [...cleaned].slice(0, maxLength).join("") || fallback;
}

export const isVec = (v: unknown, len: number): v is number[] =>
  Array.isArray(v) && v.length === len && v.every((n) => typeof n === "number" && Number.isFinite(n));

function attach<C, S, M>(httpServer: HttpServer, spec: RoomServerSpec<C, S, M>) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: spec.maxPayloadBytes });
  type Room = RoomContext<C, S> & {
    membersMut: Map<string, LiveWebSocket>;
    timer: ReturnType<typeof setInterval> | null;
    /** メンバー 0 で捨てる予約（猶予中に誰か入れば取り消す） */
    destroyTimer: ReturnType<typeof setTimeout> | null;
  };
  const rooms = new Map<string, Room>();
  let nextPlayerNumber = 1;

  const heartbeat = setInterval(() => {
    for (const room of rooms.values()) {
      for (const ws of room.membersMut.values()) {
        if (ws.isAlive === false) {
          ws.terminate();
          continue;
        }
        ws.isAlive = false;
        ws.ping();
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
  httpServer.on("close", () => {
    clearInterval(heartbeat);
    for (const room of rooms.values()) {
      if (room.timer) clearInterval(room.timer);
      if (room.destroyTimer) clearTimeout(room.destroyTimer);
    }
  });

  function destroyRoom(room: Room) {
    if (room.timer) clearInterval(room.timer);
    if (room.destroyTimer) clearTimeout(room.destroyTimer);
    spec.destroyState?.(room.state);
    rooms.delete(room.name);
    console.log(`${spec.tag} room "${room.name}" destroyed`);
  }

  function reject(ws: WebSocket, reason: string) {
    console.warn(`${spec.tag} rejected: ${reason}`);
    // close 中に不正フレームが来ると 'error' が出る。リスナーが無いと EventEmitter が throw して dev サーバーごと落ちる
    ws.on("error", () => {});
    ws.send(JSON.stringify({ type: "error", reason }));
    ws.close();
  }

  function createRoom(name: string, config: C): Room {
    const membersMut = new Map<string, LiveWebSocket>();
    const room: Room = {
      name,
      config,
      state: spec.createState(name, config),
      members: membersMut,
      membersMut,
      timer: null,
      destroyTimer: null,
      send(id, msg) {
        const ws = membersMut.get(id);
        if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
      },
      broadcast(msg, excludeId) {
        const data = JSON.stringify(msg);
        for (const [id, ws] of membersMut) {
          if (id !== excludeId && ws.readyState === ws.OPEN) ws.send(data);
        }
      },
    };
    if (spec.tickMs && spec.onTick) {
      room.timer = setInterval(() => spec.onTick!(room, performance.now()), spec.tickMs);
    }
    rooms.set(name, room);
    return room;
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
      const version = Number(url.searchParams.get("v") ?? NaN);
      if (version !== spec.protocolVersion) {
        reject(
          ws,
          `プロトコルバージョン不一致 (server: ${spec.protocolVersion} / client: ${url.searchParams.get("v") ?? "なし"})。ページを再読み込みしてください`,
        );
        return;
      }
      const config = spec.parseConfig(url);
      if (!config) {
        reject(ws, spec.configErrorReason);
        return;
      }
      let room = rooms.get(roomName);
      if (room && !spec.sameConfig(room.config, config)) {
        reject(
          ws,
          `room "${roomName}" の設定と不一致 (参加中: ${spec.describeConfig(room.config)} / あなた: ${spec.describeConfig(config)})`,
        );
        return;
      }
      if (room && spec.maxMembers !== undefined && room.membersMut.size >= spec.maxMembers) {
        reject(ws, spec.fullReason ?? `room "${roomName}" は満員です (${spec.maxMembers} 人まで)`);
        return;
      }
      if (!room) room = createRoom(roomName, config);
      const r = room;
      if (r.destroyTimer) {
        clearTimeout(r.destroyTimer);
        r.destroyTimer = null;
      }
      const id = `p${nextPlayerNumber++}`;
      ws.isAlive = true;
      ws.on("pong", () => {
        ws.isAlive = true;
      });
      r.membersMut.set(id, ws);
      spec.onJoin(r, id, url, performance.now());
      console.log(`${spec.tag} ${id} joined room "${roomName}" (${r.membersMut.size} members)`);

      ws.on("message", (data) => {
        // error → close は非同期なので、退室処理の後に届いたメッセージは捨てる
        if (!r.membersMut.has(id)) return;
        const msg = spec.parseMessage(data);
        if (msg === null) return;
        spec.onMessage(r, id, msg, performance.now());
      });
      const leave = () => {
        if (!r.membersMut.delete(id)) return;
        const now = performance.now();
        spec.onLeave(r, id, now);
        if (r.membersMut.size === 0) {
          const ttl = spec.emptyRoomTtlMs ?? 0;
          if (ttl > 0) {
            r.destroyTimer = setTimeout(() => destroyRoom(r), ttl);
          } else {
            destroyRoom(r);
          }
        }
        console.log(`${spec.tag} ${id} left room "${roomName}" (${r.membersMut.size} members)`);
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
