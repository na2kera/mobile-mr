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
- **どう対処したか**: 開始タップ内で `document.documentElement.requestFullscreen()` を呼び、非対応・拒否時は従来の `100dvh` 表示のまま続行するフォールバックを実装。実機では console が見えず「何も起きない」の原因切り分けができないため、全画面化の成否・解除イベントを HUD に表示するデバッグ導線も追加した。上端スワイプで全画面解除された後の再全画面化の導線は未対応（未解決）
- **SDK ならどう解決するか（案）**: 「開始ジェスチャーは 1 回しか使えない希少資源」を SDK の中心概念にする。`mr.start()` が 1 タップの中でセンサー許可 → 全画面化 →（必要なら）カメラ許可 → Wake Lock を正しい順序で束ね、それぞれの成否を構造化して返す。`fullscreenchange` による解除検知と再入導線も SDK 側で提供する
- **関連**: `demos/01-stereo-box/main.ts` の `enterFullscreen()` / iPhone の Fullscreen API 対応は iOS 17.2 から: https://bugs.webkit.org/show_bug.cgi?id=267743
