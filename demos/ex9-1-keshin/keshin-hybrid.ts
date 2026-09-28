// 段階 3 の B: カメラで見た人で相手の化身の位置を決める（ハイブリッド）の純粋関数。three に依存させない（scripts/test-keshin.mjs から import する）。
//   方向 = 自分のカメラで検出した相手の体（Pose → 09 の body-math.ts で 3D 化 → ジャイロの回転 + カメラの位置で自分のワールドへ。マーカーに依らない）
//   距離 = 申告位置（新しければ主）とカメラの推定（体の大きさの仮定）を混ぜる。申告が古ければカメラだけ
//   誰か = 申告位置の方向が一番近い人（09 と同じ考え方）。申告が古い・自分のアンカーが無いときは前の結果の人と位置で対応づける
//   見えていない間 = 申告位置 + 見えていた間に学んだ補正（直近の窓の外れ値を除いた平均。最後に見えてからの時間で弱める）
import { bodyHeadPoint, placeBodyLandmarks, scaleBody, solveBodyPlacement, BODY_LANDMARK_COUNT } from "../../src/shared/body-math.ts";
import type { BodyLandmark } from "../../src/shared/body-math.ts";
import type { ViewMapping } from "../../src/shared/hand-math.ts";
import { mirrorBodyFacing } from "./mirror-math.ts";
import type { V3 } from "./keshin-math.ts";

/** 自分のカメラで見た相手 1 人（自分のワールド座標） */
export type CamDetection = {
  /** 頭（両目の中点。ゴーグルで隠れていても Pose は推定する） */
  head: V3;
  /** 体の前（水平 [x, z]。肩の線から。ゴーグルで顔が隠れるので鼻は前後の向きの補助だけ） */
  fwd: [number, number];
  fwdSource: "shoulders" | "nose" | "default";
  /** 目（カメラ）から頭までの距離 [m]（カメラの推定） */
  camDist: number;
};

