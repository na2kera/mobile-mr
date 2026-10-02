// 化身の 3D モデル（GLB）の読み込みと、1 体ぶんの描画用インスタンス（半透明・腰のクリッピング・目の近くを消す・決めポーズ）。
// モデルの扱いは各モデルの README（/Users/keranatsuki/dev/blender/{majin-fable,Pegasus-Opus,Lancelot-Opus,Maestro-Opus}/README.md）に従う:
//   - 拡大縮小・移動・回転はモデルの根（MTH_Root / PA_Root / KL_Root / SoushaMaestro）の外側で行う（ここでは keshin-view.ts の holder）
//   - 下半身ノード（*_LowerBody。マエストロは LowerBody）は非表示、残り（ランスロットのマント・ペガサスのたてがみ等）は腰のクリッピング平面で切る
//   - extras の default_visible が false のノード（マエストロの指揮棒 Baton）は読み込み後に隠す。spec.showNodes にあれば出す
//   - スキンメッシュの境界球はアニメで追従しないので frustumCulled = false（disableSkinnedCulling）
//   - 半透明は makeGhost の方法: 深度だけ書く複製を先に描いてから色を重ねる（内側の面が透けない）。発光部分（目など）は濃く残す
//   - アニメの時刻: MTH_SummonPose 0〜1.25s（A ポーズ → 召喚ポーズ）/ PA_WingFold 0.0417〜0.8333s（レスト → たたむ。逆再生で開く）/
//     KL_ArmTest 0.0417〜0.833s（A ポーズ → 剣と盾を構える）/ MS_ArmTest 0.0417〜1.0417s（レスト → 腕を振る → レスト。ループ用）
// 読み込めない（未配置・build 版）ときは代わりの人型（カプセル）を同じ寸法の約束（5m・腰の高さ・頭の位置）で作り、演出と位置を確認できるようにする
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import type { KeshinIndex } from "../../src/shared/keshin-protocol";
import { MODEL_HEIGHT_M } from "./keshin-math";
import type { KeshinBelow } from "./keshin-math";
import { MASK_HEAD_GLSL } from "./keshin-occlusion";
import type { MaskBinding } from "./keshin-occlusion";

export type KeshinSpec = {
  index: KeshinIndex;
  name: string;
  file: string;
  /** モデルの根ノード名（userData に README の仕様値） */
  rootName: string;
  /** 腰の切断面の高さ（モデル座標 [m]）。クリッピング平面・オーラの渦・主観の前傾の支点 */
  cutY: number;
  /** 決めポーズのクリップ名と向き（reverse = 最後の姿勢から最初へ。ペガサスの「たたんだ翼を開く」） */
  clip: string;
  clipReverse: boolean;
  /** オーラの色（下 → 上。モデルの発光色・地の色から） */
  auraColors: [number, number];
  /** ボタンや HUD に出す短い名前 */
  short: string;
  /**
   * 主観では演出ノード（*_FX_*）を出さない。ペガサスのオーラの帯（半径 1.4m の螺旋）は主観だと自分の頭を囲んで
   * 視界を横切るため。ランスロットの頭の炎は出す
   */
  selfHideFx: boolean;
  /**
   * 主観（自分の画面）の見え方の既定値。URL の ?selfLean= / ?selfFaceAhead= / ?selfBack= で上書きできる。
   *   leanDeg: 腰の切断面を支点に前へ倒す角度 [deg]
   *   faceAheadM: backM が null のとき、化身の頭（Head ボーン）を本人の目よりどれだけ前に置くか [m]
   *   backM: 化身の原点を頭の真下からどれだけ後ろに置くか [m]（null = faceAheadM から自動）
   * 値は README「主観の見え方の既定値」（self-sweep.png を見て確定。scripts/sweep-keshin-self.mjs）
   */
  self: { leanDeg: number; faceAheadM: number; backM: number | null };
  /**
   * 他人用（段階 3 の C）の腰の切り口の既定。URL の ?showBelowM= / ?dissolveM= を指定したときはそちらで全員を上書きする。
   *   showM: 切り口を腰の支点（頭 + waistAboveHeadM）より下げて体を見せる長さ [m]（ワールド。化身の位置は変えない）
   *   dissolveM: 切り口から上のこの長さ [m] を下へ行くほど透明にする
   * 胴の底の作りがモデルごとに違う（cutY で蓋をして終わる胴は、showM ≥ dissolveM だと蓋が溶けずに平らな切り口として出る）ので化身ごと。
   * 値は look-sweep.png（scripts/sweep-keshin-look.mjs）と check:keshin の mirror-look.png を見て決めた
   */
  below: KeshinBelow;
  /**
   * extras（userData）の default_visible が false でも表示するノード名。default_visible が false のノードは読み込み後に隠し、
   * ここに名前があるものだけ出す（マエストロの指揮棒 Baton。glTF には表示の概念が無いので読み込んだままだと見えてしまう）
   */
  showNodes?: readonly string[];
};

