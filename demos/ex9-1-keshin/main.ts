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
import { bodyForward, lookUpDeg, poseReceivedLocal, selfLookFade, smoothYaw, stageStartLocal, yawOfForward } from "./keshin-math";
import type { Quat, V3 } from "./keshin-math";
import { KESHIN_SPECS, loadKeshinModel } from "./keshin-assets";
import type { LoadedKeshin } from "./keshin-assets";
import { KeshinView } from "./keshin-view";
import { PeripheralAura } from "./keshin-aura";
import { connectKeshin } from "./keshin-client";
import { OcclusionController, drawPersonShape, projectFakePerson } from "./keshin-occlusion";
import type { PersonShape } from "./keshin-occlusion";
import { RemoteKeshins } from "./remote-keshins";
import type { PosMode } from "./remote-keshins";
import { DEFAULT_CORR_GATE_M, DEFAULT_FACING_MAX_DEG, detectionToWorld } from "./keshin-hybrid";
import type { CamDetection } from "./keshin-hybrid";
import { fakeMirrorPoints, poseFromCamPoints } from "./mirror-math";
import type { BodyLandmarkLike } from "./keshin-occlusion";
import { describeLook, lookFromParams } from "./keshin-look";
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

// 段階 2: 相手の化身（スマホにも描く）
/** 相手の化身の不透明度（体。発光部分は 1 のまま。俯瞰画面と同じ） */
const OTHER_OPACITY = numParam("otherOpacity", 0.85, { min: 0, max: 1 });
/** 相手の化身の表示の位置・向きを目標へ寄せる時定数 [s] */
const REMOTE_SMOOTH_SEC = numParam("remoteSmoothSec", 0.25, { min: 0, max: 5 });
/** 目標がこれ以上離れたら寄せずに即座に移す [m] */
const SNAP_M = numParam("snapM", 3, { min: 0.1, max: 100 });
/** gyro の ageMs がこれで化身が半分の薄さ、以降はその薄さで最後の位置に止める [ms]（俯瞰画面と同じ） */
const STALE_MS = numParam("staleMs", 3000, { min: 100, max: 60000 });
/** pose がこれだけ届かなければ marker でも gyro 扱い [ms]（俯瞰画面と同じ） */
/** gyro の ageMs がこれを超えたら相手の化身をフェードで消す [ms]（マーカーを見直したらまた出す） */
// 段階 3 の B: カメラで見た人で相手の化身の位置を決める（ハイブリッド）
/** 位置の決め方: declared = 段階 2（申告位置だけ）、camera = 見えている間はカメラだけ、hybrid（既定）= 方向はカメラ・距離は申告と混ぜる・見えない間は申告 + 補正 */
const POS_MODE: PosMode = (() => {
  const v = (params.get("posMode") ?? "hybrid").toLowerCase();
  return v === "declared" || v === "camera" ? v : "hybrid";
})();
/** 申告位置の方向と検出の方向がこれ以内なら同じ人 [deg] */
const MATCH_DEG = numParam("matchDeg", 15, { min: 1, max: 90 });
/** 相手 1 人・検出 1 人で結ぶとき、新しい申告があれば方向の差がこれ以内のときだけ [deg]（プレイヤーでない人に付けないように） */
const ONLY_ONE_MAX_DEG = numParam("onlyOneMaxDeg", 45, { min: 1, max: 180 });
/** 見えなくなった瞬間の補正に使う直近の観測 [s]（窓全体の平均より遅れない） */
const CORR_RECENT_SEC = numParam("corrRecentSec", 0.5, { min: 0.05, max: 60 });
/** 前の結果の人と頭がこれ以内なら同じ人 [m] */
const MATCH_M = numParam("matchM", 0.5, { min: 0.05, max: 5 });
/**
 * 申告の体の向き（相手のジャイロ → 自分のアンカーで自分のワールドへ）と、検出した人の肩の線の向きがこれを超えて違えば新しく結ばない [deg]。
 * 自分のアンカーの向きの誤差（単一マーカーで十数度）と肩の線のぶれを見込む。前後が決まらない（顔が隠れた）人は線の向きだけで比べる
 */
