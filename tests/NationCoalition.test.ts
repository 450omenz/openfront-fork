import {
  Archetype,
  PlayerInfo,
  PlayerType,
  Relation,
} from "@openfront/engine-api/game/GameTypes";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import {
  coalitionName,
  NationCoalitionBehavior,
} from "@openfront/engine/execution/nation/NationCoalitionBehavior";
import { NationEmojiBehavior } from "@openfront/engine/execution/nation/NationEmojiBehavior";
import { AiAttackBehavior } from "@openfront/engine/execution/utils/AiAttackBehavior";
import { Game, Player } from "@openfront/engine/game/Game";
import {
  NEUTRAL,
  Personality,
  setPersonality,
} from "@openfront/engine/game/NationPersonality";
import { setup } from "./util/Setup";
import { executeTicks } from "./util/utils";

let game: Game;
let n1: Player; // nation, north-west
let n2: Player; // nation, north-east
let h: Player; // human, south-west
let e: Player; // human, south-east

function personality(over: Partial<Personality>): Personality {
  return { ...NEUTRAL, archetype: Archetype.Balanced, ...over };
}

function befriend(a: Player, b: Player) {
  a.updateRelation(b, 100);
  b.updateRelation(a, 100);
}

function attackBehavior(p: Player) {
  const random = new PseudoRandom(1);
  return new AiAttackBehavior(
    random,
    game,
    p,
    0.5,
    0.3,
    0.1,
    undefined,
    new NationEmojiBehavior(random, game, p),
  );
}

function behavior(p: Player) {
  return new NationCoalitionBehavior(game, p);
}

