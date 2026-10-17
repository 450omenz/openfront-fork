import {
  Archetype,
  PlayerInfo,
  PlayerType,
} from "@openfront/engine-api/game/GameTypes";
import { AttackExecution } from "@openfront/engine/execution/AttackExecution";
import { answerDiplomacyChat } from "@openfront/engine/execution/nation/NationDiplomacyChat";
import { Game, Player } from "@openfront/engine/game/Game";
import {
  NEUTRAL,
  Personality,
  setPersonality,
} from "@openfront/engine/game/NationPersonality";
import { setup } from "./util/Setup";
import { executeTicks } from "./util/utils";

let game: Game;
let nation: Player;
let human: Player;
let other: Player;

const personality = (over: Partial<Personality>): Personality => ({
  ...NEUTRAL,
  archetype: Archetype.Balanced,
  ...over,
});

describe("nations answer diplomacy messages", () => {
  beforeEach(async () => {
    game = await setup("plains", { infiniteGold: true }, [
      new PlayerInfo("n", PlayerType.Nation, null, "n"),
      new PlayerInfo("h", PlayerType.Human, "ch", "h"),
      new PlayerInfo("o", PlayerType.Human, "co", "o"),
    ]);
    [nation, human, other] = ["n", "h", "o"].map((id) => game.player(id));
    for (let x = 0; x < 100; x++)
      for (let y = 0; y < 100; y++)
        (x < 50 ? nation : y < 50 ? human : other).conquer(game.ref(x, y));
    for (const p of [nation, human, other]) p.addTroops(100_000);
    setPersonality(nation, personality({}));
    game.config().spawnImmunityDuration = () => 0;
    game.config().nationSpawnImmunityDuration = () => 0;
  });

  test("pact: a willing nation proposes one back", () => {
    human.addTroops(1_000_000); // stronger: worth a pact
    answerDiplomacyChat(game, nation, human, "diplomacy.pact");
    expect(game.pacts().proposalsFor(human)).toHaveLength(1);
  });

  test("pact: a greedy nation refuses weak askers", () => {
    setPersonality(nation, personality({ aggression: 90 }));
    nation.addTroops(1_000_000);
    answerDiplomacyChat(game, nation, human, "diplomacy.pact");
    expect(game.pacts().proposalsFor(human)).toHaveLength(0);
  });

  test("ceasefire: calls off its attacks and offers a pact", () => {
    human.addTroops(1_000_000);
    game.addExecution(new AttackExecution(10_000, nation, human.id(), null));
    executeTicks(game, 2);
    expect(nation.outgoingAttacks().length).toBe(1);
    answerDiplomacyChat(game, nation, human, "diplomacy.ceasefire");
    expect(nation.outgoingAttacks()[0]?.retreating() ?? true).toBe(true);
    expect(game.pacts().proposalsFor(human)).toHaveLength(1);
  });

  test("join_you: a leading nation invites the asker", () => {
    const c = game.coalitions().create(nation, "Pact")!;
    answerDiplomacyChat(game, nation, human, "diplomacy.join_you");
    expect(game.coalitions().invitesFor(human)[0]?.coalition).toBe(c);
  });

  test("trade: a merchant lifts its embargo", () => {
    setPersonality(nation, personality({ mercantilism: 80 }));
    nation.addEmbargo(human, false);
    answerDiplomacyChat(game, nation, human, "diplomacy.trade");
    expect(nation.hasEmbargoAgainst(human)).toBe(false);
  });

  test("players without a personality don't answer", () => {
    answerDiplomacyChat(game, other, human, "diplomacy.pact");
    expect(game.pacts().proposalsFor(human)).toHaveLength(0);
  });
});
