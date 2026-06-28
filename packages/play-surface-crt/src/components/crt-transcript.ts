import { LitElement, html, css } from "lit";
import { linkNouns } from "../link-nouns.js";
import type { RoomParts } from "../narrator.js";

export type { RoomParts };

export class CrtTranscript extends LitElement {
  static override properties = {
    clickableNouns: { attribute: false },
  };
  declare clickableNouns: string[];

  #scroll: HTMLDivElement | null = null;
  #activeTypewriter: (() => void) | null = null;
  #activeTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    super();
    this.clickableNouns = [];
  }

  static override styles = css`
    :host { display: flex; flex-direction: column; flex: 1; min-height: 0; }
    .transcript { flex: 1; overflow-y: auto; padding: 1rem; position: relative; z-index: 1; }
    .block { margin-bottom: 0.35rem; }
    .line { white-space: pre-wrap; line-height: 1.2; }
    .line.echo { color: var(--color-muted); }
    .line.error { color: var(--color-error); }
    .line.end { color: var(--color-accent); }
    .room-name {
      font-family: var(--font-head);
      font-weight: bold;
      font-size: 1.15em;
      letter-spacing: 0.05em;
      color: var(--color-accent);
      text-shadow: 0 0 12px rgba(217, 194, 122, 0.35);
      margin-bottom: 0.15em;
    }
    .noun {
      cursor: pointer; text-decoration: underline dotted;
      text-underline-offset: 2px; color: var(--color-text);
    }
  `;

  override render() {
    return html`<div id="transcript" class="transcript" aria-live="polite"></div>`;
  }

  override firstUpdated() {
    this.#scroll = this.renderRoot.querySelector<HTMLDivElement>("#transcript");
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    if (this.#activeTimer !== null) {
      clearInterval(this.#activeTimer);
      this.#activeTimer = null;
    }
    this.#activeTypewriter = null;
  }

  #appendBlock(): HTMLDivElement {
    const block = document.createElement("div");
    block.className = "block";
    this.#scroll!.appendChild(block);
    return block;
  }

  #appendLine(block: HTMLElement, line: string, cls = ""): void {
    const el = document.createElement("div");
    el.className = `line ${cls}`.trim();
    this.#renderClickable(el, line);
    block.appendChild(el);
  }

  #renderClickable(el: HTMLElement, line: string): void {
    const segments = linkNouns(line, this.clickableNouns);
    for (const seg of segments) {
      if (seg.noun !== undefined) {
        const span = document.createElement("span");
        span.className = "noun";
        span.textContent = seg.text;
        const noun = seg.noun;
        span.addEventListener("click", () => {
          this.dispatchEvent(
            new CustomEvent("fill-input", {
              detail: { value: `examine ${noun}` },
              bubbles: true,
              composed: true,
            }),
          );
        });
        el.appendChild(span);
      } else {
        el.appendChild(document.createTextNode(seg.text));
      }
    }
  }

  print(lines: string[], cls = ""): void {
    const scroll = this.#scroll;
    if (!scroll) return;
    const block = this.#appendBlock();
    for (const line of lines) {
      this.#appendLine(block, line, cls);
    }
    scroll.scrollTop = scroll.scrollHeight;
  }

  printRoom(parts: RoomParts): void {
    this.flush();
    const scroll = this.#scroll;
    if (!scroll) return;
    const block = this.#appendBlock();

    // Header — instant, no noun linking
    const headerEl = document.createElement("div");
    headerEl.className = "line room-name";
    headerEl.textContent = parts.header;
    block.appendChild(headerEl);

    // Description — typewriter or instant
    if (parts.description !== null) {
      const descEl = document.createElement("div");
      descEl.className = "line";
      block.appendChild(descEl);

      if (prefersReducedMotion() || parts.description.length === 0) {
        descEl.textContent = parts.description;
      } else {
        const text = parts.description;
        let idx = 0;
        // Type at full speed on first sight; twice as fast on a room you've seen.
        const CHAR_INTERVAL_MS = parts.firstVisit ? 22 : 11;
        const complete = () => {
          descEl.textContent = text;
          scroll.scrollTop = scroll.scrollHeight;
        };
        const timer = setInterval(() => {
          idx++;
          descEl.textContent = text.slice(0, idx);
          scroll.scrollTop = scroll.scrollHeight;
          if (idx >= text.length) {
            clearInterval(timer);
            this.#activeTimer = null;
            this.#activeTypewriter = null;
          }
        }, CHAR_INTERVAL_MS);
        this.#activeTimer = timer;
        this.#activeTypewriter = () => {
          clearInterval(timer);
          this.#activeTimer = null;
          complete();
        };
      }
    }

    // Body lines — instant, noun-linked
    for (const line of parts.body) {
      this.#appendLine(block, line);
    }

    scroll.scrollTop = scroll.scrollHeight;
  }

  /** Complete any in-progress typewriter immediately. */
  flush(): void {
    if (this.#activeTypewriter) {
      const complete = this.#activeTypewriter;
      this.#activeTypewriter = null;
      complete();
    }
  }

  /** Empty the transcript. */
  clear(): void {
    if (this.#activeTimer !== null) {
      clearInterval(this.#activeTimer);
      this.#activeTimer = null;
    }
    this.#activeTypewriter = null;
    if (this.#scroll) this.#scroll.replaceChildren();
  }
}

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

customElements.define("crt-transcript", CrtTranscript);

declare global {
  interface HTMLElementTagNameMap {
    "crt-transcript": CrtTranscript;
  }
}
