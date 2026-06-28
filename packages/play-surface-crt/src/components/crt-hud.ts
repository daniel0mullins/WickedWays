import { LitElement, html, css, nothing } from "lit";
import type { TemplateResult } from "lit";
import type { ViewModel } from "@wickedways/play-runtime";
import { linkNouns } from "../link-nouns.js";

/** Persistent bottom HUD; re-renders location, loot, inventory, and exits on every turn. */
export class CrtHud extends LitElement {
  static override properties = {
    vm: { attribute: false },
    clickableNouns: { attribute: false },
  };
  declare vm: ViewModel;
  declare clickableNouns: string[];

  constructor() {
    super();
    this.vm = {
      room: { id: "", name: "", description: "", isLit: true },
      exits: [],
      lockedDoors: [],
      occupants: [],
      loot: [],
      inventory: { items: [], keys: [], equippedNames: [] },
      scope: [],
      status: { locationName: "", turn: 0, maxTurns: 0, sanity: 0, health: 0 },
      outcome: "",
      finished: false,
    };
    this.clickableNouns = [];
  }

  static override styles = css`
    :host { display: block; }
    .hud {
      padding: .25rem 1rem; position: relative; z-index: 1;
      border-top: 1px solid var(--color-border);
      color: var(--color-text);
      display: flex; flex-direction: column; gap: .05em;
    }
    .hud-line { white-space: pre-wrap; line-height: 1.2; }
    .hud-label { font-weight: bold; color: color-mix(in srgb, var(--color-accent) 72%, var(--color-bg)); }
    .exit-link {
      cursor: pointer; text-decoration: underline;
      text-underline-offset: 2px; color: var(--color-accent);
    }
    .exit-locked { color: var(--color-muted); opacity: 0.7; }
    .noun {
      cursor: pointer; text-decoration: underline dotted;
      text-underline-offset: 2px; color: var(--color-text);
    }
  `;

  #emitFill(value: string): void {
    this.dispatchEvent(
      new CustomEvent("fill-input", { detail: { value }, bubbles: true, composed: true }),
    );
  }

  /** Render a string with noun segments as clickable `.noun` spans. */
  #renderLinked(text: string): TemplateResult {
    const segments = linkNouns(text, this.clickableNouns);
    return html`${segments.map((seg) => {
      if (seg.noun !== undefined) {
        const noun = seg.noun;
        return html`<span class="noun" @click=${() => this.#emitFill(`examine ${noun}`)}>${seg.text}</span>`;
      }
      return seg.text;
    })}`;
  }

  /** A hud line with a bold label followed by a space and body content. */
  #hudLine(label: string, body: TemplateResult): TemplateResult {
    return html`<div class="hud-line"><span class="hud-label">${label}</span> ${body}</div>`;
  }

  override render() {
    const vm = this.vm;

    // "Here:" loot line — only when there is loot.
    const lootDescs = vm.loot.map((l) => l.description.replace(/\.\s*$/, ""));
    const hereLine = lootDescs.length
      ? this.#hudLine("Here:", this.#renderLinked(`${lootDescs.join(", ")}.`))
      : nothing;

    // "Carrying:" line — always present.
    const equipped = new Set(vm.inventory.equippedNames);
    const carried = [
      ...vm.inventory.items.map((i) => (equipped.has(i.name) ? `${i.name} (equipped)` : i.name)),
      ...vm.inventory.keys.map((k) => k.name),
      // Equipped gear that has left the items list still belongs on the readout.
      ...vm.inventory.equippedNames
        .filter((n) => !vm.inventory.items.some((i) => i.name === n))
        .map((n) => `${n} (equipped)`),
    ];
    const carryingBody = this.#renderLinked(
      `${carried.length ? carried.join(", ") : "nothing"}.`,
    );

    // "Exits:" line — passable exits as clickable links; locked doors as dim text.
    const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
    const exitParts: TemplateResult[] = [];
    for (const e of vm.exits) {
      const dir = e.dir;
      exitParts.push(
        html`<span class="exit-link" @click=${() => this.#emitFill(`go ${dir}`)}>${cap(e.dir)}</span>`,
      );
    }
    for (const d of vm.lockedDoors) {
      exitParts.push(
        html`<span class="exit-locked">${cap(d.dir)} (${d.name}, locked)</span>`,
      );
    }
    if (exitParts.length === 0) {
      exitParts.push(html`<span class="exit-locked">none</span>`);
    }
    const exitsBody = html`${exitParts.map((part, i) => html`${i > 0 ? ", " : nothing}${part}`)}`;

    return html`
      <div id="hud" class="hud">
        ${hereLine}
        ${this.#hudLine("Carrying:", carryingBody)}
        ${this.#hudLine("Exits:", exitsBody)}
      </div>
    `;
  }
}

customElements.define("crt-hud", CrtHud);

declare global {
  interface HTMLElementTagNameMap {
    "crt-hud": CrtHud;
  }
}
