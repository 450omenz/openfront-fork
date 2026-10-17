import {
  PlayerInfo,
  PlayerType,
  UnitStatus,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { ConstructionExecution } from "@openfront/engine/execution/ConstructionExecution";
import { UpgradeStructureExecution } from "@openfront/engine/execution/UpgradeStructureExecution";
import { Game, Player, Unit } from "@openfront/engine/game/Game";
import { setup } from "./util/Setup";
import { expectSnapshotRoundTrip } from "./util/Snapshot";
import { executeTicks } from "./util/utils";

let game: Game;
let p1: Player;

const INTERVAL = 5;
const UPKEEP = 1_000;

function build(x: number, y: number): Unit {
  game.addExecution(
    new ConstructionExecution(p1, UnitType.CivicCenter, game.ref(x, y)),
  );
  executeTicks(game, 3);
  const centers = p1.units(UnitType.CivicCenter);
  return centers[centers.length - 1];
}

describe("Civic Center", () => {
  beforeEach(async () => {
    game = await setup("plains", { instantBuild: true }, [
      new PlayerInfo("p1", PlayerType.Human, null, "p1"),
    ]);
    p1 = game.player("p1");
    for (let x = 0; x < 40; x++)
      for (let y = 0; y < 40; y++) p1.conquer(game.ref(x, y));
    game.config().civicCenterUpkeepInterval = () => INTERVAL;
    game.config().civicCenterUpkeep = () => UPKEEP;
    // Isolate upkeep from income.
    game.config().goldAdditionRate = () => 0n;
    p1.addGold(10_000_000n);
  });

  test("is buildable on own land and charges its build cost", () => {
    const before = p1.gold();
    const center = build(10, 10);
    expect(center).toBeDefined();
    expect(center.isUnderConstruction()).toBe(false);
    expect(before - p1.gold()).toBeGreaterThanOrEqual(250_000n);
  });

  test("charges upkeep every interval", () => {
    build(10, 10);
    const start = p1.gold();
    executeTicks(game, INTERVAL * 4 + 1);
    const paid = start - p1.gold();
    expect(paid).toBeGreaterThanOrEqual(BigInt(UPKEEP * 3));
    expect(paid).toBeLessThanOrEqual(BigInt(UPKEEP * 5));
    expect(paid % BigInt(UPKEEP)).toBe(0n);
  });

  test("stops working (NoFunds) when broke, recovers when paid", () => {
    const center = build(10, 10);
    const working = game.config().troopIncreaseRate(p1);
    p1.removeGold(p1.gold());
    executeTicks(game, INTERVAL * 2 + 1);
    expect(center.hasStatus(UnitStatus.NoFunds)).toBe(true);
    expect(game.config().workingCivicCenters(p1)).toBe(0);
    expect(game.config().troopIncreaseRate(p1)).toBeLessThan(working);

    p1.addGold(1_000_000n);
    executeTicks(game, INTERVAL * 2 + 1);
    expect(center.hasStatus(UnitStatus.NoFunds)).toBe(false);
    expect(game.config().workingCivicCenters(p1)).toBe(1);
  });

  test("raises troop regeneration 12% per working center", () => {
    // Keep troops fixed so the base rate doesn't drift between reads.
    const base = game.config().troopIncreaseRate(p1);
    build(10, 10);
    expect(game.config().troopIncreaseRate(p1)).toBeCloseTo(base * 1.12, 5);
    build(20, 20);
    expect(game.config().troopIncreaseRate(p1)).toBeCloseTo(base * 1.24, 5);
  });

  test("only five centers count", () => {
    // structureMinDist is 15: a 3x3 grid of sites 15 tiles apart.
    for (let i = 0; i < 7; i++)
      build(3 + (i % 3) * 15, 3 + Math.floor(i / 3) * 15);
    expect(p1.units(UnitType.CivicCenter).length).toBe(7);
    expect(game.config().workingCivicCenters(p1)).toBe(5);
  });

  describe("stacking", () => {
    function stack(center: Unit, amount: number) {
      game.addExecution(new UpgradeStructureExecution(p1, center.id(), amount));
      game.executeNextTick();
    }

    test("a center can be stacked in place", () => {
      const center = build(10, 10);
      stack(center, 2);
      expect(center.level()).toBe(3);
      expect(p1.units(UnitType.CivicCenter).length).toBe(1);
    });

    test("each level counts toward the troop bonus", () => {
      const base = game.config().troopIncreaseRate(p1);
      const center = build(10, 10);
      stack(center, 2);
      expect(game.config().workingCivicCenters(p1)).toBe(3);
      expect(game.config().troopIncreaseRate(p1)).toBeCloseTo(base * 1.36, 5);
    });

    test("stacked levels share the five-level cap", () => {
      const a = build(10, 10);
      const b = build(30, 30);
      stack(a, 3);
      stack(b, 3);
      expect(game.config().workingCivicCenters(p1)).toBe(5);
    });

    test("upkeep scales with level", () => {
      const center = build(10, 10);
      stack(center, 2);
      executeTicks(game, INTERVAL + 1); // let the first interval start
      const start = p1.gold();
      executeTicks(game, INTERVAL);
      expect(start - p1.gold()).toBe(BigInt(UPKEEP * 3));
    });

    test("stacking costs the same as building another center", () => {
      const center = build(10, 10);
      const cost = game.config().unitInfo(UnitType.CivicCenter).cost(game, p1);
      const before = p1.gold();
      stack(center, 1);
      expect(before - p1.gold()).toBe(cost);
    });
  });

  test("cost rises 125k per center, capped at 1M", () => {
    const cost = game.config().unitInfo(UnitType.CivicCenter).cost;
    expect(cost(game, p1)).toBe(250_000n);
    expect(cost(game, p1, 1)).toBe(375_000n);
    expect(cost(game, p1, 10)).toBe(1_000_000n);
  });

  test("survives a snapshot round trip with NoFunds set", async () => {
    // A fresh game with default config: a restore rebuilds the config, so
    // the per-test overrides above would make the two games diverge.
    const g = await setup("plains", { instantBuild: true }, [
      new PlayerInfo("q", PlayerType.Human, null, "q"),
    ]);
    const q = g.player("q");
    for (let x = 0; x < 20; x++)
      for (let y = 0; y < 20; y++) q.conquer(g.ref(x, y));
    q.addGold(1_000_000n);
    g.addExecution(
      new ConstructionExecution(q, UnitType.CivicCenter, g.ref(10, 10)),
    );
    executeTicks(g, 3);
    const [center] = q.units(UnitType.CivicCenter);
    q.removeGold(q.gold());
    executeTicks(g, g.config().civicCenterUpkeepInterval() * 2 + 1);
    expect(center.hasStatus(UnitStatus.NoFunds)).toBe(true);
    await expectSnapshotRoundTrip(g, "plains", 60);
  });
});
