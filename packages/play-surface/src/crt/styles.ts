/** The document-level CRT design tokens + reset. Injected once; inherits into every shadow root. */
export const globalTokensCss = `
:root {
  /* CRT theme defaults — overridden per-element by applyTheme */
  --crt-bg: #0b0e0a;
  --crt-fg: #9be89b;
  --crt-accent: #d7ffd7;
  --crt-warn: #e8d36b;
  --crt-critical: #e86b6b;
  --crt-font-body: 'VT323', monospace;
  --crt-font-display: 'Silkscreen', monospace;
  --crt-scanline: 0.25;
  --crt-glow: 0.6;
  --crt-flicker: 0.0;
  /* Derived aliases used throughout the rest of the CSS */
  --font-body: var(--crt-font-body);
  --font-head: var(--crt-font-display);
  --color-bg: var(--crt-bg);
  --color-text: var(--crt-fg);
  --color-accent: var(--crt-accent);
  --color-warn: var(--crt-warn);
  --color-error: var(--crt-critical);
  --color-muted: #8a8f80;
  --color-border: #2a281f;
  --color-chip-bg: #25241d;
  --color-chip-border: #3a382e;
  --color-input: #e7e9df;
  /* Monitor housing — swap --plastic to e.g. #3a3a3e for a charcoal monitor. */
  --plastic: #cdbb97;
  --plastic-dark: #9c8a68;
  --plastic-light: #e4d6b6;
  --plastic-shadow: #6f6147;
  --led-color: #ffb347;
}
*, *::before, *::after { box-sizing: border-box; }
body { margin: 0; background: #0a0a0c; }
`;

/** Inject globalTokensCss once into doc.head, guarded by a <style id="crt-global-tokens">. Idempotent. */
export function ensureGlobalTokens(doc?: Document): void {
  const targetDoc = doc ?? globalThis.document;

  // Check if already injected
  const existing = targetDoc.head.querySelector("#crt-global-tokens");
  if (existing) {
    return; // idempotent: already exists, do nothing
  }

  // Create and inject the style element
  const style = targetDoc.createElement("style");
  style.id = "crt-global-tokens";
  style.textContent = globalTokensCss;
  targetDoc.head.appendChild(style);
}
