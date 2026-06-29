import { LitElement, html, css } from "lit";

/** Surface-picker shown when a campaign offers ≥2 surfaces; emits a `select` CustomEvent with `{ id }` when the player chooses, and a `back` CustomEvent when the player returns to the campaign list. */
export class SurfacePicker extends LitElement {
  static override properties = {
    surfaces: { attribute: false },
  };
  declare surfaces: { id: string; label: string; description?: string }[];

  constructor() {
    super();
    this.surfaces = [];
  }

  static override styles = css`
    :host {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      font-family: sans-serif;
      background: #111;
      color: #eee;
    }
    .surface-menu {
      display: flex;
      flex-direction: column;
      gap: 1rem;
      padding: 2rem;
      max-width: 36rem;
      width: 100%;
    }
    .surface-back {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      background: transparent;
      color: #aaa;
      border: none;
      cursor: pointer;
      font-size: 0.85rem;
      padding: 0;
      margin-bottom: 0.5rem;
      text-align: left;
    }
    .surface-back:hover,
    .surface-back:focus-visible {
      color: #eee;
      outline: none;
    }
    .surface-entry {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
      padding: 0.9rem 1.2rem;
      background: transparent;
      color: inherit;
      border: 1px solid #444;
      border-radius: 4px;
      cursor: pointer;
      text-align: left;
      transition: border-color 0.15s, background 0.15s;
    }
    .surface-entry:hover,
    .surface-entry:focus-visible {
      border-color: #aaa;
      background: rgba(255, 255, 255, 0.06);
      outline: none;
    }
    .surface-label {
      font-size: 1.1rem;
      font-weight: 600;
    }
    .surface-desc {
      font-size: 0.85rem;
      color: #aaa;
    }
  `;

  private _handleClick(id: string) {
    this.dispatchEvent(
      new CustomEvent("select", { detail: { id }, bubbles: true, composed: true }),
    );
  }

  private _handleBack() {
    this.dispatchEvent(new CustomEvent("back", { bubbles: true, composed: true }));
  }

  // Arrow function keeps `this` bound; registered on the shadow root so the
  // test can dispatch keydown directly on `el.shadowRoot`.
  private readonly _handleKeydown = (ev: Event): void => {
    const e = ev as KeyboardEvent;
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const entries = Array.from(
      this.shadowRoot!.querySelectorAll<HTMLButtonElement>(".surface-entry"),
    );
    const active = this.shadowRoot!.activeElement;
    const idx = entries.indexOf(active as HTMLButtonElement);
    if (idx === -1) return;
    const next = e.key === "ArrowDown" ? idx + 1 : idx - 1;
    if (next >= 0 && next < entries.length) {
      e.preventDefault();
      entries[next]!.focus();
    }
  };

  override connectedCallback() {
    super.connectedCallback();
    this.shadowRoot!.addEventListener("keydown", this._handleKeydown);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.shadowRoot!.removeEventListener("keydown", this._handleKeydown);
  }

  override render() {
    return html`
      <div class="surface-menu">
        <button class="surface-back" type="button" @click=${() => this._handleBack()}>
          ← Campaigns
        </button>
        ${this.surfaces.map(
          (s) => html`
            <button
              class="surface-entry"
              type="button"
              @click=${() => this._handleClick(s.id)}
            >
              <span class="surface-label">${s.label}</span>
              <span class="surface-desc">${s.description ?? s.label}</span>
            </button>
          `,
        )}
      </div>
    `;
  }
}

customElements.define("surface-picker", SurfacePicker);

declare global {
  interface HTMLElementTagNameMap {
    "surface-picker": SurfacePicker;
  }
}
