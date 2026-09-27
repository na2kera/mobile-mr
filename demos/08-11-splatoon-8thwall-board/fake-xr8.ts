// PC 確認用の XR8 モック（?fakecam=1&fakexr=1）。window.XR8 に差し込んでから既存の startXrSource() を呼ぶので、
// xr-source.ts と main.ts の XR 経路（姿勢の適用・invalidate・再ロック・射撃停止・tracking:false・投影更新）を実コードのまま通せる。
// 実装するのは xr-source.ts が呼ぶ API だけ。callback の順序は scripts/test-08-10-xr.mjs（08-11 は scripts/test-08-11-board.mjs）と同じ
// （run: onCameraStatusChange(hasVideo) → onStart → onAttach、runPreRender: onUpdate）。onAttach の引数は実機と同じく
// {framework, canvas, videoWidth, videoHeight} で video / status は無い（video は onCameraStatusChange(hasVideo) だけで渡る）。
// onUpdate の frameStartResult.repeatFrame は配布 xr.js と同じく「video が停止中・寸法 0・currentTime が前回と同じ」で true
// （そのときの reality は前回と同じものを渡す）。
// API: https://8thwall.org/docs/api/engine/xrcontroller/pipelinemodule
//      https://8thwall.org/docs/api/engine/xr8/run
//
// 姿勢: 合成カメラの field 座標系での姿勢（カメラ → field、three 流儀: +Y 上・-Z 前）に既知のオフセット
// （ヨー回転 + 平行移動、スケール 1）を掛けて「8th Wall の world 座標系でのカメラ姿勢」にする。
// 8th Wall は scale:'absolute' でメートル、Y が重力上向きなので、オフセットはヨーだけ（X/Z の傾きは付けない）。
//
// ヘッドレス確認から window.__fakeXr で状態を切り替える:
//   status: "NORMAL" | "LIMITED"、reason（LIMITED のとき trackingReason）、lost（reality を返さない）、
//   badIntrinsics（不正な intrinsics）、throw（onUpdate の代わりに onException）、setVideoSize(w, h)（映像の解像度を変える）、
//   pauseVideo() / resumeVideo()（video.pause() / play()。停止中は repeatFrame）、holdFrames（次の N 回を repeatFrame にする）、
//   rotateDevice()（各 module の onDeviceOrientationChange を {orientation: 90, videoWidth, videoHeight} で呼ぶ）
//   projection（最後の updateCameraProjectionMatrix の引数）、configured、runOptions、preRenders、postRenders、stopped
//
// 08-11: 原点のリセットを模す。rotateDevice() と、開始後の 2 回目以降の updateCameraProjectionMatrix（映像サイズ変更・resize）で、
// 以後の姿勢の world に原点のオフセット（ORIGIN_SHIFT_M の平行移動 + ORIGIN_SHIFT_YAW_DEG のヨー）を足す。ただし直後の
// STALE_AFTER_RESET フレーム（repeatFrame でないもの）は古い原点の reality を返す（古い原点で計算済みの reality が届く最悪ケース。
// xr-source.ts がそれを捨てて、再ロックが新しい原点で行われるかを確かめる。レビュー R3）。originResets に回数

type Module = {
  name?: string;
  onStart?: (args: object) => void;
  onAttach?: (args: object) => void;
  onCameraStatusChange?: (args: object) => void;
  onVideoSizeChange?: (args: object) => void;
  onCanvasSizeChange?: (args: object) => void;
  onDeviceOrientationChange?: (args: object) => void;
  onUpdate?: (args: object) => void;
  onException?: (error: unknown) => void;
};

export type FakeXrOptions = {
  /** フェイクカメラの映像を srcObject にして play() した video（main.ts の fakeStream を再利用） */
  createVideo(): HTMLVideoElement;
  /** 合成カメラの field 座標系での姿勢（カメラ → field の rigid 4x4、列優先）。未生成なら null */
  cameraToWorld(): number[] | null;
  /** 基準解像度（width × height）での焦点距離 [px] */
  focalPx: number;
  width: number;
  height: number;
  /** field → 8th Wall world のヨー [deg]（既定 140） */
  yawDeg?: number;
  /** field → 8th Wall world の平行移動 [m]（既定 [0.7, -0.3, 1.6]） */
  trans?: [number, number, number];
  /** 位置のノイズ [m]（標準偏差。既定 0.002） */
  noiseM?: number;
};

