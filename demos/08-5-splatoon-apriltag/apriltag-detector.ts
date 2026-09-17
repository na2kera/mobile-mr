// AprilTag（tag36h11）の WASM 検出器の境界モジュール。08 の marker-detector.ts（js-aruco2）と同じ
// MarkerDetector / MarkerObservation の形で返すので、marker-anchor-apriltag.ts は検出器の中身を知らない。
// 中身は arenaxr/apriltag-js-standalone の apriltag_wasm.js / .wasm（scripts/fetch-apriltag.mjs で public/vendor/apriltag/ に取得。
// ライセンスはそのスクリプトのコメントと README 参照）。同梱の apriltag.js（Comlink + Web Worker のラッパー）は unpkg から
// Comlink を読む前提で LAN のオフラインでは動かないので使わず、同じ cwrap 呼び出しをここに書いた（メインスレッドで同期実行。
// 08 と同じく markerIntervalMs で間引き、detW で縮小する）。
//
// WASM の読み込み: apriltag_wasm.js は emcc の MODULARIZE=1 でグローバル AprilTagWasm（Module を resolve する Promise を返す
// ファクトリ）を定義するクラシックスクリプト。ES module から import はできないので <script> を差し込んで待つ。
// .wasm の場所は locateFile で明示する（document.currentScript から自動で解決もするが、Vite の dev と build で base が
// 変わっても壊れないように）。読めなければ reject するので、呼び出し側（main.ts）は HUD に出して js-aruco2 に落とす
import * as THREE from "three";
import type { MarkerDetector, MarkerObservation } from "../../src/shared/marker-detector";
import { aprilPoseToMatrix, normalizedReprojectionError, sidePxOf } from "./apriltag-pose";

/** Emscripten の Module のうち使う部分 */
type AprilTagModule = {
  cwrap: (name: string, ret: string | null, args: string[]) => (...args: number[]) => number;
  getValue: (ptr: number, type: string) => number;
  HEAPU8: Uint8Array;
};
type AprilTagFactory = (opts: { locateFile?: (path: string) => string; print?: (s: string) => void; printErr?: (s: string) => void }) => Promise<AprilTagModule>;

/** apriltag_js.c の JSON（return_pose = 1 のとき。return_solutions = 0 でも asol は常に付くが使わない） */
type RawDetection = {
  id: number;
  corners: { x: number; y: number }[];
  center: { x: number; y: number };
  pose?: { size: number; R: number[][]; t: number[]; e: number };
};

/** apriltag_js.h の MAX_TAG_ID（set_tag_size で受け付ける ID の上限） */
const MAX_TAG_ID = 600;

let loading: Promise<AprilTagModule> | null = null;

/**
 * WASM を読み込む（1 回だけ。2 回目以降は同じ Promise）。
 * @param baseUrl apriltag_wasm.js / .wasm を置いた場所（末尾 / 付き。例: `${import.meta.env.BASE_URL}vendor/apriltag/`）
 * @param onStderr WASM の stderr（printErr）。検出器の警告を HUD に出したいとき
 */
export function loadAprilTagWasm(baseUrl: string, onStderr?: (s: string) => void): Promise<AprilTagModule> {
  if (loading) return loading;
  loading = new Promise<AprilTagModule>((resolve, reject) => {
    const w = window as unknown as { AprilTagWasm?: AprilTagFactory };
    const start = () => {
      const factory = w.AprilTagWasm;
      if (typeof factory !== "function") {
        reject(new Error("apriltag_wasm.js は読めたが AprilTagWasm が定義されていない（配布物が変わった?）"));
        return;
      }
      factory({
        locateFile: (path) => baseUrl + path,
        // apriltag_js.c は検出のたび printf("###Size:%f") を stdout に出す（改行なし）。console を汚さないよう捨てる
        print: () => {},
        printErr: (s) => {
          console.warn(`[apriltag] ${s}`);
          onStderr?.(s);
        },
      }).then(resolve, (e: unknown) => reject(e instanceof Error ? e : new Error(String(e))));
    };
    if (typeof w.AprilTagWasm === "function") {
      start();
      return;
    }
    const script = document.createElement("script");
    script.src = `${baseUrl}apriltag_wasm.js`;
    script.async = true;
    script.onload = start;
    script.onerror = () => reject(new Error(`${script.src} が読めない（npm run fetch:apriltag を実行したか確認）`));
    document.head.appendChild(script);
  });
  loading.catch(() => {
    // 失敗したら次回また試せるようにする（ページの再読み込みが普通だが、念のため）
    loading = null;
  });
  return loading;
}

export type AprilTagDetectorOptions = {
  /** 入力画像を 1/decimate に間引いてから四角形を探す（apriltag の quad_decimate。既定 2.0。1.0 で全画素。角は refine_edges で全解像度に戻す） */
  decimate: number;
  /** 分割前のガウスぼかし [px]（quad_sigma。既定 0） */
  sigma: number;
};

export type AprilTagDetector = MarkerDetector & {
  /** 直近の detect で WASM の atagjs_detect に掛かった時間 [ms]（グレースケール変換と JSON の解析を除く） */
  readonly lastWasmMs: number;
  /** 直近の detect で受け取った生の検出数（姿勢の検証で捨てたものも含む） */
  readonly lastRawCount: number;
};

