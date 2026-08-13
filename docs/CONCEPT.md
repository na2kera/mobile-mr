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
mr.hands.on("update", hands => { /* hand position */ });
mr.body.on("update", pose => { /* body pose */ });
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

## 6. SDK構成案

将来的には以下のように分割する。

| パッケージ | 内容 |
| --- | --- |
| `@mobile-mr/core` | MR Session管理 |
| `@mobile-mr/stereo` | Stereo Rendering / Lens Configuration / FOV / IPD相当の設定 |
| `@mobile-mr/tracking` | Head / Hand / Body Tracking |
| `@mobile-mr/camera` | getUserMedia / Passthrough / Camera configuration |
| `@mobile-mr/spatial` | Anchor / Marker / Shared Origin / Surface |
| `@mobile-mr/network` | Room / Player / Transform Sync / State Sync |
| `@mobile-mr/three` | Three.js Adapter |

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

現在はPhase 1開始直前。技術スタックは Vite / TypeScript / Three.js。

最初に実装するもの：**Three.jsで単純な3Dシーンを作り、スマートフォン横画面で左右2眼表示する。**

その後、

```text
左右2眼 → ジャイロ → スマホVR完成 → 背面カメラ → MR
→ Shared Coordinates → Multiplayer → Hand Tracking → MR Volleyball
```

の順番で進める。

## 10. 開発環境の決定事項（2026-08-11）

- 実機検証は **iPhone（iOS Safari）中心**
  - `DeviceOrientationEvent.requestPermission()` が必須（ユーザージェスチャー起点）
  - `getUserMedia()` やセンサー系は secure context（HTTPS）必須 → 開発サーバーは LAN + HTTPS で公開する
- スマホ用VRゴーグル（レンズ付き）は手元にある → Phase 1 から実機でFOV・レンズ間隔等を調整できる
- 各フェーズのデモは **Viteマルチページ構成で別ページとして残す**（`src/demos/01-stereo-box/` など）。過去のデモに戻って比較できるようにし、共通化の材料を蓄積する
