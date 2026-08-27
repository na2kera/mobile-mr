// Phase 7 (07-surface-mapping): 現実の壁・床を「Surface」として扱うための純粋関数。
// three.js に依存させない（サーバー・Node テストからも import する）。
//
// Surface の定義（A 案 = マーカー由来）:
//   壁に貼ったマーカー（03/04/06-2 と同じ ArUco）の座標系そのものを Surface の座標系にする。
//   マーカーの中心が Surface の中心、X = マーカー右、Y = マーカー上、面 = Z=0（+Z が視点側）。
//   大きさは widthM × heightM [m] の矩形（マーカーの外側まで広げた「壁のこの範囲」）。
//   Surface ID は `wall-<markerId>`。マーカーを増やせば Surface が増える構造（このデモは 1 枚）
//
// UV（CONCEPT.md §Phase 7 の図のとおり。左上 (0,0) → 右下 (1,1)。v は下向き）:
//   u = (x + w/2) / w,  v = (h/2 - y) / h
//
// ペイントは「Surface ID + UV + 半径 [m]」で表す。端末ごとにマーカーの見え方が違っても、
// UV は Surface 固有なので全員で同じ場所を指す（Phase 8 のインクはこれをそのまま使う）

export type V2 = [number, number];
export type V3 = [number, number, number];

export type SurfaceDef = {
  id: string;
  /** この Surface の原点にするマーカー */
  markerId: number;
  /** Surface の大きさ [m]（マーカー中心から ±w/2, ±h/2） */
  widthM: number;
  heightM: number;
};

export const DEFAULT_SURFACE_W = 1.0;
export const DEFAULT_SURFACE_H = 0.8;
export const SURFACE_SIZE_MIN = 0.1;
export const SURFACE_SIZE_MAX = 20;

export function surfaceIdFor(markerId: number): string {
  return `wall-${markerId}`;
}

export function makeSurface(markerId: number, widthM: number, heightM: number): SurfaceDef {
  return { id: surfaceIdFor(markerId), markerId, widthM, heightM };
}

/** UV → Surface 座標系（マーカー座標系）の (x, y)。z は常に 0 */
export function uvToLocal(s: SurfaceDef, uv: V2): V2 {
  return [(uv[0] - 0.5) * s.widthM, (0.5 - uv[1]) * s.heightM];
}

/** Surface 座標系の (x, y) → UV。矩形の外なら 0..1 の範囲外になる（クランプしない） */
export function localToUv(s: SurfaceDef, xy: V2): V2 {
  return [xy[0] / s.widthM + 0.5, 0.5 - xy[1] / s.heightM];
}

export function uvInside(uv: V2): boolean {
  return uv[0] >= 0 && uv[0] <= 1 && uv[1] >= 0 && uv[1] <= 1;
}

export type SurfaceHit = {
  uv: V2;
  /** 交点（Surface 座標系。z=0） */
  point: V3;
  /** 交点までの距離 [m]（dir が単位ベクトルのとき） */
  distance: number;
  /** 矩形の中か（外でもカーソル表示用に返す） */
  inside: boolean;
};

/**
 * 視線（Surface 座標系の origin + dir）と Surface の面 Z=0 との交点。
 * 面の表側（+Z 側）から面へ向かう視線だけ当たりとみなす（裏側や面と平行は null）
 */
export function raySurfaceHit(s: SurfaceDef, origin: V3, dir: V3): SurfaceHit | null {
  if (!(origin[2] > 0) || !(dir[2] < -1e-6)) return null;
  const t = -origin[2] / dir[2];
  const x = origin[0] + dir[0] * t;
  const y = origin[1] + dir[1] * t;
  const uv = localToUv(s, [x, y]);
  return {
    uv,
    point: [x, y, 0],
    distance: t * Math.hypot(dir[0], dir[1], dir[2]),
    inside: uvInside(uv),
  };
}

/** UV 同士の距離を [m] で（Surface の縦横比を反映） */
export function uvDistanceM(s: SurfaceDef, a: V2, b: V2): number {
  return Math.hypot((a[0] - b[0]) * s.widthM, (a[1] - b[1]) * s.heightM);
}

/** UV の送信・保存用の丸め（0.0001 = 1m の Surface で 0.1mm） */
export function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}
