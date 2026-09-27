import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { numParam, params } from "../../src/shared/url-params";
import { TextPanel } from "../../src/shared/text-panel";
import { startRemoteLog } from "../../src/shared/remote-log";
import { ROOM_ID_PATTERN } from "../../src/shared/shared-room-protocol";
import { DEFAULT_MARKER_MM } from "../../src/shared/marker-layout";
import { playerColorHex } from "../../src/shared/person-protocol";
import { KESHIN_NAMES } from "../../src/shared/keshin-protocol";
import type { KeshinIndex, KeshinPlayer, KeshinPose, Track } from "../../src/shared/keshin-protocol";
import { keshinTimeline } from "../../src/shared/keshin-timeline";
import type { KeshinVisual } from "../../src/shared/keshin-timeline";
import { effectiveTrack, isPositionFrozen, poseReceivedLocal, stageStartLocal, trackFade, yawOfForward } from "./keshin-math";
import type { V3 } from "./keshin-math";
import { KESHIN_SPECS, loadKeshinModel } from "./keshin-assets";
import type { LoadedKeshin } from "./keshin-assets";
import { KeshinView } from "./keshin-view";
import { connectKeshin } from "./keshin-client";
import type { KeshinClient } from "./keshin-client";

// ex9-1: 化身の PC 俯瞰画面（08 の overview を参考にした最小限の版）。カメラもゴーグルも使わず、同じ room に「俯瞰」役で入って
// マーカー（壁の四角）・床の目安（各プレイヤーの頭 − eyeH）・各プレイヤーの頭（視線の線 + 名前 + 位置の信用度）と、
// その人の化身をスマホと同じ部品（keshin-view.ts）の「他人用」で描く。座標系はマーカー座標系をそのままワールドに置く。
// 受信側の見せ方（教訓 2）: track = marker は通常、gyro は ageMs が伸びるにつれ薄く（?staleMs= で半分、以降はその薄さで
// 最後の位置に止める）、none は化身を出さず「位置未確定」の表示だけ

// ---- パラメータ（room の設定はスマホと一致が必要。サーバーが検証する）----
const roomRaw = params.get("room");
const ROOM = roomRaw === null ? "demo" : ROOM_ID_PATTERN.test(roomRaw) ? roomRaw : null;
const MARKER_MM = numParam("markerMm", DEFAULT_MARKER_MM, { max: 5000 });
const MARKER_ID = Math.round(numParam("markerId", 0, { min: 0, max: 999 }));
const KESHIN_H = numParam("keshinH", 3, { min: 0.5, max: 20 });
const EYE_H = numParam("eyeH", 1.5, { min: 0.3, max: 3 });
const KESHIN_BACK: number | null = params.has("keshinBack") ? numParam("keshinBack", 0.5, { min: -5, max: 10 }) : null;
/** 他人用の既定不透明度（体。発光部分は 1 のまま） */
const OTHER_OPACITY = numParam("otherOpacity", 0.85, { min: 0, max: 1 });
const AURA_N = Math.round(numParam("auraN", 400, { min: 0, max: 20000 }));
/** gyro の ageMs がこれで化身が半分の薄さ、以降はその薄さで最後の位置に止める [ms] */
const STALE_MS = numParam("staleMs", 3000, { min: 100, max: 60000 });
/** pose がこれだけ届かなければ「通信なし」（marker でも gyro 扱いで薄くする）[ms] */
const NO_POSE_MS = numParam("noPoseMs", 1000, { min: 100, max: 60000 });

// ---- 実機ログ ----
startRemoteLog({ tag: "keshin-overview", snapshot: () => diagSummary(), snapshotMs: 1000 });
function logEvent(kind: string, detail = "") {
  console.log(`[keshin-overview] event=${kind}${detail ? ` ${detail}` : ""}`);
}

// ---- シーン ----
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a2233);
scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.6));
const dirLight = new THREE.DirectionalLight(0xffffff, 1.8);
dirLight.position.set(3, 10, 4);
scene.add(dirLight);

