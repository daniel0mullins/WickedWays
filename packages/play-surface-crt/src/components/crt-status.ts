import { LitElement, html, css } from "lit";
import { classMap } from "lit/directives/class-map.js";
import type { StatusField } from "wickedways/lib/presentation";

export class CrtStatus extends LitElement {
  static override properties = {
    location: { type: String },
    fields: { attribute: false }, // arrays/objects: attribute:false (set as property, not attribute)
  };
  declare location: string;
  declare fields: readonly StatusField[];

  constructor() {
    super();
    this.location = "";
    this.fields = [];
  }

  static override styles = css`
    :host { display: block; }
    .status {
      padding: .3rem 1rem;
      color: var(--color-muted);
      border-top: 1px solid var(--color-border);
      position: relative;
      z-index: 1;
    }
    .status-critical { color: var(--color-error); }
    .status-warn { color: var(--color-warn); }
  `;

  override render() {
    return html`<div class="status">${this.location}${this.fields.map((f) => {
      const classes = {
        "status-critical": f.emphasis === "critical",
        "status-warn": f.emphasis === "warn",
      };
      return html`  ·  <span class=${classMap(classes)}>${f.label} ${f.value}</span>`;
    })}</div>`;
  }
}

customElements.define("crt-status", CrtStatus);

declare global {
  interface HTMLElementTagNameMap {
    "crt-status": CrtStatus;
  }
}
