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
import { FINGER_TIPS, INDEX_TIP } from "../../src/shared/hand-math";
import type { Vec3, ViewMapping } from "../../src/shared/hand-math";
import { HandSlots } from "../../src/shared/hand-slots";
import type { HandResultLike } from "../../src/shared/hand-slots";
import { TextPanel } from "../../src/shared/text-panel";
import { ROOM_ID_PATTERN } from "../../src/shared/shared-room-protocol";
import markerSvgUrl from "../../src/shared/marker-0.svg";
import {
  DEFAULT_SURFACE_H,
  DEFAULT_SURFACE_W,
  SURFACE_SIZE_MAX,
  SURFACE_SIZE_MIN,
  makeSurface,
  raySurfaceHit,
  round4,
  uvDistanceM,
  uvToLocal,
} from "../../src/shared/surface";
import type { SurfaceDef, SurfaceHit, V2 } from "../../src/shared/surface";
import { PAINT_RADIUS_MAX, PAINT_RADIUS_MIN } from "../../src/shared/surface-paint";
import type { PaintStroke } from "../../src/shared/surface-paint";
import { NAME_MAX_LENGTH } from "../../src/shared/surface-protocol";
import type { PlayerInfo, PlayerPose } from "../../src/shared/surface-protocol";
import { connectPaint } from "./paint-client";
import type { PaintClient } from "./paint-client";
import { SurfaceView, playerColorHex } from "./surface-view";
import { scriptedSurfaceHand } from "./fake-surface-hand";

// Phase 7: Surface Mapping。現実の壁を「Surface」として扱い、その上の位置を UV で共有する。
//   - Surface の定義（A 案）: 壁に貼ったマーカー（03/04/06-2）の座標系をそのまま Surface 座標系にする。
//     マーカー中心 = Surface 中心、面 = Z=0、大きさは ?surfaceW= × ?surfaceH= [m]（src/shared/surface.ts）
//   - 操作: 05 の指差し（目 → 人差し指の先の視線）で Surface を指すとカーソル、指差しポーズの間ペイント。
//     手が使えないときの保険として、画面を押している間は視線の先（画面中央）にペイント
//   - 共有: サーバー権威（server/surface.ts）。paint { surfaceId, uv, radius } を検証して全員に配り、
//     入室時に全ストロークの snapshot を渡す。相手の頭とカーソルも表示する
//   - Phase 8（スプラトゥーン）はこの paint に色・チーム・弾の飛翔を足す

// ---- パラメータ（06-2 と同じもの。根拠は 06 の main.ts 参照） ----
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
const NAME = (params.get("name") ?? "").trim().slice(0, NAME_MAX_LENGTH);
const SEND_INTERVAL_MS = 1000 / numParam("sendHz", 15, { min: 1, max: 60 });
const PEER_STALE_MS = numParam("peerStaleMs", 2000, { min: 200, max: 30000 });
const PEER_SMOOTH = numParam("peerSmooth", 0.3, { min: 0.01, max: 1 });

// Surface（room 内で一致が必要。サーバーが検証）
const SURFACE_W = numParam("surfaceW", DEFAULT_SURFACE_W, { min: SURFACE_SIZE_MIN, max: SURFACE_SIZE_MAX });
const SURFACE_H = numParam("surfaceH", DEFAULT_SURFACE_H, { min: SURFACE_SIZE_MIN, max: SURFACE_SIZE_MAX });

// ペイント
/** 1 ストロークの半径 [m] */
const PAINT_RADIUS = numParam("paintRadius", 0.03, { min: PAINT_RADIUS_MIN, max: PAINT_RADIUS_MAX });
/** 送信の上限 [回/秒]（サーバーの上限 30 より下に） */
const PAINT_HZ = numParam("paintHz", 15, { min: 1, max: 30 });
/** 前回の送信位置からこの距離 [m] 未満なら送らない（同じ場所を塗り重ねない） */
const PAINT_MIN_STEP_M = numParam("paintStep", PAINT_RADIUS * 0.4, { min: 0, max: 1 });
/** 視線（画面中央）ペイントを常時 ON（手を使わない確認用）。既定は画面を押している間だけ */
const GAZE_ALWAYS = params.has("gaze");

