# Pain Points（痛点ログ）

デモ実装中に感じた「苦しいところ」を記録する。ここに蓄積された痛点が Mobile MR SDK の設計材料になる（方針は [CONCEPT.md](CONCEPT.md) 参照）。

記録フォーマットは `.claude/skills/pain-point/SKILL.md` を参照。**新しいものは末尾に追記する**（時系列の古い → 新しい）。

---

## [2026-08-11] Phase 1 / 01-stereo-box: DeviceOrientationControls が許可フローを隠蔽していて制御できない

- **何が苦しかったか**: three-stdlib の `DeviceOrientationControls` はコンストラクタ内で `connect()` → `DeviceOrientationEvent.requestPermission()` を呼ぶ。そのため (1) iOS ではユーザージェスチャー（タップハンドラ）内でインスタンス化しないと許可ダイアログが出ない、(2) 許可結果の Promise がライブラリ内で握りつぶされており、拒否されたことをアプリ側が検知できない（黙って動かないだけになる）
- **どう対処したか**: 開始ボタンのクリックハンドラ内でインスタンス化して回避。拒否検知は未対応（未解決）
- **SDK ならどう解決するか（案）**: `tracker.start(): Promise<PermissionState>` のように許可フローを明示的な async API として公開し、拒否時のエラーとフォールバック（例: タッチ操作）を提供する
- **関連**: 詳細 → [pain-points/01-device-orientation-controls.md](pain-points/01-device-orientation-controls.md) / `demos/01-stereo-box/main.ts` の `startControls()`、`node_modules/three-stdlib/controls/DeviceOrientationControls.js:38-55`

## [2026-08-11] Phase 1 / 01-stereo-box: スマホVR系ライブラリのエコシステムが保守停止している

- **何が苦しかったか**: `DeviceOrientationControls` は three 本体から r134 で削除済み（公式方針は「WebXR を使え」だが iPhone Safari では immersive-vr が使えない）。現役メンテは three-stdlib のみ。レンズ歪み補正・ゴーグルプロファイルを扱う webxr-polyfill / cardboard-vr-display は保守停止・アーカイブ状態。Cardboard 時代（〜2018）でエコシステムが止まっている
- **どう対処したか**: 2眼は three 同梱の `StereoEffect`、頭追従は three-stdlib を採用。歪み補正は Phase 1 では見送り
- **SDK ならどう解決するか（案）**: この空白領域こそが Mobile MR SDK の存在意義。`@mobile-mr/stereo` / `@mobile-mr/tracking` がこの穴を埋める
- **関連**: `docs/CONCEPT.md` §4、three r134 changelog

## [2026-08-11] Phase 1 / 01-stereo-box: three の型定義が別パッケージで、バージョン対応も手動

- **何が苦しかったか**: three@0.185 は型定義を同梱しておらず、`@types/three` を three と同じマイナーバージョンに手動で合わせて入れる必要がある。入れるまで `import * as THREE from 'three'` が型エラー
- **どう対処したか**: `@types/three@^0.185` を devDependencies に追加
- **SDK ならどう解決するか（案）**: SDK は TypeScript で書いて型を同梱し、利用者に @types の追加を要求しない
- **関連**: `package.json`

## [2026-08-12] Phase 1 / 01-stereo-box: DeviceOrientationControls のできること / できないこと / 辛さ

- **何が苦しかったか**: 座標変換（頭追従）自体は十分だが、許可タイミング・許可結果・拒否時 UX・`enabled` の意味がアプリから制御・観測できない。タップ内 `new` 強制、拒否しても開始成功に見える、フォールバック分岐が書けない
- **どう対処したか**: 詳細を別紙に整理。デモ側の回避は開始ボタン内 `new` のみ（拒否検知は未解決のまま）
- **SDK ならどう解決するか（案）**: `HeadTracker.start(): Promise<PermissionState>` で開始〜失敗〜代替を API 境界にする。数学の再発明が目的ではない
- **関連**: 詳細 → [pain-points/01-device-orientation-controls.md](pain-points/01-device-orientation-controls.md) / `demos/01-stereo-box/main.ts` の `startControls()`

