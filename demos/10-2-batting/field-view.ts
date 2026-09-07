// 10-2-batting の共通 3D 表示。スマホは marker anchor の子、俯瞰画面は world 直下に置く。
import * as THREE from "three";
import {
  BALL_R,
  type BattingConfig,
  type V3,
} from "../../src/shared/batting-sim";

export class BattingFieldView {
  readonly group = new THREE.Group();
  private readonly floor: THREE.Mesh<
    THREE.PlaneGeometry,
    THREE.MeshStandardMaterial
  >;
  private readonly mound = new THREE.Group();
  private readonly plate = new THREE.Group();
  private readonly strikeZone: THREE.LineSegments;
  private readonly ball: THREE.Mesh<
    THREE.SphereGeometry,
    THREE.MeshStandardMaterial
  >;
  private readonly shadow: THREE.Mesh<
    THREE.CircleGeometry,
    THREE.MeshBasicMaterial
  >;
  private readonly batPivot = new THREE.Group();
  private readonly bat: THREE.Mesh<
    THREE.CylinderGeometry,
    THREE.MeshStandardMaterial
  >;
  private readonly pitcherPivot = new THREE.Group();
  private cfg: BattingConfig | null = null;

  constructor(ballDetail = 20) {
    this.floor = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshStandardMaterial({
        color: 0x4f7d3c,
        transparent: true,
        opacity: 0.42,
        side: THREE.DoubleSide,
        roughness: 0.95,
      }),
    );
    this.floor.rotation.x = -Math.PI / 2;
    this.group.add(this.floor);

    const moundDisc = new THREE.Mesh(
      new THREE.CircleGeometry(0.22, 32),
      new THREE.MeshStandardMaterial({
        color: 0xb78a5c,
        transparent: true,
        opacity: 0.65,
        side: THREE.DoubleSide,
      }),
    );
    moundDisc.rotation.x = -Math.PI / 2;
    this.mound.add(moundDisc);
    const rubber = new THREE.Mesh(
      new THREE.BoxGeometry(0.28, 0.015, 0.06),
      new THREE.MeshStandardMaterial({ color: 0xe8eaed }),
    );
    rubber.position.y = 0.012;
    this.mound.add(rubber);
    this.group.add(this.mound);

