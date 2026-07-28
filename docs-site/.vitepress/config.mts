import { defineConfig } from "vitepress";
import { withMermaid } from "vitepress-plugin-mermaid";

// `withMermaid` wraps the config so ```mermaid fenced blocks live-render
// (VitePress has no native Mermaid support). Used by /guide/data-model.
// Project site is served from https://daniel0mullins.github.io/WickedWays/,
// so every asset/link is prefixed with this base.
export default withMermaid(defineConfig({
  title: "Wicked Ways",
  description: "A turn-based tabletop horror-RPG engine in Rust, shipped as a wasm web client.",
  base: "/WickedWays/",
  // The architecture guide includes the root README, which links to source
  // files (crates/...) that are not site pages. Skip dead-link checking
  // rather than rewrite every source link.
  ignoreDeadLinks: true,
  // Pre-bundle Mermaid (from vitepress-plugin-mermaid) so its CJS dependency
  // dayjs gets bundled with proper default-export interop; otherwise the dev
  // server throws "does not provide an export named 'default'" in the browser.
  // `pnpm docs:build` is unaffected; this only fixes `docs:dev`.
  vite: {
    optimizeDeps: {
      include: ["mermaid"],
    },
    ssr: {
      noExternal: ["mermaid"],
    },
  },
  themeConfig: {
    nav: [{ text: "Guide", link: "/guide/introduction" }],
    sidebar: {
      "/guide/": [
        {
          text: "Guide",
          items: [
            { text: "Introduction", link: "/guide/introduction" },
            { text: "Getting started", link: "/guide/getting-started" },
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
}));
