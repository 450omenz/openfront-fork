/**
 * Fork: an "ally under attack" entry carries the attack (attacker and target
 * smallIDs). Clicking it moves the camera to that attack's front, the same
 * spot the incoming-attack warnings go to, or to the target once the attack
 * is over.
 */

vi.mock("lit", () => ({
  html: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings,
    values,
  }),
  LitElement: class extends EventTarget {
    requestUpdate() {}
  },
}));

vi.mock("lit/decorators.js", () => ({
  customElement: () => (clazz: unknown) => clazz,
  state: () => () => {},
  property: () => () => {},
  query: () => () => {},
}));

vi.mock("lit/directive.js", () => ({}));
vi.mock("lit/directives/unsafe-html.js", () => ({
  unsafeHTML: (s: string) => s,
}));

vi.mock("../../../../src/client/Utils", () => ({
  translateText: vi.fn((key: string) => key),
  getMessageTypeClasses: vi.fn(() => ""),
}));
vi.mock("@openfront/engine-lib/Format", () => ({
  renderNumber: vi.fn(),
  renderTroops: vi.fn(),
}));

import { MessageType } from "@openfront/engine-api/game/GameTypes";
import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventsDisplay } from "../../../../src/client/hud/layers/EventsDisplay";
import {
  GoToPlayerEvent,
  GoToPositionEvent,
} from "../../../../src/client/TransformHandler";
import { PlayerView } from "../../../../src/client/view/PlayerView";

describe("EventsDisplay conflict focus", () => {
  let ed: EventsDisplay;
  let emit: ReturnType<typeof vi.fn>;
  const me = { smallID: () => 1, displayName: () => "Me" };
  const ally = { smallID: () => 2, displayName: () => "Ally" };
  let attacks: { id: string; targetID: number; retreating: boolean }[];
  let attacker: PlayerView;

  beforeEach(() => {
    attacks = [{ id: "a1", targetID: 2, retreating: false }];
    attacker = Object.assign(Object.create(PlayerView.prototype), {
      smallID: () => 3,
      outgoingAttacks: () => attacks,
      attackClusteredPositions: vi.fn(async (id: string) => [
        { id, positions: [{ x: 40, y: 50 }] },
      ]),
    });
    ed = new EventsDisplay();
    (ed as unknown as { game: unknown }).game = {
      myPlayer: () => me,
      ticks: () => 0,
      unit: () => undefined,
      playerBySmallID: (id: number) =>
        id === 3 ? attacker : id === 2 ? ally : me,
    };
    emit = vi.fn();
    (ed as unknown as { eventBus: unknown }).eventBus = { emit };
  });

  it("keeps the conflict on the feed entry", () => {
    ed.onDisplayMessageEvent({
      type: GameUpdateType.DisplayEvent,
      message: "ally under attack",
      messageType: MessageType.ATTACK_REQUEST,
      playerID: 1,
      focusPlayerID: 2,
      conflict: { attackerID: 3, targetID: 2 },
    });
    const events = (
      ed as unknown as {
        events: { conflict?: { attackerID: number; targetID: number } }[];
      }
    ).events;
    expect(events[0].conflict).toEqual({ attackerID: 3, targetID: 2 });
  });

  it("goes to the front of the attack", async () => {
    await ed.focusConflict(3, 2);
    expect(attacker.attackClusteredPositions).toHaveBeenCalledWith("a1");
    const ev = emit.mock.calls[0][0];
    expect(ev).toBeInstanceOf(GoToPositionEvent);
    expect([ev.x, ev.y]).toEqual([40, 50]);
  });

  it("goes to the ally once the attack is over", async () => {
    attacks = [];
    await ed.focusConflict(3, 2);
    const ev = emit.mock.calls[0][0];
    expect(ev).toBeInstanceOf(GoToPlayerEvent);
    expect(ev.player).toBe(ally);
  });
});
