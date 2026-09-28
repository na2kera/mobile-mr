// ex9-1 鏡モード（mirror.html）の純粋関数。three に依存させない（scripts/test-keshin.mjs から import する）。
// 座標は「カメラ座標系 = ワールド」: iPad はスタンドに固定し、three のカメラは原点で −Z を見る（x 右・y 上・z 手前）。
// 人の 3D 化は 09 の body-math.ts（worldLandmarks の実寸の形を画像上の見え方に当てはめる最小二乗）をそのまま使う
import {
  LEFT_ANKLE,
  LEFT_EAR,
  LEFT_EYE,
  LEFT_HIP,
  LEFT_SHOULDER,
  NOSE,
  RIGHT_ANKLE,
  RIGHT_EAR,
  RIGHT_EYE,
  RIGHT_SHOULDER,
  BODY_LANDMARK_COUNT,
  bodyHeadPoint,
  placeBodyLandmarks,
  scaleBody,
  solveBodyPlacement,
} from "../../src/shared/body-math.ts";
import type { BodyLandmark } from "../../src/shared/body-math.ts";
import { projectToImage } from "../../src/shared/fake-hands.ts";
import type { Vec3, ViewMapping } from "../../src/shared/hand-math.ts";
import { syntheticBodyShape } from "../../src/shared/fake-body.ts";
import type { V3 } from "./keshin-math.ts";

/** 鏡の前で見つけた人 1 人（カメラ座標系） */
export type MirrorPerson = {
  /** 頭（両目の中点。見えなければ両耳・鼻） */
  head: V3;
  /** 体の前の向き（水平の単位ベクトル [x, z]。カメラの方を向くと [0, 1]） */
  fwd: [number, number];
  /** 向きをどこから出したか（shoulders = 肩の線、nose = 肩の線が短いので鼻で前後を決めた、default = 分からないのでカメラの方） */
  fwdSource: "shoulders" | "nose" | "default";
  /** カメラからの距離（体の深度 [m]。小さいほど近い = 大きく写る） */
  depth: number;
  /** 足首が見えていれば床の高さ（y）。見えなければ null（頭 − eyeH を使う） */
  floorY: number | null;
  /** 解くのに使った可視点の数 */
  used: number;
  /**
   * 画像の上での頭の位置（正規化座標。x 右・y 下、画像の幅・高さを 1 とする。鏡の反転前）。一度付けた人を追いかける主な手掛かり
   * （深度の推定は体の大きさの仮定で数十 cm ぶれるが、画像の上の位置はほとんどぶれない）
   */
  img: [number, number];
};

export type MirrorPersonOptions = {
  /** worldLandmarks の実寸補正（09 の ?bodyScale= と同じ。1 で補正なし） */
  bodyScale: number;
  /** 可視とみなす visibility */
  minVisibility: number;
  /** これより遠い人は無視する [m] */
  maxDepthM: number;
};

/** 肩の線の水平の長さがこれ未満なら（真横を向いていて肩が重なる）鼻で前後を決める [m] */
export const SHOULDER_MIN_M = 0.12;
/** 鼻が肩の中点からこれ以上前（水平）に出ていれば、その側を前とする [m] */
export const NOSE_AHEAD_M = 0.03;
/** 足首から床まで（足首の関節の高さ）[m] */
export const ANKLE_ABOVE_FLOOR_M = 0.08;

function vis(l: BodyLandmark | undefined): number {
  return l?.visibility ?? 1;
}

/**
 * 体の前の向き（カメラ座標系の水平 [x, z]）。肩の線（本人の右 → 左）と上（+Y）の外積が前:
 * カメラの方を向いた人は本人の左肩が画像の右（+x）に写るので、(+x) × (+y) = +z（カメラの方）。
 * MediaPipe は真横に近いと左右を取り違えることがあるので、鼻が肩の中点より前に出ていればその側に合わせる。
 * 肩が重なる（真横で肩の線が短い）なら鼻の向きだけで決める
 */
