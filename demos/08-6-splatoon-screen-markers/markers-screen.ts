// 08-6 画面マーカー: 俯瞰画面の PC に繋いだモニタ / プロジェクタに、マーカー板（原点 ID 0 + 追加マーカー）を実寸で大きく出す。
// 08 の印刷ページ（markers.html）の代わりで、紙より「大きく・高コントラスト・平面が保証される」観測を作る（候補 1d）。
// 推定の数学（スマホ側 main.ts / marker-anchor.ts）は 08 のまま。差分はマーカーの供給源だけ。
//   - 画面の実寸はブラウザから取れない（CSS の mm は 96dpi 固定）ので、対角のインチか 1mm あたりの px を入力欄で指定して localStorage に保存する
//   - 一辺（markerMm）とモード（遠い: 1 枚 / 近い: 複数枚）を変えると即座に描き直す。収まらない大きさは最大値に丸める
//   - 「room に反映」で画面上の配置（px 差 ÷ pxPerMm → 原点からの m。面は全部 "wall"）を 08 の markers メッセージで room に配る
//     （俯瞰画面の「反映」と同じ経路。役割は overview で入る。サーバーの上限は俯瞰画面 2 台なので、俯瞰画面 + この画面で使い切る）
//   - markerMm は room の接続設定（全員一致が必要）なので、変えるとこの画面は入り直す。room と違えばサーバーが拒否するので、
//     その理由を表示して「全員の URL に ?markerMm= を付けて入り直す」よう案内する
// URL: ?room= ?markerId= ?markerMm= ?mode=single|multi ?count=（追加マーカーの枚数 0〜8）?ids=1,2,3（追加マーカーの ID）
//      ?screenIn=（対角インチ）?screenMm=（対角 mm）?pxPerMm=（直接指定）?gap=（間隔の比）?invert=1 ?bg=white ?panel=0（パネルを隠して開く）
//      ?gravity= ?matchSec= ?waitSec=（room の設定。俯瞰画面と同じ値にする）
import { numParam, params } from "../../src/shared/url-params";
import { markerIdCount, markerSvg } from "../../src/shared/marker-detector";
import { DEFAULT_MARKER_MM, MAX_EXTRA_MARKERS, describeMarkers } from "../../src/shared/marker-layout";
import type { MarkerPlacement } from "../../src/shared/marker-layout";
import { DEFAULT_FIELD } from "../../src/shared/splatoon-sim";
import type { FieldConfig } from "../../src/shared/splatoon-sim";
import type { GameSnapshot } from "../../src/shared/splatoon-game";
import { ROOM_ID_PATTERN } from "../../src/shared/shared-room-protocol";
import { connectGame } from "./game-client";
import type { GameClient } from "./game-client";
import {
  DEFAULT_GAP_RATIO,
  MARKER_SVG_SCALE,
  MIN_SCREEN_MARKER_MM,
  SCREEN_MODES,
  defaultExtraIds,
  describeTiles,
  inchesToMm,
  layoutScreenMarkers,
  pxPerMmFromDiagonal,
  screenSizeMm,
  tilesToPlacements,
  validateScreenPlacements,
} from "./screen-layout";
import type { ScreenLayout, ScreenMode } from "./screen-layout";

// ---- パラメータ（room の設定はスマホ・俯瞰画面と一致が必要。サーバーが検証する）----
const roomRaw = params.get("room");
const ROOM = roomRaw === null ? "demo" : ROOM_ID_PATTERN.test(roomRaw) ? roomRaw : null;
const MARKER_ID = Math.round(numParam("markerId", 0, { min: 0, max: markerIdCount() - 1 }));
const GRAVITY = numParam("gravity", DEFAULT_FIELD.gravity, { min: 0, max: 30 });
const MATCH_SEC = numParam("matchSec", DEFAULT_FIELD.matchSec, { min: 10, max: 600 });
const WAIT_SEC = numParam("waitSec", DEFAULT_FIELD.waitSec, { min: 0, max: 120 });
const modeRaw = params.get("mode");
const INITIAL_MODE: ScreenMode = (SCREEN_MODES as readonly string[]).includes(modeRaw ?? "") ? (modeRaw as ScreenMode) : "multi";
const INITIAL_COUNT = Math.round(numParam("count", 4, { min: 0, max: MAX_EXTRA_MARKERS }));
const IDS_RAW = params.get("ids");
const INITIAL_MARKER_MM = numParam("markerMm", DEFAULT_MARKER_MM, { min: MIN_SCREEN_MARKER_MM, max: 5000 });
const INITIAL_GAP = numParam("gap", DEFAULT_GAP_RATIO, { min: 0, max: 2 });
const STORAGE_KEY = "mobile-mr:08-6:screen";

