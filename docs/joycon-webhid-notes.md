# Joy-Con を WebHID から使うときのメモ（Phase 10 MR ゴルフ / 10-2 MR バッティング）

2026-09-05、Phase 10（`demos/10-golf/`）で Joy-Con をパターにするために調べ、Phase 10-2（`demos/10-2-batting/`）の投球・打撃入力でも再利用した仕様の要点。
一次資料は dekuNukem の逆解析ノートと joy-con-webhid / joycon-toolweb / Linux hid-nintendo の実装で、
codex（gpt-5.6）に照合させた結果を要約した。**実機（macOS Chrome + Joy-Con）での動作は未確認**。

## なぜ PC 経由か

- iOS Safari から Joy-Con を読む手段は Gamepad API だけで、取れるのはボタンとスティック。**IMU（ジャイロ・加速度）は取れない**。WebHID は iOS に無く、Android Chrome にも無い
- WebHID があるのは PC の Chrome。08 の俯瞰画面用 PC が既にあるので、**PC の Chrome が Joy-Con を読み、振りを検出してサーバー経由でスマホに届ける**（CONCEPT.md「外付けハードはスマホに繋がず、サーバーで合流させる」）

## 接続

- Bluetooth ペアリング: Joy-Con を本体から外し、レールの SYNC ボタンを LED が流れるまで長押し → macOS の Bluetooth 設定で接続（L / R それぞれ）
- `navigator.hid.requestDevice({ filters: [{ vendorId: 0x057e, productId: 0x2006 }, { vendorId: 0x057e, productId: 0x2007 }, { vendorId: 0x057e, productId: 0x2009 }] })`（L / R / Pro）。ユーザー操作（クリック）の中で呼ぶ。HTTPS か localhost
- 一度許可した端末はページ再読込後 `navigator.hid.getDevices()` で取れる（再 `open()` と IMU の再設定が要る）
- `productName` が "Wireless Gamepad" になることがある。左右の判定は productId で
- `disconnect` / `connect` イベントで応答待ち・積分をリセットする
- 「macOS が掴んで開けない」は既知の仕様として確認できず。開けないときは Steam・コントローラ変換ソフト・他のタブを疑う。`chrome://device-log` で見る

## 出力レポート 0x01（サブコマンド）

`device.sendReport(0x01, data)`。`data` に reportId は含めない。

| data の位置 | 内容 |
| --- | --- |
| 0 | パケットカウンタ 0x0〜0xF（送るたびに +1、16 で循環） |
| 1〜8 | ランブル（無振動 = `00 01 40 40 00 01 40 40`） |
| 9 | サブコマンド |
| 10〜 | 引数 |

| 用途 | サブコマンド + 引数 |
| --- | --- |
| IMU 有効 | `40 01` |
| フルレポート 0x30 | `03 30` |
| プレイヤー LED | `30 <mask>`（下位 4 ビット点灯、上位 4 ビット点滅） |
| IMU 感度（任意） | `41 03 00 01 01`（±2000dps / ±8G / 208Hz / 100Hz） |

応答は入力レポート 0x21。ID 込みの位置 13 が ACK（`& 0x80`）、14 が対象サブコマンド。`sendReport` の完了は送信完了でしかないので、ACK を待って（タイムアウト・再送）から次を送る。

## 入力レポート 0x30（標準フル。約 60Hz、実測は 15ms 周期 = 66Hz）

WebHID の `event.data` は reportId を除いた 48 バイト。下は **ID 込み（0 = 0x30）の位置**（`src/shared/joycon-report.ts` は呼ぶ側で `[reportId, ...data]` に戻して渡す）。

| 位置 | 内容 |
| --- | --- |
| 1 | タイマー（8 ビットで循環） |
| 2 | 上位ニブル: バッテリー（`& 0x0e` で 8/6/4/2/0。`& 0x10` は充電中）。下位: 接続情報 |
| 3 | 右のボタン: Y 01 / X 02 / B 04 / A 08 / SR 10 / SL 20 / R 40 / ZR 80 |
| 4 | 共通: − 01 / + 02 / R スティック 04 / L スティック 08 / HOME 10 / キャプチャ 20 |
| 5 | 左のボタン: 下 01 / 上 02 / 右 04 / 左 08 / SR 10 / SL 20 / L 40 / ZL 80 |
| 6〜8, 9〜11 | 左右スティック（12 ビット × 2。較正無しでは中心 2048 の保証なし） |
| 13〜48 | IMU 3 サンプル × 12 バイト（各: 加速度 XYZ、ジャイロ XYZ。int16 LE。古い順、5ms 間隔） |