const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.05, 200);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.localClippingEnabled = true;
document.querySelector<HTMLDivElement>("#app")!.appendChild(renderer.domElement);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.12;
// 視点: 部屋の斜め後ろ上から、壁（マーカー）とその前に立つ人を見る
camera.position.set(3.8, 2.4, 5.2);
controls.target.set(0, -0.2, 1.6);
controls.update();

function resize() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
}
resize();
addEventListener("resize", resize);

// マーカー（壁の四角。原点）と軸
const markerSize = MARKER_MM / 1000;
scene.add(new THREE.Mesh(new THREE.PlaneGeometry(markerSize, markerSize), new THREE.MeshBasicMaterial({ color: 0x8ab4f8, transparent: true, opacity: 0.7, side: THREE.DoubleSide })));
scene.add(new THREE.AxesHelper(0.3));
// 壁の目安（マーカーの面。3m × 2.5m の枠）
const wallFrame = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.PlaneGeometry(3, 2.5)),
  new THREE.LineBasicMaterial({ color: 0x5f6368 }),
);
scene.add(wallFrame);
// 床の目安: 各プレイヤーの頭 − eyeH の平均（誰もいなければマーカーの 1.3m 下）
const floorGrid = new THREE.GridHelper(6, 12, 0x5f6368, 0x3c4043);
floorGrid.position.set(0, -1.3, 2.5);
scene.add(floorGrid);
const markerLabel = new TextPanel(0.5, 0.12, 256, 6);
markerLabel.set(`マーカー ${MARKER_ID}`, "#8ab4f8");
markerLabel.mesh.position.set(0, markerSize * 0.9, 0.01);
scene.add(markerLabel.mesh);

// ---- 化身のモデル（必要になった番号だけ読み込む。無ければ代わりの人型のまま）----
type ModelEntry = { status: "loading" | "loaded" | "missing"; loaded: LoadedKeshin | null; detail: string };
const models = new Map<KeshinIndex, ModelEntry>();
function requestModel(index: KeshinIndex) {
  if (models.has(index)) return;
  const spec = KESHIN_SPECS[index];
  const entry: ModelEntry = { status: "loading", loaded: null, detail: spec.file };
  models.set(index, entry);
  const t0 = performance.now();
  loadKeshinModel(spec)
    .then((loaded) => {
      entry.status = "loaded";
      entry.loaded = loaded;
      entry.detail = `${loaded.loadMs.toFixed(0)}ms tris=${loaded.triangles}`;
      for (const v of views.values()) {
        if (v.player.info.keshin !== index) continue;
        v.view.setModel(loaded);
      }
      logEvent("model-loaded", `#${index} ${spec.file} ${(performance.now() - t0).toFixed(0)}ms tris=${loaded.triangles} frontZ=${loaded.frontZ.toFixed(3)} headY=${loaded.head.y.toFixed(3)}`);
    })
    .catch((e: unknown) => {
      entry.status = "missing";
      entry.detail = e instanceof Error ? e.message.slice(0, 80) : String(e);
      logEvent("model-failed", `#${index} ${spec.file} ${entry.detail}`);
    });
}

/**
 * 化身のシェーダーを先にコンパイルする（初めて出たときに固まらないように）。ビューを作った直後・モデルを差し替えた直後に、
 * 本描画の直前でキャンバスへ実際の設定のまま 1 回描く（直後の本描画が autoClear で消す）。時間とリンクしたプログラムの数をログに出す
 */
