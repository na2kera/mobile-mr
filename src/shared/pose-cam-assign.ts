// 08-8（PC カメラ + MediaPipe Pose）の「誰がどのプレイヤーか」の対応づけ。three.js に依存しない（Node の回帰テストから import する）。
// マーカーが無いので、入室した順に俯瞰画面で「次の人は手を挙げてください」→ 手を挙げた人物にその順のプレイヤーを割り当てる。
// 人物の見た目は区別できないので、取り違えるくらいなら割当を外して手を挙げ直してもらう（安全側。Codex / Fable レビューの指摘）:
//   1. 期限切れ（lostMs 見えなかった）の人物は、対応づけの**前**に消す（古い割当・挙手の状態が新しい検出に引き継がれない）
//   2. 割当済みの人物が reacquireMs を超えて見えなかったら、対応づけの前に割当を外す（戻ってきても自動では戻さない。手を挙げ直す）
//   3. 同じ人物の重複検出（位置が mergeM 以内）は 1 つにまとめる（可視性の合計 score が大きい方を残す）
//   4. 対応づけ: 各人物の「速度で予測した位置」と検出の距離が近い組から貪欲に取る。距離の上限は経過時間に比例
//      （matchM は 66ms あたりの基準）。対応が付かない検出は新しい人物（未割当）
//   5. 割当済みの 2 人が closeM 以内に近づいた・1 つの検出に融合した（片方が見えず、その予測が見えている方の検出の closeM 以内）ら、
//      両方を「要確認」（pending）にする（位置は送らない）。離れた（両方見えていて closeM 以上）ときに、要確認になる前の位置と速度から
//      予測した位置との距離で「そのまま」と「入れ替え」を比べ、そのままの方が swapMarginM 以上明確に近ければ続け、そうでなければ両方の割当を外す
//   6. 未割当の人物が raiseHoldMs 続けて手を挙げたら、入室順で次のプレイヤー（まだ誰にも割り当たっていない最初の人）を割り当てる。
//      1 回の更新で 1 人だけ。直前の割当より前から挙げ続けていた手は数えない（同時に挙げた 2 人目が次のプレイヤーに流れ込まないように、
//      一度下ろして挙げ直してもらう）
// 限界: 2 人が止まったまま完全に重なり、その間に左右を入れ替えて離れると、要確認になる前の位置からの予測では入れ替わりを検出できない
// （見た目で区別しないため）。すれ違い（速度がある）と、重なっている時間が reacquireMs を超える場合は外れる
import type { V3 } from "./surface.ts";

export type AssignerOptions = {
  /** 66ms あたりに同じ人物とみなす「予測位置との距離」[m]（経過時間に比例させて使う） */
  matchM: number;
  /** これだけ見えなかった人物は消す [ms] */
  lostMs: number;
  /** 手を挙げ続けてからこの時間で割り当てる [ms]（一瞬の誤検出で割り当てない） */
  raiseHoldMs: number;
  /** 割当済みの人物がこれを超えて見えなかったら割当を外す [ms]（既定 500） */
  reacquireMs?: number;
  /** 頭の位置がこれ以内の検出は同じ人物の重複としてまとめる [m]（既定 0.3） */
  mergeM?: number;
  /** 割当済みの 2 人がこれ以内に近づいたら要確認 [m]（既定 0.5） */
  closeM?: number;
  /** 要確認の解消: 「入れ替え」の予測誤差が「そのまま」よりこれ以上大きければ続ける [m]（既定 0.3） */
  swapMarginM?: number;
};

export type PersonDetection = { pos: V3; raised: boolean; score?: number };

