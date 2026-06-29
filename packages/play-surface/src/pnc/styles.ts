/** The document-level PnC design tokens. Injected once; inherits into every shadow root. */
export const pncGlobalTokensCss = `
:root {
  /* PnC theme defaults — overridden per-element by applyPncTheme */
  --pnc-bg: #1a1814;
  --pnc-panel: #252220;
  --pnc-ink: #e8e2d0;
  --pnc-accent: #b8943c;
  --pnc-warn: #d4a843;
  --pnc-critical: #c04040;
  --pnc-hotspot: #4a8ec8;
  --pnc-font-body: Georgia, 'Times New Roman', serif;
  --pnc-font-display: 'Palatino Linotype', Palatino, Georgia, serif;
  --pnc-vignette: 0.2;
  --pnc-grain: 0.0;
  /* Derived aliases used throughout the rest of the CSS */
  --font-body: var(--pnc-font-body);
  --font-head: var(--pnc-font-display);
  --color-bg: var(--pnc-bg);
  --color-text: var(--pnc-ink);
  --color-accent: var(--pnc-accent);
  --color-warn: var(--pnc-warn);
  --color-error: var(--pnc-critical);
  --color-panel: var(--pnc-panel);
  --color-hotspot: var(--pnc-hotspot);
}
*, *::before, *::after { box-sizing: border-box; }
/* Center the 16:9 surface in the viewport; the page background shows through as
   letterbox bars on whichever axis the window is longer than 16:9. */
body {
  margin: 0;
  background: #0a0a08;
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
}

/* ── PnC app layout ────────────────────────────────────────────────────────────
   These selectors style the light-DOM wrappers created by the controller.
   The controller sets position:relative on .pnc-app for overlay containment;
   we add the flex geometry here so the scene has a real, non-zero height.

   The surface is locked to a 16:9 box sized to fit inside the viewport: it fills
   whichever axis is the binding constraint and letterboxes the other, so a very
   tall (or very wide) window never stretches the layout.
   ─────────────────────────────────────────────────────────────────────────── */
.pnc-app {
  aspect-ratio: 16 / 9;
  width: min(100vw, calc(100vh * 16 / 9));
  height: min(100vh, calc(100vw * 9 / 16));
  display: flex;
  flex-direction: column;
}
.pnc-stage {
  flex: 1;
  display: flex;
  min-height: 0;
}
/* pnc-scene is the flex child that fills the remaining horizontal space. */
pnc-scene {
  flex: 1;
  min-height: 0;
}
.pnc-sidebar {
  width: clamp(220px, 28%, 360px);
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: auto;
}
`;

/** Inject pncGlobalTokensCss once into doc.head, guarded by a <style id="pnc-global-tokens">. Idempotent. */
export function ensurePncTokens(doc?: Document): void {
  const targetDoc = doc ?? globalThis.document;

  const existing = targetDoc.head.querySelector("#pnc-global-tokens");
  if (existing) {
    return;
  }

  const style = targetDoc.createElement("style");
  style.id = "pnc-global-tokens";
  style.textContent = pncGlobalTokensCss;
  targetDoc.head.appendChild(style);
}
