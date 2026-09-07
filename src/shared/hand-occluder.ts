// 自分の手で仮想物を隠す（オクルージョン）ための「深度だけ書く」手のメッシュ（issue #14）。
//
// なぜ要るか: パススルー背景（scene.background のカメラ映像）は深度を持たない一枚の絵なので、
// 背景に映っている現実の手は three にとって「物体」ではなく、ボードなど仮想物は距離に関係なく
// 必ず手の上に描かれる（手より奥にあるはずのダーツボードが手の前に見える）。ブラウザからは
// 深度センサーも取れない（iOS Safari は WebXR depth-sensing 非対応）ので、唯一持っている
// 手の 3D 情報 = MediaPipe の 21 点（hand-slots.ts がカメラ座標系に置いたもの）から手の形を
// 太らせたメッシュを作り、色は書かず深度だけ書く（colorWrite: false）。仮想物のうち手の奥に
// ある部分は深度テストで落ち、そこには背景（= 現実の手）がそのまま残る。
//
// 形: 関節 21 個の球 + 骨 21 本の円柱 + 手のひらの多角形。半径は大人の手の概算（下の RADII）に
// 余白 pad を足す。SkeletonView と同じ点を同じ親（カメラ）の下で使うので、骨格が背景の手に
// 重なる設定なら、このメッシュも背景の手を覆う。
//
// 視差: 背景は両眼に同じ画像（視差ゼロ）だが、カメラの子に置いた手は StereoEffect の eyeSep 分の
// 視差を持つ（PAIN_POINTS「単眼パススルーの背景には視差が無く…」。0.4m で片目 ±3cm ≈ 指 1 本）。
// このメッシュが視差を持つと「穴」が左右の目で指 1 本分ずれ、背景の手を覆い切れない。そこで
// 既定では、目ごとの描画のたびに（onBeforeRender で渡される目のカメラと中心カメラの差ぶん）
// 頂点をその目の側へずらして描き、背景と同じ視差ゼロにする（同 PAIN_POINTS の案 (a) を
// この 1 層だけに適用）。zeroParallax: false で通常の視差に戻せる（実機での比較用）
import * as THREE from "three";
import { HAND_CONNECTIONS, LANDMARK_COUNT } from "./hand-math.ts";
import type { Vec3 } from "./hand-math.ts";

/** 各ランドマークの太さ（半径 [m]）。大人の手の概算: 指の幅 1.6〜2cm、手のひらの厚み 2.5〜3cm */
export const RADII: readonly number[] = [
  0.022, // 0 手首
  0.018, // 1 親指 CMC（手のひらの付け根）
  0.014, // 2 親指 MCP
  0.012, // 3 親指 IP
  0.011, // 4 親指の先
  0.014, 0.01, 0.009, 0.008, // 5-8 人差し指 MCP/PIP/DIP/TIP
  0.014, 0.01, 0.009, 0.008, // 9-12 中指
  0.014, 0.01, 0.009, 0.008, // 13-16 薬指
  0.013, 0.009, 0.008, 0.007, // 17-20 小指
];

/**
 * 手のひらを埋める三角形。手のひらの重心 c（0,5,9,13,17 の平均）を中心にした扇 +
 * 親指の付け根と人差し指の間（1-2-5）。-1 は c
 */
const PALM_TRIANGLES: readonly (readonly [number, number, number])[] = [
  [-1, 0, 1],
  [-1, 1, 5],
  [-1, 5, 9],
  [-1, 9, 13],
  [-1, 13, 17],
  [-1, 17, 0],
  [1, 2, 5],
];
const PALM_CENTER_INDICES = [0, 5, 9, 13, 17];
const Y_AXIS = new THREE.Vector3(0, 1, 0);

