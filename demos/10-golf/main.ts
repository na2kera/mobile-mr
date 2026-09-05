import * as THREE from "three";
import { StereoEffect } from "three/examples/jsm/effects/StereoEffect.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { DeviceOrientationControls } from "three-stdlib";
import { numParam, params, resolutionParam } from "../../src/shared/url-params";
import { CAM_FOV_WIDE, createFakeCameraStream, drawCheckerboard, startPassthrough } from "../../src/shared/passthrough-camera";
import type { Passthrough } from "../../src/shared/passthrough-camera";
import { isTouchDevice, runStartFlow, setupFullscreen } from "../../src/shared/start-flow";
import { setupPlayerNameField } from "../../src/shared/player-name";
import { createMarkerAnchor } from "../../src/shared/marker-anchor";
import type { ExtraMarker, MarkerAnchor } from "../../src/shared/marker-anchor";
import { markerBits } from "../../src/shared/marker-detector";
import { FACE_LABELS, MARKER_FACES, describeMarkers, markerToFieldMatrix } from "../../src/shared/marker-layout";
import type { MarkerFace, MarkerPlacement } from "../../src/shared/marker-layout";
import { drawProjectedMarkers, fakeCameraToField, parseFakeMarkersParam, projectFakeMarkers } from "../../src/shared/fake-markers";
import type { FakeMarker } from "../../src/shared/fake-markers";
import { TextPanel } from "../../src/shared/text-panel";
import { ROOM_ID_PATTERN } from "../../src/shared/shared-room-protocol";
import { BALL_R, CUP_R, DEFAULT_GOLF, playerColorHex, playerColorName, rollAt, simulateRoll, speedForDistance } from "../../src/shared/golf-sim";
import type { GolfConfig, RollResult, V2, V3 } from "../../src/shared/golf-sim";
import type { GameSnapshot } from "../../src/shared/golf-game";
import { NAME_MAX_LENGTH } from "../../src/shared/golf-protocol";
import type { PlayerPose } from "../../src/shared/golf-protocol";
import { connectGame } from "./game-client";
import type { GameClient } from "./game-client";
import { CourseView } from "./course-view";

// Phase 10: MR パターゴルフ。08 の箱型コート（壁のマーカー + 床）をグリーンにして、Joy-Con をパターにする統合ゲーム第 4 弾。
//   - コート: 08 と同じ field 座標系（正面の壁のマーカーが原点、床 = Y=-floorDrop）。床がグリーン、四方の壁はクッション。
//     マルチマーカー（床のマーカー）は下を向いてパットするこのゲームでは実質必須（正面のマーカーが視界から外れる）
//   - 打ち方: ホール（か狙いたい場所）を見て「構え」（画面タップ / Joy-Con の A）→ 狙い線が固定される。
//     構えなければ狙いはカップの方向。振りは PC の俯瞰画面に繋いだ Joy-Con（振りの速さと面の開きを検出して 1 打として届く）。
//     Joy-Con が無いときの保険: 画面長押しで溜めて離す（PC は Space）。溜めた量で速さ
//   - 見た目: Joy-Con の位置は取れないので、パターはボールの真上を支点にした振り子として描き、角度だけ Joy-Con に追従する
//   - 共有: サーバー権威（server/golf.ts）。1 打の向きと速さから転がり（golf-sim.ts の simulateRoll）を計算して終点を決め、
//     全員の端末が同じ式で転がりを描く。参加順に 1 打ずつ交代、3 ホールの合計打数で勝負
//   - 手トラッキングは使わない（08 より軽い）

// ---- パラメータ（06〜08 と同じもの。根拠は 06 の main.ts 参照） ----
const fovRaw = params.get("fov");
const FOV_FIXED: number | null = fovRaw === null || fovRaw === "auto" ? null : numParam("fov", 94, { min: 20, max: 170 });
const EYE_SEP = numParam("eyeSep", 0.064, { min: 0, max: 0.2 });
const CAM_ZOOM = numParam("camZoom", 0.7, { min: 0.2, max: 5 });
const CAM_RES = resolutionParam("camRes", [1280, 720]);

const MARKER_MM = numParam("markerMm", 100, { max: 5000 });
const MARKER_SIZE_M = MARKER_MM / 1000;
const MARKER_ID = Math.round(numParam("markerId", 0, { min: 0, max: 999 }));
const MAX_POSE_ERROR = numParam("maxPoseError", 0.5, { min: 0, max: 100 });
const MARKER_DET_W = numParam("detW", 960, { min: 64, max: 4096 });
const MARKER_SMOOTH = numParam("smooth", 0.5, { min: 0.01, max: 1 });
const MARKER_INTERVAL_MS = numParam("markerIntervalMs", 66, { min: 0, max: 2000 });
const MARKER_LOST_MS = numParam("lostMs", 500, { min: 50, max: 10000 });

