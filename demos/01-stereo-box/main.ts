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
}
resize();
addEventListener("resize", resize);

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
const hudState = { base: "", sensor: "", fsResult: "", fsChange: "" };
function renderHud() {
  hud.textContent = [
    hudState.base,
    hudState.sensor && `sensor=${hudState.sensor}`,
    hudState.fsResult && `fs=${hudState.fsResult}`,
    hudState.fsChange && `fs-change: ${hudState.fsChange}`,
  ]
    .filter(Boolean)
    .join("\n");
}

// ---- 開始フロー ----
// iOS の制約（実機で確認済み）: センサー許可と全画面化はどちらもタップ起点が
// 必須だが、全画面遷移中は許可ダイアログが表示されず、全画面解除まで繰り延べ
// られる。同一タップで両方を撃つと初回訪問では頭追従が死んだままになるため、
// 「先に許可を要求 → 結果を待ってから全画面化」の順に直列化する。
// 許可ダイアログの操作でタップの効力（transient activation）が切れて全画面化
// が拒否された場合は、#fs-button を出して再タップしてもらう。
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

document
  .querySelector<HTMLButtonElement>("#start-button")!
  .addEventListener("click", () => {
    document.body.classList.add("started");
    hudState.base = `fov=${FOV} eyeSep=${EYE_SEP} mode=${isTouchDevice ? "gyro" : "orbit"}`;
    renderHud();

    // PC はデバッグ用途なので全画面にせず OrbitControls のみ
    if (!isTouchDevice) {
      startControls();
      return;
    }

    const doe = DeviceOrientationEvent as unknown as {
      requestPermission?: () => Promise<"granted" | "denied">;
    };
    if (!doe.requestPermission) {
      // Android 等、許可ダイアログが無い環境は同一タップで両方いける
      startControls();
      tryEnterFullscreen();
      return;
    }

    // iOS: このタップ起点で許可を要求し、結果を待ってから全画面化する
    doe
      .requestPermission()
      .then((state) => {
        hudState.sensor = state;
        renderHud();
        if (state !== "granted") return; // 拒否: 頭追従が無いので全画面にもしない
        startControls();
        // 既に許可済みならタップの効力が残っていて 1 タップで全画面まで行ける。
        // いまダイアログが出た場合は効力切れで拒否され、fs-button 経由の再タップに落ちる
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

// ---- ループ ----
renderer.setAnimationLoop((time) => {
  for (const [i, box] of boxes.entries()) {
    box.rotation.y = time / 2000 + i;
  }
  controls?.update();
  effect.render(scene, camera);
});
