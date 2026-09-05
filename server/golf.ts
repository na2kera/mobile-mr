// Phase 10 (10-golf) 用のサーバー。接続の共通部分は server/room-server.ts、ルールは src/shared/golf-game.ts の純粋クラス。
// ここは「Room 設定」「メッセージ」「状態と tick」だけ（08 の server/splatoon.ts と同じ構成）。
// 役割: プレイヤー（スマホ）と俯瞰画面（PC。?role=overview。Joy-Con のハブでもある）。俯瞰画面はプレイヤーではないが、
// 誰かの代わりに address / stroke を送れる唯一の端末（Joy-Con を割り当てたプレイヤーの 1 打）。
// スマホは自分の分だけ送れる（Joy-Con が無いときの保険: 画面長押しで溜めて離す）
import type { RawData } from "ws";
import { isVec, parseName, roomServerPlugin, type RoomContext } from "./room-server.ts";
import {
  GOLF_PATH,
  GOLF_PROTOCOL_VERSION,
  MAX_POSE_MARKER_IDS,
  NAME_MAX_LENGTH,
  type ClientMessage,
  type ClientRole,
  type GolfRoomConfig,
  type PlayerPose,
  type ServerMessage,
} from "../src/shared/golf-protocol.ts";
import { GolfGame, MAX_PLAYERS } from "../src/shared/golf-game.ts";
import { FIELD_SIZE_KEYS, GOLF_RULE_KEYS, type V2, type V3 } from "../src/shared/golf-sim.ts";
import { RateLimiter } from "../src/shared/surface-paint.ts";
import { MAX_EXTRA_MARKERS, MAX_MARKER_ID, describeMarkers, validateMarkerLayout, type MarkerFace, type MarkerPlacement } from "../src/shared/marker-layout.ts";

const MAX_PAYLOAD_BYTES = 8 * 1024;
const TICK_MS = 100;
const IDLE_BROADCAST_MS = 1000;
const MAX_OVERVIEWS = 2;
const MAX_ROOMS = 64;
/** クライアントの ?sendHz= の max 60 に余裕を持たせる */
const POSE_RATE_PER_SEC = 90;
/** パターの振り角の中継の上限 [回/秒]（ハブは 1 台あたり 20Hz で送る。2〜4 台ぶん） */
const PUTTER_RATE_PER_SEC = 100;
/** 全員切断してから Room を捨てるまでの猶予（1 人プレイ中の瞬断・bfcache でゲームが消えないように） */
const EMPTY_ROOM_TTL_MS = 60 * 1000;

/** 構え（address / clearAim）の上限 [回/秒]（1 通ごとに全員へ state を配るので、壊れたクライアントの増幅を防ぐ。外部レビュー指摘） */
const AIM_RATE_PER_SEC = 10;

type State = { game: GolfGame; lastBroadcastMs: number; poseRate: RateLimiter; putterRate: RateLimiter; aimRate: RateLimiter; overviews: Set<string> };
type Ctx = RoomContext<GolfRoomConfig, State>;

function roleOf(url: URL): ClientRole {
  return url.searchParams.get("role") === "overview" ? "overview" : "player";
}

function playerIds(room: Ctx, excludeId: string): string[] {
  return [...room.members.keys()].filter((k) => k !== excludeId && !room.state.overviews.has(k));
}

