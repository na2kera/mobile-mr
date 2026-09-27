// 化身 1 体の描画部品（モデル + 足元のオーラの柱 + 腰の渦）。「自分用（主観）」と「他人用（俯瞰画面・段階 2 の相手）」の両方で使う。
//   - 自分用: 腰の切断面を支点に前傾（?selfLean=）し、目から ?nearFade= m 以内を消す。見上げフェードは呼び出し側が fade で渡す
//   - 他人用: 前傾なし。受信側の「信用できるか」による薄さは呼び出し側が fade で渡す
// 配置の数学は keshin-math.ts（純粋関数・テスト済み）のモデル行列とクリッピング平面をそのまま使う。
// group は親（シーン or マーカー座標系のアンカー）の座標で置く。head / yaw も親の座標系で渡す
import * as THREE from "three";
import type { KeshinVisual } from "../../src/shared/keshin-timeline";
import { autoBack, keshinCutPlane, keshinModelMatrix, keshinScale, selfAutoBack } from "./keshin-math";
import type { KeshinFrameInput, V3 } from "./keshin-math";
import { createKeshinInstance, fallbackKeshin } from "./keshin-assets";
import type { KeshinInstance, KeshinSpec, LoadedKeshin } from "./keshin-assets";
import { WorldAura } from "./keshin-aura";
import { attachEyeViewport, createOwnerUniforms } from "./keshin-occlusion";
import type { MaskBinding, MaskUniforms } from "./keshin-occlusion";

export type KeshinViewOptions = {
  mode: "self" | "other";
  /** 表示高さ [m]（?keshinH=） */
  heightM: number;
  /** 頭から推定の床まで [m]（?eyeH=） */
  eyeH: number;
  /** 背中からの距離の上書き [m]（?keshinBack=。null = 上半身の前面から自動） */
  backOverride: number | null;
  /** 主観の前傾 [deg]（?selfLean=） */
  leanDeg: number;
  /** 主観の前後の上書き [m]（?selfBack=。null = 顔が頭上のやや前に来る自動値） */
  selfBackOverride: number | null;
  /** 主観の自動値で、化身の顔を本人の目よりどれだけ前に置くか [m] */
  faceAheadM: number;
  /** 既定の不透明度（体。発光部分は 1 のまま） */
  opacity: number;
  /** オーラの粒子数（?auraN=） */
  auraN: number;
  /** 主観で目から消す距離 [m]（[消える, 見え始める]。他人用は null） */
  nearFade: [number, number] | null;
  /** カメラに写った人の形で隠す（他人用をスマホに描くとき。段階 2）。null = 隠さない（自分用・俯瞰画面） */
  mask?: MaskUniforms | null;
};

export type KeshinUpdate = {
  /** 本人の頭の位置（親の座標系） */
  head: V3;
  /** 体の向き（keshin-math.ts の yawOfForward。親の座標系） */
  yaw: number;
  visual: KeshinVisual;
  /** 追加の不透明度の係数（主観の見上げフェード / 受信側の信用度） */
  fade: number;
  /** オーラを出すか（主観で化身は見えなくてもオーラは出す。受信側の none では出さない） */
  aura: boolean;
  /** 揺らめきの時刻 [s] */
  timeSec: number;
  /** 目の中心のワールド位置（主観の near フェード用） */
  eyeWorld?: THREE.Vector3;
  /** 粒子の大きさの換算に使う片目のビューポートの高さ [px] */
  viewportH: number;
};

const tmpPoint = new THREE.Vector3();
const tmpNormal = new THREE.Vector3();
const tmpMat = new THREE.Matrix4();
const tmpNormalMat = new THREE.Matrix3();

export class KeshinView {
  readonly group = new THREE.Group();
  readonly spec: KeshinSpec;
  private readonly opts: KeshinViewOptions;
  /** モデル行列を入れる入れ物（matrixAutoUpdate = false） */
  private readonly holder = new THREE.Group();
  private readonly aura: WorldAura;
  private loaded: LoadedKeshin;
  private instance: KeshinInstance;
  /** 直近の配置（診断・テスト用） */
  lastFrame: KeshinFrameInput | null = null;
  /** 直近に化身（モデル）を描いたか */
  modelVisible = false;
  /** 直近の体の不透明度（診断用） */
  lastOpacity = 0;
  /** 直近の発光部分の不透明度 */
  private lastOwn = 0;

