// Phase 8 (08-splatoon): インクの飛行・着弾・塗りの格子（純粋関数）。
// サーバー（権威）とクライアント（飛行の描画・撃った瞬間の予測）が同じ式を使う。
// three.js に依存させない（Node の回帰テスト scripts/test-splatoon.mjs から import するため。
// import に .ts を付けているのも Node の ESM 解決のため）。
//
// 座標系（field 座標系）: 壁に貼ったマーカーのマーカー座標系そのもの（06-2 / 07 と同じ）。
//   X = マーカーの右, Y = マーカーの上（= 鉛直上。天地を合わせて貼る前提）, +Z = 壁から部屋側。
//   壁面 = Z=0。床 = Y = -floorDrop の水平面（壁から部屋側へ floorDepth まで）。重力は -Y。単位 m
//
// Surface（07 の SurfaceDef は「壁面 Z=0」前提だったので、ここでは向きを持つ SurfaceFrame に一般化する。
// UV の規約は 07 と同じ: 左上 (0,0) → 右下 (1,1)。壁: u = X 右, v = 下。床: u = X 右, v = 壁から部屋側へ）
import type { V2, V3 } from "./surface.ts";

export type { V2, V3 };

export type SurfaceFrame = {
  id: string;
  /** Surface の中心（field 座標系） */
  origin: V3;
  /** u 方向（単位ベクトル。UV の右） */
  xAxis: V3;
  /** v 方向（単位ベクトル。UV の下。壁なら鉛直下、床なら壁から部屋側） */
  yAxis: V3;
  /** 表の法線 = xAxis × yAxis の逆（壁: +Z、床: +Y になるように yAxis を選ぶ） */
  normal: V3;
  widthM: number;
  heightM: number;
};

export type FieldConfig = {
  /** 壁の Surface の大きさ [m]（マーカー中心 ±） */
  wallW: number;
  wallH: number;
  /** マーカー中心から床までの高さ [m] */
  floorDrop: number;
  /** 床の Surface の奥行き [m]（壁面から部屋側へ）。幅は wallW */
  floorDepth: number;
  gravity: number;
  /** 飛行の打ち切り [s] */
  maxFlightSec: number;
  /** 1 試合の長さ [s] */
  matchSec: number;
  /** 結果表示の長さ [s] */
  resultSec: number;
  /** 1 発の速さ [m/s] と半径 [m]（連射なので固定） */
  shotSpeed: number;
  shotRadius: number;
  /** インクタンク満タンで撃てる発数 */
  tankShots: number;
  /** 連射の速さ [発/s] */
  fireRatePerSec: number;
  /** 満タンまでの回復時間 [s]（場所に依存しない。3DoF では頭の位置がマーカーを見ている間しか更新できないため、位置ベースの回復はやめた） */
  inkFullSec: number;
  /** 撃ってからこの時間 [s] は回復しない（撃ちながら回復して無限に撃てるのを防ぐ） */
  inkRegenDelaySec: number;
  /** 最初の 1 人が入ってから試合開始までの待機 [s]（全員がマーカーを読み取る時間。入室の速さが得点差にならないように） */
  waitSec: number;
  /** 格子の 1 セル [m] */
  cellM: number;
};

export const DEFAULT_FIELD: FieldConfig = {
  // 壁の下端（wallH/2 = 1.2m 下）と床がちょうど接続する寸法。マーカーは床から 1.2m の高さに貼る想定
  wallW: 3.0,
  wallH: 2.4,
  floorDrop: 1.2,
  floorDepth: 2.5,
  gravity: 4,
  maxFlightSec: 3,
  matchSec: 90,
  resultSec: 8,
  shotSpeed: 5,
  shotRadius: 0.09,
  tankShots: 50,
  fireRatePerSec: 6,
  inkFullSec: 5,
  inkRegenDelaySec: 1,
  waitSec: 15,
  cellM: 0.02,
};

export const WALL_ID = "wall";
export const FLOOR_ID = "floor";
export const LEFT_ID = "left";
export const RIGHT_ID = "right";
export const BACK_ID = "back";

