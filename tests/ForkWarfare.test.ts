import {
  Climate,
  Difficulty,
  PlayerInfo,
  PlayerType,
  TerrainType,
} from "@openfront/engine-api/game/GameTypes";
import {
  ARID_RANGE,
  climateAt,
  climateMap,
  COASTAL_RANGE,
  homeClimate,
  NO_CLIMATE,
} from "@openfront/engine-lib/game/Climate";
import { GameMapImpl } from "@openfront/engine-lib/game/GameMapImpl";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { GameConfig } from "@openfront/engine-api/Schemas";
import {
  AttackLogicInput,
  EngineConfig,
} from "@openfront/engine/configuration/EngineConfig";
import { AttackExecution } from "@openfront/engine/execution/AttackExecution";
import { NationAllianceBehavior } from "@openfront/engine/execution/nation/NationAllianceBehavior";
import { NationEmojiBehavior } from "@openfront/engine/execution/nation/NationEmojiBehavior";
import { AiAttackBehavior } from "@openfront/engine/execution/utils/AiAttackBehavior";
import { setup } from "./util/Setup";
import { executeTicks } from "./util/utils";

// Terrain byte: bit 7 = land, low 5 bits = magnitude.
const LAND = 1 << 7;

/** A W×H map: a water column at x = 0, land elsewhere, a hill at (60, 50). */
function syntheticMap(w = 120, h = 100): GameMapImpl {
  const bytes = new Uint8Array(w * h);
  let land = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0) continue;
      const hill = Math.abs(x - 60) <= 2 && Math.abs(y - 50) <= 2;
      bytes[y * w + x] = LAND | (hill ? 15 : 2);
      land++;
    }
  }
  return new GameMapImpl(w, h, bytes, land);
}

describe("Climate", () => {
  test("classifies coast, highland, arid and cold", () => {
    const map = syntheticMap();
    expect(climateMap(map)[map.ref(0, 50)]).toBe(NO_CLIMATE);
    expect(climateAt(map, map.ref(COASTAL_RANGE, 50))).toBe(Climate.Coastal);
    expect(map.terrainType(map.ref(60, 50))).toBe(TerrainType.Highland);
    expect(climateAt(map, map.ref(60, 50))).toBe(Climate.Highland);
    // Far from water, near the equator.
    expect(climateAt(map, map.ref(ARID_RANGE + 20, 50))).toBe(Climate.Arid);
    // Near the top edge.
    expect(climateAt(map, map.ref(ARID_RANGE + 20, 1))).toBe(Climate.Cold);
    // Between coast and arid range, mid latitude.
    expect(climateAt(map, map.ref(COASTAL_RANGE + 5, 30))).toBe(
      Climate.Temperate,
    );
  });

  test("is deterministic and recomputes when water changes", () => {
    const a = climateMap(syntheticMap());
    const b = climateMap(syntheticMap());
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);

    const map = syntheticMap();
    const tile = map.ref(ARID_RANGE + 20, 50);
    expect(climateAt(map, tile)).toBe(Climate.Arid);
    map.setWater(map.ref(ARID_RANGE + 21, 50));
    expect(climateAt(map, tile)).toBe(Climate.Coastal);
  });

  test("home climate is the majority around a base", () => {
    const map = syntheticMap();
    expect(homeClimate(map, map.ref(ARID_RANGE + 30, 50), 10)).toBe(
      Climate.Arid,
    );
    expect(homeClimate(map, map.ref(3, 50), 5)).toBe(Climate.Coastal);
  });
});

describe("combat modifiers", () => {
  // The real rules: the test config stubs attackLogic out.
  const config = new EngineConfig({} as GameConfig, false);
  const base = (): AttackLogicInput => ({
    terrain: TerrainType.Plains,
    attackTroops: 10_000,
    attacker: { type: PlayerType.Human, numTiles: 1_000 },
    defender: {
      type: PlayerType.Human,
      numTiles: 1_000,
      troops: 20_000,
      isTraitor: false,
      isDisconnectedTeammate: false,
    },
    defenderHasDefensePost: false,
    falloutRatio: null,
    borderSize: 50,
  });

  test("leaving the fork inputs out changes nothing", () => {
    const c = config;
    expect(c.forkCombatModifiers(base())).toEqual({ mag: 1, tileCost: 1 });
    const withOnes = {
      ...base(),
      defenderHasAllySupport: false,
      attackerHasJointAttack: false,
    };
    expect(c.attackLogic(withOnes)).toEqual(c.attackLogic(base()));
  });

  test("trained attackers lose less; trained defenders cost more", () => {
    const c = config;
    const plain = c.attackLogic(base()).attackerTroopLoss;
    const trained = { share: 0.5, level: 2, homeMatch: false };
    const atk = c.attackLogic({ ...base(), attackerTrained: trained });
    const def = c.attackLogic({ ...base(), defenderTrained: trained });
    expect(atk.attackerTroopLoss).toBeLessThan(plain);
    expect(def.attackerTroopLoss).toBeGreaterThan(plain);
    // Home climate makes it stronger still.
    const home = c.attackLogic({
      ...base(),
      attackerTrained: { ...trained, homeMatch: true },
    });
    expect(home.attackerTroopLoss).toBeLessThan(atk.attackerTroopLoss);
  });

  test("fresh land is cheaper to take than entrenched land", () => {
    const c = config;
    const fresh = c.attackLogic({ ...base(), entrenchment: 0 });
    const dug = c.attackLogic({ ...base(), entrenchment: 1 });
    const plain = c.attackLogic(base());
    expect(fresh.attackerTroopLoss).toBeLessThan(plain.attackerTroopLoss);
    expect(dug.attackerTroopLoss).toBeGreaterThan(plain.attackerTroopLoss);
    expect(dug.tickFraction).toBeGreaterThan(fresh.tickFraction);
    // Bases deepen entrenchment.
    const based = c.attackLogic({
      ...base(),
      entrenchment: 1,
      defenderBaseLevels: 5,
    });
    expect(based.attackerTroopLoss).toBeGreaterThan(dug.attackerTroopLoss);
  });

  test("ally support defends; joint attacks are cheaper", () => {
    const c = config;
    const plain = c.attackLogic(base());
    const support = c.attackLogic({ ...base(), defenderHasAllySupport: true });
    const joint = c.attackLogic({ ...base(), attackerHasJointAttack: true });
    expect(support.attackerTroopLoss).toBeGreaterThan(plain.attackerTroopLoss);
    expect(support.tickFraction).toBeGreaterThan(plain.tickFraction);
    expect(joint.attackerTroopLoss).toBeLessThan(plain.attackerTroopLoss);
    expect(joint.tickFraction).toBeLessThan(plain.tickFraction);
  });

  test("terra nullius ignores the defender-side inputs", () => {
    const c = config;
    const tn = { ...base(), defender: null };
    expect(c.attackLogic({ ...tn, entrenchment: 1 })).toEqual(
      c.attackLogic(tn),
    );
  });
});

