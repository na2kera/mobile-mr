// 8th Wall がカメラと SLAM を所有する。ゲームは同じ video を背景・マーカー・手に共有する。
// API: https://8thwall.org/docs/api/engine/xrcontroller/pipelinemodule
//      https://8thwall.org/docs/api/engine/xr8/run
//
// 08-11: 08-10 の xr-source.ts のコピーを次のように変えた（08-10 は変更しない）:
//   - LIMITED（trackingStatus !== "NORMAL"）で invalidate しない。reality の姿勢が有効（有限・単位四元数）なら LIMITED でも pose を更新し、
//     無効（reality 無し・NaN など）なら最後の有効な姿勢を保持する。status は生の trackingStatus、trackingReason は生の trackingReason を毎フレーム持つ
//     （08-10 は reason が無効化理由と兼用で、LIMITED の理由が失われていた）
//   - 姿勢の鮮度切れ（500ms 超）でも invalidate しない（main.ts が HUD とログに出すだけ）
//   - invalidate は「原点が確実に変わる出来事」だけ: 端末の向き変更・投影の更新（映像サイズ変更）・onCameraStatusChange("failed")・
//     main.ts からのタブ復帰 / bfcache 復帰。原因ごとの回数（invalidateCounts）を持つ
//   - invalidate では 08-10 と同じく pose = null にし、その後に届いた有効な reality で初めて pose を戻す（設計の追補 A1。
//     原点が変わった直後に古いカメラ姿勢でマーカーを採用しないように。main.ts はマーカーの update を pose !== null のときだけ呼ぶ）
//   - 姿勢の飛び（連続する 2 回の有効な姿勢の差が jumpPosM 以上か jumpDeg 以上）を診断として数える（振る舞いは変えない）。
//     LIMITED → NORMAL の復帰から afterLimitedMs 以内の飛びは afterLimited として別に数える（8th Wall が LIMITED を越えて原点を保つかを実機で測る）
//   - invalidate の後は、repeatFrame でない onUpdate の reality を STALE_FRAMES（2）フレーム、かつ STALE_MS（150ms）捨ててから pose を戻す
//     （向き変更などの直後の数フレームは、古い原点で計算済みの reality が届く可能性がある。推測だが安全側に。レビュー R3）
//   - onException は invalidate しない（原点が変わったとは限らない）。cameraStatus = "exception"・lastError に残し、main.ts が画面の主表示に出す。
//     lastError は少なくとも ERROR_SHOW_MS（3 秒）は残す（次の reality で 1 フレームで消えないように。レビュー R9）
//   - カメラの状態（onCameraStatusChange の hasVideo / failed、例外）は cameraStatus に分け、status（trackingStatus）と混ぜない
//     （LIMITED の回数・長さの集計を汚さない。レビュー R9）
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

/** invalidate の原因（原点が確実に変わる出来事だけ） */
export type InvalidateCause = "orientation" | "projection" | "visibility" | "bfcache" | "cameraFailed";
export const INVALIDATE_CAUSES: readonly InvalidateCause[] = ["orientation", "projection", "visibility", "bfcache", "cameraFailed"];

/** 姿勢の飛び（診断） */
export type XrJump = { tMs: number; posM: number; deg: number; status: string; reason: string; afterLimited: boolean };

