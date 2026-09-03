import * as THREE from "three";
import { StereoEffect } from "three/examples/jsm/effects/StereoEffect.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { DeviceOrientationControls } from "three-stdlib";
import { numParam, params, resolutionParam } from "../../src/shared/url-params";
import {
  createFakeCameraStream,
  drawCheckerboard,
  startPassthrough,
} from "../../src/shared/passthrough-camera";
import type { Passthrough } from "../../src/shared/passthrough-camera";
import { isTouchDevice, runStartFlow, setupFullscreen } from "../../src/shared/start-flow";
import { setupPlayerNameField } from "../../src/shared/player-name";
import { createMarkerAnchor } from "../../src/shared/marker-anchor";
import type { MarkerAnchor } from "../../src/shared/marker-anchor";
import { createHandTracker } from "../../src/shared/hand-tracker";
import type { HandTracker } from "../../src/shared/hand-tracker";
import { HandView } from "../../src/shared/hand-view";
import { LANDMARK_COUNT } from "../../src/shared/hand-math";
import type { Vec3, ViewMapping } from "../../src/shared/hand-math";
import { HandSlots, PALM_CONTACT } from "../../src/shared/hand-slots";
import type { HandResultLike, HandSlot } from "../../src/shared/hand-slots";
import { ThrowDetector } from "../../src/shared/throw-detector";
import type { Release } from "../../src/shared/throw-detector";
import { TextPanel } from "../../src/shared/text-panel";
import { ROOM_ID_PATTERN } from "../../src/shared/shared-room-protocol";
import markerSvgUrl from "../../src/shared/marker-0.svg";
import { BOARD, DEFAULT_DARTS, dartAt, dartVelAt, loftVelocity, simulateDart } from "../../src/shared/darts-sim";
import type { DartsConfig, V3 } from "../../src/shared/darts-sim";
import { launchVelocity } from "../../src/shared/volleyball-sim";
import type { Dart, GameState } from "../../src/shared/darts-game";
import { NAME_MAX_LENGTH } from "../../src/shared/darts-protocol";
import type { PlayerPose } from "../../src/shared/darts-protocol";
import { connectGame } from "./game-client";
import type { GameClient } from "./game-client";
import { createDartboardTexture } from "./dartboard-texture";
import { FAKE_REST, scriptedDartsHand } from "./fake-darts-hand";

// Phase 6-2: MR ダーツ。06（マーカー共通座標系 + サーバー権威 + 手トラッキング）の構成で、
//   - 共通座標系: 壁に貼ったマーカー（03/04）。マーカーの中心にダーツボード。壁面 = Z=0
//   - 通信: サーバー権威（server/darts.ts）。手番（参加順に 3 投ずつ × ラウンド）・採点・
//     ダーツの着地はサーバーが決め、クライアントは同じ式（darts-sim.ts）で飛行を描く
//   - 投げ: 手（05 の MediaPipe）の手のひらの速度を見て「速く前へ振って止めた（離した）」瞬間を
//     投げとみなし、そのときの位置・速度をそのまま throw として送る。狙いの補正はしない
//     （06 のオートエイムとは逆の割り切り。3DoF + 手のブレで狙えるかは実機で確かめる）
//   - 待っている人も同じ room で、他人のダーツが飛んで刺さるのを自分の端末から見られる

// ---- パラメータ（06 と同じもの。根拠は 06 の main.ts 参照） ----
const fovRaw = params.get("fov");
const FOV_FIXED: number | null =
  fovRaw === null || fovRaw === "auto" ? null : numParam("fov", 94, { min: 20, max: 170 });
const EYE_SEP = numParam("eyeSep", 0.064, { min: 0, max: 0.2 });
const CAM_ZOOM = numParam("camZoom", 0.7, { min: 0.2, max: 5 });
const CAM_RES = resolutionParam("camRes", [1280, 720]);

const MARKER_MM = numParam("markerMm", 100, { max: 5000 });
const MARKER_SIZE_M = MARKER_MM / 1000;
const MARKER_ID = Math.round(numParam("markerId", 0, { min: 0, max: 999 }));
const MAX_POSE_ERROR = numParam("maxPoseError", 0.5, { min: 0, max: 100 });
const MARKER_DET_W = numParam("detW", 960, { min: 64, max: 4096 });
const MARKER_SMOOTH = numParam("smooth", 0.5, { min: 0.01, max: 1 });
const MARKER_INTERVAL_MS = numParam("markerIntervalMs", 100, { min: 0, max: 2000 });
const MARKER_LOST_MS = numParam("lostMs", 500, { min: 50, max: 10000 });

const NUM_HANDS = Math.round(numParam("hands", 1, { min: 1, max: 2 }));
const delegateRaw = (params.get("delegate") ?? "auto").toLowerCase();
const DELEGATE = delegateRaw === "gpu" ? "GPU" : delegateRaw === "cpu" ? "CPU" : "auto";
const HAND_SMOOTH = numParam("handSmooth", 0.5, { min: 0.05, max: 1 });
const HAND_DET_W = numParam("handDetW", 0, { min: 0, max: 4096 });
const HAND_LOST_MS = numParam("handLostMs", 300, { min: 50, max: 5000 });
const MAX_DEPTH_M = numParam("maxDepth", 1.5, { min: 0.2, max: 10 });
const HAND_SCALE = numParam("handScale", 1, { min: 0.2, max: 5 });
const MATCH_DIST_M = numParam("matchDist", 0.15, { min: 0.02, max: 2 });
const MATCH_SPEED_MPS = numParam("matchSpeed", 2, { min: 0, max: 20 });
const SWAP_HANDS = params.get("swapHands") === "1";
const OFFICIAL_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
const MODEL_URLS = params.get("model")
  ? [params.get("model")!]
  : [`${import.meta.env.BASE_URL}models/hand_landmarker.task`, OFFICIAL_MODEL_URL];

