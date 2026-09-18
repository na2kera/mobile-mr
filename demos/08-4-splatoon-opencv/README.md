# 08-4. MR Splatoon（OpenCV.js の ArUco board + solvePnP 版）

`demos/08-splatoon/`（MR スプラトゥーン）の丸ごとコピーで、**「位置の取り方」（自分のカメラの姿勢を field 座標系でどう決めるか）だけ**を
OpenCV.js（WASM）に替えた比較用のデモ。[docs/space-stability-options.md](../../docs/space-stability-options.md) §4 の候補 **1b**。
「推定の数学を替えると、斜めから見たときのコートの不安定さが収まるか」を確かめる代表。

ゲームの仕様（コート・インク・タンク・練習 → 俯瞰画面の「対戦開始」→ 1 分の対戦 → 結果 → 練習・俯瞰画面の寸法とマーカー配置・8 色・サーバー権威の格子）、
UI・HUD の表記、サーバー（`server/splatoon.ts`。同じプロトコル・同じ `SPLATOON_PATH`）は 08 のまま。
同じ room 名なら 08 の端末と同じコートを塗り合える（比較に使える）。

## 方式

| | 08（`src/shared/marker-anchor.ts`） | 08-4（`src/shared/marker-anchor-opencv.ts`） |
| --- | --- | --- |
| 検出 | js-aruco2（辞書 ARUCO_MIP_36h12。誤り訂正 4 ビット） | OpenCV.js 4.12 の `ArucoDetector`（辞書 `DICT_ARUCO_MIP_36h12`。**js-aruco2 と同じ ID・同じ向きのビット**であることを Node で確認済み。08 の `markers.html` で印刷したマーカーがそのまま読める）。コーナーはサブピクセル精錬（`CORNER_REFINE_SUBPIX`）。誤り訂正は `errorCorrectionRate = 0.34`（int(12 × 0.34) = 4 ビット = js-aruco2 と同じ。既定 0.6 だと 7 ビット反転しても読む） |
| 姿勢 | 1 枚ずつ POSIT（平面 4 点）→ 画面上の辺長² で重み付き平均 | **見えている全マーカー（原点 + 俯瞰画面で配った追加マーカー）の 4 隅を 1 つの board にして `solvePnP` で 1 つの姿勢**。平面（1 枚、同じ壁の複数枚）なら `SOLVEPNP_IPPE` → その解を初期値に `ITERATIVE`（LM）で仕上げ。非平面（壁 + 床など）なら `ITERATIVE`（前フレームの姿勢を初期値。初期値無しの解と再投影誤差で選ぶ） |
| 傾き | 重力で水平化（`gravityAlign`。マーカーからは位置とヨーだけ） | 同じ考え方で残す（PnP の傾きも信用しない場合の保険）。位置は「見えているマーカーの中心の平均 − R_level・(その平均のアンカー座標)」（08 の「マーカー中心 − R・pos」の複数枚版）。`?gravityAlign=0` で切れる |
| 内部パラメータ | 焦点距離 = 長辺 / 2 / tan(水平 FOV / 2)。FOV は機種平均の推定値 | 同じ換算（`?camFov=` で上書き）。主点は画像中心、歪みは 0 |
| 診断 | `err=`（POSIT の正規化誤差）`spread=`（複数枚の候補のばらつき）`tilt=` `Δ=` | 同じ + `reproj=`（board の再投影誤差 [px]。配置の入力ミス・貼りズレで増える）、solvePnP の方法、`cv=`（処理時間）。`err=` は 08 と同じ尺度（マーカーごとに 4 隅の \|du\|+\|dv\| の合計 ÷ 辺長）、`spread=` は 1 枚ずつの単体解（board と独立の IPPE の 2 解から選ぶ。下の既知の制約）の候補から 08 と同じ定義で出す。`id=` は最終の姿勢に実際に寄与した ID だけ |
| 配置の不整合 | 1 枚ずつの平均のまま（spread が大きくなる） | board は解けたが再投影誤差が上限を超えた（複数枚の配置と観測が合わない）ときは、同じ配置で原点に直す 1 枚ずつの平均には**落とさない**。原点マーカーが見えていれば原点だけで解き（`id=0 … (origin only) inconsistent spread=…m`）、見えていなければ直前の姿勢を維持する（`pose=opencv inconsistent spread=…m …`）。solvePnP が解けない（解なし）はロスト |
| 無いとき | — | OpenCV.js が無い / 読めない（取得が 30s 応答しなければ中断）/ 初期化できないときは HUD に理由を出して **08 と同じ js-aruco2 の経路にフォールバック**（`?detector=aruco2` で明示的にも切替）。読み込めた後も、検出・solvePnP の例外（WASM の abort など）が **30 回連続**したら `pose=aruco2 (opencv runtime error: …)` に切り替える（例外のフレームは `error(Nx)=…` でロスト扱い） |