<!-- 新しい痛点はここより下に追記 -->

## [2026-08-13] Phase 1 / 01-stereo-box: ブラウザ UI（アドレスバー/タブバー）が VR 表示に被り、消す手段が限定的

- **何が苦しかったか**: iOS Safari では `100dvh` + `touch-action: none` で「全画面風」にしてもアドレスバー・タブバーは消えず、VR ゴーグル装着時に視界へ食い込む。任意要素の Fullscreen API（`requestFullscreen()`）が iPhone で使えるのは **iOS 17.2 以降**で、それ未満は PWA（ホーム画面追加）しか完全な解がない。さらにセンサー許可と同じく「ユーザージェスチャー内で呼ぶ」制約があるため、開始ボタンの 1 タップにセンサー許可 + 全画面化（将来はカメラ許可・Wake Lock も）が集中する。`screen.orientation.lock()` は iOS Safari で使えないため横向き固定もできず、案内 UI 頼みのまま
- **どう対処したか**: 開始タップ内で `document.documentElement.requestFullscreen()` を呼び、非対応・拒否時は従来の `100dvh` 表示のまま続行するフォールバックを実装。実機では console が見えず「何も起きない」の原因切り分けができないため、全画面化の成否・解除イベントを HUD に表示するデバッグ導線も追加した。上端スワイプで全画面解除された後の再全画面化の導線は未対応（→ 同日の後続エントリで解消）
- **SDK ならどう解決するか（案）**: 「開始ジェスチャーは 1 回しか使えない希少資源」を SDK の中心概念にする。`mr.start()` が 1 タップの中でセンサー許可 → 全画面化 →（必要なら）カメラ許可 → Wake Lock を正しい順序で束ね、それぞれの成否を構造化して返す。`fullscreenchange` による解除検知と再入導線も SDK 側で提供する
- **関連**: `demos/01-stereo-box/main.ts` の `enterFullscreen()` / iPhone の Fullscreen API 対応は iOS 17.2 から: https://bugs.webkit.org/show_bug.cgi?id=267743

## [2026-08-13] Phase 1 / 01-stereo-box: 全画面遷移中はセンサー許可ダイアログが出ない（1タップに同居できない）

- **何が苦しかったか**: 開始タップ内で「センサー許可要求 → `requestFullscreen()`」の順に呼んでも、iOS Safari は全画面遷移中／全画面中に許可ダイアログを表示せず、**全画面を解除するまで繰り延べる**（実機で確認: 全画面にはなるがジャイロ無反応 → 全画面解除で初めてダイアログが出る）。ゴーグル装着済みだとダイアログに気づけず、初回訪問では頭追従が死んだままになる。かといって許可の結果を待ってから全画面化すると、ダイアログ操作の間にタップの効力（transient activation）が切れて `requestFullscreen()` が拒否される。つまり**初回訪問は 1 タップで「許可 + 全画面」を完結できない**
- **どう対処したか**: 自前の `DeviceOrientationEvent.requestPermission()` で先に許可を要求し、結果を待ってから全画面化を試みる直列フローに変更。許可済みのリピーターは 1 タップで完結し、初回はダイアログ後に「タップで全画面表示」ボタン（2 タップ目）に落とす。このボタンは上端スワイプで全画面解除された後の再入導線も兼ねる（前エントリの未解決項目を解消）。副次効果として許可拒否もデモ側で検知できるようになった（痛点 #01 の一部をデモレベルで解消）
- **SDK ならどう解決するか（案）**: `mr.start()` は「1 ジェスチャーで完結できる特権操作は限られる」を前提に設計する。許可 → 全画面の直列化、activation 失効時の再タップ UI、解除後の再入導線までをセットで提供し、許可状態を事前判定できない（Permissions API 非対応）ことも吸収する
- **関連**: `demos/01-stereo-box/main.ts` の開始フロー / `demos/01-stereo-box/index.html` の `#fs-button`

## [2026-08-14] Phase 2 / 02-passthrough: パススルーに適した超広角カメラを facingMode では選べない

