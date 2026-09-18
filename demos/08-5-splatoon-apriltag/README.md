# 08-5. MR Splatoon（AprilTag 版）— 候補 1c「検出器を替える」

[docs/space-stability-options.md](../../docs/space-stability-options.md) §4 の候補 **1c AprilTag（WASM）** を、08 スプラトゥーンと同じ仕様の別デモとして作ったもの。
「検出器を js-aruco2 から AprilTag に替えると、斜め・遠くの検出が堅牢になるか」を確かめる。
**08（`demos/08-splatoon/`）は一切触っていない。** ゲームの仕様・UI・俯瞰画面・サーバーは 08 と同じで、変えたのは「位置の取り方」のうちマーカーの検出器だけ。

## 方式

- マーカーの検出と姿勢推定を **AprilTag（tag36h11）の WASM**（[arenaxr/apriltag-js-standalone](https://github.com/arenaxr/apriltag-js-standalone)。apriltag C ライブラリを Emscripten でビルドしたもの）で行う。
  `atagjs_detect` が ID・4 隅・姿勢（`estimate_tag_pose_orthogonal_iteration` の R, t。`set_tag_size` の実寸と `set_pose_info` の fx fy cx cy から）を JSON で返す
- 焦点距離 fx = fy は 08 と同じく `camHFovDeg`（`?camFov=` で上書き）から「長辺 / 2 / tan(FOV/2)」で換算、主点は検出画像の中心
- AprilTag の姿勢（カメラ X 右・Y 下・Z 前 / タグ X 右・Y 下・Z 奥）を 08 と同じ field 座標系（マーカー面 = Z=0、Y 上、+Z 視点側）に直す（`apriltag-pose.ts`。F = diag(1, -1, -1) で挟む。js-aruco2 の diag(1, 1, -1) とは違う）
- そこから先（重力での水平化 `gravityAlign`、複数マーカーの重み付き平均 `fusePoseCandidates`、スナップ / lerp、`Δ=` の診断）は 08 と同じ。`src/shared/marker-anchor.ts` は差し替え口が無いので、同じ `MarkerAnchor` interface の実装を demo 内に写し、検出器を注入で受ける形にした（`marker-anchor-apriltag.ts`）。`?detector=aruco2` で同じアンカーに js-aruco2 を通せるので、**違いは検出器だけ**
- マーカーは tag36h11（ArUco と絵柄が違う）。`markers.html` で印刷する。ID の対応は 08 と同じ（原点 ID 0、追加マーカーは俯瞰画面の ID）。タグの大きさ（黒い正方形の一辺）の定義も ArUco と同じなので `?markerMm=` の意味は変わらない
- 「平面 4 点」の姿勢推定であることは変わらないので、傾きの弱さ（issue #54）は残る前提。**実機（iPhone）は未確認**

## 08 との差分（ファイル単位）

| ファイル | 08 との関係 |
| --- | --- |
| `main.ts` | 08 のコピー。差し替えた節: import（`createMarkerAnchor` → `createDetectorAnchor` + AprilTag）、冒頭コメント、パラメータ（`?detector=` `?aprilDecimate=` `?aprilSigma=`）、`fakeWorld()`（絵柄を検出器に合わせる）、`startCameraAndMarker`（WASM を先に読んでから検出器を決め、カメラとアンカーを作る。読めなければ js-aruco2 に落とす。検出中の例外が連続 30 回でも js-aruco2 に落とす）、HUD（`marker=` の行が `april=`、1 行目に `detector=` `apriltag=`）。ゲーム・手・インク・ピア・俯瞰画面は無変更 |
| `apriltag-detector.ts` | 新規。WASM の読み込み（`<script>` 差し込み + `AprilTagWasm({locateFile})`）と cwrap 呼び出し、RGBA → グレースケール、JSON → `MarkerObservation`（08 の `MarkerDetector` と同じ形）。誤差は AprilTag の `e` ではなく 08 と同じ正規化再投影誤差を自前で計算 |
| `apriltag-pose.ts` | 新規。AprilTag の R, t → 08 の Matrix4 の純粋な変換と再投影（three.js 非依存。Node のテストから import） |
| `marker-anchor-apriltag.ts` | 新規。`src/shared/marker-anchor.ts` の `createMarkerAnchor` の写しで、検出器を引数で受ける（`fusePoseCandidates` / `levelRotation` / `tiltDegOf` は shared から import）。加えて検出器の例外を止める（そのフレームはロスト扱い・ログは間引き・連続したら `fallbackDetector` に切り替え） |
| `tag36h11.ts` | 新規。tag36h11 の符号表（0〜249）と bit の座標、絵柄（6×6 のビット / ASCII / 印刷用 SVG）。公式 PNG と一致することをテスト |
| `fake-apriltags.ts` | 新規。フェイクカメラの tag36h11 描画（ピンホール投影と塗りは `src/shared/fake-markers.ts` を import） |
| `markers.html` / `markers.ts` | 08 のコピー。SVG を `tag36h11Svg` から生成。文言を tag36h11 に |
| `index.html` / `overview.html` | 08 のコピー。タイトルと案内（方式の説明・固有パラメータ）だけ変更。レイアウト・色は同じ |
| `overview.ts` `game-client.ts` `ink-tank.ts` `ink-view.ts` `splat-sound.ts` `fake-splat-hand.ts` | 08 のコピーのまま（無変更） |
| `scripts/fetch-apriltag.mjs` | 新規。WASM・2 つのライセンス・照合用の `tag36h11.c` を `public/vendor/apriltag/` に取得（`.gitignore` 済み）。5 ファイルとも SHA-256 を固定して検証 |
| `scripts/test-08-5-apriltag.mjs` | 新規。純粋な数学の回帰テスト + 符号表 250 件と upstream `tag36h11.c` の照合（未取得なら SKIP）+ 検出器が例外を投げてもアンカーの `update` が例外を外に出さないこと |
| `scripts/headless-splatoon-apriltag.mjs` | 新規。`headless-splatoon.mjs` をもとにした、検出器の比較 + ゲームの流れ |

`src/shared/` と `server/` は変更していない（サーバーは 08 と同じ `server/splatoon.ts`、同じ `SPLATOON_PATH`。room 名で分かれる）。

## URL パラメータ

08 と同名・同義（`fov` `camZoom` `markerMm` `markerId` `detW` `markerIntervalMs` `smooth` `lostMs` `maxPoseError` `gravityAlign` `fakecam` `fakehands` `fakeMarkers` `fakeCamPos` `fakeYaw` `fakePitch` `fakeTilt` `room` `name` `autostart` …）に加えて:

| パラメータ | 既定 | 意味 |
| --- | --- | --- |
| `detector` | `apriltag` | `aruco2` で 08 と同じ js-aruco2（比較用。同じアンカーを通る）。WASM が読めないときも自動でこちらに落ちる |
| `aprilDecimate` | `2` | AprilTag の `quad_decimate`。入力を 1/n に間引いて四角形を探し、角は `refine_edges` で全解像度に戻す。`1` で全画素（遅いが小さいマーカーの位置精度が上がる） |
| `aprilSigma` | `0` | AprilTag の `quad_sigma`（分割前のガウスぼかし [px]）。実カメラでノイズが多いときに 0.8 程度 |
| `camFov` | ラベルから | 焦点距離の換算に使う水平 FOV（08 と同じ） |

HUD: 1 行目に `detector=apriltag apriltag=ready decimate=2 sigma=0`（WASM が読めなければ `apriltag=error: …` と `detector=aruco2`）。位置合わせの行は `april=id=0 err=0.01 tilt=1deg Δ=0.00m 12ms layout=- self=(…)`（末尾の ms が検出 1 回の処理時間。aruco2 のときは `marker=`）。検出中に WASM が例外を投げたフレームはロスト扱いで、この行に `error(3x)=RuntimeError: …` と出る。連続 30 回で js-aruco2 に切り替わり、1 行目が `detector=aruco2 apriltag=error: detect threw 30x (…)` になる。切り替え後は例外で止まらなくなるだけで、**追跡は戻らない**（印刷した tag36h11 は js-aruco2 では読めない。フェイクカメラの絵柄も tag36h11 のまま）。戻すにはページを再読み込みする。1 行目の末尾の `wasm=NNms raw=N` は `atagjs_detect` 単体の時間と姿勢の検証前の検出数で、ロスト中も出る（iPhone で重さを見るのはこちら。`april=` の行の ms はグレースケール変換と JSON の解析を含み、追跡中だけ出る）。

## セットアップ

```sh
npm run fetch:models     # 手の検出（08 と同じ）
npm run fetch:apriltag   # AprilTag の WASM → public/vendor/apriltag/
npm run dev
```

WASM を取得していなくてもページは開け、HUD に `apriltag=error: …` と出て js-aruco2 で動く（その場合マーカーは 08 の ArUco になるので注意）。

## PC 確認

```sh
npm run test:splatoon-apriltag    # Node: tag36h11 の絵柄が公式画像と一致 / 姿勢の変換の往復（角の順序込み）/ 変換の取り違えを検出できること
npm run check:splatoon-apriltag   # ヘッドレス Chrome: 検出器の比較 + 入室 → 練習 → 対戦 → 結果（PORT 5205 / CDP 9346）
npm run test:splatoon && npm run check:splatoon   # 08 を壊していないこと
```

### 検出器の比較（ヘッドレス Chrome、合成映像。`check:splatoon-apriltag` の出力から）

条件: 100mm のマーカー、フェイクカメラ 640×480（水平 FOV 68°）、正面 1.0 d0 = 0.74m（マーカーが 80px に映る距離）。斜めは原点マーカーをその角度・距離から見る。
HUD を 20 回読んで、追跡中だった割合（検出率）・`self=`（自分の位置）のフェイクカメラの位置からの誤差・正規化再投影誤差・検出 1 回の処理時間（swiftshader の CPU）。

| 条件 | 検出器 | 検出率 | 自分の位置の誤差 平均 / 最大 [m] | 再投影誤差 | 検出時間 [ms] |
| --- | --- | --- | --- | --- | --- |
| 正面 1.0d0 | apriltag dec2 | 100% | 0.010 / 0.010 | 0.00 | 9〜11 |
| 正面 1.0d0 | apriltag dec1 | 100% | 0.001 / 0.001 | 0.00 | 14〜35 |
| 正面 1.0d0 | aruco2（08） | 100% | 0.009 / 0.009 | 0.00 | 9 |
| 斜め 45° 1.5d0（1.11m） | apriltag dec2 | 100% | 0.007 / 0.007 | 0.01 | 8〜12 |
| 斜め 45° 1.5d0 | apriltag dec1 | 100% | 0.007 / 0.007 | 0.01 | 13〜17 |
| 斜め 45° 1.5d0 | aruco2（08） | **0%** | - | - | - |
| 斜め 60° 2.0d0（1.48m） | apriltag dec2 | 100% | 0.020 / 0.020 | 0.03 | 8〜9 |
| 斜め 60° 2.0d0 | apriltag dec1 | 100% | 0.013 / 0.013 | 0.01 | 10 |
| 斜め 60° 2.0d0 | aruco2（08） | **0%** | - | - | - |
| 正面 2.5d0（1.85m、黒 32px） | apriltag dec2 | 100% | 0.111 / 0.111 | 0.01 | 6〜17 |
| 正面 2.5d0 | apriltag dec1 | 100% | 0.071 / 0.071 | 0.00 | 9〜22 |
| 正面 2.5d0 | aruco2（08） | **0%** | - | - | - |

読み方:

- **正面 1.0d0 は 08 と同じ位置に来る**（1cm 以内。座標系の変換が合っている）
- **合成映像では、斜め 45°・60° と 2.5 倍の距離で js-aruco2 は 1 回も検出できず、AprilTag は 100% 検出できた**。斜め 60°・1.5m でも位置の誤差は 2cm。ただし合成映像はノイズ無しの完璧な四角形なので、実機の差はこれより小さい可能性がある（js-aruco2 が斜めで落ちる原因は輪郭の多角形近似の閾値と考えられるが未調査）
- 遠く（2.5 倍、黒い正方形が 32px）では AprilTag も位置が 7〜11cm ずれる（`decimate=1` で 7cm）。距離の誤差は「画素あたりの奥行き」で決まり検出器の差ではない。実用距離は 08 と同じく一辺の 10〜20 倍
- 検出時間は js-aruco2 と同程度（既定の decimate=2 で 6〜12ms、decimate=1 で 10〜35ms。ヘッドレスの CPU 値。iPhone は未計測）
- 傾き（ピッチ / ロール）の推定は同じ「平面 4 点」なので改善しない前提。`gravityAlign` は 08 と同じく既定 on

### ゲームの流れ（同じスクリプト）

2 ウィンドウ（AprilTag、合成の手）+ 俯瞰画面で、入室 → 練習で連射が受理され得点 → 追加マーカー（正面 2 枚目 ID 5）を配ると 2 枚同時に使い spread < 5cm → 原点を隠しても ID 5 だけで追跡が続き位置が動かない → 対戦開始 → 試合中の得点が全員で一致 → 途中終了 → 結果を閉じて練習、まで PASS。

## 実機で確認すべき項目（未確認）

- iPhone（iOS Safari）で WASM が読めて `apriltag=ready` になるか（`public/vendor/apriltag/` の配信。HTTPS の dev サーバー）
- 実カメラでの検出時間（HUD の `april=… NNms`）。`detW=960` + `decimate=2` で 08 の js-aruco2（20ms 前後）と比べる。遅ければ `?aprilDecimate=3` か `?detW=640`
- 印刷した tag36h11（`markers.html`）が 08 の ArUco と同じ距離（150mm で 1.5〜3m）で検出できるか。**斜め（壁に対して 45〜60°）と遠く（3m）で 08 より粘るか**が本題
- 位置合わせの正しさ: 正面で `self=` が実測の立ち位置と合うか、壁と床の枠が実物に重なるか（08 と同じ確認）。`err=` が 0.0x のままか（0.5 前後なら座標系の取り違え）
- 実カメラのノイズで `?aprilSigma=0.8` が要るか
- 08 と同じ項目: 手の検出、連射、俯瞰画面からの対戦開始、相手の位置

## 既知の制約

- 傾きの誤差は残る（平面 4 点）。issue #54 の水平化で吸収する前提は 08 と同じ
- WASM はメインスレッドで同期実行（同梱の Web Worker + Comlink のラッパーは unpkg 依存なので使っていない）。iPhone で重ければ Worker 化を検討
- `set_tag_size` は全 ID に同じ実寸（08 の「追加マーカーも同じ大きさ」と同じ前提）
- 符号表は tag36h11 の 0〜249（`MAX_MARKER_ID` と同じ範囲）。250 以上の ID は印刷・合成できない（検出はされるが配置に入れられない）
- 「WASM が無いときのフォールバック」はヘッドレスで自動確認していない（`?detector=aruco2` の経路で同じアンカー + js-aruco2 が動くことは確認）

## ライセンス

- [arenaxr/apriltag-js-standalone](https://github.com/arenaxr/apriltag-js-standalone)（`apriltag_wasm.js` / `.wasm`）: **BSD-3-Clause**（Copyright (c) 2020, The CONIX Research Center）。コミット `f0fe55676265a1251ad36f18bac9939206a59e19` の `html/` 配下のビルド済みを `scripts/fetch-apriltag.mjs` で取得（LICENSE も同じ場所に置く）
- 中の [AprilRobotics/apriltag](https://github.com/AprilRobotics/apriltag)（C ライブラリ。WiseLabCMU の fork をサブモジュールで取り込んだもの）: **BSD-2-Clause**（Copyright (C) 2013-2016, The Regents of The University of Michigan）。`tag36h11.ts` の符号表と bit の座標はその `tag36h11.c` から写した
- どちらも再配布時に著作権表示と免責の記載が要る。`scripts/fetch-apriltag.mjs` が全文を配布物と同じ場所に置く:
  - `public/vendor/apriltag/LICENSE` — apriltag-js-standalone の BSD-3-Clause 全文（コミット `f0fe556` の `LICENSE`）
  - `public/vendor/apriltag/LICENSE.apriltag` — apriltag C ライブラリの BSD-2-Clause 全文（同コミットのサブモジュール `apriltag` が指すコミット `4cdba6a8c6cf4efeb032fa5542da927d4677c035` の `LICENSE.md`）
- 同じサブモジュールのコミットの `tag36h11.c` も `public/vendor/apriltag/` に取得する（テストで `tag36h11.ts` の全 250 件と照合するため）
