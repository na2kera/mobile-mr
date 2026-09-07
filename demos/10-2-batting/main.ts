import * as THREE from "three";
import { StereoEffect } from "three/examples/jsm/effects/StereoEffect.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { DeviceOrientationControls } from "three-stdlib";
import {
  numParam,
  params,
  resolutionParam,
} from "../../src/shared/url-params";
import {
  CAM_FOV_WIDE,
  createFakeCameraStream,
  drawCheckerboard,
  startPassthrough,
  type Passthrough,
} from "../../src/shared/passthrough-camera";
import {
  isTouchDevice,
  runStartFlow,
  setupFullscreen,
} from "../../src/shared/start-flow";
import { setupPlayerNameField } from "../../src/shared/player-name";
import {
  createMarkerAnchor,
  type MarkerAnchor,
} from "../../src/shared/marker-anchor";
import { markerBits } from "../../src/shared/marker-detector";
import { markerToFieldMatrix } from "../../src/shared/marker-layout";
import {
  drawProjectedMarkers,
  fakeCameraToField,
  projectFakeMarkers,
  type FakeMarker,
} from "../../src/shared/fake-markers";
import { TextPanel } from "../../src/shared/text-panel";
import { ROOM_ID_PATTERN } from "../../src/shared/shared-room-protocol";
import {
  DEFAULT_BATTING,
  PITCH_LABELS,
  hitAt,
  pitchAt,
  simulatePitch,
  type BattingConfig,
  type HitFlight,
  type PitchResult,
  type V3,
} from "../../src/shared/batting-sim";
import type {
  GameSnapshot,
  PlayerRole,
} from "../../src/shared/batting-game";
import {
  NAME_MAX_LENGTH,
  type MotionKind,
  type PlayerPose,
} from "../../src/shared/batting-protocol";
import { startRemoteLog } from "../../src/shared/remote-log";
import { BattingFieldView } from "./field-view";
import { connectGame, type GameClient } from "./game-client";

// Phase 10-2: Joy-Con をバット / 投球入力にする MR バッティング。
// Joy-Con の IMU は PC Chrome の俯瞰画面が読み、サーバーを経由してこのスマホへ届く。
// 1 人なら bot の投球でフリーバッティング、2 人なら参加順で打者・投手に分かれる。

const fovRaw = params.get("fov");
const FOV_FIXED =
  fovRaw === null || fovRaw === "auto"
    ? null
    : numParam("fov", 94, { min: 20, max: 170 });
const EYE_SEP = numParam("eyeSep", 0.064, { min: 0, max: 0.2 });
const CAM_ZOOM = numParam("camZoom", 0.7, { min: 0.2, max: 5 });
const CAM_RES = resolutionParam("camRes", [1280, 720]);
const MARKER_MM = numParam("markerMm", 100, { max: 5000 });
const MARKER_SIZE_M = MARKER_MM / 1000;
const MARKER_ID = Math.round(
  numParam("markerId", 0, { min: 0, max: 249 }),
);
const MARKER_DET_W = numParam("detW", 960, { min: 64, max: 4096 });
const MARKER_SMOOTH = numParam("smooth", 0.5, { min: 0.01, max: 1 });
const MARKER_INTERVAL_MS = numParam("markerIntervalMs", 66, {
  min: 0,
  max: 2000,
});
const MARKER_LOST_MS = numParam("lostMs", 500, {
  min: 50,
  max: 10000,
});
const MAX_POSE_ERROR = numParam("maxPoseError", 0.5, {
  min: 0,
  max: 100,
});
const roomRaw = params.get("room");
const ROOM =
  roomRaw === null
    ? "demo"
    : ROOM_ID_PATTERN.test(roomRaw)
      ? roomRaw
      : null;
const SEND_INTERVAL_MS =
  1000 / numParam("sendHz", 15, { min: 1, max: 60 });
