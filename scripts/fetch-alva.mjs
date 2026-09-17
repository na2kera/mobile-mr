// AlvaAR（WebAssembly の単眼 SLAM）のビルド済みファイルを public/vendor/alva/ に取得する。`npm run fetch:alva` で実行する。
// demos/08-7-splatoon-alva（候補 3a。docs/space-stability-options.md §4）だけが使う。git には入れない（.gitignore 済み）。
// 取得していなくてもページは開け、HUD に「slam=off (読み込み失敗)」と出て 08 と同じ「マーカーのみ」に落ちる。
//
// 入手元: alanross/AlvaAR https://github.com/alanross/AlvaAR
//   コミット 7796af500ee92001ac2a9888363ff64d7a3bee75（2023-07-03 "Fix for OpenCV build location"。タグ・リリースは無いのでコミットで固定）
//   - dist/alva_ar.js（約 4.3MB）: Emscripten の出力（WASM は base64 で埋め込み済み）+ AlvaAR クラス。ES module で `export { AlvaAR }`。
//     API: `await AlvaAR.Initialize(width, height, fov = 45)` → `alva.findCameraPose(imageData)`（Float32Array(16) の姿勢 or null）
//   - dist/alva_ar_three.js: 姿勢を Three.js のカメラに当てる例（x 反転の四元数 / y・z 反転の位置）。座標系の確認用に置くだけで読まない
//   - LICENSE: GPLv3 の全文
// 完全性: 3 ファイルとも SHA-256 を下に固定し、既存ファイルも新規ダウンロードも照合する（不一致なら取り直し、それでも不一致ならエラー終了）
// ライセンス: **GPLv3**（AlvaAR 本体、および元になった OV²SLAM / ORB-SLAM2 も GPLv3）。
//   このデモ（実験）限定で使い、Mobile MR SDK には入れない。配布（ビルド成果物の公開）をするなら GPLv3 の義務（ソースの提供等）が
//   掛かるので、公開ビルドに含めないこと。demos/08-7-splatoon-alva/README.md の冒頭にも書いてある。C++ からのビルドはしない
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const COMMIT = "7796af500ee92001ac2a9888363ff64d7a3bee75";
const RAW = `https://raw.githubusercontent.com/alanross/AlvaAR/${COMMIT}/`;
const FILES = [
  { file: "alva_ar.js", url: `${RAW}dist/alva_ar.js`, sha256: "94e95644869c899ee89608f1b812a9df0ef13eb8b34df008ec518fea1643f779" },
  { file: "alva_ar_three.js", url: `${RAW}dist/alva_ar_three.js`, sha256: "67554116f36fc4e03b3a49a26e0b4d29f9ae049735ed262749553b0d5d8a71a9" },
  { file: "LICENSE", url: `${RAW}LICENSE`, sha256: "3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986" },
];

const dir = fileURLToPath(new URL("../public/vendor/alva/", import.meta.url));
await mkdir(dir, { recursive: true });

const sha256Of = (buf) => createHash("sha256").update(buf).digest("hex");

for (const { file, url, sha256 } of FILES) {
  const dest = dir + file;
  const existing = await readFile(dest).catch(() => null);
  if (existing) {
    const actual = sha256Of(existing);
    if (actual === sha256) {
      console.log(`skip: ${file} は取得済み・SHA-256 一致 (${(existing.length / 1e3).toFixed(0)}KB)`);
      continue;
    }
    console.log(`再取得: ${file} の SHA-256 が固定値と違う (${actual})`);
  }
  console.log(`fetch: ${url}`);
  const res = await fetch(url).catch((e) => {
    console.error(`failed: ${e.message ?? e} ${url}`);
    process.exit(1);
  });
  if (!res.ok) {
    console.error(`failed: HTTP ${res.status} ${url}`);
    process.exit(1);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const actual = sha256Of(buf);
  if (actual !== sha256) {
    console.error(`failed: ${file} の SHA-256 が一致しない (expected ${sha256}, got ${actual}) ${url}`);
    process.exit(1);
  }
  await writeFile(dest, buf);
  console.log(`saved: public/vendor/alva/${file} (${(buf.length / 1e3).toFixed(0)}KB, SHA-256 一致)`);
}
