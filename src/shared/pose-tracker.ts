// Phase 9: MediaPipe Tasks Vision の PoseLandmarker（全身 33 点）を <video> に対して回す薄いラッパ。
// 背面カメラに映る「相手の体」を検出するために使う（自分の体はゴーグル装着時に映らない。
// CONCEPT.md Phase 5 の注記参照）。共通部分は landmarker-tracker.ts、ここは姿勢固有のオプションだけ
import { PoseLandmarker } from "@mediapipe/tasks-vision";
import type { PoseLandmarkerResult } from "@mediapipe/tasks-vision";
import { createLandmarkerTracker } from "./landmarker-tracker.ts";
import type { Delegate, LandmarkerTracker } from "./landmarker-tracker.ts";

export type { Delegate };

export type PoseTrackerOptions = {
  /** 同時に検出する人数の上限（1〜4。増やすほど重い） */
  numPoses: number;
  delegate: Delegate | "auto";
  /** モデル（pose_landmarker_*.task）の取得先候補。先頭から順に試す */
  modelUrls: string[];
  minPoseDetectionConfidence: number;
  minPosePresenceConfidence: number;
  minTrackingConfidence: number;
  /** 推論に渡す画像の長辺の上限 [px]。0 なら video をそのまま。全身は画面の大部分を占めるので 640 で十分 */
  inputMaxSide: number;
  inputMaxSideCpu: number;
  canvas?: HTMLCanvasElement;
  modelBuffer?: ArrayBuffer;
};

export type PoseTracker = LandmarkerTracker<PoseLandmarkerResult>;

export function createPoseTracker(
  opts: PoseTrackerOptions,
  onProgress: (step: string) => void,
): Promise<PoseTracker> {
  return createLandmarkerTracker<PoseLandmarkerResult>(
    {
      label: "PoseLandmarker",
      delegate: opts.delegate,
      modelUrls: opts.modelUrls,
      inputMaxSide: opts.inputMaxSide,
      inputMaxSideCpu: opts.inputMaxSideCpu,
      canvas: opts.canvas,
      modelBuffer: opts.modelBuffer,
      create: (fileset, baseOptions, canvas) =>
        PoseLandmarker.createFromOptions(fileset, {
          baseOptions,
          canvas,
          runningMode: "VIDEO",
          numPoses: opts.numPoses,
          minPoseDetectionConfidence: opts.minPoseDetectionConfidence,
          minPosePresenceConfidence: opts.minPosePresenceConfidence,
          minTrackingConfidence: opts.minTrackingConfidence,
          // セグメンテーションマスクは使わない（毎フレーム GPU → CPU の転送が増える）
          outputSegmentationMasks: false,
        }),
    },
    onProgress,
  );
}
