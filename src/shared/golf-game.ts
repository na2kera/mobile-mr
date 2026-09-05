// Phase 10 (10-golf): パターゴルフのルール（純粋クラス。サーバーが権威として持つ）。
//   - 参加順に色を割り当て、全員が自分のボールを持つ。手番は参加順に 1 打ずつ交代（カップインした人・打ち切りの人は飛ばす）
//   - 1 打は「向き + 速さ」。向きは構え（address）で決めた狙い（無ければカップの方向）にフェイスの開き（faceDeg）を足したもの。
//     転がり（simulateRoll）はサーバーが計算して終点を権威にし、クライアントは同じ式で描く
//   - 全員が終わったら次のホール。最終ホールが終わったら結果（合計打数の少ない人が勝ち）→ resultMs 後に最初から
//   - 手番が turnTimeoutMs 続いたら（打てない・居ない）そのホールは打ち切り（maxStrokes）にして次へ
//   - 途中参加はいまのホールのティーから（それまでのホールは無し。合計は打ったホールだけ）
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
  /** 全ホール終了。少し見せてから最初に戻る */
  | "result";

export type Player = { id: string; name: string; color: number };

export type Ball = {
  pos: V2;
  /** このホールの打数 */
  strokes: number;
  holed: boolean;
  /** このホールを終えた（カップイン or 打ち切り） */
  done: boolean;
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
  /** 次のホールに進んだ */
  | { kind: "hole"; hole: number }
  | { kind: "timeout"; by: string }
  | { kind: "result"; winners: string[]; winnerNames: string[] }
  | { kind: "restart" }
  | { kind: "field" }
  | { kind: "rules" };

export type GameSnapshot = {
  t: number;
  seq: number;
  phase: Phase;
  /** いまのホール（0 始まり） */
  hole: number;
  holes: HoleDef[];
  players: Player[];
  balls: Record<string, Ball>;
  /** 構えで決めた狙い（床の単位ベクトル）。無ければカップの方向 */
  aims: Record<string, V2 | null>;
  /** 終えたホールの打数（プレイヤーごと。途中参加は打ったホールだけ） */
  cards: Record<string, number[]>;
  turn: string | null;
  /** 手番の期限 [ms]（aim のとき。権威時刻） */
  turnEndsAt: number | null;
  /** 転がっている（or 直近の）1 打 */
  roll: Roll | null;
  /** 結果表示の終わり [ms]（result のとき） */
  phaseEndsAt: number | null;
  winners: string[] | null;
  winnerNames: string[] | null;
  event?: GameEvent;
};

export type GameOptions = {
  /** 止まってから次の手番に移るまで [ms] */
  settleMs: number;
  /** 結果表示の長さ [ms] */
  resultMs: number;
  /** 手番がこの時間 [ms] 打たなければ打ち切り */
  turnTimeoutMs: number;
};

export const DEFAULT_GAME_OPTIONS: GameOptions = {
  settleMs: 1200,
  resultMs: 12000,
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
  phaseEndsAt = -1;
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
    if (this.phase === "result") {
      // 結果表示中の参加は、次の周回に入る
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
    this.phase = "lobby";
    this.turn = null;
    this.turnEndsAt = -1;
    this.roll = null;
    this.hole = 0;
    this.winners = null;
    this.winnerNames = null;
    this.phaseEndsAt = -1;
  }

  private freshBall(): Ball {
    const tee = this.holes[this.hole]?.tee ?? [0, 1];
    return { pos: [tee[0], tee[1]], strokes: 0, holed: false, done: false };
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

  /** 狙いを消す（カップの方向に戻す） */
  clearAim(id: string): boolean {
    if (!this.players.has(id)) return this.reject("not a player");
    this.aims.delete(id);
    this.bump();
    return true;
  }

  /** いまの狙い（構えが無ければカップの方向） */
  aimOf(id: string): V2 {
    const custom = this.aims.get(id);
    if (custom) return custom;
    const ball = this.balls.get(id);
    const cup = this.holes[this.hole]?.cup ?? [0, 0];
    if (!ball) return [0, -1];
    return norm2([cup[0] - ball.pos[0], cup[1] - ball.pos[1]]);
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
    const result = simulateRoll(from, vel, cup, c);
    ball.pos = result.end;
    ball.strokes++;
    ball.holed = result.holed;
    if (result.holed || ball.strokes >= c.maxStrokes) ball.done = true;
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

  /** 次に打つ人（参加順で fromIndex の次から、このホールを終えていない人）。居なければ null */
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
   * 全員が終えていれば次のホール（最終ホールなら結果）
   */
  private advanceTurn(now: number, lastIndex: number): GameEvent[] {
    const next = this.nextPlayer(lastIndex);
    if (next !== null) return [this.startTurn(next, now)];
    // ホール終了: カードに記録
    for (const id of this.order) {
      const ball = this.balls.get(id);
      const card = this.cards.get(id);
      if (ball && card) card.push(ball.strokes);
    }
    // 直近の 1 打はホールをまたいで残さない（再接続の welcome で新しいホールのカップで再計算され「カップイン」が再表示される。外部レビュー指摘）
    this.roll = null;
    if (this.hole + 1 >= this.holes.length) {
      return [this.finish(now)];
    }
    this.hole++;
    for (const id of this.order) this.balls.set(id, this.freshBall());
    this.aims.clear();
    const first = this.nextPlayer(-1);
    const events: GameEvent[] = [{ kind: "hole", hole: this.hole }];
    if (first !== null) events.push(this.startTurn(first, now));
    return events;
  }

  private finish(now: number): GameEvent {
    this.phase = "result";
    this.turn = null;
    this.turnEndsAt = -1;
    this.phaseEndsAt = now + this.opts.resultMs;
    this.computeWinners();
    this.bump();
    return { kind: "result", winners: this.winners ?? [], winnerNames: this.winnerNames ?? [] };
  }

  /** 合計打数（打ったホールだけ）。全ホール打った人を優先し、その中で最少 */
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
    // 全ホール打った人を優先。居なければ 1 ホール以上打った人。一度も打っていない人（結果表示中の参加）は勝者にしない（外部レビュー指摘）
    const played = ids.filter((id) => (this.cards.get(id)?.length ?? 0) > 0);
    const full = played.filter((id) => (this.cards.get(id)?.length ?? 0) >= this.holes.length);
    const pool = full.length > 0 ? full : played;
    if (pool.length === 0) {
      this.winners = [];
      this.winnerNames = [];
      return;
    }
    const best = Math.min(...pool.map((id) => this.totalOf(id)));
    this.winners = pool.filter((id) => this.totalOf(id) === best);
    this.winnerNames = this.winners.map((id) => this.players.get(id)?.name ?? id);
  }

  /** 最初から（俯瞰画面の「最初から」/ 結果表示の終わり）。同じメンバーでホール 1 へ */
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
    this.winners = null;
    this.winnerNames = null;
    this.phaseEndsAt = -1;
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
        ball.strokes = this.config.maxStrokes;
        ball.done = true;
      }
      const idx = this.order.indexOf(id);
      this.bump();
      return [{ kind: "timeout", by: id }, ...this.advanceTurn(now, idx)];
    }
    if (this.phase === "result" && now >= this.phaseEndsAt) {
      return this.restart(now);
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
      balls[id] = { pos: [b.pos[0], b.pos[1]], strokes: b.strokes, holed: b.holed, done: b.done };
      aims[id] = this.aims.get(id) ?? null;
      cards[id] = [...(this.cards.get(id) ?? [])];
    }
    const snap: GameSnapshot = {
      t: now,
      seq: this.seq,
      phase: this.phase,
      hole: this.hole,
      holes: this.holes.map((h) => ({ cup: [h.cup[0], h.cup[1]], tee: [h.tee[0], h.tee[1]] })),
      players: this.order.map((id) => ({ ...this.players.get(id)! })),
      balls,
      aims,
      cards,
      turn: this.turn,
      turnEndsAt: this.phase === "aim" ? this.turnEndsAt : null,
      roll: this.roll ? { ...this.roll, from: [...this.roll.from] as V2, vel: [...this.roll.vel] as V2, end: [...this.roll.end] as V2 } : null,
      phaseEndsAt: this.phase === "result" ? this.phaseEndsAt : null,
      winners: this.winners,
      winnerNames: this.winnerNames,
    };
    if (event) snap.event = event;
    return snap;
  }
}
