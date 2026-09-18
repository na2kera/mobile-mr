// 比較実験（08-2〜08-8。docs/space-stability-options.md）を実機で試す前に、その方式が本当に動く状態かを確かめる。
// `node scripts/preflight-stability.mjs`（全方式）/ `node scripts/preflight-stability.mjs 08-4 08-5`（指定した方式だけ）。
//
// なぜ要るか: どの方式も「外部のものが読めなければ 08 と同じ経路に落ちる」フォールバックを持っている。
// 気づかずにフォールバックしたまま試すと、測っているのは 08 であって、その方式ではない（比較が無効になる）。
// このスクリプトは「ページを開く前に PC 側で分かること」（取得済みのファイル・モデル・ポートの空き）だけを見る。
// ブラウザでしか分からないこと（本当にその検出器が使われているか）は、HUD の表示で確かめる（下の「HUD で確かめること」）。
//
// package.json には登録していない（比較用の 7 本の PR が package.json を触っていて、衝突を増やさないため）。
import { existsSync, statSync, readdirSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const at = (p) => `${root}${p}`;

/** 方式ごとの前提。ports は「ヘッドレス確認が使う Vite / CDP」で、実機では使わないが、他の worktree と衝突していないかの目安になる */
const METHODS = [
  {
    id: "08-2",
    dir: "demos/08-2-splatoon-fixed",
    name: "一度合わせて固定",
    needs: [],
    ports: [5197, 9342],
    physical: ["08 と同じ紙の ArUco（150mm 推奨）", "マーカーの正面 0.8〜1.2m に立てる場所"],
    hud: ["align=locked（確定した）", "obs= が動いてもコートが動かないこと"],
  },
  {
    id: "08-3",
    dir: "demos/08-3-splatoon-outside-in",
    name: "アウトサイドイン（PC カメラ + ゴーグルのマーカー）",
    needs: [],
    ports: [5201, 9344],
    physical: [
      "PC と Web カメラ（部屋に固定。コート全体が入る位置）",
      "原点用の紙の ArUco（150mm）",
      "ゴーグル前面に貼る ArUco（ID 10, 11, …。60〜80mm。markers.html で印刷）",
    ],
    hud: ["トラッカーの枠で「原点を確定」できた", "スマホの track=id=10 … と self=(…)"],
  },
  {
    id: "08-4",
    dir: "demos/08-4-splatoon-opencv",
    name: "OpenCV.js（全マーカーを 1 つの board にして solvePnP）",
    needs: [{ path: "public/vendor/opencv/opencv.js", minMB: 5, how: "npm run fetch:opencv" }],
    ports: [5203, 9345],
    physical: ["08 と同じ紙の ArUco（複数枚。原点 + 壁 / 床）"],
    hud: ["pose=opencv（aruco2 ならフォールバックしている）", "reproj= が 1〜2px"],
  },
  {
    id: "08-5",
    dir: "demos/08-5-splatoon-apriltag",
    name: "AprilTag（tag36h11 の WASM）",
    needs: [
      { path: "public/vendor/apriltag/apriltag_wasm.js", minMB: 0.05, how: "npm run fetch:apriltag" },
      { path: "public/vendor/apriltag/apriltag_wasm.wasm", minMB: 0.05, how: "npm run fetch:apriltag" },
    ],
    ports: [5205, 9346],
    physical: ["**tag36h11 の印刷**（ArUco とは絵柄が違う。markers.html から印刷し直す）"],
    hud: ["detector=apriltag apriltag=ready（aruco2 ならフォールバックしている）"],
  },
  {
    id: "08-6",
    dir: "demos/08-6-splatoon-screen-markers",
    name: "画面マーカー（モニタ / プロジェクタ）",
    needs: [],
    ports: [5211, 9351],
    physical: [
      "モニタかプロジェクタ（Chrome のズームは 100%）",
      "定規（画面の 100mm の較正線を当てて確かめる）",
      "プロジェクタなら台形補正を切る",
    ],
    hud: ["画面マーカーのページで「room に反映」が押せる（赤い警告が出ていない）", "スマホの marker= に複数 ID"],
  },
  {
    id: "08-7",
    dir: "demos/08-7-splatoon-alva",
    name: "AlvaAR（単眼 SLAM。GPLv3）",
    needs: [
      { path: "public/vendor/alva/alva_ar.js", minMB: 1, how: "npm run fetch:alva" },
      { path: "public/vendor/alva/LICENSE", minMB: 0, how: "npm run fetch:alva" },
      { path: "public/vendor/alva/SOURCE.txt", minMB: 0, how: "npm run fetch:alva" },
    ],
    ports: [5207, 9347],
    physical: ["08 と同じ紙の ArUco", "較正のためマーカーを見ながら 15cm 以上動ける場所"],
    hud: ["slam=tracking（off / failed ならマーカーのみで動いている）", "較正後に fix= が出ている"],
  },
  {
    id: "08-8",
    dir: "demos/08-8-splatoon-pose-cam",
    name: "Pose カメラ（PC カメラ + MediaPipe Pose）",
    needs: [{ path: "public/models/pose_landmarker_lite.task", minMB: 1, how: "npm run fetch:models" }],
    ports: [5199, 9343],
    physical: [
      "PC と Web カメラ（部屋に固定）",
      "原点用の紙の ArUco（150mm）",
      "入室順に手を挙げる段取り（ゴーグルのマーカーは不要）",
    ],
    hud: ["トラッカーの枠に人物が出て、割当が付く", "スマホの track= と self=(…)"],
  },
];

/** 全方式で要るもの（08 と同じ） */
const COMMON = [{ path: "public/models/hand_landmarker.task", minMB: 1, how: "npm run fetch:models" }];

function checkFile({ path, minMB, how }) {
  const full = at(path);
  if (!existsSync(full)) return { ok: false, text: `無い（${how}）` };
  const mb = statSync(full).size / 1024 / 1024;
  if (mb < minMB) return { ok: false, text: `小さすぎる ${mb.toFixed(1)}MB（${how} で取り直す）` };
  return { ok: true, text: `${mb.toFixed(1)}MB` };
}

function portFree(port) {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => s.close(() => resolve(true)));
    s.listen(port, "127.0.0.1");
  });
}