const CHARGE_SEC = numParam("chargeSec", 1.2, { min: 0.2, max: 10 });
const FAKE_CAM = params.has("fakecam");
const FAKE_ACTION_SEC = params.has("fakeAction")
  ? numParam("fakeAction", 0.6, { min: 0.05, max: 10 })
  : null;
const touch = isTouchDevice();

let lastHudText = "";
startRemoteLog({
  tag: "batting-phone",
  snapshot: () => lastHudText,
  snapshotMs: 3000,
});

// ---- scene / field ----
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a2233);
const camera = new THREE.PerspectiveCamera(
  FOV_FIXED ?? 94,
  innerWidth / innerHeight,
  0.05,
  100,
);
camera.position.set(0, 0.35, 2.45);
scene.add(camera);
scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.2));
const dirLight = new THREE.DirectionalLight(0xffffff, 1.5);
dirLight.position.set(3, 8, 3);
scene.add(dirLight);

const anchor = new THREE.Group();
anchor.visible = false;
scene.add(anchor);
const field = anchor;
let cfg: BattingConfig = { ...DEFAULT_BATTING };
const fieldView = new BattingFieldView(20);
field.add(fieldView.group);
fieldView.build(cfg);

const markerFrame = new THREE.Mesh(
  new THREE.PlaneGeometry(MARKER_SIZE_M, MARKER_SIZE_M),
  new THREE.MeshBasicMaterial({
    color: 0x8ab4f8,
    transparent: true,
    opacity: 0.45,
    side: THREE.DoubleSide,
  }),
);
field.add(markerFrame);

const scorePanel = new TextPanel(1.35, 0.36);
scorePanel.mesh.position.set(0, 0.75, 0.02);
field.add(scorePanel.mesh);
const messagePanel = new TextPanel(0.95, 0.25);
messagePanel.mesh.position.set(0, -0.28, -1.2);
camera.add(messagePanel.mesh);
const chargePanel = new TextPanel(0.65, 0.1, 512, 8);
chargePanel.mesh.position.set(0, -0.43, -1.2);
camera.add(chargePanel.mesh);

// ---- peer heads ----
type Peer = {
  group: THREE.Group;
  targetPos: THREE.Vector3;
  targetQuat: THREE.Quaternion;
  lastPoseMs: number;
};
const peers = new Map<string, Peer>();
function createPeer(id: string): Peer {
  removePeer(id);
  const group = new THREE.Group();
  group.add(
    new THREE.Mesh(
      new THREE.SphereGeometry(0.09, 20, 14),
      new THREE.MeshStandardMaterial({ color: 0x00b8d4 }),
    ),
  );
  const nose = new THREE.Mesh(
    new THREE.ConeGeometry(0.03, 0.08, 12),
    new THREE.MeshStandardMaterial({ color: 0xe8eaed }),
  );
  nose.rotation.x = -Math.PI / 2;
  nose.position.z = -0.1;
  group.add(nose);
  group.visible = false;
  field.add(group);
  const peer = {
    group,
    targetPos: new THREE.Vector3(),
    targetQuat: new THREE.Quaternion(),
    lastPoseMs: -Infinity,
  };
  peers.set(id, peer);
  return peer;
}
function removePeer(id: string) {
  const peer = peers.get(id);
  if (!peer) return;
  peer.group.removeFromParent();
  peers.delete(id);
}
function onPeerPose(id: string, pose: PlayerPose) {
  const peer = peers.get(id) ?? createPeer(id);
  peer.targetPos.set(...pose.pos);
  peer.targetQuat.set(...pose.quat);
  if (!Number.isFinite(peer.lastPoseMs)) {
    peer.group.position.copy(peer.targetPos);
    peer.group.quaternion.copy(peer.targetQuat);
  }
  peer.lastPoseMs = performance.now();
}
function updatePeers(now: number) {
  for (const peer of peers.values()) {
    peer.group.visible = now - peer.lastPoseMs < 2000;
    peer.group.position.lerp(peer.targetPos, 0.25);
    peer.group.quaternion.slerp(peer.targetQuat, 0.25);
  }
}

