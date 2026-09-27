# 08-11 MR Splatoon — 8th Wall SLAM + OpenCV board（ぶれを窓平均で抑える）

[08-10](../08-10-splatoon-8thwall/)（8th Wall の World Tracking で頭の 6DoF）の丸ごとコピーで、**コートの置き方**だけを変えた比較デモです。
[docs/space-stability-options.md](../../docs/space-stability-options.md) §5 の表の 08-11。ゲーム（コート・インク・タンク・練習 → 俯瞰画面の「対戦開始」→ 対戦 → 結果）、
UI、サーバー（`server/splatoon.ts`。同じプロトコル・同じ WebSocket のパス）は 08 / 08-10 のままです。

## 目的

- 08-4（OpenCV の ArucoDetector + 全マーカーを 1 つの board にして solvePnP）は iPhone 実機で「コートの位置のずれは小さいが、止まって見ていても数 cm ぶれる」。
- 08-10 は `xr=NORMAL` にはなるが、「マーカーから目を離す・少し離れるだけで LIMITED になり、08-4 なら認識できる距離でも『マーカーを見てください』になる」。
  原因は (1) NORMAL 以外でマーカー検出を止め、LIMITED・姿勢 500ms 超のたびに invalidate してコートを隠していた、(2) マーカー検出が 08 と同じ js-aruco2 + POSIT だった、の 2 つ。
- 08-11 は **08-4 の推定を 8th Wall のワールド座標系の上で使い、コートのワールド姿勢は定数であることを利用して、直近の短い窓で外れ値を除いて平均する**。
  止まって見ている間のぶれは平均で抑え、少し動いたときは 8th Wall がカメラを動かすのでコートはワールドに留まる。
- 08-9（08-4 + AlvaAR + 静止中は止める）は実機で「かなり空間がズレてダメ」だったが原因を切り分けられなかった。08-11 は最初から **HUD と実機ログ（`logs/client.log`）に診断**を出す。

## 08-10 との違い

| | 08-10 | 08-11 |
| --- | --- | --- |
| マーカー推定 | js-aruco2 + POSIT（`createMarkerAnchor`） | 08-4 と同じ OpenCV.js の board + solvePnP（`createOpenCvMarkerAnchor`。読めなければ js-aruco2 にフォールバックし、HUD の先頭に `!! FALLBACK` とログに `event=opencv backend=aruco2 FALLBACK`） |
| コートの姿勢 | マーカーのアンカーを lerp（`smooth=0.5`） | OpenCV アンカーは非表示の `rawAnchor` に毎回の観測をそのまま写し（`smooth=1`）、表示用の `anchor` は窓平均フィルタ（[anchor-filter.ts](./anchor-filter.ts)）が書く |
| マーカー検出を回す条件 | 8th Wall が NORMAL のときだけ | 8th Wall の姿勢があれば常に（LIMITED 中も） |
| LIMITED | invalidate → コートを隠し、発射を止め、マーカーで再ロック | **コートを出し続け、発射も止めない**（姿勢が有効なら LIMITED でも更新、無効なフレームは最後の有効な姿勢） |
| 姿勢の鮮度切れ（500ms） | invalidate | invalidate しない（HUD の `age=` とログに出すだけ） |
| invalidate する出来事 | 上記 + 向き変更・投影更新・タブ復帰・bfcache | **原点が確実に変わる出来事だけ**: 向き変更・投影の更新（映像サイズ変更）・タブ復帰・bfcache 復帰・`onCameraStatusChange("failed")` |
| 送る `tracking` | NORMAL かつ再ロック済み | 再ロック済み かつ NORMAL かつ姿勢の鮮度 500ms 未満（サーバーは tracking を発射の可否に使わないので、発射は再ロック済みかだけで決まる）。LIMITED 中も**いまの姿勢**を送る |
| 8th Wall の例外・カメラ失敗 | HUD の `xr=` | HUD に加えて**画面の主表示**（「カメラを開けません」）にも出す |

### 窓平均フィルタ（[anchor-filter.ts](./anchor-filter.ts)）

- `?avg=1`（既定）: 8th Wall が NORMAL の観測（1 回ごとの「カメラ姿勢 × PnP」= コートのワールド姿勢）を直近 `?avgWindowMs=3000` ms・最大 `?avgMaxN=40` 件の窓に入れる。
  位置は各軸の中央値、回転は半球をそろえた四元数の平均を基準に、位置が `max(3σ, 2cm)` を超えるか回転が `max(3σ, 2°)` を超える観測を外れ値として除いて平均する
  （位置の σ = 3D 距離の中央値 / 1.538、回転の σ = 角度の中央値 × 1.4826）。
