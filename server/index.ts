import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { MOVE_INTERVAL_MS, PROTOCOL_VERSION, isFaction, validDelta, type ClientMessage, type Envelope, type InputAck, type MatchInfo, type PlayerEntity, type ServerMetrics, type ServerState, type StatePatch, type Vec2, type WorldConfig } from '../shared/protocol.js';
import { World } from './world.js';
import { needsSnapshot, TokenBucket, writable } from './transport.js';

function envInt(name: string, fallback: number, min: number, max: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer in ${min}..${max}`);
  return value;
}
const PORT = envInt('PORT', 3001, 0, 65535);
const MAX_PLAYERS = envInt('MAX_PLAYER_LIMIT', 50, 1, 2000);
const MAX_CONNECTIONS = envInt('MAX_CONNECTIONS', Math.max(100, MAX_PLAYERS + 50), MAX_PLAYERS, 10000);
const BROADCAST_HZ = envInt('BROADCAST_HZ', 12, 5, 30);
const BUFFER_LIMIT = envInt('MAX_BUFFERED_BYTES', 128 * 1024, 1024, 4 * 1024 * 1024);
const FULL_SYNC = process.env.SYNC_MODE === 'full';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || randomBytes(24).toString('base64url');
if (!process.env.ADMIN_TOKEN) console.log(`Temporary admin password (set ADMIN_TOKEN for a stable password): ${ADMIN_TOKEN}`);
const DEFAULT_DURATION = 45 * 60;
const roomConfig = { playerLimit: envInt('DEFAULT_PLAYER_LIMIT', Math.min(50, MAX_PLAYERS), 1, MAX_PLAYERS), maxPlayerLimit: MAX_PLAYERS, version: 0 };
let world = new World({ width: 64, height: 64, boxCount: 220 }, [], roomConfig.playerLimit);
let matchId = randomUUID(), mapVersion = 1, revision = 1, lastBroadcastRevision = 0;
let match: MatchInfo = { status: 'waiting', durationSeconds: DEFAULT_DURATION, startedAt: 0, endsAt: 0, remainingSeconds: DEFAULT_DURATION, countdownSeconds: 0 };
let dirty = true, lastSnapshotAt = 0;
interface Pending { seq: number; delta: Vec2; at: number; queued?: boolean }
interface Connection {
  identityPending: boolean; subscribed: boolean; role: 'player' | 'spectator'; playerId?: string; admin: boolean;
  revision: number; mapVersion: number; needsSnapshot: boolean; slowSince: number;
  pongAt: number; connectedAt: number; messageBucket: TokenBucket; moveBucket: TokenBucket; controlBucket: TokenBucket; pingBucket: TokenBucket;
  inputTimer?: NodeJS.Timeout; lastSeenSeq: number; settled: number; terminals: Set<number>; queue: Pending[];
}
interface Identity { token: string; offlineAt: number; nextMoveAt: number }
const connections = new Map<WebSocket, Connection>();
const socketsByPlayer = new Map<string, WebSocket>();
const identities = new Map<string, Identity>();
const handshakeBucket = new TokenBucket(40, 100);
const snapshotBucket = new TokenBucket(80, 100);
const loopDelay = monitorEventLoopDelay({ resolution: 10 }); loopDelay.enable();
const metrics: ServerMetrics = { connections: 0, spectators: 0, backpressured: 0, broadcastHz: BROADCAST_HZ, eventLoopP95Ms: 0, eventLoopP99Ms: 0, rssMB: 0, outboundBytes: 0, inputs: 0, moved: 0, rejected: 0, inputP95Ms: 0, queuedP95Ms: 0, cpuPercent: 0 };
let inputSamples: number[] = [], queuedSamples: number[] = [];
const percentile = (a: number[], p: number) => a.length ? a.sort((a, b) => a - b)[Math.min(a.length - 1, Math.floor(a.length * p))] : 0;
function changed() { revision++; dirty = true; }
function envelope(): Envelope { return { protocolVersion: PROTOCOL_VERSION, matchId, mapVersion, revision, serverTime: Date.now() }; }
function clockMatch(now = Date.now()): MatchInfo {
  return { ...match, remainingSeconds: match.status === 'ended' ? 0 : match.status === 'running' ? Math.max(0, Math.ceil((match.endsAt - now) / 1000)) : match.durationSeconds,
    countdownSeconds: match.status === 'countdown' ? Math.max(0, Math.ceil((match.startedAt - now) / 1000)) : 0 };
}
function stats() { return { onlinePlayers: socketsByPlayer.size, playerLimit: roomConfig.playerLimit, totalPlayers: world.players.size, boxCount: world.config.boxCount }; }
function state(): ServerState { return { players: world.online().map(p => ({ ...p })), boxes: world.snapshotBoxes(), scores: { ...world.scores }, match: clockMatch(), stats: stats(), roomConfig: { ...roomConfig } }; }
function inputSeqs() { return Object.fromEntries([...socketsByPlayer].map(([id, socket]) => [id, connections.get(socket)?.settled ?? 0])); }
function sendSerialized(socket: WebSocket, value: string) {
  const c = connections.get(socket); if (!c || !writable(socket, c, BUFFER_LIMIT, performance.now())) return false;
  socket.send(value); metrics.outboundBytes += Buffer.byteLength(value); return true;
}
function send(socket: WebSocket, value: unknown) { return sendSerialized(socket, JSON.stringify(value)); }
function error(socket: WebSocket, message: string, code = 'INVALID_REQUEST', action?: string) { send(socket, { type: 'ERROR', message, code, action }); }
function init(socket: WebSocket, resumeToken?: string) {
  const c = connections.get(socket)!;
  if (!snapshotBucket.take()) { c.needsSnapshot = true; return; }
  if (send(socket, { type: 'INIT', ...envelope(), selfId: c.playerId, resumeToken: resumeToken ?? (c.identityPending && c.playerId ? identities.get(c.playerId)?.token : undefined), inputSeq: c.settled, map: world.map, state: state() })) {
    c.revision = revision; c.mapVersion = mapVersion; c.needsSnapshot = false; c.identityPending = false;
  }
}
let lastMeta = '';
let lastEntities = { players: new Map<string, PlayerEntity>(), boxes: new Map<string, ServerState['boxes'][number]>() };
function entityChanges<T extends { id: string }>(current: T[], changedIds: Set<string>, previous: Map<string, T>) {
  return current.filter(p => changedIds.has(p.id)).map(p => {
    const old = previous.get(p.id);
    if (!old) return p;
    return Object.fromEntries(Object.entries(p).filter(([key, value]) => key === 'id' || value !== old[key as keyof T])) as Partial<T> & Pick<T, 'id'>;
  });
}
function broadcast(forceSnapshot = false) {
  const now = Date.now(), checkpoint = forceSnapshot || now - lastSnapshotAt >= 5000;
  const waitingSnapshots = [...connections.values()].some(c => c.subscribed && c.needsSnapshot);
  if (!dirty && !checkpoint && !waitingSnapshots) return;
  const current = state(), baseRevision = lastBroadcastRevision;
  const meta = { scores: current.scores, match: current.match, stats: current.stats, roomConfig: current.roomConfig };
  // Metadata is infrequent; comparing here also keeps unchanged HUD subscriptions stable on the client.
  const metaText = JSON.stringify(meta);
  const patch: StatePatch = {
    players: { upsert: entityChanges(current.players, world.changedPlayers, lastEntities.players), remove: [...world.removedPlayers] },
    boxes: { upsert: entityChanges(current.boxes, world.changedBoxes, lastEntities.boxes), remove: [] },
    ...(metaText !== lastMeta ? meta : {}),
  };
  const seqs = inputSeqs();
  const delta = JSON.stringify({ type: 'DELTA', ...envelope(), baseRevision, patch });
  const full = JSON.stringify({ type: 'STATE', ...envelope(), state: current, inputSeqs: seqs });
  let mapFull: string | undefined;
  for (const [socket, c] of connections) {
    if (!c.subscribed) continue;
    if (c.identityPending) { init(socket); continue; }
    if (!writable(socket, c, BUFFER_LIMIT, performance.now())) continue;
    const mapChanged = c.mapVersion !== mapVersion;
    const fullRequired = checkpoint || FULL_SYNC || needsSnapshot(c, baseRevision, mapVersion);
    // Rate-limit initial/catch-up snapshots; a normal synchronized client needs no extra work.
    if ((mapChanged || c.needsSnapshot) && !snapshotBucket.take()) continue;
    let value = delta;
    if (mapChanged) {
      mapFull ??= JSON.stringify({ type: 'INIT', ...envelope(), map: world.map, state: current, inputSeqs: seqs });
      value = mapFull;
    } else if (fullRequired) value = full;
    if (sendSerialized(socket, value)) { c.revision = revision; c.mapVersion = mapVersion; c.needsSnapshot = false; }
  }
  lastEntities = { players: new Map(current.players.map(p => [p.id, p])), boxes: new Map(current.boxes.map(b => [b.id, b])) };
  world.clearChanges(); dirty = false; lastBroadcastRevision = revision; lastMeta = metaText;
  if (checkpoint) lastSnapshotAt = now;
}
function secretEqual(a: string, b: string) { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
function attach(socket: WebSocket, id: string) {
  const c = connections.get(socket)!, old = socketsByPlayer.get(id);
  if (old && old !== socket) { const previous = connections.get(old); if (previous) { clearTimeout(previous.inputTimer); previous.playerId = undefined; previous.queue = []; } old.close(4001, 'Session replaced'); }
  c.playerId = id; c.identityPending = true; c.role = 'player'; c.lastSeenSeq = 0; c.settled = 0; c.terminals.clear(); c.queue = [];
  socketsByPlayer.set(id, socket); identities.get(id)!.offlineAt = 0;
}
function terminal(socket: WebSocket, input: Pending, result: InputAck['result']) {
  const c = connections.get(socket)!; if (!c.playerId) return;
  const p = world.players.get(c.playerId); if (!p) return;
  c.terminals.add(input.seq);
  while (c.terminals.delete(c.settled + 1)) c.settled++;
  changed();
  const elapsed = performance.now() - input.at;
  const samples = input.queued ? queuedSamples : inputSamples;
  if (samples.length < 10000) samples.push(elapsed);
  if (result === 'moved') metrics.moved++; else if (result !== 'blocked') metrics.rejected++;
  send(socket, { type: 'INPUT_ACK', ...envelope(), ack: { inputSeq: input.seq, settledThrough: c.settled, result, player: { ...p }, receivedAt: Date.now() - elapsed, processedAt: Date.now() } });
}
function execute(socket: WebSocket, input: Pending) {
  const c = connections.get(socket)!, identity = identities.get(c.playerId!)!;
  if (match.status !== 'running') { terminal(socket, input, 'inactive'); return; }
  if (performance.now() - input.at > 250) { terminal(socket, input, 'expired'); return; }
  identity.nextMoveAt = performance.now() + MOVE_INTERVAL_MS;
  terminal(socket, input, world.move(c.playerId!, input.delta) ? 'moved' : 'blocked');
}
function scheduleInput(socket: WebSocket) {
  const c = connections.get(socket);
  if (!c?.playerId || c.inputTimer || !c.queue.length) return;
  const identity = identities.get(c.playerId)!;
  c.inputTimer = setTimeout(() => {
    c.inputTimer = undefined;
    if (connections.get(socket) !== c || !c.playerId || !c.queue.length) return;
    if (performance.now() >= identity.nextMoveAt || match.status !== 'running') execute(socket, c.queue.shift()!);
    scheduleInput(socket);
  }, Math.max(1, identity.nextMoveAt - performance.now()));
}
function parseMap(config: unknown): WorldConfig {
  if (config !== undefined && (!config || typeof config !== 'object' || Array.isArray(config))) throw new Error('地图设置格式错误。');
  const c = (config ?? {}) as Partial<WorldConfig>;
  const result = { ...world.config, ...c };
  if (!Number.isInteger(result.width) || result.width < 24 || result.width > 96 || !Number.isInteger(result.height) || result.height < 24 || result.height > 96 || !Number.isInteger(result.boxCount) || result.boxCount < 40 || result.boxCount > 500) throw new Error('地图宽高须为 24～96，箱子数量须为 40～500 的整数。');
  return { width: result.width, height: result.height, boxCount: result.boxCount };
}
function handleMessage(socket: WebSocket, raw: string) {
  const c = connections.get(socket)!;
  if (!c.messageBucket.take()) { socket.close(4008, 'Message rate exceeded'); return; }
  let value: unknown; try { value = JSON.parse(raw); } catch { error(socket, '消息格式错误。'); return; }
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof (value as { type?: unknown }).type !== 'string') { error(socket, '无效消息。'); return; }
  const m = value as ClientMessage;
  if (m.type === 'MOVE_PLAYER') {
    if (!c.moveBucket.take()) { socket.close(4008, 'Input rate exceeded'); return; }
    if (!c.playerId || !validDelta(m.delta) || !Number.isSafeInteger(m.inputSeq) || m.inputSeq !== c.lastSeenSeq + 1) { error(socket, '输入序号或方向无效。', 'INVALID_INPUT'); return; }
    c.lastSeenSeq = m.inputSeq; metrics.inputs++;
    const input = { seq: m.inputSeq, delta: m.delta, at: performance.now() };
    if (m.matchId !== matchId || match.status !== 'running') { terminal(socket, input, 'inactive'); return; }
    if (c.queue.length >= 2) { terminal(socket, input, 'overloaded'); return; }
    if (c.queue.length === 0 && performance.now() >= identities.get(c.playerId)!.nextMoveAt) execute(socket, input);
    else { Object.assign(input, { queued: true }); c.queue.push(input); scheduleInput(socket); }
    return;
  }
  if (m.type === 'PING') {
    if (c.pingBucket.take() && typeof m.clientTime === 'number' && Number.isFinite(m.clientTime)) send(socket, { type: 'PONG', clientTime: m.clientTime, serverTime: Date.now() });
    return;
  }
  if (!c.controlBucket.take()) { error(socket, '操作过于频繁，请稍后重试。', 'RATE_LIMIT', m.type); return; }
  if (m.type === 'SUBSCRIBE') {
    if (m.protocolVersion !== PROTOCOL_VERSION) { error(socket, '页面版本已更新，请刷新。', 'PROTOCOL_MISMATCH'); return; }
    if (m.role !== 'player' && m.role !== 'spectator') return;
    if (c.subscribed) return;
    c.subscribed = true; c.role = m.role; c.needsSnapshot = true; init(socket); return;
  }
  if (!c.subscribed) { error(socket, '请先订阅房间。', 'SUBSCRIBE_REQUIRED'); return; }
  if (m.type === 'RESYNC') { c.needsSnapshot = true; return; }
  if (m.type === 'ADMIN_AUTH') {
    c.admin = typeof m.token === 'string' && secretEqual(m.token, ADMIN_TOKEN);
    send(socket, { type: 'ADMIN_AUTH', authorized: c.admin }); return;
  }
  if (m.type === 'JOIN') {
    if (!isFaction(m.faction) || typeof m.name !== 'string' || !m.name.trim() || m.name.length > 100) throw new Error('请输入昵称并选择有效队伍。');
    const name = m.name.trim().slice(0, 20);
    if (c.playerId) {
      if (match.status !== 'waiting') throw new Error('只有等待中可以更换队伍。');
      world.changeTeam(c.playerId, name, m.faction); changed(); init(socket, identities.get(c.playerId)!.token); return;
    }
    if (socketsByPlayer.size >= roomConfig.playerLimit) { error(socket, `房间已满，最多 ${roomConfig.playerLimit} 人。`, 'ROOM_FULL'); return; }
    const p = world.join(name, m.faction), token = randomBytes(24).toString('base64url');
    identities.set(p.id, { token, offlineAt: 0, nextMoveAt: 0 }); attach(socket, p.id); changed(); init(socket, token); return;
  }
  if (m.type === 'RESUME_PLAYER') {
    if (c.playerId) throw new Error('当前连接已经绑定玩家。');
    const identity = typeof m.playerId === 'string' ? identities.get(m.playerId) : undefined;
    if (!identity || typeof m.resumeToken !== 'string' || !secretEqual(m.resumeToken, identity.token) || (identity.offlineAt > 0 && Date.now() - identity.offlineAt > 300000)) { error(socket, '玩家身份已失效，请重新加入。', 'PLAYER_NOT_FOUND'); return; }
    if (!socketsByPlayer.has(m.playerId) && socketsByPlayer.size >= roomConfig.playerLimit) { error(socket, '房间已满，请稍后重试恢复连接。', 'ROOM_FULL'); return; }
    world.resume(m.playerId); attach(socket, m.playerId); changed(); init(socket, identity.token); return;
  }
  if (m.type.startsWith('ADMIN_')) {
    if (!c.admin) { error(socket, '请先输入管理密码。', 'UNAUTHORIZED', m.type); return; }
    if (m.type === 'ADMIN_CONFIG') {
      if (match.status === 'running' || match.status === 'countdown') throw new Error('比赛中不能修改人数上限。');
      if (m.version !== roomConfig.version) throw new Error('房间设置已被其他管理员更新，请重新保存。');
      if (!Number.isInteger(m.playerLimit) || m.playerLimit < 1 || m.playerLimit > MAX_PLAYERS) throw new Error(`人数必须为 1～${MAX_PLAYERS} 的整数。`);
      if (m.playerLimit < socketsByPlayer.size) throw new Error('人数上限不能小于当前在线人数。');
      if (m.playerLimit > world.capacity()) throw new Error('人数上限超过地图可用格子，请扩大地图或减少箱子。');
      roomConfig.playerLimit = m.playerLimit; roomConfig.version++; changed();
      send(socket, { type: 'ADMIN_RESULT', action: m.type, message: '房间人数已保存，立即生效。' }); return;
    }
    if (m.type === 'ADMIN_START' || m.type === 'ADMIN_RESET') {
      if (m.type === 'ADMIN_START' && (match.status === 'running' || match.status === 'countdown')) throw new Error('比赛已经开始。');
      if (m.type === 'ADMIN_START' && socketsByPlayer.size === 0) throw new Error('至少需要一名在线玩家才能开始。');
      const duration = m.type === 'ADMIN_START' ? m.durationSeconds : DEFAULT_DURATION;
      if (!Number.isInteger(duration) || duration < 60 || duration > 5400) throw new Error('比赛时长必须为 1～90 分钟。');
      const candidate = new World(parseMap(m.mapConfig), world.players.values(), roomConfig.playerLimit);
      world = candidate; matchId = randomUUID(); mapVersion++; changed();
      const start = Date.now() + 3000;
      match = { status: m.type === 'ADMIN_START' ? 'countdown' : 'waiting', durationSeconds: duration, startedAt: m.type === 'ADMIN_START' ? start : 0, endsAt: m.type === 'ADMIN_START' ? start + duration * 1000 : 0, remainingSeconds: duration, countdownSeconds: m.type === 'ADMIN_START' ? 3 : 0 };
      for (const [s, conn] of connections) {
        for (const pending of conn.queue) terminal(s, pending, 'inactive');
        clearTimeout(conn.inputTimer); conn.inputTimer = undefined; conn.queue = []; conn.needsSnapshot = true;
      }
      send(socket, { type: 'ADMIN_RESULT', action: m.type, message: m.type === 'ADMIN_START' ? '倒计时已开始。' : '战场已重置。' }); return;
    }
  }
  error(socket, '不支持的消息类型。');
}

const CLIENT_DIST = path.resolve(process.cwd(), process.env.CLIENT_DIST_DIR ?? 'dist/client');
const CONTENT_TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2' };
function endResponse(res: ServerResponse, status: number, text: string) { res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(text); }
async function handleHttp(req: IncomingMessage, res: ServerResponse) {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (req.method !== 'GET' && req.method !== 'HEAD') { endResponse(res, 405, 'Method Not Allowed'); return; }
  if (pathname === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ status: 'ok', onlinePlayers: socketsByPlayer.size, protocolVersion: PROTOCOL_VERSION })); return; }
  const requested = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  let filename = path.resolve(CLIENT_DIST, requested);
  if (!filename.startsWith(CLIENT_DIST + path.sep)) { endResponse(res, 403, 'Forbidden'); return; }
  let content: Buffer;
  try { content = await readFile(filename); } catch {
    if (path.extname(requested)) { endResponse(res, 404, 'Not Found'); return; }
    filename = path.join(CLIENT_DIST, 'index.html');
    try { content = await readFile(filename); } catch { endResponse(res, 503, 'Client build is unavailable'); return; }
  }
  res.writeHead(200, { 'Content-Type': CONTENT_TYPES[path.extname(filename)] ?? 'application/octet-stream', 'Cache-Control': path.basename(filename) === 'index.html' ? 'no-cache' : 'public, max-age=31536000, immutable' });
  res.end(req.method === 'HEAD' ? undefined : content);
}
const httpServer = createServer((req, res) => { void handleHttp(req, res).catch(() => { if (!res.headersSent) endResponse(res, 500, 'Internal Server Error'); else res.end(); }); });
const wss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });
httpServer.on('upgrade', (req, socket, head) => {
  if (connections.size >= MAX_CONNECTIONS || !handshakeBucket.take()) { socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); return; }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});
wss.on('connection', socket => {
  connections.set(socket, { identityPending: false, subscribed: false, role: 'player', admin: false, revision: -1, mapVersion: -1, needsSnapshot: true, slowSince: 0, pongAt: performance.now(), connectedAt: performance.now(), messageBucket: new TokenBucket(30, 16), moveBucket: new TokenBucket(20, 8), controlBucket: new TokenBucket(2, 8), pingBucket: new TokenBucket(1, 3), lastSeenSeq: 0, settled: 0, terminals: new Set(), queue: [] });
  send(socket, { type: 'HELLO', protocolVersion: PROTOCOL_VERSION, adminRequired: true });
  socket.on('pong', () => { const c = connections.get(socket); if (c) c.pongAt = performance.now(); });
  socket.on('message', raw => {
    try { handleMessage(socket, raw.toString()); }
    catch (e) { error(socket, e instanceof Error ? e.message : '请求失败。'); }
  });
  socket.on('error', () => { /* close handles cleanup, including oversized payloads */ });
  socket.on('close', () => {
    const c = connections.get(socket); clearTimeout(c?.inputTimer); connections.delete(socket);
    if (c?.playerId && socketsByPlayer.get(c.playerId) === socket) {
      socketsByPlayer.delete(c.playerId); world.disconnect(c.playerId);
      const identity = identities.get(c.playerId); if (identity) identity.offlineAt = Date.now(); changed();
    }
  });
});
const timers: NodeJS.Timeout[] = [];
timers.push(setInterval(() => {
  const now = Date.now();
  if (match.status === 'countdown' && now >= match.startedAt) { match.status = 'running'; changed(); }
  if (match.status === 'running' && now >= match.endsAt) { match.status = 'ended'; changed(); }
}, 20));
timers.push(setInterval(() => broadcast(), 1000 / BROADCAST_HZ));
let cpuAt = process.cpuUsage(), cpuTime = performance.now();
timers.push(setInterval(() => {
  const now = performance.now(), wallNow = Date.now();
  if (match.status === 'running' && world.respawnStuck()) changed();
  for (const [id, identity] of identities) if (identity.offlineAt && wallNow - identity.offlineAt > 300000) { identities.delete(id); world.players.delete(id); changed(); }
  for (const [s, c] of connections) {
    if ((!c.subscribed && now - c.connectedAt > 10000) || (c.role === 'player' && !c.playerId && now - c.connectedAt > 120000) || (c.slowSince && now - c.slowSince > 3000) || now - c.pongAt > 30000) s.terminate();
  }
  const cpu = process.cpuUsage(cpuAt);
  Object.assign(metrics, { connections: connections.size, spectators: [...connections.values()].filter(c => c.subscribed && !c.playerId).length, backpressured: [...connections.values()].filter(c => c.slowSince).length,
    eventLoopP95Ms: loopDelay.percentile(95) / 1e6, eventLoopP99Ms: loopDelay.percentile(99) / 1e6, rssMB: process.memoryUsage().rss / 1048576,
    inputP95Ms: percentile(inputSamples, .95), queuedP95Ms: percentile(queuedSamples, .95), cpuPercent: (cpu.user + cpu.system) / ((now - cpuTime) * 1000) * 100 });
  cpuAt = process.cpuUsage(); cpuTime = now; inputSamples = []; queuedSamples = []; loopDelay.reset();
  for (const [s, c] of connections) if (c.admin) send(s, { type: 'METRICS', metrics });
  // One low-frequency metadata update keeps clocks, capacity and roster counts fresh.
  dirty = true;
}, 1000));
timers.push(setInterval(() => { for (const s of connections.keys()) if (s.readyState === WebSocket.OPEN) s.ping(); }, 15000));
httpServer.listen(PORT, '0.0.0.0', () => console.log(`OpenAtom server listening on http://0.0.0.0:${(httpServer.address() as { port: number }).port}`));
function shutdown() { timers.forEach(clearInterval); loopDelay.disable(); for (const [s, c] of connections) { clearTimeout(c.inputTimer); s.terminate(); } wss.close(); httpServer.close(); }
process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
