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
import {
  isTouchDevice,
  runStartFlow,
  setupFullscreen,
} from "../../src/shared/start-flow";
import { createMarkerAnchor } from "../../src/shared/marker-anchor";
import type { MarkerAnchor } from "../../src/shared/marker-anchor";
import { createHandTracker } from "../../src/shared/hand-tracker";
import type { HandTracker } from "../../src/shared/hand-tracker";
import { HandView } from "../../src/shared/hand-view";
import {
  FINGER_TIPS,
  LANDMARK_COUNT,
  WRIST,
  placeLandmarks,
  solveHandPlacement,
} from "../../src/shared/hand-math";
import type { Vec3, ViewMapping } from "../../src/shared/hand-math";
import { ROOM_ID_PATTERN } from "../../src/shared/shared-room-protocol";
import markerSvgUrl from "../../src/shared/marker-0.svg";
import {
  DEFAULT_COURT,
  aimPoint,
  botAimPoint,
  extrapolateBall,
  otherSide,
  returnVelocity,
} from "../../src/shared/volleyball-sim";
import type {
  BallState,
  CourtConfig,
  GameState,
  Side,
  V3,
} from "../../src/shared/volleyball-sim";
import type { PlayerPose } from "../../src/shared/volleyball-protocol";
import { connectGame } from "./game-client";
import type { GameClient } from "./game-client";
import { scriptedVolleyHand } from "./fake-volley-hand";

// Phase 6: MR バレーボール。これまでのフェーズの統合（統合ゲーム第1弾）。
//   - 共通座標系: マーカー（03/04）。机のマーカーの真上にネットを立て、マーカーを挟んで向かい合う
//   - 通信: サーバー権威（server/volleyball.ts）。ボールの物理・得点・bot はサーバーが持ち、
//     クライアントは同じ式（volleyball-sim.ts）で権威状態から外挿して描く
//   - 手: MediaPipe（05）。指先・手のひらがボールに触れたら hit をサーバーへ送る。
//     当たり判定は手を持つ本人の端末でしか行えないのでクライアント側、打ち返しの方向・速さは
//     サーバー側（相手の顔の前へ自動で狙う。3DoF + 手のブレでは方向を制御できないため）
//   - マーカーロスト時（ボールを見上げる等）: 04 と違いアンカーを最後の姿勢のまま維持し、
//     ジャイロ（3DoF）で回転だけ追従する。その場に立っている限りズレは小さい
// パススルー・開始フロー・マーカー・手の各処理は Phase 6 で src/shared/ に抽出したものを使う
// （02〜05 のデモ内の複製はそのまま残している）

// ---- パラメータ ----
// fov / camZoom の既定は 05 と同じ実機較正値（VR ゴーグル + iPhone）。PC では ?fov=70&camZoom=1
const FOV = numParam("fov", 135, { min: 20, max: 170 });
const EYE_SEP = numParam("eyeSep", 0.064, { min: 0, max: 0.2 });
const CAM_ZOOM = numParam("camZoom", 0.7, { min: 0.2, max: 5 });
const CAM_RES = resolutionParam("camRes", [1280, 720]);

// マーカー（04 と同じ既定）
const MARKER_MM = numParam("markerMm", 100, { max: 5000 });
const MARKER_SIZE_M = MARKER_MM / 1000;
const MARKER_ID = Math.round(numParam("markerId", 0, { min: 0, max: 999 }));
const MAX_POSE_ERROR = numParam("maxPoseError", 0.5, { min: 0, max: 100 });
const MARKER_DET_W = numParam("detW", 960, { min: 64, max: 4096 });
const MARKER_SMOOTH = numParam("smooth", 0.25, { min: 0.01, max: 1 });
// 手の推論（GPU 18ms）とマーカー検出（960px で 20ms）を毎フレーム両方回すと描画が持たないので、
// マーカーは 10Hz に間引く（アンカーは静止物なので低頻度の補正で足りる）
const MARKER_INTERVAL_MS = numParam("markerIntervalMs", 100, { min: 0, max: 2000 });
// この時間マーカーが見えなければ tracking=false として送る（表示は消さない）
const MARKER_LOST_MS = numParam("lostMs", 500, { min: 50, max: 10000 });

// 手（05 と同じ既定。detW は名前が衝突するので handDetW）
const NUM_HANDS = Math.round(numParam("hands", 1, { min: 1, max: 2 }));
const delegateRaw = (params.get("delegate") ?? "auto").toLowerCase();
const DELEGATE =
  delegateRaw === "gpu" ? "GPU" : delegateRaw === "cpu" ? "CPU" : "auto";
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

// Room / 通信（04 と同じ）
const roomRaw = params.get("room");
const ROOM =
  roomRaw === null ? "demo" : ROOM_ID_PATTERN.test(roomRaw) ? roomRaw : null;
const SEND_INTERVAL_MS = 1000 / numParam("sendHz", 15, { min: 1, max: 60 });
const PEER_STALE_MS = numParam("peerStaleMs", 2000, { min: 200, max: 30000 });
const PEER_SMOOTH = numParam("peerSmooth", 0.3, { min: 0.01, max: 1 });
// ネットの高さ。"auto" はサーバーが頭の高さから決める。room 内で一致が必要（サーバーが検証）
const netTopRaw = params.get("netTop");
const NET_TOP: number | "auto" =
  netTopRaw === null || netTopRaw === "auto"
    ? "auto"
    : numParam("netTop", 0.6, { min: 0.1, max: 3 });

