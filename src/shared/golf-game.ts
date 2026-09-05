// Phase 10 (10-golf): パターゴルフのルール（純粋クラス。サーバーが権威として持つ）。
//   - 各ラウンドは参加順に各自 1 打。カップイン優先、次に残り距離（mm 単位）で順位を決める。
//   - 1 位 N 点、2 位 N-1 点…（N はラウンド終了時の人数）。同順位は同点、時間切れは 0 点。
//   - 1 打は「向き + 速さ」。構えが無ければ正面（-Z）へ、構えた向きに faceDeg を足して打つ。
//     転がり（simulateRoll）はサーバーが計算して終点を権威にし、クライアントは同じ式で描く
//   - 全員の一打後にラウンド結果を表示して次の配置へ。最終ラウンド後は合計点の最多が勝ち。
//   - 途中参加は進行中なら現在のティーから、結果表示中なら次ラウンドから。過去ラウンドの得点は無し。
// 06-2 / 08 の *-game.ts と同じく three.js に依存しない（Node テスト対象）
import {
  DEFAULT_GOLF,
  GOLF_SIZE_CELL_M,
  PLAYER_COLORS,
  makeHoles,
  norm2,
  rotate2,
  round3,
  simulateRoll,
  validateFieldSize,
  validateGolfRules,
  type FieldSize,
  type GolfConfig,
  type GolfRules,
  type HoleDef,
  type V2,
} from "./golf-sim.ts";
import { withFloorDrop } from "./marker-layout.ts";
import type { MarkerPlacement } from "./marker-layout.ts";

export type Phase =
  /** 参加者 0 人 */
  | "lobby"
  /** 手番のプレイヤーが打つのを待っている */
  | "aim"
  /** ボールが転がっている（止まって少し見せるまで） */
  | "rolling"
  /** 各自の一打が終了。マスターが進めるまで順位・距離を保持 */
  | "roundResult"
  /** 全ラウンド終了。マスターが最初から始めるまで保持 */
  | "result";

export type Player = { id: string; name: string; color: number };

export type Ball = {
  pos: V2;
  /** このラウンドの打数（0 または 1） */
  strokes: number;
  holed: boolean;
  /** このラウンドを終えた（一打済み、時間切れ、結果表示中の途中参加） */
  done: boolean;
  /** 一打の残り距離 [mm]。未打・時間切れは null。カップインは 0 */
  distanceMm: number | null;
  /** ラウンド確定時の順位。時間切れ・未確定は null */
  rank: number | null;
};

export type Roll = {
  seq: number;
  by: string;
  from: V2;
  /** 初速（床の速度 [m/s]） */
  vel: V2;
  /** 打った権威時刻 [ms] */
  startedAt: number;
  /** 転がりの長さ [s]（クライアントは同じ式で計算できるが、突き合わせ用に載せる） */
  duration: number;
  end: V2;
  holed: boolean;
  bounces: number;
};

export type GameEvent =
  | { kind: "stroke"; by: string; holed: boolean; strokes: number }
  | { kind: "turn"; playerId: string }
  /** 次のラウンドに進んだ */
  | { kind: "hole"; hole: number }
  | { kind: "roundResult"; hole: number }
  | { kind: "timeout"; by: string }
  | { kind: "result"; winners: string[]; winnerNames: string[] }
  | { kind: "restart" }
  | { kind: "field" }
  | { kind: "rules" };

export type GameSnapshot = {
  t: number;
  seq: number;
  phase: Phase;
  /** いまのラウンド（0 始まり。通信上の互換性のため hole の名称を維持） */
  hole: number;
  holes: HoleDef[];
  players: Player[];
  balls: Record<string, Ball>;
  /** 構えで決めた狙い（床の単位ベクトル）。無ければ正面 */
  aims: Record<string, V2 | null>;
  /** 終えたラウンドの順位点（途中参加前のラウンドは含まない） */
  cards: Record<string, number[]>;
  turn: string | null;
  /** 手番の期限 [ms]（aim のとき。権威時刻） */
  turnEndsAt: number | null;
  /** 転がっている（or 直近の）1 打 */
  roll: Roll | null;
  winners: string[] | null;
  winnerNames: string[] | null;
  event?: GameEvent;
};

