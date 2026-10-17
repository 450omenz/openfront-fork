import { TileRef } from "@openfront/engine-api/game/GameMap";
import { UnitType } from "@openfront/engine-api/game/GameTypes";
import { GameLike, PlayerLike } from "@openfront/engine-api/game/ReadViews";

/**
 * Population density (fork).
 *
 * A player's troops are one pool, but people don't live evenly across the
 * land: they crowd around cities and other buildings. Density decides where
 * losses fall when land is taken or bombed. Nothing is stored; it is derived
 * from the owner's finished buildings and land every time it is asked for.
 *
 *   weight(tile) = 1 + Σ peak × level × (1 − d²/radius²)
 *     over the owner's sources within radius of the tile
 *   total(player) = Σ weight over every tile the player owns
 *
 * A tile's share of the player's population is weight / total, so the shares
 * add up to exactly 1: losses move toward cities without changing how many
 * people a player has. A player without sources has weight 1 everywhere and
 * total = tiles owned: the old even spread, bit for bit.
 *
 * total() only walks the discs around the player's sources (not all their
 * land), and that part is memoized once per tick per player. Every client computes it
 * at the same point of the same tick, and snapshots are taken between ticks,
 * so the memo never makes clients disagree.
 *
 * Sums are taken in fixed point (integers): units come back from the grid and
 * the player in an order a snapshot restore doesn't keep, and integer sums
 * don't depend on order, so every client gets bit-identical weights.
 *
 * To add a source, add a row to Config.populationDensitySources().
 */

/** Fixed-point scale: weights are exact to 1e-6. */
const SCALE = 1_000_000;

export interface DensitySource {
  /** Extra weight at the building's own tile, per level. */
  peak: number;
  /** Tiles (Euclidean) at which its effect reaches zero. */
  radius: number;
}

export type DensitySources = Partial<Record<UnitType, DensitySource>>;

/** One tile of a source's disc: its offset and level-1 weight (fixed point). */
interface DiscCell {
  dx: number;
  dy: number;
  weight: number;
}

export class PopulationDensity {
  private readonly types: UnitType[];
  private readonly maxRadius: number = 0;
  private readonly discs = new Map<UnitType, DiscCell[]>();
  /** Per player: the buildings' part of total(), fixed point, per tick. */
  private readonly extras = new WeakMap<
    PlayerLike,
    { tick: number; extra: number }
  >();

  constructor(private readonly sources: DensitySources) {
    this.types = Object.keys(sources) as UnitType[];
    for (const type of this.types) {
      const s = sources[type]!;
      this.maxRadius = Math.max(this.maxRadius, s.radius);
      this.discs.set(type, discCells(s));
    }
  }

  /** Weight of one tile owned by owner: 1 plus nearby buildings' share. */
  tileWeight(game: GameLike, owner: PlayerLike, tile: TileRef): number {
    // Fast path: most tiles have no source nearby. Avoids building a result
    // array for every tile an attack conquers.
    if (
      this.types.length === 0 ||
      !game.anyUnitNearby(
        tile,
        this.maxRadius,
        this.types,
        () => true,
        owner.id(),
      )
    ) {
      return 1;
    }
    let extra = 0; // fixed point
    for (const { unit, distSquared } of game.nearbyUnits(
      tile,
      this.maxRadius,
      this.types,
    )) {
      if (unit.owner().id() !== owner.id()) continue;
      const s = this.sources[unit.type()]!;
      const r2 = s.radius * s.radius;
      if (distSquared >= r2) continue;
      // Same rounding as discCells, so total() is the exact sum of these.
      extra += unit.level() * cellWeight(s, distSquared);
    }
    return 1 + extra / SCALE;
  }

  /** Sum of tileWeight over every tile the player owns. */
  totalWeight(game: GameLike, player: PlayerLike): number {
    // The tile count is always live, so a player without sources gets
    // exactly numTilesOwned (old formulas stay bit-identical) even while an
    // attack takes their tiles mid-tick. Only the buildings' part is
    // memoized; it drifts by at most a tick's worth of conquered tiles.
    return player.numTilesOwned() + this.sourceExtra(game, player) / SCALE;
  }

  private sourceExtra(game: GameLike, player: PlayerLike): number {
    const tick = game.ticks();
    const memo = this.extras.get(player);
    if (memo !== undefined && memo.tick === tick) return memo.extra;

    let extra = 0; // fixed point
    const me = player.smallID();
    for (const type of this.types) {
      const cells = this.discs.get(type)!;
      for (const u of player.units(type)) {
        if (!u.isActive() || u.isUnderConstruction()) continue;
        const cx = game.x(u.tile());
        const cy = game.y(u.tile());
        let owned = 0;
        for (const c of cells) {
          const x = cx + c.dx;
          const y = cy + c.dy;
          if (!game.isValidCoord(x, y)) continue;
          const o = game.owner(game.ref(x, y));
          if (o.isPlayer() && (o as PlayerLike).smallID() === me) {
            owned += c.weight;
          }
        }
        extra += u.level() * owned;
      }
    }
    this.extras.set(player, { tick, extra });
    return extra;
  }

  /** tileWeight relative to the player's average tile (1 = average). */
  relativeDensity(game: GameLike, owner: PlayerLike, tile: TileRef): number {
    const tiles = owner.numTilesOwned();
    if (tiles === 0) return 1;
    return (
      this.tileWeight(game, owner, tile) /
      (this.totalWeight(game, owner) / tiles)
    );
  }
}

/** Level-1 weight of a tile at distSquared from a source, in fixed point. */
function cellWeight(s: DensitySource, distSquared: number): number {
  return Math.round(s.peak * (1 - distSquared / (s.radius * s.radius)) * SCALE);
}

/** Every tile offset with d² < radius², with its level-1 weight. */
function discCells(s: DensitySource): DiscCell[] {
  const r2 = s.radius * s.radius;
  const span = Math.floor(s.radius);
  const cells: DiscCell[] = [];
  for (let dy = -span; dy <= span; dy++) {
    for (let dx = -span; dx <= span; dx++) {
      const d2 = dx * dx + dy * dy;
      if (d2 < r2) cells.push({ dx, dy, weight: cellWeight(s, d2) });
    }
  }
  return cells;
}
