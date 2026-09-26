// 08-9: 「静止中はアンカー（コート）を動かさない」ための状態機械。three.js に依存しない純粋な計算
// （Node の回帰テスト scripts/test-08-9-hold.mjs から直接 import する）。
//
// ■ 何をするか
//   マーカー（08-4 の board + solvePnP）と SLAM（08-7 の AlvaAR）で毎フレーム出るアンカーの姿勢（raw）を受け取り、
//   表示に使う姿勢（出力）を返す。出力は 2 つの状態を自動で切り替える:
//     hold   … 出力を固定する（raw の小さなぶれを捨てる）。raw が固定姿勢から「はっきり・しばらく」離れたら follow へ
//     follow … 出力は raw（切り替えた直後だけ、直前の出力との差を時定数 catchUpTauMs で縮めて滑らかに寄せる）。
//              raw が inMs の間ほぼ動かなければ、その区間の平均で hold へ
//   目標は「ぴったり合わせる」ではなく「数 cm ずれていても、ちょこちょこ動かない」。実機で 08-4 / 08-7 を止まって見ていると
//   数 cm の小さなぶれが残り、それが体験を悪くしていた。
//
// ■ 08-2（一度合わせて固定）との違い
//   08-2 は確定したら二度と動かさないので、歩くとコートが一緒についてきて破綻した。08-9 は raw が閾値を超えて離れ続けたら
//   自動で follow に戻り（歩き始め・マーカーでの取り直し・SLAM の追従）、止まったらまた固定する。「止める / 追従する」を自動で切り替える。
//
// ■ 各値の意味と、なぜこうしたか
//   posM / deg（既定 2cm / 2°）: 「ぶれ」と「本当の動き」の境目。hold 中の離脱の判定と、follow 中の「止まった」の判定の両方に使う。
//     観察されたぶれ（数 cm）より小さいと hold に入れず、大きいと歩き始めの遅れが増える。実機で調整する値（README の実機項目）。
//     回転は PC の合成カメラに ±1cm のノイズを入れただけで推定が 0.5〜0.9° ぶれたので、1° では実機で hold に入れない恐れが高く 2° にした
//   outMs（既定 250ms）: hold 中に離脱の閾値（posM / deg × exitRatio）超えが「連続で」この時間続いたら follow へ。1 フレームの外れ値（検出の誤り・鏡像の解・
//     SLAM の一瞬の飛び）では動かさないため。閾値内に戻ったら継続時間は 0 に戻す。代償として、歩き始めは
//     outMs + 離脱の閾値に届くまでの時間だけ出力が止まったままになる（離脱は posM × exitRatio = 3cm なので、0.5m/s なら約 16cm 遅れてから寄せ始める）
//   inMs（既定 600ms）: follow 中、直近 inMs の raw の窓が「止まっている」なら hold へ。窓が inMs に満たない（follow に入った直後）
//     うち、または窓の点が 3 個未満は判定しない。inMs より長いフレーム落ち（dt > inMs）があったら窓を作り直す
//     （古い点が 1 つ残ったまま新しい 2 点と平均されると、何秒も前の位置が固定姿勢に混ざる）。
//     「止まっている」= 窓の平均からの**ばらつきの RMS** が閾値以内:
//       位置: sqrt(Σ|p_i − p̄|² / n) ≤ posM、回転: sqrt(Σ angle(q_i, q̄)² / n) ≤ deg（angle は 2 つの回転の差の角度 [deg]）
//     全点の最大値で判定すると、実機の推定（数 cm のぶれ）では 600ms の窓に外れ値が 1 回入るだけで 600ms 入れず、follow のままになりやすい。
//     hold の維持は「閾値超えが outMs 続いたら離脱」で外れ値に強いので、入る側も外れ値 1 回で拒まない RMS にそろえた。
//     ただし RMS だけでは、ゆっくりした動きや**減速の尾**も「止まっている」になる（ノイズ無しの等速なら窓の長さ L のばらつきの RMS は
//     L/√12 なので、2cm / 600ms では約 11cm/s 以下の動きを止まっているとみなす）。そこで次の 2 つを足した（レビューで追加）:
//   driftRatio（既定 0.5）… **ドリフト条件**。窓を時刻で前半と後半に分け、それぞれの平均の差が位置 posM × driftRatio・
//     回転 deg × driftRatio 以内のときだけ hold に入る（RMS 条件と AND）。raw はマーカー検出（100ms ごと）のたびに lerp 0.5 で寄るので、
//     止まった後も 0.5 倍ずつ縮む減速の尾を引く。RMS だけだとその尾を含んだ窓で入ってしまい、固定姿勢（窓の平均）が歩いてきた側に
//     1.5〜2cm ずれた（止まった位置との差が離脱の閾値の直下になり、ノイズで hold / follow を往復した）。前半と後半の平均の差は
//     「窓の中で推定がまだ一方向に動いているか」を見るので、ノイズ（前後で打ち消す）では増えず、尾やゆっくりした動きでは増える
//   exitRatio（既定 1.5）… **離脱のヒステリシス**。hold から出る閾値は posM × exitRatio / deg × exitRatio（入る側は posM / deg）。
//     入る側が RMS ≤ posM なので、RMS が 1.5〜2cm の静止ノイズでも hold に入れるが、そのノイズは単発で posM を超えることが多い。
//     入ると出るを同じ閾値にすると、閾値の際で outMs 続けて超えるたびに follow → 再 hold を繰り返すので、出る側を広げる。
//     snapM の即離脱はそのまま
//   固定姿勢は**窓の平均**（位置は算術平均、四元数は符号を揃えて足してから正規化）。直近の 1 点で止めるとぶれの端で固まり、
//     その後のぶれが片側に偏って閾値を超えやすい。中心で止めると、同じぶれでも固定姿勢からの差が最小になる
//   snapM（既定 0.3m）: これ以上離れた raw は即 follow にし、出力も即 raw にする（寄せない）。マーカーの再検出のスナップ
//     （marker-anchor の snapDistanceM と同じ 0.3m）や SLAM のリセットで座標が大きく変わったとき、ゆっくり寄せると
//     その間ずっとずれて見えるため
//   catchUpTauMs（既定 120ms）: 状態を切り替えた直後、出力を新しい目標へ寄せる時定数。**出力そのものではなく「出力 − 目標」の差を**
//     毎フレーム exp(−dt/τ) 倍に縮める（α = 1 − exp(−dt/τ) で差を詰めるのと同じ）。
//       follow に入るとき: 目標は raw。出力そのものを raw へ lerp すると歩いている間は速度 × τ（0.5m/s で 6cm）遅れ続けるが、
//         差を縮める形なら raw の動きはそのまま通り、残るのは切り替え時の差だけ
//       hold に入るとき: 目標は固定姿勢（窓の平均）。直前の出力は窓の平均から最大 posM 程度離れているので、そのまま平均に切り替えると
//         その分だけ飛ぶ。差を持ち越して縮めるので、**hold に入った直後の数フレームは出力が固定姿勢へ滑る**（τ = 120ms なら 0.5 秒ほど）。
//         follow の寄せの差が残ったまま止まったとき（?holdTau=1000 など）も同じく飛ばない
//     差が 1mm / 0.05° 未満になったら差を 0 にする（follow では出力 = raw、hold では出力 = 固定姿勢で以後一切変えない）
//   時間はすべて nowMs（ms）で数える（フレームレートに依存しない）。nowMs が戻ることは無い前提で、dt ≤ 0 は 0 として扱う
//   raw に非有限の値（NaN など）が混ざったフレームは無視する（状態も時刻も進めず、直前の出力を返す。最初のフレームなら単位姿勢）
import type { Pose, Quat, V3 } from "./slam-fusion";

