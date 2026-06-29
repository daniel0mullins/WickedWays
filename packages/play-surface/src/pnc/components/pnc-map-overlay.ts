import { LitElement, html, css } from "lit";

/**
 * PnC map overlay — renders a full-screen overlay containing a passed SVGElement.
 *
 * Props:
 *   - `svg` — an `SVGElement | null` produced by `renderMapSvg(layoutMap(mapModel))`.
 *     The element is inserted imperatively (not via Lit string interpolation) so the
 *     live DOM node is preserved.
 *
 * Events:
 *   - `dismiss` — emitted on any click or any keydown.
 *
 * Window `keydown` listener is added in `connectedCallback` and removed both when it
 * fires (one-shot, capture) and in `disconnectedCallback` — mirroring the leak-free
 * pattern in `crt-game.ts`.
 */
export class PncMapOverlay extends LitElement {
  static override properties = {
    svg: { attribute: false },
  };
  declare svg: SVGElement | null;

  constructor() {
    super();
    this.svg = null;
  }

  static override styles = css`
    :host { display: block; }
    .map-overlay {
      position: fixed; inset: 0; z-index: 200;
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      gap: 0.6em; padding: 1rem;
      background: rgba(10, 10, 8, 0.92);
      cursor: pointer;
    }
    .overlay-frame {
      max-width: 100%; max-height: 80%; overflow: auto;
      padding: 0.8em; border-radius: 6px;
      border: 2px solid var(--pnc-accent, var(--color-accent, #b8943c));
      background: rgba(10, 10, 8, 0.6);
      box-shadow: 0 0 10px rgba(217, 194, 122, 0.35), inset 0 0 14px rgba(0, 0, 0, 0.5);
    }
    .svg-frame { max-width: 100%; height: auto; }
    /* The map SVG (class "map-svg") is built by the shared renderer with .map-*
       classes but carries no inline colors, so it must be styled here — without
       these rules its text/boxes fall back to the SVG default black fill and
       vanish against the dark overlay. */
    .map-svg { max-width: 100%; height: auto; }
    .map-svg .map-box { fill: var(--color-panel, #252220); stroke: var(--color-muted, #8a8070); stroke-width: 1.5; }
    .map-svg .map-box.current { stroke: var(--pnc-accent, var(--color-accent, #b8943c)); stroke-width: 2.5;
      filter: drop-shadow(0 0 6px rgba(217, 194, 122, 0.7)); }
    .map-svg .map-label { fill: var(--color-text, #e8e2d0); font: 0.5em var(--font-body); }
    .map-svg .map-link { stroke: var(--color-muted, #8a8070); stroke-width: 2; }
    .map-svg .map-link.locked { stroke: var(--color-muted, #8a8070); stroke-dasharray: 4 4; }
    .map-svg .map-stub { stroke: var(--color-muted, #8a8070); stroke-width: 2; }
    .map-svg .map-stub.locked { stroke: var(--color-muted, #8a8070); stroke-dasharray: 4 4; }
    .map-svg .map-q { fill: var(--color-muted, #8a8070); font: 0.5em var(--font-body); }
    .map-svg .map-remains { fill: var(--pnc-critical, var(--color-error, #c04040)); font: 0.5em var(--font-body); }
    .overlay-legend {
      font-family: var(--font-body);
      font-size: 0.7em;
      color: var(--color-muted, #8a8070);
      text-align: center;
    }
  `;

  // ── private state ────────────────────────────────────────────────────────────

  #svgFrame: HTMLDivElement | null = null;
  #overlayKeyCleanup: (() => void) | null = null;

  // ── lifecycle ────────────────────────────────────────────────────────────────

  override connectedCallback(): void {
    super.connectedCallback();
    this.#attachKeyListener();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.#overlayKeyCleanup?.();
    this.#overlayKeyCleanup = null;
  }

  override firstUpdated(): void {
    this.#svgFrame = this.renderRoot.querySelector<HTMLDivElement>(".svg-frame");
    this.#syncSvg();
  }

  override updated(changed: Map<PropertyKey, unknown>): void {
    if (changed.has("svg")) this.#syncSvg();
  }

  // ── private helpers ──────────────────────────────────────────────────────────

  /** Imperatively insert (or remove) the live SVGElement into the frame div. */
  #syncSvg(): void {
    if (!this.#svgFrame) return;
    while (this.#svgFrame.firstChild) {
      this.#svgFrame.removeChild(this.#svgFrame.firstChild);
    }
    if (this.svg) this.#svgFrame.appendChild(this.svg);
  }

  /**
   * Add a one-shot capture keydown listener on `window`.
   * Mirrors the pattern in `crt-game.ts #openOverlay`:
   *   - The handler removes itself when it fires.
   *   - `#overlayKeyCleanup` is a stored reference that `disconnectedCallback` can
   *     call to remove the listener if it hasn't fired yet.
   */
  #attachKeyListener(): void {
    const onKey = (_ev: KeyboardEvent): void => {
      window.removeEventListener("keydown", onKey, true);
      this.#overlayKeyCleanup = null;
      this.#emitDismiss();
    };
    this.#overlayKeyCleanup = () => window.removeEventListener("keydown", onKey, true);
    window.addEventListener("keydown", onKey, true);
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
    return html`<div class="map-overlay" @click=${() => this.#emitDismiss()}>
      <div class="overlay-frame">
        <div class="svg-frame"></div>
      </div>
      <div class="overlay-legend">
        ─ open &nbsp; ╌ locked &nbsp; ? unexplored &nbsp; ✕ remains &nbsp; ▣ here &nbsp; · &nbsp;
        click or any key to close
      </div>
    </div>`;
  }
}

customElements.define("pnc-map-overlay", PncMapOverlay);

declare global {
  interface HTMLElementTagNameMap {
    "pnc-map-overlay": PncMapOverlay;
  }
}