// Room / 通信
const roomRaw = params.get("room");
const ROOM = roomRaw === null ? "demo" : ROOM_ID_PATTERN.test(roomRaw) ? roomRaw : null;
const SEND_INTERVAL_MS = 1000 / numParam("sendHz", 15, { min: 1, max: 60 });
const PEER_STALE_MS = numParam("peerStaleMs", 2000, { min: 200, max: 30000 });
const PEER_SMOOTH = numParam("peerSmooth", 0.3, { min: 0.01, max: 1 });
// 飛行に効く値は room 内で一致が必要（サーバーが検証）
const GRAVITY = numParam("gravity", DEFAULT_DARTS.gravity, { min: 0, max: 30 });
const ROUNDS = Math.round(numParam("rounds", DEFAULT_DARTS.rounds, { min: 1, max: 20 }));

// 投げの検出
/** 「振り始め」とみなす手のひらの速さ [m/s] */
const THROW_MIN_SPEED = numParam("throwMinSpeed", 1.5, { min: 0.2, max: 20 });
/** ピークからこの割合まで落ちたら「離した」とみなす */
const RELEASE_RATIO = numParam("releaseRatio", 0.5, { min: 0.1, max: 0.95 });
/** 振りがこれ以上続いたら打ち切って離した扱い [ms] */
const SWING_MAX_MS = numParam("swingMaxMs", 800, { min: 100, max: 3000 });
/** 手の速度に掛ける係数。トラッカーの速度の過小申告を補う較正用（狙いの補正ではない）。既定 1 */
const THROW_GAIN = numParam("throwGain", 1, { min: 0.1, max: 10 });
/**
 * 打ち出しに足す仰角 [deg]。水平に振っても山なりで届かせるための補正（loftVelocity 参照）。
 * 0 で補正なし = 手の速度方向そのまま
 */
const THROW_LOFT = numParam("throwLoft", 20, { min: 0, max: 60 });
const LOCAL_THROW_COOLDOWN_MS = 1000;
const PREDICT_MAX_MS = 1500;

// デバッグ
const FAKE_CAM = params.has("fakecam");
const FAKE_SHIFT = numParam("fakeShift", 0, { min: -200, max: 200 });
const FAKE_SHIFT_Y = numParam("fakeShiftY", 0, { min: -240, max: 240 });
const FAKE_MARKER_PX = numParam("fakeMarkerPx", 80, { min: 30, max: 400 });
const FAKE_HANDS = params.has("fakehands");
/** 合成の手が投げる滞空時間 [s]（ボードの中心を狙う速度をこれから逆算する） */
const FAKE_FLIGHT_SEC = numParam("fakeFlightSec", 0.45, { min: 0.1, max: 3 });

// ---- シーン ----
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a2233);

const camera = new THREE.PerspectiveCamera(FOV_FIXED ?? 94, innerWidth / innerHeight, 0.05, 100);
camera.position.set(0, 1.6, 0);
scene.add(camera);

scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.2));
const dirLight = new THREE.DirectionalLight(0xffffff, 1.5);
dirLight.position.set(3, 10, 2);
scene.add(dirLight);

// ---- アンカー（マーカー座標系 = board 座標系）。壁のマーカーなので回さない ----
const anchor = new THREE.Group();
anchor.visible = false;
scene.add(anchor);
const board = anchor;

const markerFrameMaterial = new THREE.MeshBasicMaterial({
  color: 0x8ab4f8,
  transparent: true,
  opacity: 0.4,
  side: THREE.DoubleSide,
});
anchor.add(new THREE.Mesh(new THREE.PlaneGeometry(MARKER_SIZE_M, MARKER_SIZE_M), markerFrameMaterial));

// ダーツボード（マーカーの中心。壁面より少し手前に浮かせてマーカーの枠と重ならないように）
const boardMesh = new THREE.Mesh(
  new THREE.CircleGeometry(BOARD.boardR, 96),
  new THREE.MeshBasicMaterial({ map: createDartboardTexture(), transparent: true }),
);
boardMesh.position.z = 0.004;
board.add(boardMesh);
// ボードの縁（厚み）
const rim = new THREE.Mesh(
  new THREE.TorusGeometry(BOARD.boardR, 0.008, 8, 96),
  new THREE.MeshStandardMaterial({ color: 0x333333 }),
);
rim.position.z = 0.004;
board.add(rim);

// スコアボード: ボードの上
const scorePanel = new TextPanel(0.7, 0.3);
scorePanel.mesh.position.set(0, BOARD.boardR + 0.2, 0.01);
board.add(scorePanel.mesh);
// 視界内メッセージ（カメラの子）
const message = new TextPanel(0.9, 0.24);
message.mesh.position.set(0, -0.28, -1.2);
camera.add(message.mesh);

// ---- ダーツの見た目。先端が +Z（lookAt で進行方向へ向ける） ----
const PLAYER_COLORS = [0x8ab4f8, 0xffa657, 0x81c995, 0xf28b82, 0xfdd663, 0xc58af9];
const DART_LENGTH = 0.15;
function createDartMesh(color: number): THREE.Group {
  const g = new THREE.Group();
  const metal = new THREE.MeshStandardMaterial({ color: 0xb0b0b0, metalness: 0.6, roughness: 0.4 });
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.003, 0.03, 10), metal);
  tip.rotation.x = Math.PI / 2;
  tip.position.z = DART_LENGTH / 2 - 0.015;
  g.add(tip);
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.005, 0.05, 12), metal);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.z = DART_LENGTH / 2 - 0.055;
  g.add(barrel);
  const shaft = new THREE.Mesh(
    new THREE.CylinderGeometry(0.003, 0.003, 0.04, 8),
    new THREE.MeshStandardMaterial({ color: 0x222222 }),
  );
  shaft.rotation.x = Math.PI / 2;
  shaft.position.z = DART_LENGTH / 2 - 0.1;
  g.add(shaft);
  const flightMat = new THREE.MeshStandardMaterial({ color, side: THREE.DoubleSide });
  for (const rot of [0, Math.PI / 2]) {
    const flight = new THREE.Mesh(new THREE.PlaneGeometry(0.03, 0.035), flightMat);
    flight.rotation.y = Math.PI / 2;
    flight.rotation.x = rot;
    flight.position.z = -DART_LENGTH / 2 + 0.02;
    g.add(flight);
  }
  return g;
}

