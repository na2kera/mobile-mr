import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { numParam, params } from "../../src/shared/url-params";
import { ROOM_ID_PATTERN } from "../../src/shared/shared-room-protocol";
import { DEFAULT_MARKER_MM } from "../../src/shared/marker-layout";
import { TextPanel } from "../../src/shared/text-panel";
import {
  DEFAULT_BATTING,
  PITCH_LABELS,
  clamp,
  hitAt,
  pitchAt,
  pitchTypeFromButtons,
  simulatePitch,
  type BattingConfig,
  type HitFlight,
  type PitchResult,
  type PitchType,
} from "../../src/shared/batting-sim";
import type { GameSnapshot } from "../../src/shared/batting-game";
import type {
  MotionKind,
  PlayerPose,
} from "../../src/shared/batting-protocol";
import { IMU_SAMPLE_SEC, type StandardReport } from "../../src/shared/joycon-report";
import {
  SwingDetector,
  impactSpeed,
  type Impact,
} from "../../src/shared/swing-detector";
import { startRemoteLog } from "../../src/shared/remote-log";
import {
  FakeJoyCon,
  JoyConHub,
  hidSupported,
  type JoyCon,
} from "../10-golf/joycon-hid";
import { BattingFieldView } from "./field-view";
import { connectGame, type GameClient } from "./game-client";

// PC Chrome の俯瞰画面兼 Joy-Con ハブ。
// Joy-Con をプレイヤーへ割り当て、投手なら方向ボタン+振りを pitch、打者なら振りを swing として送る。

const roomRaw = params.get("room");
const ROOM =
  roomRaw === null
    ? "demo"
    : ROOM_ID_PATTERN.test(roomRaw)
      ? roomRaw
      : null;
const MARKER_MM = numParam("markerMm", DEFAULT_MARKER_MM, { max: 5000 });
const MARKER_ID = Math.round(
  numParam("markerId", 0, { min: 0, max: 249 }),
);
const ARM_M = numParam("armM", 0.65, { min: 0.2, max: 2 });
const PITCH_GAIN = numParam("pitchGain", 1.2, { min: 0.1, max: 10 });
const BAT_GAIN = numParam("batGain", 1.5, { min: 0.1, max: 10 });
const SWING_OPTS = {
  stillDps: numParam("stillDps", 25, { min: 1, max: 500 }),
  stillMs: numParam("stillMs", 250, { min: 50, max: 5000 }),
  minBackswingDeg: numParam("minBackswing", 8, { min: 1, max: 90 }),
  minImpactDps: numParam("minImpactDps", 30, { min: 1, max: 2000 }),
  maxSwingMs: numParam("maxSwingMs", 3000, { min: 200, max: 20000 }),
  swingStillMs: numParam("swingStillMs", 450, {
    min: 100,
    max: 10000,
  }),
};
const MOTION_SEND_MS = 50;
const FAKE_JOYCON = params.has("fakeJoycon");
const FAKE_DELAY_SEC = numParam("fakeDelay", 0.45, {
  min: 0.05,
  max: 10,
});

let lastHudText = "";
startRemoteLog({
  tag: "batting-overview",
  snapshot: () => lastHudText,
  snapshotMs: 3000,
});

// ---- scene ----
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a2233);
scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.2));
const light = new THREE.DirectionalLight(0xffffff, 1.5);
light.position.set(3, 8, 3);
scene.add(light);
const camera = new THREE.PerspectiveCamera(
  50,
  innerWidth / innerHeight,
  0.05,
  100,
);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
document.querySelector<HTMLDivElement>("#app")!.appendChild(renderer.domElement);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enablePan = false;
function resize() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
}
resize();
addEventListener("resize", resize);

