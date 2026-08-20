# Mobile MR / Multiplayer XR Project

## 1. プロジェクト概要

スマートフォン + スマホ用VRゴーグルを利用して、ブラウザだけで動作するMR（Mixed Reality）環境を作る。

単なるスマホVRではなく、

**「同じ現実空間にいる複数人が、同じ仮想世界・仮想オブジェクトを共有して遊べるWebベースのマルチプレイヤーMR基盤」**

を最終目標とする。

最終的には、ゲーム固有の実装から共通機能を切り出し、他の開発者も利用できるJavaScript / TypeScriptライブラリ（Mobile MR SDK）として公開したい。

### 進め方の方針（重要）

最初からライブラリを完成させようとしない。色々なJSライブラリを使いながら「どの辺が苦しいか」を感じ、複数のデモ・ゲームを試行錯誤で実装してから共通処理を抽出する。**痛点の発見がライブラリ設計より先。**

## 2. 最終的に実現したい体験

例えば、同じ体育館や部屋に複数人が集まり、それぞれスマートフォンをVRゴーグルにセットする。

各ユーザーには背面カメラを通して現実世界が見えており、その上に3Dオブジェクトが重なって見える。

さらに、全ユーザーが同じ現実座標系を共有する。

### 例1：MRバレーボール

現実には存在しない仮想ボールとネットを、同じ空間にいる全員が同じ場所に見る。

```text
現実空間

 A                       B
🥽                      🥽
 \                      /
  \        🏐          /
   \                  /
──────── 仮想NET ────────
```

手や身体をカメラで認識し、

- 手で仮想ボールを打つ
- ボールが相手側へ飛ぶ
- 全プレイヤーから同じボール位置に見える
- 衝突・速度・得点などを同期する

といったゲームを実現する。

### 例2：MRスプラトゥーン

現実の床・壁・物体などに仮想インクを塗る。

```text
現実の壁

┌─────────────────────┐
│                     │
│    🟦🟦             │
│   🟦🟦🟦       🟥   │
│               🟥🟥  │
│                     │
└─────────────────────┘
```

Aさんが壁を青く塗ったら、Bさんの端末から見ても同じ現実の壁の同じ位置が青く見える。

つまり、「現実空間そのものをマルチプレイヤーゲームのフィールドにする」ことを目指す。

## 3. 基本技術スタック

初期構成：

```text
Vite
└── TypeScript
    └── Three.js
```

React / Next.jsなどは最初は使用しない。

理由は、UI中心のWebアプリではなく、Three.js・カメラ・センサー・レンダリングなどを直接扱うXRランタイムを作るため。

### 追加予定技術

- **3D**: Three.js
- **カメラ**: MediaDevices API / getUserMedia()
- **スマホセンサー**: DeviceOrientation API / DeviceMotion API
- **Computer Vision**: MediaPipe Tasks Vision（Hand Tracking / Pose・Body Tracking）
- **空間認識**: 初期は QR / AR Marker、将来は WebXR Anchors / WebXR Hit Test / SLAM系技術の検討
- **Multiplayer**: 初期は WebSocket、将来は WebRTC DataChannel

通信の使い分けイメージ：

```text
WebSocket
→ Room / Game State / Score / Reliable Event

WebRTC
→ Position / Rotation / Hand Pose / 高頻度データ
```

## 4. WebXRについて

WebXRだけに依存しない。

WebXR対応デバイス（Meta Quest等）ではWebXRを利用できるようにしつつ、WebXRの利用が難しいスマートフォンでも動作する仕組みを作る。そのため内部的には抽象化する。

例：

```ts
interface HeadTracker {
  start(): Promise<void>;
  getPose(): Pose;
}
```

実装：

```text
HeadTracker
├── DeviceOrientationTracker … スマホVR
└── WebXRHeadTracker …………… Quest等

StereoRenderer
├── MobileStereoRenderer …… スマホ + VRゴーグル
└── WebXRRenderer …………………… WebXRデバイス
```

のように分離できる設計を目指す。

## 5. 開発ロードマップ

### Phase 1：スマホVR

**目的**: 普通のスマートフォンを簡易VRデバイスとして利用できるようにする。

**作るもの**: 「VR射的 / VR Box Demo」— 単純なThree.js空間を作り、スマートフォンを横向きにしてVRゴーグルへ入れる。

**実装項目**:

- Three.js Scene / PerspectiveCamera / StereoCamera
- 左右2眼レンダリング
- DeviceOrientation / DeviceMotion
- Fullscreen / Landscape対応
- FOV調整 / 左右カメラ間隔調整
- VRゴーグル向け表示調整、必要に応じてレンズ歪み補正

**完成状態**:

```text
スマホ → URLを開く → 横画面 → 左右2眼表示 → VRゴーグルへ入れる
→ 頭を動かす → Three.js Cameraが追従
```

### Phase 2：Passthrough MR

**目的**: VR空間の背景として背面カメラ映像を利用する。

```text
Back Camera → getUserMedia() → Video → Three.js → Stereo Rendering
```

**作るもの**: 「MR Ball Demo」— 現実世界の中に仮想ボールが存在するように表示する。

**注意**: スマホ背面カメラは単一視点なので現実映像に本当の左右眼視差はない。CGはStereoCameraで視差を生成できる。この問題は将来的な研究・改善対象。

### Phase 3：現実空間への固定

**目的**: 3Dオブジェクトを「画面上の位置」ではなく「現実世界の特定位置」へ固定する。

**初期方式**: QR / AR MarkerをWorld Originとして利用。全端末が同じマーカーを認識することで共通座標系（X=横, Y=高さ, Z=奥行き）を構築する。

**作るもの**: 「MR Anchor Demo」— マーカーから1m先など指定した現実位置に3Dオブジェクトを配置。ユーザーが動いてもオブジェクトが現実の同じ位置に存在して見える状態を目指す。

#### 前提となる制約：現状は 3DoF しかない（2026-08-16 追記）

Phase 1 で採用した `DeviceOrientationControls` が返すのは**回転のみ（3DoF）**。スマホは自分が平行移動したことを知る手段を持たない（加速度センサーの二重積分は誤差が発散するため実用にならない）。Quest 等の HMD が内蔵カメラの SLAM で 6DoF を得ているのとはここが決定的に違う。

|          | スマホ + ゴーグル（現状） | Quest 等の HMD      |
| -------- | ------------------------- | ------------------- |
| 追跡     | 3DoF（回転のみ）          | 6DoF（回転 + 位置） |
| 首を振る | 追従する                  | 追従する            |
| 一歩歩く | **検知できない**          | 追従する            |

つまり上記「ユーザーが動いても」を素朴に満たすには 6DoF が要る。3DoF のままだと、その場で見回す分には固定されて見えるが、歩くとオブジェクトが付いてくる。

**方針**: まず (1) で作り、限界を痛点として記録してから次を検討する。

1. **マーカーを見続ける** ← Phase 3 はここから。QR が視界にある間はカメラ映像から毎フレーム 6DoF 姿勢を復元できる。視界から外れると位置を失う
2. **視覚オドメトリを自前で足す** — カメラ映像の特徴点追跡で移動量を推定。難易度が高い
3. **3DoF で割り切る** — 「その場に立って見回す」体験に限定する

#### 将来の拡張案：マルチマーカー（2026-08-17 追記、後々やる）

(1) の「視界から外れると位置を失う」制約を緩和する案として、ID の違う ArUco マーカーを部屋に複数貼る**マーカーフィールド**方式がある（ARToolKit 時代からある定番手法）。どれか1枚でも視界に入っていれば 6DoF を復元でき、「マーカーを見続ける」が「部屋のどこかを見ていればいい」に緩和される。ワールド原点は1枚（例: ID 0）に固定し、他は「原点からの相対変換」で同じ共通座標系に変換する。

増える課題:

- **マーカー間の位置関係の取得**: 手動計測（確実だが設置がだるい）か、2枚同時に視界に入った瞬間に相対変換を記録する自動キャリブレーション（楽だが誤差が連鎖的に蓄積）
- **切り替え時のズレ**: 参照マーカーが変わる瞬間に姿勢推定誤差の差分が「カクッ」と見える。同時に見えるときの平均化・切り替え補間が要る
- **検出条件**: 遠い・斜めのマーカーは検出できないか精度がガタ落ち（実用距離はマーカー1辺の10〜20倍程度が目安）。カバー範囲を広げるには枚数か寸法を増やす

UWB 案と違い外付けハード不要で「スマホ + 紙だけ」のコンセプト内に収まる。まず「原点マーカー + 1枚、相対位置は手動計測」の最小構成で切り替え時のズレを体感し、「マルチマーカーで粘る / 3DoF で割り切る / UWB 実験」の判断材料にする。

