import * as THREE from "three";
import { StereoEffect } from "three/examples/jsm/effects/StereoEffect.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { DeviceOrientationControls } from "three-stdlib";
import { createMarkerDetector } from "./marker-detector";
import type { MarkerObservation } from "./marker-detector";
import markerSvgUrl from "./marker-0.svg";

// ---- ゴーグル調整パラメータ（URL クエリで実機合わせ込み） ----
// 実機で手打ちするパラメータなので、打ち間違い（NaN）や空文字（Number("") === 0）を
// 既定値に落とす。さらに「数値としては正当だが用途的に壊れる値」（例: detW=0.1 は
// 検出キャンバスが 0px に丸まって getImageData が例外を投げる、camFov=180 は
// tan(90°) で焦点距離が発散する）も範囲外として既定値に落とす
// （コードレビュー指摘: パラメータごとの範囲検証が無かった）
const params = new URLSearchParams(location.search);
// URL クエリから数値パラメータを1つ読む。範囲外・不正値は fallback に落とす
function numParam(
  name: string,
  fallback: number,
  { min = Number.EPSILON, max = Infinity } = {},
): number {
  const v = Number(params.get(name) ?? NaN);
  return Number.isFinite(v) && v >= min && v <= max ? v : fallback;
}
const FOV = numParam("fov", 70, { min: 20, max: 170 });
// eyeSep=0 はステレオ視差を無効化する校正モード（下の markerFrame 定義のコメント参照）
const EYE_SEP = numParam("eyeSep", 0.064, { min: 0, max: 0.2 }); // 人間の平均瞳孔間距離 ≈ 64mm

// ---- マーカー関連パラメータ ----
// markerMm: マーカー（黒い正方形）の一辺の実寸 [mm]。余白は含まない。
// marker.html を原寸（倍率 100%）で印刷したときの既定は 100mm。
// 画面表示した場合や拡縮印刷した場合は、定規で黒枠を測ってここに渡す
const MARKER_MM = numParam("markerMm", 100, { max: 5000 });
const MARKER_SIZE_M = MARKER_MM / 1000;
// markerId: World Origin として採用するマーカー ID。marker.html が印刷するのは ID 0。
// 0 は有効な ID なので他の URL パラメータと違い 0 を許容する。ID は整数なので丸める
// （小数のままだと === 比較が永遠に一致せず、黙って全拒否になる）
const MARKER_ID = Math.round(numParam("markerId", 0, { min: 0, max: 999 }));
// maxPoseError: 姿勢推定の正規化再投影誤差（ピクセル和 ÷ マーカーの画面上の平均辺長。
// 無次元なので detW を変えても意味が変わらない）の許容上限。
// きれいな検出で 0.0x、崩れた四角形で 1 前後（marker-detector.ts 参照）
const MAX_POSE_ERROR = numParam("maxPoseError", 0.5, { min: 0, max: 100 });
// anchorDist: マーカーの法線方向（面から視点側）に浮かべるボールまでの距離 [m]
const ANCHOR_DIST = numParam("anchorDist", 0.5, { max: 50 });
// detW: 検出にかける画像の長辺 [px]。大きいほど遠くの小さいマーカーを拾えるが検出が重くなる
const DET_W = numParam("detW", 640, { min: 64, max: 4096 });
// smooth: 検出姿勢の指数移動平均係数。検出値は毎フレーム揺れる（ジッタ）ため平滑化する。
// 1 で平滑化なし、小さいほど滑らかだが追従が遅れる。
// 0 は lerp/slerp が恒等になりアンカーが初回位置で凍結するため除外する
const SMOOTH = numParam("smooth", 0.25, { min: 0.01, max: 1 });
// lostHideMs: マーカーの最終検出からこの時間 [ms] 過ぎたらアンカーを消す。
// カメラは 3DoF（回転のみ）なのでロスト中の平行移動は追えず、猶予を過ぎたアンカーは
// 「現実に固定」の保証が無い古い座標になる。すぐ消すと1フレームの検出漏れでも
// 点滅するため、少しだけ待ってから隠す。フレーム数ではなく時刻基準なのは、
// カメラ映像が停止（トラック終了・中断等）して検出ループ自体が回らなくなっても
// 描画ループ側で消せるようにするため（コードレビュー指摘対応）
const LOST_HIDE_MS = numParam("lostHideMs", 500, { min: 50, max: 10000 });
// camFov: 実カメラの水平視野角 [deg]。姿勢推定の焦点距離換算に使う。
// ブラウザにはカメラの内部パラメータ（焦点距離）を取得する API が無いため、
// 開いたレンズの種別から推定した既定値（超広角 0.5x ≈ 106° / 標準 ≈ 68°）を使い、
// ズレは ?camFov= で実機合わせ込みする。カメラ起動後に確定する
let camHFovDeg = 68;

