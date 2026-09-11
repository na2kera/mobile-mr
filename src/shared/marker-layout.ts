// マルチマーカー（issue #30）: 原点マーカー（正面の壁）に加えて、床・左右・背面の壁などに貼った
// 追加マーカーの「原点からの位置と向き」を表す純粋な定義と数学。
//   - 追加マーカーは face（どの面に貼ったか）と pos（field 座標系での中心）だけで表す。向きは face から決まる
//     （部屋は直方体、壁のマーカーは天地を合わせて貼る、床のマーカーは「上」を正面の壁に向ける、が前提）
//   - どのマーカーが見えても「原点マーカー = アンカー」の姿勢に直せるよう、マーカー → field の 4x4 を返す
//   - 配置はサーバーの状態（FieldConfig.markers）で、俯瞰画面から変えて全員に配る（v7 の寸法と同じ経路）
// three.js に依存させない（Node の回帰テスト scripts/test-splatoon.mjs から import するため。
// import に .ts を付けているのも Node の ESM 解決のため）。
// 行列は three.js の Matrix4.elements と同じ列優先 16 要素で表す（Matrix4.fromArray でそのまま読める）
import type { V3 } from "./surface.ts";

/** 貼る面。"wall" は正面（原点マーカーと同じ壁。2 枚目を横に貼るとき） */
export const MARKER_FACES = ["wall", "floor", "left", "right", "back"] as const;
export type MarkerFace = (typeof MARKER_FACES)[number];

export type MarkerPlacement = {
  /** ArUco の ID（ARUCO_MIP_36h12: 0〜249）。原点マーカー（room 設定の markerId）とは別の値 */
  id: number;
  face: MarkerFace;
  /** マーカーの中心（field 座標系 = 原点マーカー座標系 [m]。X 右・Y 上・Z 壁から部屋側） */
  pos: V3;
};

/** 追加マーカーの枚数の上限（四方 + 床 + 予備） */
export const MAX_EXTRA_MARKERS = 8;
/** 辞書 ARUCO_MIP_36h12 の ID の上限 */
export const MAX_MARKER_ID = 249;
/** 原点からの距離の上限 [m]（入力ミスの足切り） */
export const MARKER_POS_LIMIT_M = 20;

export const FACE_LABELS: Record<MarkerFace, string> = {
  wall: "正面",
  floor: "床",
  left: "左",
  right: "右",
  back: "背面",
};

/**
 * 俯瞰画面の入力欄と印刷ページで共有する「おすすめの割り当て」（面 → 既定の ID）。
 * 原点は room 設定の markerId（既定 0）。ID は俯瞰画面で変えられる
 */
export const SUGGESTED_MARKERS: readonly { key: string; face: MarkerFace; id: number; label: string }[] = [
  { key: "floor", face: "floor", id: 1, label: "床" },
  { key: "left", face: "left", id: 2, label: "左の壁" },
  { key: "right", face: "right", id: 3, label: "右の壁" },
  { key: "back", face: "back", id: 4, label: "背面の壁" },
  { key: "wall2", face: "wall", id: 5, label: "正面の壁（2 枚目）" },
];

/**
 * 面ごとの既定の位置（field 座標系 [m]）。コートの各面の中央・原点マーカーと同じ高さ。
 * 「コートの壁 = 現実の壁」の運用ならこのままで良く、部屋がコートより広いときは実測値に直す
 */
