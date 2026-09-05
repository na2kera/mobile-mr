// Joy-Con 単体の診断ページ。ゲーム（通信・カメラ・マーカー）と切り離して、WebHID で生のレポートが
// 届いているかだけを画面に出す。10-golf で「Joy-Con が反応しない」ときの切り分け用。
//   - navigator.hid の有無・許可済みデバイス
//   - open() の成否、サブコマンド（IMU 有効 / フルレポート 0x30）の送信と ACK
//   - 受信したレポートを reportId ごとに数える（0x3f だけなら「サブコマンドが効いていない」）
//   - 0x30 の中身（IMU・ボタン）と、swing-detector の状態
// 実装は joycon-hid.ts を経由せず、WebHID を直に叩く（ドライバ側の問題と切り分けるため）
import { INPUT_REPORT_STANDARD_FULL, INPUT_REPORT_SUBCOMMAND_REPLY, NINTENDO_VENDOR_ID, OUTPUT_REPORT_SUBCOMMAND, SUBCMD_ENABLE_IMU, SUBCMD_SET_INPUT_REPORT_MODE, SUBCMD_SET_PLAYER_LIGHTS, parseStandardReport, pressedNames, subcommandPacket } from "../../src/shared/joycon-report";
import type { StandardReport } from "../../src/shared/joycon-report";
import { SwingDetector } from "../../src/shared/swing-detector";
import { startRemoteLog } from "../../src/shared/remote-log";
import { IMU_SAMPLE_SEC } from "../../src/shared/joycon-report";

type HIDInputReportEvent = Event & { reportId: number; data: DataView };
type HIDDeviceLike = {
  vendorId: number;
  productId: number;
  productName: string;
  opened: boolean;
  collections?: { outputReports?: { reportId: number; items?: unknown[] }[]; inputReports?: { reportId: number }[] }[];
  open(): Promise<void>;
  sendReport(reportId: number, data: Uint8Array): Promise<void>;
  addEventListener(type: "inputreport", listener: (e: HIDInputReportEvent) => void): void;
};
type HIDLike = {
  requestDevice(opts: { filters: { vendorId: number }[] }): Promise<HIDDeviceLike[]>;
  getDevices(): Promise<HIDDeviceLike[]>;
};

// 画面を見られない場所で試すとき用に、ログを dev サーバーのファイル（logs/client.log）へ残す
startRemoteLog({
  tag: "joycon-test",
  snapshot: () => `reports=${[...counts.entries()].map(([id, n]) => `0x${id.toString(16)}:${n}`).join(",") || "-"} det=${det.phase} angle=${det.angleDeg.toFixed(0)} addresses=${det.addresses} last=${lastReport ? `gyro(${lastReport.imu[2].gyro.map((v) => v.toFixed(0)).join(",")}) accel(${lastReport.imu[2].accel.map((v) => v.toFixed(2)).join(",")}) btn=${pressedNames(lastReport.buttons).join("+") || "-"}` : "-"}`,
  snapshotMs: 2000,
});

const hid = (navigator as Navigator & { hid?: HIDLike }).hid ?? null;
const el = (id: string) => document.querySelector<HTMLElement>(`#${id}`)!;
const connectButton = document.querySelector<HTMLButtonElement>("#connect")!;
const resendButton = document.querySelector<HTMLButtonElement>("#resend")!;

const logLines: string[] = [];
function log(text: string) {
  const t = new Date().toLocaleTimeString("ja-JP", { hour12: false });
  logLines.unshift(`${t} ${text}`);
  if (logLines.length > 200) logLines.pop();
  el("log").textContent = logLines.join("\n");
  console.log(`[joycon-test] ${text}`);
}