export type XrSource = {
  readonly video: HTMLVideoElement | null;
  /** 最後の有効な姿勢（LIMITED 中も有効なら更新。invalidate 後は次の有効な reality まで null） */
  readonly pose: XrPose | null;
  /** 生の trackingStatus（reality が無ければ "NO_REALITY"。最初の reality の前は "starting"） */
  readonly status: string;
  /** カメラの状態（onCameraStatusChange の status: requesting / hasStream / hasVideo / failed。例外の後は "exception"） */
  readonly cameraStatus: string;
  /** 生の trackingReason（毎フレーム。reality が無ければ ""） */
  readonly trackingReason: string;
  /** 直近の invalidate の理由（HUD 用の文） */
  readonly reason: string;
  /** 直近の reality の intrinsics が有効だったか（無効なら intrinsics は最後の有効な値のまま） */
  readonly intrinsicsOk: boolean;
  readonly intrinsics: ArrayLike<number> | null;
  /** 最後に有効な姿勢を採用した時刻 [ms]（鮮度。HUD とログに出すだけ） */
  readonly frameMs: number;
  /** 原点が変わった時刻 [ms]。この後に採用したマーカーの観測で再ロックする */
  readonly invalidatedAt: number;
  /** invalidate の回数（世代。同じフレーム内の invalidate を時刻の分解能に依らず判定する） */
  readonly generation: number;
  /** 原因ごとの invalidate の回数 */
  readonly invalidateCounts: Readonly<Record<InvalidateCause, number>>;
  /** 今の status が始まった時刻 [ms] */
  readonly statusSinceMs: number;
  /** NORMAL → NORMAL 以外 になった回数（LIMITED などの回数） */
  readonly limitedCount: number;
  /** 直近に終わった NORMAL 以外の区間の長さ [ms] */
  readonly lastLimitedMs: number;
  /** NORMAL 以外が始まった時刻 [ms]（NORMAL 中は null） */
  readonly limitedSinceMs: number | null;
  /** 姿勢の飛びの回数・うち LIMITED 復帰直後・最大の大きさ・直近の飛び */
  readonly jumps: { readonly count: number; readonly afterLimited: number; readonly maxPosM: number; readonly maxDeg: number; readonly last: XrJump | null };
  /** 直近の例外・カメラ失敗の文（main.ts が画面の主表示に出す）。無ければ "" */
  readonly lastError: string;
  waitForVideo(): Promise<HTMLVideoElement>;
  preRender(): void;
  postRender(): void;
  invalidate(cause: InvalidateCause, reason: string): void;
  stop(): void;
};

export type XrSourceOptions = {
  timeoutMs?: number;
  /** イベントの 1 行ログ（既定 console.log。"[08-11] event=..." の形で渡す） */
  log?: (line: string) => void;
  /** 姿勢の飛びとみなす位置の差 [m]（既定 0.2） */
  jumpPosM?: number;
  /** 姿勢の飛びとみなす角度の差 [deg]（既定 15） */
  jumpDeg?: number;
  /** LIMITED → NORMAL の復帰からこの時間以内の飛びを afterLimited として数える [ms]（既定 1000） */
  afterLimitedMs?: number;
};

