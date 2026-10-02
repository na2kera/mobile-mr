// ex9-1-keshin（化身）の 3D モデル 4 体（GLB）を local-assets/keshin/ にコピーする。`npm run fetch:keshin` で実行する。
// モデルは手元の Blender 作業フォルダで作ったもので、公開リポジトリには入れない（.gitignore 済み）。
// dev サーバーだけが /local-assets/keshin/*.glb で配る（vite.config.ts の keshinLocalAssets。build には出さない）。
// コピーしていなくてもページは開け、HUD に「モデル未配置（npm run fetch:keshin）」と出て代わりの人型で演出を確認できる。
//
// コピー元の既定: リポジトリ直下から ../../../blender（= /Users/keranatsuki/dev/blender）。環境変数 KESHIN_SRC_DIR で上書きする。
//   <src>/majin-fable/majin_the_hand.glb       … 0: マジン・ザ・ハンド
//   <src>/Pegasus-Opus/majin_pegasus_arc.glb   … 1: 魔神ペガサスアーク
//   <src>/Lancelot-Opus/kensei_lancelot.glb    … 2: 剣聖ランスロット
//   <src>/Maestro-Opus/sousha_maestro.glb      … 3: 奏者マエストロ
// 各フォルダの README.md に Three.js での扱い方（半透明・下半身の隠し方・クリッピング・アニメの時刻）が書いてある
import { copyFile, mkdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = process.env.KESHIN_SRC_DIR ? resolve(process.env.KESHIN_SRC_DIR) : resolve(ROOT, "../../../blender");
const DEST = join(ROOT, "local-assets", "keshin");

const MODELS = [
  { dir: "majin-fable", file: "majin_the_hand.glb", label: "0: マジン・ザ・ハンド" },
  { dir: "Pegasus-Opus", file: "majin_pegasus_arc.glb", label: "1: 魔神ペガサスアーク" },
  { dir: "Lancelot-Opus", file: "kensei_lancelot.glb", label: "2: 剣聖ランスロット" },
  { dir: "Maestro-Opus", file: "sousha_maestro.glb", label: "3: 奏者マエストロ" },
];

const srcStat = await stat(SRC).catch(() => null);
if (!srcStat?.isDirectory()) {
  console.error(`コピー元のフォルダが見つかりません: ${SRC}`);
  console.error("Blender の作業フォルダの場所を KESHIN_SRC_DIR=/path/to/blender npm run fetch:keshin で指定してください");
  process.exit(1);
}

await mkdir(DEST, { recursive: true });
let failed = 0;
for (const m of MODELS) {
  const from = join(SRC, m.dir, m.file);
  const to = join(DEST, m.file);
  const s = await stat(from).catch(() => null);
  if (!s?.isFile()) {
    console.error(`見つかりません: ${from}（${m.label}）`);
    failed++;
    continue;
  }
  await copyFile(from, to);
  console.log(`copy: ${m.label} ${from} → local-assets/keshin/${m.file} (${(s.size / 1024 / 1024).toFixed(2)} MiB)`);
}
if (failed > 0) {
  console.error(`${failed} 個のモデルが見つかりませんでした。KESHIN_SRC_DIR（いま: ${SRC}）を確認してください`);
  process.exit(1);
}
console.log(`完了: ${DEST}（dev サーバーが /local-assets/keshin/ で配ります。build には入りません）`);
