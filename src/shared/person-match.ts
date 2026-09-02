// Phase 9: 「カメラに映っている人」と「ネットワーク上の Player」の対応づけ（Spatial Matching）。
// 顔認識は使わない（CONCEPT.md Phase 9）。自分のカメラ座標系で、検出した人の頭の位置と、
// ピアが申告してきた頭の位置（マーカー座標系 → 自分のカメラ座標系に変換済み）を比べ、
// 「視線方向のずれ（角度）」と「距離のずれ」の両方が許容内の組だけを 1 対 1 で採用する。
// 角度を主にするのは、深度（カメラからの距離）は MediaPipe の実寸申告と FOV の仮定に依存して粗い一方、
// 画像上の方向は正確なため（hand-math.ts の placeLandmarks と同じ理由）。
// 比較する頭の位置はどちらも「実カメラの FOV で解いた」座標（表示用の FOV ではない。main.ts の applyPoseResult 参照）。
// three.js に依存させない（Node の回帰テスト scripts/test-person.mjs から import する）
import type { Vec3 } from "./hand-math.ts";

export type MatchCandidate = {
  id: string;
  /** 頭の位置（自分のカメラ座標系。x 右・y 上・z 手前 = 負） */
  pos: Vec3;
};

export type MatchOptions = {
  /** 視線方向のずれの許容 [rad] */
  angleTolRad: number;
  /** カメラからの距離のずれの許容 [m] */
  depthTolM: number;
  /**
   * いま付いている id を維持する側に働く二次コスト（正規化コストの単位。省略時 0.25）。
   * 2 人のピアが両方許容内にいるとき、わずかなコスト差で名札が入れ替わるのを防ぐ
   */
  keepBonus?: number;
};

export type MatchResult = {
  id: string;
  angleRad: number;
  depthDiffM: number;
  /** 角度・距離をそれぞれの許容で正規化した和（小さいほど良い。採用条件はそれぞれが 1 以下） */
  cost: number;
};

function len(v: Vec3): number {
  return Math.hypot(v.x, v.y, v.z);
}

/** 2 つの位置ベクトル（カメラ原点から）のなす角 [rad] */
export function angleBetween(a: Vec3, b: Vec3): number {
  const la = len(a);
  const lb = len(b);
  if (la < 1e-9 || lb < 1e-9) return Math.PI;
  const c = (a.x * b.x + a.y * b.y + a.z * b.z) / (la * lb);
  return Math.acos(Math.min(1, Math.max(-1, c)));
}

/**
 * 検出した人（key で識別）とピアを 1 対 1 で対応づける。
 * 許容内の組の中で「対応する組の数が最大」→「その中で総コストが最小」の割当を全探索で選ぶ
 * （検出 ≤ 4 人 × ピア ≤ 7 人なので探索は数百通り。貪欲だと局所最小が別の検出の唯一の候補を奪う）。
 * currentIds を渡すと、いま付いている id と同じ組のコストを keepBonus だけ下げる。
 * カメラの後ろにいるピア（角度が 90° を超える）は許容内に入らないので自然に除外される
 */
export function matchPersons<K>(
  detected: readonly { key: K; pos: Vec3 }[],
  peers: readonly MatchCandidate[],
  opts: MatchOptions,
  currentIds?: ReadonlyMap<K, string | null>,
): Map<K, MatchResult> {
  const keepBonus = opts.keepBonus ?? 0.25;
  // 検出ごとの許容内の候補
  const options: { result: MatchResult; effective: number }[][] = detected.map((d) => {
    const dd = len(d.pos);
    const cur = currentIds?.get(d.key) ?? null;
    const out: { result: MatchResult; effective: number }[] = [];
    for (const p of peers) {
      const angleRad = angleBetween(d.pos, p.pos);
      const depthDiffM = Math.abs(dd - len(p.pos));
      if (angleRad > opts.angleTolRad || depthDiffM > opts.depthTolM) continue;
      const cost = angleRad / opts.angleTolRad + depthDiffM / opts.depthTolM;
      out.push({ result: { id: p.id, angleRad, depthDiffM, cost }, effective: cost - (p.id === cur ? keepBonus : 0) });
    }
    return out;
  });
  let bestCount = -1;
  let bestCost = Infinity;
  let best: (MatchResult | null)[] = [];
  const chosen: (MatchResult | null)[] = new Array(detected.length).fill(null);
  const usedIds = new Set<string>();
  const search = (i: number, count: number, cost: number) => {
    if (i === detected.length) {
      if (count > bestCount || (count === bestCount && cost < bestCost)) {
        bestCount = count;
        bestCost = cost;
        best = [...chosen];
      }
      return;
    }
    // 残り全部が対応しても現在の最良に届かないなら打ち切り
    if (count + (detected.length - i) < bestCount) return;
    for (const o of options[i]) {
      if (usedIds.has(o.result.id)) continue;
      usedIds.add(o.result.id);
      chosen[i] = o.result;
      search(i + 1, count + 1, cost + o.effective);
      usedIds.delete(o.result.id);
    }
    chosen[i] = null;
    search(i + 1, count, cost);
  };
  search(0, 0, 0);
  const out = new Map<K, MatchResult>();
  for (const [i, r] of best.entries()) if (r) out.set(detected[i].key, r);
  return out;
}

