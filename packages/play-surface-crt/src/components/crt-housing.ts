import { LitElement, html, css } from "lit";

export class CrtHousing extends LitElement {
  static override styles = css`
    /*
     * CRITICAL: --base-size, font, color, text-shadow live on :host so slotted
     * descendants (light-DOM children) inherit the terminal typography.
     * Only the purely-visual bits (position/inset/flex/background/border-radius)
     * remain on .screen.
     */
    :host {
      display: block;
      --base-size: 32px;
      font: var(--base-size)/1.5 var(--font-body);
      color: var(--color-text);
      text-shadow: 0 0 8px rgba(205, 210, 196, 0.18);
    }

    *, *::before, *::after { box-sizing: border-box; }

    /* (4) Backdrop — dark surround behind the monitor. */
    .backdrop {
      min-height: 100vh; width: 100%;
      display: flex; align-items: center; justify-content: center;
      padding: 2vmin;
      background: radial-gradient(ellipse at 50% 35%, #1c1b22 0%, #111016 55%, #08070a 100%);
    }

    /* (2) Monitor housing/cowling — molded plastic frame, pure CSS. */
    .monitor {
      --screen-h: min(82vh, calc((100vw - 14vmin) * 3 / 4));
      position: relative;
      padding: clamp(18px, 3vmin, 40px);
      padding-bottom: clamp(34px, 6vmin, 64px);
      border-radius: 28px;
      background:
        linear-gradient(160deg, var(--plastic-light) 0%, var(--plastic) 38%, var(--plastic-dark) 100%);
      box-shadow:
        inset 0 2px 3px rgba(255, 255, 255, 0.55),
        inset 0 -6px 14px rgba(0, 0, 0, 0.35),
        inset 8px 0 18px rgba(0, 0, 0, 0.12),
        inset -8px 0 18px rgba(0, 0, 0, 0.12),
        0 24px 60px rgba(0, 0, 0, 0.7),
        0 2px 0 rgba(255, 255, 255, 0.2);
    }

    /* Recessed well that the glass tube sits inside. */
    .monitor-screen {
      position: relative;
      height: var(--screen-h);
      aspect-ratio: 4 / 3;
      max-width: 100%;
      border-radius: 14px / 18px;
      overflow: hidden;
      background: #000;
      box-shadow:
        inset 0 0 0 3px var(--plastic-shadow),
        inset 0 0 14px 6px rgba(0, 0, 0, 0.9),
        0 0 2px rgba(0, 0, 0, 0.8);
    }

    /*
     * (1) 4:3 screen — the live terminal fills the bounded glass.
     * --base-size is the single knob; everything else is em-relative.
     * Typography is on :host (see above); only visual layout here.
     */
    .screen {
      position: absolute; inset: 0;
      display: flex; flex-direction: column;
      /* faint bulged-glass curvature */
      background:
        radial-gradient(ellipse at 50% 45%, #1b1a14 0%, var(--color-bg) 70%, #0c0b08 100%);
      border-radius: 14px / 18px;
    }

    /* (3) CRT artifacts — overlays inside the bezel, above the transcript.
       HARD REQ: pointer-events:none so chips/nouns still receive clicks. */
    .crt-overlay {
      position: absolute; inset: 0;
      pointer-events: none;
      z-index: 5;
      border-radius: 14px / 18px;
      background:
        /* scanlines */
        repeating-linear-gradient(
          to bottom,
          rgba(0, 0, 0, 0.0) 0px,
          rgba(0, 0, 0, 0.0) 2px,
          rgba(0, 0, 0, 0.22) 3px,
          rgba(0, 0, 0, 0.22) 4px
        ),
        /* edge vignette / bulged-tube darkening */
        radial-gradient(ellipse at 50% 50%, rgba(0,0,0,0) 55%, rgba(0,0,0,0.55) 100%);
      animation: crt-flicker 5s steps(60) infinite;
    }

    /* slow-moving scanline sweep */
    .crt-sweep {
      position: absolute; left: 0; right: 0; top: 0;
      height: 32%;
      pointer-events: none;
      z-index: 6;
      border-radius: 14px / 18px;
      background: linear-gradient(
        to bottom,
        rgba(217, 194, 122, 0) 0%,
        rgba(217, 194, 122, 0.045) 50%,
        rgba(217, 194, 122, 0) 100%
      );
      animation: crt-sweep 7s linear infinite;
    }

    @keyframes crt-flicker {
      0%, 100% { opacity: 1; }
      48% { opacity: 0.97; }
      50% { opacity: 0.93; }
      52% { opacity: 0.98; }
    }

    @keyframes crt-sweep {
      0% { transform: translateY(-40%); }
      100% { transform: translateY(360%); }
    }

    /* (3) HARD REQ: all motion gated off when reduced motion is preferred. */
    @media (prefers-reduced-motion: reduce) {
      .crt-overlay { animation: none; }
      .crt-sweep { animation: none; display: none; }
    }
  `;

  override render() {
    return html`
      <div class="backdrop">
        <div class="monitor">
          <div class="monitor-screen">
            <div class="screen"><slot name="screen"></slot></div>
            <div class="crt-overlay" aria-hidden="true"></div>
            <div class="crt-sweep" aria-hidden="true"></div>
          </div>
          <slot name="bezel"></slot>
        </div>
      </div>`;
  }
}

customElements.define("crt-housing", CrtHousing);

declare global {
  interface HTMLElementTagNameMap {
    "crt-housing": CrtHousing;
  }
}
