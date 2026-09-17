// 08-7: カメラ映像 → AlvaAR（WASM の単眼 SLAM）→ カメラの姿勢（three 流儀）。
// AlvaAR は GPLv3 なので npm には足さず、scripts/fetch-alva.mjs で public/vendor/alva/ に置いたものを動的 import する
// （無ければ state=failed になり、呼び出し側は 08 と同じ「マーカーのみ」で動く）。SDK には入れない。
//
// - 入力: <video> を長辺 widthPx に縮小した ImageData（マーカー検出の detW とは別の canvas）
// - 焦点距離: AlvaAR.Initialize(w, h, fov) の fov は「短辺側の FOV」に近い独自の換算（alva_ar.js の getCameraIntrinsics）なので、
//   同じ関数を二分探索して「長辺 / 2 / tan(水平 FOV / 2)」（marker-anchor.ts と同じ換算）になる fov を渡す
// - 状態: findCameraPose の戻り値（null / 16 要素）だけでは「初期化中」と「リセット」が区別できないので、
//   ピン留めしたコミットの内部（alva.system.findCameraPose の戻り値 1=追跡 / 2=リセット / 3=初期化中。src/slam/src/system.cpp）を
//   使えるときは使う。無ければ公開 API の null / 非 null だけで判断する
// - 例外: 検出の呼び出しは try/catch し、例外のフレームはロスト扱い。maxFailures 回続いたら止める（state=failed）。描画ループは止めない
// - フェイク（?fakeslam=1）: AlvaAR を読まず、fakePose() が返す AlvaAR 形式の 16 要素を同じ経路で変換する
import { alvaPoseToThree } from "./slam-fusion";
import type { Pose } from "./slam-fusion";

type AlvaIntrinsics = { fx: number; fy: number };
type AlvaInstance = {
  findCameraPose(frame: ImageData): Float32Array | null;
  intrinsics?: AlvaIntrinsics;
  system?: { findCameraPose(imagePtr: number, posePtr: number): number };
  memImg?: { write(data: Uint8ClampedArray): void; heap: { byteOffset: number } };
  memCam?: { ptr: number; read(length: number): Float32Array };
};
type AlvaClass = {
  Initialize(width: number, height: number, fov?: number): Promise<AlvaInstance>;
  prototype: { getCameraIntrinsics(width: number, height: number, fov?: number): AlvaIntrinsics };
};

export type SlamState = "off" | "loading" | "waiting" | "init" | "tracking" | "lost" | "reset" | "failed";

export type SlamSourceOptions = {
  video: HTMLVideoElement;
  /** 入力画像の長辺 [px] */
  widthPx: number;
  /** 処理の最小間隔 [ms]（0 = カメラの新フレームごと） */
  intervalMs: number;
  /** 例外がこの回数続いたら止める */
  maxFailures: number;
  /** 実カメラの水平 FOV [deg]（長辺方向） */
  camHFovDeg: () => number;
  /** alva_ar.js の URL（動的 import） */
  moduleUrl: string;
  /** フェイク: 今のカメラの姿勢を AlvaAR の形式で返す（null = ロスト）。例外を投げれば例外の経路を通る */
  fakePose?: () => ArrayLike<number> | null;
};

export type SlamSource = {
  /** 描画ループから毎フレーム呼ぶ。このフレームで新しい姿勢が出たらそれ（three 流儀、SLAM 座標系）を返す */
  update(now: number): Pose | null;
  readonly state: SlamState;
  /** failed / off の理由 */
  readonly reason: string;
  /** 直近の処理時間 [ms]（縮小 + getImageData + findCameraPose） */
  readonly lastMs: number;
  /** findCameraPose を呼んだ回数 */
  readonly calls: number;
  /** SLAM のリセット回数（座標系が変わるので、呼び出し側は変換の推定を捨てる） */
  readonly resets: number;
  /** 直近の姿勢（three 流儀） */
  readonly lastPose: Pose | null;
  readonly lastPoseMs: number;
  /** 例外が連続した回数 */
  readonly failures: number;
  /** AlvaAR に渡した焦点距離 [px]（診断用） */
  readonly focalPx: number;
  isTracking(now: number, lostMs: number): boolean;
};

