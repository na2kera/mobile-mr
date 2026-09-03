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
import { createPoseTracker } from "../../src/shared/pose-tracker";
import type { PoseTracker } from "../../src/shared/pose-tracker";
import { SkeletonView } from "../../src/shared/skeleton-view";
import { TextPanel } from "../../src/shared/text-panel";
import type { ViewMapping } from "../../src/shared/hand-math";
import { BODY_CONNECTIONS, BODY_LANDMARK_COUNT, buildPersonDetection } from "../../src/shared/body-math";
import type { BodyLandmark } from "../../src/shared/body-math";
import { PersonTracks } from "../../src/shared/person-match";
import type { MatchCandidate, PersonDetection } from "../../src/shared/person-match";
import { eyesAboveHip, fakePoseResult, syntheticBodyShape } from "../../src/shared/fake-body";
import type { FakeBody } from "../../src/shared/fake-body";
import { ROOM_ID_PATTERN } from "../../src/shared/shared-room-protocol";
import { NAME_MAX_LENGTH, playerColorHex, playerColorName } from "../../src/shared/person-protocol";
import type { PersonPose, PlayerInfo, Sighting } from "../../src/shared/person-protocol";
import { connectPerson } from "./person-client";
import type { PersonClient } from "./person-client";
import markerSvgUrl from "../../src/shared/marker-0.svg";

// Phase 9: 現実の人物と Player ID の対応。
//   - 検出: 背面カメラの映像を MediaPipe PoseLandmarker（全身 33 点）に通す（src/shared/pose-tracker.ts）
//   - 3D 化: 05 の手と同じ「worldLandmarks の実寸の形を画像上の見え方に当てはめる最小二乗」で
//     カメラからの位置を解き、骨格を背景の人に重ねる（src/shared/body-math.ts）
//   - 対応づけ: ピアが送ってくる頭の姿勢（04 と同じマーカー座標系）を自分のカメラ座標系に直し、
//     検出した頭との「視線方向のずれ」と「距離のずれ」の両方が許容内の組を 1 対 1 で採用。
//     3 回連続で同じ相手が最良なら名札を切り替え、対応が取れなくなっても 1.5s は保持（src/shared/person-match.ts）
//   - 共有: Player 一覧（名前・色）と pose の中継はサーバー（server/person.ts）。pose には
//     「誰をどこで見たか（seen）」も載せ、相手の端末に「あなたから見えています（ずれ 0.2m）」と出す
//   - 自分の体はゴーグル装着時に映らないので、検出対象は常に「相手」

// ---- パラメータ（06〜08 と同じもの。根拠は 06 の main.ts 参照） ----
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

// 人物検出
const POSES = Math.round(numParam("poses", 2, { min: 1, max: 4 }));
const delegateRaw = (params.get("delegate") ?? "auto").toLowerCase();
const DELEGATE = delegateRaw === "gpu" ? "GPU" : delegateRaw === "cpu" ? "CPU" : "auto";
/** 推論に渡す長辺 [px]。全身は画面の大部分を占めるので 640 で十分（0 でフル解像度） */
const BODY_DET_W = numParam("bodyDetW", 640, { min: 0, max: 4096 });
const BODY_SMOOTH = numParam("bodySmooth", 0.5, { min: 0.05, max: 1 });
const BODY_LOST_MS = numParam("bodyLostMs", 500, { min: 50, max: 5000 });
/** worldLandmarks の実寸補正（05 の handScale と同じ役割。実機で決める） */
const BODY_SCALE = numParam("bodyScale", 1, { min: 0.2, max: 5 });
/** これ未満の visibility の点は 3D 化の最小二乗に使わない */
const MIN_VIS = numParam("minVis", 0.5, { min: 0, max: 1 });
const MAX_BODY_DEPTH_M = numParam("maxBodyDepth", 8, { min: 0.5, max: 50 });
/** 追跡の継続判定: 頭の位置がこの距離 [m] 以内なら同じ人 */
const TRACK_DIST_M = numParam("trackDist", 0.5, { min: 0.05, max: 5 });

