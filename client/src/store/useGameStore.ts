import { create } from 'zustand';
import { FACTIONS, MOVE_INTERVAL_MS, PROTOCOL_VERSION, directionDelta, isFaction, type CameraSettings, type ClientMessage, type Direction, type FactionId, type LeaderboardRow, type PlayerEntity, type ServerMessage, type ServerMetrics, type ServerState, type StaticMap, type Vec2, type WorldConfig } from '../types/game';
import { acknowledge, applyPatch, collisionView, predictSelf, type CollisionView, type PendingInput } from './sync';

const PLAYER_STORAGE_KEY = 'openatom-sokoban-player-v2';
const ADMIN_STORAGE_KEY = 'openatom-sokoban-admin';
interface Identity { id: string; name: string; faction: FactionId; token: string }
const spectator = () => window.location.pathname.includes('spectator');
function storedIdentity(): Identity | null {
  try { const p = JSON.parse(localStorage.getItem(PLAYER_STORAGE_KEY) ?? 'null'); return p && typeof p.id === 'string' && typeof p.name === 'string' && typeof p.token === 'string' && isFaction(p.faction) ? p : null; } catch { return null; }
}
function saveIdentity(p: PlayerEntity, token: string) { try { localStorage.setItem(PLAYER_STORAGE_KEY, JSON.stringify({ id: p.id, name: p.name, faction: p.faction, token })); } catch { /* private mode */ } }
function readAdmin() { try { return sessionStorage.getItem(ADMIN_STORAGE_KEY) ?? ''; } catch { return ''; } }
interface GameState {
  socket: WebSocket | null; connected: boolean; ready: boolean; reconnecting: boolean;
  playerReady: boolean; joinSuccess: number; selfId: string | null; playerName: string; selectedFaction: FactionId; notice: string | null; joining: boolean;
  roster: PlayerEntity[]; map: StaticMap | null; state: ServerState; cameraSettings: CameraSettings;
  snapshotTime: number; displaySelf: Vec2 | null; renderEpoch: number; rtt: number | null; metrics: ServerMetrics | null;
  adminAuthorized: boolean; configSaving: boolean; adminPending: boolean;
  connect: () => void; join: (name: string, faction: FactionId) => void;
  sendMove: (move: Direction | Vec2) => void;
  authenticateAdmin: (token: string) => void; saveRoomConfig: (playerLimit: number) => void;
  adminStart: (duration: number, config?: Partial<WorldConfig>) => void; adminReset: (config?: Partial<WorldConfig>) => void;
  setCameraSettings: (settings: Partial<CameraSettings>) => void;
}
export const factions = FACTIONS;
const identity = !spectator() ? storedIdentity() : null;
const initialState: ServerState = { players: [], boxes: [], scores: { red: 0, blue: 0, green: 0, yellow: 0 },
  match: { status: 'waiting', durationSeconds: 2700, startedAt: 0, endsAt: 0, remainingSeconds: 2700, countdownSeconds: 0 },
  stats: { onlinePlayers: 0, playerLimit: 200, totalPlayers: 0, boxCount: 220 }, roomConfig: { playerLimit: 200, maxPlayerLimit: 200, version: 0 } };
