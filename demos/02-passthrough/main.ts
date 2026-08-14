import * as THREE from "three";
import { StereoEffect } from "three/examples/jsm/effects/StereoEffect.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { DeviceOrientationControls } from "three-stdlib";

// ---- ゴーグル調整パラメータ（URL クエリで実機合わせ込み） ----
const params = new URLSearchParams(location.search);
const FOV = Number(params.get("fov") ?? 70);
const EYE_SEP = Number(params.get("eyeSep") ?? 0.064); // 人間の平均瞳孔間距離 ≈ 64mm

// ---- シーン ----
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a2233);
scene.fog = new THREE.Fog(0x1a2233, 10, 40);

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

// 床グリッド（距離感の基準）
scene.add(new THREE.GridHelper(40, 40, 0x8ab4f8, 0x3c4043));

// 色違いボックスを周囲に配置（頭追従の確認用に全方位へ）
const boxGeometry = new THREE.BoxGeometry(0.5, 0.5, 0.5);
const boxes: THREE.Mesh[] = [];
const COLORS = [0xf28b82, 0xfdd663, 0x81c995, 0x8ab4f8, 0xff8bcb, 0xffa657];
for (let i = 0; i < 12; i++) {
  const angle = (i / 12) * Math.PI * 2;
  const radius = 3 + (i % 3) * 2; // 3m / 5m / 7m の3リング
  const box = new THREE.Mesh(
    boxGeometry,
    new THREE.MeshStandardMaterial({ color: COLORS[i % COLORS.length] }),
  );
  box.position.set(
    Math.sin(angle) * radius,
    0.8 + (i % 4) * 0.7, // 高さもばらす
    Math.cos(angle) * radius,
  );
  boxes.push(box);
  scene.add(box);
}

// 正面（-Z）の目印: 起動時に見える方向の基準
const frontMarker = new THREE.Mesh(
  new THREE.ConeGeometry(0.3, 0.6, 16),
  new THREE.MeshStandardMaterial({ color: 0xffffff }),
);
frontMarker.position.set(0, 1.6, -4);
frontMarker.rotation.x = Math.PI;
scene.add(frontMarker);

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
// カメラは1つ（モノラル）なので両眼に同じ映像が映る。StereoEffect は左右の目
// ごとにシーンを描画するため、scene.background に貼れば背景も両眼に描かれる。
// <video> を DOM で canvas の背後に置く方式は左右2分割できないため採らない。
const video = document.createElement("video");
// iOS Safari は playsinline + muted が揃わないとインライン再生されない
video.playsInline = true;
video.muted = true;

// PC デバッグ用: ?fakecam=1 でカメラの代わりにテストパターン（canvas の
// captureStream）を使う。ヘッドレス Chrome では getUserMedia が解決しないため、
// stream 以降の描画経路（VideoTexture → 背景 → cover 補正）だけを自動確認する用途。
// 円が円のまま表示されれば縦横比の補正が効いている
function createFakeCameraStream(): MediaStream {
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 480;
  const ctx = canvas.getContext("2d")!;
  let frame = 0;
  const draw = () => {
    frame++;
    const cell = 40;
    for (let y = 0; y < canvas.height / cell; y++) {
      for (let x = 0; x < canvas.width / cell; x++) {
        ctx.fillStyle = (x + y) % 2 ? "#666" : "#999";
        ctx.fillRect(x * cell, y * cell, cell, cell);
      }
    }
    ctx.strokeStyle = "#f28b82";
    ctx.lineWidth = 12;
    ctx.strokeRect(0, 0, canvas.width, canvas.height);
    ctx.beginPath();
    ctx.arc(canvas.width / 2, canvas.height / 2, 120, 0, Math.PI * 2);
    ctx.stroke();
    // 毎フレーム内容を変える: 内容が同一だと captureStream が新フレームを
    // 流さないことがあり、ヘッドレスでは初回フレームすら届かず真っ黒になる
    ctx.fillStyle = "#fdd663";
    ctx.fillRect(20, 20, (frame * 7) % 200, 12);
  };
  draw();
  // ヘッドレス Chrome では fps 指定の自動キャプチャがフレームを流さないことがある
  // （readyState=4 なのに currentTime が 0 のまま）ため、requestFrame() で明示的に送る
  const stream = canvas.captureStream(0);
  const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
  setInterval(() => {
    draw();
    track.requestFrame();
  }, 100);
  return stream;
}