describe("NationCoalitionBehavior", () => {
  beforeEach(async () => {
    game = await setup("plains", { infiniteGold: true }, [
      new PlayerInfo("n1", PlayerType.Nation, null, "n1"),
      new PlayerInfo("n2", PlayerType.Nation, null, "n2"),
      new PlayerInfo("h", PlayerType.Human, "ch", "h"),
      new PlayerInfo("e", PlayerType.Human, "ce", "e"),
    ]);
    [n1, n2, h, e] = ["n1", "n2", "h", "e"].map((id) => game.player(id));
    const own = (p: Player, x0: number, y0: number) => {
      for (let x = x0; x < x0 + 50; x++)
        for (let y = y0; y < y0 + 50; y++) p.conquer(game.ref(x, y));
    };
    own(n1, 0, 0);
    own(n2, 50, 0);
    own(h, 0, 50);
    own(e, 50, 50);
    for (const p of [n1, n2, h, e]) p.addTroops(50_000);
    setPersonality(n1, personality({}));
    setPersonality(n2, personality({}));
  });

  describe("invites", () => {
    test("joins a friend's coalition", () => {
      befriend(n1, h);
      const c = game.coalitions().create(h, "Pact")!;
      game.coalitions().invite(h, n1);
      behavior(n1).handleCoalitions();
      expect(c.has(n1)).toBe(true);
    });

    test("turns down a merely neutral inviter without a reason", () => {
      const c = game.coalitions().create(h, "Pact")!;
      game.coalitions().invite(h, n1);
      behavior(n1).handleCoalitions();
      expect(c.has(n1)).toBe(false);
      expect(game.coalitions().invitesFor(n1)).toHaveLength(0); // answered
    });

    test("a nation under attack joins a coalition that would defend it", () => {
      const c = game.coalitions().create(h, "Pact")!;
      e.addTroops(1_000_000);
      game.config().spawnImmunityDuration = () => 0;
      game.config().nationSpawnImmunityDuration = () => 0;
      e.createAttack(n1, 10_000, null, new Set());
      game.coalitions().invite(h, n1);
      behavior(n1).handleCoalitions();
      expect(c.has(n1)).toBe(true);
    });

    test("joins a clearly stronger coalition", () => {
      const c = game.coalitions().create(h, "Pact")!;
      h.addTroops(1_000_000);
      game.coalitions().invite(h, n1);
      behavior(n1).handleCoalitions();
      expect(c.has(n1)).toBe(true);
    });

    test("a loyal diplomat joins a neutral inviter", () => {
      setPersonality(
        n1,
        personality({ archetype: Archetype.Diplomat, loyalty: 90 }),
      );
      const c = game.coalitions().create(h, "Pact")!;
      game.coalitions().invite(h, n1);
      behavior(n1).handleCoalitions();
      expect(c.has(n1)).toBe(true);
    });

    test("never joins a coalition with someone it hates", () => {
      befriend(n1, h);
      const c = game.coalitions().create(h, "Pact")!;
      game.coalitions().invite(h, e);
      game.coalitions().reply(e, c.id(), true);
      n1.updateRelation(e, -100);
      game.coalitions().invite(h, n1);
      behavior(n1).handleCoalitions();
      expect(c.has(n1)).toBe(false);
    });

    test("nations without a personality ignore coalitions", () => {
      befriend(n1, h);
      game.config().nationPersonalities = () => false;
      const c = game.coalitions().create(h, "Pact")!;
      game.coalitions().invite(h, e);
      // e is human: no personality, so the behavior does nothing for it.
      new NationCoalitionBehavior(game, e).handleCoalitions();
      expect(c.has(e)).toBe(false);
      expect(game.coalitions().invitesFor(e)).toHaveLength(1);
    });
  });

  describe("leading", () => {
    test("an ambitious nation founds a coalition and invites its friends", () => {
      setPersonality(n1, personality({ ambition: 80 }));
      befriend(n1, n2);
      befriend(n1, h);
      behavior(n1).handleCoalitions();
      const c = game.coalitions().of(n1)!;
      expect(c).not.toBeNull();
      expect(c.name()).toBe("n1 Pact");
      behavior(n1).handleCoalitions();
      const invited = [n2, h].filter(
        (p) => game.coalitions().invitesFor(p).length > 0,
      );
      expect(invited).toHaveLength(1);
    });

    test("a founder nobody joins gives up", () => {
      setPersonality(n1, personality({ ambition: 80 }));
      befriend(n1, n2);
      befriend(n1, h);
      behavior(n1).handleCoalitions();
      const c = game.coalitions().of(n1)!;
      // Alone: no orders or sanctions.
      n1.updateRelation(e, -100);
      behavior(n1).handleCoalitions();
      expect(c.target()).toBeNull();
      executeTicks(game, 3 * 60 * 10 + 1);
      behavior(n1).handleCoalitions();
      expect(game.coalitions().of(n1)).toBeNull();
      expect(n1.isTraitor()).toBe(false);
    });

    test("doesn't found one without friends to ask", () => {
      setPersonality(n1, personality({ ambition: 90 }));
      behavior(n1).handleCoalitions();
      expect(game.coalitions().of(n1)).toBeNull();
    });

    test("sanctions a player two members hate, and orders an attack", () => {
      befriend(n1, n2);
      const c = game.coalitions().create(n1, "Pact")!;
      game.coalitions().invite(n1, n2);
      game.coalitions().reply(n2, c.id(), true);
      n1.updateRelation(e, -100);
      n2.updateRelation(e, -100);
      behavior(n1).handleCoalitions();
      expect(c.sanctions().has(e)).toBe(true);
      expect(c.target()).toBe(e);
      // The grudges fade: the sanction is lifted.
      n1.updateRelation(e, 100);
      n2.updateRelation(e, 100);
      behavior(n1).handleCoalitions();
      expect(c.sanctions().has(e)).toBe(false);
    });
  });

  describe("membership", () => {
    function joinHs() {
      befriend(n1, h);
      const c = game.coalitions().create(h, "Pact")!;
      game.coalitions().invite(h, n1);
      game.coalitions().reply(n1, c.id(), true);
      return c;
    }

    test("a disloyal member leaves once it distrusts the leader", () => {
      setPersonality(n1, personality({ loyalty: 20 }));
      const c = joinHs();
      n1.updateRelation(h, -150);
      expect(n1.relation(h)).toBeLessThanOrEqual(Relation.Distrustful);
      behavior(n1).handleCoalitions();
      expect(c.has(n1)).toBe(false);
      expect(n1.isTraitor()).toBe(true);
    });

    test("a loyal member stays", () => {
      setPersonality(n1, personality({ loyalty: 90 }));
      const c = joinHs();
      n1.updateRelation(h, -150);
      behavior(n1).handleCoalitions();
      expect(c.has(n1)).toBe(true);
    });

    test("follows the leader's attack order", () => {
      // n2 is a nation: lift the early-game immunity so it can be attacked.
      game.config().nationSpawnImmunityDuration = () => 0;
      game.config().spawnImmunityDuration = () => 0;
      const c = joinHs();
      n1.addTroops(1_000_000); // well past the reserve ratio
      game.coalitions().setTarget(h, n2);
      expect(c.target()).toBe(n2);
      const attack = attackBehavior(n1);
      expect((attack as any).followCoalitionOrder()).toBe(true);
      executeTicks(game, 1);
      expect(n1.outgoingAttacks().some((a) => a.target() === n2)).toBe(true);
    });

    test("a disloyal member ignores orders", () => {
      setPersonality(n1, personality({ loyalty: 10 }));
      joinHs();
      game.coalitions().setTarget(h, n2);
      const attack = attackBehavior(n1);
      expect((attack as any).followCoalitionOrder()).toBe(false);
    });
  });

  test("coalition names keep only allowed characters", () => {
    const fake = (name: string) =>
      ({ displayName: () => name, smallID: () => 7 }) as unknown as Player;
    expect(coalitionName(fake("Côte d'Ivoire"))).toBe("Côte d'Ivoire Pact");
    expect(coalitionName(fake("((("))).toBe("Pact 7");
    expect(coalitionName(fake("A".repeat(40))).length).toBeLessThanOrEqual(24);
  });
});
