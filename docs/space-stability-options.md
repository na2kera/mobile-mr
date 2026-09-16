# 仮想空間の安定化 — 方針の候補（提案）

2026-09-15 時点の整理。08 スプラトゥーンの仮想空間（箱型コート）が、マーカーを見ているのに斜めから見ると不安定になる問題に対して、
**今の実装（マーカーを各端末が推定する方式）を残したまま、別の方針で同じ仕様のスプラトゥーンを作って比較する**ための候補一覧。
文献調査のみで、**実機で試したものは無い**。「要確認」はそのまま未確認。
兄弟文書: [browser-measure-notes.md](./browser-measure-notes.md)（issue #53。ブラウザで「計測」ができるか。WebXR / 8th Wall / App Clip / 単眼深度の状況はそちらが詳しい）。

## 1. 要件と制約

要件（この比較で満たしたいもの）:

1. **インクがきちんと塗れて対決になる** — 狙った場所にインクが着弾し、コートが動かない。MR の強みは「現実の壁や床に塗れる」ことなので、空間が不安定だと成立しない
2. **他のユーザーの相対位置が合っている** — 自分から見た相手の位置と、相手から見た自分の位置が一致する。相手のインクが相手の手元から出て見える

制約（CONCEPT.md）:

- 実機は iPhone（iOS Safari）+ スマホ用 VR ゴーグル。**WebXR の AR 系は iOS Safari に無い**（2026-09 時点。browser-measure-notes §2）
- 「URL を開くだけ」が本線。外付けハードは「サーバーで合流」する形なら実験として可（CONCEPT.md Phase 3「外付けハードによる 6DoF」、Phase 10 の Joy-Con ハブが前例）
- LAN の dev サーバー（Vite 同居の WebSocket）。PC の俯瞰画面（`overview.html`）が既にある

## 2. いま何が起きているか（原因の整理）

症状: マーカーが見えていても、斜め（横）から見ると立方体が傾く・飛ぶ。追加マーカーを置いても収まらない。

構造上の原因は 2 つに分けられる。

| # | 原因 | どこで効くか | いま入っている対処 |
| --- | --- | --- | --- |
| A | **1 枚の平面マーカーの姿勢推定（js-aruco2 の POSIT）が斜めに弱い**。正面付近で傾きを 10〜30° 外し、表裏の 2 解が 1〜2 割混ざる（issue #54, #55）。斜めから見るとマーカーは細い台形になり、4 隅の画素誤差が奥行き・傾きに増幅される。焦点距離も推測値（PAIN_POINTS Phase 3） | 位置・ヨー・傾きの全部 | 重力で傾きだけ固定（`gravityAlign`）。位置とヨーはマーカー頼み |
| B | **複数マーカーを「どれか 1 枚を選んで原点に直す」方式**で、枚数が増えても平均されない。相対位置は巻き尺の手入力なので貼りズレがそのまま原点の飛びになる。追加マーカーは腕の長さ（原点からの距離）で A の誤差を 1〜2m に増幅する（issue #55） | 切り替わりの飛び | 候補のばらつき `spread=` と補正量 `Δ=` を HUD に出す診断のみ |
| C | **相手の位置は「各自が自分で推定した位置」の交換**。自分の誤差 + 相手の誤差が足し合わさる | 要件 2 | 無し（Phase 9 の人物対応は「誰か」の対応づけで、位置の補正はしていない） |
| D | **頭は 3DoF**。マーカーが見えない間は位置が止まり、歩くとずれる | 見回した先・移動 | ロスト時は最後の姿勢を維持（06 以降） |

A と B は「推定の数学と統合の仕方」、C と D は「構造」の問題。候補はこの 4 つのどれに効くかで分類する。

## 3. 候補一覧

判定は「この比較実験で最初に作る候補か」の目安。工数は 08 と同じ仕様のスプラトゥーンを別デモとして動かすまでの粗い見積り。

