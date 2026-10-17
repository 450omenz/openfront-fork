/**
 * Map view modes (fork). One is active at a time; the picker in the HUD and
 * the cycle hotkey choose it, and ViewModeController applies it.
 *
 * - Normal: the usual map.
 * - Terrain: terrain under faction colors (the old space-hold view, kept on).
 * - Flat: terrain colors off — land and water in two flat tones.
 * - Grid: the coordinate grid.
 * - Density: where people live (PopulationDensity), as a heat map.
 * - Climate: the climate zones Military Bases draw their home bonus from.
 */
export enum ViewMode {
  Normal = "normal",
  Terrain = "terrain",
  Flat = "flat",
  Grid = "grid",
  Density = "density",
  Climate = "climate",
}

export const VIEW_MODES: readonly ViewMode[] = [
  ViewMode.Normal,
  ViewMode.Terrain,
  ViewMode.Flat,
  ViewMode.Grid,
  ViewMode.Density,
  ViewMode.Climate,
];

/** Modes drawn with the tile overlay pass. */
export function isOverlayMode(mode: ViewMode): boolean {
  return mode === ViewMode.Density || mode === ViewMode.Climate;
}

const STORAGE_KEY = "fork:view_mode";

export function loadViewMode(): ViewMode {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    if (v !== null && (VIEW_MODES as readonly string[]).includes(v)) {
      return v as ViewMode;
    }
  } catch {
    // Storage unavailable (private mode, tests): fall through.
  }
  return ViewMode.Normal;
}

export function saveViewMode(mode: ViewMode): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // Ignore: the choice just won't persist.
  }
}

export function nextViewMode(
  mode: ViewMode,
  available: readonly ViewMode[] = VIEW_MODES,
): ViewMode {
  const i = available.indexOf(mode);
  return available[(i + 1) % available.length];
}
