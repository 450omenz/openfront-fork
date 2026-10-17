import { PlayerType, Relation } from "@openfront/engine-api/game/GameTypes";
import { Game, Player } from "../../game/Game";
import { personalityOf, scaled } from "../../game/NationPersonality";

/**
 * Nations as traders (fork). Reads the per-partner trade ledger
 * (Player.tradeVolumeWith) and turns it into diplomacy:
 *
 *  - Trade breeds friendship: relation with each partner rises with its
 *    share of our recent trade, up to Friendly.
 *  - A valued partner (a big enough share of our trade) is spared by the
 *    "weakest", "juicy" and "hated" attack picks unless we're aggressive,
 *    is not embargoed over a grudge, and gets alliances more easily.
 *
 * Mercantilism scales all of it. Off entirely when nationPersonalities()
 * is off, so the game then plays like the code before this behavior.
 * Stateless: everything comes from the ledger, which is in the snapshot.
 */
export class NationTradeBehavior {
  constructor(
    private game: Game,
    private player: Player,
  ) {}

  /** Once per decision cycle: warm relations with trade partners. */
  warmToPartners(): void {
    if (!tradeMinded(this.game, this.player)) return;
    const total = this.player.totalTradeVolume();
    if (total <= 0n) return;
    const merc = personalityOf(this.player).mercantilism;
    // Relation decays 0.05/tick toward 0; at share 1 this outpaces it.
    const perCycle = scaled(WARMTH_PER_CYCLE, merc, 0.8);
    for (const other of this.game.players()) {
      if (other === this.player || !other.isAlive()) continue;
      const vol = this.player.tradeVolumeWith(other);
      if (vol <= 0n) continue;
      if (this.player.relation(other) >= Relation.Friendly) continue;
      const share = Number(vol) / Number(total);
      this.player.updateRelation(other, perCycle * share);
    }
  }

  isValuedPartner(other: Player): boolean {
    return isValuedPartner(this.game, this.player, other);
  }
}

const WARMTH_PER_CYCLE = 8;
// Below this much recent gold a partner isn't worth protecting yet.
const MIN_PARTNER_GOLD = 20_000n;
// Share of our recent trade that makes a partner valued, at mercantilism
// 50; 100 lowers it to 10%, 0 raises it to 40%.
const VALUED_SHARE = 0.25;

function tradeMinded(game: Game, player: Player): boolean {
  return (
    player.type() === PlayerType.Nation && game.config().nationPersonalities()
  );
}

export function isValuedPartner(
  game: Game,
  player: Player,
  other: Player,
): boolean {
  if (!tradeMinded(game, player)) return false;
  const vol = player.tradeVolumeWith(other);
  if (vol < MIN_PARTNER_GOLD) return false;
  const total = player.totalTradeVolume();
  const merc = personalityOf(player).mercantilism;
  return Number(vol) / Number(total) >= scaled(VALUED_SHARE, merc, -0.6);
}

/**
 * A valued partner that attack picks other than retaliation leave alone.
 * Aggressive nations (aggression >= 70) attack partners anyway.
 */
export function isProtectedPartner(
  game: Game,
  player: Player,
  other: Player,
): boolean {
  return (
    personalityOf(player).aggression < 70 &&
    isValuedPartner(game, player, other)
  );
}