function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
export function dot(a: V3, b: V3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function sub(a: V3, b: V3): V3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
export function norm(a: V3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

/**
 * 四方の壁と床の 5 枚。床（wallW × floorDepth）を囲む箱型のコートで、
 * 正面 = マーカーの壁（Z=0）、左右 = x=±wallW/2、背面 = z=floorDepth。
 * 左右・背面は現実の壁が無くても立つ仮想の壁。法線はすべてコートの内側を向く。
 * 壁の下端は常に床（y=-floorDrop）に接続し、上端は床から wallH。マーカーの高さ（floorDrop）が
 * いくつでも壁と床に隙間ができない（マーカーは壁の中の任意の高さで良い）
 */
export function fieldSurfaces(cfg: FieldConfig): SurfaceFrame[] {
  const down: V3 = [0, -1, 0];
  const halfW = cfg.wallW / 2;
  const zMid = cfg.floorDepth / 2;
  /** 壁の縦の中心（下端 = 床に固定） */
  const wallMidY = -cfg.floorDrop + cfg.wallH / 2;
  const frame = (id: string, origin: V3, xAxis: V3, widthM: number, heightM: number, yAxis: V3 = down): SurfaceFrame => ({
    id,
    origin,
    xAxis,
    yAxis,
    normal: cross(yAxis, xAxis),
    widthM,
    heightM,
  });
  return [
    // 正面（マーカーの壁）: 法線 +Z。UV は部屋の中から見て左上 (0,0)
    frame(WALL_ID, [0, wallMidY, 0], [1, 0, 0], cfg.wallW, cfg.wallH),
    // 床: 法線 +Y。v は壁 → 部屋側
    frame(FLOOR_ID, [0, -cfg.floorDrop, zMid], [1, 0, 0], cfg.wallW, cfg.floorDepth, [0, 0, 1]),
    // 左（x=-wallW/2）: 法線 +X。u は背面 → 正面（部屋の中から見て左 → 右）
    frame(LEFT_ID, [-halfW, wallMidY, zMid], [0, 0, -1], cfg.floorDepth, cfg.wallH),
    // 右（x=+wallW/2）: 法線 -X。u は正面 → 背面
    frame(RIGHT_ID, [halfW, wallMidY, zMid], [0, 0, 1], cfg.floorDepth, cfg.wallH),
    // 背面（z=floorDepth）: 法線 -Z（マーカー側を向く）
    frame(BACK_ID, [0, wallMidY, cfg.floorDepth], [-1, 0, 0], cfg.wallW, cfg.wallH),
  ];
}

/** UV → field 座標系の点 */
export function frameUvToPoint(s: SurfaceFrame, uv: V2): V3 {
  const a = (uv[0] - 0.5) * s.widthM;
  const b = (uv[1] - 0.5) * s.heightM;
  return [
    s.origin[0] + s.xAxis[0] * a + s.yAxis[0] * b,
    s.origin[1] + s.xAxis[1] * a + s.yAxis[1] * b,
    s.origin[2] + s.xAxis[2] * a + s.yAxis[2] * b,
  ];
}

/** field 座標系の点 → UV（面上に無い点は面へ投影） */
export function framePointToUv(s: SurfaceFrame, p: V3): V2 {
  const d = sub(p, s.origin);
  return [dot(d, s.xAxis) / s.widthM + 0.5, dot(d, s.yAxis) / s.heightM + 0.5];
}

export function uvInside(uv: V2): boolean {
  return uv[0] >= 0 && uv[0] <= 1 && uv[1] >= 0 && uv[1] <= 1;
}

/** 視線（origin + dir）と Surface の交点。表側から面へ向かうものだけ */
export function rayFrameHit(s: SurfaceFrame, origin: V3, dir: V3): { uv: V2; point: V3; t: number; inside: boolean } | null {
  const denom = dot(dir, s.normal);
  if (!(denom < -1e-6)) return null;
  const t = -dot(sub(origin, s.origin), s.normal) / denom;
  if (!(t > 0)) return null;
  const point: V3 = [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t];
  const uv = framePointToUv(s, point);
  return { uv, point, t, inside: uvInside(uv) };
}

/** 放物線上の位置（重力は -Y） */
export function inkAt(pos: V3, vel: V3, t: number, g: number): V3 {
  return [pos[0] + vel[0] * t, pos[1] + vel[1] * t - 0.5 * g * t * t, pos[2] + vel[2] * t];
}

export type InkLanding = {
  surfaceId: string;
  uv: V2;
  point: V3;
  /** 着弾時刻 [s] */
  hitT: number;
  /** 矩形の中に当たった（塗る）か。false は面の延長（現実の壁・床）に当たって消えるだけ */
  hit: boolean;
};

/**
 * 発射位置 pos・速度 vel のインクが最初に当たる Surface（表側から）。矩形の中なら hit=true（塗る）、
 * 外なら hit=false（現実の壁・床の延長に当たって消える。突き抜けて飛び続けないため）。
 * 面の方程式 n·x = n·o に放物線を代入した 2 次式を解く。どの面にも届かなければ null（maxFlightSec で打ち切り）
 */
export function simulateInk(pos: V3, vel: V3, surfaces: readonly SurfaceFrame[], cfg: FieldConfig): InkLanding | null {
  let best: InkLanding | null = null;
  for (const s of surfaces) {
    const n = s.normal;
    // n·(pos + vel t - 0.5 g t² ŷ) = n·origin  →  a t² + b t + c = 0
    const a = -0.5 * cfg.gravity * n[1];
    const b = dot(vel, n);
    const c = dot(sub(pos, s.origin), n);
    const roots: number[] = [];
    if (Math.abs(a) < 1e-9) {
      if (Math.abs(b) > 1e-9) roots.push(-c / b);
    } else {
      const disc = b * b - 4 * a * c;
      if (disc >= 0) {
        const sq = Math.sqrt(disc);
        roots.push((-b - sq) / (2 * a), (-b + sq) / (2 * a));
      }
    }
    for (const t of roots.sort((x, y) => x - y)) {
      if (!(t > 1e-4) || t > cfg.maxFlightSec) continue;
      // 表側から入る（速度が法線と逆向き）ことを要求
      const vt: V3 = [vel[0], vel[1] - cfg.gravity * t, vel[2]];
      if (!(dot(vt, n) < 0)) continue;
      const point = inkAt(pos, vel, t, cfg.gravity);
      const uv = framePointToUv(s, point);
      if (!best || t < best.hitT) best = { surfaceId: s.id, uv, point, hitT: t, hit: uvInside(uv) };
      break;
    }
  }
  return best;
}

/** 1 発で減るインク（タンク = 1） */
export function inkPerShot(cfg: FieldConfig): number {
  return 1 / cfg.tankShots;
}

// ---- 塗りの格子（サーバーの権威状態。ストロークの列ではなく「塗った結果」を持つ。07 の痛点への回答） ----

/** 色の数の上限（= Room の人数上限。個人戦なので 1 人 1 色） */
export const MAX_INK_COLORS = 8;
/** セルの値: 0 = 未塗装, 1..MAX_INK_COLORS = プレイヤーの色番号 */
export type InkColor = number;

export class InkGrid {
  readonly cols: number;
  readonly rows: number;
  readonly cells: Uint8Array;
  readonly surface: SurfaceFrame;
  readonly cellM: number;

  constructor(surface: SurfaceFrame, cellM: number) {
    this.surface = surface;
    this.cellM = cellM;
    this.cols = Math.max(1, Math.round(surface.widthM / cellM));
    this.rows = Math.max(1, Math.round(surface.heightM / cellM));
    this.cells = new Uint8Array(this.cols * this.rows);
  }

  /** UV を中心に半径 radiusM の円を color（1..MAX_INK_COLORS）で塗る。塗り替えたセル数を返す */
  stamp(uv: V2, radiusM: number, color: InkColor): number {
    const cx = uv[0] * this.cols;
    const cy = uv[1] * this.rows;
    const rx = radiusM / this.surface.widthM * this.cols;
    const ry = radiusM / this.surface.heightM * this.rows;
    let changed = 0;
    const x0 = Math.max(0, Math.floor(cx - rx));
    const x1 = Math.min(this.cols - 1, Math.ceil(cx + rx));
    const y0 = Math.max(0, Math.floor(cy - ry));
    const y1 = Math.min(this.rows - 1, Math.ceil(cy + ry));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = (x + 0.5 - cx) / rx;
        const dy = (y + 0.5 - cy) / ry;
        if (dx * dx + dy * dy > 1) continue;
        const i = y * this.cols + x;
        if (this.cells[i] !== color) {
          this.cells[i] = color;
          changed++;
        }
      }
    }
    return changed;
  }

  clear() {
    this.cells.fill(0);
  }

  /** 色ごとのセル数（index 0 = 未塗装、1.. = 色番号） */
  counts(): number[] {
    const c = new Array<number>(MAX_INK_COLORS + 1).fill(0);
    for (const v of this.cells) c[v]++;
    return c;
  }

  /** 送信用（各セル 1 文字 '0'/'1'/'2'。JSON の数値配列より小さい） */
  encode(): string {
    let s = "";
    for (const v of this.cells) s += v;
    return s;
  }

  decode(s: string) {
    const n = Math.min(s.length, this.cells.length);
    for (let i = 0; i < n; i++) {
      const v = s.charCodeAt(i) - 48;
      this.cells[i] = v >= 0 && v <= MAX_INK_COLORS ? v : 0;
    }
  }
}
