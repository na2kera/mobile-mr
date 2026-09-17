// 08-8（PC カメラ + MediaPipe Pose で人を追う。docs/space-stability-options.md §4 の 2b）の WebSocket プロトコル。
// メッセージは 08-3（アウトサイドイン）のプロトコルと**同じ**（splatoon-outside-in-protocol.ts をそのまま使う）で、違うのはパスだけ:
//   - track の id は 08-3 と同じ「プレイヤーの trackId（サーバーが入室順に割り当てる番号）」。08-8 ではゴーグルにマーカーを貼らず、
//     トラッカー（俯瞰画面）が「手を挙げた人物 → 入室順で次のプレイヤー」の対応を持ち、そのプレイヤーの trackId を載せて送る
//     （welcome / join の trackIds で番号を知っている）。サーバーから見ればマーカーの ID と区別が無いので、検証
//     （tracker 以外は送れない・範囲・レート・知らない ID は捨てる・有効なトラッカーは 1 台・未測定の発射の拒否）は 08-3 のサーバーのまま効く
//   - サーバーは server/splatoon-pose-cam.ts（08-3 の server/splatoon-outside-in.ts のプラグインをオプション付きでこのパスに登録する。
//     dropMissing で track に居ないプレイヤーは未測定に戻り撃てない）。
//     08-3 と Room を分けるため（同じ room 名でも混ざらない）に別パスにする
export * from "./splatoon-outside-in-protocol.ts";

export const SPLATOON_POSE_CAM_PATH = "/api/splatoon-pose-cam";