export function suggestedMarkerPos(face: MarkerFace, size: { wallW: number; floorDepth: number; floorDrop: number }): V3 {
  switch (face) {
    case "floor":
      return [0, -size.floorDrop, round3(size.floorDepth / 2)];
    case "left":
      return [-round3(size.wallW / 2), 0, round3(size.floorDepth / 2)];
    case "right":
      return [round3(size.wallW / 2), 0, round3(size.floorDepth / 2)];
    case "back":
      return [0, 0, size.floorDepth];
    case "wall":
      return [round3(size.wallW / 3), 0, 0];
  }
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/**
 * 面ごとのマーカー座標系の軸（field 座標系で）。マーカー座標系は marker-detector.ts と同じ
 * X = マーカーの右, Y = マーカーの上, Z = 面から視点側（法線）。
 * 壁: Y = 鉛直上（天地を合わせて貼る）。床: Y = 正面の壁の向き（-Z）。X = Y × Z で右手系
 */
export function markerAxes(face: MarkerFace): { x: V3; y: V3; z: V3 } {
  const y: V3 = face === "floor" ? [0, 0, -1] : [0, 1, 0];
  const z: V3 =
    face === "wall" ? [0, 0, 1] : face === "floor" ? [0, 1, 0] : face === "left" ? [1, 0, 0] : face === "right" ? [-1, 0, 0] : [0, 0, -1];
  return { x: cross(y, z), y, z };
}

/** マーカー座標系 → field 座標系の 4x4（列優先 16 要素。three.js の Matrix4.fromArray 互換） */
export function markerToFieldMatrix(p: MarkerPlacement): number[] {
  const { x, y, z } = markerAxes(p.face);
  // 列優先: 列 0 = x 軸, 列 1 = y 軸, 列 2 = z 軸, 列 3 = 並進
  return [x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, p.pos[0], p.pos[1], p.pos[2], 1];
}

/** 剛体変換（回転 + 並進）の逆行列（列優先 16 要素） */
export function invertRigid(m: number[]): number[] {
  // 回転部分の転置と、-R^T t
  const r = [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]]; // 列優先で転置したもの（列 0 = 元の行 0）
  const tx = m[12];
  const ty = m[13];
  const tz = m[14];
  // R^T の各行 = 元の各列
  const ix = -(m[0] * tx + m[1] * ty + m[2] * tz);
  const iy = -(m[4] * tx + m[5] * ty + m[6] * tz);
  const iz = -(m[8] * tx + m[9] * ty + m[10] * tz);
  return [r[0], r[1], r[2], 0, r[3], r[4], r[5], 0, r[6], r[7], r[8], 0, ix, iy, iz, 1];
}

/** 4x4 の積 a × b（列優先） */
export function mulMat4(a: number[], b: number[]): number[] {
  const out = new Array<number>(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      out[col * 4 + row] = a[row] * b[col * 4] + a[4 + row] * b[col * 4 + 1] + a[8 + row] * b[col * 4 + 2] + a[12 + row] * b[col * 4 + 3];
    }
  }
  return out;
}

/** 点に 4x4 を掛ける（w=1） */
export function transformPoint(m: number[], p: V3): V3 {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}

function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/**
 * 配置の検証（サーバーの rejected の文言と俯瞰画面の表示で共有）。不正なら理由、正しければ null。
 * 床のマーカーの高さは床（-floorDrop）に固定する（床に置くものなので入力させず、寸法から決める）
 */
export function validateMarkerLayout(markers: unknown, originId: number, floorDrop: number): string | null {
  if (!Array.isArray(markers)) return "markers は配列";
  if (markers.length > MAX_EXTRA_MARKERS) return `追加マーカーは ${MAX_EXTRA_MARKERS} 枚まで`;
  const ids = new Set<number>();
  for (const m of markers) {
    if (typeof m !== "object" || m === null) return "markers の要素が不正";
    const { id, face, pos } = m as Record<string, unknown>;
    if (!Number.isInteger(id) || (id as number) < 0 || (id as number) > MAX_MARKER_ID) return `ID は 0〜${MAX_MARKER_ID} の整数`;
    if (id === originId) return `ID ${id} は原点のマーカーと同じです`;
    if (ids.has(id as number)) return `ID ${id} が重複しています`;
    ids.add(id as number);
    if (typeof face !== "string" || !(MARKER_FACES as readonly string[]).includes(face)) return "face は wall / floor / left / right / back";
    if (!Array.isArray(pos) || pos.length !== 3 || !pos.every((v) => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= MARKER_POS_LIMIT_M)) {
      return `位置は各軸 ±${MARKER_POS_LIMIT_M} m の数値`;
    }
    if (face === "floor" && Math.abs((pos as number[])[1] + floorDrop) > 1e-3) {
      return `床のマーカー ID ${id} の高さは床（Y = ${-floorDrop}）にしてください`;
    }
  }
  return null;
}