    const plateShape = new THREE.Shape();
    plateShape.moveTo(-0.22, 0.14);
    plateShape.lineTo(0.22, 0.14);
    plateShape.lineTo(0.22, -0.08);
    plateShape.lineTo(0, -0.23);
    plateShape.lineTo(-0.22, -0.08);
    plateShape.closePath();
    const plateMesh = new THREE.Mesh(
      new THREE.ShapeGeometry(plateShape),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.8,
      }),
    );
    plateMesh.rotation.x = -Math.PI / 2;
    this.plate.add(plateMesh);
    this.group.add(this.plate);

    this.strikeZone = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 0.025)),
      new THREE.LineBasicMaterial({
        color: 0xfdd663,
        transparent: true,
        opacity: 0.8,
      }),
    );
    this.group.add(this.strikeZone);

    // 投手と打者を結ぶ白線 + バッターボックス。
    const lineMaterial = new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.45,
    });
    const centerLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(),
        new THREE.Vector3(0, 0, 1),
      ]),
      lineMaterial,
    );
    centerLine.name = "center-line";
    this.group.add(centerLine);
    const batterBox = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1.2, 0.01, 0.85)),
      lineMaterial,
    );
    batterBox.name = "batter-box";
    this.group.add(batterBox);

    this.ball = new THREE.Mesh(
      new THREE.SphereGeometry(BALL_R, ballDetail, Math.round(ballDetail * 0.75)),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.45 }),
    );
    this.ball.visible = false;
    this.group.add(this.ball);
    this.shadow = new THREE.Mesh(
      new THREE.CircleGeometry(BALL_R * 1.15, 20),
      new THREE.MeshBasicMaterial({
        color: 0x000000,
        transparent: true,
        opacity: 0.3,
      }),
    );
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.visible = false;
    this.group.add(this.shadow);

    // Joy-Con の絶対位置は取れないため、ホームベース横の支点を中心に角度だけ追従する仮想バット。
    this.bat = new THREE.Mesh(
      new THREE.CylinderGeometry(0.028, 0.055, 0.75, 16),
      new THREE.MeshStandardMaterial({
        color: 0xffb300,
        metalness: 0.1,
        roughness: 0.55,
      }),
    );
    this.bat.rotation.z = Math.PI / 2;
    this.bat.position.x = -0.34;
    this.batPivot.add(this.bat);
    this.batPivot.visible = false;
    this.group.add(this.batPivot);

    // 投手の腕も位置は固定し、Joy-Con の回転角だけを表示する。
    const arm = new THREE.Mesh(
      new THREE.CylinderGeometry(0.025, 0.04, 0.55, 12),
      new THREE.MeshStandardMaterial({ color: 0x00b8d4, roughness: 0.6 }),
    );
    arm.position.y = -0.25;
    this.pitcherPivot.add(arm);
    this.pitcherPivot.visible = false;
    this.group.add(this.pitcherPivot);
  }

  build(cfg: BattingConfig) {
    this.cfg = cfg;
    const floorY = -cfg.floorDrop;
    this.floor.scale.set(cfg.wallW, cfg.floorDepth, 1);
    this.floor.position.set(0, floorY, cfg.floorDepth / 2);
    this.mound.position.set(0, floorY + 0.008, cfg.moundZ);
    this.plate.position.set(0, floorY + 0.008, cfg.plateZ);
    this.strikeZone.scale.set(
      cfg.strikeHalfW * 2,
      cfg.strikeHalfH * 2,
      1,
    );
    this.strikeZone.position.set(0, cfg.strikeY, cfg.plateZ);

    const centerLine = this.group.getObjectByName("center-line") as THREE.Line;
    centerLine.scale.z = cfg.plateZ - cfg.moundZ;
    centerLine.position.set(0, floorY + 0.01, cfg.moundZ);
    const batterBox = this.group.getObjectByName(
      "batter-box",
    ) as THREE.LineSegments;
    batterBox.position.set(0, floorY + 0.01, cfg.plateZ + 0.15);

    this.batPivot.position.set(
      0.48,
      cfg.strikeY + 0.16,
      cfg.plateZ + 0.18,
    );
    this.pitcherPivot.position.set(0.3, cfg.releaseY + 0.3, cfg.moundZ);
  }

  setTracking(tracking: boolean) {
    this.floor.material.color.setHex(tracking ? 0x4f7d3c : 0x8b3a3a);
  }

  setBall(pos: V3 | null, color = 0xffffff) {
    if (!this.cfg || !pos) {
      this.ball.visible = false;
      this.shadow.visible = false;
      return;
    }
    this.ball.visible = true;
    this.shadow.visible = true;
    this.ball.material.color.setHex(color);
    this.ball.position.set(...pos);
    this.shadow.position.set(
      pos[0],
      -this.cfg.floorDrop + 0.01,
      pos[2],
    );
    const height = Math.max(0, pos[1] + this.cfg.floorDrop);
    this.shadow.material.opacity = Math.max(0.08, 0.32 - height * 0.08);
  }

  setBat(angleDeg: number | null, color = 0xffb300) {
    if (angleDeg === null) {
      this.batPivot.visible = false;
      return;
    }
    this.batPivot.visible = true;
    this.bat.material.color.setHex(color);
    this.batPivot.rotation.y =
      THREE.MathUtils.degToRad(-25 - angleDeg * 1.4);
  }

  setPitcher(angleDeg: number | null, color = 0x00b8d4) {
    if (angleDeg === null) {
      this.pitcherPivot.visible = false;
      return;
    }
    this.pitcherPivot.visible = true;
    (
      this.pitcherPivot.children[0] as THREE.Mesh<
        THREE.CylinderGeometry,
        THREE.MeshStandardMaterial
      >
    ).material.color.setHex(color);
    this.pitcherPivot.rotation.x =
      THREE.MathUtils.degToRad(15 + angleDeg * 1.2);
  }
}
