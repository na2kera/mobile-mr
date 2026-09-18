# ブラウザで「計測」（iPhone の計測アプリ相当）はできるか — 調査メモ（issue #53）

2026-09-11 に調べた。「iPhone の『計測』アプリのように、現実の長さ・距離をブラウザだけで測れれば、コートの寸法やマーカーの位置をもっと正確に扱える」という issue #53 の問いに対する調査結果と、このプロジェクトでの現実的な選択肢をまとめる。
情報源は WebKit / Chrome / W3C / Apple の一次資料と、2026 年時点の各社の解説記事。**実機で試したものは無い**（すべて文献調査。「未検証」の欄はそのまま未検証）。

## 結論（先に）

1. **iOS Safari では、計測アプリと同じ仕組みはブラウザから一切使えない**。計測アプリは ARKit の VIO（カメラ + IMU の融合）と平面検出、Pro 機種では LiDAR で動くが、Safari にはそのどれも露出していない。WebXR の AR 系（`immersive-ar` / hit-test / depth-sensing / plane-detection）は 2026-09 時点で iOS Safari に無く、Apple が WebXR を出しているのは visionOS の `immersive-vr` だけ
2. **Android Chrome なら WebXR の `immersive-ar` + hit-test で「2 点を置いて距離を出す」がそのまま作れる**（計測アプリの基本操作と同じ。ARCore 対応機 + Google Play 開発者サービス (AR) が必要）。ただし手持ちモード専用で、このプロジェクトのゴーグル（ステレオ）表示とは同時に使えない
3. このプロジェクトで「より正確にいろいろ」やるなら、**既に持っている定規 = 既知寸法の ArUco マーカー**を計測に転用するのが現実的。マーカーが貼ってある面の上なら、視線と面の交点として今日の iPhone Safari でも点が置け、2 点間の距離が出せる（§4）。焦点距離が取れない問題（PAIN_POINTS Phase 3）が精度の上限になるので、その較正も「計測」の一部として組み込む

## 1. 計測アプリは何でできているか

| 部品 | 中身 | ブラウザ（iOS Safari）で相当するもの |
| --- | --- | --- |
| 自己位置（6DoF） | ARKit の VIO（visual-inertial odometry）。カメラの特徴点の動きと、加速度・ジャイロを高レート・同期タイムスタンプで融合し、**IMU からメートル単位のスケール**を得る | 無し。取れるのは `deviceorientation` の 3DoF（回転だけ）。位置はマーカーからしか出ない |
| 平面 | 特徴点の集まりから床・机・壁を検出 | 無し。マーカーを貼った面だけが「既知の平面」 |
| 点を置く | 画面中心のレイと平面・メッシュの交差（hit test） | 自前のレイと「マーカー平面」の交差なら可能（07 の Surface と同じ数学） |
| 深度（Pro 機種） | LiDAR の飛行時間から直接距離。ARKit の scene reconstruction でメッシュ化 | 無し。`getUserMedia` は色の映像だけ |
| カメラの内部パラメータ | ARKit が較正済み intrinsics を渡す | 無し。`MediaTrackSettings` に焦点距離・FOV は含まれない（PAIN_POINTS「カメラの焦点距離（内部パラメータ）がブラウザから取得できず」） |

精度の目安（外部サイトの比較。Apple 自身は「概算」と明記）: iPhone 12 Pro（LiDAR あり）で誤差 0.23 インチ ≈ 6mm、iPhone 12（LiDAR なし、VIO のみ）で 1.27 インチ ≈ 32mm。つまり LiDAR 無しの VIO でも数 cm、LiDAR で数 mm。ブラウザから目指せるのは前者（VIO 相当）の水準が上限で、それも 6DoF が無い今は届かない。

## 2. ブラウザで使える API の状況（2026-09 時点）

