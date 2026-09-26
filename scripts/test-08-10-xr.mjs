// XR8 の公式 pipeline callback 境界をモックし、姿勢・投影・再ロック世代を確認する。
import assert from "node:assert/strict";
import { createServer } from "vite";
import * as THREE from "three";

const vite = await createServer({ server: { middlewareMode: true }, logLevel: "silent" });
const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
try {
  const { startXrSource, loadEngine } = await vite.ssrLoadModule("/demos/08-10-splatoon-8thwall/xr-source.ts");
  const normal = (x = 0) => ({
    position: { x, y: 1, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 },
    intrinsics: [1.5, 0, 0, 0, 0, 2, 0, 0, 0, 0, -1, -1, 0, 0, -0.1, 0],
    trackingStatus: "NORMAL", trackingReason: "UNSPECIFIED",
  });
  /**
   * XR8 のモック。callback の順序と引数は実機に合わせる: run で onCameraStatusChange({status:"hasVideo", video}) →
   * onStart → onAttach({framework, canvas, videoWidth, videoHeight})（onAttach に video / status は来ない）、
   * runPreRender で onUpdate({frameStartResult, processCpuResult})。preRenderOrder = true のときは配布 xr.js の pre-render と同じく
   * onVideoSizeChange → onCanvasSizeChange → onUpdate の順で呼ぶ（size callback は寸法が変わったときだけ）
   */
  const makeXr = () => {
    const m = {
      video: { videoWidth: 640, videoHeight: 480, readyState: 2 },
      bridge: null, configured: null, projection: null, projections: 0, runOptions: null,
      preRenders: 0, postRenders: 0, stopped: false, nextReality: undefined, repeatFrame: false,
      canvasAtHasVideo: null, canvasAtStart: null, preRenderOrder: false, lastVideoSize: "", lastCanvasSize: "", canvas: null,
    };
    m.engine = {
      XrController: {
        configure: (value) => { m.configured = value; },
        pipelineModule: () => ({ name: "reality" }),
        updateCameraProjectionMatrix: (value) => { m.projection = value; m.projections++; },
      },
      XrConfig: { device: () => ({ MOBILE: "mobile" }) },
      addCameraPipelineModules: (modules) => { m.bridge = modules[1]; },
      run: (value) => {
        m.runOptions = value;
        const { canvas } = value;
        m.canvas = canvas;
        m.bridge.onCameraStatusChange({ status: "hasVideo", video: m.video });
        m.canvasAtHasVideo = [canvas.width, canvas.height];
        m.bridge.onStart({ canvas, canvasWidth: canvas.width, canvasHeight: canvas.height });
        m.canvasAtStart = [canvas.width, canvas.height];
        m.bridge.onAttach({ framework: {}, canvas, videoWidth: m.video.videoWidth, videoHeight: m.video.videoHeight });
      },
      runPreRender: (time) => {
        assert.ok(Number.isFinite(time) && time > 0);
        m.preRenders++;
        if (m.preRenderOrder) {
          const videoSize = `${m.video.videoWidth}x${m.video.videoHeight}`;
          if (videoSize !== m.lastVideoSize) {
            m.lastVideoSize = videoSize;
            m.bridge.onVideoSizeChange({ videoWidth: m.video.videoWidth, videoHeight: m.video.videoHeight });
          }
          const canvasSize = `${m.canvas.width}x${m.canvas.height}`;
          if (canvasSize !== m.lastCanvasSize) {
            m.lastCanvasSize = canvasSize;
            m.bridge.onCanvasSizeChange({ canvasWidth: m.canvas.width, canvasHeight: m.canvas.height });
          }
        }
        m.bridge.onUpdate({ frameStartResult: { repeatFrame: m.repeatFrame }, processCpuResult: { reality: m.nextReality } });
      },
      runPostRender: () => { m.postRenders++; },
      stop: () => { m.stopped = true; },
    };
    return m;
  };
  globalThis.HTMLMediaElement = { HAVE_CURRENT_DATA: 2 };

  // ---- 基本: 起動・姿勢・LIMITED・不正 intrinsics ----
  const x1 = makeXr();
  globalThis.window = { XR8: x1.engine };
  const video = x1.video;
  const canvas1 = { width: 300, height: 150 };
  const source = await startXrSource(canvas1);
  assert.equal(await source.waitForVideo(), video, "video は onCameraStatusChange(hasVideo) だけで取れる（onAttach には来ない）");
  assert.equal(x1.configured.scale, "absolute");
  assert.equal(x1.configured.disableWorldTracking, false);
  assert.equal(x1.runOptions.ownRunLoop, false);
  assert.equal(x1.runOptions.allowedDevices, "mobile");
  assert.deepEqual(x1.projection.cam.pixelRectWidth, 640);
  assert.deepEqual(x1.canvasAtHasVideo, [640, 480], "hasVideo の時点（onStart 前）で XR 用 canvas が映像寸法");
  assert.deepEqual(x1.canvasAtStart, [640, 480]);
  x1.nextReality = normal(0.2);
  source.preRender();
  assert.equal(source.status, "NORMAL");
  assert.equal(source.pose.position.x, 0.2);
  const firstPose = source.pose;
  x1.nextReality.position.x = 99;
  assert.equal(firstPose.position.x, 0.2, "XR8 の内部オブジェクトを参照保持しない");
  source.postRender();
  const generation = source.invalidatedAt;
  x1.nextReality = { ...normal(), trackingStatus: "LIMITED", trackingReason: "INITIALIZING" };
  source.preRender();
  assert.equal(source.pose, null);
  assert.equal(source.status, "LIMITED");
  assert.ok(source.invalidatedAt >= generation);
  x1.nextReality = normal(0.4);
  source.preRender();
  assert.equal(source.pose.position.x, 0.4);

  // ---- A. repeatFrame: 映像が進んでいないフレームでは姿勢も鮮度も更新しない ----
  const frameMs = source.frameMs;
  const invalidatedBeforeRepeat = source.invalidatedAt;
  await new Promise((r) => setTimeout(r, 5));
  x1.repeatFrame = true;
  for (let i = 0; i < 5; i++) {
    x1.nextReality = normal(5 + i);
    source.preRender();
  }
  assert.equal(source.frameMs, frameMs, "repeatFrame では frameMs を更新しない");
  assert.equal(source.pose.position.x, 0.4, "repeatFrame の reality は採用しない");
  assert.equal(source.status, "NORMAL");
  assert.equal(source.invalidatedAt, invalidatedBeforeRepeat);
  x1.nextReality = { ...normal(), trackingStatus: "LIMITED", trackingReason: "INITIALIZING" };
  source.preRender();
  assert.equal(source.status, "NORMAL", "repeatFrame では status も更新しない");
  assert.equal(source.pose.position.x, 0.4);
  source.invalidate("追跡姿勢が古くなりました");
  x1.nextReality = normal(0.6);
  for (let i = 0; i < 3; i++) source.preRender();
  assert.equal(source.pose, null, "invalidate 後の repeatFrame で古い reality から姿勢を復活させない");
  assert.equal(source.frameMs, -Infinity);
  x1.repeatFrame = false;
  source.preRender();
  assert.equal(source.pose.position.x, 0.6, "新しいフレームで姿勢が戻る");
  assert.ok(source.frameMs > frameMs);

  // ---- B. 端末の向き変更: invalidate ----
  {
    const before = source.invalidatedAt;
    await new Promise((r) => setTimeout(r, 2));
    x1.bridge.onDeviceOrientationChange({ orientation: 90, videoWidth: 640, videoHeight: 480 });
    assert.equal(source.pose, null, "向き変更で姿勢を捨てる");
    assert.ok(source.invalidatedAt > before);
    assert.match(source.reason, /向き/);
    x1.nextReality = normal(0.7);
    source.preRender();
    assert.equal(source.pose.position.x, 0.7);
  }

  // ---- C. 映像サイズ変更: 投影更新で invalidate したフレームの reality は捨て、次フレームで採用 ----
  {
    const projections = x1.projections;
    video.videoWidth = 800;
    video.videoHeight = 600;
    x1.nextReality = normal(0.8);
    source.preRender();
    assert.equal(x1.projections, projections + 1, "新しい映像寸法で投影を送り直す");
    assert.equal(x1.projection.cam.pixelRectWidth, 800);
    assert.deepEqual([canvas1.width, canvas1.height], [800, 600]);
    assert.equal(source.pose, null, "投影更新と同じフレームの reality（旧 origin）は捨てる");
    assert.equal(source.status, "NORMAL", "捨てたフレームでは status はそのまま");
    source.preRender();
    assert.equal(source.pose.position.x, 0.8, "次フレームで採用");
    assert.equal(x1.projections, projections + 1);
  }

  // ---- C2. 実機の pre-render 順（onVideoSizeChange → onCanvasSizeChange → onUpdate）: 投影更新は onVideoSizeChange で
  //      済むので、同じ tick の onUpdate の reality（投影更新の後に計算された新 origin の値）は採用し、再ロック世代は進む ----
  {
    x1.preRenderOrder = true;
    x1.lastVideoSize = `${video.videoWidth}x${video.videoHeight}`;
    x1.lastCanvasSize = `${canvas1.width}x${canvas1.height}`;
    x1.nextReality = normal(0.85);
    source.preRender();
    assert.equal(source.pose.position.x, 0.85, "寸法が変わらない tick は通常どおり採用");
    const projections = x1.projections;
    const before = source.invalidatedAt;
    await new Promise((r) => setTimeout(r, 2));
    video.videoWidth = 1024;
    video.videoHeight = 768;
    x1.nextReality = normal(0.9);
    source.preRender();
    assert.equal(x1.projections, projections + 1, "onVideoSizeChange で投影を送り直す");
    assert.equal(x1.projection.cam.pixelRectWidth, 1024);
    assert.equal(x1.projection.cam.pixelRectHeight, 768);
    assert.deepEqual([canvas1.width, canvas1.height], [1024, 768]);
    assert.ok(source.invalidatedAt > before, "映像サイズ変更で再ロック世代が進む");
    assert.equal(source.pose?.position.x, 0.9, "onVideoSizeChange の後の同 tick の onUpdate では pose を採用する");
    assert.equal(source.status, "NORMAL");
    const afterChange = source.invalidatedAt;
    x1.nextReality = normal(1.0);
    source.preRender();
    assert.equal(x1.projections, projections + 1, "寸法が同じなら投影は送り直さない（onCanvasSizeChange で canvas が揃っても）");
    assert.equal(source.invalidatedAt, afterChange);
    assert.equal(source.pose.position.x, 1.0);
    x1.preRenderOrder = false;
  }

  x1.nextReality = { ...normal(), intrinsics: [1] };
  source.preRender();
  assert.equal(source.status, "INVALID_INTRINSICS");
  assert.equal(source.pose, null);
  source.stop();
  assert.equal(x1.stopped, true);
  assert.equal(x1.postRenders, 1);

  // ---- G. 先行読み込み: 渡した Promise の engine を使い、読み込みエラーは開始時に再スローされる ----
  {
    const x2 = makeXr();
    globalThis.window = {};
    const preloaded = Promise.resolve(x2.engine);
    const s2 = await startXrSource({ width: 300, height: 150 }, preloaded);
    assert.equal(await s2.waitForVideo(), x2.video);
    s2.stop();
    globalThis.window = { XR8: makeXr().engine };
    assert.ok(await loadEngine(), "window.XR8 があればそれを使う");
    const failed = Promise.reject(new Error("読み込み失敗（テスト）"));
    failed.catch(() => {});
    await assert.rejects(startXrSource({ width: 300, height: 150 }, failed), /読み込み失敗/);
  }

  // ---- H. 読み込みのタイムアウトは startXrSource() の開始時から数え、失敗後も window.XR8 があれば次の開始で使える ----
  {
    globalThis.window = {};
    const never = new Promise(() => {});
    const t0 = performance.now();
    await assert.rejects(startXrSource({ width: 300, height: 150 }, never, { timeoutMs: 50 }), /タイムアウト/);
    assert.ok(performance.now() - t0 >= 45, "timeoutMs まで待ってから reject する");
    // タイムアウトで失敗した後に xr.js が読み終わった（window.XR8 がある）状態で、もう一度開始する
    const x3 = makeXr();
    globalThis.window = { XR8: x3.engine };
    const s3 = await startXrSource({ width: 300, height: 150 });
    assert.equal(await s3.waitForVideo(), x3.video, "タイムアウト後でも window.XR8 があれば startXrSource(canvas) は成功する");
    s3.stop();
    // 開始時から timeoutMs 以内に読み終われば成功（タイマーは settle 後に解除される）
    const x4 = makeXr();
    globalThis.window = {};
    const late = new Promise((r) => setTimeout(() => r(x4.engine), 20));
    const s4 = await startXrSource({ width: 300, height: 150 }, late, { timeoutMs: 200 });
    assert.equal(await s4.waitForVideo(), x4.video);
    s4.stop();
  }
  const { startPassthrough } = await vite.ssrLoadModule("/src/shared/passthrough-camera.ts");
  let gumCalls = 0;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
    mediaDevices: { getUserMedia: () => { gumCalls++; throw Error("二重カメラ起動"); } },
  } });
  video.srcObject = { getVideoTracks: () => [{ label: "Back Camera" }] };
  video.addEventListener = () => {};
  const scene = new THREE.Scene();
  const passthrough = await startPassthrough(scene, {
    existingVideo: video, camRes: [1280, 720], preferUltraWide: false,
    eyeAspect: () => 0.8, zoom: 1,
  }, () => {});
  assert.equal(passthrough.video, video);
  assert.equal(gumCalls, 0);
  passthrough.setCamHFovDeg(75);
  assert.equal(passthrough.camHFovDeg, 75);
  passthrough.texture.dispose();
  console.log("PASS: XR8 callback・映像共有・投影・追跡ロスト/復帰・repeatFrame・向き変更・投影更新フレームの破棄・実機の pre-render 順・canvas 寸法・先行読み込み・開始時からの読み込みタイムアウト");
} finally {
  await vite.close();
  delete globalThis.window;
  delete globalThis.HTMLMediaElement;
  if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
}
