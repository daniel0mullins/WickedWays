import { LitElement, html, css } from "lit";

/** Scrolling, append-only game log for point-and-click surface. No typewriter, no clickable nouns. */
export class PncLog extends LitElement {
  #log: HTMLDivElement | null = null;

  static override styles = css`
    :host { display: flex; flex-direction: column; flex: 1; min-height: 0; }
    .log { flex: 1; overflow-y: auto; padding: 0.75rem 1rem; }
    .line { white-space: pre-wrap; line-height: 1.45; }
    .line.echo { color: var(--color-muted, #888); }
    .line.error { color: var(--color-error, #c04040); }
    .line.end { color: var(--color-accent, #b8943c); }
  `;

  override render() {
    return html`<div id="pnc-log" class="log" aria-live="polite"></div>`;
  }

  override firstUpdated() {
    this.#log = this.renderRoot.querySelector<HTMLDivElement>("#pnc-log");
  }

  /** Append one line element per entry; auto-scrolls to bottom. */
  print(lines: string[], cls = ""): void {
    const log = this.#log;
    if (!log) return;
    for (const text of lines) {
      const el = document.createElement("div");
      el.className = cls ? `line ${cls}` : "line";
      el.textContent = text;
      log.appendChild(el);
    }
    log.scrollTop = log.scrollHeight;
  }

  /** Empty the log. */
  clear(): void {
    if (this.#log) this.#log.replaceChildren();
  }
}

customElements.define("pnc-log", PncLog);

declare global {
  interface HTMLElementTagNameMap {
    "pnc-log": PncLog;
  }
}
