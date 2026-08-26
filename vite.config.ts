import { fileURLToPath, URL } from "node:url";
import { defineConfig, type Plugin } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";
// 拡張子付き import なのは Vite の configLoader: native 対応（拡張子なしだと
// dev/build のたびに非対応警告が出て、将来の Vite で config が壊れる）
import { sharedRoomServer } from "./server/shared-room.ts";
import { volleyballServer } from "./server/volleyball.ts";
import { dartsServer } from "./server/darts.ts";

// js-aruco2（demos/03 で使用）は top-level this へ代入する古い CJS 形式で、
// Vite(rolldown) が exports を静的検出できず named import が組めない。
// 読み込み時に該当行だけを ESM の import/export へ書き換えて解決する。
// 下の optimizeDeps.exclude とセット（除外しないと dev の事前バンドルが
// このプラグインを通らず壊れる）。js-aruco2 を剥がすときはここも削除する
function jsAruco2Esm(): Plugin {
  const patches: Record<string, [RegExp, string][]> = {
    "cv.js": [[/^this\.CV = CV;$/m, "export { CV };"]],
    "svd.js": [[/^this\.SVD = SVD;$/m, "export { SVD };"]],
    "posit1.js": [
      [
        /^var SVD = this\.SVD \|\| require\('\.\/svd'\)\.SVD;$/m,
        'import { SVD } from "./svd.js";',
      ],
      [/^this\.POS = POS;$/m, "export { POS };"],
    ],
    "aruco.js": [
      [
        /^var CV = this\.CV \|\| require\('\.\/cv'\)\.CV;$/m,
        'import { CV } from "./cv.js";',
      ],
      [/^this\.AR = AR;$/m, "export { AR };"],
    ],
  };
  return {
    name: "js-aruco2-esm",
    enforce: "pre",
    transform(code, id) {
      // dev では id に ?v= 等のクエリが付くため、クエリを除いてから判定する
      const file = id
        .split("?")[0]
        .match(/node_modules\/js-aruco2\/src\/([^/]+)$/)?.[1];
      if (!file || !patches[file]) return;
      let out = code;
      for (const [from, to] of patches[file]) {
        if (!from.test(out))
          throw new Error(
            `js-aruco2-esm: ${file} の書き換え対象行が見つからない（js-aruco2 のバージョンが変わった?）`,
          );
        out = out.replace(from, to);
      }
      return out;
    },
  };
}

// iOS Safari はセンサー/カメラ API が HTTPS 必須のため、dev サーバーを
// 自己署名 HTTPS + LAN 公開で立てる（iPhone 側は初回のみ証明書警告を突破する）
export default defineConfig({
  plugins: [basicSsl(), jsAruco2Esm(), sharedRoomServer(), volleyballServer(), dartsServer()],
  server: {
    host: true,
  },
  optimizeDeps: {
    // jsAruco2Esm プラグインのコメント参照
    exclude: ["js-aruco2", "js-aruco2/src/posit1.js"],
  },
  build: {
    rollupOptions: {
      // マルチページ構成: デモを追加したらここに登録する（new-demo スキル参照）
      input: {
        home: fileURLToPath(new URL("./index.html", import.meta.url)),
        "demo-01-stereo-box": fileURLToPath(
          new URL("./demos/01-stereo-box/index.html", import.meta.url),
        ),
        "demo-02-passthrough": fileURLToPath(
          new URL("./demos/02-passthrough/index.html", import.meta.url),
        ),
        "demo-03-marker-anchor": fileURLToPath(
          new URL("./demos/03-marker-anchor/index.html", import.meta.url),
        ),
        "demo-03-marker-print": fileURLToPath(
          new URL("./demos/03-marker-anchor/marker.html", import.meta.url),
        ),
        "demo-ex2-1-joycon-rc": fileURLToPath(
          new URL("./demos/ex2-1-joycon-rc/index.html", import.meta.url),
        ),
        "demo-04-shared-room": fileURLToPath(
          new URL("./demos/04-shared-room/index.html", import.meta.url),
        ),
        "demo-05-hand-interaction": fileURLToPath(
          new URL("./demos/05-hand-interaction/index.html", import.meta.url),
        ),
        "demo-06-volleyball": fileURLToPath(
          new URL("./demos/06-volleyball/index.html", import.meta.url),
        ),
        "demo-06-2-darts": fileURLToPath(
          new URL("./demos/06-2-darts/index.html", import.meta.url),
        ),
      },
    },
  },
});