/**
 * 4 体の仕様。腰の高さは README の推奨: 魔神は腰の分割位置 2.77m（userData.waist_height_m。断面に蓋がある）、
 * ペガサスは腰帯の上 2.35m（「胸から上だけにしたい場合は 2.35」）、ランスロットは腰装甲の下端付近 1.72m
 * （マントが 1 枚なので下半身を隠しても腰より下が残る。README の setClipBelow(knight, 1.72)）、
 * マエストロは胴の底 2.50m（README 6 章: UpperBody の胴は Z 2.50 で底を閉じた立体。setClipBelow(THREE, root, 2.5)）
 * 他人用の切り口の下げ幅・溶ける長さ（below）は各化身のコメントの理由で化身ごとに決めた（README の見え方 C の表）
 */
export const KESHIN_SPECS: readonly KeshinSpec[] = [
  {
    index: 0,
    name: "マジン・ザ・ハンド",
    short: "マジン・ザ・ハンド",
    file: "majin_the_hand.glb",
    rootName: "MTH_Root",
    cutY: 2.7701,
    clip: "MTH_SummonPose",
    clipReverse: false,
    auraColors: [0xff8a1a, 0xffe07a],
    selfHideFx: false,
    // 確定（self-sweep.png の S5）: 前へ大きく出して 50° 倒す。見上げ 45〜60° で頭と広げた腕の輪郭が入り、目の近くで消える頂点 2%。
    // 35° / +0.25（S1）は兜の裏と細い腕しか見えなかった
    self: { leanDeg: 50, faceAheadM: 1.0, backM: null },
    // 胴（MTH_UpperBody）は腰の分割位置 2.77 で蓋をして終わり、その下は炎のマントだけ。切り口を下げると胴の底の蓋が溶けずに
    // 頭のすぐ上へ平らに出た（check:keshin の mirror-look.png）ので、切り口は腰のまま・腰から上 0.6m を溶かす（従来どおり）
    below: { showM: 0, dissolveM: 0.6 },
  },
  {
    index: 1,
    name: "魔神ペガサスアーク",
    short: "ペガサス",
    file: "majin_pegasus_arc.glb",
    rootName: "PA_Root",
    cutY: 2.35,
    clip: "PA_WingFold",
    clipReverse: true,
    auraColors: [0xff3040, 0x3fe0e8],
    selfHideFx: true,
    // 確定（S4）: 35° のまま頭を 0.7m 前へ。見上げ 45〜60° で翼・髪・肩が入り、消える頂点 12%（S1 は髪の房の裏が重なり 43% 消えていた）
    self: { leanDeg: 35, faceAheadM: 0.7, backM: null },
    // 胴（PA_UpperBody）の底は 2.0 前後（cutY 2.35 の 0.35 下）で蓋をして終わる。人の形で隠す処理を切って撮ると、0.6 / 溶け 0.4 は
    // 1.3m で胴の底の楕円の蓋がはっきり出て、0.4 でも縁が残った。0.3 なら蓋は溶けて籠手（腕当て）が下まで見える
    below: { showM: 0.3, dissolveM: 0.4 },
  },
  {
    index: 2,
    name: "剣聖ランスロット",
    short: "ランスロット",
    file: "kensei_lancelot.glb",
    rootName: "KL_Root",
    cutY: 1.72,
    clip: "KL_ArmTest",
    clipReverse: false,
    auraColors: [0x6a5cff, 0xff2a48],
    selfHideFx: false,
    // 確定（S4）: 見上げ 45° で兜・角・肩当て・胸当てが入り、消える頂点 14%。S1（35° / +0.25）は兜・肩当て・胸が読めるが
    // 頂点の 45% が目の近くで消えていた
    self: { leanDeg: 35, faceAheadM: 0.7, backM: null },
    // 腰装甲（草摺り）の下端は尖った形で、その下はマント（下端 0.35）と盾・剣。0.6 / 溶け 0.4 で草摺りの先まで見え、
    // 人の形で隠す処理を切っても平らな切り口は出なかった（1.3m・3.2m）
    below: { showM: 0.6, dissolveM: 0.4 },
  },
  {
    index: 3,
    name: "奏者マエストロ",
    short: "マエストロ",
    file: "sousha_maestro.glb",
    // 根ノードは *_Root ではなく SoushaMaestro（README 3 章）。子ノードも接頭辞なし（UpperBody / LowerBody / Baton など）
    rootName: "SoushaMaestro",
    // 胴の底（README 6 章: Z 2.50 に蓋がある。LowerBody を隠すと胴の暗い底面が見える）。前布（下端 2.25）と下段の手（指先 ≈ 2.05）は
    // この面で切れる
    cutY: 2.5,
    // 上段の腕を上下・下段の腕を前後に振る（README 5 章。レスト → 山 → レストの往復なので決めポーズの終わりはレストに戻る）
    clip: "MS_ArmTest",
    clipReverse: false,
    // 元画像の光の演出（青いボールの球体・水色のベール）から。モデル自体に発光は無い
    auraColors: [0x2f6fff, 0x9fe8ff],
    // 演出ノード（fx_nodes）が無い
    selfHideFx: false,
    // 確定（2026-10-01 の self-sweep.png の S4）: 見上げ 45° で髪・肩飾り・立ち襟・上段の腕が入り、消える頂点 4%、視界の中心を 85%（60° で 51%）覆う。
    // S1（35° / +0.25）は頂点の 51% が消え、S5（50° / +1.0）は 60° 以上で画素が 1/2〜1/20 に減った
    self: { leanDeg: 35, faceAheadM: 0.7, backM: null },
    // 下段の手（指先 ≈ 2.05）と前布（下端 2.25）が cutY 2.5 より下にある。look-sweep.png で 0.6 / 溶け 0.4 なら下段の手 2 本と前布が読めた
    // （0.8 は 0.6 と同じ: 2.05 より下に頂点が無い）。胴の底の蓋（2.50）は前布が覆うので切り口に見えない
    below: { showM: 0.6, dissolveM: 0.4 },
    // 指揮棒（README 7 章: 上段の右手のボーン HandUp.R の子の剛体。extras の default_visible は false）を出す
    showNodes: ["Baton"],
  },
];

