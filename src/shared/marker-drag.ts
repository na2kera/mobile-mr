// 俯瞰画面でのマーカーのドラッグ（issue #43）の純粋な数学。
//   - 追加マーカーは貼った面（face）から浮かないので、ドラッグは「その面の平面上」だけで動かす
//     （正面 / 背面の壁は X・Y、左右の壁は Z・Y、床は X・Z。残りの軸は元の値のまま）
//   - Shift を押している間は PowerPoint と同じく、面内の 2 軸のうち動きの大きい方だけに固定する（水平 / 垂直）
//   - 画面のレイと平面の交点は「ドラッグ開始時の交点からの差」で使う（掴んだ点がずれず、枠の中心に吸い付かない）
// three.js に依存させない（Node の回帰テスト scripts/test-splatoon.mjs から import するため）
import type { V3 } from "./surface.ts";
import { MARKER_POS_LIMIT_M, markerAxes } from "./marker-layout.ts";
import type { MarkerFace } from "./marker-layout.ts";

/** ドラッグで動かせる面内の 2 軸（field 座標系の軸番号 0 = X, 1 = Y, 2 = Z）。[横方向, 縦方向] */
export function dragAxes(face: MarkerFace): [number, number] {
  switch (face) {
    case "floor":
      return [0, 2];
    case "left":
    case "right":
      return [2, 1];
    case "wall":
    case "back":
      return [0, 1];
  }
}

/** 面の法線（面内の平面の定義に使う。マーカー座標系の Z と同じ） */
export function faceNormal(face: MarkerFace): V3 {
  return markerAxes(face).z;
}

/**
 * レイ（origin + t × dir）と平面（point を通り normal に垂直）の交点。
 * 平行なら null。視点の後ろ（t < 0）も null（画面の外から平面を裏側で捉えたときに枠が飛ぶのを防ぐ）
 */
export function rayPlaneHit(origin: V3, dir: V3, point: V3, normal: V3): V3 | null {
  const denom = dir[0] * normal[0] + dir[1] * normal[1] + dir[2] * normal[2];
  if (Math.abs(denom) < 1e-9) return null;
  const t = ((point[0] - origin[0]) * normal[0] + (point[1] - origin[1]) * normal[1] + (point[2] - origin[2]) * normal[2]) / denom;
  if (t < 0) return null;
  return [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t];
}

/** 入力欄と同じ精度（cm）に丸める */
export function roundCm(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * ドラッグ中のマーカーの新しい位置。
 * pos0 = 掴んだときのマーカーの位置、hit0 = 掴んだときの平面上の点、hit = いまの平面上の点。
 * 面内の 2 軸だけ hit - hit0 ぶん動かす。lockAxis（Shift）なら動きの大きい方の軸だけ動かす。
 * cm に丸め、入力の上限（±MARKER_POS_LIMIT_M）で止める
 */
export function draggedMarkerPos(face: MarkerFace, pos0: V3, hit0: V3, hit: V3, lockAxis: boolean): V3 {
  const [a, b] = dragAxes(face);
  let da = hit[a] - hit0[a];
  let db = hit[b] - hit0[b];
  if (lockAxis) {
    if (Math.abs(da) >= Math.abs(db)) db = 0;
    else da = 0;
  }
  const out: V3 = [pos0[0], pos0[1], pos0[2]];
  out[a] = clampPos(roundCm(pos0[a] + da));
  out[b] = clampPos(roundCm(pos0[b] + db));
  return out;
}

function clampPos(v: number): number {
  return Math.max(-MARKER_POS_LIMIT_M, Math.min(MARKER_POS_LIMIT_M, v));
}