export type PersonTrack<T extends PersonDetection> = {
  /** 人物の通し番号（表示用） */
  key: number;
  /** 直近の検出 */
  det: T;
  lastSeenMs: number;
  /** 速度 [m/ms]（予測用。見失いが reacquireMs を超えたら 0 から） */
  vel: V3;
  /** 割り当てたプレイヤー id（未割当なら null） */
  player: string | null;
  /** 手を挙げ始めた時刻（下ろしていれば null） */
  raisedSinceMs: number | null;
  /** 要確認（割当済みの別の人物と近づいた・融合した。位置を送らない） */
  pending: boolean;
};

export type AssignEvent =
  | { kind: "assigned"; player: string; key: number }
  /** 割当を外した（lost = reacquireMs を超えて見失った、ambiguous = 近づいた・重なった後に区別できなかった） */
  | { kind: "released"; player: string; key: number; reason: "lost" | "ambiguous" };

/** 基準の間隔 [ms]（matchM はこの間隔あたり） */
const MATCH_BASE_MS = 66;
/** 距離の上限の経過時間の下限 [ms]（間隔が短いときに上限が小さくなりすぎないように） */
const MATCH_MIN_MS = 33;

type Snapshot = { pos: V3; vel: V3; atMs: number };
type Pair<T extends PersonDetection> = { a: PersonTrack<T>; b: PersonTrack<T>; snapA: Snapshot; snapB: Snapshot };

export class PoseAssigner<T extends PersonDetection> {
  readonly tracks: PersonTrack<T>[] = [];
  private nextKey = 1;
  /** 直近に割り当てた時刻（これより前から挙げていた手は数えない） */
  private lastAssignMs = -Infinity;
  private readonly opts: Required<AssignerOptions>;
  /** 要確認の組 */
  private pairs: Pair<T>[] = [];

  constructor(opts: AssignerOptions) {
    this.opts = { reacquireMs: 500, mergeM: 0.3, closeM: 0.5, swapMarginM: 0.3, ...opts };
  }

  /**
   * 1 フレームぶんの検出で更新する。
   * @param players 入室順のプレイヤー id（全員。割当済みの人も含む）
   * @returns このフレームの割当（0 か 1 件）と割当の解除
   */
  update(detections: readonly T[], now: number, players: readonly string[]): AssignEvent[] {
    const o = this.opts;
    const events: AssignEvent[] = [];
    // 1. 期限切れの人物を先に消す（対応づけで古い人物が拾われないように）
    for (let i = this.tracks.length - 1; i >= 0; i--) {
      const tr = this.tracks[i];
      if (now - tr.lastSeenMs > o.lostMs) {
        this.releaseWithPartners(tr, events, "lost");
        this.tracks.splice(i, 1);
      }
    }
    // 居なくなったプレイヤーの割当を外す
    const present = new Set(players);
    for (const tr of this.tracks) if (tr.player !== null && !present.has(tr.player)) this.releaseWithPartners(tr, events, null);
    // 2. 見失いが reacquireMs を超えた割当を、対応づけの前に外す（戻ってきても自動では戻さない）。
    //    要確認の相手も外す（どちらが誰か分からないまま片方が消えたので）
    for (const tr of this.tracks) {
      if (tr.player === null || now - tr.lastSeenMs <= o.reacquireMs) continue;
      this.releaseWithPartners(tr, events, "lost");
    }
    // 3. 重複検出をまとめる
    const dets = dedupe(detections, o.mergeM);
    // 4. 予測位置との距離で対応づけ
    const pairs: { t: number; d: number; dist: number }[] = [];
    this.tracks.forEach((tr, ti) => {
      const dt = Math.min(now - tr.lastSeenMs, o.reacquireMs);
      const pred = predict(tr.det.pos, tr.vel, dt);
      const gate = (o.matchM * Math.max(dt, MATCH_MIN_MS)) / MATCH_BASE_MS;
      dets.forEach((det, di) => {
        const dist = distance(det.pos, pred);
        if (dist <= gate) pairs.push({ t: ti, d: di, dist });
      });
    });
    pairs.sort((a, b) => a.dist - b.dist);
    const usedT = new Set<number>();
    const usedD = new Set<number>();
    /** このフレームの観測の前の状態（要確認になった時点の予測に使う） */
    const before = new Map<PersonTrack<T>, Snapshot>();
    for (const tr of this.tracks) before.set(tr, { pos: tr.det.pos, vel: tr.vel, atMs: tr.lastSeenMs });
    for (const p of pairs) {
      if (usedT.has(p.t) || usedD.has(p.d)) continue;
      usedT.add(p.t);
      usedD.add(p.d);
      this.observe(this.tracks[p.t], dets[p.d], now);
    }
    dets.forEach((det, di) => {
      if (usedD.has(di)) return;
      this.tracks.push({ key: this.nextKey++, det, lastSeenMs: now, vel: [0, 0, 0], player: null, raisedSinceMs: det.raised ? now : null, pending: false });
    });
    // 5. 要確認: 既存の組を解消し、新しく近づいた・融合した組を足す
    this.resolvePairs(now, events);
    this.detectPairs(now, before);
    for (const tr of this.tracks) tr.pending = this.pairs.some((p) => p.a === tr || p.b === tr);
    // 6. 割当: 次のプレイヤーが居て、未割当で手を挙げ続けている人物（直前の割当より後に挙げ始めた、一番早く挙げた人）
    const next = this.nextPlayer(players);
    if (next === null) return events;
    let best: PersonTrack<T> | null = null;
    for (const tr of this.tracks) {
      if (tr.player !== null || tr.raisedSinceMs === null || tr.lastSeenMs !== now) continue;
      if (tr.raisedSinceMs < this.lastAssignMs || now - tr.raisedSinceMs < o.raiseHoldMs) continue;
      if (!best || tr.raisedSinceMs < best.raisedSinceMs!) best = tr;
    }
    if (!best) return events;
    best.player = next;
    this.lastAssignMs = now;
    events.push({ kind: "assigned", player: next, key: best.key });
    return events;
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
    for (const tr of this.tracks) this.release(tr);
    this.lastAssignMs = now;
  }