- 窓が 3 件未満の間は中央値が当てにならないので、基準は「いまの目標」にし、目標から 10cm / 5° 以上離れた観測は窓に入れない（鏡像解などの外れ値 1 件でコートが動かないように）。目標は窓が 3 件そろうまで書き換えない。
  目標が無いとき（invalidate 後の再ロック）だけは 1 件目で目標を作る。
- 前回の観測から 3 秒超の空白の後・配置変更・直接モードの後の最初の観測は**再取得（reacquire）**: 目標は保持したまま新しい窓を始め、保持していた目標との差をログ（`event=reacquire`）と HUD（`reacq=`）に出す（空白 1 回につき 1 回だけ）。
  空白は時間で判定する（遠くて窓に入れなかった観測でも「前回の観測」の時刻は進む）。ずれていれば下の作り直しで新しい位置へ移る。
- 固着の保険: 窓が 3 件未満の状態が 3 秒続き、直近 3 秒の観測のうち目標から遠い観測が 3 件以上かつ過半数なら、まとまりの条件なしでその間の観測の平均で作り直す（`reseed=N(… fb M)` の M）。
  遠い観測が二峰なら全体の平均（中間）、そうでなければ頑健な平均。低頻度の近い観測だけでは発動しない。
- 持続的なずれ（推定から 10cm 以上 / 5° 以上離れた観測が連続 `?avgReseedN=5` 件、または 3 件以上・1000ms 以上）で、**候補どうしがまとまっていれば**（候補の平均が目標から閾値以上離れ、候補のばらつきの RMS が 5cm / 2.5° 未満）窓をその観測で作り直す
  （8th Wall のドリフト・再推定の段差に追従。全履歴の平均は古い座標系に引かれるので使わない。ばらつきの条件はノイズが大きいだけで誤って作り直さないため。`reseed=N(rej M …)` の M が見送った回数）。
  候補が二峰（2 つの群に分かれ、群の中心が 5cm / 2.5° 以上・群の中のばらつきの 4 倍を超えて離れ、群の間に隙間がある。鏡像解などの 2 解が交互に出る列）なら作り直さない（`bi`）。
  まとまりの上限は候補の平均のずれに合わせて緩める（位置 max(5cm, ずれ/2)、回転 max(5°, ずれ/2)）。ノイズだけで作り直さないことは「候補の平均が 10cm / 5° 以上ずれている」で守る。
- **2 つの解が交互に出るとき**（窓が二峰）: どちらかの群が 6 割以上ならその群の平均、そうでなければ中間（全体の平均）に落ち着く。いったん選んだ群は 3 割を切るまで選び続ける（6 割の際で揺れて往復しないように）。
  二峰でない窓は各軸の中央値を基準にした頑健な平均。ただし別解が一時的に増えて推定が目標の周りの推定と食い違ったら、目標の周りを採る（混ざった平均に落ち着かないように）。
  それでも別解が窓の半分近く（45〜50%）になると、どちらかへ移ったり中間へ寄ったりすることがある（PC の合成データで確認。どちらが正しいかは窓平均では決められない）。
- 頭を速く回している間（8th Wall の姿勢の角速度が `?maxObsDegPerSec=90` 超）の観測は、映像とカメラ姿勢の時刻ずれで偏りうるので窓に入れない（`fast=` に数える）。
  invalidate 後の最初の姿勢では角速度が測れない（未測定。HUD の `rot=-`）ので、その間の観測も同じ扱い。
  - 仕様: **速い首振り（と角速度が未測定）の間は再ロックしない**（コートが出るのは 2 つ目の姿勢で角速度が測れてから）。
  - 仕様: **LIMITED が 1 秒以上続いた直接モードでは、速い首振りの観測も使う**（LIMITED 中は観測だけが頼りなので。ただし目標が無い = 再ロック前は使わない）。