/** 読み込んだ（または代わりに作った）1 体ぶんのテンプレート。インスタンスはここから複製する */
export type LoadedKeshin = {
  spec: KeshinSpec;
  /** 本物のモデルか、代わりの人型か */
  fallback: boolean;
  /** 複製元（シーンには入れない） */
  template: THREE.Object3D;
  animations: THREE.AnimationClip[];
  /** 上半身（腰より上・下半身と演出ノードを除く）の +Z 側の端（モデル座標 [m]。召喚前後の姿勢の大きい方） */
  frontZ: number;
  /** 頭（Head ボーン）の位置（モデル座標 [m]。決めポーズのあと） */
  head: { x: number; y: number; z: number };
  /** 読み込みにかかった時間 [ms]（代わりの人型は 0） */
  loadMs: number;
  /** 三角形の数（下半身を除いた描画ぶん。深度の複製で実際はこの 2 倍描く） */
  triangles: number;
  /** 前面と頭の測定にかかった時間 [ms]（全頂点 × 2 姿勢を CPU でスキン変形する。0 = 事前計算の値を使った） */
  measureMs?: number;
};

/** dev サーバーだけが配る URL（vite.config.ts の keshinLocalAssets） */
export function keshinModelUrl(spec: KeshinSpec): string {
  return `${import.meta.env.BASE_URL}local-assets/keshin/${spec.file}`;
}

const isEmissiveName = (name: string) => /_Emissive$/.test(name) || /Eye_Glow/.test(name);

