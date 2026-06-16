import { defineConfig } from "vitepress";

// Project site is served from https://daniel0mullins.github.io/WickedWays/,
// so every asset/link is prefixed with this base.
export default defineConfig({
  title: "Wicked Ways",
  description: "A type-safe, turn-based tabletop RPG engine in TypeScript.",
  base: "/WickedWays/",
  // The architecture guide includes the root README, which links to source
  // files (src/lib/...) that are not site pages. Skip dead-link checking
  // rather than rewrite every source link.
  ignoreDeadLinks: true,
  themeConfig: {
    nav: [{ text: "Guide", link: "/guide/introduction" }],
    sidebar: {
      "/guide/": [
        {
          text: "Guide",
          items: [
            { text: "Introduction", link: "/guide/introduction" },
            { text: "Architecture", link: "/guide/architecture" },
          ],
        },
      ],
    },
    socialLinks: [
      { icon: "github", link: "https://github.com/daniel0mullins/WickedWays" },
    ],
    search: { provider: "local" },
  },
});