// 対応づけ
const MATCH_ANGLE_DEG = numParam("matchAngle", 12, { min: 1, max: 90 });
const MATCH_DEPTH_M = numParam("matchDepth", 1.0, { min: 0.05, max: 10 });
const ID_HOLD_MS = numParam("idHoldMs", 1500, { min: 0, max: 30000 });
const ID_STREAK = Math.round(numParam("idStreak", 3, { min: 1, max: 30 }));
/**
 * マーカーを見失っている間（3DoF: 位置は最後にマーカーを見た所で凍結）の扱い。
 * 既定（0）は 06〜08 と同じく凍結した位置を使い続ける: 相手を見るとマーカーは視界から外れるのが普通で、
 * その場で回るだけなら凍結した位置は正しい。歩くとずれるが、ずれは角度のゲートで「？」になるだけで別人には付きにくい。
 * 1 にすると、自分がロスト中は seen を送らず、ロスト中の相手は対応の候補にせず、相手のロスト中の seen も捨てる（厳密だが名札が付く機会は減る）
 */
const STRICT_TRACKING = params.get("strictTracking") === "1";

const OFFICIAL_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";
const MODEL_URLS = params.get("model")
  ? [params.get("model")!]
  : [`${import.meta.env.BASE_URL}models/pose_landmarker_lite.task`, OFFICIAL_MODEL_URL];

// Room / 通信
const roomRaw = params.get("room");
const ROOM = roomRaw === null ? "demo" : ROOM_ID_PATTERN.test(roomRaw) ? roomRaw : null;
const SEND_INTERVAL_MS = 1000 / numParam("sendHz", 15, { min: 1, max: 60 });
const PEER_STALE_MS = numParam("peerStaleMs", 2000, { min: 200, max: 30000 });
const PEER_SMOOTH = numParam("peerSmooth", 0.3, { min: 0.01, max: 1 });
/** 「あなたから見えています」を出し続ける時間 [ms]（seen が来なくなってから） */
const SEEN_STALE_MS = 2000;

// デバッグ
const FAKE_CAM = params.has("fakecam");
const FAKE_SHIFT = numParam("fakeShift", 0, { min: -200, max: 200 });
const FAKE_SHIFT_Y = numParam("fakeShiftY", 0, { min: -240, max: 240 });
const FAKE_MARKER_PX = numParam("fakeMarkerPx", 80, { min: 30, max: 400 });
const FAKE_BODY = params.has("fakebody");
/** 合成の人をピアの頭からこれだけ横にずらして置く [m]（対応づけの許容の確認用） */
const FAKE_BODY_ERR = numParam("fakeBodyErr", 0.15, { min: 0, max: 5 });
/** 相手が居ないときの合成の人までの距離 [m] */
const FAKE_BODY_DEPTH = numParam("fakeBodyDepth", 2.5, { min: 0.3, max: 20 });
/** 合成の人をもう 1 人、1.5m 横に置く（対応が付かない「？」の確認用。fakebody=1 のとき既定 on） */
const FAKE_DECOY = params.get("fakeDecoy") !== "0";

/** タッチ端末（実機）か。PC は OrbitControls */
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

// ---- アンカー（マーカー座標系 = 共通座標系）。06〜08 と同じくロスト中は最後の姿勢を維持 ----
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
anchor.add(new THREE.AxesHelper(MARKER_SIZE_M));

// 視界内メッセージ: カメラの子。相手の体（視界の中央〜下）に被らないよう視界の下端寄りに置く
const message = new TextPanel(0.9, 0.26);
message.mesh.position.set(0, -0.52, -1.2);
camera.add(message.mesh);

