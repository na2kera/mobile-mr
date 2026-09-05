// スマホと俯瞰画面で共通の一打勝負の表示。サーバーが先に計算した終点を転がり中に見せない。
import type { GameSnapshot } from "./golf-game.ts";

export function scoreTotal(s: GameSnapshot, id: string): number {
  return (s.cards[id] ?? []).reduce((sum, points) => sum + points, 0);
}

export function shotLabel(s: GameSnapshot, id: string): string {
  const b = s.balls[id];
  if (!b) return "待機";
  if (s.phase === "rolling" && s.roll?.by === id) return "転がり中";
  if (b.distanceMm === null) {
    if (b.done && (s.phase === "roundResult" || s.phase === "result") && (s.cards[id]?.length ?? 0) === 0) return "次から参加";
    return b.done ? "時間切れ · 0点" : "未打";
  }
  const result = b.holed ? "カップイン！" : `残り ${(b.distanceMm / 1000).toFixed(3)}m`;
  return b.rank === null ? result : `${b.rank}位 · ${result} · +${s.cards[id]?.at(-1) ?? 0}点`;
}
