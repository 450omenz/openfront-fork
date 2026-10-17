import {
  Archetype,
  BANNABLE_WEAPONS,
  PlayerType,
  Relation,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
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
 *    loyal, or (opportunists) when it could swallow a bordering member, or
 *    (warlike, not loyal) when the coalition bans weapons it relies on;
 *  - as leader, bans weapons by temperament: the cautious and diplomats
 *    ban hydrogen bombs and MIRVs (very cautious: atom bombs too), the
 *    peaceful ban tanks, the aggressive ban nothing;
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
    if (this.chafesAtBans(c)) return false;
    const bansNukes = c.bannedWeapons().has(UnitType.HydrogenBomb);
    // Under attack by someone outside the coalition: it would defend us.
    const besieged = me
      .incomingAttacks()
      .some((a) => !c.has(a.attacker()) && a.attacker() !== me);
    // Safety in numbers: the cautious count it sooner.
    const strength = totalTroops(c.members());
    const strongEnough =
      strength > me.troops() * (p.caution >= 60 ? 1 : STRENGTH_RATIO);
    const reasons =
      // The cautious like a coalition that outlaws the worst weapons.
      (bansNukes && p.caution >= 60) ||
      me.relation(inviter) >= Relation.Friendly ||
      c.members().some((m) => isValuedPartner(this.game, me, m)) ||
      besieged ||
      strongEnough ||
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
    if (fallenOut || prey || this.chafesAtBans(c)) {
      this.game.coalitions().leave(me);
    }
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

    // Sanctions, bans and orders need someone to give them to.
    if (c.size() < 2) return;

    const wanted = desiredBans(me);
    for (const weapon of BANNABLE_WEAPONS) {
      const on = wanted.has(weapon);
      if (on !== c.bannedWeapons().has(weapon)) {
        coalitions.setWeaponBan(me, weapon, on);
      }
    }

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
    // Whoever broke the coalition's weapon ban recently comes first.
    const now = this.game.ticks();
    for (const [violator, tick] of c.violators()) {
      if (
        now - tick < VIOLATOR_MEMORY_TICKS &&
        this.game.coalitions().canTarget(me, violator)
      ) {
        return violator;
      }
    }
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

  // A warlike, not very loyal nation won't live with a ban on weapons it
  // has invested in (tanks it owns, silos for nukes).
  private chafesAtBans(c: Coalition): boolean {
    const me = this.player;
    const p = personalityOf(me);
    if (p.aggression < CHAFE_AGGRESSION || p.loyalty >= CHAFE_LOYALTY) {
      return false;
    }
    const bans = c.bannedWeapons();
    const tanks = bans.has(UnitType.Tank) && me.units(UnitType.Tank).length > 0;
    const nukes =
      (bans.has(UnitType.AtomBomb) ||
        bans.has(UnitType.HydrogenBomb) ||
        bans.has(UnitType.MIRV)) &&
      me.units(UnitType.MissileSilo).length > 0;
    return tanks || nukes;
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

// What a nation leader bans, by temperament.
export function desiredBans(leader: Player): Set<UnitType> {
  const p = personalityOf(leader);
  const bans = new Set<UnitType>();
  if (p.aggression >= 70) return bans;
  if (p.caution >= 60 || p.archetype === Archetype.Diplomat) {
    bans.add(UnitType.HydrogenBomb);
    bans.add(UnitType.MIRV);
  }
  if (p.caution >= 75) bans.add(UnitType.AtomBomb);
  if (p.aggression <= 30) bans.add(UnitType.Tank);
  return bans;
}

// Personality thresholds.
const CHAFE_AGGRESSION = 75;
const CHAFE_LOYALTY = 60;
// Violations older than this (5 minutes) no longer drive attack orders.
const VIOLATOR_MEMORY_TICKS = 5 * 60 * 10;
const JOIN_LOYALTY = 60;
// Without other reasons, a coalition this many times our troops is worth
// joining (cautious nations: as strong as us).
const STRENGTH_RATIO = 1.5;
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