let warmupInfo = "-";
function warmUpPending() {
  for (const v of views.values()) {
    if (!v.view.warmPending) continue;
    const what = `#${v.player.info.keshin} ${v.view.warmPending}`;
    v.view.warmPending = null;
    const before = renderer.info.programs?.length ?? 0;
    const t0 = performance.now();
    try {
      v.view.forceVisible(() => renderer.render(scene, camera));
    } catch (e: unknown) {
      logEvent("warmup-failed", `${what} ${e instanceof Error ? e.message : String(e)}`);
    }
    warmupInfo = `${what} ${(performance.now() - t0).toFixed(0)}ms programs=${before}→${renderer.info.programs?.length ?? 0}`;
    logEvent("warmup", warmupInfo);
  }
}

// ---- プレイヤー（頭 + 視線の線 + 名前 + 床の目安の輪 + 化身）----
type PlayerState = { info: KeshinPlayer; startLocalMs: number; poseRecvMs: number };
type PlayerView = {
  player: PlayerState;
  head: THREE.Mesh;
  headMaterial: THREE.MeshStandardMaterial;
  gaze: THREE.Line;
  ring: THREE.Mesh;
  label: TextPanel;
  view: KeshinView;
  /** 表示中の頭の位置（gyro で止めるときはこれを使い続ける） */
  shownHead: V3 | null;
  /** 直近の描画の状態（診断・ヘッドレス確認用） */
  last: { track: Track | "nopose"; fade: number | null; visual: KeshinVisual | null; yaw: number | null };
};
const players = new Map<string, PlayerState>();
const views = new Map<string, PlayerView>();
const headGeometry = new THREE.SphereGeometry(0.1, 24, 16);
const ringGeometry = new THREE.RingGeometry(0.22, 0.26, 32).rotateX(-Math.PI / 2);

function createView(p: PlayerState): PlayerView {
  removeView(p.info.id);
  const color = playerColorHex(p.info.color);
  const headMaterial = new THREE.MeshStandardMaterial({ color, transparent: true });
  const head = new THREE.Mesh(headGeometry, headMaterial);
  const gaze = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -0.7)]), new THREE.LineBasicMaterial({ color }));
  head.add(gaze);
  const ring = new THREE.Mesh(ringGeometry, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.6, side: THREE.DoubleSide }));
  const label = new TextPanel(0.9, 0.2, 512, 10);
  scene.add(head, ring, label.mesh);
  const spec = KESHIN_SPECS[p.info.keshin];
  const view = new KeshinView(spec, {
    mode: "other",
    heightM: KESHIN_H,
    eyeH: EYE_H,
    backOverride: KESHIN_BACK,
    leanDeg: 0,
    selfBackOverride: null,
    faceAheadM: 0,
    opacity: OTHER_OPACITY,
    auraN: AURA_N,
    nearFade: null,
  });
  scene.add(view.group);
  requestModel(p.info.keshin);
  const loaded = models.get(p.info.keshin)?.loaded;
  if (loaded) view.setModel(loaded);
  const v: PlayerView = { player: p, head, headMaterial, gaze, ring, label, view, shownHead: null, last: { track: "nopose", fade: null, visual: null, yaw: null } };
  views.set(p.info.id, v);
  return v;
}

function removeView(id: string) {
  const v = views.get(id);
  if (!v) return;
  v.head.removeFromParent();
  v.ring.removeFromParent();
  v.label.mesh.removeFromParent();
  v.label.mesh.material.map?.dispose();
  v.label.mesh.material.dispose();
  v.headMaterial.dispose();
  v.view.dispose();
  views.delete(id);
}

const TRACK_LABEL: Record<Track | "nopose", string> = { marker: "marker", gyro: "gyro", none: "位置未確定", nopose: "位置未確定" };

/** 受信した pose と経過時間から、いまの「信用できるか」（keshin-math.ts の effectiveTrack。段階 2 のスマホと共通） */
function trackNow(p: PlayerState, now: number): { track: Track | "nopose"; ageMs: number | null } {
  return effectiveTrack(p.info.pose, now - p.poseRecvMs, NO_POSE_MS);
}

