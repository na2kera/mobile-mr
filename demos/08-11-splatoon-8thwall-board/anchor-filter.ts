// 08-11: コート（アンカー）のワールド姿勢の「窓平均フィルタ」。three.js に依存しない純粋な計算
// （Node の単体テスト scripts/test-08-11-board.mjs から直接 import する。Node 22.18+ は .ts をそのまま読める）。
//
// ■ 何をするか
//   8th Wall のワールド座標系では、壁に貼ったマーカー（= コートの原点）の姿勢は時間によらず一定のはず。
//   そこで OpenCV の board + solvePnP が出す「1 回ごとの観測（カメラ姿勢 × PnP の結果 = コートのワールド姿勢）」を
//   直近の短い窓に貯め、外れ値を除いて平均したものを「目標」にする。08-4 の lerp（前回の表示と観測の内分）は観測のノイズが
//   半分ずつ残って「止まって見ていても数 cm ぶれる」ので、平均で √N 分の 1 に抑えるのが狙い。
//   少し動いたときは 8th Wall がカメラを動かすので、コートはワールドに留まったまま（観測が無い間も目標を保持する）。
//
// ■ 2 段: 目標（add で観測ごとに更新）と表示（step で毎フレーム目標へ寄せる）
//   add(obs, canSnap)  … 観測を入れて目標を更新する
//   step(canSnap)      … 毎フレーム呼ぶ。表示を目標へ寄せる。canSnap（発射後 300ms を過ぎた）なら目標そのまま、
//                        false（連射中）なら 1 フレームあたり最大 maxStepM・maxStepDeg だけ寄せる（設計の追補 A3）。
//                        発射の向きが飛ばないように、作り直し・初回・配置変更・LIMITED の直接モードなど、どの経路の変化にも掛かる。
//                        表示が無い（再ロック直後。発射できない状態）ときは制限なしで目標に合わせる
//
// ■ モード
//   avg（既定。?avg=1）
//     - 8th Wall が NORMAL の観測は窓に入れる。窓は直近 windowMs かつ最大 maxN 件
//     - 推定: 位置は各軸の中央値を基準、回転は半球をそろえた四元数の正規化平均を基準にして、
//       位置が max(k·σ_pos, minOutlierPosM) を超える、または回転が max(k·σ_rot, minOutlierDeg) を超える観測を外れ値として除き
//       （位置と回転は同じ観測単位で採否する）、残りで平均し直す。0 のときは下限値が効く。
//       σ_pos = median(基準からの 3D 距離) / 1.538（各軸 σ の正規分布なら 3D 距離はマクスウェル分布で、その中央値が 1.538σ。
//       1.4826 を掛けると 3σ のつもりが実質 6.8σ になっていた。レビュー R6）、σ_rot = 1.4826 × median(基準からの角度)
//     - 窓が MIN_WINDOW 件（3）に満たない間は中央値も σ も当てにならない（1〜2 件の平均に鏡像解などの外れ値が 1 件入るだけで
//       25cm・15° 動く。レビュー R1）ので、基準は「いまの目標」にして、目標から reseedPosM / reseedDeg 以上離れた観測は窓に入れず
//       作り直しの候補として数えるだけにする。目標は窓が 3 件そろうまで書き換えない。
//       目標が無いとき（初回・invalidate 後の再ロック）だけは 1 件目で目標を作る（再ロックを遅らせない）
//     - 空白の後（前回の観測から windowMs を超えた・配置変更・直接モードの後）の最初の観測は「再取得」（reacquire）: 目標は保持したまま
//       新しい窓を始め、保持していた目標と最初の観測の差を lastReacquire に残す（歩いて戻ったときのずれの実測値。レビュー R2）。
//       空白は窓の件数ではなく時間で判定し、遠くて窓に入れなかった観測でも lastObsMs を進める（件数で判定すると、遠い観測のたびに
//       再取得がやり直されて作り直しの候補が捨てられ、目標が永遠に固着した。再レビュー S1）
//     - 固着の保険: 窓が 3 件未満の状態が windowMs 続き、直近 windowMs の観測のうち目標から遠い観測が 3 件以上かつ過半数なら、
//       まとまりの条件なしでその間の観測の平均で作り直す（二峰なら全体の平均 = 中間、そうでなければ頑健な平均。fallbackReseeds。
//       再レビュー S2・最終レビュー T2 / T4）
//     - 作り直しの候補が二峰（2 解が交互に出るなど）なら作り直さない（bimodalRejected。二峰の判定は bimodalSplit）。
//       まとまりの上限は候補の平均のずれに合わせて緩める（位置 max(5cm, ずれ/2)・回転 max(5°, ずれ/2)。T1）
//     - 窓が二峰なら、片方の群が 6 割以上ならその群、そうでなければ全体の平均（中間）。いったん選んだ群は 3 割を切るまで選び続ける。
//       二峰でなければ各軸の中央値を基準にした頑健な平均。ただし別解が一時的に増えて中央値の側の推定が目標の周りの推定と食い違ったら、
//       目標の周り（支持 3 割以上）を採る（別解へ飛び移る・混ざった平均に落ち着くのを防ぐ。再レビュー S5・最終レビュー T3）
//     - 持続的なずれで窓を作り直す: 推定から reseedPosM 以上 / reseedDeg 以上離れた観測が連続 reseedN 件、
//       または連続 reseedMinN 件以上かつ reseedMs 以上続き、**かつ候補どうしがまとまっている**（候補の平均が目標から閾値以上離れ、
//       候補の平均からのばらつきの RMS が閾値の半分未満。ノイズが大きいだけで作り直して 7〜12cm 飛ぶのを防ぐ。レビュー R5）なら、
//       窓をその候補で作り直す（8th Wall のドリフトや再推定の段差に追従する。全履歴の平均は古い座標系に引かれるので使わない）
//     - 頭を速く回している間の観測（fastMotion。main.ts が 8th Wall の姿勢の角速度で判定）は、映像とカメラ姿勢の時刻ずれで
//       同じ向きに偏りうるので使わない（ignored に数える。レビュー R7）
//     - LIMITED（NORMAL でない）中の観測は姿勢が信用できないので窓にも表示にも使わない（一瞬の LIMITED ではコートを動かさない。追補 A5）。
//       LIMITED が limitedDirectMs 以上続いている間に観測が来たら「直接モード」に入り、窓を空にして、目標を 08-4 と同じ lerp で
//       生の観測に寄せる（マーカーが見えている間は「カメラ × マーカー」で表示が正しくなるため）。
//       直接モードから NORMAL に戻ったら新しい窓を始める。limitedDirectMs 未満で NORMAL に戻ったら窓はそのまま続ける
//   lerp（?avg=0。比較用）: 08-4 と同じ。目標 = 表示で、観測ごとに smooth で lerp、前回の観測から resnapAfterMs 超・snapDistanceM 超は
//     スナップ（ただし連射中 canSnap=false ならスナップしない）。08-4 との比較が崩れないよう step の制限は掛けない
//
// ■ 観測が無い間は目標も表示も最後のまま（ワールドに留まる = 8th Wall がコートを運ぶ）

