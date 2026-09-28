import * as THREE from "three";
import { numParam, params, resolutionParam } from "../../src/shared/url-params";
import { CAM_FOV_WIDE, createFakeCameraStream, drawCheckerboard, startPassthrough } from "../../src/shared/passthrough-camera";
import type { Passthrough } from "../../src/shared/passthrough-camera";
import { isTouchDevice, keepScreenAwake, setupFullscreen } from "../../src/shared/start-flow";
import { startRemoteLog } from "../../src/shared/remote-log";
import { ROOM_ID_PATTERN } from "../../src/shared/shared-room-protocol";
import { DEFAULT_MARKER_MM } from "../../src/shared/marker-layout";
import type { KeshinIndex, KeshinPlayer } from "../../src/shared/keshin-protocol";
import { keshinTimeline } from "../../src/shared/keshin-timeline";
import type { KeshinVisual } from "../../src/shared/keshin-timeline";
import { poseReceivedLocal, smoothToward, smoothYaw, stageStartLocal, yawOfForward } from "./keshin-math";
import type { V3 } from "./keshin-math";
import { KESHIN_SPECS, loadKeshinModel } from "./keshin-assets";
import type { LoadedKeshin } from "./keshin-assets";
import { KeshinView } from "./keshin-view";
import { connectKeshin } from "./keshin-client";
import type { KeshinClient } from "./keshin-client";
import { OcclusionController, drawPersonShape, projectFakePerson } from "./keshin-occlusion";
import type { BodyLandmarkLike, PersonShape } from "./keshin-occlusion";
import { describeLook, lookFromParams } from "./keshin-look";
import { probeDissolve, probeStream } from "./keshin-probe";
import { assignMirrorTracked, fakeMirrorPose, mirrorPersonFromPose, mirrorVisibility } from "./mirror-math";
import type { FakeMirrorPerson, MirrorAssignInfo, MirrorPerson } from "./mirror-math";

// ex9-1 鏡モード（mirror.html）: iPad を前面カメラで自分を映す鏡にして、化身を確かめる。
//   - 見る専用の参加者として room に入る（役割は俯瞰画面と同じ overview。プロトコルは変えない）。化身の on/off と演出の timeline は全員と同じ経路
//   - 化身の位置は iPad のカメラで見た人（MediaPipe PoseLandmarker → 09 の body-math.ts で 3D 化）から決める。申告位置・マーカーは使わない
//   - three のカメラは原点に固定（iPad はスタンドに固定。ジャイロなし）。カメラ座標系 = ワールド。描画の FOV は背景に合わせる（backgroundFovDeg）
//   - 鏡: canvas を CSS の scaleX(-1) で背景と 3D をまとめて反転する（HUD・文字は反転しない）
//   - 誰の化身か: 最初は見えている人を近い順に、化身を出しているプレイヤーの参加順に割り当てる。一度付けた人は画像の上の頭の位置で追いかけ、
//     見えている間は付け替えない（見失って保持の時間が過ぎてから、残った人へ）。mirror-math.ts の assignMirrorTracked
//   - 見失ったら ?mirrorHoldMs=500 だけ最後の位置で保持してから ?mirrorFadeMs=500 で消す。見つけ直したらすぐ出す
//   - 人の形で隠す処理（持ち主の頭より奥だけ）はスマホの段階 2 と同じ（keshin-occlusion.ts。持ち主の頭は Pose で出した頭）

// ---- パラメータ ----
const roomRaw = params.get("room");
const ROOM = roomRaw === null ? "demo" : ROOM_ID_PATTERN.test(roomRaw) ? roomRaw : null;
const MARKER_MM = numParam("markerMm", DEFAULT_MARKER_MM, { max: 5000 });
const MARKER_ID = Math.round(numParam("markerId", 0, { min: 0, max: 999 }));
const CAM_RES = resolutionParam("camRes", [1280, 720]);
/** 背景の表示倍率（鏡は切り抜きなしの 1 が既定） */
const CAM_ZOOM = numParam("camZoom", 1, { min: 0.2, max: 5 });
/** 前面カメラの水平 FOV [deg] の上書き（未指定ならカメラ名から推定: 超広角 106 / それ以外 68） */
const CAM_FOV: number | undefined = params.has("camFov") ? numParam("camFov", CAM_FOV_WIDE, { min: 10, max: 170 }) : undefined;

const KESHIN_H = numParam("keshinH", 3, { min: 0.5, max: 20 });
const EYE_H = numParam("eyeH", 1.5, { min: 0.3, max: 3 });
const KESHIN_BACK: number | null = params.has("keshinBack") ? numParam("keshinBack", 0.5, { min: -5, max: 10 }) : null;
const OTHER_OPACITY = numParam("otherOpacity", 0.85, { min: 0, max: 1 });
/** 段階 3 の C: 化身の見え方（腰を頭より上・溶ける下端・背中からの光の流れ）。?look=0 で段階 2 まで */
const LOOK = lookFromParams();
const AURA_N = Math.round(numParam("auraN", 400, { min: 0, max: 20000 }));
/** 表示の位置・向きを検出した人へ寄せる時定数 [s] */
const MIRROR_SMOOTH_SEC = numParam("mirrorSmoothSec", 0.15, { min: 0, max: 5 });
/** これ以上離れた人へは寄せずに即座に移す [m] */
const MIRROR_SNAP_M = numParam("mirrorSnapM", 1.5, { min: 0.1, max: 100 });
/** 見失ってから最後の位置で保持する時間 [ms] と、その後に消す時間 [ms] */
const HOLD_MS = numParam("mirrorHoldMs", 500, { min: 0, max: 60000 });
const FADE_MS = numParam("mirrorFadeMs", 500, { min: 1, max: 60000 });
/**
 * 前の結果の人と同じ人とみなす、画像の上の頭の距離の上限（正規化座標。画像の幅・高さを 1 とする。最後に見えてからの時間で 0.05 から
 * ここまで広げる = mirror-math.ts の mirrorImgGate）。3D の頭の距離は Pose の距離の推定が
 * 数十 cm ぶれて対応が外れる（実機で 2 人の間を行き来した）ので、画像の上の位置を主にする（3D は同じくらいのときの決め手だけ）
 */
