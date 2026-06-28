import { LitElement, html, css, nothing } from "lit";

/** Point-and-click top bar — room name on the left, control cluster on the right. */
export class PncTopbar extends LitElement {
  static override properties = {
    roomName: { type: String },
    audioEnabled: { type: Boolean },
    soundpacks: { attribute: false },
    activeSoundpack: { type: String },
    themes: { attribute: false },
    activeTheme: { type: String },
  };

  declare roomName: string;
  declare audioEnabled: boolean;
  declare soundpacks: { id: string; label: string }[];
  declare activeSoundpack: string;
  declare themes: { id: string; label: string }[];
  declare activeTheme: string;

  constructor() {
    super();
    this.roomName = "";
    this.audioEnabled = false;
    this.soundpacks = [];
    this.activeSoundpack = "";
    this.themes = [];
    this.activeTheme = "";
  }

  static override styles = css`
    :host {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
      padding: 0.35rem 1rem;
      background: var(--pnc-topbar-bg, color-mix(in srgb, var(--color-bg, #1a1410) 90%, transparent));
      border-bottom: 1px solid var(--pnc-accent, #b8943c);
      font-family: var(--font-head);
      color: var(--color-text, #e8e2d0);
    }
    .topbar-left {
      flex: 1;
      min-width: 0;
    }
    .room-name {
      font-size: 0.95em;
      font-weight: 600;
      letter-spacing: 0.06em;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      color: var(--color-text, #e8e2d0);
    }
    .topbar-controls {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      flex-shrink: 0;
    }
    .topbar-btn {
      appearance: none;
      -webkit-appearance: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 2rem;
      height: 1.75rem;
      padding: 0 0.4em;
      border: 1px solid var(--pnc-accent, #b8943c);
      border-radius: 4px;
      background: transparent;
      color: var(--color-text, #e8e2d0);
      font-family: var(--font-head);
      font-size: 0.85em;
      cursor: pointer;
      transition: background 0.12s, color 0.12s;
    }
    .topbar-btn:hover {
      background: color-mix(in srgb, var(--pnc-accent, #b8943c) 20%, transparent);
      color: #fff;
    }
    .topbar-btn:active {
      background: color-mix(in srgb, var(--pnc-accent, #b8943c) 35%, transparent);
    }
    .topbar-btn:focus-visible {
      outline: 2px solid var(--pnc-accent, #b8943c);
      outline-offset: 2px;
    }
    /* Muted when audio is off */
    .topbar-btn[aria-pressed="false"] {
      color: var(--color-muted, #888);
    }
    .topbar-btn[aria-pressed="false"] .wave {
      display: none;
    }
    .topbar-btn[aria-pressed="false"] .mute-slash {
      display: block;
    }
    .topbar-btn[aria-pressed="true"] .mute-slash {
      display: none;
    }
    .topbar-btn svg {
      width: 1em;
      height: 1em;
      display: block;
    }
    .topbar-select {
      appearance: none;
      -webkit-appearance: none;
      height: 1.75rem;
      padding: 0 0.5em;
      border: 1px solid var(--pnc-accent, #b8943c);
      border-radius: 4px;
      background: transparent;
      color: var(--color-text, #e8e2d0);
      font-family: var(--font-head);
      font-size: 0.8em;
      cursor: pointer;
    }
    .topbar-select:focus-visible {
      outline: 2px solid var(--pnc-accent, #b8943c);
      outline-offset: 2px;
    }
  `;

  #onToggleAudio = (): void => {
    this.dispatchEvent(new CustomEvent("toggle-audio", { bubbles: true, composed: true }));
  };

  #onSoundpackChange = (ev: Event): void => {
    const select = ev.target as HTMLSelectElement;
    this.dispatchEvent(
      new CustomEvent("soundpack-change", {
        detail: { id: select.value },
        bubbles: true,
        composed: true,
      }),
    );
  };

  #onThemeChange = (ev: Event): void => {
    const select = ev.target as HTMLSelectElement;
    this.dispatchEvent(
      new CustomEvent("theme-change", {
        detail: { id: select.value },
        bubbles: true,
        composed: true,
      }),
    );
  };

  #onOpenMap = (): void => {
    this.dispatchEvent(new CustomEvent("open-map", { bubbles: true, composed: true }));
  };

  #onOpenMenu = (): void => {
    this.dispatchEvent(new CustomEvent("open-menu", { bubbles: true, composed: true }));
  };

  override render() {
    return html`
      <div class="topbar-left">
        <span class="room-name">${this.roomName}</span>
      </div>
      <div class="topbar-controls">
        <button
          class="topbar-btn"
          type="button"
          aria-pressed=${String(this.audioEnabled)}
          aria-label="Toggle audio"
          title=${"Audio: " + (this.audioEnabled ? "on" : "off")}
          @click=${this.#onToggleAudio}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path class="spk" d="M4 9 H8 L13 5 V19 L8 15 H4 Z" fill="currentColor"/>
            <path class="wave" d="M15.5 8 Q18.5 12 15.5 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            <path class="wave" d="M18 6 Q22.5 12 18 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            <line class="mute-slash" x1="3" y1="3" x2="21" y2="21" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>
          </svg>
        </button>
        ${this.soundpacks.length >= 2
          ? html`<select
              class="topbar-select"
              aria-label="Sound pack"
              @change=${this.#onSoundpackChange}
            >${this.soundpacks.map(
              (sp) =>
                html`<option value=${sp.id} ?selected=${sp.id === this.activeSoundpack}
                  >${sp.label}</option>`,
            )}</select>`
          : nothing}
        ${this.themes.length >= 2
          ? html`<select
              class="topbar-select"
              aria-label="Theme"
              @change=${this.#onThemeChange}
            >${this.themes.map(
              (t) =>
                html`<option value=${t.id} ?selected=${t.id === this.activeTheme}
                  >${t.label}</option>`,
            )}</select>`
          : nothing}
        <button
          class="topbar-btn topbar-btn-map"
          type="button"
          aria-label="Open map"
          title="Map"
          @click=${this.#onOpenMap}
        >&#x1F5FA;</button>
        <button
          class="topbar-btn topbar-btn-menu"
          type="button"
          aria-label="Back to menu"
          title="Menu"
          @click=${this.#onOpenMenu}
        >&#x21A9;</button>
      </div>
    `;
  }
}

customElements.define("pnc-topbar", PncTopbar);

declare global {
  interface HTMLElementTagNameMap {
    "pnc-topbar": PncTopbar;
  }
}
