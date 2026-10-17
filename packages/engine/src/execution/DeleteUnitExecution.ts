import { MessageType } from "@openfront/engine-api/game/GameTypes";
import {
  zInt,
  zPlayerRef,
  zRef,
} from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import { Execution, Game, Player, Unit } from "../game/Game";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";

export class DeleteUnitExecution implements Execution {
  private active: boolean = true;
  private mg: Game;
  private unit: Unit | null = null;

  constructor(
    private player: Player,
    private unitId: number,
  ) {}

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  init(mg: Game, ticks: number) {
    if (!this.active) {
      return;
    }
    this.mg = mg;

    const unit = this.mg.unit(this.unitId);
    if (!unit || unit.owner() !== this.player) {
      console.warn(
        `SECURITY: unit ${this.unitId} not found or not owned by player ${this.player.displayName()}`,
      );
      this.active = false;
      return;
    }

    if (!unit.isActive()) {
      console.warn(`SECURITY: unit ${this.unitId} is not active`);
      this.active = false;
      return;
    }
    this.unit = unit;

    const tileOwner = mg.owner(unit.tile());
    if (!tileOwner.isPlayer() || tileOwner.id() !== this.player.id()) {
      console.warn(
        `SECURITY: unit ${this.unitId} is not on player's territory`,
      );
      this.active = false;
      return;
    }

    if (!mg.isLand(unit.tile())) {
      console.warn(`SECURITY: unit ${this.unitId} is not on land`);
      this.active = false;
      return;
    }

    if (mg.inSpawnPhase()) {
      console.warn(`SECURITY: cannot delete units during spawn phase`);
      this.active = false;
      return;
    }

    if (!this.player.canDeleteUnit()) {
      console.warn(`SECURITY: delete unit cooldown not expired`);
      this.active = false;
      return;
    }

    this.player.recordDeleteUnit();
    unit.markForDeletion();
  }

  tick(ticks: number) {
    if (!this.active || !this.unit) {
      return;
    }
    if (!this.unit.isActive()) {
      this.active = false;
      return;
    }
    if (this.unit.isOverdueDeletion()) {
      // Fork: deconstruction refunds part of the price. Prices scale with
      // how many the player owns, so the unit being removed is valued at
      // what the newest one of its type cost (one fewer than owned now).
      const refund = this.refund(this.unit);
      this.unit.delete(false);
      if (refund > 0n) this.player.addGold(refund);

      this.mg.displayMessage(
        refund > 0n
          ? `events_display.unit_deconstructed_refund`
          : `events_display.unit_voluntarily_deleted`,
        MessageType.UNIT_DESTROYED,
        this.player.id(),
        refund > 0n ? refund : undefined,
        refund > 0n ? { gold: Number(refund) } : undefined,
      );
      this.active = false;
    }
  }

  private refund(unit: Unit): bigint {
    const paid = this.mg
      .config()
      .unitInfo(unit.type())
      .cost(this.mg, this.player, -1);
    return (paid * BigInt(this.mg.config().deconstructRefundPercent())) / 100n;
  }

  isActive(): boolean {
    return this.active;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return DeleteUnitExecutionSnapshot.write({
      active: this.active,
      initialized: this.mg !== undefined,
      unit: w.unitOrNull(this.unit),
      player: w.player(this.player),
      unitId: this.unitId,
    });
  }

  restoreSnapshot(s: DeleteUnitState, r: SnapshotReader): void {
    this.active = s.active;
    if (s.initialized) this.mg = r.game;
    this.unit = r.unitOrNull(s.unit);
    this.player = r.player(s.player);
    this.unitId = s.unitId;
  }
}

const DeleteUnitStateSchema = z.object({
  active: z.boolean(),
  initialized: z.boolean(),
  unit: zRef().nullable(),
  player: zPlayerRef(),
  unitId: zInt(),
});
type DeleteUnitState = z.infer<typeof DeleteUnitStateSchema>;

export const DeleteUnitExecutionSnapshot = execSnapshotType({
  name: "DeleteUnit",
  version: 1,
  schema: DeleteUnitStateSchema,
  cls: () => DeleteUnitExecution,
});
