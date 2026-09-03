import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { numParam, params } from "../../src/shared/url-params";
import { HandView } from "../../src/shared/hand-view";
import { LANDMARK_COUNT } from "../../src/shared/hand-math";
import type { Vec3 } from "../../src/shared/hand-math";
import { TextPanel } from "../../src/shared/text-panel";
import { ROOM_ID_PATTERN } from "../../src/shared/shared-room-protocol";
import { DEFAULT_FIELD, FIELD_SIZE_KEYS, FIELD_SIZE_LIMITS, fieldSurfaces, inkAt, validateFieldSize } from "../../src/shared/splatoon-sim";
import type { FieldConfig, FieldSize, InkColor, InkLanding, SurfaceFrame, V3 } from "../../src/shared/splatoon-sim";
import type { GameSnapshot, Shot } from "../../src/shared/splatoon-game";
import type { PlayerPose } from "../../src/shared/splatoon-protocol";
import { connectGame } from "./game-client";
import type { GameClient } from "./game-client";
import { InkView, inkColorHex, inkColorName } from "./ink-view";
import { impactDirUv, isWallSurface, splatShape } from "../../src/shared/splat-shape";
import { createSplatSound } from "./splat-sound";

// Phase 8 / issue #19・#21: PC の俯瞰画面。カメラもゴーグルも使わず、同じ room に「俯瞰」役で入って
// コート全体（四方の壁 + 床の塗り）・全員の頭と手・飛んでいるインクを描き、「対戦開始」と「フィールドの寸法」を送る唯一の端末。
// 座標系はスマホと同じ field 座標系（マーカー座標系）で、ここではそれをワールド座標にそのまま置く。
// 描画のうち塗り（InkView）・飛行（inkAt）・ピアの頭と手は main.ts と同じ式（俯瞰なので視点だけ違う）

// ---- パラメータ（room の設定はスマホと一致が必要。サーバーが検証する）----
// フィールドの寸法（幅・高さ・奥行き）は URL ではなくこの画面の入力欄で決め、サーバーに送る（welcome / field で戻ってくる）
const roomRaw = params.get("room");
const ROOM = roomRaw === null ? "demo" : ROOM_ID_PATTERN.test(roomRaw) ? roomRaw : null;
const MARKER_MM = numParam("markerMm", 100, { max: 5000 });
const MARKER_ID = Math.round(numParam("markerId", 0, { min: 0, max: 999 }));
const FLOOR_DROP = numParam("floorDrop", DEFAULT_FIELD.floorDrop, { min: 0.1, max: 5 });
const GRAVITY = numParam("gravity", DEFAULT_FIELD.gravity, { min: 0, max: 30 });
const MATCH_SEC = numParam("matchSec", DEFAULT_FIELD.matchSec, { min: 10, max: 600 });
const WAIT_SEC = numParam("waitSec", DEFAULT_FIELD.waitSec, { min: 0, max: 120 });
const SURFACE_PX_PER_M = numParam("surfacePx", 384, { min: 64, max: 2048 });
const PEER_STALE_MS = numParam("peerStaleMs", 2000, { min: 200, max: 30000 });
const PEER_SMOOTH = numParam("peerSmooth", 0.3, { min: 0.01, max: 1 });
/** 着弾の音（?sound=0 で無効。PC は最初のクリックで有効になる） */
const SOUND = params.get("sound") !== "0";

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

// ---- フィールド（field 座標系 = ワールド）----
const field = new THREE.Group();
scene.add(field);
let fieldCfg: FieldConfig = {
  ...DEFAULT_FIELD,
  floorDrop: FLOOR_DROP,
  gravity: GRAVITY,
  matchSec: MATCH_SEC,
  waitSec: WAIT_SEC,
};
let surfaces: SurfaceFrame[] = [];
const inkViews = new Map<string, InkView>();

/** 壁と床（5 枚）と塗りの層を config から作り直す（起動時と、寸法が変わったとき）。視点もコートに合わせ直す */
function buildField() {
  for (const v of inkViews.values()) v.dispose();
  inkViews.clear();
  surfaces = fieldSurfaces(fieldCfg);
  for (const s of surfaces) {
    const view = new InkView(s, SURFACE_PX_PER_M, fieldCfg.cellM);
    field.add(view.group);
    inkViews.set(s.id, view);
  }
  fitCamera();
}

