// 08-6 画面マーカー（docs/space-stability-options.md §4 の 1d）: PC のモニタ / プロジェクタに表示するマーカー板の
// 「画面上の配置（px）」と「room に配る配置（原点からの m）」の純粋な変換。
//   - 画面の実寸はブラウザから取れない（CSS の mm は 96dpi 固定）ので、対角の実寸（インチ / mm）か 1mm あたりの px を利用者が入れる
//   - 原点（room の markerId）は画面の中央。追加マーカーはその周り（左右 → 上下 → 四隅の順）に同じ大きさで並べる
//   - 追加マーカーの位置は「画面上の px 差 ÷ pxPerMm」で決まる（巻き尺で測らない）。面は全部「正面の壁」（画面 = 正面の壁）
//   - 大きさ（markerMm）は画面に収まる範囲に丸めて描く（モードと枚数で最大値が変わる: 遠いときは 1 枚大きく、近いときは複数枚小さく）。
//     ただし丸めた一辺は room の markerMm と食い違うので、丸めている間はページ側で接続も反映もしない（clamped）
// three.js に依存させない（Node の回帰テスト scripts/test-08-6-screen-markers.mjs から import する。.ts 付き import は Node の ESM 解決のため）
import { MAX_EXTRA_MARKERS, MAX_MARKER_ID, validateMarkerLayout } from "../../src/shared/marker-layout.ts";
import type { MarkerPlacement } from "../../src/shared/marker-layout.ts";

/** 余白（クワイエットゾーン）込みの一辺は黒い正方形の 10/8 倍（marker-detector.ts の markerSvg は 余白 1 + 黒枠 8 + 余白 1 = 10 セル） */
export const MARKER_SVG_SCALE = 10 / 8;
/** 画面に出すマーカー（黒い正方形）の一辺の既定 [mm]。08 の DEFAULT_MARKER_MM と同じ値（room の markerMm と一致が必要） */
export const DEFAULT_SCREEN_MARKER_MM = 150;
export const MIN_SCREEN_MARKER_MM = 20;
/** 隣り合うマーカーの余白同士の間隔（黒い正方形の一辺に対する比） */
export const DEFAULT_GAP_RATIO = 0.2;
/** 隣り合うマーカーの間隔の最小 [CSS px]。タイルの下のキャプション（11px の文字 + 余白）が下のタイルの余白に重ならないため */
export const CAPTION_GAP_PX = 18;
/** 換算した画面の幅 [mm] の妥当な範囲（外れたら対角 / 1mm あたり CSS px の入力ミス。スマホ〜大型プロジェクタより外） */
export const SCREEN_WIDTH_MM_MIN = 150;
export const SCREEN_WIDTH_MM_MAX = 5000;
/** 較正線の長さ [mm]（画面に常時出し、定規を当てて実寸を確かめる） */
export const RULER_MM = 100;
/** 追加マーカーの枚数の範囲 */
export const MIN_EXTRA_COUNT = 0;
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
  /** 希望した一辺 [mm]（入力が不正なら既定値） */
  wantedMm: number;
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

/** 隣り合うマーカーの余白同士の間隔 [px]（gapRatio × 一辺。ただしキャプションの高さ CAPTION_GAP_PX 以上） */
export function gapPx(sidePx: number, gapRatio = DEFAULT_GAP_RATIO): number {
  return Math.max(gapRatio * sidePx, CAPTION_GAP_PX);
}

/**
 * 画面に収まる最大の一辺 [mm]（整数に切り捨て）。余白込みの 10/8 倍と、隣との間隔（gapPx: gapRatio × 一辺、最小 CAPTION_GAP_PX）を含めて
 * 列数・行数ぶん並べたときに幅・高さの両方に収まる値
 */
export function maxMarkerMm(widthPx: number, heightPx: number, pxPerMm: number, mode: ScreenMode, extraCount: number, gapRatio = DEFAULT_GAP_RATIO): number {
  if (!(pxPerMm > 0)) return 0;
  const { cols, rows } = gridSpan(mode, extraCount);
  const { widthMm, heightMm } = screenSizeMm(pxPerMm, widthPx, heightPx);
  const minGapMm = CAPTION_GAP_PX / pxPerMm;
  // 間隔が比で決まる場合と、最小間隔で決まる場合の両方に収まる値
  const fit = (lenMm: number, n: number) => Math.min(lenMm / (n * MARKER_SVG_SCALE + (n - 1) * gapRatio), (lenMm - (n - 1) * minGapMm) / (n * MARKER_SVG_SCALE));
  return Math.max(0, Math.floor(Math.min(fit(widthMm, cols), fit(heightMm, rows))));
}

