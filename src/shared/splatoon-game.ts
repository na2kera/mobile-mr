// Phase 8 (08-splatoon): 試合のルール（純粋クラス。サーバーが権威として持つ）。個人戦。
//   - 参加順に 8 色から自分の色を割り当てる（その試合で未使用の色を優先。再利用時はその色のセルを消す）
//   - 入室したら練習（practice。時間無制限に自由に塗れる。issue #20）→ 俯瞰画面の「対戦開始」（start）で
//     カウントダウン（waiting。waitSec）→ 試合（matchSec）→ 結果（resultSec）→ 格子とインクをリセットして練習に戻る
//   - 俯瞰画面の「終了」（stop）で試合を途中で終えられる（即座に結果へ）。カウントダウン中の stop は中止して練習に戻る（issue #32）
//   - 発射（shot）は位置・速度・半径・インク残量を検証し、着弾を simulateInk で決めて格子に塗る
//   - インクは撃つのをやめると回復し、グー（fist）の間は速く回復する（issue #20「グーで補充」）
//   - 得点 = 自分の色のセル数（四方の壁 + 床）。勝者はセル最多の人（同点は複数）
// 06 / 06-2 の *-game.ts と同じく three.js に依存しない（Node テスト対象）
import {
  DEFAULT_FIELD,
  MAX_INK_COLORS,
  InkGrid,
  fieldSurfaces,
  inkPerShot,
  norm,
  simulateInk,
  type FieldConfig,
  type FieldSize,
  type InkLanding,
  type InkColor,
  type SurfaceFrame,
  type V3,
} from "./splatoon-sim.ts";
import { impactDirUv, isWallSurface, splatShape } from "./splat-shape.ts";

export type Phase = "practice" | "waiting" | "play" | "result";

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
  /** 俯瞰画面が「対戦開始」を押した（カウントダウン開始） */
  | { kind: "countdown" }
  | { kind: "start" }
  /** 結果表示が終わり練習に戻った（格子は消える） */
  | { kind: "practice" }
  /** 俯瞰画面がカウントダウンを中止した（練習に戻る。練習の塗りは残る） */
  | { kind: "cancel" }
  /** 俯瞰画面がフィールドの寸法を変えた（格子は作り直し = 塗りは消える。config は field メッセージで配る） */
  | { kind: "field" }
  /** 個人戦の結果。winners = 最多セルのプレイヤー id（同点は複数。誰も塗っていなければ空）。stopped = 俯瞰画面が途中で終えた */
  | { kind: "result"; winners: string[]; winnerNames: string[]; stopped?: boolean }
  | { kind: "shot"; by: string };

export type GameSnapshot = {
  t: number;
  seq: number;
  phase: Phase;
  /** 今のフェーズが終わる権威時刻 [ms]。practice は終わらないので null（Infinity は JSON に載らない。受信側は null = 時間表示なし） */
  phaseEndsAt: number | null;
  players: Player[];
  /** プレイヤーごとの塗ったセル数（四方の壁 + 床） */
  scores: Record<string, number>;
  totalCells: number;
  /** result 中の勝者（同点は複数、play 中は null） */
  winners: string[] | null;
  /** 勝者の表示名（結果確定時に固定。勝者が退出しても名前で表示できる） */
  winnerNames: string[] | null;
  /** 直近の発射（飛行の描画用。着弾済みのものも maxFlightSec の間は残す） */
  shots: Shot[];
  /** プレイヤーごとのインク残量 0..1（サーバー権威。クライアントはこれに予測を重ねる） */
  ink: Record<string, number>;
  /** Surface ごとの格子（welcome / 結果後のリセット時だけ載せる） */
  grids?: Record<string, string>;
  event?: GameEvent;
};

