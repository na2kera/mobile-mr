// 自分の手のスロット管理（MediaPipe の結果 → カメラ座標系の 21 点 → 2 スロットへの割当 →
// 指数移動平均 → 当たり判定点のワールド座標と速度）。05 → 06 で 2 回写したものを
// 06-2 で抽出した（05 / 06 のデモ内の複製はそのまま残す）。
// スロットは「同じ手の続き」を手首位置の近さで判断し、手ごとの EMA・速度を持つ
import * as THREE from "three";
import { HandView } from "./hand-view";
import {
  FINGER_TIPS,
  LANDMARK_COUNT,
  WRIST,
  placeLandmarks,
  solveHandPlacement,
} from "./hand-math";
import type { Vec3, ViewMapping } from "./hand-math";

export const HAND_COLORS = { R: 0x8ab4f8, L: 0xffa657, "-": 0xe8eaed } as const;
export type HandLabel = keyof typeof HAND_COLORS;

/** 当たり判定に使う点: 5 指先 + 手のひら（MCP 4 点と手首の重心） */
export const PALM_INDICES = [WRIST, 5, 9, 13, 17];
export const CONTACT_COUNT = FINGER_TIPS.length + 1;
/** contactsWorld / contactsVel の中で手のひらの index */
export const PALM_CONTACT = CONTACT_COUNT - 1;

export type HandResultLike = {
  landmarks: readonly (readonly Vec3[])[];
  worldLandmarks: readonly (readonly Vec3[])[];
  handedness: readonly (readonly { categoryName: string }[])[];
};

export type DetectedHand = {
  label: HandLabel;
  points: Vec3[];
  depth: number;
  residual: number;
  handCm: number;
};

export type HandSlot = {
  view: HandView;
  label: HandLabel;
  /** 平滑化した 21 点（カメラ座標系）。未検出は null */
  ema: Vec3[] | null;
  lastWrist: Vec3;
  lastSeenMs: number;
  depth: number;
  residual: number;
  handCm: number;
  /** 当たり判定点のワールド座標（毎フレーム、今の頭の向きで更新） */
  contactsWorld: THREE.Vector3[];
  /**
   * 当たり判定点の速度 [m/s]（ワールド座標）。推論時のスナップショット同士の差で計算する
   * （contactsWorld は頭の回転で毎フレーム動くので、そこから速度を取ると頭の回転が混ざる）
   */
  contactsVel: THREE.Vector3[];
  snapContacts: THREE.Vector3[] | null;
  snapMs: number;
};

export type HandSlotsOptions = {
  /** 骨格をぶら下げる親（通常はカメラ） */
  camera: THREE.Camera;
  numHands: number;
  /** EMA 係数（1 で平滑化なし） */
  smooth: number;
  lostMs: number;
  maxDepthM: number;
  /** worldLandmarks の実寸補正（05 の較正値。未較正は 1） */
  handScale: number;
  /** スロット継続の判定: 手首の距離 [m] + 速度 [m/s] × 経過 */
  matchDistM: number;
  matchSpeedMps: number;
  swapHands: boolean;
};

export class HandSlots {
  readonly slots: HandSlot[] = [];
  private readonly opts: HandSlotsOptions;
  private readonly tmp = new THREE.Vector3();

  constructor(opts: HandSlotsOptions) {
    this.opts = opts;
    for (let i = 0; i < 2; i++) {
      const view = new HandView(HAND_COLORS["-"]);
      opts.camera.add(view.group);
      this.slots.push({
        view,
        label: "-",
        ema: null,
        lastWrist: { x: 0, y: 0, z: 0 },
        lastSeenMs: -Infinity,
        depth: 0,
        residual: 0,
        handCm: 0,
        contactsWorld: Array.from({ length: CONTACT_COUNT }, () => new THREE.Vector3()),
        contactsVel: Array.from({ length: CONTACT_COUNT }, () => new THREE.Vector3()),
        snapContacts: null,
        snapMs: 0,
      });
    }
  }

  /** 見えているスロット */
  visible(): HandSlot[] {
    return this.slots.filter((s) => s.view.visible);
  }

  /** ロスト処理と、当たり判定点のワールド座標の更新。毎フレーム呼ぶ */
  update(now: number) {
    for (const slot of this.slots) {
      if (slot.view.visible && now - slot.lastSeenMs > this.opts.lostMs) {
        slot.view.hide();
        slot.ema = null;
        slot.snapContacts = null;
      }
    }
    for (const slot of this.slots) {
      if (slot.view.visible && slot.ema) this.updateContactsWorld(slot);
    }
  }

  private updateContactsWorld(slot: HandSlot) {
    const { camera } = this.opts;
    const ema = slot.ema!;
    for (const [k, tipIndex] of FINGER_TIPS.entries()) {
      const p = ema[tipIndex];
      slot.contactsWorld[k].set(p.x, p.y, p.z);
      camera.localToWorld(slot.contactsWorld[k]);
    }
    const palm = slot.contactsWorld[PALM_CONTACT].set(0, 0, 0);
    for (const i of PALM_INDICES) palm.add(this.tmp.set(ema[i].x, ema[i].y, ema[i].z));
    palm.divideScalar(PALM_INDICES.length);
    camera.localToWorld(palm);
  }

