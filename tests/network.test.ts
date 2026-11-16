import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';

test('delay proxy preserves HTTP upgrade and WebSocket message ordering under jitter', { timeout: 10000 }, async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  server.on('connection', socket => {
    socket.send(JSON.stringify({ seq: 0 }));
    for (let seq = 1; seq < 20; seq++) setTimeout(() => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ seq })); }, seq * 2);
  });
  const proxy = spawn(process.execPath, ['--import', 'tsx', 'scripts/network-proxy.ts', '--port', '0', '--target-port', String(port), '--rtt-ms', '80', '--jitter-ms', '60'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let client: WebSocket | undefined;
  try {
    const proxyPort = await new Promise<number>((resolve, reject) => {
      proxy.stdout.on('data', data => { const m = String(data).match(/Local proxy :(\d+)/); if (m) resolve(Number(m[1])); });
      proxy.on('error', reject); proxy.on('exit', () => reject(new Error('Proxy exited')));
    });
    client = new WebSocket(`ws://127.0.0.1:${proxyPort}`);
    const received = await new Promise<number[]>((resolve, reject) => {
      const items: number[] = [];
      client!.on('message', raw => { items.push(JSON.parse(raw.toString()).seq); if (items.length === 20) resolve(items); });
      client!.on('error', reject);
    });
    assert.deepEqual(received, Array.from({ length: 20 }, (_, i) => i));
  } finally {
    client?.terminate(); const exited = once(proxy, 'exit'); proxy.kill('SIGTERM'); await exited;
    server.clients.forEach(socket => socket.terminate()); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
