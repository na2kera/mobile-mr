---
name: new-demo
description: 新しいフェーズのデモページを Vite マルチページ構成に追加する。「新しいデモを作って」「Phase N のデモを始めたい」「デモページを追加」と言われたら使う。番号付きディレクトリの作成・トップページへのリンク追加・vite.config.ts への登録までを一貫して行う。
---

# 新しいデモページの追加

このプロジェクトはフェーズごとのデモを削除・上書きせず、別ページとして積み上げる（理由は CLAUDE.md / docs/CONCEPT.md 参照）。

## ディレクトリ規約

```text
demos/
├── 01-stereo-box/
│   ├── index.html   ← このデモのエントリ
│   └── main.ts
├── 02-passthrough/
│   └── ...
src/
└── shared/          ← 複数デモで共通化できた処理だけをここに移す
```

- ディレクトリ名は `NN-slug`（NN はゼロ埋め2桁の連番、slug は英小文字ケバブケース）
- **共通化は急がない。** まずデモ内に書き、2つ以上のデモで同じ痛みを感じてから `src/shared/` に移す

## 手順

1. `demos/` 配下を見て次の連番 NN を決める（`demos/` が無ければ作る）
2. `demos/NN-slug/index.html` と `demos/NN-slug/main.ts` を作成する
   - index.html には `<title>`、トップページ（`/`）へ戻るリンク、`<script type="module" src="./main.ts">` を含める
   - スマホ実機で使うため viewport meta（`width=device-width, initial-scale=1, user-scalable=no`）を必ず入れる
3. ルートの `index.html`（デモ一覧）に新しいデモへのリンクを追加する
4. `vite.config.ts` の `build.rollupOptions.input` に新ページを追加する（dev では不要だが build で必要）。`vite.config.ts` が無ければマルチページ設定込みで新規作成する
5. `npx tsc --noEmit` と `npx vite build` が通ることを確認する
6. CLAUDE.md の「現在地」フェーズ表記が変わる場合は更新する

## 注意

- 新しい npm パッケージが必要になっても勝手に追加しない（理由と選択肢を提示して相談する）
- デモ実装中に「苦しい」と感じた点があれば pain-point スキルの形式で `docs/PAIN_POINTS.md` に記録する
