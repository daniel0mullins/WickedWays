import { defaultCrtTheme, type CrtTheme } from "../text/theme.js";

export const hauntedCrtTheme: CrtTheme = {
  id: "haunted",
  label: "Haunted",
  palette: { bg: "#080406", fg: "#c08a8a", accent: "#f0d0d0", warn: "#d98a4b", critical: "#ff3b3b" },
  fonts: { body: "'VT323', monospace", display: "'Silkscreen', monospace" },
  effects: { scanlineIntensity: 0.4, glow: 0.9, flicker: 0.15 },
};

export const hollowHouseThemes: CrtTheme[] = [defaultCrtTheme, hauntedCrtTheme];
