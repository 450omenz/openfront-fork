import { MessageType, Relation } from "@openfront/engine-api/game/GameTypes";
import { Game, Player } from "../../game/Game";
import { archetypeOf, personalityOf } from "../../game/NationPersonality";
import { NationCoalitionBehavior } from "./NationCoalitionBehavior";
import { NationPactBehavior } from "./NationPactBehavior";

/**
 * Nations answer the Diplomacy quick-chat phrases (fork), with the same
 * judgement their own diplomacy uses, and act on a yes:
 *
 *   diplomacy.pact       propose a 10-minute pact back (NationPactBehavior)
 *   diplomacy.ceasefire  call off attacks on the sender and propose a pact
 *   diplomacy.join_you   (as a coalition leader) invite the sender
 *   diplomacy.join_me    say whether they'd accept the sender's invite
 *   diplomacy.trade      lift their embargo (merchant-minded, not hostile)
 *
 * The answer reaches the sender as a message. Only nations with a
 * personality answer. Deterministic (no PRNG draws).
 */
export function answerDiplomacyChat(
  game: Game,
  nation: Player,
  sender: Player,
  key: string,
): void {
  if (archetypeOf(nation) === undefined || nation === sender) return;
  const reply = (msg: string, params: Record<string, string> = {}) =>
    game.displayMessage(
      msg,
      MessageType.CHAT,
      sender.id(),
      undefined,
      { name: nation.displayName(), ...params },
      undefined,
      nation.id(),
    );
  const judge = new NationPactBehavior(game, nation);
  switch (key) {
    case "diplomacy.pact": {
      const manager = game.pacts();
      if (
        judge.wantsPact(sender) &&
        manager.canPropose(nation, sender) &&
        manager.propose(nation, sender, 10)
      ) {
        reply("events_display.diplomacy_pact_yes");
      } else {
        reply("events_display.diplomacy_no");
      }
      return;
    }
    case "diplomacy.ceasefire": {
      if (!judge.wantsPact(sender)) {
        reply("events_display.diplomacy_no");
        return;
      }
      for (const a of nation.outgoingAttacks()) {
        if (a.target() === sender && !a.retreating()) a.orderRetreat();
      }
      if (game.pacts().canPropose(nation, sender)) {
        game.pacts().propose(nation, sender, 10);
      }
      reply("events_display.diplomacy_ceasefire_yes");
      return;
    }
    case "diplomacy.join_you": {
      const c = game.coalitions().of(nation);
      if (c === null || c.leader() !== nation) {
        reply("events_display.diplomacy_no_coalition");
        return;
      }
      const welcome =
        nation.relation(sender) >= Relation.Neutral &&
        !c.members().some((m) => m.relation(sender) <= Relation.Hostile);
      if (welcome && game.coalitions().invite(nation, sender)) {
        reply("events_display.diplomacy_join_you_yes", { coalition: c.name() });
      } else {
        reply("events_display.diplomacy_no");
      }
      return;
    }
    case "diplomacy.join_me": {
      const c = game.coalitions().of(sender);
      const yes =
        c !== null &&
        game.coalitions().of(nation) === null &&
        new NationCoalitionBehavior(game, nation).wantsToJoin(c, sender);
      reply(
        yes
          ? "events_display.diplomacy_join_me_yes"
          : "events_display.diplomacy_no",
      );
      return;
    }
    case "diplomacy.trade": {
      const yes =
        nation.hasEmbargoAgainst(sender) &&
        nation.relation(sender) > Relation.Hostile &&
        personalityOf(nation).mercantilism >= 50;
      if (yes) {
        nation.stopEmbargo(sender);
        reply("events_display.diplomacy_trade_yes");
      } else {
        reply("events_display.diplomacy_no");
      }
      return;
    }
  }
}
