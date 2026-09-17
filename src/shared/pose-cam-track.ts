// 08-8 PC カメラ + MediaPipe Pose で人を追う（docs/space-stability-options.md §4 の 2b）の純粋な数学。three.js に依存しない
// （Node の回帰テスト scripts/test-08-8-pose-cam.mjs から import するため。.ts 付き import も Node の ESM 解決のため）。
// 08-3（2a）の「ゴーグルのマーカー」を「PoseLandmarker の体」に置き換えるもので、原点合わせ（カメラ → field）と
// スマホ側（位置 + ジャイロのヨー）は 08-3 の outside-in-track.ts をそのまま使う。
//
// 座標系:
//   - field 座標系 = 08 と同じ（正面の壁のマーカーが原点。X 右・Y 上・+Z 壁から部屋側）
//   - トラッカー（PC の Web カメラ）のカメラ座標系 = three.js 規約（X 右・Y 上・-Z 前方）。body-math.ts の placeBodyLandmarks と同じ
//   - MediaPipe の worldLandmarks: 腰の中点が原点、x は画像の右・y 下・z カメラから遠ざかる向き。尺度はモデルの推定なので、
//     両肩の間の距離が shoulderM（既定 0.4m）になるように全体を拡大縮小してから、09 と同じ最小二乗で画像に当てはめる
//   - 体のヨー = 正面の向き（three.js の Y 回転と同じ: 0 = -Z（正面の壁）を向く、+ で左）。
//     正面 f と本人の左 l の関係: l = 上 × f = (f.z, 0, -f.x)、逆に f = (L − R) × 上 = (−d.z, 0, d.x)（d = 左 − 右）
import type { V3 } from "./surface.ts";
import { transformPoint } from "./marker-layout.ts";
import { yawOfForward } from "./outside-in-track.ts";
import {
  BODY_LANDMARK_COUNT,
  LEFT_EAR,
  LEFT_ELBOW,
  LEFT_EYE,
  LEFT_SHOULDER,
  LEFT_WRIST,
  NOSE,
  RIGHT_EAR,
  RIGHT_ELBOW,
  RIGHT_EYE,
  RIGHT_SHOULDER,
  RIGHT_WRIST,
  placeBodyLandmarks,
  scaleBody,
  solveBodyPlacement,
} from "./body-math.ts";
import type { BodyLandmark } from "./body-math.ts";
import type { ViewMapping } from "./hand-math.ts";

/**
 * 頭の中心（両耳の中点）から見た鼻・両目の中点の位置 [m]（本人の正面へ fwd、上へ up）。合成の体（fake-body.ts）と
 * 同じ大人の平均的な値（肩幅 REF_SHOULDER_M のとき）。鼻・目の観測から「頭の中心」を推定するときに引く。
 * 体の大きさは肩幅の仮定で決めているので、オフセットも肩幅の仮定 / REF_SHOULDER_M 倍する（仮定した体の大きさと揃える）
 */
export const NOSE_OFFSET = { fwd: 0.08, up: -0.01 };
export const EYES_OFFSET = { fwd: 0.06, up: 0.02 };
/** NOSE_OFFSET / EYES_OFFSET を測った体の肩幅 [m]（fake-body.ts の合成の体の両肩の間） */
export const REF_SHOULDER_M = 0.36;
/**
 * 両耳が見えるときの肩の向きの重み（耳の重みに対する倍率）。ヨーはスマホの φ（アンカーの Y 回転）の補正に使うので、
 * 「頭（ゴーグル）の向き」に近い耳を優先し、体の向き（肩）は耳が見えないときの代わりにする
 */
export const SHOULDER_YAW_WEIGHT_WITH_EARS = 0.25;
/** 手を挙げている: 手首が頭の中心よりこれだけ上 [m]（頭をかく・髪を触る程度では届かない高さ） */
export const RAISE_MARGIN_M = 0.15;
/** 両肩の水平距離がこれ未満なら向きを出さない（真横を向いて肩が重なっている）[m] */
const MIN_SHOULDER_SPAN_M = 0.02;

/** Web カメラの写像（歪みなしのピンホール。焦点距離 = 長辺 / 2 / tan(水平 FOV / 2)。08-3 のトラッカーと同じ換算） */
export function webcamViewMapping(width: number, height: number, hFovDeg: number): ViewMapping {
  const focal = Math.max(width, height) / 2 / Math.tan((hFovDeg * Math.PI) / 360);
  return { tanHalfFov: height / 2 / focal, eyeAspect: width / height, repeatX: 1, repeatY: 1 };
}

