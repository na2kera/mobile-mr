// 段階 3 の C: 本人の背中から化身の腰（溶けた下端）へ立ち上る光の流れ（アニメの化身の「背中からビヨーンと出る」見え方）。
//   - 帯: 3 次ベジェ曲線（背中の点 P0 → 制御点 P1・P2 → 化身の腰 P3）に沿った管。形（t, 角度）は一度だけ作り、曲線と太さは uniform で
//     頂点シェーダーが決める（毎フレーム頂点を書き換えない）。加算合成で、曲線に沿って上へ流れるノイズの明るさ
//   - 粒: 同じ曲線に沿って上へ流れる光の粒（頂点シェーダーが時刻から位置を出す）
//   - 伸び（uGrow）: 出現の最初に背中から腰へ伸び、その先で化身がせり上がる。消えるときは逆
//   - 人の形で隠す（段階 2 の keshinMasked）: 持ち主の頭より奥で、カメラに写った人の画素は描かない
// 座標は KeshinView の group の親の座標（group は単位行列）
import * as THREE from "three";
import { MASK_HEAD_GLSL } from "./keshin-occlusion";
import type { MaskBinding } from "./keshin-occlusion";

export type StreamUniforms = {
  uP0: { value: THREE.Vector3 };
  uP1: { value: THREE.Vector3 };
  uP2: { value: THREE.Vector3 };
  uP3: { value: THREE.Vector3 };
  /** 管の断面の横向き（本人の後ろ向きと上の外積。曲線は後ろ向きと上の面の中にあるので、どこでも曲線に直交する。ねじれない） */
  uN: { value: THREE.Vector3 };
  /** 背中側・腰側の太さ（半径 [m]） */
  uR0: { value: number };
  uR1: { value: number };
  /** 伸び 0..1（曲線のどこまで描くか） */
  uGrow: { value: number };
  /** 明るさ 0..1 */
  uK: { value: number };
  /**
   * 人の形の縁から、この幅（人の形のマスクの横幅に対する割合）までの流れを薄くする（帯も粒も。人の形で隠すときだけ）。
   * 流れは本人の頭・首の真後ろを上るので、人の形で隠すと、頭より太い管がはみ出た縁だけが頭のまわりの明るい輪（縁取り）として残った。
   * 曲線のパラメータ t や高さで根元を消しても、鏡の正面からは腰の近くまで頭の後ろに重なっていて輪が消えなかったため、画面の上で
   * 人の形に近い所を消す（横や上から見たときの流れはそのまま残る）
   */
  uMaskNear: { value: number };
  uTime: { value: number };
  uColA: { value: THREE.Color };
  uColB: { value: THREE.Color };
  uViewportH: { value: number };
};

const CURVE_GLSL = /* glsl */ `
uniform vec3 uP0, uP1, uP2, uP3, uN;
uniform float uR0, uR1, uTime;
vec3 kBez(float t) {
  float s = 1.0 - t;
  return s * s * s * uP0 + 3.0 * s * s * t * uP1 + 3.0 * s * t * t * uP2 + t * t * t * uP3;
}
vec3 kBezD(float t) {
  float s = 1.0 - t;
  return 3.0 * s * s * (uP1 - uP0) + 6.0 * s * t * (uP2 - uP1) + 3.0 * t * t * (uP3 - uP2);
}
void kFrame(float t, out vec3 T, out vec3 N, out vec3 B) {
  // 横向き N は uniform で固定（上向きの基準を途中で切り替えると、腰の近くで管が 90° ねじれていた）
  T = normalize(kBezD(t) + vec3(0.0, 1e-5, 0.0));
  N = uN;
  B = normalize(cross(T, N));
}
float kRadius(float t) {
  // 背中は細く、腰へ向かって太く（t^1.6）。ゆっくり脈打つ
  return mix(uR0, uR1, pow(t, 1.6)) * (0.88 + 0.12 * sin(t * 11.0 - uTime * 2.6));
}
float kHash(float n) { return fract(sin(n) * 43758.5453123); }
float kNoise(float x) {
  float i = floor(x);
  float f = fract(x);
  float u = f * f * (3.0 - 2.0 * f);
  return mix(kHash(i), kHash(i + 1.0), u);
}
`;

/**
 * 人の形の縁に近いほど 1（MASK_HEAD_GLSL の後に置く）。持ち主の頭より奥の点だけ、マスクを半径 uMaskNear（横幅に対する割合）と
 * その半分の 8 方向で読み、人の画素があれば近い。keshinMasked と同じく、手前の部分には効かない
 */