/** 下半身・演出ノードの名前（userData に無ければ命名規約から） */
function nodeNames(root: THREE.Object3D, spec: KeshinSpec): { lower: string; fx: string[] } {
  // userData（GLB の extras）はシーンの根ではなくモデルの根（MTH_Root 等）にある
  const ud = modelRootOf(root, spec).userData as { lower_body_node?: string; fx_nodes?: string[] };
  const prefix = spec.rootName.replace(/_Root$/, "");
  return { lower: ud.lower_body_node ?? `${prefix}_LowerBody`, fx: ud.fx_nodes ?? [] };
}

/** モデルの根（MTH_Root / PA_Root / KL_Root / SoushaMaestro。README の仕様値が userData にある）。無ければ渡したもの */
function modelRootOf(root: THREE.Object3D, spec: KeshinSpec): THREE.Object3D {
  return root.getObjectByName(spec.rootName) ?? root;
}

/**
 * extras（userData）の default_visible が false のノードを隠す（マエストロ README 7 章の applyDefaultVisibility と同じ）。
 * show に名前があるノードは逆に出す。該当するノードが無いモデル（魔神・ペガサス・ランスロット）では何もしない
 */
function applyDefaultVisibility(root: THREE.Object3D, show: readonly string[]) {
  root.traverse((o) => {
    if ((o.userData as { default_visible?: unknown }).default_visible === false) o.visible = show.includes(o.name);
  });
}

/** o が names のどれかのノードの子孫（自身を含む）か */
function isUnder(o: THREE.Object3D, names: readonly string[]): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (names.includes(p.name)) return true;
  return false;
}

// ---- 1 体ぶんのインスタンス（自分用・他人用で別々に作る。マテリアルとクリッピング平面は個別）----

/** 段階 3 の C: 腰の切り口を溶かす uniform（他人用。plane = 腰の切断面（ワールド。法線は上）、m = 溶ける長さ [m]、time = 揺らめき） */
export type DissolveUniforms = {
  uDissolvePlane: { value: THREE.Vector4 };
  uDissolveM: { value: number };
  uDissolveTime: { value: number };
};

export function createDissolveUniforms(m: number): DissolveUniforms {
  return { uDissolvePlane: { value: new THREE.Vector4(0, 1, 0, 0) }, uDissolveM: { value: m }, uDissolveTime: { value: 0 } };
}

export type KeshinInstance = {
  /** モデルの根（位置・回転・拡大縮小は外側の holder で行う） */
  root: THREE.Object3D;
  /** 腰のクリッピング平面（ワールド。毎フレーム値を書き換える） */
  plane: THREE.Plane;
  /** 目の近くを消すシェーダーの uniform（自分用だけ。eye = 目のワールド位置、near = (消える距離, 見え始める距離)） */
  nearUniforms: { uKeshinEye: { value: THREE.Vector3 }; uKeshinNear: { value: THREE.Vector2 } } | null;
  /** 決めポーズ（0..1）を当てる。同じ値なら何もしない */
  setPose(poseK: number): void;
  /** 不透明度を当てる（body = 体の目標値 × 演出。発光部分は演出だけ） */
  setOpacity(body: number, fx: number): void;
  dispose(): void;
};

/**
 * インスタンスを作る。materials は複製して個別にし（不透明度・クリッピング平面を他のインスタンスと共有しない）、
 * 下半身を隠し、スキンのカリングを切り、makeGhost（深度の前描画）を掛ける。
 * nearFade を渡すと目から near[0] m 以内を消し、near[1] m までをなめらかに戻す（主観用。StereoEffect の左右の目で
 * 同じ結果になるよう、カメラではなく「頭の中心」のワールド位置からの距離で決める）
 */
