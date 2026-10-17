import {
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { ConstructionExecution } from "@openfront/engine/execution/ConstructionExecution";
import { DeleteUnitExecution } from "@openfront/engine/execution/DeleteUnitExecution";
import { TankExecution } from "@openfront/engine/execution/TankExecution";
import { Game, Player, Unit } from "@openfront/engine/game/Game";
import { setup } from "./util/Setup";
import { executeTicks } from "./util/utils";

let game: Game;
let p1: Player;

function build(type: UnitType, x: number, y: number): Unit {
  game.addExecution(new ConstructionExecution(p1, type, game.ref(x, y)));
  executeTicks(game, 3);
  const units = p1.units(type);
  return units[units.length - 1];
}

// Deconstruct and wait out the deletion mark; returns gold gained.
function deconstruct(unit: Unit): bigint {
  const before = p1.gold();
  game.addExecution(new DeleteUnitExecution(p1, unit.id()));
  executeTicks(game, game.config().deletionMarkDuration() + 5);
  expect(unit.isActive()).toBe(false);
  return p1.gold() - before;
}

describe("Deconstruct (50% refund)", () => {
  beforeEach(async () => {
    game = await setup("plains", { instantBuild: true }, [
      new PlayerInfo("p1", PlayerType.Human, null, "p1"),
    ]);
    p1 = game.player("p1");
    for (let x = 0; x < 50; x++)
      for (let y = 0; y < 50; y++) p1.conquer(game.ref(x, y));
    game.config().goldAdditionRate = () => 0n; // isolate the refund
    game.config().deletionMarkDuration = () => 5;
    game.config().deleteUnitCooldown = () => 0;
    p1.addGold(20_000_000n);
    executeTicks(game, 1);
  });

  test("a building refunds half its price", () => {
    const city = build(UnitType.City, 10, 10);
    const paid = game.config().unitInfo(UnitType.City).cost(game, p1, -1);
    expect(deconstruct(city)).toBe(paid / 2n);
  });

  test("refund matches the newest unit's price when prices scale", () => {
    build(UnitType.City, 10, 10); // 125k
    const second = build(UnitType.City, 30, 10); // 250k
    expect(deconstruct(second)).toBe(125_000n);
  });

  test("a tank can be deconstructed for half its price", () => {
    build(UnitType.Factory, 25, 25);
    game.addExecution(
      new TankExecution({ owner: p1, targetTile: game.ref(28, 25) }),
    );
    executeTicks(game, 2);
    const [tank] = p1.units(UnitType.Tank);
    expect(tank).toBeDefined();
    expect(deconstruct(tank)).toBe(150_000n);
  });

  test("no refund when the unit cost nothing (infinite gold)", async () => {
    game = await setup("plains", { instantBuild: true, infiniteGold: true }, [
      new PlayerInfo("p1", PlayerType.Human, null, "p1"),
    ]);
    p1 = game.player("p1");
    for (let x = 0; x < 20; x++)
      for (let y = 0; y < 20; y++) p1.conquer(game.ref(x, y));
    game.config().goldAdditionRate = () => 0n;
    game.config().deletionMarkDuration = () => 5;
    game.config().deleteUnitCooldown = () => 0;
    executeTicks(game, 1);
    const city = build(UnitType.City, 10, 10);
    expect(deconstruct(city)).toBe(0n);
  });
});