const FACING_MAX_DEG = numParam("facingMaxDeg", DEFAULT_FACING_MAX_DEG, { min: 1, max: 180 });
/** 補正を学べている相手は、申告 + 補正からこれより離れた人に新しく結ばない [m] */
const CORR_GATE_M = numParam("corrGateM", DEFAULT_CORR_GATE_M, { min: 0.1, max: 100 });
/** 距離の混ぜ方: 申告までの距離の重み（残りはカメラの推定）。申告が古ければカメラだけ */
const DIST_W = numParam("distW", 0.7, { min: 0, max: 1 });
/** 補正（カメラで見た位置 − 申告位置）を平均する窓 [s] と、見えなくなってから 0 へ弱める時間 [s] */
const CORR_WINDOW_SEC = numParam("corrWindowSec", 3, { min: 0.2, max: 60 });
const CORR_DECAY_SEC = numParam("corrDecaySec", 10, { min: 0, max: 600 });
/** 人の 3D 化（09 と同じ） */
const BODY_SCALE = numParam("bodyScale", 1, { min: 0.3, max: 3 });
const MIN_VIS = numParam("minVis", 0.5, { min: 0, max: 1 });
const MAX_DEPTH_M = numParam("maxDepth", 8, { min: 0.5, max: 30 });
/** 段階 3 の C: 相手の化身の見え方（腰を頭より上・溶ける下端・背中からの光の流れ）。?look=0 で段階 2 まで */
const LOOK = lookFromParams();
const STALE_HIDE_MS = numParam("staleHideMs", 8000, { min: 100, max: 600000 });
const NO_POSE_MS = numParam("noPoseMs", 1000, { min: 100, max: 60000 });
/** pose がこれだけ届かなければ通信切れとして相手の化身を描かない [ms] */
const PEER_LOST_MS = numParam("peerLostMs", 5000, { min: 500, max: 120000 });
// 人の形で相手の化身を隠す（MediaPipe PoseLandmarker の segmentation mask）
/** ?occlude=0 で隠す処理を丸ごと止める（Pose も読み込まない） */
const OCCLUDE = params.get("occlude") !== "0";
const MASK_HZ = numParam("maskHz", 15, { min: 1, max: 60 });
const MASK_POSES = Math.round(numParam("maskPoses", 3, { min: 1, max: 4 }));
/** マスクの縁を膨らませる量 [マスクの px] */
const MASK_DILATE_PX = numParam("maskDilatePx", 3, { min: 0, max: 30 });
/** 持ち主（相手）の頭よりこれだけ手前（カメラに近い）までは人の形で隠さない [m] */
const MASK_DEPTH_MARGIN = numParam("maskDepthMargin", 0.15, { min: -2, max: 5 });
/** マスクの確信度の裾の切り方（smoothstep の 2 つの端。?maskEdge=0.3,0.7） */
const MASK_EDGE: [number, number] = (() => {
  const v = (params.get("maskEdge") ?? "").split(",").map(Number);
  return v.length === 2 && v.every((x) => Number.isFinite(x) && x >= 0 && x <= 1) && v[0] < v[1] ? [v[0], v[1]] : [0.3, 0.7];
})();
/** 人の形の検出に渡す画像の長辺 [px]（マスクの大きさもこれ） */
const MASK_DET_W = numParam("maskDetW", 512, { min: 64, max: 1280 });
/** fps を見て検出の回数を自動で下げる（15 → 10 → 6 → 4。?maskHz= が上限）。?maskHzAuto=0 で止める */
const MASK_HZ_AUTO = params.get("maskHzAuto") !== "0";
/** ?maskDebug=1: 相手がいなくても人の形の検出を回し、Pose に渡した入力と最新のマスクを画面の隅に小さく出す */
const MASK_DEBUG = params.get("maskDebug") === "1";
/** 人の形の出どころ: seg = MediaPipe の segmentation mask、skel = Pose の骨格から描く、auto（既定）= seg の中身が空なら skel */
const MASK_SOURCE: "seg" | "skel" | "auto" = (() => {
  const v = (params.get("maskSource") ?? "auto").toLowerCase();
  return v === "seg" || v === "skel" ? v : "auto";
})();
/** auto で seg の中身が空とみなすマスクの最大値 */
const MASK_MIN_MAX = numParam("maskMinMax", 0.1, { min: 0, max: 1 });
/** delegate = auto で GPU の人数が 0 のままこれだけ続いたら CPU でも回して比べる [ms] */
const MASK_PROBE_AFTER_MS = numParam("maskProbeAfterMs", 10000, { min: 1000, max: 600000 });
const delegateRaw = (params.get("delegate") ?? "auto").toLowerCase();
const DELEGATE: "GPU" | "CPU" | "auto" = delegateRaw === "gpu" ? "GPU" : delegateRaw === "cpu" ? "CPU" : "auto";
const POSE_MODEL_URLS = params.get("poseModel")
  ? [params.get("poseModel")!]
  : [
      `${import.meta.env.BASE_URL}models/pose_landmarker_lite.task`,
      "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
    ];

// デバッグ（08 と同じフェイクカメラの流儀。ただしマウスで見回すとフェイクの映像も一緒に回る = 見上げるとマーカーが画面外へ出て gyro になる）
const FAKE_CAM = params.has("fakecam");
const FAKE_SHIFT = numParam("fakeShift", 0, { min: -200, max: 200 });
const FAKE_SHIFT_Y = numParam("fakeShiftY", 0, { min: -240, max: 240 });
const FAKE_MARKER_PX = numParam("fakeMarkerPx", 80, { min: 30, max: 400 });
const FAKE_CAM_POS = (params.get("fakeCamPos") ?? "").split(",").map(Number);
const FAKE_YAW = numParam("fakeYaw", 0, { min: -180, max: 180 });
const FAKE_PITCH = numParam("fakePitch", 0, { min: -90, max: 90 });
/**
 * PC 確認用: 相手の申告位置に合成の体（fake-body.ts）を立たせ、フェイクカメラの映像に描いて、同じ形を人の形のマスクにも使う
 * （MediaPipe の代わり。マスク → テクスチャ → シェーダーの経路を確かめる）
 */
