import DefaultTheme from "vitepress/theme";
import type { Theme } from "vitepress";
import "./mermaid-zoom.css";

// Extends the default VitePress theme with scroll-to-zoom / drag-to-pan for the
// Mermaid diagrams on /guide/data-model. svg-pan-zoom touches `window`, so it is
// imported only on the client (skipped during the SSR build).
export default {
  extends: DefaultTheme,
  enhanceApp() {
    if (!import.meta.env.SSR) {
      void import("./mermaid-zoom").then((m) => m.setupMermaidZoom());
    }
  },
} satisfies Theme;
