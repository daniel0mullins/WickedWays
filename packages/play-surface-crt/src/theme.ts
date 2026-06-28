import type { Theme } from "@wickedways/play-runtime";

export interface CrtTheme extends Theme {
  palette: { bg: string; fg: string; accent: string; warn: string; critical: string };
  fonts: { body: string; display: string };
  effects: { scanlineIntensity: number; glow: number; flicker: number };
}

export const defaultCrtTheme: CrtTheme = {
  id: "default",
  label: "Default",
  palette: { bg: "#0b0e0a", fg: "#9be89b", accent: "#d7ffd7", warn: "#e8d36b", critical: "#e86b6b" },
  fonts: { body: "'VT323', monospace", display: "'Silkscreen', monospace" },
  effects: { scanlineIntensity: 0.25, glow: 0.6, flicker: 0.0 },
};

/** Applies a theme to the CRT housing via CSS custom properties. */
export function applyTheme(root: HTMLElement, theme: CrtTheme): void {
  const s = root.style;
  s.setProperty("--crt-bg", theme.palette.bg);
  s.setProperty("--crt-fg", theme.palette.fg);
  s.setProperty("--crt-accent", theme.palette.accent);
  s.setProperty("--crt-warn", theme.palette.warn);
  s.setProperty("--crt-critical", theme.palette.critical);
  s.setProperty("--crt-font-body", theme.fonts.body);
  s.setProperty("--crt-font-display", theme.fonts.display);
  s.setProperty("--crt-scanline", String(theme.effects.scanlineIntensity));
  s.setProperty("--crt-glow", String(theme.effects.glow));
  s.setProperty("--crt-flicker", String(theme.effects.flicker));
}
