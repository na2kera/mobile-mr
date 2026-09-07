// Phase 10-2 (10-2-batting) の Vite 同居 WebSocket サーバー。
// 接続の共通部分は room-server.ts、ゲーム状態は純粋な BattingGame が持つ。
import type { RawData } from "ws";
import {
  isVec,
  parseName,
  roomServerPlugin,
  type RoomContext,
} from "./room-server.ts";
import {
  BATTING_PATH,
  BATTING_PROTOCOL_VERSION,
  NAME_MAX_LENGTH,
  type BattingRoomConfig,
  type ClientMessage,
  type ClientRole,
  type PlayerPose,
  type ServerMessage,
} from "../src/shared/batting-protocol.ts";
import {
  BattingGame,
  type GameEvent,
} from "../src/shared/batting-game.ts";
import {
  PITCH_TYPES,
  type PitchType,
  type V3,
} from "../src/shared/batting-sim.ts";
import { RateLimiter } from "../src/shared/surface-paint.ts";

const MAX_PAYLOAD_BYTES = 4 * 1024;
const TICK_MS = 50;
const IDLE_BROADCAST_MS = 1000;
const MAX_PLAYERS = 2;
const MAX_OVERVIEWS = 2;
const MAX_ROOMS = 64;
const EMPTY_ROOM_TTL_MS = 60 * 1000;
const POSE_RATE_PER_SEC = 90;
const MOTION_RATE_PER_SEC = 120;

type State = {
  game: BattingGame;
  overviews: Set<string>;
  poseRate: RateLimiter;
  motionRate: RateLimiter;
  lastBroadcastMs: number;
};
type Ctx = RoomContext<BattingRoomConfig, State>;

function roleOf(url: URL): ClientRole {
  return url.searchParams.get("role") === "overview" ? "overview" : "player";
}

function playerIds(room: Ctx, excludeId: string): string[] {
  return [...room.members.keys()].filter(
    (id) => id !== excludeId && !room.state.overviews.has(id),
  );
}

const isPlayerId = (v: unknown): v is string =>
  typeof v === "string" && /^p\d{1,9}$/.test(v);
const isNum = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

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
    if (
      !isVec(m.pos, 3) ||
      !isVec(m.quat, 4) ||
      typeof m.tracking !== "boolean"
    ) {
      return null;
    }
    if (
      m.pos.some((v) => Math.abs(v) > 100) ||
      m.quat.some((v) => Math.abs(v) > 1e6)
    ) {
      return null;
    }
    const quatLen = Math.hypot(...m.quat);
    if (!Number.isFinite(quatLen) || quatLen < 0.5) return null;
    return {
      type: "pose",
      pos: m.pos as V3,
      quat: m.quat.map((v) => v / quatLen) as PlayerPose["quat"],
      tracking: m.tracking,
    };
  }
  if (m.type === "pitch") {
    if (m.playerId !== undefined && !isPlayerId(m.playerId)) return null;
    if (
      typeof m.pitchType !== "string" ||
      !PITCH_TYPES.includes(m.pitchType as PitchType) ||
      !isNum(m.speed)
    ) {
      return null;
    }
    const out: ClientMessage = {
      type: "pitch",
      pitchType: m.pitchType as PitchType,
      speed: m.speed,
    };
    if (m.playerId !== undefined) out.playerId = m.playerId;
    return out;
  }
  if (m.type === "swing") {
    if (m.playerId !== undefined && !isPlayerId(m.playerId)) return null;
    if (!isNum(m.speed) || !isNum(m.faceDeg)) return null;
    const out: ClientMessage = {
      type: "swing",
      speed: m.speed,
      faceDeg: m.faceDeg,
    };
    if (m.playerId !== undefined) out.playerId = m.playerId;
    return out;
  }
  if (m.type === "motion") {
    if (
      !isPlayerId(m.playerId) ||
      (m.kind !== "pitch" && m.kind !== "bat") ||
      !isNum(m.angleDeg) ||
      !isNum(m.dps) ||
      Math.abs(m.angleDeg) > 360 ||
      Math.abs(m.dps) > 10000
    ) {
      return null;
    }
    return {
      type: "motion",
      playerId: m.playerId,
      kind: m.kind,
      angleDeg: m.angleDeg,
      dps: m.dps,
    };
  }
  if (m.type === "restart") return { type: "restart" };
  return null;
}

