# 08-10 MR Splatoon — 8th Wall SLAM 比較デモ

08 と同じマーカー、MediaPipe Hands、インク、対戦サーバーを使い、頭の位置と回転だけ 8th Wall Engine Binary の World Tracking に替えた比較デモです。8th Wall が取得した背面カメラの `video` を背景、マーカー検出、手検出で共有するため、カメラを二重に開きません。

## 試す

```sh
npm ci
npm run fetch:models
npm run dev -- --host 0.0.0.0 --port 5210
```

スマホと開発 PC を同じ LAN に接続し、`https://<Mac のホスト名>.local:5210/demos/08-10-splatoon-8thwall/`（ホスト名は `scutil --get LocalHostName`。IP 直打ちは Wi-Fi が変わると開けなくなる）をスマホのブラウザで開きます。初回は自己署名証明書の警告を許可してください。印刷するマーカーは [markers.html](./markers.html)、PC の俯瞰画面は [overview.html](./overview.html) です。両方で `?room=同じ名前` と `?markerMm=印刷寸法` を揃えます。ゲームの操作は [08 のデモ](../08-splatoon/) と同じです。

開始後は背面カメラで特徴のある壁や床をゆっくり映し、HUD の `xr=NORMAL` を待ちます。次に壁のマーカーを見て `relock=ready` と `marker=id=...` を確認してください。マーカーが見えない方向へ歩いたときも、8th Wall の位置と回転でコートがその場に残る想定です。`LIMITED`、タブ復帰、姿勢更新停止などの後は、再びマーカーを見るまでコートと発射を止めます。`?fakecam=1&fakehands=1&autostart=1&name=PC` は既存デモと同様の PC 用フェイクで、8th Wall は起動しません。`?fakecam=1&fakexr=1` を足すと `window.XR8` にモック（[fake-xr8.ts](./fake-xr8.ts)）を差し込んでから実機と同じ `startXrSource()` を通し、合成カメラの姿勢に既知のヨー + 平行移動（`?fakeXrYaw=` 既定 140°、`?fakeXrNoise=` 既定 0.002m）を掛けた姿勢を返します。PC で XR 経路（姿勢適用・再ロック・発射停止・`tracking:false`・投影更新）を確認するためのもので、`window.__fakeXr` から `LIMITED`・姿勢欠損・不正 intrinsics・例外・映像サイズ変更（`setVideoSize(w, h)`）・映像の停止と再開（`pauseVideo()` / `resumeVideo()`。停止中は `repeatFrame`）・次の N tick を `repeatFrame` にする（`holdFrames = N`）・端末の向き変更（`rotateDevice()`）を起こせます。

## 構成と調整

