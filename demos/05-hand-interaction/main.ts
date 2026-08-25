import * as THREE from "three";
import { StereoEffect } from "three/examples/jsm/effects/StereoEffect.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { DeviceOrientationControls } from "three-stdlib";
import { createHandTracker } from "./hand-tracker";
import type { HandTracker } from "./hand-tracker";
import { HandView } from "./hand-view";
import { scriptedHand } from "./fake-hands";
import {
  FINGER_TIPS,
  INDEX_TIP,
  LANDMARK_COUNT,
  WRIST,
  isPointingPose,
  placeLandmarks,
  solveHandPlacement,
} from "./hand-math";
import type { Vec3, ViewMapping } from "./hand-math";

// Phase 5: MR Hand Interaction。
// 背面カメラの映像（パススルー）に映った自分の手を MediaPipe HandLandmarker で検出し、
// 仮想空間の手として 3D 化する。3種類の操作を試す:
//   1. 目の前に浮かぶボールを手で押す（指先とボールの衝突 + ばねで戻る）
//   2. 手前のボタンを指で押す（指先がボタンの箱に入ったら押下）
//   3. 指差しで遠くの的を選ぶ（視点 → 人差し指の先を通る視線で当てて、一定時間で選択）
// 単独端末・マーカーなし（3DoF の頭追従のみ）。マーカー・マルチプレイヤーとの合流は Phase 6。
// カメラ・ステレオ描画・開始フローは 02-passthrough と同じ（詳細コメントはそちら）。
// 手の 3D 化の考え方は hand-math.ts の solveHandPlacement のコメントを参照。

// ---- ゴーグル調整パラメータ（02 と同じ。URL クエリで実機合わせ込み） ----
const params = new URLSearchParams(location.search);
function numParam(
  name: string,
  fallback: number,
  { min = Number.EPSILON, max = Infinity } = {},
): number {
  const v = Number(params.get(name) ?? NaN);
  return Number.isFinite(v) && v >= min && v <= max ? v : fallback;
}
const FOV = numParam("fov", 70, { min: 20, max: 170 });
const EYE_SEP = numParam("eyeSep", 0.064, { min: 0, max: 0.2 });
const CAM_ZOOM = numParam("camZoom", 1, { min: 0.2, max: 5 });

// ---- 手トラッキングのパラメータ ----
// hands: 同時に追跡する手の数。既定 1（MediaPipe は追跡中の手が numHands 未満だと
// 毎フレーム全画面の palm detection も回すので、片手しか出さないのに 2 にすると常に重い）
const NUM_HANDS = Math.round(numParam("hands", 1, { min: 1, max: 2 }));
// delegate: auto（GPU → 失敗したら CPU）/ gpu / cpu。実機で比較するため
const delegateRaw = (params.get("delegate") ?? "auto").toLowerCase();
const DELEGATE =
  delegateRaw === "gpu" ? "GPU" : delegateRaw === "cpu" ? "CPU" : "auto";
// smooth: 推論結果（約 30Hz・ブレあり）を描画に馴染ませる指数移動平均係数。1 で平滑化なし
const SMOOTH = numParam("smooth", 0.5, { min: 0.05, max: 1 });
// detIntervalMs: 推論の最小間隔。0 = カメラの新フレームごと。重い端末で間引くため
const DET_INTERVAL_MS = numParam("detIntervalMs", 0, { min: 0, max: 1000 });
// detAdapt: 直近の推論時間 × この係数も最小間隔にする（0 = 無効）。推論が描画フレームを
// 毎回塞ぐ端末で、一定間隔の間引きに自動で落とすため。実機で比較して決める
const DET_ADAPT = numParam("detAdapt", 0, { min: 0, max: 10 });
// detW: 推論に渡す画像の長辺 [px]。0 = 自動（GPU は video そのまま / CPU は 640 に縮小）。
// CPU で縮小を切りたいときは映像より大きい値（例 4096）を指定する
const DET_W = numParam("detW", 0, { min: 0, max: 4096 });
// mpCanvas=dom: MediaPipe に DOM の canvas を渡す（OffscreenCanvas 絡みの不具合の切り分け用）
const MP_CANVAS_DOM = params.get("mpCanvas") === "dom";
// lostHideMs: 手が検出されなくなってから骨格を消すまでの時間
const LOST_HIDE_MS = numParam("lostHideMs", 300, { min: 50, max: 5000 });
// alignHoldMs: 横向きで頭が水平な状態がこれだけ続いたら、その向きを正面にする
const ALIGN_HOLD_MS = numParam("alignHoldMs", 1000, { min: 0, max: 10000 });
// recenterMs: 正面からの向きのズレが 90° を超えた状態がこれだけ続いたら正面を取り直す（0 = 無効）
const RECENTER_MS = numParam("recenterMs", 3000, { min: 0, max: 60000 });
// maxDepth: これより遠いと推定された手は無視する（誤検出や他人の手は遠くに出やすい）
const MAX_DEPTH_M = numParam("maxDepth", 1.5, { min: 0.2, max: 10 });
// maxResidual: 3D 化の当てはめ残差（深度 1 の平面上の長さ）がこれを超える検出は捨てる。
// 実機での典型値が分かっていないので既定は無効（HUD の res= を見て決める）
const MAX_RESIDUAL = numParam("maxResidual", Infinity, { min: 0 });
// matchDist: 前回の手と「同じ手」とみなす手首位置の距離 [m]（スロット割当に使う）。
// 推論の間隔が空くほど手は遠くへ動けるので、実際の閾値は matchDist + matchSpeed × 経過秒
const MATCH_DIST_M = numParam("matchDist", 0.15, { min: 0.02, max: 2 });
const MATCH_SPEED_MPS = numParam("matchSpeed", 2, { min: 0, max: 20 });
// MediaPipe の信頼度閾値（既定はライブラリと同じ 0.5）
const MIN_DET = numParam("minDet", 0.5, { min: 0, max: 1 });
const MIN_PRESENCE = numParam("minPresence", 0.5, { min: 0, max: 1 });
const MIN_TRACK = numParam("minTrack", 0.5, { min: 0, max: 1 });
// モデルの取得先: ローカル（npm run fetch:models で配置）→ 公式 URL の順。?model= で差し替え
const OFFICIAL_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
const MODEL_URLS = params.get("model")
  ? [params.get("model")!]
  : [`${import.meta.env.BASE_URL}models/hand_landmarker.task`, OFFICIAL_MODEL_URL];

// fakehands: MediaPipe の代わりに台本どおりに動く合成の手を入れる（PC での経路確認用。
// fake-hands.ts 参照）。?fakecam=1 と組み合わせてヘッドレスでも全経路を回せる
const FAKE_HANDS = params.has("fakehands");