const FAKE_PERSON = FAKE_CAM && params.get("fakeperson") === "1";

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
      // ?fakeperson=1: 相手の申告位置に合成の体を描く（マスクにも同じ形を使う）
      if (FAKE_PERSON) for (const s of fakePersonShapes()) drawPersonShape(ctx, s, "#5a6b86");
    },
    { width: FAKE_CAM_W, height: FAKE_CAM_H },
  );
}

/**
 * 合成の人（?fakeperson=1）の立つ位置（マーカー座標系の頭と体の向き）。既定は相手の申告位置。確認用の setFakeBodies で
 * 「本当の位置」を申告位置と別にできる（段階 3 の B: 申告が古い・ずれている相手をカメラで見た位置に出す確認）
 */
let fakeBodiesOverride: { head: V3; fwd: [number, number] }[] | null = null;
function fakeBodies(): { head: V3; fwd: [number, number] }[] {
  if (fakeBodiesOverride) return fakeBodiesOverride;
  const out: { head: V3; fwd: [number, number] }[] = [];
  for (const [id, p] of players) {
    if (id === selfId || !p.info.pose?.pos || !p.info.pose.fwd) continue;
    out.push({ head: [p.info.pose.pos[0], p.info.pose.pos[1], p.info.pose.pos[2]], fwd: [p.info.pose.fwd[0], p.info.pose.fwd[1]] });
  }
  return out;
}

/** 合成の人を、いまのフェイクカメラの画像に投影した形（?fakeperson=1） */
function fakePersonShapes(): PersonShape[] {
  const camToField = fakeCamToFieldNow();
  if (!camToField) return [];
  const out: PersonShape[] = [];
  for (const b of fakeBodies()) {
    const s = projectFakePerson(b, camToField, FAKE_FOCAL_PX, FAKE_CAM_W, FAKE_CAM_H);
    if (s) out.push(s);
  }
  return out;
}

/** 合成の人の骨格（MediaPipe の PoseLandmarker と同じ形。Pose の代わりに段階 3 の B とマスクの skel に使う） */
function fakePoseResult(): { landmarks: BodyLandmarkLike[][]; worldLandmarks: BodyLandmarkLike[][] } {
  const camToField = fakeCamToFieldNow();
  const m = passthrough?.metricViewMapping();
  if (!camToField || !m) return { landmarks: [], worldLandmarks: [] };
  const fieldToCam = invertRigid(camToField);
  const people: V3[][] = [];
  for (const b of fakeBodies()) {
    const cam = fakeMirrorPoints(b).cam.map((p) => transformPoint(fieldToCam, p) as V3);
    // カメラの後ろに回る・画面に入らない人は写らない
    if (cam.some((c) => -c[2] < 0.1)) continue;
    const r = poseFromCamPoints([cam], m);
    if (!r.landmarks[0].some((l) => l.x > 0 && l.x < 1 && l.y > 0 && l.y < 1)) continue;
    people.push(cam);
  }
  return poseFromCamPoints(people, m);
}

/** フェイクの人の形のマスク（MediaPipe の代わり。マスクの大きさは本物と同じく長辺 ?maskDetW=） */
let fakeMaskCanvas: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null = null;
function fakeMaskImage(): ImageData | null {
  const scale = Math.min(1, MASK_DET_W / Math.max(FAKE_CAM_W, FAKE_CAM_H));
  const w = Math.round(FAKE_CAM_W * scale);
  const h = Math.round(FAKE_CAM_H * scale);
  if (!fakeMaskCanvas) {
    const canvas = document.createElement("canvas");
    fakeMaskCanvas = { canvas, ctx: canvas.getContext("2d", { willReadFrequently: true })! };
  }
  const { canvas, ctx } = fakeMaskCanvas;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, w, h);
  for (const s of fakePersonShapes()) drawPersonShape(ctx, s, "#fff", scale);
  return ctx.getImageData(0, 0, w, h);
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

// ---- 化身のモデル（自分と相手の番号のぶんだけ読み込む。無ければ代わりの人型）----
type ModelEntry = { status: "loading" | "loaded" | "missing"; detail: string; loaded: LoadedKeshin | null };
const models = new Map<KeshinIndex, ModelEntry>();

