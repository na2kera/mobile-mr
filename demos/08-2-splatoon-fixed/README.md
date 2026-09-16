# 08-2. MR Splatoon（一度合わせて固定）

`demos/08-splatoon/`（MR スプラトゥーン）の**位置の取り方だけ**を変えた比較用デモ。
[docs/space-stability-options.md](../../docs/space-stability-options.md) §4 の候補 **5b「一度合わせて固定 + 立ち位置固定」**で、比較実験の**基準線**。
ゲームの仕様（コート・インク・タンク・練習 → 対戦 → 結果・俯瞰画面・8 色・サーバー権威の格子）と UI は 08 のまま。

## 方式

08 はマーカーが見えるたびにアンカー（field 座標系 → ワールド）を観測へ寄せる（lerp / スナップ）ので、斜めから見た 1 枚のマーカーの姿勢誤差（issue #54 / #55）がそのままコートの揺れになる。08-2 は:

1. **位置合わせ**: 開始後、練習に入る前に「マーカーの正面 1m に立ってください」と誘導し、**信頼できる観測**（下表）が **N 回連続**（既定 10）し、その間の位置のばらつきが 5cm・回転のばらつきが 3° 以内のときだけアンカーを確定する。位置は成分ごとの**中央値**、回転は四元数の**平均**。視界内メッセージに「合わせ中 3/10」→「確定！」
2. **確定後はアンカーを更新しない**。ロスト・再検出・別マーカーへの切り替えでも動かさない。回転はジャイロ（DeviceOrientationControls）のまま
3. ただし確定時と同じ条件を満たす観測のときだけ、**ごく緩やかに補正**する（`?refine=` = 観測 1 回ごとの EMA 係数。既定 0.02、0 で完全固定）。観測がアンカーから `?refineMax=`（既定 0.5m）以上離れていれば（POSIT の鏡像解などの疑い）補正に使わない
4. **合わせ直し**: 練習中に画面（PC は Space）を `?realignHoldMs=`（既定 2 秒）押し続ける。集め直している間もいまの位置で遊べ（コートは消えない）、確定した時点で置き換わる。対戦中・カウントダウン中・結果表示中は押し続けても合わせ直さない（コートが跳ぶと対戦が壊れる）
5. 追加マーカー（俯瞰画面の配置）も位置合わせの候補になる（見えているマーカーのうち条件の良い 1 枚で信頼度を評価）。確定後は切り替えでアンカーを飛ばさない（3 の緩やかな補正だけ）

「信頼できる観測」の条件（`fixed-anchor-math.ts` の `untrustedReason`。全部 URL で変えられる）:

| 条件 | 既定 | パラメータ | 落ちたときの案内 |
| --- | --- | --- | --- |
| カメラからマーカー中心までの距離 | ≤ 1.6 m | `alignDist` | もっとマーカーに近づいてください |
| 画面の中央（光軸）からマーカー中心までの角度 | ≤ 20° | `alignOff` | マーカーを画面の中央に |
| マーカーの法線と「マーカー → カメラ」の角度（正対の度合い） | ≤ 25° | `alignFace` | マーカーの正面に回ってください |
| 水平化する前のアンカーの傾き（`marker-anchor.ts` の `tiltDeg`） | ≤ 15° | `alignTilt` | 端末を水平に構えてください |
| 正規化再投影誤差（`marker-anchor.ts` の `err=`） | ≤ 0.15 | `alignErr` | 止まってマーカーをはっきり映してください |

実装: `src/shared/marker-anchor.ts` は**変更しない**。`createMarkerAnchor` の出力先を field のアンカーではなく観測用の `Object3D`（`observed`。`smooth: 1`・常にスナップ = 生の観測）にして、`fixed-anchor.ts` が公開値（`lastAcceptedMs` / `usedIds` / `tiltDeg` / `info` の `err=`）と `observed` の姿勢を読み、本物のアンカーに書くかどうかを決める。純粋な数学（信頼判定・窓・中央値 / 平均・EMA）は `fixed-anchor-math.ts`（three 非依存。Node のテストから直接 import）。

## 08 との差分（ファイル単位）

`demos/08-splatoon/` を丸ごとコピーして始めた。`src/shared/` と `server/` は変更していない（同じ `SPLATOON_PATH`・同じプロトコル v11 に繋ぐ。room 名で分かれるので、08 と 08-2 を同じ room に入れて相対位置を比べることもできる）。

