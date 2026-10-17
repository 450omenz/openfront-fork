import { PlayerType, Relation } from "@openfront/engine-api/game/GameTypes";
import { Game, Player } from "../../game/Game";
import { archetypeOf, personalityOf } from "../../game/NationPersonality";
import { isValuedPartner } from "./NationTradeBehavior";

/**
 * Nations and non-aggression pacts (fork). Once per decision cycle:
 *
 *  - Proposals are answered: yes to a stronger neighbor, when busy fighting
 *    someone else, to a valued trade partner, or when cautious; no to
 *    someone hated, to a traitor (if loyal), or — for the aggressive — to
 *    a weaker neighbor it would rather conquer.
 *  - Cautious nations (55+) ask their strongest non-friendly land neighbor
 *    for a pact when it outnumbers them, for longer the more cautious
 *    they are.
 *
 * Keeping or breaking pacts happens in the attack code (respectsPact).
 * Nations with a personality only; no PRNG draws; stateless (the pact
 * manager keeps proposals and refusals).
 */
export class NationPactBehavior {
  constructor(
    private game: Game,
    private player: Player,
  ) {}

  handlePacts(): void {
    const pacts = this.game.pacts();
    if (!pacts.enabled() || archetypeOf(this.player) === undefined) return;
    for (const proposal of pacts.proposalsFor(this.player)) {
      pacts.reply(
        this.player,
        proposal.proposer,
        this.wantsPact(proposal.proposer),
      );
    }
    this.maybePropose();
  }

  wantsPact(other: Player): boolean {
    const me = this.player;
    const p = personalityOf(me);
    if (me.relation(other) <= Relation.Hostile) return false;
    if (other.isTraitor() && p.loyalty >= 50) return false;
    if (
      p.aggression >= GREEDY_AGGRESSION &&
      other.troops() < me.troops() * 0.7
    ) {
      return false; // easier to conquer than to promise peace
    }
    if (other.troops() > me.troops() * 1.2) return true;
    const busy =
      me.incomingAttacks().some((a) => a.attacker() !== other) ||
      me
        .outgoingAttacks()
        .some((a) => a.target().isPlayer() && a.target() !== other);
    if (busy) return true;
    if (isValuedPartner(this.game, me, other)) return true;
    if (p.caution >= 60) return true;
    return me.relation(other) >= Relation.Neutral && p.aggression < 50;
  }

  private maybePropose(): void {
    const me = this.player;
    const p = personalityOf(me);
    if (p.caution < PROPOSE_CAUTION) return;
    const pacts = this.game.pacts();
    let best: Player | null = null;
    for (const n of me.nearby()) {
      if (!n.isPlayer() || n.type() === PlayerType.Bot) continue;
      if (me.relation(n) <= Relation.Hostile) continue;
      if (n.troops() <= me.troops()) continue;
      if (!pacts.canPropose(me, n)) continue;
      if (
        best === null ||
        n.troops() > best.troops() ||
        (n.troops() === best.troops() && n.smallID() < best.smallID())
      ) {
        best = n;
      }
    }
    if (best === null) return;
    const minutes = p.caution >= 80 ? 20 : p.caution >= 65 ? 10 : 5;
    pacts.propose(me, best, minutes);
  }
}

const GREEDY_AGGRESSION = 75;
const PROPOSE_CAUTION = 55;