function errorText(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

// ---- 1. 環境 ----
async function showEnv() {
  const lines = [
    `navigator.hid: ${hid ? "あり" : "無し（PC の Chrome で開いてください。Safari / Firefox / iOS は非対応）"}`,
    `secure context: ${isSecureContext ? "はい" : "いいえ（HTTPS か localhost が必要）"}`,
    `userAgent: ${navigator.userAgent}`,
  ];
  if (hid) {
    try {
      const devices = await hid.getDevices();
      lines.push(`許可済みのデバイス: ${devices.length === 0 ? "無し（「Joy-Con を接続」を押してください）" : devices.map((d) => `${d.productName} (VID ${d.vendorId.toString(16)} / PID ${d.productId.toString(16)}) opened=${d.opened}`).join(" / ")}`);
    } catch (e: unknown) {
      lines.push(`getDevices 失敗: ${errorText(e)}`);
    }
  }
  el("env").textContent = lines.join("\n");
}
void showEnv();
if (!hid) connectButton.disabled = true;

// ---- 2〜5. 受信 ----
let device: HIDDeviceLike | null = null;
/** reportId ごとの受信数 */
const counts = new Map<number, number>();
let lastRaw = "";
let lastReport: StandardReport | null = null;
let lastAnyMs = -Infinity;
const det = new SwingDetector();
const swingLines: string[] = [];
/** サブコマンドの ACK 待ち */
const ackWaiters = new Map<number, (ok: boolean) => void>();
let counter = 0;
const full = new Uint8Array(64);

function onInputReport(e: HIDInputReportEvent) {
  const now = performance.now();
  lastAnyMs = now;
  counts.set(e.reportId, (counts.get(e.reportId) ?? 0) + 1);
  const data = new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength);
  lastRaw = `reportId 0x${e.reportId.toString(16).padStart(2, "0")} / ${data.length} バイト\n${[...data.slice(0, 24)].map((b) => b.toString(16).padStart(2, "0")).join(" ")}${data.length > 24 ? " …" : ""}`;

  if (e.reportId === INPUT_REPORT_SUBCOMMAND_REPLY) {
    const ack = (data[12] & 0x80) !== 0;
    const sub = data[13];
    const waiter = ackWaiters.get(sub);
    log(`0x21 応答: ACK=${ack ? "あり" : "無し"} サブコマンド 0x${sub.toString(16)}`);
    if (waiter) {
      ackWaiters.delete(sub);
      waiter(ack);
    }
    return;
  }
  if (e.reportId !== INPUT_REPORT_STANDARD_FULL || data.length < 48) return;
  full[0] = INPUT_REPORT_STANDARD_FULL;
  full.set(data.subarray(0, Math.min(data.length, 63)), 1);
  const report = parseStandardReport(full);
  if (!report) return;
  lastReport = report;
  for (let i = 0; i < report.imu.length; i++) {
    const s = report.imu[i];
    const t = now - (report.imu.length - 1 - i) * IMU_SAMPLE_SEC * 1000;
    const impact = det.sample(t, s.gyro, s.accel, IMU_SAMPLE_SEC);
    if (impact) {
      swingLines.unshift(`インパクト: ${impact.dps.toFixed(0)} deg/s（バック ${impact.backswingDeg.toFixed(0)}°, 面 ${impact.faceDeg.toFixed(1)}°, ${impact.swingMs.toFixed(0)}ms）`);
      if (swingLines.length > 8) swingLines.pop();
      log(`振りを検出: ${swingLines[0]}`);
    }
  }
}

/** サブコマンドを 1 つ送って ACK を待つ */
async function send(sub: number, args: number[], label: string): Promise<boolean> {
  if (!device) return false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const acked = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        ackWaiters.delete(sub);
        resolve(false);
      }, 800);
      ackWaiters.set(sub, (ok) => {
        clearTimeout(timer);
        resolve(ok);
      });
    });
    try {
      await device.sendReport(OUTPUT_REPORT_SUBCOMMAND, subcommandPacket(counter++, sub, args));
      log(`${label}: 送信した（${attempt} 回目）`);
    } catch (e: unknown) {
      log(`${label}: sendReport 失敗 — ${errorText(e)}`);
      return false;
    }
    if (await acked) {
      log(`${label}: ACK あり`);
      return true;
    }
    log(`${label}: ACK 無し（${attempt} 回目）`);
  }
  return false;
}

async function setup(d: HIDDeviceLike) {
  device = d;
  log(`デバイス: ${d.productName} (VID 0x${d.vendorId.toString(16)} / PID 0x${d.productId.toString(16)})`);
  // HID 記述子に出力レポート 0x01 があるか（無ければサブコマンドが送れない可能性）
  const outIds = (d.collections ?? []).flatMap((c) => (c.outputReports ?? []).map((r) => r.reportId));
  const inIds = (d.collections ?? []).flatMap((c) => (c.inputReports ?? []).map((r) => r.reportId));
  log(`記述子: 入力レポート [${inIds.map((i) => "0x" + i.toString(16)).join(", ")}] / 出力レポート [${outIds.map((i) => "0x" + i.toString(16)).join(", ")}]`);
  if (!d.opened) {
    try {
      await d.open();
      log("open(): 成功");
    } catch (e: unknown) {
      log(`open(): 失敗 — ${errorText(e)}（他のアプリが掴んでいる可能性。Steam・コントローラ変換ソフト・他のタブを終了して再試行）`);
      return;
    }
  } else {
    log("open(): すでに開いている");
  }
  d.addEventListener("inputreport", onInputReport);
  log("inputreport を待ち受け開始（この時点で 0x3f が来ていればデバイスは生きています）");
  resendButton.disabled = false;
  await sendSubcommands();
}

