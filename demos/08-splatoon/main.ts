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
import { INDEX_MCP, LANDMARK_COUNT, MIDDLE_MCP, PINKY_MCP, WRIST } from "../../src/shared/hand-math";
import type { Vec3, ViewMapping } from "../../src/shared/hand-math";
import { HandSlots, PALM_CONTACT } from "../../src/shared/hand-slots";
import type { HandResultLike, HandSlot } from "../../src/shared/hand-slots";
import { TextPanel } from "../../src/shared/text-panel";
import { ROOM_ID_PATTERN } from "../../src/shared/shared-room-protocol";
import markerSvgUrl from "../../src/shared/marker-0.svg";
import {
  DEFAULT_FIELD,
  fieldSurfaces,
  inkAt,
  inkPerShot,
  simulateInk,
} from "../../src/shared/splatoon-sim";
import type { FieldConfig, InkColor, InkLanding, SurfaceFrame, V3 } from "../../src/shared/splatoon-sim";
import { inkRegenPerSec } from "../../src/shared/splatoon-game";
import type { GameSnapshot, Shot } from "../../src/shared/splatoon-game";
import { NAME_MAX_LENGTH } from "../../src/shared/splatoon-protocol";
import type { PlayerPose } from "../../src/shared/splatoon-protocol";
import { connectGame } from "./game-client";
import type { GameClient } from "./game-client";
import { InkView, inkColorHex, inkColorName } from "./ink-view";
import { InkTankView } from "./ink-tank";
import { scriptedSplatHand } from "./fake-splat-hand";
import { impactDirUv, isWallSurface, splatShape } from "../../src/shared/splat-shape";
import { createSplatSound } from "./splat-sound";

// Phase 8: MR スプラトゥーン。07（Surface + UV + サーバー権威の共有）に「手の形」「インクの飛翔」「床」
// 「チームと陣取り」を足した統合ゲーム第 3 弾。
//   - フィールド: 壁のマーカー 1 枚で壁（Z=0）と床（Y=-floorDrop）の 2 枚の Surface を定義（splatoon-sim.ts）
//   - 操作: パーの間、手のひらから連射（1 発 = タンクの 1/tankShots。空になると撃てない）。
//     撃つのをやめると回復し、グーの間は速く回復する（撃った直後 1s は回復しない）。残量はサーバー権威。
//     向きは「目 → 手のひら」の視線（06-2 で手の速度方向は狙えないと分かったので、07 の指差しと同じ方式）
//   - インクの残量は手元のタンク（issue #31。ink-tank.ts）: グーで補充している間だけ、そのグーの手のそば（既定は手のひらの親指側）に
//     水位で出す（パーで撃っている間は消す。?tankShow=always なら従来どおり見えている手のそば / 手が無いときは視界の下に常に出す）
//   - 進行（issue #18〜#21）: 入室したら練習（時間無制限に自由に塗れる。案内「グーで補充 / パーで塗る」）→
//     PC の俯瞰画面（overview.html）の「対戦開始」でカウントダウン → 1 分の試合（issue #32。?matchSec=）→ 結果 → 練習に戻る。
//     俯瞰画面の「対戦を終了」で途中でも結果へ（カウントダウン中なら中止して練習へ）。
//     対戦中は視界の上に自分の塗り率と順位を大きく出す（issue #32「パーセント表示がもう少し大きく」）
//   - 共有: サーバー権威（server/splatoon.ts）。発射を検証して着弾を決め、塗りの格子と得点を持つ。
//     クライアントは同じ式（simulateInk）で飛行を描き、着弾時刻にその場所へ塗る
//   - 手が取れないときの保険: 画面（PC は Space）を押している間、視界の中央へ連射

// ---- パラメータ（06-2 / 07 と同じもの。根拠は 06 の main.ts 参照） ----
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

// 飛行・時間（room 内で一致が必要。サーバーが検証）。
// フィールドの寸法（幅・高さ・奥行き・マーカーの高さ）は URL ではなくサーバーの状態で、俯瞰画面から変える（welcome / field で届く）
const GRAVITY = numParam("gravity", DEFAULT_FIELD.gravity, { min: 0, max: 30 });
const MATCH_SEC = numParam("matchSec", DEFAULT_FIELD.matchSec, { min: 10, max: 600 });
/** 俯瞰画面で「対戦開始」を押してから試合が始まるまでのカウントダウン [s] */
const WAIT_SEC = numParam("waitSec", DEFAULT_FIELD.waitSec, { min: 0, max: 120 });
/** ペイント層の解像度 [px/m]（07 と同じ理由で控えめ） */
const SURFACE_PX_PER_M = numParam("surfacePx", 384, { min: 64, max: 2048 });
/** 発射後、サーバーの確認が来るまで予測を出す上限 [ms] */
const PREDICT_MAX_MS = 1500;

/** 着弾の音（?sound=0 で無効） */
const SOUND = params.get("sound") !== "0";

// 手元のインクタンク（issue #31）
/** タンクの板の高さ [m]（幅はその 0.4 倍）。実機で手の大きさと見比べて決める */
const TANK_H = numParam("tankH", 0.12, { min: 0.03, max: 0.5 });
/** タンクの中心を手からずらす距離 [m]（thumb / pinky は手のひらの中心から、arm は手首から） */
const TANK_OFFSET = numParam("tankOffset", 0.09, { min: 0, max: 0.5 });
/** タンクの置き場所: thumb = 手のひらの親指側（既定）、pinky = 小指側、arm = 手首の先（前腕側）。手が低いと arm は視界の下で切れやすい */
const tankPlaceRaw = params.get("tankPlace") ?? "thumb";
const TANK_PLACE: "thumb" | "pinky" | "arm" = tankPlaceRaw === "pinky" || tankPlaceRaw === "arm" ? tankPlaceRaw : "thumb";
/**
 * タンクを出す条件: fist = グーで補充している間だけ、そのグーの手のそばに出す（既定）。
 * always = 見えている手（パー優先）のそばに常に出す（手が無いときは視界の下）
 */