/** HUD / ログ用の要約（"1:floor,2:left"。無ければ "-"） */
export function describeMarkers(markers: readonly MarkerPlacement[]): string {
  return markers.length === 0 ? "-" : markers.map((m) => `${m.id}:${m.face}`).join(",");
}

/** 寸法（マーカーの高さ）が変わったとき、床のマーカーを新しい床の高さに追従させた配置を返す */
export function withFloorDrop(markers: readonly MarkerPlacement[], floorDrop: number): MarkerPlacement[] {
  return markers.map((m) => (m.face === "floor" ? { ...m, pos: [m.pos[0], -floorDrop, m.pos[2]] } : m));
}

// ---- 複数マーカーの観測の合成（marker-anchor.ts から使う。three.js に依存しないよう配列で） ----

export type PoseCandidate = {
  /** アンカー（原点マーカー）の位置の候補（ワールド） */
  pos: V3;
  /** 回転の候補 [x, y, z, w] */
  quat: [number, number, number, number];
  /** 重み（> 0）。画面上のマーカーの大きさの 2 乗（POSIT の並進誤差の分散が辺長の 2 乗に反比例するため） */
  weight: number;
};

/**
 * 同じフレームで見えた複数のマーカーから出した「原点の姿勢」の候補を重み付きで平均する。
 * 位置は重み付き平均、回転は最初の候補と同じ半球に揃えてから重み付き和 → 正規化（候補同士は近い前提）。
 * spread は候補の位置の最大距離 [m]（貼りズレ・推定誤差の診断用。1 枚なら 0）
 */
export function fusePoseCandidates(candidates: readonly PoseCandidate[]): { pos: V3; quat: [number, number, number, number]; spread: number } | null {
  if (candidates.length === 0) return null;
  let wsum = 0;
  const pos: V3 = [0, 0, 0];
  const q = [0, 0, 0, 0];
  const ref = candidates[0].quat;
  for (const c of candidates) {
    const w = c.weight > 0 && Number.isFinite(c.weight) ? c.weight : 0;
    if (w === 0) continue;
    wsum += w;
    pos[0] += c.pos[0] * w;
    pos[1] += c.pos[1] * w;
    pos[2] += c.pos[2] * w;
    const d = c.quat[0] * ref[0] + c.quat[1] * ref[1] + c.quat[2] * ref[2] + c.quat[3] * ref[3];
    const s = d < 0 ? -w : w;
    q[0] += c.quat[0] * s;
    q[1] += c.quat[1] * s;
    q[2] += c.quat[2] * s;
    q[3] += c.quat[3] * s;
  }
  if (wsum === 0) return null;
  const len = Math.hypot(q[0], q[1], q[2], q[3]);
  if (!(len > 0)) return null;
  let spread = 0;
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i].pos;
      const b = candidates[j].pos;
      spread = Math.max(spread, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
    }
  }
  return {
    pos: [pos[0] / wsum, pos[1] / wsum, pos[2] / wsum],
    quat: [q[0] / len, q[1] / len, q[2] / len, q[3] / len],
    spread,
  };
}

// ---- 重力による水平化（issue #55。marker-anchor.ts から使う） ----

/** 回転 + 並進の 4x4（列優先）で方向ベクトルを変換する（並進は掛けない） */
export function transformDirection(m: number[], d: V3): V3 {
  return [m[0] * d[0] + m[4] * d[1] + m[8] * d[2], m[1] * d[0] + m[5] * d[1] + m[9] * d[2], m[2] * d[0] + m[6] * d[1] + m[10] * d[2]];
}

