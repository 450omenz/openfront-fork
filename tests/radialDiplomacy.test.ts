// @vitest-environment jsdom
import { vi } from "vitest";

vi.mock("../src/client/hud/layers/BuildMenu", () => ({
  BuildMenu: class {},
  flattenedBuildTable: [],
}));
vi.mock("../src/client/Utils", () => ({
  translateText: (k: string) => k,
  getSvgAspectRatio: async () => 1,
}));
vi.mock("../src/client/hud/layers/CoalitionPanel", () => ({
  ToggleCoalitionPanelEvent: class {
    constructor(public open?: boolean) {}
  },
}));

import { PlayerType } from "@openfront/engine-api/game/GameTypes";
import {
  diplomacyMenuElement,
  rootMenuElement,
  type MenuElementParams,
} from "../src/client/hud/layers/RadialMenuElements";

// Fork: the Diplomacy slot of the radial menu.
const player = (id: string, type = PlayerType.Human) =>
  ({
    id: () => id,
    type: () => type,
    isAlliedWith: () => false,
    isFriendly: () => false,
    isTraitor: () => false,
    isDisconnected: () => false,
  }) as any;

function params(interaction: object, selected = player("p2")) {
  const emitted: any[] = [];
  const p: MenuElementParams = {
    myPlayer: player("p1"),
    selected,
    tile: 0 as any,
    playerActions: { canAttack: true, interaction } as any,
    game: {
      inSpawnPhase: () => false,
      ticks: () => 0,
      owner: () => ({ isPlayer: () => false }),
      config: () => ({ allianceExtensionPromptOffset: () => 300 }),
    } as any,
    buildMenu: { canBuildOrUpgrade: () => false, cost: () => 0 } as any,
    emojiTable: {} as any,
    playerActionHandler: {} as any,
    playerPanel: { show: vi.fn() } as any,
    chatIntegration: { createQuickChatMenu: vi.fn(() => []) } as any,
    eventBus: { emit: (e: any) => emitted.push(e) } as any,
    closeMenu: vi.fn(),
  };
  return { p, emitted };
}

describe("radial Diplomacy menu", () => {
  test("appears on another player, not on tribes", () => {
    expect(
      rootMenuElement.subMenu!(params({}).p).some((i) => i.id === "diplomacy"),
    ).toBe(true);
    expect(
      rootMenuElement.subMenu!(
        params({}, player("bot", PlayerType.Bot)).p,
      ).some((i) => i.id === "diplomacy"),
    ).toBe(false);
  });

  test("pact: pick a length, which sends a proposal", () => {
    const { p, emitted } = params({ canProposePact: true });
    const pact = diplomacyMenuElement.subMenu!(p).find(
      (i) => i.id === "diplomacy_pact",
    )!;
    expect(pact.disabled(p)).toBe(false);
    const lengths = pact.subMenu!(p);
    expect(lengths.map((l) => l.id)).toEqual(["pact_5", "pact_10", "pact_20"]);
    lengths[1].action!(p);
    expect(emitted[0].intent).toEqual({
      type: "pact_propose",
      recipient: "p2",
      minutes: 10,
    });
  });

  test("pact: with one active, offers to break it", () => {
    const { p, emitted } = params({ pactExpiresAt: 3000 });
    const pact = diplomacyMenuElement.subMenu!(p).find(
      (i) => i.id === "diplomacy_pact",
    )!;
    const [brk] = pact.subMenu!(p);
    expect(brk.id).toBe("pact_break");
    brk.action!(p);
    expect(emitted[0].intent).toEqual({ type: "pact_break", target: "p2" });
  });

  test("pact: an offer from them can be signed or declined", () => {
    const { p, emitted } = params({ pactOfferedMinutes: 20 });
    const pact = diplomacyMenuElement.subMenu!(p).find(
      (i) => i.id === "diplomacy_pact",
    )!;
    expect(pact.disabled(p)).toBe(false);
    const items = pact.subMenu!(p);
    expect(items.map((i) => i.id)).toEqual(["pact_sign", "pact_decline"]);
    items[0].action!(p);
    expect(emitted[0].intent).toEqual({
      type: "pact_reply",
      proposer: "p2",
      accept: true,
    });
  });

  test("pact: while ours is pending, it says so", () => {
    const { p } = params({ pactAwaitingReply: true });
    const pact = diplomacyMenuElement.subMenu!(p).find(
      (i) => i.id === "diplomacy_pact",
    )!;
    expect(pact.disabled(p)).toBe(false);
    const [waiting] = pact.subMenu!(p);
    expect(waiting.id).toBe("pact_waiting");
    expect(waiting.disabled(p)).toBe(true);
  });

  test("coalition actions follow the flags", () => {
    const ids = (flags: object) =>
      diplomacyMenuElement.subMenu!(params(flags).p).map((i) => i.id);
    expect(ids({})).not.toContain("coalition_invite");
    expect(ids({ canCoalitionInvite: true, canCoalitionTarget: true })).toEqual(
      expect.arrayContaining(["coalition_invite", "coalition_target"]),
    );
  });

  test("ask to join their coalition", () => {
    const them = {
      ...player("p2"),
      coalition: () => ({ id: 7, name: "Pact" }),
    };
    const { p, emitted } = params({ canRequestJoin: true }, them);
    const item = diplomacyMenuElement.subMenu!(p).find(
      (i) => i.id === "coalition_request",
    )!;
    expect(item.disabled(p)).toBe(false);
    item.action!(p);
    expect(emitted[0].intent).toEqual({
      type: "coalition_request",
      coalitionID: 7,
    });
  });

  test("their request to join ours can be accepted", () => {
    const { p, emitted } = params({ coalitionRequestFromThem: true });
    const item = diplomacyMenuElement.subMenu!(p).find(
      (i) => i.id === "coalition_request_accept",
    )!;
    item.action!(p);
    expect(emitted[0].intent).toEqual({
      type: "coalition_request_reply",
      applicant: "p2",
      accept: true,
    });
  });

  test("messages send diplomacy quick-chat phrases", () => {
    const { p, emitted } = params({});
    const chat = diplomacyMenuElement.subMenu!(p).find(
      (i) => i.id === "diplomacy_chat",
    )!;
    const phrases = chat.subMenu!(p);
    expect(phrases).toHaveLength(5);
    phrases[0].action!(p);
    expect(emitted[0].quickChatKey).toBe("diplomacy.pact");
  });

  test("on your own land it opens the panel", () => {
    const me = player("p1");
    const { p, emitted } = params({}, me);
    p.myPlayer = me;
    const [open] = diplomacyMenuElement.subMenu!(p);
    open.action!(p);
    expect(emitted[0].open).toBe(true);
  });
});
