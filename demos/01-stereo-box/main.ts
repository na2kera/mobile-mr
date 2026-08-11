import * as THREE from 'three'
import { StereoEffect } from 'three/examples/jsm/effects/StereoEffect.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { DeviceOrientationControls } from 'three-stdlib'

// ---- ゴーグル調整パラメータ（URL クエリで実機合わせ込み） ----
const params = new URLSearchParams(location.search)
const FOV = Number(params.get('fov') ?? 70)
const EYE_SEP = Number(params.get('eyeSep') ?? 0.064) // 人間の平均瞳孔間距離 ≈ 64mm

// ---- シーン ----
const scene = new THREE.Scene()
scene.background = new THREE.Color(0x1a2233)
scene.fog = new THREE.Fog(0x1a2233, 10, 40)

const camera = new THREE.PerspectiveCamera(FOV, innerWidth / innerHeight, 0.1, 100)
camera.position.set(0, 1.6, 0) // 立った人間の目線の高さ

scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.2))
const dirLight = new THREE.DirectionalLight(0xffffff, 1.5)
dirLight.position.set(3, 10, 2)
scene.add(dirLight)

// 床グリッド（距離感の基準）
scene.add(new THREE.GridHelper(40, 40, 0x8ab4f8, 0x3c4043))

// 色違いボックスを周囲に配置（頭追従の確認用に全方位へ）
const boxGeometry = new THREE.BoxGeometry(0.5, 0.5, 0.5)
const boxes: THREE.Mesh[] = []
const COLORS = [0xf28b82, 0xfdd663, 0x81c995, 0x8ab4f8, 0xff8bcb, 0xffa657]
for (let i = 0; i < 12; i++) {
  const angle = (i / 12) * Math.PI * 2
  const radius = 3 + (i % 3) * 2 // 3m / 5m / 7m の3リング
  const box = new THREE.Mesh(
    boxGeometry,
    new THREE.MeshStandardMaterial({ color: COLORS[i % COLORS.length] }),
  )
  box.position.set(
    Math.sin(angle) * radius,
    0.8 + (i % 4) * 0.7, // 高さもばらす
    Math.cos(angle) * radius,
  )
  boxes.push(box)
  scene.add(box)
}

// 正面（-Z）の目印: 起動時に見える方向の基準
const frontMarker = new THREE.Mesh(
  new THREE.ConeGeometry(0.3, 0.6, 16),
  new THREE.MeshStandardMaterial({ color: 0xffffff }),
)
frontMarker.position.set(0, 1.6, -4)
frontMarker.rotation.x = Math.PI
scene.add(frontMarker)

// ---- レンダラー + 2眼（three 同梱の StereoEffect を利用） ----
const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
document.querySelector<HTMLDivElement>('#app')!.appendChild(renderer.domElement)

const effect = new StereoEffect(renderer)
effect.setEyeSeparation(EYE_SEP)

function resize() {
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
  effect.setSize(innerWidth, innerHeight)
}
resize()
addEventListener('resize', resize)

// ---- 頭追従 ----
// スマホ: three-stdlib の DeviceOrientationControls
// PC(センサーなし): OrbitControls にフォールバック（デバッグ用）
type HeadControls = { update: () => void }
let controls: HeadControls | null = null

const isTouchDevice = matchMedia('(pointer: coarse)').matches

function startControls() {
  if (isTouchDevice) {
    // 注意: DeviceOrientationControls はコンストラクタ内で requestPermission() を
    // 呼ぶため、iOS ではユーザージェスチャー（このタップ）内で生成する必要がある。
    // 許可結果の Promise はライブラリ内で握りつぶされるため成否は取得できない。
    controls = new DeviceOrientationControls(camera)
  } else {
    const orbit = new OrbitControls(camera, renderer.domElement)
    orbit.target.set(0, 1.6, -0.01) // カメラ位置とほぼ同じ点を注視 = 一人称の見回し
    orbit.enableZoom = false
    orbit.enablePan = false
    orbit.rotateSpeed = -0.5 // ドラッグ方向を「頭を振る」感覚に合わせて反転
    controls = orbit
  }
}

// ---- 開始フロー（センサー許可はタップ起点必須） ----
const hud = document.querySelector<HTMLDivElement>('#hud')!
document.querySelector<HTMLButtonElement>('#start-button')!.addEventListener('click', () => {
  startControls()
  document.body.classList.add('started')
  hud.textContent = `fov=${FOV} eyeSep=${EYE_SEP} mode=${isTouchDevice ? 'gyro' : 'orbit'}`
})

// ---- ループ ----
renderer.setAnimationLoop((time) => {
  for (const [i, box] of boxes.entries()) {
    box.rotation.y = time / 2000 + i
  }
  controls?.update()
  effect.render(scene, camera)
})
