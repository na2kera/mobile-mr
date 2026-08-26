// Phase 6-2: ダーツのルール（参加順の手番・3 投ずつ・採点・ラウンド・結果）。
// サーバー（server/darts.ts）だけが実行する権威ロジックだが、WebSocket や Node に触れない
// 純粋なクラスにしてある（06 の VolleyballGame と同じ方針。Node の回帰テスト
// scripts/test-darts.mjs から直接叩く）。時刻は呼び出し側から渡す（now [ms]）
import { DEFAULT_DARTS, len3, simulateDart } from "./darts-sim.ts";
import type { DartsConfig, Landing, V3 } from "./darts-sim.ts";

export type Phase =
  /** 参加者 0 人 */
  | "lobby"
  /** 手番のプレイヤーが投げるのを待っている */
  | "aim"
  /** ダーツが飛んでいる → 刺さって少し見せるまで */
  | "flight"
  /** 全ラウンド終了。少し見せてから最初に戻る */
  | "result";

export type PlayerInfo = { id: string; name: string };

export type Dart = {
  /** 投げた人 */
  by: string;
  /** 何ラウンド目・何投目か（0 始まり） */
  round: number;
  index: number;
  /** 投げた位置・速度（board 座標系）。クライアントはここから同じ式で飛行を描く */
  launch: { pos: V3; vel: V3 };
  /** 投げたサーバー時刻 [ms]（GameState.t と同じ時計） */
  launchedAt: number;
  landing: Landing;
};

export type GameEvent = {
  kind: "throw" | "throw-rejected" | "turn" | "timeout" | "result" | "restart";
  by?: string;
};

export type GameState = {
  /** サーバー時刻 [ms]（performance.now 基準）。クライアントは受信時刻との差で飛行を進める */
  t: number;
  seq: number;
  phase: Phase;
  /** 参加順（= 手番の順） */
  players: PlayerInfo[];
  round: number;
  /** 手番。aim / flight のとき */
  turn: { playerId: string; index: number } | null;
  /** 合計点 */
  scores: Record<string, number>;
  /** ボードに刺さっている（または今飛んでいる）ダーツ。手番が替わると抜かれる */
  darts: Dart[];
  /** 全ラウンド終了時の勝者（同点は複数） */
  winners: string[] | null;
  /** この snapshot で起きた出来事（状態の変化を配る契機。無ければ undefined） */
  event?: GameEvent;
  /** 受け付けなかった throw の申告者（その人にだけ送る） */
  rejectedFor?: string;
};

export type GameOptions = {
  config: DartsConfig;
  /** 刺さってから次の投げに移るまでの間 [ms] */
  settleMs: number;
  /** 手番の最後の 1 投が刺さってから、ダーツを抜いて次の人へ移るまで [ms] */
  turnEndMs: number;
  /** 結果表示の長さ [ms]。過ぎたら同じメンバーで最初から */
  resultMs: number;
  /** 手番が来てからこの時間投げなければ 0 点で進める [ms] */
  turnTimeoutMs: number;
  /** throw の受理: 投げた位置がこの範囲（Z の下限〜上限、XY の絶対値上限）[m] */
  minThrowZ: number;
  maxThrowZ: number;
  maxThrowXY: number;
  /** throw の受理: 速さの上限 [m/s] */
  maxThrowSpeed: number;
};

export const DEFAULT_GAME_OPTIONS: GameOptions = {
  config: DEFAULT_DARTS,
  settleMs: 900,
  turnEndMs: 2500,
  resultMs: 10000,
  turnTimeoutMs: 60000,
  minThrowZ: 0.15,
  maxThrowZ: 8,
  maxThrowXY: 4,
  maxThrowSpeed: 30,
};

export type Player = PlayerInfo & {
  joinedMs: number;
  lastPoseMs: number;
};

export class DartsGame {
  readonly players = new Map<string, Player>();
  readonly opts: GameOptions;
  readonly config: DartsConfig;
  state: GameState;
  /** phase を進める予定時刻 [ms]（flight の終わり / result の終わり / 手番のタイムアウト） */
  private nextAtMs = -1;
  private turnStartedMs = -1;
  private lastEvent: GameEvent | undefined;

