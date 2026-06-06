import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';

type FactionId = 'red' | 'blue' | 'green' | 'yellow';
type MatchStatus = 'waiting' | 'countdown' | 'running' | 'ended';
type Direction = 'up' | 'down' | 'left' | 'right';

interface Vec2 {
  x: number;
  y: number;
}

interface FactionInfo {
  id: FactionId;
  name: string;
  color: string;
  base: Vec2[];
}

interface PlayerEntity extends Vec2 {
  id: string;
  name: string;
  faction: FactionId;
  color: string;
  connected: boolean;
  assigned: boolean;
}

interface BoxEntity extends Vec2 {
  id: string;
  faction: FactionId;
  color: string;
  code: string;
  lastMovedAt: number;
}

interface WorldConfig {
  width: number;
  height: number;
  boxCount: number;
}

interface ClientMessage {
  type: 'JOIN' | 'RESUME_PLAYER' | 'MOVE_PLAYER' | 'ADMIN_START' | 'ADMIN_RESET';
  playerId?: string;
  name?: string;
  faction?: FactionId;
  direction?: Direction;
  delta?: Partial<Vec2>;
  durationSeconds?: number;
  mapConfig?: Partial<WorldConfig>;
}

const PORT = Number(process.env.PORT ?? 3001);
const DEFAULT_MAP_WIDTH = 64;
const DEFAULT_MAP_HEIGHT = 64;
const PLAYER_LIMIT = 50;
const DEFAULT_BOX_COUNT = 220;
const ACTIVE_BROADCAST_HZ = 12;
const IDLE_BROADCAST_MS = 1000;
const MAX_DYNAMIC_BUFFERED_BYTES = 512 * 1024;
const DEFAULT_DURATION_SECONDS = 45 * 60;
const START_COUNTDOWN_SECONDS = 3;
const RESPAWN_AFTER_MS = 60_000;
const BASE_SIZE = 6;
const MIN_MAP_SIZE = 24;
const MAX_MAP_SIZE = 96;
const MIN_BOX_COUNT = 40;
const MAX_BOX_COUNT = 500;
const CLIENT_DIST_DIR = path.resolve(process.cwd(), process.env.CLIENT_DIST_DIR ?? 'dist/client');
const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

let worldConfig: WorldConfig = {
  width: DEFAULT_MAP_WIDTH,
  height: DEFAULT_MAP_HEIGHT,
  boxCount: DEFAULT_BOX_COUNT,
};
let factions: FactionInfo[] = buildFactions(worldConfig);

const codePhrases = [
  'printf("Hello, 开源!");',
  'git push origin main',
  'npm run build',
  'const pr = review();',
  'fork().commit()',
  'merge(openSource)',
  'license.check()',
  'community.join()',
];

const clients = new Map<WebSocket, string>();
const socketsByPlayer = new Map<string, WebSocket>();
let players = new Map<string, PlayerEntity>();
let boxes = new Map<string, BoxEntity>();
let walls = new Set<string>();
let scores: Record<FactionId, number> = { red: 0, blue: 0, green: 0, yellow: 0 };
let match = {
  status: 'waiting' as MatchStatus,
  durationSeconds: DEFAULT_DURATION_SECONDS,
  startedAt: 0,
  endsAt: 0,
};
let stateDirty = true;
let lastDynamicBroadcastAt = 0;

function buildBase(startX: number, startY: number) {
  const cells: Vec2[] = [];

  for (let y = startY; y < startY + BASE_SIZE; y += 1) {
    for (let x = startX; x < startX + BASE_SIZE; x += 1) {
      cells.push({ x, y });
    }
  }

  return cells;
}

function buildFactions(config: WorldConfig): FactionInfo[] {
  const rightBaseX = config.width - BASE_SIZE - 2;
  const bottomBaseY = config.height - BASE_SIZE - 2;

  return [
    { id: 'red', name: 'Red', color: '#ef4444', base: buildBase(2, 2) },
    { id: 'blue', name: 'Blue', color: '#3b82f6', base: buildBase(rightBaseX, 2) },
    { id: 'green', name: 'Green', color: '#22c55e', base: buildBase(2, bottomBaseY) },
    { id: 'yellow', name: 'Yellow', color: '#eab308', base: buildBase(rightBaseX, bottomBaseY) },
  ];
}