// Room / 通信
const roomRaw = params.get("room");
const ROOM = roomRaw === null ? "demo" : ROOM_ID_PATTERN.test(roomRaw) ? roomRaw : null;
const SEND_INTERVAL_MS = 1000 / numParam("sendHz", 15, { min: 1, max: 60 });
const PEER_STALE_MS = numParam("peerStaleMs", 2000, { min: 200, max: 30000 });
const PEER_SMOOTH = numParam("peerSmooth", 0.3, { min: 0.01, max: 1 });

// 溜め打ち（Joy-Con が無いときの保険）
/** 長押しを「溜め」とみなすまで [ms]（それより短ければタップ = 構え） */
const HOLD_MS = 250;
/** 満タンまでの時間 [s] */
const CHARGE_SEC = numParam("chargeSec", 1.5, { min: 0.2, max: 10 });
/** 満タンの速さ [m/s] */
const STROKE_MAX = numParam("strokeMax", 3, { min: 0.2, max: 10 });
/** 振り子パターの長さ（支点からヘッドまで）[m]。俯瞰画面の armM と合わせると見た目と速さが揃う */
const ARM_M = numParam("armM", 0.9, { min: 0.3, max: 2 });
/** Joy-Con の振り角が届かなくなってから、溜め表示に戻すまで [ms] */
const PUTTER_STALE_MS = 1000;

// デバッグ
const FAKE_CAM = params.has("fakecam");
const FAKE_SHIFT = numParam("fakeShift", 0, { min: -200, max: 200 });
const FAKE_SHIFT_Y = numParam("fakeShiftY", 0, { min: -240, max: 240 });
const FAKE_MARKER_PX = numParam("fakeMarkerPx", 80, { min: 30, max: 400 });
const FAKE_MARKERS = parseFakeMarkersParam(params.get("fakeMarkers"));
const FAKE_CAM_POS = (params.get("fakeCamPos") ?? "").split(",").map(Number);
const FAKE_YAW = numParam("fakeYaw", 0, { min: -180, max: 180 });
const FAKE_PITCH = numParam("fakePitch", 0, { min: -90, max: 90 });
const FAKE_HIDE_ORIGIN = params.get("fakeHideOrigin") === "1";
/** 自分の手番になったら自動で（カップに届く速さで）打つ（PC / ヘッドレス確認用）。値は手番からの待ち [s] */
const FAKE_STROKE_SEC = params.has("fakeStroke") ? numParam("fakeStroke", 1.5, { min: 0.1, max: 60 }) : null;
/** 自動で打つときのフェイスの開き [deg]（外す様子の確認用） */
const FAKE_STROKE_FACE = numParam("fakeStrokeFace", 0, { min: -90, max: 90 });

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

// ---- アンカー（マーカー座標系 = field 座標系）----
const anchor = new THREE.Group();
anchor.visible = false;
scene.add(anchor);
const field = anchor;