// ---- シーン ----
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a2233);

const camera = new THREE.PerspectiveCamera(
  FOV,
  innerWidth / innerHeight,
  0.1,
  100,
);
camera.position.set(0, 1.6, 0); // 立った人間の目線の高さ

scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.2));
const dirLight = new THREE.DirectionalLight(0xffffff, 1.5);
dirLight.position.set(3, 10, 2);
scene.add(dirLight);

// ---- アンカー（マーカー座標系に固定するオブジェクト群） ----
// マーカー検出時にワールド姿勢を更新する。ローカル座標系は
// X=マーカー右 / Y=マーカー上 / +Z=マーカー面から視点側（marker-detector.ts 参照）。
// 01/02 と違い固定シーン（箱の輪・グリッド）は置かない。現実に固定されて見えるか
// どうかの確認がこのデモの主題なので、アンカー由来の表示だけにする
const anchor = new THREE.Group();
anchor.visible = false; // 初検出まで非表示
scene.add(anchor);

// マーカー実寸の枠: 位置合わせの正解確認用。現実のマーカーにぴったり重なって
// 見えるべきもので、ズレていたら camFov / markerMm / fov の何かが合っていない。
// 注意: 背景の現実映像は単眼カメラ1枚を両眼に複製しているため視差が無いが、
// この枠は有限距離にある3Dオブジェクトとして StereoEffect で両眼別々に描画されるため
// 視差が付く。したがって「両眼で同時にぴったり重なる」は幾何的に成立しない
// （docs/CONCEPT.md の Phase 2 注記と同根。コードレビュー指摘で判明）。
// 厳密に位置合わせを確認したいときは ?eyeSep=0 を付けて視差を無効化する
const markerFrame = new THREE.Mesh(
  new THREE.PlaneGeometry(MARKER_SIZE_M, MARKER_SIZE_M),
  new THREE.MeshBasicMaterial({
    color: 0x8ab4f8,
    transparent: true,
    opacity: 0.4,
    side: THREE.DoubleSide,
  }),
);
anchor.add(markerFrame);
anchor.add(new THREE.AxesHelper(MARKER_SIZE_M)); // X=赤 Y=緑 Z=青（青が面から手前）

// アンカー本体: マーカー法線上 ANCHOR_DIST [m] に浮かぶボールと、マーカーと結ぶ線
const ball = new THREE.Mesh(
  new THREE.SphereGeometry(0.06, 24, 16),
  new THREE.MeshStandardMaterial({ color: 0xf28b82 }),
);
ball.position.set(0, 0, ANCHOR_DIST);
anchor.add(ball);
anchor.add(
  new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0, ANCHOR_DIST),
    ]),
    new THREE.LineBasicMaterial({ color: 0xf28b82 }),
  ),
);

// ---- レンダラー + 2眼（three 同梱の StereoEffect を利用） ----
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
document
  .querySelector<HTMLDivElement>("#app")!
  .appendChild(renderer.domElement);

const effect = new StereoEffect(renderer);
effect.setEyeSeparation(EYE_SEP);

function resize() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  effect.setSize(innerWidth, innerHeight);
  updateBackgroundCover();
}
resize();
addEventListener("resize", resize);