export type GameOptions = {
  /** 止まってから次の手番に移るまで [ms] */
  settleMs: number;
  /** 手番がこの時間 [ms] 打たなければ時間切れ */
  turnTimeoutMs: number;
};

export const DEFAULT_GAME_OPTIONS: GameOptions = {
  settleMs: 1200,
  turnTimeoutMs: 90000,
};

export const MAX_PLAYERS = PLAYER_COLORS.length;

export class GolfGame {
  /** setFieldSize / setRules で差し替わる（参照を取っておかず、都度 game.config を読むこと） */
  config: GolfConfig;
  readonly opts: GameOptions;
  readonly players = new Map<string, Player>();
  /** 参加順（= 手番の順） */
  private order: string[] = [];
  holes: HoleDef[] = [];
  phase: Phase = "lobby";
  hole = 0;
  readonly balls = new Map<string, Ball>();
  readonly aims = new Map<string, V2>();
  readonly cards = new Map<string, number[]>();
  turn: string | null = null;
  turnEndsAt = -1;
  roll: Roll | null = null;
  winners: string[] | null = null;
  winnerNames: string[] | null = null;
  /** 直近の pose から出した視線と床の交点（構えの狙いに使う） */
  private readonly gaze = new Map<string, V2 | null>();
  private seq = 0;
  private rollSeq = 0;
  /** rolling → 次の手番へ進める時刻 */
  private nextAtMs = -1;
  /** 転がしている本人が抜けたときの「その人が居た位置 - 1」（止まったあとの手番探索の起点。外部レビュー指摘） */
  private pendingLastIndex: number | null = null;
  lastRejectReason = "";

  constructor(config: Partial<GolfConfig> = {}, opts: Partial<GameOptions> = {}) {
    this.config = { ...DEFAULT_GOLF, ...config };
    this.opts = { ...DEFAULT_GAME_OPTIONS, ...opts };
    this.holes = makeHoles(this.config, this.config.holes);
  }

  private bump() {
    this.seq++;
  }

  private reject(why: string): false {
    this.lastRejectReason = why;
    return false;
  }

  // ---- 参加・退出 ----

  join(id: string, name: string, now: number): GameEvent[] {
    if (this.players.has(id)) return [];
    const used = new Set([...this.players.values()].map((p) => p.color));
    let color = 1;
    while (used.has(color) && color < MAX_PLAYERS) color++;
    this.players.set(id, { id, name, color });
    this.order.push(id);
    this.cards.set(id, []);
    this.balls.set(id, this.freshBall());
    this.bump();
    if (this.phase === "lobby") {
      this.phase = "aim";
      this.hole = 0;
      return [this.startTurn(id, now)];
    }
    if (this.phase === "result" || this.phase === "roundResult") {
      // 確定済みのラウンドには入れない。次の配置で freshBall に戻す
      this.balls.get(id)!.done = true;
      return [];
    }
    return [];
  }

  leave(id: string, now: number): GameEvent[] {
    if (!this.players.delete(id)) return [];
    const idx = this.order.indexOf(id);
    this.order = this.order.filter((p) => p !== id);
    this.balls.delete(id);
    this.aims.delete(id);
    this.cards.delete(id);
    this.gaze.delete(id);
    this.bump();
    if (this.order.length === 0) {
      this.resetToLobby();
      return [];
    }
    if (this.phase === "aim" && this.turn === id) {
      // 抜けた人の位置から次を探す。配列から消えたぶん 1 つ手前を起点にする（外部レビュー指摘: 直後の人を飛ばしていた）
      return this.advanceTurn(now, idx - 1);
    }
    if (this.phase === "rolling" && this.roll?.by === id) {
      // 転がしている途中で抜けた: 転がりは見せ、止まったら「抜けた人の次」へ（tick が pendingLastIndex を使う）
      this.pendingLastIndex = idx - 1;
      return [];
    }
    if (this.phase === "rolling" && this.pendingLastIndex !== null && idx <= this.pendingLastIndex) {
      // 転がし中に抜けた人より前の人がさらに抜けた: 起点を詰める
      this.pendingLastIndex--;
    }
    if (this.phase === "result") {
      this.computeWinners();
    }
    return [];
  }

  private resetToLobby() {
    this.pendingLastIndex = null;
    this.phase = "lobby";
    this.turn = null;
    this.turnEndsAt = -1;
    this.roll = null;
    this.hole = 0;
    this.winners = null;
    this.winnerNames = null;
  }

