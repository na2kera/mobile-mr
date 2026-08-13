---
name: iphone-test
description: iPhone 実機（iOS Safari）でデモを確認するための手順とチェックリスト。「実機で確認したい」「スマホで見たい」「iPhoneでテスト」と言われたとき、またはセンサー・カメラを使う変更を検証するときに使う。LAN + HTTPS の dev サーバー起動と iOS Safari 特有の制約チェックを行う。
---

# iPhone 実機確認

このプロジェクトの検証基準は iPhone（iOS Safari）。センサー・カメラ系 API は secure context（HTTPS）必須のため、Mac の dev サーバーを LAN + HTTPS で公開して確認する。

## 手順

1. **HTTPS 設定の確認**: `vite.config.ts` に HTTPS 化の設定（`@vitejs/plugin-basic-ssl` や `vite-plugin-mkcert` 等）があるか確認する
   - 無ければ勝手に追加せず、選択肢（basic-ssl: 手軽だが毎回警告 / mkcert: 初回に CA インストールが必要だが警告なし）を提示して相談する
2. **dev サーバー起動**: `npm run dev -- --host` で LAN に公開する（バックグラウンド起動にして出力を確認する）
3. **URL の案内**: `scutil --get LocalHostName` で Mac のホスト名を取得し、`https://<ホスト名>.local:<port>/`（またはデモの個別ページ URL）を提示する。`.local`（Bonjour）は Mac の IP が変わっても有効なため、IP 直打ち（`ipconfig getifaddr en0`）より優先する。提示前に Mac 自身から curl で疎通確認すること
   - 開けないと言われたら、まず Mac の IP・ネットワークが変わっていないか、iPhone が Mac と同じ SSID にいるかを疑う（このプロジェクトで実際に2回発生）
4. ユーザーの実機確認結果を聞き、問題があれば修正する。**実機で動くまで「完了」と言わない**（自分で確認できない部分は「実機確認待ち」と明記する）

## iOS Safari チェックリスト

実機で問題が出たら、まずここを疑う：

- **センサー許可**: `DeviceOrientationEvent.requestPermission()` / `DeviceMotionEvent.requestPermission()` は**タップ等のユーザージェスチャー内**でしか呼べない。ページロード時に呼ぶと失敗する
- **HTTPS**: `getUserMedia()`・センサー系は HTTP だと undefined / 拒否になる。`http://` で開いていないか確認
- **自己署名証明書**: basic-ssl 利用時は iPhone 側で「詳細を表示 → この Web サイトを閲覧」で警告を突破する必要がある
- **フルスクリーン**: 任意要素の `requestFullscreen()` は iPhone では **iOS 17.2 以降**で対応（それ未満は非対応）。ユーザージェスチャー内で呼ぶこと。上端からのスワイプで解除される。非対応環境向けには `100dvh` + スクロール抑止（`touch-action: none` 等）でフォールバックする
- **画面回転ロック**: `screen.orientation.lock()` は iOS Safari 非対応。「横向きにしてください」の案内 UI で代替する
- **スリープ**: 長時間のデモでは Wake Lock API（`navigator.wakeLock`）を検討（iOS 16.4+ で対応）
- **console が見えない**: 実機のエラーは Mac の Safari → 開発メニューから iPhone を接続して Web インスペクタで確認する（USB 接続 + iPhone 側で「Web インスペクタ」を有効化）

## 痛点の記録

実機確認でハマった点は pain-point スキルの形式で `docs/PAIN_POINTS.md` に記録する。
