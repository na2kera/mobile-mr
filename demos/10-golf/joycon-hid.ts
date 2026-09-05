// Joy-Con を WebHID（PC の Chrome）で開き、IMU 付きの入力レポート 0x30 を受け取る薄いドライバ。
// 仕様の根拠は docs/joycon-webhid-notes.md。レポートの解析は src/shared/joycon-report.ts（純粋。Node テスト済み）。
// ここは「開く → サブコマンド（IMU 有効・フルレポート・LED）を ACK を待ちながら送る → inputreport を配る」だけ。
// 振りの検出（swing-detector.ts）や誰の 1 打かの割り当ては overview.ts が持つ。
// フェイク（?fakeJoycon=1）: 実機が無い PC・ヘッドレス確認のために、合成のジャイロ列（構え → バックスイング → 戻り）を
// 同じ形の StandardReport で流す
import {
  INPUT_REPORT_STANDARD_FULL,
  INPUT_REPORT_SUBCOMMAND_REPLY,
  JOYCON_L_PRODUCT_ID,
  JOYCON_R_PRODUCT_ID,
  NINTENDO_VENDOR_ID,
  OUTPUT_REPORT_SUBCOMMAND,
  PRO_CONTROLLER_PRODUCT_ID,
  SUBCMD_ENABLE_IMU,
  SUBCMD_SET_INPUT_REPORT_MODE,
  SUBCMD_SET_PLAYER_LIGHTS,
  parseStandardReport,
  subcommandPacket,
} from "../../src/shared/joycon-report";
import type { StandardReport, V3 } from "../../src/shared/joycon-report";

// ---- WebHID の型（TS の lib.dom には無いので必要な分だけ） ----
type HIDInputReportEvent = Event & { reportId: number; data: DataView; device: HIDDeviceLike };
type HIDDeviceLike = {
  vendorId: number;
  productId: number;
  productName: string;
  opened: boolean;
  open(): Promise<void>;
  close(): Promise<void>;
  sendReport(reportId: number, data: Uint8Array): Promise<void>;
  addEventListener(type: "inputreport", listener: (e: HIDInputReportEvent) => void): void;
  removeEventListener(type: "inputreport", listener: (e: HIDInputReportEvent) => void): void;
};
type HIDLike = {
  requestDevice(opts: { filters: { vendorId: number; productId?: number }[] }): Promise<HIDDeviceLike[]>;
  getDevices(): Promise<HIDDeviceLike[]>;
  addEventListener(type: "connect" | "disconnect", listener: (e: { device: HIDDeviceLike }) => void): void;
};

function hidOf(): HIDLike | null {
  const n = navigator as Navigator & { hid?: HIDLike };
  return n.hid ?? null;
}

export function hidSupported(): boolean {
  return hidOf() !== null;
}

export type JoyConKind = "L" | "R" | "Pro" | "?";

export function kindOf(productId: number): JoyConKind {
  return productId === JOYCON_L_PRODUCT_ID ? "L" : productId === JOYCON_R_PRODUCT_ID ? "R" : productId === PRO_CONTROLLER_PRODUCT_ID ? "Pro" : "?";
}

export type JoyConEvents = {
  /** 開いて初期化できた（「接続」ボタン・ページ再読込後の再開・Bluetooth の再接続のどれでも呼ぶ） */
  onConnect: (jc: JoyCon) => void;
  onReport: (jc: JoyCon, report: StandardReport, nowMs: number) => void;
  onStatus: (jc: JoyCon, status: string) => void;
  onDisconnect: (jc: JoyCon) => void;
};

/** 開いた 1 台。実機（WebHID）とフェイクの共通の見た目 */
export type JoyCon = {
  readonly key: string;
  readonly kind: JoyConKind;
  readonly name: string;
  readonly fake: boolean;
  /** 初期化の状態（"opening" / "imu" / "mode" / "ready" / エラー文字列） */
  status: string;
  /** 直近の 0x30 の受信時刻 [ms] と受信数（レート確認用） */
  lastReportMs: number;
  reports: number;
  battery: number;
  charging: boolean;
  /** プレイヤー LED（1〜4）を点ける。失敗しても無視 */
  setLights(index: number): Promise<void>;
  close(): Promise<void>;
};

const FILTERS = [
  { vendorId: NINTENDO_VENDOR_ID, productId: JOYCON_L_PRODUCT_ID },
  { vendorId: NINTENDO_VENDOR_ID, productId: JOYCON_R_PRODUCT_ID },
  { vendorId: NINTENDO_VENDOR_ID, productId: PRO_CONTROLLER_PRODUCT_ID },
];
const ACK_TIMEOUT_MS = 600;
const ACK_RETRIES = 3;