function clampInteger(value: unknown, fallback: number, min: number, max: number) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

function normalizeWorldConfig(config: Partial<WorldConfig> = {}) {
  return {
    width: clampInteger(config.width, worldConfig.width, MIN_MAP_SIZE, MAX_MAP_SIZE),
    height: clampInteger(config.height, worldConfig.height, MIN_MAP_SIZE, MAX_MAP_SIZE),
    boxCount: clampInteger(config.boxCount, worldConfig.boxCount, MIN_BOX_COUNT, MAX_BOX_COUNT),
  };
}

function applyWorldConfig(config: Partial<WorldConfig> = {}) {
  worldConfig = normalizeWorldConfig(config);
  factions = buildFactions(worldConfig);
}

function keyOf(position: Vec2) {
  return `${position.x}:${position.y}`;
}

function randomId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function randomInt(min: number, max: number) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function getFaction(id: FactionId) {
  return factions.find((faction) => faction.id === id) ?? factions[0];
}

function isFactionId(value: unknown): value is FactionId {
  return value === 'red' || value === 'blue' || value === 'green' || value === 'yellow';
}

function isPlayerOnline(player: PlayerEntity) {
  return player.connected && socketsByPlayer.has(player.id);
}

function onlinePlayers() {
  return [...players.values()].filter(isPlayerOnline);
}

function factionWithFewestPlayers() {
  const counts = new Map<FactionId, number>(factions.map((faction) => [faction.id, 0]));
  onlinePlayers().forEach((player) => {
    if (!player.assigned) return;
    counts.set(player.faction, (counts.get(player.faction) ?? 0) + 1);
  });

  return [...counts.entries()].sort((a, b) => a[1] - b[1])[0][0];
}

function isBaseCell(position: Vec2) {
  return factions.some((faction) => faction.base.some((cell) => cell.x === position.x && cell.y === position.y));
}

function baseFactionAt(position: Vec2) {
  return factions.find((faction) => faction.base.some((cell) => cell.x === position.x && cell.y === position.y));
}

function inBounds(position: Vec2) {
  return position.x >= 0 && position.y >= 0 && position.x < worldConfig.width && position.y < worldConfig.height;
}

function isWall(position: Vec2) {
  return !inBounds(position) || walls.has(keyOf(position));
}

function boxAt(position: Vec2) {
  return [...boxes.values()].find((box) => box.x === position.x && box.y === position.y);
}

function playerAt(position: Vec2, ignoredPlayerId?: string) {
  return [...players.values()].find(
    (player) =>
      isPlayerOnline(player) && player.id !== ignoredPlayerId && player.x === position.x && player.y === position.y,
  );
}

function isOccupied(position: Vec2, ignoredPlayerId?: string) {
  return isWall(position) || Boolean(boxAt(position)) || Boolean(playerAt(position, ignoredPlayerId));
}

function randomOpenCell(options: { avoidBases?: boolean } = {}) {
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    const position = { x: randomInt(1, worldConfig.width - 2), y: randomInt(1, worldConfig.height - 2) };

    if (options.avoidBases && isBaseCell(position)) continue;
    if (!isOccupied(position)) return position;
  }

  return { x: Math.floor(worldConfig.width / 2), y: Math.floor(worldConfig.height / 2) };
}

function generateWalls() {
  walls = new Set<string>();

  for (let x = 0; x < worldConfig.width; x += 1) {
    walls.add(keyOf({ x, y: 0 }));
    walls.add(keyOf({ x, y: worldConfig.height - 1 }));
  }
  for (let y = 0; y < worldConfig.height; y += 1) {
    walls.add(keyOf({ x: 0, y }));
    walls.add(keyOf({ x: worldConfig.width - 1, y }));
  }

  const clusterCount = Math.max(16, Math.round((worldConfig.width * worldConfig.height) / 57));
  for (let cluster = 0; cluster < clusterCount; cluster += 1) {
    const origin = { x: randomInt(8, worldConfig.width - 9), y: randomInt(8, worldConfig.height - 9) };
    const length = randomInt(2, 5);
    const horizontal = Math.random() > 0.5;

    for (let step = 0; step < length; step += 1) {
      const position = {
        x: origin.x + (horizontal ? step : 0),
        y: origin.y + (horizontal ? 0 : step),
      };

      if (!isBaseCell(position)) walls.add(keyOf(position));
    }
  }
}

