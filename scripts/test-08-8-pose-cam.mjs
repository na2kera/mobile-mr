// 08-8（PC カメラ + MediaPipe Pose で人を追う）の回帰テスト。`npm run test:pose-cam` で実行する。
//   1. src/shared/pose-cam-track.ts — 頭の中心・体のヨー・手を挙げているか・Web カメラの写像・PoseLandmarker の結果 → field 座標系
//      （実装の生成関数を使わない「手計算の固定期待値」のテストを先に置く。生成側と同じ規約で戻すと符号の取り違えを見逃すため）
//   2. src/shared/pose-cam-assign.ts — 手を挙げた順の割当・予測位置での追跡・0.5 秒の見失いで未割当・期限切れ・割当のやり直し・
//      取り違えの防止（Fable の検算シナリオ S1 別人が同じ場所 / S2 すれ違い / S3 融合して分離 / S5 重複検出）
//   3. server/splatoon-pose-cam.ts — 08-3 のサーバーをオプション付きで別パスに登録したもの（別 Room・tracker 以外の track の拒否・
//      未測定の発射の拒否・知らない ID は捨てる・trackId での引き当て・dropMissing（track に居ないプレイヤーは撃てない。08-3 のパスは従来どおり）・
//      マーカー ID との衝突の検証をしない）。Vite dev サーバーを起動して叩く（既定 PORT 5200）
// テストフレームワークは使わない（04〜08 と同じ方針）。Node 22.18+ は .ts をそのまま import できる
import { spawn } from "node:child_process";
import WebSocket from "ws";
import {
  EYES_OFFSET,
  NOSE_OFFSET,
  RAISE_MARGIN_M,
  SHOULDER_YAW_WEIGHT_WITH_EARS,
  bodyYaw,
  fakeBodyInCamera,
  fakeShape,
  headCenter,
  isHandRaised,
  observePerson,
  parseFakeBodiesParam,
  shoulderScale,
  webcamViewMapping,
} from "../src/shared/pose-cam-track.ts";
import { PoseAssigner, dedupe } from "../src/shared/pose-cam-assign.ts";
import { fakePoseResult, syntheticBodyShape } from "../src/shared/fake-body.ts";
import { fakeCameraToField } from "../src/shared/fake-markers.ts";
import { imageToRay } from "../src/shared/hand-math.ts";
import { invertRigid } from "../src/shared/marker-layout.ts";
import { SPLATOON_OUTSIDE_IN_PATH, SPLATOON_OUTSIDE_IN_PROTOCOL_VERSION, SPLATOON_POSE_CAM_PATH, TRACK_ID_FIRST } from "../src/shared/splatoon-pose-cam-protocol.ts";