座標系の合わせ方（一番間違えやすいところ）: OpenCV のカメラは X 右・Y 下・Z 前、three.js は X 右・Y 上・-Z 前。
board の対応点（object points）は **field 座標系（three.js の規約）のまま**渡し、solvePnP の [R|t]（field → OpenCV カメラ）に
F = diag(1, −1, −1) を**左から**掛けて field → three.js カメラにする（`pnp-board.ts` の `cvPoseToCameraMatrix`）。
08 の `marker-detector.ts`（POSIT のモデル座標が「Z 奥」だったので F・M・F）とは違い、右からは掛けない。
合成カメラ（`fake-markers.ts`）の投影と再投影誤差 0 で整合することを Node のテストで確かめている。
OpenCV の corners の並び（左上・右上・右下・左下）は印刷したマーカーの左上から時計回りで、辞書のビットの向きが js-aruco2 と一致するので
「左上」も一致する（`markerCorners`）。

## 08 との差分（ファイル単位）

新規:

- `demos/08-4-splatoon-opencv/` — 08 の丸ごとコピー。変えたのは `main.ts`（下記の節）、`index.html`（タイトル・方式の説明・URL パラメータ）、`overview.html` / `markers.html`（タイトルのみ）、`markers.ts`（キャプションのみ）。`overview.ts` `game-client.ts` `ink-*.ts` `splat-sound.ts` `fake-splat-hand.ts` は無変更のコピー
- `src/shared/pnp-board.ts` — 純粋な数学（three / OpenCV 非依存）: board の組み立て・平面判定・Rodrigues・OpenCV ⇔ three.js の姿勢変換・再投影誤差
- `src/shared/opencv-pose.ts` — OpenCV.js を使う部分（DOM / three 非依存。Node でも動く）: `ArucoDetector` の生成・検出・`solveBoardPnP`（IPPE / ITERATIVE の使い分け）・`solveSingleMarker`（IPPE_SQUARE）
- `src/shared/opencv-loader.ts` — `public/vendor/opencv/opencv.js` を fetch → Blob の ES モジュールとして動的 import（`<script>` は使わない）。進捗と失敗を返す。`OpenCv` 型（使う範囲だけ）
- `src/shared/marker-anchor-opencv.ts` — 08 の `MarkerAnchor` interface を満たす実装（`update` / `info` / `usedIds` / `spreadM` / `tiltDeg` / `correctionM` / `isTracking` …）+ `backend` / `loadStatus` / `reprojPx` / `pnpUsed`。読み込み失敗時は `createMarkerAnchor`（js-aruco2）に委譲
- `scripts/fetch-opencv.mjs` — OpenCV.js の取得（`npm run fetch:opencv`）。`scripts/test-08-4-opencv.mjs` / `scripts/headless-08-4-opencv.mjs` — PC の確認
- `public/vendor/opencv/`（git 管理外。`.gitignore`）

`main.ts` で差し替えた節（それ以外は 08 のまま）:

- 先頭のコメント（方式と URL パラメータ）
- import: `createMarkerAnchor` → `createOpenCvMarkerAnchor`（`marker-anchor.ts` からは `ExtraMarker` 型だけ）
- パラメータ: `MARKER_LOST_MS` の直後に `DETECTOR` / `PNP_METHOD` / `POSE_SOURCE` / `MAX_REPROJ_PX` / `OPENCV_URL`
- `let markerAnchor: OpenCvMarkerAnchor | null`
- `startCameraAndMarker`: `createOpenCvMarkerAnchor({ opencvUrl, detector, pnpMethod, poseSource, maxReprojPx, ...08 と同じオプション })`
- HUD: `marker=` の行 → `pose=<opencv|aruco2|loading> id=… err=… reproj=…px <方法> spread=… tilt=… Δ=… cv=…ms`（フォールバック時は理由を括弧で）。1 行目に `detector= pnp= poseSource=`

`src/shared/marker-anchor.ts` は変更していない。`server/splatoon.ts` も変更していない（同じプロトコル）。

## URL パラメータ

