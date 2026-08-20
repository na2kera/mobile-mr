// Phase 5: MediaPipe Tasks Vision の HandLandmarker を <video> に対して回す薄いラッパ。
// 段階1（既存ライブラリで作りきる）なので、MediaPipe をそのまま使う。
// ここで吸収しているのは次の3点だけ:
//  1. wasm をローカル配信する（自己署名 HTTPS + LAN の実機環境で CDN 依存を増やさない）
//  2. モデルの取得先フォールバック（ローカル → 公式 URL）
//  3. GPU デリゲートが初期化できない端末で CPU に落とす
import { FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";
import type { HandLandmarkerResult } from "@mediapipe/tasks-vision";
// wasm 本体とそのローダーを Vite のアセット（?url）として配信する。MediaPipe 標準の
// FilesetResolver.forVisionTasks(basePath) は「basePath/vision_wasm_internal.js」を
// 決め打ちで探すため、Vite がハッシュ付きで出力する build では使えない。
// WasmFileset（ローダーと wasm の URL の組）を自前で渡せば同じことができる。
// パスはパッケージの exports が公開しているサブパス（実体は wasm/ 配下）。
// SIMD 版のみ同梱する（iOS 16.4+ / Chrome 91+ は対応。非対応環境はエラーにする）
import wasmLoaderPath from "@mediapipe/tasks-vision/vision_wasm_internal.js?url";
import wasmBinaryPath from "@mediapipe/tasks-vision/vision_wasm_internal.wasm?url";

export type Delegate = "GPU" | "CPU";

export type HandTrackerOptions = {
  /** 同時に追跡する手の数（1 or 2） */
  numHands: number;
  /** "auto" は GPU → 失敗したら CPU */
  delegate: Delegate | "auto";
  /** モデル（hand_landmarker.task）の取得先候補。先頭から順に試す */
  modelUrls: string[];
  minHandDetectionConfidence: number;
  minHandPresenceConfidence: number;
  minTrackingConfidence: number;
  /**
   * 推論に渡す画像の長辺の上限 [px]。0 なら video をそのまま渡す。
   * モデルの入力は 192〜224px 程度なので、30〜60cm 先の手なら 640 で十分
   */
  inputMaxSide: number;
  /**
   * inputMaxSide が 0 のとき、CPU デリゲートにだけ適用する上限。CPU 経路は video を
   * フル解像度で 2D canvas に描いて getImageData で読むため、720p のままだと読み戻しが重い
   */
  inputMaxSideCpu: number;
  /** MediaPipe に使わせる canvas。未指定なら MediaPipe が OffscreenCanvas を作る */
  canvas?: HTMLCanvasElement;
  /** 取得済みのモデル。指定があれば modelUrls からの取得を省く（CPU での作り直し用） */
  modelBuffer?: ArrayBuffer;
};

export type HandTracker = {
  /** 実際に初期化できたデリゲート */
  readonly delegate: Delegate;
  /** 実際に読み込めたモデルの URL */
  readonly modelUrl: string;
  /** 読み込んだモデル本体（作り直すときに使い回す） */
  readonly modelBuffer: ArrayBuffer;
  /** 直近の推論の所要時間 [ms]（推論を走らせなかった呼び出しでは更新しない） */
  readonly lastMs: number;
  /** 直近の推論に渡した画像サイズ（"1280x720" 形式。HUD 用） */
  readonly lastInput: string;
  /**
   * video の新しいフレームに対して推論する。前回と同じフレーム（currentTime が同じ）や
   * まだフレームが来ていないときは null を返すので、呼び出し側は前回の結果を使い続ける
   */
  detect(video: HTMLVideoElement): HandLandmarkerResult | null;
  close(): void;
};

/**
 * @param onProgress どの段階まで進んだかを HUD に出すためのコールバック
 *   （実機では console が見えないので、wasm・モデル・デリゲートのどこで詰まったかをここで切り分ける）
 */
export async function createHandTracker(
  opts: HandTrackerOptions,
  onProgress: (step: string) => void,
): Promise<HandTracker> {
  if (!(await FilesetResolver.isSimdSupported())) {
    throw new Error(
      "WebAssembly SIMD 非対応のブラウザです（iOS 16.4+ / Chrome 91+ が必要）",
    );
  }
  onProgress("simd-ok");

  // モデルは自前で fetch して buffer で渡す。modelAssetPath で渡すと 404 の HTML を
  // モデルとして読もうとして分かりにくいエラーになり、フォールバックもできないため
  const { buffer, url: modelUrl } = opts.modelBuffer
    ? { buffer: opts.modelBuffer, url: "(reused)" }
    : await fetchFirst(opts.modelUrls, onProgress);

  const fileset = { wasmLoaderPath, wasmBinaryPath };
  const delegates: Delegate[] =
    opts.delegate === "auto" ? ["GPU", "CPU"] : [opts.delegate];
  let landmarker: HandLandmarker | null = null;
  let delegate: Delegate = delegates[0];
  const errors: string[] = [];
  for (const d of delegates) {
    onProgress(`init-${d.toLowerCase()}`);
    try {
      landmarker = await HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetBuffer: new Uint8Array(buffer), delegate: d },
        canvas: opts.canvas,
        runningMode: "VIDEO",
        numHands: opts.numHands,
        minHandDetectionConfidence: opts.minHandDetectionConfidence,
        minHandPresenceConfidence: opts.minHandPresenceConfidence,
        minTrackingConfidence: opts.minTrackingConfidence,
      });
      delegate = d;
      break;
    } catch (e: unknown) {
      errors.push(`${d}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (!landmarker) {
    throw new Error(`HandLandmarker を初期化できません: ${errors.join(" / ")}`);
  }

  const lm = landmarker;
  const maxSide =
    opts.inputMaxSide > 0
      ? opts.inputMaxSide
      : delegate === "CPU"
        ? opts.inputMaxSideCpu
        : 0;
  // 縮小用 canvas（必要になったときだけ作る）
  let scaled: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null = null;
  let lastVideoTime = -1;
  let lastTimestampMs = -1;
  const tracker = {
    delegate,
    modelUrl,
    modelBuffer: buffer,
    lastMs: 0,
    lastInput: "",
    detect(video: HTMLVideoElement): HandLandmarkerResult | null {
      if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return null;
      // iOS の回転中などサイズが 0 の瞬間は渡さない（MediaPipe 側で例外になる）
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh) return null;
      if (video.currentTime === lastVideoTime) return null;
      lastVideoTime = video.currentTime;
      // VIDEO モードのタイムスタンプは単調増加が必須（同値・逆行はエラー）。
      // performance.now() は単調だが、同じ ms 内に2回呼ばれ得るので +1 で保証する
      const ts = Math.max(performance.now(), lastTimestampMs + 1);
      lastTimestampMs = ts;
      const t0 = performance.now();
      let source: HTMLVideoElement | HTMLCanvasElement = video;
      const scale = maxSide > 0 ? Math.min(1, maxSide / Math.max(vw, vh)) : 1;
      if (scale < 1) {
        // 縦横比はそのままなので、正規化座標（0..1）はフル解像度のときと同じ意味になる
        const w = Math.round(vw * scale);
        const h = Math.round(vh * scale);
        if (!scaled) {
          const canvas = document.createElement("canvas");
          scaled = {
            canvas,
            // CPU デリゲートは縮小後に getImageData で読むので読み戻し前提の canvas にする。
            // GPU デリゲートはテクスチャとして取り込むので通常の canvas のまま
            ctx: canvas.getContext("2d", { willReadFrequently: delegate === "CPU" })!,
          };
        }
        if (scaled.canvas.width !== w || scaled.canvas.height !== h) {
          scaled.canvas.width = w;
          scaled.canvas.height = h;
        }
        scaled.ctx.drawImage(video, 0, 0, w, h);
        source = scaled.canvas;
      }
      // video の width 属性は 0 なので、映像の実サイズは videoWidth から取る
      tracker.lastInput =
        source === video ? `${vw}x${vh}` : `${source.width}x${source.height}`;
      const result = lm.detectForVideo(source, ts);
      tracker.lastMs = performance.now() - t0;
      return result;
    },
    close() {
      lm.close();
    },
  };
  return tracker;
}

/** 候補 URL を順に fetch して最初に取れたものを返す。全滅なら理由をまとめて投げる */
async function fetchFirst(
  urls: string[],
  onProgress: (step: string) => void,
): Promise<{ buffer: ArrayBuffer; url: string }> {
  const errors: string[] = [];
  for (const url of urls) {
    onProgress(`model-fetch ${shortUrl(url)}`);
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buffer = await res.arrayBuffer();
      // 7.8MB 前後のはず。開発サーバーが SPA フォールバックで index.html を返した場合等、
      // 極端に小さいものはモデルではないので弾く
      if (buffer.byteLength < 100_000) {
        throw new Error(`サイズが不正 (${buffer.byteLength} bytes)`);
      }
      onProgress(`model-ok ${shortUrl(url)} ${(buffer.byteLength / 1e6).toFixed(1)}MB`);
      return { buffer, url };
    } catch (e: unknown) {
      errors.push(
        `${shortUrl(url)}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  throw new Error(`モデルを取得できません: ${errors.join(" / ")}`);
}

function shortUrl(url: string): string {
  return url.startsWith("http") ? new URL(url).host : url;
}
