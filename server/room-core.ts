// Room サーバーのコア（実行環境に依存しない部分）。docs/CONCEPT.md「サーバーコンポーネントは『コア + アダプタ』の2層にする」の
// コア層にあたる。「入室の判定 → id の採番 → spec の onJoin / onMessage / onLeave の呼び出し → メンバー 0 の破棄予約」だけを行い、
// WebSocket の実 API は知らない（ws も WebSocketPair も import しない）。アダプタは 2 つ:
//   ・server/room-server.ts の attach() — Node の ws（Vite の dev / preview サーバーに同居）。複数の Room を 1 プロセスで持つ
//   ・deploy/cloudflare/keshin-room.ts — Cloudflare の Durable Object（Room 1 つ = DO 1 つ）
// タイマー（tick・破棄予約）は setInterval / setTimeout のグローバルを使う（Node と Workers の両方にある）。
// heartbeat（ping/pong）と送信キューの監視は WebSocket の実 API なのでアダプタの責務

/** 受信データ。Node（ws）の Buffer は ArrayBufferView、Workers の message は string / ArrayBuffer */
export type WireData = string | ArrayBufferLike | ArrayBufferView;

/** spec から見たメンバーの接続。close だけ持つ（terminate は Node の ws だけにある強制切断） */
export type MemberSocket = {
  close(code?: number, reason?: string): void;
  terminate?(): void;
};

/** コアがアダプタから受け取る接続。send は「開いていれば送る」（送信キューの監視などはアダプタが行う） */
export type MemberConn = MemberSocket & {
  send(data: string): void;
};

/** 1 Room のコンテキスト。spec のフックに渡す */
export type RoomContext<C, S> = {
  readonly name: string;
  readonly config: C;
  readonly state: S;
  readonly members: ReadonlyMap<string, MemberSocket>;
  send(id: string, msg: unknown): void;
  broadcast(msg: unknown, excludeId?: string): void;
};

export type RoomServerSpec<C, S, M> = {
  /** ログの接頭辞（"[surface]" 等） */
  tag: string;
  /** WebSocket のアップグレード先パス（Vite の HMR と衝突しない値） */
  path: string;
  protocolVersion: number;
  maxPayloadBytes: number;
  /** 接続クエリから Room 設定を読む。不正なら null（入室拒否） */
  parseConfig(url: URL): C | null;
  sameConfig(a: C, b: C): boolean;
  describeConfig(c: C): string;
  /** parseConfig が null のときに返す理由 */
  configErrorReason: string;
  /** 受信メッセージの検証。不正なら null（黙って捨てる）。文字列にするときは wireText() を使う */
  parseMessage(data: WireData): M | null;
  createState(name: string, config: C): S;
  /** tick の間隔 [ms]。省略時は tick しない */
  tickMs?: number;
  onTick?(room: RoomContext<C, S>, now: number): void;
  /**
   * 入室。welcome の送信と全員への join の通知は spec が行う（内容がデモごとに違うため）。
   * 呼ばれた時点で本人は既に members に入っているので、join を broadcast するときは excludeId=id を渡す
   * （04/06/06-2 は members に入れる前に broadcast していたので、そこから写すときは注意）
   */
  onJoin(room: RoomContext<C, S>, id: string, url: URL, now: number): void;
  onMessage(room: RoomContext<C, S>, id: string, msg: M, now: number): void;
  /** 退室（切断）。leave の通知は spec が行う。members からは既に消えている */
  onLeave(room: RoomContext<C, S>, id: string, now: number): void;
  /** メンバーが 0 になり Room を捨てるとき */
  destroyState?(state: S): void;
  /**
   * メンバーが 0 になってから Room を捨てるまでの猶予 [ms]（省略時 0 = 即捨てる）。
   * 状態を持つ Room（07 のペイント）は、1 人利用中の Wi-Fi 瞬断・bfcache で全部消えないようにここを長くする
   */
  emptyRoomTtlMs?: number;
  /** Room の人数上限（省略時は無制限）。全員に fan-out するので人数の二乗で重くなる */
  maxMembers?: number;
  /** maxMembers で断るときの理由 */
  fullReason?: string;
  /**
   * 役割ごとの上限など、spec 固有の入室可否（08 の「プレイヤー 8 人 + 俯瞰画面 2 台」）。
   * 既存 Room に入るときだけ呼ばれ（本人はまだ members に入っていない）、断る理由の文字列を返すと拒否する。
   * maxMembers より先に評価する
   */
  canJoin?(room: RoomContext<C, S>, url: URL): string | null;
  /**
   * Room の総数上限（省略時は無制限）。emptyRoomTtlMs で空 Room を保持する spec は付けること。
   * 複数の Room を 1 プロセスで持つ Node のアダプタだけが見る（Room 1 つ = DO 1 つの Cloudflare では数えられない）
   */
  maxRooms?: number;
};