08 と同名・同義のもの（`fov` `camZoom` `markerMm` `markerId` `detW` `smooth` `markerIntervalMs` `lostMs` `maxPoseError` `gravityAlign` `fakecam` `fakehands` `fakeMarkers` `fakeCamPos` `fakeYaw` `fakePitch` `fakeTilt` `room` `name` `autostart` `camFov` …）はそのまま。
08-4 固有:

| パラメータ | 既定 | 意味 |
| --- | --- | --- |
| `detector=opencv\|aruco2` | `opencv` | `aruco2` は OpenCV.js を読まずに 08 と同じ js-aruco2 の経路 |
| `pnp=auto\|ippe\|iterative` | `auto` | `auto`: 平面なら IPPE → LM 仕上げ（前フレームがあれば初期値ありの解も出し、誤差が同程度なら連続性を優先）、非平面なら ITERATIVE + 前フレームを初期値。`ippe`: IPPE のみ（非平面は ITERATIVE に落ちる）。`iterative`: 常に ITERATIVE + 前フレームを初期値（初期値ありと無しを再投影誤差で選ぶ） |
| `pose=board\|single` | `board` | `single`: 1 枚ずつ `IPPE_SQUARE` で出して 08 と同じ重み付き平均（「数学だけ替えた」比較用） |
| `maxReprojPx=` | `4` | board の再投影誤差（平均）の上限。**検出画像の長辺 960px（`detW=960`）のときの px** で指定し、実際の検出画像の長辺に比例して換算する（640px なら 2.67px）。正常な配置なら 1〜2px、配置の入力ミス・貼りズレで 5px 超（Node のテストの床 30cm ずれは 640px で 5.2px = 960px 換算 7.8px）。超えたら上の「配置の不整合」。`maxPoseError`（08 と同じ尺度の正規化誤差）でもマーカーごとに足切り |
| `opencvUrl=` | `<BASE_URL>vendor/opencv/opencv.js` | OpenCV.js の場所 |
| `camFov=` | 機種平均（超広角 106 / 標準 68。フェイクカメラは 68） | 焦点距離の換算に使う水平 FOV（内部パラメータの手動較正） |

## PC での確認

```sh
export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"   # Node 22
npm ci && npm run fetch:models && npm run fetch:opencv       # opencv.js（約 11MB）を public/vendor/opencv/ に（SHA-256 を固定値と照合）
npx tsc --noEmit && npx vite build                           # public/ ごと dist に入るので dist にも約 11MB の opencv.js が入る
npm run test:08-4-opencv    # Node: pnp-board.ts の数学 + OpenCV.js を Node で動かした往復・誤り訂正・配置の不整合・実行時エラーの切替と比較（下の表）
npm run check:08-4-opencv   # ヘッドレス Chrome: 08 と同じ確認 + 経路の切替・フォールバック・斜め 55° の比較（dev サーバー 5203 / CDP 9345。PORT= / CDP_PORT= で変更）
npm run test:splatoon && PORT=5237 CDP_PORT=9367 npm run check:splatoon   # 08 を壊していないこと（既定 5189 / 9336。並行実行時はポートを変える）
```

ヘッドレス確認は dev サーバーとヘッドレス Chrome をポート固定で立てるので、回す前に `lsof -nP -iTCP:5203 -sTCP:LISTEN` / `lsof -nP -iTCP:9345 -sTCP:LISTEN` で空いていることを確かめる（他の worktree の確認と衝突すると別のコードを確認してしまう）。

手で見るなら `npm run dev` → `https://localhost:5173/demos/08-4-splatoon-opencv/?camZoom=1&fakecam=1&autostart=1&name=PC&fakehands=1`
（2 つ目のウィンドウで同じ URL、3 つ目で `overview.html`）。斜めから見るなら `&fakeCamPos=0.98,0.05,0.69&fakeYaw=55&gravityAlign=0`（fakeYaw は + で左を向く。右前方に居るので左を向いて原点を見る）など。

### 同じ合成入力での比較（`scripts/test-08-4-opencv.mjs` の出力。2026-09-17）

原点マーカー 150mm を 1.5m から、カメラを原点に向けたままヨー 0 / 30 / 45 / 60° に置き、位置を ±3cm・向きを ±1.5° 揺らして 24 試行。
640×480・水平 FOV 68°（検出側と同じ換算）でピンホール投影し、4 倍で描いて INTER_AREA で縮小 + σ=1.2 のぼかし（js-aruco2 は縁が鋭い合成画像だと ID を読めないため。両方に同じ画像）。
**原点の推定位置の真値からの誤差 [cm]（中央値 / p90）** と傾きの誤差の p90 [deg]。raw = 姿勢そのまま、lvl = 重力で水平化（08 と同じ式）。
2 枚は「原点 + 同じ壁の ID 5（右 0.6m）」で、08 は 1 枚ずつ POSIT → 辺長² の重み付き平均、08-4 は 8 点を 1 つの board。