function updateViews(now: number) {
  let floorSum = 0;
  let floorN = 0;
  for (const v of views.values()) {
    const p = v.player;
    const pose: KeshinPose | undefined = p.info.pose;
    const { track, ageMs } = trackNow(p, now);
    const visual = keshinTimeline((now - p.startLocalMs) / 1000, p.info.on ? "appear" : "vanish");
    const fade = track === "nopose" ? null : trackFade(track, ageMs, STALE_MS);
    const noPose = now - p.poseRecvMs > NO_POSE_MS * 2 && pose !== undefined;
    // 1 行目: 名前の横に位置の信用度、2 行目: 化身
    let labelText = `${p.info.name} [${TRACK_LABEL[track]}${track === "gyro" && ageMs !== null ? ` ${(ageMs / 1000).toFixed(1)}s` : ""}${noPose ? " 通信なし" : ""}]\n${KESHIN_SPECS[p.info.keshin].short}${p.info.on ? "（出ている）" : ""}`;
    if (fade === null || !pose?.pos || !pose.quat || !pose.fwd) {
      // 位置未確定: 化身は出さない（名前と状態だけ、壁の前の目安の位置に）
      v.view.hide();
      v.head.visible = false;
      v.ring.visible = false;
      v.label.mesh.position.set(-1.2 + 0.6 * (p.info.color - 1), 0.9, 0.2);
      v.label.set(labelText, "#f28b82");
      v.last = { track, fade: null, visual, yaw: null };
      continue;
    }
    // gyro で staleMs を過ぎたら位置は最後の値に止める（向きはジャイロで正しいので受け取った向きのまま）
    if (!v.shownHead || !isPositionFrozen(track === "gyro" ? "gyro" : "marker", ageMs, STALE_MS)) v.shownHead = [pose.pos[0], pose.pos[1], pose.pos[2]];
    const head = v.shownHead;
    const yaw = yawOfForward(pose.fwd);
    v.head.visible = true;
    v.head.position.set(...head);
    v.head.quaternion.set(...pose.quat);
    v.headMaterial.opacity = 0.35 + 0.65 * fade;
    v.ring.visible = true;
    v.ring.position.set(head[0], head[1] - EYE_H + 0.005, head[2]);
    floorSum += head[1] - EYE_H;
    floorN++;
    v.view.update({ head, yaw, visual, fade, aura: true, timeSec: now / 1000, viewportH: renderer.domElement.height });
    v.label.mesh.position.set(head[0], head[1] + 0.35, head[2]);
    const color = track === "marker" ? "#e8eaed" : "#fdd663";
    if (track === "gyro") labelText += " 薄く表示";
    v.label.set(labelText, color);
    v.last = { track, fade, visual, yaw };
  }
  if (floorN > 0) floorGrid.position.y = floorSum / floorN;
  // 名札はカメラの方を向ける
  for (const v of views.values()) v.label.mesh.quaternion.copy(camera.quaternion);
  markerLabel.mesh.quaternion.copy(camera.quaternion);
}

// ---- 通信 ----
let selfId = "";
let netStatus = "idle";
let client: KeshinClient | null = null;
addEventListener("pagehide", () => client?.dispose());

/** Player を足す / 置き換える。スナップショット（welcome / join）の pose は poseAgeMs だけ前に届いたものとして扱う */
function upsertPlayer(info: KeshinPlayer, startLocalMs: number, recvMs: number) {
  const p: PlayerState = { info, startLocalMs, poseRecvMs: info.pose ? poseReceivedLocal(recvMs, info.poseAgeMs) : -Infinity };
  players.set(info.id, p);
  const v = views.get(info.id);
  if (!v || v.view.spec.index !== info.keshin) createView(p);
  else v.player = p;
}

