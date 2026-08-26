// Phase 6-2 (06-2-darts) 用の対戦サーバー。04 / 06 と同じく Vite プラグインとして dev/preview の
// HTTPS サーバーに同居させる。接続の受け付け・heartbeat・Origin 検証・Room 設定の一致検証は
// 06 の server/volleyball.ts からの写し（3 本目。PAIN_POINTS「Room サーバーのボイラープレートが
// 3 本目になった」参照）。ルールは src/shared/darts-game.ts の純粋クラスで、ここは WebSocket と
// tick ループの皮だけ
import process from "node:process";
import type { HttpServer, Plugin } from "vite";
import { WebSocketServer, type WebSocket, type RawData } from "ws";
import { ROOM_ID_PATTERN } from "../src/shared/shared-room-protocol.ts";
import {
  DARTS_PATH,
  DARTS_PROTOCOL_VERSION,
  HAND_FLAT_LENGTH,
  NAME_MAX_LENGTH,
  type ClientMessage,
  type DartsRoomConfig,
  type PlayerPose,
  type ServerMessage,
} from "../src/shared/darts-protocol.ts";
import { DartsGame } from "../src/shared/darts-game.ts";
import { DEFAULT_DARTS, type V3 } from "../src/shared/darts-sim.ts";

const MAX_PAYLOAD_BYTES = 8 * 1024;
const HEARTBEAT_INTERVAL_MS =
  Number(process.env.SHARED_ROOM_HEARTBEAT_MS ?? "") || 10000;
/** 遷移の確認間隔。物理はサーバーで積分しない（着地は投げた瞬間に解析的に決まる）ので粗くて良い */
const TICK_MS = 50;
/** 出来事が無いときの状態配信間隔（再接続直後の取りこぼし・時計合わせ用） */
const IDLE_BROADCAST_MS = 1000;

type LiveWebSocket = WebSocket & { isAlive?: boolean };

type Room = {
  config: DartsRoomConfig;
  game: DartsGame;
  members: Map<string, LiveWebSocket>;
  timer: ReturnType<typeof setInterval>;
  lastBroadcastMs: number;
};

const isVec = (v: unknown, len: number): v is number[] =>
  Array.isArray(v) &&
  v.length === len &&
  v.every((n) => typeof n === "number" && Number.isFinite(n));

function parseClientMessage(data: RawData): ClientMessage | null {
  let msg: unknown;
  try {
    msg = JSON.parse(data.toString());
  } catch {
    return null;
  }
  if (typeof msg !== "object" || msg === null) return null;
  const m = msg as Record<string, unknown>;
  if (m.type === "pose") {
    if (!isVec(m.pos, 3) || !isVec(m.quat, 4)) return null;
    if (typeof m.tracking !== "boolean") return null;
    if (m.quat.some((v) => Math.abs(v) > 1e6)) return null;
    const quatLen = Math.hypot(...m.quat);
    if (!Number.isFinite(quatLen) || quatLen < 0.5) return null;
    if (m.pos.some((v) => Math.abs(v) > 100)) return null;
    let hands: number[][] | undefined;
    if (m.hands !== undefined) {
      if (
        !Array.isArray(m.hands) ||
        m.hands.length > 2 ||
        !m.hands.every((h) => isVec(h, HAND_FLAT_LENGTH) && h.every((v) => Math.abs(v) <= 100))
      ) {
        return null;
      }
      hands = m.hands as number[][];
    }
    const pose: PlayerPose = {
      pos: m.pos as V3,
      quat: m.quat.map((v) => v / quatLen) as unknown as PlayerPose["quat"],
      tracking: m.tracking,
    };
    if (hands) pose.hands = hands;
    return { type: "pose", ...pose };
  }
  if (m.type === "throw") {
    if (!isVec(m.pos, 3) || !isVec(m.vel, 3)) return null;
    if (m.pos.some((v) => Math.abs(v) > 100)) return null;
    if (m.vel.some((v) => Math.abs(v) > 50)) return null;
    return { type: "throw", pos: m.pos as V3, vel: m.vel as V3 };
  }
  return null;
}

