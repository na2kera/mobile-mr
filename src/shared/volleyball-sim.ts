// Phase 6: バレーボールのボール物理と打ち返しの計算（純粋関数）。
// サーバー（権威）とクライアント（描画のための外挿・打った瞬間の予測）が同じ式を使う。
// three.js に依存させない（Node の回帰テスト scripts/test-volleyball.mjs から import するため。
// import に .ts を付けているのも Node の ESM 解決のため）。
// 座標系は volleyball-protocol.ts 参照（Y 上、ネットは Z=0、A 側 = Z>0）

export type V3 = [number, number, number];
export type Side = "A" | "B";

export type CourtConfig = {
  /** ネット上端の高さ [m]（マーカー面 = 0 から） */
  netTop: number;
  /** ネット下端の高さ [m]（見た目用。物理では下をくぐった球もネットに当たった扱いなので未使用） */
  netBottom: number;
  /** ネットの幅の半分 [m] */
  netHalfWidth: number;
  /** ボールの半径 [m]（バレーボール実寸 ≈ 0.105。05 と同じ） */
  ballR: number;
  /**
   * 重力 [m/s²]。現実の 9.8 ではなく低め（既定 4）。現実の重力で反応できる滞空時間（1s）を
   * 要求すると最高点が g·t²/8 ≈ 1.2m 上がり、机上コートでは天井を突き抜けて、落下速度も
   * 5m/s 超（当たり窓が手トラッカー 2 フレーム分）になる（レビュー指摘で机上計算）。
   * MR の部屋の寸法と手トラッカーのレートに合わせた「非現実的だが遊べる」値
   */
  gravity: number;
  /** 打ち返しの基準滞空時間 [s]（手の速さで短くなる）。サーバーからクライアントへ配る */
  baseFlightSec: number;
  /** サーブ（自動トス）の滞空時間 [s]。ゆっくり目 */
  serveFlightSec: number;
  /** 打ち返しの狙い: 相手の頭からネット側へこの距離 [m]（手を出す位置 = 顔の前 30〜60cm） */
  reach: number;
  /** 狙う高さ: 相手の頭からこれだけ下 [m]（目の高さより少し下に手が来る） */
  aimDrop: number;
  /** コートの外（アウト）とみなす範囲。yMin は地面判定が先に当たるので通常は到達しない（保険） */
  bounds: { x: number; z: number; yMin: number };
  /** 相手がいないときに bot が狙う位置の、ネットからの距離 [m] */
  botDistance: number;
};

export const DEFAULT_COURT: CourtConfig = {
  netTop: 0.6,
  // 実機確認（2026-08-27）: 浮いたネットは違和感があったので地面（マーカー面）まで下ろす
  netBottom: 0,
  // 幅 1.8m（実機確認で 1.2m は小さく感じた）。?netW= で room 設定として変更できる
  netHalfWidth: 0.9,
  ballR: 0.105,
  gravity: 4,
  baseFlightSec: 1.0,
  serveFlightSec: 1.3,
  reach: 0.45,
  aimDrop: 0.1,
  bounds: { x: 3, z: 4, yMin: -1 },
  botDistance: 1.5,
};

export type BallState = {
  pos: V3;
  vel: V3;
  /** 直近に打った側（アウトの責任判定・演出用）。サーブ直後は null */
  lastHit: Side | null;
};

export type Phase =
  /** プレイヤーがいない（どちらの側にも追跡中のプレイヤーがいない） */
  | "waiting"
  /** ボールが飛んでいる */
  | "rally"
  /** ポイントが決まった直後（次のサーブまでの間） */
  | "point";

/** ground: 落下 / net: ネットに掛けて自陣に落下 / out: コート外 */
export type PointReason = "ground" | "net" | "out";

export type GameEvent = {
  /** hit-rejected は申告者にだけ送る（予測を即座に捨てさせる） */
  kind: "serve" | "hit" | "hit-rejected" | "bot-hit" | "net" | "ground" | "out";
  /** hit / bot-hit: 打った側。ground / out: 責任のある側（失点側） */
  side?: Side;
  /** hit / hit-rejected: 申告したプレイヤーの id */
  by?: string;
  t: number;
};

