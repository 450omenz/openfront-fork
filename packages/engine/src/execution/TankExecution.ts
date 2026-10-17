import { TileRef } from "@openfront/engine-api/game/GameMap";
import { UnitStatus, UnitType } from "@openfront/engine-api/game/GameTypes";
import {
  zInt,
  zPlayerRef,
  zRef,
  zTile,
} from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import {
  Execution,
  Game,
  isUnit,
  OwnerComp,
  Player,
  Unit,
  UnitParams,
} from "../game/Game";
import { AStarLandBounded } from "../pathfinding/algorithms/AStar.LandBounded";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";
import { seekFront } from "./behaviors/FrontSeeker";
import { ShellExecution } from "./ShellExecution";

// One land A* per game, shared by every tank. Scratch buffers only (no state
// survives a call), so it is a cache, not snapshot state.
const landPathfinders = new WeakMap<Game, AStarLandBounded>();
function landPathfinder(mg: Game): AStarLandBounded {
  let pf = landPathfinders.get(mg);
  if (pf === undefined) {
    // Detours may leave the start/goal bounding box by this many tiles.
    const margin = 40;
    const span = mg.config().tankMaxMoveDistance() + 2 * margin;
    pf = new AStarLandBounded(mg.map(), span * span, margin);
    landPathfinders.set(mg, pf);
  }
  return pf;
}

// Fork unit. A tank drives only on its owner's land; attacks the owner makes
// near it get the spearhead bonus (see AttackExecution / attackLogic). It
// shells hostile tanks in range, and is destroyed if its tile is overrun.
// Left alone, it drives itself to the nearest front (autoDeploy); a player's
// move order always wins, and the tank holds where it was sent for a while.
export class TankExecution implements Execution {
  private mg: Game;
  private tank: Unit;
  // Remaining tiles to drive, next one first. Computed for pathTarget.
  private path: TileRef[] = [];
  private pathTarget: TileRef | undefined;
  private lastShellAttack = 0;
  // The target autoDeploy chose, so a player's order can be told apart.
  private autoTarget: TileRef | null = null;
  // After a player's order arrives, autoDeploy waits until this tick.
  private holdUntil = -1;

