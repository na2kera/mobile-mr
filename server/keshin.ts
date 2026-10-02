// ex9-1-keshin（化身）用の Room サーバー（Vite の dev / preview サーバーに同居させるプラグイン）。
// 中身（Player 一覧・化身の on/off・pose の中継・再接続の引き継ぎ）は server/keshin-spec.ts にあり、
// Cloudflare の Durable Object（deploy/cloudflare/keshin-room.ts）と共有する。ここは Node（ws）のアダプタに渡すだけ
import { roomServerPlugin } from "./room-server.ts";
import { keshinSpec } from "./keshin-spec.ts";

// テスト（scripts/test-keshin.mjs）がここから import している
export { keshinSpec, parseClientMessage } from "./keshin-spec.ts";

export function keshinServer() {
  return roomServerPlugin("keshin-server", keshinSpec());
}
