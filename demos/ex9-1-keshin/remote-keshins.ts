// 段階 2: 相手の化身を自分の画面（スマホ）に描く。俯瞰画面と同じ keshin-view.ts の「他人用」を使い、
// 相手の申告した頭の位置と体の向き（マーカー座標系）を自分のアンカーで自分のワールドに直して、その背後・同じ向きに置く。
//   - 信用できるか（教訓 2）: 俯瞰画面と同じ effectiveTrack / poseReceivedLocal（keshin-math.ts の remoteDisplay）。
//     marker は通常、gyro は経過が伸びるほど薄く（staleMs で半分）位置は最後の値で止め、staleHideMs を超えたらフェードで消す。
//     none・通信切れ・自分のアンカー無しは描かない
//   - 跳びをなめらかに: 見た目の位置と向き（自分のワールド）を最新の目標へ時定数 smoothSec で寄せる。持つ状態はこの「表示中の値」だけ
//     （教訓 4）。自分のアンカーの跳び（マーカーを見直したとき）でも目標が動くので同じ仕組みでなめらかになる。snapM 以上は即座に移す
//   - 見上げ角に関係なく描く。演出は全員同じ timeline（段階 1 と同じ経路）
import * as THREE from "three";
import type { KeshinPlayer } from "../../src/shared/keshin-protocol";
import { keshinTimeline } from "../../src/shared/keshin-timeline";
import { effectiveTrack, forwardOfYaw, markerFwdToWorldYaw, markerToWorld, remoteDisplay, smoothToward, smoothYaw, worldToMarker } from "./keshin-math";
import { angleFromEyeDeg, correctionAt, hybridHead, matchRemotesDiag, planRemote, pruneCorr } from "./keshin-hybrid";
import type { CamDetection, CorrSample, MatchInfo, MatchReason } from "./keshin-hybrid";
import type { Quat, V3 } from "./keshin-math";
import { KESHIN_SPECS } from "./keshin-assets";
import type { LoadedKeshin } from "./keshin-assets";
import { KeshinView } from "./keshin-view";
import type { MaskUniforms } from "./keshin-occlusion";
import type { KeshinLook } from "./keshin-look";

export type RemoteOptions = {
  heightM: number;
  eyeH: number;
  backOverride: number | null;
  opacity: number;
  auraN: number;
  /** 表示の位置・向きを目標へ寄せる時定数 [s]（?remoteSmoothSec=） */
  smoothSec: number;
  /** これ以上離れた目標へは寄せずに即座に移す [m]（?snapM=） */
  snapM: number;
  staleMs: number;
  /** gyro の経過がこれを超えたら化身をフェードで消す [ms]（?staleHideMs=。マーカーを見直したらまた出す） */
  staleHideMs: number;
  noPoseMs: number;
  /** pose がこれだけ届かなければ通信切れとして描かない [ms]（?peerLostMs=） */
  lostMs: number;
  /** 段階 3 の C の見え方（null = 段階 2 まで） */
  look: KeshinLook | null;
  /** 段階 3 の B: 位置の決め方（?posMode=declared|camera|hybrid。既定 hybrid） */
  posMode: PosMode;
  /** 方向で結ぶ角度のしきい値 [deg]（?matchDeg=） */
  matchDeg: number;
  /** 相手 1 人・検出 1 人で結ぶとき、新しい申告があれば方向の差の上限 [deg]（?onlyOneMaxDeg=） */
  onlyOneMaxDeg: number;
  /** 見えなくなった瞬間の補正に使う直近の観測 [s]（?corrRecentSec=） */
  corrRecentSec: number;
  /** camera モードで見えなくなってから消すまで [ms] */
  cameraFadeMs: number;
  /** 前の結果の人と位置で結ぶしきい値 [m]（?matchM=） */
  matchM: number;
  /** 申告の体の向きとこれを超えて違う人には新しく結ばない [deg]（?facingMaxDeg=） */
  facingMaxDeg: number;
  /** 補正を学べている相手は、申告 + 補正からこれより離れた人に新しく結ばない [m]（?corrGateM=） */
  corrGateM: number;
  /** 距離の混ぜ方: 申告までの距離の重み（?distW=。申告寄り） */
  distW: number;
  /** 補正を平均する窓 [s]（?corrWindowSec=）と、見えなくなってから 0 へ弱める時間 [s]（?corrDecaySec=） */
  corrWindowSec: number;
  corrDecaySec: number;
  /** Pose の結果がこれより古ければ「見えていない」とする [ms] */
  camStaleMs: number;
};

