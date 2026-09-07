// Phase 10-2 (10-2-batting): フリーバッティング / 2 人対戦のサーバー権威ルール。
// WebSocket や three.js には依存しない純粋クラスで、server/batting.ts が 1 Room ごとに持つ。
import {
  DEFAULT_BATTING,
  PITCH_TYPES,
  resolveSwing,
  simulatePitch,
  type BattingConfig,
  type HitFlight,
  type PitchType,
  type SwingResult,
  type V3,
} from "./batting-sim.ts";

export type Mode = "free" | "duel";
export type Phase = "lobby" | "waitingPitch" | "pitching" | "hit" | "result";
export type PlayerRole = "batter" | "pitcher";

export type Player = {
  id: string;
  name: string;
  color: number;
  role: PlayerRole;
};

export type LivePitch = {
  seq: number;
  by: string | "bot";
  type: PitchType;
  speed: number;
  startedAt: number;
  duration: number;
  plate: V3;
  inZone: boolean;
};

export type LiveHit = {
  seq: number;
  by: string;
  startedAt: number;
  samples: V3[];
  duration: number;
  end: V3;
  distance: number;
  exitSpeed: number;
};

export type BattingStats = {
  pitches: number;
  swings: number;
  hits: number;
  misses: number;
};

export type LastResult = {
  by: string | null;
  kind: "hit" | "miss" | "take";
  label: string;
  timingMs: number | null;
  pitchType: PitchType;
  pitchSpeed: number;
  distance: number | null;
};

export type GameEvent =
  | { kind: "mode"; mode: Mode }
  | { kind: "ready"; batterId: string; pitcherId: string | null }
  | { kind: "pitch"; by: string | "bot"; pitchType: PitchType; speed: number }
  | { kind: "hit"; by: string; label: string; distance: number }
  | { kind: "miss"; by: string; label: string }
  | { kind: "take"; by: string; label: string }
  | { kind: "restart" };

export type GameSnapshot = {
  t: number;
  seq: number;
  mode: Mode;
  phase: Phase;
  players: Player[];
  batterId: string | null;
  pitcherId: string | null;
  pitch: LivePitch | null;
  hit: LiveHit | null;
  stats: BattingStats;
  lastResult: LastResult | null;
  nextPitchAt: number | null;
  event?: GameEvent;
};

export type BattingGameOptions = {
  botDelayMs: number;
  resultMs: number;
  hitSettleMs: number;
};

export const DEFAULT_GAME_OPTIONS: BattingGameOptions = {
  botDelayMs: 1400,
  resultMs: 900,
  hitSettleMs: 700,
};

const PLAYER_COLORS = [0xffb300, 0x00b8d4] as const;

export class BattingGame {
  readonly config: BattingConfig;
  readonly opts: BattingGameOptions;
  readonly players = new Map<string, Player>();
  private order: string[] = [];
  mode: Mode = "free";
  phase: Phase = "lobby";
  batterId: string | null = null;
  pitcherId: string | null = null;
  pitch: LivePitch | null = null;
  hit: LiveHit | null = null;
  stats: BattingStats = { pitches: 0, swings: 0, hits: 0, misses: 0 };
  lastResult: LastResult | null = null;
  nextPitchAt = -1;
  lastRejectReason = "";
  private seq = 0;
  private pitchSeq = 0;
  private hitSeq = 0;
  private advanceAt = -1;

  constructor(
    config: Partial<BattingConfig> = {},
    opts: Partial<BattingGameOptions> = {},
  ) {
    this.config = { ...DEFAULT_BATTING, ...config };
    this.opts = { ...DEFAULT_GAME_OPTIONS, ...opts };
  }

  private bump() {
    this.seq++;
  }

  private reject(reason: string): false {
    this.lastRejectReason = reason;
    return false;
  }

  join(id: string, name: string, now: number): GameEvent[] {
    if (this.players.has(id)) return [];
    if (this.order.length >= 2) {
      this.reject("players full");
      return [];
    }
    this.order.push(id);
    this.players.set(id, {
      id,
      name,
      color: PLAYER_COLORS[this.order.length - 1] ?? 0xe8eaed,
      role: this.order.length === 1 ? "batter" : "pitcher",
    });
    const oldMode = this.mode;
    this.assignRoles();
    this.prepare(now);
    this.bump();
    const events: GameEvent[] = [];
    if (oldMode !== this.mode || this.order.length === 1) {
      events.push({ kind: "mode", mode: this.mode });
    }
    if (this.batterId) {
      events.push({
        kind: "ready",
        batterId: this.batterId,
        pitcherId: this.pitcherId,
      });
    }
    return events;
  }

