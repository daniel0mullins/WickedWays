# Documentation Site on GitHub Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a VitePress static documentation site — prose guide plus a TypeDoc-generated API reference — that auto-deploys to GitHub Pages on every push to `main`.

**Architecture:** VitePress is the site generator (Vite ecosystem, already aligned with the repo's Vitest toolchain). Prose lives under `docs-site/` and the architecture guide *includes* the authoritative root `README.md` so it never drifts. TypeDoc reads the existing TSDoc in `src/lib/**` and emits markdown pages plus a sidebar that VitePress renders under `/api/`. A GitHub Actions workflow builds both and publishes to Pages.

**Tech Stack:** VitePress, TypeDoc, `typedoc-plugin-markdown`, `typedoc-vitepress-theme`, GitHub Actions (`actions/deploy-pages`).

---

## Background the engineer needs

- **Repo:** `git@github.com:daniel0mullins/WickedWays.git`. The published site URL will be `https://daniel0mullins.github.io/WickedWays/`, so VitePress `base` **must** be `'/WickedWays/'` (note the capitalization — it matches the repo name exactly).
- **Runtime:** Node 22, npm. The repo's existing CI (`.github/workflows/checks.yml`) uses `actions/setup-node@v4` with `node-version: 22` and `cache: npm`; mirror that.
- **Two codebases live here.** The TypeScript engine is `src/`. `landing/` + `vendor/` + `composer.*` are an unrelated PHP page. The docs site documents **only** the engine. Do not touch `landing/`.
- **No barrel export.** `src/index.ts` is intentionally empty; consumers import directly from `src/lib/...`. TypeDoc therefore points at the `src/lib` directory (expand strategy), not a single entry file.
- **README is authoritative + large (415 lines).** Lines 1–4 are the `# Wicked Ways` title, a blank line, a `![Wicked Ways](src/assets/images/wicked+ways.png)` image, and another blank line. Prose starts at **line 5**. The README links extensively to source files (`](src/lib/...)`) — these are **not** site pages and would register as dead links, so the VitePress config sets `ignoreDeadLinks: true`.
- **Logo asset:** `src/assets/images/wicked+ways.png` exists (the `+` in the name makes URL handling awkward, so we copy it to a clean `logo.png` in the site's `public/` dir).
- **`npm run checks`** = `lint && typecheck && test`. Linting is `eslint .` (flat config at `eslint.config.mjs`), so the new `docs-site/` dir must be added to that config's `ignores` or it will try to type-lint the VitePress config and fail. Typecheck (`tsc --noEmit`) only includes `src/**`, so the site is unaffected by it.
- **Config file extension matters:** the root `package.json` has no `"type": "module"`, so the VitePress config is written as `.mts` to force ESM regardless.

## File structure

| Path | Responsibility | Created/Modified |
|------|----------------|------------------|
| `docs-site/.vitepress/config.mts` | Site config: title, base, nav, sidebar, dead-link policy, search | Create |
| `docs-site/index.md` | Home page (VitePress `layout: home` hero + features) | Create |
| `docs-site/public/logo.png` | Hero/logo image (copy of the engine logo) | Create |
| `docs-site/guide/introduction.md` | Hand-written orientation page | Create |
| `docs-site/guide/architecture.md` | Includes the root README (authoritative architecture) | Create |
| `docs-site/api/**` | TypeDoc-generated markdown + `typedoc-sidebar.json` (gitignored) | Generated |
| `typedoc.json` | TypeDoc config (entry points, excludes, plugins, output) | Create |
| `.github/workflows/docs.yml` | Build + deploy to GitHub Pages on push to `main` | Create |
| `package.json` | `docs:*` scripts + new devDependencies | Modify |
| `eslint.config.mjs` | Add `docs-site/` to `ignores` | Modify (line ~7) |
| `.gitignore` | Ignore VitePress build/cache + generated `docs-site/api` | Modify |
| `README.md` | Document the docs site + commands | Modify |
| `CLAUDE.md` | Add docs commands + site location note | Modify |

**Note on verification style:** a static site has no unit tests. The verification analog used throughout this plan is *run the build, assert it succeeds, and assert an expected artifact/string exists in the output*. Treat those build-assert steps as the "test" gate before each commit.

---

### Task 1: Scaffold the VitePress site

**Files:**
- Create: `docs-site/.vitepress/config.mts`
- Create: `docs-site/index.md`
- Create: `docs-site/public/logo.png`
- Modify: `package.json` (scripts + devDependencies)
- Modify: `eslint.config.mjs:7`
- Modify: `.gitignore`

- [ ] **Step 1: Install VitePress as a dev dependency**

Run (installs the latest VitePress — expected major: `vitepress@^1`):

```bash
npm install -D vitepress
```

Expected: `package.json` `devDependencies` gains a `vitepress` entry; `package-lock.json` updates.

- [ ] **Step 2: Add the docs npm scripts**

In `package.json`, add these three scripts to the `"scripts"` block (alongside the existing ones; TypeDoc-aware versions are layered on in Task 2):

```json
    "docs:dev": "vitepress dev docs-site",
    "docs:build": "vitepress build docs-site",
    "docs:preview": "vitepress preview docs-site"
```

- [ ] **Step 3: Copy the logo into the site's public dir**

```bash
mkdir -p docs-site/public
cp "src/assets/images/wicked+ways.png" docs-site/public/logo.png
```

Expected: `docs-site/public/logo.png` exists (~1 MB).

- [ ] **Step 4: Write the VitePress config**

Create `docs-site/.vitepress/config.mts` with exactly this content (no `/api/` sidebar yet — that is wired in Task 2 once the generated sidebar JSON exists):

```ts
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
```

- [ ] **Step 5: Write the home page**

Create `docs-site/index.md` with exactly this content (the hero links point at pages created in Task 3; `ignoreDeadLinks: true` keeps the build green until then):

```markdown
---
layout: home
hero:
  name: Wicked Ways
  text: A type-safe tabletop RPG engine
  tagline: Turn-based horror campaigns modeled in TypeScript — branded IDs, hidden state, and runtime lifecycle guards.
  image:
    src: /logo.png
    alt: Wicked Ways
  actions:
    - theme: brand
      text: Get Started
      link: /guide/introduction
    - theme: alt
      text: API Reference
      link: /api/
features:
  - title: Type-safe by construction
    details: Branded IDs and hidden state make illegal game states hard to represent at compile time.
  - title: Runtime lifecycle guards
    details: Illegal moves throw ProceduralViolation instead of silently corrupting campaign state.
  - title: Deterministic & testable
    details: All randomness flows through an injected rng, so seeded runs are fully reproducible.
---
```

- [ ] **Step 6: Exclude the site dir from ESLint**

In `eslint.config.mjs`, extend the existing `ignores` array (currently `["dist/", "coverage/", "node_modules/"]` at line ~7) to include the site:

```js
  {
    ignores: ["dist/", "coverage/", "node_modules/", "docs-site/"],
  },
```

- [ ] **Step 7: Ignore VitePress build artifacts**

Append these lines to `.gitignore`:

```gitignore
docs-site/.vitepress/dist/
docs-site/.vitepress/cache/
docs-site/api/
```

- [ ] **Step 8: Build the site to verify the scaffold**

Run: `npm run docs:build`
Expected: terminal prints `build complete` (VitePress success line). Then:

```bash
test -f docs-site/.vitepress/dist/index.html && echo "OK: home built"
```

Expected: `OK: home built`.

- [ ] **Step 9: Verify repo checks are unaffected**

Run: `npm run checks`
Expected: lint + typecheck + tests all pass exactly as before (the `docs-site/` ESLint ignore prevents the `.mts` config from being type-linted; `tsc` only includes `src/**`).

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json eslint.config.mjs .gitignore docs-site/
git commit -m "feat(docs): scaffold VitePress documentation site"
```

---

### Task 2: Generate the API reference with TypeDoc

**Files:**
- Create: `typedoc.json`
- Modify: `docs-site/.vitepress/config.mts` (add API sidebar + nav entry)
- Modify: `package.json` (TypeDoc-aware scripts + devDependencies)

- [ ] **Step 1: Install TypeDoc and the markdown/VitePress plugins**

Run (latest of each — expected majors: `typedoc@^0.28`, `typedoc-plugin-markdown@^4`, `typedoc-vitepress-theme@^1`):

```bash
npm install -D typedoc typedoc-plugin-markdown typedoc-vitepress-theme
```

- [ ] **Step 2: Write the TypeDoc config**

Create `typedoc.json` with exactly this content:

```json
{
  "$schema": "https://typedoc.org/schema.json",
  "entryPoints": ["src/lib"],
  "entryPointStrategy": "expand",
  "exclude": ["**/*.test.ts", "**/*.spec.ts", "**/test-utils.ts", "**/*.d.ts"],
  "tsconfig": "tsconfig.json",
  "plugin": ["typedoc-plugin-markdown", "typedoc-vitepress-theme"],
  "out": "docs-site/api",
  "readme": "none",
  "githubPages": false,
  "skipErrorChecking": true
}
```

Notes for the engineer:
- `entryPointStrategy: "expand"` walks the `src/lib` directory (including `src/lib/character/**`) instead of relying on a barrel file, which this repo deliberately does not have.
- `exclude` drops co-located tests, the shared `test-utils.ts`, and `brand.d.ts`.
- `skipErrorChecking: true` keeps TypeDoc from failing on the repo's newer TypeScript (^6) version mismatch; type *resolution* still works for doc generation.
- `out: "docs-site/api"` writes generated markdown **inside** the VitePress root so it is served at `/api/`. `typedoc-vitepress-theme` also writes `docs-site/api/typedoc-sidebar.json` there.

- [ ] **Step 3: Generate the API docs**

Run: `npx typedoc`
Expected: TypeDoc prints `Documentation generated at ...docs-site/api`. Then:

```bash
test -f docs-site/api/typedoc-sidebar.json && echo "OK: sidebar generated"
ls docs-site/api | head
```

Expected: `OK: sidebar generated`, and the listing shows generated markdown (e.g. an `index.md` plus per-module files/folders such as `classes/`, `interfaces/`).

- [ ] **Step 4: Layer TypeDoc into the docs scripts**

In `package.json`, **replace** the `docs:dev` and `docs:build` scripts from Task 1 and **add** `docs:api`, so generation always runs before VitePress:

```json
    "docs:api": "typedoc",
    "docs:dev": "npm run docs:api && vitepress dev docs-site",
    "docs:build": "npm run docs:api && vitepress build docs-site",
    "docs:preview": "vitepress preview docs-site"
```

- [ ] **Step 5: Wire the generated sidebar into the VitePress config**

In `docs-site/.vitepress/config.mts`, add the JSON import at the top (below the existing `import`):

```ts
import { defineConfig } from "vitepress";
import typedocSidebar from "../api/typedoc-sidebar.json";
```

Add an API entry to `nav`:

```ts
    nav: [
      { text: "Guide", link: "/guide/introduction" },
      { text: "API", link: "/api/" },
    ],
```

And add an `/api/` key to the `sidebar` object (alongside the existing `/guide/` key):

```ts
      "/api/": [{ text: "API Reference", items: typedocSidebar }],
```

- [ ] **Step 6: Build the full site to verify API integration**

Run: `npm run docs:build`
Expected: `build complete`. Then:

```bash
test -d docs-site/.vitepress/dist/api && echo "OK: api section built"
```

Expected: `OK: api section built`.

- [ ] **Step 7: Commit**

```bash
git add typedoc.json package.json package-lock.json docs-site/.vitepress/config.mts
git commit -m "feat(docs): generate TypeDoc API reference into the site"
```

---

### Task 3: Author the guide pages

**Files:**
- Create: `docs-site/guide/introduction.md`
- Create: `docs-site/guide/architecture.md`

- [ ] **Step 1: Write the introduction page**

Create `docs-site/guide/introduction.md` with exactly this content:

```markdown
# Introduction

Wicked Ways is a type-safe, turn-based tabletop RPG engine written in TypeScript.
It models a party-based horror campaign: a Game Master and player characters take
turns across a procedurally generated dungeon — fighting mobs, looting containers,
talking to NPCs, and accumulating damage across three interlocking stats. Game
rules are enforced both by the type system (branded IDs, hidden state) and at
runtime (lifecycle guards that throw on illegal moves).

## How these docs are organized

- **[Architecture](./architecture)** — the authoritative deep dive: the campaign
  turn loop, character hierarchy, combat and mitigation math, status effects,
  mobs and encounters, loot, crafting, durability, equipment slots, keys, and
  dialogue. This page mirrors the project's root `README.md`.
- **[API Reference](/api/)** — generated directly from the TSDoc comments in
  `src/lib`, so it always matches the current source.

## Using the engine

There is no published npm package yet. Import directly from the engine source
under `src/lib/...` — there is intentionally no barrel export. Start from
`src/lib/campaign.ts` (the campaign turn loop) and follow the types from there;
the [Architecture](./architecture) page walks through how the pieces fit.
```

- [ ] **Step 2: Write the architecture page that includes the README**

Create `docs-site/guide/architecture.md` with exactly this content. The `<!--@include-->` directive is a VitePress feature that inlines another markdown file; the `{5,}` line range starts the include at line 5, skipping the README's own title and logo image (lines 1–4):

```markdown
# Architecture

<!--@include: ../../README.md{5,}-->
```

- [ ] **Step 3: Build and verify the guide renders the README content**

Run: `npm run docs:build`
Expected: `build complete`. Then confirm README prose made it into the architecture page:

```bash
grep -rl "Core concepts" docs-site/.vitepress/dist/guide/ && echo "OK: README included"
```

Expected: prints the built `architecture.html` path and `OK: README included` (the string `Core concepts` is a README `##` heading).

- [ ] **Step 4: Spot-check locally (optional but recommended)**

Run: `npm run docs:preview`
Expected: serves the built site (default `http://localhost:4173/WickedWays/`). Open it, confirm the home hero, the Guide pages, and the API sidebar all render, then stop the server (Ctrl-C).

- [ ] **Step 5: Commit**

```bash
git add docs-site/guide/
git commit -m "docs(site): add introduction and architecture guide pages"
```

---

### Task 4: Deploy to GitHub Pages via Actions

**Files:**
- Create: `.github/workflows/docs.yml`

- [ ] **Step 1: Write the deploy workflow**

Create `.github/workflows/docs.yml` with exactly this content (mirrors the repo's existing `checks.yml` Node setup, plus the standard GitHub Pages publish jobs):

```yaml
name: Docs

# Build and publish the documentation site on every push to main.
on:
  push:
    branches: [main]
  workflow_dispatch:

# Permissions required by actions/deploy-pages.
permissions:
  contents: read
  pages: write
  id-token: write

# Allow only one concurrent deployment; do not cancel an in-progress one.
concurrency:
  group: pages
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run docs:build
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with:
          path: docs-site/.vitepress/dist

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```

- [ ] **Step 2: Sanity-check the build command the workflow runs**

Run: `npm run docs:build`
Expected: `build complete` and the artifact dir exists:

```bash
test -f docs-site/.vitepress/dist/index.html && echo "OK: artifact path matches workflow"
```

Expected: `OK: artifact path matches workflow` (confirms `path: docs-site/.vitepress/dist` in the workflow is correct).

- [ ] **Step 3: Enable GitHub Pages with the Actions build type (one-time repo setting)**

This cannot be done from the working tree; it is a repo setting. Run:

```bash
gh api -X POST repos/daniel0mullins/WickedWays/pages -f build_type=workflow
```

Expected: returns JSON describing the Pages site. If it responds `409` "already enabled", instead run `gh api -X PUT repos/daniel0mullins/WickedWays/pages -f build_type=workflow` to switch the source to GitHub Actions. (Equivalent UI path: repo **Settings → Pages → Build and deployment → Source → GitHub Actions**.) The actual deploy only runs after this branch merges to `main`.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/docs.yml
git commit -m "ci(docs): deploy documentation site to GitHub Pages"
```

---

### Task 5: Document the docs site

**Files:**
- Modify: `README.md` (add a short "Documentation site" section near the top)
- Modify: `CLAUDE.md` (add docs commands + site-location note)

- [ ] **Step 1: Add a documentation-site note to the README**

In `README.md`, immediately after the intro paragraph that ends at line 11 (just before the `## Core concepts` heading at line 12), insert:

```markdown
## Documentation site

Full docs are published to GitHub Pages at
**<https://daniel0mullins.github.io/WickedWays/>** — a prose guide (this README,
rendered) plus an API reference generated from the source TSDoc. The site is
built with VitePress + TypeDoc and lives in `docs-site/`. Work on it locally with:

```bash
npm run docs:dev       # serve the site with hot reload
npm run docs:build     # production build into docs-site/.vitepress/dist
```

It deploys automatically on every push to `main` via `.github/workflows/docs.yml`.

```

- [ ] **Step 2: Add the docs commands to CLAUDE.md**

In `CLAUDE.md`, in the `## Commands` section, add to the command block:

```bash
npm run docs:dev      # VitePress docs site with hot reload (docs-site/)
npm run docs:build    # build the docs site (runs TypeDoc, then VitePress)
```

Then, in the "Repo layout gotcha" section (which already explains the `src/` vs `landing/` split), add a sentence noting the third area:

```markdown
The `docs-site/` directory is the VitePress documentation site (prose guide +
TypeDoc API reference) published to GitHub Pages; like `landing/`, it is separate
from the engine and not built by `npm run build`.
```

- [ ] **Step 3: Verify the docs still build after edits**

Run: `npm run docs:build`
Expected: `build complete` (confirms the README edits — which the architecture page includes — did not break the include or introduce a fatal markdown error).

- [ ] **Step 4: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: document the docs site and its commands"
```

---

## Final verification (after all tasks)

- [ ] Run `npm run docs:build` → `build complete`, no errors.
- [ ] Run `npm run checks` → lint + typecheck + tests all green (site dir does not interfere).
- [ ] Confirm `docs-site/.vitepress/dist/index.html`, `.../guide/architecture.html`, and `.../api/` all exist.
- [ ] Confirm Pages is set to the **GitHub Actions** source (Task 4 Step 3).
- [ ] After merge to `main`, confirm the `Docs` workflow runs green and the site is live at <https://daniel0mullins.github.io/WickedWays/>.

## Out of scope (YAGNI — do not build unless asked)

- Docs versioning, a blog, or i18n.
- A custom domain / `CNAME`.
- Rewriting the README's `src/lib/...` links into clickable GitHub source URLs (currently suppressed via `ignoreDeadLinks`). Reasonable future polish, not required now.
- Publishing the package to npm or generating install instructions for a published package.
