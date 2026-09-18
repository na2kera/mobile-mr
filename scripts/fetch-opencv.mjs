// OpenCV.js（WASM 同梱の単一ファイル。約 10.9MB）を public/vendor/opencv/ に取得する。`npm run fetch:opencv` で実行する。
// 08-4（demos/08-4-splatoon-opencv）が実行時に fetch して読み込む。バイナリ相当なので git には入れない（.gitignore 済み）。
// 取得していなくても 08-4 のページは開け、HUD に読み込み失敗が出て js-aruco2（08 と同じ経路）にフォールバックする。
//
// 入手元と根拠:
//   - パッケージ: @techstark/opencv-js 4.12.0-release.1（npm。ライセンス Apache-2.0、OpenCV 本体と同じ）
//     https://www.npmjs.com/package/@techstark/opencv-js / https://github.com/TechStark/opencv-js
//   - 中身の dist/opencv.js は公式配布 https://docs.opencv.org/4.12.0/opencv.js そのもの（README に明記）。
//     公式サイトは Cloudflare の challenge でスクリプトから直接落とせないため、同じファイルを jsDelivr（npm ミラー）から取る
//   - このビルドに含まれること（Node で確認済み）: aruco_ArucoDetector / aruco_DetectorParameters / aruco_RefineParameters /
//     getPredefinedDictionary(DICT_ARUCO_MIP_36h12 = 21。js-aruco2 の ARUCO_MIP_36h12 と同じ ID・同じ向きのビット配列) /
//     solvePnP（SOLVEPNP_IPPE / ITERATIVE）/ Rodrigues / projectPoints。cornerSubPix は無いが CORNER_REFINE_SUBPIX は
//     ArucoDetector 内部で動く
//   - package.json の依存には足さない（scripts/fetch-models.mjs と同じ方針。ページは動的 import で読む）
//   - 取得したファイルは SHA-256 を固定して照合する（既存ファイルも新規ダウンロードも）。値は npm の tarball
//     （registry.npmjs.org の integrity sha512 と一致を確認）の package/dist/opencv.js / package/LICENSE から取った。
//     jsDelivr は gzip / brotli で返し content-length は圧縮後の大きさなので、サイズでは照合できない
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const OPENCV_VERSION = "4.12.0-release.1";
const BASE = `https://cdn.jsdelivr.net/npm/@techstark/opencv-js@${OPENCV_VERSION}/`;
const FILES = [
  { file: "opencv.js", url: `${BASE}dist/opencv.js`, sha256: "bd0c3e6448043de04f6a64a12cb7b759f78c3ab8f7c35c9f2e0f71c88bb17103" },
  { file: "LICENSE", url: `${BASE}LICENSE`, sha256: "c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4" },
];

const dir = fileURLToPath(new URL("../public/vendor/opencv/", import.meta.url));
await mkdir(dir, { recursive: true });
const mb = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}MB` : `${(n / 1e3).toFixed(1)}KB`);
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

for (const { file, url, sha256: expected } of FILES) {
  const dest = dir + file;
  const existing = await readFile(dest).catch(() => null);
  if (existing) {
    const actual = sha256(existing);
    if (actual === expected) {
      console.log(`skip: ${file} は取得済み (${mb(existing.length)}, sha256 一致)`);
      continue;
    }
    console.log(`再取得: ${file} の sha256 が固定値と違う (${actual})。途中で切れた・別の版の可能性`);
  }
  console.log(`fetch: ${url}`);
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`failed: HTTP ${res.status} ${url}`);
    process.exit(1);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const actual = sha256(buf);
  if (actual !== expected) {
    console.error(`failed: ${file} の sha256 が一致しない (${actual} != ${expected})。配布元の中身が変わった可能性（保存しない）`);
    process.exit(1);
  }
  await writeFile(dest, buf);
  console.log(`saved: public/vendor/opencv/${file} (${mb(buf.length)}, sha256 一致)`);
}
// バージョンを添えておく（HUD / README の照合用。opencv.js 自体には package のバージョンが入っていない）
await writeFile(`${dir}VERSION`, `@techstark/opencv-js ${OPENCV_VERSION} (= docs.opencv.org/4.12.0/opencv.js)\n`);