let cfg: BattingConfig = { ...DEFAULT_BATTING };
const fieldView = new BattingFieldView(24);
scene.add(fieldView.group);
fieldView.build(cfg);
scene.add(new THREE.AxesHelper(0.3));
const markerFrame = new THREE.Mesh(
  new THREE.PlaneGeometry(MARKER_MM / 1000, MARKER_MM / 1000),
  new THREE.MeshBasicMaterial({
    color: 0x8ab4f8,
    transparent: true,
    opacity: 0.5,
    side: THREE.DoubleSide,
  }),
);
scene.add(markerFrame);
function fitCamera() {
  camera.position.set(
    cfg.wallW * 0.65,
    -cfg.floorDrop + cfg.wallH * 0.85,
    cfg.floorDepth + cfg.wallW * 0.65,
  );
  controls.target.set(0, -cfg.floorDrop + 0.35, cfg.floorDepth / 2);
  controls.update();
}
fitCamera();

// ---- player heads ----
type Peer = {
  group: THREE.Group;
  label: TextPanel;
  targetPos: THREE.Vector3;
  targetQuat: THREE.Quaternion;
  lastPose: number;
};
const peers = new Map<string, Peer>();
function createPeer(id: string): Peer {
  removePeer(id);
  const group = new THREE.Group();
  group.add(
    new THREE.Mesh(
      new THREE.SphereGeometry(0.1, 20, 14),
      new THREE.MeshStandardMaterial({ color: 0xe8eaed }),
    ),
  );
  const nose = new THREE.Mesh(
    new THREE.ConeGeometry(0.035, 0.1, 12),
    new THREE.MeshStandardMaterial({ color: 0x9aa0a6 }),
  );
  nose.rotation.x = -Math.PI / 2;
  nose.position.z = -0.11;
  group.add(nose);
  group.visible = false;
  scene.add(group);
  const label = new TextPanel(0.48, 0.12, 384);
  scene.add(label.mesh);
  const peer = {
    group,
    label,
    targetPos: new THREE.Vector3(),
    targetQuat: new THREE.Quaternion(),
    lastPose: -Infinity,
  };
  peers.set(id, peer);
  return peer;
}
function removePeer(id: string) {
  const peer = peers.get(id);
  if (!peer) return;
  peer.group.removeFromParent();
  peer.label.mesh.removeFromParent();
  peers.delete(id);
}
function onPeerPose(id: string, pose: PlayerPose) {
  const peer = peers.get(id) ?? createPeer(id);
  peer.targetPos.set(...pose.pos);
  peer.targetQuat.set(...pose.quat);
  peer.lastPose = performance.now();
}
const tmpQuat = new THREE.Quaternion();
function updatePeers(now: number) {
  camera.getWorldQuaternion(tmpQuat);
  for (const [id, peer] of peers) {
    const visible = now - peer.lastPose < 2000;
    peer.group.visible = visible;
    if (!visible) {
      peer.label.set("");
      continue;
    }
    peer.group.position.lerp(peer.targetPos, 0.25);
    peer.group.quaternion.slerp(peer.targetQuat, 0.25);
    peer.label.mesh.position
      .copy(peer.group.position)
      .add(new THREE.Vector3(0, 0.2, 0));
    peer.label.mesh.quaternion.copy(tmpQuat);
    const player = auth?.state.players.find((p) => p.id === id);
    peer.label.set(
      player
        ? `${player.name}（${player.role === "batter" ? "打者" : "投手"}）`
        : id,
      player?.role === "batter" ? "#ffb300" : "#00b8d4",
    );
  }
}

// ---- network state ----
let selfId = "";
let netStatus = "idle";
let joined = false;
let client: GameClient | null = null;
let auth: { state: GameSnapshot; recvMs: number } | null = null;
let lastRejectReason = "";
let pitchesSent = 0;
let swingsSent = 0;
let restartsSent = 0;
let lastEventKey = "";
let livePitch:
  | { seq: number; result: PitchResult; startLocalMs: number }
  | null = null;
let liveHit:
  | { seq: number; result: HitFlight; startLocalMs: number }
  | null = null;