- `?avgMaxN=` の下限は 3（窓が 3 件未満だと目標を更新しないため。範囲外の値は既定の 40 になる）。
- LIMITED の観測は窓にも表示にも使わない（一瞬の LIMITED ではコートを動かさない）。LIMITED が `?limitedDirectMs=1000` 以上続いている間に観測が来たら**直接モード**（窓を空にし、08-4 と同じ lerp で生の観測へ寄せる）。NORMAL に戻ったら新しい窓を始める。
- 表示は目標（窓の推定）へ毎フレーム寄せる。撃っていなければ目標そのまま、**連射中（発射後 300ms 以内）は 1 フレーム最大 5mm・0.3°** だけ寄せる（作り直し・直接モード・配置変更のどれでも発射の向きが飛ばないように）。再ロック直後（発射できない状態）は制限なし。
- 追加マーカーの配置が変わったら窓を捨てる（表示の移行は上の制限つき）。
- `?avg=0`: 08-4 と同じ lerp（`?smooth=0.5`。前回の観測から 2 秒超・30cm 超はスナップ、ただし連射中はスナップしない）。比較用。
  08-4 と同じ挙動で比べるための対照なので、連射中の 1 フレーム 5mm・0.3° の制限は掛けない（レビューで指摘があったが、比較を崩さないため不採用）。
- 使った閾値は開始時に `event=filter-config` でログに出る（実機ログを見て調整する前提）。

## 試す

```sh
export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"   # Node 22
npm ci && npm run fetch:models && npm run fetch:opencv
node scripts/preflight-stability.mjs 08-11                   # OpenCV と 8th Wall の両方が揃っているか
npm run dev -- --host 0.0.0.0
```

スマホと PC を同じ LAN に置き、`https://<Mac のホスト名>.local:<port>/demos/08-11-splatoon-8thwall-board/?room=<一意の名前>`（ホスト名は `scutil --get LocalHostName`）を開きます。
印刷するマーカーは [markers.html](./markers.html)、PC の俯瞰画面は [overview.html](./overview.html)。`?room=` と `?markerMm=` は全員と俯瞰画面で揃えます。

- 比較: 同じ場所・同じ条件で `?avg=1`（既定）と `?avg=0`（08-4 と同じ lerp）を開き直して見比べます（room 名は試行ごとに変える）。
- 08-4 と同じパラメータ: `?detector=opencv|aruco2` `?pnp=auto|ippe|iterative` `?pose=board|single`（`?poseSource=` も同じ意味） `?maxReprojPx=4` `?opencvUrl=`。08-10 のパラメータ（`?camZoom=` `?fov=` `?markerMm=` `?detW=` `?markerIntervalMs=` …）もそのまま。
- PC: `?fakecam=1&fakexr=1&fakehands=1&autostart=1&name=PC` で XR8 のモック（[fake-xr8.ts](./fake-xr8.ts)。08-10 と同じ）を通します。`?fakeXrNoise=`（8th Wall の姿勢に乗るノイズ [m]、既定 0.002）に加えて、
  `?fakeMarkerNoise=`（合成映像を描くカメラの位置にだけ乗るノイズ [m]、既定 0 = PnP の観測だけがぶれる、実機の数 cm のぶれの PC 版）で窓平均の効きを見られます。

## HUD の読み方

