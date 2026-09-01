// Phase 8 (08-splatoon) 用の対戦サーバー。接続の共通部分は server/room-server.ts、
// ルールは src/shared/splatoon-game.ts の純粋クラス。ここは「Room 設定」「メッセージ」「状態と tick」だけ
import type { RawData } from "ws";
import { isVec, parseName, roomServerPlugin, type RoomContext } from "./room-server.ts";
import {
  HAND_FLAT_LENGTH,
  NAME_MAX_LENGTH,
  SPLATOON_PATH,
  SPLATOON_PROTOCOL_VERSION,
  type ClientMessage,
  type PlayerPose,
  type ServerMessage,
  type SplatoonRoomConfig,
} from "../src/shared/splatoon-protocol.ts";
import { SplatoonGame } from "../src/shared/splatoon-game.ts";
import { DEFAULT_FIELD, type V3 } from "../src/shared/splatoon-sim.ts";
import { RateLimiter } from "../src/shared/surface-paint.ts";

const MAX_PAYLOAD_BYTES = 8 * 1024;
const TICK_MS = 100;
const IDLE_BROADCAST_MS = 1000;
const MAX_MEMBERS = 8;
const MAX_ROOMS = 64;
/** クライアントの ?sendHz= の max 60 に余裕を持たせる */
const POSE_RATE_PER_SEC = 90;
/** 全員切断してから Room を捨てるまでの猶予（1 人プレイ中の瞬断・bfcache で試合が消えないように） */
const EMPTY_ROOM_TTL_MS = 60 * 1000;
/** 格子のセル数の上限（壁 + 床）。超える大きさは拒否（scores の走査と encode の転送量のため） */
const MAX_CELLS = 250_000;

type State = { game: SplatoonGame; lastBroadcastMs: number; poseRate: RateLimiter };
type Ctx = RoomContext<SplatoonRoomConfig, State>;

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
  if (m.type === "shot") {
    if (!isVec(m.pos, 3) || !isVec(m.vel, 3)) return null;
    if (typeof m.radius !== "number" || !Number.isFinite(m.radius)) return null;
    if (m.pos.some((v) => Math.abs(v) > 100) || m.vel.some((v) => Math.abs(v) > 50)) return null;
    return { type: "shot", pos: m.pos as V3, vel: m.vel as V3, radius: m.radius };
  }
  return null;
}

function parseRoomConfig(url: URL): SplatoonRoomConfig | null {
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
  const wallW = num("wallW", DEFAULT_FIELD.wallW, 0.2, 20);
  const wallH = num("wallH", DEFAULT_FIELD.wallH, 0.2, 20);
  const floorDrop = num("floorDrop", DEFAULT_FIELD.floorDrop, 0.1, 5);
  const floorDepth = num("floorDepth", DEFAULT_FIELD.floorDepth, 0.2, 20);
  const gravity = num("gravity", DEFAULT_FIELD.gravity, 0, 30);
  const matchSec = num("matchSec", DEFAULT_FIELD.matchSec, 10, 600);
  if (wallW === null || wallH === null || floorDrop === null || floorDepth === null || gravity === null || matchSec === null) return null;
  const cells = (wallW * wallH + wallW * floorDepth) / (DEFAULT_FIELD.cellM * DEFAULT_FIELD.cellM);
  if (cells > MAX_CELLS) return null;
  return { markerId, markerMm, wallW, wallH, floorDrop, floorDepth, gravity, matchSec };
}

function describeConfig(c: SplatoonRoomConfig): string {
  return `markerId=${c.markerId} markerMm=${c.markerMm} wallW=${c.wallW} wallH=${c.wallH} floorDrop=${c.floorDrop} floorDepth=${c.floorDepth} gravity=${c.gravity} matchSec=${c.matchSec}`;
}

function broadcastState(room: Ctx, now: number, withGrids: boolean, event?: ReturnType<SplatoonGame["tick"]>[number]) {
  room.state.lastBroadcastMs = now;
  room.broadcast({ type: "state", state: room.state.game.snapshot(now, withGrids, event) } satisfies ServerMessage);
}

