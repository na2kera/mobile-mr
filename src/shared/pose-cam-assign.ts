// 08-8（PC カメラ + MediaPipe Pose）の「誰がどのプレイヤーか」の対応づけ。three.js に依存しない（Node の回帰テストから import する）。
// マーカーが無いので、入室した順に俯瞰画面で「次の人は手を挙げてください」→ 手を挙げた人物にその順のプレイヤーを割り当てる。
//   - 毎フレームの検出（位置 + 手を挙げているか）を、前フレームの人物（トラック）に位置の近さで対応づける（近い組から貪欲に。matchM 以内）
//   - 対応が付かない検出は新しい人物（未割当）。lostMs 見えなかった人物は消す（割当も外れる = 未割当に戻る）
//   - 未割当の人物が raiseHoldMs 続けて手を挙げたら、入室順で次のプレイヤー（まだ誰にも割り当たっていない最初の人）を割り当てる。
//     1 回の更新で 1 人だけ。直前の割当より前から挙げ続けていた手は数えない（同時に挙げた 2 人目が次のプレイヤーに流れ込まないように、
//     一度下ろして挙げ直してもらう）
import type { V3 } from "./surface.ts";

export type AssignerOptions = {
  /** 前フレームの位置からこの距離 [m] 以内の検出だけ同じ人物とみなす */
  matchM: number;
  /** これだけ見えなかった人物は消す（割当も外れる）[ms] */
  lostMs: number;
  /** 手を挙げ続けてからこの時間で割り当てる [ms]（一瞬の誤検出で割り当てない） */
  raiseHoldMs: number;
};

export type PersonDetection = { pos: V3; raised: boolean };

export type PersonTrack<T extends PersonDetection> = {
  /** 人物の通し番号（表示用） */
  key: number;
  /** 直近の検出 */
  det: T;
  lastSeenMs: number;
  /** 割り当てたプレイヤー id（未割当なら null） */
  player: string | null;
  /** 手を挙げ始めた時刻（下ろしていれば null） */
  raisedSinceMs: number | null;
};

export type AssignEvent = { player: string; key: number };

export class PoseAssigner<T extends PersonDetection> {
  readonly tracks: PersonTrack<T>[] = [];
  private nextKey = 1;
  /** 直近に割り当てた時刻（これより前から挙げていた手は数えない） */
  private lastAssignMs = -Infinity;
  private readonly opts: AssignerOptions;

  constructor(opts: AssignerOptions) {
    this.opts = opts;
  }

  /**
   * 1 フレームぶんの検出で更新する。
   * @param players 入室順のプレイヤー id（全員。割当済みの人も含む）
   * @returns このフレームで新しく割り当てたもの（0 か 1 件）
   */
  update(detections: readonly T[], now: number, players: readonly string[]): AssignEvent[] {
    // 対応づけ: すべての組を距離の近い順に並べて貪欲に取る
    const pairs: { t: number; d: number; dist: number }[] = [];
    this.tracks.forEach((tr, ti) => {
      detections.forEach((det, di) => {
        const dist = Math.hypot(det.pos[0] - tr.det.pos[0], det.pos[1] - tr.det.pos[1], det.pos[2] - tr.det.pos[2]);
        if (dist <= this.opts.matchM) pairs.push({ t: ti, d: di, dist });
      });
    });
    pairs.sort((a, b) => a.dist - b.dist);
    const usedT = new Set<number>();
    const usedD = new Set<number>();
    for (const p of pairs) {
      if (usedT.has(p.t) || usedD.has(p.d)) continue;
      usedT.add(p.t);
      usedD.add(p.d);
      this.observe(this.tracks[p.t], detections[p.d], now);
    }
    detections.forEach((det, di) => {
      if (usedD.has(di)) return;
      const tr: PersonTrack<T> = { key: this.nextKey++, det, lastSeenMs: now, player: null, raisedSinceMs: det.raised ? now : null };
      this.tracks.push(tr);
    });
    // 見失い: lostMs を超えた人物は消す（割当も外れる）
    for (let i = this.tracks.length - 1; i >= 0; i--) {
      if (now - this.tracks[i].lastSeenMs > this.opts.lostMs) this.tracks.splice(i, 1);
    }
    // 居なくなったプレイヤーの割当を外す
    const present = new Set(players);
    for (const tr of this.tracks) if (tr.player !== null && !present.has(tr.player)) tr.player = null;
    // 割当: 次のプレイヤーが居て、未割当で手を挙げ続けている人物（直前の割当より後に挙げ始めた、一番早く挙げた人）
    const next = this.nextPlayer(players);
    if (next === null) return [];
    let best: PersonTrack<T> | null = null;
    for (const tr of this.tracks) {
      if (tr.player !== null || tr.raisedSinceMs === null || tr.lastSeenMs !== now) continue;
      if (tr.raisedSinceMs < this.lastAssignMs || now - tr.raisedSinceMs < this.opts.raiseHoldMs) continue;
      if (!best || tr.raisedSinceMs < best.raisedSinceMs!) best = tr;
    }
    if (!best) return [];
    best.player = next;
    this.lastAssignMs = now;
    return [{ player: next, key: best.key }];
  }

  /** 入室順で、まだ誰にも割り当たっていない最初のプレイヤー（居なければ null） */
  nextPlayer(players: readonly string[]): string | null {
    const assigned = new Set(this.tracks.map((t) => t.player).filter((p): p is string => p !== null));
    return players.find((p) => !assigned.has(p)) ?? null;
  }

  /** プレイヤーの人物（割当が無ければ null） */
  trackOf(player: string): PersonTrack<T> | null {
    return this.tracks.find((t) => t.player === player) ?? null;
  }

  /** 割当をやり直す（全員を未割当に戻す。人物の追跡は続ける）。いま挙げている手は数えない */
  reset(now: number) {
    for (const tr of this.tracks) tr.player = null;
    this.lastAssignMs = now;
  }

  /** プレイヤーの退室（その人物は未割当に戻る） */
  removePlayer(player: string) {
    for (const tr of this.tracks) if (tr.player === player) tr.player = null;
  }

  private observe(tr: PersonTrack<T>, det: T, now: number) {
    tr.det = det;
    tr.lastSeenMs = now;
    if (!det.raised) tr.raisedSinceMs = null;
    else if (tr.raisedSinceMs === null) tr.raisedSinceMs = now;
  }
}