export type Vec3T = [number, number, number];
export type QuatT = [number, number, number, number];
export type PoseT = { pos: Vec3T; quat: QuatT };

/**
 * 採用された観測（ワールド座標）。xrNormal は「その時 8th Wall が NORMAL だったか」、
 * limitedMs は NORMAL でない状態がその時点で何 ms 続いているか（NORMAL なら 0）
 */
export type AnchorObservation = { tMs: number; pos: Vec3T; quat: QuatT; xrNormal: boolean; limitedMs?: number; fastMotion?: boolean };

/** 目標を窓から作り直すのに要る件数（これ未満の窓では中央値・σ が当てにならない） */
export const MIN_WINDOW = 3;

export type AnchorFilterOptions = {
  /** avg（窓平均）か lerp（08-4 と同じ） */
  mode: "avg" | "lerp";
  /** 窓の長さ [ms]（?avgWindowMs=） */
  windowMs: number;
  /** 窓の最大件数（?avgMaxN=） */
  maxN: number;
  /** 持続的なずれとみなす連続件数（?avgReseedN=） */
  reseedN: number;
  /** 持続的なずれ: 件数が reseedN に満たなくても、この件数以上かつ reseedMs 以上続いたら作り直す */
  reseedMinN: number;
  /** 同上の時間 [ms] */
  reseedMs: number;
  /** 持続的なずれの距離 [m] */
  reseedPosM: number;
  /** 持続的なずれの角度 [deg] */
  reseedDeg: number;
  /** 外れ値の判定: σ（MAD × 1.4826）の何倍を超えたら外れ値か */
  outlierK: number;
  /** 外れ値の判定の下限 [m]（ノイズが小さいとき σ が 0 に近くなり、普通の観測まで捨てないように） */
  minOutlierPosM: number;
  /** 外れ値の判定の下限 [deg] */
  minOutlierDeg: number;
  /** LIMITED がこれ以上続いている間の観測で直接モードに入る [ms]（?limitedDirectMs=） */
  limitedDirectMs: number;
  /** lerp の係数（08-4 の ?smooth=。直接モードと lerp モードの目標の寄せ方） */
  smooth: number;
  /** 前回の観測からこれ以上空いたらスナップ（08-4 と同じ 2000ms） */
  resnapAfterMs: number;
  /** 目標と観測の距離がこれ以上ならスナップ（08-4 と同じ 0.3m） */
  snapDistanceM: number;
  /** 連射中（canSnap=false）に表示を 1 フレームで寄せる上限 [m] */
  maxStepM: number;
  /** 同上 [deg] */
  maxStepDeg: number;
};

export const DEFAULT_ANCHOR_FILTER: AnchorFilterOptions = {
  mode: "avg",
  windowMs: 3000,
  maxN: 40,
  reseedN: 5,
  reseedMinN: 3,
  reseedMs: 1000,
  reseedPosM: 0.1,
  reseedDeg: 5,
  outlierK: 3,
  minOutlierPosM: 0.02,
  minOutlierDeg: 2,
  limitedDirectMs: 1000,
  smooth: 0.5,
  resnapAfterMs: 2000,
  snapDistanceM: 0.3,
  maxStepM: 0.005,
  maxStepDeg: 0.3,
};

/** いまの目標の出どころ: avg = 窓平均、direct = LIMITED が続いているので生の観測へ lerp、lerp = ?avg=0 */
export type AnchorFilterMode = "avg" | "direct" | "lerp";

/**
 * add() が何をしたか: init = 新しい窓を始めた（初回・直接モードの後・長い空白の後・clearWindow の後）、reseed = 作り直し、
 * update = 窓に足した、ignored = 短い LIMITED 中なので使わなかった、direct = 直接モードで目標を寄せた、lerp = ?avg=0
 */
export type AnchorFilterEvent = "init" | "reacquire" | "reseed" | "update" | "ignored" | "fast" | "direct" | "lerp";

/** 空白の後の再取得（reacquire）の記録: 最初の観測と、保持していた目標との差 */
export type AnchorReacquire = { tMs: number; gapMs: number; residualMm: number; residualDeg: number; reason: "gap" | "layout" | "direct" };