/** サーバーの config を取り込む。壁と床の形に効く値が変わっていたら作り直す */
function applyFieldConfig(cfg: FieldConfig): boolean {
  const changed = cfg.wallW !== fieldCfg.wallW || cfg.wallH !== fieldCfg.wallH || cfg.floorDepth !== fieldCfg.floorDepth || cfg.floorDrop !== fieldCfg.floorDrop || cfg.cellM !== fieldCfg.cellM;
  fieldCfg = cfg;
  if (changed) buildField();
  return changed;
}
// マーカーの枠（壁の原点。スマホの位置合わせの基準がどこかを示す）
field.add(
  new THREE.Mesh(
    new THREE.PlaneGeometry(MARKER_MM / 1000, MARKER_MM / 1000),
    new THREE.MeshBasicMaterial({ color: 0x8ab4f8, transparent: true, opacity: 0.5, side: THREE.DoubleSide }),
  ),
);
field.add(new THREE.AxesHelper(0.3));

// 視点: コートの後方上空から壁を見下ろす。OrbitControls で回せる
function fitCamera() {
  const { wallW, wallH, floorDrop, floorDepth } = fieldCfg;
  camera.position.set(wallW * 0.9, -floorDrop + wallH * 1.1, floorDepth + wallW * 0.9);
  controls.target.set(0, -floorDrop + wallH * 0.35, floorDepth / 2);
  controls.update();
}
buildField();

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

