import {
  Archetype,
  PlayerInfo,
  PlayerType,
  Relation,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import {
  isProtectedPartner,
  isValuedPartner,
  NationTradeBehavior,
} from "@openfront/engine/execution/nation/NationTradeBehavior";
import { PlayerExecution } from "@openfront/engine/execution/PlayerExecution";
import { NationStructureBehavior } from "@openfront/engine/execution/nation/NationStructureBehavior";
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
let nation: Player;
let partner: Player;
let other: Player;

function personality(over: Partial<Personality>): Personality {
  return { ...NEUTRAL, archetype: Archetype.Balanced, ...over };
}

describe("trade ledger and trading nations", () => {
  beforeEach(async () => {
    game = await setup("plains", { infiniteGold: true, instantBuild: true }, [
      new PlayerInfo("nation", PlayerType.Nation, null, "nation"),
      new PlayerInfo("partner", PlayerType.Human, null, "partner"),
      new PlayerInfo("other", PlayerType.Human, null, "other"),
    ]);
    nation = game.player("nation");
    partner = game.player("partner");
    other = game.player("other");
    // Alive players (relations and trade only count the living).
    nation.conquer(game.ref(5, 5));
    partner.conquer(game.ref(90, 5));
    other.conquer(game.ref(90, 95));
  });

  test("records gold per partner and decays it by halves", () => {
    nation.recordTrade(partner, 100_000n);
    nation.recordTrade(partner, 50_000n);
    nation.recordTrade(other, 1n);
    nation.recordTrade(nation, 999n); // self-trade is not a partner
    expect(nation.tradeVolumeWith(partner)).toBe(150_000n);
    expect(nation.totalTradeVolume()).toBe(150_001n);
    nation.decayTradeLedger();
    expect(nation.tradeVolumeWith(partner)).toBe(75_000n);
    expect(nation.tradeVolumeWith(other)).toBe(0n); // 1 / 2 = 0: dropped
  });

  test("PlayerExecution decays the ledger every tradeLedgerDecayTicks", () => {
    nation.recordTrade(partner, 1_000_000n);
    game.addExecution(new PlayerExecution(nation));
    const every = game.config().tradeLedgerDecayTicks();
    // PlayerExecution doesn't run during the spawn phase.
    executeTicks(game, game.config().numSpawnPhaseTurns() + every + 1);
    expect(nation.tradeVolumeWith(partner)).toBeLessThan(1_000_000n);
  });

  test("the ledger survives a snapshot round trip", async () => {
    nation.recordTrade(partner, 123_456n);
    await expectSnapshotRoundTrip(game, "plains", 5);
  });

  test("a big share of our trade makes a valued partner", () => {
    setPersonality(nation, personality({}));
    nation.recordTrade(partner, 300_000n);
    nation.recordTrade(other, 700_000n);
    expect(isValuedPartner(game, nation, partner)).toBe(true); // 30% > 25%
    nation.recordTrade(other, 2_000_000n);
    expect(isValuedPartner(game, nation, partner)).toBe(false); // 10%
    // A merchant still values a 10% partner.
    setPersonality(nation, personality({ mercantilism: 100 }));
    expect(isValuedPartner(game, nation, partner)).toBe(true);
  });

  test("nothing is valued with personalities off", () => {
    game.config().nationPersonalities = () => false;
    nation.recordTrade(partner, 1_000_000n);
    expect(isValuedPartner(game, nation, partner)).toBe(false);
  });

  test("aggressive nations don't protect partners", () => {
    nation.recordTrade(partner, 1_000_000n);
    setPersonality(nation, personality({ archetype: Archetype.Merchant }));
    expect(isProtectedPartner(game, nation, partner)).toBe(true);
    setPersonality(
      nation,
      personality({ archetype: Archetype.Warmonger, aggression: 90 }),
    );
    expect(isProtectedPartner(game, nation, partner)).toBe(false);
  });

  test("trade warms relations, up to Friendly", () => {
    setPersonality(nation, personality({ mercantilism: 90 }));
    nation.recordTrade(partner, 1_000_000n);
    const trade = new NationTradeBehavior(game, nation);
    const before = nation.relation(partner);
    for (let i = 0; i < 40; i++) trade.warmToPartners();
    expect(nation.relation(partner)).toBeGreaterThan(before);
    expect(nation.relation(partner)).toBe(Relation.Friendly);
    // Not toward someone we never traded with.
    expect(nation.relation(other)).toBe(Relation.Neutral);
  });

  describe("tank building", () => {
    function structureBehavior() {
      return new NationStructureBehavior(new PseudoRandom(1), game, nation);
    }

    beforeEach(() => {
      for (let x = 0; x < 50; x++)
        for (let y = 0; y < 100; y++) nation.conquer(game.ref(x, y));
      for (let x = 50; x < 100; x++)
        for (let y = 0; y < 100; y++) other.conquer(game.ref(x, y));
      nation.buildUnit(UnitType.Factory, game.ref(20, 50), {});
      nation.addGold(100_000_000n);
    });

    test("aggressive nations with a land front build tanks, up to a cap", () => {
      setPersonality(
        nation,
        personality({ archetype: Archetype.Warmonger, aggression: 60 }),
      );
      const b = structureBehavior();
      expect((b as any).maybeBuildTank()).toBe(true);
      executeTicks(game, 3);
      expect(nation.units(UnitType.Tank).length).toBe(1);
      expect((b as any).maybeBuildTank()).toBe(true);
      executeTicks(game, 3);
      // aggression 60: cap of 2.
      expect((b as any).maybeBuildTank()).toBe(false);
    });

    test("peaceful or personality-less nations don't", () => {
      setPersonality(nation, personality({ aggression: 20 }));
      expect((structureBehavior() as any).maybeBuildTank()).toBe(false);
    });
  });
});
