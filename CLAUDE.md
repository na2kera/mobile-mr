# Mobile MR Project

スマートフォン + スマホ用VRゴーグルで、ブラウザだけで動くマルチプレイヤーMR基盤を作るプロジェクト。
構想の全文・ロードマップは **[docs/CONCEPT.md](docs/CONCEPT.md)** を必ず参照すること。

## 一言でいうと

> URLを開いた複数のスマートフォンを、同じ現実空間を共有するMRデバイス群に変える。

最終的には共通処理を「Mobile MR SDK」としてライブラリ化して公開する。

## 進め方の方針（最重要）

- **最初からライブラリ・抽象化を作らない。** デモを試行錯誤で実装し、「どこが苦しいか」を体感してから共通処理を抽出する。痛点の発見がライブラリ設計より先
- フェーズごとのデモは削除・上書きせず、**別ページとして残す**（Viteマルチページ構成、`src/demos/01-xxx/` 形式）。過去のデモが共通化の材料になる
- きれいな設計より「動くものを作って痛点をメモする」を優先する。作業中に見つけた痛点・不満は残すこと

## 技術スタック

- Vite + TypeScript + Three.js（**React等のUIフレームワークは使わない**）
- スタックの変更・ライブラリ追加は勝手に行わず、理由と選択肢を提示して相談する
- WebXR には依存しない。`HeadTracker` / `StereoRenderer` のような interface でスマホ実装と WebXR 実装を差し替え可能にする方針（ただし抽象化を急がない。上記方針を優先）
- **既存ライブラリ（three-stdlib の DeviceOrientationControls、three 同梱の StereoEffect 等）は暫定採用。SDK 化の段階でコア部分は自力実装に移行する方針**。理由: 許可フロー等の制御点をラップでは持てない・拡張の余地がない・依存先が保守停止している・この空白領域こそがプロジェクトの存在意義（詳細: [PR #1 のコメント](https://github.com/na2kera/mobile-mr/pull/1#issuecomment-5255304585)）。移行は一括ではなく、痛点が実害になった箇所から順に行う

## ロードマップ（現在地: Phase 1）

1. **Phase 1: スマホVR** — Three.js シーンを左右2眼レンダリング + DeviceOrientation で頭追従 ← いまここ
2. Phase 2: Passthrough MR — 背面カメラ映像を背景に
3. Phase 3: QR/ARマーカーで現実座標への固定（共通座標系）
4. Phase 4: Multiplayer（WebSocket、Room / position / rotation 共有）
5. Phase 5: MediaPipe で Hand / Body Tracking
6. Phase 6: MRバレーボール（統合ゲーム第1弾）
7. Phase 7-8: Surface Mapping → MRスプラトゥーン
8. Phase 9: 現実の人物と Player ID の対応
9. Phase 10: SDK / ライブラリ化（`@mobile-mr/core` ほか。詳細は CONCEPT.md §6）

## プロジェクトスキル

`.claude/skills/` に定型作業のスキルがある。該当する作業ではまずこれを使うこと：

- **new-demo** — 新しいデモページの追加（ディレクトリ規約・vite.config 登録・一覧ページ更新まで）
- **pain-point** — 開発中に見つけた痛点を `docs/PAIN_POINTS.md` に記録する。痛点の記録はこのプロジェクトの成果物の一部
- **iphone-test** — iPhone 実機（iOS Safari）での確認手順とハマりどころチェックリスト

## 開発環境の前提

- 実機検証は **iPhone（iOS Safari）中心**。VRゴーグル実機あり
- iOS Safari の制約に常に注意:
  - `DeviceOrientationEvent.requestPermission()` はユーザージェスチャー（タップ）起点で呼ぶ必要がある
  - `getUserMedia()` / センサー系は HTTPS（secure context）必須 → 実機確認は LAN + HTTPS の dev サーバーで行う
- 「完了」は実機またはブラウザで実際に動かして確認してから。型チェック（`tsc`）も通すこと
