// Phase 4 (04-shared-room) の WebSocket プロトコル定義。
// クライアント（demos/04-shared-room/room-client.ts）とサーバー
// （server/shared-room.ts、Vite dev サーバーに同居するプラグイン）の両方から
// import して、メッセージの型と経路の食い違いをコンパイル時に検出する。

/** WebSocket のアップグレード先パス。Vite 自身の HMR WebSocket と衝突しない値にする */
export const SHARED_ROOM_PATH = "/api/shared-room";

/**
 * プロトコルバージョン。メッセージや座標系の意味を変えたら上げる。
 * 接続クエリで送り、サーバーと不一致なら入室を拒否する（古いタブと新しいタブが
 * 同じ Room で黙って噛み合わないのを防ぐ）
 */
export const PROTOCOL_VERSION = 1;

/**
 * Room の空間設定。共通座標系はこの設定が全員一致して初めて成立する
 * （markerMm が違うと POSIT の並進スケールが変わり、通信が正常でも位置が合わない。
 * markerId が違うとそもそも別のマーカーを原点にしてしまう）。
 * 接続クエリで送り、Room の最初の参加者の値と不一致なら入室を拒否する。
 * camFov は端末固有のキャリブレーション値なので一致条件に含めない
 */
export type SpaceConfig = {
  /** World Origin にするマーカー ID（整数 0〜999） */
  markerId: number;
  /** マーカー（黒い正方形）の一辺の実寸 [mm]（0 より大きく 5000 以下） */
  markerMm: number;
};

/**
 * Room ID の許容形式。デモページが「?room=好きな名前」と案内しているため
 * 日本語などの Unicode 文字も許容する（URL 上は percent-encoding され、
 * URLSearchParams がデコードして戻す）。空白・記号は URL とログの取り回し上除外
 * （コードレビュー指摘: ASCII 限定だと日本語 room 名が黙って既定 room に合流し、
 * 無関係なペア同士が同じ部屋に混ざる）
 */
export const ROOM_ID_PATTERN = /^[\p{L}\p{N}_-]{1,32}$/u;

/**
 * マーカー座標系（World Origin マーカー基準: X=マーカー右 / Y=マーカー上 /
 * +Z=面から視点側、単位 m）での自分のカメラ姿勢。
 * 全端末が同じマーカーを原点にするので、これをそのまま交換すれば共通座標系になる
 */
export type PoseData = {
  pos: [number, number, number];
  quat: [number, number, number, number];
  /**
   * いまマーカーが視界にあり姿勢が現実に追従しているか。
   * false はロスト中（3DoF の限界で位置が古い）を意味し、受信側は表示を落とす
   */
  tracking: boolean;
};

/** クライアント → サーバー。現状 pose のみ（サーバーが送信元 id を付けて中継する） */
export type ClientMessage = { type: "pose" } & PoseData;

/** サーバー → クライアント */
export type ServerMessage =
  /** 入室完了。自分の id と、その時点で同室にいる相手の id 一覧 */
  | { type: "welcome"; id: string; peers: string[] }
  | { type: "join"; id: string }
  | { type: "leave"; id: string }
  | ({ type: "pose"; id: string } & PoseData)
  /**
   * 入室拒否（バージョン不一致・空間設定不一致など）。この直後に接続は閉じられる。
   * 再接続しても同じ結果になるので、受信側は再接続ループを止めて理由を表示する
   */
  | { type: "error"; reason: string };