この制約は Phase 4 にも波及する（共有する `position` を、そもそも自分が取得できない）。

#### うまくいかなかった場合の代替案：外付けハードによる 6DoF（2026-08-16 追記）

QR マーカー方式が実用に耐えなかった場合の**実験ブランチ**として、UWB（Ultra-Wideband）による位置測位を検討する。電波の飛行時間を実測する方式で精度は約10cm。BLE ビーコンの電波強度方式（±0.5m 程度）とは一桁違う。部屋にアンカーを3〜4個固定し、ゴーグルにタグを付けて三辺測量する。

課題は「マイコンとブラウザが直接喋れない」こと（Web Bluetooth / Web Serial / WebUSB はいずれも iOS Safari 非対応）。これは**スマホに繋がず、サーバーで合流させる**ことで回避できる。

```text
       [UWB アンカー ×4]（部屋に固定）
              ↕ 測距
   ┌── ESP32 + UWB タグ ──WiFi──┐
   │  （ゴーグルに装着）          │
   │                          サーバー ──WebSocket──> ブラウザ
   │  スマホ（ブラウザ）──WiFi────┘        （位置 + 回転を合成）
   └── ジャイロで回転を取得（ローカル・低遅延）
```

マイコンとスマホは物理的に同じ頭に付いているだけで、論理的には同じ ID を持つ別クライアントとして扱う。Phase 4 のサーバーをそのまま流用できる。

この分担は遅延特性とも噛み合う。VR 酔いの主犯である**頭の回転**はローカルのジャイロのままで遅延ゼロ、**位置**は人が歩く速度でしか変わらないため LAN 越しの数十 ms を許容できる。3DoF（ジャイロ）+ 位置3自由度（UWB）で 6DoF が成立する。

- **想定コスト**: アンカー4個 + プレイヤー1人あたりタグ1個。2人プレイで計6個、ざっくり3〜5万円（要確認）
- **課題**: 精度10cm はジッタとして見える（IMU との融合が要る） / 実効更新レート10〜50Hz で描画60fps に対し補間が必要 / アンカー座標の校正（QR マーカーと組み合わせるのが筋） / 人体による電波遮蔽
- **注意**: 外付けハードを前提にすると「普通のスマートフォンでブラウザを開くだけ」というコンセプトから外れるため、**SDK の標準機能にはしない**。本線は Phase 3（QR マーカー）のまま進める

実験する価値は「6DoF が手に入ると体験がどう変わるか」を先に体感できる点にある。それを知らずに視覚オドメトリの自力実装へ進むのは順序として危うい。UWB で 6DoF の正解を作っておけば、後でカメラだけで実装する際の精度の答え合わせにも使える。

### Phase 4：Shared Space / Multiplayer

**目的**: 複数端末を同じMR空間へ参加させる。

**作るもの**: 「2 Player Shared MR」— 2台のスマホから同じRoomへアクセス。

```text
           Shared World

User A                     User B
  📱                         📱
   │                         │
   └──────── Server ─────────┘
```

共有データ: playerId / position / rotation / roomId

**完成状態**: Aから見たBの仮想位置と、Bから見たAの仮想位置が共通座標上で一致する。

### Phase 5：Hand / Body Tracking

**目的**: 現実の身体をMR世界の入力装置として利用する。

**技術**: MediaPipe Tasks Vision

**認識対象**: Hand（Wrist / Thumb / Index / Middle / Ring / Pinky）、Body（Head / Shoulder / Elbow / Wrist / Hip / Knee / Ankle 等）

**APIイメージ**:

```ts
mr.hands.on("update", (hands) => {
  /* hand position */
});
mr.body.on("update", (pose) => {
  /* body pose */
});
```

**作るもの**: 「MR Hand Interaction Demo」— 手で仮想ボールを触る / ボタンを押す / 指を向けて操作する等。

### Phase 6：MRバレーボール

ここまでの技術を統合する最初の本格ゲーム。

**使用機能**: Stereo Rendering / Camera Passthrough / Shared Coordinates / Multiplayer / Hand Tracking / Body Tracking / Physics

**衝突**:

```ts
if (ball.intersects(player.hand)) {
  ball.velocity = calculateHitVelocity();
}
```

**Multiplayer Physics**: Server Authoritative方式を検討。

```text
Client → Input → Server → Physics → Game State → Clients
```

