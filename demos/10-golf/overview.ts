import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { numParam, params } from "../../src/shared/url-params";
import { TextPanel } from "../../src/shared/text-panel";
import { ROOM_ID_PATTERN } from "../../src/shared/shared-room-protocol";
import { DEFAULT_GOLF, GOLF_SIZE_CELL_M, GOLF_RULE_KEYS, GOLF_RULE_LIMITS, playerColorCss, playerColorHex, playerColorName, rollAt, simulateRoll, speedForDistance, validateGolfRules } from "../../src/shared/golf-sim";
import type { GolfConfig, GolfRules, RollResult, V2 } from "../../src/shared/golf-sim";
import type { GameSnapshot } from "../../src/shared/golf-game";
import type { PlayerPose } from "../../src/shared/golf-protocol";
import { FACE_LABELS, describeMarkers, markerToFieldMatrix } from "../../src/shared/marker-layout";
import type { MarkerPlacement } from "../../src/shared/marker-layout";
import { createFieldSetupPanel } from "../../src/shared/field-setup-panel";
import { SwingDetector, impactSpeed } from "../../src/shared/swing-detector";
import type { Impact } from "../../src/shared/swing-detector";
import { IMU_SAMPLE_SEC } from "../../src/shared/joycon-report";
import type { StandardReport } from "../../src/shared/joycon-report";
import { connectGame } from "./game-client";
import type { GameClient } from "./game-client";
import { CourseView } from "./course-view";
import { FakeJoyCon, JoyConHub, hidSupported } from "./joycon-hid";
import type { JoyCon } from "./joycon-hid";

// Phase 10: PC の俯瞰画面 + Joy-Con のハブ。08 の俯瞰画面（コート全体・全員の位置・運営の操作）に、
// WebHID で読んだ Joy-Con の振りを「誰の 1 打か」を付けてサーバーへ送る役割を足した。
//   - Joy-Con は 1 台ずつ「手番の人（自動）」「特定のプレイヤー」「使わない」に割り当てる。1 台を回して使うなら自動のまま
//   - 振りの検出は swing-detector.ts（静止で構え → バックスイング → 戻りの 0 通過 = インパクト）。
//     A ボタンで構え（サーバーがその人の視線の交点を狙いにする）、B で狙いを消す（カップの方向に戻す）
//   - 振り角は 20Hz でサーバーへ送り、全員のスマホの振り子パターが追従する
//   - フェイク Joy-Con（?fakeJoycon=1）: 実機が無い PC・ヘッドレス確認用。割り当てた人の手番になると自動で（届く速さで）振る

// ---- パラメータ ----
const roomRaw = params.get("room");
const ROOM = roomRaw === null ? "demo" : ROOM_ID_PATTERN.test(roomRaw) ? roomRaw : null;
const MARKER_MM = numParam("markerMm", 100, { max: 5000 });
const MARKER_ID = Math.round(numParam("markerId", 0, { min: 0, max: 999 }));
const PEER_STALE_MS = numParam("peerStaleMs", 2000, { min: 200, max: 30000 });
const PEER_SMOOTH = numParam("peerSmooth", 0.3, { min: 0.01, max: 1 });
/** 振り子パターの長さ（支点からヘッドまで）[m]。インパクトの角速度 × これ × strokeGain がボールの速さ */
const ARM_M = numParam("armM", 0.9, { min: 0.3, max: 2 });
/** 角速度 → ボールの速さの補正（実機で合わせ込む。実物のパットはヘッドより少し速く飛び出す） */
const STROKE_GAIN = numParam("strokeGain", 1.4, { min: 0.1, max: 10 });
/** 振り検出のしきい値（swing-detector.ts の既定。実機で調整） */
const SWING_OPTS = {
  stillDps: numParam("stillDps", 25, { min: 1, max: 500 }),
  stillMs: numParam("stillMs", 250, { min: 50, max: 5000 }),
  minBackswingDeg: numParam("minBackswing", 6, { min: 1, max: 90 }),
  minImpactDps: numParam("minImpactDps", 20, { min: 1, max: 2000 }),
  maxSwingMs: numParam("maxSwingMs", 3000, { min: 200, max: 20000 }),
  swingStillMs: numParam("swingStillMs", 450, { min: 100, max: 10000 }),
};
/** 振り角を送る間隔 [ms] */
const PUTTER_SEND_MS = 50;
const FAKE_JOYCON = params.has("fakeJoycon");
/** フェイク Joy-Con が手番になってから振るまでの待ち [s] */
const FAKE_SWING_SEC = numParam("fakeSwingSec", 2, { min: 0.2, max: 60 });
/** フェイク Joy-Con のフェイスの開きを作る戻り中のひねり [deg/s]（0 で真っ直ぐ） */
const FAKE_YAW_DPS = numParam("fakeYawDps", 0, { min: -500, max: 500 });

// ---- シーン ----
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a2233);
scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.2));
const dirLight = new THREE.DirectionalLight(0xffffff, 1.5);
dirLight.position.set(3, 10, 2);
scene.add(dirLight);
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.05, 100);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
document.querySelector<HTMLDivElement>("#app")!.appendChild(renderer.domElement);
const controls = new OrbitControls(camera, renderer.domElement);
function resize() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
}
resize();
addEventListener("resize", resize);

