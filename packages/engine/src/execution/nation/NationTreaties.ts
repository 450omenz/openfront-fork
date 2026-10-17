import { UnitType } from "@openfront/engine-api/game/GameTypes";
import { Game, Player } from "../../game/Game";
import { personalityOf } from "../../game/NationPersonality";

/**
 * How nations treat other players' treaties (fork). Both answer "should
 * this nation hold back from hitting `target` this way?"; the attack, nuke
 * and MIRV code skips the action when they say yes.
 */

/**
 * The target's coalition bans `weapon`. Using it anyway gets the user
 * sanctioned and hunted, so most nations hold back; aggressive ones
 * (aggression >= 70) don't care unless they're cautious (60+) too.
 */
export function respectsWeaponBan(
  player: Player,
  target: Player,
  weapon: UnitType,
): boolean {
  const c = target.coalition();
  if (c === null || !c.bannedWeapons().has(weapon)) return false;
  const p = personalityOf(player);
  return p.aggression < DEFY_BAN_AGGRESSION || p.caution >= 60;
}

/**
 * We have a non-aggression pact with the target. Attacking breaks it and
 * marks us a traitor, so nations keep their word — except a disloyal one
 * (loyalty < 25) facing a partner it outnumbers 3 to 1: a backstab.
 */
export function respectsPact(
  game: Game,
  player: Player,
  target: Player,
): boolean {
  if (game.pacts().between(player, target) === null) return false;
  const p = personalityOf(player);
  const backstab =
    p.loyalty < BACKSTAB_LOYALTY &&
    player.troops() >= target.troops() * BACKSTAB_TROOP_RATIO;
  return !backstab;
}

const DEFY_BAN_AGGRESSION = 70;
const BACKSTAB_LOYALTY = 25;
const BACKSTAB_TROOP_RATIO = 3;