// ---- ピア（他のプレイヤー）: 頭のアバター + 手の骨格。board 座標系で受け取るので board の子 ----
type Peer = {
  group: THREE.Group;
  materials: THREE.Material[];
  targetPos: THREE.Vector3;
  targetQuat: THREE.Quaternion;
  lastPoseMs: number;
  tracking: boolean;
  hands: HandView[];
  handTargets: (Vec3[] | null)[];
  handCurrent: (Vec3[] | null)[];
};
const peers = new Map<string, Peer>();
const peerHeadGeometry = new THREE.SphereGeometry(0.09, 24, 16);
const peerNoseGeometry = new THREE.ConeGeometry(0.035, 0.09, 16);

function createPeer(id: string): Peer {
  const group = new THREE.Group();
  const headMat = new THREE.MeshStandardMaterial({ color: 0xe8eaed, transparent: true });
  const noseMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, transparent: true });
  group.add(new THREE.Mesh(peerHeadGeometry, headMat));
  const nose = new THREE.Mesh(peerNoseGeometry, noseMat);
  nose.rotation.x = -Math.PI / 2;
  nose.position.z = -0.1;
  group.add(nose);
  group.visible = false;
  board.add(group);
  const hands = [new HandView(0xe8eaed, 0.01), new HandView(0xe8eaed, 0.01)];
  for (const h of hands) board.add(h.group);
  const peer: Peer = {
    group,
    materials: [headMat, noseMat],
    targetPos: new THREE.Vector3(),
    targetQuat: new THREE.Quaternion(),
    lastPoseMs: -Infinity,
    tracking: false,
    hands,
    handTargets: [null, null],
    handCurrent: [null, null],
  };
  peers.set(id, peer);
  return peer;
}

function removePeer(id: string) {
  const peer = peers.get(id);
  if (!peer) return;
  peer.group.removeFromParent();
  peer.materials.forEach((m) => m.dispose());
  for (const h of peer.hands) h.dispose();
  peers.delete(id);
}

function onPeerPose(id: string, pose: PlayerPose) {
  const peer = peers.get(id) ?? createPeer(id);
  peer.targetPos.set(...pose.pos);
  peer.targetQuat.set(...pose.quat);
  peer.tracking = pose.tracking;
  const now = performance.now();
  if (now - peer.lastPoseMs > PEER_STALE_MS) {
    peer.group.position.copy(peer.targetPos);
    peer.group.quaternion.copy(peer.targetQuat);
    peer.handCurrent = [null, null];
  }
  peer.lastPoseMs = now;
  for (let i = 0; i < 2; i++) {
    const flat = pose.hands?.[i];
    if (!flat) {
      peer.handTargets[i] = null;
      continue;
    }
    const pts: Vec3[] = [];
    for (let k = 0; k < LANDMARK_COUNT; k++) {
      pts.push({ x: flat[k * 3], y: flat[k * 3 + 1], z: flat[k * 3 + 2] });
    }
    peer.handTargets[i] = pts;
  }
}

let lastPeerUpdateMs = performance.now();
function updatePeers(now: number) {
  const dtFrames = Math.min((now - lastPeerUpdateMs) / (1000 / 60), 4);
  lastPeerUpdateMs = now;
  const alpha = 1 - Math.pow(1 - PEER_SMOOTH, dtFrames);
  for (const [id, peer] of peers) {
    if (peer.lastPoseMs === -Infinity) continue;
    const stale = now - peer.lastPoseMs > PEER_STALE_MS;
    peer.group.visible = !stale;
    if (stale) {
      for (const h of peer.hands) h.hide();
      continue;
    }
    peer.group.position.lerp(peer.targetPos, alpha);
    peer.group.quaternion.slerp(peer.targetQuat, alpha);
    const opacity = peer.tracking ? 1 : 0.3;
    for (const m of peer.materials) m.opacity = opacity;
    const color = playerColor(id);
    (peer.materials[0] as THREE.MeshStandardMaterial).color.setHex(color);
    for (const [i, view] of peer.hands.entries()) {
      const target = peer.handTargets[i];
      if (!target) {
        view.hide();
        peer.handCurrent[i] = null;
        continue;
      }
      let cur = peer.handCurrent[i];
      if (!cur) {
        cur = target.map((p) => ({ ...p }));
        peer.handCurrent[i] = cur;
      } else {
        for (let k = 0; k < LANDMARK_COUNT; k++) {
          cur[k].x += (target[k].x - cur[k].x) * alpha;
          cur[k].y += (target[k].y - cur[k].y) * alpha;
          cur[k].z += (target[k].z - cur[k].z) * alpha;
        }
      }
      view.setColor(color);
      view.update(cur);
    }
  }
}

// ---- 自分の手（src/shared/hand-slots.ts） ----
const handSlots = new HandSlots({
  camera,
  numHands: NUM_HANDS,
  smooth: HAND_SMOOTH,
  lostMs: HAND_LOST_MS,
  maxDepthM: MAX_DEPTH_M,
  handScale: HAND_SCALE,
  matchDistM: MATCH_DIST_M,
  matchSpeedMps: MATCH_SPEED_MPS,
  swapHands: SWAP_HANDS,
});

// ---- レンダラー + 2眼 ----
let passthrough: Passthrough | null = null;
let markerAnchor: MarkerAnchor | null = null;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
document.querySelector<HTMLDivElement>("#app")!.appendChild(renderer.domElement);
const effect = new StereoEffect(renderer);
effect.setEyeSeparation(EYE_SEP);

function resize() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  effect.setSize(innerWidth, innerHeight);
  passthrough?.updateCover();
}
resize();
addEventListener("resize", resize);

