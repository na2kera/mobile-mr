// 08-9: 「静止中はアンカー（コート）を動かさない」ための状態機械。three.js に依存しない純粋な計算
// （Node の回帰テスト scripts/test-08-9-hold.mjs から直接 import する）。
//
// ■ 何をするか
//   マーカー（08-4 の board + solvePnP）と SLAM（08-7 の AlvaAR）で毎フレーム出るアンカーの姿勢（raw）を受け取り、
//   表示に使う姿勢（出力）を返す。出力は 2 つの状態を自動で切り替える:
//     hold   … 出力を固定する（raw の小さなぶれを捨てる）。raw が固定姿勢から「はっきり・しばらく」離れたら follow へ
//     follow … 出力は raw（切り替えた直後だけ、固定姿勢との差を時定数 catchUpTauMs で縮めて滑らかに寄せる）。
//              raw が inMs の間ほぼ動かなければ、その区間の平均で hold へ
//   目標は「ぴったり合わせる」ではなく「数 cm ずれていても、ちょこちょこ動かない」。実機で 08-4 / 08-7 を止まって見ていると
//   数 cm の小さなぶれが残り、それが体験を悪くしていた。
//
// ■ 08-2（一度合わせて固定）との違い
//   08-2 は確定したら二度と動かさないので、歩くとコートが一緒についてきて破綻した。08-9 は raw が閾値を超えて離れ続けたら
//   自動で follow に戻り（歩き始め・マーカーでの取り直し・SLAM の追従）、止まったらまた固定する。「止める / 追従する」を自動で切り替える。
//
// ■ 各値の意味と、なぜこうしたか
//   posM / deg（既定 2cm / 1°）: 「ぶれ」と「本当の動き」の境目。hold 中の離脱の判定と、follow 中の「止まった」の判定の両方に使う。
//     観察されたぶれ（数 cm）より小さいと hold に入れず、大きいと歩き始めの遅れが増える。実機で調整する値（README の実機項目）
//   outMs（既定 250ms）: hold 中に閾値超えが「連続で」この時間続いたら follow へ。1 フレームの外れ値（検出の誤り・鏡像の解・
//     SLAM の一瞬の飛び）では動かさないため。閾値内に戻ったら継続時間は 0 に戻す。代償として、歩き始めは
//     outMs + 閾値に届くまでの時間だけ出力が止まったままになる（0.5m/s なら約 14cm 遅れてから寄せ始める）
//   inMs（既定 600ms）: follow 中、直近 inMs の raw の窓の全点が「窓の平均」から posM / deg 以内なら hold へ。
//     窓が inMs に満たない（follow に入った直後）うちは判定しない
//   固定姿勢は**窓の平均**（位置は算術平均、四元数は符号を揃えて足してから正規化）。直近の 1 点で止めるとぶれの端で固まり、
//     その後のぶれが片側に偏って閾値を超えやすい。中心で止めると、同じぶれでも固定姿勢からの差が最小になる
//   snapM（既定 0.3m）: これ以上離れた raw は即 follow にし、出力も即 raw にする（寄せない）。マーカーの再検出のスナップ
//     （marker-anchor の snapDistanceM と同じ 0.3m）や SLAM のリセットで座標が大きく変わったとき、ゆっくり寄せると
//     その間ずっとずれて見えるため
//   catchUpTauMs（既定 120ms）: follow に入った直後、出力を raw へ寄せる時定数。**出力そのものではなく「出力 − raw」の差を**
//     毎フレーム exp(−dt/τ) 倍に縮める（α = 1 − exp(−dt/τ) で差を詰めるのと同じ）。出力そのものを raw へ lerp すると、
//     歩いている間は速度 × τ（0.5m/s で 6cm）遅れ続けるが、差を縮める形なら raw の動きはそのまま通り、残るのは切り替え時の差だけ。
//     差が 1mm / 0.05° 未満になったら出力 = raw（以後は raw のまま。raw は marker-anchor の smooth / slamSmooth で平滑化済み）
//   時間はすべて nowMs（ms）で数える（フレームレートに依存しない）。nowMs が戻ることは無い前提で、dt ≤ 0 は 0 として扱う
import type { Pose, Quat, V3 } from "./slam-fusion";

export type AnchorHoldOptions = {
  /** false なら update は raw をそのまま返す（?hold=0。経路は同じにして比較する） */
  enabled: boolean;
  /** 止める判定の位置の閾値 [m] */
  posM: number;
  /** 止める判定の回転の閾値 [deg] */
  deg: number;
  /** hold 中、閾値超えがこの時間続いたら follow へ [ms] */
  outMs: number;
  /** follow 中、raw がこの時間ほぼ動かなかったら hold へ [ms] */
  inMs: number;
  /** これ以上離れた raw は即 follow（+ 出力も即 raw）[m] */
  snapM: number;
  /** follow に入った直後、出力が raw に追いつく時定数 [ms] */
  catchUpTauMs: number;
};

export type AnchorHoldState = "hold" | "follow";