// マーカーの枠（08 と同じ: 原点 + 追加。見えているものは青、それ以外は灰、ロスト中は赤）
type MarkerFrame = { id: number; mesh: THREE.Mesh; material: THREE.MeshBasicMaterial; label: TextPanel | null };
const markerFrameGeometry = new THREE.PlaneGeometry(MARKER_SIZE_M, MARKER_SIZE_M);
function createMarkerFrame(id: number, labelText: string | null): MarkerFrame {
  const material = new THREE.MeshBasicMaterial({ color: 0x8ab4f8, transparent: true, opacity: 0.4, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(markerFrameGeometry, material);
  let label: TextPanel | null = null;
  if (labelText !== null) {
    label = new TextPanel(MARKER_SIZE_M * 1.6, MARKER_SIZE_M * 0.5, 256, 6);
    label.mesh.position.set(0, MARKER_SIZE_M * 0.85, 0.005);
    label.set(labelText, "#e8eaed");
    mesh.add(label.mesh);
  }
  return { id, mesh, material, label };
}
const originFrame = createMarkerFrame(MARKER_ID, null);
anchor.add(originFrame.mesh);
let extraFrames: MarkerFrame[] = [];
let extraMarkers: ExtraMarker[] = [];
let markerLayoutKey = "";
function applyMarkerLayout(markers: MarkerPlacement[]): boolean {
  const key = JSON.stringify(markers);
  if (key === markerLayoutKey) return false;
  markerLayoutKey = key;
  for (const f of extraFrames) {
    f.mesh.removeFromParent();
    f.material.dispose();
    f.label?.mesh.material.map?.dispose();
    f.label?.mesh.material.dispose();
    f.label?.mesh.geometry.dispose();
  }
  extraFrames = [];
  extraMarkers = [];
  for (const m of markers) {
    const toAnchor = new THREE.Matrix4().fromArray(markerToFieldMatrix(m));
    extraMarkers.push({ id: m.id, toAnchor });
    const frame = createMarkerFrame(m.id, `${FACE_LABELS[m.face]} ${m.id}`);
    frame.mesh.matrixAutoUpdate = false;
    frame.mesh.matrix.copy(toAnchor);
    anchor.add(frame.mesh);
    extraFrames.push(frame);
  }
  return true;
}

// ---- コート（グリーン・壁・カップ・ボール・狙い線・パター）----
let cfg: GolfConfig = { ...DEFAULT_GOLF };
const course = new CourseView({ armM: ARM_M, ballDetail: 20 });
field.add(course.group);
course.build(cfg);
/** サーバーの config を取り込む。コートの形に効く値が変わっていたら作り直す。追加マーカーの配置も反映する */
function applyConfig(next: GolfConfig): boolean {
  const changed = next.wallW !== cfg.wallW || next.wallH !== cfg.wallH || next.floorDepth !== cfg.floorDepth || next.floorDrop !== cfg.floorDrop;
  cfg = next;
  if (changed) course.build(cfg);
  applyMarkerLayout(cfg.markers ?? []);
  return changed;
}

// スコアボード: 壁の上端。視界内メッセージ: カメラの子
const scorePanel = new TextPanel(1.5, 0.4);
field.add(scorePanel.mesh);
const message = new TextPanel(0.9, 0.24);
message.mesh.position.set(0, -0.28, -1.2);
camera.add(message.mesh);
/** 溜めのゲージ（視界の下） */
const chargePanel = new TextPanel(0.6, 0.1, 512, 8);
chargePanel.mesh.position.set(0, -0.42, -1.2);
camera.add(chargePanel.mesh);

// ---- ピア（他のプレイヤー）: 頭だけ（手トラッキングは使わない）----
type Peer = { group: THREE.Group; materials: THREE.MeshStandardMaterial[]; targetPos: THREE.Vector3; targetQuat: THREE.Quaternion; lastPoseMs: number; tracking: boolean };
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
  const peer: Peer = { group, materials: [headMat, noseMat], targetPos: new THREE.Vector3(), targetQuat: new THREE.Quaternion(), lastPoseMs: -Infinity, tracking: false };
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
function onPeerPose(id: string, pose: PlayerPose) {
  const peer = peers.get(id) ?? createPeer(id);
  peer.targetPos.set(...pose.pos);
  peer.targetQuat.set(...pose.quat);
  peer.tracking = pose.tracking;
  const now = performance.now();
  if (now - peer.lastPoseMs > PEER_STALE_MS) {
    peer.group.position.copy(peer.targetPos);
    peer.group.quaternion.copy(peer.targetQuat);
  }
  peer.lastPoseMs = now;
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
    if (stale) continue;
    peer.group.position.lerp(peer.targetPos, alpha);
    peer.group.quaternion.slerp(peer.targetQuat, alpha);
    const opacity = peer.tracking ? 1 : 0.3;
    for (const m of peer.materials) m.opacity = opacity;
    peer.materials[0].color.setHex(colorHexOf(id));
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

// ---- パススルー（PC デバッグ用フェイクカメラ。08 と同じ 3D 版）----
const FAKE_CAM_W = 640;
const FAKE_CAM_H = 480;
const FAKE_FOCAL_PX = FAKE_CAM_W / 2 / Math.tan(THREE.MathUtils.degToRad(params.has("camFov") ? numParam("camFov", CAM_FOV_WIDE, { min: 10, max: 170 }) : CAM_FOV_WIDE) / 2);
const fakeHidden = new Set<number>(FAKE_HIDE_ORIGIN ? [MARKER_ID] : []);
if (FAKE_CAM) (window as unknown as { __fakeMarkers: unknown }).__fakeMarkers = { hidden: fakeHidden };
function fakeWorld(): { markers: FakeMarker[]; camToField: number[] } {
  const markers: FakeMarker[] = [{ id: MARKER_ID, bits: markerBits(MARKER_ID), toField: markerToFieldMatrix({ id: MARKER_ID, face: "wall", pos: [0, 0, 0] }) }];
  for (const m of FAKE_MARKERS) {
    if (m.id === MARKER_ID || !(MARKER_FACES as readonly string[]).includes(m.face)) continue;
    markers.push({ id: m.id, bits: markerBits(m.id), toField: markerToFieldMatrix({ id: m.id, face: m.face as MarkerFace, pos: m.pos }) });
  }
  let pos: V3;
  if (FAKE_CAM_POS.length === 3 && FAKE_CAM_POS.every(Number.isFinite)) {
    pos = [FAKE_CAM_POS[0], FAKE_CAM_POS[1], FAKE_CAM_POS[2]];
  } else {
    const d = (MARKER_SIZE_M * FAKE_FOCAL_PX) / (0.8 * FAKE_MARKER_PX);
    pos = [(-FAKE_SHIFT * d) / FAKE_FOCAL_PX, (FAKE_SHIFT_Y * d) / FAKE_FOCAL_PX, d];
  }
  return { markers, camToField: fakeCameraToField(pos, FAKE_YAW, FAKE_PITCH) };
}
function fakeStream(): MediaStream {
  const world = fakeWorld();
  return createFakeCameraStream(
    (ctx, canvas, frame) => {
      drawCheckerboard(ctx, canvas, frame);
      const visible = world.markers.filter((m) => !fakeHidden.has(m.id));
      drawProjectedMarkers(ctx, projectFakeMarkers(visible, world.camToField, FAKE_FOCAL_PX, canvas.width, canvas.height, MARKER_SIZE_M));
    },
    { width: FAKE_CAM_W, height: FAKE_CAM_H },
  );
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
    extraMarkers: () => extraMarkers,
    maxPoseError: MAX_POSE_ERROR,
    detW: MARKER_DET_W,
    smooth: MARKER_SMOOTH,
    minIntervalMs: MARKER_INTERVAL_MS,
    camHFovDeg: () => pt.camHFovDeg,
    resnapAfterMs: 2000,
    snapDistanceM: 0.3,
  });
}

// ---- ゲームの状態（サーバー権威）----
let selfId = "";
let netStatus = "idle";
let client: GameClient | null = null;
let joined = false;
let auth: { state: GameSnapshot; recvMs: number } | null = null;
let cameraError = "";
let strokesSent = 0;
let strokesAccepted = 0;
let addressesSent = 0;
let lastRejectReason = "";
let flash: { text: string; untilMs: number } | null = null;
let lastEventKey = "";
/** いま描いている転がり（サーバーの roll と同じ式で計算） */
let liveRoll: { seq: number; by: string; result: RollResult; startLocalMs: number; holedShown: boolean } | null = null;
/** 自分の手番が始まった時刻（自動打ちの待ちに使う） */
let myTurnSinceMs = -1;
/** 誰かのパターの振り角（Joy-Con のハブから）。自分の分は振り子に、他人の分もその人の振り子に */
const putters = new Map<string, { angleDeg: number; dps: number; atMs: number }>();

function colorOf(id: string): number | null {
  return auth?.state.players.find((p) => p.id === id)?.color ?? null;
}
function colorHexOf(id: string): number {
  const c = colorOf(id);
  return c ? playerColorHex(c) : 0xe8eaed;
}
function nameOf(id: string): string {
  return auth?.state.players.find((p) => p.id === id)?.name ?? id;
}
function localTimeOf(serverT: number, refServerT: number, refLocalMs: number): number {
  return refLocalMs + (serverT - refServerT);
}
function isMyTurn(): boolean {
  return joined && auth?.state.phase === "aim" && auth.state.turn === selfId;
}

function onState(state: GameSnapshot) {
  const now = performance.now();
  const prevTurn = auth?.state.turn;
  auth = { state, recvMs: now };
  if (state.turn === selfId && prevTurn !== selfId) myTurnSinceMs = now;
  const ev = state.event;
  const key = ev ? `${state.seq}:${ev.kind}` : "";
  if (key && key !== lastEventKey) {
    lastEventKey = key;
    if (ev?.kind === "turn") {
      flash = ev.playerId === selfId ? { text: "あなたの番！\n狙いを見てタップ（構え）→ 振る", untilMs: now + 3000 } : { text: `${nameOf(ev.playerId)} の番`, untilMs: now + 2000 };
    } else if (ev?.kind === "hole") {
      flash = { text: `ホール ${ev.hole + 1} へ`, untilMs: now + 2500 };
    } else if (ev?.kind === "timeout") {
      flash = { text: `${nameOf(ev.by)} は時間切れ`, untilMs: now + 2500 };
    } else if (ev?.kind === "restart") {
      flash = { text: "最初から（ホール 1）", untilMs: now + 2500 };
    } else if (ev?.kind === "field" || ev?.kind === "rules") {
      flash = { text: ev.kind === "field" ? `コートが変わりました\n幅 ${cfg.wallW}m × 奥行き ${cfg.floorDepth}m` : `ルールが変わりました\n${cfg.holes} ホール・${cfg.maxStrokes} 打まで`, untilMs: now + 3000 };
    } else if (ev?.kind === "result") {
      const text = ev.winners.length === 0 ? "だれもいません…" : ev.winners.includes(selfId) ? "あなたの勝ち！" : `${ev.winnerNames.join("・")} の勝ち！`;
      flash = { text, untilMs: now + 5000 };
    }
    console.log(`[game] event ${ev?.kind} phase=${state.phase} hole=${state.hole} turn=${state.turn} balls=${JSON.stringify(state.balls)}`);
  }
  // 転がり: 新しい roll なら同じ式で計算して描き始める
  const roll = state.roll;
  if (roll && roll.seq !== liveRoll?.seq) {
    const cup = state.holes[state.hole]?.cup ?? [0, 0];
    const result = simulateRoll(roll.from, roll.vel, cup, cfg);
    liveRoll = { seq: roll.seq, by: roll.by, result, startLocalMs: localTimeOf(roll.startedAt, state.t, now), holedShown: false };
    if (roll.by === selfId) strokesAccepted++;
    if (Math.abs(result.end[0] - roll.end[0]) > 0.01 || Math.abs(result.end[1] - roll.end[1]) > 0.01) {
      console.warn(`[game] roll end mismatch: local=(${result.end.join(",")}) server=(${roll.end.join(",")})`);
    }
  }
  if (!roll) liveRoll = null;
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
      onError: (reason) => {
        netStatus = `error: ${reason}`;
        console.warn(`[game] rejected: ${reason}`);
      },
      onWelcome: (id, _role, peerIds, config, state) => {
        selfId = id;
        netStatus = "open";
        joined = true;
        posesSent = 0;
        applyConfig(config);
        [...peers.keys()].forEach(removePeer);
        peerIds.forEach(createPeer);
        lastEventKey = "";
        liveRoll = null;
        onState(state);
        console.log(`[game] joined "${ROOM}" as ${id} color=${colorOf(id)} (peers: ${peerIds.join(", ") || "none"})`);
      },
      onPeerJoin: (id) => {
        createPeer(id);
        console.log(`[game] peer ${id} joined`);
      },
      onPeerLeave: (id) => {
        removePeer(id);
        putters.delete(id);
        console.log(`[game] peer ${id} left`);
      },
      onPeerPose,
      onState,
      onPutter: (id, angleDeg, dps) => {
        putters.set(id, { angleDeg, dps, atMs: performance.now() });
      },
      onRejected: (reason) => {
        lastRejectReason = reason;
        if (/gaze/.test(reason)) flash = { text: "グリーンを見て構えてください", untilMs: performance.now() + 2000 };
        else if (/not your turn/.test(reason)) flash = { text: "まだあなたの番ではありません", untilMs: performance.now() + 2000 };
        console.log(`[game] rejected by server: ${reason}`);
      },
      onConfig: (config, state) => {
        applyConfig(config);
        liveRoll = null;
        onState(state);
        console.log(`[game] config ${config.wallW}x${config.wallH}x${config.floorDepth}/${config.floorDrop} decel=${config.decel} holes=${config.holes}`);
      },
      onMarkers: (config) => {
        applyConfig(config);
        const names = config.markers.map((m) => `${FACE_LABELS[m.face]} ${m.id}`).join("・");
        flash = { text: config.markers.length === 0 ? "追加マーカーが無くなりました" : `マーカーの配置が変わりました\n${names}`, untilMs: performance.now() + 3000 };
      },
    },
  );
}

