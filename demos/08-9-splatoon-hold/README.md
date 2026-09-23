# 08-9. MR Splatoon（止める + board + SLAM）

> **ライセンス: AlvaAR は GPLv3。このデモ（実験）限定で使い、Mobile MR SDK には入れない。**
> AlvaAR は npm に入れず、`npm run fetch:alva` で `public/vendor/alva/`（git 管理外）に置く。`vite build` するとそのまま `dist/vendor/alva/` にコピーされるので、
> **ビルド成果物を公開するなら GPLv3 の義務（ソースの提供・ライセンス全文の同梱など）が掛かる**。公開ビルドに含めない場合は `public/vendor/alva/` を消してからビルドする。
> **公開する場合は `SOURCE.txt`（対応ソースの入手先。`fetch:alva` が書き出す）と `LICENSE`（GPLv3 の全文）を必ず `alva_ar.js` と同じ場所（`dist/vendor/alva/`）に置く**。
> `SOURCE.txt` にはリポジトリ・固定コミット `7796af5` のソースアーカイブの URL・ビルド手順の場所・GPLv3 であることを書いてある。
> AlvaAR の元になった OV²SLAM / ORB-SLAM2 も GPLv3。

## 狙い

08-4（OpenCV.js の board + solvePnP で推定が良い）と 08-7（AlvaAR の単眼 SLAM でマーカーを見失っても位置が追従）を 1 つにし、
その上に **「静止中はアンカー（コート）を動かさない」** 処理を足す。
目標は「ぴったり合わせる」ではなく **「数 cm ずれていても、ちょこちょこ動かない」**。

- 実機の観察: 08-4 も 08-7 も、止まって見ているときに数 cm の小さなぶれが残り、体験を悪くしている
- 08-2（一度合わせて固定）は、歩くとコートが一緒についてきて破綻した
- 08-9 は「止める（hold）/ 追従する（follow）」を自動で切り替える

`docs/space-stability-options.md` §4 の候補 **1b + 3a + 「止める」**（軸: 表示の更新方針）。
**iPhone 実機では未確認**（PC の Node テストとヘッドレス Chrome + フェイク入力でのみ確認）。

## 方式

推定（どこにコートがあるか）と表示（コートをどこに描くか）を分ける。

| 層 | 何をするか | 実装 |
| --- | --- | --- |
| 推定: マーカー | 08-4 と同じ。OpenCV.js の `ArucoDetector` で検出 → 見えている全マーカーの 4 隅を 1 つの board にして `solvePnP`（重力での水平化あり）。OpenCV.js が無い・失敗なら js-aruco2 にフォールバック | `src/shared/marker-anchor-opencv.ts`（無変更） |
| 推定: 見失った間 | 08-7 と同じ。マーカーが見えている間に SLAM → field の相似変換を推定し、見えない間は SLAM の位置の増分でアンカーの位置だけ動かす（回転はジャイロ） | `slam-fusion.ts` / `slam-source.ts`（08-7 のコピー、無変更） |
| **表示（08-9 で追加）** | 推定（`rawAnchor`）を状態機械に通して、表示用の `anchor` に写す。止まっている間は表示を固定し、歩き出したら追従する | `anchor-hold.ts`（新規。three 非依存） |

`main.ts` ではアンカーを 2 つに分けた:

- `rawAnchor` … マーカー（`createOpenCvMarkerAnchor({ anchor: rawAnchor })`）と SLAM（`updateSlam`）が書き込む推定そのもの。**scene に入れない**（描かない）
- `anchor` … 表示用（scene 上）。毎フレーム `updateDisplayAnchor` で `anchorHold.update(rawAnchor の姿勢)` を写す。
  ゲーム側（壁・床・インクの枠、着弾、発射位置、pose 送信の `self=`）は今までどおり `anchor` を読む
- SLAM の組（field 側のカメラ姿勢 = アンカー⁻¹ · カメラ）と、見失った間の増分はすべて `rawAnchor` で作る。
  表示の `anchor` は hold で止まっていることがあり、それで組を作ると「マーカーの推定」ではなく「止めた姿勢」と SLAM を対応づけてしまうため