  leave(id: string, now: number): GameEvent[] {
    if (!this.players.delete(id)) return [];
    this.order = this.order.filter((p) => p !== id);
    if (this.order.length === 0) {
      this.phase = "lobby";
      this.batterId = null;
      this.pitcherId = null;
      this.pitch = null;
      this.hit = null;
      this.nextPitchAt = -1;
      this.advanceAt = -1;
      this.bump();
      return [];
    }
    const oldMode = this.mode;
    this.assignRoles();
    this.prepare(now);
    this.bump();
    const events: GameEvent[] = [];
    if (oldMode !== this.mode) events.push({ kind: "mode", mode: this.mode });
    events.push({
      kind: "ready",
      batterId: this.batterId!,
      pitcherId: this.pitcherId,
    });
    return events;
  }

  private assignRoles() {
    this.batterId = this.order[0] ?? null;
    this.pitcherId = this.order[1] ?? null;
    this.mode = this.pitcherId ? "duel" : "free";
    this.order.forEach((id, i) => {
      const p = this.players.get(id);
      if (p) p.role = i === 0 ? "batter" : "pitcher";
    });
  }

  private prepare(now: number) {
    if (!this.batterId) {
      this.phase = "lobby";
      return;
    }
    this.phase = "waitingPitch";
    this.pitch = null;
    this.hit = null;
    this.lastResult = null;
    this.advanceAt = -1;
    this.nextPitchAt = this.mode === "free" ? now + this.opts.botDelayMs : -1;
  }

  /** 2 人対戦の投手だけが送れる。1 人時の投球は tick の bot が同じ startPitch を使う。 */
  pitchBall(
    id: string,
    pitchType: PitchType,
    speed: number,
    now: number,
  ): GameEvent | null {
    if (this.mode !== "duel") {
      this.reject("free batting uses bot pitcher");
      return null;
    }
    if (id !== this.pitcherId) {
      this.reject(`not pitcher (pitcher=${this.pitcherId ?? "-"})`);
      return null;
    }
    if (this.phase !== "waitingPitch") {
      this.reject(`phase=${this.phase}`);
      return null;
    }
    if (!PITCH_TYPES.includes(pitchType)) {
      this.reject(`unknown pitch type=${pitchType}`);
      return null;
    }
    if (!Number.isFinite(speed) || speed < this.config.minPitchSpeed) {
      this.reject(`pitch speed=${speed} below ${this.config.minPitchSpeed}`);
      return null;
    }
    if (speed > this.config.maxPitchSpeed) {
      this.reject(`pitch speed=${speed} above ${this.config.maxPitchSpeed}`);
      return null;
    }
    return this.startPitch(id, pitchType, speed, now);
  }

  private startPitch(
    by: string | "bot",
    pitchType: PitchType,
    speed: number,
    now: number,
  ): GameEvent {
    const result = simulatePitch(pitchType, speed, this.config);
    this.pitch = {
      seq: ++this.pitchSeq,
      by,
      type: pitchType,
      speed: result.speed,
      startedAt: now,
      duration: result.duration,
      plate: [...result.plate],
      inZone: result.inZone,
    };
    this.hit = null;
    this.phase = "pitching";
    this.nextPitchAt = -1;
    this.stats.pitches++;
    this.bump();
    return { kind: "pitch", by, pitchType, speed: result.speed };
  }

  /** 打者の Joy-Con（またはスマホ長押し）の振り。判定時刻はサーバー受信時刻。 */
  swing(
    id: string,
    speed: number,
    faceDeg: number,
    now: number,
  ): GameEvent | null {
    if (id !== this.batterId) {
      this.reject(`not batter (batter=${this.batterId ?? "-"})`);
      return null;
    }
    if (this.phase !== "pitching" || !this.pitch) {
      this.reject(`phase=${this.phase}`);
      return null;
    }
    if (!Number.isFinite(speed) || speed < this.config.minSwingSpeed) {
      this.reject(`swing speed=${speed} below ${this.config.minSwingSpeed}`);
      return null;
    }
    if (speed > this.config.maxSwingSpeed) {
      this.reject(`swing speed=${speed} above ${this.config.maxSwingSpeed}`);
      return null;
    }
    if (!Number.isFinite(faceDeg) || Math.abs(faceDeg) > 90) {
      this.reject(`faceDeg=${faceDeg} out of ±90`);
      return null;
    }
    const pitchResult = simulatePitch(
      this.pitch.type,
      this.pitch.speed,
      this.config,
    );
    const elapsed = (now - this.pitch.startedAt) / 1000;
    const result = resolveSwing(
      pitchResult,
      elapsed,
      speed,
      faceDeg,
      this.config,
    );
    this.stats.swings++;
    if (result.kind === "hit" && result.hit) {
      return this.finishHit(id, result, result.hit, now);
    }
    return this.finishMiss(id, result, now);
  }