function connect() {
  if (ROOM === null) {
    netStatus = "error: room 名が不正";
    return;
  }
  client = connectKeshin(
    ROOM,
    "overview",
    { markerId: MARKER_ID, markerMm: MARKER_MM },
    {
      onStatus: (status) => {
        netStatus = status;
      },
      onError: (reason) => {
        netStatus = `error: ${reason}`;
        logEvent("error", reason);
      },
      onWelcome: (id, _role, list, now) => {
        const recv = performance.now();
        selfId = id;
        netStatus = "open";
        for (const pid of [...views.keys()]) removeView(pid);
        players.clear();
        for (const info of list) upsertPlayer(info, stageStartLocal(info.changedAt, now, recv), recv);
        logEvent("welcome", `room=${ROOM} me=${id} players=${list.map((p) => `${p.id}:${p.keshin}${p.on ? "on" : ""}`).join(",") || "-"}`);
      },
      onJoin: (info, now) => {
        // 再接続の引き継ぎ（同じ session 鍵）なら on / changedAt を持っている → 演出なしで同じ見え方から続ける
        const recv = performance.now();
        upsertPlayer(info, stageStartLocal(info.changedAt, now, recv), recv);
        logEvent("join", `${info.id} "${info.name}" keshin=${info.keshin}`);
      },
      onLeave: (id) => {
        if (!players.delete(id)) return;
        removeView(id);
        logEvent("leave", id);
      },
      onPose: (id, pose) => {
        const p = players.get(id);
        if (!p) return;
        p.info.pose = pose;
        p.poseRecvMs = performance.now();
      },
      onKeshin: (id, on, keshin, changedAt, now) => {
        const recv = performance.now();
        const p = players.get(id);
        if (!p) return;
        p.info.on = on;
        p.info.keshin = keshin;
        p.info.changedAt = changedAt;
        p.startLocalMs = stageStartLocal(changedAt, now, recv);
        logEvent(on ? "keshin-on" : "keshin-off", `${id} keshin=${keshin}`);
      },
    },
    "overview",
  );
}
connect();

// ---- パネル・HUD ----
const playersEl = document.querySelector<HTMLUListElement>("#players")!;
const statusEl = document.querySelector<HTMLParagraphElement>("#status")!;
const hud = document.querySelector<HTMLDivElement>("#hud")!;
let lastPanelKey = "";
function renderPanel(now: number) {
  const rows = [...views.values()].map((v) => {
    const p = v.player;
    const { track, ageMs } = trackNow(p, now);
    const t = (now - p.startLocalMs) / 1000;
    return {
      id: p.info.id,
      html: `<li style="border-left-color:#${playerColorHex(p.info.color).toString(16).padStart(6, "0")}"><strong>${escapeHtml(p.info.name)}</strong> ${KESHIN_NAMES[p.info.keshin]}（${p.info.on ? "出ている" : "消えている"}${Number.isFinite(t) && t < 2 ? ` ${t.toFixed(1)}s` : ""}）<br><span class="track ${track === "nopose" ? "none" : track}">${TRACK_LABEL[track]}${track === "gyro" && ageMs !== null ? ` ${(ageMs / 1000).toFixed(1)}s` : ""}</span></li>`,
    };
  });
  const modelText = [...models.entries()].map(([i, m]) => `#${i} ${KESHIN_SPECS[i].short}: ${m.status === "missing" ? "モデル未配置（npm run fetch:keshin）→ 代わりの人型" : `${m.status} ${m.detail}`}`).join("\n");
  const status = `room=${ROOM ?? "(不正)"} ws=${netStatus}${selfId ? ` me=${selfId}` : ""}\n${modelText || "モデル: まだ読み込んでいません（プレイヤーが入ると読み込みます）"}`;
  const key = rows.map((r) => r.html).join("") + status;
  if (key === lastPanelKey) return;
  lastPanelKey = key;
  playersEl.innerHTML = rows.map((r) => r.html).join("") || "<li>プレイヤーはまだいません</li>";
  statusEl.textContent = status;
}
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