- **何が苦しかったか**: `getUserMedia({ video: { facingMode: "environment" } })` で取れるのは標準の広角カメラ（26mm 相当・視野約70°）。cover 切り抜き分も含めると実視界よりかなりズームされた映像になり、パススルーとして不自然（実機で確認。「普段の視界よりズームされている」）。パススルーに適した超広角カメラ（0.5x・約106°）を constraints で直接指名する手段がなく、許可取得後に `enumerateDevices()` のデバイス**ラベル文字列**（「背面超広角カメラ」/「Back Ultra Wide Camera」）を正規表現でマッチして `deviceId` で開き直すしかない。ラベルは OS の言語設定依存で、将来の機種・言語で壊れうる。さらにラベルが取れるのは許可取得後なので「一度開いて→止めて→開き直す」の2段階が必須
- **どう対処したか**: `/ultra wide|超広角/i` でラベルをマッチし、ヒットしたら既存トラックを stop して deviceId 指定で開き直す。見つからなければ標準カメラのまま。`?lens=wide` で標準カメラとの比較用の逃げ道も用意
- **SDK ならどう解決するか（案）**: `passthrough.start({ preferredFov: "widest" })` のような意図ベースの API にして、ラベルマッチ・多言語対応・開き直しを SDK 内に隠蔽する。機種ごとのラベル辞書は SDK が保守する（利用者に機種差を意識させない方針そのもの）
- **関連**: `demos/02-passthrough/main.ts` の `openBackCameraStream()`

## [2026-08-14] Phase 2 / 02-passthrough: getUserMedia は解像度を指定しないと 640x480 が返る

- **何が苦しかったか**: 解像度 constraints を省略すると iOS Safari は 640x480 を返し、パススルー映像がかなり粗い（実機で確認）。「デフォルト = そのカメラの標準的な解像度」ではない。width/height の ideal 指定を追加するだけで 1280x720 が取れた
- **どう対処したか**: `{ width: { ideal: 1280 }, height: { ideal: 720 } }` をデフォルトにし、`?camRes=1920x1080` で実機から変更できるようにした。1280x720 では実機（iPhone）でカクつきなし
- **SDK ならどう解決するか（案）**: SDK が用途別プリセット（passthrough なら 720p 基準）を持ち、フレームレート低下を検知したら自動で下げる、等の適応制御も検討
- **関連**: `demos/02-passthrough/main.ts` の `camSize`

## [2026-08-14] Phase 2 / 02-passthrough: iOS はデバイス回転でカメラ映像自体が回転し、縦横比補正が古いままになる

- **何が苦しかったか**: iOS Safari は本体を回すとカメラストリームのフレーム自体を回転させ、`videoWidth` / `videoHeight` が入れ替わる。背景テクスチャの縦横比補正（object-fit: cover 相当の UV 計算）を window の `resize` でしか再計算していないと、映像側のサイズ入れ替わりが window resize より遅れて届くため、回転後に映像が縦に潰れて見える（実機で確認。「縦に歪んでいる」）
- **どう対処したか**: video 要素の `resize` イベント（メディアのフレームサイズ変化で発火）でも補正を再計算するようにして解消
- **SDK ならどう解決するか（案）**: パススルー背景の描画を SDK が持つなら、video resize / orientationchange / fullscreenchange をまとめて監視して常に正しい UV を維持する。利用者には「背景がゆがまない」ことだけを保証する
- **関連**: `demos/02-passthrough/main.ts` の `updateBackgroundCover()` と `video.addEventListener("resize", ...)`

## [2026-08-14] Phase 2 / 02-passthrough: 開始ジェスチャーの奪い合いにカメラ許可が3人目として参加

