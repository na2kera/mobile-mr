import * as THREE from "three";
import { StereoEffect } from "three/examples/jsm/effects/StereoEffect.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { DeviceOrientationControls } from "three-stdlib";
import { createMarkerDetector } from "../../src/shared/marker-detector";
import type { MarkerObservation } from "../../src/shared/marker-detector";
import { ROOM_ID_PATTERN } from "../../src/shared/shared-room-protocol";
import type { PoseData } from "../../src/shared/shared-room-protocol";
import { connectRoom } from "./room-client";
import type { RoomClient } from "./room-client";
import markerSvgUrl from "../../src/shared/marker-0.svg";

// Phase 4: 2 Player Shared MR。
// 全端末が同じマーカー（World Origin）を見ることで共通座標系を作り、
// マーカー座標系での自分のカメラ姿勢を WebSocket で交換して、
// 相手の位置にアバターを描画する。マーカーは机に水平に置き、2人で挟んで
// 向かい合う想定（両者の視界に常にマーカーが入り、視界喪失の制約を踏まない）。
// カメラ・マーカー検出・開始フローは 03-marker-anchor と同じ（詳細コメントはそちら）

// ---- ゴーグル調整パラメータ（03 と同じ。URL クエリで実機合わせ込み） ----
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

// ---- マーカー関連パラメータ（03 と同じ） ----
const MARKER_MM = numParam("markerMm", 100, { max: 5000 });
const MARKER_SIZE_M = MARKER_MM / 1000;
const MARKER_ID = Math.round(numParam("markerId", 0, { min: 0, max: 999 }));
const MAX_POSE_ERROR = numParam("maxPoseError", 0.5, { min: 0, max: 100 });
// detW の既定は 03 の 640 ではなく 960。マルチプレイヤーでは「相手との距離 =
// マーカーからの距離」になり、640 だと 1〜2m で検出が途切れて相手の位置がぶれる
// （iPhone 2台の実機検証 2026-08-20: 960 で約 2.5m まで安定、検出 20ms 前後で許容内。
// 詳細は docs/PAIN_POINTS.md「マーカー検出の実用距離が短く、離れると位置がぶれる」）
const DET_W = numParam("detW", 960, { min: 64, max: 4096 });
const SMOOTH = numParam("smooth", 0.25, { min: 0.01, max: 1 });
const LOST_HIDE_MS = numParam("lostHideMs", 500, { min: 50, max: 10000 });
let camHFovDeg = 68;

// ---- Room 関連パラメータ ----
// room: 同じ値を開いた端末同士が同じ空間に入る。未指定なら既定の "demo"。
// 指定があるのに形式外の場合は null にして接続を止め、エラーを表示する
// （コードレビュー指摘: 黙って既定に落とすと、別 Room のつもりの利用者同士が
// demo に合流して Room 隔離が意図せず破られる）
const roomRaw = params.get("room");
const ROOM =
  roomRaw === null ? "demo" : ROOM_ID_PATTERN.test(roomRaw) ? roomRaw : null;
// sendHz: 自分の姿勢を送る頻度。人の移動は遅いので 10Hz で十分（受信側で補間する）
const SEND_INTERVAL_MS = 1000 / numParam("sendHz", 10, { min: 1, max: 60 });
// peerStaleMs: 相手の姿勢がこの時間更新されなかったら表示を消す（切断・タブ非表示など。
// 送信間隔の数倍あれば通常のゆらぎでは消えない）
const PEER_STALE_MS = numParam("peerStaleMs", 2000, { min: 200, max: 30000 });
// peerSmooth: 受信姿勢（10Hz）を描画（60fps）に馴染ませる指数移動平均係数
const PEER_SMOOTH = numParam("peerSmooth", 0.25, { min: 0.01, max: 1 });

// ---- シーン ----
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a2233);

const camera = new THREE.PerspectiveCamera(
  FOV,
  innerWidth / innerHeight,
  0.1,
  100,
);
camera.position.set(0, 1.6, 0);

scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.2));
const dirLight = new THREE.DirectionalLight(0xffffff, 1.5);
dirLight.position.set(3, 10, 2);
scene.add(dirLight);

// ---- アンカー（マーカー座標系。03 と同じ役割） ----
// このデモではアンカーの transform が「マーカー座標系 → ワールド」の変換そのもの。
// ピアのアバターを anchor の子にすることで、受信したマーカー座標系の姿勢を
// ローカル座標としてそのまま入れられる（ワールド合成は three.js に任せる）。
// anchor 非表示（ロスト）時にピアも一緒に消えるのも都合が良い:
// 自分の原点が現実に追従していない間は、相手の表示位置も保証できないため
const anchor = new THREE.Group();
anchor.visible = false;
scene.add(anchor);

// マーカー実寸の枠と軸（位置合わせの正解確認用。03 と同じ、注意書きもそちら参照）
const markerFrame = new THREE.Mesh(
  new THREE.PlaneGeometry(MARKER_SIZE_M, MARKER_SIZE_M),
  new THREE.MeshBasicMaterial({
    color: 0x8ab4f8,
    transparent: true,
    opacity: 0.4,
    side: THREE.DoubleSide,
  }),
);
anchor.add(markerFrame);
anchor.add(new THREE.AxesHelper(MARKER_SIZE_M));

// ---- ピア（同室の他端末）のアバター ----
type Peer = {
  group: THREE.Group;
  /** アバターの不透明度を tracking 状態で切り替えるための材質 */
  materials: THREE.Material[];
  targetPos: THREE.Vector3;
  targetQuat: THREE.Quaternion;
  /** 最後に pose を受信した時刻 [ms]。初回受信までは -Infinity（未受信は非表示） */
  lastPoseMs: number;
  /** 相手側でマーカーが視界にあるか（false = 相手がロスト中で位置が古い） */
  tracking: boolean;
};
const peers = new Map<string, Peer>();
let selfId = "";
let netStatus = "idle";
let roomClient: RoomClient | null = null;
let loggedFirstPeerPose = false;

// id（p1, p2, ...）から見分けやすい色を作る（黄金角で色相を散らす）
function peerColor(id: string): THREE.Color {
  const n = Number(id.replace(/\D/g, "")) || 0;
  return new THREE.Color().setHSL(((n * 137.5) % 360) / 360, 0.7, 0.6);
}

// ジオメトリは全ピアで共有する（removePeer で dispose しなくて済み、再接続の
// たびにピアを作り直しても GPU バッファが増えない。コードレビュー指摘対応）
const peerHeadGeometry = new THREE.SphereGeometry(0.08, 24, 16);
const peerNoseGeometry = new THREE.ConeGeometry(0.035, 0.09, 16);

// アバター = 頭の球 + 視線方向を示すコーン。ピアの pose は「カメラの姿勢」なので、
// 群のローカル -Z が相手の視線方向になる（three.js のカメラ既定と同じ向き）
function createPeer(id: string): Peer {
  const color = peerColor(id);
  const headMat = new THREE.MeshStandardMaterial({
    color,
    transparent: true,
  });
  const noseMat = new THREE.MeshStandardMaterial({
    color: color.clone().offsetHSL(0, 0, -0.2),
    transparent: true,
  });
  const group = new THREE.Group();
  group.add(new THREE.Mesh(peerHeadGeometry, headMat));
  const nose = new THREE.Mesh(peerNoseGeometry, noseMat);
  nose.rotation.x = -Math.PI / 2; // コーンの既定 +Y を視線方向 -Z に向ける
  nose.position.z = -0.1;
  group.add(nose);
  group.visible = false; // 初回の pose 受信まで非表示（位置が未定のため）
  anchor.add(group);
  const peer: Peer = {
    group,
    materials: [headMat, noseMat],
    targetPos: new THREE.Vector3(),
    targetQuat: new THREE.Quaternion(),
    lastPoseMs: -Infinity,
    tracking: false,
  };
  peers.set(id, peer);
  return peer;
}

