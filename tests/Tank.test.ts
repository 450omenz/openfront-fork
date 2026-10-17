import {
  PlayerInfo,
  PlayerType,
  TerrainType,
  UnitStatus,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { GameConfig } from "@openfront/engine-api/Schemas";
import {
  AttackLogicInput,
  EngineConfig,
} from "@openfront/engine/configuration/EngineConfig";
import { AttackExecution } from "@openfront/engine/execution/AttackExecution";
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

  test("a diagonal order drives a staircase, not an L", () => {
    const tank = buildTank(p1, 10, 50);
    game.addExecution(
      new MoveWarshipExecution(p1, [tank.id()], game.ref(20, 60)),
    );
    let maxRun = 0;
    let run = 0;
    let lastDir = "";
    let prev = tank.tile();
    for (let i = 0; i < 60; i++) {
      game.executeNextTick();
      const cur = tank.tile();
      if (cur === prev) continue;
      const dir = game.x(cur) !== game.x(prev) ? "x" : "y";
      run = dir === lastDir ? run + 1 : 1;
      lastDir = dir;
      maxRun = Math.max(maxRun, run);
      prev = cur;
    }
    expect(tank.tile()).toBe(game.ref(20, 60));
    // An L would be one 10-tile run each way.
    expect(maxRun).toBeLessThanOrEqual(2);
  });

  test("an order to the tile it is on completes at once", () => {
    const tank = buildTank(p1, 10, 50);
    executeTicks(game, 2);
    game.addExecution(new MoveWarshipExecution(p1, [tank.id()], tank.tile()));
    executeTicks(game, 3);
    expect(tank.targetTile()).toBeUndefined();
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

  test("repairs a route cut mid-drive", () => {
    const tank = buildTank(p1, 10, 50);
    game.addExecution(
      new MoveWarshipExecution(p1, [tank.id()], game.ref(10, 80)),
    );
    executeTicks(game, 6);
    // Cut the straight road ahead of it.
    for (let x = 5; x <= 15; x++) p2.conquer(game.ref(x, 65));
    executeTicks(game, 120);
    expect(tank.tile()).toBe(game.ref(10, 80));
  });

  test("an unreachable order stops the tank", () => {
    const tank = buildTank(p1, 10, 50);
    executeTicks(game, 2);
    // Wall off a p1 pocket the tank can't drive into.
    for (let x = 30; x <= 36; x++)
      for (let y = 30; y <= 36; y++)
        if (x === 30 || x === 36 || y === 30 || y === 36)
          p2.conquer(game.ref(x, y));
    const before = tank.tile();
    tank.setTargetTile(game.ref(33, 33));
    executeTicks(game, 5);
    expect(tank.targetTile()).toBeUndefined();
    expect(tank.tile()).toBe(before);
  });

  test("an idle tank backs off before its ground is taken", () => {
    const tank = buildTank(p1, 10, 50);
    tank.move(game.ref(49, 50));
    tank.setTargetTile(undefined);
    p1.addTroops(1_000_000);
    p2.addTroops(1_000_000);
    game.addExecution(new AttackExecution(30_000, p2, p1.id(), null));
    executeTicks(game, 40);
    expect(tank.isActive()).toBe(true);
    expect(game.x(tank.tile())).toBeLessThan(49);
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

    test("a defender's tank makes the tile bloodier and slower", () => {
      const plain = real.attackLogic(input({}));
      const def = real.attackLogic(input({ defenderHasTankSupport: true }));
      expect(def.attackerTroopLoss).toBeGreaterThan(plain.attackerTroopLoss);
      expect(def.tickFraction).toBeGreaterThan(plain.tickFraction);
    });

    test("tanks on both sides cancel out", () => {
      const plain = real.attackLogic(input({}));
      const both = real.attackLogic(
        input({ attackerHasTankSupport: true, defenderHasTankSupport: true }),
      );
      expect(both).toEqual(plain);
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

  test("flags SupportingAttack while its aura boosts an attack", () => {
    // The rear tank must stay in the rear.
    game.config().tankAutoFront = () => false;
    const front = buildTank(p1, 10, 50);
    front.move(game.ref(47, 50)); // 3 tiles from the border at x = 50
    front.setTargetTile(undefined);
    const rear = buildTank(p1, 12, 50); // ~38 tiles behind the front
    rear.setTargetTile(undefined);
    executeTicks(game, 2);
    expect(front.hasStatus(UnitStatus.SupportingAttack)).toBe(false);

    p1.addTroops(1_000_000);
    p2.addTroops(1_000);
    game.addExecution(new AttackExecution(500_000, p1, p2.id(), null));
    // The front spans the whole border; the tank lights up whenever tiles
    // inside its aura are taken.
    let frontLit = false;
    let rearLit = false;
    for (let i = 0; i < 80; i++) {
      game.executeNextTick();
      frontLit ||= front.hasStatus(UnitStatus.SupportingAttack);
      rearLit ||= rear.hasStatus(UnitStatus.SupportingAttack);
    }
    expect(frontLit).toBe(true);
    expect(rearLit).toBe(false);

    // Once the attack is over the flag times out.
    for (const a of p1.outgoingAttacks()) a.delete();
    executeTicks(game, game.config().tankSupportFlagTicks() + 5);
    expect(front.hasStatus(UnitStatus.SupportingAttack)).toBe(false);
  });

  describe("auto-deploy to the front", () => {
    function attackP2() {
      p1.addTroops(1_000_000);
      p2.addTroops(1_000_000);
      // Small attack: a long-lived front that barely moves.
      game.addExecution(new AttackExecution(20_000, p1, p2.id(), null));
    }

    function distToFront(tank: Unit): number {
      let best = Infinity;
      for (const a of p1.outgoingAttacks())
        for (const t of a.borderTiles())
          best = Math.min(best, game.manhattanDist(tank.tile(), t));
      return best;
    }

    function idleTank(x: number, y: number): Unit {
      const tank = buildTank(p1, x, y);
      tank.setTargetTile(undefined);
      return tank;
    }

    test("an idle tank drives to the front", () => {
      const tank = idleTank(10, 50);
      attackP2();
      executeTicks(game, 150);
      expect(distToFront(tank)).toBeLessThanOrEqual(
        game.config().tankAuraRange(),
      );
      expect(tank.hasStatus(UnitStatus.SupportingAttack)).toBe(true);
    });

    test("stays home when there is no front", () => {
      const tank = idleTank(10, 50);
      executeTicks(game, 100);
      expect(tank.tile()).toBe(game.ref(10, 50));
    });

    test("attacks on unclaimed land are not a front", async () => {
      const g = await setup("plains", { infiniteGold: true }, [
        new PlayerInfo("a", PlayerType.Human, null, "a"),
      ]);
      const a = g.player("a");
      for (let x = 0; x < 30; x++)
        for (let y = 0; y < 100; y++) a.conquer(g.ref(x, y));
      a.buildUnit(UnitType.Factory, g.ref(10, 50), {});
      g.addExecution(
        new TankExecution({ owner: a, targetTile: g.ref(10, 50) }),
      );
      g.executeNextTick();
      const [tank] = a.units(UnitType.Tank);
      a.addTroops(1_000_000);
      g.addExecution(new AttackExecution(20_000, a, null, null));
      for (let i = 0; i < 100; i++) g.executeNextTick();
      expect(tank.tile()).toBe(g.ref(10, 50));
    });

    test("a player's order wins, then the tank holds", () => {
      const tank = idleTank(10, 50);
      attackP2();
      executeTicks(game, 3);
      game.addExecution(
        new MoveWarshipExecution(p1, [tank.id()], game.ref(5, 20)),
      );
      executeTicks(game, 140);
      expect(tank.tile()).toBe(game.ref(5, 20));
      // Still holding well inside the hold window.
      executeTicks(game, game.config().tankManualHoldTicks() / 2);
      expect(tank.tile()).toBe(game.ref(5, 20));
      // Hold over: back to the front.
      executeTicks(game, game.config().tankManualHoldTicks() + 200);
      expect(distToFront(tank)).toBeLessThanOrEqual(
        game.config().tankAuraRange(),
      );
    });

    test("tanks spread out along the front", () => {
      const tanks = [idleTank(10, 50), idleTank(11, 50), idleTank(12, 50)];
      attackP2();
      executeTicks(game, 200);
      const ys = tanks.map((t) => game.y(t.tile()));
      for (let i = 0; i < ys.length; i++)
        for (let j = i + 1; j < ys.length; j++) {
          const d = game.euclideanDistSquared(tanks[i].tile(), tanks[j].tile());
          expect(d).toBeGreaterThan(4 * 4);
        }
    });

    test("can be turned off", () => {
      game.config().tankAutoFront = () => false;
      const tank = idleTank(10, 50);
      attackP2();
      executeTicks(game, 150);
      expect(tank.tile()).toBe(game.ref(10, 50));
    });

    test("survives a snapshot round trip while deploying", async () => {
      idleTank(10, 50);
      attackP2();
      executeTicks(game, 30);
      await expectSnapshotRoundTrip(game, "plains", 60);
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