export type AnchorFilterStats = {
  mode: AnchorFilterMode;
  /** 窓の件数 */
  n: number;
  /** 位置のばらつき（窓の採用した観測の推定からの RMS）[mm] */
  spreadMm: number;
  /** 回転のばらつき（同じく RMS）[deg] */
  spreadDeg: number;
  /** 直近の観測の、それを入れる前の目標からの残差 [mm] */
  residualMm: number;
  /** 同じく [deg] */
  residualDeg: number;
  /** 窓の作り直しの回数 */
  reseeds: number;
  /** 外れ値として捨てた観測の数（観測を入れた時点で、その観測自身が外れ値だった回数） */
  outliers: number;
  /** 短い LIMITED 中なので使わなかった観測の数 */
  ignored: number;
  /** 頭を速く回している（または角速度が未測定の）間なので使わなかった観測の数（fast=。レビュー R7・再レビュー S4 / S6） */
  fast: number;
  /** 窓が 3 件未満のまま windowMs 続いたので、まとまりの条件なしで作り直した回数（固着の保険。再レビュー S2） */
  fallbackReseeds: number;
  /** 作り直しの候補が二峰（2 つの群に分かれている）なので見送った回数（再レビュー S5） */
  bimodalRejected: number;
  /** 直接モードに入った回数 */
  directEntries: number;
  /** 表示が目標に追いついていない（連射中の制限で寄せている最中） */
  catchingUp: boolean;
  /** 窓が 3 件未満の間に、目標から離れていて窓に入れなかった観測の数 */
  heldOut: number;
  /** 作り直しの条件（件数・時間）は満たしたが、候補がまとまっていないので作り直さなかった回数 */
  reseedRejected: number;
};

export type AnchorFilter = {
  add(obs: AnchorObservation, canSnap: boolean): AnchorFilterEvent;
  /** 毎フレーム呼ぶ。表示を目標へ寄せて返す（目標が無ければ null） */
  step(canSnap: boolean): PoseT | null;
  /** 窓だけ捨てる（追加マーカーの配置が変わったとき。追補 A7）。表示と目標は残し、次の観測で新しい窓を始める */
  clearWindow(): void;
  /** 原点が変わったとき（向き変更・投影更新・タブ復帰など）。目標・表示・窓を捨てる（作り直し回数などの累計は残す） */
  reset(): void;
  readonly target: PoseT | null;
  readonly display: PoseT | null;
  readonly stats: AnchorFilterStats;
  readonly lastReacquire: AnchorReacquire | null;
  readonly options: Readonly<AnchorFilterOptions>;
};

// ---- 小さな数学（three を使わない） ----