// ---- 深度の基準 ----
// depthMode=metric（既定）: 手の深度は実カメラの FOV（レンズ種別から推定。?camFov= で補正、
//   03/04 と同じ方式）で実寸に合わせる。骨格の x/y（背景の手との重なり）は表示基準のまま。
//   実機確認（2026-08-26）で、表示基準の深度は「仮想 FOV / 実効 FOV」の比がそのまま倍率になり、
//   腕を伸ばした手（実測 0.6m 前後）が 0.25m と推定される（= ボールとの奥行き感覚がズレる）
//   ことが分かったため、実寸基準を既定にした
// depthMode=display: 従来の表示基準（仮想 FOV + cover）。fakehands は合成データが表示基準で
//   作られているため常にこちらを使う
const DEPTH_MODE =
  FAKE_HANDS || params.get("depthMode") === "display" ? "display" : "metric";
// 実カメラの水平 FOV [deg]（長辺方向）。カメラ起動時にレンズのラベルから推定して上書きする
let camHFovDeg = 68;

// ---- 操作対象のパラメータ ----
// reach: ボール・ボタンを置く距離 [m]。腕を伸ばさずに届き、かつカメラに手が映る距離
const REACH = numParam("reach", 0.45, { min: 0.2, max: 1.5 });
const BALL_R = numParam("ballR", 0.06, { min: 0.02, max: 0.3 });
// dwellMs: 指差しで的を選ぶまでの滞留時間
const DWELL_MS = numParam("dwellMs", 600, { min: 100, max: 5000 });
/** 指先の当たり半径 [m]（ボール・ボタンとの接触判定に足す） */
const TIP_R = 0.012;

// ---- シーン ----
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a2233);

const camera = new THREE.PerspectiveCamera(
  FOV,
  innerWidth / innerHeight,
  0.05, // 手は 20〜30cm まで近づくので 02 より手前まで描く
  100,
);
camera.position.set(0, 1.6, 0);
// 手の骨格はカメラの子にする（MediaPipe の結果はカメラ座標系なので、頭の回転を
// three.js の親子関係に任せられる）。子を描くにはカメラ自体をシーンに入れる必要がある
scene.add(camera);

scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.2));
const dirLight = new THREE.DirectionalLight(0xffffff, 1.5);
dirLight.position.set(3, 10, 2);
scene.add(dirLight);

// ---- ステージ（操作対象をまとめる親。開始後に「最初に正面を向いた方向」へ回す） ----
// DeviceOrientationControls の yaw はコンパス基準なので、開始時にユーザーがどちらを
// 向いているかは分からない。ゴーグルを付けて頭を水平にした最初のフレームで、
// その向きにステージ全体を回して「目の前に置く」
const stage = new THREE.Group();
scene.add(stage);
let stageAligned = false;

// 1. ボール（ばねで定位置に戻る）
const BALL_HOME = new THREE.Vector3(0, 1.45, -REACH);
const ballMaterial = new THREE.MeshStandardMaterial({
  color: 0xfdd663,
  emissive: 0xfdd663,
  emissiveIntensity: 0,
  roughness: 0.4,
});
const ball = new THREE.Mesh(new THREE.SphereGeometry(BALL_R, 24, 16), ballMaterial);
ball.position.copy(BALL_HOME);
stage.add(ball);
// 定位置の目印（ボールが押されて飛んでも、戻る先が分かるように）
const ballHomeGhost = new THREE.Mesh(
  new THREE.SphereGeometry(BALL_R, 12, 8),
  new THREE.MeshBasicMaterial({ color: 0xfdd663, wireframe: true, transparent: true, opacity: 0.15 }),
);
ballHomeGhost.position.copy(BALL_HOME);
stage.add(ballHomeGhost);
const ballPos = BALL_HOME.clone();
const ballVel = new THREE.Vector3();
/** 現在のボールの色（ボタンで変わる。tracker 状態表示から戻すときに使う） */
let ballColor = 0xfdd663;
let touches = 0;
let lastTouchMs = -Infinity;

// 2. ボタン（3色。押すとボールの色が変わる）
type Button = {
  mesh: THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>;
  color: number;
  homeZ: number;
  pressed: boolean;
};
const BUTTON_SIZE = new THREE.Vector3(0.07, 0.07, 0.025);
const buttons: Button[] = [];
{
  const panelZ = -REACH + 0.05;
  const panelY = 1.3;
  const plate = new THREE.Mesh(
    new THREE.BoxGeometry(0.36, 0.1, 0.01),
    new THREE.MeshStandardMaterial({ color: 0x2a2e33, roughness: 0.8 }),
  );
  plate.position.set(0, panelY, panelZ - BUTTON_SIZE.z / 2);
  stage.add(plate);
  for (const [i, color] of [0xf28b82, 0x81c995, 0x8ab4f8].entries()) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(BUTTON_SIZE.x, BUTTON_SIZE.y, BUTTON_SIZE.z),
      new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0 }),
    );
    mesh.position.set((i - 1) * 0.12, panelY, panelZ);
    stage.add(mesh);
    buttons.push({ mesh, color, homeZ: panelZ, pressed: false });
  }
}
let presses = 0;

// 3. 的（指差しで選ぶ。手が届かない距離に置く）
type Target = {
  mesh: THREE.Mesh<THREE.SphereGeometry, THREE.MeshStandardMaterial>;
  selected: boolean;
};
const targets: Target[] = [];
for (const [x, y, z] of [
  [-0.8, 1.9, -2.0],
  [0, 2.2, -2.2],
  [0.8, 1.9, -2.0],
  [0, 1.0, -2.4],
]) {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.12, 20, 14),
    new THREE.MeshStandardMaterial({ color: 0x9aa0a6, emissive: 0xfdd663, emissiveIntensity: 0 }),
  );
  mesh.position.set(x, y, z);
  stage.add(mesh);
  targets.push({ mesh, selected: false });
}
let selections = 0;

