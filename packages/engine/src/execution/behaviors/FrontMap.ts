import { TileRef } from "@openfront/engine-api/game/GameMap";
import { Relation, UnitType } from "@openfront/engine-api/game/GameTypes";
import { Game, Player } from "../../game/Game";

/**
 * Where a player's land units are needed right now (fork), as weighted
 * slots. A slot is one aura-sized cell of front line:
 *
 *  - Attack: enemy tiles one of the owner's attacks on a player is fighting
 *    over (Attack.borderTiles()). Cells near an enemy Defense Post weigh
 *    double, since a tank's spearhead cancels the post.
 *  - Defend: the owner's own tiles an incoming attack from a player is
 *    about to take. Weighted by how big the attack is next to our army.
 *  - Watch: border with a player either side is Hostile toward. Only used
 *    when there is no fighting at all, so idle tanks still face a threat.
 *
 * Each slot has an anchor (the cell's front tile nearest its centroid) and
 * a stage tile: owned land `standoff` tiles behind the anchor, where a unit
 * waits — inside aura range but not on the line it would be overrun on.
 *
 * Pure function of game state, memoized for the tick it was built in
 * (never across ticks, so snapshot restore can't change a result).
 */
export const enum FrontKind {
  Attack = 0,
  Defend = 1,
  Watch = 2,
}

export interface FrontSlot {
  kind: FrontKind;
  anchor: TileRef;
  stage: TileRef;
  /** Integer weight: front tiles in the cell times their kind's weight. */
  weight: number;
  /**
   * Which fight the slot belongs to (one attack or one attacker), so units
   * can be spread over several fights, not just along the biggest one.
   */
  group: number;
}

const ATTACK_TILE_WEIGHT = 2;
const DEFEND_TILE_WEIGHT_BASE = 2;
const DEFEND_TILE_WEIGHT_MAX = 6;
const WATCH_TILE_WEIGHT = 1;
// Slot groups: attacks use the target's smallID (< 4096).
const GROUP_DEFEND = 1 << 12;
const GROUP_WATCH = 1 << 13;

interface Cell {
  kind: FrontKind;
  weight: number;
  sumX: number;
  sumY: number;
  tiles: TileRef[];
  /** Attack cells: the defender, for the Defense Post check. */
  enemy: Player | null;
  group: number;
}

const memo = new WeakMap<Player, { tick: number; slots: FrontSlot[] }>();

export function frontSlots(mg: Game, owner: Player): FrontSlot[] {
  const hit = memo.get(owner);
  if (hit !== undefined && hit.tick === mg.ticks()) return hit.slots;
  const slots = buildSlots(mg, owner);
  memo.set(owner, { tick: mg.ticks(), slots });
  return slots;
}

function buildSlots(mg: Game, owner: Player): FrontSlot[] {
  const cellSize = Math.max(1, mg.config().tankAuraRange());
  const cols = Math.ceil(mg.width() / cellSize);
  // Key: kind * (cells) + cell index, so an attack and a defense in the same
  // spot stay separate slots. Map preserves insertion order, and insertion
  // order follows attack and border-set order, which is deterministic.
  const cells = new Map<number, Cell>();
  const cellsPerKind = cols * Math.ceil(mg.height() / cellSize);
  const add = (
    kind: FrontKind,
    tile: TileRef,
    w: number,
    enemy: Player | null,
    group: number,
  ) => {
    const x = mg.x(tile);
    const y = mg.y(tile);
    const key =
      kind * cellsPerKind +
      Math.floor(y / cellSize) * cols +
      Math.floor(x / cellSize);
    let c = cells.get(key);
    if (c === undefined) {
      c = { kind, weight: 0, sumX: 0, sumY: 0, tiles: [], enemy, group };
      cells.set(key, c);
    }
    c.weight += w;
    c.sumX += x;
    c.sumY += y;
    c.tiles.push(tile);
  };

  for (const attack of owner.outgoingAttacks()) {
    if (!attack.isActive() || attack.retreating()) continue;
    const target = attack.target();
    if (!target.isPlayer()) continue;
    for (const t of attack.borderTiles()) {
      if (mg.owner(t) !== target) continue; // stale border entry
      add(FrontKind.Attack, t, ATTACK_TILE_WEIGHT, target, target.smallID());
    }
  }

  const ourTroops = Math.max(1, owner.troops());
  for (const attack of owner.incomingAttacks()) {
    if (!attack.isActive() || attack.retreating()) continue;
    const w = Math.min(
      DEFEND_TILE_WEIGHT_MAX,
      DEFEND_TILE_WEIGHT_BASE + Math.floor((2 * attack.troops()) / ourTroops),
    );
    for (const t of attack.borderTiles()) {
      if (mg.owner(t) !== owner || !passable(mg, owner, t)) continue;
      add(
        FrontKind.Defend,
        t,
        w,
        null,
        GROUP_DEFEND + attack.attacker().smallID(),
      );
    }
  }

  if (cells.size === 0) {
    for (const t of owner.borderTiles()) {
      for (const n of mg.neighbors(t)) {
        const o = mg.owner(n);
        if (!o.isPlayer() || o === owner || owner.isFriendly(o)) continue;
        if (
          owner.relation(o) === Relation.Hostile ||
          o.relation(owner) === Relation.Hostile
        ) {
          if (passable(mg, owner, t)) {
            add(FrontKind.Watch, t, WATCH_TILE_WEIGHT, null, GROUP_WATCH);
          }
          break;
        }
      }
    }
  }

  const slots: FrontSlot[] = [];
  const standoff = mg.config().tankStandoff();
  const postRange = mg.config().defensePostRange();
  for (const c of cells.values()) {
    const anchor = nearestToCentroid(mg, c);
    const stage = stageTile(mg, owner, anchor, standoff);
    if (stage === null) continue;
    let weight = c.weight;
    if (
      c.enemy !== null &&
      mg.hasUnitNearby(anchor, postRange, UnitType.DefensePost, c.enemy.id())
    ) {
      weight *= 2;
    }
    slots.push({ kind: c.kind, anchor, stage, weight, group: c.group });
  }
  // Heaviest first; anchor breaks ties so every client agrees.
  slots.sort((a, b) => b.weight - a.weight || a.anchor - b.anchor);
  return slots;
}

