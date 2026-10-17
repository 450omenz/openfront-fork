import {
  PlayerInfo,
  PlayerType,
  TerrainType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { GameConfig } from "@openfront/engine-api/Schemas";
import {
  AttackLogicInput,
  EngineConfig,
} from "@openfront/engine/configuration/EngineConfig";
import { AttackExecution } from "@openfront/engine/execution/AttackExecution";
import { NukeExecution } from "@openfront/engine/execution/NukeExecution";
import { UpgradeStructureExecution } from "@openfront/engine/execution/UpgradeStructureExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { setup } from "./util/Setup";
import { expectSnapshotRoundTrip } from "./util/Snapshot";
import { UseRealAttackLogic } from "./util/TestConfig";
import { executeTicks } from "./util/utils";

let game: Game;
let p1: Player;
let p2: Player;

function conquerRect(
  p: Player,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
) {
  for (let x = x0; x <= x1; x++)
    for (let y = y0; y <= y1; y++) p.conquer(game.ref(x, y));
}

async function twoPlayers(config: typeof EngineConfig | undefined = undefined) {
  game = await setup(
    "plains",
    { infiniteGold: true, instantBuild: true },
    [
      new PlayerInfo("p1", PlayerType.Human, null, "p1"),
      new PlayerInfo("p2", PlayerType.Human, null, "p2"),
    ],
    undefined,
    config,
  );
  p1 = game.player("p1");
  p2 = game.player("p2");
  // p1 owns the west half, p2 the east half.
  conquerRect(p1, 0, 0, 49, 99);
  conquerRect(p2, 50, 0, 99, 99);
}

const density = () => game.config().populationDensity();
const weight = (p: Player, x: number, y: number) =>
  density().tileWeight(game, p, game.ref(x, y));

describe("Population density", () => {
  beforeEach(() => twoPlayers());

  test("is 1 everywhere without buildings, and the total is the tile count", () => {
    expect(weight(p1, 10, 10)).toBe(1);
    expect(weight(p1, 40, 90)).toBe(1);
    expect(density().totalWeight(game, p1)).toBe(p1.numTilesOwned());
  });

  test("peaks at a city and fades with distance", () => {
    p1.buildUnit(UnitType.City, game.ref(25, 50), {});
    const at = weight(p1, 25, 50);
    const near = weight(p1, 25, 55);
    const far = weight(p1, 25, 65);
    const outside = weight(p1, 25, 75);
    expect(at).toBeCloseTo(1 + 6, 5);
    expect(at).toBeGreaterThan(near);
    expect(near).toBeGreaterThan(far);
    expect(outside).toBe(1);
  });

  test("a stacked city is denser", () => {
    const city = p1.buildUnit(UnitType.City, game.ref(25, 50), {});
    const level1 = weight(p1, 25, 55);
    game.addExecution(new UpgradeStructureExecution(p1, city.id(), 2));
    game.executeNextTick();
    expect(city.level()).toBe(3);
    expect(weight(p1, 25, 55) - 1).toBeCloseTo(3 * (level1 - 1), 5);
  });

  test("weaker sources add less than a city", () => {
    p1.buildUnit(UnitType.Factory, game.ref(10, 20), {});
    p1.buildUnit(UnitType.City, game.ref(10, 80), {});
    expect(weight(p1, 10, 20)).toBeGreaterThan(1);
    expect(weight(p1, 10, 20)).toBeLessThan(weight(p1, 10, 80));
  });

  test("only the owner's buildings count", () => {
    p2.buildUnit(UnitType.City, game.ref(52, 50), {});
    expect(weight(p1, 48, 50)).toBe(1);
    expect(weight(p2, 54, 50)).toBeGreaterThan(1);
  });

  test("tile shares add up to the whole population", () => {
    p1.buildUnit(UnitType.City, game.ref(25, 50), {});
    p1.buildUnit(UnitType.Factory, game.ref(25, 15), {});
    const total = density().totalWeight(game, p1);
    let sum = 0;
    for (let x = 0; x <= 49; x++)
      for (let y = 0; y <= 99; y++) sum += weight(p1, x, y);
    expect(sum / total).toBeCloseTo(1, 6);
  });

  test("shares still add up when a city's reach is mostly not the owner's land", async () => {
    game = await setup("plains", {}, [
      new PlayerInfo("a", PlayerType.Human, null, "a"),
    ]);
    const a = game.player("a");
    // A 10x10 territory: far smaller than a city's 20-tile reach.
    for (let x = 0; x < 10; x++)
      for (let y = 0; y < 10; y++) a.conquer(game.ref(x, y));
    a.buildUnit(UnitType.City, game.ref(5, 5), {});
    const d = game.config().populationDensity();
    let sum = 0;
    for (let x = 0; x < 10; x++)
      for (let y = 0; y < 10; y++) sum += d.tileWeight(game, a, game.ref(x, y));
    expect(sum / d.totalWeight(game, a)).toBeCloseTo(1, 6);
    // Still denser at the city than at the edge.
    expect(d.relativeDensity(game, a, game.ref(5, 5))).toBeGreaterThan(1);
    expect(d.relativeDensity(game, a, game.ref(0, 0))).toBeLessThan(1);
  });

  test("a city still being built adds nothing", async () => {
    game = await setup("plains", {}, [
      new PlayerInfo("a", PlayerType.Human, null, "a"),
    ]);
    const a = game.player("a");
    for (let x = 0; x < 40; x++)
      for (let y = 0; y < 40; y++) a.conquer(game.ref(x, y));
    const city = a.buildUnit(UnitType.City, game.ref(20, 20), {});
    city.setUnderConstruction(true);
    expect(
      game.config().populationDensity().tileWeight(game, a, game.ref(20, 20)),
    ).toBe(1);
    expect(game.config().populationDensity().totalWeight(game, a)).toBe(
      a.numTilesOwned(),
    );
  });
});

describe("attackLogic with density", () => {
  const real = new EngineConfig({} as GameConfig, false);
  const input = (
    defender: Partial<NonNullable<AttackLogicInput["defender"]>>,
  ): AttackLogicInput => ({
    terrain: TerrainType.Plains,
    attackTroops: 10_000,
    attacker: { type: PlayerType.Human, numTiles: 1000 },
    defender: {
      type: PlayerType.Human,
      numTiles: 1000,
      troops: 10_000,
      isTraitor: false,
      isDisconnectedTeammate: false,
      ...defender,
    },
    defenderHasDefensePost: false,
    falloutRatio: null,
    borderSize: 50,
  });

  test("weight 1 of numTiles is exactly the old even spread", () => {
    expect(
      real.attackLogic(input({ tileWeight: 1, totalWeight: 1000 })),
    ).toEqual(real.attackLogic(input({})));
  });

  test("a dense tile kills more defenders and costs the attacker more", () => {
    const open = real.attackLogic(input({ tileWeight: 1, totalWeight: 1200 }));
    const city = real.attackLogic(input({ tileWeight: 6, totalWeight: 1200 }));
    expect(city.defenderTroopLoss).toBeCloseTo(6 * open.defenderTroopLoss, 5);
    expect(city.attackerTroopLoss).toBeGreaterThan(open.attackerTroopLoss);
  });
});

describe("density in play", () => {
  // Troops p2 loses to the same attack, with or without a city on the front.
  async function defenderLoss(withCity: boolean): Promise<number> {
    await twoPlayers(UseRealAttackLogic);
    if (withCity) p2.buildUnit(UnitType.City, game.ref(52, 50), {});
    p1.addTroops(500_000);
    p2.addTroops(100_000);
    const before = p2.troops();
    game.addExecution(new AttackExecution(50_000, p1, p2.id(), null));
    executeTicks(game, 15);
    return before - p2.troops();
  }

  test("attacks through a city kill more defenders", async () => {
    const open = await defenderLoss(false);
    const city = await defenderLoss(true);
    expect(open).toBeGreaterThan(0);
    expect(city).toBeGreaterThan(open);
  });

  // Troops p1 loses to one atom bomb on (25, 50), with or without a city there.
  async function nukeLoss(withCity: boolean): Promise<number> {
    await twoPlayers();
    if (withCity) p1.buildUnit(UnitType.City, game.ref(25, 50), {});
    p2.buildUnit(UnitType.MissileSilo, game.ref(80, 50), {});
    p1.addTroops(100_000);
    const before = p1.troops();
    game.addExecution(
      new NukeExecution(UnitType.AtomBomb, p2, game.ref(25, 50), null),
    );
    for (let i = 0; i < 300; i++) {
      game.executeNextTick();
      if (i > 2 && game.units(UnitType.AtomBomb).length === 0) break;
    }
    return before - p1.troops();
  }

  test("a nuke on a city kills more people than on open land", async () => {
    const open = await nukeLoss(false);
    const city = await nukeLoss(true);
    expect(open).toBeGreaterThan(0);
    expect(city).toBeGreaterThan(open * 1.5);
  });

  test("survives a snapshot round trip mid-attack through a city", async () => {
    await twoPlayers(UseRealAttackLogic);
    p2.buildUnit(UnitType.City, game.ref(52, 50), {});
    p1.addTroops(500_000);
    p2.addTroops(100_000);
    game.addExecution(new AttackExecution(50_000, p1, p2.id(), null));
    executeTicks(game, 5);
    await expectSnapshotRoundTrip(game, "plains", 30);
  });
});