- **何が苦しかったか**: Phase 1 の「センサー許可 → 全画面化」直列フローに、Phase 2 でカメラ許可（getUserMedia のダイアログ）が加わった。1 タップで完結できる特権操作は限られるため、初回訪問は「センサー許可 → カメラ許可 → （activation 失効で全画面化は拒否）→ 再タップで全画面」という流れになる。ダイアログが増えるほど初回体験が長くなる構造的な問題で、今後 Wake Lock 等が加わるとさらに悪化する
- **どう対処したか**: ダイアログを伴うもの（センサー → カメラ）を先に直列で済ませ、最後に全画面化を試みる順序に固定。失敗時は既存の #fs-button（再タップ導線）に落とす。各段階の成否は HUD に表示
- **SDK ならどう解決するか（案）**: `mr.start()` が必要な特権操作のリストを受け取り、「ダイアログ系を先に・ジェスチャー消費系を最後に」の順序制御と再タップ導線を一括提供する（Phase 1 の同種エントリの拡張。デモごとに毎回この開始フローを書いており、ボイラープレート化のシグナル2回目）
- **関連**: `demos/02-passthrough/main.ts` の開始フロー / PAIN_POINTS「全画面遷移中はセンサー許可ダイアログが出ない」

## [2026-08-14] Phase 2 / 02-passthrough: カメラ映像と仮想カメラの FOV が一致せず、スケール感の正解が分からない

- **何が苦しかったか**: 背景のカメラ映像は「カメラの実 FOV の範囲」を「仮想カメラの FOV いっぱい」に引き伸ばして描くため、両者がズレていると現実のスケール感と 3D オブジェクトのスケール感が合わない。ゴーグルのレンズ倍率も加わるため、机上で正解値を計算できず、実機 + ゴーグルで見ながら合わせ込むしかない
- **どう対処したか**: `?camZoom=` で背景の表示倍率を実機から調整できるようにした（1 未満で広く表示。映像の外はフチの色が伸びる妥協）。厳密な FOV マッチングは未解決
- **SDK ならどう解決するか（案）**: デバイスごとのカメラ実 FOV（機種 DB or MediaTrackSettings から取得）とゴーグルプロファイル（レンズ FOV）を持ち、`camZoom` に相当する補正を自動計算する。Phase 3 の共通座標系でも精度に効いてくるはず
- **関連**: `demos/02-passthrough/main.ts` の `CAM_ZOOM` / `updateBackgroundCover()`

## [2026-08-14] Phase 2 / 02-passthrough: getUserMedia を使うデモは PC で自動テストできない

- **何が苦しかったか**: macOS のヘッドレス Chrome では `--use-fake-device-for-media-capture` 等のフラグを付けても getUserMedia の Promise が resolve せず（pending のまま）、さらに canvas `captureStream()` も fps 指定の自動キャプチャではフレームが video 要素に届かないことが多い（`readyState=4` なのに `currentTime=0` のまま）。「背景が真っ黒」の原因がコードかテスト環境か切り分けるのに時間を溶かした
- **どう対処したか**: デバッグ用 URL パラメータを用意: `?autostart=1`（開始ボタン自動押下）+ `?fakecam=1`（canvas `captureStream(0)` + `requestFrame()` 明示送信のテストパターンをカメラ代わりに使う）。requestFrame 方式でヘッドレスでもおおむね安定。実カメラ経路の検証は実機のみ
- **SDK ならどう解決するか（案）**: SDK にモックカメラソース（テストパターン注入）を一級機能として持たせ、CI で描画経路を検証できるようにする。「円が真円で表示されれば縦横比補正が正しい」のような自己診断パターンも同梱する
- **関連**: `demos/02-passthrough/main.ts` の `createFakeCameraStream()`

## [2026-08-16] Phase 3-4 事前調査: ブラウザだけがハードウェアから隔離されていて、測位手段を自前で選べない