// ---- Passthrough 背景（背面カメラ → VideoTexture → scene.background） ----
// 方式・ハマりどころは 02-passthrough と同じ（詳細コメントはそちらを参照）
const video = document.createElement("video");
video.playsInline = true;
video.muted = true;

// PC デバッグ用: ?fakecam=1 でカメラの代わりにテストパターンを使う（02 と同方式）。
// 03 ではパターン中央にマーカー画像を描き、検出 → 姿勢推定 → アンカー配置までの
// 経路をヘッドレスでも自動確認できるようにする
function createFakeCameraStream(): MediaStream {
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 480;
  const ctx = canvas.getContext("2d")!;
  const markerImg = new Image();
  markerImg.src = markerSvgUrl; // 印刷用と同じ ID 0 のマーカー
  let frame = 0;
  const draw = () => {
    frame++;
    // マーカーの検出を邪魔しないよう、市松はコントラスト弱め
    const cell = 40;
    for (let y = 0; y < canvas.height / cell; y++) {
      for (let x = 0; x < canvas.width / cell; x++) {
        ctx.fillStyle = (x + y) % 2 ? "#8a8a8a" : "#999";
        ctx.fillRect(x * cell, y * cell, cell, cell);
      }
    }
    // 中央にマーカー（白余白込み 240px → 黒枠 192px）を正対で描く。
    // 正対なので、アンカーは画面中央・回転ほぼ単位行列・距離は
    // markerMm と camFov の既定値から決まる値になるはず（動作確認の期待値）
    if (markerImg.complete && markerImg.naturalWidth > 0) {
      ctx.drawImage(
        markerImg,
        (canvas.width - 240) / 2,
        (canvas.height - 240) / 2,
        240,
        240,
      );
    }
    // 毎フレーム内容を変えて captureStream にフレームを流させる（02 と同じ理由）
    ctx.fillStyle = "#fdd663";
    ctx.fillRect(20, 20, (frame * 7) % 200, 12);
  };
  draw();
  const stream = canvas.captureStream(0);
  const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
  setInterval(() => {
    draw();
    track.requestFrame();
  }, 100);
  return stream;
}

// 超広角カメラ優先・解像度指定・フォールバックはすべて 02 と同じ（詳細はそちら）
const camResParsed = (params.get("camRes") ?? "").split(/x/i).map(Number);
const [CAM_W, CAM_H] =
  camResParsed.length === 2 &&
  camResParsed.every((v) => Number.isFinite(v) && v > 0)
    ? camResParsed
    : [1280, 720];
const camSize = { width: { ideal: CAM_W }, height: { ideal: CAM_H } };

async function openBackCameraStream(
  onProgress: (step: string) => void,
): Promise<MediaStream> {
  let stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: "environment" }, ...camSize },
    audio: false,
  });
  onProgress("gum-ok");
  if (params.get("lens") === "wide") return stream;
  const devices = await navigator.mediaDevices.enumerateDevices();
  const ultra = devices.find(
    (d) => d.kind === "videoinput" && /ultra wide|超広角/i.test(d.label),
  );
  if (!ultra) return stream;
  stream.getTracks().forEach((t) => t.stop());
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: ultra.deviceId }, ...camSize },
      audio: false,
    });
    onProgress("ultra-ok");
  } catch {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, ...camSize },
      audio: false,
    });
    onProgress("ultra-fail-fallback");
  }
  return stream;
}

async function startCamera(
  onProgress: (step: string) => void,
): Promise<string> {
  const stream = params.has("fakecam")
    ? createFakeCameraStream()
    : await openBackCameraStream(onProgress);
  video.srcObject = stream;
  await video.play();
  onProgress("play-ok");
  const texture = new THREE.VideoTexture(video);
  texture.colorSpace = THREE.SRGBColorSpace;
  scene.background = texture;
  updateBackgroundCover();
  video.addEventListener("resize", updateBackgroundCover);
  const label = stream.getVideoTracks()[0]?.label ?? "";
  // 開いたレンズから水平 FOV の既定値を確定する（姿勢推定の焦点距離換算に使う）
  camHFovDeg = params.has("camFov")
    ? numParam("camFov", 68, { min: 10, max: 170 })
    : /ultra wide|超広角/i.test(label)
      ? 106
      : 68;
  return `${video.videoWidth}x${video.videoHeight} ${label}`.trim();
}

