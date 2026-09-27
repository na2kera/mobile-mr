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
  setFromFloat(masks: readonly Float32Array[], w: number, h: number) {
    this.ensure(w, h);
    const out = this.data;
    out.fill(0);
    let any = false;
    const [lo, hi] = this.edge;
    const span = hi > lo ? hi - lo : 1e-6;
    for (const m of masks) {
      const n = Math.min(m.length, out.length);
      for (let i = 0; i < n; i++) {
        let t = (m[i] - lo) / span;
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
export type PersonShape = { head: { x: number; y: number; r: number }; torso: [number, number][]; limbs: { a: [number, number]; b: [number, number]; w: number }[] };

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
  return { head, torso, limbs };
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

// ---- 人の形の検出を回す（PoseLandmarker の segmentation mask / フェイク）----

export type OcclusionOptions = {
  /** ?occlude=0 で false（隠す処理を丸ごと止める。Pose も読み込まない） */
  enabled: boolean;
  /** ?fakeperson=1: MediaPipe の代わりにフェイクの人の形を使う（PC 確認用） */
  fake: boolean;
  /** 検出の回数の上限 [回/s]（?maskHz=） */
  maskHz: number;
  /** 同時に検出する人数の上限（?maskPoses=） */
  maxPoses: number;
  /** 推論に渡す画像の長辺 [px]（?maskDetW=。マスクの大きさもこれになる） */
  detW: number;
  delegate: "GPU" | "CPU" | "auto";
  modelUrls: string[];
  /** マスクがこれより古くなったら隠すのをやめる [ms] */
  staleOffMs: number;
  log: (kind: string, detail: string) => void;
};

/** 使う PoseLandmarker の部分（コールバック版の detectForVideo。結果のマスクはコールバックの中でだけ有効） */
type PoseCallbackLandmarker = {
  detectForVideo(
    source: HTMLVideoElement | HTMLCanvasElement,
    timestampMs: number,
    callback: (result: { segmentationMasks?: { width: number; height: number; getAsFloat32Array(): Float32Array }[] }) => void,
  ): void;
};

type PoseTrackerLike = {
  delegate: string;
  modelUrl: string;
  modelBuffer: ArrayBuffer;
  lastMs: number;
  detectWith(video: HTMLVideoElement, run: (landmarker: unknown, source: HTMLVideoElement | HTMLCanvasElement, timestampMs: number) => void): boolean;
  close(): void;
};

/**
 * 人の形のマスクを ?maskHz= 以下で更新する。
 *   - 読み込み（モデル・wasm・GPU の初期化）は、隠す処理が有効で相手が 1 人でも入室したら先に済ませる（初めて視野に入った瞬間に
 *     重い初期化が走らないように）。人数は最初から ?maskPoses= で作り、使っている最中に作り直さない（GL コンテキストが 2 組になる山を避ける）
 *   - 回すのは、相手の化身（モデルかオーラ）が視野に入っていそうな間だけ。マーカー検出と同じフレームでは回さない
 *   - Pose の読み込み・推論に失敗したら隠さずに描く（化身は止めない）
 */
export class OcclusionController {
  readonly uniforms: MaskUniforms;
  readonly mask: PersonMask;
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

  constructor(opts: OcclusionOptions, dilatePx: number, depthMarginM: number, edge: [number, number]) {
    this.opts = opts;
    this.uniforms = createMaskUniforms(dilatePx, depthMarginM);
    this.mask = new PersonMask(this.uniforms, edge);
    if (!opts.enabled) this.status = "off";
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

  /**
   * 毎フレーム呼ぶ。need = 相手の化身（モデルかオーラ）が視野に入っていそう、markerRan = このフレームでマーカー検出をした、
   * others = 相手の人数（1 人でもいれば読み込みだけ先に済ませる）、fakeImage = フェイクの人の形（?fakeperson=1 のとき）
   */
  update(now: number, need: boolean, video: HTMLVideoElement | null, markerRan: boolean, others: number, fakeImage: (() => ImageData | null) | null) {
    if (!this.opts.enabled) {
      this.uniforms.uMaskOn.value = 0;
      return;
    }
    if (!this.opts.fake && this.status === "idle" && others > 0) void this.load(this.opts.maxPoses);
    if (need !== this.running) {
      this.running = need;
      this.opts.log(need ? "mask-start" : "mask-stop", `${this.opts.fake ? "fake" : "pose"} status=${this.status}`);
      if (!need) this.mask.clear();
    }
    const dueMs = 1000 / this.opts.maskHz;
    if (need && !markerRan && now - this.lastRunMs >= dueMs) {
      if (this.opts.fake) {
        this.lastRunMs = now;
        const t0 = performance.now();
        const img = fakeImage?.() ?? null;
        if (img) this.mask.setFromImageData(img);
        else this.mask.clear();
        this.maskMs = performance.now() - t0;
        this.updates.push(now);
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
    try {
      ran = tracker.detectWith(video, (landmarker, source, ts) => {
        // コールバック版: マスクはこの中でだけ有効（外へ持ち出さない。読み戻して自前の R8 にコピーする）。
        // 返り値の版はマスクを複製するので、コピーが 1 回多い
        (landmarker as PoseCallbackLandmarker).detectForVideo(source, ts, (result) => {
          try {
            const masks = result.segmentationMasks ?? [];
            if (masks.length > 0) this.mask.setFromFloat(masks.map((m) => m.getAsFloat32Array()), masks[0].width, masks[0].height);
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
      this.opts.log("mask-ready", `${tracker.delegate} numPoses=${numPoses} load=${(performance.now() - t0).toFixed(0)}ms model=${tracker.modelUrl.startsWith("http") ? "remote" : "local"}`);
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
    try {
      tracker?.close();
    } catch {
      // close の失敗は無視（描画ループへ上げない）
    }
    // 隠さずに描き続ける（化身の表示は止めない）
    this.opts.log("mask-failed", this.detail);
  }

  /** HUD / ログの 1 行 */
  describe(): string {
    if (this.status === "off") return "occlude=off";
    const age = Number.isFinite(this.ageMs) ? `${this.ageMs.toFixed(0)}ms` : "-";
    return `occlude=${this.opts.fake ? "fake" : this.status}${this.detail ? `(${this.detail})` : ""} run=${this.running ? 1 : 0} on=${this.uniforms.uMaskOn.value} pose=${this.poseMs.toFixed(0)}ms mask=${this.maskMs.toFixed(0)}ms hz=${this.hz} age=${age} person=${this.mask.hasPerson ? 1 : 0}`;
  }
}
