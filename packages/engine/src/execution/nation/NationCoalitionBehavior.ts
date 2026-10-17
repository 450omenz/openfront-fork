import { PlayerType, Relation } from "@openfront/engine-api/game/GameTypes";
import {
  COALITION_NAME_MAX,
  COALITION_NAME_REGEX,
} from "@openfront/engine-api/Schemas";
import { Coalition, Game, Player } from "../../game/Game";
import { archetypeOf, personalityOf } from "../../game/NationPersonality";
import { isValuedPartner } from "./NationTradeBehavior";

/**
 * Nations in coalitions (fork). Once per decision cycle a nation:
 *
 *  - answers invites: yes when it doesn't distrust the inviter and has a
 *    reason (a trade partner or friend inside, safety in numbers, or a
 *    loyal/diplomatic streak), never when it hates a member;
 *  - as a member, leaves when it has come to distrust the leader and isn't
 *    loyal, or (opportunists) when it could swallow a bordering member;
 *  - as leader, invites friends and trade partners, sanctions players that
 *    several members are hostile to (and lifts that when it fades), and
 *    orders an attack on a hostile neighbor of the coalition; a founder
 *    nobody joins disbands after a while;
 *  - founds a coalition when ambitious, with friends or partners to ask.
 *
 * Following orders is an attack strategy (AiAttackBehavior). Only nations
 * with a personality take part, and no PRNG draws are made, so with
 * personalities off nothing changes. Stateless: the coalition manager and
 * relations hold everything.
 */
export class NationCoalitionBehavior {
  constructor(
    private game: Game,
    private player: Player,
  ) {}

  handleCoalitions(): void {
    const coalitions = this.game.coalitions();
    if (!coalitions.enabled() || archetypeOf(this.player) === undefined) {
      return;
    }
    const mine = coalitions.of(this.player);
    if (mine === null) {
      if (this.answerInvites()) return;
      this.maybeFound();
      return;
    }
    if (mine.leader() === this.player) {
      this.lead(mine);
    } else {
      this.maybeLeave(mine);
    }
  }

  private answerInvites(): boolean {
    const coalitions = this.game.coalitions();
    for (const invite of coalitions.invitesFor(this.player)) {
      const accept = this.wantsToJoin(invite.coalition, invite.inviter);
      coalitions.reply(this.player, invite.coalition.id(), accept);
      if (accept && coalitions.of(this.player) !== null) return true;
    }
    return false;
  }

  wantsToJoin(c: Coalition, inviter: Player): boolean {
    const me = this.player;
    const p = personalityOf(me);
    if (me.relation(inviter) < Relation.Neutral) return false;
    if (c.members().some((m) => me.relation(m) <= Relation.Hostile)) {
      return false;
    }
    if (inviter.isTraitor() && p.loyalty >= 50) return false;
    const reasons =
      me.relation(inviter) >= Relation.Friendly ||
      c.members().some((m) => isValuedPartner(this.game, me, m)) ||
      // Safety in numbers for the cautious.
      (p.caution >= 60 && totalTroops(c.members()) > me.troops() * 2) ||
      p.loyalty >= JOIN_LOYALTY;
    return reasons;
  }

  private maybeLeave(c: Coalition): void {
    const me = this.player;
    const p = personalityOf(me);
    const fallenOut =
      me.relation(c.leader()) <= Relation.Distrustful &&
      p.loyalty < LEAVE_LOYALTY;
    // Opportunists break ranks when a neighboring member is easy prey.
    const prey =
      p.loyalty < BETRAY_LOYALTY &&
      c
        .members()
        .some(
          (m) =>
            m !== me &&
            me.sharesBorderWith(m) &&
            me.troops() >= m.troops() * BETRAY_TROOP_RATIO,
        );
    if (fallenOut || prey) this.game.coalitions().leave(me);
  }