export function createSlamSource(opts: SlamSourceOptions): SlamSource {
  const { video } = opts;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  let AlvaAR: AlvaClass | null = null;
  let alva: AlvaInstance | null = null;
  let alvaSize = "";
  let initializing = false;
  let lastVideoTime = -1;
  let lastRunMs = -Infinity;

  const self = {
    state: (opts.fakePose ? "waiting" : "loading") as SlamState,
    reason: "",
    lastMs: 0,
    calls: 0,
    resets: 0,
    lastPose: null as Pose | null,
    lastPoseMs: -Infinity,
    failures: 0,
    focalPx: 0,
    isTracking(now: number, lostMs: number) {
      // 1 フレームだけ取りこぼしても（state=lost）lostMs 以内なら追跡中とみなす。リセットは resets で呼び出し側が検知する
      return self.state !== "failed" && self.state !== "reset" && now - self.lastPoseMs <= lostMs;
    },
    update(now: number): Pose | null {
      if (self.state === "failed" || self.state === "off" || self.state === "loading" || initializing) return null;
      if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return null;
      if (video.currentTime === lastVideoTime) return null;
      if (now - lastRunMs < opts.intervalMs) return null;
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh) return null;
      const scale = Math.min(1, opts.widthPx / Math.max(vw, vh));
      const w = Math.round(vw * scale);
      const h = Math.round(vh * scale);
      if (!opts.fakePose && (!alva || alvaSize !== `${w}x${h}`)) {
        // 初回と、映像の縦横が変わった（端末の回転）とき。AlvaAR は画像の大きさを初期化時に固定する
        void initAlva(w, h);
        return null;
      }
      lastVideoTime = video.currentTime;
      lastRunMs = now;
      const t0 = performance.now();
      let raw: ArrayLike<number> | null = null;
      let status = 0;
      try {
        if (opts.fakePose) {
          raw = opts.fakePose();
          status = raw ? 1 : 0;
        } else {
          if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
          }
          ctx.drawImage(video, 0, 0, w, h);
          const image = ctx.getImageData(0, 0, w, h);
          const a = alva!;
          if (a.system && a.memImg && a.memCam) {
            a.memImg.write(image.data);
            status = a.system.findCameraPose(a.memImg.heap.byteOffset, a.memCam.ptr);
            // WASM のヒープへのビューなので、次の呼び出し（やメモリの拡張）で書き換わる前に複製する
            raw = status === 1 ? Array.from(a.memCam.read(16)) : null;
          } else {
            const p = a.findCameraPose(image);
            raw = p ? Array.from(p) : null;
            status = raw ? 1 : 0;
          }
        }
        self.calls++;
        self.failures = 0;
      } catch (e: unknown) {
        self.failures++;
        self.lastMs = performance.now() - t0;
        self.reason = e instanceof Error ? e.message : String(e);
        if (self.failures >= opts.maxFailures) {
          self.state = "failed";
          self.reason = `例外が ${self.failures} 回続いたので停止: ${self.reason}`;
          console.error(`[slam] ${self.reason}`);
        } else {
          self.state = "lost";
        }
        return null;
      }
      self.lastMs = performance.now() - t0;
      if (status === 2) {
        self.resets++;
        self.state = "reset";
        return null;
      }
      if (status === 3) {
        self.state = "init";
        return null;
      }
      if (!raw || status !== 1 || !Array.prototype.every.call(raw, Number.isFinite)) {
        self.state = self.lastPose ? "lost" : "init";
        return null;
      }
      const pose = alvaPoseToThree(raw);
      self.state = "tracking";
      self.lastPose = pose;
      self.lastPoseMs = now;
      return pose;
    },
  };

  async function initAlva(w: number, h: number) {
    if (!AlvaAR) return;
    initializing = true;
    try {
      const target = Math.max(w, h) / 2 / Math.tan((opts.camHFovDeg() * Math.PI) / 360);
      // getCameraIntrinsics の fx(=fy=min) は fov に対して単調減少なので二分探索
      const focalOf = (fov: number) => AlvaAR!.prototype.getCameraIntrinsics.call(null, w, h, fov).fx;
      let lo = 1;
      let hi = 179;
      for (let i = 0; i < 50; i++) {
        const mid = (lo + hi) / 2;
        if (focalOf(mid) > target) lo = mid;
        else hi = mid;
      }
      const fov = (lo + hi) / 2;
      const inst = await AlvaAR.Initialize(w, h, fov);
      if (alva) self.resets++; // 作り直した = 座標系が変わった
      alva = inst;
      alvaSize = `${w}x${h}`;
      self.focalPx = inst.intrinsics?.fx ?? focalOf(fov);
      self.state = "init";
      console.log(`[slam] AlvaAR initialized ${w}x${h} f=${self.focalPx.toFixed(1)}px (target ${target.toFixed(1)}px, fov arg ${fov.toFixed(2)})`);
    } catch (e: unknown) {
      self.state = "failed";
      self.reason = `初期化に失敗: ${e instanceof Error ? e.message : String(e)}`;
      console.error(`[slam] ${self.reason}`);
    } finally {
      initializing = false;
    }
  }

  if (!opts.fakePose) {
    // public/ のファイルは Vite の dev サーバーが「ソースから import するな」と拒否する（動的 import には ?import が付けられ 500 になる）。
    // import 式を Vite の書き換えから外すため Function 経由で呼ぶ（ブラウザがそのまま /vendor/alva/alva_ar.js を取りに行く）
    const importModule = new Function("url", "return import(url)") as (url: string) => Promise<{ AlvaAR?: AlvaClass }>;
    importModule(opts.moduleUrl)
      .then((mod: { AlvaAR?: AlvaClass }) => {
        if (!mod.AlvaAR) throw new Error("alva_ar.js に AlvaAR の export が無い");
        AlvaAR = mod.AlvaAR;
        self.state = "waiting";
      })
      .catch((e: unknown) => {
        self.state = "failed";
        self.reason = `読み込み失敗（npm run fetch:alva 済みか確認）: ${e instanceof Error ? e.message : String(e)}`;
        console.error(`[slam] ${self.reason}`);
      });
  }

  return self;
}
