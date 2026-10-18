import {
  Archetype,
  Cell,
  Difficulty,
  Nation,
  PlayerInfo,
  PlayerType,
} from "@openfront/engine-api/game/GameTypes";
import { EngineConfig } from "@openfront/engine/configuration/EngineConfig";
import { AttackExecution } from "@openfront/engine/execution/AttackExecution";
import { NationExecution } from "@openfront/engine/execution/NationExecution";
import { PlayerExecution } from "@openfront/engine/execution/PlayerExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import {
  personalityOf,
  setPersonality,
} from "@openfront/engine/game/NationPersonality";
import { setup } from "./util/Setup";

// Fork: a nation in your coalition comes to your aid when you're attacked,
// on every difficulty — even with free land to grab, below its troop
// reserve, against a stronger attacker, and when that attacker is human.
async function scenarioWithoutInvite() {
  return scenario(Difficulty.Hard, false);
}

async function scenario(difficulty: Difficulty, invite = true) {
  const nation = new Nation(
    new Cell(75, 25),
    new PlayerInfo("N", PlayerType.Nation, null, "N"),
  );
  const game: Game = await setup(
    "plains",
    { difficulty },
    [
      new PlayerInfo("h", PlayerType.Human, "ch", "h"),
      new PlayerInfo("e", PlayerType.Human, "ce", "e"),
    ],
    undefined,
    EngineConfig,
    false,
    [nation],
  );
  game.addExecution(new NationExecution("g", nation));
  for (let i = 0; i < 60 && !game.player("N").hasSpawned(); i++) {
    game.executeNextTick();
  }
  game.endSpawnPhase();
  // Early-game immunity would hold back the aggressor's attack.
  game.config().spawnImmunityDuration = () => 0;
  game.config().nationSpawnImmunityDuration = () => 0;
  const [h, e, n] = ["h", "e", "N"].map((id) => game.player(id));
  const own = (p: Player, x0: number, y0: number, w: number, hh: number) => {
    for (let x = x0; x < x0 + w; x++)
      for (let y = y0; y < y0 + hh; y++) p.conquer(game.ref(x, y));
  };
  own(h, 0, 0, 50, 100);
  own(n, 50, 0, 50, 50);
  own(e, 50, 50, 50, 50); // borders both h and n
  for (const p of [h, e]) game.addExecution(new PlayerExecution(p));
  h.addTroops(50_000);
  e.addTroops(400_000); // the aggressor is far stronger
  setPersonality(n, {
    ...personalityOf(n),
    archetype: Archetype.Diplomat,
    loyalty: 90,
  });
  const c = game.coalitions().create(h, "Pact")!;
  if (invite) {
    game.coalitions().invite(h, n);
    for (let i = 0; i < 150 && !c.has(n); i++) game.executeNextTick();
  }
  return { game, h, e, n, c };
}

describe("coalition members defend each other", () => {
  it.each([
    Difficulty.Easy,
    Difficulty.Medium,
    Difficulty.Hard,
    Difficulty.Impossible,
  ])(
    "%s",
    async (difficulty) => {
      const { game, h, e, n, c } = await scenario(difficulty);
      expect(c.has(n)).toBe(true); // a loyal nation accepted the invite
      game.addExecution(new AttackExecution(100_000, e, h.id(), null));
      let helped = false;
      for (let i = 0; i < 200 && !helped; i++) {
        game.executeNextTick();
        helped = n.outgoingAttacks().some((a) => a.target() === e);
      }
      expect(helped).toBe(true);
    },
    120_000,
  );
});

describe("nations ask to join instead of allying", () => {
  test("a bordering nation applies to the human's coalition, then defends it", async () => {
    const { game, h, e, n, c } = await scenarioWithoutInvite();
    let asked = false;
    for (let i = 0; i < 400 && !asked; i++) {
      game.executeNextTick();
      asked = game
        .coalitions()
        .requestsFor(h)
        .some((r) => r.applicant === n);
    }
    expect(asked).toBe(true);
    expect(n.outgoingAllianceRequests()).toHaveLength(0);
    // The human leader accepts; the new member then defends them.
    expect(game.coalitions().answerRequest(h, n, true)).toBe(true);
    expect(c.has(n)).toBe(true);
    game.addExecution(new AttackExecution(100_000, e, h.id(), null));
    let helped = false;
    for (let i = 0; i < 200 && !helped; i++) {
      game.executeNextTick();
      helped = n.outgoingAttacks().some((a) => a.target() === e);
    }
    expect(helped).toBe(true);
  }, 120_000);
});