// ---- ピア（ネットワーク上の Player）: 頭 + 視線のコーン（04 と同じ）+ 名札 ----
type Peer = {
  info: PlayerInfo;
  group: THREE.Group;
  materials: THREE.MeshStandardMaterial[];
  label: TextPanel;
  targetPos: THREE.Vector3;
  targetQuat: THREE.Quaternion;
  lastPoseMs: number;
  tracking: boolean;
  /** この相手が「自分」を見た位置（マーカー座標系）。無ければ null */
  seesMe: THREE.Vector3 | null;
  seesMeMs: number;
  /** 相手が見た自分の位置と、自分の申告位置の距離 [m] */
  seesMeDist: number;
  /** 相手がそれを見たとき、相手側でマーカーが追従していたか（false なら相手の位置が古い可能性） */
  seesMeTracking: boolean;
};
const peers = new Map<string, Peer>();
const peerHeadGeometry = new THREE.SphereGeometry(0.09, 24, 16);
const peerNoseGeometry = new THREE.ConeGeometry(0.035, 0.09, 16);

function createPeer(info: PlayerInfo): Peer {
  removePeer(info.id);
  const color = playerColorHex(info.color);
  const group = new THREE.Group();
  const headMat = new THREE.MeshStandardMaterial({ color, transparent: true, opacity: 0.5 });
  const noseMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, transparent: true, opacity: 0.5 });
  group.add(new THREE.Mesh(peerHeadGeometry, headMat));
  const nose = new THREE.Mesh(peerNoseGeometry, noseMat);
  nose.rotation.x = -Math.PI / 2;
  nose.position.z = -0.1;
  group.add(nose);
  group.visible = false;
  field.add(group);
  // 名札はワールドに置いて常にカメラへ向ける（group はピアの向きで回るので子にしない）
  const label = new TextPanel(0.4, 0.1, 384);
  scene.add(label.mesh);
  const peer: Peer = {
    info,
    group,
    materials: [headMat, noseMat],
    label,
    targetPos: new THREE.Vector3(),
    targetQuat: new THREE.Quaternion(),
    lastPoseMs: -Infinity,
    tracking: false,
    seesMe: null,
    seesMeMs: -Infinity,
    seesMeDist: 0,
    seesMeTracking: true,
  };
  peers.set(info.id, peer);
  return peer;
}

function removePeer(id: string) {
  const peer = peers.get(id);
  if (!peer) return;
  peer.group.removeFromParent();
  peer.materials.forEach((m) => m.dispose());
  peer.label.mesh.removeFromParent();
  peer.label.mesh.material.map?.dispose();
  peer.label.mesh.material.dispose();
  peer.label.mesh.geometry.dispose();
  peers.delete(id);
}

const fieldInv = new THREE.Matrix4();
const poseMatrix = new THREE.Matrix4();
const posePos = new THREE.Vector3();
const poseQuat = new THREE.Quaternion();
const poseScale = new THREE.Vector3();
const tmpVec = new THREE.Vector3();
const tmpVec2 = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();

/** 自分のカメラ姿勢をマーカー座標系で（posePos / poseQuat に入る） */
function computeMyPose() {
  fieldInv.copy(field.matrixWorld).invert();
  poseMatrix.multiplyMatrices(fieldInv, camera.matrixWorld);
  poseMatrix.decompose(posePos, poseQuat, poseScale);
}

function onPeerPose(id: string, pose: PersonPose) {
  const peer = peers.get(id);
  if (!peer) return; // join より先に pose が来ることは無い想定（来ても welcome の再送で揃う）
  peer.targetPos.set(...pose.pos);
  peer.targetQuat.set(...pose.quat);
  peer.tracking = pose.tracking;
  const now = performance.now();
  if (now - peer.lastPoseMs > PEER_STALE_MS) {
    peer.group.position.copy(peer.targetPos);
    peer.group.quaternion.copy(peer.targetQuat);
  }
  peer.lastPoseMs = now;
  // 相手が自分を見ていたら、相手の推定と自分の申告位置のずれを測る。
  // 相手がマーカーロスト中（tracking=false）の seen は位置が古い可能性があるので、厳密モードでは捨てる
  const me = pose.seen?.find((s) => s.id === selfId);
  if (me && markerAnchor?.everDetected && (pose.tracking || !STRICT_TRACKING)) {
    peer.seesMe = (peer.seesMe ?? new THREE.Vector3()).set(...me.pos);
    peer.seesMeMs = now;
    peer.seesMeTracking = pose.tracking;
    computeMyPose();
    peer.seesMeDist = peer.seesMe.distanceTo(posePos);
  } else if (STRICT_TRACKING && !pose.tracking) {
    peer.seesMeMs = -Infinity;
  }
}

