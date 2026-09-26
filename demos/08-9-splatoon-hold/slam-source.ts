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
// - 間隔: 次の実行は処理の終了時刻から intervalMs 後。直近の処理時間が intervalMs を超えたら間隔を処理時間の 2 倍に延ばす
//   （処理の遅い端末でメインスレッドを連続占有しない。HUD の every NNms = effectiveIntervalMs）
// - 端末の回転（入力画像の縦横が変わる）: AlvaAR は画像の大きさを初期化時に固定し、作り直すと WASM のメモリ（約 256MB）を
//   新しく確保する（古いものは解放されない）ので、作り直さずに止める（state=stopped、reason=rotated）。呼び出し側はマーカーのみに落ちる
// - WASM のメモリ: SharedMemory の heap（型付き配列のビュー）はメモリの拡張で切れる（detached）ので使わず、
//   毎回 wasm.module.HEAPU8 / HEAPF32（Emscripten が拡張時に取り直す）から ptr の位置を読み書きする
// - フェイク（?fakeslam=1）: AlvaAR を読まず、fakePose() が返す AlvaAR 形式の 16 要素を同じ経路で変換する
import { alvaPoseToThree } from "./slam-fusion";
import type { Pose } from "./slam-fusion";

type AlvaIntrinsics = { fx: number; fy: number };
type AlvaInstance = {
  findCameraPose(frame: ImageData): Float32Array | null;
  intrinsics?: AlvaIntrinsics;
  system?: { findCameraPose(imagePtr: number, posePtr: number): number };
  memImg?: { ptr: number };
  memCam?: { ptr: number };
  wasm?: { module?: { HEAPU8?: Uint8Array; HEAPF32?: Float32Array } };
};
type AlvaClass = {
  Initialize(width: number, height: number, fov?: number): Promise<AlvaInstance>;
  prototype: { getCameraIntrinsics(width: number, height: number, fov?: number): AlvaIntrinsics };
};

export type SlamState = "off" | "loading" | "waiting" | "init" | "tracking" | "lost" | "reset" | "failed" | "stopped";

export type SlamSourceOptions = {
  video: HTMLVideoElement;
  /** 入力画像の長辺 [px] */
  widthPx: number;
  /** 処理の最小間隔 [ms]。処理の終了時刻から数える（0 = カメラの新フレームごと。ただし処理時間が超えれば延ばす） */
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
  /** failed / off / stopped の理由 */
  readonly reason: string;
  /** 直近の処理時間 [ms]（縮小 + getImageData + findCameraPose） */
  readonly lastMs: number;
  /** 実効の間隔 [ms]（intervalMs、処理時間が超えたらその 2 倍） */
  readonly effectiveIntervalMs: number;
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
  /** 次に処理してよい時刻（performance.now 基準。直前の処理の終了時刻 + 実効の間隔） */
  let nextRunMs = -Infinity;

  const self = {
    state: (opts.fakePose ? "waiting" : "loading") as SlamState,
    reason: "",
    lastMs: 0,
    effectiveIntervalMs: opts.intervalMs,
    calls: 0,
    resets: 0,
    lastPose: null as Pose | null,
    lastPoseMs: -Infinity,
    failures: 0,
    focalPx: 0,
    isTracking(now: number, lostMs: number) {
      // 1 フレームだけ取りこぼしても（state=lost）lostMs 以内なら追跡中とみなす。リセットは resets で呼び出し側が検知する
      return self.state !== "failed" && self.state !== "stopped" && self.state !== "reset" && now - self.lastPoseMs <= lostMs;
    },
    update(now: number): Pose | null {
      if (self.state === "failed" || self.state === "stopped" || self.state === "off" || self.state === "loading" || initializing) return null;
      if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return null;
      if (video.currentTime === lastVideoTime) return null;
      if (now < nextRunMs) return null;
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh) return null;
      const scale = Math.min(1, opts.widthPx / Math.max(vw, vh));
      const w = Math.round(vw * scale);
      const h = Math.round(vh * scale);
      if (!opts.fakePose && !alva) {
        // 初回。AlvaAR は画像の大きさを初期化時に固定する
        void initAlva(w, h);
        return null;
      }
      if (!opts.fakePose && alvaSize !== `${w}x${h}`) {
        // 映像の縦横が変わった（端末の回転）。作り直すと WASM のメモリを新しく確保するので止める（ヘッダのコメント参照）
        self.state = "stopped";
        self.reason = `rotated: 向きが変わったので SLAM を止めた。再読み込みで再開（${alvaSize} → ${w}x${h}）`;
        console.warn(`[slam] ${self.reason}`);
        return null;
      }
      lastVideoTime = video.currentTime;
      const t0 = performance.now();
      /** 処理の終了時刻から次の実行を決める（例外のフレームも同じ） */
      const schedule = () => {
        const end = performance.now();
        self.lastMs = end - t0;
        self.effectiveIntervalMs = self.lastMs > opts.intervalMs ? 2 * self.lastMs : opts.intervalMs;
        nextRunMs = end + self.effectiveIntervalMs;
      };
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
          const mod = a.wasm?.module;
          if (a.system && a.memImg && a.memCam && mod?.HEAPU8 && mod.HEAPF32) {
            // 毎回いまのヒープから書く（メモリの拡張で古いビューは切れる。ヘッダのコメント参照）
            mod.HEAPU8.set(image.data, a.memImg.ptr);
            status = a.system.findCameraPose(a.memImg.ptr, a.memCam.ptr);
            // findCameraPose の中でメモリが拡張されうるので、読む前にもう一度取り直し、次の呼び出しで書き換わる前に複製する
            const f32 = a.wasm!.module!.HEAPF32!;
            raw = status === 1 ? Array.from(f32.subarray(a.memCam.ptr >> 2, (a.memCam.ptr >> 2) + 16)) : null;
          } else {
            const p = a.findCameraPose(image);
            raw = p ? Array.from(p) : null;
            status = raw ? 1 : 0;
          }
        }
        self.calls++;
        self.failures = 0;
      } catch (e: unknown) {
        schedule();
        self.failures++;
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
      schedule();
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
    // public/ のファイルは Vite の dev サーバーが「ソースから import するな」と拒否する（dev では変数の動的 import に
    // __vite__injectQuery で ?import が付けられ 500 になる）。injectQuery は "/" か "." で始まる URL だけを書き換えるので、
    // 絶対 URL（https://…/vendor/alva/alva_ar.js）にして @vite-ignore で渡す（CSP で eval を禁じても動く。new Function は使わない）
    let url: string;
    try {
      url = new URL(opts.moduleUrl, location.href).href;
    } catch {
      url = opts.moduleUrl;
    }
    import(/* @vite-ignore */ url)
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
