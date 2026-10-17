import { Climate, UnitType } from "@openfront/engine-api/game/GameTypes";
import { NO_CLIMATE } from "@openfront/engine-lib/game/Climate";
import { GameMapImpl } from "@openfront/engine-lib/game/GameMapImpl";
import { PopulationDensity } from "@openfront/engine-lib/game/PopulationDensity";
import {
  isOverlayMode,
  nextViewMode,
  VIEW_MODES,
  ViewMode,
} from "../../src/client/render/ViewMode";
import {
  climateOverlay,
  densityIndex,
  densityOverlay,
} from "../../src/client/render/ViewOverlayData";

describe("ViewMode", () => {
  test("cycles through every mode and wraps", () => {
    let m = ViewMode.Normal;
    const seen: ViewMode[] = [];
    for (let i = 0; i < VIEW_MODES.length; i++) {
      seen.push(m);
      m = nextViewMode(m);
    }
    expect(seen).toEqual(VIEW_MODES);
    expect(m).toBe(ViewMode.Normal);
  });

  test("cycles only the available modes", () => {
    const plain = VIEW_MODES.filter((v) => !isOverlayMode(v));
    expect(nextViewMode(ViewMode.Grid, plain)).toBe(ViewMode.Normal);
  });
});

/** 20×10 map: water at x = 0, land elsewhere. */
function map(): GameMapImpl {
  const w = 20;
  const h = 10;
  const bytes = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 1; x < w; x++) bytes[y * w + x] = (1 << 7) | 2;
  return new GameMapImpl(w, h, bytes, (w - 1) * h);
}

describe("overlay data", () => {
  test("density index grows with people and stays in range", () => {
    expect(densityIndex(0)).toBe(1);
    let prev = 0;
    for (const p of [1, 10, 100, 1_000, 10_000, 1e9]) {
      const i = densityIndex(p);
      expect(i).toBeGreaterThanOrEqual(prev);
      expect(i).toBeLessThanOrEqual(255);
      prev = i;
    }
    expect(densityIndex(1e9)).toBe(255);
  });

  test("climate overlay: water is transparent, land gets climate + 1", () => {
    const m = map();
    const o = climateOverlay(m as never);
    expect(o.indices[m.ref(0, 5)]).toBe(0);
    expect(o.indices[m.ref(2, 5)]).toBe(Climate.Coastal + 1);
    expect(NO_CLIMATE).toBe(255);
  });

  test("density overlay: owned land only, more around a city", () => {
    const m = map();
    // Player 1 owns x >= 10.
    for (let y = 0; y < 10; y++)
      for (let x = 10; x < 20; x++) m.setOwnerID(m.ref(x, y), 1);
    const city = {
      type: () => UnitType.City,
      tile: () => m.ref(15, 5),
      lastTile: () => m.ref(15, 5),
      isActive: () => true,
      isUnderConstruction: () => false,
      level: () => 1,
      statusFlags: () => 0,
      owner: () => player,
    };
    const player = {
      smallID: () => 1,
      troops: () => 100_000,
      units: (t: UnitType) => (t === UnitType.City ? [city] : []),
      numTilesOwned: () => 100,
      isPlayer: (): boolean => true,
    };
    const sources = { [UnitType.City]: { peak: 6, radius: 4 } };
    const density = new PopulationDensity(sources);
    const game = Object.assign(m, {
      players: () => [player],
      config: () => ({
        populationDensity: () => density,
        populationDensitySources: () => sources,
      }),
      owner: (t: number) =>
        m.ownerID(t) === 1 ? player : { isPlayer: (): boolean => false },
      ticks: () => 0,
      anyUnitNearby: () => false,
      nearbyUnits: (tile: number, r: number, type: UnitType) =>
        type === UnitType.City &&
        m.euclideanDistSquared(tile, city.tile()) <= r * r
          ? [
              {
                unit: city,
                distSquared: m.euclideanDistSquared(tile, city.tile()),
              },
            ]
          : [],
    });
    const o = densityOverlay(game as never);
    expect(o.indices[m.ref(5, 5)]).toBe(0); // unowned
    const atCity = o.indices[m.ref(15, 5)];
    const far = o.indices[m.ref(10, 0)];
    expect(far).toBeGreaterThan(0);
    expect(atCity).toBeGreaterThan(far);
  });
});