  /**
   * 推論結果を取り込む
   * @param mapping 表示基準の写像（点の配置用）
   * @param depthMapping 深度を解く写像（実寸基準。フェイクの手は表示基準）
   */
  apply(result: HandResultLike, now: number, mapping: ViewMapping, depthMapping: ViewMapping) {
    const o = this.opts;
    const detected: DetectedHand[] = [];
    for (const [i, landmarks] of result.landmarks.entries()) {
      const worldRaw = result.worldLandmarks[i];
      if (!worldRaw || landmarks.length < LANDMARK_COUNT || worldRaw.length < LANDMARK_COUNT) continue;
      const world =
        o.handScale === 1
          ? worldRaw
          : worldRaw.map((w) => ({ x: w.x * o.handScale, y: w.y * o.handScale, z: w.z * o.handScale }));
      const placement = solveHandPlacement(landmarks, world, depthMapping);
      if (!placement || placement.depth > o.maxDepthM) continue;
      const reported = result.handedness[i]?.[0]?.categoryName;
      const raw: HandLabel = reported === "Left" ? "L" : reported === "Right" ? "R" : "-";
      const label: HandLabel = o.swapHands && raw !== "-" ? (raw === "L" ? "R" : "L") : raw;
      const w0 = world[0];
      const w12 = world[12];
      detected.push({
        label,
        points: placeLandmarks(landmarks, world, placement, mapping),
        depth: placement.depth,
        residual: placement.residual,
        handCm: Math.hypot(w12.x - w0.x, w12.y - w0.y, w12.z - w0.z) * 100,
      });
      if (detected.length >= this.slots.length) break;
    }

    // スロット割当: 手首位置の近さで「同じ手の続き」を組む
    const slots = this.slots;
    const assignment = new Map<HandSlot, DetectedHand>();
    const continuing = new Set<HandSlot>();
    const taken = new Set<DetectedHand>();
    const isLive = (s: HandSlot) => s.ema !== null && now - s.lastSeenMs <= o.lostMs;
    const pairs: { slot: HandSlot; hand: DetectedHand; dist: number; limit: number }[] = [];
    for (const slot of slots) {
      if (!isLive(slot)) continue;
      const limit = o.matchDistM + (o.matchSpeedMps * (now - slot.lastSeenMs)) / 1000;
      for (const hand of detected) {
        const a = slot.lastWrist;
        const b = hand.points[WRIST];
        pairs.push({ slot, hand, dist: Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z), limit });
      }
    }
    pairs.sort((p, q) => p.dist - q.dist);
    for (const { slot, hand, dist, limit } of pairs) {
      if (dist > limit) continue;
      if (assignment.has(slot) || taken.has(hand)) continue;
      assignment.set(slot, hand);
      continuing.add(slot);
      taken.add(hand);
    }
    for (const hand of detected) {
      if (taken.has(hand)) continue;
      const liveUnassigned = slots
        .filter((s) => !assignment.has(s) && isLive(s))
        .sort((a, b) => a.lastSeenMs - b.lastSeenMs);
      const liveCount = slots.filter((s) => isLive(s) || assignment.has(s)).length;
      const mustReuse = liveUnassigned.length > 0 && liveCount + 1 > o.numHands;
      const target = mustReuse
        ? liveUnassigned[0]
        : (slots.find((s) => !assignment.has(s) && !isLive(s)) ?? liveUnassigned[0]);
      if (!target) break;
      assignment.set(target, hand);
      taken.add(hand);
    }
    for (const [slot, hand] of assignment) this.updateSlot(slot, hand, now, continuing.has(slot));
  }

  private updateSlot(slot: HandSlot, hand: DetectedHand, now: number, continuing: boolean) {
    const o = this.opts;
    if (continuing && slot.ema) {
      for (let k = 0; k < LANDMARK_COUNT; k++) {
        const e = slot.ema[k];
        e.x += (hand.points[k].x - e.x) * o.smooth;
        e.y += (hand.points[k].y - e.y) * o.smooth;
        e.z += (hand.points[k].z - e.z) * o.smooth;
      }
    } else {
      slot.ema = hand.points;
      slot.snapContacts = null;
    }
    if (slot.label !== hand.label) {
      slot.label = hand.label;
      slot.view.setColor(HAND_COLORS[hand.label]);
    }
    slot.view.update(slot.ema);
    slot.depth = hand.depth;
    slot.residual = hand.residual;
    slot.handCm = hand.handCm;
    slot.lastSeenMs = now;
    slot.lastWrist = hand.points[WRIST];
    this.updateContactsWorld(slot);
    const dt = (now - slot.snapMs) / 1000;
    if (slot.snapContacts && dt > 0) {
      for (const [k, v] of slot.contactsVel.entries()) {
        v.subVectors(slot.contactsWorld[k], slot.snapContacts[k]).divideScalar(dt);
      }
    } else {
      for (const v of slot.contactsVel) v.set(0, 0, 0);
    }
    if (!slot.snapContacts) slot.snapContacts = slot.contactsWorld.map((v) => v.clone());
    else for (const [k, v] of slot.snapContacts.entries()) v.copy(slot.contactsWorld[k]);
    slot.snapMs = now;
  }

  /** HUD 用の 1 行 */
  describe(): string {
    return this.visible()
      .map((x) => `${x.label}:${x.depth.toFixed(2)}m hand=${x.handCm.toFixed(1)}cm res=${x.residual.toFixed(3)}`)
      .join(" ");
  }
}
