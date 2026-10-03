// 化身 1 体の描画部品（モデル + 背後の炎 + 足元の柱 + 腰の渦）。「自分用（主観）」と「他人用（俯瞰画面・段階 2 の相手）」の両方で使う。
//   - 自分用: 腰の切断面を支点に前傾（?selfLean=）し、目から ?nearFade= m 以内を消す。見上げフェードは呼び出し側が fade で渡す
//   - 他人用: 前傾なし。受信側の「信用できるか」による薄さは呼び出し側が fade で渡す
// 配置の数学は keshin-math.ts（純粋関数・テスト済み）のモデル行列とクリッピング平面をそのまま使う。
// group は親（シーン or マーカー座標系のアンカー）の座標で置く。head / yaw も親の座標系で渡す
import * as THREE from "three";
import type { KeshinVisual } from "../../src/shared/keshin-timeline";
import { autoBack, keshinCutPlane, keshinModelMatrix, keshinScale, resolveKeshinBelow, selfAutoBack, MODEL_HEIGHT_M } from "./keshin-math";
import { AURA_SUSTAIN } from "../../src/shared/keshin-timeline";
import { createDissolveUniforms } from "./keshin-assets";
import type { DissolveUniforms } from "./keshin-assets";
import { BackStream } from "./keshin-stream";
import type { KeshinLook } from "./keshin-look";
import type { KeshinBelow, KeshinFrameInput, V3 } from "./keshin-math";
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
  /** 段階 3 の C: 他人用の「背中からビヨーンと出る」見え方（腰を頭より上・溶ける下端・背中からの光の流れ）。null = 段階 2 までの見え方 */
  look?: KeshinLook | null;
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
  /** 頭から床まで [m] の上書き（鏡モードで足首から床が分かったとき。未指定なら ?eyeH=） */
  eyeH?: number;
};

const tmpPoint = new THREE.Vector3();
const tmpNormal = new THREE.Vector3();
const tmpMat = new THREE.Matrix4();
const tmpNormalMat = new THREE.Matrix3();
const tmpBackDir = new THREE.Vector3();
const tmpBack = new THREE.Vector3();
const tmpWaist = new THREE.Vector3();