// ---- コート（field 座標系 = ワールド）----
const field = new THREE.Group();
scene.add(field);
let cfg: GolfConfig = { ...DEFAULT_GOLF };
const course = new CourseView({ armM: ARM_M, ballDetail: 24 });
field.add(course.group);
const markerFrameGeometry = new THREE.PlaneGeometry(MARKER_MM / 1000, MARKER_MM / 1000);
field.add(new THREE.Mesh(markerFrameGeometry, new THREE.MeshBasicMaterial({ color: 0x8ab4f8, transparent: true, opacity: 0.5, side: THREE.DoubleSide })));
field.add(new THREE.AxesHelper(0.3));
const markerFrames = new THREE.Group();
field.add(markerFrames);
let markerLayoutKey = "";
function applyMarkerLayout(markers: MarkerPlacement[]) {
  const key = JSON.stringify(markers);
  if (key === markerLayoutKey) return;
  markerLayoutKey = key;
  for (const child of [...markerFrames.children]) {
    child.removeFromParent();
    child.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        (o.material as THREE.Material & { map?: THREE.Texture | null }).map?.dispose();
        (o.material as THREE.Material).dispose();
        if (o.geometry !== markerFrameGeometry) o.geometry.dispose();
      }
    });
  }
  for (const m of markers) {
    const mesh = new THREE.Mesh(markerFrameGeometry, new THREE.MeshBasicMaterial({ color: 0xfdd663, transparent: true, opacity: 0.6, side: THREE.DoubleSide }));
    mesh.matrixAutoUpdate = false;
    mesh.matrix.fromArray(markerToFieldMatrix(m));
    const label = new TextPanel(0.3, 0.09, 256, 6);
    label.mesh.position.set(0, (MARKER_MM / 1000) * 0.9, 0.005);
    label.set(`${FACE_LABELS[m.face]} ${m.id}`, "#fdd663");
    mesh.add(label.mesh);
    markerFrames.add(mesh);
  }
}
function fitCamera() {
  const { wallW, wallH, floorDrop, floorDepth } = cfg;
  camera.position.set(wallW * 0.6, -floorDrop + wallH * 0.9, floorDepth + wallW * 0.7);
  controls.target.set(0, -floorDrop, floorDepth / 2);
  controls.update();
}
function applyConfig(next: GolfConfig): boolean {
  const changed = next.wallW !== cfg.wallW || next.wallH !== cfg.wallH || next.floorDepth !== cfg.floorDepth || next.floorDrop !== cfg.floorDrop;
  cfg = next;
  if (changed) {
    course.build(cfg);
    fitCamera();
  }
  applyMarkerLayout(cfg.markers ?? []);
  return changed;
}
course.build(cfg);
fitCamera();

// ---- プレイヤー（頭 + 名札）----
type Peer = { group: THREE.Group; materials: THREE.MeshStandardMaterial[]; label: TextPanel; targetPos: THREE.Vector3; targetQuat: THREE.Quaternion; lastPoseMs: number; tracking: boolean; markerIds: number[] };
const peers = new Map<string, Peer>();
const headGeometry = new THREE.SphereGeometry(0.12, 24, 16);
const noseGeometry = new THREE.ConeGeometry(0.05, 0.14, 16);
function createPeer(id: string): Peer {
  removePeer(id);
  const group = new THREE.Group();
  const headMat = new THREE.MeshStandardMaterial({ color: 0xe8eaed, transparent: true });
  const noseMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, transparent: true });
  group.add(new THREE.Mesh(headGeometry, headMat));
  const nose = new THREE.Mesh(noseGeometry, noseMat);
  nose.rotation.x = -Math.PI / 2;
  nose.position.z = -0.14;
  group.add(nose);
  group.visible = false;
  field.add(group);
  const label = new TextPanel(0.5, 0.12, 384);
  scene.add(label.mesh);
  const peer: Peer = { group, materials: [headMat, noseMat], label, targetPos: new THREE.Vector3(), targetQuat: new THREE.Quaternion(), lastPoseMs: -Infinity, tracking: false, markerIds: [] };
  peers.set(id, peer);
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
function onPeerPose(id: string, pose: PlayerPose) {
  const peer = peers.get(id) ?? createPeer(id);
  peer.targetPos.set(...pose.pos);
  peer.targetQuat.set(...pose.quat);
  peer.tracking = pose.tracking;
  peer.markerIds = pose.tracking ? (pose.markerIds ?? []) : [];
  const now = performance.now();
  if (now - peer.lastPoseMs > PEER_STALE_MS) {
    peer.group.position.copy(peer.targetPos);
    peer.group.quaternion.copy(peer.targetQuat);
  }
  peer.lastPoseMs = now;
}
const tmpVec = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();
let lastPeerUpdateMs = performance.now();
function updatePeers(now: number) {
  const dtFrames = Math.min((now - lastPeerUpdateMs) / (1000 / 60), 4);
  lastPeerUpdateMs = now;
  const alpha = 1 - Math.pow(1 - PEER_SMOOTH, dtFrames);
  camera.getWorldQuaternion(tmpQuat);
  for (const [id, peer] of peers) {
    if (peer.lastPoseMs === -Infinity) continue;
    const stale = now - peer.lastPoseMs > PEER_STALE_MS;
    peer.group.visible = !stale;
    if (stale) {
      peer.label.set("");
      continue;
    }
    peer.group.position.lerp(peer.targetPos, alpha);
    peer.group.quaternion.slerp(peer.targetQuat, alpha);
    const opacity = peer.tracking ? 1 : 0.35;
    for (const m of peer.materials) m.opacity = opacity;
    const color = colorHexOf(id);
    peer.materials[0].color.setHex(color);
    peer.group.getWorldPosition(tmpVec);
    peer.label.mesh.position.set(tmpVec.x, tmpVec.y + 0.22, tmpVec.z);
    peer.label.mesh.quaternion.copy(tmpQuat);
    const p = auth?.state.players.find((x) => x.id === id);
    peer.label.set(p ? `${p.name}（${id}）` : id, `#${color.toString(16).padStart(6, "0")}`);
  }
}