// ---- フレームをまたぐ追跡（人のスロット）と、対応づけのヒステリシス ----

export type PersonDetection = {
  /** 表示用の 33 点（カメラ座標系。表示 FOV の視線に沿って置いたもの。背景の人に重なる） */
  points: Vec3[];
  /** 頭の位置（カメラ座標系。実カメラの FOV で置いたもの。追跡・対応づけ・seen に使う） */
  head: Vec3;
  /** 表示用の頭の位置（名札と線の位置に使う） */
  displayHead: Vec3;
  depth: number;
  residual: number;
  /** 解くのに使った可視点の数 */
  used: number;
};

export type PersonTrack = {
  key: number;
  /** 平滑化した表示用の 33 点（カメラ座標系）。未検出なら null */
  points: Vec3[] | null;
  /** 平滑化した頭の位置（実カメラ基準） */
  head: Vec3;
  /** 平滑化した表示用の頭の位置 */
  displayHead: Vec3;
  lastSeenMs: number;
  /** 直近の apply（推論）で検出があったか。false は lostMs 以内の保持中（骨格は最後の位置で凍結） */
  fresh: boolean;
  depth: number;
  residual: number;
  used: number;
  /** 対応づいた Player ID（ヒステリシス後）。未対応は null */
  id: string | null;
  /** id がいまの値になった時刻 [ms] */
  idSinceMs: number;
  /** 切り替え候補と、それが連続で最良だった回数 */
  candidate: string | null;
  candidateStreak: number;
  /** id に対する直近の対応結果（HUD 用）と、その時刻 */
  lastMatch: MatchResult | null;
  lastMatchMs: number;
};

export type PersonTracksOptions = {
  maxTracks: number;
  /** EMA 係数（1 で平滑化なし） */
  smooth: number;
  /** この時間検出が無ければ追跡を捨てる [ms] */
  lostMs: number;
  /** 追跡の継続判定: 前回の頭の位置からの距離 [m] がこれ以下なら同じ人 */
  trackDistM: number;
  /** 対応が取れなくなってから id を外すまでの猶予 [ms]（ピアの pose が一瞬途切れても名札が消えない） */
  idHoldMs: number;
  /** 別の id に切り替えるのに必要な連続回数（検出フレーム単位） */
  idStreak: number;
  /** matchPersons の keepBonus（省略時はそちらの既定） */
  keepBonus?: number;
};

export class PersonTracks {
  readonly tracks: PersonTrack[] = [];
  private readonly opts: PersonTracksOptions;
  private nextKey = 1;

  constructor(opts: PersonTracksOptions) {
    this.opts = opts;
  }

  /** いま見えている追跡（lostMs 以内の保持中を含む。表示用） */
  live(now: number): PersonTrack[] {
    return this.tracks.filter((t) => t.points !== null && now - t.lastSeenMs <= this.opts.lostMs);
  }

  /** 直近の推論で実際に検出された追跡（seen の送信用。保持中の凍結した骨格は含めない） */
  detected(now: number): PersonTrack[] {
    return this.live(now).filter((t) => t.fresh);
  }

  /** ロスト処理。毎フレーム呼ぶ */
  update(now: number) {
    for (let i = this.tracks.length - 1; i >= 0; i--) {
      if (now - this.tracks[i].lastSeenMs > this.opts.lostMs) this.tracks.splice(i, 1);
    }
  }