export type PosMode = "declared" | "camera" | "hybrid";

/** 相手 1 人ぶんの受信状態（main.ts の players と同じもの） */
export type RemotePlayerInput = { info: KeshinPlayer; startLocalMs: number; poseRecvMs: number };

type RemoteEntry = {
  id: string;
  view: KeshinView;
  /** 表示中の頭の位置・向き（自分のワールド）。持つ状態はこれだけ（null = まだ置いていない / 描かない間に捨てた） */
  shownHead: V3 | null;
  shownYaw: number | null;
  /** gyro で staleMs を過ぎたときに止める、マーカー座標系の頭の位置 */
  frozenMarkerHead: V3 | null;
  drawn: boolean;
  /** モデルかオーラを描いているか（出現の最初と消える終わりはオーラだけ。人の形の検出を回す条件） */
  active: boolean;
  everDrawn: boolean;
  reason: string;
  fade: number;
  track: string;
  ageMs: number | null;
  /** 自分の頭からの距離 [m] */
  dist: number;
  /** 直近 1 秒の跳び（目標と表示の差）の最大 [m] と、いまの差 */
  gapMax: number;
  gapNow: number;
  snaps: number;
  // ---- 段階 3 の B（カメラで見た位置）----
  /** 直近の Pose の結果でこの相手に結んだ人（自分のワールド）と、その結果の時刻・結び方 */
  cam: CamDetection | null;
  camAtMs: number;
  matchReason: MatchReason | "-";
  /** 最後にカメラで見えた時刻と、そのときの頭（次の結果の対応づけに使う） */
  lastCamSeenMs: number;
  lastCamHead: V3 | null;
  lastCamFwd: [number, number] | null;
  /** 補正の観測（マーカー座標系の「カメラで見た頭 − 申告位置」。直近の窓だけ持つ） */
  corr: CorrSample[];
  /** 表示の出どころ（camera / hybrid / declared / declared+corr / hidden）と診断 */
  source: string;
  declDist: number | null;
  camDist: number | null;
  dirDeg: number | null;
  /** 直近の Pose の結果での判断に使った値（結ばなかった理由・検出ごとの体の向きの差・申告 + 補正からの距離）。HUD とログ用 */
  matchInfo: MatchInfo | null;
};

const tmpQuat = new THREE.Quaternion();
const tmpPos = new THREE.Vector3();
const tmpSphere = new THREE.Sphere();
const tmpFrustum = new THREE.Frustum();
const tmpMat = new THREE.Matrix4();

export class RemoteKeshins {
  readonly views = new Map<string, RemoteEntry>();
  private readonly scene: THREE.Scene;
  private readonly opts: RemoteOptions;
  private readonly mask: MaskUniforms | null;
  private readonly getModel: (index: number) => LoadedKeshin | null;
  private readonly log: (kind: string, detail: string) => void;
  private gapWindowStart = performance.now();
  /** 直前の 1 秒の跳びの最大（ログ用。1 秒ごとに入れ替える） */
  private gapLastWindow = new Map<string, number>();
  /** 直近の Pose の結果の時刻（見えているかの判定。observe で更新） */
  private lastResultMs = -Infinity;
  private lastMatchKey = "";

  constructor(
    scene: THREE.Scene,
    opts: RemoteOptions,
    mask: MaskUniforms | null,
    getModel: (index: number) => LoadedKeshin | null,
    log: (kind: string, detail: string) => void,
  ) {
    this.scene = scene;
    this.opts = opts;
    this.mask = mask;
    this.getModel = getModel;
    this.log = log;
  }

