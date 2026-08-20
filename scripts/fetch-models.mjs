// MediaPipe のモデル（hand_landmarker.task, 約 7.8MB）を public/models/ に取得する。
// `npm run fetch:models` で実行する。バイナリなので git には入れない（.gitignore 済み）。
// 取得していなくてもデモは動く（demos/05 は公式 URL にフォールバックする）が、
// ローカルにあれば iPhone 側が Google のストレージに出て行かずに済み、
// 電波の弱い場所やオフラインの LAN でも確認できる
import { mkdir, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const MODELS = [
  {
    file: "hand_landmarker.task",
    url: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
  },
];

const dir = fileURLToPath(new URL("../public/models/", import.meta.url));
await mkdir(dir, { recursive: true });

for (const { file, url } of MODELS) {
  const dest = dir + file;
  const existing = await stat(dest).catch(() => null);
  if (existing && existing.size > 100_000) {
    console.log(`skip: ${file} は取得済み (${(existing.size / 1e6).toFixed(1)}MB)`);
    continue;
  }
  console.log(`fetch: ${url}`);
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`failed: HTTP ${res.status} ${url}`);
    process.exit(1);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(dest, buf);
  console.log(`saved: public/models/${file} (${(buf.length / 1e6).toFixed(1)}MB)`);
}
