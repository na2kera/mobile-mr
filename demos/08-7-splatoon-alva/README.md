# 08-7. MR Splatoon（AlvaAR の単眼 SLAM + マーカー）

> **ライセンス: AlvaAR は GPLv3。このデモ（実験）限定で使い、Mobile MR SDK には入れない。**
> AlvaAR は npm に入れず、`npm run fetch:alva` で `public/vendor/alva/`（git 管理外）に置く。`vite build` するとそのまま `dist/vendor/alva/` にコピーされるので、
> **ビルド成果物を公開するなら GPLv3 の義務（ソースの提供・ライセンス全文の同梱など）が掛かる**。公開ビルドに含めない場合は `public/vendor/alva/` を消してからビルドする。
> AlvaAR の元になった OV²SLAM / ORB-SLAM2 も GPLv3。

`docs/space-stability-options.md` §4 の候補 **3a**。「ブラウザだけで 6DoF（歩いてもずれない）が得られるか」を確かめる実験。
**iPhone 実機では未確認**（PC のヘッドレス Chrome とフェイク入力でのみ確認）。

## 方式

08 はマーカーが見えない間は最後の姿勢のまま位置が止まる（原因 D「頭は 3DoF」）。08-7 はハイブリッド:

| いつ | 位置 | 回転 |
| --- | --- | --- |
| マーカーが見えている | 08 と同じマーカー（`createMarkerAnchor`。既存ファイルは無変更） | ジャイロ（08 と同じ） |
| マーカーが見えている間ずっと | 「field 座標系でのカメラの姿勢（マーカー + ジャイロ）」と「AlvaAR の姿勢」の組を集め、SLAM → field の相似変換（回転 + スケール + 平行移動）を推定し続ける | — |
| マーカーが見えない・変換が推定済み・SLAM が追跡中 | AlvaAR の位置を変換で field に写し、**アンカーの位置だけ**動かす（`slamSmooth` で平滑化） | ジャイロ（アンカーの向きはマーカーで決めた最後のまま） |
| AlvaAR が無い / 初期化失敗 / 例外が 30 回続いた / `?slam=0` | 08 と同じ（ロスト中は最後の姿勢） | ジャイロ |

- **AlvaAR の姿勢の形式**（ピン留めしたコミット `7796af5` の `src/slam/src/utils.cpp` の `toPoseArray`）: 16 要素は **Twc**（カメラ → SLAM ワールド）。
  `[0..2]` が回転の 0 行目（= 行優先。three の `Matrix4.fromArray` で読むと転置）、`[12..14]` がカメラの位置。座標系は OpenCV 流儀（X 右・Y 下・Z 前）。
  three 流儀（X 右・Y 上・-Z 前）へは `S = diag(1,-1,-1)` で `p = S t`、`R = S R_cv S`（同梱の `alva_ar_three.js` と同じ変換）
- **変換の推定**（`slam-fusion.ts`）: 回転 = 各組の `Q_field · Q_slam⁻¹` の平均、スケール = 重心からの変位の最小二乗、平行移動 = 重心合わせ。
  位置だけで回転も出す Umeyama は、ゴーグルを付けて数十 cm 動く程度の直線的な軌道では回転が決まらないので使わない。基線（field 側の重心からの距離の RMS）が `slamMinBaseline` 未満のうちは推定しない
- **組の選び方**: マーカーの採用から `slamPairAgeMs` 以内、かつ直近の採用でアンカーがほぼ動かなかった（補正量 `Δ ≤ slamPairMaxCorr`）フレームだけ。
  アンカーは lerp で遅れて追いつくので、動いている最中の組は「SLAM は新しい位置・マーカーは古い位置」になりスケールが縮む（ヘッドレスで確認）
- **SLAM のリセット**（AlvaAR 内部の追跡失敗 → 地図を捨てる。`system.findCameraPose` の戻り値 2）で座標系が変わるので、推定を捨ててマーカーで取り直す
- **焦点距離**: `AlvaAR.Initialize(w, h, fov)` の `fov` は独自の換算なので、`getCameraIntrinsics` を二分探索して「長辺 / 2 / tan(水平 FOV / 2)」（マーカー検出と同じ）になる値を渡す（HUD の `f=`）

## 08 との差分（ファイル単位）

| ファイル | 差分 |
| --- | --- |
| `main.ts` | 冒頭コメント（方式・追加パラメータ）/ SLAM のパラメータ定数 / フェイクカメラを毎フレーム作り直して `window.__fakeMarkers.camPos` で動かせるように（`fakeWorld`・`fakeStream`）/ 新しい節「SLAM（08-7）」（`updateSlam`・フェイクの SLAM `fakeSlamPose`・`slamStateText`）/ `startCameraAndMarker` の末尾で SLAM を起動 / `sendPoseIfDue` の `tracking` に SLAM で動かしている間を含める（`markerIds` はマーカー追跡中だけ）/ HUD の `marker=` 行の `(slam)` と `slam=` 行、`hudState.base` の `slam=`・`slamW=` / ループで `updateSlam` を呼ぶ |
| `slam-source.ts`（新規） | カメラ映像 → 縮小 ImageData → AlvaAR（動的 import）→ three 流儀の姿勢。例外の try/catch と連続失敗での停止、フェイクの注入口 |
| `slam-fusion.ts`（新規） | three 非依存の数学（形式の変換・相似変換の推定・`SlamFusion`） |
| `index.html` / `overview.html` / `markers.html` | タイトルと見出しを 08-7 に。`index.html` に 08-7 の説明と追加パラメータの段落 |
| `overview.ts` / `game-client.ts` / `ink-*.ts` / `splat-sound.ts` / `fake-splat-hand.ts` / `markers.ts` | 無変更（08 のコピー） |