| 行 | 意味 |
| --- | --- |
| `!! FALLBACK: …` | OpenCV.js が読めず js-aruco2 で動いている。**比較が無効**なので記録しない |
| `xr=<status> <reason> <秒>s limited=<回数>/<直近の長さ>s age=<ms> rot=<deg/s> xrJit=<mm> relock=<ready\|required> (last invalidate: …) p=…` | 8th Wall の生の trackingStatus と trackingReason、今の状態が続いている秒数、NORMAL → それ以外になった回数と直近の長さ、姿勢の鮮度（main スレッドが止まっていた時間も含む素の値）、カメラの角速度、**xrJit=**（角速度 30°/s 未満の間の、カメラ位置の 1 秒移動平均からの 3D の RMS = 8th Wall 自体のぶれ。各軸 σ のぶれなら約 1.7σ。歩いている間は移動平均からの遅れも入るので、止まっているときに読む）。`badK` は intrinsics が不正、`nopose` は姿勢がまだ無い（invalidate 直後）、`camera=failed / exception` はカメラの状態（trackingStatus とは別。LIMITED の集計に入れない）。`p=` は投影行列の `[0,5,8,9]` と `sq=`（08-10 と同じ） |
| `jump=<回数>(afterLimited <回数>) max=<m>/<deg> last=…` | 8th Wall の姿勢の飛び（連続する 2 回の有効な姿勢の差が 0.2m 以上か 15° 以上）。afterLimited は LIMITED → NORMAL の復帰から 1 秒以内。**8th Wall が LIMITED を越えて原点を保つか**を見る一番の値 |
| `inv=orientation:… projection:… visibility:… bfcache:… cameraFailed:…` | invalidate（コートを隠して再ロック）の原因別の回数。開始時の投影設定は数えない |
| `det=<opencv\|aruco2\|loading> <試行>/<何か検出>/<採用> in <秒>s reject=… cv=<ms>` | 直近 5 秒の検出の試行・何かしらマーカーが見つかったフレーム・姿勢を採用した回数、直近の棄却理由（no layout / no solution / rejected / inconsistent / error）、検出時間 |
| `fps=` | 描画ループの間隔の EMA |
| `avg=<avg\|direct\|lerp> n=<窓の件数> spread=<mm>/<deg> res=<mm>/<deg> reseed=N(rej M bi B fb F) out= held= ign= fast= direct= reacq=<mm>/<deg>(gap <秒>s) anchor=(x,y,z)` | 窓平均の状態。spread は窓の観測の推定からの RMS（= 観測のぶれ）、res は直近の観測の（入れる前の）目標からの残差、reseed は作り直し（rej は見送った回数、bi はそのうち二峰だった回数、fb は固着の保険で作り直した回数）、out は外れ値として捨てた数、held は窓が 3 件未満の間に目標から離れていて入れなかった数、ign は短い LIMITED で使わなかった数、fast は速い首振り・角速度未測定で使わなかった数、direct は直接モードに入った回数、reacq は直近の再取得での保持していた目標との差と空白の長さ。`catching-up` は連射中の制限で表示が目標へ寄せている最中。anchor はコートのワールド位置 |
| `cam=… \| video=WxH track="…" settings=WxH@fps` | 映像の実寸とトラックの label・`getSettings()` |
| `marker=…` | 08-4 と同じ OpenCV アンカーの情報。**`Δ=` は「前回の生の観測との差」**（08-4 では表示コートとの差だったが、08-11 では OpenCV アンカーが rawAnchor に毎回の観測をそのまま写すため）。表示コートとの差は `avg=` の `res=` |
| `self=` | 送っている自分の位置（field 座標系）。08-10 と違い LIMITED 中も更新される |

## 実機ログ（`logs/client.log`）

dev サーバーのリポジトリの `logs/client.log` に、タグ `8thwall-board-phone` で書かれます（`?remoteLog=0` で無効）。

- `state:` の行: 1 秒ごとの診断の 1 行要約（`xr= relock= jump= inv= det= avg= fps= anchor= self= ids= p= shots= ws=`。同じ内容なら送らない）
- `[08-11] event=…` の行（種類ごとに 1 秒あたり 5 件まで。間引いた数は `dropped=`）:
  `filter-config`（開始時の閾値）、`opencv`（読み込み結果・フォールバック）、`camera`（映像の実寸・トラックの設定。開始時と変化時）、`intrinsics`（投影行列の変化）、
  `limited-start` / `limited-end`（理由・続いた時間）、`jump`（大きさ・status/reason・afterLimited）、`invalidate`（原因）、`relock` / `relock-required`、
  `reacquire`（空白の長さ `gapMs`・保持していた目標との差 `residual`・角速度）、`reseed`（そのときの残差・角速度）、`direct-enter` / `window-restart`、`layout`（追加マーカーの配置の変化）、`xr-exception`

```sh
grep 8thwall-board-phone logs/client.log | grep "event=" | tail -50      # イベントだけ
grep 8thwall-board-phone logs/client.log | grep " state:" | tail -20      # 1 秒ごとの要約
```

## 実機で確認すること（測り方と目安。PC の合格は実機で効いた証明ではない）

1. **止まって 10 秒見たときのコートの変動**: マーカーの正面 1〜1.5m で静止し、HUD の `avg=` の `spread=` と `anchor=` / `self=` の変化を 10 秒見る（またはログの `state:` の行の `anchor=` を並べる）。
   目安: `anchor=` の変化が 1cm 以下。**同じ場所・同じ条件で `?avg=0` と見比べる**（`?avg=0` が数 cm、`?avg=1` が 1cm 以下なら窓平均が効いている）。
   - **`?avg=1` の方が揺れて見える場合は `xrJit=` が大きいはず**。それは 8th Wall 自体の姿勢のぶれで、コートをワールドに固定する窓平均では消せない（`?avg=0` は観測ごとにコートをカメラへ寄せ直すので、8th Wall のぶれが一部打ち消されて見える。PC のモックで 8th Wall 側だけに σ=1cm のノイズを入れると、self= の RMS は avg=1 の方が大きかった）。
   - 実機では検出が 2〜5Hz になり得る（HUD の `det=` の採用数 ÷ 5 秒）。`avg=` の `n=` が 10 件に満たなければ `?avgWindowMs=5000` などに伸ばす。
