// Phase 6: バレーボールのルール（サイド割当・サーブ・ラリー・得点・bot）。
// サーバー（server/volleyball.ts）だけが実行する権威ロジックだが、WebSocket や Node に触れない
// 純粋なクラスにしてある（Node の回帰テスト scripts/test-volleyball.mjs から直接叩くため）。
// 時刻は呼び出し側から渡す（now [ms]）。乱数も注入できる
import {
  DEFAULT_COURT,
  aimPoint,
  botAimPoint,
  botShouldHit,
  dist3,
  launchVelocity,
  len3,
  otherSide,
  returnVelocity,
  sideOfZ,
  stepBall,
} from "./volleyball-sim.ts";
import type {
  BallState,
  CourtConfig,
  GameEvent,
  GameState,
  Side,
  V3,
} from "./volleyball-sim.ts";

export type GameOptions = {
  court: CourtConfig;
  /** ネット高さを頭の高さから決める（VolleyballRoomConfig.netTop === "auto"） */
  autoNetTop: boolean;
  /** waiting → 最初のサーブ、point → 次のサーブ までの間 [ms] */
  serveDelayMs: number;
  pointDelayMs: number;
  /** 打ち返しの基準滞空時間 [s]（手の速さで短くなる） */
  baseFlightSec: number;
  /** サーブ（自動トス）の滞空時間 [s]。ゆっくり目 */
  serveFlightSec: number;
  /** hit の受理: クライアント申告のボール位置とサーバーのボール位置の許容差 [m] */
  hitToleranceM: number;
  /** 同じプレイヤーの連続 hit を捨てる間隔 [ms]（指が触れ続けても 1 回にする） */
  hitCooldownMs: number;
  /** プレイヤーの姿勢がこの時間更新されなければ「いない」扱い（サイドを空ける） */
  poseStaleMs: number;
  /**
   * bot が打ち返す確率（0〜1）。1 だと bot は絶対に落とさず人が得点できないので、
   * 球ごとに一定確率で見送る（人の球がアウト・ネットなら人の失点のまま）
   */
  botReturnRate: number;
  random: () => number;
};

export const DEFAULT_GAME_OPTIONS: Omit<GameOptions, "random"> = {
  court: DEFAULT_COURT,
  autoNetTop: true,
  serveDelayMs: 1500,
  pointDelayMs: 2000,
  baseFlightSec: 1.1,
  serveFlightSec: 1.4,
  hitToleranceM: 0.4,
  hitCooldownMs: 250,
  poseStaleMs: 3000,
  botReturnRate: 0.75,
};

export type Player = {
  id: string;
  side: Side | null;
  /** 直近の頭の位置（court 座標系）。未受信なら null */
  head: V3 | null;
  tracking: boolean;
  lastPoseMs: number;
  lastHitMs: number;
};

export class VolleyballGame {
  readonly players = new Map<string, Player>();
  readonly opts: GameOptions;
  court: CourtConfig;
  state: GameState;
  /** 次のサーブ時刻 [ms]（waiting / point のとき） */
  private serveAtMs = -1;
  private lastEvents: GameEvent[] = [];
  /** いま bot へ向かっている球を bot が見送るか（球が bot へ向かうたびに抽選する） */
  private botMissesThisBall = false;

  constructor(opts: Partial<GameOptions> & { random?: () => number } = {}) {
    this.opts = {
      ...DEFAULT_GAME_OPTIONS,
      random: Math.random,
      ...opts,
      court: { ...DEFAULT_COURT, ...(opts.court ?? {}) },
    };
    this.court = this.opts.court;
    this.state = {
      t: 0,
      seq: 0,
      phase: "waiting",
      ball: restingBall(this.court),
      score: { A: 0, B: 0 },
      serveTo: "A",
      sides: { A: null, B: null },
      bot: null,
      lastPoint: null,
    };
  }

  join(id: string, now: number): Player {
    const p: Player = {
      id,
      side: null,
      head: null,
      tracking: false,
      lastPoseMs: now,
      lastHitMs: -Infinity,
    };
    this.players.set(id, p);
    return p;
  }

  leave(id: string) {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
    if (p.side) this.state.sides[p.side] = null;
    this.refreshSides();
  }

