// Phase 9 (09-person-id) の回帰テスト。`npm run test:person` で実行する。
//   1. src/shared/body-math.ts — 合成の体（fake-body.ts）から深度・位置・頭の位置を復元できる、visibility の除外
//   2. src/shared/person-match.ts — 角度 + 距離のゲート付き 1 対 1 対応、追跡の継続、id のヒステリシスと一意性
//   3. server/person.ts — welcome / join / leave・pose と seen の中継と検証（Vite dev サーバーを起動して叩く）
// テストフレームワークは使わない（04〜08 と同じ方針）。Node 22.18+ は .ts をそのまま import できる
import { spawn } from "node:child_process";
import WebSocket from "ws";
import {
  BODY_LANDMARK_COUNT,
  LEFT_EYE,
  MIN_VISIBLE_POINTS,
  RIGHT_EYE,
  bodyHeadPoint,
  placeBodyLandmarks,
  scaleBody,
  solveBodyPlacement,
} from "../src/shared/body-math.ts";
import { PersonTracks, angleBetween, assignOptimal, matchPersons, nearestCandidate } from "../src/shared/person-match.ts";
import { eyesAboveHip, fakePoseResult, syntheticBodyShape } from "../src/shared/fake-body.ts";
import { MAX_PLAYERS, PERSON_PATH, PERSON_PROTOCOL_VERSION } from "../src/shared/person-protocol.ts";