// 標準の背面カメラ（広角 26mm 相当・視野約70°）だと、cover 切り抜きの分も含めて
// 実視界よりかなりズームして見える（実機で確認）。パススルー用途には視野の広い
// 超広角カメラ（0.5x・約106°）の方が自然なので、あればそちらを優先する。
// facingMode では超広角を指名できないため、許可取得後に enumerateDevices() の
// ラベルから探して開き直す。?lens=wide で標準カメラに戻して比較できる
// 解像度は指定しないと 640x480 が返ってきて粗い（実機で確認）。
// ideal 指定なので、非対応ならブラウザが一番近いモードに丸めてくれる
const [CAM_W, CAM_H] = (params.get("camRes") ?? "1280x720")
  .split("x")
  .map(Number);
const camSize = { width: { ideal: CAM_W }, height: { ideal: CAM_H } };

async function openBackCameraStream(
  onProgress: (step: string) => void,
): Promise<MediaStream> {
  let stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: "environment" }, ...camSize }, // PC 等、背面が無ければ内蔵カメラ
    audio: false,
  });
  onProgress("gum-ok");
  if (params.get("lens") === "wide") return stream;
  const devices = await navigator.mediaDevices.enumerateDevices();
  const ultra = devices.find(
    (d) => d.kind === "videoinput" && /ultra wide|超広角/i.test(d.label),
  );
  if (!ultra) return stream;
  // iOS はカメラの同時オープンを嫌うので、開き直す前に既存トラックを止める
  stream.getTracks().forEach((t) => t.stop());
  stream = await navigator.mediaDevices.getUserMedia({
    video: { deviceId: { exact: ultra.deviceId }, ...camSize },
    audio: false,
  });
  onProgress("ultra-ok");
  return stream;
}

// onProgress: どの段階まで進んだかを HUD に出す（実機では console が見えないため、
// 「カメラが映らない」の原因が許可待ちなのか再生失敗なのかをここで切り分ける）
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
  scene.fog = null; // フォグは背景色前提の演出なので、カメラ映像に切り替えたら外す
  updateBackgroundCover();
  // iOS はデバイス回転でカメラ映像自体が回転し、縦横サイズが入れ替わる。
  // window の resize より遅れて反映されることがあるため、映像側のサイズ変化でも補正し直す
  video.addEventListener("resize", updateBackgroundCover);
  const label = stream.getVideoTracks()[0]?.label ?? "";
  return `${video.videoWidth}x${video.videoHeight} ${label}`.trim();
}