export function createKeshinInstance(
  loaded: LoadedKeshin,
  nearFade: [number, number] | null,
  hideFx = false,
  mask: MaskBinding | null = null,
  dissolve: DissolveUniforms | null = null,
): KeshinInstance {
  const root = loaded.fallback ? loaded.template.clone(true) : cloneSkinned(loaded.template);
  const names = nodeNames(root, loaded.spec);
  const lower = root.getObjectByName(names.lower);
  if (lower) lower.visible = false;
  applyDefaultVisibility(root, loaded.spec.showNodes ?? []);
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const nearUniforms = nearFade
    ? { uKeshinEye: { value: new THREE.Vector3() }, uKeshinNear: { value: new THREE.Vector2(nearFade[0], nearFade[1]) } }
    : null;

  // 深度だけ書く複製のマテリアル（インスタンスで 1 つ。スキン・モーフはオブジェクト側の属性で自動）
  // transparent にするのは描く順のため（色は書かない）: 背後の炎（keshin-flame.ts。renderOrder −2）→ この深度（−1）→ 体の色（0）。
  // 不透明のままだと不透明の段で炎より先に深度が書かれ、化身がまだ薄い出現・消去の途中に、化身の形に炎が抜けて背景が見える
  const depthMaterial = new THREE.MeshBasicMaterial({ colorWrite: false, transparent: true });
  depthMaterial.clippingPlanes = [plane];
  if (nearUniforms || mask || dissolve) addKeshinShader(depthMaterial, nearUniforms, mask, "depth", dissolve);

  type Mat = THREE.Material & { opacity: number; emissive?: THREE.Color };
  /** own = 発光・演出（体の目標値を掛けず、元の値 × 演出だけ） */
  const materials: { m: Mat; base: number; own: boolean }[] = [];
  const cloned = new Map<string, Mat>();
  const refOpacity = (modelRootOf(root, loaded.spec).userData as { opacity?: number }).opacity;
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
  });
  for (const mesh of meshes) {
    mesh.frustumCulled = false;
    const list = ([] as THREE.Material[]).concat(mesh.material);
    // 半透明の演出（ペガサスのオーラの帯。元から BLEND・両面）だけは特別扱い: 深度の前描画をせず（裏側が消える）、元の不透明度 × 演出。
    // 不透明で作られた演出（ランスロットの頭の炎）は体と同じ扱い（深度の前描画 + 体の不透明度。発光の外炎は発光部分として濃く残す）
    const fxBlend = isUnder(mesh, names.fx) && list.every((m) => m.transparent);
    const next = list.map((orig) => {
      let m = cloned.get(orig.uuid);
      if (m) return m;
      m = orig.clone() as Mat;
      cloned.set(orig.uuid, m);
      // 体の目標値に対する倍率（元が半透明なら部位ごとの差を保つ: 魔神の兜 0.98 / 体 0.90）。発光部分は 1 のまま残す
      const emissive = isEmissiveName(orig.name);
      const base = fxBlend ? orig.opacity : emissive ? 1 : orig.transparent && refOpacity ? orig.opacity / refOpacity : 1;
      m.transparent = true;
      m.depthWrite = false;
      m.clippingPlanes = [plane];
      if (nearUniforms || mask || dissolve) addKeshinShader(m, nearUniforms, mask, "color", dissolve);
      materials.push({ m, base, own: fxBlend || emissive });
      return m;
    });
    mesh.material = Array.isArray(mesh.material) ? next : next[0];
    if (fxBlend) continue;
    const depth = mesh.clone();
    depth.name = `${mesh.name}_depth`;
    depth.userData.ghostDepth = true;
    depth.material = depthMaterial;
    depth.position.set(0, 0, 0);
    depth.quaternion.identity();
    depth.scale.set(1, 1, 1);
    depth.frustumCulled = false;
    if (mesh.morphTargetInfluences) depth.morphTargetInfluences = mesh.morphTargetInfluences;
    // 深度を体の色より先に書く（半透明の段の中で renderOrder を下げて先に描く。炎はさらに前の −2）
    depth.renderOrder = -1;
    mesh.add(depth);
  }

  // 決めポーズ
  const mixer = loaded.fallback ? null : new THREE.AnimationMixer(root);
  const clip = loaded.fallback ? null : THREE.AnimationClip.findByName(loaded.animations, loaded.spec.clip);
  const action = mixer && clip ? mixer.clipAction(clip) : null;
  if (action) {
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    action.play();
  }
  // 魔神の口: 召喚までは閉じ、決めポーズで叫ぶ（シェイプキー MouthClosed。README: 0 = 叫び顔、1 = 閉じた口）
  const mouth: { mesh: THREE.Mesh; i: number }[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    const i = m.morphTargetDictionary?.MouthClosed;
    if (m.isMesh && !m.userData.ghostDepth && i !== undefined) mouth.push({ mesh: m, i });
  });
  const fxNodes = names.fx.map((n) => root.getObjectByName(n)).filter((o): o is THREE.Object3D => !!o);
  let lastPose = NaN;
  let lastBody = NaN;
  let lastFx = NaN;

  return {
    root,
    plane,
    nearUniforms,
    setPose(poseK: number) {
      const k = Math.min(1, Math.max(0, poseK));
      if (k === lastPose) return;
      lastPose = k;
      if (loaded.fallback) {
        applyFallbackPose(root, k);
        return;
      }
      if (mixer && action && clip) {
        const t = (loaded.spec.clipReverse ? 1 - k : k) * clip.duration;
        action.enabled = true;
        action.paused = false;
        mixer.setTime(t);
      }
      for (const { mesh, i } of mouth) if (mesh.morphTargetInfluences) mesh.morphTargetInfluences[i] = 1 - k;
      // ペガサスのオーラの帯は翼がレストのときだけ（README: たたむ途中の翼が帯を通る）。hideFx なら出さない
      for (const n of fxNodes) n.visible = !hideFx && (loaded.spec.index !== 1 || k >= 0.999);
    },
    setOpacity(body: number, fx: number) {
      if (body === lastBody && fx === lastFx) return;
      lastBody = body;
      lastFx = fx;
      for (const { m, base, own } of materials) m.opacity = Math.min(1, base * (own ? fx : body));
    },
    dispose() {
      mixer?.stopAllAction();
      if (mixer) mixer.uncacheRoot(root);
      for (const { m } of materials) m.dispose();
      depthMaterial.dispose();
      // 骨の行列テクスチャ（SkeletonUtils.clone がインスタンスごとに作る Skeleton が持つ）。形状はテンプレートと共有なので捨てない
      const skeletons = new Set<THREE.Skeleton>();
      root.traverse((o) => {
        const sm = o as THREE.SkinnedMesh;
        if (sm.isSkinnedMesh && sm.skeleton) skeletons.add(sm.skeleton);
      });
      for (const sk of skeletons) sk.dispose();
    },
  };
}