// ---- ゲームの状態 ----
let selfId = "";
let netStatus = "idle";
let client: GameClient | null = null;
let joined = false;
let auth: { state: GameSnapshot; recvMs: number } | null = null;
let lastEventKey = "";
let lastRejectReason = "";
let restartsSent = 0;
let rulesSent = 0;
let fieldsSent = 0;
let markersSent = 0;
let strokesSent = 0;
let addressesSent = 0;
let rulesPending = false;
let sizePending = false;
let markersPending = false;
let liveRoll: { seq: number; by: string; result: RollResult; startLocalMs: number } | null = null;
/** 手番が始まった時刻（フェイク Joy-Con の待ちに使う） */
let turnSinceMs = -1;
let lastTurn: string | null = null;

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

function onState(state: GameSnapshot) {
  const now = performance.now();
  auth = { state, recvMs: now };
  if (state.turn !== lastTurn) {
    lastTurn = state.turn;
    turnSinceMs = now;
  }
  const ev = state.event;
  const key = ev ? `${state.seq}:${ev.kind}` : "";
  if (key && key !== lastEventKey) {
    lastEventKey = key;
    console.log(`[overview] event ${ev?.kind} phase=${state.phase} hole=${state.hole} turn=${state.turn}`);
  }
  const roll = state.roll;
  if (roll && roll.seq !== liveRoll?.seq) {
    const cup = state.holes[state.hole]?.cup ?? [0, 0];
    liveRoll = { seq: roll.seq, by: roll.by, result: simulateRoll(roll.from, roll.vel, cup, cfg), startLocalMs: localTimeOf(roll.startedAt, state.t, now) };
  }
  if (!roll) liveRoll = null;
  renderPanel();
}

function connect() {
  if (ROOM === null) return;
  client = connectGame(
    ROOM,
    "",
    { markerId: MARKER_ID, markerMm: MARKER_MM },
    {
      onStatus: (status) => {
        netStatus = status;
        if (status !== "open") {
          joined = false;
          rulesPending = sizePending = markersPending = false;
        }
        renderPanel();
      },
      onError: (reason) => {
        netStatus = `error: ${reason}`;
        console.warn(`[overview] rejected: ${reason}`);
        renderPanel();
      },
      onWelcome: (id, role, peerIds, config, state) => {
        selfId = id;
        netStatus = "open";
        joined = true;
        applyConfig(config);
        setup.syncSize(config);
        setup.syncMarkers(config);
        syncRuleInputs();
        [...peers.keys()].forEach(removePeer);
        peerIds.forEach(createPeer);
        lastEventKey = "";
        liveRoll = null;
        onState(state);
        console.log(`[overview] joined "${ROOM}" as ${id} (${role}; players: ${peerIds.join(", ") || "none"})`);
      },
      onPeerJoin: (id) => {
        createPeer(id);
        renderPanel();
      },
      onPeerLeave: (id) => {
        removePeer(id);
        renderPanel();
      },
      onPeerPose,
      onState,
      onPutter: () => {},
      onRejected: (reason) => {
        lastRejectReason = reason;
        rulesPending = sizePending = markersPending = false;
        console.log(`[overview] rejected by server: ${reason}`);
        renderPanel();
      },
      onConfig: (config, state) => {
        rulesPending = sizePending = false;
        lastRejectReason = "";
        applyConfig(config);
        setup.syncSize(config);
        syncRuleInputs();
        liveRoll = null;
        onState(state);
        console.log(`[overview] config ${config.wallW}x${config.wallH}x${config.floorDepth}/${config.floorDrop} decel=${config.decel} holes=${config.holes} maxStrokes=${config.maxStrokes}`);
      },
      onMarkers: (config) => {
        markersPending = false;
        lastRejectReason = "";
        applyConfig(config);
        setup.syncMarkers(config);
        renderPanel();
        console.log(`[overview] markers ${describeMarkers(config.markers)}`);
      },
    },
    "overview",
  );
}

// ---- Joy-Con のハブ ----
type Assignment = "auto" | "none" | string;
type JoyConSlot = {
  jc: JoyCon;
  det: SwingDetector;
  assign: Assignment;
  prevA: boolean;
  prevB: boolean;
  lastPutterSendMs: number;
  /** 直近のインパクト（HUD 用） */
  lastImpact: (Impact & { speed: number; playerId: string | null; sent: boolean }) | null;
  swings: number;
  /** 直近の角速度の大きさ [deg/s] */
  dps: number;
  row: { root: HTMLDivElement; name: HTMLSpanElement; select: HTMLSelectElement; meta: HTMLDivElement } | null;
};
const slots = new Map<string, JoyConSlot>();
const joyconRowsEl = document.querySelector<HTMLDivElement>("#joycon-rows")!;
const joyconHint = document.querySelector<HTMLDivElement>("#joycon-hint")!;
const connectButton = document.querySelector<HTMLButtonElement>("#connect-joycon")!;