const MATCH_IMG = numParam("mirrorMatchImg", 0.15, { min: 0.01, max: 1 });
/** Pose の結果がこれだけ来なければ「止まった」とみなす [ms]（HUD とログに出す。化身は保持 → フェードで消える） */
const POSE_STALL_MS = numParam("poseStallMs", 1000, { min: 200, max: 60000 });
/** 人の 3D 化（09 と同じ）: worldLandmarks の実寸補正・可視とみなす visibility・これより遠い人は無視 [m] */
const BODY_SCALE = numParam("bodyScale", 1, { min: 0.3, max: 3 });
const MIN_VIS = numParam("minVis", 0.5, { min: 0, max: 1 });
const MAX_DEPTH_M = numParam("maxDepth", 8, { min: 0.5, max: 30 });
// 人の形の検出（段階 2 と同じ既定値。Pose は人の位置を出すのにも使うので常に回す）
const OCCLUDE = params.get("occlude") !== "0";
const MASK_HZ = numParam("maskHz", 15, { min: 1, max: 60 });
const MASK_HZ_AUTO = params.get("maskHzAuto") !== "0";
const MASK_POSES = Math.round(numParam("maskPoses", 3, { min: 1, max: 4 }));
const MASK_DILATE_PX = numParam("maskDilatePx", 3, { min: 0, max: 30 });
const MASK_DEPTH_MARGIN = numParam("maskDepthMargin", 0.15, { min: -2, max: 5 });
const MASK_EDGE: [number, number] = (() => {
  const v = (params.get("maskEdge") ?? "").split(",").map(Number);
  return v.length === 2 && v.every((x) => Number.isFinite(x) && x >= 0 && x <= 1) && v[0] < v[1] ? [v[0], v[1]] : [0.3, 0.7];
})();
const MASK_DET_W = numParam("maskDetW", 512, { min: 64, max: 1280 });
const MASK_DEBUG = params.get("maskDebug") === "1";
/** 人の形の出どころ: seg = MediaPipe の segmentation mask、skel = Pose の骨格から描く、auto（既定）= seg の中身が空なら skel */
const MASK_SOURCE: "seg" | "skel" | "auto" = (() => {
  const v = (params.get("maskSource") ?? "auto").toLowerCase();
  return v === "seg" || v === "skel" ? v : "auto";
})();
/** auto で seg の中身が空とみなすマスクの最大値 */
const MASK_MIN_MAX = numParam("maskMinMax", 0.1, { min: 0, max: 1 });
const MASK_PROBE_AFTER_MS = numParam("maskProbeAfterMs", 10000, { min: 1000, max: 600000 });
const delegateRaw = (params.get("delegate") ?? "auto").toLowerCase();
const DELEGATE: "GPU" | "CPU" | "auto" = delegateRaw === "gpu" ? "GPU" : delegateRaw === "cpu" ? "CPU" : "auto";
const POSE_MODEL_URLS = params.get("poseModel")
  ? [params.get("poseModel")!]
  : [
      `${import.meta.env.BASE_URL}models/pose_landmarker_lite.task`,
      "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
    ];
// PC 確認用
const FAKE_CAM = params.has("fakecam");
/** ?fakeperson=1: フェイクカメラの映像に合成の人を描き、Pose の代わりに同じ人の骨格と人の形のマスクを使う */
const FAKE_PERSON = FAKE_CAM && params.get("fakeperson") === "1";
/** 合成の人（カメラ座標系の頭 x,y,z と体の向き yaw [deg]。0 = カメラの方。; で複数人）。既定は正面 3.2m に 1 人 */
let fakePeople: FakeMirrorPerson[] = (() => {
  const raw = params.get("fakePeople") ?? "0,0.25,-3.2,0";
  const out: FakeMirrorPerson[] = [];
  for (const part of raw.split(";")) {
    const v = part.split(",").map(Number);
    if (v.length < 3 || !v.slice(0, 3).every(Number.isFinite)) continue;
    const yaw = THREE.MathUtils.degToRad(Number.isFinite(v[3]) ? v[3] : 0);
    out.push({ head: [v[0], v[1], v[2]], fwd: [Math.sin(yaw), Math.cos(yaw)] });
  }
  return out;
})();

const touch = isTouchDevice();

// ---- 実機ログ ----
startRemoteLog({ tag: "keshin-mirror", snapshot: () => diagSummary(), snapshotMs: 1000 });
const EVENT_MAX_PER_SEC = 5;
const eventBudget = new Map<string, { windowStartMs: number; n: number; dropped: number }>();
function logEvent(kind: string, detail = "") {
  let line = `[keshin-mirror] event=${kind}${detail ? ` ${detail}` : ""}`;
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

// ---- シーン（カメラは原点に固定。カメラ座標系 = ワールド）----
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a2233);
scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.6));
const dirLight = new THREE.DirectionalLight(0xffffff, 1.8);
dirLight.position.set(3, 10, 4);
scene.add(dirLight);
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.05, 100);
scene.add(camera);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.localClippingEnabled = true;
document.querySelector<HTMLDivElement>("#app")!.appendChild(renderer.domElement);

let passthrough: Passthrough | null = null;
function resize() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  passthrough?.updateCover();
}
resize();
addEventListener("resize", resize);

