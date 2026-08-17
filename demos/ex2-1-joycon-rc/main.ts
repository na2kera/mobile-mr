import * as THREE from "three";

// ex2-1: Joy-Con で 3D 空間上のラジコンを操作する番外デモ。
// Joy-Con はスマホと Bluetooth ペアリングし、ブラウザからは Gamepad API で読む
// （iOS 16+ / Android は Joy-Con を標準の Bluetooth コントローラとして認識する）。
// MR 表示（ステレオ/パススルー）はここでは扱わず、入力まわりの検証に絞る。

// ---- 調整パラメータ（URL クエリで実機合わせ込み） ----
// Joy-Con は持ち方（縦持ち/横持ち）や OS によってスティックの軸番号・向きが
// 変わることがあるため、軸割り当てを URL で差し替えられるようにしておく。
// 90° 回転は「軸の入れ替え + 反転」で表現できる（例: ?axX=1&axY=0&invY=1）
const params = new URLSearchParams(location.search);
function intParam(name: string, fallback: number): number {
  const v = Number(params.get(name) ?? NaN);
  return Number.isInteger(v) && v >= 0 ? v : fallback;
}
const AX_X = intParam("axX", 0); // ハンドルに使う軸番号
const AX_Y = intParam("axY", 1); // アクセルに使う軸番号
const INV_X = params.has("invX") ? -1 : 1;
const INV_Y = params.has("invY") ? -1 : 1;
const DEADZONE = 0.15; // Joy-Con はニュートラルでも僅かに値が出るため必須

// ---- シーン ----
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a2233);
scene.fog = new THREE.Fog(0x1a2233, 15, 60);

const camera = new THREE.PerspectiveCamera(
  60,
  innerWidth / innerHeight,
  0.1,
  100,
);

scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.2));
const dirLight = new THREE.DirectionalLight(0xffffff, 1.5);
dirLight.position.set(5, 10, 3);
scene.add(dirLight);

// 走行エリア: 床グリッド + 外周の壁（この内側にクランプして場外に出さない)
const ARENA = 14; // 中心から壁までの距離
scene.add(new THREE.GridHelper(ARENA * 2, ARENA * 2, 0x8ab4f8, 0x3c4043));
const wallMaterial = new THREE.MeshStandardMaterial({
  color: 0x3c4043,
  transparent: true,
  opacity: 0.5,
});
for (let i = 0; i < 4; i++) {
  const wall = new THREE.Mesh(
    new THREE.BoxGeometry(ARENA * 2, 0.6, 0.1),
    wallMaterial,
  );
  const angle = (i * Math.PI) / 2;
  wall.position.set(Math.sin(angle) * ARENA, 0.3, Math.cos(angle) * ARENA);
  wall.rotation.y = angle;
  scene.add(wall);
}

// スラローム用のパイロン（当たり判定はなし。走り回る目標物として置くだけ）
const coneGeometry = new THREE.ConeGeometry(0.25, 0.6, 16);
const COLORS = [0xf28b82, 0xfdd663, 0x81c995, 0x8ab4f8, 0xff8bcb, 0xffa657];
for (let i = 0; i < 8; i++) {
  const angle = (i / 8) * Math.PI * 2;
  const cone = new THREE.Mesh(
    coneGeometry,
    new THREE.MeshStandardMaterial({ color: COLORS[i % COLORS.length] }),
  );
  cone.position.set(Math.sin(angle) * 6, 0.3, Math.cos(angle) * 6);
  scene.add(cone);
}

// ---- ラジコン本体（プリミティブの組み合わせ） ----
const car = new THREE.Group();
scene.add(car);

const body = new THREE.Mesh(
  new THREE.BoxGeometry(0.5, 0.18, 0.9),
  new THREE.MeshStandardMaterial({ color: 0xf28b82 }),
);
body.position.y = 0.22;
car.add(body);

const cabin = new THREE.Mesh(
  new THREE.BoxGeometry(0.4, 0.16, 0.42),
  new THREE.MeshStandardMaterial({ color: 0xe8eaed }),
);
cabin.position.set(0, 0.38, 0.05);
car.add(cabin);