// ---- renderer / camera / marker ----
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

const FAKE_W = 640;
const FAKE_H = 480;
const FAKE_FOCAL =
  FAKE_W /
  2 /
  Math.tan(THREE.MathUtils.degToRad(CAM_FOV_WIDE) / 2);
function fakeStream(): MediaStream {
  const marker: FakeMarker = {
    id: MARKER_ID,
    bits: markerBits(MARKER_ID),
    toField: markerToFieldMatrix({
      id: MARKER_ID,
      face: "wall",
      pos: [0, 0, 0],
    }),
  };
  // 150mm マーカーで約67px（既存ヘッドレス確認の安定域）になる距離。
  const camToField = fakeCameraToField([0, 0.1, 0.75], 0, 0);
  return createFakeCameraStream(
    (ctx, canvas, frame) => {
      drawCheckerboard(ctx, canvas, frame);
      drawProjectedMarkers(
        ctx,
        projectFakeMarkers(
          [marker],
          camToField,
          FAKE_FOCAL,
          canvas.width,
          canvas.height,
          MARKER_SIZE_M,
        ),
      );
    },
    { width: FAKE_W, height: FAKE_H },
  );
}
async function startCamera(onProgress: (step: string) => void) {
  passthrough = await startPassthrough(
    scene,
    {
      fakeStream: FAKE_CAM ? fakeStream : undefined,
      camRes: CAM_RES,
      preferUltraWide: params.get("lens") !== "wide",
      camFovOverride: params.has("camFov")
        ? numParam("camFov", 68, { min: 10, max: 170 })
        : undefined,
      eyeAspect: () => innerWidth / 2 / innerHeight,
      zoom: CAM_ZOOM,
    },
    onProgress,
  );
  markerAnchor = createMarkerAnchor({
    video: passthrough.video,
    camera,
    anchor,
    markerSizeM: MARKER_SIZE_M,
    markerId: MARKER_ID,
    maxPoseError: MAX_POSE_ERROR,
    detW: MARKER_DET_W,
    smooth: MARKER_SMOOTH,
    minIntervalMs: MARKER_INTERVAL_MS,
    camHFovDeg: () => passthrough!.camHFovDeg,
    resnapAfterMs: 2000,
    snapDistanceM: 0.3,
  });
}

// ---- network state ----
let selfId = "";
let netStatus = "idle";
let joined = false;
let client: GameClient | null = null;
let auth: { state: GameSnapshot; recvMs: number } | null = null;
let cameraError = "";
let lastRejectReason = "";
let actionsSent = 0;
let posesSent = 0;
let lastEventKey = "";
let flash: { text: string; until: number } | null = null;
let livePitch:
  | { seq: number; result: PitchResult; startLocalMs: number }
  | null = null;
let liveHit:
  | { seq: number; result: HitFlight; startLocalMs: number }
  | null = null;
const motions = new Map<
  string,
  { kind: MotionKind; angleDeg: number; dps: number; at: number }
>();
let fakeHandledPitch = -1;
let fakeHandledWaitSeq = -1;