// ---- DOM ----
const board = document.querySelector<HTMLDivElement>("#board")!;
const panel = document.querySelector<HTMLDivElement>("#panel")!;
const showPanelButton = document.querySelector<HTMLButtonElement>("#show-panel")!;
const phaseEl = document.querySelector<HTMLDivElement>("#phase")!;
const screenInInput = document.querySelector<HTMLInputElement>("#screen-in")!;
const pxPerMmInput = document.querySelector<HTMLInputElement>("#px-per-mm")!;
const screenHint = document.querySelector<HTMLDivElement>("#screen-hint")!;
const markerMmInput = document.querySelector<HTMLInputElement>("#marker-mm")!;
const modeSelect = document.querySelector<HTMLSelectElement>("#mode")!;
const countInput = document.querySelector<HTMLInputElement>("#count")!;
const gapInput = document.querySelector<HTMLInputElement>("#gap")!;
const invertInput = document.querySelector<HTMLInputElement>("#invert")!;
const bgWhiteInput = document.querySelector<HTMLInputElement>("#bg-white")!;
const markerHint = document.querySelector<HTMLDivElement>("#marker-hint")!;
const fullscreenButton = document.querySelector<HTMLButtonElement>("#fullscreen")!;
const hidePanelButton = document.querySelector<HTMLButtonElement>("#hide-panel")!;
const applyButton = document.querySelector<HTMLButtonElement>("#apply")!;
const applyHint = document.querySelector<HTMLDivElement>("#apply-hint")!;
const hud = document.querySelector<HTMLDivElement>("#hud")!;

// ---- 画面の実寸（localStorage に保存。URL があれば優先）----
type Stored = { screenIn?: number; pxPerMm?: number };
function loadStored(): Stored {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Stored) : {};
  } catch {
    return {};
  }
}
function saveStored(s: Stored) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // プライベートモード等。保存できなくても表示はできる
  }
}
const stored = loadStored();
if (params.has("pxPerMm")) pxPerMmInput.value = String(numParam("pxPerMm", 0, { min: 0.1, max: 100 }) || "");
else if (params.has("screenMm")) screenInInput.value = (numParam("screenMm", 0, { min: 50, max: 10000 }) / inchesToMm(1)).toFixed(1);
else if (params.has("screenIn")) screenInInput.value = String(numParam("screenIn", 0, { min: 3, max: 400 }) || "");
else if (stored.pxPerMm) pxPerMmInput.value = String(stored.pxPerMm);
else if (stored.screenIn) screenInInput.value = String(stored.screenIn);
markerMmInput.value = String(INITIAL_MARKER_MM);
modeSelect.value = INITIAL_MODE;
countInput.value = String(INITIAL_COUNT);
gapInput.value = String(INITIAL_GAP);
invertInput.checked = params.get("invert") === "1";
bgWhiteInput.checked = params.get("bg") === "white";
if (params.get("panel") === "0") setPanelVisible(false);

/** 1mm あたりの px（CSS px）。直接指定 > 対角インチ（画面全体の px で換算。全画面でなくても実寸は同じ） */
function currentPxPerMm(): number {
  const direct = pxPerMmInput.valueAsNumber;
  if (Number.isFinite(direct) && direct > 0) return direct;
  const inches = screenInInput.valueAsNumber;
  if (Number.isFinite(inches) && inches > 0) return pxPerMmFromDiagonal(inchesToMm(inches), screen.width, screen.height);
  return NaN;
}