const results = [];
function check(name, cond, detail = "") {
  results.push([name, cond]);
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${detail ? ` (${detail})` : ""}`);
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const deg = (d) => (d * Math.PI) / 180;

// ================= 1. body-math =================
{
  const mapping = { tanHalfFov: Math.tan(deg(35)), eyeAspect: 16 / 9, repeatX: 1, repeatY: 1 };
  const shape = syntheticBodyShape();
  const eyes = eyesAboveHip(shape);
  check("合成の体は 33 点、目は腰の約 0.75m 上", shape.length === BODY_LANDMARK_COUNT && near(eyes.y, 0.75, 1e-9));
  for (const depth of [1.5, 2.5, 4]) {
    const hip = { x: 0.3, y: -0.7, z: -depth };
    const r = fakePoseResult([{ shapeYUp: shape, hip }], mapping);
    const lm = r.landmarks[0];
    const world = r.worldLandmarks[0];
    check(`fakePoseResult: 33 点・visibility 1（${depth}m）`, lm.length === 33 && world.length === 33 && lm.every((l) => l.visibility === 1));
    const p = solveBodyPlacement(lm, world, mapping, 0.5);
    check(`深度 ${depth}m の体の並進を復元（x/y/depth）`, p && near(p.depth, depth, 1e-6) && near(p.x, hip.x, 1e-6) && near(p.y, hip.y, 1e-6) && p.used === 33, p ? `${p.x.toFixed(3)},${p.y.toFixed(3)},${p.depth.toFixed(3)} res=${p.residual.toExponential(1)}` : "null");
    const placed = placeBodyLandmarks(lm, world, p, mapping);
    const head = bodyHeadPoint(placed, lm, 0.5);
    check(`頭（両目の中点）は腰 + (${eyes.x.toFixed(2)}, ${eyes.y.toFixed(2)}, ${(-eyes.z).toFixed(2)})`, near(head.x, hip.x + eyes.x, 1e-6) && near(head.y, hip.y + eyes.y, 1e-6) && near(head.z, hip.z - eyes.z, 1e-6));
    check("目の点が両目の位置に置かれている", near(placed[LEFT_EYE].x, hip.x + shape[LEFT_EYE].x, 1e-6) && near(placed[RIGHT_EYE].x, hip.x + shape[RIGHT_EYE].x, 1e-6));
  }
  // 実寸補正: world を 2 倍にすると同じ見え方には 2 倍の深度が要る
  {
    const hip = { x: 0, y: -0.7, z: -2 };
    const r = fakePoseResult([{ shapeYUp: shape, hip }], mapping);
    const p2 = solveBodyPlacement(r.landmarks[0], scaleBody(r.worldLandmarks[0], 2), mapping, 0.5);
    check("bodyScale=2 で深度が 2 倍", p2 && near(p2.depth, 4, 1e-6), p2?.depth.toFixed(3));
  }
  // visibility の除外
  {
    const hip = { x: 0, y: -0.7, z: -2 };
    const r = fakePoseResult([{ shapeYUp: shape, hip }], mapping);
    const lm = r.landmarks[0].map((l, i) => ({ ...l, visibility: i < 33 - (MIN_VISIBLE_POINTS - 1) ? 0.1 : 1 }));
    check("可視点が足りなければ null", solveBodyPlacement(lm, r.worldLandmarks[0], mapping, 0.5) === null);
    const lm2 = r.landmarks[0].map((l, i) => ({ ...l, visibility: i >= 23 ? 0.1 : 1 }));
    const p = solveBodyPlacement(lm2, r.worldLandmarks[0], mapping, 0.5);
    check("下半身が見えなくても上半身だけで解ける（used=23）", p && p.used === 23 && near(p.depth, 2, 1e-6));
    const placed = placeBodyLandmarks(lm2, r.worldLandmarks[0], p, mapping);
    const lmNoEyes = lm2.map((l, i) => (i === LEFT_EYE || i === RIGHT_EYE ? { ...l, visibility: 0 } : l));
    const head = bodyHeadPoint(placed, lmNoEyes, 0.5);
    check("目が見えなければ頭は両耳の中点", near(head.x, 0, 1e-6) && near(head.y, hip.y + 0.73, 1e-6));
    const behind = fakePoseResult([{ shapeYUp: shape, hip: { x: 0, y: 0, z: 1 } }], mapping);
    check("カメラの後ろの体は visibility 0 → null", behind.landmarks[0].every((l) => l.visibility === 0) && solveBodyPlacement(behind.landmarks[0], behind.worldLandmarks[0], mapping, 0.5) === null);
  }
}

// 表示用 FOV と実カメラ FOV が違うとき（?fov= 固定など）: 深度と対応づけ用の頭は実カメラ FOV の視線で置く
{
  const metric = { tanHalfFov: Math.tan(deg(35)), eyeAspect: 16 / 9, repeatX: 1, repeatY: 1 };
  const display = { tanHalfFov: Math.tan(deg(60)), eyeAspect: 16 / 9, repeatX: 1, repeatY: 1 };
  const shape = syntheticBodyShape();
  const eyes = eyesAboveHip(shape);
  const hip = { x: 0.4, y: -0.7, z: -2 };
  const r = fakePoseResult([{ shapeYUp: shape, hip }], metric);
  const p = solveBodyPlacement(r.landmarks[0], r.worldLandmarks[0], metric, 0.5);
  const metricHead = bodyHeadPoint(placeBodyLandmarks(r.landmarks[0], r.worldLandmarks[0], p, metric), r.landmarks[0], 0.5);
  const displayHead = bodyHeadPoint(placeBodyLandmarks(r.landmarks[0], r.worldLandmarks[0], p, display), r.landmarks[0], 0.5);
  check("実カメラ FOV で置いた頭は真の位置", near(metricHead.x, hip.x + eyes.x, 1e-6) && near(metricHead.y, hip.y + eyes.y, 1e-6));
  check("表示 FOV で置いた頭は視線がずれる（対応づけに使ってはいけない）", Math.abs(displayHead.x - metricHead.x) > 0.3, `${displayHead.x.toFixed(2)} vs ${metricHead.x.toFixed(2)}`);
}

// ================= 2. person-match =================
{
  const opts = { angleTolRad: deg(12), depthTolM: 1.0 };
  check("angleBetween: 同じ向きは 0、直交は 90°", near(angleBetween({ x: 0, y: 0, z: -1 }, { x: 0, y: 0, z: -2 }), 0) && near(angleBetween({ x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }), Math.PI / 2));
  const detected = [
    { key: 1, pos: { x: 0, y: 0, z: -2 } },
    { key: 2, pos: { x: 1.5, y: 0, z: -2 } },
  ];
  const peers = [
    { id: "p2", pos: { x: 0.1, y: 0.05, z: -2.1 } },
    { id: "p3", pos: { x: 0, y: 0, z: 2 } },
  ];
  const m = matchPersons(detected, peers, opts);
  check("近い人に p2 が付き、1.5m 横の人と後ろのピアは対応なし", m.size === 1 && m.get(1)?.id === "p2" && !m.has(2), JSON.stringify([...m]));
  check("角度と距離のずれが結果に入る", m.get(1).angleRad < deg(4) && near(m.get(1).depthDiffM, Math.hypot(0.1, 0.05, 2.1) - 2, 1e-9));
  const m2 = matchPersons(
    [
      { key: 1, pos: { x: 0, y: 0, z: -2 } },
      { key: 2, pos: { x: 0.2, y: 0, z: -2 } },
    ],
    [{ id: "p2", pos: { x: 0.15, y: 0, z: -2 } }],
    opts,
  );
  check("1 対 1: 2 人が同じピアの近くなら、より近い方だけに付く", m2.size === 1 && m2.get(2)?.id === "p2");
  check("角度の許容を超えると対応なし", matchPersons([{ key: 1, pos: { x: 0.5, y: 0, z: -2 } }], [{ id: "p2", pos: { x: 0, y: 0, z: -2 } }], { angleTolRad: deg(10), depthTolM: 5 }).size === 0);
  check("距離の許容を超えると対応なし", matchPersons([{ key: 1, pos: { x: 0, y: 0, z: -2 } }], [{ id: "p2", pos: { x: 0, y: 0, z: -3.5 } }], opts).size === 0);
  check("同じ方向でも距離が許容内なら対応", matchPersons([{ key: 1, pos: { x: 0, y: 0, z: -2 } }], [{ id: "p2", pos: { x: 0, y: 0, z: -2.8 } }], opts).size === 1);
  // 交差する 2 人（外部レビューの反例）: 検出 0° / 10°、ピア 4° / -8°、許容 12°。
  // 貪欲（0°→4° を先に取る）だと 10°→-8° は 18° でゲート外になり 1 人しか付かないが、0°→-8°（8°）と 10°→4°（6°）なら両方付く
  const at = (angleDeg, id) => ({ id, pos: { x: 2 * Math.sin(deg(angleDeg)), y: 0, z: -2 * Math.cos(deg(angleDeg)) } });
  const cross = matchPersons(
    [
      { key: "a", pos: at(0).pos },
      { key: "b", pos: at(10).pos },
    ],
    [at(4, "p2"), at(-8, "p3")],
    opts,
  );
  check("交差する 2 人: 対応数が最大になる割当（a→p3, b→p2）を選ぶ（貪欲だと 1 人だけ）", cross.size === 2 && cross.get("a")?.id === "p3" && cross.get("b")?.id === "p2", JSON.stringify([...cross]));
  // いま付いている id の維持: 2 人のピアが両方許容内で、コスト差が keepBonus 未満なら現状維持、超えれば乗り換え
  const keepA = matchPersons([{ key: 1, pos: at(0).pos }], [at(3, "p2"), at(2, "p3")], opts, new Map([[1, "p2"]]));
  check("僅差なら現状の id（p2）を維持", keepA.get(1)?.id === "p2", keepA.get(1)?.id);
  const keepB = matchPersons([{ key: 1, pos: at(0).pos }], [at(9, "p2"), at(1, "p3")], opts, new Map([[1, "p2"]]));
  check("差が大きければ乗り換える（p3）", keepB.get(1)?.id === "p3", keepB.get(1)?.id);
  check("keepBonus=0 なら僅差でも近い方", matchPersons([{ key: 1, pos: at(0).pos }], [at(3, "p2"), at(2, "p3")], { ...opts, keepBonus: 0 }, new Map([[1, "p2"]])).get(1)?.id === "p3");

  // 追跡 + ヒステリシス
  const shape = syntheticBodyShape();
  const det = (x, z) => ({ points: shape.map((p) => ({ x: p.x + x, y: p.y, z: p.z + z })), head: { x, y: 0.75, z }, displayHead: { x, y: 0.75, z }, depth: -z, residual: 0, used: 33 });
  const tracks = new PersonTracks({ maxTracks: 2, smooth: 1, lostMs: 500, trackDistM: 0.5, idHoldMs: 1000, idStreak: 3 });
  tracks.apply([det(0, -2)], 0);
  check("最初の検出で追跡が 1 つできる（id なし）", tracks.live(0).length === 1 && tracks.live(0)[0].id === null);
  const peerAt = (x, z) => [{ id: "p2", pos: { x, y: 0.75, z } }];
  tracks.match(peerAt(0.05, -2.05), 0, opts);
  tracks.apply([det(0.02, -2)], 66);
  tracks.match(peerAt(0.05, -2.05), 66, opts);
  check("2 回連続ではまだ切り替わらない（idStreak=3）", tracks.live(66)[0].id === null && tracks.live(66)[0].candidate === "p2" && tracks.live(66)[0].candidateStreak === 2);
  tracks.apply([det(0.04, -2)], 132);
  tracks.match(peerAt(0.05, -2.05), 132, opts);
  check("3 回連続で最良なら id が付く", tracks.live(132)[0].id === "p2" && tracks.live(132).length === 1, `keys=${tracks.live(132).map((t) => t.key)}`);
  check("少し動いても同じ追跡（key が変わらない）", tracks.live(132)[0].key === 1);
  // ピアの pose が途切れても idHoldMs は保持（検出は lostMs 以内に続けて来る）
  for (const t of [200, 600, 1000]) {
    tracks.apply([det(0.04, -2)], t);
    tracks.match([], t, opts);
  }
  check("対応が取れなくても idHoldMs の間は保持", tracks.live(1000)[0].id === "p2" && tracks.live(1000)[0].key === 1);
  tracks.apply([det(0.04, -2)], 1300);
  tracks.match([], 1300, opts);
  check("idHoldMs を超えると id が外れる", tracks.live(1300)[0].id === null && tracks.live(1300)[0].key === 1);
  // 空フレーム（外部レビューの反例）: 人が消えたあと lostMs 以内の保持中に別のピアが凍結位置に来ても id は付かない
  {
    const t2 = new PersonTracks({ maxTracks: 2, smooth: 1, lostMs: 500, trackDistM: 0.5, idHoldMs: 1000, idStreak: 3 });
    for (const t of [0, 66, 132]) {
      t2.apply([det(0, -2)], t);
      t2.match(peerAt(0.05, -2.05), t, opts);
    }
    check("空フレーム前: p2 が付いている", t2.live(132)[0].id === "p2" && t2.detected(132).length === 1);
    for (const t of [200, 266, 332]) {
      t2.apply([], t);
      t2.match([{ id: "p3", pos: { x: 0, y: 0.75, z: -2 } }], t, opts);
    }
    const held = t2.live(332)[0];
    check("空フレームの間は候補を進めない（p3 に切り替わらない）。保持中は detected() に入らない", held && held.id === "p2" && held.candidateStreak === 0 && held.fresh === false && t2.detected(332).length === 0 && t2.live(332).length === 1, `${held?.id} streak=${held?.candidateStreak}`);
    t2.apply([], 1200);
    t2.match([], 1200, opts);
    check("保持中でも idHoldMs を過ぎれば id は外れる（lostMs は過ぎているので live からも消える）", t2.live(1200).length === 0);
  }
  // 2 人目は別の追跡
  tracks.apply([det(0.04, -2), det(1.5, -2)], 1400);
  check("1.5m 離れた検出は別の追跡になる", tracks.live(1400).length === 2 && tracks.live(1400).map((t) => t.key).join() === "1,2");
  // 一意性: p2 が A に付いた後、B の位置へ移ると A から外れて B に付く
  for (const t of [1400, 1466, 1532]) tracks.match(peerAt(0.05, -2.05), t, opts);
  const [a, b] = tracks.live(1532);
  check("A に p2", a.id === "p2" && b.id === null);
  for (const t of [1600, 1666, 1732]) {
    tracks.apply([det(0.04, -2), det(1.5, -2)], t);
    tracks.match(peerAt(1.5, -2.02), t, opts);
  }
  const [a2, b2] = tracks.live(1732);
  check("p2 が B の位置へ移ると、B に付いて A からは外れる（同じ id は 1 人だけ）", b2.id === "p2" && a2.id === null, `${a2.id} / ${b2.id}`);
  // ロスト: A（最後の検出 1732）は 2300 で消え、B（1800）は残る
  tracks.apply([det(1.5, -2)], 1800);
  tracks.update(2300);
  check("検出が途切れた追跡は lostMs で消える", tracks.live(2300).length === 1 && tracks.live(2300)[0].key === 2 && tracks.tracks.length === 1);
  tracks.update(3000);
  check("全部消える", tracks.live(3000).length === 0 && tracks.tracks.length === 0);
  // maxTracks と退避
  const t3 = new PersonTracks({ maxTracks: 1, smooth: 1, lostMs: 500, trackDistM: 0.5, idHoldMs: 1000, idStreak: 1 });
  t3.apply([det(0, -2), det(1.5, -2), det(-1.5, -2)], 0);
  check("maxTracks を超える検出は捨てる", t3.live(0).length === 1 && t3.live(0)[0].key === 1);
  t3.apply([det(1.5, -2)], 66);
  check("枠が保持中の追跡で埋まっていたら退避して、いま映っている人を優先する", t3.live(66).length === 1 && t3.live(66)[0].key === 2 && near(t3.live(66)[0].head.x, 1.5) && t3.tracks.length === 1);
  t3.apply([det(1.5, -2), det(-1.5, -2)], 132);
  check("全部が今回更新された追跡なら退避しない", t3.live(132).length === 1 && t3.live(132)[0].key === 2);
  // 追跡の継続も交差で取りこぼさない: 前回 x=0 / 0.4、今回 x=-0.4 / 0.1（閾値 0.5）。貪欲なら 0→0.1 だけ
  const t4 = new PersonTracks({ maxTracks: 2, smooth: 1, lostMs: 500, trackDistM: 0.5, idHoldMs: 1000, idStreak: 1 });
  t4.apply([det(0, -2), det(0.4, -2)], 0);
  const [k1, k2] = t4.live(0).map((t) => t.key);
  t4.apply([det(-0.4, -2), det(0.1, -2)], 66);
  const after = t4.live(66);
  check("交差する 2 人の継続: 両方とも同じ追跡が続く（0→-0.4, 0.4→0.1）", after.length === 2 && near(after.find((t) => t.key === k1)?.head.x ?? NaN, -0.4, 1e-9) && near(after.find((t) => t.key === k2)?.head.x ?? NaN, 0.1, 1e-9), JSON.stringify(after.map((t) => [t.key, t.head.x])));
  // 最寄り候補（許容外でも診断用に残る）
  const t5 = new PersonTracks({ maxTracks: 2, smooth: 1, lostMs: 500, trackDistM: 0.5, idHoldMs: 1000, idStreak: 1 });
  t5.apply([det(0, -2)], 0);
  t5.match([{ id: "p2", pos: { x: 1, y: 0.75, z: -2 } }], 0, opts);
  const t5a = t5.live(0)[0];
  const expectAngle = angleBetween({ x: 0, y: 0.75, z: -2 }, { x: 1, y: 0.75, z: -2 });
  check("許容外なら id は付かないが nearest にずれが残る（約 25°）", t5a.id === null && t5a.nearest?.id === "p2" && near(t5a.nearest.angleRad, expectAngle, 1e-9) && expectAngle > opts.angleTolRad, `${t5a.nearest?.angleRad}`);
  check("nearestCandidate: 候補なしは null", nearestCandidate({ x: 0, y: 0, z: -1 }, []) === null);
  // assignOptimal 単体: 同数ならコスト最小、打ち切りで見落とさない
  const a1 = assignOptimal([
    [{ ukey: "x", cost: 1 }, { ukey: "y", cost: 5 }],
    [{ ukey: "x", cost: 2 }],
  ]);
  check("assignOptimal: 数が最大の割当（0→y, 1→x）を選ぶ", a1[0] === 1 && a1[1] === 0);
  const a3 = assignOptimal([[{ ukey: "x", cost: -0.2 }], [{ ukey: "x", cost: 0.1 }, { ukey: "y", cost: 0.9 }]]);
  check("assignOptimal: 負のコスト（keepBonus）でも数が最大の割当（0→x, 1→y）", a3[0] === 0 && a3[1] === 1);
  check("assignOptimal: 候補なし", assignOptimal([[], []]).every((v) => v === null));
}

// ================= 3. server =================
const PORT = 5191;
const server = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], { stdio: ["ignore", "pipe", "pipe"] });
let portInUse = false;
server.stderr.on("data", (d) => {
  process.stderr.write(d);
  // 別の dev サーバーが同じポートに居残っていると、そちらに繋がって誤判定する（古いコードを叩く）ので止める
  if (/already in use/.test(d.toString())) portInUse = true;
});
server.stdout.on("data", (d) => {
  for (const line of d.toString().split("\n")) if (line.startsWith("[person]")) console.log(line);
});
let serverExited = false;
server.on("exit", () => {
  serverExited = true;
});
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

async function waitForServer(timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (serverExited || portInUse) return false;
    const res = await fetch(`https://localhost:${PORT}/`).catch(() => null);
    if (res?.ok) return true;
    await sleep(300);
  }
  return false;
}