function removePeer(id: string) {
  const peer = peers.get(id);
  if (!peer) return;
  peer.group.removeFromParent();
  peer.materials.forEach((m) => m.dispose());
  peers.delete(id);
}

// 受信 pose（10Hz、マーカー座標系）を目標値として保存し、描画ループで補間する
function onPeerPose(id: string, pose: PoseData) {
  // pose が join より先に届くことは無い想定だが、順序に依存しないよう無ければ作る
  const peer = peers.get(id) ?? createPeer(id);
  peer.targetPos.set(...pose.pos);
  peer.targetQuat.set(...pose.quat);
  peer.tracking = pose.tracking;
  const now = performance.now();
  if (now - peer.lastPoseMs > PEER_STALE_MS) {
    // 初回（lastPoseMs=-Infinity）と、非表示になるほど途絶したあとの復帰はスナップ
    // （古い位置から部屋を横切って lerp で滑ってくるのを防ぐ。03 の初検出と同じ理由。
    // コードレビュー指摘: 初回だけのスナップだと途絶復帰時に旧位置から滑る）
    peer.group.position.copy(peer.targetPos);
    peer.group.quaternion.copy(peer.targetQuat);
  }
  peer.lastPoseMs = now;
  if (!loggedFirstPeerPose) {
    loggedFirstPeerPose = true;
    // ヘッドレス自動確認用（fakecam 2タブ検証で位置が届いたことを見る）
    console.log(
      `[room] first peer pose from ${id} pos=(${pose.pos.map((v) => v.toFixed(3)).join(", ")}) tracking=${pose.tracking}`,
    );
  }
}

// 描画ループから毎フレーム: ピアを目標姿勢へ補間し、鮮度と tracking で表示を調整する
let lastPeerUpdateMs = performance.now();
function updatePeers() {
  const now = performance.now();
  // 補間係数をフレーム時間で補正する（60fps 換算。定数係数のままだと収束速度が
  // 端末のフレームレートに比例し、熱で 30fps に落ちた端末だけ相手のアバターが
  // 目に見えて遅れる。コードレビュー指摘対応）。タブ復帰などの巨大な dt は
  // 4フレーム分に丸めて一気に飛びすぎないようにする
  const dtFrames = Math.min((now - lastPeerUpdateMs) / (1000 / 60), 4);
  lastPeerUpdateMs = now;
  const alpha = 1 - Math.pow(1 - PEER_SMOOTH, dtFrames);
  for (const peer of peers.values()) {
    if (peer.lastPoseMs === -Infinity) continue; // pose 未受信
    const stale = now - peer.lastPoseMs > PEER_STALE_MS;
    peer.group.visible = !stale;
    if (stale) continue;
    peer.group.position.lerp(peer.targetPos, alpha);
    peer.group.quaternion.slerp(peer.targetQuat, alpha);
    // 相手がマーカーロスト中は位置の保証が無いので半透明にして「怪しさ」を示す
    // （完全に消すと通信断と区別できないため区別のつく見た目にする）
    const opacity = peer.tracking ? 1 : 0.3;
    for (const m of peer.materials) m.opacity = opacity;
  }
}

// ---- 自分の姿勢の送信 ----
// マーカー座標系での自分のカメラ姿勢 = anchor（マーカー→ワールド）の逆行列 × カメラのワールド行列。
// 検出の生値ではなく平滑化済みの anchor を使う（送る座標系と自分の描画座標系を一致させる）
const inverseAnchor = new THREE.Matrix4();
const poseMatrix = new THREE.Matrix4();
const posePos = new THREE.Vector3();
const poseQuat = new THREE.Quaternion();
const poseScale = new THREE.Vector3();
let lastSendMs = -Infinity;