- **何が苦しかったか**: Phase 3（共通座標系）・Phase 4（マルチプレイヤー）の方式を検討したところ、ネイティブアプリなら当然使える測位・発見手段が**ブラウザからは軒並み使えない**ことが分かった。(1) **端末発見**: UDP ブロードキャスト / mDNS / 生ソケットがすべて塞がれており、「同じページを開いている端末」を LAN 内で探す手段がない（WebRTC の ICE candidate はローカル IP を `.local` の mDNS 名に隠す＝むしろ発見を防ぐ方向）。(2) **BLE ビーコン**: iBeacon の読み取りは CoreLocation（ネイティブ）必須。Web Bluetooth の `requestLEScan()` は Chrome で実験扱い、**Safari は Web Bluetooth 自体が非対応**。(3) **UWB**: 最も皮肉で、**iPhone 11 以降には U1/U2 チップ（UWB）が最初から載っている**のに、それを使う Nearby Interaction API はネイティブ専用で Safari から一切触れない。つまり「スマホに既に入っている UWB が使えないので外付け UWB モジュールを貼り付ける」という構図になる。(4) **外付けマイコン**: Web Bluetooth / Web Serial / WebUSB がいずれも iOS Safari 非対応のため、マイコンをスマホに繋いでもブラウザから読めない。比較対象として Unity ベースの STYLY は、LBE 向け SDK で「ローカルネットワーク内のサーバー自動発見」と最大100台同期を実現している（ネイティブなので OS のソケットを直接叩ける）。**実装力の差ではなくサンドボックスの差**である
- **どう対処したか**: 「直接繋ぐ」を諦めて**サーバーで合流させる**方針に倒す。(a) 端末発見は QR マーカーに room ID とサーバー URL を埋め込み、マーカーが World Origin と Room の入場券を兼ねる形で代替する（STYLY の mDNS 自動発見と体験上は等価にできる。ただし「全員が同じマーカーを物理的に見に行く」必要があるため大人数会場には向かない＝スケールでは明確に劣る）。(b) 外付けハードを使う場合も、マイコンをスマホに繋がず ESP32 の WiFi から Phase 4 のサーバーへ直接送り、ブラウザは WebSocket で受け取る（同じ頭に付いているだけで論理的には別クライアント）。なお外付けハード案自体は本線ではなく、QR マーカーが実用に耐えなかった場合の実験ブランチとして CONCEPT.md に記載するに留めた。**未解決**: ブラウザのまま 6DoF を得る手段（視覚オドメトリの自力実装）は未着手
- **SDK ならどう解決するか（案）**: この制約は SDK でも吸収しきれない部類で、**`@mobile-mr/network` にサーバー実装が必須になる**という設計上の帰結として受け入れる（「サーバー不要の P2P」は API として提供できない）。その上で SDK が隠蔽すべきは「利用者がサーバーの場所を知らなくていい」体験のほうで、QR / URL パラメータから room とエンドポイントを解決する導線を `@mobile-mr/spatial` と `@mobile-mr/network` の境界に置く。また `space.origin` を `"marker"` 以外に差し替え可能な口にしておき、将来 UWB 等の外部測位ソースを「位置を供給するプラグイン」として挿せる形にすれば、コンセプト（普通のスマホ + URL だけ）を標準経路として保ったまま拡張だけ許容できる
- **関連**: `docs/CONCEPT.md` Phase 3 の「前提となる制約：現状は 3DoF しかない」「うまくいかなかった場合の代替案」/ STYLY の LBE 向けオープンソース SDK: https://styly.inc/news/open-source-solution-for-lbe/

## [2026-08-16] Phase 3 / 03-marker-anchor: js-aruco2 が古い CJS 形式で、そのままでは Vite(rolldown) から import できない

- **何が苦しかったか**: js-aruco2 は `this.AR = AR;`（top-level `this` への代入）+ `require()` という2011年由来のモジュール形式で、Vite 8 (rolldown) が exports を静的検出できず、default / named どちらの import もビルドエラー（`"AR" is not exported`）になる。加えて型定義も同梱していないため `@types/three` と同種の型問題も再発（こちらは対応パッケージすら無いので自前宣言が必要）。Phase 1 で記録した「スマホVR系ライブラリのエコシステムが保守停止している」の再確認で、コードの中身以前に「現代のツールチェーンに載せる」段階で工数を食う
- **どう対処したか**: vite.config.ts に読み込み時変換プラグイン（`jsAruco2Esm`）を書き、`this.X = X;` → `export { X };`、`var CV = this.CV || require('./cv').CV;` → `import { CV } from "./cv.js";` の行単位書き換えで ESM 化した。dev の事前バンドルはプラグインを通らないため `optimizeDeps.exclude` とセットで運用。型は使用範囲だけの `js-aruco2.d.ts` を自前宣言。変換の妥当性は Node で patched ファイルを import して検出まで動かすスモークテストで確認した
- **SDK ならどう解決するか（案）**: SDK は依存を TypeScript + ESM で自己完結させ、利用者のビルド設定に一切の細工（プラグイン・exclude・自前 d.ts）を要求しない。マーカー検出を既存ライブラリに委譲する場合も、この変換ごと SDK 内部に閉じ込める
- **関連**: `vite.config.ts` の `jsAruco2Esm` / `demos/03-marker-anchor/js-aruco2.d.ts` / PAIN_POINTS「スマホVR系ライブラリのエコシステムが保守停止している」