function connect(query, name = "") {
  const q = new URLSearchParams({ v: String(PERSON_PROTOCOL_VERSION), ...query });
  if (name) q.set("name", name);
  const ws = new WebSocket(`wss://localhost:${PORT}${PERSON_PATH}?${q}`, {
    rejectUnauthorized: false,
    headers: { origin: `https://localhost:${PORT}` },
  });
  const client = { ws, msgs: [] };
  ws.on("message", (d) => client.msgs.push(JSON.parse(d.toString())));
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
  const cfg = { room: "test", markerId: "0", markerMm: "100" };
  const a = connect(cfg, "Alice");
  const wa = await a.waitFor((m) => m.type === "welcome");
  check("welcome: 自分の id と Player 一覧（自分・名前・色 1）", wa && wa.id === "p1" && wa.players.length === 1 && wa.players[0].name === "Alice" && wa.players[0].color === 1);
  const b = connect(cfg, "Bob");
  const wb = await b.waitFor((m) => m.type === "welcome");
  check("2 人目は色 2・一覧に p1 と自分", wb && wb.players.length === 2 && wb.players.find((p) => p.id === wb.id).color === 2 && wb.players.some((p) => p.id === "p1"));
  const ja = await a.waitFor((m) => m.type === "join");
  check("join に Player（名前・色）が付く", ja && ja.player.id === wb.id && ja.player.name === "Bob" && ja.player.color === 2);

  b.send({ type: "pose", pos: [0.5, 0, 1.5], quat: [0, 0, 0, 2], tracking: true, seen: [{ id: "p1", pos: [0.1, 0.2, 0.3] }, { id: "p9", pos: [1, 1, 1] }, { id: null, pos: [2, 2, 2] }, { id: wb.id, pos: [3, 3, 3] }] });
  const pa = await a.waitFor((m) => m.type === "pose" && m.id === wb.id);
  check("pose が中継され quat は正規化", pa && Math.abs(pa.quat[3] - 1) < 1e-9 && pa.pos[0] === 0.5 && pa.tracking === true);
  check("seen: 存在する id はそのまま、存在しない id と自分自身は null に落ちる", pa && pa.seen.length === 4 && pa.seen[0].id === "p1" && pa.seen[1].id === null && pa.seen[2].id === null && pa.seen[3].id === null && pa.seen[1].pos[0] === 1);
  const before = a.msgs.filter((m) => m.type === "pose").length;
  b.send({ type: "pose", pos: [0, 0, 1], quat: [0, 0, 0, 1], tracking: true, seen: [{ id: "x", pos: [0, 0, 0] }] });
  b.send({ type: "pose", pos: [0, 0, 1], quat: [0, 0, 0, 1], tracking: true, seen: [{ id: "p1", pos: [0, 0, 1e9] }] });
  b.send({ type: "pose", pos: [0, 0, 1], quat: [0, 0, 0, 1], tracking: true, seen: Array.from({ length: MAX_PLAYERS + 1 }, () => ({ id: null, pos: [0, 0, 0] })) });
  b.send({ type: "pose", pos: [0, 0, 1], quat: [0, 0, 0, 0], tracking: true });
  b.send({ type: "pose", pos: [7, 7, 7], quat: [0, 0, 0, 1], tracking: false });
  const pa2 = await a.waitFor((m) => m.type === "pose" && m.pos[0] === 7);
  check("不正な seen（形式外の id・巨大な座標・件数超過）や零クォータニオンは捨て、正しい pose だけ届く", pa2 && a.msgs.filter((m) => m.type === "pose").length === before + 1 && pa2.seen === undefined);

  const bad = connect({ ...cfg, markerMm: "200" });
  const err = await bad.waitFor((m) => m.type === "error");
  check("空間設定が違う端末は入室拒否", err && /不一致/.test(err.reason));

  b.ws.close();
  const la = await a.waitFor((m) => m.type === "leave");
  check("leave が届く", la && la.id === wb.id);
  const c = connect(cfg, "Carol");
  const wc = await c.waitFor((m) => m.type === "welcome");
  check("退出者の色（2）は次の人に再利用される", wc && wc.players.find((p) => p.id === wc.id).color === 2);
  a.ws.close();
  c.ws.close();
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
