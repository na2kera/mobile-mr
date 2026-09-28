// ex9-1 鏡モード（mirror.html）の純粋関数。three に依存させない（scripts/test-keshin.mjs から import する）。
// 座標は「カメラ座標系 = ワールド」: iPad はスタンドに固定し、three のカメラは原点で −Z を見る（x 右・y 上・z 手前）。
// 人の 3D 化は 09 の body-math.ts（worldLandmarks の実寸の形を画像上の見え方に当てはめる最小二乗）をそのまま使う
import {
  LEFT_ANKLE,
  LEFT_EYE,
  LEFT_HIP,
  LEFT_SHOULDER,
  NOSE,
  RIGHT_ANKLE,
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
): { fwd: [number, number]; source: MirrorPerson["fwdSource"] } {
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
      if (noseDir && Math.hypot(noseDir.x, noseDir.z) >= NOSE_AHEAD_M && noseDir.x * f[0] + noseDir.z * f[1] < 0) f = [-f[0], -f[1]];
      return { fwd: f, source: "shoulders" };
    }
  }
  if (noseDir) {
    const n = Math.hypot(noseDir.x, noseDir.z);
    if (n >= NOSE_AHEAD_M) return { fwd: [noseDir.x / n, noseDir.z / n], source: "nose" };
  }
  // 分からなければ鏡（カメラ）の方を向いているとみなす
  return { fwd: [0, 1], source: "default" };
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
 * 割り当て（前の結果との対応づけ付き）: 1 人の人には化身を 1 体だけ付ける。
 *   1. 前回その化身を付けていた人の頭の位置（last。見失って消えるまでの間だけ持つ）と、今回の人の頭が matchM 以内なら同じ人とみなす
 *      （近い組から順に。1 人の人・1 体の化身は 1 回だけ）
 *   2. 残った化身（参加順）に、残った人を近い順（深度の小さい順）に割り当てる（初めて付ける・見失った人が遠くへ移った）
 *   3. 付かなかった化身のうち、前の位置のすぐ近く（matchM 以内）に今回の人がいる（= その人は別の化身に付いた）ものは displaced:
 *      保持せずにすぐフェードに入れる（同じ人の所に 2 体重ならないように）
 * 持つ状態は化身ごとの「前回の人の位置」だけ（教訓 4）
 */
export function assignMirrorTracked(
  persons: readonly { head: V3; depth: number }[],
  players: readonly { id: string; last: V3 | null }[],
  matchM: number,
): { assign: Map<string, number>; displaced: Set<string> } {
  const assign = new Map<string, number>();
  const used = new Set<number>();
  const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const pairs: [number, string, number][] = [];
  for (const pl of players) {
    if (!pl.last) continue;
    persons.forEach((p, i) => {
      const d = dist(pl.last!, p.head);
      if (d <= matchM) pairs.push([d, pl.id, i]);
    });
  }
  pairs.sort((a, b) => a[0] - b[0]);
  for (const [, id, i] of pairs) {
    if (assign.has(id) || used.has(i)) continue;
    assign.set(id, i);
    used.add(i);
  }
  const freePersons = persons
    .map((p, i) => [p.depth, i] as const)
    .filter(([, i]) => !used.has(i))
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
    .map(([, i]) => i);
  for (const pl of players) {
    if (assign.has(pl.id) || freePersons.length === 0) continue;
    // 前の位置の近くに今回の人がいる（その人は別の化身に付いた）なら、ここでは付け替えない（displaced でフェード）
    if (pl.last && persons.some((p) => dist(pl.last!, p.head) <= matchM)) continue;
    const i = freePersons.shift()!;
    assign.set(pl.id, i);
    used.add(i);
  }
  const displaced = new Set<string>();
  for (const pl of players) {
    if (assign.has(pl.id) || !pl.last) continue;
    if (persons.some((p) => dist(pl.last!, p.head) <= matchM)) displaced.add(pl.id);
  }
  return { assign, displaced };
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