/** いま骨格に名札が付いているピア（アバター側の名札は消して二重表示を避ける） */
const matchedPeers = new Set<string>();

let lastPeerUpdateMs = performance.now();
function updatePeers(now: number) {
  const dtFrames = Math.min((now - lastPeerUpdateMs) / (1000 / 60), 4);
  lastPeerUpdateMs = now;
  const alpha = 1 - Math.pow(1 - PEER_SMOOTH, dtFrames);
  camera.getWorldQuaternion(tmpQuat);
  for (const peer of peers.values()) {
    if (peer.lastPoseMs === -Infinity) continue;
    const stale = now - peer.lastPoseMs > PEER_STALE_MS;
    peer.group.visible = !stale && anchor.visible;
    if (!peer.group.visible) {
      peer.label.set("");
      continue;
    }
    peer.group.position.lerp(peer.targetPos, alpha);
    peer.group.quaternion.slerp(peer.targetQuat, alpha);
    const opacity = peer.tracking ? 0.5 : 0.2;
    for (const m of peer.materials) m.opacity = opacity;
    peer.group.getWorldPosition(tmpVec);
    peer.label.mesh.position.set(tmpVec.x, tmpVec.y + 0.16, tmpVec.z);
    peer.label.mesh.quaternion.copy(tmpQuat);
    peer.label.set(matchedPeers.has(peer.info.id) ? "" : `${peer.info.name}（${peer.info.id}）`, cssColor(playerColorHex(peer.info.color)));
  }
}

/** 対応づけの候補: いま表示しているピアの頭を自分のカメラ座標系で（厳密モードではマーカーロスト中の相手を除く） */
function peerCandidates(now: number): MatchCandidate[] {
  const out: MatchCandidate[] = [];
  for (const [id, peer] of peers) {
    if (peer.lastPoseMs === -Infinity || now - peer.lastPoseMs > PEER_STALE_MS || !anchor.visible) continue;
    if (STRICT_TRACKING && !peer.tracking) continue;
    peer.group.getWorldPosition(tmpVec);
    camera.worldToLocal(tmpVec);
    out.push({ id, pos: { x: tmpVec.x, y: tmpVec.y, z: tmpVec.z } });
  }
  return out;
}

// ---- 検出した人（追跡 + 骨格 + 名札 + アバターとのずれの線） ----
const tracks = new PersonTracks({
  maxTracks: POSES,
  smooth: BODY_SMOOTH,
  lostMs: BODY_LOST_MS,
  trackDistM: TRACK_DIST_M,
  idHoldMs: ID_HOLD_MS,
  idStreak: ID_STREAK,
});
const matchOpts = { angleTolRad: THREE.MathUtils.degToRad(MATCH_ANGLE_DEG), depthTolM: MATCH_DEPTH_M };
const UNKNOWN_COLOR = 0x9aa0a6;

type TrackView = {
  key: number | null;
  view: SkeletonView;
  label: TextPanel;
  link: THREE.Line;
  linkPositions: Float32Array;
};
const trackViews: TrackView[] = [];
for (let i = 0; i < POSES; i++) {
  const view = new SkeletonView(BODY_LANDMARK_COUNT, BODY_CONNECTIONS, UNKNOWN_COLOR, 0.015);
  camera.add(view.group);
  const label = new TextPanel(0.5, 0.12, 384);
  camera.add(label.mesh);
  const linkPositions = new Float32Array(6);
  const linkGeometry = new THREE.BufferGeometry();
  linkGeometry.setAttribute("position", new THREE.BufferAttribute(linkPositions, 3));
  const link = new THREE.Line(
    linkGeometry,
    new THREE.LineBasicMaterial({ color: UNKNOWN_COLOR, transparent: true, opacity: 0.8, depthTest: false }),
  );
  link.renderOrder = 10;
  link.frustumCulled = false;
  link.visible = false;
  scene.add(link);
  trackViews.push({ key: null, view, label, link, linkPositions });
}

