// ゴッドハンドの見た目。参考画像（イナズマイレブンの必殺技）の再現が目標:
//   - カクカクした厚みのある金色の手（面取りなしの角ばった板の組み合わせ）
//   - 指は大きく開き、第二関節で前へ曲がる。親指は横へ
//   - 本体は明るい黄色に発光し、輪郭にオレンジのオーラ（少し大きい殻を裏面描画）
//   - 周りに稲妻（ジグザグの細い棒。数十 ms ごとに形を作り直す）
// 破られたときはオーラが砕け散る（金色の破片が飛び散って消える）
import * as THREE from "three";

/** 手のひらの中心が原点。指は +Y、手のひらの法線は +Z（出すときに向きは呼び出し側が決める） */
export const GOD_HAND_HEIGHT = 1.7;

const CORE_COLOR = 0xffe14d;
const EMISSIVE_COLOR = 0xffc21a;
const AURA_COLOR = 0xff9a00;
const BOLT_COLOR = 0xffe36e;

export type GodHand = {
  group: THREE.Group;
  /** 稲妻の形の作り直しと出現アニメ。毎フレーム呼ぶ。sinceMs = 実体化からの経過 [ms] */
  update(now: number, sinceMs: number): void;
  dispose(): void;
};

export function createGodHand(): GodHand {
  const group = new THREE.Group();
  const coreMat = new THREE.MeshStandardMaterial({
    color: CORE_COLOR,
    emissive: EMISSIVE_COLOR,
    emissiveIntensity: 1.05,
    roughness: 0.55,
    metalness: 0.1,
    transparent: true,
    opacity: 0.96,
  });
  // 輪郭のオーラ: 同じ箱を少し膨らませて裏面だけ加算描画（角ばったシルエットが光って見える）
  const auraMat = new THREE.MeshBasicMaterial({
    color: AURA_COLOR,
    transparent: true,
    opacity: 0.4,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const geometries: THREE.BufferGeometry[] = [];

  /** 角ばった板を 1 枚置く（本体 + オーラ殻） */
  function slab(parent: THREE.Object3D, w: number, h: number, d: number, pos: [number, number, number], rot: [number, number, number] = [0, 0, 0]): THREE.Object3D {
    const geo = new THREE.BoxGeometry(w, h, d);
    geometries.push(geo);
    const holder = new THREE.Group();
    holder.position.set(...pos);
    holder.rotation.set(...rot);
    const core = new THREE.Mesh(geo, coreMat);
    holder.add(core);
    const aura = new THREE.Mesh(geo, auraMat);
    aura.scale.setScalar(1.14);
    aura.renderOrder = 5;
    holder.add(aura);
    parent.add(holder);
    return holder;
  }

  // ---- 手のひら（大きな板を少し重ねて角ばった掌に） ----
  const palm = new THREE.Group();
  slab(palm, 0.78, 0.8, 0.24, [0, 0, 0]);
  slab(palm, 0.66, 0.34, 0.24, [0.03, -0.5, 0.02], [0, 0, -0.12]); // 手首側
  group.add(palm);

  // ---- 指 4 本（根元 + 前へ曲がる先端の 2 枚）。大きく開く ----
  const fingers: { x: number; splay: number; len1: number; len2: number; w: number }[] = [
    { x: -0.3, splay: 0.5, len1: 0.52, len2: 0.42, w: 0.19 }, // 人差し指（画像では大きく外へ）
    { x: -0.1, splay: 0.16, len1: 0.6, len2: 0.48, w: 0.2 }, // 中指
    { x: 0.1, splay: -0.1, len1: 0.56, len2: 0.44, w: 0.2 }, // 薬指
    { x: 0.28, splay: -0.38, len1: 0.46, len2: 0.36, w: 0.18 }, // 小指
  ];
  for (const f of fingers) {
    const root = new THREE.Group();
    root.position.set(f.x, 0.38, 0);
    root.rotation.z = f.splay;
    group.add(root);
    slab(root, f.w, f.len1, 0.2, [0, f.len1 / 2, 0]);
    // 第二関節から前（+Z 側 = 手のひらの向く方）へ曲げる
    const tip = new THREE.Group();
    tip.position.set(0, f.len1 - 0.02, 0);
    tip.rotation.x = 0.55;
    root.add(tip);
    slab(tip, f.w * 0.94, f.len2, 0.19, [0, f.len2 / 2, 0]);
  }
  // ---- 親指（横へ突き出して前へ曲がる） ----
  {
    const root = new THREE.Group();
    root.position.set(-0.42, -0.05, 0);
    root.rotation.z = 1.15;
    group.add(root);
    slab(root, 0.2, 0.4, 0.2, [0, 0.2, 0]);
    const tip = new THREE.Group();
    tip.position.set(0, 0.37, 0);
    tip.rotation.x = 0.5;
    root.add(tip);
    slab(tip, 0.18, 0.3, 0.19, [0, 0.15, 0]);
  }

  // ---- 稲妻（ジグザグの細い棒の連なり。低頻度で形を作り直す） ----
  const boltMat = new THREE.MeshBasicMaterial({
    color: BOLT_COLOR,
    transparent: true,
    opacity: 0.9,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const boltGeo = new THREE.BoxGeometry(1, 1, 1);
  geometries.push(boltGeo);
  const BOLTS = 2;
  const SEGS = 9;
  const boltSegs: THREE.Mesh[] = [];
  const boltsGroup = new THREE.Group();
  group.add(boltsGroup);
  for (let i = 0; i < BOLTS * SEGS; i++) {
    const m = new THREE.Mesh(boltGeo, boltMat);
    m.renderOrder = 6;
    boltsGroup.add(m);
    boltSegs.push(m);
  }
  // ---- 後光（参考画像の、手の後ろで放射状に光る halo。カメラに正対する Sprite で近似） ----
  function createHaloTexture(): THREE.CanvasTexture {
    const c = document.createElement("canvas");
    c.width = c.height = 256;
    const ctx = c.getContext("2d")!;
    const g = ctx.createRadialGradient(128, 128, 10, 128, 128, 128);
    g.addColorStop(0, "rgba(255, 250, 210, 0.95)");
    g.addColorStop(0.35, "rgba(255, 220, 90, 0.55)");
    g.addColorStop(0.7, "rgba(255, 170, 30, 0.22)");
    g.addColorStop(1, "rgba(255, 150, 0, 0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 256);
    // 放射状の細い光線
    ctx.strokeStyle = "rgba(255, 235, 150, 0.35)";
    ctx.lineWidth = 3;
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2 + 0.2;
      ctx.beginPath();
      ctx.moveTo(128 + Math.cos(a) * 30, 128 + Math.sin(a) * 30);
      ctx.lineTo(128 + Math.cos(a) * 126, 128 + Math.sin(a) * 126);
      ctx.stroke();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }
  const haloTex = createHaloTexture();
  const haloMat = new THREE.SpriteMaterial({
    map: haloTex,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    opacity: 0.9,
  });
  const halo = new THREE.Sprite(haloMat);
  halo.scale.setScalar(3.4);
  halo.position.set(0, 0.15, 0);
  halo.renderOrder = 4;
  group.add(halo);

  const tmpA = new THREE.Vector3();
  const tmpB = new THREE.Vector3();
  const tmpC = new THREE.Vector3();
  let lastBoltMs = -Infinity;
  function rebuildBolts() {
    for (let b = 0; b < BOLTS; b++) {
      // 手の縁のどこかから外へ向かってジグザグ
      // 手の縁に沿って走ってから外へ抜ける（参考画像の、手の輪郭をなぞる稲妻）
      const a0 = Math.random() * Math.PI * 2;
      let r = 0.75 + Math.random() * 0.15;
      let ang = a0;
      tmpA.set(Math.cos(a0) * r, Math.sin(a0) * r + 0.15, 0.06);
      for (let s = 0; s < SEGS; s++) {
        // 前半は縁に沿う（半径ほぼ一定で角度を進める）、後半は外へ
        if (s < SEGS / 2) {
          ang += 0.35 + Math.random() * 0.25;
          r += (Math.random() - 0.5) * 0.1;
        } else {
          ang += (Math.random() - 0.5) * 0.5;
          r += 0.16 + Math.random() * 0.1;
        }
        tmpB.set(Math.cos(ang) * r, Math.sin(ang) * r + 0.15, 0.06 + (Math.random() - 0.5) * 0.08);
        const m = boltSegs[b * SEGS + s];
        m.position.copy(tmpA).add(tmpB).multiplyScalar(0.5);
        m.scale.set(0.04, tmpA.distanceTo(tmpB), 0.04);
        m.lookAt(tmpC.copy(tmpB).add(m.position).sub(tmpA));
        m.rotateX(Math.PI / 2);
        tmpA.copy(tmpB);
      }
    }
  }
  rebuildBolts();

  function update(now: number, sinceMs: number) {
    // 出現: 0.18 秒で 0.2 → 1.05 → 1.0（勢いよく実体化）
    const t = sinceMs / 180;
    const scale = t >= 1.4 ? 1 : t >= 1 ? 1.05 - 0.05 * ((t - 1) / 0.4) : 0.2 + 0.85 * t;
    group.scale.setScalar(Math.max(0.01, scale));
    // 発光の揺らぎ
    coreMat.emissiveIntensity = 0.95 + 0.3 * Math.sin(now / 90);
    // 後光: 実体化の瞬間に強く光ってから柔らかく残る（アニメの発動バースト）
    haloMat.opacity = 0.85 * Math.exp(-sinceMs / 420) + 0.3 + 0.06 * Math.sin(now / 70);
    halo.scale.setScalar(3.4 * (1 - 0.25 * Math.exp(-sinceMs / 300)));
    halo.material.rotation = now / 4000;
    boltMat.opacity = 0.55 + 0.35 * Math.abs(Math.sin(now / 60));
    if (now - lastBoltMs > 80) {
      lastBoltMs = now;
      rebuildBolts();
    }
  }

  function dispose() {
    group.removeFromParent();
    for (const g of geometries) g.dispose();
    coreMat.dispose();
    auraMat.dispose();
    boltMat.dispose();
    haloMat.dispose();
    haloTex.dispose();
  }

  return { group, update, dispose };
}

// ---- 砕け散り（破られた / 消えるときのオーラの破片） ----
export type Shatter = {
  group: THREE.Group;
  /** false を返したら終わり（呼び出し側が dispose する） */
  update(dtSec: number): boolean;
  dispose(): void;
};

export function createShatter(center: THREE.Vector3): Shatter {
  const group = new THREE.Group();
  group.position.copy(center);
  const mat = new THREE.MeshBasicMaterial({
    color: CORE_COLOR,
    transparent: true,
    opacity: 0.95,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const pieces: { mesh: THREE.Mesh; vel: THREE.Vector3; spin: THREE.Vector3 }[] = [];
  for (let i = 0; i < 36; i++) {
    const mesh = new THREE.Mesh(geo, mat);
    const s = 0.05 + Math.random() * 0.11;
    mesh.scale.set(s, s * (0.5 + Math.random()), s * 0.5);
    mesh.position.set((Math.random() - 0.5) * 1.2, (Math.random() - 0.5) * 1.4, (Math.random() - 0.5) * 0.3);
    const dir = mesh.position.clone().normalize();
    pieces.push({
      mesh,
      vel: dir.multiplyScalar(2.5 + Math.random() * 2.5).add(new THREE.Vector3(0, 1, 0)),
      spin: new THREE.Vector3(Math.random() * 8, Math.random() * 8, Math.random() * 8),
    });
    group.add(mesh);
  }
  let life = 0.9;
  function update(dtSec: number): boolean {
    const dt = Math.min(0.05, dtSec);
    life -= dt;
    if (life <= 0) return false;
    mat.opacity = Math.max(0, life / 0.9);
    for (const p of pieces) {
      p.vel.y -= 6 * dt;
      p.mesh.position.addScaledVector(p.vel, dt);
      p.mesh.rotation.x += p.spin.x * dt;
      p.mesh.rotation.y += p.spin.y * dt;
      p.mesh.rotation.z += p.spin.z * dt;
    }
    return true;
  }
  function dispose() {
    group.removeFromParent();
    geo.dispose();
    mat.dispose();
  }
  return { group, update, dispose };
}
