import type { CoalitionView } from "@openfront/engine-api/game/GameUpdates";
import {
  COALITION_NAME_MAX,
  COALITION_NAME_REGEX,
  CoalitionIntent,
} from "@openfront/engine-api/Schemas";
import { EventBus, GameEvent } from "@openfront/shared/EventBus";
import { html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import { Controller } from "../../Controller";
import { SendCoalitionIntentEvent } from "../../Transport";
import { translateText } from "../../Utils";
import { GameView, PlayerView } from "../../view";

/** Fork: open (true), close (false) or toggle (undefined) the panel. */
export class ToggleCoalitionPanelEvent implements GameEvent {
  constructor(public readonly open?: boolean) {}
}

/**
 * Coalitions (fork): a button under the top-right bar opening the player's
 * coalition — name, leader, members, sanctions and the standing attack
 * order — with a form to found one when they have none. Actions on other
 * players (invite, kick, sanction, order an attack, hand over) live in the
 * player panel; this one leaves the coalition.
 */
@customElement("coalition-panel")
export class CoalitionPanel extends LitElement implements Controller {
  public eventBus: EventBus;
  public game: GameView;

  @state() private open = false;
  @state() private name = "";
  // Bumped every tick (throttled), so names, countdowns and lists refresh.
  @state() private version = 0;

  createRenderRoot() {
    return this;
  }

  init() {
    this.eventBus.on(ToggleCoalitionPanelEvent, (e) => {
      this.open = e.open ?? !this.open;
    });
    // game/eventBus are plain fields set before init: render now.
    this.requestUpdate();
  }

  tick() {
    // The button shows the coalition name, so refresh even when closed.
    this.version++;
  }

  getTickIntervalMs() {
    return 500;
  }

  private send(intent: CoalitionIntent) {
    this.eventBus.emit(new SendCoalitionIntentEvent(intent));
  }

  private nameValid(): boolean {
    const n = this.name.trim();
    return (
      n.length > 0 &&
      n.length <= COALITION_NAME_MAX &&
      COALITION_NAME_REGEX.test(n)
    );
  }

  private create() {
    if (!this.nameValid()) return;
    this.send({ type: "coalition_create", name: this.name.trim() });
    this.name = "";
  }

  private player(sid: number): PlayerView | null {
    const p = this.game.playerBySmallID(sid);
    return p.isPlayer() ? (p as PlayerView) : null;
  }

  private renderMine(me: PlayerView, c: CoalitionView) {
    const leader = this.player(c.leaderID);
    const target = c.targetID === null ? null : this.player(c.targetID);
    const secondsLeft =
      c.targetUntil === null
        ? 0
        : Math.max(0, Math.ceil((c.targetUntil - this.game.ticks()) / 10));
    return html`
      <div class="text-base font-semibold">${c.name}</div>
      <div class="text-xs text-slate-400 mb-2">
        ${translateText("coalition.led_by", {
          name: leader?.displayName() ?? "?",
        })}
      </div>
      <div class="text-xs uppercase tracking-wide text-slate-400">
        ${translateText("coalition.members", { count: c.memberIDs.length })}
      </div>
      <ul class="mb-2">
        ${c.memberIDs.map((sid) => {
          const p = this.player(sid);
          return html`<li class="flex items-center gap-1 text-sm">
            <span>${sid === c.leaderID ? "👑" : "•"}</span>
            <span class=${p === me ? "text-sky-300" : ""}
              >${p?.displayName() ?? "?"}</span
            >
          </li>`;
        })}
      </ul>
      ${target !== null && secondsLeft > 0
        ? html`<div class="text-sm text-red-300 mb-2">
            ${translateText("coalition.order", {
              target: target.displayName(),
              seconds: secondsLeft,
            })}
          </div>`
        : ""}
      ${c.sanctionIDs.length > 0
        ? html`<div class="text-xs uppercase tracking-wide text-slate-400">
              ${translateText("coalition.sanctions")}
            </div>
            <div class="text-sm text-yellow-300 mb-2">
              ${c.sanctionIDs
                .map((sid) => this.player(sid)?.displayName() ?? "?")
                .join(", ")}
            </div>`
        : ""}
      <div class="text-xs text-slate-400 mb-2">
        ${c.leaderID === me.smallID()
          ? translateText("coalition.leader_hint")
          : translateText("coalition.member_hint")}
      </div>
      <button
        class="w-full px-2 py-1 rounded-sm bg-red-700 hover:bg-red-600 text-sm"
        title=${translateText("coalition.leave_desc")}
        @click=${() => this.send({ type: "coalition_leave" })}
      >
        ${translateText("coalition.leave")}
      </button>
    `;
  }

  private renderCreate() {
    const others = this.game.coalitions();
    return html`
      <div class="text-sm mb-2">${translateText("coalition.none")}</div>
      <div class="text-xs text-slate-400 mb-2">
        ${translateText("coalition.explain")}
      </div>
      <div class="flex gap-1">
        <input
          class="flex-1 min-w-0 px-2 py-1 rounded-sm bg-gray-900 text-sm"
          maxlength=${COALITION_NAME_MAX}
          placeholder=${translateText("coalition.name_placeholder")}
          .value=${this.name}
          @input=${(e: Event) =>
            (this.name = (e.target as HTMLInputElement).value)}
          @keydown=${(e: KeyboardEvent) => {
            e.stopPropagation(); // typing must not trigger game hotkeys
            if (e.key === "Enter") this.create();
          }}
        />
        <button
          class="px-2 py-1 rounded-sm text-sm ${this.nameValid()
            ? "bg-indigo-700 hover:bg-indigo-600"
            : "bg-gray-700 opacity-50"}"
          ?disabled=${!this.nameValid()}
          @click=${() => this.create()}
        >
          ${translateText("coalition.create")}
        </button>
      </div>
      ${others.length > 0
        ? html`<div class="mt-2 pt-2 border-t border-white/10">
            <div class="text-xs uppercase tracking-wide text-slate-400 mb-1">
              ${translateText("coalition.others")}
            </div>
            ${others.map(
              (c) =>
                html`<div class="text-sm">
                  ${c.name}
                  <span class="text-slate-400">(${c.memberIDs.length})</span>
                </div>`,
            )}
          </div>`
        : ""}
    `;
  }

  render() {
    if (this.eventBus === undefined || this.game === undefined) return null;
    void this.version;
    const me = this.game.myPlayer();
    if (me === null) return null;
    const mine = me.coalition();
    return html`
      <div class="relative flex flex-col items-end pr-1 text-white">
        <button
          class="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-gray-800/92 backdrop-blur-sm text-sm hover:bg-gray-700 pointer-events-auto"
          title=${translateText("coalition.title")}
          @click=${() => (this.open = !this.open)}
          @contextmenu=${(e: Event) => e.preventDefault()}
        >
          <span>🤝</span>
          <span>${mine?.name ?? translateText("coalition.title")}</span>
        </button>
        ${this.open
          ? html`<div
              class="mt-1 w-64 p-2 rounded-md bg-gray-800/95 backdrop-blur-sm shadow-lg pointer-events-auto"
              @contextmenu=${(e: Event) => e.preventDefault()}
            >
              ${mine !== null ? this.renderMine(me, mine) : this.renderCreate()}
            </div>`
          : ""}
      </div>
    `;
  }
}