export function mirrorBodyFacing(
  placed: readonly Vec3[],
  landmarks: readonly BodyLandmark[],
  minVisibility: number,
): { fwd: [number, number]; source: MirrorPerson["fwdSource"]; frontKnown: boolean } {
  const ls = placed[LEFT_SHOULDER];
  const rs = placed[RIGHT_SHOULDER];
  const shouldersOk = vis(landmarks[LEFT_SHOULDER]) >= minVisibility && vis(landmarks[RIGHT_SHOULDER]) >= minVisibility;
  const nose = placed[NOSE];
  const noseOk = vis(landmarks[NOSE]) >= minVisibility;
  const mid = shouldersOk ? { x: (ls.x + rs.x) / 2, z: (ls.z + rs.z) / 2 } : null;
  const noseDir = noseOk && mid ? { x: nose.x - mid.x, z: nose.z - mid.z } : null;
  if (shouldersOk) {
    // (L − R) × up = (dx, 0, dz) × (0, 1, 0) = (−dz, 0, dx)
    const dx = ls.x - rs.x;
    const dz = ls.z - rs.z;
    const len = Math.hypot(dx, dz);
    if (len >= SHOULDER_MIN_M) {
      let f: [number, number] = [-dz / len, dx / len];
      // 鼻が前に出ていれば前後が決まる（frontKnown）。出ていない（ゴーグルで顔が隠れる・背中から見ている）なら肩の線の向きだけが確か
      const noseAhead = !!noseDir && Math.hypot(noseDir.x, noseDir.z) >= NOSE_AHEAD_M;
      if (noseAhead && noseDir!.x * f[0] + noseDir!.z * f[1] < 0) f = [-f[0], -f[1]];
      return { fwd: f, source: "shoulders", frontKnown: noseAhead };
    }
  }
  if (noseDir) {
    const n = Math.hypot(noseDir.x, noseDir.z);
    if (n >= NOSE_AHEAD_M) return { fwd: [noseDir.x / n, noseDir.z / n], source: "nose", frontKnown: true };
  }
  // 分からなければ鏡（カメラ）の方を向いているとみなす
  return { fwd: [0, 1], source: "default", frontKnown: false };
}

/**
 * 画像の上での頭の位置（正規化座標）: 両目の中点 → 鼻 → 両耳の中点 → 両肩の中点の順に、見えているもの。どれも見えなければ見えている点の平均
 */
export function headImagePoint(landmarks: readonly BodyLandmark[], minVisibility: number): [number, number] {
  const ok = (i: number) => !!landmarks[i] && vis(landmarks[i]) >= minVisibility;
  const mid = (a: number, b: number): [number, number] => [(landmarks[a].x + landmarks[b].x) / 2, (landmarks[a].y + landmarks[b].y) / 2];
  if (ok(LEFT_EYE) && ok(RIGHT_EYE)) return mid(LEFT_EYE, RIGHT_EYE);
  if (ok(NOSE)) return [landmarks[NOSE].x, landmarks[NOSE].y];
  if (ok(LEFT_EAR) && ok(RIGHT_EAR)) return mid(LEFT_EAR, RIGHT_EAR);
  if (ok(LEFT_SHOULDER) && ok(RIGHT_SHOULDER)) return mid(LEFT_SHOULDER, RIGHT_SHOULDER);
  let x = 0;
  let y = 0;
  let n = 0;
  for (const l of landmarks) {
    if (vis(l) < minVisibility) continue;
    x += l.x;
    y += l.y;
    n++;
  }
  return n > 0 ? [x / n, y / n] : [0.5, 0.5];
}

/** 足首が両方見えていて画面の中なら床の高さ（y）。見えなければ null */
export function floorFromAnkles(placed: readonly Vec3[], landmarks: readonly BodyLandmark[], minVisibility: number): number | null {
  for (const i of [LEFT_ANKLE, RIGHT_ANKLE]) {
    const l = landmarks[i];
    if (!l || vis(l) < minVisibility || l.x < 0.01 || l.x > 0.99 || l.y < 0.01 || l.y > 0.99) return null;
  }
  return Math.min(placed[LEFT_ANKLE].y, placed[RIGHT_ANKLE].y) - ANKLE_ABOVE_FLOOR_M;
}