  /** 相手の一覧に合わせてビューを作る / 消す（化身の番号が変わったら作り直す） */
  sync(players: ReadonlyMap<string, RemotePlayerInput>, selfId: string) {
    for (const [id, e] of this.views) {
      const p = players.get(id);
      if (!p || id === selfId || p.info.keshin !== e.view.spec.index) {
        e.view.dispose();
        this.views.delete(id);
      }
    }
    for (const [id, p] of players) {
      if (id === selfId || this.views.has(id)) continue;
      const spec = KESHIN_SPECS[p.info.keshin];
      const view = new KeshinView(
        spec,
        {
          mode: "other",
          heightM: this.opts.heightM,
          eyeH: this.opts.eyeH,
          backOverride: this.opts.backOverride,
          leanDeg: 0,
          selfBackOverride: null,
          faceAheadM: 0,
          opacity: this.opts.opacity,
          auraN: this.opts.auraN,
          nearFade: null,
          mask: this.mask,
          look: this.opts.look,
        },
        this.getModel(p.info.keshin),
      );
      this.scene.add(view.group);
      this.views.set(id, {
        id,
        view,
        shownHead: null,
        shownYaw: null,
        frozenMarkerHead: null,
        drawn: false,
        active: false,
        everDrawn: false,
        reason: "-",
        fade: 0,
        track: "nopose",
        ageMs: null,
        dist: NaN,
        gapMax: 0,
        gapNow: 0,
        snaps: 0,
        cam: null,
        camAtMs: -Infinity,
        matchReason: "-",
        lastCamSeenMs: -Infinity,
        lastCamHead: null,
        lastCamFwd: null,
        corr: [],
        source: "-",
        declDist: null,
        camDist: null,
        dirDeg: null,
        matchInfo: null,
      });
    }
  }

  /** モデルが読み込めたら、その番号のビューを差し替える（差し替えたビューは先行コンパイルを待つ） */
  onModelLoaded(index: number, loaded: LoadedKeshin) {
    for (const e of this.views.values()) if (e.view.spec.index === index) e.view.setModel(loaded);
  }

  /** 見え方を変える（確認用。ビューを作り直す。相手ごとの学習した補正なども捨てる） */
  setLook(look: KeshinLook | null, players: ReadonlyMap<string, RemotePlayerInput>, selfId: string) {
    this.opts.look = look;
    for (const e of this.views.values()) e.view.dispose();
    this.views.clear();
    this.sync(players, selfId);
  }

  /** 位置の決め方を変える（比べる用。?posMode= と同じ） */
  setPosMode(mode: PosMode) {
    this.opts.posMode = mode;
  }
  get posMode(): PosMode {
    return this.opts.posMode;
  }