function spawnBox(id: string, factionId?: FactionId): BoxEntity {
  const faction = getFaction(factionId ?? factions[randomInt(0, factions.length - 1)].id);
  const position = randomOpenCell({ avoidBases: true });

  return {
    id,
    faction: faction.id,
    color: faction.color,
    code: codePhrases[randomInt(0, codePhrases.length - 1)],
    x: position.x,
    y: position.y,
    lastMovedAt: Date.now(),
  };
}

function spawnBoxes() {
  boxes = new Map<string, BoxEntity>();
  for (let index = 0; index < worldConfig.boxCount; index += 1) {
    const faction = factions[index % factions.length];
    const box = spawnBox(`box-${index}`, faction.id);
    boxes.set(box.id, box);
  }
}

function spawnForFaction(factionId: FactionId) {
  const faction = getFaction(factionId);
  return faction.base[Math.floor(faction.base.length / 2)];
}

function spawnPlayer(name: string, factionId?: FactionId): PlayerEntity {
  const faction = getFaction(factionId ?? factionWithFewestPlayers());
  const spawn = spawnForFaction(faction.id);

  return {
    id: randomId('player'),
    name: name.trim().slice(0, 20) || 'Player',
    faction: faction.id,
    color: faction.color,
    x: spawn.x,
    y: spawn.y,
    connected: true,
    assigned: true,
  };
}

function assignPlayerToFaction(player: PlayerEntity, factionId: FactionId) {
  const faction = getFaction(factionId);
  const spawn = spawnForFaction(faction.id);

  return {
    ...player,
    faction: faction.id,
    color: faction.color,
    x: spawn.x,
    y: spawn.y,
    assigned: true,
  };
}

function markStateDirty() {
  stateDirty = true;
}

function attachSocketToPlayer(socket: WebSocket, playerId: string) {
  const existingSocket = socketsByPlayer.get(playerId);
  if (existingSocket && existingSocket !== socket) {
    clients.delete(existingSocket);
    existingSocket.close(1000, 'Reconnected');
  }

  clients.set(socket, playerId);
  socketsByPlayer.set(playerId, socket);
}

function resetWorld(config?: Partial<WorldConfig>) {
  if (config) applyWorldConfig(config);

  generateWalls();
  boxes = new Map<string, BoxEntity>();
  scores = { red: 0, blue: 0, green: 0, yellow: 0 };
  players = new Map(
    [...players.values()].map((player) => {
      const faction = getFaction(player.faction);
      const spawn = spawnForFaction(faction.id);
      return [player.id, { ...player, color: faction.color, x: spawn.x, y: spawn.y, assigned: true }];
    }),
  );
  spawnBoxes();
}

function teamCounts() {
  const counts = new Map<FactionId, number>(factions.map((faction) => [faction.id, 0]));
  onlinePlayers().forEach((player) => {
    if (!player.assigned) return;
    counts.set(player.faction, (counts.get(player.faction) ?? 0) + 1);
  });

  return counts;
}

function teamDistributionIsBalanced() {
  const counts = [...teamCounts().values()];
  const onlineCount = counts.reduce((total, count) => total + count, 0);
  if (onlineCount <= 0) return false;

  return Math.max(...counts) - Math.min(...counts) <= 1;
}

function directionDelta(direction: Direction): Vec2 {
  if (direction === 'up') return { x: 0, y: -1 };
  if (direction === 'down') return { x: 0, y: 1 };
  if (direction === 'left') return { x: -1, y: 0 };
  return { x: 1, y: 0 };
}

function stepValue(value: unknown) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(-1, Math.min(1, Math.trunc(parsed)));
}

function moveDeltaFromMessage(message: ClientMessage) {
  if (message.delta) {
    const delta = {
      x: stepValue(message.delta.x),
      y: stepValue(message.delta.y),
    };
    if (delta.x !== 0 || delta.y !== 0) return delta;
  }

  if (message.direction) return directionDelta(message.direction);
  return null;
}