/** その番号のモデルを読み込む（1 回だけ）。読み込めたら自分・相手のビューを差し替える */
function requestModel(index: KeshinIndex) {
  if (models.has(index)) return;
  const spec = KESHIN_SPECS[index];
  const entry: ModelEntry = { status: "loading", detail: spec.file, loaded: null };
  models.set(index, entry);
  const t0 = performance.now();
  loadKeshinModel(spec)
    .then((loaded) => {
      entry.status = "loaded";
      entry.loaded = loaded;
      entry.detail = `load=${loaded.loadMs.toFixed(0)}ms measure=${(loaded.measureMs ?? 0).toFixed(1)}ms tris=${loaded.triangles} front=${loaded.frontZ.toFixed(2)} head=${loaded.head.y.toFixed(2)}`;
      if (selfView?.spec.index === index) selfView.setModel(loaded);
      remotes.onModelLoaded(index, loaded);
      logEvent("model-loaded", `#${index} ${spec.file} ${(performance.now() - t0).toFixed(0)}ms load=${loaded.loadMs.toFixed(0)}ms measure=${(loaded.measureMs ?? 0).toFixed(1)}ms tris=${loaded.triangles} frontZ=${loaded.frontZ.toFixed(3)} headY=${loaded.head.y.toFixed(3)}`);
    })
    .catch((e: unknown) => {
      entry.status = "missing";
      entry.detail = e instanceof Error ? e.message.slice(0, 80) : String(e);
      logEvent("model-failed", `#${index} ${spec.file} ${(performance.now() - t0).toFixed(0)}ms ${entry.detail}`);
    });
}

/** 自分の化身のモデルの状態（HUD 用） */
function selfModel(): { status: string; detail: string } {
  const me = selfState();
  return (me && models.get(me.info.keshin)) ?? { status: "idle", detail: "" };
}

/**
 * 自分の化身のシェーダーを先にコンパイルする（初めて見上げた瞬間に固まらないように）。化身を作った直後とモデルを差し替えた直後に、
 * 描画ループの本描画の直前でキャンバスへ実際の設定（StereoEffect の左右のカメラ・クリッピング・出力の色空間）のまま 1 回描く。
 * 直後の本描画（autoClear）が消すので見えない。かかった時間と、新しくリンクされたプログラムの数を HUD と実機ログに出す
 */
