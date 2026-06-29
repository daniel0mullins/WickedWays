import { defaultPncTheme, type PncTheme } from "@wickedways/play-surface/pnc";

// Near-black bg, desaturated stone-grey ink, pale bone accent — eerier and
// heavier than the default to match the haunted-house atmosphere.
export const hauntedPncTheme: PncTheme = {
  id: "haunted",
  label: "Haunted",
  palette: {
    bg: "#070508",
    panel: "#100d0f",
    ink: "#b8b0a0",
    accent: "#8b6a3a",
    warn: "#c08020",
    critical: "#c03030",
    hotspot: "#3a6a8c",
  },
  fonts: {
    body: "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    display: "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  },
  scene: { vignette: 0.6, grain: 0.08, fog: 0.18 },
};

export const hollowHousePncThemes: PncTheme[] = [defaultPncTheme, hauntedPncTheme];