/** この Joy-Con が「いま誰の分か」（auto は手番の人） */
function playerOf(slot: JoyConSlot): string | null {
  if (slot.assign === "none") return null;
  if (slot.assign === "auto") return auth?.state.turn ?? null;
  return auth?.state.players.some((p) => p.id === slot.assign) ? slot.assign : null;
}

function onReport(jc: JoyCon, report: StandardReport, nowMs: number) {
  const slot = slots.get(jc.key);
  if (!slot) return;
  const playerId = playerOf(slot);
  // ボタン: A の立ち上がりで構え、B で狙いを消す。Joy-Con (L) には A / B が無いので同じ位置の → / ↓ を当てる（外部レビュー指摘）
  const pressA = report.buttons.a || report.buttons.right;
  const pressB = report.buttons.b || report.buttons.down;
  if (pressA && !slot.prevA) {
    slot.det.address(nowMs);
    if (client && playerId && client.sendAddress(playerId)) {
      addressesSent++;
      console.log(`[overview] address(${playerId}) via ${jc.name}`);
    }
  }
  if (pressB && !slot.prevB && client && playerId) client.sendClearAim(playerId);
  slot.prevA = pressA;
  slot.prevB = pressB;
  // IMU: 3 サンプル（古い順、5ms 間隔）
  let dps = 0;
  for (let i = 0; i < report.imu.length; i++) {
    const s = report.imu[i];
    dps = Math.hypot(s.gyro[0], s.gyro[1], s.gyro[2]);
    const t = nowMs - (report.imu.length - 1 - i) * IMU_SAMPLE_SEC * 1000;
    const impact = slot.det.sample(t, s.gyro, s.accel, IMU_SAMPLE_SEC);
    if (impact) onImpact(slot, impact, playerId);
  }
  slot.dps = dps;
  // 振り角を配る（割り当てがあるときだけ）
  if (playerId && client && nowMs - slot.lastPutterSendMs >= PUTTER_SEND_MS) {
    slot.lastPutterSendMs = nowMs;
    client.sendPutter(playerId, round1(slot.det.angleDeg), round1(dps));
  }
}

function onImpact(slot: JoyConSlot, impact: Impact, playerId: string | null) {
  const speed = impactSpeed(impact.dps, ARM_M, STROKE_GAIN);
  slot.swings++;
  const s = auth?.state;
  const isTurn = !!playerId && s?.phase === "aim" && s.turn === playerId;
  let sent = false;
  if (isTurn && client) {
    sent = client.sendStroke(round3(speed), round1(impact.faceDeg), playerId!);
    if (sent) strokesSent++;
  }
  slot.lastImpact = { ...impact, speed, playerId, sent };
  console.log(`[overview] impact ${slot.jc.name}: dps=${impact.dps.toFixed(0)} back=${impact.backswingDeg.toFixed(1)} face=${impact.faceDeg.toFixed(1)} speed=${speed.toFixed(2)} player=${playerId ?? "-"} ${sent ? "sent" : isTurn ? "not sent" : "not their turn"}`);
  renderPanel();
}

const hub = new JoyConHub({
  onConnect: (jc) => {
    lastRejectReason = ""; // 開けた（失敗の理由はここでだけ消す）
    addSlot(jc);
  },
  onReport,
  onStatus: (jc, status) => {
    console.log(`[overview] ${jc.name}: ${status}`);
    // 開けなかった台は行が出ない（onConnect が来ない）ので、理由をパネルに出す（外部レビュー指摘）
    if (/失敗/.test(status)) lastRejectReason = `${jc.name}: ${status}`;
    renderPanel();
  },
  onDisconnect: (jc) => {
    const slot = slots.get(jc.key);
    slot?.row?.root.remove();
    slots.delete(jc.key);
    console.log(`[overview] ${jc.name} disconnected`);
    renderPanel();
  },
});

function addSlot(jc: JoyCon) {
  if (slots.has(jc.key)) return;
  const det = new SwingDetector(SWING_OPTS);
  const root = document.createElement("div");
  root.className = "jc";
  const name = document.createElement("span");
  name.className = "name";
  const select = document.createElement("select");
  const meta = document.createElement("div");
  meta.className = "meta";
  root.append(name, select, meta);
  joyconRowsEl.append(root);
  const slot: JoyConSlot = { jc, det, assign: "auto", prevA: false, prevB: false, lastPutterSendMs: -Infinity, lastImpact: null, swings: 0, dps: 0, row: { root, name, select, meta } };
  select.addEventListener("change", () => {
    slot.assign = select.value;
    renderPanel();
  });
  slots.set(jc.key, slot);
  renderPanel();
}