export function distV3(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** 2 つの回転の差の角度 [deg]（q と -q は同じ回転） */
export function quatAngleDeg(a: readonly number[], b: readonly number[]): number {
  const d = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  return (2 * Math.acos(Math.min(1, d)) * 180) / Math.PI;
}

function normalizeQuat(q: readonly number[]): QuatT {
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** 半球を ref にそろえた四元数の正規化平均 */
export function meanQuat(qs: readonly (readonly number[])[], ref: readonly number[]): QuatT {
  const sum = [0, 0, 0, 0];
  for (const q of qs) {
    const s = q[0] * ref[0] + q[1] * ref[1] + q[2] * ref[2] + q[3] * ref[3] < 0 ? -1 : 1;
    for (let i = 0; i < 4; i++) sum[i] += s * q[i];
  }
  return normalizeQuat(sum);
}

function lerpV3(a: readonly number[], b: readonly number[], t: number): Vec3T {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** 球面線形補間（短い経路。three の Quaternion.slerp と同じ考え方） */
export function slerpQuat(a: readonly number[], b: readonly number[], t: number): QuatT {
  let [bx, by, bz, bw] = b;
  let cos = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (cos < 0) {
    cos = -cos;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  if (cos > 0.9995) {
    return normalizeQuat([a[0] + (bx - a[0]) * t, a[1] + (by - a[1]) * t, a[2] + (bz - a[2]) * t, a[3] + (bw - a[3]) * t]);
  }
  const theta = Math.acos(cos);
  const sin = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / sin;
  const wb = Math.sin(t * theta) / sin;
  return normalizeQuat([a[0] * wa + bx * wb, a[1] * wa + by * wb, a[2] * wa + bz * wb, a[3] * wa + bw * wb]);
}

/** MAD（中央値からの距離の中央値）を正規分布の標準偏差に換算する係数 */
export const MAD_TO_SIGMA = 1.4826;
/** 各軸 σ の等方正規分布の 3D 距離（マクスウェル分布）の中央値 ÷ σ。位置の σ は median(3D 距離) / これ */
export const DIST3_MEDIAN_TO_SIGMA = 1.538;
/** 同じく下位 3 割の値 ÷ σ（マクスウェル分布の 30 パーセンタイル） */
export const DIST3_Q30_TO_SIGMA = 1.2;

/** 小さい方から割合 frac の位置の値 */
function sortedAt(values: readonly number[], frac: number): number {
  const s = [...values].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(frac * (s.length - 1))))];
}

type Robust = { pos: Vec3T; quat: QuatT; inlier: boolean[]; spreadMm: number; spreadDeg: number; bimodal: boolean; chosen: PoseT | null };

/** 窓の観測から外れ値を除いた平均（位置・回転のどちらかで外れた観測は両方から除く。追補 A6） */
/** 観測の平均（位置は算術平均、回転は半球をそろえた正規化平均） */
function plainMean(obs: readonly { pos: readonly number[]; quat: readonly number[] }[]): { pos: Vec3T; quat: QuatT } {
  const pos: Vec3T = [0, 0, 0];
  for (const w of obs) for (let i = 0; i < 3; i++) pos[i] += w.pos[i] / obs.length;
  return { pos, quat: meanQuat(obs.map((w) => w.quat), obs[0].quat) };
}

/**
 * 窓の頑健な平均（最終レビュー T3）。
 * - 窓が二峰でなければ: 位置は各軸の中央値、回転は正規化平均を基準に、位置が max(k·σ_pos, minOutlierPosM) を超える、または回転が
 *   max(k·σ_rot, minOutlierDeg) を超える観測を外れ値として除いた平均（位置と回転は同じ観測単位で採否する）。
 *   ただし current（いまの目標）の周りに同じ閾値で 3 割以上の観測があれば、そちらの平均（ヒステリシス）
 * - 窓が二峰なら（2 解が交互に出るなど）: 片方の群が BIMODAL_MAJORITY（6 割）以上ならその群の平均、そうでなければ全体の平均（中間）。
 *   ヒステリシス: 前回その群を選んでいて（prefer = 前回選んだ群の平均。それに近い方の群を「いまの群」とする）、いまの群が 3 割以上なら
 *   選び続ける。割合が 6 割の際で揺れると「群の平均」と「全体の平均」が入れ替わって目標が数 cm 往復した（Fable の sim-mix で 30%@15cm が最悪 63mm）ため
 *   各軸の中央値は二峰の窓で多数派の群へ 1 件ごとに飛び移り、MAD も 0 に潰れて目標が観測ごとに往復した（再レビュー S5）ため。
 *   S5 の修正で基準を常に「いまの目標」にしたところ、中程度の距離の別解が混ざると混ざった平均で安定してしまった（30% が 4cm 先で
 *   最悪 17mm）ので、二峰でないときは中央値の基準に戻した
 */
export function robustMean(
  win: readonly { pos: readonly number[]; quat: readonly number[] }[],
  o: Pick<AnchorFilterOptions, "outlierK" | "minOutlierPosM" | "minOutlierDeg" | "reseedPosM" | "reseedDeg">,
  prefer: PoseT | null = null,
  current: PoseT | null = null,
): Robust {
  const bi = bimodalSplit(win, o.reseedPosM / 2, o.reseedDeg / 2);
  let src: { pos: readonly number[]; quat: readonly number[] }[];
  let inlier: boolean[];
  let chosen: PoseT | null = null;
  if (bi) {
    const ma = plainMean(bi.ga.map((i) => win[i]));
    const mb = plainMean(bi.gb.map((i) => win[i]));
    let use: number[] | null = null;
    if (prefer) {
      // 前回選んだ群に近い方（1° ≒ 1cm として位置と回転の差を足す）が 3 割以上なら選び続ける
      const cost = (m: PoseT) => distV3(m.pos, prefer.pos) + quatAngleDeg(m.quat, prefer.quat) * 0.01;
      const inc = cost(ma) <= cost(mb) ? bi.ga : bi.gb;
      if (inc.length >= KEEP_SUPPORT * win.length) use = inc;
    }
    if (!use) {
      const big = bi.ga.length >= bi.gb.length ? bi.ga : bi.gb;
      if (big.length >= BIMODAL_MAJORITY * win.length) use = big;
    }
    const set = use ? new Set(use) : null;
    inlier = win.map((_, i) => (set ? set.has(i) : true));
    src = win.filter((_, i) => inlier[i]);
    if (set) chosen = plainMean(src);
  } else {
    const center: readonly number[] = [median(win.map((w) => w.pos[0])), median(win.map((w) => w.pos[1])), median(win.map((w) => w.pos[2]))];
    const d = win.map((w) => distV3(w.pos, center));
    const posLimit = Math.max((o.outlierK * median(d)) / DIST3_MEDIAN_TO_SIGMA, o.minOutlierPosM);
    const base = meanQuat(win.map((w) => w.quat), win[0].quat);
    const a = win.map((w) => quatAngleDeg(w.quat, base));
    const rotLimit = Math.max(o.outlierK * MAD_TO_SIGMA * median(a), o.minOutlierDeg);
    inlier = win.map((_, i) => d[i] <= posLimit && a[i] <= rotLimit);
    if (current) {
      // ヒステリシス: 同じ閾値でいまの目標の周りに 3 割以上の観測があれば、そちらを採る。各軸の中央値は別解が一時的に過半数になると
      // そちらへ飛び移る（30% が 4cm 先の混ざり方で 1cm 超の変化が 61 回）。閾値は中央値の側のまま（目標の周りで閾値を測り直すと、
      // 混ざった平均に落ち着いてしまった。最終レビュー T3）
      // 目標の周りの閾値は、目標からの距離の下位 3 割（= いまの解のノイズの大きさ）から測る。中央値の側の閾値を使うと、別解が一時的に
      // 半分近くになったとき閾値が 2 つの解を覆うほど広がり、混ざった平均に落ち着いた（30% が 4cm 先で最悪 23mm）
      const dc = win.map((w) => distV3(w.pos, current.pos));
      const ac = win.map((w) => quatAngleDeg(w.quat, current.quat));
      const q = (v: number[]) => sortedAt(v, KEEP_SUPPORT);
      const curPosLimit = Math.max((o.outlierK * q(dc)) / DIST3_Q30_TO_SIGMA, o.minOutlierPosM);
      const curRotLimit = Math.max((o.outlierK * q(ac)) / DIST3_Q30_TO_SIGMA, o.minOutlierDeg);
      const nearCurrent = win.map((_, i) => dc[i] <= curPosLimit && ac[i] <= curRotLimit);
      // 普段のノイズでは中央値の側（偏りの無い推定）をそのまま使う。中央値の側の平均と目標の周りの平均が閾値の半分以上食い違う（別解へ
      // 飛び移る・混ざる）ときだけ、目標の周りを採る（目標の周りだけを毎回使うとノイズの裾を切って目標に張り付き、ヨー ±2° の一様ノイズで
      // 変動が増えた。「中央値の側が目標から離れたか」で見ると、1 件ずつ少しずつ混ざった平均へ歩いていった）
      const selA = win.filter((_, i) => inlier[i]);
      const selB = win.filter((_, i) => nearCurrent[i]);
      if (selA.length > 0 && selB.length >= KEEP_SUPPORT * win.length) {
        const mA = plainMean(selA);
        const mB = plainMean(selB);
        if (distV3(mA.pos, mB.pos) > curPosLimit / 2 || quatAngleDeg(mA.quat, mB.quat) > curRotLimit / 2) inlier = nearCurrent;
      }
    }
    src = win.filter((_, i) => inlier[i]);
    // 全部が外れ値（2 件で割れた等）なら全件で平均する（推定を失わない）
    if (src.length === 0) src = [...win];
  }
  const { pos, quat } = plainMean(src);
  const spreadMm = Math.sqrt(src.reduce((s, w) => s + distV3(w.pos, pos) ** 2, 0) / src.length) * 1000;
  const spreadDeg = Math.sqrt(src.reduce((s, w) => s + quatAngleDeg(w.quat, quat) ** 2, 0) / src.length);
  return { pos, quat, inlier, spreadMm, spreadDeg, bimodal: bi !== null, chosen };
}

function clonePose(p: { pos: readonly number[]; quat: readonly number[] }): PoseT {
  return { pos: [p.pos[0], p.pos[1], p.pos[2]], quat: [p.quat[0], p.quat[1], p.quat[2], p.quat[3]] };
}

/** 表示を目標へ、1 回あたり最大 maxM・maxDeg だけ寄せる */
export function stepToward(from: PoseT, to: PoseT, maxM: number, maxDeg: number): PoseT {
  const d = distV3(from.pos, to.pos);
  const pos = d <= maxM ? ([...to.pos] as Vec3T) : lerpV3(from.pos, to.pos, maxM / d);
  const ang = quatAngleDeg(from.quat, to.quat);
  const quat = ang <= maxDeg ? ([...to.quat] as QuatT) : slerpQuat(from.quat, to.quat, maxDeg / ang);
  return { pos, quat };
}

/**
 * 観測の集まりが二峰なら 2 つの群（添字）を返す（再レビュー S5・最終レビュー T1）。無ければ null。
 * 最も離れた 2 件を種にして近い方へ割り当て（2-means の 1 回目）、両方に 2 件以上あり、群の中心が minSepM（位置）/ minSepDeg（回転）以上、
 * かつ群の中のばらつき（RMS）の 4 倍を超えて離れ、かつ 2 群を結ぶ軸の上で群の間に離れの 1/4 以上の隙間があれば二峰とする。2 倍だと 5 件程度の 1 つの塊でも偶然この条件を満たし
 * （位置 2cm・回転 1.5° のノイズで 57% 誤判定）、4 倍で誤判定 1〜3%・本物の二峰（8cm・10°）の検出 97〜100%（Fable の検証）。
 * 例: 目標から 11cm と 19cm の観測が交互に出る（鏡像解などの 2 解が入れ替わる）列
 */
export function bimodalSplit(cand: readonly { pos: readonly number[]; quat: readonly number[] }[], minSepM: number, minSepDeg: number): { ga: number[]; gb: number[] } | null {
  if (cand.length < 4) return null;
  const split = (dist: (i: number, j: number) => number) => {
    let a = 0;
    let b = 1;
    let best = -1;
    for (let i = 0; i < cand.length; i++) {
      for (let j = i + 1; j < cand.length; j++) {
        const dd = dist(i, j);
        if (dd > best) {
          best = dd;
          a = i;
          b = j;
        }
      }
    }
    const ga: number[] = [];
    const gb: number[] = [];
    for (let i = 0; i < cand.length; i++) (dist(i, a) <= dist(i, b) ? ga : gb).push(i);
    return { ga, gb };
  };
  // 位置
  {
    const g = split((i, j) => distV3(cand[i].pos, cand[j].pos));
    if (g.ga.length >= 2 && g.gb.length >= 2) {
      const mean = (idx: number[]) => [0, 1, 2].map((k) => idx.reduce((acc, i) => acc + cand[i].pos[k], 0) / idx.length);
      const ca = mean(g.ga);
      const cb = mean(g.gb);
      const sep = distV3(ca, cb);
      const within = Math.sqrt([...g.ga.map((i) => distV3(cand[i].pos, ca) ** 2), ...g.gb.map((i) => distV3(cand[i].pos, cb) ** 2)].reduce((x, y) => x + y, 0) / cand.length);
      // 2 群を結ぶ軸に射影したときの群の間の隙間（一様・正規の 1 つの塊は隙間がほぼ 0）
      const axis = sep > 0 ? [0, 1, 2].map((k) => (cb[k] - ca[k]) / sep) : [1, 0, 0];
      const x = (i: number) => [0, 1, 2].reduce((acc, k) => acc + (cand[i].pos[k] - ca[k]) * axis[k], 0);
      const gap = Math.min(...g.gb.map(x)) - Math.max(...g.ga.map(x));
      if (sep >= minSepM && sep > BIMODAL_SEP_RATIO * within && gap >= BIMODAL_GAP_RATIO * sep) return g;
    }
  }
  // 回転
  {
    const g = split((i, j) => quatAngleDeg(cand[i].quat, cand[j].quat));
    if (g.ga.length >= 2 && g.gb.length >= 2) {
      const qa = meanQuat(g.ga.map((i) => cand[i].quat), cand[g.ga[0]].quat);
      const qb = meanQuat(g.gb.map((i) => cand[i].quat), cand[g.gb[0]].quat);
      const sep = quatAngleDeg(qa, qb);
      const within = Math.sqrt([...g.ga.map((i) => quatAngleDeg(cand[i].quat, qa) ** 2), ...g.gb.map((i) => quatAngleDeg(cand[i].quat, qb) ** 2)].reduce((x, y) => x + y, 0) / cand.length);
      // 2 群の平均の間の「どちら寄りか」（角度の差の半分）で 1 次元に並べたときの群の間の隙間
      const x = (i: number) => (quatAngleDeg(cand[i].quat, qa) - quatAngleDeg(cand[i].quat, qb)) / 2;
      const gap = Math.min(...g.gb.map(x)) - Math.max(...g.ga.map(x));
      if (sep >= minSepDeg && sep > BIMODAL_SEP_RATIO * within && gap >= BIMODAL_GAP_RATIO * sep) return g;
    }
  }
  return null;
}
/** 二峰とみなす「群の中心の離れ ÷ 群の中のばらつき」の下限（最終レビュー T1） */
export const BIMODAL_SEP_RATIO = 4;
/**
 * 二峰とみなす「2 群を結ぶ軸の上での群の間の隙間 ÷ 群の中心の離れ」の下限。一様に広がった 1 つの塊（ヨー ±2° の一様ノイズなど）は
 * 2 つに割ると離れ ÷ ばらつきが 3.5 前後になり、標本しだいで 4 を超えて二峰と誤判定された。本物の 2 解は群の間が空いている
 */
export const BIMODAL_GAP_RATIO = 0.25;
/** 窓が二峰のとき、この割合以上の群があればその群の平均を目標にする（無ければ全体の平均 = 中間。最終レビュー T3） */
export const BIMODAL_MAJORITY = 0.6;
/** いったん選んだ群（といまの目標の周り）は、この割合を切るまで選び続ける（ヒステリシス） */
export const KEEP_SUPPORT = 0.3;

export function isBimodal(cand: readonly { pos: readonly number[]; quat: readonly number[] }[], minSepM: number, minSepDeg: number): boolean {
  return bimodalSplit(cand, minSepM, minSepDeg) !== null;
}

export function createAnchorFilter(options: Partial<AnchorFilterOptions> = {}): AnchorFilter {
  const merged: AnchorFilterOptions = { ...DEFAULT_ANCHOR_FILTER, ...options };
  // 窓が MIN_WINDOW 件未満だと目標を更新しないので、上限もそれ以上にする（?avgMaxN=1 / 2 で目標が固まらないように。再レビュー S3）
  const o: AnchorFilterOptions = { ...merged, maxN: Math.max(MIN_WINDOW, Math.round(merged.maxN)) };
  /**
   * 窓が 3 件未満の間の直近 windowMs の観測（held = 目標から遠くて窓に入れなかった）と、3 件未満の状態が始まった時刻。
   * 固着の保険の判定に使う（再レビュー S2・最終レビュー T2 / T4）
   */
  let lowObs: { obs: AnchorObservation; held: boolean }[] = [];
  let lowSinceMs = Number.NaN;
  /** 窓が二峰のとき前回選んだ群の平均（ヒステリシス。無ければ null） */
  let bimodalPrefer: PoseT | null = null;
  let win: AnchorObservation[] = [];
  /** 推定から大きく離れた観測の連続（持続的なずれの判定） */
  let farRun: AnchorObservation[] = [];
  let target: PoseT | null = null;
  let display: PoseT | null = null;
  let lastObsMs = -Infinity;
  /** 直接モード中か（avg のみ） */
  let direct = false;
  const stats: AnchorFilterStats = {
    mode: o.mode === "lerp" ? "lerp" : "avg",
    n: 0,
    spreadMm: 0,
    spreadDeg: 0,
    residualMm: 0,
    residualDeg: 0,
    reseeds: 0,
    outliers: 0,
    ignored: 0,
    fast: 0,
    fallbackReseeds: 0,
    bimodalRejected: 0,
    directEntries: 0,
    catchingUp: false,
    heldOut: 0,
    reseedRejected: 0,
  };
  /** 直近の再取得（無ければ null） */
  let lastReacquire: AnchorReacquire | null = null;
  /** 窓が空になった理由（次の NORMAL の観測を reacquire として記録する） */
  let pendingReason: AnchorReacquire["reason"] | null = null;

  /** 08-4 と同じ lerp（marker-anchor-opencv.ts の apply の snap 判定と同じ式）で pose を raw に寄せる */
  function lerp084(pose: PoseT | null, raw: PoseT, obs: AnchorObservation, canSnap: boolean): PoseT {
    const snap = !pose || (canSnap && (obs.tMs - lastObsMs > o.resnapAfterMs || distV3(pose.pos, raw.pos) > o.snapDistanceM));
    if (snap || !pose) return clonePose(raw);
    return { pos: lerpV3(pose.pos, raw.pos, o.smooth), quat: slerpQuat(pose.quat, raw.quat, o.smooth) };
  }

  function residualOf(obs: AnchorObservation, ref: PoseT | null) {
    stats.residualMm = ref ? distV3(obs.pos, ref.pos) * 1000 : 0;
    stats.residualDeg = ref ? quatAngleDeg(obs.quat, ref.quat) : 0;
  }

  function clearWindowState() {
    win = [];
    farRun = [];
    stats.n = 0;
    stats.spreadMm = 0;
    stats.spreadDeg = 0;
  }

  function add(obs: AnchorObservation, canSnap: boolean): AnchorFilterEvent {
    const raw = clonePose(obs);
    // ---- lerp（?avg=0）: 08-4 と同じ。表示 = 目標 ----
    if (o.mode === "lerp") {
      residualOf(obs, target);
      target = lerp084(target, raw, obs, canSnap);
      display = clonePose(target);
      lastObsMs = obs.tMs;
      return "lerp";
    }
    // ---- avg: LIMITED 中の観測 ----
    if (!obs.xrNormal) {
      if (obs.fastMotion && !target) {
        // 速い首振り（または角速度が未測定）の観測では再ロックしない。直接モード中で目標があるなら使う（LIMITED 中は観測だけが頼り）
        stats.fast++;
        return "fast";
      }
      if (!direct && (obs.limitedMs ?? 0) < o.limitedDirectMs) {
        // 一瞬の LIMITED では窓もコートも動かさない（追補 A5）
        stats.ignored++;
        return "ignored";
      }
      residualOf(obs, target);
      if (!direct) {
        direct = true;
        stats.directEntries++;
        clearWindowState();
        // 配置変更の直後など、すでに再取得の理由があれば最初の理由を保つ（最終レビュー T5）
        if (pendingReason === null) pendingReason = "direct";
      }
      stats.mode = "direct";
      // 目標を生の観測へ lerp（08-4 と同じ式。連射中の飛びは step の制限で抑えるので、ここでは canSnap を見ない）
      target = lerp084(target, raw, obs, true);
      lastObsMs = obs.tMs;
      return "direct";
    }
    // ---- avg: NORMAL の観測 ----
    if (obs.fastMotion) {
      // 頭を速く回している間（と角速度が未測定の間）の観測は窓にも再ロックにも使わない（レビュー R7・再レビュー S4）
      stats.fast++;
      return "fast";
    }
    stats.mode = "avg";
    residualOf(obs, target);
    // 古い観測を落とす（時間）
    win = win.filter((w) => obs.tMs - w.tMs <= o.windowMs);
    if (!target) {
      // 目標が無い（初回・invalidate 後の再ロック）: 1 件目で目標を作る
      direct = false;
      win = [obs];
      farRun = [];
      lowObs = [];
      lowSinceMs = Number.NaN;
      pendingReason = null;
      target = clonePose(obs);
      stats.n = 1;
      stats.spreadMm = 0;
      stats.spreadDeg = 0;
      lastObsMs = obs.tMs;
      return "init";
    }
    // 空白の判定は窓の件数ではなく時間で行う。窓の件数で判定すると、再取得の観測が遠くて窓に入らない（heldOut）たびに
    // 次の観測がまた「再取得」になって作り直しの候補が毎回捨てられ、目標が永遠に固着した（再レビュー S1）
    if (pendingReason === null && (direct || obs.tMs - lastObsMs > o.windowMs)) pendingReason = direct ? "direct" : "gap";
    let event: AnchorFilterEvent = "update";
    if (pendingReason !== null) {
      // 空白の後の再取得（空白 1 回につき最初の 1 回だけ記録）: 目標は保持したまま新しい窓を始める
      lastReacquire = { tMs: obs.tMs, gapMs: obs.tMs - lastObsMs, residualMm: stats.residualMm, residualDeg: stats.residualDeg, reason: pendingReason };
      pendingReason = null;
      direct = false;
      win = [];
      farRun = [];
      lowObs = [];
      lowSinceMs = Number.NaN;
      event = "reacquire";
    }
    const far = distV3(obs.pos, target.pos) >= o.reseedPosM || quatAngleDeg(obs.quat, target.quat) >= o.reseedDeg;
    if (far) farRun.push(obs);
    else farRun = [];
    if (farRun.length > o.reseedN) farRun = farRun.slice(-o.reseedN);
    const runMs = farRun.length > 0 ? farRun[farRun.length - 1].tMs - farRun[0].tMs : 0;
    let reseeded = false;
    let fallbackTarget = false;
    if (far && (farRun.length >= o.reseedN || (farRun.length >= o.reseedMinN && runMs >= o.reseedMs))) {
      // 候補どうしがまとまっていて（レビュー R5）、二峰でない（再レビュー S5）ときだけ作り直す
      const cand = farRun;
      const cPos: Vec3T = [0, 1, 2].map((k) => cand.reduce((acc, w) => acc + w.pos[k], 0) / cand.length) as Vec3T;
      const cQuat = meanQuat(cand.map((w) => w.quat), cand[0].quat);
      const rmsPos = Math.sqrt(cand.reduce((acc, w) => acc + distV3(w.pos, cPos) ** 2, 0) / cand.length);
      const rmsDeg = Math.sqrt(cand.reduce((acc, w) => acc + quatAngleDeg(w.quat, cQuat) ** 2, 0) / cand.length);
      const awayM = distV3(cPos, target.pos);
      const awayDeg = quatAngleDeg(cQuat, target.quat);
      const away = awayM >= o.reseedPosM || awayDeg >= o.reseedDeg;
      // まとまりの上限は、候補の平均のずれが大きいほど緩める（位置 max(5cm, ずれの半分)、回転 max(5°, ずれの半分)）。
      // 固定の 5cm / 2.5° だと、本物の 15cm のずれでも各軸 σ3cm・回転 1.5° のノイズで候補のばらつきが際に来て作り直しが 26 件まで遅れた
      // （最終レビュー T1）。ノイズだけで作り直さないことは「候補の平均が閾値以上ずれている」（等方的なノイズの平均はほぼ 0）で守る
      const limPos = Math.max(o.reseedPosM / 2, awayM / 2);
      const limDeg = Math.max(o.reseedDeg, awayDeg / 2);
      if (!(away && rmsPos < limPos && rmsDeg < limDeg)) {
        stats.reseedRejected++;
      } else if (isBimodal(cand, o.reseedPosM / 2, o.reseedDeg / 2)) {
        stats.reseedRejected++;
        stats.bimodalRejected++;
      } else {
        win = [...cand];
        farRun = [];
        lowObs = [];
        lowSinceMs = Number.NaN;
        stats.reseeds++;
        event = "reseed";
        reseeded = true;
      }
    }
    if (!reseeded) {
      if (win.length < MIN_WINDOW && far) {
        // 窓が少数件の間は中央値が当てにならないので、目標から離れた観測は窓に入れない（作り直しの候補としてだけ数える。レビュー R1）
        stats.heldOut++;
      } else {
        win.push(obs);
      }
      if (win.length < MIN_WINDOW) {
        // 固着の保険（再レビュー S2・最終レビュー T2）: 窓が 3 件未満の状態が windowMs 以上続き、直近 windowMs（時間で間引く。T4）の観測の
        // うち目標から遠くて入れなかった観測が 3 件以上かつ過半数なら、まとまりの条件なしで作り直す。
        // 遠い観測を条件にするのは、低頻度（0.4〜0.8Hz）の近い観測だけで窓が 3 件にならない状態で 3〜7 秒ごとに跳ねたため。
        // 遠い観測が二峰（2 解の交互）なら片方の峰に寄せず全体の平均（中間）、二峰でなければ頑健な平均
        if (lowObs.length === 0 || Number.isNaN(lowSinceMs)) lowSinceMs = obs.tMs;
        lowObs.push({ obs, held: win[win.length - 1] !== obs });
        lowObs = lowObs.filter((l) => obs.tMs - l.obs.tMs <= o.windowMs);
        const held = lowObs.filter((l) => l.held).map((l) => l.obs);
        if (obs.tMs - lowSinceMs >= o.windowMs && held.length >= MIN_WINDOW && held.length * 2 > lowObs.length) {
          // 推定は遠い観測だけでなく期間中の全部の観測から（遠い観測だけだとノイズの裾に偏る）
          const all = lowObs.map((l) => l.obs);
          const bi = isBimodal(all, o.reseedPosM / 2, o.reseedDeg / 2);
          const est = bi ? plainMean(all) : robustMean(all, o);
          win = all.slice(-o.maxN);
          bimodalPrefer = null;
          lowObs = [];
          lowSinceMs = Number.NaN;
          farRun = [];
          stats.reseeds++;
          stats.fallbackReseeds++;
          event = "reseed";
          reseeded = true;
          // 二峰なら窓の頑健な平均も中間になるが、念のため保険の推定をそのまま目標にする
          target = { pos: est.pos, quat: est.quat };
          fallbackTarget = true;
        }
      } else {
        lowObs = [];
        lowSinceMs = Number.NaN;
      }
    }
    if (win.length > o.maxN) win = win.slice(win.length - o.maxN);
    stats.n = win.length;
    if (win.length >= MIN_WINDOW) {
      const r = robustMean(win, o, reseeded ? null : bimodalPrefer, reseeded ? null : target);
      bimodalPrefer = r.chosen;
      if (fallbackTarget) {
        // 保険で作った目標はそのまま（窓の件数・ばらつきだけ更新）
        stats.spreadMm = r.spreadMm;
        stats.spreadDeg = r.spreadDeg;
        lastObsMs = obs.tMs;
        return event;
      }
      if (!reseeded && win[win.length - 1] === obs && !r.inlier[win.length - 1]) stats.outliers++;
      target = { pos: r.pos, quat: r.quat };
      stats.spreadMm = r.spreadMm;
      stats.spreadDeg = r.spreadDeg;
    }
    // 窓が 3 件未満の間は目標を書き換えない（保持していた目標のまま。レビュー R1）
    // 遠くて窓に入れなかった観測でも lastObsMs は進める（次の観測を「空白の後」と誤判定しない。再レビュー S1）
    lastObsMs = obs.tMs;
    return event;
  }

  function step(canSnap: boolean): PoseT | null {
    if (!target) return display ? clonePose(display) : null;
    if (o.mode === "lerp" || !display || canSnap) {
      // lerp は 08-4 と同じ（add で表示も決まっている）。表示が無い（再ロック直後で発射できない）か、撃っていなければ目標そのまま
      display = clonePose(target);
    } else {
      display = stepToward(display, target, o.maxStepM, o.maxStepDeg);
    }
    // 同じ四元数でも acos の丸めで 1e-6° 程度は出るので、判定は 0.1mm・0.001° で見る
    stats.catchingUp = distV3(display.pos, target.pos) > 1e-4 || quatAngleDeg(display.quat, target.quat) > 1e-3;
    return clonePose(display);
  }

  function clearWindow() {
    clearWindowState();
    lowObs = [];
    lowSinceMs = Number.NaN;
    // 配置の変更は明示的に 1 回だけ「再取得」の理由を立てる（次の NORMAL の観測で記録）。すでに理由があれば最初の理由を保つ（T5）
    if (target && pendingReason === null) pendingReason = "layout";
    // 直接モード中なら直接モードのまま（ここで抜けると次の LIMITED の観測で directEntries を二重に数える。T5）。
    // 次の NORMAL の観測で新しい窓を始める（目標と表示は残す。表示の移行は step の制限つき）
  }

  function reset() {
    clearWindowState();
    bimodalPrefer = null;
    pendingReason = null;
    lowObs = [];
    lowSinceMs = Number.NaN;
    target = null;
    display = null;
    direct = false;
    lastObsMs = -Infinity;
    stats.residualMm = 0;
    stats.residualDeg = 0;
    stats.catchingUp = false;
    stats.mode = o.mode === "lerp" ? "lerp" : "avg";
  }

  return {
    add,
    step,
    clearWindow,
    reset,
    get target() {
      return target ? clonePose(target) : null;
    },
    get display() {
      return display ? clonePose(display) : null;
    },
    get stats() {
      return { ...stats };
    },
    get lastReacquire() {
      return lastReacquire ? { ...lastReacquire } : null;
    },
    options: o,
  };
}