## [2026-08-16] Phase 3 / 03-marker-anchor: js-aruco2 の許容ハミング距離の既定値が緩すぎて偽検出する

- **何が苦しかったか**: `AR.Detector` の許容ハミング距離の既定は辞書の `tau`（ARUCO_MIP_36h12 で 12/36bit）で、ノイズのないテストパターン画像ですら正解 ID 0 に加えて偽 ID 97（ハミング距離10）を検出した。OpenCV の ArUco が既定で厳しめの誤り訂正なのと対照的に、ライブラリの既定値をそのまま使うと「たまに部屋の模様がマーカーとして誤検出される」品質になる。既定値が安全側でないことへの注意書きもドキュメントに無い
- **どう対処したか**: `new AR.Detector({ maxHammingDistance: 4 })` に絞った。Node のスモークテスト（合成画像に対する検出）で 4 なら正解のみ・誤検出なしを確認
- **SDK ならどう解決するか（案）**: SDK の既定値は「誤検出しない側」に倒し、緩める場合だけ利用者が明示する。また合成画像でのセルフテスト（真値が既知のパターンを検出させて精度を確認する仕組み）を SDK のテスト基盤として持つ（02 のモックカメラ案の拡張）
- **関連**: `demos/03-marker-anchor/marker-detector.ts` / スモークテスト結果: maxHam=12 → [0, 97]、maxHam=4 → [0]

## [2026-08-16] Phase 3 / 03-marker-anchor: カメラの焦点距離（内部パラメータ）がブラウザから取得できず、姿勢推定の精度が推測値頼み

- **何が苦しかったか**: マーカーの姿勢推定（POSIT）には焦点距離 [px] が必須だが、ブラウザにはカメラの内部パラメータを取得する API が無い（ネイティブの ARKit はキャリブレーション済み intrinsics を提供する。ここでもブラウザだけが取り残されている）。`MediaTrackSettings` にも焦点距離・FOV は含まれない。仕方なくレンズ種別（超広角/標準）をラベル文字列から推定し、機種平均の水平 FOV（106°/68°）から換算しているが、実際の FOV は機種ごとに違ううえ、iOS がストリームに施す切り抜きでも実効 FOV が変わるため、距離・スケールの誤差として直接効いてくる。Phase 2 の「カメラ実 FOV と仮想カメラ FOV の不一致」と同根で、今回は見た目の違和感ではなく**座標の精度**に効く分だけ深刻
- **どう対処したか**: `?camFov=` で実機から補正できるようにした（フェイクカメラでの理論値検証では、焦点距離→距離の換算チェーン自体の正しさは確認済み: 期待 0.247m に対し実測 0.248m）。機種ごとの正確な値の取得は未解決
- **SDK ならどう解決するか（案）**: 機種 DB（機種名 → レンズごとの実測 FOV/焦点距離）を SDK が保守する。加えて「既知サイズのマーカーを既知距離から映すキャリブレーションモード」を提供すれば、機種 DB に無い端末でも1回の採寸で補正値を得られる。Phase 2 の camZoom 補正と統合して「実カメラ・仮想カメラ・レンズの3つの FOV を一元管理する」層を作る
- **関連**: `demos/03-marker-anchor/main.ts` の `camHFovDeg` / `demos/03-marker-anchor/marker-detector.ts` の focalLengthPx / PAIN_POINTS「カメラ映像と仮想カメラの FOV が一致せず、スケール感の正解が分からない」