function localTimeOf(
  serverT: number,
  refServerT: number,
  refLocalMs: number,
) {
  return refLocalMs + (serverT - refServerT);
}
function playerRole(id = selfId): PlayerRole | null {
  return auth?.state.players.find((p) => p.id === id)?.role ?? null;
}
function nameOf(id: string) {
  return auth?.state.players.find((p) => p.id === id)?.name ?? id;
}
function onState(state: GameSnapshot) {
  const now = performance.now();
  auth = { state, recvMs: now };
  if (state.pitch && state.pitch.seq !== livePitch?.seq) {
    livePitch = {
      seq: state.pitch.seq,
      result: simulatePitch(state.pitch.type, state.pitch.speed, cfg),
      startLocalMs: localTimeOf(state.pitch.startedAt, state.t, now),
    };
  }
  if (!state.pitch) livePitch = null;
  if (state.hit && state.hit.seq !== liveHit?.seq) {
    liveHit = {
      seq: state.hit.seq,
      result: {
        samples: state.hit.samples.map((p) => [...p]),
        duration: state.hit.duration,
        end: [...state.hit.end],
        distance: state.hit.distance,
        exitSpeed: state.hit.exitSpeed,
      },
      startLocalMs: localTimeOf(state.hit.startedAt, state.t, now),
    };
  }
  if (!state.hit) liveHit = null;
  const event = state.event;
  const key = event ? `${state.seq}:${event.kind}` : "";
  if (event && key !== lastEventKey) {
    lastEventKey = key;
    if (event.kind === "pitch") {
      flash = {
        text: `${PITCH_LABELS[event.pitchType]} ${Math.round(event.speed * 3.6)} km/h`,
        until: now + 700,
      };
    } else if (
      event.kind === "hit" ||
      event.kind === "miss" ||
      event.kind === "take"
    ) {
      flash = { text: event.label, until: now + 1500 };
    } else if (event.kind === "mode") {
      flash = {
        text:
          event.mode === "free"
            ? "フリーバッティング"
            : "2人対戦：打者と投手",
        until: now + 1600,
      };
    }
    console.log(
      `[batting] event=${event.kind} phase=${state.phase} mode=${state.mode}`,
    );
  }
}

function connect(name: string) {
  if (ROOM === null) return;
  client = connectGame(
    ROOM,
    name,
    { markerId: MARKER_ID, markerMm: MARKER_MM },
    {
      onStatus: (status) => {
        netStatus = status;
        if (status !== "open") joined = false;
      },
      onWelcome: (id, _role, _playerRole, peerIds, config, state) => {
        selfId = id;
        joined = true;
        netStatus = "open";
        cfg = config;
        fieldView.build(cfg);
        [...peers.keys()].forEach(removePeer);
        peerIds.forEach(createPeer);
        lastEventKey = "";
        onState(state);
      },
      onPeerJoin: createPeer,
      onPeerLeave: (id) => {
        removePeer(id);
        motions.delete(id);
      },
      onPeerPose,
      onState,
      onMotion: (id, kind, angleDeg, dps) => {
        motions.set(id, {
          kind,
          angleDeg,
          dps,
          at: performance.now(),
        });
      },
      onRejected: (reason) => {
        lastRejectReason = reason;
        flash = {
          text: /not batter|not pitcher/.test(reason)
            ? "今の役割では操作できません"
            : /phase/.test(reason)
              ? "今は振るタイミングではありません"
              : reason,
          until: performance.now() + 1500,
        };
      },
      onError: (reason) => {
        netStatus = `error: ${reason}`;
      },
    },
  );
}

// ---- pose ----
const fieldInv = new THREE.Matrix4();
const poseMatrix = new THREE.Matrix4();
const posePos = new THREE.Vector3();
const poseQuat = new THREE.Quaternion();
const poseScale = new THREE.Vector3();
let lastSendMs = -Infinity;
function sendPose(now: number) {
  if (
    !client ||
    !markerAnchor?.everDetected ||
    now - lastSendMs < SEND_INTERVAL_MS
  ) {
    return;
  }
  lastSendMs = now;
  fieldInv.copy(field.matrixWorld).invert();
  poseMatrix.multiplyMatrices(fieldInv, camera.matrixWorld);
  poseMatrix.decompose(posePos, poseQuat, poseScale);
  const pose: PlayerPose = {
    pos: [round3(posePos.x), round3(posePos.y), round3(posePos.z)],
    quat: [poseQuat.x, poseQuat.y, poseQuat.z, poseQuat.w],
    tracking: markerAnchor.isTracking(now, MARKER_LOST_MS),
  };
  if (client.sendPose(pose)) posesSent++;
}

