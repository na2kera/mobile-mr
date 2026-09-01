// フィールド（壁 + 床）の見た目: SurfaceFrame の向きに置いた矩形 + 塗りを描く CanvasTexture。
// 07 の SurfaceView（壁面 Z=0 前提）の向き付き版。着弾はチーム色の円で描き、snapshot（格子）が来たら
// 格子から描き直す（格子は 2cm セルなので少し粗いが、再接続と試合の切り替え時だけ）
import * as THREE from "three";
import { InkGrid, MAX_INK_COLORS, type InkColor, type SurfaceFrame, type V2 } from "../../src/shared/splatoon-sim";

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

export class InkView {
  readonly group = new THREE.Group();
  readonly frame: SurfaceFrame;
  private readonly canvas = document.createElement("canvas");
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly frameMaterial: THREE.LineBasicMaterial;
  private readonly pxPerM: number;

  constructor(frame: SurfaceFrame, pxPerM = DEFAULT_PX_PER_M) {
    this.frame = frame;
    const scale = Math.min(pxPerM, MAX_PX / Math.max(frame.widthM, frame.heightM));
    this.pxPerM = scale;
    this.canvas.width = Math.max(8, Math.round(frame.widthM * scale));
    this.canvas.height = Math.max(8, Math.round(frame.heightM * scale));
    this.ctx = this.canvas.getContext("2d")!;
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
    this.texture.needsUpdate = true;
  }

  private color(c: InkColor): string {
    return `#${inkColorHex(c).toString(16).padStart(6, "0")}`;
  }

  /** 着弾: UV を中心に半径 radiusM の円 */
  splat(uv: V2, radiusM: number, color: InkColor) {
    const { ctx, canvas } = this;
    ctx.fillStyle = this.color(color);
    ctx.beginPath();
    ctx.arc(uv[0] * canvas.width, uv[1] * canvas.height, Math.max(1, radiusM * this.pxPerM), 0, Math.PI * 2);
    ctx.fill();
    this.texture.needsUpdate = true;
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