  /** 人の形で隠すときの uniform（全員で共有するマスク + この化身の持ち主の頭）。隠さないなら null */
  private readonly maskBinding: MaskBinding | null;

  constructor(spec: KeshinSpec, opts: KeshinViewOptions, loaded: LoadedKeshin | null = null) {
    this.spec = spec;
    this.maskBinding = opts.mask ? { shared: opts.mask, owner: createOwnerUniforms() } : null;
    // 主観の見え方（前傾・前後）は確認用に後から変えられるよう、自分の写しを持つ
    this.opts = { ...opts };
    this.loaded = loaded ?? fallbackKeshin(spec);
    this.instance = this.createInstance(this.loaded);
    this.holder.matrixAutoUpdate = false;
    this.holder.add(this.instance.root);
    this.aura = new WorldAura(opts.auraN, spec.auraColors, this.maskBinding);
    if (this.maskBinding) attachEyeViewport(this.aura.points, this.maskBinding.shared);
    if (opts.nearFade) {
      // 主観: 目のすぐ近くの粒は消し、渦（自分の頭のまわり）は出さず、柱は肩の高さまで（正面の視界の中心に粒を入れない。
      // 下を見ると体のまわりから立ち上る粒が見える）
      this.aura.uniforms.uNear.value.set(0.2, 0.45);
      this.aura.uniforms.uSwirlK.value = 0;
      this.aura.uniforms.uColumnMaxH.value = opts.eyeH - 0.3;
    }
    this.group.add(this.holder, this.aura.points);
    this.holder.visible = false;
    this.aura.points.visible = false;
  }

  private createInstance(loaded: LoadedKeshin): KeshinInstance {
    const inst = createKeshinInstance(loaded, this.opts.nearFade, this.opts.mode === "self" && this.spec.selfHideFx, this.maskBinding);
    // 人の形で隠すときは、眼ごとのビューポートを描く直前に uniform へ入れる（深度の前描画の複製も含めて）
    if (this.maskBinding) attachEyeViewport(inst.root, this.maskBinding.shared);
    return inst;
  }

  /** 足元・腰のオーラを描いているか（出現の最初と消える終わりはモデルが見えずオーラだけの時間がある） */
  get auraVisible(): boolean {
    return this.aura.points.visible;
  }

  /** 確認用: モデルかオーラだけを一時的に隠す（fn の間だけ） */
  withHidden<T>(part: "model" | "aura", fn: () => T): T {
    const o = part === "model" ? this.holder : this.aura.points;
    const was = o.visible;
    o.visible = false;
    try {
      return fn();
    } finally {
      o.visible = was;
    }
  }

  get isFallback(): boolean {
    return this.loaded.fallback;
  }
  get model(): LoadedKeshin {
    return this.loaded;
  }

  /** 読み込み終わった本物のモデルに差し替える（それまでは代わりの人型） */
  setModel(loaded: LoadedKeshin) {
    if (loaded === this.loaded) return;
    this.holder.remove(this.instance.root);
    this.instance.dispose();
    this.disposeFallback();
    this.loaded = loaded;
    this.warmPending = "model";
    this.instance = this.createInstance(loaded);
    this.holder.add(this.instance.root);
  }

  /** 主観の見え方を変える（比較用のコンタクトシート scripts/sweep-keshin-self.mjs から使う。backM = null は自動） */
  setSelfTuning(t: { leanDeg: number; faceAheadM: number; backM: number | null }) {
    this.opts.leanDeg = t.leanDeg;
    this.opts.faceAheadM = t.faceAheadM;
    this.opts.selfBackOverride = t.backM;
  }

  /** いまの主観の見え方（HUD・ログ用） */
  selfTuning(): { leanDeg: number; faceAheadM: number; backM: number | null } {
    return { leanDeg: this.opts.leanDeg, faceAheadM: this.opts.faceAheadM, backM: this.opts.selfBackOverride };
  }

