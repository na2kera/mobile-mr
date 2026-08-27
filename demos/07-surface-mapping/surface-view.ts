// Surface の見た目: マーカー座標系（= Surface 座標系）に置く矩形 + ペイントを描く CanvasTexture。
// ストロークは UV と半径 [m] で来るので、ここで px に直す。ストロークの順序（seq）で上書きするので
// 全員の見た目が一致する
import * as THREE from "three";
import type { SurfaceDef } from "../../src/shared/surface";
import type { PaintStroke } from "../../src/shared/surface-paint";
import { PLAYER_COLOR_COUNT } from "../../src/shared/surface-protocol";

export const PLAYER_COLORS = [0x8ab4f8, 0xffa657, 0x81c995, 0xf28b82, 0xfdd663, 0xc58af9, 0x78d9ec, 0xff8bcb];
if (PLAYER_COLORS.length !== PLAYER_COLOR_COUNT) {
  throw new Error(`PLAYER_COLORS (${PLAYER_COLORS.length}) と PLAYER_COLOR_COUNT (${PLAYER_COLOR_COUNT}) が一致していない`);
}

export function playerColorHex(color: number): number {
  return PLAYER_COLORS[((color % PLAYER_COLORS.length) + PLAYER_COLORS.length) % PLAYER_COLORS.length];
}

/**
 * 1m あたりの px。1m × 0.8m で 512 × 410（RGBA 約 0.8MB）。半径 3cm のストロークが 15px。
 * ストロークのある毎フレーム全面を GPU へ送り直す（three.js の CanvasTexture は部分更新できない）ので、
 * モバイルの帯域を考えて控えめにしている。広い Surface は MAX_PX の上限で粗くなる。
 * 実機で粗ければ ?surfacePx= で上げる（main.ts）
 */
const DEFAULT_PX_PER_M = 512;
const MAX_PX = 1024;

export class SurfaceView {
  readonly group = new THREE.Group();
  readonly def: SurfaceDef;
  private readonly canvas = document.createElement("canvas");
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private readonly paintMesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly frameMaterial: THREE.LineBasicMaterial;
  private readonly pxPerM: number;
  private applied = 0;
  /** 描いたストロークの最大 seq（HUD 用） */
  lastSeq = 0;

  constructor(def: SurfaceDef, pxPerM = DEFAULT_PX_PER_M) {
    this.def = def;
    const scale = Math.min(pxPerM, MAX_PX / Math.max(def.widthM, def.heightM));
    this.pxPerM = scale;
    this.canvas.width = Math.max(8, Math.round(def.widthM * scale));
    this.canvas.height = Math.max(8, Math.round(def.heightM * scale));
    this.ctx = this.canvas.getContext("2d")!;
    this.clear();
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    // 更新のたびに mipmap を作り直さない（アップロード 1 回分で済ませる）
    this.texture.generateMipmaps = false;
    this.texture.minFilter = THREE.LinearFilter;
    // ペイント層（壁面のわずかに手前。マーカーの枠と Z-fighting しないように）
    this.paintMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(def.widthM, def.heightM),
      new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, side: THREE.DoubleSide }),
    );
    this.paintMesh.position.z = 0.003;
    this.group.add(this.paintMesh);
    // 枠線（Surface の範囲が見えるように）
    const w = def.widthM / 2;
    const h = def.heightM / 2;
    this.frameMaterial = new THREE.LineBasicMaterial({ color: 0x8ab4f8, transparent: true, opacity: 0.8 });
    const frame = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-w, -h, 0.002),
        new THREE.Vector3(w, -h, 0.002),
        new THREE.Vector3(w, h, 0.002),
        new THREE.Vector3(-w, h, 0.002),
      ]),
      this.frameMaterial,
    );
    this.group.add(frame);
  }

  /** 枠の色（トラッキング中 / ロスト中の区別に使う） */
  setFrameColor(hex: number) {
    this.frameMaterial.color.setHex(hex);
  }

  /** 全消去（薄い格子だけ残す。UV の目安 0.1 刻み） */
  clear() {
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = "rgba(138, 180, 248, 0.25)";
    ctx.lineWidth = 1;
    for (let i = 1; i < 10; i++) {
      const x = (canvas.width * i) / 10;
      const y = (canvas.height * i) / 10;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, canvas.height);
      ctx.moveTo(0, y);
      ctx.lineTo(canvas.width, y);
      ctx.stroke();
    }
    this.applied = 0;
    this.lastSeq = 0;
    if (this.texture) this.texture.needsUpdate = true;
  }

  /** 1 ストロークを描く（順序は呼び出し側が seq 順に保つ） */
  draw(s: PaintStroke) {
    const { ctx, canvas } = this;
    const x = s.uv[0] * canvas.width;
    const y = s.uv[1] * canvas.height;
    const r = Math.max(1, s.radius * this.pxPerM);
    ctx.fillStyle = `#${playerColorHex(s.color).toString(16).padStart(6, "0")}cc`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    this.applied++;
    this.lastSeq = Math.max(this.lastSeq, s.seq);
    this.texture.needsUpdate = true;
  }

  /** snapshot（全ストローク）で置き換える */
  replace(strokes: readonly PaintStroke[]) {
    this.clear();
    for (const s of strokes) if (s.surfaceId === this.def.id) this.draw(s);
  }

  get strokeCount(): number {
    return this.applied;
  }

  dispose() {
    this.group.removeFromParent();
    this.texture.dispose();
    this.paintMesh.geometry.dispose();
    this.paintMesh.material.dispose();
    this.frameMaterial.dispose();
  }
}