// ---- 手（最大2つ。左右で色を変える） ----
// MediaPipe のドキュメントは「handedness は鏡像（自撮り）前提。鏡像でない画像では
// アプリ側で入れ替えること」と言うが、iPhone 実機（1.0.1）では背面カメラのままで
// 正しい Left/Right が返ってきた（2026-08-24 実機確認。入れ替えると逆になった）。
// 既定は入れ替えなしとし、挙動が違う端末・バージョンに備えて ?swapHands=1 を残す
const SWAP_HANDS = params.get("swapHands") === "1";
const HAND_COLORS = { R: 0x8ab4f8, L: 0xffa657, "-": 0xe8eaed } as const;
type HandLabel = keyof typeof HAND_COLORS;
type HandSlot = {
  view: HandView;
  /** 指差しの視線（人差し指の先 → 的）の表示 */
  rayLine: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  rayPositions: Float32Array;
  label: HandLabel;
  /** 平滑化済みの 21 点（カメラ座標系）。未検出なら null */
  ema: Vec3[] | null;
  /** 前回検出した手首の生の位置（カメラ座標系。同じ手かどうかの照合に使う。EMA は遅れるので使わない） */
  lastWrist: Vec3;
  lastSeenMs: number;
  depth: number;
  /** 3D 化の当てはめ残差（HUD 用。実機で maxResidual を決める材料） */
  residual: number;
  /** 5 指先のワールド座標（今フレーム）と前フレーム（速度計算用） */
  tipsWorld: THREE.Vector3[];
  tipsWorldMs: number;
  prevTipsWorld: THREE.Vector3[] | null;
  prevTipsMs: number;
  /** 指差し判定のヒステリシス: 連続して判定が続いたフレーム数（負は非指差し） */
  pointingStreak: number;
  pointing: boolean;
  hoverTarget: number;
  dwellMs: number;
  /** 滞留で選択した後、的から視線が外れるまで再選択しない */
  dwellLatched: boolean;
};
const slots: HandSlot[] = [];
for (let i = 0; i < 2; i++) {
  const view = new HandView(HAND_COLORS["-"]);
  camera.add(view.group);
  const rayPositions = new Float32Array(6);
  const rayGeometry = new THREE.BufferGeometry();
  rayGeometry.setAttribute("position", new THREE.BufferAttribute(rayPositions, 3));
  const rayLine = new THREE.Line(
    rayGeometry,
    new THREE.LineBasicMaterial({ color: HAND_COLORS["-"], transparent: true, opacity: 0.6 }),
  );
  rayLine.frustumCulled = false;
  rayLine.visible = false;
  scene.add(rayLine);
  slots.push({
    view,
    rayLine,
    rayPositions,
    label: "-",
    ema: null,
    lastWrist: { x: 0, y: 0, z: 0 },
    lastSeenMs: -Infinity,
    depth: 0,
    residual: 0,
    tipsWorld: FINGER_TIPS.map(() => new THREE.Vector3()),
    tipsWorldMs: 0,
    prevTipsWorld: null,
    prevTipsMs: 0,
    pointingStreak: 0,
    pointing: false,
    hoverTarget: -1,
    dwellMs: 0,
    dwellLatched: false,
  });
}

// ---- レンダラー + 2眼（02 と同じ） ----
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
document
  .querySelector<HTMLDivElement>("#app")!
  .appendChild(renderer.domElement);

const effect = new StereoEffect(renderer);
effect.setEyeSeparation(EYE_SEP);

function resize() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  effect.setSize(innerWidth, innerHeight);
  updateBackgroundCover();
}
resize();
addEventListener("resize", resize);

// ---- Passthrough 背景（02 と同じ） ----
const video = document.createElement("video");
video.playsInline = true;
video.muted = true;

// PC デバッグ用フェイクカメラ（02 と同じテストパターン。手は映らないので、
// wasm・モデルの読み込みと推論ループが例外なく回ることの確認用）
function createFakeCameraStream(): MediaStream {
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 480;
  const ctx = canvas.getContext("2d")!;
  let frame = 0;
  const draw = () => {
    frame++;
    const cell = 40;
    for (let y = 0; y < canvas.height / cell; y++) {
      for (let x = 0; x < canvas.width / cell; x++) {
        ctx.fillStyle = (x + y) % 2 ? "#666" : "#999";
        ctx.fillRect(x * cell, y * cell, cell, cell);
      }
    }
    ctx.strokeStyle = "#f28b82";
    ctx.lineWidth = 12;
    ctx.strokeRect(0, 0, canvas.width, canvas.height);
    ctx.beginPath();
    ctx.arc(canvas.width / 2, canvas.height / 2, 120, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "#fdd663";
    ctx.fillRect(20, 20, (frame * 7) % 200, 12);
  };
  draw();
  const stream = canvas.captureStream(0);
  const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
  setInterval(() => {
    draw();
    track.requestFrame();
  }, 100);
  return stream;
}

// 超広角カメラ優先・解像度指定・フォールバックは 02 と同じ
const camResParsed = (params.get("camRes") ?? "").split(/x/i).map(Number);
const [CAM_W, CAM_H] =
  camResParsed.length === 2 &&
  camResParsed.every((v) => Number.isFinite(v) && v > 0)
    ? camResParsed
    : [1280, 720];
const camSize = { width: { ideal: CAM_W }, height: { ideal: CAM_H } };

async function openBackCameraStream(
  onProgress: (step: string) => void,
): Promise<MediaStream> {
  let stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: "environment" }, ...camSize },
    audio: false,
  });
  onProgress("gum-ok");
  if (params.get("lens") === "wide") return stream;
  const devices = await navigator.mediaDevices.enumerateDevices();
  const ultra = devices.find(
    (d) => d.kind === "videoinput" && /ultra wide|超広角/i.test(d.label),
  );
  if (!ultra) return stream;
  stream.getTracks().forEach((t) => t.stop());
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: ultra.deviceId }, ...camSize },
      audio: false,
    });
    onProgress("ultra-ok");
  } catch {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, ...camSize },
      audio: false,
    });
    onProgress("ultra-fail-fallback");
  }
  return stream;
}

async function startCamera(
  onProgress: (step: string) => void,
): Promise<string> {
  const stream = params.has("fakecam")
    ? createFakeCameraStream()
    : await openBackCameraStream(onProgress);
  video.srcObject = stream;
  await video.play();
  onProgress("play-ok");
  const texture = new THREE.VideoTexture(video);
  texture.colorSpace = THREE.SRGBColorSpace;
  scene.background = texture;
  updateBackgroundCover();
  video.addEventListener("resize", updateBackgroundCover);
  const label = stream.getVideoTracks()[0]?.label ?? "";
  // 実カメラの FOV はブラウザから取得できないので、レンズ種別のラベルから機種平均を推定する
  // （03/04 と同じ。詳細は PAIN_POINTS「カメラの焦点距離（内部パラメータ）がブラウザから取得できず」）
  camHFovDeg = params.has("camFov")
    ? numParam("camFov", 68, { min: 10, max: 170 })
    : /ultra wide|超広角/i.test(label)
      ? 106
      : 68;
  return `${video.videoWidth}x${video.videoHeight} ${label}`.trim();
}

// カメラ映像と片目ビューポートの縦横比補正（02 と同じ）。
// ここで決まる repeat が、手の画像位置 → 視線方向の変換（ViewMapping）にも使われる
function updateBackgroundCover() {
  const texture = scene.background;
  if (!(texture instanceof THREE.VideoTexture)) return;
  if (!video.videoWidth || !video.videoHeight) return;
  const eyeAspect = innerWidth / 2 / innerHeight;
  const videoAspect = video.videoWidth / video.videoHeight;
  let rx = 1;
  let ry = 1;
  if (videoAspect > eyeAspect) {
    rx = eyeAspect / videoAspect;
  } else {
    ry = videoAspect / eyeAspect;
  }
  rx /= CAM_ZOOM;
  ry /= CAM_ZOOM;
  texture.repeat.set(rx, ry);
  texture.offset.set((1 - rx) / 2, (1 - ry) / 2);
}

