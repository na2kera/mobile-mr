// ex9-1-keshin（化身）の純粋な数学: 体の向き（body yaw）、化身の配置（頭の姿勢 → 化身のモデル行列・腰のクリッピング平面）、
// 主観の見上げフェード、受信側の「信用できるか」による薄さ。
// three.js に依存させない（Node のテスト scripts/test-keshin.mjs から import するため。.ts 付き import は Node の ESM 解決のため）。
// 行列は three.js の Matrix4.elements と同じ列優先 16 要素（Matrix4.fromArray でそのまま読める）。
// 座標系: Y が鉛直上（主観はジャイロのワールド、俯瞰はマーカー座標系。どちらも重力で水平）。
// モデルは +Y 上・正面 +Z・原点は足元の床・全高 MODEL_HEIGHT_M（Blender の README の仕様）
import { mulMat4, transformPoint } from "../../src/shared/marker-layout.ts";

export type V3 = [number, number, number];
export type Quat = [number, number, number, number];

/** GLB の全高 [m]（3 体とも 5.0。userData.height_m） */
export const MODEL_HEIGHT_M = 5;
/** 化身の上半身の前面と本人の頭の中心の最小の間隔 [m] */
export const BACK_CLEARANCE_M = 0.25;
/** 見上げ・見下ろしの符号 s を ±1 に切り替える幅 [deg]（水平付近で符号が飛ばないよう、この範囲だけ線形に混ぜる） */
export const PITCH_SIGN_BLEND_DEG = 10;

const DEG = Math.PI / 180;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** クォータニオン [x, y, z, w] でベクトルを回す */
export function rotateByQuat(q: Quat, v: V3): V3 {
  const [qx, qy, qz, qw] = q;
  // t = 2 q × v, v' = v + w t + q × t
  const tx = 2 * (qy * v[2] - qz * v[1]);
  const ty = 2 * (qz * v[0] - qx * v[2]);
  const tz = 2 * (qx * v[1] - qy * v[0]);
  return [v[0] + qw * tx + (qy * tz - qz * ty), v[1] + qw * ty + (qz * tx - qx * tz), v[2] + qw * tz + (qx * ty - qy * tx)];
}

/**
 * 頭の姿勢から体の向き（水平の単位ベクトル [x, z]）を出す。
 * f = h(−Z_cam) + s·h(−Y_cam)（h は水平面への射影、s は見上げなら +1・見下ろしなら −1）を正規化。
 * 真上・真下を見て前方ベクトルの水平成分が消えても、画面の下向き（−Y_cam）の水平成分が体の前（見上げ）/ 後ろ（見下ろし）を指すので
 * 向きが決まる。s は水平 ±PITCH_SIGN_BLEND_DEG の間だけ線形に混ぜる（首を傾けたまま水平を横切ったときに向きが飛ばないように。
 * 首を傾けていなければ水平付近の h(−Y_cam) はほぼ 0 なので結果は変わらない）。決まらなければ null
 */
export function bodyForward(q: Quat): [number, number] | null {
  const fwd = rotateByQuat(q, [0, 0, -1]);
  const down = rotateByQuat(q, [0, -1, 0]);
  const s = clamp(fwd[1] / Math.sin(PITCH_SIGN_BLEND_DEG * DEG), -1, 1);
  const x = fwd[0] + s * down[0];
  const z = fwd[2] + s * down[2];
  const len = Math.hypot(x, z);
  if (!(len > 1e-6)) return null;
  return [x / len, z / len];
}

/** 水平の向き [x, z] → ヨー [rad]（+Z が 0、+X が +π/2。モデルの rotation.y にそのまま入れると正面 +Z がこの向きを向く） */
export function yawOfForward(f: readonly [number, number]): number {
  return Math.atan2(f[0], f[1]);
}

/** ヨー [rad] → 水平の単位ベクトル [x, z] */
export function forwardOfYaw(yaw: number): [number, number] {
  return [Math.sin(yaw), Math.cos(yaw)];
}

/** 角度を (−π, π] に */
export function wrapAngle(a: number): number {
  let r = a % (2 * Math.PI);
  if (r <= -Math.PI) r += 2 * Math.PI;
  if (r > Math.PI) r -= 2 * Math.PI;
  return r;
}

/**
 * 送信側の体の向きの指数平滑（状態は送信側のこの 1 つだけ。受信側は受け取った向きをそのまま使う）。
 * prev が null（初回）なら target。tauSec は時定数 [s]（?yawSmoothSec=）。±π をまたいでも近い側へ回る
 */
