// 08-3（アウトサイドイン）用の対戦サーバー。server/splatoon.ts（08）をコピーして拡張したもので、08 のサーバーは触らない。
// 試合のルール・格子・得点は 08 と同じ（src/shared/splatoon-game.ts）。違いは「プレイヤーの位置の出所」だけ:
//   - 接続の役割に tracker（?role=tracker。俯瞰画面と同じ PC の Web カメラ）を足す。tracker は俯瞰画面と同じく
//     プレイヤーではなく、state / pose / shot を受け取り、唯一 track（各マーカーの field 座標系での位置とヨー）を送れる
//   - プレイヤーごとにゴーグルへ貼るマーカーの ID（trackId）を入室順に割り当て、welcome / join で全員に伝える
//   - track を受けたら、マーカーの ID をプレイヤーに引き当てて tracked として全員に配る（スマホは自分の位置をここから受け取る）
//   - プレイヤーの pose はこれまでどおり受け取る（手の 21 点が要る）が、pos はトラッカーの直近の測定値で上書きして配り、
//     発射位置の検証（「頭から 1.2m 以内」）もその値で行う。自己申告の位置は使わない: 一度も測定されていないプレイヤーの
//     pose は配らず、発射は "not tracked yet" で拒否する。見失った後（TRACK_STALE_MS 超過）も最後の測定位置を基準にする
//     （Codex レビューの指摘: 未測定でも自己申告の pose で射撃できた）
//   - トラッカーは 1 台だけ有効（最初に接続した tracker が所有者。2 台目は接続できるが track は "not active tracker" で
//     拒否され、所有者が切断したら引き継ぐ。Codex レビューの指摘: 複数トラッカーが locked と位置を競合する）
import type { RawData } from "ws";
import { isVec, parseName, roomServerPlugin, type RoomContext } from "./room-server.ts";
import {
  HAND_FLAT_LENGTH,
  MAX_POSE_MARKER_IDS,
  MAX_TRACK_ENTRIES,
  NAME_MAX_LENGTH,
  SPLATOON_OUTSIDE_IN_PATH,
  SPLATOON_OUTSIDE_IN_PROTOCOL_VERSION,
  TRACK_ID_FIRST,
  TRACK_RATE_PER_SEC,
  type ClientMessage,
  type ClientRole,
  type PlayerPose,
  type ServerMessage,
  type SplatoonRoomConfig,
  type TrackEntry,
  type TrackedPlayer,
  type TrackerStatus,
} from "../src/shared/splatoon-outside-in-protocol.ts";
import { SplatoonGame } from "../src/shared/splatoon-game.ts";
import { DEFAULT_FIELD, FIELD_SIZE_KEYS, validateFieldSize, type FieldSize, type V3 } from "../src/shared/splatoon-sim.ts";
import { RateLimiter } from "../src/shared/surface-paint.ts";
import { MAX_EXTRA_MARKERS, MAX_MARKER_ID, describeMarkers, validateMarkerLayout, type MarkerFace, type MarkerPlacement } from "../src/shared/marker-layout.ts";

const MAX_PAYLOAD_BYTES = 8 * 1024;
const TICK_MS = 100;
const IDLE_BROADCAST_MS = 1000;
/** プレイヤーの上限（色の数） */
const MAX_PLAYERS = 8;
/** 俯瞰画面の上限（運営 + 予備）。役割は ?role= の自己申告（LAN デモ。URL を知っていれば誰でも開ける） */
const MAX_OVERVIEWS = 2;
/** トラッカーの上限（1 台 + 予備。2 台目のカメラは将来の隠れ対策） */
const MAX_TRACKERS = 2;
const MAX_ROOMS = 64;
/** クライアントの ?sendHz= の max 60 に余裕を持たせる */
const POSE_RATE_PER_SEC = 90;
/** 全員切断してから Room を捨てるまでの猶予（1 人プレイ中の瞬断・bfcache で試合が消えないように） */
const EMPTY_ROOM_TTL_MS = 60 * 1000;

