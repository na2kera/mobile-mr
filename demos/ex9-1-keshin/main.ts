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
import type { MarkerAnchor } from "../../src/shared/marker-anchor";
import { markerBits } from "../../src/shared/marker-detector";
import { DEFAULT_MARKER_MM, invertRigid, markerToFieldMatrix, mulMat4, transformPoint } from "../../src/shared/marker-layout";
import { drawProjectedMarkers, fakeCameraToField, projectFakeMarkers } from "../../src/shared/fake-markers";
import { TextPanel } from "../../src/shared/text-panel";
import { startRemoteLog } from "../../src/shared/remote-log";
import { ROOM_ID_PATTERN } from "../../src/shared/shared-room-protocol";
import { KESHIN_NAMES, NAME_MAX_LENGTH, REPLACED_REASON } from "../../src/shared/keshin-protocol";
import type { KeshinIndex, KeshinPlayer, KeshinPose, Track } from "../../src/shared/keshin-protocol";
import { keshinTimeline } from "../../src/shared/keshin-timeline";
import type { KeshinVisual } from "../../src/shared/keshin-timeline";
import { bodyForward, lookUpDeg, selfLookFade, smoothYaw, stageStartLocal, yawOfForward } from "./keshin-math";
import type { Quat, V3 } from "./keshin-math";
import { KESHIN_SPECS, loadKeshinModel } from "./keshin-assets";
import type { LoadedKeshin } from "./keshin-assets";
import { KeshinView } from "./keshin-view";
import { PeripheralAura } from "./keshin-aura";
import { connectKeshin } from "./keshin-client";
import type { KeshinClient } from "./keshin-client";

// ex9-1: 化身（番外編。09-person-id を後で土台にするので 9 番台の ex）。
// ボタン 1 つで自分の背後に化身（イナズマイレブンの化身の 3D モデル）を出す。全 4 段階のうち段階 1:
//   「1 台で、ボタン → 主観のオーラ + 上を向くと見える化身 + PC の俯瞰画面での表示」
//   - 自己位置は 08 と同じ（js-aruco2 + ジャイロ。壁のマーカー 1 枚・重力で水平化）。共有する座標はマーカー座標系
//   - pose に「信用できるか」（track = marker / gyro / none と ageMs）を必ず付ける（教訓 2）
//   - 化身の on/off はサーバーが確定して全員に配った時点で演出を始める（押した本人も同じ経路）
//   - 演出は keshin-timeline.ts の純粋関数（ステージの経過時間 t だけで決まる。教訓 4）
//   - 主観: 正面を見ている間は化身を描かず、視界の周りにオーラ。見上げ角が ?lookUpDeg= 以上で前傾した自分の化身が見える
//   - 段階 2（相手の背中に化身）の描画はまだ出さない（部品 keshin-view.ts の「他人用」とプロトコルは用意済み。俯瞰画面が使う）

// ---- パラメータ ----
const fovRaw = params.get("fov");
const FOV_FIXED: number | null = fovRaw === null || fovRaw === "auto" ? null : numParam("fov", 94, { min: 20, max: 170 });
const EYE_SEP = numParam("eyeSep", 0.064, { min: 0, max: 0.2 });
const CAM_ZOOM = numParam("camZoom", 0.7, { min: 0.2, max: 5 });
const CAM_RES = resolutionParam("camRes", [1280, 720]);

/** マーカーの一辺 [mm]。既定は印刷ページ（08 の markers.html）と同じ DEFAULT_MARKER_MM */
const MARKER_MM = numParam("markerMm", DEFAULT_MARKER_MM, { max: 5000 });
const MARKER_SIZE_M = MARKER_MM / 1000;
const MARKER_ID = Math.round(numParam("markerId", 0, { min: 0, max: 999 }));
const MAX_POSE_ERROR = numParam("maxPoseError", 0.5, { min: 0, max: 100 });
const MARKER_DET_W = numParam("detW", 960, { min: 64, max: 4096 });
const MARKER_SMOOTH = numParam("smooth", 0.5, { min: 0.01, max: 1 });
const MARKER_INTERVAL_MS = numParam("markerIntervalMs", 100, { min: 0, max: 2000 });
/** 直近これ以内にマーカーを見ていれば track = marker（それ以外でアンカーがあれば gyro） */
const TRACK_OK_MS = numParam("trackOkMs", 500, { min: 50, max: 10000 });

// Room / 通信
const roomRaw = params.get("room");
const ROOM = roomRaw === null ? "demo" : ROOM_ID_PATTERN.test(roomRaw) ? roomRaw : null;
const SEND_INTERVAL_MS = 1000 / numParam("sendHz", 15, { min: 1, max: 60 });