/** 表示名。無ければ fallback。長さと制御文字だけ弾く */
export function parseName(url: URL, fallback: string, maxLength: number): string {
  const raw = (url.searchParams.get("name") ?? "").trim();
  if (raw === "") return fallback;
  const cleaned = raw.replace(/\p{Cc}/gu, "");
  return [...cleaned].slice(0, maxLength).join("") || fallback;
}

export const isVec = (v: unknown, len: number): v is number[] =>
  Array.isArray(v) && v.length === len && v.every((n) => typeof n === "number" && Number.isFinite(n));

const utf8 = new TextDecoder();

/** 受信データを文字列にする（UTF-8） */
export function wireText(data: WireData): string {
  if (typeof data === "string") return data;
  return utf8.decode(data as ArrayBuffer | ArrayBufferView);
}

/** 入室の判定の結果。拒否なら理由（クライアントに error で送る文言） */
export type Admission<C> = { ok: true; config: C } | { ok: false; reason: string };

/**
 * 入室の判定（順序と文言は 07 以降の attach() と同じ: プロトコルバージョン → 空間設定 → 既存 Room の設定の一致 →
 * canJoin → maxMembers → Room を新しく作る前の判定）。
 * beforeCreate は Room がまだ無いときだけ呼ぶ（Node のアダプタが maxRooms を数えるのに使う）
 */
export function admit<C, S, M>(
  spec: RoomServerSpec<C, S, M>,
  url: URL,
  roomName: string,
  room: RoomCore<C, S, M> | null | undefined,
  beforeCreate?: () => string | null,
): Admission<C> {
  const version = Number(url.searchParams.get("v") ?? NaN);
  if (version !== spec.protocolVersion) {
    return {
      ok: false,
      reason: `プロトコルバージョン不一致 (server: ${spec.protocolVersion} / client: ${url.searchParams.get("v") ?? "なし"})。ページを再読み込みしてください`,
    };
  }
  const config = spec.parseConfig(url);
  if (!config) return { ok: false, reason: spec.configErrorReason };
  if (room && !spec.sameConfig(room.config, config)) {
    return {
      ok: false,
      reason: `room "${roomName}" の設定と不一致 (参加中: ${spec.describeConfig(room.config)} / あなた: ${spec.describeConfig(config)})`,
    };
  }
  const denied = room ? spec.canJoin?.(room.ctx, url) : null;
  if (room && denied) return { ok: false, reason: denied };
  if (room && spec.maxMembers !== undefined && room.size >= spec.maxMembers) {
    return { ok: false, reason: spec.fullReason ?? `room "${roomName}" は満員です (${spec.maxMembers} 人まで)` };
  }
  if (!room) {
    const reason = beforeCreate?.() ?? null;
    if (reason !== null) return { ok: false, reason };
  }
  return { ok: true, config };
}

