// 08-6 画面マーカー（docs/space-stability-options.md §4 の 1d）: PC のモニタ / プロジェクタに表示するマーカー板の
// 「画面上の配置（px）」と「room に配る配置（原点からの m）」の純粋な変換。
//   - 画面の実寸はブラウザから取れない（CSS の mm は 96dpi 固定）ので、対角の実寸（インチ / mm）か 1mm あたりの px を利用者が入れる
//   - 原点（room の markerId）は画面の中央。追加マーカーはその周り（左右 → 上下 → 四隅の順）に同じ大きさで並べる
//   - 追加マーカーの位置は「画面上の px 差 ÷ pxPerMm」で決まる（巻き尺で測らない）。面は全部「正面の壁」（画面 = 正面の壁）
//   - 大きさ（markerMm）は画面に収まる範囲に丸める（モードと枚数で最大値が変わる: 遠いときは 1 枚大きく、近いときは複数枚小さく）
// three.js に依存させない（Node の回帰テスト scripts/test-08-6-screen-markers.mjs から import する。.ts 付き import は Node の ESM 解決のため）
import { MAX_EXTRA_MARKERS, MAX_MARKER_ID, MARKER_POS_LIMIT_M, validateMarkerLayout } from "../../src/shared/marker-layout.ts";
import type { MarkerPlacement } from "../../src/shared/marker-layout.ts";

/** 余白（クワイエットゾーン）込みの一辺は黒い正方形の 10/8 倍（marker-detector.ts の markerSvg は 余白 1 + 黒枠 8 + 余白 1 = 10 セル） */
export const MARKER_SVG_SCALE = 10 / 8;
/** 画面に出すマーカー（黒い正方形）の一辺の既定 [mm]。08 の DEFAULT_MARKER_MM と同じ値（room の markerMm と一致が必要） */
export const DEFAULT_SCREEN_MARKER_MM = 150;
export const MIN_SCREEN_MARKER_MM = 20;
/** 隣り合うマーカーの余白同士の間隔（黒い正方形の一辺に対する比） */
export const DEFAULT_GAP_RATIO = 0.2;
export const MM_PER_INCH = 25.4;

/** "single" = 中央に 1 枚（遠いとき。大きく）/ "multi" = 中央 + 周囲に追加マーカー（近いとき。小さく複数） */
export type ScreenMode = "single" | "multi";
export const SCREEN_MODES: readonly ScreenMode[] = ["single", "multi"];

/** 画面上の 1 枚（中心 [px]・黒い正方形の一辺 [px]） */
export type ScreenTile = { id: number; cx: number; cy: number; sidePx: number; origin: boolean };

export type ScreenLayoutInput = {
  /** 表示領域 [px]（CSS px。全画面ならウィンドウの大きさ） */
  widthPx: number;
  heightPx: number;
  /** 1mm あたりの px（CSS px） */
  pxPerMm: number;
  /** 希望する黒い正方形の一辺 [mm]。収まらなければ最大値に丸める */
  markerMm: number;
  mode: ScreenMode;
  originId: number;
  /** 追加マーカーの ID（multi のときだけ使う。先頭から ring の順） */
  extraIds: readonly number[];
  gapRatio?: number;
};

export type ScreenLayout = {
  tiles: ScreenTile[];
  /** 実際に使う一辺 [mm]（丸めた後） */
  markerMm: number;
  /** この画面・モード・枚数で収まる最大の一辺 [mm] */
  maxMm: number;
  /** 希望した markerMm が収まらず丸めたか */
  clamped: boolean;
};

/** 追加マーカーの並び（格子の列, 行。中央が原点）。左右 → 上下 → 四隅 */
export const RING_OFFSETS: readonly [number, number][] = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
];

/** 対角の実寸 [mm] と画面の px から 1mm あたりの px */
export function pxPerMmFromDiagonal(diagonalMm: number, widthPx: number, heightPx: number): number {
  if (!(diagonalMm > 0) || !(widthPx > 0) || !(heightPx > 0)) return NaN;
  return Math.hypot(widthPx, heightPx) / diagonalMm;
}

export function inchesToMm(inches: number): number {
  return inches * MM_PER_INCH;
}

/** 画面の実寸 [mm] */
export function screenSizeMm(pxPerMm: number, widthPx: number, heightPx: number): { widthMm: number; heightMm: number } {
  return { widthMm: widthPx / pxPerMm, heightMm: heightPx / pxPerMm };
}

/** モードと枚数から必要な格子の列数・行数（中央を含む） */
export function gridSpan(mode: ScreenMode, extraCount: number): { cols: number; rows: number } {
  if (mode === "single" || extraCount <= 0) return { cols: 1, rows: 1 };
  const used = RING_OFFSETS.slice(0, Math.min(extraCount, RING_OFFSETS.length));
  const maxCol = Math.max(0, ...used.map(([c]) => Math.abs(c)));
  const maxRow = Math.max(0, ...used.map(([, r]) => Math.abs(r)));
  return { cols: maxCol * 2 + 1, rows: maxRow * 2 + 1 };
}

/**
 * 画面に収まる最大の一辺 [mm]（整数に切り捨て）。余白込みの 10/8 倍と、隣との間隔（gapRatio × 一辺）を含めて
 * 列数・行数ぶん並べたときに幅・高さの両方に収まる値
 */
