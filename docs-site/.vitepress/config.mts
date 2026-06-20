import { defineConfig } from "vitepress";
import { withMermaid } from "vitepress-plugin-mermaid";
import typedocSidebar from "../api/typedoc-sidebar.json";

// `withMermaid` wraps the config so ```mermaid fenced blocks live-render
// (VitePress has no native Mermaid support). Used by /guide/data-model.
// Project site is served from https://daniel0mullins.github.io/WickedWays/,
// so every asset/link is prefixed with this base.
export default withMermaid(defineConfig({
  title: "Wicked Ways",
  description: "A type-safe, turn-based tabletop RPG engine in TypeScript.",
  base: "/WickedWays/",
  // The architecture guide includes the root README, which links to source
  // files (src/lib/...) that are not site pages. Skip dead-link checking
  // rather than rewrite every source link.
  ignoreDeadLinks: true,
  themeConfig: {
    nav: [
      { text: "Guide", link: "/guide/introduction" },
      { text: "API", link: "/api/" },
    ],
    sidebar: {
      "/guide/": [
        {
          text: "Guide",
          items: [
            { text: "Introduction", link: "/guide/introduction" },
            { text: "Architecture", link: "/guide/architecture" },
            { text: "Data model", link: "/guide/data-model" },
          ],
        },
      ],
      "/api/": [{ text: "API Reference", items: typedocSidebar }],
    },
    socialLinks: [
      { icon: "github", link: "https://github.com/daniel0mullins/WickedWays" },
    ],
    search: { provider: "local" },
  },
}));
