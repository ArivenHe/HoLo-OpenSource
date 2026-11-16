import { MOVE_INTERVAL_MS, type Direction } from '../types/game';
import { useGameStore } from './useGameStore';

const held = new Map<string, Direction>();
let timer: number | undefined;
function tick() {
  const dirs = new Set(held.values());
  const delta = { x: Number(dirs.has('right')) - Number(dirs.has('left')), y: Number(dirs.has('down')) - Number(dirs.has('up')) };
  if (delta.x || delta.y) useGameStore.getState().sendMove(delta);
}
export function pressDirection(source: string, direction: Direction) {
  if (held.has(source)) return;
  held.set(source, direction); tick();
  if (!timer) timer = window.setInterval(tick, MOVE_INTERVAL_MS + 5);
}
export function releaseDirection(source: string) {
  held.delete(source);
  if (!held.size) { clearInterval(timer); timer = undefined; }
}
export function clearDirections() { held.clear(); clearInterval(timer); timer = undefined; }
window.addEventListener('blur', clearDirections);
document.addEventListener('visibilitychange', () => { if (document.hidden) clearDirections(); });
useGameStore.subscribe((s, old) => { if ((!s.ready && old.ready) || s.state.match.status !== old.state.match.status) clearDirections(); });