// カメラ映像と片目ビューポートの縦横比の差を CSS の object-fit: cover 相当に補正する
// （補正しないと映像が引き伸ばされて歪む）。scene.background は texture の
// offset/repeat による UV 変換を反映するのでそれを使う。
// CAM_ZOOM はゴーグル越しの見え方を実機で合わせ込むための倍率（1 = cover ぴったり）。
// 1 未満で縮小（より広い範囲が見える。映像の外はフチの色が伸びる）、1 より大きくで拡大
const CAM_ZOOM = Number(params.get("camZoom") ?? 1);
function updateBackgroundCover() {
  const texture = scene.background;
  if (!(texture instanceof THREE.VideoTexture)) return;
  if (!video.videoWidth || !video.videoHeight) return;
  const eyeAspect = innerWidth / 2 / innerHeight; // StereoEffect は片目が画面の横半分
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

// ---- 頭追従 ----
// スマホ: three-stdlib の DeviceOrientationControls
// PC(センサーなし): OrbitControls にフォールバック（デバッグ用）
type HeadControls = { update: () => void };
let controls: HeadControls | null = null;

const isTouchDevice = matchMedia("(pointer: coarse)").matches;

function startControls() {
  if (isTouchDevice) {
    // DeviceOrientationControls はコンストラクタ内でも requestPermission() を呼ぶが、
    // 開始フロー側で先に許可を取ってから生成するため、ここではダイアログなしで即解決する
    // （許可結果の Promise はライブラリ内で握りつぶされるため、成否は開始フロー側で自前管理する）
    controls = new DeviceOrientationControls(camera);
  } else {
    const orbit = new OrbitControls(camera, renderer.domElement);
    orbit.target.set(0, 1.6, -0.01); // カメラ位置とほぼ同じ点を注視 = 一人称の見回し
    orbit.enableZoom = false;
    orbit.enablePan = false;
    orbit.rotateSpeed = -0.5; // ドラッグ方向を「頭を振る」感覚に合わせて反転
    controls = orbit;
  }
}

// ---- 全画面化 ----
// iPhone Safari は iOS 17.2+ で任意要素の requestFullscreen() に対応
// （それ未満は旧プレフィックス版も含め未定義なので、フォールバック分岐は持たない）。
// センサー許可と同様にユーザージェスチャー内で呼ぶ必要がある。
// 非対応・拒否時は従来どおり 100dvh の全画面風表示のまま続行する。
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
// 追記ではなく毎回描き直すことで、イベントの繰り返しで行が増え続けないようにする
const hud = document.querySelector<HTMLDivElement>("#hud")!;
const hudState = { base: "", sensor: "", cam: "", fsResult: "", fsChange: "" };
function renderHud() {
  hud.textContent = [
    hudState.base,
    hudState.sensor && `sensor=${hudState.sensor}`,
    hudState.cam && `cam=${hudState.cam}`,
    hudState.fsResult && `fs=${hudState.fsResult}`,
    hudState.fsChange && `fs-change: ${hudState.fsChange}`,
  ]
    .filter(Boolean)
    .join("\n");
}

// ---- 開始フロー ----
// iOS の制約（01 の実機確認より）: 許可ダイアログ系はタップ起点が必須だが、
// 全画面遷移中はダイアログが表示されず全画面解除まで繰り延べられる。そのため
// ダイアログを伴うもの（センサー許可 → カメラ許可）を先に直列で済ませ、
// 最後に全画面化する。ダイアログの操作でタップの効力（transient activation）
// が切れて全画面化が拒否された場合は、#fs-button を出して再タップしてもらう。
// カメラ許可がこの列に加わるのが 02 の追加点。
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
  hudState.base = `fov=${FOV} eyeSep=${EYE_SEP} mode=${isTouchDevice ? "gyro" : "orbit"}`;
  renderHud();

  // カメラの成否は開始可否に影響させない（失敗しても VR 表示は続行し、HUD に出す）
  async function startCameraWithHud() {
    hudState.cam = "requesting";
    renderHud();
    try {
      hudState.cam = await startCamera((step) => {
        hudState.cam = step;
        renderHud();
      });
    } catch (e: unknown) {
      hudState.cam = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    }
    renderHud();
  }

  // PC はデバッグ用途なので全画面にせず OrbitControls + カメラのみ
  if (!isTouchDevice) {
    startControls();
    void startCameraWithHud();
    return;
  }

  const doe = DeviceOrientationEvent as unknown as {
    requestPermission?: () => Promise<"granted" | "denied">;
  };
  if (!doe.requestPermission) {
    // Android 等、センサー許可ダイアログが無い環境: カメラ許可 → 全画面の順
    startControls();
    startCameraWithHud().then(tryEnterFullscreen);
    return;
  }

  // iOS: このタップ起点でセンサー許可 → カメラ許可 → 全画面化を直列に進める
  doe
    .requestPermission()
    .then(async (state) => {
      hudState.sensor = state;
      renderHud();
      if (state !== "granted") return; // 拒否: 頭追従が無いので先へ進まない
      startControls();
      await startCameraWithHud();
      // 両方許可済みのリピーターならタップの効力が残っていて 1 タップで全画面まで
      // 行ける。ダイアログが出た場合は効力切れで拒否され、fs-button の再タップに落ちる
      tryEnterFullscreen();
    })
    .catch((e: unknown) => {
      hudState.sensor =
        e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      renderHud();
    });
});

// 全画面の開始・解除（上端スワイプ等）を HUD で観測し、解除時は再入ボタンを出す
document.addEventListener("fullscreenchange", () => {
  const inFullscreen = Boolean(document.fullscreenElement);
  hudState.fsChange = inFullscreen ? "enter" : "exit";
  renderHud();
  if (isTouchDevice && document.body.classList.contains("started")) {
    fsButton.hidden = inFullscreen;
  }
});

// PC デバッグ用: ?autostart=1 で開始ボタンを自動クリックする
// （ヘッドレス Chrome + フェイクカメラでの自動確認に使う。実機フローでは使わない）
if (params.has("autostart")) startButton.click();

// ---- ループ ----
renderer.setAnimationLoop((time) => {
  for (const [i, box] of boxes.entries()) {
    box.rotation.y = time / 2000 + i;
  }
  controls?.update();
  effect.render(scene, camera);
});
