import { Climate } from "@openfront/engine-api/game/GameTypes";
import { EventBus } from "@openfront/shared/EventBus";
import { html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import { Controller } from "../../Controller";
import { MapRenderer } from "../../render/gl";
import {
  isOverlayMode,
  loadViewMode,
  VIEW_MODES,
  ViewMode,
} from "../../render/ViewMode";
import {
  CLIMATE_COLORS,
  DENSITY_SCALE_MAX,
  heatColor,
} from "../../render/ViewOverlayData";
import { translateText } from "../../Utils";
import {
  SetMapLayerVisibleEvent,
  SetViewModeEvent,
  ViewModeChangedEvent,
} from "../../ViewModeEvents";

const CLIMATE_KEYS: Record<Climate, string> = {
  [Climate.Temperate]: "climate.temperate",
  [Climate.Arid]: "climate.arid",
  [Climate.Cold]: "climate.cold",
  [Climate.Coastal]: "climate.coastal",
  [Climate.Highland]: "climate.highland",
};

export function climateName(c: Climate): string {
  return translateText(CLIMATE_KEYS[c]);
}

/**
 * The map view picker (fork): a button under the top-right bar that opens a
 * list of view modes, the map's own image layers, and a legend for the
 * overlay modes. V cycles the modes without opening it.
 */
@customElement("view-mode-picker")
export class ViewModePicker extends LitElement implements Controller {
  public eventBus: EventBus;
  public view: MapRenderer | null = null;
  /** Overlay modes need a live game; replays leave them out. */
  public overlaysAvailable = true;

  @state() private mode: ViewMode = ViewMode.Normal;
  @state() private open = false;
  // Bumped to re-render after a layer toggle (MapRenderer holds the state).
  @state() private layerVersion = 0;

  createRenderRoot() {
    return this;
  }

  init() {
    this.mode = loadViewMode();
    this.eventBus.on(ViewModeChangedEvent, (e) => {
      this.mode = e.mode;
    });
  }

  private modes(): readonly ViewMode[] {
    return this.overlaysAvailable
      ? VIEW_MODES
      : VIEW_MODES.filter((m) => !isOverlayMode(m));
  }

  private choose(mode: ViewMode) {
    this.eventBus.emit(new SetViewModeEvent(mode));
  }

  private toggleLayer(id: string) {
    if (this.view === null) return;
    this.eventBus.emit(
      new SetMapLayerVisibleEvent(id, !this.view.isLayerVisible(id)),
    );
    this.layerVersion++;
  }

  private layerName(id: string): string {
    const key = `map_layers.${id}`;
    const t = translateText(key);
    return t === key ? id : t;
  }

  private renderLegend() {
    if (this.mode === ViewMode.Climate) {
      return html`<div class="mt-2 pt-2 border-t border-white/10 grid gap-1">
        ${Object.entries(CLIMATE_COLORS).map(
          ([c, rgb]) =>
            html`<div class="flex items-center gap-2 text-xs">
              <span
                class="inline-block w-3 h-3 rounded-sm"
                style="background: rgb(${rgb.join(",")})"
              ></span>
              ${climateName(Number(c) as Climate)}
            </div>`,
        )}
      </div>`;
    }
    if (this.mode === ViewMode.Density) {
      const stops = [0, 0.25, 0.5, 0.75, 1]
        .map((f) => `rgba(${heatColor(f).slice(0, 3).join(",")},1) ${f * 100}%`)
        .join(", ");
      return html`<div class="mt-2 pt-2 border-t border-white/10 text-xs">
        <div
          class="h-2 rounded-sm"
          style="background: linear-gradient(to right, ${stops})"
        ></div>
        <div class="flex justify-between text-slate-400 mt-0.5">
          <span>${translateText("view_mode.density_sparse")}</span>
          <span>${DENSITY_SCALE_MAX.toLocaleString()}+</span>
        </div>
        <div class="text-slate-400 mt-1">
          ${translateText("view_mode.density_desc")}
        </div>
      </div>`;
    }
    return null;
  }

  render() {
    if (this.eventBus === undefined) return null;
    void this.layerVersion;
    const layers = this.view?.mapLayers() ?? [];
    return html`
      <div class="relative flex flex-col items-end pr-1 text-white">
        <button
          class="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-gray-800/92 backdrop-blur-sm text-sm hover:bg-gray-700 pointer-events-auto"
          title=${translateText("view_mode.title")}
          @click=${() => (this.open = !this.open)}
          @contextmenu=${(e: Event) => e.preventDefault()}
        >
          <svg
            viewBox="0 0 24 24"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linejoin="round"
          >
            <path d="M12 3 2 8l10 5 10-5-10-5z" />
            <path d="m2 13 10 5 10-5" />
            <path d="m2 18 10 5 10-5" opacity="0.5" />
          </svg>
          <span>${translateText(`view_mode.${this.mode}`)}</span>
        </button>
        ${this.open
          ? html`<div
              class="mt-1 w-60 p-2 rounded-md bg-gray-800/95 backdrop-blur-sm shadow-lg pointer-events-auto"
              @contextmenu=${(e: Event) => e.preventDefault()}
            >
              <div class="text-xs uppercase tracking-wide text-slate-400 mb-1">
                ${translateText("view_mode.title")}
              </div>
              ${this.modes().map(
                (m) =>
                  html`<button
                    class="w-full flex items-center gap-2 px-2 py-1 rounded-sm text-left text-sm ${m ===
                    this.mode
                      ? "bg-sky-700/70"
                      : "hover:bg-gray-700"}"
                    @click=${() => this.choose(m)}
                  >
                    <span
                      class="inline-block w-2 h-2 rounded-full ${m === this.mode
                        ? "bg-white"
                        : "border border-slate-400"}"
                    ></span>
                    <span class="flex-1"
                      >${translateText(`view_mode.${m}`)}</span
                    >
                  </button>`,
              )}
              ${this.renderLegend()}
              ${layers.length > 0
                ? html`<div class="mt-2 pt-2 border-t border-white/10">
                    <div
                      class="text-xs uppercase tracking-wide text-slate-400 mb-1"
                    >
                      ${translateText("view_mode.map_layers")}
                    </div>
                    ${layers.map(
                      (l) =>
                        html`<label
                          class="flex items-center gap-2 px-2 py-0.5 text-sm cursor-pointer"
                        >
                          <input
                            type="checkbox"
                            .checked=${this.view?.isLayerVisible(l.id) ?? true}
                            @change=${() => this.toggleLayer(l.id)}
                          />
                          ${this.layerName(l.id)}
                        </label>`,
                    )}
                  </div>`
                : null}
              <div class="mt-2 text-xs text-slate-500">
                ${translateText("view_mode.hint")}
              </div>
            </div>`
          : null}
      </div>
    `;
  }
}