換算（工場既定の較正値のとき）:

- 加速度: `raw × 0.000244` [g]（±8G）
- ジャイロ: `raw × 0.070` [deg/s]（±2000dps。LSM6DS3 の公称 70 mdps/LSB。joy-con-webhid の 0.06103 は 16 ビット全域に ±2000 を割り当てた近似で、約 15% 小さい）
- 工場較正（SPI 0x6020、24 バイト: 加速度 origin / sensitivity、ジャイロ origin / sensitivity）を読めば個体差を消せるが、振りの検出には省略で足りる。残るジャイロのバイアス（数 dps）は `swing-detector.ts` が構え（静止）のときの平均として取り、以後のサンプルから引く（積分もゼロにする）

## 本体座標系（縦持ち、ボタン面を正面、ショルダー側を上）

| 生値の + | Joy-Con L | Joy-Con R |
| --- | --- | --- |
| +X | ショルダー側（上） | ショルダー側（上） |
| +Y | 正面から見て左 | 正面から見て右 |
| +Z | ボタン面から手前 | 背面へ |

L と R は Y・Z の符号が逆（X まわりに 180° 回した関係。右手系のまま）。ゴルフの振り検出は軸を決め打ちせず「バックスイングの回転ベクトルの向き」を振りの軸にするので、L / R も持ち方も問わない。

## MR バッティングでの球種選択と振り検出

- 投手は Joy-Con L の方向ボタンで、↑ストレート / →カーブ / ←スライダー / ↓フォークを選ぶ。無入力はストレート。複数方向が同時に入った場合の優先順は「下、左、右、上」（`pitchTypeFromButtons` の判定順）。Joy-Con R の A/B/X/Y は方向ボタンの代用にはしていないため、2台使う場合は L を投手、R を打者へ明示的に割り当てる
- レポートのボタン値はその瞬間の状態でしかなく、投球の 0 通過（インパクト）より先に指を離すと球種が失われる。そのため `overview.ts` は、検出中の振りで最後に観測した方向を `selectedPitch` に保持し、ボタンを離してもインパクトまで使う。次に静止して `address` へ戻った時点でストレートへリセットする
- バッティング用 `SwingDetector` の初期値は `stillDps=25`、`stillMs=250`、`minBackswingDeg=8`、`minImpactDps=30`、`maxSwingMs=3000`、`swingStillMs=450`。ゴルフの共通既定（最小 6° / 20dps）より誤検出を抑える側へ上げている。俯瞰画面の `?minBackswing=8&minImpactDps=30` などで実機調整できる
- 速度は `impactSpeed(dps, armM, gain)` で換算し、初期値は `armM=0.65`、投球 `pitchGain=1.2`、打撃 `batGain=1.5`。上記のしきい値と補正値はフェイク Joy-Con / ヘッドレス Chrome での初期推奨値で、実 Joy-Con では持ち方・腕の長さと合わせて調整が必要

## 参考

- https://github.com/dekuNukem/Nintendo_Switch_Reverse_Engineering/blob/master/bluetooth_hid_notes.md
- https://github.com/dekuNukem/Nintendo_Switch_Reverse_Engineering/blob/master/bluetooth_hid_subcommands_notes.md
- https://github.com/dekuNukem/Nintendo_Switch_Reverse_Engineering/blob/master/imu_sensor_notes.md
- https://github.com/dekuNukem/Nintendo_Switch_Reverse_Engineering/blob/master/spi_flash_notes.md
- https://github.com/tomayac/joy-con-webhid（src/joycon.ts, src/parse.ts）
- https://github.com/mzyy94/joycon-toolweb/blob/master/controller.js
- https://github.com/torvalds/linux/blob/master/drivers/hid/hid-nintendo.c
- https://developer.chrome.com/docs/capabilities/hid
