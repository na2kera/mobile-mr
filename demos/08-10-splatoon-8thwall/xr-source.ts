// 8th Wall がカメラと SLAM を所有する。ゲームは同じ video を背景・マーカー・手に共有する。
// API: https://8thwall.org/docs/api/engine/xrcontroller/pipelinemodule
//      https://8thwall.org/docs/api/engine/xr8/run
export type XrPose = {
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number; w: number };
};
type Reality = XrPose & { intrinsics: ArrayLike<number>; trackingStatus: string; trackingReason: string };
export type XR8 = {
  XrController: {
    configure(options: Record<string, unknown>): void;
    pipelineModule(): object;
    updateCameraProjectionMatrix(options: object): void;
  };
  XrConfig: { device(): { MOBILE: unknown } };
  addCameraPipelineModules(modules: object[]): void;
  run(options: object): void;
  runPreRender(timestamp: number): void;
  runPostRender(): void;
  stop(): void;
};

export type XrSource = {
  readonly video: HTMLVideoElement | null;
  readonly pose: XrPose | null;
  readonly status: string;
  readonly reason: string;
  readonly intrinsics: ArrayLike<number> | null;
  readonly frameMs: number;
  /** LIMITED またはタブ復帰後は、新しいマーカー観測まで原点合わせが必要 */
  readonly invalidatedAt: number;
  waitForVideo(): Promise<HTMLVideoElement>;
  preRender(): void;
  postRender(): void;
  invalidate(reason: string): void;
  stop(): void;
};

/**
 * xr.js（と SLAM chunk）の読み込みを始める。ページ表示時に呼んで開始ボタンまでの待ち時間を減らす。
 * 返した Promise を startXrSource() に渡す（読み込みエラーはそこで再スローされる）。XR8.run は startXrSource() まで呼ばない。
 * タイムアウトはここでは持たない（遅い回線でページ表示から数えると、開始を押す前に失敗が確定してしまう）。
 * 待ち時間の上限は startXrSource() が開始時から数える。xrloaded の listener は残すので、その後に読み終われば resolve する
 */
export function loadEngine(): Promise<XR8> {
  const existing = (window as Window & { XR8?: XR8 }).XR8;
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `${import.meta.env.BASE_URL}vendor/8thwall/xr.js`;
    script.async = true;
    script.crossOrigin = "anonymous";
    script.dataset.preloadChunks = "slam";
    const ready = () => {
      const xr = (window as Window & { XR8?: XR8 }).XR8;
      if (xr) resolve(xr);
      else reject(new Error("xrloaded 後も XR8 がありません"));
    };
    window.addEventListener("xrloaded", ready, { once: true });
    script.addEventListener("error", () => {
      window.removeEventListener("xrloaded", ready);
      reject(new Error("8th Wall Engine のスクリプトを読み込めません"));
    }, { once: true });
    document.head.append(script);
  });
}

/**
 * @param engine loadEngine() の Promise（先行読み込み）。省略時はここで読み込む（window.XR8 があればそれを使う）
 * @param options.timeoutMs engine を待つ上限（開始時から数える）。超えたら reject するが、読み込み自体は続くので、
 *   後で読み終わっていれば次の startXrSource(canvas) は window.XR8 で開始できる
 */