// ---- 配置と描画 ----
let layout: ScreenLayout | null = null;
let layoutError = "";
let placements: MarkerPlacement[] = [];
/** いまの一辺 [mm]（room の接続設定に使う。入力欄の値そのもの。丸めた値ではない: 丸めたら room も変えるべきなので警告で示す） */
let markerMm = INITIAL_MARKER_MM;

function relayout() {
  const pxPerMm = currentPxPerMm();
  const mode = modeSelect.value as ScreenMode;
  const count = Math.round(countInput.valueAsNumber);
  const gap = gapInput.valueAsNumber;
  board.classList.toggle("invert", invertInput.checked);
  board.classList.toggle("bg-white", bgWhiteInput.checked);
  layout = null;
  layoutError = "";
  placements = [];
  board.replaceChildren();
  if (!(pxPerMm > 0)) {
    layoutError = "画面の対角（インチ）か 1mm あたりの px を入れてください";
  } else {
    try {
      layout = layoutScreenMarkers({
        widthPx: innerWidth,
        heightPx: innerHeight,
        pxPerMm,
        markerMm: markerMmInput.valueAsNumber,
        mode,
        originId: MARKER_ID,
        extraIds: defaultExtraIds(MARKER_ID, Number.isFinite(count) ? count : 0, IDS_RAW).slice(0, Number.isFinite(count) ? count : 0),
        gapRatio: Number.isFinite(gap) ? gap : DEFAULT_GAP_RATIO,
      });
      placements = tilesToPlacements(layout.tiles, pxPerMm);
      for (const t of layout.tiles) {
        const el = document.createElement("div");
        el.className = "tile";
        const side = t.sidePx * MARKER_SVG_SCALE;
        el.style.width = `${side}px`;
        el.style.height = `${side}px`;
        el.style.left = `${t.cx}px`;
        el.style.top = `${t.cy}px`;
        el.dataset.id = String(t.id);
        el.innerHTML = markerSvg(t.id);
        const cap = document.createElement("div");
        cap.className = "cap";
        cap.textContent = t.origin ? `ID ${t.id}（原点）` : `ID ${t.id}`;
        el.append(cap);
        board.append(el);
      }
    } catch (e) {
      layoutError = e instanceof Error ? e.message : String(e);
    }
  }
  renderPanel();
}

// ---- room への接続（俯瞰画面と同じ役割 "overview"。markerMm が変わったら入り直す）----
let client: GameClient | null = null;
let netStatus = "connecting";
let joined = false;
let selfId = "";
let fieldCfg: FieldConfig | null = null;
let state: GameSnapshot | null = null;
let applyPending = false;
let appliesSent = 0;
let lastRejectReason = "";

function connect() {
  if (ROOM === null) return;
  client?.dispose();
  joined = false;
  client = connectGame(
    ROOM,
    "",
    { markerId: MARKER_ID, markerMm, gravity: GRAVITY, matchSec: MATCH_SEC, waitSec: WAIT_SEC },
    {
      onStatus: (status) => {
        netStatus = status;
        if (status !== "open") {
          joined = false;
          applyPending = false;
        }
        renderPanel();
      },
      onError: (reason) => {
        netStatus = `error: ${reason}`;
        console.warn(`[screen] rejected: ${reason}`);
        renderPanel();
      },
      onWelcome: (id, role, _peers, cfg, s) => {
        selfId = id;
        netStatus = "open";
        joined = true;
        fieldCfg = cfg;
        state = s;
        lastRejectReason = "";
        console.log(`[screen] joined "${ROOM}" as ${id} (${role}) markers=${describeMarkers(cfg.markers)}`);
        renderPanel();
      },
      onPeerJoin: () => renderPanel(),
      onPeerLeave: () => renderPanel(),
      onPeerPose: () => {},
      onShot: () => {},
      onRejected: (reason) => {
        lastRejectReason = reason;
        applyPending = false;
        console.log(`[screen] rejected by server: ${reason}`);
        renderPanel();
      },
      onState: (s) => {
        state = s;
        renderPanel();
      },
      onField: (cfg, s) => {
        fieldCfg = cfg;
        state = s;
        renderPanel();
      },
      onMarkers: (cfg) => {
        fieldCfg = cfg;
        applyPending = false;
        lastRejectReason = "";
        console.log(`[screen] markers ${describeMarkers(cfg.markers)}`);
        renderPanel();
      },
    },
    "overview",
  );
}

