// 段階 3 の C: 他人用の化身の「背中からビヨーンと出る」見え方の設定（鏡・ゴーグルの相手・俯瞰画面で共通。URL で変えられる）。
// 数値の既定はコンタクトシート（scripts/sweep-keshin-look.mjs → logs/keshin-check/look-sweep.png）で比べた候補。確定は方針側
import { numParam, params } from "../../src/shared/url-params";

export type KeshinLook = {
  /** 化身の腰（溶けた下端）を本人の頭よりこれだけ上に置く [m]（?waistAboveHeadM=） */
  waistAboveHeadM: number;
  /** 上半身の前面から本人の頭の中心までの間隔 [m]（?backClearM=。背中からの距離 = 前面 × 拡大率 + これ。?keshinBack= を指定すればそちらが優先） */
  backClearM: number;
  /** 腰から上のこの長さ [m] を、下へ行くほど透明にして光に溶かす（?dissolveM=。0 で切り口のまま） */
  dissolveM: number;
  /** 背中からの光の流れの太さ: 背中側・腰側の半径 [m]（?streamR0= / ?streamR1=） */
  streamR0: number;
  streamR1: number;
  /** 光の流れの明るさ（?streamK=。0 で出さない） */
  streamK: number;
  /** 光の流れの粒の数（?streamN=） */
  streamN: number;
  /** 足元の柱（今のオーラ）の強さの倍率（?footAuraK=。背中からの流れに置き換えるので控えめ） */
  footAuraK: number;
};

/**
 * 見え方の既定（look-sweep.png を見て方針側が決めた）。L2（腰 +0.5 / 間隔 0.7）は頭の上に浮いて見えたので、
 * 人に近い L1 の位置（+0.3 / 0.4）に溶ける長さ 0.6 を合わせた。人に重なる分は人の形で隠す処理（骨格の形でも可）に任せる。
 * 光の流れは根元が頭の周りで後光のように光ったので少し暗くする
 */
export const DEFAULT_LOOK: KeshinLook = {
  waistAboveHeadM: 0.3,
  backClearM: 0.4,
  dissolveM: 0.6,
  streamR0: 0.07,
  streamR1: 0.32,
  streamK: 0.7,
  streamN: 90,
  footAuraK: 0.3,
};

/** URL から読む。?look=0 で段階 2 までの見え方（腰で切る・頭の高さ・光の流れなし）に戻す（比較用） → null */
export function lookFromParams(): KeshinLook | null {
  if (params.get("look") === "0") return null;
  return {
    waistAboveHeadM: numParam("waistAboveHeadM", DEFAULT_LOOK.waistAboveHeadM, { min: -3, max: 5 }),
    backClearM: numParam("backClearM", DEFAULT_LOOK.backClearM, { min: -2, max: 5 }),
    dissolveM: numParam("dissolveM", DEFAULT_LOOK.dissolveM, { min: 0, max: 3 }),
    streamR0: numParam("streamR0", DEFAULT_LOOK.streamR0, { min: 0, max: 2 }),
    streamR1: numParam("streamR1", DEFAULT_LOOK.streamR1, { min: 0, max: 3 }),
    streamK: numParam("streamK", DEFAULT_LOOK.streamK, { min: 0, max: 5 }),
    streamN: Math.round(numParam("streamN", DEFAULT_LOOK.streamN, { min: 0, max: 2000 })),
    footAuraK: numParam("footAuraK", DEFAULT_LOOK.footAuraK, { min: 0, max: 1 }),
  };
}

/** 起動時のログ・HUD 用 */
export function describeLook(l: KeshinLook | null): string {
  if (!l) return "look=0";
  return `look waistAbove=${l.waistAboveHeadM} backClear=${l.backClearM} dissolve=${l.dissolveM} stream=${l.streamR0}/${l.streamR1}xK${l.streamK} footAura=${l.footAuraK}`;
}