/**
 * 実カメラの FOV に基づく、画像位置 → 実世界の方向の対応（深度の実寸推定用）。
 * camHFovDeg は映像の長辺方向の FOV として扱う（縦持ちで映像が回転しても長辺に付く）
 */
function metricViewMapping(): ViewMapping | null {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;
  const t = Math.tan(THREE.MathUtils.degToRad(camHFovDeg) / 2);
  return {
    tanHalfFov: t * (vh / Math.max(vw, vh)),
    eyeAspect: vw / vh,
    repeatX: 1,
    repeatY: 1,
  };
}

/** 現在の背景の貼り方と仮想カメラから、画像位置 → 視線方向の対応を作る（hand-math.ts 参照） */
function currentViewMapping(): ViewMapping | null {
  const texture = scene.background;
  if (!(texture instanceof THREE.VideoTexture)) return null;
  return {
    tanHalfFov: Math.tan(THREE.MathUtils.degToRad(FOV) / 2),
    eyeAspect: innerWidth / 2 / innerHeight,
    repeatX: texture.repeat.x,
    repeatY: texture.repeat.y,
  };
}

// ---- 手トラッキング（MediaPipe。hand-tracker.ts 参照） ----
let tracker: HandTracker | null = null;
let trackerStatus = "idle";
let lastDetectAt = -Infinity;
/** 推論の間隔の移動平均 [ms]（HUD で実効レートを見るため） */
let detIntervalEma = 0;
let lastResultHands = 0;

let retriedWithCpu = false;
/** 直近の tracker の失敗理由（再初期化で trackerStatus が上書きされても HUD に残す） */
let lastTrackerError = "";

async function initTracker(
  delegate: typeof DELEGATE = DELEGATE,
  modelBuffer?: ArrayBuffer,
) {
  trackerStatus = "loading";
  try {
    tracker = await createHandTracker(
      {
        numHands: NUM_HANDS,
        delegate,
        modelBuffer,
        modelUrls: MODEL_URLS,
        minHandDetectionConfidence: MIN_DET,
        minHandPresenceConfidence: MIN_PRESENCE,
        minTrackingConfidence: MIN_TRACK,
        inputMaxSide: DET_W,
        inputMaxSideCpu: 640,
        canvas: MP_CANVAS_DOM ? document.createElement("canvas") : undefined,
      },
      (step) => {
        trackerStatus = `loading: ${step}`;
        renderHud();
      },
    );
    const modelSource =
      modelBuffer ? "reused" : tracker.modelUrl.startsWith("http") ? "remote" : "local";
    trackerStatus = `ready ${tracker.delegate} model=${modelSource}`;
    showTrackerState("ready");
  } catch (e: unknown) {
    trackerStatus = `error: ${e instanceof Error ? e.message : String(e)}`;
    showTrackerState("error");
  }
  renderHud();
}

// ゴーグル装着後は HUD（左下の小さな文字）が読めないので、ボールの見た目で状態を伝える:
// 読み込み中は灰色のワイヤーフレーム、ready で実体化、error で赤いワイヤーフレーム
function showTrackerState(state: "loading" | "ready" | "error") {
  ballMaterial.wireframe = state !== "ready";
  ballMaterial.transparent = state !== "ready";
  ballMaterial.opacity = state === "ready" ? 1 : 0.6;
  if (state === "error") {
    ballMaterial.color.setHex(0xf28b82);
  } else if (state === "loading") {
    ballMaterial.color.setHex(0x9aa0a6);
  } else {
    ballMaterial.color.setHex(ballColor);
  }
  ballMaterial.needsUpdate = true;
}

/**
 * 推論中の例外（GPU デリゲートは初期化は通るのに初回推論で落ちる端末がある、等）。
 * setAnimationLoop の中で投げると次フレームが予約されず画面ごと止まるので、ここで受けて
 * HUD に出す。auto で GPU だったなら一度だけ CPU で作り直す
 */
function onTrackerFailure(e: unknown) {
  console.error("[hand-tracker] 推論に失敗:", e);
  const msg = e instanceof Error ? e.message : String(e);
  lastTrackerError = `${tracker?.delegate ?? "?"}: ${msg}`;
  const failed = tracker;
  tracker = null;
  try {
    failed?.close();
  } catch {
    // close 自体の失敗は無視（既に壊れている）
  }
  if (failed?.delegate === "GPU" && DELEGATE === "auto" && !retriedWithCpu) {
    retriedWithCpu = true;
    trackerStatus = `GPU で推論失敗 → CPU で再初期化`;
    showTrackerState("loading");
    void initTracker("CPU", failed.modelBuffer); // モデルは取得済みのものを使い回す
  } else {
    trackerStatus = `error: 推論失敗 ${msg}`;
    showTrackerState("error");
  }
  renderHud();
}

const tmpVec = new THREE.Vector3();

let fakeStartMs = -1;
const fakeScene = { ballCam: new THREE.Vector3(), buttonCam: new THREE.Vector3(), targetCam: new THREE.Vector3() };

function updateFakeHands(now: number) {
  // カメラ（30fps 相当）の新フレームごとに台本の手を1つ返す
  if (now - lastDetectAt < 33 || !stageAligned) return;
  const mapping = currentViewMapping();
  if (!mapping) return;
  if (fakeStartMs < 0) fakeStartMs = now;
  if (lastDetectAt > 0) {
    detIntervalEma = detIntervalEma
      ? detIntervalEma * 0.9 + (now - lastDetectAt) * 0.1
      : now - lastDetectAt;
  }
  lastDetectAt = now;
  // 台本の目標（ボール・中央ボタン・2番目の的）をカメラ座標系で渡す
  camera.worldToLocal(stage.localToWorld(fakeScene.ballCam.copy(BALL_HOME)));
  // ボタンは押されるとメッシュが沈むので、動かない押し込み前の位置（homeZ）を目標にする
  // （メッシュ位置を追うと「押す → 沈む → 手も下がって離す → 戻る → また押す」のループになる）
  camera.worldToLocal(
    stage.localToWorld(
      fakeScene.buttonCam.set(buttons[1].mesh.position.x, buttons[1].mesh.position.y, buttons[1].homeZ),
    ),
  );
  camera.worldToLocal(stage.localToWorld(fakeScene.targetCam.copy(targets[1].mesh.position)));
  const result = scriptedHand((now - fakeStartMs) / 1000, fakeScene, mapping);
  if (result) applyHandResult(result, now);
  else lastResultHands = 0;
}