const TANK_SHOW: "fist" | "always" = params.get("tankShow") === "always" ? "always" : "fist";
/** 手が見えないとき、視界の下にタンクを出すか（?tankFallback=0 で出さない。tankShow=always のときだけ意味がある） */
const TANK_FALLBACK = params.get("tankFallback") !== "0";
/**
 * 手が消えてから最後の手の位置に留める時間 [ms]（MediaPipe の一瞬の取りこぼしで往復しないように）。
 * fist のときはこの時間を過ぎたら消える。always のときは視界の下へ落ちる
 */
const TANK_HOLD_MS = numParam("tankHoldMs", 800, { min: 0, max: 5000 });

// デバッグ
const FAKE_CAM = params.has("fakecam");
const FAKE_SHIFT = numParam("fakeShift", 0, { min: -200, max: 200 });
const FAKE_SHIFT_Y = numParam("fakeShiftY", 0, { min: -240, max: 240 });
const FAKE_MARKER_PX = numParam("fakeMarkerPx", 80, { min: 30, max: 400 });
const FAKE_HANDS = params.has("fakehands");

/** タッチ端末（実機）か。PC は OrbitControls + キーボード */
const touch = isTouchDevice();

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

// ---- アンカー（マーカー座標系 = field 座標系）。壁のマーカーなので回さない ----
const anchor = new THREE.Group();
anchor.visible = false;
scene.add(anchor);
const field = anchor;

const markerFrameMaterial = new THREE.MeshBasicMaterial({
  color: 0x8ab4f8,
  transparent: true,
  opacity: 0.4,
  side: THREE.DoubleSide,
});
anchor.add(new THREE.Mesh(new THREE.PlaneGeometry(MARKER_SIZE_M, MARKER_SIZE_M), markerFrameMaterial));

// ---- フィールド（壁 + 床）----
// 寸法はサーバーが権威（welcome / field で届く）。届くまでは既定の寸法で枠だけ出しておく
let fieldCfg: FieldConfig = {
  ...DEFAULT_FIELD,
  gravity: GRAVITY,
  matchSec: MATCH_SEC,
  waitSec: WAIT_SEC,
};
let surfaces: SurfaceFrame[] = [];
const inkViews = new Map<string, InkView>();

// スコアボード: 壁の上端（issue #32 で 1.0×0.22 → 1.5×0.33 に拡大。壁から 2〜3m 離れると読めなかった）。視界内メッセージ: カメラの子
const scorePanel = new TextPanel(1.5, 0.33);
field.add(scorePanel.mesh);

/** 壁と床（5 枚）と塗りの層を config から作り直す（起動時と、寸法が変わったとき） */
function buildField() {
  for (const v of inkViews.values()) v.dispose();
  inkViews.clear();
  surfaces = fieldSurfaces(fieldCfg);
  for (const s of surfaces) {
    const view = new InkView(s, SURFACE_PX_PER_M, fieldCfg.cellM);
    field.add(view.group);
    inkViews.set(s.id, view);
  }
  // 壁の下端は床（-floorDrop）に接続し、上端は床から wallH
  scorePanel.mesh.position.set(0, -fieldCfg.floorDrop + fieldCfg.wallH + 0.22, 0.01);
}
buildField();

/** サーバーの config を取り込む。壁と床の形に効く値が変わっていたら作り直す（塗りは直後の state の格子で描き直される） */
function applyFieldConfig(cfg: FieldConfig): boolean {
  const changed = cfg.wallW !== fieldCfg.wallW || cfg.wallH !== fieldCfg.wallH || cfg.floorDepth !== fieldCfg.floorDepth || cfg.floorDrop !== fieldCfg.floorDrop || cfg.cellM !== fieldCfg.cellM;
  fieldCfg = cfg;
  if (changed) buildField();
  return changed;
}
const message = new TextPanel(0.9, 0.24);
message.mesh.position.set(0, -0.28, -1.2);
camera.add(message.mesh);
// 手元のインクタンク（issue #31）。置き場所と残量は updateInkTank で毎フレーム決める
const inkTank = new InkTankView(TANK_H);
camera.add(inkTank.mesh);
// 自分の塗り率と順位（視界の上・対戦中だけ。issue #32「対戦中のパーセント表示がもう少し大きく見えると良い」。
// 壁のスコアボードは離れると小さいので、視界に固定して minCols=8 で文字を大きく出す）
const percentPanel = new TextPanel(0.6, 0.16, 512, 8);
percentPanel.mesh.position.set(0, 0.34, -1.2);
camera.add(percentPanel.mesh);

// ---- インクの玉（飛行中）----
const inkGeometry = new THREE.SphereGeometry(1, 16, 12);
const inkMaterials = new Map<number, THREE.MeshStandardMaterial>();
function inkMaterialOf(color: InkColor): THREE.MeshStandardMaterial {
  let m = inkMaterials.get(color);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color: inkColorHex(color), roughness: 0.4 });
    inkMaterials.set(color, m);
  }
  return m;
}
function createInkMesh(color: InkColor, radius: number): THREE.Mesh {
  const m = new THREE.Mesh(inkGeometry, inkMaterialOf(color));
  m.scale.setScalar(radius * 0.45);
  field.add(m);
  return m;
}
const splatSound = createSplatSound(SOUND);
// iOS はバックグラウンド移行や音声割り込みで AudioContext が suspended に戻るので、タッチのたびと復帰時に resume を試す
addEventListener("pointerdown", () => splatSound.unlock());
addEventListener("pageshow", () => splatSound.unlock());
addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") splatSound.unlock();
});