// ---- 視線と床の交点（構えの狙い）----
const fieldInv = new THREE.Matrix4();
const poseMatrix = new THREE.Matrix4();
const posePos = new THREE.Vector3();
const poseQuat = new THREE.Quaternion();
const poseScale = new THREE.Vector3();
const gazeOrigin = new THREE.Vector3();
const gazeDir = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();
/** 視線が床に当たっている点（field 座標系の床 [x, z]）。当たっていなければ null */
let gaze: V2 | null = null;
function updateGaze() {
  gaze = null;
  if (!anchor.visible) return;
  fieldInv.copy(field.matrixWorld).invert();
  camera.getWorldPosition(gazeOrigin).applyMatrix4(fieldInv);
  gazeDir.set(0, 0, -1).applyQuaternion(camera.getWorldQuaternion(tmpQuat));
  field.getWorldQuaternion(tmpQuat).invert();
  gazeDir.applyQuaternion(tmpQuat);
  const floorY = -cfg.floorDrop;
  if (gazeDir.y >= -1e-4) return;
  const t = (floorY - gazeOrigin.y) / gazeDir.y;
  if (t <= 0) return;
  const x = gazeOrigin.x + gazeDir.x * t;
  const z = gazeOrigin.z + gazeDir.z * t;
  if (Math.abs(x) > cfg.wallW / 2 || z < 0 || z > cfg.floorDepth) return;
  gaze = [round3(x), round3(z)];
}

