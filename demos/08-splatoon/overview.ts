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
import { FACE_LABELS, MARKER_FACES, MAX_EXTRA_MARKERS, SUGGESTED_MARKERS, describeMarkers, markerToFieldMatrix, suggestedMarkerPos, validateMarkerLayout } from "../../src/shared/marker-layout";
import type { MarkerFace, MarkerPlacement } from "../../src/shared/marker-layout";
import { draggedMarkerPos, faceNormal, rayPlaneHit } from "../../src/shared/marker-drag";
import { connectGame } from "./game-client";
import type { GameClient } from "./game-client";
import { InkView, inkColorHex, inkColorName } from "./ink-view";
import { impactDirUv, isWallSurface, splatShape } from "../../src/shared/splat-shape";
import { createSplatSound } from "./splat-sound";

// Phase 8 / issue #19・#21: PC の俯瞰画面。カメラもゴーグルも使わず、同じ room に「俯瞰」役で入って
// コート全体（四方の壁 + 床の塗り）・全員の頭と手・飛んでいるインクを描き、「対戦開始」「フィールドの寸法」「追加マーカーの配置」を送る唯一の端末。
// 追加マーカー（issue #30）は配置どおりの位置に枠と ID を描き、各プレイヤーがいまどのマーカーで位置合わせしているかを一覧に出す（貼りズレの診断用）。
// 枠は入力欄の行（未送信の下書き）を描き、3D の枠をドラッグすると行の X/Y/Z が書き換わる（issue #43。送るのは今までどおり「反映」）。
// マーカー以外を掴むと空間全体が回る（OrbitControls）。
// 座標系はスマホと同じ field 座標系（マーカー座標系）で、ここではそれをワールド座標にそのまま置く。
// 描画のうち塗り（InkView）・飛行（inkAt）・ピアの頭と手は main.ts と同じ式（俯瞰なので視点だけ違う）

// ---- パラメータ（room の設定はスマホと一致が必要。サーバーが検証する）----
// フィールドの寸法（幅・高さ・奥行き・マーカーの高さ）は URL ではなくこの画面の入力欄で決め、サーバーに送る（welcome / field で戻ってくる）
const roomRaw = params.get("room");
const ROOM = roomRaw === null ? "demo" : ROOM_ID_PATTERN.test(roomRaw) ? roomRaw : null;
const MARKER_MM = numParam("markerMm", 100, { max: 5000 });
const MARKER_ID = Math.round(numParam("markerId", 0, { min: 0, max: 999 }));
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
// 「箱を持って回す」手触り（issue #43）: 回転の中心はコートの箱の中心（fitCamera）、離しても少し回り続ける慣性
controls.enableDamping = true;
controls.dampingFactor = 0.12;

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

/** サーバーの config を取り込む。壁と床の形に効く値が変わっていたら作り直す（追加マーカーの枠は行から描くので renderPanel が更新する） */
function applyFieldConfig(cfg: FieldConfig): boolean {
  const changed = cfg.wallW !== fieldCfg.wallW || cfg.wallH !== fieldCfg.wallH || cfg.floorDepth !== fieldCfg.floorDepth || cfg.floorDrop !== fieldCfg.floorDrop || cfg.cellM !== fieldCfg.cellM;
  fieldCfg = cfg;
  if (changed) buildField();
  return changed;
}
// マーカーの枠（壁の原点。スマホの位置合わせの基準がどこかを示す）
const markerFrameGeometry = new THREE.PlaneGeometry(MARKER_MM / 1000, MARKER_MM / 1000);
field.add(new THREE.Mesh(markerFrameGeometry, new THREE.MeshBasicMaterial({ color: 0x8ab4f8, transparent: true, opacity: 0.5, side: THREE.DoubleSide })));
field.add(new THREE.AxesHelper(0.3));
// 追加マーカーの枠 + ID（issue #30）。入力欄の行（使う行）を配置どおりの位置と向きに描く（スマホ側の枠と同じ。貼る位置の目安）。
// サーバーの配置と同じ枠は黄、まだ「反映」していない下書きはオレンジ（issue #43）。枠は掴んでドラッグできる
const markerFrames = new THREE.Group();
field.add(markerFrames);
const MARKER_FRAME_COLOR = 0xfdd663;
const MARKER_DRAFT_COLOR = 0xf5a05a;
/** 枠（見た目）と、それより広い見えない掴み領域（10cm の枠は俯瞰の距離だと十数 px しかなく掴みにくい） */
type MarkerFrame = { mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>; hit: THREE.Mesh; label: TextPanel; rowIndex: number };
const MARKER_GRAB_M = Math.max(0.3, (MARKER_MM / 1000) * 1.5);
const markerGrabGeometry = new THREE.PlaneGeometry(MARKER_GRAB_M, MARKER_GRAB_M);
const markerGrabMaterial = new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide });
let markerFrameList: MarkerFrame[] = [];
let markerFramesKey = "";
/**
 * 行 → 枠。使う行の数・面・ID が変わったら作り直し、位置と色は毎回そのまま書き直す（ドラッグ中は毎 move で呼ばれるので、
 * 位置だけの変化でテクスチャを作り直さない）。位置が空欄・数値でない行の枠は隠す
 */