  private freshBall(): Ball {
    const tee = this.holes[this.hole]?.tee ?? [0, 1];
    return { pos: [tee[0], tee[1]], strokes: 0, holed: false, done: false, distanceMm: null, rank: null };
  }

  // ---- 視線と構え ----

  /** pose から出した視線と床の交点（無ければ null）。構えの狙いに使う */
  updateGaze(id: string, gaze: V2 | null) {
    if (this.players.has(id)) this.gaze.set(id, gaze);
  }

  /**
   * 構え: 狙いを「ボール → target」の向きにする。target が無ければ直近の視線の床の交点。
   * 手番でなくても、転がっている間でも自分の狙いは決められる（終えた人は不可）
   */
  address(id: string, target: V2 | null | undefined): boolean {
    const ball = this.balls.get(id);
    if (!ball) return this.reject("not a player");
    if (ball.done) return this.reject("already done");
    const t = target ?? this.gaze.get(id) ?? null;
    if (!t) return this.reject("no gaze on floor (look at the green)");
    const d: V2 = [t[0] - ball.pos[0], t[1] - ball.pos[1]];
    if (Math.hypot(d[0], d[1]) < 0.05) return this.reject("target too close to the ball");
    this.aims.set(id, norm2(d));
    this.bump();
    return true;
  }

  /** 狙いを消す（正面に戻す） */
  clearAim(id: string): boolean {
    if (!this.players.has(id)) return this.reject("not a player");
    this.aims.delete(id);
    this.bump();
    return true;
  }

  /** いまの狙い（構えが無ければ正面。勾配・障害物は自分で狙いを調整する） */
  aimOf(id: string): V2 {
    const custom = this.aims.get(id);
    if (custom) return custom;
    return [0, -1];
  }

  // ---- 1 打 ----

  /** 手番のプレイヤーの 1 打。受理したらイベント（stroke）を返す。速すぎ・遅すぎは拒否 */
  stroke(id: string, speed: number, faceDeg: number, now: number): GameEvent[] | null {
    if (this.phase !== "aim") {
      this.reject(`phase=${this.phase}`);
      return null;
    }
    if (this.turn !== id) {
      this.reject(`not your turn (turn=${this.turn ?? "-"})`);
      return null;
    }
    const ball = this.balls.get(id);
    if (!ball || ball.done) {
      this.reject("already done");
      return null;
    }
    const c = this.config;
    if (!Number.isFinite(speed) || speed < c.minStrokeSpeed) {
      this.reject(`speed=${speed.toFixed(2)} below ${c.minStrokeSpeed} (whiff)`);
      return null;
    }
    if (speed > c.maxStrokeSpeed) {
      this.reject(`speed=${speed.toFixed(2)} above ${c.maxStrokeSpeed}`);
      return null;
    }
    if (!Number.isFinite(faceDeg) || Math.abs(faceDeg) > 90) {
      this.reject(`faceDeg=${faceDeg} out of ±90`);
      return null;
    }
    const dir = rotate2(this.aimOf(id), faceDeg);
    const vel: V2 = [round3(dir[0] * speed), round3(dir[1] * speed)];
    const from: V2 = [ball.pos[0], ball.pos[1]];
    const cup = this.holes[this.hole].cup;
    const result = simulateRoll(from, vel, cup, c, this.holes[this.hole]);
    ball.pos = result.end;
    ball.strokes++;
    ball.holed = result.holed;
    ball.done = true;
    ball.distanceMm = result.holed ? 0 : Math.round(Math.hypot(result.end[0] - cup[0], result.end[1] - cup[1]) * 1000);
    this.aims.delete(id);
    this.roll = {
      seq: ++this.rollSeq,
      by: id,
      from,
      vel,
      startedAt: now,
      duration: result.duration,
      end: result.end,
      holed: result.holed,
      bounces: result.bounces,
    };
    this.phase = "rolling";
    this.turn = null;
    this.turnEndsAt = -1;
    this.nextAtMs = now + result.duration * 1000 + this.opts.settleMs;
    this.bump();
    return [{ kind: "stroke", by: id, holed: result.holed, strokes: ball.strokes }];
  }

  // ---- 手番と進行 ----