describe("entrenchment", () => {
  test("taking a tile resets how long it has been held", async () => {
    const game = await setup("plains", {}, [
      new PlayerInfo("a", PlayerType.Human, null, "a"),
      new PlayerInfo("b", PlayerType.Human, null, "b"),
    ]);
    const a = game.player("a");
    const b = game.player("b");
    const tile = game.ref(5, 5);
    a.conquer(tile);
    executeTicks(game, 200);
    expect(game.heldFor(tile)).toBeGreaterThanOrEqual(192);
    const dug = game.entrenchment(tile, a);
    expect(dug).toBeGreaterThan(0.2);
    b.conquer(tile);
    expect(game.heldFor(tile)).toBeLessThan(16);
    expect(game.entrenchment(tile, b)).toBeLessThan(dug);
    executeTicks(game, game.config().entrenchTicks(0) + 20);
    expect(game.entrenchment(tile, b)).toBe(1);
  });
});

describe("call to arms", () => {
  /**
   * enemy owns the left side; ally (human) and nation split the right side
   * into a top and bottom half, so the enemy borders both of them.
   */
  async function setupCallToArms(difficulty: Difficulty) {
    const game = await setup("big_plains", { difficulty }, [
      new PlayerInfo("nation", PlayerType.Nation, null, "nation_id"),
      new PlayerInfo("ally", PlayerType.Human, null, "ally_id"),
      new PlayerInfo("enemy", PlayerType.Human, null, "enemy_id"),
    ]);
    const nation = game.player("nation_id");
    const ally = game.player("ally_id");
    const enemy = game.player("enemy_id");
    const h = game.map().height();
    for (let x = 0; x < game.map().width(); x++) {
      for (let y = 0; y < h; y++) {
        const tile = game.ref(x, y);
        if (!game.map().isLand(tile)) continue;
        if (x < 40) enemy.conquer(tile);
        else if (y < h / 2) ally.conquer(tile);
        else nation.conquer(tile);
      }
    }
    nation.createAllianceRequest(ally)?.accept();
    const random = new PseudoRandom(42);
    const emoji = new NationEmojiBehavior(random, game, nation);
    const behavior = new AiAttackBehavior(
      random,
      game,
      nation,
      0.5,
      0.3,
      0.2,
      new NationAllianceBehavior(random, game, nation, emoji),
      emoji,
    );
    return { game, nation, ally, enemy, behavior };
  }

  it.each([Difficulty.Medium, Difficulty.Hard, Difficulty.Impossible])(
    "%s: a nation attacks whoever attacks its ally, below its trigger ratio",
    async (difficulty) => {
      const { game, nation, ally, enemy, behavior } =
        await setupCallToArms(difficulty);
      expect(nation.isAlliedWith(ally)).toBe(true);
      // Above the 0.3 reserve, below the 0.5 trigger.
      nation.setTroops(Math.floor(game.config().maxTroops(nation) * 0.4));
      enemy.setTroops(200_000);
      ally.setTroops(50_000);
      game.addExecution(new AttackExecution(40_000, enemy, ally.id()));
      game.executeNextTick();
      expect(ally.incomingAttacks().length).toBeGreaterThan(0);

      const spy = vi.spyOn(game, "addExecution");
      behavior.maybeAttack();
      const sent = spy.mock.calls
        .map((c) => c[0])
        .filter(
          (e): e is AttackExecution =>
            e instanceof AttackExecution && e.targetID() === enemy.id(),
        );
      expect(sent.length).toBe(1);
    },
  );

  test("human allies get a message, once per cooldown", async () => {
    const { game, ally, nation, enemy } = await setupCallToArms(
      Difficulty.Medium,
    );
    // nation (as the attacked one) has a human ally: the "ally" player.
    enemy.setTroops(200_000);
    nation.setTroops(50_000);
    const spy = vi.spyOn(game, "displayMessage");
    game.addExecution(new AttackExecution(10_000, enemy, nation.id()));
    game.executeNextTick();
    game.addExecution(new AttackExecution(10_000, enemy, nation.id()));
    game.executeNextTick();
    const calls = spy.mock.calls.filter(
      (c) => c[0] === "events_display.ally_under_attack" && c[2] === ally.id(),
    );
    expect(calls).toHaveLength(1);
  });
});