const NEAR_PERSON_GLSL = /* glsl */ `
uniform float uMaskNear;
float streamNearPerson(vec3 worldPos) {
  if (uMaskOn < 0.5 || uMaskNear <= 0.0) return 0.0;
  if (distance(worldPos, cameraPosition) <= distance(uOwnerHead, cameraPosition) - uMaskDepthMargin) return 0.0;
  vec2 vp = (gl_FragCoord.xy - uEyeVp.xy) / uEyeVp.zw;
  vec2 t = (uMaskUv * vec3(vp, 1.0)).xy;
  vec2 muv = vec2(t.x, 1.0 - t.y);
  vec2 r = vec2(uMaskNear, uMaskNear * uMaskTexel.y / uMaskTexel.x);
  float far = 0.0;
  float half_ = 0.0;
  for (int i = 0; i < 8; i++) {
    float a = float(i) * 0.7853982;
    vec2 d = vec2(cos(a), sin(a)) * r;
    far = max(far, texture2D(uMaskTex, muv + d).r);
    half_ = max(half_, texture2D(uMaskTex, muv + d * 0.5).r);
  }
  // 半分の距離に人がいれば消し、縁の距離だけならなかば（境目をぼかす）
  return max(half_, far * 0.6);
}
`;

/** 帯（管）の形: position = (t, 角度, 0)。t 方向 segT、周方向 segA */
function tubeParamGeometry(segT: number, segA: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= segT; i++) {
    for (let j = 0; j <= segA; j++) pos.push(i / segT, (j / segA) * Math.PI * 2, 0);
  }
  const row = segA + 1;
  for (let i = 0; i < segT; i++) {
    for (let j = 0; j < segA; j++) {
      const a = i * row + j;
      idx.push(a, a + row, a + 1, a + 1, a + row, a + row + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
  return g;
}

function seedGeometry(n: number): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  const seeds = new Float32Array(n * 4);
  let s = 424242;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  for (let i = 0; i < n * 4; i++) seeds[i] = rnd();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  g.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 4));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
  return g;
}

export class BackStream {
  readonly group = new THREE.Group();
  readonly uniforms: StreamUniforms;
  private readonly tube: THREE.Mesh;
  private readonly sparks: THREE.Points;

