import { GameMap, TileRef } from "@openfront/engine-api/game/GameMap";
import { Climate, TerrainType } from "@openfront/engine-api/game/GameTypes";

/**
 * Climate zones (fork).
 *
 * Maps only carry elevation, so climate is derived from it: how high a tile
 * is, how far it is from water, and how far from the equator (the middle row
 * of the map). Nothing is stored; every client derives the same zones from
 * the same map with integer math only.
 *
 *   1. Highland or Mountain terrain            → Highland
 *   2. within COASTAL_RANGE tiles of water     → Coastal
 *   3. latitude band above COLD_BAND           → Cold
 *   4. ARID_RANGE+ tiles from water, band below ARID_MAX_BAND → Arid
 *   5. otherwise                               → Temperate
 *
 * The band is 0 on the equator and 100 at the top and bottom edges.
 *
 * Terrain can change mid-game (WaterManager), so the cache is keyed on the
 * map's waterVersion: the zones are a pure function of the current map, and
 * a restored snapshot derives the same zones as a live game.
 */

export const COASTAL_RANGE = 6;
export const ARID_RANGE = 30;
export const COLD_BAND = 70;
export const ARID_MAX_BAND = 60;
/** Distances are capped here; anything farther counts as this far. */
const MAX_DIST = 255;
/** Marks water (and impassable) tiles in the climate array. */
export const NO_CLIMATE = 255;

export const CLIMATES: readonly Climate[] = [
  Climate.Temperate,
  Climate.Arid,
  Climate.Cold,
  Climate.Coastal,
  Climate.Highland,
];

interface Cached {
  version: number;
  zones: Uint8Array;
}

const cache = new WeakMap<GameMap, Cached>();
const homeCache = new WeakMap<object, { version: number; climate: Climate }>();

/** The climate of every tile; NO_CLIMATE for water and impassable tiles. */
export function climateMap(map: GameMap): Uint8Array {
  const version = map.waterVersion();
  const hit = cache.get(map);
  if (hit !== undefined && hit.version === version) return hit.zones;
  const zones = computeZones(map);
  cache.set(map, { version, zones });
  return zones;
}

export function climateAt(map: GameMap, tile: TileRef): Climate | null {
  const c = climateMap(map)[tile];
  return c === undefined || c === NO_CLIMATE ? null : (c as Climate);
}

/**
 * The most common climate within `radius` of `tile`, ties going to the
 * earlier entry in CLIMATES. `key` (usually the unit) caches the answer
 * until the map's terrain changes.
 */
export function homeClimate(
  map: GameMap,
  tile: TileRef,
  radius: number,
  key?: object,
): Climate {
  const version = map.waterVersion();
  if (key !== undefined) {
    const hit = homeCache.get(key);
    if (hit !== undefined && hit.version === version) return hit.climate;
  }
  const zones = climateMap(map);
  const counts = new Array<number>(CLIMATES.length).fill(0);
  const cx = map.x(tile);
  const cy = map.y(tile);
  const r2 = radius * radius;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy > r2) continue;
      const x = cx + dx;
      const y = cy + dy;
      if (!map.isValidCoord(x, y)) continue;
      const c = zones[map.ref(x, y)];
      if (c !== NO_CLIMATE) counts[c]++;
    }
  }
  let best = Climate.Temperate;
  let bestCount = -1;
  for (const c of CLIMATES) {
    if (counts[c] > bestCount) {
      best = c;
      bestCount = counts[c];
    }
  }
  if (key !== undefined) homeCache.set(key, { version, climate: best });
  return best;
}

function computeZones(map: GameMap): Uint8Array {
  const w = map.width();
  const h = map.height();
  const n = w * h;
  // Multi-source BFS from every water tile: distance to the nearest water.
  const dist = new Uint8Array(n).fill(MAX_DIST);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let t = 0; t < n; t++) {
    if (!map.isLand(t)) {
      dist[t] = 0;
      queue[tail++] = t;
    }
  }
  while (head < tail) {
    const t = queue[head++];
    const d = dist[t] + 1;
    if (d >= MAX_DIST) continue;
    const x = t % w;
    const y = (t - x) / w;
    if (x > 0 && dist[t - 1] > d) {
      dist[t - 1] = d;
      queue[tail++] = t - 1;
    }
    if (x < w - 1 && dist[t + 1] > d) {
      dist[t + 1] = d;
      queue[tail++] = t + 1;
    }
    if (y > 0 && dist[t - w] > d) {
      dist[t - w] = d;
      queue[tail++] = t - w;
    }
    if (y < h - 1 && dist[t + w] > d) {
      dist[t + w] = d;
      queue[tail++] = t + w;
    }
  }

  const zones = new Uint8Array(n);
  for (let t = 0; t < n; t++) {
    if (!map.isLand(t) || map.isImpassable(t)) {
      zones[t] = NO_CLIMATE;
      continue;
    }
    const terrain = map.terrainType(t);
    if (terrain === TerrainType.Highland || terrain === TerrainType.Mountain) {
      zones[t] = Climate.Highland;
      continue;
    }
    const d = dist[t];
    if (d <= COASTAL_RANGE) {
      zones[t] = Climate.Coastal;
      continue;
    }
    const y = Math.floor(t / w);
    const band = Math.floor((Math.abs(2 * y - h) * 100) / Math.max(1, h));
    if (band > COLD_BAND) {
      zones[t] = Climate.Cold;
    } else if (d >= ARID_RANGE && band < ARID_MAX_BAND) {
      zones[t] = Climate.Arid;
    } else {
      zones[t] = Climate.Temperate;
    }
  }
  return zones;
}