// 化身（数値は URL で変えられる。合意済みの既定値）
/** 表示高さ [m]（scale = keshinH / 5） */
const KESHIN_H = numParam("keshinH", 3, { min: 0.5, max: 20 });
/** 頭（カメラ）から推定の床まで [m]。化身の足元 = 頭 − eyeH */
const EYE_H = numParam("eyeH", 1.5, { min: 0.3, max: 3 });
/** 背中からの距離の上書き [m]（未指定なら上半身の前面から自動。主観の前傾には使わない） */
const KESHIN_BACK: number | null = params.has("keshinBack") ? numParam("keshinBack", 0.5, { min: -5, max: 10 }) : null;
// 主観の見え方（前傾・前後）の既定値はモデルごと（keshin-assets.ts の KESHIN_SPECS[].self）。URL で指定したときだけ全モデル共通で上書きする
/** 主観の前傾 [deg]（腰の切断面が支点）の上書き */
const SELF_LEAN: number | null = params.has("selfLean") ? numParam("selfLean", 35, { min: -30, max: 90 }) : null;
/** 主観の前後の上書き [m]（化身の原点を頭の真下からどれだけ後ろに置くか。未指定ならモデルの既定、それも無ければ顔の位置から自動） */
const SELF_BACK: number | null = params.has("selfBack") ? numParam("selfBack", 0, { min: -5, max: 10 }) : null;
/** 主観の自動の前後で、化身の顔を本人の目よりどれだけ前に置くか [m] の上書き */
const SELF_FACE_AHEAD: number | null = params.has("selfFaceAhead") ? numParam("selfFaceAhead", 0.25, { min: -2, max: 3 }) : null;
/** 見上げ角 [deg]: これ以上で主観の化身が完全に見え、これ − 10 以下では描かない */
const LOOK_UP_DEG = numParam("lookUpDeg", 40, { min: -80, max: 90 });
/** 主観の既定不透明度 */
const SELF_OPACITY = numParam("selfOpacity", 0.55, { min: 0, max: 1 });
/** 主観で目からこれ以内を消す [m]（なめらかに戻す幅は +0.15） */
const NEAR_FADE_M = numParam("nearFade", 0.6, { min: 0, max: 5 });
/** オーラの粒子数（足元の柱 + 腰の渦。視界の周りはこの 0.6 倍） */
const AURA_N = Math.round(numParam("auraN", 400, { min: 0, max: 20000 }));
/** 体の向きの指数平滑の時定数 [s]（送信側だけ。受信側は受け取った向きをそのまま使う） */
const YAW_SMOOTH_SEC = numParam("yawSmoothSec", 0.25, { min: 0, max: 5 });

// デバッグ（08 と同じフェイクカメラの流儀。ただしマウスで見回すとフェイクの映像も一緒に回る = 見上げるとマーカーが画面外へ出て gyro になる）
const FAKE_CAM = params.has("fakecam");
const FAKE_SHIFT = numParam("fakeShift", 0, { min: -200, max: 200 });
const FAKE_SHIFT_Y = numParam("fakeShiftY", 0, { min: -240, max: 240 });
const FAKE_MARKER_PX = numParam("fakeMarkerPx", 80, { min: 30, max: 400 });
const FAKE_CAM_POS = (params.get("fakeCamPos") ?? "").split(",").map(Number);
const FAKE_YAW = numParam("fakeYaw", 0, { min: -180, max: 180 });
const FAKE_PITCH = numParam("fakePitch", 0, { min: -90, max: 90 });

/** タッチ端末（実機）か。PC は OrbitControls + キーボード */
const touch = isTouchDevice();
/** 重力でアンカーを水平に直す（08 と同じ。ジャイロ（実機）とフェイクカメラでは既定 on、?gravityAlign=0/1 で上書き） */
const GRAVITY_ALIGN = params.has("gravityAlign") ? params.get("gravityAlign") !== "0" : touch || FAKE_CAM;

// ---- 実機ログ（08-11 / 10 と同じ使い方）----
// ゴーグルに入れた iPhone では console も HUD も読めないので、dev サーバーのファイル（logs/client.log）へ送る。
// snapshot は 1 行の診断要約（diagSummary）を 1 秒ごと、出来事は console.log("[keshin] event=...") を拾う。?remoteLog=0 で無効
startRemoteLog({ tag: "keshin-phone", snapshot: () => diagSummary(), snapshotMs: 1000 });

/** 出来事の間引き: 種類ごとに 1 秒あたり EVENT_MAX_PER_SEC 件まで（超えた件数は次に出せたときに dropped= で添える。08-11 と同じ） */
const EVENT_MAX_PER_SEC = 5;
const eventBudget = new Map<string, { windowStartMs: number; n: number; dropped: number }>();
function logEvent(kind: string, detail = "") {
  let line = `[keshin] event=${kind}${detail ? ` ${detail}` : ""}`;
  const now = performance.now();
  let b = eventBudget.get(kind);
  if (!b || now - b.windowStartMs >= 1000) {
    const dropped = b?.dropped ?? 0;
    b = { windowStartMs: now, n: 0, dropped: 0 };
    eventBudget.set(kind, b);
    if (dropped > 0) line += ` dropped=${dropped}`;
  }
  if (b.n >= EVENT_MAX_PER_SEC) {
    b.dropped++;
    return;
  }
  b.n++;
  console.log(line);
}

// ---- シーン ----
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a2233);

const camera = new THREE.PerspectiveCamera(FOV_FIXED ?? 94, innerWidth / innerHeight, 0.05, 100);
camera.position.set(0, 1.6, 0);
scene.add(camera);

// ライトはモデルの README の確認環境（Hemisphere + Directional、環境マップなし）に合わせて少し明るめ
scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.6));
const dirLight = new THREE.DirectionalLight(0xffffff, 1.8);
dirLight.position.set(3, 10, 4);
scene.add(dirLight);

// ---- アンカー（マーカー座標系）。壁のマーカーの枠だけ描く（位置合わせの確認用）----
const anchor = new THREE.Group();
anchor.visible = false;
scene.add(anchor);
// マーカーを見ていないとき（gyro）はアンカーが最後の位置のままなので、ずれた位置に枠が出て紛らわしい → track = marker のときだけ描く
const markerFrameMaterial = new THREE.MeshBasicMaterial({ color: 0x8ab4f8, transparent: true, opacity: 0.4, side: THREE.DoubleSide });
const markerFrame = new THREE.Mesh(new THREE.PlaneGeometry(MARKER_SIZE_M, MARKER_SIZE_M), markerFrameMaterial);
anchor.add(markerFrame);