  constructor(colors: [number, number], particles: number, mask: MaskBinding | null) {
    this.uniforms = {
      uP0: { value: new THREE.Vector3() },
      uP1: { value: new THREE.Vector3() },
      uP2: { value: new THREE.Vector3() },
      uP3: { value: new THREE.Vector3() },
      uN: { value: new THREE.Vector3(1, 0, 0) },
      uR0: { value: 0.06 },
      uR1: { value: 0.3 },
      uGrow: { value: 0 },
      uK: { value: 0 },
      uMaskNear: { value: 0 },
      uTime: { value: 0 },
      uColA: { value: new THREE.Color(colors[0]) },
      uColB: { value: new THREE.Color(colors[1]) },
      uViewportH: { value: 800 },
    };
    const uniforms = mask ? { ...this.uniforms, ...mask.shared, ...mask.owner } : this.uniforms;
    const maskHead = mask ? MASK_HEAD_GLSL + NEAR_PERSON_GLSL : "float streamNearPerson(vec3 worldPos) { return 0.0; }\n";
    const maskTest = mask ? "if (keshinMasked(vWorld)) discard;" : "";
    const tubeMat = new THREE.ShaderMaterial({
      uniforms,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        ${CURVE_GLSL}
        varying float vT;
        varying float vA;
        varying vec3 vWorld;
        varying vec3 vNormalW;
        void main() {
          float t = position.x;
          float a = position.y;
          vec3 T; vec3 N; vec3 B;
          kFrame(t, T, N, B);
          vec3 nrm = cos(a) * N + sin(a) * B;
          vec3 p = kBez(t) + kRadius(t) * nrm;
          vec4 world = modelMatrix * vec4(p, 1.0);
          vWorld = world.xyz;
          vNormalW = normalize(mat3(modelMatrix) * nrm);
          vT = t;
          vA = a;
          gl_Position = projectionMatrix * viewMatrix * world;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uGrow, uK, uTime;
        uniform vec3 uColA, uColB;
        varying float vT;
        varying float vA;
        varying vec3 vWorld;
        varying vec3 vNormalW;
        float kHash(float n) { return fract(sin(n) * 43758.5453123); }
        float kNoise(float x) {
          float i = floor(x);
          float f = fract(x);
          float u = f * f * (3.0 - 2.0 * f);
          return mix(kHash(i), kHash(i + 1.0), u);
        }
        ${maskHead}
        void main() {
          if (vT > uGrow) discard;
          ${maskTest}
          // 曲線に沿って上へ流れる明るさ（筋 + ゆっくりしたノイズ）
          float streak = kNoise(vT * 9.0 - uTime * 2.2 + floor(vA * 1.9099) * 17.0);
          float wave = 0.5 + 0.5 * sin(vT * 26.0 - uTime * 5.5 + vA * 2.0);
          float flow = 0.35 + 0.45 * streak + 0.2 * wave;
          // 縁ほど明るい（光の管に見える）
          vec3 v = normalize(cameraPosition - vWorld);
          float rim = 1.0 - abs(dot(v, normalize(vNormalW)));
          // 人の形の縁のまわりは見せない（頭のまわりに輪として残らないように）
          float clear = 1.0 - streamNearPerson(vWorld);
          if (clear <= 0.0) discard;
          float ends = clear * smoothstep(0.0, 0.1, vT) * (1.0 - smoothstep(0.8, 1.0, vT));
          float tip = 1.0 - smoothstep(uGrow - 0.06, uGrow, vT);
          float a = uK * ends * tip * (0.3 + 0.7 * flow) * (0.45 + 0.55 * rim * rim);
          gl_FragColor = vec4(mix(uColA, uColB, vT * 0.8 + 0.2 * streak) * 1.35, min(1.0, a));
        }
      `,
    });
    this.tube = new THREE.Mesh(tubeParamGeometry(48, 14), tubeMat);
    this.tube.frustumCulled = false;
    // 化身（半透明）の後に描く
    this.tube.renderOrder = 2;
    const sparkMat = new THREE.ShaderMaterial({
      uniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        ${CURVE_GLSL}
        attribute vec4 aSeed;
        uniform float uGrow, uK, uViewportH;
        uniform vec3 uColA, uColB;
        varying float vAlpha;
        varying vec3 vColor;
        varying vec3 vWorld;
        void main() {
          // 曲線に沿って背中から腰へ流れる（上へ）
          float t = fract(aSeed.x + uTime * (0.3 + 0.35 * aSeed.y));
          vec3 T; vec3 N; vec3 B;
          kFrame(t, T, N, B);
          float ang = aSeed.z * 6.2832 + uTime * (1.2 + aSeed.w * 1.5);
          float r = kRadius(t) * (0.25 + 0.95 * aSeed.w);
          vec3 p = kBez(t) + r * (cos(ang) * N + sin(ang) * B);
          vec4 world = modelMatrix * vec4(p, 1.0);
          vWorld = world.xyz;
          float alive = step(t, uGrow);
          vAlpha = uK * alive * sin(3.1416 * t) * (0.55 + 0.45 * kNoise(uTime * 3.0 + aSeed.y * 40.0));
          vColor = mix(uColA, uColB, t);
          vec4 mv = viewMatrix * world;
          gl_Position = projectionMatrix * mv;
          gl_PointSize = clamp(0.07 * (0.6 + aSeed.y) * projectionMatrix[1][1] * uViewportH * 0.5 / max(0.05, -mv.z), 0.0, 40.0);
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vAlpha;
        varying vec3 vColor;
        varying vec3 vWorld;
        ${maskHead}
        void main() {
          ${maskTest}
          vec2 c = gl_PointCoord - 0.5;
          float d = length(c) * 2.0;
          if (d > 1.0) discard;
          // 帯と同じく、人の形の縁のまわりは見せない
          float clear = 1.0 - streamNearPerson(vWorld);
          if (clear <= 0.0) discard;
          gl_FragColor = vec4(vColor, pow(1.0 - d, 1.8) * vAlpha * clear);
        }
      `,
    });
    this.sparks = new THREE.Points(seedGeometry(particles), sparkMat);
    this.sparks.frustumCulled = false;
    this.sparks.renderOrder = 2;
    this.group.add(this.tube, this.sparks);
    this.group.visible = false;
  }

  /**
   * 曲線を決める（親の座標）: back = 背中の点（頭の 0.35m 下・少し後ろ）、waist = 化身の腰（切断面の中心）、
   * backDir = 本人の後ろ向き（水平の単位ベクトル）。背中から後ろへ出て、下から腰に入る形
   */
  setCurve(back: THREE.Vector3, waist: THREE.Vector3, backDir: THREE.Vector3) {
    const u = this.uniforms;
    const d = back.distanceTo(waist);
    u.uP0.value.copy(back);
    u.uP1.value.copy(back).addScaledVector(backDir, 0.4 * d).add(new THREE.Vector3(0, 0.05 * d, 0));
    u.uP2.value.copy(waist).add(new THREE.Vector3(0, -0.45 * d, 0));
    u.uP3.value.copy(waist);
    u.uN.value.set(-backDir.z, 0, backDir.x).normalize();
  }

  dispose() {
    this.tube.geometry.dispose();
    (this.tube.material as THREE.Material).dispose();
    this.sparks.geometry.dispose();
    (this.sparks.material as THREE.Material).dispose();
  }
}