// ---- フェイクカメラ（PC 確認用）: 合成の人をカメラ座標系に立たせて投影する ----
const FAKE_CAM_W = 640;
const FAKE_CAM_H = 480;
const FAKE_FOV = CAM_FOV ?? CAM_FOV_WIDE;
const FAKE_FOCAL_PX = FAKE_CAM_W / 2 / Math.tan(THREE.MathUtils.degToRad(FAKE_FOV) / 2);
/** カメラ → field の姿勢（鏡モードは field = カメラ座標系なので単位行列） */
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function fakeShapes(): PersonShape[] {
  const out: PersonShape[] = [];
  for (const p of fakePeople) {
    const s = projectFakePerson({ head: p.head, fwd: p.fwd }, IDENTITY, FAKE_FOCAL_PX, FAKE_CAM_W, FAKE_CAM_H);
    if (s) out.push(s);
  }
  return out;
}
function fakeStream(): MediaStream {
  return createFakeCameraStream(
    (ctx, canvas, frame) => {
      drawCheckerboard(ctx, canvas, frame);
      if (!FAKE_PERSON) return;
      for (const s of fakeShapes()) {
        drawPersonShape(ctx, s, "#5a6b86");
        // 本人の左手首に赤い印（鏡の左右反転を確かめる用。カメラの方を向いた人の左手は、反転前の画像では右に写る）
        ctx.fillStyle = "#e0302a";
        ctx.beginPath();
        ctx.arc(s.leftHand[0], s.leftHand[1], Math.max(4, s.head.r * 0.45), 0, Math.PI * 2);
        ctx.fill();
      }
    },
    { width: FAKE_CAM_W, height: FAKE_CAM_H },
  );
}
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
  for (const s of fakeShapes()) drawPersonShape(ctx, s, "#fff", scale);
  return ctx.getImageData(0, 0, w, h);
}

// ---- カメラ（前面。フェイクなら合成）----
let cameraInfo = "";
let cameraError = "";
async function startCamera(onProgress: (step: string) => void) {
  const video = document.createElement("video");
  video.playsInline = true;
  video.muted = true;
  const stream = FAKE_CAM
    ? fakeStream()
    : await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "user" }, width: { ideal: CAM_RES[0] }, height: { ideal: CAM_RES[1] } },
        audio: false,
      });
  onProgress("gum-ok");
  video.srcObject = stream;
  await video.play();
  passthrough = await startPassthrough(
    scene,
    {
      existingVideo: video,
      camRes: CAM_RES,
      preferUltraWide: false,
      camFovOverride: FAKE_CAM ? FAKE_FOV : CAM_FOV,
      eyeAspect: () => innerWidth / innerHeight,
      zoom: CAM_ZOOM,
    },
    onProgress,
  );
  const track = stream.getVideoTracks()[0];
  const facing = FAKE_CAM ? "fake" : ((track?.getSettings?.().facingMode as string | undefined) ?? "-");
  const fovSrc = FAKE_CAM ? "fake" : CAM_FOV !== undefined ? "url" : "label-estimate";
  cameraInfo = `${passthrough.summary} facing=${facing} fov=${passthrough.camHFovDeg}(${fovSrc})`;
  logEvent("camera", cameraInfo);
  if (facing === "environment") logEvent("camera-warning", "背面カメラが開いた（鏡にならない）");
}

// ---- 化身のモデル ----
type ModelEntry = { status: "loading" | "loaded" | "missing"; loaded: LoadedKeshin | null; detail: string };
const models = new Map<KeshinIndex, ModelEntry>();
function requestModel(index: KeshinIndex) {
  if (models.has(index)) return;
  const spec = KESHIN_SPECS[index];
  const entry: ModelEntry = { status: "loading", loaded: null, detail: spec.file };
  models.set(index, entry);
  const t0 = performance.now();
  loadKeshinModel(spec)
    .then((loaded) => {
      entry.status = "loaded";
      entry.loaded = loaded;
      entry.detail = `${loaded.loadMs.toFixed(0)}ms tris=${loaded.triangles}`;
      for (const e of entries.values()) if (e.view.spec.index === index) e.view.setModel(loaded);
      logEvent("model-loaded", `#${index} ${spec.file} ${(performance.now() - t0).toFixed(0)}ms tris=${loaded.triangles}`);
    })
    .catch((e: unknown) => {
      entry.status = "missing";
      entry.detail = e instanceof Error ? e.message.slice(0, 80) : String(e);
      logEvent("model-failed", `#${index} ${spec.file} ${entry.detail}`);
    });
}

// ---- 人の検出（Pose。人の形のマスクも同じ推論から）----
/** 直近の Pose の結果で見つけた人（カメラ座標系）と、その時刻 */
let persons: MirrorPerson[] = [];
let personsAtMs = -Infinity;
let lastPersonCount = 0;
function onPoses(landmarks: BodyLandmarkLike[][], world: BodyLandmarkLike[][], now: number) {
  const m = passthrough?.metricViewMapping();
  if (!m) return;
  const found: MirrorPerson[] = [];
  for (let i = 0; i < landmarks.length; i++) {
    const p = mirrorPersonFromPose(landmarks[i], world[i] ?? [], m, { bodyScale: BODY_SCALE, minVisibility: MIN_VIS, maxDepthM: MAX_DEPTH_M });
    if (p) found.push(p);
  }
  persons = found;
  personsAtMs = now;
  if (found.length !== lastPersonCount) {
    logEvent(found.length > lastPersonCount ? "person-found" : "person-lost", `persons ${lastPersonCount}→${found.length}${found.length ? ` depth=${found.map((p) => p.depth.toFixed(2)).join(",")}` : ""}`);
    lastPersonCount = found.length;
  }
  assignNow(now);
}