let fps = 0;
let fpsFrames = 0;
let fpsWindowStart = performance.now();
let renderMsEma = 0;
function diagSummary(): string {
  const now = performance.now();
  const list = [...views.values()].map((v) => {
    const { track, ageMs } = trackNow(v.player, now);
    const vis = v.last.visual;
    return `${v.player.info.id}:${v.player.info.keshin}${v.player.info.on ? "on" : "off"}/${track}${ageMs ? `@${(ageMs / 1000).toFixed(1)}s` : ""}/u=${vis ? vis.u.toFixed(2) : "-"}/drawn=${v.view.modelVisible ? 1 : 0}`;
  });
  return `fps=${fps.toFixed(0)} render=${renderMsEma.toFixed(1)}ms tris=${renderer.info.render.triangles} calls=${renderer.info.render.calls} ws=${netStatus} players=[${list.join(" ")}] models=${[...models.entries()].map(([i, m]) => `${i}:${m.status}`).join(",") || "-"}`;
}

// ---- ヘッドレス確認用の口 ----
(window as unknown as { __keshinOverview: unknown }).__keshinOverview = {
  state() {
    const now = performance.now();
    return [...views.values()].map((v) => {
      const f = v.view.lastFrame;
      return {
        id: v.player.info.id,
        name: v.player.info.name,
        keshin: v.player.info.keshin,
        on: v.player.info.on,
        track: trackNow(v.player, now).track,
        fade: v.last.fade,
        u: v.last.visual?.u ?? null,
        yaw: v.last.yaw,
        drawn: v.view.modelVisible,
        opacity: v.view.lastOpacity,
        fallback: v.view.isFallback,
        head: v.shownHead,
        back: f?.back ?? null,
        fwd: v.player.info.pose?.fwd ?? null,
        /** 実際に描いているモデルの原点（ワールド）と正面 +Z の水平の向き */
        world: v.view.modelVisible ? v.view.debugWorld() : null,
      };
    });
  },
  /** リンク済みのシェーダープログラムの数と直近の先行コンパイル（ヘッドレス確認用） */
  programs() {
    return { programs: renderer.info.programs?.length ?? 0, warmup: warmupInfo, pending: [...views.values()].filter((v) => v.view.warmPending).length };
  },
  models() {
    return [...models.entries()].map(([i, m]) => ({ index: i, status: m.status, detail: m.detail, frontZ: m.loaded?.frontZ ?? null, headY: m.loaded?.head.y ?? null, measureMs: m.loaded?.measureMs ?? null, loadMs: m.loaded?.loadMs ?? null }));
  },
  /** 視点を決める（スクリーンショット用） */
  setView(pos: V3, target: V3) {
    camera.position.set(...pos);
    controls.target.set(...target);
    controls.update();
  },
  /** その人の化身を描いたときと描かないときの画素の差（ピクセルでの確認用） */
  pixelDiff(id: string) {
    const v = views.get(id);
    if (!v) return null;
    const gl = renderer.getContext();
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    const read = () => {
      const buf = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      return buf;
    };
    renderer.render(scene, camera);
    const a = read();
    const was = v.view.group.visible;
    v.view.group.visible = false;
    renderer.render(scene, camera);
    const b = read();
    v.view.group.visible = was;
    let changed = 0;
    for (let i = 0; i < a.length; i += 4) {
      if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 24) changed++;
    }
    return { changed, total: w * h };
  },
};

// ---- ループ ----
renderer.setAnimationLoop(() => {
  const now = performance.now();
  controls.update();
  updateViews(now);
  renderPanel(now);
  warmUpPending();
  const t0 = performance.now();
  renderer.render(scene, camera);
  const renderMs = performance.now() - t0;
  renderMsEma = renderMsEma ? renderMsEma * 0.9 + renderMs * 0.1 : renderMs;
  fpsFrames++;
  if (now - fpsWindowStart >= 1000) {
    fps = (fpsFrames * 1000) / (now - fpsWindowStart);
    fpsFrames = 0;
    fpsWindowStart = now;
    hud.textContent = diagSummary();
  }
});
