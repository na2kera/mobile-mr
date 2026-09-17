// 08-8（PC カメラ + MediaPipe Pose で人を追う）用の対戦サーバー。
// メッセージ・検証・試合のルールは 08-3（アウトサイドイン）のサーバーと完全に同じなので、server/splatoon-outside-in.ts の spec を
// **別パス**（SPLATOON_POSE_CAM_PATH）でもう 1 つ登録するだけにする（08-3 のファイルは変更しない。Room の状態も 08-3 とは別インスタンス）。
//   - 08-3 の track の id は「ゴーグルのマーカーの ID = プレイヤーの trackId」。08-8 のトラッカーは手を挙げた人物にプレイヤーを割り当て、
//     そのプレイヤーの trackId を載せて送るので、サーバーから見て違いは無い（splatoon-pose-cam-protocol.ts）
//   - 08-3 の plugin はパスが定数なので、httpServer の "upgrade" の購読だけを包み、SPLATOON_POSE_CAM_PATH への接続を
//     「08-3 のパスに見える req」（元の req を prototype にした URL だけ違うオブジェクト）で渡す。元の req は書き換えないので、
//     同じ httpServer に登録されている本物の 08-3 のサーバーや Vite の HMR には影響しない
//   - ログの接頭辞は 08-3 と同じ "[splatoon-oi]"（spec を共有しているため）
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { HttpServer, Plugin, PreviewServer, ViteDevServer } from "vite";
import { splatoonOutsideInServer } from "./splatoon-outside-in.ts";
import { SPLATOON_OUTSIDE_IN_PATH } from "../src/shared/splatoon-outside-in-protocol.ts";
import { SPLATOON_POSE_CAM_PATH } from "../src/shared/splatoon-pose-cam-protocol.ts";

type UpgradeListener = (req: IncomingMessage, socket: Duplex, head: Buffer) => void;

/** "upgrade" の購読だけを包んだ httpServer（それ以外の購読・プロパティは元のまま） */
function rerouteUpgrades(httpServer: HttpServer): HttpServer {
  return new Proxy(httpServer, {
    get(target, prop, receiver) {
      if (prop === "on" || prop === "addListener") {
        return (event: string, listener: (...args: unknown[]) => void) => {
          if (event !== "upgrade") return (target as unknown as { on: (e: string, l: unknown) => unknown }).on(event, listener);
          const wrapped: UpgradeListener = (req, socket, head) => {
            const url = new URL(req.url ?? "", "http://localhost");
            if (url.pathname !== SPLATOON_POSE_CAM_PATH) return;
            const rerouted = Object.create(req, { url: { value: `${SPLATOON_OUTSIDE_IN_PATH}${url.search}`, enumerable: true } }) as IncomingMessage;
            (listener as UpgradeListener)(rerouted, socket, head);
          };
          // このサーバーを足すと、Vite の HMR と既存のデモのサーバーで "upgrade" の購読が既定の上限（10）を超えて
          // MaxListenersExceededWarning が出るので、このぶん（1 つ）だけ上限を広げる（リークではなく、デモのサーバーの数だけ購読がある）
          target.setMaxListeners(target.getMaxListeners() + 1);
          return target.on("upgrade", wrapped);
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

export function splatoonPoseCamServer(): Plugin {
  const inner = splatoonOutsideInServer();
  const configureServer = inner.configureServer as ((server: ViteDevServer) => void) | undefined;
  const configurePreviewServer = inner.configurePreviewServer as ((server: PreviewServer) => void) | undefined;
  return {
    name: "splatoon-pose-cam-server",
    configureServer(server) {
      if (!server.httpServer || !configureServer) return;
      configureServer({ httpServer: rerouteUpgrades(server.httpServer) } as unknown as ViteDevServer);
    },
    configurePreviewServer(server) {
      if (!server.httpServer || !configurePreviewServer) return;
      configurePreviewServer({ httpServer: rerouteUpgrades(server.httpServer) } as unknown as PreviewServer);
    },
  };
}
