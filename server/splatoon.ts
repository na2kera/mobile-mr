// Phase 8 (08-splatoon) 用の対戦サーバー。接続の共通部分は server/room-server.ts、
// ルールは src/shared/splatoon-game.ts の純粋クラス。ここは「Room 設定」「メッセージ」「状態と tick」だけ。
// 接続には 2 つの役割がある: プレイヤー（スマホ）と俯瞰画面（PC。?role=overview）。俯瞰画面はプレイヤーではない
// （game.join しない・join / leave を配らない・welcome の peers にも入れない）が、room のメンバーとして
// pose / shot / state を受け取り、唯一「start（対戦開始）」と「field（フィールドの寸法の変更）」を送れる（issue #19 / #21）。
// フィールドの寸法（幅・高さ・奥行き・マーカーの高さ）は URL クエリではなく room の状態（game.config）で、welcome / field で全員に配る
import type { RawData } from "ws";
import { isVec, parseName, roomServerPlugin, type RoomContext } from "./room-server.ts";
import {
  HAND_FLAT_LENGTH,
  NAME_MAX_LENGTH,
  SPLATOON_PATH,
  SPLATOON_PROTOCOL_VERSION,
  type ClientMessage,
  type ClientRole,
  type PlayerPose,
  type ServerMessage,
  type SplatoonRoomConfig,
} from "../src/shared/splatoon-protocol.ts";
import { SplatoonGame } from "../src/shared/splatoon-game.ts";
import { DEFAULT_FIELD, FIELD_SIZE_KEYS, validateFieldSize, type FieldSize, type V3 } from "../src/shared/splatoon-sim.ts";
import { RateLimiter } from "../src/shared/surface-paint.ts";

const MAX_PAYLOAD_BYTES = 8 * 1024;
const TICK_MS = 100;
const IDLE_BROADCAST_MS = 1000;
/** プレイヤーの上限（色の数） */
const MAX_PLAYERS = 8;
/** 俯瞰画面の上限（運営 + 予備）。役割は ?role= の自己申告（LAN デモ。URL を知っていれば誰でも開ける） */
const MAX_OVERVIEWS = 2;
const MAX_ROOMS = 64;
/** クライアントの ?sendHz= の max 60 に余裕を持たせる */
const POSE_RATE_PER_SEC = 90;
/** 全員切断してから Room を捨てるまでの猶予（1 人プレイ中の瞬断・bfcache で試合が消えないように） */
const EMPTY_ROOM_TTL_MS = 60 * 1000;

type State = { game: SplatoonGame; lastBroadcastMs: number; poseRate: RateLimiter; overviews: Set<string> };
type Ctx = RoomContext<SplatoonRoomConfig, State>;

function roleOf(url: URL): ClientRole {
  return url.searchParams.get("role") === "overview" ? "overview" : "player";
}

/** welcome の peers: プレイヤーだけ（俯瞰画面はアバターを持たないので相手に見せない） */
function playerIds(room: Ctx, excludeId: string): string[] {
  return [...room.members.keys()].filter((k) => k !== excludeId && !room.state.overviews.has(k));
}

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
    if (m.fist !== undefined && typeof m.fist !== "boolean") return null;
    const pose: PlayerPose = {
      pos: m.pos as V3,
      quat: m.quat.map((v) => v / quatLen) as unknown as PlayerPose["quat"],
      tracking: m.tracking,
    };
    if (hands) pose.hands = hands;
    if (m.fist === true) pose.fist = true;
    return { type: "pose", ...pose };
  }
  if (m.type === "start") return { type: "start" };
  if (m.type === "field") {
    // 範囲とセル数の上限は onMessage で validateFieldSize（理由を rejected で返すため）。ここは数値であることだけ
    if (!FIELD_SIZE_KEYS.every((k) => typeof m[k] === "number" && Number.isFinite(m[k]))) return null;
    return { type: "field", wallW: m.wallW as number, wallH: m.wallH as number, floorDepth: m.floorDepth as number, floorDrop: m.floorDrop as number };
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
  const gravity = num("gravity", DEFAULT_FIELD.gravity, 0, 30);
  const matchSec = num("matchSec", DEFAULT_FIELD.matchSec, 10, 600);
  const waitSec = num("waitSec", DEFAULT_FIELD.waitSec, 0, 120);
  if (gravity === null || matchSec === null || waitSec === null) return null;
  return { markerId, markerMm, gravity, matchSec, waitSec };
}

function describeConfig(c: SplatoonRoomConfig): string {
  return `markerId=${c.markerId} markerMm=${c.markerMm} gravity=${c.gravity} matchSec=${c.matchSec} waitSec=${c.waitSec}`;
}

