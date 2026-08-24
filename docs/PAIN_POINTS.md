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
- **関連**: `src/shared/marker-detector.ts`（03 実装当時は demos/03-marker-anchor/ 直下。Phase 4 で共用化のため移動） / スモークテスト結果: maxHam=12 → [0, 97]、maxHam=4 → [0]

## [2026-08-16] Phase 3 / 03-marker-anchor: カメラの焦点距離（内部パラメータ）がブラウザから取得できず、姿勢推定の精度が推測値頼み

- **何が苦しかったか**: マーカーの姿勢推定（POSIT）には焦点距離 [px] が必須だが、ブラウザにはカメラの内部パラメータを取得する API が無い（ネイティブの ARKit はキャリブレーション済み intrinsics を提供する。ここでもブラウザだけが取り残されている）。`MediaTrackSettings` にも焦点距離・FOV は含まれない。仕方なくレンズ種別（超広角/標準）をラベル文字列から推定し、機種平均の水平 FOV（106°/68°）から換算しているが、実際の FOV は機種ごとに違ううえ、iOS がストリームに施す切り抜きでも実効 FOV が変わるため、距離・スケールの誤差として直接効いてくる。Phase 2 の「カメラ実 FOV と仮想カメラ FOV の不一致」と同根で、今回は見た目の違和感ではなく**座標の精度**に効く分だけ深刻
- **どう対処したか**: `?camFov=` で実機から補正できるようにした（フェイクカメラでの理論値検証では、焦点距離→距離の換算チェーン自体の正しさは確認済み: 期待 0.247m に対し実測 0.248m）。機種ごとの正確な値の取得は未解決
- **SDK ならどう解決するか（案）**: 機種 DB（機種名 → レンズごとの実測 FOV/焦点距離）を SDK が保守する。加えて「既知サイズのマーカーを既知距離から映すキャリブレーションモード」を提供すれば、機種 DB に無い端末でも1回の採寸で補正値を得られる。Phase 2 の camZoom 補正と統合して「実カメラ・仮想カメラ・レンズの3つの FOV を一元管理する」層を作る
- **関連**: `demos/03-marker-anchor/main.ts` の `camHFovDeg` / `src/shared/marker-detector.ts`（03 実装当時は demos/03-marker-anchor/ 直下。Phase 4 で共用化のため移動） の focalLengthPx / PAIN_POINTS「カメラ映像と仮想カメラの FOV が一致せず、スケール感の正解が分からない」

## [2026-08-17] Phase 3 / 03-marker-anchor: js-aruco2 POSIT の誤差 API に無効値の罠が2つある

- **何が苦しかったか**: レビューで発覚した2点。(1) POSIT は姿勢計算不能時（平面 POSIT の2解のうちモデル点がカメラ背後に回る枝）に `error=-1`・空の回転 `[[],[],[]]`・空の並進 `[]` を返すが、best/alternative の選択が単純な `error1 < error2` 比較のため **-1（無効）が有効解に必ず勝って best になる**。「無効な best + 有効な alternative」という直感に反する並びが起き、best だけ見ていると空配列アクセス → 行列が NaN → lerp では二度と回復しない（Node で再現確認: 至近距離の正対四角形で bestErr=-1 / altErr=313 になるケースあり）。(2) `bestError.pixels` は再投影誤差の**ピクセル和**で検出解像度にほぼ比例する（1x/2x/4x で 25/46/94）。「誤差 8 以下なら採用」のような絶対値の閾値は detW を変えると意味が変わる。どちらもドキュメントに記載がなく、戻り値の形からは読み取れない
- **どう対処したか**: 境界モジュール（marker-detector.ts）で (1) `error >= 0` かつ回転・並進の全要素が有限であることを検証し、best が無効なら alternative を試し、両方無効ならその観測自体を返さない (2) 誤差をマーカーの画面上の平均辺長で割った正規化値（無次元）に変換してから返す。閾値（maxPoseError 既定 0.5）はこの正規化値に対して設定する
- **SDK ならどう解決するか（案）**: SDK の姿勢 API は「無効な姿勢はそもそも返さない」を型で保証する（error に -1 のような番兵値を混ぜない）。誤差は必ず無次元の正規化値で公開し、ピクセル和のような解像度依存の生値は出さない。境界モジュールに検証を集約するこの構造自体が、既存ライブラリの API の粗さをデモ側に漏らさない実例になった
- **関連**: `src/shared/marker-detector.ts`（03 実装当時は demos/03-marker-anchor/ 直下。Phase 4 で共用化のため移動） の `pickValidPose()` / `node_modules/js-aruco2/src/posit1.js` の `pose()`（error1.euclidean < error2.euclidean 比較と isValid）

