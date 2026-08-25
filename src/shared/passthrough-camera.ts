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

/** 超広角カメラ優先・解像度指定・フォールバック（02〜05 と同じ） */
export async function openBackCameraStream(
  opts: BackCameraOptions,
  onProgress: (step: string) => void,
): Promise<MediaStream> {
  const camSize = {
    width: { ideal: opts.camRes[0] },
    height: { ideal: opts.camRes[1] },
  };
  let stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: "environment" }, ...camSize },
    audio: false,
  });
  onProgress("gum-ok");
  if (!opts.preferUltraWide) return stream;
  // ラベルは許可取得後にしか取れないので「一度開いて → 止めて → 開き直す」
  const devices = await navigator.mediaDevices.enumerateDevices();
  const ultra = devices.find(
    (d) => d.kind === "videoinput" && ULTRA_WIDE_LABEL.test(d.label),
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

export type PassthroughOptions = BackCameraOptions & {
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
  /** HUD 用の要約（"1280x720 Back Ultra Wide Camera"） */
  readonly summary: string;
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
};

/**
 * カメラを開き、scene.background に VideoTexture を張る。
 * 開始ボタンのハンドラ内（許可フローの中）から呼ぶこと
 */
export async function startPassthrough(
  scene: THREE.Scene,
  opts: PassthroughOptions,
  onProgress: (step: string) => void,
): Promise<Passthrough> {
  const video = document.createElement("video");
  video.playsInline = true;
  video.muted = true;
  const stream = opts.fakeStream
    ? opts.fakeStream()
    : await openBackCameraStream(opts, onProgress);
  video.srcObject = stream;
  await video.play();
  onProgress("play-ok");
  const texture = new THREE.VideoTexture(video);
  texture.colorSpace = THREE.SRGBColorSpace;
  scene.background = texture;

  const updateCover = () => {
    if (!video.videoWidth || !video.videoHeight) return;
    const eyeAspect = opts.eyeAspect();
    const videoAspect = video.videoWidth / video.videoHeight;
    let rx = 1;
    let ry = 1;
    if (videoAspect > eyeAspect) {
      rx = eyeAspect / videoAspect;
    } else {
      ry = videoAspect / eyeAspect;
    }
    rx /= opts.zoom;
    ry /= opts.zoom;
    texture.repeat.set(rx, ry);
    texture.offset.set((1 - rx) / 2, (1 - ry) / 2);
  };
  updateCover();
  // iOS は本体の回転で映像自体が回転し videoWidth/Height が入れ替わる。window の resize より
  // 遅れて届くので、video 側の resize でも補正を取り直す（PAIN_POINTS 参照）
  video.addEventListener("resize", updateCover);

  const label = stream.getVideoTracks()[0]?.label ?? "";
  const camHFovDeg =
    opts.camFovOverride ??
    (ULTRA_WIDE_LABEL.test(label) ? CAM_FOV_ULTRA_WIDE : CAM_FOV_WIDE);

  return {
    video,
    texture,
    label,
    camHFovDeg,
    summary: `${video.videoWidth}x${video.videoHeight} ${label}`.trim(),
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
  };
}