export type RoomCoreOptions = {
  /** プレイヤーの id を採番する（Node は全 Room で通し番号、DO は DO ごと） */
  nextId: () => string;
  /** spec に渡す時刻 [ms]（省略時 performance.now()） */
  now?: () => number;
  /** Room を捨てたとき（アダプタが Room の一覧から外す） */
  onDestroy?: () => void;
};

/** 1 Room ぶんのコア。接続の受け付け（admit）を通った接続を join で入れ、message / leave をアダプタから受け取る */
export class RoomCore<C, S, M> {
  readonly ctx: RoomContext<C, S>;
  private readonly membersMut = new Map<string, MemberConn>();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** メンバー 0 で捨てる予約（猶予中に誰か入れば取り消す） */
  private destroyTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private readonly now: () => number;
  private readonly spec: RoomServerSpec<C, S, M>;
  private readonly opts: RoomCoreOptions;

  constructor(spec: RoomServerSpec<C, S, M>, name: string, config: C, opts: RoomCoreOptions) {
    this.spec = spec;
    this.opts = opts;
    this.now = opts.now ?? (() => performance.now());
    const membersMut = this.membersMut;
    this.ctx = {
      name,
      config,
      state: spec.createState(name, config),
      members: membersMut,
      send(id, msg) {
        membersMut.get(id)?.send(JSON.stringify(msg));
      },
      broadcast(msg, excludeId) {
        const data = JSON.stringify(msg);
        for (const [id, conn] of membersMut) {
          if (id !== excludeId) conn.send(data);
        }
      },
    };
    if (spec.tickMs && spec.onTick) {
      const onTick = spec.onTick;
      this.timer = setInterval(() => onTick(this.ctx, this.now()), spec.tickMs);
    }
  }

  get name(): string {
    return this.ctx.name;
  }
  get config(): C {
    return this.ctx.config;
  }
  get size(): number {
    return this.membersMut.size;
  }
  has(id: string): boolean {
    return this.membersMut.has(id);
  }

  /** 入室させて id を返す（admit を通った接続だけを渡すこと） */
  join(conn: MemberConn, url: URL): string {
    if (this.destroyTimer) {
      clearTimeout(this.destroyTimer);
      this.destroyTimer = null;
    }
    const id = this.opts.nextId();
    this.membersMut.set(id, conn);
    this.spec.onJoin(this.ctx, id, url, this.now());
    console.log(`${this.spec.tag} ${id} joined room "${this.name}" (${this.membersMut.size} members)`);
    return id;
  }

  message(id: string, data: WireData): void {
    // error → close は非同期なので、退室処理の後に届いたメッセージは捨てる
    if (!this.membersMut.has(id)) return;
    const msg = this.spec.parseMessage(data);
    if (msg === null) return;
    this.spec.onMessage(this.ctx, id, msg, this.now());
  }

  /** 退室（close / error のどちらから呼ばれてもよい。2 回目以降は何もしない） */
  leave(id: string): void {
    if (!this.membersMut.delete(id)) return;
    const now = this.now();
    this.spec.onLeave(this.ctx, id, now);
    if (this.membersMut.size === 0) {
      const ttl = this.spec.emptyRoomTtlMs ?? 0;
      if (ttl > 0) {
        this.destroyTimer = setTimeout(() => this.destroy(), ttl);
      } else {
        this.destroy();
      }
    }
    console.log(`${this.spec.tag} ${id} left room "${this.name}" (${this.membersMut.size} members)`);
  }

  /** Room を捨てる（tick と破棄予約を止め、spec の destroyState を呼ぶ） */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stopTimers();
    this.spec.destroyState?.(this.ctx.state);
    this.opts.onDestroy?.();
    console.log(`${this.spec.tag} room "${this.name}" destroyed`);
  }

  /** タイマーだけ止める（サーバーの終了時。destroyState は呼ばない） */
  stopTimers(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.destroyTimer) clearTimeout(this.destroyTimer);
    this.timer = null;
    this.destroyTimer = null;
  }
}
