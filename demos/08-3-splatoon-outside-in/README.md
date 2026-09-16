# 08-3. MR Splatoon（アウトサイドイン）

`demos/08-splatoon/`（MR スプラトゥーン）と**同じ仕様**のスプラトゥーンを、「位置の取り方（自分のカメラの姿勢を field 座標系でどう決めるか）」だけ変えた比較用デモ。
背景と候補一覧は [docs/space-stability-options.md](../../docs/space-stability-options.md) §4 の **2a「アウトサイドイン（PC の Web カメラでゴーグルのマーカーを追う）」**。
08 は一切触っていない（丸ごとコピーして差分を作った）。

## 方式

```text
   [PC + Web カメラ]（部屋に固定。俯瞰画面 overview.html の「トラッカー」）
        │ 各ゴーグル前面のマーカー（ID = 入室順に 10, 11, …）を検出 → 部屋（field）座標系での位置 + ヨー + 品質
        ▼  track
   サーバー（server/splatoon-outside-in.ts）──tracked──▶ 各スマホ（位置はここから受け取り、回転はジャイロ）
        └ プレイヤーの pose の pos もトラッカーの測定値で上書きして配る（発射位置の検証も測定値で）
```

- **スマホ**（`main.ts`）: マーカーを検出しない（`createMarkerAnchor` を使わない）。アンカー（field → ワールド）は「Y 回転 φ + 並進」だけ:
  φ = ワールド（ジャイロ）でのカメラのヨー − トラッカーのヨー、並進 = カメラ位置 − R_y(φ)・自分の位置（`src/shared/outside-in-track.ts` の `anchorPose`）。
  ワールドの上 = ジャイロの重力の上 = field の Y なので常に水平（08 の `gravityAlign` に相当することを常に行う）。
  φ は最初の観測でスナップし、以後は**品質の高い観測（正面を向いてマーカーが大きく映った）のときだけ緩やかに寄せて**ジャイロのヨーのドリフトを消す。
  位置は LAN の遅延ぶん遅れて届くので前回値から lerp し、見失った間は最後の位置を保持して HUD に `tracked (0.8s ago)` を出す。
  スマホのカメラは手の検出とパススルーだけに使う
- **トラッカー**（`tracker.ts`。俯瞰画面の「トラッカー」の枠）: `getUserMedia` で Web カメラを開き、既存の `src/shared/marker-detector.ts`（js-aruco2）で検出。
  **原点合わせ**は「配置が分かっているマーカー（正面の壁の原点 ID 0、または俯瞰画面の「追加マーカーの配置」に入れた床などのマーカー）を同じカメラで見て『原点を確定』」
  （直近 10 サンプルの平均。確定後は原点マーカーが隠れてもよい。カメラを動かしたら「原点を解除」→ 確定し直す）。
  ゴーグルのマーカーからは**位置とヨーだけ**採る（1 枚のマーカーの傾きは信用しない。issue #54）。
  原点用（`?markerMm=` 150mm）とゴーグル用（`?trackMarkerMm=` 60mm）で実寸が違うが、検出器は 1 つ（POSIT の並進は実寸に比例するので、ゴーグルの並進だけ比で直す）
- **サーバー**（`server/splatoon-outside-in.ts`、プロトコル `src/shared/splatoon-outside-in-protocol.ts` v1。08 の `server/splatoon.ts` は触らない）:
  役割 `player` / `overview` / `tracker`（`?role=tracker`）。プレイヤーの入室順にマーカー ID（`TRACK_ID_FIRST` = 10 から空いている番号）を割り当てて `welcome.trackId` / `join.trackId` で伝える。
  `track`（tracker → server。`{ locked, players: [{ id, pos, yaw, quality }] }`）をマーカー ID → プレイヤーに引き当てて `tracked` で全員に配る。
  `pose` の `pos` はトラッカーの直近の測定値（2 秒以内）で上書きして配り、発射位置の検証（頭から 1.2m 以内）もその値で行う。
  妥当性検証（値の範囲・レート制限 40 回/s）は 08 に倣う。試合のルール（`splatoon-game.ts`）はそのまま
- **俯瞰画面**（`overview.ts`）: 08 のコピーに「トラッカー」の枠（カメラを開く / 原点を確定 / プレビュー）を足したもの。
  トラッカーは 2 本目の WebSocket（`?role=tracker`）で送る。一覧の「位置合わせ」は 08 の「マーカー n」の代わりに「トラッカー ID n q=品質 / 見失い」

## 08 との差分（ファイル単位）