export type AnchorHold = {
  /** 毎フレーム呼ぶ。表示に使う姿勢を返す（返り値は呼び出し側で書き換えない） */
  update(raw: Pose, nowMs: number): Pose;
  readonly state: AnchorHoldState;
  /** 直近の raw と出力の位置差 [m] */
  readonly devPosM: number;
  /** 直近の raw と出力の回転差 [deg] */
  readonly devDeg: number;
  /** hold に入った時刻 [ms]（follow 中は NaN） */
  readonly heldSinceMs: number;
  /** HUD 用（"hold dev=0.008m/0.3deg held=4.2s" / "follow dev=0.012m/0.4deg" / "off"） */
  readonly info: string;
  reset(): void;
};

export const DEFAULT_ANCHOR_HOLD: AnchorHoldOptions = {
  enabled: true,
  posM: 0.02,
  deg: 1.0,
  outMs: 250,
  inMs: 600,
  snapM: 0.3,
  catchUpTauMs: 120,
};

/** 追いついたとみなす差（これ未満なら出力 = raw） */
const CAUGHT_UP_M = 0.001;
const CAUGHT_UP_DEG = 0.05;

// ---- 小道具（slam-fusion.ts と同じ並び [x, y, z, w]。Node からそのまま読めるよう、型以外は import しない） ----
function dist(a: V3, b: V3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function quatNorm(q: Quat): Quat {
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

function quatMul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

function quatConj(q: Quat): Quat {
  return [-q[0], -q[1], -q[2], q[3]];
}

/** 2 つの回転の差の角度 [deg]（q と −q は同じ回転） */
export function quatAngleDeg(a: Quat, b: Quat): number {
  const d = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  return (2 * Math.acos(Math.min(1, d)) * 180) / Math.PI;
}

/** 単位四元数 → 回転ベクトル（軸 × 角度 [rad]）。短い側（w ≥ 0）で出す */
function quatToRotVec(q: Quat): V3 {
  const s = q[3] < 0 ? -1 : 1;
  const x = q[0] * s;
  const y = q[1] * s;
  const z = q[2] * s;
  const w = Math.min(1, q[3] * s);
  const sinHalf = Math.hypot(x, y, z);
  if (sinHalf < 1e-12) return [0, 0, 0];
  const angle = 2 * Math.atan2(sinHalf, w);
  return [(x / sinHalf) * angle, (y / sinHalf) * angle, (z / sinHalf) * angle];
}

function rotVecToQuat(v: V3): Quat {
  const angle = Math.hypot(v[0], v[1], v[2]);
  if (angle < 1e-12) return [0, 0, 0, 1];
  const s = Math.sin(angle / 2) / angle;
  return [v[0] * s, v[1] * s, v[2] * s, Math.cos(angle / 2)];
}

function copyPose(p: Pose): Pose {
  return { pos: [p.pos[0], p.pos[1], p.pos[2]], quat: [p.quat[0], p.quat[1], p.quat[2], p.quat[3]] };
}

/** 窓の平均の姿勢（位置は算術平均、四元数は最初の点に符号を揃えて足してから正規化） */
export function meanPose(poses: readonly Pose[]): Pose {
  const pos: V3 = [0, 0, 0];
  const q: Quat = [0, 0, 0, 0];
  const ref = poses[0].quat;
  for (const p of poses) {
    pos[0] += p.pos[0];
    pos[1] += p.pos[1];
    pos[2] += p.pos[2];
    const sign = p.quat[0] * ref[0] + p.quat[1] * ref[1] + p.quat[2] * ref[2] + p.quat[3] * ref[3] < 0 ? -1 : 1;
    q[0] += p.quat[0] * sign;
    q[1] += p.quat[1] * sign;
    q[2] += p.quat[2] * sign;
    q[3] += p.quat[3] * sign;
  }
  const n = poses.length;
  return { pos: [pos[0] / n, pos[1] / n, pos[2] / n], quat: quatNorm(q) };
}

export function createAnchorHold(opts: AnchorHoldOptions): AnchorHold {
  let state: AnchorHoldState = "follow";
  /** 一度でも update されたか（最初の update は出力 = raw で follow） */
  let started = false;
  let lastMs = NaN;
  /** hold 中の固定姿勢 */
  let held: Pose | null = null;
  let heldSinceMs = NaN;
  /** hold 中、閾値超えが始まった時刻（閾値内なら NaN） */
  let exceedSinceMs = NaN;
  /** follow 中の「出力 − raw」（位置はワールドのベクトル、回転は out = offQuat · raw の offQuat） */
  let offPos: V3 = [0, 0, 0];
  let offQuat: Quat = [0, 0, 0, 1];
  let hasOffset = false;
  /** follow 中の raw の窓（時刻の昇順） */
  let win: { t: number; pose: Pose }[] = [];
  let devPosM = 0;
  let devDeg = 0;

  function enterFollow(raw: Pose, from: Pose | null) {
    state = "follow";
    held = null;
    heldSinceMs = NaN;
    exceedSinceMs = NaN;
    win = [];
    if (from) {
      offPos = [from.pos[0] - raw.pos[0], from.pos[1] - raw.pos[1], from.pos[2] - raw.pos[2]];
      offQuat = quatNorm(quatMul(from.quat, quatConj(raw.quat)));
      hasOffset = true;
    } else {
      offPos = [0, 0, 0];
      offQuat = [0, 0, 0, 1];
      hasOffset = false;
    }
  }

  function enterHold(pose: Pose, nowMs: number) {
    state = "hold";
    held = pose;
    heldSinceMs = nowMs;
    exceedSinceMs = NaN;
    win = [];
    hasOffset = false;
  }

  /** follow の出力 = raw + 差（差は exp(−dt/τ) で縮める。十分小さければ 0） */
  function followOutput(raw: Pose, dt: number): Pose {
    if (hasOffset) {
      const k = opts.catchUpTauMs > 0 ? Math.exp(-dt / opts.catchUpTauMs) : 0;
      offPos = [offPos[0] * k, offPos[1] * k, offPos[2] * k];
      const rv = quatToRotVec(offQuat);
      offQuat = rotVecToQuat([rv[0] * k, rv[1] * k, rv[2] * k]);
      const offM = Math.hypot(offPos[0], offPos[1], offPos[2]);
      const offDeg = quatAngleDeg(offQuat, [0, 0, 0, 1]);
      if (offM < CAUGHT_UP_M && offDeg < CAUGHT_UP_DEG) hasOffset = false;
    }
    if (!hasOffset) return copyPose(raw);
    return {
      pos: [raw.pos[0] + offPos[0], raw.pos[1] + offPos[1], raw.pos[2] + offPos[2]],
      quat: quatNorm(quatMul(offQuat, raw.quat)),
    };
  }

  function update(raw: Pose, nowMs: number): Pose {
    const dt = started && Number.isFinite(lastMs) ? Math.max(0, nowMs - lastMs) : 0;
    lastMs = nowMs;
    if (!opts.enabled) {
      started = true;
      state = "follow";
      devPosM = 0;
      devDeg = 0;
      return copyPose(raw);
    }
    if (!started) {
      // 初検出でいきなり固定しない: 最初は出力 = raw で follow
      started = true;
      enterFollow(raw, null);
    }

    if (state === "hold" && held) {
      const dPos = dist(raw.pos, held.pos);
      const dDeg = quatAngleDeg(raw.quat, held.quat);
      if (dPos > opts.snapM) {
        // 大きな飛び（再検出のスナップ・SLAM のリセット）: 即 follow、出力も即 raw
        enterFollow(raw, null);
      } else if (dPos > opts.posM || dDeg > opts.deg) {
        if (Number.isNaN(exceedSinceMs)) exceedSinceMs = nowMs;
        if (nowMs - exceedSinceMs >= opts.outMs) {
          // 閾値超えが outMs 続いた = 本当に動いた。固定姿勢との差を持ったまま follow に入り、その差を縮めて寄せる（飛ばない）
          enterFollow(raw, held);
        }
      } else {
        exceedSinceMs = NaN;
      }
      if (state === "hold" && held) {
        devPosM = dPos;
        devDeg = dDeg;
        return held;
      }
    }

    // follow
    const out = followOutput(raw, dt);
    devPosM = dist(raw.pos, out.pos);
    devDeg = quatAngleDeg(raw.quat, out.quat);
    win.push({ t: nowMs, pose: copyPose(raw) });
    // 窓は「最古の点が now − inMs 以前」を 1 点だけ残す（窓の長さが inMs 以上あるかを判定できるように）
    while (win.length >= 2 && nowMs - win[1].t >= opts.inMs) win.shift();
    if (nowMs - win[0].t >= opts.inMs) {
      const mean = meanPose(win.map((w) => w.pose));
      const still = win.every((w) => dist(w.pose.pos, mean.pos) <= opts.posM && quatAngleDeg(w.pose.quat, mean.quat) <= opts.deg);
      if (still) {
        // 窓の中心で止める（ぶれの端で止めない）
        enterHold(mean, nowMs);
        devPosM = dist(raw.pos, mean.pos);
        devDeg = quatAngleDeg(raw.quat, mean.quat);
        return mean;
      }
    }
    return out;
  }

  return {
    update,
    get state() {
      return state;
    },
    get devPosM() {
      return devPosM;
    },
    get devDeg() {
      return devDeg;
    },
    get heldSinceMs() {
      return heldSinceMs;
    },
    get info() {
      if (!opts.enabled) return "off";
      const dev = `dev=${devPosM.toFixed(3)}m/${devDeg.toFixed(1)}deg`;
      return state === "hold" ? `hold ${dev} held=${((lastMs - heldSinceMs) / 1000).toFixed(1)}s` : `follow ${dev}`;
    },
    reset() {
      state = "follow";
      started = false;
      lastMs = NaN;
      held = null;
      heldSinceMs = NaN;
      exceedSinceMs = NaN;
      offPos = [0, 0, 0];
      offQuat = [0, 0, 0, 1];
      hasOffset = false;
      win = [];
      devPosM = 0;
      devDeg = 0;
    },
  };
}