## [2026-08-17] Phase 4 / 04-shared-room: 自己署名 HTTPS 運用では wss サーバーを別に立てられず、Vite dev サーバーへの同居が必須になった

- **何が苦しかったか**: マルチプレイヤー用の WebSocket サーバーをどこに立てるかで選択肢が実質1つしかなかった。ページ自体が iOS Safari のセンサー/カメラ制約で HTTPS 必須（Phase 1〜3 で確立済みの自己署名 + LAN 構成）なので、そこから張る WebSocket も `wss://` が必須（mixed content で `ws://` は拒否される）。別ポート・別プロセスでサーバーを立てると、その wss 接続には**ページとは別の証明書検証**が走るが、iOS Safari には「wss のためだけに証明書警告を突破する」UI が存在しない（ページなら警告画面から進めるが、wss はハンドシェイクが黙って失敗するだけでエラーの手掛かりも出ない）。つまり自己署名運用では「ページと同一オリジン・同一証明書」以外の wss は事実上使えない
- **どう対処したか**: WebSocket サーバーを独立プロセスにせず、Vite プラグイン（`configureServer`）として dev サーバーの https サーバーに同居させた。同一オリジンなので証明書警告はページ表示時の1回で済む。副作用として Vite 自身の HMR WebSocket と upgrade イベントを共有するため、パス（`/api/shared-room`）で厳密に仕分けて他のパスには触らないようにする必要がある（雑に `socket.destroy()` すると HMR が死ぬ）
- **SDK ならどう解決するか（案）**: SDK のサーバーコンポーネント（`@mobile-mr/server` 想定）は「既存の http(s) サーバーにアタッチする」形を第一級の API にする（`attachRoomServer(httpServer)`）。開発時は Vite プラグインとして提供し、本番はユーザーのサーバー（正規証明書）に同じ API で載せ替えられるようにする。「dev の自己署名 + iOS Safari」という組み合わせが前提の設計判断であることをドキュメントに残す
- **関連**: `server/shared-room.ts` / `demos/04-shared-room/room-client.ts`（同一オリジンで URL を組む箇所） / PAIN_POINTS「ブラウザだけがハードウェアから隔離されていて、測位手段を自前で選べない」（サーバー必須になった経緯）

## [2026-08-17] Phase 4 / 04-shared-room: bfcache 復帰でカメラ・接続が黙って死んでいる（ライフサイクル管理が毎デモ手書き）

- **何が苦しかったか**: iOS Safari で別ページへ移動して戻ると、ページは bfcache から一瞬で復元されるが、中身のリソースは無事ではない。(1) WebSocket は pagehide で閉じる（閉じないと裏で再接続ループが回り続ける）ため、復帰時に張り直しが要る (2) `getUserMedia()` のカメラストリームは bfcache 復帰後に止まっていることがあり、映像が静止画のまま固まる。しかもどちらも**エラーは出ず黙って死ぬ**ので、実機では「なんか動かない」にしか見えない。pagehide / pageshow(event.persisted) / visibilitychange のどれで何を畳み・張り直すかは完全に手書きで、02/03 はカメラの復帰処理を持っていない（未対応のまま）
- **どう対処したか**: 04 では pagehide で WebSocket を dispose し、pageshow(persisted) で接続だけ張り直す。カメラは復帰させておらず、「カメラ停止の可能性」を HUD に出すだけの妥協。02/03 は未対応のまま
- **SDK ならどう解決するか（案）**: SDK がページライフサイクルを一元管理する（`mr.lifecycle` 層）。pagehide で保持リソース（カメラ・センサー・接続）を宣言的に suspend し、pageshow / visibilitychange で resume を試み、ユーザージェスチャーが再度必要なもの（カメラ再取得等）は「タップで再開」UI を自動で出す。デモごとに手書きしていた畳み方・張り直し方を吸収する
- **関連**: `demos/04-shared-room/main.ts` の pagehide / pageshow リスナー / `demos/04-shared-room/room-client.ts` の `dispose()`

