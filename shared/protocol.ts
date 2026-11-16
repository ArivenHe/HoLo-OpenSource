export const PROTOCOL_VERSION = 2;
export const MOVE_INTERVAL_MS = 115;
export const FACTIONS = [
  { id: 'red', name: 'Red', color: '#ef4444' },
  { id: 'blue', name: 'Blue', color: '#3b82f6' },
  { id: 'green', name: 'Green', color: '#22c55e' },
  { id: 'yellow', name: 'Yellow', color: '#eab308' },
] as const;
export type FactionId = typeof FACTIONS[number]['id'];
export type MatchStatus = 'waiting' | 'countdown' | 'running' | 'ended';
export type Direction = 'up' | 'down' | 'left' | 'right';
export interface Vec2 { x: number; y: number }
export interface WorldConfig { width: number; height: number; boxCount: number }
export interface RoomConfig { playerLimit: number; maxPlayerLimit: number; version: number }
export interface CameraSettings { height: number; distance: number; shake: number }
export interface FactionBase { id: FactionId; name: string; color: string; cells: Vec2[] }
export interface StaticMap { width: number; height: number; walls: [number, number][]; bases: FactionBase[] }
export interface PlayerEntity extends Vec2 {
  id: string; name: string; faction: FactionId; color: string; connected: boolean; assigned: boolean;
}
export interface BoxEntity extends Vec2 { id: string; faction: FactionId; color: string }
export interface MatchInfo {
  status: MatchStatus; durationSeconds: number; startedAt: number; endsAt: number;
  remainingSeconds: number; countdownSeconds: number;
}
export interface GameStats { onlinePlayers: number; playerLimit: number; totalPlayers: number; boxCount: number }
export interface ServerState {
  players: PlayerEntity[]; boxes: BoxEntity[]; scores: Record<FactionId, number>;
  match: MatchInfo; stats: GameStats; roomConfig: RoomConfig;
}
export interface Envelope {
  protocolVersion: number; matchId: string; mapVersion: number; revision: number; serverTime: number;
}
export interface EntityChanges<T extends { id: string }> { upsert: (Partial<T> & Pick<T, 'id'>)[]; remove: string[] }
export type StatePatch = Partial<Omit<ServerState, 'players' | 'boxes'>> & {
  players: EntityChanges<PlayerEntity>; boxes: EntityChanges<BoxEntity>;
};
export interface InputAck {
  inputSeq: number; settledThrough: number; result: 'moved' | 'blocked' | 'expired' | 'overloaded' | 'inactive';
  player: PlayerEntity; receivedAt: number; processedAt: number;
}
export interface ServerMetrics {
  connections: number; spectators: number; backpressured: number; broadcastHz: number;
  eventLoopP95Ms: number; eventLoopP99Ms: number; rssMB: number; outboundBytes: number;
  inputs: number; moved: number; rejected: number; inputP95Ms: number; queuedP95Ms: number;
  cpuPercent: number;
}
export type ServerMessage =
  | (Envelope & { type: 'INIT'; selfId?: string; resumeToken?: string; map: StaticMap; state: ServerState; inputSeq?: number; inputSeqs?: Record<string, number> })
  | (Envelope & { type: 'STATE'; state: ServerState; inputSeqs: Record<string, number> })
  | (Envelope & { type: 'DELTA'; baseRevision: number; patch: StatePatch; inputSeqs?: Record<string, number> })
  | (Envelope & { type: 'INPUT_ACK'; ack: InputAck })
  | { type: 'HELLO'; protocolVersion: number; adminRequired: boolean }
  | { type: 'ADMIN_AUTH'; authorized: boolean }
  | { type: 'ADMIN_RESULT'; action: string; message: string }
  | { type: 'METRICS'; metrics: ServerMetrics }
  | { type: 'PONG'; clientTime: number; serverTime: number }
  | { type: 'ERROR'; message: string; code?: string; action?: string };
export type ClientMessage =
  | { type: 'SUBSCRIBE'; role: 'player' | 'spectator'; protocolVersion: number }
  | { type: 'JOIN'; name: string; faction: FactionId }
  | { type: 'RESUME_PLAYER'; playerId: string; resumeToken: string }
  | { type: 'MOVE_PLAYER'; matchId: string; inputSeq: number; delta: Vec2 }
  | { type: 'PING'; clientTime: number }
  | { type: 'RESYNC' }
  | { type: 'ADMIN_AUTH'; token: string }
  | { type: 'ADMIN_CONFIG'; playerLimit: number; version: number }
  | { type: 'ADMIN_START'; durationSeconds: number; mapConfig?: Partial<WorldConfig> }
  | { type: 'ADMIN_RESET'; mapConfig?: Partial<WorldConfig> };
export interface LeaderboardRow { faction: FactionId; name: string; color: string; score: number }
export const keyOf = (p: Vec2) => `${p.x}:${p.y}`;
export const directionDelta = (d: Direction): Vec2 => ({
  up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 },
})[d];
export function isFaction(value: unknown): value is FactionId { return FACTIONS.some(f => f.id === value); }
export function validDelta(value: unknown): value is Vec2 {
  if (!value || typeof value !== 'object') return false;
  const p = value as Vec2;
  return Number.isInteger(p.x) && Number.isInteger(p.y) && Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1 && (p.x !== 0 || p.y !== 0);
}
