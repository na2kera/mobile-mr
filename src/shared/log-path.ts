// クライアント（remote-log.ts）とサーバー（server/client-log.ts）で共有するパス。
// server/client-log.ts は node:fs を import するのでブラウザから読めない。パスだけをここに置く
export const CLIENT_LOG_PATH = "/api/client-log";