// ---- ピア（他のプレイヤー）: 頭 + 手（06-2 と同じ）。チーム色 ----
type Peer = {
  group: THREE.Group;
  materials: THREE.MeshStandardMaterial[];
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
  removePeer(id);
  const group = new THREE.Group();
  const headMat = new THREE.MeshStandardMaterial({ color: 0xe8eaed, transparent: true });
  const noseMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, transparent: true });
  group.add(new THREE.Mesh(peerHeadGeometry, headMat));
  const nose = new THREE.Mesh(peerNoseGeometry, noseMat);
  nose.rotation.x = -Math.PI / 2;
  nose.position.z = -0.1;
  group.add(nose);
  group.visible = false;
  field.add(group);
  const hands = [new HandView(0xe8eaed, 0.01), new HandView(0xe8eaed, 0.01)];
  for (const h of hands) field.add(h.group);
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
    for (let k = 0; k < LANDMARK_COUNT; k++) pts.push({ x: flat[k * 3], y: flat[k * 3 + 1], z: flat[k * 3 + 2] });
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
    const color = colorHexOf(id);
    peer.materials[0].color.setHex(color);
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

// ---- パススルー（PC デバッグ用フェイクカメラは 06-2 / 07 と同じ描き方） ----
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
    // 連射中にフィールドが飛ぶと発射の向きがずれるので lerp だけ
    // 発射間隔（250ms）よりわずかに長く。連射の合間には再スナップできる
    canSnap: () => performance.now() - lastShotMs > 300,
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

