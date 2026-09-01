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
import type { ViewMapping } from "../../src/shared/hand-math";
import { HandSlots, PALM_CONTACT } from "../../src/shared/hand-slots";
import type { HandResultLike } from "../../src/shared/hand-slots";
import { TextPanel } from "../../src/shared/text-panel";
import markerSvgUrl from "../../src/shared/marker-0.svg";
import { launchVelocity } from "../../src/shared/volleyball-sim";
import type { V3 } from "../../src/shared/darts-sim";
import { DEFAULT_GH, GodHandGame } from "./god-hand-game";
import type { GHBall } from "./god-hand-game";
import { createGodHand, createShatter } from "./god-hand-mesh";
import type { GodHand, Shatter } from "./god-hand-mesh";
import { FAKE_THRUST_SEC, scriptedGodHand } from "./fake-godhand-hand";

// 番外編 ex8-1: ゴッドハンド。イナズマイレブンの円堂守のキーパー技を MR で出す 1 人用ミニゲーム。
//   - 壁のマーカー = 相手コート。仮想シューターが壁の手前からあなたの背後のゴールへシュートを撃つ
//   - パーに開いた手を素早く前へ突き出すと、巨大な金色の手（カクカクした厚い板 + オーラ + 稲妻）が
//     約 1.2 秒実体化する。その間にボールが触れればキャッチ、通されると失点（オーラが砕ける）
//   - ローカルのみ（サーバー・通信なし）。ルールと判定は god-hand-game.ts の純粋クラス
//   - 手が取れないときの保険: 画面タップ / Space でも視界の先に発動する

// ---- パラメータ（カメラ・マーカー・手は 06-2 / 08 と同じ。根拠は 06 の main.ts 参照） ----
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

// ゴッドハンド
/** 発動とみなす手のひらの突き出しの速さ [m/s]（パーの手のみ） */
const GH_MIN_SPEED = numParam("ghMinSpeed", 2, { min: 0.3, max: 10 });
const GH_ACTIVE_SEC = numParam("ghActiveSec", DEFAULT_GH.handActiveSec, { min: 0.3, max: 5 });
const GH_SPEED = numParam("ghSpeed", DEFAULT_GH.speedStart, { min: 1, max: 20 });
const GH_SPEED_MAX = numParam("ghSpeedMax", DEFAULT_GH.speedMax, { min: 1, max: 20 });
const GH_LIVES = Math.round(numParam("lives", DEFAULT_GH.lives, { min: 1, max: 20 }));
/** 手のひらから見て、巨大な手をどれだけ壁側（ボール側）へ出すか [m] */
const GH_FORWARD_M = numParam("ghForward", 0.6, { min: 0, max: 2 });

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

// ---- ゲーム ----
const game = new GodHandGame({
  handActiveSec: GH_ACTIVE_SEC,
  speedStart: GH_SPEED,
  speedMax: GH_SPEED_MAX,
  lives: GH_LIVES,
});

// ---- 壁側: シュートの出口（光る輪）とスコアボード ----
const portal = new THREE.Mesh(
  new THREE.TorusGeometry(0.25, 0.03, 12, 40),
  new THREE.MeshBasicMaterial({ color: 0xff8855, transparent: true, opacity: 0.7 }),
);
portal.visible = false;
board.add(portal);
const scorePanel = new TextPanel(0.9, 0.3);
scorePanel.mesh.position.set(0, 0.65, 0.01);
board.add(scorePanel.mesh);
const message = new TextPanel(0.9, 0.24);
message.mesh.position.set(0, -0.28, -1.2);
camera.add(message.mesh);

