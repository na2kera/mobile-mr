// Joy-Con の HID 入力レポート 0x30（標準フルモード。IMU 付き、60Hz）の解析（純粋関数）。
// WebHID の inputreport は reportId をデータから外して渡すので、呼ぶ側で [reportId, ...data] に戻してから渡す
// （dekuNukem/Nintendo_Switch_Reverse_Engineering の bluetooth_hid_notes.md と同じオフセットで読むため）。
// 参考: https://github.com/dekuNukem/Nintendo_Switch_Reverse_Engineering/blob/master/bluetooth_hid_notes.md
//       https://github.com/dekuNukem/Nintendo_Switch_Reverse_Engineering/blob/master/imu_sensor_notes.md
// three.js に依存させない（Node の回帰テスト scripts/test-golf.mjs から import するため）

/** Nintendo の vendorId と Joy-Con (L) / (R) / Pro Controller の productId */
export const NINTENDO_VENDOR_ID = 0x057e;
export const JOYCON_L_PRODUCT_ID = 0x2006;
export const JOYCON_R_PRODUCT_ID = 0x2007;
export const PRO_CONTROLLER_PRODUCT_ID = 0x2009;

export const INPUT_REPORT_STANDARD_FULL = 0x30;
/** ペアリング直後の簡易レポート（ボタンだけ。0x30 に切り替えるまで来る） */
export const INPUT_REPORT_SIMPLE = 0x3f;
/** サブコマンドの応答 */
export const INPUT_REPORT_SUBCOMMAND_REPLY = 0x21;

/** 出力レポート 0x01（サブコマンド）の ID */
export const OUTPUT_REPORT_SUBCOMMAND = 0x01;
/** サブコマンド ID */
export const SUBCMD_SET_INPUT_REPORT_MODE = 0x03;
export const SUBCMD_SET_PLAYER_LIGHTS = 0x30;
export const SUBCMD_ENABLE_IMU = 0x40;
export const SUBCMD_ENABLE_VIBRATION = 0x48;
/** 無振動のランブルデータ 8 バイト（[00 01 40 40] × 2） */
export const RUMBLE_NEUTRAL: readonly number[] = [0x00, 0x01, 0x40, 0x40, 0x00, 0x01, 0x40, 0x40];

/** 1 レポートに載る IMU サンプル数と、その間隔 [s]（5ms） */
export const IMU_SAMPLES_PER_REPORT = 3;
export const IMU_SAMPLE_SEC = 0.005;
/** 加速度の生値 → g（±8G: 1 / 16384 × 4） */
export const ACCEL_G_PER_LSB = 0.000244;
/** ジャイロの生値 → deg/s（±2000dps、工場既定の感度係数 13371 のとき 936 / 13371 = 0.070） */
export const GYRO_DPS_PER_LSB = 0.07;

export type V3 = [number, number, number];

export type JoyConButtons = {
  y: boolean;
  x: boolean;
  b: boolean;
  a: boolean;
  /** R 側の SR / SL（横持ちの側面ボタン） */
  srR: boolean;
  slR: boolean;
  r: boolean;
  zr: boolean;
  minus: boolean;
  plus: boolean;
  rStick: boolean;
  lStick: boolean;
  home: boolean;
  capture: boolean;
  down: boolean;
  up: boolean;
  right: boolean;
  left: boolean;
  /** L 側の SR / SL */
  srL: boolean;
  slL: boolean;
  l: boolean;
  zl: boolean;
};

export type ImuSample = {
  /** 加速度 [g]（本体座標系） */
  accel: V3;
  /** 角速度 [deg/s]（本体座標系） */
  gyro: V3;
};

export type StandardReport = {
  /** バイト 1 のタイマー（0〜255 で回る。取りこぼしの検出用） */
  timer: number;
  /** バッテリー 0 / 2 / 4 / 6 / 8（上位ニブルの偶数部分。8 = 満、2 = 残りわずか） */
  battery: number;
  /** 充電中か（上位ニブルの最下位ビット） */
  charging: boolean;
  buttons: JoyConButtons;
  /** 左右のスティック（-1〜1 の粗い値。工場較正は読まないので中心のずれあり。ゴルフでは使わない） */
  leftStick: [number, number];
  rightStick: [number, number];
  /** 3 サンプル（古い順。5ms 間隔） */
  imu: ImuSample[];
};