let lastSendMs = -Infinity;
let posesSent = 0;
let lastSelfPos: V3 | null = null;
function sendPoseIfDue(now: number) {
  if (!client || !markerAnchor?.everDetected) return;
  if (now - lastSendMs < SEND_INTERVAL_MS) return;
  lastSendMs = now;
  fieldInv.copy(field.matrixWorld).invert();
  poseMatrix.multiplyMatrices(fieldInv, camera.matrixWorld);
  poseMatrix.decompose(posePos, poseQuat, poseScale);
  const tracking = markerAnchor.isTracking(now, MARKER_LOST_MS);
  const pose: PlayerPose = {
    pos: [round3(posePos.x), round3(posePos.y), round3(posePos.z)],
    quat: [poseQuat.x, poseQuat.y, poseQuat.z, poseQuat.w],
    tracking,
  };
  lastSelfPos = pose.pos;
  if (tracking && markerAnchor.usedIds.length > 0) pose.markerIds = [...markerAnchor.usedIds];
  if (gaze) pose.gaze = gaze;
  if (client.sendPose(pose)) posesSent++;
}
function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

// ---- 入力: タップ = 構え / 長押し = 溜めて離すと 1 打（Joy-Con が無いときの保険。PC は Space、C で狙いを消す）----
let holdStartMs = -1;
let charging = false;
let charge = 0;
function canAct(): boolean {
  return joined && anchor.visible && posesSent > 0;
}
function sendAddress() {
  if (!client || !canAct()) return;
  if (!gaze) {
    flash = { text: "グリーンの狙いたい場所を見てタップ", untilMs: performance.now() + 2000 };
    return;
  }
  if (client.sendAddress(undefined, gaze)) {
    addressesSent++;
    console.log(`[game] address sent target=(${gaze.join(",")})`);
  }
}
function sendStroke(speed: number, faceDeg: number, how: string) {
  if (!client || !canAct()) return;
  if (!isMyTurn()) {
    flash = { text: "まだあなたの番ではありません", untilMs: performance.now() + 2000 };
    return;
  }
  if (client.sendStroke(round3(speed), round3(faceDeg))) {
    strokesSent++;
    console.log(`[game] stroke sent (${how}) speed=${speed.toFixed(2)} face=${faceDeg.toFixed(1)}`);
  }
}
function pressStart() {
  if (!document.body.classList.contains("started") || holdStartMs >= 0) return;
  holdStartMs = performance.now();
  charging = false;
  charge = 0;
}
function pressEnd() {
  if (holdStartMs < 0) return;
  const held = performance.now() - holdStartMs;
  holdStartMs = -1;
  if (!charging) {
    sendAddress();
  } else {
    sendStroke(STROKE_MAX * charge, 0, `hold ${held.toFixed(0)}ms`);
  }
  charging = false;
  charge = 0;
}
function updateCharge(now: number) {
  if (holdStartMs < 0) return;
  const held = now - holdStartMs;
  if (held >= HOLD_MS) {
    charging = true;
    charge = Math.min(1, (held - HOLD_MS) / (CHARGE_SEC * 1000));
  }
}
if (touch) {
  const appEl = document.querySelector<HTMLDivElement>("#app")!;
  appEl.addEventListener("contextmenu", (e) => e.preventDefault());
  appEl.addEventListener("pointerdown", pressStart);
  addEventListener("pointerup", pressEnd);
  addEventListener("pointercancel", () => {
    holdStartMs = -1;
    charging = false;
  });
} else {
  addEventListener("keydown", (e) => {
    if (e.repeat) return;
    if (e.key === " ") {
      e.preventDefault();
      pressStart();
    } else if (e.key.toLowerCase() === "c" && client && canAct()) {
      client.sendClearAim();
    }
  });
  addEventListener("keyup", (e) => {
    if (e.key === " ") pressEnd();
  });
}
addEventListener("blur", () => {
  holdStartMs = -1;
  charging = false;
});