| ファイル | 差分 |
| --- | --- |
| `main.ts` | 冒頭のコメント（方式と URL パラメータ）。`// ---- アンカー` の節に `observed` と `fixedAnchor`。`startCameraAndMarker` で `createMarkerAnchor` の出力先を `observed` に（`smooth: 1`、`resnapAfterMs: 0`、`snapDistanceM: 0`、`canSnap` 無し）し、`createFixedAnchor` を作る。`sendPoseIfDue` は確定（`fixedAnchor.locked`）まで送らない。`updateRealign` / `pressHold`（長押しの計時）。`updateMessages` に位置合わせの案内（`alignMessage`）と合わせ直し中の表示。HUD の `marker=` 行を `align=`（+ `obs=` に生の観測）に。ループで `fixedAnchor.update` と確定時の「確定！」。フェイクカメラの姿勢を毎フレーム `window.__fakeCam` から作る（実行中に動かせる）。`?smooth=` は使わない |
| `fixed-anchor.ts` | 新規。three 側の薄い層（観測の質の計算・窓・確定・補正・合わせ直し・HUD 文字列） |
| `fixed-anchor-math.ts` | 新規。純粋な数学（`untrustedReason` / `markerQuality` / `AlignWindow` / `medianPose` / `averageQuat` / `emaPose`） |
| `index.html` | タイトル・見出しと方式の説明、08-2 固有の URL パラメータの案内。レイアウト・スタイルは 08 のまま |
| `overview.html` / `markers.html` | タイトルと見出しだけ（08-2 と分かるように）。`overview.ts` / `markers.ts` は 08 と同一 |
| `game-client.ts` / `ink-view.ts` / `ink-tank.ts` / `splat-sound.ts` / `fake-splat-hand.ts` | 08 と同一 |
| `README.md` | このファイル |

リポジトリ側: ルートの `index.html`（08 の次に 08-2 と俯瞰画面）、`vite.config.ts` の `build.rollupOptions.input`（3 ページ）、`package.json` の `test:08-2-fixed` / `check:08-2-fixed`、`scripts/test-08-2-fixed.mjs`、`scripts/headless-08-2-fixed.mjs`、`docs/PAIN_POINTS.md` の末尾。

## URL パラメータ

08 と同名・同義のものはそのまま（`fov` `camZoom` `markerMm` `fakecam` `fakehands` `room` `name` `autostart` `gravityAlign` 等）。08-2 固有:

| パラメータ | 既定 | 意味 |
| --- | --- | --- |
| `alignN` | 10 | 確定に必要な「信頼できる観測」の連続数 |
| `alignDist` / `alignOff` / `alignFace` / `alignTilt` / `alignErr` | 1.6 / 20 / 25 / 15 / 0.15 | 信頼できる観測の条件（上の表） |
| `alignSpread` | 0.05 | 窓の中の位置のばらつき（中央値からの最大距離）の上限 [m] |
| `alignAngle` | 3 | 窓の中の回転のばらつき（平均からの最大角度）の上限 [deg] |
| `refine` | 0.02 | 確定後の緩やかな補正の EMA 係数（観測 1 回ごと）。0 で完全固定 |
| `refineMax` | 0.5 | 観測がアンカーからこれ以上離れていれば補正に使わない [m] |
| `realignHoldMs` | 2000 | 合わせ直しに必要な押し続けの時間 [ms]。0 で無効 |

HUD（08 の `marker=` 行と同じ位置）: `align=locked (12.3s) locks=1 refine=0.02 refined=57 drift=0.012m obsΔ=0.03m/39deg dist=0.74m off=3deg face=39deg tilt=1deg err=0.02 trusted=no(face) realigns=0 obs=id=0 err=0.02 ... layout=- self=(x,y,z)`

- `locked` / `aligning n=3/10` / `realigning n=3/10`（`unstable` が付けばばらついている）
- `obsΔ=<位置>m/<回転>deg` 直近の観測とアンカーの差（**08 ならこのぶん動いていた量**。比較実験の指標。斜めから見るとヨーの差が出る）、`drift=` 確定時からの累積の補正量
- `dist= off= face= tilt= err= trusted=` 直近の観測の質と信頼できなかった理由
- `obs=` 生の観測（08 の `marker=` と同じ内容。ロスト中は `(lost)`）

