// Phase 8 (08-splatoon): 試合のルール（純粋クラス。サーバーが権威として持つ）。
//   - 参加順に A / B チームへ交互に振り分ける（1 人なら A だけで練習）
//   - 最初の 1 人が入ったら試合開始。matchSec 経ったら結果（resultSec）→ 格子を消して次の試合
//   - 発射（shot）は位置・速度・半径を検証し、着弾を simulateInk で決めて格子に塗る
//   - 得点 = 塗ったセル数（壁 + 床）
// 06 / 06-2 の *-game.ts と同じく three.js に依存しない（Node テスト対象）
import {
  DEFAULT_FIELD,
  FLOOR_ID,
  MAX_INK_COLORS,
  InkGrid,
  fieldSurfaces,
  framePointToUv,
  inkPerShot,
  norm,
  simulateInk,
  uvInside,
  type FieldConfig,
  type InkLanding,
  type InkColor,
  type SurfaceFrame,
  type V3,
} from "./splatoon-sim.ts";

export type Phase = "play" | "result";

export type Player = { id: string; name: string; color: InkColor };

export type Shot = {
  seq: number;
  by: string;
  color: InkColor;
  pos: V3;
  vel: V3;
  radius: number;
  /** 権威時刻 [ms] */
  launchedAt: number;
  landing: InkLanding | null;
};

export type GameEvent =
  | { kind: "start" }
  /** 個人戦の結果。winners = 最多セルのプレイヤー id（同点は複数。誰も塗っていなければ空） */
  | { kind: "result"; winners: string[] }
  | { kind: "shot"; by: string };

export type GameSnapshot = {
  t: number;
  seq: number;
  phase: Phase;
  /** 今のフェーズが終わる権威時刻 [ms] */
  phaseEndsAt: number;
  players: Player[];
  /** プレイヤーごとの塗ったセル数（壁 + 床） */
  scores: Record<string, number>;
  totalCells: number;
  /** result 中の勝者（同点は複数、play 中は null） */
  winners: string[] | null;
  /** 直近の発射（飛行の描画用。着弾済みのものも maxFlightSec の間は残す） */
  shots: Shot[];
  /** プレイヤーごとのインク残量 0..1（サーバー権威。クライアントはこれに予測を重ねる） */
  ink: Record<string, number>;
  /** Surface ごとの格子（welcome / 結果後のリセット時だけ載せる） */
  grids?: Record<string, string>;
  event?: GameEvent;
};

/** 1 人あたりの発射の上限 [回/秒]（クライアントの連射 fireRatePerSec=4 に余裕を持たせる。総量はインクが縛る） */
export const SHOT_RATE_PER_SEC = 6;
/** 発射位置がこの距離 [m] を超えて壁から離れていたら不正 */
export const MAX_SHOT_DIST_M = 6;
/** 発射位置は直近の頭の位置からこの距離 [m] 以内（腕の長さ + 手トラッキングの誤差） */
export const MAX_SHOT_FROM_HEAD_M = 1.2;

export class SplatoonGame {
  readonly config: FieldConfig;
  readonly surfaces: SurfaceFrame[];
  readonly grids = new Map<string, InkGrid>();
  readonly players = new Map<string, Player>();
  phase: Phase = "play";
  phaseEndsAt = Infinity;
  winners: string[] | null = null;
  private seq = 0;
  private shots: Shot[] = [];
  private readonly shotTimes = new Map<string, number[]>();
  /** 直近の頭の位置（発射位置の検証と「自分の色の床の上か」の判定用） */
  private readonly headPos = new Map<string, V3>();
  /** インク残量（0..1）と最後に撃った時刻（回復の遅延用） */
  private readonly inkState = new Map<string, { ink: number; updatedMs: number; lastShotMs: number }>();
  private started = false;
  lastRejectReason = "";

  constructor(config: Partial<FieldConfig> = {}) {
    this.config = { ...DEFAULT_FIELD, ...config };
    this.surfaces = fieldSurfaces(this.config);
    for (const s of this.surfaces) this.grids.set(s.id, new InkGrid(s, this.config.cellM));
  }