// 当たり判定
/** 指先の当たり半径 [m]（05 と同じ） */
const TIP_R = 0.012;
/** 手のひら（MCP の重心）の当たり半径 [m] */
const PALM_R = 0.04;
/** 当たりを少し甘くする余裕 [m]（深度推定は数 cm ぶれる） */
const HIT_MARGIN = numParam("hitMargin", 0.02, { min: 0, max: 0.2 });
/** 自分の連続 hit を送らない間隔 [ms]（サーバーの cooldown と同程度） */
const LOCAL_HIT_COOLDOWN_MS = 300;
/** 自分の打球の予測を、サーバーの確認なしに描き続ける上限 [ms] */
const PREDICT_MAX_MS = 400;
/** サーバーの基準滞空時間 [s]（server/volleyball.ts の DEFAULT_GAME_OPTIONS.baseFlightSec と揃える。予測用） */
const BASE_FLIGHT_SEC = 1.1;

// デバッグ
const FAKE_CAM = params.has("fakecam");
// fakeShift/fakeShiftY: フェイク映像内のマーカーの位置 [px]。フェイクではマーカーがカメラに正対する
// （court の Y = カメラ方向）ので、プレイヤーはネット面（Z=0）に立つ幾何になる。fakeShiftY で
// マーカーを下に寄せるとカメラがマーカーの上辺側（court -Z = B 側）に立つ形になり、
// 狙い点が自陣側に来てラリーが回る。fakeMarkerPx はマーカーの描画サイズ（小さいほど遠い）
const FAKE_SHIFT = numParam("fakeShift", 0, { min: -200, max: 200 });
const FAKE_SHIFT_Y = numParam("fakeShiftY", 0, { min: -200, max: 200 });
const FAKE_MARKER_PX = numParam("fakeMarkerPx", 240, { min: 30, max: 400 });
const FAKE_HANDS = params.has("fakehands");

// ---- シーン ----
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a2233);

const camera = new THREE.PerspectiveCamera(FOV, innerWidth / innerHeight, 0.05, 100);
camera.position.set(0, 1.6, 0);
scene.add(camera); // 手の骨格をカメラの子にするため（05 と同じ）

scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.2));
const dirLight = new THREE.DirectionalLight(0xffffff, 1.5);
dirLight.position.set(3, 10, 2);
scene.add(dirLight);

// ---- アンカー（マーカー座標系）とコート（Y 上の座標系） ----
// court 座標系の定義は src/shared/volleyball-protocol.ts 参照。
// マーカー座標系を X 軸まわりに +90° 回すと、机に置いたマーカーの法線（マーカー +Z）が
// court の +Y（上）になり、court +Z がマーカーの下辺側になる
const anchor = new THREE.Group();
anchor.visible = false; // 初検出まで（初検出後はロストしても消さない）
scene.add(anchor);
const court = new THREE.Group();
court.rotation.x = Math.PI / 2;
anchor.add(court);

// マーカー実寸の枠（位置合わせの正解確認用。04 と同じ。ロスト中は赤くする）
const markerFrameMaterial = new THREE.MeshBasicMaterial({
  color: 0x8ab4f8,
  transparent: true,
  opacity: 0.4,
  side: THREE.DoubleSide,
});
anchor.add(
  new THREE.Mesh(new THREE.PlaneGeometry(MARKER_SIZE_M, MARKER_SIZE_M), markerFrameMaterial),
);

// 側の色: A（court +Z 側）= 青、B = 橙
const SIDE_COLORS: Record<Side, number> = { A: 0x8ab4f8, B: 0xffa657 };

// コートの見た目（ネット・支柱・両サイドの床・スコアボード）。ネットの高さは
// サーバーから来る court で変わるので、寸法依存のものは rebuildCourt で作り直す
const courtVisuals = new THREE.Group();
court.add(courtVisuals);
let courtCfg: CourtConfig = { ...DEFAULT_COURT, netTop: NET_TOP === "auto" ? DEFAULT_COURT.netTop : NET_TOP };
let builtNetTop = NaN;