let warmupInfo = "-";
function warmUpIfPending() {
  // 相手の化身（段階 2）も同じ方法で。自分の化身と同じフレームに重ならないよう 1 フレーム 1 体
  const remote = [...remotes.views.values()].find((e) => e.view.warmPending)?.view ?? null;
  const view = selfView?.warmPending ? selfView : remote;
  if (!view || !view.warmPending) return;
  const what = `${view === selfView ? "self" : "remote"}#${view.spec.index} ${view.warmPending}`;
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

// ---- 段階 2: 相手の化身（remote-keshins.ts）と、人の形で隠す処理（keshin-occlusion.ts）----
const occlusion = new OcclusionController(
  {
    // 段階 3 の B: 隠す処理を止めても（?occlude=0）、カメラで見た位置に使うので Pose は回す（?posMode=declared なら回さない）
    enabled: OCCLUDE || POS_MODE !== "declared",
    fake: FAKE_PERSON,
    maskHz: MASK_HZ,
    maskHzAuto: MASK_HZ_AUTO,
    maxPoses: MASK_POSES,
    detW: MASK_DET_W,
    delegate: DELEGATE,
    modelUrls: POSE_MODEL_URLS,
    staleOffMs: 1000,
    debug: MASK_DEBUG && OCCLUDE,
    probeAfterMs: MASK_PROBE_AFTER_MS,
    maskSource: MASK_SOURCE,
    maskMinMax: MASK_MIN_MAX,
    log: logEvent,
    onPoses: (landmarks, world, now) => onPoses(landmarks, world, now),
    fakePoses: FAKE_PERSON ? () => fakePoseResult() : undefined,
  },
  MASK_DILATE_PX,
  MASK_DEPTH_MARGIN,
  MASK_EDGE,
);
// ?maskDebug=1: 画面の右上に Pose に渡した入力（上）と最新のマスク（下。白 = 人）を小さく出す（実機で目で見て確かめる用）
if (MASK_DEBUG && OCCLUDE) {
  const box = document.createElement("div");
  box.id = "mask-debug";
  box.style.cssText =
    "position:fixed;top:calc(8px + env(safe-area-inset-top));right:calc(8px + env(safe-area-inset-right));z-index:6;pointer-events:none;display:flex;flex-direction:column;gap:4px;";
  const mk = () => {
    const c = document.createElement("canvas");
    c.width = 192;
    c.height = 108;
    c.style.cssText = "width:192px;height:auto;background:#000;border:1px solid rgba(255,255,255,0.4);";
    box.appendChild(c);
    return c;
  };
  const input = mk();
  const mask = mk();
  document.body.appendChild(box);
  occlusion.setDebugCanvases({ input, mask });
}
const remotes = new RemoteKeshins(
  scene,
  {
    heightM: KESHIN_H,
    eyeH: EYE_H,
    backOverride: KESHIN_BACK,
    opacity: OTHER_OPACITY,
    auraN: AURA_N,
    smoothSec: REMOTE_SMOOTH_SEC,
    snapM: SNAP_M,
    staleMs: STALE_MS,
    staleHideMs: STALE_HIDE_MS,
    noPoseMs: NO_POSE_MS,
    lostMs: PEER_LOST_MS,
    look: LOOK,
    posMode: POS_MODE,
    matchDeg: MATCH_DEG,
    onlyOneMaxDeg: ONLY_ONE_MAX_DEG,
    corrRecentSec: CORR_RECENT_SEC,
    cameraFadeMs: 200,
    matchM: MATCH_M,
    facingMaxDeg: FACING_MAX_DEG,
    corrGateM: CORR_GATE_M,
    distW: DIST_W,
    corrWindowSec: CORR_WINDOW_SEC,
    corrDecaySec: CORR_DECAY_SEC,
    camStaleMs: 1000,
  },
  OCCLUDE ? occlusion.uniforms : null,
  (index) => models.get(index as KeshinIndex)?.loaded ?? null,
  logEvent,
);
let lastRemoteMs = performance.now();

/** 相手の化身を更新する（段階 2）。自分のアンカーが無い（track = none）間は描かない */
function updateRemotes(now: number) {
  const dt = Math.min(0.5, (now - lastRemoteMs) / 1000);
  lastRemoteMs = now;
  camera.getWorldPosition(camWorldPos);
  renderer.getDrawingBufferSize(drawingSize);
  remotes.update(now, dt, players, { anchor: markerAnchor?.everDetected ? anchor : null, camWorldPos, viewportH: drawingSize.y, selfAnchorFresh: selfAnchorFresh(now) });
}

/** 自分のアンカーが新しいか（マーカーを見ている、または見失ってから staleMs 未満） */
function selfAnchorFresh(now: number): boolean {
  const t = trackOf(now);
  return t.track === "marker" || (t.track === "gyro" && (t.ageMs ?? Infinity) < STALE_MS);
}

/** 段階 3 の B: Pose の結果（人の形のマスクと同じ推論）→ 自分のワールドの人 → 相手と結ぶ・補正を学ぶ */
let lastDetections: CamDetection[] = [];
function onPoses(landmarks: BodyLandmarkLike[][], world: BodyLandmarkLike[][], now: number) {
  const m = passthrough?.metricViewMapping();
  if (!m || POS_MODE === "declared") return;
  camera.updateMatrixWorld();
  const cm = camera.matrixWorld.elements;
  const dets: CamDetection[] = [];
  for (let i = 0; i < landmarks.length; i++) {
    const d = detectionToWorld(landmarks[i], world[i] ?? [], m, cm, { bodyScale: BODY_SCALE, minVisibility: MIN_VIS, maxDepthM: MAX_DEPTH_M });
    if (d) dets.push(d);
  }
  lastDetections = dets;
  camera.getWorldPosition(camWorldPos);
  remotes.observe(now, dets, players, { anchor: markerAnchor?.everDetected ? anchor : null, eye: [camWorldPos.x, camWorldPos.y, camWorldPos.z], selfAnchorFresh: selfAnchorFresh(now) });
}

/** 人の形の検出（相手の化身が視野に入っていそうな間だけ。マーカー検出と同じフレームでは回さない） */
function updateOcclusion(now: number, markerRan: boolean) {
  occlusion.syncBackground(passthrough?.texture ?? null);
  const need = remotes.anyVisibleInView(camera);
  const others = [...players.keys()].filter((id) => id !== selfId).length;
  // 段階 3 の B: 相手が 1 人でも入室していれば回す（化身が出ていなくても、割り当てと補正の学習のため）
  occlusion.update(now, need && OCCLUDE, passthrough?.video ?? null, markerRan, others, FAKE_PERSON ? fakeMaskImage : null, others > 0 && POS_MODE !== "declared");
}

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
  requestModel(index);
}

