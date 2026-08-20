// Phase 4 (04-shared-room) 用の Room 中継 WebSocket サーバー。
// 独立プロセスではなく Vite プラグインとして dev/preview の HTTPS サーバーに
// 同居させる。ページと同一オリジン・同一証明書になるため、iPhone (iOS Safari) で
// 自己署名証明書の警告をページ表示時の1回突破すれば wss も追加設定なしで通る
// （別ポートに立てると wss だけ証明書エラーで黙って落ちる）。
// 役割は「同じ room に入った端末間で pose を中継する」だけで、姿勢の解釈は
// 一切しない（座標系の意味は src/shared/shared-room-protocol.ts 参照）。
// ただし Room の空間設定（markerId / markerMm）の一致だけは入室時に検証する。
// 座標の中身は解釈しなくても、座標系の前提が揃っていなければ中継自体が無意味なため
import process from "node:process";
import type { HttpServer, Plugin } from "vite";
import { WebSocketServer, type WebSocket, type RawData } from "ws";
// 拡張子付き import なのは Vite の configLoader: native 対応
// （拡張子なしだと dev/build のたびに非対応警告が出て、将来の Vite で config が壊れる）
import {
  SHARED_ROOM_PATH,
  ROOM_ID_PATTERN,
  PROTOCOL_VERSION,
  type PoseData,
  type ServerMessage,
  type SpaceConfig,
} from "../src/shared/shared-room-protocol.ts";

/** 1メッセージの上限バイト数。pose の JSON は 200 バイト程度なので余裕を見て 1KB */
const MAX_PAYLOAD_BYTES = 1024;

/**
 * 生存確認 ping の間隔 [ms]。iOS のロックや Wi-Fi 切断は FIN を送らずに死ぬため
 * （half-open）、放置すると幽霊メンバーが welcome の peers に残り続ける。
 * ping に前回応答しなかった接続は切断して leave 扱いにする。
 * 回帰テストが切断までの実時間を待てるよう、環境変数で短縮できる
 */
const HEARTBEAT_INTERVAL_MS =
  Number(process.env.SHARED_ROOM_HEARTBEAT_MS ?? "") || 10000;

/** pong で生存を記録するための ws 拡張（ws 公式ドキュメントの定番パターン） */
type LiveWebSocket = WebSocket & { isAlive?: boolean };

/** Room の状態。空間設定は最初の参加者が決め、全員一致を要求する */
type Room = {
  config: SpaceConfig;
  members: Map<string, LiveWebSocket>;
};

// 受信データを ClientMessage の pose として検証する。壊れた JSON・型違い・
// 非有限数（NaN/Infinity は JSON.parse では作れないが、値の欠落や文字列は来うる）は
// null を返して黙って捨てる（クライアントのバグや悪意で他端末を壊さないための境界）
function parsePoseMessage(data: RawData): PoseData | null {
  let msg: unknown;
  try {
    msg = JSON.parse(data.toString());
  } catch {
    return null;
  }
  if (typeof msg !== "object" || msg === null) return null;
  const m = msg as Record<string, unknown>;
  if (m.type !== "pose") return null;
  const isVec = (v: unknown, len: number): v is number[] =>
    Array.isArray(v) &&
    v.length === len &&
    v.every((n) => typeof n === "number" && Number.isFinite(n));
  if (!isVec(m.pos, 3) || !isVec(m.quat, 4)) return null;
  if (typeof m.tracking !== "boolean") return null;
  // 有限なだけでは足りない意味的な検証（コードレビュー指摘）:
  // 零・退化クォータニオンは受信側の slerp で NaN を生むため拒否し、
  // それ以外は境界で正規化してから中継する（非正規化値をそのまま流すと
  // three.js の compose() で回転行列にスケールが混ざりアバターが歪む）。
  // 成分の上限チェックと quatLen の有限チェックは別物であることに注意:
  // 各成分が有限（例: 1e308）でも二乗和が double の上限を超えると
  // Math.hypot は Infinity を返し、正規化の除算が零クォータニオンを作ってしまう
  // （コードレビュー指摘で実際に再現した穴）。
  // 位置も現実的にありえない値は捨てる（マーカー座標系で 100m 超は誤検出かバグ）
  if (m.quat.some((v) => Math.abs(v) > 1e6)) return null;
  const quatLen = Math.hypot(...m.quat);
  if (!Number.isFinite(quatLen) || quatLen < 0.5) return null;
  if (m.pos.some((v) => Math.abs(v) > 100)) return null;
  return {
    pos: m.pos as PoseData["pos"],
    quat: m.quat.map((v) => v / quatLen) as unknown as PoseData["quat"],
    tracking: m.tracking,
  };
}

/**
 * 接続クエリから空間設定を検証つきで読む。範囲はクライアント（numParam）と同じ。
 * 不正なら null（呼び出し側が error を返して接続を閉じる）
 */
function parseSpaceConfig(url: URL): SpaceConfig | null {
  const markerId = Number(url.searchParams.get("markerId") ?? NaN);
  const markerMm = Number(url.searchParams.get("markerMm") ?? NaN);
  if (!Number.isInteger(markerId) || markerId < 0 || markerId > 999) return null;
  if (!Number.isFinite(markerMm) || markerMm <= 0 || markerMm > 5000)
    return null;
  return { markerId, markerMm };
}

