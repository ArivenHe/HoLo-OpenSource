import assert from 'node:assert/strict';
import test from 'node:test';
import { acknowledge, mergeEntities, predictSelf, type CollisionView } from '../client/src/store/sync.js';
import { needsSnapshot, TokenBucket, writable } from '../server/transport.js';
import { validDelta, type PlayerEntity } from '../shared/protocol.js';

test('delta removes disconnected entities and preserves untouched identities', () => {
  const a = { id: 'a', x: 1 }, b = { id: 'b', x: 2 };
  const next = mergeEntities([a, b], { upsert: [{ id: 'c', x: 3 }], remove: ['b'] });
  assert.deepEqual(next.map(x => x.id), ['a', 'c']); assert.equal(next[0], a);
  assert.equal(mergeEntities(next, { upsert: [], remove: [] }), next);
  const sparse = mergeEntities([{ id: 'p', name: 'original', x: 1, y: 2 }], { upsert: [{ id: 'p', x: 9 }], remove: [] });
  assert.deepEqual(sparse, [{ id: 'p', name: 'original', x: 9, y: 2 }]);
});
test('out-of-order rejected input does not erase earlier unconfirmed input', () => {
  const pending = [1, 2, 3].map(seq => ({ seq, delta: { x: 1, y: 0 }, sentAt: 10 }));
  assert.deepEqual(acknowledge(pending, 3, 0).map(x => x.seq), [1, 2]);
  assert.deepEqual(acknowledge(pending, 2, 2).map(x => x.seq), [3]);
});
test('prediction is bounded, expires, and avoids push, pull, player and wall interactions', () => {
  const p: PlayerEntity = { id: 'p', name: 'p', x: 5, y: 5, faction: 'red', color: '#fff', assigned: true, connected: true };
  const view: CollisionView = { width: 24, height: 24, walls: new Set(), boxes: new Set(), players: new Map() };
  const pending = [1, 2, 3].map(seq => ({ seq, delta: { x: 1, y: 0 }, sentAt: 10 }));
  assert.deepEqual(predictSelf(p, pending, view, 20), { x: 7, y: 5 });
  assert.deepEqual(predictSelf(p, pending, view, 300), { x: 5, y: 5 });
  for (const obstacle of ['6:5', '4:5']) { view.boxes.add(obstacle); assert.deepEqual(predictSelf(p, pending, view, 20), { x: 5, y: 5 }); view.boxes.clear(); }
  view.walls.add('6:5'); assert.deepEqual(predictSelf(p, pending, view, 20), { x: 5, y: 5 }); view.walls.clear();
  view.players.set('6:5', 'q'); assert.deepEqual(predictSelf(p, pending, view, 20), { x: 5, y: 5 });
});
test('backpressure and revision/map gaps force a snapshot before more deltas', () => {
  const c = { revision: 2, mapVersion: 1, needsSnapshot: false, slowSince: 0 };
  assert.equal(needsSnapshot(c, 2, 1), false);
  assert.equal(writable({ readyState: 1, bufferedAmount: 5000 }, c, 1024, 100), false);
  assert.equal(c.slowSince, 100); assert.equal(c.needsSnapshot, true);
  assert.equal(writable({ readyState: 1, bufferedAmount: 0 }, c, 1024, 101), true);
  assert.equal(needsSnapshot(c, 2, 1), true);
  c.needsSnapshot = false;
  assert.equal(needsSnapshot(c, 3, 1), true); assert.equal(needsSnapshot(c, 2, 2), true);
});
test('bucket limits bursts; malformed movement cannot enter simulation', () => {
  const bucket = new TokenBucket(1, 2); assert.equal(bucket.take(), true); assert.equal(bucket.take(), true); assert.equal(bucket.take(), false);
  for (const input of [null, {}, { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 1.2, y: 0 }, { x: '1', y: 0 }]) assert.equal(validDelta(input), false);
  assert.equal(validDelta({ x: -1, y: 1 }), true);
});
