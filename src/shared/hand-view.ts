// Phase 5: 手の骨格（21 関節 + 21 本の骨）を three.js で描く。
// 描画の実体は skeleton-view.ts（Phase 9 で全身と共通化）。ここは手の点数と接続を固定するだけ
import { HAND_CONNECTIONS, LANDMARK_COUNT } from "./hand-math.ts";
import { SkeletonView } from "./skeleton-view.ts";

export class HandView extends SkeletonView {
  constructor(color: number, jointRadius = 0.008) {
    super(LANDMARK_COUNT, HAND_CONNECTIONS, color, jointRadius);
  }
}