  /**
   * シェーダーの先行コンパイルを待っているか（"fallback" / "model"。null = 済み）。描画ループが見て、本描画の直前に
   * forceVisible の中で**キャンバスへ実際の設定のまま 1 回描く**（直後の本描画が autoClear で消す）。
   * 1×1 のレンダーターゲットへ描くと出力の色空間が Linear になってキャンバス用（sRGB）と別のプログラムになり、
   * renderer.compile はマテリアルごとのクリッピングの状態を設定しないので平面の数が違うプログラムになる
   * （どちらも初めて見上げたときに作り直しが走っていた。レビュー 2 回目の実測）
   */
  warmPending: "fallback" | "model" | null = "fallback";

  /**
   * fn の間だけ化身（モデル・深度の前描画・足元のオーラ）を表示して描けるようにする。表示状態と不透明度は例外が出ても必ず戻す
   */
  forceVisible<T>(fn: () => T): T {
    const wasHolder = this.holder.visible;
    const wasGroup = this.group.visible;
    const wasAura = this.aura.points.visible;
    try {
      this.holder.visible = true;
      this.group.visible = true;
      this.aura.points.visible = true;
      this.instance.setOpacity(0.5, 0.5);
      return fn();
    } finally {
      this.holder.visible = wasHolder;
      this.group.visible = wasGroup;
      this.aura.points.visible = wasAura;
      this.instance.setOpacity(this.lastOpacity, this.lastOwn);
    }
  }