function scoreAndRespawnBox(box: BoxEntity) {
  const baseFaction = baseFactionAt(box);
  if (baseFaction?.id !== box.faction) return;

  scores[box.faction] += 1;
  boxes.set(box.id, spawnBox(box.id, box.faction));
}

function pushBoxChain(start: Vec2, delta: Vec2, playerId: string) {
  const chain: BoxEntity[] = [];
  let cursor = start;

  while (true) {
    const box = boxAt(cursor);
    if (!box) break;

    chain.push(box);
    cursor = { x: cursor.x + delta.x, y: cursor.y + delta.y };
  }

  if (chain.length === 0) return true;
  if (isWall(cursor) || playerAt(cursor, playerId)) return false;

  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const box = chain[index];
    box.x += delta.x;
    box.y += delta.y;
    box.lastMovedAt = Date.now();
  }

  chain.forEach((box) => {
    scoreAndRespawnBox(box);
  });

  return true;
}

function pullBoxBehind(previousPlayerPosition: Vec2, delta: Vec2) {
  const behind = {
    x: previousPlayerPosition.x - delta.x,
    y: previousPlayerPosition.y - delta.y,
  };
  const box = boxAt(behind);
  if (!box) return;

  box.x = previousPlayerPosition.x;
  box.y = previousPlayerPosition.y;
  box.lastMovedAt = Date.now();
  scoreAndRespawnBox(box);
}

function movePlayer(playerId: string, delta: Vec2) {
  if (match.status !== 'running') return false;

  const player = players.get(playerId);
  if (!player || !isPlayerOnline(player)) return false;

  const previousPlayerPosition = { x: player.x, y: player.y };
  const nextPlayer = { x: player.x + delta.x, y: player.y + delta.y };

  if (isWall(nextPlayer) || playerAt(nextPlayer, player.id)) return false;

  const pushedBox = boxAt(nextPlayer);
  if (pushedBox) {
    if (!pushBoxChain(nextPlayer, delta, player.id)) return false;
  }

  player.x = nextPlayer.x;
  player.y = nextPlayer.y;
  if (!pushedBox) pullBoxBehind(previousPlayerPosition, delta);
  return true;
}

function isDeadCorner(box: BoxEntity) {
  if (baseFactionAt(box)) return false;

  const left = isWall({ x: box.x - 1, y: box.y });
  const right = isWall({ x: box.x + 1, y: box.y });
  const up = isWall({ x: box.x, y: box.y - 1 });
  const down = isWall({ x: box.x, y: box.y + 1 });

  return (left || right) && (up || down);
}

function respawnStuckBoxes() {
  const now = Date.now();
  let respawned = false;

  boxes.forEach((box) => {
    if (now - box.lastMovedAt > RESPAWN_AFTER_MS && isDeadCorner(box)) {
      boxes.set(box.id, spawnBox(box.id, box.faction));
      respawned = true;
    }
  });

  return respawned;
}

function normalizeDuration(durationSeconds: unknown) {
  return clampInteger(durationSeconds, DEFAULT_DURATION_SECONDS, 60, 90 * 60);
}

function startMatch(durationSeconds = DEFAULT_DURATION_SECONDS, config?: Partial<WorldConfig>) {
  const normalizedDuration = normalizeDuration(durationSeconds);
  resetWorld(config);
  const runningStartsAt = Date.now() + START_COUNTDOWN_SECONDS * 1000;
  match = {
    status: 'countdown',
    durationSeconds: normalizedDuration,
    startedAt: runningStartsAt,
    endsAt: runningStartsAt + normalizedDuration * 1000,
  };
}

function resetMatch(config?: Partial<WorldConfig>) {
  resetWorld(config);
  match = {
    status: 'waiting',
    durationSeconds: DEFAULT_DURATION_SECONDS,
    startedAt: 0,
    endsAt: 0,
  };
}

function remainingSeconds() {
  if (match.status !== 'running') return match.durationSeconds;
  return Math.max(0, Math.ceil((match.endsAt - Date.now()) / 1000));
}

function countdownSeconds() {
  if (match.status !== 'countdown') return 0;
  return Math.max(0, Math.ceil((match.startedAt - Date.now()) / 1000));
}