const results = [];
function check(name, cond, detail = "") {
  results.push([name, cond]);
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${detail ? ` (${detail})` : ""}`);
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const nearV = (a, b, eps = 1e-6) => a.length === b.length && a.every((v, i) => near(v, b[i], eps));
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DEG = 180 / Math.PI;

/** 33 点ぶんの field 座標（既定はすべて原点）と可視性（既定はすべて 1）を作り、指定の index だけ上書きする */
function pts(overrides) {
  const p = Array.from({ length: 33 }, () => [0, 0, 0]);
  for (const [i, v] of Object.entries(overrides)) p[Number(i)] = v;
  return p;
}
function visAll(overrides = {}) {
  const v = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 1 }));
  for (const [i, x] of Object.entries(overrides)) v[Number(i)].visibility = x;
  return v;
}
const L_SH = 11, R_SH = 12, L_EAR = 7, R_EAR = 8, NOSE = 0, L_EYE = 2, R_EYE = 5, L_ELBOW = 13, R_ELBOW = 14, L_WRIST = 15, R_WRIST = 16;

// ================= 1. 手計算の固定期待値 =================
// ---- 体のヨー: 左肩 − 右肩の向きから ----
{
  // 正面の壁（-Z）を向いて立つ人: 本人の左は -X。左肩 (-0.2, 1.2, 2)、右肩 (0.2, 1.2, 2) → ヨー 0
  const a = bodyYaw(pts({ [L_SH]: [-0.2, 1.2, 2], [R_SH]: [0.2, 1.2, 2] }), visAll({ [L_EAR]: 0, [R_EAR]: 0 }), 0.5);
  check("固定値: 左肩が -X・右肩が +X → 正面は -Z（ヨー 0°）", a && near(a.yaw, 0) && nearV(a.forward, [0, 0, -1]), JSON.stringify(a));
  // -X を向いて立つ人（左へ 90° 回った）: 本人の左は +Z。左肩 (0, 1.2, 2.2)、右肩 (0, 1.2, 1.8) → ヨー +90°、正面 (-1, 0, 0)
  const b = bodyYaw(pts({ [L_SH]: [0, 1.2, 2.2], [R_SH]: [0, 1.2, 1.8] }), visAll({ [L_EAR]: 0, [R_EAR]: 0 }), 0.5);
  check("固定値: 左肩が +Z・右肩が -Z → 正面は -X（ヨー +90°）", b && near(b.yaw * DEG, 90) && nearV(b.forward, [-1, 0, 0]), JSON.stringify(b));
  // カメラ（+Z 側）の方を向く人: 本人の左は +X → ヨー 180°
  const c = bodyYaw(pts({ [L_SH]: [0.2, 1.2, 2], [R_SH]: [-0.2, 1.2, 2] }), visAll({ [L_EAR]: 0, [R_EAR]: 0 }), 0.5);
  check("固定値: 左肩が +X・右肩が -X → 正面は +Z（ヨー 180°）", c && near(Math.abs(c.yaw * DEG), 180) && nearV(c.forward, [0, 0, 1]), JSON.stringify(c));
  // 肩は正面（0°）、耳は左へ 90° 向く、可視性は同じ（1 と 1）。両耳が見えるので肩の重みは 0.25 → 正面 = 0.25×(0,0,-1) + 1×(-1,0,0)
  // → ヨー = atan2(1, 0.25) = atan(4) ≈ 75.964°（耳 = 頭の向きを優先）
  const d = bodyYaw(pts({ [L_SH]: [-0.2, 1.2, 2], [R_SH]: [0.2, 1.2, 2], [L_EAR]: [0, 1.4, 2.1], [R_EAR]: [0, 1.4, 1.9] }), visAll(), 0.5);
  check("固定値: 肩 0° と耳 90° は耳を優先（肩の重み 0.25）→ atan(4) ≈ 75.964°", SHOULDER_YAW_WEIGHT_WITH_EARS === 0.25 && d && near(d.yaw * DEG, 75.96375653207353, 1e-9), `${d && (d.yaw * DEG).toFixed(3)}`);
  // 耳が見えなければ肩だけ（重み 1）
  const d2 = bodyYaw(pts({ [L_SH]: [-0.2, 1.2, 2], [R_SH]: [0.2, 1.2, 2], [L_EAR]: [0, 1.4, 2.1], [R_EAR]: [0, 1.4, 1.9] }), visAll({ [R_EAR]: 0.1 }), 0.5);
  check("固定値: 片耳が見えなければ肩の向きだけ（0°）", d2 && near(d2.yaw * DEG, 0, 1e-9), `${d2 && (d2.yaw * DEG).toFixed(3)}`);
  const e = bodyYaw(pts({ [L_SH]: [0, 1.2, 2], [R_SH]: [0, 1.2, 2] }), visAll({ [L_EAR]: 0, [R_EAR]: 0 }), 0.5);
  check("肩が重なって（真横）耳も見えなければヨーは出さない", e === null);
}

// ---- 頭の中心 ----
{
  // 両耳だけ見える（鼻・目は可視性 0）: 耳の中点
  const h1 = headCenter(pts({ [L_EAR]: [-0.1, 1.5, 2], [R_EAR]: [0.1, 1.5, 2] }), visAll({ [NOSE]: 0, [L_EYE]: 0, [R_EYE]: 0 }), [0, 0, -1], { minVisibility: 0.5, neckM: 0.25 });
  check("固定値: 両耳 (-0.1,1.5,2)・(0.1,1.5,2) → 頭の中心 (0,1.5,2)、source=ears", h1 && nearV(h1.pos, [0, 1.5, 2]) && h1.source === "ears", JSON.stringify(h1));
  // 耳の中点 (0,1.5,2)、鼻 (0,1.49,1.92)（-Z 向きの人の 8cm 前・1cm 下）を可視性 1:1 → どちらも (0,1.5,2) を指すので (0,1.5,2)
  const h2 = headCenter(pts({ [L_EAR]: [-0.1, 1.5, 2], [R_EAR]: [0.1, 1.5, 2], [NOSE]: [0, 1.49, 1.92] }), visAll({ [L_EYE]: 0.1, [R_EYE]: 0.1 }), [0, 0, -1], { minVisibility: 0.5, neckM: 0.25 });
  check("固定値: 鼻 (0,1.49,1.92) は正面 -Z の人なら頭の中心 (0,1.5,2) の前 8cm・下 1cm（NOSE_OFFSET）", NOSE_OFFSET.fwd === 0.08 && NOSE_OFFSET.up === -0.01 && h2 && nearV(h2.pos, [0, 1.5, 2], 1e-9), JSON.stringify(h2));
  // 耳 (0,1.5,2)（可視性 1）と、ずれた鼻（(0,1.49,1.72) → 頭の中心の推定 (0,1.5,1.8)、可視性 0.6）→ z = (2×1 + 1.8×0.6) / 1.6 = 1.925
  const h3 = headCenter(pts({ [L_EAR]: [-0.1, 1.5, 2], [R_EAR]: [0.1, 1.5, 2], [NOSE]: [0, 1.49, 1.72] }), visAll({ [NOSE]: 0.6, [L_EYE]: 0, [R_EYE]: 0 }), [0, 0, -1], { minVisibility: 0.5, neckM: 0.25 });
  check("固定値: 耳と鼻を可視性で重み付け（z = (2×1 + 1.8×0.6)/1.6 = 1.925）", h3 && nearV(h3.pos, [0, 1.5, 1.925], 1e-9), JSON.stringify(h3));
  // 耳が片方しか見えず鼻も見えない → 肩の中点 (0,1.25,2) + 首 0.25 → (0,1.5,2)、source=shoulders
  const h4 = headCenter(pts({ [L_SH]: [-0.2, 1.25, 2], [R_SH]: [0.2, 1.25, 2], [L_EAR]: [9, 9, 9] }), visAll({ [R_EAR]: 0.2, [NOSE]: 0.2 }), [0, 0, -1], { minVisibility: 0.5, neckM: 0.25 });
  check("固定値: 片耳だけで鼻も見えなければ肩の中点 (0,1.25,2) + 首 0.25m → (0,1.5,2)", h4 && nearV(h4.pos, [0, 1.5, 2]) && h4.source === "shoulders", JSON.stringify(h4));
  // 片耳 + 鼻（正面 -Z の人）: 左耳 (-0.1, 1.52, 2.03)、鼻 (0.02, 1.49, 1.92) → 鼻から戻した点 (0.02, 1.5, 2.0)。
  // 横（X）は鼻から 0.02、正面方向（Z）は耳から 2.03、高さは耳 1.52 と 1.5 の平均 1.51 → (0.02, 1.51, 2.03)
  const h5 = headCenter(pts({ [L_SH]: [-0.2, 1.25, 2], [R_SH]: [0.2, 1.25, 2], [L_EAR]: [-0.1, 1.52, 2.03], [R_EAR]: [9, 9, 9], [NOSE]: [0.02, 1.49, 1.92] }), visAll({ [R_EAR]: 0.2, [L_EYE]: 0, [R_EYE]: 0 }), [0, 0, -1], { minVisibility: 0.5, neckM: 0.25 });
  check("固定値: 片耳 + 鼻 → 横は鼻、正面方向は耳、高さは平均 = (0.02, 1.51, 2.03)、source=ear-nose", h5 && nearV(h5.pos, [0.02, 1.51, 2.03], 1e-9) && h5.source === "ear-nose", JSON.stringify(h5));
  // 右を向いた人（正面 +X、ヨー -90°）: 右耳 (1.98, 1.5, 2.1)（本人の右 = +Z）、鼻 (2.08, 1.49, 2.0) → 戻した点 (2.0, 1.5, 2.0)。
  // 横（Z）は鼻から 2.0、正面方向（X）は耳から 1.98、高さ 1.5 → (1.98, 1.5, 2.0)
  const h6 = headCenter(pts({ [R_EAR]: [1.98, 1.5, 2.1], [NOSE]: [2.08, 1.49, 2.0] }), visAll({ [L_EAR]: 0, [L_EYE]: 0, [R_EYE]: 0 }), [1, 0, 0], { minVisibility: 0.5, neckM: 0.25 });
  check("固定値: 横を向いた人の片耳 + 鼻（正面 +X）→ (1.98, 1.5, 2.0)", h6 && nearV(h6.pos, [1.98, 1.5, 2.0], 1e-9) && h6.source === "ear-nose", JSON.stringify(h6));
  check("EYES_OFFSET は前 6cm・上 2cm", EYES_OFFSET.fwd === 0.06 && EYES_OFFSET.up === 0.02);
}

// ---- 手を挙げているか / 肩幅の尺度 / 写像 ----
{
  // 肩 y=1.25、頭の中心 y=1.5。挙手 = 手首 > 1.5 + 0.15 かつ同じ側の肘 > 肩
  const arm = (wristY, elbowY) => pts({ [L_SH]: [-0.2, 1.25, 2], [R_SH]: [0.2, 1.25, 2], [L_ELBOW]: [-0.3, 1.0, 2], [L_WRIST]: [-0.3, 0.8, 2], [R_ELBOW]: [0.3, elbowY, 2], [R_WRIST]: [0.3, wristY, 2] });
  check("RAISE_MARGIN_M は 15cm", RAISE_MARGIN_M === 0.15);
  check("固定値: 右手首 y=1.7（> 1.65）・右肘 y=1.4（> 肩 1.25）→ 挙げている", isHandRaised(arm(1.7, 1.4), visAll(), 1.5, 0.5) === true);
  check("固定値: 右手首が見えない（可視性 0.1）なら挙げていない", isHandRaised(arm(1.7, 1.4), visAll({ [R_WRIST]: 0.1 }), 1.5, 0.5) === false);
  check("固定値: 右肘が見えない（可視性 0.1）なら挙げていない", isHandRaised(arm(1.7, 1.4), visAll({ [R_ELBOW]: 0.1 }), 1.5, 0.5) === false);
  check("固定値: 手首 y=1.62 は 1.5 + 15cm に届かない → 挙げていない（頭の上に手を置く程度）", isHandRaised(arm(1.62, 1.4), visAll(), 1.5, 0.5) === false);
  check("固定値: 頭をかく（手首 y=1.7 でも右肘 y=1.2 が肩 1.25 より下）→ 挙げていない", isHandRaised(arm(1.7, 1.2), visAll(), 1.5, 0.5) === false);
  check("固定値: 左右は同じ側で見る（右手首が高く、左肘だけ肩より上）→ 挙げていない", isHandRaised(pts({ [L_SH]: [-0.2, 1.25, 2], [R_SH]: [0.2, 1.25, 2], [L_ELBOW]: [-0.3, 1.4, 2], [L_WRIST]: [-0.3, 1.0, 2], [R_ELBOW]: [0.3, 1.1, 2], [R_WRIST]: [0.3, 1.7, 2] }), visAll(), 1.5, 0.5) === false);
  const world = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0 }));
  world[L_SH] = { x: 0.15, y: -0.5, z: 0 };
  world[R_SH] = { x: -0.15, y: -0.5, z: 0 };
  check("固定値: worldLandmarks の肩の間 0.3m を肩幅 0.4m に合わせる倍率は 4/3", near(shoulderScale(world, visAll(), 0.4, 0.5), 4 / 3, 1e-12));
  // 1280x720・水平 FOV 90° → 焦点距離 640px。画像の (0.75, 0.5) は光軸から右へ 320px → 深度 1 で x = 0.5、(0.5, 0.25) は上へ 180px → y = 0.28125
  const m = webcamViewMapping(1280, 720, 90);
  const r1 = imageToRay(0.75, 0.5, m);
  const r2 = imageToRay(0.5, 0.25, m);
  check("固定値: 1280x720・水平 FOV 90° の写像で (0.75,0.5) → 視線 (0.5, 0)、(0.5,0.25) → (0, 0.28125)", near(r1.x, 0.5, 1e-12) && near(r1.y, 0, 1e-12) && near(r2.x, 0, 1e-12) && near(r2.y, 0.28125, 1e-12), `${JSON.stringify(r1)} ${JSON.stringify(r2)}`);
}

// ---- 合成の体の投影（向き合った人の左肩は画像の右に映る、という実世界の事実で符号を固定する）----
{
  // カメラ = field の原点で -Z を見る（fakeCameraToField(0,0,0, yaw 0, pitch 0) = 単位行列）。人は (0,0,-3) でカメラの方（+Z、ヨー 180°）を向く
  const camToField = fakeCameraToField([0, 0, 0], 0, 0);
  check("fakeCameraToField(原点, 0, 0) は単位行列", nearV(camToField, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]));
  const m = webcamViewMapping(1280, 720, 60);
  const shape = fakeShape(syntheticBodyShape(), 0.4, false);
  check("fakeShape: 肩幅が 0.4m に合う", near(Math.abs(shape[L_SH].x - shape[R_SH].x), 0.4, 1e-12));
  const body = fakeBodyInCamera({ head: [0, 0, -3], yawDeg: 180, raised: false }, shape, invertRigid(camToField));
  const res = fakePoseResult([body], m);
  const lm = res.landmarks[0];
  check("固定値: カメラの方を向いた人の左肩は画像の右（x > 0.5）、右肩は左（x < 0.5）", lm[L_SH].x > 0.5 && lm[R_SH].x < 0.5, `L=${lm[L_SH].x.toFixed(3)} R=${lm[R_SH].x.toFixed(3)}`);
  check("固定値: 頭（y=0 = カメラの高さ）は画像の縦の中央、肩はそれより下（y > 0.5）", near(lm[L_EAR].y, 0.5, 1e-9) && lm[L_SH].y > 0.5, `ear y=${lm[L_EAR].y.toFixed(3)} sh y=${lm[L_SH].y.toFixed(3)}`);
  const obs = observePerson(lm, res.worldLandmarks[0], { mapping: m, imageW: 1280, imageH: 720, camToField, shoulderM: 0.4, neckM: 0.25, eyeFwdM: 0, minVisibility: 0.5, qualityFullPx: 60 });
  check("固定値: その人の頭の中心は (0,0,-3)、ヨーは 180°（カメラの方）、正対で品質 > 0.9", obs && dist(obs.head, [0, 0, -3]) < 1e-6 && near(Math.abs(obs.yaw * DEG), 180, 1e-6) && obs.quality > 0.9, obs ? `head=${obs.head.map((v) => v.toFixed(4))} yaw=${(obs.yaw * DEG).toFixed(2)} q=${obs.quality.toFixed(2)}` : "null");
  // 1280px・FOV 60° の焦点距離 = 640/tan30° ≈ 1108.5px。肩幅 0.4m が深度 ≈ 3m → 約 148px
  check("固定値: 肩の画面上の幅 ≈ 0.4 × 1108.5 / 3 ≈ 148px（±3px。肩は頭と同じ深度）", obs && Math.abs(obs.shoulderPx - (0.4 * (640 / Math.tan(Math.PI / 6))) / 3) < 3, obs ? obs.shoulderPx.toFixed(1) : "null");
}

// ================= 2. 生成と往復（傾いたカメラ・いろいろな向き・ゴーグルで目が隠れる・肩幅の仮定違い）=================
{
  const camToField = fakeCameraToField([0, 0.5, 0.2], 180, 35);
  const fieldToCam = invertRigid(camToField);
  const m = webcamViewMapping(1280, 960, 68);
  const base = syntheticBodyShape();
  const opts = { mapping: m, imageW: 1280, imageH: 960, camToField, shoulderM: 0.4, neckM: 0.25, eyeFwdM: 0.1, minVisibility: 0.5, qualityFullPx: 60 };
  let worst = 0;
  let worstYaw = 0;
  for (const [head, yawDeg] of [[[-0.5, 0, 1.5], 0], [[0.5, 0, 1.5], 15], [[0.8, 0.1, 2.5], -30], [[-1.0, -0.1, 3.0], 60]]) {
    const body = fakeBodyInCamera({ head, yawDeg, raised: false }, fakeShape(base, 0.4, false), fieldToCam);
    const res = fakePoseResult([body], m);
    // ゴーグルで目が隠れる
    for (const i of [1, 2, 3, 4, 5, 6]) res.landmarks[0][i].visibility = 0.05;
    const o = observePerson(res.landmarks[0], res.worldLandmarks[0], opts);
    const fwd = [-Math.sin(yawDeg / DEG), 0, -Math.cos(yawDeg / DEG)];
    const expectPos = [head[0] + fwd[0] * 0.1, head[1], head[2] + fwd[2] * 0.1];
    if (!o) {
      worst = Infinity;
      continue;
    }
    worst = Math.max(worst, dist(o.pos, expectPos), dist(o.head, head));
    worstYaw = Math.max(worstYaw, Math.abs(o.yaw * DEG - yawDeg));
  }
  check("往復: 傾いたカメラで 4 人（ヨー 0/15/-30/60°、目は隠れる）の頭の中心と送る位置（正面へ 10cm）が 1mm 以内", worst < 1e-3, `worst=${worst}`);
  check("往復: ヨーが 0.01° 以内", worstYaw < 0.01, `worst=${worstYaw}`);

  // 耳も隠れる → 肩 + 首の長さ（合成の体の肩 → 耳は 0.23 × 0.4/0.36 ≈ 0.256m なので、首 0.25 の仮定で 1cm 以内）
  const body = fakeBodyInCamera({ head: [0, 0, 2], yawDeg: 0, raised: false }, fakeShape(base, 0.4, false), fieldToCam);
  const res = fakePoseResult([body], m);
  for (const i of [0, 1, 2, 3, 4, 5, 6, 7, 8]) res.landmarks[0][i].visibility = 0.05;
  const o = observePerson(res.landmarks[0], res.worldLandmarks[0], { ...opts, eyeFwdM: 0 });
  check("顔が全部隠れると肩の中点 + 首 0.25m に落ちる（source=shoulders、1cm 以内）", o && o.headSource === "shoulders" && dist(o.head, [0, 0, 2]) < 0.01, o ? `${o.headSource} err=${dist(o.head, [0, 0, 2]).toFixed(4)}` : "null");

  // 肩幅の仮定が 10% 大きい（実際 0.4m を 0.44m と仮定）→ 距離が約 10% 遠くに出る（精度は肩幅の仮定に依存する）
  const body2 = fakeBodyInCamera({ head: [0, 0, 2], yawDeg: 0, raised: false }, fakeShape(base, 0.4, false), fieldToCam);
  const res2 = fakePoseResult([body2], m);
  const o1 = observePerson(res2.landmarks[0], res2.worldLandmarks[0], { ...opts, eyeFwdM: 0 });
  const o2 = observePerson(res2.landmarks[0], res2.worldLandmarks[0], { ...opts, eyeFwdM: 0, shoulderM: 0.44 });
  const camPos = [0, 0.5, 0.2];
  const r1 = dist(o1.head, camPos);
  const r2 = dist(o2.head, camPos);
  check("肩幅の仮定が 10% 大きいと、カメラからの距離も約 10% 遠く出る（尺度の依存）", Math.abs(r2 / r1 - 1.1) < 0.01, `${r1.toFixed(3)}m → ${r2.toFixed(3)}m`);

  // 手を挙げた合成の体
  const up = fakeBodyInCamera({ head: [0.5, 0, 1.5], yawDeg: 15, raised: true }, fakeShape(base, 0.4, true), fieldToCam);
  const resUp = fakePoseResult([up], m);
  const oUp = observePerson(resUp.landmarks[0], resUp.worldLandmarks[0], opts);
  check("右手を挙げた合成の体は raised=true、位置は挙げていないときと同じ（1mm 以内）", oUp && oUp.raised === true && dist(oUp.head, [0.5, 0, 1.5]) < 1e-3, oUp ? `raised=${oUp.raised} head=${oUp.head.map((v) => v.toFixed(3))}` : "null");
  check("parseFakeBodiesParam: 4 つの数値の要素だけ", JSON.stringify(parseFakeBodiesParam("-0.5,0,1.5,0;0.5,0,1.5,15;x,1,2,3;1,2")) === JSON.stringify([{ head: [-0.5, 0, 1.5], yawDeg: 0, raised: false }, { head: [0.5, 0, 1.5], yawDeg: 15, raised: false }]));
}

// ================= 3. 割当（手を挙げた順）=================
{
  const assignedOf = (evs) => evs.filter((e) => e.kind === "assigned");
  const a = new PoseAssigner({ matchM: 0.6, lostMs: 2000, raiseHoldMs: 500 });
  const P = (x, raised = false, z = 1.5, score) => ({ pos: [x, 0, z], raised, ...(score === undefined ? {} : { score }) });
  const players = ["p1", "p2"];
  a.update([P(-0.5), P(0.5)], 0, players);
  check("割当: 2 人を検出、どちらも未割当、次は p1", a.tracks.length === 2 && a.tracks.every((t) => t.player === null) && a.nextPlayer(players) === "p1");
  // 右の人（0.5）が手を挙げる。500ms 続くまでは割り当てない
  let ev = a.update([P(-0.5), P(0.5, true)], 100, players);
  ev = ev.concat(a.update([P(-0.5), P(0.52, true)], 400, players));
  check("割当: 手を挙げて 500ms 経つまでは割り当てない", ev.length === 0);
  ev = a.update([P(-0.5), P(0.54, true)], 600, players);
  const right = a.tracks.find((t) => t.det.pos[0] > 0);
  check("割当: 500ms 挙げ続けた右の人に入室順の p1 が割り当たる（追跡で少し動いても同じ人）", ev.length === 1 && ev[0].kind === "assigned" && ev[0].player === "p1" && right.player === "p1" && a.nextPlayer(players) === "p2", JSON.stringify(ev));
  // 左の人が「p1 の割当の前から」挙げていた場合は数えない → 挙げ直すと p2
  const b = new PoseAssigner({ matchM: 0.6, lostMs: 2000, raiseHoldMs: 500 });
  b.update([P(-0.5, true), P(0.5, true)], 0, players);
  const first = b.update([P(-0.5, true), P(0.5, true)], 500, players);
  let second = [];
  for (let tt = 600; tt <= 1200; tt += 100) second = second.concat(b.update([P(-0.5, true), P(0.5, true)], tt, players));
  check("割当: 同時に挙げた 2 人は 1 人だけ割り当て、もう 1 人は挙げ続けても次のプレイヤーに流れ込まない", assignedOf(first).length === 1 && second.length === 0, JSON.stringify({ first, second }));
  const other = b.tracks.find((t) => t.player === null);
  b.update([P(other.det.pos[0], false), P(-other.det.pos[0], true)], 1300, players);
  b.update([P(other.det.pos[0], true), P(-other.det.pos[0], true)], 1400, players);
  b.update([P(other.det.pos[0], true), P(-other.det.pos[0], true)], 1650, players);
  const again = b.update([P(other.det.pos[0], true), P(-other.det.pos[0], true)], 1900, players);
  check("割当: 下ろして挙げ直すと次の p2 が割り当たる", again.length === 1 && again[0].player === "p2" && other.player === "p2", JSON.stringify(again));
  // p1 の人物が 1 フレーム 20cm ずつ後ろ（+Z）へ歩いても、検出の並び順が入れ替わっても同じ人物に付いていく
  let t = 600;
  for (let i = 0; i < 5; i++) {
    t += 66;
    a.update([P(0.54, false, 1.5 + 0.2 * (i + 1)), P(-0.5)], t, players);
  }
  const p1Track = a.trackOf("p1");
  check("追跡: 1 フレーム 20cm ずつ歩いても割当は同じ人物に付いていく（p1 は z=2.5 へ）", p1Track && near(p1Track.det.pos[2], 2.5, 1e-9) && a.tracks.length === 2 && !p1Track.pending, p1Track ? JSON.stringify(p1Track.det.pos) : "null");
  const jump = new PoseAssigner({ matchM: 0.6, lostMs: 2000, raiseHoldMs: 0 });
  jump.update([P(0, true)], 0, ["p1"]);
  jump.update([P(0.7)], 66, ["p1"]);
  check("追跡: 66ms で matchM（0.6m）より遠くへ跳んだ検出は別人（新しい未割当の人物）", jump.tracks.length === 2 && jump.tracks.find((tr) => tr.det.pos[0] === 0.7)?.player === null);
  const slow = new PoseAssigner({ matchM: 0.6, lostMs: 2000, raiseHoldMs: 0 });
  slow.update([P(0, true)], 0, ["p1"]);
  slow.update([P(0.7)], 200, ["p1"]);
  check("追跡: 距離の上限は経過時間に比例（200ms 空けば 0.6 × 200/66 ≈ 1.8m まで同じ人物）", slow.tracks.length === 1 && slow.trackOf("p1")?.det.pos[0] === 0.7);
  // 速度で予測: 1 フレーム 0.4m ずつ動く人は、予測位置（前回 + 速度）で追う
  const fast = new PoseAssigner({ matchM: 0.3, lostMs: 2000, raiseHoldMs: 0 });
  fast.update([P(0, true)], 0, ["p1"]);
  for (let i = 1; i <= 6; i++) fast.update([P(0.25 * i)], 66 * i, ["p1"]);
  check("追跡: 速度で予測するので、matchM 0.3m でも 1 フレーム 0.25m ずつ動く人に付いていく（予測との距離で見る）", fast.tracks.length === 1 && fast.trackOf("p1")?.det.pos[0] === 1.5, JSON.stringify(fast.tracks.map((x) => [x.key, x.player, x.det.pos[0]])));
  // 見失い: 0.5 秒以内なら同じ場所に戻ってきた人に割当が残る、超えたら外れる（自動では戻らない）
  a.update([P(-0.5)], t + 400, players);
  check("見失い: 0.4 秒ではまだ割当が残る", a.trackOf("p1") !== null);
  const back = a.update([P(0.54, false, 2.5), P(-0.5)], t + 466, players);
  check("見失い: 0.5 秒以内に戻れば同じ人物に復帰する", a.trackOf("p1") !== null && back.length === 0);
  const leftAt = t + 466;
  a.update([P(-0.5)], leftAt + 400, players);
  const rel = a.update([P(-0.5)], leftAt + 600, players);
  check("見失い: 0.5 秒を超えると p1 の割当が外れる（released lost。次は p1）", a.trackOf("p1") === null && a.nextPlayer(players) === "p1" && rel.some((e) => e.kind === "released" && e.player === "p1" && e.reason === "lost"), JSON.stringify(rel));
  a.update([P(0.54, false, 2.5), P(-0.5)], leftAt + 700, players);
  check("見失い: 0.5 秒を超えてから同じ場所に戻っても自動では割り当たらない", a.trackOf("p1") === null);
  a.update([P(-0.5)], leftAt + 2800, players);
  check("見失い: lostMs（2 秒）を超えた人物は一覧から消える", a.tracks.length === 1);
  // 1. 期限切れの人物は対応づけの前に消す（古い「挙げ始めた時刻」が新しい検出に引き継がれない）
  {
    const e = new PoseAssigner({ matchM: 0.6, lostMs: 3000, raiseHoldMs: 500 });
    e.update([P(0, true)], 0, []);
    e.update([P(0, true)], 100, []);
    const oldKey = e.tracks[0].key;
    const got = e.update([P(0, true)], 3200, ["p1"]);
    check("期限切れ: 3 秒途切れた後に同じ場所の検出は新しい人物（古い挙手の時刻を引き継がず、すぐには割り当たらない）", got.length === 0 && e.tracks.length === 1 && e.tracks[0].key !== oldKey && e.tracks[0].raisedSinceMs === 3200, JSON.stringify({ got, keys: e.tracks.map((x) => x.key) }));
  }
  // 割当のやり直し・退室
  const c = new PoseAssigner({ matchM: 0.6, lostMs: 2000, raiseHoldMs: 0 });
  c.update([P(0, true)], 0, ["p1"]);
  check("raiseHoldMs=0 なら挙げた瞬間に割り当たる", c.trackOf("p1") !== null);
  c.reset(10);
  check("reset: 全員未割当に戻り、挙げ続けている手は数えない", c.trackOf("p1") === null && c.update([P(0, true)], 20, ["p1"]).length === 0);
  c.update([P(0, false)], 30, ["p1"]);
  c.update([P(0, true)], 40, ["p1", "p2"]);
  check("reset 後に挙げ直すと割り当たる", c.trackOf("p1") !== null);
  c.update([P(0, false)], 50, ["p2"]);
  check("プレイヤーが退室すると（players から消える）その人物は未割当", c.tracks[0].player === null && c.nextPlayer(["p2"]) === "p2");

  // ---- 取り違えの防止（Fable の検算シナリオ S1〜S3・S5）----
  /** p1 を x=-0.5 の人物、p2 を x=+0.5 の人物に割り当てた状態（z=-2） */
  const Q = (x, raised = false, z = -2) => ({ pos: [x, 0, z], raised });
  const newAssigned = () => {
    const s = new PoseAssigner({ matchM: 0.6, lostMs: 2000, raiseHoldMs: 0 });
    s.update([Q(-0.5, true)], 0, players);
    s.update([Q(-0.5, false), Q(0.5, true)], 100, players);
    return s;
  };
  /** 入れ替わっていない: 各プレイヤーは未割当か、要確認（位置を送らない）か、真の位置に付いている */
  const notSwapped = (s, truth) =>
    Object.entries(truth).every(([p, x]) => {
      const tr = s.trackOf(p);
      return tr === null || tr.pending || Math.abs(tr.det.pos[0] - x) < 1e-9;
    });
  const who = (s) => s.tracks.map((x) => `#${x.key}:${x.player ?? "-"}${x.pending ? "?" : ""}@${x.det.pos[0].toFixed(2)}`).join(" ");
  {
    const s = newAssigned();
    check("S0: p1 / p2 が割り当たっている", s.trackOf("p1")?.det.pos[0] === -0.5 && s.trackOf("p2")?.det.pos[0] === 0.5, who(s));
    // p1 の人が t=200 で消え（p2 は見え続ける）、t=1500 に別人が x=-0.3 に現れる
    for (let tt = 200; tt < 1500; tt += 66) s.update([Q(0.5)], tt, players);
    s.update([Q(0.5), Q(-0.3)], 1500, players);
    const at = s.tracks.find((x) => Math.abs(x.det.pos[0] + 0.3) < 1e-9);
    check("S1: 割当済みの人が消えて 1.3 秒後に別人が近くに来ても、p1 を引き継がない", at && at.player !== "p1" && s.trackOf("p1") === null && s.trackOf("p2")?.det.pos[0] === 0.5, who(s));
  }
  {
    const s = newAssigned();
    let tt = 200;
    let xa = -0.5;
    let xb = 0.5;
    let everSwapped = false;
    for (let i = 0; i < 30; i++) {
      tt += 66;
      xa += 0.08;
      xb -= 0.08;
      s.update(i % 2 ? [Q(xa), Q(xb)] : [Q(xb), Q(xa)], tt, players);
      if (!notSwapped(s, { p1: xa, p2: xb })) everSwapped = true;
    }
    check("S2: 同じ深度ですれ違っても入れ替わらない（どのフレームでも、確定した割当は真の人に付いている）", !everSwapped, who(s));
  }
  {
    const s = newAssigned();
    let tt = 200;
    let xa = -0.5;
    let xb = 0.5;
    let everSwapped = false;
    for (let i = 0; i < 30; i++) {
      tt += 66;
      xa += 0.08;
      xb -= 0.08;
      s.update(i % 2 ? [Q(xa, false, -2), Q(xb, false, -2.4)] : [Q(xb, false, -2.4), Q(xa, false, -2)], tt, players);
      if (!notSwapped(s, { p1: xa, p2: xb })) everSwapped = true;
    }
    check("S2': 深度差 0.4m ですれ違っても入れ替わらない", !everSwapped, who(s));
  }
  {
    const s = newAssigned();
    s.update([Q(-0.2), Q(0.2)], 200, players);
    s.update([Q(-0.2), Q(0.2)], 266, players);
    check("S3: 割当済みの 2 人が 0.5m 以内に近づくと両方とも要確認", s.trackOf("p1")?.pending === true && s.trackOf("p2")?.pending === true, who(s));
    let tt = 266;
    for (let i = 0; i < 5; i++) {
      tt += 66;
      s.update([Q(0.0)], tt, players);
    }
    // 実際は p1 が右へ、p2 が左へ抜けた
    let everSwapped = false;
    for (const x of [0.2, 0.5, 0.8]) {
      tt += 66;
      s.update([Q(x), Q(-x)], tt, players);
      if (!notSwapped(s, { p1: x, p2: -x })) everSwapped = true;
    }
    check("S3: 重なって 1 人に見えてから左右を入れ替えて離れても、入れ替わった割当は確定しない", !everSwapped, who(s));
  }
  {
    // 近づいて元の側へ離れた（予測との差が明確）ならそのまま続く
    const s = newAssigned();
    let tt = 100;
    const path = [-0.4, -0.3, -0.22, -0.3, -0.4, -0.5, -0.6];
    for (const x of path) {
      tt += 66;
      s.update([Q(x), Q(-x)], tt, players);
    }
    const p1 = s.trackOf("p1");
    const p2 = s.trackOf("p2");
    check("要確認: 近づいて元の側へ離れた（予測との差が明確）なら割当はそのまま続き、要確認が解ける", p1 && p2 && !p1.pending && !p2.pending && p1.det.pos[0] === -0.6 && p2.det.pos[0] === 0.6, who(s));
  }
  {
    // 要確認のまま片方を 0.5 秒超えて見失うと、両方外れる
    const s = newAssigned();
    s.update([Q(-0.2), Q(0.2)], 166, players);
    let tt = 166;
    const evs = [];
    for (let i = 0; i < 10; i++) {
      tt += 66;
      evs.push(...s.update([Q(-0.2)], tt, players));
    }
    check("要確認: 片方が 0.5 秒を超えて見えないと、両方の割当が外れる（lost + ambiguous）", s.trackOf("p1") === null && s.trackOf("p2") === null && evs.some((e) => e.reason === "lost") && evs.some((e) => e.reason === "ambiguous"), JSON.stringify(evs));
  }
  {
    // S5: 同じ人物が 5cm ずれて 2 重に検出される
    const s = new PoseAssigner({ matchM: 0.6, lostMs: 2000, raiseHoldMs: 500 });
    s.update([Q(0, true)], 0, players);
    s.update([Q(0, true)], 600, players);
    s.update([Q(0, false)], 700, players);
    let tt = 700;
    const evs = [];
    for (let i = 0; i < 12; i++) {
      tt += 66;
      evs.push(...s.update([Q(0, true), Q(0.05, true)], tt, players));
    }
    check("S5: 同じ人物の重複検出（0.05m ずれ）はまとめられ、手を挙げても 2 人目が同じ人に割り当たらない", s.trackOf("p1") !== null && evs.length === 0 && s.tracks.length === 1, `${JSON.stringify(evs)} ${who(s)}`);
    const kept = dedupe([{ pos: [0, 0, 0], raised: false, score: 10 }, { pos: [0.2, 0, 0], raised: false, score: 20 }, { pos: [0.8, 0, 0], raised: false, score: 5 }], 0.3);
    check("dedupe: 0.3m 以内は可視性の合計（score）の大きい方を残し、離れた検出は残す", kept.length === 2 && kept[0].score === 20 && kept[1].score === 5, JSON.stringify(kept));
  }
}

