// 08-8（PC カメラ + MediaPipe Pose で人を追う）用の対戦サーバー。
// メッセージ・検証・試合のルールは 08-3（アウトサイドイン）のサーバーと同じなので、server/splatoon-outside-in.ts のプラグインを
// オプション付きで**別パス**（SPLATOON_POSE_CAM_PATH）に登録するだけ（Room の状態も 08-3 とは別インスタンス。ログの接頭辞は "[splatoon-pose-cam]"）。
//   - 08-3 の track の id は「ゴーグルのマーカーの ID = プレイヤーの trackId」。08-8 のトラッカーは手を挙げた人物にプレイヤーを割り当て、
//     そのプレイヤーの trackId を載せて送るので、サーバーから見て違いは無い（splatoon-pose-cam-protocol.ts）
//   - checkTrackIdCollision: false — trackId はマーカーではないので、原点・追加マーカーの ID との衝突の検証は要らない
//   - dropMissing: true — トラッカーの track に含まれないプレイヤー（割当が外れた・要確認）は未測定に戻し、撃てなくする。
//     08-3 のマーカーの一時的な隠れと違い、08-8 で track に居ないのは「人物との対応が無効」なので、古い位置で撃たせない
import { splatoonOutsideInServer } from "./splatoon-outside-in.ts";
import { SPLATOON_POSE_CAM_PATH } from "../src/shared/splatoon-pose-cam-protocol.ts";

export function splatoonPoseCamServer() {
  return splatoonOutsideInServer({ path: SPLATOON_POSE_CAM_PATH, checkTrackIdCollision: false, dropMissing: true });
}