/** 換算した画面の実寸が妥当か（幅が SCREEN_WIDTH_MM_MIN〜MAX）。外れていれば警告の文言 */
export function validateScreenSize(pxPerMm: number, screenWidthPx: number, screenHeightPx: number): string | null {
  if (!(pxPerMm > 0) || !Number.isFinite(pxPerMm)) return "画面の対角（インチ）か 1mm あたり CSS px を入れてください";
  const { widthMm, heightMm } = screenSizeMm(pxPerMm, screenWidthPx, screenHeightPx);
  if (widthMm >= SCREEN_WIDTH_MM_MIN && widthMm <= SCREEN_WIDTH_MM_MAX) return null;
  return `画面の実寸が ${widthMm.toFixed(0)}×${heightMm.toFixed(0)} mm になります（幅 ${SCREEN_WIDTH_MM_MIN}〜${SCREEN_WIDTH_MM_MAX}mm の範囲外）。対角か 1mm あたり CSS px の入力を確認してください`;
}

/** 一辺を丸めたときのパネルの文言（丸めている間は接続も反映もしない） */
export function clampMessage(wantedMm: number, maxMm: number, mode: ScreenMode): string {
  return `一辺 ${wantedMm}mm は画面に収まりません。${maxMm}mm 以下にするか、${mode === "multi" ? "1 枚モードにしてください" : "もっと大きな画面を使ってください"}`;
}

/**
 * 画面上の配置を決める。原点は中央、追加マーカーは RING_OFFSETS の順に中心間隔 pitch で並ぶ。
 * 追加マーカーの枚数が上限（MAX_EXTRA_MARKERS）を超える・ID が不正（範囲外・重複・原点と同じ）・収まる最大の一辺が MIN_SCREEN_MARKER_MM 未満なら throw
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
  if (maxMm < MIN_SCREEN_MARKER_MM) throw new Error(`この表示領域・モード・枚数で収まる一辺は ${maxMm}mm で、${MIN_SCREEN_MARKER_MM}mm 未満です（ウィンドウを大きくするか枚数を減らす）`);
  const wanted = Number.isFinite(input.markerMm) && input.markerMm > 0 ? input.markerMm : DEFAULT_SCREEN_MARKER_MM;
  const markerMm = Math.min(wanted, maxMm);
  const clamped = markerMm !== wanted;
  const sidePx = markerMm * input.pxPerMm;
  const pitchPx = sidePx * MARKER_SVG_SCALE + gapPx(sidePx, gapRatio);
  const ox = input.widthPx / 2;
  const oy = input.heightPx / 2;
  const tiles: ScreenTile[] = [{ id: input.originId, cx: ox, cy: oy, sidePx, origin: true }];
  extraIds.forEach((id, i) => {
    const [c, r] = RING_OFFSETS[i];
    tiles.push({ id, cx: ox + c * pitchPx, cy: oy + r * pitchPx, sidePx, origin: false });
  });
  return { tiles, wantedMm: wanted, markerMm, maxMm, clamped };
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

/** 追加マーカーの枚数の入力を 0〜MAX_EXTRA_MARKERS の整数に丸める。範囲外・数値でなければ note に理由 */
export function clampExtraCount(raw: number): { count: number; note: string } {
  if (!Number.isFinite(raw)) return { count: MIN_EXTRA_COUNT, note: `追加マーカーの枚数が数値でないので ${MIN_EXTRA_COUNT} 枚にしました` };
  const count = Math.min(MAX_EXTRA_MARKERS, Math.max(MIN_EXTRA_COUNT, Math.round(raw)));
  return { count, note: count === raw ? "" : `追加マーカーの枚数は ${MIN_EXTRA_COUNT}〜${MAX_EXTRA_MARKERS}（${raw} → ${count} 枚）` };
}

export type DroppedIdReason = "重複" | "原点" | "範囲外" | "数値でない";
export type ExtraIdsResult = {
  /** 使う ID（count 枚。?ids= の有効な値の後ろに既定の ID を補う） */
  ids: number[];
  /** ?ids= から捨てた要素と理由 */
  dropped: { raw: string; reason: DroppedIdReason }[];
  /** 有効な ID が count 未満だったので補った既定の ID */
  filled: number[];
};

/**
 * 追加マーカーの ID の並びを決める。?ids= があればその有効な要素を先頭から使い（不正な要素は理由つきで捨てる）、
 * count に足りなければ原点と使用済みを飛ばして 0 から既定の ID で補う。?ids= が無ければ原点を飛ばして 0 から count 枚
 */