/** フェイク Joy-Con: 割り当てた人の手番になって FAKE_SWING_SEC 経ったら、カップに届く速さで 1 回振る（受理待ちの間は振らない） */
let fakeTriggeredForTurn = -1; // 手番の開始時刻（turnSinceMs）で 1 手番 1 回。seq は構え・入室でも進むので使わない
function updateFakeJoycon(now: number) {
  if (!fakeJoycon || !auth) return;
  const slot = slots.get(fakeJoycon.key);
  if (!slot) return;
  const s = auth.state;
  const playerId = playerOf(slot);
  if (!playerId || s.phase !== "aim" || s.turn !== playerId) return;
  if (now - turnSinceMs < FAKE_SWING_SEC * 1000 || fakeTriggeredForTurn === turnSinceMs) return;
  const ball = s.balls[playerId];
  const cup = s.holes[s.hole]?.cup;
  if (!ball || !cup) return;
  fakeTriggeredForTurn = turnSinceMs;
  const dist = Math.hypot(cup[0] - ball.pos[0], cup[1] - ball.pos[1]);
  const speed = Math.min(cfg.maxStrokeSpeed, speedForDistance(dist, cfg.decel) + 0.15);
  // 検出のしきい値（minImpactDps）を割ると振っても 1 打にならず手番が止まるので下限を持つ（短い寄せは少し強めになる）
  const impactDps = Math.max(SWING_OPTS.minImpactDps * 1.2, (speed / (ARM_M * STROKE_GAIN)) * (180 / Math.PI));
  fakeJoycon.trigger({ backDeg: 20, backDps: 120, impactDps, yawDps: FAKE_YAW_DPS });
  console.log(`[overview] fake swing for ${playerId}: dist=${dist.toFixed(2)} speed=${speed.toFixed(2)} dps=${impactDps.toFixed(0)}`);
}

// ---- 描画の更新（コート・転がり）----
function updateCourse(now: number) {
  const s = auth?.state;
  if (!s) {
    course.setBalls([], now);
    return;
  }
  const balls = s.players
    .filter((p) => s.balls[p.id])
    .map((p) => {
      const b = s.balls[p.id];
      let pos: V2 = b.pos;
      let sunk = b.holed;
      if (liveRoll && liveRoll.by === p.id) {
        const elapsed = (now - liveRoll.startLocalMs) / 1000;
        if (elapsed < liveRoll.result.duration) {
          pos = rollAt(liveRoll.result, elapsed);
          sunk = false;
        }
      }
      return { id: p.id, pos, color: playerColorHex(p.color), holed: b.holed, sunk };
    });
  course.setBalls(balls, now);
  course.setHole(s.holes[s.hole] ?? null, s.hole);
  const turnId = s.phase === "aim" ? s.turn : null;
  if (turnId && s.balls[turnId]) {
    const ball = s.balls[turnId];
    const cup = s.holes[s.hole]?.cup ?? [0, 0];
    const d: V2 = [cup[0] - ball.pos[0], cup[1] - ball.pos[1]];
    const l = Math.hypot(d[0], d[1]) || 1;
    const aim = s.aims[turnId] ?? [d[0] / l, d[1] / l];
    const color = playerColorHex(colorOf(turnId) ?? 1);
    course.setAim(ball.pos, aim, s.aims[turnId] !== null, color);
    // 振り子: この人に割り当てた Joy-Con の角度（auto は手番の人）
    const slot = [...slots.values()].find((x) => playerOf(x) === turnId);
    course.setPutter(ball.pos, aim, slot ? slot.det.angleDeg : 0, color);
  } else {
    course.setAim(null, null, false, 0);
    course.setPutter(null, null, 0, 0);
  }
}

