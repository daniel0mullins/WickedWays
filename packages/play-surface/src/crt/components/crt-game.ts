import { LitElement, html, css } from "lit";
import "./crt-transcript.js";
import "./crt-hud.js";
import "./crt-status.js";
import "./crt-prompt.js";
import type { CrtTranscript } from "./crt-transcript.js";
import type { CrtHud } from "./crt-hud.js";
import type { CrtStatus } from "./crt-status.js";
import type { CrtPrompt } from "./crt-prompt.js";
import type { ViewModel } from "@wickedways/play-runtime";
import type { StatusField } from "wickedways/lib/presentation";

/** Game area — composes the transcript, HUD, status bar, prompt, and the map/help overlay. */
export class CrtGame extends LitElement {
  static override styles = css`
    :host { display: flex; flex-direction: column; flex: 1; min-height: 0; position: relative; }
    :host([hidden]) { display: none; }
    crt-transcript { flex: 1; min-height: 0; }

    /* Shared overlay (map + help) */
    .overlay {
      position: absolute; inset: 0; z-index: 3;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 0.6em; padding: 1rem;
      background: rgba(10, 10, 8, 0.92);
    }
    .overlay-frame {
      max-width: 100%; max-height: 80%; overflow: auto;
      padding: 0.8em; border-radius: 6px;
      border: 2px solid var(--color-accent);
      background: rgba(10, 10, 8, 0.6);
      box-shadow: 0 0 10px rgba(217, 194, 122, 0.35), inset 0 0 14px rgba(0, 0, 0, 0.5);
    }
    .help-list { display: flex; flex-direction: column; gap: 0.35em; }
    .help-row { font-family: var(--font-body); font-size: 0.8em; color: var(--color-text); white-space: nowrap; }
    .map-svg { max-width: 100%; height: auto; }
    .map-svg .map-box { fill: var(--color-chip-bg); stroke: var(--color-muted); stroke-width: 1.5; }
    .map-svg .map-box.current { stroke: var(--color-accent); stroke-width: 2.5;
      filter: drop-shadow(0 0 6px rgba(217, 194, 122, 0.7)); }
    .map-svg .map-label { fill: var(--color-text); font: 0.5em var(--font-body); }
    .map-svg .map-link { stroke: var(--color-muted); stroke-width: 2; }
    .map-svg .map-link.locked { stroke: var(--color-muted); stroke-dasharray: 4 4; }
    .map-svg .map-stub { stroke: var(--color-border); stroke-width: 2; }
    .map-svg .map-stub.locked { stroke: var(--color-border); stroke-dasharray: 4 4; }
    .map-svg .map-q { fill: var(--color-muted); font: 0.5em var(--font-body); }
    .map-svg .map-remains { fill: var(--color-error); font: 0.5em var(--font-body); }
    .overlay-legend { font-family: var(--font-body); font-size: 0.7em; color: var(--color-muted); text-align: center; }
  `;

  #transcript: CrtTranscript | null = null;
  #hud: CrtHud | null = null;
  #status: CrtStatus | null = null;
  #prompt: CrtPrompt | null = null;
  #overlayHost: HTMLDivElement | null = null;
  #overlay: HTMLDivElement | null = null;
  #overlayKeyCleanup: (() => void) | null = null;

  override render() {
    return html`
      <crt-transcript></crt-transcript>
      <crt-hud></crt-hud>
      <crt-status></crt-status>
      <crt-prompt></crt-prompt>
      <div class="overlay-host"></div>`;
  }

  override firstUpdated() {
    this.#transcript = this.renderRoot.querySelector<CrtTranscript>("crt-transcript");
    this.#hud = this.renderRoot.querySelector<CrtHud>("crt-hud");
    this.#status = this.renderRoot.querySelector<CrtStatus>("crt-status");
    this.#prompt = this.renderRoot.querySelector<CrtPrompt>("crt-prompt");
    this.#overlayHost = this.renderRoot.querySelector<HTMLDivElement>(".overlay-host");
  }

  #onFillInput = (ev: Event): void => {
    const ce = ev as CustomEvent<{ value: string }>;
    const value = ce.detail?.value ?? "";
    this.#prompt?.setValue(value);
    this.#prompt?.focusInput();
    ev.stopPropagation();
  };

  override connectedCallback() {
    super.connectedCallback();
    this.addEventListener("fill-input", this.#onFillInput);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener("fill-input", this.#onFillInput);
    this.#overlayKeyCleanup?.();
    this.#overlayKeyCleanup = null;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  get transcript(): CrtTranscript {
    return this.#transcript!;
  }

  setHud(vm: ViewModel): void {
    if (this.#hud) this.#hud.vm = vm;
  }

  setStatus(location: string, fields: readonly StatusField[]): void {
    if (this.#status) {
      this.#status.location = location;
      this.#status.fields = fields;
    }
  }

  setClickableNouns(nouns: string[]): void {
    if (this.#hud) this.#hud.clickableNouns = nouns;
    if (this.#transcript) this.#transcript.clickableNouns = nouns;
  }

  setPromptDisabled(disabled: boolean): void {
    if (this.#prompt) this.#prompt.disabled = disabled;
  }

  focusInput(): void {
    this.#prompt?.focusInput();
  }

  clearTranscript(): void {
    this.#transcript?.clear();
  }

  openMap(svg: SVGElement): void {
    this.#openOverlay(
      (frame) => frame.appendChild(svg),
      "─ open   ╌ locked   ? unexplored   ✕ remains   ▣ here   ·   any key to close",
    );
  }

  openHelp(rows: string[]): void {
    this.#openOverlay((frame) => {
      const list = document.createElement("div");
      list.className = "help-list";
      for (const rowText of rows) {
        const row = document.createElement("div");
        row.className = "help-row";
        row.textContent = rowText;
        list.appendChild(row);
      }
      frame.appendChild(list);
    }, "any key to close");
  }

  closeOverlay(): void {
    if (!this.#overlay) return;
    this.#overlay.remove();
    this.#overlay = null;
    this.#overlayKeyCleanup?.();
    this.#overlayKeyCleanup = null;
    this.#prompt?.focusInput();
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  #openOverlay(fill: (frame: HTMLDivElement) => void, legendText: string): void {
    if (this.#overlay) return; // idempotent — only one overlay at a time

    const overlay = document.createElement("div");
    overlay.className = "overlay";

    const frame = document.createElement("div");
    frame.className = "overlay-frame";
    fill(frame);

    const legend = document.createElement("div");
    legend.className = "overlay-legend";
    legend.textContent = legendText;

    overlay.append(frame, legend);
    this.#overlayHost!.appendChild(overlay);
    this.#overlay = overlay;

    // Any key dismisses the overlay (capture so it never reaches the prompt input).
    const onKey = (ev: KeyboardEvent) => {
      ev.preventDefault();
      window.removeEventListener("keydown", onKey, true);
      this.#overlayKeyCleanup = null;
      this.closeOverlay();
    };
    this.#overlayKeyCleanup = () => window.removeEventListener("keydown", onKey, true);
    window.addEventListener("keydown", onKey, true);
  }
}

customElements.define("crt-game", CrtGame);

declare global {
  interface HTMLElementTagNameMap {
    "crt-game": CrtGame;
  }
}
