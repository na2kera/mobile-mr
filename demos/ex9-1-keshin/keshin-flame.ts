// 人物から化身へつながる炎の膜。円筒の頂点を GPU で揺らし、面の連続性と尖った炎の輪郭を作る。
// ワールドの形状なので左右の眼で視差が付く。画像・ポストエフェクト・毎フレームの頂点更新は不要。
import * as THREE from "three";
import { MASK_HEAD_GLSL } from "./keshin-occlusion";
import type { MaskBinding } from "./keshin-occlusion";
import type { WorldAuraUniforms } from "./keshin-aura";

export function createFlame(uniforms: WorldAuraUniforms, mask: MaskBinding | null): THREE.Mesh {
  // position.y = 高さ 0..1。円周の重複頂点も同じ角度の波で動くため継ぎ目が出ない。
  const geometry = new THREE.CylinderGeometry(1, 1, 1, 64, 40, true);
  geometry.translate(0, 0.5, 0);
  const material = new THREE.ShaderMaterial({
    uniforms: mask ? { ...uniforms, ...mask.shared, ...mask.owner } : uniforms,
    transparent: true,
    depthWrite: false,
    // 奥側の面も描く。加算だけの白い光にせず、飽和した色の炎を背景へ重ねる。
    side: THREE.DoubleSide,
    blending: THREE.NormalBlending,
    vertexShader: /* glsl */ `
      uniform float uTime, uBurstK, uFlameH, uFlameR, uColumnR;
      uniform vec3 uSwirlC;
      varying vec2 vFlame;
      varying vec3 vWorld, vRadial;
      void main() {
        float h = position.y;
        float a = atan(position.z, position.x);
        float t = uTime * (1.6 + uBurstK);
        float tongues = 0.5 + 0.5 * sin(a * 7.0 + sin(a * 3.0 - t) * 1.1 - t * 1.8);
        // 頂部は一様な輪にせず、背の違う炎の舌にする。
        float top = 0.84 + 0.16 * tongues;
        float y = h * uFlameH * top;
        float join = smoothstep(0.2, max(0.4, uSwirlC.y), y);
        float taper = 1.0 - 0.96 * pow(h, 4.5);
        float wave = sin(a * 9.0 - y * 3.8 + t * 3.0) * 0.09
                   + sin(a * 5.0 + y * 6.0 - t * 4.0) * 0.05;
        float r = mix(uColumnR, uFlameR, join) * taper * (1.0 + wave * (1.0 + uBurstK));
        vec3 radial = vec3(cos(a), 0.0, sin(a));
        vec3 p = vec3(0.0, y, uSwirlC.z * join) + radial * r;
        vec4 world = modelMatrix * vec4(p, 1.0);
        vWorld = world.xyz;
        vRadial = normalize(mat3(modelMatrix) * radial);
        vFlame = vec2(a, h);
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime, uAuraK, uPillarK, uBurstK, uFlameH, uColumnMaxH;
      uniform vec3 uColA, uColB, uEye;
      uniform vec2 uNear;
      varying vec2 vFlame;
      varying vec3 vWorld, vRadial;
      ${mask ? MASK_HEAD_GLSL : ""}
      void main() {
        ${mask ? "if (keshinMasked(vWorld)) discard;" : ""}
        float a = vFlame.x;
        float h = vFlame.y;
        float t = uTime * (1.6 + uBurstK);
        // 周方向は整数周の sin に統一。縦の筋を高速に上へ流す。
        float warp = sin(a * 3.0 + h * 8.0 - t * 2.0);
        float flow = 0.5 + 0.5 * sin(a * 11.0 + warp * 1.7 - h * 19.0 + t * 6.0);
        float detail = 0.5 + 0.5 * sin(a * 19.0 - h * 31.0 + t * 8.0);
        float fire = smoothstep(0.22, 0.8, flow * 0.78 + detail * 0.22);
        float edge = pow(1.0 - abs(dot(normalize(cameraPosition - vWorld), normalize(vRadial))), 1.8);
        float reach = 1.0 - smoothstep(uPillarK - 0.12, uPillarK + 0.001, h);
        float ends = smoothstep(0.0, 0.08, h) * (1.0 - smoothstep(0.88, 1.0, h));
        // 主観は肩より上へ描かない。近距離フェードも既存の粒子と共有する。
        float cap = 1.0 - smoothstep(uColumnMaxH - 0.2, uColumnMaxH, h * uFlameH);
        float nearK = uNear.y > 0.0 ? smoothstep(uNear.x, uNear.y, distance(vWorld, uEye)) : 1.0;
        float alpha = (0.12 + fire * 0.38 + edge * 0.30) * ends * reach * cap * nearK
                    * uAuraK * (1.0 + 0.25 * uBurstK);
        vec3 color = mix(uColA, uColB, clamp(fire * 0.55 + edge * 0.35, 0.0, 1.0));
        gl_FragColor = vec4(color, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 1;
  return mesh;
}