// ---- パススルー（PC デバッグ用フェイクカメラは 06 と同じ描き方） ----
const markerImg = new Image();
markerImg.src = markerSvgUrl;
function fakeStream(): MediaStream {
  return createFakeCameraStream((ctx, canvas, frame) => {
    drawCheckerboard(ctx, canvas, frame);
    if (markerImg.complete && markerImg.naturalWidth > 0) {
      ctx.drawImage(
        markerImg,
        (canvas.width - FAKE_MARKER_PX) / 2 + FAKE_SHIFT,
        (canvas.height - FAKE_MARKER_PX) / 2 + FAKE_SHIFT_Y,
        FAKE_MARKER_PX,
        FAKE_MARKER_PX,
      );
    }
  });
}

async function startCameraAndMarker(onProgress: (step: string) => void) {
  passthrough = await startPassthrough(
    scene,
    {
      fakeStream: FAKE_CAM ? fakeStream : undefined,
      camRes: CAM_RES,
      preferUltraWide: params.get("lens") !== "wide",
      camFovOverride: params.has("camFov") ? numParam("camFov", 68, { min: 10, max: 170 }) : undefined,
      eyeAspect: () => innerWidth / 2 / innerHeight,
      zoom: CAM_ZOOM,
    },
    onProgress,
  );
  const pt = passthrough;
  markerAnchor = createMarkerAnchor({
    video: pt.video,
    camera,
    anchor,
    markerSizeM: MARKER_SIZE_M,
    markerId: MARKER_ID,
    maxPoseError: MAX_POSE_ERROR,
    detW: MARKER_DET_W,
    smooth: MARKER_SMOOTH,
    minIntervalMs: MARKER_INTERVAL_MS,
    camHFovDeg: () => pt.camHFovDeg,
    resnapAfterMs: 2000,
    snapDistanceM: 0.3,
    // 自分が投げている最中（振り〜着地）にボードが飛ぶと投げた位置がずれるので lerp だけ
    canSnap: () => !(isMyTurn() && (swinging() || auth?.state.phase === "flight")),
  });
}

// ---- 手トラッキング（06 と同じ初期化・失敗時の CPU 再試行） ----
let tracker: HandTracker | null = null;
let trackerStatus = "idle";
let lastTrackerError = "";
let retriedWithCpu = false;
let lastDetectAt = -Infinity;
let detIntervalEma = 0;
let lastResultHands = 0;

