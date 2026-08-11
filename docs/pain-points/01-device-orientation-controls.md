# DeviceOrientationControls（three-stdlib）のできること / できないこと

- **日付**: 2026-08-12
- **Phase / デモ**: Phase 1 / `demos/01-stereo-box`
- **対象**: `three-stdlib` の `DeviceOrientationControls`
- **実装参照**: `node_modules/three-stdlib/controls/DeviceOrientationControls.js`
- **利用箇所**: `demos/01-stereo-box/main.ts` の `startControls()`
- **親ログ**: [PAIN_POINTS.md](../PAIN_POINTS.md)

このメモは「座標変換が足りないか」ではなく、**許可・失敗・代替入力をアプリ側が扱えるか**に焦点を当てる。SDK 化時に自前 `HeadTracker` へ置き換える判断材料。

---

## できること（ライブラリが十分にやってくれる部分）

ライブラリの本業は **センサー値 → Three.js カメラ向き** の変換である。ここ自体は短く、実用に足りる。

1. `deviceorientation` で `alpha` / `beta` / `gamma` を購読する
2. `orientationchange` で画面の縦横（`window.orientation`）を取る
3. 毎フレーム `update()` でカメラの `quaternion` を更新する
4. DeviceOrientation の Z-X'-Y''（Tait-Bryan）を Three の座標系へ写す

核心の変換:

```js
euler.set(beta, alpha, -gamma, 'YXZ')
quaternion.setFromEuler(euler)
quaternion.multiply(q1)                          // X 軸 -90°（平置き基準 → カメラ前方）
quaternion.multiply(q0.setFromAxisAngle(zee, -orient)) // 画面回転補正
```

| ステップ | 意味 |
| --- | --- |
| `euler.set(beta, alpha, -gamma, "YXZ")` | 端末姿勢を Three のオイラーへ |
| `× q1`（X 軸 -90°） | 「端末が平置き」基準 → 「カメラが前方を見る」基準 |
| `× screenOrientation` | 縦横回転に合わせた補正 |

おまけとして `alphaOffset`（方位のオフセット）や `change` イベントもある。  
実装量は実質 50〜80 行程度で、**「頭の向きを取るレシピ」としては借りてよい水準**。

---

## できないこと（制御面の欠落）

足りないのは数学ではなく、**開始〜失敗〜代替** をアプリが設計できないこと。

### 1. 許可タイミングをアプリが決められない

- コンストラクタ末尾で必ず `connect()` を呼ぶ
- `connect()` 内で即座に `DeviceOrientationEvent.requestPermission()` する（iOS）
- そのため「先にインスタンスを作り、後で start」ができない
- iOS ではユーザージェスチャー（タップ）内で `new` しないと許可ダイアログが出ない

### 2. 許可結果をアプリが受け取れない

`requestPermission()` の Promise はライブラリ内で消費される。

- `granted` → リスナー登録
- `denied` → **何もしない**（呼び出し元にも返さない）
- `catch` → `console.error` のみ

呼び出し側は `await` も分岐もできない。

### 3. 拒否・エラーを UX に接続できない

結果として次が書けない。

- 「許可されませんでした」と説明する UI
- 再試行・設定アプリへの案内
- 拒否時にタッチ見回しなどへフォールバック

ユーザー体験としては「左右 2 眼のまま、頭だけ動かない」になりやすい。

### 4. `enabled` が実状態と一致しない

`connect()` は許可の成否を待たず `this.enabled = true` にする。  
アプリから見ると「有効そう」に見えるが、拒否時はセンサーが動いていない。

### 5. MR セッション API の入口にはなりにくい

将来欲しい形は controls ではなくセッション入口:

```ts
await tracker.start() // → PermissionState
tracker.getPose()
```

ライブラリは「カメラの quaternion を更新する controls」止まりで、キャリブレーション・DeviceMotion 併用・WebXR 実装との差し替え（同じ `start` / `getPose`）を載せる境界になっていない。

---

## 辛いこと（デモで実際にぶつかったこと）

### タップ内 `new` という実装都合がアプリに漏れる

```ts
// demos/01-stereo-box/main.ts — 開始ボタン内でしか作れない
controls = new DeviceOrientationControls(camera)
```

「開始ボタンで `await mr.start()`」と説明したいのに、現状は「タップハンドラの中で `new DeviceOrientationControls` しろ」という制約になる。

### 拒否しても「開始成功」に見える

デモは `startControls()` の直後に HUD を `mode=gyro` にする。  
許可ダイアログで拒否してもコード上は成功扱い。拒否検知は **未解決**。

### PC 向け Orbit 切替は「拒否フォールバック」ではない

いまの分岐は `pointer: coarse`（タッチ端末か）の事前判定だけ。  
センサー拒否後にタッチ操作へ切り替える経路はない。

### エコシステム全体の文脈

- `DeviceOrientationControls` は three 本体から r134 で削除済み（公式は WebXR 推奨）
- iPhone Safari では immersive-vr が使えないため、スマホ VR ではこの系が当面必要
- 現役メンテは three-stdlib 側が中心。周辺（レンズ歪み・Cardboard 系）は停滞気味

→ 座標変換レシピは借りつつ、**許可フローとセッション API は自前にする動機**が強い。

---

## デモでの対処（現状）

| 項目 | 状態 |
| --- | --- |
| 許可ダイアログを出す | 開始ボタンのクリック内で `new` して回避 |
| 拒否の検知 | 未対応 |
| 拒否時フォールバック | 未対応 |
| PC デバッグ | タッチ端末以外は `OrbitControls`（センサーなし用） |

---

## SDK ならどう解決するか（案）

```ts
type PermissionState = 'granted' | 'denied' | 'unavailable'

interface HeadTracker {
  start(): Promise<PermissionState>
  getPose(): Pose
  stop(): void
}
```

狙い:

1. **許可を明示的な async API にする** — アプリが `await` して分岐できる
2. **インスタンス化と許可リクエストを分離する** — タップでは `start()` だけ呼ぶ
3. **拒否・不可をプロダクト体験に接続する** — 説明 UI / 再試行 / タッチフォールバック
4. **WebXR 実装と差し替え可能にする** — 同じ `HeadTracker` 境界（CONCEPT.md §4）
5. **キャリブレーション等を載せやすくする** — 例: 「今向いている方向を正面に」=`alphaOffset` 相当を API 化

自前実装のメリットは「数学をより正しく書く」ことではない。  
**開始〜失敗〜代替の境界をアプリ / SDK が設計できること**が本質。

Phase 1 デモでは借りて動かし、痛点を確認したうえで SDK 化段階で置き換える、でよい。

---

## 対照表（要約）

| 項目 | three-stdlib | アプリ / SDK が欲しいもの |
| --- | --- | --- |
| 座標変換（頭追従） | 十分 | そのまま再利用 or 移植でよい |
| いつ許可を取るか | `new` 瞬間に勝手に取る | ボタン押下など明示タイミング |
| 許可結果 | 内部消費、外に返さない | `await` して `granted` / `denied` |
| 拒否時 | 黙って動かない | UI・再試行・代替入力 |
| `enabled` | 許可前から `true` | センサー利用可能状態と一致 |
| エラー | `console.error` のみ | 呼び出し側で catch / 分岐 |
| API 形 | Controls（`update` で quaternion） | `HeadTracker.start()` / `getPose()` |