  private finishHit(
    id: string,
    result: SwingResult,
    flight: HitFlight,
    now: number,
  ): GameEvent {
    this.stats.hits++;
    this.hit = {
      seq: ++this.hitSeq,
      by: id,
      startedAt: now,
      samples: flight.samples.map((p) => [...p]),
      duration: flight.duration,
      end: [...flight.end],
      distance: flight.distance,
      exitSpeed: flight.exitSpeed,
    };
    this.lastResult = {
      by: id,
      kind: "hit",
      label: result.label,
      timingMs: result.timingMs,
      pitchType: this.pitch!.type,
      pitchSpeed: this.pitch!.speed,
      distance: flight.distance,
    };
    this.phase = "hit";
    this.advanceAt =
      now + flight.duration * 1000 + this.opts.hitSettleMs;
    this.bump();
    return {
      kind: "hit",
      by: id,
      label: result.label,
      distance: flight.distance,
    };
  }

  private finishMiss(
    id: string,
    result: SwingResult,
    now: number,
  ): GameEvent {
    this.stats.misses++;
    this.hit = null;
    this.lastResult = {
      by: id,
      kind: "miss",
      label: result.label,
      timingMs: result.timingMs,
      pitchType: this.pitch!.type,
      pitchSpeed: this.pitch!.speed,
      distance: null,
    };
    this.phase = "result";
    this.advanceAt = now + this.opts.resultMs;
    this.bump();
    return { kind: "miss", by: id, label: result.label };
  }

  private finishTake(now: number): GameEvent {
    const pitch = this.pitch!;
    const label = pitch.inZone ? "見逃し" : "ボール";
    if (pitch.inZone) this.stats.misses++;
    this.lastResult = {
      by: this.batterId,
      kind: "take",
      label,
      timingMs: null,
      pitchType: pitch.type,
      pitchSpeed: pitch.speed,
      distance: null,
    };
    this.phase = "result";
    this.advanceAt = now + this.opts.resultMs;
    this.bump();
    return { kind: "take", by: this.batterId!, label };
  }

  tick(now: number): GameEvent[] {
    if (
      this.phase === "waitingPitch" &&
      this.mode === "free" &&
      now >= this.nextPitchAt
    ) {
      const type = PITCH_TYPES[this.pitchSeq % PITCH_TYPES.length];
      const speed = 4.5 + (this.pitchSeq % 4) * 0.7;
      return [this.startPitch("bot", type, speed, now)];
    }
    if (
      this.phase === "pitching" &&
      this.pitch &&
      now >=
        this.pitch.startedAt +
          this.pitch.duration * 1000 +
          this.config.contactWindowMs
    ) {
      return [this.finishTake(now)];
    }
    if (
      (this.phase === "hit" || this.phase === "result") &&
      now >= this.advanceAt
    ) {
      this.prepare(now);
      this.bump();
      return this.batterId
        ? [
            {
              kind: "ready",
              batterId: this.batterId,
              pitcherId: this.pitcherId,
            },
          ]
        : [];
    }
    return [];
  }

  restart(now: number): GameEvent[] {
    this.stats = { pitches: 0, swings: 0, hits: 0, misses: 0 };
    this.pitchSeq = 0;
    this.hitSeq = 0;
    this.prepare(now);
    this.bump();
    const events: GameEvent[] = [{ kind: "restart" }];
    if (this.batterId) {
      events.push({
        kind: "ready",
        batterId: this.batterId,
        pitcherId: this.pitcherId,
      });
    }
    return events;
  }

  snapshot(now: number, event?: GameEvent): GameSnapshot {
    const snap: GameSnapshot = {
      t: now,
      seq: this.seq,
      mode: this.mode,
      phase: this.phase,
      players: this.order.map((id) => ({ ...this.players.get(id)! })),
      batterId: this.batterId,
      pitcherId: this.pitcherId,
      pitch: this.pitch
        ? {
            ...this.pitch,
            plate: [...this.pitch.plate],
          }
        : null,
      hit: this.hit
        ? {
            ...this.hit,
            samples: this.hit.samples.map((p) => [...p]),
            end: [...this.hit.end],
          }
        : null,
      stats: { ...this.stats },
      lastResult: this.lastResult ? { ...this.lastResult } : null,
      nextPitchAt:
        this.phase === "waitingPitch" && this.mode === "free"
          ? this.nextPitchAt
          : null,
    };
    if (event) snap.event = event;
    return snap;
  }
}
