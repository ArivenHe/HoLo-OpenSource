// Local TCP delay proxy. Preserves byte order; it does not simulate packet loss or a bandwidth limit.
import net from 'node:net';
const args = process.argv.slice(2);
const option = (name: string, fallback: string) => { const i = args.indexOf(`--${name}`); return i < 0 ? fallback : args[i + 1]; };
const listenPort = Number(option('port', '17774')), targetPort = Number(option('target-port', '17772'));
const rtt = Number(option('rtt-ms', '100')), jitter = Number(option('jitter-ms', '20'));
if (![listenPort, targetPort, rtt, jitter].every(Number.isFinite) || rtt < 0 || jitter < 0) throw new Error('Invalid proxy arguments');
const active = new Set<net.Socket>();
function relay(from: net.Socket, to: net.Socket) {
  let lastDue = 0;
  const queue: Array<{ due: number; data: Buffer }> = [];
  let timer: NodeJS.Timeout | undefined, queuedBytes = 0, blocked = false;
  function pump() {
    timer = undefined;
    if (to.destroyed || blocked || !queue.length) return;
    const now = performance.now();
    while (queue.length && queue[0].due <= now) {
      const next = queue.shift()!; queuedBytes -= next.data.length;
      if (!to.write(next.data)) { from.pause(); blocked = true; return; }
    }
    if (queue.length) timer = setTimeout(pump, Math.max(1, Math.ceil(queue[0].due - performance.now())));
  }
  from.on('data', data => {
    const due = Math.max(lastDue, performance.now() + Math.max(0, rtt / 2 + (Math.random() - .5) * jitter)); lastDue = due;
    queue.push({ due, data }); queuedBytes += data.length;
    if (queuedBytes > 8 * 1024 * 1024) { from.destroy(); to.destroy(); return; }
    if (!timer && !blocked) pump();
  });
  to.on('drain', () => { blocked = false; from.resume(); if (!timer) pump(); });
  from.on('close', () => { clearTimeout(timer); queue.length = 0; to.destroy(); active.delete(from); });
  from.on('error', () => to.destroy());
}
const server = net.createServer(client => {
  const upstream = net.connect(targetPort, '127.0.0.1'); active.add(client); active.add(upstream);
  relay(client, upstream); relay(upstream, client);
});
server.listen(listenPort, '127.0.0.1', () => console.log(`Local proxy :${(server.address() as net.AddressInfo).port} -> :${targetPort}; added RTT ~${rtt}ms, per-direction jitter ±${jitter / 2}ms`));
function stop() { active.forEach(s => s.destroy()); server.close(); }
process.once('SIGINT', stop); process.once('SIGTERM', stop);