function syncMarkerFrames() {
  const rows = markerRows.map((r, i) => ({ row: r, i })).filter(({ row }) => row.use.checked);
  const key = rows.map(({ row, i }) => `${i}:${row.face.value}:${row.id.value}`).join("|");
  if (key !== markerFramesKey) {
    markerFramesKey = key;
    // 古い枠を指したままにしない（作り直した枠は次の pointermove で当て直す）
    hoverFrame = null;
    updateCursor();
    for (const f of markerFrameList) {
      f.mesh.removeFromParent();
      f.mesh.material.dispose();
      f.label.mesh.material.map?.dispose();
      f.label.mesh.material.dispose();
      f.label.mesh.geometry.dispose();
    }
    markerFrameList = rows.map(({ row, i }) => {
      const mesh = new THREE.Mesh(markerFrameGeometry, new THREE.MeshBasicMaterial({ color: MARKER_FRAME_COLOR, transparent: true, opacity: 0.6, side: THREE.DoubleSide }));
      mesh.matrixAutoUpdate = false;
      const label = new TextPanel(0.3, 0.09, 256, 6);
      label.mesh.position.set(0, (MARKER_MM / 1000) * 0.9, 0.005);
      label.set(`${FACE_LABELS[row.face.value as MarkerFace]} ${row.id.value}`, cssColor(MARKER_FRAME_COLOR));
      mesh.add(label.mesh);
      const hit = new THREE.Mesh(markerGrabGeometry, markerGrabMaterial);
      mesh.add(hit);
      markerFrames.add(mesh);
      return { mesh, hit, label, rowIndex: i };
    });
  }
  const server = fieldCfg.markers ?? [];
  for (const f of markerFrameList) {
    const m = rowPlacement(markerRows[f.rowIndex]);
    const valid = m.pos.every(Number.isFinite);
    f.mesh.visible = valid;
    if (!valid) continue;
    f.mesh.matrix.fromArray(markerToFieldMatrix(m));
    const sent = server.some((s) => s.id === m.id && s.face === m.face && s.pos.every((v, k) => v === m.pos[k]));
    const hovered = hoverFrame === f || drag?.frame === f;
    f.mesh.material.color.setHex(sent ? MARKER_FRAME_COLOR : MARKER_DRAFT_COLOR);
    f.mesh.material.opacity = hovered ? 0.9 : 0.6;
  }
  // 作り直した直後の pointerdown でも当たるよう、描画を待たずワールド行列を更新しておく
  markerFrames.updateMatrixWorld(true);
}