async function initTracker(delegate: typeof DELEGATE = DELEGATE, modelBuffer?: ArrayBuffer) {
  trackerStatus = "loading";
  try {
    tracker = await createHandTracker(
      {
        numHands: NUM_HANDS,
        delegate,
        modelBuffer,
        modelUrls: MODEL_URLS,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
        inputMaxSide: HAND_DET_W,
        inputMaxSideCpu: 640,
      },
      (step) => {
        trackerStatus = `loading: ${step}`;
      },
    );
    const modelSource = modelBuffer ? "reused" : tracker.modelUrl.startsWith("http") ? "remote" : "local";
    trackerStatus = `ready ${tracker.delegate} model=${modelSource}`;
  } catch (e: unknown) {
    trackerStatus = `error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

function onTrackerFailure(e: unknown) {
  console.error("[hand-tracker] 推論に失敗:", e);
  const msg = e instanceof Error ? e.message : String(e);
  lastTrackerError = `${tracker?.delegate ?? "?"}: ${msg}`;
  const failed = tracker;
  tracker = null;
  try {
    failed?.close();
  } catch {
    // close 自体の失敗は無視
  }
  if (failed?.delegate === "GPU" && DELEGATE === "auto" && !retriedWithCpu) {
    retriedWithCpu = true;
    trackerStatus = "GPU で推論失敗 → CPU で再初期化";
    void initTracker("CPU", failed.modelBuffer);
  } else {
    trackerStatus = `error: 推論失敗 ${msg}`;
  }
}

const tmpVec = new THREE.Vector3();
const tmpVec2 = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();
let fakeStartMs = -1;
let myTurnSinceMs = -1;
let fakeDebugSec = -1;

/** 合成の手の振り速度（カメラ座標系）: 定位置からボードの中心へ FAKE_FLIGHT_SEC で届く速度 */
function fakeSwingVel(): Vec3 {
  if (!anchor.visible) return { x: 0, y: 0, z: -4 };
  // 定位置 → board 座標系
  tmpVec.set(FAKE_REST.x, FAKE_REST.y, FAKE_REST.z);
  camera.localToWorld(tmpVec);
  board.worldToLocal(tmpVec);
  const from: V3 = [tmpVec.x, tmpVec.y, tmpVec.z];
  // onRelease が仰角と較正を足すので、その逆をここで打ち消す（合成の手は狙って投げる）
  const v = loftVelocity(launchVelocity(from, [0, 0, 0], FAKE_FLIGHT_SEC, GRAVITY), -THROW_LOFT);
  // board → world → camera（回転だけ）
  tmpVec.set(v[0], v[1], v[2]).applyQuaternion(board.getWorldQuaternion(tmpQuat));
  tmpVec.applyQuaternion(camera.getWorldQuaternion(tmpQuat).invert());
  if (params.has("fakeDebug") && Math.floor(performance.now() / 1000) !== fakeDebugSec) {
    fakeDebugSec = Math.floor(performance.now() / 1000);
    camera.getWorldPosition(tmpVec2);
    board.worldToLocal(tmpVec2);
    console.log(`[fake] cam=(${tmpVec2.toArray().map((x) => x.toFixed(2)).join(",")}) rest=(${from.map((x) => x.toFixed(2)).join(",")}) vBoard=(${v.map((x) => x.toFixed(2)).join(",")}) vCam=(${tmpVec.toArray().map((x) => x.toFixed(2)).join(",")})`);
  }
  return { x: tmpVec.x / THROW_GAIN, y: tmpVec.y / THROW_GAIN, z: tmpVec.z / THROW_GAIN };
}

function updateFakeHands(now: number) {
  if (now - lastDetectAt < 33 || !passthrough) return;
  const mapping = passthrough.displayViewMapping(camera.fov);
  if (fakeStartMs < 0) fakeStartMs = now;
  lastDetectAt = now;
  const turnSec = isMyTurn() && myTurnSinceMs >= 0 ? (now - myTurnSinceMs) / 1000 : null;
  applyHandResult(scriptedDartsHand(turnSec, fakeSwingVel(), (now - fakeStartMs) / 1000, mapping), now);
}

function updateHands(now: number) {
  if (FAKE_HANDS) updateFakeHands(now);
  if (tracker && passthrough) {
    let result: ReturnType<HandTracker["detect"]> = null;
    try {
      result = tracker.detect(passthrough.video);
    } catch (e: unknown) {
      onTrackerFailure(e);
      return;
    }
    if (result) {
      if (lastDetectAt > 0) {
        detIntervalEma = detIntervalEma ? detIntervalEma * 0.9 + (now - lastDetectAt) * 0.1 : now - lastDetectAt;
      }
      lastDetectAt = now;
      applyHandResult(result, now);
    }
  }
  handSlots.update(now);
}

function applyHandResult(result: HandResultLike, now: number) {
  if (!passthrough) return;
  const mapping = passthrough.displayViewMapping(camera.fov);
  const depthMapping: ViewMapping = FAKE_HANDS ? mapping : (passthrough.metricViewMapping() ?? mapping);
  lastResultHands = result.landmarks.length;
  handSlots.apply(result, now, mapping, depthMapping);
}

// ---- 試合の状態（サーバー権威） ----
let selfId = "";
let netStatus = "idle";
let client: GameClient | null = null;
let auth: { state: GameState; recvMs: number } | null = null;
let dartsCfg: DartsConfig = { ...DEFAULT_DARTS, gravity: GRAVITY, rounds: ROUNDS };
/** 自分の投げの予測（サーバーの確認が来るまで）。index は投げたときの手番の投数 */
let predicted: { launch: { pos: V3; vel: V3 }; sinceMs: number; index: number; round: number } | null = null;
/** 短時間だけ出す視界内メッセージ。fromMs までは出さない（投げの結果は刺さってから出す） */
let flash: { text: string; fromMs: number; untilMs: number } | null = null;
let cameraError = "";
let lastLocalThrowMs = -Infinity;
let localThrows = 0;
let acceptedThrows = 0;
let lastEventKey = "";
let lastTurnPlayer: string | null = null;

function isMyTurn(): boolean {
  return auth?.state.turn?.playerId === selfId && selfId !== "";
}

function playerIndex(id: string): number {
  return auth?.state.players.findIndex((p) => p.id === id) ?? -1;
}

function playerColor(id: string): number {
  const i = playerIndex(id);
  return i < 0 ? 0xe8eaed : PLAYER_COLORS[i % PLAYER_COLORS.length];
}

function playerName(id: string): string {
  const p = auth?.state.players.find((x) => x.id === id);
  const base = p?.name ?? id;
  return id === selfId ? `${base}（あなた）` : base;
}

function onState(state: GameState) {
  const now = performance.now();
  const ev = state.event;
  if (state.rejectedFor === selfId) {
    predicted = null;
    console.log("[game] throw rejected by server");
    return;
  }
  if (predicted) {
    const confirmed = state.darts.some(
      (d) => d.by === selfId && d.round === predicted!.round && d.index === predicted!.index,
    );
    if (confirmed) {
      predicted = null;
      acceptedThrows++;
    } else if (!(state.turn?.playerId === selfId && state.phase === "aim")) {
      // 自分の投げが載らないまま別の出来事で先に進んだ（手番のタイムアウト・離脱等）
      predicted = null;
    }
  }
  const key = ev ? `${state.seq}:${ev.kind}` : "";
  if (key && key !== lastEventKey) {
    lastEventKey = key;
    if (ev?.kind === "throw" && ev.by) {
      const d = state.darts[state.darts.length - 1];
      if (d) {
        const who = ev.by === selfId ? "あなた" : playerName(ev.by);
        // 刺さる時刻 = 権威時刻 launchedAt + hitT。受信時刻基準に直す
        const landAt = now + (d.launchedAt - state.t) + d.landing.hitT * 1000;
        const result = d.landing.stuck ? `${d.landing.score.label}（${d.landing.score.points} 点）` : "届かず（0 点）";
        flash = { text: `${who}: ${result}`, fromMs: landAt, untilMs: landAt + 1800 };
      }
    } else if (ev?.kind === "timeout" && ev.by) {
      flash = { text: `${playerName(ev.by)} は時間切れ`, fromMs: now, untilMs: now + 2000 };
    } else if (ev?.kind === "restart") {
      flash = { text: "もう一度！", fromMs: now, untilMs: now + 2000 };
    }
    console.log(
      `[game] event ${ev?.kind} by=${ev?.by ?? "-"} phase=${state.phase} round=${state.round} turn=${state.turn?.playerId ?? "-"}#${state.turn?.index ?? "-"} darts=${state.darts.length}`,
    );
  }
  const turnPlayer = state.turn?.playerId ?? null;
  if (turnPlayer !== lastTurnPlayer) {
    lastTurnPlayer = turnPlayer;
    myTurnSinceMs = turnPlayer === selfId ? now : -1;
  }
  auth = { state, recvMs: now };
}