/**
 * 化身のマテリアルに差し込むシェーダー（onBeforeCompile）。どちらも深度の前描画（depth）と色（color）で**同じ条件で画素ごとに捨てる**。
 *   near（自分用）: 目の近くを消す。頂点シェーダーでスキン後のワールド位置を渡し、フラグメントで「頭の中心」からの距離 d を見る。
 *     k = smoothstep(near.x, near.y, d) を、画素の位置で決まるノイズ（interleaved gradient noise。同じ画素なら深度と色で同じ値）と
 *     比べて k ≤ ノイズなら discard。アルファを落とすと、その帯だけ深度の前描画が無くなって内側の面が透ける（段階 1 のレビュー）ので、
 *     残す画素は深度も色も残す。near.y ≤ near.x のときは d < near.x を捨てるだけ（(0, 0) なら何も捨てない）
 *   mask（他人用・段階 2）: カメラに写った人の形で、持ち主の頭より奥の部分だけ隠す（keshin-occlusion.ts の keshinMasked）
 */
function addKeshinShader(
  material: THREE.Material,
  near: { uKeshinEye: { value: THREE.Vector3 }; uKeshinNear: { value: THREE.Vector2 } } | null,
  mask: MaskBinding | null,
  kind: "color" | "depth",
  dissolve: DissolveUniforms | null = null,
) {
  material.onBeforeCompile = (shader) => {
    const heads: string[] = ["varying vec3 vKeshinWorld;"];
    const bodies: string[] = [];
    // スキン後のワールド位置（目の近くの距離・人の形の前後の判定に使う）
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vKeshinWorld;")
      .replace("#include <project_vertex>", "#include <project_vertex>\nvKeshinWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    if (near) {
      shader.uniforms.uKeshinEye = near.uKeshinEye;
      shader.uniforms.uKeshinNear = near.uKeshinNear;
      heads.push("uniform vec3 uKeshinEye;", "uniform vec2 uKeshinNear;");
      bodies.push(
        "{",
        "  float kd = distance(vKeshinWorld, uKeshinEye);",
        "  float kk = uKeshinNear.y > uKeshinNear.x ? smoothstep(uKeshinNear.x, uKeshinNear.y, kd) : step(uKeshinNear.x, kd);",
        "  float kn = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));",
        "  if (kk <= kn) discard;",
        "}",
      );
    }
    if (dissolve) {
      // 段階 3 の C: 腰の切断面から上 uDissolveM の範囲を、下へ行くほど画素ごとに捨てる（切り口を作らず光に溶ける）。
      // 高さの境目は横方向のゆっくりしたノイズで揺らめかせる。深度の前描画も同じ条件で捨てる（同じ画素は同じノイズ）
      Object.assign(shader.uniforms, dissolve);
      heads.push(
        "uniform vec4 uDissolvePlane;",
        "uniform float uDissolveM;",
        "uniform float uDissolveTime;",
        "float kdHash(float n) { return fract(sin(n) * 43758.5453123); }",
        "float kdNoise(float x) { float i = floor(x); float f = fract(x); float u = f * f * (3.0 - 2.0 * f); return mix(kdHash(i), kdHash(i + 1.0), u); }",
      );
      bodies.push(
        "{",
        "  float dh = dot(uDissolvePlane.xyz, vKeshinWorld) + uDissolvePlane.w;",
        "  float wob = (kdNoise(vKeshinWorld.x * 3.1 + vKeshinWorld.z * 2.3 + uDissolveTime * 0.8) + kdNoise(vKeshinWorld.y * 5.0 - uDissolveTime * 1.3) - 1.0) * 0.3 * uDissolveM;",
        "  float dk = uDissolveM > 0.0 ? smoothstep(0.0, uDissolveM, dh + wob) : 1.0;",
        "  float dn = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));",
        "  if (dk * dk <= dn) discard;",
        "}",
      );
    }
    if (mask) {
      Object.assign(shader.uniforms, mask.shared, mask.owner);
      heads.push(MASK_HEAD_GLSL);
      bodies.push("if (keshinMasked(vKeshinWorld)) discard;");
    }
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", ["#include <common>", ...heads].join("\n"))
      .replace("#include <clipping_planes_fragment>", ["#include <clipping_planes_fragment>", ...bodies].join("\n"));
  };
  material.customProgramCacheKey = () => `keshin-${near ? "near" : ""}-${mask ? "mask" : ""}-${dissolve ? "dissolve" : ""}-${kind}`;
  material.needsUpdate = true;
}