function parseRoomConfig(url: URL): BattingRoomConfig | null {
  const markerId = Number(url.searchParams.get("markerId") ?? NaN);
  const markerMm = Number(url.searchParams.get("markerMm") ?? NaN);
  if (!Number.isInteger(markerId) || markerId < 0 || markerId > 999) {
    return null;
  }
  if (!Number.isFinite(markerMm) || markerMm <= 0 || markerMm > 5000) {
    return null;
  }
  return { markerId, markerMm };
}

function describeConfig(c: BattingRoomConfig): string {
  return `markerId=${c.markerId} markerMm=${c.markerMm}`;
}

function broadcastState(room: Ctx, now: number, event?: GameEvent) {
  room.state.lastBroadcastMs = now;
  room.broadcast({
    type: "state",
    state: room.state.game.snapshot(now, event),
  } satisfies ServerMessage);
}

function describeEvents(events: readonly GameEvent[]): string {
  return events.map((e) => e.kind).join("+") || "-";
}

export function battingServer() {
  return roomServerPlugin<BattingRoomConfig, State, ClientMessage>(
    "batting-server",
    {
      tag: "[batting]",
      path: BATTING_PATH,
      protocolVersion: BATTING_PROTOCOL_VERSION,
      maxPayloadBytes: MAX_PAYLOAD_BYTES,
      parseConfig: parseRoomConfig,
      sameConfig: (a, b) => describeConfig(a) === describeConfig(b),
      describeConfig,
      configErrorReason: "Room 設定 (markerId / markerMm) が不正です",
      parseMessage: parseClientMessage,
      canJoin(room, url) {
        if (roleOf(url) === "overview") {
          return room.state.overviews.size >= MAX_OVERVIEWS
            ? `俯瞰画面は ${MAX_OVERVIEWS} 台までです`
            : null;
        }
        const players = room.members.size - room.state.overviews.size;
        return players >= MAX_PLAYERS
          ? `room "${room.name}" は満員です（打者 + 投手の2人まで）`
          : null;
      },
      maxRooms: MAX_ROOMS,
      emptyRoomTtlMs: EMPTY_ROOM_TTL_MS,
      createState: () => ({
        game: new BattingGame(),
        overviews: new Set(),
        poseRate: new RateLimiter(POSE_RATE_PER_SEC),
        motionRate: new RateLimiter(MOTION_RATE_PER_SEC),
        lastBroadcastMs: -Infinity,
      }),
      tickMs: TICK_MS,
      onTick(room, now) {
        const events = room.state.game.tick(now);
        if (events.length > 0) {
          console.log(
            `[batting] tick → ${describeEvents(events)} phase=${room.state.game.phase}`,
          );
          events.forEach((event) => broadcastState(room, now, event));
        } else if (
          now - room.state.lastBroadcastMs >=
          IDLE_BROADCAST_MS
        ) {
          broadcastState(room, now);
        }
      },
      onJoin(room, id, url, now) {
        const { game } = room.state;
        if (roleOf(url) === "overview") {
          room.state.overviews.add(id);
          room.send(id, {
            type: "welcome",
            id,
            role: "overview",
            playerRole: null,
            peers: playerIds(room, id),
            config: game.config,
            state: game.snapshot(now),
          } satisfies ServerMessage);
          console.log(`[batting] ${id} overview joined`);
          return;
        }
        const name = parseName(url, id, NAME_MAX_LENGTH);
        const events = game.join(id, name, now);
        const playerRole = game.players.get(id)?.role ?? null;
        room.send(id, {
          type: "welcome",
          id,
          role: "player",
          playerRole,
          peers: playerIds(room, id),
          config: game.config,
          state: game.snapshot(now, events[0]),
        } satisfies ServerMessage);
        room.broadcast({ type: "join", id } satisfies ServerMessage, id);
        events.forEach((event) => broadcastState(room, now, event));
        console.log(
          `[batting] ${id} "${name}" joined as ${playerRole} → ${describeEvents(events)}`,
        );
      },
      onMessage(room, id, msg, now) {
        const { game } = room.state;
        const isOverview = room.state.overviews.has(id);
        const rejected = (reason: string) =>
          room.send(id, { type: "rejected", reason } satisfies ServerMessage);
        const actorOf = (playerId: string | undefined): string | null => {
          if (isOverview) {
            if (!playerId) {
              rejected("overview must specify playerId");
              return null;
            }
            if (!game.players.has(playerId)) {
              rejected(`unknown player ${playerId}`);
              return null;
            }
            return playerId;
          }
          if (playerId !== undefined && playerId !== id) {
            rejected("cannot act for another player");
            return null;
          }
          return id;
        };
        if (
          (msg.type === "motion" || msg.type === "restart") &&
          !isOverview
        ) {
          rejected("not overview");
          return;
        }
        switch (msg.type) {
          case "pose": {
            if (isOverview || !room.state.poseRate.allow(id, now)) return;
            const { type: _type, ...pose } = msg;
            room.broadcast(
              { type: "pose", id, ...pose } satisfies ServerMessage,
              id,
            );
            return;
          }
          case "pitch": {
            const actor = actorOf(msg.playerId);
            if (!actor) return;
            const event = game.pitchBall(
              actor,
              msg.pitchType,
              msg.speed,
              now,
            );
            if (!event) {
              rejected(game.lastRejectReason);
              console.log(
                `[batting] ${id} pitch(${actor}) rejected: ${game.lastRejectReason}`,
              );
              return;
            }
            console.log(
              `[batting] ${id} pitch(${actor}): ${msg.pitchType} ${msg.speed.toFixed(2)}m/s`,
            );
            broadcastState(room, now, event);
            return;
          }
          case "swing": {
            const actor = actorOf(msg.playerId);
            if (!actor) return;
            const event = game.swing(actor, msg.speed, msg.faceDeg, now);
            if (!event) {
              rejected(game.lastRejectReason);
              console.log(
                `[batting] ${id} swing(${actor}) rejected: ${game.lastRejectReason}`,
              );
              return;
            }
            console.log(
              `[batting] ${id} swing(${actor}): ${msg.speed.toFixed(2)}m/s face=${msg.faceDeg.toFixed(1)} → ${event.kind}`,
            );
            broadcastState(room, now, event);
            return;
          }
          case "motion": {
            if (!room.state.motionRate.allow(id, now)) return;
            if (!game.players.has(msg.playerId)) return;
            room.broadcast(
              {
                type: "motion",
                id: msg.playerId,
                kind: msg.kind,
                angleDeg: msg.angleDeg,
                dps: msg.dps,
              } satisfies ServerMessage,
              id,
            );
            return;
          }
          case "restart": {
            const events = game.restart(now);
            console.log(
              `[batting] ${id} restart → ${describeEvents(events)}`,
            );
            events.forEach((event) => broadcastState(room, now, event));
            return;
          }
        }
      },
      onLeave(room, id, now) {
        room.state.motionRate.forget(id);
        if (room.state.overviews.delete(id)) return;
        room.state.poseRate.forget(id);
        const events = room.state.game.leave(id, now);
        room.broadcast({ type: "leave", id } satisfies ServerMessage);
        if (events.length === 0) broadcastState(room, now);
        else events.forEach((event) => broadcastState(room, now, event));
      },
    },
  );
}
