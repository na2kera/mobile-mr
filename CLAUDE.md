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

## ライブラリ化の3段階戦略（順番を飛ばさない）

このプロジェクトと「独自ライブラリ」の関係は、次の3段階で進める。

**段階1: 既存ライブラリありで、このプロジェクトを実装しきる ← いまここ**

- three-stdlib の DeviceOrientationControls、three 同梱の StereoEffect、MediaPipe など、使えるものは迷わず使う
- 目的は「動くMR体験を最後まで作ること」と「どこが苦しいかを実体験として貯めること」。**この段階では自力実装をしない**
- 苦しかった箇所は `docs/PAIN_POINTS.md` に必ず残す（pain-point スキル）。これが段階2の要求仕様になる

**段階2: 別プロジェクト（別リポジトリ）で独自ライブラリを作る**

- このリポジトリの中で育てず、**新しいリポジトリで新規に作る**
- 段階1の実装と `docs/PAIN_POINTS.md` を「参照実装 + 要求仕様」として扱い、コア部分（頭追従・ステレオ描画・許可フロー等）はゼロから自力実装する
- 既存ライブラリのラップではなく置き換えを作る。理由は下の「技術スタック」の該当項目を参照

**段階3: このプロジェクトを独自ライブラリで置き換える**

- mobile-mr 側の既存ライブラリ依存を、段階2で作ったライブラリに差し替えていく
- **一括で置き換えない。** デモ単位で、かつ痛点が実害になった箇所から順に
- 置き換え作業そのものがSDKのドッグフーディングであり、APIの使いにくさを洗い出す工程として扱う

## 技術スタック

- Vite + TypeScript + Three.js（**React等のUIフレームワークは使わない**）
- スタックの変更・ライブラリ追加は勝手に行わず、理由と選択肢を提示して相談する
- WebXR には依存しない。`HeadTracker` / `StereoRenderer` のような interface でスマホ実装と WebXR 実装を差し替え可能にする方針（ただし抽象化を急がない。上記方針を優先）
- **既存ライブラリ（three-stdlib の DeviceOrientationControls、three 同梱の StereoEffect 等）は暫定採用。SDK 化の段階でコア部分は自力実装に移行する方針**。理由: 許可フロー等の制御点をラップでは持てない・拡張の余地がない・依存先が保守停止している・この空白領域こそがプロジェクトの存在意義（詳細: [PR #1 のコメント](https://github.com/na2kera/mobile-mr/pull/1#issuecomment-5255304585)）。移行は一括ではなく、痛点が実害になった箇所から順に行う。移行のタイミングと進め方は上記「ライブラリ化の3段階戦略」の段階3に従う

## ロードマップ（現在地: Phase 9 PC 確認済み → 実機確認）

1. ~~Phase 1: スマホVR~~ — Three.js シーンを左右2眼レンダリング + DeviceOrientation で頭追従（完了: `demos/01-stereo-box/`）
2. ~~Phase 2: Passthrough MR~~ — 背面カメラ映像を背景に（完了: `demos/02-passthrough/`）
3. ~~Phase 3: QR/ARマーカーで現実座標への固定（共通座標系）~~ — ArUco マーカーを World Origin に（完了: `demos/03-marker-anchor/`）
4. ~~Phase 4: Multiplayer（WebSocket、Room / position / rotation 共有）~~ — マーカー座標系の pose を交換し相手位置にアバター表示（完了: `demos/04-shared-room/`）
5. ~~Phase 5: MediaPipe で Hand Tracking~~ — 手の 3D 化とボール・ボタン・指差し操作（完了: `demos/05-hand-interaction/`。Body は Phase 9 で扱う）
6. ~~Phase 6: MRバレーボール（統合ゲーム第1弾）~~ — サーバー権威の物理 + bot + 2台対戦（完了: `demos/06-volleyball/`。iPhone 実機 + ゴーグルで確認済み 2026-08-27）
   - Phase 6-2: MR ダーツ（統合ゲーム第2弾。`demos/06-2-darts/`）— 壁のマーカーにボード、手を振って投げる、何人でも参加順に 3 投ずつ。サーバー権威（`server/darts.ts`）。PC（Node テスト + ヘッドレス Chrome）で確認済み、**実機は未確認**（PR #11 マージ済み 2026-08-27）
7. ~~Phase 7: Surface Mapping~~ — 壁のマーカー座標系を Surface にし、指差しの視線で UV を指してペイント、サーバー権威で共有（完了: `demos/07-surface-mapping/`、`server/surface.ts` + 共通化した `server/room-server.ts`。iPhone 実機で確認済み 2026-08-29。PR #12）
8. ~~Phase 8: MRスプラトゥーン~~ — 壁マーカー 1 枚で四方の壁 + 床の箱型コート（3.0×2.5m）を作り、パーの間「目 → 手」の向きへインクを連射（タンク 50 発・自分の色の床の上で回復）、参加順に 8 色の個人戦。サーバー権威の格子で塗りと得点を共有（完了: `demos/08-splatoon/`、`server/splatoon.ts`。**iPhone 実機で確認済み** 2026-09-02。PR #15）
9. **Phase 9: 現実の人物と Player ID の対応（Body Tracking はここで扱う）** — MediaPipe PoseLandmarker で相手の体を検出し、05 と同じ最小二乗で 3D 化、ピアの申告位置と角度 + 距離で 1 対 1 に対応づけて名札を付ける。「誰をどこで見たか」をサーバー経由で相手に返す（PC 確認済み: `demos/09-person-id/`、`server/person.ts`。**実機は未確認**） ← いまここ
10. Phase 10: SDK / ライブラリ化（`@mobile-mr/core` ほか。詳細は CONCEPT.md §6）

Phase 1〜9 は上記「ライブラリ化の3段階戦略」の段階1にあたる。Phase 10 は別リポジトリでの段階2 → このリポジトリへの段階3、の順で進める。

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