  /**
   * 段階 3 の B: Pose の結果（自分のワールドの人）が届くたびに呼ぶ。相手と 1 対 1 で結び（matchRemotes）、見えた相手は補正を学ぶ
   * （マーカー座標系の「カメラで見た頭（ハイブリッド）− 申告位置」。自分のアンカーがあるときだけ）
   */
  observe(
    now: number,
    detections: readonly CamDetection[],
    players: ReadonlyMap<string, RemotePlayerInput>,
    ctx: { anchor: THREE.Object3D | null; eye: V3; selfAnchorFresh: boolean },
  ) {
    const prevResultMs = this.lastResultMs;
    this.lastResultMs = now;
    const a = this.anchorOf(ctx.anchor);
    const remotes = [...this.views.values()].map((e) => {
      const p = players.get(e.id);
      const pose = p?.info.pose;
      const decl = a && pose?.pos ? markerToWorld(a.pos, a.quat, [pose.pos[0], pose.pos[1], pose.pos[2]]) : null;
      // 申告の体の向き（位置が古くても向きは相手のジャイロで正しい）を自分のワールドへ
      const declFwd = a && pose?.fwd ? forwardOfYaw(markerFwdToWorldYaw(a.quat, pose.fwd)) : null;
      // 補正を学べている（最後に見えてから corrDecaySec 以内）なら、最新の申告位置 + 学んだ補正（弱める前）を予測位置にする
      let corrPred: V3 | null = null;
      if (a && pose?.pos) {
        const c = correctionAt(e.corr, now, this.opts.corrWindowSec, this.opts.corrDecaySec, this.opts.corrRecentSec, e.lastCamSeenMs);
        if (c.n > 0 && c.k > 0) corrPred = markerToWorld(a.pos, a.quat, [pose.pos[0] + c.raw[0], pose.pos[1] + c.raw[1], pose.pos[2] + c.raw[2]]);
      }
      return {
        id: e.id,
        declared: decl,
        fresh: !!decl && ctx.selfAnchorFresh && this.declaredFresh(p, now),
        last: e.lastCamHead && now - e.lastCamSeenMs <= 3000 ? e.lastCamHead : null,
        // 前回の結果でも結んでいた（続けて追いかけている）
        continuing: Number.isFinite(prevResultMs) && e.lastCamSeenMs === prevResultMs,
        declFwd,
        corrPred,
      };
    });
    const res = matchRemotesDiag(detections, remotes, ctx.eye, {
      matchDeg: this.opts.matchDeg,
      matchM: this.opts.matchM,
      onlyOneMaxDeg: this.opts.onlyOneMaxDeg,
      facingMaxDeg: this.opts.facingMaxDeg,
      corrGateM: this.opts.corrGateM,
    });
    const m = res.matches;
    for (const r of remotes) {
      const e = this.views.get(r.id)!;
      e.matchInfo = res.info.get(r.id) ?? null;
      const hit = m.get(r.id);
      if (!hit) {
        e.cam = null;
        e.matchReason = "-";
        continue;
      }
      const d = detections[hit.index];
      e.cam = d;
      e.camAtMs = now;
      e.matchReason = hit.reason;
      e.lastCamSeenMs = now;
      e.lastCamHead = d.head;
      e.lastCamFwd = d.fwd;
      e.dirDeg = r.declared ? angleFromEyeDeg(ctx.eye, r.declared, d.head) : null;
      // 補正の学習: 見えている位置（ハイブリッドの頭）をマーカー座標系に直して申告位置との差を窓に入れる
      const p = players.get(r.id);
      if (a && p?.info.pose?.pos && r.declared) {
        const h = hybridHead(ctx.eye, d.head, r.declared, r.fresh, this.opts.distW);
        const hm = worldToMarker(a.pos, a.quat, h);
        const dm = p.info.pose.pos;
        e.corr.push({ t: now, c: [hm[0] - dm[0], hm[1] - dm[1], hm[2] - dm[2]] });
        e.corr = pruneCorr(e.corr, this.opts.corrWindowSec);
      }
    }
    // 結ばなかった相手は理由も（-(facing) / -(corr-gate) / -(no-facing) / -(dir) / -(no-candidate)）
    const key = remotes
      .map((r) => {
        const why = res.info.get(r.id)?.reject;
        return `${r.id}:${m.get(r.id)?.reason ?? `-${why ? `(${why})` : ""}`}`;
      })
      .join(",");
    if (key !== this.lastMatchKey) {
      this.lastMatchKey = key;
      const vals = remotes.map((r) => `${r.id}[${this.describeMatchValues(res.info.get(r.id) ?? null)}]`).join(" ");
      this.log("remote-match", `${key} persons=${detections.length} ${vals}`);
    }
  }

  private anchorOf(anchor: THREE.Object3D | null): { pos: V3; quat: Quat } | null {
    if (!anchor) return null;
    anchor.updateWorldMatrix(true, false);
    anchor.matrixWorld.decompose(tmpPos, tmpQuat, new THREE.Vector3());
    return { pos: [tmpPos.x, tmpPos.y, tmpPos.z], quat: [tmpQuat.x, tmpQuat.y, tmpQuat.z, tmpQuat.w] };
  }

  /** 申告が新しいか（marker、または gyro で staleMs 未満） */
  private declaredFresh(p: RemotePlayerInput | undefined, now: number): boolean {
    if (!p?.info.pose) return false;
    const eff = effectiveTrack(p.info.pose, now - p.poseRecvMs, this.opts.noPoseMs);
    return eff.track === "marker" || (eff.track === "gyro" && (eff.ageMs ?? Infinity) < this.opts.staleMs);
  }

