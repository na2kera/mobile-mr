// 08-3 アウトサイドインの「トラッカー」: 部屋に固定した PC の Web カメラ（俯瞰画面と同じ PC の Chrome）で
// 各プレイヤーのゴーグル前面のマーカーを検出し、部屋（field）座標系での位置とヨーを出す。送信は overview.ts が行う。
//   - 検出は既存の src/shared/marker-detector.ts（js-aruco2）。姿勢推定（POSIT）はマーカーの実寸に比例した並進を返すので、
//     原点用（markerMm）とゴーグル用（trackMarkerMm）で大きさが違っても、1 つの検出器（原点の実寸）で検出して
//     ゴーグルのマーカーの並進だけ trackMarkerMm / markerMm 倍する（検出（重い）を 2 回走らせない）
//   - 原点合わせ: 配置が分かっているマーカー（原点 = 正面の壁の markerId / 08 の追加マーカー = 床など。俯瞰画面の配置）を
//     このカメラで見て「カメラ → field」を出す（outside-in-track.ts の camToFieldFromOrigin）。「原点を確定」で直近の
//     数フレームぶんを平均して固定し、以後は原点マーカーが隠れてもよい。カメラを動かしたら確定し直す
//   - PC 確認: ?fakecam=1 で、field 座標系に置いた原点マーカー + 配置の追加マーカー + ゴーグルのマーカー（?fakePlayers=）を
//     フェイクカメラ（?fakeTrackCam=）からピンホール投影する（fake-markers.ts の 3D 版をそのまま使う）
import * as THREE from "three";
import { createFakeCameraStream, drawCheckerboard } from "../../src/shared/passthrough-camera";
import { createMarkerDetector, markerBits } from "../../src/shared/marker-detector";
import type { MarkerObservation } from "../../src/shared/marker-detector";
import { drawProjectedMarkers, fakeCameraToField, projectFakeMarker } from "../../src/shared/fake-markers";
import type { FakeMarker, ProjectedMarker } from "../../src/shared/fake-markers";
import { fusePoseCandidates, markerToFieldMatrix } from "../../src/shared/marker-layout";
import type { MarkerPlacement, PoseCandidate } from "../../src/shared/marker-layout";
import { camToFieldFromOrigin, goggleMarkerToField, matrixOfQuat, quatOfMatrix, trackFromObservation, trackQuality } from "../../src/shared/outside-in-track";
import type { FakePlayer } from "../../src/shared/outside-in-track";
import type { TrackEntry } from "../../src/shared/splatoon-outside-in-protocol";
import type { V3 } from "../../src/shared/splatoon-sim";

export type TrackerOptions = {
  /** 原点マーカー（正面の壁）の ID と実寸 [m]。追加マーカーも同じ実寸 */
  originId: number;
  markerSizeM: number;
  /** ゴーグルのマーカーの実寸 [m] */
  goggleSizeM: number;
  /** Web カメラの水平 FOV [deg]（焦点距離の換算に使う。ブラウザからは取れないので推定値） */
  camHFovDeg: number;
  /** 検出画像の長辺 [px] */
  detW: number;
  /** 検出の最小間隔 [ms] */
  intervalMs: number;
  /** 正規化再投影誤差の上限（marker-detector.ts。超える観測は捨てる） */
  maxPoseError: number;
  /** マーカーの中心からスマホのカメラまでの距離 [m]（マーカーの裏側へ） */
  eyeBackM: number;
  /** 品質が 1 になる画面上の辺長 [px] */
  qualityFullPx: number;
  /** getUserMedia の ideal 解像度 */
  camRes: [number, number];
  /** カメラのラベルに含まれる文字列で選ぶ（省略時は既定のカメラ） */
  camLabel: string | null;
  /** 原点合わせの候補にする追加マーカーの配置（俯瞰画面の配置。毎回呼ぶ） */
  extraMarkers: () => readonly MarkerPlacement[];
  /** 「原点を確定」で平均する直近のサンプル数 */
  lockSamples: number;
  /** フェイクカメラ（?fakecam=1）。null なら実カメラ */
  fake: { players: FakePlayer[]; cam: { pos: V3; yawDeg: number; pitchDeg: number }; hidden: Set<number> } | null;
  /** 検出のたびに呼ぶ（locked と観測。観測は原点が確定している間だけ入る） */
  onTrack: (locked: boolean, entries: TrackEntry[]) => void;
  /** 状態が変わったら呼ぶ（ボタンの有効 / 無効の描き直し用） */
  onChange: () => void;
};