// デバッグ
const FAKE_CAM = params.has("fakecam");
const FAKE_SHIFT = numParam("fakeShift", 0, { min: -200, max: 200 });
const FAKE_SHIFT_Y = numParam("fakeShiftY", 0, { min: -240, max: 240 });
const FAKE_MARKER_PX = numParam("fakeMarkerPx", 80, { min: 30, max: 400 });
const FAKE_HANDS = params.has("fakehands");
/** 合成の手が Surface 上に描く円の半径（UV）と周期 [s] */
const FAKE_UV_R = numParam("fakeUvR", 0.3, { min: 0, max: 0.5 });
const FAKE_PERIOD_SEC = numParam("fakePeriodSec", 6, { min: 1, max: 60 });

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

// ---- アンカー（マーカー座標系 = Surface 座標系）。壁のマーカーなので回さない ----
const anchor = new THREE.Group();
anchor.visible = false;
scene.add(anchor);

const markerFrameMaterial = new THREE.MeshBasicMaterial({
  color: 0x8ab4f8,
  transparent: true,
  opacity: 0.4,
  side: THREE.DoubleSide,
});
anchor.add(new THREE.Mesh(new THREE.PlaneGeometry(MARKER_SIZE_M, MARKER_SIZE_M), markerFrameMaterial));

// ---- Surface（このデモは 1 枚。id は surface.ts の規約でマーカーから決まる） ----
const surfaceDef: SurfaceDef = makeSurface(MARKER_ID, SURFACE_W, SURFACE_H);
const surfaces = new Map<string, SurfaceView>();
function getSurfaceView(id: string): SurfaceView | undefined {
  return surfaces.get(id);
}
{
  const view = new SurfaceView(surfaceDef);
  anchor.add(view.group);
  surfaces.set(surfaceDef.id, view);
}

// Surface の名札（上）と視界内メッセージ（カメラの子）
const label = new TextPanel(0.6, 0.12, 512);
label.mesh.position.set(0, SURFACE_H / 2 + 0.09, 0.01);
anchor.add(label.mesh);
const message = new TextPanel(0.9, 0.24);
message.mesh.position.set(0, -0.28, -1.2);
camera.add(message.mesh);

// ---- カーソル（自分 + ピア）。Surface 座標系に置くので anchor の子 ----
const cursorGeometry = new THREE.RingGeometry(0.8, 1, 32);
function createCursor(hex: number): THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial> {
  const mesh = new THREE.Mesh(
    cursorGeometry,
    new THREE.MeshBasicMaterial({ color: hex, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthTest: false }),
  );
  mesh.renderOrder = 10;
  mesh.position.z = 0.006;
  mesh.visible = false;
  anchor.add(mesh);
  return mesh;
}
const myCursor = createCursor(0xe8eaed);
function placeCursor(mesh: THREE.Mesh, uv: V2, surface: SurfaceDef, radius: number) {
  const [x, y] = uvToLocal(surface, uv);
  mesh.position.set(x, y, 0.006);
  mesh.scale.setScalar(radius);
  mesh.visible = true;
}

// ---- ピア（他のプレイヤー）: 頭のアバター + カーソル ----
type Peer = {
  info: PlayerInfo;
  group: THREE.Group;
  materials: THREE.MeshStandardMaterial[];
  cursor: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  targetPos: THREE.Vector3;
  targetQuat: THREE.Quaternion;
  lastPoseMs: number;
  tracking: boolean;
};
const peers = new Map<string, Peer>();
const peerHeadGeometry = new THREE.SphereGeometry(0.09, 24, 16);
const peerNoseGeometry = new THREE.ConeGeometry(0.035, 0.09, 16);