class HidJoyCon implements JoyCon {
  readonly key: string;
  readonly kind: JoyConKind;
  readonly name: string;
  readonly fake = false;
  status = "opening";
  lastReportMs = -Infinity;
  reports = 0;
  battery = 0;
  charging = false;
  private counter = 0;
  private readonly full = new Uint8Array(64);
  /** サブコマンドの ACK 待ち（対象サブコマンド → 解決） */
  private ackWaiters = new Map<number, () => void>();
  /** 切断・除去された（初期化の途中でも以後は onConnect を呼ばない） */
  disposed = false;
  private readonly listener: (e: HIDInputReportEvent) => void;
  readonly device: HIDDeviceLike;
  private readonly events: JoyConEvents;

  constructor(device: HIDDeviceLike, events: JoyConEvents) {
    this.device = device;
    this.events = events;
    this.kind = kindOf(device.productId);
    this.name = `${device.productName || "Joy-Con"} (${this.kind})`;
    this.key = `hid:${device.vendorId}:${device.productId}:${device.productName}:${Math.random().toString(36).slice(2, 6)}`;
    this.listener = (e) => this.onInputReport(e);
  }

  private onInputReport(e: HIDInputReportEvent) {
    const now = performance.now();
    const data = new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength);
    if (e.reportId === INPUT_REPORT_SUBCOMMAND_REPLY) {
      // ID 込みの位置 13 が ACK、14 が対象サブコマンド → data では 12 / 13
      const ack = (data[12] & 0x80) !== 0;
      const sub = data[13];
      const waiter = this.ackWaiters.get(sub);
      if (ack && waiter) {
        this.ackWaiters.delete(sub);
        waiter();
      }
      return;
    }
    if (e.reportId !== INPUT_REPORT_STANDARD_FULL || data.length < 48) return; // 短いものは前回のバイトが残るので捨てる
    // 解析は「reportId 込み」のレイアウトで（docs の表と同じ位置）
    this.full[0] = INPUT_REPORT_STANDARD_FULL;
    this.full.set(data.subarray(0, Math.min(data.length, 63)), 1);
    const report = parseStandardReport(this.full);
    if (!report) return;
    this.lastReportMs = now;
    this.reports++;
    this.battery = report.battery;
    this.charging = report.charging;
    this.events.onReport(this, report, now);
  }

  private async send(subcommand: number, args: number[]): Promise<boolean> {
    for (let attempt = 0; attempt < ACK_RETRIES && !this.disposed; attempt++) {
      const acked = new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          this.ackWaiters.delete(subcommand);
          resolve(false);
        }, ACK_TIMEOUT_MS);
        this.ackWaiters.set(subcommand, () => {
          clearTimeout(timer);
          resolve(true);
        });
      });
      const packet = subcommandPacket(this.counter++, subcommand, args);
      try {
        await this.device.sendReport(OUTPUT_REPORT_SUBCOMMAND, packet);
      } catch (e: unknown) {
        this.ackWaiters.delete(subcommand);
        this.setStatus(`sendReport 失敗: ${errorText(e)}`);
        return false;
      }
      if (await acked) return true;
    }
    return false;
  }

  private setStatus(s: string) {
    this.status = s;
    this.events.onStatus(this, s);
  }

  async init(lightIndex: number): Promise<void> {
    try {
      if (!this.device.opened) await this.device.open();
    } catch (e: unknown) {
      this.setStatus(`open 失敗: ${errorText(e)}`);
      throw e;
    }
    this.device.addEventListener("inputreport", this.listener);
    this.setStatus("imu");
    const imuOk = await this.send(SUBCMD_ENABLE_IMU, [0x01]);
    this.setStatus(imuOk ? "mode" : "mode (IMU の ACK 無し)");
    const modeOk = await this.send(SUBCMD_SET_INPUT_REPORT_MODE, [INPUT_REPORT_STANDARD_FULL]);
    await this.setLights(lightIndex);
    // ACK が来なくてもレポートが来ていれば実用上は動く（ACK の位置が機種で違う可能性への保険）
    this.setStatus(modeOk && imuOk ? "ready" : "ready (ACK 無し。0x30 が来るか HUD で確認)");
  }

  async setLights(index: number): Promise<void> {
    const mask = 1 << Math.max(0, Math.min(3, index - 1));
    await this.send(SUBCMD_SET_PLAYER_LIGHTS, [mask]).catch(() => false);
  }

  async close(): Promise<void> {
    this.device.removeEventListener("inputreport", this.listener);
    try {
      await this.device.close();
    } catch {
      // 既に切れている
    }
  }
}

