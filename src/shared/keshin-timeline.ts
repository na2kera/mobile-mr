// ex9-1-keshin（化身）の出現・消去の演出の時刻表。クライアント（demos/ex9-1-keshin）とサーバー（server/keshin.ts）の
// 両方から import する（サーバーは途中反転のときの開始時刻のずらしを同じ式で計算して全員に配る）。
// 見え方は「ステージ（出現 / 消去）の開始からの経過時間 t」だけで決まる純粋関数で、隠れた状態を持たない
// （教訓 4: 状態を持つアニメは途中入室・再接続・連打で端末ごとにずれる）。
//
// 見え方の軸は「出現の進み具合 u」（0 = 消えている 〜 APPEAR_SEC = 出切った）1 本にまとめ、
//   出現: u = t（APPEAR_SEC で止まる）
//   消去: u = APPEAR_SEC − t × (APPEAR_SEC / VANISH_SEC)（出現の逆再生を VANISH_SEC に縮めたもの）
// とする。途中で反転（消えている途中で出す等）したときは、新しいステージの開始時刻を「いまの u と同じ u になる時刻」に
// ずらす（elapsedForProgress）。これで反転の瞬間に見え方が飛ばない。
// three.js に依存させない（Node のテスト scripts/test-keshin.mjs とサーバーから import するため）

/** 出現の長さ [s] */
export const APPEAR_SEC = 1.5;
/** 消去の長さ [s]（出現の逆再生を縮めたもの） */
export const VANISH_SEC = 1.0;
/** せり上がりの距離 [m]（化身が下からこれだけ上がってくる。クリッピング平面は腰で固定なので「腰から生えてくる」） */
export const RISE_M = 1.0;
/** オーラが出切ったあとも揺らめき続ける強さ（出現の途中は 1 まで吹き上がる） */
export const AURA_SUSTAIN = 0.65;

export type KeshinMode = "appear" | "vanish";

export type KeshinVisual = {
  /** 出現の進み具合 [s]（0 = 消えている 〜 APPEAR_SEC = 出切った） */
  u: number;
  /** オーラ（足元の柱・腰の渦・視界の周り）の強さ 0..1 */
  auraK: number;
  /** オーラの柱が足元からどこまで伸びたか 0..1（0〜0.4s で吹き上がる） */
  pillarK: number;
  /** 吹き上がりの勢い 0..1（粒子の速さ・明るさを上乗せする） */
  burstK: number;
  /** せり上がりのずれ [m]（−RISE_M 〜 0） */
  riseM: number;
  /** 不透明度の係数 0..1（既定の不透明度に掛ける） */
  opacityK: number;
  /** 決めポーズの進み具合 0..1 */
  poseK: number;
  /** 何も描かなくてよい（消え切っている） */
  hidden: boolean;
};

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
/** 0..1 の区間 [a, b] での線形の進み */
const lin = (x: number, a: number, b: number) => clamp01((x - a) / (b - a));
const smooth = (x: number) => x * x * (3 - 2 * x);
const easeOutCubic = (x: number) => 1 - (1 - x) ** 3;

/** ステージの経過時間 t [s] → 出現の進み具合 u [s] */
export function progressOf(t: number, mode: KeshinMode): number {
  const tt = Number.isFinite(t) ? Math.max(0, t) : Infinity;
  if (mode === "appear") return Math.min(APPEAR_SEC, tt);
  return Math.max(0, APPEAR_SEC - tt * (APPEAR_SEC / VANISH_SEC));
}

/** 進み具合 u になるステージの経過時間 [s]（progressOf の逆） */
export function elapsedForProgress(u: number, mode: KeshinMode): number {
  const uu = Math.min(APPEAR_SEC, Math.max(0, u));
  return mode === "appear" ? uu : ((APPEAR_SEC - uu) * VANISH_SEC) / APPEAR_SEC;
}

/**
 * 途中反転: いまのステージ（prevMode を prevElapsed [s] 進めたところ）から newMode に切り替えるとき、
 * 見え方が連続になる新しいステージの経過時間 [s]（= 開始時刻をこれだけ過去にずらす）
 */
export function retargetElapsed(prevMode: KeshinMode, prevElapsed: number, newMode: KeshinMode): number {
  return elapsedForProgress(progressOf(prevElapsed, prevMode), newMode);
}

/** 出現の進み具合 u [s] → 見え方 */
export function visualAt(u: number): KeshinVisual {
  const x = Math.min(APPEAR_SEC, Math.max(0, u));
  // 1. 0〜0.4s: 足元〜腰に光の粒とオーラの柱が吹き上がる（その後は AURA_SUSTAIN でゆっくり揺らめき続ける）
  const pillarK = easeOutCubic(lin(x, 0, 0.4));
  const auraK = x <= 0.4 ? easeOutCubic(lin(x, 0, 0.4)) : 1 - (1 - AURA_SUSTAIN) * smooth(lin(x, 0.4, APPEAR_SEC));
  const burstK = smooth(lin(x, 0, 0.1)) * (1 - smooth(lin(x, 0.35, 0.9)));
  // 2. 0.3〜1.1s: 下から RISE_M せり上がりながら不透明度 0 → 1
  const riseK = lin(x, 0.3, 1.1);
  const riseM = -RISE_M * (1 - easeOutCubic(riseK));
  const opacityK = smooth(riseK);
  // 3. 1.0〜1.5s: 決めポーズ
  const poseK = lin(x, 1.0, APPEAR_SEC);
  return { u: x, auraK, pillarK, burstK, riseM, opacityK, poseK, hidden: x <= 0 };
}

/** ステージの経過時間 t [s] → 見え方（keshinTimeline(t, mode) = visualAt(progressOf(t, mode))） */
export function keshinTimeline(t: number, mode: KeshinMode): KeshinVisual {
  return visualAt(progressOf(t, mode));
}