/**
 * 検出器を作る（loadAprilTagWasm の Module を渡す）。detect() は 08 の MarkerDetector と同じ形。
 * @param markerSizeM マーカー（黒い正方形）の一辺の実寸 [m]。全 ID（0〜MAX_TAG_ID-1）に同じ実寸を設定する（08 と同じ「追加マーカーも同じ大きさ」）
 */
export function createAprilTagDetector(module: AprilTagModule, markerSizeM: number, opts: AprilTagDetectorOptions): AprilTagDetector {
  const init = module.cwrap("atagjs_init", "number", []);
  const setDetectorOptions = module.cwrap("atagjs_set_detector_options", "number", ["number", "number", "number", "number", "number", "number", "number"]);
  const setPoseInfo = module.cwrap("atagjs_set_pose_info", "number", ["number", "number", "number", "number"]);
  const setImgBuffer = module.cwrap("atagjs_set_img_buffer", "number", ["number", "number", "number"]);
  const setTagSize = module.cwrap("atagjs_set_tag_size", null, ["number", "number"]);
  const detectRaw = module.cwrap("atagjs_detect", "number", []);
  if (init() !== 0) throw new Error("atagjs_init が失敗");
  // decimate, sigma, nthreads(効かない), refine_edges, max_detections(0 = 全部), return_pose, return_solutions
  setDetectorOptions(opts.decimate, opts.sigma, 1, 1, 0, 1, 0);
  for (let id = 0; id < MAX_TAG_ID; id++) setTagSize(id, markerSizeM);

  let poseKey = "";
  let gray: Uint8Array = new Uint8Array(0);
  const decoder = new TextDecoder();
  const self = {
    lastWasmMs: 0,
    lastRawCount: 0,
    detect(image: ImageData, focalLengthPx: number): MarkerObservation[] {
      const w = image.width;
      const h = image.height;
      const cx = w / 2;
      const cy = h / 2;
      // 内部パラメータは検出画像の大きさと焦点距離が変わったときだけ設定し直す（fx = fy、主点 = 画像の中心。08 と同じ仮定）
      const key = `${w}x${h}@${focalLengthPx}`;
      if (key !== poseKey) {
        setPoseInfo(focalLengthPx, focalLengthPx, cx, cy);
        poseKey = key;
      }
      // RGBA → グレースケール（apriltag は 8bit 1 チャンネル）。ITU-R BT.601 の重みは掛けず単純平均（同梱の例と同じ。合成のマーカーは白黒なので差は無い）
      if (gray.length !== w * h) gray = new Uint8Array(w * h);
      const src = image.data;
      for (let i = 0, j = 0; j < gray.length; i += 4, j++) gray[j] = (src[i] + src[i + 1] + src[i + 2]) / 3;
      const buf = setImgBuffer(w, h, w);
      // calloc に失敗すると NULL（0）が返る。そのまま HEAPU8.set すると例外にならずヒープ先頭を上書きするので、例外にして
      // marker-anchor-apriltag.ts の「失敗したフレームはロスト扱い・30 回で js-aruco2」の経路に乗せる（Fable レビューの指摘）
      if (!buf) throw new Error("atagjs_set_img_buffer が NULL を返した（WASM のメモリ確保に失敗）");
      // ALLOW_MEMORY_GROWTH なので HEAPU8 は毎回取り直す（成長すると別の ArrayBuffer になる）
      module.HEAPU8.set(gray, buf);
      const t0 = performance.now();
      const ptr = detectRaw();
      self.lastWasmMs = performance.now() - t0;
      // t_str_json { size_t len; char *str; size_t alloc_size; }（wasm32 なので各 4 バイト）
      const len = module.getValue(ptr, "i32");
      if (len === 0) {
        self.lastRawCount = 0;
        return [];
      }
      const strPtr = module.getValue(ptr + 4, "i32");
      const json = decoder.decode(module.HEAPU8.subarray(strPtr, strPtr + len));
      let raw: RawDetection[] | { result: string };
      try {
        raw = JSON.parse(json);
      } catch {
        console.warn(`[apriltag] JSON を解析できない: ${json.slice(0, 80)}`);
        self.lastRawCount = 0;
        return [];
      }
      if (!Array.isArray(raw)) {
        console.warn(`[apriltag] ${raw.result}`);
        self.lastRawCount = 0;
        return [];
      }
      self.lastRawCount = raw.length;
      const observations: MarkerObservation[] = [];
      for (const d of raw) {
        if (!d.pose || !Array.isArray(d.corners) || d.corners.length !== 4) continue;
        const { R, t } = d.pose;
        if (R.length !== 3 || !R.every((c) => c.length === 3 && c.every(Number.isFinite)) || t.length !== 3 || !t.every(Number.isFinite)) continue;
        const elements = aprilPoseToMatrix(R, t);
        // 08 と同じ正規化再投影誤差（apriltag の e は物体空間の誤差 [m^2] で流儀が違うので、4 隅を投影し直して測る）
        const error = normalizedReprojectionError(elements, d.corners, markerSizeM, focalLengthPx, cx, cy);
        if (!Number.isFinite(error)) continue;
        observations.push({
          id: d.id,
          corners: d.corners,
          matrix: new THREE.Matrix4().fromArray(elements),
          error,
          sidePx: sidePxOf(d.corners),
        });
      }
      return observations;
    },
  };
  return self;
}