export function splatoonServer() {
  return roomServerPlugin<SplatoonRoomConfig, State, ClientMessage>("splatoon-server", {
    tag: "[splatoon]",
    path: SPLATOON_PATH,
    protocolVersion: SPLATOON_PROTOCOL_VERSION,
    maxPayloadBytes: MAX_PAYLOAD_BYTES,
    parseConfig: parseRoomConfig,
    sameConfig: (a, b) => describeConfig(a) === describeConfig(b),
    describeConfig,
    configErrorReason: "Room 設定 (markerId / markerMm / wallW / wallH / floorDrop / floorDepth / gravity / matchSec) が不正です（フィールドが大きすぎる場合も）",
    parseMessage: parseClientMessage,
    maxMembers: MAX_MEMBERS,
    maxRooms: MAX_ROOMS,
    emptyRoomTtlMs: EMPTY_ROOM_TTL_MS,
    createState: (_name, c) => ({
      game: new SplatoonGame({
        wallW: c.wallW,
        wallH: c.wallH,
        floorDrop: c.floorDrop,
        floorDepth: c.floorDepth,
        gravity: c.gravity,
        matchSec: c.matchSec,
      }),
      lastBroadcastMs: -Infinity,
      poseRate: new RateLimiter(POSE_RATE_PER_SEC),
    }),
    tickMs: TICK_MS,
    onTick(room: Ctx, now) {
      const events = room.state.game.tick(now);
      if (events.length > 0) {
        // 開始 / 結果は格子ごと配る（結果 → 開始で格子が消えるので）
        broadcastState(room, now, true, events[0]);
      } else if (now - room.state.lastBroadcastMs >= IDLE_BROADCAST_MS) {
        broadcastState(room, now, false);
      }
    },
    onJoin(room: Ctx, id, url, now) {
      const { game } = room.state;
      const name = parseName(url, id, NAME_MAX_LENGTH);
      const events = game.join(id, name, now);
      room.send(id, {
        type: "welcome",
        id,
        peers: [...room.members.keys()].filter((k) => k !== id),
        config: game.config,
        state: game.snapshot(now, true, events[0]),
      } satisfies ServerMessage);
      room.broadcast({ type: "join", id } satisfies ServerMessage, id);
      // チーム割当が変わったので全員に配る
      broadcastState(room, now, events.length > 0, events[0]);
      console.log(`[splatoon] ${id} "${name}" color ${game.players.get(id)?.color}`);
    },
    onMessage(room: Ctx, id, msg, now) {
      const { game } = room.state;
      if (msg.type === "pose") {
        if (!room.state.poseRate.allow(id, now)) return;
        game.updatePose(id, msg.pos, now);
        const { type: _type, ...pose } = msg;
        room.broadcast({ type: "pose", id, ...pose } satisfies ServerMessage, id);
      } else if (msg.type === "shot") {
        const shot = game.shoot(id, msg.pos, msg.vel, msg.radius, now);
        if (shot) {
          room.broadcast({ type: "shot", shot, t: now } satisfies ServerMessage);
          const l = shot.landing;
          console.log(
            `[splatoon] ${id} shot #${shot.seq}: ${l?.hit ? `${l.surfaceId} uv=(${l.uv.map((v) => v.toFixed(2)).join(",")}) t=${l.hitT.toFixed(2)}` : "miss"} r=${shot.radius.toFixed(2)} from=(${msg.pos.map((v) => v.toFixed(2)).join(",")}) vel=(${msg.vel.map((v) => v.toFixed(2)).join(",")})`,
          );
        } else if (game.lastRejectReason !== "rate limited") {
          console.log(`[splatoon] ${id} shot rejected: ${game.lastRejectReason}`);
          room.send(id, { type: "rejected", reason: game.lastRejectReason } satisfies ServerMessage);
        }
      }
    },
    onLeave(room: Ctx, id, now) {
      room.state.game.leave(id);
      room.state.poseRate.forget(id);
      room.broadcast({ type: "leave", id } satisfies ServerMessage);
      broadcastState(room, now, false);
    },
  });
}