  /**
   * 推論結果を取り込む。頭の位置の近さで「同じ人の続き」を組み、続きなら EMA、新規なら追跡を作る。
   * maxTracks を超える検出は捨てる。呼ばれるたびに、更新されなかった追跡は fresh=false になる
   */
  apply(detections: readonly PersonDetection[], now: number) {
    const o = this.opts;
    for (const t of this.tracks) t.fresh = false;
    const live = this.live(now);
    const pairs: { track: PersonTrack; det: PersonDetection; dist: number }[] = [];
    for (const track of live) {
      for (const det of detections) {
        pairs.push({ track, det, dist: dist3(track.head, det.head) });
      }
    }
    pairs.sort((a, b) => a.dist - b.dist);
    const assigned = new Map<PersonTrack, PersonDetection>();
    const taken = new Set<PersonDetection>();
    for (const { track, det, dist } of pairs) {
      if (dist > o.trackDistM) break;
      if (assigned.has(track) || taken.has(det)) continue;
      assigned.set(track, det);
      taken.add(det);
    }
    for (const [track, det] of assigned) this.updateTrack(track, det, now, true);
    for (const det of detections) {
      if (taken.has(det)) continue;
      if (this.live(now).length >= o.maxTracks) break;
      const track: PersonTrack = {
        key: this.nextKey++,
        points: null,
        head: { ...det.head },
        displayHead: { ...det.displayHead },
        lastSeenMs: now,
        fresh: true,
        depth: det.depth,
        residual: det.residual,
        used: det.used,
        id: null,
        idSinceMs: now,
        candidate: null,
        candidateStreak: 0,
        lastMatch: null,
        lastMatchMs: -Infinity,
      };
      this.tracks.push(track);
      this.updateTrack(track, det, now, false);
    }
  }

  private updateTrack(track: PersonTrack, det: PersonDetection, now: number, continuing: boolean) {
    const o = this.opts;
    if (continuing && track.points) {
      for (let k = 0; k < track.points.length && k < det.points.length; k++) {
        const e = track.points[k];
        e.x += (det.points[k].x - e.x) * o.smooth;
        e.y += (det.points[k].y - e.y) * o.smooth;
        e.z += (det.points[k].z - e.z) * o.smooth;
      }
      lerpInto(track.head, det.head, o.smooth);
      lerpInto(track.displayHead, det.displayHead, o.smooth);
    } else {
      track.points = det.points.map((p) => ({ ...p }));
      track.head = { ...det.head };
      track.displayHead = { ...det.displayHead };
    }
    track.depth = det.depth;
    track.residual = det.residual;
    track.used = det.used;
    track.lastSeenMs = now;
    track.fresh = true;
  }

  /**
   * ピアとの対応づけを 1 回（検出フレームごとに）行い、ヒステリシス付きで id を更新する。
   * - 直近の推論で検出された追跡（fresh）だけが対応の対象。保持中の凍結した追跡は候補を進めない
   *   （人が画面から消えたあとの空フレームで、凍結した骨格に別の id が付くのを防ぐ）
   * - 同じ id が最良なら維持
   * - 別の id が idStreak 回連続で最良なら切り替え
   * - 対応が取れない状態が idHoldMs 続いたら id を外す（保持中の追跡も同じ）
   * - 同じ id を 2 つの追跡が持ったら、対応が新しい方に残す
   */
  match(peers: readonly MatchCandidate[], now: number, opts: MatchOptions) {
    const live = this.live(now);
    const fresh = live.filter((t) => t.fresh);
    const currentIds = new Map<number, string | null>(fresh.map((t) => [t.key, t.id]));
    const results = matchPersons(
      fresh.map((t) => ({ key: t.key, pos: t.head })),
      peers,
      { ...opts, keepBonus: opts.keepBonus ?? this.opts.keepBonus },
      currentIds,
    );
    for (const track of live) {
      const r = track.fresh ? results.get(track.key) : undefined;
      if (r && r.id === track.id) {
        track.lastMatch = r;
        track.lastMatchMs = now;
        track.candidate = null;
        track.candidateStreak = 0;
        continue;
      }
      if (r) {
        if (r.id === track.candidate) track.candidateStreak++;
        else {
          track.candidate = r.id;
          track.candidateStreak = 1;
        }
        if (track.candidateStreak >= this.opts.idStreak) {
          track.id = r.id;
          track.idSinceMs = now;
          track.lastMatch = r;
          track.lastMatchMs = now;
          track.candidate = null;
          track.candidateStreak = 0;
        }
        continue;
      }
      if (track.fresh) {
        track.candidate = null;
        track.candidateStreak = 0;
      }
      if (track.id !== null && now - track.lastMatchMs > this.opts.idHoldMs) {
        track.id = null;
        track.idSinceMs = now;
        track.lastMatch = null;
      }
    }
    // 一意性: 同じ id は対応が新しい追跡だけに残す
    const byId = new Map<string, PersonTrack>();
    for (const track of live) {
      if (track.id === null) continue;
      const other = byId.get(track.id);
      if (!other) {
        byId.set(track.id, track);
        continue;
      }
      const loser = other.lastMatchMs <= track.lastMatchMs ? other : track;
      loser.id = null;
      loser.idSinceMs = now;
      loser.lastMatch = null;
      if (loser === other) byId.set(track.id, track);
    }
  }
}

function lerpInto(target: Vec3, v: Vec3, k: number) {
  target.x += (v.x - target.x) * k;
  target.y += (v.y - target.y) * k;
  target.z += (v.z - target.z) * k;
}

function dist3(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