// ---- fallback input: 長押しで投球 / スイング ----
let holdStart = -1;
let charge = 0;
function canAct() {
  return joined && anchor.visible && posesSent > 0 && auth !== null;
}
function beginAction() {
  if (
    !document.body.classList.contains("started") ||
    holdStart >= 0 ||
    !canAct()
  ) {
    return;
  }
  holdStart = performance.now();
  charge = 0;
}
function endAction() {
  if (holdStart < 0 || !auth || !client) return;
  const now = performance.now();
  charge = Math.min(1, (now - holdStart) / (CHARGE_SEC * 1000));
  holdStart = -1;
  const role = playerRole();
  let sent = false;
  if (role === "batter" && auth.state.phase === "pitching") {
    const speed =
      cfg.minSwingSpeed +
      (cfg.maxSwingSpeed * 0.65 - cfg.minSwingSpeed) * charge;
    sent = client.sendSwing(round3(speed), 0);
  } else if (role === "pitcher" && auth.state.phase === "waitingPitch") {
    const speed =
      cfg.minPitchSpeed +
      (cfg.maxPitchSpeed - cfg.minPitchSpeed) * charge;
    sent = client.sendPitch("fastball", round3(speed));
  }
  if (sent) actionsSent++;
  charge = 0;
}
if (touch) {
  const app = document.querySelector<HTMLDivElement>("#app")!;
  app.addEventListener("contextmenu", (event) => event.preventDefault());
  app.addEventListener("pointerdown", beginAction);
  addEventListener("pointerup", endAction);
  addEventListener("pointercancel", () => {
    holdStart = -1;
    charge = 0;
  });
} else {
  addEventListener("keydown", (event) => {
    if (event.code === "Space" && !event.repeat) {
      event.preventDefault();
      beginAction();
    }
  });
  addEventListener("keyup", (event) => {
    if (event.code === "Space") endAction();
  });
}
addEventListener("blur", () => {
  holdStart = -1;
  charge = 0;
});

function updateFallback(now: number) {
  if (holdStart >= 0) {
    charge = Math.min(1, (now - holdStart) / (CHARGE_SEC * 1000));
  }
}

/** ヘッドレス確認用。投手は待機中に投げ、打者はボールがベースへ来る時刻に振る。 */
function updateFakeAction(now: number) {
  if (FAKE_ACTION_SEC === null || !auth || !client || !canAct()) return;
  const state = auth.state;
  const role = playerRole();
  if (
    role === "pitcher" &&
    state.phase === "waitingPitch" &&
    fakeHandledWaitSeq !== state.seq &&
    now - auth.recvMs >= FAKE_ACTION_SEC * 1000
  ) {
    fakeHandledWaitSeq = state.seq;
    if (client.sendPitch("curve", 5.5)) actionsSent++;
  }
  if (
    role === "batter" &&
    state.phase === "pitching" &&
    state.pitch &&
    fakeHandledPitch !== state.pitch.seq
  ) {
    const startLocal = localTimeOf(state.pitch.startedAt, state.t, auth.recvMs);
    if (now >= startLocal + state.pitch.duration * 1000) {
      fakeHandledPitch = state.pitch.seq;
      if (client.sendSwing(8, 0)) actionsSent++;
    }
  }
}