## PC 確認

```sh
export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
npm run test:08-2-fixed    # 純粋な数学（信頼判定・窓・中央値 / 平均・EMA）。Node のみ
npm run check:08-2-fixed   # ヘッドレス Chrome（PORT 5197 / CDP 9342）
```

ヘッドレスで見ているもの: 正面で確定（`align=locked`、自分の位置がフェイクカメラの位置に 5cm 以内）→ カメラを正対から 39° 斜めにしてもアンカーが 1µm も動かず `obsΔ` の回転 30° 以上・`trusted=no(face)` → マーカーを隠す / 戻すでも動かない → 正面のまま 10cm 横（信頼できる観測）でも `refine=0` なら動かない → `refine=0.1` のウィンドウでは跳ばずに単調に寄る → 練習中に Space 2 秒で合わせ直し（`locks=2`、新しい位置に一致）→ 床の追加マーカーだけのウィンドウも確定 → 対戦中は Space 2 秒でも合わせ直さない → 得点が両ウィンドウと俯瞰画面で一致。

ヘッドレスの幾何はマーカーまで 0.5〜0.75m（100mm が 60px 以上）に揃えてある。合成カメラ（640×480）では 0.9m 以遠（50px 未満）のマーカーは角の量子化で位置が 5〜12cm ずれ（08 でも同じ値。POSIT 自体の誤差ではない）、1m 以上だと検出自体が落ちることがある。

手動で見るなら `?camZoom=1&fakecam=1&autostart=1&name=PC&fakehands=1&refine=0` を開き、DevTools で `__fakeCam.yaw = 30` などと書き換えると、生の観測（`obs=` / `obsΔ=`）が動いてもコートが動かないのが分かる。

## 実機（iPhone）で確認すべき項目 — **未確認**

iPhone 実機ではまだ確認していない。見るべきこと:

1. 「マーカーの正面 1m に立ってください」→「合わせ中 n/10」→「確定！」の流れが自然に進むか。既定の閾値（距離 1.6m・中央 20°・正対 25°・傾き 15°・誤差 0.15）が実機の観測で満たせるか（`err=` の実測値は PC のフェイクカメラでは小さすぎて分からない。満たせなければ `?alignErr=` / `?alignTilt=` を緩める）。手ブレで `unstable` になりやすければ `?alignSpread=` / `?alignAngle=`
2. 確定後、斜め・横から見ても、マーカーを見失って戻っても**コートが動かない**か（08 と同じ部屋・同じマーカーで、角の画面上のぶれ [px] と `obsΔ=` を比べる）
3. `refine=0.02`（既定）で、正面に戻ったときにコートがじわっと寄るのが気にならないか。0 の完全固定と比べる
4. 歩いたときのずれ（3DoF なので 08 と同じ。動かない前提の方式であることの確認）
5. 2 台で相対位置が合うか（相手の頭とインクが相手の手元から出るか）。08 と混ぜて同じ room に入れても比べられる
6. 合わせ直し（画面 2 秒押し続け）がゴーグルのボタンで押せるか。押している間の視線連射と両立するか（2 秒未満なら連射だけ）
7. 発熱・フレームレートは 08 と同じはず（検出は 08 と同じ頻度で回している）

## 既知の制約

- 3DoF のまま: 確定後に歩くと位置がずれる（方式の割り切り。docs/space-stability-options.md §2 の D）
- 確定時の 1 回の観測誤差（正面 1m でも位置 数 cm・ヨー数°。issue #54 の計測では正面付近のヨーは ±8°）はそのまま残る。`refine` で正面に戻るたびに少しずつ寄るが、斜めの観測では補正しない
- 合わせ直しは長押し 2 秒なので、視線連射（画面を押している間）を 2 秒以上続けると練習中は合わせ直しが始まる（集め直している間もコートはそのままなので実害は小さい）。俯瞰画面からの指示はプロトコルを変えないと作れないので今回は入れていない
- 再投影誤差は `marker-anchor.ts` の `info` 文字列（`err=`）から読んでいる（公開 API に数値が無い。PAIN_POINTS 参照）
- 08 と同じサーバー・同じ room 名空間。既定 room は 08 と同じ `demo`
