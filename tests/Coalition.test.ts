import {
  GameMode,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import { AllianceRequestExecution } from "@openfront/engine/execution/alliance/AllianceRequestExecution";
import { AttackExecution } from "@openfront/engine/execution/AttackExecution";
import { NukeExecution } from "@openfront/engine/execution/NukeExecution";
import { CoalitionExecution } from "@openfront/engine/execution/coalition/CoalitionExecution";
import { Coalition, Game, Player } from "@openfront/engine/game/Game";
import { setup } from "./util/Setup";
import { expectSnapshotRoundTrip } from "./util/Snapshot";
import { executeTicks } from "./util/utils";

let game: Game;
let a: Player;
let b: Player;
let c: Player;
let d: Player;

async function newGame(config = {}) {
  game = await setup("plains", { infiniteGold: true, ...config }, [
    new PlayerInfo("a", PlayerType.Human, "ca", "a"),
    new PlayerInfo("b", PlayerType.Human, "cb", "b"),
    new PlayerInfo("c", PlayerType.Human, "cc", "c"),
    new PlayerInfo("d", PlayerType.Human, "cd", "d"),
  ]);
  [a, b, c, d] = ["a", "b", "c", "d"].map((id) => game.player(id));
  // Four quarters of the map, so everyone is alive and has land.
  const own = (p: Player, x0: number, y0: number) => {
    for (let x = x0; x < x0 + 50; x++)
      for (let y = y0; y < y0 + 50; y++) p.conquer(game.ref(x, y));
  };
  own(a, 0, 0);
  own(b, 50, 0);
  own(c, 0, 50);
  own(d, 50, 50);
}

function act(
  p: Player,
  action: ConstructorParameters<typeof CoalitionExecution>[1],
) {
  game.addExecution(new CoalitionExecution(p, action));
  game.executeNextTick();
}

// a founds "Pact"; b joins.
function pactOfAB(): Coalition {
  act(a, { kind: "create", name: "Pact" });
  const pact = game.coalitions().of(a)!;
  act(a, { kind: "invite", target: b.id() });
  act(b, { kind: "reply", coalitionID: pact.id(), accept: true });
  return pact;
}

describe("Coalitions", () => {
  beforeEach(async () => newGame());

  test("found, invite, accept: members are friendly", () => {
    const pact = pactOfAB();
    expect(pact.name()).toBe("Pact");
    expect(pact.leader()).toBe(a);
    expect(pact.members()).toEqual([a, b]);
    expect(a.isFriendly(b)).toBe(true);
    expect(b.isCoalitionMember(a)).toBe(true);
    expect(a.isFriendly(c)).toBe(false);
  });

  test("clients get the coalition list and the invite", () => {
    game.addExecution(
      new CoalitionExecution(a, { kind: "create", name: "Pact" }),
    );
    let updates = game.executeNextTick();
    const lists = updates[GameUpdateType.Coalitions];
    expect(lists[lists.length - 1].coalitions).toMatchObject([
      { name: "Pact", leaderID: a.smallID(), memberIDs: [a.smallID()] },
    ]);
    game.addExecution(
      new CoalitionExecution(a, { kind: "invite", target: b.id() }),
    );
    updates = game.executeNextTick();
    const invites = updates[GameUpdateType.CoalitionInvite];
    expect(invites).toHaveLength(1);
    expect(invites[0].recipientID).toBe(b.smallID());
  });

  test("a declined invite tells the inviter and can't be repeated at once", () => {
    act(a, { kind: "create", name: "Pact" });
    const pact = game.coalitions().of(a)!;
    act(a, { kind: "invite", target: b.id() });
    expect(game.coalitions().inviteBlocker(a, b)).toBe("pending");
    game.addExecution(
      new CoalitionExecution(b, {
        kind: "reply",
        coalitionID: pact.id(),
        accept: false,
      }),
    );
    const updates = game.executeNextTick();
    const told = updates[GameUpdateType.DisplayEvent].some(
      (m) =>
        m.message === "events_display.coalition_invite_declined" &&
        m.playerID === a.smallID(),
    );
    expect(told).toBe(true);
    expect(game.coalitions().canInvite(a, b)).toBe(false);
    expect(game.coalitions().inviteBlocker(a, b)).toBe("declined");
    executeTicks(game, 2 * 60 * 10);
    expect(game.coalitions().canInvite(a, b)).toBe(true);
  });

  test("says why an invite can't be sent", () => {
    const pact = pactOfAB();
    act(c, { kind: "create", name: "Other" });
    expect(game.coalitions().inviteBlocker(a, c)).toBe("other_coalition");
    expect(game.coalitions().inviteBlocker(a, b)).toBeNull(); // a member
    act(a, { kind: "sanction", target: d.id(), on: true });
    expect(game.coalitions().inviteBlocker(a, d)).toBe("sanctioned");
    expect(pact.size()).toBe(2);
  });

  test("an invite lapses", () => {
    act(a, { kind: "create", name: "Pact" });
    const pact = game.coalitions().of(a)!;
    act(a, { kind: "invite", target: b.id() });
    executeTicks(game, game.config().coalitionInviteDuration() + 1);
    act(b, { kind: "reply", coalitionID: pact.id(), accept: true });
    expect(game.coalitions().of(b)).toBeNull();
  });

  test("only the leader invites, and names are checked", () => {
    const pact = pactOfAB();
    act(b, { kind: "invite", target: c.id() });
    expect(game.coalitions().invitesFor(c)).toHaveLength(0);
    act(c, { kind: "create", name: "<script>" });
    expect(game.coalitions().of(c)).toBeNull();
    act(c, { kind: "create", name: "x".repeat(25) });
    expect(game.coalitions().of(c)).toBeNull();
    expect(pact.size()).toBe(2);
  });

  test("joining replaces a pairwise alliance and ends embargoes", () => {
    game.addExecution(new AllianceRequestExecution(a, b.id()));
    game.executeNextTick();
    game.addExecution(new AllianceRequestExecution(b, a.id()));
    game.executeNextTick();
    expect(a.isAlliedWith(b)).toBe(true);
    pactOfAB();
    expect(a.isAlliedWith(b)).toBe(false);
    expect(a.isFriendly(b)).toBe(true);
  });

  test("members can't attack each other", () => {
    pactOfAB();
    a.addTroops(100_000);
    game.addExecution(new AttackExecution(10_000, a, b.id(), null));
    executeTicks(game, 3);
    expect(a.outgoingAttacks()).toHaveLength(0);
  });

  test("leaving breaks the peace: traitor, and a rejoin cooldown", () => {
    const pact = pactOfAB();
    act(c, { kind: "create", name: "Third" });
    act(b, { kind: "leave" });
    expect(b.isTraitor()).toBe(true);
    expect(a.isFriendly(b)).toBe(false);
    // Down to one member: dissolved.
    expect(game.coalitions().get(pact.id())).toBeNull();
    expect(game.coalitions().of(a)).toBeNull();
    // b can't found or join anything for a while.
    expect(game.coalitions().canCreate(b)).toBe(false);
    executeTicks(game, game.config().coalitionRejoinCooldown());
    expect(game.coalitions().canCreate(b)).toBe(true);
  });

  test("a nuke that hits a member breaks with the coalition", () => {
    game.config().nukeAllianceBreakThreshold = () => 0;
    const pact = pactOfAB();
    act(a, { kind: "invite", target: c.id() });
    act(c, { kind: "reply", coalitionID: pact.id(), accept: true });
    // a nukes d's tile touching member b's land (test nukes have radius 1).
    a.buildUnit(UnitType.MissileSilo, game.ref(10, 10), {});
    game.addExecution(
      new NukeExecution(UnitType.AtomBomb, a, game.ref(55, 50), null),
    );
    executeTicks(game, 3);
    expect(a.isTraitor()).toBe(true);
    expect(pact.has(a)).toBe(false);
    expect(pact.leader()).not.toBe(a);
  });

  test("being kicked is not betrayal", () => {
    const pact = pactOfAB();
    act(a, { kind: "invite", target: c.id() });
    act(c, { kind: "reply", coalitionID: pact.id(), accept: true });
    act(a, { kind: "kick", target: b.id() });
    expect(b.isTraitor()).toBe(false);
    expect(pact.members()).toEqual([a, c]);
  });

  test("sanctions block trade with every member", () => {
    const pact = pactOfAB();
    expect(b.canTrade(d)).toBe(true);
    act(a, { kind: "sanction", target: d.id(), on: true });
    expect(pact.sanctions().has(d)).toBe(true);
    expect(a.canTrade(d)).toBe(false);
    expect(b.canTrade(d)).toBe(false);
    expect(d.canTrade(b)).toBe(false);
    expect(c.canTrade(d)).toBe(true); // outsiders unaffected
    // Can't sanction a member; a sanctioned player can't be invited.
    act(a, { kind: "sanction", target: b.id(), on: true });
    expect(pact.sanctions().has(b)).toBe(false);
    act(a, { kind: "invite", target: d.id() });
    expect(game.coalitions().invitesFor(d)).toHaveLength(0);
    act(a, { kind: "sanction", target: d.id(), on: false });
    expect(b.canTrade(d)).toBe(true);
  });

  test("the attack order: every member's target, a joint attack, then lapses", () => {
    const pact = pactOfAB();
    act(a, { kind: "target", target: d.id() });
    expect(pact.target()).toBe(d);
    expect(b.transitiveTargets()).toContain(d);
    b.addTroops(100_000);
    const attack = new AttackExecution(1_000, b, d.id(), null);
    game.addExecution(attack);
    game.executeNextTick();
    expect((attack as any).buildTickCtx(d).jointAttack).toBe(true);
    // Not a member: no order.
    expect(c.transitiveTargets()).not.toContain(d);
    executeTicks(game, game.config().coalitionTargetDuration());
    expect(pact.target()).toBeNull();
  });

  test("an order has a cooldown and can't target a member", () => {
    pactOfAB();
    act(a, { kind: "target", target: b.id() });
    expect(game.coalitions().of(a)!.target()).toBeNull();
    act(a, { kind: "target", target: c.id() });
    act(a, { kind: "target", target: d.id() });
    expect(game.coalitions().of(a)!.target()).toBe(c);
  });

  test("leadership passes to the largest member when the leader falls", () => {
    const pact = pactOfAB();
    act(a, { kind: "invite", target: c.id() });
    act(c, { kind: "reply", coalitionID: pact.id(), accept: true });
    // c bigger than b.
    for (let x = 0; x < 50; x++) c.conquer(game.ref(x, 49));
    a.removeAllAlliances(); // what elimination does
    expect(pact.leader()).toBe(c);
    expect(pact.members()).toEqual([b, c]);
    expect(a.isTraitor()).toBe(false);
  });

  test("leadership can be handed over", () => {
    const pact = pactOfAB();
    act(a, { kind: "transfer", target: b.id() });
    expect(pact.leader()).toBe(b);
    act(a, { kind: "invite", target: c.id() });
    expect(game.coalitions().invitesFor(c)).toHaveLength(0);
  });

  test("survives a snapshot round trip", async () => {
    const pact = pactOfAB();
    act(a, { kind: "sanction", target: d.id(), on: true });
    act(a, { kind: "target", target: c.id() });
    act(a, { kind: "invite", target: c.id() });
    expect(pact.size()).toBe(2);
    await expectSnapshotRoundTrip(game, "plains", 10);
  });

  test("off when alliances are disabled", async () => {
    await newGame({ disableAlliances: true });
    act(a, { kind: "create", name: "Pact" });
    expect(game.coalitions().of(a)).toBeNull();
  });

  test("off in team games", async () => {
    await newGame({ gameMode: GameMode.Team, playerTeams: 2 });
    expect(game.coalitions().enabled()).toBe(false);
  });
});

describe("Coalition join requests", () => {
  beforeEach(async () => newGame());

  test("ask to join; the leader accepts", () => {
    const pact = pactOfAB();
    act(c, { kind: "request", coalitionID: pact.id() });
    expect(
      game
        .coalitions()
        .requestsFor(a)
        .map((r) => r.applicant),
    ).toEqual([c]);
    expect(game.coalitions().requestBlocker(c, pact)).toBe("pending");
    act(a, { kind: "answer", target: c.id(), accept: true });
    expect(pact.has(c)).toBe(true);
    expect(game.coalitions().requestsFor(a)).toHaveLength(0);
  });

  test("a refusal is reported and blocks asking again for a while", () => {
    const pact = pactOfAB();
    act(c, { kind: "request", coalitionID: pact.id() });
    game.addExecution(
      new CoalitionExecution(a, {
        kind: "answer",
        target: c.id(),
        accept: false,
      }),
    );
    const updates = game.executeNextTick();
    expect(
      updates[GameUpdateType.DisplayEvent].some(
        (m) =>
          m.message === "events_display.coalition_request_declined" &&
          m.playerID === c.smallID(),
      ),
    ).toBe(true);
    expect(game.coalitions().requestBlocker(c, pact)).toBe("declined");
    executeTicks(game, 2 * 60 * 10);
    expect(game.coalitions().canRequestJoin(c, pact)).toBe(true);
  });

  test("only the leader answers; members of a coalition can't apply", () => {
    const pact = pactOfAB();
    act(c, { kind: "request", coalitionID: pact.id() });
    act(b, { kind: "answer", target: c.id(), accept: true }); // not leader
    expect(pact.has(c)).toBe(false);
    act(d, { kind: "create", name: "Other" });
    expect(game.coalitions().requestBlocker(d, pact)).toBe("other_coalition");
  });

  test("an invited player is told to accept the invite instead", () => {
    const pact = pactOfAB();
    act(a, { kind: "invite", target: c.id() });
    expect(game.coalitions().requestBlocker(c, pact)).toBe("invited");
  });

  test("requests survive a snapshot round trip", async () => {
    const pact = pactOfAB();
    act(c, { kind: "request", coalitionID: pact.id() });
    act(d, { kind: "request", coalitionID: pact.id() });
    act(a, { kind: "answer", target: d.id(), accept: false });
    await expectSnapshotRoundTrip(game, "plains", 10);
  });
});
