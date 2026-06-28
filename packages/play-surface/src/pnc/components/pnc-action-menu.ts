import { LitElement, html, css } from "lit";

/**
 * PnC contextual action menu — a dumb popup that renders one button per action.
 *
 * Props: `actions` (label + index pairs), `x` / `y` (placement in px).
 * Events:
 *   - `choose` — emitted when the user clicks a button; `detail.index` is the
 *     action index so the controller can map it back to an intent.
 *   - `dismiss` — emitted on Escape keydown or a click outside the popup.
 *
 * Window-level listeners are added in `connectedCallback` and removed in
 * `disconnectedCallback` to prevent leaks (mirrors `crt-game.ts` pattern).
 */
export class PncActionMenu extends LitElement {
  static override properties = {
    actions: { attribute: false },
    x: { type: Number },
    y: { type: Number },
  };
  declare actions: { label: string; index: number }[];
  declare x: number;
  declare y: number;

  constructor() {
    super();
    this.actions = [];
    this.x = 0;
    this.y = 0;
  }

  static override styles = css`
    :host { display: block; }
    .action-menu {
      position: absolute;
      z-index: 100;
      display: flex;
      flex-direction: column;
      gap: 0.15rem;
      padding: 0.4rem;
      background: var(--color-panel, #252220);
      border: 1px solid var(--color-accent, #b8943c);
      border-radius: 4px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.5);
    }
    button {
      display: block;
      width: 100%;
      padding: 0.3rem 0.75rem;
      background: transparent;
      border: none;
      border-radius: 3px;
      color: var(--color-text, #e8e2d0);
      font-family: var(--font-body);
      font-size: 0.9em;
      text-align: left;
      cursor: pointer;
      white-space: nowrap;
    }
    button:hover {
      background: color-mix(in srgb, var(--color-accent, #b8943c) 20%, transparent);
    }
  `;

  // ── window listeners — added/removed to avoid leaks ─────────────────────────

  #onKeydown = (ev: KeyboardEvent): void => {
    if (ev.key === "Escape") {
      this.#emitDismiss();
    }
  };

  #onOutsideClick = (ev: MouseEvent): void => {
    // If the click target is inside this element's shadow, skip.
    const path = ev.composedPath();
    if (path.includes(this)) return;
    this.#emitDismiss();
  };

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("keydown", this.#onKeydown);
    window.addEventListener("click", this.#onOutsideClick);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener("keydown", this.#onKeydown);
    window.removeEventListener("click", this.#onOutsideClick);
  }

  // ── event helpers ────────────────────────────────────────────────────────────

  #emitChoose(index: number): void {
    this.dispatchEvent(
      new CustomEvent("choose", {
        detail: { index },
        bubbles: true,
        composed: true,
      }),
    );
  }

  #emitDismiss(): void {
    this.dispatchEvent(
      new CustomEvent("dismiss", {
        bubbles: true,
        composed: true,
      }),
    );
  }

  // ── render ───────────────────────────────────────────────────────────────────

  override render() {
    return html`<div
      class="action-menu"
      style="left:${this.x}px;top:${this.y}px;"
    >${this.actions.map(
      (a) => html`<button @click=${() => this.#emitChoose(a.index)}>${a.label}</button>`,
    )}</div>`;
  }
}

customElements.define("pnc-action-menu", PncActionMenu);

declare global {
  interface HTMLElementTagNameMap {
    "pnc-action-menu": PncActionMenu;
  }
}