export function smoothYaw(prev: number | null, target: number, dtSec: number, tauSec: number): number {
  if (prev === null || !Number.isFinite(prev) || !(tauSec > 0)) return wrapAngle(target);
  const k = 1 - Math.exp(-Math.max(0, dtSec) / tauSec);
  return wrapAngle(prev + wrapAngle(target - prev) * k);
}

/** 見上げ角 [deg]（カメラの前方の水平からの角度。上が +） */
export function lookUpDeg(q: Quat): number {
  const fwd = rotateByQuat(q, [0, 0, -1]);
  return Math.asin(clamp(fwd[1], -1, 1)) / DEG;
}

/**
 * 主観の化身の見上げフェード 0..1: thresholdDeg（?lookUpDeg=）以上で 1、thresholdDeg − rampDeg 以下で 0、その間は線形
 */
export function selfLookFade(lookDeg: number, thresholdDeg: number, rampDeg = 10): number {
  return clamp((lookDeg - (thresholdDeg - rampDeg)) / rampDeg, 0, 1);
}

/**
 * 受信側の「信用できるか」による化身の薄さの係数（null = 化身を出さない）。
 *   marker → 1、gyro → ageMs が staleMs で 0.5 まで線形に薄く、以降は 0.5 のまま（位置は最後の値に止める）、none → null
 */
export function trackFade(track: "marker" | "gyro" | "none", ageMs: number | null, staleMs: number): number | null {
  if (track === "none") return null;
  if (track === "marker") return 1;
  const age = Math.max(0, ageMs ?? Infinity);
  return age >= staleMs ? 0.5 : 1 - (0.5 * age) / staleMs;
}

/** gyro で staleMs を過ぎたら位置を最後の値に止める（受信側がこの判定で新しい pos を無視する） */
export function isPositionFrozen(track: "marker" | "gyro" | "none", ageMs: number | null, staleMs: number): boolean {
  return track === "gyro" && (ageMs ?? Infinity) >= staleMs;
}

/** 表示高さ [m] → モデルの拡大率 */
export function keshinScale(heightM: number): number {
  return heightM / MODEL_HEIGHT_M;
}

/**
 * 背中からの距離（化身の原点を頭の真下からどれだけ後ろに置くか）[m]: 上半身の前面（モデル座標の +Z 側の端 frontZ）×拡大率 + 間隔。
 * これで「上半身の前面が本人の頭の中心から少なくとも clearance 後ろ」になる（?keshinBack= で上書き）
 */
export function autoBack(frontZ: number, scale: number, clearance = BACK_CLEARANCE_M): number {
  return frontZ * scale + clearance;
}

/**
 * 主観（前傾）の後ろへのずらし量の既定 [m]: 腰の切断面を支点に leanDeg 前傾したとき、化身の頭（モデル座標の head）が
 * 本人の目より faceAhead だけ前（本人の頭上のやや前）に来る値。見上げたときに化身の顔〜胸が頭上に見える
 */
export function selfAutoBack(head: { y: number; z: number }, cutY: number, scale: number, leanDeg: number, faceAhead: number): number {
  const a = leanDeg * DEG;
  const hy = (head.y - cutY) * scale;
  const hz = head.z * scale;
  return hy * Math.sin(a) + hz * Math.cos(a) - faceAhead;
}

export type KeshinFrameInput = {
  /** 本人の頭（カメラ）の位置 */
  head: V3;
  /** 体の向き（yawOfForward） */
  yaw: number;
  /** 頭から推定の床までの高さ [m]（?eyeH=）。化身の足元（原点）= 頭 − eyeH */
  eyeH: number;
  /** 化身の原点を頭の真下からどれだけ後ろに置くか [m] */
  back: number;
  /** 腰の切断面の高さ（モデル座標 [m]。クリッピング平面と前傾の支点） */
  cutY: number;
  /** モデルの拡大率 */
  scale: number;
  /** せり上がりのずれ [m]（keshin-timeline.ts の riseM。クリッピング平面は動かない） */
  riseM: number;
  /** 前傾 [deg]（主観だけ。他人用は 0） */
  leanDeg: number;
};

function translation(x: number, y: number, z: number): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
}
function rotationY(a: number): number[] {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
}
function rotationX(a: number): number[] {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1];
}
function scaling(k: number): number[] {
  return [k, 0, 0, 0, 0, k, 0, 0, 0, 0, k, 0, 0, 0, 0, 1];
}

/** 本人の足元（推定の床）: 頭の真下 eyeH */
export function keshinFloor(p: KeshinFrameInput): V3 {
  return [p.head[0], p.head[1] - p.eyeH, p.head[2]];
}

