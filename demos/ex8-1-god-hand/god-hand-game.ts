// 番外編 ex8-1: ゴッドハンド（イナズマイレブンの円堂守のキーパー技）の 1 人用ゲームロジック。
// ローカルのみ（サーバー・通信なし）。three.js に依存しない純粋クラス
// （Node の回帰テスト scripts/test-godhand.mjs から import するため。import の .ts も Node の ESM 解決のため）。
//
// 座標系（board 座標系）: 壁に貼ったマーカーのマーカー座標系そのもの（06-2 と同じ）。
//   X = マーカーの右, Y = マーカーの上（= 鉛直上）, +Z = 壁から部屋側。壁面 = Z=0。単位 m
//
// 遊び方: プレイヤー（キーパー）は壁のマーカーを見て立つ。壁の前の仮想シューターがプレイヤーの
// 背後のゴールへシュートを撃つ。パーの手を素早く突き出すと巨大な金色の手（ゴッドハンド）が
// 約 1.2 秒実体化し、その間にボールが触れればキャッチ。通り抜けられると失点（オーラが砕ける）。
import type { V3 } from "../../src/shared/darts-sim.ts";

export type { V3 };

export type GHConfig = {
  /** シュートの重力 [m/s²]（小さめで直線的なシュートに） */
  gravity: number;
  /** 予告（ボールが光る）からシュートまで [s] */
  telegraphSec: number;
  /** 最初のシュート間隔 [s] と下限 [s]、1 本ごとの短縮 [s] */
  intervalStartSec: number;
  intervalMinSec: number;
  intervalRampSec: number;
  /** 最初のシュート速さ [m/s] と上限 [m/s]、1 本ごとの加速 [m/s] */
  speedStart: number;
  speedMax: number;
  speedRamp: number;
  /** ゴッドハンドの実体化時間 [s]・再発動までのクールダウン [s]・当たり判定の半径 [m] */
  handActiveSec: number;
  handCooldownSec: number;
  handRadius: number;
  /** ボールの半径 [m] */
  ballR: number;
  /** 失点がこの数に達したらリザルト → 自動で次のゲーム */
  lives: number;
  resultSec: number;
  /** ボールの飛行がこの時間 [s] を超えたら消す（保険） */
  maxFlightSec: number;
};

export const DEFAULT_GH: GHConfig = {
  gravity: 2,
  telegraphSec: 0.9,
  intervalStartSec: 3.2,
  intervalMinSec: 1.6,
  intervalRampSec: 0.08,
  speedStart: 4,
  speedMax: 9,
  speedRamp: 0.25,
  handActiveSec: 1.2,
  handCooldownSec: 0.6,
  handRadius: 0.7,
  ballR: 0.11,
  lives: 5,
  resultSec: 4,
  maxFlightSec: 4,
};

export type BallState = "telegraph" | "flying" | "caught" | "conceded" | "gone";

export type GHBall = {
  id: number;
  state: BallState;
  /** 予告位置（シューターの位置）。telegraph 中はここで光る */
  from: V3;
  /** 発射時に決まる */
  pos: V3;
  vel: V3;
  /** 発射時刻 [ms]（telegraph 開始は launchAt - telegraphSec） */
  launchAt: number;
  /** このボールの失点判定面（board 座標系の z。プレイヤーの少し後ろ） */
  goalZ: number;
  /** 状態が変わった時刻 [ms]（caught の吸い付き・conceded のフェード用） */
  stateSinceMs: number;
};

export type GHEvent =
  | { kind: "launch"; ball: GHBall }
  | { kind: "catch"; ball: GHBall; combo: number }
  /** ゴッドハンドが出ていたのに通された（オーラが砕ける演出） */
  | { kind: "broken"; ball: GHBall }
  | { kind: "goal"; ball: GHBall }
  | { kind: "gameover"; score: number; bestCombo: number }
  | { kind: "restart" };

export class GodHandGame {
  readonly cfg: GHConfig;
  phase: "play" | "result" = "play";
  phaseEndsAt = Infinity;
  /** キャッチ数・連続キャッチ・最高連続・失点 */
  score = 0;
  combo = 0;
  bestCombo = 0;
  conceded = 0;
  /** 撃たれた本数（難易度の段階） */
  shotsFired = 0;
  readonly balls: GHBall[] = [];
  /** 実体化中のゴッドハンド（中心は毎フレーム手に追従して呼び出し側が更新する） */
  hand: { center: V3; activatedAt: number } | null = null;
  private lastHandEndMs = -Infinity;
  private nextId = 1;

  constructor(cfg: Partial<GHConfig> = {}) {
    this.cfg = { ...DEFAULT_GH, ...cfg };
  }

  /** いまの難易度でのシュート速さ [m/s] */
  shotSpeed(): number {
    return Math.min(this.cfg.speedMax, this.cfg.speedStart + this.cfg.speedRamp * this.shotsFired);
  }

