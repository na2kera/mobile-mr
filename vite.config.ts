import { fileURLToPath, URL } from "node:url";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { defineConfig, type Plugin } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";
// 拡張子付き import なのは Vite の configLoader: native 対応（拡張子なしだと
// dev/build のたびに非対応警告が出て、将来の Vite で config が壊れる）
import { sharedRoomServer } from "./server/shared-room.ts";
import { volleyballServer } from "./server/volleyball.ts";
import { dartsServer } from "./server/darts.ts";
import { surfaceServer } from "./server/surface.ts";
import { splatoonServer } from "./server/splatoon.ts";
import { splatoonOutsideInServer } from "./server/splatoon-outside-in.ts";
import { splatoonPoseCamServer } from "./server/splatoon-pose-cam.ts";
import { personServer } from "./server/person.ts";
import { golfServer } from "./server/golf.ts";
import { battingServer } from "./server/batting.ts";
import { keshinServer } from "./server/keshin.ts";
import { clientLogServer } from "./server/client-log.ts";

// js-aruco2（demos/03 で使用）は top-level this へ代入する古い CJS 形式で、
// Vite(rolldown) が exports を静的検出できず named import が組めない。
// 読み込み時に該当行だけを ESM の import/export へ書き換えて解決する。
// 下の optimizeDeps.exclude とセット（除外しないと dev の事前バンドルが
// このプラグインを通らず壊れる）。js-aruco2 を剥がすときはここも削除する
// dev サーバーの HTTP サーバーには、デモごとの WebSocket サーバー（server/*.ts）が upgrade と close を 1 つずつ購読する。
// 08-3 / 08-8 を足して 11 個になり、Node の既定の上限 10 を超えて MaxListenersExceededWarning が出るようになったので、
// 上限を購読の数に合わせて上げる（漏れではなく、デモの数だけ購読が並ぶのが正しい形）。他のプラグインより先に置く
function roomListenerLimit(): Plugin {
  return {
    name: "room-listener-limit",
    configureServer(server) {
      server.httpServer?.setMaxListeners(32);
    },
    configurePreviewServer(server) {
      server.httpServer?.setMaxListeners(32);
    },
  };
}

export function jsAruco2Esm(): Plugin {
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

// 8th Wall の配布ファイルを package から同じ相対パスで配信する。
// xr.js は xr-slam.js と resources/ を自身の URL から解決する。
function eighthWallAssets(): Plugin {
  const root = fileURLToPath(new URL("./node_modules/@8thwall/engine-binary/dist/", import.meta.url));
  const prefix = "/vendor/8thwall/";
  const files = (dir = ""): string[] => readdirSync(join(root, dir)).flatMap((name) => {
    const relative = join(dir, name);
    return statSync(join(root, relative)).isDirectory() ? files(relative) : [relative];
  });
  const assetFiles = files();
  const assetSet = new Set(assetFiles);
  const serve: Plugin["configureServer"] = (server) => {
    server.middlewares.use((req, res, next) => {
      const rawPath = (req.url ?? "").split("?")[0];
      if (!rawPath.startsWith(prefix)) return next();
      let path: string;
      try { path = decodeURIComponent(rawPath); }
      catch { res.statusCode = 400; res.end("Invalid URL"); return; }
      const relative = path.slice(prefix.length);
      if (!assetSet.has(relative)) return next();
      const contentType = relative.endsWith(".js") ? "text/javascript" : relative.endsWith(".svg") ? "image/svg+xml" : relative.endsWith("LICENSE") ? "text/plain" : "application/octet-stream";
      res.setHeader("Content-Type", contentType);
      res.end(readFileSync(join(root, relative)));
    });
  };
  return {
    name: "eighth-wall-assets",
    configureServer: serve,
    generateBundle() {
      for (const file of assetFiles) this.emitFile({ type: "asset", fileName: `vendor/8thwall/${file}`, source: readFileSync(join(root, file)) });
    },
  };
}

// ex9-1-keshin の化身モデル（GLB）を local-assets/keshin/ から /local-assets/keshin/*.glb で配る。
// モデルは手元の Blender 作業フォルダのもので公開リポジトリに入れない（npm run fetch:keshin でコピー、.gitignore 済み）ので、
// dev サーバーだけが配り、build には出さない（eighthWallAssets の dev 側と同じ書き方。generateBundle は持たない）。
// 置いていなければ 404 になり、ページは代わりの人型に落ちる
function keshinLocalAssets(): Plugin {
  const root = fileURLToPath(new URL("./local-assets/keshin/", import.meta.url));
  const prefix = "/local-assets/keshin/";
  return {
    name: "keshin-local-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const rawPath = (req.url ?? "").split("?")[0];
        if (!rawPath.startsWith(prefix)) return next();
        const name = rawPath.slice(prefix.length);
        // ファイル名だけ（ディレクトリをたどらせない）
        if (!/^[A-Za-z0-9_-]+\.glb$/.test(name)) return next();
        let body: Buffer;
        try {
          body = readFileSync(join(root, name));
        } catch {
          res.statusCode = 404;
          res.end("not found (npm run fetch:keshin)");
          return;
        }
        res.setHeader("Content-Type", "model/gltf-binary");
        res.setHeader("Cache-Control", "no-cache");
        res.end(body);
      });
    },
  };
}