export function resolveExtraIds(originId: number, count: number, idsRaw: string | null = null): ExtraIdsResult {
  const want = Math.max(0, count);
  const ids: number[] = [];
  const dropped: ExtraIdsResult["dropped"] = [];
  if (idsRaw) {
    for (const part of idsRaw.split(",")) {
      const raw = part.trim();
      if (raw === "") continue;
      const id = Number(raw);
      if (!Number.isFinite(id)) dropped.push({ raw, reason: "数値でない" });
      else if (!Number.isInteger(id) || id < 0 || id > MAX_MARKER_ID) dropped.push({ raw, reason: "範囲外" });
      else if (id === originId) dropped.push({ raw, reason: "原点" });
      else if (ids.includes(id)) dropped.push({ raw, reason: "重複" });
      else ids.push(id);
    }
  }
  const used = ids.slice(0, want);
  const filled: number[] = [];
  for (let id = 0; used.length < want && id <= MAX_MARKER_ID; id++) {
    if (id === originId || used.includes(id)) continue;
    used.push(id);
    filled.push(id);
  }
  return { ids: used, dropped, filled: idsRaw ? filled : [] };
}

/** resolveExtraIds の ID だけ */
export function defaultExtraIds(originId: number, count: number, idsRaw: string | null = null): number[] {
  return resolveExtraIds(originId, count, idsRaw).ids;
}

/** パネル用: 捨てた ID と補った ID の説明（無ければ空文字） */
export function describeExtraIds(r: ExtraIdsResult): string {
  const lines: string[] = [];
  if (r.dropped.length > 0) lines.push(`?ids= から捨てた ID: ${r.dropped.map((d) => `${d.raw}（${d.reason}）`).join(" / ")}`);
  if (r.filled.length > 0) lines.push(`有効な ID が足りないので既定の ID ${r.filled.join(", ")} で補いました`);
  return lines.join("\n");
}

/** 較正線の置き場所（左上の座標 [px] と向き）。マーカーのタイル（余白 + キャプション込み）に重ならない隅を探す。無ければ null */
export type RulerPlacement = { x: number; y: number; w: number; h: number; vertical: boolean };
export function placeRuler(widthPx: number, heightPx: number, tiles: readonly ScreenTile[], lengthPx: number, margin = 8): RulerPlacement | null {
  // 横置き: 線の下に文言（高さ 44px）/ 縦置き: 線の右に文言（幅 110px）
  const shapes = [
    { w: lengthPx, h: 44, vertical: false },
    { w: 110, h: lengthPx, vertical: true },
  ];
  const rects = tiles.map((t) => {
    const half = (t.sidePx * MARKER_SVG_SCALE) / 2;
    return { l: t.cx - half - 4, t: t.cy - half - 4, r: t.cx + half + 4, b: t.cy + half + CAPTION_GAP_PX + 4 };
  });
  for (const shape of shapes) {
    // 右下 → 右上 → 左下 → 左上（左上はパネルを表示するボタンがある）
    const corners = [
      [widthPx - margin - shape.w, heightPx - margin - shape.h],
      [widthPx - margin - shape.w, margin + 28],
      [margin, heightPx - margin - shape.h - 24],
      [margin, margin + 28],
    ];
    for (const [x, y] of corners) {
      if (x < 0 || y < 0 || x + shape.w > widthPx || y + shape.h > heightPx) continue;
      const hit = rects.some((q) => x < q.r && x + shape.w > q.l && y < q.b && y + shape.h > q.t);
      if (!hit) return { x, y, ...shape };
    }
  }
  return null;
}

/** 配置の検証（サーバーと同じ validateMarkerLayout。画面は壁だけなので床の高さは関係ない） */
export function validateScreenPlacements(placements: readonly MarkerPlacement[], originId: number): string | null {
  // 画面の実寸の入力ミスは配置の mm では分からない（px 差 ÷ pxPerMm はほぼ「一辺 × 比」で決まり pxPerMm に依らない）ので、validateScreenSize で見る
  return validateMarkerLayout(placements, originId, 0);
}

/** HUD / ログ用: "0@(640,360)s300;1@(190,360)s300"（HUD は空白区切りなので中は ; で区切る） */
export function describeTiles(tiles: readonly ScreenTile[]): string {
  return tiles.map((t) => `${t.id}@(${Math.round(t.cx)},${Math.round(t.cy)})s${Math.round(t.sidePx)}`).join(";");
}