サーバーは 08 と同じ `server/splatoon.ts`（`SPLATOON_PATH`。プロトコルは変えていないので room 名で分かれる）。
その他: `scripts/fetch-alva.mjs`、`scripts/test-08-7-alva.mjs`、`scripts/headless-08-7-alva.mjs`、`package.json`（`fetch:alva` / `test:splatoon-alva` / `check:splatoon-alva`）、`.gitignore`、ルートの `index.html`、`vite.config.ts`。

## URL パラメータ

08 のパラメータはすべて同名・同義（`fov` `camZoom` `markerMm` `fakecam` `fakehands` `room` `name` `autostart` `gravityAlign` ほか）。追加:

| パラメータ | 既定 | 意味 |
| --- | --- | --- |
| `slam` | 1 | `0` で SLAM を使わない（08 と同じ動作） |
| `slamW` | 360 | SLAM の入力画像の長辺 [px]（マーカーの `detW` とは別） |
| `slamIntervalMs` | 50 | SLAM の最小間隔 [ms]（手の推論・マーカー検出との同居のための間引き） |
| `slamMaxFail` | 30 | 例外がこの回数続いたら SLAM を止めてマーカーのみに落ちる |
| `slamLostMs` | 500 | この時間 SLAM の姿勢が出なければロスト |
| `slamMinBaseline` | 0.15 | 変換の推定に要る基線 [m]（マーカーを見ながらこれくらい動くと SLAM が使えるようになる） |
| `slamPairs` | 150 | 推定に使う組の数（古いものから捨てる） |
| `slamPairMs` | 100 | 組を足す最小間隔 [ms] |
| `slamPairAgeMs` | 150 | マーカーの採用からこの時間以内のフレームだけ組にする [ms] |
| `slamPairMaxCorr` | 0.08 | マーカーの補正量 Δ がこれ以下のときだけ組にする [m] |
| `slamSmooth` | 0.5 | SLAM でアンカーを動かすときの平滑化（1 で平滑化なし） |
| `fakeslam` | — | `1` で AlvaAR を読まず、合成カメラ（`fakecam` 必須）の姿勢に既知の別原点・スケール・回転を掛けてノイズを足した AlvaAR 形式の姿勢を注入 |
| `fakeSlamScale` / `fakeSlamYaw` / `fakeSlamNoise` | 0.37 / 140 / 0.002 | フェイクの SLAM 座標系のスケール・ヨー [deg]（+ X まわり 20° の傾き固定）・位置のノイズ（field 換算 [m]） |

HUD（`marker=` 行の下）: `slam=<状態> t=<処理時間>ms off=<マーカーの位置との差>m fix=<推定> rot=(<ヨー>,<ピッチ>,<ロール>) rotErr=<ジャイロとの差>deg n=<呼び出し回数> resets=<リセット回数> f=<焦点距離>px`。
状態は `loading`（読み込み中）/ `waiting`（映像待ち）/ `init`（AlvaAR の初期化中。視差のある動きが要る）/ `tracking`（`+drive` = マーカーの代わりに位置を動かしている）/ `lost` / `reset` / `failed(<理由>)` / `off(<理由>)`。
マーカーが見えない間、`marker=` 行の末尾は SLAM で動かしていれば `(slam)`、動かしていなければ 08 と同じ `(holding last pose)`。`rot` / `rotErr` は診断用（回転は SLAM から採らない）。

## PC 確認の手順

```sh
export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
npm ci && npm run fetch:models && npm run fetch:alva
npm run test:splatoon-alva    # 純粋な数学（手計算の固定期待値 + 合成の往復）
npm run check:splatoon-alva   # ヘッドレス Chrome（既定 PORT=5207 CDP_PORT=9347）
```

`check:splatoon-alva` の内容:

