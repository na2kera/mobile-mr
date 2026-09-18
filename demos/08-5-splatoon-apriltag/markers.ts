// 08-5 用のマーカー印刷ページ（AprilTag tag36h11）。08 の markers.ts のコピーで、SVG を tag36h11（tag36h11.ts の符号表。
// 検出は WASM の同じファミリ）から生成する。原点（正面）+ おすすめの割り当て（床・左・右・背面・正面 2 枚目）を 1 枚 1 ページで出す。
// ?mm= で黒い正方形の一辺 [mm]、?ids= で印刷する ID の並び（既定 0,1,2,3,4,5）、?markerId= で原点の ID。
// AprilTag の「タグの大きさ」は黒い正方形の外側の一辺（8 セル）で、ArUco と同じ定義なので ?markerMm= の意味も 08 と同じ
import { TAG36H11_COUNT, tag36h11Svg } from "./tag36h11";
import { DEFAULT_MARKER_MM, SUGGESTED_MARKERS } from "../../src/shared/marker-layout";
import { numParam, params } from "../../src/shared/url-params";

/** 黒い正方形の一辺 [mm]。既定はデモ側の ?markerMm= の既定と同じ値（1 か所で持つ。issue #54） */
const MM = numParam("mm", DEFAULT_MARKER_MM, { min: 20, max: 1000 });
const ORIGIN_ID = Math.round(numParam("markerId", 0, { min: 0, max: TAG36H11_COUNT - 1 }));
document.documentElement.style.setProperty("--marker-mm", String(MM));
document.querySelector<HTMLParagraphElement>("#size-note")!.textContent =
  MM === DEFAULT_MARKER_MM
    ? `1 枚 1 ページで印刷します（倍率 100%「実際のサイズ」）。黒い正方形の一辺が ${MM}mm（デモの ?markerMm= の既定と同じ）になります（?mm= で変えたときは全員のデモ URL に ?markerMm=実測値 を付けます。追加マーカーも同じ大きさで印刷してください）。`
    : `1 枚 1 ページで印刷します（倍率 100%「実際のサイズ」）。黒い正方形の一辺が ${MM}mm になります（デモの既定 ${DEFAULT_MARKER_MM}mm と違うので、全員のデモ URL と俯瞰画面に ?markerMm=${MM} を付けます。追加マーカーも同じ大きさで印刷してください）。`;

type Sheet = { id: number; title: string; up: string };
const idsRaw = params.get("ids");
const sheets: Sheet[] = [];
if (idsRaw) {
  for (const raw of idsRaw.split(",")) {
    const id = Number(raw);
    if (Number.isInteger(id) && id >= 0 && id < TAG36H11_COUNT) sheets.push({ id, title: `ID ${id}`, up: "↑ 上（壁: 天井へ ／ 床: 正面の壁へ）" });
  }
} else {
  sheets.push({ id: ORIGIN_ID, title: `正面の壁（原点）— ID ${ORIGIN_ID}`, up: "↑ 上（天井へ）" });
  for (const s of SUGGESTED_MARKERS) {
    if (s.id === ORIGIN_ID) continue;
    sheets.push({ id: s.id, title: `${s.label} — ID ${s.id}`, up: s.face === "floor" ? "↑ 上（正面の壁の方向へ）" : "↑ 上（天井へ）" });
  }
}

const container = document.querySelector<HTMLDivElement>("#sheets")!;
for (const s of sheets) {
  const sheet = document.createElement("div");
  sheet.className = "sheet";
  const up = document.createElement("div");
  up.className = "up";
  up.textContent = s.up;
  const marker = document.createElement("div");
  marker.className = "marker";
  marker.innerHTML = tag36h11Svg(s.id);
  const caption = document.createElement("div");
  caption.className = "caption";
  caption.innerHTML = `<strong>${s.title}</strong><small>黒い正方形 ${MM}mm ／ AprilTag tag36h11 ／ 08-5 MR Splatoon（AprilTag 版）。中心の位置を原点から測って俯瞰画面に入力</small>`;
  sheet.append(up, marker, caption);
  container.append(sheet);
}