- `@8thwall/engine-binary@1.0.0` の `dist` を Vite が `/vendor/8thwall/` で配信します。開発時も本番 build も `npm ci` だけでバイナリが揃います。XR8 専用 canvas は非表示にし、別の Three.js canvas で左右の目を描きます。
- `XR8.XrController.configure({scale:'absolute'})` のメートル単位の姿勢を Three.js の camera に適用します。マーカーが映ると既存 `createMarkerAnchor` が field → XR の変換を決め、その後は SLAM の位置・回転が動いても anchor はワールドに留まります。
- XR 専用 canvas の実ピクセル寸法を映像と揃え、`reality.intrinsics` のうち長辺に対応する焦点係数（横長なら `p[0]`、縦長なら `p[5]`）と映像サイズから長辺の FOV を求めます。既存の `camZoom` と左右分割用の cover 計算を通して背景とゲームの投影を合わせます。`?camZoom=`、`?fov=`、`?markerMm=` は既存と同じ調整項目です。HUD の `p=` は投影行列の `[0,5,8,9]` と、縦横の焦点係数の比 `sq=p[0]·w/(p[5]·h)`（1.000 が正方画素）を表示します。現状は対称ピンホール近似で、主点ずれ（`p[8]`・`p[9]`）やカメラ歪みは補正しません。
- `XR8.runPreRender(Date.now())` → camera・マーカー・ゲーム更新 → `StereoEffect.render()` → `XR8.runPostRender()` の順で処理します。
- 映像が進んでいないフレーム（停止中・`currentTime` が前回と同じ）では xr.js が `frameStartResult.repeatFrame` を立てて前回の reality を繰り返すので、姿勢も鮮度も更新しません。映像が 500ms 止まると再ロック要求・発射停止・`tracking:false` 送信になります。ただしループの前回 tick から 300ms 以上空いたとき（MediaPipe 初期化・シェーダコンパイル・GC などで main スレッドが止まっていた直後）は、止まっていたのは映像ではないので、500ms をその時点から数え直します。毎 tick が 300ms 以上かかる状態（3fps 以下）が続くと鮮度切れでは止まりません（`LIMITED`・姿勢欠損・タブ復帰の経路は効きます）。
- 端末の向き変更（`onDeviceOrientationChange`）と投影の更新（`updateCameraProjectionMatrix`。映像サイズ変更時）は SLAM の開始位置（origin）のリセットを伴うので、再ロック必須にします。映像サイズ変更は xr.js が `onUpdate` より先に `onVideoSizeChange` を呼ぶので、同じ tick の reality は新しい origin の値として採用し、`onUpdate` の中で初めて寸法の変化に気づいた場合だけそのフレームの reality を捨てます。XR 用 canvas は `hasVideo` の時点で映像寸法に合わせます。xr.js はページ表示時に読み込み始め、`XR8.run` は開始ボタンの後です。読み込みのタイムアウト 30 秒は開始ボタンからの計測です（ページ表示からではないので、遅い回線で開始前に読み終わらなくても失敗にしない）。
- 8th Wall の [配布バイナリ](https://github.com/8thwall/engine)は SLAM を含みますが、Hand Tracking は含まれません。ライセンス文は配信先 `/vendor/8thwall/LICENSE` に同梱されます。

## 検証と未検証

`npm run build`、`npm run test:splatoon`、`npm run test:8thwall`、08-10 専用の headless 確認（`npm run check:8thwall`。`?fakexr=1` の 2 人 + 俯瞰画面と、実バイナリの配信・読み込みの smoke）で、型・ビルド・ゲームロジック・XR8 callback と再ロックの流れを確認します。PC は実 SLAM 対象外です。以下は実機で確認が必要です。

1. iOS Safari と Android Chrome で実バイナリが SLAM を初期化し、`xr=NORMAL` になるか。
2. 実際の映像に対する投影行列、StereoEffect の背景、手の位置、マーカー枠のずれ。特に主点オフセットと端末回転。
   単眼カメラ映像には左右眼の背景視差がないため、近距離では `eyeSep=0.064` の骨格や枠と背景に差が出る既存の制約があります。`?eyeSep=0` と既定を同じ位置で見比べ、近距離のマーカー枠と背景のずれが消えるかを確認します。
   映像が端末の向きに合わせて回転しない端末（一部の Android）では、pixelRect（横長）と表示（縦長）が食い違う可能性があります。HUD の `sq=` が 1 から外れる、またはマーカー枠がずれるならこれを疑います。`P[8]`・`P[9]` は pixelRect と映像のアスペクトが一致していれば通常 0 です。
   映像サイズ変更時に `updateCameraProjectionMatrix` を呼ぶと origin もリセットされます。XR 用 canvas を映像寸法に保っていれば XrController 側の `onCanvasSizeChange` で pixelRect が揃うので、この呼び出しを省けば再ロックを減らせる可能性があります（要実機確認）。
3. マーカーを見失った状態の歩行・首振り、`LIMITED` からの復帰時の再ロック、2 台の相対位置と発射。
4. 処理時間・発熱・電池消費。10 分程度の試遊でフレームレートを見る。

公式 API: [Engine Overview](https://8thwall.org/docs/engine/overview)、[XR8.run](https://8thwall.org/docs/api/engine/xr8/run)、[XrController.pipelineModule](https://8thwall.org/docs/api/engine/xrcontroller/pipelinemodule)、[XrController.configure](https://8thwall.org/docs/api/engine/xrcontroller/configure)。