function errorText(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

/** 接続中の一覧を持ち、選択・再接続・切断を扱う */
export class JoyConHub {
  readonly joycons: JoyCon[] = [];
  private readonly byDevice = new Map<HIDDeviceLike, HidJoyCon>();
  private listening = false;
  private readonly events: JoyConEvents;

  constructor(events: JoyConEvents) {
    this.events = events;
  }

  /** ユーザー操作（クリック）の中で呼ぶ。選択された台を開いて初期化する */
  async request(): Promise<JoyCon[]> {
    const hid = hidOf();
    if (!hid) throw new Error("WebHID が使えません（PC の Chrome で開いてください）");
    const devices = await hid.requestDevice({ filters: FILTERS });
    return this.adopt(devices);
  }

  /** 以前に許可した台を開き直す（ページ再読込後） */
  async reconnect(): Promise<JoyCon[]> {
    const hid = hidOf();
    if (!hid) return [];
    const devices = await hid.getDevices();
    return this.adopt(devices.filter((d) => d.vendorId === NINTENDO_VENDOR_ID));
  }

  private listen() {
    const hid = hidOf();
    if (!hid || this.listening) return;
    this.listening = true;
    hid.addEventListener("disconnect", (e) => {
      const jc = this.byDevice.get(e.device);
      if (!jc) return;
      this.remove(jc);
      this.events.onDisconnect(jc);
    });
    hid.addEventListener("connect", (e) => {
      if (e.device.vendorId === NINTENDO_VENDOR_ID && !this.byDevice.has(e.device)) void this.adopt([e.device]);
    });
  }

  private async adopt(devices: HIDDeviceLike[]): Promise<JoyCon[]> {
    this.listen();
    const added: JoyCon[] = [];
    for (const device of devices) {
      if (this.byDevice.has(device)) continue;
      const jc = new HidJoyCon(device, this.events);
      this.byDevice.set(device, jc);
      this.joycons.push(jc);
      added.push(jc);
      try {
        await jc.init(this.joycons.length);
        // 初期化の途中で切断された（disconnect が remove 済み）なら通知しない（外部レビュー指摘）
        if (jc.disposed || this.byDevice.get(device) !== jc) continue;
        this.events.onConnect(jc);
      } catch {
        this.remove(jc);
        continue;
      }
    }
    return added;
  }

  addFake(fake: JoyCon) {
    this.joycons.push(fake);
  }

  private remove(jc: JoyCon) {
    const i = this.joycons.indexOf(jc);
    if (i >= 0) this.joycons.splice(i, 1);
    if (jc instanceof HidJoyCon) {
      jc.disposed = true;
      this.byDevice.delete(jc.device);
    }
  }
}

// ---- フェイク Joy-Con（PC / ヘッドレス確認用）----
// 合成のジャイロ: 静止 → バックスイング（backDeg まで backDps）→ 戻り（impactDps で 0 を通過してフォロースルー）→ 静止 を、
// trigger() が呼ばれるたびに 1 回演じる（自動で振らせるのは overview.ts が「自分の手番のとき」に決める）。
// 加速度は「上」を +Z に固定した 1g

export type FakeSwingParams = { backDeg: number; backDps: number; impactDps: number; yawDps: number };

export class FakeJoyCon implements JoyCon {
  readonly key = "fake";
  readonly kind: JoyConKind = "?";
  readonly name = "フェイク Joy-Con";
  readonly fake = true;
  status = "ready (fake)";
  lastReportMs = -Infinity;
  reports = 0;
  battery = 8;
  charging = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** いま演じている振り（残りのサンプル列） */
  private queue: V3[] = [];
  private pressA = 0;
  private readonly events: JoyConEvents;

  constructor(events: JoyConEvents) {
    this.events = events;
    // 15ms ごとに 3 サンプル（実機と同じ形）
    this.timer = setInterval(() => this.tick(), 15);
  }

  /** 1 回の振りを予約する。impactDps は戻りの角速度（ボールの速さは armM × gain で決まる） */
  trigger(p: FakeSwingParams) {
    const dt = 0.005;
    const seq: V3[] = [];
    const backSec = p.backDeg / p.backDps;
    for (let t = 0; t < backSec; t += dt) seq.push([p.backDps, 0, 0]);
    const fwdSec = (p.backDeg * 1.6) / p.impactDps;
    for (let t = 0; t < fwdSec; t += dt) seq.push([-p.impactDps, 0, p.yawDps]);
    // 戻ったあと静止（構え直しが起きる長さ）
    for (let t = 0; t < 0.4; t += dt) seq.push([0, 0, 0]);
    this.queue.push(...seq);
  }

  /** A ボタンを 1 レポートぶん押す（構え） */
  pressAddress() {
    this.pressA = 2;
  }

  private tick() {
    const now = performance.now();
    const imu = [] as StandardReport["imu"];
    for (let i = 0; i < 3; i++) {
      const g = this.queue.shift() ?? [0.3, -0.2, 0.1];
      imu.push({ accel: [0, 0, 1], gyro: g });
    }
    const a = this.pressA > 0;
    if (this.pressA > 0) this.pressA--;
    const report: StandardReport = {
      timer: this.reports & 0xff,
      battery: 8,
      charging: false,
      buttons: { y: false, x: false, b: false, a, srR: false, slR: false, r: false, zr: false, minus: false, plus: false, rStick: false, lStick: false, home: false, capture: false, down: false, up: false, right: false, left: false, srL: false, slL: false, l: false, zl: false },
      leftStick: [0, 0],
      rightStick: [0, 0],
      imu,
    };
    this.lastReportMs = now;
    this.reports++;
    this.events.onReport(this, report, now);
  }

  async setLights(): Promise<void> {}
  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
