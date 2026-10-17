import {
  PlayerInfo,
  PlayerType,
  UnitStatus,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { AttackExecution } from "@openfront/engine/execution/AttackExecution";
import { ConstructionExecution } from "@openfront/engine/execution/ConstructionExecution";
import { PlayerExecution } from "@openfront/engine/execution/PlayerExecution";
import { RetreatExecution } from "@openfront/engine/execution/RetreatExecution";
import { UpgradeStructureExecution } from "@openfront/engine/execution/UpgradeStructureExecution";
import { Game, Player, Unit } from "@openfront/engine/game/Game";
import { trainingLevel } from "@openfront/engine/game/Military";
import { setup } from "./util/Setup";
import { expectSnapshotRoundTrip } from "./util/Snapshot";
import { executeTicks } from "./util/utils";

let game: Game;
let p1: Player;
let p2: Player;

function build(owner: Player, x: number, y: number): Unit {
  game.addExecution(
    new ConstructionExecution(owner, UnitType.MilitaryBase, game.ref(x, y)),
  );
  executeTicks(game, 3);
  const bases = owner.units(UnitType.MilitaryBase);
  return bases[bases.length - 1];
}

describe("Military Base", () => {
  beforeEach(async () => {
    game = await setup("plains", { instantBuild: true }, [
      new PlayerInfo("p1", PlayerType.Human, null, "p1"),
      new PlayerInfo("p2", PlayerType.Human, null, "p2"),
    ]);
    p1 = game.player("p1");
    p2 = game.player("p2");
    for (let x = 0; x < 40; x++)
      for (let y = 0; y < 40; y++) p1.conquer(game.ref(x, y));
    for (let x = 40; x < 80; x++)
      for (let y = 0; y < 40; y++) p2.conquer(game.ref(x, y));
    // Isolate training from regen and income.
    game.config().troopIncreaseRate = () => 0;
    game.config().goldAdditionRate = () => 0n;
    p1.addGold(100_000_000n);
    p2.addGold(100_000_000n);
    p1.setTroops(100_000);
    p2.setTroops(100_000);
    // Training runs in each player's PlayerExecution.
    game.addExecution(new PlayerExecution(p1));
    game.addExecution(new PlayerExecution(p2));
  });

  test("trains troops up to the level cap", () => {
    build(p1, 10, 10);
    expect(game.config().workingMilitaryBases(p1)).toBe(1);
    expect(p1.trainedTroops()).toBe(0);
    executeTicks(game, 50);
    expect(p1.trainedTroops()).toBeGreaterThan(0);
    executeTicks(game, 1_000);
    const cap = game.config().trainedCap(1);
    expect(p1.trainedShare()).toBeCloseTo(cap, 2);
    expect(p1.trainedShare()).toBeLessThanOrEqual(cap);
  });

  test("stacking raises the training level and the cap", () => {
    const base = build(p1, 10, 10);
    game.addExecution(new UpgradeStructureExecution(p1, base.id()));
    executeTicks(game, 3);
    expect(base.level()).toBe(2);
    expect(trainingLevel(game, p1)).toBe(2);
    executeTicks(game, 2_000);
    expect(p1.trainedShare()).toBeCloseTo(game.config().trainedCap(2), 2);
    expect(game.config().trainedCap(2)).toBeGreaterThan(
      game.config().trainedCap(1),
    );
  });

  test("losses take trained troops in proportion", () => {
    build(p1, 10, 10);
    executeTicks(game, 1_000);
    const share = p1.trainedShare();
    p1.removeTroops(40_000);
    expect(p1.trainedShare()).toBeCloseTo(share, 3);
    expect(p1.trainedTroops()).toBeLessThanOrEqual(p1.troops());
  });

  test("a base that can't pay upkeep stops training and the pool shrinks", () => {
    game.config().militaryBaseUpkeepInterval = () => 5;
    const base = build(p1, 10, 10);
    executeTicks(game, 1_000);
    expect(p1.trainedTroops()).toBeGreaterThan(0);
    p1.removeGold(p1.gold());
    executeTicks(game, 30);
    expect(base.hasStatus(UnitStatus.NoFunds)).toBe(true);
    expect(trainingLevel(game, p1)).toBe(0);
  });

  test("allies that border you lend half their training level", () => {
    build(p2, 50, 10);
    expect(trainingLevel(game, p1)).toBe(0);
    p1.createAllianceRequest(p2)?.accept();
    expect(p1.isAlliedWith(p2)).toBe(true);
    expect(trainingLevel(game, p1)).toBeCloseTo(
      game.config().allyTrainingShare(),
      5,
    );
  });

  test("retreating attack brings trained troops home trained", () => {
    build(p1, 10, 10);
    executeTicks(game, 1_000);
    const share = p1.trainedShare();
    const exec = new AttackExecution(20_000, p1, p2.id());
    game.addExecution(exec);
    executeTicks(game, 2);
    const attack = p1.outgoingAttacks()[0];
    expect(attack).toBeDefined();
    game.addExecution(new RetreatExecution(p1, attack.id()));
    executeTicks(game, 200);
    expect(p1.outgoingAttacks()).toHaveLength(0);
    // Combat and the retreat malus cost troops, but the share holds.
    expect(p1.trainedShare()).toBeGreaterThan(share * 0.8);
  });

  test("trained troops and entrenchment survive a snapshot", async () => {
    // A fresh game: the config overrides above aren't part of a snapshot.
    const g = await setup("plains", { instantBuild: true }, [
      new PlayerInfo("q", PlayerType.Human, null, "q"),
    ]);
    const q = g.player("q");
    for (let x = 0; x < 30; x++)
      for (let y = 0; y < 30; y++) q.conquer(g.ref(x, y));
    q.addGold(10_000_000n);
    q.setTroops(100_000);
    g.addExecution(new PlayerExecution(q));
    g.addExecution(
      new ConstructionExecution(q, UnitType.MilitaryBase, g.ref(10, 10)),
    );
    executeTicks(g, 300);
    expect(q.trainedTroops()).toBeGreaterThan(0);
    const restored = await expectSnapshotRoundTrip(g, "plains", 30);
    expect(restored.player("q").trainedTroops()).toBe(q.trainedTroops());
    expect(restored.heldFor(g.ref(5, 5))).toBe(g.heldFor(g.ref(5, 5)));
  });
});