  private startTurn(id: string, now: number): GameEvent {
    this.phase = "aim";
    this.turn = id;
    this.turnEndsAt = now + this.opts.turnTimeoutMs;
    this.bump();
    return { kind: "turn", playerId: id };
  }

  /** 次に打つ人（参加順で fromIndex の次から、このラウンドを終えていない人）。居なければ null */
  private nextPlayer(fromIndex: number): string | null {
    const n = this.order.length;
    for (let k = 1; k <= n; k++) {
      const id = this.order[(fromIndex + k) % n];
      const ball = this.balls.get(id);
      if (ball && !ball.done) return id;
    }
    return null;
  }

  /**
   * 次の手番へ。lastIndex は直前に打った人の参加順の位置（抜けた人の位置でも良い）。
   * 全員が終えていればラウンド結果へ
   */
  private advanceTurn(now: number, lastIndex: number): GameEvent[] {
    const next = this.nextPlayer(lastIndex);
    if (next !== null) return [this.startTurn(next, now)];
    // ラウンド終了: カップイン > 残り距離。同距離は同順位（mm 単位）、未打は 0 点
    const ranked = this.order.map((id) => ({ id, ball: this.balls.get(id)! }))
      .filter(({ ball }) => ball.distanceMm !== null)
      .sort((a, b) => Number(b.ball.holed) - Number(a.ball.holed) || a.ball.distanceMm! - b.ball.distanceMm!);
    let rank = 0;
    ranked.forEach(({ ball }, i) => {
      const prev = ranked[i - 1]?.ball;
      if (!prev || prev.holed !== ball.holed || prev.distanceMm !== ball.distanceMm) rank = i + 1;
      ball.rank = rank;
    });
    for (const id of this.order) {
      const ball = this.balls.get(id);
      const card = this.cards.get(id);
      if (ball && card) card.push(ball.rank === null ? 0 : this.order.length - ball.rank + 1);
    }
    this.phase = "roundResult";
    this.turn = null;
    this.turnEndsAt = -1;
    this.bump();
    return [{ kind: "roundResult", hole: this.hole }];
  }

  /** 俯瞰画面が結果確認後に呼ぶ。結果はこの操作まで無期限に保持する */
  advanceRound(now: number): GameEvent[] | null {
    if (this.phase !== "roundResult") {
      this.reject(`phase=${this.phase}`);
      return null;
    }
    return this.nextRound(now);
  }

  private nextRound(now: number): GameEvent[] {
    // 直近の 1 打はラウンドをまたいで残さない（再接続で新しいカップに対して再計算されるのを防ぐ）
    this.roll = null;
    if (this.hole + 1 >= this.holes.length) {
      return [this.finish()];
    }
    this.hole++;
    for (const id of this.order) this.balls.set(id, this.freshBall());
    this.aims.clear();
    const first = this.nextPlayer(-1);
    const events: GameEvent[] = [{ kind: "hole", hole: this.hole }];
    if (first !== null) events.push(this.startTurn(first, now));
    return events;
  }

  private finish(): GameEvent {
    this.phase = "result";
    this.turn = null;
    this.turnEndsAt = -1;
    this.computeWinners();
    this.bump();
    return { kind: "result", winners: this.winners ?? [], winnerNames: this.winnerNames ?? [] };
  }

  /** 合計順位点 */
  totalOf(id: string): number {
    return (this.cards.get(id) ?? []).reduce((a, b) => a + b, 0);
  }

  private computeWinners() {
    const ids = [...this.players.keys()];
    if (ids.length === 0) {
      this.winners = [];
      this.winnerNames = [];
      return;
    }
    // 時間切れだけの人・結果表示中に参加した人は勝者にしない
    const pool = ids.filter((id) => this.totalOf(id) > 0);
    if (pool.length === 0) {
      this.winners = [];
      this.winnerNames = [];
      return;
    }
    const best = Math.max(...pool.map((id) => this.totalOf(id)));
    this.winners = pool.filter((id) => this.totalOf(id) === best);
    this.winnerNames = this.winners.map((id) => this.players.get(id)?.name ?? id);
  }

