// Phase 5: MediaPipe Tasks Vision の HandLandmarker を <video> に対して回す薄いラッパ。
// wasm の配信・モデルの取得フォールバック・GPU → CPU の切り替え・フレームの間引きと縮小は
// landmarker-tracker.ts（Phase 9 で PoseLandmarker と共通化）にあり、ここは手固有のオプションだけ
import { HandLandmarker } from "@mediapipe/tasks-vision";
import type { HandLandmarkerResult } from "@mediapipe/tasks-vision";
import { createLandmarkerTracker } from "./landmarker-tracker.ts";
import type { Delegate, LandmarkerTracker } from "./landmarker-tracker.ts";

export type { Delegate };

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
  /** inputMaxSide が 0 のとき、CPU デリゲートにだけ適用する上限（landmarker-tracker.ts 参照） */
  inputMaxSideCpu: number;
  /** MediaPipe に使わせる canvas。未指定なら MediaPipe が OffscreenCanvas を作る */
  canvas?: HTMLCanvasElement;
  /** 取得済みのモデル。指定があれば modelUrls からの取得を省く（CPU での作り直し用） */
  modelBuffer?: ArrayBuffer;
};

export type HandTracker = LandmarkerTracker<HandLandmarkerResult>;

/**
 * @param onProgress どの段階まで進んだかを HUD に出すためのコールバック
 *   （実機では console が見えないので、wasm・モデル・デリゲートのどこで詰まったかをここで切り分ける）
 */
export function createHandTracker(
  opts: HandTrackerOptions,
  onProgress: (step: string) => void,
): Promise<HandTracker> {
  return createLandmarkerTracker<HandLandmarkerResult>(
    {
      label: "HandLandmarker",
      delegate: opts.delegate,
      modelUrls: opts.modelUrls,
      inputMaxSide: opts.inputMaxSide,
      inputMaxSideCpu: opts.inputMaxSideCpu,
      canvas: opts.canvas,
      modelBuffer: opts.modelBuffer,
      create: (fileset, baseOptions, canvas) =>
        HandLandmarker.createFromOptions(fileset, {
          baseOptions,
          canvas,
          runningMode: "VIDEO",
          numHands: opts.numHands,
          minHandDetectionConfidence: opts.minHandDetectionConfidence,
          minHandPresenceConfidence: opts.minHandPresenceConfidence,
          minTrackingConfidence: opts.minTrackingConfidence,
        }),
    },
    onProgress,
  );
}