// ---- プレイヤー（頭 + 視線のコーン + 名札 + 手）----
type Peer = {
  group: THREE.Group;
  materials: THREE.MeshStandardMaterial[];
  label: TextPanel;
  hands: HandView[];
  handTargets: (Vec3[] | null)[];
  handCurrent: (Vec3[] | null)[];
  targetPos: THREE.Vector3;
  targetQuat: THREE.Quaternion;
  lastPoseMs: number;
  tracking: boolean;
};
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
  const hands = [new HandView(0xe8eaed, 0.012), new HandView(0xe8eaed, 0.012)];
  for (const h of hands) field.add(h.group);
  const peer: Peer = {
    group,
    materials: [headMat, noseMat],
    label,
    hands,
    handTargets: [null, null],
    handCurrent: [null, null],
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
  peer.label.mesh.removeFromParent();
  peer.label.mesh.material.map?.dispose();
  peer.label.mesh.material.dispose();
  peer.label.mesh.geometry.dispose();
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
      for (const h of peer.hands) h.hide();
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
    peer.label.set(p ? `${p.name}（${id}）` : id, cssColor(color));
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

// ---- 試合の状態（サーバー権威）----
let selfId = "";
let netStatus = "idle";
let client: GameClient | null = null;
let joined = false;
let auth: { state: GameSnapshot; recvMs: number } | null = null;
let lastEventKey = "";
let startsSent = 0;
let lastRejectReason = "";
/** 「対戦開始」を送ってから state / rejected / 切断のいずれかが来るまで（二重送信の防止） */
let startPending = false;
/** 寸法の「反映」を送ってから field / rejected / 切断のいずれかが来るまで */
let fieldPending = false;
let fieldsSent = 0;

function colorOf(id: string): InkColor | null {
  return auth?.state.players.find((p) => p.id === id)?.color ?? null;
}
function colorHexOf(id: string): number {
  const c = colorOf(id);
  return c ? inkColorHex(c) : 0xe8eaed;
}
function cssColor(hex: number): string {
  return `#${hex.toString(16).padStart(6, "0")}`;
}
function localTimeOf(serverT: number, refServerT: number, refLocalMs: number): number {
  return refLocalMs + (serverT - refServerT);
}

function onState(state: GameSnapshot) {
  const now = performance.now();
  auth = { state, recvMs: now };
  if (state.phase === "waiting" || state.phase === "play") {
    startPending = false;
    lastRejectReason = "";
  }
  const ev = state.event;
  const key = ev ? `${state.seq}:${ev.kind}` : "";
  if (key && key !== lastEventKey) {
    lastEventKey = key;
    console.log(`[overview] event ${ev?.kind} phase=${state.phase} scores=${JSON.stringify(state.scores)} players=${state.players.length}`);
  }
  if (state.grids) {
    for (const [id, enc] of Object.entries(state.grids)) inkViews.get(id)?.redrawFromGrid(enc, fieldCfg.cellM);
    for (const s of state.shots) if (s.landing?.hit) splatted.add(s.seq);
  }
  for (const s of state.shots) if (!shots.has(s.seq)) addShot(s, state.t, now);
  renderPanel();
}

function connect() {
  if (ROOM === null) return;
  client = connectGame(
    ROOM,
    "",
    {
      markerId: MARKER_ID,
      markerMm: MARKER_MM,
      floorDrop: FLOOR_DROP,
      gravity: GRAVITY,
      matchSec: MATCH_SEC,
      waitSec: WAIT_SEC,
    },
    {
      onStatus: (status) => {
        netStatus = status;
        if (status !== "open") {
          joined = false;
          startPending = false;
          fieldPending = false;
        }
        renderPanel();
      },
      onError: (reason) => {
        netStatus = `error: ${reason}`;
        console.warn(`[overview] rejected: ${reason}`);
        renderPanel();
      },
      onWelcome: (id, role, peerIds, cfg, state) => {
        selfId = id;
        netStatus = "open";
        joined = true;
        applyFieldConfig(cfg);
        syncSizeInputs();
        [...peers.keys()].forEach(removePeer);
        peerIds.forEach(createPeer);
        lastEventKey = "";
        for (const s of shots.values()) s.mesh.removeFromParent();
        shots.clear();
        splatted.clear();
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
      onShot: (shot, serverT) => addShot(shot, serverT, performance.now()),
      onRejected: (reason) => {
        lastRejectReason = reason;
        startPending = false;
        fieldPending = false;
        console.log(`[overview] rejected by server: ${reason}`);
        renderPanel();
      },
      onState,
      onField: (cfg, state) => {
        fieldPending = false;
        lastRejectReason = "";
        applyFieldConfig(cfg);
        syncSizeInputs();
        for (const s of shots.values()) s.mesh.removeFromParent();
        shots.clear();
        splatted.clear();
        onState(state);
        console.log(`[overview] field ${cfg.wallW}x${cfg.wallH}x${cfg.floorDepth} (${state.totalCells} cells)`);
      },
    },
    "overview",
  );
}

// ---- インクの描画（main.ts と同じ: 権威の launch から同じ式で飛行を進め、着弾時刻に塗る）----
type LiveShot = { shot: Shot; launchLocalMs: number; mesh: THREE.Mesh };
const shots = new Map<number, LiveShot>();
const splatted = new Set<number>();

const splatSound = createSplatSound(SOUND);
addEventListener("pointerdown", () => splatSound.unlock());
addEventListener("pageshow", () => splatSound.unlock());
addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") splatSound.unlock();
});

function addShot(shot: Shot, serverT: number, recvMs: number) {
  const mesh = new THREE.Mesh(inkGeometry, inkMaterialOf(shot.color));
  mesh.scale.setScalar(shot.radius * 0.45);
  field.add(mesh);
  shots.set(shot.seq, { shot, launchLocalMs: localTimeOf(shot.launchedAt, serverT, recvMs), mesh });
}

const inkLookAt = new THREE.Vector3();
/** 飛んでいる玉を進行方向に少し伸ばす（main.ts と同じ） */
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

/** 着弾を飛沫の形で塗る（main.ts と同じ形。サーバーの格子とも同じ） */
function splatLanding(shot: Shot, now: number) {
  const landing = shot.landing;
  if (!landing?.hit) return;
  const surface = surfaces.find((s) => s.id === landing.surfaceId);
  const view = inkViews.get(landing.surfaceId);
  if (!surface || !view) return;
  const shape = splatShape(shot.seq, shot.radius, impactDirUv(landing, shot.vel, surface, fieldCfg.gravity), isWallSurface(surface));
  const overwrote = view.splat(shot.seq, landing.uv, shape, shot.color, now);
  splatSound.play(0.25, overwrote);
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
}