export type AnchorHoldOptions = {
  /** false なら update は raw をそのまま返す（?hold=0。経路は同じにして比較する） */
  enabled: boolean;
  /** 止める判定の位置の閾値 [m] */
  posM: number;
  /** 止める判定の回転の閾値 [deg] */
  deg: number;
  /** hold に入るとき、窓の前半と後半の平均の差を posM × driftRatio / deg × driftRatio 以内に求める（減速の尾・ゆっくりした動きで入らない） */
  driftRatio: number;
  /** hold から出る閾値の倍率（posM × exitRatio / deg × exitRatio。入る側より広げて閾値の際で往復しない） */
  exitRatio: number;
  /** hold 中、閾値超えがこの時間続いたら follow へ [ms] */
  outMs: number;
  /** follow 中、raw がこの時間ほぼ動かなかったら hold へ [ms] */
  inMs: number;
  /** これ以上離れた raw は即 follow（+ 出力も即 raw）[m] */
  snapM: number;
  /** 状態を切り替えた直後、出力が目標（follow では raw、hold では固定姿勢）に追いつく時定数 [ms] */
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
  deg: 2.0,
  driftRatio: 0.5,
  exitRatio: 1.5,
  outMs: 250,
  inMs: 600,
  snapM: 0.3,
  catchUpTauMs: 120,
};