async function sendSubcommands() {
  await send(SUBCMD_ENABLE_IMU, [0x01], "IMU 有効 (0x40)");
  await send(SUBCMD_SET_INPUT_REPORT_MODE, [INPUT_REPORT_STANDARD_FULL], "フルレポート 0x30 (0x03)");
  await send(SUBCMD_SET_PLAYER_LIGHTS, [0x01], "プレイヤー LED (0x30)");
  log("サブコマンド送信おわり。Joy-Con を動かして「3. IMU」の数字が動くか見てください");
}

connectButton.addEventListener("click", async () => {
  if (!hid) return;
  connectButton.disabled = true;
  try {
    // 既に許可済みならそれを使う（毎回ダイアログを出さない）
    const known = (await hid.getDevices()).filter((d) => d.vendorId === NINTENDO_VENDOR_ID);
    const picked = known.length > 0 ? known : await hid.requestDevice({ filters: [{ vendorId: NINTENDO_VENDOR_ID }] });
    if (picked.length === 0) {
      log("デバイスが選ばれませんでした（ダイアログに Joy-Con が出ない場合は、macOS の Bluetooth 設定で接続済みか確認）");
      return;
    }
    for (const d of picked) await setup(d);
  } catch (e: unknown) {
    log(`接続に失敗: ${errorText(e)}`);
  } finally {
    connectButton.disabled = false;
    void showEnv();
  }
});
resendButton.addEventListener("click", () => void sendSubcommands());

// ---- 表示の更新 ----
setInterval(() => {
  const now = performance.now();
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  if (total === 0) {
    el("counts").textContent = device ? "レポートがまだ 1 件も届いていません" : "まだ 1 件も受信していません";
    el("counts").className = "big ng";
  } else {
    const parts = [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([id, n]) => `0x${id.toString(16).padStart(2, "0")}: ${n} 件`);
    const live = now - lastAnyMs < 500;
    const has30 = (counts.get(INPUT_REPORT_STANDARD_FULL) ?? 0) > 0;
    el("counts").textContent = `${parts.join(" / ")}${live ? "（受信中）" : "（止まっています）"}`;
    el("counts").className = `big ${has30 ? "ok" : "warn"}`;
  }
  el("raw").textContent = lastRaw || (device ? "（まだ届いていません）" : "");
  if (!(counts.get(INPUT_REPORT_STANDARD_FULL) ?? 0)) {
    el("imu").textContent = counts.size > 0 ? "0x30 が来ていません（サブコマンドが効いていない可能性 → 送り直す）" : "-";
    el("imu").className = "big warn";
  } else if (lastReport) {
    const g = lastReport.imu[2].gyro;
    const a = lastReport.imu[2].accel;
    const speed = Math.hypot(g[0], g[1], g[2]);
    el("imu").textContent = `角速度 ${speed.toFixed(0)} deg/s`;
    el("imu").className = `big ${speed > 25 ? "ok" : ""}`;
    el("imubar").style.width = `${Math.min(100, (speed / 400) * 100)}%`;
    el("imuraw").textContent = `ジャイロ (${g.map((v) => v.toFixed(1)).join(", ")}) deg/s\n加速度 (${a.map((v) => v.toFixed(2)).join(", ")}) g\n電池 ${lastReport.battery}/8${lastReport.charging ? "（充電中）" : ""}`;
    const pressed = pressedNames(lastReport.buttons);
    el("buttons").textContent = pressed.length > 0 ? pressed.join(", ") : "（何も押されていません）";
    el("buttons").className = `big ${pressed.length > 0 ? "ok" : ""}`;
  }
  el("swing").textContent = `状態 ${det.phase} / 角 ${det.angleDeg.toFixed(0)}° / 構え ${det.addresses} 回`;
  el("swing").className = `big ${det.phase === "idle" ? "" : "ok"}`;
  el("swinglog").textContent = swingLines.join("\n") || "（まだ振りを検出していません。0.3 秒静止 → 引く → 戻す）";
}, 100);