export type FakeXrState = {
  status: "NORMAL" | "LIMITED";
  reason: string;
  lost: boolean;
  badIntrinsics: boolean;
  throw: boolean;
  projection: { cam?: { pixelRectWidth?: number; pixelRectHeight?: number; nearClipPlane?: number; farClipPlane?: number } } | null;
  configured: Record<string, unknown> | null;
  runOptions: Record<string, unknown> | null;
  preRenders: number;
  postRenders: number;
  videoSizeChanges: number;
  canvasSizeChanges: number;
  exceptions: number;
  /** repeatFrame: true で onUpdate を呼んだ回数 */
  repeatFrames: number;
  /**
   * 次の N 回の runPreRender を、映像が進んでいても repeatFrame 扱いにする（main スレッドが止まった直後の tick に
   * 新しいカメラフレームがまだ処理されていない状況を模す）
   */
  holdFrames: number;
  orientationChanges: number;
  /** 原点をずらした回数（rotateDevice と 2 回目以降の投影更新） */
  originResets: number;
  /** 古い原点で返した reality の数 */
  staleRealities: number;
  stopped: boolean;
  /** run() で作った映像 */
  video: HTMLVideoElement | null;
  /** 映像（フェイクカメラの canvas）の解像度を変える。captureStream の解像度が変わり、video の videoWidth/Height が追従する */
  setVideoSize(width: number, height: number): string;
  /** 映像を止める（video.pause()。以後の onUpdate は repeatFrame: true） */
  pauseVideo(): boolean;
  /** 映像を再開する（video.play()） */
  resumeVideo(): Promise<boolean>;
  /** 端末の向きの変更を通知する（onDeviceOrientationChange） */
  rotateDevice(): boolean;
};

const NEAR = 0.05;
/** 原点のリセット 1 回ごとに world へ足すオフセット */
const ORIGIN_SHIFT_M: [number, number, number] = [0.5, 0, -0.3];
const ORIGIN_SHIFT_YAW_DEG = 30;
/** リセットの直後に古い原点の reality を返すフレーム数 */
const STALE_AFTER_RESET = 2;
const FAR = 100;

function gaussian(): number {
  return Math.sqrt(-2 * Math.log(Math.random() + 1e-12)) * Math.cos(2 * Math.PI * Math.random());
}

/** 列優先 4x4 の積 a · b */
function mul(a: ArrayLike<number>, b: ArrayLike<number>): number[] {
  const out = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = s;
    }
  }
  return out;
}

/** 回転行列（列優先 4x4 の左上 3x3）→ 単位四元数 */
function quatFromMatrix(m: ArrayLike<number>): { x: number; y: number; z: number; w: number } {
  const m11 = m[0], m12 = m[4], m13 = m[8];
  const m21 = m[1], m22 = m[5], m23 = m[9];
  const m31 = m[2], m32 = m[6], m33 = m[10];
  const trace = m11 + m22 + m33;
  let x: number, y: number, z: number, w: number;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    w = 0.25 / s; x = (m32 - m23) * s; y = (m13 - m31) * s; z = (m21 - m12) * s;
  } else if (m11 > m22 && m11 > m33) {
    const s = 2 * Math.sqrt(1 + m11 - m22 - m33);
    w = (m32 - m23) / s; x = 0.25 * s; y = (m12 + m21) / s; z = (m13 + m31) / s;
  } else if (m22 > m33) {
    const s = 2 * Math.sqrt(1 + m22 - m11 - m33);
    w = (m13 - m31) / s; x = (m12 + m21) / s; y = 0.25 * s; z = (m23 + m32) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m33 - m11 - m22);
    w = (m21 - m12) / s; x = (m13 + m31) / s; y = (m23 + m32) / s; z = 0.25 * s;
  }
  const n = Math.hypot(x, y, z, w);
  return { x: x / n, y: y / n, z: z / n, w: w / n };
}

