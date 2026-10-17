import {
  Archetype,
  Cell,
  Nation,
  PlayerInfo,
  PlayerType,
} from "@openfront/engine-api/game/GameTypes";
import { NationExecution } from "@openfront/engine/execution/NationExecution";
import {
  archetypeOf,
  likelierOdds,
  NEUTRAL,
  personalityOf,
  rollPersonality,
  scaled,
  scaledInt,
} from "@openfront/engine/game/NationPersonality";
import { setup } from "./util/Setup";
import { expectSnapshotRoundTrip } from "./util/Snapshot";
import { executeTicks } from "./util/utils";

describe("NationPersonality", () => {
  test("is deterministic per nation and game", () => {
    expect(rollPersonality("France", "g1")).toEqual(
      rollPersonality("France", "g1"),
    );
    // Different games re-roll (overwhelmingly likely to differ somewhere).
    const rolls = new Set(
      ["g1", "g2", "g3", "g4", "g5"].map((g) =>
        JSON.stringify(rollPersonality("France", g)),
      ),
    );
    expect(rolls.size).toBeGreaterThan(1);
  });

  test("traits stay in 0..100 and archetypes are all reachable", () => {
    const seen = new Set<Archetype>();
    for (let i = 0; i < 400; i++) {
      const p = rollPersonality(`nation${i}`, "game");
      seen.add(p.archetype);
      for (const t of [
        p.aggression,
        p.loyalty,
        p.mercantilism,
        p.caution,
        p.ambition,
      ]) {
        expect(Number.isInteger(t)).toBe(true);
        expect(t).toBeGreaterThanOrEqual(0);
        expect(t).toBeLessThanOrEqual(100);
      }
    }
    expect(seen.size).toBe(Object.values(Archetype).length);
  });

  test("every helper is the identity at 50", () => {
    expect(scaled(0.55, 50, 0.9)).toBe(0.55);
    expect(scaledInt(61, 50, -0.3, 10)).toBe(61);
    expect(likelierOdds(7, 50, 0.5)).toBe(7);
    // ...and moves the right way off it.
    expect(scaled(0.5, 100, 0.2)).toBeCloseTo(0.6);
    expect(scaled(0.5, 0, 0.2)).toBeCloseTo(0.4);
    expect(likelierOdds(10, 100, 0.5)).toBe(5);
  });

  describe("on nations", () => {
    async function nationGame(personalities: boolean) {
      const game = await setup("plains", {}, []);
      game.config().nationPersonalities = () => personalities;
      const nation = new Nation(
        new Cell(50, 50),
        new PlayerInfo("Ruritania", PlayerType.Nation, null, "Ruritania"),
      );
      game.addExecution(new NationExecution("game", nation));
      game.executeNextTick();
      return { game, player: game.player("Ruritania") };
    }

    test("a nation gets its rolled personality", async () => {
      const { player } = await nationGame(true);
      const rolled = rollPersonality("Ruritania", "game");
      expect(personalityOf(player)).toEqual(rolled);
      expect(archetypeOf(player)).toBe(rolled.archetype);
      expect((player as any).toFullUpdate().archetype).toBe(rolled.archetype);
    });

    test("off: baseline traits and no archetype shown", async () => {
      const { player } = await nationGame(false);
      expect(personalityOf(player)).toBe(NEUTRAL);
      expect(archetypeOf(player)).toBeUndefined();
    });

    test("personality survives a snapshot round trip", async () => {
      const { game } = await nationGame(true);
      executeTicks(game, 5);
      await expectSnapshotRoundTrip(game, "plains", 30);
    });
  });
});
