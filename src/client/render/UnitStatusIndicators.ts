import { UnitStatus } from "@openfront/engine-api/game/GameTypes";

/**
 * Registry of per-unit status indicators (fork).
 *
 * The engine sets UnitStatus bits on a unit; StatusIndicatorPass draws one
 * indicator for every bit that has an entry here. To add an indicator:
 *   1. append a bit to UnitStatus (packages/engine-api/src/game/GameTypes.ts)
 *   2. set it from the unit's execution with unit.setStatus(bit, on)
 *   3. add an entry below
 * No renderer changes are needed: shapes are drawn procedurally.
 */
export type IndicatorShape =
  /** Round "!" badge above the unit — "this isn't working". */
  | "badge"
  /** Expanding ring around the unit — "this is doing something now". */
  | "ring";

export interface StatusIndicator {
  flag: UnitStatus;
  shape: IndicatorShape;
  /** Linear RGB, 0–1. */
  color: readonly [number, number, number];
  /** Badge diameter or max ring radius, in tiles. */
  size: number;
  /** Vertical offset of the indicator's center from the unit, in tiles (negative = up). */
  offsetY: number;
  /** Blink (badge) or ring-pulse frequency, in Hz. */
  pulseHz: number;
}

export const STATUS_INDICATORS: readonly StatusIndicator[] = [
  {
    flag: UnitStatus.NoFunds,
    shape: "badge",
    color: [0.95, 0.27, 0.2],
    size: 5,
    offsetY: -6,
    pulseHz: 1.2,
  },
  {
    flag: UnitStatus.SupportingAttack,
    shape: "ring",
    color: [1.0, 0.72, 0.18],
    size: 8,
    offsetY: 0,
    pulseHz: 1.5,
  },
];

/** Shader-side cap on registry entries (uniform array length). */
export const MAX_STATUS_INDICATORS = 8;

if (STATUS_INDICATORS.length > MAX_STATUS_INDICATORS) {
  throw new Error(
    `STATUS_INDICATORS has ${STATUS_INDICATORS.length} entries; the shader supports ${MAX_STATUS_INDICATORS}`,
  );
}

export const SHAPE_CODE: Record<IndicatorShape, number> = {
  badge: 0,
  ring: 1,
};

/** Registry indices of the indicators active for these status bits. */
export function activeIndicatorIndices(statusFlags: number): number[] {
  const out: number[] = [];
  if (statusFlags === 0) return out;
  STATUS_INDICATORS.forEach((ind, i) => {
    if ((statusFlags & ind.flag) !== 0) out.push(i);
  });
  return out;
}