/** 腰の切断面の支点の変換（足元 → 体の向き → 背中側へ back・腰の高さ → 前傾）。モデル行列とクリッピング平面の共通部分 */
function pivotMatrix(p: KeshinFrameInput): number[] {
  const floor = keshinFloor(p);
  const cutW = p.cutY * p.scale;
  let m = mulMat4(translation(floor[0], floor[1], floor[2]), rotationY(p.yaw));
  m = mulMat4(m, translation(0, cutW, -p.back));
  return mulMat4(m, rotationX(p.leanDeg * DEG));
}

/**
 * 化身のモデル行列（モデル座標 → ワールド）。M = T(床) · Ry(yaw) · T(0, 腰, −back) · Rx(前傾) · T(0, −腰 + rise, 0) · S(scale)。
 * 前傾は腰の切断面を支点に前（体の向き）へ倒す。せり上がりは支点の中で下からずらすだけなので、クリッピング平面は腰に残る
 */
export function keshinModelMatrix(p: KeshinFrameInput): number[] {
  const cutW = p.cutY * p.scale;
  return mulMat4(mulMat4(pivotMatrix(p), translation(0, -cutW + p.riseM, 0)), scaling(p.scale));
}

/** 腰のクリッピング平面（ワールド）。normal の側（上）を残す。前傾すると平面も一緒に傾く */
export function keshinCutPlane(p: KeshinFrameInput): { point: V3; normal: V3 } {
  const m = pivotMatrix(p);
  const point = transformPoint(m, [0, 0, 0]);
  const up = transformPoint(m, [0, 1, 0]);
  return { point, normal: [up[0] - point[0], up[1] - point[1], up[2] - point[2]] };
}

/** モデル座標の点をワールドへ（テスト・診断用） */
export function keshinModelToWorld(p: KeshinFrameInput, local: V3): V3 {
  return transformPoint(keshinModelMatrix(p), local);
}

/**
 * サーバーのステージ開始時刻（changedAt）を受信時刻基準のローカル時刻 [ms] に直す（経過 = serverNow − changedAt を受信時刻から引く）。
 * changedAt が null（一度も出していない）なら −Infinity（ずっと前 = 演出なしで最後の状態）
 */
export function stageStartLocal(changedAt: number | null, serverNow: number, recvLocalMs: number): number {
  return changedAt === null ? -Infinity : recvLocalMs - (serverNow - changedAt);
}

/**
 * 受け取った pose の「サーバーが受け取った時刻」をローカル時刻に直す。welcome / join のスナップショットの pose は
 * poseAgeMs だけ前に届いていたものなので、受信時刻をその分だけ過去にずらす（今届いた marker と誤解しない）。
 * 通常の pose メッセージは poseAgeMs 無し = 受信時刻そのもの。俯瞰画面と、段階 2 のスマホ側で同じ関数を使う
 */
export function poseReceivedLocal(recvLocalMs: number, poseAgeMs: number | undefined): number {
  return recvLocalMs - Math.max(0, Number.isFinite(poseAgeMs) ? (poseAgeMs as number) : 0);
}

/**
 * 受信側のいまの「信用できるか」: 受け取った pose の track と、受け取ってからの経過 sinceMs（poseReceivedLocal 基準）から決める。
 *   pose 無し → nopose、none → none（位置未確定）、marker でも noPoseMs を超えて次が来なければ gyro 扱い、
 *   gyro 扱いの ageMs は送信側の ageMs + 受け取ってからの経過
 */
export function effectiveTrack(
  pose: { track: "marker" | "gyro" | "none"; ageMs: number | null } | undefined,
  sinceMs: number,
  noPoseMs: number,
): { track: "marker" | "gyro" | "none" | "nopose"; ageMs: number | null } {
  if (!pose) return { track: "nopose", ageMs: null };
  if (pose.track === "none") return { track: "none", ageMs: null };
  const since = Math.max(0, sinceMs);
  if (pose.track === "marker" && since <= noPoseMs) return { track: "marker", ageMs: 0 };
  // marker を gyro に移すときも送信元の ageMs（最後にマーカーを見てから送るまで）を足す
  return { track: "gyro", ageMs: (pose.ageMs ?? 0) + since };
}

// ---- 段階 2: 相手の化身を自分の画面に描く ----

/** マーカー座標系の点 → 自分のワールド（アンカーの位置 + 回転。アンカーは重力で水平化済みなので回転はヨーだけのはず） */
export function markerToWorld(anchorPos: V3, anchorQuat: Quat, p: V3): V3 {
  const r = rotateByQuat(anchorQuat, p);
  return [anchorPos[0] + r[0], anchorPos[1] + r[1], anchorPos[2] + r[2]];
}