// iOS Safari はセンサー/カメラ API が HTTPS 必須のため、dev サーバーを
// 自己署名 HTTPS + LAN 公開で立てる（iPhone 側は初回のみ証明書警告を突破する）
export default defineConfig({
  plugins: [
    roomListenerLimit(),
    basicSsl(),
    jsAruco2Esm(),
    eighthWallAssets(),
    keshinLocalAssets(),
    sharedRoomServer(),
    volleyballServer(),
    dartsServer(),
    surfaceServer(),
    splatoonServer(),
    splatoonOutsideInServer(),
    splatoonPoseCamServer(),
    personServer(),
    golfServer(),
    battingServer(),
    keshinServer(),
    clientLogServer(),
  ],
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
        "demo-07-surface-mapping": fileURLToPath(
          new URL("./demos/07-surface-mapping/index.html", import.meta.url),
        ),
        "demo-08-splatoon": fileURLToPath(
          new URL("./demos/08-splatoon/index.html", import.meta.url),
        ),
        "demo-08-splatoon-overview": fileURLToPath(
          new URL("./demos/08-splatoon/overview.html", import.meta.url),
        ),
        "demo-08-splatoon-markers": fileURLToPath(
          new URL("./demos/08-splatoon/markers.html", import.meta.url),
        ),
        "demo-ex8-1-god-hand": fileURLToPath(
          new URL("./demos/ex8-1-god-hand/index.html", import.meta.url),
        ),
        "demo-09-person-id": fileURLToPath(
          new URL("./demos/09-person-id/index.html", import.meta.url),
        ),
        // ex9-1: 化身（モデルは dev サーバーだけが配る。build には入らない）
        "demo-ex9-1-keshin": fileURLToPath(new URL("./demos/ex9-1-keshin/index.html", import.meta.url)),
        "demo-ex9-1-keshin-overview": fileURLToPath(new URL("./demos/ex9-1-keshin/overview.html", import.meta.url)),
        "demo-ex9-1-keshin-mirror": fileURLToPath(new URL("./demos/ex9-1-keshin/mirror.html", import.meta.url)),
        "demo-10-golf": fileURLToPath(new URL("./demos/10-golf/index.html", import.meta.url)),
        "demo-10-golf-overview": fileURLToPath(new URL("./demos/10-golf/overview.html", import.meta.url)),
        "demo-10-golf-joycon-test": fileURLToPath(new URL("./demos/10-golf/joycon-test.html", import.meta.url)),
        "demo-10-2-batting": fileURLToPath(new URL("./demos/10-2-batting/index.html", import.meta.url)),
        "demo-10-2-batting-overview": fileURLToPath(new URL("./demos/10-2-batting/overview.html", import.meta.url)),
        "demo-08-2-splatoon-fixed": fileURLToPath(new URL("./demos/08-2-splatoon-fixed/index.html", import.meta.url)),
        "demo-08-2-splatoon-fixed-overview": fileURLToPath(new URL("./demos/08-2-splatoon-fixed/overview.html", import.meta.url)),
        "demo-08-2-splatoon-fixed-markers": fileURLToPath(new URL("./demos/08-2-splatoon-fixed/markers.html", import.meta.url)),

        "demo-08-3-splatoon-outside-in": fileURLToPath(new URL("./demos/08-3-splatoon-outside-in/index.html", import.meta.url)),
        "demo-08-3-splatoon-outside-in-overview": fileURLToPath(new URL("./demos/08-3-splatoon-outside-in/overview.html", import.meta.url)),
        "demo-08-3-splatoon-outside-in-markers": fileURLToPath(new URL("./demos/08-3-splatoon-outside-in/markers.html", import.meta.url)),
        "demo-08-5-splatoon-apriltag": fileURLToPath(new URL("./demos/08-5-splatoon-apriltag/index.html", import.meta.url)),
        "demo-08-5-splatoon-apriltag-overview": fileURLToPath(new URL("./demos/08-5-splatoon-apriltag/overview.html", import.meta.url)),
        "demo-08-5-splatoon-apriltag-markers": fileURLToPath(new URL("./demos/08-5-splatoon-apriltag/markers.html", import.meta.url)),

        "demo-08-6-splatoon-screen-markers": fileURLToPath(new URL("./demos/08-6-splatoon-screen-markers/index.html", import.meta.url)),
        "demo-08-6-splatoon-screen-markers-overview": fileURLToPath(new URL("./demos/08-6-splatoon-screen-markers/overview.html", import.meta.url)),
        "demo-08-6-splatoon-screen-markers-markers": fileURLToPath(new URL("./demos/08-6-splatoon-screen-markers/markers.html", import.meta.url)),
        "demo-08-6-splatoon-screen-markers-screen": fileURLToPath(new URL("./demos/08-6-splatoon-screen-markers/markers-screen.html", import.meta.url)),

        "demo-08-4-splatoon-opencv": fileURLToPath(new URL("./demos/08-4-splatoon-opencv/index.html", import.meta.url)),
        "demo-08-4-splatoon-opencv-overview": fileURLToPath(new URL("./demos/08-4-splatoon-opencv/overview.html", import.meta.url)),
        "demo-08-4-splatoon-opencv-markers": fileURLToPath(new URL("./demos/08-4-splatoon-opencv/markers.html", import.meta.url)),

        "demo-08-7-splatoon-alva": fileURLToPath(new URL("./demos/08-7-splatoon-alva/index.html", import.meta.url)),
        "demo-08-7-splatoon-alva-overview": fileURLToPath(new URL("./demos/08-7-splatoon-alva/overview.html", import.meta.url)),
        "demo-08-7-splatoon-alva-markers": fileURLToPath(new URL("./demos/08-7-splatoon-alva/markers.html", import.meta.url)),

        "demo-08-8-splatoon-pose-cam": fileURLToPath(new URL("./demos/08-8-splatoon-pose-cam/index.html", import.meta.url)),
        "demo-08-8-splatoon-pose-cam-overview": fileURLToPath(new URL("./demos/08-8-splatoon-pose-cam/overview.html", import.meta.url)),
        "demo-08-8-splatoon-pose-cam-markers": fileURLToPath(new URL("./demos/08-8-splatoon-pose-cam/markers.html", import.meta.url)),
        // 08-9: 08-4 の board + 08-7 の SLAM + 静止中はアンカーを止める
        "demo-08-9-splatoon-hold": fileURLToPath(new URL("./demos/08-9-splatoon-hold/index.html", import.meta.url)),
        "demo-08-9-splatoon-hold-overview": fileURLToPath(new URL("./demos/08-9-splatoon-hold/overview.html", import.meta.url)),
        "demo-08-9-splatoon-hold-markers": fileURLToPath(new URL("./demos/08-9-splatoon-hold/markers.html", import.meta.url)),
        "demo-08-10-splatoon-8thwall": fileURLToPath(new URL("./demos/08-10-splatoon-8thwall/index.html", import.meta.url)),
        "demo-08-10-splatoon-8thwall-overview": fileURLToPath(new URL("./demos/08-10-splatoon-8thwall/overview.html", import.meta.url)),
        "demo-08-10-splatoon-8thwall-markers": fileURLToPath(new URL("./demos/08-10-splatoon-8thwall/markers.html", import.meta.url)),
        // 08-11: 8th Wall SLAM + OpenCV board + 窓平均（止まっている間のぶれを抑える）
        "demo-08-11-splatoon-8thwall-board": fileURLToPath(new URL("./demos/08-11-splatoon-8thwall-board/index.html", import.meta.url)),
        "demo-08-11-splatoon-8thwall-board-overview": fileURLToPath(new URL("./demos/08-11-splatoon-8thwall-board/overview.html", import.meta.url)),
        "demo-08-11-splatoon-8thwall-board-markers": fileURLToPath(new URL("./demos/08-11-splatoon-8thwall-board/markers.html", import.meta.url)),
      },
    },
  },
});