/** 4×4 の列優先行列で点を変換する（three の Matrix4.elements と同じ並び） */
function applyMat4(m: readonly number[], p: V3): V3 {
  return [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
}

/**
 * Pose の 1 人ぶん → 自分のワールドの頭・体の向き。mapping は実カメラの FOV（Passthrough.metricViewMapping）、camMatrix は three のカメラの
 * matrixWorld（ジャイロの回転 + カメラの位置。StereoEffect の左右の目の中心）
 */
export function detectionToWorld(
  landmarks: readonly BodyLandmark[],
  worldRaw: readonly BodyLandmark[],
  mapping: ViewMapping,
  camMatrix: readonly number[],
  opts: { bodyScale: number; minVisibility: number; maxDepthM: number },
): CamDetection | null {
  if (landmarks.length < BODY_LANDMARK_COUNT || worldRaw.length < BODY_LANDMARK_COUNT) return null;
  const world = scaleBody(worldRaw, opts.bodyScale);
  const placement = solveBodyPlacement(landmarks, world, mapping, opts.minVisibility);
  if (!placement || !(placement.depth > 0) || placement.depth > opts.maxDepthM) return null;
  const placed = placeBodyLandmarks(landmarks, world, placement, mapping);
  const headCam = bodyHeadPoint(placed, landmarks, opts.minVisibility);
  const head = applyMat4(camMatrix, [headCam.x, headCam.y, headCam.z]);
  // 体の向きはワールドで（カメラが傾いていても水平面で決まる）
  const placedWorld = placed.map((p) => {
    const w = applyMat4(camMatrix, [p.x, p.y, p.z]);
    return { x: w[0], y: w[1], z: w[2] };
  });
  const facing = mirrorBodyFacing(placedWorld, landmarks, opts.minVisibility);
  return { head, fwd: facing.fwd, fwdSource: facing.source, camDist: Math.hypot(headCam.x, headCam.y, headCam.z) };
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (a: V3) => Math.hypot(a[0], a[1], a[2]);

/** 目から見た 2 つの点の方向のなす角 [deg] */
export function angleFromEyeDeg(eye: V3, a: V3, b: V3): number {
  const u = sub(a, eye);
  const v = sub(b, eye);
  const lu = norm(u);
  const lv = norm(v);
  if (lu < 1e-9 || lv < 1e-9) return 180;
  const c = (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (lu * lv);
  return (Math.acos(Math.min(1, Math.max(-1, c))) * 180) / Math.PI;
}

/** 相手 1 人の対応づけの入力 */
export type MatchRemote = {
  id: string;
  /** 申告位置（自分のワールド。自分のアンカーが無ければ null） */
  declared: V3 | null;
  /** 申告と自分のアンカーがどちらも新しいか（方向で結ぶ条件） */
  fresh: boolean;
  /** 前回この相手に結んだ人の頭（自分のワールド。しばらく見ていなければ null） */
  last: V3 | null;
};

export type MatchReason = "declared-dir" | "tracked" | "only-one";

/**
 * 1 対 1 の割り当てを全探索で選ぶ: 「結ぶ組の数が最大」→「その中でコストの合計が最小」（09 の assignOptimal と同じ考え方）。
 * 貪欲（近い組から順に）だと、成り立つ 2 組のうち 1 組を失うことがある（例: A=0°・B=10° と検出 4°・−5°、しきい値 8° で A→4° だけ）。
 * 相手は高々 8 人・検出は高々 4 人なので全探索で足りる
 */
export function assignMaxMin(
  remoteIds: readonly string[],
  detCount: number,
  cost: (id: string, det: number) => number | null,
): Map<string, number> {
  const opts = remoteIds.map((id) => {
    const list: { det: number; c: number }[] = [];
    for (let d = 0; d < detCount; d++) {
      const c = cost(id, d);
      if (c !== null && Number.isFinite(c)) list.push({ det: d, c });
    }
    return list;
  });
  let best: { n: number; c: number; pick: (number | null)[] } = { n: 0, c: 0, pick: remoteIds.map(() => null) };
  const pick: (number | null)[] = remoteIds.map(() => null);
  const used = new Set<number>();
  const dfs = (i: number, n: number, c: number) => {
    if (i === remoteIds.length) {
      if (n > best.n || (n === best.n && n > 0 && c < best.c)) best = { n, c, pick: [...pick] };
      return;
    }
    // 残りを全部結んでも今の最良の数に届かなければ打ち切る
    if (n + (remoteIds.length - i) < best.n) return;
    for (const o of opts[i]) {
      if (used.has(o.det)) continue;
      used.add(o.det);
      pick[i] = o.det;
      dfs(i + 1, n + 1, c + o.c);
      used.delete(o.det);
      pick[i] = null;
    }
    dfs(i + 1, n, c);
  };
  dfs(0, 0, 0);
  const out = new Map<string, number>();
  best.pick.forEach((d, i) => {
    if (d !== null) out.set(remoteIds[i], d);
  });
  return out;
}

/**
 * 検出した人と相手を 1 対 1 で結ぶ。1 回の全探索で「結ぶ組の数が最大 → コストの合計が最小」（段ごとに決めると、先の段が別の相手の
 * 唯一の候補を取ってしまう。例: 申告の方向がアンカーの誤差でずれて隣の人に近く見えると、隣の人の相手が結べなくなる）。組の候補:
 *   declared-dir: 申告と自分のアンカーが新しい相手で、申告位置の方向と検出の方向のなす角が matchDeg 以内（コスト = 角度 [deg]）
 *   tracked: 前回結んだ人の頭と今の検出の頭が matchM 以内（コスト = 距離 / matchM × matchDeg / 2。見失う直前まで見ていた人を優先）
 * どちらも無ければ、相手 1 人・検出 1 人のときだけ結ぶ（only-one）。ただし新しい申告がある相手は、方向の差が onlyOneMaxDeg 以内のときだけ
 * （部屋にいるプレイヤーでない人に付けて、その差を補正として学ばないように）。古い申告の方向だけでは結ばない（別人に付け得る）
 */
export function matchRemotes(
  detections: readonly { head: V3 }[],
  remotes: readonly MatchRemote[],
  eye: V3,
  opts: { matchDeg: number; matchM: number; onlyOneMaxDeg: number },
): Map<string, { index: number; reason: MatchReason }> {
  const out = new Map<string, { index: number; reason: MatchReason }>();
  const byId = new Map(remotes.map((r) => [r.id, r]));
  const best = (id: string, d: number): { c: number; reason: MatchReason } | null => {
    const r = byId.get(id)!;
    let pick: { c: number; reason: MatchReason } | null = null;
    if (r.declared && r.fresh) {
      const a = angleFromEyeDeg(eye, r.declared, detections[d].head);
      if (a <= opts.matchDeg) pick = { c: a, reason: "declared-dir" };
    }
    if (r.last) {
      const m = norm(sub(detections[d].head, r.last));
      if (m <= opts.matchM) {
        const c = (m / opts.matchM) * opts.matchDeg * 0.5;
        if (!pick || c < pick.c) pick = { c, reason: "tracked" };
      }
    }
    return pick;
  };
  const m = assignMaxMin(
    remotes.map((r) => r.id),
    detections.length,
    (id, d) => best(id, d)?.c ?? null,
  );
  for (const [id, d] of m) out.set(id, { index: d, reason: best(id, d)!.reason });
  if (remotes.length === 1 && detections.length === 1 && !out.has(remotes[0].id)) {
    const r = remotes[0];
    const ok = !(r.declared && r.fresh) || angleFromEyeDeg(eye, r.declared, detections[0].head) <= opts.onlyOneMaxDeg;
    if (ok) out.set(r.id, { index: 0, reason: "only-one" });
  }
  return out;
}

/**
 * 距離の混ぜ方: 申告が新しければ 申告までの距離 × distW + カメラの推定 × (1 − distW)（申告寄り）、古ければ（申告が無ければ）カメラの推定
 */
export function blendDistance(camDist: number, declDist: number | null, fresh: boolean, distW: number): number {
  if (declDist === null || !fresh) return camDist;
  const w = Math.min(1, Math.max(0, distW));
  return declDist * w + camDist * (1 - w);
}

/** 見えている相手の頭: 方向はカメラの値、距離は blendDistance。頭 = 自分の目 + 方向 × 距離 */
export function hybridHead(eye: V3, camHead: V3, declared: V3 | null, fresh: boolean, distW: number): V3 {
  const d = sub(camHead, eye);
  const camDist = norm(d);
  if (camDist < 1e-9) return [camHead[0], camHead[1], camHead[2]];
  const dist = blendDistance(camDist, declared ? norm(sub(declared, eye)) : null, fresh, distW);
  return [eye[0] + (d[0] / camDist) * dist, eye[1] + (d[1] / camDist) * dist, eye[2] + (d[2] / camDist) * dist];
}

/**
 * 外れ値を除いた平均（08-11 の anchor-filter.ts と同じ書き方）: 各軸の中央値を基準に、基準からの 3D 距離の中央値 / 1.538 を σ とし、
 * max(3σ, minOutlierM) を超える点を除いて平均し直す。3 件未満は単純平均（中央値が当てにならない）
 */
export function robustMeanV3(samples: readonly V3[], minOutlierM = 0.15): { mean: V3; used: number } {
  const n = samples.length;
  if (n === 0) return { mean: [0, 0, 0], used: 0 };
  const plain = (list: readonly V3[]): V3 => {
    const s: V3 = [0, 0, 0];
    for (const p of list) for (let k = 0; k < 3; k++) s[k] += p[k] / list.length;
    return s;
  };
  if (n < 3) return { mean: plain(samples), used: n };
  const med = (xs: number[]) => {
    const a = [...xs].sort((x, y) => x - y);
    const m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  };
  const center: V3 = [med(samples.map((p) => p[0])), med(samples.map((p) => p[1])), med(samples.map((p) => p[2]))];
  const dists = samples.map((p) => norm(sub(p, center)));
  const sigma = med(dists) / 1.538;
  const thr = Math.max(3 * sigma, minOutlierM);
  const kept = samples.filter((_, i) => dists[i] <= thr);
  return { mean: plain(kept.length ? kept : samples), used: kept.length || n };
}

/** 補正の観測（マーカー座標系の「カメラで見た頭 − 申告位置」と、その時刻 [ms]） */
export type CorrSample = { t: number; c: V3 };

/** 窓の外（最後の観測から windowSec より前）の観測を捨てる（見えていない間は最後の窓を残す。隠れた状態は窓の観測だけ） */
export function pruneCorr(samples: readonly CorrSample[], windowSec: number): CorrSample[] {
  if (samples.length === 0) return [];
  const last = samples[samples.length - 1].t;
  return samples.filter((s) => s.t >= last - windowSec * 1000);
}

/**
 * いまの補正: 見えなくなった瞬間に位置が飛ばないよう、直近 recentSec 秒（最後の観測から）の観測の外れ値を除いた平均（3 件未満なら窓全体）
 * × 弱まり（最後に見えてから decaySec で 0 へ。線形）。lastSeenMs を渡せばそれを「最後に見えた時刻」とする（表示の判定と同じ時刻の基準）。
 * 窓（windowSec）は観測を捨てる範囲と、直近の件数が足りないときの平均に使う。raw = 弱める前、n = 窓の件数、used = 平均に使った件数
 */
export function correctionAt(
  samples: readonly CorrSample[],
  nowMs: number,
  windowSec: number,
  decaySec: number,
  recentSec = 0.5,
  lastSeenMs?: number,
): { c: V3; raw: V3; k: number; n: number; used: number; sinceMs: number } {
  const win = pruneCorr(samples, windowSec);
  if (win.length === 0) return { c: [0, 0, 0], raw: [0, 0, 0], k: 0, n: 0, used: 0, sinceMs: Infinity };
  const lastT = win[win.length - 1].t;
  const sinceMs = Math.max(0, nowMs - (lastSeenMs !== undefined && Number.isFinite(lastSeenMs) ? Math.max(lastSeenMs, lastT) : lastT));
  const k = decaySec > 0 ? Math.max(0, 1 - sinceMs / (decaySec * 1000)) : 0;
  const recent = win.filter((s) => s.t >= lastT - recentSec * 1000);
  const rm = robustMeanV3((recent.length >= 3 ? recent : win).map((s) => s.c));
  return { c: [rm.mean[0] * k, rm.mean[1] * k, rm.mean[2] * k], raw: rm.mean, k, n: win.length, used: rm.used, sinceMs };
}

/** planRemote の入力（相手 1 人ぶん。自分のワールドの値。three に依存しない） */
export type PlanInput = {
  mode: "declared" | "camera" | "hybrid";
  now: number;
  /** 申告だけで見たときの表示（keshin-math.ts の remoteDisplay。stale で消す判定込み） */
  disp: { draw: boolean; fade: number; reason: string };
  /** 自分のアンカー（マーカー座標系 → 自分のワールド）。無ければ null */
  anchor: { pos: V3; quat: [number, number, number, number] } | null;
  /** 最新の申告位置（マーカー座標系。補正の基準と見えている間の距離に使う） */
  declMarker: V3 | null;
  /** declared モードの表示用の申告位置（gyro で staleMs を過ぎたら止めた値） */
  declMarkerFrozen: V3 | null;
  /** 申告された体の向き（自分のワールドのヨー。アンカーが無ければ null） */
  declYaw: number | null;
  /** 申告と自分のアンカーがどちらも新しいか */
  fresh: boolean;
  /** 最新の Pose の結果で見えているか・そのときの検出 */
  seen: boolean;
  cam: CamDetection | null;
  lastCamSeenMs: number;
  lastCamHead: V3 | null;
  lastCamFwd: [number, number] | null;
  corr: readonly CorrSample[];
  eye: V3;
  opts: {
    distW: number;
    corrWindowSec: number;
    corrDecaySec: number;
    corrRecentSec: number;
    staleMs: number;
    staleHideMs: number;
    noPoseMs: number;
    lostMs: number;
    cameraFadeMs: number;
  };
  /** remoteDisplay（keshin-math.ts）。循環の import を避けるため呼び出し側から渡す */
  display: (pose: { track: "gyro"; ageMs: number }) => { draw: boolean; fade: number; reason: string };
  markerToWorld: (pos: V3, quat: [number, number, number, number], p: V3) => V3;
};

export type PlanOutput = { target: V3 | null; yaw: number | null; fade: number; reason: string; source: "declared" | "camera" | "hybrid" | "declared+corr" | "hidden" };

const yawOf = (f: readonly [number, number]) => Math.atan2(f[0], f[1]);

/**
 * どこに・どの薄さで描くか（位置の決め方ごと。RemoteKeshins.plan の中身。Node テストで時刻を進めて確かめる）。target = null なら描かない
 *   declared: 段階 2 と同じ（止めた申告位置。信用度で薄く・古ければ消す）
 *   camera: 見えている間はカメラの位置だけ。最新の結果で見えなくなったら cameraFadeMs で消す（比べる用）
 *   hybrid: 見えている間は方向 = カメラ・距離 = 申告と混ぜる（アンカーやマーカーが無くても描く）。見えていない間は 最新の申告位置 + 補正（弱めながら）。
 *     薄さは max(申告側, 最後に見えてから側)、消すのは両方とも描けないときだけ（申告が新しければ補正が 0 になっても消えない）
 */
export function planRemote(i: PlanInput): PlanOutput {
  const hidden = (reason: string): PlanOutput => ({ target: null, yaw: null, fade: 0, reason, source: "hidden" });
  const toWorld = (m: V3) => i.markerToWorld(i.anchor!.pos, i.anchor!.quat, m);
  const camYaw = i.cam ? yawOf(i.cam.fwd) : i.lastCamFwd ? yawOf(i.lastCamFwd) : null;
  if (i.mode === "declared") {
    if (!i.disp.draw || !i.anchor || !i.declMarkerFrozen || i.declYaw === null) return hidden(i.disp.reason);
    return { target: toWorld(i.declMarkerFrozen), yaw: i.declYaw, fade: i.disp.fade, reason: i.disp.reason, source: "declared" };
  }
  const since = i.seen ? 0 : i.now - i.lastCamSeenMs;
  if (i.mode === "camera") {
    if (!i.lastCamHead) return hidden("camera-lost");
    if (i.seen) return { target: i.lastCamHead, yaw: i.declYaw ?? camYaw ?? 0, fade: 1, reason: "ok", source: "camera" };
    const f = 1 - since / Math.max(1, i.opts.cameraFadeMs);
    if (f <= 0) return hidden("camera-lost");
    return { target: i.lastCamHead, yaw: i.declYaw ?? camYaw ?? 0, fade: f, reason: "camera-fading", source: "camera" };
  }
  const declWorld = i.anchor && i.declMarker ? toWorld(i.declMarker) : null;
  if (i.seen && i.cam) {
    const head = hybridHead(i.eye, i.cam.head, declWorld, i.fresh, i.opts.distW);
    return { target: head, yaw: i.declYaw ?? camYaw ?? 0, fade: 1, reason: "ok", source: i.fresh ? "hybrid" : "camera" };
  }
  // 見えていない: 申告側と「最後に見えてから」側の薄さの大きい方
  const corr = correctionAt(i.corr, i.now, i.opts.corrWindowSec, i.opts.corrDecaySec, i.opts.corrRecentSec, i.lastCamSeenMs);
  const learned = corr.n > 0 && Number.isFinite(i.lastCamSeenMs);
  const dSide = i.disp.draw && declWorld ? i.disp.fade : 0;
  const sDisp = learned && Number.isFinite(since) ? i.display({ track: "gyro", ageMs: since }) : { draw: false, fade: 0, reason: "not-seen" };
  const sSide = sDisp.draw ? sDisp.fade : 0;
  // 通信切れ・pose 無しは申告側の理由で消す（最後に見えていても、もう居ないかもしれない）
  if (i.disp.reason === "lost" || i.disp.reason === "no-pose") return hidden(i.disp.reason);
  const fade = Math.max(dSide, sSide);
  if (!(fade > 0)) return hidden(i.disp.draw ? "stale" : i.disp.reason === "ok" ? "stale" : i.disp.reason);
  const yaw = i.declYaw ?? camYaw ?? 0;
  if (declWorld && i.declMarker) {
    const m = i.declMarker;
    const target = corr.k > 0 ? toWorld([m[0] + corr.c[0], m[1] + corr.c[1], m[2] + corr.c[2]]) : declWorld;
    return { target, yaw, fade, reason: dSide >= sSide ? i.disp.reason : sDisp.reason, source: corr.k > 0 ? "declared+corr" : "declared" };
  }
  // 自分のアンカーが無い（申告を自分のワールドに置けない）: 最後に見えた位置で、最後に見えてから側の薄さで
  if (i.lastCamHead && sSide > 0) return { target: i.lastCamHead, yaw, fade: sSide, reason: sDisp.reason, source: "camera" };
  return hidden(i.disp.reason);
}
