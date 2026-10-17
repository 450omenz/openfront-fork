import { TileRef } from "@openfront/engine-api/game/GameMap";
import { UnitType } from "@openfront/engine-api/game/GameTypes";
import { Game, Player, Unit } from "../../game/Game";
import { FrontSlot, frontSlots } from "./FrontMap";

/**
 * Spreads a player's auto-deploying land units across the front (fork).
 *
 * One assignment per owner and unit type per tick (memoized), shared by
 * every unit of that owner — so units are placed together rather than each
 * grabbing the nearest spot. Greedy maximum coverage over FrontMap slots:
 *
 *  1. Units the assigner doesn't control (a player's order, holding, or not
 *     registered) cover the slots within aura range of where they are or
 *     are going.
 *  2. Rounds: the uncovered slot with the most weight left gets the nearest
 *     free unit, which then covers the slots around it. A fight (one attack
 *     or attacker) counts for less with each unit it already got, so units
 *     spread over several fights.
 *     A unit settled at another uncovered slot only moves if this slot
 *     outweighs that one by more than tankReassignMargin percent, so units
 *     don't flip between two similar slots as the fronts shift.
 *  3. Leftover units stay where they are if they're settled at a slot,
 *     otherwise double up on the heaviest slot.
 *
 * Unit executions register their auto-deploy state with registerFrontUnit
 * (in init and restoreSnapshot), so the assigner reads it live; it is never
 * stored here across ticks.
 */
export interface FrontUnitState {
  /** The assigner may move this unit now (no player order or hold). */
  autoEligible(ticks: number): boolean;
  /** The stage tile the unit is auto-driving to, if any. */
  autoTarget(): TileRef | null;
  /** The unit's route search recently failed near this tile. */
  avoids(tile: TileRef, ticks: number): boolean;
}

export type FrontOrder =
  /** Nothing to do: no front, or this unit isn't needed. */
  | { kind: "none" }
  /** Stay put: the unit already covers its slot. */
  | { kind: "atFront" }
  /** Drive here. */
  | { kind: "stage"; tile: TileRef };

const SETTLE_RANGE = 3;

const registry = new WeakMap<Unit, FrontUnitState>();

export function registerFrontUnit(unit: Unit, state: FrontUnitState): void {
  registry.set(unit, state);
}

const memo = new WeakMap<
  Player,
  Map<UnitType, { tick: number; orders: Map<number, FrontOrder> }>
>();

export function frontOrderFor(mg: Game, unit: Unit): FrontOrder {
  const owner = unit.owner();
  const type = unit.type();
  let byType = memo.get(owner);
  if (byType === undefined) {
    byType = new Map();
    memo.set(owner, byType);
  }
  let hit = byType.get(type);
  if (hit === undefined || hit.tick !== mg.ticks()) {
    hit = { tick: mg.ticks(), orders: assign(mg, owner, type) };
    byType.set(type, hit);
  }
  return hit.orders.get(unit.id()) ?? { kind: "none" };
}

interface Free {
  unit: Unit;
  state: FrontUnitState;
  /** Where it is or is auto-driving to. */
  spot: TileRef;
  /** Index of the uncovered slot it is settled at, or -1. */
  settled: number;
}