| 候補 | 方式 | 効く原因 | 要件 1 | 要件 2 | iOS Safari | 追加ハード | ライセンス | 工数 | 判定 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1a 平面 PnP + 全マーカー同時最適化 + 時間フィルタ | 推定の数学を替える | A, B | ○ | △ | ○ | 無し | 自作 | 中 | SDK 段階 2 `spatial` の内容そのもの。並行して進める |
| 1b OpenCV.js（ArUco board / ChArUco / `solvePnP`） | 実績ある実装を借りる | A, B | ○ | △ | ○（WASM） | 無し | Apache-2.0 | 小〜中 | 1a の「まず動くもの」。1a の答え合わせにもなる |
| 1c AprilTag（WASM） | 検出器を替える | A（一部） | △ | △ | ○（WASM） | 無し | BSD | 小 | 検出は堅牢だが姿勢推定の問題は残る。単独では弱い |
| 1d マーカーの物理を変える（大型化・ChArUco 板・**ディスプレイ / プロジェクタに表示**） | 観測の質を上げる | A | ○ | △ | ○ | PC の画面 or プロジェクタ | — | 小 | 1a/1b と組み合わせる。今すぐ試せる |
| **2a アウトサイドイン（PC の Web カメラでゴーグルのマーカーを追う）** | 位置を外から測る | **A, B, C, D** | ○ | **○** | ○（スマホ側は変更小） | PC + Web カメラ（+ ゴーグル用マーカー） | 自作 | 中 | **最初に作る候補として推奨** |
| 2b アウトサイドイン（PC カメラ + MediaPipe Pose で人を追う） | 同上、マーカー無し | A, B, C, D | ○ | ○ | ○ | PC + Web カメラ | Apache-2.0 | 中〜大 | 2a の次。ID の対応づけ（Phase 9 と同じ問題）が要る |
| 2c UWB（ESP32 + タグ） | 位置を電波で測る | C, D | ○ | ○ | ○ | アンカー 4 + タグ | — | 大 | CONCEPT.md 既出。3〜5 万円。2a で足りなければ |
| 3a AlvaAR（WASM の単眼 SLAM） | ブラウザで 6DoF | D（A, B は別） | △ | △ | ○（要検証） | 無し | **GPLv3** | 中 | 試す価値あり。ただしライセンスとスケール（絶対寸法）の扱い |
| 3b 8th Wall（SLAM はバイナリ配布） | ブラウザで 6DoF | D | △ | △ | ○ | 無し | 枠組み MIT / SLAM はバイナリ | 中 | 保守の見込みが不明。参考実装扱い |
| 3c Zappar Universal AR（World Tracking） | ブラウザで 6DoF | D | △ | △ | ○ | 無し | 商用（開発は無料、公開は有料プラン） | 小〜中 | 「6DoF があると何が変わるか」を最短で体感する用途 |
| 3d 床面オドメトリ（重力 + 目線の高さで床を定規にする）自作 | ブラウザで位置の増分 | D | △ | △ | ○ | 無し | 自作 | 大 | 段階 2 の研究課題。今は作らない |
| 3e サーバー側 SLAM（映像を PC へ送って処理） | 重い処理を PC へ | D | △ | △ | ○（WebRTC） | PC | 自作 or 3a を PC で | 大 | 遅延と帯域が課題。2a の方が素直 |
| 4a Variant Launch / Onirix Clip（App Clip 経由の ARKit） | ブラウザの外に出る | A, B, D | ○ | △ | △（App Clip） | 無し（Apple の配布） | 商用 | 小 | 「ブラウザだけ」の枠外。答え合わせの基準として |
| 4b AR Quick Look / `<model-viewer>` | ブラウザの外に出る | — | × | × | ○ | 無し | — | — | **不適**（後述） |
| 4c MindAR / AR.js（画像トラッキング） | マーカーを絵に替える | — | × | × | ○ | 無し | MIT | — | 今の ArUco と同種（平面ターゲット）。6DoF は無い。不採用 |
| 4d Android Chrome の WebXR | 別 OS で 6DoF | A, B, D | ○ | △ | ×（iPhone 不可） | Android 端末 | — | 中 | iPhone が本線なので比較の基準としてのみ |
| 5a 相互補正（Phase 9 の人物検出で相手の位置を合わせる） | 端末同士で補正 | C | — | ○ | ○ | 無し | 自作 | 大 | 2a の後。単独では A の誤差が先に効く |
| 5b 一度合わせて固定 + 立ち位置固定 | 割り切り | A, B（更新を止める） | △ | △ | ○ | 無し | 自作 | 小 | 補助策。どの候補にも足せる |

## 4. 各候補の詳細

### 1. 推定を良くする（インサイドアウトの改良）

**1a. 平面 PnP + 全マーカー同時最適化 + 時間フィルタ（自作）**