// ---- render state / messages ----
function updateField(now: number) {
  const state = auth?.state;
  let ball: V3 | null = null;
  let color = 0xffffff;
  if (state?.phase === "hit" && liveHit) {
    ball = hitAt(liveHit.result, (now - liveHit.startLocalMs) / 1000);
    color = 0xfdd663;
  } else if (state?.pitch && livePitch && state.phase === "pitching") {
    ball = pitchAt(
      livePitch.result,
      (now - livePitch.startLocalMs) / 1000,
    );
  }
  fieldView.setBall(ball, color);
  const batterMotion = state?.batterId
    ? motions.get(state.batterId)
    : undefined;
  const pitcherMotion = state?.pitcherId
    ? motions.get(state.pitcherId)
    : undefined;
  fieldView.setBat(
    batterMotion &&
      batterMotion.kind === "bat" &&
      now - batterMotion.at < 1000
      ? batterMotion.angleDeg
      : state?.phase === "pitching"
        ? 0
        : null,
  );
  fieldView.setPitcher(
    pitcherMotion &&
      pitcherMotion.kind === "pitch" &&
      now - pitcherMotion.at < 1000
      ? pitcherMotion.angleDeg
      : state?.phase === "waitingPitch" && state.mode === "duel"
        ? 0
        : null,
  );
}

