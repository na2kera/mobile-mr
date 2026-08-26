# Mobile MR

スマートフォンとスマホ用VRゴーグルを使い、ブラウザだけで動くマルチプレイヤーMR（Mixed Reality）を試作するプロジェクトです。

複数人が同じ現実空間に集まり、各自のスマートフォンから同じ仮想オブジェクトを同じ場所に見られる状態を目指しています。まずデモを段階的に作って実装上の痛点を集め、最終的には共通部分を Mobile MR SDK として切り出す方針です。

> URLを開いた複数のスマートフォンを、同じ現実空間を共有するMRデバイス群に変える。

## 現在のデモ

| デモ | 内容 | 主な準備 |
| --- | --- | --- |
| [01. Stereo Box](./demos/01-stereo-box/) | 左右2眼レンダリングと端末の向きによる頭追従 | スマートフォン、VRゴーグル（任意） |
| [02. Passthrough](./demos/02-passthrough/) | 背面カメラ映像に3Dオブジェクトを重ねるPassthrough MR | カメラを使えるスマートフォン |
| [ex2-1. Joy-Con RC](./demos/ex2-1-joycon-rc/) | Bluetooth接続したJoy-Conで3D空間のラジコンを操作 | Joy-Con（PCではキーボードでも操作可能） |
| [03. Marker Anchor](./demos/03-marker-anchor/) | ArUcoマーカーを原点にして3Dオブジェクトを現実空間へ固定 | 印刷したマーカー |
| [04. Shared Room](./demos/04-shared-room/) | 同じマーカー座標系にいる端末同士で姿勢を共有し、相手位置にアバターを表示 | スマートフォン2台、印刷したマーカー |
| [05. Hand Interaction](./demos/05-hand-interaction/) | MediaPipeで手を追跡し、押す・触る・指差す操作を試す | カメラを使えるスマートフォン |
| [06. MR Volleyball](./demos/06-volleyball/) | マーカーを挟んで向かい合い、手で仮想ボールを打ち合う統合ゲーム（1台ならbotと練習、2台で対戦） | スマートフォン1〜2台、印刷したマーカー |

Phase 1〜5は完了し、現在はPhase 6のMRバレーボール（これまでの技術の統合）を実装しています。将来はSurface Mapping、MRスプラトゥーン、SDK化へ進む予定です。詳しい構想とロードマップは[docs/CONCEPT.md](./docs/CONCEPT.md)を参照してください。

## 技術構成

- Vite + TypeScript
- Three.js / three-stdlib
- DeviceOrientation API / MediaDevices API
- js-aruco2（マーカー検出）
- MediaPipe Tasks Vision（手の追跡）
- WebSocket（Room内の姿勢共有）

ReactなどのUIフレームワークやWebXRを前提にせず、iPhoneのSafariを中心に検証しています。

## セットアップ

### 必要なもの

- Node.js 22.18以上
- npm
- PCでの確認: WebGLを利用できるモダンブラウザ
- 実機での確認: PCと同じLANに接続したスマートフォン

### 起動

```bash
git clone https://github.com/na2kera/mobile-mr.git
cd mobile-mr
npm ci
npm run dev
```

Viteが表示したURLをブラウザで開きます。

- PC: `https://localhost:5173/`
- スマートフォン: ターミナルの `Network` 欄に表示されたURL（例: `https://192.168.1.10:5173/`）

開発サーバーは、iOS Safariでカメラとセンサーを利用できるように自己署名証明書付きのHTTPSで起動し、LAN内へ公開されます。開発時の証明書警告は想定どおりの動作です。

### iPhoneで確認する

1. 開発用PCとiPhoneを同じWi-Fiへ接続します。
2. `npm run dev` の出力にある `Network` URLをiPhoneのSafariで開きます。
3. 初回は自己署名証明書の警告画面で詳細を表示し、サイトの閲覧を続けます。
4. 一覧からデモを選び、画面の「開始」をタップしてセンサー・カメラの利用を許可します。
5. スマートフォンを横向きにし、必要に応じてVRゴーグルへ装着します。

接続できない場合は、PC側のファイアウォール、両端末が同じLANにいること、ターミナルに表示されたIPアドレスを使っていることを確認してください。センサーやカメラの許可要求はユーザー操作が必要なため、URLを開いただけではデモは開始しません。

## デモ別の追加準備

### マーカーを使うデモ（03 / 04 / 06）

1. 開発サーバーを起動します。
2. `https://localhost:5173/demos/03-marker-anchor/marker.html` を開き、マーカーを倍率100%で印刷します。
3. 印刷した黒い正方形の一辺が100mmであることを確認します。異なる大きさの場合は、デモURLへ実測値を `?markerMm=200` のように指定します。
4. 03ではマーカーをカメラに映し、04では同じマーカーを2台のスマートフォンから映します。

