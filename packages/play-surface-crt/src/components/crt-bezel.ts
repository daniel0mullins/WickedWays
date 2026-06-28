import { LitElement, html, css, nothing } from "lit";

export class CrtBezel extends LitElement {
  static override properties = {
    audioEnabled: { type: Boolean },
    soundpacks: { attribute: false },
    activeSoundpack: { type: String },
    themes: { attribute: false },
    activeTheme: { type: String },
  };

  declare audioEnabled: boolean;
  declare soundpacks: { id: string; label: string }[];
  declare activeSoundpack: string;
  declare themes: { id: string; label: string }[];
  declare activeTheme: string;

  constructor() {
    super();
    this.audioEnabled = false;
    this.soundpacks = [];
    this.activeSoundpack = "";
    this.themes = [];
    this.activeTheme = "";
  }

  static override styles = css`
    :host {
      position: absolute; left: 0; right: 0; bottom: 0;
      height: clamp(28px, 5vmin, 52px);
      display: flex; align-items: center; gap: 14px;
      padding: 0 clamp(22px, 4vmin, 48px);
    }
    .monitor-brand {
      font-family: var(--font-head);
      font-size: clamp(7px, 1.1vmin, 11px);
      letter-spacing: 0.18em;
      color: var(--plastic-shadow);
      text-shadow: 0 1px 0 rgba(255, 255, 255, 0.4);
    }
    .monitor-vents {
      flex: 1; height: 60%;
      background: repeating-linear-gradient(
        to right,
        rgba(0, 0, 0, 0.18) 0px,
        rgba(0, 0, 0, 0.18) 2px,
        rgba(255, 255, 255, 0.12) 3px,
        rgba(255, 255, 255, 0.12) 6px
      );
      border-radius: 3px;
      box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.3);
    }
    .monitor-led {
      width: 9px; height: 9px; border-radius: 50%;
      background: radial-gradient(circle at 35% 30%, #ffd98a, var(--led-color) 60%, #b46b00 100%);
      box-shadow: 0 0 6px 1px var(--led-color), inset 0 0 2px rgba(0,0,0,0.4);
    }
    .monitor-btn {
      appearance: none; -webkit-appearance: none;
      width: clamp(20px, 3.2vmin, 30px); height: clamp(20px, 3.2vmin, 30px);
      padding: 0; display: grid; place-items: center;
      border: 1px solid var(--plastic-shadow); border-radius: 5px;
      background: linear-gradient(#3a3026, #241c14);
      color: var(--color-text); cursor: pointer;
      box-shadow: inset 0 1px 1px rgba(255,255,255,0.12), 0 1px 2px rgba(0,0,0,0.45);
    }
    .monitor-btn svg { width: 68%; height: 68%; display: block; }
    .monitor-btn:hover { color: #fff; }
    .monitor-btn:active { box-shadow: inset 0 1px 3px rgba(0,0,0,0.55); }
    .monitor-btn:focus-visible { outline: 2px solid var(--led-color); outline-offset: 2px; }
    .monitor-btn-text { font-family: var(--font-head); font-size: clamp(10px, 1.8vmin, 14px); padding: 0 0.4em; }
    .monitor-select {
      appearance: none; -webkit-appearance: none;
      height: clamp(20px, 3.2vmin, 30px);
      padding: 0 0.4em;
      border: 1px solid var(--plastic-shadow); border-radius: 5px;
      background: linear-gradient(#3a3026, #241c14);
      color: var(--color-text);
      font: clamp(7px, 1.1vmin, 11px) var(--font-head);
      letter-spacing: 0.08em;
      cursor: pointer;
      box-shadow: inset 0 1px 1px rgba(255,255,255,0.12), 0 1px 2px rgba(0,0,0,0.45);
    }
    .monitor-select:focus-visible { outline: 2px solid var(--led-color); outline-offset: 2px; }
    /* Audio on: sound waves shown, no mute slash. */
    .monitor-btn[aria-pressed="true"] .mute-slash { display: none; }
    /* Audio off: hide waves, show slash, dim the icon. */
    .monitor-btn[aria-pressed="false"] { color: var(--color-muted); }
    .monitor-btn[aria-pressed="false"] .wave { display: none; }
    .monitor-btn[aria-pressed="false"] .mute-slash { display: block; }
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

  #onExit = (): void => {
    this.dispatchEvent(new CustomEvent("exit", { bubbles: true, composed: true }));
  };

  override render() {
    return html`
      <span class="monitor-brand">WICKEDWAYS</span>
      <span class="monitor-vents" aria-hidden="true"></span>
      <button
        class="monitor-btn"
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
            class="monitor-select"
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
            class="monitor-select"
            aria-label="Theme"
            @change=${this.#onThemeChange}
          >${this.themes.map(
            (t) =>
              html`<option value=${t.id} ?selected=${t.id === this.activeTheme}
                >${t.label}</option>`,
          )}</select>`
        : nothing}
      <button
        class="monitor-btn monitor-btn-text"
        type="button"
        title="Back to menu"
        aria-label="Back to menu"
        @click=${this.#onExit}
      >&#x2190;</button>
      <span class="monitor-led" aria-hidden="true"></span>
    `;
  }
}

customElements.define("crt-bezel", CrtBezel);

declare global {
  interface HTMLElementTagNameMap {
    "crt-bezel": CrtBezel;
  }
}