export function installFakeXr8(opts: FakeXrOptions): FakeXrState {
  const yaw = ((opts.yawDeg ?? 140) * Math.PI) / 180;
  const [tx, ty, tz] = opts.trans ?? [0.7, -0.3, 1.6];
  const noise = opts.noiseM ?? 0.002;
  // field → 8th Wall world（ヨー回転 + 平行移動。列優先）
  let fieldToWorld = [Math.cos(yaw), 0, -Math.sin(yaw), 0, 0, 1, 0, 0, Math.sin(yaw), 0, Math.cos(yaw), 0, tx, ty, tz, 1];
  /** 原点のリセット前の fieldToWorld（直後の STALE_AFTER_RESET フレームだけ使う） */
  let staleFieldToWorld: number[] | null = null;
  let staleLeft = 0;
  let projectionCalls = 0;
  const shiftYaw = (ORIGIN_SHIFT_YAW_DEG * Math.PI) / 180;
  const originShift = [Math.cos(shiftYaw), 0, -Math.sin(shiftYaw), 0, 0, 1, 0, 0, Math.sin(shiftYaw), 0, Math.cos(shiftYaw), 0, ...ORIGIN_SHIFT_M, 1];
  const resetOrigin = () => {
    staleFieldToWorld = fieldToWorld;
    staleLeft = STALE_AFTER_RESET;
    fieldToWorld = mul(originShift, fieldToWorld);
    state.originResets++;
  };
  let modules: Module[] = [];
  let video: HTMLVideoElement | null = null;
  let canvas: HTMLCanvasElement | null = null;
  let running = false;
  let lastVideoSize = "";
  let lastVideoTime = -1;
  let lastReality: object | undefined;

  const call = (name: Exclude<keyof Module, "name">, args: object) => {
    for (const m of modules) {
      const fn = m[name] as ((a: object) => void) | undefined;
      fn?.call(m, args);
    }
  };

  const intrinsics = (vw: number, vh: number): number[] => {
    // 焦点距離は基準の横幅に対する比で伸縮する（解像度を変えても水平 FOV は同じ。フェイクカメラの描画と同じ換算）
    const f = (opts.focalPx * vw) / opts.width;
    const p = new Array<number>(16).fill(0);
    p[0] = (2 * f) / vw;
    p[5] = (2 * f) / vh;
    p[10] = -(FAR + NEAR) / (FAR - NEAR);
    p[11] = -1;
    p[14] = (-2 * FAR * NEAR) / (FAR - NEAR);
    return p;
  };

  const state: FakeXrState = {
    status: "NORMAL",
    reason: "",
    lost: false,
    badIntrinsics: false,
    throw: false,
    projection: null,
    configured: null,
    runOptions: null,
    preRenders: 0,
    postRenders: 0,
    videoSizeChanges: 0,
    canvasSizeChanges: 0,
    exceptions: 0,
    repeatFrames: 0,
    holdFrames: 0,
    orientationChanges: 0,
    originResets: 0,
    staleRealities: 0,
    stopped: false,
    video: null,
    setVideoSize(width: number, height: number) {
      const track = (video?.srcObject as MediaStream | null)?.getVideoTracks()[0] as (MediaStreamTrack & { canvas?: HTMLCanvasElement }) | undefined;
      const source = track?.canvas;
      if (!source) return "no-canvas-track";
      source.width = Math.round(width);
      source.height = Math.round(height);
      return `${source.width}x${source.height}`;
    },
    pauseVideo() {
      if (!video) return false;
      video.pause();
      return video.paused;
    },
    async resumeVideo() {
      if (!video) return false;
      await video.play();
      return !video.paused;
    },
    rotateDevice() {
      if (!running || !video) return false;
      state.orientationChanges++;
      resetOrigin();
      call("onDeviceOrientationChange", { orientation: 90, videoWidth: video.videoWidth, videoHeight: video.videoHeight });
      return true;
    },
  };

  // 実機の XrController は表示 canvas のサイズ変更でも pixelRect を canvas 寸法で上書きする（xr-source.ts のコメント参照）。
  // その最悪ケースを模して、ウィンドウの resize で XR 用 canvas を表示寸法にし、記録する投影も canvas 寸法で上書きしてから
  // onCanvasSizeChange を呼ぶ。xr-source.ts が canvas と投影を映像寸法へ戻せるかを確認するため
  const onWindowResize = () => {
    if (!running || !canvas) return;
    canvas.width = Math.round(innerWidth * devicePixelRatio);
    canvas.height = Math.round(innerHeight * devicePixelRatio);
    const cam = state.projection?.cam ?? {};
    state.projection = { ...state.projection, cam: { ...cam, pixelRectWidth: canvas.width, pixelRectHeight: canvas.height } };
    state.canvasSizeChanges++;
    call("onCanvasSizeChange", { canvasWidth: canvas.width, canvasHeight: canvas.height, videoWidth: video?.videoWidth, videoHeight: video?.videoHeight });
  };

  const xr8 = {
    XrController: {
      configure(o: Record<string, unknown>) { state.configured = { ...state.configured, ...o }; },
      pipelineModule(): Module { return { name: "reality" }; },
      updateCameraProjectionMatrix(o: FakeXrState["projection"]) {
        state.projection = o;
        // 開始時の 1 回目は原点の設定そのもの。2 回目以降は実機と同じく原点がリセットされる
        if (projectionCalls++ > 0) resetOrigin();
      },
    },
    XrConfig: { device: () => ({ MOBILE: "mobile", ANY: "any" }) },
    addCameraPipelineModules(list: Module[]) { modules = [...modules, ...list]; },
    run(o: { canvas: HTMLCanvasElement } & Record<string, unknown>) {
      state.runOptions = o;
      state.stopped = false;
      canvas = o.canvas;
      running = true;
      const v = opts.createVideo();
      video = v;
      state.video = v;
      addEventListener("resize", onWindowResize);
      const attach = () => {
        if (!running) return;
        if (v.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
          v.addEventListener("loadeddata", attach, { once: true });
          return;
        }
        lastVideoSize = `${v.videoWidth}x${v.videoHeight}`;
        call("onCameraStatusChange", { status: "hasVideo", video: v });
        call("onStart", { canvas, canvasWidth: canvas?.width, canvasHeight: canvas?.height, videoWidth: v.videoWidth, videoHeight: v.videoHeight });
        call("onAttach", { framework: {}, canvas, videoWidth: v.videoWidth, videoHeight: v.videoHeight });
      };
      attach();
    },
    runPreRender(timestamp: number) {
      if (!running || !video) return;
      state.preRenders++;
      const size = `${video.videoWidth}x${video.videoHeight}`;
      if (video.videoWidth && size !== lastVideoSize) {
        lastVideoSize = size;
        state.videoSizeChanges++;
        call("onVideoSizeChange", { videoWidth: video.videoWidth, videoHeight: video.videoHeight });
      }
      if (state.throw) {
        state.exceptions++;
        for (const m of modules) m.onException?.call(m, new Error("fake XR8 exception (__fakeXr.throw)"));
        return;
      }
      // 配布 xr.js と同じ判定: 映像が進んでいないフレームでは SLAM を省略して前回の reality を繰り返す
      const held = state.holdFrames > 0;
      if (held) state.holdFrames--;
      const repeatFrame = held || video.paused || video.videoWidth <= 0 || video.currentTime === lastVideoTime;
      if (!held) lastVideoTime = video.currentTime;
      if (repeatFrame) {
        state.repeatFrames++;
        call("onUpdate", { frameStartResult: { repeatFrame: true, frameTime: timestamp }, processCpuResult: { reality: lastReality } });
        return;
      }
      const camToField = opts.cameraToWorld();
      let reality: object | undefined;
      if (!state.lost && camToField && video.videoWidth && video.videoHeight) {
        let toWorld = fieldToWorld;
        if (staleLeft > 0 && staleFieldToWorld) {
          staleLeft--;
          state.staleRealities++;
          toWorld = staleFieldToWorld;
        }
        const m = mul(toWorld, camToField);
        reality = {
          position: { x: m[12] + noise * gaussian(), y: m[13] + noise * gaussian(), z: m[14] + noise * gaussian() },
          rotation: quatFromMatrix(m),
          intrinsics: state.badIntrinsics ? [Number.NaN, 0, 0, 0, 0, 0, 0, 0, 0, 0, -1, -1, 0, 0, 0, 0] : intrinsics(video.videoWidth, video.videoHeight),
          trackingStatus: state.status,
          trackingReason: state.status === "LIMITED" ? state.reason || "UNSPECIFIED" : "UNSPECIFIED",
          timestamp,
        };
      }
      lastReality = reality;
      call("onUpdate", { frameStartResult: { repeatFrame: false, frameTime: timestamp }, processCpuResult: { reality } });
    },
    runPostRender() {
      if (running) state.postRenders++;
    },
    stop() {
      running = false;
      state.stopped = true;
      removeEventListener("resize", onWindowResize);
      for (const t of (video?.srcObject as MediaStream | null)?.getTracks() ?? []) t.stop();
    },
  };
  (window as unknown as { XR8: unknown }).XR8 = xr8;
  (window as unknown as { __fakeXr: FakeXrState }).__fakeXr = state;
  return state;
}
