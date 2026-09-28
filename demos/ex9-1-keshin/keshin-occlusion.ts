// 段階 2: カメラに写った人の形（MediaPipe PoseLandmarker の segmentation mask）で相手の化身を隠す。
// 人が写っている画素のうち、**持ち主（相手）の頭よりカメラから遠い部分**の相手の化身（とその足元・腰のオーラ）を描かない。
// 相手がこちらを向いていれば化身は相手の向こう側なので人の形で隠れ、向こうを向いていれば化身は相手の手前なので隠さない
// （断片のカメラからの距離 > 持ち主の頭までの距離 − ?maskDepthMargin=0.15 のときだけ捨てる。眼ごとのカメラ位置で）。
// 自分の化身・視界の周りのオーラは隠さない。
//   - マスクは CPU で 1 枚の R8 テクスチャにまとめる（複数人は画素ごとの最大）。MediaPipe の GL コンテキストは three と別なので
//     テクスチャを共有できない（getAsFloat32Array で読み戻す）
//   - シェーダー: gl_FragCoord から「その眼のビューポート内の位置」を出し、背景の VideoTexture と同じ UV 変換
//     （passthrough-camera.ts の coverUvTransform = texture.matrix）でマスクの座標に直して、人ならディザで discard する。
//     眼のビューポートは onBeforeRender で renderer.getCurrentViewport から入れる（StereoEffect は眼ごとに render を呼ぶ）。
//     深度の前描画も同じ条件で discard する（透けを防ぐ）。純粋な式は keshin-math.ts の maskUvFromFragment（テスト済み）
//   - 縁は数 px 膨らませる（?maskDilatePx=。マスクの画素で、周り 8 方向の最大）。境界は段階 1 の目の近くと同じディザでぼかす
//   - PC 確認用のフェイク（?fakeperson=1）: 相手の申告位置に fake-body.ts の合成の体を置き、フェイクカメラの映像に描くのと
//     同じ形をマスクにも描く（MediaPipe の代わり。マスク → テクスチャ → シェーダーの経路を確かめる）
import * as THREE from "three";
// .ts 付き import は Node のテスト（scripts/test-keshin.mjs の PersonMask）から読むため
import { BODY_CONNECTIONS } from "../../src/shared/body-math.ts";
import { eyesAboveHip, syntheticBodyShape } from "../../src/shared/fake-body.ts";
import { invertRigid, transformPoint } from "../../src/shared/marker-layout.ts";
import type { V3 } from "./keshin-math.ts";

export type MaskUniforms = {
  /** 1 = 隠す（マスクが有効）。0 = 隠さない（?occlude=0・マスク未取得・失敗） */
  uMaskOn: { value: number };
  uMaskTex: { value: THREE.Texture };
  /** 背景の VideoTexture の UV 変換（texture.matrix。cover・camZoom） */
  uMaskUv: { value: THREE.Matrix3 };
  /** いま描いている眼のビューポート（描画バッファの px） */
  uEyeVp: { value: THREE.Vector4 };
  /** マスクの 1 画素（1 / 幅, 1 / 高さ） */
  uMaskTexel: { value: THREE.Vector2 };
  /** 縁を膨らませる量 [マスクの px] */
  uMaskDilate: { value: number };
  /** 持ち主の頭よりこれだけ手前（カメラに近い）までは隠さない [m]（?maskDepthMargin=） */
  uMaskDepthMargin: { value: number };
};

/** 化身ごとの uniform: 持ち主（相手）の頭のワールド位置（表示中の、なめらかにした位置） */
export type OwnerUniforms = { uOwnerHead: { value: THREE.Vector3 } };

/** 化身 1 体ぶんの隠す処理の uniform（全員で共有するマスク + その化身の持ち主の頭） */
export type MaskBinding = { shared: MaskUniforms; owner: OwnerUniforms };

export function createOwnerUniforms(): OwnerUniforms {
  return { uOwnerHead: { value: new THREE.Vector3() } };
}

const EMPTY_MASK = new THREE.DataTexture(new Uint8Array([0]), 1, 1, THREE.RedFormat, THREE.UnsignedByteType);
EMPTY_MASK.needsUpdate = true;

export function createMaskUniforms(dilatePx: number, depthMarginM = 0.15): MaskUniforms {
  return {
    uMaskDepthMargin: { value: depthMarginM },
    uMaskOn: { value: 0 },
    uMaskTex: { value: EMPTY_MASK },
    uMaskUv: { value: new THREE.Matrix3() },
    uEyeVp: { value: new THREE.Vector4(0, 0, 1, 1) },
    uMaskTexel: { value: new THREE.Vector2(1, 1) },
    uMaskDilate: { value: dilatePx },
  };
}

/**
 * フラグメントシェーダーの先頭に足す宣言と判定関数（keshinMasked(断片のワールド位置) が true なら discard）。
 * cameraPosition は three がいま描いている眼のカメラ（StereoEffect は眼ごとに render を呼ぶ）
 */
export const MASK_HEAD_GLSL = /* glsl */ `
uniform float uMaskOn;
uniform sampler2D uMaskTex;
uniform mat3 uMaskUv;
uniform vec4 uEyeVp;
uniform vec2 uMaskTexel;
uniform float uMaskDilate;
uniform float uMaskDepthMargin;
uniform vec3 uOwnerHead;
bool keshinMasked(vec3 worldPos) {
  if (uMaskOn < 0.5) return false;
  // 持ち主の頭より手前（カメラに近い）の部分は、人より前にあるので隠さない
  if (distance(worldPos, cameraPosition) <= distance(uOwnerHead, cameraPosition) - uMaskDepthMargin) return false;
  vec2 vp = (gl_FragCoord.xy - uEyeVp.xy) / uEyeVp.zw;
  vec2 t = (uMaskUv * vec3(vp, 1.0)).xy;
  if (t.x < 0.0 || t.x > 1.0 || t.y < 0.0 || t.y > 1.0) return false;
  vec2 muv = vec2(t.x, 1.0 - t.y);
  vec2 d = uMaskTexel * uMaskDilate;
  vec2 e = d * 0.7071;
  float m = texture2D(uMaskTex, muv).r;
  m = max(m, texture2D(uMaskTex, muv + vec2(d.x, 0.0)).r);
  m = max(m, texture2D(uMaskTex, muv - vec2(d.x, 0.0)).r);
  m = max(m, texture2D(uMaskTex, muv + vec2(0.0, d.y)).r);
  m = max(m, texture2D(uMaskTex, muv - vec2(0.0, d.y)).r);
  m = max(m, texture2D(uMaskTex, muv + e).r);
  m = max(m, texture2D(uMaskTex, muv - e).r);
  m = max(m, texture2D(uMaskTex, muv + vec2(e.x, -e.y)).r);
  m = max(m, texture2D(uMaskTex, muv + vec2(-e.x, e.y)).r);
  // 境界は画素の位置で決まるノイズと比べてぼかす（深度の前描画と色で同じ画素になる）。
  // マスクの値は CPU で確信度の裾を切ってある（PersonMask の edge）ので、人の周りに点状の穴は散らない
  float n = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  return m > n;
}
`;

