// パススルー背景（背面カメラ → <video> → VideoTexture → scene.background）。
// 02〜05 の各デモに複製されていた openBackCameraStream / startCamera /
// updateBackgroundCover / createFakeCameraStream を Phase 6 で抽出した
// （PAIN_POINTS「パススルー + 開始フローのボイラープレートが 4 本目になり…」参照）。
// 02〜05 は過去のデモとして手を付けず、06 以降がこれを使う。
// 各処理の根拠（超広角の選び方・解像度指定・回転追従・フェイクカメラ）は
// PAIN_POINTS の Phase 2 の各エントリを参照
import * as THREE from "three";
import type { ViewMapping } from "./hand-math";

/** iOS のデバイスラベルから超広角カメラを見分ける（OS の言語設定依存。PAIN_POINTS 参照） */
export const ULTRA_WIDE_LABEL = /ultra wide|超広角/i;

/** レンズ種別ごとの水平 FOV の機種平均 [deg]（ブラウザからは取得できないので推定値） */
export const CAM_FOV_ULTRA_WIDE = 106;
export const CAM_FOV_WIDE = 68;

export type FakeCameraDraw = (
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  frame: number,
) => void;

/**
 * PC デバッグ用フェイクカメラ。canvas を captureStream(0) + requestFrame() の明示送信で
 * 流す（fps 指定の自動キャプチャはヘッドレスでフレームが video に届かないことが多い）
 */
export function createFakeCameraStream(
  draw: FakeCameraDraw,
  { width = 640, height = 480, intervalMs = 100 } = {},
): MediaStream {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  let frame = 0;
  const tick = () => {
    frame++;
    draw(ctx, canvas, frame);
  };
  tick();
  const stream = canvas.captureStream(0);
  const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
  setInterval(() => {
    tick();
    track.requestFrame();
  }, intervalMs);
  return stream;
}

/** 02〜05 共通のチェッカーボード + 動くバー（フレームが更新されていることを目で確認する用） */
export function drawCheckerboard(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  frame: number,
  colors: [string, string] = ["#8a8a8a", "#999"],
) {
  const cell = 40;
  for (let y = 0; y < canvas.height / cell; y++) {
    for (let x = 0; x < canvas.width / cell; x++) {
      ctx.fillStyle = (x + y) % 2 ? colors[0] : colors[1];
      ctx.fillRect(x * cell, y * cell, cell, cell);
    }
  }
  ctx.fillStyle = "#fdd663";
  ctx.fillRect(20, 20, (frame * 7) % 200, 12);
}

export type BackCameraOptions = {
  /** getUserMedia に渡す ideal 解像度（未指定だと iOS は 640x480 を返す） */
  camRes: [number, number];
  /** 超広角カメラを優先する（?lens=wide で false にして標準カメラと比較できる） */
  preferUltraWide: boolean;
};

/** 前面カメラの名前（iPad は「前面超広角カメラ」/ "Front Ultra Wide Camera" があり、超広角は前面だけ）。Mac の FaceTime も前面 */
export const FRONT_LABEL = /前面|front|facetime|user/i;
/** 背面カメラの名前（iPhone の「背面超広角カメラ」/ "Back Ultra Wide Camera"） */
export const BACK_LABEL = /背面|back|rear|environment/i;

export type CameraDeviceLike = { kind: string; label: string; deviceId: string };

/**
 * 背面の超広角カメラを選ぶ（純粋関数。scripts/test-keshin.mjs でテスト）。名前が「超広角」に合うもののうち、
 * 前面（前面|front|FaceTime|user）は外し、背面（背面|back|rear）を名乗るものを優先する（名乗らないものは次点）。
 * iPad は超広角が前面にしか無く、以前は前面が選ばれて映像とジャイロの向きが合わなかった（ex9-1 の実機。PAIN_POINTS 参照）
 */
export function pickBackUltraWide(devices: readonly CameraDeviceLike[]): { device: CameraDeviceLike | null; reason: string } {
  const ultras = devices.filter((d) => d.kind === "videoinput" && ULTRA_WIDE_LABEL.test(d.label));
  if (ultras.length === 0) return { device: null, reason: "no-ultra-wide" };
  const notFront = ultras.filter((d) => !FRONT_LABEL.test(d.label));
  if (notFront.length === 0) return { device: null, reason: `front-only(${ultras.map((d) => d.label).join("/")})` };
  const back = notFront.find((d) => BACK_LABEL.test(d.label));
  if (back) return { device: back, reason: "back-ultra-wide" };
  return { device: notFront[0], reason: "ultra-wide(no-side-in-label)" };
}

/** 開いたカメラの記録（HUD / ログ用） */
export type CameraChoice = { label: string; facingMode: string; reason: string };