// ---- 操作パネル ----
const phaseEl = document.querySelector<HTMLDivElement>("#phase")!;
const turnEl = document.querySelector<HTMLDivElement>("#turn")!;
const playersEl = document.querySelector<HTMLUListElement>("#players")!;
const statusEl = document.querySelector<HTMLDivElement>("#status")!;
const hud = document.querySelector<HTMLDivElement>("#hud")!;
const restartButton = document.querySelector<HTMLButtonElement>("#restart")!;
const ruleInputs: Record<keyof GolfRules, HTMLInputElement> = {
  decel: document.querySelector<HTMLInputElement>("#rule-decel")!,
  cupMaxSpeed: document.querySelector<HTMLInputElement>("#rule-cupMaxSpeed")!,
  maxStrokes: document.querySelector<HTMLInputElement>("#rule-maxStrokes")!,
  holes: document.querySelector<HTMLInputElement>("#rule-holes")!,
};
const applyRulesButton = document.querySelector<HTMLButtonElement>("#apply-rules")!;
const rulesHint = document.querySelector<HTMLDivElement>("#rules-hint")!;
for (const key of GOLF_RULE_KEYS) {
  ruleInputs[key].min = String(GOLF_RULE_LIMITS[key].min);
  ruleInputs[key].max = String(GOLF_RULE_LIMITS[key].max);
  ruleInputs[key].addEventListener("input", () => renderPanel());
}
function syncRuleInputs() {
  for (const key of GOLF_RULE_KEYS) ruleInputs[key].value = String(cfg[key]);
}
function readRules(): GolfRules {
  return { decel: Number(ruleInputs.decel.value), cupMaxSpeed: Number(ruleInputs.cupMaxSpeed.value), maxStrokes: Number(ruleInputs.maxStrokes.value), holes: Number(ruleInputs.holes.value) };
}
function rulesChanged(): boolean {
  const r = readRules();
  return GOLF_RULE_KEYS.some((k) => r[k] !== cfg[k]);
}
applyRulesButton.addEventListener("click", () => {
  if (!client || rulesPending) return;
  const rules = readRules();
  const invalid = validateGolfRules(rules);
  if (invalid) {
    lastRejectReason = invalid;
    renderPanel();
    return;
  }
  if (client.sendRules(rules)) {
    rulesSent++;
    rulesPending = true;
    lastRejectReason = "";
    console.log(`[overview] rules sent ${JSON.stringify(rules)}`);
  }
  renderPanel();
});
restartButton.addEventListener("click", () => {
  if (!client) return;
  if (client.sendRestart()) {
    restartsSent++;
    lastRejectReason = "";
    console.log("[overview] restart sent");
  }
});
const setup = createFieldSetupPanel({
  originMarkerId: MARKER_ID,
  sizeInputs: {
    wallW: document.querySelector<HTMLInputElement>("#size-wallW")!,
    wallH: document.querySelector<HTMLInputElement>("#size-wallH")!,
    floorDepth: document.querySelector<HTMLInputElement>("#size-floorDepth")!,
    floorDrop: document.querySelector<HTMLInputElement>("#size-floorDrop")!,
  },
  applySizeButton: document.querySelector<HTMLButtonElement>("#apply-size")!,
  sizeHint: document.querySelector<HTMLDivElement>("#size-hint")!,
  markerRowsEl: document.querySelector<HTMLDivElement>("#marker-rows")!,
  applyMarkersButton: document.querySelector<HTMLButtonElement>("#apply-markers")!,
  markersHint: document.querySelector<HTMLDivElement>("#markers-hint")!,
  onApplySize: (size) => {
    if (!client || sizePending) return false;
    if (!client.sendField(size)) return false;
    fieldsSent++;
    sizePending = true;
    lastRejectReason = "";
    console.log(`[overview] field sent ${size.wallW}x${size.wallH}x${size.floorDepth}/${size.floorDrop}`);
    renderPanel();
    return true;
  },
  onApplyMarkers: (markers) => {
    if (!client || markersPending) return false;
    if (!client.sendMarkers(markers)) return false;
    markersSent++;
    markersPending = true;
    lastRejectReason = "";
    console.log(`[overview] markers sent ${describeMarkers(markers)}`);
    renderPanel();
    return true;
  },
  onInput: () => renderPanel(),
  sizeChangeNote: "「反映」で全員のコートが変わります（最初からになります）",
  cellM: GOLF_SIZE_CELL_M,
  markersChangeNote: "「反映」で全員の位置合わせに使うマーカーが変わります（ゲームはそのまま）",
});

function remainingSec(now: number): number {
  const s = auth?.state;
  if (!s || !auth) return 0;
  const end = s.phase === "aim" ? s.turnEndsAt : s.phaseEndsAt;
  if (end === null) return 0;
  return Math.max(0, (end - s.t) / 1000 - (now - auth.recvMs) / 1000);
}
function totalOf(s: GameSnapshot, id: string): number {
  return (s.cards[id] ?? []).reduce((a, b) => a + b, 0);
}
function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

