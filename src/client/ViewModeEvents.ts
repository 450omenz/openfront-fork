import { GameEvent } from "@openfront/shared/EventBus";
import type { ViewMode } from "./render/ViewMode";

/** Hotkey: step to the next view mode. */
export class CycleViewModeEvent implements GameEvent {}

/** Picker: switch to a view mode. */
export class SetViewModeEvent implements GameEvent {
  constructor(public readonly mode: ViewMode) {}
}

/** Picker: show or hide one of the map's image layers. */
export class SetMapLayerVisibleEvent implements GameEvent {
  constructor(
    public readonly layerId: string,
    public readonly visible: boolean,
  ) {}
}

/** ViewModeController → UI: the active mode changed. */
export class ViewModeChangedEvent implements GameEvent {
  constructor(public readonly mode: ViewMode) {}
}