/** 1 人あたりの発射の上限 [回/秒]（クライアントの連射 fireRatePerSec=6 に余裕を持たせる。総量はインクが縛る） */
export const SHOT_RATE_PER_SEC = 9;
/** 発射位置の距離上限の最低値 [m]（実際はコートの対角 + 1m まで許す。コートを広げても奥から撃てる） */
export const MAX_SHOT_DIST_M = 6;
/** 発射位置は直近の頭の位置からこの距離 [m] 以内（腕の長さ + 手トラッキングの誤差） */
export const MAX_SHOT_FROM_HEAD_M = 1.2;
/**
 * グー（fist）の申告が有効な時間 [ms]。pose（15Hz）が止まったら（タブ停止・通信停滞・一度だけ true を送る
 * クライアント）この時間で通常の回復速度に戻す（外部レビュー指摘: 申告が無期限に効くと高速回復が続く）
 */
export const FIST_STALE_MS = 1000;

export class SplatoonGame {
  /** setFieldSize で差し替わる（参照を取っておかず、都度 game.config を読むこと） */
  config: FieldConfig;
  surfaces: SurfaceFrame[];
  readonly grids = new Map<string, InkGrid>();
  readonly players = new Map<string, Player>();
  phase: Phase = "practice";
  phaseEndsAt = Infinity;
  winners: string[] | null = null;
  winnerNames: string[] | null = null;
  private seq = 0;
  private shots: Shot[] = [];
  private readonly shotTimes = new Map<string, number[]>();
  /** 直近の頭の位置（発射位置の検証用） */
  private readonly headPos = new Map<string, V3>();
  /** インク残量（0..1）・最後に撃った時刻（回復の遅延用）・グーにしているか（回復の速さ）とその申告時刻 */
  private readonly inkState = new Map<string, { ink: number; updatedMs: number; lastShotMs: number; fist: boolean; fistUpdatedMs: number }>();
  /** この試合で一度でも使った色（退出者の塗りを新しい参加者が引き継がないように、未使用の色を優先する） */
  private readonly usedColors = new Set<InkColor>();
  /** 直近の join で色を再利用してその色のセルを消したか（サーバーはこれを見て格子を配り直す） */
  lastJoinClearedColor = false;
  /** 発射位置の距離上限（コートの対角 + 1m） */
  private maxShotDist = MAX_SHOT_DIST_M;
  /** カウントダウンに入る前のフェーズ（practice か result）。中止したとき、result 由来なら前試合の盤面を消して練習に戻す */
  private countdownFrom: Phase = "practice";
  lastRejectReason = "";

  constructor(config: Partial<FieldConfig> = {}) {
    this.config = { ...DEFAULT_FIELD, ...config };
    this.surfaces = [];
    this.buildField();
  }

  /** config から壁と床（5 枚）と格子を作る。既存の格子は捨てる */
  private buildField() {
    this.surfaces = fieldSurfaces(this.config);
    this.grids.clear();
    for (const s of this.surfaces) this.grids.set(s.id, new InkGrid(s, this.config.cellM));
    const c = this.config;
    this.maxShotDist = Math.max(MAX_SHOT_DIST_M, Math.hypot(c.wallW / 2, c.floorDrop + c.wallH, c.floorDepth) + 1);
  }

