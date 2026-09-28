// 化身のオーラ（加算合成の粒子 + ゆっくり動くノイズの揺らぎ）。粒子の位置はすべて頂点シェーダーで時刻から計算する
// （CPU は uniform を書くだけ。粒子数 ?auraN= を増やしても JS の負荷は増えない）。
//   - WorldAura: 本人の足元から腰の高さへ立ち上る柱 + 化身の腰（切断面）の渦。ワールドに置くので左右 2 眼で自然に立体に見える
//   - PeripheralAura: 主観で視界の周り（周辺）にうっすら出すオーラ。カメラの子にして 0.6〜1.2m 先の実際の 3D 位置に置く
//     （画面空間のポストエフェクトは StereoEffect と相性が悪いので使わない）。視線から 25° 以内は空け、外側ほど濃く、
//     小さな火の粉が下から上へ立ち上って消える。外周には大きく柔らかい低アルファのもやを少し置く
import * as THREE from "three";
import { MASK_HEAD_GLSL } from "./keshin-occlusion";
import type { MaskBinding } from "./keshin-occlusion";

/** 共通の GLSL: ハッシュと滑らかなノイズ（1 次元） */
const NOISE_GLSL = /* glsl */ `
float kHash(float n) { return fract(sin(n) * 43758.5453123); }
float kNoise(float x) {
  float i = floor(x);
  float f = fract(x);
  float u = f * f * (3.0 - 2.0 * f);
  return mix(kHash(i), kHash(i + 1.0), u);
}
`;