| マーカー | 角度 | 検出 08 / 08-4 | 08 POSIT raw | 08-4 PnP raw | 08 lvl | 08-4 lvl | 傾き p90 08 / 08-4 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 原点 1 枚 | 0° | 24 / 24 | 2.4 / 3.7 | 1.1 / 1.4 | 2.4 / 3.7 | 1.1 / 1.4 | 8.1 / 3.6 |
| 原点 1 枚 | 30° | 24 / 24 | 2.5 / 4.9 | 1.0 / 1.5 | 2.5 / 4.9 | 1.0 / 1.5 | 1.7 / 0.5 |
| 原点 1 枚 | 45° | 24 / 24 | 2.4 / 3.6 | 2.5 / 3.8 | 2.4 / 3.6 | 2.5 / 3.8 | 1.2 / 1.6 |
| 原点 1 枚 | 60° | 18 / 24 | 3.4 / 4.9 | 3.2 / 5.0 | 3.4 / 4.9 | 3.2 / 5.0 | 1.0 / 1.0 |
| 原点 + ID 5 | 0° | 24 / 24 | 24.1 / 25.2 | 0.4 / 0.6 | 24.2 / 25.3 | 0.4 / 0.6 | 8.2 / 1.1 |
| 原点 + ID 5 | 30° | 24 / 24 | 2.2 / 4.1 | 0.2 / 0.2 | 2.2 / 4.1 | 0.2 / 0.2 | 3.7 / 0.3 |
| 原点 + ID 5 | 45° | 24 / 24 | 1.5 / 2.3 | 0.4 / 0.6 | 1.5 / 2.2 | 0.4 / 0.6 | 1.5 / 1.2 |
| 原点 + ID 5 | 60° | 24 / 24 | 1.5 / 2.1 | 0.6 / 0.9 | 1.5 / 2.1 | 0.6 / 0.9 | 1.2 / 0.7 |

読み方:

- **1 枚だけなら PnP（IPPE + LM）と POSIT はほぼ同等**（45 / 60° で p90 3.6〜5cm。正面〜30° では PnP のほうが 2〜3 倍良い）。「斜めの平面 4 点は条件が悪い」こと自体は数学を替えても変わらない（space-stability-options.md 1a の「限界」どおり）
- **複数枚を 1 つの board にすると明確に効く**（45 / 60° で p90 0.6〜0.9cm vs 2.1〜2.3cm）。正面（0°）で右 0.6m の 2 枚目を斜めに見る条件では、POSIT は鏡像の解（issue #55 の機序）で原点が 25cm 飛ぶが board は 0.6cm
- 60° の細い台形は js-aruco2 が 24 回中 6 回落とす（OpenCV は全て検出）
- ヘッドレス Chrome（`check:08-4-opencv`）の斜め 55°・1 枚（100mm を 1.2m から。画面上 23px 幅）・水平化なしでは、OpenCV の PnP は自分の位置の誤差 1.7cm、js-aruco2 はそもそも検出できなかった（ログ `oblique 55°:`）
- 1 枚だけになった瞬間の鏡像（原点を隠して 100mm の 2 枚目だけ）は、前フレームの board の解を初期値にした ITERATIVE を連続性で優先することで 0.46m の飛びが消えた（`hidden-origin window1: self=[0,0,0.74]`）。配置を実際と違う位置に反映して board が再投影誤差で捨てられると、原点だけで解いて `inconsistent spread=…m` を出す（Node のテストでは 0.6m ずらした 2 枚でアンカーが原点単体の位置から 0.00cm、spread=0.59m）

## 実機で確認すべき項目（**iPhone 実機は未確認**）