## [2026-08-20] Phase 4 / 04-shared-room: 実機2台テストで判明 — マーカー検出の実用距離が短く、離れると位置がぶれる

- **何が苦しかったか**: iPhone 2台での実機テストで、マーカーが両者の視界にある間は位置一致・追従とも良好だったが、**少し離れるとマーカーを認識できなくなり、相手の頭の位置がぶれやすくなる**。原因は距離とともにマーカーの画面上のサイズが縮むこと: 検出は既定で長辺 640px に縮小した画像で行うため（detW、検出コストとのトレードオフ）、100mm マーカーは 1〜2m 程度（目安: 一辺の 10〜20 倍）で検出限界に達する。検出が途切れると anchor がロスト → 再検出でスナップ、を繰り返して「ぶれ」として見える。マルチプレイヤーでは「プレイヤー間の距離 = マーカーからの距離」になりがちで、部屋規模の体験だと 2〜4m は普通に必要。単一マーカー方式の実用距離の短さが Phase 4 で実害になった
- **どう対処したか**: URL パラメータでの調整で緩和（?detW= で検出解像度を上げる / ?camRes= で入力解像度を上げる / マーカーを大きく印刷して ?markerMm= を両端末で合わせる）。実機での実測: detW=1280 は検出 25〜30ms で描画が実質 30fps まで落ちて重い。**detW=960 が妥協点で、100mm マーカーで約 2.5m まで安定・検出 20ms 前後**。この結果を受けて 04 の既定値を 960 に変更した（03 は単独確認用なので 640 のまま）。根本対策（部屋規模の距離カバー）は未解決
- **SDK ならどう解決するか（案）**: (1) 検出解像度の自動調整 — マーカーが小さくなってきたら detW を動的に上げる（常時高解像度は電池と発熱で不利） (2) マーカーの画面上サイズから「検出限界に近い」ことを検知してユーザーに警告する (3) 本命はマルチマーカー（docs/CONCEPT.md Phase 3 の将来拡張案）で、部屋の複数箇所にマーカーを貼って実用距離を面でカバーする。今回の実害がマルチマーカー着手の判断材料になる
- **関連**: `demos/04-shared-room/main.ts` の DET_W / `src/shared/marker-detector.ts` / docs/CONCEPT.md「将来の拡張案：マルチマーカー」

## [2026-08-21] Phase 5 / 05-hand-interaction: MediaPipe の wasm 配信がバンドラ前提になっておらず、exports と FilesetResolver の決め打ちを迂回した