/** 自動で打つ（?fakeStroke=）: 自分の手番になって待ち時間が過ぎたら、カップに届く速さで狙い（無ければカップの方向）へ */
function updateFakeStroke(now: number) {
  if (FAKE_STROKE_SEC === null || !isMyTurn() || !canAct() || !auth) return;
  if (now - myTurnSinceMs < FAKE_STROKE_SEC * 1000) return;
  if (strokesSent > strokesAccepted) return; // 前の 1 打の返事待ち
  const s = auth.state;
  const ball = s.balls[selfId];
  const cup = s.holes[s.hole]?.cup;
  if (!ball || !cup) return;
  const dist = Math.hypot(cup[0] - ball.pos[0], cup[1] - ball.pos[1]);
  const speed = Math.min(cfg.maxStrokeSpeed, speedForDistance(dist, cfg.decel) + 0.15);
  myTurnSinceMs = now; // 拒否されても連打しない
  sendStroke(speed, FAKE_STROKE_FACE, "fake");
}

// ---- 描画の更新 ----
function updateCourse(now: number) {
  const s = auth?.state;
  if (!s) {
    course.setBalls([], now);
    return;
  }
  // ボールの位置: 転がっている本人は転がりの式、それ以外は権威の位置
  const balls: { id: string; pos: V2; color: number; holed: boolean; sunk: boolean }[] = [];
  for (const p of s.players) {
    const b = s.balls[p.id];
    if (!b) continue;
    let pos: V2 = b.pos;
    let sunk = b.holed;
    if (liveRoll && liveRoll.by === p.id) {
      const elapsed = (now - liveRoll.startLocalMs) / 1000;
      if (elapsed < liveRoll.result.duration) {
        pos = rollAt(liveRoll.result, elapsed);
        sunk = false;
      } else if (liveRoll.result.holed && !liveRoll.holedShown) {
        liveRoll.holedShown = true;
        flash = { text: p.id === selfId ? `カップイン！（${b.strokes} 打）` : `${p.name} カップイン！`, untilMs: now + 2500 };
      }
    }
    balls.push({ id: p.id, pos, color: playerColorHex(p.color), holed: b.holed, sunk });
  }
  course.setBalls(balls, now);
  course.setHole(s.holes[s.hole] ?? null, s.hole);
  // 狙い線: 手番の人のボールから。自分の分は構えていれば固定の狙い、無ければカップの方向（サーバーと同じ既定）
  const turnId = s.phase === "aim" ? s.turn : null;
  if (turnId && s.balls[turnId]) {
    const ball = s.balls[turnId];
    const cup = s.holes[s.hole]?.cup ?? [0, 0];
    const aim = s.aims[turnId] ?? normDir([cup[0] - ball.pos[0], cup[1] - ball.pos[1]]);
    course.setAim(ball.pos, aim, s.aims[turnId] !== null, playerColorHex(colorOf(turnId) ?? 1));
    // 振り子パター: Joy-Con の振り角（届いていれば）、自分なら溜め中はバックスイックの角度で
    const pt = putters.get(turnId);
    let angleDeg = 0;
    if (pt && now - pt.atMs < PUTTER_STALE_MS) angleDeg = pt.angleDeg;
    else if (turnId === selfId && charging) angleDeg = 10 + 40 * charge;
    course.setPutter(ball.pos, aim, angleDeg, playerColorHex(colorOf(turnId) ?? 1));
  } else {
    course.setAim(null, null, false, 0);
    course.setPutter(null, null, 0, 0);
  }
  // 視線のカーソル: 自分の番で、まだ構えていない or 構え直したいとき（常に出す。小さいので邪魔にならない）
  course.setGaze(isMyTurn() ? gaze : null);
}
function normDir(v: V2): V2 {
  const l = Math.hypot(v[0], v[1]);
  return l > 0 ? [v[0] / l, v[1] / l] : [0, -1];
}

