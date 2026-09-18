// OpenCV.js（public/vendor/opencv/opencv.js。scripts/fetch-opencv.mjs で取得する WASM 同梱の単一ファイル）を
// 実行時に読み込む。<script> は使わず fetch → Blob の ES モジュールを動的 import する（08-4 の方針。読み込みの進捗と失敗を
// 呼び出し側（HUD）に返せるようにするため。失敗したら呼び出し側が js-aruco2 にフォールバックする）。
// 配布ファイルは UMD（`module.exports` があればそれに代入）なので、前置きで module / exports を用意して default export に流す。
// WASM は data: URI で同梱されているため、別ファイルの取得や locateFile は要らない。
//
// 型: @techstark/opencv-js の d.ts は依存に足さない方針なので、08-4 が使う範囲だけをここで宣言する
export type CvMat = {
  readonly rows: number;
  readonly cols: number;
  readonly data: Uint8Array;
  readonly data32F: Float32Array;
  readonly data32S: Int32Array;
  readonly data64F: Float64Array;
  type(): number;
  delete(): void;
};

export type CvMatVector = {
  size(): number;
  get(i: number): CvMat;
  delete(): void;
};

export type OpenCv = {
  Mat: {
    new (): CvMat;
    new (rows: number, cols: number, type: number): CvMat;
    zeros(rows: number, cols: number, type: number): CvMat;
  };
  MatVector: new () => CvMatVector;
  matFromArray(rows: number, cols: number, type: number, array: ArrayLike<number>): CvMat;
  matFromImageData(imageData: ImageData): CvMat;
  cvtColor(src: CvMat, dst: CvMat, code: number): void;
  solvePnP(objectPoints: CvMat, imagePoints: CvMat, cameraMatrix: CvMat, distCoeffs: CvMat, rvec: CvMat, tvec: CvMat, useExtrinsicGuess: boolean, flags: number): boolean;
  Rodrigues(src: CvMat, dst: CvMat): void;
  getPredefinedDictionary(name: number): { delete(): void };
  aruco_DetectorParameters: new () => { cornerRefinementMethod: number; errorCorrectionRate: number; delete(): void };
  aruco_RefineParameters: new (minRepDistance: number, errorCorrectionRate: number, checkAllOrders: boolean) => { delete(): void };
  aruco_ArucoDetector: new (dictionary: unknown, params: unknown, refine: unknown) => { detectMarkers(image: CvMat, corners: CvMatVector, ids: CvMat, rejected: CvMatVector): void; delete(): void };
  getBuildInformation?: () => string;
  readonly CV_8UC1: number;
  readonly CV_8UC4: number;
  readonly CV_32F: number;
  readonly CV_64F: number;
  readonly COLOR_RGBA2GRAY: number;
  readonly DICT_ARUCO_MIP_36h12: number;
  readonly CORNER_REFINE_SUBPIX: number;
  readonly SOLVEPNP_ITERATIVE: number;
  readonly SOLVEPNP_IPPE: number;
  readonly SOLVEPNP_IPPE_SQUARE: number;
  onRuntimeInitialized?: () => void;
};

/** 08-4 が既定で読む場所（Vite の public/ 配下。`npm run fetch:opencv` で取得） */
export function defaultOpenCvUrl(baseUrl: string): string {
  return `${baseUrl}vendor/opencv/opencv.js`;
}

/**
 * OpenCV.js を読み込んで初期化済みのモジュールを返す。失敗（404・パース失敗・ArucoDetector 無し・取得や初期化のタイムアウト）は throw。
 * @param onProgress 取得の進捗（"3.2/10.9MB" → "compiling" → "ready"）
 * @param timeoutMs WASM の初期化（onRuntimeInitialized）を待つ上限
 * @param fetchTimeoutMs 取得の無応答の上限。応答ヘッダまで、および本体のチャンクの間隔がこれを超えたら AbortController で中断する
 *   （回線が遅いだけで 11MB の取得全体が 30s を超えるのは許し、止まったまま loading に居座るのを防ぐ）
 */