export function maxMarkerMm(widthPx: number, heightPx: number, pxPerMm: number, mode: ScreenMode, extraCount: number, gapRatio = DEFAULT_GAP_RATIO): number {
  if (!(pxPerMm > 0)) return 0;
  const { cols, rows } = gridSpan(mode, extraCount);
  const { widthMm, heightMm } = screenSizeMm(pxPerMm, widthPx, heightPx);
  const perW = widthMm / (cols * MARKER_SVG_SCALE + (cols - 1) * gapRatio);
  const perH = heightMm / (rows * MARKER_SVG_SCALE + (rows - 1) * gapRatio);
  return Math.max(0, Math.floor(Math.min(perW, perH)));
}

/**
 * 画面上の配置を決める。原点は中央、追加マーカーは RING_OFFSETS の順に中心間隔 pitch で並ぶ。
 * 追加マーカーの枚数が上限（MAX_EXTRA_MARKERS）を超える・ID が不正（範囲外・重複・原点と同じ）なら throw
 */
export function layoutScreenMarkers(input: ScreenLayoutInput): ScreenLayout {
  const gapRatio = input.gapRatio ?? DEFAULT_GAP_RATIO;
  const extraIds = input.mode === "multi" ? input.extraIds : [];
  if (extraIds.length > MAX_EXTRA_MARKERS) throw new Error(`追加マーカーは ${MAX_EXTRA_MARKERS} 枚まで（${extraIds.length} 枚）`);
  const seen = new Set<number>([input.originId]);
  for (const id of extraIds) {
    if (!Number.isInteger(id) || id < 0 || id > MAX_MARKER_ID) throw new Error(`ID は 0〜${MAX_MARKER_ID} の整数（${id}）`);
    if (seen.has(id)) throw new Error(`ID ${id} が重複しています（原点 ${input.originId} とも別の値に）`);
    seen.add(id);
  }
  if (!(input.pxPerMm > 0) || !Number.isFinite(input.pxPerMm)) throw new Error("pxPerMm は正の数");
  const maxMm = maxMarkerMm(input.widthPx, input.heightPx, input.pxPerMm, input.mode, extraIds.length, gapRatio);
  const wanted = Number.isFinite(input.markerMm) && input.markerMm > 0 ? input.markerMm : DEFAULT_SCREEN_MARKER_MM;
  const markerMm = Math.max(0, Math.min(wanted, maxMm));
  const clamped = markerMm !== wanted;
  const sidePx = markerMm * input.pxPerMm;
  const pitchPx = sidePx * (MARKER_SVG_SCALE + gapRatio);
  const ox = input.widthPx / 2;
  const oy = input.heightPx / 2;
  const tiles: ScreenTile[] = [{ id: input.originId, cx: ox, cy: oy, sidePx, origin: true }];
  extraIds.forEach((id, i) => {
    const [c, r] = RING_OFFSETS[i];
    tiles.push({ id, cx: ox + c * pitchPx, cy: oy + r * pitchPx, sidePx, origin: false });
  });
  return { tiles, markerMm, maxMm, clamped };
}

/**
 * 画面上の配置 → room に配る配置（MarkerPlacement[]。原点は含まない）。
 * 画面 = 正面の壁（face "wall"）。画面の右が +X、上が +Y（画面の y は下向きなので符号を反転）、Z = 0。位置は mm 単位に丸める
 */
export function tilesToPlacements(tiles: readonly ScreenTile[], pxPerMm: number): MarkerPlacement[] {
  const origin = tiles.find((t) => t.origin);
  if (!origin) throw new Error("原点のタイルがありません");
  // -0 を作らない（JSON では "0" になるが Object.is で違い、俯瞰画面の行との比較で食い違う）
  const toM = (px: number) => Math.round(px / pxPerMm) / 1000 || 0;
  return tiles.filter((t) => !t.origin).map((t) => ({ id: t.id, face: "wall", pos: [toM(t.cx - origin.cx), toM(origin.cy - t.cy), 0] }));
}

/** 追加マーカーの ID の並びを決める。?ids= があればそれ（不正な要素は捨てる）、無ければ原点を飛ばして 1 から count 枚 */
export function defaultExtraIds(originId: number, count: number, idsRaw: string | null = null): number[] {
  if (idsRaw) {
    const out: number[] = [];
    for (const raw of idsRaw.split(",")) {
      const id = Number(raw);
      if (Number.isInteger(id) && id >= 0 && id <= MAX_MARKER_ID && id !== originId && !out.includes(id)) out.push(id);
    }
    return out;
  }
  const out: number[] = [];
  for (let id = 0; out.length < Math.max(0, count) && id <= MAX_MARKER_ID; id++) if (id !== originId) out.push(id);
  return out;
}

/** 配置の検証（サーバーと同じ validateMarkerLayout。画面は壁だけなので床の高さは関係ない） */
export function validateScreenPlacements(placements: readonly MarkerPlacement[], originId: number): string | null {
  const invalid = validateMarkerLayout(placements, originId, 0);
  if (invalid) return invalid;
  // 画面の実寸の入力ミス（対角を mm ではなくインチで入れた等）で原点から数 m 離れることはないはずなので早めに気づかせる
  const far = placements.find((p) => Math.hypot(p.pos[0], p.pos[1]) > MARKER_POS_LIMIT_M / 4);
  return far ? `ID ${far.id} が原点から ${Math.hypot(far.pos[0], far.pos[1]).toFixed(1)}m 離れています（画面の実寸の入力を確認）` : null;
}

/** HUD / ログ用: "0@(640,360)s300;1@(190,360)s300"（HUD は空白区切りなので中は ; で区切る） */
export function describeTiles(tiles: readonly ScreenTile[]): string {
  return tiles.map((t) => `${t.id}@(${Math.round(t.cx)},${Math.round(t.cy)})s${Math.round(t.sidePx)}`).join(";");
}