function localTimeOf(
  serverT: number,
  refServerT: number,
  refLocalMs: number,
) {
  return refLocalMs + (serverT - refServerT);
}
function nameOf(id: string) {
  return auth?.state.players.find((p) => p.id === id)?.name ?? id;
}
function onState(state: GameSnapshot) {
  const now = performance.now();
  auth = { state, recvMs: now };
  if (state.pitch && state.pitch.seq !== livePitch?.seq) {
    livePitch = {
      seq: state.pitch.seq,
      result: simulatePitch(state.pitch.type, state.pitch.speed, cfg),
      startLocalMs: localTimeOf(state.pitch.startedAt, state.t, now),
    };
  }
  if (!state.pitch) livePitch = null;
  if (state.hit && state.hit.seq !== liveHit?.seq) {
    liveHit = {
      seq: state.hit.seq,
      result: {
        samples: state.hit.samples.map((p) => [...p]),
        duration: state.hit.duration,
        end: [...state.hit.end],
        distance: state.hit.distance,
        exitSpeed: state.hit.exitSpeed,
      },
      startLocalMs: localTimeOf(state.hit.startedAt, state.t, now),
    };
  }
  if (!state.hit) liveHit = null;
  const event = state.event;
  const key = event ? `${state.seq}:${event.kind}` : "";
  if (key && key !== lastEventKey) {
    lastEventKey = key;
    console.log(
      `[overview] event=${event?.kind} phase=${state.phase} mode=${state.mode}`,
    );
  }
  renderPanel();
}

function connect() {
  if (ROOM === null) return;
  client = connectGame(
    ROOM,
    "",
    { markerId: MARKER_ID, markerMm: MARKER_MM },
    {
      onStatus: (status) => {
        netStatus = status;
        if (status !== "open") joined = false;
        renderPanel();
      },
      onWelcome: (id, _role, _playerRole, peerIds, config, state) => {
        selfId = id;
        joined = true;
        netStatus = "open";
        cfg = config;
        fieldView.build(cfg);
        fitCamera();
        [...peers.keys()].forEach(removePeer);
        peerIds.forEach(createPeer);
        lastEventKey = "";
        onState(state);
      },
      onPeerJoin: (id) => {
        createPeer(id);
        renderPanel();
      },
      onPeerLeave: (id) => {
        removePeer(id);
        renderPanel();
      },
      onPeerPose,
      onState,
      onMotion: () => {},
      onRejected: (reason) => {
        lastRejectReason = reason;
        renderPanel();
      },
      onError: (reason) => {
        netStatus = `error: ${reason}`;
        renderPanel();
      },
    },
    "overview",
  );
}

// ---- Joy-Con hub ----
type Assignment = "auto" | "none" | string;
type JoyConSlot = {
  jc: JoyCon;
  det: SwingDetector;
  assign: Assignment;
  selectedPitch: PitchType;
  lastMotionMs: number;
  lastImpact:
    | (Impact & {
        speed: number;
        playerId: string | null;
        kind: MotionKind | null;
        sent: boolean;
      })
    | null;
  dps: number;
  swings: number;
  row: {
    root: HTMLDivElement;
    name: HTMLSpanElement;
    select: HTMLSelectElement;
    meta: HTMLDivElement;
  };
};
const slots = new Map<string, JoyConSlot>();
const joyconRows = document.querySelector<HTMLDivElement>("#joycon-rows")!;
const joyconHint = document.querySelector<HTMLDivElement>("#joycon-hint")!;
const connectButton =
  document.querySelector<HTMLButtonElement>("#connect-joycon")!;
let lastPanelKey = "";

function playerOf(slot: JoyConSlot): string | null {
  if (slot.assign === "none") return null;
  const state = auth?.state;
  if (!state) return null;
  if (slot.assign !== "auto") {
    return state.players.some((p) => p.id === slot.assign)
      ? slot.assign
      : null;
  }
  if (state.phase === "waitingPitch" && state.mode === "duel") {
    return state.pitcherId;
  }
  return state.batterId;
}