// ---- Room の状態（サーバーが確定したもの）----
/** poseRecvMs = その pose をサーバーが受け取った時刻（ローカル。スナップショットの pose は poseAgeMs だけ過去。poseReceivedLocal） */
type PlayerState = { info: KeshinPlayer; startLocalMs: number; poseRecvMs: number };
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
        for (const p of list) players.set(p.id, { info: p, startLocalMs: stageStartLocal(p.changedAt, now, recv), poseRecvMs: p.pose ? poseReceivedLocal(recv, p.poseAgeMs) : -Infinity });
        remotes.sync(players, selfId);
        for (const p of list) if (p.id !== id) requestModel(p.keshin);
        pending = null;
        const me = players.get(id);
        if (me) setupSelfKeshin(me.info.keshin);
        logEvent("welcome", `room=${ROOM} me=${id} keshin=${me?.info.keshin ?? "-"} players=${list.map((p) => `${p.id}:${p.keshin}${p.on ? "on" : ""}`).join(",")}`);
      },
      onJoin: (p, now) => {
        // 再接続の引き継ぎ（同じ session 鍵）なら on / changedAt を持っている → 演出なしで同じ見え方から
        const recv = performance.now();
        players.set(p.id, { info: p, startLocalMs: stageStartLocal(p.changedAt, now, recv), poseRecvMs: p.pose ? poseReceivedLocal(recv, p.poseAgeMs) : -Infinity });
        remotes.sync(players, selfId);
        requestModel(p.keshin);
        logEvent("join", `${p.id} "${p.name}" keshin=${p.keshin}${p.on ? " on" : ""}`);
      },
      onLeave: (id) => {
        if (players.delete(id)) logEvent("leave", id);
        remotes.sync(players, selfId);
      },
      onPose: (id, pose) => {
        // 段階 2: 相手の化身の位置と信用度に使う（remote-keshins.ts）
        const p = players.get(id);
        if (!p) return;
        p.info.pose = pose;
        p.poseRecvMs = poseReceivedLocal(performance.now(), undefined);
      },
      onKeshin: (id, on, keshin, changedAt, now) => {
        const recv = performance.now();
        const p = players.get(id);
        if (!p) return;
        p.info.on = on;
        p.info.keshin = keshin;
        p.info.changedAt = changedAt;
        p.startLocalMs = stageStartLocal(changedAt, now, recv);
        remotes.sync(players, selfId);
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
    // 主観の化身はマーカーが無くても出せる。位置の共有（俯瞰画面）と相手の化身の位置にはマーカーが要る
    const remoteOn = [...players.values()].some((p) => p.info.id !== selfId && p.info.on);
    text = remoteOn ? "壁のマーカーを見てください\n（相手の化身の位置が分かりません）" : "壁のマーカーを見てください\n（位置を共有します）";
    color = "#fdd663";
  }
  message.set(text, color);
  lastMessageText = text;
}
let lastMessageText = "";

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
  const m = selfModel();
  if (m.status === "loaded") return `loaded(${m.detail})`;
  if (m.status === "missing") return "missing(fallback)";
  return m.status;
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
    `model=${selfModel().status}`,
    `ws=${netStatus} me=${selfId || "-"} players=${players.size} sent=${posesSent}`,
    `cam=${cameraChoice || "-"}`,
    occlusion.describe(),
    remotes.diag(),
  ].join(" ");
}

