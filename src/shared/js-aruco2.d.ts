// js-aruco2 は型定義を同梱していないため、使用する範囲だけ自前で宣言する
// （three の @types と同じ痛点。PAIN_POINTS.md 参照）。
// js-aruco2 を剥がすときはこのファイルごと削除する。
declare module "js-aruco2" {
  export interface ArucoMarker {
    id: number;
    corners: { x: number; y: number }[];
    hammingDistance: number;
  }
  export interface ArucoDetector {
    detect(image: ImageData): ArucoMarker[];
  }
  // CJS パッケージ（top-level this への代入）。Vite(rolldown) の CJS 変換は
  // これを named export として公開する（default は生成されない）
  export const AR: {
    Detector: new (config?: {
      dictionaryName?: string;
      maxHammingDistance?: number;
    }) => ArucoDetector;
  };
}

declare module "js-aruco2/src/posit1.js" {
  export interface PositPose {
    bestError: number;
    /** 3x3 回転行列（行優先） */
    bestRotation: number[][];
    /** [x, y, z]。単位は Posit コンストラクタの modelSize と同じ */
    bestTranslation: number[];
    alternativeError: number;
    alternativeRotation: number[][];
    alternativeTranslation: number[];
  }
  export interface Posit {
    pose(corners: { x: number; y: number }[]): PositPose;
  }
  export const POS: {
    Posit: new (modelSize: number, focalLength: number) => Posit;
  };
}
