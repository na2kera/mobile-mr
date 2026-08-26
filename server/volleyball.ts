// Phase 6 (06-volleyball) 用の対戦サーバー。04 の shared-room.ts と同じく Vite プラグインとして
// dev/preview の HTTPS サーバーに同居させる（理由は shared-room.ts と PAIN_POINTS
// 「自己署名 HTTPS 運用では wss サーバーを別に立てられず…」を参照）。
// 04 との違い: pose の中継に加えて、サーバーがボールの物理・得点・bot の権威を持つ
// （ルールは src/shared/volleyball-game.ts。ここは WebSocket と tick ループの皮だけ）。
// 04 のサーバーを拡張せず別ファイルにしたのは、04 のデモをそのまま残すため
// （接続の受け付け・ハートビート・Origin 検証は 04 からの写し。PAIN_POINTS に記録）
import process from "node:process";
import type { HttpServer, Plugin } from "vite";
import { WebSocketServer, type WebSocket, type RawData } from "ws";
import { ROOM_ID_PATTERN } from "../src/shared/shared-room-protocol.ts";
import {
  HAND_FLAT_LENGTH,
  VOLLEYBALL_PATH,
  VOLLEYBALL_PROTOCOL_VERSION,
  type ClientMessage,
  type PlayerPose,
  type ServerMessage,
  type VolleyballRoomConfig,
} from "../src/shared/volleyball-protocol.ts";
import { VolleyballGame } from "../src/shared/volleyball-game.ts";
import { DEFAULT_COURT, SERVE_FLIGHT_FACTOR, type V3 } from "../src/shared/volleyball-sim.ts";

/** 1メッセージの上限。pose + 両手（63 数値 × 2）の JSON で 2KB 前後 */
const MAX_PAYLOAD_BYTES = 8 * 1024;

// 回帰テストが half-open 切断を実時間で待てるよう短縮できる（04 と同じ環境変数を共用）
const HEARTBEAT_INTERVAL_MS =
  Number(process.env.SHARED_ROOM_HEARTBEAT_MS ?? "") || 10000;

/** 物理の刻み。60Hz（クライアントの描画と同程度。放物線なので粗くても誤差は小さい） */
const TICK_MS = 1000 / 60;
/** ラリー中の状態配信間隔。クライアントは受信のたびに外挿の基準を取り直す */
const RALLY_BROADCAST_MS = 50;
/** ラリー以外（待機・ポイント表示中）の配信間隔 */
const IDLE_BROADCAST_MS = 500;

type LiveWebSocket = WebSocket & { isAlive?: boolean };

type Room = {
  config: VolleyballRoomConfig;
  game: VolleyballGame;
  members: Map<string, LiveWebSocket>;
  timer: ReturnType<typeof setInterval>;
  lastTickMs: number;
  lastBroadcastMs: number;
};

const isVec = (v: unknown, len: number): v is number[] =>
  Array.isArray(v) &&
  v.length === len &&
  v.every((n) => typeof n === "number" && Number.isFinite(n));

/** 受信データを検証する。壊れたものは null（04 の parsePoseMessage と同じ境界の考え方） */
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
        !m.hands.every(
          (h) => isVec(h, HAND_FLAT_LENGTH) && h.every((v) => Math.abs(v) <= 100),
        )
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
  if (m.type === "hit") {
    if (!isVec(m.pos, 3) || !isVec(m.handVel, 3)) return null;
    if (m.pos.some((v) => Math.abs(v) > 100)) return null;
    if (m.handVel.some((v) => Math.abs(v) > 50)) return null;
    return { type: "hit", pos: m.pos as V3, handVel: m.handVel as V3 };
  }
  return null;
}

function parseRoomConfig(url: URL): VolleyballRoomConfig | null {
  const markerId = Number(url.searchParams.get("markerId") ?? NaN);
  const markerMm = Number(url.searchParams.get("markerMm") ?? NaN);
  if (!Number.isInteger(markerId) || markerId < 0 || markerId > 999) return null;
  if (!Number.isFinite(markerMm) || markerMm <= 0 || markerMm > 5000)
    return null;
  const netTopRaw = url.searchParams.get("netTop") ?? "auto";
  let netTop: number | "auto";
  if (netTopRaw === "auto") {
    netTop = "auto";
  } else {
    const v = Number(netTopRaw);
    if (!Number.isFinite(v) || v < 0.1 || v > 3) return null;
    netTop = v;
  }
  // 軌道パラメータ（クライアントの numParam と同じ範囲。未指定は既定値）
  const num = (name: string, fallback: number, min: number, max: number) => {
    const raw = url.searchParams.get(name);
    if (raw === null) return fallback;
    const v = Number(raw);
    return Number.isFinite(v) && v >= min && v <= max ? v : null;
  };
  const gravity = num("gravity", DEFAULT_COURT.gravity, 0.5, 20);
  const flightSec = num("flightSec", DEFAULT_COURT.baseFlightSec, 0.3, 3);
  const reach = num("reach", DEFAULT_COURT.reach, 0.1, 1.5);
  const netW = num("netW", DEFAULT_COURT.netHalfWidth * 2, 0.4, 6);
  if (gravity === null || flightSec === null || reach === null || netW === null) return null;
  return { markerId, markerMm, netTop, gravity, flightSec, reach, netW };
}

function sameConfig(a: VolleyballRoomConfig, b: VolleyballRoomConfig): boolean {
  return (
    a.markerId === b.markerId &&
    a.markerMm === b.markerMm &&
    a.netTop === b.netTop &&
    a.gravity === b.gravity &&
    a.flightSec === b.flightSec &&
    a.reach === b.reach &&
    a.netW === b.netW
  );
}

