// AprilTag（tag36h11）の WASM 検出器を public/vendor/apriltag/ に取得する。`npm run fetch:apriltag` で実行する。
// demos/08-5-splatoon-apriltag（候補 1c。docs/space-stability-options.md §4）が使う。バイナリなので git には入れない（.gitignore 済み）。
// 取得していなくてもページは開け、HUD に「apriltag: 読み込み失敗」と出て js-aruco2 の経路（?detector=aruco2 と同じ）に落ちる。
//
// 入手元: arenaxr/apriltag-js-standalone（apriltag の C ライブラリを Emscripten でビルドしたもの。ビルド済みが html/ 配下に置かれている）
//   https://github.com/arenaxr/apriltag-js-standalone
//   コミット f0fe55676265a1251ad36f18bac9939206a59e19（2026-08-21。タグは切られていないのでコミットで固定）
//   - apriltag_wasm.js / apriltag_wasm.wasm: emcc -Os -s MODULARIZE=1 -s EXPORT_NAME="AprilTagWasm"（Makefile 参照）。
//     クラシックな <script> で読むとグローバル AprilTagWasm（Promise を返すファクトリ）が定義される
//   - LICENSE: BSD-3-Clause（Copyright (c) 2020, The CONIX Research Center）
// ライセンス: ラッパー（apriltag-js-standalone）は BSD-3-Clause、中の apriltag C ライブラリ（AprilRobotics/apriltag。
//   WiseLabCMU の fork をサブモジュールで取り込んでいる）は BSD-2-Clause（Copyright (C) 2013-2016, The Regents of The University of Michigan）。
//   どちらも再配布時に著作権表示と免責の記載が要る。README（demos/08-5-splatoon-apriltag/README.md）にも書いてある
import { mkdir, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const COMMIT = "f0fe55676265a1251ad36f18bac9939206a59e19";
const RAW = `https://raw.githubusercontent.com/arenaxr/apriltag-js-standalone/${COMMIT}/`;
const FILES = [
  { file: "apriltag_wasm.js", url: `${RAW}html/apriltag_wasm.js` },
  { file: "apriltag_wasm.wasm", url: `${RAW}html/apriltag_wasm.wasm` },
  { file: "LICENSE", url: `${RAW}LICENSE` },
];

const dir = fileURLToPath(new URL("../public/vendor/apriltag/", import.meta.url));
await mkdir(dir, { recursive: true });

for (const { file, url } of FILES) {
  const dest = dir + file;
  const existing = await stat(dest).catch(() => null);
  if (existing && existing.size > 0) {
    // 途中で切れたファイルを取得済みと誤認しないよう、配布元のサイズと照合する（HEAD が失敗したらサイズ不明として取得済み扱い）
    // raw.githubusercontent.com は .js を gzip で返し content-length は圧縮後のサイズなので、content-encoding があるときはサイズ不明扱い
    const expected = await fetch(url, { method: "HEAD" })
      .then((r) => {
        const len = r.ok && !r.headers.get("content-encoding") ? r.headers.get("content-length") : null;
        return len === null ? NaN : Number(len);
      })
      .catch(() => NaN);
    if (!Number.isFinite(expected) || expected === existing.size) {
      console.log(`skip: ${file} は取得済み (${(existing.size / 1e3).toFixed(0)}KB)`);
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
  await writeFile(dest, buf);
  console.log(`saved: public/vendor/apriltag/${file} (${(buf.length / 1e3).toFixed(0)}KB)`);
}