function motionKindOf(playerId: string | null): MotionKind | null {
  const player = auth?.state.players.find((p) => p.id === playerId);
  return player?.role === "pitcher"
    ? "pitch"
    : player?.role === "batter"
      ? "bat"
      : null;
}

function onReport(jc: JoyCon, report: StandardReport, nowMs: number) {
  const slot = slots.get(jc.key);
  if (!slot) return;
  const playerId = playerOf(slot);
  const kind = motionKindOf(playerId);
  const hasDirection =
    report.buttons.up ||
    report.buttons.right ||
    report.buttons.left ||
    report.buttons.down;
  if (kind === "pitch" && hasDirection) {
    // 振りの途中に押されていた最後の方向をリリースまで保持する。
    slot.selectedPitch = pitchTypeFromButtons(report.buttons);
  } else if (slot.det.phase === "address") {
    slot.selectedPitch = "fastball";
  }
  let dps = 0;
  for (let i = 0; i < report.imu.length; i++) {
    const sample = report.imu[i];
    dps = Math.hypot(...sample.gyro);
    const sampleAt =
      nowMs - (report.imu.length - 1 - i) * IMU_SAMPLE_SEC * 1000;
    const impact = slot.det.sample(
      sampleAt,
      sample.gyro,
      sample.accel,
      IMU_SAMPLE_SEC,
    );
    if (impact) onImpact(slot, impact, playerId, kind);
  }
  slot.dps = dps;
  if (
    client &&
    playerId &&
    kind &&
    nowMs - slot.lastMotionMs >= MOTION_SEND_MS
  ) {
    slot.lastMotionMs = nowMs;
    client.sendMotion(
      playerId,
      kind,
      round1(slot.det.angleDeg),
      round1(dps),
    );
  }
}

function onImpact(
  slot: JoyConSlot,
  impact: Impact,
  playerId: string | null,
  kind: MotionKind | null,
) {
  slot.swings++;
  let speed = impactSpeed(
    impact.dps,
    ARM_M,
    kind === "pitch" ? PITCH_GAIN : BAT_GAIN,
  );
  let sent = false;
  if (client && auth && playerId && kind === "pitch") {
    speed = clamp(speed, cfg.minPitchSpeed, cfg.maxPitchSpeed);
    if (
      auth.state.mode === "duel" &&
      auth.state.phase === "waitingPitch" &&
      auth.state.pitcherId === playerId
    ) {
      sent = client.sendPitch(
        slot.selectedPitch,
        round3(speed),
        playerId,
      );
      if (sent) pitchesSent++;
    }
  } else if (client && auth && playerId && kind === "bat") {
    speed = clamp(speed, cfg.minSwingSpeed, cfg.maxSwingSpeed);
    if (
      auth.state.phase === "pitching" &&
      auth.state.batterId === playerId
    ) {
      sent = client.sendSwing(
        round3(speed),
        round1(impact.faceDeg),
        playerId,
      );
      if (sent) swingsSent++;
    }
  }
  slot.lastImpact = { ...impact, speed, playerId, kind, sent };
  console.log(
    `[overview] impact ${slot.jc.name}: ${kind ?? "-"} player=${playerId ?? "-"} dps=${impact.dps.toFixed(0)} speed=${speed.toFixed(2)} pitch=${slot.selectedPitch} ${sent ? "sent" : "ignored"}`,
  );
  renderPanel();
}

const hub = new JoyConHub({
  onConnect: addSlot,
  onReport,
  onStatus: (jc, status) => {
    if (/失敗/.test(status)) lastRejectReason = `${jc.name}: ${status}`;
    renderPanel();
  },
  onDisconnect: (jc) => {
    slots.get(jc.key)?.row.root.remove();
    slots.delete(jc.key);
    renderPanel();
  },
});