- 何をするか: POSIT を平面用の PnP（IPPE 系。4 点の平面から 2 解を出し、重力・前フレームとの整合で選ぶ）に替える。見えている全マーカーの 4 隅を**1 つの最適化**にかけて 1 つの姿勢を出す（今は 1 枚を選ぶ）。斜め・小さい・遠い観測は重みを下げ、位置は時間方向に平滑化（ジャイロの回転は即時、位置は緩やか）
- 効く理由: A の「斜めの 1 枚」を「複数枚の合成」に変える。同じ壁の 2 枚が同時に映れば左右方向の間隔は焦点距離の誤差に効かれない（browser-measure-notes §4 案 1）
- 限界: 斜めの平面が原理的に条件が悪いことは変わらない。相手の位置は各自の推定の足し算のまま（C）。歩くとずれる（D）
- 位置づけ: **SDK 段階 2 の `spatial`（着手順 5）で予定していた内容そのもの**（mobile-mr-sdk/CLAUDE.md「ArUco: 姿勢推定だけ自力実装」）。この比較とは独立に進み、比較の「改良版インサイドアウト」として並ぶ

**1b. OpenCV.js（ArUco board / ChArUco / `solvePnP`）**

- 何をするか: 検出と姿勢推定を OpenCV.js（WASM）に任せる。`ArucoDetector` は 4.x の objdetect に含まれ、公式ビルドの設定にも入っている。複数マーカーを 1 つの「board」として `matchImagePoints` → `solvePnP`（IPPE / RANSAC）で 1 つの姿勢にできる。ChArUco（チェス盤 + ArUco）ならコーナーがサブピクセルで取れ、斜めに強い
- メリット: 1a を自作する前に「数学を替えると本当に収まるのか」を実装 1 日で確かめられる。1a の答え合わせ（同じ入力で結果を比べる）にも使える
- デメリット: WASM が大きい（公式ビルドで数 MB〜10MB 程度。要確認）。カメラの内部パラメータ（焦点距離・歪み）を渡す前提なので、較正ページ（browser-measure-notes §4 案 3）が先に要る。CLAUDE.md の「既存ライブラリの暫定採用」なので段階 1 のルールには合うが、段階 3 で SDK に置き換える対象になる
- 関連: [OpenCV: Detection of ArUco boards](https://docs.opencv.org/4.x/db/da9/tutorial_aruco_board_detection.html)、[objdetect への移動](https://docs.opencv.org/4.x/d9/d6a/group__aruco.html)、[opencv_js.config.py](https://github.com/opencv/opencv/blob/4.x/platforms/js/opencv_js.config.py)

**1c. AprilTag（WASM）**

- apriltag の C ライブラリを Emscripten でビルドした [apriltag-js-standalone](https://github.com/arenaxr/apriltag-js-standalone)（tag36h11、`set_tag_size` で姿勢も出る）。検出は ArUco より遠く・斜めに堅牢と言われるが、姿勢推定は同じ「平面 4 点」なので A の本質は残る。1b と比べる価値はあるが単独では選ばない

**1d. マーカーの物理を変える（今すぐできる）**

- **大型化**: 実用距離はマーカー 1 辺の 10〜20 倍。A4 短辺いっぱい（190〜200mm）で 4.5〜5m（CONCEPT.md Phase 4 の換算）。斜めでも画素数が増えるので A の誤差が減る
- **ChArUco 板**: 1 枚の紙に多数のコーナー。1b とセット
- **ディスプレイ / プロジェクタに表示する**: 俯瞰画面の PC に繋いだモニタやプロジェクタで壁に大きなマーカー（板）を出す。紙より大きく・コントラストが高く・平面が保証され、**距離に応じてマーカーの大きさや枚数を変える**（近いと細かく、遠いと大きく）こともできる。08 は既に PC の俯瞰画面を必須にしているので、道具は増えない。プロジェクタなら「塗ったインクを現実の壁にも投影する」拡張（観戦者向け）にも繋がる
- どれも 1a/1b の効果を底上げする。比較実験では**マーカーの条件を揃える**ために、最初にここを決める

### 2. 位置を外から測る（アウトサイドイン）

**2a. PC の Web カメラでゴーグルのマーカーを追う ← 推奨**

```text
   [PC + Web カメラ]（部屋に固定。俯瞰画面と同じ PC）
        │ ゴーグル前面のマーカー（ID = プレイヤー）を検出 → 位置 + ヨー
        ▼
   サーバー ──WebSocket──▶ 各スマホ（位置は受け取り、回転はジャイロ）
                                  └ スマホのカメラは手の検出だけ
```

- 何をするか: ゴーグルの前面（と必要なら側面）に ArUco マーカーを貼り、部屋に固定した PC の Web カメラが全員のマーカーを検出して、部屋座標系での位置とヨーをサーバーへ送る。スマホは自分の位置をサーバーから受け取り、回転はこれまでどおりジャイロ（遅延ゼロ）。コート（仮想空間）は**カメラの座標系に固定**され、スマホが何を見ているかに依存しない。これは CONCEPT.md の UWB 案（Phase 3「外付けハードによる 6DoF」）と同じ構造で、電波の代わりにカメラを使う
- 要件への効き方:
  - 要件 1: コートは PC カメラの座標系に固定なので、プレイヤーが横を向いても動かない。マーカーが正面にあるときの推定（条件が良い）だけを使える
  - 要件 2: **全員が同じ 1 台のカメラで測られる**ので、相対位置は構造的に一致する（C を根本から消す）。相手のインクは相手の測定位置から出る
  - D: 歩いても位置が更新される（人が歩く速さなら LAN の数十 ms は許容。CONCEPT.md の UWB 案と同じ論法）
- スマホ側の変更: 「マーカーからアンカーを作る」を「サーバーから位置を受ける」に差し替えるだけ。手の検出・インク・サーバー権威の格子はそのまま
- PC 側: Chrome の `getUserMedia` で Web カメラを開き、既存の `marker-detector.ts`（js-aruco2）か 1b の OpenCV.js で検出。俯瞰画面に「カメラ」タブを足す形。カメラの位置合わせ（部屋座標系の原点）は、床や壁に置いた原点マーカーを同じカメラで一度見て決める
- 課題:
  - カメラの視野内でしか遊べない（広角 Web カメラで 3×2.5m のコートは 2〜3m 離せば入る。要確認）
  - 他の人に隠れると位置が止まる（最後の位置を保持。2 台目のカメラで解消）
  - ゴーグルのマーカーは正面を向いたときしか大きく映らない。横向きのときはヨーが取れないので、ヨーはジャイロで継続し、正面のときだけ補正する。側面にもマーカーを貼るか、ゴーグルを囲む「帯」状のマーカー列にする
  - PC 側の 1 枚の姿勢推定にも A は効く。ただし**位置だけ**使い（傾きとヨーの精密さは要らない）、距離はマーカーの見かけの大きさで出るので、斜めの弱さが実害になりにくい
  - 「URL を開くだけ」から PC + Web カメラが増える。08 は既に PC の俯瞰画面が必須なので、増えるのは Web カメラ 1 台
- 工数の目安: PC 側の検出 + 配信（既存の検出器を流用）1〜2 日、スマホ側の差し替え 1 日、ゴーグルへの貼り付けと較正 0.5 日

**2b. PC カメラ + MediaPipe Pose で人を追う（マーカー無し）**

- 2a のマーカーを外し、PC で PoseLandmarker を回して各人の頭の位置を出す。距離は 09 と同じ最小二乗（体の実寸の仮定に依存）で、精度は 2a より落ちる
- 誰がどの人物かの対応づけが要る（Phase 9 と同じ問題。入室順に手を挙げる等の儀式で解ける）
- 2a が成立した後の「マーカーを貼らない」改良として

**2c. UWB**

- CONCEPT.md Phase 3 の既出案。精度 10cm、アンカー 4 + タグで 3〜5 万円。カメラ（2a）は視野と隠れが弱点、UWB は精度とジッタが弱点。2a を先に試し、視野の制約が実害になったら

### 3. ブラウザで 6DoF を作る

**3a. AlvaAR**

- [alanross/AlvaAR](https://github.com/alanross/AlvaAR): OV²SLAM 系の単眼 SLAM を WebAssembly に移植したもの。iOS Safari での動作を謳っており、Three.js の例がある。**GPLv3**。issue は溜まっており保守は活発でない（要確認）
- 効くのは D（歩いても位置が出る）。単眼なので絶対スケールが無く、マーカーで一度スケールと原点を決める必要がある。要件 2 は各端末の SLAM の原点合わせ（= 今のマーカー問題）に戻るので、2a ほど直接には効かない
- ゴーグル装着時の背面カメラ映像（超広角・歩行の揺れ）で追跡が持つかは未知。熱（PAIN_POINTS「熱制限」）も未知
- 試すなら「マーカーで原点、AlvaAR で増分」のハイブリッド。GPLv3 はデモでは問題ないが SDK には入れられない

**3b. 8th Wall**

- 2026 年にオープンソース化。枠組み・Image Targets・Face Effects は MIT、**SLAM（World Tracking）はバイナリ配布のみ**（browser-measure-notes §2）。絶対スケールは「端末を前後に動かして推定」
- バイナリの保守の見込みが不明。3a と同じ「D にだけ効く」性質。参考実装として見る以上にはしない

**3c. Zappar Universal AR**

- [Universal AR SDK](https://zap.works/universal-ar/)（Three.js 版あり）。Instant World Tracking（ジャイロ + カメラ）と World Tracking（SLAM）を iOS Safari で提供する商用 SDK。開発は無料、公開は有料プラン（個人・非商用 $12.99/月。要確認）
- 「6DoF があると体験がどう変わるか」を**最短で体感する**用途に向く（CONCEPT.md の UWB 案の動機と同じ）。本線には乗せない

**3d. 床面オドメトリ（自作）**

- 重力（ジャイロ）でカメラの傾きが分かり、目線の高さ（Phase 6 で頭の高さから自動）を既知とすれば、**床に映った点の 3D 位置は画素から一意に決まる**（床平面へのホモグラフィ）。床の模様の特徴点を追跡すれば、SLAM より遥かに軽い「床の上の移動量」が出る
- 効くのは D。スケールは目線の高さの誤差に比例。床に模様が無い（単色のカーペット）と追跡できない
- 段階 2 の研究課題として面白いが、今の比較には重い

**3e. サーバー側 SLAM**

- スマホの映像を WebRTC で PC に送り、PC で SLAM（3a を PC で動かす等）して位置を返す。帯域（720p × 人数）と往復遅延が課題で、位置だけなら 2a の方が素直

### 4. ブラウザの外に出る / 別の入口

**4a. Variant Launch / Onirix Clip（App Clip 経由の ARKit）**

- Safari から App Clip を起動し、その中の WebView に WebXR（ARKit の 6DoF・平面・hit test）を注入する。精度は計測アプリ相当
- 「ブラウザだけ」の枠外（Apple の配布と審査、商用 SDK）。ステレオ表示（ゴーグル）と両立するかも要確認。**答え合わせの基準**（同じ部屋で ARKit の 6DoF がどれだけ安定か）として 1 度試す価値はある

**4b. AR Quick Look / `<model-viewer>` — 不適**

- `<model-viewer>` の `ar` は Android では WebXR / Scene Viewer、iOS では **AR Quick Look（USDZ をネイティブのビューアで開く）**に切り替わる。起動後はページの JavaScript が一切動かず、イベントも取れない（[model-viewer issue #18](https://github.com/google/model-viewer/issues/18)、[issue #1314](https://github.com/google/model-viewer/issues/1314)）。「1 つの 3D モデルを床に置いて眺める」専用で、カメラ映像・手・通信・ステレオ表示のどれも使えない
- このプロジェクトの要件（対戦・共有・ゴーグル）とは噛み合わないので不採用。ただし「iOS でマーカー無しに床に置ける」体験の参考にはなる

**4c. MindAR / AR.js（画像トラッキング）**

- [MindAR](https://github.com/hiukim/mind-ar-js) は画像ターゲット（任意の絵）と顔の追跡。World Tracking（6DoF）は無い（[docs](https://hiukim.github.io/mind-ar-js-doc/)）。ジッタの報告もある（[issue #556](https://github.com/hiukim/mind-ar-js/issues/556)）
- 「平面のターゲットを見て姿勢を出す」点で今の ArUco と同じ構造なので、A も C も D も解決しない。ArUco の代わりにポスターを貼れる、という違いだけ。不採用

**4d. Android Chrome の WebXR**

- `immersive-ar` + hit-test / anchors で 6DoF が取れる（browser-measure-notes §2）。iPhone では動かず、手持ちモードのみ（ゴーグル不可）。比較の基準（同じコートで WebXR ならどうか）としてのみ

### 5. 端末同士 / 割り切り

**5a. 相互補正（Phase 9 の人物検出）**

- 相手の体を自分のカメラで検出し（09）、相手の申告位置との差で相手（または自分）の位置を補正する。C に直接効くが、自分の A の誤差が先に乗るので、2a や 1a の後

**5b. 一度合わせて固定 + 立ち位置固定**

- 開始時に「マーカーの正面 1m に立って合わせる」誘導で原点を確定し、その後は信頼できる観測（正面・近い・大きい）のときだけ静かに補正する。立方体は止まるが、歩くとずれる（D）。08 の「練習 → 対戦」の流れに「位置合わせ」を足すだけなので、**どの候補にも補助として足せる**

## 5. 比較実験の進め方（案）

1. **計測（1 日）**: iPhone で角度（0 / 30 / 45 / 60°）と距離（1 / 2 / 3m）を変えてマーカーの 4 隅の画素座標を記録し、Node で POSIT（今）と平面 PnP（1a）/ OpenCV.js `solvePnP`（1b）の位置・傾きを比べる。「数学だけで足りるか（1）、構造を変えないと無理か（2）」の根拠にする。同じデータは 2a の PC 側検出の設計にも使う
2. **新デモ**: 今の 08 は残し、別ページ（`demos/08-2-splatoon-outside-in/` 等。new-demo スキル）で **08 と同じ仕様**（コート寸法・インク・タンク・練習 → 対戦 → 結果・俯瞰画面）を、位置の取り方だけ変えて作る。サーバー（`server/splatoon.ts`）と格子の権威は共有し、`pose` の出所だけ変える
3. **評価指標**（同じ部屋・同じマーカー条件で 08 と比べる）:
   - 立方体の角の画面上のぶれ [px] と、コートの原点の位置のぶれ [cm]（HUD の `spread=` / `Δ=` を流用）
   - 2 台間の相対位置の誤差 [cm]（実際の距離を巻き尺で測って比較）
   - インクの着弾の一致（同じ壁の同じ点を狙って、格子の同じセルに入る率）
   - 発熱・フレームレート（PAIN_POINTS「熱制限」）
4. **記録**: 比較の結果と痛点は `docs/PAIN_POINTS.md` へ（この PR では触っていない。PR #60 と同じ箇所で衝突するため、比較の実施時に追記する）

## 6. 提案する順番

1. **§5 の計測**を先にやる（1 日）
2. **2a（アウトサイドイン）を別デモで作る**。要件 2 に構造的に効く唯一の低コスト案で、Joy-Con ハブ・俯瞰画面の延長線にある。マーカー条件は 1d で揃える（大型化。可能なら PC の画面に表示）
3. **1a/1b は SDK 段階 2 の `spatial` として並行**して進め、改良版インサイドアウトとして比較に並べる（1b で先に「収まるか」を見るのが早い）
4. 3a（AlvaAR）と 4a（App Clip）は「6DoF の答え合わせ」として各 0.5 日ずつ触る。本線には乗せない
5. 2a で視野・隠れが実害になったら 2c（UWB）または 2 台目のカメラ

4b と 4c は不採用。

## 参考

- WebXR の iOS 状況、8th Wall、App Clip、単眼深度: [browser-measure-notes.md](./browser-measure-notes.md) の「参考」
- WebXR on iOS（2026 時点の整理）: https://xrdoctors.pro/blog/webxr-on-ios-what-actually-works
- 8th Wall のオープンソース化（SLAM はバイナリ）: https://8thwall.org/docs/open-source / https://roadtovr.com/niantic-webar-platform-8th-wall-open-source/
- AlvaAR: https://github.com/alanross/AlvaAR（GPLv3）/ デモ: https://alanross.github.io/AlvaAR/
- Zappar Universal AR: https://docs.zap.works/universal-ar/ / Instant World Tracking: https://docs.zap.works/universal-ar/a-frame/tracking/instant-world-tracking/ / World Tracking: https://www.zappar.com/blog/create-more-immersive-webar-with-zappars-new-world-tracking/ / ライセンス: https://docs.zap.works/universal-ar/general/licensing/
- Variant Launch（App Clip 経由の WebXR）: https://launch.variant3d.com/ / Onirix Clip: https://www.onirix.com/alternative-to-webxr-on-ios-for-accurate-ar/
- `<model-viewer>` の iOS（AR Quick Look）の制約: https://github.com/google/model-viewer/issues/18 / https://github.com/google/model-viewer/issues/1314 / https://cwervo.com/writing/quicklook-web/
- MindAR: https://github.com/hiukim/mind-ar-js / https://hiukim.github.io/mind-ar-js-doc/
- OpenCV ArUco board / ChArUco: https://docs.opencv.org/4.x/db/da9/tutorial_aruco_board_detection.html / OpenCV.js の設定: https://github.com/opencv/opencv/blob/4.x/platforms/js/opencv_js.config.py
- AprilTag（WASM）: https://github.com/arenaxr/apriltag-js-standalone
- 既存の関連: CONCEPT.md Phase 3「前提となる制約：現状は 3DoF しかない」「将来の拡張案：マルチマーカー」「外付けハードによる 6DoF」、PAIN_POINTS 2026-09-11（issue #54 / #55）、issue #30（マルチマーカー）