function remainingSec(now: number): number {
  const s = auth?.state;
  if (!s || !auth) return 0;
  const end = s.phase === "aim" ? s.turnEndsAt : s.phaseEndsAt;
  if (end === null) return 0;
  return Math.max(0, (end - s.t) / 1000 - (now - auth.recvMs) / 1000);
}

function updateMessages(now: number) {
  const s = auth?.state;
  if (s) {
    const lines = [`ホール ${s.hole + 1} / ${s.holes.length}${s.phase === "result" ? "　結果" : ""}`];
    const sorted = [...s.players].sort((a, b) => totalOf(s, a.id) - totalOf(s, b.id));
    for (const p of sorted) {
      const b = s.balls[p.id];
      const cards = s.cards[p.id] ?? [];
      const win = s.winners?.includes(p.id) ? " 🏆" : "";
      const turn = s.turn === p.id ? "▶ " : "　";
      lines.push(`${turn}${p.name}${p.id === selfId ? "（あなた）" : ""} ${cards.join("+")}${cards.length ? "+" : ""}${b?.strokes ?? 0}${b?.holed ? "✓" : ""} = ${totalOf(s, p.id) + (b?.strokes ?? 0)}${win}`);
    }
    scorePanel.set(lines.join("\n"), "#e8eaed", "left");
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
    text = (cfg.markers ?? []).length > 0 ? "マーカーを見てください\n（正面の壁か、床のマーカー）" : "壁のマーカーを見てください";
    color = "#fdd663";
  } else if (netStatus !== "open" && selfId !== "") {
    text = "接続が切れました（再接続中）";
    color = "#f28b82";
  } else if (!joined || !auth) {
    text = netStatus === "open" ? "入室中…" : `サーバーに接続中… (${netStatus})`;
    color = "#fdd663";
  } else if (flash && now < flash.untilMs) {
    text = flash.text;
    color = flash.text.includes("カップイン") || flash.text.includes("勝ち") ? "#81c995" : flash.text.includes("ありません") || flash.text.includes("見て") ? "#fdd663" : "#e8eaed";
  } else {
    const s = auth.state;
    const myColor = colorOf(selfId);
    const me = myColor ? `${playerColorName(myColor)}` : "-";
    if (s.phase === "result") {
      const w = s.winners ?? [];
      const names = s.winnerNames ?? [];
      text = w.length === 0 ? "結果" : w.includes(selfId) ? "あなたの勝ち！" : `${names.join("・")} の勝ち`;
      color = w.includes(selfId) ? "#81c995" : "#e8eaed";
    } else if (s.phase === "rolling") {
      text = liveRoll ? `${liveRoll.by === selfId ? "あなた" : nameOf(liveRoll.by)} のボールが転がっています` : "転がっています";
    } else if (s.phase === "aim" && s.turn === selfId) {
      const b = s.balls[selfId];
      const aimed = s.aims[selfId] !== null;
      text = `あなたの番（${me}・${(b?.strokes ?? 0) + 1} 打目）\n${aimed ? "狙い OK。Joy-Con を振る ／ 長押しで溜めて離す" : "狙いを見てタップ（無ければカップへ）\nJoy-Con を振る ／ 長押しで溜めて離す"}`;
      color = myColor ? `#${playerColorHex(myColor).toString(16).padStart(6, "0")}` : "#e8eaed";
    } else if (s.phase === "aim" && s.turn) {
      text = `${nameOf(s.turn)} の番です\n（あなたは ${me}）`;
    } else {
      text = "プレイヤーを待っています";
    }
  }
  message.set(text, color);
  chargePanel.set(charging ? `溜め ${"■".repeat(Math.round(charge * 10))}${"□".repeat(10 - Math.round(charge * 10))} ${(STROKE_MAX * charge).toFixed(1)} m/s` : "", "#fdd663");
}
function totalOf(s: GameSnapshot, id: string): number {
  return (s.cards[id] ?? []).reduce((a, b) => a + b, 0);
}