// 視界内メッセージ（ゴーグルでは HUD が読めない）。視界の中央下（周りのオーラより内側）
const message = new TextPanel(0.9, 0.24);
message.mesh.position.set(0, -0.28, -1.2);
camera.add(message.mesh);

// ---- レンダラー + 2眼 ----
let passthrough: Passthrough | null = null;
let markerAnchor: MarkerAnchor | null = null;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
// 腰のクリッピング平面（モデルの README の setClipBelow と同じ。マテリアルごとの clippingPlanes）
renderer.localClippingEnabled = true;
// 左右 2 眼ぶんの三角形数と描画コールを数えるため、リセットは毎フレーム自分で行う
renderer.info.autoReset = false;
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

// ---- パススルー（PC デバッグ用フェイクカメラ。08 の fake-markers.ts と同じピンホール投影）----
// 08 は合成カメラの姿勢が固定（見回してもマーカーは同じ場所に映る）だったが、ここでは OrbitControls の向きを合成カメラにも掛けて
// 映像も一緒に回す。見上げるとマーカーが画面の外に出て track が gyro になり、戻ると marker に戻る（信用度の確認ができる）
const FAKE_CAM_W = 640;
const FAKE_CAM_H = 480;
const FAKE_FOCAL_PX =
  FAKE_CAM_W / 2 / Math.tan(THREE.MathUtils.degToRad(params.has("camFov") ? numParam("camFov", CAM_FOV_WIDE, { min: 10, max: 170 }) : CAM_FOV_WIDE) / 2);
/** 合成カメラの基準の姿勢（カメラ → field。見回す前） */
function fakeBaseCamToField(): number[] {
  let pos: [number, number, number];
  if (FAKE_CAM_POS.length === 3 && FAKE_CAM_POS.every(Number.isFinite)) {
    pos = [FAKE_CAM_POS[0], FAKE_CAM_POS[1], FAKE_CAM_POS[2]];
  } else {
    // 原点マーカーが fakeMarkerPx の大きさで、中央から (fakeShift, fakeShiftY) px ずれて映る正面の位置（08 と同じ換算）
    const d = (MARKER_SIZE_M * FAKE_FOCAL_PX) / (0.8 * FAKE_MARKER_PX);
    pos = [(-FAKE_SHIFT * d) / FAKE_FOCAL_PX, (FAKE_SHIFT_Y * d) / FAKE_FOCAL_PX, d];
  }
  return fakeCameraToField(pos, FAKE_YAW, FAKE_PITCH);
}
const fakeBase = FAKE_CAM ? fakeBaseCamToField() : null;
const fakeMarkers = [{ id: MARKER_ID, bits: markerBits(MARKER_ID), toField: markerToFieldMatrix({ id: MARKER_ID, face: "wall", pos: [0, 0, 0] }) }];
/** いまの合成カメラの姿勢（基準 × 見回した回転）。worldUp と描画で同じものを使う */
function fakeCamToFieldNow(): number[] | null {
  if (!fakeBase) return null;
  const e = new THREE.Matrix4().makeRotationFromQuaternion(camera.quaternion).elements;
  return mulMat4(fakeBase, Array.from(e));
}
/** ワールド座標系での「上」（08 と同じ。ジャイロならワールドの Y、フェイクカメラなら合成カメラから見た field の上をワールドへ） */
const worldUpVec = new THREE.Vector3();
function worldUp(): THREE.Vector3 | null {
  if (!GRAVITY_ALIGN) return null;
  if (!FAKE_CAM) return worldUpVec.set(0, 1, 0);
  const camToField = fakeCamToFieldNow();
  if (!camToField) return null;
  const fieldToCam = invertRigid(camToField);
  const o = transformPoint(fieldToCam, [0, 0, 0]);
  const u = transformPoint(fieldToCam, [0, 1, 0]);
  return worldUpVec.set(u[0] - o[0], u[1] - o[1], u[2] - o[2]).transformDirection(camera.matrixWorld);
}
function fakeStream(): MediaStream {
  return createFakeCameraStream(
    (ctx, canvas, frame) => {
      drawCheckerboard(ctx, canvas, frame);
      const camToField = fakeCamToFieldNow();
      if (camToField) drawProjectedMarkers(ctx, projectFakeMarkers(fakeMarkers, camToField, FAKE_FOCAL_PX, canvas.width, canvas.height, MARKER_SIZE_M));
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
    maxPoseError: MAX_POSE_ERROR,
    detW: MARKER_DET_W,
    smooth: MARKER_SMOOTH,
    minIntervalMs: MARKER_INTERVAL_MS,
    camHFovDeg: () => pt.camHFovDeg,
    resnapAfterMs: 2000,
    snapDistanceM: 0.3,
    worldUp,
  });
}

// ---- 化身のモデル（自分の 1 体だけ読み込む。無ければ代わりの人型）----
type ModelState = { status: "idle" | "loading" | "loaded" | "missing"; detail: string; loaded: LoadedKeshin | null };
const modelState: ModelState = { status: "idle", detail: "", loaded: null };
let modelIndex: KeshinIndex | null = null;