- `rawAnchor` は scene に無い（親が無い）ので、`matrixWorld` は自分で更新する。`updateSlam` の先頭で `rawAnchor.updateMatrixWorld()` を呼ぶ
  （親が無いので `matrixWorld = matrix`）。marker-anchor は `camera.matrixWorld` しか読まず、`anchor` には `position` / `quaternion` を書くだけなので、そちらは何もしなくてよい
- 初検出まで（`everDetected` が false）は `rawAnchor` に意味が無いので hold に入れない（`reset()` して raw をそのまま写す）

### 状態遷移（`anchor-hold.ts`）

```text
            最初の update（出力 = raw）
                    │
                    ▼
   ┌────────── follow ◀─────────────────────────────────┐
   │  出力 = raw（入った直後だけ、直前の出力との差を        │
   │  時定数 holdTau で縮める）                            │
   │                                                      │
   │  直近 holdInMs の raw の窓（3 点以上）の、窓の平均      │ raw が固定姿勢から holdPos / holdDeg を
   │  からのばらつきの RMS が holdPos / holdDeg 以内         │ 超えた状態が「連続で」holdOutMs 続いた
   │  → 固定姿勢 = 窓の平均                                │（1 フレームの外れ値では動かない。閾値内に
   ▼                                                      │  戻ったら継続時間は 0 に戻す。raw が NaN の
  hold ───────────────────────────────────────────────────┤  フレームは無視）
   出力 = 固定姿勢（入った直後だけ、直前の出力との差を        │
   時定数 holdTau で縮めて滑らせる。差が消えたら一切変えない）  │
   raw が固定姿勢から holdSnap を超えて離れた ──────────────┘ 即 follow・出力も即 raw（寄せない）
```

- **入る判定を RMS にした理由**（レビューで最大値判定から変更）: 実機の推定には数 cm のぶれがあり、「窓の全点が平均から閾値以内」だと 600ms の窓に外れ値が 1 回入るだけで 600ms 入れず、follow のままになりやすい。
  hold の維持は「閾値超えが holdOutMs 続いたら離脱」で外れ値に強いので、入る側も外れ値 1 回で拒まない RMS（位置: `sqrt(Σ|p_i − p̄|² / n)`、回転: 平均との角度差の二乗平均の平方根）にそろえた。
  代わりにゆっくりした動きも「止まっている」とみなしやすくなる（ノイズ無しの等速で、最大値判定は約 6.7cm/s 以下、RMS は約 11cm/s 以下）。そうして止めても、動き続けていれば holdOutMs で follow に戻る。
  窓の点が 3 個未満（長いフレーム落ちの直後）なら判定しない
- **窓の平均で止める理由**: 直近の 1 点で止めるとぶれの端で固まり、その後のぶれが片側に偏って閾値を超えやすい。中心で止めると、同じぶれでも固定姿勢からの差が最小になる
- **hold に入るときも飛ばない**: 直前の出力は窓の平均から最大 holdPos 程度離れているので、そのまま平均に切り替えると飛ぶ。直前の出力との差を持ち越して holdTau で縮めるので、
  **hold に入った直後の数フレーム（τ=120ms なら 0.3〜0.5 秒）は出力が固定姿勢へ滑る**。差が 1mm / 0.05° 未満になったら固定姿勢そのものになり、以後は一切変わらない。
  follow の寄せの差が残ったまま止まったとき（`?holdTau=1000` など）も同じく飛ばない
- **寄せ方**: 出力そのものを raw へ lerp するのではなく、「出力 − raw」の差を毎フレーム `exp(−dt/τ)` 倍に縮める（`α = 1 − exp(−dt/τ)` で差を詰めるのと同じ）。
  出力を lerp すると歩いている間ずっと「速度 × τ」（0.5m/s・τ=120ms で 6cm）遅れ続けるが、差を縮める形なら raw の動きはそのまま通り、残るのは切り替え時の差だけ。
  差が 1mm / 0.05° 未満になったら出力 = raw。raw は marker-anchor の `smooth` / SLAM の `slamSmooth` で平滑化済み
