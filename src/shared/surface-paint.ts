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
 * 1 Room に保持するストロークの上限（snapshot が肥大しないように）。到達したら古いものから
 * TRIM_TO 件まで切り詰め、サーバーは全員に snapshot を配り直す（在室者と後から入った人の
 * 見た目を揃えるため。「黙って古いのを捨てる」だと在室者にだけ古い絵が残る）。
 * 既定 15Hz で描き続けると 1 人で約 4 分半で到達する。Phase 8 ではストロークの列ではなく
 * ラスタ（塗った結果）をサーバーが持つ方が良い（PAIN_POINTS 参照）
 */
export const MAX_STROKES = 4000;
export const TRIM_TO = 3000;
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
  /** 直前の paint() で上限に達して切り詰めたか（サーバーはこれを見て snapshot を配り直す） */
  trimmed = false;
  private readonly trimTo: number;
  private readonly maxStrokes: number;

  constructor(surfaces: SurfaceDef[], maxStrokes = MAX_STROKES, trimTo = Math.min(TRIM_TO, maxStrokes)) {
    this.maxStrokes = maxStrokes;
    this.trimTo = Math.max(1, Math.min(trimTo, maxStrokes));
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
    this.trimmed = false;
    const stroke: PaintStroke = {
      seq: ++this.seq,
      surfaceId: input.surfaceId,
      uv: [round4(input.uv[0]), round4(input.uv[1])],
      radius: input.radius,
      color,
      by,
      t: now,
    };
    this.strokes.push(stroke);
    if (this.strokes.length > this.maxStrokes) {
      this.strokes = this.strokes.slice(this.strokes.length - this.trimTo);
      this.trimmed = true;
    }
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