  constructor(private input: (UnitParams<UnitType.Tank> & OwnerComp) | Unit) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;
    if (isUnit(this.input)) {
      this.tank = this.input;
      return;
    }
    const target = this.input.targetTile;
    const spawn =
      target === undefined
        ? false
        : this.input.owner.canBuild(UnitType.Tank, target);
    if (spawn === false) {
      console.warn(`Failed to spawn tank for ${this.input.owner.name()}`);
      return;
    }
    this.tank = this.input.owner.buildUnit(UnitType.Tank, spawn, {});
    this.tank.setTargetTile(target);
  }

  tick(ticks: number): void {
    if (this.tank.health() <= 0) {
      this.tank.delete();
      return;
    }
    const owner = this.tank.owner();
    const here = this.mg.owner(this.tank.tile());
    if (here !== owner) {
      // Overrun: the enemy took the ground the tank stood on.
      this.tank.delete(true, here.isPlayer() ? (here as Player) : undefined);
      return;
    }
    this.autoDeploy(ticks, owner);
    this.drive(ticks, owner);
    this.shoot(ticks, owner);
    // Visual "supporting the front" flag while the aura is boosting attacks.
    const since = ticks - this.tank.lastSupportTick();
    this.tank.setStatus(
      UnitStatus.SupportingAttack,
      this.tank.lastSupportTick() >= 0 &&
        since <= this.mg.config().tankSupportFlagTicks(),
    );
  }

  private drive(ticks: number, owner: Player): void {
    const target = this.tank.targetTile();
    if (target === undefined) {
      this.path = [];
      this.pathTarget = undefined;
      return;
    }
    if (this.tank.tile() === target) {
      this.arrive(ticks, target); // includes orders to the tile it's on
      return;
    }
    if (target !== this.pathTarget && !this.planRoute(target, owner)) {
      this.tank.setTargetTile(undefined); // unreachable: stop
      this.autoTarget = null;
      return;
    }
    if (ticks % this.mg.config().tankMoveInterval() !== 0) return;
    const next = this.path[0];
    if (next === undefined || this.mg.owner(next) !== owner) {
      this.pathTarget = undefined; // route was cut; replan next tick
      return;
    }
    this.tank.move(next);
    this.path.shift();
    if (this.path.length === 0) this.arrive(ticks, target);
  }

  private arrive(ticks: number, target: TileRef): void {
    if (target !== this.autoTarget) {
      // The player sent it here: hold before auto-deploy takes over again.
      this.holdUntil = ticks + this.mg.config().tankManualHoldTicks();
    }
    this.tank.setTargetTile(undefined);
    this.path = [];
    this.pathTarget = undefined;
    this.autoTarget = null;
  }

  // Send an idle tank to the nearest front, re-checked every seek interval.
  // Fronts move as attacks advance, so an auto route is refreshed too.
  private autoDeploy(ticks: number, owner: Player): void {
    const config = this.mg.config();
    if (!config.tankAutoFront()) return;
    const target = this.tank.targetTile();
    if (target !== undefined && target !== this.autoTarget) {
      this.autoTarget = null; // a player's order: never override it
      return;
    }
    if (ticks < this.holdUntil) return;
    // Stagger tanks so they don't all search on the same tick.
    const interval = config.tankFrontSeekInterval();
    if ((ticks + this.tank.id()) % interval !== 0) return;

    const result = seekFront(this.mg, owner, this.tank, {
      inRange: config.tankAuraRange() / 2,
      maxDistance: config.tankMaxMoveDistance(),
      spread: config.tankFrontSpread(),
      spreadTypes: [UnitType.Tank],
    });
    if (result.kind === "stage") {
      if (result.tile !== target) {
        this.autoTarget = result.tile;
        this.tank.setTargetTile(result.tile);
      }
    } else if (target !== undefined) {
      // At the front already, or the front is gone: stop here.
      this.autoTarget = null;
      this.tank.setTargetTile(undefined);
    }
  }

  private planRoute(target: TileRef, owner: Player): boolean {
    const mg = this.mg;
    const from = this.tank.tile();
    if (mg.manhattanDist(from, target) > mg.config().tankMaxMoveDistance()) {
      return false;
    }
    const path = landPathfinder(mg).findPath(
      from,
      target,
      (t) => mg.owner(t) === owner && mg.isLand(t) && !mg.isImpassable(t),
    );
    if (path === null) return false;
    this.path = path.slice(1);
    this.pathTarget = target;
    return true;
  }

  private shoot(ticks: number, owner: Player): void {
    const mg = this.mg;
    if (ticks - this.lastShellAttack < mg.config().tankShellAttackRate()) {
      return;
    }
    let best: Unit | null = null;
    let bestDist = Infinity;
    for (const { unit, distSquared } of mg.nearbyUnits(
      this.tank.tile(),
      mg.config().tankShellRange(),
      UnitType.Tank,
    )) {
      const enemy = unit as Unit;
      if (
        enemy.owner() === owner ||
        owner.isFriendly(enemy.owner()) ||
        !enemy.isActive()
      ) {
        continue;
      }
      // Nearest first; lower id breaks ties deterministically.
      if (
        distSquared < bestDist ||
        (distSquared === bestDist && best !== null && enemy.id() < best.id())
      ) {
        best = enemy;
        bestDist = distSquared;
      }
    }
    if (best === null) return;
    this.lastShellAttack = ticks;
    mg.addExecution(
      new ShellExecution(this.tank.tile(), owner, this.tank, best),
    );
  }

  isActive(): boolean {
    return this.tank?.isActive() ?? false;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return TankExecutionSnapshot.write({
      input: isUnit(this.input)
        ? { unit: w.unit(this.input) }
        : {
            owner: w.player(this.input.owner),
            targetTile: this.input.targetTile ?? null,
          },
      initialized: this.mg !== undefined,
      tank: this.tank === undefined ? null : w.unit(this.tank),
      path: [...this.path],
      pathTarget: this.pathTarget ?? null,
      lastShellAttack: this.lastShellAttack,
      autoTarget: this.autoTarget,
      holdUntil: this.holdUntil,
    });
  }

  restoreSnapshot(s: TankExecutionState, r: SnapshotReader): void {
    this.input =
      "unit" in s.input
        ? r.unit(s.input.unit)
        : {
            owner: r.player(s.input.owner),
            ...(s.input.targetTile === null
              ? {}
              : { targetTile: s.input.targetTile }),
          };
    if (s.initialized) this.mg = r.game;
    if (s.tank !== null) this.tank = r.unit(s.tank);
    this.path = [...s.path];
    this.pathTarget = s.pathTarget ?? undefined;
    this.lastShellAttack = s.lastShellAttack;
    this.autoTarget = s.autoTarget;
    this.holdUntil = s.holdUntil;
  }
}

const TankExecutionStateSchema = z.object({
  /** An existing tank, or the params to build one in init(). */
  input: z.union([
    z.object({ unit: zRef() }),
    z.object({ owner: zPlayerRef(), targetTile: zTile().nullable() }),
  ]),
  initialized: z.boolean(),
  /** Null before init() or when the spawn failed. */
  tank: zRef().nullable(),
  path: z.array(zTile()),
  pathTarget: zTile().nullable(),
  lastShellAttack: zInt(),
  autoTarget: zTile().nullable(),
  holdUntil: zInt(),
});
type TankExecutionState = z.infer<typeof TankExecutionStateSchema>;

export const TankExecutionSnapshot = execSnapshotType({
  name: "Tank",
  version: 2,
  migrations: {
    // v1 tanks predate auto-deploy: treat them as idle, no hold.
    1: (d) => ({ ...d, autoTarget: null, holdUntil: -1 }),
  },
  schema: TankExecutionStateSchema,
  cls: () => TankExecution,
});
