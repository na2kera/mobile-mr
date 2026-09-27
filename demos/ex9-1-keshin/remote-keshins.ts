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
import { markerFwdToWorldYaw, markerToWorld, remoteDisplay, smoothToward, smoothYaw } from "./keshin-math";
import type { Quat, V3 } from "./keshin-math";
import { KESHIN_SPECS } from "./keshin-assets";
import type { LoadedKeshin } from "./keshin-assets";
import { KeshinView } from "./keshin-view";
import type { MaskUniforms } from "./keshin-occlusion";

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
};

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
      });
    }
  }

  /** モデルが読み込めたら、その番号のビューを差し替える（差し替えたビューは先行コンパイルを待つ） */
  onModelLoaded(index: number, loaded: LoadedKeshin) {
    for (const e of this.views.values()) if (e.view.spec.index === index) e.view.setModel(loaded);
  }

  update(
    now: number,
    dtSec: number,
    players: ReadonlyMap<string, RemotePlayerInput>,
    ctx: { anchor: THREE.Object3D | null; camWorldPos: THREE.Vector3; viewportH: number },
  ) {
    let anchorPos: V3 | null = null;
    let anchorQuat: Quat | null = null;
    if (ctx.anchor) {
      ctx.anchor.updateWorldMatrix(true, false);
      ctx.anchor.matrixWorld.decompose(tmpPos, tmpQuat, new THREE.Vector3());
      anchorPos = [tmpPos.x, tmpPos.y, tmpPos.z];
      anchorQuat = [tmpQuat.x, tmpQuat.y, tmpQuat.z, tmpQuat.w];
    }
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
      e.fade = disp.fade;
      const visual = keshinTimeline((now - p.startLocalMs) / 1000, p.info.on ? "appear" : "vanish");
      const canPlace = disp.draw && anchorPos && anchorQuat && pose?.pos && pose.fwd;
      if (!canPlace) {
        this.setDrawn(e, false, disp.reason);
        e.active = false;
        e.view.hide();
        // 描けない間は表示中の値を捨てる（戻ったときは目標へ即座に置く）
        e.shownHead = null;
        e.shownYaw = null;
        if (disp.reason !== "ok") e.frozenMarkerHead = null;
        continue;
      }
      // gyro で staleMs を過ぎたら、マーカー座標系の頭の位置は最後の値で止める（向きはジャイロで正しいので受け取ったまま）
      if (!disp.freeze || !e.frozenMarkerHead) e.frozenMarkerHead = [pose!.pos![0], pose!.pos![1], pose!.pos![2]];
      const target = markerToWorld(anchorPos!, anchorQuat!, e.frozenMarkerHead);
      const targetYaw = markerFwdToWorldYaw(anchorQuat!, pose!.fwd!);
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
      e.view.update({ head: e.shownHead, yaw: e.shownYaw, visual, fade: disp.fade, aura: true, timeSec: now / 1000, viewportH: ctx.viewportH });
      this.setDrawn(e, !visual.hidden && e.view.modelVisible, visual.hidden ? "off" : disp.reason);
      e.active = !visual.hidden && (e.view.modelVisible || e.view.auraVisible);
    }
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
      return `remote ${name}(${e.id}) #${e.view.spec.index}${p?.info.on ? "on" : "off"} ${e.track}${age} dist=${Number.isFinite(e.dist) ? e.dist.toFixed(2) : "-"}m drawn=${e.drawn ? 1 : 0}(${e.reason}) fade=${e.fade.toFixed(2)} jump=${(this.gapLastWindow.get(e.id) ?? e.gapMax).toFixed(2)}m snaps=${e.snaps}`;
    });
  }

  /** 実機ログの snapshot 用（1 行に収める） */
  diag(): string {
    const list = [...this.views.values()].map((e) => `${e.id}:#${e.view.spec.index}/${e.track}${e.ageMs ? `@${(e.ageMs / 1000).toFixed(1)}` : ""}/d${Number.isFinite(e.dist) ? e.dist.toFixed(1) : "-"}/${e.drawn ? "drawn" : e.reason}/f${e.fade.toFixed(2)}/j${(this.gapLastWindow.get(e.id) ?? 0).toFixed(2)}`);
    return list.length ? `remotes=[${list.join(" ")}]` : "remotes=-";
  }

  dispose() {
    for (const e of this.views.values()) e.view.dispose();
    this.views.clear();
  }
}
