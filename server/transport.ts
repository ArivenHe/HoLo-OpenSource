import type { WebSocket } from 'ws';

export class TokenBucket {
  private tokens: number;
  private updated = performance.now();
  constructor(private rate: number, private burst: number) { this.tokens = burst; }
  take(now = performance.now()) {
    this.tokens = Math.min(this.burst, this.tokens + (now - this.updated) * this.rate / 1000); this.updated = now;
    if (this.tokens < 1) return false;
    this.tokens--; return true;
  }
}

// Dropped deltas must always be followed by a full snapshot, never another delta.
export function needsSnapshot(client: { needsSnapshot: boolean; revision: number; mapVersion: number }, baseRevision: number, mapVersion: number) {
  return client.needsSnapshot || client.revision !== baseRevision || client.mapVersion !== mapVersion;
}
export function writable(socket: Pick<WebSocket, 'bufferedAmount' | 'readyState'>, client: { needsSnapshot: boolean; slowSince: number }, limit: number, now: number) {
  if (socket.readyState !== 1) return false;
  if (socket.bufferedAmount > limit) {
    client.needsSnapshot = true;
    if (!client.slowSince) client.slowSince = now;
    return false;
  }
  client.slowSince = 0; return true;
}