function assign(
  mg: Game,
  owner: Player,
  type: UnitType,
): Map<number, FrontOrder> {
  const orders = new Map<number, FrontOrder>();
  const allSlots = frontSlots(mg, owner);
  if (allSlots.length === 0) return orders;

  const ticks = mg.ticks();
  const aura = mg.config().tankAuraRange();
  // A unit staged `standoff` tiles behind the line still covers about an
  // aura radius of line either side of it, so a slot counts as covered
  // when its anchor is within aura + standoff: units end up roughly an aura
  // diameter apart along the front.
  const reach = aura + mg.config().tankStandoff() + 1;
  const reachSq = reach * reach;
  // A unit this close to a slot's stage tile is "at" that slot. Small, so
  // units follow a front that advances instead of lagging behind it.
  const settleSq = SETTLE_RANGE * SETTLE_RANGE;
  const margin = mg.config().tankReassignMargin();
  // Units are sorted by id so the greedy pass doesn't depend on how the
  // owner's unit list happens to be stored.
  const units = owner
    .units(type)
    .filter((u) => u.isActive())
    .sort((a, b) => a.id() - b.id());
  const free: Free[] = [];
  const fixedSpots: TileRef[] = [];
  for (const u of units) {
    const state = registry.get(u);
    if (state === undefined || !state.autoEligible(ticks)) {
      fixedSpots.push(u.targetTile() ?? u.tile());
      continue;
    }
    const spot = state.autoTarget() ?? u.tile();
    free.push({ unit: u, state, spot, settled: -1 });
  }
  if (free.length === 0) return orders;

  const slots = allSlots;
  const covered = new Uint8Array(slots.length);
  const cover = (spot: TileRef) => {
    for (let i = 0; i < slots.length; i++) {
      if (mg.euclideanDistSquared(spot, slots[i].anchor) <= reachSq) {
        covered[i] = 1;
      }
    }
  };
  for (const spot of fixedSpots) cover(spot);
  for (const f of free) f.settled = settledSlot(mg, slots, f.spot, settleSq);

  const taken = new Set<Free>();
  const send = (f: Free, slotIdx: number) => {
    taken.add(f);
    const slot = slots[slotIdx];
    // A unit settled at this slot keeps its spot (no new route); one parked
    // there idle is simply at the front.
    if (f.settled === slotIdx && f.state.autoTarget() === null) {
      orders.set(f.unit.id(), { kind: "atFront" });
      cover(f.unit.tile());
    } else if (f.settled === slotIdx) {
      orders.set(f.unit.id(), { kind: "stage", tile: f.spot });
      cover(f.spot);
    } else {
      orders.set(f.unit.id(), { kind: "stage", tile: slot.stage });
      cover(slot.stage);
    }
  };

  // The free unit to send to slot i, and how far it is (0 if settled there).
  const candidate = (i: number): { f: Free; cost: number } | null => {
    const slot = slots[i];
    let best: Free | null = null;
    let bestCost = Infinity;
    for (const f of free) {
      if (taken.has(f) || f.state.avoids(slot.stage, ticks)) continue;
      if (f.settled !== -1 && f.settled !== i && !covered[f.settled]) {
        // Settled elsewhere: only worth moving for a clearly heavier slot.
        const other = slots[f.settled].weight;
        if (slot.weight * 100 <= other * (100 + margin)) continue;
      }
      const cost =
        f.settled === i ? 0 : mg.manhattanDist(f.unit.tile(), slot.stage);
      if (cost < bestCost) {
        best = f;
        bestCost = cost;
      }
    }
    return best === null ? null : { f: best, cost: bestCost };
  };

  // Each round sends one unit to the uncovered slot with the most weight
  // left. A fight's slots count for less the more units it already has
  // (weight / (1 + sent)), so a second attack gets a unit before the first
  // gets its third. Ties go to the slot with the nearest unit, then the
  // lower anchor: a lone tank takes the closest stretch of a uniform front.
  const sent = new Map<number, number>();
  for (;;) {
    let bestI = -1;
    let bestPick: { f: Free; cost: number } | null = null;
    let bestW = 0;
    let bestDiv = 1;
    for (let i = 0; i < slots.length; i++) {
      if (covered[i]) continue;
      const w = slots[i].weight;
      const div = 1 + (sent.get(slots[i].group) ?? 0);
      // Compare w/div with bestW/bestDiv in integers.
      const cmp = bestI === -1 ? 1 : w * bestDiv - bestW * div;
      if (cmp < 0) continue;
      const pick = candidate(i);
      if (pick === null) continue;
      if (
        cmp > 0 ||
        pick.cost < bestPick!.cost ||
        (pick.cost === bestPick!.cost && slots[i].anchor < slots[bestI].anchor)
      ) {
        bestI = i;
        bestPick = pick;
        bestW = w;
        bestDiv = div;
      }
    }
    if (bestI === -1 || bestPick === null) break;
    send(bestPick.f, bestI);
    const g = slots[bestI].group;
    sent.set(g, (sent.get(g) ?? 0) + 1);
  }

  // Leftovers: stay if settled at a slot, else back up the heaviest one.
  for (const f of free) {
    if (taken.has(f)) continue;
    if (f.settled !== -1) {
      send(f, f.settled);
      continue;
    }
    const heaviest = slots.findIndex((s) => !f.state.avoids(s.stage, ticks));
    if (heaviest !== -1) send(f, heaviest);
  }
  return orders;
}

// The slot whose stage tile is nearest `spot`, if within settle range.
function settledSlot(
  mg: Game,
  slots: FrontSlot[],
  spot: TileRef,
  settleSq: number,
): number {
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < slots.length; i++) {
    const d = mg.euclideanDistSquared(spot, slots[i].stage);
    if (d <= settleSq && d < bestD) {
      best = i;
      bestD = d;
    }
  }
  return best;
}