const occlusion = new OcclusionController(
  {
    enabled: true,
    fake: FAKE_PERSON,
    maskHz: MASK_HZ,
    maskHzAuto: MASK_HZ_AUTO,
    maxPoses: MASK_POSES,
    detW: MASK_DET_W,
    delegate: DELEGATE,
    modelUrls: POSE_MODEL_URLS,
    staleOffMs: 1000,
    debug: MASK_DEBUG,
    probeAfterMs: MASK_PROBE_AFTER_MS,
    maskSource: MASK_SOURCE,
    maskMinMax: MASK_MIN_MAX,
    log: logEvent,
    onPoses,
    fakePoses: FAKE_PERSON
      ? () => {
          const m = passthrough?.metricViewMapping();
          return m ? fakeMirrorPose(fakePeople, m) : { landmarks: [], worldLandmarks: [] };
        }
      : undefined,
  },
  MASK_DILATE_PX,
  MASK_DEPTH_MARGIN,
  MASK_EDGE,
);
if (MASK_DEBUG) {
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

// ---- プレイヤーと化身（割り当てた人の背後に、スマホの「他人用」と同じ部品・置き方で）----
type PlayerState = { info: KeshinPlayer; startLocalMs: number; poseRecvMs: number };
type MirrorEntry = {
  id: string;
  view: KeshinView;
  /** 表示中の頭・向き・頭から床まで（状態はこの表示中の値だけ。null = まだ置いていない / 消した） */
  shownHead: V3 | null;
  shownYaw: number | null;
  shownEyeH: number | null;
  /** 割り当てた人の最新の値と、最後に見えた時刻（Pose の結果の時刻） */
  target: MirrorPerson | null;
  lastSeenMs: number;
  /** 確認用: 見え方（drawn / fade / reason）を最後に決めたフレームの時刻 */
  lastVisMs: number;
  personIndex: number | null;
  /** 直近の割り当ての結果と判断に使った値（画像の上の距離など。HUD とログ用） */
  assign: MirrorAssignInfo | null;
  drawn: boolean;
  reason: string;
  fade: number;
  visual: KeshinVisual | null;
};
const players = new Map<string, PlayerState>();
const entries = new Map<string, MirrorEntry>();

/** 化身が見えている（出ている・消える演出の途中）プレイヤー（参加順 = Map の順） */
function activePlayers(now: number): PlayerState[] {
  return [...players.values()].filter((p) => !keshinTimeline((now - p.startLocalMs) / 1000, p.info.on ? "appear" : "vanish").hidden);
}

function ensureEntry(p: PlayerState): MirrorEntry {
  let e = entries.get(p.info.id);
  if (e && e.view.spec.index === p.info.keshin) return e;
  e?.view.dispose();
  const spec = KESHIN_SPECS[p.info.keshin];
  const view = new KeshinView(
    spec,
    {
      mode: "other",
      heightM: KESHIN_H,
      eyeH: EYE_H,
      backOverride: KESHIN_BACK,
      leanDeg: 0,
      selfBackOverride: null,
      faceAheadM: 0,
      opacity: OTHER_OPACITY,
      auraN: AURA_N,
      nearFade: null,
      mask: OCCLUDE ? occlusion.uniforms : null,
      look: LOOK,
    },
    models.get(p.info.keshin)?.loaded ?? null,
  );
  scene.add(view.group);
  requestModel(p.info.keshin);
  e = { id: p.info.id, view, shownHead: null, shownYaw: null, shownEyeH: null, target: null, lastSeenMs: -Infinity, lastVisMs: -Infinity, personIndex: null, assign: null, drawn: false, reason: "-", fade: 0, visual: null };
  entries.set(p.info.id, e);
  return e;
}

function removeEntry(id: string) {
  const e = entries.get(id);
  if (!e) return;
  e.view.dispose();
  entries.delete(id);
}

let lastAssignKey = "";
/**
 * Pose の結果が届くたびに、見えている人を化身の出ているプレイヤーへ割り当てる（mirror-math.ts の assignMirrorTracked）。
 * 1 人の人には化身を 1 体だけ。前の結果で付けていた人（画像の上の頭が ?mirrorMatchImg= 以内）には同じ化身を付け続け、
 * その人を見失っても ?mirrorHoldMs= の間はほかの人へ付け替えない。持つ状態は化身ごとの「前回の人（target）と最後に見えた時刻」だけ
 */
function assignNow(now: number) {
  const act = activePlayers(now);
  const res = assignMirrorTracked(
    persons,
    act.map((p) => {
      const e = entries.get(p.info.id);
      // 前回の人の位置は、見失って消えるまでの間だけ使う
      const alive = e && e.target && now - e.lastSeenMs <= HOLD_MS + FADE_MS;
      return { id: p.info.id, last: alive ? { img: e.target!.img, head: e.target!.head } : null, sinceSeenMs: e ? now - e.lastSeenMs : Infinity };
    }),
    { matchImg: MATCH_IMG, holdMs: HOLD_MS },
  );
  for (const p of act) {
    const e = ensureEntry(p);
    e.assign = res.info.get(p.info.id) ?? null;
    const idx = res.assign.get(p.info.id);
    if (idx === undefined) {
      e.personIndex = null;
      // 付いていた人が別の化身に付いた: 保持せずにすぐフェードに入れる（同じ人の所に 2 体重ならないように）
      if (res.displaced.has(p.info.id) && now - e.lastSeenMs < HOLD_MS) {
        e.lastSeenMs = now - HOLD_MS;
        logEvent("reassign-fade", `${p.info.id} (its person went to another keshin)`);
      }
      continue;
    }
    e.personIndex = idx;
    e.target = persons[idx];
    e.lastSeenMs = now;
  }
  // 人の番号（結果の中の順番）は結果ごとに入れ替わりうるので、ログの鍵は「どの化身が付いているか・付け方」で比べる（番号の入れ替わりでは出さない）
  const key = act.map((p) => `${p.info.id}:${res.info.get(p.info.id)?.reason ?? "-"}`).join(",");
  if (key !== lastAssignKey) {
    const detail = act
      .map((p) => {
        const i = res.info.get(p.info.id);
        return `${p.info.id}→${res.assign.has(p.info.id) ? res.assign.get(p.info.id) : "-"}(${i?.reason ?? "-"} ${describeAssignValues(i ?? null)})`;
      })
      .join(",");
    logEvent("assign", `${detail || "-"} persons=${persons.length}`);
    lastAssignKey = key;
  }
}

let lastFrameMs = performance.now();
function updateEntries(now: number) {
  const dt = Math.min(0.5, (now - lastFrameMs) / 1000);
  lastFrameMs = now;
  const act = new Set(activePlayers(now).map((p) => p.info.id));
  for (const [id, p] of players) {
    const e = entries.get(id);
    if (!e) continue;
    const visual = keshinTimeline((now - p.startLocalMs) / 1000, p.info.on ? "appear" : "vanish");
    e.visual = visual;
    e.lastVisMs = now;
    // 濃さは常に「いま − 最後にその人を見た時刻」で決める（Pose が止まっても保持 → フェード → 消える）
    const hf = mirrorVisibility(now, e.lastSeenMs, personsAtMs, { holdMs: HOLD_MS, fadeMs: FADE_MS, staleResultMs: POSE_STALL_MS });
    if (!act.has(id) || !e.target || !hf.draw) {
      const reason = !act.has(id) ? "off" : e.lastSeenMs === -Infinity ? "no-person" : "lost";
      setDrawn(e, false, reason);
      e.view.hide();
      e.shownHead = null;
      e.shownYaw = null;
      e.shownEyeH = null;
      e.fade = 0;
      if (!act.has(id)) {
        e.target = null;
        e.lastSeenMs = -Infinity;
      }
      continue;
    }
    const t = e.target;
    const sm = smoothToward(e.shownHead, t.head, dt, MIRROR_SMOOTH_SEC, MIRROR_SNAP_M);
    e.shownHead = sm.pos;
    const targetYaw = yawOfForward(t.fwd);
    e.shownYaw = sm.snapped || e.shownYaw === null ? targetYaw : smoothYaw(e.shownYaw, targetYaw, dt, MIRROR_SMOOTH_SEC);
    // 足首が見えていれば床から（頭 − 床）、見えなければ ?eyeH=
    const eyeHTarget = t.floorY !== null ? THREE.MathUtils.clamp(t.head[1] - t.floorY, 0.8, 2.3) : EYE_H;
    const k = MIRROR_SMOOTH_SEC > 0 ? 1 - Math.exp(-dt / MIRROR_SMOOTH_SEC) : 1;
    e.shownEyeH = e.shownEyeH === null || sm.snapped ? eyeHTarget : e.shownEyeH + (eyeHTarget - e.shownEyeH) * k;
    e.fade = hf.fade;
    e.view.update({ head: e.shownHead, yaw: e.shownYaw, visual, fade: hf.fade, aura: true, timeSec: now / 1000, viewportH: renderer.domElement.height, eyeH: e.shownEyeH });
    setDrawn(e, !visual.hidden && e.view.modelVisible, hf.phase === "seen" ? "ok" : hf.phase);
  }
}

function setDrawn(e: MirrorEntry, drawn: boolean, reason: string) {
  if (drawn && !e.drawn) logEvent("keshin-shown", `${e.id} keshin=${e.view.spec.index} person=${e.personIndex ?? "-"} depth=${e.target ? e.target.depth.toFixed(2) : "-"} model=${e.view.isFallback ? "fallback" : "loaded"}`);
  else if (!drawn && e.drawn) logEvent("keshin-hidden", `${e.id} reason=${reason}`);
  e.drawn = drawn;
  e.reason = reason;
}

let warmupInfo = "-";
function warmUpPending() {
  for (const e of entries.values()) {
    if (!e.view.warmPending) continue;
    const what = `#${e.view.spec.index} ${e.view.warmPending}`;
    e.view.warmPending = null;
    const before = renderer.info.programs?.length ?? 0;
    const t0 = performance.now();
    try {
      e.view.forceVisible(() => renderer.render(scene, camera));
    } catch (err: unknown) {
      logEvent("warmup-failed", `${what} ${err instanceof Error ? err.message : String(err)}`);
    }
    warmupInfo = `${what} ${(performance.now() - t0).toFixed(0)}ms programs=${before}→${renderer.info.programs?.length ?? 0}`;
    logEvent("warmup", warmupInfo);
    return;
  }
}

// ---- 通信（見る専用。役割は俯瞰画面と同じ overview）----
let selfId = "";
let netStatus = "idle";
let client: KeshinClient | null = null;
addEventListener("pagehide", () => client?.dispose());

function upsertPlayer(info: KeshinPlayer, startLocalMs: number, recvMs: number) {
  const p: PlayerState = { info, startLocalMs, poseRecvMs: info.pose ? poseReceivedLocal(recvMs, info.poseAgeMs) : -Infinity };
  players.set(info.id, p);
  const e = entries.get(info.id);
  if (e && e.view.spec.index !== info.keshin) removeEntry(info.id);
  requestModel(info.keshin);
  ensureEntry(p);
}

function connect() {
  if (ROOM === null) {
    netStatus = "error: room 名が不正";
    return;
  }
  client = connectKeshin(
    ROOM,
    "mirror",
    { markerId: MARKER_ID, markerMm: MARKER_MM },
    {
      onStatus: (status) => {
        netStatus = status;
      },
      onError: (reason) => {
        netStatus = `error: ${reason}`;
        logEvent("error", reason);
      },
      onWelcome: (id, _role, list, now) => {
        const recv = performance.now();
        selfId = id;
        netStatus = "open";
        for (const pid of [...entries.keys()]) removeEntry(pid);
        players.clear();
        for (const info of list) upsertPlayer(info, stageStartLocal(info.changedAt, now, recv), recv);
        logEvent("welcome", `room=${ROOM} me=${id} players=${list.map((p) => `${p.id}:${p.keshin}${p.on ? "on" : ""}`).join(",") || "-"}`);
      },
      onJoin: (info, now) => {
        const recv = performance.now();
        upsertPlayer(info, stageStartLocal(info.changedAt, now, recv), recv);
        logEvent("join", `${info.id} "${info.name}" keshin=${info.keshin}`);
      },
      onLeave: (id) => {
        if (!players.delete(id)) return;
        removeEntry(id);
        logEvent("leave", id);
      },
      onPose: (id) => {
        const p = players.get(id);
        if (p) p.poseRecvMs = performance.now();
      },
      onKeshin: (id, on, keshin, changedAt, now) => {
        const recv = performance.now();
        const p = players.get(id);
        if (!p) return;
        p.info.on = on;
        p.info.changedAt = changedAt;
        if (p.info.keshin !== keshin) {
          p.info.keshin = keshin;
          removeEntry(id);
        }
        p.startLocalMs = stageStartLocal(changedAt, now, recv);
        ensureEntry(p);
        logEvent(on ? "keshin-on" : "keshin-off", `${id} keshin=${keshin}`);
      },
    },
    "overview",
    // 鍵は俯瞰画面（overview）と分ける（タブを複製して鏡を開いても俯瞰画面を切らない）
    "mirror",
  );
}

// ---- Pose が止まったか（結果が POSE_STALL_MS 来ない）----
let poseStalled = false;
/** 確認用: Pose を回すのを止める（カメラの停止・推論の失敗の代わり） */
let debugPoseStopped = false;
function watchPoseStall(now: number) {
  const ready = FAKE_PERSON || occlusion.status === "ready";
  const stalled = ready && Number.isFinite(personsAtMs) && now - personsAtMs > POSE_STALL_MS;
  if (stalled === poseStalled) return;
  poseStalled = stalled;
  logEvent(stalled ? "pose-stalled" : "pose-resumed", `lastResult=${((now - personsAtMs) / 1000).toFixed(1)}s ago status=${occlusion.status}`);
}
function poseStateText(now: number): string {
  if (!Number.isFinite(personsAtMs)) return `pose=${FAKE_PERSON ? "fake" : occlusion.status}(no result yet)`;
  return `pose=${poseStalled ? "STALLED" : "ok"} last=${((now - personsAtMs) / 1000).toFixed(1)}s`;
}

// ---- 画面の下の案内・HUD ----
const messageEl = document.querySelector<HTMLDivElement>("#mirror-message")!;
function updateMessage(now: number) {
  let text = "";
  if (!document.body.classList.contains("started")) text = "";
  else if (cameraError) text = `カメラを開けません: ${cameraError.slice(0, 60)}`;
  else if (activePlayers(now).length === 0) text = "ゴーグルの人が化身ボタンを押すと出ます";
  else if (poseStalled) text = "人の検出が止まっています（カメラ・Pose を確認）";
  else if (persons.length === 0 && now - personsAtMs < 3000 + 1000 / Math.max(1, occlusion.governor.hz)) text = "カメラに人が写っていません（2〜3m 離れて、腰から上が入るように）";
  else if (persons.length === 0 && occlusion.status !== "ready" && !FAKE_PERSON) text = `人の検出を準備中（${occlusion.status}）`;
  if (messageEl.textContent !== text) messageEl.textContent = text;
  messageEl.hidden = text === "";
}

const hud = document.querySelector<HTMLDivElement>("#hud")!;
let fps = 0;
let fpsFrames = 0;
let fpsWindowStart = performance.now();
let renderMsEma = 0;
function describePersons(): string {
  return persons.map((p, i) => `#${i}:d${p.depth.toFixed(2)}/yaw${THREE.MathUtils.radToDeg(yawOfForward(p.fwd)).toFixed(0)}(${p.fwdSource})/floor${p.floorY === null ? "-" : p.floorY.toFixed(2)}/img${p.img[0].toFixed(2)},${p.img[1].toFixed(2)}`).join(" ") || "-";
}
/** 割り当ての判断に使った値: 前回の人から付けた人までの画像の上の距離 dImg・2 番目に近い人までの dImg2・その結果のしきい値 gate・3D の距離 d3（しきい値を決める材料） */
function describeAssignValues(i: MirrorAssignInfo | null): string {
  const f = (v: number | null | undefined, d: number) => (v === null || v === undefined ? "-" : v.toFixed(d));
  return `dImg=${f(i?.dImg, 3)} dImg2=${f(i?.dImg2, 3)} gate=${f(i?.gate, 3)} d3=${f(i?.d3, 2)}`;
}
function describeEntries(): string {
  return (
    [...entries.values()]
      .map((e) => {
        const p = players.get(e.id);
        return `${p?.info.name ?? e.id}(${e.id})#${e.view.spec.index}${p?.info.on ? "on" : "off"}→person${e.personIndex ?? "-"}(${e.assign?.reason ?? "-"} ${describeAssignValues(e.assign)}) drawn=${e.drawn ? 1 : 0}(${e.reason}) fade=${e.fade.toFixed(2)} u=${e.visual ? e.visual.u.toFixed(2) : "-"}`;
      })
      .join(" | ") || "-"
  );
}
function diagSummary(): string {
  if (!document.body.classList.contains("started")) return "";
  return [
    `fps=${fps.toFixed(0)} render=${renderMsEma.toFixed(1)}ms`,
    `cam=${cameraInfo || cameraError || "-"}`,
    occlusion.describe(),
    poseStateText(performance.now()),
    `persons=${persons.length} [${describePersons()}]`,
    `keshin=[${describeEntries()}]`,
    `ws=${netStatus} me=${selfId || "-"} players=${players.size}`,
    `models=${[...models.entries()].map(([i, m]) => `${i}:${m.status}`).join(",") || "-"}`,
  ].join(" ");
}
function renderHud() {
  const text = [
    `mirror room=${ROOM ?? "(不正)"} ws=${netStatus} me=${selfId || "-"} keshinH=${KESHIN_H} eyeH=${EYE_H} smooth=${MIRROR_SMOOTH_SEC}s hold=${HOLD_MS}ms fade=${FADE_MS}ms matchImg=${MATCH_IMG} fov now=${camera.fov.toFixed(1)}`,
    `cam=${cameraInfo || cameraError || "requesting"}`,
    `fps=${fps.toFixed(0)} render=${renderMsEma.toFixed(1)}ms tris=${renderer.info.render.triangles} calls=${renderer.info.render.calls} warmup=${warmupInfo}`,
    occlusion.describe(),
    `${poseStateText(performance.now())} persons=${persons.length} ${describePersons()}`,
    `keshin ${describeEntries()}`,
    `models ${[...models.entries()].map(([i, m]) => `#${i}:${m.status === "missing" ? "モデル未配置（npm run fetch:keshin）→ 代わりの人型" : `${m.status} ${m.detail}`}`).join(" ") || "-"}`,
  ].join("\n");
  if (hud.textContent !== text) hud.textContent = text;
}

// ---- 開始（カメラの許可 → 全画面。名前は要らない）----
const fsButton = document.querySelector<HTMLButtonElement>("#fs-button")!;
const tryEnterFullscreen = setupFullscreen({
  button: fsButton,
  touch,
  onResult: (status) => logEvent("fullscreen", status),
  onChange: () => {},
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
  logEvent("start", `room=${ROOM} keshinH=${KESHIN_H} eyeH=${EYE_H} smooth=${MIRROR_SMOOTH_SEC} matchImg=${MATCH_IMG} hold=${HOLD_MS} maskHz=${MASK_HZ}${MASK_HZ_AUTO ? "(auto)" : ""} maskDetW=${MASK_DET_W} maskSource=${MASK_SOURCE} maskMinMax=${MASK_MIN_MAX} delegate=${DELEGATE} fake=${FAKE_PERSON ? "person" : FAKE_CAM ? "cam" : 0} ${describeLook(LOOK)}`);
  connect();
  if (touch) keepScreenAwake((s) => logEvent("wakelock", s));
  startCamera((step) => {
    cameraInfo = step;
  })
    .then(() => {
      if (touch) tryEnterFullscreen();
    })
    .catch((e: unknown) => {
      cameraError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      cameraInfo = "";
      logEvent("error", `camera: ${cameraError}`);
    });
});

// ---- ヘッドレス確認用の口 ----
(window as unknown as { __keshinMirror: unknown }).__keshinMirror = {
  state() {
    const now = performance.now();
    return {
      started: document.body.classList.contains("started"),
      me: selfId,
      ws: netStatus,
      poseStalled,
      cam: cameraInfo,
      fov: camera.fov,
      persons: persons.map((p) => ({ head: p.head, fwd: p.fwd, source: p.fwdSource, depth: p.depth, floorY: p.floorY, img: p.img })),
      personsAgeMs: now - personsAtMs,
      message: messageEl.hidden ? "" : messageEl.textContent,
      programs: renderer.info.programs?.length ?? 0,
      warmup: warmupInfo,
      entries: [...entries.values()].map((e) => ({
        id: e.id,
        keshin: e.view.spec.index,
        on: players.get(e.id)?.info.on ?? false,
        personIndex: e.personIndex,
        assign: e.assign,
        sinceSeenMs: now - e.lastSeenMs,
        drawn: e.drawn,
        reason: e.reason,
        fade: e.fade,
        head: e.shownHead,
        yaw: e.shownYaw,
        eyeH: e.shownEyeH,
        fallback: e.view.isFallback,
        world: e.view.modelVisible ? e.view.debugWorld() : null,
      })),
    };
  },
  occlusionState() {
    return { status: occlusion.status, on: occlusion.uniforms.uMaskOn.value, person: occlusion.mask.hasPerson, lastPoses: occlusion.lastPoses, maskHz: occlusion.governor.hz, text: occlusion.describe() };
  },
  /** 合成の人を入れ替える（見失い → 保持 → フェード → 見つけ直しの確認用。[] で誰もいない） */
  setFakePeople(list: { head: V3; yawDeg: number }[]) {
    fakePeople = list.map((p) => ({ head: p.head, fwd: [Math.sin(THREE.MathUtils.degToRad(p.yawDeg)), Math.cos(THREE.MathUtils.degToRad(p.yawDeg))] as [number, number] }));
  },
  /**
   * 合成の人を消して、そこから ms の間、毎フレーム（ページの中で）その化身の見え方を記録する（見失い → 保持 → フェードの確認用。
   * 確認側からの 1 回ごとの問い合わせの遅れ（重い環境で数百 ms）に左右されない）
   */
  recordAfterRemove(id: string, ms: number) {
    fakePeople = [];
    const t0 = performance.now();
    const out: { t: number; sinceSeenMs: number; drawn: boolean; fade: number; reason: string }[] = [];
    return new Promise((resolve) => {
      const tick = () => {
        const now = performance.now();
        const e = entries.get(id);
        // 経過は見え方を決めたフレームの時刻から（rAF の順番で 1 フレーム前の値を読んでも、経過と見え方が食い違わない）
        if (e) out.push({ t: now - t0, sinceSeenMs: e.lastVisMs - e.lastSeenMs, drawn: e.drawn, fade: e.fade, reason: e.reason });
        if (now - t0 >= ms) resolve(out);
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  },
  /** Pose を回すのを止める / 再開する（Pose が止まったときの確認用） */
  setPoseStopped(stop: boolean) {
    debugPoseStopped = stop;
  },
  poseStalled() {
    return poseStalled;
  },
  /** その化身の足元・腰のオーラだけを、濃さ fade で描いたときの画素の明るさの差の合計（オーラにも fade が掛かることの確認用） */
  auraIntensity(id: string, fade: number) {
    const e = entries.get(id);
    if (!e || !e.shownHead || e.shownYaw === null || !e.visual) return null;
    const gl = renderer.getContext();
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    const read = () => {
      const buf = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      return buf;
    };
    const u = { head: e.shownHead, yaw: e.shownYaw, visual: e.visual, aura: true, timeSec: 12.345, viewportH: renderer.domElement.height, eyeH: e.shownEyeH ?? EYE_H };
    e.view.update({ ...u, fade });
    const a = e.view.withHidden("model", () => {
      renderer.render(scene, camera);
      return read();
    });
    const was = e.view.group.visible;
    e.view.group.visible = false;
    renderer.render(scene, camera);
    const b = read();
    e.view.group.visible = was;
    let sum = 0;
    for (let i = 0; i < a.length; i += 4) sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    return sum;
  },
  setMaskSource(mode: "seg" | "skel" | "auto") {
    occlusion.setMaskSource(mode);
  },
  setOcclusionDisabled(off: boolean) {
    occlusion.disabled = off;
    if (off) occlusion.uniforms.uMaskOn.value = 0;
  },
  /** 化身のモデルを描いたときと描かないときの画素の差を、人の形の中・外（背景の人の色 #5a6b86）で分けて数える（main.ts と同じ） */
  pixelDiff(id: string, occlude = true) {
    const e = entries.get(id);
    if (!e) return null;
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
    renderer.render(scene, camera);
    const a = read();
    const b = e.view.withHidden("model", () => {
      renderer.render(scene, camera);
      return read();
    });
    const wasGroup = e.view.group.visible;
    e.view.group.visible = false;
    renderer.render(scene, camera);
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
    /** 化身の画素のいちばん上（画面の上から [px]。0 なら画面の上で切れている）と、人の画素のいちばん上 */
    let topY = h;
    let personTopY = h;
    for (let i = 0; i < bg.length; i += 4) {
      if (Math.abs(bg[i] - 0x5a) + Math.abs(bg[i + 1] - 0x6b) + Math.abs(bg[i + 2] - 0x86) <= 30) personTopY = Math.min(personTopY, h - 1 - Math.floor(i / 4 / w));
    }
    for (let i = 0; i < a.length; i += 4) {
      if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) <= 24) continue;
      changed++;
      const px = (i / 4) % w;
      const py = Math.floor(i / 4 / w);
      topY = Math.min(topY, h - 1 - py);
      const s = [isPerson(px, py), isPerson(px + r, py), isPerson(px - r, py), isPerson(px, py + r), isPerson(px, py - r)];
      if (s.every(Boolean)) inside++;
      else if (s.every((x) => !x)) outside++;
    }
    return { changed, inside, outside, total: w * h, topY, personTopY, height: h };
  },
  /** 段階 3 の C の見え方を画素で調べる（切り口が無いか・背中からの光の流れがつながっているか。人の形で隠す処理は切って） */
  lookProbe(id: string) {
    const e = entries.get(id);
    if (!e) return null;
    const gl = renderer.getContext();
    const wasOn = occlusion.uniforms.uMaskOn.value;
    occlusion.uniforms.uMaskOn.value = 0;
    const render = () => renderer.render(scene, camera);
    try {
      return { dissolve: LOOK ? probeDissolve(gl, render, e.view, camera, LOOK.dissolveM) : null, stream: probeStream(gl, render, e.view, camera) };
    } finally {
      occlusion.uniforms.uMaskOn.value = wasOn;
    }
  },
  /** 画面の見え方（CSS の反転）: canvas は scaleX(-1)、HUD と案内は反転しない */
  transforms() {
    return {
      canvas: getComputedStyle(renderer.domElement).transform,
      hud: getComputedStyle(hud).transform,
      hudInsideApp: document.querySelector("#app")!.contains(hud),
      message: getComputedStyle(messageEl).transform,
    };
  },
};

// ---- ループ ----
renderer.setAnimationLoop(() => {
  const now = performance.now();
  if (passthrough) {
    const fov = passthrough.backgroundFovDeg();
    if (fov !== null && Math.abs(fov - camera.fov) > 0.01) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
  }
  camera.updateMatrixWorld();
  occlusion.syncBackground(passthrough?.texture ?? null);
  // Pose は人の位置を出すのにも使うので常に回す（隠す処理そのものは化身を描いているときだけ効く）
  if (passthrough && !debugPoseStopped) occlusion.update(now, true, passthrough.video, false, 1, FAKE_PERSON ? fakeMaskImage : null);
  watchPoseStall(now);
  updateEntries(now);
  updateMessage(now);
  warmUpPending();
  const t0 = performance.now();
  renderer.render(scene, camera);
  const renderMs = performance.now() - t0;
  renderMsEma = renderMsEma ? renderMsEma * 0.9 + renderMs * 0.1 : renderMs;
  fpsFrames++;
  if (now - fpsWindowStart >= 1000) {
    fps = (fpsFrames * 1000) / (now - fpsWindowStart);
    fpsFrames = 0;
    fpsWindowStart = now;
  }
  if (document.body.classList.contains("started")) renderHud();
});

if (params.has("autostart")) startButton.click();