/** 幅x高さx奥行き/マーカーの高さ（クライアントの HUD の field= と同じ形） */
function describeSize(s: FieldSize): string {
  return `${s.wallW}x${s.wallH}x${s.floorDepth}/${s.floorDrop}`;
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
    configErrorReason: "Room 設定 (markerId / markerMm / gravity / matchSec / waitSec) が不正です",
    parseMessage: parseClientMessage,
    // 役割ごとの上限（room-server の maxMembers は役割を区別しないので canJoin で数える）
    canJoin(room: Ctx, url) {
      const overviews = room.state.overviews.size;
      if (roleOf(url) === "overview") {
        return overviews >= MAX_OVERVIEWS ? `俯瞰画面は ${MAX_OVERVIEWS} 台までです` : null;
      }
      const players = room.members.size - overviews;
      return players >= MAX_PLAYERS ? `room "${room.name}" は満員です (プレイヤー ${MAX_PLAYERS} 人まで)` : null;
    },
    maxRooms: MAX_ROOMS,
    emptyRoomTtlMs: EMPTY_ROOM_TTL_MS,
    // フィールドの寸法は DEFAULT_FIELD から始まり、俯瞰画面の field で変わる
    createState: (_name, c) => ({
      game: new SplatoonGame({
        gravity: c.gravity,
        matchSec: c.matchSec,
        waitSec: c.waitSec,
      }),
      lastBroadcastMs: -Infinity,
      poseRate: new RateLimiter(POSE_RATE_PER_SEC),
      overviews: new Set(),
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
      if (roleOf(url) === "overview") {
        // 俯瞰画面: プレイヤーにはしない。全体の状態（格子込み）だけ渡す
        room.state.overviews.add(id);
        room.send(id, {
          type: "welcome",
          id,
          role: "overview",
          peers: playerIds(room, id),
          config: game.config,
          state: game.snapshot(now, true),
        } satisfies ServerMessage);
        console.log(`[splatoon] ${id} overview joined`);
        return;
      }
      const name = parseName(url, id, NAME_MAX_LENGTH);
      const events = game.join(id, name, now);
      room.send(id, {
        type: "welcome",
        id,
        role: "player",
        peers: playerIds(room, id),
        config: game.config,
        state: game.snapshot(now, true, events[0]),
      } satisfies ServerMessage);
      room.broadcast({ type: "join", id } satisfies ServerMessage, id);
      // 色の割当が変わったので全員に配る（色を再利用してセルを消したときは格子ごと）
      broadcastState(room, now, events.length > 0 || game.lastJoinClearedColor, events[0]);
      console.log(`[splatoon] ${id} "${name}" color ${game.players.get(id)?.color}`);
    },
    onMessage(room: Ctx, id, msg, now) {
      const { game } = room.state;
      const isOverview = room.state.overviews.has(id);
      if (msg.type === "start") {
        // 対戦開始は俯瞰画面だけ（issue #21「対戦開始はこちら側で制御」）。スマホからの start は拒否を返すだけ
        if (!isOverview) {
          room.send(id, { type: "rejected", reason: "not overview" } satisfies ServerMessage);
          return;
        }
        const events = game.start(now);
        if (events.length === 0) {
          console.log(`[splatoon] ${id} start rejected: ${game.lastRejectReason}`);
          room.send(id, { type: "rejected", reason: game.lastRejectReason } satisfies ServerMessage);
          return;
        }
        console.log(`[splatoon] ${id} start → countdown ${game.config.waitSec}s`);
        broadcastState(room, now, false, events[0]);
        return;
      }
      if (msg.type === "field") {
        // フィールドの寸法の変更も俯瞰画面だけ（対戦開始と同じ運営の操作）
        if (!isOverview) {
          room.send(id, { type: "rejected", reason: "not overview" } satisfies ServerMessage);
          return;
        }
        const { type: _type, ...size } = msg;
        const invalid = validateFieldSize(size, game.config.cellM);
        const reason = invalid ?? (game.setFieldSize(size, now).length === 0 ? game.lastRejectReason : null);
        if (reason !== null) {
          console.log(`[splatoon] ${id} field ${describeSize(size)} rejected: ${reason}`);
          room.send(id, { type: "rejected", reason } satisfies ServerMessage);
          return;
        }
        console.log(`[splatoon] ${id} field → ${describeSize(game.config)} (${game.totalCells} cells)`);
        // 格子が作り直されたので、config と格子付きの state を全員に配る（俯瞰画面も含む）
        room.state.lastBroadcastMs = now;
        room.broadcast({ type: "field", config: game.config, state: game.snapshot(now, true, { kind: "field" }) } satisfies ServerMessage);
        return;
      }
      if (isOverview) return; // 俯瞰画面は pose / shot を送らない（送ってきても捨てる）
      if (msg.type === "pose") {
        if (!room.state.poseRate.allow(id, now)) return;
        game.updatePose(id, msg.pos, now, msg.fist === true);
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
      if (room.state.overviews.delete(id)) return; // 俯瞰画面の退室は誰にも関係ない
      room.state.game.leave(id);
      room.state.poseRate.forget(id);
      room.broadcast({ type: "leave", id } satisfies ServerMessage);
      broadcastState(room, now, false);
    },
  });
}