- **時間ベース**: dt はフレームで変わるので、すべて `performance.now()` の ms で数える（dt ≤ 0 は 0）
- **08-2 との違い**: 08-2 は確定したら二度と動かさない。08-9 は raw が離れ続けたら自動で follow に戻り、止まったらまた固定する
- `?hold=0` でも同じ経路（`enabled: false` で出力 = raw）。経路の違いで比較が崩れないように

## 08-7・08-4 との差分（ファイル単位）

土台は `demos/08-7-splatoon-alva/` の丸ごとコピーで、`main.ts` に 08-4 が 08 に当てた差分（位置の取り方を OpenCV.js に替える）を当て、表示の hold を足した。

| ファイル | 差分 |
| --- | --- |
| `main.ts` | 先頭コメント（方式・追加パラメータ）/ **08-4 から**: import の差し替え（`createOpenCvMarkerAnchor` ほか）、`DETECTOR` / `PNP_METHOD` / `POSE_SOURCE` / `MAX_REPROJ_PX` / `OPENCV_URL`、`createOpenCvMarkerAnchor({...})`、HUD の `pose=` 行（末尾に 08-7 の `(slam)` / `(holding last pose)`）、`hudState.base` の `detector= pnp= poseSource=` / **08-9**: `HOLD_*` のパラメータ、`rawAnchor` と `anchorHold`、`updateSlam` の `anchor` → `rawAnchor`（組・増分・`updateMatrixWorld`）、`updateDisplayAnchor`（ループで `updateSlam` の直後）、HUD の `hold=` 行、`hudState.base` の `hold=1(pos= deg= out= in=)`、`window.__hold`（ヘッドレス確認の口） |
| `anchor-hold.ts`（新規） | 「止める / 追従する」の状態機械（three 非依存。Node のテストから直接 import） |
| `slam-fusion.ts` / `slam-source.ts` | 無変更（08-7 のコピー。`anchor-hold.ts` は `slam-fusion.ts` の `Pose` 型だけ使う） |
| `index.html` / `overview.html` / `markers.html` | タイトルと見出しの番号を 08-9 に（スマホの開始画面の案内文・レイアウトは 08 と同じ。08-9 の説明はこの README） |
| `overview.ts` | 無変更（08-7 のまま。SLAM で位置を動かしているプレイヤーを `SLAM` と表示） |
| `game-client.ts` / `ink-*.ts` / `splat-sound.ts` / `fake-splat-hand.ts` / `markers.ts` | 無変更（08-7 のコピー = 08 と同じ） |

サーバーは 08 と同じ `server/splatoon.ts`（`SPLATOON_PATH`。プロトコルは変えていないので room 名で分かれる）。`src/shared/*` は変更していない。
その他: `scripts/test-08-9-hold.mjs`、`scripts/headless-08-9-hold.mjs`、`package.json`（`test:08-9-hold` / `check:08-9-hold`）、`scripts/preflight-stability.mjs`（08-9 の項目）、ルートの `index.html`、`vite.config.ts`、`docs/space-stability-options.md` §5、`CLAUDE.md`。

## URL パラメータ

08 / 08-4 / 08-7 のパラメータはすべて同名・同義（`fov` `camZoom` `markerMm` `detW` `smooth` `gravityAlign` `fakecam` `fakehands` `room` `name` `autostart` …、
08-4 の `detector` `pnp` `pose` `maxReprojPx` `opencvUrl` `camFov`、08-7 の `slam` `slamW` `slamIntervalMs` `slamMinBaseline` `slamPairMaxCorr` `slamSmooth` `fakeslam` …）。08-9 で追加:

| パラメータ | 既定 | 意味 |
| --- | --- | --- |
| `hold` | 1 | `0` で止めない（出力 = 推定。08-4 + 08-7 と同じ表示。経路は同じ） |
| `holdPos` | 0.02 | 止める判定の位置の閾値 [m]（hold 中の離脱と、follow 中の「止まった」の両方） |
| `holdDeg` | 2.0 | 止める判定の回転の閾値 [deg]（1° だと合成ノイズでも 0.5〜0.9° 出ていて実機で入れない恐れが高いので 2°） |
| `holdOutMs` | 250 | hold 中、閾値超えがこの時間「連続で」続いたら follow へ [ms] |
| `holdInMs` | 600 | follow 中、推定がこの時間ほぼ動かなかったら hold へ [ms] |
| `holdSnap` | 0.3 | これ以上離れた推定は即 follow・表示も即推定に合わせる [m]（marker-anchor の `snapDistanceM` と同じ値） |
| `holdTau` | 120 | 状態を切り替えた直後、表示が目標（follow では推定、hold では固定姿勢）に追いつく時定数 [ms] |

HUD（`slam=` 行の下）: `hold=<hold|follow> dev=<推定と表示の位置差>m/<回転差>deg held=<止めてからの秒>s`（`?hold=0` なら `hold=off`、マーカーを一度も検出していない間は `hold=waiting`）。
1 行目に `detector=opencv pnp=auto poseSource=board hold=1(pos=0.02 deg=1 out=250ms in=600ms) slam=…`。
`pose=` 行と `slam=` 行の読み方は 08-4 / 08-7 の README と同じ。`pose=` 行の `self=` は**表示**のアンカーから出した自分の位置（hold 中は変わらない）。

## PC 確認の手順

```sh
export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
npm ci && npm run fetch:models && npm run fetch:opencv && npm run fetch:alva
node scripts/preflight-stability.mjs 08-9
npx tsc --noEmit && npx vite build
npm run test:08-9-hold      # Node: anchor-hold.ts の状態機械（下の表）
npm run check:08-9-hold     # ヘッドレス Chrome（既定 PORT=5213 CDP_PORT=9352。先に lsof -nP -iTCP:5213 -sTCP:LISTEN / :9352 で空きを確認）
```

`test:08-9-hold` の内容（合成の raw を流す。乱数は種を固定）:

| 項目 | 結果（2026-09-24） |
| --- | --- |
| (a) 固定姿勢に各軸 ±1cm・±0.5° の一様ノイズ（60fps、3 秒） | 600ms で hold、入った瞬間は出力 = raw で以後 1 フレームの変化は最大 1.02mm、hold から 317ms で固定姿勢に落ち着き以後ビット単位で不変。固定位置は種 20 通りで中心から中央値 1.59mm / 最悪 3.26mm（基準: 中央値 ≤ 3mm かつ最悪 ≤ 5mm） |
| (b) 0.5m/s で 2 秒直進（ノイズ付き、最初から follow） | 出力と raw の差 0.00cm、hold に落ちない |
| (b') hold 中に 0.5m/s で歩き出す | 283ms で follow。**真の位置からの遅れは最大 13.3cm**（止めていた分 + 閾値に届くまで）。歩き出して 0.6s 以降は raw から 0.84cm 以内 |
| (c) hold 中に 1 フレームだけ 10cm 飛ぶ | 出力不変・hold のまま |
| (d) hold 中に 5cm ずれた raw が続く | 267ms で follow、0.5s 以降の寄せの差 0.50cm、717ms で出力 = raw、883ms で新しい位置で hold |
| (e) 直進後に停止 | 483ms（60fps）/ 624ms（dt 不均一）で hold。固定位置は止まった位置から 6.0mm / 2.5mm（RMS 判定なので止まる直前の歩きが少し窓に残る。最大値判定のときは 567ms・1.0mm） |
| (f) hold 中に 0.5m 飛ぶ | そのフレームで follow・出力 = raw |
| (g) `enabled:false` | 常に出力 = raw、`hold=off` |
| (h) dt 16ms / 100ms 混在で (a)(b)(e) | (a) 632ms で hold・312ms で落ち着き以後不変、(b) 差 0。固定位置は種 20 通りで中央値 2.77mm / 最悪 4.63mm（窓の点が約 10 個しかないので 60fps より大きい） |
| 回転だけで抜ける | 位置は同じで向きが 3° ずれ続けると 267ms で follow、0.5 秒後には向きの差 0.000° |
| `?holdTau=1000` で寄せの差が残ったまま止まる | 差 2.70cm を持ったまま hold に入っても 1 フレームの変化は最大 1.01mm（差が 1mm 未満で 0 にする最後の 1 回） |
| raw に NaN が混ざる / 窓の点が 2 個 | NaN のフレームは無視（出力は有限、閾値超えの継続時間も進む）/ 0ms と 700ms の 2 点では hold に入らず 3 点目で入る |

`check:08-9-hold` の内容（`?fakecam=1&fakeslam=1&autostart=1&fakehands=1&markerMm=100&camZoom=1`。A = 既定、B = `?hold=0`）:

1. A・B とも `pose=opencv`（フォールバックしていない）、A は `hold=hold`、B は `hold=off`
2. ページ内で `__fakeMarkers.camPos` に毎フレーム ±1cm のノイズ → 1 秒後から 4 秒間、A の自分の位置（`__hold.self`。mm 単位）が **1mm も変わらず** `hold` のまま、表示用アンカーの回転もビット単位で変わらない（`__hold.anchorQuat`。そのときの推定と表示の差は最大 0.010〜0.012m / 0.52〜0.78deg。レビュー後の 3 回。レビュー前の 3 回は 0.009〜0.012m / 0.51〜0.90deg）
3. マーカーを見たまま 0.5m 動かす（0.25m/s）→ 途中は `follow` で推定と表示の差 `dev` が 0（遅れは hold のせいではない）、`self=` は真値から 7.7〜7.9cm（マーカー検出 + marker-anchor の lerp の遅れ）、止めると `hold`（到達点から 1.7〜1.9cm。最大値判定のときは 0.5cm。RMS 判定にしてから止まる直前の位置が少し混ざる）
4. マーカーを見ながら動いて SLAM を較正（`fix=s=2.69〜2.70`、正解 1/0.37 = 2.70）→ 原点マーカーを隠して 0.72m 動かす → SLAM 駆動（`(slam)`・`tracking+drive`）で `follow`・`self=` が追従（真値から 3.7〜5.7cm）、止めると `hold`（到達点から 0.5〜2.0cm）で、その間 `self=` は 1mm も変わらず回転もビット単位で変わらない
5. 対照: B（`?hold=0`）は 2 と同じノイズで `self=` が 17.3〜24.6mm、表示用アンカーの回転が 0.75〜1.48° ぶれる
6. 俯瞰画面が開けて 2 人が見える / 例外なし

手で見るなら: `npm run dev` → `https://localhost:5173/demos/08-9-splatoon-hold/?camZoom=1&fakecam=1&autostart=1&name=PC&fakehands=1&fakeslam=1&markerMm=100`、
DevTools で `setInterval(() => __fakeMarkers.camPos = [0, 0, 0.74].map((v) => v + (Math.random() * 2 - 1) * 0.01), 16)` と打って HUD の `hold=` と `self=` を見る（`&hold=0` と見比べる）。

## 実機で確認すべき項目（すべて未確認）

1. **立ち止まって見ているとき、コートの枠が「ちょこちょこ」動かなくなるか**（08-4 / 08-7 / 08-9 の `?hold=0` と同じ部屋・同じマーカーで見比べる。動画で枠の角を比べる）
2. 立ち止まって数秒で HUD が `hold=hold` になるか。**ならない（`follow` のまま）なら、推定のぶれ（RMS）が `holdPos`（2cm）/ `holdDeg`（2°）より大きい**。`dev=` の値を記録して `?holdPos=0.04` `?holdDeg=3` などで試す
3. **頭を回しただけ**（位置は動かさない）で hold が外れないか。回転はジャイロなので推定の位置は変わらないはずだが、マーカーの見え方が変わると PnP のヨーが揺れる
4. **歩き出しの遅れ**: hold 中に歩き出すと、`holdOutMs`（250ms）+ 閾値に届くまでの間コートが止まったまま（0.5m/s で約 13cm 遅れてから寄せ始める。Node のテスト (b')）。その間コートが「ついてくる」ように見えて気持ち悪くないか。`?holdOutMs=150` と比べる
5. hold に入った直後に表示が固定姿勢へ滑る動き（0.3〜0.5 秒、最大 `holdPos` 程度）が気にならないか。ゆっくり動いている（約 11cm/s 以下）ときに hold に入ってしまい、遅れてから追従に戻る動きが気にならないか
6. 数 cm ずれたまま止まることの許容度（「ぴったり」ではなく「動かない」を狙っている。止まった位置が実物から何 cm ずれているか）
7. 08-7 の項目（AlvaAR の読み込み・処理時間・超広角での追跡・リセット頻度・発熱）と 08-4 の項目（OpenCV.js の読み込み・`cv=`・斜めの安定さ）はそのまま当てはまる。両方を同時に動かすので**処理時間と発熱は 08-4 / 08-7 より重い**
8. 2 台で入室 → 発射 → 得点、相手の相対位置（相手は相手の表示のアンカーで出した位置を送ってくる。hold 中は相手のアバターも止まる）
9. 実機の結果を見てから決める（レビューで見送った案）:
   - 歩き出しの遅れ（約 13cm）が気になるなら、SLAM を動き検出に使って早めに follow に移す / 寄せの速度に上限を付ける
   - 止まっている間の固定姿勢のずれが気になるなら、hold 中にごく遅い EMA で固定姿勢を寄せる
   - `dev=` の記録を見て、回転と位置を「距離に換算した 1 つの m の閾値」にまとめるか
   - 外れ値の実態を見て、`holdOutMs` を時間ではなくマーカーの検出回数で数えるか

## 既知の制約・判断

- **止めている間、表示は推定より最大 `holdPos` / `holdDeg` ずれている**（それを超えて `holdOutMs` 続くと追従する）。「ぴったり合わせる」ではなく「動かない」を優先した判断
- **歩き出しは遅れる**（上の実機項目 4）。1 フレームの外れ値（検出の誤り・鏡像の解・SLAM の一瞬の飛び）で動かないことと引き換え
- 閾値の既定（2cm / 2° / 250ms / 600ms）は PC の合成入力で決めた初期値。回転は、ヘッドレスで ±1cm の合成カメラのノイズだけで推定が最大 0.51〜0.90° ぶれ、1° では実機で hold に入れない恐れが高いので 2° にした（レビューで変更）
- 固定姿勢は窓の平均なので、その精度は窓の中の**独立な**観測の数で決まる。実機ではマーカー検出が 10Hz（`markerIntervalMs=100`）で、その間の raw は平滑化で相関しているので、600ms の窓の独立な観測は 6 個程度（Node のテストの dt 不均一の場合に近い。中心からの誤差は数 mm）
- 回転は推定（マーカーのヨー + 重力）の四元数ごと止める。カメラの回転はジャイロなので、頭を回しても表示のアンカーは動かない
- hold は表示だけ。SLAM の較正（組）と見失った間の増分は推定（`rawAnchor`）で作るので、hold の有無で SLAM の推定は変わらない
- pose 送信（`self=`・相手に見える位置）と発射位置は表示のアンカーから出す（コートの見た目と着弾が一致するように）。hold 中の小さな位置のずれは相手にもそのまま見える
- 08-7 の既知の制約（GPLv3・回転に SLAM を使わない・端末の回転で SLAM を止める・フェイクの SLAM では追跡の質を確かめられない）と、08-4 の既知の制約（OpenCV.js の読み込み待ち・1 枚の IPPE の鏡像・内部パラメータは推定値）はそのまま