  private lead(c: Coalition): void {
    const coalitions = this.game.coalitions();
    const me = this.player;

    // Invite one candidate per cycle, the best trade partner first.
    if (c.size() === 1) {
      // Nobody came: give up on it after a while.
      if (this.game.ticks() - c.createdAt() > SOLO_GIVE_UP_TICKS) {
        coalitions.leave(me);
        return;
      }
    }

    if (c.size() < this.game.config().coalitionMaxMembers()) {
      const candidate = this.candidates()
        .filter((o) => coalitions.canInvite(me, o))
        .sort(
          (a, b) =>
            Number(me.tradeVolumeWith(b) - me.tradeVolumeWith(a)) ||
            a.smallID() - b.smallID(),
        )[0];
      if (candidate !== undefined) coalitions.invite(me, candidate);
    }

    // Sanctions and orders need someone to give them to.
    if (c.size() < 2) return;

    // Sanctions follow the members' grudges.
    for (const other of this.game.players()) {
      if (other === me || c.has(other) || other.type() === PlayerType.Bot) {
        continue;
      }
      const haters = c
        .members()
        .filter((m) => m.relation(other) <= Relation.Hostile).length;
      const sanctioned = c.sanctions().has(other);
      if (!sanctioned && haters >= SANCTION_HATERS && other.isAlive()) {
        coalitions.setSanction(me, other, true);
      } else if (sanctioned && haters === 0) {
        coalitions.setSanction(me, other, false);
      }
    }

    // An attack order on the weakest hostile neighbor of the coalition.
    if (c.target() === null) {
      const target = this.orderTarget(c);
      if (target !== null) coalitions.setTarget(me, target);
    }
  }

  private orderTarget(c: Coalition): Player | null {
    const me = this.player;
    let best: Player | null = null;
    for (const m of c.members()) {
      for (const n of m.nearby()) {
        if (!n.isPlayer() || c.has(n) || n.type() === PlayerType.Bot) continue;
        if (me.relation(n) > Relation.Hostile) continue;
        if (!this.game.coalitions().canTarget(me, n)) continue;
        if (
          best === null ||
          n.troops() < best.troops() ||
          (n.troops() === best.troops() && n.smallID() < best.smallID())
        ) {
          best = n;
        }
      }
    }
    return best;
  }

  private maybeFound(): void {
    const coalitions = this.game.coalitions();
    if (personalityOf(this.player).ambition < FOUND_AMBITION) return;
    if (!coalitions.canCreate(this.player)) return;
    if (this.candidates().length < FOUND_CANDIDATES) return;
    coalitions.create(this.player, coalitionName(this.player));
  }

  // Players worth having: alive, not bots, outside any coalition, and
  // friends or valued trade partners.
  private candidates(): Player[] {
    const me = this.player;
    return this.game
      .players()
      .filter(
        (o) =>
          o !== me &&
          o.isAlive() &&
          o.type() !== PlayerType.Bot &&
          this.game.coalitions().of(o) === null &&
          (me.relation(o) >= Relation.Friendly ||
            isValuedPartner(this.game, me, o)),
      );
  }
}

// Personality thresholds.
const JOIN_LOYALTY = 70;
const LEAVE_LOYALTY = 40;
const BETRAY_LOYALTY = 25;
const BETRAY_TROOP_RATIO = 3;
const FOUND_AMBITION = 60;
const FOUND_CANDIDATES = 2;
// A founder still alone after this long (3 minutes) disbands.
const SOLO_GIVE_UP_TICKS = 3 * 60 * 10;
// Members hostile to a player before the leader sanctions them.
const SANCTION_HATERS = 2;

function totalTroops(players: readonly Player[]): number {
  return players.reduce((sum, p) => sum + p.troops(), 0);
}

/** "<Nation> Pact", reduced to the characters coalition names allow. */
export function coalitionName(player: Player): string {
  const suffix = " Pact";
  const base = [...player.displayName()]
    .filter((ch) => /[\p{L}\p{N} '._-]/u.test(ch))
    .join("")
    .trim()
    .slice(0, COALITION_NAME_MAX - suffix.length)
    .trim();
  const name = `${base}${suffix}`;
  return COALITION_NAME_REGEX.test(name) ? name : `Pact ${player.smallID()}`;
}