- OpenCV.js（約 11MB）の読み込み時間と HUD の `pose=loading …MB` → `opencv` の遷移。Safari で Blob の動的 import と WASM の初期化が通るか（失敗すると `pose=aruco2 (opencv failed: …)` になる）
- `cv=` の処理時間（detW=960 で 20〜40ms を想定）と発熱。重ければ `?detW=640` `?markerIntervalMs=150`
- 正面で 08 と同じ位置（壁・床の枠が実物に重なる）
- **斜め 45〜60° から見たときのコートの安定さ**（08 と同じ部屋・同じマーカーで見比べる。HUD の `Δ=` と `reproj=`）
- 追加マーカー（床・左右・背面）を配って複数枚が同時に見えたときの `reproj=`（1〜2px なら配置が合っている。5px 超なら貼りズレか入力ミス）と、1 枚 → 2 枚の切り替わりで飛ばないこと
- 2 台で入室 → 発射 → 得点、相手の相対位置
- `?gravityAlign=0` で PnP の傾きだけでどこまで安定するか（板の傾き推定が 08 より良ければ水平化無しでも床が浮かない）

## 既知の制約

- OpenCV.js の読み込みは「開始」をタップしてから始まるので、開始後の数秒〜十数秒（回線と端末による）は `pose=loading …MB` で位置合わせしない（先読みは UI/UX の方針に関わるので未対応）
- OpenCV.js は package.json に足していない。`npm run fetch:opencv` で取得する（@techstark/opencv-js 4.12.0-release.1 の `dist/opencv.js` = 公式 docs.opencv.org/4.12.0/opencv.js。Apache-2.0）。公式サイトは Cloudflare の challenge でスクリプトから取れないので jsDelivr（npm ミラー）経由
- この Emscripten ビルドの Module には `then` が生えていて、async 関数から返すと Promise の解決が無限ループする（`opencv-loader.ts` で `delete cv.then`）
- 1 枚だけの IPPE は正面付近で 2 解（鏡像）の誤差が僅差で、どちらが選ばれるかが揺れる（ヘッドレスでは 100mm の 2 枚目だけになった瞬間に 0.46m 飛んだ）。前フレーム（複数枚が見えていた board の解）を初期値にした解を「誤差が同程度なら」優先して正しい側に留める。最初の取得が鏡像だとそこに居座る（2s ロストで初期値を捨てて取り直す）。水平化で傾きの鏡像は消えるが、ヨーの鏡像は複数枚でしか解けない
  - **未解決（コードは変えていない）**: 1 枚の IPPE の鏡像の解を実測した（Node。原点 150mm を 1.5m から、各 24 試行。IPPE_SQUARE の解と、視線まわりに法線を反射した姿勢を初期値にした LM の解を比べる。中央値）。
    正面 0°: 誤差比 1.5 倍（最小 1.15）・2 解の自分の位置の差 3.2cm・回転差 1.2°（両解とも真値から数 cm）/ 13°: 誤差比 6.4 倍（最小 1.09）・位置差 66cm・回転差 25° /
    45°: 誤差比 6.5 倍（最小 3.3）・位置差 2.2m・回転差 91°。鏡像の差はヨー（重力では選べない）に出る。正面では取り違えても害が小さく、斜めでは誤差比が大きく離れて取り違えにくいので、
    「前フレーム初期値で連続性を優先」を維持する（13° 付近で誤差比が 1.1 倍まで近づく試行があり、そこで初回の取得を誤ると居座る余地は残る）
- `spread=` の単体解は、board と独立に IPPE の最良解と鏡像（法線を視線で鏡映した初期値から ITERATIVE）の 2 解を作り、再投影誤差の比が 2 倍以上なら誤差の小さい方、2 倍未満（僅差。正面付近の小さいマーカー）なら board の姿勢に回転が近い方を採る（`pnp-board.ts` の `SINGLE_AMBIGUITY_RATIO` / `chooseSingleSolution`）。鏡像の差はヨー（数十度）に出て配置の誤り（位置が数十 cm）とは性質が違うので、どちらを選んでも配置の誤りは spread に残る（Node のテストで 0.6m ずれ → spread 0.59m・inconsistent、合っている 2 枚 → 0.003m）。誤差だけで選ぶとヘッドレスの 100mm 正面で鏡像を拾い、配置が合っていても 0.16m 出ていた。board が無い `?pose=single` では僅差でも誤差の小さい方なので、この膨らみは残る
- 内部パラメータは 08 と同じ推定値（機種平均の FOV・主点中心・歪み 0）。較正ページは無い。超広角の歪みは無視している
- 単眼 3DoF のまま（マーカーが見えない間は位置が止まる）。要件 2（相手の相対位置）は各自の推定の交換のまま（space-stability-options.md の C / D は対象外）
- Node のテストは `public/vendor/opencv/opencv.js` が無いと OpenCV の節を SKIP して FAIL 扱い（取得してから流す）。ヘッドレス確認は無ければ取得する
