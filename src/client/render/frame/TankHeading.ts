/**
 * Tank facing for the 8-direction sprites (fork, client-only).
 *
 * Tanks path in 4 directions, so a single step can only ever say N/E/S/W.
 * Instead the heading is measured over the last few tiles: once a tank has
 * moved HEADING_WINDOW tiles (Manhattan) from its anchor, the direction from
 * anchor to current tile is snapped to one of 8 octants and the anchor moves
 * up. A staircase path therefore reads as a diagonal. Purely visual — the
 * engine never sees it.
 *
 * Directions: 0 = N, then clockwise in 45° steps (1 = NE … 7 = NW). Screen y
 * grows downward.
 */
export const HEADING_WINDOW = 3;
export const DEFAULT_HEADING = 0;

/** Snap a screen-space displacement to an octant (0 = N, clockwise). */
export function octant(dx: number, dy: number): number {
  // atan2(dx, -dy): 0 at north, increasing clockwise (y down).
  const a = Math.atan2(dx, -dy);
  return (Math.round(a / (Math.PI / 4)) + 8) % 8;
}

interface HeadingState {
  anchor: number;
  dir: number;
  seen: number;
}

export class TankHeadingTracker {
  private state = new Map<number, HeadingState>();
  private frame = 0;

  constructor(private mapW: number) {}

  /** Call once per unit update pass, before heading(). */
  beginFrame(): void {
    this.frame++;
  }

  heading(unitId: number, pos: number): number {
    let s = this.state.get(unitId);
    if (s === undefined) {
      s = { anchor: pos, dir: DEFAULT_HEADING, seen: this.frame };
      this.state.set(unitId, s);
      return s.dir;
    }
    s.seen = this.frame;
    if (pos === s.anchor) return s.dir;
    const w = this.mapW;
    const ax = s.anchor % w;
    const px = pos % w;
    const dx = px - ax;
    const dy = (pos - px) / w - (s.anchor - ax) / w;
    if (Math.abs(dx) + Math.abs(dy) >= HEADING_WINDOW) {
      s.dir = octant(dx, dy);
      s.anchor = pos;
    } else if (Math.abs(dx) + Math.abs(dy) === 1) {
      // A single step at 90° or more from the current heading is a real
      // turn (not a staircase zig-zag): face it right away instead of
      // waiting HEADING_WINDOW tiles.
      const fresh = octant(dx, dy);
      const diff = (fresh - s.dir + 8) % 8;
      if (diff >= 2 && diff <= 6) s.dir = fresh;
    }
    return s.dir;
  }

  /** Forget tanks not seen since the last beginFrame(). */
  endFrame(): void {
    for (const [id, s] of this.state) {
      if (s.seen !== this.frame) this.state.delete(id);
    }
  }
}