  update(
    now: number,
    dtSec: number,
    players: ReadonlyMap<string, RemotePlayerInput>,
    ctx: { anchor: THREE.Object3D | null; camWorldPos: THREE.Vector3; viewportH: number; selfAnchorFresh?: boolean },
  ) {
    let anchorPos: V3 | null = null;
    let anchorQuat: Quat | null = null;
    if (ctx.anchor) {
      ctx.anchor.updateWorldMatrix(true, false);
      ctx.anchor.matrixWorld.decompose(tmpPos, tmpQuat, new THREE.Vector3());
      anchorPos = [tmpPos.x, tmpPos.y, tmpPos.z];
      anchorQuat = [tmpQuat.x, tmpQuat.y, tmpQuat.z, tmpQuat.w];
    }
    const eye: V3 = [ctx.camWorldPos.x, ctx.camWorldPos.y, ctx.camWorldPos.z];
    // 跳びの最大は 1 秒ごとに入れ替える（ログは直前の 1 秒）
    if (now - this.gapWindowStart >= 1000) {
      this.gapWindowStart = now;
      this.gapLastWindow = new Map([...this.views].map(([id, e]) => [id, e.gapMax]));
      for (const e of this.views.values()) e.gapMax = 0;
    }
    for (const [id, e] of this.views) {
      const p = players.get(id);
      if (!p) continue;
      const pose = p.info.pose;
      const disp = remoteDisplay(anchorPos !== null, pose, now - p.poseRecvMs, this.opts);
      e.track = disp.track;
      e.ageMs = disp.ageMs;
      const visual = keshinTimeline((now - p.startLocalMs) / 1000, p.info.on ? "appear" : "vanish");
      // gyro で staleMs を過ぎたら、マーカー座標系の頭の位置は最後の値で止める（向きはジャイロで正しいので受け取ったまま）
      if (disp.draw && pose?.pos && (!disp.freeze || !e.frozenMarkerHead)) e.frozenMarkerHead = [pose.pos[0], pose.pos[1], pose.pos[2]];
      const plan = this.plan(e, p, disp, now, anchorPos, anchorQuat, eye, !!ctx.selfAnchorFresh);
      e.fade = plan.fade;
      e.source = plan.source;
      if (!plan.target || plan.yaw === null) {
        this.setDrawn(e, false, plan.reason);
        e.active = false;
        e.view.hide();
        // 描けない間は表示中の値を捨てる（戻ったときは目標へ即座に置く）
        e.shownHead = null;
        e.shownYaw = null;
        // 表示を止めた申告位置を捨てるのは declared モードだけ（hybrid の補正の基準は最新の申告位置で、これとは別）
        if (this.opts.posMode === "declared" && plan.reason !== "ok") e.frozenMarkerHead = null;
        continue;
      }
      const target = plan.target;
      const targetYaw = plan.yaw;
      const sm = smoothToward(e.shownHead, target, dtSec, this.opts.smoothSec, this.opts.snapM);
      if (sm.snapped && e.shownHead !== null) {
        e.snaps++;
        this.log("remote-snap", `${id} gap=${sm.gap.toFixed(2)}m`);
      }
      e.gapNow = sm.gap;
      e.gapMax = Math.max(e.gapMax, sm.gap);
      e.shownHead = sm.pos;
      e.shownYaw = sm.snapped || e.shownYaw === null ? targetYaw : smoothYaw(e.shownYaw, targetYaw, dtSec, this.opts.smoothSec);
      e.dist = Math.hypot(sm.pos[0] - ctx.camWorldPos.x, sm.pos[1] - ctx.camWorldPos.y, sm.pos[2] - ctx.camWorldPos.z);
      e.view.update({ head: e.shownHead, yaw: e.shownYaw, visual, fade: plan.fade, aura: true, timeSec: now / 1000, viewportH: ctx.viewportH });
      this.setDrawn(e, !visual.hidden && e.view.modelVisible, visual.hidden ? "off" : plan.reason);
      e.active = !visual.hidden && (e.view.modelVisible || e.view.auraVisible);
    }
  }