// ---- HUD（デバッグ用） ----
const hud = document.querySelector<HTMLDivElement>("#hud")!;
const hudState = { base: "", sensor: "", cam: "", fsResult: "", fsChange: "", wake: "" };
/** 開いたカメラの facingMode と選んだ理由（HUD の cam= と実機ログ） */
let cameraChoice = "";
let lastHudText = "";
function renderHud() {
  const now = performance.now();
  const { track, ageMs } = trackOf(now);
  const modelLine =
    selfModel().status === "missing"
      ? `model=モデル未配置（npm run fetch:keshin）→ 代わりの人型で表示 [${selfModel().detail}]`
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
    occlusion.describe(),
    ...remotes.describe(players),
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
  hudState.base = `fov=${FOV_FIXED ?? "auto"} camZoom=${CAM_ZOOM} markerMm=${MARKER_MM} detW=${MARKER_DET_W}@${MARKER_INTERVAL_MS}ms gravityAlign=${GRAVITY_ALIGN ? 1 : 0} keshinH=${KESHIN_H} eyeH=${EYE_H} lean=${SELF_LEAN ?? "model"} lookUp=${LOOK_UP_DEG} auraN=${AURA_N} occlude=${OCCLUDE ? (FAKE_PERSON ? "fake" : 1) : 0} maskHz=${MASK_HZ}${MASK_HZ_AUTO ? "(auto)" : ""} maskDetW=${MASK_DET_W} maskSource=${MASK_SOURCE} maskMinMax=${MASK_MIN_MAX} delegate=${DELEGATE}${MASK_DEBUG ? " maskDebug=1" : ""} staleHideMs=${STALE_HIDE_MS} posMode=${POS_MODE} matchDeg=${MATCH_DEG} onlyOneMaxDeg=${ONLY_ONE_MAX_DEG} matchM=${MATCH_M} facingMaxDeg=${FACING_MAX_DEG} corrGateM=${CORR_GATE_M} distW=${DIST_W} corr=${CORR_WINDOW_SEC}s/${CORR_DECAY_SEC}s/${CORR_RECENT_SEC}s mode=${touch ? "gyro" : "orbit"}`;
  logEvent("start", `name=${name} room=${ROOM} ${hudState.base} ${describeLook(LOOK)}`);
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
        const choice = passthrough!.choice;
        // どのカメラを・なぜ選んだか（iPad の「前面超広角カメラ」問題の確認用。facing=environment が背面）
        cameraChoice = choice ? `facing=${choice.facingMode} why=${choice.reason}` : FAKE_CAM ? "facing=fake" : "facing=-";
        hudState.cam = `${passthrough!.summary} ${cameraChoice}`;
        hudState.base += ` camFov=${passthrough!.camHFovDeg}`;
        logEvent("camera", `${passthrough!.summary} ${cameraChoice} camFov=${passthrough!.camHFovDeg}`);
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
        model: selfModel().status,
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
    /** リンク済みのシェーダープログラムの名前（確認用。新しく増えたものを特定する） */
    programNames() {
      return (renderer.info.programs ?? []).map((p) => `${p.name}|${p.cacheKey.length}|${p.cacheKey.slice(-160)}`);
    },
    /** 視界内メッセージの文字（確認用） */
    messageText() {
      return lastMessageText;
    },
    /** 相手の化身の状態（段階 2） */
    /** 段階 3 の B: 位置の決め方を変える / 合成の人の本当の位置（マーカー座標系。null で申告位置） */
    setPosMode(mode: PosMode) {
      remotes.setPosMode(mode);
    },
    /** 相手の化身の見え方を段階 2 まで（false）/ URL の見え方（true）に切り替える（人の形で隠す確認用。ビューを作り直す） */
    /** 人の形で隠す前後の判定の余裕 [m] を変える（確認用。5 なら前後によらず人の形の上は全部隠す） */
    setMaskDepthMargin(m: number) {
      occlusion.uniforms.uMaskDepthMargin.value = m;
    },
    setRemoteLook(on: boolean) {
      remotes.setLook(on ? LOOK : null, players, selfId);
    },
    setFakeBodies(list: { head: V3; fwd: [number, number] }[] | null) {
      fakeBodiesOverride = list;
    },
    detections() {
      return lastDetections;
    },
    /** 合成の人の「本当の位置」（マーカー座標系 = フェイクカメラの field）を自分のワールドに直した点（アンカーの推定の誤差を含まない） */
    fakeTrueWorld(p: V3) {
      const camToField = fakeCamToFieldNow();
      if (!camToField) return null;
      camera.updateMatrixWorld();
      const c = transformPoint(invertRigid(camToField), p);
      return new THREE.Vector3(c[0], c[1], c[2]).applyMatrix4(camera.matrixWorld).toArray();
    },
    eyeWorld() {
      camera.getWorldPosition(camWorldPos);
      return camWorldPos.toArray();
    },
    remoteState() {
      return [...remotes.views.values()].map((e) => ({
        id: e.id,
        source: e.source,
        matchReason: e.matchReason,
        matchInfo: e.matchInfo,
        corrState: remotes.corrState(e.id, performance.now()),
        camDist: e.camDist,
        declDist: e.declDist,
        dirDeg: e.dirDeg,
        corrN: e.corr.length,
        headMarker: (() => {
          if (!e.shownHead || !markerAnchor?.everDetected) return null;
          anchor.updateWorldMatrix(true, false);
          return new THREE.Vector3(...e.shownHead).applyMatrix4(anchorInv.copy(anchor.matrixWorld).invert()).toArray();
        })(),
        keshin: e.view.spec.index,
        drawn: e.drawn,
        reason: e.reason,
        track: e.track,
        ageMs: e.ageMs,
        fade: e.fade,
        dist: e.dist,
        head: e.shownHead,
        yaw: e.shownYaw,
        world: e.drawn ? e.view.debugWorld() : null,
        gapNow: e.gapNow,
        snaps: e.snaps,
        fallback: e.view.isFallback,
        warmPending: e.view.warmPending,
      }));
    },
    /** 自分のワールドでのアンカー（マーカー座標系 → ワールド）の位置と回転 */
    anchorWorld() {
      anchor.updateWorldMatrix(true, false);
      const p = new THREE.Vector3();
      const q = new THREE.Quaternion();
      anchor.matrixWorld.decompose(p, q, new THREE.Vector3());
      return { pos: [p.x, p.y, p.z], quat: [q.x, q.y, q.z, q.w] };
    },
    occlusionState() {
      return { status: occlusion.status, detail: occlusion.detail, on: occlusion.uniforms.uMaskOn.value, hz: occlusion.hz, poseMs: occlusion.poseMs, ageMs: occlusion.ageMs, person: occlusion.mask.hasPerson, everMasked: occlusion.everMasked, lastPoses: occlusion.lastPoses, lastMasks: occlusion.lastMasks, lastInput: occlusion.lastInput, lastLuma: occlusion.lastLuma, delegate: occlusion.delegate, maskHz: occlusion.governor.hz, maskHzLevels: occlusion.governor.levels, runs: occlusion.runs, runsWithPerson: occlusion.runsWithPerson, probe: occlusion.probe, text: occlusion.describe() };
    },
    /** 隠す処理を一時的に止める / 戻す（確認用） */
    setMaskSource(mode: "seg" | "skel" | "auto") {
    occlusion.setMaskSource(mode);
  },
  setOcclusionDisabled(off: boolean) {
      occlusion.disabled = off;
      occlusion.uniforms.uMaskOn.value = off ? 0 : occlusion.uniforms.uMaskOn.value;
    },
    /**
     * 相手の化身を描いたときと描かないときの画素の差を、フェイクの人の中（inside）・外（outside）に分けて数える。
     * 人の中か外かは、化身を描かないフレームの背景の画素がフェイクの人の色（#5a6b86）かどうかで決める
     * （シェーダーと同じ式を使わずに、マスクの UV が背景と一致していることも確かめる）。人の縁の近く（±12px）は数えない。
     * occlude = false なら隠す処理を止めて描いたときの数。part = "model" ならオーラは比べずモデルだけ
     */
    pixelDiffRemote(id: string, occlude = true, part: "all" | "model" = "all") {
      const e = remotes.views.get(id);
      if (!e || !passthrough) return null;
      const gl = renderer.getContext();
      const w = gl.drawingBufferWidth;
      const h = gl.drawingBufferHeight;
      const read = () => {
        const buf = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        return buf;
      };
      const wasOn = occlusion.uniforms.uMaskOn.value;
      if (!occlude) occlusion.uniforms.uMaskOn.value = 0;
      effect.render(scene, camera);
      const a = read();
      let b: Uint8Array;
      if (part === "model") {
        b = e.view.withHidden("model", () => {
          effect.render(scene, camera);
          return read();
        });
      } else {
        const was = e.view.group.visible;
        e.view.group.visible = false;
        effect.render(scene, camera);
        b = read();
        e.view.group.visible = was;
      }
      // 背景（この化身を丸ごと描かないフレーム）
      const wasGroup = e.view.group.visible;
      e.view.group.visible = false;
      effect.render(scene, camera);
      const bg = read();
      e.view.group.visible = wasGroup;
      occlusion.uniforms.uMaskOn.value = wasOn;
      const isPerson = (x: number, y: number) => {
        if (x < 0 || y < 0 || x >= w || y >= h) return false;
        const i = (y * w + x) * 4;
        return Math.abs(bg[i] - 0x5a) + Math.abs(bg[i + 1] - 0x6b) + Math.abs(bg[i + 2] - 0x86) <= 30;
      };
      const r = 12;
      let changed = 0;
      let inside = 0;
      let outside = 0;
      let edge = 0;
      const insideSample: [number, number][] = [];
      for (let i = 0; i < a.length; i += 4) {
        if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) <= 24) continue;
        changed++;
        const px = (i / 4) % w;
        const py = Math.floor(i / 4 / w);
        const samples = [isPerson(px, py), isPerson(px + r, py), isPerson(px - r, py), isPerson(px, py + r), isPerson(px, py - r)];
        if (samples.every(Boolean)) {
          inside++;
          if (inside % 50 === 1 && insideSample.length < 12) insideSample.push([px, h - 1 - py]);
        } else if (samples.every((x) => !x)) outside++;
        else edge++;
      }
      return { changed, inside, outside, edge, total: w * h, maskOn: occlude ? wasOn : 0, insideSample };
    },
    pixelDiff(all = false, hideRemotes = false) {
      if (!selfView) return null;
      const gl = renderer.getContext();
      const w = gl.drawingBufferWidth;
      const h = gl.drawingBufferHeight;
      const read = () => {
        const buf = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        return buf;
      };
      // hideRemotes: 相手の化身を描かずに比べる（相手の化身と重なって自分の化身の見え方が変わるのを除く）
      const remoteVisible = [...remotes.views.values()].map((e) => [e.view.group, e.view.group.visible] as const);
      if (hideRemotes) for (const [g] of remoteVisible) g.visible = false;
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
      for (const [g, v] of remoteVisible) g.visible = v;
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
  // マーカー検出をこのフレームで回したか（回すと数 ms かかる。人の形の検出を同じフレームに重ねない）
  const tMarker = performance.now();
  markerAnchor?.update(now);
  const markerRan = performance.now() - tMarker > 1;
  if (markerAnchor?.everDetected && !anchor.visible) anchor.visible = true;
  markerFrame.visible = trackOf(now).track === "marker";
  anchor.updateMatrixWorld(true);
  watchTrack(now);
  updateBodyYaw(now);
  updateSelf(now);
  updateRemotes(now);
  updateOcclusion(now, markerRan);
  sendPoseIfDue(now);
  updateButton(now);
  updateMessage(now);
  if (document.body.classList.contains("started")) renderHud();
  warmUpIfPending();
  renderer.info.reset();
  const t0 = performance.now();
  effect.render(scene, camera);
  measureFrame(now, performance.now() - t0);
});
