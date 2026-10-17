import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  MessageType,
  UnitStatus,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
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
import { registerFrontUnit } from "./behaviors/FrontAssigner";
import { passable, stageTile } from "./behaviors/FrontMap";
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
// Left alone, it drives itself to the front (autoDeploy): FrontAssigner
// spreads the owner's tanks over attacks, defenses and hostile borders. A
// player's move order always wins, and the tank holds where it was sent for
// a while. An idle tank about to be overrun pulls back a few tiles.
export class TankExecution implements Execution {
  private mg: Game;
  private tank: Unit;
  // Route for pathTarget; path[pathIndex] is the next tile to drive onto.
  private path: TileRef[] = [];
  private pathIndex = 0;
  private pathTarget: TileRef | undefined;
  private lastShellAttack = 0;
  // The target autoDeploy chose, so a player's order can be told apart.
  private autoTarget: TileRef | null = null;
  // After a player's order arrives, autoDeploy waits until this tick.
  private holdUntil = -1;
  // A destination the route search failed on, avoided until failedUntil.
  private failedTarget: TileRef | null = null;
  private failedUntil = -1;

  constructor(private input: (UnitParams<UnitType.Tank> & OwnerComp) | Unit) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;
    if (isUnit(this.input)) {
      this.tank = this.input;
      this.register();
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
    this.register();
  }