// ---- 頭追従 ----
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

// ---- HUD ----
const hud = document.querySelector<HTMLDivElement>("#hud")!;
const hudState = { base: "", sensor: "", cam: "", fsResult: "", fsChange: "", wake: "" };
let lastHudText = "";
function renderHud() {
  const s = auth?.state;
  const now = performance.now();
  const myPutter = putters.get(selfId);
  const text = [
    `${hudState.base} (fov now=${camera.fov.toFixed(1)})`,
    hudState.sensor && `sensor=${hudState.sensor}`,
    hudState.cam && `cam=${hudState.cam}`,
    hudState.fsResult && `fs=${hudState.fsResult}`,
    hudState.fsChange && `fs-change: ${hudState.fsChange}`,
    hudState.wake && `wake=${hudState.wake}`,
    `marker=${markerAnchor?.info ?? "-"}${markerAnchor?.everDetected && !markerAnchor.isTracking(now, MARKER_LOST_MS) ? " (holding last pose)" : ""} layout=${describeMarkers(cfg.markers ?? [])} self=${lastSelfPos ? `(${lastSelfPos.map((v) => v.toFixed(2)).join(",")})` : "-"}`,
    `room=${ROOM ?? "(不正)"} me=${selfId || "-"} peers=${peers.size} ws=${netStatus} field=${cfg.wallW}x${cfg.wallH}x${cfg.floorDepth}/${cfg.floorDrop} gaze=${gaze ? `(${gaze.join(",")})` : "-"} putter=${myPutter && now - myPutter.atMs < PUTTER_STALE_MS ? myPutter.angleDeg.toFixed(1) : "-"} charge=${charging ? charge.toFixed(2) : "-"}`,
    s &&
      `game: phase=${s.phase} hole=${s.hole + 1}/${s.holes.length} turn=${s.turn ?? "-"} left=${remainingSec(now).toFixed(0)}s players=${s.players.map((p) => `${p.id}:${p.color}`).join(",")} balls=${s.players.map((p) => `${p.id}:${s.balls[p.id]?.strokes ?? 0}${s.balls[p.id]?.holed ? "h" : s.balls[p.id]?.done ? "d" : ""}`).join(",")} cards=${s.players.map((p) => `${p.id}:${(s.cards[p.id] ?? []).join("+") || "-"}`).join(",")} strokes=${strokesSent}/${strokesAccepted} addresses=${addressesSent} roll=${s.roll ? `#${s.roll.seq}:${s.roll.by}:${s.roll.holed ? "holed" : "stop"}` : "-"} seq=${s.seq}${lastRejectReason ? ` lastReject=${lastRejectReason}` : ""}`,
  ]
    .filter(Boolean)
    .join("\n");
  if (text !== lastHudText) {
    lastHudText = text;
    hud.textContent = text;
  }
}

// ---- 開始フロー ----
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
  hudState.base = `fov=${FOV_FIXED ?? "auto"} camZoom=${CAM_ZOOM} markerMm=${MARKER_MM} detW=${MARKER_DET_W}@${MARKER_INTERVAL_MS}ms strokeMax=${STROKE_MAX} armM=${ARM_M} mode=${touch ? "gyro" : "orbit"}`;
  connect(name);
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
  if (!e.persisted || !document.body.classList.contains("started")) return;
  const name = readPlayerName();
  if (name !== null) connect(name);
  if (hudState.cam && !hudState.cam.includes("bfcache")) hudState.cam += " (bfcache: カメラ停止の可能性)";
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
  const usedIds = markerAnchor?.usedIds ?? [];
  for (const f of [originFrame, ...extraFrames]) {
    f.material.color.setHex(!tracking ? 0xf28b82 : usedIds.includes(f.id) ? 0x8ab4f8 : 0x9aa0a6);
  }
  course.setTracking(tracking);
  anchor.updateMatrixWorld(true);
  updateGaze();
  updateCharge(now);
  updateFakeStroke(now);
  updatePeers(now);
  updateCourse(now);
  sendPoseIfDue(now);
  updateMessages(now);
  scorePanel.mesh.position.set(0, -cfg.floorDrop + cfg.wallH + 0.25, 0.01);
  if (document.body.classList.contains("started")) renderHud();
  effect.render(scene, camera);
});

export { BALL_R, CUP_R };
