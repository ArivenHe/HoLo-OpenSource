import { randomUUID } from 'node:crypto';
import { FACTIONS, keyOf, type BoxEntity, type FactionId, type PlayerEntity, type StaticMap, type Vec2, type WorldConfig } from '../shared/protocol.js';

interface LiveBox extends BoxEntity { lastMovedAt: number }
const randomInt = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1));

export class World {
  players = new Map<string, PlayerEntity>();
  boxes = new Map<string, LiveBox>();
  playerByCell = new Map<string, string>();
  boxByCell = new Map<string, string>();
  baseByCell = new Map<string, FactionId>();
  walls = new Set<string>();
  scores: Record<FactionId, number> = { red: 0, blue: 0, green: 0, yellow: 0 };
  changedPlayers = new Set<string>();
  removedPlayers = new Set<string>();
  changedBoxes = new Set<string>();
  map: StaticMap;
  constructor(public config: WorldConfig, players: Iterable<PlayerEntity> = [], requiredCapacity = 0) {
    const { width, height } = config;
    this.map = { width, height, walls: [], bases: FACTIONS.map((f, i) => ({
      ...f, cells: Array.from({ length: 36 }, (_, n) => ({
        x: (i % 2 ? width - 8 : 2) + n % 6, y: (i >= 2 ? height - 8 : 2) + Math.floor(n / 6),
      })),
    })) };
    this.map.bases.forEach(b => b.cells.forEach(p => this.baseByCell.set(keyOf(p), b.id)));
    for (let x = 0; x < width; x++) { this.walls.add(`${x}:0`); this.walls.add(`${x}:${height - 1}`); }
    for (let y = 0; y < height; y++) { this.walls.add(`0:${y}`); this.walls.add(`${width - 1}:${y}`); }
    for (let i = 0; i < Math.max(16, Math.round(width * height / 57)); i++) {
      const x = randomInt(8, width - 9), y = randomInt(8, height - 9), horizontal = Math.random() > .5;
      const length = randomInt(2, 5);
      for (let n = 0; n < length; n++) {
        const p = { x: x + (horizontal ? n : 0), y: y + (horizontal ? 0 : n) };
        if (!this.baseByCell.has(keyOf(p)) && !this.isWall(p)) this.walls.add(keyOf(p));
      }
    }
    this.map.walls = [...this.walls].map(k => k.split(':').map(Number) as [number, number]);
    const existing = [...players];
    // Reserve legal, distinct player cells before boxes. Candidate construction never mutates the old world.
    for (const old of existing) {
      const p = { ...old };
      if (p.connected) Object.assign(p, this.spawnForFaction(p.faction));
      this.players.set(p.id, p);
      if (p.connected) this.playerByCell.set(keyOf(p), p.id);
    }
    const free = this.openCells(true);
    if (free.length < config.boxCount) throw new Error('地图空位不足以放置箱子，请扩大地图或减少箱子。');
    for (let i = free.length - 1; i > 0; i--) {
      const j = randomInt(0, i); [free[i], free[j]] = [free[j], free[i]];
    }
    for (let i = 0; i < config.boxCount; i++) {
      const f = FACTIONS[i % 4];
      this.putBox({ id: `box-${i}`, faction: f.id, color: f.color, ...free[i], lastMovedAt: Date.now() });
    }
    if (this.capacity() < requiredCapacity) throw new Error('地图可用格子少于人数上限，请扩大地图、减少箱子或下调人数。');
  }
  isWall(p: Vec2) { return p.x < 0 || p.y < 0 || p.x >= this.config.width || p.y >= this.config.height || this.walls.has(keyOf(p)); }
  occupied(p: Vec2, ignoredId?: string) {
    const player = this.playerByCell.get(keyOf(p));
    return this.isWall(p) || this.boxByCell.has(keyOf(p)) || Boolean(player && player !== ignoredId);
  }
  boxAt(p: Vec2) { const id = this.boxByCell.get(keyOf(p)); return id ? this.boxes.get(id) : undefined; }
  openCells(avoidBases = false) {
    const result: Vec2[] = [];
    for (let y = 1; y < this.config.height - 1; y++) for (let x = 1; x < this.config.width - 1; x++) {
      const p = { x, y };
      if (!this.occupied(p) && (!avoidBases || !this.baseByCell.has(keyOf(p)))) result.push(p);
    }
    return result;
  }
  capacity() { return this.config.width * this.config.height - this.walls.size - this.boxes.size; }
  spawnForFaction(faction: FactionId, ignoredId?: string): Vec2 {
    const cells = this.map.bases.find(b => b.id === faction)!.cells;
    const center = cells[21];
    for (const p of cells) if (!this.occupied(p, ignoredId)) return { ...p };
    // Expanding rings avoid sorting or scanning all entities for every spawn.
    for (let r = 1; r < Math.max(this.config.width, this.config.height); r++) {
      for (let dx = -r; dx <= r; dx++) for (const dy of [-r, r]) {
        const p = { x: center.x + dx, y: center.y + dy }; if (!this.occupied(p, ignoredId)) return p;
      }
      for (let dy = -r + 1; dy < r; dy++) for (const dx of [-r, r]) {
        const p = { x: center.x + dx, y: center.y + dy }; if (!this.occupied(p, ignoredId)) return p;
      }
    }
    throw new Error('没有可用出生位置，请稍后重试。');
  }
  join(name: string, faction: FactionId) {
    const f = FACTIONS.find(f => f.id === faction)!;
    const p: PlayerEntity = { id: randomUUID(), name, faction, color: f.color, connected: true, assigned: true, ...this.spawnForFaction(faction) };
    this.players.set(p.id, p); this.playerByCell.set(keyOf(p), p.id); this.touchPlayer(p.id); return p;
  }
  changeTeam(id: string, name: string, faction: FactionId) {
    const p = this.players.get(id)!;
    const position = this.spawnForFaction(faction, id);
    this.playerByCell.delete(keyOf(p));
    Object.assign(p, position, { name, faction, color: FACTIONS.find(f => f.id === faction)!.color });
    this.playerByCell.set(keyOf(p), id); this.touchPlayer(id); return p;
  }
  resume(id: string) {
    const p = this.players.get(id)!;
    if (!p.connected) {
      if (this.occupied(p)) Object.assign(p, this.spawnForFaction(p.faction));
      p.connected = true; this.playerByCell.set(keyOf(p), id); this.touchPlayer(id);
    }
    return p;
  }
  disconnect(id: string) {
    const p = this.players.get(id); if (!p) return;
    this.playerByCell.delete(keyOf(p)); p.connected = false;
    this.changedPlayers.delete(id); this.removedPlayers.add(id);
  }
  touchPlayer(id: string) { this.changedPlayers.add(id); this.removedPlayers.delete(id); }
  putBox(box: LiveBox) {
    this.boxes.set(box.id, box); this.boxByCell.set(keyOf(box), box.id); this.changedBoxes.add(box.id);
  }
  relocateBox(box: LiveBox, p: Vec2, now: number) {
    this.boxByCell.delete(keyOf(box)); Object.assign(box, p, { lastMovedAt: now }); this.putBox(box);
  }
  scoreBox(box: LiveBox, now: number) {
    if (this.baseByCell.get(keyOf(box)) !== box.faction) return;
    // A dense map may have no non-base respawn cell. Keep the box until a legal cell becomes available.
    const free = this.findRespawn(); if (!free) return;
    this.scores[box.faction]++; this.relocateBox(box, free, now);
  }
  findRespawn() {
    const count = this.config.width * this.config.height, start = randomInt(0, count - 1);
    for (let i = 0; i < count; i++) {
      const n = (start + i) % count, p = { x: n % this.config.width, y: Math.floor(n / this.config.width) };
      if (!this.occupied(p) && !this.baseByCell.has(keyOf(p))) return p;
    }
    return null;
  }
  move(id: string, delta: Vec2, now = Date.now()) {
    const p = this.players.get(id); if (!p?.connected) return false;
    const old = { x: p.x, y: p.y }, next = { x: p.x + delta.x, y: p.y + delta.y };
    const other = this.playerByCell.get(keyOf(next));
    if (this.isWall(next) || (other && other !== id)) return false;
    const chain: LiveBox[] = [];
    let cursor = next;
    while (true) {
      const box = this.boxAt(cursor); if (!box) break;
      chain.push(box); cursor = { x: cursor.x + delta.x, y: cursor.y + delta.y };
    }
    if (chain.length && this.occupied(cursor, id)) return false;
    // Reserve the player's destination before respawning any scored boxes.
    this.playerByCell.delete(keyOf(p)); Object.assign(p, next); this.playerByCell.set(keyOf(p), id); this.touchPlayer(id);
    for (let i = chain.length - 1; i >= 0; i--) {
      const b = chain[i]; this.relocateBox(b, { x: b.x + delta.x, y: b.y + delta.y }, now);
    }
    if (!chain.length) {
      const behind = this.boxAt({ x: old.x - delta.x, y: old.y - delta.y });
      if (behind) { this.relocateBox(behind, old, now); chain.push(behind); }
    }
    chain.forEach(b => this.scoreBox(b, now));
    return true;
  }
  respawnStuck(now = Date.now()) {
    let changed = false;
    for (const box of this.boxes.values()) {
      if (now - box.lastMovedAt <= 60_000 || this.baseByCell.has(keyOf(box))) continue;
      const blocked = (x: number, y: number) => this.isWall({ x, y });
      if ((blocked(box.x - 1, box.y) || blocked(box.x + 1, box.y)) && (blocked(box.x, box.y - 1) || blocked(box.x, box.y + 1))) {
        const free = this.findRespawn(); if (free) { this.relocateBox(box, free, now); changed = true; }
      }
    }
    return changed;
  }
  snapshotBoxes(): BoxEntity[] { return [...this.boxes.values()].map(({ lastMovedAt: _, ...box }) => box); }
  online() { return [...this.players.values()].filter(p => p.connected); }
  clearChanges() { this.changedPlayers.clear(); this.removedPlayers.clear(); this.changedBoxes.clear(); }
  assertConsistent() {
    const occupied = new Set<string>();
    for (const p of this.players.values()) if (p.connected) {
      const k = keyOf(p);
      if (this.isWall(p) || occupied.has(k) || this.playerByCell.get(k) !== p.id) throw new Error('Invalid player index'); occupied.add(k);
    }
    for (const b of this.boxes.values()) {
      const k = keyOf(b);
      if (this.isWall(b) || occupied.has(k) || this.boxByCell.get(k) !== b.id) throw new Error('Invalid box index'); occupied.add(k);
    }
    if (this.playerByCell.size !== this.online().length || this.boxByCell.size !== this.boxes.size) throw new Error('Stale cell index');
  }
}