let lastPanelKey = "";
function renderPanel() {
  const now = performance.now();
  const s = auth?.state;
  let phaseText = "接続中…";
  let turnText = "";
  if (netStatus.startsWith("error")) phaseText = `接続できません: ${netStatus.slice(7)}`;
  else if (!joined || !s) phaseText = `サーバーに接続中… (${netStatus})`;
  else if (s.phase === "lobby") phaseText = "プレイヤー待ち（スマホで同じ room に入ってください）";
  else if (s.phase === "result") {
    const w = s.winnerNames ?? [];
    phaseText = w.length === 0 ? "結果" : `結果: ${w.join("・")} の勝ち！`;
    turnText = `${Math.ceil(remainingSec(now))} 秒後に最初から`;
  } else {
    phaseText = `ホール ${s.hole + 1} / ${s.holes.length}`;
    if (s.phase === "rolling") turnText = `${liveRoll ? nameOf(liveRoll.by) : "-"} のボールが転がっています`;
    else if (s.turn) turnText = `▶ ${nameOf(s.turn)} の番（${(s.balls[s.turn]?.strokes ?? 0) + 1} 打目。残り ${Math.ceil(remainingSec(now))} 秒）`;
  }
  const editable = joined && s !== undefined && s.phase !== "rolling";
  const canRestart = joined && s !== undefined && s.players.length > 0;
  const rulesInvalid = validateGolfRules(readRules());
  const canApplyRules = editable && !rulesPending && rulesChanged() && rulesInvalid === null;
  const rulesHintText = !joined ? "" : rulesInvalid ? rulesInvalid : rulesChanged() ? "「反映」で全員のルールが変わります（最初からになります）" : `いま: 減速 ${cfg.decel}・入る速さ ${cfg.cupMaxSpeed} m/s・${cfg.maxStrokes} 打まで・${cfg.holes} ホール`;
  const playerRows = s
    ? [...s.players]
        .map((p) => {
          const peer = peers.get(p.id);
          const marker = !peer || peer.lastPoseMs === -Infinity || now - peer.lastPoseMs > PEER_STALE_MS ? "-" : !peer.tracking ? "ロスト（最後の姿勢を維持）" : peer.markerIds.length > 0 ? peer.markerIds.join("+") : "?";
          const b = s.balls[p.id];
          const cards = s.cards[p.id] ?? [];
          const jc = [...slots.values()].find((x) => playerOf(x) === p.id);
          // 結果表示では最終ホールの打数はカードに入っているので足さない（外部レビュー指摘: 二重加算）
          const inPlay = s.phase !== "result";
          return { p, marker, strokes: inPlay ? (b?.strokes ?? 0) : null, holed: b?.holed ?? false, done: b?.done ?? false, cards, total: totalOf(s, p.id) + (inPlay ? (b?.strokes ?? 0) : 0), turn: s.turn === p.id, win: s.winners?.includes(p.id) ?? false, jc: jc ? jc.jc.name : "" };
        })
        .sort((a, b) => a.total - b.total)
    : [];
  const jcRows = [...slots.values()].map((slot) => {
    const pid = playerOf(slot);
    const age = now - slot.jc.lastReportMs;
    const li = slot.lastImpact;
    return {
      key: slot.jc.key,
      name: slot.jc.name,
      assign: slot.assign,
      meta: `${slot.jc.status} / ${slot.jc.fake ? "" : `電池 ${slot.jc.battery}/8${slot.jc.charging ? "(充電中)" : ""} / `}${Number.isFinite(age) ? `${age < 500 ? "受信中" : `${(age / 1000).toFixed(1)}s 途絶`} ${slot.jc.reports} 件` : "未受信"}\n担当: ${pid ? nameOf(pid) : "-"}${slot.assign === "auto" ? "（手番の人）" : ""} / 状態 ${slot.det.phase} / 角 ${slot.det.angleDeg.toFixed(0)}° / ${slot.dps.toFixed(0)} deg/s / 構え ${slot.det.addresses} 回\n${li ? `直近の振り: ${li.speed.toFixed(2)} m/s（${li.dps.toFixed(0)} deg/s, バック ${li.backswingDeg.toFixed(0)}°, 面 ${li.faceDeg.toFixed(1)}°）${li.sent ? " → 送信" : li.playerId ? "（手番でないので無視）" : "（担当なし）"}` : "振り: まだ"}`,
    };
  });
  // 寸法・追加マーカーの入力欄の値もキーに入れる（外部レビュー指摘: lobby で編集しても再描画されず「反映」が押せなかった）
  const key = JSON.stringify([phaseText, turnText, canRestart, editable, canApplyRules, rulesPending, rulesHintText, playerRows, jcRows, netStatus, lastRejectReason, sizePending, markersPending, connectButton.disabled, setup.readSize(), setup.readMarkers()]);
  if (key === lastPanelKey) return;
  lastPanelKey = key;
  phaseEl.textContent = phaseText;
  turnEl.textContent = turnText;
  restartButton.disabled = !canRestart;
  for (const k of GOLF_RULE_KEYS) ruleInputs[k].disabled = !editable || rulesPending;
  applyRulesButton.disabled = !canApplyRules;
  applyRulesButton.textContent = rulesPending ? "送信中…" : "反映";
  rulesHint.textContent = rulesHintText;
  setup.render({ editable, sizePending, markersPending, joined, current: cfg });
  // Joy-Con の行
  for (const slot of slots.values()) {
    const row = slot.row;
    if (!row) continue;
    row.name.textContent = slot.jc.name;
    const options: { value: string; label: string }[] = [{ value: "auto", label: "手番の人（自動）" }, ...(s?.players ?? []).map((p) => ({ value: p.id, label: `${p.name}（${p.id}）` })), { value: "none", label: "使わない" }];
    if (row.select.options.length !== options.length || [...row.select.options].some((o, i) => o.value !== options[i].value || o.textContent !== options[i].label)) {
      row.select.replaceChildren(...options.map((o) => Object.assign(document.createElement("option"), { value: o.value, textContent: o.label })));
    }
    // 割り当てた人が居なくなった（切断・再接続で id が変わった）ら自動に戻す（外部レビュー指摘: 選択欄だけ戻して assign が古いままだった）
    if (!options.some((o) => o.value === slot.assign)) slot.assign = "auto";
    row.select.value = slot.assign;
    const r = jcRows.find((x) => x.key === slot.jc.key);
    row.meta.textContent = r?.meta ?? "";
  }
  joyconHint.textContent = !hidSupported()
    ? "この環境では WebHID が使えません（PC の Chrome で開いてください）。?fakeJoycon=1 で合成の振りを流せます"
    : slots.size === 0
      ? "Joy-Con を Mac の Bluetooth 設定で接続してから「Joy-Con を接続」→ 選択。以後はページを開くだけで再接続します。\n使い方: パターのように握って静止（構え）→ バックスイング → 振り戻す。A（L は →）で狙いを固定（スマホで見ている床の点）、B（L は ↓）で狙いを消す"
      : `静止すると構え直します（角 0°。持ち直したら ${(SWING_OPTS.swingStillMs / 1000).toFixed(1)} 秒止めるか A で構え直す）。バックスイング ${SWING_OPTS.minBackswingDeg}° 以上・戻り ${SWING_OPTS.minImpactDps} deg/s 以上で 1 打。速さ = 角速度 × 腕 ${ARM_M}m × 補正 ${STROKE_GAIN}（?armM= ?strokeGain= ?minBackswing= ?minImpactDps=）`;
  playersEl.replaceChildren(
    ...playerRows.map(({ p, marker, strokes, holed, done, cards, total, turn, win, jc }) => {
      const li = document.createElement("li");
      const sw = document.createElement("span");
      sw.className = "swatch";
      sw.style.background = playerColorCss(p.color);
      const name = document.createElement("span");
      name.textContent = `${turn ? "▶ " : ""}${p.name}（${playerColorName(p.color)}）${win ? " 🏆" : ""}${jc ? ` 🎮` : ""}`;
      const score = document.createElement("span");
      score.className = "score";
      score.textContent = strokes === null ? `${cards.join("+")} = ${total}` : `${cards.join("+")}${cards.length ? "+" : ""}${strokes}${holed ? "✓" : done ? "×" : ""} = ${total}`;
      const markerEl = document.createElement("span");
      markerEl.className = "marker";
      markerEl.textContent = `位置合わせ: マーカー ${marker}${jc ? ` / Joy-Con: ${jc}` : ""}`;
      li.append(sw, name, score, markerEl);
      return li;
    }),
  );
  if (playerRows.length === 0 && joined) {
    const li = document.createElement("li");
    li.textContent = "プレイヤーはまだいません（スマホで同じ room に入ってください）";
    playersEl.append(li);
  }
  statusEl.textContent = [`room=${ROOM ?? "(不正)"} ws=${netStatus}`, lastRejectReason && `できません: ${lastRejectReason}`].filter(Boolean).join("\n");
}