/** 押されているボタンの名前（HUD 用） */
export function pressedNames(b: JoyConButtons): string[] {
  return (Object.keys(b) as (keyof JoyConButtons)[]).filter((k) => b[k]);
}

function int16le(bytes: Uint8Array, offset: number): number {
  const v = bytes[offset] | (bytes[offset + 1] << 8);
  return v >= 0x8000 ? v - 0x10000 : v;
}

function stick(bytes: Uint8Array, offset: number): [number, number] {
  const h = bytes[offset] | ((bytes[offset + 1] & 0x0f) << 8);
  const v = (bytes[offset + 1] >> 4) | (bytes[offset + 2] << 4);
  // 12 ビットの中心を 2048 とみなす粗い正規化（較正無し）
  return [(h - 2048) / 2048, (v - 2048) / 2048];
}

/**
 * 入力レポートの解析。bytes[0] が reportId（0x30）であること（WebHID の data には無いので呼ぶ側で足す）。
 * 0x30 以外・短すぎるものは null
 */
export function parseStandardReport(bytes: Uint8Array): StandardReport | null {
  if (bytes.length < 49 || bytes[0] !== INPUT_REPORT_STANDARD_FULL) return null;
  const b3 = bytes[3];
  const b4 = bytes[4];
  const b5 = bytes[5];
  const buttons: JoyConButtons = {
    y: (b3 & 0x01) !== 0,
    x: (b3 & 0x02) !== 0,
    b: (b3 & 0x04) !== 0,
    a: (b3 & 0x08) !== 0,
    srR: (b3 & 0x10) !== 0,
    slR: (b3 & 0x20) !== 0,
    r: (b3 & 0x40) !== 0,
    zr: (b3 & 0x80) !== 0,
    minus: (b4 & 0x01) !== 0,
    plus: (b4 & 0x02) !== 0,
    rStick: (b4 & 0x04) !== 0,
    lStick: (b4 & 0x08) !== 0,
    home: (b4 & 0x10) !== 0,
    capture: (b4 & 0x20) !== 0,
    down: (b5 & 0x01) !== 0,
    up: (b5 & 0x02) !== 0,
    right: (b5 & 0x04) !== 0,
    left: (b5 & 0x08) !== 0,
    srL: (b5 & 0x10) !== 0,
    slL: (b5 & 0x20) !== 0,
    l: (b5 & 0x40) !== 0,
    zl: (b5 & 0x80) !== 0,
  };
  const imu: ImuSample[] = [];
  for (let i = 0; i < IMU_SAMPLES_PER_REPORT; i++) {
    const o = 13 + i * 12;
    imu.push({
      accel: [int16le(bytes, o) * ACCEL_G_PER_LSB, int16le(bytes, o + 2) * ACCEL_G_PER_LSB, int16le(bytes, o + 4) * ACCEL_G_PER_LSB],
      gyro: [int16le(bytes, o + 6) * GYRO_DPS_PER_LSB, int16le(bytes, o + 8) * GYRO_DPS_PER_LSB, int16le(bytes, o + 10) * GYRO_DPS_PER_LSB],
    });
  }
  return {
    timer: bytes[1],
    battery: (bytes[2] >> 4) & 0x0e,
    charging: (bytes[2] & 0x10) !== 0,
    buttons,
    leftStick: stick(bytes, 6),
    rightStick: stick(bytes, 9),
    imu,
  };
}

/**
 * 出力レポート 0x01 のデータ部（reportId を除く）を組む: パケット番号（0〜15）+ ランブル 8 バイト + サブコマンド + 引数。
 * WebHID では device.sendReport(OUTPUT_REPORT_SUBCOMMAND, data) で送る
 */
export function subcommandPacket(counter: number, subcommand: number, args: readonly number[], rumble: readonly number[] = RUMBLE_NEUTRAL): Uint8Array {
  return new Uint8Array([counter & 0x0f, ...rumble, subcommand, ...args]);
}

/** 加速度 [g] だけを見た「静止しているか」の目安（重力 1g からのずれ） */
export function accelDeviationG(a: V3): number {
  return Math.abs(Math.hypot(a[0], a[1], a[2]) - 1);
}