/** 配置を変えられるか（俯瞰画面と同じ条件: 練習中か結果表示中で、送信中でない） */
function editable(): boolean {
  return joined && state !== null && (state.phase === "practice" || state.phase === "result") && !applyPending;
}
/** 画面の配置と room の配置が同じか（順序は問わない） */
function sameAsRoom(): boolean {
  const key = (ms: readonly MarkerPlacement[]) => JSON.stringify([...ms].sort((a, b) => a.id - b.id));
  return key(placements) === key(fieldCfg?.markers ?? []);
}

applyButton.addEventListener("click", () => {
  if (!client || applyPending || !layout) return;
  const invalid = validateScreenPlacements(placements, MARKER_ID);
  if (invalid) {
    lastRejectReason = invalid;
    renderPanel();
    return;
  }
  if (client.sendMarkers(placements)) {
    appliesSent++;
    applyPending = true;
    lastRejectReason = "";
    console.log(`[screen] markers sent ${describeMarkers(placements)}`);
  }
  renderPanel();
});

// ---- パネル ----
let lastPanelKey = "";
function renderPanel() {
  const pxPerMm = currentPxPerMm();
  const size = pxPerMm > 0 ? screenSizeMm(pxPerMm, screen.width, screen.height) : null;
  const screenHintText = size
    ? `1mm = ${pxPerMm.toFixed(3)} px（画面 ${screen.width}×${screen.height} px = ${size.widthMm.toFixed(0)}×${size.heightMm.toFixed(0)} mm。Chrome のズームは 100% に）`
    : "";
  const clampNote = layout?.clamped ? `\n${markerMmInput.valueAsNumber}mm は収まらないので ${layout.markerMm}mm で描いています（room の ?markerMm= もこの値に）` : "";
  const markerHintText = layoutError
    ? layoutError
    : layout
      ? `いまの画面に収まる最大: ${layout.maxMm}mm（${modeSelect.value === "single" ? "1 枚" : `${layout.tiles.length} 枚`}）。実用距離の目安は一辺の 10〜20 倍 = ${((layout.markerMm * 10) / 1000).toFixed(1)}〜${((layout.markerMm * 20) / 1000).toFixed(1)}m${clampNote}\n配置: ${placements.length === 0 ? "原点だけ" : placements.map((p) => `${p.id} (${p.pos[0]}, ${p.pos[1]})`).join(" / ")}`
      : "";
  let phaseText = "接続中…";
  if (ROOM === null) phaseText = "room 名が不正です（?room= は英数字・_・- で 32 文字まで）";
  else if (netStatus.startsWith("error")) phaseText = `接続できません: ${netStatus.slice(7)}`;
  else if (!joined || !state) phaseText = `サーバーに接続中… (${netStatus})`;
  else if (state.phase === "practice") phaseText = `練習中（room ${ROOM}・プレイヤー ${state.players.length} 人）`;
  else if (state.phase === "waiting") phaseText = "開始待ち（配置は変えられません）";
  else if (state.phase === "play") phaseText = "対戦中（配置は変えられません）";
  else phaseText = "結果表示中";
  const invalid = layout ? validateScreenPlacements(placements, MARKER_ID) : layoutError || "配置がありません";
  const roomMm = joined ? markerMm : null;
  const mmMismatch = layout !== null && layout.clamped;
  const canApply = editable() && layout !== null && invalid === null && !sameAsRoom();
  const applyHintText = !joined
    ? netStatus.startsWith("error") && /markerMm/.test(netStatus)
      ? "room のマーカーの一辺がこの画面と違います。全員のデモ URL と俯瞰画面に ?markerMm=（この画面の値）を付けて入り直すか、この画面の一辺を room に合わせてください"
      : ""
    : invalid
      ? invalid
      : lastRejectReason
        ? `サーバーが拒否: ${lastRejectReason}`
        : sameAsRoom()
          ? `room の配置はこの画面と同じです（${describeMarkers(fieldCfg?.markers ?? [])}。一辺 ${roomMm}mm）`
          : applyPending
            ? "送信中…"
            : `「room に反映」で全員の位置合わせに使うマーカーがこの画面の配置になります（塗りは消えません。一辺 ${markerMm}mm）${mmMismatch ? "\n※ 一辺を丸めたので room の ?markerMm= と食い違います" : ""}`;
  const key = JSON.stringify([screenHintText, markerHintText, phaseText, applyHintText, canApply, applyPending, invertInput.checked, bgWhiteInput.checked]);
  if (key !== lastPanelKey) {
    lastPanelKey = key;
    screenHint.textContent = screenHintText;
    markerHint.textContent = markerHintText;
    markerHint.classList.toggle("warn", !!layoutError || !!layout?.clamped);
    phaseEl.textContent = phaseText;
    applyHint.textContent = applyHintText;
    applyHint.classList.toggle("warn", invalid !== null || lastRejectReason !== "" || netStatus.startsWith("error"));
    applyButton.disabled = !canApply;
    applyButton.textContent = applyPending ? "送信中…" : "room に反映";
  }
  hud.textContent = `screen: room=${ROOM} me=${selfId || "-"} ws=${netStatus} joined=${joined} phase=${state?.phase ?? "-"} pxPerMm=${pxPerMm > 0 ? pxPerMm.toFixed(3) : "-"} board=${innerWidth}x${innerHeight} mode=${modeSelect.value} markerMm=${layout?.markerMm ?? "-"}/${markerMm} max=${layout?.maxMm ?? "-"} clamped=${layout?.clamped ? 1 : 0} tiles=${layout ? describeTiles(layout.tiles) : "-"} layout=${describeMarkers(placements)} room=${describeMarkers(fieldCfg?.markers ?? [])} applies=${appliesSent} pending=${applyPending ? 1 : 0} invert=${invertInput.checked ? 1 : 0} fullscreen=${document.fullscreenElement ? 1 : 0} panel=${panel.hidden === true ? 0 : 1}`;
}

