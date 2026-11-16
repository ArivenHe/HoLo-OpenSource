import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => { const i = args.indexOf(`--${name}`); return i < 0 ? fallback : args[i + 1]; };
const seconds = Number(option('seconds', '20'));
const directory = option('output-dir', 'docs/performance');
const baseline = option('baseline', '');
const token = randomBytes(24).toString('hex');
const active = new Set<ChildProcess>();
async function service(file: string, env: NodeJS.ProcessEnv, params: string[] = [], match = /http:\/\/0\.0\.0\.0:(\d+)/) {
  const child = spawn(process.execPath, ['--import', 'tsx', file, ...params], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }); active.add(child);
  let stderr = '';
  child.stderr!.on('data', data => { stderr += data; });
  const port = await new Promise<number>((resolve, reject) => {
    child.stdout!.on('data', data => { const found = String(data).match(match); if (found) resolve(Number(found[1])); });
    child.on('exit', code => reject(new Error(`Service exited ${code}: ${stderr}`)));
  });
  return { child, port };
}
async function stop(child: ChildProcess) { if (child.exitCode !== null) return; const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; active.delete(child); }
async function run(port: number, players: number, observers: number, filename: string, extra: string[] = []) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/loadtest.ts', '--url', `ws://127.0.0.1:${port}`, '--players', String(players), '--spectators', String(observers), '--seconds', String(seconds), '--output', `${directory}/${filename}.json`, ...extra], { env: { ...process.env, ADMIN_TOKEN: token }, stdio: 'inherit' }); active.add(child);
  const [code] = await once(child, 'exit'); active.delete(child); if (code !== 0) throw new Error(`Load test failed: ${filename}`);
}
try {
  await mkdir(directory, { recursive: true });
  if (baseline) { const s = await service(baseline, { PORT: option('baseline-port', '17771') }); await run(s.port, 50, 5, 'before-50', ['--legacy']); await stop(s.child); }
  for (const count of (args.includes('--only-weak') ? [] : [50, 100, 200])) {
    const s = await service('dist/server/index.js', { PORT: '0', ADMIN_TOKEN: token, MAX_PLAYER_LIMIT: '200', DEFAULT_PLAYER_LIMIT: String(count), MAX_CONNECTIONS: '300' });
    await run(s.port, count, count === 50 ? 5 : 20, `after-${count}`); await stop(s.child);
  }
  if (args.includes('--weak-network')) {
    const s = await service('dist/server/index.js', { PORT: '0', ADMIN_TOKEN: token, MAX_PLAYER_LIMIT: '200', DEFAULT_PLAYER_LIMIT: '50', MAX_CONNECTIONS: '300' });
    const proxy = await service('scripts/network-proxy.ts', {}, ['--port', '0', '--target-port', String(s.port), '--rtt-ms', '100', '--jitter-ms', '20'], /Local proxy :(\d+)/);
    await run(proxy.port, 50, 5, 'weak-50', ['--network-notes', 'local TCP proxy adds ~100ms RTT and +/-10ms per-direction jitter; no packet loss simulation']);
    await stop(proxy.child); await stop(s.child);
  }
} finally { for (const child of active) child.kill('SIGTERM'); }