function parseRoomConfig(url: URL): DartsRoomConfig | null {
  const markerId = Number(url.searchParams.get("markerId") ?? NaN);
  const markerMm = Number(url.searchParams.get("markerMm") ?? NaN);
  if (!Number.isInteger(markerId) || markerId < 0 || markerId > 999) return null;
  if (!Number.isFinite(markerMm) || markerMm <= 0 || markerMm > 5000) return null;
  const num = (name: string, fallback: number, min: number, max: number) => {
    const raw = url.searchParams.get(name);
    if (raw === null) return fallback;
    const v = Number(raw);
    return Number.isFinite(v) && v >= min && v <= max ? v : null;
  };
  const gravity = num("gravity", DEFAULT_DARTS.gravity, 0, 30);
  const rounds = num("rounds", DEFAULT_DARTS.rounds, 1, 20);
  if (gravity === null || rounds === null || !Number.isInteger(rounds)) return null;
  return { markerId, markerMm, gravity, rounds };
}

/** 表示名。無ければ id をそのまま使う。長さと制御文字だけ弾く */
function parseName(url: URL, fallback: string): string {
  const raw = (url.searchParams.get("name") ?? "").trim();
  if (raw === "") return fallback;
  const cleaned = raw.replace(/\p{Cc}/gu, "");
  return [...cleaned].slice(0, NAME_MAX_LENGTH).join("") || fallback;
}

function sameConfig(a: DartsRoomConfig, b: DartsRoomConfig): boolean {
  return (
    a.markerId === b.markerId &&
    a.markerMm === b.markerMm &&
    a.gravity === b.gravity &&
    a.rounds === b.rounds
  );
}

function describeConfig(c: DartsRoomConfig): string {
  return `markerId=${c.markerId} markerMm=${c.markerMm} gravity=${c.gravity} rounds=${c.rounds}`;
}