const want = process.argv.slice(2).map((s) => s.replace(/^demos\//, "").slice(0, 4));
const methods = METHODS.filter((m) => want.length === 0 || want.includes(m.id));
if (methods.length === 0) {
  console.error(`知らない方式: ${want.join(" ")}（${METHODS.map((m) => m.id).join(" / ")}）`);
  process.exit(2);
}

let ng = 0;
console.log("== 全方式で要るもの ==");
for (const f of COMMON) {
  const r = checkFile(f);
  if (!r.ok) ng++;
  console.log(`${r.ok ? "OK  " : "NG  "} ${f.path}: ${r.text}`);
}

for (const m of methods) {
  console.log(`\n== ${m.id} ${m.name} ==`);
  if (!existsSync(at(m.dir))) {
    console.log(`SKIP ${m.dir} がまだ無い（その PR がマージされていない）`);
    continue;
  }
  for (const f of m.needs) {
    const r = checkFile(f);
    if (!r.ok) ng++;
    console.log(`${r.ok ? "OK  " : "NG  "} ${f.path}: ${r.text}`);
  }
  if (m.needs.length === 0) console.log("OK   取得が要る外部のファイルは無い");
  for (const p of m.ports) {
    const free = await portFree(p);
    console.log(`${free ? "OK  " : "使用中"} ポート ${p}${free ? "" : "（他の worktree の確認が動いている。実機の確認には影響しない）"}`);
  }
  console.log("     用意するもの:");
  for (const x of m.physical) console.log(`       - ${x}`);
  console.log("     ページを開いたら HUD で確かめること:");
  for (const x of m.hud) console.log(`       - ${x}`);
}

console.log("\n== room 名 ==");
console.log("  試行ごとに一意の room 名を使う（例: stability-08-4-r03）。");
console.log("  08 / 08-2 / 08-4 / 08-5 / 08-6 / 08-7 は同じ WebSocket のパスを使うので、room 名が同じで設定も同じだと別方式の端末が混ざる。");
console.log("  空の room はサーバーに 60 秒残るので、同じ名前をすぐ再利用しない。");
const vendor = at("public/vendor");
if (existsSync(vendor)) {
  const dirs = readdirSync(vendor);
  if (dirs.includes("alva")) {
    console.log("\n== 公開ビルドの注意 ==");
    console.log("  public/vendor/alva/ がある。vite build するとそのまま dist/vendor/alva/ に入り、GPLv3 の配布になる。");
    console.log("  公開ビルドに含めないなら、ビルド前に public/vendor/alva/ を消す。含めるなら LICENSE と SOURCE.txt を同じ場所に置いたままにする。");
  }
}

console.log(ng === 0 ? "\nALL OK" : `\n${ng} 件の準備が足りない`);
process.exit(ng === 0 ? 0 : 1);
