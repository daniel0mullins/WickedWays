import { LitElement, html, css, nothing } from "lit";
import type { ScopeEntity } from "@wickedways/play-runtime";

type Tab = "inventory" | "keys";

/**
 * PnC inventory panel — two tabs:
 *   - "Inventory": a numbered list with one entry per inventory slot; empty
 *     slots read "--empty--".
 *   - "Key Items": an unordered (bulleted) list of held keys.
 *
 * Clicking a filled item slot or a key emits `inventory-activate` with `{ id }`
 * so the controller can build an action menu. This component is deliberately
 * dumb: it does NOT compute verbs; it only emits the entity id.
 */
export class PncInventory extends LitElement {
  static override properties = {
    items: { attribute: false },
    keys: { attribute: false },
    equippedNames: { attribute: false },
    slots: { type: Number },
    activeTab: { state: true },
  };
  declare items: ScopeEntity[];
  declare keys: ScopeEntity[];
  declare equippedNames: string[];
  /** Inventory capacity — how many numbered slots to render. */
  declare slots: number;
  declare activeTab: Tab;

  constructor() {
    super();
    this.items = [];
    this.keys = [];
    this.equippedNames = [];
    this.slots = 0;
    this.activeTab = "inventory";
  }

  static override styles = css`
    :host { display: block; }
    .inventory { display: flex; flex-direction: column; font-family: var(--font-body); }
    .tabs {
      display: flex;
      gap: 0.25rem;
      border-bottom: 1px solid var(--color-muted, #8a8070);
    }
    .tab {
      flex: 1;
      padding: 0.3rem 0.5rem;
      background: transparent;
      border: none;
      border-bottom: 2px solid transparent;
      color: var(--color-muted, #8a8070);
      font-family: inherit;
      font-size: 0.85em;
      cursor: pointer;
    }
    .tab[aria-selected="true"] {
      color: var(--color-text, #e8e2d0);
      border-bottom-color: var(--color-accent, #b8943c);
    }
    .tab:hover { color: var(--color-text, #e8e2d0); }
    .slot-list {
      list-style: decimal;
      margin: 0;
      padding: 0.5rem 0.5rem 0.5rem 2rem;
      display: flex;
      flex-direction: column;
      gap: 0.15rem;
    }
    .key-list {
      list-style: disc;
      margin: 0;
      padding: 0.5rem 0.5rem 0.5rem 2rem;
      display: flex;
      flex-direction: column;
      gap: 0.15rem;
    }
    .slot, .key { color: var(--color-text, #e8e2d0); }
    .slot-empty { color: var(--color-muted, #8a8070); font-style: italic; }
    .inventory-entry {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      width: 100%;
      padding: 0.15rem 0.4rem;
      border-radius: 4px;
      cursor: pointer;
      color: var(--color-text, #e8e2d0);
      background: transparent;
      border: none;
      text-align: left;
      font-family: inherit;
      font-size: 0.9em;
    }
    .inventory-entry:hover {
      background: color-mix(in srgb, var(--color-accent, #b8943c) 15%, transparent);
    }
    .inventory-entry img {
      width: 2rem;
      height: 2rem;
      object-fit: contain;
      border-radius: 2px;
    }
    .entry-name { flex: 1; }
    .equipped-tag {
      font-size: 0.75em;
      color: var(--color-accent, #b8943c);
      opacity: 0.85;
    }
    .empty-note { padding: 0.5rem; color: var(--color-muted, #8a8070); font-style: italic; }
  `;

  #emit(id: string): void {
    this.dispatchEvent(
      new CustomEvent("inventory-activate", {
        detail: { id },
        bubbles: true,
        composed: true,
      }),
    );
  }

  #select(tab: Tab): void {
    this.activeTab = tab;
  }

  #renderEntry(entity: ScopeEntity) {
    const equipped = this.equippedNames.includes(entity.name);
    return html`<button
      class="inventory-entry"
      @click=${() => this.#emit(entity.id)}
    >${entity.image
      ? html`<img src=${entity.image} alt=${entity.name} />`
      : nothing}<span class="entry-name">${entity.name}</span>${equipped
      ? html`<span class="equipped-tag">(equipped)</span>`
      : nothing}</button>`;
  }

  #renderSlots() {
    // One entry per slot; if items somehow exceed capacity, show them all.
    const count = Math.max(this.slots, this.items.length);
    const slots = Array.from({ length: count }, (_, i) => this.items[i]);
    return html`<ol class="slot-list">${slots.map(
      (entity) =>
        html`<li class="slot">${entity
          ? this.#renderEntry(entity)
          : html`<span class="slot-empty">--empty--</span>`}</li>`,
    )}</ol>`;
  }

  #renderKeys() {
    if (this.keys.length === 0) {
      return html`<p class="empty-note">No key items.</p>`;
    }
    return html`<ul class="key-list">${this.keys.map(
      (key) => html`<li class="key">${this.#renderEntry(key)}</li>`,
    )}</ul>`;
  }

  override render() {
    return html`<div class="inventory">
      <div class="tabs" role="tablist">
        <button
          class="tab"
          role="tab"
          aria-selected=${this.activeTab === "inventory"}
          @click=${() => this.#select("inventory")}
        >Inventory</button>
        <button
          class="tab"
          role="tab"
          aria-selected=${this.activeTab === "keys"}
          @click=${() => this.#select("keys")}
        >Key Items</button>
      </div>
      ${this.activeTab === "inventory" ? this.#renderSlots() : this.#renderKeys()}
    </div>`;
  }
}

customElements.define("pnc-inventory", PncInventory);

declare global {
  interface HTMLElementTagNameMap {
    "pnc-inventory": PncInventory;
  }
}