  /**
   * 姿勢の受信。最初に追跡できた姿勢で立っている側（Z の符号）にサイドを割り当てる。
   * その側が埋まっていれば反対側（両方埋まっていれば観戦 = null のまま）
   */
  updatePose(id: string, head: V3, tracking: boolean, now: number) {
    const p = this.players.get(id);
    if (!p) return;
    p.head = head;
    p.tracking = tracking;
    p.lastPoseMs = now;
    if (p.side === null && tracking) {
      const want = sideOfZ(head[2]);
      const side =
        this.state.sides[want] === null
          ? want
          : this.state.sides[otherSide(want)] === null
            ? otherSide(want)
            : null;
      if (side) {
        p.side = side;
        this.state.sides[side] = id;
        this.refreshSides();
      }
    }
  }

  /**
   * プレイヤーからの「触れた」申告。ボールが本当にその近くにあり、ラリー中で、
   * 同じプレイヤーの直前の hit から間隔が空いていれば受理して打ち返す。
   * @returns 受理したか
   */
  hit(id: string, claimedPos: V3, handVel: V3, now: number): boolean {
    const p = this.players.get(id);
    if (!p || !p.side) return false;
    if (this.state.phase !== "rally") return false;
    if (now - p.lastHitMs < this.opts.hitCooldownMs) return false;
    if (dist3(this.state.ball.pos, claimedPos) > this.opts.hitToleranceM)
      return false;
    p.lastHitMs = now;
    const target = this.targetFor(otherSide(p.side));
    const vel = returnVelocity(
      this.state.ball.pos,
      target,
      len3(handVel),
      this.opts.baseFlightSec,
      this.court,
    );
    this.state.ball = { pos: this.state.ball.pos, vel, lastHit: p.side };
    this.botMissesThisBall = this.opts.random() >= this.opts.botReturnRate;
    this.emit({ kind: "hit", side: p.side, by: id, t: now });
    return true;
  }

  /** dt 秒進める。起きた出来事を返す（呼び出し側は空でなければ即 broadcast する） */
  tick(dtSec: number, now: number): GameEvent[] {
    this.lastEvents = [];
    this.state.t = now;
    this.expireStalePlayers(now);
    switch (this.state.phase) {
      case "waiting":
        if (this.hasActivePlayer()) {
          if (this.serveAtMs < 0) this.serveAtMs = now + this.opts.serveDelayMs;
          if (now >= this.serveAtMs) this.serve(now);
        } else {
          this.serveAtMs = -1;
        }
        break;
      case "point":
        if (!this.hasActivePlayer()) {
          this.toWaiting();
        } else if (now >= this.serveAtMs) {
          this.serve(now);
        }
        break;
      case "rally": {
        if (!this.hasActivePlayer()) {
          this.toWaiting();
          break;
        }
        const r = stepBall(this.state.ball, dtSec, this.court);
        this.state.ball = r.ball;
        if (r.event === "net") {
          this.emit({ kind: "net", t: now });
        } else if (r.event === "ground") {
          // 落ちた側の失点
          const loser = sideOfZ(r.ball.pos[2]);
          this.endPoint(otherSide(loser), "ground", now);
        } else if (r.event === "out") {
          // アウトは打った側の責任。サーブ直後（lastHit なし）なら飛んでいった側の失点
          const loser = r.ball.lastHit ?? sideOfZ(r.ball.pos[2]);
          this.endPoint(otherSide(loser), "out", now);
        } else if (
          this.state.bot &&
          !this.botMissesThisBall &&
          botShouldHit(this.state.ball, this.state.bot, this.court)
        ) {
          const bot = this.state.bot;
          const target = this.targetFor(otherSide(bot));
          const vel = launchVelocity(
            this.state.ball.pos,
            target,
            this.opts.baseFlightSec,
            this.court.gravity,
          );
          this.state.ball = { pos: this.state.ball.pos, vel, lastHit: bot };
          this.emit({ kind: "bot-hit", side: bot, t: now });
        }
        break;
      }
    }
    return this.lastEvents;
  }

  snapshot(): GameState {
    // 配列を共有しないようコピー（受け手が JSON にするだけなら浅いコピーで十分）
    return {
      ...this.state,
      ball: {
        pos: [...this.state.ball.pos] as V3,
        vel: [...this.state.ball.vel] as V3,
        lastHit: this.state.ball.lastHit,
      },
      score: { ...this.state.score },
      sides: { ...this.state.sides },
      lastPoint: this.state.lastPoint ? { ...this.state.lastPoint } : null,
      event: this.lastEvents[this.lastEvents.length - 1],
    };
  }

