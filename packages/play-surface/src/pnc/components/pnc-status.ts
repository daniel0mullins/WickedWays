import { LitElement, html, css, nothing } from "lit";
import { classMap } from "lit/directives/class-map.js";
import type { StatusField } from "wickedways/lib/presentation";

/** Fraction pattern: digits / digits (spaces optional). */
const FRACTION_RE = /^(\d+)\s*\/\s*(\d+)$/;

function parseFraction(value: string): { num: number; den: number } | null {
  const m = FRACTION_RE.exec(value);
  if (!m) return null;
  const num = Number(m[1]);
  const den = Number(m[2]);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
  return { num, den };
}

/** PnC status bar — renders `StatusField` readouts with emphasis classes and optional fraction bars. */
export class PncStatus extends LitElement {
  static override properties = {
    fields: { attribute: false },
  };
  declare fields: readonly StatusField[];

  constructor() {
    super();
    this.fields = [];
  }

  static override styles = css`
    :host { display: block; }
    .status {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem 1.25rem;
      padding: 0.35rem 1rem;
      color: var(--color-text, #e8e2d0);
      border-top: 1px solid var(--pnc-accent, #b8943c);
      font-family: var(--font-body);
      font-size: 0.85em;
    }
    .field { display: flex; align-items: center; gap: 0.4rem; }
    .field-label { color: var(--color-muted, #888); }
    .field-value { font-weight: 500; }
    .pnc-warn .field-value { color: var(--color-warn, #d4a843); }
    .pnc-critical .field-value { color: var(--color-error, #c04040); }
    .bar {
      display: inline-block;
      width: 4rem;
      height: 0.5rem;
      background: color-mix(in srgb, currentColor 20%, transparent);
      border-radius: 2px;
      overflow: hidden;
    }
    .bar-fill {
      height: 100%;
      background: currentColor;
      border-radius: 2px;
    }
  `;

  override render() {
    return html`<div class="status">${this.fields.map((f) => this._renderField(f))}</div>`;
  }

  private _renderField(f: StatusField) {
    const classes = classMap({
      field: true,
      "pnc-critical": f.emphasis === "critical",
      "pnc-warn": f.emphasis === "warn",
    });

    const fraction = parseFraction(f.value);
    const bar = fraction
      ? html`<span class="bar"><span class="bar-fill" style="width:${Math.min(100, Math.round((fraction.num / fraction.den) * 10000) / 100)}%"></span></span>`
      : nothing;

    return html`<span class=${classes}><span class="field-label">${f.label}</span> <span class="field-value">${f.value}</span>${bar}</span>`;
  }
}

customElements.define("pnc-status", PncStatus);

declare global {
  interface HTMLElementTagNameMap {
    "pnc-status": PncStatus;
  }
}