function addSlot(jc: JoyCon) {
  if (slots.has(jc.key)) return;
  const root = document.createElement("div");
  root.className = "jc";
  const name = document.createElement("span");
  name.className = "name";
  const select = document.createElement("select");
  const meta = document.createElement("div");
  meta.className = "meta";
  root.append(name, select, meta);
  joyconRows.append(root);
  const slot: JoyConSlot = {
    jc,
    det: new SwingDetector(SWING_OPTS),
    assign: "auto",
    selectedPitch: "fastball",
    lastMotionMs: -Infinity,
    lastImpact: null,
    dps: 0,
    swings: 0,
    row: { root, name, select, meta },
  };
  select.addEventListener("change", () => {
    slot.assign = select.value;
    renderPanel();
  });
  slots.set(jc.key, slot);
  renderPanel();
}

// フェイクは 1 台を auto にし、投球待ちなら投手、投球中なら打者へ自動で切り替える。
let fakeJoycon: FakeJoyCon | null = null;
let fakeWaitingSeq = -1;
let fakePitchSeq = -1;
function updateFakeJoycon(now: number) {
  if (!fakeJoycon || !auth) return;
  const state = auth.state;
  const slot = slots.get(fakeJoycon.key);
  if (!slot) return;
  if (
    state.mode === "duel" &&
    state.phase === "waitingPitch" &&
    fakeWaitingSeq !== state.seq &&
    now - auth.recvMs >= FAKE_DELAY_SEC * 1000
  ) {
    fakeWaitingSeq = state.seq;
    const dps =
      (5.5 / (ARM_M * PITCH_GAIN)) * (180 / Math.PI);
    fakeJoycon.trigger({
      backDeg: 20,
      backDps: 120,
      impactDps: Math.max(dps, SWING_OPTS.minImpactDps * 1.2),
      yawDps: 0,
    });
  }
  if (
    state.phase === "pitching" &&
    state.pitch &&
    fakePitchSeq !== state.pitch.seq
  ) {
    const start = localTimeOf(
      state.pitch.startedAt,
      state.t,
      auth.recvMs,
    );
    // 合成の振りは trigger からインパクトまで約 0.25s。ホーム到達に合わせて開始する。
    if (now >= start + state.pitch.duration * 1000 - 250) {
      fakePitchSeq = state.pitch.seq;
      const dps = (8 / (ARM_M * BAT_GAIN)) * (180 / Math.PI);
      fakeJoycon.trigger({
        backDeg: 20,
        backDps: 120,
        impactDps: Math.max(dps, SWING_OPTS.minImpactDps * 1.2),
        yawDps: 0,
      });
    }
  }
}

// ---- field animation ----
function updateField(now: number) {
  const state = auth?.state;
  if (state?.phase === "hit" && liveHit) {
    fieldView.setBall(
      hitAt(liveHit.result, (now - liveHit.startLocalMs) / 1000),
      0xfdd663,
    );
  } else if (state?.phase === "pitching" && livePitch) {
    fieldView.setBall(
      pitchAt(livePitch.result, (now - livePitch.startLocalMs) / 1000),
    );
  } else {
    fieldView.setBall(null);
  }
  const batterSlot = [...slots.values()].find(
    (slot) => playerOf(slot) === state?.batterId,
  );
  const pitcherSlot = [...slots.values()].find(
    (slot) => playerOf(slot) === state?.pitcherId,
  );
  fieldView.setBat(
    state?.batterId
      ? batterSlot?.det.angleDeg ?? (state.phase === "pitching" ? 0 : null)
      : null,
  );
  fieldView.setPitcher(
    state?.pitcherId
      ? pitcherSlot?.det.angleDeg ??
          (state.phase === "waitingPitch" ? 0 : null)
      : null,
  );
}

// ---- panel ----
const phaseEl = document.querySelector<HTMLDivElement>("#phase")!;
const rolesEl = document.querySelector<HTMLUListElement>("#roles")!;
const statusEl = document.querySelector<HTMLDivElement>("#status")!;
const restartButton =
  document.querySelector<HTMLButtonElement>("#restart")!;
