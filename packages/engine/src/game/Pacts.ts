import {
  MessageType,
  PACT_MINUTES,
  PlayerType,
  Tick,
} from "@openfront/engine-api/game/GameTypes";
import {
  GameUpdateType,
  PactView,
} from "@openfront/engine-api/game/GameUpdates";
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
import { Game, Pact, PactProposal, Pacts, Player } from "./Game";

/**
 * Non-aggression pacts (fork): two players promise not to attack each
 * other for 5, 10 or 20 minutes.
 *
 * Unlike an alliance a pact isn't friendship: no shared defense, no
 * donations, embargoes still allowed. Attacks aren't blocked either —
 * attacking, landing a boat on or nuking a pact partner breaks the pact on
 * the spot and marks the attacker a traitor (the same backstab debuff as
 * breaking an alliance), and the victim never forgets it (-100 relation).
 * Breaking one on purpose costs the same.
 *
 * Pacts end quietly when they run out (`tick`). Proposals lapse after the
 * alliance request duration. Off when alliances are disabled.
 */
export class PactManager implements Pacts {
  private pacts: Pact[] = [];
  private proposals: PactProposal[] = [];
  // Tick a proposal from one player to another was turned down: the
  // proposer waits PROPOSE_AGAIN_TICKS before asking that player again.
  private rejected: { from: Player; to: Player; tick: Tick }[] = [];

  constructor(private readonly game: Game) {}

  enabled(): boolean {
    return !this.game.config().disableAlliances();
  }

  all(): readonly Pact[] {
    return this.pacts;
  }

  between(a: Player, b: Player): Pact | null {
    if (this.pacts.length === 0) return null;
    return (
      this.pacts.find(
        (p) => (p.a === a && p.b === b) || (p.a === b && p.b === a),
      ) ?? null
    );
  }

  of(p: Player): readonly Pact[] {
    return this.pacts.filter((x) => x.a === p || x.b === p);
  }

  proposalsFor(p: Player): readonly PactProposal[] {
    const now = this.game.ticks();
    return this.proposals.filter((x) => x.recipient === p && this.live(x, now));
  }

  canPropose(from: Player, to: Player): boolean {
    const now = this.game.ticks();
    return (
      this.enabled() &&
      from !== to &&
      from.isAlive() &&
      to.isAlive() &&
      to.type() !== PlayerType.Bot &&
      // Friends are already at peace.
      !from.isFriendly(to) &&
      this.between(from, to) === null &&
      !this.rejected.some(
        (r) =>
          r.from === from && r.to === to && now - r.tick < PROPOSE_AGAIN_TICKS,
      ) &&
      !this.proposals.some(
        (x) =>
          this.live(x, now) &&
          ((x.proposer === from && x.recipient === to) ||
            (x.proposer === to && x.recipient === from)),
      )
    );
  }

  propose(from: Player, to: Player, minutes: number): boolean {
    if (
      !(PACT_MINUTES as readonly number[]).includes(minutes) ||
      !this.canPropose(from, to)
    ) {
      return false;
    }
    const proposal: PactProposal = {
      proposer: from,
      recipient: to,
      minutes,
      createdAt: this.game.ticks(),
    };
    this.proposals.push(proposal);
    this.game.addUpdate({
      type: GameUpdateType.PactProposal,
      proposerID: from.smallID(),
      recipientID: to.smallID(),
      minutes,
      expiresAt: proposal.createdAt + this.proposalDuration(),
    });
    return true;
  }

  reply(recipient: Player, proposer: Player, accept: boolean): boolean {
    const now = this.game.ticks();
    const proposal = this.proposals.find(
      (x) =>
        x.recipient === recipient &&
        x.proposer === proposer &&
        this.live(x, now),
    );
    if (proposal === undefined) return false;
    this.proposals = this.proposals.filter((x) => x !== proposal);
    if (!accept) {
      this.rejected = this.rejected.filter(
        (r) => !(r.from === proposer && r.to === recipient),
      );
      this.rejected.push({ from: proposer, to: recipient, tick: now });
      this.game.displayMessage(
        "events_display.pact_rejected",
        MessageType.ALLIANCE_REJECTED,
        proposer.id(),
        undefined,
        { name: recipient.displayName() },
      );
      return true;
    }
    if (
      this.between(proposer, recipient) !== null ||
      !proposer.isAlive() ||
      !recipient.isAlive() ||
      proposer.isFriendly(recipient)
    ) {
      return false;
    }
    this.pacts.push({
      a: proposer,
      b: recipient,
      createdAt: now,
      expiresAt: now + proposal.minutes * 60 * 10,
    });
    for (const [p, other] of [
      [proposer, recipient],
      [recipient, proposer],
    ]) {
      this.game.displayMessage(
        "events_display.pact_signed",
        MessageType.ALLIANCE_ACCEPTED,
        p.id(),
        undefined,
        { name: other.displayName(), minutes: proposal.minutes },
      );
    }
    this.emit();
    return true;
  }