- **何が苦しかったか**: `@mediapipe/tasks-vision` の標準手順は `FilesetResolver.forVisionTasks(basePath)` に wasm の置き場所ディレクトリを渡す（公式例は jsDelivr の CDN）。中で `${basePath}/vision_wasm_internal.js` と `.wasm` をファイル名決め打ちで探すため、Vite がハッシュ付きファイル名でアセットを出力する build では使えない。さらに package.json の `exports` が `./wasm/*` を公開していないため、`@mediapipe/tasks-vision/wasm/vision_wasm_internal.wasm?url` は rolldown の解決で `is not exported under the conditions` エラーになる（tsc は `?url` の型が vite/client のワイルドカードなので通ってしまい、build で初めて落ちる）。LAN + 自己署名 HTTPS の実機環境で CDN 依存を増やしたくない（「wss は Vite dev サーバーへの同居が必須」と同根）ので、ローカル配信にこだわった
- **どう対処したか**: exports が公開しているサブパス `@mediapipe/tasks-vision/vision_wasm_internal.js` / `.wasm` を `?url` で import し、`WasmFileset`（ローダーと wasm の URL の組）を自前で組み立てて `HandLandmarker.createFromOptions` に渡した。SIMD 版のみ同梱し、`isSimdSupported()` が false の環境は明示エラーにした（nosimd 版も同梱すると dist が約 +11MB）
- **SDK ならどう解決するか（案）**: `@mobile-mr/tracking` が wasm/モデルの配信を引き受け、バンドラ（Vite/webpack）向けのアセット解決をパッケージ側で済ませる。「CDN か自前配信か」は利用者が選べる1つのオプションにする
- **追記（レビューでの確認）**: ローダーは ESM ではなく `<script>` 注入 + グローバル `ModuleFactory` 前提で動くため、CSP やモジュール Worker とは相性が悪い。また Vite dev は存在しないパスへの `fetch`（`Accept: */*`）にも index.html を 200 で返すので、モデルの取得では「HTTP 200 なのに中身が HTML」を自前のサイズ検証で弾く必要があった（実際に必要だったことを curl で確認済み）
- **関連**: `demos/05-hand-interaction/hand-tracker.ts` の import 部分 / node_modules/@mediapipe/tasks-vision/package.json の exports

## [2026-08-21] Phase 5 / 05-hand-interaction: モデル（7.8MB）が npm パッケージに入っておらず、配布を自前で設計する必要があった

- **何が苦しかったか**: HandLandmarker のモデル `hand_landmarker.task` は npm パッケージに含まれず、Google のストレージ（storage.googleapis.com）から実行時に取る前提。LAN 内の実機確認では iPhone 側が毎回インターネットへ取りに行くことになり、電波の弱い会場やオフライン LAN で詰む。かといって 7.8MB のバイナリを git に入れるのも避けたい。`modelAssetPath` に 404 になる URL を渡すと HTML をモデルとして読もうとして分かりにくいエラーになり、フォールバックもできない
- **どう対処したか**: `npm run fetch:models` で `public/models/` に取得（gitignore）し、デモは「ローカル → 公式 URL」の順に自前で `fetch` してサイズを検証してから `modelAssetBuffer` で渡す。HUD に `model=local|remote` を出して、どちらから読んだか実機で分かるようにした
- **SDK ならどう解決するか（案）**: SDK がモデルの取得元・キャッシュ（Cache API）・整合性検証を持ち、利用者は `hands: true` と書くだけにする。Phase 6 以降はモデルが増える（Pose 等）ので取得は1か所にまとめる
- **関連**: `scripts/fetch-models.mjs` / `demos/05-hand-interaction/hand-tracker.ts` の fetchFirst / `demos/05-hand-interaction/main.ts` の MODEL_URLS

## [2026-08-21] Phase 5 / 05-hand-interaction: MediaPipe は手の「カメラからの距離」を返さず、3D 化は自前の最小二乗と FOV の仮定に依存する

- **何が苦しかったか**: HandLandmarker が返すのは「画像上の正規化 2D 座標（z は手首基準の相対値）」と「手の中心を原点とした実寸 3D（worldLandmarks）」で、**カメラ座標系での絶対位置は返さない**。「ボールに触る」には手の絶対位置が要る。さらに画像位置 → 視線方向の換算には FOV が必要だが、実カメラの FOV はブラウザから取得できない（「カメラの焦点距離（内部パラメータ）がブラウザから取得できず」参照）。Phase 2 の「実カメラ・仮想カメラ・レンズの3つの FOV」問題が、ここでは**手の座標の精度**に直接効く
- **どう対処したか**: worldLandmarks の形を画像上の見え方に当てはめ、手の中心の並進 (X, Y, 深度) を 42 本の式の最小二乗（3x3 正規方程式）で解いた。FOV は実カメラではなく**仮想カメラ + 背景の cover 切り抜き**（= 背景に映っている位置）を使い、「背景の手の真上に骨格が重なる」ことを優先した。仮想 FOV が現実とズレていても背景と仮想物体が同じだけズレる（自己整合）。合成データでは厳密に復元できることを Node の回帰テストで確認済みだが、実機での精度（worldLandmarks の実寸がどの程度正確か、ブレの大きさ）は未検証
- **SDK ならどう解決するか（案）**: `mr.hands` が返す座標は「カメラ座標系の実寸」に統一し、FOV の管理（機種 DB・キャリブレーション）と合わせて SDK 内で吸収する。ステレオカメラや深度センサーが使える端末では置き換えられる差し込み口にする
- **関連**: `demos/05-hand-interaction/hand-math.ts` の solveHandPlacement / placeLandmarks、`scripts/test-hand-math.mjs`

