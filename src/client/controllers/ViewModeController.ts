/**
 * ViewModeController — forwards map view-mode toggles to the WebGL view.
 *
 * - AlternateViewEvent: space-hold (and the settings-modal toggle) drives the
 *   affiliation recolor + grid overlay + hides names.
 * - ToggleCoordinateGridEvent: persistent coordinate-grid toggle (M keybind);
 *   grid shows but names stay visible.
 * - Fork: the view picker / V hotkey choose a ViewMode (../render/ViewMode),
 *   which stays on until changed. Overlay modes (population density, climate)
 *   are computed here from the game view and pushed to the renderer.
 */

import { EventBus } from "@openfront/shared/EventBus";
import { Controller } from "../Controller";
import { AlternateViewEvent, ToggleCoordinateGridEvent } from "../InputHandler";
import { MapRenderer } from "../render/gl";
import {
  isOverlayMode,
  loadViewMode,
  nextViewMode,
  saveViewMode,
  VIEW_MODES,
  ViewMode,
} from "../render/ViewMode";
import {
  climateOverlay,
  densityOverlay,
  TileOverlay,
} from "../render/ViewOverlayData";
import { UserSettings } from "../UserSettings";
import {
  CycleViewModeEvent,
  SetMapLayerVisibleEvent,
  SetViewModeEvent,
  ViewModeChangedEvent,
} from "../ViewModeEvents";
import type { GameView } from "../view/GameView";

/** How often the density overlay is rebuilt while shown. */
const DENSITY_REFRESH_MS = 1000;

export class ViewModeController implements Controller {
  private mode: ViewMode = ViewMode.Normal;
  private lastDensity = 0;
  private densityBuf: Uint8Array | undefined;
  private climate: TileOverlay | null = null;

  constructor(
    private eventBus: EventBus,
    private view: MapRenderer,
    // Null in replays: the overlay modes need a live game view.
    private game: GameView | null = null,
    private userSettings: UserSettings | null = null,
  ) {}

  init() {
    this.eventBus.on(AlternateViewEvent, (e) =>
      this.view.setAltView(e.alternateView),
    );
    this.eventBus.on(ToggleCoordinateGridEvent, (e) =>
      this.view.setGridView(e.enabled),
    );
    this.eventBus.on(CycleViewModeEvent, () =>
      this.setMode(nextViewMode(this.mode, this.availableModes())),
    );
    this.eventBus.on(SetViewModeEvent, (e) => this.setMode(e.mode));
    this.eventBus.on(SetMapLayerVisibleEvent, (e) =>
      this.setLayerVisible(e.layerId, e.visible),
    );
    const saved = loadViewMode();
    this.setMode(
      this.availableModes().includes(saved) ? saved : ViewMode.Normal,
    );
  }

  tick() {
    if (this.mode !== ViewMode.Density || this.game === null) return;
    const now = performance.now();
    if (now - this.lastDensity < DENSITY_REFRESH_MS) return;
    this.pushDensity();
  }

  availableModes(): readonly ViewMode[] {
    return this.game === null
      ? VIEW_MODES.filter((m) => !isOverlayMode(m))
      : VIEW_MODES;
  }

  private setMode(mode: ViewMode) {
    this.mode = mode;
    saveViewMode(mode);
    this.view.setViewModeFlags({
      terrain: mode === ViewMode.Terrain,
      grid: mode === ViewMode.Grid,
      flat: mode === ViewMode.Flat,
    });
    if (mode === ViewMode.Density && this.game !== null) {
      this.pushDensity();
    } else if (mode === ViewMode.Climate && this.game !== null) {
      // Terrain only changes with water nukes; rebuilt on each switch.
      this.climate = climateOverlay(this.game);
      this.view.setTileOverlay(this.climate);
    } else {
      this.view.setTileOverlay(null);
    }
    this.eventBus.emit(new ViewModeChangedEvent(mode));
  }

  private pushDensity() {
    if (this.game === null) return;
    this.lastDensity = performance.now();
    const overlay = densityOverlay(this.game, this.densityBuf);
    this.densityBuf = overlay.indices;
    this.view.setTileOverlay(overlay);
  }

  private setLayerVisible(layerId: string, visible: boolean) {
    this.view.setLayerVisible(layerId, visible);
    if (this.userSettings === null) return;
    const current = this.userSettings.graphicsOverrides();
    this.userSettings.setGraphicsOverrides({
      ...current,
      mapLayerVisibility: {
        ...(current.mapLayerVisibility ?? {}),
        [layerId]: visible,
      },
    });
  }
}