  /**
   * どこに・どの薄さで描くか（位置の決め方 posMode ごと）。target = null なら描かない
   *   declared: 段階 2 と同じ（申告位置。信用度で薄く・古ければ消す）
   *   camera: 見えている間はカメラの位置だけ（距離もカメラの推定）。見えなくなったら 0.5 秒保持してフェードで消す
   *   hybrid: 見えている間は方向 = カメラ・距離 = 申告と混ぜる（アンカーやマーカーが無くても描く）。見えていない間は申告位置 + 補正（弱めながら）。
   *     補正を学べていた相手は、薄さと staleHideMs を「最後に見えてから」で数える
   */
  private plan(
    e: RemoteEntry,
    p: RemotePlayerInput,
    disp: ReturnType<typeof remoteDisplay>,
    now: number,
    anchorPos: V3 | null,
    anchorQuat: Quat | null,
    eye: V3,
    selfAnchorFresh: boolean,
  ): ReturnType<typeof planRemote> {
    const pose = p.info.pose;
    const anchor = anchorPos && anchorQuat ? { pos: anchorPos, quat: anchorQuat } : null;
    const declMarker: V3 | null = pose?.pos ? [pose.pos[0], pose.pos[1], pose.pos[2]] : null;
    const declWorld = anchor && declMarker ? markerToWorld(anchor.pos, anchor.quat, declMarker) : null;
    const seen = e.cam !== null && e.camAtMs === this.lastResultMs && now - this.lastResultMs <= this.opts.camStaleMs;
    e.declDist = declWorld ? Math.hypot(declWorld[0] - eye[0], declWorld[1] - eye[1], declWorld[2] - eye[2]) : null;
    e.camDist = seen && e.cam ? e.cam.camDist : null;
    return planRemote({
      mode: this.opts.posMode,
      now,
      disp,
      anchor,
      declMarker,
      declMarkerFrozen: e.frozenMarkerHead,
      declYaw: anchorQuat && pose?.fwd ? markerFwdToWorldYaw(anchorQuat, pose.fwd) : null,
      fresh: !!declWorld && selfAnchorFresh && this.declaredFresh(p, now),
      seen,
      cam: e.cam,
      lastCamSeenMs: e.lastCamSeenMs,
      lastCamHead: e.lastCamHead,
      lastCamFwd: e.lastCamFwd,
      corr: e.corr,
      eye,
      opts: {
        distW: this.opts.distW,
        corrWindowSec: this.opts.corrWindowSec,
        corrDecaySec: this.opts.corrDecaySec,
        corrRecentSec: this.opts.corrRecentSec,
        staleMs: this.opts.staleMs,
        staleHideMs: this.opts.staleHideMs,
        noPoseMs: this.opts.noPoseMs,
        lostMs: this.opts.lostMs,
        cameraFadeMs: this.opts.cameraFadeMs,
      },
      display: (q) => remoteDisplay(true, q, 0, this.opts),
      markerToWorld,
    });
  }

  private setDrawn(e: RemoteEntry, drawn: boolean, reason: string) {
    if (drawn && !e.everDrawn) {
      e.everDrawn = true;
      this.log("remote-first-draw", `${e.id} keshin=${e.view.spec.index} dist=${e.dist.toFixed(2)}m model=${e.view.isFallback ? "fallback" : "loaded"}`);
    } else if (!drawn && e.drawn) {
      this.log("remote-hidden", `${e.id} reason=${reason}`);
    } else if (drawn && !e.drawn) {
      // 一度消えた後にまた描いた（例: stale で消えた相手がマーカーを見直した）
      this.log("remote-shown", `${e.id} after=${e.reason} track=${e.track}`);
    }
    e.drawn = drawn;
    e.reason = reason;
  }

