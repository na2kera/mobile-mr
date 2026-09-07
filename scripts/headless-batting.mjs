// 10-2-batting のブラウザ経路: フェイクカメラ + bot 投球 + フェイク Joy-Con の打撃を確認する。
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const chromeCandidates = [
  process.env.CHROME,
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);
const CHROME = chromeCandidates.find(existsSync);
const PORT = 5196;
const CDP_PORT = 9341;
const BASE = `https://localhost:${PORT}/demos/10-2-batting/`;

if (!CHROME) {
  console.log(
    `SKIP: Chrome が見つかりません。CHROME=/path/to/chrome で指定できます`,
  );
  process.exit(0);
}

const results = [];
function check(name, condition, detail = "") {
  results.push([name, Boolean(condition)]);
  console.log(
    `${condition ? "PASS" : "FAIL"}: ${name}${detail ? ` (${detail})` : ""}`,
  );
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const server = spawn(
  "npx",
  ["vite", "--port", String(PORT), "--strictPort"],
  { stdio: ["ignore", "pipe", "pipe"] },
);
let serverExited = false;
let portInUse = false;
const serverLines = [];
server.on("exit", () => {
  serverExited = true;
});
server.stderr.on("data", (data) => {
  const text = data.toString();
  if (/already in use/i.test(text)) portInUse = true;
  process.stderr.write(text);
});
server.stdout.on("data", (data) => {
  for (const line of data.toString().split("\n")) {
    if (!line.startsWith("[batting]")) continue;
    serverLines.push(line);
    console.log(line);
  }
});

async function waitForServer(timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (serverExited || portInUse) return false;
    const response = await fetch(BASE).catch(() => null);
    if (response?.ok) return true;
    await sleep(250);
  }
  return false;
}

class Page {
  constructor(wsUrl, name) {
    this.name = name;
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.logs = [];
    this.exceptions = [];
    this.ws.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        clearTimeout(pending.timer);
        pending.resolve(message);
        this.pending.delete(message.id);
      } else if (message.method === "Runtime.consoleAPICalled") {
        this.logs.push(
          message.params.args
            .map((arg) => arg.value ?? arg.description ?? "")
            .join(" "),
        );
      } else if (message.method === "Runtime.exceptionThrown") {
        this.exceptions.push(
          `${message.params.exceptionDetails.text} ${message.params.exceptionDetails.exception?.description ?? ""}`,
        );
      }
    });
  }
  ready() {
    return new Promise((resolve) => this.ws.on("open", resolve));
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.name}: ${method} timeout`));
      }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const response = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
    });
    return response.result?.result?.value ?? null;
  }
}

async function cdpJson(path, method = "GET") {
  for (let i = 0; i < 50; i++) {
    try {
      const response = await fetch(
        `http://127.0.0.1:${CDP_PORT}${path}`,
        { method },
      );
      return await response.json();
    } catch {
      await sleep(200);
    }
  }
  throw new Error("Chrome DevTools port に接続できません");
}

async function openPage(target, name) {
  const page = new Page(target.webSocketDebuggerUrl, name);
  await page.ready();
  await page.send("Runtime.enable");
  await page.send("Page.enable");
  return page;
}

function parsePhoneHud(text) {
  const stats = text.match(/stats=(\d+)\/(\d+)\/(\d+)\/(\d+)/);
  return {
    me: text.match(/\bme=(p\d+)/)?.[1] ?? "",
    marker: text.match(/marker=(\S+)/)?.[1] ?? "",
    mode: text.match(/game: mode=(\S+)/)?.[1] ?? "",
    phase: text.match(/\bphase=(\S+)/)?.[1] ?? "",
    pitches: Number(stats?.[1] ?? -1),
    swings: Number(stats?.[2] ?? -1),
    hits: Number(stats?.[3] ?? -1),
    misses: Number(stats?.[4] ?? -1),
  };
}

function parseOverviewHud(text) {
  const stats = text.match(/stats=(\d+)\/(\d+)\/(\d+)\/(\d+)/);
  return {
    me: text.match(/\bme=(p\d+)/)?.[1] ?? "",
    mode: text.match(/\bmode=(\S+)/)?.[1] ?? "",
    phase: text.match(/\bphase=(\S+)/)?.[1] ?? "",
    joycons: Number(text.match(/joycons=(\d+)/)?.[1] ?? -1),
    impacts: Number(text.match(/impacts=(\d+)/)?.[1] ?? -1),
    swingsSent: Number(text.match(/swingsSent=(\d+)/)?.[1] ?? -1),
    pitches: Number(stats?.[1] ?? -1),
    swings: Number(stats?.[2] ?? -1),
    hits: Number(stats?.[3] ?? -1),
    misses: Number(stats?.[4] ?? -1),
  };
}

