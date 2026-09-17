// 08-8 の「トラッカー」: 部屋に固定した PC の Web カメラ（俯瞰画面と同じ PC の Chrome）の映像を MediaPipe PoseLandmarker に通し、
// 各人の頭の位置（部屋 = field 座標系）とヨーを出す。08-3 の tracker.ts のコピーで、ゴーグルのマーカーの検出を人物の検出に差し替えたもの。
// 送信は overview.ts が行う。
//   - 原点合わせは 08-3 と同じ: 配置が分かっているマーカー（原点 = 正面の壁の markerId / 08 の追加マーカー = 床など）を
//     同じカメラで見て「原点を確定」（直近のサンプルの平均）。マーカーの検出は原点が未確定の間だけ走らせる（確定後は人物だけ）
//   - 人物: PoseLandmarker（src/shared/pose-tracker.ts）→ 1 人ずつ src/shared/pose-cam-track.ts の observePerson
//     （肩幅の仮定で尺度を合わせた最小二乗で 3D 化 → カメラ → field。頭の中心は耳・鼻・目、無ければ肩 + 首。ヨーは肩と耳）
//   - 誰がどのプレイヤーか: src/shared/pose-cam-assign.ts の PoseAssigner（入室順に「手を挙げた人」へ割り当て、位置の近さで追跡、
//     2 秒見失ったら未割当）。track の id は割り当てたプレイヤーの trackId（サーバーが入室順に付けた番号。08-3 のマーカー ID と同じ枠）
//   - 推論の例外（MediaPipe）は try/catch で握り、GPU なら CPU で作り直す（09 と同じ）。描画ループ・検出のタイマーは止めない
//   - PC 確認: ?fakecam=1 で、フェイクカメラ（チェッカーボード + 原点・追加マーカーのピンホール投影）に加えて、
//     field 座標系に置いた合成の体（?fakeBodies=）を PoseLandmarker の代わりに fake-body.ts の fakePoseResult で返す（MediaPipe は読まない）
import * as THREE from "three";
import { createFakeCameraStream, drawCheckerboard } from "../../src/shared/passthrough-camera";
import { createMarkerDetector, markerBits } from "../../src/shared/marker-detector";
import type { MarkerObservation } from "../../src/shared/marker-detector";
import { drawProjectedMarkers, fakeCameraToField, projectFakeMarker } from "../../src/shared/fake-markers";
import type { FakeMarker, ProjectedMarker } from "../../src/shared/fake-markers";
import { fusePoseCandidates, markerToFieldMatrix } from "../../src/shared/marker-layout";
import type { MarkerPlacement, PoseCandidate } from "../../src/shared/marker-layout";
import { camToFieldFromOrigin, matrixOfQuat, quatOfMatrix } from "../../src/shared/outside-in-track";
import { createPoseTracker } from "../../src/shared/pose-tracker";
import type { Delegate, PoseTracker } from "../../src/shared/pose-tracker";
import { BODY_CONNECTIONS } from "../../src/shared/body-math";
import type { BodyLandmark } from "../../src/shared/body-math";
import { fakePoseResult, syntheticBodyShape } from "../../src/shared/fake-body";
import { fakeBodyInCamera, fakeShape, observePerson, webcamViewMapping } from "../../src/shared/pose-cam-track";
import type { FakePoseBody, PersonObservation } from "../../src/shared/pose-cam-track";
import { PoseAssigner } from "../../src/shared/pose-cam-assign";
import type { PersonTrack } from "../../src/shared/pose-cam-assign";
import type { TrackEntry } from "../../src/shared/splatoon-pose-cam-protocol";
import type { V3 } from "../../src/shared/splatoon-sim";

export type TrackerPlayer = { id: string; trackId: number };