function cssColor(hex: number): string {
  return `#${hex.toString(16).padStart(6, "0")}`;
}

function syncTrackViews(now: number) {
  const live = tracks.live(now);
  matchedPeers.clear();
  for (const t of live) if (t.id) matchedPeers.add(t.id);
  for (const v of trackViews) {
    if (v.key !== null && !live.some((t) => t.key === v.key)) {
      v.key = null;
      v.view.hide();
      v.label.set("");
      v.link.visible = false;
    }
  }
  for (const t of live) {
    let v = trackViews.find((x) => x.key === t.key) ?? trackViews.find((x) => x.key === null);
    if (!v || !t.points) continue;
    v.key = t.key;
    const peer = t.id ? peers.get(t.id) : undefined;
    const color = peer ? playerColorHex(peer.info.color) : UNKNOWN_COLOR;
    v.view.setColor(color);
    v.view.update(t.points);
    v.label.set(peer ? `${peer.info.name}（${peer.info.id}）` : "？", cssColor(color));
    // 名札は頭の上（表示用の座標。骨格と同じ視線に沿う）。遠いほど小さく見えるので、距離に応じて実寸を変えて見かけの大きさを保つ
    const h = t.displayHead;
    const depth = Math.max(0.3, -h.z);
    v.label.mesh.position.set(h.x, h.y + 0.12 * depth, h.z);
    v.label.mesh.scale.setScalar(THREE.MathUtils.clamp(depth / 1.5, 0.5, 4));
    // ネットワーク上の頭（アバター）→ 検出した頭 の線（対応の誤差を見せる）
    if (peer && peer.group.visible) {
      peer.group.getWorldPosition(tmpVec);
      tmpVec2.set(h.x, h.y, h.z);
      camera.localToWorld(tmpVec2);
      v.linkPositions.set([tmpVec.x, tmpVec.y, tmpVec.z, tmpVec2.x, tmpVec2.y, tmpVec2.z]);
      v.link.geometry.attributes.position.needsUpdate = true;
      (v.link.material as THREE.LineBasicMaterial).color.setHex(color);
      v.link.visible = true;
    } else {
      v.link.visible = false;
    }
  }
}

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

// ---- パススルー（PC デバッグ用フェイクカメラは 06-2 / 07 / 08 と同じ描き方） ----
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

// ---- 人物検出（初期化・失敗時の CPU 再試行は 06〜08 の手と同じ） ----
let tracker: PoseTracker | null = null;
let trackerStatus = "idle";
let lastTrackerError = "";
let retriedWithCpu = false;
let lastDetectAt = -Infinity;
let detIntervalEma = 0;
let lastResultBodies = 0;