function updateHands(now: number) {
  if (FAKE_HANDS) updateFakeHands(now);
  const minInterval = tracker
    ? Math.max(DET_INTERVAL_MS, tracker.lastMs * DET_ADAPT)
    : 0;
  if (tracker && now - lastDetectAt >= minInterval) {
    let result: ReturnType<HandTracker["detect"]> = null;
    try {
      result = tracker.detect(video);
    } catch (e: unknown) {
      onTrackerFailure(e);
      return;
    }
    if (result) {
      if (lastDetectAt > 0) {
        detIntervalEma = detIntervalEma
          ? detIntervalEma * 0.9 + (now - lastDetectAt) * 0.1
          : now - lastDetectAt;
      }
      lastDetectAt = now;
      applyHandResult(result, now);
    }
  }
  // しばらく検出されていない手は消す（次に見つかったら平滑化もやり直す）
  for (const slot of slots) {
    if (slot.view.visible && now - slot.lastSeenMs > LOST_HIDE_MS) {
      slot.view.hide();
      slot.ema = null;
      slot.prevTipsWorld = null;
      slot.pointing = false;
      slot.pointingStreak = 0;
      slot.rayLine.visible = false;
      slot.hoverTarget = -1;
    }
  }
  // 指先のワールド座標は毎フレーム取り直す。骨格は camera の子なので頭の回転に毎フレーム
  // 追従するが、判定に使う座標が推論時（間引くと 100ms 以上前）の頭の向きのままだと、
  // 「骨格は触っているのに判定が外れる」が起きる（コードレビュー指摘）
  for (const slot of slots) {
    if (slot.view.visible && slot.ema) updateTipsWorld(slot);
  }
}

function updateTipsWorld(slot: HandSlot) {
  for (const [k, tipIndex] of FINGER_TIPS.entries()) {
    const p = slot.ema![tipIndex];
    slot.tipsWorld[k].set(p.x, p.y, p.z);
    camera.localToWorld(slot.tipsWorld[k]);
  }
}

/** HandLandmarkerResult のうち使う部分（合成の手 fake-hands.ts も同じ形で渡す） */
type HandResultLike = {
  landmarks: readonly (readonly Vec3[])[];
  worldLandmarks: readonly (readonly Vec3[])[];
  handedness: readonly (readonly { categoryName: string }[])[];
};

type DetectedHand = {
  label: HandLabel;
  /** カメラ座標系の 21 点 */
  points: Vec3[];
  world: readonly Vec3[];
  depth: number;
  residual: number;
};

function applyHandResult(result: HandResultLike, now: number) {
  const mapping = currentViewMapping();
  if (!mapping) return;
  // 深度（とその妥当性判定）だけ実寸基準で解く。x/y の重なりは表示基準（DEPTH_MODE 参照）
  const depthMapping =
    DEPTH_MODE === "metric" ? (metricViewMapping() ?? mapping) : mapping;
  lastResultHands = result.landmarks.length;

  // 1. 各検出を 3D 化する。形が崩れているもの・遠すぎるものはここで捨てる
  const detected: DetectedHand[] = [];
  for (const [i, landmarks] of result.landmarks.entries()) {
    const world = result.worldLandmarks[i];
    if (!world || landmarks.length < LANDMARK_COUNT || world.length < LANDMARK_COUNT) continue;
    const placement = solveHandPlacement(landmarks, world, depthMapping);
    if (!placement || placement.depth > MAX_DEPTH_M || placement.residual > MAX_RESIDUAL) continue;
    // Left/Right の扱いは HAND_COLORS のコメント参照（既定は入れ替えなし）
    const reported = result.handedness[i]?.[0]?.categoryName;
    const raw: HandLabel =
      reported === "Left" ? "L" : reported === "Right" ? "R" : "-";
    const label: HandLabel =
      SWAP_HANDS && raw !== "-" ? (raw === "L" ? "R" : "L") : raw;
    detected.push({
      label,
      points: placeLandmarks(landmarks, world, placement, mapping),
      world,
      depth: placement.depth,
      residual: placement.residual,
    });
    if (detected.length >= slots.length) break;
  }

  // 2. スロット割当: 表示中のスロットと手首の位置が近いもの同士を「同じ手の続き」として組む。
  //    左右ラベルは背面カメラでは1フレームだけ反転することがあるので、割当には使わず色にだけ使う
  //    （コードレビュー指摘: ラベルで固定すると反転のたびに骨格が2つ出て当たり判定がダブる）。
  //    照合は前回の「生の」手首位置と行う（EMA は遅れるので、速い手が別の手に見えてしまう）
  const assignment = new Map<HandSlot, DetectedHand>();
  const continuing = new Set<HandSlot>();
  const taken = new Set<DetectedHand>();
  const isLive = (s: HandSlot) => s.ema !== null && now - s.lastSeenMs <= LOST_HIDE_MS;
  const pairs: { slot: HandSlot; hand: DetectedHand; dist: number; limit: number }[] = [];
  for (const slot of slots) {
    if (!isLive(slot)) continue;
    const limit = MATCH_DIST_M + (MATCH_SPEED_MPS * (now - slot.lastSeenMs)) / 1000;
    for (const hand of detected) {
      const a = slot.lastWrist;
      const b = hand.points[WRIST];
      pairs.push({ slot, hand, dist: Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z), limit });
    }
  }
  pairs.sort((p, q) => p.dist - q.dist);
  for (const { slot, hand, dist, limit } of pairs) {
    if (dist > limit) continue;
    if (assignment.has(slot) || taken.has(hand)) continue;
    assignment.set(slot, hand);
    continuing.add(slot);
    taken.add(hand);
  }
  // 続きと判定できなかった手の置き場所。MediaPipe は NUM_HANDS を超える手を返さないので、
  // 「表示中のスロット + 未対応の手」が NUM_HANDS を超えるなら、未対応の表示中スロットの
  // どれかは同じ手が閾値を超えて動いただけ → 最も古いものを乗っ取る（骨格が2本出るのを防ぐ）。
  // 超えないなら本当に新しい手なので、非表示のスロットに入れる
  for (const hand of detected) {
    if (taken.has(hand)) continue;
    const liveUnassigned = slots
      .filter((s) => !assignment.has(s) && isLive(s))
      .sort((a, b) => a.lastSeenMs - b.lastSeenMs);
    const liveCount = slots.filter((s) => isLive(s) || assignment.has(s)).length;
    const mustReuse = liveUnassigned.length > 0 && liveCount + 1 > NUM_HANDS;
    const target = mustReuse
      ? liveUnassigned[0]
      : (slots.find((s) => !assignment.has(s) && !isLive(s)) ?? liveUnassigned[0]);
    if (!target) break;
    assignment.set(target, hand);
    taken.add(hand);
  }

  // 3. スロットを更新
  for (const [slot, hand] of assignment) {
    updateSlot(slot, hand, now, continuing.has(slot));
  }
}