const isPlayerId = (v: unknown): v is string => typeof v === "string" && /^p\d{1,9}$/.test(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

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
    let markerIds: number[] | undefined;
    if (m.markerIds !== undefined) {
      if (!Array.isArray(m.markerIds) || m.markerIds.length > MAX_POSE_MARKER_IDS || !m.markerIds.every((v) => Number.isInteger(v) && v >= 0 && v <= 999)) return null;
      markerIds = m.markerIds as number[];
    }
    let gaze: V2 | undefined;
    if (m.gaze !== undefined) {
      if (!isVec(m.gaze, 2) || m.gaze.some((v) => Math.abs(v) > 100)) return null;
      gaze = [m.gaze[0], m.gaze[1]];
    }
    const pose: PlayerPose = {
      pos: m.pos as V3,
      quat: m.quat.map((v) => v / quatLen) as unknown as PlayerPose["quat"],
      tracking: m.tracking,
    };
    if (markerIds && markerIds.length > 0) pose.markerIds = markerIds;
    if (gaze) pose.gaze = gaze;
    return { type: "pose", ...pose };
  }
  if (m.type === "address") {
    if (m.playerId !== undefined && !isPlayerId(m.playerId)) return null;
    if (m.target !== undefined && (!isVec(m.target, 2) || m.target.some((v) => Math.abs(v) > 100))) return null;
    const out: ClientMessage = { type: "address" };
    if (m.playerId !== undefined) out.playerId = m.playerId;
    if (m.target !== undefined) out.target = [(m.target as number[])[0], (m.target as number[])[1]];
    return out;
  }
  if (m.type === "clearAim") {
    if (m.playerId !== undefined && !isPlayerId(m.playerId)) return null;
    return m.playerId !== undefined ? { type: "clearAim", playerId: m.playerId } : { type: "clearAim" };
  }
  if (m.type === "stroke") {
    if (m.playerId !== undefined && !isPlayerId(m.playerId)) return null;
    if (!isNum(m.speed) || !isNum(m.faceDeg)) return null;
    if (Math.abs(m.speed) > 100 || Math.abs(m.faceDeg) > 360) return null;
    const out: ClientMessage = { type: "stroke", speed: m.speed, faceDeg: m.faceDeg };
    if (m.playerId !== undefined) out.playerId = m.playerId;
    return out;
  }
  if (m.type === "putter") {
    if (!isPlayerId(m.playerId) || !isNum(m.angleDeg) || !isNum(m.dps)) return null;
    if (Math.abs(m.angleDeg) > 360 || Math.abs(m.dps) > 10000) return null;
    return { type: "putter", playerId: m.playerId, angleDeg: m.angleDeg, dps: m.dps };
  }
  if (m.type === "restart") return { type: "restart" };
  if (m.type === "field") {
    if (!FIELD_SIZE_KEYS.every((k) => isNum(m[k]))) return null;
    return { type: "field", wallW: m.wallW as number, wallH: m.wallH as number, floorDepth: m.floorDepth as number, floorDrop: m.floorDrop as number };
  }
  if (m.type === "rules") {
    if (!GOLF_RULE_KEYS.every((k) => isNum(m[k]))) return null;
    return { type: "rules", decel: m.decel as number, cupMaxSpeed: m.cupMaxSpeed as number, maxStrokes: m.maxStrokes as number, holes: m.holes as number };
  }
  if (m.type === "markers") {
    if (!Array.isArray(m.markers) || m.markers.length > MAX_EXTRA_MARKERS * 4) return null;
    const markers: MarkerPlacement[] = [];
    for (const raw of m.markers) {
      if (typeof raw !== "object" || raw === null) return null;
      const r = raw as Record<string, unknown>;
      if (!Number.isInteger(r.id) || (r.id as number) < 0 || (r.id as number) > MAX_MARKER_ID) return null;
      if (typeof r.face !== "string" || !isVec(r.pos, 3)) return null;
      markers.push({ id: r.id as number, face: r.face as MarkerFace, pos: [r.pos[0], r.pos[1], r.pos[2]] });
    }
    return { type: "markers", markers };
  }
  return null;
}

function parseRoomConfig(url: URL): GolfRoomConfig | null {
  const markerId = Number(url.searchParams.get("markerId") ?? NaN);
  const markerMm = Number(url.searchParams.get("markerMm") ?? NaN);
  if (!Number.isInteger(markerId) || markerId < 0 || markerId > 999) return null;
  if (!Number.isFinite(markerMm) || markerMm <= 0 || markerMm > 5000) return null;
  return { markerId, markerMm };
}

function describeConfig(c: GolfRoomConfig): string {
  return `markerId=${c.markerId} markerMm=${c.markerMm}`;
}

function broadcastState(room: Ctx, now: number, event?: ReturnType<GolfGame["tick"]>[number]) {
  room.state.lastBroadcastMs = now;
  room.broadcast({ type: "state", state: room.state.game.snapshot(now, event) } satisfies ServerMessage);
}

