// コート（グリーン・クッションの壁・カップと旗・ボール・狙い線・振り子パター・視線のカーソル）の描画。
// スマホ（main.ts）と俯瞰画面（overview.ts）で同じ見た目にするために分けた。group を field（マーカー座標系）の子にして使う。
// 座標は golf-sim.ts の field 座標系（床 = Y=-floorDrop、床の 2 次元 [x, z]）
import * as THREE from "three";
import { BALL_R, CUP_R, greenHeight } from "../../src/shared/golf-sim";
import type { GolfConfig, HoleDef, V2 } from "../../src/shared/golf-sim";
import { TextPanel } from "../../src/shared/text-panel";

export type BallState = { id: string; pos: V2; color: number; holed: boolean; /** カップの中（描かない） */ sunk: boolean };

export type CourseViewOptions = {
  /** 振り子パターの長さ（支点からヘッドまで）[m] */
  armM: number;
  ballDetail: number;
};

/** クッションの高さ [m]（見た目。08 の壁の高さより低く、床の縁が分かる程度） */
const CUSHION_H = 0.08;
/** 狙い線の長さ [m] */
const AIM_LEN = 0.8;
const UP = new THREE.Vector3(0, 1, 0);
const tmpDir = new THREE.Vector3();

export class CourseView {
  readonly group = new THREE.Group();
  private readonly terrain = new THREE.Group();
  private readonly terrainDetails = new THREE.Group();
  private hole: HoleDef | null = null;
  private readonly green: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>;
  private readonly cushions: THREE.LineSegments<THREE.EdgesGeometry, THREE.LineBasicMaterial>;
  private readonly cushionFill: THREE.Mesh[] = [];
  private readonly cup: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>;
  private readonly cupRim: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  private readonly flag = new THREE.Group();
  private readonly flagLabel: TextPanel;
  private readonly tee: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  private readonly aim: THREE.Line<THREE.BufferGeometry, THREE.LineDashedMaterial>;
  private readonly aimHead: THREE.Mesh<THREE.ConeGeometry, THREE.MeshBasicMaterial>;
  private readonly putter = new THREE.Group();
  private readonly putterHead: THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>;
  private readonly putterShaft: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshStandardMaterial>;
  private readonly gazeCursor: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  private readonly balls = new Map<string, { mesh: THREE.Mesh<THREE.SphereGeometry, THREE.MeshStandardMaterial>; shadow: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial> }>();
  private readonly ballGeometry: THREE.SphereGeometry;
  private readonly shadowGeometry = new THREE.CircleGeometry(BALL_R * 1.1, 16);
  private cfg: GolfConfig | null = null;
  private holeIndex = -1;
  private readonly opts: CourseViewOptions;

