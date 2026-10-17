import {
  Tick,
  UnitStatus,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { Config } from "@openfront/engine-lib/configuration/Config";
import { zInt, zRef } from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import { Execution, Game, Unit } from "../game/Game";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";

/**
 * Template for fork buildings that cost gold to keep running (fork).
 *
 * Every interval the owner pays goldPerLevel × the building's level (stacked
 * buildings cost more to run). While paid up the building is "working"; when
 * the owner can't pay it carries UnitStatus.NoFunds, which the client draws
 * as a "!" badge, and Config.workingLevels() stops counting it.
 *
 * To add an upkeep building:
 *   1. add its UnitType and unitInfo (set upgradable: true to let it stack)
 *   2. add an entry below
 *   3. route it here from ConstructionExecution (see the CivicCenter case)
 *   4. read its effect with config.workingLevels(player, type, cap)
 */
export interface UpkeepSpec {
  /** Gold charged per level, every interval. */
  goldPerLevel(config: Config): number;
  interval(config: Config): Tick;
}

export const UPKEEP_STRUCTURES: Partial<Record<UnitType, UpkeepSpec>> = {
  [UnitType.CivicCenter]: {
    goldPerLevel: (c) => c.civicCenterUpkeep(),
    interval: (c) => c.civicCenterUpkeepInterval(),
  },
  [UnitType.MilitaryBase]: {
    goldPerLevel: (c) => c.militaryBaseUpkeep(),
    interval: (c) => c.militaryBaseUpkeepInterval(),
  },
};

export function hasUpkeep(type: UnitType): boolean {
  return UPKEEP_STRUCTURES[type] !== undefined;
}

export class UpkeepStructureExecution implements Execution {
  private mg: Game;
  private active = true;
  private lastUpkeepTick = -1;

  constructor(private structure: Unit) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;
  }

  tick(ticks: number): void {
    const spec = UPKEEP_STRUCTURES[this.structure.type()];
    if (!this.structure.isActive() || spec === undefined) {
      this.active = false;
      return;
    }
    if (this.structure.isUnderConstruction()) return;
    if (this.lastUpkeepTick === -1) {
      // First interval starts when construction finishes.
      this.lastUpkeepTick = ticks;
      return;
    }
    const config = this.mg.config();
    if (ticks - this.lastUpkeepTick < spec.interval(config)) return;
    this.lastUpkeepTick = ticks;
    const owner = this.structure.owner();
    const upkeep = BigInt(spec.goldPerLevel(config) * this.structure.level());
    const canPay = owner.gold() >= upkeep;
    if (canPay) owner.removeGold(upkeep);
    this.structure.setStatus(UnitStatus.NoFunds, !canPay);
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return UpkeepStructureExecutionSnapshot.write({
      active: this.active,
      initialized: this.mg !== undefined,
      lastUpkeepTick: this.lastUpkeepTick,
      structure: w.unit(this.structure),
    });
  }

  restoreSnapshot(s: UpkeepStructureState, r: SnapshotReader): void {
    this.active = s.active;
    if (s.initialized) this.mg = r.game;
    this.lastUpkeepTick = s.lastUpkeepTick;
    this.structure = r.unit(s.structure);
  }
}

const UpkeepStructureStateSchema = z.object({
  active: z.boolean(),
  initialized: z.boolean(),
  lastUpkeepTick: zInt(),
  structure: zRef(),
});
type UpkeepStructureState = z.infer<typeof UpkeepStructureStateSchema>;

export const UpkeepStructureExecutionSnapshot = execSnapshotType({
  name: "UpkeepStructure",
  version: 1,
  schema: UpkeepStructureStateSchema,
  cls: () => UpkeepStructureExecution,
});