export type GameState = {
  /** サーバー時刻 [ms]（デバッグ用。クライアントは受信時刻を基準に外挿する） */
  t: number;
  /** 権威状態の連番（打球の受理や順序の確認用） */
  seq: number;
  phase: Phase;
  ball: BallState;
  score: Record<Side, number>;
  /** 次のサーブ（自動トス）を受ける側 */
  serveTo: Side;
  /** 各サイドを担当するプレイヤーの id（空きは null。bot はここには入らない） */
  sides: Record<Side, string | null>;
  /** bot が担当している側（相手がいない側。両方に人がいれば null） */
  bot: Side | null;
  /** phase=point のとき、直前のポイント */
  lastPoint: { winner: Side; reason: PointReason } | null;
  /** この状態を作った出来事（演出用。無ければ undefined） */
  event?: GameEvent;
};

export function sideSign(side: Side): 1 | -1 {
  return side === "A" ? 1 : -1;
}

export function otherSide(side: Side): Side {
  return side === "A" ? "B" : "A";
}

/** Z 座標からどちら側か（Z=0 ちょうどは A 側扱い） */
export function sideOfZ(z: number): Side {
  return z >= 0 ? "A" : "B";
}

export function dist3(a: V3, b: V3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export function len3(a: V3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

/**
 * from から to へ flightSec 秒で届く初速（重力 g の放物線）。
 * v = (to - from - ½ g t²) / t。x/z は等速、y だけ重力が乗る
 */
export function launchVelocity(
  from: V3,
  to: V3,
  flightSec: number,
  gravity: number,
): V3 {
  const t = Math.max(0.05, flightSec);
  return [
    (to[0] - from[0]) / t,
    (to[1] - from[1]) / t + 0.5 * gravity * t,
    (to[2] - from[2]) / t,
  ];
}

/** 狙い点を頭に近づけすぎない下限（頭からの水平距離 [m]）。顔面に飛ばさない */
export const AIM_MIN_FROM_HEAD = 0.3;
/** 狙い点をネットから最低これだけ手前に置く [m]（狙い点は必ず受け手の陣に置く） */
export const NET_CLEARANCE = 0.05;
/** ネット際で頭の前に置けないとき、代わりに頭上を通す高さ [m] */
export const AIM_OVERHEAD = 0.3;
/** サーブは打ち返しより少しゆっくり（受け手が構える時間） */
export const SERVE_FLIGHT_FACTOR = 1.15;
/** サーブの発射高さ（ネット上端から [m]）。高いほど最高点が上がり天井に近づく */
export const SERVE_LAUNCH_ABOVE_NET = 0.3;

/**
 * 相手の頭の位置から「手を出しそうな位置」を作る: 頭からネット側へ reach、少し下へ aimDrop。
 * 頭の向きは使わない（ボールを目で追う前提なので、ネット方向に手を出すとみなす）。
 * 狙い点は必ず受け手の陣（ネットから NET_CLEARANCE 以上）に置く。ネット際に立っていて
 * 頭から AIM_MIN_FROM_HEAD 離せないときは、顔面に飛ばさないよう頭上を通す高さにする
 * （受け手には「マーカーから離れて」を案内する。打った側の失点にはしない）
 */
export function aimPoint(head: V3, side: Side, court: CourtConfig): V3 {
  const sign = sideSign(side);
  const fromNet = Math.abs(head[2]);
  const ahead = clamp(fromNet - NET_CLEARANCE, 0, court.reach);
  const overhead = ahead < AIM_MIN_FROM_HEAD;
  // 頭が低い（座位・フェイク幾何）ときに狙い点が地面に埋まらないよう下限を付ける
  const y = Math.max(
    overhead ? head[1] + AIM_OVERHEAD : head[1] - court.aimDrop,
    court.ballR + 0.1,
  );
  return [head[0], y, sign * Math.max(fromNet - ahead, NET_CLEARANCE)];
}

/** 相手がいない側（bot）を狙う位置。bot はここに落ちてくる球を打ち返す */
export function botAimPoint(
  side: Side,
  court: CourtConfig,
  random: () => number = Math.random,
): V3 {
  return [
    (random() - 0.5) * 0.4,
    court.netTop + 0.3,
    sideSign(side) * court.botDistance,
  ];
}

/**
 * 手の速さ [m/s] → 滞空時間 [s]。速く振るほど速い（低い）球になる。
 * 止まった手に当たっただけでも base 秒の山なりで返る（オートエイム前提のゆるい操作感）
 */
export function flightTimeForHandSpeed(speed: number, baseSec: number): number {
  const s = Number.isFinite(speed) ? Math.max(0, speed) : 0;
  return clamp(baseSec * (1 - 0.12 * s), 0.65, baseSec);
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export type StepResult = {
  ball: BallState;
  /** この dt の間に起きたこと。ground / out のとき呼び出し側はラリーを終える */
  event: "net" | "ground" | "out" | null;
};

/**
 * ボールを dt 秒進める。重力 + ネットとの衝突 + 地面/アウトの検出。
 * 純粋関数（入力の ball は変更しない）。
 * ネット: Z=0 の面を横切るとき、交点が幅の中でボール中心の高さがネット上端 + 半径未満なら
 * 当たり。Z 速度を反転して減衰させ、手前側へ戻す（下をくぐった場合も同じ扱い）
 */
export function stepBall(
  ball: BallState,
  dt: number,
  court: CourtConfig,
): StepResult {
  const [x0, y0, z0] = ball.pos;
  const [vx, vy0, vz] = ball.vel;
  const vy = vy0 - court.gravity * dt;
  let x = x0 + vx * dt;
  let y = y0 + ((vy0 + vy) / 2) * dt;
  let z = z0 + vz * dt;
  let nvx = vx;
  let nvy = vy;
  let nvz = vz;
  let event: StepResult["event"] = null;

  // ネット（Z=0 の面）を横切ったか（終点がちょうど面上の場合も含む。z !== 0 を条件にすると
  // 次のステップで z0 === 0 になって判定されず、すり抜ける。レビュー指摘）。
  // z0 が 0 ちょうどのときは「まだ手前側にいる」として次のステップで判定する
  // （サーブはネットの真上から出るので、これで出だしが引っかからない）
  if (z0 !== 0 && z0 * z <= 0) {
    const s = z0 / (z0 - z); // 交点までの割合
    const cx = x0 + (x - x0) * s;
    const cy = y0 + (y - y0) * s;
    if (Math.abs(cx) <= court.netHalfWidth && cy < court.netTop + court.ballR) {
      // 交点で反射。手前側（z0 側）にボール半径ぶん押し戻す
      const back = Math.sign(z0) * court.ballR;
      x = cx;
      y = cy;
      z = back;
      nvx = vx * 0.5;
      nvy = vy * 0.5;
      nvz = -vz * 0.3;
      event = "net";
    }
  }

  if (y - court.ballR <= 0 && nvy < 0) {
    y = court.ballR;
    nvx = 0;
    nvy = 0;
    nvz = 0;
    event = "ground";
  } else if (
    Math.abs(x) > court.bounds.x ||
    Math.abs(z) > court.bounds.z ||
    y < court.bounds.yMin
  ) {
    event = "out";
  }

  return {
    ball: { pos: [x, y, z], vel: [nvx, nvy, nvz], lastHit: ball.lastHit },
    event,
  };
}

/**
 * 描画用: 権威状態から dt 秒後の位置を、固定刻みで stepBall を繰り返して求める
 * （ネットでの跳ね返りも予測に含める。ground / out で止める）
 */
export function extrapolateBall(
  ball: BallState,
  dtSec: number,
  court: CourtConfig,
  stepSec = 1 / 120,
): BallState {
  let cur = ball;
  let remaining = Math.max(0, dtSec);
  while (remaining > 1e-6) {
    const dt = Math.min(stepSec, remaining);
    const r = stepBall(cur, dt, court);
    cur = r.ball;
    if (r.event === "ground" || r.event === "out") break;
    remaining -= dt;
  }
  return cur;
}

/**
 * bot が打ち返すタイミングか: 相手が打った球が bot 側にあり、落下中で、ネット上端 + 0.35m を
 * 切ったら（botAimPoint の高さ netTop + 0.3 に届く少し前）。自分の打球（相手がネット際にいて
 * 狙い点が自陣に出た場合など）は打ち直さない
 */
export function botShouldHit(
  ball: BallState,
  botSide: Side,
  court: CourtConfig,
): boolean {
  const [, y, z] = ball.pos;
  return (
    ball.lastHit !== botSide &&
    sideOfZ(z) === botSide &&
    Math.abs(z) > court.ballR &&
    ball.vel[1] < 0 &&
    y <= court.netTop + 0.35
  );
}

/**
 * 打ち返しの初速を作る。from（接触時のボール位置）から target へ、手の速さで決まる滞空時間で。
 * ネットの上を通るかは保証しない（低く速い球はネットに掛かる = プレイヤーの責任）
 */
export function returnVelocity(
  from: V3,
  target: V3,
  handSpeed: number,
  court: CourtConfig,
): V3 {
  const t = flightTimeForHandSpeed(handSpeed, court.baseFlightSec);
  return launchVelocity(from, target, t, court.gravity);
}