  /**
   * 俯瞰画面からのフィールドの寸法の変更。練習中か結果表示中だけ受け付ける（カウントダウン中・試合中は拒否）。
   * 格子はセル数が変わるので作り直す（塗りは消える。インクと発射も新品 = resetField）。
   * 寸法の範囲とセル数の上限は呼ぶ側（サーバー）が validateFieldSize で検証する
   */
  setFieldSize(size: FieldSize, now: number): GameEvent[] {
    if (this.phase !== "practice" && this.phase !== "result") {
      this.lastRejectReason = `cannot resize during ${this.phase}`;
      return [];
    }
    this.config = { ...this.config, wallW: size.wallW, wallH: size.wallH, floorDepth: size.floorDepth, floorDrop: size.floorDrop };
    this.buildField();
    // 結果表示中なら練習に戻す（結果の格子は消えたので、勝者の表示だけ残っても意味がない）
    this.phase = "practice";
    this.phaseEndsAt = Infinity;
    this.resetField(now);
    return [{ kind: "field" }];
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

  /** 色 c のセルを全部消す。消した数を返す */
  private clearColor(c: InkColor): number {
    let n = 0;
    for (const g of this.grids.values()) {
      for (let i = 0; i < g.cells.length; i++) {
        if (g.cells[i] === c) {
          g.cells[i] = 0;
          n++;
        }
      }
    }
    return n;
  }

  /**
   * 色の割当。試合中はその試合でまだ使っていない色を優先し、全色使用済みなら「今いない人」の色を再利用する。
   * 再利用時はその色のセルを消す（退出者の塗りを新しい参加者が得点として引き継がないように）。
   * 練習中（終わらないので usedColors が積み上がる。iPhone の瞬断で再接続するたび新しい id になる）は
   * 「今いない人」の色をすぐ再利用してよい（引き継ぎ防止は試合中だけの要件）
   */
  private pickColor(): InkColor {
    const active = new Set([...this.players.values()].map((p) => p.color));
    this.lastJoinClearedColor = false;
    const reserved = this.phase === "practice" ? active : new Set([...this.usedColors, ...active]);
    for (let c = 1; c <= MAX_INK_COLORS; c++) {
      if (!reserved.has(c)) {
        if (this.usedColors.has(c)) this.lastJoinClearedColor = this.clearColor(c) > 0;
        return c;
      }
    }
    let c: InkColor = 1;
    while (active.has(c) && c < MAX_INK_COLORS) c++;
    this.lastJoinClearedColor = this.clearColor(c) > 0;
    return c;
  }

  join(id: string, name: string, now: number): GameEvent[] {
    const color = this.pickColor();
    this.usedColors.add(color);
    this.players.set(id, { id, name, color });
    this.inkState.set(id, { ink: 1, updatedMs: now, lastShotMs: -Infinity, fist: false, fistUpdatedMs: -Infinity });
    // 入室しても試合は始めない（練習のまま）。開始は俯瞰画面の start()
    return [];
  }

  leave(id: string) {
    this.players.delete(id);
    this.shotTimes.delete(id);
    this.headPos.delete(id);
    this.inkState.delete(id);
  }

  /** 頭の位置と手の形（グーなら回復が速い）を更新する。fist は「見えている手のどれかがグー」 */
  updatePose(id: string, pos: V3, now: number, fist = false) {
    if (!this.players.has(id)) return;
    // ここまでは前の形で回復させてから、形を切り替える
    this.refreshInk(id, now);
    this.headPos.set(id, pos);
    const st = this.inkState.get(id);
    if (st) {
      st.fist = fist;
      st.fistUpdatedMs = now;
    }
  }

  /**
   * 経過時間ぶんの回復を反映する（撃つ前・snapshot 前に呼ぶ）。撃った直後 inkRegenDelaySec は回復しない。
   * 回復の速さはグーの間 1/inkFistFullSec、それ以外 1/inkFullSec（クライアントの予測も同じ式: inkRegenPerSec）。
   * グーの申告は FIST_STALE_MS で失効するので、区間がその境界をまたぐときは前後で速さを分けて積分する
   */
  private refreshInk(id: string, now: number) {
    const st = this.inkState.get(id);
    if (!st) return;
    const regenFrom = Math.max(st.updatedMs, st.lastShotMs + this.config.inkRegenDelaySec * 1000);
    st.updatedMs = now;
    if (now <= regenFrom) return;
    const fistUntil = st.fist ? st.fistUpdatedMs + FIST_STALE_MS : -Infinity;
    const fastEnd = Math.min(now, Math.max(regenFrom, fistUntil));
    const fastSec = Math.max(0, (fastEnd - regenFrom) / 1000);
    const slowSec = Math.max(0, (now - Math.max(regenFrom, fastEnd)) / 1000);
    st.ink = Math.min(1, st.ink + fastSec * inkRegenPerSec(this.config, true) + slowSec * inkRegenPerSec(this.config, false));
  }

  /** いまのインク残量（0..1）。存在しない id は 0 */
  inkOf(id: string, now: number): number {
    this.refreshInk(id, now);
    return this.inkState.get(id)?.ink ?? 0;
  }

  /** 格子・インク・発射を新品にする（試合の開始と、練習に戻るとき） */
  private resetField(now: number) {
    this.winners = null;
    this.winnerNames = null;
    // 「今いる人の色」だけが使用中（退出者の色は再び新品として使える）
    this.usedColors.clear();
    for (const p of this.players.values()) this.usedColors.add(p.color);
    for (const g of this.grids.values()) g.clear();
    for (const st of this.inkState.values()) {
      st.ink = 1;
      st.updatedMs = now;
      st.lastShotMs = -Infinity;
    }
    this.shots = [];
    this.seq++;
  }

  /**
   * 俯瞰画面の「対戦開始」。練習中か結果表示中に受け付け、waitSec のカウントダウン（waiting）に入る。
   * それ以外（カウントダウン中・試合中）は無視して空を返す
   */
  start(now: number): GameEvent[] {
    if (this.phase !== "practice" && this.phase !== "result") {
      this.lastRejectReason = `cannot start during ${this.phase}`;
      return [];
    }
    if (this.players.size === 0) {
      this.lastRejectReason = "no players";
      return [];
    }
    this.countdownFrom = this.phase;
    this.phase = "waiting";
    this.phaseEndsAt = now + this.config.waitSec * 1000;
    // 結果表示中からの開始: 前の勝者の表示（🏆）はここで消す（格子は試合開始まで残す）
    this.winners = null;
    this.winnerNames = null;
    this.seq++;
    return [{ kind: "countdown" }];
  }

  private startMatch(now: number): GameEvent[] {
    this.phase = "play";
    this.phaseEndsAt = now + this.config.matchSec * 1000;
    this.resetField(now);
    return [{ kind: "start" }];
  }

  private enterPractice(now: number): GameEvent[] {
    this.phase = "practice";
    this.phaseEndsAt = Infinity;
    this.resetField(now);
    return [{ kind: "practice" }];
  }

  tick(now: number): GameEvent[] {
    // 古い発射は捨てる（描画に要らない）
    const keepAfter = now - this.config.maxFlightSec * 1000 - 500;
    if (this.shots.length > 0 && this.shots[0].launchedAt < keepAfter) {
      this.shots = this.shots.filter((s) => s.launchedAt >= keepAfter);
    }
    if (now < this.phaseEndsAt) return [];
    if (this.phase === "waiting") return this.startMatch(now);
    if (this.phase === "play") return this.finishMatch(now, false);
    if (this.phase === "result") return this.enterPractice(now);
    return [];
  }

  /** 試合を終えて結果（result）にする。時間切れ（tick）と俯瞰画面の stop の両方から */
  private finishMatch(now: number, stopped: boolean): GameEvent[] {
    const scores = this.scores();
    const max = Math.max(0, ...Object.values(scores));
    this.winners = max > 0 ? Object.keys(scores).filter((id) => scores[id] === max) : [];
    // 名前は結果確定時に固定する（勝者が result 中に退出しても名前で表示できる）
    this.winnerNames = this.winners.map((id) => this.players.get(id)?.name ?? id);
    this.phase = "result";
    this.phaseEndsAt = now + this.config.resultSec * 1000;
    this.seq++;
    const ev: GameEvent = { kind: "result", winners: this.winners, winnerNames: this.winnerNames };
    if (stopped) ev.stopped = true;
    return [ev];
  }

  /**
   * 俯瞰画面の「終了」（issue #32「途中で終われるように」）。
   * 試合中なら即座に結果へ（時間切れと同じ集計。塗りはそのまま結果表示に使う）、
   * カウントダウン中なら中止して練習に戻る。練習から始めたカウントダウンなら練習の塗りはそのまま、
   * 結果表示から始めたものなら前試合の盤面が練習に漏れないよう格子とインクを新品にする（外部レビュー指摘）。
   * それ以外（練習中・結果表示中）は終えるものが無いので空を返す
   */
  stop(now: number): GameEvent[] {
    if (this.phase === "play") return this.finishMatch(now, true);
    if (this.phase === "waiting") {
      this.phase = "practice";
      this.phaseEndsAt = Infinity;
      if (this.countdownFrom === "result") this.resetField(now); // seq も進む
      else this.seq++;
      return [{ kind: "cancel" }];
    }
    this.lastRejectReason = `nothing to stop during ${this.phase}`;
    return [];
  }

  /**
   * 発射。速度・半径は固定値（連射）なので、上限を超えていたら拒否。
   * インクタンクを検証して減らし、着弾は simulateInk で決めて格子に塗る。受理したら Shot を返す
   */
  shoot(id: string, pos: V3, vel: V3, radius: number, now: number): Shot | null {
    const p = this.players.get(id);
    if (!p) {
      this.lastRejectReason = "unknown player";
      return null;
    }
    // 練習中と試合中だけ撃てる（カウントダウン中・結果表示中は撃てない）
    if (this.phase !== "play" && this.phase !== "practice") {
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
    if (!(norm(pos) <= this.maxShotDist) || !(pos[2] > 0)) {
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
    st.ink = Math.max(0, st.ink - cost);
    st.lastShotMs = now;
    const landing = simulateInk(pos, vel, this.surfaces, cfg);
    const seq = ++this.seq;
    if (landing?.hit) {
      // 見た目（InkView）と同じ飛沫の形で塗る（形は seq を種に全端末で同じ）
      const surface = this.surfaces.find((s) => s.id === landing.surfaceId);
      if (surface) {
        const shape = splatShape(seq, radius, impactDirUv(landing, vel, surface, cfg.gravity), isWallSurface(surface));
        this.grids.get(landing.surfaceId)?.stampSplat(landing.uv, shape, p.color);
      }
    }
    const shot: Shot = { seq, by: id, color: p.color, pos, vel, radius, launchedAt: now, landing };
    this.shots.push(shot);
    return shot;
  }

  snapshot(now: number, withGrids = false, event?: GameEvent): GameSnapshot {
    const snap: GameSnapshot = {
      t: now,
      seq: this.seq,
      phase: this.phase,
      phaseEndsAt: Number.isFinite(this.phaseEndsAt) ? this.phaseEndsAt : null,
      players: [...this.players.values()],
      scores: this.scores(),
      totalCells: this.totalCells,
      winners: this.winners,
      winnerNames: this.winnerNames,
      shots: this.shots.slice(),
      ink: {},
    };
    for (const id of this.players.keys()) {
      // 切り捨て（四捨五入だと実残量より多く見え、クライアントが空撃ちする）。0..1 にクランプ
      snap.ink[id] = Math.min(1, Math.max(0, Math.floor(this.inkOf(id, now) * 100) / 100));
    }
    if (withGrids) {
      snap.grids = {};
      for (const [id, g] of this.grids) snap.grids[id] = g.encode();
    }
    if (event) snap.event = event;
    return snap;
  }
}

/** 回復の速さ [1/s]（サーバーとクライアントの予測で共通）。グーの間は inkFistFullSec、それ以外は inkFullSec で満タン */
export function inkRegenPerSec(cfg: FieldConfig, fist: boolean): number {
  return 1 / (fist ? cfg.inkFistFullSec : cfg.inkFullSec);
}