// 視点: コートの後方上空から壁を見下ろす。OrbitControls で回せる（回転の中心はコートの箱の中心）
function fitCamera() {
  const { wallW, wallH, floorDrop, floorDepth } = fieldCfg;
  camera.position.set(wallW * 0.9, -floorDrop + wallH * 1.1, floorDepth + wallW * 0.9);
  controls.target.set(0, -floorDrop + wallH / 2, floorDepth / 2);
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
  /** いま位置合わせに使っているマーカーの ID（pose.markerIds。ロスト中は空） */
  markerIds: number[];
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
    markerIds: [],
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
  peer.markerIds = pose.tracking ? (pose.markerIds ?? []) : [];
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
let stopsSent = 0;
let lastRejectReason = "";
/** 「対戦開始」を送ってから state / rejected / 切断のいずれかが来るまで（二重送信の防止） */
let startPending = false;
/** 「対戦を終了」を送ってから state / rejected / 切断のいずれかが来るまで */
let stopPending = false;
/** 寸法の「反映」を送ってから field / rejected / 切断のいずれかが来るまで */
let fieldPending = false;
let fieldsSent = 0;
/** 追加マーカーの「反映」を送ってから markers / rejected / 切断のいずれかが来るまで */
let markersPending = false;
let markersSent = 0;

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
  if (state.phase === "practice" || state.phase === "result") stopPending = false;
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
          stopPending = false;
          fieldPending = false;
          markersPending = false;
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
        syncMarkerRows();
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
        stopPending = false;
        fieldPending = false;
        markersPending = false;
        console.log(`[overview] rejected by server: ${reason}`);
        renderPanel();
      },
      onState,
      onField: (cfg, state) => {
        fieldPending = false;
        lastRejectReason = "";
        applyFieldConfig(cfg);
        syncSizeInputs();
        // 追加マーカーの行はここでは同期しない（未送信の編集が消える。外部レビュー指摘）。床の Y は renderPanel が寸法から書き直す
        renderPanel();
        for (const s of shots.values()) s.mesh.removeFromParent();
        shots.clear();
        splatted.clear();
        onState(state);
        console.log(`[overview] field ${cfg.wallW}x${cfg.wallH}x${cfg.floorDepth}/${cfg.floorDrop} (${state.totalCells} cells)`);
      },
      onMarkers: (cfg) => {
        markersPending = false;
        lastRejectReason = "";
        applyFieldConfig(cfg);
        syncMarkerRows();
        console.log(`[overview] markers ${describeMarkers(cfg.markers)}`);
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
const stopButton = document.querySelector<HTMLButtonElement>("#stop-match")!;
const playersEl = document.querySelector<HTMLUListElement>("#players")!;
const statusEl = document.querySelector<HTMLDivElement>("#status")!;
const hud = document.querySelector<HTMLDivElement>("#hud")!;
/** フィールドの寸法の入力欄（幅・高さ・奥行き・マーカーの高さ [m]）と「反映」。サーバーの config が届くたび入力欄を合わせる */
const sizeInputs: Record<keyof FieldSize, HTMLInputElement> = {
  wallW: document.querySelector<HTMLInputElement>("#size-wallW")!,
  wallH: document.querySelector<HTMLInputElement>("#size-wallH")!,
  floorDepth: document.querySelector<HTMLInputElement>("#size-floorDepth")!,
  floorDrop: document.querySelector<HTMLInputElement>("#size-floorDrop")!,
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

// ---- 追加マーカーの配置（issue #30）: 行 = 1 枚（使う / 面 / ID / X / Y / Z）。おすすめの割り当てを既定値にする ----
type MarkerRow = { root: HTMLDivElement; use: HTMLInputElement; face: HTMLSelectElement; id: HTMLInputElement; pos: [HTMLInputElement, HTMLInputElement, HTMLInputElement] };
const markerRowsEl = document.querySelector<HTMLDivElement>("#marker-rows")!;
const applyMarkersButton = document.querySelector<HTMLButtonElement>("#apply-markers")!;
const markersHint = document.querySelector<HTMLDivElement>("#markers-hint")!;
/**
 * 行の既定値。サーバーの上限（MAX_EXTRA_MARKERS）ぶん用意する（足りないと他の端末が保存した配置を表示できず、反映で消してしまう）。
 * おすすめの 5 枚の後は予備。既定の ID は原点（room の markerId）と重ならないよう空いている番号へずらす
 */
const ROW_DEFAULTS: readonly { face: MarkerFace; id: number }[] = (() => {
  const used = new Set<number>([MARKER_ID]);
  const alloc = (want: number) => {
    let id = want;
    while (used.has(id)) id++;
    used.add(id);
    return id;
  };
  return [
    ...SUGGESTED_MARKERS.map((s) => ({ face: s.face, id: alloc(s.id) })),
    ...Array.from({ length: Math.max(0, MAX_EXTRA_MARKERS - SUGGESTED_MARKERS.length) }, (_, i) => ({ face: "wall" as MarkerFace, id: alloc(SUGGESTED_MARKERS.length + 1 + i) })),
  ];
})();
const markerRows: MarkerRow[] = ROW_DEFAULTS.map((suggested) => {
  const root = document.createElement("div");
  root.className = "row off";
  const use = document.createElement("input");
  use.type = "checkbox";
  use.title = "このマーカーを使う";
  const face = document.createElement("select");
  for (const f of MARKER_FACES) {
    const opt = document.createElement("option");
    opt.value = f;
    opt.textContent = FACE_LABELS[f];
    face.append(opt);
  }
  face.value = suggested.face;
  const id = document.createElement("input");
  id.type = "number";
  id.min = "0";
  id.step = "1";
  id.inputMode = "numeric";
  id.value = String(suggested.id);
  const pos = [0, 1, 2].map(() => {
    const i = document.createElement("input");
    i.type = "number";
    i.step = "0.05";
    i.inputMode = "decimal";
    return i;
  }) as MarkerRow["pos"];
  root.append(use, face, id, ...pos);
  markerRowsEl.append(root);
  const row: MarkerRow = { root, use, face, id, pos };
  // 面を変えたら既定の位置を入れ直す（床は Y を床の高さに固定）
  face.addEventListener("change", () => {
    setRowPos(row, suggestedMarkerPos(face.value as MarkerFace, fieldCfg));
    renderPanel();
  });
  use.addEventListener("change", () => renderPanel());
  for (const el of [id, ...pos]) el.addEventListener("input", () => renderPanel());
  return row;
});
function setRowPos(row: MarkerRow, p: readonly number[]) {
  for (let k = 0; k < 3; k++) row.pos[k].value = String(p[k]);
}
/**
 * 行 → 配置（使う行だけ）。空欄・数値でない入力は valueAsNumber の NaN のまま渡して validateMarkerLayout に弾かせる
 * （Number("") は 0 になり、入力途中の空欄が「原点の位置」として配られてしまう。外部レビュー指摘）
 */
function readMarkerRows(): MarkerPlacement[] {
  return markerRows.filter((row) => row.use.checked).map(rowPlacement);
}
/** 1 行 → 配置（使う / 使わないは見ない）。床の Y は入力欄に関係なく床の高さ（寸法から） */
function rowPlacement(row: MarkerRow): MarkerPlacement {
  const face = row.face.value as MarkerFace;
  const y = face === "floor" ? -fieldCfg.floorDrop : row.pos[1].valueAsNumber;
  return { id: row.id.valueAsNumber, face, pos: [row.pos[0].valueAsNumber, y, row.pos[2].valueAsNumber] };
}
/** 追加マーカーを変えられるか（練習中か結果表示中で、送信中でない。行の入力欄とドラッグで共通） */
function markersEditable(): boolean {
  const s = auth?.state;
  return joined && s !== undefined && (s.phase === "practice" || s.phase === "result") && !markersPending;
}

// ---- 3D の枠のドラッグ（issue #43）: 枠を掴むとその面の平面上で動かし、行の X/Y/Z に書き戻す。枠以外を掴むと OrbitControls で空間が回る ----
// OrbitControls も同じ canvas の pointerdown を見るので、枠に当たったときは親（#app）の capture で先に受けて伝播を止める
const appEl = document.querySelector<HTMLDivElement>("#app")!;
const raycaster = new THREE.Raycaster();
const pointerNdc = new THREE.Vector2();
type Drag = { frame: MarkerFrame; row: MarkerRow; face: MarkerFace; pos0: V3; hit0: V3; normal: V3; pointerId: number };
let drag: Drag | null = null;
let hoverFrame: MarkerFrame | null = null;
/** ドラッグで行を書き換えた回数（HUD。ヘッドレス確認用） */
let markerDrags = 0;

/** 画面の点 → レイ（field 座標系 = ワールド）。origin と dir を配列で返す（marker-drag.ts の純粋関数に渡す） */
function pointerRay(e: { clientX: number; clientY: number }): { origin: V3; dir: V3 } {
  const rect = renderer.domElement.getBoundingClientRect();
  pointerNdc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(pointerNdc, camera);
  const { origin, direction } = raycaster.ray;
  return { origin: [origin.x, origin.y, origin.z], dir: [direction.x, direction.y, direction.z] };
}
/** 画面の点の下にある枠（掴み領域で判定。手前のもの）。ラベルは当てない */
function frameAt(e: { clientX: number; clientY: number }): MarkerFrame | null {
  pointerRay(e);
  const hits = raycaster.intersectObjects(
    markerFrameList.filter((f) => f.mesh.visible).map((f) => f.hit),
    false,
  );
  if (hits.length === 0) return null;
  return markerFrameList.find((f) => f.hit === hits[0].object) ?? null;
}
function updateCursor() {
  renderer.domElement.style.cursor = drag ? "grabbing" : hoverFrame ? "grab" : "";
}

/**
 * OrbitControls の慣性の残りを使い切る。`enabled = false` は入力を止めるだけで、毎フレームの `update()` が残った damping を
 * 適用し続けるので、空間を回した直後に枠を掴むとドラッグ中もカメラが動いてレイがずれる（codex レビュー指摘）。
 * damping を切って 1 回 update すると残りの回転を一度に適用して 0 に戻す（レイを計算する前に呼ぶ）
 */
function settleOrbit() {
  controls.enableDamping = false;
  controls.update();
  controls.enableDamping = true;
}
/** ドラッグを中断する（行の同期・編集不可への遷移・ポインタの解放。行の値はその時点のまま） */
function cancelDrag() {
  if (!drag) return;
  try {
    renderer.domElement.releasePointerCapture(drag.pointerId);
  } catch {
    // 取れていなければ何もしない
  }
  drag = null;
  controls.enabled = true;
  updateCursor();
}

appEl.addEventListener(
  "pointerdown",
  (e) => {
    if (e.button !== 0 || drag || !markersEditable()) return;
    if (!frameAt(e)) return;
    // 枠に当たった。慣性の残りを使い切ってから、同じカメラで当たり判定と掴み点をやり直す
    // （慣性で跳んだ後のカメラで掴み点を計算すると平面の遠い点になり、少しの移動で枠が数 m 飛ぶ）
    settleOrbit();
    const frame = frameAt(e);
    if (!frame) return;
    const row = markerRows[frame.rowIndex];
    const m = rowPlacement(row);
    const normal = faceNormal(m.face);
    const { origin, dir } = pointerRay(e);
    const hit0 = rayPlaneHit(origin, dir, m.pos, normal);
    if (!hit0) return;
    e.stopPropagation();
    e.preventDefault();
    // 伝播を止めるので window の pointerdown（着弾の音の解錠）に届かない。ここで解錠しておく
    splatSound.unlock();
    controls.enabled = false;
    drag = { frame, row, face: m.face, pos0: m.pos, hit0, normal, pointerId: e.pointerId };
    try {
      renderer.domElement.setPointerCapture(e.pointerId);
    } catch {
      // 合成イベント（pointerId が無い）では取れない。ドラッグは動く
    }
    updateCursor();
    renderPanel();
  },
  { capture: true },
);
renderer.domElement.addEventListener("pointermove", (e) => {
  if (drag) {
    if (e.pointerId !== drag.pointerId) return;
    // ドラッグ中に試合が始まる・切断するなどで編集できなくなったら、そこで止める（行は無効化されているのに書き換え続けない）
    if (!markersEditable()) {
      cancelDrag();
      renderPanel();
      return;
    }
    const { origin, dir } = pointerRay(e);
    const hit = rayPlaneHit(origin, dir, drag.pos0, drag.normal);
    if (!hit) return;
    const next = draggedMarkerPos(drag.face, drag.pos0, drag.hit0, hit, e.shiftKey);
    const cur = rowPlacement(drag.row).pos;
    if (next.every((v, k) => v === cur[k])) return;
    setRowPos(drag.row, next);
    markerDrags++;
    renderPanel();
    return;
  }
  const frame = markersEditable() ? frameAt(e) : null;
  if (frame !== hoverFrame) {
    hoverFrame = frame;
    updateCursor();
    syncMarkerFrames();
  }
});
function endDrag(e: PointerEvent) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  cancelDrag();
  hoverFrame = frameAt(e);
  updateCursor();
  renderPanel();
}
// pointerup は window で受ける（setPointerCapture が取れなかったとき canvas の外で離しても取りこぼさない）
addEventListener("pointerup", endDrag);
addEventListener("pointercancel", endDrag);
renderer.domElement.addEventListener("lostpointercapture", endDrag);
renderer.domElement.addEventListener("pointerleave", () => {
  if (drag || !hoverFrame) return;
  hoverFrame = null;
  updateCursor();
  syncMarkerFrames();
});
/** 行とサーバーの配置が違うか（順序は問わない: 行は ID で埋めるのでサーバーの並びと一致しないことがある） */
function markerRowsChanged(): boolean {
  const key = (ms: readonly MarkerPlacement[]) => JSON.stringify([...ms].sort((a, b) => a.id - b.id));
  return key(readMarkerRows()) !== key(fieldCfg.markers ?? []);
}
/**
 * サーバーの配置（fieldCfg.markers）を行に反映する。同じ ID の行があればそこへ、無ければ空いている行へ。
 * 残りの行は使わない状態にしておすすめの値を入れる
 */
function syncMarkerRows() {
  // ドラッグ中に届いたら（自分の「反映」の応答か、別の俯瞰画面の変更）ドラッグは中断し、行はサーバーの配置に揃える
  cancelDrag();
  const markers = fieldCfg.markers ?? [];
  const assigned = new Map<MarkerRow, MarkerPlacement>();
  const pending: MarkerPlacement[] = [];
  for (const m of markers) {
    const row = markerRows.find((r) => r.id.valueAsNumber === m.id && !assigned.has(r));
    if (row) assigned.set(row, m);
    else pending.push(m);
  }
  for (const m of pending) {
    const row = markerRows.find((r) => !assigned.has(r));
    if (row) assigned.set(row, m);
    else console.warn(`[overview] 追加マーカー ${m.id}:${m.face} は行が足りず表示できません（反映すると消えます）`);
  }
  markerRows.forEach((row, i) => {
    const m = assigned.get(row);
    if (m) {
      row.use.checked = true;
      row.face.value = m.face;
      row.id.value = String(m.id);
      setRowPos(row, m.pos);
    } else {
      const suggested = ROW_DEFAULTS[i];
      row.use.checked = false;
      row.face.value = suggested.face;
      row.id.value = String(suggested.id);
      setRowPos(row, suggestedMarkerPos(suggested.face, fieldCfg));
    }
  });
  renderPanel();
}
applyMarkersButton.addEventListener("click", () => {
  if (!client || markersPending) return;
  const markers = readMarkerRows();
  const invalid = validateMarkerLayout(markers, MARKER_ID, fieldCfg.floorDrop);
  if (invalid) {
    lastRejectReason = invalid;
    renderPanel();
    return;
  }
  if (client.sendMarkers(markers)) {
    markersSent++;
    markersPending = true;
    lastRejectReason = "";
    console.log(`[overview] markers sent ${describeMarkers(markers)}`);
  }
  renderPanel();
});

/** 入力欄の値（不正なら null） */
function readSizeInputs(): FieldSize {
  return {
    wallW: Number(sizeInputs.wallW.value),
    wallH: Number(sizeInputs.wallH.value),
    floorDepth: Number(sizeInputs.floorDepth.value),
    floorDrop: Number(sizeInputs.floorDrop.value),
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
    console.log(`[overview] field sent ${size.wallW}x${size.wallH}x${size.floorDepth}/${size.floorDrop}`);
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
// 途中終了（issue #32）: 試合中は即座に結果へ、カウントダウン中は中止して練習へ。確認ダイアログは出さない（運営の操作なので即時）
stopButton.addEventListener("click", () => {
  if (!client || stopPending) return;
  if (client.sendStop()) {
    stopsSent++;
    stopPending = true;
    lastRejectReason = "";
    console.log("[overview] stop sent");
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
  const canStop = joined && s !== undefined && (s.phase === "waiting" || s.phase === "play") && !stopPending;
  const stopText = stopPending ? "送信中…" : s?.phase === "waiting" ? "カウントダウンを中止" : "対戦を終了";
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
        : `いま: 幅 ${fieldCfg.wallW}m × 高さ ${fieldCfg.wallH}m × 奥行き ${fieldCfg.floorDepth}m、マーカーの高さ ${fieldCfg.floorDrop}m（${s?.totalCells ?? 0} セル）`;
  // 追加マーカーも練習中か結果表示中だけ（寸法と同じ）。床の行の Y は寸法から決まるので入力不可
  const canEditMarkers = markersEditable();
  const markerRowsValue = readMarkerRows();
  const markersInvalid = validateMarkerLayout(markerRowsValue, MARKER_ID, fieldCfg.floorDrop);
  const canApplyMarkers = canEditMarkers && markerRowsChanged() && markersInvalid === null;
  // 3D の枠は行の下書きを描く（ドラッグ中は毎 move で来る。位置と色だけ書き直すので軽い）
  syncMarkerFrames();
  const markersHintText = !joined
    ? ""
    : markersInvalid
      ? markersInvalid
      : markerRowsChanged()
        ? "「反映」で全員の位置合わせに使うマーカーが変わります（塗りは消えません）"
        : `いま: ${(fieldCfg.markers ?? []).length === 0 ? "正面のマーカーだけ" : (fieldCfg.markers ?? []).map((m) => `${FACE_LABELS[m.face]} ${m.id} (${m.pos.join(", ")})`).join(" / ")}`;
  const rowStates = markerRows.map((r) => `${r.use.checked}:${r.face.value}`);
  const total = Math.max(1, s?.totalCells ?? 1);
  const ranking = s
    ? [...s.players]
        .sort((a, b) => (s.scores[b.id] ?? 0) - (s.scores[a.id] ?? 0))
        .map((p) => {
          const peer = peers.get(p.id);
          const marker = !peer || peer.lastPoseMs === -Infinity || now - peer.lastPoseMs > PEER_STALE_MS ? "-" : !peer.tracking ? "ロスト（最後の姿勢を維持）" : peer.markerIds.length > 0 ? peer.markerIds.join("+") : "?";
          return { p, pct: (((s.scores[p.id] ?? 0) / total) * 100).toFixed(1), ink: s.ink[p.id] ?? 1, win: s.winners?.includes(p.id), marker };
        })
    : [];
  const key = JSON.stringify([phaseText, canStart, startPending, canStop, stopText, ranking, netStatus, lastRejectReason, peers.size, sizeEditable, canApplySize, fieldPending, sizeHintText, canEditMarkers, canApplyMarkers, markersPending, markersHintText, rowStates]);
  if (key === lastPanelKey) return;
  lastPanelKey = key;
  phaseEl.textContent = phaseText;
  startButton.disabled = !canStart;
  stopButton.disabled = !canStop;
  stopButton.textContent = stopText;
  for (const key of FIELD_SIZE_KEYS) sizeInputs[key].disabled = !sizeEditable;
  applySizeButton.disabled = !canApplySize;
  applySizeButton.textContent = fieldPending ? "送信中…" : "反映";
  sizeHint.textContent = sizeHintText;
  for (const row of markerRows) {
    row.use.disabled = !canEditMarkers;
    row.root.classList.toggle("off", !row.use.checked);
    const isFloor = row.face.value === "floor";
    if (isFloor) row.pos[1].value = String(-fieldCfg.floorDrop);
    row.face.disabled = !canEditMarkers;
    row.id.disabled = !canEditMarkers;
    row.pos[0].disabled = !canEditMarkers;
    row.pos[1].disabled = !canEditMarkers || isFloor;
    row.pos[1].title = isFloor ? "床のマーカーの高さは「マーカーの高さ」から自動" : "";
    row.pos[2].disabled = !canEditMarkers;
  }
  if (!canEditMarkers && hoverFrame) {
    hoverFrame = null;
    updateCursor();
  }
  applyMarkersButton.disabled = !canApplyMarkers;
  applyMarkersButton.textContent = markersPending ? "送信中…" : "反映";
  markersHint.textContent = markersHintText;
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
    ...ranking.map(({ p, pct, ink, win, marker }) => {
      const li = document.createElement("li");
      const sw = document.createElement("span");
      sw.className = "swatch";
      sw.style.background = cssColor(inkColorHex(p.color));
      const name = document.createElement("span");
      name.textContent = `${p.name}（${inkColorName(p.color)}）${win ? " 🏆" : ""}`;
      const pctEl = document.createElement("span");
      pctEl.className = "pct";
      pctEl.textContent = `${pct}%`;
      const inkEl = document.createElement("span");
      inkEl.className = "ink";
      inkEl.textContent = gauge(ink);
      const markerEl = document.createElement("span");
      markerEl.className = "marker";
      markerEl.textContent = `位置合わせ: マーカー ${marker}`;
      li.append(sw, name, pctEl, inkEl, markerEl);
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
    ? `overview: room=${ROOM} me=${selfId} ws=${netStatus} phase=${s.phase} left=${remainingSec(now).toFixed(0)}s players=${s.players.map((p) => `${p.id}:${p.color}`).join(",")} scores=${s.players.map((p) => `${p.id}:${s.scores[p.id] ?? 0}`).join(",")} total=${s.totalCells} field=${fieldCfg.wallW}x${fieldCfg.wallH}x${fieldCfg.floorDepth}/${fieldCfg.floorDrop} markers=${describeMarkers(fieldCfg.markers ?? [])} live=${shots.size} seq=${s.seq} starts=${startsSent} stops=${stopsSent} fields=${fieldsSent} markersSent=${markersSent} markerDrags=${markerDrags} peerMarkers=${[...peers].map(([id, p]) => `${id}:${p.tracking ? p.markerIds.join("+") || "?" : "lost"}`).join(",")}`
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

// ヘッドレス確認用（scripts/headless-splatoon.mjs）: 行の枠の画面座標と視点の位置。CDP の実マウスでドラッグして確かめる
const projected = new THREE.Vector3();
(window as Window & { __overviewDebug?: unknown }).__overviewDebug = {
  /** 行番号 → 枠の中心の画面座標 [x, y]（CSS px。枠が無い・画面外なら null） */
  markerScreen(rowIndex: number): [number, number] | null {
    const f = markerFrameList.find((x) => x.rowIndex === rowIndex);
    if (!f || !f.mesh.visible) return null;
    projected.setFromMatrixPosition(f.mesh.matrixWorld).project(camera);
    if (Math.abs(projected.x) > 1 || Math.abs(projected.y) > 1) return null;
    const rect = renderer.domElement.getBoundingClientRect();
    return [rect.left + ((projected.x + 1) / 2) * rect.width, rect.top + ((1 - projected.y) / 2) * rect.height];
  },
  cameraPos: (): V3 => [camera.position.x, camera.position.y, camera.position.z],
};

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