/** 主観の炎の半径 [m]（足元の柱 0.45 より少し太いだけ。目から肩の縁まで 0.6m 前後・正面から 29° 下） */
const SELF_FLAME_R = 0.55;
/** 他人用の逆三角形の炎の頂点（化身の切り口）の太さ = 化身を包む太さ（uFlameR）のこの割合 */
const FLAME_APEX_K = 0.25;

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
  /**
   * 直近の炎の形の値（診断・テスト用: 逆三角形か・下端（頂点）の高さ・柱の粒の高さと強さ・腰の高さ・頂点の太さ・包む太さ・頂部の高さ・
   * 持ち主の頭の高さ（床から））
   */
  get flameShape() {
    const au = this.aura.uniforms;
    return {
      v: au.uFlameV.value,
      joinY: au.uJoinY.value,
      columnH: au.uColumnH.value,
      columnK: au.uColumnK.value,
      waistY: au.uSwirlC.value.y,
      columnR: au.uColumnR.value,
      flameR: au.uFlameR.value,
      flameH: au.uFlameH.value,
      eyeH: this.lastFrame?.eyeH ?? null,
    };
  }
  /** 直近の発光部分の不透明度 */
  private lastOwn = 0;

  /** 人の形で隠すときの uniform（全員で共有するマスク + この化身の持ち主の頭）。隠さないなら null */
  private readonly maskBinding: MaskBinding | null;
  /** 段階 3 の C（他人用だけ）: 見え方の設定・腰を溶かす uniform・背中からの光の流れ */
  private readonly look: KeshinLook | null;
  /** 他人用の切り口の下げ幅・溶ける長さ（化身ごとの既定 + URL の上書き）。自分用は null */
  readonly below: KeshinBelow | null;
  private readonly dissolve: DissolveUniforms | null;
  readonly stream: BackStream | null;

  constructor(spec: KeshinSpec, opts: KeshinViewOptions, loaded: LoadedKeshin | null = null) {
    this.spec = spec;
    this.maskBinding = opts.mask ? { shared: opts.mask, owner: createOwnerUniforms() } : null;
    // 主観の見え方（前傾・前後）は確認用に後から変えられるよう、自分の写しを持つ
    this.opts = { ...opts };
    this.look = opts.mode === "other" ? (opts.look ?? null) : null;
    this.below = this.look ? resolveKeshinBelow(spec.below, this.look) : null;
    this.dissolve = this.below && this.below.dissolveM > 0 ? createDissolveUniforms(this.below.dissolveM) : null;
    this.stream = this.look && this.look.streamK > 0 ? new BackStream(spec.auraColors, this.look.streamN, this.maskBinding) : null;
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
      // 炎も肩までで切れる（下を見たときだけ見える）。自分の体と床を塞がないよう薄くし、粒は炎を足す前の明るさのままにする
      this.aura.uniforms.uFlameK.value = 0.5;
      this.aura.uniforms.uInsideFade.value = 0;
      this.aura.uniforms.uParticleK.value = 1;
    }
    this.group.add(this.holder, this.aura.points);
    if (this.stream) {
      this.stream.uniforms.uR0.value = this.look!.streamR0;
      this.stream.uniforms.uR1.value = this.look!.streamR1;
      this.stream.uniforms.uMaskNear.value = this.look!.streamClear;
      this.group.add(this.stream.group);
      if (this.maskBinding) attachEyeViewport(this.stream.group, this.maskBinding.shared);
    }
    this.holder.visible = false;
    this.aura.points.visible = false;
  }

  private createInstance(loaded: LoadedKeshin): KeshinInstance {
    const inst = createKeshinInstance(loaded, this.opts.nearFade, this.opts.mode === "self" && this.spec.selfHideFx, this.maskBinding, this.dissolve);
    // 人の形で隠すときは、眼ごとのビューポートを描く直前に uniform へ入れる（深度の前描画の複製も含めて）
    if (this.maskBinding) attachEyeViewport(inst.root, this.maskBinding.shared);
    return inst;
  }

  /** 足元・腰のオーラを描いているか（出現の最初と消える終わりはモデルが見えずオーラだけの時間がある） */
  get auraVisible(): boolean {
    return this.aura.points.visible;
  }

  /** 確認用: モデルかオーラだけを一時的に隠す（fn の間だけ） */
  withHidden<T>(part: "model" | "aura" | "stream", fn: () => T): T {
    const o = part === "model" ? this.holder : part === "aura" ? this.aura.points : (this.stream?.group ?? new THREE.Group());
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
    const wasStream = this.stream?.group.visible ?? false;
    try {
      this.holder.visible = true;
      this.group.visible = true;
      this.aura.points.visible = true;
      if (this.stream) this.stream.group.visible = true;
      this.instance.setOpacity(0.5, 0.5);
      return fn();
    } finally {
      this.holder.visible = wasHolder;
      this.group.visible = wasGroup;
      this.aura.points.visible = wasAura;
      if (this.stream) this.stream.group.visible = wasStream;
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

  /** 腰の切断面（ワールド。確認用）。化身を描いていなければ null */
  cutPlaneWorld(): { point: THREE.Vector3; normal: THREE.Vector3 } | null {
    if (!this.modelVisible || !this.lastFrame) return null;
    // 切断面の中心（化身の腰の真ん中）。plane.coplanarPoint は原点に一番近い点なので使わない
    const c = keshinCutPlane(this.lastFrame).point;
    this.group.updateWorldMatrix(true, false);
    return { point: new THREE.Vector3(c[0], c[1], c[2]).applyMatrix4(this.group.matrixWorld), normal: this.instance.plane.normal.clone() };
  }

  /** 化身の原点を頭の真下からどれだけ後ろに置くか [m]（主観は前傾の自動値） */
  back(): number {
    const scale = keshinScale(this.opts.heightM);
    if (this.opts.mode === "self") {
      if (this.opts.selfBackOverride !== null) return this.opts.selfBackOverride;
      return selfAutoBack(this.loaded.head, this.loaded.spec.cutY, scale, this.opts.leanDeg, this.opts.faceAheadM);
    }
    return this.opts.backOverride ?? autoBack(this.loaded.frontZ, scale, this.look ? this.look.backClearM : undefined);
  }

  update(u: KeshinUpdate) {
    const { visual } = u;
    const scale = keshinScale(this.opts.heightM);
    const back = this.back();
    const frame: KeshinFrameInput = {
      head: u.head,
      yaw: u.yaw,
      eyeH: u.eyeH ?? this.opts.eyeH,
      back,
      cutY: this.loaded.spec.cutY,
      scale,
      riseM: visual.riseM,
      leanDeg: this.opts.mode === "self" ? this.opts.leanDeg : 0,
      waistAboveHead: this.look ? this.look.waistAboveHeadM : undefined,
      // 他人用だけ: 切り口を支点より下げて体を下まで見せる（主観は支点で切ったまま）
      showBelow: this.below ? this.below.showM : undefined,
    };
    const eyeH = u.eyeH ?? this.opts.eyeH;
    this.lastFrame = frame;
    // 人の形の前後の判定に使う持ち主の頭（ワールド。親がシーンでもアンカーでも）
    if (this.maskBinding) {
      this.group.updateWorldMatrix(true, false);
      this.maskBinding.owner.uOwnerHead.value.set(u.head[0], u.head[1], u.head[2]).applyMatrix4(this.group.matrixWorld);
    }
    // オーラ（柱 + 渦）: 本人の足元・体の向きの枠。他人用は受信側の薄さ（信用度・鏡の見失い）をオーラにも掛ける
    // （自分用の fade は見上げフェード = 化身を見せるかどうかなので、足元のオーラには掛けない）
    const auraFade = this.opts.mode === "other" ? Math.max(0, u.fade) : 1;
    const auraOn = u.aura && !visual.hidden && visual.auraK * auraFade > 0.001;
    this.aura.points.visible = auraOn;
    if (auraOn) {
      const au = this.aura.uniforms;
      au.uTime.value = u.timeSec;
      au.uAuraK.value = visual.auraK * auraFade;
      au.uPillarK.value = visual.pillarK;
      au.uBurstK.value = visual.burstK;
      // 腰の高さ（床から）。段階 3 の C では頭より waistAboveHeadM 上。柱の粒は床から背中まで（他人用は既定 0 = 出さない）
      const cutH = this.look ? eyeH + this.look.waistAboveHeadM : this.loaded.spec.cutY * scale;
      au.uColumnH.value = this.look ? Math.max(0.3, eyeH - 0.35) : cutH;
      au.uColumnK.value = this.look ? this.look.footAuraK : 1;
      // 炎は化身の頭上を越えて吹き上がる（頂部の 3 割ほどは炎の舌にちぎれる）。太さは腕や翼を広げた化身が収まる幅
      au.uFlameH.value = (cutH + (MODEL_HEIGHT_M - this.loaded.spec.cutY) * scale) * 1.3;
      // 主観は体に沿う細い柱のまま（太くすると、正面を向いたとき肩の高さの縁が視界の中心に入る。check:keshin の「各眼の中心 50% はほぼ空」）
      au.uFlameR.value = this.opts.mode === "self" ? SELF_FLAME_R : Math.max(1.0, scale * 2.3);
      if (this.look) {
        // 他人用は逆三角形: 化身の切り口（支点 − showM。体が見え始める高さ）を頂点に、上へ直線的に広がる。床から切り口まで
        // （人のまわり）には炎を置かない（人の形で隠すと人型の穴になって見えたため）。頂点の太さは化身を包む太さの 1/4
        au.uFlameV.value = 1;
        au.uJoinY.value = cutH - (this.below?.showM ?? 0);
        au.uColumnR.value = au.uFlameR.value * FLAME_APEX_K;
      } else {
        // 主観（と ?look=0）は床から立ち上る柱: 足元は細く、0.2m から化身の腰へ向けて広げる
        au.uFlameV.value = 0;
        au.uJoinY.value = 0.2;
        au.uColumnR.value = 0.45;
      }
      au.uSwirlC.value.set(0, cutH, -back);
      au.uSwirlR.value = 0.55 * scale * 1.6;
      au.uViewportH.value = u.viewportH;
      if (u.eyeWorld) au.uEye.value.copy(u.eyeWorld);
      const floor: V3 = [u.head[0], u.head[1] - eyeH, u.head[2]];
      this.aura.points.matrix.makeRotationY(u.yaw).setPosition(floor[0], floor[1], floor[2]);
      this.aura.points.matrixWorldNeedsUpdate = true;
    }
    // 段階 3 の C: 背中（頭の 0.35m 下・少し後ろ）から化身の腰へ立ち上る光の流れ。出現の最初に伸び、その先で化身がせり上がる
    if (this.stream) {
      const k = visual.hidden || !u.aura ? 0 : Math.min(1, visual.auraK / AURA_SUSTAIN) * auraFade * this.look!.streamK;
      this.stream.group.visible = k > 0.002;
      if (this.stream.group.visible) {
        const su = this.stream.uniforms;
        su.uK.value = k;
        const g = Math.min(1, Math.max(0, visual.u / 0.45));
        su.uGrow.value = g * g * (3 - 2 * g);
        su.uTime.value = u.timeSec;
        su.uViewportH.value = u.viewportH;
        tmpBackDir.set(-Math.sin(u.yaw), 0, -Math.cos(u.yaw));
        tmpBack.set(u.head[0], u.head[1] - 0.35, u.head[2]).addScaledVector(tmpBackDir, 0.12);
        // 流れの終点は腰の支点（切り口を下げても支点のまま。溶けた体の中へ流れ込む）
        const cut = keshinCutPlane({ ...frame, showBelow: 0 });
        tmpWaist.set(cut.point[0], cut.point[1], cut.point[2]);
        this.stream.setCurve(tmpBack, tmpWaist, tmpBackDir);
      }
    }
    if (this.dissolve) this.dissolve.uDissolveTime.value = u.timeSec;
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
    if (this.dissolve) this.dissolve.uDissolvePlane.value.set(this.instance.plane.normal.x, this.instance.plane.normal.y, this.instance.plane.normal.z, this.instance.plane.constant);
    if (this.instance.nearUniforms && u.eyeWorld) this.instance.nearUniforms.uKeshinEye.value.copy(u.eyeWorld);
  }

  /** 目から消す距離を変える（自分用だけ。ヘッドレス確認で「消している」ことを比べる用） */
  setNearFade(near: [number, number]) {
    this.instance.nearUniforms?.uKeshinNear.value.set(near[0], near[1]);
  }

  hide() {
    this.holder.visible = false;
    this.aura.points.visible = false;
    if (this.stream) this.stream.group.visible = false;
    this.modelVisible = false;
  }

  dispose() {
    this.group.removeFromParent();
    this.instance.dispose();
    this.disposeFallback();
    this.aura.dispose();
    this.stream?.dispose();
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