## [2026-08-21] Phase 5 / 05-hand-interaction: handedness が「鏡像（自撮り）」前提で、背面カメラでは左右が逆に返る

- **何が苦しかったか**: MediaPipe の handedness（Left/Right）は前面カメラの鏡像映像を前提に付いており、背面カメラ（鏡像でない）では自分の右手が "Left" と返る。ドキュメント上はさりげない注記で、色分けを実装してみるまで気づきにくい
- **どう対処したか**: 背面カメラ用途なのでデモ側でラベルを入れ替えた（R ⇔ L）。前面カメラに切り替えたらまた逆になる
- **SDK ならどう解決するか（案）**: カメラの向き（facingMode / 鏡像かどうか）は SDK が知っているので、handedness の正規化を SDK の責務にする
- **関連**: `demos/05-hand-interaction/main.ts` の applyHandResult（HAND_COLORS のコメント）

## [2026-08-21] Phase 5 / 05-hand-interaction: 「ユーザーの目の前」に物を置く基準が無く、向き合わせのヒューリスティックを自前で書いた

- **何が苦しかったか**: DeviceOrientationControls の yaw はコンパス（北）基準なので、開始時にユーザーがどちらを向いているかは分からない。01/02 は物体を全方位に並べてこの問題を避けていたが、「手の届く所にボールを置く」Phase 5 では避けられない。開始タップはスマホを手に持って下を向いた状態で行われるので、そのときの yaw も当てにならない
- **どう対処したか**: 最初は「開始後、頭が水平になった最初のフレームの yaw」で決めていたが、レビューで2つの穴が見つかった: (1) three-stdlib は最初のセンサーイベントまで `deviceOrientation` を全ゼロ（真下向き）で持つので `camera.quaternion` をそのまま信じられない、(2) 許可ダイアログ中は `controls` が null のままで、それを「頭追従なし」と誤認すると北向きで確定してしまう。現行は「許可フローの決着（sensorSettled）→ 最初の `deviceorientation` 受信 → 横向き + 水平（上下 30° 以内）が 1 秒連続」で確定し、確定後も正面から 90° 超のズレが 3 秒続いたら自動で取り直す（装着中はタップできないため）。45〜90° のズレは直せないまま。実機での挙動は未確認
- **SDK ならどう解決するか（案）**: `mr.recenter()` と「装着検知（頭が水平で安定した）」を SDK が持ち、アプリは「ユーザー正面」座標系に置くだけにする。Phase 3 のマーカー座標系がある場では、マーカー基準で置くことでこの問題自体が消える
- **関連**: `demos/05-hand-interaction/main.ts` の alignStageIfNeeded

## [2026-08-21] Phase 5 / 05-hand-interaction: 手トラッキングは PC で再現できず、検出後の経路を検証するために「合成の手」の注入口を作った

