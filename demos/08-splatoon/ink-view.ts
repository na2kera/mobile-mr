// フィールド（壁 + 床）の見た目: SurfaceFrame の向きに置いた矩形 + 塗りを描く CanvasTexture。
// 07 の SurfaceView（壁面 Z=0 前提）の向き付き版。着弾は飛沫の形（splat-shape.ts。全端末とサーバーで同じ形）で描き、
// snapshot（格子）が来たら格子から描き直す（格子は 2cm セルなので少し粗いが、再接続と試合の切り替え時だけ）。
// 見た目の遊び（Phase 8 追加 A 案）: 本体はツヤのあるグラデーション + ハイライト、着弾から 150ms で広がり、
// 壁では 1.2 秒かけて下に垂れる。相手の色を塗り替えたときは一瞬白く光る
import * as THREE from "three";
import { InkGrid, MAX_INK_COLORS, type InkColor, type SurfaceFrame, type V2 } from "../../src/shared/splatoon-sim";
import { edgePoint, mulberry32 } from "../../src/shared/splat-shape";
import type { SplatShape } from "../../src/shared/splat-shape";

/** プレイヤーの色（個人戦。色番号 1.. の順） */
export const INK_COLORS = [0xff7a1a, 0x2bd4ff, 0x81c995, 0xf28b82, 0xfdd663, 0xc58af9, 0xe8eaed, 0xff8bcb];
export const INK_COLOR_NAMES = ["オレンジ", "ブルー", "グリーン", "レッド", "イエロー", "パープル", "ホワイト", "ピンク"];
if (INK_COLORS.length !== MAX_INK_COLORS || INK_COLOR_NAMES.length !== MAX_INK_COLORS) {
  throw new Error("INK_COLORS / INK_COLOR_NAMES と MAX_INK_COLORS が一致していない");
}
export function inkColorHex(color: InkColor): number {
  return INK_COLORS[Math.min(MAX_INK_COLORS, Math.max(1, Math.round(color))) - 1];
}
export function inkColorName(color: InkColor): string {
  return INK_COLOR_NAMES[Math.min(MAX_INK_COLORS, Math.max(1, Math.round(color))) - 1];
}

/** 1m あたりの px。07 と同じ理由で控えめ（毎フレーム全面転送） */
const DEFAULT_PX_PER_M = 384;
const MAX_PX = 1024;

/** 着弾が広がる時間 [ms] */
const GROW_MS = 150;
/** 塗り替えのフラッシュ [ms] */
const FLASH_MS = 220;
/** 垂れが伸びきる時間 [ms]（壁だけ） */
const DRIP_MS = 1200;
/** 垂れが始まるまで [ms] */
const DRIP_DELAY_MS = 120;
/** 本体の縁の分割数 */
const EDGE_STEPS = 48;

type Drip = {
  x: number;
  y: number;
  /** 伸びきったときの長さ [px] */
  len: number;
  /** 根元の太さ [px] */
  w: number;
  /** ここまで描いた長さ [px] */
  drawn: number;
};

type ActiveSplat = {
  cx: number;
  cy: number;
  shape: SplatShape;
  color: InkColor;
  startMs: number;
  overwrote: boolean;
  drips: Drip[];
  grown: boolean;
};