function connect(name: string) {
  if (ROOM === null) return;
  client = connectGame(
    ROOM,
    name,
    { markerId: MARKER_ID, markerMm: MARKER_MM, gravity: GRAVITY, rounds: ROUNDS },
    {
      onStatus: (status) => {
        netStatus = status;
      },
      onError: (reason) => {
        netStatus = `error: ${reason}`;
        console.warn(`[game] rejected: ${reason}`);
      },
      onWelcome: (id, peerIds, cfg, state) => {
        selfId = id;
        netStatus = "open";
        [...peers.keys()].forEach(removePeer);
        peerIds.forEach(createPeer);
        predicted = null;
        lastTurnPlayer = null;
        dartsCfg = cfg;
        onState(state);
        console.log(`[game] joined "${ROOM}" as ${id} (peers: ${peerIds.join(", ") || "none"})`);
      },
      onPeerJoin: (id) => {
        createPeer(id);
        console.log(`[game] peer ${id} joined`);
      },
      onPeerLeave: (id) => {
        removePeer(id);
        console.log(`[game] peer ${id} left`);
      },
      onPeerPose,
      onState,
    },
  );
}

// 自分の姿勢（board 座標系）+ 手の 21 点を送る
const boardInv = new THREE.Matrix4();
const poseMatrix = new THREE.Matrix4();
const posePos = new THREE.Vector3();
const poseQuat = new THREE.Quaternion();
const poseScale = new THREE.Vector3();
let lastSendMs = -Infinity;
let myBoardZ: number | null = null;

