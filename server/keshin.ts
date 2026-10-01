// ex9-1-keshin（化身）用の Room サーバー。接続の共通部分は server/room-server.ts、書き方は server/person.ts が手本。
// 役割は「Player 一覧（id・名前・色・化身の番号・出ているか・状態が変わった時刻）を持つ」「化身の on/off を確定して全員に配る」
// 「pose（頭の姿勢 + 体の向き + 信用できるか）を検証して中継する」だけ。演出の時刻は keshin-timeline.ts の純粋関数で、
// 途中反転（消えている途中で出す等）のときだけ、いまの見え方と同じになる時刻に開始をずらして配る（全員が同じ見え方になる）。
// 接続の役割は 08 と同じく ?role=player（最大 8）/ ?role=overview（俯瞰画面、最大 2）の自己申告。
// 再接続（v2）: クライアントはタブごとの session 鍵を ?session= に付ける。同じ鍵で入ってきたら古い接続を切って
// 化身の番号・on・changedAt・色・直近の pose を引き継ぐ（古い id の leave は全員に配る）。きれいに切れた後の再入室も
// SESSION_TTL_MS 以内なら引き継ぐ（ページの再読み込み・bfcache の復帰）
import type { RawData, WebSocket } from "ws";
import { isVec, parseName, roomServerPlugin, type RoomContext } from "./room-server.ts";
import {
  KESHIN_COUNT,
  KESHIN_PATH,
  KESHIN_PROTOCOL_VERSION,
  MAX_OVERVIEWS,
  MAX_PLAYERS,
  NAME_MAX_LENGTH,
  REPLACED_REASON,
  SESSION_PATTERN,
  TRACKS,
  assignKeshin,
  type ClientMessage,
  type ClientRole,
  type KeshinPlayer,
  type KeshinPose,
  type KeshinRoomConfig,
  type Quat,
  type ServerMessage,
  type Track,
  type V3,
} from "../src/shared/keshin-protocol.ts";
import { retargetElapsed } from "../src/shared/keshin-timeline.ts";
import { RateLimiter } from "../src/shared/surface-paint.ts";

/** pose の JSON は 300 バイト前後 */
const MAX_PAYLOAD_BYTES = 4 * 1024;
const MAX_ROOMS = 64;
/** クライアントの ?sendHz= の max 60 に余裕を持たせる */
const POSE_RATE_PER_SEC = 90;
/** 化身の on/off の連打の上限（連打は受け付けるが、壊れたクライアントの洪水は止める） */
const KESHIN_RATE_PER_SEC = 10;
/** 位置の上限 [m]（04 / 09 と同じ足切り） */
const POS_LIMIT_M = 100;
/** ageMs の上限（1 日。それ以上はクランプ） */
const AGE_LIMIT_MS = 24 * 60 * 60 * 1000;
/** きれいに切れた後、同じ session 鍵で戻ってきたら引き継ぐ猶予 [ms]（ページの再読み込み・bfcache の復帰） */
const SESSION_TTL_MS = 60 * 1000;

/** 引き継ぐもの（化身の番号・on・changedAt・色・直近の pose とその受信時刻） */
type Carry = Pick<KeshinPlayer, "keshin" | "on" | "changedAt" | "color" | "pose"> & { poseAt: number | null };

type State = {
  players: Map<string, KeshinPlayer>;
  overviews: Set<string>;
  poseRate: RateLimiter;
  keshinRate: RateLimiter;
  /** pose を受け取った時刻（サーバーの performance.now()）。welcome / join の poseAgeMs に使う */
  poseAt: Map<string, number>;
  /** 接続中の id → session 鍵 / session 鍵 → id（プレイヤーと俯瞰画面の両方） */
  sessionOf: Map<string, string>;
  idOfSession: Map<string, string>;
  /** 同じ鍵の再接続で置き換えた古い id（その close では leave を二重に配らない） */
  replaced: Set<string>;
  /** きれいに切れたプレイヤーの引き継ぎ用（session 鍵 → 状態と切れた時刻） */
  departed: Map<string, Carry & { at: number }>;
};
type Ctx = RoomContext<KeshinRoomConfig, State>;

function roleOf(url: URL): ClientRole {
  return url.searchParams.get("role") === "overview" ? "overview" : "player";
}

/**
 * ?session= の鍵（形式外・無しは null = 引き継ぎなし）。役割を前に付けて返す（"player:…" / "overview:…"）。
 * 役割をまたいで同じ鍵を使っても別人として扱う（置き換え・上限の免除・引き継ぎは同じ役割のときだけ。
 * 俯瞰画面の鍵で player として入ると満員を超えられた、というレビューの指摘）
 */