let lastHudText = "";
function renderHud() {
  const s = auth?.state;
  const now = performance.now();
  const jcs = [...slots.values()];
  const text = s
    ? `overview: room=${ROOM} me=${selfId} ws=${netStatus} phase=${s.phase} hole=${s.hole + 1}/${s.holes.length} turn=${s.turn ?? "-"} left=${remainingSec(now).toFixed(0)}s players=${s.players.map((p) => `${p.id}:${p.color}`).join(",")} balls=${s.players.map((p) => `${p.id}:${s.balls[p.id]?.strokes ?? 0}${s.balls[p.id]?.holed ? "h" : s.balls[p.id]?.done ? "d" : ""}`).join(",")} cards=${s.players.map((p) => `${p.id}:${(s.cards[p.id] ?? []).join("+") || "-"}`).join(",")} roll=${s.roll ? `#${s.roll.seq}:${s.roll.by}:${s.roll.holed ? "holed" : "stop"}` : "-"} field=${cfg.wallW}x${cfg.wallH}x${cfg.floorDepth}/${cfg.floorDrop} rules=${cfg.decel}/${cfg.cupMaxSpeed}/${cfg.maxStrokes}/${cfg.holes} markers=${describeMarkers(cfg.markers ?? [])} joycons=${jcs.length} assigned=${jcs.map((j) => `${j.jc.fake ? "fake" : j.jc.kind}:${playerOf(j) ?? "-"}:${j.det.phase}`).join(",") || "-"} swings=${jcs.reduce((a, j) => a + j.swings, 0)} strokesSent=${strokesSent} addresses=${addressesSent} restarts=${restartsSent} rulesSent=${rulesSent} fields=${fieldsSent} markersSent=${markersSent} seq=${s.seq} peerMarkers=${[...peers].map(([id, p]) => `${id}:${p.tracking ? p.markerIds.join("+") || "?" : "lost"}`).join(",")}`
    : `overview: room=${ROOM} ws=${netStatus}`;
  if (text !== lastHudText) {
    lastHudText = text;
    hud.textContent = text;
  }
}

// ---- Joy-Con の接続（パネルの部品が揃ってから。フェイクは addSlot で renderPanel を呼ぶ）----
connectButton.addEventListener("click", async () => {
  connectButton.disabled = true;
  try {
    await hub.request(); // 開けた台は onConnect で addSlot される（失敗の理由は onStatus が残す）
  } catch (e: unknown) {
    lastRejectReason = `Joy-Con: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    connectButton.disabled = !hidSupported();
    renderPanel();
  }
});
if (!hidSupported()) {
  connectButton.disabled = true;
} else {
  // 以前に許可した台を開き直す（ページ再読込後。開けた台は onConnect で addSlot される）
  void hub.reconnect();
}
let fakeJoycon: FakeJoyCon | null = null;
if (FAKE_JOYCON) {
  fakeJoycon = new FakeJoyCon({ onConnect: () => {}, onReport, onStatus: () => {}, onDisconnect: () => {} });
  hub.addFake(fakeJoycon);
  addSlot(fakeJoycon);
  // ヘッドレス確認から A ボタン（構え）と振りを起こせるようにする
  (window as unknown as { __golfFake: unknown }).__golfFake = {
    pressA: () => fakeJoycon?.pressAddress(),
    swing: (impactDps: number) => fakeJoycon?.trigger({ backDeg: 20, backDps: 120, impactDps, yawDps: FAKE_YAW_DPS }),
  };
}

if (ROOM === null) {
  phaseEl.textContent = `room 名「${roomRaw}」は使えません`;
} else {
  connect();
}
addEventListener("pagehide", () => {
  client?.dispose();
  joined = false;
  netStatus = "closed (pagehide)";
});
addEventListener("pageshow", (e) => {
  if (e.persisted) connect();
});

// ---- ループ ----
let lastPanelMs = 0;
renderer.setAnimationLoop(() => {
  const now = performance.now();
  controls.update();
  updatePeers(now);
  updateCourse(now);
  updateFakeJoycon(now);
  if (now - lastPanelMs > 250) {
    lastPanelMs = now;
    renderPanel();
  }
  renderHud();
  renderer.render(scene, camera);
});