function loadModelFor(index: KeshinIndex) {
  if (modelIndex === index) return;
  modelIndex = index;
  const spec = KESHIN_SPECS[index];
  modelState.status = "loading";
  modelState.detail = spec.file;
  modelState.loaded = null;
  const t0 = performance.now();
  loadKeshinModel(spec)
    .then((loaded) => {
      if (modelIndex !== index) return;
      modelState.status = "loaded";
      modelState.loaded = loaded;
      modelState.detail = `load=${loaded.loadMs.toFixed(0)}ms measure=${(loaded.measureMs ?? 0).toFixed(1)}ms tris=${loaded.triangles} front=${loaded.frontZ.toFixed(2)} head=${loaded.head.y.toFixed(2)}`;
      selfView?.setModel(loaded);
      logEvent("model-loaded", `#${index} ${spec.file} ${(performance.now() - t0).toFixed(0)}ms load=${loaded.loadMs.toFixed(0)}ms measure=${(loaded.measureMs ?? 0).toFixed(1)}ms tris=${loaded.triangles} frontZ=${loaded.frontZ.toFixed(3)} headY=${loaded.head.y.toFixed(3)}`);
    })
    .catch((e: unknown) => {
      if (modelIndex !== index) return;
      modelState.status = "missing";
      modelState.detail = e instanceof Error ? e.message.slice(0, 80) : String(e);
      logEvent("model-failed", `#${index} ${spec.file} ${(performance.now() - t0).toFixed(0)}ms ${modelState.detail}`);
    });
}

/**
 * 自分の化身のシェーダーを先にコンパイルする（初めて見上げた瞬間に固まらないように）。化身を作った直後とモデルを差し替えた直後に、
 * 描画ループの本描画の直前でキャンバスへ実際の設定（StereoEffect の左右のカメラ・クリッピング・出力の色空間）のまま 1 回描く。
 * 直後の本描画（autoClear）が消すので見えない。かかった時間と、新しくリンクされたプログラムの数を HUD と実機ログに出す
 */