  constructor(opts: Partial<GameOptions> = {}) {
    this.opts = {
      ...DEFAULT_GAME_OPTIONS,
      ...opts,
      config: { ...DEFAULT_DARTS, ...(opts.config ?? {}) },
    };
    this.config = this.opts.config;
    this.state = {
      t: 0,
      seq: 0,
      phase: "lobby",
      players: [],
      round: 0,
      turn: null,
      scores: {},
      darts: [],
      winners: null,
    };
  }

  private bump(event?: GameEvent) {
    this.state.seq++;
    if (event) this.lastEvent = event;
  }

  join(id: string, name: string, now: number): Player {
    const p: Player = { id, name, joinedMs: now, lastPoseMs: now };
    this.players.set(id, p);
    this.state.players.push({ id, name });
    this.state.scores[id] = 0;
    if (this.state.phase === "lobby") {
      this.state.phase = "aim";
      this.state.round = 0;
      this.startTurn(id, now);
    } else {
      this.bump();
    }
    return p;
  }

  leave(id: string, now: number) {
    if (!this.players.delete(id)) return;
    const wasTurn = this.state.turn?.playerId === id;
    const idx = this.state.players.findIndex((p) => p.id === id);
    this.state.players = this.state.players.filter((p) => p.id !== id);
    delete this.state.scores[id];
    if (this.state.players.length === 0) {
      this.reset("lobby");
      return;
    }
    if (wasTurn) {
      // 投げている途中で抜けたら、そのダーツは見せずに次の人へ（抜けた人の次 = 同じ index の人）
      this.state.darts = [];
      this.advanceTurn(now, undefined, idx);
    } else {
      this.bump();
    }
  }

  updatePose(id: string, now: number) {
    const p = this.players.get(id);
    if (p) p.lastPoseMs = now;
  }

  /** 直近に throw を拒否した理由（ログ用） */
  lastRejectReason = "";

  /** 手番のプレイヤーからの throw。受理したら true */
  throw(id: string, pos: V3, vel: V3, now: number): boolean {
    const s = this.state;
    const reject = (why: string) => {
      this.lastRejectReason = why;
      return false;
    };
    if (s.phase !== "aim") return reject(`phase=${s.phase}`);
    if (s.turn?.playerId !== id) return reject(`not your turn (turn=${s.turn?.playerId ?? "-"})`);
    const { minThrowZ, maxThrowZ, maxThrowXY, maxThrowSpeed } = this.opts;
    if (pos[2] < minThrowZ || pos[2] > maxThrowZ) return reject(`pos.z=${pos[2].toFixed(2)} out of [${minThrowZ}, ${maxThrowZ}]`);
    if (Math.abs(pos[0]) > maxThrowXY || Math.abs(pos[1]) > maxThrowXY) return reject(`pos.xy=(${pos[0].toFixed(2)}, ${pos[1].toFixed(2)}) beyond ±${maxThrowXY}`);
    const speed = len3(vel);
    if (!(speed > 0) || speed > maxThrowSpeed) return reject(`speed=${speed.toFixed(2)} out of (0, ${maxThrowSpeed}]`);
    const landing = simulateDart(pos, vel, this.config);
    const dart: Dart = {
      by: id,
      round: s.round,
      index: s.turn.index,
      launch: { pos, vel },
      launchedAt: now,
      landing,
    };
    s.darts.push(dart);
    s.scores[id] = (s.scores[id] ?? 0) + landing.score.points;
    s.phase = "flight";
    const last = s.turn.index + 1 >= this.config.dartsPerTurn;
    this.nextAtMs = now + landing.hitT * 1000 + (last ? this.opts.turnEndMs : this.opts.settleMs);
    this.bump({ kind: "throw", by: id });
    return true;
  }