function updateMessages(now: number) {
  const state = auth?.state;
  if (state) {
    scorePanel.set(
      [
        state.mode === "free"
          ? "フリーバッティング"
          : "2人対戦",
        `投球 ${state.stats.pitches}　安打 ${state.stats.hits}　空振り ${state.stats.misses}`,
        state.lastResult
          ? `${PITCH_LABELS[state.lastResult.pitchType]} ${Math.round(state.lastResult.pitchSpeed * 3.6)}km/h · ${state.lastResult.label}${state.lastResult.distance !== null ? ` ${state.lastResult.distance.toFixed(1)}m` : ""}`
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
      "#e8eaed",
      "left",
    );
  }
  let text = "";
  let color = "#e8eaed";
  if (netStatus.startsWith("error")) {
    text = `接続できません\n${netStatus.slice(7)}`;
    color = "#f28b82";
  } else if (cameraError) {
    text = `カメラを開けません\n${cameraError}`;
    color = "#f28b82";
  } else if (!passthrough) {
    text = "カメラを起動中…";
  } else if (!markerAnchor?.everDetected) {
    text = "壁のマーカーを見てください";
    color = "#fdd663";
  } else if (!joined || !state) {
    text = `サーバーに接続中… (${netStatus})`;
  } else if (flash && now < flash.until) {
    text = flash.text;
    color = flash.text.includes("ヒット") || flash.text.includes("ホームラン")
      ? "#81c995"
      : "#e8eaed";
  } else {
    const role = playerRole();
    if (role === "batter") {
      text =
        state.phase === "waitingPitch"
          ? state.mode === "free"
            ? "打者：bot の投球を待っています"
            : `${nameOf(state.pitcherId ?? "")} の投球を待っています`
          : state.phase === "pitching"
            ? "打者：ボールを見て Joy-Con を振る！\n（無いときは画面長押し→離す）"
            : state.lastResult?.label ?? "次の球を待っています";
    } else {
      text =
        state.phase === "waitingPitch"
          ? "投手：方向ボタンを押しながら Joy-Con を振る\n↑直球 →カーブ ←スライダー ↓フォーク"
          : "投手：打者の結果を待っています";
    }
  }
  messagePanel.set(text, color);
  chargePanel.set(
    holdStart >= 0
      ? `${playerRole() === "pitcher" ? "投球" : "スイング"} ${"■".repeat(Math.round(charge * 10))}${"□".repeat(10 - Math.round(charge * 10))}`
      : "",
    "#fdd663",
  );
}

// ---- controls / HUD / start flow ----
type HeadControls = { update: () => void };
let controls: HeadControls | null = null;
function startControls() {
  if (touch) controls = new DeviceOrientationControls(camera);
  else {
    const orbit = new OrbitControls(camera, renderer.domElement);
    orbit.target.set(0, -0.2, 1.2);
    orbit.enablePan = false;
    orbit.rotateSpeed = -0.5;
    controls = orbit;
  }
}
const hud = document.querySelector<HTMLDivElement>("#hud")!;
const hudState = { base: "", sensor: "", cam: "", fs: "", wake: "" };
function renderHud(now: number) {
  const state = auth?.state;
  const text = [
    hudState.base,
    hudState.sensor && `sensor=${hudState.sensor}`,
    hudState.cam && `cam=${hudState.cam}`,
    hudState.fs && `fs=${hudState.fs}`,
    hudState.wake && `wake=${hudState.wake}`,
    `marker=${markerAnchor?.info ?? "-"} room=${ROOM ?? "(invalid)"} me=${selfId || "-"} ws=${netStatus} role=${playerRole() ?? "-"} poses=${posesSent} actions=${actionsSent}`,
    state &&
      `game: mode=${state.mode} phase=${state.phase} players=${state.players.map((p) => `${p.id}:${p.role}`).join(",")} batter=${state.batterId ?? "-"} pitcher=${state.pitcherId ?? "bot"} pitch=${state.pitch ? `#${state.pitch.seq}:${state.pitch.type}:${state.pitch.speed.toFixed(1)}` : "-"} stats=${state.stats.pitches}/${state.stats.swings}/${state.stats.hits}/${state.stats.misses} hit=${state.hit ? `#${state.hit.seq}:${state.hit.distance.toFixed(1)}m` : "-"} seq=${state.seq}${lastRejectReason ? ` reject=${lastRejectReason}` : ""}`,
  ]
    .filter(Boolean)
    .join("\n");
  if (text !== lastHudText) {
    lastHudText = text;
    hud.textContent = text;
  }
  fieldView.setTracking(
    markerAnchor?.isTracking(now, MARKER_LOST_MS) ?? false,
  );
}

const fsButton = document.querySelector<HTMLButtonElement>("#fs-button")!;
const tryFullscreen = setupFullscreen({
  button: fsButton,
  touch,
  onResult: (status) => {
    hudState.fs = status;
  },
  onChange: (change) => {
    hudState.fs = change;
  },
  isStarted: () => document.body.classList.contains("started"),
});
const nameForm = document.querySelector<HTMLFormElement>("#name-form")!;
const startButton = document.querySelector<HTMLButtonElement>("#start-button")!;
const roomError = document.querySelector<HTMLParagraphElement>("#room-error")!;
const readName = setupPlayerNameField({
  input: document.querySelector<HTMLInputElement>("#player-name")!,
  error: document.querySelector<HTMLParagraphElement>("#name-error")!,
  maxLength: NAME_MAX_LENGTH,
});
nameForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (ROOM === null) {
    roomError.hidden = false;
    roomError.textContent = `room 名「${roomRaw}」は使えません`;
    return;
  }
  const name = readName();
  if (name === null) return;
  document.body.classList.add("started");
  hudState.base = `fov=${FOV_FIXED ?? "auto"} markerMm=${MARKER_MM} detW=${MARKER_DET_W}`;
  connect(name);
  runStartFlow(touch, {
    onSensor: (status) => {
      hudState.sensor = status;
    },
    startControls,
    startCamera: async () => {
      hudState.cam = "requesting";
      try {
        await startCamera((step) => {
          hudState.cam = step;
        });
        hudState.cam = passthrough!.summary;
      } catch (error: unknown) {
        cameraError =
          error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        hudState.cam = cameraError;
      }
    },
    tryEnterFullscreen: tryFullscreen,
    onWakeLock: (status) => {
      hudState.wake = status;
    },
  });
});
addEventListener("pagehide", () => client?.dispose());
if (params.has("autostart")) startButton.click();

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
  if (markerAnchor?.everDetected) anchor.visible = true;
  anchor.updateMatrixWorld(true);
  updateFallback(now);
  updateFakeAction(now);
  updatePeers(now);
  updateField(now);
  updateMessages(now);
  sendPose(now);
  if (document.body.classList.contains("started")) renderHud(now);
  effect.render(scene, camera);
});

function round3(v: number) {
  return Math.round(v * 1000) / 1000;
}