let reconnectTimer: number | undefined, attempts = 0, heartbeat: number | undefined;
let pending: PendingInput[] = [], seq = 0, lastInputAt = -Infinity;
let currentMatchId = '', currentMapVersion = -1, currentRevision = -1, ackRevision = -1;
let latestSelf: PlayerEntity | undefined, collision: CollisionView | null = null;
let serverOffset = 0, bestRtt = Infinity, clockReady = false, awaitingResync = false;
let queuedJoin: { name: string; faction: FactionId } | null = null;
let adminPassword = readAdmin();
function url() {
  const env = import.meta.env.VITE_WS_URL as string | undefined; if (env) return env;
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.hostname}${import.meta.env.DEV ? ':3001' : location.port ? ':' + location.port : ''}`;
}
function send(message: ClientMessage) {
  const socket = useGameStore.getState().socket;
  if (socket?.readyState !== WebSocket.OPEN || socket.bufferedAmount > 4096) return false;
  socket.send(JSON.stringify(message)); return true;
}
function updateDisplay() {
  const g = useGameStore.getState(), self = g.state.players.find(p => p.id === g.selfId);
  if (!self || !collision) { if (g.displaySelf) useGameStore.setState({ displaySelf: null }); return; }
  const next = predictSelf(self, pending, collision, performance.now());
  if (!g.displaySelf || next.x !== g.displaySelf.x || next.y !== g.displaySelf.y) useGameStore.setState({ displaySelf: next });
}
function receiveState(state: ServerState, revision: number, settledThrough: number, reset: boolean) {
  const g = useGameStore.getState();
  if (reset) { pending = []; latestSelf = undefined; ackRevision = -1; lastInputAt = -Infinity; }
  pending = pending.filter(p => p.seq > settledThrough);
  if (!reset && latestSelf && ackRevision > revision) state = { ...state, players: state.players.map(p => p.id === latestSelf!.id ? latestSelf! : p) };
  if (g.map) collision = collisionView(g.map, state);
  for (const field of ['scores', 'match', 'stats', 'roomConfig'] as const) {
    if (JSON.stringify(state[field]) === JSON.stringify(g.state[field])) Object.assign(state, { [field]: g.state[field] });
  }
  const rosterKey = (players: PlayerEntity[]) => players.map(p => `${p.id}:${p.name}:${p.faction}`).join('|');
  const roster = rosterKey(state.players) === rosterKey(g.roster) ? g.roster : state.players;
  useGameStore.setState({ state, roster }); updateDisplay();
}
function beginJoin() {
  if (!queuedJoin || !useGameStore.getState().ready) return;
  const next = queuedJoin; queuedJoin = null;
  if (!send({ type: 'JOIN', ...next })) useGameStore.setState({ joining: false, notice: '连接忙，请稍后再试。' });
}
export const useGameStore = create<GameState>((set, get) => ({
  socket: null, connected: false, ready: false, reconnecting: false, playerReady: false, joinSuccess: 0, selfId: identity?.id ?? null,
  playerName: identity?.name ?? '', selectedFaction: identity?.faction ?? 'red', notice: null, joining: false,
  roster: [], map: null, state: initialState, cameraSettings: { height: 15.5, distance: 6.2, shake: 0 }, snapshotTime: 0, displaySelf: null, renderEpoch: 0, rtt: null, metrics: null,
  adminAuthorized: false, configSaving: false, adminPending: false,
  connect: () => {
    if (get().socket && get().socket!.readyState <= WebSocket.OPEN) return;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = undefined; }
    const socket = new WebSocket(url()); set({ socket });
    let fatal = false, resumed = false;
    socket.addEventListener('open', () => {
      if (get().socket !== socket) return;
      seq = 0; pending = []; currentRevision = -1; ackRevision = -1; latestSelf = undefined; awaitingResync = false;
      bestRtt = Infinity; clockReady = false;
      set({ connected: true, playerReady: false, ready: false, adminAuthorized: false, notice: '正在同步战场…' });
    });
    socket.addEventListener('message', event => {
      if (get().socket !== socket) return;
      let m: ServerMessage; try { m = JSON.parse(event.data); } catch { return; }
      if (m.type === 'HELLO') {
        if (m.protocolVersion !== PROTOCOL_VERSION) { fatal = true; set({ notice: '页面版本已更新，请刷新。' }); socket.close(); return; }
        send({ type: 'SUBSCRIBE', role: spectator() ? 'spectator' : 'player', protocolVersion: PROTOCOL_VERSION });
        if (spectator() && adminPassword) send({ type: 'ADMIN_AUTH', token: adminPassword });
        const ping = () => send({ type: 'PING', clientTime: performance.now() });
        ping(); heartbeat = window.setInterval(ping, 5000); return;
      }
      if ('protocolVersion' in m && m.protocolVersion !== PROTOCOL_VERSION) return;
      if (m.type === 'INIT' || m.type === 'STATE' || m.type === 'DELTA') {
        const reset = m.matchId !== currentMatchId || m.mapVersion !== currentMapVersion;
        if (m.type === 'DELTA' && (reset || m.baseRevision !== currentRevision)) {
          if (!awaitingResync) { send({ type: 'RESYNC' }); awaitingResync = true; set({ ready: false, notice: '正在重新同步…' }); pending = []; updateDisplay(); }
          return;
        }
        if (m.type !== 'INIT' && !reset && m.revision < currentRevision) return;
        currentMatchId = m.matchId; currentMapVersion = m.mapVersion; currentRevision = m.revision; awaitingResync = false;
        if (!clockReady) serverOffset = m.serverTime - Date.now();
        if (m.type === 'INIT') set({ map: m.map, ...(m.selfId ? { selfId: m.selfId } : {}) });
        const state = m.type === 'DELTA' ? applyPatch(get().state, m.patch) : m.state;
        const selfId = get().selfId;
        const settled = m.type === 'INIT' ? (m.inputSeqs?.[selfId ?? ''] ?? m.inputSeq ?? 0) : m.inputSeqs?.[selfId ?? ''] ?? 0;
        receiveState(state, m.revision, settled, reset);
        set({ snapshotTime: m.serverTime });
        set({ ready: true, reconnecting: false, ...(reset ? { renderEpoch: get().renderEpoch + 1 } : {}) }); attempts = 0;
        if (m.type === 'INIT' && m.selfId && m.resumeToken) {
          const p = state.players.find(p => p.id === m.selfId);
          if (p) { saveIdentity(p, m.resumeToken); set({ playerName: p.name, selectedFaction: p.faction, joining: false, playerReady: true, joinSuccess: get().joinSuccess + 1, notice: '已加入战场。' }); }
          queuedJoin = null;
        }
        if (!resumed) {
          resumed = true;
          set({ notice: spectator() ? '战场已同步。' : '请选择队伍加入，已有身份将自动恢复。' });
          const saved = !spectator() ? storedIdentity() : null;
          if (saved && !queuedJoin && !(m.type === 'INIT' && m.selfId)) send({ type: 'RESUME_PLAYER', playerId: saved.id, resumeToken: saved.token });
          else beginJoin();
        }
        return;
      }
      if (m.type === 'INPUT_ACK') {
        if (m.matchId !== currentMatchId || m.mapVersion !== currentMapVersion) return;
        pending = acknowledge(pending, m.ack.inputSeq, m.ack.settledThrough);
        if (m.revision >= Math.max(ackRevision, currentRevision)) {
          latestSelf = m.ack.player; ackRevision = m.revision;
          const state = { ...get().state, players: get().state.players.map(p => p.id === latestSelf!.id ? latestSelf! : p) };
          set({ state }); if (get().map) collision = collisionView(get().map!, state);
        }
        updateDisplay(); return;
      }
      if (m.type === 'PONG') {
        const rtt = performance.now() - m.clientTime;
        if (rtt < bestRtt) { bestRtt = rtt; serverOffset = m.serverTime + rtt / 2 - Date.now(); clockReady = true; }
        set({ rtt: Math.round(rtt) }); return;
      }
      if (m.type === 'ADMIN_AUTH') {
        set({ adminAuthorized: m.authorized, notice: m.authorized ? '管理权限已启用。' : '管理密码错误。' });
        if (!m.authorized) { adminPassword = ''; try { sessionStorage.removeItem(ADMIN_STORAGE_KEY); } catch { /* private mode */ } } return;
      }
      if (m.type === 'ADMIN_RESULT') { set({ notice: m.message, configSaving: false, adminPending: false }); return; }
      if (m.type === 'METRICS') { set({ metrics: m.metrics }); return; }
      if (m.type === 'ERROR') {
        if (m.code === 'PLAYER_NOT_FOUND') { try { localStorage.removeItem(PLAYER_STORAGE_KEY); } catch { /* private mode */ } set({ selfId: null, displaySelf: null }); }
        if (m.code === 'PROTOCOL_MISMATCH') { fatal = true; socket.close(); }
        set({ notice: m.message, joining: false, configSaving: false, adminPending: false });
      }
    });
    socket.addEventListener('close', event => {
      if (get().socket !== socket) return;
      clearInterval(heartbeat); heartbeat = undefined; pending = []; latestSelf = undefined;
      const replaced = event.code === 4001;
      set({ socket: null, connected: false, playerReady: false, ready: false, joining: false, adminAuthorized: false, configSaving: false, adminPending: false, reconnecting: !fatal && !replaced,
        notice: replaced ? '此玩家已在另一页面连接，请关闭本页。' : fatal ? '页面版本已更新，请刷新。' : '连接中断，正在重连…' });
      if (!fatal && !replaced) reconnectTimer = window.setTimeout(() => get().connect(), Math.min(15000, 500 * 2 ** attempts++) * (.8 + Math.random() * .4));
      updateDisplay();
    });
    socket.addEventListener('error', () => { set({ notice: '连接异常，正在恢复…' }); });
  },
  join: (name, faction) => {
    queuedJoin = { name: name.trim(), faction }; set({ joining: true, playerName: name.trim(), selectedFaction: faction, notice: '正在加入队伍…' });
    get().connect(); beginJoin();
  },
  sendMove: move => {
    const g = get(), now = performance.now();
    if (!g.connected || !g.ready || !g.playerReady || !g.selfId || g.state.match.status !== 'running' || now - lastInputAt < MOVE_INTERVAL_MS - 2 || pending.length >= 4) return;
    const delta = typeof move === 'string' ? directionDelta(move) : move;
    const nextSeq = seq + 1;
    if (!send({ type: 'MOVE_PLAYER', matchId: currentMatchId, inputSeq: nextSeq, delta })) return;
    seq = nextSeq; lastInputAt = now; pending.push({ seq, delta, sentAt: now }); updateDisplay();
  },
  authenticateAdmin: token => {
    adminPassword = token; try { sessionStorage.setItem(ADMIN_STORAGE_KEY, token); } catch { /* private mode */ }
    if (!send({ type: 'ADMIN_AUTH', token })) set({ notice: '请等待服务器连接完成。' });
  },
  saveRoomConfig: playerLimit => {
    if (send({ type: 'ADMIN_CONFIG', playerLimit, version: get().state.roomConfig.version })) set({ configSaving: true, notice: '正在保存人数…' });
  },
  adminStart: (durationSeconds, mapConfig) => { if (send({ type: 'ADMIN_START', durationSeconds, mapConfig })) set({ adminPending: true }); },
  adminReset: mapConfig => { if (send({ type: 'ADMIN_RESET', mapConfig })) set({ adminPending: true }); },
  setCameraSettings: settings => set(s => ({ cameraSettings: { ...s.cameraSettings, ...settings } })),
}));
// Small periodic tasks never send historical input. Expired predictions return to authority.
window.setInterval(() => {
  const g = useGameStore.getState(); updateDisplay();
  if (!g.ready) return;
  const now = Date.now() + serverOffset, m = g.state.match;
  const remainingSeconds = m.status === 'ended' ? 0 : m.status === 'running' ? Math.max(0, Math.ceil((m.endsAt - now) / 1000)) : m.durationSeconds;
  const countdownSeconds = m.status === 'countdown' ? Math.max(0, Math.ceil((m.startedAt - now) / 1000)) : 0;
  if (remainingSeconds !== m.remainingSeconds || countdownSeconds !== m.countdownSeconds) useGameStore.setState({ state: { ...g.state, match: { ...m, remainingSeconds, countdownSeconds } } });
}, 100);
export function formatDuration(totalSeconds: number) {
  const value = Math.max(0, Math.ceil(totalSeconds)); return `${Math.floor(value / 60).toString().padStart(2, '0')}:${(value % 60).toString().padStart(2, '0')}`;
}
export function leaderboardRows(scores: ServerState['scores']): LeaderboardRow[] {
  return FACTIONS.map(f => ({ faction: f.id, name: f.name, color: f.color, score: scores[f.id] })).sort((a, b) => b.score - a.score);
}

export const estimatedServerTime = () => Date.now() + serverOffset;