const hud = document.querySelector<HTMLDivElement>("#hud")!;
restartButton.addEventListener("click", () => {
  if (client?.sendRestart()) {
    restartsSent++;
    lastRejectReason = "";
  }
});
connectButton.addEventListener("click", async () => {
  connectButton.disabled = true;
  try {
    await hub.request();
  } catch (error: unknown) {
    lastRejectReason =
      error instanceof Error ? error.message : String(error);
  } finally {
    connectButton.disabled = !hidSupported();
    renderPanel();
  }
});
if (hidSupported()) void hub.reconnect();
else connectButton.disabled = true;

if (FAKE_JOYCON) {
  fakeJoycon = new FakeJoyCon({
    onConnect: () => {},
    onReport,
    onStatus: () => {},
    onDisconnect: () => {},
  });
  hub.addFake(fakeJoycon);
  addSlot(fakeJoycon);
  (
    window as unknown as {
      __battingFake: {
        swing: (dps: number) => void;
      };
    }
  ).__battingFake = {
    swing: (dps) =>
      fakeJoycon?.trigger({
        backDeg: 20,
        backDps: 120,
        impactDps: dps,
        yawDps: 0,
      }),
  };
}

function renderPanel() {
  const now = performance.now();
  const state = auth?.state;
  let phaseText = `接続中… (${netStatus})`;
  if (netStatus.startsWith("error")) phaseText = netStatus;
  else if (state?.phase === "lobby") phaseText = "スマホの参加待ち";
  else if (state) {
    const mode =
      state.mode === "free" ? "フリーバッティング" : "2人対戦";
    const phase =
      state.phase === "waitingPitch"
        ? state.mode === "free"
          ? "bot が次の球を準備中"
          : "投手の Joy-Con を待っています"
        : state.phase === "pitching"
          ? `${PITCH_LABELS[state.pitch!.type]} ${Math.round(state.pitch!.speed * 3.6)}km/h`
          : state.phase === "hit"
            ? state.lastResult?.label ?? "打球"
            : state.lastResult?.label ?? "結果";
    phaseText = `${mode} · ${phase}`;
  }
  const roleRows =
    state?.players.map((player) => ({
      id: player.id,
      text: `${player.role === "batter" ? "🥎 打者" : "⚾ 投手"}: ${player.name}（${player.id}）`,
      assigned: [...slots.values()]
        .filter((slot) => playerOf(slot) === player.id)
        .map((slot) => slot.jc.name)
        .join(" / "),
    })) ?? [];
  const slotRows = [...slots.values()].map((slot) => {
    const playerId = playerOf(slot);
    const impact = slot.lastImpact;
    return {
      key: slot.jc.key,
      playerId,
      meta: `${slot.jc.status} / ${now - slot.jc.lastReportMs < 500 ? "受信中" : "待機"} ${slot.jc.reports}件\n担当: ${playerId ? nameOf(playerId) : "-"} / ${motionKindOf(playerId) === "pitch" ? `投球（${PITCH_LABELS[slot.selectedPitch]}）` : motionKindOf(playerId) === "bat" ? "バット" : "-"} / ${slot.det.phase} ${slot.det.angleDeg.toFixed(0)}° ${slot.dps.toFixed(0)}deg/s\n${impact ? `直近: ${impact.kind ?? "-"} ${impact.speed.toFixed(1)}m/s ${impact.sent ? "送信" : "無視"}` : "振り: まだ"}`,
    };
  });
  const key = JSON.stringify([
    phaseText,
    roleRows,
    slotRows,
    netStatus,
    lastRejectReason,
    connectButton.disabled,
  ]);
  if (key === lastPanelKey) return;
  lastPanelKey = key;
  phaseEl.textContent = phaseText;
  rolesEl.replaceChildren(
    ...roleRows.map((row) => {
      const li = document.createElement("li");
      li.textContent = `${row.text}${row.assigned ? ` 🎮 ${row.assigned}` : ""}`;
      return li;
    }),
  );
  if (joined && roleRows.length === 0) {
    const li = document.createElement("li");
    li.textContent = "スマホで同じ room に入ってください";
    rolesEl.append(li);
  }
  restartButton.disabled = !joined || roleRows.length === 0;
  for (const slot of slots.values()) {
    slot.row.name.textContent = slot.jc.name;
    const options = [
      { value: "auto", label: "局面で自動（投手→打者）" },
      ...roleRows.map((row) => ({
        value: row.id,
        label: row.text.replace(/^[^:]+: /, ""),
      })),
      { value: "none", label: "使わない" },
    ];
    if (
      slot.row.select.options.length !== options.length ||
      [...slot.row.select.options].some(
        (option, i) =>
          option.value !== options[i].value ||
          option.textContent !== options[i].label,
      )
    ) {
      slot.row.select.replaceChildren(
        ...options.map((option) =>
          Object.assign(document.createElement("option"), {
            value: option.value,
            textContent: option.label,
          }),
        ),
      );
    }
    if (!options.some((option) => option.value === slot.assign)) {
      slot.assign = "auto";
    }
    slot.row.select.value = slot.assign;
    slot.row.meta.textContent =
      slotRows.find((row) => row.key === slot.jc.key)?.meta ?? "";
  }
  joyconHint.textContent = !hidSupported()
    ? "WebHID 非対応です。PC Chrome で開いてください（?fakeJoycon=1 で合成入力）"
    : slots.size === 0
      ? "Mac の Bluetooth 設定で接続後、「Joy-Con を接続」。2台なら各プレイヤーへ割り当てます"
      : `投手: ↑ストレート / →カーブ / ←スライダー / ↓フォークを押しながら投げる。打者: ボールに合わせて振る。速さは Joy-Con の角速度から計算（arm=${ARM_M}m, pitchGain=${PITCH_GAIN}, batGain=${BAT_GAIN}）`;
  statusEl.textContent = [
    `room=${ROOM ?? "(invalid)"} ws=${netStatus}`,
    state &&
      `投球 ${state.stats.pitches} / 振り ${state.stats.swings} / 安打 ${state.stats.hits} / 空振り ${state.stats.misses}`,
    lastRejectReason && `できません: ${lastRejectReason}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function renderHud() {
  const state = auth?.state;
  const text = state
    ? `overview: room=${ROOM} me=${selfId} ws=${netStatus} mode=${state.mode} phase=${state.phase} players=${state.players.map((p) => `${p.id}:${p.role}`).join(",")} batter=${state.batterId ?? "-"} pitcher=${state.pitcherId ?? "bot"} pitch=${state.pitch ? `#${state.pitch.seq}:${state.pitch.type}` : "-"} stats=${state.stats.pitches}/${state.stats.swings}/${state.stats.hits}/${state.stats.misses} joycons=${slots.size} assigned=${[...slots.values()].map((slot) => `${slot.jc.fake ? "fake" : slot.jc.kind}:${playerOf(slot) ?? "-"}`).join(",") || "-"} impacts=${[...slots.values()].reduce((n, slot) => n + slot.swings, 0)} pitchesSent=${pitchesSent} swingsSent=${swingsSent} restarts=${restartsSent} seq=${state.seq}`
    : `overview: room=${ROOM} ws=${netStatus}`;
  if (text !== lastHudText) {
    lastHudText = text;
    hud.textContent = text;
  }
}

if (ROOM === null) {
  phaseEl.textContent = `room 名「${roomRaw}」は使えません`;
} else {
  connect();
}
addEventListener("pagehide", () => client?.dispose());

let lastPanelMs = 0;
renderer.setAnimationLoop(() => {
  const now = performance.now();
  controls.update();
  updatePeers(now);
  updateField(now);
  updateFakeJoycon(now);
  if (now - lastPanelMs >= 200) {
    lastPanelMs = now;
    renderPanel();
  }
  renderHud();
  renderer.render(scene, camera);
});

function round1(v: number) {
  return Math.round(v * 10) / 10;
}
function round3(v: number) {
  return Math.round(v * 1000) / 1000;
}