function createPeer(info: PlayerInfo): Peer {
  removePeer(info.id);
  const hex = playerColorHex(info.color);
  const group = new THREE.Group();
  const headMat = new THREE.MeshStandardMaterial({ color: hex, transparent: true });
  const noseMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, transparent: true });
  group.add(new THREE.Mesh(peerHeadGeometry, headMat));
  const nose = new THREE.Mesh(peerNoseGeometry, noseMat);
  nose.rotation.x = -Math.PI / 2;
  nose.position.z = -0.1;
  group.add(nose);
  group.visible = false;
  anchor.add(group);
  const peer: Peer = {
    info,
    group,
    materials: [headMat, noseMat],
    cursor: createCursor(hex),
    targetPos: new THREE.Vector3(),
    targetQuat: new THREE.Quaternion(),
    lastPoseMs: -Infinity,
    tracking: false,
  };
  peers.set(info.id, peer);
  return peer;
}

function removePeer(id: string) {
  const peer = peers.get(id);
  if (!peer) return;
  peer.group.removeFromParent();
  peer.materials.forEach((m) => m.dispose());
  peer.cursor.removeFromParent();
  peer.cursor.material.dispose();
  peers.delete(id);
}

function onPeerPose(id: string, pose: PlayerPose) {
  const peer = peers.get(id);
  if (!peer) return;
  peer.targetPos.set(...pose.pos);
  peer.targetQuat.set(...pose.quat);
  peer.tracking = pose.tracking;
  const now = performance.now();
  if (now - peer.lastPoseMs > PEER_STALE_MS) {
    peer.group.position.copy(peer.targetPos);
    peer.group.quaternion.copy(peer.targetQuat);
  }
  peer.lastPoseMs = now;
  const view = pose.cursor ? getSurfaceView(pose.cursor.surfaceId) : undefined;
  if (view && pose.cursor) placeCursor(peer.cursor, pose.cursor.uv, view.def, PAINT_RADIUS);
  else peer.cursor.visible = false;
}

