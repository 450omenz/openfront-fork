import { PlayerID } from "@openfront/engine-api/game/GameTypes";
import { zPlayerRef, zRef } from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import { AllianceRequest, Execution, Game, Player } from "../../game/Game";
import { cancelNukesBetween } from "../../game/NukeCancel";
import { execSnapshotType } from "../../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../../snapshot/SnapshotContext";

export class AllianceRequestExecution implements Execution {
  private req: AllianceRequest | null = null;
  private active = true;
  private mg: Game;

  constructor(
    private requestor: Player,
    private recipientID: PlayerID,
  ) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;
    if (!mg.hasPlayer(this.recipientID)) {
      console.warn(
        `AllianceRequestExecution recipient ${this.recipientID} not found`,
      );
      return;
    }

    const recipient = mg.player(this.recipientID);

    if (!this.requestor.canSendAllianceRequest(recipient)) {
      console.warn("cannot send alliance request");
      this.active = false;
    } else {
      const incoming = recipient
        .outgoingAllianceRequests()
        .find((r) => r.recipient() === this.requestor);
      if (incoming) {
        // If the recipient already has pending alliance request,
        // then accept it instead of creating a new one.
        this.active = false;
        incoming.accept();

        // Update player relations
        this.requestor.updateRelation(recipient, 100);
        recipient.updateRelation(this.requestor, 100);

        // Automatically remove embargoes only if they were automatically created
        if (this.requestor.hasEmbargoAgainst(recipient))
          this.requestor.endTemporaryEmbargo(recipient);
        if (recipient.hasEmbargoAgainst(this.requestor))
          recipient.endTemporaryEmbargo(this.requestor);

        // Cancel incoming nukes between players
        this.cancelNukesBetweenAlliedPlayers(recipient);
      } else {
        this.req = this.requestor.createAllianceRequest(recipient);
      }
    }
  }

  tick(ticks: number): void {
    if (
      this.req?.status() === "accepted" ||
      this.req?.status() === "rejected"
    ) {
      this.active = false;
      return;
    }
    if (
      this.mg.ticks() - (this.req?.createdAt() ?? 0) >
      this.mg.config().allianceRequestDuration()
    ) {
      this.req?.reject();
      this.active = false;
    }
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  cancelNukesBetweenAlliedPlayers(recipient: Player): void {
    cancelNukesBetween(this.mg, this.requestor, recipient);
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return AllianceRequestExecutionSnapshot.write({
      active: this.active,
      initialized: this.mg !== undefined,
      req: this.req === null ? null : w.allianceRequest(this.req),
      requestor: w.player(this.requestor),
      recipientID: this.recipientID,
    });
  }

  restoreSnapshot(s: AllianceRequestState, r: SnapshotReader): void {
    this.active = s.active;
    if (s.initialized) this.mg = r.game;
    this.req =
      s.req === null ? null : r.allianceRequest<AllianceRequest>(s.req);
    this.requestor = r.player(s.requestor);
    this.recipientID = s.recipientID;
  }
}

const AllianceRequestStateSchema = z.object({
  active: z.boolean(),
  initialized: z.boolean(),
  req: zRef().nullable(),
  requestor: zPlayerRef(),
  recipientID: z.string(),
});
type AllianceRequestState = z.infer<typeof AllianceRequestStateSchema>;

export const AllianceRequestExecutionSnapshot = execSnapshotType({
  name: "AllianceRequest",
  version: 1,
  schema: AllianceRequestStateSchema,
  cls: () => AllianceRequestExecution,
});
