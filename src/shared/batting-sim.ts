// Phase 10-2 (10-2-batting): 投球と打球の決定的な軌道計算。
// サーバーが判定に使い、スマホと俯瞰画面が同じ入力から描画を再現する。
// three.js に依存させず Node の回帰テストから直接 import できるようにする。
import type { JoyConButtons } from "./joycon-report.ts";

export type V3 = [number, number, number];
export type PitchType = "fastball" | "curve" | "slider" | "fork";

export type BattingConfig = {
  wallW: number;
  wallH: number;
  floorDepth: number;
  floorDrop: number;
  moundZ: number;
  plateZ: number;
  releaseY: number;
  strikeY: number;
  strikeHalfW: number;
  strikeHalfH: number;
  minPitchSpeed: number;
  maxPitchSpeed: number;
  minSwingSpeed: number;
  maxSwingSpeed: number;
  contactWindowMs: number;
};

export const BALL_R = 0.0366;
export const PITCH_STEP_SEC = 0.005;
export const HIT_STEP_SEC = 0.01;

export const DEFAULT_BATTING: BattingConfig = {
  wallW: 3,
  wallH: 2.4,
  floorDepth: 2.5,
  floorDrop: 1.2,
  moundZ: 0.35,
  plateZ: 2.1,
  releaseY: -0.25,
  strikeY: -0.43,
  strikeHalfW: 0.28,
  strikeHalfH: 0.38,
  minPitchSpeed: 3,
  maxPitchSpeed: 8,
  minSwingSpeed: 1,
  maxSwingSpeed: 14,
  contactWindowMs: 150,
};

export const PITCH_TYPES: readonly PitchType[] = [
  "fastball",
  "curve",
  "slider",
  "fork",
];

export const PITCH_LABELS: Record<PitchType, string> = {
  fastball: "ストレート",
  curve: "カーブ",
  slider: "スライダー",
  fork: "フォーク",
};

/**
 * Joy-Con (L) の方向ボタンと球種。
 * 上=ストレート、右=カーブ、左=スライダー、下=フォーク。
 * 何も押さずに投げた場合もストレート。複数同時押しは下→左→右→上の順で決める。
 */
export function pitchTypeFromButtons(
  buttons: Pick<JoyConButtons, "up" | "right" | "left" | "down">,
): PitchType {
  if (buttons.down) return "fork";
  if (buttons.left) return "slider";
  if (buttons.right) return "curve";
  return "fastball";
}

export type PitchResult = {
  type: PitchType;
  speed: number;
  samples: V3[];
  duration: number;
  plate: V3;
  inZone: boolean;
};

function pitchPoint(type: PitchType, u: number, cfg: BattingConfig): V3 {
  const xBreak =
    type === "curve"
      ? 0.22 * u * u
      : type === "slider"
        ? -0.18 * u * u * u
        : 0;
  const late = Math.max(0, (u - 0.55) / 0.45);
  const forkDrop = type === "fork" ? 0.28 * late * late : 0;
  // 短い実寸コートでも球筋を目で追えるよう、直線補間に小さな山なりを足す。
  const arc = 0.1 * 4 * u * (1 - u);
  return [
    xBreak,
    cfg.releaseY + (cfg.strikeY - cfg.releaseY) * u + arc - forkDrop,
    cfg.moundZ + (cfg.plateZ - cfg.moundZ) * u,
  ];
}

/** 球種と速さから、マウンド→ホームベースの軌道を固定刻みで作る。 */
export function simulatePitch(
  type: PitchType,
  rawSpeed: number,
  cfg: BattingConfig = DEFAULT_BATTING,
): PitchResult {
  const speed = clamp(rawSpeed, cfg.minPitchSpeed, cfg.maxPitchSpeed);
  const distance = cfg.plateZ - cfg.moundZ;
  const duration = distance / speed;
  const steps = Math.max(1, Math.ceil(duration / PITCH_STEP_SEC));
  const samples: V3[] = [];
  for (let i = 0; i <= steps; i++) {
    samples.push(pitchPoint(type, i / steps, cfg));
  }
  const plate = samples[samples.length - 1];
  const inZone =
    Math.abs(plate[0]) <= cfg.strikeHalfW &&
    Math.abs(plate[1] - cfg.strikeY) <= cfg.strikeHalfH;
  return { type, speed, samples, duration, plate: [...plate], inZone };
}

/** 投球途中の位置。サンプル間は線形補間し、範囲外は端へ丸める。 */
export function pitchAt(result: PitchResult, t: number): V3 {
  return sampleAt(result.samples, t, result.duration);
}

export type HitFlight = {
  samples: V3[];
  duration: number;
  end: V3;
  distance: number;
  exitSpeed: number;
};

export type SwingResult = {
  kind: "hit" | "miss";
  reason: "contact" | "early" | "late" | "weak" | "out-of-reach";
  timingMs: number;
  label: string;
  pitchPos: V3;
  hit: HitFlight | null;
};