- A（`?fakeslam=1`）: マーカーを見ながら合成カメラを動かすと変換が推定される（スケールが正解の ±15%、`off` < 5cm、`rotErr` < 5°）。原点マーカーを隠して合成カメラを 2 か所へ動かすと、`self=` が追従する（±10cm）。マーカーを戻すとマーカーの追跡に戻る。`__fakeSlam.throw` で例外を出し続けると 30 回で `slam=failed` になり、08 と同じマーカーのみに落ちて描画・発射が続く
- B（`?slam=0`）: 同じ動きで、マーカーを隠している間は `(holding last pose)` で位置が止まる
- C（実 AlvaAR）: チェッカーボードの映像で読み込み・初期化が通り、`findCameraPose` が呼べる（静止画なので追跡は始まらず `init` / `reset` を繰り返す）。焦点距離がマーカー検出と同じ換算
- D（`alva_ar.js` を CDP でブロック）: `slam=failed(読み込み失敗…)` が出て、マーカーのみで入室・発射できる
- 俯瞰画面が開けて 4 人が見える / 例外なし

手で見るなら: `https://localhost:5173/demos/08-7-splatoon-alva/?camZoom=1&fakecam=1&autostart=1&name=PC&fakehands=1&fakeslam=1&markerMm=100` を開き、
DevTools で `__fakeMarkers.camPos = [0, 0, 0.5]` → 数秒 → `[0, 0.04, 0.8]` …と動かしてから `__fakeMarkers.hidden.add(0)`、`__fakeMarkers.camPos = [0.4, 0.1, 1.2]`。

## 実機で確認すべき項目（すべて未確認）

1. **AlvaAR が iOS Safari で読み込め、初期化が通るか**（4.3MB の JS に WASM を base64 で埋め込み。メモリ・コンパイル時間）。HUD の `slam=` が `init` → `tracking` になるまでの動き（AlvaAR は視差が要るので、横に数十 cm 動かす）
2. **処理時間 `t=`**（メインスレッドで同期実行。`slamW=360` で何 ms か）と、手の推論・マーカー検出と同居したときのフレームレート。重ければ `slamW=320` / `slamIntervalMs=100`
3. **超広角カメラ（既定）で追跡が持つか**。AlvaAR は歪み係数 0 で初期化しているので、超広角の歪みが強いと追跡が崩れる可能性。`?lens=wide` と比べる
4. **ゴーグル装着時の歩行の揺れ・手が映ること**で `reset` が頻発しないか（HUD の `resets=`）
5. マーカーを見ながら動いて `fix=s=… res=…` が出るまでの動き（既定 15cm）と、そのときの `off=`（数 cm 以内か）・`rotErr=`（ジャイロとの差。数° 以内か）
6. **マーカーから目を離して歩いたとき**、コート（壁・床の枠）が現実の壁に留まるか。数 m 歩いてからマーカーを見直したときの `Δ=`（ずれていた量）
7. 2 台で相手の位置（相手のインクが相手の手元から出るか）。相対位置は各端末の推定の足し算のまま（原因 C は解決しない）
8. **発熱と電池**（PAIN_POINTS「熱制限」）。10 分遊んで `t=` とフレームレートが落ちないか
9. 端末を回転（縦 ↔ 横）したときに AlvaAR が作り直され（`resets` が増える）、マーカーで取り直せるか

## 既知の制約・判断

- **回転に SLAM を使わない理由**: ジャイロは遅延ゼロでドリフトが小さく、08 で実機確認済み。単眼 SLAM の回転はフレーム間隔（`slamIntervalMs`）ぶん遅れ、追跡が切れると飛ぶ。VR ゴーグルでは回転の遅れ・飛びが酔いに直結するので、SLAM からは位置だけ採る（`rot` / `rotErr` は診断用に HUD に出す）
- **6DoF が効く場面**: マーカーを見失ったまま歩く・しゃがむ（08 は位置が止まってコートが一緒に動く）。**効かない場面**: 変換の推定前（マーカーを見ながら動くまで）、SLAM のリセット直後（マーカーを見直すまで 08 と同じ）、特徴の少ない壁や暗い部屋、速い首振り（ゴーグル装着時の揺れ）、手が大きく映る（手を動く特徴点として拾う）、超広角の歪み
- **スケールと向きはマーカーの精度に依存する**。マーカーの姿勢推定が斜めで崩れる（08 の原因 A）と、その誤差が変換に入る。ヘッドレスでも合成カメラをマーカーの視軸から 15° 以上ずらすと POSIT が鏡像のヨーを拾い、組が壊れてスケールが 1/4 になった（確認ではずらさない位置を使った）
- AlvaAR の状態（初期化中 / リセット）の判別に、ピン留めしたコミットの内部（`alva.system` / `memImg` / `memCam`）を使っている。無ければ公開 API（`findCameraPose` の null / 非 null）に落ちるが、そのときはリセットを検知できない
- 端末の回転で映像の縦横が変わると AlvaAR を作り直す（古いインスタンスの WASM メモリは解放しない。回転を何度も繰り返すとメモリが増える）
- 相手との相対位置（原因 C）は解決しない。各端末の SLAM の原点合わせはマーカー頼みのまま
- フェイクの SLAM は合成カメラの「正解の姿勢」から作るので、SLAM の追跡の質（初期化・ドリフト・リセット）は PC では確かめられない
- 熱: SLAM はメインスレッドで毎秒 20 回（既定）動く。手の推論（MediaPipe）・マーカー検出と合わせて 08 より確実に重い。未計測