type Tracked = { pos: V3; yaw: number; quality: number; marker: number; atMs: number };
type State = {
  game: SplatoonGame;
  lastBroadcastMs: number;
  poseRate: RateLimiter;
  trackRate: RateLimiter;
  overviews: Set<string>;
  trackers: Set<string>;
  /** 有効なトラッカー（最初に接続した tracker。track を受け付けるのはこれだけ）。居なければ null */
  activeTracker: string | null;
  /** プレイヤー id → ゴーグルのマーカー ID */
  trackIds: Map<string, number>;
  /** プレイヤー id → 直近の観測 */
  tracked: Map<string, Tracked>;
  /** 原点が確定しているトラッカーがいるか（直近の track の locked） */
  locked: boolean;
};
type Ctx = RoomContext<SplatoonRoomConfig, State>;

function roleOf(url: URL): ClientRole {
  const r = url.searchParams.get("role");
  return r === "overview" ? "overview" : r === "tracker" ? "tracker" : "player";
}

/** welcome の peers: プレイヤーだけ（俯瞰画面・トラッカーはアバターを持たないので相手に見せない） */
function playerIds(room: Ctx, excludeId: string): string[] {
  return [...room.members.keys()].filter((k) => k !== excludeId && !room.state.overviews.has(k) && !room.state.trackers.has(k));
}

function isPlayer(room: Ctx, id: string): boolean {
  return !room.state.overviews.has(id) && !room.state.trackers.has(id);
}

/**
 * 空いているマーカー ID のうち最小（入室順に 10, 11, …。退室した番号は次の人が使う）。
 * 原点マーカー（room 設定の markerId）と追加マーカーの ID は避ける（衝突すると、トラッカーがそのプレイヤーのマーカーを
 * 原点候補として消費し、永遠に「位置待ち」になる。Fable レビューの指摘）
 */
function allocTrackId(room: Ctx): number {
  const used = new Set(room.state.trackIds.values());
  used.add(room.config.markerId);
  for (const m of room.state.game.config.markers) used.add(m.id);
  let id = TRACK_ID_FIRST;
  while (used.has(id)) id++;
  return id;
}

function trackerStatus(room: Ctx): TrackerStatus {
  return { connected: room.state.trackers.size, locked: room.state.locked };
}

/** 所有者が居なければ、接続順で次のトラッカーを所有者にする（原点は未確定に戻る） */
function electTracker(room: Ctx) {
  if (room.state.activeTracker && room.state.trackers.has(room.state.activeTracker)) return;
  const next = [...room.state.trackers][0] ?? null;
  room.state.activeTracker = next;
  room.state.locked = false;
  if (next) console.log(`[splatoon-oi] ${next} is now the active tracker`);
}

function trackIdsRecord(room: Ctx): Record<string, number> {
  return Object.fromEntries(room.state.trackIds);
}

