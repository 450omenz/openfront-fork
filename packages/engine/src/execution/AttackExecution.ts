import { GameMap, TileRef } from "@openfront/engine-api/game/GameMap";
import {
  Difficulty,
  MessageType,
  PlayerID,
  PlayerType,
  Relation,
  TerrainType,
  TerraNullius,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { renderTroops } from "@openfront/engine-lib/Format";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import {
  zInt,
  zNum,
  zPlayerRef,
  zRandom,
  zRef,
  zTile,
  zTiles,
} from "@openfront/engine-lib/snapshot/SnapshotType";
import { assertNever } from "@openfront/engine-lib/Util";
import { z } from "zod";
import { AttackLogicInput } from "../configuration/EngineConfig";
import { Attack, Execution, Game, Player, Unit } from "../game/Game";
import { TrainingSnapshot } from "../game/Military";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";
import { FlatBinaryHeap } from "./utils/FlatBinaryHeap"; // adjust path if needed

const malusForRetreat = 25;

// Fork: per-player training state, memoized for the tick it was taken in.
// Not on the player itself so it never shows up in snapshots.
const trainingMemo = new WeakMap<
  Player,
  { tick: number; snap: TrainingSnapshot }
>();
function trainingFor(mg: Game, player: Player): TrainingSnapshot {
  const hit = trainingMemo.get(player);
  if (hit !== undefined && hit.tick === mg.ticks()) return hit.snap;
  const snap = new TrainingSnapshot(mg, player);
  trainingMemo.set(player, { tick: mg.ticks(), snap });
  return snap;
}

// Fork (call to arms): last tick each human was told an ally is under
// attack by a given attacker, so repeat clicks don't spam them.
const CALL_TO_ARMS_COOLDOWN = 300;
const callToArmsSent = new WeakMap<Player, Map<string, number>>();
export class AttackExecution implements Execution {
  private active: boolean = true;
  private toConquer = new FlatBinaryHeap();

  private random = new PseudoRandom(123);

  private target: Player | TerraNullius;

  private mg: Game;
  // Direct GameMap reference to skip the Game delegation hop in hot loops.
  private map: GameMap;

  private attack: Attack | null = null;

  // Cached smallIDs for integer owner comparisons in hot loops.
  private ownerSmallID: number;
  private targetSmallID: number;
  // Reusable neighbor buffers to avoid closures/allocation in hot loops.
  private nbuf: TileRef[] = [0, 0, 0, 0];
  private nbuf2: TileRef[] = [0, 0, 0, 0];
  // Fork: share of this attack's troops that are trained, set at launch.
  private trainedShare = 0;
  // Fork: per-tick combat context, rebuilt at the start of every tick.
  private tickCtx: {
    attacker: TrainingSnapshot;
    defender: TrainingSnapshot | null;
    defenderBaseLevels: number;
    jointAttack: boolean;
    defenderAllies: Set<number>;
  } | null = null;

  constructor(
    private startTroops: number | null = null,
    private _owner: Player,
    private _targetID: PlayerID | null,
    private sourceTile: TileRef | null = null,
    private removeTroops: boolean = true,
  ) {}

  public targetID(): PlayerID | null {
    return this._targetID;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  init(mg: Game, ticks: number) {
    if (!this.active) {
      return;
    }
    this.mg = mg;
    this.map = mg.map();

    if (this._targetID !== null && !mg.hasPlayer(this._targetID)) {
      console.warn(`target ${this._targetID} not found`);
      this.active = false;
      return;
    }

    this.target =
      this._targetID === this.mg.terraNullius().id()
        ? mg.terraNullius()
        : mg.player(this._targetID);
    this.ownerSmallID = this._owner.smallID();
    this.targetSmallID = this.target.smallID();

    if (this._owner === this.target) {
      console.error(`Player ${this._owner} cannot attack itself`);
      this.active = false;
      return;
    }

    // ALLIANCE CHECK — block attacks on friendly (ally or same team)
    if (this.target.isPlayer()) {
      const targetPlayer = this.target as Player;
      if (this._owner.isFriendly(targetPlayer)) {
        console.warn(
          `${this._owner.displayName()} cannot attack ${targetPlayer.displayName()} because they are friendly (allied or same team)`,
        );
        this.active = false;
        return;
      }
    }

    if (this.target && this.target.isPlayer()) {
      const targetPlayer = this.target as Player;
      if (
        targetPlayer.type() !== PlayerType.Bot &&
        this._owner.type() !== PlayerType.Bot
      ) {
        // Don't let bots embargo since they can't trade anyway.
        targetPlayer.addEmbargo(this._owner, true);
        this.rejectIncomingAllianceRequests(targetPlayer);
      }
    }

    if (this.target.isPlayer() && !this._owner.canAttackPlayer(this.target)) {
      this.active = false;
      return;
    }

    this.startTroops ??= this.mg
      .config()
      .attackAmount(this._owner, this.target);
    this.trainedShare = this._owner.trainedShare();
    if (this.removeTroops) {
      this.startTroops = Math.min(this._owner.troops(), this.startTroops);
      // Take the amount that was actually deducted, not the amount asked for.
      // removeTroops() floors, so a fractional request leaves the attack
      // holding troops the owner never paid for — and retreat refunds the
      // combined total, turning the leftover fractions into free troops.
      this.startTroops = this._owner.removeTroops(this.startTroops);
    }
    this.attack = this._owner.createAttack(
      this.target,
      this.startTroops,
      this.sourceTile,
      new Set<TileRef>(),
    );

    if (this.sourceTile !== null) {
      this.addNeighbors(this.sourceTile);
    } else {
      this.refreshToConquer();
    }

    // Record stats
    this.mg.stats().attack(this._owner, this.target, this.startTroops);

    for (const incoming of this._owner.incomingAttacks()) {
      if (incoming.attacker() === this.target) {
        // Target has opposing attack, cancel them out
        if (incoming.troops() > this.attack.troops()) {
          incoming.setTroops(incoming.troops() - this.attack.troops());
          this.attack.delete();
          this.active = false;
          return;
        } else {
          this.attack.setTroops(this.attack.troops() - incoming.troops());
          incoming.delete();
        }
      }
    }
    for (const outgoing of this._owner.outgoingAttacks()) {
      if (
        outgoing !== this.attack &&
        outgoing.target() === this.attack.target() &&
        // Boat attacks (sourceTile is not null) are not combined with other attacks
        this.attack.sourceTile() === null
      ) {
        this.attack.setTroops(this.attack.troops() + outgoing.troops());
        outgoing.delete();
      }
    }

    // Nothing next to the owner to conquer (no wilderness around them, or a
    // target they don't border): the attack doesn't happen. Held until the
    // next tick, the troops would sit out the regen step and come back free,
    // so one such attack per tick kept regen at its peak rate and refunded
    // past maxTroops.
    if (this.toConquer.size() === 0) {
      this.retreat();
      return;
    }

    // Only now is it known how large the attack the defender actually faces
    // is: a big assault is built by clicking repeatedly, and each click's
    // execution absorbs the earlier ones above. Recorded before the loops it
    // would measure one click, and would count an attack that cancelled out
    // and never landed.
    this.mg.stats().attackMaxIncoming(this.target, this.attack.troops());

    if (!this.target.isPlayer()) return;
    this.callAlliesToArms(this.target);
    const difficulty = this.mg.config().gameConfig().difficulty;
    // Hitting back at whoever just attacked us doesn't anger them, except on Easy
    if (
      difficulty !== Difficulty.Easy &&
      this._owner.relation(this.target) === Relation.Hostile
    ) {
      return;
    }
    let relationChange: number;
    switch (difficulty) {
      case Difficulty.Easy:
        relationChange = -60;
        break;
      case Difficulty.Medium:
        relationChange = -70;
        break;
      case Difficulty.Hard:
        relationChange = -80;
        break;
      case Difficulty.Impossible:
        relationChange = -100;
        break;
      default:
        assertNever(difficulty);
    }
    this.target.updateRelation(this._owner, relationChange);
  }

  private refreshToConquer() {
    if (this.attack === null) {
      throw new Error("Attack not initialized");
    }

    this.toConquer.clear();
    this.attack.clearBorder();
    // forEach over the dense storage — the values() generator showed up in long-game profiles
    this._owner.borderTiles().forEach((tile) => this.addNeighbors(tile));
  }

  private retreat(malusPercent = 0) {
    if (this.attack === null) {
      throw new Error("Attack not initialized");
    }

    const deaths = this.attack.troops() * (malusPercent / 100);
    if (deaths) {
      this.mg.displayMessage(
        "events_display.attack_cancelled_retreat",
        MessageType.ATTACK_CANCELLED,
        this._owner.id(),
        undefined,
        { troops: renderTroops(deaths) },
      );
    }
    if (this.removeTroops === false && this.sourceTile === null) {
      // startTroops are always added to attack troops at init but not always removed from owner troops
      // subtract startTroops from attack troops so we don't give back startTroops to owner that were never removed
      // boat attacks (sourceTile !== null) are the exception: troops were removed at departure and must be returned after attack still
      this.attack.setTroops(this.attack.troops() - (this.startTroops ?? 0));
    }

    const survivors = this.attack.troops() - deaths;
    // Fork: the trained part of the survivors comes home trained.
    const trainedBack = Math.floor(survivors * this.trainedShare);
    this._owner.addTroops(survivors - trainedBack);
    this._owner.addTrainedTroops(trainedBack);
    this.attack.delete();
    this.active = false;

    // Not all retreats are canceled attacks
    if (this.attack.retreated()) {
      // Record stats
      this.mg.stats().attackCancel(this._owner, this.target, survivors);
    }
  }

  tick(ticks: number) {
    try {
      this.tickInner();
    } finally {
      // Per-tick only: never carried between ticks (or into snapshots).
      this.tickCtx = null;
    }
  }

  private tickInner() {
    if (this.attack === null) {
      throw new Error("Attack not initialized");
    }
    let troopCount = this.attack.troops(); // cache troop count
    const targetIsPlayer = this.target.isPlayer(); // cache target type
    const targetPlayer = targetIsPlayer ? (this.target as Player) : null; // cache target player

    if (this.attack.retreated()) {
      if (targetIsPlayer) {
        this.retreat(malusForRetreat);
      } else {
        this.retreat();
      }
      this.active = false;
      return;
    }

    if (this.attack.retreating()) {
      return;
    }

    if (!this.attack.isActive()) {
      this.active = false;
      return;
    }

    if (targetPlayer && this._owner.isFriendly(targetPlayer)) {
      // In this case a new alliance was created AFTER the attack started.
      this.retreat();
      return;
    }

    const borderSize = this.attack.borderSize() + this.random.nextInt(0, 5);
    this.tickCtx = this.buildTickCtx(targetPlayer);
    // Each tile consumes a fraction of the tick; conquer until it is spent.
    let tickBudget = 1;

    while (tickBudget > 0) {
      if (troopCount < 1) {
        this.attack.delete();
        this.active = false;
        return;
      }

      if (this.toConquer.size() === 0) {
        this.refreshToConquer();
        this.retreat();
        return;
      }

      const tileToConquer = this.toConquer.dequeue();
      this.attack.removeBorderTile(tileToConquer);

      let onBorder = false;
      const numNeighbors = this.map.neighbors4(tileToConquer, this.nbuf);
      for (let i = 0; i < numNeighbors; i++) {
        if (this.map.ownerID(this.nbuf[i]) === this.ownerSmallID) {
          onBorder = true;
          break;
        }
      }
      if (this.map.ownerID(tileToConquer) !== this.targetSmallID || !onBorder) {
        continue;
      }
      if (
        !this.map.isLand(tileToConquer) ||
        this.map.isImpassable(tileToConquer)
      ) {
        continue;
      }
      this.addNeighbors(tileToConquer);
      const { attackerTroopLoss, defenderTroopLoss, tickFraction } = this.mg
        .config()
        .attackLogic(
          this.attackLogicInput(troopCount, tileToConquer, borderSize),
        );
      tickBudget -= tickFraction;
      troopCount -= attackerTroopLoss;
      this.attack.setTroops(troopCount);
      if (targetPlayer) {
        targetPlayer.removeTroops(defenderTroopLoss);
      }
      this._owner.conquer(tileToConquer);
      this.handleDeadDefender();
    }
  }

  // Fork: is an attacker's tank in aura range of this tile? Tanks that are get
  // stamped so they can show their "supporting the front" effect.
  private tankSupport(tile: TileRef): boolean {
    const range = this.mg.config().tankAuraRange();
    if (!this.mg.hasUnitNearby(tile, range, UnitType.Tank, this._owner.id())) {
      return false;
    }
    const now = this.mg.ticks();
    for (const { unit } of this.mg.nearbyUnits(tile, range, UnitType.Tank)) {
      if (unit.owner() === this._owner) (unit as Unit).markSupport(now);
    }
    return true;
  }

  // Fork: combat context that holds for the whole tick.
  private buildTickCtx(defender: Player | null) {
    if (defender === null) return null;
    const allies = new Set<number>();
    for (const a of defender.allies()) {
      if (a !== this._owner) allies.add(a.smallID());
    }
    let jointAttack = false;
    for (const ally of this._owner.allies()) {
      for (const a of ally.outgoingAttacks()) {
        if (a.target() === defender) {
          jointAttack = true;
          break;
        }
      }
      if (jointAttack) break;
    }
    return {
      attacker: trainingFor(this.mg, this._owner),
      defender: trainingFor(this.mg, defender),
      defenderBaseLevels: this.mg.config().workingMilitaryBases(defender),
      jointAttack,
      defenderAllies: allies,
    };
  }

  // Fork: does the tile touch land held by one of the defender's allies?
  private allySupport(tile: TileRef): boolean {
    const allies = this.tickCtx?.defenderAllies;
    if (allies === undefined || allies.size === 0) return false;
    const n = this.map.neighbors4(tile, this.nbuf2);
    for (let i = 0; i < n; i++) {
      if (allies.has(this.map.ownerID(this.nbuf2[i]))) return true;
    }
    return false;
  }

  // Fork: tell the defender's human allies they are needed, and why.
  private callAlliesToArms(defender: Player) {
    if (this._owner.type() === PlayerType.Bot) return;
    const now = this.mg.ticks();
    for (const ally of defender.allies()) {
      if (ally === this._owner || ally.type() !== PlayerType.Human) continue;
      let sent = callToArmsSent.get(ally);
      if (sent === undefined) {
        sent = new Map();
        callToArmsSent.set(ally, sent);
      }
      const key = `${defender.id()}>${this._owner.id()}`;
      const last = sent.get(key);
      if (last !== undefined && now - last < CALL_TO_ARMS_COOLDOWN) continue;
      sent.set(key, now);
      this.mg.displayMessage(
        "events_display.ally_under_attack",
        MessageType.ATTACK_REQUEST,
        ally.id(),
        undefined,
        { ally: defender.displayName(), attacker: this._owner.displayName() },
        undefined,
        defender.id(),
        { attacker: this._owner.id(), target: defender.id() },
      );
    }
  }

  // Fork: population density of this tile and of the defender's land.
  private density(
    defender: Player,
    tile: TileRef,
  ): { tileWeight: number; totalWeight: number } {
    const density = this.mg.config().populationDensity();
    return {
      tileWeight: density.tileWeight(this.mg, defender, tile),
      totalWeight: density.totalWeight(this.mg, defender),
    };
  }

  private attackLogicInput(
    attackTroops: number,
    tile: TileRef,
    borderSize: number,
  ): AttackLogicInput {
    const defender = this.target.isPlayer() ? this.target : null;
    // Same test as scanning nearbyUnits() for a post owned by the defender
    // (active, not under construction, within range), without building a
    // result array per conquered tile — this runs for every tile of every
    // attack on the map.
    const defenderHasDefensePost =
      defender !== null &&
      this.mg.hasUnitNearby(
        tile,
        this.mg.config().defensePostRange(),
        UnitType.DefensePost,
        defender.id(),
      );
    return {
      terrain: this.map.terrainType(tile),
      attackTroops,
      attacker: {
        type: this._owner.type(),
        numTiles: this._owner.numTilesOwned(),
      },
      defender:
        defender === null
          ? null
          : {
              type: defender.type(),
              numTiles: defender.numTilesOwned(),
              troops: defender.troops(),
              isTraitor: defender.isTraitor(),
              isDisconnectedTeammate:
                defender.isDisconnected() && this._owner.isOnSameTeam(defender),
              ...this.density(defender, tile),
            },
      defenderHasDefensePost,
      attackerHasTankSupport: defender !== null && this.tankSupport(tile),
      ...this.forkInputs(defender, tile),
      falloutRatio: this.mg.hasFallout(tile)
        ? this.mg.numTilesWithFallout() / this.mg.numLandTiles()
        : null,
      borderSize,
    };
  }

  // Fork: training, entrenchment and alliance inputs for one tile.
  private forkInputs(
    defender: Player | null,
    tile: TileRef,
  ): Partial<AttackLogicInput> {
    const ctx = this.tickCtx;
    if (defender === null || ctx === null) return {};
    return {
      attackerTrained: ctx.attacker.input(this.mg, this.trainedShare, tile),
      defenderTrained: ctx.defender?.input(
        this.mg,
        defender.trainedShare(),
        tile,
      ),
      entrenchment: this.mg.entrenchment(tile, defender),
      defenderBaseLevels: ctx.defenderBaseLevels,
      defenderHasAllySupport: this.allySupport(tile),
      attackerHasJointAttack: ctx.jointAttack,
    };
  }

  private rejectIncomingAllianceRequests(target: Player) {
    const request = this._owner
      .incomingAllianceRequests()
      .find((ar) => ar.requestor() === target);
    if (request !== undefined) {
      request.reject();
    }
  }

  private addNeighbors(tile: TileRef) {
    if (this.attack === null) {
      throw new Error("Attack not initialized");
    }

    const tickNow = this.mg.ticks(); // cache tick

    const numNeighbors = this.map.neighbors4(tile, this.nbuf);
    for (let i = 0; i < numNeighbors; i++) {
      const neighbor = this.nbuf[i];
      if (
        this.map.isWater(neighbor) ||
        this.map.isImpassable(neighbor) ||
        this.map.ownerID(neighbor) !== this.targetSmallID
      ) {
        continue;
      }
      this.attack.addBorderTile(neighbor);
      let numOwnedByMe = 0;
      const numInner = this.map.neighbors4(neighbor, this.nbuf2);
      for (let j = 0; j < numInner; j++) {
        if (this.map.ownerID(this.nbuf2[j]) === this.ownerSmallID) {
          numOwnedByMe++;
        }
      }

      let mag: number;
      switch (this.map.terrainType(neighbor)) {
        case TerrainType.Plains:
          mag = 1;
          break;
        case TerrainType.Highland:
          mag = 1.5;
          break;
        case TerrainType.Mountain:
          mag = 2;
          break;
        default:
          mag = 0;
          break;
      }

      const priority =
        (this.random.nextInt(0, 7) + 10) * (1 - numOwnedByMe * 0.5 + mag / 2) +
        tickNow;

      this.toConquer.enqueue(neighbor, priority);
    }
  }

  private handleDeadDefender() {
    if (!(this.target.isPlayer() && this.target.numTilesOwned() < 100)) return;
    const target: Player = this.target;

    this.mg.conquerPlayer(this._owner, target);

    const MAX_PASSES = 100;
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      let progressed = false;
      for (const tile of target.tiles()) {
        let borders = false;
        this.mg.forEachNeighbor(tile, (t) => {
          if (!borders && this.mg.owner(t) === this._owner) {
            borders = true;
          }
        });
        if (borders) {
          this._owner.conquer(tile);
          progressed = true;
        } else {
          let captured = false;
          this.mg.forEachNeighbor(tile, (neighbor) => {
            if (captured) return;
            const no = this.mg.owner(neighbor);
            if (no.isPlayer() && no !== target && !no.isFriendly(target)) {
              this.mg.player(no.id()).conquer(tile);
              captured = true;
            }
          });
          if (captured) progressed = true;
        }
      }
      if (!progressed) break;
    }
  }

  owner(): Player {
    return this._owner;
  }

  isActive(): boolean {
    return this.active;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return AttackExecutionSnapshot.write({
      active: this.active,
      initialized: this.mg !== undefined,
      toConquer: this.toConquer.getState(),
      random: w.random(this.random),
      target: this.target === undefined ? null : w.owner(this.target),
      attack: this.attack === null ? null : w.attack(this.attack),
      startTroops: this.startTroops,
      owner: w.player(this._owner),
      targetID: this._targetID,
      sourceTile: this.sourceTile,
      removeTroops: this.removeTroops,
      trainedShare: this.trainedShare,
    });
  }

  restoreSnapshot(s: AttackExecutionState, r: SnapshotReader): void {
    this.active = s.active;
    this.toConquer = FlatBinaryHeap.fromState(s.toConquer);
    this.random = r.random(s.random);
    if (s.initialized) {
      this.mg = r.game;
      this.map = r.game.map();
    }
    if (s.target !== null) {
      this.target = r.owner(s.target);
      // Set together with target in init(); small ids are the stored refs.
      this.ownerSmallID = s.owner;
      this.targetSmallID = s.target;
    }
    this.attack = s.attack === null ? null : r.attack(s.attack);
    // Scratch buffers, overwritten before every read.
    this.nbuf = [0, 0, 0, 0];
    this.nbuf2 = [0, 0, 0, 0];
    this.startTroops = s.startTroops;
    this._owner = r.player(s.owner);
    this._targetID = s.targetID;
    this.sourceTile = s.sourceTile;
    this.removeTroops = s.removeTroops;
    this.trainedShare = s.trainedShare;
    // Rebuilt at the start of every tick.
    this.tickCtx = null;
  }
}

const AttackExecutionStateSchema = z.object({
  active: z.boolean(),
  initialized: z.boolean(),
  // Exact heap layout: ties between equal priorities dequeue by position.
  toConquer: z.object({
    pri: z.custom<Float32Array>(
      (v) => v instanceof Float32Array,
      "expected float32s",
    ),
    tiles: zTiles(),
    capacity: zInt(),
  }),
  random: zRandom(),
  /** Null until init() resolves the target. */
  target: zPlayerRef().nullable(),
  attack: zRef().nullable(),
  startTroops: zNum().nullable(),
  owner: zPlayerRef(),
  targetID: z.string().nullable(),
  sourceTile: zTile().nullable(),
  removeTroops: z.boolean(),
  trainedShare: zNum(),
});
type AttackExecutionState = z.infer<typeof AttackExecutionStateSchema>;

export const AttackExecutionSnapshot = execSnapshotType({
  name: "Attack",
  version: 2,
  migrations: {
    // Fork: trained troops (Military Base).
    1: (d) => ({ ...d, trainedShare: 0 }),
  },
  schema: AttackExecutionStateSchema,
  cls: () => AttackExecution,
});
