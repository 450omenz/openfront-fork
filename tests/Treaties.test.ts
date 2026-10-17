import {
  Archetype,
  PlayerInfo,
  PlayerType,
  Relation,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { AttackExecution } from "@openfront/engine/execution/AttackExecution";
import { CoalitionExecution } from "@openfront/engine/execution/coalition/CoalitionExecution";
import { PactExecution } from "@openfront/engine/execution/coalition/PactExecution";
import {
  desiredBans,
  NationCoalitionBehavior,
} from "@openfront/engine/execution/nation/NationCoalitionBehavior";
import { NationEmojiBehavior } from "@openfront/engine/execution/nation/NationEmojiBehavior";
import { NationPactBehavior } from "@openfront/engine/execution/nation/NationPactBehavior";
import {
  respectsPact,
  respectsWeaponBan,
} from "@openfront/engine/execution/nation/NationTreaties";
import { NukeExecution } from "@openfront/engine/execution/NukeExecution";
import { AiAttackBehavior } from "@openfront/engine/execution/utils/AiAttackBehavior";
import { Game, Player } from "@openfront/engine/game/Game";
import {
  NEUTRAL,
  Personality,
  setPersonality,
} from "@openfront/engine/game/NationPersonality";
import { setup } from "./util/Setup";
import { expectSnapshotRoundTrip } from "./util/Snapshot";
import { executeTicks } from "./util/utils";

let game: Game;
let a: Player; // north-west
let b: Player; // north-east
let c: Player; // south-west
let d: Player; // south-east

function personality(over: Partial<Personality>): Personality {
  return { ...NEUTRAL, archetype: Archetype.Balanced, ...over };
}

async function newGame(types: PlayerType[] = []) {
  const t = (i: number) => types[i] ?? PlayerType.Human;
  game = await setup("plains", { infiniteGold: true, instantBuild: true }, [
    new PlayerInfo("a", t(0), t(0) === PlayerType.Human ? "ca" : null, "a"),
    new PlayerInfo("b", t(1), t(1) === PlayerType.Human ? "cb" : null, "b"),
    new PlayerInfo("c", t(2), t(2) === PlayerType.Human ? "cc" : null, "c"),
    new PlayerInfo("d", t(3), t(3) === PlayerType.Human ? "cd" : null, "d"),
  ]);
  [a, b, c, d] = ["a", "b", "c", "d"].map((id) => game.player(id));
  const own = (p: Player, x0: number, y0: number) => {
    for (let x = x0; x < x0 + 50; x++)
      for (let y = y0; y < y0 + 50; y++) p.conquer(game.ref(x, y));
  };
  own(a, 0, 0);
  own(b, 50, 0);
  own(c, 0, 50);
  own(d, 50, 50);
  for (const p of [a, b, c, d]) p.addTroops(100_000);
  // Early-game immunity would block the attacks these tests make.
  game.config().spawnImmunityDuration = () => 0;
  game.config().nationSpawnImmunityDuration = () => 0;
}

// a leads a coalition with b.
function pactAB() {
  const coalition = game.coalitions().create(a, "Pact")!;
  game.coalitions().invite(a, b);
  game.coalitions().reply(b, coalition.id(), true);
  return coalition;
}

describe("coalition weapon bans", () => {
  beforeEach(async () => newGame());

  test("members can't build a banned weapon; outsiders still can", () => {
    pactAB();
    b.buildUnit(UnitType.MissileSilo, game.ref(60, 10), {});
    d.buildUnit(UnitType.MissileSilo, game.ref(60, 60), {});
    expect(b.canBuild(UnitType.HydrogenBomb, game.ref(10, 60))).not.toBe(false);
    game.addExecution(
      new CoalitionExecution(a, {
        kind: "ban",
        weapon: UnitType.HydrogenBomb,
        on: true,
      }),
    );
    game.executeNextTick();
    expect(
      game.coalitions().of(a)!.bannedWeapons().has(UnitType.HydrogenBomb),
    ).toBe(true);
    expect(b.canBuild(UnitType.HydrogenBomb, game.ref(10, 60))).toBe(false);
    expect(b.canBuild(UnitType.AtomBomb, game.ref(10, 60))).not.toBe(false);
    expect(d.canBuild(UnitType.HydrogenBomb, game.ref(10, 60))).not.toBe(false);
  });

  test("only the leader bans, and only bannable weapons", () => {
    const coalition = pactAB();
    expect(game.coalitions().setWeaponBan(b, UnitType.Tank, true)).toBe(false);
    expect(game.coalitions().setWeaponBan(a, UnitType.City, true)).toBe(false);
    expect(coalition.bannedWeapons().size).toBe(0);
  });

  test("an outsider who nukes a member with a banned bomb is sanctioned", () => {
    game.config().nukeAllianceBreakThreshold = () => 0;
    const coalition = pactAB();
    game.coalitions().setWeaponBan(a, UnitType.AtomBomb, true);
    d.buildUnit(UnitType.MissileSilo, game.ref(60, 60), {});
    game.addExecution(
      new NukeExecution(UnitType.AtomBomb, d, game.ref(70, 20), null),
    );
    executeTicks(game, 3);
    expect(coalition.violators().has(d)).toBe(true);
    expect(coalition.sanctions().has(d)).toBe(true);
    expect(b.canTrade(d)).toBe(false);
    expect(a.relation(d)).toBeLessThan(Relation.Neutral);
  });

  test("an allowed weapon is no violation", () => {
    game.config().nukeAllianceBreakThreshold = () => 0;
    const coalition = pactAB();
    game.coalitions().setWeaponBan(a, UnitType.HydrogenBomb, true);
    d.buildUnit(UnitType.MissileSilo, game.ref(60, 60), {});
    game.addExecution(
      new NukeExecution(UnitType.AtomBomb, d, game.ref(70, 20), null),
    );
    executeTicks(game, 3);
    expect(coalition.violators().size).toBe(0);
  });
});

describe("nations and weapon bans", () => {
  beforeEach(async () =>
    newGame([PlayerType.Nation, PlayerType.Nation, PlayerType.Human]),
  );

  test("a leader bans by temperament", () => {
    setPersonality(a, personality({ caution: 80 }));
    expect([...desiredBans(a)].sort()).toEqual(
      [UnitType.AtomBomb, UnitType.HydrogenBomb, UnitType.MIRV].sort(),
    );
    setPersonality(a, personality({ aggression: 20 }));
    expect(desiredBans(a).has(UnitType.Tank)).toBe(true);
    setPersonality(a, personality({ aggression: 85, caution: 90 }));
    expect(desiredBans(a).size).toBe(0);
  });

  test("a cautious nation leader applies its bans", () => {
    setPersonality(a, personality({ caution: 70 }));
    setPersonality(b, personality({ loyalty: 90 }));
    const coalition = pactAB();
    new NationCoalitionBehavior(game, a).handleCoalitions();
    expect(coalition.bannedWeapons().has(UnitType.MIRV)).toBe(true);
  });

  test("a warlike member with tanks walks out over a tank ban", () => {
    setPersonality(a, personality({ aggression: 20 }));
    setPersonality(b, personality({ aggression: 85, loyalty: 30 }));
    const coalition = pactAB();
    b.buildUnit(UnitType.Tank, game.ref(60, 10), {});
    new NationCoalitionBehavior(game, a).handleCoalitions();
    expect(coalition.bannedWeapons().has(UnitType.Tank)).toBe(true);
    new NationCoalitionBehavior(game, b).handleCoalitions();
    expect(coalition.has(b)).toBe(false);
  });

  test("outsiders hold back unless they're aggressive", () => {
    pactAB();
    game.coalitions().setWeaponBan(a, UnitType.HydrogenBomb, true);
    setPersonality(c, personality({}));
    expect(respectsWeaponBan(c, b, UnitType.HydrogenBomb)).toBe(true);
    expect(respectsWeaponBan(c, b, UnitType.AtomBomb)).toBe(false);
    setPersonality(c, personality({ aggression: 90 }));
    expect(respectsWeaponBan(c, b, UnitType.HydrogenBomb)).toBe(false);
  });
});

describe("non-aggression pacts", () => {
  beforeEach(async () => newGame());

  function sign(minutes = 5) {
    game.addExecution(
      new PactExecution(a, { kind: "propose", other: b.id(), minutes }),
    );
    game.executeNextTick();
    game.addExecution(
      new PactExecution(b, { kind: "reply", other: a.id(), accept: true }),
    );
    game.executeNextTick();
  }

  test("sign one for a while; it runs out", () => {
    sign(5);
    const pact = game.pacts().between(b, a)!;
    expect(pact).not.toBeNull();
    expect(pact.expiresAt - pact.createdAt).toBe(5 * 60 * 10);
    expect(a.isFriendly(b)).toBe(false); // peace, not friendship
    executeTicks(game, 5 * 60 * 10);
    expect(game.pacts().between(a, b)).toBeNull();
    expect(a.isTraitor()).toBe(false);
  });

  test("only the offered lengths", () => {
    expect(game.pacts().propose(a, b, 7)).toBe(false);
  });

  test("attacking a partner breaks the pact: traitor", () => {
    sign();
    game.addExecution(new AttackExecution(10_000, a, b.id(), null));
    executeTicks(game, 2);
    expect(game.pacts().between(a, b)).toBeNull();
    expect(a.isTraitor()).toBe(true);
    expect(b.relation(a)).toBe(Relation.Hostile);
    expect(b.isTraitor()).toBe(false);
  });

  test("breaking one on purpose costs the same", () => {
    sign();
    game.addExecution(new PactExecution(b, { kind: "break", other: a.id() }));
    game.executeNextTick();
    expect(game.pacts().between(a, b)).toBeNull();
    expect(b.isTraitor()).toBe(true);
  });

  test("a refusal makes the proposer wait before asking again", () => {
    game.pacts().propose(a, b, 10);
    game.pacts().reply(b, a, false);
    expect(game.pacts().canPropose(a, b)).toBe(false);
    expect(game.pacts().canPropose(b, a)).toBe(true);
    executeTicks(game, 2 * 60 * 10);
    expect(game.pacts().canPropose(a, b)).toBe(true);
  });

  test("friends don't need one", () => {
    const coalition = pactAB();
    expect(coalition.has(b)).toBe(true);
    expect(game.pacts().canPropose(a, b)).toBe(false);
  });

  test("survives a snapshot round trip, with bans", async () => {
    sign(20);
    game.pacts().propose(c, d, 10);
    game.pacts().propose(c, b, 5);
    game.pacts().reply(b, c, false);
    const coalition = game.coalitions().create(c, "South")!;
    game.coalitions().invite(c, d);
    game.coalitions().reply(d, coalition.id(), true);
    game.coalitions().setWeaponBan(c, UnitType.Tank, true);
    await expectSnapshotRoundTrip(game, "plains", 10);
  });
});

describe("nations and pacts", () => {
  beforeEach(async () =>
    newGame([PlayerType.Nation, PlayerType.Nation, PlayerType.Human]),
  );

  test("accepts a stronger neighbor, refuses a hated one", () => {
    setPersonality(a, personality({}));
    b.addTroops(500_000);
    expect(new NationPactBehavior(game, a).wantsPact(b)).toBe(true);
    a.updateRelation(b, -100);
    expect(new NationPactBehavior(game, a).wantsPact(b)).toBe(false);
  });

  test("a greedy aggressor won't promise peace to easy prey", () => {
    setPersonality(a, personality({ aggression: 90 }));
    a.addTroops(1_000_000);
    expect(new NationPactBehavior(game, a).wantsPact(c)).toBe(false);
  });

  test("a cautious nation asks its strongest neighbor for a pact", () => {
    setPersonality(a, personality({ caution: 85 }));
    b.addTroops(500_000);
    new NationPactBehavior(game, a).handlePacts();
    const proposals = game.pacts().proposalsFor(b);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].minutes).toBe(20);
  });

  test("nations keep their word, except a disloyal backstabber", () => {
    setPersonality(a, personality({}));
    game.pacts().propose(a, c, 10);
    game.pacts().reply(c, a, true);
    expect(respectsPact(game, a, c)).toBe(true);
    const random = new PseudoRandom(1);
    const attack = new AiAttackBehavior(
      random,
      game,
      a,
      0.5,
      0.3,
      0.1,
      undefined,
      new NationEmojiBehavior(random, game, a),
    );
    a.addTroops(1_000_000);
    expect(attack.sendAttack(c)).toBe(false);
    setPersonality(a, personality({ loyalty: 10 }));
    expect(respectsPact(game, a, c)).toBe(false);
    expect(attack.sendAttack(c)).toBe(true);
    executeTicks(game, 2);
    expect(a.isTraitor()).toBe(true);
  });
});