/** 相手の体の向き（マーカー座標系の水平 [x, z]）→ 自分のワールドのヨー（水平面へ射影してから） */
export function markerFwdToWorldYaw(anchorQuat: Quat, fwd: readonly [number, number]): number {
  const v = rotateByQuat(anchorQuat, [fwd[0], 0, fwd[1]]);
  return Math.atan2(v[0], v[2]);
}

/**
 * 表示中の値を目標へ寄せる（時定数 tauSec の指数平滑。持つ状態は「表示中の値」1 つだけ）。
 * 目標が snapM 以上離れていたら寄せずに移す（遠い跳びをゆっくり滑らせると、化身が空中を長く移動して見えるため）。
 * gap = 寄せる前の目標との差 [m]（跳びの大きさのログ用）
 */
export function smoothToward(
  shown: V3 | null,
  target: V3,
  dtSec: number,
  tauSec: number,
  snapM: number,
): { pos: V3; snapped: boolean; gap: number } {
  if (shown === null) return { pos: [target[0], target[1], target[2]], snapped: true, gap: 0 };
  const gap = Math.hypot(target[0] - shown[0], target[1] - shown[1], target[2] - shown[2]);
  if (!(tauSec > 0) || gap >= snapM) return { pos: [target[0], target[1], target[2]], snapped: gap >= snapM, gap };
  const k = 1 - Math.exp(-Math.max(0, dtSec) / tauSec);
  return {
    pos: [shown[0] + (target[0] - shown[0]) * k, shown[1] + (target[1] - shown[1]) * k, shown[2] + (target[2] - shown[2]) * k],
    snapped: false,
    gap,
  };
}

/**
 * 相手の化身を描くか・どの薄さで描くか（受信側の見せ方。教訓 2）。
 *   自分のアンカーが無い → 描かない（相手の位置が自分の世界のどこか分からない）
 *   pose 無し / none → 描かない、受け取ってから lostMs を超えた（通信切れ）→ 描かない
 *   marker → 1、gyro → trackFade（staleMs で半分、以降 0.5 で位置を止める）
 */
export function remoteDisplay(
  selfHasAnchor: boolean,
  pose: { track: "marker" | "gyro" | "none"; ageMs: number | null } | undefined,
  sinceMs: number,
  opts: { noPoseMs: number; lostMs: number; staleMs: number },
): { draw: boolean; fade: number; freeze: boolean; reason: string; track: "marker" | "gyro" | "none" | "nopose"; ageMs: number | null } {
  const eff = effectiveTrack(pose, sinceMs, opts.noPoseMs);
  const base = { track: eff.track, ageMs: eff.ageMs };
  if (!selfHasAnchor) return { ...base, draw: false, fade: 0, freeze: false, reason: "self-no-anchor" };
  if (eff.track === "nopose") return { ...base, draw: false, fade: 0, freeze: false, reason: "no-pose" };
  if (eff.track === "none") return { ...base, draw: false, fade: 0, freeze: false, reason: "peer-none" };
  if (sinceMs > opts.lostMs) return { ...base, draw: false, fade: 0, freeze: false, reason: "lost" };
  const fade = trackFade(eff.track, eff.ageMs, opts.staleMs) ?? 0;
  return { ...base, draw: true, fade, freeze: isPositionFrozen(eff.track, eff.ageMs, opts.staleMs), reason: "ok" };
}

/**
 * 画面の画素（gl_FragCoord、描画バッファの px・左下原点）→ 人の形のマスクの座標（0..1、**左上原点**）。
 * 背景の VideoTexture と同じ変換: 眼のビューポート内の位置 p = (frag − vp.xy) / vp.zw → 映像の UV = p × repeat + offset
 * （passthrough-camera.ts の coverUvTransform。左下原点）→ 上下を反転（マスクの行 0 は画像の上）。
 * シェーダー（keshin-occlusion.ts の GLSL）と同じ式。範囲外（背景が映像の外 = zoom < 1 の余白）は null
 */
export function maskUvFromFragment(
  frag: readonly [number, number],
  viewport: readonly [number, number, number, number],
  repeat: readonly [number, number],
  offset: readonly [number, number],
): [number, number] | null {
  const px = (frag[0] - viewport[0]) / viewport[2];
  const py = (frag[1] - viewport[1]) / viewport[3];
  const u = px * repeat[0] + offset[0];
  const v = py * repeat[1] + offset[1];
  if (u < 0 || u > 1 || v < 0 || v > 1) return null;
  return [u, 1 - v];
}