/**
 * 観測した姿勢（anchor → world の 4x4、列優先）の「アンカー座標系で鉛直上を向くはずの軸（anchorUp）」を、
 * ワールドの鉛直上（worldUp。DeviceOrientation 由来のカメラ姿勢ではワールドの +Y）に最短の回転で合わせる。
 * 回転はマーカーの中心 pivot（ワールド）のまわりに掛ける = マーカーの位置は信用し、傾きだけ直す。
 *
 * 背景: 平面マーカーの POSIT は表裏 2 解の取り違え（面の傾きの誤り）が起きやすい。原点マーカーではマーカー自身が
 * 原点なので位置にほとんど効かないが、追加マーカーでは「マーカー → 原点」の腕の長さ（1〜2m）で増幅されて原点が
 * 1〜2m 飛ぶ（Node の実験: 100mm の床マーカーを立って見る幾何で p90 1.9m → 水平化で 0.05m）。
 * 「マーカーは水平 / 鉛直に貼ってある」前提が使える場では、傾きは IMU の重力の方が POSIT より信用できる。
 *
 * @returns matrix 直した姿勢、tiltDeg 直す前の傾き [deg]（2 解の選択と、大きすぎる観測の棄却に使う）
 */
export function levelPose(anchorWorld: number[], pivot: V3, anchorUp: V3, worldUp: V3): { matrix: number[]; tiltDeg: number } {
  const a = normalize(transformDirection(anchorWorld, anchorUp));
  const b = normalize(worldUp);
  const c = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const tiltDeg = (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI;
  let r: number[]; // 3x3 行優先 [r00, r01, r02, r10, ...]
  let v = cross(a, b);
  const s2 = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
  if (s2 < 1e-18) {
    if (c > 0) return { matrix: anchorWorld.slice(), tiltDeg };
    // 真逆（180°）: a に直交する任意の軸で 180° 回す（棄却される傾きだが、有限の行列は返す）
    const axis = normalize(Math.abs(a[0]) < 0.9 ? cross(a, [1, 0, 0]) : cross(a, [0, 1, 0]));
    const [x, y, z] = axis;
    r = [2 * x * x - 1, 2 * x * y, 2 * x * z, 2 * x * y, 2 * y * y - 1, 2 * y * z, 2 * x * z, 2 * y * z, 2 * z * z - 1];
  } else {
    // Rodrigues: R = I + [v]x + [v]x^2 (1 - c) / |v|^2
    const k = (1 - c) / s2;
    const [x, y, z] = v;
    r = [
      1 + k * (-y * y - z * z), -z + k * x * y, y + k * x * z,
      z + k * x * y, 1 + k * (-x * x - z * z), -x + k * y * z,
      -y + k * x * z, x + k * y * z, 1 + k * (-x * x - y * y),
    ];
  }
  // 回転 R をワールドで左から掛け（R × M）、並進は pivot のまわりに回す: t' = R (t - pivot) + pivot
  const rot4 = [r[0], r[3], r[6], 0, r[1], r[4], r[7], 0, r[2], r[5], r[8], 0, 0, 0, 0, 1];
  const out = mulMat4(rot4, anchorWorld);
  const d: V3 = [anchorWorld[12] - pivot[0], anchorWorld[13] - pivot[1], anchorWorld[14] - pivot[2]];
  const rd = transformDirection(rot4, d);
  out[12] = rd[0] + pivot[0];
  out[13] = rd[1] + pivot[1];
  out[14] = rd[2] + pivot[2];
  return { matrix: out, tiltDeg };
}

function normalize(v: V3): V3 {
  const len = Math.hypot(v[0], v[1], v[2]);
  return len > 0 ? [v[0] / len, v[1] / len, v[2] / len] : [0, 0, 0];
}