/**
 * PoseLandmarker の 1 人ぶん（landmarks = 画像の正規化座標、world = worldLandmarks）→ カメラ座標系の頭・体の向き・深度・床。
 * mapping は実カメラの FOV（Passthrough.metricViewMapping。描画のカメラの FOV を背景に合わせているので、この座標がそのまま背景の人に重なる）
 */
export function mirrorPersonFromPose(
  landmarks: readonly BodyLandmark[],
  worldRaw: readonly BodyLandmark[],
  mapping: ViewMapping,
  opts: MirrorPersonOptions,
): MirrorPerson | null {
  if (landmarks.length < BODY_LANDMARK_COUNT || worldRaw.length < BODY_LANDMARK_COUNT) return null;
  const world = scaleBody(worldRaw, opts.bodyScale);
  const placement = solveBodyPlacement(landmarks, world, mapping, opts.minVisibility);
  if (!placement || !(placement.depth > 0) || placement.depth > opts.maxDepthM) return null;
  const placed = placeBodyLandmarks(landmarks, world, placement, mapping);
  const h = bodyHeadPoint(placed, landmarks, opts.minVisibility);
  const facing = mirrorBodyFacing(placed, landmarks, opts.minVisibility);
  return {
    head: [h.x, h.y, h.z],
    fwd: facing.fwd,
    fwdSource: facing.source,
    depth: placement.depth,
    floorY: floorFromAnkles(placed, landmarks, opts.minVisibility),
    used: placement.used,
    img: headImagePoint(landmarks, opts.minVisibility),
  };
}

/**
 * 誰の化身をどの人に付けるか（簡易な対応）: 見えている人を近い順（深度の小さい順）に、化身を出しているプレイヤーの参加順に割り当てる。
 * 化身が 1 人なら一番近い人に付く。人が足りなければ後ろのプレイヤーは付かない。返り値は プレイヤー id → 人の番号
 */
export function assignMirror(depths: readonly number[], playerIds: readonly string[]): Map<string, number> {
  const order = depths.map((d, i) => [d, i] as const).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(([, i]) => i);
  const out = new Map<string, number>();
  for (let k = 0; k < Math.min(order.length, playerIds.length); k++) out.set(playerIds[k], order[k]);
  return out;
}

/**
 * 見失ったときの見せ方（経過だけで決まる。状態を持たない）: 見えている / 見失って holdMs までは同じ濃さで最後の位置に保持、
 * その後 fadeMs かけて消し、以降は描かない。見つけ直したら（sinceSeenMs = 0）すぐ出す
 */
export function mirrorHoldFade(
  sinceSeenMs: number,
  holdMs: number,
  fadeMs: number,
): { draw: boolean; fade: number; phase: "seen" | "hold" | "fading" | "lost" } {
  if (!(sinceSeenMs > 0)) return { draw: true, fade: 1, phase: "seen" };
  if (sinceSeenMs <= holdMs) return { draw: true, fade: 1, phase: "hold" };
  const t = (sinceSeenMs - holdMs) / Math.max(1, fadeMs);
  if (t >= 1) return { draw: false, fade: 0, phase: "lost" };
  return { draw: true, fade: 1 - t, phase: "fading" };
}

/**
 * 毎フレームの見せ方: 濃さ（保持・フェード）は常に「いま − 最後にその人を見た時刻」で決める（Pose が止まって新しい結果が来なくなっても
 * 保持 → フェード → 消える）。phase が "seen" になるのは、最新の結果がまだ新しく（staleResultMs 以内）、その結果にその人が写っていたときだけ
 */
export function mirrorVisibility(
  nowMs: number,
  lastSeenMs: number,
  lastResultMs: number,
  opts: { holdMs: number; fadeMs: number; staleResultMs: number },
): { draw: boolean; fade: number; phase: "seen" | "hold" | "fading" | "lost" } {
  const hf = mirrorHoldFade(nowMs - lastSeenMs, opts.holdMs, opts.fadeMs);
  const fresh = Number.isFinite(lastSeenMs) && lastSeenMs === lastResultMs && nowMs - lastResultMs <= opts.staleResultMs;
  if (fresh && (hf.phase === "seen" || hf.phase === "hold")) return { ...hf, phase: "seen" };
  if (hf.phase === "seen") return { ...hf, phase: "hold" };
  return hf;
}

