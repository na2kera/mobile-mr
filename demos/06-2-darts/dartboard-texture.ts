// ダーツボードの絵（CanvasTexture）。寸法は darts-sim.ts の BOARD と同じ（採点と絵がずれないよう
// 同じ定数から描く）。ボード全体（数字リング込み、直径 451mm）を正方形のテクスチャに収める
import * as THREE from "three";
import { BOARD, SEGMENTS, SEGMENT_DEG } from "../../src/shared/darts-sim";

export function createDartboardTexture(px = 1024): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = px;
  const ctx = canvas.getContext("2d")!;
  const c = px / 2;
  /** m → px */
  const s = px / 2 / BOARD.boardR;
  const r = (m: number) => m * s;

  // 外周（数字リング）
  ctx.fillStyle = "#1c1c1c";
  ctx.beginPath();
  ctx.arc(c, c, r(BOARD.boardR), 0, Math.PI * 2);
  ctx.fill();

  // セクター（真上の 20 から時計回り。canvas の角度は +X から時計回りなので -90° ずらす）
  const half = (SEGMENT_DEG / 2) * (Math.PI / 180);
  const sector = (k: number, rIn: number, rOut: number, color: string) => {
    const mid = (k * SEGMENT_DEG - 90) * (Math.PI / 180);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(c, c, r(rOut), mid - half, mid + half);
    ctx.arc(c, c, r(rIn), mid + half, mid - half, true);
    ctx.closePath();
    ctx.fill();
  };
  for (let k = 0; k < SEGMENTS.length; k++) {
    const dark = k % 2 === 0;
    const single = dark ? "#111111" : "#f3e9d2";
    const ring = dark ? "#c62828" : "#2e7d32";
    sector(k, BOARD.outerBullR, BOARD.tripleInR, single);
    sector(k, BOARD.tripleInR, BOARD.tripleOutR, ring);
    sector(k, BOARD.tripleOutR, BOARD.doubleInR, single);
    sector(k, BOARD.doubleInR, BOARD.doubleOutR, ring);
  }
  // ブル
  ctx.fillStyle = "#2e7d32";
  ctx.beginPath();
  ctx.arc(c, c, r(BOARD.outerBullR), 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#c62828";
  ctx.beginPath();
  ctx.arc(c, c, r(BOARD.bullR), 0, Math.PI * 2);
  ctx.fill();
  // ワイヤー（セクター境界とリング）
  ctx.strokeStyle = "rgba(220, 220, 220, 0.8)";
  ctx.lineWidth = Math.max(1, px / 600);
  for (const rm of [BOARD.outerBullR, BOARD.tripleInR, BOARD.tripleOutR, BOARD.doubleInR, BOARD.doubleOutR]) {
    ctx.beginPath();
    ctx.arc(c, c, r(rm), 0, Math.PI * 2);
    ctx.stroke();
  }
  for (let k = 0; k < SEGMENTS.length; k++) {
    const a = (k * SEGMENT_DEG - 90) * (Math.PI / 180) - half;
    ctx.beginPath();
    ctx.moveTo(c + Math.cos(a) * r(BOARD.outerBullR), c + Math.sin(a) * r(BOARD.outerBullR));
    ctx.lineTo(c + Math.cos(a) * r(BOARD.doubleOutR), c + Math.sin(a) * r(BOARD.doubleOutR));
    ctx.stroke();
  }
  // 数字
  ctx.fillStyle = "#f3e9d2";
  ctx.font = `bold ${Math.round(px * 0.045)}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const numR = r((BOARD.doubleOutR + BOARD.boardR) / 2);
  for (const [k, n] of SEGMENTS.entries()) {
    const a = (k * SEGMENT_DEG - 90) * (Math.PI / 180);
    ctx.fillText(String(n), c + Math.cos(a) * numR, c + Math.sin(a) * numR);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}