function vis(l: BodyLandmark | undefined): number {
  return l?.visibility ?? 1;
}

/**
 * worldLandmarks の尺度: 両肩の 3D 距離が shoulderM になる倍率。肩が見えない・退化しているなら null
 * （体の実寸の仮定。精度はこれに依存する: 肩幅が 10% 違えば距離も 10% ずれる）
 */
export function shoulderScale(world: readonly BodyLandmark[], landmarks: readonly BodyLandmark[], shoulderM: number, minVisibility: number): number | null {
  const l = world[LEFT_SHOULDER];
  const r = world[RIGHT_SHOULDER];
  if (!l || !r) return null;
  if (vis(landmarks[LEFT_SHOULDER]) < minVisibility || vis(landmarks[RIGHT_SHOULDER]) < minVisibility) return null;
  const d = Math.hypot(l.x - r.x, l.y - r.y, l.z - r.z);
  if (!(d > 0.05)) return null;
  return shoulderM / d;
}

/** 水平面での「左 − 右」の差 → 正面の単位ベクトル（f = d × 上）。水平成分が短すぎれば null */
function forwardFromLeftRight(left: V3, right: V3): V3 | null {
  const dx = left[0] - right[0];
  const dz = left[2] - right[2];
  const len = Math.hypot(dx, dz);
  if (len < MIN_SHOULDER_SPAN_M) return null;
  return [-dz / len, 0, dx / len];
}

export type BodyYaw = {
  /** 正面の向き [rad]（0 = -Z、+ で左） */
  yaw: number;
  /** 正面の単位ベクトル（水平） */
  forward: V3;
};

/**
 * 体（頭）のヨー。両肩の向き（左 − 右）と両耳の向きを可視性で重み付けして足す。両耳が見えるときは耳を優先し、
 * 肩の重みを SHOULDER_YAW_WEIGHT_WITH_EARS 倍に下げる（首だけ回したときに体の向きへ引っ張られないように）。
 * @param field 33 点の field 座標系での位置
 * @param landmarks 可視性の判定用（MediaPipe の landmarks）
 */
export function bodyYaw(field: readonly V3[], landmarks: readonly BodyLandmark[], minVisibility: number): BodyYaw | null {
  let sx = 0;
  let sz = 0;
  const add = (li: number, ri: number, scale: number): boolean => {
    const w = Math.min(vis(landmarks[li]), vis(landmarks[ri]));
    if (w < minVisibility) return false;
    const f = forwardFromLeftRight(field[li], field[ri]);
    if (!f) return false;
    sx += f[0] * w * scale;
    sz += f[2] * w * scale;
    return true;
  };
  const ears = add(LEFT_EAR, RIGHT_EAR, 1);
  add(LEFT_SHOULDER, RIGHT_SHOULDER, ears ? SHOULDER_YAW_WEIGHT_WITH_EARS : 1);
  const len = Math.hypot(sx, sz);
  if (len < 1e-6) return null;
  const forward: V3 = [sx / len, 0, sz / len];
  return { yaw: yawOfForward(forward), forward };
}

export type HeadEstimate = {
  /** 頭の中心（両耳の中点に相当）[m]（field 座標系） */
  pos: V3;
  /** どこから出したか: ears = 両耳（+ 鼻・目）、ear-nose = 片耳 + 鼻、shoulders = 肩の中点 + 首の長さ */
  source: "ears" | "ear-nose" | "shoulders";
};

/**
 * 頭の中心。両耳が見えれば、両耳の中点・鼻・両目の中点それぞれから「頭の中心」を推定し（鼻と目は正面方向のオフセットを引く）、
 * 可視性で重み付けして平均する（ゴーグルで目が隠れると目の重みは 0 に近づく）。
 * 片耳しか見えなければ、見えている耳と鼻から出す（耳は頭の中心の真横にあるので「正面方向の位置」を、鼻は正面にあるので
 * 「横方向の位置」を受け持つ。高さは両方の可視性の重み付き平均）。
 * 耳も鼻も揃わなければ、両肩の中点 + 上へ neckM（首の長さの仮定）に落とす。肩も見えなければ null
 * @param forward 体の正面（bodyYaw。鼻・目のオフセットの向きに使う）
 */