// 車輪。前輪はステアリングの見た目用に yaw 回転させるため、
// 「yaw 用の親グループ + スピン用の子メッシュ」の2段構成にする
const wheelGeometry = new THREE.CylinderGeometry(0.14, 0.14, 0.1, 20);
wheelGeometry.rotateZ(Math.PI / 2); // 円柱の軸を車軸（X軸）方向へ
const wheelMaterial = new THREE.MeshStandardMaterial({ color: 0x202124 });
const spinWheels: THREE.Mesh[] = [];
const frontWheelPivots: THREE.Group[] = [];
for (const [x, z, isFront] of [
  [-0.3, 0.3, true],
  [0.3, 0.3, true],
  [-0.3, -0.32, false],
  [0.3, -0.32, false],
] as const) {
  const wheel = new THREE.Mesh(wheelGeometry, wheelMaterial);
  spinWheels.push(wheel);
  const pivot = new THREE.Group();
  pivot.position.set(x, 0.14, z);
  pivot.add(wheel);
  if (isFront) frontWheelPivots.push(pivot);
  car.add(pivot);
}

// ---- レンダラー ----
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
document
  .querySelector<HTMLDivElement>("#app")!
  .appendChild(renderer.domElement);

function resize() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
}
resize();
addEventListener("resize", resize);

// ---- 入力: Gamepad API（Joy-Con） ----
// 注意点（このデモの検証対象）:
// - Joy-Con はペアリング済みでも「何かボタンを押す」まで getGamepads() に現れない
// - gamepad オブジェクトはスナップショットなので、保持せず毎フレーム取り直す
// - Joy-Con (L)/(R) を両方つなぐと 2 台のゲームパッドとして見える
//   → 「最後に入力があったパッド」を操作対象にして、どちらを振っても反応するようにする
let activePadIndex: number | null = null;
let padSummary = ""; // HUD 表示用（id と生の軸・ボタン値）

function readPad(): { x: number; y: number; reset: boolean } | null {
  const pads = navigator.getGamepads();

  // 何か入力（ボタン押下 or 軸の傾き）のあるパッドがいれば操作対象を切り替える
  for (const pad of pads) {
    if (!pad) continue;
    const hasInput =
      pad.buttons.some((b) => b.pressed) ||
      pad.axes.some((a) => Math.abs(a) > DEADZONE);
    if (hasInput) {
      activePadIndex = pad.index;
      break;
    }
  }
  const pad = activePadIndex !== null ? pads[activePadIndex] : null;
  if (!pad) return null;

  // マッピング確認用に生の値を HUD に出す（軸番号のズレはここを見て URL で合わせる）
  const axesText = pad.axes.map((a) => a.toFixed(2)).join(" ");
  const pressed = pad.buttons
    .map((b, i) => (b.pressed ? i : null))
    .filter((i) => i !== null)
    .join(",");
  padSummary = `pad[${pad.index}] ${pad.id}\naxes: ${axesText}\nbuttons: ${pressed || "-"}`;

  let x = (pad.axes[AX_X] ?? 0) * INV_X;
  let y = (pad.axes[AX_Y] ?? 0) * INV_Y;
  if (Math.abs(x) < DEADZONE) x = 0;
  if (Math.abs(y) < DEADZONE) y = 0;

  // スティックが軸として取れない持ち方・機種向けの保険: 標準マッピングの
  // 十字ボタン（12=上 13=下 14=左 15=右）でもデジタル操作できるようにする
  const btn = (i: number) => pad.buttons[i]?.pressed ?? false;
  if (btn(12)) y = -1;
  if (btn(13)) y = 1;
  if (btn(14)) x = -1;
  if (btn(15)) x = 1;

  // スティック押し込み（標準マッピング 10/11）で位置リセット
  return { x, y, reset: btn(10) || btn(11) };
}

const statusEl = document.querySelector<HTMLDivElement>("#status")!;
function setStatus(text: string, connected: boolean) {
  statusEl.textContent = text;
  statusEl.classList.toggle("connected", connected);
}

addEventListener("gamepadconnected", (e) => {
  setStatus(`接続: ${e.gamepad.id}`, true);
});
addEventListener("gamepaddisconnected", (e) => {
  if (e.gamepad.index === activePadIndex) activePadIndex = null;
  padSummary = "";
  setStatus(
    "切断されました。Joy-Con のボタンを押すと再接続します",
    false,
  );
});

// ---- 入力: キーボード（PC デバッグ用フォールバック） ----
const keys = new Set<string>();
addEventListener("keydown", (e) => keys.add(e.key.toLowerCase()));
addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));

function readKeyboard(): { x: number; y: number; reset: boolean } {
  const has = (...names: string[]) => names.some((n) => keys.has(n));
  return {
    x: (has("arrowright", "d") ? 1 : 0) - (has("arrowleft", "a") ? 1 : 0),
    y: (has("arrowdown", "s") ? 1 : 0) - (has("arrowup", "w") ? 1 : 0),
    reset: has("r"),
  };
}

