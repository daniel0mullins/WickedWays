import { defaultCrtTheme, type CrtTheme } from "@wickedways/play-surface/crt";

// Near-black bg, muted blood fg — accent is warm candlelit bone/amber for visible, horror-coherent highlights.
export const hauntedCrtTheme: CrtTheme = {
  id: "haunted",
  label: "Haunted",
  palette: { bg: "#080406", fg: "#c08a8a", accent: "#d8b48a", warn: "#d98a4b", critical: "#ff3b3b" },
  fonts: { body: "'VT323', monospace", display: "'Silkscreen', monospace" },
  effects: { scanlineIntensity: 0.4, glow: 0.9, flicker: 0.15 },
};

export const hollowHouseThemes: CrtTheme[] = [defaultCrtTheme, hauntedCrtTheme];
