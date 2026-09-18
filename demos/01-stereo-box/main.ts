import * as THREE from "three";
import { StereoEffect } from "three/examples/jsm/effects/StereoEffect.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { DeviceOrientationControls } from "three-stdlib";
import { createSession, readNumber, type SessionState } from "mobile-mr-sdk/core";

// 段階 3 の先取り（mobile-mr-sdk/docs/core.md）: 開始フロー（センサー許可 → 全画面 → 横向き固定 → Wake Lock）・
// 全画面の再入・フレームループを SDK の core に置き換えた。2 眼（StereoEffect）と頭追従
// （DeviceOrientationControls）は暫定採用のまま（stereo / tracking で置き換える）。
// 置き換え前の形は git 履歴（feature/sdk-core-01 の親）を参照

// ---- ゴーグル調整パラメータ（URL クエリで実機合わせ込み） ----
const params = new URLSearchParams(location.search);
const FOV = readNumber(params, "fov", 70, { max: 179 });
const EYE_SEP = readNumber(params, "eyeSep", 0.064, { min: 0 }); // 人間の平均瞳孔間距離 ≈ 64mm

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
}
resize();
addEventListener("resize", resize);

// ---- Session（開始フロー・全画面・ライフサイクル・ループ。mobile-mr-sdk/core） ----
const session = createSession();
const isTouchDevice = session.touch;

// ---- 頭追従 ----
// スマホ: three-stdlib の DeviceOrientationControls
// PC(センサーなし): OrbitControls にフォールバック（デバッグ用）
type HeadControls = { update: () => void };
let controls: HeadControls | null = null;

function startControls() {
  if (isTouchDevice) {
    // DeviceOrientationControls はコンストラクタ内でも requestPermission() を呼ぶが、
    // Session が先に許可を取ってから生成するため、ここではダイアログなしで即解決する
    // （許可結果の Promise はライブラリ内で握りつぶされるため、成否は Session の状態で見る）
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

// 許可フローが決着したら頭追従を始める（PC は許可不要。拒否されたら頭追従なしで続ける）。
// 「どの permission なら始めてよいか」は SDK が sensor.usable として持つ（デモ側で書き写さない）
session.on("sensor", (sensor) => {
  if (sensor.usable) startControls();
});

// ---- デバッグ用 HUD（実機では console が見えないため状態をここに出す） ----
// 追記ではなく毎回描き直すことで、イベントの繰り返しで行が増え続けないようにする。
// 語彙（sensor= / events-ok / no-events / no-permission-api / fs= / lock= / wake=）は 06 以降の
// start-flow.ts と同じにし、headless スクリプトがそのまま解析できるようにする
const hud = document.querySelector<HTMLDivElement>("#hud")!;
let hudBase = "";
let fsChanged = false;
let loopError = "";

function text(v: string | { error: string }): string {
  return typeof v === "string" ? v : v.error;
}

function renderHud(s: SessionState = session.state) {
  const sensor =
    s.sensor.permission === "pending" || s.sensor.permission === "skipped"
      ? ""
      : `sensor=${s.sensor.permission === "no-api" ? "no-permission-api" : text(s.sensor.permission)}${s.sensor.events === "ok" ? " events-ok" : s.sensor.events === "none" ? " no-events" : ""}`;
  const fs =
    s.fullscreen === "pending" || s.fullscreen === "skipped"
      ? ""
      : `fs=${s.fullscreen === "needs-tap" ? (s.fullscreenError ?? "needs-tap") : s.fullscreen}${s.orientation === "pending" || s.orientation === "skipped" ? "" : ` lock=${text(s.orientation)}`}`;
  const wake = s.wakeLock === "pending" || s.wakeLock === "skipped" ? "" : `wake=${text(s.wakeLock)}`;
  hud.textContent = [
    hudBase,
    sensor,
    fs,
    fsChanged && `fs-change: ${s.inFullscreen ? "enter" : "exit"}`,
    wake,
    loopError && `loop-error: ${loopError}`,
  ]
    .filter(Boolean)
    .join("\n");
}

// ---- 開始フロー ----
// iOS の制約（実機で確認済み）: センサー許可と全画面化はどちらもタップ起点が必須だが、
// 全画面遷移中は許可ダイアログが表示されない。Session が「先に許可 → 結果を待ってから全画面化」に
// 直列化し、許可ダイアログの操作でタップの効力が切れて全画面化が拒否されたときは
// fullscreen = "needs-tap" になるので、#fs-button を出して再タップしてもらう。
// 上端スワイプで全画面が解除されたときも同じ "needs-tap" になる
const fsButton = document.querySelector<HTMLButtonElement>("#fs-button")!;
fsButton.addEventListener("click", () => void session.enterFullscreen());

session.on("change", (s) => {
  fsButton.hidden = s.fullscreen !== "needs-tap";
  renderHud(s);
});
session.on("error", (e) => {
  loopError = `${e.name}: ${e.text}`;
  renderHud();
});
// fs-change は全画面の開始・解除が実際に起きた後だけ表示する（置き換え前の HUD と同じ）
let lastInFullscreen = session.state.inFullscreen;
session.on("change", (s) => {
  if (s.inFullscreen !== lastInFullscreen) {
    lastInFullscreen = s.inFullscreen;
    fsChanged = true;
    renderHud(s);
  }
});

document
  .querySelector<HTMLButtonElement>("#start-button")!
  .addEventListener("click", () => {
    document.body.classList.add("started");
    hudBase = `fov=${FOV} eyeSep=${EYE_SEP} mode=${isTouchDevice ? "gyro" : "orbit"}`;
    renderHud();
    // PC はデバッグ用途なので Session が許可・全画面を飛ばし OrbitControls のみになる
    void session.start();
  });

// ---- ループ（例外は隔離されて "error" イベントになり、描画は止まらない） ----
session.loop.add("render", (_dt, time) => {
  for (const [i, box] of boxes.entries()) {
    box.rotation.y = time / 2000 + i;
  }
  controls?.update();
  effect.render(scene, camera);
});
session.loop.start();
