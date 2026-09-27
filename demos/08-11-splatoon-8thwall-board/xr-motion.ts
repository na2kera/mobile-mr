// 08-11: 8th Wall の姿勢からカメラの角速度を出す（three に依存しない純粋な計算。scripts/test-08-11-board.mjs から直接 import する）。
// 頭を速く回している間のマーカーの観測は、映像とカメラ姿勢の時刻ずれで同じ向きに偏りうるので窓平均に入れない（レビュー R7）。
// XR の世代（invalidate の回数）が変わった直後の最初の姿勢では、比べる前の姿勢が無いので角速度は「未測定」（null）にする。
// 以前は 0 として扱っていたため、高速回転中でも再ロックの 1 件目に使えてしまった（再レビュー S4）。未測定の観測は速い首振りと同じ扱い

export type AngularRateMeter = {
  /**
   * 新しい姿勢を渡す（同じ frameMs なら何もしない）。戻り値は角速度 [deg/s]、世代の最初の姿勢なら null（未測定）
   * @param generation XR の世代（invalidate で増える）
   * @param frameMs その姿勢を採用した時刻 [ms]
   * @param quat カメラの回転（x, y, z, w）
   */
  update(generation: number, frameMs: number, quat: readonly number[]): number | null;
  /** 直近の角速度 [deg/s]。未測定なら null */
  readonly value: number | null;
};

export function createAngularRateMeter(): AngularRateMeter {
  let lastGen = Number.NaN;
  let lastMs = Number.NaN;
  let lastQuat: number[] = [0, 0, 0, 1];
  let value: number | null = null;
  return {
    update(generation, frameMs, quat) {
      if (generation !== lastGen) {
        lastGen = generation;
        lastMs = frameMs;
        lastQuat = [quat[0], quat[1], quat[2], quat[3]];
        value = null;
        return value;
      }
      if (frameMs === lastMs) return value;
      const dt = (frameMs - lastMs) / 1000;
      const d = Math.abs(quat[0] * lastQuat[0] + quat[1] * lastQuat[1] + quat[2] * lastQuat[2] + quat[3] * lastQuat[3]);
      const deg = (2 * Math.acos(Math.min(1, d)) * 180) / Math.PI;
      value = dt > 0 ? deg / dt : value;
      lastMs = frameMs;
      lastQuat = [quat[0], quat[1], quat[2], quat[3]];
      return value;
    },
    get value() {
      return value;
    },
  };
}