async function initTracker(delegate: typeof DELEGATE = DELEGATE, modelBuffer?: ArrayBuffer) {
  trackerStatus = "loading";
  try {
    tracker = await createPoseTracker(
      {
        numPoses: POSES,
        delegate,
        modelBuffer,
        modelUrls: MODEL_URLS,
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
        inputMaxSide: BODY_DET_W,
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
  console.error("[pose-tracker] 推論に失敗:", e);
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

type PoseResultLike = {
  landmarks: readonly (readonly BodyLandmark[])[];
  worldLandmarks: readonly (readonly BodyLandmark[])[];
};

// 合成の人（?fakebody=1）: 相手が居ればその頭（アバター）の位置に fakeBodyErr だけずらして立たせ、
// 1.5m 横にもう 1 人（対応が付かない「？」）。相手が居なければ fakeBodyDepth 先に 1 人
const fakeShape = syntheticBodyShape();
const fakeEyes = eyesAboveHip(fakeShape);
function fakeBodies(now: number, mapping: ViewMapping): PoseResultLike {
  const bodies: FakeBody[] = [];
  const peer = [...peers.values()].find((p) => p.group.visible && now - p.lastPoseMs <= PEER_STALE_MS);
  let hip: FakeBody["hip"];
  if (peer) {
    peer.group.getWorldPosition(tmpVec);
    camera.worldToLocal(tmpVec);
    // fakePoseResult は cam = hip + (w.x, -w.y, -w.z)（w は y 下向きの world）なので、
    // 目（形状では hip + fakeEyes、y 上）は cam = hip + (fakeEyes.x, fakeEyes.y, -fakeEyes.z)
    hip = { x: tmpVec.x - fakeEyes.x + FAKE_BODY_ERR, y: tmpVec.y - fakeEyes.y, z: tmpVec.z + fakeEyes.z };
  } else {
    hip = { x: -fakeEyes.x, y: -fakeEyes.y, z: -FAKE_BODY_DEPTH + fakeEyes.z };
  }
  bodies.push({ shapeYUp: fakeShape, hip });
  if (FAKE_DECOY) bodies.push({ shapeYUp: fakeShape, hip: { x: hip.x + 1.5, y: hip.y, z: hip.z } });
  return fakePoseResult(bodies, mapping);
}

function updateBodies(now: number) {
  if (!passthrough) return;
  if (FAKE_BODY) {
    if (now - lastDetectAt >= 66) {
      if (lastDetectAt > 0) detIntervalEma = detIntervalEma ? detIntervalEma * 0.9 + (now - lastDetectAt) * 0.1 : now - lastDetectAt;
      lastDetectAt = now;
      applyPoseResult(fakeBodies(now, passthrough.displayViewMapping(camera.fov)), now);
    }
  } else if (tracker) {
    let result: ReturnType<PoseTracker["detect"]> = null;
    try {
      result = tracker.detect(passthrough.video);
    } catch (e: unknown) {
      onTrackerFailure(e);
      return;
    }
    if (result) {
      if (lastDetectAt > 0) detIntervalEma = detIntervalEma ? detIntervalEma * 0.9 + (now - lastDetectAt) * 0.1 : now - lastDetectAt;
      lastDetectAt = now;
      applyPoseResult(result, now);
    }
  }
  tracks.update(now);
  syncTrackViews(now);
}

// 表示用（仮想カメラの FOV）と実寸用（実カメラの FOV）の 2 つの写像の使い分けは buildPersonDetection（body-math.ts）参照
function applyPoseResult(result: PoseResultLike, now: number) {
  if (!passthrough) return;
  const mapping = passthrough.displayViewMapping(camera.fov);
  const depthMapping: ViewMapping = FAKE_BODY ? mapping : (passthrough.metricViewMapping() ?? mapping);
  lastResultBodies = result.landmarks.length;
  const detections: PersonDetection[] = [];
  for (const [i, landmarks] of result.landmarks.entries()) {
    const worldRaw = result.worldLandmarks[i];
    if (!worldRaw) continue;
    const det = buildPersonDetection(landmarks, worldRaw, {
      mapping,
      depthMapping,
      bodyScale: BODY_SCALE,
      minVisibility: MIN_VIS,
      maxDepthM: MAX_BODY_DEPTH_M,
    });
    if (det) detections.push(det);
  }
  tracks.apply(detections, now);
  // 厳密モードでは自分がマーカーロスト中（位置が凍結）は照合しない（候補なし = 保持と期限切れだけ進む）
  const localTracking = markerAnchor?.isTracking(now, MARKER_LOST_MS) ?? false;
  tracks.match(STRICT_TRACKING && !localTracking ? [] : peerCandidates(now), now, matchOpts);
}

// ---- 通信 ----
let selfId = "";
let netStatus = "idle";
let client: PersonClient | null = null;
let joined = false;
let cameraError = "";
let posesSent = 0;
let lastSendMs = -Infinity;

function connect(name: string) {
  if (ROOM === null) return;
  client = connectPerson(
    ROOM,
    name,
    { markerId: MARKER_ID, markerMm: MARKER_MM },
    {
      onStatus: (status) => {
        netStatus = status;
        if (status !== "open") joined = false;
      },
      onError: (reason) => {
        netStatus = `error: ${reason}`;
        console.warn(`[person] rejected: ${reason}`);
      },
      onWelcome: (id, players) => {
        selfId = id;
        netStatus = "open";
        joined = true;
        posesSent = 0;
        [...peers.keys()].forEach(removePeer);
        for (const p of players) if (p.id !== id) createPeer(p);
        console.log(`[person] joined "${ROOM}" as ${id} (peers: ${[...peers.keys()].join(", ") || "none"})`);
      },
      onPeerJoin: (player) => {
        createPeer(player);
        console.log(`[person] peer ${player.id} "${player.name}" joined`);
      },
      onPeerLeave: (id) => {
        removePeer(id);
        console.log(`[person] peer ${id} left`);
      },
      onPeerPose,
    },
  );
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** 自分の姿勢（マーカー座標系）+ 見えている人（頭の位置と対応づけた id）を送る */
function sendPoseIfDue(now: number) {
  if (!client || !markerAnchor?.everDetected) return;
  if (now - lastSendMs < SEND_INTERVAL_MS) return;
  lastSendMs = now;
  computeMyPose();
  const tracking = markerAnchor.isTracking(now, MARKER_LOST_MS);
  // seen は直近の推論で実際に検出された人だけ（保持中の凍結した骨格は送らない）。
  // 厳密モードでは自分がマーカーロスト中（位置が凍結）の間は送らない
  const seen: Sighting[] = [];
  if (tracking || !STRICT_TRACKING) {
    for (const t of tracks.detected(now)) {
      tmpVec.set(t.head.x, t.head.y, t.head.z);
      camera.localToWorld(tmpVec);
      field.worldToLocal(tmpVec);
      seen.push({ id: t.id, pos: [round3(tmpVec.x), round3(tmpVec.y), round3(tmpVec.z)] });
    }
  }
  const pose: PersonPose = {
    pos: [round3(posePos.x), round3(posePos.y), round3(posePos.z)],
    quat: [poseQuat.x, poseQuat.y, poseQuat.z, poseQuat.w],
    tracking,
  };
  if (seen.length > 0) pose.seen = seen;
  if (client.sendPose(pose)) posesSent++;
}

// ---- 視界内メッセージ ----
function describeTrack(t: ReturnType<PersonTracks["live"]>[number]): string {
  const peer = t.id ? peers.get(t.id) : undefined;
  if (peer && t.lastMatch) {
    const stale = peer.tracking ? "" : "・相手はマーカーを見失い中";
    return `${peer.info.name}（${peer.info.id}・${playerColorName(peer.info.color)}） ずれ ${THREE.MathUtils.radToDeg(t.lastMatch.angleRad).toFixed(1)}° / ${t.lastMatch.depthDiffM.toFixed(2)}m${stale}`;
  }
  const n = t.nearest ? peers.get(t.nearest.id) : undefined;
  const hint = t.nearest && n ? `。最寄り ${n.info.name} まで ${THREE.MathUtils.radToDeg(t.nearest.angleRad).toFixed(0)}° / ${t.nearest.depthDiffM.toFixed(2)}m` : "";
  return `？ 不明（${t.depth.toFixed(1)}m 先${hint}）`;
}

function updateMessages(now: number) {
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
    text = "壁のマーカーを見てください\n（共通座標系の原点）";
    color = "#fdd663";
  } else if (trackerStatus.startsWith("error")) {
    text = `人物の検出に失敗しました\n${trackerStatus.slice(7, 50)}`;
    color = "#f28b82";
  } else if (!FAKE_BODY && !tracker) {
    text = "人物の検出を読み込み中…";
    color = "#fdd663";
  } else if (netStatus !== "open" && selfId !== "") {
    text = "接続が切れました（再接続中）";
    color = "#f28b82";
  } else if (!joined) {
    text = netStatus === "open" ? "入室中…" : `サーバーに接続中… (${netStatus})`;
    color = "#fdd663";
  } else {
    const live = tracks.live(now);
    const lines: string[] = [];
    if (live.length === 0) {
      lines.push("人が映っていません");
      lines.push(peers.size === 0 ? "相手の端末も同じ room に入ると名札が付きます" : "相手の方を見てください");
      color = "#fdd663";
    } else {
      for (const t of live) lines.push(describeTrack(t));
      if (live.some((t) => t.id)) color = "#81c995";
    }
    for (const peer of peers.values()) {
      if (peer.seesMe && now - peer.seesMeMs <= SEEN_STALE_MS) {
        lines.push(`${peer.info.name} から見えています（ずれ ${peer.seesMeDist.toFixed(2)}m${peer.seesMeTracking ? "" : "・相手はマーカーを見失い中"}）`);
      }
    }
    text = lines.join("\n");
  }
  message.set(text, color);
}

// ---- 頭追従（02〜08 と同じ） ----
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
  const now = performance.now();
  const live = tracks.live(now);
  const seenBy = [...peers.values()]
    .filter((p) => p.seesMe && now - p.seesMeMs <= SEEN_STALE_MS)
    .map((p) => `${p.info.id}:${p.seesMeDist.toFixed(2)}m`)
    .join(",");
  const text = [
    `${hudState.base} (fov now=${camera.fov.toFixed(1)})`,
    hudState.sensor && `sensor=${hudState.sensor}`,
    hudState.cam && `cam=${hudState.cam}`,
    hudState.fsResult && `fs=${hudState.fsResult}`,
    hudState.fsChange && `fs-change: ${hudState.fsChange}`,
    hudState.wake && `wake=${hudState.wake}`,
    `marker=${markerAnchor?.info ?? "-"}${markerAnchor?.everDetected && !markerAnchor.isTracking(now, MARKER_LOST_MS) ? " (holding last pose)" : ""}`,
    `tracker=${trackerStatus}${lastTrackerError ? ` (last error: ${lastTrackerError})` : ""}`,
    (tracker || FAKE_BODY) &&
      `bodies=${lastResultBodies} tracks=[${live
        .map(
          (t) =>
            `${t.id ?? "?"}:${t.depth.toFixed(2)}m` +
            (t.lastMatch ? `/${THREE.MathUtils.radToDeg(t.lastMatch.angleRad).toFixed(1)}deg/${t.lastMatch.depthDiffM.toFixed(2)}m` : "") +
            `/vis${t.used}/res${t.residual.toFixed(3)}` +
            (!t.lastMatch && t.nearest ? `/near=${t.nearest.id}@${THREE.MathUtils.radToDeg(t.nearest.angleRad).toFixed(1)}deg/${t.nearest.depthDiffM.toFixed(2)}m` : ""),
        )
        .join(",")}] infer=${(tracker?.lastMs ?? 0).toFixed(0)}ms every ${detIntervalEma.toFixed(0)}ms`,
    `room=${ROOM ?? "(不正)"} me=${selfId || "-"} peers=${[...peers.values()].map((p) => `${p.info.id}${p.group.visible ? "" : "(hidden)"}`).join(",") || "-"} ws=${netStatus} sent=${posesSent} seenBy=${seenBy || "-"}`,
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
  hudState.base = `fov=${FOV_FIXED ?? "auto"} camZoom=${CAM_ZOOM} markerMm=${MARKER_MM} detW=${MARKER_DET_W}@${MARKER_INTERVAL_MS}ms poses=${POSES} delegate=${DELEGATE} bodyDetW=${BODY_DET_W} bodyScale=${BODY_SCALE} minVis=${MIN_VIS} match=${MATCH_ANGLE_DEG}deg/${MATCH_DEPTH_M}m strict=${STRICT_TRACKING ? 1 : 0} mode=${touch ? "gyro" : "orbit"}`;
  connect(name);
  if (FAKE_BODY) {
    trackerStatus = "fake (synthetic body, MediaPipe 未使用)";
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
  anchor.updateMatrixWorld(true);
  // ピアの位置を先に進めてから、その位置を対応づけの候補にする
  updatePeers(now);
  updateBodies(now);
  sendPoseIfDue(now);
  updateMessages(now);
  if (document.body.classList.contains("started")) renderHud();
  effect.render(scene, camera);
});