export type TrackerOptions = {
  /** 原点マーカー（正面の壁）の ID と実寸 [m]。追加マーカーも同じ実寸 */
  originId: number;
  markerSizeM: number;
  /** Web カメラの水平 FOV [deg]（焦点距離の換算に使う。ブラウザからは取れないので推定値） */
  camHFovDeg: number;
  /** マーカー検出の画像の長辺 [px] */
  detW: number;
  /** 検出（マーカー / 人物）の最小間隔 [ms] */
  intervalMs: number;
  /** 正規化再投影誤差の上限（marker-detector.ts。超える観測は捨てる） */
  maxPoseError: number;
  /** getUserMedia の ideal 解像度 */
  camRes: [number, number];
  /** カメラのラベルに含まれる文字列で選ぶ（省略時は既定のカメラ） */
  camLabel: string | null;
  /** 原点合わせの候補にする追加マーカーの配置（俯瞰画面の配置。毎回呼ぶ） */
  extraMarkers: () => readonly MarkerPlacement[];
  /** 「原点を確定」で平均する直近のサンプル数 */
  lockSamples: number;
  // ---- 人物（PoseLandmarker）----
  numPoses: number;
  delegate: Delegate | "auto";
  modelUrls: string[];
  /** 推論に渡す画像の長辺の上限 [px]（0 なら video のまま。CPU のときは 640） */
  poseDetW: number;
  shoulderM: number;
  neckM: number;
  eyeFwdM: number;
  minVisibility: number;
  qualityFullPx: number;
  /** 割当: 同じ人物とみなす距離 [m]・見失いで未割当に戻す時間 [ms]・手を挙げ続ける時間 [ms] */
  matchM: number;
  lostMs: number;
  raiseHoldMs: number;
  /** 入室順のプレイヤーと trackId（毎回呼ぶ） */
  players: () => readonly TrackerPlayer[];
  /** プレイヤーの表示名（プレビューの名札。毎回呼ぶ） */
  playerLabel: (id: string) => string;
  /** フェイクカメラ（?fakecam=1）。null なら実カメラ + PoseLandmarker */
  fake: {
    bodies: FakePoseBody[];
    cam: { pos: V3; yawDeg: number; pitchDeg: number };
    hidden: Set<number>;
    goggles: boolean;
    /**
     * フェイクカメラの映像にも本物の PoseLandmarker を回す（?fakePoseModel=1。映像に人は居ないので検出は 0 人のはず）。
     * モデルの読み込み・推論の呼び出し・例外処理の経路を PC で通すため。観測は合成の体のまま
     */
    useModel: boolean;
  } | null;
  /** 検出のたびに呼ぶ（locked と観測。観測は原点が確定していて、割当のある人物だけ） */
  onTrack: (locked: boolean, entries: TrackEntry[]) => void;
  /** プレイヤーを人物に割り当てた */
  onAssign: (player: string, key: number) => void;
  /** 状態が変わったら呼ぶ（ボタンの有効 / 無効の描き直し用） */
  onChange: () => void;
};

export type TrackedEntry = TrackEntry & { player: string };

export type Tracker = {
  /** カメラを開いて検出を始める（getUserMedia の許可はユーザー操作から） */
  start(): Promise<void>;
  stop(): void;
  /** 原点を確定する（直近のサンプルを平均）。候補が無ければ false */
  lock(): boolean;
  unlock(): void;
  /** 割当をやり直す（全員を未割当に戻す。人物の追跡は続ける） */
  resetAssignments(): void;
  readonly running: boolean;
  readonly locked: boolean;
  /** 原点マーカーが直近 1 秒に見えているか（確定ボタンの有効条件） */
  originVisible(now: number): boolean;
  /** HUD / 状態表示用の 1 行 */
  readonly info: string;
  /** PoseLandmarker の状態（loading / ready / error / fake） */
  readonly poseStatus: string;
  /** 直近に送った観測（field 座標系。確定後・割当のある人物だけ） */
  readonly lastEntries: readonly TrackedEntry[];
  /** 検出中の人物（割当の有無を含む） */
  readonly persons: readonly PersonTrack<PersonObservation>[];
  /** 次に手を挙げてもらうプレイヤー（全員割当済みなら null） */
  nextPlayer(): string | null;
  /** 直近に見えた原点候補の ID */
  readonly lastOriginIds: readonly number[];
  readonly video: HTMLVideoElement;
  /** プレビュー（映像 + 検出の枠と骨格）を描く canvas */
  readonly preview: HTMLCanvasElement;
  readonly error: string;
};

const FAKE_W = 1280;
const FAKE_H = 960;
/** 原点候補を「見えている」とみなす猶予 [ms] */
const ORIGIN_FRESH_MS = 1000;
/** ゴーグルで隠れる目の点（1〜6）の可視性（フェイクカメラ） */
const GOGGLE_EYE_VISIBILITY = 0.05;

type PoseResultLike = { landmarks: BodyLandmark[][]; worldLandmarks: BodyLandmark[][] };