function attach(httpServer: HttpServer) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
  const rooms = new Map<string, Room>();
  let nextPlayerNumber = 1;

  const heartbeat = setInterval(() => {
    for (const room of rooms.values()) {
      for (const ws of room.members.values()) {
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
    for (const room of rooms.values()) clearInterval(room.timer);
  });

  function send(ws: WebSocket, msg: ServerMessage) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  function broadcast(room: Room, msg: ServerMessage, excludeId?: string) {
    const data = JSON.stringify(msg);
    for (const [id, ws] of room.members) {
      if (id !== excludeId && ws.readyState === ws.OPEN) ws.send(data);
    }
  }

  function broadcastState(room: Room, now: number) {
    room.lastBroadcastMs = now;
    broadcast(room, { type: "state", state: room.game.snapshot(now) });
  }

  function reject(ws: WebSocket, reason: string) {
    console.warn(`[darts] rejected: ${reason}`);
    ws.send(JSON.stringify({ type: "error", reason } satisfies ServerMessage));
    ws.close();
  }

  function createRoom(name: string, config: DartsRoomConfig): Room {
    const game = new DartsGame({
      config: { ...DEFAULT_DARTS, gravity: config.gravity, rounds: config.rounds },
    });
    const room: Room = {
      config,
      game,
      members: new Map(),
      lastBroadcastMs: -Infinity,
      timer: setInterval(() => {
        const now = performance.now();
        const events = room.game.tick(now);
        if (events.length > 0 || now - room.lastBroadcastMs >= IDLE_BROADCAST_MS) {
          broadcastState(room, now);
        }
      }, TICK_MS),
    };
    rooms.set(name, room);
    return room;
  }

  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "", "http://localhost");
    if (url.pathname !== DARTS_PATH) return;
    const roomName = url.searchParams.get("room") ?? "";
    if (!ROOM_ID_PATTERN.test(roomName)) {
      socket.destroy();
      return;
    }
    const origin = req.headers.origin;
    if (origin) {
      let originHost: string | null = null;
      try {
        originHost = new URL(origin).host;
      } catch {
        // 不正な Origin はホスト不一致と同じ扱い
      }
      if (originHost !== req.headers.host) {
        console.warn(`[darts] rejected connection from origin "${origin}" (host: ${req.headers.host})`);
        socket.destroy();
        return;
      }
    }
    wss.handleUpgrade(req, socket, head, (ws: LiveWebSocket) => {
      const version = Number(url.searchParams.get("v") ?? NaN);
      if (version !== DARTS_PROTOCOL_VERSION) {
        reject(
          ws,
          `プロトコルバージョン不一致 (server: ${DARTS_PROTOCOL_VERSION} / client: ${url.searchParams.get("v") ?? "なし"})。ページを再読み込みしてください`,
        );
        return;
      }
      const config = parseRoomConfig(url);
      if (!config) {
        reject(ws, "Room 設定 (markerId / markerMm / gravity / rounds) が不正です");
        return;
      }
      let room = rooms.get(roomName);
      if (room && !sameConfig(room.config, config)) {
        reject(
          ws,
          `room "${roomName}" の設定と不一致 (参加中: ${describeConfig(room.config)} / あなた: ${describeConfig(config)})`,
        );
        return;
      }
      if (!room) room = createRoom(roomName, config);
      const { members, game } = room;
      const id = `p${nextPlayerNumber++}`;
      const name = parseName(url, id);
      const now = performance.now();
      ws.isAlive = true;
      ws.on("pong", () => {
        ws.isAlive = true;
      });
      game.join(id, name, now);
      send(ws, {
        type: "welcome",
        id,
        peers: [...members.keys()],
        config: game.config,
        state: game.snapshot(now),
      });
      broadcast(room, { type: "join", id });
      members.set(id, ws);
      // 参加で手番が変わった可能性があるので全員に配る（welcome は本人にしか届かない）
      broadcastState(room, now);
      console.log(`[darts] ${id} "${name}" joined room "${roomName}" (${members.size} members)`);

      ws.on("message", (data) => {
        const msg = parseClientMessage(data);
        if (!msg) return;
        const t = performance.now();
        if (msg.type === "pose") {
          game.updatePose(id, t);
          const { type: _type, ...pose } = msg;
          broadcast(room, { type: "pose", id, ...pose }, id);
        } else if (msg.type === "throw") {
          if (game.throw(id, msg.pos, msg.vel, t)) {
            const d = game.state.darts[game.state.darts.length - 1];
            console.log(
              `[darts] ${id} throw #${d.index + 1}: ${d.landing.score.label} (${d.landing.score.points}) end=(${d.landing.end.map((v) => v.toFixed(2)).join(",")}) from=(${msg.pos.map((v) => v.toFixed(2)).join(",")}) vel=(${msg.vel.map((v) => v.toFixed(2)).join(",")})`,
            );
            broadcastState(room, t);
          } else {
            console.log(`[darts] ${id} throw rejected: ${game.lastRejectReason}`);
            send(ws, { type: "state", state: game.rejectionSnapshot(id, t) });
          }
        }
      });
      const leave = () => {
        if (!members.delete(id)) return;
        const t = performance.now();
        game.leave(id, t);
        if (members.size === 0) {
          clearInterval(room.timer);
          rooms.delete(roomName);
        } else {
          broadcast(room, { type: "leave", id });
          broadcastState(room, t);
        }
        console.log(`[darts] ${id} left room "${roomName}" (${members.size} members)`);
      };
      ws.on("close", leave);
      ws.on("error", (e) => {
        console.warn(`[darts] ${id} socket error:`, e.message);
        ws.close();
        leave();
      });
    });
  });
}

export function dartsServer(): Plugin {
  return {
    name: "darts-server",
    configureServer(server) {
      if (server.httpServer) attach(server.httpServer);
    },
    configurePreviewServer(server) {
      if (server.httpServer) attach(server.httpServer);
    },
  };
}
