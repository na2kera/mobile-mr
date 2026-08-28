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
import { createMarkerAnchor } from "../../src/shared/marker-anchor";
import type { MarkerAnchor } from "../../src/shared/marker-anchor";
import { createHandTracker } from "../../src/shared/hand-tracker";
import type { HandTracker } from "../../src/shared/hand-tracker";
import { HandView } from "../../src/shared/hand-view";
import { LANDMARK_COUNT } from "../../src/shared/hand-math";
import type { Vec3, ViewMapping } from "../../src/shared/hand-math";
import { HandSlots, PALM_CONTACT } from "../../src/shared/hand-slots";
import type { HandResultLike, HandSlot } from "../../src/shared/hand-slots";
import { TextPanel } from "../../src/shared/text-panel";
import { ROOM_ID_PATTERN } from "../../src/shared/shared-room-protocol";
import markerSvgUrl from "../../src/shared/marker-0.svg";
import {
  DEFAULT_FIELD,
  chargeToShot,
  fieldSurfaces,
  inkAt,
  simulateInk,
} from "../../src/shared/splatoon-sim";
import type { FieldConfig, InkLanding, SurfaceFrame, Team, V3 } from "../../src/shared/splatoon-sim";
import type { GameSnapshot, Shot } from "../../src/shared/splatoon-game";
import { NAME_MAX_LENGTH } from "../../src/shared/splatoon-protocol";
import type { PlayerPose } from "../../src/shared/splatoon-protocol";
import { connectGame } from "./game-client";
import type { GameClient } from "./game-client";
import { InkView, TEAM_COLORS, TEAM_NAMES } from "./ink-view";
import { scriptedSplatHand } from "./fake-splat-hand";

// Phase 8: MR スプラトゥーン。07（Surface + UV + サーバー権威の共有）に「手の形」「インクの飛翔」「床」
// 「チームと陣取り」を足した統合ゲーム第 3 弾。
//   - フィールド: 壁のマーカー 1 枚で壁（Z=0）と床（Y=-floorDrop）の 2 枚の Surface を定義（splatoon-sim.ts）
//   - 操作: グーを握るとチャージ、パーに開くと手からインクが飛ぶ。向きは「目 → 手のひら」の視線
//     （06-2 で 3DoF + 手のブレでは手の速度方向を狙えないと分かったので、07 の指差しと同じ視線方式）
//   - 共有: サーバー権威（server/splatoon.ts）。発射を検証して着弾を決め、塗りの格子と得点を持つ。
//     クライアントは同じ式（simulateInk）で飛行を描き、着弾時刻にその場所へ塗る
//   - 手が取れないときの保険: 画面（PC は Space）を押している間チャージ、離すと視界の中央へ発射

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
const NAME = [...(params.get("name") ?? "").trim()].slice(0, NAME_MAX_LENGTH).join("");
const SEND_INTERVAL_MS = 1000 / numParam("sendHz", 15, { min: 1, max: 60 });
const PEER_STALE_MS = numParam("peerStaleMs", 2000, { min: 200, max: 30000 });
const PEER_SMOOTH = numParam("peerSmooth", 0.3, { min: 0.01, max: 1 });

// フィールド・飛行（room 内で一致が必要。サーバーが検証）
const WALL_W = numParam("wallW", DEFAULT_FIELD.wallW, { min: 0.2, max: 20 });
const WALL_H = numParam("wallH", DEFAULT_FIELD.wallH, { min: 0.2, max: 20 });
const FLOOR_DROP = numParam("floorDrop", DEFAULT_FIELD.floorDrop, { min: 0.1, max: 5 });
const FLOOR_DEPTH = numParam("floorDepth", DEFAULT_FIELD.floorDepth, { min: 0.2, max: 20 });
const GRAVITY = numParam("gravity", DEFAULT_FIELD.gravity, { min: 0, max: 30 });
const MATCH_SEC = numParam("matchSec", DEFAULT_FIELD.matchSec, { min: 10, max: 600 });
/** ペイント層の解像度 [px/m]（07 と同じ理由で控えめ） */
const SURFACE_PX_PER_M = numParam("surfacePx", 384, { min: 64, max: 2048 });
/** 発射後、サーバーの確認が来るまで予測を出す上限 [ms] */
const PREDICT_MAX_MS = 1500;
/** 連射の最小間隔 [ms]（サーバーの上限 4/s より緩く） */
const LOCAL_SHOT_COOLDOWN_MS = 300;

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
let fieldCfg: FieldConfig = {
  ...DEFAULT_FIELD,
  wallW: WALL_W,
  wallH: WALL_H,
  floorDrop: FLOOR_DROP,
  floorDepth: FLOOR_DEPTH,
  gravity: GRAVITY,
  matchSec: MATCH_SEC,
};
const surfaces: SurfaceFrame[] = fieldSurfaces(fieldCfg);
const inkViews = new Map<string, InkView>();
for (const s of surfaces) {
  const view = new InkView(s, SURFACE_PX_PER_M);
  field.add(view.group);
  inkViews.set(s.id, view);
}