export async function startXrSource(
  canvas: HTMLCanvasElement,
  engine: Promise<XR8> = loadEngine(),
  { timeoutMs = 30000 }: { timeoutMs?: number } = {},
): Promise<XrSource> {
  let loadTimer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    loadTimer = setTimeout(() => reject(new Error("8th Wall Engine の読み込みがタイムアウトしました")), timeoutMs);
  });
  let xr: XR8;
  try { xr = await Promise.race([engine, timeout]); }
  finally { clearTimeout(loadTimer); }
  if (!xr.XrController) throw new Error("8th Wall の SLAM chunk がありません");
  let video: HTMLVideoElement | null = null;
  let pose: XrPose | null = null;
  let intrinsics: ArrayLike<number> | null = null;
  let status = "starting";
  let reason = "";
  let frameMs = -Infinity;
  let invalidatedAt = performance.now();
  /** invalidate() の回数（同じフレーム内で invalidate されたかを時刻の分解能に依らず判定する） */
  let generation = 0;
  let started = false;
  let disposed = false;
  let projectionSize = "";
  let resolveVideo!: (video: HTMLVideoElement) => void;
  let rejectVideo!: (error: Error) => void;
  const videoReady = new Promise<HTMLVideoElement>((resolve, reject) => { resolveVideo = resolve; rejectVideo = reject; });
  const videoTimer = setTimeout(() => rejectVideo(new Error("8th Wall の映像取得がタイムアウトしました")), 30000);
  const invalidate = (why: string) => {
    generation++;
    invalidatedAt = performance.now();
    pose = null;
    frameMs = -Infinity;
    reason = why;
  };
  const configureProjection = () => {
    if (!video?.videoWidth || !video.videoHeight) return;
    // XrController は canvas size callback でも pixelRect を上書きするため、XR 専用 canvas の
    // 実ピクセル寸法を raw video に合わせる。hasVideo の時点（onStart 前）から合わせ、xr.js の初期化が
    // 既定の 300x150 で走らないようにする
    const resized = canvas.width !== video.videoWidth || canvas.height !== video.videoHeight;
    if (resized) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    }
    if (!started) return;
    const size = `${video.videoWidth}x${video.videoHeight}`;
    if (size === projectionSize && !resized) return;
    projectionSize = size;
    // updateCameraProjectionMatrix は pixelRect と一緒に開始位置（origin/facing）も engine に送り直すので、
    // 以後の姿勢は新しい原点基準になる → マーカーで位置合わせし直す
    xr.XrController.updateCameraProjectionMatrix({
      cam: { pixelRectWidth: video.videoWidth, pixelRectHeight: video.videoHeight, nearClipPlane: 0.05, farClipPlane: 100 },
    });
    invalidate("映像サイズ変更。マーカーで位置合わせしてください");
  };
  xr.XrController.configure({ scale: "absolute", disableWorldTracking: false, leftHandedAxes: false, mirroredDisplay: false });
  xr.addCameraPipelineModules([
    xr.XrController.pipelineModule(),
    {
      name: "splatoon-8thwall-bridge",
      onStart: () => { if (disposed) return; started = true; configureProjection(); },
      // 実機の onAttach には video / status は来ない（{framework, canvas, GLctx, videoWidth, videoHeight, ...}）。
      // video は onCameraStatusChange(hasVideo) で受け取る。ここは念のための経路
      onAttach: ({ video: attached, status: attachedStatus }: { video?: HTMLVideoElement; status?: string }) => {
        if (disposed) return;
        if (attached && !video && (attachedStatus === "hasVideo" || attached.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA)) {
          video = attached; clearTimeout(videoTimer); resolveVideo(attached);
        }
        configureProjection();
      },
      onCameraStatusChange: ({ status: next, video: attached }: { status: string; video?: HTMLVideoElement }) => {
        if (disposed) return;
        status = next;
        if (next === "hasVideo" && attached && !video) { video = attached; clearTimeout(videoTimer); resolveVideo(attached); }
        if (next === "failed") { clearTimeout(videoTimer); rejectVideo(new Error("8th Wall のカメラ取得に失敗しました")); }
        configureProjection();
      },
      onVideoSizeChange: configureProjection,
      onCanvasSizeChange: configureProjection,
      // 端末の向きが変わると reality は origin 込みで engine に送り直される（開始位置のリセット）→ 再ロック必須
      onDeviceOrientationChange: () => {
        if (disposed) return;
        configureProjection();
        invalidate("端末の向きが変わりました。マーカーで位置合わせしてください");
      },
      onUpdate: ({ processCpuResult, frameStartResult }: { processCpuResult?: { reality?: Reality }; frameStartResult?: { repeatFrame?: boolean } }) => {
        if (disposed) return;
        const before = generation;
        configureProjection();
        // 投影更新で invalidate したフレームの reality は旧 origin で計算済みなので捨てる（status はそのまま）
        if (generation !== before) return;
        // 映像が進んでいない（停止・同じ currentTime）フレームでは SLAM は前回の reality を繰り返すだけ。
        // 鮮度（frameMs）も姿勢も更新しない → 止まったままなら main.ts の 500ms 判定で再ロック要求になる
        if (frameStartResult?.repeatFrame) return;
        const reality = processCpuResult?.reality;
        if (!reality || reality.trackingStatus !== "NORMAL" || !validPose(reality) || !validIntrinsics(reality.intrinsics)) {
          if (pose) invalidate(`追跡停止: ${reality?.trackingStatus ?? "NO_POSE"} ${reality?.trackingReason ?? ""}`);
          status = reality && !validIntrinsics(reality.intrinsics) ? "INVALID_INTRINSICS" : reality?.trackingStatus ?? "INITIALIZING";
          return;
        }
        pose = {
          position: { x: reality.position.x, y: reality.position.y, z: reality.position.z },
          rotation: { x: reality.rotation.x, y: reality.rotation.y, z: reality.rotation.z, w: reality.rotation.w },
        };
        intrinsics = Array.from(reality.intrinsics);
        frameMs = performance.now();
        status = "NORMAL";
        reason = "";
      },
      onException: (error: unknown) => {
        if (disposed) return;
        invalidate(`8th Wall: ${error instanceof Error ? error.message : String(error)}`);
        status = "failed";
        clearTimeout(videoTimer);
        rejectVideo(error instanceof Error ? error : new Error(String(error)));
      },
    },
  ]);
  try { xr.run({ canvas, ownRunLoop: false, allowedDevices: xr.XrConfig.device().MOBILE }); }
  catch (error) {
    clearTimeout(videoTimer);
    xr.stop();
    throw error;
  }
  const source: XrSource = {
    get video() { return video; }, get pose() { return pose; }, get status() { return status; },
    get reason() { return reason; }, get intrinsics() { return intrinsics; }, get frameMs() { return frameMs; },
    get invalidatedAt() { return invalidatedAt; },
    waitForVideo() { return videoReady; },
    preRender() { if (started && !disposed) xr.runPreRender(Date.now()); },
    postRender() { if (started && !disposed) xr.runPostRender(); },
    invalidate,
    stop() { disposed = true; clearTimeout(videoTimer); xr.stop(); },
  };
  return source;
}

function validPose(value: Reality): boolean {
  const { position: p, rotation: q } = value;
  if (!p || !q) return false;
  return [p.x, p.y, p.z, q.x, q.y, q.z, q.w].every(Number.isFinite)
    && Math.abs(Math.hypot(q.x, q.y, q.z, q.w) - 1) < 0.05;
}

function validIntrinsics(value: ArrayLike<number> | undefined): value is ArrayLike<number> {
  return Boolean(value && value.length === 16 && value[0] > 0 && value[5] > 0
    && Array.from(value!).every(Number.isFinite));
}
