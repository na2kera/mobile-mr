// AprilTag（tag36h11）の WASM 検出器を public/vendor/apriltag/ に取得する。`npm run fetch:apriltag` で実行する。
// demos/08-5-splatoon-apriltag（候補 1c。docs/space-stability-options.md §4）が使う。バイナリなので git には入れない（.gitignore 済み）。
// 取得していなくてもページは開け、HUD に `apriltag=error: …` と出て js-aruco2 の経路（?detector=aruco2 と同じ）に落ちる。
//
// 入手元: arenaxr/apriltag-js-standalone（apriltag の C ライブラリを Emscripten でビルドしたもの。ビルド済みが html/ 配下に置かれている）
//   https://github.com/arenaxr/apriltag-js-standalone
//   コミット f0fe55676265a1251ad36f18bac9939206a59e19（2026-08-21。タグは切られていないのでコミットで固定）
//   - apriltag_wasm.js / apriltag_wasm.wasm: emcc -Os -s MODULARIZE=1 -s EXPORT_NAME="AprilTagWasm"（Makefile 参照）。
//     クラシックな <script> で読むとグローバル AprilTagWasm（Promise を返すファクトリ）が定義される
//   - LICENSE: BSD-3-Clause（Copyright (c) 2020, The CONIX Research Center）
// 同じコミットのサブモジュール apriltag（.gitmodules の url = WiseLabCMU/apriltag。AprilRobotics/apriltag の fork）が指すコミット
//   4cdba6a8c6cf4efeb032fa5542da927d4677c035（GitHub API の contents で type=submodule の sha を確認。同じコミットは AprilRobotics/apriltag にもある）から:
//   - LICENSE.md → LICENSE.apriltag: BSD-2-Clause の全文（WASM の中身の C ライブラリ。配布物に含める）
//   - tag36h11.c: 符号表。配信には使わず、scripts/test-08-5-apriltag.mjs が tag36h11.ts の全 250 件と突き合わせるためだけに置く
// 完全性: 5 ファイルとも SHA-256 を下に固定し、既存ファイルも新規ダウンロードも照合する（不一致なら取り直し、それでも不一致ならエラー終了）
// ライセンス: ラッパー（apriltag-js-standalone）は BSD-3-Clause、中の apriltag C ライブラリ（AprilRobotics/apriltag。
//   WiseLabCMU の fork をサブモジュールで取り込んでいる）は BSD-2-Clause（Copyright (C) 2013-2016, The Regents of The University of Michigan）。
//   どちらも再配布時に著作権表示と免責の記載が要る。README（demos/08-5-splatoon-apriltag/README.md）にも書いてある
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const COMMIT = "f0fe55676265a1251ad36f18bac9939206a59e19";
const RAW = `https://raw.githubusercontent.com/arenaxr/apriltag-js-standalone/${COMMIT}/`;
/** サブモジュール apriltag が指すコミット（上のコミットの時点） */
const APRILTAG_COMMIT = "4cdba6a8c6cf4efeb032fa5542da927d4677c035";
const APRILTAG_RAW = `https://raw.githubusercontent.com/WiseLabCMU/apriltag/${APRILTAG_COMMIT}/`;
const FILES = [
  { file: "apriltag_wasm.js", url: `${RAW}html/apriltag_wasm.js`, sha256: "587c3b98f7e9a312d9f69dbb541c91741f9ee2df10c356362b05243041e3ddea" },
  { file: "apriltag_wasm.wasm", url: `${RAW}html/apriltag_wasm.wasm`, sha256: "0283215c40f3bcd265d2650aeb0d4419e87222830fe8a31a1978401a4cac77aa" },
  { file: "LICENSE", url: `${RAW}LICENSE`, sha256: "14b8f722e667e13c43a3b5e15283e92ec9a8e3b9d728eca6571d4d3a73a723a7" },
  { file: "LICENSE.apriltag", url: `${APRILTAG_RAW}LICENSE.md`, sha256: "3a99f2b7797dfbe2fd36e374e0123c06089fa49e6d7e44b3406570f758105d0b" },
  { file: "tag36h11.c", url: `${APRILTAG_RAW}tag36h11.c`, sha256: "ded6199c388e9d24104c0806eb11b27f9a77fc98ff6499178c0c5ca0f7e1fe55" },
];

const dir = fileURLToPath(new URL("../public/vendor/apriltag/", import.meta.url));
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
  console.log(`saved: public/vendor/apriltag/${file} (${(buf.length / 1e3).toFixed(0)}KB, SHA-256 一致)`);
}
