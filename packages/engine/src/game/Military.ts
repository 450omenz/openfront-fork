import { TileRef } from "@openfront/engine-api/game/GameMap";
import { Climate, UnitType } from "@openfront/engine-api/game/GameTypes";
import { climateAt, homeClimate } from "@openfront/engine-lib/game/Climate";
import { Game, Player } from "./Game";

/**
 * Military Bases (fork): trained troops, home climates and the combat input
 * they produce. See docs/ForkExtending.md.
 */

/**
 * Fork: who fights alongside the player — allies plus fellow coalition
 * members, each once. Ally support, joint attacks, lent training and the
 * call to arms all use this.
 */
export function friendsForWar(player: Player): Player[] {
  const allies = player.allies();
  const coalition = player.coalition();
  if (coalition === null) return allies;
  const out = [...allies];
  for (const m of coalition.members()) {
    if (m !== player && !out.includes(m)) out.push(m);
  }
  return out;
}

/** How often (ticks) the trained pool grows. */
export const TRAIN_INTERVAL = 10;

/**
 * Training level: the player's working base levels plus a share of the levels
 * of allies that border them ("lend trained troops").
 */
export function trainingLevel(game: Game, player: Player): number {
  const config = game.config();
  const level = config.workingMilitaryBases(player);
  // Cheap check first: lending needs an ally with a working base. Most of the
  // time there is none, and nearby() (a full border scan whenever any tile on
  // the map changed hands) is the expensive part.
  let allyHasBase = false;
  for (const a of friendsForWar(player)) {
    if (config.workingMilitaryBases(a) > 0) {
      allyHasBase = true;
      break;
    }
  }
  if (!allyHasBase) return level;
  const lent = lentLevels(game, player);
  return Math.min(
    level + lent * config.allyTrainingShare(),
    config.militaryBaseMaxCounted(),
  );
}

// Base levels of allies that border the player. Attacks already ask once per
// player per tick (AttackExecution's trainingFor memo).
function lentLevels(game: Game, player: Player): number {
  const config = game.config();
  let lent = 0;
  for (const n of player.nearby()) {
    if (
      !n.isPlayer() ||
      (!player.isAlliedWith(n) && !player.isCoalitionMember(n))
    ) {
      continue;
    }
    lent += config.workingMilitaryBases(n);
  }
  return lent;
}

// What the client is told about each player's training, refreshed every
// TRAIN_INTERVAL by trainTick. Display only: never read by the simulation, so
// it can live outside the player (and its snapshot).
const views = new WeakMap<
  Player,
  { trainingLevel10: number; homeClimates: number }
>();

/** Training level (x10) and home-climate bitmask for the player update. */
export function trainingView(player: Player): {
  trainingLevel10: number;
  homeClimates: number;
} {
  return views.get(player) ?? { trainingLevel10: 0, homeClimates: 0 };
}

/** Called every tick from PlayerExecution; grows the trained pool. */
export function trainTick(game: Game, player: Player, ticks: number): void {
  if ((ticks + player.smallID()) % TRAIN_INTERVAL !== 0) return;
  const config = game.config();
  const level = trainingLevel(game, player);
  let mask = 0;
  if (level > 0) {
    for (const c of homeClimates(game, player)) mask |= 1 << c;
  }
  views.set(player, {
    trainingLevel10: Math.round(level * 10),
    homeClimates: mask,
  });
  const troops = player.troops();
  if (level <= 0 || troops <= 0) return;
  const cap = Math.floor(troops * config.trainedCap(level));
  const trained = player.trainedTroops();
  if (trained >= cap) {
    // Lost a base level: shrink to the new cap.
    if (trained > cap) player.setTrainedTroops(cap);
    return;
  }
  const add = Math.max(
    1,
    Math.floor(troops * config.trainRatePerLevel() * level * TRAIN_INTERVAL),
  );
  player.trainTroops(Math.min(add, cap - trained));
}

/** Climates the player's working bases are at home in. */
export function homeClimates(game: Game, player: Player): Set<Climate> {
  const out = new Set<Climate>();
  const radius = game.config().militaryBaseClimateRadius();
  for (const u of player.units(UnitType.MilitaryBase)) {
    if (!u.isActive() || u.isUnderConstruction()) continue;
    out.add(homeClimate(game, u.tile(), radius, u));
  }
  return out;
}

/** One side's training, as attackLogic takes it. */
export interface TrainedInput {
  /** Share of the fighting troops that are trained, 0..1. */
  share: number;
  level: number;
  /** The tile is in one of the side's home climates. */
  homeMatch: boolean;
}

/**
 * Per-player training state for one tick: level and home climates, computed
 * once and reused for every tile an attack takes that tick.
 */
export class TrainingSnapshot {
  readonly level: number;
  readonly climates: Set<Climate>;

  constructor(game: Game, player: Player) {
    this.level = trainingLevel(game, player);
    this.climates =
      this.level > 0 ? homeClimates(game, player) : new Set<Climate>();
  }

  input(game: Game, share: number, tile: TileRef): TrainedInput | undefined {
    const out = { share: 0, level: 0, homeMatch: false };
    return this.fill(out, game, share, tile) ? out : undefined;
  }

  /** input() without allocating: fills `out`, false when there's no effect. */
  fill(out: TrainedInput, game: Game, share: number, tile: TileRef): boolean {
    if (this.level <= 0 || share <= 0) return false;
    const c = this.climates.size > 0 ? climateAt(game, tile) : null;
    out.share = share;
    out.level = this.level;
    out.homeMatch = c !== null && this.climates.has(c);
    return true;
  }
}
