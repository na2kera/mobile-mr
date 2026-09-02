// Phase 9 (09-person-id) 用の Room サーバー。接続の共通部分は server/room-server.ts。
// 役割は「Player 一覧（id・名前・色）を持つ」「pose（頭の姿勢 + 誰をどこで見たか）を中継する」だけで、
// 人物との対応づけは各端末が行う（src/shared/person-match.ts）
import type { RawData } from "ws";
import { isVec, parseName, roomServerPlugin, type RoomContext } from "./room-server.ts";
import {
  MAX_PLAYERS,
  NAME_MAX_LENGTH,
  PERSON_PATH,
  PERSON_PROTOCOL_VERSION,
  type ClientMessage,
  type PersonPose,
  type PersonRoomConfig,
  type PlayerInfo,
  type ServerMessage,
  type Sighting,
  type V3,
} from "../src/shared/person-protocol.ts";
import { RateLimiter } from "../src/shared/surface-paint.ts";

/** pose の JSON は seen 8 件込みでも 1KB 未満 */
const MAX_PAYLOAD_BYTES = 4 * 1024;
const MAX_ROOMS = 64;
/** クライアントの ?sendHz= の max 60 に余裕を持たせる */
const POSE_RATE_PER_SEC = 90;
/** Player の id の形式（room-server が振る "p123"）。seen の id はこれ以外を捨てる */
const PLAYER_ID_PATTERN = /^p\d{1,9}$/;

type State = { players: Map<string, PlayerInfo>; poseRate: RateLimiter };
type Ctx = RoomContext<PersonRoomConfig, State>;

function parseClientMessage(data: RawData): ClientMessage | null {
  let msg: unknown;
  try {
    msg = JSON.parse(data.toString());
  } catch {
    return null;
  }
  if (typeof msg !== "object" || msg === null) return null;
  const m = msg as Record<string, unknown>;
  if (m.type !== "pose") return null;
  if (!isVec(m.pos, 3) || !isVec(m.quat, 4)) return null;
  if (typeof m.tracking !== "boolean") return null;
  // 04 と同じ意味的な検証（零・退化クォータニオンは受信側の slerp で NaN になる。位置は 100m 超を捨てる）
  if (m.quat.some((v) => Math.abs(v) > 1e6)) return null;
  const quatLen = Math.hypot(...m.quat);
  if (!Number.isFinite(quatLen) || quatLen < 0.5) return null;
  if (m.pos.some((v) => Math.abs(v) > 100)) return null;
  let seen: Sighting[] | undefined;
  if (m.seen !== undefined) {
    if (!Array.isArray(m.seen) || m.seen.length > MAX_PLAYERS) return null;
    seen = [];
    for (const s of m.seen) {
      if (typeof s !== "object" || s === null) return null;
      const r = s as Record<string, unknown>;
      if (!isVec(r.pos, 3) || r.pos.some((v) => Math.abs(v) > 100)) return null;
      if (r.id !== null && (typeof r.id !== "string" || !PLAYER_ID_PATTERN.test(r.id))) return null;
      seen.push({ id: r.id as string | null, pos: r.pos as V3 });
    }
  }
  const pose: PersonPose = {
    pos: m.pos as V3,
    quat: m.quat.map((v) => v / quatLen) as unknown as PersonPose["quat"],
    tracking: m.tracking,
  };
  if (seen) pose.seen = seen;
  return { type: "pose", ...pose };
}

function parseRoomConfig(url: URL): PersonRoomConfig | null {
  const markerId = Number(url.searchParams.get("markerId") ?? NaN);
  const markerMm = Number(url.searchParams.get("markerMm") ?? NaN);
  if (!Number.isInteger(markerId) || markerId < 0 || markerId > 999) return null;
  if (!Number.isFinite(markerMm) || markerMm <= 0 || markerMm > 5000) return null;
  return { markerId, markerMm };
}

function describeConfig(c: PersonRoomConfig): string {
  return `markerId=${c.markerId} markerMm=${c.markerMm}`;
}

/** 未使用の色のうち最小（1..MAX_PLAYERS）。maxMembers で人数は色数以下に抑えている */
function pickColor(players: ReadonlyMap<string, PlayerInfo>): number {
  const used = new Set([...players.values()].map((p) => p.color));
  for (let c = 1; c <= MAX_PLAYERS; c++) if (!used.has(c)) return c;
  return MAX_PLAYERS;
}

export function personServer() {
  return roomServerPlugin<PersonRoomConfig, State, ClientMessage>("person-server", {
    tag: "[person]",
    path: PERSON_PATH,
    protocolVersion: PERSON_PROTOCOL_VERSION,
    maxPayloadBytes: MAX_PAYLOAD_BYTES,
    parseConfig: parseRoomConfig,
    sameConfig: (a, b) => a.markerId === b.markerId && a.markerMm === b.markerMm,
    describeConfig,
    configErrorReason: "空間設定 (markerId / markerMm) が不正です",
    parseMessage: parseClientMessage,
    maxMembers: MAX_PLAYERS,
    maxRooms: MAX_ROOMS,
    createState: () => ({ players: new Map(), poseRate: new RateLimiter(POSE_RATE_PER_SEC) }),
    onJoin(room: Ctx, id, url) {
      const { players } = room.state;
      const player: PlayerInfo = { id, name: parseName(url, id, NAME_MAX_LENGTH), color: pickColor(players) };
      players.set(id, player);
      room.send(id, { type: "welcome", id, players: [...players.values()] } satisfies ServerMessage);
      room.broadcast({ type: "join", player } satisfies ServerMessage, id);
      console.log(`[person] ${id} "${player.name}" color ${player.color}`);
    },
    onMessage(room: Ctx, id, msg, now) {
      if (!room.state.poseRate.allow(id, now)) return;
      const { type: _type, ...pose } = msg;
      // 退室済み・存在しない Player を見たという申告は「不明」に落とす（送信元の自称を信用しない。自分自身も不可）
      if (pose.seen) {
        pose.seen = pose.seen.map((s) => (s.id !== null && s.id !== id && room.members.has(s.id) ? s : { id: null, pos: s.pos }));
      }
      room.broadcast({ type: "pose", id, ...pose } satisfies ServerMessage, id);
    },
    onLeave(room: Ctx, id) {
      room.state.players.delete(id);
      room.state.poseRate.forget(id);
      room.broadcast({ type: "leave", id } satisfies ServerMessage);
    },
  });
}
