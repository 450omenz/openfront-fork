import {
  GameMode,
  MessageType,
  PlayerType,
  Tick,
} from "@openfront/engine-api/game/GameTypes";
import {
  CoalitionView,
  GameUpdateType,
} from "@openfront/engine-api/game/GameUpdates";
import {
  COALITION_NAME_MAX,
  COALITION_NAME_REGEX,
} from "@openfront/engine-api/Schemas";
import {
  snapshotType,
  zInt,
  zPlayerRef,
} from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import type {
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";
import { Coalition, CoalitionInvite, Coalitions, Game, Player } from "./Game";
import type { GameImpl } from "./GameImpl";
import { cancelNukesBetween } from "./NukeCancel";

/**
 * Coalitions (fork): standing groups of players at peace with each other.
 *
 *  - Members are friendly (Player.isFriendly), like teammates: they can't
 *    attack or nuke each other, and they get the alliance war effects
 *    (ally support, joint attacks, lent training; see Military.ts).
 *    Membership doesn't expire. Joining drops pairwise alliances with
 *    members, which are redundant.
 *  - Leaving is breaking the peace: the leaver is marked a traitor, like
 *    breaking an alliance, and can't join any coalition for a while.
 *    Being kicked carries no stigma, only the cooldown.
 *  - The leader invites, kicks, hands over leadership, sanctions players
 *    (no trade between them and any member: Player.canTrade) and issues an
 *    attack order (a coalition target: every member's transitive target;
 *    members attacking it count as a joint attack).
 *  - When the leader leaves or is eliminated, the member with the most
 *    land leads. A coalition down to one member dissolves.
 *
 * Off when alliances are disabled and in team games. All mutations go
 * through this class, which validates them (they can come from any client)
 * and sends the full coalition list to clients after each change.
 */
export class CoalitionImpl implements Coalition {
  /** Join order; the leader is always a member. */
  _members: Player[];
  _sanctions = new Set<Player>();
  _target: { player: Player; tick: Tick } | null = null;
  _lastTargetTick: Tick = -Infinity;

  constructor(
    private readonly game: Game,
    private readonly _id: number,
    private _name: string,
    public _leader: Player,
    private readonly _createdAt: Tick,
  ) {
    this._members = [_leader];
  }

  id(): number {
    return this._id;
  }
  name(): string {
    return this._name;
  }
  leader(): Player {
    return this._leader;
  }
  members(): readonly Player[] {
    return this._members;
  }
  size(): number {
    return this._members.length;
  }
  has(p: Player): boolean {
    return this._members.includes(p);
  }
  sanctions(): ReadonlySet<Player> {
    return this._sanctions;
  }
  target(): Player | null {
    const t = this._target;
    if (t === null) return null;
    if (
      this.game.ticks() - t.tick >=
      this.game.config().coalitionTargetDuration()
    ) {
      return null;
    }
    return t.player.isAlive() ? t.player : null;
  }
  createdAt(): Tick {
    return this._createdAt;
  }
}

export class CoalitionManager implements Coalitions {
  private list: CoalitionImpl[] = [];
  private nextID = 1;
  private invites: CoalitionInvite[] = [];
  // Tick a player last left or was kicked out of a coalition.
  private leftAt = new Map<Player, Tick>();
  // Derived: each member's coalition (isFriendly asks a lot).
  private index = new Map<Player, CoalitionImpl>();

  constructor(private readonly game: GameImpl) {}

  enabled(): boolean {
    const config = this.game.config();
    return (
      !config.disableAlliances() &&
      config.gameConfig().gameMode !== GameMode.Team
    );
  }

  all(): readonly Coalition[] {
    return this.list;
  }

  of(p: Player): Coalition | null {
    return this.implOf(p);
  }

  get(id: number): Coalition | null {
    return this.list.find((c) => c.id() === id) ?? null;
  }

  invitesFor(p: Player): readonly CoalitionInvite[] {
    const now = this.game.ticks();
    return this.invites.filter((i) => i.recipient === p && this.live(i, now));
  }

  // --- checks (also used for the UI's action flags) ---

  canCreate(p: Player): boolean {
    return this.enabled() && this.eligible(p) && this.implOf(p) === null;
  }

  canInvite(leader: Player, target: Player): boolean {
    const c = this.ledBy(leader);
    return (
      c !== null &&
      target !== leader &&
      this.eligible(target) &&
      this.implOf(target) === null &&
      !c._sanctions.has(target) &&
      c.size() < this.game.config().coalitionMaxMembers() &&
      !this.invites.some(
        (i) =>
          i.coalition === c &&
          i.recipient === target &&
          this.live(i, this.game.ticks()),
      )
    );
  }

  canKick(leader: Player, target: Player): boolean {
    const c = this.ledBy(leader);
    return c !== null && target !== leader && c.has(target);
  }

  canSanction(leader: Player, target: Player): boolean {
    const c = this.ledBy(leader);
    return (
      c !== null &&
      !c.has(target) &&
      target.isAlive() &&
      target.type() !== PlayerType.Bot
    );
  }

  canTarget(leader: Player, target: Player): boolean {
    const c = this.ledBy(leader);
    return (
      c !== null &&
      !c.has(target) &&
      target.isAlive() &&
      this.game.ticks() - c._lastTargetTick >=
        this.game.config().coalitionTargetCooldown()
    );
  }

  // --- mutations: each validates, and returns whether it happened ---

  create(founder: Player, name: string): Coalition | null {
    const clean = name.trim();
    if (
      !this.canCreate(founder) ||
      clean.length === 0 ||
      clean.length > COALITION_NAME_MAX ||
      !COALITION_NAME_REGEX.test(clean)
    ) {
      return null;
    }
    const c = new CoalitionImpl(
      this.game,
      this.nextID++,
      clean,
      founder,
      this.game.ticks(),
    );
    this.list.push(c);
    this.index.set(founder, c);
    this.dropInvitesTo(founder);
    this.emit();
    return c;
  }

  invite(leader: Player, target: Player): boolean {
    if (!this.canInvite(leader, target)) return false;
    const c = this.implOf(leader)!;
    const invite: CoalitionInvite = {
      coalition: c,
      inviter: leader,
      recipient: target,
      createdAt: this.game.ticks(),
    };
    this.invites.push(invite);
    this.game.addUpdate({
      type: GameUpdateType.CoalitionInvite,
      coalitionID: c.id(),
      name: c.name(),
      inviterID: leader.smallID(),
      recipientID: target.smallID(),
      expiresAt:
        invite.createdAt + this.game.config().coalitionInviteDuration(),
    });
    return true;
  }

  reply(recipient: Player, coalitionID: number, accept: boolean): boolean {
    const now = this.game.ticks();
    const invite = this.invites.find(
      (i) =>
        i.recipient === recipient &&
        i.coalition.id() === coalitionID &&
        this.live(i, now),
    );
    if (invite === undefined) return false;
    this.invites = this.invites.filter((i) => i !== invite);
    const c = invite.coalition as CoalitionImpl;
    if (!accept) return true;
    if (
      !this.list.includes(c) ||
      this.implOf(recipient) !== null ||
      !this.eligible(recipient) ||
      c._sanctions.has(recipient) ||
      c.size() >= this.game.config().coalitionMaxMembers()
    ) {
      return false;
    }
    this.join(c, recipient);
    return true;
  }

  leave(p: Player): boolean {
    const c = this.implOf(p);
    if (c === null) return false;
    // Breaking the peace with the rest of the coalition.
    if (c.size() > 1) {
      p.markTraitor();
      for (const m of c._members) {
        if (m !== p) m.updateRelation(p, -100);
      }
    }
    this.remove(c, p);
    this.leftAt.set(p, this.game.ticks());
    this.notify(c, "events_display.coalition_left", p);
    return true;
  }

  kick(leader: Player, target: Player): boolean {
    if (!this.canKick(leader, target)) return false;
    const c = this.implOf(leader)!;
    this.remove(c, target);
    this.leftAt.set(target, this.game.ticks());
    this.game.displayMessage(
      "events_display.coalition_kicked",
      MessageType.ALLIANCE_BROKEN,
      target.id(),
      undefined,
      { name: c.name() },
    );
    return true;
  }

  transfer(leader: Player, target: Player): boolean {
    const c = this.ledBy(leader);
    if (c === null || target === leader || !c.has(target)) return false;
    c._leader = target;
    this.notify(c, "events_display.coalition_new_leader", target);
    this.emit();
    return true;
  }

  setSanction(leader: Player, target: Player, on: boolean): boolean {
    const c = this.ledBy(leader);
    if (c === null) return false;
    if (on) {
      if (!this.canSanction(leader, target) || c._sanctions.has(target)) {
        return false;
      }
      c._sanctions.add(target);
      // Invites to a sanctioned player lapse.
      this.invites = this.invites.filter(
        (i) => !(i.coalition === c && i.recipient === target),
      );
      this.game.displayMessage(
        "events_display.coalition_sanctioned_you",
        MessageType.ALLIANCE_BROKEN,
        target.id(),
        undefined,
        { name: c.name() },
      );
    } else {
      if (!c._sanctions.delete(target)) return false;
    }
    this.emit();
    return true;
  }

  setTarget(leader: Player, target: Player): boolean {
    if (!this.canTarget(leader, target)) return false;
    const c = this.implOf(leader)!;
    const now = this.game.ticks();
    c._target = { player: target, tick: now };
    c._lastTargetTick = now;
    for (const m of c._members) {
      // Members (nations) take the leader's word for it.
      if (m !== leader) m.updateRelation(target, -20);
      if (m.type() !== PlayerType.Human) continue;
      this.game.displayMessage(
        "events_display.coalition_target",
        MessageType.ATTACK_REQUEST,
        m.id(),
        undefined,
        { leader: leader.displayName(), target: target.displayName() },
        undefined,
        target.id(),
      );
    }
    target.updateRelation(leader, -40);
    this.emit();
    return true;
  }

  /** A player was eliminated: drop them without the traitor mark. */
  removeSilently(p: Player): void {
    const c = this.implOf(p);
    this.invites = this.invites.filter(
      (i) => i.recipient !== p && i.inviter !== p,
    );
    if (c === null) return;
    this.remove(c, p);
  }

  // --- internals ---

  private join(c: CoalitionImpl, p: Player): void {
    for (const m of c._members) {
      // Membership supersedes pairwise alliances and grudges inside the
      // coalition.
      const alliance = p.allianceWith(m);
      if (alliance !== null) this.game.detachAlliance(alliance);
      if (p.hasEmbargoAgainst(m)) p.stopEmbargo(m);
      if (m.hasEmbargoAgainst(p)) m.stopEmbargo(p);
    }
    for (const m of c._members) cancelNukesBetween(this.game, p, m);
    c._members.push(p);
    this.index.set(p, c);
    this.dropInvitesTo(p);
    this.notify(c, "events_display.coalition_joined", p);
    this.emit();
  }

  private remove(c: CoalitionImpl, p: Player): void {
    c._members = c._members.filter((m) => m !== p);
    this.index.delete(p);
    if (c._members.length <= 1) {
      this.list = this.list.filter((x) => x !== c);
      this.invites = this.invites.filter((i) => i.coalition !== c);
      for (const m of c._members) {
        this.game.displayMessage(
          "events_display.coalition_dissolved",
          MessageType.ALLIANCE_EXPIRED,
          m.id(),
          undefined,
          { name: c.name() },
        );
      }
      for (const m of c._members) this.index.delete(m);
      c._members = [];
    } else if (c._leader === p) {
      c._leader = successor(c._members);
      this.notify(c, "events_display.coalition_new_leader", c._leader);
    }
    this.emit();
  }

  private notify(c: CoalitionImpl, key: string, who: Player): void {
    for (const m of c._members) {
      if (m === who) continue;
      this.game.displayMessage(
        key,
        MessageType.ALLIANCE_ACCEPTED,
        m.id(),
        undefined,
        { name: who.displayName(), coalition: c.name() },
      );
    }
  }

  private implOf(p: Player): CoalitionImpl | null {
    return this.index.get(p) ?? null;
  }

  /** Same coalition (and not the same player). */
  together(a: Player, b: Player): boolean {
    if (a === b || this.index.size === 0) return false;
    const c = this.index.get(a);
    return c !== undefined && c === this.index.get(b);
  }

  /** Either side's coalition trade-bans the other. */
  sanctioned(a: Player, b: Player): boolean {
    if (this.index.size === 0) return false;
    return (
      this.index.get(a)?._sanctions.has(b) === true ||
      this.index.get(b)?._sanctions.has(a) === true
    );
  }

  private ledBy(p: Player): CoalitionImpl | null {
    const c = this.implOf(p);
    return c !== null && c._leader === p ? c : null;
  }

  private eligible(p: Player): boolean {
    if (!this.enabled() || !p.isAlive() || p.type() === PlayerType.Bot) {
      return false;
    }
    const left = this.leftAt.get(p);
    return (
      left === undefined ||
      this.game.ticks() - left >= this.game.config().coalitionRejoinCooldown()
    );
  }

  private live(i: CoalitionInvite, now: Tick): boolean {
    return now - i.createdAt < this.game.config().coalitionInviteDuration();
  }

  private dropInvitesTo(p: Player): void {
    this.invites = this.invites.filter((i) => i.recipient !== p);
  }

  views(): CoalitionView[] {
    return this.list.map((c) => {
      const target = c.target();
      return {
        id: c.id(),
        name: c.name(),
        leaderID: c._leader.smallID(),
        memberIDs: c._members.map((m) => m.smallID()),
        sanctionIDs: [...c._sanctions].map((m) => m.smallID()),
        targetID: target?.smallID() ?? null,
        targetUntil:
          target === null
            ? null
            : c._target!.tick + this.game.config().coalitionTargetDuration(),
      };
    });
  }

  emit(): void {
    this.game.addUpdate({
      type: GameUpdateType.Coalitions,
      coalitions: this.views(),
    });
  }

  snapshot(w: SnapshotWriter): CoalitionsState {
    return {
      nextID: this.nextID,
      coalitions: this.list.map((c) => ({
        id: c.id(),
        name: c.name(),
        leader: w.player(c._leader),
        members: c._members.map((m) => w.player(m)),
        sanctions: [...c._sanctions].map((m) => w.player(m)),
        target:
          c._target === null
            ? null
            : { player: w.player(c._target.player), tick: c._target.tick },
        lastTargetTick: Number.isFinite(c._lastTargetTick)
          ? c._lastTargetTick
          : null,
        createdAt: c.createdAt(),
      })),
      invites: this.invites.map((i) => ({
        coalitionID: i.coalition.id(),
        inviter: w.player(i.inviter),
        recipient: w.player(i.recipient),
        createdAt: i.createdAt,
      })),
      leftAt: [...this.leftAt].map(([p, t]) => ({
        player: w.player(p),
        tick: t,
      })),
    };
  }

  restore(s: CoalitionsState, r: SnapshotReader): void {
    this.nextID = s.nextID;
    this.list = s.coalitions.map((d) => {
      const c = new CoalitionImpl(
        this.game,
        d.id,
        d.name,
        r.player(d.leader),
        d.createdAt,
      );
      c._members = d.members.map((m) => r.player(m));
      c._sanctions = new Set(d.sanctions.map((m) => r.player(m)));
      c._target =
        d.target === null
          ? null
          : { player: r.player(d.target.player), tick: d.target.tick };
      c._lastTargetTick = d.lastTargetTick ?? -Infinity;
      return c;
    });
    this.invites = s.invites.flatMap((i) => {
      const c = this.list.find((x) => x.id() === i.coalitionID);
      return c === undefined
        ? []
        : [
            {
              coalition: c,
              inviter: r.player(i.inviter),
              recipient: r.player(i.recipient),
              createdAt: i.createdAt,
            },
          ];
    });
    this.leftAt = new Map(s.leftAt.map((e) => [r.player(e.player), e.tick]));
    this.index = new Map();
    for (const c of this.list) for (const m of c._members) this.index.set(m, c);
  }
}

// Most land, then the lowest smallID: the same pick on every client.
function successor(members: Player[]): Player {
  let best = members[0];
  for (const m of members) {
    const d = m.numTilesOwned() - best.numTilesOwned();
    if (d > 0 || (d === 0 && m.smallID() < best.smallID())) best = m;
  }
  return best;
}

export const CoalitionsSnapshot = snapshotType({
  name: "Coalitions",
  version: 1,
  schema: z.object({
    nextID: zInt(),
    coalitions: z.array(
      z.object({
        id: zInt(),
        name: z.string(),
        leader: zPlayerRef(),
        members: z.array(zPlayerRef()),
        sanctions: z.array(zPlayerRef()),
        target: z.object({ player: zPlayerRef(), tick: zInt() }).nullable(),
        lastTargetTick: zInt().nullable(),
        createdAt: zInt(),
      }),
    ),
    invites: z.array(
      z.object({
        coalitionID: zInt(),
        inviter: zPlayerRef(),
        recipient: zPlayerRef(),
        createdAt: zInt(),
      }),
    ),
    leftAt: z.array(z.object({ player: zPlayerRef(), tick: zInt() })),
  }),
});
export type CoalitionsState = z.infer<typeof CoalitionsSnapshot.schema>;