/** 超広角カメラ優先（背面だけ）・解像度指定・フォールバック（02〜05 と同じ流れ） */
export async function openBackCameraStream(
  opts: BackCameraOptions,
  onProgress: (step: string) => void,
  onChoice?: (choice: CameraChoice) => void,
): Promise<MediaStream> {
  const camSize = {
    width: { ideal: opts.camRes[0] },
    height: { ideal: opts.camRes[1] },
  };
  const openEnvironment = () =>
    navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, ...camSize },
      audio: false,
    });
  const facingOf = (s: MediaStream) => {
    const t = s.getVideoTracks()[0];
    return { label: t?.label ?? "", facingMode: (t?.getSettings?.().facingMode as string | undefined) ?? "-" };
  };
  let stream = await openEnvironment();
  onProgress("gum-ok");
  if (!opts.preferUltraWide) {
    onChoice?.({ ...facingOf(stream), reason: "environment(lens=wide)" });
    return stream;
  }
  // ラベルは許可取得後にしか取れないので「一度開いて → 止めて → 開き直す」
  const devices = await navigator.mediaDevices.enumerateDevices();
  const pick = pickBackUltraWide(devices);
  if (!pick.device) {
    onChoice?.({ ...facingOf(stream), reason: `environment(${pick.reason})` });
    return stream;
  }
  stream.getTracks().forEach((t) => t.stop());
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: pick.device.deviceId }, ...camSize },
      audio: false,
    });
    onProgress("ultra-ok");
  } catch {
    stream = await openEnvironment();
    onProgress("ultra-fail-fallback");
    onChoice?.({ ...facingOf(stream), reason: "environment(ultra-open-failed)" });
    return stream;
  }
  // 開いた後も確かめる: 前面（facingMode = user）だったら超広角をやめて背面に戻す
  const opened = facingOf(stream);
  if (opened.facingMode === "user") {
    stream.getTracks().forEach((t) => t.stop());
    stream = await openEnvironment();
    onProgress("ultra-was-front-fallback");
    onChoice?.({ ...facingOf(stream), reason: `environment(ultra-was-front: ${opened.label})` });
    return stream;
  }
  onChoice?.({ ...opened, reason: pick.reason });
  return stream;
}

export type PassthroughOptions = BackCameraOptions & {
  /** 外部のカメラ所有者（8th Wall 等）が取得済みの video を共有する。getUserMedia は呼ばない */
  existingVideo?: HTMLVideoElement;
  /** 指定があれば実カメラの代わりにこれを使う（?fakecam=1） */
  fakeStream?: () => MediaStream;
  /** 実カメラの水平 FOV [deg] の上書き（?camFov=）。未指定ならレンズ種別のラベルから推定 */
  camFovOverride?: number;
  /** 片目ビューポートのアスペクト比（幅 / 高さ）。StereoEffect なら innerWidth/2/innerHeight */
  eyeAspect: () => number;
  /** 背景の表示倍率（?camZoom=。1 未満で広く表示。PAIN_POINTS「スケール感の正解が分からない」） */
  zoom: number;
};

export type Passthrough = {
  readonly video: HTMLVideoElement;
  readonly texture: THREE.VideoTexture;
  /** カメラのラベル（HUD 用） */
  readonly label: string;
  /** 実カメラの水平 FOV [deg]（長辺方向。マーカー姿勢推定・手の深度推定に使う） */
  readonly camHFovDeg: number;
  /** 外部エンジンから推定した実際の水平 FOV を反映する */
  setCamHFovDeg(fovDeg: number): void;
  /** HUD 用の要約（"1280x720 Back Ultra Wide Camera"） */
  readonly summary: string;
  /** どのカメラを・なぜ選んだか（facingMode 込み。フェイクカメラ・既存の video では null） */
  readonly choice: CameraChoice | null;
  /**
   * カメラ映像と片目ビューポートの縦横比補正（object-fit: cover 相当）を再計算する。
   * window の resize で呼ぶ。video の resize（iOS の回転で映像の縦横が入れ替わる）は内部で拾う
   */
  updateCover(): void;
  /**
   * 「画像のどこに映っているか → 仮想カメラから見てどの方向か」の対応（表示基準）。
   * 背景の cover 切り抜きの逆変換 + 仮想カメラの FOV。骨格を背景の手に重ねるのに使う
   */
  displayViewMapping(fovDeg: number): ViewMapping;
  /**
   * 実カメラの FOV に基づく対応（実寸基準。手の深度推定に使う）。
   * 映像サイズが未確定なら null
   */
  metricViewMapping(): ViewMapping | null;
  /**
   * 背景と幾何的に整合する仮想カメラの垂直 FOV [deg]。この値で描くと、実カメラの FOV で
   * 距離を計算した仮想物（マーカー基準のコート等）が背景の実物にぴったり重なる。
   * 映像の縦 FOV（camHFovDeg は長辺方向）× 背景の縦方向の表示割合（cover 切り抜きと zoom）。
   * 映像サイズが未確定なら null（06 の実機で fov=135 だとマーカー基準の物が 0.44 倍に
   * 縮んで見えた経緯は PAIN_POINTS「背景整合の FOV と距離感の FOV」参照）
   */
  backgroundFovDeg(): number | null;
};