// ---- 自分のゴール（背後の白い枠。restart のたびに頭の位置から置き直す） ----
const goalGroup = new THREE.Group();
goalGroup.visible = false;
board.add(goalGroup);
{
  const mat = new THREE.MeshStandardMaterial({ color: 0xf5f5f5, roughness: 0.6 });
  const W = 2.4;
  const H = 1.8;
  const R = 0.05;
  const left = new THREE.Mesh(new THREE.CylinderGeometry(R, R, H, 10), mat);
  left.position.set(-W / 2, H / 2, 0);
  const right = left.clone();
  right.position.x = W / 2;
  const bar = new THREE.Mesh(new THREE.CylinderGeometry(R, R, W + R * 2, 10), mat);
  bar.rotation.z = Math.PI / 2;
  bar.position.set(0, H, 0);
  goalGroup.add(left, right, bar);
}

// ---- ボール（白地 + 黒い斑のサッカーボール風テクスチャ） ----
function createBallTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#f2f2f2";
  ctx.fillRect(0, 0, 128, 128);
  ctx.fillStyle = "#222";
  for (const [x, y] of [[20, 30], [70, 15], [110, 45], [40, 75], [95, 90], [15, 105], [65, 115]]) {
    ctx.beginPath();
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
      const px = x + Math.cos(a) * 11;
      const py = y + Math.sin(a) * 11;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
const ballGeometry = new THREE.SphereGeometry(DEFAULT_GH.ballR, 20, 14);
const ballTexture = createBallTexture();
const ballMeshes = new Map<number, THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>>();
function ballMeshOf(ball: GHBall): THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial> {
  let m = ballMeshes.get(ball.id);
  if (!m) {
    // 照明に依存しない Basic（パススルーの背景の上では Standard だと暗く沈む）。
    // 予告の光は color を白 → オレンジに寄せて表す
    m = new THREE.Mesh(ballGeometry, new THREE.MeshBasicMaterial({ map: ballTexture }));
    board.add(m);
    ballMeshes.set(ball.id, m);
  }
  return m;
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

// ---- パススルー（PC デバッグ用フェイクカメラは 06-2 / 08 と同じ描き方） ----
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
    // 実体化中に board が飛ぶと手とボールの位置関係が壊れるので lerp だけ
    canSnap: () => game.hand === null,
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
let fakeThrustStartMs = -1;

/** 合成の手: 迫っているボールが手前 1.4m まで来たら突き出す */
function updateFakeHands(now: number) {
  if (now - lastDetectAt < 33 || !passthrough) return;
  const mapping = passthrough.displayViewMapping(camera.fov);
  if (fakeStartMs < 0) fakeStartMs = now;
  lastDetectAt = now;
  const head = headBoard();
  const incoming =
    head !== null &&
    game.balls.some(
      (b) => b.state === "flying" && head[2] - b.pos[2] > 0.4 && head[2] - b.pos[2] < 1.6,
    );
  if (incoming && fakeThrustStartMs < 0 && game.hand === null) fakeThrustStartMs = now;
  if (fakeThrustStartMs >= 0 && now - fakeThrustStartMs > (FAKE_THRUST_SEC + 0.4) * 1000) fakeThrustStartMs = -1;
  const thrustSec = fakeThrustStartMs >= 0 ? (now - fakeThrustStartMs) / 1000 : null;
  applyHandResult(scriptedGodHand(thrustSec, (now - fakeStartMs) / 1000, mapping), now);
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

// ---- 頭の位置（board 座標系）。シュートの狙いとゴール枠に使う ----
const headWorld = new THREE.Vector3();
function headBoard(): V3 | null {
  if (!anchor.visible) return null;
  camera.getWorldPosition(headWorld);
  board.worldToLocal(headWorld);
  return [headWorld.x, headWorld.y, headWorld.z];
}

// ---- シューター（仮想）: 一定間隔で頭の少し脇 → ゴールへ撃つ ----
let nextShotAt = -1;
let goalPlaced = false;

function placeGoal(head: V3) {
  goalGroup.position.set(head[0], head[1] - 1.5, head[2] + 0.8);
  goalGroup.visible = true;
  goalPlaced = true;
}

function updateShooter(now: number) {
  const head = headBoard();
  if (!head || game.phase !== "play") return;
  if (!goalPlaced) placeGoal(head);
  if (nextShotAt < 0) nextShotAt = now + 1500;
  if (now < nextShotAt) return;
  nextShotAt = now + game.shotInterval() * 1000;
  // 壁の手前（マーカーの周り）から、頭の近く（ゴールの中）へ
  const from: V3 = [
    (Math.random() - 0.5) * 1.6,
    (Math.random() - 0.5) * 0.7,
    0.18,
  ];
  const target: V3 = [
    head[0] + (Math.random() - 0.5) * 0.9,
    head[1] + (Math.random() - 0.5) * 0.6 - 0.1,
    head[2],
  ];
  const speed = game.shotSpeed();
  const dist = Math.hypot(target[0] - from[0], target[1] - from[1], target[2] - from[2]);
  const flightSec = dist / speed;
  const vel = launchVelocity(from, target, flightSec, game.cfg.gravity);
  game.spawnShot(from, vel, head[2] + 0.8, now);
}

// ---- ゴッドハンドの発動（パーの手の突き出し / タップ・Space） ----
let godHand: GodHand | null = null;
const godHandCenterWorld = new THREE.Vector3();
let shatters: Shatter[] = [];
let flash: { text: string; untilMs: number; color: string } | null = null;
let activations = 0;
let holdRequested = false;
let lastShapeInfo = "";
/** 発動の元になった手のスロット（実体化中の追従先。hands=2 で別の手へ飛ばないように） */
let activeSlot: ReturnType<HandSlots["visible"]>[number] | null = null;
const velBoard = new THREE.Vector3();
const boardQuatInv = new THREE.Quaternion();

function tryActivate(originWorld: THREE.Vector3, now: number) {
  if (!anchor.visible) return;
  // 手のひらから壁側へ GH_FORWARD_M 出した位置に実体化
  tmpVec2.copy(originWorld);
  board.worldToLocal(tmpVec2);
  tmpVec2.z -= GH_FORWARD_M;
  if (!game.activate([tmpVec2.x, tmpVec2.y, tmpVec2.z], now)) return;
  activations++;
  godHand?.dispose();
  godHand = createGodHand();
  godHand.group.position.copy(tmpVec2);
  // 手のひらを壁（ボールの来る方向 = -Z）へ向け、参考画像のように少し傾ける
  godHand.group.rotation.set(-0.12, Math.PI, -0.22);
  board.add(godHand.group);
  console.log(`[gh] activate #${activations} at (${tmpVec2.x.toFixed(2)}, ${tmpVec2.y.toFixed(2)}, ${tmpVec2.z.toFixed(2)})`);
}

function updateActivation(now: number) {
  const shapes = handSlots.slots.filter((s) => s.view.visible).map((s) => s.shape);
  lastShapeInfo = shapes.join(",") || "-";
  // 1) パーの手の速い突き出し（壁の方向か上方向への成分が主であること。横に振っただけでは出さない）
  for (const slot of handSlots.slots) {
    if (!slot.view.visible || !slot.ema || slot.shape !== "open") continue;
    const v = slot.contactsVel[PALM_CONTACT];
    if (v.length() < GH_MIN_SPEED) continue;
    board.getWorldQuaternion(boardQuatInv).invert();
    velBoard.copy(v).applyQuaternion(boardQuatInv);
    const thrust = Math.max(-velBoard.z, velBoard.y); // 壁へ（-Z）か上へ（+Y）
    if (thrust < GH_MIN_SPEED * 0.5) continue;
    tryActivate(slot.contactsWorld[PALM_CONTACT], now);
    if (game.hand) activeSlot = slot;
    break;
  }
  // 2) タップ / Space（手が取れないときの保険）: 視界の先 0.9m
  if (holdRequested) {
    holdRequested = false;
    tmpVec.set(0, 0, -0.9);
    camera.localToWorld(tmpVec);
    tryActivate(tmpVec, now);
  }
  // 実体化中は「発動した手」に追従（ゆっくり）。手を見失ったら最後の位置を保つ
  if (game.hand && godHand) {
    if (activeSlot && activeSlot.view.visible && activeSlot.ema) {
      tmpVec2.copy(activeSlot.contactsWorld[PALM_CONTACT]);
      board.worldToLocal(tmpVec2);
      tmpVec2.z -= GH_FORWARD_M;
      godHand.group.position.lerp(tmpVec2, 0.15);
    }
    const p = godHand.group.position;
    game.moveHand([p.x, p.y, p.z]);
  } else {
    activeSlot = null;
  }
}

if (touch) {
  document.querySelector<HTMLDivElement>("#app")!.addEventListener("pointerdown", () => {
    if (document.body.classList.contains("started")) holdRequested = true;
  });
} else {
  addEventListener("keydown", (e) => {
    if (e.key === " " && document.body.classList.contains("started")) {
      e.preventDefault();
      holdRequested = true;
    }
  });
}

// ---- ゲームの進行と描画 ----
let lastUpdateMs = performance.now();
let caught = 0;

function updateGame(now: number) {
  const dt = (now - lastUpdateMs) / 1000;
  lastUpdateMs = now;
  if (!anchor.visible) return;
  updateShooter(now);
  const events = game.update(now, dt);
  for (const ev of events) {
    if (ev.kind === "catch") {
      caught++;
      // 参考画像のように、キャッチしたボールは手のひらの中央に張り付かせる（少し手前 = プレイヤー側）
      if (game.hand) {
        ev.ball.pos = [game.hand.center[0], game.hand.center[1] + 0.05, game.hand.center[2] + 0.18];
      }
      flash = { text: `ゴッドハンド！！ キャッチ！${ev.combo >= 2 ? `\n${ev.combo} 連続！` : ""}`, untilMs: now + 1600, color: "#ffd75e" };
      console.log(`[gh] catch combo=${ev.combo}`);
    } else if (ev.kind === "broken") {
      flash = { text: "破られた…！", untilMs: now + 1600, color: "#f28b82" };
      if (godHand) {
        godHand.group.getWorldPosition(godHandCenterWorld);
        const sh = createShatter(new THREE.Vector3().copy(godHandCenterWorld));
        scene.add(sh.group);
        shatters.push(sh);
        godHand.dispose();
        godHand = null;
        game.breakHand(now); // クールダウンの起点も記録（直接 null にすると即再発動できてしまう）
      }
      console.log("[gh] broken");
    } else if (ev.kind === "goal") {
      flash = { text: "ゴール…", untilMs: now + 1400, color: "#f28b82" };
      console.log("[gh] goal");
    } else if (ev.kind === "gameover") {
      flash = { text: `ゲームオーバー\nキャッチ ${ev.score} / 最高 ${ev.bestCombo} 連続`, untilMs: now + game.cfg.resultSec * 1000, color: "#e8eaed" };
      console.log(`[gh] gameover score=${ev.score} best=${ev.bestCombo}`);
    } else if (ev.kind === "restart") {
      goalPlaced = false;
      nextShotAt = -1;
      flash = { text: "もう一度！", untilMs: now + 1500, color: "#81c995" };
    } else if (ev.kind === "launch") {
      console.log(`[gh] launch #${ev.ball.id} speed=${Math.hypot(...ev.ball.vel).toFixed(1)}`);
    }
  }
  // 実体化の寿命が尽きたら静かに消す（破られたときは上で消している）
  if (!game.hand && godHand) {
    godHand.dispose();
    godHand = null;
  }
  godHand?.update(now, now - (game.hand?.activatedAt ?? now));

  // ボールの描画（telegraph は portal の位置で光る）
  const keep = new Set<number>();
  let telegraphing = false;
  for (const ball of game.balls) {
    keep.add(ball.id);
    const mesh = ballMeshOf(ball);
    if (ball.state === "telegraph") {
      portal.position.set(ball.from[0], ball.from[1], ball.from[2]);
      telegraphing = true;
      const k = Math.min(1, (now - (ball.launchAt - game.cfg.telegraphSec * 1000)) / (game.cfg.telegraphSec * 1000));
      mesh.position.set(...ball.from);
      mesh.material.color.setRGB(1, 1 - 0.35 * k, 1 - 0.7 * k);
      mesh.scale.setScalar(0.6 + 0.4 * k);
    } else {
      // キャッチ中でゴッドハンドがまだ出ていれば、手のひらに張り付いて一緒に動く
      if (ball.state === "caught" && godHand && game.hand) {
        ball.pos = [godHand.group.position.x, godHand.group.position.y + 0.05, godHand.group.position.z + 0.18];
      }
      mesh.position.set(ball.pos[0], ball.pos[1], ball.pos[2]);
      mesh.material.color.setRGB(1, 1, 1);
      mesh.scale.setScalar(1);
      if (ball.state === "conceded" || ball.state === "gone") {
        mesh.material.transparent = true;
        mesh.material.opacity = Math.max(0, 1 - (now - ball.stateSinceMs) / 1000);
      } else {
        mesh.material.opacity = 1;
      }
    }
  }
  for (const [id, mesh] of ballMeshes) {
    if (keep.has(id)) continue;
    mesh.material.dispose();
    mesh.removeFromParent();
    ballMeshes.delete(id);
  }
  portal.visible = telegraphing;
  if (telegraphing) portal.scale.setScalar(1 + 0.12 * Math.sin(now / 70));
  // 砕け散り
  shatters = shatters.filter((sh) => {
    if (sh.update(dt)) return true;
    sh.dispose();
    return false;
  });
}

// ---- 表示 ----
let cameraError = "";
function updateMessages(now: number) {
  scorePanel.set(
    `キャッチ ${game.score}（${game.combo} 連続）\n失点 ${game.conceded} / ${game.cfg.lives}`,
    "#e8eaed",
  );
  let text = "";
  let color = "#e8eaed";
  if (cameraError) {
    text = `カメラを開けません\n${cameraError.slice(0, 40)}`;
    color = "#f28b82";
  } else if (!passthrough) {
    text = "カメラを起動中…";
  } else if (!markerAnchor?.everDetected) {
    text = "壁のマーカーを見てください";
    color = "#fdd663";
  } else if (trackerStatus.startsWith("error")) {
    text = "手の検出に失敗しました\nタップ / Space でも発動できます";
    color = "#f28b82";
  } else if (!FAKE_HANDS && !tracker) {
    text = "手の検出を読み込み中…";
    color = "#fdd663";
  } else if (flash && now < flash.untilMs) {
    text = flash.text;
    color = flash.color;
  } else if (game.hand) {
    text = "";
  } else {
    text = "ボールが光ったら\nパーの手を前へ突き出せ！";
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
const hudState = { base: "", sensor: "", cam: "", fsResult: "", fsChange: "" };
let lastHudText = "";
function renderHud() {
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
    `game: phase=${game.phase} score=${game.score} combo=${game.combo} best=${game.bestCombo} conceded=${game.conceded}/${game.cfg.lives} shots=${game.shotsFired} activations=${activations} hand=${game.hand ? "yes" : "no"} balls=${game.balls.length} caught=${caught}`,
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
startButton.addEventListener("click", () => {
  document.body.classList.add("started");
  hudState.base = `fov=${FOV_FIXED ?? "auto"} camZoom=${CAM_ZOOM} markerMm=${MARKER_MM} detW=${MARKER_DET_W}@${MARKER_INTERVAL_MS}ms hands=${NUM_HANDS} delegate=${DELEGATE} handScale=${HAND_SCALE} ghMinSpeed=${GH_MIN_SPEED} ghActiveSec=${GH_ACTIVE_SEC} speed=${GH_SPEED}..${GH_SPEED_MAX} mode=${touch ? "gyro" : "orbit"}`;
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
  updateActivation(now);
  updateGame(now);
  updateMessages(now);
  if (document.body.classList.contains("started")) renderHud();
  effect.render(scene, camera);
});
