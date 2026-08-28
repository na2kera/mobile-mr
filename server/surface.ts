// Phase 7 (07-surface-mapping) 用のサーバー。Surface 上のペイントの権威（検証・順序・保持）を持ち、
// 姿勢（pose）は中継する。接続の受け付け等の共通部分は server/room-server.ts（今回抽出）で、
// ここは「Room 設定」「メッセージ」「状態（PaintBoard）」の 3 点だけ
import process from "node:process";
import type { RawData } from "ws";
import { isVec, parseName, roomServerPlugin, type RoomContext } from "./room-server.ts";
import {
  NAME_MAX_LENGTH,
  PLAYER_COLOR_COUNT,
  SURFACE_PATH,
  SURFACE_PROTOCOL_VERSION,
  type ClientMessage,
  type PlayerInfo,
  type PlayerPose,
  type ServerMessage,
  type SurfaceRoomConfig,
} from "../src/shared/surface-protocol.ts";
import { PAINT_RADIUS_MAX, PAINT_RADIUS_MIN, PaintBoard, RateLimiter } from "../src/shared/surface-paint.ts";
import {
  DEFAULT_SURFACE_H,
  DEFAULT_SURFACE_W,
  SURFACE_SIZE_MAX,
  SURFACE_SIZE_MIN,
  makeSurface,
  uvInside,
  type V2,
  type V3,
} from "../src/shared/surface.ts";

const MAX_PAYLOAD_BYTES = 4 * 1024;
/** 全員切断してから Room（ペイント）を捨てるまでの猶予。瞬断・bfcache・サーバー再起動以外で消えないように */
const EMPTY_ROOM_TTL_MS = Number(process.env.SURFACE_ROOM_TTL_MS ?? "") || 10 * 60 * 1000;
/** Room の人数上限（pose / paint を全員に配るので二乗で重くなる）。色の数（PLAYER_COLOR_COUNT）以下にする */
const MAX_MEMBERS = 8;
/** Room の総数上限（空 Room を猶予で保持するので、room 名を変えて作り続けられないように） */
const MAX_ROOMS = Number(process.env.SURFACE_MAX_ROOMS ?? "") || 64;
/** テスト用にストローク上限を小さくできる */
const MAX_STROKES_OVERRIDE = Number(process.env.SURFACE_MAX_STROKES ?? "") || undefined;
/** clear / pose の人ごとの上限 [回/秒]（paint の上限は PaintBoard が持つ） */
const CLEAR_RATE_PER_SEC = 1;
/** クライアントの ?sendHz= の max 60 に余裕を持たせる（境界落ち防止） */
const POSE_RATE_PER_SEC = 90;

type State = {
  board: PaintBoard;
  players: Map<string, PlayerInfo>;
  clearRate: RateLimiter;
  poseRate: RateLimiter;
};
type Ctx = RoomContext<SurfaceRoomConfig, State>;

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
    const pose: PlayerPose = {
      pos: m.pos as V3,
      quat: m.quat.map((v) => v / quatLen) as unknown as PlayerPose["quat"],
      tracking: m.tracking,
    };
    if (m.cursor !== undefined) {
      const c = m.cursor as Record<string, unknown> | null;
      if (typeof c !== "object" || c === null) return null;
      if (typeof c.surfaceId !== "string" || c.surfaceId.length > 32 || !isVec(c.uv, 2)) return null;
      if (!uvInside(c.uv as V2)) return null;
      if (typeof c.radius !== "number" || !(c.radius >= PAINT_RADIUS_MIN && c.radius <= PAINT_RADIUS_MAX)) return null;
      pose.cursor = { surfaceId: c.surfaceId, uv: c.uv as V2, radius: c.radius };
    }
    return { type: "pose", ...pose };
  }
  if (m.type === "paint") {
    if (typeof m.surfaceId !== "string" || m.surfaceId.length > 32) return null;
    if (!isVec(m.uv, 2) || typeof m.radius !== "number" || !Number.isFinite(m.radius)) return null;
    return { type: "paint", surfaceId: m.surfaceId, uv: m.uv as V2, radius: m.radius };
  }
  if (m.type === "clear") return { type: "clear" };
  return null;
}

