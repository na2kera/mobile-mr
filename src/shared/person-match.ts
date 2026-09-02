// Phase 9: 「カメラに映っている人」と「ネットワーク上の Player」の対応づけ（Spatial Matching）。
// 顔認識は使わない（CONCEPT.md Phase 9）。自分のカメラ座標系で、検出した人の頭の位置と、
// ピアが申告してきた頭の位置（マーカー座標系 → 自分のカメラ座標系に変換済み）を比べ、
// 「視線方向のずれ（角度）」と「距離のずれ」の両方が許容内の組だけを、コストの小さい順に貪欲に 1 対 1 で採用する。
// 角度を主にするのは、深度（カメラからの距離）は MediaPipe の実寸申告と FOV の仮定に依存して粗い一方、
// 画像上の方向は正確なため（hand-math.ts の placeLandmarks と同じ理由）。
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
 * カメラの後ろにいるピア（角度が 90° を超える）は許容内に入らないので自然に除外される
 */
export function matchPersons<K>(
  detected: readonly { key: K; pos: Vec3 }[],
  peers: readonly MatchCandidate[],
  opts: MatchOptions,
): Map<K, MatchResult> {
  const pairs: { key: K; result: MatchResult }[] = [];
  for (const d of detected) {
    const dd = len(d.pos);
    for (const p of peers) {
      const angleRad = angleBetween(d.pos, p.pos);
      const depthDiffM = Math.abs(dd - len(p.pos));
      if (angleRad > opts.angleTolRad || depthDiffM > opts.depthTolM) continue;
      pairs.push({
        key: d.key,
        result: { id: p.id, angleRad, depthDiffM, cost: angleRad / opts.angleTolRad + depthDiffM / opts.depthTolM },
      });
    }
  }
  pairs.sort((a, b) => a.result.cost - b.result.cost);
  const out = new Map<K, MatchResult>();
  const usedIds = new Set<string>();
  for (const { key, result } of pairs) {
    if (out.has(key) || usedIds.has(result.id)) continue;
    out.set(key, result);
    usedIds.add(result.id);
  }
  return out;
}

// ---- フレームをまたぐ追跡（人のスロット）と、対応づけのヒステリシス ----

export type PersonDetection = {
  /** 33 点（カメラ座標系） */
  points: Vec3[];
  /** 頭の位置（カメラ座標系。body-math の bodyHeadPoint） */
  head: Vec3;
  depth: number;
  residual: number;
  /** 解くのに使った可視点の数 */
  used: number;
};

export type PersonTrack = {
  key: number;
  /** 平滑化した 33 点（カメラ座標系）。未検出なら null */
  points: Vec3[] | null;
  /** 平滑化した頭の位置 */
  head: Vec3;
  lastSeenMs: number;
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
};

export class PersonTracks {
  readonly tracks: PersonTrack[] = [];
  private readonly opts: PersonTracksOptions;
  private nextKey = 1;

  constructor(opts: PersonTracksOptions) {
    this.opts = opts;
  }

  /** いま見えている追跡 */
  live(now: number): PersonTrack[] {
    return this.tracks.filter((t) => t.points !== null && now - t.lastSeenMs <= this.opts.lostMs);
  }

  /** ロスト処理。毎フレーム呼ぶ */
  update(now: number) {
    for (let i = this.tracks.length - 1; i >= 0; i--) {
      if (now - this.tracks[i].lastSeenMs > this.opts.lostMs) this.tracks.splice(i, 1);
    }
  }

  /**
   * 検出結果を取り込む。頭の位置の近さで「同じ人の続き」を組み、続きなら EMA、新規なら追跡を作る。
   * maxTracks を超える検出は捨てる
   */
  apply(detections: readonly PersonDetection[], now: number) {
    const o = this.opts;
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
        lastSeenMs: now,
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
      track.head.x += (det.head.x - track.head.x) * o.smooth;
      track.head.y += (det.head.y - track.head.y) * o.smooth;
      track.head.z += (det.head.z - track.head.z) * o.smooth;
    } else {
      track.points = det.points.map((p) => ({ ...p }));
      track.head = { ...det.head };
    }
    track.depth = det.depth;
    track.residual = det.residual;
    track.used = det.used;
    track.lastSeenMs = now;
  }

  /**
   * ピアとの対応づけを 1 回（検出フレームごとに）行い、ヒステリシス付きで id を更新する。
   * - 同じ id が最良なら維持
   * - 別の id が idStreak 回連続で最良なら切り替え
   * - 対応が取れない状態が idHoldMs 続いたら id を外す
   * - 同じ id を 2 つの追跡が持ったら、対応が新しい方に残す
   */
  match(peers: readonly MatchCandidate[], now: number, opts: MatchOptions) {
    const live = this.live(now);
    const results = matchPersons(
      live.map((t) => ({ key: t.key, pos: t.head })),
      peers,
      opts,
    );
    for (const track of live) {
      const r = results.get(track.key);
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
      track.candidate = null;
      track.candidateStreak = 0;
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

function dist3(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
