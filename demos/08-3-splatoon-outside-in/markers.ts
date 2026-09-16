// 08-3 用のマーカー印刷ページ。08 の markers.ts のコピーで、原点（正面）+ 床（トラッカーの原点合わせ用）に加えて
// ゴーグルの前面に貼るマーカー（ID 10〜。サーバーが入室順に割り当てる）を小さく（?goggleMm=）出す。
// SVG は検出と同じ辞書（marker-detector.ts の markerSvg）から生成するので、03 の marker-0.svg と同じ描き方。
// ?mm= で黒い正方形の一辺 [mm]、?ids= で印刷する ID の並び（既定 0,1 と 10〜13）、?markerId= で原点の ID、?players= でゴーグルの枚数
import { markerIdCount, markerSvg } from "../../src/shared/marker-detector";
import { DEFAULT_MARKER_MM, SUGGESTED_MARKERS } from "../../src/shared/marker-layout";
import { TRACK_ID_FIRST } from "../../src/shared/splatoon-outside-in-protocol";
import { numParam, params } from "../../src/shared/url-params";

/** 黒い正方形の一辺 [mm]。既定はデモ側の ?markerMm= の既定と同じ値（1 か所で持つ。issue #54） */
const MM = numParam("mm", DEFAULT_MARKER_MM, { min: 20, max: 1000 });
/** ゴーグルのマーカーの一辺 [mm]（俯瞰画面の ?trackMarkerMm= の既定と同じ 60） */
const GOGGLE_MM = numParam("goggleMm", 60, { min: 10, max: 1000 });
/** ゴーグルのマーカーの枚数（ID 10 から順） */
const PLAYERS = Math.round(numParam("players", 4, { min: 1, max: 8 }));
const ORIGIN_ID = Math.round(numParam("markerId", 0, { min: 0, max: markerIdCount() - 1 }));
document.documentElement.style.setProperty("--marker-mm", String(MM));
document.querySelector<HTMLParagraphElement>("#size-note")!.textContent =
  MM === DEFAULT_MARKER_MM
    ? `1 枚 1 ページで印刷します（倍率 100%「実際のサイズ」）。黒い正方形の一辺が ${MM}mm（デモの ?markerMm= の既定と同じ）になります（?mm= で変えたときは全員のデモ URL に ?markerMm=実測値 を付けます。追加マーカーも同じ大きさで印刷してください）。`
    : `1 枚 1 ページで印刷します（倍率 100%「実際のサイズ」）。黒い正方形の一辺が ${MM}mm になります（デモの既定 ${DEFAULT_MARKER_MM}mm と違うので、全員のデモ URL と俯瞰画面に ?markerMm=${MM} を付けます。追加マーカーも同じ大きさで印刷してください）。`;

type Sheet = { id: number; title: string; up: string; mm: number };
const idsRaw = params.get("ids");
const sheets: Sheet[] = [];
if (idsRaw) {
  for (const raw of idsRaw.split(",")) {
    const id = Number(raw);
    if (Number.isInteger(id) && id >= 0 && id < markerIdCount()) sheets.push({ id, title: `ID ${id}`, up: "↑ 上（壁: 天井へ ／ 床: 正面の壁へ ／ ゴーグル: 天井へ）", mm: id >= TRACK_ID_FIRST ? GOGGLE_MM : MM });
  }
} else {
  sheets.push({ id: ORIGIN_ID, title: `正面の壁（原点）— ID ${ORIGIN_ID}`, up: "↑ 上（天井へ）", mm: MM });
  const floor = SUGGESTED_MARKERS.find((s) => s.face === "floor");
  if (floor && floor.id !== ORIGIN_ID) sheets.push({ id: floor.id, title: `${floor.label}（トラッカーの原点合わせ用）— ID ${floor.id}`, up: "↑ 上（正面の壁の方向へ）", mm: MM });
  for (let i = 0; i < PLAYERS; i++) {
    const id = TRACK_ID_FIRST + i;
    if (id >= markerIdCount()) break;
    sheets.push({ id, title: `ゴーグル ${i + 1} 人目（入室順）— ID ${id}`, up: "↑ 上（天井へ。ゴーグルの前面に）", mm: GOGGLE_MM });
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
  marker.style.setProperty("--marker-mm", String(s.mm));
  marker.innerHTML = markerSvg(s.id);
  const caption = document.createElement("div");
  caption.className = "caption";
  caption.innerHTML = `<strong>${s.title}</strong><small>黒い正方形 ${s.mm}mm ／ ARUCO_MIP_36h12 ／ 08-3 MR Splatoon（アウトサイドイン）。${s.id >= TRACK_ID_FIRST ? "ゴーグルの前面に貼る（俯瞰画面の ?trackMarkerMm= と同じ大きさ）" : "中心の位置を原点から測って俯瞰画面に入力"}</small>`;
  sheet.append(up, marker, caption);
  container.append(sheet);
}