  /** プレイヤーの退室（その人物は未割当に戻る） */
  removePlayer(player: string) {
    for (const tr of this.tracks) if (tr.player === player) this.release(tr);
  }

  /**
   * 割当を外し（reason が null なら退室なのでイベントは出さない）、要確認の相手の割当も外す（相手がどちらの人物か分からないため）
   */
  private releaseWithPartners(tr: PersonTrack<T>, events: AssignEvent[], reason: "lost" | null) {
    if (tr.player !== null && reason !== null) events.push({ kind: "released", player: tr.player, key: tr.key, reason });
    const partners = this.pairs.map((p) => (p.a === tr ? p.b : p.b === tr ? p.a : null)).filter((p): p is PersonTrack<T> => p !== null);
    this.release(tr);
    for (const other of partners) {
      if (other.player === null) continue;
      events.push({ kind: "released", player: other.player, key: other.key, reason: "ambiguous" });
      this.release(other);
    }
  }

  /** 割当を外し、その人物を含む要確認の組を捨てる */
  private release(tr: PersonTrack<T>) {
    tr.player = null;
    tr.pending = false;
    this.pairs = this.pairs.filter((p) => p.a !== tr && p.b !== tr);
  }

  private observe(tr: PersonTrack<T>, det: T, now: number) {
    const dt = now - tr.lastSeenMs;
    if (dt > 0 && dt <= this.opts.reacquireMs) {
      // 速度は半分ずつ寄せる（検出の揺れで予測が跳ねないように）。上限は matchM / 66ms
      const maxV = this.opts.matchM / MATCH_BASE_MS;
      const raw = [0, 1, 2].map((i) => (det.pos[i] - tr.det.pos[i]) / dt);
      const v = raw.map((r, i) => 0.5 * r + 0.5 * tr.vel[i]);
      const len = Math.hypot(v[0], v[1], v[2]);
      const s = len > maxV ? maxV / len : 1;
      tr.vel = [v[0] * s, v[1] * s, v[2] * s];
    } else {
      tr.vel = [0, 0, 0];
    }
    tr.det = det;
    tr.lastSeenMs = now;
    if (!det.raised) tr.raisedSinceMs = null;
    else if (tr.raisedSinceMs === null) tr.raisedSinceMs = now;
  }

