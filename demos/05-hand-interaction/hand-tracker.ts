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
};

export type HandTracker = {
  /** 実際に初期化できたデリゲート */
  readonly delegate: Delegate;
  /** 実際に読み込めたモデルの URL */
  readonly modelUrl: string;
  /** 直近の推論の所要時間 [ms]（推論を走らせなかった呼び出しでは更新しない） */
  readonly lastMs: number;
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
  const { buffer, url: modelUrl } = await fetchFirst(opts.modelUrls, onProgress);

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
  let lastVideoTime = -1;
  let lastTimestampMs = -1;
  const tracker = {
    delegate,
    modelUrl,
    lastMs: 0,
    detect(video: HTMLVideoElement): HandLandmarkerResult | null {
      if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return null;
      if (video.currentTime === lastVideoTime) return null;
      lastVideoTime = video.currentTime;
      // VIDEO モードのタイムスタンプは単調増加が必須（同値・逆行はエラー）。
      // performance.now() は単調だが、同じ ms 内に2回呼ばれ得るので +1 で保証する
      const ts = Math.max(performance.now(), lastTimestampMs + 1);
      lastTimestampMs = ts;
      const t0 = performance.now();
      const result = lm.detectForVideo(video, ts);
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
