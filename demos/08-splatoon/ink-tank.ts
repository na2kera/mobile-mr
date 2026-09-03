// 手元のインクタンク（issue #31）。スプラトゥーンの背中のタンクのような「黒い枠 + ガラスの窓 + 自分の色のインク」を
// Canvas に描いて板に貼る（TextPanel と同じ CanvasTexture 方式。文字ではなく水位で残量を見せる）。
// 板はカメラの子として使う想定（常に正面を向き、水位は常に鉛直）。置き場所は main.ts が決める
// （見えている手の手首の前腕側 / 手が無いときは視界の下）。
// 描き直すのは水位（px 単位）・色・空の状態が変わったときだけ。空のときの脈動は板の大きさで出し、テクスチャは描き直さない
import * as THREE from "three";

/** 板の幅 / 高さ（縦長の筒） */
export const TANK_ASPECT = 0.4;
/** 空のときの脈動 [Hz] と振幅 */
const PULSE_HZ = 3;
const PULSE_AMP = 0.06;
/** 空のときの枠の色（08 の「インク切れ」と同じ黄色） */
const LOW_COLOR = "#fdd663";

type Rgb = [number, number, number];
function hexToRgb(hex: number): Rgb {
  return [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
}
function mix(a: Rgb, b: Rgb, k: number, alpha = 1): string {
  const c = [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * k));
  return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${alpha})`;
}
const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];

export class InkTankView {
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  /** 板の基準の大きさ（1 = heightM）。手元と視界の下で変えるのは main.ts。脈動はこれに掛かる */
  baseScale = 1;
  private readonly canvas = document.createElement("canvas");
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private last = "";
  private low = false;
  /** 板の高さ [m]（幅は TANK_ASPECT 倍） */
  readonly heightM: number;

  /**
   * @param heightM 板の高さ [m]（幅は TANK_ASPECT 倍）
   * @param px テクスチャの幅 [px]
   */
  constructor(heightM: number, px = 160) {
    this.heightM = heightM;
    this.canvas.width = px;
    this.canvas.height = Math.round(px / TANK_ASPECT);
    this.ctx = this.canvas.getContext("2d")!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(heightM * TANK_ASPECT, heightM),
      new THREE.MeshBasicMaterial({
        map: this.texture,
        transparent: true,
        depthTest: false, // 手の骨格（renderOrder 10）と同じく背景の上に必ず描く
        depthWrite: false,
      }),
    );
    this.mesh.renderOrder = 20;
    this.mesh.visible = false;
  }

  /**
   * 残量を反映する（変わっていなければ描き直さない）
   * @param level 残量 0..1
   * @param colorHex インクの色
   * @param low 1 発ぶんも無い（枠を黄色にして update で脈動させる）
   */
  set(level: number, colorHex: number, low: boolean) {
    const fillPx = Math.round(Math.min(1, Math.max(0, level)) * this.windowRect().h);
    const key = `${fillPx}/${colorHex}/${low}`;
    if (key === this.last) return;
    this.last = key;
    this.low = low;
    this.draw(fillPx, hexToRgb(colorHex), low);
  }

  /** 毎フレーム: 空のときの脈動（板の大きさだけ変える） */
  update(now: number) {
    const pulse = this.low ? 1 + PULSE_AMP * (0.5 + 0.5 * Math.sin((now / 1000) * 2 * Math.PI * PULSE_HZ)) : 1;
    this.mesh.scale.setScalar(this.baseScale * pulse);
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.texture.dispose();
  }

  /** ガラスの窓（インクが溜まる範囲）の px 矩形 */
  private windowRect() {
    const { width: w, height: h } = this.canvas;
    const t = Math.round(w * 0.125);
    return { x: t, y: t, w: w - 2 * t, h: h - 2 * t };
  }

  private draw(fillPx: number, ink: Rgb, low: boolean) {
    const { canvas, ctx } = this;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    // ---- 枠（黒い筒。外側にうっすら影を落として明るい背景でも輪郭が出るように） ----
    const m = Math.round(w * 0.03);
    const frame = { x: m, y: m, w: w - 2 * m, h: h - 2 * m };
    const frameR = frame.w * 0.3;
    ctx.save();
    ctx.shadowColor = "rgba(0, 0, 0, 0.55)";
    ctx.shadowBlur = w * 0.06;
    const frameGrad = ctx.createLinearGradient(0, frame.y, 0, frame.y + frame.h);
    frameGrad.addColorStop(0, "#2b323a");
    frameGrad.addColorStop(0.5, "#151a1f");
    frameGrad.addColorStop(1, "#0a0d10");
    ctx.fillStyle = frameGrad;
    ctx.beginPath();
    ctx.roundRect(frame.x, frame.y, frame.w, frame.h, frameR);
    ctx.fill();
    ctx.restore();
    // 外縁のベベル（少し青みのある灰色）と、空のときは黄色の太い縁
    ctx.lineWidth = low ? w * 0.03 : w * 0.015;
    ctx.strokeStyle = low ? LOW_COLOR : "rgba(150, 170, 190, 0.35)";
    ctx.beginPath();
    ctx.roundRect(frame.x + ctx.lineWidth / 2, frame.y + ctx.lineWidth / 2, frame.w - ctx.lineWidth, frame.h - ctx.lineWidth, frameR);
    ctx.stroke();

    // ---- ガラスの窓（暗い半透明 + インク色のわずかな色味）----
    const win = this.windowRect();
    const winR = win.w * 0.3;
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(win.x, win.y, win.w, win.h, winR);
    ctx.clip();
    ctx.fillStyle = "rgba(4, 8, 12, 0.72)";
    ctx.fillRect(win.x, win.y, win.w, win.h);
    ctx.fillStyle = mix(ink, BLACK, 0, 0.1);
    ctx.fillRect(win.x, win.y, win.w, win.h);

    // ---- インク（下から水位まで。上ほど明るく、筒らしく左寄りに光の芯を入れる）----
    if (fillPx > 0) {
      const top = win.y + win.h - fillPx;
      const inkGrad = ctx.createLinearGradient(0, top, 0, win.y + win.h);
      inkGrad.addColorStop(0, mix(ink, WHITE, 0.12));
      inkGrad.addColorStop(1, mix(ink, BLACK, 0.3));
      ctx.fillStyle = inkGrad;
      ctx.fillRect(win.x, top, win.w, fillPx);
      const shade = ctx.createLinearGradient(win.x, 0, win.x + win.w, 0);
      shade.addColorStop(0, "rgba(0, 0, 0, 0.3)");
      shade.addColorStop(0.3, "rgba(255, 255, 255, 0.22)");
      shade.addColorStop(0.55, "rgba(255, 255, 255, 0.04)");
      shade.addColorStop(1, "rgba(0, 0, 0, 0.35)");
      ctx.fillStyle = shade;
      ctx.fillRect(win.x, top, win.w, fillPx);
      // 液面: 明るい帯と、その下のにじみ
      const band = Math.max(3, Math.round(w * 0.045));
      ctx.fillStyle = mix(ink, WHITE, 0.6);
      ctx.fillRect(win.x, top, win.w, band);
      const glow = ctx.createLinearGradient(0, top + band, 0, top + band + w * 0.12);
      glow.addColorStop(0, "rgba(255, 255, 255, 0.28)");
      glow.addColorStop(1, "rgba(255, 255, 255, 0)");
      ctx.fillStyle = glow;
      ctx.fillRect(win.x, top + band, win.w, w * 0.12);
    }

    // ---- ガラスの映り込み（左の縦の筋と上の光）----
    const streakX = win.x + w * 0.04;
    const streakW = w * 0.11;
    const streak = ctx.createLinearGradient(streakX, 0, streakX + streakW, 0);
    streak.addColorStop(0, "rgba(255, 255, 255, 0)");
    streak.addColorStop(0.5, "rgba(255, 255, 255, 0.26)");
    streak.addColorStop(1, "rgba(255, 255, 255, 0)");
    ctx.fillStyle = streak;
    ctx.fillRect(streakX, win.y + w * 0.06, streakW, win.h - w * 0.12);
    ctx.fillStyle = "rgba(255, 255, 255, 0.14)";
    ctx.beginPath();
    ctx.ellipse(w / 2, win.y + w * 0.1, win.w * 0.36, w * 0.06, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    this.texture.needsUpdate = true;
  }
}