/**
 * サーバーで受信した振りの時刻を、投球がホームベースへ着く時刻と比較して判定する。
 * LAN 上の PC Joy-Con ハブから届く前提で、許容幅は config.contactWindowMs。
 */
export function resolveSwing(
  pitch: PitchResult,
  elapsedSec: number,
  rawSwingSpeed: number,
  faceDeg: number,
  cfg: BattingConfig = DEFAULT_BATTING,
): SwingResult {
  const timingMs = Math.round((elapsedSec - pitch.duration) * 1000);
  const pitchPos = pitchAt(pitch, elapsedSec);
  if (!Number.isFinite(rawSwingSpeed) || rawSwingSpeed < cfg.minSwingSpeed) {
    return { kind: "miss", reason: "weak", timingMs, label: "空振り（弱い）", pitchPos, hit: null };
  }
  if (timingMs < -cfg.contactWindowMs) {
    return { kind: "miss", reason: "early", timingMs, label: "空振り（早い）", pitchPos, hit: null };
  }
  if (timingMs > cfg.contactWindowMs) {
    return { kind: "miss", reason: "late", timingMs, label: "空振り（遅い）", pitchPos, hit: null };
  }
  const reachable =
    Math.abs(pitchPos[0]) <= cfg.strikeHalfW + 0.18 &&
    Math.abs(pitchPos[1] - cfg.strikeY) <= cfg.strikeHalfH + 0.18;
  if (!reachable) {
    return { kind: "miss", reason: "out-of-reach", timingMs, label: "空振り（ボール球）", pitchPos, hit: null };
  }
  const hit = simulateHit(pitchPos, rawSwingSpeed, faceDeg, timingMs, cfg);
  const label =
    hit.distance >= 5
      ? "ホームラン！"
      : hit.distance >= 3
        ? "長打！"
        : hit.distance >= 1.5
          ? "ヒット！"
          : "当たった！";
  return { kind: "hit", reason: "contact", timingMs, label, pitchPos, hit };
}

/** 打球。打者側（+Z）からマーカー側（-Z）へ飛ばし、床に落ちるまで積分する。 */
export function simulateHit(
  from: V3,
  rawSwingSpeed: number,
  faceDeg: number,
  timingMs: number,
  cfg: BattingConfig = DEFAULT_BATTING,
): HitFlight {
  const swingSpeed = clamp(rawSwingSpeed, cfg.minSwingSpeed, cfg.maxSwingSpeed);
  const quality = 1 - Math.min(1, Math.abs(timingMs) / cfg.contactWindowMs);
  const exitSpeed = clamp(swingSpeed * (1.1 + quality * 0.7), 2.5, 20);
  const sprayDeg = clamp(faceDeg + timingMs * 0.09, -55, 55);
  const yaw = (sprayDeg * Math.PI) / 180;
  const loft = (25 + quality * 22) * (Math.PI / 180);
  let vx = Math.sin(yaw) * Math.cos(loft) * exitSpeed;
  let vy = Math.sin(loft) * exitSpeed;
  let vz = -Math.cos(yaw) * Math.cos(loft) * exitSpeed;
  let p: V3 = [...from];
  const samples: V3[] = [[...p]];
  const floorY = -cfg.floorDrop + BALL_R;
  const maxSteps = Math.ceil(3 / HIT_STEP_SEC);
  let steps = 0;
  while (steps < maxSteps) {
    vy -= 9.81 * HIT_STEP_SEC;
    p = [
      p[0] + vx * HIT_STEP_SEC,
      p[1] + vy * HIT_STEP_SEC,
      p[2] + vz * HIT_STEP_SEC,
    ];
    steps++;
    if (p[1] <= floorY && vy < 0) {
      p[1] = floorY;
      samples.push([...p]);
      break;
    }
    samples.push([...p]);
    // 空気抵抗の最小モデル。固定刻みなので両端で同じ結果になる。
    vx *= 0.999;
    vy *= 0.999;
    vz *= 0.999;
  }
  const end: V3 = [...samples[samples.length - 1]];
  const distance = Math.hypot(end[0] - from[0], end[2] - from[2]);
  return {
    samples,
    duration: steps * HIT_STEP_SEC,
    end,
    distance,
    exitSpeed,
  };
}

export function hitAt(result: HitFlight, t: number): V3 {
  return sampleAt(result.samples, t, result.duration);
}

function sampleAt(samples: readonly V3[], t: number, duration: number): V3 {
  if (samples.length === 1 || t <= 0) return [...samples[0]];
  if (t >= duration) return [...samples[samples.length - 1]];
  const f = (t / duration) * (samples.length - 1);
  const i = Math.floor(f);
  const u = f - i;
  const a = samples[i];
  const b = samples[Math.min(i + 1, samples.length - 1)];
  return [
    a[0] + (b[0] - a[0]) * u,
    a[1] + (b[1] - a[1]) * u,
    a[2] + (b[2] - a[2]) * u,
  ];
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