/** 追いついたとみなす差（これ未満なら差を 0 にする） */
const CAUGHT_UP_M = 0.001;
const CAUGHT_UP_DEG = 0.05;
/** hold に入る判定に要る窓の点の最小数（長いフレーム落ちの後の 2 点で止めない） */
const MIN_WINDOW_POINTS = 3;

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

/**
 * 2 つの回転の差の角度 [deg]（q と −q は同じ回転）。相対回転 r = a⁻¹·b の 2·atan2(|r.xyz|, |r.w|)。
 * acos(|a·b|) より 0 付近の分解能が良く、内積の丸めで 1 を超えても NaN にならない
 */
export function quatAngleDeg(a: Quat, b: Quat): number {
  const r = quatMul(quatConj(a), b);
  return (2 * Math.atan2(Math.hypot(r[0], r[1], r[2]), Math.abs(r[3])) * 180) / Math.PI;
}

/** 単位四元数 → 回転ベクトル（軸 × 角度 [rad]）。短い側（w ≥ 0）で出す */
function quatToRotVec(q: Quat): V3 {
  const s = q[3] < 0 ? -1 : 1;
  const x = q[0] * s;
  const y = q[1] * s;
  const z = q[2] * s;
  const sinHalf = Math.hypot(x, y, z);
  if (sinHalf < 1e-12) return [0, 0, 0];
  const angle = 2 * Math.atan2(sinHalf, q[3] * s);
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

function isFinitePose(p: Pose): boolean {
  return p.pos.every(Number.isFinite) && p.quat.every(Number.isFinite);
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

/** 平均からのばらつきの RMS（位置 [m] と回転 [deg]） */
export function spreadRms(poses: readonly Pose[], mean: Pose): { posM: number; deg: number } {
  let sp = 0;
  let sd = 0;
  for (const p of poses) {
    sp += dist(p.pos, mean.pos) ** 2;
    sd += quatAngleDeg(p.quat, mean.quat) ** 2;
  }
  return { posM: Math.sqrt(sp / poses.length), deg: Math.sqrt(sd / poses.length) };
}

/** 「出力 − 目標」の差（位置はワールドのベクトル、回転は out = quat · target の quat）。exp(−dt/τ) で縮める */
type Offset = { pos: V3; quat: Quat };

function offsetBetween(from: Pose, to: Pose): Offset {
  return {
    pos: [from.pos[0] - to.pos[0], from.pos[1] - to.pos[1], from.pos[2] - to.pos[2]],
    quat: quatNorm(quatMul(from.quat, quatConj(to.quat))),
  };
}

/** 差を dt だけ縮める。十分小さくなったら null（差 0） */
function decayOffset(off: Offset, dt: number, tauMs: number): Offset | null {
  const k = tauMs > 0 ? Math.exp(-dt / tauMs) : 0;
  const rv = quatToRotVec(off.quat);
  const next: Offset = { pos: [off.pos[0] * k, off.pos[1] * k, off.pos[2] * k], quat: rotVecToQuat([rv[0] * k, rv[1] * k, rv[2] * k]) };
  const m = Math.hypot(next.pos[0], next.pos[1], next.pos[2]);
  const d = quatAngleDeg(next.quat, [0, 0, 0, 1]);
  return m < CAUGHT_UP_M && d < CAUGHT_UP_DEG ? null : next;
}

function applyOffset(target: Pose, off: Offset): Pose {
  return {
    pos: [target.pos[0] + off.pos[0], target.pos[1] + off.pos[1], target.pos[2] + off.pos[2]],
    quat: quatNorm(quatMul(off.quat, target.quat)),
  };
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
  /** 「出力 − 目標」の差（follow では目標 = raw、hold では目標 = held）。null なら差 0 */
  let off: Offset | null = null;
  /** 直近の出力 */
  let lastOut: Pose | null = null;
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
    off = from ? offsetBetween(from, raw) : null;
  }

  function enterHold(mean: Pose, currentOut: Pose, nowMs: number) {
    state = "hold";
    held = mean;
    heldSinceMs = nowMs;
    exceedSinceMs = NaN;
    win = [];
    // いまの出力と固定姿勢の差を持ち越し、hold 中に縮める（入る瞬間に飛ばない）
    off = offsetBetween(currentOut, mean);
    if (dist(off.pos, [0, 0, 0]) < CAUGHT_UP_M && quatAngleDeg(off.quat, [0, 0, 0, 1]) < CAUGHT_UP_DEG) off = null;
  }

  /** ドリフト条件: 窓を時刻で前半・後半に分け、それぞれの平均の差が posM × driftRatio / deg × driftRatio 以内か */
  function driftWithin(w: readonly { t: number; pose: Pose }[], nowMs: number): boolean {
    const half = w[0].t + (nowMs - w[0].t) / 2;
    const first = w.filter((p) => p.t < half).map((p) => p.pose);
    const second = w.filter((p) => p.t >= half).map((p) => p.pose);
    if (first.length === 0 || second.length === 0) return false;
    const m1 = meanPose(first);
    const m2 = meanPose(second);
    return dist(m1.pos, m2.pos) <= opts.posM * opts.driftRatio && quatAngleDeg(m1.quat, m2.quat) <= opts.deg * opts.driftRatio;
  }

  function finish(out: Pose, raw: Pose): Pose {
    devPosM = dist(raw.pos, out.pos);
    devDeg = quatAngleDeg(raw.quat, out.quat);
    lastOut = out;
    return out;
  }

  function update(raw: Pose, nowMs: number): Pose {
    if (!isFinitePose(raw) || !Number.isFinite(nowMs)) {
      // 非有限の raw は無視する（hold の継続時間・窓・時刻を進めない）
      return lastOut ?? { pos: [0, 0, 0], quat: [0, 0, 0, 1] };
    }
    const dt = started && Number.isFinite(lastMs) ? Math.max(0, nowMs - lastMs) : 0;
    lastMs = nowMs;
    if (!opts.enabled) {
      started = true;
      state = "follow";
      devPosM = 0;
      devDeg = 0;
      lastOut = copyPose(raw);
      return lastOut;
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
      } else if (dPos > opts.posM * opts.exitRatio || dDeg > opts.deg * opts.exitRatio) {
        if (Number.isNaN(exceedSinceMs)) exceedSinceMs = nowMs;
        if (nowMs - exceedSinceMs >= opts.outMs) {
          // 閾値超えが outMs 続いた = 本当に動いた。直前の出力との差を持ったまま follow に入り、その差を縮めて寄せる（飛ばない）
          enterFollow(raw, lastOut ?? held);
        }
      } else {
        exceedSinceMs = NaN;
      }
      if (state === "hold" && held) {
        if (off) off = decayOffset(off, dt, opts.catchUpTauMs);
        // 差が消えたら固定姿勢そのもの（同じオブジェクト）を返し続ける = 以後一切変わらない
        return finish(off ? applyOffset(held, off) : held, raw);
      }
    }

    // follow
    if (off) off = decayOffset(off, dt, opts.catchUpTauMs);
    const out = off ? applyOffset(raw, off) : copyPose(raw);
    // inMs より長いフレーム落ちの後は窓を作り直す（何秒も前の点を平均に混ぜない）
    if (dt > opts.inMs) win = [];
    win.push({ t: nowMs, pose: copyPose(raw) });
    // 窓は「最古の点が now − inMs 以前」を 1 点だけ残す（窓の長さが inMs 以上あるかを判定できるように）
    while (win.length >= 2 && nowMs - win[1].t >= opts.inMs) win.shift();
    if (nowMs - win[0].t >= opts.inMs && win.length >= MIN_WINDOW_POINTS) {
      const poses = win.map((w) => w.pose);
      const mean = meanPose(poses);
      const rms = spreadRms(poses, mean);
      if (rms.posM <= opts.posM && rms.deg <= opts.deg && driftWithin(win, nowMs)) {
        // 窓の中心で止める（ぶれの端で止めない）。このフレームの出力は follow のままの out（差を持ち越すので飛ばない）
        enterHold(mean, out, nowMs);
      }
    }
    return finish(out, raw);
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
      off = null;
      lastOut = null;
      win = [];
      devPosM = 0;
      devDeg = 0;
    },
  };
}