  // ---- 内部 ----

  private emit(e: GameEvent) {
    this.state.seq++;
    this.lastEvents.push(e);
  }

  private playerOn(side: Side): Player | null {
    const id = this.state.sides[side];
    return id ? (this.players.get(id) ?? null) : null;
  }

  /** どちらかの側に（姿勢が新しい）プレイヤーがいるか */
  private hasActivePlayer(): boolean {
    return this.state.sides.A !== null || this.state.sides.B !== null;
  }

  /** 姿勢が途絶えたプレイヤーのサイドを空ける（接続は残っていても、追跡していなければ試合に参加できない） */
  private expireStalePlayers(now: number) {
    let changed = false;
    for (const p of this.players.values()) {
      if (p.side && now - p.lastPoseMs > this.opts.poseStaleMs) {
        this.state.sides[p.side] = null;
        p.side = null;
        changed = true;
      }
    }
    if (changed) this.refreshSides();
  }

  /** サイドの埋まり具合から bot の側を決める。片側だけ人がいれば反対側が bot */
  private refreshSides() {
    const { A, B } = this.state.sides;
    this.state.bot = A && !B ? "B" : B && !A ? "A" : null;
    if (!this.hasActivePlayer() && this.state.phase !== "waiting") {
      this.toWaiting();
    }
  }

  private toWaiting() {
    this.state.phase = "waiting";
    this.state.ball = restingBall(this.court);
    this.state.lastPoint = null;
    this.serveAtMs = -1;
    this.state.seq++;
  }

  /** 打ち返し・サーブの狙い: その側のプレイヤーの頭の前。いなければ bot の位置 */
  private targetFor(side: Side): V3 {
    const p = this.playerOn(side);
    if (p?.head) return aimPoint(p.head, side, this.court);
    return botAimPoint(side, this.court, this.opts.random);
  }

  private serve(now: number) {
    // 受ける側に人がいなければ（bot 側なら）人のいる側へ
    let to = this.state.serveTo;
    if (!this.playerOn(to)) to = otherSide(to);
    if (!this.playerOn(to)) return;
    this.updateNetTop();
    const from: V3 = [0, this.court.netTop + 0.5, 0];
    const target = this.targetFor(to);
    const vel = launchVelocity(
      from,
      target,
      this.opts.serveFlightSec,
      this.court.gravity,
    );
    this.state.ball = { pos: from, vel, lastHit: null };
    this.botMissesThisBall = false;
    this.state.phase = "rally";
    this.state.lastPoint = null;
    this.serveAtMs = -1;
    this.emit({ kind: "serve", side: to, t: now });
  }

  private endPoint(winner: Side, reason: "ground" | "out", now: number) {
    this.state.score[winner]++;
    this.state.phase = "point";
    this.state.lastPoint = { winner, reason };
    // 失点した側がレシーブする（次の球を打ち返す機会を与える）
    this.state.serveTo = otherSide(winner);
    this.serveAtMs = now + this.opts.pointDelayMs;
    this.emit({ kind: reason, side: otherSide(winner), t: now });
  }

  /**
   * ネットの高さを頭の高さから決める（サーブのたびに評価）。
   * 頭の高さの平均から 0.35m 下。机上のマーカー + 立位（頭 ≈ 0.9m）で 0.55m、
   * 床のマーカー + 立位（頭 ≈ 1.6m）で 1.25m。10cm 以上変わるときだけ更新する
   */
  private updateNetTop() {
    if (!this.opts.autoNetTop) return;
    const heads = [...this.players.values()]
      .filter((p) => p.side && p.head)
      .map((p) => p.head![1]);
    if (heads.length === 0) return;
    const avg = heads.reduce((a, b) => a + b, 0) / heads.length;
    const netTop = Math.min(2.5, Math.max(0.3, avg - 0.35));
    if (Math.abs(netTop - this.court.netTop) >= 0.1) {
      this.court = { ...this.court, netTop };
    }
  }
}

/** サーブ待ちの静止位置（ネット上端の真上） */
function restingBall(court: CourtConfig): BallState {
  return { pos: [0, court.netTop + 0.5, 0], vel: [0, 0, 0], lastHit: null };
}