export async function loadOpenCv(url: string, onProgress?: (step: string) => void, timeoutMs = 90_000, fetchTimeoutMs = 30_000): Promise<OpenCv> {
  const controller = new AbortController();
  let fetchTimer: ReturnType<typeof setTimeout> | undefined;
  const armFetchTimer = () => {
    clearTimeout(fetchTimer);
    fetchTimer = setTimeout(() => controller.abort(new Error(`opencv.js の取得が ${fetchTimeoutMs / 1000}s 応答しない`)), fetchTimeoutMs);
  };
  armFetchTimer();
  try {
    return await loadOpenCvInner(url, controller.signal, { arm: armFetchTimer, stop: () => clearTimeout(fetchTimer) }, onProgress, timeoutMs);
  } catch (e) {
    // abort の理由（タイムアウト）を優先して返す（fetch / reader.read は AbortError を投げる）
    if (controller.signal.aborted && controller.signal.reason instanceof Error) throw controller.signal.reason;
    throw e;
  } finally {
    clearTimeout(fetchTimer);
  }
}

async function loadOpenCvInner(
  url: string,
  signal: AbortSignal,
  fetchTimer: { arm(): void; stop(): void },
  onProgress: ((step: string) => void) | undefined,
  timeoutMs: number,
): Promise<OpenCv> {
  const res = await fetch(url, { signal });
  fetchTimer.arm();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}（npm run fetch:opencv で取得）`);
  // Vite の dev サーバーは無いパスにも index.html を 200 で返すので、種類でも弾く
  if (/html/i.test(res.headers.get("content-type") ?? "")) throw new Error(`${url} が JS ではなく HTML（ファイルが無い? npm run fetch:opencv で取得）`);
  const total = Number(res.headers.get("content-length")) || 0;
  const chunks: Uint8Array[] = [];
  let received = 0;
  if (res.body) {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      fetchTimer.arm();
      chunks.push(value);
      received += value.length;
      onProgress?.(`${(received / 1e6).toFixed(1)}${total ? `/${(total / 1e6).toFixed(1)}` : ""}MB`);
    }
  } else {
    const buf = new Uint8Array(await res.arrayBuffer());
    chunks.push(buf);
    received = buf.length;
  }
  if (received < 1_000_000) throw new Error(`opencv.js が小さすぎる（${received} bytes）。取得が途中で切れていないか確認`);
  const merged = new Uint8Array(received);
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.length;
  }
  const src = new TextDecoder().decode(merged);
  // 取得は終わったので無応答のタイムアウトは止める（以降は WASM の初期化の timeoutMs）
  fetchTimer.stop();
  signal.throwIfAborted();
  onProgress?.("compiling");
  // UMD の CommonJS 分岐（typeof module === 'object' && module.exports）に入れて、返ったモジュールを default export にする。
  // ES モジュールなので top-level の this は undefined だが、UMD は module 分岐を先に見るので問題ない
  const wrapped = `const module = { exports: {} }; const exports = module.exports;\n${src}\nexport default module.exports;`;
  const blobUrl = URL.createObjectURL(new Blob([wrapped], { type: "text/javascript" }));
  let loaded: unknown;
  try {
    loaded = (await import(/* @vite-ignore */ blobUrl)).default;
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
  const cv = (loaded instanceof Promise ? await loaded : loaded) as OpenCv;
  if (!cv || typeof cv !== "object") throw new Error("opencv.js がモジュールを返さなかった（配布ファイルの形式が変わった?）");
  // この Emscripten ビルドの Module には then(func) が生えていて（古い MODULARIZE の名残）、async 関数から返したり Promise で
  // 解決したりすると「thenable を解決 → then が Module 自身を渡す → また thenable」の無限ループになる（Node の --prof で
  // PromiseResolveThenableJob が 100% になって発見）。初期化待ちには使わないので消してから返す
  delete (cv as { then?: unknown }).then;
  if (typeof cv.Mat !== "function") {
    // WASM の初期化はこの時点では非同期に進行中。onRuntimeInitialized を待つ
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`OpenCV.js の初期化が ${timeoutMs / 1000}s 以内に終わらない`)), timeoutMs);
      cv.onRuntimeInitialized = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
  if (typeof cv.aruco_ArucoDetector !== "function" || typeof cv.solvePnP !== "function") {
    throw new Error("この opencv.js には ArucoDetector / solvePnP が入っていない（objdetect 抜きのビルド?）");
  }
  onProgress?.("ready");
  return cv;
}