function updateFakeHands(now: number) {
  if (now - lastDetectAt < 33 || !passthrough) return;
  const mapping = passthrough.displayViewMapping(camera.fov);
  if (fakeStartMs < 0) fakeStartMs = now;
  lastDetectAt = now;
  const r = scriptedSplatHand((now - fakeStartMs) / 1000, mapping);
  if (r) applyHandResult(r, now);
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
  // 自分の手はチーム色
  for (const slot of handSlots.slots) {
    if (!slot.view.visible) continue;
    slot.view.setColor(myColor ? inkColorHex(myColor) : 0xe8eaed);
  }
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
let joined = false;
let auth: { state: GameSnapshot; recvMs: number } | null = null;
let myColor: InkColor | null = null;
let cameraError = "";
let shotsSent = 0;
let shotsAccepted = 0;
let lastRejectReason = "";
let flash: { text: string; untilMs: number } | null = null;
let lastEventKey = "";

function colorOf(id: string): InkColor | null {
  return auth?.state.players.find((p) => p.id === id)?.color ?? null;
}
function colorHexOf(id: string): number {
  const c = colorOf(id);
  return c ? inkColorHex(c) : 0xe8eaed;
}

/** 権威時刻 → 受信時刻基準のローカル時刻 [ms] */
function localTimeOf(serverT: number, refServerT: number, refLocalMs: number): number {
  return refLocalMs + (serverT - refServerT);
}

function onState(state: GameSnapshot) {
  const now = performance.now();
  auth = { state, recvMs: now };
  myColor = colorOf(selfId);
  // インク残量はサーバーが権威。受信のたびローカルの予測を上書きする（間はローカルで進める）
  const serverInk = state.ink?.[selfId];
  if (serverInk !== undefined) inkLocal = serverInk;
  const ev = state.event;
  const key = ev ? `${state.seq}:${ev.kind}` : "";
  if (key && key !== lastEventKey) {
    lastEventKey = key;
    if (ev?.kind === "start") flash = { text: "スタート！ 塗れ！", untilMs: now + 2500 };
    else if (ev?.kind === "countdown") flash = { text: "まもなく対戦開始！\n構えてください", untilMs: now + 2500 };
    else if (ev?.kind === "practice") flash = { text: "練習に戻りました\n（開始は俯瞰画面から）", untilMs: now + 3000 };
    else if (ev?.kind === "cancel") flash = { text: "対戦開始は中止されました\n練習を続けてください", untilMs: now + 3000 };
    else if (ev?.kind === "field") flash = { text: `フィールドが変わりました\n幅 ${fieldCfg.wallW}m × 高さ ${fieldCfg.wallH}m × 奥行き ${fieldCfg.floorDepth}m\nマーカーの高さ ${fieldCfg.floorDrop}m`, untilMs: now + 3000 };
    else if (ev?.kind === "result") {
      const text =
        ev.winners.length === 0
          ? "だれも塗れず…"
          : ev.winners.includes(selfId)
            ? "あなたの勝ち！"
            : `${ev.winnerNames.join("・")} の勝ち！`;
      flash = { text: ev.stopped ? `そこまで！\n${text}` : text, untilMs: now + 4000 };
    }
    console.log(`[game] event ${ev?.kind} phase=${state.phase} scores=${JSON.stringify(state.scores)} players=${state.players.length}`);
  }
  if (state.grids) {
    for (const [id, enc] of Object.entries(state.grids)) {
      inkViews.get(id)?.redrawFromGrid(enc, fieldCfg.cellM);
    }
    // 格子で描き直したので、着弾済みの玉の再描画は要らない
    for (const s of state.shots) if (s.landing?.hit) splatted.add(s.seq);
  }
  // 発射一覧の同期（再接続直後の取りこぼし用。既知の seq は無視）
  for (const s of state.shots) {
    if (!shots.has(s.seq)) addShot(s, state.t, now);
  }
}

function connect(name: string) {
  if (ROOM === null) return;
  client = connectGame(
    ROOM,
    name,
    {
      markerId: MARKER_ID,
      markerMm: MARKER_MM,
      gravity: GRAVITY,
      matchSec: MATCH_SEC,
      waitSec: WAIT_SEC,
    },
    {
      onStatus: (status) => {
        netStatus = status;
        if (status !== "open") joined = false;
      },
      onError: (reason) => {
        netStatus = `error: ${reason}`;
        console.warn(`[game] rejected: ${reason}`);
      },
      onWelcome: (id, _role, peerIds, cfg, state) => {
        selfId = id;
        netStatus = "open";
        joined = true;
        posesSent = 0;
        applyFieldConfig(cfg);
        [...peers.keys()].forEach(removePeer);
        peerIds.forEach(createPeer);
        clearPredicted();
        lastEventKey = "";
        // 既知の発射は捨てて snapshot から作り直す
        for (const s of shots.values()) s.mesh.removeFromParent();
        shots.clear();
        splatted.clear();
        onState(state);
        console.log(`[game] joined "${ROOM}" as ${id} color=${myColor} (peers: ${peerIds.join(", ") || "none"})`);
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
      onShot: (shot, serverT) => {
        const now = performance.now();
        let launchLocalMs: number | undefined;
        if (shot.by === selfId) {
          shotsAccepted++;
          // 自分の玉は予測の発射時刻を引き継ぐ（RTT ぶん後退しないように）
          launchLocalMs = predicted?.sinceMs;
          clearPredicted();
        }
        addShot(shot, serverT, now, launchLocalMs);
      },
      onRejected: (reason) => {
        lastRejectReason = reason;
        clearPredicted();
        console.log(`[game] shot rejected by server: ${reason}`);
      },
      onState,
      onField: (cfg, state) => {
        // 寸法が変わった: 壁と床を作り直し、飛んでいる玉と予測は捨てる（古い面への着弾なので）
        applyFieldConfig(cfg);
        clearPredicted();
        for (const s of shots.values()) s.mesh.removeFromParent();
        shots.clear();
        splatted.clear();
        onState(state);
        console.log(`[game] field ${cfg.wallW}x${cfg.wallH}x${cfg.floorDepth}/${cfg.floorDrop}`);
      },
    },
  );
}

// 自分の姿勢（field 座標系）+ 手の 21 点 + チャージ量を送る
const fieldInv = new THREE.Matrix4();
const poseMatrix = new THREE.Matrix4();
const posePos = new THREE.Vector3();
const poseQuat = new THREE.Quaternion();
const poseScale = new THREE.Vector3();
let lastSendMs = -Infinity;
/** 入室後に pose を送った回数。サーバーは pose が届く前の発射を拒否するので、最初の pose まで撃たない */
let posesSent = 0;

function sendPoseIfDue(now: number) {
  if (!client || !markerAnchor?.everDetected) return;
  if (now - lastSendMs < SEND_INTERVAL_MS) return;
  lastSendMs = now;
  fieldInv.copy(field.matrixWorld).invert();
  poseMatrix.multiplyMatrices(fieldInv, camera.matrixWorld);
  poseMatrix.decompose(posePos, poseQuat, poseScale);
  const hands: number[][] = [];
  for (const slot of handSlots.visible()) {
    if (!slot.ema) continue;
    const flat: number[] = [];
    for (const p of slot.ema) {
      tmpVec.set(p.x, p.y, p.z);
      camera.localToWorld(tmpVec);
      field.worldToLocal(tmpVec);
      flat.push(round3(tmpVec.x), round3(tmpVec.y), round3(tmpVec.z));
    }
    hands.push(flat);
  }
  const pose: PlayerPose = {
    pos: [round3(posePos.x), round3(posePos.y), round3(posePos.z)],
    quat: [poseQuat.x, poseQuat.y, poseQuat.z, poseQuat.w],
    tracking: markerAnchor.isTracking(now, MARKER_LOST_MS),
  };
  if (hands.length > 0) pose.hands = hands;
  if (isFist()) pose.fist = true;
  if (client.sendPose(pose)) posesSent++;
}

/** 見えている手のどれかがグーか（インクの回復が速くなる。サーバーにも送る） */
function isFist(): boolean {
  return handSlots.slots.some((s) => s.view.visible && s.ema && s.shape === "fist");
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

// ---- 連射とインクタンク ----
// パー（"open"）の間、手のひらから fireRatePerSec で連射。1 発 = タンクの 1/tankShots。
// 撃つのをやめると回復し、グー（"fist"）の間は速く回復する（撃った直後 inkRegenDelaySec は回復しない。
// 場所には依存しない — 3DoF では頭の位置がマーカーを見ている間しか更新できないため、位置ベースの回復はやめた）。
// 残量の権威はサーバー（state.ink）。ローカルは同じ式（inkRegenPerSec）で予測し、state が来るたび上書きされる。
// 手が取れないときは画面 / Space の長押しで視界の中央へ連射
let lastShotMs = -Infinity;
let holdPressed = false;
let lastShapeInfo = "";
/** インク残量 0..1 のローカル予測（表示用。権威は state.ink） */
let inkLocal = 1;
let lastInkUpdateMs = performance.now();
let lastNoInkFlashMs = -Infinity;

/** いまの残量で 1 発撃てるか（発射と、タンクの「空」表示で同じ判定。減算の丸め誤差ぶんの余裕を持つ） */
function hasInkForShot(): boolean {
  return inkLocal + 1e-9 >= inkPerShot(fieldCfg);
}

/** 練習中と試合中に撃てる（カウントダウン中・結果表示中は撃てない） */
function canShoot(): boolean {
  const phase = auth?.state.phase;
  return joined && (phase === "play" || phase === "practice") && anchor.visible && myColor !== null && posesSent > 0;
}

const camWorldPos = new THREE.Vector3();
const shotOrigin = new THREE.Vector3();
const shotDir = new THREE.Vector3();

/** 発射: origin（ワールド）から、目（カメラ）→ origin の向きへ 1 発 */
function fire(originWorld: THREE.Vector3, now: number, how: string) {
  if (!client || !canShoot()) return;
  camera.getWorldPosition(camWorldPos);
  shotDir.subVectors(originWorld, camWorldPos);
  if (shotDir.lengthSq() < 1e-6) shotDir.set(0, 0, -1).applyQuaternion(camera.getWorldQuaternion(tmpQuat));
  shotDir.normalize();
  // ワールド → field 座標系（位置は変換、向きは回転だけ）
  shotOrigin.copy(originWorld);
  field.worldToLocal(shotOrigin);
  field.getWorldQuaternion(tmpQuat).invert();
  shotDir.applyQuaternion(tmpQuat);
  const speed = fieldCfg.shotSpeed;
  const radius = fieldCfg.shotRadius;
  const pos: V3 = [round3(shotOrigin.x), round3(shotOrigin.y), round3(shotOrigin.z)];
  const vel: V3 = [round3(shotDir.x * speed), round3(shotDir.y * speed), round3(shotDir.z * speed)];
  if (!client.sendShot(pos, vel, radius)) return;
  lastShotMs = now;
  shotsSent++;
  inkLocal = Math.max(0, inkLocal - inkPerShot(fieldCfg));
  clearPredicted();
  predicted = { pos, vel, radius, sinceMs: now, landing: simulateInk(pos, vel, surfaces, fieldCfg), mesh: null };
  console.log(`[game] shot sent (${how}) ink=${inkLocal.toFixed(2)} pos=(${pos.join(",")}) vel=(${vel.join(",")}) land=${predicted.landing?.hit ? `${predicted.landing.surfaceId} ${predicted.landing.uv.map((v) => v.toFixed(2)).join(",")}` : "miss"}`);
}

function updateFire(now: number) {
  // ローカルのインク予測（サーバーと同じ式。state が来たら上書きされる）。撃った直後は回復しない
  const regenFrom = Math.max(lastInkUpdateMs, lastShotMs + fieldCfg.inkRegenDelaySec * 1000);
  const dt = Math.min(1, Math.max(0, (now - regenFrom) / 1000));
  lastInkUpdateMs = now;
  if (dt > 0) {
    inkLocal = Math.min(1, inkLocal + dt * inkRegenPerSec(fieldCfg, isFist()));
  }

  const openSlot = handSlots.slots.find((s) => s.view.visible && s.ema && s.shape === "open");

  const interval = 1000 / fieldCfg.fireRatePerSec;
  const wantHand = openSlot && canShoot();
  const wantGaze = !openSlot && holdPressed && canShoot();
  if ((wantHand || wantGaze) && now - lastShotMs >= interval) {
    if (!hasInkForShot()) {
      if (now - lastNoInkFlashMs > 2000) {
        lastNoInkFlashMs = now;
        flash = { text: "インク切れ！\n少し待つと回復します", untilMs: now + 2000 };
      }
    } else if (wantHand) {
      fire(openSlot!.contactsWorld[PALM_CONTACT], now, "hand");
    } else {
      // 視界の中央、目の 30cm 先から
      tmpVec2.set(0, 0, -0.3);
      camera.localToWorld(tmpVec2);
      fire(tmpVec2, now, "gaze");
    }
  }
  const shapes = handSlots.slots.filter((s) => s.view.visible).map((s) => s.shape);
  lastShapeInfo = shapes.join(",") || "-";
}

if (touch) {
  const appEl = document.querySelector<HTMLDivElement>("#app")!;
  // Android Chrome は長押しで contextmenu が出て押し続けが切れるので抑止する
  appEl.addEventListener("contextmenu", (e) => e.preventDefault());
  appEl.addEventListener("pointerdown", () => {
    if (document.body.classList.contains("started")) holdPressed = true;
  });
  addEventListener("pointerup", () => {
    holdPressed = false;
  });
  addEventListener("pointercancel", () => {
    holdPressed = false;
  });
} else {
  addEventListener("keydown", (e) => {
    if (e.key === " " && document.body.classList.contains("started")) {
      e.preventDefault();
      holdPressed = true;
    }
  });
  addEventListener("keyup", (e) => {
    if (e.key === " ") holdPressed = false;
  });
}
function releaseHold() {
  holdPressed = false;
}
addEventListener("blur", releaseHold);
addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") releaseHold();
});

// ---- インクの描画（権威の launch から同じ式で飛行を進め、着弾時刻に塗る） ----
type LiveShot = { shot: Shot; launchLocalMs: number; mesh: THREE.Mesh };
const shots = new Map<number, LiveShot>();
const splatted = new Set<number>();
type Predicted = { pos: V3; vel: V3; radius: number; sinceMs: number; landing: InkLanding | null; mesh: THREE.Mesh | null };
/**
 * 未確認の予測は 1 発ぶんだけ持つ（連射中は次の発射で前の予測を消す）。
 * RTT が発射間隔（167ms）を超えると自分の玉の見た目が一瞬跳び得るが、LAN の RTT（10〜30ms）では
 * 起きないので発射 ID の導入は見送っている（外部レビュー指摘・既知の制約）
 */
let predicted: Predicted | null = null;

function clearPredicted() {
  predicted?.mesh?.removeFromParent();
  predicted = null;
}

function addShot(shot: Shot, serverT: number, recvMs: number, launchLocalMs?: number) {
  const mesh = createInkMesh(shot.color, shot.radius);
  shots.set(shot.seq, { shot, launchLocalMs: launchLocalMs ?? localTimeOf(shot.launchedAt, serverT, recvMs), mesh });
}

const inkLookAt = new THREE.Vector3();
/** 飛んでいる玉を進行方向に少し伸ばす（スクワッシュ）。玉は field の子なので lookAt の目標はワールドに直す */
function placeInk(mesh: THREE.Mesh, pos: V3, vel: V3, elapsed: number, landing: InkLanding | null, radius: number): boolean {
  const hitT = landing?.hitT ?? fieldCfg.maxFlightSec;
  if (elapsed >= hitT) {
    mesh.visible = false;
    return true;
  }
  const t = Math.max(0, elapsed);
  const p = inkAt(pos, vel, t, fieldCfg.gravity);
  mesh.position.set(p[0], p[1], p[2]);
  inkLookAt.set(p[0] + vel[0], p[1] + vel[1] - fieldCfg.gravity * t, p[2] + vel[2]);
  field.localToWorld(inkLookAt);
  mesh.lookAt(inkLookAt);
  const base = radius * 0.45;
  mesh.scale.set(base * 0.85, base * 0.85, base * 1.35);
  mesh.visible = true;
  return false;
}

/** 着弾を飛沫の形で塗る（形はサーバーと同じ seq 由来。見た目 = 得点）。音も鳴らす */
function splatLanding(shot: Shot, now: number) {
  const landing = shot.landing;
  if (!landing?.hit) return;
  const surface = surfaces.find((s) => s.id === landing.surfaceId);
  const view = inkViews.get(landing.surfaceId);
  if (!surface || !view) return;
  const shape = splatShape(shot.seq, shot.radius, impactDirUv(landing, shot.vel, surface, fieldCfg.gravity), isWallSurface(surface));
  const overwrote = view.splat(shot.seq, landing.uv, shape, shot.color, now);
  splatSound.play(shot.by === selfId ? 0.5 : 0.3, overwrote);
}

function updateShots(now: number) {
  for (const [seq, live] of shots) {
    const { shot } = live;
    const elapsed = (now - live.launchLocalMs) / 1000;
    const landed = placeInk(live.mesh, shot.pos, shot.vel, elapsed, shot.landing, shot.radius);
    if (landed && shot.landing?.hit && !splatted.has(seq)) {
      splatted.add(seq);
      splatLanding(shot, now);
    }
    if (elapsed > fieldCfg.maxFlightSec + 1) {
      live.mesh.removeFromParent();
      shots.delete(seq);
      splatted.delete(seq);
    }
  }
  if (predicted) {
    if (now - predicted.sinceMs > PREDICT_MAX_MS) {
      clearPredicted();
    } else {
      if (!predicted.mesh) predicted.mesh = createInkMesh(myColor ?? 1, predicted.radius);
      placeInk(predicted.mesh, predicted.pos, predicted.vel, (now - predicted.sinceMs) / 1000, predicted.landing, predicted.radius);
    }
  }
}

// ---- 視界内メッセージとスコアボード ----
function remainingSec(now: number): number {
  if (!auth || auth.state.phaseEndsAt === null) return 0;
  return Math.max(0, (auth.state.phaseEndsAt - auth.state.t) / 1000 - (now - auth.recvMs) / 1000);
}

function updateMessages(now: number) {
  const s = auth?.state;
  if (s) {
    const total = Math.max(1, s.totalCells);
    const left = Math.ceil(remainingSec(now));
    const head =
      s.phase === "result" ? "結果" : s.phase === "waiting" ? `開始まで ${left} 秒` : s.phase === "practice" ? "練習中（開始は俯瞰画面から）" : `残り ${left} 秒`;
    const sorted = [...s.players].sort((a, b) => (s.scores[b.id] ?? 0) - (s.scores[a.id] ?? 0));
    const ranking = sorted.map((p, i) => {
      const pct = (((s.scores[p.id] ?? 0) / total) * 100).toFixed(1);
      const win = s.winners?.includes(p.id) ? " 🏆" : "";
      return `${i + 1}. ${inkColorName(p.color)} ${p.name}${p.id === selfId ? "（あなた）" : ""} ${pct}%${win}`;
    });
    scorePanel.set([head, ...ranking].join("\n"), "#e8eaed", "left");
    // 対戦中だけ、自分の塗り率と順位を視界の上に大きく（同点は同じ順位）
    const myIndex = sorted.findIndex((p) => p.id === selfId);
    if (s.phase === "play" && myIndex >= 0 && myColor) {
      const myScore = s.scores[selfId] ?? 0;
      const rank = sorted.findIndex((p) => (s.scores[p.id] ?? 0) === myScore) + 1;
      percentPanel.set(`${rank}位 ${((myScore / total) * 100).toFixed(1)}%`, `#${inkColorHex(myColor).toString(16).padStart(6, "0")}`);
    } else {
      percentPanel.set("");
    }
  } else {
    percentPanel.set("");
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
    text = "手の検出に失敗しました\n画面を押している間、視界の中央へ連射";
    color = "#f28b82";
  } else if (!FAKE_HANDS && !tracker) {
    text = "手の検出を読み込み中…";
    color = "#fdd663";
  } else if (netStatus !== "open" && selfId !== "") {
    text = "接続が切れました（再接続中）";
    color = "#f28b82";
  } else if (!joined || !auth) {
    text = netStatus === "open" ? "入室中…" : `サーバーに接続中… (${netStatus})`;
    color = "#fdd663";
  } else if (flash && now < flash.untilMs) {
    text = flash.text;
    color = flash.text.startsWith("インク切れ") ? "#fdd663" : "#81c995";
  } else if (auth.state.phase === "result") {
    const w = auth.state.winners ?? [];
    const names = auth.state.winnerNames ?? [];
    text = w.length === 0 ? "だれも塗れず…" : w.includes(selfId) ? "あなたの勝ち！" : `${names.join("・")} の勝ち`;
    color = w.includes(selfId) ? "#81c995" : "#e8eaed";
  } else if (auth.state.phase === "waiting") {
    text = `まもなく開始（${Math.ceil(remainingSec(now))} 秒）\nあなたは ${myColor ? inkColorName(myColor) : "-"}`;
    color = "#fdd663";
  } else if (auth.state.phase === "practice") {
    // チュートリアル（issue #20）: 練習中は操作の案内を出しっぱなしにする
    text = `練習中（あなたは ${myColor ? inkColorName(myColor) : "-"}）\nパーで塗る ／ グーで補充\n対戦は俯瞰画面の「開始」から`;
    color = myColor ? `#${inkColorHex(myColor).toString(16).padStart(6, "0")}` : "#e8eaed";
  } else {
    // 対戦中: 1 分と短いので残り時間も視界に（塗り率は上の percentPanel）
    text = `残り ${Math.ceil(remainingSec(now))} 秒（あなたは ${myColor ? inkColorName(myColor) : "-"}）\nパーで塗る ／ グーで補充`;
    color = myColor ? `#${inkColorHex(myColor).toString(16).padStart(6, "0")}` : "#e8eaed";
  }
  message.set(text, color);
}

// ---- 手元のインクタンク（issue #31）----
// 既定（TANK_SHOW = fist）はグーで補充している間だけ、そのグーの手のそばに置く。パーで撃っている間は残量を見ないので消して、
// 視界を塞がないようにする（撃てなくなったらグーにすれば残量と回復が見える）。グーの手を一瞬見失っても TANK_HOLD_MS は
// 最後の位置に留める（MediaPipe の取りこぼし・再検出直後の 3 フレームは形が "other" になるのでちらつかないように）が、
// パーが見えたら即座に消す。
// ?tankShow=always は従来どおり: 見えている手（パーを優先）のそばに常に出し、手が見えないとき（視線連射・手を下ろしたとき）は
// 視界の下に大きめに出す（消えてから TANK_HOLD_MS は最後の位置に留める）。
// 置き場所は手のひらの中心から親指側（小指の付け根 → 人差し指の付け根の向き）へ TANK_OFFSET ずらした位置
// （?tankPlace= で小指側・手首の先にもできる。向きは手の 3D 点から取るので手を回しても同じ側に付く）。
// 板はカメラの子なので常に正面を向き、水位は手の向きによらず鉛直（残量を読むため。手に貼り付ける見た目より読みやすさ）。
// 置き場所が変わるときは TANK_GLIDE_MS で滑らせる
/** 視界の下の位置（1.2m 先）。上端が視界内メッセージの下端 -0.40 より下（脈動 ×1.06 ぶんも含めて）になる高さ */
const TANK_FALLBACK_POS = new THREE.Vector3(0, -0.51, -1.2);
/** 視界の下に出すときの高さ [m]（1.2m 先なので手元より大きく） */
const TANK_FALLBACK_H = 0.2;
const TANK_GLIDE_MS = 250;
const tankTarget = new THREE.Vector3();
const tankFrom = new THREE.Vector3();
let tankFromScale = 1;
let tankGlideStartMs = -Infinity;
let tankSlot: HandSlot | null = null;
/** 最後に手のそばに置いた時刻 [ms]（TANK_HOLD_MS の判定） */
let tankLastHandMs = -Infinity;
/** いまの置き場所（HUD 用）: hand = 手元、view = 視界の下、- = 非表示 */
let tankPlace: "hand" | "view" | "-" = "-";

function updateInkTank(now: number) {
  if (!joined || !myColor) {
    inkTank.mesh.visible = false;
    tankPlace = "-";
    return;
  }
  const visibleSlots = handSlots.slots.filter((s) => s.view.visible && s.ema);
  const slot =
    TANK_SHOW === "fist"
      ? (visibleSlots.find((s) => s.shape === "fist") ?? null)
      : (visibleSlots.find((s) => s.shape === "open") ?? visibleSlots[0] ?? null);
  /** fist のとき: パーが見えている（撃っている）ので、猶予を待たずに消す */
  const hideNow = TANK_SHOW === "fist" && visibleSlots.some((s) => s.shape === "open");
  let place: typeof tankPlace;
  let targetScale: number;
  if (slot?.ema) {
    const wrist = slot.ema[WRIST];
    const mcp = slot.ema[MIDDLE_MCP];
    if (TANK_PLACE === "arm") {
      // 手首から前腕の向き（手首 − 中指の付け根）へ
      tmpVec.set(wrist.x - mcp.x, wrist.y - mcp.y, wrist.z - mcp.z);
      tankTarget.set(wrist.x, wrist.y, wrist.z);
    } else {
      // 手のひらの中心（手首と中指の付け根の中点）から親指側（小指の付け根 → 人差し指の付け根）か小指側へ
      const idx = slot.ema[INDEX_MCP];
      const pky = slot.ema[PINKY_MCP];
      tmpVec.set(idx.x - pky.x, idx.y - pky.y, idx.z - pky.z);
      if (TANK_PLACE === "pinky") tmpVec.negate();
      tankTarget.set((wrist.x + mcp.x) / 2, (wrist.y + mcp.y) / 2, (wrist.z + mcp.z) / 2);
    }
    if (tmpVec.lengthSq() < 1e-8) tmpVec.set(0, -1, 0);
    else tmpVec.normalize();
    tankTarget.addScaledVector(tmpVec, TANK_OFFSET);
    tankLastHandMs = now;
    targetScale = 1;
    place = "hand";
  } else if (!hideNow && tankPlace === "hand" && now - tankLastHandMs < TANK_HOLD_MS) {
    // 手（fist ならグーの手）が消えた直後: 最後の位置（tankTarget のまま）に留める。すぐ再検出されればそこから滑る
    targetScale = 1;
    place = "hand";
  } else if (TANK_SHOW === "always" && TANK_FALLBACK) {
    tankTarget.copy(TANK_FALLBACK_POS);
    targetScale = TANK_FALLBACK_H / TANK_H;
    place = "view";
  } else {
    inkTank.mesh.visible = false;
    tankPlace = "-";
    tankSlot = null;
    return;
  }
  if (place !== tankPlace || slot !== tankSlot) {
    // 置き場所が変わった: いまの位置から目標へ滑らせる（非表示からは即座に置く）
    if (tankPlace === "-") {
      tankGlideStartMs = -Infinity;
    } else {
      tankFrom.copy(inkTank.mesh.position);
      tankFromScale = inkTank.baseScale;
      tankGlideStartMs = now;
    }
    tankPlace = place;
    tankSlot = slot;
  }
  const p = Math.min(1, (now - tankGlideStartMs) / TANK_GLIDE_MS);
  const k = 1 - (1 - p) * (1 - p);
  if (k >= 1) {
    inkTank.mesh.position.copy(tankTarget);
    inkTank.baseScale = targetScale;
  } else {
    inkTank.mesh.position.lerpVectors(tankFrom, tankTarget, k);
    inkTank.baseScale = tankFromScale + (targetScale - tankFromScale) * k;
  }
  inkTank.set(inkLocal, inkColorHex(myColor), !hasInkForShot());
  inkTank.update(now);
  inkTank.mesh.visible = true;
}

// ---- 頭追従（02〜07 と同じ） ----
type HeadControls = { update: () => void };
let controls: HeadControls | null = null;

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
  const now = performance.now();
  const text = [
    `${hudState.base} (fov now=${camera.fov.toFixed(1)})`,
    hudState.sensor && `sensor=${hudState.sensor}`,
    hudState.cam && `cam=${hudState.cam}`,
    hudState.fsResult && `fs=${hudState.fsResult}`,
    hudState.fsChange && `fs-change: ${hudState.fsChange}`,
    hudState.wake && `wake=${hudState.wake}`,
    `marker=${markerAnchor?.info ?? "-"}${markerAnchor?.everDetected && !markerAnchor.isTracking(now, MARKER_LOST_MS) ? " (holding last pose)" : ""}`,
    `tracker=${trackerStatus}${lastTrackerError ? ` (last error: ${lastTrackerError})` : ""}`,
    (tracker || FAKE_HANDS) &&
      `hands=${lastResultHands} ${handSlots.describe() || "-"} shape=${lastShapeInfo} infer=${(tracker?.lastMs ?? 0).toFixed(0)}ms every ${detIntervalEma.toFixed(0)}ms`,
    `room=${ROOM ?? "(不正)"} me=${selfId || "-"} peers=${peers.size} ws=${netStatus} field=${fieldCfg.wallW}x${fieldCfg.wallH}x${fieldCfg.floorDepth}/${fieldCfg.floorDrop} ink=${inkLocal.toFixed(2)} tank=${tankPlace} fist=${isFist() ? "yes" : "no"} held=${holdPressed ? "yes" : "no"}`,
    s &&
      `game: phase=${s.phase} left=${remainingSec(now).toFixed(0)}s color=${myColor ?? "-"} players=${s.players.map((p) => `${p.id}:${p.color}`).join(",")} scores=${s.players.map((p) => `${p.id}:${s.scores[p.id] ?? 0}`).join(",")} total=${s.totalCells} shots=${shotsSent}/${shotsAccepted} live=${shots.size} seq=${s.seq}${lastRejectReason ? ` lastReject=${lastRejectReason}` : ""}`,
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
  splatSound.unlock(); // ユーザージェスチャー内（iOS の AudioContext）
  hudState.base = `fov=${FOV_FIXED ?? "auto"} camZoom=${CAM_ZOOM} markerMm=${MARKER_MM} detW=${MARKER_DET_W}@${MARKER_INTERVAL_MS}ms hands=${NUM_HANDS} delegate=${DELEGATE} handScale=${HAND_SCALE} gravity=${GRAVITY} matchSec=${MATCH_SEC} mode=${touch ? "gyro" : "orbit"}`;
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
  releaseHold();
  client?.dispose();
  joined = false;
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
  const tracking = markerAnchor?.isTracking(now, MARKER_LOST_MS) ?? false;
  markerFrameMaterial.color.setHex(tracking ? 0x8ab4f8 : 0xf28b82);
  for (const v of inkViews.values()) v.setFrameColor(tracking ? 0x8ab4f8 : 0xf28b82);
  anchor.updateMatrixWorld(true);
  updateHands(now);
  updateFire(now);
  updatePeers(now);
  updateShots(now);
  for (const v of inkViews.values()) v.update(now);
  sendPoseIfDue(now);
  updateMessages(now);
  updateInkTank(now);
  if (document.body.classList.contains("started")) renderHud();
  effect.render(scene, camera);
});