let lastPeerUpdateMs = performance.now();
function updatePeers(now: number) {
  const dtFrames = Math.min((now - lastPeerUpdateMs) / (1000 / 60), 4);
  lastPeerUpdateMs = now;
  const alpha = 1 - Math.pow(1 - PEER_SMOOTH, dtFrames);
  for (const peer of peers.values()) {
    if (peer.lastPoseMs === -Infinity) continue;
    const stale = now - peer.lastPoseMs > PEER_STALE_MS;
    peer.group.visible = !stale;
    if (stale) {
      peer.cursor.visible = false;
      continue;
    }
    peer.group.position.lerp(peer.targetPos, alpha);
    peer.group.quaternion.slerp(peer.targetQuat, alpha);
    const opacity = peer.tracking ? 1 : 0.3;
    for (const m of peer.materials) m.opacity = opacity;
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
const INDEX_CONTACT = FINGER_TIPS.indexOf(INDEX_TIP);

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

// ---- パススルー（PC デバッグ用フェイクカメラは 06-2 と同じ描き方） ----
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
let fakeStartMs = -1;

/** 合成の手が指す点（カメラ座標系）: Surface の UV で円を描く */
function fakeTargetCam(tSec: number): Vec3 | null {
  if (!anchor.visible) return null;
  const a = (tSec / FAKE_PERIOD_SEC) * Math.PI * 2;
  const uv: V2 = [0.5 + FAKE_UV_R * Math.cos(a), 0.5 + FAKE_UV_R * Math.sin(a)];
  const [x, y] = uvToLocal(surfaceDef, uv);
  tmpVec.set(x, y, 0);
  anchor.localToWorld(tmpVec);
  camera.worldToLocal(tmpVec);
  return { x: tmpVec.x, y: tmpVec.y, z: tmpVec.z };
}

function updateFakeHands(now: number) {
  if (now - lastDetectAt < 33 || !passthrough) return;
  const mapping = passthrough.displayViewMapping(camera.fov);
  if (fakeStartMs < 0) fakeStartMs = now;
  lastDetectAt = now;
  const tSec = (now - fakeStartMs) / 1000;
  applyHandResult(scriptedSurfaceHand(fakeTargetCam(tSec), tSec, mapping), now);
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

// ---- 通信（サーバー権威のペイント） ----
let selfId = "";
let netStatus = "idle";
let client: PaintClient | null = null;
let joined = false;
const players = new Map<string, PlayerInfo>();
let cameraError = "";
let paintsSent = 0;
let paintsAcked = 0;
let strokesSeen = 0;
let lastClearBy = "";
let flash: { text: string; untilMs: number } | null = null;

function playerName(id: string): string {
  if (id === "server") return "サーバー（上限到達）";
  const base = players.get(id)?.name ?? id;
  return id === selfId ? `${base}（あなた）` : base;
}

function onPaint(stroke: PaintStroke) {
  strokesSeen++;
  if (stroke.by === selfId) paintsAcked++;
  getSurfaceView(stroke.surfaceId)?.draw(stroke);
}

function connect() {
  if (ROOM === null) return;
  client = connectPaint(
    ROOM,
    NAME,
    { markerId: MARKER_ID, markerMm: MARKER_MM, surfaceW: SURFACE_W, surfaceH: SURFACE_H },
    {
      onStatus: (status) => {
        netStatus = status;
        // 切断中は送らない（welcome で再び true）。送ってもクライアントが黙って捨てるだけだが HUD の sent が狂う
        if (status !== "open") joined = false;
      },
      onError: (reason) => {
        netStatus = `error: ${reason}`;
        console.warn(`[paint] rejected: ${reason}`);
      },
      onWelcome: (id, list, snapshot) => {
        selfId = id;
        netStatus = "open";
        joined = true;
        [...peers.keys()].forEach(removePeer);
        players.clear();
        for (const p of list) {
          players.set(p.id, p);
          if (p.id !== id) createPeer(p);
        }
        const me = players.get(id);
        if (me) myCursor.material.color.setHex(playerColorHex(me.color));
        // snapshot で全 Surface を置き換える（再接続でも取りこぼしが無い）
        for (const view of surfaces.values()) view.replace(snapshot.strokes);
        strokesSeen = snapshot.strokes.length;
        // サーバー側の Surface 定義が自分と違ったら（あり得ないが）ログに出す
        for (const s of snapshot.surfaces) {
          const mine = surfaces.get(s.id);
          if (!mine || mine.def.widthM !== s.widthM || mine.def.heightM !== s.heightM) {
            console.warn(`[paint] surface ${s.id} differs: server=${s.widthM}x${s.heightM}`);
          }
        }
        console.log(`[paint] joined "${ROOM}" as ${id} (players: ${list.map((p) => p.id).join(", ")}, strokes: ${snapshot.strokes.length})`);
      },
      onPeerJoin: (p) => {
        players.set(p.id, p);
        createPeer(p);
        console.log(`[paint] peer ${p.id} joined`);
      },
      onPeerLeave: (id) => {
        players.delete(id);
        removePeer(id);
        console.log(`[paint] peer ${id} left`);
      },
      onPeerPose,
      onPaint,
      onClear: (by) => {
        for (const view of surfaces.values()) view.clear();
        lastClearBy = by;
        flash = { text: `${playerName(by)} が全消去`, untilMs: performance.now() + 2000 };
        console.log(`[paint] cleared by ${by}`);
      },
    },
  );
}

// 自分の姿勢（Surface 座標系）+ カーソルを送る
const anchorInv = new THREE.Matrix4();
const poseMatrix = new THREE.Matrix4();
const posePos = new THREE.Vector3();
const poseQuat = new THREE.Quaternion();
const poseScale = new THREE.Vector3();
let lastSendMs = -Infinity;

function sendPoseIfDue(now: number) {
  if (!client || !markerAnchor?.everDetected) return;
  if (now - lastSendMs < SEND_INTERVAL_MS) return;
  lastSendMs = now;
  anchorInv.copy(anchor.matrixWorld).invert();
  poseMatrix.multiplyMatrices(anchorInv, camera.matrixWorld);
  poseMatrix.decompose(posePos, poseQuat, poseScale);
  const pose: PlayerPose = {
    pos: [round3(posePos.x), round3(posePos.y), round3(posePos.z)],
    quat: [poseQuat.x, poseQuat.y, poseQuat.z, poseQuat.w],
    tracking: markerAnchor.isTracking(now, MARKER_LOST_MS),
  };
  if (currentHit?.inside) {
    pose.cursor = { surfaceId: surfaceDef.id, uv: [round4(currentHit.uv[0]), round4(currentHit.uv[1])] };
  }
  client.sendPose(pose);
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

// ---- 指差し → Surface の交点 → ペイント ----
// 視線は 05 と同じ「カメラ（≒目）→ 人差し指の先」。指の向きより安定で「指先で隠した場所」を指す
const camWorldPos = new THREE.Vector3();
const rayOrigin = new THREE.Vector3();
const rayDir = new THREE.Vector3();
const anchorQuatInv = new THREE.Quaternion();
/** いま指している場所（Surface 座標系）。無ければ null */
let currentHit: SurfaceHit | null = null;
/** 指差しで指しているか（false なら視線ペイント） */
let hitByHand = false;
let paintHeld = false;
let lastPaintMs = -Infinity;
let lastPaintUv: V2 | null = null;
let pointingNow = false;

/** origin / dir（ワールド）を Surface 座標系に直して交点を求める */
function hitSurface(originWorld: THREE.Vector3, throughWorld: THREE.Vector3): SurfaceHit | null {
  rayOrigin.copy(originWorld);
  anchor.worldToLocal(rayOrigin);
  rayDir.subVectors(throughWorld, originWorld).normalize();
  anchor.getWorldQuaternion(anchorQuatInv).invert();
  rayDir.applyQuaternion(anchorQuatInv);
  return raySurfaceHit(surfaceDef, [rayOrigin.x, rayOrigin.y, rayOrigin.z], [rayDir.x, rayDir.y, rayDir.z]);
}

function updatePointing(now: number) {
  currentHit = null;
  hitByHand = false;
  pointingNow = false;
  if (!anchor.visible) {
    myCursor.visible = false;
    return;
  }
  camera.getWorldPosition(camWorldPos);
  // 1) 指差し（見えている手のうち指差しポーズのもの。先に見つかった 1 本）
  for (const slot of handSlots.slots) {
    if (!slot.view.visible || !slot.pointing || !slot.ema) continue;
    pointingNow = true;
    const hit = hitSurface(camWorldPos, slot.contactsWorld[INDEX_CONTACT]);
    if (hit) {
      currentHit = hit;
      hitByHand = true;
      break;
    }
  }
  // 2) 視線（画面中央）。画面を押している間、または ?gaze=1 で常時
  const gazeWanted = paintHeld || GAZE_ALWAYS;
  if (!currentHit && gazeWanted) {
    tmpVec2.set(0, 0, -1);
    camera.localToWorld(tmpVec2);
    currentHit = hitSurface(camWorldPos, tmpVec2);
  }
  if (currentHit) placeCursor(myCursor, currentHit.uv, surfaceDef, PAINT_RADIUS);
  else myCursor.visible = false;

  // ペイント: 指差し中 or 押している間、矩形の中にいれば間引いて送る
  const painting = currentHit?.inside && (hitByHand || gazeWanted);
  if (!painting || !client || !joined) {
    if (!painting) lastPaintUv = null;
    return;
  }
  const uv = currentHit!.uv;
  if (now - lastPaintMs < 1000 / PAINT_HZ) return;
  if (lastPaintUv && uvDistanceM(surfaceDef, lastPaintUv, uv) < PAINT_MIN_STEP_M) return;
  lastPaintMs = now;
  lastPaintUv = [uv[0], uv[1]];
  paintsSent++;
  client.sendPaint(surfaceDef.id, [round4(uv[0]), round4(uv[1])], PAINT_RADIUS);
}

// 画面を押している間 = 視線ペイント（ゴーグル無しの手持ち確認・手が取れないときの保険）
const appEl = document.querySelector<HTMLDivElement>("#app")!;
appEl.addEventListener("pointerdown", () => {
  if (document.body.classList.contains("started")) paintHeld = true;
});
addEventListener("pointerup", () => {
  paintHeld = false;
});
addEventListener("pointercancel", () => {
  paintHeld = false;
});

// ---- 視界内メッセージと名札 ----
function updateMessages(now: number) {
  label.set(`${surfaceDef.id}  ${SURFACE_W}m × ${SURFACE_H}m`, "#e8eaed");
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
    text = "手の検出に失敗しました\n画面を押している間は視線の先に描けます";
    color = "#f28b82";
  } else if (!FAKE_HANDS && !tracker) {
    text = "手の検出を読み込み中…";
    color = "#fdd663";
  } else if (netStatus !== "open" && selfId !== "") {
    // 一度入室した後の切断（再接続中）。joined は切断で false になるので先に判定する
    text = "接続が切れました（再接続中）";
    color = "#f28b82";
  } else if (!joined) {
    text = netStatus === "open" ? "入室中…" : `サーバーに接続中… (${netStatus})`;
    color = "#fdd663";
  } else if (flash && now < flash.untilMs) {
    text = flash.text;
    color = "#81c995";
  } else if (currentHit?.inside) {
    text = `UV (${currentHit.uv[0].toFixed(2)}, ${currentHit.uv[1].toFixed(2)})`;
    color = "#81c995";
  } else if (pointingNow) {
    text = "Surface の外を指しています";
    color = "#fdd663";
  } else {
    text = `人差し指で壁を指すと描けます\n（${players.size} 人が参加中）`;
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
const hudState = { base: "", sensor: "", cam: "", fsResult: "", fsChange: "" };
let lastHudText = "";
function renderHud() {
  const view = surfaces.get(surfaceDef.id)!;
  const text = [
    `${hudState.base} (fov now=${camera.fov.toFixed(1)})`,
    hudState.sensor && `sensor=${hudState.sensor}`,
    hudState.cam && `cam=${hudState.cam}`,
    hudState.fsResult && `fs=${hudState.fsResult}`,
    hudState.fsChange && `fs-change: ${hudState.fsChange}`,
    `marker=${markerAnchor?.info ?? "-"}${markerAnchor?.everDetected && !markerAnchor.isTracking(performance.now(), MARKER_LOST_MS) ? " (holding last pose)" : ""}`,
    `tracker=${trackerStatus}${lastTrackerError ? ` (last error: ${lastTrackerError})` : ""}`,
    (tracker || FAKE_HANDS) &&
      `hands=${lastResultHands} ${handSlots.describe() || "-"} infer=${(tracker?.lastMs ?? 0).toFixed(0)}ms every ${detIntervalEma.toFixed(0)}ms`,
    `room=${ROOM ?? "(不正)"} me=${selfId || "-"} players=${[...players.values()].map((p) => `${p.id}:c${p.color}`).join(",") || "-"} ws=${netStatus}`,
    `surface=${surfaceDef.id} ${SURFACE_W}x${SURFACE_H} hit=${currentHit ? `${currentHit.uv[0].toFixed(3)},${currentHit.uv[1].toFixed(3)}${currentHit.inside ? "" : " (out)"} ${hitByHand ? "hand" : "gaze"}` : "-"} pointing=${pointingNow ? "yes" : "no"} held=${paintHeld ? "yes" : "no"}`,
    `paint: strokes=${view.strokeCount} seen=${strokesSeen} sent=${paintsSent} acked=${paintsAcked} lastSeq=${view.lastSeq}${lastClearBy ? ` clearedBy=${lastClearBy}` : ""}`,
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

const clearButton = document.querySelector<HTMLButtonElement>("#clear-button")!;
clearButton.addEventListener("click", (e) => {
  e.stopPropagation();
  client?.sendClear();
});
addEventListener("keydown", (e) => {
  if (e.key === "c" && !e.repeat) client?.sendClear();
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
  hudState.base = `fov=${FOV_FIXED ?? "auto"} camZoom=${CAM_ZOOM} markerMm=${MARKER_MM} detW=${MARKER_DET_W}@${MARKER_INTERVAL_MS}ms hands=${NUM_HANDS} delegate=${DELEGATE} handScale=${HAND_SCALE} surface=${SURFACE_W}x${SURFACE_H} paintRadius=${PAINT_RADIUS} paintHz=${PAINT_HZ} mode=${touch ? "gyro" : "orbit"}`;
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
  for (const view of surfaces.values()) view.setFrameColor(tracking ? 0x8ab4f8 : 0xf28b82);
  anchor.updateMatrixWorld(true);
  updateHands(now);
  updatePointing(now);
  updatePeers(now);
  sendPoseIfDue(now);
  updateMessages(now);
  if (document.body.classList.contains("started")) renderHud();
  effect.render(scene, camera);
});