/** 描く前に、いま描いている眼のビューポートを uniform に入れる（Mesh / Points の onBeforeRender） */
export function attachEyeViewport(root: THREE.Object3D, u: MaskUniforms) {
  const set = (renderer: THREE.WebGLRenderer) => {
    renderer.getCurrentViewport(u.uEyeVp.value);
  };
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh || (o as THREE.Points).isPoints) o.onBeforeRender = set;
  });
}

/**
 * 人の形のマスク（1 枚の R8 テクスチャ）。複数人のマスクは画素ごとの最大でまとめる。
 * 大きさが変わったらテクスチャを作り直して uniform を差し替える
 */
export class PersonMask {
  private texture: THREE.DataTexture | null = null;
  private data = new Uint8Array(0);
  private w = 0;
  private h = 0;
  /** 直近に更新した時刻 [ms]（performance.now()） */
  updatedMs = -Infinity;
  /** 人が写っている画素があったか（直近の更新） */
  hasPerson = false;
  private readonly uniforms: MaskUniforms;
  /**
   * 確信度の裾の切り方（MediaPipe の confidence を smoothstep(lo, hi, v) にしてから 0..255 にする。?maskEdge=0.3,0.7）。
   * 確信度をそのままディザの確率にすると、人の周りの低い確信度の画素に点状の穴が散るため
   */
  edge: [number, number];
  constructor(uniforms: MaskUniforms, edge: [number, number] = [0.3, 0.7]) {
    this.uniforms = uniforms;
    this.edge = edge;
  }
  get size(): [number, number] {
    return [this.w, this.h];
  }
  /** CPU 側の値（0..255、行 0 が画像の上）。確認用 */
  get pixels(): Uint8Array {
    return this.data;
  }
  private ensure(w: number, h: number) {
    if (this.texture && w === this.w && h === this.h) return;
    this.texture?.dispose();
    this.w = w;
    this.h = h;
    this.data = new Uint8Array(w * h);
    const tex = new THREE.DataTexture(this.data, w, h, THREE.RedFormat, THREE.UnsignedByteType);
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    // 幅が 4 の倍数でないと行がずれる（R8 は 1 画素 1 バイト）
    tex.unpackAlignment = 1;
    this.texture = tex;
    this.uniforms.uMaskTex.value = tex;
    this.uniforms.uMaskTexel.value.set(1 / w, 1 / h);
  }
  /**
   * MediaPipe の confidence mask（0..1 の float、人数ぶん。行 0 が画像の上 = MPImage の getAsImageData と同じ並び）から作る。
   * 複数人は画素ごとの最大。確信度は edge で裾を切ってから 0..255 にする
   */
  setFromFloat(masks: readonly Float32Array[], w: number, h: number, valueScale = 1) {
    this.ensure(w, h);
    const out = this.data;
    out.fill(0);
    let any = false;
    const [lo, hi] = this.edge;
    const span = hi > lo ? hi - lo : 1e-6;
    for (const m of masks) {
      const n = Math.min(m.length, out.length);
      for (let i = 0; i < n; i++) {
        let t = (m[i] * valueScale - lo) / span;
        if (t <= 0) continue;
        if (t > 1) t = 1;
        const v = Math.round(t * t * (3 - 2 * t) * 255);
        if (v > out[i]) {
          out[i] = v;
          if (v > 127) any = true;
        }
      }
    }
    this.commit(any);
  }
  /** 2D canvas の赤チャンネルから作る（フェイクの人） */
  setFromImageData(img: ImageData) {
    this.ensure(img.width, img.height);
    const out = this.data;
    let any = false;
    for (let i = 0; i < out.length; i++) {
      const v = img.data[i * 4];
      out[i] = v;
      if (v > 127) any = true;
    }
    this.commit(any);
  }
  /** 何も写っていない（マスクを消す） */
  clear() {
    if (!this.texture) return;
    this.data.fill(0);
    this.commit(false);
  }
  private commit(any: boolean) {
    if (this.texture) this.texture.needsUpdate = true;
    this.hasPerson = any;
    this.updatedMs = typeof performance !== "undefined" ? performance.now() : Date.now();
  }
  dispose() {
    this.texture?.dispose();
    this.texture = null;
    this.uniforms.uMaskTex.value = EMPTY_MASK;
  }
}

// ---- PC 確認用のフェイクの人（?fakeperson=1）----

/** フェイクの人の形（画像の px）: 頭の円・胴の四角形・手足の太い線 */
export type PersonShape = {
  head: { x: number; y: number; r: number };
  torso: [number, number][];
  limbs: { a: [number, number]; b: [number, number]; w: number }[];
  /** 本人の左手首（画像の px。鏡モードの確認で左右を見分ける印に使う） */
  leftHand: [number, number];
};

/**
 * 相手の申告位置（頭・体の向き。マーカー座標系）に fake-body.ts の合成の体を立たせ、フェイクカメラ（カメラ → field の姿勢・
 * 焦点距離 [px]）の画像に投影する。カメラの後ろに回る体は null
 */
export function projectFakePerson(
  person: { head: V3; fwd: readonly [number, number] },
  camToField: number[],
  focalPx: number,
  width: number,
  height: number,
): PersonShape | null {
  const shape = syntheticBodyShape();
  const eyes = eyesAboveHip(shape);
  const f = person.fwd;
  // 体の軸（field）: 左 = 上 × 前、後ろ = −前
  const left: V3 = [f[1], 0, -f[0]];
  const back: V3 = [-f[0], 0, -f[1]];
  const hip: V3 = [
    person.head[0] - (left[0] * eyes.x + back[0] * eyes.z),
    person.head[1] - eyes.y,
    person.head[2] - (left[2] * eyes.x + back[2] * eyes.z),
  ];
  const fieldToCam = invertRigid(camToField);
  const pts: ([number, number, number] | null)[] = shape.map((p) => {
    const w: V3 = [hip[0] + left[0] * p.x + back[0] * p.z, hip[1] + p.y, hip[2] + left[2] * p.x + back[2] * p.z];
    const c = transformPoint(fieldToCam, w);
    if (-c[2] < 0.1) return null;
    return [width / 2 + (focalPx * c[0]) / -c[2], height / 2 - (focalPx * c[1]) / -c[2], -c[2]];
  });
  if (pts.some((p) => p === null)) return null;
  const P = pts as [number, number, number][];
  const px = (m: number, depth: number) => (focalPx * m) / depth;
  const headC: V3 = [person.head[0], person.head[1], person.head[2]];
  const hc = transformPoint(fieldToCam, headC);
  if (-hc[2] < 0.1) return null;
  const head = { x: width / 2 + (focalPx * hc[0]) / -hc[2], y: height / 2 - (focalPx * hc[1]) / -hc[2], r: px(0.12, -hc[2]) };
  // 胴: 両肩（11, 12）と両腰（23, 24）を少し外へ広げた四角形
  const torso: [number, number][] = [P[11], P[12], P[24], P[23]].map((q) => [q[0], q[1]]);
  const limbs = BODY_CONNECTIONS.filter(([a, b]) => a >= 11 && b >= 11).map(([a, b]) => ({
    a: [P[a][0], P[a][1]] as [number, number],
    b: [P[b][0], P[b][1]] as [number, number],
    w: px(0.13, (P[a][2] + P[b][2]) / 2),
  }));
  return { head, torso, limbs, leftHand: [P[15][0], P[15][1]] };
}

