// 関節 + 骨の骨格を three.js で描く汎用版。05 の HandView（21 点 / 21 本）を Phase 9 で
// 全身（33 点 / 35 本）にも使うために点数と接続を引数にした。HandView はこれの薄い皮。
// 関節は InstancedMesh（球 N 個を 1 ドローコール）、骨は LineSegments。
// 半透明にして、背景（パススルー）に映っている実際の手・体が透けて見えるようにする
import * as THREE from "three";
import type { Vec3 } from "./hand-math.ts";

export class SkeletonView {
  readonly group = new THREE.Group();
  readonly count: number;
  private readonly connections: ReadonlyArray<readonly [number, number]>;
  private readonly joints: THREE.InstancedMesh;
  private readonly bones: THREE.LineSegments;
  private readonly bonePositions: Float32Array;
  private readonly jointMaterial: THREE.MeshBasicMaterial;
  private readonly boneMaterial: THREE.LineBasicMaterial;
  private readonly tmp = new THREE.Matrix4();

  constructor(
    count: number,
    connections: ReadonlyArray<readonly [number, number]>,
    color: number,
    jointRadius = 0.008,
  ) {
    this.count = count;
    this.connections = connections;
    this.jointMaterial = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.85,
      depthTest: false, // 実際の手・体（背景）の上に必ず描く。ボール等に埋もれても見失わないように
    });
    this.joints = new THREE.InstancedMesh(
      new THREE.SphereGeometry(jointRadius, 10, 8),
      this.jointMaterial,
      count,
    );
    this.joints.renderOrder = 10;
    // InstancedMesh の境界球は初回描画時に一度だけ計算され、その後 setMatrixAt で動かしても
    // 更新されない。最初に見えた位置でカリングされ続けないよう切る（bones も同様）
    this.joints.frustumCulled = false;
    this.group.add(this.joints);

    this.bonePositions = new Float32Array(connections.length * 2 * 3);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(this.bonePositions, 3),
    );
    this.boneMaterial = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity: 0.7,
      depthTest: false,
    });
    this.bones = new THREE.LineSegments(geometry, this.boneMaterial);
    this.bones.renderOrder = 10;
    this.bones.frustumCulled = false; // 位置を毎フレーム書き換えるので境界球を当てにしない
    this.group.add(this.bones);
    this.group.visible = false;
  }

  setColor(color: number) {
    this.jointMaterial.color.setHex(color);
    this.boneMaterial.color.setHex(color);
  }

  /** 全点の不透明度（関節 0.85・骨 0.7 を基準に掛ける） */
  setOpacity(k: number) {
    this.jointMaterial.opacity = 0.85 * k;
    this.boneMaterial.opacity = 0.7 * k;
  }

  /** N 点（group のローカル座標）で骨格を更新して表示する */
  update(points: readonly Vec3[]) {
    for (let i = 0; i < this.count; i++) {
      const p = points[i];
      this.tmp.makeTranslation(p.x, p.y, p.z);
      this.joints.setMatrixAt(i, this.tmp);
    }
    this.joints.instanceMatrix.needsUpdate = true;
    for (const [k, [a, b]] of this.connections.entries()) {
      const o = k * 6;
      this.bonePositions[o] = points[a].x;
      this.bonePositions[o + 1] = points[a].y;
      this.bonePositions[o + 2] = points[a].z;
      this.bonePositions[o + 3] = points[b].x;
      this.bonePositions[o + 4] = points[b].y;
      this.bonePositions[o + 5] = points[b].z;
    }
    this.bones.geometry.attributes.position.needsUpdate = true;
    this.group.visible = true;
  }

  hide() {
    this.group.visible = false;
  }

  /** ピアの入れ替えなどで作り直すときに GPU リソースを解放する（06 で追加） */
  dispose() {
    this.group.removeFromParent();
    this.joints.dispose(); // instanceMatrix のバッファ
    this.joints.geometry.dispose();
    this.jointMaterial.dispose();
    this.bones.geometry.dispose();
    this.boneMaterial.dispose();
  }

  get visible() {
    return this.group.visible;
  }
}
