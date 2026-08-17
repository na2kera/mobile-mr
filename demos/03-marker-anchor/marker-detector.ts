// マーカー検出の境界モジュール。
// js-aruco2（保守が活発でない暫定採用ライブラリ）への依存をこのファイルに閉じ込める。
// 剥がすときは createMarkerDetector の実装だけを差し替える（MarkerObservation と
// MarkerDetector のインターフェースは維持する）。js-aruco2 の import を
// このファイルと js-aruco2.d.ts 以外に書かないこと。
import * as THREE from "three";
import { AR } from "js-aruco2";
import { POS } from "js-aruco2/src/posit1.js";

export type MarkerObservation = {
  id: number;
  /** 検出画像のピクセル座標（左上原点）。デバッグ描画用 */
  corners: { x: number; y: number }[];
  /**
   * カメラ座標系（three.js 規約: X右 / Y上 / -Z前方）でのマーカーの姿勢。
   * マーカーのローカル座標系は X=マーカー右 / Y=マーカー上 / +Z=面から視点側。
   * 並進の単位はメートル
   */
  matrix: THREE.Matrix4;
  /**
   * 姿勢推定の正規化再投影誤差（無次元）。POSIT の誤差はピクセル和で検出解像度に
   * ほぼ比例するため（1x/2x/4x で 25/46/94 になることをスモークテストで確認）、
   * マーカーの画面上の平均辺長 [px] で割って解像度非依存にしてある。
   * 目安: きれいな検出で 0.0x、崩れた四角形で 1 前後。
   * 呼び出し側でこれを閾値に検出結果を足切りする想定
   */
  error: number;
};

export interface MarkerDetector {
  /**
   * @param image 検出にかけるフレーム
   * @param focalLengthPx カメラの焦点距離 [px]。ブラウザから内部パラメータは
   *   取得できないため、レンズの水平 FOV から (幅/2)/tan(FOV/2) で換算した推定値を渡す
   */
  detect(image: ImageData, focalLengthPx: number): MarkerObservation[];
}

// POSIT は姿勢計算不能時（平面 POSIT の2解のうちモデル点がカメラ背後に回る枝）に
// error=-1・空の回転・空の並進を返し、しかも誤差比較で -1 が必ず勝つため
// 「無効な best + 有効な alternative」という並びになる（Node で再現確認済み。
// 空配列を信じると行列が NaN になり、lerp では二度と回復しない）。
// error>=0 かつ回転・並進の全要素が有限のものだけを姿勢として信用する
function pickValidPose(
  error: number,
  rotation: number[][],
  translation: number[],
): { error: number; r: number[][]; t: number[] } | null {
  const rOk =
    rotation.length === 3 &&
    rotation.every((row) => row.length === 3 && row.every(Number.isFinite));
  const tOk = translation.length === 3 && translation.every(Number.isFinite);
  return error >= 0 && rOk && tOk
    ? { error, r: rotation, t: translation }
    : null;
}

/**
 * @param markerSizeM マーカー（黒い正方形）の一辺の実寸 [m]。姿勢の並進のスケールを決める
 */
export function createMarkerDetector(markerSizeM: number): MarkerDetector {
  // 既定辞書 ARUCO_MIP_36h12（誤検出耐性が高い、js-aruco2 の推奨辞書）。
  // 許容ハミング距離の既定は辞書の tau(=12/36bit) で、テストパターンでも
  // 偽 ID を拾うほど緩い（Node でのスモークテストで確認）。4 まで絞る
  const detector = new AR.Detector({ maxHammingDistance: 4 });
  // Posit は (マーカー実寸, 焦点距離) 固定のインスタンスなので、焦点距離が変わったら作り直す
  // （デバイス回転で映像サイズが入れ替わると焦点距離の px 換算も変わる）
  let posit: InstanceType<typeof POS.Posit> | null = null;
  let positFocal = 0;

  return {
    detect(image, focalLengthPx) {
      const markers = detector.detect(image);
      if (markers.length === 0) return [];
      if (!posit || positFocal !== focalLengthPx) {
        posit = new POS.Posit(markerSizeM, focalLengthPx);
        positFocal = focalLengthPx;
      }
      const observations: MarkerObservation[] = [];
      for (const marker of markers) {
        // POSIT は「画像中心原点・Y 上」の座標系で角を受け取る（画像は左上原点・Y 下）
        const centered = marker.corners.map((c) => ({
          x: c.x - image.width / 2,
          y: image.height / 2 - c.y,
        }));
        const pose = posit.pose(centered);
        // best が無効なら alternative を試し、両方無効ならこの観測は返さない
        // （pickValidPose のコメント参照）
        const valid =
          pickValidPose(
            pose.bestError,
            pose.bestRotation,
            pose.bestTranslation,
          ) ??
          pickValidPose(
            pose.alternativeError,
            pose.alternativeRotation,
            pose.alternativeTranslation,
          );
        if (!valid) continue;
        const { r, t } = valid;
        // POSIT のカメラ座標系は +Z が前方（奥）、three.js は -Z が前方。
        // F=diag(1,1,-1) で M = F・[R|t]・F と挟んで変換する（行3・列3の符号反転。
        // 右手系のまま保たれ、マーカー面の +Z が視点側を向くローカル系になる）
        const matrix = new THREE.Matrix4().set(
          r[0][0],
          r[0][1],
          -r[0][2],
          t[0],
          r[1][0],
          r[1][1],
          -r[1][2],
          t[1],
          -r[2][0],
          -r[2][1],
          r[2][2],
          -t[2],
          0,
          0,
          0,
          1,
        );
        // 正規化誤差: ピクセル和 ÷ マーカーの画面上の平均辺長（型コメント参照）
        let perimeter = 0;
        for (let i = 0; i < 4; i++) {
          const a = marker.corners[i];
          const b = marker.corners[(i + 1) % 4];
          perimeter += Math.hypot(b.x - a.x, b.y - a.y);
        }
        const sidePx = perimeter / 4;
        observations.push({
          id: marker.id,
          corners: marker.corners,
          matrix,
          error: sidePx > 0 ? valid.error / sidePx : Infinity,
        });
      }
      return observations;
    },
  };
}