function buildNetGrid(w: number, h: number, nx: number, ny: number): THREE.LineSegments {
  const pts: number[] = [];
  for (let i = 0; i <= nx; i++) {
    const x = -w / 2 + (w * i) / nx;
    pts.push(x, 0, 0, x, h, 0);
  }
  for (let j = 0; j <= ny; j++) {
    const y = (h * j) / ny;
    pts.push(-w / 2, y, 0, w / 2, y, 0);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  return new THREE.LineSegments(
    g,
    new THREE.LineBasicMaterial({ color: 0xe8eaed, transparent: true, opacity: 0.6 }),
  );
}

function rebuildCourt(cfg: CourtConfig) {
  if (cfg.netTop === builtNetTop) return;
  builtNetTop = cfg.netTop;
  for (const child of [...courtVisuals.children]) {
    child.removeFromParent();
    child.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
  }
  const netW = cfg.netHalfWidth * 2;
  const netH = cfg.netTop - cfg.netBottom;
  // ネット本体（半透明の面）+ 網目
  const net = new THREE.Mesh(
    new THREE.PlaneGeometry(netW, netH),
    new THREE.MeshBasicMaterial({
      color: 0xe8eaed,
      transparent: true,
      opacity: 0.15,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  net.position.set(0, cfg.netBottom + netH / 2, 0);
  courtVisuals.add(net);
  const grid = buildNetGrid(netW, netH, 12, 5);
  grid.position.set(0, cfg.netBottom, 0);
  courtVisuals.add(grid);
  // 上端の白帯
  const band = new THREE.Mesh(
    new THREE.BoxGeometry(netW, 0.03, 0.01),
    new THREE.MeshStandardMaterial({ color: 0xffffff }),
  );
  band.position.set(0, cfg.netTop, 0);
  courtVisuals.add(band);
  // 支柱
  for (const sx of [-1, 1]) {
    const post = new THREE.Mesh(
      new THREE.CylinderGeometry(0.012, 0.012, cfg.netTop, 10),
      new THREE.MeshStandardMaterial({ color: 0x9aa0a6 }),
    );
    post.position.set(sx * (cfg.netHalfWidth + 0.03), cfg.netTop / 2, 0);
    courtVisuals.add(post);
  }
  // 両サイドの床（自分の側が分かるように色を付ける。ネットから 2m まで）
  for (const side of ["A", "B"] as const) {
    const sign = side === "A" ? 1 : -1;
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(netW + 0.6, 2),
      new THREE.MeshBasicMaterial({
        color: SIDE_COLORS[side],
        transparent: true,
        opacity: 0.12,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, 0.002, sign * 1);
    courtVisuals.add(floor);
  }
  // スコアボード（ネットの上、両面。裏から見ても読めるように 2 枚を背中合わせに）
  for (const flip of [0, 1]) {
    const panel = scorePanels[flip];
    panel.mesh.position.set(0, cfg.netTop + 0.22, 0);
    panel.mesh.rotation.y = flip * Math.PI;
    courtVisuals.add(panel.mesh);
  }
}

// ---- 文字パネル（CanvasTexture）。装着中は HUD が読めないので、視界内に状態を出す ----
class TextPanel {
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly canvas = document.createElement("canvas");
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private last = "";
  constructor(widthM: number, heightM: number, px = 768) {
    this.canvas.width = px;
    this.canvas.height = Math.round((px * heightM) / widthM);
    this.ctx = this.canvas.getContext("2d")!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(widthM, heightM),
      new THREE.MeshBasicMaterial({
        map: this.texture,
        transparent: true,
        depthTest: false,
        depthWrite: false,
      }),
    );
    this.mesh.renderOrder = 20;
    this.mesh.visible = false;
  }
  /** 改行区切りの複数行。空文字で非表示 */
  set(text: string, color = "#e8eaed") {
    const key = `${color}\n${text}`;
    if (key === this.last) return;
    this.last = key;
    this.mesh.visible = text !== "";
    if (!this.mesh.visible) return;
    const { canvas, ctx } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "rgba(20, 22, 26, 0.65)";
    ctx.beginPath();
    ctx.roundRect(0, 0, canvas.width, canvas.height, 24);
    ctx.fill();
    const lines = text.split("\n");
    const size = Math.min(canvas.height / (lines.length + 0.6), canvas.width / 14);
    ctx.font = `bold ${size}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = color;
    lines.forEach((line, i) => {
      const y = (canvas.height * (i + 1)) / (lines.length + 1);
      ctx.fillText(line, canvas.width / 2, y, canvas.width * 0.94);
    });
    this.texture.needsUpdate = true;
  }
}

const scorePanels = [new TextPanel(0.6, 0.16), new TextPanel(0.6, 0.16)];
// 視界内メッセージ（カメラの子。中央より下に置いてボールの邪魔をしない）
const message = new TextPanel(0.9, 0.24);
message.mesh.position.set(0, -0.28, -1.2);
camera.add(message.mesh);

// ---- ボール ----
const ballR = courtCfg.ballR;
const ballMaterial = new THREE.MeshStandardMaterial({
  color: 0xffffff,
  emissive: 0xfdd663,
  emissiveIntensity: 0,
  roughness: 0.5,
});
const ball = new THREE.Mesh(new THREE.SphereGeometry(ballR, 28, 20), ballMaterial);
// バレーボールらしい色帯（3 本のリング）。回転が分かる
for (const [i, color] of [0x8ab4f8, 0xfdd663, 0x8ab4f8].entries()) {
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(ballR * 0.98, 0.012, 8, 40),
    new THREE.MeshStandardMaterial({ color, roughness: 0.6 }),
  );
  if (i === 1) ring.rotation.x = Math.PI / 2;
  if (i === 2) ring.rotation.y = Math.PI / 2;
  ball.add(ring);
}
court.add(ball);
// 床の影（高さの手がかり。単眼パススルーでは奥行きが読みにくいため）
const shadowMaterial = new THREE.MeshBasicMaterial({
  color: 0x000000,
  transparent: true,
  opacity: 0.3,
  depthWrite: false,
});
const ballShadow = new THREE.Mesh(new THREE.CircleGeometry(ballR, 24), shadowMaterial);
ballShadow.rotation.x = -Math.PI / 2;
court.add(ballShadow);

// ---- ピア（相手）: 頭のアバター + 手の骨格。court 座標系で受け取るので court の子 ----
type Peer = {
  group: THREE.Group;
  materials: THREE.Material[];
  targetPos: THREE.Vector3;
  targetQuat: THREE.Quaternion;
  lastPoseMs: number;
  tracking: boolean;
  hands: HandView[];
  /** 受信した手の 21 点（court 座標系）。手ごと。無ければ null */
  handTargets: (Vec3[] | null)[];
  handCurrent: (Vec3[] | null)[];
};
const peers = new Map<string, Peer>();
const peerHeadGeometry = new THREE.SphereGeometry(0.09, 24, 16);
const peerNoseGeometry = new THREE.ConeGeometry(0.035, 0.09, 16);

function createPeer(id: string): Peer {
  const group = new THREE.Group();
  const headMat = new THREE.MeshStandardMaterial({ color: 0xe8eaed, transparent: true });
  const noseMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, transparent: true });
  group.add(new THREE.Mesh(peerHeadGeometry, headMat));
  const nose = new THREE.Mesh(peerNoseGeometry, noseMat);
  nose.rotation.x = -Math.PI / 2;
  nose.position.z = -0.1;
  group.add(nose);
  group.visible = false;
  court.add(group);
  const hands = [new HandView(0xe8eaed, 0.01), new HandView(0xe8eaed, 0.01)];
  for (const h of hands) court.add(h.group);
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
  for (const h of peer.hands) h.group.removeFromParent();
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
    for (let k = 0; k < LANDMARK_COUNT; k++) {
      pts.push({ x: flat[k * 3], y: flat[k * 3 + 1], z: flat[k * 3 + 2] });
    }
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
    // 相手の色（サイドが決まっていれば）
    const side = sideOf(id);
    const color = side ? SIDE_COLORS[side] : 0xe8eaed;
    (peer.materials[0] as THREE.MeshStandardMaterial).color.setHex(color);
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

// ---- 自分の手（05 と同じスロット方式。指差し・ボタンは無いぶん簡略） ----
const HAND_COLORS = { R: 0x8ab4f8, L: 0xffa657, "-": 0xe8eaed } as const;
type HandLabel = keyof typeof HAND_COLORS;
/** 当たり判定に使う点: 5 指先 + 手のひら（MCP 4 点と手首の重心） */
const PALM_INDICES = [WRIST, 5, 9, 13, 17];
const CONTACT_COUNT = FINGER_TIPS.length + 1;
type HandSlot = {
  view: HandView;
  label: HandLabel;
  ema: Vec3[] | null;
  lastWrist: Vec3;
  lastSeenMs: number;
  depth: number;
  residual: number;
  handCm: number;
  /** 当たり判定点のワールド座標（今フレーム）と前フレーム（速度用） */
  contactsWorld: THREE.Vector3[];
  contactsWorldMs: number;
  prevContactsWorld: THREE.Vector3[] | null;
  prevContactsMs: number;
};
const slots: HandSlot[] = [];
for (let i = 0; i < 2; i++) {
  const view = new HandView(HAND_COLORS["-"]);
  camera.add(view.group);
  slots.push({
    view,
    label: "-",
    ema: null,
    lastWrist: { x: 0, y: 0, z: 0 },
    lastSeenMs: -Infinity,
    depth: 0,
    residual: 0,
    handCm: 0,
    contactsWorld: Array.from({ length: CONTACT_COUNT }, () => new THREE.Vector3()),
    contactsWorldMs: 0,
    prevContactsWorld: null,
    prevContactsMs: 0,
  });
}

// ---- レンダラー + 2眼 ----
// パススルーとマーカーはカメラ起動後に作る（resize から参照するのでここで宣言しておく）
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

// ---- パススルー（src/shared/passthrough-camera.ts） ----
// PC デバッグ用フェイクカメラ: チェッカーボードの中央にマーカー（04 と同じ。fakeShift で横にずらす）
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
      camFovOverride: params.has("camFov")
        ? numParam("camFov", 68, { min: 10, max: 170 })
        : undefined,
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

// ---- 手トラッキング（src/shared/hand-tracker.ts。05 と同じ初期化・失敗時の CPU 再試行） ----
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

type HandResultLike = {
  landmarks: readonly (readonly Vec3[])[];
  worldLandmarks: readonly (readonly Vec3[])[];
  handedness: readonly (readonly { categoryName: string }[])[];
};
type DetectedHand = {
  label: HandLabel;
  points: Vec3[];
  depth: number;
  residual: number;
  handCm: number;
};

const tmpVec = new THREE.Vector3();
const fakeBallCam = new THREE.Vector3();
let fakeStartMs = -1;

function updateFakeHands(now: number) {
  if (now - lastDetectAt < 33 || !passthrough) return;
  const mapping = passthrough.displayViewMapping(FOV);
  if (fakeStartMs < 0) fakeStartMs = now;
  lastDetectAt = now;
  // ボールのカメラ座標系での位置（アンカー未検出なら null = 定位置の手）
  let ballCam: Vec3 | null = null;
  if (anchor.visible) {
    camera.worldToLocal(court.localToWorld(fakeBallCam.copy(ball.position)));
    ballCam = { x: fakeBallCam.x, y: fakeBallCam.y, z: fakeBallCam.z };
  }
  applyHandResult(scriptedVolleyHand(ballCam, (now - fakeStartMs) / 1000, mapping), now);
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
        detIntervalEma = detIntervalEma
          ? detIntervalEma * 0.9 + (now - lastDetectAt) * 0.1
          : now - lastDetectAt;
      }
      lastDetectAt = now;
      applyHandResult(result, now);
    }
  }
  for (const slot of slots) {
    if (slot.view.visible && now - slot.lastSeenMs > HAND_LOST_MS) {
      slot.view.hide();
      slot.ema = null;
      slot.prevContactsWorld = null;
    }
  }
  // 当たり判定点のワールド座標は毎フレーム取り直す（頭の回転に追従。05 のレビュー指摘と同じ）
  for (const slot of slots) {
    if (slot.view.visible && slot.ema) updateContactsWorld(slot);
  }
}

function updateContactsWorld(slot: HandSlot) {
  const ema = slot.ema!;
  for (const [k, tipIndex] of FINGER_TIPS.entries()) {
    const p = ema[tipIndex];
    slot.contactsWorld[k].set(p.x, p.y, p.z);
    camera.localToWorld(slot.contactsWorld[k]);
  }
  const palm = slot.contactsWorld[CONTACT_COUNT - 1].set(0, 0, 0);
  for (const i of PALM_INDICES) palm.add(tmpVec.set(ema[i].x, ema[i].y, ema[i].z));
  palm.divideScalar(PALM_INDICES.length);
  camera.localToWorld(palm);
}

function applyHandResult(result: HandResultLike, now: number) {
  if (!passthrough) return;
  const mapping = passthrough.displayViewMapping(FOV);
  // 深度だけ実寸基準で解く（05 の depthMode=metric。合成の手は表示基準で作られているので display）
  const depthMapping: ViewMapping =
    FAKE_HANDS ? mapping : (passthrough.metricViewMapping() ?? mapping);
  lastResultHands = result.landmarks.length;

  const detected: DetectedHand[] = [];
  for (const [i, landmarks] of result.landmarks.entries()) {
    const worldRaw = result.worldLandmarks[i];
    if (!worldRaw || landmarks.length < LANDMARK_COUNT || worldRaw.length < LANDMARK_COUNT) continue;
    const world =
      HAND_SCALE === 1
        ? worldRaw
        : worldRaw.map((w) => ({ x: w.x * HAND_SCALE, y: w.y * HAND_SCALE, z: w.z * HAND_SCALE }));
    const placement = solveHandPlacement(landmarks, world, depthMapping);
    if (!placement || placement.depth > MAX_DEPTH_M) continue;
    const reported = result.handedness[i]?.[0]?.categoryName;
    const raw: HandLabel = reported === "Left" ? "L" : reported === "Right" ? "R" : "-";
    const label: HandLabel = SWAP_HANDS && raw !== "-" ? (raw === "L" ? "R" : "L") : raw;
    const w0 = world[0];
    const w12 = world[12];
    detected.push({
      label,
      points: placeLandmarks(landmarks, world, placement, mapping),
      depth: placement.depth,
      residual: placement.residual,
      handCm: Math.hypot(w12.x - w0.x, w12.y - w0.y, w12.z - w0.z) * 100,
    });
    if (detected.length >= slots.length) break;
  }

  // スロット割当（05 と同じ: 手首位置の近さで「同じ手の続き」を組む）
  const assignment = new Map<HandSlot, DetectedHand>();
  const continuing = new Set<HandSlot>();
  const taken = new Set<DetectedHand>();
  const isLive = (s: HandSlot) => s.ema !== null && now - s.lastSeenMs <= HAND_LOST_MS;
  const pairs: { slot: HandSlot; hand: DetectedHand; dist: number; limit: number }[] = [];
  for (const slot of slots) {
    if (!isLive(slot)) continue;
    const limit = MATCH_DIST_M + (MATCH_SPEED_MPS * (now - slot.lastSeenMs)) / 1000;
    for (const hand of detected) {
      const a = slot.lastWrist;
      const b = hand.points[WRIST];
      pairs.push({ slot, hand, dist: Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z), limit });
    }
  }
  pairs.sort((p, q) => p.dist - q.dist);
  for (const { slot, hand, dist, limit } of pairs) {
    if (dist > limit) continue;
    if (assignment.has(slot) || taken.has(hand)) continue;
    assignment.set(slot, hand);
    continuing.add(slot);
    taken.add(hand);
  }
  for (const hand of detected) {
    if (taken.has(hand)) continue;
    const liveUnassigned = slots
      .filter((s) => !assignment.has(s) && isLive(s))
      .sort((a, b) => a.lastSeenMs - b.lastSeenMs);
    const liveCount = slots.filter((s) => isLive(s) || assignment.has(s)).length;
    const mustReuse = liveUnassigned.length > 0 && liveCount + 1 > NUM_HANDS;
    const target = mustReuse
      ? liveUnassigned[0]
      : (slots.find((s) => !assignment.has(s) && !isLive(s)) ?? liveUnassigned[0]);
    if (!target) break;
    assignment.set(target, hand);
    taken.add(hand);
  }
  for (const [slot, hand] of assignment) updateSlot(slot, hand, now, continuing.has(slot));
}

function updateSlot(slot: HandSlot, hand: DetectedHand, now: number, continuing: boolean) {
  if (continuing && slot.ema) {
    for (let k = 0; k < LANDMARK_COUNT; k++) {
      const e = slot.ema[k];
      e.x += (hand.points[k].x - e.x) * HAND_SMOOTH;
      e.y += (hand.points[k].y - e.y) * HAND_SMOOTH;
      e.z += (hand.points[k].z - e.z) * HAND_SMOOTH;
    }
  } else {
    slot.ema = hand.points;
    slot.prevContactsWorld = null;
  }
  if (slot.label !== hand.label) {
    slot.label = hand.label;
    slot.view.setColor(HAND_COLORS[hand.label]);
  }
  slot.view.update(slot.ema);
  slot.depth = hand.depth;
  slot.residual = hand.residual;
  slot.handCm = hand.handCm;
  slot.lastSeenMs = now;
  slot.lastWrist = hand.points[WRIST];
  const hadPrev = slot.prevContactsWorld !== null;
  if (slot.prevContactsWorld) {
    for (const [k, v] of slot.prevContactsWorld.entries()) v.copy(slot.contactsWorld[k]);
    slot.prevContactsMs = slot.contactsWorldMs;
  }
  updateContactsWorld(slot);
  slot.contactsWorldMs = now;
  if (!hadPrev) {
    slot.prevContactsWorld = slot.contactsWorld.map((v) => v.clone());
    slot.prevContactsMs = now;
  }
}

// ---- 試合の状態（サーバー権威 + クライアント外挿） ----
let selfId = "";
let netStatus = "idle";
let client: GameClient | null = null;
/** 直近の権威状態と、その受信時刻（この時刻を基準に外挿する） */
let auth: { state: GameState; recvMs: number } | null = null;
/** 自分の打球の予測（サーバーの確認が来るまでの間だけ使う） */
let predicted: { ball: BallState; sinceMs: number } | null = null;
let lastLocalHitMs = -Infinity;
let localHits = 0;
let acceptedHits = 0;
let lastEventKey = "";
/** 権威状態の受信で生じる位置の飛びを隠すための、描画位置と外挿位置の差（減衰させる） */
const visualOffset = new THREE.Vector3();
const displayedBall = new THREE.Vector3();
const prevDisplayedBall = new THREE.Vector3();
let displayedValid = false;
let flashUntilMs = -Infinity;

function sideOf(id: string): Side | null {
  const sides = auth?.state.sides;
  if (!sides) return null;
  return sides.A === id ? "A" : sides.B === id ? "B" : null;
}

function mySide(): Side | null {
  return sideOf(selfId);
}

function onState(state: GameState, cfg: CourtConfig) {
  const now = performance.now();
  // 自分の打球がサーバーに受理されたら（自分の hit イベント）、予測を捨てて権威に戻る
  if (state.event?.kind === "hit" && state.event.by === selfId) {
    predicted = null;
    acceptedHits++;
  }
  const key = state.event ? `${state.seq}:${state.event.kind}` : "";
  if (key && key !== lastEventKey) {
    lastEventKey = key;
    if (state.event?.kind === "hit" || state.event?.kind === "bot-hit") {
      flashUntilMs = now + 150;
    }
    console.log(`[game] event ${state.event?.kind} side=${state.event?.side ?? "-"} by=${state.event?.by ?? "-"} score=${state.score.A}-${state.score.B} phase=${state.phase}`);
  }
  // 受信直前の描画位置との差をオフセットにして、少しずつ消す（急に飛ばない）
  if (displayedValid && !predicted) {
    const [x, y, z] = state.ball.pos;
    visualOffset.set(displayedBall.x - x, displayedBall.y - y, displayedBall.z - z);
    if (visualOffset.length() > 0.5) visualOffset.set(0, 0, 0);
  }
  auth = { state, recvMs: now };
  courtCfg = cfg;
  rebuildCourt(cfg);
}

function connect() {
  if (ROOM === null) return;
  client = connectGame(
    ROOM,
    { markerId: MARKER_ID, markerMm: MARKER_MM, netTop: NET_TOP },
    {
      onStatus: (status) => {
        netStatus = status;
      },
      onError: (reason) => {
        netStatus = `error: ${reason}`;
        console.warn(`[game] rejected: ${reason}`);
      },
      onWelcome: (id, peerIds, cfg, state) => {
        selfId = id;
        netStatus = "open";
        [...peers.keys()].forEach(removePeer);
        peerIds.forEach(createPeer);
        predicted = null;
        onState(state, cfg);
        console.log(`[game] joined "${ROOM}" as ${id} (peers: ${peerIds.join(", ") || "none"})`);
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
      onState,
    },
  );
}

// 自分の姿勢（court 座標系）+ 手の 21 点を送る
const courtInv = new THREE.Matrix4();
const poseMatrix = new THREE.Matrix4();
const posePos = new THREE.Vector3();
const poseQuat = new THREE.Quaternion();
const poseScale = new THREE.Vector3();
let lastSendMs = -Infinity;

function sendPoseIfDue(now: number) {
  if (!client || !markerAnchor?.everDetected) return;
  if (now - lastSendMs < SEND_INTERVAL_MS) return;
  lastSendMs = now;
  courtInv.copy(court.matrixWorld).invert();
  poseMatrix.multiplyMatrices(courtInv, camera.matrixWorld);
  poseMatrix.decompose(posePos, poseQuat, poseScale);
  const hands: number[][] = [];
  for (const slot of slots) {
    if (!slot.view.visible || !slot.ema) continue;
    const flat: number[] = [];
    for (const p of slot.ema) {
      tmpVec.set(p.x, p.y, p.z);
      camera.localToWorld(tmpVec);
      court.worldToLocal(tmpVec);
      flat.push(round3(tmpVec.x), round3(tmpVec.y), round3(tmpVec.z));
    }
    hands.push(flat);
  }
  const pose: PlayerPose = {
    pos: [posePos.x, posePos.y, posePos.z],
    quat: [poseQuat.x, poseQuat.y, poseQuat.z, poseQuat.w],
    tracking: markerAnchor.isTracking(now, MARKER_LOST_MS),
  };
  if (hands.length > 0) pose.hands = hands;
  client.sendPose(pose);
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

// ボールの描画位置を更新し、自分の手との接触を判定する
const tmpLocal = new THREE.Vector3();
const tmpPrevLocal = new THREE.Vector3();
const tmpHandVel = new THREE.Vector3();
const spinAxis = new THREE.Vector3();
const spinQuat = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);

function updateBall(now: number, dt: number) {
  if (!auth) {
    ball.visible = false;
    ballShadow.visible = false;
    return;
  }
  ball.visible = anchor.visible;
  ballShadow.visible = anchor.visible;
  if (predicted && now - predicted.sinceMs > PREDICT_MAX_MS) predicted = null;
  const base = predicted ?? { ball: auth.state.ball, sinceMs: auth.recvMs };
  const phase = auth.state.phase;
  const cur =
    phase === "rally"
      ? extrapolateBall(base.ball, (now - base.sinceMs) / 1000, courtCfg)
      : base.ball;
  // オフセットを 80ms の時定数で消す
  visualOffset.multiplyScalar(Math.exp(-dt / 0.08));
  prevDisplayedBall.copy(displayedBall);
  displayedBall.set(cur.pos[0], cur.pos[1], cur.pos[2]).add(visualOffset);
  ball.position.copy(displayedBall);
  // 回転（速度に垂直な軸まわりに、転がる速さで）
  const speed = Math.hypot(cur.vel[0], cur.vel[1], cur.vel[2]);
  if (speed > 0.05) {
    spinAxis.set(cur.vel[0], cur.vel[1], cur.vel[2]).normalize();
    spinAxis.crossVectors(UP, spinAxis);
    if (spinAxis.lengthSq() > 1e-6) {
      spinAxis.normalize();
      spinQuat.setFromAxisAngle(spinAxis, ((speed * 0.6) / ballR) * dt);
      ball.quaternion.premultiply(spinQuat);
    }
  }
  ballShadow.position.set(displayedBall.x, 0.003, displayedBall.z);
  const h = Math.max(0, displayedBall.y - ballR);
  shadowMaterial.opacity = Math.max(0.06, 0.32 - h * 0.12);
  ballShadow.scale.setScalar(1 + h * 0.15);
  ballMaterial.emissiveIntensity = now < flashUntilMs ? 0.9 : 0;
  ballMaterial.opacity = 1;
  ballMaterial.transparent = phase === "waiting";
  if (phase === "waiting") ballMaterial.opacity = 0.45;
  displayedValid = true;

  // ---- 接触 → hit ----
  if (phase !== "rally" || !client || now - lastLocalHitMs < LOCAL_HIT_COOLDOWN_MS) return;
  const side = mySide();
  if (!side) return;
  for (const slot of slots) {
    if (!slot.view.visible) continue;
    const tipDt = slot.prevContactsWorld ? (slot.contactsWorldMs - slot.prevContactsMs) / 1000 : 0;
    for (const [k, pWorld] of slot.contactsWorld.entries()) {
      court.worldToLocal(tmpLocal.copy(pWorld));
      const r = (k === CONTACT_COUNT - 1 ? PALM_R : TIP_R) + ballR + HIT_MARGIN;
      if (tmpLocal.distanceTo(displayedBall) >= r) continue;
      tmpHandVel.set(0, 0, 0);
      if (slot.prevContactsWorld && tipDt > 0) {
        court.worldToLocal(tmpPrevLocal.copy(slot.prevContactsWorld[k]));
        tmpHandVel.subVectors(tmpLocal, tmpPrevLocal).divideScalar(tipDt);
      }
      const pos: V3 = [displayedBall.x, displayedBall.y, displayedBall.z];
      const handVel: V3 = [tmpHandVel.x, tmpHandVel.y, tmpHandVel.z];
      // 予測: サーバーと同じ式で相手の顔の前へ（相手の頭は受信済みの姿勢から。いなければ bot の位置）
      const opp = otherSide(side);
      const oppId = auth.state.sides[opp];
      const oppPeer = oppId ? peers.get(oppId) : undefined;
      const target: V3 = oppPeer
        ? aimPoint([oppPeer.targetPos.x, oppPeer.targetPos.y, oppPeer.targetPos.z], opp, courtCfg)
        : botAimPoint(opp, courtCfg, () => 0.5);
      const vel = returnVelocity(pos, target, tmpHandVel.length(), BASE_FLIGHT_SEC, courtCfg);
      predicted = { ball: { pos, vel, lastHit: side }, sinceMs: now };
      visualOffset.set(0, 0, 0);
      client.sendHit(pos, handVel);
      lastLocalHitMs = now;
      localHits++;
      flashUntilMs = now + 150;
      console.log(`[game] hit sent (${k === CONTACT_COUNT - 1 ? "palm" : `tip${k}`}) speed=${tmpHandVel.length().toFixed(2)}m/s`);
      return;
    }
  }
}

// ---- 視界内メッセージとスコアボード ----
function updateMessages(now: number) {
  const s = auth?.state;
  const me = mySide();
  // スコアボード（自分の側を左に。相手が bot なら "BOT"）
  if (s) {
    const left: Side = me ?? "A";
    const right = otherSide(left);
    const name = (side: Side) =>
      side === me ? "あなた" : s.sides[side] ? "相手" : s.bot === side ? "BOT" : "-";
    const text = `${name(left)} ${s.score[left]} - ${s.score[right]} ${name(right)}`;
    for (const p of scorePanels) p.set(text, "#e8eaed");
  }
  // 視界内メッセージ（優先順）
  let text = "";
  let color = "#e8eaed";
  if (netStatus.startsWith("error")) {
    text = `接続できません\n${netStatus.slice(7, 60)}`;
    color = "#f28b82";
  } else if (!passthrough) {
    text = "カメラを起動中…";
  } else if (!markerAnchor?.everDetected) {
    text = "机のマーカーを見てください";
    color = "#fdd663";
  } else if (trackerStatus.startsWith("error")) {
    text = "手の検出に失敗しました";
    color = "#f28b82";
  } else if (!FAKE_HANDS && !tracker) {
    text = "手の検出を読み込み中…";
    color = "#fdd663";
  } else if (!auth) {
    text = netStatus === "open" ? "入室中…" : `サーバーに接続中… (${netStatus})`;
    color = "#fdd663";
  } else if (auth.state.phase === "waiting") {
    text = me ? "まもなくサーブ" : "マーカーを見て立ち位置を決めてください";
    if (me && auth.state.bot) text += "\n（相手がいないので BOT と練習）";
  } else if (auth.state.phase === "point" && auth.state.lastPoint) {
    const { winner, reason } = auth.state.lastPoint;
    const why = reason === "out" ? "アウト" : "落下";
    text = me
      ? winner === me
        ? `ポイント！（相手の${why}）`
        : `失点…（${why}）`
      : `${winner} 側のポイント`;
    color = me && winner === me ? "#81c995" : "#f28b82";
  } else if (auth.state.phase === "rally" && !markerAnchor.isTracking(now, MARKER_LOST_MS)) {
    // ロスト中は表示を続ける（その場で回転だけ追従）。歩くとずれるので注意だけ出す
    text = "";
  }
  message.set(text, color);
}

// ---- 頭追従（02〜05 と同じ） ----
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
  const s = auth?.state;
  const handLines = slots
    .filter((x) => x.view.visible)
    .map((x) => `${x.label}:${x.depth.toFixed(2)}m hand=${x.handCm.toFixed(1)}cm res=${x.residual.toFixed(3)}`)
    .join(" ");
  const text = [
    hudState.base,
    hudState.sensor && `sensor=${hudState.sensor}`,
    hudState.cam && `cam=${hudState.cam}`,
    hudState.fsResult && `fs=${hudState.fsResult}`,
    hudState.fsChange && `fs-change: ${hudState.fsChange}`,
    `marker=${markerAnchor?.info ?? "-"}${markerAnchor?.everDetected && !markerAnchor.isTracking(performance.now(), MARKER_LOST_MS) ? " (holding last pose)" : ""}`,
    `tracker=${trackerStatus}${lastTrackerError ? ` (last error: ${lastTrackerError})` : ""}`,
    (tracker || FAKE_HANDS) &&
      `hands=${lastResultHands} ${handLines || "-"} infer=${(tracker?.lastMs ?? 0).toFixed(0)}ms every ${detIntervalEma.toFixed(0)}ms`,
    `room=${ROOM ?? "(不正)"} me=${selfId || "-"} side=${mySide() ?? "-"} peers=${peers.size} ws=${netStatus}`,
    s &&
      `game: phase=${s.phase} score=A${s.score.A}-B${s.score.B} sides=A:${s.sides.A ?? "-"} B:${s.sides.B ?? "-"} bot=${s.bot ?? "-"} netTop=${courtCfg.netTop.toFixed(2)} seq=${s.seq} hits=${localHits}/${acceptedHits} ball=(${s.ball.pos.map((v) => v.toFixed(2)).join(",")})`,
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
  hudState.base = `fov=${FOV} camZoom=${CAM_ZOOM} markerMm=${MARKER_MM} detW=${MARKER_DET_W}@${MARKER_INTERVAL_MS}ms hands=${NUM_HANDS} delegate=${DELEGATE} handScale=${HAND_SCALE} netTop=${NET_TOP} mode=${touch ? "gyro" : "orbit"}`;
  connect(); // 通信はジェスチャーに依存しない
  if (FAKE_HANDS) {
    trackerStatus = "fake (scripted hand, MediaPipe 未使用)";
  } else {
    void initTracker(); // wasm + モデルの読み込みは許可ダイアログと並行して進める
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
      }
    },
    tryEnterFullscreen,
  });
});

// ページ離脱時は再接続ループごと接続を畳む / bfcache 復帰で張り直す（04 と同じ）
addEventListener("pagehide", () => {
  client?.dispose();
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
let lastFrameMs = performance.now();
renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = Math.min(0.05, (now - lastFrameMs) / 1000);
  lastFrameMs = now;
  controls?.update();
  camera.updateMatrixWorld();
  markerAnchor?.update(now);
  if (markerAnchor?.everDetected && !anchor.visible) anchor.visible = true;
  markerFrameMaterial.color.setHex(
    markerAnchor?.isTracking(now, MARKER_LOST_MS) ? 0x8ab4f8 : 0xf28b82,
  );
  anchor.updateMatrixWorld(true);
  updateHands(now);
  updatePeers(now);
  updateBall(now, dt);
  sendPoseIfDue(now);
  updateMessages(now);
  if (document.body.classList.contains("started")) renderHud();
  effect.render(scene, camera);
});