function sessionKeyOf(url: URL): string | null {
  const k = url.searchParams.get("session");
  return k !== null && SESSION_PATTERN.test(k) ? `${roleOf(url)}:${k}` : null;
}


/** 送る形の Player（pose があれば受け取ってからの経過 poseAgeMs を付ける） */
function wirePlayer(room: Ctx, p: KeshinPlayer, now: number): KeshinPlayer {
  const at = room.state.poseAt.get(p.id);
  return p.pose && at !== undefined ? { ...p, poseAgeMs: Math.max(0, Math.round(now - at)) } : p;
}

/** 期限切れの引き継ぎ情報を捨てる */
function pruneDeparted(state: State, now: number) {
  for (const [k, d] of state.departed) if (now - d.at > SESSION_TTL_MS) state.departed.delete(k);
}

/**
 * 受信メッセージの検証（person.ts と同じ厳しさ: NaN・巨大値・退化クォータニオンを捨てる）。不正なら null。
 * テスト（scripts/test-keshin.mjs）からも直接呼ぶ
 */
export function parseClientMessage(data: RawData | string): ClientMessage | null {
  let msg: unknown;
  try {
    msg = JSON.parse(data.toString());
  } catch {
    return null;
  }
  if (typeof msg !== "object" || msg === null || Array.isArray(msg)) return null;
  const m = msg as Record<string, unknown>;
  if (m.type === "keshin") {
    if (typeof m.on !== "boolean") return null;
    return { type: "keshin", on: m.on };
  }
  if (m.type !== "pose") return null;
  if (typeof m.track !== "string" || !(TRACKS as readonly string[]).includes(m.track)) return null;
  const track = m.track as Track;
  if (track === "none") {
    // 位置が無意味な状態。付いていても捨てる（受信側が誤って描かないように）
    return { type: "pose", track, ageMs: null };
  }
  if (!isVec(m.pos, 3) || !isVec(m.quat, 4) || !isVec(m.fwd, 2)) return null;
  if (m.pos.some((v) => Math.abs(v) > POS_LIMIT_M)) return null;
  // 04 と同じ意味的な検証（零・退化クォータニオンは受信側の slerp で NaN になる）
  if (m.quat.some((v) => Math.abs(v) > 1e6)) return null;
  const quatLen = Math.hypot(...m.quat);
  if (!Number.isFinite(quatLen) || quatLen < 0.5) return null;
  if (m.fwd.some((v) => Math.abs(v) > 1e6)) return null;
  const fwdLen = Math.hypot(...m.fwd);
  // 体の向きは水平の単位ベクトル。ほぼ 0 は向きが決まらないので捨てる
  if (!Number.isFinite(fwdLen) || fwdLen < 0.1) return null;
  if (typeof m.ageMs !== "number" || !Number.isFinite(m.ageMs) || m.ageMs < 0) return null;
  const pose: KeshinPose = {
    pos: m.pos as V3,
    quat: m.quat.map((v) => v / quatLen) as Quat,
    fwd: [m.fwd[0] / fwdLen, m.fwd[1] / fwdLen],
    track,
    ageMs: Math.min(AGE_LIMIT_MS, Math.round(m.ageMs)),
  };
  return { type: "pose", ...pose };
}

function parseRoomConfig(url: URL): KeshinRoomConfig | null {
  const markerId = Number(url.searchParams.get("markerId") ?? NaN);
  const markerMm = Number(url.searchParams.get("markerMm") ?? NaN);
  if (!Number.isInteger(markerId) || markerId < 0 || markerId > 999) return null;
  if (!Number.isFinite(markerMm) || markerMm <= 0 || markerMm > 5000) return null;
  return { markerId, markerMm };
}

function describeConfig(c: KeshinRoomConfig): string {
  return `markerId=${c.markerId} markerMm=${c.markerMm}`;
}

/**
 * 未使用の色のうち最小（1..MAX_PLAYERS）。reserved（猶予中に戻ってくるかもしれない人の色）は避けるが、
 * それで選べなければ reserved も使う（人数は canJoin で色数以下に抑えている）
 */
function pickColor(players: ReadonlyMap<string, KeshinPlayer>, reserved: ReadonlySet<number> = new Set()): number {
  const used = new Set([...players.values()].map((p) => p.color));
  for (let c = 1; c <= MAX_PLAYERS; c++) if (!used.has(c) && !reserved.has(c)) return c;
  for (let c = 1; c <= MAX_PLAYERS; c++) if (!used.has(c)) return c;
  return MAX_PLAYERS;
}

