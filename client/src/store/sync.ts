import { keyOf, type EntityChanges, type PlayerEntity, type ServerState, type StatePatch, type StaticMap, type Vec2 } from '../types/game';

export interface PendingInput { seq: number; delta: Vec2; sentAt: number }
export function mergeEntities<T extends { id: string }>(current: T[], changes: EntityChanges<T>): T[] {
  if (!changes.upsert.length && !changes.remove.length) return current;
  const entities = new Map(current.map(item => [item.id, item]));
  changes.remove.forEach(id => entities.delete(id));
  changes.upsert.forEach(item => entities.set(item.id, { ...entities.get(item.id), ...item } as T));
  return [...entities.values()];
}
export function applyPatch(current: ServerState, patch: StatePatch): ServerState {
  return { ...current, ...patch, players: mergeEntities(current.players, patch.players), boxes: mergeEntities(current.boxes, patch.boxes) };
}
export interface CollisionView { walls: Set<string>; boxes: Set<string>; players: Map<string, string>; width: number; height: number }
export function collisionView(map: StaticMap, state: ServerState): CollisionView {
  return { width: map.width, height: map.height, walls: new Set(map.walls.map(([x, y]) => `${x}:${y}`)), boxes: new Set(state.boxes.map(keyOf)), players: new Map(state.players.map(p => [keyOf(p), p.id])) };
}
export function predictSelf(player: PlayerEntity, pending: PendingInput[], view: CollisionView, now: number): Vec2 {
  let position = { x: player.x, y: player.y }, steps = 0;
  for (const input of pending) {
    // Stop at an uncertain shared interaction; later moves depend on its result.
    if (++steps > 2 || now - input.sentAt > 250) break;
    const next = { x: position.x + input.delta.x, y: position.y + input.delta.y };
    const behind = { x: position.x - input.delta.x, y: position.y - input.delta.y };
    const occupant = view.players.get(keyOf(next));
    if (next.x < 0 || next.y < 0 || next.x >= view.width || next.y >= view.height || view.walls.has(keyOf(next)) || view.boxes.has(keyOf(next)) || view.boxes.has(keyOf(behind)) || (occupant && occupant !== player.id)) break;
    position = next;
  }
  return position;
}
export function acknowledge(pending: PendingInput[], inputSeq: number, settledThrough: number) {
  return pending.filter(input => input.seq !== inputSeq && input.seq > settledThrough);
}