/** 直近の観測（見失っていても最後の測定値。一度も測定されていなければ null） */
function lastTracked(room: Ctx, id: string): Tracked | null {
  return room.state.tracked.get(id) ?? null;
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
    let markerIds: number[] | undefined;
    if (m.markerIds !== undefined) {
      if (!Array.isArray(m.markerIds) || m.markerIds.length > MAX_POSE_MARKER_IDS || !m.markerIds.every((v) => Number.isInteger(v) && v >= 0 && v <= 999)) return null;
      markerIds = m.markerIds as number[];
    }
    const pose: PlayerPose = {
      pos: m.pos as V3,
      quat: m.quat.map((v) => v / quatLen) as unknown as PlayerPose["quat"],
      tracking: m.tracking,
    };
    if (hands) pose.hands = hands;
    if (m.fist === true) pose.fist = true;
    if (markerIds && markerIds.length > 0) pose.markerIds = markerIds;
    return { type: "pose", ...pose };
  }
  if (m.type === "track") {
    // トラッカーの観測: 形と範囲だけここで（ID がどのプレイヤーかは onMessage で引き当て、知らない ID は捨てる）
    if (typeof m.locked !== "boolean") return null;
    if (!Array.isArray(m.players) || m.players.length > MAX_TRACK_ENTRIES) return null;
    const players: TrackEntry[] = [];
    for (const raw of m.players) {
      if (typeof raw !== "object" || raw === null) return null;
      const r = raw as Record<string, unknown>;
      if (!Number.isInteger(r.id) || (r.id as number) < 0 || (r.id as number) > MAX_MARKER_ID) return null;
      if (!isVec(r.pos, 3) || r.pos.some((v) => Math.abs(v) > 100)) return null;
      if (typeof r.yaw !== "number" || !Number.isFinite(r.yaw) || Math.abs(r.yaw) > 10) return null;
      if (typeof r.quality !== "number" || !Number.isFinite(r.quality) || r.quality < 0 || r.quality > 1) return null;
      players.push({ id: r.id as number, pos: [r.pos[0], r.pos[1], r.pos[2]], yaw: r.yaw, quality: r.quality });
    }
    return { type: "track", locked: m.locked, players };
  }
  if (m.type === "start") return { type: "start" };
  if (m.type === "stop") return { type: "stop" };
  if (m.type === "reset") return { type: "reset" };
  if (m.type === "dismiss") return { type: "dismiss" };
  if (m.type === "field") {
    // 範囲とセル数の上限は onMessage で validateFieldSize（理由を rejected で返すため）。ここは数値であることだけ
    if (!FIELD_SIZE_KEYS.every((k) => typeof m[k] === "number" && Number.isFinite(m[k]))) return null;
    return { type: "field", wallW: m.wallW as number, wallH: m.wallH as number, floorDepth: m.floorDepth as number, floorDrop: m.floorDrop as number };
  }
  if (m.type === "markers") {
    // 形（配列・各要素の型）だけここで。枚数の上限・ID の重複・床の高さは onMessage で validateMarkerLayout（理由を rejected で返すため。
    // 配列の長さは明らかな異常値だけ弾く）
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

export function splatoonOutsideInServer() {
  return roomServerPlugin<SplatoonRoomConfig, State, ClientMessage>("splatoon-outside-in-server", {
    tag: "[splatoon-oi]",
    path: SPLATOON_OUTSIDE_IN_PATH,
    protocolVersion: SPLATOON_OUTSIDE_IN_PROTOCOL_VERSION,
    maxPayloadBytes: MAX_PAYLOAD_BYTES,
    parseConfig: parseRoomConfig,
    sameConfig: (a, b) => describeConfig(a) === describeConfig(b),
    describeConfig,
    configErrorReason: "Room 設定 (markerId / markerMm / gravity / matchSec / waitSec) が不正です",
    parseMessage: parseClientMessage,
    // 役割ごとの上限（room-server の maxMembers は役割を区別しないので canJoin で数える）
    canJoin(room: Ctx, url) {
      const overviews = room.state.overviews.size;
      const trackers = room.state.trackers.size;
      const role = roleOf(url);
      if (role === "overview") {
        return overviews >= MAX_OVERVIEWS ? `俯瞰画面は ${MAX_OVERVIEWS} 台までです` : null;
      }
      if (role === "tracker") {
        return trackers >= MAX_TRACKERS ? `トラッカーは ${MAX_TRACKERS} 台までです` : null;
      }
      const players = room.members.size - overviews - trackers;
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
      trackRate: new RateLimiter(TRACK_RATE_PER_SEC),
      overviews: new Set(),
      trackers: new Set(),
      activeTracker: null,
      trackIds: new Map(),
      tracked: new Map(),
      locked: false,
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
      const role = roleOf(url);
      if (role === "overview" || role === "tracker") {
        // 俯瞰画面 / トラッカー: プレイヤーにはしない。全体の状態（格子込み）と割当だけ渡す
        (role === "overview" ? room.state.overviews : room.state.trackers).add(id);
        room.send(id, {
          type: "welcome",
          id,
          role,
          peers: playerIds(room, id),
          config: game.config,
          state: game.snapshot(now, true),
          trackIds: trackIdsRecord(room),
          tracker: trackerStatus(room),
        } satisfies ServerMessage);
        console.log(`[splatoon-oi] ${id} ${role} joined`);
        if (role === "tracker") {
          // トラッカーが（再）接続した: 所有者が居なければこれが所有者（原点は未確定から）。居れば待機（track は拒否される）。
          // 全員に状態を知らせる（スマホの HUD「トラッカー待ち」→「原点待ち」）
          electTracker(room);
          if (room.state.activeTracker !== id) console.log(`[splatoon-oi] ${id} tracker standby (active: ${room.state.activeTracker})`);
          room.broadcast({ type: "tracked", tracker: trackerStatus(room), players: [] } satisfies ServerMessage);
        }
        return;
      }
      const name = parseName(url, id, NAME_MAX_LENGTH);
      const trackId = allocTrackId(room);
      room.state.trackIds.set(id, trackId);
      const events = game.join(id, name, now);
      room.send(id, {
        type: "welcome",
        id,
        role: "player",
        peers: playerIds(room, id),
        config: game.config,
        state: game.snapshot(now, true, events[0]),
        trackId,
        trackIds: trackIdsRecord(room),
        tracker: trackerStatus(room),
      } satisfies ServerMessage);
      room.broadcast({ type: "join", id, trackId } satisfies ServerMessage, id);
      // 色の割当が変わったので全員に配る（色を再利用してセルを消したときは格子ごと）
      broadcastState(room, now, events.length > 0 || game.lastJoinClearedColor, events[0]);
      console.log(`[splatoon-oi] ${id} "${name}" color ${game.players.get(id)?.color} marker ${trackId}`);
    },
    onMessage(room: Ctx, id, msg, now) {
      const { game } = room.state;
      const isOverview = room.state.overviews.has(id);
      const isTracker = room.state.trackers.has(id);
      if (msg.type === "track") {
        // 観測はトラッカーだけ。マーカーの ID をプレイヤーに引き当て、知らない ID は捨てる。原点が未確定なら位置は捨てる
        if (!isTracker) {
          room.send(id, { type: "rejected", reason: "not tracker" } satisfies ServerMessage);
          return;
        }
        if (!room.state.trackRate.allow(id, now)) return;
        if (room.state.activeTracker !== id) {
          // 2 台目のトラッカー: 位置と locked を競合させない（所有者が切断したら引き継ぐ）
          room.send(id, { type: "rejected", reason: "not active tracker" } satisfies ServerMessage);
          return;
        }
        room.state.locked = msg.locked;
        const byMarker = new Map<number, string>();
        for (const [pid, mid] of room.state.trackIds) byMarker.set(mid, pid);
        const players: TrackedPlayer[] = [];
        if (msg.locked) {
          for (const e of msg.players) {
            const pid = byMarker.get(e.id);
            if (!pid || players.some((p) => p.player === pid)) continue;
            // 頭の位置（発射位置の検証）へは次の pose のときに反映する（game.updatePose は fist の申告も上書きするので、ここからは呼ばない）
            room.state.tracked.set(pid, { pos: e.pos, yaw: e.yaw, quality: e.quality, marker: e.id, atMs: now });
            players.push({ ...e, player: pid });
          }
        }
        room.broadcast({ type: "tracked", tracker: trackerStatus(room), players } satisfies ServerMessage);
        return;
      }
      if (msg.type === "start") {
        // 対戦開始は俯瞰画面だけ（issue #21「対戦開始はこちら側で制御」）。スマホからの start は拒否を返すだけ
        if (!isOverview) {
          room.send(id, { type: "rejected", reason: "not overview" } satisfies ServerMessage);
          return;
        }
        const events = game.start(now);
        if (events.length === 0) {
          console.log(`[splatoon-oi] ${id} start rejected: ${game.lastRejectReason}`);
          room.send(id, { type: "rejected", reason: game.lastRejectReason } satisfies ServerMessage);
          return;
        }
        console.log(`[splatoon-oi] ${id} start → countdown ${game.config.waitSec}s`);
        broadcastState(room, now, false, events[0]);
        return;
      }
      if (msg.type === "stop") {
        // 途中終了も俯瞰画面だけ（issue #32）。試合中は即座に結果、カウントダウン中は中止して練習へ
        if (!isOverview) {
          room.send(id, { type: "rejected", reason: "not overview" } satisfies ServerMessage);
          return;
        }
        const events = game.stop(now);
        if (events.length === 0) {
          console.log(`[splatoon-oi] ${id} stop rejected: ${game.lastRejectReason}`);
          room.send(id, { type: "rejected", reason: game.lastRejectReason } satisfies ServerMessage);
          return;
        }
        console.log(`[splatoon-oi] ${id} stop → ${events[0].kind}`);
        // 結果は tick の時間切れと同じく格子ごと配る。中止も、結果表示から始めたカウントダウンなら格子が消えるので格子ごと配る
        broadcastState(room, now, true, events[0]);
        return;
      }
      if (msg.type === "reset") {
        // 練習のインクリセットも俯瞰画面だけ（issue #47）。試合中・待機中・結果表示中は誤操作を拒否する
        if (!isOverview) {
          room.send(id, { type: "rejected", reason: "not overview" } satisfies ServerMessage);
          return;
        }
        const events = game.resetPractice(now);
        if (events.length === 0) {
          console.log(`[splatoon-oi] ${id} reset rejected: ${game.lastRejectReason}`);
          room.send(id, { type: "rejected", reason: game.lastRejectReason } satisfies ServerMessage);
          return;
        }
        console.log(`[splatoon-oi] ${id} reset practice ink`);
        // 格子・インク残量・飛行中の弾を初期化した権威状態を全員へ配る
        broadcastState(room, now, true, events[0]);
        return;
      }
      if (msg.type === "dismiss") {
        // 結果を閉じるのも俯瞰画面だけ（issue #45「マスターが明示しない限り結果は消えない」）。結果表示中だけ受け付け、練習に戻る
        if (!isOverview) {
          room.send(id, { type: "rejected", reason: "not overview" } satisfies ServerMessage);
          return;
        }
        const events = game.dismiss(now);
        if (events.length === 0) {
          console.log(`[splatoon-oi] ${id} dismiss rejected: ${game.lastRejectReason}`);
          room.send(id, { type: "rejected", reason: game.lastRejectReason } satisfies ServerMessage);
          return;
        }
        console.log(`[splatoon-oi] ${id} dismiss → ${events[0].kind}`);
        // 格子が消えるので格子ごと配る
        broadcastState(room, now, true, events[0]);
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
          console.log(`[splatoon-oi] ${id} field ${describeSize(size)} rejected: ${reason}`);
          room.send(id, { type: "rejected", reason } satisfies ServerMessage);
          return;
        }
        console.log(`[splatoon-oi] ${id} field → ${describeSize(game.config)} (${game.totalCells} cells)`);
        // 格子が作り直されたので、config と格子付きの state を全員に配る（俯瞰画面も含む）
        room.state.lastBroadcastMs = now;
        room.broadcast({ type: "field", config: game.config, state: game.snapshot(now, true, { kind: "field" }) } satisfies ServerMessage);
        return;
      }
      if (msg.type === "markers") {
        // 追加マーカーの配置の変更も俯瞰画面だけ（issue #30）。配置は塗りに関係しないので格子は配り直さない。
        // 08-3 ではスマホは追加マーカーを検出しない（枠を描くだけ）が、トラッカーの原点合わせに使う（床のマーカー等）
        if (!isOverview) {
          room.send(id, { type: "rejected", reason: "not overview" } satisfies ServerMessage);
          return;
        }
        // ゴーグル用の ID（TRACK_ID_FIRST 以上・割当済みの trackId）と重なる配置は拒否する（トラッカーが原点候補として
        // 消費してしまうため。共有の validateMarkerLayout は 08 と共用なので、ここで追加チェック。Fable レビューの指摘）
        const assigned = new Set(room.state.trackIds.values());
        const clash = msg.markers.find((m) => m.id >= TRACK_ID_FIRST || assigned.has(m.id));
        const invalid =
          validateMarkerLayout(msg.markers, room.config.markerId, game.config.floorDrop) ??
          (clash ? `ID ${clash.id} はゴーグルのマーカー（ID ${TRACK_ID_FIRST} 以上・割当済み）と重なります` : null);
        const reason = invalid ?? (game.setMarkers(msg.markers, now) ? null : game.lastRejectReason);
        if (reason !== null) {
          // 拒否側は face が任意の文字列なので、そのままログに出さず枚数だけ
          console.log(`[splatoon-oi] ${id} markers (${msg.markers.length}) rejected: ${reason}`);
          room.send(id, { type: "rejected", reason } satisfies ServerMessage);
          return;
        }
        console.log(`[splatoon-oi] ${id} markers → ${describeMarkers(game.config.markers)}`);
        room.broadcast({ type: "markers", config: game.config } satisfies ServerMessage);
        return;
      }
      if (!isPlayer(room, id)) return; // 俯瞰画面・トラッカーは pose / shot を送らない（送ってきても捨てる）
      if (msg.type === "pose") {
        if (!room.state.poseRate.allow(id, now)) return;
        // 位置は常にトラッカーの測定値（見失っていても最後の値）。自己申告の pos は使わず、一度も測定されていなければ配らない
        // （頭の位置も更新しない = 発射は "not tracked yet" で拒否される）
        const t = lastTracked(room, id);
        if (!t) return;
        game.updatePose(id, t.pos, now, msg.fist === true);
        const { type: _type, ...pose } = msg;
        room.broadcast({ type: "pose", id, ...pose, pos: t.pos } satisfies ServerMessage, id);
      } else if (msg.type === "shot") {
        if (!lastTracked(room, id)) {
          // 未測定のプレイヤーは撃てない（自己申告の頭位置で検証させない）
          room.send(id, { type: "rejected", reason: "not tracked yet" } satisfies ServerMessage);
          return;
        }
        const shot = game.shoot(id, msg.pos, msg.vel, msg.radius, now);
        if (shot) {
          room.broadcast({ type: "shot", shot, t: now } satisfies ServerMessage);
          const l = shot.landing;
          console.log(
            `[splatoon-oi] ${id} shot #${shot.seq}: ${l?.hit ? `${l.surfaceId} uv=(${l.uv.map((v) => v.toFixed(2)).join(",")}) t=${l.hitT.toFixed(2)}` : "miss"} r=${shot.radius.toFixed(2)} from=(${msg.pos.map((v) => v.toFixed(2)).join(",")}) vel=(${msg.vel.map((v) => v.toFixed(2)).join(",")})`,
          );
        } else if (game.lastRejectReason !== "rate limited") {
          console.log(`[splatoon-oi] ${id} shot rejected: ${game.lastRejectReason}`);
          room.send(id, { type: "rejected", reason: game.lastRejectReason } satisfies ServerMessage);
        }
      }
    },
    onLeave(room: Ctx, id, now) {
      if (room.state.overviews.delete(id)) return; // 俯瞰画面の退室は誰にも関係ない
      if (room.state.trackers.delete(id)) {
        // トラッカーが居なくなった: 所有者なら次のトラッカーが引き継ぐ（原点は未確定から）。全員に知らせる
        // （スマホは最後の位置を保持し HUD に「トラッカー無し」か「原点未確定」）
        room.state.trackRate.forget(id);
        electTracker(room);
        room.broadcast({ type: "tracked", tracker: trackerStatus(room), players: [] } satisfies ServerMessage);
        return;
      }
      room.state.game.leave(id);
      room.state.poseRate.forget(id);
      room.state.trackIds.delete(id);
      room.state.tracked.delete(id);
      room.broadcast({ type: "leave", id } satisfies ServerMessage);
      broadcastState(room, now, false);
    },
  });
}