// ---- 操作パネル ----
const phaseEl = document.querySelector<HTMLDivElement>("#phase")!;
const startButton = document.querySelector<HTMLButtonElement>("#start-match")!;
const playersEl = document.querySelector<HTMLUListElement>("#players")!;
const statusEl = document.querySelector<HTMLDivElement>("#status")!;
const hud = document.querySelector<HTMLDivElement>("#hud")!;
/** フィールドの寸法の入力欄（幅・高さ・奥行き [m]）と「反映」。サーバーの config が届くたび入力欄を合わせる */
const sizeInputs: Record<keyof FieldSize, HTMLInputElement> = {
  wallW: document.querySelector<HTMLInputElement>("#size-wallW")!,
  wallH: document.querySelector<HTMLInputElement>("#size-wallH")!,
  floorDepth: document.querySelector<HTMLInputElement>("#size-floorDepth")!,
};
const applySizeButton = document.querySelector<HTMLButtonElement>("#apply-size")!;
const sizeHint = document.querySelector<HTMLDivElement>("#size-hint")!;
for (const key of FIELD_SIZE_KEYS) {
  sizeInputs[key].min = String(FIELD_SIZE_LIMITS[key].min);
  sizeInputs[key].max = String(FIELD_SIZE_LIMITS[key].max);
}

function syncSizeInputs() {
  for (const key of FIELD_SIZE_KEYS) sizeInputs[key].value = String(fieldCfg[key]);
  renderPanel();
}

/** 入力欄の値（不正なら null） */
function readSizeInputs(): FieldSize {
  return {
    wallW: Number(sizeInputs.wallW.value),
    wallH: Number(sizeInputs.wallH.value),
    floorDepth: Number(sizeInputs.floorDepth.value),
  };
}
function sizeInputsChanged(): boolean {
  const v = readSizeInputs();
  return FIELD_SIZE_KEYS.some((k) => v[k] !== fieldCfg[k]);
}

applySizeButton.addEventListener("click", () => {
  if (!client || fieldPending) return;
  const size = readSizeInputs();
  const invalid = validateFieldSize(size, fieldCfg.cellM);
  if (invalid) {
    lastRejectReason = invalid;
    renderPanel();
    return;
  }
  if (client.sendField(size)) {
    fieldsSent++;
    fieldPending = true;
    lastRejectReason = "";
    console.log(`[overview] field sent ${size.wallW}x${size.wallH}x${size.floorDepth}`);
  }
  renderPanel();
});
for (const key of FIELD_SIZE_KEYS) sizeInputs[key].addEventListener("input", () => renderPanel());

function remainingSec(now: number): number {
  if (!auth || auth.state.phaseEndsAt === null) return 0;
  return Math.max(0, (auth.state.phaseEndsAt - auth.state.t) / 1000 - (now - auth.recvMs) / 1000);
}

function gauge(c: number): string {
  const n = Math.round(Math.min(1, Math.max(0, c)) * 10);
  return "■".repeat(n) + "□".repeat(10 - n);
}

startButton.addEventListener("click", () => {
  if (!client || startPending) return;
  if (client.sendStart()) {
    startsSent++;
    startPending = true;
    lastRejectReason = "";
    console.log("[overview] start sent");
  }
  renderPanel();
});