/** @param continuing 前フレームの同じ手の続きなら true（平滑化・速度を引き継ぐ） */
function updateSlot(slot: HandSlot, hand: DetectedHand, now: number, continuing: boolean) {
  if (continuing && slot.ema) {
    for (let k = 0; k < LANDMARK_COUNT; k++) {
      const e = slot.ema[k];
      e.x += (hand.points[k].x - e.x) * SMOOTH;
      e.y += (hand.points[k].y - e.y) * SMOOTH;
      e.z += (hand.points[k].z - e.z) * SMOOTH;
    }
  } else {
    // 新しく見つけた手（または別の手に入れ替わった）: 前の手の速度・指差し状態を引き継がない
    slot.ema = hand.points;
    slot.prevTipsWorld = null;
    slot.pointingStreak = 0;
    slot.pointing = false;
    slot.hoverTarget = -1;
    slot.dwellMs = 0;
    slot.dwellLatched = false;
  }
  if (slot.label !== hand.label) {
    slot.label = hand.label;
    slot.view.setColor(HAND_COLORS[hand.label]);
    slot.rayLine.material.color.setHex(HAND_COLORS[hand.label]);
  }
  slot.view.update(slot.ema);
  slot.depth = hand.depth;
  slot.residual = hand.residual;
  slot.lastSeenMs = now;
  slot.lastWrist = hand.points[WRIST];

  // 指先のワールド座標（カメラの子なので camera.matrixWorld で変換）。前フレームは速度計算用に残す
  const hadPrev = slot.prevTipsWorld !== null;
  if (slot.prevTipsWorld) {
    for (const [k, v] of slot.prevTipsWorld.entries()) v.copy(slot.tipsWorld[k]);
    slot.prevTipsMs = slot.tipsWorldMs;
  }
  updateTipsWorld(slot);
  slot.tipsWorldMs = now;
  if (!hadPrev) {
    // 見つけた最初のフレームは「前 = 今」にして速度 0 から始める（原点からの大速度を作らない）
    slot.prevTipsWorld = slot.tipsWorld.map((v) => v.clone());
    slot.prevTipsMs = now;
  }

  // 指差しポーズ（実寸の worldLandmarks で判定）。数フレーム続いたら切り替える
  const pointingNow = isPointingPose(hand.world);
  slot.pointingStreak = pointingNow
    ? Math.max(1, slot.pointingStreak + 1)
    : Math.min(-1, slot.pointingStreak - 1);
  if (slot.pointingStreak >= 3) slot.pointing = true;
  if (slot.pointingStreak <= -3) slot.pointing = false;
}

// ---- 操作 1: ボールを押す ----
const SPRING_K = 10; // ばね定数（定位置へ戻す強さ）
const SPRING_C = 4; // 減衰（臨界減衰 2√K ≈ 6.3 より弱めにして少し揺れるように）
const tmpLocal = new THREE.Vector3();
const tmpPrevLocal = new THREE.Vector3();
const tmpNormal = new THREE.Vector3();
const tmpVel = new THREE.Vector3();

function updateBall(dt: number, now: number) {
  for (const slot of slots) {
    if (!slot.view.visible) continue;
    const tipDt = slot.prevTipsWorld ? (slot.tipsWorldMs - slot.prevTipsMs) / 1000 : 0;
    for (const [k, tipWorld] of slot.tipsWorld.entries()) {
      // ボールはステージ座標系で動かすので、指先もそこへ持ち込む
      stage.worldToLocal(tmpLocal.copy(tipWorld));
      const d = tmpLocal.distanceTo(ballPos);
      if (d >= BALL_R + TIP_R) continue;
      if (d > 1e-6) {
        tmpNormal.subVectors(ballPos, tmpLocal).divideScalar(d);
      } else {
        tmpNormal.set(0, 0, -1);
      }
      // 指先の速度の、ボール方向の成分で押す。止まった指が触れているだけでも最低速度で押し出す
      let speedAlong = 0;
      if (slot.prevTipsWorld && tipDt > 0) {
        stage.worldToLocal(tmpPrevLocal.copy(slot.prevTipsWorld[k]));
        speedAlong = tmpVel.subVectors(tmpLocal, tmpPrevLocal).divideScalar(tipDt).dot(tmpNormal);
      }
      const push = THREE.MathUtils.clamp(Math.max(0.5, speedAlong * 1.2), 0.5, 2.5);
      const current = ballVel.dot(tmpNormal);
      if (current < push) ballVel.addScaledVector(tmpNormal, push - current);
      // めり込み分を押し戻す
      ballPos.addScaledVector(tmpNormal, BALL_R + TIP_R - d);
      if (now - lastTouchMs > 150) touches++;
      lastTouchMs = now;
      ballMaterial.emissiveIntensity = 0.8;
    }
  }
  // ばね + 減衰で定位置へ
  tmpVec.subVectors(BALL_HOME, ballPos).multiplyScalar(SPRING_K);
  tmpVec.addScaledVector(ballVel, -SPRING_C);
  ballVel.addScaledVector(tmpVec, dt);
  ballPos.addScaledVector(ballVel, dt);
  ball.position.copy(ballPos);
  ballMaterial.emissiveIntensity = Math.max(0, ballMaterial.emissiveIntensity - dt * 2);
}

// ---- 操作 2: ボタンを押す ----
const tmpBox = new THREE.Box3();
const tmpBoxSize = new THREE.Vector3();
// 当たり箱は表面から奥（プレート側）へ深く取る。指が奥へ突き抜けても押したまま扱い、
// 引き戻す途中で二重に押下したことにならないように（深度推定は数 cm ぶれる前提）
const BUTTON_THROUGH_DEPTH = 0.06;
function updateButtons() {
  for (const button of buttons) {
    tmpBox.setFromCenterAndSize(
      tmpVec.set(button.mesh.position.x, button.mesh.position.y, button.homeZ - BUTTON_THROUGH_DEPTH / 2),
      tmpBoxSize.set(BUTTON_SIZE.x, BUTTON_SIZE.y, BUTTON_SIZE.z + BUTTON_THROUGH_DEPTH),
    );
    tmpBox.expandByScalar(TIP_R);
    let inside = false;
    for (const slot of slots) {
      if (!slot.view.visible) continue;
      for (const tipWorld of slot.tipsWorld) {
        if (tmpBox.containsPoint(stage.worldToLocal(tmpLocal.copy(tipWorld)))) {
          inside = true;
          break;
        }
      }
      if (inside) break;
    }
    if (inside && !button.pressed) {
      button.pressed = true;
      presses++;
      ballColor = button.color;
      ballMaterial.color.setHex(button.color);
      ballMaterial.emissive.setHex(button.color);
      ballHomeGhost.material.color.setHex(button.color);
    } else if (!inside && button.pressed) {
      button.pressed = false;
    }
    // 押されている間は奥へ沈めて光らせる（指を離すまで保持）
    button.mesh.position.z = button.homeZ + (button.pressed ? -0.012 : 0);
    button.mesh.material.emissiveIntensity = button.pressed ? 0.6 : 0;
  }
}