04で同じRoomに入る端末は、同じURLを開いてください。既定のRoom名は `demo` です。別のRoomを使う場合は、両端末に同じクエリ（例: `?room=my-room`）を指定します。中継用WebSocketサーバーはViteと同じプロセスで起動するため、別途サーバーを立ち上げる必要はありません。

### Hand Interaction（05）/ MR Volleyball（06）

MediaPipeのWasmは依存パッケージから配信されます。手の検出モデルは未取得でも公式URLへフォールバックしますが、次のコマンドでローカルへ取得しておくと、実機から外部サイトへアクセスせずに試せます。

```bash
npm run fetch:models
```

モデルファイルは約7.8MBで、`public/models/hand_landmarker.task` に保存されます（Git管理外）。

### MR Volleyball（06）

1. 03/04と同じマーカーを机に水平に置き、マーカーを挟んで向かい合います（1台だけなら相手側はbotが返球します）。
2. 両方の端末で同じURLを開いて開始し、まず机のマーカーを見ます。マーカーの真上に仮想のネットが立ち、立っている側（マーカーの下辺側=A、上辺側=B）が自動で決まります。同じ側に2人いると後から来た人は観戦扱いになるので、案内に従って反対側へ移動してください。
   - URLには05で求めた手の実寸較正 `?handScale=` を必ず付けてください（未指定は未較正の1。MediaPipeが申告する手の大きさは実際の半分程度なので、そのままでは手がボールの奥で空振りします）。較正値は05を開き、自分の手の長さ（手首のしわ→中指の先）[cm] ÷ HUDの `hand=` の値で求めます（例: 実測23cmで `hand=12cm` なら `?handScale=1.9`）。
3. ボールが自分の顔の前へ山なりに飛んでくるので、顔の前30〜60cmに手を出して触れると相手の顔の前へ自動で打ち返します（狙いは自動、手を速く振ると速い球）。落とした側の失点です。
4. ボールを見上げてマーカーが視界から外れても、ネットとボールはその場に残ります（ジャイロで回転だけ追従。歩くとずれるのでその場で遊んでください）。

ボールの物理・得点はViteに同居する対戦サーバー（`server/volleyball.ts`）が持ちます。同じroomに入る条件は04と同じ（既定 `demo`、`?room=` で分ける）で、ネットの高さ（`?netTop=`、既定は頭の高さから自動）もroom内で一致している必要があります。

## コマンド

| コマンド | 内容 |
| --- | --- |
| `npm run dev` | LAN公開・自己署名HTTPS付きの開発サーバーを起動 |
| `npm run build` | TypeScriptの型チェックと本番ビルド |
| `npm run preview` | ビルド結果をHTTPSでプレビュー |
| `npm run test:room` | Shared RoomのWebSocket回帰テスト |
| `npm run test:hand` | Hand Interactionの座標変換・操作判定の回帰テスト |
| `npm run test:volley` | MR Volleyballのボール物理・ルール・対戦サーバーの回帰テスト |
| `npm run check:volley` | MR Volleyballのブラウザ経路（マーカー→コート変換・当たり判定・予測・2ウィンドウ対戦）をヘッドレスChromeで確認（Chromeが無ければスキップ） |
| `npm run fetch:models` | Hand Landmarkerモデルをローカルへ取得 |

## ディレクトリ構成

```text
mobile-mr/
├── demos/                  # フェーズごとの独立したデモページ
├── src/shared/             # デモ間で共有する処理（マーカー、手トラッキング、パススルー、開始フロー、通信プロトコル、バレーボールの物理・ルール）
├── server/                 # Viteに同居するWebSocketサーバー（04の中継、06の対戦サーバー）
├── scripts/                # 回帰テスト、モデル取得
├── public/                 # 静的アセット
├── docs/CONCEPT.md         # 構想、技術方針、ロードマップ
└── docs/PAIN_POINTS.md     # 実装・実機検証で見つかった課題
```

## 現時点の主な制約

- スマートフォンのジャイロだけで追跡できるのは回転（3DoF）で、平行移動は取得できません。
- マーカーを使うデモでは、マーカーがカメラに映っている間だけ6DoF姿勢を更新できます。
- 背面カメラは単眼のため、現実映像そのものには左右眼の視差がありません。
- Shared RoomはLAN内での試作向けです。公開運用に必要な認証、永続化、レート制限は備えていません。
- iOS Safariではセンサー・カメラ・全画面表示に固有の制約があります。

既知の問題と試した対処は[docs/PAIN_POINTS.md](./docs/PAIN_POINTS.md)に記録しています。