/** 粒子ごとの乱数（4 成分）を属性に入れた Points の形 */
function seededGeometry(n: number, kinds: (i: number) => number): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  const seeds = new Float32Array(n * 4);
  const kind = new Float32Array(n);
  // 決まった乱数列（毎回同じ見た目。ヘッドレスの比較が安定する）
  let s = 12345;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 4; k++) seeds[i * 4 + k] = rnd();
    kind[i] = kinds(i);
  }
  // position は使わない（three が要求するので 0 で置く）。境界球は大きく取ってカリングされないようにする
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  g.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 4));
  g.setAttribute("aKind", new THREE.BufferAttribute(kind, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
  return g;
}

/** 粒のフラグメント。mask を渡すと、カメラに写った人の画素では描かない（相手の化身の足元・腰のオーラ。段階 2） */
const spriteFragment = (mask: boolean) => /* glsl */ `
varying float vAlpha;
varying vec3 vColor;
${mask ? `varying vec3 vMaskWorld;\n${MASK_HEAD_GLSL}` : ""}
void main() {
  ${mask ? "if (keshinMasked(vMaskWorld)) discard;" : ""}
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c) * 2.0;
  if (d > 1.0) discard;
  // 芯が明るく縁が柔らかい光の粒
  float a = pow(1.0 - d, 1.8) * vAlpha;
  gl_FragColor = vec4(vColor, a);
}
`;

export type WorldAuraUniforms = {
  uTime: { value: number };
  uAuraK: { value: number };
  uPillarK: { value: number };
  uBurstK: { value: number };
  uColA: { value: THREE.Color };
  uColB: { value: THREE.Color };
  uColumnR: { value: number };
  uColumnH: { value: number };
  uSwirlC: { value: THREE.Vector3 };
  uSwirlR: { value: number };
  /** 渦の強さ（主観では渦が自分の頭のまわりに来て視界の中心を埋めるので 0） */
  uSwirlK: { value: number };
  /** 柱の粒を出す高さの上限（床から [m]。主観は肩の高さで止めて、正面を見たとき視界の中心に粒が来ないように） */
  uColumnMaxH: { value: number };
  /** 柱の強さの倍率（段階 3 の C: 他人用は背中からの光の流れに置き換えるので控えめ） */
  uColumnK: { value: number };
  uSize: { value: number };
  uViewportH: { value: number };
  uEye: { value: THREE.Vector3 };
  uNear: { value: THREE.Vector2 };
};

/**
 * 足元の柱と腰の渦。Points の座標系は「本人の足元（推定の床）・体の向き」の枠（keshin-view.ts が行列を入れる）。
 * 柱: 本人の足元を中心に半径 uColumnR、床から uColumnH（化身の腰の高さ）まで螺旋を描いて立ち上る（uPillarK で伸び、uBurstK で勢い）。
 * 渦: 化身の腰の切断面の中心 uSwirlC のまわりを回り、少しずつ上へ立ち上る
 */
export class WorldAura {
  readonly points: THREE.Points;
  readonly uniforms: WorldAuraUniforms;
  constructor(n: number, colors: [number, number], mask: MaskBinding | null = null) {
    // 6 割を柱、4 割を渦
    const geometry = seededGeometry(n, (i) => (i % 5 < 3 ? 0 : 1));
    this.uniforms = {
      uTime: { value: 0 },
      uAuraK: { value: 0 },
      uPillarK: { value: 0 },
      uBurstK: { value: 0 },
      uColA: { value: new THREE.Color(colors[0]) },
      uColB: { value: new THREE.Color(colors[1]) },
      uColumnR: { value: 0.45 },
      uColumnH: { value: 1.5 },
      uSwirlC: { value: new THREE.Vector3() },
      uSwirlR: { value: 0.5 },
      uSwirlK: { value: 1 },
      uColumnMaxH: { value: 1e4 },
      uColumnK: { value: 1 },
      uSize: { value: 0.07 },
      uViewportH: { value: 800 },
      uEye: { value: new THREE.Vector3(0, -1000, 0) },
      uNear: { value: new THREE.Vector2(0, 0) },
    };
    const material = new THREE.ShaderMaterial({
      uniforms: mask ? { ...this.uniforms, ...mask.shared, ...mask.owner } : this.uniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        attribute vec4 aSeed;
        attribute float aKind;
        uniform float uTime, uAuraK, uPillarK, uBurstK, uColumnR, uColumnH, uSwirlR, uSwirlK, uColumnMaxH, uColumnK, uSize, uViewportH;
        uniform vec3 uSwirlC, uColA, uColB, uEye;
        uniform vec2 uNear;
        varying float vAlpha;
        varying vec3 vMaskWorld;
        varying vec3 vColor;
        ${NOISE_GLSL}
        void main() {
          vec3 p;
          float alpha;
          float mixK;
          float id = aSeed.x * 97.0 + aSeed.y * 13.0;
          if (aKind < 0.5) {
            // 柱: 寿命の中で床から上へ。勢い（burst）で速く・高く
            float speed = (0.28 + 0.3 * aSeed.y) * (1.0 + 2.2 * uBurstK);
            float life = fract(aSeed.x + uTime * speed);
            float h = life * uColumnH * (1.0 + 0.35 * uBurstK);
            float ang = aSeed.z * 6.2832 + uTime * (0.7 + 0.8 * aSeed.w) + life * 2.5;
            float wob = kNoise(uTime * 0.8 + id) - 0.5;
            float r = uColumnR * (0.55 + 0.6 * aSeed.w) * (1.0 - 0.35 * life) + wob * 0.12;
            p = vec3(cos(ang) * r, h, sin(ang) * r);
            // 柱がまだ伸びきっていない高さの粒は出さない
            float reach = step(h, uPillarK * uColumnH * (1.0 + 0.35 * uBurstK) + 0.001);
            alpha = sin(3.1416 * life) * reach * (1.0 - smoothstep(uColumnMaxH - 0.2, uColumnMaxH, h)) * uColumnK;
            mixK = life;
          } else {
            // 腰の渦: 切断面のまわりを回りながら少しずつ立ち上り、上で消える
            float spin = (1.1 + 0.9 * aSeed.y) * (1.0 + uBurstK);
            float ang = aSeed.x * 6.2832 + uTime * spin;
            float rise = fract(aSeed.w + uTime * (0.25 + 0.25 * aSeed.z));
            float r = uSwirlR * (0.45 + 0.75 * aSeed.z) * (1.0 - 0.25 * rise) + (kNoise(uTime + id) - 0.5) * 0.1;
            p = uSwirlC + vec3(cos(ang) * r, rise * 0.45 * (0.5 + aSeed.y) + sin(ang * 3.0 + uTime) * 0.03, sin(ang) * r);
            alpha = (1.0 - rise) * smoothstep(0.0, 0.15, rise) * uPillarK * uSwirlK;
            mixK = 0.6 + 0.4 * rise;
          }
          // ゆっくりした揺らめき（明るさのノイズ）
          float flick = 0.55 + 0.45 * kNoise(uTime * 2.3 + id * 3.1);
          vec4 world = modelMatrix * vec4(p, 1.0);
          vMaskWorld = world.xyz;
          // 目のすぐ近くの粒は消す（主観で視界を塞がない。他人用は uNear = 0）
          float nearK = uNear.y > 0.0 ? smoothstep(uNear.x, uNear.y, distance(world.xyz, uEye)) : 1.0;
          vAlpha = alpha * flick * uAuraK * (1.0 + 0.8 * uBurstK) * nearK;
          vColor = mix(uColA, uColB, mixK);
          vec4 mv = viewMatrix * world;
          gl_Position = projectionMatrix * mv;
          float size = uSize * (0.5 + aSeed.y);
          gl_PointSize = clamp(size * projectionMatrix[1][1] * uViewportH * 0.5 / max(0.05, -mv.z), 0.0, 48.0);
        }
      `,
      fragmentShader: spriteFragment(mask !== null),
    });
    this.points = new THREE.Points(geometry, material);
    this.points.frustumCulled = false;
    this.points.matrixAutoUpdate = false;
  }
  dispose() {
    this.points.geometry.dispose();
    (this.points.material as THREE.Material).dispose();
  }
}

export type PeripheralAuraUniforms = {
  uTime: { value: number };
  uK: { value: number };
  uColA: { value: THREE.Color };
  uColB: { value: THREE.Color };
  /** 空ける中心の半角の tan（25°） */
  uInnerTan: { value: number };
  /** 片目の視野の半角の tan（横・縦）。粒は視野の縁（楕円）まで、もやは縁の外側寄りに置く */
  uTanX: { value: number };
  uTanY: { value: number };
  uSize: { value: number };
  uHazeSize: { value: number };
  uViewportH: { value: number };
};

/** 視線から何度以内を空けるか [deg]（レビュー: 各眼の視野の中心から約 25° 以内はほぼ空） */
export const PERIPHERAL_INNER_DEG = 25;
/** 外周のもやの数（粒の数の 5%、最低 8） */
const hazeCount = (n: number) => Math.max(8, Math.round(n * 0.05));

/**
 * 主観の視界の周りのオーラ（カメラの子）。位置は「視線からの角度 θ と向き φ」で決める（片目の視野の形に依らず、
 * 視線から PERIPHERAL_INNER_DEG° 以内には入れない）。
 *   火の粉（kind 0）: θ は外側ほど多く（√ で偏らせる）、奥行き 0.6〜1.2m。寿命の間に上へ流れて消える（下から上へ立ち上る炎）。
 *     上へ流れて内側に入りそうなら輪の外へ押し戻す。下側（体から立ち上る側）を少し濃く。小さく、明るさは控えめ
 *   もや（kind 1）: θ 44〜58° の外周に大きく柔らかい低アルファのスプライト。ゆっくり漂い、明るさがゆっくり息づく
 */
export class PeripheralAura {
  readonly points: THREE.Points;
  readonly uniforms: PeripheralAuraUniforms;
  constructor(n: number, colors: [number, number]) {
    const haze = hazeCount(n);
    const geometry = seededGeometry(n + haze, (i) => (i < n ? 0 : 1));
    this.uniforms = {
      uTime: { value: 0 },
      uK: { value: 0 },
      uColA: { value: new THREE.Color(colors[0]) },
      uColB: { value: new THREE.Color(colors[1]) },
      uInnerTan: { value: Math.tan(THREE.MathUtils.degToRad(PERIPHERAL_INNER_DEG)) },
      uTanX: { value: 0.7 },
      uTanY: { value: 0.7 },
      uSize: { value: 0.016 },
      uHazeSize: { value: 0.5 },
      uViewportH: { value: 800 },
    };
    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        attribute vec4 aSeed;
        attribute float aKind;
        uniform float uTime, uK, uInnerTan, uTanX, uTanY, uSize, uHazeSize, uViewportH;
        uniform vec3 uColA, uColB;
        varying float vAlpha;
        varying vec3 vColor;
        varying float vKind;
        ${NOISE_GLSL}
        void main() {
          float id = aSeed.x * 71.0 + aSeed.z * 17.0;
          vec2 t;      // 視線からのずれ（tan の平面。1 = 45°）
          float d;     // 奥行き [m]
          float size;
          if (aKind < 0.5) {
            float life = fract(aSeed.w + uTime * (0.22 + 0.25 * aSeed.x));
            float phi = aSeed.y * 6.2832;
            // この向きの視野の縁（楕円）までの距離。外側ほど多く: 内側（25°）〜縁の少し外を √ に偏らせる
            float edgeR = 1.0 / length(vec2(cos(phi) / uTanX, sin(phi) / uTanY));
            float r = mix(uInnerTan, max(uInnerTan, edgeR * 1.05), sqrt(aSeed.z));
            t = vec2(cos(phi), sin(phi)) * r;
            // 上へ流れる（炎）＋ 横に揺れる
            t.y += life * 0.32 * (0.6 + 0.4 * aSeed.x);
            t.x += (kNoise(uTime * 0.9 + id) - 0.5) * 0.05;
            // 内側に入りそうなら輪の外へ押し戻す
            float tl = length(t);
            if (tl < uInnerTan) t *= uInnerTan / max(tl, 1e-3);
            d = 0.6 + 0.6 * aSeed.x;
            float lower = 0.55 + 0.45 * clamp(-sin(phi), 0.0, 1.0);
            float flick = 0.5 + 0.5 * kNoise(uTime * 2.7 + id);
            // 内側の縁はやわらかく（外側ほど濃い）
            float edge = smoothstep(uInnerTan, uInnerTan + 0.18, length(t));
            vAlpha = sin(3.1416 * life) * flick * lower * edge * 0.9;
            vColor = mix(uColA, uColB, life);
            size = uSize * (0.6 + 0.8 * aSeed.z);
          } else {
            // もや: 視野の縁のあたりに大きく柔らかく（中心は縁の少し外。内側へにじむ）。ゆっくり漂い、明るさが息づく
            float phi = aSeed.y * 6.2832 + 0.08 * sin(uTime * 0.21 + id);
            float edgeR = 1.0 / length(vec2(cos(phi) / uTanX, sin(phi) / uTanY));
            float r = edgeR * mix(1.0, 1.2, aSeed.z);
            t = vec2(cos(phi), sin(phi)) * r;
            t.y += 0.05 * sin(uTime * 0.37 + id * 1.3);
            d = 1.0;
            vAlpha = (0.10 + 0.07 * kNoise(uTime * 0.45 + id)) * (0.7 + 0.3 * clamp(-sin(phi), 0.0, 1.0));
            vColor = mix(uColA, uColB, 0.35);
            size = uHazeSize * (0.75 + 0.5 * aSeed.w);
          }
          vAlpha *= uK;
          vKind = aKind;
          vec4 mv = modelViewMatrix * vec4(t.x * d, t.y * d, -d, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = clamp(size * projectionMatrix[1][1] * uViewportH * 0.5 / max(0.05, -mv.z), 0.0, 256.0);
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vAlpha;
        varying vec3 vColor;
        varying float vKind;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float d = length(c) * 2.0;
          if (d > 1.0) discard;
          // 火の粉は芯が明るい小さな粒、もやはガウスの柔らかい円
          float a = vKind < 0.5 ? pow(1.0 - d, 1.8) : exp(-d * d * 3.5) * (1.0 - d);
          gl_FragColor = vec4(vColor, a * vAlpha);
        }
      `,
    });
    this.points = new THREE.Points(geometry, material);
    this.points.frustumCulled = false;
    // 化身・マーカー枠より後（加算なので順序で色は変わらないが、半透明の化身の後に重ねる）
    this.points.renderOrder = 10;
  }
  /** 片目の視野に合わせる（StereoEffect の片目は aspect が camera.aspect の半分）。viewportH は粒の大きさの換算用 [px] */
  setView(fovDeg: number, eyeAspect: number, viewportH: number) {
    const t = Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2);
    this.uniforms.uTanY.value = t;
    this.uniforms.uTanX.value = t * eyeAspect;
    this.uniforms.uViewportH.value = viewportH;
  }
  dispose() {
    this.points.geometry.dispose();
    (this.points.material as THREE.Material).dispose();
  }
}
