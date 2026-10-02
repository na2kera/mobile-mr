// 人物から化身の頭上へ吹き上がる炎。円筒の頂点を GPU で揺らして輪郭をうねらせ、表面の模様と炎の舌の切れ目は
// フラグメントシェーダーのノイズで作る。ワールドの形状なので左右の眼で視差が付く。画像・ポストエフェクト・毎フレームの頂点更新は不要。
//
// 参考動画（2026-10-02）に合わせた見え方:
//   - 人物と化身の「背後」に立つ濃い塊（円筒の奥側の面だけを描く。手前の面を描くと化身と人物が炎でかすむ）
//   - 芯は暗く、輪郭と炎の舌の縁が明るい
//   - 上へ行くほど広がり、頂部は高さの違う炎の舌にちぎれる（1 点にすぼめない）
//   - 模様は上へ流れる不規則な乱れ（sin の重ね合わせだけだと規則的な縦縞のカーテンに見える）
import * as THREE from "three";
import { MASK_HEAD_GLSL } from "./keshin-occlusion";
import type { MaskBinding } from "./keshin-occlusion";
import type { WorldAuraUniforms } from "./keshin-aura";

/** 円周方向に周期のある値ノイズ（x は period で一周する。円筒に巻いても継ぎ目が出ない） */
const FLAME_NOISE_GLSL = /* glsl */ `
// 縦のセル番号は時刻とともに増え続けるので折り返す（sin の引数が大きくなると、スマホの GPU で精度が落ちて模様が崩れる）
float fHash(vec2 p) { return fract(sin(dot(vec2(p.x, mod(p.y, 1024.0)), vec2(127.1, 311.7))) * 43758.5453123); }
float fNoise(vec2 p, float period) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float x0 = mod(i.x, period);
  float x1 = mod(i.x + 1.0, period);
  return mix(mix(fHash(vec2(x0, i.y)), fHash(vec2(x1, i.y)), u.x),
             mix(fHash(vec2(x0, i.y + 1.0)), fHash(vec2(x1, i.y + 1.0)), u.x), u.y);
}
`;

