import type { Theme } from "@wickedways/play-runtime";

export interface PncTheme extends Theme {
  palette: {
    bg: string;
    panel: string;
    ink: string;
    accent: string;
    warn: string;
    critical: string;
    hotspot: string;
  };
  fonts: { body: string; display: string };
  scene: { vignette: number; grain: number; fog?: number };
}

export const defaultPncTheme: PncTheme = {
  id: "default",
  label: "Default",
  palette: {
    bg: "#1a1814",
    panel: "#252220",
    ink: "#e8e2d0",
    accent: "#b8943c",
    warn: "#d4a843",
    critical: "#c04040",
    hotspot: "#4a8ec8",
  },
  fonts: {
    body: "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    display: "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  },
  scene: { vignette: 0.2, grain: 0.0 },
};

/** Applies a PnC theme to an element via CSS custom properties. */
export function applyPncTheme(root: HTMLElement, theme: PncTheme): void {
  const s = root.style;
  s.setProperty("--pnc-bg", theme.palette.bg);
  s.setProperty("--pnc-panel", theme.palette.panel);
  s.setProperty("--pnc-ink", theme.palette.ink);
  s.setProperty("--pnc-accent", theme.palette.accent);
  s.setProperty("--pnc-warn", theme.palette.warn);
  s.setProperty("--pnc-critical", theme.palette.critical);
  s.setProperty("--pnc-hotspot", theme.palette.hotspot);
  s.setProperty("--pnc-font-body", theme.fonts.body);
  s.setProperty("--pnc-font-display", theme.fonts.display);
  s.setProperty("--pnc-vignette", String(theme.scene.vignette));
  s.setProperty("--pnc-grain", String(theme.scene.grain));
  if (theme.scene.fog !== undefined) {
    s.setProperty("--pnc-fog", String(theme.scene.fog));
  } else {
    s.removeProperty("--pnc-fog");
  }
}
