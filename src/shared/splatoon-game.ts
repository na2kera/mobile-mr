// Phase 8 (08-splatoon): 試合のルール（純粋クラス。サーバーが権威として持つ）。
//   - 参加順に A / B チームへ交互に振り分ける（1 人なら A だけで練習）
//   - 最初の 1 人が入ったら試合開始。matchSec 経ったら結果（resultSec）→ 格子を消して次の試合
//   - 発射（shot）は位置・速度・半径を検証し、着弾を simulateInk で決めて格子に塗る
//   - 得点 = 塗ったセル数（壁 + 床）
// 06 / 06-2 の *-game.ts と同じく three.js に依存しない（Node テスト対象）
import {
  DEFAULT_FIELD,
  FLOOR_ID,
  InkGrid,
  fieldSurfaces,
  framePointToUv,
  inkPerShot,
  norm,
  simulateInk,
  uvInside,
  type FieldConfig,
  type InkLanding,
  type SurfaceFrame,
  type Team,
  type V3,
} from "./splatoon-sim.ts";

export type Phase = "play" | "result";

export type Player = { id: string; name: string; team: Team };

export type Shot = {
  seq: number;
  by: string;
  team: Team;
  pos: V3;
  vel: V3;
  radius: number;
  /** 権威時刻 [ms] */
  launchedAt: number;
  landing: InkLanding | null;
};

export type GameEvent =
  | { kind: "start" }
  | { kind: "result"; winner: Team | 0 }
  | { kind: "shot"; by: string };

export type GameSnapshot = {
  t: number;
  seq: number;
  phase: Phase;
  /** 今のフェーズが終わる権威時刻 [ms] */
  phaseEndsAt: number;
  players: Player[];
  /** [壁 + 床の A のセル数, B のセル数] */
  scores: [number, number];
  totalCells: number;
  winner: Team | 0 | null;
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
  private seq = 0;
  private shots: Shot[] = [];
  private readonly shotTimes = new Map<string, number[]>();
  /** 直近の頭の位置（発射位置の検証と「自分の色の床の上か」の判定用） */
  private readonly headPos = new Map<string, V3>();
  /** インク残量（0..1） */
  private readonly inkState = new Map<string, { ink: number; updatedMs: number }>();
  private started = false;
  winner: Team | 0 | null = null;
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

  scores(): [number, number] {
    let a = 0;
    let b = 0;
    for (const g of this.grids.values()) {
      const c = g.counts();
      a += c[1];
      b += c[2];
    }
    return [a, b];
  }

  /** 少ない方のチームへ（同数なら A） */
  private pickTeam(): Team {
    let a = 0;
    let b = 0;
    for (const p of this.players.values()) if (p.team === 1) a++; else b++;
    return a <= b ? 1 : 2;
  }

  join(id: string, name: string, now: number): GameEvent[] {
    this.players.set(id, { id, name, team: this.pickTeam() });
    this.inkState.set(id, { ink: 1, updatedMs: now });
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
    return g.cells[y * g.cols + x] === p.team;
  }

  /** 経過時間ぶんの回復を反映する（撃つ前・snapshot 前に呼ぶ） */
  private refreshInk(id: string, now: number) {
    const st = this.inkState.get(id);
    if (!st) return;
    const dt = Math.max(0, (now - st.updatedMs) / 1000);
    st.updatedMs = now;
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
    this.winner = null;
    for (const g of this.grids.values()) g.clear();
    for (const st of this.inkState.values()) {
      st.ink = 1;
      st.updatedMs = now;
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
      const [a, b] = this.scores();
      this.winner = a > b ? 1 : b > a ? 2 : 0;
      this.phase = "result";
      this.phaseEndsAt = now + this.config.resultSec * 1000;
      this.seq++;
      return [{ kind: "result", winner: this.winner }];
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
    const landing = simulateInk(pos, vel, this.surfaces, cfg);
    if (landing?.hit) this.grids.get(landing.surfaceId)?.stamp(landing.uv, radius, p.team);
    const shot: Shot = { seq: ++this.seq, by: id, team: p.team, pos, vel, radius, launchedAt: now, landing };
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
      winner: this.winner,
      shots: this.shots.slice(),
      ink: {},
    };
    for (const id of this.players.keys()) {
      snap.ink[id] = Math.round(this.inkOf(id, now) * 100) / 100;
    }
    if (withGrids) {
      snap.grids = {};
      for (const [id, g] of this.grids) snap.grids[id] = g.encode();
    }
    if (event) snap.event = event;
    return snap;
  }
}