function sendPoseIfDue() {
  if (!roomClient) return;
  if (lastAcceptedMs === -Infinity) return; // マーカー初検出まで座標系が無い
  const now = performance.now();
  if (now - lastSendMs < SEND_INTERVAL_MS) return;
  lastSendMs = now;
  camera.updateMatrixWorld();
  anchor.updateMatrixWorld();
  // anchor はロストで visible=false になっても最後の姿勢を保持しているので、
  // ロスト中も tracking=false を付けて送り続ける（受信側が半透明表示にする）
  inverseAnchor.copy(anchor.matrixWorld).invert();
  poseMatrix.multiplyMatrices(inverseAnchor, camera.matrixWorld);
  poseMatrix.decompose(posePos, poseQuat, poseScale);
  roomClient.sendPose({
    pos: [posePos.x, posePos.y, posePos.z],
    quat: [poseQuat.x, poseQuat.y, poseQuat.z, poseQuat.w],
    tracking: now - lastAcceptedMs <= LOST_HIDE_MS,
  });
}

function connect() {
  if (ROOM === null) return; // 不正 room 名（開始ボタン側でエラー表示済み）
  // 空間設定（markerId / markerMm）を申告し、Room 内の全員一致をサーバーに検証させる
  roomClient = connectRoom(ROOM, { markerId: MARKER_ID, markerMm: MARKER_MM }, {
    onStatus: (status) => {
      netStatus = status;
    },
    onError: (reason) => {
      // 入室拒否（バージョン・空間設定の不一致）。再接続は room-client 側で停止済み
      netStatus = `error: ${reason}`;
      console.warn(`[room] rejected: ${reason}`);
    },
    onWelcome: (id, peerIds) => {
      selfId = id;
      netStatus = "open";
      // 再接続のたびに id が変わるので、ピア表示は毎回作り直す
      [...peers.keys()].forEach(removePeer);
      peerIds.forEach(createPeer);
      console.log(`[room] joined "${ROOM}" as ${id} (peers: ${peerIds.join(", ") || "none"})`);
    },
    onPeerJoin: (id) => {
      createPeer(id);
      console.log(`[room] peer ${id} joined`);
    },
    onPeerLeave: (id) => {
      removePeer(id);
      console.log(`[room] peer ${id} left`);
    },
    onPeerPose,
  });
}

// ---- レンダラー + 2眼（03 と同じ） ----
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

// ---- Passthrough 背景（02/03 と同じ） ----
const video = document.createElement("video");
video.playsInline = true;
video.muted = true;