  /** 相手の化身（モデルかオーラ）が 1 体でも描かれていて、視野に入っていそうか（人の形の検出を回し、隠す条件） */
  anyVisibleInView(camera: THREE.Camera): boolean {
    camera.updateMatrixWorld();
    tmpMat.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    tmpFrustum.setFromProjectionMatrix(tmpMat);
    for (const e of this.views.values()) {
      if (!e.active || !e.shownHead) continue;
      // 化身と足元のオーラのおおよその大きさの球（頭の少し上を中心に、足元から化身の頭まで入る半径）
      tmpSphere.center.set(e.shownHead[0], e.shownHead[1] + this.opts.heightM * 0.1, e.shownHead[2]);
      tmpSphere.radius = this.opts.heightM * 0.7;
      if (tmpFrustum.intersectsSphere(tmpSphere)) return true;
    }
    return false;
  }

  /** 相手の頭（表示中の位置・向き。フェイクの人を描く・確認用） */
  drawnHeads(): { id: string; head: V3; yaw: number }[] {
    return [...this.views.values()].filter((e) => e.drawn && e.shownHead && e.shownYaw !== null).map((e) => ({ id: e.id, head: e.shownHead!, yaw: e.shownYaw! }));
  }

  /** HUD の相手ごとの 1 行 */
  describe(players: ReadonlyMap<string, RemotePlayerInput>): string[] {
    return [...this.views.values()].map((e) => {
      const p = players.get(e.id);
      const name = p ? p.info.name : e.id;
      const age = e.ageMs !== null ? ` ${(e.ageMs / 1000).toFixed(1)}s` : "";
      return `remote ${name}(${e.id}) #${e.view.spec.index}${p?.info.on ? "on" : "off"} ${e.track}${age} dist=${Number.isFinite(e.dist) ? e.dist.toFixed(2) : "-"}m drawn=${e.drawn ? 1 : 0}(${e.reason}) fade=${e.fade.toFixed(2)} jump=${(this.gapLastWindow.get(e.id) ?? e.gapMax).toFixed(2)}m snaps=${e.snaps} ${this.describeHybrid(e)}`;
    });
  }

  /** 段階 3 の B の診断: 出どころ・カメラの推定距離・申告距離・補正の大きさと窓の件数・方向のずれ・結び方・結ばなかった理由と判断に使った値 */
  private describeHybrid(e: RemoteEntry): string {
    const c = correctionAt(e.corr, performance.now(), this.opts.corrWindowSec, this.opts.corrDecaySec, this.opts.corrRecentSec, e.lastCamSeenMs);
    const f = (v: number | null, d = 2) => (v === null ? "-" : v.toFixed(d));
    return `src=${e.source} camD=${f(e.camDist)} decD=${f(e.declDist)} corr=${Math.hypot(...c.raw).toFixed(2)}m×${c.k.toFixed(2)} n=${c.n} dAng=${f(e.dirDeg, 0)}deg match=${e.matchReason} why=${e.matchInfo?.reject ?? "-"} ${this.describeMatchValues(e.matchInfo)}`;
  }

  /** 検出ごとの体の向きの差 fDeg=[..] と申告 + 補正からの距離 corrM=[..]（次の実機テストでしきい値を決める材料） */
  private describeMatchValues(info: MatchInfo | null): string {
    const list = (xs: (number | null)[] | undefined, d: number) => (xs && xs.length ? xs.map((v) => (v === null ? "-" : v.toFixed(d))).join(",") : "-");
    return `fDeg=${list(info?.facingDeg, 0)} corrM=${list(info?.corrM, 2)}`;
  }

  /** 実機ログの snapshot 用（1 行に収める） */
  diag(): string {
    const list = [...this.views.values()].map((e) => `${e.id}:#${e.view.spec.index}/${e.track}${e.ageMs ? `@${(e.ageMs / 1000).toFixed(1)}` : ""}/d${Number.isFinite(e.dist) ? e.dist.toFixed(1) : "-"}/${e.drawn ? "drawn" : e.reason}/f${e.fade.toFixed(2)}/j${(this.gapLastWindow.get(e.id) ?? 0).toFixed(2)}/${this.describeHybrid(e).replace(/ /g, "/")}`);
    return list.length ? `remotes=[${list.join(" ")}]` : "remotes=-";
  }

  dispose() {
    for (const e of this.views.values()) e.view.dispose();
    this.views.clear();
  }
}