// ================= 4. server（別パス）=================
const PORT = Number(process.env.PORT ?? "") || 5200;
const server = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], { stdio: ["ignore", "pipe", "pipe"] });
server.stderr.on("data", (d) => process.stderr.write(d));
server.stdout.on("data", (d) => {
  for (const line of d.toString().split("\n")) if (line.startsWith("[splatoon-pose-cam]") || line.startsWith("[splatoon-oi]")) console.log(line);
});
let serverExited = false;
server.on("exit", () => {
  serverExited = true;
});
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

async function waitForServer(timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (serverExited) return false;
    const res = await fetch(`https://localhost:${PORT}/`).catch(() => null);
    if (res?.ok) return true;
    await sleep(300);
  }
  return false;
}

function connect(path, query, name = "") {
  const q = new URLSearchParams({ v: String(SPLATOON_OUTSIDE_IN_PROTOCOL_VERSION), ...query });
  if (name) q.set("name", name);
  const ws = new WebSocket(`wss://localhost:${PORT}${path}?${q}`, { rejectUnauthorized: false, headers: { origin: `https://localhost:${PORT}` } });
  const client = { ws, msgs: [], closed: false };
  ws.on("message", (d) => client.msgs.push(JSON.parse(d.toString())));
  ws.on("close", () => {
    client.closed = true;
  });
  ws.on("error", () => {});
  client.waitFor = async (pred, timeoutMs = 3000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const m = client.msgs.find(pred);
      if (m) return m;
      await sleep(20);
    }
    return null;
  };
  client.send = (m) => ws.send(JSON.stringify(m));
  return client;
}