function staticPayload(selfId?: string) {
  return {
    type: 'INIT',
    selfId,
    map: {
      width: worldConfig.width,
      height: worldConfig.height,
      walls: [...walls].map((item) => item.split(':').map(Number)),
      bases: factions.map((faction) => ({
        id: faction.id,
        name: faction.name,
        color: faction.color,
        cells: faction.base,
      })),
    },
    state: dynamicPayload().state,
  };
}

function dynamicPayload() {
  const currentOnlinePlayers = onlinePlayers();
  const boxSnapshots = [...boxes.values()].map((box) => ({
    id: box.id,
    faction: box.faction,
    color: box.color,
    x: box.x,
    y: box.y,
  }));

  return {
    type: 'STATE',
    state: {
      players: currentOnlinePlayers,
      boxes: boxSnapshots,
      scores,
      match: {
        ...match,
        remainingSeconds: remainingSeconds(),
        countdownSeconds: countdownSeconds(),
      },
      stats: {
        onlinePlayers: currentOnlinePlayers.length,
        playerLimit: PLAYER_LIMIT,
        totalPlayers: players.size,
        boxCount: worldConfig.boxCount,
      },
    },
  };
}

function send(socket: WebSocket, payload: unknown) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function sendSerialized(socket: WebSocket, payload: string, options: { skipBackpressured?: boolean } = {}) {
  if (socket.readyState !== WebSocket.OPEN) return;
  if (options.skipBackpressured && socket.bufferedAmount > MAX_DYNAMIC_BUFFERED_BYTES) return;
  socket.send(payload);
}

function broadcast(payload: unknown, options: { skipBackpressured?: boolean } = {}) {
  const serialized = JSON.stringify(payload);
  wss.clients.forEach((client) => sendSerialized(client, serialized, options));
}

function broadcastDynamicState(force = false) {
  const now = Date.now();
  if (!force && !stateDirty && now - lastDynamicBroadcastAt < IDLE_BROADCAST_MS) return;

  broadcast(dynamicPayload(), { skipBackpressured: true });
  stateDirty = false;
  lastDynamicBroadcastAt = now;
}

function endResponse(response: ServerResponse, statusCode: number, body: string) {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'text/plain; charset=utf-8');
  response.end(body);
}

