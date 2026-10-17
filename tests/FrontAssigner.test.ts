import {
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { AttackExecution } from "@openfront/engine/execution/AttackExecution";
import { frontSlots } from "@openfront/engine/execution/behaviors/FrontMap";
import { TankExecution } from "@openfront/engine/execution/TankExecution";
import { Game, Player, Unit } from "@openfront/engine/game/Game";
import { AStarLandBounded } from "@openfront/engine/pathfinding/algorithms/AStar.LandBounded";
import { setup } from "./util/Setup";
import { expectSnapshotRoundTrip } from "./util/Snapshot";
import { executeTicks } from "./util/utils";

let game: Game;
let p1: Player;
let p2: Player;
let p3: Player;

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

function idleTank(owner: Player, x: number, y: number): Unit {
  game.addExecution(new TankExecution({ owner, targetTile: game.ref(x, y) }));
  game.executeNextTick();
  const tanks = owner.units(UnitType.Tank);
  const tank = tanks[tanks.length - 1];
  tank.setTargetTile(undefined);
  return tank;
}

function attack(from: Player, to: Player, troops = 20_000) {
  from.addTroops(1_000_000);
  to.addTroops(1_000_000);
  game.addExecution(new AttackExecution(troops, from, to.id(), null));
}

// Front tiles of p1's attacks within aura range of at least one tank.
function coverage(tanks: Unit[]): number {
  const aura = game.config().tankAuraRange();
  let total = 0;
  let hit = 0;
  for (const a of p1.outgoingAttacks())
    for (const t of a.borderTiles()) {
      total++;
      if (
        tanks.some((k) => game.euclideanDistSquared(k.tile(), t) <= aura * aura)
      )
        hit++;
    }
  return total === 0 ? 0 : hit / total;
}

describe("FrontAssigner", () => {
  beforeEach(async () => {
    game = await setup("plains", { infiniteGold: true, instantBuild: true }, [
      new PlayerInfo("p1", PlayerType.Human, null, "p1"),
      new PlayerInfo("p2", PlayerType.Human, null, "p2"),
      new PlayerInfo("p3", PlayerType.Human, null, "p3"),
    ]);
    p1 = game.player("p1");
    p2 = game.player("p2");
    p3 = game.player("p3");
    conquerRect(p1, 0, 0, 49, 99);
    conquerRect(p2, 50, 0, 99, 99);
    p1.buildUnit(UnitType.Factory, game.ref(10, 50), {});
  });

  test("tanks spread to cover the front instead of piling up", () => {
    const tanks = [
      idleTank(p1, 10, 50),
      idleTank(p1, 11, 50),
      idleTank(p1, 12, 50),
    ];
    attack(p1, p2);
    executeTicks(game, 300);
    const aura = game.config().tankAuraRange();
    for (let i = 0; i < tanks.length; i++)
      for (let j = i + 1; j < tanks.length; j++) {
        // Roughly an aura diameter apart: little overlap.
        expect(
          game.euclideanDistSquared(tanks[i].tile(), tanks[j].tile()),
        ).toBeGreaterThanOrEqual(1.5 * aura * (1.5 * aura));
      }
    // Three auras staged ~5 tiles back each cover ~18-20 tiles of a
    // 100-tile line.
    expect(coverage(tanks)).toBeGreaterThan(0.45);
  });

  test("stages behind the line, not on it", () => {
    const tank = idleTank(p1, 10, 50);
    attack(p1, p2);
    executeTicks(game, 200);
    let nearest = Infinity;
    for (const a of p1.outgoingAttacks())
      for (const t of a.borderTiles())
        nearest = Math.min(nearest, game.manhattanDist(tank.tile(), t));
    expect(nearest).toBeGreaterThan(1);
    expect(nearest).toBeLessThanOrEqual(game.config().tankAuraRange());
  });

  test("a tank defends against an incoming attack", () => {
    const tank = idleTank(p1, 10, 50);
    attack(p2, p1);
    executeTicks(game, 200);
    const front = p2.outgoingAttacks()[0];
    expect(front).toBeDefined();
    let nearest = Infinity;
    for (const t of front.borderTiles())
      nearest = Math.min(nearest, game.manhattanDist(tank.tile(), t));
    expect(nearest).toBeLessThanOrEqual(game.config().tankAuraRange());
  });

  test("splits tanks between two attacks", () => {
    // p3 holds a strip on p1's west side: a second front.
    conquerRect(p3, 0, 0, 4, 99);
    const tanks = [idleTank(p1, 25, 50), idleTank(p1, 26, 50)];
    attack(p1, p2);
    attack(p1, p3);
    executeTicks(game, 300);
    const xs = tanks.map((t) => game.x(t.tile())).sort((a, b) => a - b);
    expect(xs[0]).toBeLessThan(20); // west front
    expect(xs[1]).toBeGreaterThan(30); // east front
  });

  test("an unreachable front costs bounded searches and the tank stays", () => {
    // p3 cuts p1 in two: the tank's pocket (x < 20) can't reach x = 50.
    conquerRect(p3, 20, 0, 24, 99);
    const tank = idleTank(p1, 10, 50);
    const spy = vi.spyOn(AStarLandBounded.prototype, "findPath");
    attack(p1, p2);
    executeTicks(game, 200);
    spy.mockRestore();
    expect(tank.tile()).toBe(game.ref(10, 50));
    // Each failed slot is avoided for a while instead of retried every seek.
    const slots = frontSlots(game, p1).length;
    expect(spy.mock.calls.length).toBeLessThanOrEqual(slots + 2);
  });

  test("slot order is heaviest first, deterministic", () => {
    attack(p1, p2);
    executeTicks(game, 5);
    const slots = frontSlots(game, p1);
    expect(slots.length).toBeGreaterThan(3);
    for (let i = 1; i < slots.length; i++)
      expect(slots[i - 1].weight).toBeGreaterThanOrEqual(slots[i].weight);
  });

  test("survives a snapshot round trip while spreading", async () => {
    idleTank(p1, 10, 50);
    idleTank(p1, 11, 50);
    attack(p1, p2);
    executeTicks(game, 25);
    await expectSnapshotRoundTrip(game, "plains", 60);
  });
});
