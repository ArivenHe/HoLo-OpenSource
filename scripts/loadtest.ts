import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import WebSocket from 'ws';
import { FACTIONS, PROTOCOL_VERSION } from '../shared/protocol.js';
const args = process.argv.slice(2);
const option = (name: string, fallback: string) => { const i = args.indexOf(`--${name}`); return i < 0 ? fallback : args[i + 1]; };
const url = option('url', 'ws://127.0.0.1:3001');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname) && !args.includes('--allow-remote')) throw new Error('Remote load tests require --allow-remote.');
const count = Number(option('players', '50')), spectators = Number(option('spectators', '5')), seconds = Number(option('seconds', '30'));
if (!Number.isInteger(count) || count < 1 || count > 2000 || !Number.isInteger(spectators) || spectators < 0 || spectators > 5000 || !Number.isInteger(seconds) || seconds < 1 || seconds > 5380) throw new Error('Invalid player/spectator count or duration');
const legacy = args.includes('--legacy'), password = process.env.ADMIN_TOKEN ?? '';
const output = option('output', '/private/tmp/holo-loadtest.json');
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let bytes = 0, messages = 0, acks = 0, moved = 0, blocked = 0, errors = 0, disconnects = 0, sent = 0, loadActive = false, seed = 42;
const latency: number[] = [], metrics: any[] = [], all: any[] = [];
const directions = [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 0, y: -1 }, { x: 1, y: 1 }, { x: -1, y: 1 }, { x: 1, y: -1 }, { x: -1, y: -1 }];
const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed; };
async function connect(index: number, player: boolean, admin = false) {
  const socket = new WebSocket(url), client = { socket, id: '', matchId: '', seq: 0, pending: new Map<number, number>(), state: null as any, map: null as any, authorized: false, direction: index % 4, received: 0 };
  all.push(client);
  return new Promise<typeof client>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Connection ${index} timed out`)), 15000);
    let joined = false, done = false;
    socket.on('error', reject);
    socket.on('close', () => { if (!done) reject(new Error('Connection closed before joining')); else if (loadActive) disconnects++; });
    socket.on('message', raw => {
      bytes += raw.byteLength; messages++; client.received++;
      const m = JSON.parse(raw.toString());
      if (m.type === 'HELLO') socket.send(JSON.stringify({ type: 'SUBSCRIBE', protocolVersion: PROTOCOL_VERSION, role: player ? 'player' : 'spectator' }));
      if (m.type === 'INIT') client.map = m.map;
      if (m.type === 'INIT' || m.type === 'STATE') { client.state = m.state; client.matchId = m.matchId ?? ''; }
      if (m.type === 'DELTA') {
        for (const name of ['players', 'boxes']) {
          const entities = new Map(client.state[name].map((e: any) => [e.id, e]));
          m.patch[name].remove.forEach((id: string) => entities.delete(id)); m.patch[name].upsert.forEach((e: any) => entities.set(e.id, { ...entities.get(e.id) as object, ...e })); client.state[name] = [...entities.values()];
        }
        for (const key of ['match', 'stats', 'scores', 'roomConfig']) if (m.patch[key]) client.state[key] = m.patch[key]; client.matchId = m.matchId;
      }
      if (m.type === 'INIT' && !joined) {
        joined = true;
        if (player) socket.send(JSON.stringify({ type: 'JOIN', name: `load-${index}`, faction: FACTIONS[index % 4].id }));
        else if (admin && !legacy) socket.send(JSON.stringify({ type: 'ADMIN_AUTH', token: password }));
        else { clearTimeout(timeout); done = true; resolve(client); }
      }
      if (m.type === 'INIT' && m.selfId) { client.id = m.selfId; clearTimeout(timeout); done = true; resolve(client); }
      if (m.type === 'ADMIN_AUTH') { if (!m.authorized) reject(new Error('ADMIN_TOKEN required')); client.authorized = m.authorized; clearTimeout(timeout); done = true; resolve(client); }
      if (m.type === 'METRICS') metrics.push(m.metrics);
      if (m.type === 'INPUT_ACK') {
        acks++; const sent = client.pending.get(m.ack.inputSeq); if (sent !== undefined) latency.push(performance.now() - sent); client.pending.delete(m.ack.inputSeq);
        if (m.ack.result === 'moved') moved++; if (m.ack.result === 'blocked') { blocked++; }
      }
      if (m.type === 'ERROR') { errors++; if (!done) { clearTimeout(timeout); reject(new Error(m.message)); } }
    });
  });
}
function quantile(a: number[], p: number) { const sorted = [...a].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? null; }
try {
  const started = performance.now(), admin = await connect(-1, false, true);
  if (!legacy && admin.state.match.status !== 'waiting') {
    admin.socket.send(JSON.stringify({ type: 'ADMIN_RESET' }));
    const until = Date.now() + 5000;
    while (Date.now() < until && admin.state.match.status !== 'waiting') await delay(50);
    if (admin.state.match.status !== 'waiting') throw new Error('Could not reset test match');
  }
  if (!legacy && admin.state.roomConfig.playerLimit !== count) {
    admin.socket.send(JSON.stringify({ type: 'ADMIN_CONFIG', playerLimit: count, version: admin.state.roomConfig.version }));
    const until = Date.now() + 5000;
    while (Date.now() < until && admin.state.roomConfig.playerLimit !== count) await delay(50);
    if (admin.state.roomConfig.playerLimit !== count) throw new Error('Could not configure capacity');
  }
  const players: Awaited<ReturnType<typeof connect>>[] = [];
  for (let i = 0; i < count; i += 10) { players.push(...await Promise.all(Array.from({ length: Math.min(10, count - i) }, (_, n) => connect(i + n, true)))); await delay(100); }
  for (let i = 0; i < spectators; i++) await connect(count + i, false);
  const joinMs = performance.now() - started, joinBytes = bytes;
  admin.socket.send(JSON.stringify({ type: 'ADMIN_START', durationSeconds: Math.max(60, seconds + 10) }));
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && players.some(p => p.state?.match.status !== 'running')) await delay(50);
  if (players.some(p => p.state?.match.status !== 'running')) throw new Error('Match did not start');
  const startBytes = bytes, startMessages = messages; loadActive = true;
  const timer = setInterval(() => {
    for (const p of players) {
      // Choose legal destinations from the received state so bots actively move instead of repeatedly hitting walls.
      const self = p.state.players.find((e: any) => e.id === p.id);
      if (!self) continue;
      const key = (e: any) => `${e.x}:${e.y}`;
      const walls = new Set(p.map.walls.map(([x, y]: number[]) => `${x}:${y}`));
      const occupiedPlayers = new Set(p.state.players.filter((e: any) => e.id !== p.id).map(key));
      const boxes = new Set(p.state.boxes.map(key));
      const legal = directions.filter(d => {
        let next = { x: self.x + d.x, y: self.y + d.y };
        while (boxes.has(key(next))) next = { x: next.x + d.x, y: next.y + d.y };
        return next.x >= 0 && next.y >= 0 && next.x < p.map.width && next.y < p.map.height && !walls.has(key(next)) && !occupiedPlayers.has(key(next));
      });
      sent++;
      const delta = legal.length ? legal[random() % legal.length] : directions[random() % directions.length];
      if (legacy) p.socket.send(JSON.stringify({ type: 'MOVE_PLAYER', delta }));
      else { const inputSeq = ++p.seq; p.pending.set(inputSeq, performance.now()); p.socket.send(JSON.stringify({ type: 'MOVE_PLAYER', delta, matchId: p.matchId, inputSeq })); }
    }
  }, 120);
  await delay(seconds * 1000); clearInterval(timer); await delay(350); loadActive = false;
  const report = { date: new Date().toISOString(), legacy, environment: { platform: os.platform(), arch: os.arch(), cpu: os.cpus()[0]?.model, cpuCount: os.cpus().length, memoryGB: os.totalmem() / 2 ** 30, node: process.version, topology: option('network-notes', 'load generator and server on same local host; no network impairment') },
    players: count, spectators: spectators + 1, seconds, joinMs, joinBytes, outboundBytes: bytes - startBytes, outboundMbps: (bytes - startBytes) * 8 / seconds / 1e6, messages: messages - startMessages,
    sent, acks, moved, blocked, errors, disconnects, ackP50Ms: quantile(latency, .5), ackP95Ms: quantile(latency, .95), ackP99Ms: quantile(latency, .99),
    server: { samples: metrics.length, eventLoopP95Ms: quantile(metrics.map(m => m.eventLoopP95Ms), .95), cpuP95PercentOfOneCore: quantile(metrics.map(m => m.cpuPercent), .95), rssMaxMB: metrics.length ? Math.max(...metrics.map(m => m.rssMB)) : null }, metrics };
  await writeFile(output, JSON.stringify(report, null, 2));
  if (disconnects || errors || (!legacy && sent !== acks)) throw new Error(`Load validation failed: ${sent} sent, ${acks} ACKs, ${disconnects} disconnects, ${errors} errors`);
  console.log(JSON.stringify({ ...report, metrics: undefined }, null, 2));
} finally { all.forEach(c => c.socket.terminate()); }
