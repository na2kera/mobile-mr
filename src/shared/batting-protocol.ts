// Phase 10-2 (10-2-batting) の WebSocket プロトコル。
// player はスマホ、overview は PC の俯瞰画面兼 Joy-Con WebHID ハブ。
import type { SpaceConfig } from "./shared-room-protocol.ts";
import type {
  BattingConfig,
  PitchType,
  V3,
} from "./batting-sim.ts";
import type {
  GameSnapshot,
  PlayerRole,
} from "./batting-game.ts";

export const BATTING_PATH = "/api/batting";
export const BATTING_PROTOCOL_VERSION = 1;
export const NAME_MAX_LENGTH = 12;

export type BattingRoomConfig = SpaceConfig;
export type ClientRole = "player" | "overview";
export type MotionKind = "pitch" | "bat";

export type PlayerPose = {
  pos: V3;
  quat: [number, number, number, number];
  tracking: boolean;
};

export type ClientMessage =
  | ({ type: "pose" } & PlayerPose)
  /** overview は playerId 必須。player は自分の操作だけ */
  | {
      type: "pitch";
      playerId?: string;
      pitchType: PitchType;
      speed: number;
    }
  | {
      type: "swing";
      playerId?: string;
      speed: number;
      faceDeg: number;
    }
  /** Joy-Con の現在角（見た目だけ。判定には使わない） */
  | {
      type: "motion";
      playerId: string;
      kind: MotionKind;
      angleDeg: number;
      dps: number;
    }
  | { type: "restart" };

export type ServerMessage =
  | {
      type: "welcome";
      id: string;
      role: ClientRole;
      playerRole: PlayerRole | null;
      peers: string[];
      config: BattingConfig;
      state: GameSnapshot;
    }
  | { type: "join"; id: string }
  | { type: "leave"; id: string }
  | ({ type: "pose"; id: string } & PlayerPose)
  | { type: "state"; state: GameSnapshot }
  | {
      type: "motion";
      id: string;
      kind: MotionKind;
      angleDeg: number;
      dps: number;
    }
  | { type: "rejected"; reason: string }
  | { type: "error"; reason: string };

export type {
  BattingConfig,
  GameSnapshot,
  PitchType,
  PlayerRole,
  V3,
};