function sendPoseIfDue(now: number) {
  if (!client || !markerAnchor?.everDetected) return;
  if (now - lastSendMs < SEND_INTERVAL_MS) return;
  lastSendMs = now;
  boardInv.copy(board.matrixWorld).invert();
  poseMatrix.multiplyMatrices(boardInv, camera.matrixWorld);
  poseMatrix.decompose(posePos, poseQuat, poseScale);
  myBoardZ = posePos.z;
  const hands: number[][] = [];
  for (const slot of handSlots.visible()) {
    if (!slot.ema) continue;
    const flat: number[] = [];
    for (const p of slot.ema) {
      tmpVec.set(p.x, p.y, p.z);
      camera.localToWorld(tmpVec);
      board.worldToLocal(tmpVec);
      flat.push(round3(tmpVec.x), round3(tmpVec.y), round3(tmpVec.z));
    }
    hands.push(flat);
  }
  const pose: PlayerPose = {
    pos: [posePos.x, posePos.y, posePos.z],
    quat: [poseQuat.x, poseQuat.y, poseQuat.z, poseQuat.w],
    tracking: markerAnchor.isTracking(now, MARKER_LOST_MS),
  };
  if (hands.length > 0) pose.hands = hands;
  client.sendPose(pose);
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

// ---- 投げの検出（src/shared/throw-detector.ts）。手ごとに 1 つ。board 座標系のサンプルを渡す ----
const detectors = new WeakMap<HandSlot, ThrowDetector>();
const lastSampleMs = new WeakMap<HandSlot, number>();
let lastSwingInfo = "";
/** 投げを受け付けられる状態（自分の手番の aim 中）。false の間は振りを始めず、進行中の振りも捨てる */
function canThrow(): boolean {
  return isMyTurn() && auth?.state.phase === "aim";
}
function swinging(): boolean {
  return handSlots.slots.some((slot) => !!detectors.get(slot)?.swing);
}

function updateThrowDetection(now: number) {
  if (!anchor.visible) return;
  board.getWorldQuaternion(tmpQuat).invert();
  const allowed = canThrow();
  for (const slot of handSlots.slots) {
    let det = detectors.get(slot);
    if (!det) {
      det = new ThrowDetector({ minSpeed: THROW_MIN_SPEED, releaseRatio: RELEASE_RATIO, maxSwingMs: SWING_MAX_MS });
      detectors.set(slot, det);
    }
    const visible = slot.view.visible && slot.snapContacts !== null;
    if (!visible) {
      const r = det.lost();
      if (r) onRelease(now, r);
      continue;
    }
    const sampleMs = slot.snapMs;
    if (lastSampleMs.get(slot) === sampleMs) continue;
    lastSampleMs.set(slot, sampleMs);
    // 手のひらの位置・速度を board 座標系へ
    tmpVec.copy(slot.contactsWorld[PALM_CONTACT]);
    board.worldToLocal(tmpVec);
    tmpVec2.copy(slot.contactsVel[PALM_CONTACT]).applyQuaternion(tmpQuat);
    const r = det.sample(now, [tmpVec.x, tmpVec.y, tmpVec.z], [tmpVec2.x, tmpVec2.y, tmpVec2.z], allowed);
    if (r) {
      onRelease(now, r);
      // 同時に 2 本投げない（もう片方の手の振りは捨てる）
      for (const other of handSlots.slots) if (other !== slot) detectors.get(other)?.reset();
      return;
    }
  }
}

function onRelease(now: number, r: Release) {
  // 仰角を足してから速度の較正を掛ける（loftVelocity は速さを変えないので順序はどちらでも同じだが、
  // 「手の速度 → 打ち出しの向き → 打ち出しの速さ」の順に読めるようにこの並びにする）
  const lofted = loftVelocity(r.vel, THROW_LOFT);
  const vel: V3 = [lofted[0] * THROW_GAIN, lofted[1] * THROW_GAIN, lofted[2] * THROW_GAIN];
  lastSwingInfo = `${r.why} peak=${r.peakSpeed.toFixed(2)}m/s pos=(${r.pos.map((v) => v.toFixed(2)).join(",")})`;
  if (!client || !auth || !canThrow()) return;
  if (now - lastLocalThrowMs < LOCAL_THROW_COOLDOWN_MS) return;
  lastLocalThrowMs = now;
  localThrows++;
  predicted = {
    launch: { pos: r.pos, vel },
    sinceMs: now,
    index: auth.state.turn!.index,
    round: auth.state.round,
  };
  client.sendThrow(r.pos, vel);
  console.log(`[game] throw sent (${r.why}) speed=${(r.peakSpeed * THROW_GAIN).toFixed(2)}m/s pos=(${r.pos.map((v) => v.toFixed(2)).join(",")}) vel=(${vel.map((v) => v.toFixed(2)).join(",")})`);
}

// ---- ダーツの描画（権威状態の launch から同じ式で飛行を進める） ----
const dartMeshes = new Map<string, THREE.Group>();
const dartTarget = new THREE.Vector3();

function dartKey(d: Dart): string {
  return `${d.by}:${d.round}:${d.index}`;
}

function placeDart(mesh: THREE.Group, launch: { pos: V3; vel: V3 }, elapsed: number, landing: { hitT: number; end: V3; stuck: boolean } | null) {
  const g = dartsCfg.gravity;
  const hitT = landing?.hitT ?? Infinity;
  const t = Math.min(elapsed, hitT);
  const pos = t < hitT || !landing ? dartAt(launch.pos, launch.vel, t, g) : landing.end;
  const vel = dartVelAt(launch.vel, t, g);
  // 先端を刺さる点に置く（刺さったら先端が壁面、飛行中は先端が進行方向）
  mesh.position.set(pos[0], pos[1], pos[2]);
  dartTarget.set(pos[0] + vel[0], pos[1] + vel[1], pos[2] + vel[2]);
  mesh.lookAt(board.localToWorld(dartTarget));
  mesh.translateZ(-DART_LENGTH / 2);
  mesh.visible = true;
  if (landing && elapsed >= hitT && !landing.stuck) {
    // 壁に届かなかった: 落ちた点に寝かせて薄く
    mesh.visible = elapsed < hitT + 2;
  }
}

function updateDarts(now: number) {
  const keep = new Set<string>();
  if (auth) {
    const s = auth.state;
    for (const d of s.darts) {
      const key = dartKey(d);
      keep.add(key);
      let mesh = dartMeshes.get(key);
      if (!mesh) {
        mesh = createDartMesh(playerColor(d.by));
        board.add(mesh);
        dartMeshes.set(key, mesh);
      }
      const elapsed = (s.t - d.launchedAt) / 1000 + (now - auth.recvMs) / 1000;
      placeDart(mesh, d.launch, elapsed, d.landing);
    }
  }
  if (predicted) {
    if (now - predicted.sinceMs > PREDICT_MAX_MS) {
      predicted = null;
    } else {
      keep.add("predicted");
      let mesh = dartMeshes.get("predicted");
      if (!mesh) {
        mesh = createDartMesh(playerColor(selfId));
        board.add(mesh);
        dartMeshes.set("predicted", mesh);
      }
      const landing = simulateDart(predicted.launch.pos, predicted.launch.vel, dartsCfg);
      placeDart(mesh, predicted.launch, (now - predicted.sinceMs) / 1000, landing);
    }
  }
  for (const [key, mesh] of dartMeshes) {
    if (keep.has(key)) continue;
    mesh.removeFromParent();
    mesh.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
    dartMeshes.delete(key);
  }
}

// ---- 視界内メッセージとスコアボード ----
function updateMessages(now: number) {
  const s = auth?.state;
  if (s) {
    const lines = s.players.map((p, i) => {
      const mark = s.turn?.playerId === p.id ? "▶ " : "　";
      const win = s.winners?.includes(p.id) ? " 🏆" : "";
      return `${mark}${i + 1}. ${p.name}${p.id === selfId ? "（あなた）" : ""}  ${s.scores[p.id] ?? 0}${win}`;
    });
    const head = s.phase === "result" ? "結果" : `ラウンド ${s.round + 1} / ${dartsCfg.rounds}`;
    scorePanel.set([head, ...lines].join("\n"), "#e8eaed", "left");
  }
  let text = "";
  let color = "#e8eaed";
  if (netStatus.startsWith("error")) {
    text = `接続できません\n${netStatus.slice(7, 60)}`;
    color = "#f28b82";
  } else if (cameraError) {
    text = `カメラを開けません\n${cameraError.slice(0, 40)}`;
    color = "#f28b82";
  } else if (!passthrough) {
    text = "カメラを起動中…";
  } else if (!markerAnchor?.everDetected) {
    text = "壁のマーカーを見てください";
    color = "#fdd663";
  } else if (trackerStatus.startsWith("error")) {
    text = "手の検出に失敗しました";
    color = "#f28b82";
  } else if (!FAKE_HANDS && !tracker) {
    text = "手の検出を読み込み中…";
    color = "#fdd663";
  } else if (!auth) {
    text = netStatus === "open" ? "入室中…" : `サーバーに接続中… (${netStatus})`;
    color = "#fdd663";
  } else if (netStatus !== "open") {
    text = "接続が切れました（再接続中）";
    color = "#f28b82";
  } else if (flash && now >= flash.fromMs && now < flash.untilMs) {
    text = flash.text;
    color = "#81c995";
  } else if (auth.state.phase === "result") {
    const w = auth.state.winners ?? [];
    text = w.includes(selfId) ? "あなたの勝ち！" : `${w.map(playerName).join("・")} の勝ち`;
    color = w.includes(selfId) ? "#81c995" : "#e8eaed";
  } else if (isMyTurn()) {
    const idx = auth.state.turn!.index + 1;
    // 飛行中は何も出さない（ダーツを見せる）
    text = auth.state.phase === "aim" ? `あなたの番です（${idx} / ${dartsCfg.dartsPerTurn} 投目）\n手を前へ振って投げる` : "";
    color = "#81c995";
    if (auth.state.phase === "aim" && myBoardZ !== null && myBoardZ < 0.5) {
      text = "ボードから離れてください";
      color = "#fdd663";
    }
  } else if (auth.state.turn) {
    text = `${playerName(auth.state.turn.playerId)} の番です`;
  } else {
    text = "参加者を待っています";
  }
  message.set(text, color);
}

// ---- 頭追従（02〜06 と同じ） ----
type HeadControls = { update: () => void };
let controls: HeadControls | null = null;
const touch = isTouchDevice();

function startControls() {
  if (touch) {
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

// ---- HUD（デバッグ用） ----
const hud = document.querySelector<HTMLDivElement>("#hud")!;
const hudState = { base: "", sensor: "", cam: "", fsResult: "", fsChange: "", wake: "" };
let lastHudText = "";
function renderHud() {
  const s = auth?.state;
  const text = [
    `${hudState.base} (fov now=${camera.fov.toFixed(1)})`,
    hudState.sensor && `sensor=${hudState.sensor}`,
    hudState.cam && `cam=${hudState.cam}`,
    hudState.fsResult && `fs=${hudState.fsResult}`,
    hudState.fsChange && `fs-change: ${hudState.fsChange}`,
    hudState.wake && `wake=${hudState.wake}`,
    `marker=${markerAnchor?.info ?? "-"}${markerAnchor?.everDetected && !markerAnchor.isTracking(performance.now(), MARKER_LOST_MS) ? " (holding last pose)" : ""}`,
    `tracker=${trackerStatus}${lastTrackerError ? ` (last error: ${lastTrackerError})` : ""}`,
    (tracker || FAKE_HANDS) &&
      `hands=${lastResultHands} ${handSlots.describe() || "-"} infer=${(tracker?.lastMs ?? 0).toFixed(0)}ms every ${detIntervalEma.toFixed(0)}ms`,
    `room=${ROOM ?? "(不正)"} me=${selfId || "-"} peers=${peers.size} ws=${netStatus} swing=${swinging() ? "yes" : "no"} last=${lastSwingInfo || "-"}`,
    s &&
      `game: phase=${s.phase} round=${s.round} turn=${s.turn?.playerId ?? "-"}#${s.turn?.index ?? "-"} players=${s.players.map((p) => `${p.id}:${s.scores[p.id] ?? 0}`).join(",")} darts=${s.darts.length} throws=${localThrows}/${acceptedThrows} seq=${s.seq}`,
  ]
    .filter(Boolean)
    .join("\n");
  if (text !== lastHudText) {
    lastHudText = text;
    hud.textContent = text;
  }
}

// ---- 開始フロー（src/shared/start-flow.ts） ----
const fsButton = document.querySelector<HTMLButtonElement>("#fs-button")!;
const tryEnterFullscreen = setupFullscreen({
  button: fsButton,
  touch,
  onResult: (status) => {
    hudState.fsResult = status;
  },
  onChange: (change) => {
    hudState.fsChange = change;
  },
  isStarted: () => document.body.classList.contains("started"),
});

const startButton = document.querySelector<HTMLButtonElement>("#start-button")!;
const nameForm = document.querySelector<HTMLFormElement>("#name-form")!;
const roomError = document.querySelector<HTMLParagraphElement>("#room-error")!;
const readPlayerName = setupPlayerNameField({
  input: document.querySelector<HTMLInputElement>("#player-name")!,
  error: document.querySelector<HTMLParagraphElement>("#name-error")!,
  maxLength: NAME_MAX_LENGTH,
});
nameForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (ROOM === null) {
    roomError.hidden = false;
    roomError.textContent = `room 名「${roomRaw}」は使えません。日本語・英数字・ハイフン・アンダースコアの1〜32文字にしてください（記号・空白は不可）`;
    return;
  }
  const name = readPlayerName();
  if (name === null) return;
  document.body.classList.add("started");
  hudState.base = `fov=${FOV_FIXED ?? "auto"} camZoom=${CAM_ZOOM} markerMm=${MARKER_MM} detW=${MARKER_DET_W}@${MARKER_INTERVAL_MS}ms hands=${NUM_HANDS} delegate=${DELEGATE} handScale=${HAND_SCALE} gravity=${GRAVITY} rounds=${ROUNDS} throwMinSpeed=${THROW_MIN_SPEED} throwGain=${THROW_GAIN} throwLoft=${THROW_LOFT} mode=${touch ? "gyro" : "orbit"}`;
  connect(name);
  if (FAKE_HANDS) {
    trackerStatus = "fake (scripted hand, MediaPipe 未使用)";
  } else {
    void initTracker();
  }
  runStartFlow(touch, {
    onSensor: (state) => {
      hudState.sensor = state;
    },
    startControls,
    startCamera: async () => {
      hudState.cam = "requesting";
      try {
        await startCameraAndMarker((step) => {
          hudState.cam = step;
        });
        hudState.cam = passthrough!.summary;
        hudState.base += ` camFov=${passthrough!.camHFovDeg}`;
      } catch (e: unknown) {
        hudState.cam = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        cameraError = hudState.cam;
      }
    },
    tryEnterFullscreen,
    onWakeLock: (status) => {
      hudState.wake = status;
    },
  });
});

addEventListener("pagehide", () => {
  client?.dispose();
  netStatus = "closed (pagehide)";
});
addEventListener("pageshow", (e) => {
  if (!e.persisted) return;
  if (!document.body.classList.contains("started")) return;
  const name = readPlayerName();
  if (name !== null) connect(name);
  if (hudState.cam && !hudState.cam.includes("bfcache")) {
    hudState.cam += " (bfcache: カメラ停止の可能性)";
  }
});

if (params.has("autostart")) startButton.click();

// ---- ループ ----
renderer.setAnimationLoop(() => {
  const now = performance.now();
  controls?.update();
  if (FOV_FIXED === null && passthrough) {
    const fov = passthrough.backgroundFovDeg();
    if (fov !== null && Math.abs(fov - camera.fov) > 0.01) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
  }
  camera.updateMatrixWorld();
  markerAnchor?.update(now);
  if (markerAnchor?.everDetected && !anchor.visible) anchor.visible = true;
  markerFrameMaterial.color.setHex(markerAnchor?.isTracking(now, MARKER_LOST_MS) ? 0x8ab4f8 : 0xf28b82);
  anchor.updateMatrixWorld(true);
  updateHands(now);
  updateThrowDetection(now);
  updatePeers(now);
  updateDarts(now);
  sendPoseIfDue(now);
  updateMessages(now);
  if (document.body.classList.contains("started")) renderHud();
  effect.render(scene, camera);
});