// カメラ映像と片目ビューポートの縦横比補正（02 と同じ。詳細はそちら）
const CAM_ZOOM = numParam("camZoom", 1);
function updateBackgroundCover() {
  const texture = scene.background;
  if (!(texture instanceof THREE.VideoTexture)) return;
  if (!video.videoWidth || !video.videoHeight) return;
  const eyeAspect = innerWidth / 2 / innerHeight;
  const videoAspect = video.videoWidth / video.videoHeight;
  let rx = 1;
  let ry = 1;
  if (videoAspect > eyeAspect) {
    rx = eyeAspect / videoAspect;
  } else {
    ry = videoAspect / eyeAspect;
  }
  rx /= CAM_ZOOM;
  ry /= CAM_ZOOM;
  texture.repeat.set(rx, ry);
  texture.offset.set((1 - rx) / 2, (1 - ry) / 2);
}

// ---- マーカー検出 → アンカー更新 ----
// 毎フレーム video を縮小キャンバスへ描き、ImageData を境界モジュールに渡して
// カメラ座標系でのマーカー姿勢をもらう。ワールドへの合成はこちらの責務:
//   markerWorld = camera.matrixWorld × markerInCamera
// カメラは 3DoF（回転のみ・位置固定）なので、この合成が正しいのは
// 「検出した瞬間のカメラ角度」に対してのみ。マーカーが見えている間は毎フレーム
// 更新され続けるので実質 6DoF 相当、ロストすると最後のワールド姿勢で固定される
// （首振りだけならジャイロが追従するので固定に見える。歩くとズレる = 3DoF の限界。
// docs/CONCEPT.md Phase 3 の「前提となる制約」参照）
const markerDetector = createMarkerDetector(MARKER_SIZE_M);
const detCanvas = document.createElement("canvas");
const detCtx = detCanvas.getContext("2d", { willReadFrequently: true })!;

let lastDetVideoTime = -1;
let detMs = 0;
let markerInfo = "searching";
let loggedFirstDetection = false;
let lastRejectLogMs = -Infinity;
// 最後に有効な観測を採用した時刻。ロスト後の非表示はフレーム数ではなくこれを基準に
// 判定する（カメラ映像の停止で検出ループが回らなくなっても描画ループ側で消すため）
let lastAcceptedMs = -Infinity;

const targetPos = new THREE.Vector3();
const targetQuat = new THREE.Quaternion();
const targetScale = new THREE.Vector3();
const markerWorld = new THREE.Matrix4();

// 毎フレーム呼ばれる検出の入口。カメラ映像の新フレームを縮小キャンバスに取り込み、
// 境界モジュールでマーカー検出 → applyObservations() でアンカーに反映する
function detectAndUpdateAnchor() {
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
  if (video.currentTime === lastDetVideoTime) return; // 新フレームが来ていない
  lastDetVideoTime = video.currentTime;
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return;
  // 長辺が DET_W になるよう縮小する（幅基準だと縦持ち時に検出画像が縦に伸びて
  // 検出コストが倍増する。横持ちでは幅基準と同じ結果になる）
  const scale = Math.min(1, DET_W / Math.max(vw, vh));
  const w = Math.round(vw * scale);
  const h = Math.round(vh * scale);
  if (detCanvas.width !== w || detCanvas.height !== h) {
    detCanvas.width = w;
    detCanvas.height = h;
  }
  const t0 = performance.now();
  detCtx.drawImage(video, 0, 0, w, h);
  const image = detCtx.getImageData(0, 0, w, h);
  // 焦点距離 [px] は向きに依存しない値なので、水平 FOV が対応する長辺から換算する
  // （iOS はデバイス回転で映像の縦横が入れ替わるため w ではなく max を使う）
  const focalPx =
    Math.max(w, h) / 2 / Math.tan(THREE.MathUtils.degToRad(camHFovDeg) / 2);
  const observations = markerDetector.detect(image, focalPx);
  detMs = performance.now() - t0;
  applyObservations(observations);
}