export function createTracker(opts: TrackerOptions): Tracker {
  const detector = createMarkerDetector(opts.markerSizeM);
  const video = document.createElement("video");
  video.playsInline = true;
  video.muted = true;
  const detCanvas = document.createElement("canvas");
  const detCtx = detCanvas.getContext("2d", { willReadFrequently: true })!;
  const preview = document.createElement("canvas");
  preview.width = 320;
  preview.height = 240;
  const previewCtx = preview.getContext("2d")!;
  const assigner = new PoseAssigner<PersonObservation>({ matchM: opts.matchM, lostMs: opts.lostMs, raiseHoldMs: opts.raiseHoldMs });
  const fakeShapes = opts.fake ? { down: syntheticBodyShape(), cache: new Map<boolean, { x: number; y: number; z: number }[]>() } : null;

  let stream: MediaStream | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastVideoTime = -1;
  let camToField: number[] | null = null;
  /** 直近の原点候補（カメラ → field）のサンプル（確定時に平均する） */
  const originSamples: { pos: V3; quat: [number, number, number, number]; weight: number; atMs: number }[] = [];
  let lastOriginMs = -Infinity;
  let detMs = 0;
  let poseTracker: PoseTracker | null = null;
  let poseLoading = false;
  let retriedWithCpu = false;
  /** 直近の推論結果（プレビューの骨格用） */
  let lastResult: PoseResultLike | null = null;
  /** ?fakePoseModel=1 のとき、本物の PoseLandmarker が映像から返した人数と推論回数（HUD の model=） */
  let modelBodies = -1;
  let modelRuns = 0;
  /** 直近の観測と、その元の landmarks（プレビューの名札の位置用） */
  let lastPairs: { obs: PersonObservation; lm: BodyLandmark[] }[] = [];
  let poseErrors = 0;

  const self = {
    running: false,
    locked: false,
    info: "stopped",
    poseStatus: opts.fake && !opts.fake.useModel ? "fake (合成の体。MediaPipe 未使用)" : "idle",
    lastEntries: [] as TrackedEntry[],
    persons: assigner.tracks,
    lastOriginIds: [] as number[],
    video,
    preview,
    error: "",
    originVisible(now: number) {
      return now - lastOriginMs <= ORIGIN_FRESH_MS;
    },
    nextPlayer() {
      return assigner.nextPlayer(opts.players().map((p) => p.id));
    },
    async start() {
      if (self.running) return;
      self.error = "";
      try {
        stream = opts.fake ? fakeStream() : await openCamera();
        video.srcObject = stream;
        await video.play();
      } catch (e: unknown) {
        self.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        self.info = `error: ${self.error}`;
        opts.onChange();
        throw e;
      }
      self.running = true;
      timer = setInterval(tick, Math.max(16, opts.intervalMs));
      if ((!opts.fake || opts.fake.useModel) && !poseTracker && !poseLoading) void initPose(opts.delegate);
      opts.onChange();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
      self.running = false;
      self.info = "stopped";
      opts.onChange();
    },
    lock() {
      const now = performance.now();
      const fresh = originSamples.filter((s) => now - s.atMs <= ORIGIN_FRESH_MS * 2).slice(-opts.lockSamples);
      const fused = fusePoseCandidates(fresh.map((s): PoseCandidate => ({ pos: s.pos, quat: s.quat, weight: s.weight })));
      if (!fused) return false;
      camToField = matrixOfQuat(fused.quat, fused.pos);
      self.locked = true;
      console.log(`[tracker] origin locked from ${fresh.length} samples: cam at (${fused.pos.map((v) => v.toFixed(2)).join(",")}) spread=${fused.spread.toFixed(3)}m`);
      opts.onChange();
      return true;
    },
    unlock() {
      camToField = null;
      self.locked = false;
      self.lastEntries = [];
      opts.onChange();
    },
    resetAssignments() {
      assigner.reset(performance.now());
      console.log("[tracker] assignments reset");
      opts.onChange();
    },
  };

  async function initPose(delegate: Delegate | "auto", modelBuffer?: ArrayBuffer) {
    poseLoading = true;
    self.poseStatus = "loading";
    try {
      poseTracker = await createPoseTracker(
        {
          numPoses: opts.numPoses,
          delegate,
          modelBuffer,
          modelUrls: opts.modelUrls,
          minPoseDetectionConfidence: 0.5,
          minPosePresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
          inputMaxSide: opts.poseDetW,
          inputMaxSideCpu: 640,
        },
        (step) => {
          self.poseStatus = `loading: ${step}`;
        },
      );
      self.poseStatus = `ready ${poseTracker.delegate} model=${modelBuffer ? "reused" : poseTracker.modelUrl.startsWith("http") ? "remote" : "local"}`;
    } catch (e: unknown) {
      self.poseStatus = `error: ${e instanceof Error ? e.message : String(e)}`;
      console.error("[tracker] PoseLandmarker を初期化できません:", e);
    } finally {
      poseLoading = false;
      opts.onChange();
    }
  }

  /** 推論の失敗: GPU なら 1 回だけ CPU で作り直す（09 と同じ）。検出のタイマーは止めない */
  function onPoseFailure(e: unknown) {
    poseErrors++;
    console.error("[tracker] 人物の推論に失敗:", e);
    const msg = e instanceof Error ? e.message : String(e);
    const failed = poseTracker;
    poseTracker = null;
    try {
      failed?.close();
    } catch {
      // close 自体の失敗は無視
    }
    if (failed?.delegate === "GPU" && opts.delegate === "auto" && !retriedWithCpu) {
      retriedWithCpu = true;
      self.poseStatus = "GPU で推論失敗 → CPU で再初期化";
      void initPose("CPU", failed.modelBuffer);
    } else {
      self.poseStatus = `error: 推論失敗 ${msg}`;
    }
    opts.onChange();
  }

  async function openCamera(): Promise<MediaStream> {
    const size = { width: { ideal: opts.camRes[0] }, height: { ideal: opts.camRes[1] } };
    let s = await navigator.mediaDevices.getUserMedia({ video: { ...size }, audio: false });
    if (!opts.camLabel) return s;
    // ラベルは許可取得後にしか取れないので、一度開いてから選び直す（passthrough-camera.ts の超広角と同じ手順）
    const devices = await navigator.mediaDevices.enumerateDevices();
    const want = devices.find((d) => d.kind === "videoinput" && d.label.toLowerCase().includes(opts.camLabel!.toLowerCase()));
    if (!want) return s;
    s.getTracks().forEach((t) => t.stop());
    s = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: want.deviceId }, ...size }, audio: false });
    return s;
  }

  /** 焦点距離 [px]（長辺 / 2 / tan(水平 FOV / 2)。marker-anchor.ts と同じ換算） */
  function focalPx(w: number, h: number): number {
    return Math.max(w, h) / 2 / Math.tan(THREE.MathUtils.degToRad(opts.camHFovDeg) / 2);
  }

  function fakeFieldToCam(): number[] {
    const cam = opts.fake!.cam;
    return new THREE.Matrix4().fromArray(fakeCameraToField(cam.pos, cam.yawDeg, cam.pitchDeg)).invert().toArray();
  }

  // ---- フェイクカメラ: field 座標系のマーカー（原点 + 配置の追加マーカー）をピンホール投影。人物は fakePoses で合成する ----
  function fakeStream(): MediaStream {
    const fieldToCam = fakeFieldToCam();
    const focal = focalPx(FAKE_W, FAKE_H);
    return createFakeCameraStream(
      (ctx, canvas, frame) => {
        drawCheckerboard(ctx, canvas, frame);
        const items: FakeMarker[] = [{ id: opts.originId, bits: markerBits(opts.originId), toField: markerToFieldMatrix({ id: opts.originId, face: "wall", pos: [0, 0, 0] }) }];
        for (const m of opts.extraMarkers()) {
          if (m.id === opts.originId) continue;
          items.push({ id: m.id, bits: markerBits(m.id), toField: markerToFieldMatrix(m) });
        }
        const projected: ProjectedMarker[] = [];
        for (const it of items) {
          const pm = projectFakeMarker(it, fieldToCam, focal, canvas.width, canvas.height, opts.markerSizeM);
          if (pm) projected.push(pm);
        }
        drawProjectedMarkers(ctx, projected.sort((a, b) => a.sidePx - b.sidePx));
      },
      { width: FAKE_W, height: FAKE_H },
    );
  }

  /** 合成の体（?fakeBodies=）を PoseLandmarker の結果の形で返す（隠した体は載せない。ゴーグルなら目の可視性を下げる） */
  function fakePoses(): PoseResultLike {
    const fake = opts.fake!;
    const fieldToCam = fakeFieldToCam();
    const mapping = webcamViewMapping(FAKE_W, FAKE_H, opts.camHFovDeg);
    const bodies = fake.bodies
      .filter((_, i) => !fake.hidden.has(i))
      .map((b) => {
        let shape = fakeShapes!.cache.get(b.raised);
        if (!shape) {
          shape = fakeShape(fakeShapes!.down, opts.shoulderM, b.raised);
          fakeShapes!.cache.set(b.raised, shape);
        }
        return fakeBodyInCamera(b, shape, fieldToCam);
      });
    const res = fakePoseResult(bodies, mapping);
    if (fake.goggles) for (const lm of res.landmarks) for (const i of [1, 2, 3, 4, 5, 6]) lm[i].visibility = GOGGLE_EYE_VISIBILITY;
    return res;
  }

  /** 原点候補（ID → マーカー → field）。原点は正面の壁、追加マーカーは俯瞰画面の配置 */
  function originToFieldOf(id: number): number[] | null {
    if (id === opts.originId) return markerToFieldMatrix({ id, face: "wall", pos: [0, 0, 0] });
    const m = opts.extraMarkers().find((x) => x.id === id);
    return m ? markerToFieldMatrix(m) : null;
  }

  function tick() {
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return;
    const now = performance.now();
    if (!self.locked) {
      // 原点合わせ: マーカーの検出（新しいフレームのときだけ）
      if (video.currentTime === lastVideoTime) return;
      lastVideoTime = video.currentTime;
      const scale = Math.min(1, opts.detW / Math.max(vw, vh));
      const w = Math.round(vw * scale);
      const h = Math.round(vh * scale);
      if (detCanvas.width !== w || detCanvas.height !== h) {
        detCanvas.width = w;
        detCanvas.height = h;
      }
      const t0 = performance.now();
      detCtx.drawImage(video, 0, 0, w, h);
      const observations = detector.detect(detCtx.getImageData(0, 0, w, h), focalPx(w, h));
      detMs = performance.now() - t0;
      applyMarkers(observations, now);
      lastResult = null;
      lastPairs = [];
      drawPreview(observations, w, h);
      self.info = `${vw}x${vh} det=${detMs.toFixed(0)}ms origin=${self.lastOriginIds.length > 0 ? `seen(${self.lastOriginIds.join("+")})` : self.originVisible(now) ? "seen" : "none"} pose=${self.poseStatus}`;
      opts.onTrack(false, []);
      return;
    }
    // 原点確定後: 人物の検出
    let result: PoseResultLike | null = null;
    let inputW = vw;
    let inputH = vh;
    if (opts.fake) {
      if (opts.fake.useModel && poseTracker) {
        try {
          const r = poseTracker.detect(video);
          if (r) {
            modelBodies = r.landmarks.length;
            modelRuns++;
          }
        } catch (e: unknown) {
          onPoseFailure(e);
        }
      }
      result = fakePoses();
      inputW = FAKE_W;
      inputH = FAKE_H;
      detMs = poseTracker?.lastMs ?? 0;
    } else if (poseTracker) {
      try {
        const r = poseTracker.detect(video);
        if (r) {
          result = { landmarks: r.landmarks as BodyLandmark[][], worldLandmarks: r.worldLandmarks as BodyLandmark[][] };
          detMs = poseTracker.lastMs;
        }
      } catch (e: unknown) {
        onPoseFailure(e);
      }
    }
    if (!result) {
      // まだ推論できない（モデルの読み込み中・同じフレーム・失敗）: 確定していることだけ知らせる（観測は無し）
      if (!poseTracker) opts.onTrack(true, []);
      return;
    }
    applyPoses(result, inputW, inputH, now);
    lastResult = result;
    drawPreview([], vw, vh);
  }

  function applyMarkers(observations: MarkerObservation[], now: number) {
    const originIds: number[] = [];
    const seen = new Set<number>();
    for (const o of observations) {
      if (!Number.isFinite(o.error) || o.error > opts.maxPoseError || seen.has(o.id)) continue;
      seen.add(o.id);
      const toField = originToFieldOf(o.id);
      if (!toField) continue;
      // 原点候補: このマーカーから見た「カメラ → field」をサンプルに積む
      originIds.push(o.id);
      lastOriginMs = now;
      const c2f = camToFieldFromOrigin(o.matrix.elements, toField);
      originSamples.push({ pos: [c2f[12], c2f[13], c2f[14]], quat: quatOfMatrix(c2f), weight: o.sidePx * o.sidePx, atMs: now });
      if (originSamples.length > opts.lockSamples * 4) originSamples.splice(0, originSamples.length - opts.lockSamples * 4);
    }
    self.lastOriginIds = originIds;
  }

  function applyPoses(result: PoseResultLike, w: number, h: number, now: number) {
    const mapping = webcamViewMapping(w, h, opts.camHFovDeg);
    const pairs: { obs: PersonObservation; lm: BodyLandmark[] }[] = [];
    for (let i = 0; i < result.landmarks.length; i++) {
      const lm = result.landmarks[i];
      const world = result.worldLandmarks[i];
      if (!lm || !world) continue;
      const o = observePerson(lm, world, { mapping, imageW: w, imageH: h, camToField: camToField!, shoulderM: opts.shoulderM, neckM: opts.neckM, eyeFwdM: opts.eyeFwdM, minVisibility: opts.minVisibility, qualityFullPx: opts.qualityFullPx });
      if (o) pairs.push({ obs: o, lm });
    }
    lastPairs = pairs;
    const observations = pairs.map((p) => p.obs);
    const players = opts.players();
    for (const ev of assigner.update(observations, now, players.map((p) => p.id))) {
      console.log(`[tracker] assigned ${ev.player} to person #${ev.key}`);
      opts.onAssign(ev.player, ev.key);
    }
    const trackIdOf = new Map(players.map((p) => [p.id, p.trackId]));
    const entries: TrackedEntry[] = [];
    for (const tr of assigner.tracks) {
      if (tr.player === null || tr.lastSeenMs !== now) continue;
      const trackId = trackIdOf.get(tr.player);
      if (trackId === undefined) continue;
      const o = tr.det;
      entries.push({ id: trackId, player: tr.player, pos: [round3(o.pos[0]), round3(o.pos[1]), round3(o.pos[2])], yaw: Math.round(o.yaw * 1000) / 1000, quality: Math.round(o.quality * 100) / 100 });
    }
    self.lastEntries = entries;
    self.info = `${video.videoWidth}x${video.videoHeight} pose=${detMs.toFixed(0)}ms bodies=${result.landmarks.length} solved=${observations.length} persons=${assigner.tracks.length} errors=${poseErrors}${opts.fake?.useModel ? ` model=${modelBodies}/${modelRuns}` : ""} ${self.poseStatus}`;
    opts.onTrack(true, entries.map(({ id, pos, yaw, quality }) => ({ id, pos, yaw, quality })));
  }

  function drawPreview(observations: MarkerObservation[], w: number, h: number) {
    const pw = preview.width;
    const ph = Math.round((pw * h) / w);
    if (preview.height !== ph) preview.height = ph;
    try {
      previewCtx.drawImage(video, 0, 0, pw, ph);
    } catch {
      // フレームが無い瞬間は描かない
    }
    const sx = pw / w;
    const sy = ph / h;
    previewCtx.lineWidth = 2;
    previewCtx.font = "12px system-ui, sans-serif";
    for (const o of observations) {
      previewCtx.strokeStyle = "#fdd663";
      previewCtx.beginPath();
      o.corners.forEach((c, i) => (i === 0 ? previewCtx.moveTo(c.x * sx, c.y * sy) : previewCtx.lineTo(c.x * sx, c.y * sy)));
      previewCtx.closePath();
      previewCtx.stroke();
      previewCtx.fillStyle = previewCtx.strokeStyle;
      previewCtx.fillText(`原点 ${o.id}`, o.corners[0].x * sx, o.corners[0].y * sy - 4);
    }
    if (!lastResult) return;
    // 骨格（正規化座標なので映像の縮尺に合わせる）と名札（人物の割当）
    for (const lm of lastResult.landmarks) {
      previewCtx.strokeStyle = "rgba(138, 180, 248, 0.8)";
      previewCtx.lineWidth = 1.5;
      previewCtx.beginPath();
      for (const [a, b] of BODY_CONNECTIONS) {
        previewCtx.moveTo(lm[a].x * pw, lm[a].y * ph);
        previewCtx.lineTo(lm[b].x * pw, lm[b].y * ph);
      }
      previewCtx.stroke();
    }
    for (const tr of assigner.tracks) {
      // 今回の観測に対応した人物だけ（観測の元の landmarks の鼻の上に名札）
      const lm = lastPairs.find((p) => p.obs === tr.det)?.lm;
      if (!lm) continue;
      const label = `#${tr.key} ${tr.player ? opts.playerLabel(tr.player) : "未割当"}${tr.det.raised ? " ✋" : ""}`;
      previewCtx.fillStyle = tr.player ? "#81c995" : "#fdd663";
      previewCtx.fillText(label, lm[0].x * pw - 20, Math.max(12, lm[0].y * ph - 16));
    }
  }

  return self;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
