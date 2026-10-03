// 段階 3 の C: 他人用の化身の「背中からビヨーンと出る」見え方の設定（鏡・ゴーグルの相手・俯瞰画面で共通。URL で変えられる）。
// 数値の既定はコンタクトシート（scripts/sweep-keshin-look.mjs → logs/keshin-check/look-sweep.png）で比べた候補。確定は方針側
import { numParam, params } from "../../src/shared/url-params";

export type KeshinLook = {
  /** 化身の腰（溶けた下端）を本人の頭よりこれだけ上に置く [m]（?waistAboveHeadM=） */
  waistAboveHeadM: number;
  /**
   * 腰の支点（頭 + waistAboveHeadM）より下へ、化身の体をこれだけ [m] 見せる（?showBelowM=）。切り口（溶ける範囲の下端）を下げるだけで
   * 化身の位置は変えない（体が下へ伸びる）。null = 化身ごとの既定（KESHIN_SPECS の below.showM）。URL で指定したときだけ全員を上書きする
   */
  showBelowM: number | null;
  /** 上半身の前面から本人の頭の中心までの間隔 [m]（?backClearM=。背中からの距離 = 前面 × 拡大率 + これ。?keshinBack= を指定すればそちらが優先） */
  backClearM: number;
  /**
   * 切り口から上のこの長さ [m] を、下へ行くほど透明にして光に溶かす（?dissolveM=。0 で切り口のまま）。
   * null = 化身ごとの既定（KESHIN_SPECS の below.dissolveM）。URL で指定したときだけ全員を上書きする
   */
  dissolveM: number | null;
  /** 背中からの光の流れの太さ: 背中側・腰側の半径 [m]（?streamR0= / ?streamR1=） */
  streamR0: number;
  streamR1: number;
  /** 光の流れの明るさ（?streamK=。0 で出さない） */
  streamK: number;
  /** 光の流れの粒の数（?streamN=） */
  streamN: number;
  /**
   * 光の流れを、人の形の縁からこの幅（人の形のマスクの横幅に対する割合。?streamClear=。0 で従来どおり）まで薄くする。
   * 流れは頭の真後ろを上るので、人の形で隠すと頭のまわりに明るい輪（縁取り）として残ったため
   */
  streamClear: number;
  /**
   * 足元から背中まで立ち上る柱の粒の強さの倍率（?footAuraK=）。既定 0（出さない）: 人の形で隠すと人のまわりのオーラが人型の穴に
   * なって見えたため、背中からの光の流れと化身の切り口から上の逆三角形の炎に置き換えた。炎の形には影響しない
   */
  footAuraK: number;
};

/**
 * 見え方の既定（look-sweep.png を見て方針側が決めた）。L2（腰 +0.5 / 間隔 0.7）は頭の上に浮いて見えたので、
 * 人に近い L1 の位置（+0.3 / 0.4）に溶ける長さ 0.6 を合わせた。人に重なる分は人の形で隠す処理（骨格の形でも可）に任せる。
 * 光の流れは根元が頭の周りで後光のように光ったので少し暗くする。
 * 切り口を下げる長さと溶ける長さは化身ごとの既定（keshin-assets.ts の KESHIN_SPECS の below）。全員共通の値では、マエストロの下段の腕を
 * 見せると魔神の胴の底（cutY で終わる蓋）が平らな切り口として出て両立しないため。ここでは null（= 化身ごと）
 */
export const DEFAULT_LOOK: KeshinLook = {
  waistAboveHeadM: 0.3,
  showBelowM: null,
  backClearM: 0.4,
  dissolveM: null,
  streamR0: 0.07,
  streamR1: 0.32,
  streamK: 0.7,
  streamN: 90,
  streamClear: 0.04,
  footAuraK: 0,
};

/** URL から読む。?look=0 で段階 2 までの見え方（腰で切る・頭の高さ・光の流れなし）に戻す（比較用） → null */
export function lookFromParams(): KeshinLook | null {
  if (params.get("look") === "0") return null;
  return {
    waistAboveHeadM: numParam("waistAboveHeadM", DEFAULT_LOOK.waistAboveHeadM, { min: -3, max: 5 }),
    showBelowM: overrideParam("showBelowM", 0, 3),
    backClearM: numParam("backClearM", DEFAULT_LOOK.backClearM, { min: -2, max: 5 }),
    dissolveM: overrideParam("dissolveM", 0, 3),
    streamR0: numParam("streamR0", DEFAULT_LOOK.streamR0, { min: 0, max: 2 }),
    streamR1: numParam("streamR1", DEFAULT_LOOK.streamR1, { min: 0, max: 3 }),
    streamK: numParam("streamK", DEFAULT_LOOK.streamK, { min: 0, max: 5 }),
    streamN: Math.round(numParam("streamN", DEFAULT_LOOK.streamN, { min: 0, max: 2000 })),
    streamClear: numParam("streamClear", DEFAULT_LOOK.streamClear, { min: 0, max: 0.3 }),
    footAuraK: numParam("footAuraK", DEFAULT_LOOK.footAuraK, { min: 0, max: 1 }),
  };
}

/** URL で明示されたときだけ値（空・範囲外・数値でなければ指定なし扱い。numParam は空文字を 0 と読むので先に弾く）。指定なし → null（化身ごとの既定） */
function overrideParam(name: string, min: number, max: number): number | null {
  if (!params.get(name)?.trim()) return null;
  const v = numParam(name, NaN, { min, max });
  return Number.isNaN(v) ? null : v;
}

/** 起動時のログ・HUD 用（showBelow / dissolve の spec = 化身ごとの既定） */
export function describeLook(l: KeshinLook | null): string {
  if (!l) return "look=0";
  return `look waistAbove=${l.waistAboveHeadM} showBelow=${l.showBelowM ?? "spec"} backClear=${l.backClearM} dissolve=${l.dissolveM ?? "spec"} stream=${l.streamR0}/${l.streamR1}xK${l.streamK}clear${l.streamClear} footAura=${l.footAuraK}`;
}
