import { TileRef } from "@openfront/engine-api/game/GameMap";
import { UnitType } from "@openfront/engine-api/game/GameTypes";
import { Game, Player, Unit } from "../../game/Game";

/**
 * Reusable "go where the fighting is" behavior for land units (fork).
 *
 * A front is an enemy tile one of the owner's attacks on another player is
 * fighting over right now (Attack.borderTiles()). Attacks on unclaimed land
 * are not fronts: nothing there to support. seekFront() answers two
 * questions for a unit: is it already close enough to a front to matter, and
 * if not, which owned tile next to the nearest front should it drive to.
 *
 * Any unit execution can use it; see TankExecution.autoDeploy() for the
 * pattern (seek on an interval, never override a player's own order).
 */
export interface FrontSeekOptions {
  /** A front tile this close (Euclidean, tiles) counts as "at the front". */
  inRange: number;
  /** Ignore fronts further than this (Manhattan, tiles) from the unit. */
  maxDistance: number;
  /**
   * Don't stage where another of the owner's units of these types already
   * sits within this many tiles, so a group spreads along the line instead of
   * piling onto one tile. 0 disables spreading.
   */
  spread: number;
  spreadTypes: readonly UnitType[];
}

export type FrontSeekResult =
  /** No front within maxDistance. */
  | { kind: "none" }
  /** Already within inRange of a front: stay put. */
  | { kind: "atFront" }
  /** Drive here: an owned land tile bordering a front. */
  | { kind: "stage"; tile: TileRef };

export function seekFront(
  mg: Game,
  owner: Player,
  unit: Unit,
  opts: FrontSeekOptions,
): FrontSeekResult {
  const from = unit.tile();
  const inRangeSq = opts.inRange * opts.inRange;
  const claimed = claimedTiles(owner, unit, opts);
  const spreadSq = opts.spread * opts.spread;
  // Nearest unclaimed front, and nearest overall as a fallback. Tile ref
  // breaks distance ties so every client picks the same tile.
  let free: Candidate | null = null;
  let any: Candidate | null = null;

  for (const attack of owner.outgoingAttacks()) {
    if (!attack.isActive() || attack.retreating()) continue;
    if (!attack.target().isPlayer()) continue;
    for (const front of attack.borderTiles()) {
      if (mg.euclideanDistSquared(from, front) <= inRangeSq) {
        return { kind: "atFront" };
      }
      const dist = mg.manhattanDist(from, front);
      if (dist > opts.maxDistance) continue;
      const beatsAny = better(dist, front, any);
      const isFree =
        better(dist, front, free) &&
        !claimed.some((c) => mg.euclideanDistSquared(c, front) <= spreadSq);
      if (!beatsAny && !isFree) continue;
      const stage = ownedNeighbor(mg, owner, front);
      if (stage === null) continue;
      if (beatsAny) any = { dist, front, stage };
      if (isFree) free = { dist, front, stage };
    }
  }

  // Every front is taken: doubling up beats sitting at home.
  const pick = free ?? any;
  return pick === null ? { kind: "none" } : { kind: "stage", tile: pick.stage };
}

interface Candidate {
  dist: number;
  front: TileRef;
  stage: TileRef;
}

function better(dist: number, front: TileRef, c: Candidate | null): boolean {
  return c === null || dist < c.dist || (dist === c.dist && front < c.front);
}

function ownedNeighbor(mg: Game, owner: Player, tile: TileRef): TileRef | null {
  for (const n of mg.neighbors(tile)) {
    if (mg.owner(n) === owner && mg.isLand(n) && !mg.isImpassable(n)) {
      return n;
    }
  }
  return null;
}

// Where the owner's other units of spreadTypes are, or are driving to.
function claimedTiles(
  owner: Player,
  self: Unit,
  opts: FrontSeekOptions,
): TileRef[] {
  const out: TileRef[] = [];
  if (opts.spread <= 0) return out;
  for (const type of opts.spreadTypes) {
    for (const u of owner.units(type)) {
      if (u === self || !u.isActive()) continue;
      out.push(u.targetTile() ?? u.tile());
    }
  }
  return out;
}