const profile = mkdtempSync(join(tmpdir(), "mobile-mr-batting-chrome-"));
let chrome = null;
let exitCode = 1;
try {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  if (!(await waitForServer())) {
    throw new Error(`dev server failed on ${PORT}`);
  }
  chrome = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`,
      "--ignore-certificate-errors",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
      "--no-first-run",
      "--window-size=1280,720",
      "--enable-unsafe-swiftshader",
      ...(process.env.CHROME_ARGS ?? "").split(" ").filter(Boolean),
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const targets = await cdpJson("/json");
  const first = targets.find((target) => target.type === "page");
  const version = await cdpJson("/json/version");
  const browser = new Page(version.webSocketDebuggerUrl, "browser");
  await browser.ready();
  const overview = await openPage(first, "overview");
  await overview.send("Page.navigate", {
    url: `${BASE}overview.html?room=bat-check&markerMm=150&fakeJoycon=1&fakeDelay=0.3`,
  });

  const created = await browser.send("Target.createTarget", {
    url: "about:blank",
    newWindow: true,
  });
  const playerTarget = (await cdpJson("/json")).find(
    (target) => target.id === created.result.targetId,
  );
  const player = await openPage(playerTarget, "player");
  await player.send("Page.navigate", {
    url: `${BASE}?room=bat-check&name=Solo&fakecam=1&autostart=1&camZoom=1&fov=70&markerMm=150`,
  });

  const readPhone = async () =>
    parsePhoneHud(
      (await player.eval(
        "document.querySelector('#hud')?.textContent ?? ''",
      )) ?? "",
    );
  const readOverview = async () =>
    parseOverviewHud(
      (await overview.eval(
        "document.querySelector('#hud')?.textContent ?? ''",
      )) ?? "",
    );

  const readyDeadline = Date.now() + 30000;
  let phone = await readPhone();
  let ov = await readOverview();
  while (
    Date.now() < readyDeadline &&
    (!phone.me || !phone.marker.startsWith("id=") || !ov.me)
  ) {
    await sleep(300);
    phone = await readPhone();
    ov = await readOverview();
  }
  check(
    "スマホが room に入りフェイクカメラのマーカーを検出",
    phone.me.startsWith("p") && phone.marker.startsWith("id="),
    JSON.stringify(phone),
  );
  check(
    "俯瞰画面はプレイヤーにならずフェイク Joy-Con を1台持つ",
    ov.me.startsWith("p") && ov.joycons === 1,
    JSON.stringify(ov),
  );
  check(
    "1人参加はフリーバッティング",
    phone.mode === "free" && ov.mode === "free",
  );

  const hitDeadline = Date.now() + 30000;
  while (
    Date.now() < hitDeadline &&
    (phone.pitches < 1 || phone.swings < 1)
  ) {
    await sleep(250);
    phone = await readPhone();
    ov = await readOverview();
  }
  check(
    "bot が投球し、俯瞰画面の Joy-Con が打者として振る",
    phone.pitches >= 1 &&
      phone.swings >= 1 &&
      ov.impacts >= 1 &&
      ov.swingsSent >= 1,
    `phone=${JSON.stringify(phone)} overview=${JSON.stringify(ov)}`,
  );
  check(
    "サーバーが打撃を判定し状態を全画面で共有",
    phone.hits + phone.misses >= 1 &&
      phone.pitches === ov.pitches &&
      phone.swings === ov.swings,
    `phone=${JSON.stringify(phone)} overview=${JSON.stringify(ov)}`,
  );
  check(
    "サーバーログに bot 投球と代理 swing が残る",
    serverLines.some((line) => /tick → pitch/.test(line)) &&
      serverLines.some((line) => /swing\(p\d+\).*(hit|miss)/.test(line)),
  );
  check(
    "ブラウザ例外がない",
    player.exceptions.length === 0 && overview.exceptions.length === 0,
    [...player.exceptions, ...overview.exceptions].slice(0, 2).join(" | "),
  );

  const failed = results.filter(([, ok]) => !ok);
  console.log(failed.length ? `\n${failed.length} FAILED` : "\nALL PASS");
  exitCode = failed.length ? 1 : 0;
} catch (error) {
  console.error("確認の実行エラー:", error.message ?? error);
} finally {
  chrome?.kill();
  server.kill();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}
process.exit(exitCode);
