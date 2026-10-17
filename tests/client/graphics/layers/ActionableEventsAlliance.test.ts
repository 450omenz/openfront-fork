import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";

vi.mock("lit", () => ({
  html: () => {},
  LitElement: class {},
}));

vi.mock("lit/decorators.js", () => ({
  customElement: () => (clazz: any) => clazz,
  query: () => () => {},
  state: () => () => {},
  property: () => () => {},
}));

vi.mock("lit/directive.js", () => ({
  DirectiveResult: class {},
}));

vi.mock("lit/directives/unsafe-html.js", () => ({
  unsafeHTML: () => {},
  UnsafeHTMLDirective: class {},
}));

import { MessageType } from "@openfront/engine-api/game/GameTypes";
import { ActionableEvents } from "../../../../src/client/hud/layers/ActionableEvents";

describe("ActionableEvents - alliance renewal cleanup (allianceID based)", () => {
  function makeRenewal(
    allianceID: number,
    focusID: number,
    description = "Alliance about to expire",
  ) {
    return {
      description,
      type: MessageType.RENEW_ALLIANCE,
      allianceID,
      focusID,
      createdAt: 0,
    };
  }

  test("removes ONLY renewal events for the broken alliance", () => {
    const display = new ActionableEvents();

    const allianceAB = 1;
    const allianceAC = 2;
    const allianceBC = 3;

    (display as any).events = [
      makeRenewal(allianceAB, 1), // A–B
      makeRenewal(allianceAC, 1), // A–C
      makeRenewal(allianceBC, 2), // B–C
    ];

    // Break alliance A–B
    (display as any).removeAllianceRenewalEvents(allianceAB);

    const remaining = (display as any).events;

    // A–B renewal removed
    expect(remaining.some((e: any) => e.allianceID === allianceAB)).toBe(false);

    // Other alliances untouched
    expect(remaining.some((e: any) => e.allianceID === allianceAC)).toBe(true);

    expect(remaining.some((e: any) => e.allianceID === allianceBC)).toBe(true);
  });

  test("does NOT remove renewals just because the same player is involved", () => {
    const display = new ActionableEvents();

    const allianceAB = 10;
    const allianceAC = 11;

    (display as any).events = [
      makeRenewal(allianceAB, 1), // Player 1 involved
      makeRenewal(allianceAC, 1), // Same player, different alliance
    ];

    (display as any).removeAllianceRenewalEvents(allianceAB);

    const remaining = (display as any).events;

    expect(remaining.length).toBe(1);
    expect(remaining[0].allianceID).toBe(allianceAC);
  });

  test("breaking one alliance does not affect renewals between other players", () => {
    const display = new ActionableEvents();

    const allianceAB = 100;
    const allianceCD = 200;

    (display as any).events = [
      makeRenewal(allianceAB, 1), // A–B
      makeRenewal(allianceCD, 3), // C–D
    ];

    (display as any).removeAllianceRenewalEvents(allianceAB);

    const remaining = (display as any).events;

    expect(remaining.length).toBe(1);
    expect(remaining[0].allianceID).toBe(allianceCD);
  });

  test("onAllianceExtensionEvent removes renewal when playerID matches myPlayer", () => {
    const display = new ActionableEvents();

    const allianceID = 42;
    const mySmallID = 7;

    (display as any).game = {
      myPlayer: () => ({ smallID: () => mySmallID }),
    };
    (display as any).requestUpdate = () => {};
    (display as any).events = [makeRenewal(allianceID, mySmallID)];

    (display as any).onAllianceExtensionEvent({
      type: GameUpdateType.AllianceExtension,
      playerID: mySmallID,
      allianceID,
    });

    const remaining = (display as any).events;
    expect(remaining.some((e: any) => e.allianceID === allianceID)).toBe(false);
  });

  test("onAllianceExtensionEvent keeps renewal when playerID does not match myPlayer", () => {
    const display = new ActionableEvents();

    const allianceID = 42;
    const mySmallID = 7;
    const otherSmallID = 9;

    (display as any).game = {
      myPlayer: () => ({ smallID: () => mySmallID }),
    };
    (display as any).requestUpdate = () => {};
    (display as any).events = [makeRenewal(allianceID, mySmallID)];

    (display as any).onAllianceExtensionEvent({
      type: "AllianceExtension",
      playerID: otherSmallID,
      allianceID,
    });

    const remaining = (display as any).events;
    expect(remaining.some((e: any) => e.allianceID === allianceID)).toBe(true);
  });

  test("onAllianceExtensionEvent keeps renewal when myPlayer is null", () => {
    const display = new ActionableEvents();

    const allianceID = 42;

    (display as any).game = {
      myPlayer: () => null,
    };
    (display as any).requestUpdate = () => {};
    (display as any).events = [makeRenewal(allianceID, 1)];

    (display as any).onAllianceExtensionEvent({
      type: "AllianceExtension",
      playerID: 1,
      allianceID,
    });

    const remaining = (display as any).events;
    expect(remaining.some((e: any) => e.allianceID === allianceID)).toBe(true);
  });

  test("does not affect non-RENEW_ALLIANCE events", () => {
    const display = new ActionableEvents();

    (display as any).events = [
      {
        description: "Alliance broken",
        type: MessageType.ALLIANCE_BROKEN,
        createdAt: 0,
      },
      {
        description: "Alliance accepted",
        type: MessageType.ALLIANCE_ACCEPTED,
        createdAt: 0,
      },
      {
        description: "Renewal",
        type: MessageType.RENEW_ALLIANCE,
        allianceID: 999,
        createdAt: 0,
      },
    ];

    (display as any).removeAllianceRenewalEvents(999);

    const remaining = (display as any).events;

    expect(
      remaining.some((e: any) => e.type === MessageType.ALLIANCE_BROKEN),
    ).toBe(true);

    expect(
      remaining.some((e: any) => e.type === MessageType.ALLIANCE_ACCEPTED),
    ).toBe(true);

    expect(
      remaining.some((e: any) => e.type === MessageType.RENEW_ALLIANCE),
    ).toBe(false);
  });
});