// ---- 操作 3: 指差しで的を選ぶ ----
// 視線は「カメラ（≒目）→ 人差し指の先」。指の向き（付け根 → 先）は 4cm 程度の
// 短い基線から作るためブレが大きく、深度推定の誤差も増幅される。目と指先を結ぶ
// 視線なら、指先の画像上の位置だけで決まるので安定し、「的を指先で隠す」操作になる
const raycaster = new THREE.Raycaster();
raycaster.near = 0.05;
raycaster.far = 10;
const camWorldPos = new THREE.Vector3();
const rayDir = new THREE.Vector3();
const rayEnd = new THREE.Vector3();
const targetMeshes = targets.map((t) => t.mesh);
/** 的ごとの滞留進捗（0..1、表示用）。毎フレーム使い回す */
const hovered = targets.map(() => 0);

function updatePointing(dt: number) {
  hovered.fill(0);
  camera.getWorldPosition(camWorldPos);
  for (const slot of slots) {
    if (!slot.view.visible || !slot.pointing) {
      slot.rayLine.visible = false;
      slot.hoverTarget = -1;
      slot.dwellMs = 0;
      slot.dwellLatched = false;
      continue;
    }
    const tip = slot.tipsWorld[FINGER_TIPS.indexOf(INDEX_TIP)];
    rayDir.subVectors(tip, camWorldPos).normalize();
    raycaster.set(camWorldPos, rayDir);
    const hit = raycaster.intersectObjects(targetMeshes, false)[0];
    const hitIndex = hit ? targets.findIndex((t) => t.mesh === hit.object) : -1;
    if (hitIndex !== slot.hoverTarget) {
      slot.hoverTarget = hitIndex;
      slot.dwellMs = 0;
      slot.dwellLatched = false;
    } else if (hitIndex >= 0 && !slot.dwellLatched) {
      slot.dwellMs += dt * 1000;
      if (slot.dwellMs >= DWELL_MS) {
        targets[hitIndex].selected = !targets[hitIndex].selected;
        selections++;
        slot.dwellLatched = true; // 視線が外れるまで再選択しない
      }
    }
    if (hitIndex >= 0 && !slot.dwellLatched) {
      hovered[hitIndex] = Math.max(hovered[hitIndex], slot.dwellMs / DWELL_MS);
    }
    // 指先から先（当たった点、無ければ 3m 先）まで線を引く
    rayEnd.copy(hit ? hit.point : tmpVec.copy(camWorldPos).addScaledVector(rayDir, 3));
    slot.rayPositions.set([tip.x, tip.y, tip.z, rayEnd.x, rayEnd.y, rayEnd.z]);
    slot.rayLine.geometry.attributes.position.needsUpdate = true;
    slot.rayLine.visible = true;
  }
  for (const [i, target] of targets.entries()) {
    target.mesh.material.color.setHex(target.selected ? 0x81c995 : 0x9aa0a6);
    target.mesh.material.emissiveIntensity = hovered[i] * 0.8;
  }
}

// ---- ステージの向き合わせ（正面を決める） ----
// DeviceOrientationControls の yaw はコンパス基準なので、開始時にユーザーがどちらを向いて
// いるかは分からない。three-stdlib は最初のセンサーイベントまで deviceOrientation を全ゼロ
// （= 真下を向いたクォータニオン）で持つので、camera.quaternion をそのまま信じると誤る。
// そこで (1) 実際に deviceorientation イベントを受けてから、(2) 横向きで、(3) 頭が水平
// （上下 30° 以内）な状態が ALIGN_HOLD_MS 続いた所で「装着して前を向いた」とみなして揃える。
// 開始タップや fs-button の 2 タップ目はスマホを顔の前に持った姿勢で行われ、そのときの
// 向きで確定すると装着後に目の前に出ないことがあるため、瞬間ではなく継続で判定する。
// 揃えた後も、正面から 90° 超ずれた状態が RECENTER_MS 続いたら取り直す（装着中はタップ
// できないので、体ごと向きを変えたときの自動再センター）
let orientationReceived = false;
/** センサー許可の結果が出た（許可 / 拒否 / 不要）か。許可ダイアログ中は controls が null のままなので、
 *  それを「頭追従なし」と誤認して整列しないためのフラグ */
let sensorSettled = false;
const forward = new THREE.Vector3();
let levelSinceMs = -1;
let offAxisSinceMs = -1;

function isLevelForward(): boolean {
  forward.set(0, 0, -1).applyQuaternion(camera.quaternion);
  return Math.abs(forward.y) <= 0.5;
}

/** 視線の水平方向（fwd）を正面にしてステージを回す */
function alignStage(fwd: THREE.Vector3) {
  stage.rotation.y = Math.atan2(-fwd.x, -fwd.z);
  stage.updateMatrixWorld(true);
  stageAligned = true;
}

function alignStageIfNeeded(now: number) {
  if (!sensorSettled) return;
  if (!(controls instanceof DeviceOrientationControls)) {
    // PC（OrbitControls）や、センサー許可が拒否されて頭追従が無い場合: 初期の向きが正面
    if (!stageAligned) {
      forward.set(0, 0, -1).applyQuaternion(camera.quaternion);
      alignStage(forward);
    }
    return;
  }
  if (!orientationReceived) return;
  if (!stageAligned) {
    const landscape = innerWidth > innerHeight;
    if (landscape && isLevelForward()) {
      if (levelSinceMs < 0) levelSinceMs = now;
      if (now - levelSinceMs >= ALIGN_HOLD_MS) alignStage(forward);
    } else {
      levelSinceMs = -1;
    }
    return;
  }
  if (RECENTER_MS <= 0) return;
  // 視線の yaw とステージの正面の差（水平成分だけ見る）
  forward.set(0, 0, -1).applyQuaternion(camera.quaternion);
  const yaw = Math.atan2(-forward.x, -forward.z);
  let diff = Math.abs(yaw - stage.rotation.y) % (Math.PI * 2);
  if (diff > Math.PI) diff = Math.PI * 2 - diff;
  if (diff > Math.PI / 2 && isLevelForward()) {
    if (offAxisSinceMs < 0) offAxisSinceMs = now;
    if (now - offAxisSinceMs >= RECENTER_MS) {
      alignStage(forward);
      offAxisSinceMs = -1;
    }
  } else {
    offAxisSinceMs = -1;
  }
}

// ---- 頭追従（02 と同じ。PC は OrbitControls） ----
type HeadControls = { update: () => void };
let controls: HeadControls | null = null;
const isTouchDevice = matchMedia("(pointer: coarse)").matches;

function startControls() {
  if (isTouchDevice) {
    controls = new DeviceOrientationControls(camera);
    // 向き合わせ用: 実際にセンサー値が届いたことを知る（controls は初期値を全ゼロで持つため区別できない）
    addEventListener(
      "deviceorientation",
      () => {
        orientationReceived = true;
      },
      { once: true },
    );
  } else {
    const orbit = new OrbitControls(camera, renderer.domElement);
    orbit.target.set(0, 1.6, -0.01);
    orbit.enableZoom = false;
    orbit.enablePan = false;
    orbit.rotateSpeed = -0.5;
    controls = orbit;
  }
}