  /** 次のシュートまでの間隔 [s] */
  shotInterval(): number {
    return Math.max(this.cfg.intervalMinSec, this.cfg.intervalStartSec - this.cfg.intervalRampSec * this.shotsFired);
  }

  /**
   * シュートの予告を積む（発射は telegraphSec 後）。from はシューターの位置（壁の少し手前）、
   * vel は発射速度、goalZ は失点判定面（呼び出し側がプレイヤーの頭位置から決める）
   */
  spawnShot(from: V3, vel: V3, goalZ: number, now: number): GHBall {
    const ball: GHBall = {
      id: this.nextId++,
      state: "telegraph",
      from: [...from] as V3,
      pos: [...from] as V3,
      vel: [...vel] as V3,
      launchAt: now + this.cfg.telegraphSec * 1000,
      goalZ,
      stateSinceMs: now,
    };
    this.balls.push(ball);
    this.shotsFired++;
    return ball;
  }

  /** ゴッドハンド発動。クールダウン中・実体化中・result 中は false */
  activate(center: V3, now: number): boolean {
    if (this.phase !== "play") return false;
    if (this.hand) return false;
    if (now - this.lastHandEndMs < this.cfg.handCooldownSec * 1000) return false;
    this.hand = { center: [...center] as V3, activatedAt: now };
    return true;
  }

  /** 実体化中の手の中心を手の動きに追従させる */
  moveHand(center: V3) {
    if (this.hand) this.hand.center = [...center] as V3;
  }

  handActive(now: number): boolean {
    return this.hand !== null && now - this.hand.activatedAt <= this.cfg.handActiveSec * 1000;
  }

  /** 毎フレーム呼ぶ。物理と判定を進めて出来事を返す */
  update(now: number, dtSec: number): GHEvent[] {
    const events: GHEvent[] = [];
    const cfg = this.cfg;
    // 手の実体化終了（クールダウンの起点は「実際に切れた時刻」。update が遅れて呼ばれても延びない）
    if (this.hand && now - this.hand.activatedAt > cfg.handActiveSec * 1000) {
      this.lastHandEndMs = this.hand.activatedAt + cfg.handActiveSec * 1000;
      this.hand = null;
    }
    if (this.phase === "result" && now >= this.phaseEndsAt) {
      this.phase = "play";
      this.score = 0;
      this.combo = 0;
      this.bestCombo = 0;
      this.conceded = 0;
      this.shotsFired = 0;
      this.balls.length = 0;
      events.push({ kind: "restart" });
    }
    const dt = Math.min(0.1, Math.max(0, dtSec));
    for (const ball of this.balls) {
      if (ball.state === "telegraph") {
        if (now >= ball.launchAt) {
          ball.state = "flying";
          ball.stateSinceMs = now;
          events.push({ kind: "launch", ball });
        }
        continue;
      }
      if (ball.state !== "flying") continue;
      // 放物線（低重力）。dt 積分で十分（判定面は毎フレーム跨ぎを見る）
      const prevZ = ball.pos[2];
      ball.vel[1] -= cfg.gravity * dt;
      ball.pos[0] += ball.vel[0] * dt;
      ball.pos[1] += ball.vel[1] * dt;
      ball.pos[2] += ball.vel[2] * dt;
      // キャッチ判定（実体化中の手の球）
      if (this.phase === "play" && this.handActive(now) && this.hand) {
        const h = this.hand.center;
        const d = Math.hypot(ball.pos[0] - h[0], ball.pos[1] - h[1], ball.pos[2] - h[2]);
        if (d <= cfg.handRadius + cfg.ballR) {
          ball.state = "caught";
          ball.stateSinceMs = now;
          this.score++;
          this.combo++;
          this.bestCombo = Math.max(this.bestCombo, this.combo);
          events.push({ kind: "catch", ball, combo: this.combo });
          continue;
        }
      }
      // 失点判定（プレイヤーの後ろの面を跨いだ）
      if (prevZ < ball.goalZ && ball.pos[2] >= ball.goalZ) {
        ball.state = "conceded";
        ball.stateSinceMs = now;
        if (this.phase === "play") {
          this.conceded++;
          this.combo = 0;
          events.push(this.handActive(now) ? { kind: "broken", ball } : { kind: "goal", ball });
          if (this.conceded >= cfg.lives) {
            this.phase = "result";
            this.phaseEndsAt = now + cfg.resultSec * 1000;
            events.push({ kind: "gameover", score: this.score, bestCombo: this.bestCombo });
          }
        }
        continue;
      }
      if (now - ball.launchAt > cfg.maxFlightSec * 1000) {
        ball.state = "gone";
        ball.stateSinceMs = now;
      }
    }
    // 終わったボールはしばらく見せてから捨てる
    for (let i = this.balls.length - 1; i >= 0; i--) {
      const b = this.balls[i];
      if ((b.state === "caught" || b.state === "conceded" || b.state === "gone") && now - b.stateSinceMs > 1500) {
        this.balls.splice(i, 1);
      }
    }
    return events;
  }
}