// ---- 読み込み ----

const loader = new GLTFLoader();

/** GLB を読み込んでテンプレートにする。失敗したら例外（呼び出し側が代わりの人型に落とす） */
export async function loadKeshinModel(spec: KeshinSpec, url = keshinModelUrl(spec)): Promise<LoadedKeshin> {
  const t0 = performance.now();
  const gltf = await loader.loadAsync(url);
  const loadMs = performance.now() - t0;
  const template = gltf.scene;
  const root = template.getObjectByName(spec.rootName);
  if (!root) throw new Error(`${spec.rootName} が見つからない（${spec.file}）`);
  const loaded: LoadedKeshin = { spec, fallback: false, template, animations: gltf.animations, frontZ: 0, head: { x: 0, y: 0, z: 0 }, loadMs, triangles: 0 };
  const tm = performance.now();
  measure(loaded);
  loaded.measureMs = performance.now() - tm;
  return loaded;
}

/**
 * 上半身の前面と頭の位置を測る（モデル座標）。前面は「腰より上・下半身と演出ノードを除く頂点の +Z の最大」を、
 * 召喚前（ポーズ 0）と決めポーズ（1）の両方で取った大きい方（腕を前に差し出す魔神の手も本人の頭に刺さらないように）
 */
function measure(loaded: LoadedKeshin) {
  const inst = createKeshinInstance(loaded, null);
  const names = nodeNames(inst.root, loaded.spec);
  const v = new THREE.Vector3();
  let frontZ = -Infinity;
  let triangles = 0;
  const head = new THREE.Vector3(0, loaded.spec.cutY + 1.5, 0);
  for (const k of [0, 1]) {
    inst.setPose(k);
    inst.root.updateMatrixWorld(true);
    inst.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || mesh.userData.ghostDepth || isUnder(mesh, [names.lower, ...names.fx])) return;
      const pos = mesh.geometry.getAttribute("position");
      if (!pos) return;
      if (k === 1) triangles += (mesh.geometry.index ? mesh.geometry.index.count : pos.count) / 3;
      for (let i = 0; i < pos.count; i++) {
        mesh.getVertexPosition(i, v);
        v.applyMatrix4(mesh.matrixWorld);
        if (v.y > loaded.spec.cutY && v.z > frontZ) frontZ = v.z;
      }
    });
    if (k === 1) {
      const bone = inst.root.getObjectByName("Head");
      if (bone) bone.getWorldPosition(head);
    }
  }
  inst.dispose();
  loaded.frontZ = Number.isFinite(frontZ) ? frontZ : 0.5;
  loaded.head = { x: head.x, y: head.y, z: head.z };
  loaded.triangles = Math.round(triangles);
}

