import { LitElement, html, css } from "lit";

export class CrtPrompt extends LitElement {
  static override properties = {
    disabled: { type: Boolean },
  };
  declare disabled: boolean;

  #input: HTMLInputElement | null = null;
  #history: string[] = [];
  #historyIdx = 0;

  constructor() {
    super();
    this.disabled = false;
  }

  static override styles = css`
    :host { display: block; }
    .prompt { display: flex; gap: .5rem; align-items: center; padding: .5rem 1rem 1rem; position: relative; z-index: 1; }
    .caret { color: var(--color-accent); }
    #cmd { flex: 1; background: transparent; border: none; color: var(--color-input); font: inherit; outline: none; }
  `;

  override render() {
    return html`
      <form id="prompt-form" class="prompt" @submit=${this.#onSubmit}>
        <span class="caret">&gt;</span>
        <input id="cmd" type="text" autocomplete="off" .disabled=${this.disabled} @keydown=${this.#onKeydown} />
      </form>
    `;
  }

  override firstUpdated() {
    this.#input = this.renderRoot.querySelector<HTMLInputElement>("#cmd");
  }

  #onSubmit = (ev: Event): void => {
    ev.preventDefault();
    const input = this.#input;
    if (!input) return;
    const line = input.value.trim();
    if (!line) return;
    input.value = "";
    this.#history.push(line);
    this.#historyIdx = this.#history.length;
    this.dispatchEvent(
      new CustomEvent("command", { detail: { line }, bubbles: true, composed: true }),
    );
  };

  #onKeydown = (ev: KeyboardEvent): void => {
    const input = this.#input;
    if (!input) return;
    if (ev.key === "ArrowUp" && this.#historyIdx > 0) {
      this.#historyIdx--;
      input.value = this.#history[this.#historyIdx] ?? "";
    } else if (ev.key === "ArrowDown" && this.#historyIdx < this.#history.length) {
      this.#historyIdx++;
      input.value = this.#history[this.#historyIdx] ?? "";
    }
  };

  setValue(v: string): void {
    if (this.#input) this.#input.value = v;
  }

  getValue(): string {
    return this.#input?.value ?? "";
  }

  clear(): void {
    if (this.#input) this.#input.value = "";
  }

  focusInput(): void {
    this.#input?.focus();
  }
}

customElements.define("crt-prompt", CrtPrompt);

declare global {
  interface HTMLElementTagNameMap {
    "crt-prompt": CrtPrompt;
  }
}
