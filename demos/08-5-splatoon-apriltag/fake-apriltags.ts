// PC デバッグ用フェイクカメラの AprilTag（tag36h11）描画。08 の src/shared/fake-markers.ts は ArUco（ARUCO_MIP_36h12）の
// ビットを 10 セル格子（余白 1 + 黒枠 1 + 中身 6 + 黒枠 1 + 余白 1）に投影して塗る。tag36h11 も同じ格子
// （width_at_border = 8、total_width = 10。tag36h11.ts 参照）なので、ピンホール投影と塗りは fake-markers.ts の関数を
// そのまま使い、ビットだけ tag36h11 のものに差し替える（既存ファイルは変更しない）。
// `?fakecam=1` で AprilTag の WASM が実際に検出できる合成映像になる（ヘッドレス確認 scripts/headless-splatoon-apriltag.mjs）
import type { FakeMarker, ProjectedMarker } from "../../src/shared/fake-markers";
import { drawProjectedMarkers, projectFakeMarkers } from "../../src/shared/fake-markers";
import { tag36h11Bits } from "./tag36h11";

/** field 座標系に置いた tag36h11 のマーカー（fake-markers.ts の FakeMarker と同じ形） */
export function fakeAprilTag(id: number, toField: number[]): FakeMarker {
  return { id, bits: tag36h11Bits(id), toField };
}

/** 全マーカーを投影して canvas に塗る（背景は呼び出し側が先に描く）。返り値は投影結果（検出可能かの目安 sidePx を見たいとき） */
export function drawFakeAprilTags(
  ctx: CanvasRenderingContext2D,
  markers: readonly FakeMarker[],
  camToField: number[],
  focalPx: number,
  width: number,
  height: number,
  markerSizeM: number,
): ProjectedMarker[] {
  const projected = projectFakeMarkers(markers, camToField, focalPx, width, height, markerSizeM);
  drawProjectedMarkers(ctx, projected);
  return projected;
}
