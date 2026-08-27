// 空間に置く文字パネル（CanvasTexture）。ゴーグル装着中は HUD が読めないので、視界内・
// 物体の近くに状態を出すために使う。06 の main.ts 内の TextPanel を 06-2 で抽出した
import * as THREE from "three";

export class TextPanel {
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly canvas = document.createElement("canvas");
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private last = "";
  constructor(widthM: number, heightM: number, px = 768) {
    this.canvas.width = px;
    this.canvas.height = Math.round((px * heightM) / widthM);
    this.ctx = this.canvas.getContext("2d")!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(widthM, heightM),
      new THREE.MeshBasicMaterial({
        map: this.texture,
        transparent: true,
        depthTest: false,
        depthWrite: false,
      }),
    );
    this.mesh.renderOrder = 20;
    this.mesh.visible = false;
  }
  /** 改行区切りの複数行。空文字で非表示。align は "center" | "left" */
  set(text: string, color = "#e8eaed", align: "center" | "left" = "center") {
    const key = `${color}\n${align}\n${text}`;
    if (key === this.last) return;
    this.last = key;
    this.mesh.visible = text !== "";
    if (!this.mesh.visible) return;
    const { canvas, ctx } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "rgba(20, 22, 26, 0.65)";
    ctx.beginPath();
    ctx.roundRect(0, 0, canvas.width, canvas.height, 24);
    ctx.fill();
    const lines = text.split("\n");
    let size = Math.min(canvas.height / (lines.length + 0.6), canvas.width / 14);
    const maxW = canvas.width * 0.94;
    for (let i = 0; i < 8; i++) {
      ctx.font = `bold ${size}px system-ui, sans-serif`;
      const widest = Math.max(...lines.map((l) => ctx.measureText(l).width));
      if (widest <= maxW) break;
      size *= Math.max(0.6, maxW / widest);
    }
    ctx.textAlign = align;
    ctx.textBaseline = "middle";
    ctx.fillStyle = color;
    const x = align === "center" ? canvas.width / 2 : canvas.width * 0.04;
    lines.forEach((line, i) => {
      const y = (canvas.height * (i + 1)) / (lines.length + 1);
      ctx.fillText(line, x, y);
    });
    this.texture.needsUpdate = true;
  }
}
