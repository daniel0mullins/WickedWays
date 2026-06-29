import { LitElement, html, css } from "lit";

/** PnC welcome screen shown before the game starts; emits `enter` when the start button is pressed. */
export class PncWelcome extends LitElement {
  static override properties = {
    title: { type: String },
    intro: { type: String },
    buttonText: { type: String },
  };
  declare title: string;
  declare intro: string;
  declare buttonText: string | undefined;

  constructor() {
    super();
    this.title = "";
    this.intro = "";
    this.buttonText = undefined;
  }

  static override styles = css`
    :host {
      position: absolute;
      inset: 0;
      z-index: 2;
    }
    :host([hidden]) { display: none; }
    .welcome {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: clamp(1rem, 4%, 2.5rem);
      gap: 1.6em;
      text-align: center;
      background: var(--color-bg, #1a1814);
    }
    .welcome-title {
      font-family: var(--font-head);
      font-size: clamp(1.8em, 5vmin, 3em);
      letter-spacing: 0.06em;
      color: var(--color-accent, #b8943c);
      margin: 0;
      line-height: 1.2;
    }
    .welcome-intro {
      font-family: var(--font-body);
      font-size: clamp(0.9em, 2.2vmin, 1.15em);
      color: var(--color-text, #e8e2d0);
      line-height: 1.6;
      max-width: 38em;
      margin: 0;
    }
    .enter-btn {
      font-family: var(--font-head);
      font-size: clamp(1em, 2.8vmin, 1.4em);
      letter-spacing: 0.08em;
      padding: 0.5em 1.8em;
      background: transparent;
      color: var(--color-accent, #b8943c);
      border: 1px solid var(--color-accent, #b8943c);
      border-radius: 2px;
      cursor: pointer;
      transition: background 0.2s, color 0.2s;
      margin-top: 0.4em;
    }
    .enter-btn:hover {
      background: color-mix(in srgb, var(--color-accent, #b8943c) 15%, transparent);
    }
    .enter-btn:focus-visible {
      outline: 2px solid var(--color-accent, #b8943c);
      outline-offset: 3px;
    }
    .enter-btn:active {
      background: color-mix(in srgb, var(--color-accent, #b8943c) 25%, transparent);
    }
  `;

  override firstUpdated() {
    this.renderRoot.querySelector<HTMLButtonElement>(".enter-btn")?.focus();
  }

  private _handleEnter() {
    this.dispatchEvent(new CustomEvent("enter", { bubbles: true, composed: true }));
  }

  override render() {
    return html`
      <div class="welcome" aria-label="Welcome screen">
        <h1 class="welcome-title">${this.title}</h1>
        <p class="welcome-intro">${this.intro}</p>
        <button
          id="enter-game"
          class="enter-btn"
          type="button"
          @click=${this._handleEnter}
        >${this.buttonText ?? `Enter ${this.title}`}</button>
      </div>
    `;
  }
}

customElements.define("pnc-welcome", PncWelcome);

declare global {
  interface HTMLElementTagNameMap {
    "pnc-welcome": PncWelcome;
  }
}
