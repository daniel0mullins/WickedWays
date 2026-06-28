import { LitElement, html, css } from "lit";

export class CrtWelcome extends LitElement {
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
    /* Welcome screen — fills the host, centered column layout. */
    .welcome {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: clamp(1rem, 4%, 2.5rem);
      gap: 1.4em;
      text-align: center;
    }
    .welcome-title {
      font-family: var(--font-head);
      font-size: clamp(1.6em, 5vmin, 2.6em);
      letter-spacing: 0.08em;
      color: var(--color-accent);
      text-shadow: 0 0 18px rgba(217, 194, 122, 0.45), 0 0 4px rgba(217, 194, 122, 0.2);
      margin: 0;
      line-height: 1.2;
    }
    .welcome-intro {
      font-family: var(--font-body);
      font-size: clamp(0.85em, 2.2vmin, 1.1em);
      color: var(--color-text);
      line-height: 1.55;
      max-width: 36em;
      margin: 0;
    }
    .enter-btn {
      font-family: var(--font-head);
      font-size: clamp(1em, 3vmin, 1.5em);
      letter-spacing: 0.1em;
      padding: 0.55em 1.6em;
      background: transparent;
      color: var(--color-accent);
      border: 2px solid var(--color-accent);
      border-radius: 4px;
      cursor: pointer;
      /* Phosphor bloom — layered halo + text glow, breathing slowly. */
      text-shadow: 0 0 8px rgba(217, 194, 122, 0.55), 0 0 18px rgba(217, 194, 122, 0.32);
      box-shadow:
        0 0 6px rgba(217, 194, 122, 0.45),
        0 0 16px rgba(217, 194, 122, 0.30),
        0 0 34px rgba(217, 194, 122, 0.18),
        inset 0 0 10px rgba(217, 194, 122, 0.10);
      transition: background 0.15s, color 0.15s, box-shadow 0.25s, text-shadow 0.25s;
      animation: enter-bloom 2.6s ease-in-out infinite;
      margin-top: 0.4em;
    }
    .enter-btn:hover {
      background: rgba(217, 194, 122, 0.12);
      box-shadow:
        0 0 12px rgba(217, 194, 122, 0.8),
        0 0 30px rgba(217, 194, 122, 0.55),
        0 0 70px rgba(217, 194, 122, 0.40),
        inset 0 0 18px rgba(217, 194, 122, 0.20);
    }
    .enter-btn:focus-visible {
      outline: 2px solid var(--led-color);
      outline-offset: 3px;
    }
    .enter-btn:active {
      background: rgba(217, 194, 122, 0.22);
    }
    /* The bloom swells and recedes — a slow phosphor breath. */
    @keyframes enter-bloom {
      0%, 100% {
        box-shadow:
          0 0 6px rgba(217, 194, 122, 0.42),
          0 0 16px rgba(217, 194, 122, 0.28),
          0 0 34px rgba(217, 194, 122, 0.16),
          inset 0 0 10px rgba(217, 194, 122, 0.10);
        text-shadow: 0 0 8px rgba(217, 194, 122, 0.5), 0 0 16px rgba(217, 194, 122, 0.30);
      }
      50% {
        box-shadow:
          0 0 11px rgba(217, 194, 122, 0.72),
          0 0 26px rgba(217, 194, 122, 0.50),
          0 0 60px rgba(217, 194, 122, 0.34),
          inset 0 0 16px rgba(217, 194, 122, 0.18);
        text-shadow: 0 0 12px rgba(217, 194, 122, 0.78), 0 0 26px rgba(217, 194, 122, 0.46);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .enter-btn { animation: none; } /* keep the static bloom, drop the pulse */
    }
  `;

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

customElements.define("crt-welcome", CrtWelcome);

declare global {
  interface HTMLElementTagNameMap {
    "crt-welcome": CrtWelcome;
  }
}
