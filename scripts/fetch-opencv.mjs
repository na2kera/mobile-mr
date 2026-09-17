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
import { mkdir, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const OPENCV_VERSION = "4.12.0-release.1";
const BASE = `https://cdn.jsdelivr.net/npm/@techstark/opencv-js@${OPENCV_VERSION}/`;
const FILES = [
  { file: "opencv.js", url: `${BASE}dist/opencv.js`, minBytes: 5_000_000 },
  { file: "LICENSE", url: `${BASE}LICENSE`, minBytes: 1_000 },
];

const dir = fileURLToPath(new URL("../public/vendor/opencv/", import.meta.url));
await mkdir(dir, { recursive: true });

for (const { file, url, minBytes } of FILES) {
  const dest = dir + file;
  const existing = await stat(dest).catch(() => null);
  if (existing && existing.size >= minBytes) {
    // 途中で切れたファイルを取得済みと誤認しないよう、配布元のサイズと照合する（HEAD が失敗したらサイズ不明として取得済み扱い）
    // jsDelivr は gzip / brotli で返し content-length は圧縮後の大きさなので、圧縮されているときは照合しない
    const expected = await fetch(url, { method: "HEAD" })
      .then((r) => {
        const len = r.ok && !r.headers.get("content-encoding") ? r.headers.get("content-length") : null;
        return len === null ? NaN : Number(len);
      })
      .catch(() => NaN);
    if (!Number.isFinite(expected) || expected === existing.size) {
      console.log(`skip: ${file} は取得済み (${(existing.size / 1e6).toFixed(1)}MB)`);
      continue;
    }
    console.log(`再取得: ${file} のサイズが配布元と違う (${existing.size} != ${expected})`);
  }
  console.log(`fetch: ${url}`);
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`failed: HTTP ${res.status} ${url}`);
    process.exit(1);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const declared = res.headers.get("content-encoding") ? NaN : Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > 0 && declared !== buf.length) {
    console.error(`failed: サイズが一致しない (${buf.length} != ${declared}) ${url}`);
    process.exit(1);
  }
  if (buf.length < minBytes) {
    console.error(`failed: ${file} が小さすぎる (${buf.length} bytes)。配布元の構成が変わった可能性`);
    process.exit(1);
  }
  await writeFile(dest, buf);
  console.log(`saved: public/vendor/opencv/${file} (${(buf.length / 1e6).toFixed(1)}MB)`);
}
// バージョンを添えておく（HUD / README の照合用。opencv.js 自体には package のバージョンが入っていない）
await writeFile(`${dir}VERSION`, `@techstark/opencv-js ${OPENCV_VERSION} (= docs.opencv.org/4.12.0/opencv.js)\n`);
