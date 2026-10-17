import { MessageType, UnitType } from "@openfront/engine-api/game/GameTypes";
import { wouldNukeBreakAlliance } from "@openfront/engine-lib/execution/NukeAlliance";
import { Game, Player } from "./Game";

/**
 * Two players just made peace (an alliance, or a coalition joining): nukes
 * either has in flight at the other are destroyed, and both are told.
 */
export function cancelNukesBetween(mg: Game, a: Player, b: Player): void {
  const neutralized = new Map<Player, number>();
  const cancelledWarheadLaunchers = new Set<Player>();

  const players = [a, b];

  for (const launcher of players) {
    const other = launcher === a ? b : a;

    for (const unit of launcher.units([
      UnitType.AtomBomb,
      UnitType.HydrogenBomb,
      UnitType.MIRV,
      UnitType.MIRVWarhead,
    ])) {
      if (!unit.isActive() || unit.reachedTarget()) continue;

      const targetTile = unit.targetTile();

      if (unit.type() === UnitType.MIRV) {
        // Compare against the captured target player at launch rather than
        // the tile's current owner, so tile ownership changes mid-flight
        // (e.g. from third-party conquest or fallout) don't skip cancellation
        // while the MIRV continues seeking the newly allied player's tiles.
        const target =
          unit.targetPlayer() ?? (targetTile ? mg.owner(targetTile) : null);
        if (target !== other) continue;
      } else if (unit.type() === UnitType.MIRVWarhead) {
        if (!targetTile || mg.owner(targetTile) !== other) continue;
      } else {
        if (!targetTile) continue;
        const magnitude = mg.config().nukeMagnitudes(unit.type());
        if (
          !wouldNukeBreakAlliance({
            game: mg,
            targetTile,
            magnitude,
            allySmallIds: new Set([other.smallID()]),
            threshold: mg.config().nukeAllianceBreakThreshold(),
          })
        ) {
          continue;
        }
      }

      unit.delete(false);
      if (unit.type() === UnitType.MIRVWarhead) {
        cancelledWarheadLaunchers.add(launcher);
      } else {
        neutralized.set(launcher, (neutralized.get(launcher) ?? 0) + 1);
      }
    }
  }

  for (const launcher of cancelledWarheadLaunchers) {
    neutralized.set(launcher, (neutralized.get(launcher) ?? 0) + 1);
  }

  for (const [launcher, count] of neutralized) {
    const other = launcher === a ? b : a;

    mg.displayMessage(
      "events_display.alliance_nukes_destroyed_outgoing",
      MessageType.ALLIANCE_ACCEPTED,
      launcher.id(),
      undefined,
      { name: other.displayName(), count },
      undefined,
      other.id(),
    );

    mg.displayMessage(
      "events_display.alliance_nukes_destroyed_incoming",
      MessageType.ALLIANCE_ACCEPTED,
      other.id(),
      undefined,
      { name: launcher.displayName(), count },
      undefined,
      launcher.id(),
    );
  }
}
