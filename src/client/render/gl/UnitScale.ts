import type { RenderSettings } from "./RenderSettings";

/**
 * Unit sprite scaling (fork). Shared by UnitPass, BarPass and
 * StatusIndicatorPass so health bars and status rings stay attached to the
 * sprite they belong to.
 *
 * Units are drawn unitSize tiles wide, so on screen they are
 * unitSize × zoom pixels: specks when zoomed out on a big map, giant when
 * zoomed in. screenScale() returns the factor that keeps that on-screen
 * size inside [minScreenPx, maxScreenPx]; between the two, units scale with
 * the map as before. sizeMultiplier (the "Unit size" graphics setting) then
 * scales the result.
 *
 * Per-type size lives in render-settings.json → unit.typeScale, keyed by the
 * unit type's name ("Tank", "Warship", …). A unit type with no entry draws
 * at 1. Adding a unit needs no code here, only (optionally) a typeScale entry.
 */
export type UnitScaleSettings = Pick<
  RenderSettings["unit"],
  "unitSize" | "sizeMultiplier" | "minScreenPx" | "maxScreenPx" | "typeScale"
>;

/** World-size multiplier for every unit at this zoom (screen px per tile). */
export function screenScale(zoom: number, s: UnitScaleSettings): number {
  // The clamp works on the unscaled size so the user's multiplier still
  // applies at every zoom.
  const px = s.unitSize * zoom;
  if (px <= 0) return s.sizeMultiplier;
  const clamped = Math.min(Math.max(px, s.minScreenPx), s.maxScreenPx);
  return (clamped / px) * s.sizeMultiplier;
}

/** Per-type size multiplier (1 when the type has no entry). */
export function typeScale(unitType: string, s: UnitScaleSettings): number {
  return s.typeScale[unitType] ?? 1;
}