// ---- 全画面化（02 と同じ） ----
function enterFullscreen(onStatus: (status: string) => void) {
  const el = document.documentElement;
  if (!el.requestFullscreen) {
    onStatus("unsupported");
    return;
  }
  el.requestFullscreen().then(
    () => onStatus("ok"),
    (e) => onStatus(e instanceof Error ? `${e.name}: ${e.message}` : String(e)),
  );
}

// ---- デバッグ用 HUD（02 と同じ + 手の検出状態） ----
const hud = document.querySelector<HTMLDivElement>("#hud")!;
const hudState = { base: "", sensor: "", cam: "", fsResult: "", fsChange: "" };
let lastHudText = "";
function renderHud() {
  const handLines = slots
    .filter((s) => s.view.visible)
    .map((s) => `${s.label}:${s.depth.toFixed(2)}m res=${s.residual.toFixed(3)}${s.pointing ? " point" : ""}`)
    .join(" ");
  const pointing = slots
    .filter((s) => s.pointing && s.hoverTarget >= 0)
    .map((s) => `${s.label}→target${s.hoverTarget + 1} ${s.dwellLatched ? "done" : `${Math.round((s.dwellMs / DWELL_MS) * 100)}%`}`)
    .join(" ");
  const text = [
    hudState.base,
    hudState.sensor && `sensor=${hudState.sensor}`,
    hudState.cam && `cam=${hudState.cam}`,
    hudState.fsResult && `fs=${hudState.fsResult}`,
    hudState.fsChange && `fs-change: ${hudState.fsChange}`,
    `tracker=${trackerStatus}${lastTrackerError ? ` (last error: ${lastTrackerError})` : ""}`,
    (tracker || FAKE_HANDS) &&
      `hands=${lastResultHands} ${handLines || "-"} infer=${(tracker?.lastMs ?? 0).toFixed(0)}ms every ${detIntervalEma.toFixed(0)}ms in=${tracker?.lastInput || "-"}`,
    pointing && `point: ${pointing}`,
    `touches=${touches} presses=${presses} selects=${selections} stage=${stageAligned ? "aligned" : sensorSettled ? "waiting(level)" : "waiting(permission)"}`,
  ]
    .filter(Boolean)
    .join("\n");
  // 毎フレーム呼ばれるので、変化が無ければ DOM を触らない（レイアウトを走らせない）
  if (text !== lastHudText) {
    lastHudText = text;
    hud.textContent = text;
  }
}

// ---- 開始フロー（02 と同じ直列化。iOS の制約はそちらのコメント参照） ----
const fsButton = document.querySelector<HTMLButtonElement>("#fs-button")!;

function tryEnterFullscreen() {
  fsButton.hidden = true;
  enterFullscreen((status) => {
    hudState.fsResult = status;
    renderHud();
    if (status !== "ok" && status !== "unsupported") fsButton.hidden = false;
  });
}

fsButton.addEventListener("click", tryEnterFullscreen);

const startButton = document.querySelector<HTMLButtonElement>("#start-button")!;
startButton.addEventListener("click", () => {
  document.body.classList.add("started");
  hudState.base = `fov=${FOV} eyeSep=${EYE_SEP} mode=${isTouchDevice ? "gyro" : "orbit"} hands=${NUM_HANDS} delegate=${DELEGATE} smooth=${SMOOTH} detW=${DET_W} detAdapt=${DET_ADAPT} detIntervalMs=${DET_INTERVAL_MS} depth=${DEPTH_MODE}`;
  renderHud();
  // wasm + モデルの読み込み（数秒）は許可ダイアログと並行して進める。カメラの成否とは独立
  if (FAKE_HANDS) {
    trackerStatus = "fake (scripted hand, MediaPipe 未使用)";
    showTrackerState("ready");
  } else {
    showTrackerState("loading");
    void initTracker();
  }

  async function startCameraWithHud() {
    hudState.cam = "requesting";
    renderHud();
    try {
      hudState.cam = await startCamera((step) => {
        hudState.cam = step;
        renderHud();
      });
      hudState.base += ` camFov=${camHFovDeg}`;
    } catch (e: unknown) {
      hudState.cam = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    }
    renderHud();
  }

  if (!isTouchDevice) {
    startControls();
    sensorSettled = true;
    void startCameraWithHud();
    return;
  }

  const doe = DeviceOrientationEvent as unknown as {
    requestPermission?: () => Promise<"granted" | "denied">;
  };
  if (!doe.requestPermission) {
    startControls();
    sensorSettled = true;
    startCameraWithHud().then(tryEnterFullscreen);
    return;
  }

  doe
    .requestPermission()
    .then(async (state) => {
      hudState.sensor = state;
      renderHud();
      if (state === "granted") startControls();
      sensorSettled = true; // 拒否でも確定（頭追従なしで正面に置く）
      await startCameraWithHud();
      if (state === "granted") tryEnterFullscreen();
    })
    .catch(async (e: unknown) => {
      hudState.sensor =
        e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      sensorSettled = true;
      renderHud();
      await startCameraWithHud();
    });
});

document.addEventListener("fullscreenchange", () => {
  const inFullscreen = Boolean(document.fullscreenElement);
  hudState.fsChange = inFullscreen ? "enter" : "exit";
  renderHud();
  if (isTouchDevice && document.body.classList.contains("started")) {
    fsButton.hidden = inFullscreen;
  }
});

// bfcache から復帰したとき、カメラストリームが止まっている可能性を HUD に出す
// （02/03/04 と共通の未対応領域。PAIN_POINTS 参照）
addEventListener("pageshow", (e) => {
  if (!e.persisted) return;
  if (!document.body.classList.contains("started")) return;
  if (hudState.cam && !hudState.cam.includes("bfcache")) {
    hudState.cam += " (bfcache: カメラ停止の可能性)";
  }
  renderHud();
});

// PC デバッグ用: ?autostart=1 で開始ボタンを自動クリックする
if (params.has("autostart")) startButton.click();

// ---- ループ ----
let lastFrameMs = performance.now();
renderer.setAnimationLoop(() => {
  const now = performance.now();
  // バックグラウンドから戻った直後などの巨大な dt で物理が飛ばないように上限を付ける
  const dt = Math.min(0.05, (now - lastFrameMs) / 1000);
  lastFrameMs = now;
  controls?.update();
  // 手のワールド座標（camera.localToWorld）に今フレームの頭の向きを反映させる。
  // 通常は render 時に更新されるので、その前に使うここで明示的に更新する
  camera.updateMatrixWorld();
  alignStageIfNeeded(now);
  updateHands(now);
  updateBall(dt, now);
  updateButtons();
  updatePointing(dt);
  if (document.body.classList.contains("started")) renderHud();
  effect.render(scene, camera);
});
