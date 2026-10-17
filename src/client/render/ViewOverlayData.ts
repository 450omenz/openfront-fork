import { Climate, UnitType } from "@openfront/engine-api/game/GameTypes";
import { GameLike, PlayerLike } from "@openfront/engine-api/game/ReadViews";
import { Config } from "@openfront/engine-lib/configuration/Config";
import { climateMap, NO_CLIMATE } from "@openfront/engine-lib/game/Climate";

/**
 * Per-tile data for the overlay view modes (fork), as palette indices for
 * TileOverlayPass. CPU only, no GL: index 0 = transparent.
 */

export interface TileOverlay {
  indices: Uint8Array;
  palette: Uint8Array;
  opacity: number;
}

// --- Climate ---------------------------------------------------------------

/** Legend + palette colors, indexed by Climate. */
export const CLIMATE_COLORS: Record<Climate, [number, number, number]> = {
  [Climate.Temperate]: [92, 170, 92],
  [Climate.Arid]: [226, 168, 74],
  [Climate.Cold]: [186, 222, 245],
  [Climate.Coastal]: [64, 156, 204],
  [Climate.Highland]: [150, 108, 172],
};

export function climateOverlay(map: GameLike): TileOverlay {
  const zones = climateMap(map);
  const indices = new Uint8Array(zones.length);
  for (let t = 0; t < zones.length; t++) {
    const c = zones[t];
    indices[t] = c === NO_CLIMATE ? 0 : c + 1;
  }
  const palette = new Uint8Array(256 * 4);
  for (const [c, rgb] of Object.entries(CLIMATE_COLORS)) {
    const i = (Number(c) + 1) * 4;
    palette[i] = rgb[0];
    palette[i + 1] = rgb[1];
    palette[i + 2] = rgb[2];
    palette[i + 3] = 255;
  }
  return { indices, palette, opacity: 0.7 };
}

// --- Population density ----------------------------------------------------

/** People per tile at which the heat scale tops out. */
export const DENSITY_SCALE_MAX = 20_000;
const LOG_MAX = Math.log2(1 + DENSITY_SCALE_MAX);

/** Heat palette stops: low (sparse) → high (packed). */
const HEAT_STOPS: [number, [number, number, number, number]][] = [
  [0, [30, 40, 120, 120]],
  [0.35, [30, 150, 170, 170]],
  [0.6, [235, 220, 70, 210]],
  [0.8, [240, 130, 40, 230]],
  [1, [220, 40, 40, 245]],
];

export function heatColor(f: number): [number, number, number, number] {
  for (let i = 1; i < HEAT_STOPS.length; i++) {
    const [f1, c1] = HEAT_STOPS[i];
    if (f <= f1) {
      const [f0, c0] = HEAT_STOPS[i - 1];
      const k = (f - f0) / (f1 - f0);
      return [0, 1, 2, 3].map((j) =>
        Math.round(c0[j] + (c1[j] - c0[j]) * k),
      ) as [number, number, number, number];
    }
  }
  return HEAT_STOPS[HEAT_STOPS.length - 1][1];
}

let heatPalette: Uint8Array | null = null;
function densityPalette(): Uint8Array {
  if (heatPalette !== null) return heatPalette;
  heatPalette = new Uint8Array(256 * 4);
  for (let i = 1; i < 256; i++) {
    const c = heatColor((i - 1) / 254);
    heatPalette.set(c, i * 4);
  }
  return heatPalette;
}

/** Palette index for `people` living on one tile. */
export function densityIndex(people: number): number {
  if (people <= 0) return 1;
  const f = Math.min(1, Math.log2(1 + people) / LOG_MAX);
  return 1 + Math.floor(f * 254);
}

/**
 * People per tile across the map: each owner's troops spread over their land
 * by PopulationDensity's weights (more around cities and other sources).
 * Unowned land and water stay transparent.
 */
export function densityOverlay(
  game: GameLike & {
    players(): readonly PlayerLike[];
    config(): Config;
  },
  reuse?: Uint8Array,
): TileOverlay {
  const w = game.width();
  const h = game.height();
  const n = w * h;
  const config = game.config();
  const density = config.populationDensity();
  const sources = config.populationDensitySources();

  // People on a weight-1 tile, per owner smallID.
  const base = new Map<number, number>();
  for (const p of game.players()) {
    const total = density.totalWeight(game, p);
    if (total > 0) base.set(p.smallID(), p.troops() / total);
  }

  const people = new Float32Array(n);
  for (let t = 0; t < n; t++) {
    const owner = game.ownerID(t);
    if (owner === 0) continue;
    people[t] = base.get(owner) ?? 0;
  }

  // Add each source's disc on its owner's land.
  for (const p of game.players()) {
    const b = base.get(p.smallID());
    if (b === undefined) continue;
    for (const [type, src] of Object.entries(sources)) {
      if (src === undefined) continue;
      for (const u of p.units(type as UnitType)) {
        if (!u.isActive() || u.isUnderConstruction()) continue;
        const cx = game.x(u.tile());
        const cy = game.y(u.tile());
        const r = src.radius;
        const r2 = r * r;
        const peak = src.peak * u.level() * b;
        for (let dy = -r; dy <= r; dy++) {
          const y = cy + dy;
          if (y < 0 || y >= h) continue;
          for (let dx = -r; dx <= r; dx++) {
            const d2 = dx * dx + dy * dy;
            if (d2 >= r2) continue;
            const x = cx + dx;
            if (x < 0 || x >= w) continue;
            const t = y * w + x;
            if (game.ownerID(t) !== p.smallID()) continue;
            people[t] += peak * (1 - d2 / r2);
          }
        }
      }
    }
  }

  const indices =
    reuse !== undefined && reuse.length === n ? reuse : new Uint8Array(n);
  for (let t = 0; t < n; t++) {
    indices[t] = game.ownerID(t) === 0 ? 0 : densityIndex(people[t]);
  }
  return { indices, palette: densityPalette(), opacity: 0.8 };
}
