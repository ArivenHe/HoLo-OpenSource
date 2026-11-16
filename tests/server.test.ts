import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import WebSocket from 'ws';
import { PROTOCOL_VERSION } from '../shared/protocol.js';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
test('live server: auth, configurable capacity, concurrent admission, resume, unbalanced start and input speed', { timeout: 20000 }, async () => {
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { env: { ...process.env, PORT: '0', ADMIN_TOKEN: 'integration-password', MAX_PLAYER_LIMIT: '200', DEFAULT_PLAYER_LIMIT: '50' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', data => { stderr += data; });
  const url = await new Promise<string>((resolve, reject) => {
    child.stdout.on('data', data => { const m = String(data).match(/http:\/\/0\.0\.0\.0:(\d+)/); if (m) resolve(`ws://127.0.0.1:${m[1]}`); });
    child.on('exit', code => reject(new Error(`Server exited ${code}: ${stderr}`)));
  });
  const sockets: WebSocket[] = [];
  async function connect(role = 'player') {
    const ws = new WebSocket(url), messages: any[] = []; sockets.push(ws);
    ws.on('message', raw => { const m = JSON.parse(raw.toString()); messages.push(m); if (m.type === 'HELLO') ws.send(JSON.stringify({ type: 'SUBSCRIBE', protocolVersion: PROTOCOL_VERSION, role })); });
    ws.on('error', () => {});
    async function wait(predicate: (m: any) => boolean, start = 0) {
      const end = Date.now() + 3000;
      while (Date.now() < end) { const found = messages.slice(start).find(predicate); if (found) return found; await delay(10); }
      throw new Error(`Message timeout: ${JSON.stringify(messages.slice(-5))}`);
    }
    await wait(m => m.type === 'INIT');
    return { ws, messages, wait, send: (value: object) => { const at = messages.length; ws.send(JSON.stringify(value)); return at; } };
  }
  try {
    const admin = await connect('spectator');
    let at = admin.send({ type: 'ADMIN_START', durationSeconds: 60 });
    await admin.wait(m => m.code === 'UNAUTHORIZED', at);
    admin.send({ type: 'ADMIN_AUTH', token: 'integration-password' }); await admin.wait(m => m.type === 'ADMIN_AUTH' && m.authorized);
    at = admin.send({ type: 'ADMIN_START', durationSeconds: 60 }); await admin.wait(m => m.type === 'ERROR' && m.message.includes('至少'), at);
    admin.send({ type: 'ADMIN_CONFIG', version: 0, playerLimit: 1 }); await admin.wait(m => m.type === 'ADMIN_RESULT');
    const a = await connect(), b = await connect();
    a.send({ type: 'JOIN', name: 'a', faction: 'red' }); b.send({ type: 'JOIN', name: 'b', faction: 'red' });
    const joined = await a.wait(m => m.type === 'INIT' && m.selfId); await b.wait(m => m.code === 'ROOM_FULL');
    at = b.send({ type: 'RESUME_PLAYER', playerId: joined.selfId, resumeToken: 'wrong' }); await b.wait(m => m.code === 'PLAYER_NOT_FOUND', at);
    at = admin.send({ type: 'ADMIN_CONFIG', version: 1, playerLimit: 0 }); await admin.wait(m => m.type === 'ERROR', at);
    await delay(550);
    at = admin.send({ type: 'ADMIN_CONFIG', version: 1, playerLimit: 2 }); await admin.wait(m => m.type === 'ADMIN_RESULT', at);
    at = b.send({ type: 'JOIN', name: 'b', faction: 'red' }); const joinedB = await b.wait(m => m.type === 'INIT' && m.selfId, at);
    assert.notEqual(`${joined.state.players[0].x}:${joined.state.players[0].y}`, `${joinedB.state.players.find((p: any) => p.id === joinedB.selfId).x}:${joinedB.state.players.find((p: any) => p.id === joinedB.selfId).y}`);
    await delay(550);
    at = admin.send({ type: 'ADMIN_CONFIG', version: 2, playerLimit: 1 }); await admin.wait(m => m.type === 'ERROR' && m.message.includes('在线人数'), at);
    // Same online identity replaces its old connection even when the room is full.
    const replacement = await connect(); replacement.send({ type: 'RESUME_PLAYER', playerId: joined.selfId, resumeToken: joined.resumeToken });
    await replacement.wait(m => m.type === 'INIT' && m.selfId === joined.selfId); await delay(100);
    assert.notEqual(a.ws.readyState, WebSocket.OPEN);
    b.ws.close(); await once(b.ws, 'close'); await delay(100);
    // Fill the released seat, then prove an offline identity cannot bypass capacity.
    const c = await connect(); c.send({ type: 'JOIN', name: 'c', faction: 'red' }); await c.wait(m => m.selfId);
    const offline = await connect(); offline.send({ type: 'RESUME_PLAYER', playerId: joinedB.selfId, resumeToken: joinedB.resumeToken }); await offline.wait(m => m.code === 'ROOM_FULL');
    await delay(550);
    at = admin.send({ type: 'ADMIN_START', durationSeconds: 60, mapConfig: { width: 24, height: 24, boxCount: 500 } });
    await admin.wait(m => m.type === 'ERROR', at);
    await delay(550);
    at = admin.send({ type: 'ADMIN_START', durationSeconds: 60 }); await admin.wait(m => m.type === 'ADMIN_RESULT', at);
    const started = await replacement.wait(m => m.type === 'INIT' && m.state.match.status === 'countdown');
    at = admin.send({ type: 'ADMIN_START', durationSeconds: 60 }); await admin.wait(m => m.type === 'ERROR', at);
    await delay(550);
    at = admin.send({ type: 'ADMIN_CONFIG', version: 2, playerLimit: 3 }); await admin.wait(m => m.type === 'ERROR' && m.message.includes('比赛中'), at);
    await replacement.wait(m => (m.type === 'DELTA' && m.patch.match?.status === 'running') || m.state?.match.status === 'running');
    const initial = replacement.messages.length;
    for (let inputSeq = 1; inputSeq <= 6; inputSeq++) replacement.send({ type: 'MOVE_PLAYER', matchId: started.matchId, inputSeq, delta: { x: 1, y: 0 } });
    await delay(450);
    const acks = replacement.messages.slice(initial).filter(m => m.type === 'INPUT_ACK');
    assert.equal(acks.length, 6); assert.ok(acks.filter(m => m.ack.result === 'moved').length <= 3); assert.ok(acks.some(m => m.ack.result === 'overloaded'));
    assert.equal(Math.max(...acks.map(m => m.ack.settledThrough)), 6);
    const times = acks.filter(m => m.ack.result === 'moved').map(m => m.ack.processedAt);
    for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 110);
    const beforeResync = replacement.messages.length; replacement.send({ type: 'RESYNC' });
    await replacement.wait(m => m.type === 'STATE', beforeResync);
    replacement.ws.send('null'); replacement.ws.send('{'); await delay(100);
    const health = await fetch(url.replace('ws:', 'http:') + '/health'); assert.equal(health.status, 200);
    assert.equal((await health.json() as any).onlinePlayers, 2);
  } finally {
    sockets.forEach(ws => ws.terminate()); child.kill('SIGTERM'); await once(child, 'exit');
  }
});