/**
 * 1 対 1 の割り当てを全探索で選ぶ: 「結ぶ組の数が最大」→「その中でコストの合計が最小」（09 の assignOptimal と同じ考え方）。
 * 貪欲（近い組から順に）だと、成り立つ 2 組のうち 1 組を失うことがある（例: A=0°・B=10° と検出 4°・−5°、しきい値 8° で A→4° だけ）。
 * 相手は高々 8 人・検出は高々 4 人なので全探索で足りる。鏡（assignMirrorTracked）とゴーグル（keshin-hybrid.ts の matchRemotes）で共有する
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

/** 画像の上の距離（正規化座標） */
export function imageDist(a: readonly [number, number], b: readonly [number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/**
 * 前回の人と同じ人とみなす画像の上の距離は、最後に見えてからの時間で広げる: min(matchImg, max(MIRROR_MIN_IMG, MIRROR_IMG_SPEED_PER_S × 経過))。
 * 続けて見えている（経過 = 結果の間隔）ときは狭く、Pose が 1〜2 回その人を取りこぼしても、隣に並んだ人（3m で肩を並べると画像の上で 0.12〜0.2）へ
 * 移らない。長く見失うほど広げ、0.3 秒で matchImg（0.15）に届く。状態は増やさない（経過は「最後に見えた時刻」から出す）
 */
export const MIRROR_MIN_IMG = 0.05;
/** 画像の上で人が動ける速さの見込み [正規化 / 秒]（3m で横へ約 2m/s、1.5m で約 1m/s） */
export const MIRROR_IMG_SPEED_PER_S = 0.5;
export function mirrorImgGate(matchImg: number, sinceSeenMs: number): number {
  const t = Number.isFinite(sinceSeenMs) ? Math.max(0, sinceSeenMs) : Infinity;
  return Math.min(matchImg, Math.max(MIRROR_MIN_IMG, (MIRROR_IMG_SPEED_PER_S * t) / 1000));
}

/** 3D の距離をコストに足すときの重み（画像の上の距離 [正規化] に対して 1m あたり）。3D は補助（同じくらいの画像の距離のときの決め手）だけ */
export const MIRROR_DEPTH_COST_PER_M = 0.05;

/** 鏡の割り当ての 1 体ぶんの結果と、判断に使った値（HUD とログ用） */
export type MirrorAssignInfo = {
  /** tracked = 前回の人を画像の上の位置で追いかけた / new = 新しく付けた（近い順）/ hold = 前回の人を見失い、保持の時間の間は付け替えない / displaced = 前回の人を別の化身に取られた / none = 付ける人がいない */
  reason: "tracked" | "new" | "hold" | "displaced" | "none";
  /** 前回の人の画像の位置から、付けた人（付けなければ一番近い人）までの画像の上の距離 */
  dImg: number | null;
  /** 前回の人の画像の位置から、2 番目に近い人（付けた人以外で一番近い人）までの画像の上の距離（しきい値を決める材料） */
  dImg2: number | null;
  /** この結果で使った画像の上の距離のしきい値（mirrorImgGate。最後に見えてからの時間で広がる） */
  gate: number | null;
  /** 前回の人の頭から、付けた人の頭までの 3D の距離 [m]（補助） */
  d3: number | null;
};

/**
 * 割り当て（前の結果との対応づけ付き）: 1 人の人には化身を 1 体だけ付ける。一度付けた人は画像の上の頭の位置で追いかけ、見えている間は付け替えない。
 *   1. 前回その化身を付けていた人（last。見失って消えるまでの間だけ持つ）と、今回の人を画像の上の頭の位置で対応づける:
 *      画像の上の距離が mirrorImgGate（最後に見えてからの時間で広がり、最大 matchImg）以内の組の中から、組の数が最大 → コスト（画像の上の距離 + 3D の距離 × MIRROR_DEPTH_COST_PER_M）の合計が最小
 *      （3D の距離は Pose の距離の推定が数十 cm ぶれるので補助だけ。ぶれで対応が外れて近い順に選び直すと、同じくらいの距離の 2 人の間で行き来する）
 *   2. 付かなかった化身のうち、前回の人がいない（初めて）か、見失って holdMs を過ぎたものにだけ、残った人を近い順（深度の小さい順）に参加順で付ける。
 *      前回の人を見失ってまだ holdMs 以内なら付け替えない（hold。その人が戻れば 1 で同じ化身に戻る）
 *   3. 付かなかった化身のうち、前回の人の画像の位置の近く（mirrorImgGate 以内）に今回の人がいる（= その人は別の化身に付いた）ものは displaced:
 *      保持せずにすぐフェードに入れる（同じ人の所に 2 体重ならないように）
 * 持つ状態は化身ごとの「前回の人の画像の上の位置（と 3D の頭）と、最後に見えた時刻」だけ（教訓 4）。sinceSeenMs = いま − 最後に見えた時刻
 */
export function assignMirrorTracked(
  persons: readonly { head: V3; depth: number; img: readonly [number, number] }[],
  players: readonly { id: string; last: { img: readonly [number, number]; head: V3 } | null; sinceSeenMs: number }[],
  opts: { matchImg: number; holdMs: number },
): { assign: Map<string, number>; displaced: Set<string>; info: Map<string, MirrorAssignInfo> } {
  const d3 = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const gateOf = (pl: (typeof players)[number]) => mirrorImgGate(opts.matchImg, pl.sinceSeenMs);
  const tracked = assignMaxMin(
    players.map((p) => p.id),
    persons.length,
    (id, i) => {
      const pl = players.find((p) => p.id === id)!;
      if (!pl.last) return null;
      const di = imageDist(pl.last.img, persons[i].img);
      return di <= gateOf(pl) ? di + d3(pl.last.head, persons[i].head) * MIRROR_DEPTH_COST_PER_M : null;
    },
  );
  const assign = new Map<string, number>();
  const info = new Map<string, MirrorAssignInfo>();
  const used = new Set<number>();
  for (const pl of players) {
    const i = tracked.get(pl.id);
    if (i === undefined) continue;
    assign.set(pl.id, i);
    used.add(i);
  }
  const freePersons = persons
    .map((p, i) => [p.depth, i] as const)
    .filter(([, i]) => !used.has(i))
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
    .map(([, i]) => i);
  const displaced = new Set<string>();
  const nearOther = (pl: (typeof players)[number]) => !!pl.last && persons.some((p) => imageDist(pl.last!.img, p.img) <= gateOf(pl));
  const reasonOf = new Map<string, MirrorAssignInfo["reason"]>();
  for (const pl of players) {
    if (assign.has(pl.id)) {
      reasonOf.set(pl.id, "tracked");
      continue;
    }
    // 前回の人の近くに今回の人がいる（その人は別の化身に付いた）なら、ここでは付け替えない（displaced でフェード）
    if (nearOther(pl)) {
      displaced.add(pl.id);
      reasonOf.set(pl.id, "displaced");
      continue;
    }
    // 前回の人を見失ってまだ保持の時間の間は、ほかの人へ付け替えない
    if (pl.last && !(pl.sinceSeenMs > opts.holdMs)) {
      reasonOf.set(pl.id, "hold");
      continue;
    }
    if (freePersons.length === 0) {
      reasonOf.set(pl.id, "none");
      continue;
    }
    const i = freePersons.shift()!;
    assign.set(pl.id, i);
    used.add(i);
    reasonOf.set(pl.id, "new");
  }
  for (const pl of players) {
    const i = assign.get(pl.id);
    let dImg: number | null = null;
    let dImg2: number | null = null;
    let dd: number | null = null;
    if (pl.last) {
      const ds = persons.map((p, k) => [imageDist(pl.last!.img, p.img), k] as const).sort((a, b) => a[0] - b[0]);
      const mine = i !== undefined ? ds.find(([, k]) => k === i) : ds[0];
      dImg = mine ? mine[0] : null;
      dImg2 = ds.find(([, k]) => !mine || k !== mine[1])?.[0] ?? null;
      dd = mine ? d3(pl.last.head, persons[mine[1]].head) : null;
    }
    info.set(pl.id, { reason: reasonOf.get(pl.id) ?? "none", dImg, dImg2, d3: dd, gate: pl.last ? gateOf(pl) : null });
  }
  return { assign, displaced, info };
}

/** 鏡の反転（画像の横の正規化座標）。背景と 3D をまとめて左右反転するので、画面上の x はこれになる */
export function mirrorImageX(x: number): number {
  return 1 - x;
}

/** 鏡の反転（カメラ座標系の水平の向き）。x を反転する */
export function mirrorDir(f: readonly [number, number]): [number, number] {
  return [-f[0], f[1]];
}

/** PC 確認用の合成の人（カメラ座標系の頭の位置と、体の前の向き） */
export type FakeMirrorPerson = { head: V3; fwd: readonly [number, number] };

/**
 * 合成の人（fake-body.ts の体）をカメラ座標系に立たせた 33 点。keshin-occlusion.ts の projectFakePerson と同じ軸の取り方
 * （左 = 上 × 前、後ろ = −前。field = カメラ座標系）
 */
export function fakeMirrorPoints(p: FakeMirrorPerson): { cam: V3[]; hip: V3 } {
  const shape = syntheticBodyShape();
  const eyesHip = { x: (shape[LEFT_EYE].x + shape[RIGHT_EYE].x) / 2, y: (shape[LEFT_EYE].y + shape[RIGHT_EYE].y) / 2, z: (shape[LEFT_EYE].z + shape[RIGHT_EYE].z) / 2 };
  const f = p.fwd;
  const left: V3 = [f[1], 0, -f[0]];
  const back: V3 = [-f[0], 0, -f[1]];
  const hipShape = shape[LEFT_HIP];
  // 腰の中点は形の原点（左右の腰の中点 = x 0）
  const hip: V3 = [
    p.head[0] - (left[0] * eyesHip.x + back[0] * eyesHip.z),
    p.head[1] - (eyesHip.y - hipShape.y),
    p.head[2] - (left[2] * eyesHip.x + back[2] * eyesHip.z),
  ];
  const cam = shape.map((s): V3 => [hip[0] + left[0] * s.x + back[0] * s.z, hip[1] + s.y, hip[2] + left[2] * s.x + back[2] * s.z]);
  return { cam, hip };
}

/**
 * 合成の人たち → MediaPipe の PoseLandmarker と同じ形の結果（landmarks = 画像の正規化座標、worldLandmarks = 腰の中点が原点・
 * y 下・z はカメラから遠ざかる向きが + の実寸）。?fakeperson=1 とテストで使う
 */
export function fakeMirrorPose(people: readonly FakeMirrorPerson[], m: ViewMapping): { landmarks: BodyLandmark[][]; worldLandmarks: BodyLandmark[][] } {
  return poseFromCamPoints(
    people.map((p) => fakeMirrorPoints(p).cam),
    m,
  );
}

/**
 * カメラ座標系の 33 点（人ごと）→ MediaPipe の PoseLandmarker と同じ形の結果（landmarks = 画像の正規化座標、worldLandmarks = 腰の中点が原点・
 * カメラの軸に沿った y 下・z 奥の実寸）。カメラの後ろに回った点は visibility 0
 */
export function poseFromCamPoints(people: readonly (readonly V3[])[], m: ViewMapping): { landmarks: BodyLandmark[][]; worldLandmarks: BodyLandmark[][] } {
  const landmarks: BodyLandmark[][] = [];
  const worldLandmarks: BodyLandmark[][] = [];
  for (const cam of people) {
    const hip: V3 = [(cam[23][0] + cam[24][0]) / 2, (cam[23][1] + cam[24][1]) / 2, (cam[23][2] + cam[24][2]) / 2];
    const world: BodyLandmark[] = cam.map((c) => ({ x: c[0] - hip[0], y: -(c[1] - hip[1]), z: -(c[2] - hip[2]), visibility: 1 }));
    const img: BodyLandmark[] = cam.map((c, i) => {
      const proj = projectToImage({ x: c[0], y: c[1], z: c[2] }, m);
      return proj ? { x: proj.x, y: proj.y, z: world[i].z, visibility: 1 } : { x: 0.5, y: 0.5, z: 0, visibility: 0 };
    });
    landmarks.push(img);
    worldLandmarks.push(world);
  }
  return { landmarks, worldLandmarks };
}
