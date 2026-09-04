// 08 用のマーカー印刷ページ（issue #30 マルチマーカー）。原点（正面）+ おすすめの割り当て（床・左・右・背面・正面 2 枚目）を
// 1 枚 1 ページで出す。SVG は検出と同じ辞書（marker-detector.ts の markerSvg）から生成するので、03 の marker-0.svg と同じ描き方。
// ?mm= で黒い正方形の一辺 [mm]、?ids= で印刷する ID の並び（既定 0,1,2,3,4,5）、?markerId= で原点の ID
import { markerIdCount, markerSvg } from "../../src/shared/marker-detector";
import { SUGGESTED_MARKERS } from "../../src/shared/marker-layout";
import { numParam, params } from "../../src/shared/url-params";

const MM = numParam("mm", 150, { min: 20, max: 1000 });
const ORIGIN_ID = Math.round(numParam("markerId", 0, { min: 0, max: markerIdCount() - 1 }));
document.documentElement.style.setProperty("--marker-mm", String(MM));
document.querySelector<HTMLParagraphElement>("#size-note")!.textContent =
  `1 枚 1 ページで印刷します（倍率 100%「実際のサイズ」）。黒い正方形の一辺が ${MM}mm になります（?mm= で変更。全員のデモ URL に ?markerMm=${MM} を付けます。追加マーカーも同じ大きさで印刷してください）。`;

type Sheet = { id: number; title: string; up: string };
const idsRaw = params.get("ids");
const sheets: Sheet[] = [];
if (idsRaw) {
  for (const raw of idsRaw.split(",")) {
    const id = Number(raw);
    if (Number.isInteger(id) && id >= 0 && id < markerIdCount()) sheets.push({ id, title: `ID ${id}`, up: "↑ 上（壁: 天井へ ／ 床: 正面の壁へ）" });
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
  marker.innerHTML = markerSvg(s.id);
  const caption = document.createElement("div");
  caption.className = "caption";
  caption.innerHTML = `<strong>${s.title}</strong><small>黒い正方形 ${MM}mm ／ ARUCO_MIP_36h12 ／ 08 MR Splatoon。中心の位置を原点から測って俯瞰画面に入力</small>`;
  sheet.append(up, marker, caption);
  container.append(sheet);
}