  /** 俯瞰画面の「最初から」。同じメンバーでラウンド 1 へ */
  restart(now: number): GameEvent[] {
    if (this.order.length === 0) {
      this.resetToLobby();
      return [];
    }
    this.hole = 0;
    this.holes = makeHoles(this.config, this.config.holes);
    for (const id of this.order) {
      this.balls.set(id, this.freshBall());
      this.cards.set(id, []);
    }
    this.aims.clear();
    this.roll = null;
    this.pendingLastIndex = null;
    this.winners = null;
    this.winnerNames = null;
    const first = this.nextPlayer(-1)!;
    return [{ kind: "restart" }, this.startTurn(first, now)];
  }

  tick(now: number): GameEvent[] {
    if (this.phase === "rolling" && now >= this.nextAtMs) {
      const by = this.roll?.by ?? "";
      const found = this.order.indexOf(by);
      // 打った人が抜けていたら、抜けた時点の位置（pendingLastIndex）から探す
      const idx = found >= 0 ? found : (this.pendingLastIndex ?? -1);
      this.pendingLastIndex = null;
      return this.advanceTurn(now, idx);
    }
    if (this.phase === "aim" && this.turn !== null && now >= this.turnEndsAt) {
      const id = this.turn;
      const ball = this.balls.get(id);
      if (ball) {
        ball.done = true;
      }
      const idx = this.order.indexOf(id);
      this.bump();
      return [{ kind: "timeout", by: id }, ...this.advanceTurn(now, idx)];
    }
    return [];
  }

  // ---- 俯瞰画面からの設定 ----

  /** コートの寸法（練習中は無いので、転がっていないときならいつでも。ボールは新しいティーへ = 最初から） */
  setFieldSize(size: FieldSize, now: number): GameEvent[] | null {
    if (this.phase === "rolling") {
      this.reject("cannot resize during rolling");
      return null;
    }
    const invalid = validateFieldSize(size, GOLF_SIZE_CELL_M);
    if (invalid) {
      this.reject(invalid);
      return null;
    }
    this.config = { ...this.config, ...size, markers: withFloorDrop(this.config.markers, size.floorDrop) };
    this.holes = makeHoles(this.config, this.config.holes);
    const events = this.restart(now);
    return [{ kind: "field" }, ...events];
  }

  setRules(rules: GolfRules, now: number): GameEvent[] | null {
    if (this.phase === "rolling") {
      this.reject("cannot change rules during rolling");
      return null;
    }
    const invalid = validateGolfRules(rules);
    if (invalid) {
      this.reject(invalid);
      return null;
    }
    this.config = { ...this.config, ...rules };
    this.holes = makeHoles(this.config, this.config.holes);
    const events = this.restart(now);
    return [{ kind: "rules" }, ...events];
  }

  /** 追加マーカーの配置（位置合わせだけなのでゲームは進めない） */
  setMarkers(markers: MarkerPlacement[]): boolean {
    this.config = { ...this.config, markers: markers.map((m) => ({ id: m.id, face: m.face, pos: [m.pos[0], m.pos[1], m.pos[2]] })) };
    this.bump();
    return true;
  }

  // ---- snapshot ----

  snapshot(now: number, event?: GameEvent): GameSnapshot {
    const balls: Record<string, Ball> = {};
    const aims: Record<string, V2 | null> = {};
    const cards: Record<string, number[]> = {};
    for (const id of this.order) {
      const b = this.balls.get(id)!;
      balls[id] = { ...b, pos: [b.pos[0], b.pos[1]] };
      aims[id] = this.aims.get(id) ?? null;
      cards[id] = [...(this.cards.get(id) ?? [])];
    }
    const snap: GameSnapshot = {
      t: now,
      seq: this.seq,
      phase: this.phase,
      hole: this.hole,
      holes: this.holes.map((h) => ({
        cup: [...h.cup] as V2, tee: [...h.tee] as V2, slope: [...h.slope] as V2,
        obstacles: h.obstacles.map(o => ({ ...o, center: [...o.center] as V2 })),
      })),
      players: this.order.map((id) => ({ ...this.players.get(id)! })),
      balls,
      aims,
      cards,
      turn: this.turn,
      turnEndsAt: this.phase === "aim" ? this.turnEndsAt : null,
      roll: this.roll ? { ...this.roll, from: [...this.roll.from] as V2, vel: [...this.roll.vel] as V2, end: [...this.roll.end] as V2 } : null,
      winners: this.winners,
      winnerNames: this.winnerNames,
    };
    if (event) snap.event = event;
    return snap;
  }
}