// 検出結果からこのフレームで採用する観測を1つ選び、アンカーのワールド姿勢を更新する
// （初検出はスナップ、以降は指数移動平均で平滑化。HUD 表示の更新もここ）
function applyObservations(observations: MarkerObservation[]) {
  // World Origin は markerId（既定 ID 0）に固定し、姿勢誤差が大きい検出も棄却する
  // （コードレビュー指摘: 先頭の観測を無条件採用すると、複数端末が別マーカーや
  // 偽検出を原点にしてしまい Phase 4 の共通座標系が一致しなくなる）
  const obs = observations.find(
    (o) =>
      o.id === MARKER_ID &&
      Number.isFinite(o.error) &&
      o.error <= MAX_POSE_ERROR,
  );
  if (!obs) {
    // 別 ID や誤差過大の検出を確認用にログ（2秒に1回まで。連続ログでの埋没を防ぐ）
    if (observations.length > 0 && performance.now() - lastRejectLogMs > 2000) {
      console.log(
        `[marker] observed but rejected: ${observations.map((o) => `id=${o.id} err=${o.error.toFixed(2)}`).join(", ")}`,
      );
      lastRejectLogMs = performance.now();
    }
    if (anchor.visible) {
      markerInfo = `lost (${((performance.now() - lastAcceptedMs) / 1000).toFixed(1)}s)`;
    }
    // 非表示化はここではなく描画ループの hideAnchorIfStale() が時刻基準で行う
    return;
  }
  lastAcceptedMs = performance.now();
  camera.updateMatrixWorld();
  markerWorld.multiplyMatrices(camera.matrixWorld, obs.matrix);
  markerWorld.decompose(targetPos, targetQuat, targetScale);
  if (!anchor.visible) {
    // 初検出は平滑化せずスナップ（非表示位置から lerp で飛んでくるのを防ぐ）
    anchor.position.copy(targetPos);
    anchor.quaternion.copy(targetQuat);
    anchor.visible = true;
  } else {
    anchor.position.lerp(targetPos, SMOOTH);
    anchor.quaternion.slerp(targetQuat, SMOOTH);
  }
  const dist = targetPos.distanceTo(camera.position);
  markerInfo = `id=${obs.id} d=${dist.toFixed(2)}m err=${obs.error.toFixed(2)} ${detMs.toFixed(0)}ms`;
  if (!loggedFirstDetection) {
    loggedFirstDetection = true;
    // ヘッドレス自動確認用: fakecam の正対マーカーなら位置は画面中央方向・
    // 回転はほぼ単位クォータニオンになるはず
    console.log(
      `[marker] first detection id=${obs.id} pos=(${targetPos.x.toFixed(3)}, ${targetPos.y.toFixed(3)}, ${targetPos.z.toFixed(3)}) quat=(${targetQuat.x.toFixed(3)}, ${targetQuat.y.toFixed(3)}, ${targetQuat.z.toFixed(3)}, ${targetQuat.w.toFixed(3)})`,
    );
  }
}

// マーカーの最終検出から LOST_HIDE_MS 過ぎたらアンカーを消す。
// カメラは 3DoF（回転のみ）なのでロスト中の平行移動は追えず、猶予を過ぎたアンカーは
// 「現実に固定」の保証が無い古い座標になる。表示をやめて誤情報を出さない。
// applyObservations 内（= 新フレームが来たときだけ実行）ではなく描画ループから
// 毎フレーム呼ぶことで、カメラ映像が停止して検出ループ自体が回らなくなっても消せる。
// 再検出時は applyObservations の「初検出」分岐でスナップし直す
function hideAnchorIfStale() {
  if (!anchor.visible) return;
  const elapsed = performance.now() - lastAcceptedMs;
  if (elapsed > LOST_HIDE_MS) {
    anchor.visible = false;
    markerInfo = "searching";
    console.log(
      `[marker] hidden after ${(elapsed / 1000).toFixed(1)}s without detection`,
    );
  }
}