let exitCode = 1;
try {
  if (!(await waitForServer())) throw new Error(`dev サーバーが起動しなかった（ポート ${PORT} が使用中でないか確認）`);
  const cfg = { room: "test", markerId: "0", markerMm: "150", matchSec: "20", waitSec: "1" };
  const a = connect(SPLATOON_POSE_CAM_PATH, cfg, "Alice");
  const wa = await a.waitFor((m) => m.type === "welcome");
  check("サーバー: 08-8 のパスで入室でき、trackId（入室順に 10 から）が付く", wa && wa.role === "player" && wa.trackId === TRACK_ID_FIRST && wa.tracker.connected === 0, JSON.stringify({ trackId: wa?.trackId }));
  // 同じ room 名で 08-3 のパスに入っても別の Room（08-3 側の 1 人目なので trackId 10、peers は空）
  const oi = connect(SPLATOON_OUTSIDE_IN_PATH, cfg, "OtherDemo");
  const woi = await oi.waitFor((m) => m.type === "welcome");
  check("サーバー: 同じ room 名でも 08-3 のパスとは別の Room（peers が空・trackId 10）", woi && woi.peers.length === 0 && woi.trackId === TRACK_ID_FIRST, JSON.stringify({ peers: woi?.peers, trackId: woi?.trackId }));
  const b = connect(SPLATOON_POSE_CAM_PATH, cfg, "Bob");
  const wb = await b.waitFor((m) => m.type === "welcome");
  check("サーバー: 2 人目は trackId 11、peers に 1 人目（08-3 の人は入らない）", wb && wb.trackId === TRACK_ID_FIRST + 1 && wb.peers.length === 1 && wb.peers[0] === wa.id);
  await sleep(100);
  check("サーバー: 08-8 の入室は 08-3 の Room に配られない", !oi.msgs.some((m) => m.type === "join"));

  b.send({ type: "track", locked: true, players: [{ id: 10, pos: [0, 0, 1], yaw: 0, quality: 1 }] });
  check("サーバー: プレイヤーからの track は rejected: not tracker", (await b.waitFor((m) => m.type === "rejected" && m.reason === "not tracker")) !== null);
  b.send({ type: "shot", pos: [0, 0, 2], vel: [0, 0, -5], radius: 0.09 });
  check("サーバー: 割当前（未測定）のプレイヤーの shot は rejected: not tracked yet", (await b.waitFor((m) => m.type === "rejected" && m.reason === "not tracked yet")) !== null);

  const tr = connect(SPLATOON_POSE_CAM_PATH, { ...cfg, role: "tracker" });
  const wtr = await tr.waitFor((m) => m.type === "welcome");
  check("サーバー: トラッカーの welcome に全プレイヤーの trackIds（割当に使う）", wtr && wtr.role === "tracker" && wtr.trackIds[wa.id] === 10 && wtr.trackIds[wb.id] === 11, JSON.stringify(wtr?.trackIds));
  // 割当済みの人物のプレイヤーの trackId で送る。存在しない ID（12）は捨てる。範囲外の quality は丸ごと捨てる
  tr.send({ type: "track", locked: true, players: [{ id: 11, pos: [0.6, 0, 1.4], yaw: 0.2, quality: 0.8 }, { id: 12, pos: [0, 0, 2], yaw: 0, quality: 1 }] });
  const tb = await a.waitFor((m) => m.type === "tracked" && m.players.length > 0);
  check("サーバー: track の trackId 11 が Bob に引き当てられ、存在しないプレイヤー（12）は捨てられる", tb && tb.players.length === 1 && tb.players[0].player === wb.id && tb.players[0].pos[0] === 0.6, JSON.stringify(tb?.players));
  tr.send({ type: "track", locked: true, players: [{ id: 10, pos: [9, 0, 9], yaw: 0, quality: 1.5 }] });
  await sleep(150);
  check("サーバー: 範囲外の track（quality 1.5）は捨てられる", !a.msgs.some((m) => m.type === "tracked" && m.players.some((p) => p.pos[0] === 9)));
  // 頭の位置（発射の検証）は次の pose で測定値に更新される（08-3 のサーバーと同じ）
  b.send({ type: "pose", pos: [3, 3, 3], quat: [0, 0, 0, 1], tracking: true, fist: false });
  const poseB = await a.waitFor((m) => m.type === "pose" && m.id === wb.id);
  check("サーバー: pose の pos は自己申告ではなくトラッカーの測定値 (0.6,0,1.4) で配られる", poseB && nearV(poseB.pos, [0.6, 0, 1.4]), JSON.stringify(poseB?.pos));
  b.send({ type: "shot", pos: [0.6, 0, 1.2], vel: [0, 0, -5], radius: 0.09 });
  const shot = await a.waitFor((m) => m.type === "shot" && m.shot.by === wb.id);
  check("サーバー: 位置が届いた（割当済みの）プレイヤーは撃てて、着弾が配られる", shot && shot.shot.landing?.surfaceId === "wall");
  // dropMissing: track に Bob が居なくなったら未測定に戻り、pose は配られず、発射は "not tracked yet"
  tr.send({ type: "track", locked: true, players: [] });
  await sleep(150);
  a.msgs.length = 0;
  b.msgs.length = 0;
  b.send({ type: "pose", pos: [3, 3, 3], quat: [0, 0, 0, 1], tracking: true, fist: false });
  await sleep(300);
  b.send({ type: "shot", pos: [0.6, 0, 1.2], vel: [0, 0, -5], radius: 0.09 });
  const dropped = await b.waitFor((m) => m.type === "rejected" && m.reason === "not tracked yet");
  check("サーバー（08-8 の dropMissing）: track に居なくなったプレイヤーは発射が rejected: not tracked yet、pose も配られない", dropped !== null && !a.msgs.some((m) => m.type === "pose" && m.id === wb.id));
  tr.send({ type: "track", locked: true, players: [{ id: 11, pos: [0.6, 0, 1.4], yaw: 0.2, quality: 0.8 }] });
  const retracked = await a.waitFor((m) => m.type === "tracked" && m.players.some((p) => p.player === wb.id));
  b.send({ type: "pose", pos: [3, 3, 3], quat: [0, 0, 0, 1], tracking: true, fist: false });
  await sleep(300);
  b.send({ type: "shot", pos: [0.6, 0, 1.2], vel: [0, 0, -5], radius: 0.09 });
  check("サーバー（08-8）: 再び track に載れば撃てる", retracked !== null && (await a.waitFor((m) => m.type === "shot" && m.shot.by === wb.id)) !== null);
  tr.send({ type: "track", locked: false, players: [] });
  await sleep(150);
  b.msgs.length = 0;
  b.send({ type: "shot", pos: [0.6, 0, 1.2], vel: [0, 0, -5], radius: 0.09 });
  check("サーバー（08-8）: 原点が未確定の track（locked=false）で全員が未測定に戻る", (await b.waitFor((m) => m.type === "rejected" && m.reason === "not tracked yet")) !== null);

  // 08-3 のパス（オプション無し = 既定）は従来どおり: track に居なくなっても最後の測定位置で撃てる
  const oiTr = connect(SPLATOON_OUTSIDE_IN_PATH, { ...cfg, role: "tracker" });
  await oiTr.waitFor((m) => m.type === "welcome");
  oiTr.send({ type: "track", locked: true, players: [{ id: 10, pos: [0, 0, 1.4], yaw: 0, quality: 1 }] });
  await oi.waitFor((m) => m.type === "tracked" && m.players.length > 0);
  oiTr.send({ type: "track", locked: true, players: [] });
  await sleep(150);
  oi.send({ type: "pose", pos: [3, 3, 3], quat: [0, 0, 0, 1], tracking: true, fist: false });
  await sleep(300);
  oi.msgs.length = 0;
  oi.send({ type: "shot", pos: [0, 0, 1.2], vel: [0, 0, -5], radius: 0.09 });
  const oiShot = await oi.waitFor((m) => m.type === "shot" && m.shot.by === woi.id);
  check("サーバー（08-3 の既定）: track に居なくなっても最後の測定位置で撃てる（dropMissing は既定 false）", oiShot !== null && !oi.msgs.some((m) => m.type === "rejected"), JSON.stringify(oi.msgs.filter((m) => m.type === "rejected")));
  // マーカー ID との衝突: 08-3 は原点マーカーの ID（10）を避けて 11、08-8 は避けない（10）
  const cfg10 = { ...cfg, room: "collide", markerId: "10" };
  const c83 = connect(SPLATOON_OUTSIDE_IN_PATH, cfg10, "C83");
  const c88 = connect(SPLATOON_POSE_CAM_PATH, cfg10, "C88");
  const [w83, w88] = [await c83.waitFor((m) => m.type === "welcome"), await c88.waitFor((m) => m.type === "welcome")];
  check("サーバー: 原点マーカーが ID 10 のとき、08-3 は trackId 11（衝突を避ける）、08-8 は 10（checkTrackIdCollision: false）", w83?.trackId === 11 && w88?.trackId === 10, `${w83?.trackId} / ${w88?.trackId}`);
  for (const c of [oiTr, c83, c88]) c.ws.close();

  const tr2 = connect(SPLATOON_POSE_CAM_PATH, { ...cfg, role: "tracker" });
  await tr2.waitFor((m) => m.type === "welcome");
  tr2.send({ type: "track", locked: true, players: [{ id: 10, pos: [1, 0, 1], yaw: 0, quality: 1 }] });
  check("サーバー: 2 台目のトラッカーは rejected: not active tracker", (await tr2.waitFor((m) => m.type === "rejected" && m.reason === "not active tracker")) !== null);
  const bad = connect(SPLATOON_POSE_CAM_PATH, { ...cfg, v: "99" });
  check("サーバー: バージョン不一致は入室拒否", (await bad.waitFor((m) => m.type === "error" && /バージョン/.test(m.reason))) !== null);
  for (const c of [a, b, oi, tr, tr2]) c.ws.close();
  await sleep(200);

  const failed = results.filter(([, ok]) => !ok);
  console.log(failed.length === 0 ? "\nALL PASS" : `\n${failed.length} FAILED`);
  exitCode = failed.length === 0 ? 0 : 1;
} catch (e) {
  console.error("テストの実行エラー:", e.message ?? e);
} finally {
  server.kill();
}
process.exit(exitCode);