各端末で物理状態がズレないようにする。

### Phase 7：Surface Mapping

**目的**: 現実の壁・床などを仮想的なSurfaceとして扱う。

```text
surfaceId: wall-12

UV
(0,0) ───────── (1,0)
 │                 │
(0,1) ───────── (1,1)
```

```ts
paint({
  surfaceId: "wall-12",
  uv: [0.42, 0.67],
  radius: 0.08,
  playerId: "A",
});
```

のように、現実の特定Surface上に情報を保存できるようにする。

### Phase 8：MRスプラトゥーン

Surface Mappingを利用。ユーザーが現実の壁・床などに仮想インクを撃つ。Aが Wall #12 の UV(0.4, 0.6) を青く塗ったら、Bから見ても同じ場所が青く見える。

**共有するもの**: Surface ID / UV / Color・Team / Radius / Timestamp / Player ID

### Phase 9：現実の人物とPlayer IDの対応

**目的**: カメラに映っている現実の人物と、ネットワーク上のPlayerを対応させる。

```text
Camera → Person Detection → 🧍
+ Network Player B position = (x,y,z)
→ Spatial Matching → この人物 = Player B
```

顔認識は最初から使わない。ネットワーク上の推定位置とカメラで認識した人体位置を比較して、最も近い人物をPlayerとして対応させる方式から検討する。

### Phase 10：SDK / Library化

複数ゲームを実装してから、共通部分を正式にライブラリへ切り出す。最初からライブラリを完成させようとしない。

```text
Game 1: VR Demo
Game 2: MR Demo
Game 3: Shared MR
Game 4: MR Volleyball
Game 5: MR Paint Game
   ↓
共通して必要だった処理を抽出
   ↓
Mobile MR SDK
```

#### ライブラリ化の3段階戦略

このプロジェクト（mobile-mr）と独自ライブラリの関係は3段階に分ける。順番を飛ばさない。

```text
段階1: mobile-mr を「既存ライブラリあり」で実装しきる（Phase 1〜9）
        three-stdlib / StereoEffect / MediaPipe 等をそのまま使う
        目的は動くMR体験を完成させることと、痛点を実体験として貯めること
        自力実装はここではやらない → docs/PAIN_POINTS.md に記録
   ↓
段階2: 別リポジトリで独自ライブラリ（Mobile MR SDK）を新規に作る
        段階1の実装と PAIN_POINTS.md を「参照実装 + 要求仕様」として使う
        コア部分はラップではなくゼロから自力実装する
   ↓
段階3: mobile-mr の既存ライブラリ依存を、独自ライブラリで置き換えていく
        一括ではなく、デモ単位・痛点が実害になった箇所から順に
        この置き換えが SDK のドッグフーディングになる
```

段階2をこのリポジトリの中で始めない（ライブラリは別プロジェクトで作る）、段階1が終わる前に自力実装へ寄り道しない、の2点が重要。

## 6. SDK構成案

将来的には以下のように分割する。

| パッケージ            | 内容                                                        |
| --------------------- | ----------------------------------------------------------- |
| `@mobile-mr/core`     | MR Session管理                                              |
| `@mobile-mr/stereo`   | Stereo Rendering / Lens Configuration / FOV / IPD相当の設定 |
| `@mobile-mr/tracking` | Head / Hand / Body Tracking                                 |
| `@mobile-mr/camera`   | getUserMedia / Passthrough / Camera configuration           |
| `@mobile-mr/spatial`  | Anchor / Marker / Shared Origin / Surface                   |
| `@mobile-mr/network`  | Room / Player / Transform Sync / State Sync                 |
| `@mobile-mr/three`    | Three.js Adapter                                            |

`@mobile-mr/core` の Session が機種差を吸収する。使う側は iPhone / Android を分岐しなくてよい。センサー許可・全画面化の順序や、1タップでは特権操作を完結できないこと（許可ダイアログでジェスチャーの効力が切れる等）は SDK 側の責務とする。

使う側が知る必要があるのは次の体験だけにする。

- 開始はユーザージェスチャー（ボタンのタップ）の中で呼ぶ
- 初回は 2 タップ目が必要なことがある
- 許可は拒否されうる

詳細・根拠は [PAIN_POINTS.md](PAIN_POINTS.md) の開始フロー関連。

## 7. 最終的なAPIイメージ

