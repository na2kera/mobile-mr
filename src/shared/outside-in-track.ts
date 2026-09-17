// 08-3 アウトサイドイン（docs/space-stability-options.md §4 の 2a）の純粋な数学。three.js に依存しない
// （Node の回帰テスト scripts/test-08-3-outside-in.mjs から import するため。.ts 付き import も Node の ESM 解決のため）。
// 行列は marker-layout.ts と同じ列優先 16 要素（three.js の Matrix4.elements 互換）。
//
// 座標系:
//   - field 座標系 = 08 と同じ（正面の壁のマーカーが原点。X 右・Y 上・+Z 壁から部屋側）。コートはここに固定
//   - トラッカー（PC の Web カメラ）のカメラ座標系 = marker-detector.ts と同じ three.js 規約（X 右・Y 上・-Z 前方）。
//     検出器が返す各マーカーの姿勢は「マーカー → カメラ」
//   - 原点合わせ: 配置が分かっているマーカー（原点 = 正面の壁 / 08 の追加マーカー = 床など）を同じカメラで見て
//     「カメラ → field」を決める（camToFieldFromOrigin）。以後、ゴーグルのマーカーの姿勢に掛けて field 座標系に直す
//   - ゴーグルのマーカーは前面に貼る（マーカーの +Z = 面から視点側 = プレイヤーの正面）。位置はマーカーの中心
//     （必要なら eyeBackM ぶん後ろ = スマホのカメラ）、向きは +Z を水平面に射影したヨーだけ採る
//     （傾きは採らない: 1 枚のマーカーの傾きは信用できない（issue #54）。ヨーもスマホのジャイロの補正にしか使わない）
//   - スマホ側: アンカー（field → ワールド）は Y 回転 φ と並進だけ（ワールドの上 = ジャイロの重力の上 = field の Y）。
//     φ = ワールドでのカメラのヨー − トラッカーが測ったヨー。並進 = カメラ位置 − R_y(φ)・（field 座標系での自分の位置）
import type { V3 } from "./surface.ts";
import { MAX_MARKER_ID, invertRigid, mulMat4, transformPoint } from "./marker-layout.ts";

/** 向き（単位ベクトル。水平成分だけ見る）→ ヨー [rad]。0 = -Z（正面の壁）を向く、+ で左（three.js の Y 回転と同じ向き） */
export function yawOfForward(f: V3): number {
  return Math.atan2(-f[0], -f[2]);
}

/** ヨー → 水平な向き（単位ベクトル） */
export function forwardOfYaw(yaw: number): V3 {
  return [-Math.sin(yaw), 0, -Math.cos(yaw)];
}

/** 角度を (-π, π] に畳む */
export function wrapAngle(a: number): number {
  let r = a % (2 * Math.PI);
  if (r > Math.PI) r -= 2 * Math.PI;
  if (r <= -Math.PI) r += 2 * Math.PI;
  return r;
}

/** Y 回転 [rad] のクォータニオン [x, y, z, w] */
export function quatOfYaw(yaw: number): [number, number, number, number] {
  return [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
}

/** 列優先 4x4 の回転部分 → クォータニオン [x, y, z, w]（three.js の setFromRotationMatrix と同じ手順） */
export function quatOfMatrix(m: number[]): [number, number, number, number] {
  const m11 = m[0];
  const m12 = m[4];
  const m13 = m[8];
  const m21 = m[1];
  const m22 = m[5];
  const m23 = m[9];
  const m31 = m[2];
  const m32 = m[6];
  const m33 = m[10];
  const trace = m11 + m22 + m33;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    return [(m32 - m23) * s, (m13 - m31) * s, (m21 - m12) * s, 0.25 / s];
  }
  if (m11 > m22 && m11 > m33) {
    const s = 2 * Math.sqrt(1 + m11 - m22 - m33);
    return [0.25 * s, (m12 + m21) / s, (m13 + m31) / s, (m32 - m23) / s];
  }
  if (m22 > m33) {
    const s = 2 * Math.sqrt(1 + m22 - m11 - m33);
    return [(m12 + m21) / s, 0.25 * s, (m23 + m32) / s, (m13 - m31) / s];
  }
  const s = 2 * Math.sqrt(1 + m33 - m11 - m22);
  return [(m13 + m31) / s, (m23 + m32) / s, 0.25 * s, (m21 - m12) / s];
}

/** クォータニオン [x, y, z, w] + 並進 → 列優先 4x4 */
export function matrixOfQuat(q: readonly number[], pos: V3 = [0, 0, 0]): number[] {
  const [x, y, z, w] = q;
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;
  return [1 - (yy + zz), xy + wz, xz - wy, 0, xy - wz, 1 - (xx + zz), yz + wx, 0, xz + wy, yz - wx, 1 - (xx + yy), 0, pos[0], pos[1], pos[2], 1];
}

/**
 * 原点合わせ: 配置が分かっているマーカーの観測（マーカー → カメラ）と、その配置（マーカー → field）から
 * 「カメラ → field」を出す。camToField = markerToField × (markerToCam)⁻¹
 */
export function camToFieldFromOrigin(markerToCam: number[], markerToField: number[]): number[] {
  return mulMat4(markerToField, invertRigid(markerToCam));
}

export type TrackObservation = {
  /** マーカーの中心（eyeBackM ぶん後ろ）[m]（field 座標系） */
  pos: V3;
  /** マーカーの +Z（プレイヤーの正面）を水平面に射影したヨー [rad] */
  yaw: number;
  /** 正対の度合い 0..1（マーカーの法線とカメラへの向きの cos。0 = 真横、1 = 正対。負なら 0） */
  facing: number;
};