- **何が苦しかったか**: MediaPipe は実際の手がカメラに映らないと何も返さないため、PC（特にヘッドレス）では「手を検出した後」のロジック（3D 化・骨格描画・接触・押下・指差し）が一切動かせない。Phase 2 の「getUserMedia を使うデモは PC で自動テストできない」と同じ構造で、今回は入力がカメラ映像ではなく認識結果
- **どう対処したか**: `?fakehands=1` で MediaPipe を使わず、台本どおり（ボールを横切る → ボタンを押し込む → 的を指差す → 消える）に動く合成のランドマークを applyHandResult に流す。再現手順: `?fakecam=1&autostart=1&fakehands=1` を開いて約 13 秒待つと、HUD のカウンタが `touches>=1 presses>=1 selects>=1` になる（12 秒周期の台本: ボール横切り → ボタン押し込み → 的を指差し → 手なし）。この確認は Playwright でシステムの Chrome を headless 起動して行った（Playwright は依存追加になるのでリポジトリには入れていない）。形状生成と投影は Node の回帰テスト（`npm run test:hand`）と共有している
- **SDK ならどう解決するか（案）**: 「トラッキングソース」を差し替え可能にして、MediaPipe / 録画したランドマーク列 / 台本の合成データを同じ口から入れられるようにする。カメラのモックソースと並べて、CI で操作ロジックまで検証できる形にする
- **関連**: `demos/05-hand-interaction/fake-hands.ts` / `demos/05-hand-interaction/main.ts` の updateFakeHands

## [2026-08-21] Phase 5 / 05-hand-interaction: 単眼パススルーの背景には視差が無く、3D の手やボールと奥行きが矛盾する

- **何が苦しかったか**: 背景（`scene.background` のカメラ映像）は両眼に同じ画像を出すので視差ゼロ（= 無限遠）だが、手の骨格やボールは 0.3〜0.5m に置かれ `eyeSep=64mm` 分の視差が付く。0.4m では片目あたり約 ±32mm（約 4.6°）ずれるので、「背景に映った手の真上に骨格が重なる」のは中心カメラでの話で、装着時は実際の手が遠くに融像し、骨格とボールだけ手前に浮く。「ボールを押す」の体感に直接効く。実装中はこの矛盾に気づかず、コードレビュー（2名とも指摘）で定量化された
- **どう対処したか**: **未解決**（実機で程度を確かめてから選ぶ）。候補は (a) 手のレイヤーだけ視差ゼロで描く（両眼とも中心カメラ位置で描く専用パス）、(b) 背景テクスチャを片目ごとに手の深度ぶん横にずらして近景を合わせる（遠景が二重になる妥協）、(c) 受け入れる。コード上は hand-math.ts の placeLandmarks のコメントと CONCEPT.md §9 の Phase 5 項（既知の制約）に記載
- **実機確認（2026-08-24, iPhone）**: 片目ずつ見ると、骨格が背景の実際の手から**指の横幅 1 本分ずつ**左右にずれることを確認（理論値 eyeSep/2 ≈ 3.2cm と同オーダーで、予測どおり）。骨格の検出・手の動きへの追従自体は良好で、推論の重さも体感で問題なし
- **SDK ならどう解決するか（案）**: ステレオ描画側が「視差を付けないレイヤー」を一級機能として持つ（HUD・手の骨格・背景と一体で見せたいもの用）。Phase 6（バレーボール）の「ボールが手前に飛んでくる」演出は必ずこの問題を踏むので、設計前提として扱う
- **関連**: `demos/05-hand-interaction/hand-math.ts` の placeLandmarks / `demos/05-hand-interaction/main.ts` の camera.add(view.group)

## [2026-08-21] Phase 5 / 05-hand-interaction: 例外 1 回でアニメーションループが止まり、装着中は原因も見えない

