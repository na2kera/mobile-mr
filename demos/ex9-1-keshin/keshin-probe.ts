// 確認用（ヘッドレス）: 段階 3 の C の見え方を画素で調べる。鏡とスマホの確認用の口（window.__keshinMirror / __keshin）から呼ぶ。
//   dissolve: 化身の腰の近く（溶ける範囲）の画素の密度が、下へ行くほど小さいか（切り口が無いか）
//   stream: 背中からの光の流れが、背中の点から腰の点まで曲線に沿って描かれているか
import * as THREE from "three";
import type { KeshinView } from "./keshin-view";

type Render = () => void;

function readAll(gl: WebGLRenderingContext | WebGL2RenderingContext): { buf: Uint8Array; w: number; h: number } {
  const w = gl.drawingBufferWidth;
  const h = gl.drawingBufferHeight;
  const buf = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  return { buf, w, h };
}

/** 「その部分だけ描いたとき」と「化身を丸ごと描かないとき」の差の画素（true = 変わった）。行 0 = 画面の上 */
function diffMask(gl: WebGLRenderingContext | WebGL2RenderingContext, render: Render, view: KeshinView, only: "model" | "stream"): { on: Uint8Array; w: number; h: number } {
  const hideOthers = <T>(fn: () => T): T =>
    only === "model" ? view.withHidden("aura", () => view.withHidden("stream", fn)) : view.withHidden("aura", () => view.withHidden("model", fn));
  const a = hideOthers(() => {
    render();
    return readAll(gl);
  });
  const was = view.group.visible;
  view.group.visible = false;
  render();
  const b = readAll(gl);
  view.group.visible = was;
  const on = new Uint8Array(a.w * a.h);
  for (let i = 0; i < on.length; i++) {
    const j = i * 4;
    const d = Math.abs(a.buf[j] - b.buf[j]) + Math.abs(a.buf[j + 1] - b.buf[j + 1]) + Math.abs(a.buf[j + 2] - b.buf[j + 2]);
    if (d > 24) {
      const x = i % a.w;
      const yGl = Math.floor(i / a.w);
      on[(a.h - 1 - yGl) * a.w + x] = 1;
    }
  }
  return { on, w: a.w, h: a.h };
}

/** ワールドの点 → 画面の画素（行 0 = 上）。viewport = 描画バッファ全体（鏡）か左目（スマホ） */
function project(p: THREE.Vector3, camera: THREE.Camera, vp: { x: number; w: number; h: number }): [number, number] {
  const v = p.clone().project(camera);
  return [vp.x + ((v.x + 1) / 2) * vp.w, ((1 - v.y) / 2) * vp.h];
}

/**
 * 切り口が無いか: 腰（切断面の中心）から上 dissolveM の範囲を 3 つの帯に分け、化身の中央の列の画素の密度を比べる
 * （上の帯 > 中 > 腰の帯。腰の帯は溶ける範囲の上の帯の半分未満になる）。waistY = 切り口、pivotY = 腰の支点（切り口の showM 上）の画面の行
 */
export function probeDissolve(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  render: Render,
  view: KeshinView,
  camera: THREE.Camera,
  dissolveM: number,
  vp?: { x: number; w: number; h: number },
): { bands: number[]; waistY: number; topY: number; pivotY: number } | null {
  const plane = view.cutPlaneWorld();
  if (!plane) return null;
  const { on, w, h } = diffMask(gl, render, view, "model");
  const area = vp ?? { x: 0, w, h };
  const waist = project(plane.point, camera, area);
  const up = project(plane.point.clone().addScaledVector(plane.normal, dissolveM), camera, area);
  const above = project(plane.point.clone().addScaledVector(plane.normal, dissolveM * 1.6), camera, area);
  const cx = waist[0];
  const half = Math.max(8, Math.abs(waist[1] - up[1]) * 0.6);
  const density = (y0: number, y1: number) => {
    let n = 0;
    let t = 0;
    for (let y = Math.max(0, Math.round(Math.min(y0, y1))); y <= Math.min(h - 1, Math.round(Math.max(y0, y1))); y++) {
      for (let x = Math.max(0, Math.round(cx - half)); x <= Math.min(w - 1, Math.round(cx + half)); x++) {
        t++;
        n += on[y * w + x];
      }
    }
    return t ? n / t : 0;
  };
  const seg = (k0: number, k1: number) => density(waist[1] + (up[1] - waist[1]) * k0, waist[1] + (up[1] - waist[1]) * k1);
  // 帯: 溶ける範囲の上（溶けていない）/ 範囲の上半分 / 範囲の下 1/4（腰の近く）
  const bands = [density(up[1], above[1]), seg(0.5, 1), seg(0.05, 0.3)];
  // 腰の支点（切り口 + showM。化身の位置の基準で、切り口を下げても動かない）の画面の行
  const pivot = project(plane.point.clone().addScaledVector(plane.normal, view.below?.showM ?? 0), camera, area);
  return { bands, waistY: waist[1], topY: up[1], pivotY: pivot[1] };
}

/** 光の流れがつながっているか: 曲線上の点（t = 0.12〜0.78）を画面に投影し、そのまわり r px に流れの画素があるか */
export function probeStream(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  render: Render,
  view: KeshinView,
  camera: THREE.Camera,
  vp?: { x: number; w: number; h: number },
  r = 7,
): { hits: number; total: number; samples: { t: number; x: number; y: number; hit: boolean }[] } | null {
  const s = view.stream;
  if (!s || !s.group.visible) return null;
  const { on, w, h } = diffMask(gl, render, view, "stream");
  const area = vp ?? { x: 0, w, h };
  const u = s.uniforms;
  const bez = (t: number) => {
    const k = 1 - t;
    return new THREE.Vector3()
      .addScaledVector(u.uP0.value, k * k * k)
      .addScaledVector(u.uP1.value, 3 * k * k * t)
      .addScaledVector(u.uP2.value, 3 * k * t * t)
      .addScaledVector(u.uP3.value, t * t * t)
      .applyMatrix4(s.group.matrixWorld);
  };
  const samples: { t: number; x: number; y: number; hit: boolean }[] = [];
  for (let i = 0; i <= 6; i++) {
    const t = 0.12 + (0.66 * i) / 6;
    const [x, y] = project(bez(t), camera, area);
    let hit = false;
    for (let dy = -r; dy <= r && !hit; dy++) {
      for (let dx = -r; dx <= r && !hit; dx++) {
        const X = Math.round(x + dx);
        const Y = Math.round(y + dy);
        if (X >= 0 && Y >= 0 && X < w && Y < h && on[Y * w + X]) hit = true;
      }
    }
    samples.push({ t, x, y, hit });
  }
  return { hits: samples.filter((q) => q.hit).length, total: samples.length, samples };
}