function hexToRgb(hex: number): [number, number, number] {
  return [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
}
function mix(a: [number, number, number], b: [number, number, number], k: number): string {
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * k)}, ${Math.round(a[1] + (b[1] - a[1]) * k)}, ${Math.round(a[2] + (b[2] - a[2]) * k)})`;
}
function easeOut(p: number): number {
  const q = Math.min(1, Math.max(0, p));
  return 1 - (1 - q) * (1 - q);
}

export class InkView {
  readonly group = new THREE.Group();
  readonly frame: SurfaceFrame;
  private readonly canvas = document.createElement("canvas");
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly frameMaterial: THREE.LineBasicMaterial;
  private readonly pxPerM: number;
  /** 壁（法線が水平）なら垂れる。床は垂れない */
  private readonly isWall: boolean;
  private readonly active: ActiveSplat[] = [];

  constructor(frame: SurfaceFrame, pxPerM = DEFAULT_PX_PER_M) {
    this.frame = frame;
    const scale = Math.min(pxPerM, MAX_PX / Math.max(frame.widthM, frame.heightM));
    this.pxPerM = scale;
    this.isWall = Math.abs(frame.normal[1]) < 1e-6;
    this.canvas.width = Math.max(8, Math.round(frame.widthM * scale));
    this.canvas.height = Math.max(8, Math.round(frame.heightM * scale));
    // 上書きの判定で着弾点の色を読むので読み戻し前提の canvas にする
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: true })!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.generateMipmaps = false;
    this.texture.minFilter = THREE.LinearFilter;
    this.clear();
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(frame.widthM, frame.heightM),
      new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, side: THREE.DoubleSide }),
    );
    // PlaneGeometry の UV は左下 (0,0)・右上 (1,1)、テクスチャは flipY=true なので canvas の上 = +Y。
    // frame の yAxis は「UV の下」なので、group の Y を -yAxis に向ける
    this.mesh.position.z = 0.003;
    this.group.add(this.mesh);
    const w = frame.widthM / 2;
    const h = frame.heightM / 2;
    this.frameMaterial = new THREE.LineBasicMaterial({ color: 0x8ab4f8, transparent: true, opacity: 0.8 });
    const line = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-w, -h, 0.002),
        new THREE.Vector3(w, -h, 0.002),
        new THREE.Vector3(w, h, 0.002),
        new THREE.Vector3(-w, h, 0.002),
      ]),
      this.frameMaterial,
    );
    this.group.add(line);
    // group の姿勢: X = xAxis, Y = -yAxis, Z = normal
    const x = new THREE.Vector3(...frame.xAxis);
    const y = new THREE.Vector3(...frame.yAxis).negate();
    const z = new THREE.Vector3(...frame.normal);
    this.group.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
    this.group.position.set(...frame.origin);
  }

  setFrameColor(hex: number) {
    this.frameMaterial.color.setHex(hex);
  }

  clear() {
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "rgba(138, 180, 248, 0.08)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    this.active.length = 0;
    this.texture.needsUpdate = true;
  }

  private color(c: InkColor): string {
    return `#${inkColorHex(c).toString(16).padStart(6, "0")}`;
  }

  /**
   * 着弾: UV を中心に飛沫の形で塗る。広がり・フラッシュ・垂れのアニメーションは update(now) で進める。
   * @returns 相手の色を塗り替えたか（音の出し分け用）
   */
  splat(uv: V2, shape: SplatShape, color: InkColor, now: number): boolean {
    const cx = uv[0] * this.canvas.width;
    const cy = uv[1] * this.canvas.height;
    const overwrote = this.isOtherInkAt(cx, cy, color);
    const rpx = shape.r * this.pxPerM;
    const drips: Drip[] = [];
    if (this.isWall) {
      // 本体の下端（canvas の +y = 壁の下）から 1〜3 本。形は shape から決定的に
      const rand = mulberry32(Math.floor(shape.waves[0].phase * 1e6) + shape.drops.length);
      const n = 1 + Math.floor(rand() * 3);
      const thetaDown = Math.atan2(shape.dir[0], shape.dir[1]);
      for (let i = 0; i < n; i++) {
        const [du, dv] = edgePoint(shape, thetaDown + (rand() - 0.5) * 0.9);
        drips.push({
          x: cx + du * this.pxPerM,
          y: cy + dv * this.pxPerM - rpx * 0.15,
          len: rpx * (0.6 + rand() * 1.4),
          w: rpx * (0.16 + rand() * 0.16),
          drawn: 0,
        });
      }
    }
    const a: ActiveSplat = { cx, cy, shape, color, startMs: now, overwrote, drips, grown: false };
    this.active.push(a);
    this.drawFrame(a, now);
    return overwrote;
  }

  /** アニメーション中の着弾を進める。毎フレーム呼ぶ */
  update(now: number) {
    if (this.active.length === 0) return;
    for (let i = this.active.length - 1; i >= 0; i--) {
      if (this.drawFrame(this.active[i], now)) this.active.splice(i, 1);
    }
    this.texture.needsUpdate = true;
  }

  /** 着弾点にいまある色が別のインクか（未塗装の薄い背景は alpha が小さい） */
  private isOtherInkAt(cx: number, cy: number, color: InkColor): boolean {
    const x = Math.min(this.canvas.width - 1, Math.max(0, Math.floor(cx)));
    const y = Math.min(this.canvas.height - 1, Math.max(0, Math.floor(cy)));
    const d = this.ctx.getImageData(x, y, 1, 1).data;
    if (d[3] < 200) return false;
    const [r, g, b] = hexToRgb(inkColorHex(color));
    return Math.abs(d[0] - r) + Math.abs(d[1] - g) + Math.abs(d[2] - b) > 60;
  }

  /** 1 フレームぶん描く。終わったら true */
  private drawFrame(a: ActiveSplat, now: number): boolean {
    const { ctx } = this;
    const t = now - a.startMs;
    const grow = easeOut(t / GROW_MS);
    if (!a.grown) {
      // 広がっている間は本体だけ（滴を途中の大きさで描くと、動いた跡が点線として残る）
      this.drawBlob(a, grow, false);
      if (a.overwrote && t < FLASH_MS) {
        this.blobPath(a, grow);
        ctx.fillStyle = `rgba(255, 255, 255, ${(0.75 * (1 - t / FLASH_MS)).toFixed(3)})`;
        ctx.fill();
      }
      if (grow >= 1 && (!a.overwrote || t >= FLASH_MS)) {
        // 最後にフラッシュ無しの完成形（滴込み）を描いて確定
        this.drawBlob(a, 1, true);
        a.grown = true;
      }
    }
    let dripping = false;
    if (a.drips.length > 0 && t > DRIP_DELAY_MS) {
      const p = easeOut((t - DRIP_DELAY_MS) / DRIP_MS);
      const base = hexToRgb(inkColorHex(a.color));
      ctx.strokeStyle = mix(base, [0, 0, 0], 0.12);
      ctx.fillStyle = ctx.strokeStyle;
      ctx.lineCap = "round";
      for (const d of a.drips) {
        const target = d.len * p;
        if (target <= d.drawn) continue;
        // 先へ行くほど細く
        ctx.lineWidth = Math.max(1, d.w * (1 - (target / d.len) * 0.6));
        ctx.beginPath();
        ctx.moveTo(d.x, d.y + d.drawn);
        ctx.lineTo(d.x, d.y + target);
        ctx.stroke();
        d.drawn = target;
        if (p >= 1) {
          // 先端の玉
          ctx.beginPath();
          ctx.arc(d.x, d.y + d.len, Math.max(1, d.w * 0.55), 0, Math.PI * 2);
          ctx.fill();
        }
      }
      dripping = p < 1;
    } else if (a.drips.length > 0) {
      dripping = true;
    }
    this.texture.needsUpdate = true;
    return a.grown && !dripping;
  }

  private blobPath(a: ActiveSplat, scale: number) {
    const { ctx, pxPerM } = this;
    ctx.beginPath();
    for (let i = 0; i < EDGE_STEPS; i++) {
      const [du, dv] = edgePoint(a.shape, (i / EDGE_STEPS) * Math.PI * 2);
      const x = a.cx + du * pxPerM * scale;
      const y = a.cy + dv * pxPerM * scale;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }

  /** 本体（ツヤのグラデーション + ハイライト）と滴（withDrops のときだけ） */
  private drawBlob(a: ActiveSplat, scale: number, withDrops: boolean) {
    const { ctx, pxPerM } = this;
    const base = hexToRgb(inkColorHex(a.color));
    const rpx = a.shape.r * pxPerM * scale;
    const grad = ctx.createRadialGradient(a.cx - rpx * 0.35, a.cy - rpx * 0.35, rpx * 0.1, a.cx, a.cy, rpx * a.shape.stretch * 1.35);
    grad.addColorStop(0, mix(base, [255, 255, 255], 0.28));
    grad.addColorStop(0.55, this.color(a.color));
    grad.addColorStop(1, mix(base, [0, 0, 0], 0.18));
    ctx.fillStyle = grad;
    this.blobPath(a, scale);
    ctx.fill();
    // 滴（本体より少し濃い）
    if (withDrops) {
      ctx.fillStyle = mix(base, [0, 0, 0], 0.06);
      for (const d of a.shape.drops) {
        ctx.beginPath();
        ctx.arc(a.cx + d.du * pxPerM, a.cy + d.dv * pxPerM, Math.max(0.5, d.r * pxPerM), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // ハイライト（左上に小さな楕円）
    ctx.save();
    ctx.translate(a.cx - rpx * 0.38, a.cy - rpx * 0.38);
    ctx.rotate(-Math.PI / 4);
    ctx.fillStyle = "rgba(255, 255, 255, 0.32)";
    ctx.beginPath();
    ctx.ellipse(0, 0, Math.max(0.5, rpx * 0.36), Math.max(0.5, rpx * 0.18), 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /** 格子（サーバーの権威状態）から描き直す。cellM はサーバーと同じ値（FieldConfig.cellM） */
  redrawFromGrid(encoded: string, cellM: number) {
    const grid = new InkGrid(this.frame, cellM);
    grid.decode(encoded);
    this.clear();
    const { ctx, canvas } = this;
    const cw = canvas.width / grid.cols;
    const ch = canvas.height / grid.rows;
    for (let y = 0; y < grid.rows; y++) {
      for (let x = 0; x < grid.cols; x++) {
        const v = grid.cells[y * grid.cols + x];
        if (v === 0) continue;
        ctx.fillStyle = this.color(v);
        ctx.fillRect(x * cw, y * ch, cw + 0.5, ch + 0.5);
      }
    }
    this.texture.needsUpdate = true;
  }

  dispose() {
    this.group.removeFromParent();
    this.texture.dispose();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.frameMaterial.dispose();
  }
}