```ts
const mr = await createMRSession({
  renderer: "three",

  stereo: true,
  passthrough: true,

  tracking: {
    head: true,
    hands: true,
    body: true,
  },

  space: {
    origin: "marker",
  },

  multiplayer: {
    room: "gym-a",
  },
});
```

くらいでMR環境を開始できるようにしたい。さらに、

```ts
mr.players.on("join", player => {});
mr.players.on("move", player => {});
mr.hands.on("update", hands => {});
mr.space.createAnchor(...);
mr.network.sync(object);
```

などのAPIを提供する。

## 8. このライブラリの立ち位置

Three.jsの代替を作ることが目的ではない。Three.jsをレンダリングエンジンとして利用し、その上に、

**「普通のスマートフォンをMRデバイスとして利用するためのレイヤー」**

を構築する。A-Frameのような一般的なWebXRフレームワークとも少し目的が異なる。

特に重視するもの：

```text
普通のスマートフォン
        ↓
ブラウザでURLを開く
        ↓
スマホVRゴーグルに入れる
        ↓
Camera Passthrough
Stereo VR
Head Tracking
Hand Tracking
Body Tracking
Shared Coordinates
Multiplayer
        ↓
Multi-user MR
```

最終的なコンセプト：

> URLを開いた複数のスマートフォンを、同じ現実空間を共有するMRデバイス群に変える。

## 9. 現在地

Phase 3（共通座標系）まで完了。Phase 4（Multiplayer）を実装中。技術スタックは Vite / TypeScript / Three.js。

- Phase 1 完了（2026-08-13, `demos/01-stereo-box/`）: 左右2眼レンダリング + ジャイロ頭追従 + 全画面化。iPhone 実機 + ゴーグルで確認済み
- Phase 2 完了（2026-08-14, `demos/02-passthrough/`）: 背面超広角カメラの映像を `VideoTexture` → `scene.background` で両眼の背景に表示。縦横比補正・回転追従・解像度指定込み。iPhone 実機で確認済み
- Phase 3 完了（2026-08-16, `demos/03-marker-anchor/`）: ArUco マーカー（js-aruco2）を World Origin にして 3D オブジェクトを現実位置に固定。姿勢推定の検証・平滑化・ロスト処理込み。iPhone 実機で確認済み
- Phase 4 実装中（2026-08-17, `demos/04-shared-room/`）: WebSocket（Vite dev サーバー同居）でマーカー座標系の pose を交換し、相手の位置にアバターを表示。**iPhone 2台 + マーカーで実機確認済み（2026-08-20）**: 相互の位置一致・移動追従とも良好。単一マーカーの実用距離は detW=960 で約 2.5m（PAIN_POINTS 参照）
  - 実用距離を伸ばすアイデア（後々やる。実測 100mm ≈ 2.5m からの換算）: **(1) マーカー拡大印刷** — A4 短辺いっぱいの正方形（黒枠 190〜200mm、余白考慮）なら 4.5〜5m が期待でき、部屋規模に近づく。両端末で `?markerMm=` を実測値に合わせること（Room の空間設定検証で不一致は入室拒否される）。marker.html に印刷サイズ指定を足すとなお良い **(2) マルチマーカー** — Phase 3 の「将来の拡張案」参照。(1) で足りなければ着手
  - スコープ外と明示した項目: **bfcache 復帰時のカメラ再開**（WebSocket は再接続するがカメラは HUD 警告のみ。02/03 共通の未対応領域で、段階2 SDK の lifecycle 層でまとめて設計する。PAIN_POINTS 参照）、**認証・レート制限・本番サーバーへの組み込み**（LAN デモの範囲では不要。公開運用時の課題）

残りは

```text
Multiplayer → Hand Tracking → MR Volleyball
```

の順番で進める。

## 10. 開発環境の決定事項（2026-08-11）

- 実機検証は **iPhone（iOS Safari）中心**
  - `DeviceOrientationEvent.requestPermission()` が必須（ユーザージェスチャー起点）
  - `getUserMedia()` やセンサー系は secure context（HTTPS）必須 → 開発サーバーは LAN + HTTPS で公開する
- スマホ用VRゴーグル（レンズ付き）は手元にある → Phase 1 から実機でFOV・レンズ間隔等を調整できる
- 各フェーズのデモは **Viteマルチページ構成で別ページとして残す**（`src/demos/01-stereo-box/` など）。過去のデモに戻って比較できるようにし、共通化の材料を蓄積する