| 手段 | iOS Safari | Android Chrome | 備考 |
| --- | --- | --- | --- |
| WebXR `immersive-ar` | × | ○（ARCore 対応機。Chrome 81 以降） | Apple は visionOS でも AR モジュール未実装。2024-01 の Apple エンジニアの回答は「AR セッションは未対応で、対応の議論も無い」 |
| WebXR Hit Test | × | ○ | 計測アプリの「点を置く」相当。Three.js 製の計測デモ（WebXR-Measure）が公開されている |
| WebXR Depth Sensing | × | ○（ARCore Depth API 対応機のみ） | Quest 3 の Horizon Browser も対応。iOS は無し |
| WebXR Anchors / Plane Detection | × | Anchors ○ / plane-detection は実験扱い | |
| WebXR Raw Camera Access | × | ○ | AR セッション中のカメラ画素。ARCore の姿勢と同期した映像が取れる（iOS の `getUserMedia` には無い性質） |
| WebXR `immersive-vr`（ステレオ） | ×（visionOS の Safari のみ） | 電話では非対応 | ゴーグル表示は今後も自前（StereoEffect）。Android でも AR と両立しない |
| AR Quick Look / `<model>` | ○（Safari 27 で `<model>` が iOS に来る） | Scene Viewer | 実寸で「置いて見る」だけ。計測値をページに返す口が無い |
| App Clip 経由の ARKit（Variant Launch、Onirix Clip 等） | ○ | — | Web から App Clip を起動して ARKit を使う。**「ブラウザだけ」の枠外**（Apple の配布・審査が要る） |
| WebAssembly SLAM（8th Wall） | ○ | ○ | カメラ映像と IMU を自前で処理する SLAM。2026-02-28 に商用サービス終了 → 8thwall.org でオープンソース化。ただし **SLAM 本体はバイナリ配布のみ**（MIT なのは枠組み・Image Targets・Face Effects）。絶対スケールは「端末を前後に動かして推定」する方式で、精度は公表値なし |
| `getUserMedia` の zoom / intrinsics | × | zoom ○ / intrinsics × | どのブラウザでも焦点距離は取れない |
| DeviceMotion の二重積分 | ×（発散） | ×（発散） | 加速度の積分誤差は時間の 3 乗で増える。数秒でメートル級にずれ、計測には使えない |

補足:

- caniuse は iOS Safari 26.6 以降を「WebXR あり・既定で無効」と表示するが、WebKit の 26.5 / 26.6 のリリースノートに WebXR の記述は無く、Apple の公式の立場は「visionOS の `immersive-vr` のみ」のまま。フラグがあっても AR モジュール（hit-test 等）は無いので、計測の観点では「無い」と扱う
- WebKit の機能ステータスページは廃止され、MDN / caniuse を見ろとなっている。iOS の WebXR は Apple の公式ブログと Developer Forums の回答が一次資料

## 3. 深度をソフトで作る（単眼深度推定）

- Depth Anything V2 の small（fp16 で約 50MB）は transformers.js + WebGPU で PC なら 200ms 未満で動く。iOS Safari も 26 で WebGPU が来たので原理上は動く。**ただし iPhone での速度・発熱は未検証**（PAIN_POINTS「熱制限」の懸念がそのまま乗る）
- transformers.js で使えるのは**相対深度**（`onnx-community/depth-anything-v2-small`）。メートル単位の Metric 版（`Depth-Anything-V2-Metric-Indoor-*`）は ONNX 変換が通らず未対応（issue #1476、2025-12 起票・未解決）。Apple の Depth Pro は焦点距離ごと推定する Metric モデルだが、PC の GPU で 0.3 秒の重さで、スマホのブラウザ向きではない
- 相対深度でも**マーカーが映っていればスケールが決まる**（マーカーまでの距離は POSIT で分かる）。「画面全体の奥行きの目安」は作れるが、単眼推定の誤差（平らな壁がたわむ、境界がにじむ）を考えると、**計測より手のオクルージョン（issue #14）の一般化**（手以外の現実の物体も隠す）の方が用途として合う

## 4. このプロジェクトで現実的にできること（案。優先順）

前提: 使えるのは「既知寸法のマーカー（定規）」「3DoF の頭の向き」「MediaPipe の手・体（実寸は個人差で ±半分）」「複数台が同じマーカー座標系を共有していること」。

### 案 1: マーカー 2 枚の自動キャリブレーション（相対位置の計測）— 最小