  /**
   * `breaker` broke the pact with `victim` (on purpose, or by attacking):
   * traitor, and the victim's lasting grudge. No-op without a pact.
   */
  breakPact(breaker: Player, victim: Player): boolean {
    const pact = this.between(breaker, victim);
    if (pact === null) return false;
    this.pacts = this.pacts.filter((p) => p !== pact);
    breaker.markTraitor();
    victim.updateRelation(breaker, -100);
    this.game.displayMessage(
      "events_display.pact_broken_by",
      MessageType.ALLIANCE_BROKEN,
      victim.id(),
      undefined,
      { name: breaker.displayName() },
    );
    this.game.displayMessage(
      "events_display.pact_you_broke",
      MessageType.ALLIANCE_BROKEN,
      breaker.id(),
      undefined,
      { name: victim.displayName() },
    );
    this.emit();
    return true;
  }

  /** Ends pacts that ran out or lost a player. Called every tick. */
  tick(): void {
    if (this.pacts.length === 0) {
      if (this.proposals.length > 0 || this.rejected.length > 0) {
        this.pruneProposals();
      }
      return;
    }
    const now = this.game.ticks();
    const ended = this.pacts.filter(
      (p) => p.expiresAt <= now || !p.a.isAlive() || !p.b.isAlive(),
    );
    if (ended.length === 0) return;
    this.pacts = this.pacts.filter((p) => !ended.includes(p));
    for (const p of ended) {
      if (p.expiresAt > now) continue; // someone was eliminated
      for (const [x, other] of [
        [p.a, p.b],
        [p.b, p.a],
      ]) {
        this.game.displayMessage(
          "events_display.pact_expired",
          MessageType.ALLIANCE_EXPIRED,
          x.id(),
          undefined,
          { name: other.displayName() },
        );
      }
    }
    this.pruneProposals();
    this.emit();
  }

  private pruneProposals(): void {
    const now = this.game.ticks();
    this.proposals = this.proposals.filter((x) => this.live(x, now));
    this.rejected = this.rejected.filter(
      (r) => now - r.tick < PROPOSE_AGAIN_TICKS,
    );
  }

  private proposalDuration(): number {
    return this.game.config().allianceRequestDuration();
  }

  private live(x: PactProposal, now: Tick): boolean {
    return now - x.createdAt < this.proposalDuration();
  }

  views(): PactView[] {
    return this.pacts.map((p) => ({
      aID: p.a.smallID(),
      bID: p.b.smallID(),
      expiresAt: p.expiresAt,
    }));
  }

  emit(): void {
    this.game.addUpdate({ type: GameUpdateType.Pacts, pacts: this.views() });
  }

  snapshot(w: SnapshotWriter): PactsState {
    return {
      pacts: this.pacts.map((p) => ({
        a: w.player(p.a),
        b: w.player(p.b),
        createdAt: p.createdAt,
        expiresAt: p.expiresAt,
      })),
      proposals: this.proposals.map((x) => ({
        proposer: w.player(x.proposer),
        recipient: w.player(x.recipient),
        minutes: x.minutes,
        createdAt: x.createdAt,
      })),
      rejected: this.rejected.map((r) => ({
        from: w.player(r.from),
        to: w.player(r.to),
        tick: r.tick,
      })),
    };
  }

  restore(s: PactsState, r: SnapshotReader): void {
    this.pacts = s.pacts.map((p) => ({
      a: r.player(p.a),
      b: r.player(p.b),
      createdAt: p.createdAt,
      expiresAt: p.expiresAt,
    }));
    this.proposals = s.proposals.map((x) => ({
      proposer: r.player(x.proposer),
      recipient: r.player(x.recipient),
      minutes: x.minutes,
      createdAt: x.createdAt,
    }));
    this.rejected = s.rejected.map((x) => ({
      from: r.player(x.from),
      to: r.player(x.to),
      tick: x.tick,
    }));
  }
}

// After a refusal, wait 2 minutes before proposing to that player again.
const PROPOSE_AGAIN_TICKS = 2 * 60 * 10;

export const PactsSnapshot = snapshotType({
  name: "Pacts",
  version: 1,
  schema: z.object({
    pacts: z.array(
      z.object({
        a: zPlayerRef(),
        b: zPlayerRef(),
        createdAt: zInt(),
        expiresAt: zInt(),
      }),
    ),
    proposals: z.array(
      z.object({
        proposer: zPlayerRef(),
        recipient: zPlayerRef(),
        minutes: zInt(),
        createdAt: zInt(),
      }),
    ),
    rejected: z.array(
      z.object({ from: zPlayerRef(), to: zPlayerRef(), tick: zInt() }),
    ),
  }),
});
export type PactsState = z.infer<typeof PactsSnapshot.schema>;