/**
 * ゴーグルのマーカーの観測（マーカー → カメラ）を field 座標系の位置とヨーに直す。
 * @param eyeBackM マーカーの中心からスマホのカメラまでの距離 [m]（マーカーの -Z 方向。0 ならマーカーの中心）
 */
export function trackFromObservation(markerToCam: number[], camToField: number[], eyeBackM = 0): TrackObservation {
  const markerToField = mulMat4(camToField, markerToCam);
  const z: V3 = [markerToField[8], markerToField[9], markerToField[10]];
  const center = transformPoint(markerToField, [0, 0, 0]);
  const pos: V3 = [center[0] - z[0] * eyeBackM, center[1] - z[1] * eyeBackM, center[2] - z[2] * eyeBackM];
  // 正対: カメラ座標系でのマーカーの法線（+Z 列）と、マーカーからカメラへの向き（−並進）の cos
  const nz: V3 = [markerToCam[8], markerToCam[9], markerToCam[10]];
  const t: V3 = [markerToCam[12], markerToCam[13], markerToCam[14]];
  const len = Math.hypot(t[0], t[1], t[2]);
  const facing = len > 0 ? Math.max(0, -(nz[0] * t[0] + nz[1] * t[1] + nz[2] * t[2]) / len) : 0;
  return { pos, yaw: yawOfForward(z), facing };
}

/**
 * 観測の品質 0..1。画面上の大きさ（辺長 [px] / fullPx で頭打ち）× 正対の度合い。
 * スマホは品質が高い（正面を向いてマーカーが大きく映った）ときだけヨーを補正する。位置はどの品質でも使う
 */
export function trackQuality(sidePx: number, facing: number, fullPx = 30): number {
  const size = Math.min(1, Math.max(0, sidePx / fullPx));
  return size * Math.min(1, Math.max(0, facing));
}

/**
 * スマホ側: アンカーの Y 回転 φ。ワールド（ジャイロ）でのカメラのヨーと、トラッカーが測った field でのヨーの差
 * （field の向き ＋ φ = ワールドの向き）
 */
export function anchorYaw(cameraYawWorld: number, trackedYaw: number): number {
  return wrapAngle(cameraYawWorld - trackedYaw);
}

/** φ を目標へ角度差の alpha ぶん寄せる（畳んだ差で回す。緩やかなヨーの補正用） */
export function approachAngle(current: number, target: number, alpha: number): number {
  return wrapAngle(current + wrapAngle(target - current) * alpha);
}

/**
 * スマホ側: アンカー（field → ワールド）の姿勢。回転は R_y(φ)、並進は「カメラのワールド位置 − R_y(φ)・（field での自分の位置）」
 * （anchor × posField = camPosWorld になる）
 */
export function anchorPose(phi: number, camPosWorld: V3, posField: V3): { pos: V3; quat: [number, number, number, number] } {
  const c = Math.cos(phi);
  const s = Math.sin(phi);
  // R_y(φ)・p = (c·x + s·z, y, −s·x + c·z)
  const rx = c * posField[0] + s * posField[2];
  const rz = -s * posField[0] + c * posField[2];
  return { pos: [camPosWorld[0] - rx, camPosWorld[1] - posField[1], camPosWorld[2] - rz], quat: quatOfYaw(phi) };
}

/**
 * ゴーグルのマーカー（前面に貼る。+Z = プレイヤーの正面、Y = 上）の「マーカー → field」（列優先）。
 * フェイクカメラで部屋に置くときと、俯瞰画面で枠を描くときに使う
 */
export function goggleMarkerToField(pos: V3, yaw: number): number[] {
  const z = forwardOfYaw(yaw);
  const y: V3 = [0, 1, 0];
  // x = y × z（右手系）
  const x: V3 = [y[1] * z[2] - y[2] * z[1], y[2] * z[0] - y[0] * z[2], y[0] * z[1] - y[1] * z[0]];
  return [x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, pos[0], pos[1], pos[2], 1];
}

export type FakePlayer = { id: number; pos: V3; yawDeg: number };

/**
 * トラッカーのフェイクカメラに置くゴーグルのマーカー: ?fakePlayers=10:-0.5,0,1.5,0;11:0.5,0,1.5,15（ID:x,y,z,ヨー[deg]）。
 * 不正な要素は捨てる
 */
export function parseFakePlayersParam(raw: string | null): FakePlayer[] {
  if (!raw) return [];
  const out: FakePlayer[] = [];
  for (const item of raw.split(";")) {
    const [idRaw, rest] = item.split(":");
    const id = Number(idRaw);
    const v = (rest ?? "").split(",").map(Number);
    if (!Number.isInteger(id) || id < 0 || id > MAX_MARKER_ID || v.length !== 4 || !v.every(Number.isFinite)) continue;
    out.push({ id, pos: [v[0], v[1], v[2]], yawDeg: v[3] });
  }
  return out;
}

/** トラッカーのフェイクカメラの姿勢: ?fakeTrackCam=x,y,z,yaw,pitch（field 座標系 [m] と [deg]。fake-markers.ts の fakeCameraToField の引数） */
export function parseFakeTrackCamParam(raw: string | null, fallback: { pos: V3; yawDeg: number; pitchDeg: number }): { pos: V3; yawDeg: number; pitchDeg: number } {
  const v = (raw ?? "").split(",").map(Number);
  if (v.length !== 5 || !v.every(Number.isFinite)) return fallback;
  return { pos: [v[0], v[1], v[2]], yawDeg: v[3], pitchDeg: v[4] };
}
