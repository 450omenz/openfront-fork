import {
  PlayerInfo,
  PlayerType,
  UnitStatus,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { Game, Player } from "@openfront/engine/game/Game";
import {
  activeIndicatorIndices,
  STATUS_INDICATORS,
} from "../src/client/render/UnitStatusIndicators";
import { setup } from "./util/Setup";
import { expectSnapshotRoundTrip } from "./util/Snapshot";

let game: Game;
let p1: Player;

describe("UnitStatus flags", () => {
  beforeEach(async () => {
    game = await setup("plains", { infiniteGold: true, instantBuild: true }, [
      new PlayerInfo("p1", PlayerType.Human, null, "p1"),
    ]);
    p1 = game.player("p1");
    p1.conquer(game.ref(10, 10));
  });

  test("set, combine and clear bits", () => {
    const city = p1.buildUnit(UnitType.City, game.ref(10, 10), {});
    expect(city.statusFlags()).toBe(0);
    city.setStatus(UnitStatus.NoFunds, true);
    city.setStatus(UnitStatus.SupportingAttack, true);
    expect(city.hasStatus(UnitStatus.NoFunds)).toBe(true);
    expect(city.statusFlags()).toBe(
      UnitStatus.NoFunds | UnitStatus.SupportingAttack,
    );
    city.setStatus(UnitStatus.NoFunds, false);
    expect(city.hasStatus(UnitStatus.NoFunds)).toBe(false);
    expect(city.hasStatus(UnitStatus.SupportingAttack)).toBe(true);
  });

  test("unit updates carry the bits", () => {
    const city = p1.buildUnit(UnitType.City, game.ref(10, 10), {});
    expect(city.toUpdate().statusFlags).toBe(0);
    city.setStatus(UnitStatus.NoFunds, true);
    expect(city.toUpdate().statusFlags).toBe(UnitStatus.NoFunds);
  });

  test("bits survive a snapshot round trip", async () => {
    const city = p1.buildUnit(UnitType.City, game.ref(10, 10), {});
    city.setStatus(UnitStatus.NoFunds, true);
    const restored = await expectSnapshotRoundTrip(game, "plains", 5);
    expect(restored.unit(city.id())?.hasStatus(UnitStatus.NoFunds)).toBe(true);
  });

  test("registry maps bits to indicators", () => {
    expect(activeIndicatorIndices(0)).toEqual([]);
    const both = activeIndicatorIndices(
      UnitStatus.NoFunds | UnitStatus.SupportingAttack,
    );
    expect(both.map((i) => STATUS_INDICATORS[i].flag).sort()).toEqual(
      [UnitStatus.NoFunds, UnitStatus.SupportingAttack].sort(),
    );
    expect(
      STATUS_INDICATORS[activeIndicatorIndices(UnitStatus.NoFunds)[0]].shape,
    ).toBe("badge");
  });
});
