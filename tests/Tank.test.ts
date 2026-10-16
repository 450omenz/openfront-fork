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
import { ConstructionExecution } from "@openfront/engine/execution/ConstructionExecution";
import { MoveWarshipExecution } from "@openfront/engine/execution/MoveWarshipExecution";
import { TankExecution } from "@openfront/engine/execution/TankExecution";
import { Game, Player, Unit } from "@openfront/engine/game/Game";
import { setup } from "./util/Setup";
import { expectSnapshotRoundTrip } from "./util/Snapshot";
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
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) p.conquer(game.ref(x, y));
  }
}

function buildTank(owner: Player, x: number, y: number): Unit {
  game.addExecution(new TankExecution({ owner, targetTile: game.ref(x, y) }));
  game.executeNextTick(); // init builds the tank
  const tanks = owner.units(UnitType.Tank);
  return tanks[tanks.length - 1];
}

describe("Tank", () => {
  beforeEach(async () => {
    game = await setup("plains", { infiniteGold: true, instantBuild: true }, [
      new PlayerInfo("p1", PlayerType.Human, null, "p1"),
      new PlayerInfo("p2", PlayerType.Human, null, "p2"),
    ]);
    p1 = game.player("p1");
    p2 = game.player("p2");
    // p1 owns the west half, p2 the east half.
    conquerRect(p1, 0, 0, 49, 99);
    conquerRect(p2, 50, 0, 99, 99);
    p1.buildUnit(UnitType.Factory, game.ref(10, 50), {});
  });

  test("needs a nearby factory and owned land", () => {
    expect(p1.canBuild(UnitType.Tank, game.ref(15, 50))).toBe(game.ref(10, 50));
    // Too far from any factory.
    expect(p1.canBuild(UnitType.Tank, game.ref(10, 99))).toBe(false);
    // Not p1's land.
    expect(p1.canBuild(UnitType.Tank, game.ref(55, 50))).toBe(false);
    // p2 has no factory.
    expect(p2.canBuild(UnitType.Tank, game.ref(60, 50))).toBe(false);
  });

  test("build intent spawns a tank that drives to the clicked tile", () => {
    game.addExecution(
      new ConstructionExecution(p1, UnitType.Tank, game.ref(20, 50)),
    );
    executeTicks(game, 3);
    const [tank] = p1.units(UnitType.Tank);
    expect(tank).toBeDefined();
    expect(tank.health()).toBe(700);
    // 10 tiles at one tile per 2 ticks.
    executeTicks(game, 25);
    expect(tank.tile()).toBe(game.ref(20, 50));
    expect(tank.targetTile()).toBeUndefined();
  });

  test("move order re-routes; enemy land is not a valid destination", () => {
    const tank = buildTank(p1, 10, 50);
    game.addExecution(
      new MoveWarshipExecution(p1, [tank.id()], game.ref(10, 60)),
    );
    executeTicks(game, 25);
    expect(tank.tile()).toBe(game.ref(10, 60));

    game.addExecution(
      new MoveWarshipExecution(p1, [tank.id()], game.ref(70, 60)),
    );
    executeTicks(game, 10);
    expect(tank.tile()).toBe(game.ref(10, 60));
  });

  test("drives around land it does not own", () => {
    // Carve a p2 wall across p1's land with a gap at y >= 85 (inside the
    // pathfinder's 40-tile detour margin).
    for (let y = 0; y < 85; y++) p2.conquer(game.ref(30, y));
    const tank = buildTank(p1, 10, 50);
    game.addExecution(
      new MoveWarshipExecution(p1, [tank.id()], game.ref(40, 50)),
    );
    let crossedWall = false;
    for (let i = 0; i < 300; i++) {
      game.executeNextTick();
      if (game.x(tank.tile()) === 30) {
        expect(game.y(tank.tile())).toBeGreaterThanOrEqual(85);
        crossedWall = true;
      }
    }
    expect(crossedWall).toBe(true);
    expect(tank.tile()).toBe(game.ref(40, 50));
  });

  test("is destroyed when its tile is overrun", () => {
    const tank = buildTank(p1, 10, 50);
    p2.conquer(tank.tile());
    executeTicks(game, 2);
    expect(tank.isActive()).toBe(false);
  });

  test("shells a hostile tank in range", () => {
    p2.buildUnit(UnitType.Factory, game.ref(55, 50), {});
    const mine = buildTank(p1, 10, 50);
    const theirs = buildTank(p2, 55, 50);
    mine.move(game.ref(47, 50));
    theirs.move(game.ref(52, 50)); // 5 tiles apart, inside range 8
    mine.setTargetTile(undefined);
    theirs.setTargetTile(undefined);
    executeTicks(game, 60);
    expect(mine.health()).toBeLessThan(700);
    expect(theirs.health()).toBeLessThan(700);
  });

  test("ignores tanks out of range", () => {
    p2.buildUnit(UnitType.Factory, game.ref(80, 50), {});
    const mine = buildTank(p1, 10, 50);
    buildTank(p2, 80, 50);
    executeTicks(game, 60);
    expect(mine.health()).toBe(700);
  });

  test("cost starts at 300k and rises 150k per tank, capped at 1.2M", async () => {
    const paid = await setup("plains", {}, [
      new PlayerInfo("a", PlayerType.Human, null, "a"),
    ]);
    const a = paid.player("a");
    const cost = paid.config().unitInfo(UnitType.Tank).cost;
    expect(cost(paid, a)).toBe(300_000n);
    expect(cost(paid, a, 1)).toBe(450_000n);
    expect(cost(paid, a, 10)).toBe(1_200_000n);
  });

  test("each tank costs 2% of worker gold income", () => {
    const base = game.config().goldAdditionRate(p1);
    buildTank(p1, 10, 50);
    buildTank(p1, 12, 50);
    expect(game.config().goldAdditionRate(p1)).toBe((base * 96n) / 100n);
  });

  describe("spearhead aura in attackLogic", () => {
    // TestConfig stubs attackLogic; use the real rules (as the golden test does).
    const real = new EngineConfig({} as GameConfig, false);
    const input = (over: Partial<AttackLogicInput>): AttackLogicInput => ({
      terrain: TerrainType.Plains,
      attackTroops: 10_000,
      attacker: { type: PlayerType.Human, numTiles: 1000 },
      defender: {
        type: PlayerType.Human,
        numTiles: 1000,
        troops: 10_000,
        isTraitor: false,
        isDisconnectedTeammate: false,
      },
      defenderHasDefensePost: false,
      falloutRatio: null,
      borderSize: 50,
      ...over,
    });

    test("cheaper and faster with tank support", () => {
      const plain = real.attackLogic(input({}));
      const tank = real.attackLogic(input({ attackerHasTankSupport: true }));
      expect(tank.attackerTroopLoss).toBeLessThan(plain.attackerTroopLoss);
      expect(tank.tickFraction).toBeLessThan(plain.tickFraction);
    });

    test("cancels the defense post bonus", () => {
      const post = real.attackLogic(input({ defenderHasDefensePost: true }));
      const postWithTank = real.attackLogic(
        input({ defenderHasDefensePost: true, attackerHasTankSupport: true }),
      );
      const tankOnly = real.attackLogic(
        input({ attackerHasTankSupport: true }),
      );
      expect(postWithTank).toEqual(tankOnly);
      expect(postWithTank.attackerTroopLoss).toBeLessThan(
        post.attackerTroopLoss,
      );
    });
  });

  test("survives a snapshot round trip mid-drive", async () => {
    const tank = buildTank(p1, 10, 50);
    game.addExecution(
      new MoveWarshipExecution(p1, [tank.id()], game.ref(10, 80)),
    );
    executeTicks(game, 5);
    await expectSnapshotRoundTrip(game, "plains", 40);
  });
});