2. **2m 歩いて戻ったときのずれ**: マーカーから目を離して（3 秒以上）2m 歩き、戻ってマーカーを見る。ログの `event=reacquire gapMs=… residual=…mm/…deg` の residual が「8th Wall が歩いている間にどれだけずれたか」の実測値（HUD の `reacq=` にも出る）。
   目安: 5cm 以下。実物のマーカーと描いた枠の重なりも目で見る。residual が大きいのに `jump` が出ていなければ徐々にずれている（ドリフト）、`jump` が出ていれば段差。その後の `reseed` で窓が新しい位置へ移る。
3. **LIMITED の回数・長さ・復帰時の飛び**: ログの `limited-start` / `limited-end`（`durationMs=`）と `jump ... afterLimited=1` を数える。afterLimited の飛びが多い・大きいなら、8th Wall は LIMITED を越えて原点を保っていない。
4. **LIMITED 中と復帰後の着弾のずれ**: LIMITED 中（HUD の `xr=LIMITED`）に壁の決まった点を狙って撃ち、NORMAL に戻ってからの着弾と比べる。
5. **2 台の相対位置**: 2 台で同じ room に入り、相手の頭のアバターが実物の頭に重なるかを見る（08-10 と同じ）。
6. **ログが欠けずに残るか**: 10 分程度の試遊で `state:` の行が 1 秒ごとに並んでいるか（ゴーグルに入れたまま・画面ロックなしで）。
7. HUD の `fps=` と `det=` の `cv=`（OpenCV の検出時間）、発熱・電池。OpenCV と 8th Wall の両方を回すので 08-4 / 08-10 より重い。

## 既知の制約

- **主点ずれ未補正**: 8th Wall の intrinsics から出すのは長辺の FOV だけで、OpenCV の solvePnP には主点 = 画像中央・歪みなしで渡す（08-10 と同じ近似）。HUD とログの `p=` の `P[8]` `P[9]` と `sq=` を実機で見て、0 / 1.000 から外れていれば v2 で主点と縦横比を渡す。
- **LIMITED 中は位置が信用できず、コートが滑りうる**: LIMITED 中も 8th Wall の姿勢でコートを出し続ける（ユーザーの方針）。1 秒以上続いてマーカーが見えていれば直接モードで観測へ寄せるが、見えていなければ LIMITED 中の 8th Wall の姿勢のまま。
- **8th Wall が LIMITED を越えて原点を保つかは未検証**: 保たないなら復帰後に `jump`（afterLimited）と `reseed` が出て、窓の作り直しでコートが移る。ログで確かめる。
- **重さ**: OpenCV.js（WASM、約 11MB）と 8th Wall の SLAM を同時に回す。`?markerIntervalMs=`（既定 100ms）で検出の間隔を広げられる。
- `onException`（8th Wall の例外）では invalidate しない（原点が変わったとは限らない）。主表示にエラーを出し、3 秒以上たってから reality が届けば消える。
- invalidate（向き変更など）の直後は、古い原点で計算済みの reality が届く可能性がある（推測）ので、2 フレームかつ 150ms の reality を姿勢に使わない。そのぶん再ロックが 150ms ほど遅れる。
- 姿勢の鮮度（`age=`）は素の値。08-10 の「main スレッドが止まっていた時間は数えない」補正は、鮮度切れで invalidate しない 08-11 では不要で、止まった直後に古い姿勢で `tracking:true` を送ってしまうので外した。
- 窓平均の既定値（3 秒・40 件・10cm / 5°・連射中 5mm / 0.3°）は PC の合成データで決めた値。実機ログの `spread=` `res=` `reseed` を見て調整する。

## PC での確認

```sh
npm run test:8thwall-board    # Node: 窓平均フィルタ（ノイズ・外れ値・作り直し・LIMITED・連射中の制限・lerp）と xr-source のコピー
npm run check:8thwall-board   # ヘッドレス Chrome（dev サーバー 5214 / CDP 9354。PORT= / CDP_PORT= で変更。5173 / 5210 / 5213 は使わない）
```

`check:8thwall-board` は 08-10 と同じ 2 人 + 俯瞰画面の流れ・実バイナリの smoke に加えて、LIMITED でコートが消えず発射が続くこと、原点が変わる出来事で再ロックが要ること、
`?avg=1` と `?avg=0` のぶれの比較（数値を出す）、`logs/client.log` に snapshot とイベントが書かれることを確かめます（ログを書くのは 1 ページだけ。他は `?remoteLog=0`）。