function setPanelVisible(visible: boolean) {
  panel.hidden = !visible;
  showPanelButton.hidden = visible;
}
hidePanelButton.addEventListener("click", () => setPanelVisible(false));
showPanelButton.addEventListener("click", () => setPanelVisible(true));
addEventListener("keydown", (e) => {
  if (e.key === "h" && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLSelectElement)) setPanelVisible(panel.hidden === true);
});
fullscreenButton.addEventListener("click", () => {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen?.();
});
document.addEventListener("fullscreenchange", () => {
  // 全画面に入ったらパネルは邪魔なので隠す（h キーか左上のボタンで戻せる）
  if (document.fullscreenElement) setPanelVisible(false);
  relayout();
});
addEventListener("resize", relayout);

// 画面の実寸: どちらかを入れたら保存して描き直す（両方入っていれば px 直接指定が優先）
screenInInput.addEventListener("input", () => {
  saveStored({ screenIn: screenInInput.valueAsNumber || undefined, pxPerMm: pxPerMmInput.valueAsNumber || undefined });
  relayout();
});
pxPerMmInput.addEventListener("input", () => {
  saveStored({ screenIn: screenInInput.valueAsNumber || undefined, pxPerMm: pxPerMmInput.valueAsNumber || undefined });
  relayout();
});
for (const el of [modeSelect, countInput, gapInput, invertInput, bgWhiteInput]) el.addEventListener("input", relayout);
// 一辺は room の接続設定なので、変えたら（入力が落ち着いてから）入り直す
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
markerMmInput.addEventListener("input", () => {
  relayout();
  // 入力途中の値で入り直さない（前の値のタイマーは必ず消す。元の値に戻したときに古いタイマーで入り直さないため）
  clearTimeout(reconnectTimer);
  const v = markerMmInput.valueAsNumber;
  if (!(v >= MIN_SCREEN_MARKER_MM) || v === markerMm) return;
  reconnectTimer = setTimeout(() => {
    markerMm = v;
    connect();
    renderPanel();
  }, 600);
});

// ヘッドレス確認用
(window as unknown as { __screenMarkers: unknown }).__screenMarkers = {
  placements: () => placements,
  tiles: () => layout?.tiles ?? [],
  layout: () => layout,
};

relayout();
connect();
setInterval(renderPanel, 500);