let lastPanelKey = "";
function renderPanel() {
  const now = performance.now();
  const s = auth?.state;
  const left = Math.ceil(remainingSec(now));
  let phaseText = "接続中…";
  if (netStatus.startsWith("error")) phaseText = `接続できません: ${netStatus.slice(7)}`;
  else if (!joined || !s) phaseText = `サーバーに接続中… (${netStatus})`;
  else if (s.phase === "practice") phaseText = "練習中（自由に塗れます）";
  else if (s.phase === "waiting") phaseText = `開始まで ${left} 秒`;
  else if (s.phase === "play") phaseText = `対戦中 残り ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
  else {
    const w = s.winnerNames ?? [];
    phaseText = w.length === 0 ? "結果: だれも塗れず…" : `結果: ${w.join("・")} の勝ち！`;
  }
  const canStart = joined && s !== undefined && (s.phase === "practice" || s.phase === "result") && s.players.length > 0 && !startPending;
  // 寸法は練習中か結果表示中だけ変えられる（カウントダウン中・試合中は入力ごと無効）
  const sizeEditable = joined && s !== undefined && (s.phase === "practice" || s.phase === "result") && !fieldPending;
  const sizeInvalid = validateFieldSize(readSizeInputs(), fieldCfg.cellM);
  const canApplySize = sizeEditable && sizeInputsChanged() && sizeInvalid === null;
  const sizeHintText = !joined
    ? ""
    : sizeInvalid
      ? sizeInvalid
      : sizeInputsChanged()
        ? "「反映」で全員のフィールドが変わります（塗りは消えます）"
        : `いま: 幅 ${fieldCfg.wallW}m × 高さ ${fieldCfg.wallH}m × 奥行き ${fieldCfg.floorDepth}m（${s?.totalCells ?? 0} セル）`;
  const total = Math.max(1, s?.totalCells ?? 1);
  const ranking = s
    ? [...s.players]
        .sort((a, b) => (s.scores[b.id] ?? 0) - (s.scores[a.id] ?? 0))
        .map((p) => ({ p, pct: (((s.scores[p.id] ?? 0) / total) * 100).toFixed(1), ink: s.ink[p.id] ?? 1, win: s.winners?.includes(p.id) }))
    : [];
  const key = JSON.stringify([phaseText, canStart, startPending, ranking, netStatus, lastRejectReason, peers.size, sizeEditable, canApplySize, fieldPending, sizeHintText]);
  if (key === lastPanelKey) return;
  lastPanelKey = key;
  phaseEl.textContent = phaseText;
  startButton.disabled = !canStart;
  for (const key of FIELD_SIZE_KEYS) sizeInputs[key].disabled = !sizeEditable;
  applySizeButton.disabled = !canApplySize;
  applySizeButton.textContent = fieldPending ? "送信中…" : "反映";
  sizeHint.textContent = sizeHintText;
  startButton.textContent = startPending
    ? "送信中…"
    : s?.phase === "play"
      ? "対戦中"
      : s?.phase === "waiting"
        ? "カウントダウン中"
        : s && s.players.length === 0
          ? "プレイヤー待ち"
          : s?.phase === "result"
            ? "次の対戦を開始"
            : "対戦開始";
  playersEl.replaceChildren(
    ...ranking.map(({ p, pct, ink, win }) => {
      const li = document.createElement("li");
      const sw = document.createElement("span");
      sw.className = "swatch";
      sw.style.background = cssColor(inkColorHex(p.color));
      const name = document.createElement("span");
      name.textContent = `${p.name}（${inkColorName(p.color)}）${win ? " 🏆" : ""} ${pct}%`;
      const inkEl = document.createElement("span");
      inkEl.className = "ink";
      inkEl.textContent = gauge(ink);
      li.append(sw, name, inkEl);
      return li;
    }),
  );
  if (ranking.length === 0 && joined) {
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
  const text = s
    ? `overview: room=${ROOM} me=${selfId} ws=${netStatus} phase=${s.phase} left=${remainingSec(now).toFixed(0)}s players=${s.players.map((p) => `${p.id}:${p.color}`).join(",")} scores=${s.players.map((p) => `${p.id}:${s.scores[p.id] ?? 0}`).join(",")} total=${s.totalCells} field=${fieldCfg.wallW}x${fieldCfg.wallH}x${fieldCfg.floorDepth} live=${shots.size} seq=${s.seq} starts=${startsSent} fields=${fieldsSent}`
    : `overview: room=${ROOM} ws=${netStatus}`;
  if (text !== lastHudText) {
    lastHudText = text;
    hud.textContent = text;
  }
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
  updateShots(now);
  for (const v of inkViews.values()) v.update(now);
  if (now - lastPanelMs > 250) {
    lastPanelMs = now;
    renderPanel();
  }
  renderHud();
  renderer.render(scene, camera);
});