export function headCenter(
  field: readonly V3[],
  landmarks: readonly BodyLandmark[],
  forward: V3,
  opts: { minVisibility: number; neckM: number; shoulderM?: number },
): HeadEstimate | null {
  const k = (opts.shoulderM ?? REF_SHOULDER_M) / REF_SHOULDER_M;
  const earW = Math.min(vis(landmarks[LEFT_EAR]), vis(landmarks[RIGHT_EAR]));
  if (earW >= opts.minVisibility) {
    let sw = 0;
    const s: V3 = [0, 0, 0];
    const add = (p: V3, w: number) => {
      s[0] += p[0] * w;
      s[1] += p[1] * w;
      s[2] += p[2] * w;
      sw += w;
    };
    add(mid(field[LEFT_EAR], field[RIGHT_EAR]), earW);
    const noseW = vis(landmarks[NOSE]);
    if (noseW >= opts.minVisibility) add(offsetBack(field[NOSE], forward, NOSE_OFFSET, k), noseW);
    const eyeW = Math.min(vis(landmarks[LEFT_EYE]), vis(landmarks[RIGHT_EYE]));
    if (eyeW >= opts.minVisibility) add(offsetBack(mid(field[LEFT_EYE], field[RIGHT_EYE]), forward, EYES_OFFSET, k), eyeW);
    return { pos: [s[0] / sw, s[1] / sw, s[2] / sw], source: "ears" };
  }
  const leftW = vis(landmarks[LEFT_EAR]);
  const rightW = vis(landmarks[RIGHT_EAR]);
  const oneEarW = Math.max(leftW, rightW);
  const noseW = vis(landmarks[NOSE]);
  if (oneEarW >= opts.minVisibility && noseW >= opts.minVisibility) {
    const ear = field[leftW >= rightW ? LEFT_EAR : RIGHT_EAR];
    const nb = offsetBack(field[NOSE], forward, NOSE_OFFSET, k);
    // 水平: 鼻から戻した点を、正面方向にだけ耳の位置へ寄せる（横方向は鼻、正面方向は耳）
    const along = (ear[0] - nb[0]) * forward[0] + (ear[2] - nb[2]) * forward[2];
    const y = (ear[1] * oneEarW + nb[1] * noseW) / (oneEarW + noseW);
    return { pos: [nb[0] + forward[0] * along, y, nb[2] + forward[2] * along], source: "ear-nose" };
  }
  const shW = Math.min(vis(landmarks[LEFT_SHOULDER]), vis(landmarks[RIGHT_SHOULDER]));
  if (shW < opts.minVisibility) return null;
  const m = mid(field[LEFT_SHOULDER], field[RIGHT_SHOULDER]);
  return { pos: [m[0], m[1] + opts.neckM, m[2]], source: "shoulders" };
}

function mid(a: V3, b: V3): V3 {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
}

/** 顔の点から頭の中心へ戻す（正面へ fwd・上へ up だけ前にある点なので、それを引く。k = 体の大きさの倍率） */
function offsetBack(p: V3, forward: V3, o: { fwd: number; up: number }, k: number): V3 {
  return [p[0] - forward[0] * o.fwd * k, p[1] - o.up * k, p[2] - forward[2] * o.fwd * k];
}

/**
 * 手を挙げているか: どちらかの側で、手首が頭の中心より marginM（既定 15cm）以上高く、かつ同じ側の肘が肩より高い
 * （手首・肘・肩とも見えている）。頭をかく・髪を触る動作（肘が肩の高さより下）で割り当たらないように
 */
export function isHandRaised(field: readonly V3[], landmarks: readonly BodyLandmark[], headY: number, minVisibility: number, marginM = RAISE_MARGIN_M): boolean {
  for (const [wrist, elbow, shoulder] of [
    [LEFT_WRIST, LEFT_ELBOW, LEFT_SHOULDER],
    [RIGHT_WRIST, RIGHT_ELBOW, RIGHT_SHOULDER],
  ]) {
    if (vis(landmarks[wrist]) < minVisibility || vis(landmarks[elbow]) < minVisibility || vis(landmarks[shoulder]) < minVisibility) continue;
    if (field[wrist][1] > headY + marginM && field[elbow][1] > field[shoulder][1]) return true;
  }
  return false;
}