  // Lets FrontAssigner read this tank's auto-deploy state live.
  private register(): void {
    registerFrontUnit(this.tank, {
      autoEligible: (ticks) => {
        if (!this.mg.config().tankAutoFront() || ticks < this.holdUntil) {
          return false;
        }
        const target = this.tank.targetTile();
        return target === undefined || target === this.autoTarget;
      },
      autoTarget: () => this.autoTarget,
      avoids: (tile, ticks) =>
        this.failedTarget !== null &&
        ticks < this.failedUntil &&
        this.mg.manhattanDist(this.failedTarget, tile) <= 2,
    });
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
    this.retreat(ticks, owner);
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
      this.clearPath();
      return;
    }
    if (this.tank.tile() === target) {
      this.arrive(ticks, target); // includes orders to the tile it's on
      return;
    }
    if (target !== this.pathTarget && !this.planRoute(target, owner)) {
      this.unreachable(ticks, target, owner);
      return;
    }
    if (ticks % this.mg.config().tankMoveInterval() !== 0) return;
    let next = this.path[this.pathIndex];
    if (next === undefined || !passable(this.mg, owner, next)) {
      // Route was cut: repair it from here, right away.
      if (!this.planRoute(target, owner)) {
        this.unreachable(ticks, target, owner);
        return;
      }
      next = this.path[this.pathIndex];
    }
    this.tank.move(next);
    this.pathIndex++;
    if (this.pathIndex >= this.path.length) this.arrive(ticks, target);
  }

  // No route to target over owned land. An auto target is avoided for a
  // while (FrontAssigner skips it); a player's order gets a message.
  private unreachable(ticks: number, target: TileRef, owner: Player): void {
    if (target === this.autoTarget) {
      this.failedTarget = target;
      this.failedUntil = ticks + this.mg.config().tankFailedTargetTicks();
    } else {
      this.mg.displayMessage(
        "events_display.tank_no_route",
        MessageType.ATTACK_FAILED,
        owner.id(),
      );
    }
    this.tank.setTargetTile(undefined);
    this.autoTarget = null;
    this.clearPath();
  }

  private clearPath(): void {
    this.path = [];
    this.pathIndex = 0;
    this.pathTarget = undefined;
  }

  private arrive(ticks: number, target: TileRef): void {
    if (target !== this.autoTarget) {
      // The player sent it here: hold before auto-deploy takes over again.
      this.holdUntil = ticks + this.mg.config().tankManualHoldTicks();
    }
    this.tank.setTargetTile(undefined);
    this.clearPath();
    this.autoTarget = null;
  }

  // An idle tank whose ground an incoming attack is about to take, and that
  // isn't spearheading an attack of its own, backs off a few tiles. Runs
  // during a hold too: the retreat is an auto move, so the hold stands.
  private retreat(ticks: number, owner: Player): void {
    if (this.tank.targetTile() !== undefined) return;
    if (ticks % RETREAT_CHECK_TICKS !== 0) return;
    const config = this.mg.config();
    const supporting =
      this.tank.lastSupportTick() >= 0 &&
      ticks - this.tank.lastSupportTick() <= config.tankSupportFlagTicks();
    if (supporting || !this.threatened(owner)) return;
    const back = stageTile(
      this.mg,
      owner,
      this.tank.tile(),
      config.tankStandoff(),
    );
    if (back === null || back === this.tank.tile()) return;
    this.autoTarget = back;
    this.tank.setTargetTile(back);
  }

  private threatened(owner: Player): boolean {
    const here = this.tank.tile();
    for (const attack of owner.incomingAttacks()) {
      if (!attack.isActive() || attack.retreating()) continue;
      if (attack.borderTiles().has(here)) return true;
      const attacker = attack.attacker();
      for (const n of this.mg.neighbors(here)) {
        if (this.mg.owner(n) === attacker) return true;
      }
    }
    return false;
  }

  // Let FrontAssigner place an idle tank, re-checked every seek interval.
  // All of an owner's tanks seek on the same tick so they are placed
  // together. Fronts move as attacks advance, so auto routes are refreshed.
  private autoDeploy(ticks: number, owner: Player): void {
    const config = this.mg.config();
    if (!config.tankAutoFront()) return;
    const target = this.tank.targetTile();
    if (target !== undefined && target !== this.autoTarget) {
      this.autoTarget = null; // a player's order: never override it
      return;
    }
    if (ticks < this.holdUntil) return;
    if (ticks % config.tankFrontSeekInterval() !== 0) return;

    const result = seekFront(this.mg, this.tank);
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
    const path = landPathfinder(mg).findPath(from, target, (t) =>
      passable(mg, owner, t),
    );
    if (path === null) return false;
    this.path = path;
    this.pathIndex = 1; // path[0] is where the tank stands
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
      pathIndex: this.pathIndex,
      pathTarget: this.pathTarget ?? null,
      lastShellAttack: this.lastShellAttack,
      autoTarget: this.autoTarget,
      holdUntil: this.holdUntil,
      failedTarget: this.failedTarget,
      failedUntil: this.failedUntil,
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
    if (s.tank !== null) {
      this.tank = r.unit(s.tank);
      if (s.initialized) this.register();
    }
    this.path = [...s.path];
    this.pathIndex = s.pathIndex;
    this.pathTarget = s.pathTarget ?? undefined;
    this.lastShellAttack = s.lastShellAttack;
    this.autoTarget = s.autoTarget;
    this.holdUntil = s.holdUntil;
    this.failedTarget = s.failedTarget;
    this.failedUntil = s.failedUntil;
  }
}

// How often an idle tank checks whether its ground is about to be taken.
const RETREAT_CHECK_TICKS = 5;

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
  /** Index into path of the next tile to drive onto. */
  pathIndex: zInt(),
  pathTarget: zTile().nullable(),
  lastShellAttack: zInt(),
  autoTarget: zTile().nullable(),
  holdUntil: zInt(),
  failedTarget: zTile().nullable(),
  failedUntil: zInt(),
});
type TankExecutionState = z.infer<typeof TankExecutionStateSchema>;

export const TankExecutionSnapshot = execSnapshotType({
  name: "Tank",
  version: 3,
  migrations: {
    // v1 tanks predate auto-deploy: treat them as idle, no hold.
    1: (d) => ({ ...d, autoTarget: null, holdUntil: -1 }),
    // v2 stored the remaining path (next tile first) and no failed target.
    2: (d) => ({ ...d, pathIndex: 0, failedTarget: null, failedUntil: -1 }),
  },
  schema: TankExecutionStateSchema,
  cls: () => TankExecution,
});