  get totalCells(): number {
    let n = 0;
    for (const g of this.grids.values()) n += g.cells.length;
    return n;
  }

  /** プレイヤーごとの塗ったセル数（色番号で集計して id に引き当てる） */
  scores(): Record<string, number> {
    const byColor = new Array<number>(MAX_INK_COLORS + 1).fill(0);
    for (const g of this.grids.values()) {
      const c = g.counts();
      for (let i = 1; i <= MAX_INK_COLORS; i++) byColor[i] += c[i];
    }
    const out: Record<string, number> = {};
    for (const p of this.players.values()) out[p.id] = byColor[p.color];
    return out;
  }

  /** いま使われていない最小の色番号（07 の色割当と同じ。退出者の色は再利用され、残った塗りも引き継がれ得るが個人戦の範囲では許容） */
  private pickColor(): InkColor {
    const used = new Set([...this.players.values()].map((p) => p.color));
    let c = 1;
    while (used.has(c) && c < MAX_INK_COLORS) c++;
    return c;
  }

  join(id: string, name: string, now: number): GameEvent[] {
    this.players.set(id, { id, name, color: this.pickColor() });
    this.inkState.set(id, { ink: 1, updatedMs: now, lastShotMs: -Infinity });
    if (!this.started) {
      this.started = true;
      return this.startMatch(now);
    }
    return [];
  }

  leave(id: string) {
    this.players.delete(id);
    this.shotTimes.delete(id);
    this.headPos.delete(id);
    this.inkState.delete(id);
  }

  updatePose(id: string, pos: V3, now: number) {
    if (!this.players.has(id)) return;
    // 場所が変わる前に、今までの場所での回復を精算する
    this.refreshInk(id, now);
    this.headPos.set(id, pos);
  }

  /** 頭の真下の床のセルが自分のチーム色か（高速回復の条件） */
  onOwnFloorInk(id: string): boolean {
    const p = this.players.get(id);
    const head = this.headPos.get(id);
    if (!p || !head) return false;
    const floor = this.surfaces.find((s) => s.id === FLOOR_ID)!;
    const uv = framePointToUv(floor, head);
    if (!uvInside(uv)) return false;
    const g = this.grids.get(FLOOR_ID)!;
    const x = Math.min(g.cols - 1, Math.max(0, Math.floor(uv[0] * g.cols)));
    const y = Math.min(g.rows - 1, Math.max(0, Math.floor(uv[1] * g.rows)));
    return g.cells[y * g.cols + x] === p.color;
  }

  /** 経過時間ぶんの回復を反映する（撃つ前・snapshot 前に呼ぶ）。撃った直後 inkRegenDelaySec は回復しない */
  private refreshInk(id: string, now: number) {
    const st = this.inkState.get(id);
    if (!st) return;
    const regenFrom = Math.max(st.updatedMs, st.lastShotMs + this.config.inkRegenDelaySec * 1000);
    const dt = Math.max(0, (now - regenFrom) / 1000);
    st.updatedMs = now;
    if (dt <= 0) return;
    const fullSec = this.onOwnFloorInk(id) ? this.config.inkFullOwnInkSec : this.config.inkFullStandSec;
    st.ink = Math.min(1, st.ink + dt / fullSec);
  }

  /** いまのインク残量（0..1）。存在しない id は 0 */
  inkOf(id: string, now: number): number {
    this.refreshInk(id, now);
    return this.inkState.get(id)?.ink ?? 0;
  }

  private startMatch(now: number): GameEvent[] {
    this.phase = "play";
    this.phaseEndsAt = now + this.config.matchSec * 1000;
    this.winners = null;
    for (const g of this.grids.values()) g.clear();
    for (const st of this.inkState.values()) {
      st.ink = 1;
      st.updatedMs = now;
      st.lastShotMs = -Infinity;
    }
    this.shots = [];
    this.seq++;
    return [{ kind: "start" }];
  }