export type HandOccluderOptions = {
  /** 半径に足す余白 [m]（トラッキングの誤差・EMA の遅れぶん）。既定 0.005 */
  pad?: number;
  /** 背景と同じ視差ゼロで描く（既定 true）。false で通常の視差 */
  zeroParallax?: boolean;
  /** 半透明の色で描いて、背景の手にどれだけ重なっているかを目で確かめる（?occluderDebug=1） */
  debug?: boolean;
  /**
   * 視差ゼロの基準になる中心カメラ。目のカメラ（StereoEffect の cameraL/R）との位置差を
   * 打ち消す。zeroParallax のときは必須
   */
  mainCamera?: THREE.Object3D;
};

export class HandOccluder {
  readonly group = new THREE.Group();
  private readonly material: THREE.MeshBasicMaterial;
  private readonly joints: THREE.InstancedMesh;
  private readonly bones: THREE.InstancedMesh;
  private readonly palm: THREE.Mesh;
  private readonly palmPositions: Float32Array;
  private readonly pad: number;
  private readonly eyeOffset = { value: new THREE.Vector3() };
  private readonly tmpM = new THREE.Matrix4();
  private readonly tmpP = new THREE.Vector3();
  private readonly tmpQ = new THREE.Quaternion();
  private readonly tmpS = new THREE.Vector3();
  private readonly tmpDir = new THREE.Vector3();
  private readonly tmpEye = new THREE.Vector3();
  private readonly tmpCenter = new THREE.Vector3();

