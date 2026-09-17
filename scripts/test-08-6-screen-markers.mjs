// 08-6 画面マーカーの回帰テスト。`npm run test:08-6-screen-markers` で実行する。
//   demos/08-6-splatoon-screen-markers/screen-layout.ts — 画面の実寸（対角 / pxPerMm）→ 画面上の配置（px）→ room に配る配置（MarkerPlacement[]）
//   の純粋な変換（原点が中央・追加マーカーの mm が正しい・収まらない大きさは丸める・上限と ID の不正は弾く）
// テストフレームワークは使わない（他の scripts/test-*.mjs と同じ方針）。Node 22 は .ts をそのまま import できる
import { MAX_EXTRA_MARKERS, validateMarkerLayout } from "../src/shared/marker-layout.ts";
import {
  DEFAULT_GAP_RATIO,
  MARKER_SVG_SCALE,
  RING_OFFSETS,
  defaultExtraIds,
  describeTiles,
  gridSpan,
  inchesToMm,
  layoutScreenMarkers,
  maxMarkerMm,
  pxPerMmFromDiagonal,
  screenSizeMm,
  tilesToPlacements,
  validateScreenPlacements,
} from "../demos/08-6-splatoon-screen-markers/screen-layout.ts";

const results = [];
function check(name, cond, detail = "") {
  results.push([name, cond]);
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${detail ? ` (${detail})` : ""}`);
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const throws = (fn) => {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
};

// ================= 1. 画面の実寸 =================
{
  // 27 インチ 2560x1440（QHD）: 対角 685.8mm、対角 px 2937.2 → 4.283 px/mm
  const ppm27 = pxPerMmFromDiagonal(inchesToMm(27), 2560, 1440);
  check("27 インチ QHD は 1mm ≈ 4.28 px", near(ppm27, 4.2829, 1e-3), ppm27.toFixed(4));
  const size27 = screenSizeMm(ppm27, 2560, 1440);
  check("その画面の実寸は 597.7 × 336.2 mm（16:9 の 27 インチ）", near(size27.widthMm, 597.7, 0.1) && near(size27.heightMm, 336.2, 0.1), `${size27.widthMm.toFixed(1)}x${size27.heightMm.toFixed(1)}`);
  // 24 インチ FHD（1920x1080）: 3.614 px/mm。macOS の「ディスプレイのデフォルト」（1512x982 等）でも CSS px の総数と対角で換算するので同じ式
  check("24 インチ FHD は 1mm ≈ 3.61 px", near(pxPerMmFromDiagonal(inchesToMm(24), 1920, 1080), 3.6136, 1e-3));
  check("不正な入力（0・負・NaN）は NaN", Number.isNaN(pxPerMmFromDiagonal(0, 1920, 1080)) && Number.isNaN(pxPerMmFromDiagonal(600, -1, 1080)) && Number.isNaN(pxPerMmFromDiagonal(NaN, 1920, 1080)));
  check("1 インチ = 25.4mm", inchesToMm(1) === 25.4);
}

// ================= 2. 収まる最大の一辺 =================
{
  // 1280x720 px を 2 px/mm で = 640x360 mm（ヘッドレス確認と同じ条件）
  check("single: 高さ 360mm に余白込み（10/8 倍）で収まる最大は 288mm", maxMarkerMm(1280, 720, 2, "single", 0) === 288);
  check("single は枚数を無視する", maxMarkerMm(1280, 720, 2, "single", 8) === 288);
  const span4 = gridSpan("multi", 4);
  check("multi 4 枚（左右上下）は 3 列 × 3 行", span4.cols === 3 && span4.rows === 3);
  const span2 = gridSpan("multi", 2);
  check("multi 2 枚（左右）は 3 列 × 1 行", span2.cols === 3 && span2.rows === 1);
  check("multi 0 枚は 1 × 1", gridSpan("multi", 0).cols === 1 && gridSpan("multi", 0).rows === 1);
  // 3 行: 360 / (3 × 1.25 + 2 × 0.2) = 360 / 4.15 = 86.7 → 86
  check("multi 4 枚の最大は高さで決まり 86mm", maxMarkerMm(1280, 720, 2, "multi", 4) === 86);
  // 1 行 3 列: 幅 640 / 4.15 = 154.2 → 154、高さ 288 → 154
  check("multi 2 枚（1 行）の最大は幅で決まり 154mm", maxMarkerMm(1280, 720, 2, "multi", 2) === 154);
  check("間隔 0 なら 3 列で 640 / 3.75 = 170mm", maxMarkerMm(1280, 720, 2, "multi", 2, 0) === 170);
  check("pxPerMm が不正なら 0", maxMarkerMm(1280, 720, 0, "single", 0) === 0 && maxMarkerMm(1280, 720, NaN, "single", 0) === 0);
}

// ================= 3. 画面上の配置 =================
{
  const base = { widthPx: 1280, heightPx: 720, pxPerMm: 2, markerMm: 80, mode: "multi", originId: 0, extraIds: [1, 2, 3, 4] };
  const l = layoutScreenMarkers(base);
  console.log(`layout: ${describeTiles(l.tiles)} markerMm=${l.markerMm} max=${l.maxMm} clamped=${l.clamped}`);
  check("5 枚（原点 + 4）で、丸めていない", l.tiles.length === 5 && l.markerMm === 80 && !l.clamped && l.maxMm === 86);
  const origin = l.tiles[0];
  check("原点は画面の中央で origin=true", origin.id === 0 && origin.origin && near(origin.cx, 640) && near(origin.cy, 360));
  check("黒い正方形の一辺は 80mm × 2 px/mm = 160 px", l.tiles.every((t) => near(t.sidePx, 160)));
  // 中心間隔 = 160 × (1.25 + 0.2) = 232 px
  const pitch = 160 * (MARKER_SVG_SCALE + DEFAULT_GAP_RATIO);
  check("追加マーカーは RING_OFFSETS の順（左・右・上・下）に中心間隔 232px", near(pitch, 232) && l.tiles.slice(1).every((t, i) => near(t.cx, 640 + RING_OFFSETS[i][0] * pitch) && near(t.cy, 360 + RING_OFFSETS[i][1] * pitch)));
  check("追加マーカーは origin=false で ID の順", l.tiles.slice(1).map((t) => t.id).join(",") === "1,2,3,4" && l.tiles.slice(1).every((t) => !t.origin));

  const single = layoutScreenMarkers({ ...base, mode: "single", markerMm: 200 });
  check("single は追加 ID を渡しても原点 1 枚だけ（200mm はそのまま）", single.tiles.length === 1 && single.markerMm === 200 && !single.clamped && single.maxMm === 288);
  const clamped = layoutScreenMarkers({ ...base, markerMm: 300 });
  check("収まらない大きさ（300mm）は最大（86mm）に丸めて clamped=true", clamped.markerMm === 86 && clamped.clamped && clamped.tiles.every((t) => near(t.sidePx, 172)));
  const eight = layoutScreenMarkers({ ...base, extraIds: [1, 2, 3, 4, 5, 6, 7, 8], markerMm: 60 });
  check("上限の 8 枚まで並ぶ（四隅は対角に）", eight.tiles.length === 9 && near(eight.tiles[8].cx, 640 + 60 * 2 * 1.45) && near(eight.tiles[8].cy, 360 + 60 * 2 * 1.45));
  const off = layoutScreenMarkers({ ...base, widthPx: 1000, heightPx: 500 });
  check("表示領域が違えば原点もその中央（500, 250）", near(off.tiles[0].cx, 500) && near(off.tiles[0].cy, 250));
  check("markerMm が不正（NaN / 0）なら既定（150）を希望値にして丸める", layoutScreenMarkers({ ...base, markerMm: NaN }).markerMm === 86 && layoutScreenMarkers({ ...base, mode: "single", markerMm: 0 }).markerMm === 150);

  // 不正な入力は throw
  check(`追加マーカー ${MAX_EXTRA_MARKERS + 1} 枚は弾く`, /枚まで/.test(throws(() => layoutScreenMarkers({ ...base, extraIds: [1, 2, 3, 4, 5, 6, 7, 8, 9] })) ?? ""));
  check("原点と同じ ID は弾く", /重複/.test(throws(() => layoutScreenMarkers({ ...base, extraIds: [1, 0] })) ?? ""));
  check("重複した ID は弾く", /重複/.test(throws(() => layoutScreenMarkers({ ...base, extraIds: [1, 1] })) ?? ""));
  check("辞書の範囲外（250）・小数の ID は弾く", /0〜249/.test(throws(() => layoutScreenMarkers({ ...base, extraIds: [250] })) ?? "") && /0〜249/.test(throws(() => layoutScreenMarkers({ ...base, extraIds: [1.5] })) ?? ""));
  check("pxPerMm が不正なら弾く", /pxPerMm/.test(throws(() => layoutScreenMarkers({ ...base, pxPerMm: 0 })) ?? ""));
  check("single なら追加 ID が不正でも通る（使わない）", throws(() => layoutScreenMarkers({ ...base, mode: "single", extraIds: [0, 0, 300] })) === null);
}

// ================= 4. 画面上の配置 → room に配る配置 =================
{
  const l = layoutScreenMarkers({ widthPx: 1280, heightPx: 720, pxPerMm: 2, markerMm: 80, mode: "multi", originId: 0, extraIds: [1, 2, 3, 4] });
  const p = tilesToPlacements(l.tiles, 2);
  console.log(`placements: ${JSON.stringify(p)}`);
  check("原点は含まず 4 枚、面は全部 wall", p.length === 4 && p.every((m) => m.face === "wall"));
  // 中心間隔 232 px ÷ 2 px/mm = 116mm = 0.116m。画面の右が +X、上が +Y、Z = 0
  check("左のマーカー（ID 1）は X = -0.116, Y = 0", p[0].id === 1 && p[0].pos[0] === -0.116 && p[0].pos[1] === 0 && p[0].pos[2] === 0);
  check("右のマーカー（ID 2）は X = +0.116", p[1].id === 2 && p[1].pos[0] === 0.116 && p[1].pos[1] === 0);
  check("上のマーカー（ID 3）は Y = +0.116（画面の y は下向きなので反転）", p[2].id === 3 && p[2].pos[0] === 0 && p[2].pos[1] === 0.116);
  check("下のマーカー（ID 4）は Y = -0.116", p[3].id === 4 && p[3].pos[1] === -0.116);
  check("-0 にならない（JSON で \"-0\" にならず、俯瞰画面の行と一致する）", !Object.is(p[0].pos[1], -0) && !Object.is(p[2].pos[0], -0) && !Object.is(p[0].pos[2], -0));
  // mm 単位に丸める: 1.7 px/mm で 232 × 1.45 ... 中心間隔 = side × 1.45 = 80 × 1.7 × 1.45 = 197.2 px → 116mm（197.2 / 1.7 = 116.0）
  const l17 = layoutScreenMarkers({ widthPx: 1280, heightPx: 720, pxPerMm: 1.7, markerMm: 80, mode: "multi", originId: 0, extraIds: [1] });
  check("pxPerMm が小数でも位置は mm に丸める（116mm）", tilesToPlacements(l17.tiles, 1.7)[0].pos[0] === -0.116);
  check("サーバーと同じ validateMarkerLayout を通る", validateMarkerLayout(p, 0, 1.2) === null && validateScreenPlacements(p, 0) === null);
  check("原点のタイルが無ければ弾く", /原点/.test(throws(() => tilesToPlacements(l.tiles.slice(1), 2)) ?? ""));
  // 画面の実寸の入力ミス（pxPerMm を 100 倍小さく）→ 原点から 11.6m → 弾く
  const far = tilesToPlacements(l.tiles, 0.02);
  check("原点から 5m 超は「画面の実寸の入力を確認」で弾く", /実寸/.test(validateScreenPlacements(far, 0) ?? ""), validateScreenPlacements(far, 0));
  check("原点と同じ ID が混ざれば弾く（validateMarkerLayout の文言）", /原点/.test(validateScreenPlacements([{ id: 0, face: "wall", pos: [0.1, 0, 0] }], 0) ?? ""));
  // 単一なら空の配置（原点だけ）
  const s = layoutScreenMarkers({ widthPx: 1280, heightPx: 720, pxPerMm: 2, markerMm: 200, mode: "single", originId: 0, extraIds: [] });
  check("single の配置は空（原点だけ = 08 の既定と同じ）", tilesToPlacements(s.tiles, 2).length === 0);
}

// ================= 5. 追加マーカーの ID =================
{
  check("既定は原点を飛ばして 1 から count 枚", defaultExtraIds(0, 4).join(",") === "1,2,3,4" && defaultExtraIds(2, 3).join(",") === "0,1,3");
  check("count 0 は空", defaultExtraIds(0, 0).length === 0);
  check("?ids= は不正な要素（重複・原点・範囲外・数値でない）を捨てる", defaultExtraIds(0, 4, "5,5,0,300,x,7").join(",") === "5,7");
}

const failed = results.filter(([, ok]) => !ok);
console.log(failed.length === 0 ? "\nALL PASS" : `\n${failed.length} FAILED`);
process.exit(failed.length === 0 ? 0 : 1);