// ---- 頭追従（02 と同じ） ----
type HeadControls = { update: () => void };
let controls: HeadControls | null = null;

const isTouchDevice = matchMedia("(pointer: coarse)").matches;

function startControls() {
  if (isTouchDevice) {
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

// ---- 全画面化（02 と同じ） ----
function enterFullscreen(onStatus: (status: string) => void) {
  const el = document.documentElement;
  if (!el.requestFullscreen) {
    onStatus("unsupported");
    return;
  }
  el.requestFullscreen().then(
    () => onStatus("ok"),
    (e) => onStatus(e instanceof Error ? `${e.name}: ${e.message}` : String(e)),
  );
}

// ---- デバッグ用 HUD（実機では console が見えないため状態をここに出す） ----
const hud = document.querySelector<HTMLDivElement>("#hud")!;
const hudState = { base: "", sensor: "", cam: "", fsResult: "", fsChange: "" };
function renderHud() {
  hud.textContent = [
    hudState.base,
    hudState.sensor && `sensor=${hudState.sensor}`,
    hudState.cam && `cam=${hudState.cam}`,
    hudState.fsResult && `fs=${hudState.fsResult}`,
    hudState.fsChange && `fs-change: ${hudState.fsChange}`,
    `marker=${markerInfo}`,
  ]
    .filter(Boolean)
    .join("\n");
}

// ---- 開始フロー（02 と同じ直列化。理由・iOS の制約はそちらのコメント参照） ----
const fsButton = document.querySelector<HTMLButtonElement>("#fs-button")!;

function tryEnterFullscreen() {
  fsButton.hidden = true;
  enterFullscreen((status) => {
    hudState.fsResult = status;
    renderHud();
    if (status !== "ok" && status !== "unsupported") fsButton.hidden = false;
  });
}

fsButton.addEventListener("click", tryEnterFullscreen);

const startButton = document.querySelector<HTMLButtonElement>("#start-button")!;
startButton.addEventListener("click", () => {
  document.body.classList.add("started");
  hudState.base = `fov=${FOV} markerMm=${MARKER_MM} detW=${DET_W} mode=${isTouchDevice ? "gyro" : "orbit"}`;
  renderHud();

  async function startCameraWithHud() {
    hudState.cam = "requesting";
    renderHud();
    try {
      hudState.cam = await startCamera((step) => {
        hudState.cam = step;
        renderHud();
      });
      hudState.base += ` camFov=${camHFovDeg}`;
    } catch (e: unknown) {
      hudState.cam = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    }
    renderHud();
  }

  if (!isTouchDevice) {
    startControls();
    void startCameraWithHud();
    return;
  }

  const doe = DeviceOrientationEvent as unknown as {
    requestPermission?: () => Promise<"granted" | "denied">;
  };
  if (!doe.requestPermission) {
    startControls();
    startCameraWithHud().then(tryEnterFullscreen);
    return;
  }

  doe
    .requestPermission()
    .then(async (state) => {
      hudState.sensor = state;
      renderHud();
      if (state === "granted") startControls();
      await startCameraWithHud();
      if (state === "granted") tryEnterFullscreen();
    })
    .catch(async (e: unknown) => {
      hudState.sensor =
        e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      renderHud();
      await startCameraWithHud();
    });
});

document.addEventListener("fullscreenchange", () => {
  const inFullscreen = Boolean(document.fullscreenElement);
  hudState.fsChange = inFullscreen ? "enter" : "exit";
  renderHud();
  if (isTouchDevice && document.body.classList.contains("started")) {
    fsButton.hidden = inFullscreen;
  }
});

// PC デバッグ用: ?autostart=1 で開始ボタンを自動クリックする
if (params.has("autostart")) startButton.click();

// ---- ループ ----
renderer.setAnimationLoop(() => {
  controls?.update();
  detectAndUpdateAnchor();
  hideAnchorIfStale();
  if (document.body.classList.contains("started")) renderHud();
  effect.render(scene, camera);
});
