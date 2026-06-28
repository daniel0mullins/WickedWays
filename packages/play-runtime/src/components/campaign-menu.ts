import { LitElement, html, css } from "lit";

/** Campaign-picker shown before play begins; emits a `select` CustomEvent with `{ slug }` when the player chooses. */
export class CampaignMenu extends LitElement {
  static override properties = {
    campaigns: { attribute: false },
  };
  declare campaigns: { slug: string; title: string; blurb: string }[];

  constructor() {
    super();
    this.campaigns = [];
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
    .launcher-menu {
      display: flex;
      flex-direction: column;
      gap: 1rem;
      padding: 2rem;
      max-width: 36rem;
      width: 100%;
    }
    .launcher-entry {
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
    .launcher-entry:hover,
    .launcher-entry:focus-visible {
      border-color: #aaa;
      background: rgba(255, 255, 255, 0.06);
      outline: none;
    }
    .launcher-title {
      font-size: 1.1rem;
      font-weight: 600;
    }
    .launcher-blurb {
      font-size: 0.85rem;
      color: #aaa;
    }
  `;

  private _handleClick(slug: string) {
    this.dispatchEvent(
      new CustomEvent("select", { detail: { slug }, bubbles: true, composed: true }),
    );
  }

  // Arrow function keeps `this` bound; registered on the shadow root so the
  // test can dispatch keydown directly on `el.shadowRoot`.
  private readonly _handleKeydown = (ev: Event): void => {
    const e = ev as KeyboardEvent;
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const entries = Array.from(
      this.shadowRoot!.querySelectorAll<HTMLButtonElement>(".launcher-entry"),
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
      <div class="launcher-menu">
        ${this.campaigns.map(
          (c) => html`
            <button
              class="launcher-entry"
              type="button"
              @click=${() => this._handleClick(c.slug)}
            >
              <span class="launcher-title">${c.title}</span>
              <span class="launcher-blurb">${c.blurb}</span>
            </button>
          `,
        )}
      </div>
    `;
  }
}

customElements.define("campaign-menu", CampaignMenu);

declare global {
  interface HTMLElementTagNameMap {
    "campaign-menu": CampaignMenu;
  }
}
