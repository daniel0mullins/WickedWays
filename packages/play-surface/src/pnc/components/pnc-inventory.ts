import { LitElement, html, css, nothing } from "lit";
import type { ScopeEntity } from "@wickedways/play-runtime";

/**
 * PnC inventory panel — renders item and key entities.
 *
 * Clicking an entry emits `inventory-activate` with `{ id }` so the controller
 * can build an action menu. This component is deliberately dumb: it does NOT
 * compute verbs; it only emits the entity id.
 */
export class PncInventory extends LitElement {
  static override properties = {
    items: { attribute: false },
    keys: { attribute: false },
    equippedNames: { attribute: false },
  };
  declare items: ScopeEntity[];
  declare keys: ScopeEntity[];
  declare equippedNames: string[];

  constructor() {
    super();
    this.items = [];
    this.keys = [];
    this.equippedNames = [];
  }

  static override styles = css`
    :host { display: block; }
    .inventory {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
      padding: 0.5rem;
      font-family: var(--font-body);
    }
    .inventory-entry {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.3rem 0.5rem;
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

  override render() {
    return html`<div class="inventory">${[...this.items, ...this.keys].map((e) => this.#renderEntry(e))}</div>`;
  }
}

customElements.define("pnc-inventory", PncInventory);

declare global {
  interface HTMLElementTagNameMap {
    "pnc-inventory": PncInventory;
  }
}