function describeEvents(events: readonly { kind: string }[]): string {
  return events.map((e) => e.kind).join("+") || "-";
}

export function golfServer() {
  return roomServerPlugin<GolfRoomConfig, State, ClientMessage>("golf-server", {
    tag: "[golf]",
    path: GOLF_PATH,
    protocolVersion: GOLF_PROTOCOL_VERSION,
    maxPayloadBytes: MAX_PAYLOAD_BYTES,
    parseConfig: parseRoomConfig,
    sameConfig: (a, b) => describeConfig(a) === describeConfig(b),
    describeConfig,
    configErrorReason: "Room 設定 (markerId / markerMm) が不正です",
    parseMessage: parseClientMessage,
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
    createState: () => ({
      game: new GolfGame(),
      lastBroadcastMs: -Infinity,
      poseRate: new RateLimiter(POSE_RATE_PER_SEC),
      putterRate: new RateLimiter(PUTTER_RATE_PER_SEC),
      aimRate: new RateLimiter(AIM_RATE_PER_SEC),
      overviews: new Set(),
    }),
    tickMs: TICK_MS,
    onTick(room: Ctx, now) {
      const events = room.state.game.tick(now);
      if (events.length > 0) {
        console.log(`[golf] tick → ${describeEvents(events)} (hole ${room.state.game.hole + 1}, turn ${room.state.game.turn ?? "-"})`);
        // 複数のイベント（timeout + turn / hole + turn / restart + turn）は起きた順に配る（クライアントは seq:kind で区別する）
        for (const ev of events) broadcastState(room, now, ev);
      } else if (now - room.state.lastBroadcastMs >= IDLE_BROADCAST_MS) {
        broadcastState(room, now);
      }
    },
    onJoin(room: Ctx, id, url, now) {
      const { game } = room.state;
      if (roleOf(url) === "overview") {
        room.state.overviews.add(id);
        room.send(id, { type: "welcome", id, role: "overview", peers: playerIds(room, id), config: game.config, state: game.snapshot(now) } satisfies ServerMessage);
        console.log(`[golf] ${id} overview joined`);
        return;
      }
      const name = parseName(url, id, NAME_MAX_LENGTH);
      const events = game.join(id, name, now);
      room.send(id, { type: "welcome", id, role: "player", peers: playerIds(room, id), config: game.config, state: game.snapshot(now, events[0]) } satisfies ServerMessage);
      room.broadcast({ type: "join", id } satisfies ServerMessage, id);
      broadcastState(room, now, events[0]);
      console.log(`[golf] ${id} "${name}" color ${game.players.get(id)?.color} → ${describeEvents(events)}`);
    },
    onMessage(room: Ctx, id, msg, now) {
      const { game } = room.state;
      const isOverview = room.state.overviews.has(id);
      const rejected = (reason: string) => room.send(id, { type: "rejected", reason } satisfies ServerMessage);
      /** 誰の操作か: 俯瞰画面は playerId 必須（他人の代わり）、スマホは自分だけ */
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
      if (msg.type === "restart" || msg.type === "field" || msg.type === "rules" || msg.type === "markers" || msg.type === "putter") {
        if (!isOverview) {
          rejected("not overview");
          return;
        }
      }
      switch (msg.type) {
        case "pose": {
          if (isOverview) return;
          if (!room.state.poseRate.allow(id, now)) return;
          game.updateGaze(id, msg.gaze ?? null);
          const { type: _type, ...pose } = msg;
          room.broadcast({ type: "pose", id, ...pose } satisfies ServerMessage, id);
          return;
        }
        case "address": {
          if (!room.state.aimRate.allow(id, now)) return;
          const actor = actorOf(msg.playerId);
          if (actor === null) return;
          if (!game.address(actor, msg.target)) {
            console.log(`[golf] ${id} address(${actor}) rejected: ${game.lastRejectReason}`);
            rejected(game.lastRejectReason);
            return;
          }
          console.log(`[golf] ${id} address(${actor}) aim=(${game.aimOf(actor).map((v) => v.toFixed(2)).join(",")})`);
          broadcastState(room, now);
          return;
        }
        case "clearAim": {
          if (!room.state.aimRate.allow(id, now)) return;
          const actor = actorOf(msg.playerId);
          if (actor === null) return;
          if (!game.clearAim(actor)) {
            rejected(game.lastRejectReason);
            return;
          }
          broadcastState(room, now);
          return;
        }
        case "stroke": {
          const actor = actorOf(msg.playerId);
          if (actor === null) return;
          const events = game.stroke(actor, msg.speed, msg.faceDeg, now);
          if (!events) {
            console.log(`[golf] ${id} stroke(${actor}) rejected: ${game.lastRejectReason}`);
            rejected(game.lastRejectReason);
            return;
          }
          const r = game.roll!;
          console.log(
            `[golf] ${id} stroke(${actor}) #${r.seq}: speed=${msg.speed.toFixed(2)} face=${msg.faceDeg.toFixed(1)} from=(${r.from.join(",")}) vel=(${r.vel.join(",")}) → end=(${r.end.join(",")}) ${r.holed ? "HOLED" : "stop"} t=${r.duration.toFixed(2)}s bounces=${r.bounces} strokes=${game.balls.get(actor)?.strokes}`,
          );
          broadcastState(room, now, events[0]);
          return;
        }
        case "putter": {
          if (!room.state.putterRate.allow(id, now)) return;
          if (!game.players.has(msg.playerId)) return;
          room.broadcast({ type: "putter", id: msg.playerId, angleDeg: msg.angleDeg, dps: msg.dps } satisfies ServerMessage, id);
          return;
        }
        case "restart": {
          // 転がっている最中でも通す（運営の操作。クライアントは roll: null で描画を止める）
          const events = game.restart(now);
          console.log(`[golf] ${id} restart → ${describeEvents(events)}`);
          broadcastState(room, now, events[0]);
          return;
        }
        case "field": {
          const { type: _type, ...size } = msg;
          const events = game.setFieldSize(size, now);
          if (!events) {
            console.log(`[golf] ${id} field rejected: ${game.lastRejectReason}`);
            rejected(game.lastRejectReason);
            return;
          }
          const c = game.config;
          console.log(`[golf] ${id} field → ${c.wallW}x${c.wallH}x${c.floorDepth}/${c.floorDrop}`);
          room.state.lastBroadcastMs = now;
          room.broadcast({ type: "config", config: game.config, state: game.snapshot(now, events[0]) } satisfies ServerMessage);
          return;
        }
        case "rules": {
          const { type: _type, ...rules } = msg;
          const events = game.setRules(rules, now);
          if (!events) {
            console.log(`[golf] ${id} rules rejected: ${game.lastRejectReason}`);
            rejected(game.lastRejectReason);
            return;
          }
          const c = game.config;
          console.log(`[golf] ${id} rules → decel=${c.decel} cupMaxSpeed=${c.cupMaxSpeed} maxStrokes=${c.maxStrokes} holes=${c.holes}`);
          room.state.lastBroadcastMs = now;
          room.broadcast({ type: "config", config: game.config, state: game.snapshot(now, events[0]) } satisfies ServerMessage);
          return;
        }
        case "markers": {
          const invalid = validateMarkerLayout(msg.markers, room.config.markerId, game.config.floorDrop);
          if (invalid) {
            console.log(`[golf] ${id} markers (${msg.markers.length}) rejected: ${invalid}`);
            rejected(invalid);
            return;
          }
          game.setMarkers(msg.markers);
          console.log(`[golf] ${id} markers → ${describeMarkers(game.config.markers)}`);
          room.broadcast({ type: "markers", config: game.config } satisfies ServerMessage);
          return;
        }
      }
    },
    onLeave(room: Ctx, id, now) {
      room.state.putterRate.forget(id);
      room.state.aimRate.forget(id);
      if (room.state.overviews.delete(id)) return;
      const events = room.state.game.leave(id, now);
      room.state.poseRate.forget(id);
      room.broadcast({ type: "leave", id } satisfies ServerMessage);
      broadcastState(room, now, events[0]);
    },
  });
}