function describeConfig(c: VolleyballRoomConfig): string {
  return `markerId=${c.markerId} markerMm=${c.markerMm} netTop=${c.netTop} gravity=${c.gravity} flightSec=${c.flightSec} reach=${c.reach} netW=${c.netW}`;
}

function attach(httpServer: HttpServer) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_PAYLOAD_BYTES,
  });
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
    broadcast(room, {
      type: "state",
      state: room.game.snapshot(),
      court: room.game.court,
    });
  }

  function reject(ws: WebSocket, reason: string) {
    console.warn(`[volleyball] rejected: ${reason}`);
    ws.send(JSON.stringify({ type: "error", reason } satisfies ServerMessage));
    ws.close();
  }

  function createRoom(name: string, config: VolleyballRoomConfig): Room {
    const game = new VolleyballGame({
      autoNetTop: config.netTop === "auto",
      court: {
        ...DEFAULT_COURT,
        netTop: config.netTop === "auto" ? DEFAULT_COURT.netTop : config.netTop,
        gravity: config.gravity,
        baseFlightSec: config.flightSec,
        serveFlightSec: config.flightSec * SERVE_FLIGHT_FACTOR,
        reach: config.reach,
        netHalfWidth: config.netW / 2,
      },
    });
    const room: Room = {
      config,
      game,
      members: new Map(),
      lastTickMs: performance.now(),
      lastBroadcastMs: -Infinity,
      timer: setInterval(() => {
        const now = performance.now();
        // 長い停止（デバッガ等）の後に物理が飛ばないよう dt に上限
        const dt = Math.min(0.05, (now - room.lastTickMs) / 1000);
        room.lastTickMs = now;
        const events = room.game.tick(dt, now);
        const interval =
          room.game.state.phase === "rally"
            ? RALLY_BROADCAST_MS
            : IDLE_BROADCAST_MS;
        if (events.length > 0 || now - room.lastBroadcastMs >= interval) {
          broadcastState(room, now);
        }
      }, TICK_MS),
    };
    rooms.set(name, room);
    return room;
  }

  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "", "http://localhost");
    if (url.pathname !== VOLLEYBALL_PATH) return;
    const roomName = url.searchParams.get("room") ?? "";
    if (!ROOM_ID_PATTERN.test(roomName)) {
      socket.destroy();
      return;
    }
    // cross-site WebSocket hijacking 対策（04 と同じ）
    const origin = req.headers.origin;
    if (origin) {
      let originHost: string | null = null;
      try {
        originHost = new URL(origin).host;
      } catch {
        // 不正な Origin はホスト不一致と同じ扱い
      }
      if (originHost !== req.headers.host) {
        console.warn(
          `[volleyball] rejected connection from origin "${origin}" (host: ${req.headers.host})`,
        );
        socket.destroy();
        return;
      }
    }
    wss.handleUpgrade(req, socket, head, (ws: LiveWebSocket) => {
      const version = Number(url.searchParams.get("v") ?? NaN);
      if (version !== VOLLEYBALL_PROTOCOL_VERSION) {
        reject(
          ws,
          `プロトコルバージョン不一致 (server: ${VOLLEYBALL_PROTOCOL_VERSION} / client: ${url.searchParams.get("v") ?? "なし"})。ページを再読み込みしてください`,
        );
        return;
      }
      const config = parseRoomConfig(url);
      if (!config) {
        reject(ws, "Room 設定 (markerId / markerMm / netTop / gravity / flightSec / reach / netW) が不正です");
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
      const now = performance.now();
      ws.isAlive = true;
      ws.on("pong", () => {
        ws.isAlive = true;
      });
      game.join(id, now);
      send(ws, {
        type: "welcome",
        id,
        peers: [...members.keys()],
        court: game.court,
        state: game.snapshot(),
      });
      broadcast(room, { type: "join", id });
      members.set(id, ws);
      console.log(
        `[volleyball] ${id} joined room "${roomName}" (${members.size} members)`,
      );

      ws.on("message", (data) => {
        const msg = parseClientMessage(data);
        if (!msg) return;
        const t = performance.now();
        if (msg.type === "pose") {
          game.updatePose(id, msg.pos, msg.tracking, t);
          const { type: _type, ...pose } = msg;
          broadcast(room, { type: "pose", id, ...pose }, id);
        } else if (msg.type === "hit") {
          if (game.hit(id, msg.pos, msg.handVel, t)) {
            // 受理した打球は待たずに配る（クライアントの予測との差を最小にする）
            broadcastState(room, t);
          } else {
            // 拒否は申告者にだけ伝え、ローカル予測を即座に捨てさせる
            send(ws, { type: "state", state: game.rejectionSnapshot(id, t), court: game.court });
          }
        }
      });
      const leave = () => {
        if (!members.delete(id)) return;
        game.leave(id);
        if (members.size === 0) {
          clearInterval(room.timer);
          rooms.delete(roomName);
        } else {
          broadcast(room, { type: "leave", id });
          broadcastState(room, performance.now());
        }
        console.log(
          `[volleyball] ${id} left room "${roomName}" (${members.size} members)`,
        );
      };
      ws.on("close", leave);
      ws.on("error", (e) => {
        console.warn(`[volleyball] ${id} socket error:`, e.message);
        ws.close();
        leave();
      });
    });
  });
}

export function volleyballServer(): Plugin {
  return {
    name: "volleyball-server",
    configureServer(server) {
      if (server.httpServer) attach(server.httpServer);
    },
    configurePreviewServer(server) {
      if (server.httpServer) attach(server.httpServer);
    },
  };
}