// HttpServer は Vite の型（http.Server | Http2SecureServer の union。実際に来るのは
// basicSsl による https.Server）。upgrade イベントの形はどちらでも同じ
function attach(httpServer: HttpServer) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_PAYLOAD_BYTES,
  });
  const rooms = new Map<string, Room>();
  let nextPlayerNumber = 1;

  // half-open 接続の掃除（HEARTBEAT_INTERVAL_MS のコメント参照）。
  // terminate() は close イベントを発火させるので leave 処理はそちらに乗る
  const heartbeat = setInterval(() => {
    for (const room of rooms.values()) {
      for (const ws of room.members.values()) {
        if (ws.isAlive === false) {
          ws.terminate();
          continue;
        }
        ws.isAlive = false;
        ws.ping();
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
  httpServer.on("close", () => clearInterval(heartbeat));

  function broadcast(
    members: Map<string, WebSocket>,
    msg: ServerMessage,
    excludeId?: string,
  ) {
    const data = JSON.stringify(msg);
    for (const [id, ws] of members) {
      if (id !== excludeId && ws.readyState === ws.OPEN) ws.send(data);
    }
  }

  /** 入室を拒否する: 理由をクライアントへ伝えてから閉じる（黙って切ると原因が分からない） */
  function reject(ws: WebSocket, reason: string) {
    console.warn(`[shared-room] rejected: ${reason}`);
    ws.send(JSON.stringify({ type: "error", reason } satisfies ServerMessage));
    ws.close();
  }

  // Vite の HMR WebSocket も同じサーバーの upgrade イベントに乗っているため、
  // 自分のパス宛て以外には触らない（destroy すると HMR を殺す）
  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "", "http://localhost");
    if (url.pathname !== SHARED_ROOM_PATH) return;
    const roomName = url.searchParams.get("room") ?? "";
    if (!ROOM_ID_PATTERN.test(roomName)) {
      socket.destroy();
      return;
    }
    // cross-site WebSocket hijacking 対策（コードレビュー指摘）: ブラウザは
    // upgrade に必ず Origin を付けるので、付いている場合はページと同一ホストを
    // 要求する。悪意あるページを開いた LAN 内ユーザーのブラウザが、そのページの
    // スクリプトから勝手に Room へ接続させられる経路を塞ぐ。
    // 非ブラウザクライアントは Origin を偽装できるため認証の代わりにはならない
    // （本格的な認証・レート制限は公開運用時の課題として Phase 4 では扱わない）
    const origin = req.headers.origin;
    if (origin) {
      let originHost: string | null = null;
      try {
        originHost = new URL(origin).host;
      } catch {
        // 不正な Origin はホスト不一致と同じ扱い
      }
      if (originHost !== req.headers.host) {
        console.warn(
          `[shared-room] rejected connection from origin "${origin}" (host: ${req.headers.host})`,
        );
        socket.destroy();
        return;
      }
    }
    wss.handleUpgrade(req, socket, head, (ws: LiveWebSocket) => {
      // バージョン・空間設定の検証は WebSocket 確立後に行う
      // （ハンドシェイク段階で socket.destroy() すると理由を伝えられない）
      const version = Number(url.searchParams.get("v") ?? NaN);
      if (version !== PROTOCOL_VERSION) {
        reject(
          ws,
          `プロトコルバージョン不一致 (server: ${PROTOCOL_VERSION} / client: ${url.searchParams.get("v") ?? "なし"})。ページを再読み込みしてください`,
        );
        return;
      }
      const config = parseSpaceConfig(url);
      if (!config) {
        reject(ws, "空間設定 (markerId / markerMm) が不正です");
        return;
      }
      let room = rooms.get(roomName);
      if (
        room &&
        (room.config.markerId !== config.markerId ||
          room.config.markerMm !== config.markerMm)
      ) {
        // 空間設定が違う端末を同じ Room に入れると、通信は正常でも座標が一致しない
        // （markerMm の差は並進スケールの差になる）。黙って壊れるより入室拒否
        reject(
          ws,
          `room "${roomName}" の空間設定と不一致 (参加中: markerId=${room.config.markerId} markerMm=${room.config.markerMm} / あなた: markerId=${config.markerId} markerMm=${config.markerMm})`,
        );
        return;
      }
      if (!room) {
        room = { config, members: new Map() };
        rooms.set(roomName, room);
      }
      const { members } = room;
      const id = `p${nextPlayerNumber++}`;
      ws.isAlive = true;
      ws.on("pong", () => {
        ws.isAlive = true;
      });
      // welcome（既存メンバー一覧つき）を自分へ、join を既存メンバーへ。
      // 自分を members に入れるのはその後（join が自分に届かないように）
      ws.send(
        JSON.stringify({
          type: "welcome",
          id,
          peers: [...members.keys()],
        } satisfies ServerMessage),
      );
      broadcast(members, { type: "join", id });
      members.set(id, ws);
      console.log(
        `[shared-room] ${id} joined room "${roomName}" (${members.size} members)`,
      );

      ws.on("message", (data) => {
        const pose = parsePoseMessage(data);
        if (!pose) return;
        // 送信元の id はサーバーが付ける（クライアントの自称を信用しない）
        broadcast(members, { type: "pose", id, ...pose }, id);
      });
      const leave = () => {
        if (!members.delete(id)) return; // close と error の二重発火を無視
        if (members.size === 0) rooms.delete(roomName);
        else broadcast(members, { type: "leave", id });
        console.log(
          `[shared-room] ${id} left room "${roomName}" (${members.size} members)`,
        );
      };
      ws.on("close", leave);
      ws.on("error", (e) => {
        console.warn(`[shared-room] ${id} socket error:`, e.message);
        ws.close();
        leave();
      });
    });
  });
}

/**
 * Vite プラグインの入口。dev（vite）と preview（vite preview、ビルド確認用）の
 * 両方に同じ中継サーバーを付ける
 */
export function sharedRoomServer(): Plugin {
  return {
    name: "shared-room-server",
    configureServer(server) {
      if (server.httpServer) attach(server.httpServer);
    },
    configurePreviewServer(server) {
      if (server.httpServer) attach(server.httpServer);
    },
  };
}