// Fork: coalition invites and pact proposals used to share the alliance
// request check and vanished on the next tick.
describe("ActionableEvents - coalition and pact cards", () => {
  const inviter = (opts: { coalition?: object | null } = {}) => ({
    isAlive: () => true,
    isRequestingAllianceWith: () => false, // not an alliance request
    coalition: () => opts.coalition ?? { id: 1 },
  });

  function display(me: object, from: object) {
    const d = new ActionableEvents();
    (d as any).game = {
      ticks: () => 10,
      myPlayer: () => me,
      playerBySmallID: () => from,
    };
    return d;
  }

  const card = (kind: "coalition" | "pact") => ({
    description: "",
    type: MessageType.ALLIANCE_REQUEST,
    createdAt: 0,
    duration: 200,
    focusID: 2,
    requestorID: 2,
    buttons: [],
    kind,
  });

  test("a coalition invite stays while it can still be accepted", () => {
    const me = { coalition: () => null };
    const d = display(me, inviter());
    expect((d as any).eventStillValid(card("coalition"))).toBe(true);
  });

  test("a coalition invite goes once we're in a coalition", () => {
    const me = { coalition: () => ({ id: 3 }) };
    const d = display(me, inviter());
    expect((d as any).eventStillValid(card("coalition"))).toBe(false);
  });

  test("a pact proposal stays until a pact exists", () => {
    let pact: object | null = null;
    const me = { pactWith: () => pact };
    const d = display(me, inviter());
    expect((d as any).eventStillValid(card("pact"))).toBe(true);
    pact = { aID: 1, bID: 2 };
    expect((d as any).eventStillValid(card("pact"))).toBe(false);
  });

  test("an alliance reply from the same player leaves them alone", () => {
    const d = new ActionableEvents();
    (d as any).game = { myPlayer: () => ({ smallID: () => 1 }) };
    (d as any).requestUpdate = () => {};
    (d as any).events = [card("coalition"), card("pact")];
    (d as any).onAllianceRequestReplyEvent({
      request: { recipientID: 1, requestorID: 2 },
    });
    expect((d as any).events).toHaveLength(2);
  });
});