  /** 時間経過による遷移。起きた出来事を返す（空なら配信不要） */
  tick(now: number): GameEvent[] {
    const s = this.state;
    const events: GameEvent[] = [];
    if (s.phase === "flight" && now >= this.nextAtMs) {
      const turn = s.turn!;
      if (turn.index + 1 < this.config.dartsPerTurn) {
        s.phase = "aim";
        s.turn = { playerId: turn.playerId, index: turn.index + 1 };
        this.turnStartedMs = now;
        this.nextAtMs = now + this.opts.turnTimeoutMs;
        this.bump({ kind: "turn", by: turn.playerId });
      } else {
        s.darts = [];
        this.advanceTurn(now);
      }
      if (this.lastEvent) events.push(this.lastEvent);
    } else if (s.phase === "aim" && now >= this.nextAtMs && this.nextAtMs > 0) {
      // 手番のタイムアウト: 残りの投数を 0 点で消化して次へ
      const by = s.turn!.playerId;
      s.darts = [];
      this.advanceTurn(now, { kind: "timeout", by });
      if (this.lastEvent) events.push(this.lastEvent);
    } else if (s.phase === "result" && now >= this.nextAtMs) {
      this.reset("aim");
      this.state.round = 0;
      this.startTurn(this.state.players[0].id, now, { kind: "restart" });
      if (this.lastEvent) events.push(this.lastEvent);
    }
    return events;
  }

  private startTurn(playerId: string, now: number, event: GameEvent = { kind: "turn", by: playerId }) {
    this.state.phase = "aim";
    this.state.turn = { playerId, index: 0 };
    this.turnStartedMs = now;
    this.nextAtMs = now + this.opts.turnTimeoutMs;
    this.bump(event);
  }

  /**
   * 手番を次のプレイヤーへ（最後の人なら次のラウンド / 全ラウンド終われば結果）
   * @param nextIdxOverride 次の手番の index（離脱で players が詰まったとき用）
   */
  private advanceTurn(now: number, event?: GameEvent, nextIdxOverride?: number) {
    const s = this.state;
    const cur = s.turn?.playerId ?? null;
    const idx = cur ? s.players.findIndex((p) => p.id === cur) : -1;
    let nextIdx = nextIdxOverride ?? idx + 1;
    let round = s.round;
    if (nextIdx >= s.players.length) {
      nextIdx = 0;
      round++;
    }
    if (round >= this.config.rounds) {
      s.phase = "result";
      s.turn = null;
      const best = Math.max(...s.players.map((p) => s.scores[p.id] ?? 0));
      s.winners = s.players.filter((p) => (s.scores[p.id] ?? 0) === best).map((p) => p.id);
      this.nextAtMs = now + this.opts.resultMs;
      this.bump(event ?? { kind: "result" });
      return;
    }
    s.round = round;
    this.startTurn(s.players[nextIdx].id, now, event);
  }

  private reset(phase: Phase) {
    const s = this.state;
    s.phase = phase;
    s.round = 0;
    s.turn = null;
    s.darts = [];
    s.winners = null;
    for (const p of s.players) s.scores[p.id] = 0;
    this.nextAtMs = -1;
    this.bump();
  }

  /** 配信用のスナップショット。直近の出来事は 1 回だけ載せる */
  snapshot(now: number): GameState {
    const ev = this.lastEvent;
    this.lastEvent = undefined;
    const snap: GameState = {
      ...this.state,
      t: now,
      players: [...this.state.players],
      scores: { ...this.state.scores },
      darts: [...this.state.darts],
      turn: this.state.turn ? { ...this.state.turn } : null,
      winners: this.state.winners ? [...this.state.winners] : null,
    };
    if (ev) snap.event = ev;
    return snap;
  }

  /** throw を受け付けなかったことを申告者にだけ伝えるスナップショット（配信はしない） */
  rejectionSnapshot(id: string, now: number): GameState {
    return {
      ...this.state,
      t: now,
      event: { kind: "throw-rejected", by: id },
      rejectedFor: id,
    };
  }

  /** 手番が来てからの経過 [ms]（HUD 用） */
  turnElapsedMs(now: number): number {
    return this.turnStartedMs < 0 ? 0 : now - this.turnStartedMs;
  }
}