async function handleHttpRequest(request: IncomingMessage, response: ServerResponse) {
  const method = request.method ?? 'GET';
  const pathname = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`).pathname;

  if (pathname === '/health') {
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify({ status: 'ok', onlinePlayers: onlinePlayers().length }));
    return;
  }

  if (method !== 'GET' && method !== 'HEAD') {
    response.setHeader('Allow', 'GET, HEAD');
    endResponse(response, 405, 'Method Not Allowed');
    return;
  }

  const requestedPath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  let filePath = path.resolve(CLIENT_DIST_DIR, requestedPath);
  const isInsideClientDist = filePath === CLIENT_DIST_DIR || filePath.startsWith(`${CLIENT_DIST_DIR}${path.sep}`);

  if (!isInsideClientDist) {
    endResponse(response, 403, 'Forbidden');
    return;
  }

  let content: Buffer;
  try {
    content = await readFile(filePath);
  } catch {
    if (path.extname(requestedPath)) {
      endResponse(response, 404, 'Not Found');
      return;
    }

    filePath = path.join(CLIENT_DIST_DIR, 'index.html');
    try {
      content = await readFile(filePath);
    } catch {
      endResponse(response, 503, 'Client build is unavailable');
      return;
    }
  }

  response.statusCode = 200;
  response.setHeader('Content-Type', CONTENT_TYPES[path.extname(filePath)] ?? 'application/octet-stream');
  response.setHeader('Cache-Control', path.basename(filePath) === 'index.html' ? 'no-cache' : 'public, max-age=31536000, immutable');
  response.end(method === 'HEAD' ? undefined : content);
}

function handleMessage(socket: WebSocket, raw: Buffer) {
  let message: ClientMessage;
  try {
    message = JSON.parse(raw.toString()) as ClientMessage;
  } catch {
    return;
  }

  if (message.type === 'JOIN') {
    const requestedFaction = isFactionId(message.faction) ? message.faction : factionWithFewestPlayers();
    const existingPlayerId = clients.get(socket);

    if (existingPlayerId) {
      const existingPlayer = players.get(existingPlayerId);
      if (!existingPlayer) return;

      if (match.status !== 'waiting') {
        send(socket, { type: 'ERROR', message: '比赛已经开始，暂时不能更换队伍。' });
        return;
      }

      const player = assignPlayerToFaction(
        {
          ...existingPlayer,
          name: (message.name ?? existingPlayer.name).trim().slice(0, 20) || existingPlayer.name,
          connected: true,
        },
        requestedFaction,
      );
      players.set(player.id, player);
      send(socket, staticPayload(player.id));
      markStateDirty();
      broadcastDynamicState(true);
      return;
    }

    if (onlinePlayers().length >= PLAYER_LIMIT) {
      send(socket, { type: 'ERROR', message: '房间已满，最多 50 人。' });
      return;
    }

    const player = spawnPlayer(message.name ?? '', requestedFaction);
    players.set(player.id, player);
    attachSocketToPlayer(socket, player.id);
    send(socket, staticPayload(player.id));
    markStateDirty();
    broadcastDynamicState(true);
    return;
  }

  if (message.type === 'RESUME_PLAYER') {
    if (!message.playerId) return;

    const player = players.get(message.playerId);
    if (!player) {
      send(socket, { type: 'ERROR', code: 'PLAYER_NOT_FOUND', message: '玩家状态已失效，请重新加入。' });
      return;
    }

    const resumedPlayer =
      match.status !== 'waiting' && !player.assigned
        ? assignPlayerToFaction({ ...player, connected: true }, factionWithFewestPlayers())
        : { ...player, connected: true };
    players.set(player.id, resumedPlayer);
    attachSocketToPlayer(socket, player.id);
    send(socket, staticPayload(player.id));
    markStateDirty();
    broadcastDynamicState(true);
    return;
  }

  if (message.type === 'MOVE_PLAYER') {
    const playerId = clients.get(socket);
    const delta = moveDeltaFromMessage(message);
    if (!playerId || !delta) return;
    if (movePlayer(playerId, delta)) markStateDirty();
    return;
  }

  if (message.type === 'ADMIN_START') {
    if (!teamDistributionIsBalanced()) {
      send(socket, { type: 'ERROR', message: '队伍人数还不均衡，请调整后再开始。' });
      return;
    }

    startMatch(message.durationSeconds ?? DEFAULT_DURATION_SECONDS, message.mapConfig);
    markStateDirty();
    broadcast(staticPayload());
    return;
  }

  if (message.type === 'ADMIN_RESET') {
    resetMatch(message.mapConfig);
    markStateDirty();
    broadcast(staticPayload());
  }
}

generateWalls();
spawnBoxes();

const httpServer = createServer((request, response) => {
  void handleHttpRequest(request, response).catch((error: unknown) => {
    console.error('HTTP request failed:', error);
    if (!response.headersSent) endResponse(response, 500, 'Internal Server Error');
    else response.end();
  });
});
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (socket) => {
  send(socket, staticPayload());

  socket.on('message', (raw) => handleMessage(socket, raw as Buffer));
  socket.on('close', () => {
    const playerId = clients.get(socket);
    clients.delete(socket);

    if (playerId) {
      if (socketsByPlayer.get(playerId) === socket) {
        socketsByPlayer.delete(playerId);
        const player = players.get(playerId);
        if (player) players.set(playerId, { ...player, connected: false });
      }
      markStateDirty();
      broadcastDynamicState(true);
    }
  });
});

setInterval(() => {
  let matchChanged = false;
  if (match.status === 'countdown' && countdownSeconds() <= 0) {
    match = { ...match, status: 'running' };
    matchChanged = true;
  }
  if (match.status === 'running' && remainingSeconds() <= 0) {
    match = { ...match, status: 'ended' };
    matchChanged = true;
  }
  if (match.status === 'running' && respawnStuckBoxes()) matchChanged = true;
  if (matchChanged) markStateDirty();
  broadcastDynamicState();
}, 1000 / ACTIVE_BROADCAST_HZ);

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`OpenAtom Sokoban server running on http://0.0.0.0:${PORT}`);
});
