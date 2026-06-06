export type FactionId = 'red' | 'blue' | 'green' | 'yellow';
export type MatchStatus = 'waiting' | 'countdown' | 'running' | 'ended';
export type Direction = 'up' | 'down' | 'left' | 'right';

export interface Vec2 {
  x: number;
  y: number;
}

export interface WorldConfig {
  width: number;
  height: number;
  boxCount: number;
}

export interface CameraSettings {
  height: number;
  distance: number;
  shake: number;
}

export interface FactionBase {
  id: FactionId;
  name: string;
  color: string;
  cells: Vec2[];
}

export interface StaticMap {
  width: number;
  height: number;
  walls: [number, number][];
  bases: FactionBase[];
}

export interface PlayerEntity extends Vec2 {
  id: string;
  name: string;
  faction: FactionId;
  color: string;
  connected: boolean;
  assigned: boolean;
}

export interface BoxEntity extends Vec2 {
  id: string;
  faction: FactionId;
  color: string;
  code?: string;
  lastMovedAt?: number;
}

export interface MatchInfo {
  status: MatchStatus;
  durationSeconds: number;
  startedAt: number;
  endsAt: number;
  remainingSeconds: number;
  countdownSeconds: number;
}

export interface GameStats {
  onlinePlayers: number;
  playerLimit: number;
  totalPlayers: number;
  boxCount: number;
}

export interface ServerState {
  players: PlayerEntity[];
  boxes: BoxEntity[];
  scores: Record<FactionId, number>;
  match: MatchInfo;
  stats: GameStats;
}

export type ServerMessage =
  | {
      type: 'INIT';
      selfId?: string;
      map: StaticMap;
      state: ServerState;
    }
  | {
      type: 'STATE';
      state: ServerState;
    }
  | {
      type: 'ERROR';
      message: string;
      code?: 'PLAYER_NOT_FOUND';
    };

export type ClientMessage =
  | {
      type: 'JOIN';
      name: string;
      faction?: FactionId;
    }
  | {
      type: 'RESUME_PLAYER';
      playerId: string;
    }
  | {
      type: 'MOVE_PLAYER';
      direction?: Direction;
      delta?: Partial<Vec2>;
    }
  | {
      type: 'ADMIN_START';
      durationSeconds: number;
      mapConfig?: Partial<WorldConfig>;
    }
  | {
      type: 'ADMIN_RESET';
      mapConfig?: Partial<WorldConfig>;
    };

export interface LeaderboardRow {
  faction: FactionId;
  name: string;
  color: string;
  score: number;
}