  /**
   * 描いている部分（下半身・隠した演出を除く、腰の平面より上）の頂点のうち、eye から dist [m] 以内にあるものの割合（比較用）。
   * 画素で数えると目のすぐ前の部分が画面を大きく覆うので欠けた割合が大きく出る。こちらはモデルのどれだけが消えているか
   */
  nearVertexFraction(eye: THREE.Vector3, dist: number): number {
    this.group.updateWorldMatrix(true, true);
    const v = new THREE.Vector3();
    let near = 0;
    let total = 0;
    this.instance.root.traverseVisible((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || mesh.userData.ghostDepth) return;
      const pos = mesh.geometry.getAttribute("position");
      if (!pos) return;
      for (let i = 0; i < pos.count; i += 2) {
        mesh.getVertexPosition(i, v);
        v.applyMatrix4(mesh.matrixWorld);
        if (this.instance.plane.distanceToPoint(v) < 0) continue;
        total++;
        if (v.distanceTo(eye) < dist) near++;
      }
    });
    return total > 0 ? near / total : 0;
  }

  /** 実際に描いているモデルの原点（ワールド）と正面 +Z の向き（ワールド、水平成分を正規化）。ヘッドレス確認用 */
  debugWorld(): { origin: [number, number, number]; front: [number, number] } {
    this.holder.updateWorldMatrix(true, false);
    const o = new THREE.Vector3().setFromMatrixPosition(this.holder.matrixWorld);
    const z = new THREE.Vector3(0, 0, 1).transformDirection(this.holder.matrixWorld);
    const len = Math.hypot(z.x, z.z) || 1;
    return { origin: [o.x, o.y, o.z], front: [z.x / len, z.z / len] };
  }

  /** 化身の原点を頭の真下からどれだけ後ろに置くか [m]（主観は前傾の自動値） */
  back(): number {
    const scale = keshinScale(this.opts.heightM);
    if (this.opts.mode === "self") {
      if (this.opts.selfBackOverride !== null) return this.opts.selfBackOverride;
      return selfAutoBack(this.loaded.head, this.loaded.spec.cutY, scale, this.opts.leanDeg, this.opts.faceAheadM);
    }
    return this.opts.backOverride ?? autoBack(this.loaded.frontZ, scale);
  }

  update(u: KeshinUpdate) {
    const { visual } = u;
    const scale = keshinScale(this.opts.heightM);
    const back = this.back();
    const frame: KeshinFrameInput = {
      head: u.head,
      yaw: u.yaw,
      eyeH: this.opts.eyeH,
      back,
      cutY: this.loaded.spec.cutY,
      scale,
      riseM: visual.riseM,
      leanDeg: this.opts.mode === "self" ? this.opts.leanDeg : 0,
    };
    this.lastFrame = frame;
    // 人の形の前後の判定に使う持ち主の頭（ワールド。親がシーンでもアンカーでも）
    if (this.maskBinding) {
      this.group.updateWorldMatrix(true, false);
      this.maskBinding.owner.uOwnerHead.value.set(u.head[0], u.head[1], u.head[2]).applyMatrix4(this.group.matrixWorld);
    }
    // オーラ（柱 + 渦）: 本人の足元・体の向きの枠
    const auraOn = u.aura && !visual.hidden && visual.auraK > 0.001;
    this.aura.points.visible = auraOn;
    if (auraOn) {
      const au = this.aura.uniforms;
      au.uTime.value = u.timeSec;
      au.uAuraK.value = visual.auraK;
      au.uPillarK.value = visual.pillarK;
      au.uBurstK.value = visual.burstK;
      const cutW = this.loaded.spec.cutY * scale;
      au.uColumnH.value = cutW;
      au.uColumnR.value = 0.45;
      au.uSwirlC.value.set(0, cutW, -back);
      au.uSwirlR.value = 0.55 * scale * 1.6;
      au.uViewportH.value = u.viewportH;
      if (u.eyeWorld) au.uEye.value.copy(u.eyeWorld);
      const floor: V3 = [u.head[0], u.head[1] - this.opts.eyeH, u.head[2]];
      this.aura.points.matrix.makeRotationY(u.yaw).setPosition(floor[0], floor[1], floor[2]);
      this.aura.points.matrixWorldNeedsUpdate = true;
    }
    // モデル
    const body = this.opts.opacity * visual.opacityK * u.fade;
    const own = visual.opacityK * u.fade;
    this.lastOpacity = body;
    this.lastOwn = own;
    this.modelVisible = !visual.hidden && own > 0.004;
    this.holder.visible = this.modelVisible;
    if (!this.modelVisible) return;
    this.holder.matrix.fromArray(keshinModelMatrix(frame));
    this.holder.matrixWorldNeedsUpdate = true;
    this.instance.setPose(visual.poseK);
    this.instance.setOpacity(body, own);
    // クリッピング平面は親の座標で出してワールドへ（親がアンカーでも正しい。法線は法線行列で）
    const cut = keshinCutPlane(frame);
    this.group.updateWorldMatrix(true, false);
    tmpMat.copy(this.group.matrixWorld);
    tmpPoint.set(...cut.point).applyMatrix4(tmpMat);
    tmpNormal.set(...cut.normal).applyMatrix3(tmpNormalMat.getNormalMatrix(tmpMat)).normalize();
    this.instance.plane.setFromNormalAndCoplanarPoint(tmpNormal, tmpPoint);
    if (this.instance.nearUniforms && u.eyeWorld) this.instance.nearUniforms.uKeshinEye.value.copy(u.eyeWorld);
  }

  /** 目から消す距離を変える（自分用だけ。ヘッドレス確認で「消している」ことを比べる用） */
  setNearFade(near: [number, number]) {
    this.instance.nearUniforms?.uKeshinNear.value.set(near[0], near[1]);
  }

  hide() {
    this.holder.visible = false;
    this.aura.points.visible = false;
    this.modelVisible = false;
  }

  dispose() {
    this.group.removeFromParent();
    this.instance.dispose();
    this.disposeFallback();
    this.aura.dispose();
  }

  /**
   * 代わりの人型はビューごとに作ったもの（fallbackKeshin）なので、形状とマテリアルを解放する。
   * 本物のモデルのテンプレートは他のビューと共有しているので解放しない
   */
  private disposeFallback() {
    if (!this.loaded.fallback) return;
    this.loaded.template.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.dispose();
      for (const m of ([] as THREE.Material[]).concat(mesh.material)) m.dispose();
    });
  }
}