export type TrackedEntry = TrackEntry & { sidePx: number; facing: number };

export type Tracker = {
  /** カメラを開いて検出を始める（getUserMedia の許可はユーザー操作から） */
  start(): Promise<void>;
  stop(): void;
  /** 原点を確定する（直近のサンプルを平均）。候補が無ければ false */
  lock(): boolean;
  unlock(): void;
  readonly running: boolean;
  readonly locked: boolean;
  /** 原点マーカーが直近 1 秒に見えているか（確定ボタンの有効条件） */
  originVisible(now: number): boolean;
  /** HUD / 状態表示用の 1 行 */
  readonly info: string;
  /** 直近の観測（field 座標系。確定後） */
  readonly lastEntries: readonly TrackedEntry[];
  /** 直近に見えた原点候補の ID */
  readonly lastOriginIds: readonly number[];
  readonly video: HTMLVideoElement;
  /** プレビュー（映像 + 検出の枠）を描く canvas */
  readonly preview: HTMLCanvasElement;
  readonly error: string;
};

const FAKE_W = 1280;
const FAKE_H = 960;
/** 原点候補を「見えている」とみなす猶予 [ms] */
const ORIGIN_FRESH_MS = 1000;

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

  let stream: MediaStream | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastVideoTime = -1;
  let camToField: number[] | null = null;
  /** 直近の原点候補（カメラ → field）のサンプル（確定時に平均する） */
  const originSamples: { pos: V3; quat: [number, number, number, number]; weight: number; atMs: number }[] = [];
  let lastOriginMs = -Infinity;
  let detMs = 0;

  const self = {
    running: false,
    locked: false,
    info: "stopped",
    lastEntries: [] as TrackedEntry[],
    lastOriginIds: [] as number[],
    video,
    preview,
    error: "",
    originVisible(now: number) {
      return now - lastOriginMs <= ORIGIN_FRESH_MS;
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
  };

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

  // ---- フェイクカメラ: field 座標系のマーカー（原点 + 配置の追加マーカー + ゴーグル）をピンホール投影 ----
  function fakeStream(): MediaStream {
    const fake = opts.fake!;
    const camToFieldFake = fakeCameraToField(fake.cam.pos, fake.cam.yawDeg, fake.cam.pitchDeg);
    const fieldToCam = new THREE.Matrix4().fromArray(camToFieldFake).invert().toArray();
    const focal = focalPx(FAKE_W, FAKE_H);
    return createFakeCameraStream(
      (ctx, canvas, frame) => {
        drawCheckerboard(ctx, canvas, frame);
        const items: { marker: FakeMarker; sizeM: number }[] = [
          { marker: { id: opts.originId, bits: markerBits(opts.originId), toField: markerToFieldMatrix({ id: opts.originId, face: "wall", pos: [0, 0, 0] }) }, sizeM: opts.markerSizeM },
        ];
        for (const m of opts.extraMarkers()) {
          if (m.id === opts.originId) continue;
          items.push({ marker: { id: m.id, bits: markerBits(m.id), toField: markerToFieldMatrix(m) }, sizeM: opts.markerSizeM });
        }
        for (const p of fake.players) {
          items.push({ marker: { id: p.id, bits: markerBits(p.id), toField: goggleMarkerToField(p.pos, THREE.MathUtils.degToRad(p.yawDeg)) }, sizeM: opts.goggleSizeM });
        }
        const projected: ProjectedMarker[] = [];
        for (const it of items) {
          if (fake.hidden.has(it.marker.id)) continue;
          const pm = projectFakeMarker(it.marker, fieldToCam, focal, canvas.width, canvas.height, it.sizeM);
          if (pm) projected.push(pm);
        }
        drawProjectedMarkers(ctx, projected.sort((a, b) => a.sidePx - b.sidePx));
      },
      { width: FAKE_W, height: FAKE_H },
    );
  }

  /** 原点候補（ID → マーカー → field）。原点は正面の壁、追加マーカーは俯瞰画面の配置 */
  function originToFieldOf(id: number): number[] | null {
    if (id === opts.originId) return markerToFieldMatrix({ id, face: "wall", pos: [0, 0, 0] });
    const m = opts.extraMarkers().find((x) => x.id === id);
    return m ? markerToFieldMatrix(m) : null;
  }

  function tick() {
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    if (video.currentTime === lastVideoTime) return;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return;
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
    const image = detCtx.getImageData(0, 0, w, h);
    const observations = detector.detect(image, focalPx(w, h));
    detMs = performance.now() - t0;
    const now = performance.now();
    apply(observations, now);
    drawPreview(observations, w, h);
  }

  function apply(observations: MarkerObservation[], now: number) {
    const originIds: number[] = [];
    const entries: TrackedEntry[] = [];
    const seen = new Set<number>();
    for (const o of observations) {
      if (!Number.isFinite(o.error) || o.error > opts.maxPoseError || seen.has(o.id)) continue;
      seen.add(o.id);
      const toField = originToFieldOf(o.id);
      if (toField) {
        // 原点候補: このマーカーから見た「カメラ → field」をサンプルに積む（確定前だけ。確定後は原点が隠れてもよい）
        originIds.push(o.id);
        lastOriginMs = now;
        if (!self.locked) {
          const c2f = camToFieldFromOrigin(o.matrix.elements, toField);
          originSamples.push({ pos: [c2f[12], c2f[13], c2f[14]], quat: quatOfMatrix(c2f), weight: o.sidePx * o.sidePx, atMs: now });
          if (originSamples.length > opts.lockSamples * 4) originSamples.splice(0, originSamples.length - opts.lockSamples * 4);
        }
        continue;
      }
      if (!camToField) continue;
      // ゴーグルのマーカー: 並進を実寸の比で直してから field 座標系へ
      const m = o.matrix.elements.slice();
      const k = opts.goggleSizeM / opts.markerSizeM;
      m[12] *= k;
      m[13] *= k;
      m[14] *= k;
      const obs = trackFromObservation(m, camToField, opts.eyeBackM);
      entries.push({ id: o.id, pos: [round3(obs.pos[0]), round3(obs.pos[1]), round3(obs.pos[2])], yaw: Math.round(obs.yaw * 1000) / 1000, quality: Math.round(trackQuality(o.sidePx, obs.facing, opts.qualityFullPx) * 100) / 100, sidePx: o.sidePx, facing: obs.facing });
    }
    self.lastOriginIds = originIds;
    self.lastEntries = entries;
    self.info = `${video.videoWidth}x${video.videoHeight} det=${detMs.toFixed(0)}ms origin=${self.locked ? "locked" : originIds.length > 0 ? `seen(${originIds.join("+")})` : self.originVisible(now) ? "seen" : "none"} players=${entries.length === 0 ? "-" : entries.map((e) => `${e.id}:(${e.pos.map((v) => v.toFixed(2)).join(",")}):${e.quality.toFixed(2)}`).join(" ")}`;
    opts.onTrack(self.locked, entries.map(({ id, pos, yaw, quality }) => ({ id, pos, yaw, quality })));
  }

  function drawPreview(observations: MarkerObservation[], w: number, h: number) {
    const pw = preview.width;
    const ph = Math.round((pw * h) / w);
    if (preview.height !== ph) preview.height = ph;
    previewCtx.drawImage(video, 0, 0, pw, ph);
    const sx = pw / w;
    const sy = ph / h;
    previewCtx.lineWidth = 2;
    previewCtx.font = "12px system-ui, sans-serif";
    for (const o of observations) {
      const isOrigin = originToFieldOf(o.id) !== null;
      previewCtx.strokeStyle = isOrigin ? (self.locked ? "#9aa0a6" : "#fdd663") : "#8ab4f8";
      previewCtx.beginPath();
      o.corners.forEach((c, i) => (i === 0 ? previewCtx.moveTo(c.x * sx, c.y * sy) : previewCtx.lineTo(c.x * sx, c.y * sy)));
      previewCtx.closePath();
      previewCtx.stroke();
      previewCtx.fillStyle = previewCtx.strokeStyle;
      previewCtx.fillText(`${isOrigin ? "原点 " : ""}${o.id}`, o.corners[0].x * sx, o.corners[0].y * sy - 4);
    }
  }

  return self;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
