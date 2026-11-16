import assert from 'node:assert/strict';
import test from 'node:test';
import { World } from '../server/world.js';
import { keyOf, type FactionId } from '../shared/protocol.js';

function fixture() {
  const w = new World({ width: 24, height: 24, boxCount: 40 });
  w.walls.clear(); w.boxes.clear(); w.boxByCell.clear(); w.changedBoxes.clear();
  const p = w.join('player', 'red'); w.playerByCell.clear(); p.x = 10; p.y = 10; w.playerByCell.set(keyOf(p), p.id);
  return { w, p };
}
function box(w: World, id: string, x: number, y: number, faction: FactionId = 'blue') {
  w.putBox({ id, x, y, faction, color: '#fff', lastMovedAt: 0 });
}
test('200 same-team players have distinct spawns and reset without overlaps', () => {
  const w = new World({ width: 64, height: 64, boxCount: 220 });
  for (let i = 0; i < 200; i++) w.join(`p${i}`, 'red');
  w.assertConsistent();
  const replacement = new World(w.config, w.players.values(), 200); replacement.assertConsistent();
});
test('candidate generation fails without modifying the existing world', () => {
  const { w, p } = fixture(); const before = { ...p };
  assert.throws(() => new World({ width: 24, height: 24, boxCount: 500 }, w.players.values(), 50));
  assert.deepEqual(w.players.get(p.id), before); w.assertConsistent();
});
test('ordinary movement, diagonal, wall and player collision', () => {
  const { w, p } = fixture(); assert.equal(w.move(p.id, { x: 1, y: 1 }), true);
  w.walls.add('12:11'); assert.equal(w.move(p.id, { x: 1, y: 0 }), false);
  const other = w.join('other', 'blue'); w.playerByCell.delete(keyOf(other)); other.x = 11; other.y = 12; w.playerByCell.set(keyOf(other), other.id);
  assert.equal(w.move(p.id, { x: 0, y: 1 }), false); w.assertConsistent();
});
test('chain push is atomic when blocked, then succeeds; pulling uses the vacated cell', () => {
  const { w, p } = fixture(); box(w, 'a', 11, 10); box(w, 'b', 12, 10); w.walls.add('13:10');
  assert.equal(w.move(p.id, { x: 1, y: 0 }), false); assert.equal(w.boxes.get('a')!.x, 11);
  w.walls.delete('13:10'); assert.equal(w.move(p.id, { x: 1, y: 0 }), true);
  assert.equal(w.boxes.get('b')!.x, 13); assert.equal(w.boxes.get('a')!.x, 12);
  assert.equal(w.move(p.id, { x: -1, y: 0 }), true); assert.equal(w.boxes.get('a')!.x, 11); w.assertConsistent();
});
test('correct base scores exactly once and respawn avoids the player; wrong base does not score', () => {
  const { w, p } = fixture(); w.baseByCell.clear(); w.baseByCell.set('12:10', 'red'); box(w, 'a', 11, 10, 'red');
  assert.equal(w.move(p.id, { x: 1, y: 0 }), true); assert.equal(w.scores.red, 1); w.assertConsistent();
  const { w: wrong, p: q } = fixture(); wrong.baseByCell.clear(); wrong.baseByCell.set('12:10', 'red'); box(wrong, 'b', 11, 10, 'blue');
  wrong.move(q.id, { x: 1, y: 0 }); assert.equal(wrong.scores.blue, 0); assert.equal(wrong.boxes.get('b')!.x, 12);
});
test('dead corner respawn and resume both maintain occupancy', () => {
  const { w, p } = fixture(); w.baseByCell.clear(); box(w, 'a', 15, 15); w.walls.add('14:15'); w.walls.add('15:14');
  w.respawnStuck(61000); assert.notEqual(keyOf(w.boxes.get('a')!), '15:15');
  w.disconnect(p.id); const other = w.join('other', 'red'); w.playerByCell.delete(keyOf(other)); other.x = p.x; other.y = p.y; w.playerByCell.set(keyOf(other), other.id);
  w.resume(p.id); assert.notEqual(keyOf(p), keyOf(other)); w.assertConsistent();
});
test('random interactions never duplicate cells or stale indexes', () => {
  const w = new World({ width: 32, height: 32, boxCount: 180 });
  const players = Array.from({ length: 40 }, (_, i) => w.join(`p${i}`, 'red'));
  let seed = 42; const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed; };
  for (let i = 0; i < 10000; i++) {
    const p = players[random() % players.length]; let x = random() % 3 - 1, y = random() % 3 - 1;
    if (!x && !y) x = 1;
    w.move(p.id, { x, y }); if (i % 100 === 0) w.assertConsistent();
  }
  w.assertConsistent();
});