/** 人の形を 2D canvas に塗る（scale で画像の px → canvas の px） */
export function drawPersonShape(ctx: CanvasRenderingContext2D, s: PersonShape, fill: string, scale = 1) {
  ctx.save();
  ctx.fillStyle = fill;
  ctx.strokeStyle = fill;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  s.torso.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x * scale, y * scale) : ctx.lineTo(x * scale, y * scale)));
  ctx.closePath();
  ctx.fill();
  ctx.lineWidth = s.limbs.reduce((m, l) => Math.max(m, l.w), 0) * scale;
  ctx.stroke();
  for (const l of s.limbs) {
    ctx.lineWidth = l.w * scale;
    ctx.beginPath();
    ctx.moveTo(l.a[0] * scale, l.a[1] * scale);
    ctx.lineTo(l.b[0] * scale, l.b[1] * scale);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(s.head.x * scale, s.head.y * scale, s.head.r * scale, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// ---- 人の形のマスクの中身の診断と、骨格から描く人の形（段階 3 の A）----

/**
 * マスク（MediaPipe の confidence。人数ぶん）の中身の統計: 最大・平均・0.5 を超える画素の割合・NaN の割合。
 * 実機（iOS / Safari）では poses=1 masks=1 なのに person=0 だった。vision_bundle の MPMask.getAsFloat32Array は
 * GPU のマスクを readPixels(FLOAT) で読むので、その読み戻しが効かない環境では 0（や NaN）が返っていると見ている。
 * 値が 0..255 の float で来る想定違いも疑い、最大が 1.5 を超えたら scale = 1/255 を返す（setFromFloat の valueScale に渡す）
 */
export function maskStats(masks: readonly Float32Array[]): { max: number; mean: number; frac: number; nan: number; scale: number } {
  let max = 0;
  let sum = 0;
  let over = 0;
  let nan = 0;
  let n = 0;
  for (const m of masks) {
    for (let i = 0; i < m.length; i++) {
      const v = m[i];
      n++;
      if (!(v === v)) {
        nan++;
        continue;
      }
      if (v > max) max = v;
      sum += v;
    }
  }
  const scale = max > 1.5 ? 1 / 255 : 1;
  if (n > 0) for (const m of masks) for (let i = 0; i < m.length; i++) if (m[i] * scale > 0.5) over++;
  return { max, mean: n > 0 ? (sum / n) * scale : 0, frac: n > 0 ? over / n : 0, nan: n > 0 ? nan / n : 0, scale };
}

export type MaskSource = "seg" | "skel" | "fake";

/** 出どころを切り替えるのに要る「続けて反対を示した結果」の回数（1 回のばらつきで切り替わらないように） */
export const MASK_SOURCE_SWITCH_N = 5;

/** 出どころの状態: 今の source と、反対を示す結果がそのまま続いた回数だけ（教訓 4） */
export type MaskSourceState = { source: MaskSource; run: number };

/**
 * 人の形の出どころを決める。mode = ?maskSource=（seg / skel / auto。seg・skel は強制）。
 * auto: 人を見つけている（poses > 0）のにマスクの最大（0..1 に直した値）が minMax 未満なら skel 寄り、以上なら seg 寄り。
 * 今と反対を示す結果が switchN 回続いたら切り替える（途中で今と同じ側の結果が出たら数え直し）。人がいない結果（poses = 0）では変えない
 */
export function decideMaskSource(
  state: MaskSourceState,
  mode: "seg" | "skel" | "auto",
  poses: number,
  mmaxNorm: number,
  minMax: number,
  switchN = MASK_SOURCE_SWITCH_N,
): MaskSourceState {
  if (mode === "seg" || mode === "skel") return { source: mode, run: 0 };
  const cur: MaskSource = state.source === "fake" ? "seg" : state.source;
  if (poses <= 0) return { source: cur, run: state.run };
  const want: MaskSource = mmaxNorm < minMax ? "skel" : "seg";
  if (want === cur) return { source: cur, run: 0 };
  const run = state.run + 1;
  return run >= switchN ? { source: want, run: 0 } : { source: cur, run };
}

type Lm = { x: number; y: number; visibility?: number };

/**
 * Pose の 33 点（画像の正規化座標）から人の形を作る（マスクの画素 w × h の座標）。drawPersonShape で塗れる形:
 * 頭 = 円（両耳の中点、見えなければ鼻。半径は両耳の間隔か肩幅から）、胴 = 両肩・両腰の四角形（腰が見えなければ肩から下へ肩幅 × 1.3）、
 * 首・腕・脚 = 太さのあるカプセル（太さは肩幅に比例: 首 0.45・腕 0.32・脚 0.42）。visibility が minVis 未満の点は使わない
 * （肩が両方見えなければ null）
 */
export function skeletonPersonShape(lm: readonly Lm[], w: number, h: number, minVis = 0.3): PersonShape | null {
  if (lm.length < 33) return null;
  const ok = (i: number) => (lm[i].visibility ?? 1) >= minVis;
  const P = (i: number): [number, number] => [lm[i].x * w, lm[i].y * h];
  if (!ok(11) || !ok(12)) return null;
  const ls = P(11);
  const rs = P(12);
  const sw = Math.max(4, Math.hypot(ls[0] - rs[0], ls[1] - rs[1]));
  let head: { x: number; y: number; r: number };
  if (ok(7) && ok(8)) {
    const a = P(7);
    const b = P(8);
    head = { x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2, r: Math.max(0.55 * Math.hypot(a[0] - b[0], a[1] - b[1]), 0.3 * sw) };
  } else if (ok(0)) {
    const n = P(0);
    head = { x: n[0], y: n[1], r: 0.38 * sw };
  } else {
    // 頭の点が見えない: 肩の中点の上に肩幅から置く
    head = { x: (ls[0] + rs[0]) / 2, y: (ls[1] + rs[1]) / 2 - 0.7 * sw, r: 0.36 * sw };
  }
  const hips: [number, number][] = ok(23) && ok(24) ? [P(23), P(24)] : [[ls[0], ls[1] + 1.3 * sw], [rs[0], rs[1] + 1.3 * sw]];
  const torso: [number, number][] = [ls, rs, hips[1], hips[0]];
  const limbs: PersonShape["limbs"] = [];
  const mid: [number, number] = [(ls[0] + rs[0]) / 2, (ls[1] + rs[1]) / 2];
  limbs.push({ a: mid, b: [head.x, head.y], w: 0.45 * sw });
  const cap = (a: number, b: number, k: number) => {
    if (ok(a) && ok(b)) limbs.push({ a: P(a), b: P(b), w: k * sw });
  };
  cap(11, 13, 0.32);
  cap(13, 15, 0.28);
  cap(12, 14, 0.32);
  cap(14, 16, 0.28);
  cap(23, 25, 0.42);
  cap(25, 27, 0.36);
  cap(24, 26, 0.42);
  cap(26, 28, 0.36);
  return { head, torso, limbs, leftHand: P(15) };
}

// ---- 遅い端末では検出の回数を自動で下げる（stage2-fix2 の 4）----

/** 検出の回数の段 [回/s]。URL の ?maskHz= が上限（先頭）になる */
export const MASK_HZ_STEPS = [15, 10, 6, 4] as const;
/** 直近 DOWN_SAMPLES 秒の fps の平均がこれを下回ったら 1 段下げる */
export const MASK_HZ_DOWN_FPS = 30;
export const MASK_HZ_DOWN_SAMPLES = 2;
/** 直近 UP_SAMPLES 秒の fps がすべてこれを超えたら 1 段戻す */
export const MASK_HZ_UP_FPS = 45;
export const MASK_HZ_UP_SAMPLES = 5;

/** 上限 cap（?maskHz=）から段の並びを作る: 15 → [15, 10, 6, 4]、8 → [8, 6, 4]、3 → [3]、20 → [20, 15, 10, 6, 4] */
export function maskHzLevels(cap: number): number[] {
  return [cap, ...MASK_HZ_STEPS.filter((hz) => hz < cap)];
}

/**
 * 段を決める純粋関数（scripts/test-keshin.mjs でテスト）。level = 今の段（maskHzLevels の添字）、samples = 今の段になってからの
 * 1 秒ごとの fps（古い順）。段を変えたら呼び出し側は samples を捨てる（下げた効果を見てから次を決める。持つ状態は「今の段」だけ）
 */
export function decideMaskHzLevel(level: number, levelCount: number, samples: readonly number[]): { level: number; reason: string | null } {
  if (samples.length >= MASK_HZ_DOWN_SAMPLES && level < levelCount - 1) {
    const last = samples.slice(-MASK_HZ_DOWN_SAMPLES);
    const mean = last.reduce((a, b) => a + b, 0) / last.length;
    if (mean < MASK_HZ_DOWN_FPS) return { level: level + 1, reason: `fps${MASK_HZ_DOWN_SAMPLES}s=${mean.toFixed(0)}<${MASK_HZ_DOWN_FPS}` };
  }
  if (samples.length >= MASK_HZ_UP_SAMPLES && level > 0) {
    const last = samples.slice(-MASK_HZ_UP_SAMPLES);
    if (last.every((f) => f > MASK_HZ_UP_FPS)) return { level: level - 1, reason: `fps>${MASK_HZ_UP_FPS} for ${MASK_HZ_UP_SAMPLES}s(min=${Math.min(...last).toFixed(0)})` };
  }
  return { level, reason: null };
}

/**
 * 描画の fps を 1 秒ごとに数えて decideMaskHzLevel に渡す。数えるのは人の形の検出を回している間だけ（止まっている間の fps は
 * 検出の重さと関係ないので捨てる）。段が変わったら「from→to 理由」を返す（ログ用）
 */
export class MaskHzGovernor {
  readonly levels: number[];
  level = 0;
  private samples: number[] = [];
  private bucketStartMs = -1;
  private frames = 0;
  private readonly adaptive: boolean;

  constructor(cap: number, adaptive: boolean) {
    this.levels = adaptive ? maskHzLevels(cap) : [cap];
    this.adaptive = adaptive;
  }

  get hz(): number {
    return this.levels[this.level];
  }

  get cap(): number {
    return this.levels[0];
  }

  /** 毎フレーム呼ぶ。running = このフレームで人の形の検出を回す状態か */
  frame(now: number, running: boolean): string | null {
    if (!this.adaptive) return null;
    if (!running) {
      this.samples = [];
      this.bucketStartMs = -1;
      return null;
    }
    if (this.bucketStartMs < 0) {
      this.bucketStartMs = now;
      this.frames = 0;
      return null;
    }
    this.frames++;
    const span = now - this.bucketStartMs;
    if (span < 1000) return null;
    this.samples.push((this.frames * 1000) / span);
    if (this.samples.length > MASK_HZ_UP_SAMPLES) this.samples.shift();
    this.bucketStartMs = now;
    this.frames = 0;
    const d = decideMaskHzLevel(this.level, this.levels.length, this.samples);
    if (d.level === this.level) return null;
    const from = this.hz;
    this.level = d.level;
    this.samples = [];
    return `${from}→${this.hz} reason=${d.reason}`;
  }
}

// ---- 人の形の検出を回す（PoseLandmarker の segmentation mask / フェイク）----

export type OcclusionOptions = {
  /** ?occlude=0 で false（隠す処理を丸ごと止める。Pose も読み込まない） */
  enabled: boolean;
  /** ?fakeperson=1: MediaPipe の代わりにフェイクの人の形を使う（PC 確認用） */
  fake: boolean;
  /** 検出の回数の上限 [回/s]（?maskHz=） */
  maskHz: number;
  /** fps を見て検出の回数を自動で下げる（?maskHzAuto=0 で止める） */
  maskHzAuto: boolean;
  /** 同時に検出する人数の上限（?maskPoses=） */
  maxPoses: number;
  /** 推論に渡す画像の長辺 [px]（?maskDetW=。マスクの大きさもこれになる） */
  detW: number;
  delegate: "GPU" | "CPU" | "auto";
  modelUrls: string[];
  /** マスクがこれより古くなったら隠すのをやめる [ms] */
  staleOffMs: number;
  /**
   * ?maskDebug=1: 相手がいなくても・視野に化身が無くても読み込んで回す（実機で人の形が出るかを 1 台で確かめる）。
   * 画面の隅の縮小画像（debugCanvases）もこのときだけ描く
   */
  debug: boolean;
  /** delegate = auto で GPU の人数が 0 のままこれだけ続いたら、CPU でも回して比べる [ms] */
  probeAfterMs: number;
  /**
   * 1 回の結果の骨格（画像の正規化座標 landmarks と実寸の worldLandmarks。人ごと）を受け取る（鏡モードが人の位置を出すのに使う）。
   * コールバックの中で呼ぶので、受け取った側は必要なら写してから持つ
   */
  onPoses?: (landmarks: BodyLandmarkLike[][], worldLandmarks: BodyLandmarkLike[][], now: number) => void;
  /** 人の形の出どころ（?maskSource=seg|skel|auto。既定 auto: seg の中身が空なら骨格から描く） */
  maskSource?: "seg" | "skel" | "auto";
  /** auto で「seg の中身が空」とみなすマスクの最大値（?maskMinMax=0.1） */
  maskMinMax?: number;
  /** ?fakeperson=1 のときの合成の骨格（onPoses に渡す。MediaPipe の代わり） */
  fakePoses?: () => { landmarks: BodyLandmarkLike[][]; worldLandmarks: BodyLandmarkLike[][] };
  log: (kind: string, detail: string) => void;
};

/** MediaPipe の NormalizedLandmark / Landmark（使う部分） */
export type BodyLandmarkLike = { x: number; y: number; z: number; visibility?: number };

type PoseCallbackResult = {
  landmarks?: BodyLandmarkLike[][];
  worldLandmarks?: BodyLandmarkLike[][];
  segmentationMasks?: { width: number; height: number; getAsFloat32Array(): Float32Array }[];
};

/** 使う PoseLandmarker の部分（コールバック版の detectForVideo。結果のマスクはコールバックの中でだけ有効） */
type PoseCallbackLandmarker = {
  detectForVideo(source: HTMLVideoElement | HTMLCanvasElement, timestampMs: number, callback: (result: PoseCallbackResult) => void): void;
};

type PoseTrackerLike = {
  delegate: string;
  modelUrl: string;
  modelBuffer: ArrayBuffer;
  lastMs: number;
  lastInput: string;
  detectWith(video: HTMLVideoElement, run: (landmarker: unknown, source: HTMLVideoElement | HTMLCanvasElement, timestampMs: number) => void): boolean;
  close(): void;
};

/** 入力の明るさを測る間隔 [ms]（真っ黒の映像を渡していないか。iOS の drawImage 対策の切り分け） */
const LUMA_EVERY_MS = 1000;
/** ?maskDebug=1 の縮小画像を描く間隔 [ms] */
const DEBUG_DRAW_EVERY_MS = 150;
/** GPU と CPU を同じフレームで比べる回数 */
const PROBE_RUNS = 3;
/** 比べて CPU でも 0 人だったら（人が写っていないだけかもしれない）、次に比べるまで待つ [ms] と、比べる回数の上限 */
const PROBE_RETRY_MS = 30000;
const PROBE_MAX = 4;

/** ?maskDebug=1 の画面の隅の縮小画像（Pose に渡した入力と、最新のマスク） */
export type MaskDebugCanvases = { input: HTMLCanvasElement; mask: HTMLCanvasElement };

/**
 * 人の形のマスクを ?maskHz= 以下で更新する。
 *   - 読み込み（モデル・wasm・GPU の初期化）は、隠す処理が有効で相手が 1 人でも入室したら先に済ませる（初めて視野に入った瞬間に
 *     重い初期化が走らないように）。人数は最初から ?maskPoses= で作り、使っている最中に作り直さない（GL コンテキストが 2 組になる山を避ける）
 *   - 回すのは、相手の化身（モデルかオーラ）が視野に入っていそうな間だけ。マーカー検出と同じフレームでは回さない
 *   - 回数は fps を見て自動で下げる（MaskHzGovernor。15 → 10 → 6 → 4、?maskHz= が上限）
 *   - Pose の読み込み・推論に失敗したら隠さずに描く（化身は止めない）
 *   - 診断（HUD と実機ログの 1 行）: 1 回の結果の人数（landmarks）・マスクの枚数・入力の大きさ・入力の平均の明るさ・delegate
 *   - delegate = auto で GPU が 0 人のまま続いたら、CPU でも同じフレームを回して比べ、CPU だけ人が出るなら CPU に切り替える
 */
export class OcclusionController {
  readonly uniforms: MaskUniforms;
  readonly mask: PersonMask;
  readonly governor: MaskHzGovernor;
  private readonly opts: OcclusionOptions;
  status: "off" | "idle" | "loading" | "ready" | "failed" = "idle";
  detail = "";
  private tracker: PoseTrackerLike | null = null;
  private running = false;
  private lastRunMs = -Infinity;
  /** マスクの更新の時刻（直近 1 秒の回数を数える） */
  private updates: number[] = [];
  /** 直近の推論 1 回の ms（detectForVideo。コールバックの中のマスクの読み戻しを含む） */
  poseMs = 0;
  /** 直近のマスクの更新 1 回の ms（推論 + マスクの読み戻し・変換・テクスチャの更新の予約。アップロード自体は次の描画で行われる） */
  maskMs = 0;
  /** 隠した（マスクを当てた）ことがあるか */
  everMasked = false;
  /** 確認用: 隠す処理を一時的に止める（検出は続ける） */
  disabled = false;
  // ---- 診断 ----
  /** 直近 1 回の結果の人数（landmarks.length）とマスクの枚数（segmentationMasks.length）。null = まだ回していない */
  lastPoses: number | null = null;
  lastMasks: number | null = null;
  /** 直近の結果のマスクの中身（最大・平均・0.5 を超える割合・NaN の割合）。null = まだ */
  lastMaskStats: { max: number; mean: number; frac: number; nan: number; scale: number } | null = null;
  /** 人の形の出どころ（今の source）と、反対を示す結果が続いた回数。切り替えの状態はこれだけ */
  source: MaskSource = "seg";
  private sourceRun = 0;
  private sourceMode: "seg" | "skel" | "auto";
  private skelCanvas: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null = null;
  /** 直近に Pose に渡した入力の大きさ（"512x288"） */
  lastInput = "";
  /** 入力の平均の明るさ（0〜255、1 秒ごと）。null = まだ測っていない */
  lastLuma: number | null = null;
  private lumaAtMs = -Infinity;
  /** 回した回数と、そのうち人が 1 人以上出た回数（読み込んでから） */
  runs = 0;
  runsWithPerson = 0;
  /** GPU → CPU の比べ方（delegate = auto のときだけ） */
  probe: "-" | "waiting" | "loading" | "running" | "kept-gpu" | "switched-cpu" | "failed" = "-";
  private zeroSinceMs: number | null = null;
  private gpuProven = false;
  private probeCount = 0;
  private probeTracker: PoseTrackerLike | null = null;
  private probeRuns = 0;
  private probeCpuFound = 0;
  private probeGpuFound = 0;
  private nextProbeAtMs = 0;
  // ---- ?maskDebug=1 ----
  private debugCanvases: MaskDebugCanvases | null = null;
  private debugDrawnMs = -Infinity;
  private lumaCanvas: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null = null;

  constructor(opts: OcclusionOptions, dilatePx: number, depthMarginM: number, edge: [number, number]) {
    this.opts = opts;
    this.uniforms = createMaskUniforms(dilatePx, depthMarginM);
    this.mask = new PersonMask(this.uniforms, edge);
    this.governor = new MaskHzGovernor(opts.maskHz, opts.maskHzAuto);
    this.sourceMode = opts.maskSource ?? "auto";
    if (opts.fake) this.source = this.sourceMode === "skel" ? "skel" : "fake";
    if (!opts.enabled) this.status = "off";
  }

  /** 人の形の出どころを変える（確認用。?maskSource= と同じ） */
  setMaskSource(mode: "seg" | "skel" | "auto") {
    this.sourceMode = mode;
    if (this.opts.fake) this.setSource(mode === "skel" ? "skel" : "fake", "set");
  }

  private setSource(next: MaskSource, reason: string) {
    if (next === this.source) return;
    this.sourceRun = 0;
    this.opts.log("mask-source", `${this.source}→${next} ${reason}`);
    this.source = next;
  }

  /** 骨格（人ごとの 33 点の正規化座標）から人の形を w × h に塗ってマスクにする */
  private setFromSkeleton(people: readonly (readonly Lm[])[], w: number, h: number) {
    if (!this.skelCanvas) {
      const canvas = document.createElement("canvas");
      this.skelCanvas = { canvas, ctx: canvas.getContext("2d", { willReadFrequently: true })! };
    }
    const { canvas, ctx } = this.skelCanvas;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);
    for (const lm of people) {
      const shape = skeletonPersonShape(lm, w, h);
      if (shape) drawPersonShape(ctx, shape, "#fff");
    }
    this.mask.setFromImageData(ctx.getImageData(0, 0, w, h));
  }

  /** ?maskDebug=1 の縮小画像の描き先 */
  setDebugCanvases(c: MaskDebugCanvases | null) {
    this.debugCanvases = c;
  }

  /** 背景の VideoTexture の UV 変換（cover・camZoom）をマスクの uniform に写す（毎フレーム） */
  syncBackground(texture: THREE.Texture | null) {
    if (!texture) return;
    texture.updateMatrix();
    this.uniforms.uMaskUv.value.copy(texture.matrix);
  }

  get hz(): number {
    const now = performance.now();
    this.updates = this.updates.filter((t) => now - t <= 1000);
    return this.updates.length;
  }

  get ageMs(): number {
    return performance.now() - this.mask.updatedMs;
  }

  /** 実際に使っている delegate（フェイクは "fake"、読み込み前は "-"） */
  get delegate(): string {
    return this.opts.fake ? "fake" : (this.tracker?.delegate ?? "-");
  }

  /**
   * 毎フレーム呼ぶ。need = 相手の化身（モデルかオーラ）が視野に入っていそう、markerRan = このフレームでマーカー検出をした、
   * others = 相手の人数（1 人でもいれば読み込みだけ先に済ませる）、fakeImage = フェイクの人の形（?fakeperson=1 のとき）
   */
  update(
    now: number,
    need: boolean,
    video: HTMLVideoElement | null,
    markerRan: boolean,
    others: number,
    fakeImage: (() => ImageData | null) | null,
    /** 化身が視野に無くても回す（段階 3 の B: カメラで見た位置の割り当てと補正の学習のため。隠す処理は need のときだけ） */
    runAnyway = false,
  ) {
    if (!this.opts.enabled) {
      this.uniforms.uMaskOn.value = 0;
      return;
    }
    if (!this.opts.fake && this.status === "idle" && (others > 0 || this.opts.debug)) void this.load(this.opts.maxPoses);
    // ?maskDebug=1 は化身が視野に無くても回す（隠すのは化身が視野にあるときだけなのは同じ）
    const run = need || this.opts.debug || runAnyway;
    if (run !== this.running) {
      this.running = run;
      this.opts.log(run ? "mask-start" : "mask-stop", `${this.opts.fake ? "fake" : "pose"} status=${this.status} maskHz=${this.governor.hz}`);
      if (!run) this.mask.clear();
    }
    const change = this.governor.frame(now, run && (this.opts.fake || this.status === "ready"));
    if (change) this.opts.log("mask-hz", `${change} cap=${this.governor.cap}`);
    const dueMs = 1000 / this.governor.hz;
    if (run && !markerRan && now - this.lastRunMs >= dueMs) {
      if (this.opts.fake) {
        this.lastRunMs = now;
        const t0 = performance.now();
        const fp = this.opts.fakePoses?.();
        const img = fakeImage?.() ?? null;
        if (this.source === "skel" && fp && img) this.setFromSkeleton(fp.landmarks, img.width, img.height);
        else if (img) this.mask.setFromImageData(img);
        else this.mask.clear();
        this.maskMs = performance.now() - t0;
        this.updates.push(now);
        if (fp) this.opts.onPoses?.(fp.landmarks, fp.worldLandmarks, now);
        this.lastPoses = fp ? fp.landmarks.length : img ? (this.mask.hasPerson ? 1 : 0) : 0;
        this.lastMasks = img ? 1 : 0;
        this.lastInput = img ? `${img.width}x${img.height}` : "-";
        if (video && video.videoWidth > 0) {
          if (now - this.lumaAtMs >= LUMA_EVERY_MS) this.measureLuma(video, now);
          this.drawDebug(video, now, false);
        }
      } else if (this.status === "ready" && this.tracker && video) {
        this.lastRunMs = now;
        this.runPose(video, now);
      }
    }
    const on = !this.disabled && need && this.mask.updatedMs > -Infinity && now - this.mask.updatedMs < this.opts.staleOffMs;
    this.uniforms.uMaskOn.value = on ? 1 : 0;
    if (on && this.mask.hasPerson) this.everMasked = true;
  }

  private runPose(video: HTMLVideoElement, now: number) {
    const tracker = this.tracker!;
    const t0 = performance.now();
    let error: string | null = null;
    let ran = false;
    let poses = 0;
    let masksN = 0;
    let inputSource: HTMLVideoElement | HTMLCanvasElement | null = null;
    try {
      ran = tracker.detectWith(video, (landmarker, source, ts) => {
        inputSource = source;
        // 入力の明るさ（1 秒ごと）: Pose に渡すのと同じ画像を測る（video → canvas の drawImage が黒くなっていないか）
        if (now - this.lumaAtMs >= LUMA_EVERY_MS) this.measureLuma(source, now);
        // コールバック版: マスクはこの中でだけ有効（外へ持ち出さない。読み戻して自前の R8 にコピーする）。
        // 返り値の版はマスクを複製するので、コピーが 1 回多い
        (landmarker as PoseCallbackLandmarker).detectForVideo(source, ts, (result) => {
          try {
            poses = result.landmarks?.length ?? 0;
            this.opts.onPoses?.(result.landmarks ?? [], result.worldLandmarks ?? [], now);
            const masks = result.segmentationMasks ?? [];
            masksN = masks.length;
            const floats = masks.map((m) => m.getAsFloat32Array());
            const st = maskStats(floats);
            this.lastMaskStats = st;
            // 判定は 0..1 に直した最大で（0..255 で来たときに生の値で判定しない）
            const mmaxNorm = st.max * st.scale;
            const next = decideMaskSource({ source: this.source, run: this.sourceRun }, this.sourceMode, poses, mmaxNorm, this.opts.maskMinMax ?? 0.1);
            this.setSource(next.source, `poses=${poses} mmax=${mmaxNorm.toFixed(3)} min=${this.opts.maskMinMax ?? 0.1} after=${MASK_SOURCE_SWITCH_N}`);
            this.sourceRun = next.run;
            if (this.source === "skel" && poses > 0) {
              const w = masks[0]?.width ?? (source instanceof HTMLVideoElement ? source.videoWidth : source.width);
              const h = masks[0]?.height ?? (source instanceof HTMLVideoElement ? source.videoHeight : source.height);
              this.setFromSkeleton(result.landmarks ?? [], w, h);
            } else if (masks.length > 0) this.mask.setFromFloat(floats, masks[0].width, masks[0].height, st.scale);
            else this.mask.clear();
          } catch (e: unknown) {
            error = `mask: ${e instanceof Error ? e.message : String(e)}`;
          }
        });
      });
    } catch (e: unknown) {
      error = `detect: ${e instanceof Error ? e.message : String(e)}`;
    }
    if (error) {
      this.fail(error);
      return;
    }
    if (!ran) return;
    this.poseMs = tracker.lastMs;
    this.maskMs = performance.now() - t0;
    this.updates.push(now);
    this.lastPoses = poses;
    this.lastMasks = masksN;
    this.lastInput = tracker.lastInput;
    this.runs++;
    if (poses > 0) this.runsWithPerson++;
    const src = inputSource as HTMLVideoElement | HTMLCanvasElement | null;
    if (src) this.drawDebug(src, now, true);
    this.probeStep(video, now, poses);
  }

  /** 入力の平均の明るさ（0〜255）を小さな canvas に縮めて測る */
  private measureLuma(source: HTMLVideoElement | HTMLCanvasElement, now: number) {
    this.lumaAtMs = now;
    try {
      if (!this.lumaCanvas) {
        const canvas = document.createElement("canvas");
        canvas.width = 32;
        canvas.height = 18;
        this.lumaCanvas = { canvas, ctx: canvas.getContext("2d", { willReadFrequently: true })! };
      }
      const { ctx, canvas } = this.lumaCanvas;
      ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
      const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      this.lastLuma = sum / (d.length / 4);
    } catch {
      this.lastLuma = -1;
    }
  }

  /** ?maskDebug=1: 入力の縮小画像と、最新のマスク（白 = 人）を画面の隅に描く */
  private drawDebug(source: HTMLVideoElement | HTMLCanvasElement, now: number, real: boolean) {
    const dc = this.debugCanvases;
    if (!dc || now - this.debugDrawnMs < DEBUG_DRAW_EVERY_MS) return;
    this.debugDrawnMs = now;
    const ictx = dc.input.getContext("2d");
    if (ictx) {
      const sw = source instanceof HTMLVideoElement ? source.videoWidth : source.width;
      const sh = source instanceof HTMLVideoElement ? source.videoHeight : source.height;
      if (sw > 0 && sh > 0) {
        dc.input.height = Math.round((dc.input.width * sh) / sw);
        ictx.drawImage(source, 0, 0, dc.input.width, dc.input.height);
      }
      ictx.fillStyle = "rgba(0,0,0,0.6)";
      ictx.fillRect(0, 0, dc.input.width, 12);
      ictx.fillStyle = "#fff";
      ictx.font = "10px monospace";
      ictx.fillText(`${real ? "pose in" : "fake"} ${this.lastInput} lum=${this.lastLuma === null ? "-" : this.lastLuma.toFixed(0)}`, 2, 10);
    }
    const mctx = dc.mask.getContext("2d");
    if (mctx) {
      const [w, h] = this.mask.size;
      const px = this.mask.pixels;
      if (w > 0 && h > 0 && px.length === w * h) {
        if (dc.mask.width !== w || dc.mask.height !== h) {
          dc.mask.width = w;
          dc.mask.height = h;
        }
        const img = mctx.createImageData(w, h);
        for (let i = 0; i < px.length; i++) {
          const v = px[i];
          img.data[i * 4] = v;
          img.data[i * 4 + 1] = v;
          img.data[i * 4 + 2] = v;
          img.data[i * 4 + 3] = 255;
        }
        mctx.putImageData(img, 0, 0);
      } else {
        mctx.fillStyle = "#000";
        mctx.fillRect(0, 0, dc.mask.width, dc.mask.height);
      }
      const fs = Math.max(10, Math.round(dc.mask.height / 12));
      mctx.fillStyle = "rgba(0,0,0,0.6)";
      mctx.fillRect(0, 0, dc.mask.width, fs + 4);
      mctx.fillStyle = this.lastPoses ? "#7fff7f" : "#ff8080";
      mctx.font = `${fs}px monospace`;
      mctx.fillText(`mask poses=${this.lastPoses ?? "-"} masks=${this.lastMasks ?? "-"} ${this.delegate}`, 2, fs);
    }
  }

  /**
   * delegate = auto で GPU の人数が 0 のまま probeAfterMs 続いたら、CPU の PoseLandmarker を作って同じフレームで PROBE_RUNS 回比べる。
   * CPU だけ人が出たら CPU に切り替える（GPU を閉じる）。CPU でも 0 人なら GPU のまま（人が写っていないだけかもしれない）で、
   * PROBE_RETRY_MS 後にまた比べる（PROBE_MAX 回まで）。GPU で一度でも人が出たら比べない
   */
  private probeStep(video: HTMLVideoElement, now: number, gpuPoses: number) {
    if (this.opts.delegate !== "auto" || this.tracker?.delegate !== "GPU" || this.gpuProven) return;
    if (gpuPoses > 0 && this.probe !== "running") {
      this.gpuProven = true;
      this.zeroSinceMs = null;
      if (this.probe === "waiting" || this.probe === "kept-gpu") this.probe = "-";
      return;
    }
    if (this.probe === "running" && this.probeTracker) {
      let cpuPoses = 0;
      let cpuError: string | null = null;
      try {
        this.probeTracker.detectWith(video, (landmarker, source, ts) => {
          (landmarker as PoseCallbackLandmarker).detectForVideo(source, ts, (result) => {
            cpuPoses = result.landmarks?.length ?? 0;
          });
        });
      } catch (e: unknown) {
        cpuError = e instanceof Error ? e.message : String(e);
      }
      if (cpuError) {
        this.endProbe("failed", `cpu-error ${cpuError.slice(0, 80)}`);
        return;
      }
      this.probeRuns++;
      if (cpuPoses > 0) this.probeCpuFound++;
      if (gpuPoses > 0) this.probeGpuFound++;
      if (this.probeRuns < PROBE_RUNS) return;
      const counts = `cpu=${this.probeCpuFound}/${PROBE_RUNS} gpu=${this.probeGpuFound}/${PROBE_RUNS} cpuMs=${this.probeTracker.lastMs.toFixed(0)}`;
      if (this.probeCpuFound > 0 && this.probeGpuFound === 0) {
        const gpu = this.tracker!;
        this.tracker = this.probeTracker;
        this.probeTracker = null;
        try {
          gpu.close();
        } catch {
          // 閉じる失敗は無視
        }
        this.probe = "switched-cpu";
        this.detail = `CPU numPoses=${this.opts.maxPoses} (auto: GPU 0 people)`;
        this.opts.log("mask-delegate", `GPU→CPU reason=gpu-0-people ${counts}`);
      } else if (this.probeGpuFound > 0) {
        this.gpuProven = true;
        this.endProbe("-", `keep=GPU reason=gpu-found ${counts}`);
      } else {
        this.endProbe("kept-gpu", `keep=GPU reason=both-0(no person in view?) ${counts} retryIn=${PROBE_RETRY_MS / 1000}s`);
      }
      return;
    }
    if (this.probe === "loading" || this.probe === "switched-cpu" || this.probe === "failed") return;
    if (this.zeroSinceMs === null) this.zeroSinceMs = now;
    if (this.probe === "-") this.probe = "waiting";
    if (now - this.zeroSinceMs >= this.opts.probeAfterMs && now >= this.nextProbeAtMs && this.probeCount < PROBE_MAX) void this.startProbe(now);
  }

  private async startProbe(now: number) {
    this.probe = "loading";
    this.probeCount++;
    this.opts.log("mask-delegate-probe", `start #${this.probeCount} gpu-0-people for ${((now - (this.zeroSinceMs ?? now)) / 1000).toFixed(1)}s runs=${this.runs}`);
    try {
      const { createPoseTracker } = await import("../../src/shared/pose-tracker");
      const cpu = await createPoseTracker(
        {
          numPoses: this.opts.maxPoses,
          delegate: "CPU",
          modelUrls: this.opts.modelUrls,
          modelBuffer: this.tracker?.modelBuffer,
          minPoseDetectionConfidence: 0.5,
          minPosePresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
          inputMaxSide: this.opts.detW,
          inputMaxSideCpu: this.opts.detW,
          outputSegmentationMasks: true,
        },
        () => {},
      );
      if (this.probe !== "loading" || !this.tracker) {
        cpu.close();
        return;
      }
      this.probeTracker = cpu as unknown as PoseTrackerLike;
      this.probeRuns = 0;
      this.probeCpuFound = 0;
      this.probeGpuFound = 0;
      this.probe = "running";
    } catch (e: unknown) {
      this.endProbe("failed", `cpu-load ${e instanceof Error ? e.message.slice(0, 80) : String(e)}`);
    }
  }

  private endProbe(state: OcclusionController["probe"], detail: string) {
    const t = this.probeTracker;
    this.probeTracker = null;
    try {
      t?.close();
    } catch {
      // 閉じる失敗は無視
    }
    this.probe = state;
    this.zeroSinceMs = null;
    this.nextProbeAtMs = performance.now() + PROBE_RETRY_MS;
    this.opts.log("mask-delegate-probe", detail);
  }

  private async load(numPoses: number) {
    this.status = "loading";
    this.detail = `numPoses=${numPoses}`;
    const t0 = performance.now();
    try {
      // 使うときだけ読み込む（?occlude=0 や相手がいない間は MediaPipe を読み込まない）
      const { createPoseTracker } = await import("../../src/shared/pose-tracker");
      const tracker = await createPoseTracker(
        {
          numPoses,
          delegate: this.opts.delegate,
          modelUrls: this.opts.modelUrls,
          minPoseDetectionConfidence: 0.5,
          minPosePresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
          inputMaxSide: this.opts.detW,
          inputMaxSideCpu: this.opts.detW,
          outputSegmentationMasks: true,
        },
        (step) => {
          this.detail = `loading ${step}`;
        },
      );
      this.tracker = tracker as unknown as PoseTrackerLike;
      this.status = "ready";
      this.detail = `${tracker.delegate} numPoses=${numPoses}`;
      this.opts.log("mask-ready", `${tracker.delegate} numPoses=${numPoses} detW=${this.opts.detW} load=${(performance.now() - t0).toFixed(0)}ms model=${tracker.modelUrl.startsWith("http") ? "remote" : "local"}`);
    } catch (e: unknown) {
      this.fail(`load: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private fail(reason: string) {
    this.status = "failed";
    this.detail = reason.slice(0, 160);
    this.mask.clear();
    this.uniforms.uMaskOn.value = 0;
    const tracker = this.tracker;
    this.tracker = null;
    for (const t of [tracker, this.probeTracker]) {
      try {
        t?.close();
      } catch {
        // close の失敗は無視（描画ループへ上げない）
      }
    }
    this.probeTracker = null;
    // 隠さずに描き続ける（化身の表示は止めない）
    this.opts.log("mask-failed", this.detail);
  }

  /** マスクの中身（mmax / mmean / mfrac。NaN があれば mnan、0..255 で来ていれば x255） */
  private describeMaskStats(): string {
    const st = this.lastMaskStats;
    if (!st) return "mmax=- mmean=- mfrac=-";
    return `mmax=${st.max.toFixed(3)} mmean=${st.mean.toFixed(3)} mfrac=${st.frac.toFixed(3)}${st.nan > 0 ? ` mnan=${st.nan.toFixed(2)}` : ""}${st.scale !== 1 ? " x255" : ""}`;
  }

  /**
   * HUD / ログの 1 行。人の形が出ない原因を実機のログ 1 行で切り分けられるように、1 回の結果の人数（poses = landmarks.length）・
   * マスクの枚数（masks = segmentationMasks.length）・入力の大きさ（in=）・入力の平均の明るさ（lum=、0 に近ければ真っ黒）・
   * delegate（dg=）・読み込んでから人が出た回数（found=人が出た回数/回した回数）・検出の回数の段（maskHz=今/上限）を入れる
   */
  describe(): string {
    if (this.status === "off") return "occlude=off";
    const age = Number.isFinite(this.ageMs) ? `${this.ageMs.toFixed(0)}ms` : "-";
    const lum = this.lastLuma === null ? "-" : this.lastLuma.toFixed(0);
    return (
      `occlude=${this.opts.fake ? "fake" : this.status}${this.detail ? `(${this.detail})` : ""} run=${this.running ? 1 : 0} on=${this.uniforms.uMaskOn.value} ` +
      `pose=${this.poseMs.toFixed(0)}ms mask=${this.maskMs.toFixed(0)}ms hz=${this.hz} maskHz=${this.governor.hz}/${this.governor.cap} age=${age} person=${this.mask.hasPerson ? 1 : 0} ` +
      `poses=${this.lastPoses ?? "-"} masks=${this.lastMasks ?? "-"} ${this.describeMaskStats()} msrc=${this.source} in=${this.lastInput || "-"} lum=${lum} dg=${this.delegate} found=${this.runsWithPerson}/${this.runs}` +
      (this.probe !== "-" ? ` probe=${this.probe}` : "")
    );
  }
}