- **何**: 2 枚のマーカーが同時に映った瞬間に、2 枚の姿勢の差（原点マーカー → 追加マーカーの変換）を記録する。マルチマーカー（issue #30）の「相対位置は手動計測」を置き換える。CONCEPT.md Phase 3 に「自動キャリブレーション（未着手）」として既に載っている
- **精度の性質**: 同じフレーム内の 2 枚なら、**画面上の左右方向の間隔は焦点距離の誤差に効かれない**（POSIT の並進は z ∝ f × 寸法 / 画素、x = (u − cx) × z / f なので f が約分される）。奥行き方向の差だけが焦点距離の誤差（機種で ±10% 程度）を受ける。同じ壁に貼った 2 枚（奥行きが同じ）なら、焦点距離の不確かさがほぼ消える
- **必要なもの**: `marker-detector.ts` は同一フレームの複数 ID を返せる。`marker-anchor.ts` の `extraMarkers` は「配置 → アンカー」の逆変換を持つので、その逆（「2 枚の姿勢 → 配置」）を足し、俯瞰画面の入力欄に流し込む。サーバー状態（`config.markers`）とプロトコルは変えない
- **できないこと**: 2 枚が同時に映る距離（マーカー 1 辺の 10〜20 倍以内）でしか使えない。部屋の反対側の壁同士は無理

### 案 2: 「計測モード」— マーカーの面の上で 2 点を置いて距離を出す

- **何**: 計測アプリの体験に一番近い形。マーカーを貼った面（壁・床）を既知の平面とし、画面中央の視線（07 の指差しと同じレイ）と面の交点に点を置く。2 点置くと距離を表示、3 点以上で折れ線。iPhone Safari で今日動く
- **用途**: コートの幅・高さ・奥行き（俯瞰画面の入力欄に手で入れている値）を、その場で壁の端を見て測る。マーカーの高さ（床からマーカー中心まで）も、床マーカーがあれば壁との交線で測れる
- **精度の性質**: 点の位置は「マーカーの姿勢推定の誤差 × マーカーからの距離」で悪化する。マーカーの面の向き（法線）の誤差 1° は、マーカーから 3m 離れた点で約 5cm のずれ。壁の端を測るならマーカーを壁の中央に貼り、端はそこから 1.5m 以内、が目安。距離の絶対値は焦点距離の誤差を受ける（案 3 で詰める）
- **できないこと**: 面から浮いた物（机の上の物、人）は測れない。面が既知でない場所は測れない
- **ゴーグルと**: 視線で点を置くのでゴーグル装着中でも操作できる（確定はタップか長押し。08 の構えと同じ）。手持ちでも動く

### 案 3: カメラ焦点距離の較正（計測の前提を計測する）

- **何**: 「既知サイズのマーカーを、メジャーで測った既知の距離から映す」だけの較正ページ。POSIT が返す距離が実測と合うように `camFov` を逆算し、URL パラメータ（現状 `?camFov=`）または端末ごとの保存値にする。PAIN_POINTS Phase 3 の「SDK ならどう解決するか」に書いた案で、案 1・2 の絶対値の精度を決める
- **付随して測れるもの**: iOS がストリームに施す切り抜きの実効 FOV、レンズ（超広角 / 標準）ごとの値。機種 DB の種になる
- **費用**: 小さい。既存の 03 の計算経路をそのまま使い、入力欄と逆算だけ

### 案 4: Android Chrome の WebXR 計測ページ（手持ち専用）

- **何**: Android 端末があるなら、`immersive-ar` + hit-test で床・壁に点を置いて寸法を測り、結果を俯瞰画面の入力欄（コート寸法・マーカー位置）にサーバー経由で流し込む「測量役」のページ。計測アプリ相当の精度（数 cm）が期待できる
- **制約**: iPhone では動かない。手持ちモードのみ（ゴーグル装着中は不可）。この用途だけのために Android を用意するかは要判断。Chrome 向け導線（PR #28）はあるので、実機があれば試す価値はある

### 案 5: 複数台の三角測量（先の話）

- **何**: 複数のスマホが同じマーカー座標系を共有しているので、2 台から同じ物（人の頭 = 09 の検出、手 = 05 の検出、あるいはタップで指した画面上の点）を見れば、視線の交点で 3D 位置が出る。単眼の「実寸の仮定」（handScale 等）に頼らない距離が取れる
- **制約**: 各端末の姿勢誤差（3DoF + マーカー）がそのまま乗る。2 台の視線がほぼ平行（並んで見る）だと交点が定まらない。今の痛点（マーカーからの距離で位置がぶれる）が先に効くので、案 1〜3 の後

### 採らない案

