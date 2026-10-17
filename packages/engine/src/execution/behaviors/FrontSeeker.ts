import { Game, Unit } from "../../game/Game";
import { FrontOrder, frontOrderFor } from "./FrontAssigner";

/**
 * Reusable "go where the fighting is" behavior for land units (fork).
 *
 * seekFront() answers, for one unit: stay put, drive to a stage tile behind
 * the front, or nothing to do. The answer comes from FrontAssigner, which
 * places all of the owner's units of this type together so they spread
 * along the line (attacks, defenses, and hostile borders; see FrontMap).
 *
 * Any unit execution can use it; see TankExecution for the pattern: call
 * registerFrontUnit() in init/restoreSnapshot, seek on a fixed interval
 * (every unit on the same tick), and never override a player's own order.
 */
export type FrontSeekResult = FrontOrder;

export function seekFront(mg: Game, unit: Unit): FrontSeekResult {
  return frontOrderFor(mg, unit);
}