export type PersonObservation = {
  /** 送る位置 = スマホのカメラ（頭の中心から正面へ eyeFwdM）[m]（field 座標系） */
  pos: V3;
  /** 頭の中心 [m]（field 座標系） */
  head: V3;
  headSource: HeadEstimate["source"];
  yaw: number;
  /** 品質 0..1（肩の画面上の幅 × 正対の度合い × 肩の可視性） */
  quality: number;
  /** 手を挙げている（割当の儀式） */
  raised: boolean;
  /** 33 点の可視性の合計（同じ人物の重複検出をまとめるとき、大きい方を残す） */
  score: number;
  /** カメラからの深度 [m]（腰の中点） */
  depth: number;
  /** 肩の画面上の幅 [px] */
  shoulderPx: number;
  /** 33 点の field 座標系での位置（俯瞰画面の描画用） */
  field: V3[];
};

export type ObserveOptions = {
  /** Web カメラの写像（webcamViewMapping） */
  mapping: ViewMapping;
  /** 推論に渡した画像の大きさ [px]（肩の画面上の幅に使う） */
  imageW: number;
  imageH: number;
  /** カメラ → field（原点合わせで確定したもの。列優先 16 要素） */
  camToField: number[];
  /** 肩幅の実寸の仮定 [m] */
  shoulderM: number;
  /** 首の長さの仮定 [m]（両耳が見えないときの頭の中心 = 肩の中点 + これ） */
  neckM: number;
  /** 頭の中心からスマホのカメラ（ゴーグルの前面）までの距離 [m]（正面へ） */
  eyeFwdM: number;
  minVisibility: number;
  /** 品質が 1 になる肩の画面上の幅 [px] */
  qualityFullPx: number;
};

/**
 * 1 人ぶんの PoseLandmarker の結果（landmarks + worldLandmarks）→ field 座標系の位置・ヨー・品質・手を挙げているか。
 * 解けない（点が足りない・肩が見えない・深度が不正）なら null
 */
export function observePerson(landmarks: readonly BodyLandmark[], worldRaw: readonly BodyLandmark[], o: ObserveOptions): PersonObservation | null {
  if (landmarks.length < BODY_LANDMARK_COUNT || worldRaw.length < BODY_LANDMARK_COUNT) return null;
  const k = shoulderScale(worldRaw, landmarks, o.shoulderM, o.minVisibility);
  if (k === null) return null;
  const world = scaleBody(worldRaw, k);
  const placement = solveBodyPlacement(landmarks, world, o.mapping, o.minVisibility);
  if (!placement) return null;
  const cam = placeBodyLandmarks(landmarks, world, placement, o.mapping);
  const field = cam.map((p) => transformPoint(o.camToField, [p.x, p.y, p.z]));
  const by = bodyYaw(field, landmarks, o.minVisibility);
  if (!by) return null;
  const head = headCenter(field, landmarks, by.forward, o);
  if (!head) return null;
  const pos: V3 = [head.pos[0] + by.forward[0] * o.eyeFwdM, head.pos[1], head.pos[2] + by.forward[2] * o.eyeFwdM];
  // 正対の度合い: 体の正面と「頭 → カメラ」（水平）の cos（08-3 のマーカーの facing と同じく負なら 0）
  const camPos: V3 = [o.camToField[12], o.camToField[13], o.camToField[14]];
  const tx = camPos[0] - head.pos[0];
  const tz = camPos[2] - head.pos[2];
  const tl = Math.hypot(tx, tz);
  const facing = tl > 0 ? Math.max(0, (by.forward[0] * tx + by.forward[2] * tz) / tl) : 0;
  const ls = landmarks[LEFT_SHOULDER];
  const rs = landmarks[RIGHT_SHOULDER];
  const shoulderPx = Math.hypot((ls.x - rs.x) * o.imageW, (ls.y - rs.y) * o.imageH);
  const shVis = Math.min(vis(ls), vis(rs));
  const quality = Math.min(1, Math.max(0, shoulderPx / o.qualityFullPx)) * facing * Math.min(1, shVis);
  return {
    pos,
    head: head.pos,
    headSource: head.source,
    yaw: by.yaw,
    quality,
    raised: isHandRaised(field, landmarks, head.pos[1], o.minVisibility),
    score: landmarks.reduce((sum, l) => sum + vis(l), 0),
    depth: placement.depth,
    shoulderPx,
    field,
  };
}

// ---- フェイクカメラ用の合成の体（fake-body.ts の形を部屋に置く） ----

export type FakePoseBody = {
  /** 頭の中心（両耳の中点）[m]（field 座標系） */
  head: V3;
  /** 正面の向き [deg]（0 = -Z、+ で左） */
  yawDeg: number;
  /** 右手を挙げている */
  raised: boolean;
};