/** invalidate の後に捨てる reality のフレーム数と時間（レビュー R3） */
export const STALE_FRAMES = 2;
export const STALE_MS = 150;
/** 例外・カメラ失敗のエラーを主表示に残す最短の時間 [ms]（レビュー R9） */
export const ERROR_SHOW_MS = 3000;

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
  { timeoutMs = 30000, log = (line: string) => console.log(line), jumpPosM = 0.2, jumpDeg = 15, afterLimitedMs = 1000 }: XrSourceOptions = {},
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
  let intrinsicsOk = false;
  let status = "starting";
  let trackingReason = "";
  let reason = "";
  let lastError = "";
  let errorAtMs = -Infinity;
  let cameraStatus = "starting";
  /** invalidate の後に捨てる残りのフレーム数と、捨て続ける期限 [ms]（レビュー R3） */
  let staleFrames = 0;
  let staleUntilMs = -Infinity;
  let frameMs = -Infinity;
  let invalidatedAt = performance.now();
  /** invalidate() の回数（同じフレーム内で invalidate されたかを時刻の分解能に依らず判定する） */
  let generation = 0;
  const invalidateCounts: Record<InvalidateCause, number> = { orientation: 0, projection: 0, visibility: 0, bfcache: 0, cameraFailed: 0 };
  let statusSinceMs = performance.now();
  let limitedCount = 0;
  let lastLimitedMs = 0;
  let limitedSinceMs: number | null = null;
  /** 一度でも NORMAL になったか（起動直後の INITIALIZING 等を LIMITED の区間として数えない） */
  let everNormal = false;
  /** 直近に NORMAL 以外 → NORMAL に戻った時刻 [ms] */
  let recoveredAtMs = -Infinity;
  /** 飛びの判定に使う直前の有効な姿勢（invalidate で捨てる。原点が変わった後の差は飛びではない） */
  let prevPose: XrPose | null = null;
  const jumps = { count: 0, afterLimited: 0, maxPosM: 0, maxDeg: 0, last: null as XrJump | null };
  let started = false;
  let disposed = false;
  let projectionSize = "";
  let resolveVideo!: (video: HTMLVideoElement) => void;
  let rejectVideo!: (error: Error) => void;
  const videoReady = new Promise<HTMLVideoElement>((resolve, reject) => { resolveVideo = resolve; rejectVideo = reject; });
  const videoTimer = setTimeout(() => rejectVideo(new Error("8th Wall の映像取得がタイムアウトしました")), 30000);
  const invalidate = (cause: InvalidateCause, why: string) => {
    generation++;
    invalidatedAt = performance.now();
    pose = null;
    prevPose = null;
    frameMs = -Infinity;
    reason = why;
    staleFrames = STALE_FRAMES;
    staleUntilMs = performance.now() + STALE_MS;
    invalidateCounts[cause]++;
    log(`[08-11] event=invalidate cause=${cause} count=${invalidateCounts[cause]} status=${status} reason="${why}"`);
  };
  /** status を変える（NORMAL 以外の区間の開始・終了をログに出す） */
  const setStatus = (next: string, nextReason: string) => {
    const now = performance.now();
    if (next !== status) {
      const wasNormal = status === "NORMAL";
      const isNormal = next === "NORMAL";
      if (wasNormal && !isNormal) {
        limitedCount++;
        limitedSinceMs = now;
        log(`[08-11] event=limited-start status=${next} reason=${nextReason || "-"} count=${limitedCount}`);
      } else if (!wasNormal && isNormal) {
        if (limitedSinceMs !== null) {
          lastLimitedMs = now - limitedSinceMs;
          recoveredAtMs = now;
          log(`[08-11] event=limited-end from=${status} reason=${trackingReason || "-"} durationMs=${lastLimitedMs.toFixed(0)}`);
        }
        limitedSinceMs = null;
        everNormal = true;
      } else if (!wasNormal && !isNormal && everNormal && limitedSinceMs === null) {
        limitedSinceMs = now;
      }
      status = next;
      statusSinceMs = now;
    }
    trackingReason = nextReason;
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
    // 開始時の 1 回目で、まだ姿勢を採用していなければ捨てるものが無い（姿勢の採用の後にずれ込んだ初回は invalidate する。レビュー R8）
    const first = projectionSize === "" && pose === null;
    projectionSize = size;
    // updateCameraProjectionMatrix は pixelRect と一緒に開始位置（origin/facing）も engine に送り直すので、
    // 以後の姿勢は新しい原点基準になる → マーカーで位置合わせし直す
    xr.XrController.updateCameraProjectionMatrix({
      cam: { pixelRectWidth: video.videoWidth, pixelRectHeight: video.videoHeight, nearClipPlane: 0.05, farClipPlane: 100 },
    });
    // 開始時の 1 回目（onStart）は、まだ姿勢が 1 つも無いので捨てるものが無い。invalidate として数えない（HUD の inv= を実際の変化だけにする）
    if (first) return;
    invalidate("projection", `映像サイズ変更（${size}）。マーカーで位置合わせしてください`);
  };
  xr.XrController.configure({ scale: "absolute", disableWorldTracking: false, leftHandedAxes: false, mirroredDisplay: false });
  xr.addCameraPipelineModules([
    xr.XrController.pipelineModule(),
    {
      name: "splatoon-8thwall-board-bridge",
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
        cameraStatus = next;
        if (next === "hasVideo" && attached && !video) { video = attached; clearTimeout(videoTimer); resolveVideo(attached); }
        if (next === "failed") {
          // カメラが失われた: 以後の姿勢は同じ原点とは限らない（08-10 はここで invalidate していなかった）
          lastError = "8th Wall のカメラ取得に失敗しました";
          errorAtMs = performance.now();
          invalidate("cameraFailed", lastError);
          clearTimeout(videoTimer);
          rejectVideo(new Error(lastError));
        }
        configureProjection();
      },
      onVideoSizeChange: configureProjection,
      onCanvasSizeChange: configureProjection,
      // 端末の向きが変わると reality は origin 込みで engine に送り直される（開始位置のリセット）→ 再ロック必須
      onDeviceOrientationChange: () => {
        if (disposed) return;
        configureProjection();
        invalidate("orientation", "端末の向きが変わりました。マーカーで位置合わせしてください");
      },
      onUpdate: ({ processCpuResult, frameStartResult }: { processCpuResult?: { reality?: Reality }; frameStartResult?: { repeatFrame?: boolean } }) => {
        if (disposed) return;
        const before = generation;
        configureProjection();
        // 投影更新で invalidate したフレームの reality は旧 origin で計算済みなので捨てる（status はそのまま）
        if (generation !== before) return;
        // 映像が進んでいない（停止・同じ currentTime）フレームでは SLAM は前回の reality を繰り返すだけ。
        // 鮮度（frameMs）も姿勢も更新しない（main.ts は鮮度を HUD とログに出すだけで、コートは最後の姿勢のまま）
        if (frameStartResult?.repeatFrame) return;
        const reality = processCpuResult?.reality;
        if (!reality) {
          // reality が無い: 姿勢は最後の有効な値のまま
          setStatus("NO_REALITY", "");
          return;
        }
        if (lastError && performance.now() - errorAtMs >= ERROR_SHOW_MS) lastError = "";
        if (cameraStatus === "exception") cameraStatus = "hasVideo";
        setStatus(String(reality.trackingStatus ?? "UNKNOWN"), String(reality.trackingReason ?? ""));
        intrinsicsOk = validIntrinsics(reality.intrinsics);
        if (intrinsicsOk) intrinsics = Array.from(reality.intrinsics);
        if (staleFrames > 0 || performance.now() < staleUntilMs) {
          // invalidate の直後: 古い原点で計算済みかもしれない reality は姿勢に使わない（status と intrinsics は更新する）
          staleFrames = Math.max(0, staleFrames - 1);
          return;
        }
        // LIMITED でも姿勢が有効なら採用する（ユーザーの方針: LIMITED 中もコートを表示し続ける）。無効なら最後の有効な姿勢を保持
        if (!validPose(reality)) return;
        const next: XrPose = {
          position: { x: reality.position.x, y: reality.position.y, z: reality.position.z },
          rotation: { x: reality.rotation.x, y: reality.rotation.y, z: reality.rotation.z, w: reality.rotation.w },
        };
        const now = performance.now();
        if (prevPose) {
          const posM = Math.hypot(next.position.x - prevPose.position.x, next.position.y - prevPose.position.y, next.position.z - prevPose.position.z);
          const q = next.rotation;
          const p = prevPose.rotation;
          const deg = (2 * Math.acos(Math.min(1, Math.abs(q.x * p.x + q.y * p.y + q.z * p.z + q.w * p.w))) * 180) / Math.PI;
          if (posM >= jumpPosM || deg >= jumpDeg) {
            const afterLimited = status === "NORMAL" && now - recoveredAtMs <= afterLimitedMs;
            jumps.count++;
            if (afterLimited) jumps.afterLimited++;
            jumps.maxPosM = Math.max(jumps.maxPosM, posM);
            jumps.maxDeg = Math.max(jumps.maxDeg, deg);
            jumps.last = { tMs: now, posM, deg, status, reason: trackingReason, afterLimited };
            log(`[08-11] event=jump posM=${posM.toFixed(3)} deg=${deg.toFixed(1)} status=${status} reason=${trackingReason || "-"} afterLimited=${afterLimited ? 1 : 0} gapMs=${(now - frameMs).toFixed(0)} count=${jumps.count}`);
          }
        }
        pose = next;
        prevPose = next;
        frameMs = now;
      },
      onException: (error: unknown) => {
        if (disposed) return;
        const msg = error instanceof Error ? error.message : String(error);
        const first = cameraStatus !== "exception";
        lastError = `8th Wall: ${msg}`;
        errorAtMs = performance.now();
        cameraStatus = "exception";
        if (first) log(`[08-11] event=xr-exception msg="${msg.slice(0, 200)}"`);
        clearTimeout(videoTimer);
        rejectVideo(error instanceof Error ? error : new Error(msg));
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
    get trackingReason() { return trackingReason; },
    get reason() { return reason; }, get intrinsics() { return intrinsics; }, get intrinsicsOk() { return intrinsicsOk; },
    get frameMs() { return frameMs; },
    get invalidatedAt() { return invalidatedAt; }, get generation() { return generation; },
    get invalidateCounts() { return invalidateCounts; },
    get statusSinceMs() { return statusSinceMs; }, get limitedCount() { return limitedCount; },
    get lastLimitedMs() { return lastLimitedMs; }, get limitedSinceMs() { return limitedSinceMs; },
    get jumps() { return jumps; },
    get lastError() { return lastError; }, get cameraStatus() { return cameraStatus; },
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