// スコアボード: 壁の上。視界内メッセージ: カメラの子
const scorePanel = new TextPanel(1.0, 0.22);
scorePanel.mesh.position.set(0, WALL_H / 2 + 0.16, 0.01);
field.add(scorePanel.mesh);
const message = new TextPanel(0.9, 0.24);
message.mesh.position.set(0, -0.28, -1.2);
camera.add(message.mesh);

// ---- インクの玉（飛行中）----
const inkGeometry = new THREE.SphereGeometry(1, 16, 12);
const inkMaterials: Record<Team, THREE.MeshStandardMaterial> = {
  1: new THREE.MeshStandardMaterial({ color: TEAM_COLORS[1], roughness: 0.4 }),
  2: new THREE.MeshStandardMaterial({ color: TEAM_COLORS[2], roughness: 0.4 }),
};
function createInkMesh(team: Team, radius: number): THREE.Mesh {
  const m = new THREE.Mesh(inkGeometry, inkMaterials[team]);
  m.scale.setScalar(radius * 0.45);
  field.add(m);
  return m;
}

// ---- ピア（他のプレイヤー）: 頭 + 手（06-2 と同じ）。チーム色 ----
type Peer = {
  group: THREE.Group;
  materials: THREE.MeshStandardMaterial[];
  targetPos: THREE.Vector3;
  targetQuat: THREE.Quaternion;
  lastPoseMs: number;
  tracking: boolean;
  charge: number;
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
    charge: 0,
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
  peer.charge = pose.charge ?? 0;
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
    const color = teamColorOf(id);
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
      // チャージ中は白く光らせる
      view.setColor(peer.charge > 0 ? 0xffffff : color);
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
    // チャージ中にフィールドが飛ぶと発射の向きがずれるので lerp だけ
    canSnap: () => charging === null,
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
  // 自分の手はチーム色（チャージ中は白）
  for (const slot of handSlots.slots) {
    if (!slot.view.visible) continue;
    slot.view.setColor(charging?.slot === slot ? 0xffffff : myTeam ? TEAM_COLORS[myTeam] : 0xe8eaed);
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
let myTeam: Team | null = null;
let cameraError = "";
let shotsSent = 0;
let shotsAccepted = 0;
let lastRejectReason = "";
let flash: { text: string; untilMs: number } | null = null;
let lastEventKey = "";

function teamOf(id: string): Team | null {
  return auth?.state.players.find((p) => p.id === id)?.team ?? null;
}
function teamColorOf(id: string): number {
  const t = teamOf(id);
  return t ? TEAM_COLORS[t] : 0xe8eaed;
}

/** 権威時刻 → 受信時刻基準のローカル時刻 [ms] */
function localTimeOf(serverT: number, refServerT: number, refLocalMs: number): number {
  return refLocalMs + (serverT - refServerT);
}

function onState(state: GameSnapshot) {
  const now = performance.now();
  auth = { state, recvMs: now };
  myTeam = teamOf(selfId);
  const ev = state.event;
  const key = ev ? `${state.seq}:${ev.kind}` : "";
  if (key && key !== lastEventKey) {
    lastEventKey = key;
    if (ev?.kind === "start") flash = { text: "スタート！ 塗れ！", untilMs: now + 2500 };
    else if (ev?.kind === "result") {
      const w = ev.winner;
      flash = { text: w === 0 ? "引き分け！" : `${TEAM_NAMES[w]} の勝ち！`, untilMs: now + 4000 };
    }
    console.log(`[game] event ${ev?.kind} phase=${state.phase} scores=${state.scores.join("/")} players=${state.players.length}`);
  }
  if (state.grids) {
    for (const [id, enc] of Object.entries(state.grids)) inkViews.get(id)?.redrawFromGrid(enc, fieldCfg.cellM);
    // 格子で描き直したので、着弾済みの玉の再描画は要らない
    for (const s of state.shots) if (s.landing?.hit) splatted.add(s.seq);
  }
  // 発射一覧の同期（再接続直後の取りこぼし用。既知の seq は無視）
  for (const s of state.shots) {
    if (!shots.has(s.seq)) addShot(s, state.t, now);
  }
}

function connect() {
  if (ROOM === null) return;
  client = connectGame(
    ROOM,
    NAME,
    {
      markerId: MARKER_ID,
      markerMm: MARKER_MM,
      wallW: WALL_W,
      wallH: WALL_H,
      floorDrop: FLOOR_DROP,
      floorDepth: FLOOR_DEPTH,
      gravity: GRAVITY,
      matchSec: MATCH_SEC,
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
      onWelcome: (id, peerIds, cfg, state) => {
        selfId = id;
        netStatus = "open";
        joined = true;
        fieldCfg = cfg;
        [...peers.keys()].forEach(removePeer);
        peerIds.forEach(createPeer);
        clearPredicted();
        lastEventKey = "";
        // 既知の発射は捨てて snapshot から作り直す
        for (const s of shots.values()) s.mesh.removeFromParent();
        shots.clear();
        splatted.clear();
        onState(state);
        console.log(`[game] joined "${ROOM}" as ${id} team=${myTeam} (peers: ${peerIds.join(", ") || "none"})`);
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
  const c = currentCharge(now);
  if (c !== null) pose.charge = Math.round(c * 100) / 100;
  client.sendPose(pose);
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

// ---- チャージ → 発射 ----
// グー（slot.shape === "fist"）になった時刻から数えてチャージ、パー（"open"）に変わった瞬間に発射。
// 手が取れないときは画面 / Space の長押しで同じことを視線（画面中央）で行う
type Charging = { slot: HandSlot | null; sinceMs: number; lastPalm: THREE.Vector3; lostSinceMs: number };
let charging: Charging | null = null;
/** チャージ中に手を見失ってからこの時間 [ms] は待つ（パーに開く動きで一瞬落ちることがある） */
const CHARGE_LOST_GRACE_MS = 400;
/** 見失ったままでもチャージがこれ以上なら「開いて見失った」とみなして発射 */
const CHARGE_FIRE_ON_LOST = 0.3;
let lastShotMs = -Infinity;
let holdPressed = false;
let lastShapeInfo = "";

function currentCharge(now: number): number | null {
  if (!charging) return null;
  return Math.min(1, (now - charging.sinceMs) / (fieldCfg.chargeSec * 1000));
}

function canShoot(): boolean {
  return joined && auth?.state.phase === "play" && anchor.visible && myTeam !== null;
}

const camWorldPos = new THREE.Vector3();
const shotOrigin = new THREE.Vector3();
const shotDir = new THREE.Vector3();

/** 発射: origin（ワールド）から、目（カメラ）→ origin の向きへ */
function fire(originWorld: THREE.Vector3, charge: number, now: number, how: string) {
  if (!client || !canShoot()) return;
  if (now - lastShotMs < LOCAL_SHOT_COOLDOWN_MS) return;
  camera.getWorldPosition(camWorldPos);
  shotDir.subVectors(originWorld, camWorldPos);
  if (shotDir.lengthSq() < 1e-6) shotDir.set(0, 0, -1).applyQuaternion(camera.getWorldQuaternion(tmpQuat));
  shotDir.normalize();
  // ワールド → field 座標系（位置は変換、向きは回転だけ）
  shotOrigin.copy(originWorld);
  field.worldToLocal(shotOrigin);
  field.getWorldQuaternion(tmpQuat).invert();
  shotDir.applyQuaternion(tmpQuat);
  const { speed, radius } = chargeToShot(charge, fieldCfg);
  const pos: V3 = [round3(shotOrigin.x), round3(shotOrigin.y), round3(shotOrigin.z)];
  const vel: V3 = [round3(shotDir.x * speed), round3(shotDir.y * speed), round3(shotDir.z * speed)];
  if (!client.sendShot(pos, vel, radius)) return;
  lastShotMs = now;
  shotsSent++;
  clearPredicted();
  predicted = { pos, vel, radius, sinceMs: now, landing: simulateInk(pos, vel, surfaces, fieldCfg), mesh: null };
  console.log(`[game] shot sent (${how}) charge=${charge.toFixed(2)} speed=${speed.toFixed(2)} r=${radius.toFixed(2)} pos=(${pos.join(",")}) vel=(${vel.join(",")}) land=${predicted.landing?.hit ? `${predicted.landing.surfaceId} ${predicted.landing.uv.map((v) => v.toFixed(2)).join(",")}` : "miss"}`);
}

function updateCharge(now: number) {
  // 1) 手の形。チャージ中の手を見失ったら少し待ち、戻らなければチャージ量に応じて発射か中止
  if (charging?.slot) {
    const slot = charging.slot;
    const visible = slot.view.visible && !!slot.ema;
    if (visible) {
      charging.lostSinceMs = -1;
      charging.lastPalm.copy(slot.contactsWorld[PALM_CONTACT]);
      if (slot.shape === "open") {
        const c = currentCharge(now) ?? 0;
        charging = null;
        fire(slot.contactsWorld[PALM_CONTACT], c, now, "hand");
      }
    } else {
      if (charging.lostSinceMs < 0) charging.lostSinceMs = now;
      if (now - charging.lostSinceMs > CHARGE_LOST_GRACE_MS) {
        const c = currentCharge(now) ?? 0;
        const palm = charging.lastPalm;
        charging = null;
        if (c >= CHARGE_FIRE_ON_LOST) {
          fire(palm, c, now, "hand-lost");
        } else {
          flash = { text: "手を見失いました", untilMs: now + 1200 };
        }
      }
    }
  }
  if (!charging) {
    for (const slot of handSlots.slots) {
      if (slot.view.visible && slot.ema && slot.shape === "fist" && canShoot()) {
        // 発射できる状態になってからのグーだけ数える（マーカー検出前から握っていても満タンにしない）
        charging = { slot, sinceMs: now, lastPalm: slot.contactsWorld[PALM_CONTACT].clone(), lostSinceMs: -1 };
        break;
      }
    }
  }
  // 2) 長押し（視線）。手のチャージ中・発射直後は無視
  if (!charging && holdPressed && canShoot() && now - lastShotMs >= LOCAL_SHOT_COOLDOWN_MS) {
    charging = { slot: null, sinceMs: now, lastPalm: new THREE.Vector3(), lostSinceMs: -1 };
  }
  if (charging && charging.slot === null && !holdPressed) {
    const c = currentCharge(now) ?? 0;
    charging = null;
    // 視界の中央、目の 30cm 先から
    tmpVec2.set(0, 0, -0.3);
    camera.localToWorld(tmpVec2);
    fire(tmpVec2, c, now, "gaze");
  }
  if (charging && !canShoot()) charging = null;
  const shapes = handSlots.slots.filter((s) => s.view.visible).map((s) => s.shape);
  lastShapeInfo = shapes.join(",") || "-";
}

if (touch) {
  const appEl = document.querySelector<HTMLDivElement>("#app")!;
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
  if (charging?.slot === null) charging = null;
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
let predicted: Predicted | null = null;

function clearPredicted() {
  predicted?.mesh?.removeFromParent();
  predicted = null;
}

function addShot(shot: Shot, serverT: number, recvMs: number, launchLocalMs?: number) {
  const mesh = createInkMesh(shot.team, shot.radius);
  shots.set(shot.seq, { shot, launchLocalMs: launchLocalMs ?? localTimeOf(shot.launchedAt, serverT, recvMs), mesh });
}

function placeInk(mesh: THREE.Mesh, pos: V3, vel: V3, elapsed: number, landing: InkLanding | null): boolean {
  const hitT = landing?.hitT ?? fieldCfg.maxFlightSec;
  if (elapsed >= hitT) {
    mesh.visible = false;
    return true;
  }
  const p = inkAt(pos, vel, Math.max(0, elapsed), fieldCfg.gravity);
  mesh.position.set(p[0], p[1], p[2]);
  mesh.visible = true;
  return false;
}

function updateShots(now: number) {
  for (const [seq, live] of shots) {
    const { shot } = live;
    const elapsed = (now - live.launchLocalMs) / 1000;
    const landed = placeInk(live.mesh, shot.pos, shot.vel, elapsed, shot.landing);
    if (landed && shot.landing?.hit && !splatted.has(seq)) {
      splatted.add(seq);
      inkViews.get(shot.landing.surfaceId)?.splat(shot.landing.uv, shot.radius, shot.team);
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
      if (!predicted.mesh) predicted.mesh = createInkMesh(myTeam ?? 1, predicted.radius);
      placeInk(predicted.mesh, predicted.pos, predicted.vel, (now - predicted.sinceMs) / 1000, predicted.landing);
    }
  }
}

// ---- 視界内メッセージとスコアボード ----
function remainingSec(now: number): number {
  if (!auth) return 0;
  return Math.max(0, (auth.state.phaseEndsAt - auth.state.t) / 1000 - (now - auth.recvMs) / 1000);
}

function gauge(c: number): string {
  const n = Math.round(c * 10);
  return "█".repeat(n) + "░".repeat(10 - n);
}

function updateMessages(now: number) {
  const s = auth?.state;
  if (s) {
    const total = Math.max(1, s.totalCells);
    const pa = ((s.scores[0] / total) * 100).toFixed(1);
    const pb = ((s.scores[1] / total) * 100).toFixed(1);
    const left = Math.ceil(remainingSec(now));
    const head = s.phase === "result" ? "結果" : `残り ${left} 秒`;
    scorePanel.set(`${head}\n${TEAM_NAMES[1]} ${pa}%   ${TEAM_NAMES[2]} ${pb}%`, "#e8eaed");
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
    text = "手の検出に失敗しました\n画面を押している間チャージ、離すと発射";
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
    color = "#81c995";
  } else if (auth.state.phase === "result") {
    const w = auth.state.winner ?? 0;
    text = w === 0 ? "引き分け" : `${TEAM_NAMES[w]} の勝ち${w === myTeam ? "！" : ""}`;
    color = w === myTeam ? "#81c995" : "#e8eaed";
  } else if (charging) {
    const c = currentCharge(now) ?? 0;
    text = `チャージ ${gauge(c)}\nパーで発射`;
    color = "#ffffff";
  } else {
    text = `あなたは ${myTeam ? TEAM_NAMES[myTeam] : "-"}\nグーでチャージ → パーで発射`;
    color = myTeam ? `#${TEAM_COLORS[myTeam].toString(16).padStart(6, "0")}` : "#e8eaed";
  }
  message.set(text, color);
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
const hudState = { base: "", sensor: "", cam: "", fsResult: "", fsChange: "" };
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
    `marker=${markerAnchor?.info ?? "-"}${markerAnchor?.everDetected && !markerAnchor.isTracking(now, MARKER_LOST_MS) ? " (holding last pose)" : ""}`,
    `tracker=${trackerStatus}${lastTrackerError ? ` (last error: ${lastTrackerError})` : ""}`,
    (tracker || FAKE_HANDS) &&
      `hands=${lastResultHands} ${handSlots.describe() || "-"} shape=${lastShapeInfo} infer=${(tracker?.lastMs ?? 0).toFixed(0)}ms every ${detIntervalEma.toFixed(0)}ms`,
    `room=${ROOM ?? "(不正)"} me=${selfId || "-"} peers=${peers.size} ws=${netStatus} charge=${currentCharge(now)?.toFixed(2) ?? "-"} held=${holdPressed ? "yes" : "no"}`,
    s &&
      `game: phase=${s.phase} left=${remainingSec(now).toFixed(0)}s team=${myTeam ?? "-"} players=${s.players.map((p) => `${p.id}:${p.team}`).join(",")} scores=${s.scores.join("/")}/${s.totalCells} shots=${shotsSent}/${shotsAccepted} live=${shots.size} seq=${s.seq}${lastRejectReason ? ` lastReject=${lastRejectReason}` : ""}`,
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
const roomError = document.querySelector<HTMLParagraphElement>("#room-error")!;
startButton.addEventListener("click", () => {
  if (ROOM === null) {
    roomError.hidden = false;
    roomError.textContent = `room 名「${roomRaw}」は使えません。日本語・英数字・ハイフン・アンダースコアの1〜32文字にしてください（記号・空白は不可）`;
    return;
  }
  document.body.classList.add("started");
  hudState.base = `fov=${FOV_FIXED ?? "auto"} camZoom=${CAM_ZOOM} markerMm=${MARKER_MM} detW=${MARKER_DET_W}@${MARKER_INTERVAL_MS}ms hands=${NUM_HANDS} delegate=${DELEGATE} handScale=${HAND_SCALE} wall=${WALL_W}x${WALL_H} floor=${FLOOR_DROP}/${FLOOR_DEPTH} gravity=${GRAVITY} matchSec=${MATCH_SEC} mode=${touch ? "gyro" : "orbit"}`;
  connect();
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
  connect();
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
  updateCharge(now);
  updatePeers(now);
  updateShots(now);
  sendPoseIfDue(now);
  updateMessages(now);
  if (document.body.classList.contains("started")) renderHud();
  effect.render(scene, camera);
});