/**
 * 背景の VideoTexture の cover 切り抜き（object-fit: cover 相当）と表示倍率（zoom。1 未満で広く）の UV 変換。
 * 片目のビューポートの位置 p（0..1、左下原点）→ 映像の UV = p × repeat + offset（左下原点。VideoTexture は flipY）。
 * 背景と同じ変換を他の処理（ex9-1 の人の形のマスク）でも使えるよう純粋関数にした（中身は従来の updateCover と同じ）
 */
export function coverUvTransform(
  videoAspect: number,
  eyeAspect: number,
  zoom: number,
): { repeat: [number, number]; offset: [number, number] } {
  let rx = 1;
  let ry = 1;
  if (videoAspect > eyeAspect) {
    rx = eyeAspect / videoAspect;
  } else {
    ry = videoAspect / eyeAspect;
  }
  rx /= zoom;
  ry /= zoom;
  return { repeat: [rx, ry], offset: [(1 - rx) / 2, (1 - ry) / 2] };
}

/**
 * カメラを開き、scene.background に VideoTexture を張る。
 * 開始ボタンのハンドラ内（許可フローの中）から呼ぶこと
 */
export async function startPassthrough(
  scene: THREE.Scene,
  opts: PassthroughOptions,
  onProgress: (step: string) => void,
): Promise<Passthrough> {
  const video = opts.existingVideo ?? document.createElement("video");
  video.playsInline = true;
  video.muted = true;
  let choice: CameraChoice | null = null;
  const stream = opts.existingVideo
    ? (video.srcObject as MediaStream | null)
    : opts.fakeStream
      ? opts.fakeStream()
      : await openBackCameraStream(opts, onProgress, (c) => {
          choice = c;
        });
  if (!opts.existingVideo) {
    video.srcObject = stream;
    await video.play();
  }
  onProgress("play-ok");
  const texture = new THREE.VideoTexture(video);
  texture.colorSpace = THREE.SRGBColorSpace;
  scene.background = texture;

  const updateCover = () => {
    if (!video.videoWidth || !video.videoHeight) return;
    const c = coverUvTransform(video.videoWidth / video.videoHeight, opts.eyeAspect(), opts.zoom);
    texture.repeat.set(c.repeat[0], c.repeat[1]);
    texture.offset.set(c.offset[0], c.offset[1]);
  };
  updateCover();
  // iOS は本体の回転で映像自体が回転し videoWidth/Height が入れ替わる。window の resize より
  // 遅れて届くので、video 側の resize でも補正を取り直す（PAIN_POINTS 参照）
  video.addEventListener("resize", updateCover);

  const label = stream?.getVideoTracks()[0]?.label ?? "";
  let camHFovDeg =
    opts.camFovOverride ??
    (ULTRA_WIDE_LABEL.test(label) ? CAM_FOV_ULTRA_WIDE : CAM_FOV_WIDE);

  return {
    video,
    texture,
    label,
    get camHFovDeg() { return camHFovDeg; },
    setCamHFovDeg(fovDeg) {
      if (Number.isFinite(fovDeg) && fovDeg > 0 && fovDeg < 180) camHFovDeg = fovDeg;
    },
    summary: `${video.videoWidth}x${video.videoHeight} ${label}`.trim(),
    choice,
    updateCover,
    displayViewMapping(fovDeg) {
      return {
        tanHalfFov: Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2),
        eyeAspect: opts.eyeAspect(),
        repeatX: texture.repeat.x,
        repeatY: texture.repeat.y,
      };
    },
    metricViewMapping() {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh) return null;
      // camHFovDeg は映像の長辺方向の FOV として扱う（縦持ちで映像が回転しても長辺に付く）
      const t = Math.tan(THREE.MathUtils.degToRad(camHFovDeg) / 2);
      return {
        tanHalfFov: t * (vh / Math.max(vw, vh)),
        eyeAspect: vw / vh,
        repeatX: 1,
        repeatY: 1,
      };
    },
    backgroundFovDeg() {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh) return null;
      const tanHalfVideoV =
        Math.tan(THREE.MathUtils.degToRad(camHFovDeg) / 2) * (vh / Math.max(vw, vh));
      // 片目ビューポートの縦方向に映像の高さ × repeat.y ぶんが表示されている
      return THREE.MathUtils.radToDeg(2 * Math.atan(tanHalfVideoV * texture.repeat.y));
    },
  };
}
