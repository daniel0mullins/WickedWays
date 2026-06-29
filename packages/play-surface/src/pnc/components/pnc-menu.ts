import { LitElement, html, css } from "lit";

/** Valid action identifiers for the system menu. */
export type MenuAction = "save" | "restore" | "undo" | "restart" | "fullscreen" | "exit";

const MENU_ITEMS: { label: string; action: MenuAction }[] = [
  { label: "Save", action: "save" },
  { label: "Restore", action: "restore" },
  { label: "Undo", action: "undo" },
  { label: "Restart", action: "restart" },
  { label: "Fullscreen", action: "fullscreen" },
  { label: "Back to menu", action: "exit" },
];

/**
 * PnC system/meta actions overlay — renders six action buttons plus a close control.
 *
 * Events:
 *   - `command` — emitted when an action button is clicked;
 *     `detail.action` is one of {@link MenuAction}.
 *   - `dismiss` — emitted on Escape keydown, backdrop/overlay click, or the ✕ close button.
 *
 * Window-level listeners are added in `connectedCallback` and removed in
 * `disconnectedCallback` to prevent leaks (same pattern as `pnc-action-menu.ts`).
 */
export class PncMenu extends LitElement {
  static override styles = css`
    :host { display: block; }
    .menu-overlay {
      position: fixed; inset: 0; z-index: 200;
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      background: rgba(10, 10, 8, 0.85);
    }
    .menu-frame {
      display: flex; flex-direction: column; gap: 0.4rem;
      padding: 1.5rem 2rem;
      background: var(--pnc-panel, var(--color-panel, #252220));
      border: 2px solid var(--pnc-accent, var(--color-accent, #b8943c));
      border-radius: 8px;
      min-width: 200px;
    }
    .close-btn {
      align-self: flex-end;
      background: transparent;
      border: none;
      color: var(--color-muted, #8a8070);
      cursor: pointer;
      font-size: 1.2em;
      padding: 0.2rem 0.5rem;
      line-height: 1;
    }
    .close-btn:hover { color: var(--color-text, #e8e2d0); }
    button[data-action] {
      display: block;
      width: 100%;
      padding: 0.5rem 1rem;
      background: transparent;
      border: 1px solid transparent;
      border-radius: 4px;
      color: var(--color-text, #e8e2d0);
      font-family: var(--font-body);
      font-size: 1em;
      text-align: left;
      cursor: pointer;
      white-space: nowrap;
    }
    button[data-action]:hover {
      border-color: var(--pnc-accent, var(--color-accent, #b8943c));
      background: color-mix(in srgb, var(--pnc-accent, var(--color-accent, #b8943c)) 15%, transparent);
    }
  `;

  // ── window listeners — added/removed to avoid leaks ─────────────────────────

  #onKeydown = (ev: KeyboardEvent): void => {
    if (ev.key === "Escape") this.#emitDismiss();
  };

  /**
   * Backdrop-click handler on `.menu-overlay`. The overlay is full-screen
   * (`position: fixed; inset: 0`), so any click that reaches it directly (not
   * bubbling up from `.menu-frame`) is a click on the backdrop → dismiss.
   * Comparing `e.target === e.currentTarget` ensures clicks inside the frame
   * (which bubble to the overlay) are ignored; only direct overlay hits close.
   */
  #onBackdropClick = (e: MouseEvent): void => {
    if (e.target === e.currentTarget) this.#emitDismiss();
  };

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("keydown", this.#onKeydown);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener("keydown", this.#onKeydown);
  }

  // ── event helpers ────────────────────────────────────────────────────────────

  #emitCommand(action: MenuAction): void {
    this.dispatchEvent(
      new CustomEvent("command", {
        detail: { action },
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
    return html`<div class="menu-overlay" @click=${this.#onBackdropClick}>
      <div class="menu-frame">
        <button class="close-btn" @click=${() => this.#emitDismiss()}>✕</button>
        ${MENU_ITEMS.map(
          ({ label, action }) =>
            html`<button data-action=${action} @click=${() => this.#emitCommand(action)}
              >${label}</button
            >`,
        )}
      </div>
    </div>`;
  }
}

customElements.define("pnc-menu", PncMenu);

declare global {
  interface HTMLElementTagNameMap {
    "pnc-menu": PncMenu;
  }
}