export function createFlame(uniforms: WorldAuraUniforms, mask: MaskBinding | null): THREE.Mesh {
  // position.y = 高さ 0..1。上端は開いた円筒（頂部は炎の舌の切れ目で終わらせる）
  const geometry = new THREE.CylinderGeometry(1, 1, 1, 64, 40, true);
  geometry.translate(0, 0.5, 0);
  const material = new THREE.ShaderMaterial({
    uniforms: mask ? { ...uniforms, ...mask.shared, ...mask.owner } : uniforms,
    transparent: true,
    depthWrite: false,
    // 奥側の面だけ描く（外から見ると人物と化身の背後の面、主観のように中から見ると周りの面）。
    // 加算ではなく通常のアルファ合成で、背景を覆う濃い色の炎にする
    side: THREE.BackSide,
    blending: THREE.NormalBlending,
    vertexShader: /* glsl */ `
      uniform float uTime, uBurstK, uFlameH, uFlameR, uColumnR, uInsideFade;
      uniform vec3 uSwirlC;
      varying float vH, vOutK;
      varying vec2 vDir;
      varying vec3 vWorld, vRadial;
      void main() {
        float h = position.y;
        // 頂点の変形は角度の周期関数だけを使う（atan の ±π の跳びは sin の中で消える）
        float a = atan(position.z, position.x);
        float t = uTime * (1.0 + 0.6 * uBurstK);
        float y = h * uFlameH;
        // 足元は人物を包む細い柱、背中から上は化身を包む太さへ。その先も上へ行くほど広がる
        float join = smoothstep(0.2, max(0.4, uSwirlC.y), y);
        float baseR = mix(uColumnR, uFlameR, join) * (1.0 + 0.3 * h);
        // 輪郭のうねり: 周期の違う大きな膨らみが上へ流れる（上ほど大きく、出現の勢いでさらに大きく）
        float lobe = sin(a * 2.0 + y * 1.7 - t * 1.3) * 0.14
                   + sin(a * 3.0 - y * 2.9 + t * 0.9 + 1.7) * 0.10
                   + sin(a * 5.0 + y * 4.3 - t * 2.1 + 4.0) * 0.07
                   + sin(a * 8.0 - y * 6.1 + t * 3.1 + 2.3) * 0.045
                   + sin(a * 13.0 + y * 8.7 - t * 3.9 + 0.6) * 0.03;
        float r = baseR * (1.0 + lobe * (0.5 + 0.9 * h) * (1.0 + 0.5 * uBurstK));
        vec3 radial = vec3(cos(a), 0.0, sin(a));
        vec3 p = vec3(0.0, y, uSwirlC.z * join) + radial * r;
        vec4 world = modelMatrix * vec4(p, 1.0);
        vWorld = world.xyz;
        vRadial = normalize(mat3(modelMatrix) * radial);
        vH = h;
        // 角度そのものを渡すと、±π をまたぐ 1 列だけ補間で 2π ぶん回って模様が潰れる（縦の縞）。向きを渡して画素ごとに角度へ戻す
        vDir = radial.xz;
        // 見ている人が炎の内側（または縁のすぐ外）にいるときは消す（他人用。近くの人の炎の内壁が視界を覆わないように）。
        // カメラを炎の枠（足元・体の向き。回転と平行移動だけ）に戻し、その高さでの炎の中心と太さで内外を決める
        vec3 camD = cameraPosition - modelMatrix[3].xyz;
        vec3 camL = vec3(dot(modelMatrix[0].xyz, camD), dot(modelMatrix[1].xyz, camD), dot(modelMatrix[2].xyz, camD));
        float yc = clamp(camL.y, 0.0, uFlameH);
        float jc = smoothstep(0.2, max(0.4, uSwirlC.y), yc);
        float rc = mix(uColumnR, uFlameR, jc) * (1.0 + 0.3 * yc / uFlameH);
        float dc = length(camL.xz - vec2(0.0, uSwirlC.z * jc));
        vOutK = mix(1.0, smoothstep(rc * 0.9, rc * 1.5, dc), uInsideFade);
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime, uAuraK, uPillarK, uBurstK, uFlameH, uFlameK, uColumnH, uColumnK, uColumnMaxH;
      uniform vec3 uColA, uColB, uEye;
      uniform vec2 uNear;
      varying float vH, vOutK;
      varying vec2 vDir;
      varying vec3 vWorld, vRadial;
      ${FLAME_NOISE_GLSL}
      ${mask ? MASK_HEAD_GLSL : ""}
      void main() {
        if (vOutK <= 0.0) discard;
        ${mask ? "if (keshinMasked(vWorld)) discard;" : ""}
        // 一周で 0..1（ノイズ側が周期を持つので、±π の境目でも模様がつながる）
        float u = atan(vDir.y, vDir.x) / 6.2831853 + 0.5;
        float y = vH * uFlameH;
        // 主観は肩より上を描かない。正面を向くと肩より上の壁が両眼いっぱいに入るので、ノイズを計算する前に捨てる
        if (y >= uColumnMaxH) discard;
        float t = uTime * (1.0 + 0.6 * uBurstK);
        // 出現: 柱が伸びる分だけ下から伸びる（伸びている途中も先端は炎の舌の形）
        float hh = vH / max(uPillarK, 0.001);
        if (hh >= 1.0) discard;
        // 上へ流れる乱れ。横にゆっくり曲げてから 3 段重ねる（縦に長い炎の筋になるよう、縦は粗く）
        float warp = fNoise(vec2(u * 4.0, y * 0.7 - t * 0.5), 4.0) - 0.5;
        vec2 p = vec2(u * 9.0 + warp * 2.2, y * 1.3 - t * 1.5);
        float n = fNoise(p, 9.0) * 0.5
                + fNoise(p * 2.0 + vec2(0.0, -t * 0.9), 18.0) * 0.3
                + fNoise(p * 4.0 + vec2(0.0, -t * 1.7), 36.0) * 0.2;
        // 形状の輪郭（視線と面が平行に近いところ）。0 = 正面を向いた面、1 = 輪郭
        float edge = clamp(1.0 - abs(dot(normalize(cameraPosition - vWorld), normalize(vRadial))), 0.0, 1.0);
        // 濃さ: 下は全面、上へ行くほどノイズの山だけが残って炎の舌になる。輪郭もノイズで削ってちぎれさせる（布のような滑らかな縁にしない）
        float d = n + 0.58 - pow(hh, 1.25) * 1.2 - edge * edge * edge * (0.25 + 0.9 * (1.0 - n));
        float body = smoothstep(0.0, 0.08, d);
        if (body <= 0.0) discard;
        // 縁（炎の舌・輪郭の切れ目の近く）が明るく、芯は暗い。芯の中にも乱れの濃淡を残す
        float rim = 1.0 - smoothstep(0.0, 0.28, d);
        float core = smoothstep(0.15, 0.7, d) * (0.55 + 0.45 * smoothstep(0.35, 0.7, n));
        // 芯の中を上へ走る明るい筋
        float streak = smoothstep(0.6, 0.9, fNoise(vec2(u * 22.0 + warp * 2.0, y * 1.6 - t * 3.0), 22.0));
        vec3 bright = mix(uColA, uColB, 0.65);
        vec3 color = mix(uColA, uColA * 0.14, core);
        color = mix(color, bright, clamp(max(rim, edge * edge) * 0.9 + streak * 0.35 * (1.0 - rim), 0.0, 1.0));
        float foot = smoothstep(0.0, 0.05, vH);
        // 足元から背中まで: 他人用の「足元は控えめ」（uColumnK）を炎にも半分だけ掛ける
        float low = mix(sqrt(clamp(uColumnK, 0.0, 1.0)), 1.0, smoothstep(uColumnH * 0.6, uColumnH, y));
        // 主観は肩より上へ描かない。近距離フェードも粒子と共有する
        float cap = 1.0 - smoothstep(uColumnMaxH - 0.2, uColumnMaxH, y);
        float nearK = uNear.y > 0.0 ? smoothstep(uNear.x, uNear.y, distance(vWorld, uEye)) : 1.0;
        // 出切ったあと（uAuraK = AURA_SUSTAIN）も濃さを保つ。消去では uAuraK とともに消える
        float strength = clamp(uAuraK * 1.6, 0.0, 1.0);
        float alpha = body * mix(0.86, 1.0, rim) * foot * low * cap * nearK * strength * uFlameK * vOutK;
        // 色は補助の粒子（keshin-aura.ts）と同じ扱い: トーンマッピング・色空間の変換を挟まずそのまま出す
        gl_FragColor = vec4(color, alpha);
      }
    `,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  // 半透明の段の最初に描く: 炎 → 化身の深度（−1）→ 化身の色・粒・ペガサスの帯（0）→ 背中の流れ（2）。
  // 後から描くと、濃い炎が手前の粒や帯を上塗りして隠す
  mesh.renderOrder = -2;
  return mesh;
}