- **App Clip / ネイティブの補助アプリ**: ARKit がそのまま使えて一番正確だが、「URL を開くだけ」のコンセプトの外。SDK の段階で「6DoF を供給するプラグイン」の一例として検討するにとどめる（PAIN_POINTS「ブラウザだけがハードウェアから隔離されていて」の UWB と同じ扱い）
- **WebAssembly SLAM の自力実装 / 8th Wall のバイナリ**: 自力実装は段階 2（別リポジトリ）の話で、今の段階では手を出さない。8th Wall の SLAM はバイナリ配布のみでライセンスの条件（著作権表示）と保守の見込みが不明瞭なので、「動くなら参考にする」以上にはしない
- **DeviceMotion の積分**: 数秒で発散するので計測には不向き。振り（Joy-Con）のような短時間・相対の検出にだけ使う

## 5. 痛点として残すこと

「計測」は結局、**焦点距離が取れない（内部パラメータ）**と**6DoF が無い（VIO）**の 2 つに帰着する。前者は較正（案 3）で潰せる、後者はマーカーの面に限定する（案 2）ことで回避する、というのがこの段階の答え。PAIN_POINTS に記録済み（2026-09-11 の項）。

## 参考

- Apple Developer Forums「Immersive AR mode of WebXR in visionOS Safari」（2024-01 の Apple の回答: AR セッションは未対応、議論も無い）: https://developer.apple.com/forums/thread/743655
- WebKit「News from WWDC23: WebKit Features in Safari 17 beta」（WebXR は visionOS の immersive-vr）: https://webkit.org/blog/14205/news-from-wwdc23-webkit-features-in-safari-17-beta/#webxr
- WebKit Features in Safari 26.0 / 26.5 / 26.6（WebXR の記述なし）: https://webkit.org/blog/17333/webkit-features-in-safari-26-0/ / https://webkit.org/blog/17938/webkit-features-for-safari-26-5/ / https://webkit.org/blog/18178/webkit-features-for-safari-26-6/
- WWDC26「What's new in WebKit for Safari 27」（`<model>` が iOS/iPadOS/macOS へ。WebXR の言及なし）: https://developer.apple.com/videos/play/wwdc2026/204/
- caniuse WebXR: https://caniuse.com/webxr
- W3C WebXR Hit Test Module: https://www.w3.org/TR/webxr-hit-test-1/ / Depth Sensing Module: https://www.w3.org/TR/webxr-depth-sensing-1/ / Raw Camera Access: https://immersive-web.github.io/raw-camera-access/
- Google「WebXR compared to ARCore」（Chrome の AR は ARCore 経由。Hit Test / Anchors / Depth / Lighting）: https://developers.google.com/ar/develop/webxr/arcore-comparison
- WebXR-Measure（Three.js + hit-test の計測デモ）: https://github.com/woll-an/WebXR-Measure / 解説: https://woll-an.medium.com/augmented-reality-measure-with-webxr-and-three-js-a0c8355eb91a
- Apple「Understanding World Tracking」（ARKit の VIO）: https://developer.apple.com/documentation/arkit/understanding-world-tracking
- 計測アプリの LiDAR あり / なしの精度比較（Gadget Hacks）: https://ios.gadgethacks.com/how-to/5-improvements-ios-14s-measure-app-are-only-for-iphone-12-pro-12-pro-max-0348417/
- 8th Wall のオープンソース化（SLAM はバイナリのみ）: https://8thwall.org/docs/open-source / https://www.8thwall.com/blog/post/208587408737/8th-wall-open-source
- 8th Wall Absolute Scale（前後に動かしてスケール推定）: https://www.8thwall.com/blog/post/69357938708/introducing-absolute-scale
- Variant Launch「The state of WebXR on iOS」（App Clip 経由の WebXR）: https://launch.variant3d.com/blog/23-06-state-webxr-on-ios-beyond / Onirix Clip: https://www.onirix.com/alternative-to-webxr-on-ios-for-accurate-ar/
- Depth Anything V2（transformers.js + WebGPU）: https://github.com/huggingface/transformers.js/tree/v3/examples/webgpu-video-depth-estimation / Metric 版の未対応 issue: https://github.com/huggingface/transformers.js/issues/1476 / Apple Depth Pro: https://machinelearning.apple.com/research/depth-pro
- 加速度の二重積分の誤差（時間の 3 乗）: https://arxiv.org/pdf/1311.4572