let warmupInfo = "-";
function warmUpSelfIfPending() {
  const view = selfView;
  if (!view || !view.warmPending) return;
  const what = view.warmPending;
  view.warmPending = null;
  const before = renderer.info.programs?.length ?? 0;
  const wasPeripheral = peripheral?.points.visible ?? false;
  const t0 = performance.now();
  try {
    // 視界の周りのオーラも（化身を出すまで一度も描かないので）
    if (peripheral) peripheral.points.visible = true;
    view.forceVisible(() => effect.render(scene, camera));
  } catch (e: unknown) {
    logEvent("warmup-failed", `${what} ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    if (peripheral) peripheral.points.visible = wasPeripheral;
  }
  const after = renderer.info.programs?.length ?? 0;
  warmupInfo = `${what} ${(performance.now() - t0).toFixed(0)}ms programs=${before}→${after}`;
  logEvent("warmup", warmupInfo);
}

// ---- 自分の化身（主観）と視界の周りのオーラ ----
let selfView: KeshinView | null = null;
let peripheral: PeripheralAura | null = null;

function setupSelfKeshin(index: KeshinIndex) {
  if (selfView && selfView.spec.index === index) return;
  selfView?.dispose();
  peripheral?.points.removeFromParent();
  peripheral?.dispose();
  const spec = KESHIN_SPECS[index];
  selfView = new KeshinView(spec, {
    mode: "self",
    heightM: KESHIN_H,
    eyeH: EYE_H,
    backOverride: KESHIN_BACK,
    leanDeg: SELF_LEAN ?? spec.self.leanDeg,
    selfBackOverride: SELF_BACK ?? spec.self.backM,
    faceAheadM: SELF_FACE_AHEAD ?? spec.self.faceAheadM,
    opacity: SELF_OPACITY,
    auraN: AURA_N,
    nearFade: [NEAR_FADE_M, NEAR_FADE_M + 0.15],
  });
  scene.add(selfView.group);
  if (FAKE_CAM) {
    const t = selfView.selfTuning();
    (window as unknown as { __keshinDefaultTuning: unknown }).__keshinDefaultTuning = [t.leanDeg, t.faceAheadM, t.backM];
  }
  peripheral = new PeripheralAura(Math.round(AURA_N * 0.6), spec.auraColors);
  camera.add(peripheral.points);
  loadModelFor(index);
}

// ---- Room の状態（サーバーが確定したもの）----
type PlayerState = { info: KeshinPlayer; startLocalMs: number };
const players = new Map<string, PlayerState>();
let selfId = "";
let netStatus = "idle";
let client: KeshinClient | null = null;
let cameraError = "";
/** 押して送ったが、まだサーバーの確定が来ていない状態（null = 待っていない） */
let pending: { on: boolean; sinceMs: number } | null = null;
const PENDING_TIMEOUT_MS = 3000;
let flash: { text: string; untilMs: number } | null = null;

function selfState(): PlayerState | null {
  return players.get(selfId) ?? null;
}

function visualOf(p: PlayerState, now: number): KeshinVisual {
  return keshinTimeline((now - p.startLocalMs) / 1000, p.info.on ? "appear" : "vanish");
}

function connect(name: string) {
  if (ROOM === null) return;
  client = connectKeshin(
    ROOM,
    name,
    { markerId: MARKER_ID, markerMm: MARKER_MM },
    {
      onStatus: (status) => {
        netStatus = status;
      },
      onError: (reason) => {
        netStatus = `error: ${reason}`;
        logEvent("error", `server rejected: ${reason}`);
      },
      onWelcome: (id, _role, list, now) => {
        const recv = performance.now();
        selfId = id;
        netStatus = "open";
        players.clear();
        for (const p of list) players.set(p.id, { info: p, startLocalMs: stageStartLocal(p.changedAt, now, recv) });
        pending = null;
        const me = players.get(id);
        if (me) setupSelfKeshin(me.info.keshin);
        logEvent("welcome", `room=${ROOM} me=${id} keshin=${me?.info.keshin ?? "-"} players=${list.map((p) => `${p.id}:${p.keshin}${p.on ? "on" : ""}`).join(",")}`);
      },
      onJoin: (p, now) => {
        // 再接続の引き継ぎ（同じ session 鍵）なら on / changedAt を持っている → 演出なしで同じ見え方から
        players.set(p.id, { info: p, startLocalMs: stageStartLocal(p.changedAt, now, performance.now()) });
        logEvent("join", `${p.id} "${p.name}" keshin=${p.keshin}${p.on ? " on" : ""}`);
      },
      onLeave: (id) => {
        if (players.delete(id)) logEvent("leave", id);
      },
      onPose: (id, pose) => {
        // 段階 1 ではスマホに相手の化身は出さない（状態だけ持つ。段階 2 で keshin-view.ts の「他人用」で描く）
        const p = players.get(id);
        if (p) p.info.pose = pose;
      },
      onKeshin: (id, on, keshin, changedAt, now) => {
        const recv = performance.now();
        const p = players.get(id);
        if (!p) return;
        p.info.on = on;
        p.info.keshin = keshin;
        p.info.changedAt = changedAt;
        p.startLocalMs = stageStartLocal(changedAt, now, recv);
        const shifted = now - changedAt;
        if (id === selfId) {
          if (pending && pending.on === on) pending = null;
          flash = { text: on ? `化身 ${KESHIN_NAMES[keshin]}\n見上げると見えます` : "化身を戻しました", untilMs: recv + 2500 };
        }
        logEvent(on ? "keshin-on" : "keshin-off", `${id}${id === selfId ? "(me)" : ""} keshin=${keshin}${shifted > 1 ? ` shifted=${shifted.toFixed(0)}ms` : ""}`);
      },
    },
  );
}

// ---- 化身ボタン（DOM。ゴーグルに入れたまま押す想定はしない）と K キー ----
const keshinButton = document.querySelector<HTMLButtonElement>("#keshin-button")!;
const keshinButtonTitle = keshinButton.querySelector<HTMLSpanElement>(".k-title")!;
const keshinButtonState = keshinButton.querySelector<HTMLSpanElement>(".k-state")!;

function toggleKeshin() {
  const me = selfState();
  if (!client || !me) return;
  // 連打は受け付ける: 最新の希望（送信中ならその逆）を送る。確定はサーバーから全員に届いた時点
  const want = !(pending?.on ?? me.info.on);
  if (!client.sendKeshin(want)) return;
  pending = { on: want, sinceMs: performance.now() };
  logEvent("press", `want=${want ? "on" : "off"}`);
}
keshinButton.addEventListener("click", (e) => {
  e.preventDefault();
  toggleKeshin();
});
addEventListener("keydown", (e) => {
  if ((e.key === "k" || e.key === "K") && !e.repeat && document.body.classList.contains("started")) toggleKeshin();
});

let lastButtonKey = "";
function updateButton(now: number) {
  if (pending && now - pending.sinceMs > PENDING_TIMEOUT_MS) {
    logEvent("press-timeout", `want=${pending.on ? "on" : "off"}`);
    pending = null;
  }
  const me = selfState();
  const name = me ? KESHIN_NAMES[me.info.keshin] : "化身";
  const on = me?.info.on ?? false;
  const state = !me || netStatus.startsWith("error") ? (netStatus === `error: ${REPLACED_REASON}` ? "別のタブに置き換えました" : netStatus.startsWith("error") ? "接続できません" : "接続中…") : pending ? "送信中…" : on ? "出ている（タップで戻す）" : "消えている（タップで出す）";
  const key = `${name}|${state}|${on}|${!!pending}|${!!me}`;
  if (key === lastButtonKey) return;
  lastButtonKey = key;
  keshinButtonTitle.textContent = me ? `化身: ${name}` : "化身";
  keshinButtonState.textContent = state;
  keshinButton.disabled = !me || netStatus.startsWith("error");
  keshinButton.classList.toggle("on", on && !pending);
  keshinButton.classList.toggle("pending", !!pending);
}

// ---- 体の向き（送信側だけで平滑化。状態はこの 1 つだけ）と pose の送信 ----
/** 平滑化した体の向き（ワールド。ジャイロのワールドは重力で水平） */
let bodyYaw: number | null = null;
let lastYawMs = performance.now();
const camWorldQuat = new THREE.Quaternion();
const camWorldPos = new THREE.Vector3();

function updateBodyYaw(now: number) {
  camera.getWorldQuaternion(camWorldQuat);
  const q: Quat = [camWorldQuat.x, camWorldQuat.y, camWorldQuat.z, camWorldQuat.w];
  const f = bodyForward(q);
  const dt = (now - lastYawMs) / 1000;
  lastYawMs = now;
  if (f) bodyYaw = smoothYaw(bodyYaw, yawOfForward(f), dt, YAW_SMOOTH_SEC);
}

function trackOf(now: number): { track: Track; ageMs: number | null } {
  if (!markerAnchor?.everDetected) return { track: "none", ageMs: null };
  const ageMs = Math.max(0, now - markerAnchor.lastAcceptedMs);
  return { track: markerAnchor.isTracking(now, TRACK_OK_MS) ? "marker" : "gyro", ageMs };
}

const anchorInv = new THREE.Matrix4();
const poseMatrix = new THREE.Matrix4();
const posePos = new THREE.Vector3();
const poseQuat = new THREE.Quaternion();
const poseScale = new THREE.Vector3();
const anchorQuatInv = new THREE.Quaternion();
const fwdVec = new THREE.Vector3();
let lastSendMs = -Infinity;
let posesSent = 0;
/** 直近に送った pose（HUD / ログ用） */
let lastSent: KeshinPose | null = null;

function sendPoseIfDue(now: number) {
  if (!client || netStatus !== "open") return;
  if (now - lastSendMs < SEND_INTERVAL_MS) return;
  lastSendMs = now;
  const { track, ageMs } = trackOf(now);
  let pose: KeshinPose;
  if (track === "none" || bodyYaw === null) {
    pose = { track: "none", ageMs: null };
  } else {
    anchorInv.copy(anchor.matrixWorld).invert();
    poseMatrix.multiplyMatrices(anchorInv, camera.matrixWorld);
    poseMatrix.decompose(posePos, poseQuat, poseScale);
    // 体の向き（ワールド）→ マーカー座標系の水平（重力で水平化していれば Y は共通。水平化していなければ射影して正規化）
    anchor.getWorldQuaternion(anchorQuatInv).invert();
    fwdVec.set(Math.sin(bodyYaw), 0, Math.cos(bodyYaw)).applyQuaternion(anchorQuatInv);
    const len = Math.hypot(fwdVec.x, fwdVec.z) || 1;
    pose = {
      pos: [round3(posePos.x), round3(posePos.y), round3(posePos.z)],
      quat: [poseQuat.x, poseQuat.y, poseQuat.z, poseQuat.w],
      fwd: [round3(fwdVec.x / len), round3(fwdVec.z / len)],
      track,
      ageMs: Math.round(ageMs ?? 0),
    };
  }
  if (client.sendPose(pose)) {
    posesSent++;
    lastSent = pose;
  }
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

// ---- マーカーを見失った / 見つけた（出来事として記録）----
let lastTrack: Track = "none";
function watchTrack(now: number) {
  const { track } = trackOf(now);
  if (track === lastTrack) return;
  const kind = track === "marker" ? (lastTrack === "none" ? "marker-first" : "marker-found") : track === "gyro" ? "marker-lost" : "marker-reset";
  logEvent(kind, `${lastTrack}→${track} ${markerAnchor?.info ?? ""}`);
  lastTrack = track;
}

// ---- 自分の化身の更新（主観）----
let lookDeg = 0;
let selfFade = 0;
let selfVisual: KeshinVisual | null = null;
const drawingSize = new THREE.Vector2();

function updateSelf(now: number) {
  const me = selfState();
  if (!selfView || !peripheral || !me || bodyYaw === null) {
    selfView?.hide();
    if (peripheral) peripheral.points.visible = false;
    selfVisual = null;
    return;
  }
  camera.getWorldPosition(camWorldPos);
  camera.getWorldQuaternion(camWorldQuat);
  lookDeg = lookUpDeg([camWorldQuat.x, camWorldQuat.y, camWorldQuat.z, camWorldQuat.w]);
  selfFade = selfLookFade(lookDeg, LOOK_UP_DEG);
  const visual = visualOf(me, now);
  selfVisual = visual;
  renderer.getDrawingBufferSize(drawingSize);
  const head: V3 = [camWorldPos.x, camWorldPos.y, camWorldPos.z];
  selfView.update({ head, yaw: bodyYaw, visual, fade: selfFade, aura: true, timeSec: now / 1000, eyeWorld: camWorldPos, viewportH: drawingSize.y });
  // 視界の周りのオーラ（正面でも出す。見上げて化身が見えている間は少し控える）
  const pk = visual.hidden ? 0 : visual.auraK * (1 - 0.4 * selfFade);
  peripheral.points.visible = pk > 0.001;
  peripheral.uniforms.uK.value = pk;
  peripheral.uniforms.uTime.value = now / 1000;
  peripheral.setView(camera.fov, camera.aspect * 0.5, drawingSize.y);
}

// ---- 視界内メッセージ ----
function updateMessage(now: number) {
  let text = "";
  let color = "#e8eaed";
  const { track } = trackOf(now);
  if (netStatus === `error: ${REPLACED_REASON}`) {
    text = `このタブは止まっています\n${REPLACED_REASON}`;
    color = "#f28b82";
  } else if (netStatus.startsWith("error")) {
    text = `接続できません\n${netStatus.slice(7, 60)}`;
    color = "#f28b82";
  } else if (cameraError) {
    text = `カメラを開けません\n${cameraError.slice(0, 40)}`;
    color = "#f28b82";
  } else if (!passthrough) {
    text = "カメラを起動中…";
  } else if (netStatus !== "open" && selfId !== "") {
    text = "接続が切れました（再接続中）";
    color = "#f28b82";
  } else if (!selfState()) {
    text = netStatus === "open" ? "入室中…" : `サーバーに接続中… (${netStatus})`;
    color = "#fdd663";
  } else if (flash && now < flash.untilMs) {
    text = flash.text;
    color = "#fdd663";
  } else if (track === "none") {
    // 主観の化身はマーカーが無くても出せる。位置の共有（俯瞰画面）にはマーカーが要る
    text = "壁のマーカーを見てください\n（位置を共有します）";
    color = "#fdd663";
  }
  message.set(text, color);
}

// ---- 頭追従（02〜09 と同じ） ----
type HeadControls = { update: () => void };
let controls: HeadControls | null = null;
let orbit: OrbitControls | null = null;

function startControls() {
  if (touch) {
    controls = new DeviceOrientationControls(camera);
  } else {
    orbit = new OrbitControls(camera, renderer.domElement);
    orbit.target.set(0, 1.6, -0.01);
    orbit.enableZoom = false;
    orbit.enablePan = false;
    orbit.rotateSpeed = -0.5;
    controls = orbit;
  }
}

// ---- 処理の重さの計測（教訓 3・5: 最初から入れる）----
let fps = 0;
let fpsFrames = 0;
let fpsWindowStart = performance.now();
let renderMsEma = 0;
let lastTris = 0;
let lastCalls = 0;
function measureFrame(now: number, renderMs: number) {
  fpsFrames++;
  if (now - fpsWindowStart >= 1000) {
    fps = (fpsFrames * 1000) / (now - fpsWindowStart);
    fpsFrames = 0;
    fpsWindowStart = now;
  }
  renderMsEma = renderMsEma ? renderMsEma * 0.9 + renderMs * 0.1 : renderMs;
  lastTris = renderer.info.render.triangles;
  lastCalls = renderer.info.render.calls;
}

function describeKeshin(now: number): string {
  const me = selfState();
  if (!me) return "-";
  const t = (now - me.startLocalMs) / 1000;
  const v = selfVisual;
  return `#${me.info.keshin}${me.info.on ? "on" : "off"} t=${Number.isFinite(t) ? t.toFixed(2) : "inf"} u=${v ? v.u.toFixed(2) : "-"} op=${selfView ? selfView.lastOpacity.toFixed(2) : "-"} drawn=${selfView?.modelVisible ? 1 : 0}${pending ? ` pending=${pending.on ? "on" : "off"}` : ""}`;
}
function describeModel(): string {
  if (modelState.status === "loaded") return `loaded(${modelState.detail})`;
  if (modelState.status === "missing") return "missing(fallback)";
  return modelState.status;
}

/** 実機ログの snapshot（1 行の診断要約。1 秒ごとに送られ、同じ内容なら送らない） */
function diagSummary(): string {
  if (!document.body.classList.contains("started")) return "";
  const now = performance.now();
  const { track, ageMs } = trackOf(now);
  return [
    `fps=${fps.toFixed(0)}`,
    `det=${(markerAnchor?.detMs ?? 0).toFixed(0)}ms`,
    `render=${renderMsEma.toFixed(1)}ms`,
    `tris=${lastTris}`,
    `calls=${lastCalls}`,
    `track=${track}${ageMs !== null ? `/${(ageMs / 1000).toFixed(1)}s` : ""}`,
    `keshin=${describeKeshin(now)}`,
    `look=${lookDeg.toFixed(0)}deg fade=${selfFade.toFixed(2)}`,
    `model=${modelState.status}`,
    `ws=${netStatus} me=${selfId || "-"} players=${players.size} sent=${posesSent}`,
  ].join(" ");
}

// ---- HUD（デバッグ用） ----
const hud = document.querySelector<HTMLDivElement>("#hud")!;
const hudState = { base: "", sensor: "", cam: "", fsResult: "", fsChange: "", wake: "" };
let lastHudText = "";
function renderHud() {
  const now = performance.now();
  const { track, ageMs } = trackOf(now);
  const modelLine =
    modelState.status === "missing"
      ? `model=モデル未配置（npm run fetch:keshin）→ 代わりの人型で表示 [${modelState.detail}]`
      : `model=${describeModel()}`;
  const text = [
    `${hudState.base} (fov now=${camera.fov.toFixed(1)})`,
    hudState.sensor && `sensor=${hudState.sensor}`,
    hudState.cam && `cam=${hudState.cam}`,
    hudState.fsResult && `fs=${hudState.fsResult}`,
    hudState.fsChange && `fs-change: ${hudState.fsChange}`,
    hudState.wake && `wake=${hudState.wake}`,
    `fps=${fps.toFixed(0)} det=${(markerAnchor?.detMs ?? 0).toFixed(0)}ms render=${renderMsEma.toFixed(1)}ms(2眼) tris=${lastTris} calls=${lastCalls}`,
    `marker=${markerAnchor?.info ?? "-"} track=${track}${ageMs !== null ? ` age=${(ageMs / 1000).toFixed(1)}s` : ""}`,
    `keshin=${describeKeshin(now)} look=${lookDeg.toFixed(0)}deg fade=${selfFade.toFixed(2)} yaw=${bodyYaw === null ? "-" : THREE.MathUtils.radToDeg(bodyYaw).toFixed(0)}deg back=${selfView ? selfView.back().toFixed(2) : "-"}m lean=${selfView ? selfView.selfTuning().leanDeg : "-"}deg`,
    `${modelLine} warmup=${warmupInfo}`,
    `room=${ROOM ?? "(不正)"} me=${selfId || "-"} players=${[...players.values()].map((p) => `${p.info.id}:${p.info.keshin}${p.info.on ? "on" : ""}`).join(",") || "-"} ws=${netStatus} sent=${posesSent}${lastSent ? ` last=${lastSent.track}${lastSent.pos ? `(${lastSent.pos.map((v) => v.toFixed(2)).join(",")})` : ""}` : ""}`,
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
  hudState.base = `fov=${FOV_FIXED ?? "auto"} camZoom=${CAM_ZOOM} markerMm=${MARKER_MM} detW=${MARKER_DET_W}@${MARKER_INTERVAL_MS}ms gravityAlign=${GRAVITY_ALIGN ? 1 : 0} keshinH=${KESHIN_H} eyeH=${EYE_H} lean=${SELF_LEAN ?? "model"} lookUp=${LOOK_UP_DEG} auraN=${AURA_N} mode=${touch ? "gyro" : "orbit"}`;
  logEvent("start", `name=${name} room=${ROOM} ${hudState.base}`);
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
        logEvent("error", `camera: ${cameraError}`);
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

// ---- ヘッドレス確認用の口（フェイクカメラのときだけ）----
if (FAKE_CAM) {
  (window as unknown as { __keshin: unknown }).__keshin = {
    /** PC の見回し（OrbitControls）の向きを決める。pitch は上が +、yaw は左が + [deg] */
    setLook(pitchDeg: number, yawDeg = 0) {
      if (!orbit) return false;
      const p = THREE.MathUtils.degToRad(pitchDeg);
      const y = THREE.MathUtils.degToRad(yawDeg);
      const dir = new THREE.Vector3(-Math.sin(y) * Math.cos(p), Math.sin(p), -Math.cos(y) * Math.cos(p));
      orbit.target.copy(camera.position).addScaledVector(dir, 0.01);
      orbit.update();
      return true;
    },
    /** 主観の見え方を変える（比較用のコンタクトシート。back = null は顔の位置から自動） */
    setSelfTuning(leanDeg: number, faceAheadM: number, backM: number | null = null) {
      selfView?.setSelfTuning({ leanDeg, faceAheadM, backM });
      return selfView?.back() ?? null;
    },
    /** 自分の化身の頂点のうち目から dist m 以内の割合（比較用。keshin-view.ts の nearVertexFraction） */
    nearVertexFraction(dist = 0.6) {
      if (!selfView) return null;
      return selfView.nearVertexFraction(camera.getWorldPosition(new THREE.Vector3()), dist);
    },
    /** 主観で目から消す距離を変える（[消える, 見え始める] m。確認用） */
    setNearFade(a: number, b: number) {
      selfView?.setNearFade([a, b]);
    },
    state() {
      const now = performance.now();
      const me = selfState();
      return {
        me: selfId,
        keshin: me?.info.keshin ?? null,
        on: me?.info.on ?? null,
        pending: pending?.on ?? null,
        track: trackOf(now).track,
        look: lookDeg,
        fade: selfFade,
        drawn: selfView?.modelVisible ?? false,
        opacity: selfView?.lastOpacity ?? 0,
        u: selfVisual?.u ?? null,
        model: modelState.status,
        fallback: selfView?.isFallback ?? null,
        back: selfView?.back() ?? null,
        fps,
        programs: renderer.info.programs?.length ?? 0,
        warmup: warmupInfo,
        tris: lastTris,
        calls: lastCalls,
        sent: posesSent,
      };
    },
    /**
     * 化身を描いたときと描かないときで画面の画素がどれだけ変わるか（左右 2 眼込み。ピクセルでの確認用）。
     * all = true ならオーラ（足元の柱・視界の周り）も含めて消して比べる。center は各眼の中心 50%（幅・高さとも）、
     * band は各眼の外周 20% の帯（各辺から幅・高さの 20%）の中で変わった画素数。
     * 同じタスクの中で描いて readPixels する（preserveDrawingBuffer なしでも読める）
     */
    pixelDiff(all = false) {
      if (!selfView) return null;
      const gl = renderer.getContext();
      const w = gl.drawingBufferWidth;
      const h = gl.drawingBufferHeight;
      const read = () => {
        const buf = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        return buf;
      };
      effect.render(scene, camera);
      const withKeshin = read();
      const wasVisible = selfView.group.visible;
      const wasPeripheral = peripheral?.points.visible ?? false;
      selfView.group.visible = false;
      if (all && peripheral) peripheral.points.visible = false;
      effect.render(scene, camera);
      const without = read();
      selfView.group.visible = wasVisible;
      if (peripheral) peripheral.points.visible = wasPeripheral;
      // 各眼の中の位置を −1..1 に正規化して、中心 50%（幅・高さとも）と外周 20% の帯（各辺から幅・高さの 20%）を数える
      let changed = 0;
      let center = 0;
      let band = 0;
      for (let i = 0; i < withKeshin.length; i += 4) {
        const d = Math.abs(withKeshin[i] - without[i]) + Math.abs(withKeshin[i + 1] - without[i + 1]) + Math.abs(withKeshin[i + 2] - without[i + 2]);
        if (d <= 24) continue;
        changed++;
        const px = (i / 4) % w;
        const py = Math.floor(i / 4 / w);
        const ex = Math.abs((px % (w / 2) - w / 4) / (w / 4));
        const ey = Math.abs((py - h / 2) / (h / 2));
        if (ex < 0.5 && ey < 0.5) center++;
        if (ex > 0.6 || ey > 0.6) band++;
      }
      return { changed, center, band, total: w * h };
    },
  };
}

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
  markerFrame.visible = trackOf(now).track === "marker";
  anchor.updateMatrixWorld(true);
  watchTrack(now);
  updateBodyYaw(now);
  updateSelf(now);
  sendPoseIfDue(now);
  updateButton(now);
  updateMessage(now);
  if (document.body.classList.contains("started")) renderHud();
  warmUpSelfIfPending();
  renderer.info.reset();
  const t0 = performance.now();
  effect.render(scene, camera);
  measureFrame(now, performance.now() - t0);
});