  tick(now: number): GameEvent[] {
    if (!this.started) return [];
    // 古い発射は捨てる（描画に要らない）
    const keepAfter = now - this.config.maxFlightSec * 1000 - 500;
    if (this.shots.length > 0 && this.shots[0].launchedAt < keepAfter) {
      this.shots = this.shots.filter((s) => s.launchedAt >= keepAfter);
    }
    if (now < this.phaseEndsAt) return [];
    if (this.phase === "play") {
      const scores = this.scores();
      const max = Math.max(0, ...Object.values(scores));
      this.winners = max > 0 ? Object.keys(scores).filter((id) => scores[id] === max) : [];
      this.phase = "result";
      this.phaseEndsAt = now + this.config.resultSec * 1000;
      this.seq++;
      return [{ kind: "result", winners: this.winners }];
    }
    return this.startMatch(now);
  }

  /**
   * 発射。速度・半径はチャージから決まるはずなので、上限を超えていたら拒否。
   * 着弾は simulateInk で決め、格子に塗る。受理したら Shot を返す
   */
  shoot(id: string, pos: V3, vel: V3, radius: number, now: number): Shot | null {
    const p = this.players.get(id);
    if (!p) {
      this.lastRejectReason = "unknown player";
      return null;
    }
    if (this.phase !== "play") {
      this.lastRejectReason = "not playing";
      return null;
    }
    // レート制限を検証より先に（不正な発射の連投でログと返信が無制限に出ないように）
    const times = this.shotTimes.get(id) ?? [];
    while (times.length > 0 && now - times[0] > 1000) times.shift();
    if (times.length >= SHOT_RATE_PER_SEC) {
      this.lastRejectReason = "rate limited";
      return null;
    }
    times.push(now);
    this.shotTimes.set(id, times);
    const cfg = this.config;
    if (!(norm(pos) <= MAX_SHOT_DIST_M) || !(pos[2] > 0)) {
      this.lastRejectReason = "bad position";
      return null;
    }
    const head = this.headPos.get(id);
    if (!head) {
      this.lastRejectReason = "no pose yet";
      return null;
    }
    if (!(norm([pos[0] - head[0], pos[1] - head[1], pos[2] - head[2]]) <= MAX_SHOT_FROM_HEAD_M)) {
      this.lastRejectReason = "too far from head";
      return null;
    }
    if (!(norm(vel) <= cfg.shotSpeed * 1.05) || !(radius >= cfg.shotRadius * 0.9 && radius <= cfg.shotRadius * 1.1)) {
      this.lastRejectReason = "bad velocity/radius";
      return null;
    }
    // インクタンク: 1 発 = 1/tankShots。足りなければ拒否（残量はサーバーが権威）
    this.refreshInk(id, now);
    const st = this.inkState.get(id)!;
    const cost = inkPerShot(cfg);
    if (st.ink + 1e-9 < cost) {
      this.lastRejectReason = "no ink";
      return null;
    }
    st.ink -= cost;
    st.lastShotMs = now;
    const landing = simulateInk(pos, vel, this.surfaces, cfg);
    if (landing?.hit) this.grids.get(landing.surfaceId)?.stamp(landing.uv, radius, p.color);
    const shot: Shot = { seq: ++this.seq, by: id, color: p.color, pos, vel, radius, launchedAt: now, landing };
    this.shots.push(shot);
    return shot;
  }

  snapshot(now: number, withGrids = false, event?: GameEvent): GameSnapshot {
    const snap: GameSnapshot = {
      t: now,
      seq: this.seq,
      phase: this.phase,
      phaseEndsAt: this.phaseEndsAt,
      players: [...this.players.values()],
      scores: this.scores(),
      totalCells: this.totalCells,
      winners: this.winners,
      shots: this.shots.slice(),
      ink: {},
    };
    for (const id of this.players.keys()) {
      // 切り捨て（四捨五入だと実残量より多く見え、クライアントが空撃ちする）
      snap.ink[id] = Math.floor(this.inkOf(id, now) * 100) / 100;
    }
    if (withGrids) {
      snap.grids = {};
      for (const [id, g] of this.grids) snap.grids[id] = g.encode();
    }
    if (event) snap.event = event;
    return snap;
  }
}