  constructor(opts: CourseViewOptions) {
    this.opts = opts;
    this.terrain.matrixAutoUpdate = false;
    this.group.add(this.terrain);
    this.terrain.add(this.terrainDetails);
    this.ballGeometry = new THREE.SphereGeometry(BALL_R, opts.ballDetail, Math.round(opts.ballDetail * 0.75));
    // グリーン（床の矩形。半透明の緑）
    this.green = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial({ color: 0x2e8b57, transparent: true, opacity: 0.45, side: THREE.DoubleSide, roughness: 0.9 }));
    this.green.rotation.x = -Math.PI / 2;
    this.terrain.add(this.green);
    // クッション（四方の低い壁）: 半透明の面 + 縁の線
    for (let i = 0; i < 4; i++) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(1, CUSHION_H), new THREE.MeshBasicMaterial({ color: 0x8ab4f8, transparent: true, opacity: 0.25, side: THREE.DoubleSide }));
      this.cushionFill.push(m);
      this.terrain.add(m);
    }
    this.cushions = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, CUSHION_H, 1)), new THREE.LineBasicMaterial({ color: 0x8ab4f8 }));
    this.terrain.add(this.cushions);
    // カップ（黒い円 + 白い縁）と旗
    this.cup = new THREE.Mesh(new THREE.CircleGeometry(CUP_R, 32), new THREE.MeshBasicMaterial({ color: 0x101214 }));
    this.cup.rotation.x = -Math.PI / 2;
    this.terrain.add(this.cup);
    this.cupRim = new THREE.Mesh(new THREE.RingGeometry(CUP_R, CUP_R + 0.012, 32), new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }));
    this.cupRim.rotation.x = -Math.PI / 2;
    this.terrain.add(this.cupRim);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 1.0, 8), new THREE.MeshStandardMaterial({ color: 0xe8eaed }));
    pole.position.y = 0.5;
    this.flag.add(pole);
    const cloth = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.14), new THREE.MeshBasicMaterial({ color: 0xf28b82, side: THREE.DoubleSide }));
    cloth.position.set(0.11, 0.92, 0);
    this.flag.add(cloth);
    this.flagLabel = new TextPanel(0.3, 0.12, 256, 4);
    this.flagLabel.mesh.position.set(0, 1.12, 0);
    this.flag.add(this.flagLabel.mesh);
    this.group.add(this.flag);
    // ティー（白い輪）
    this.tee = new THREE.Mesh(new THREE.RingGeometry(0.04, 0.05, 24), new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, transparent: true, opacity: 0.7 }));
    this.tee.rotation.x = -Math.PI / 2;
    this.terrain.add(this.tee);
    // 狙い線（破線）と先端の三角。線は「原点 → +X に AIM_LEN」の固定 geometry を置いて回す（毎フレーム geometry を作らない）
    const aimGeometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(AIM_LEN, 0, 0)]);
    this.aim = new THREE.Line(aimGeometry, new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 0.05, gapSize: 0.03, transparent: true }));
    this.aim.computeLineDistances();
    this.terrain.add(this.aim);
    this.aimHead = new THREE.Mesh(new THREE.ConeGeometry(0.025, 0.06, 12), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    this.terrain.add(this.aimHead);
    // 振り子パター: 支点をボールの真上（armM）に置き、シャフトが -Y、ヘッドがその先
    this.putterShaft = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, opts.armM, 8), new THREE.MeshStandardMaterial({ color: 0xbdc1c6, metalness: 0.6, roughness: 0.4 }));
    this.putterShaft.position.y = -opts.armM / 2;
    this.putter.add(this.putterShaft);
    this.putterHead = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.025, 0.1), new THREE.MeshStandardMaterial({ color: 0xe8eaed, metalness: 0.5, roughness: 0.5 }));
    this.putterHead.position.set(-0.02, -opts.armM + 0.012, 0);
    this.putter.add(this.putterHead);
    this.putter.visible = false;
    this.group.add(this.putter);
    // 視線のカーソル（床の小さな輪）
    this.gazeCursor = new THREE.Mesh(new THREE.RingGeometry(0.03, 0.04, 20), new THREE.MeshBasicMaterial({ color: 0xfdd663, side: THREE.DoubleSide, transparent: true, opacity: 0.8 }));
    this.gazeCursor.rotation.x = -Math.PI / 2;
    this.gazeCursor.visible = false;
    this.terrain.add(this.gazeCursor);
  }

  /** 寸法からグリーンとクッションを作り直す */
  build(cfg: GolfConfig) {
    this.cfg = cfg;
    const y = -cfg.floorDrop;
    this.green.scale.set(cfg.wallW, cfg.floorDepth, 1);
    this.green.position.set(0, y + 0.002, cfg.floorDepth / 2);
    this.cushions.geometry.dispose();
    this.cushions.geometry = new THREE.EdgesGeometry(new THREE.BoxGeometry(cfg.wallW, CUSHION_H, cfg.floorDepth));
    this.cushions.position.set(0, y + CUSHION_H / 2, cfg.floorDepth / 2);
    const sides: [THREE.Vector3, number, number][] = [
      [new THREE.Vector3(0, y + CUSHION_H / 2, 0), 0, cfg.wallW],
      [new THREE.Vector3(0, y + CUSHION_H / 2, cfg.floorDepth), 0, cfg.wallW],
      [new THREE.Vector3(-cfg.wallW / 2, y + CUSHION_H / 2, cfg.floorDepth / 2), Math.PI / 2, cfg.floorDepth],
      [new THREE.Vector3(cfg.wallW / 2, y + CUSHION_H / 2, cfg.floorDepth / 2), Math.PI / 2, cfg.floorDepth],
    ];
    sides.forEach(([pos, rotY, w], i) => {
      const m = this.cushionFill[i];
      m.position.copy(pos);
      m.rotation.y = rotY;
      m.scale.set(w, 1, 1);
    });
    this.holeIndex = -1;
  }

  setTracking(tracking: boolean) {
    this.cushions.material.color.setHex(tracking ? 0x8ab4f8 : 0xf28b82);
  }

  setHole(hole: HoleDef | null, index: number) {
    if (!this.cfg) return;
    const y = -this.cfg.floorDrop;
    this.hole = hole;
    if (!hole) {
      this.terrainDetails.visible = false;
      this.terrain.matrix.identity();
      this.terrain.matrixWorldNeedsUpdate = true;
      this.holeIndex = -1;
      this.cup.visible = this.cupRim.visible = this.flag.visible = this.tee.visible = false;
      return;
    }
    this.cup.visible = this.cupRim.visible = this.flag.visible = this.tee.visible = true;
    this.cup.position.set(hole.cup[0], y + 0.003, hole.cup[1]);
    this.cupRim.position.set(hole.cup[0], y + 0.004, hole.cup[1]);
    this.flag.position.set(hole.cup[0], y + greenHeight(hole.cup, hole), hole.cup[1]);
    this.tee.position.set(hole.tee[0], y + 0.003, hole.tee[1]);
    if (index !== this.holeIndex) {
      this.holeIndex = index;
      this.flagLabel.set(`H${index + 1}`, "#e8eaed");
      this.rebuildTerrain(hole);
    }
  }

  private rebuildTerrain(hole: HoleDef) {
    const cfg = this.cfg!;
    const [sx, sz] = hole.slope;
    // 高さだけを変える shear。X/Z のコート境界・球の軌道とマーカー位置を維持する。
    this.terrain.matrix.set(1, 0, 0, 0, sx, 1, sz, 0, 0, 0, 1, 0, 0, 0, 0, 1);
    this.terrain.matrixWorldNeedsUpdate = true;
    this.terrainDetails.traverse(obj => {
      if (obj instanceof THREE.Mesh || obj instanceof THREE.LineSegments) {
        obj.geometry.dispose();
        const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
        materials.forEach(m => m.dispose());
      }
    });
    this.terrainDetails.clear();
    this.terrainDetails.visible = true;
    const y = -cfg.floorDrop;
    // グリッドと下り方向の矢印。半透明の地面でも勾配を読めるようにする。
    const points: THREE.Vector3[] = [];
    for (let i = 1; i < 10; i++) {
      const x = cfg.wallW * (i / 10 - 0.5), z = cfg.floorDepth * i / 10;
      points.push(new THREE.Vector3(x, y + 0.007, 0), new THREE.Vector3(x, y + 0.007, cfg.floorDepth));
      points.push(new THREE.Vector3(-cfg.wallW / 2, y + 0.007, z), new THREE.Vector3(cfg.wallW / 2, y + 0.007, z));
    }
    this.terrainDetails.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color: 0xa8d5ae, transparent: true, opacity: 0.25 })));
    if (sx !== 0) {
      const arrowPoints: THREE.Vector3[] = [];
      const direction = -Math.sign(sx), length = Math.min(0.23, cfg.wallW * 0.16);
      for (const side of [-1, 1]) for (const depth of [0.25, 0.5, 0.75]) {
        const x = side * cfg.wallW * 0.3, z = cfg.floorDepth * depth;
        const tip = new THREE.Vector3(x + direction * length / 2, y + 0.012, z);
        arrowPoints.push(new THREE.Vector3(x - direction * length / 2, y + 0.012, z), tip);
        for (const dz of [-1, 1]) arrowPoints.push(tip, new THREE.Vector3(tip.x - direction * length * 0.3, y + 0.012, z + dz * length * 0.25));
      }
      this.terrainDetails.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(arrowPoints), new THREE.LineBasicMaterial({ color: 0xfdd663 })));
    }
    for (const obstacle of hole.obstacles) {
      const block = new THREE.Mesh(new THREE.CylinderGeometry(obstacle.radius, obstacle.radius, obstacle.height, 48), new THREE.MeshStandardMaterial({ color: 0xe5a34b, roughness: 0.8 }));
      block.position.set(obstacle.center[0], y + obstacle.height / 2, obstacle.center[1]);
      this.terrainDetails.add(block);
      const rim = new THREE.Mesh(new THREE.RingGeometry(obstacle.radius * 0.84, obstacle.radius, 48), new THREE.MeshBasicMaterial({ color: 0xffdf94, side: THREE.DoubleSide }));
      rim.rotation.x = -Math.PI / 2;
      rim.position.set(obstacle.center[0], y + obstacle.height + 0.001, obstacle.center[1]);
      this.terrainDetails.add(rim);
    }
  }

  /** ボールの位置と色（居なくなった人のボールは消す） */
  setBalls(states: readonly BallState[], _now: number) {
    if (!this.cfg) return;
    const y = -this.cfg.floorDrop;
    const seen = new Set<string>();
    for (const s of states) {
      seen.add(s.id);
      let b = this.balls.get(s.id);
      if (!b) {
        const mesh = new THREE.Mesh(this.ballGeometry, new THREE.MeshStandardMaterial({ color: s.color, roughness: 0.35 }));
        const shadow = new THREE.Mesh(this.shadowGeometry, new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.3 }));
        shadow.rotation.x = -Math.PI / 2;
        this.group.add(mesh);
        this.terrain.add(shadow);
        b = { mesh, shadow };
        this.balls.set(s.id, b);
      }
      b.mesh.material.color.setHex(s.color);
      b.mesh.visible = !s.sunk;
      b.shadow.visible = !s.sunk;
      b.mesh.position.set(s.pos[0], y + greenHeight(s.pos, this.hole) + BALL_R, s.pos[1]);
      b.shadow.position.set(s.pos[0], y + 0.005, s.pos[1]);
    }
    for (const [id, b] of this.balls) {
      if (seen.has(id)) continue;
      b.mesh.removeFromParent();
      b.shadow.removeFromParent();
      b.mesh.material.dispose();
      b.shadow.material.dispose();
      this.balls.delete(id);
    }
  }

  /** 狙い線: from（ボール）から dir へ 1m。fixed = 構えで固定した狙い（実線寄りの白）、そうでなければ正面（薄く） */
  setAim(from: V2 | null, dir: V2 | null, fixed: boolean, color: number) {
    if (!this.cfg || !from || !dir) {
      this.aim.visible = this.aimHead.visible = false;
      return;
    }
    const y = -this.cfg.floorDrop + 0.01;
    const len = AIM_LEN;
    this.aim.visible = this.aimHead.visible = true;
    this.aim.position.set(from[0], y, from[1]);
    this.aim.rotation.y = Math.atan2(-dir[1], dir[0]); // ローカル +X を dir に
    this.aim.material.color.setHex(fixed ? color : 0xffffff);
    this.aim.material.opacity = fixed ? 1 : 0.5;
    this.aimHead.position.set(from[0] + dir[0] * len, y, from[1] + dir[1] * len);
    // 円錐の +Y を dir に向ける
    this.aimHead.quaternion.setFromUnitVectors(UP, tmpDir.set(dir[0], 0, dir[1]).normalize());
    this.aimHead.material.color.setHex(fixed ? color : 0xffffff);
  }

  /**
   * 振り子パター: ボールの真上 armM を支点に、狙いの向きの鉛直面内で angleDeg だけ振る（+ がバックスイング = 狙いの逆側）。
   * 支点は少しだけ手前（狙いの逆側）に寄せ、角度 0 でヘッドがボールの手前に来るようにする
   */
  setPutter(ball: V2 | null, dir: V2 | null, angleDeg: number, color: number) {
    if (!this.cfg || !ball || !dir) {
      this.putter.visible = false;
      return;
    }
    const y = -this.cfg.floorDrop + greenHeight(ball, this.hole);
    this.putter.visible = true;
    const back = 0.03;
    this.putter.position.set(ball[0] - dir[0] * back, y + this.opts.armM + 0.01, ball[1] - dir[1] * back);
    // ローカル +X を dir に向ける yaw と、ローカル Z まわりの振り（-θ でヘッドが -X = 狙いの逆側へ）
    const yaw = Math.atan2(-dir[1], dir[0]);
    this.putter.rotation.set(0, yaw, -THREE.MathUtils.degToRad(angleDeg));
    this.putterHead.material.color.setHex(color);
  }

  setGaze(p: V2 | null) {
    if (!this.cfg || !p) {
      this.gazeCursor.visible = false;
      return;
    }
    this.gazeCursor.visible = true;
    this.gazeCursor.position.set(p[0], -this.cfg.floorDrop + 0.006, p[1]);
  }
}
