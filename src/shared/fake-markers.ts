// PC デバッグ用フェイクカメラのマーカー描画（マルチマーカー対応。issue #30）。
// 02〜08 のフェイクカメラは「マーカー ID 0 の画像を画面の決まった位置に貼る」だけだったが、
// 複数マーカーの位置合わせを PC で確かめるには、全マーカーが「同じ 1 つの視点から見た」幾何で
// 描かれていないと、マーカーごとに出した原点の姿勢が食い違ってしまう（画像の重ね貼りでは作れない）。
// ここでは field 座標系に置いた各マーカーを、ピンホールカメラ（焦点距離は検出側と同じ換算）で
// 投影して 1 セルずつ多角形で塗る。描画は canvas 2D の fill だけなので three.js には依存しない。
// 投影の数学は Node の回帰テストから import する（.ts 付き import は Node の ESM 解決のため）
import type { V3 } from "./surface.ts";
import { invertRigid, mulMat4, transformPoint } from "./marker-layout.ts";

export type FakeMarker = {
  id: number;
  /** 黒枠の内側のビット [行][列]（上の行から）。true = 白（marker-detector.ts の markerBits） */
  bits: boolean[][];
  /** マーカー座標系 → field 座標系（列優先 16 要素。marker-layout.ts の markerToFieldMatrix） */
  toField: number[];
};

export type ProjectedMarker = {
  id: number;
  /** 白い余白（クワイエットゾーン）の四角形 [px] */
  quiet: [number, number][];
  /** 黒い正方形 */
  black: [number, number][];
  /** 白いセル（ビット）の四角形 */
  cells: [number, number][][];
  /** 黒い正方形の画面上の平均辺長 [px]（検出可能かの目安） */
  sidePx: number;
};

/**
 * フェイクカメラの姿勢（カメラ座標系 → field 座標系）。カメラ座標系は three.js と同じ（X 右・Y 上・-Z 前方）。
 * yaw は左回り（+ で左を向く）、pitch は + で下を向く
 */
export function fakeCameraToField(pos: V3, yawDeg: number, pitchDeg: number): number[] {
  const y = (yawDeg * Math.PI) / 180;
  const p = (-pitchDeg * Math.PI) / 180;
  // R = R_y(yaw) × R_x(-pitch)（列優先）
  const ry = [Math.cos(y), 0, -Math.sin(y), 0, 0, 1, 0, 0, Math.sin(y), 0, Math.cos(y), 0, 0, 0, 0, 1];
  const rx = [1, 0, 0, 0, 0, Math.cos(p), Math.sin(p), 0, 0, -Math.sin(p), Math.cos(p), 0, 0, 0, 0, 1];
  const r = mulMat4(ry, rx);
  r[12] = pos[0];
  r[13] = pos[1];
  r[14] = pos[2];
  return r;
}

/**
 * マーカー 1 枚を投影する。カメラの後ろに回る（Z >= -0.05）角があれば null。
 * @param fieldToCam field 座標系 → カメラ座標系（fakeCameraToField の逆）
 * @param focalPx 焦点距離 [px]（検出側と同じ: 長辺/2/tan(水平 FOV/2)）
 */
export function projectFakeMarker(
  marker: FakeMarker,
  fieldToCam: number[],
  focalPx: number,
  width: number,
  height: number,
  markerSizeM: number,
): ProjectedMarker | null {
  const markerToCam = mulMat4(fieldToCam, marker.toField);
  const c = markerSizeM / 8;
  const project = (x: number, y: number): [number, number] | null => {
    const p = transformPoint(markerToCam, [x, y, 0]);
    if (p[2] >= -0.05) return null;
    return [width / 2 + (focalPx * p[0]) / -p[2], height / 2 - (focalPx * p[1]) / -p[2]];
  };
  // 10 セルの格子（余白 1 + 黒枠 1 + ビット 6 + 黒枠 1 + 余白 1）の座標。gx: 左から, gy: 上から
  const cell = (gx: number, gy: number): [number, number][] | null => {
    const x0 = (gx - 5) * c;
    const x1 = (gx - 4) * c;
    const yTop = (5 - gy) * c;
    const yBottom = (4 - gy) * c;
    const q = [project(x0, yTop), project(x1, yTop), project(x1, yBottom), project(x0, yBottom)];
    return q.every((v) => v !== null) ? (q as [number, number][]) : null;
  };
  const span = (g0: number, g1: number): [number, number][] | null => {
    const x0 = (g0 - 5) * c;
    const x1 = (g1 - 5) * c;
    const yTop = (5 - g0) * c;
    const yBottom = (5 - g1) * c;
    const q = [project(x0, yTop), project(x1, yTop), project(x1, yBottom), project(x0, yBottom)];
    return q.every((v) => v !== null) ? (q as [number, number][]) : null;
  };
  const quiet = span(0, 10);
  const black = span(1, 9);
  if (!quiet || !black) return null;
  const cells: [number, number][][] = [];
  const size = marker.bits.length;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!marker.bits[y][x]) continue;
      const q = cell(x + 2, y + 2);
      if (!q) return null;
      cells.push(q);
    }
  }
  let perimeter = 0;
  for (let i = 0; i < 4; i++) {
    const a = black[i];
    const b = black[(i + 1) % 4];
    perimeter += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return { id: marker.id, quiet, black, cells, sidePx: perimeter / 4 };
}

/** 全マーカーを投影する（カメラの後ろのものは除く）。遠いものから描けるよう sidePx の小さい順 */
export function projectFakeMarkers(
  markers: readonly FakeMarker[],
  camToField: number[],
  focalPx: number,
  width: number,
  height: number,
  markerSizeM: number,
): ProjectedMarker[] {
  const fieldToCam = invertRigid(camToField);
  const out: ProjectedMarker[] = [];
  for (const m of markers) {
    const p = projectFakeMarker(m, fieldToCam, focalPx, width, height, markerSizeM);
    if (p) out.push(p);
  }
  return out.sort((a, b) => a.sidePx - b.sidePx);
}

function fillQuad(ctx: CanvasRenderingContext2D, q: [number, number][], color: string) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(q[0][0], q[0][1]);
  for (let i = 1; i < q.length; i++) ctx.lineTo(q[i][0], q[i][1]);
  ctx.closePath();
  ctx.fill();
}

/** 投影済みのマーカーを canvas に塗る（背景は呼び出し側が先に描く） */
export function drawProjectedMarkers(ctx: CanvasRenderingContext2D, markers: readonly ProjectedMarker[]) {
  for (const m of markers) {
    fillQuad(ctx, m.quiet, "#fff");
    fillQuad(ctx, m.black, "#000");
    for (const q of m.cells) fillQuad(ctx, q, "#fff");
  }
}

/**
 * URL の ?fakeMarkers= を読む（"1:floor:0,-1.2,0.6;5:wall:0.25,0,0" = ID:面:x,y,z を ; 区切り）。
 * 不正な要素は捨てる。face の綴りは marker-layout.ts の MARKER_FACES
 */
export function parseFakeMarkersParam(raw: string | null): { id: number; face: string; pos: V3 }[] {
  if (!raw) return [];
  const out: { id: number; face: string; pos: V3 }[] = [];
  for (const item of raw.split(";")) {
    const [idRaw, face, posRaw] = item.split(":");
    const id = Number(idRaw);
    const pos = (posRaw ?? "").split(",").map(Number);
    if (!Number.isInteger(id) || !face || pos.length !== 3 || !pos.every(Number.isFinite)) continue;
    out.push({ id, face, pos: [pos[0], pos[1], pos[2]] });
  }
  return out;
}
