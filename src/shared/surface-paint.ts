// Phase 7 (07-surface-mapping): Surface 上のペイント（ストローク）の権威状態。
// サーバー（server/surface.ts）が持ち、クライアントは snapshot + 差分（paint / clear）で追う。
// 06 / 06-2 の *-game.ts と同じく three.js に依存しない純粋クラス（Node テスト対象）
import { round4, uvInside, type SurfaceDef, type V2 } from "./surface.ts";

export type PaintStroke = {
  /** 全 Surface を通した通し番号（順序と重複排除に使う） */
  seq: number;
  surfaceId: string;
  uv: V2;
  /** 半径 [m] */
  radius: number;
  /** 色（プレイヤーに割り当てた palette の index） */
  color: number;
  by: string;
  /** サーバー時刻 [ms] */
  t: number;
};

export type PaintInput = { surfaceId: string; uv: V2; radius: number };

export const PAINT_RADIUS_MIN = 0.005;
export const PAINT_RADIUS_MAX = 0.5;
/**
 * 1 Room に保持するストロークの上限（snapshot が肥大しないように）。超えたら全消去する。
 * 「古いものから捨てる」だと在室者には消えた通知が無く、後から入った人と見た目がずれるため、
 * 全員に同じ clear を配れる全消去にした（サーバーは paint の前に clear を broadcast する）
 */
export const MAX_STROKES = 4000;
/**
 * 1 人あたりの受け付け上限 [回/秒]。クライアントの上限（?paintHz= の max 30）に対して余裕を持たせる
 * （sliding window なので上限ちょうどだと rAF のジッタで境界落ちする）
 */
export const PAINT_RATE_PER_SEC = 45;

/** 人ごとの単純なレート制限（1 秒あたりの上限）。paint / clear / pose で別々に持つ */
export class RateLimiter {
  private readonly recent = new Map<string, number[]>();
  private readonly perSec: number;
  constructor(perSec: number) {
    this.perSec = perSec;
  }
  /** 受け付けられれば true（記録する） */
  allow(id: string, now: number): boolean {
    const times = this.recent.get(id) ?? [];
    while (times.length > 0 && now - times[0] > 1000) times.shift();
    if (times.length >= this.perSec) return false;
    times.push(now);
    this.recent.set(id, times);
    return true;
  }
  forget(id: string) {
    this.recent.delete(id);
  }
}

export type PaintSnapshot = {
  surfaces: SurfaceDef[];
  strokes: PaintStroke[];
  seq: number;
};

export class PaintBoard {
  readonly surfaces = new Map<string, SurfaceDef>();
  strokes: PaintStroke[] = [];
  private seq = 0;
  private readonly rate = new RateLimiter(PAINT_RATE_PER_SEC);
  lastRejectReason = "";
  /** 直前の paint() で上限に達して全消去したか（サーバーはこれを見て clear を配る） */
  clearedByLimit = false;
  private readonly maxStrokes: number;

  constructor(surfaces: SurfaceDef[], maxStrokes = MAX_STROKES) {
    this.maxStrokes = maxStrokes;
    for (const s of surfaces) this.surfaces.set(s.id, s);
  }

  /** 検証して追加。不正なら null（理由は lastRejectReason） */
  paint(by: string, color: number, input: PaintInput, now: number): PaintStroke | null {
    if (!this.surfaces.has(input.surfaceId)) {
      this.lastRejectReason = `unknown surface ${input.surfaceId}`;
      return null;
    }
    if (!uvInside(input.uv)) {
      this.lastRejectReason = "uv out of range";
      return null;
    }
    if (!(input.radius >= PAINT_RADIUS_MIN && input.radius <= PAINT_RADIUS_MAX)) {
      this.lastRejectReason = "radius out of range";
      return null;
    }
    if (!this.rate.allow(by, now)) {
      this.lastRejectReason = "rate limited";
      return null;
    }
    this.clearedByLimit = false;
    const stroke: PaintStroke = {
      seq: ++this.seq,
      surfaceId: input.surfaceId,
      uv: [round4(input.uv[0]), round4(input.uv[1])],
      radius: input.radius,
      color,
      by,
      t: now,
    };
    if (this.strokes.length >= this.maxStrokes) {
      this.strokes = [];
      this.clearedByLimit = true;
    }
    this.strokes.push(stroke);
    return stroke;
  }

  clear() {
    this.strokes = [];
  }

  forget(by: string) {
    this.rate.forget(by);
  }

  snapshot(): PaintSnapshot {
    return { surfaces: [...this.surfaces.values()], strokes: this.strokes.slice(), seq: this.seq };
  }
}