  constructor(opts: HandOccluderOptions = {}) {
    const debug = opts.debug ?? false;
    const zeroParallax = opts.zeroParallax ?? true;
    this.pad = opts.pad ?? 0.005;
    this.material = new THREE.MeshBasicMaterial({
      color: 0x206040,
      // 本番は色を書かない = 深度だけ。デバッグは緑を加算で重ねて（transparent にすると描画順が
      // 不透明物の後ろに回って遮蔽が見えなくなるので、不透明のまま加算合成）位置合わせを見る
      colorWrite: debug,
      blending: debug ? THREE.AdditiveBlending : THREE.NormalBlending,
      side: THREE.DoubleSide,
    });
    if (zeroParallax) {
      const eyeOffset = this.eyeOffset;
      this.material.onBeforeCompile = (shader) => {
        shader.uniforms.eyeOffset = eyeOffset;
        // instanceMatrix を掛けた後・modelViewMatrix を掛ける前（= メッシュのローカル座標）で
        // 目のオフセットぶんずらす。project_vertex の中身を置き換える
        const chunk = THREE.ShaderChunk.project_vertex.replace(
          "mvPosition = modelViewMatrix * mvPosition;",
          "mvPosition.xyz += eyeOffset;\nmvPosition = modelViewMatrix * mvPosition;",
        );
        shader.vertexShader = shader.vertexShader
          .replace("#include <common>", "#include <common>\nuniform vec3 eyeOffset;")
          .replace("#include <project_vertex>", chunk);
      };
      this.material.customProgramCacheKey = () => "hand-occluder-zero-parallax";
    }

    this.joints = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 10, 8), this.material, LANDMARK_COUNT);
    // 円柱は Y 軸方向・長さ 1・半径 1。端は球で塞がるので開いたまま
    this.bones = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(1, 1, 1, 8, 1, true),
      this.material,
      HAND_CONNECTIONS.length,
    );
    this.palmPositions = new Float32Array(PALM_TRIANGLES.length * 3 * 3);
    const palmGeometry = new THREE.BufferGeometry();
    palmGeometry.setAttribute("position", new THREE.BufferAttribute(this.palmPositions, 3));
    this.palm = new THREE.Mesh(palmGeometry, this.material);

    const mainCamera = zeroParallax ? opts.mainCamera : undefined;
    for (const mesh of [this.joints, this.bones, this.palm]) {
      // 仮想物より先に描いて深度を残す（不透明の描画順は renderOrder が最優先）
      mesh.renderOrder = -1;
      // 毎フレーム位置を書き換えるので境界球を当てにしない（SkeletonView と同じ理由）
      mesh.frustumCulled = false;
      if (mainCamera) {
        mesh.onBeforeRender = (_renderer, _scene, camera) => this.updateEyeOffset(camera, mainCamera, mesh);
      }
      this.group.add(mesh);
    }
    this.group.visible = false;
  }

  /**
   * いま描こうとしている目のカメラと中心カメラの位置差を、メッシュのローカル座標で uniform に入れる。
   * StereoEffect は cameraL/R の matrixWorld を中心カメラ × (±eyeSep/2) で直接作るので、
   * 位置差は matrixWorld から取る（position には入っていない）
   */
  private updateEyeOffset(eye: THREE.Camera, center: THREE.Object3D, mesh: THREE.Object3D) {
    this.tmpEye.setFromMatrixPosition(eye.matrixWorld);
    this.tmpCenter.setFromMatrixPosition(center.matrixWorld);
    this.tmpEye.sub(this.tmpCenter);
    // ワールドの差 → メッシュのローカル（回転だけ。スケールは 1）
    mesh.getWorldQuaternion(this.tmpQ).invert();
    this.eyeOffset.value.copy(this.tmpEye).applyQuaternion(this.tmpQ);
  }

  /** 21 点（group のローカル座標）で形を更新して表示する。SkeletonView.update と同じ入力 */
  update(points: readonly Vec3[]) {
    const pad = this.pad;
    for (let i = 0; i < LANDMARK_COUNT; i++) {
      const p = points[i];
      const r = RADII[i] + pad;
      this.tmpP.set(p.x, p.y, p.z);
      this.tmpS.set(r, r, r);
      this.tmpM.compose(this.tmpP, this.tmpQ.identity(), this.tmpS);
      this.joints.setMatrixAt(i, this.tmpM);
    }
    this.joints.instanceMatrix.needsUpdate = true;

    for (const [k, [a, b]] of HAND_CONNECTIONS.entries()) {
      const pa = points[a];
      const pb = points[b];
      this.tmpDir.set(pb.x - pa.x, pb.y - pa.y, pb.z - pa.z);
      const len = this.tmpDir.length();
      const r = Math.min(RADII[a], RADII[b]) + pad;
      if (len < 1e-6) {
        this.tmpM.makeScale(0, 0, 0);
      } else {
        this.tmpDir.divideScalar(len);
        this.tmpP.set((pa.x + pb.x) / 2, (pa.y + pb.y) / 2, (pa.z + pb.z) / 2);
        this.tmpQ.setFromUnitVectors(Y_AXIS, this.tmpDir);
        this.tmpS.set(r, len, r);
        this.tmpM.compose(this.tmpP, this.tmpQ, this.tmpS);
      }
      this.bones.setMatrixAt(k, this.tmpM);
    }
    this.bones.instanceMatrix.needsUpdate = true;

    this.tmpCenter.set(0, 0, 0);
    for (const i of PALM_CENTER_INDICES) this.tmpCenter.add(this.tmpP.set(points[i].x, points[i].y, points[i].z));
    this.tmpCenter.divideScalar(PALM_CENTER_INDICES.length);
    const pos = this.palmPositions;
    for (const [t, tri] of PALM_TRIANGLES.entries()) {
      for (const [v, idx] of tri.entries()) {
        const o = (t * 3 + v) * 3;
        if (idx < 0) {
          pos[o] = this.tmpCenter.x;
          pos[o + 1] = this.tmpCenter.y;
          pos[o + 2] = this.tmpCenter.z;
        } else {
          pos[o] = points[idx].x;
          pos[o + 1] = points[idx].y;
          pos[o + 2] = points[idx].z;
        }
      }
    }
    this.palm.geometry.attributes.position.needsUpdate = true;
    this.group.visible = true;
  }

  hide() {
    this.group.visible = false;
  }

  get visible() {
    return this.group.visible;
  }

  dispose() {
    this.group.removeFromParent();
    this.joints.dispose();
    this.joints.geometry.dispose();
    this.bones.dispose();
    this.bones.geometry.dispose();
    this.palm.geometry.dispose();
    this.material.dispose();
  }
}