function parseRoomConfig(url: URL): SurfaceRoomConfig | null {
  const markerId = Number(url.searchParams.get("markerId") ?? NaN);
  const markerMm = Number(url.searchParams.get("markerMm") ?? NaN);
  if (!Number.isInteger(markerId) || markerId < 0 || markerId > 999) return null;
  if (!Number.isFinite(markerMm) || markerMm <= 0 || markerMm > 5000) return null;
  const size = (name: string, fallback: number) => {
    const raw = url.searchParams.get(name);
    if (raw === null) return fallback;
    const v = Number(raw);
    return Number.isFinite(v) && v >= SURFACE_SIZE_MIN && v <= SURFACE_SIZE_MAX ? v : null;
  };
  const surfaceW = size("surfaceW", DEFAULT_SURFACE_W);
  const surfaceH = size("surfaceH", DEFAULT_SURFACE_H);
  if (surfaceW === null || surfaceH === null) return null;
  return { markerId, markerMm, surfaceW, surfaceH };
}

export function surfaceServer() {
  return roomServerPlugin<SurfaceRoomConfig, State, ClientMessage>("surface-server", {
    tag: "[surface]",
    path: SURFACE_PATH,
    protocolVersion: SURFACE_PROTOCOL_VERSION,
    maxPayloadBytes: MAX_PAYLOAD_BYTES,
    parseConfig: parseRoomConfig,
    sameConfig: (a, b) =>
      a.markerId === b.markerId &&
      a.markerMm === b.markerMm &&
      a.surfaceW === b.surfaceW &&
      a.surfaceH === b.surfaceH,
    describeConfig: (c) =>
      `markerId=${c.markerId} markerMm=${c.markerMm} surfaceW=${c.surfaceW} surfaceH=${c.surfaceH}`,
    configErrorReason: "Room 設定 (markerId / markerMm / surfaceW / surfaceH) が不正です",
    emptyRoomTtlMs: EMPTY_ROOM_TTL_MS,
    maxMembers: MAX_MEMBERS,
    maxRooms: MAX_ROOMS,
    parseMessage: parseClientMessage,
    createState: (_name, config) => ({
      board: new PaintBoard([makeSurface(config.markerId, config.surfaceW, config.surfaceH)], MAX_STROKES_OVERRIDE),
      players: new Map(),
      clearRate: new RateLimiter(CLEAR_RATE_PER_SEC),
      poseRate: new RateLimiter(POSE_RATE_PER_SEC),
    }),
    onJoin(room: Ctx, id, url) {
      const { state } = room;
      // いま使われていない色のうち最小の番号（退出した人の色は再利用する）
      const used = new Set([...state.players.values()].map((p) => p.color));
      let color = 0;
      while (used.has(color) && color < PLAYER_COLOR_COUNT - 1) color++;
      const player: PlayerInfo = { id, name: parseName(url, id, NAME_MAX_LENGTH), color };
      state.players.set(id, player);
      room.send(id, {
        type: "welcome",
        id,
        players: [...state.players.values()],
        snapshot: state.board.snapshot(),
      } satisfies ServerMessage);
      room.broadcast({ type: "join", player } satisfies ServerMessage, id);
    },
    onMessage(room: Ctx, id, msg, now) {
      const { state } = room;
      if (!state.players.has(id)) return;
      if (msg.type === "pose") {
        if (!state.poseRate.allow(id, now)) return;
        const { type: _type, ...pose } = msg;
        // 知らない Surface のカーソルは落として中継
        if (pose.cursor && !state.board.surfaces.has(pose.cursor.surfaceId)) delete pose.cursor;
        room.broadcast({ type: "pose", id, ...pose } satisfies ServerMessage, id);
      } else if (msg.type === "paint") {
        const player = state.players.get(id)!;
        const stroke = state.board.paint(id, player.color, msg, now);
        if (stroke) {
          if (state.board.trimmed) {
            // 古い分を切り詰めた。新しい stroke も含んだ snapshot で全員を揃える
            room.broadcast({ type: "snapshot", snapshot: state.board.snapshot() } satisfies ServerMessage);
            console.log(`[surface] room "${room.name}" reached the stroke limit; trimmed to ${state.board.strokes.length}`);
          } else {
            room.broadcast({ type: "paint", stroke } satisfies ServerMessage);
          }
        } else if (state.board.lastRejectReason !== "rate limited") {
          console.log(`[surface] ${id} paint rejected: ${state.board.lastRejectReason}`);
        }
      } else if (msg.type === "clear") {
        if (!state.clearRate.allow(id, now)) return;
        state.board.clear();
        room.broadcast({ type: "clear", by: id } satisfies ServerMessage);
        console.log(`[surface] ${id} cleared room "${room.name}"`);
      }
    },
    onLeave(room: Ctx, id) {
      room.state.players.delete(id);
      room.state.board.forget(id);
      room.state.clearRate.forget(id);
      room.state.poseRate.forget(id);
      room.broadcast({ type: "leave", id } satisfies ServerMessage);
    },
  });
}