/**
 * ?fakeBodies=x,y,z,yaw;x,y,z,yaw（頭の中心 [m] とヨー [deg]）。不正な要素は捨てる
 */
export function parseFakeBodiesParam(raw: string | null): FakePoseBody[] {
  if (!raw) return [];
  const out: FakePoseBody[] = [];
  for (const item of raw.split(";")) {
    const v = item.split(",").map(Number);
    if (v.length !== 4 || !v.every(Number.isFinite)) continue;
    out.push({ head: [v[0], v[1], v[2]], yawDeg: v[3], raised: false });
  }
  return out;
}

/**
 * 合成の体の形（fake-body.ts の syntheticBodyShape: 本人の左 +x・上 +y・後ろ +z、腰の中点が原点）を、
 * 肩幅 shoulderM に拡大縮小し、raised なら右手を頭の上に挙げたものにする
 */
export function fakeShape(base: readonly { x: number; y: number; z: number }[], shoulderM: number, raised: boolean): { x: number; y: number; z: number }[] {
  const span = Math.abs(base[LEFT_SHOULDER].x - base[RIGHT_SHOULDER].x);
  const k = shoulderM / span;
  const s = base.map((p) => ({ x: p.x * k, y: p.y * k, z: p.z * k }));
  if (raised) {
    // 右肘を肩の高さの外側に、右手首と指を頭の上へ（本人の右 = -x）
    const sh = s[RIGHT_SHOULDER];
    const top = s[LEFT_EAR].y + 0.3;
    s[14] = { x: sh.x - 0.05, y: sh.y + 0.25, z: 0 };
    s[RIGHT_WRIST] = { x: sh.x - 0.02, y: top, z: 0 };
    s[18] = { x: sh.x - 0.04, y: top + 0.08, z: 0 };
    s[20] = { x: sh.x - 0.02, y: top + 0.09, z: -0.02 };
    s[22] = { x: sh.x + 0.01, y: top + 0.05, z: -0.03 };
  }
  return s;
}

/**
 * 部屋（field）に置いた合成の体を、トラッカーのカメラ座標系での fake-body.ts の FakeBody（腰の位置 + カメラの軸に合わせた形）にする。
 * fakePoseResult は「形の x = 画像の右、y = 上、z = カメラから遠ざかる向き」と見なすので、field での各点をカメラ座標系
 * （three.js 規約: z は手前が +）に直してから z の符号を反転する
 * @param shape fakeShape の結果（本人の左 +x・上 +y・後ろ +z、腰の中点が原点）
 * @param fieldToCam field → カメラ（列優先）
 */
export function fakeBodyInCamera(body: FakePoseBody, shape: readonly { x: number; y: number; z: number }[], fieldToCam: number[]): { hip: { x: number; y: number; z: number }; shapeYUp: { x: number; y: number; z: number }[] } {
  const yaw = (body.yawDeg * Math.PI) / 180;
  const f: V3 = [-Math.sin(yaw), 0, -Math.cos(yaw)];
  const l: V3 = [f[2], 0, -f[0]];
  // 形の点 → field: 腰 + 左 * x + 上 * y + 後ろ(-f) * z
  const toField = (p: { x: number; y: number; z: number }, hip: V3): V3 => [hip[0] + l[0] * p.x - f[0] * p.z, hip[1] + p.y, hip[2] + l[2] * p.x - f[2] * p.z];
  const earMid = { x: (shape[LEFT_EAR].x + shape[RIGHT_EAR].x) / 2, y: (shape[LEFT_EAR].y + shape[RIGHT_EAR].y) / 2, z: (shape[LEFT_EAR].z + shape[RIGHT_EAR].z) / 2 };
  const earOffset = toField(earMid, [0, 0, 0]);
  const hipField: V3 = [body.head[0] - earOffset[0], body.head[1] - earOffset[1], body.head[2] - earOffset[2]];
  const hipCam = transformPoint(fieldToCam, hipField);
  const shapeYUp = shape.map((p) => {
    const c = transformPoint(fieldToCam, toField(p, hipField));
    return { x: c[0] - hipCam[0], y: c[1] - hipCam[1], z: -(c[2] - hipCam[2]) };
  });
  return { hip: { x: hipCam[0], y: hipCam[1], z: hipCam[2] }, shapeYUp };
}
