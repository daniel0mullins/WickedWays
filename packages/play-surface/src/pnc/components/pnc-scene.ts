import { LitElement, html, css } from "lit";
import { styleMap } from "lit/directives/style-map.js";
import type { Hotspot } from "../affordances.js";
import type { Direction } from "wickedways/lib/room";

/**
 * Maps every compass bearing to its perimeter CSS position inside the scene.
 * Values are percentages within the scene container.
 */
const DIR_POSITION: Record<Direction, { left: string; top: string }> = {
  north:     { left: "50%", top: "5%"  },
  south:     { left: "50%", top: "90%" },
  east:      { left: "90%", top: "50%" },
  west:      { left: "5%",  top: "50%" },
  northeast: { left: "85%", top: "10%" },
  northwest: { left: "10%", top: "10%" },
  southeast: { left: "85%", top: "85%" },
  southwest: { left: "10%", top: "85%" },
};

/**
 * Deterministic placement for body hotspots (occupants, loot, floor items).
 * Spreads items evenly across a central horizontal band — same input always
 * produces the same position so re-renders are stable.
 */
function bodyPosition(index: number, total: number): { left: string; top: string } {
  const x = total <= 1 ? 50 : Math.round(20 + (index / (total - 1)) * 60);
  return { left: `${x}%`, top: "48%" };
}

/**
 * Point-and-click room scene — a procedural CSS box (or image background) with
 * clickable hotspots derived from the current-room affordance map.
 *
 * - **Exits / locked doors** (`dir` hotspots) appear on the perimeter by compass bearing.
 * - **Occupants / loot / items** appear in the scene body, spread deterministically.
 * - Locked doors are dim and non-interactive (`pointer-events:none` + no click emit).
 * - Clicking any other hotspot emits `"hotspot"` with `{ detail: { key } }` (bubbles + composed).
 */
export class PncScene extends LitElement {
  static override properties = {
    hotspots:  { attribute: false },
    roomImage: { type: String },
  };
  declare hotspots: Hotspot[];
  declare roomImage: string | undefined;

  constructor() {
    super();
    this.hotspots = [];
    this.roomImage = undefined;
  }

  static override styles = css`
    :host { display: block; }

    /* ── Scene canvas ─────────────────────────────────────────────────────────── */
    .scene {
      position: relative;
      width: 100%;
      height: 100%;
      overflow: hidden;
      /* Procedural two-tone room: upper ~60% = wall, lower ~40% = floor */
      background:
        linear-gradient(
          to bottom,
          var(--pnc-scene-wall, color-mix(in srgb, var(--color-panel, #252220) 80%, #000)) 0% 60%,
          var(--pnc-scene-floor, color-mix(in srgb, var(--color-bg, #1a1814) 85%, #3a2b1a)) 60% 100%
        );
      background-size: cover;
      background-position: center;
    }

    /* ── Shared hotspot shell ────────────────────────────────────────────────── */
    .hotspot {
      position: absolute;
      transform: translate(-50%, -50%);
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 0.25rem;
      cursor: pointer;
      user-select: none;
      transition: filter 0.1s;
    }
    .hotspot:hover {
      filter: brightness(1.25);
    }

    /* ── Locked door — dim, not interactive ──────────────────────────────────── */
    .hotspot.locked {
      pointer-events: none;
      opacity: 0.4;
    }

    /* ── Perimeter markers (exits / locked doors) ────────────────────────────── */
    .door-marker {
      width: 2rem;
      height: 3rem;
      border: 2px solid var(--pnc-accent, #b8943c);
      border-bottom: none;
      border-radius: 3px 3px 0 0;
      background: color-mix(in srgb, var(--pnc-accent, #b8943c) 12%, transparent);
    }
    .hotspot.locked .door-marker {
      border-color: var(--color-muted, #888);
    }

    /* ── Body markers (occupants / loot / items) ─────────────────────────────── */
    .body-marker {
      padding: 0.3rem 0.55rem;
      border: 1px solid var(--pnc-accent, #b8943c);
      border-radius: 3px;
      background: color-mix(in srgb, var(--color-panel, #252220) 85%, transparent);
    }
    .body-marker.occupant-marker { border-color: var(--color-error, #c04040); }
    .body-marker.loot-marker     { border-color: var(--color-accent, #b8943c); }
    .body-marker.item-marker     { border-color: var(--color-muted, #888); }

    /* ── Hotspot image ───────────────────────────────────────────────────────── */
    .hotspot img {
      width: 4rem;
      height: 4rem;
      object-fit: contain;
      image-rendering: pixelated;
    }

    /* ── Label ───────────────────────────────────────────────────────────────── */
    .label {
      font-family: var(--font-body);
      font-size: 0.75em;
      color: var(--color-text, #e8e2d0);
      white-space: nowrap;
      text-align: center;
    }
    .hotspot.locked .label { color: var(--color-muted, #888); }
  `;

  // ── event helper ─────────────────────────────────────────────────────────────

  #emitHotspot(key: string): void {
    this.dispatchEvent(
      new CustomEvent("hotspot", {
        detail: { key },
        bubbles: true,
        composed: true,
      }),
    );
  }

  // ── content rendering ─────────────────────────────────────────────────────────

  #renderContent(hs: Hotspot, kind: "perimeter" | "body") {
    if (hs.image) {
      return html`<img src=${hs.image} alt=${hs.label} /><span class="label">${hs.label}</span>`;
    }
    if (kind === "perimeter") {
      return html`<div class="door-marker"></div><span class="label">${hs.label}</span>`;
    }
    const markerClass = `body-marker ${hs.kind}-marker`;
    return html`<div class=${markerClass}></div><span class="label">${hs.label}</span>`;
  }

  // ── render ────────────────────────────────────────────────────────────────────

  override render() {
    const sceneStyle = this.roomImage
      ? { backgroundImage: `url(${this.roomImage})` }
      : {};

    // Perimeter hotspots: exits and locked doors (must have a dir)
    const perimeterHotspots = this.hotspots.filter(
      (hs): hs is Hotspot & { dir: Direction } =>
        (hs.kind === "exit" || hs.kind === "locked") && hs.dir !== undefined,
    );

    // Body hotspots: occupants, loot containers, floor items
    const bodyHotspots = this.hotspots.filter(
      (hs) => hs.kind === "occupant" || hs.kind === "loot" || hs.kind === "item",
    );

    return html`<div class="scene" style=${styleMap(sceneStyle)}>

      ${perimeterHotspots.map((hs) => {
        const pos = DIR_POSITION[hs.dir] ?? { left: "50%", top: "50%" };
        const isInteractive = hs.kind !== "locked";
        const clickHandler = isInteractive ? () => this.#emitHotspot(hs.key) : undefined;
        return html`<div
          class="hotspot ${hs.kind}"
          data-key=${hs.key}
          data-dir=${hs.dir}
          style=${styleMap({ left: pos.left, top: pos.top })}
          @click=${clickHandler}
        >${this.#renderContent(hs, "perimeter")}</div>`;
      })}

      ${bodyHotspots.map((hs, i) => {
        const pos = bodyPosition(i, bodyHotspots.length);
        return html`<div
          class="hotspot ${hs.kind}"
          data-key=${hs.key}
          style=${styleMap({ left: pos.left, top: pos.top })}
          @click=${() => this.#emitHotspot(hs.key)}
        >${this.#renderContent(hs, "body")}</div>`;
      })}

    </div>`;
  }
}

customElements.define("pnc-scene", PncScene);

declare global {
  interface HTMLElementTagNameMap {
    "pnc-scene": PncScene;
  }
}