function nearestToCentroid(mg: Game, c: Cell): TileRef {
  const n = c.tiles.length;
  let best = c.tiles[0];
  let bestD = Infinity;
  for (const t of c.tiles) {
    // Compare n²·dist² to stay in integers.
    const dx = mg.x(t) * n - c.sumX;
    const dy = mg.y(t) * n - c.sumY;
    const d = dx * dx + dy * dy;
    if (d < bestD || (d === bestD && t < best)) {
      best = t;
      bestD = d;
    }
  }
  return best;
}

export function passable(mg: Game, owner: Player, t: TileRef): boolean {
  return (
    mg.map().ownerID(t) === owner.smallID() &&
    mg.isLand(t) &&
    !mg.isImpassable(t)
  );
}

/**
 * Owned land `depth` steps inward from `from` (or from its owned neighbors,
 * when `from` is an enemy tile). Breadth-first in neighbor order, so the
 * result is deterministic; falls back to the deepest tile reached when the
 * land is too thin. Null when no owned land touches `from`.
 */
export function stageTile(
  mg: Game,
  owner: Player,
  from: TileRef,
  depth: number,
): TileRef | null {
  let frontier: TileRef[] = [];
  const seen = new Set<TileRef>();
  if (passable(mg, owner, from)) {
    frontier.push(from);
    seen.add(from);
  } else {
    for (const n of mg.neighbors(from)) {
      if (!seen.has(n) && passable(mg, owner, n)) {
        frontier.push(n);
        seen.add(n);
      }
    }
  }
  if (frontier.length === 0) return null;
  let deepest = frontier[0];
  for (let d = 0; d < depth; d++) {
    const next: TileRef[] = [];
    for (const t of frontier) {
      for (const n of mg.neighbors(t)) {
        if (seen.has(n) || !passable(mg, owner, n)) continue;
        seen.add(n);
        next.push(n);
      }
    }
    if (next.length === 0) break;
    deepest = mostInward(mg, owner, from, next);
    frontier = next;
  }
  return deepest;
}

// Of the tiles at one BFS depth, the one most "behind" the line: interior
// tiles (not touching foreign land) first, then furthest from the anchor,
// then the lowest ref.
function mostInward(
  mg: Game,
  owner: Player,
  anchor: TileRef,
  tiles: TileRef[],
): TileRef {
  let best = tiles[0];
  let bestInterior = false;
  let bestD = -1;
  for (const t of tiles) {
    const interior = !touchesForeign(mg, owner, t);
    const d = mg.euclideanDistSquared(anchor, t);
    if (
      (interior && !bestInterior) ||
      (interior === bestInterior && (d > bestD || (d === bestD && t < best)))
    ) {
      best = t;
      bestInterior = interior;
      bestD = d;
    }
  }
  return best;
}

function touchesForeign(mg: Game, owner: Player, t: TileRef): boolean {
  for (const n of mg.neighbors(t)) {
    if (mg.isLand(n) && mg.map().ownerID(n) !== owner.smallID()) return true;
  }
  return false;
}
