import { fileURLToPath, URL } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";
// js-aruco2 の ESM 化は全体の vite.config.ts と同じもの（化身はマーカーの検出に js-aruco2 を使う）
import { jsAruco2Esm } from "./vite.config.ts";

// ex9-1-keshin（化身）だけを Cloudflare Workers（静的アセット + Durable Object）へ出すためのビルド設定。`npm run build:keshin` で dist-keshin/ に出す。
// 配信側は deploy/cloudflare/（wrangler.jsonc・worker.ts・keshin-room.ts）。全体の build（vite.config.ts）とは別に、化身の 3 ページと
// そこからリンクしているマーカー印刷ページ（08-splatoon/markers.html）だけを入れる。
// public/ は 28MB あり大半（vendor/ の OpenCV・AlvaAR・AprilTag、hand_landmarker.task）は化身で使わないので、publicDir を切り、
// 要るものだけをコピーする。化身のモデル（GLB）は git に入れていないが、デプロイでは公開 URL から配る（了承済み）

const root = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// public/ から化身が読むものだけ（main.ts / mirror.ts の ${BASE_URL}models/pose_landmarker_lite.task と、各ページの /favicon.svg）
const PUBLIC_FILES = [
  { file: "models/pose_landmarker_lite.task", hint: "npm run fetch:models" },
  { file: "favicon.svg", hint: "" },
];
// 化身のモデル 4 体（scripts/fetch-keshin.mjs と同じ並び。keshin-assets.ts の keshinModelUrl が local-assets/keshin/<file> を見る）
const KESHIN_GLBS = ["majin_the_hand.glb", "majin_pegasus_arc.glb", "kensei_lancelot.glb", "sousha_maestro.glb"];

// 上のファイルを出力にそのまま足す。無ければビルドを止める（モデル抜きのまま公開しないため）
function keshinDeployAssets(): Plugin {
  const files = [
    ...PUBLIC_FILES.map(({ file, hint }) => ({ from: root(`./public/${file}`), to: file, hint })),
    ...KESHIN_GLBS.map((name) => ({
      from: root(`./local-assets/keshin/${name}`),
      to: `local-assets/keshin/${name}`,
      hint: "npm run fetch:keshin",
    })),
  ];
  return {
    name: "keshin-deploy-assets",
    apply: "build",
    buildStart() {
      const missing = files.filter((f) => !existsSync(f.from));
      if (missing.length)
        this.error(
          `化身のデプロイに要るファイルがありません:\n${missing
            .map((f) => `  ${f.to}${f.hint ? `（${f.hint} を先に実行）` : ""}`)
            .join("\n")}`,
        );
    },
    generateBundle() {
      for (const f of files) this.emitFile({ type: "asset", fileName: f.to, source: readFileSync(f.from) });
    },
  };
}

export default defineConfig({
  plugins: [jsAruco2Esm(), keshinDeployAssets()],
  publicDir: false,
  optimizeDeps: {
    // vite.config.ts の jsAruco2Esm のコメント参照（dev で使うことはないが、設定を揃えておく）
    exclude: ["js-aruco2", "js-aruco2/src/posit1.js"],
  },
  build: {
    outDir: "dist-keshin",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        "demo-ex9-1-keshin": root("./demos/ex9-1-keshin/index.html"),
        "demo-ex9-1-keshin-overview": root("./demos/ex9-1-keshin/overview.html"),
        "demo-ex9-1-keshin-mirror": root("./demos/ex9-1-keshin/mirror.html"),
        // 化身の index.html の「マーカーを印刷」のリンク先
        "demo-08-splatoon-markers": root("./demos/08-splatoon/markers.html"),
      },
    },
  },
});