- **何が苦しかったか**: three の `setAnimationLoop` はコールバックが throw すると次の `requestAnimationFrame` を予約しない（`WebGLAnimation.js`）。MediaPipe の `detectForVideo` をその中で呼んでいたので、GPU デリゲートが初期化は通るのに初回推論で落ちる端末（iOS Safari で起こり得る）や、回転中のサイズ 0 フレームで例外が出ると、背景・頭追従・HUD がまとめて凍結する。ゴーグル内では「固まった」としか見えず、HUD にも理由が出ない
- **どう対処したか**: 推論を try/catch で隔離し、失敗したら HUD に出して tracker を捨てる。auto で GPU だった場合は一度だけ CPU で作り直す。サイズ 0 のフレームは渡さない。加えて、装着後は HUD が読めないので、ボールの見た目（読み込み中はワイヤーフレーム / ready で実体化 / error で赤）で状態を出すようにした
- **SDK ならどう解決するか（案）**: 「トラッキングの失敗を描画から隔離する」を SDK の責務にする（トラッキングは別のループ or Worker で回し、失敗はイベントとして通知する）。装着中に読める状態表示（視野内の 3D インジケータ）も SDK 側で標準装備にする。01 からの「実機で console が見えない」痛点の装着時版
- **関連**: `demos/05-hand-interaction/main.ts` の onTrackerFailure / showTrackerState

## [2026-08-21] Phase 5 / 05-hand-interaction: メインスレッドの同期推論がステレオ描画のフレーム時間を揺らす（実測待ち）

- **何が苦しかったか**: MediaPipe の推論は同期でメインスレッドを塞ぐ。カメラの 30fps に追従して毎フレーム回すと、描画フレームが「16ms / 推論の分だけ長い」を交互に繰り返すジッタになり、VR では一定の低 fps より酔いやすい。さらに追跡中の手が `numHands` 未満だと毎フレーム全画面の palm detection も走るので、片手しか出さないのに `hands=2` だと常に重い。CPU デリゲートは video をフル解像度で 2D canvas に描いて `getImageData` で読むため、720p のままだと読み戻しだけで重い。iOS Safari では Worker + OffscreenCanvas + `createImageBitmap(video)` の経路が限定的で、逃げ道が狭い
- **どう対処したか**: 既定を `hands=1` にし、`detIntervalMs`（固定間引き）と `detAdapt`（直近の推論時間 × 係数を最小間隔にする）、CPU 時は長辺 640 に縮小して渡す `detW`（03/04 の detW と同じ発想）を用意した。どれが iPhone で良いかは実測で決める（未計測）
- **SDK ならどう解決するか（案）**: 推論を Worker に隔離し、描画ループは「最新の結果を読むだけ」にする。端末ごとの推論時間を見て間引きを自動調整する。これは Phase 6 で Pose も動かすなら必須
- **関連**: `demos/05-hand-interaction/main.ts` の updateHands / `demos/05-hand-interaction/hand-tracker.ts` の detect

## [2026-08-21] Phase 5 / 05-hand-interaction: パススルー + 開始フローのボイラープレートが 4 本目になり、numParam の署名が 2 種類に分岐した

- **何が苦しかったか**: `openBackCameraStream` / `startCamera` / `updateBackgroundCover` / `createFakeCameraStream` / 全画面化 / HUD / `pageshow` のひとかたまり（約 250 行）が 02 / 03 / 04 / 05 に複製されている。`numParam` は 02（min/max なし）と 03/04/05（min/max 付き）で署名が 2 種類に分かれ、同じ名前のパラメータが demo によって受け付ける範囲が違う。05 では手の検出入力の縮小（03/04 の `detW`）を最初持っておらず、レビューで同じ発想を入れることになった（= 共通化されていれば自動的に付いてきた機能）
- **どう対処したか**: 方針どおり今は抽出しない（デモ内に書く）。Phase 6 はこれら全部 + マーカー + 通信 + 手を統合するので、着手前に `src/shared/passthrough-camera.ts` と開始フロー（許可の直列化 + 全画面 + HUD）の抽出を判断する
- **SDK ならどう解決するか（案）**: `@mobile-mr/core` の「カメラ・センサー・全画面の許可フローと背景描画」そのもの。4 本の写しが要求仕様（超広角優先・解像度指定・縦横比補正・回転追従・フェイクカメラ・HUD）になる
- **関連**: `demos/02-passthrough/main.ts`, `demos/03-marker-anchor/main.ts`, `demos/04-shared-room/main.ts`, `demos/05-hand-interaction/main.ts` の各 `numParam` / `startCamera`
