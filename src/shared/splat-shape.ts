// Phase 8 追加: インクの飛沫（スプラッタ）の形。単色の円だった着弾を「いびつな本体 + 進行方向に飛び散る滴」にする。
// 全端末（スマホ・俯瞰画面）とサーバーの格子で同じ形にする必要があるので、shot.seq を種にした決定的な乱数で作る
// 純粋関数にし、three.js にも canvas にも依存させない（Node の回帰テスト scripts/test-splatoon.mjs から import する）。
// 単位は面上のメートル（u = 右、v = 下。splatoon-sim.ts の UV 規約と同じ向き）
import type { InkLanding, SurfaceFrame, V2, V3 } from "./splatoon-sim.ts";
import { dot } from "./splatoon-sim.ts";

export type SplatDrop = {
  /** 着弾点からのオフセット [m]（u 右・v 下） */
  du: number;
  dv: number;
  /** 半径 [m] */
  r: number;
};

export type SplatWave = { k: number; amp: number; phase: number };

export type SplatShape = {
  /** 本体の基準半径 [m] */
  r: number;
  /** 進行方向（面内・単位ベクトル。向きが分からないときは [0, 1]） */
  dir: V2;
  /** 本体の進行方向への伸び（1 = 円） */
  stretch: number;
  /** 縁の凹凸（角度 θ での半径倍率 = 1 + Σ amp·sin(kθ + phase)） */
  waves: SplatWave[];
  drops: SplatDrop[];
};

/** 決定的な乱数（mulberry32）。同じ種なら全端末で同じ列 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 滴の数の範囲 */
export const MIN_DROPS = 3;
export const MAX_DROPS = 8;
/** 縁の倍率の範囲（格子のバウンディングボックスと描画の参考値） */
export const MAX_EDGE_SCALE = 1.4;

/**
 * 着弾時の速度を面に射影した向き（u, v）。ほぼ垂直に当たって面内成分が無ければ null。
 * 速度は vel + 重力 × hitT（重力は -Y）
 */
export function impactDirUv(landing: InkLanding, vel: V3, surface: SurfaceFrame, gravity: number): V2 | null {
  const v: V3 = [vel[0], vel[1] - gravity * landing.hitT, vel[2]];
  const u = dot(v, surface.xAxis);
  const w = dot(v, surface.yAxis);
  const len = Math.hypot(u, w);
  if (len < 0.3) return null;
  return [u / len, w / len];
}

/**
 * 飛沫の形を作る。
 * @param seed shot.seq（全端末で同じ）
 * @param radiusM 玉の半径（本体の基準半径）
 * @param dir 面内の進行方向（impactDirUv）。null なら向きなし（伸びなし・滴は全方向）
 */
export function splatShape(seed: number, radiusM: number, dir: V2 | null): SplatShape {
  const rand = mulberry32(seed * 2654435761 + 7);
  const waves: SplatWave[] = [
    { k: 2, amp: 0.1 + rand() * 0.1, phase: rand() * Math.PI * 2 },
    { k: 3, amp: 0.06 + rand() * 0.08, phase: rand() * Math.PI * 2 },
    { k: 5, amp: 0.04 + rand() * 0.06, phase: rand() * Math.PI * 2 },
  ];
  const d: V2 = dir ?? [0, 1];
  const stretch = dir ? 1.15 + rand() * 0.2 : 1;
  const n = MIN_DROPS + Math.floor(rand() * (MAX_DROPS - MIN_DROPS + 1));
  const drops: SplatDrop[] = [];
  const base = Math.atan2(d[1], d[0]);
  for (let i = 0; i < n; i++) {
    // 進行方向 ±55° に、本体の縁の少し外〜2.8 倍の距離。向きが無ければ全方向
    const spread = dir ? (rand() - 0.5) * ((110 * Math.PI) / 180) : rand() * Math.PI * 2;
    const angle = base + spread;
    const dist = radiusM * (1.3 + rand() * 1.5);
    const r = radiusM * (0.12 + rand() * 0.3);
    drops.push({ du: Math.cos(angle) * dist, dv: Math.sin(angle) * dist, r });
  }
  // 後ろ側にも小さいのを 1〜2 個（跳ね返り）
  const back = 1 + Math.floor(rand() * 2);
  for (let i = 0; i < back; i++) {
    const angle = base + Math.PI + (rand() - 0.5) * Math.PI * 0.6;
    const dist = radiusM * (1.2 + rand() * 0.6);
    drops.push({ du: Math.cos(angle) * dist, dv: Math.sin(angle) * dist, r: radiusM * (0.08 + rand() * 0.14) });
  }
  return { r: radiusM, dir: d, stretch, waves, drops };
}

/** 本体の縁の半径倍率（形のローカル角 θ。θ=0 が進行方向） */
export function edgeScale(shape: SplatShape, theta: number): number {
  let s = 1;
  for (const w of shape.waves) s += w.amp * Math.sin(w.k * theta + w.phase);
  return Math.min(MAX_EDGE_SCALE, Math.max(0.6, s));
}

/**
 * 本体の縁の点（着弾点からのオフセット [m]）。θ は形のローカル角（0 = 進行方向）。
 * 描画の path はこれを 0..2π で結び、格子の内外判定 insideCore は同じパラメータ化で行う
 */
export function edgePoint(shape: SplatShape, theta: number): V2 {
  const rr = shape.r * edgeScale(shape, theta);
  const lx = Math.cos(theta) * rr * shape.stretch;
  const ly = Math.sin(theta) * rr;
  const [ex, ey] = shape.dir;
  // ローカル x = 進行方向、ローカル y = その垂直（面内で 90° 回転）
  return [ex * lx - ey * ly, ey * lx + ex * ly];
}

/** 着弾点からのオフセット (du, dv) [m] が本体の中か */
export function insideCore(shape: SplatShape, du: number, dv: number): boolean {
  const [ex, ey] = shape.dir;
  const lx = (du * ex + dv * ey) / shape.stretch;
  const ly = -du * ey + dv * ex;
  const dist = Math.hypot(lx, ly);
  if (dist === 0) return true;
  const theta = Math.atan2(ly, lx);
  return dist <= shape.r * edgeScale(shape, theta);
}

/** 着弾点からのオフセットが本体か滴のどれかの中か */
export function insideSplat(shape: SplatShape, du: number, dv: number): boolean {
  if (insideCore(shape, du, dv)) return true;
  for (const d of shape.drops) {
    const dx = du - d.du;
    const dy = dv - d.dv;
    if (dx * dx + dy * dy <= d.r * d.r) return true;
  }
  return false;
}

/** 形全体を含む正方形の半径 [m]（格子のバウンディングボックス用） */
export function splatExtent(shape: SplatShape): number {
  let e = shape.r * shape.stretch * MAX_EDGE_SCALE;
  for (const d of shape.drops) e = Math.max(e, Math.hypot(d.du, d.dv) + d.r);
  return e;
}