// ---- 車の運動モデル（簡易キネマティクス） ----
// 本物っぽさより「Joy-Con で気持ちよく走らせられる」ことを優先したパラメータ
const MAX_SPEED = 6; // m/s（前進）
const MAX_REVERSE = 2.5; // m/s（後退）
const ACCEL = 8; // m/s^2
const BRAKE_DECEL = 12; // 入力と逆方向へ進んでいるときの減速（ブレーキ相当）
const COAST_DECEL = 4; // 入力なしの自然減速
const STEER_ANGLE = Math.PI / 5; // 前輪の最大切れ角（見た目用）
const WHEELBASE = 0.62; // 前後輪の距離。旋回半径の計算に使う
const WHEEL_RADIUS = 0.14;

let speed = 0; // 符号付き（+が前進）
let heading = 0; // 車の向き（Y軸回転）

function resetCar() {
  speed = 0;
  heading = 0;
  car.position.set(0, 0, 0);
}

// ---- デバッグ HUD ----
const hud = document.querySelector<HTMLDivElement>("#hud")!;
function renderHud(input: { x: number; y: number }) {
  hud.textContent = [
    `axX=${AX_X}${INV_X < 0 ? "(inv)" : ""} axY=${AX_Y}${INV_Y < 0 ? "(inv)" : ""}`,
    `input: x=${input.x.toFixed(2)} y=${input.y.toFixed(2)} speed=${speed.toFixed(2)}`,
    padSummary,
  ]
    .filter(Boolean)
    .join("\n");
}

// ---- ループ ----
let prevTime: number | null = null;
renderer.setAnimationLoop((time) => {
  // タブ復帰などで dt が跳ねて車が吹き飛ばないよう上限を設ける
  const dt = Math.min((time - (prevTime ?? time)) / 1000, 0.1);
  prevTime = time;

  const input = readPad() ?? readKeyboard();
  if (input.reset) resetCar();

  // スティック上（axes は上が負）= 前進としたいので符号を反転
  const throttle = -input.y;

  // 加減速: 入力方向と進行方向が逆ならブレーキ、入力なしなら自然減速
  if (throttle !== 0) {
    const decel = throttle * speed < 0 ? BRAKE_DECEL : ACCEL;
    speed += throttle * decel * dt;
  } else {
    const drop = COAST_DECEL * dt;
    speed = Math.abs(speed) <= drop ? 0 : speed - Math.sign(speed) * drop;
  }
  speed = THREE.MathUtils.clamp(speed, -MAX_REVERSE, MAX_SPEED);

  // ステアリング: 前輪の切れ角と車速から旋回角速度を出す（自転車モデル近似）。
  // 後退時は実車同様に曲がる向きが反転する（speed の符号がそのまま効く）
  const steer = -input.x * STEER_ANGLE;
  heading += (speed / WHEELBASE) * Math.tan(steer) * dt;
  car.rotation.y = heading;

  // 前進方向はモデルの +Z（車体は +Z を正面に作ってある）
  car.position.x += Math.sin(heading) * speed * dt;
  car.position.z += Math.cos(heading) * speed * dt;
  // 壁の内側にクランプ（速度は殺さず、壁ずり走行になる）
  const limit = ARENA - 0.6;
  car.position.x = THREE.MathUtils.clamp(car.position.x, -limit, limit);
  car.position.z = THREE.MathUtils.clamp(car.position.z, -limit, limit);

  // 見た目: 前輪の向きとタイヤの回転
  for (const pivot of frontWheelPivots) pivot.rotation.y = steer;
  for (const wheel of spinWheels) {
    wheel.rotation.x += (speed / WHEEL_RADIUS) * dt;
  }

  // 追いかけカメラ: 車の後方上空の目標位置へ滑らかに寄せる。
  // lerp の係数を dt 基準にしてフレームレート非依存にする
  const chaseOffset = new THREE.Vector3(0, 1.6, -3.2).applyAxisAngle(
    new THREE.Vector3(0, 1, 0),
    heading,
  );
  const chaseTarget = chaseOffset.add(car.position);
  camera.position.lerp(chaseTarget, 1 - Math.exp(-4 * dt));
  camera.lookAt(car.position.x, car.position.y + 0.4, car.position.z);

  renderHud(input);
  renderer.render(scene, camera);
});