// ---- 代わりの人型（モデル未配置・build 版）----
// モデルと同じ約束（全高 5m・足元が原点・正面 +Z）で、カプセルの半透明の人型を作る。腕だけ決めポーズで上げる

// 腰の切断面は頭（目）より下にする（本物のモデルと同じく、相手の化身が相手の頭・肩に重なるように。人の形で隠す確認に要る）
const FALLBACK_CUT_Y = 2.1;

function fallbackTemplate(spec: KeshinSpec): THREE.Object3D {
  const prefix = spec.rootName.replace(/_Root$/, "");
  const root = new THREE.Group();
  root.name = spec.rootName;
  root.userData = { height_m: MODEL_HEIGHT_M, lower_body_node: `${prefix}_LowerBody`, fx_nodes: [] };
  const body = new THREE.MeshStandardMaterial({ name: "FB_Body", color: spec.auraColors[1], roughness: 0.6, emissive: spec.auraColors[0], emissiveIntensity: 0.25 });
  const eye = new THREE.MeshStandardMaterial({ name: "FB_Eye_Emissive", color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 1 });
  const upper = new THREE.Group();
  upper.name = `${prefix}_UpperBody`;
  const lower = new THREE.Group();
  lower.name = `${prefix}_LowerBody`;
  root.add(upper, lower);
  const capsule = (r: number, len: number, mat: THREE.Material) => new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 6, 16), mat);
  const torso = capsule(0.62, 1.1, body);
  torso.position.set(0, 3.35, 0);
  torso.scale.set(1.25, 1, 0.75);
  const hips = capsule(0.5, 0.4, body);
  hips.position.set(0, 2.55, 0);
  hips.scale.set(1.2, 1, 0.8);
  const headMesh = new THREE.Mesh(new THREE.SphereGeometry(0.42, 24, 16), body);
  headMesh.position.set(0, 4.5, 0);
  const eyes = [-0.15, 0.15].map((x) => {
    const e = new THREE.Mesh(new THREE.SphereGeometry(0.06, 12, 8), eye);
    e.position.set(x, 4.55, 0.37);
    return e;
  });
  upper.add(torso, hips, headMesh, ...eyes);
  for (const side of [-1, 1]) {
    // 肩を支点に回す腕（決めポーズで前へ上げる）
    const pivot = new THREE.Group();
    pivot.name = side < 0 ? "FB_ArmR" : "FB_ArmL";
    pivot.position.set(side * 0.95, 3.95, 0);
    const arm = capsule(0.2, 1.3, body);
    arm.position.set(0, -0.85, 0);
    pivot.add(arm);
    upper.add(pivot);
    const leg = capsule(0.26, 2.0, body);
    leg.position.set(side * 0.4, 1.2, 0);
    lower.add(leg);
  }
  return root;
}

function applyFallbackPose(root: THREE.Object3D, k: number) {
  for (const side of [-1, 1]) {
    const pivot = root.getObjectByName(side < 0 ? "FB_ArmR" : "FB_ArmL");
    if (!pivot) continue;
    // A ポーズ（少し開く）→ 前やや外へ 70° 上げる
    pivot.rotation.set(-k * 1.2, 0, side * (0.35 + k * 0.4));
  }
}

/** 代わりの人型のテンプレート（モデルと同じ測り方で前面と頭を出す） */
export function fallbackKeshin(spec: KeshinSpec): LoadedKeshin {
  const loaded: LoadedKeshin = {
    spec: { ...spec, cutY: FALLBACK_CUT_Y },
    fallback: true,
    template: fallbackTemplate(spec),
    animations: [],
    frontZ: 0,
    head: { x: 0, y: 4.5, z: 0 },
    loadMs: 0,
    triangles: 0,
  };
  measure(loaded);
  loaded.head = { x: 0, y: 4.5, z: 0 };
  return loaded;
}