| ファイル | 08 との違い |
| --- | --- |
| `main.ts` | 「アンカー」の節・`startCameraAndMarker`（→ `startCamera`）・`sendPoseIfDue`・ループ・HUD の `marker=`（→ `track=`）・案内文を差し替え。マーカー検出（`createMarkerAnchor`）とフェイクカメラのマーカー投影（`fakeWorld` / `worldUp`）を削除。`onTracked` / `updateAnchor` / `trackInfo` を追加。`window.__outsideIn`（ヘッドレス確認用） |
| `overview.ts` / `overview.html` | トラッカーの枠と 2 本目の接続、一覧の「位置合わせ」の表記、HUD に `peerTrack=` `tracker=` `local=` |
| `tracker.ts` | 新規（Web カメラ → 検出 → 原点合わせ → field 座標系の位置とヨー。フェイクカメラ込み） |
| `game-client.ts` | 新しいプロトコル（パス・バージョン・役割 tracker・`sendTrack` / `onTracked`・welcome / join の trackId） |
| `markers.ts` / `markers.html` | 原点 + 床 + ゴーグル（ID 10〜。`?goggleMm=` で小さく） |
| `index.html` | 説明と URL パラメータの案内 |
| `ink-*.ts` `splat-sound.ts` `fake-splat-hand.ts` | 08 のまま |
| `src/shared/splatoon-outside-in-protocol.ts` | 新規（08 のプロトコルを import して拡張） |
| `src/shared/outside-in-track.ts` | 新規（three.js に依存しない数学。Node テスト対象） |
| `server/splatoon-outside-in.ts` | 新規（08 のサーバーのコピー + tracker / track / tracked / trackId / pose の上書き） |

`src/shared/` の既存ファイルは変更していない。

## URL パラメータ

08 と同名・同義のもの: `fov` `eyeSep` `camZoom` `camRes` `markerMm`（原点マーカー。room 設定）`markerId` `hands` `handScale` `handDetW` `handSmooth` `handLostMs` `room` `name` `sendHz` `peerSmooth` `gravity` `matchSec` `waitSec` `surfacePx` `sound` `tank*` `fakecam`（チェッカーボードだけ）`fakehands` `fakeOpenSec` 等 `autostart`。

08 にあってこのデモに無いもの（位置合わせはトラッカー側で行い、常に水平なので）: `detW` `smooth` `markerIntervalMs` `lostMs` `maxPoseError` `gravityAlign` `fakeMarkers` `fakeCamPos` `fakeYaw` `fakePitch` `fakeShift*` `fakeMarkerPx` `fakeTilt` `fakeHideOrigin`。

このデモ固有:

| 画面 | パラメータ | 意味 |
| --- | --- | --- |
| スマホ | `trackSmooth=0.3` | 届いた位置へ前回値から寄せる係数（1 フレームあたり） |
| スマホ | `trackLostMs=2000` | 観測がこれより古ければ見失い（最後の位置を保持） |
| スマホ | `yawQuality=0.5` | ヨーの補正に使う観測の品質の下限 |
| スマホ | `yawSmooth=0.1` | ヨーの補正の速さ（観測 1 回あたり角度差のこの割合） |
| 俯瞰 | `tracker=1` | 入室したらカメラを自動で開く（ヘッドレス確認用） |
| 俯瞰 | `trackMarkerMm=60` | ゴーグルのマーカーの一辺 [mm] |
| 俯瞰 | `camFov=68` | Web カメラの水平 FOV [deg]（08 のスマホ側と同名・同義。距離が定数倍ずれるので実測して合わせる） |
| 俯瞰 | `trackDetW=1280` `trackIntervalMs=66` `maxPoseError=0.5` | 検出画像の長辺・検出間隔・誤差の上限 |
| 俯瞰 | `trackEyeBackM=0` | マーカーの中心からスマホのカメラまでの距離 [m] |
| 俯瞰 | `trackQualityPx=60` | 品質が 1 になる画面上の辺長 [px] |
| 俯瞰 | `trackCamRes=1280x720` `trackCam=<ラベルの一部>` | カメラの解像度と選択 |
| 俯瞰 | `trackLockSamples=10` | 「原点を確定」で平均する直近のサンプル数 |
| 俯瞰 | `fakecam=1` `fakePlayers=10:x,y,z,yaw;11:…` `fakeTrackCam=x,y,z,yaw,pitch` | トラッカーのフェイクカメラ（field 座標系にゴーグルを置いてピンホール投影。`window.__fakeTrack.hidden` で隠せる） |
| 印刷 | `goggleMm=60` `players=4` | ゴーグルのマーカーの大きさと枚数 |

## PC で確認する手順

```sh
export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
npm run test:outside-in    # Node: outside-in-track.ts の数学 + サーバー（Vite を起動して叩く）
npm run check:outside-in   # ヘッドレス Chrome: スマホ 2 + 俯瞰 1 + トラッカー 1
```

手で見るなら `npm run dev` のあと:

1. 俯瞰画面 `overview.html?room=x&tracker=1&fakecam=1&fakePlayers=10:-0.5,0,1.5,0;11:0.5,0,1.5,15` を開く（フェイクカメラに床のマーカー ID 1 とゴーグル 10 / 11 が映る）
2. 「追加マーカーの配置」で床（ID 1、Z = 1.25）を使う → 反映 → トラッカーの枠に「原点マーカーが見えています」→ 「原点を確定」
3. スマホ画面 `?room=x&camZoom=1&fakecam=1&autostart=1&fakehands=1&name=A` を 2 ウィンドウ開く（入室順に ID 10, 11 が割り当たる）→ HUD の `track=id=10 …` と `self=(-0.50,0.00,1.50)`、相手が右 1m に見え、連射が受理される

ヘッドレス（`scripts/headless-08-3-outside-in.mjs`）が見ていること: トラッカー待ち → 原点未確定 → 位置待ち の順に案内が変わり撃てない / 床のマーカーで原点を確定 / 両方の位置（5cm 以内）とヨー（2° 以内）が届き、自分の正面を field に直すとトラッカーのヨーと一致（φ が効く）/ 相手が正しい相対位置（5cm 以内）に見える / 発射が着弾して得点 / 俯瞰画面の一覧が「トラッカー ID 10 / 11」/ ゴーグルを隠すと最後の位置を保持して `tracked (3.0s ago)` を出し撃ち続けられ、再び見えれば復帰 / 対戦開始 → 終了 → 結果を閉じる。

## 実機で確認する項目（**iPhone 実機は未確認**）

- ゴーグルの前面に ID 10（1 人目）/ 11（2 人目）のマーカー（`markers.html?goggleMm=60`。60〜80mm）を「上」を天井に向けて貼り、スマホのカメラの穴を塞がないこと
- PC の Web カメラを部屋に固定（壁側から部屋を向けると正面を向いたゴーグルが大きく映る）。`?camFov=` は Web カメラの実測値に（既定 68°。距離が定数倍ずれる）
- 原点合わせ: 床に ID 1 を置いて原点（正面の壁のマーカー）からの位置を俯瞰画面に入れ、カメラに映して「原点を確定」。スマホ側で壁のマーカーの枠（青）が実物に重なるか（ずれていれば原点合わせの誤差。近く・大きく映して確定し直す）
- 横を向いてもコートが動かないか（要件 1）。相手の頭の表示が実際の相手の位置に重なるか、相手のインクが相手の手元から出るか（要件 2）
- 歩いたときの追従（LAN の遅延 + `trackSmooth`）。他の人に隠れたときの保持と復帰（HUD の `tracked (x.xs ago)`）
- ヨーの補正: 横を向いて戻ったとき、`Δyaw=` が小さく（ジャイロのドリフトが少なければ 0 付近）コートが回らないか。`?yawQuality=` / `?yawSmooth=` の調整
- 検出距離: 60mm のゴーグルマーカーが 1280x720 のカメラで何 m まで検出できるか（辺の 10〜20 倍 = 1m 前後の見込み。足りなければ 80〜100mm）
- 発熱・フレームレート: スマホはマーカー検出をしなくなったぶん軽いはず（08 と比べる）

## 既知の制約

- **カメラの視野内でしか遊べない**（水平 FOV 68° のカメラで 3m 幅のコートは 2.5m 以上離す）。視野の外・他の人に隠れた間は最後の位置を保持する（2 台目のカメラは未対応。`MAX_TRACKERS` = 2 で接続だけは受ける）
- **原点合わせの誤差がそのまま全員の位置の誤差になる**。PC 側の 1 枚の姿勢推定にも issue #54 の傾きの誤差（POSIT）が乗り、PC カメラにはジャイロが無いので水平化できない。確定時は原点マーカーを近く・大きく・できれば正対に近く映す（10 サンプルの平均）。壁の原点マーカーが見えないカメラ配置（壁側から部屋を向く）では床のマーカー（配置を俯瞰画面に入力）で合わせる
- ゴーグルのマーカーは**正面を向いたときしか大きく映らない**。横を向くと品質が下がり、ヨーの補正は止まる（ジャイロで継続）。位置は品質が低くても使う（側面のマーカーは未対応）
- マーカーの割当は入室順で、**再接続（瞬断・bfcache）すると id が変わり割当も変わり得る**（貼り替えが要る。HUD の `track=id=` と入室時の案内に出す）。固定の割当（名前 → ID）は未実装
- Web カメラの内部パラメータ（焦点距離）はブラウザから取れないので `?camFov=` の推定値。距離が定数倍ずれる（08 のスマホ側と同じ制約）
- 08 の「追加マーカーの配置」パネルはそのまま残っているが、スマホは検出に使わない（トラッカーの原点合わせと枠の描画だけ）