/** 猶予中（departed）の色と番号（予約扱い）。except の鍵（戻ってきた本人）は除く */
function reservations(state: State, except: string | null): { colors: Set<number>; keshins: number[] } {
  const colors = new Set<number>();
  const keshins: number[] = [];
  for (const [k, d] of state.departed) {
    if (k === except) continue;
    colors.add(d.color);
    keshins.push(d.keshin);
  }
  return { colors, keshins };
}

export function keshinServer() {
  return roomServerPlugin<KeshinRoomConfig, State, ClientMessage>("keshin-server", {
    tag: "[keshin]",
    path: KESHIN_PATH,
    protocolVersion: KESHIN_PROTOCOL_VERSION,
    maxPayloadBytes: MAX_PAYLOAD_BYTES,
    parseConfig: parseRoomConfig,
    sameConfig: (a, b) => a.markerId === b.markerId && a.markerMm === b.markerMm,
    describeConfig,
    configErrorReason: "空間設定 (markerId / markerMm) が不正です",
    parseMessage: parseClientMessage,
    // 役割ごとの上限（room-server の maxMembers は役割を区別しないので canJoin で数える。08 と同じ書き方）
    canJoin(room: Ctx, url) {
      // 同じ session 鍵の接続が残っているなら、置き換えるので数に入れない（満員でも戻れる）
      const key = sessionKeyOf(url);
      if (key !== null && room.state.idOfSession.has(key)) return null; // 鍵に役割が入っているので同じ役割のときだけ
      const overviews = room.state.overviews.size;
      if (roleOf(url) === "overview") {
        return overviews >= MAX_OVERVIEWS ? `俯瞰画面は ${MAX_OVERVIEWS} 台までです` : null;
      }
      const players = room.members.size - overviews;
      return players >= MAX_PLAYERS ? `room "${room.name}" は満員です (プレイヤー ${MAX_PLAYERS} 人まで)` : null;
    },
    maxRooms: MAX_ROOMS,
    // 1 人で使っているときの再読み込みでも引き継げるよう、空になった Room はしばらく残す
    emptyRoomTtlMs: SESSION_TTL_MS,
    createState: () => ({
      players: new Map(),
      overviews: new Set(),
      poseRate: new RateLimiter(POSE_RATE_PER_SEC),
      keshinRate: new RateLimiter(KESHIN_RATE_PER_SEC),
      poseAt: new Map(),
      sessionOf: new Map(),
      idOfSession: new Map(),
      replaced: new Set(),
      departed: new Map(),
    }),
    onJoin(room: Ctx, id, url, now) {
      const { players, overviews, sessionOf, idOfSession, departed } = room.state;
      pruneDeparted(room.state, now);
      const key = sessionKeyOf(url);
      // 同じ鍵の古い接続が残っていれば置き換える（引き継ぐ状態を取ってから、古い id の leave を全員に配って切る）
      let carry: Carry | null = null;
      const oldId = key !== null ? idOfSession.get(key) : undefined;
      if (oldId !== undefined && oldId !== id) {
        const old = players.get(oldId);
        if (old) carry = { keshin: old.keshin, on: old.on, changedAt: old.changedAt, color: old.color, pose: old.pose, poseAt: room.state.poseAt.get(oldId) ?? null };
        room.state.replaced.add(oldId);
        players.delete(oldId);
        overviews.delete(oldId);
        room.state.poseAt.delete(oldId);
        sessionOf.delete(oldId);
        room.broadcast({ type: "leave", id: oldId } satisfies ServerMessage, id);
        // 古い接続には理由を送ってから閉じる（生きているタブならそこで再接続を止める。半分切れた接続は 2 秒後に切る）
        room.send(oldId, { type: "error", reason: REPLACED_REASON } satisfies ServerMessage);
        const oldWs = room.members.get(oldId) as WebSocket | undefined;
        oldWs?.close(4001, "replaced");
        setTimeout(() => oldWs?.terminate(), 2000);
        console.log(`[keshin] ${id} replaces ${oldId} (same session)`);
      } else if (key !== null && roleOf(url) === "player") {
        const d = departed.get(key);
        if (d) carry = d;
      }
      if (key !== null) {
        departed.delete(key);
        sessionOf.set(id, key);
        idOfSession.set(key, id);
      }
      if (roleOf(url) === "overview") {
        // 俯瞰画面: プレイヤーにはしない（化身も持たない）。全員の状態だけ渡す
        overviews.add(id);
        room.send(id, { type: "welcome", id, role: "overview", players: [...players.values()].map((p) => wirePlayer(room, p, now)), now } satisfies ServerMessage);
        console.log(`[keshin] ${id} overview joined`);
        return;
      }
      // 猶予中の人の色と番号は予約扱い（きれいに切れた人が戻ったとき、他の人と重複しないように）。
      // 引き継ぐ色・番号が、いまいる人とすでに重複していれば選び直す（二重の安全策）
      const res = reservations(room.state, key);
      const current = [...players.values()];
      const carryColorOk = carry !== null && !current.some((p) => p.color === carry.color);
      // 番号は 5 人目（KESHIN_COUNT + 1 人目）から重複するのが正常なので、「いまいる人の中で使われている数が最少の番号」なら引き継ぐ（それより多ければ選び直す）
      const counts = Array.from({ length: KESHIN_COUNT }, () => 0);
      for (const p of current) counts[p.keshin]++;
      const carryKeshinOk = carry !== null && counts[carry.keshin] === Math.min(...counts);
      const player: KeshinPlayer = {
        id,
        name: parseName(url, id, NAME_MAX_LENGTH),
        color: carry && carryColorOk ? carry.color : pickColor(players, res.colors),
        keshin: carry && carryKeshinOk ? carry.keshin : assignKeshin([...current.map((p) => p.keshin), ...res.keshins]),
        on: carry?.on ?? false,
        changedAt: carry?.changedAt ?? null,
      };
      if (carry?.pose) {
        player.pose = carry.pose;
        if (carry.poseAt !== null) room.state.poseAt.set(id, carry.poseAt);
      }
      players.set(id, player);
      room.send(id, { type: "welcome", id, role: "player", players: [...players.values()].map((p) => wirePlayer(room, p, now)), now } satisfies ServerMessage);
      room.broadcast({ type: "join", player: wirePlayer(room, player, now), now } satisfies ServerMessage, id);
      console.log(`[keshin] ${id} "${player.name}" color ${player.color} keshin ${player.keshin}${carry ? ` (引き継ぎ: ${player.on ? "on" : "off"})` : ""}`);
    },
    onMessage(room: Ctx, id, msg, now) {
      const player = room.state.players.get(id);
      // 俯瞰画面は pose も化身も持たない
      if (!player) return;
      if (msg.type === "keshin") {
        if (!room.state.keshinRate.allow(id, now)) return;
        if (msg.on === player.on) return;
        // 途中反転: いまのステージの見え方と同じになる時刻に開始をずらす（消え切っていれば 0 から）
        const prevElapsed = player.changedAt === null ? Infinity : (now - player.changedAt) / 1000;
        const elapsed = retargetElapsed(player.on ? "appear" : "vanish", prevElapsed, msg.on ? "appear" : "vanish");
        player.on = msg.on;
        player.changedAt = now - elapsed * 1000;
        room.broadcast({ type: "keshin", id, on: player.on, keshin: player.keshin, changedAt: player.changedAt, now } satisfies ServerMessage);
        console.log(`[keshin] ${id} ${player.on ? "on" : "off"}${elapsed > 0 ? ` (途中反転: ${elapsed.toFixed(2)}s 進めた位置から)` : ""}`);
        return;
      }
      if (!room.state.poseRate.allow(id, now)) return;
      const { type: _type, ...pose } = msg;
      player.pose = pose;
      room.state.poseAt.set(id, now);
      room.broadcast({ type: "pose", id, ...pose } satisfies ServerMessage, id);
    },
    onLeave(room: Ctx, id, now) {
      const st = room.state;
      st.poseRate.forget(id);
      st.keshinRate.forget(id);
      if (st.replaced.delete(id)) return; // 同じ鍵の再接続で置き換え済み（leave は配ってある）
      const key = st.sessionOf.get(id);
      const player = st.players.get(id);
      if (key !== undefined) {
        st.sessionOf.delete(id);
        if (st.idOfSession.get(key) === id) st.idOfSession.delete(key);
        if (player) st.departed.set(key, { keshin: player.keshin, on: player.on, changedAt: player.changedAt, color: player.color, pose: player.pose, poseAt: st.poseAt.get(id) ?? null, at: now });
      }
      st.overviews.delete(id);
      st.players.delete(id);
      st.poseAt.delete(id);
      room.broadcast({ type: "leave", id } satisfies ServerMessage);
    },
  });
}
