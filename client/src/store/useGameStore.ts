import { create } from 'zustand';
import type {
  CameraSettings,
  ClientMessage,
  Direction,
  FactionId,
  LeaderboardRow,
  ServerMessage,
  ServerState,
  StaticMap,
  Vec2,
  WorldConfig,
} from '../types/game';

const PLAYER_STORAGE_KEY = 'openatom-sokoban-player';

interface StoredPlayerIdentity {
  id: string;
  name: string;
  faction: FactionId;
}

interface GameState {
  socket: WebSocket | null;
  connected: boolean;
  selfId: string | null;
  playerName: string;
  selectedFaction: FactionId;
  notice: string | null;
  map: StaticMap | null;
  state: ServerState;
  cameraSettings: CameraSettings;
  connect: () => void;
  join: (name: string, faction: FactionId) => void;
  sendMove: (move: Direction | Vec2) => void;
  adminStart: (durationSeconds: number, mapConfig?: Partial<WorldConfig>) => void;
  adminReset: (mapConfig?: Partial<WorldConfig>) => void;
  setCameraSettings: (settings: Partial<CameraSettings>) => void;
}

export const factions = [
  { id: 'red' as const, name: 'Red', color: '#ef4444' },
  { id: 'blue' as const, name: 'Blue', color: '#3b82f6' },
  { id: 'green' as const, name: 'Green', color: '#22c55e' },
  { id: 'yellow' as const, name: 'Yellow', color: '#eab308' },
];

function isFactionId(value: unknown): value is FactionId {
  return value === 'red' || value === 'blue' || value === 'green' || value === 'yellow';
}

function isSpectatorRoute() {
  return window.location.pathname.includes('spectator');
}

function readStoredIdentity(): StoredPlayerIdentity | null {
  try {
    const raw = window.localStorage.getItem(PLAYER_STORAGE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<StoredPlayerIdentity>;
    if (!parsed.id || !parsed.name || !isFactionId(parsed.faction)) return null;

    return {
      id: parsed.id,
      name: parsed.name,
      faction: parsed.faction,
    };
  } catch {
    return null;
  }
}

function writeStoredIdentity(identity: StoredPlayerIdentity) {
  window.localStorage.setItem(PLAYER_STORAGE_KEY, JSON.stringify(identity));
}

function clearStoredIdentity() {
  window.localStorage.removeItem(PLAYER_STORAGE_KEY);
}

const storedIdentity = !isSpectatorRoute() ? readStoredIdentity() : null;

const initialState: ServerState = {
  players: [],
  boxes: [],
  scores: { red: 0, blue: 0, green: 0, yellow: 0 },
  match: {
    status: 'waiting',
    durationSeconds: 45 * 60,
    startedAt: 0,
    endsAt: 0,
    remainingSeconds: 45 * 60,
    countdownSeconds: 0,
  },
  stats: {
    onlinePlayers: 0,
    playerLimit: 50,
    totalPlayers: 0,
    boxCount: 220,
  },
};

const initialCameraSettings: CameraSettings = {
  height: 15.5,
  distance: 6.2,
  shake: 0,
};

function wsUrl() {
  const envUrl = import.meta.env.VITE_WS_URL as string | undefined;
  if (envUrl) return envUrl;

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  if (import.meta.env.DEV) return `${protocol}//${window.location.hostname}:3001`;
  return `${protocol}//${window.location.host}`;
}

function send(socket: WebSocket | null, message: ClientMessage) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function moveMessage(move: Direction | Vec2): ClientMessage {
  if (typeof move === 'string') return { type: 'MOVE_PLAYER', direction: move };
  return { type: 'MOVE_PLAYER', delta: move };
}

export const useGameStore = create<GameState>((set, get) => ({
  socket: null,
  connected: false,
  selfId: storedIdentity?.id ?? null,
  playerName: storedIdentity?.name ?? '',
  selectedFaction: storedIdentity?.faction ?? 'red',
  notice: null,
  map: null,
  state: initialState,
  cameraSettings: initialCameraSettings,
  connect: () => {
    const existing = get().socket;
    if (existing && existing.readyState <= WebSocket.OPEN) return;

    const socket = new WebSocket(wsUrl());

    socket.addEventListener('open', () => {
      set({ connected: true, notice: '已连接实时服务器。' });

      const identity = !isSpectatorRoute() ? readStoredIdentity() : null;
      if (identity) {
        send(socket, { type: 'RESUME_PLAYER', playerId: identity.id });
      }
    });

    socket.addEventListener('close', () => {
      set({ connected: false, socket: null, notice: '服务器连接已断开。' });
    });

    socket.addEventListener('error', () => {
      set({ notice: 'WebSocket 连接异常，请确认 server 已启动。' });
    });

    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data) as ServerMessage;

      if (message.type === 'INIT') {
        const nextSelfId = message.selfId ?? get().selfId;
        const selfPlayer = nextSelfId
          ? message.state.players.find((player) => player.id === nextSelfId)
          : undefined;

        if (message.selfId && selfPlayer && !isSpectatorRoute()) {
          writeStoredIdentity({
            id: selfPlayer.id,
            name: selfPlayer.name,
            faction: selfPlayer.faction,
          });
        }

        set((state) => ({
          selfId: nextSelfId,
          map: message.map,
          state: message.state,
          notice: message.selfId ? '加入成功，等待 NPC 开始比赛。' : state.notice,
        }));
        return;
      }

      if (message.type === 'STATE') {
        set({ state: message.state });
        return;
      }

      if (message.type === 'ERROR') {
        if (message.code === 'PLAYER_NOT_FOUND') {
          clearStoredIdentity();
          set({ selfId: null, playerName: '', notice: message.message });
          return;
        }

        set({ notice: message.message });
      }
    });

    set({ socket });
  },
  join: (name, faction) => {
    get().connect();
    const socket = get().socket;
    const trimmedName = name.trim() || 'Player';

    set({ playerName: trimmedName, selectedFaction: faction });

    if (socket?.readyState === WebSocket.OPEN) {
      send(socket, { type: 'JOIN', name: trimmedName, faction });
      return;
    }

    socket?.addEventListener(
      'open',
      () => send(socket, { type: 'JOIN', name: trimmedName, faction }),
      { once: true },
    );
  },
  sendMove: (move) => send(get().socket, moveMessage(move)),
  adminStart: (durationSeconds, mapConfig) => send(get().socket, { type: 'ADMIN_START', durationSeconds, mapConfig }),
  adminReset: (mapConfig) => send(get().socket, { type: 'ADMIN_RESET', mapConfig }),
  setCameraSettings: (settings) =>
    set((state) => ({
      cameraSettings: {
        ...state.cameraSettings,
        ...settings,
      },
    })),
}));

export function formatDuration(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, '0');
  const seconds = Math.max(0, totalSeconds % 60)
    .toString()
    .padStart(2, '0');

  return `${minutes}:${seconds}`;
}

export function leaderboardRows(scores: ServerState['scores']): LeaderboardRow[] {
  return factions
    .map((faction) => ({
      faction: faction.id,
      name: faction.name,
      color: faction.color,
      score: scores[faction.id] ?? 0,
    }))
    .sort((a, b) => b.score - a.score);
}