// PC デバッグ用フェイクカメラ（03 と同じ）。fakeShift でマーカーの描画位置を
// 横にずらせる（2タブ検証で各タブに別の視点位置を持たせ、アバターが自分と
// 別の場所に出ることを確認するため。0 のままだと2タブが同一姿勢になり重なる）
const FAKE_SHIFT = numParam("fakeShift", 0, { min: -200, max: 200 });
function createFakeCameraStream(): MediaStream {
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 480;
  const ctx = canvas.getContext("2d")!;
  const markerImg = new Image();
  markerImg.src = markerSvgUrl;
  let frame = 0;
  const draw = () => {
    frame++;
    const cell = 40;
    for (let y = 0; y < canvas.height / cell; y++) {
      for (let x = 0; x < canvas.width / cell; x++) {
        ctx.fillStyle = (x + y) % 2 ? "#8a8a8a" : "#999";
        ctx.fillRect(x * cell, y * cell, cell, cell);
      }
    }
    if (markerImg.complete && markerImg.naturalWidth > 0) {
      ctx.drawImage(
        markerImg,
        (canvas.width - 240) / 2 + FAKE_SHIFT,
        (canvas.height - 240) / 2,
        240,
        240,
      );
    }
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

// 超広角カメラ優先・解像度指定・フォールバックは 02/03 と同じ
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
  camHFovDeg = params.has("camFov")
    ? numParam("camFov", 68, { min: 10, max: 170 })
    : /ultra wide|超広角/i.test(label)
      ? 106
      : 68;
  return `${video.videoWidth}x${video.videoHeight} ${label}`.trim();
}

// カメラ映像と片目ビューポートの縦横比補正（02/03 と同じ）
const CAM_ZOOM = numParam("camZoom", 1);
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

// ---- マーカー検出 → アンカー更新（03 と同じ。詳細コメントはそちら） ----
const markerDetector = createMarkerDetector(MARKER_SIZE_M);
const detCanvas = document.createElement("canvas");
const detCtx = detCanvas.getContext("2d", { willReadFrequently: true })!;

let lastDetVideoTime = -1;
let detMs = 0;
let markerInfo = "searching";
let lastRejectLogMs = -Infinity;
let lastAcceptedMs = -Infinity;

const targetPos = new THREE.Vector3();
const targetQuat = new THREE.Quaternion();
const targetScale = new THREE.Vector3();
const markerWorld = new THREE.Matrix4();

function detectAndUpdateAnchor() {
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
  if (video.currentTime === lastDetVideoTime) return;
  lastDetVideoTime = video.currentTime;
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return;
  const scale = Math.min(1, DET_W / Math.max(vw, vh));
  const w = Math.round(vw * scale);
  const h = Math.round(vh * scale);
  if (detCanvas.width !== w || detCanvas.height !== h) {
    detCanvas.width = w;
    detCanvas.height = h;
  }
  const t0 = performance.now();
  detCtx.drawImage(video, 0, 0, w, h);
  const image = detCtx.getImageData(0, 0, w, h);
  const focalPx =
    Math.max(w, h) / 2 / Math.tan(THREE.MathUtils.degToRad(camHFovDeg) / 2);
  const observations = markerDetector.detect(image, focalPx);
  detMs = performance.now() - t0;
  applyObservations(observations);
}

function applyObservations(observations: MarkerObservation[]) {
  const obs = observations.find(
    (o) =>
      o.id === MARKER_ID &&
      Number.isFinite(o.error) &&
      o.error <= MAX_POSE_ERROR,
  );
  if (!obs) {
    if (observations.length > 0 && performance.now() - lastRejectLogMs > 2000) {
      console.log(
        `[marker] observed but rejected: ${observations.map((o) => `id=${o.id} err=${o.error.toFixed(2)}`).join(", ")}`,
      );
      lastRejectLogMs = performance.now();
    }
    if (anchor.visible) {
      markerInfo = `lost (${((performance.now() - lastAcceptedMs) / 1000).toFixed(1)}s)`;
    }
    return;
  }
  lastAcceptedMs = performance.now();
  camera.updateMatrixWorld();
  markerWorld.multiplyMatrices(camera.matrixWorld, obs.matrix);
  markerWorld.decompose(targetPos, targetQuat, targetScale);
  if (!anchor.visible) {
    anchor.position.copy(targetPos);
    anchor.quaternion.copy(targetQuat);
    anchor.visible = true;
  } else {
    anchor.position.lerp(targetPos, SMOOTH);
    anchor.quaternion.slerp(targetQuat, SMOOTH);
  }
  markerInfo = `id=${obs.id} err=${obs.error.toFixed(2)} ${detMs.toFixed(0)}ms`;
}

function hideAnchorIfStale() {
  if (!anchor.visible) return;
  const elapsed = performance.now() - lastAcceptedMs;
  if (elapsed > LOST_HIDE_MS) {
    anchor.visible = false;
    markerInfo = "searching";
    console.log(
      `[marker] hidden after ${(elapsed / 1000).toFixed(1)}s without detection`,
    );
  }
}

// ---- 頭追従（02/03 と同じ） ----
type HeadControls = { update: () => void };
let controls: HeadControls | null = null;

const isTouchDevice = matchMedia("(pointer: coarse)").matches;

function startControls() {
  if (isTouchDevice) {
    controls = new DeviceOrientationControls(camera);
  } else {
    const orbit = new OrbitControls(camera, renderer.domElement);
    orbit.target.set(0, 1.6, -0.01);
    orbit.enableZoom = false;
    orbit.enablePan = false;
    orbit.rotateSpeed = -0.5;
    controls = orbit;
  }
}

// ---- 全画面化（02/03 と同じ） ----
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

// ---- デバッグ用 HUD（03 と同じ + 通信状態） ----
const hud = document.querySelector<HTMLDivElement>("#hud")!;
const hudState = { base: "", sensor: "", cam: "", fsResult: "", fsChange: "" };
function renderHud() {
  hud.textContent = [
    hudState.base,
    hudState.sensor && `sensor=${hudState.sensor}`,
    hudState.cam && `cam=${hudState.cam}`,
    hudState.fsResult && `fs=${hudState.fsResult}`,
    hudState.fsChange && `fs-change: ${hudState.fsChange}`,
    `marker=${markerInfo}`,
    `room=${ROOM ?? "(不正)"} me=${selfId || "-"} peers=${peers.size} ws=${netStatus}`,
  ]
    .filter(Boolean)
    .join("\n");
}

// ---- 開始フロー（02/03 と同じ直列化。iOS の制約はそちらのコメント参照） ----
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
const roomError = document.querySelector<HTMLParagraphElement>("#room-error")!;
startButton.addEventListener("click", () => {
  if (ROOM === null) {
    // 不正な room 名は開始させない（黙って demo に合流させないための ROOM 定義参照）
    roomError.hidden = false;
    roomError.textContent = `room 名「${roomRaw}」は使えません。日本語・英数字・ハイフン・アンダースコアの1〜32文字にしてください（記号・空白は不可）`;
    return;
  }
  document.body.classList.add("started");
  hudState.base = `fov=${FOV} markerMm=${MARKER_MM} mode=${isTouchDevice ? "gyro" : "orbit"}`;
  renderHud();
  connect(); // 通信はカメラ・センサーの成否と独立に開始できる

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
    void startCameraWithHud();
    return;
  }

  const doe = DeviceOrientationEvent as unknown as {
    requestPermission?: () => Promise<"granted" | "denied">;
  };
  if (!doe.requestPermission) {
    startControls();
    startCameraWithHud().then(tryEnterFullscreen);
    return;
  }

  doe
    .requestPermission()
    .then(async (state) => {
      hudState.sensor = state;
      renderHud();
      if (state === "granted") startControls();
      await startCameraWithHud();
      if (state === "granted") tryEnterFullscreen();
    })
    .catch(async (e: unknown) => {
      hudState.sensor =
        e instanceof Error ? `${e.name}: ${e.message}` : String(e);
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

// ページ離脱時は再接続ループごと接続を畳む（iOS Safari の bfcache に入った
// ページが裏で wss 再接続を繰り返さないように）
addEventListener("pagehide", () => {
  roomClient?.dispose();
  netStatus = "closed (pagehide)"; // HUD に古い "open" を残さない（bfcache 復帰時の誤解防止）
});

// bfcache から復帰したら破棄済みの接続を張り直す（コードレビュー指摘:
// pagehide で止めるだけだと、別ページから戻ったとき Room から切断されたままになる）。
// カメラストリーム（getUserMedia）は bfcache では復帰しないことがあるが、
// これは 02/03 にも共通する未対応領域（PAIN_POINTS 参照）。ここでは通信だけ復帰し、
// カメラが止まっている可能性を HUD に出す
addEventListener("pageshow", (e) => {
  if (!e.persisted) return;
  if (!document.body.classList.contains("started")) return;
  connect();
  if (hudState.cam && !hudState.cam.includes("bfcache")) {
    hudState.cam += " (bfcache: カメラ停止の可能性)";
  }
  renderHud();
});

// PC デバッグ用: ?autostart=1 で開始ボタンを自動クリックする
if (params.has("autostart")) startButton.click();

// ---- ループ ----
renderer.setAnimationLoop(() => {
  controls?.update();
  detectAndUpdateAnchor();
  hideAnchorIfStale();
  updatePeers();
  sendPoseIfDue();
  if (document.body.classList.contains("started")) renderHud();
  effect.render(scene, camera);
});
