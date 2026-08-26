// URL クエリの数値パラメータ読み取り。02〜05 の各デモに複製されていた numParam の共通版
// （Phase 6 で抽出。署名は 03/04/05 の min/max 付きに統一する。
// PAIN_POINTS「パススルー + 開始フローのボイラープレートが 4 本目になり、numParam の署名が
// 2 種類に分岐した」参照）。02〜05 は過去のデモとして手を付けず、06 以降がこれを使う

export const params = new URLSearchParams(location.search);

/**
 * `?name=数値` を読む。未指定・数値でない・範囲外なら fallback。
 * min の既定が EPSILON なのは「0 や負数を弾く」ため（0 を許すパラメータは min: 0 を明示する）
 */
export function numParam(
  name: string,
  fallback: number,
  { min = Number.EPSILON, max = Infinity } = {},
): number {
  const v = Number(params.get(name) ?? NaN);
  return Number.isFinite(v) && v >= min && v <= max ? v : fallback;
}

/** `?name=WxH` 形式の解像度指定を読む（02〜05 の camRes と同じ形式） */
export function resolutionParam(
  name: string,
  fallback: [number, number],
): [number, number] {
  const parsed = (params.get(name) ?? "").split(/x/i).map(Number);
  return parsed.length === 2 &&
    parsed.every((v) => Number.isFinite(v) && v > 0)
    ? [parsed[0], parsed[1]]
    : fallback;
}