  /** 割当済みの組のうち、近づいた（両方見えていて closeM 以内）・融合した（片方だけ見えていて、見えない方の予測が closeM 以内）ものを要確認にする */
  private detectPairs(now: number, before: Map<PersonTrack<T>, Snapshot>) {
    const o = this.opts;
    const assigned = this.tracks.filter((t) => t.player !== null);
    for (let i = 0; i < assigned.length; i++) {
      for (let j = i + 1; j < assigned.length; j++) {
        const a = assigned[i];
        const b = assigned[j];
        if (this.pairs.some((p) => (p.a === a && p.b === b) || (p.a === b && p.b === a))) continue;
        const seenA = a.lastSeenMs === now;
        const seenB = b.lastSeenMs === now;
        let close = false;
        if (seenA && seenB) close = distance(a.det.pos, b.det.pos) < o.closeM;
        else if (seenA !== seenB) {
          const [seen, hidden] = seenA ? [a, b] : [b, a];
          close = distance(seen.det.pos, predict(hidden.det.pos, hidden.vel, Math.min(now - hidden.lastSeenMs, o.reacquireMs))) < o.closeM;
        }
        if (!close) continue;
        const snap = (t: PersonTrack<T>): Snapshot => before.get(t) ?? { pos: t.det.pos, vel: t.vel, atMs: t.lastSeenMs };
        this.pairs.push({ a, b, snapA: snap(a), snapB: snap(b) });
      }
    }
  }

  /** 要確認の組: 両方見えていて closeM 以上離れたら、予測との距離で「そのまま」か判定する（明確でなければ両方の割当を外す） */
  private resolvePairs(now: number, events: AssignEvent[]) {
    const o = this.opts;
    for (const pr of [...this.pairs]) {
      const { a, b } = pr;
      if (a.lastSeenMs !== now || b.lastSeenMs !== now) continue;
      if (distance(a.det.pos, b.det.pos) < o.closeM) continue;
      const predA = predict(pr.snapA.pos, pr.snapA.vel, Math.min(now - pr.snapA.atMs, o.reacquireMs));
      const predB = predict(pr.snapB.pos, pr.snapB.vel, Math.min(now - pr.snapB.atMs, o.reacquireMs));
      const keep = distance(predA, a.det.pos) + distance(predB, b.det.pos);
      const swap = distance(predA, b.det.pos) + distance(predB, a.det.pos);
      this.pairs = this.pairs.filter((p) => p !== pr);
      if (swap - keep >= o.swapMarginM) continue;
      for (const t of [a, b]) {
        if (t.player === null) continue;
        events.push({ kind: "released", player: t.player, key: t.key, reason: "ambiguous" });
        this.release(t);
      }
    }
  }
}

function distance(a: V3, b: V3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function predict(pos: V3, vel: V3, dtMs: number): V3 {
  return [pos[0] + vel[0] * dtMs, pos[1] + vel[1] * dtMs, pos[2] + vel[2] * dtMs];
}

/** 位置が mergeM 以内の検出を 1 つにまとめる（score の大きい方を残す。同じなら先の方） */
export function dedupe<T extends PersonDetection>(detections: readonly T[], mergeM: number): T[] {
  const order = detections.map((d, i) => ({ d, i })).sort((x, y) => (y.d.score ?? 0) - (x.d.score ?? 0) || x.i - y.i);
  const kept: T[] = [];
  for (const { d } of order) if (!kept.some((k) => distance(k.pos, d.pos) <= mergeM)) kept.push(d);
  return kept;
}
