# Point-and-Click Play Surface — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second, point-and-click `PlaySurface` for Hollow House (a procedural room scene with contextual verb menus), selectable at launch alongside the CRT terminal.

**Architecture:** Consolidate surfaces into one `@wickedways/play-surface` package (subpath exports per surface, like `@wickedways/campaigns`). Add manifest multi-surface support + per-surface themes + a launcher surface-picker. Build the point-and-click surface as Lit components + a controller (same no-decorator pattern as the CRT surface), turning hotspot/menu clicks into engine `Intent`s. Support the engine's `presentation.image` hook; defer art.

**Tech Stack:** TypeScript (strict, NodeNext), Lit 3 (no-decorator API), Vite, Vitest (`happy-dom` per-file docblock for component tests; `node` default), Playwright (e2e), pnpm workspaces.

Spec: `docs/superpowers/specs/2026-06-28-point-and-click-surface-design.md`. Reference implementation patterns live in the current CRT surface (`packages/play-surface-crt/src/`) — read its components and `controller.ts` before Phase 3.

## Global Constraints

- **Lit 3, no-decorator API only:** `static properties`, `declare` fields, constructor init, `static styles = css\`…\``, `customElements.define`, and a `declare global { HTMLElementTagNameMap }` augmentation. Custom elements register only when imported — consumers MUST side-effect `import "./x.js"`. (Pattern: `packages/play-surface-crt/src/components/crt-status.ts`.)
- **All cross-shadow events** are `{ bubbles: true, composed: true }`.
- **Open shadow roots only** (so Playwright pierces). happy-dom `querySelector` does NOT pierce — use a `deepQuery` helper in tests.
- **Engine untouched:** no edits under `src/lib/` or `wickedways`. The `ViewModel` `image` mapping lives in `packages/play-runtime/src/viewmodel.ts`, NOT the engine.
- **Directions are the 8 compass bearings** (`North/South/East/West/Northeast/Northwest/Southeast/Southwest`) — no up/down.
- **Every game action is single-target or zero-noun.** The PnC surface builds `Intent`s directly; it does NOT use the parser.
- **Theming rides on CSS custom properties** (`--pnc-*`) inherited through shadow boundaries; switching re-applies on the app root with no re-render. Theme + surface persist in the URL (`?theme=`, `?surface=`), never in the save state.
- **`pnpm checks` (lint + typecheck + all tests) green before any task is done**; the Playwright e2e stays green from Phase 2 on.
- Reuse, don't reinvent: `Narrator`, `map-view` (`layoutMap`/`renderMapSvg`), `MapModel`, `AudioRuntime`, `GameSession`, the cue-handling order from the CRT `controller.ts`.

---

## Phase 1 — Consolidate into `@wickedways/play-surface`

### Task 1: Rename + restructure the surface package

**Files:**
- Rename package dir: `packages/play-surface-crt/` → `packages/play-surface/`
- Move CRT modules into `packages/play-surface/src/crt/`: `components/`, `controller.ts`(+test), `surface.ts`(+test), `parser.ts`(+test), `link-nouns.ts`(+test), `styles.ts`(+test), `theme.ts`. Keep their co-located tests beside them.
- Move shared modules into `packages/play-surface/src/shared/`: `narrator.ts`(+test), `map-view.ts`(+test).
- Create: `packages/play-surface/src/crt/index.ts`, `packages/play-surface/src/shared/index.ts`
- Delete: the old top-level `packages/play-surface/src/index.ts` (replaced by subpath barrels)
- Modify: `packages/play-surface/package.json` (name + exports), and every importer (below)

**Interfaces:**
- Produces: package `@wickedways/play-surface` with `"exports": { "./*": "./src/*/index.ts" }`; `@wickedways/play-surface/crt` exports `crtSurface`, `CrtTheme`, `defaultCrtTheme`, `applyTheme`, and re-exports `parse`, `Narrator`; `@wickedways/play-surface/shared` exports `Narrator`, `layoutMap`, `renderMapSvg`.

- [ ] **Step 1: `git mv` the package and restructure.** `git mv packages/play-surface-crt packages/play-surface`, then `git mv` the modules into `src/crt/` and `src/shared/` as listed. Within `src/crt/`, `controller.ts`/`surface.ts`/components import `Narrator` and `map-view` from `../shared/narrator.js` / `../shared/map-view.js` (update those relative imports). `narrator.ts` and `map-view.ts` have no CRT-specific imports (verify; `map-view` returns SVG themed via CSS vars).

- [ ] **Step 2: Write the barrels.**

`src/shared/index.ts`:
```ts
export { Narrator } from "./narrator.js";
export type { RoomParts } from "./narrator.js";
export { layoutMap, renderMapSvg } from "./map-view.js";
```
`src/crt/index.ts` (preserve the old `index.ts`'s exports so importers only change the specifier):
```ts
export { crtSurface } from "./surface.js";
export { defaultCrtTheme, applyTheme } from "./theme.js";
export type { CrtTheme } from "./theme.js";
export { parse } from "./parser.js";
export { Narrator } from "../shared/narrator.js";
```

- [ ] **Step 3: Update `package.json`.**
```jsonc
{
  "name": "@wickedways/play-surface",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "exports": { "./*": "./src/*/index.ts" },
  "scripts": { "typecheck": "tsc --noEmit" },
  "dependencies": { /* unchanged: @fontsource/*, @wickedways/play-runtime, lit, wickedways */ }
}
```
(Drop the old `"main"` and `"."` export — subpath only, matching `@wickedways/campaigns`.)

- [ ] **Step 4: Repoint all importers** (specifier `@wickedways/play-surface-crt` → `@wickedways/play-surface/crt`):
  - `packages/campaigns/package.json` dep key → `"@wickedways/play-surface": "workspace:*"`
  - `packages/play/package.json` dep key → `"@wickedways/play-surface": "workspace:*"`
  - `packages/campaigns/src/hollow-house/themes.ts` import → `@wickedways/play-surface/crt`
  - `packages/play/src/core/laudanum.test.ts`, `packages/play/src/core/capstone.test.ts` imports → `@wickedways/play-surface/crt`
  - `packages/play/src/main.ts` `crtSurface` import → `@wickedways/play-surface/crt`
  - `packages/play/README.md` references (text only) → updated in Phase 4 docs; leave a note.
  Run `pnpm install` to relink the workspace.

- [ ] **Step 5: Verify + commit.** Run `pnpm checks`. Expected: green (1167+ tests), no behavior change. If a root `tsconfig`/Vite alias references the old package path, update it.
```bash
git add -A && git commit -m "refactor(play-surface): consolidate CRT surface into @wickedways/play-surface (subpath exports)"
```

---

## Phase 2 — Surface-picker infrastructure

### Task 2: Manifest `surfaces` + `SurfaceChoice`

**Files:**
- Modify: `packages/play-runtime/src/manifest.ts`
- Modify: `packages/play-runtime/src/manifest.test.ts` (create if absent)

**Interfaces:**
- Produces: `interface SurfaceChoice { id: string; themes?: readonly Theme[] }`; `CampaignManifest.surfaces?: readonly SurfaceChoice[]` replacing `surface?`/`themes?`.

- [ ] **Step 1: Replace the `surface`/`themes` fields** in `CampaignManifest` with:
```ts
/** A surface this campaign can run on, with that surface's themes (its own Theme shape). */
export interface SurfaceChoice {
  /** `PlaySurface` id, e.g. `"crt-terminal"` or `"point-and-click"`. */
  id: string;
  /** Themes for THIS surface; `themes[0]` is the default. Omit → the surface's own default. */
  themes?: readonly Theme[];
}
// in CampaignManifest, replace `surface?` and `themes?` with:
/** Surfaces this campaign offers; `surfaces[0]` is the default. Omit → one default `"crt-terminal"`. */
surfaces?: readonly SurfaceChoice[];
```
Keep `import type { Theme } from "./surface.js"`.

- [ ] **Step 2: Add `manifest.test.ts`** asserting a manifest typechecks with `surfaces: [{ id: "crt-terminal", themes: [{ id:"default", label:"Default" }] }]` and with `surfaces` omitted. (Type-level + a trivial runtime assertion that the object is constructable.) Run it; commit.

### Task 3: `MountArgs` theme-persistence hooks + `PlaySurface.description`

**Files:**
- Modify: `packages/play-runtime/src/surface.ts`

**Interfaces:**
- Produces: `MountArgs.initialThemeId?: string`, `MountArgs.onThemeChange?(id: string): void`, `PlaySurface.description?: string`.

- [ ] **Step 1: Add the optional fields** with TSDoc:
```ts
// in MountArgs:
/** Theme id to apply on mount (from `?theme=`); falls back to `themes[0]` if unknown/absent. */
initialThemeId?: string;
/** Fired by the surface when the player switches theme, so the launcher can persist `?theme=`. */
onThemeChange?(id: string): void;
// in PlaySurface:
/** One-line description for the surface picker; falls back to `label`. */
description?: string;
```

- [ ] **Step 2:** `pnpm typecheck` (no test needed — additive optional fields). Commit with Task 4 if trivial, else alone.

### Task 4: `<surface-picker>` component

**Files:**
- Create: `packages/play-runtime/src/components/surface-picker.ts`
- Create: `packages/play-runtime/src/components/surface-picker.test.ts`

**Interfaces:**
- Consumes: the no-decorator Lit pattern (mirror `packages/play-runtime/src/components/campaign-menu.ts`).
- Produces: `<surface-picker>` with prop `surfaces: { id: string; label: string; description?: string }[]`; emits `select` `{ detail: { id } }` (bubbles+composed); a `back` event `{}` for "← campaigns".

- [ ] **Step 1: Write the failing test** (`// @vitest-environment happy-dom`): renders one `.surface-entry` per surface (label + description); clicking emits `select` with the id; Enter on a focused entry emits `select`; Arrow keys move focus; a back control emits `back`. Mirror `campaign-menu.test.ts`'s structure (side-effect import, `let el: SurfacePicker`, deep assertions on `el.shadowRoot`).

- [ ] **Step 2: Run it — FAIL** (module missing).

- [ ] **Step 3: Implement** following `campaign-menu.ts` exactly (no-decorator, self-contained shadow styles — NO `--crt-*`/`--pnc-*` tokens since this is surface-independent chrome). Reuse the class names `launcher-menu`/`launcher-entry`-style but prefix `surface-` for clarity; render `description ?? label`. Add a small "← Campaigns" button emitting `back`.

- [ ] **Step 4: Run — PASS.** `pnpm checks` green.

- [ ] **Step 5: Commit** `feat(play-runtime): add <surface-picker> component`.

### Task 5: Launcher — campaign→surface→mount flow + URL params

**Files:**
- Modify: `packages/play-runtime/src/launcher.ts`
- Modify: `packages/play-runtime/src/launcher.test.ts`

**Interfaces:**
- Consumes: `<surface-picker>` (Task 4), `SurfaceChoice` (Task 2), `MountArgs.initialThemeId`/`onThemeChange` (Task 3).
- Produces: launcher that resolves surfaces per campaign, shows the picker when ≥2, and threads `?surface=`/`?theme=`.

- [ ] **Step 1: Write/extend failing tests** (`// @vitest-environment happy-dom`, `locationSearch` injected via `BootOpts`):
  - A campaign with `surfaces.length >= 2` and no `?surface=` → `bootLauncher` renders a `<surface-picker>` populated with both surfaces' `{id,label,description}`.
  - `?campaign=hollow-house&surface=point-and-click` (both registered) → mounts the PnC surface directly (assert the right surface's `mount` is called — use stub surfaces with spy `mount`).
  - A campaign with `surfaces` omitted (or length 1) → no picker; mounts the sole/default surface (today's behavior).
  - Picking a surface sets `?surface=<id>` (assert `window.location.search` via a stubbed history, or that `mount` received the right surface).
  Keep existing `resolveCampaign` tests.

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement.** Read the current `launcher.ts`. Refactor `launch(m)` to take a resolved `SurfaceChoice` + surface, and split the flow:
```ts
const surfaceChoices = (m: CampaignManifest): readonly SurfaceChoice[] =>
  m.surfaces && m.surfaces.length ? m.surfaces : [{ id: "crt-terminal" }];

const mountSurface = (m: CampaignManifest, choice: SurfaceChoice): void => {
  const surface = reg.surfaces.find((s) => s.id === choice.id) ?? reg.surfaces[0]!;
  setParam("campaign", m.slug); setParam("surface", surface.id);
  const themes = choice.themes && choice.themes.length ? [...choice.themes] : [surface.defaultTheme];
  const initialThemeId = new URLSearchParams(currentSearch()).get("theme") ?? undefined;
  const session = GameSession.start({ /* …as today… */ });
  const audio = AudioRuntime.forCampaign(m.audio);
  handle = surface.mount({
    app, session, manifest: m, themes, audio,
    initialThemeId,
    onThemeChange: (id) => setParam("theme", id),
    onExit: () => { handle?.unmount(); handle = null; clearParams("campaign","surface","theme"); showMenu(); },
  });
};

const chooseSurface = (m: CampaignManifest): void => {
  const choices = surfaceChoices(m);
  if (choices.length < 2) { mountSurface(m, choices[0]!); return; }
  // render <surface-picker>
  app.replaceChildren();
  const picker = document.createElement("surface-picker");
  picker.surfaces = choices.map((c) => {
    const s = reg.surfaces.find((x) => x.id === c.id);
    return { id: c.id, label: s?.label ?? c.id, description: s?.description };
  });
  picker.addEventListener("select", (e) => {
    const id = (e as CustomEvent<{id:string}>).detail.id;
    const choice = choices.find((c) => c.id === id)!;
    mountSurface(m, choice);
  });
  picker.addEventListener("back", () => { clearParams("campaign","surface","theme"); showMenu(); });
  app.appendChild(picker);
};
```
  - `showMenu()`'s `<campaign-menu>` `select` handler now calls `chooseSurface(m)` instead of `launch(m)`.
  - Deep-link boot: read `?campaign=` → resolve campaign; if `?surface=` present and valid for that campaign → `mountSurface` directly; else `chooseSurface(m)`. No `?campaign=` → `showMenu()`.
  - Add tiny helpers `setParam`/`clearParams`/`currentSearch` over `window.history.replaceState` + `window.location`, honoring `opts.locationSearch` in tests.
  - Side-effect `import "./components/surface-picker.js"` and keep `import "./components/campaign-menu.js"`.

- [ ] **Step 4: Run — PASS.** `pnpm checks` green.

- [ ] **Step 5: Commit** `feat(play-runtime): surface picker + per-surface themes + ?surface=/?theme= in the launcher`.

### Task 6: CRT surface adopts `initialThemeId` / `onThemeChange`

**Files:**
- Modify: `packages/play-surface/src/crt/controller.ts`
- Modify: `packages/play-surface/src/crt/controller.test.ts`

**Interfaces:**
- Consumes: `MountArgs.initialThemeId`/`onThemeChange`.

- [ ] **Step 1: Write the failing test:** mounting with `initialThemeId` set to a non-default theme id applies that theme on mount (assert via the bezel's active theme / the applied `--crt-*`); a `theme-change` calls the provided `onThemeChange` with the chosen id. (Use the existing controller test harness + a `vi.fn()` for `onThemeChange`, and pass ≥2 themes.)

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement.** In `mountTerminal`, read `meta.initialThemeId` and apply `themes.find(t => t.id === id) ?? themes[0]` on mount (instead of always `themes[0]`); set the bezel's `activeTheme` accordingly. In the bezel `theme-change` handler, after `applyTheme`, call `meta.onThemeChange?.(id)`. (`mountTerminal`'s `meta` type gains the two optional fields from `MountArgs`.)

- [ ] **Step 4: Run — PASS.** `pnpm checks` green.

- [ ] **Step 5: Commit** `feat(play-surface/crt): honor initialThemeId + onThemeChange (theme survives reload)`.

### Task 7: Migrate Hollow House + seed manifests to `surfaces`

**Files:**
- Modify: `packages/campaigns/src/hollow-house/manifest.ts`
- Modify: `packages/campaigns/src/seed/index.ts` (the seed manifest)
- Modify/verify: `packages/campaigns/src/hollow-house/themes.ts` (import specifier already repointed in Task 1)

**Interfaces:**
- Consumes: manifest `surfaces` (Task 2).

- [ ] **Step 1:** In Hollow House `manifest.ts`, replace `surface: "crt-terminal"` + `themes: hollowHouseThemes` with:
```ts
surfaces: [{ id: "crt-terminal", themes: hollowHouseThemes }],
```
(The PnC surface choice is added in Task 22, after the surface exists.)
- [ ] **Step 2:** In the seed manifest, ensure no `surface`/`themes` fields remain (it omitted them already → defaults to CRT). If present, remove.
- [ ] **Step 3:** `pnpm checks` green (the `?campaign=hollow-house` deep-link still boots CRT, picker skipped at length 1). Commit `refactor(campaigns): adopt manifest.surfaces`.

### Task 8: e2e — theme persists across reload (CRT)

**Files:**
- Modify: `packages/play/e2e/playthrough.spec.ts`

- [ ] **Step 1:** Add a test: deep-link `?campaign=hollow-house`, switch the theme to "Haunted" via the bezel `<select>`, assert the URL gains `?theme=haunted`, reload the page, assert the haunted theme is still applied (e.g. the themed `--crt-*` value or a haunted-only visual marker) and `?theme=haunted` persists. Run `pnpm --filter @wickedways/play test:e2e` — green. Commit.

---

## Phase 3 — The point-and-click surface (`src/pnc/`)

> Build under `packages/play-surface/src/pnc/`. Mirror the CRT no-decorator Lit pattern throughout. Each component: side-effect import to register; props down, `composed` events up; `static styles` reading `--pnc-*`.

### Task 9: `ViewModel` image mapping

**Files:**
- Modify: `packages/play-runtime/src/viewmodel.ts`
- Modify: `packages/play-runtime/src/viewmodel.test.ts`

**Interfaces:**
- Produces: `ScopeEntity.image?: string`; `ViewModel.room.image?: string`.

- [ ] **Step 1: Write the failing test:** build a campaign/room where an occupant/item and the room carry `presentation.image`; assert `view(...).occupants[0].image`, `.inventory.items[0].image`, and `.room.image` equal those refs; assert entities without presentation have `image === undefined`. (Use existing test fixtures/builders; set `presentation` on a character/item/room via the authoring API or a stub.)

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement.** Add `image?: string` to `ScopeEntity` and to `ViewModel.room`. At each construction site in `view()` (occupants, loot contents, inventory items, keys, and `room`), add `image: <entity>.presentation?.image`. `AssetRef` is `string`, so type as `string`.

- [ ] **Step 4: Run — PASS.** `pnpm checks` green. Commit `feat(play-runtime): surface presentation.image on ViewModel entities + room`.

### Task 10: PnC theme — `PncTheme`, `applyPncTheme`, tokens, default theme

**Files:**
- Create: `packages/play-surface/src/pnc/theme.ts`
- Create: `packages/play-surface/src/pnc/styles.ts` (+ test) — the `--pnc-*` token defaults + `ensurePncTokens`
- Create: `packages/play-surface/src/pnc/theme.test.ts`

**Interfaces:**
- Produces: `interface PncTheme extends Theme { palette:{bg,panel,ink,accent,warn,critical,hotspot}; fonts:{body,display}; scene:{vignette,grain,fog?} }`; `defaultPncTheme: PncTheme`; `applyPncTheme(root, theme)`; `pncGlobalTokensCss`/`ensurePncTokens(doc?)`.

- [ ] **Step 1:** Mirror the CRT `theme.ts` + `styles.ts`. `applyPncTheme` sets `--pnc-bg/-panel/-ink/-accent/-warn/-critical/-hotspot`, `--pnc-font-body/-display`, `--pnc-vignette/-grain/-fog`. `ensurePncTokens` injects a `<style id="pnc-global-tokens">` with the `:root` defaults + derived aliases (e.g. `--color-bg: var(--pnc-bg)`) once (idempotent — copy the CRT `styles.ts` test for idempotency).

- [ ] **Step 2:** Tests (happy-dom): `applyPncTheme` writes the custom properties; `ensurePncTokens` idempotent. RED→GREEN. `pnpm checks` green. Commit `feat(play-surface/pnc): PncTheme + applyPncTheme + tokens`.

### Task 11: Affordance map (`affordances.ts`)

**Files:**
- Create: `packages/play-surface/src/pnc/affordances.ts`
- Create: `packages/play-surface/src/pnc/affordances.test.ts`

**Interfaces:**
- Consumes: `ViewModel`, `ScopeEntity`, `Intent` (from `@wickedways/play-runtime`), `Direction`.
- Produces:
```ts
export type ActionDescriptor =
  | { label: string; kind: "intent"; intent: Intent }
  | { label: string; kind: "examine"; targetId: string };  // routed to the examine flow

export interface Hotspot {
  key: string;                 // stable: dir for exits/doors, entity id otherwise
  label: string;               // "North", "Revenant", "Chest", "Brass Key"
  kind: "exit" | "locked" | "occupant" | "loot" | "item";
  dir?: Direction;             // exits/locked doors
  image?: string;              // entity/room image if present
  actions: ActionDescriptor[]; // [] for locked doors (informational)
}

export function sceneHotspots(vm: ViewModel): Hotspot[];           // exits, locked doors, occupants, loot, room-floor items
export function inventoryActions(item: ScopeEntity, equipped: boolean): ActionDescriptor[];
```

- [ ] **Step 1: Write failing tests** (node — pure functions): for a `ViewModel` with a passable exit, a locked door, a living mob, an opened/closed loot, a floor item:
  - exit → `{kind:"exit", dir, actions:[{label:"Go North", kind:"intent", intent:{kind:"move",dir}}]}`
  - locked door → `{kind:"locked", actions:[]}`, label includes the door name
  - occupant (not defeated) → actions `Examine` (examine targetId) + `Attack` (`{kind:"attack",targetId}`); a `defeated` occupant offers only `Examine`
  - loot → `Examine` + `Open` (`{kind:"open",targetId}`)
  - floor item (a `scope` entity of kind `item` not in inventory and not loot-contained) → `Examine` + `Take` (`{kind:"take",targetId}`)
  - `inventoryActions(item, false)` → Examine, Equip, Use, Drop; `(item, true)` → Examine, **Unequip**, Use, Drop
  - `image` is carried through from the entity.
  Cover the winning-path verbs (open/take/equip/attack/go/examine).

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement** as pure functions of the `ViewModel`. Derive scene "floor items" as `vm.scope.filter(e => e.kind === "item")` minus inventory ids minus loot-content ids (examine the CRT HUD/`refresh` logic for how scope vs inventory is partitioned). Capitalize directions via a local `cap`. Intents use the exact `Intent` shapes (`move`/`attack`/`open`/`take`/`equip`/`unequip`/`use`/`drop`).

- [ ] **Step 4: Run — PASS.** `pnpm checks` green. Commit `feat(play-surface/pnc): affordance map (hotspots + inventory verbs)`.

### Tasks 12–19: Components

> Each is its own task: write the failing happy-dom test (assert real shadow DOM + events), implement following the CRT no-decorator pattern, `pnpm checks` green, commit. Side-effect-register each element; events `{bubbles,composed}`.

### Task 12: `<pnc-welcome>`
- **Files:** `src/pnc/components/pnc-welcome.ts`(+test). Props `title`/`intro`/`buttonText`; emits `enter`. Focus the start button in `firstUpdated`. (Direct analog of `crt-welcome.ts` — copy structure, restyle with `--pnc-*`/`--color-*`.) Commit `feat(play-surface/pnc): <pnc-welcome>`.

### Task 13: `<pnc-topbar>`
- **Files:** `src/pnc/components/pnc-topbar.ts`(+test). Props `roomName`, `audioEnabled`, `soundpacks`, `activeSoundpack`, `themes`, `activeTheme`. Emits `toggle-audio` / `soundpack-change {id}` / `theme-change {id}` / `open-map` / `open-menu`. Soundpack/theme `<select>`s auto-hide <2 and use `?selected=${id===active}` per option (the CRT bezel learned this — copy it). Commit.

### Task 14: `<pnc-log>`
- **Files:** `src/pnc/components/pnc-log.ts`(+test). Imperative API `print(lines: string[], cls?: string)`, `clear()`; renders a stable `<div class="log">` and appends lines imperatively (like `crt-transcript` but NO typewriter, NO clickable nouns); auto-scrolls to bottom. Commit.

### Task 15: `<pnc-status>`
- **Files:** `src/pnc/components/pnc-status.ts`(+test). Prop `fields: readonly StatusField[]` (from `wickedways/lib/presentation`). Renders each field as a readout with `emphasis` → class (`pnc-warn`/`pnc-critical`); if a field's `value` matches `^\d+\s*/\s*\d+$`, also render a proportional bar; else plain. Commit.

### Task 16: `<pnc-inventory>`
- **Files:** `src/pnc/components/pnc-inventory.ts`(+test). Props `items: ScopeEntity[]`, `keys: ScopeEntity[]`, `equippedNames: string[]`. Renders each with `(equipped)` tag + optional `image`. Clicking an entry emits `inventory-activate` `{detail:{id}}` so the controller opens its action menu (the controller computes `inventoryActions`). Commit.

### Task 17: `<pnc-action-menu>`
- **Files:** `src/pnc/components/pnc-action-menu.ts`(+test). Prop `actions: { label: string; index: number }[]` + `x`/`y` placement; renders a popup of buttons; clicking emits `choose` `{detail:{index}}`; Escape/click-outside emits `dismiss`. Keep it dumb — the controller passes the labels and maps the chosen index back to an `ActionDescriptor`. Commit.

### Task 18: `<pnc-scene>`
- **Files:** `src/pnc/components/pnc-scene.ts`(+test). Prop `hotspots: Hotspot[]`, `roomImage?: string`. Places hotspots: exits/locked-doors by **compass bearing** on the perimeter (a `dir → {edge x%,y%}` map for all 8 bearings), occupants/loot/items as markers in the body (deterministic placement by index so positions are stable across renders); renders each hotspot's `image` when present else a kind-styled marker/silhouette; locked doors are dim and non-interactive. Clicking a hotspot emits `hotspot` `{detail:{key}}` (the controller decides: single-action exits go immediately, else open the action menu). Background uses `roomImage` when present else a procedural CSS scene. Test: given hotspots, the right markers render at the right edges/regions, locked doors carry no click action, image renders when present. Commit.

### Task 19: `<pnc-menu>` + `<pnc-map-overlay>`
- **Files:** `src/pnc/components/pnc-menu.ts`(+test), `src/pnc/components/pnc-map-overlay.ts`(+test). `pnc-menu`: a system overlay listing Save / Restore / Undo / Restart / Fullscreen / Back to menu, each emitting a `command` `{detail:{action}}`; dismissable. `pnc-map-overlay`: takes an `SVGElement` (from shared `renderMapSvg`), shows it in an overlay, dismiss on click/any key (own the window keydown listener; remove it on close + `disconnectedCallback` — copy `crt-game`'s leak-free pattern). Commit each (or together).

### Task 20: PnC controller + `pncSurface`

**Files:**
- Create: `packages/play-surface/src/pnc/controller.ts`(+test)
- Create: `packages/play-surface/src/pnc/surface.ts`(+test)
- Create: `packages/play-surface/src/pnc/index.ts`

**Interfaces:**
- Consumes: all PnC components, `affordances.ts`, `applyPncTheme`/`ensurePncTokens`, shared `Narrator`/`map-view`, `MapModel`, `AudioRuntime`, `GameSession`, `MountArgs`.
- Produces: `mountPointAndClick(root, session, meta): SurfaceHandle`; `pncSurface: PlaySurface` (`id:"point-and-click"`, `label:"Point & Click"`, `description:"Point-and-click scene"`, `defaultTheme: defaultPncTheme`, `mount`).

- [ ] **Step 1: Write the failing controller test** (happy-dom, stub session/audio like the CRT `controller.test.ts` + a `deepQuery`): mounting builds the scene/sidebar/topbar; `enter` reveals the scene and prints the opening room to the log; clicking a hotspot with multiple verbs opens `<pnc-action-menu>`, choosing "Attack" calls `session.execute` with `{kind:"attack",targetId}` and appends narration; an exit hotspot moves immediately; the ↩ menu's "Undo" calls `session.undo()`; `finished` ends + disables interaction; `unmount` disposes audio and clears `root`.

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement the controller.** Build `pnc-welcome` + the scene/sidebar/topbar layout; `ensurePncTokens`; `applyPncTheme(root, themes.find(initialThemeId) ?? themes[0])`. Reuse the **cue-handling order from the CRT `controller.ts`** (`absorbStatusCues`, split resolution vs step cues, `audio.playCue`, mob attacks, resolution, `refresh`, `finished` → end) but route output to `pnc-log.print(...)` and feed components instead of a transcript. Action routing: a `hotspot`/`inventory-activate` → look up the entity's `ActionDescriptor[]`; if one action and it's a move → execute immediately; else open `<pnc-action-menu>` with the labels; on `choose` → if `kind:"intent"` → `session.execute`; if `kind:"examine"` → `session.read(targetId)` (cues) else `Narrator.renderExamine` → log. `refresh()`: `sceneHotspots(vm)` → scene, `pnc-status.fields = latestStatus`, inventory from `vm.inventory`, `audio.update(session.campaign)`, `mapModel.observe(vm)`. `theme-change` → `applyPncTheme` + `meta.onThemeChange?.(id)`. Map → `pnc-map-overlay` with `renderMapSvg(layoutMap(mapModel))`. Menu commands → `session.save/restore/undo/restart`, fullscreen, `meta.onExit()`. `surface.ts` wraps it as `pncSurface`.

- [ ] **Step 4: Run — PASS.** `pnpm checks` green. Commit `feat(play-surface/pnc): controller + pncSurface`.

### Task 21: Register the PnC surface in the shell

**Files:**
- Modify: `packages/play/src/main.ts`

- [ ] **Step 1:** Import `pncSurface` from `@wickedways/play-surface/pnc`; add it to the `surfaces` array passed to `bootLauncher` (`surfaces: [crtSurface, pncSurface]`). `pnpm checks` green. Commit.

### Task 22: Add the PnC surface choice to Hollow House

**Files:**
- Create: `packages/campaigns/src/hollow-house/pnc-themes.ts`
- Modify: `packages/campaigns/src/hollow-house/manifest.ts`

- [ ] **Step 1:** Create `pnc-themes.ts`: `import type { PncTheme } from "@wickedways/play-surface/pnc"` + `defaultPncTheme`; export `hollowHousePncThemes: PncTheme[] = [defaultPncTheme, hauntedPncTheme]` where `hauntedPncTheme` is a darker/eerier param set (no assets). 
- [ ] **Step 2:** In `manifest.ts`, extend `surfaces` to:
```ts
surfaces: [
  { id: "crt-terminal", themes: hollowHouseThemes },
  { id: "point-and-click", themes: hollowHousePncThemes },
],
```
- [ ] **Step 3:** `pnpm checks` green (now the picker shows for Hollow House). Commit `feat(campaigns): offer Hollow House on the point-and-click surface`.

---

## Phase 4 — e2e + docs

### Task 23: e2e — pick point-and-click and win Hollow House by clicking

**Files:**
- Modify: `packages/play/e2e/playthrough.spec.ts`

- [ ] **Step 1:** Add tests: (a) deep-link `?campaign=hollow-house` → the `<surface-picker>` lists both surfaces; pick "Point & Click" → the scene mounts (`?surface=point-and-click` set). (b) Play the winning path by clicking hotspots/inventory + action menus (the same sequence as the CRT win: open chest, take journal/poker/lantern, equip, attack revenant ×N, take key, go …) and assert "— THE END —" / the win state in `pnc-log`. (c) `?surface=point-and-click&theme=haunted` deep-link applies the haunted PnC theme and persists across reload. (d) Back-to-menu from the scene returns to the campaign menu. Run `pnpm --filter @wickedways/play test:e2e` — green. Commit.

### Task 24: Docs

**Files:**
- Modify: root `README.md`, `packages/play/README.md`

- [ ] **Step 1:** Document the consolidated `@wickedways/play-surface` package (subpath exports `crt`/`pnc`, shared module), the manifest `surfaces`/per-surface themes, the surface picker + `?surface=`/`?theme=`, and the point-and-click surface (component tree, affordance model, `presentation.image` support with deferred art). Note theming is unchanged in mechanism (custom properties). Replace stale `@wickedways/play-surface-crt` references. `pnpm checks` green. Commit `docs: point-and-click surface + surface picker`.

---

## Self-Review notes

- **Save portability** (spec "Testing"): covered by Task 9's shared map blob staying surface-agnostic (no per-surface save data introduced) + the existing CRT save/restore; if a dedicated cross-surface restore test is wanted, add it to Task 23's e2e (save on CRT via `?surface=crt-terminal`, restore after switching) — optional, low-risk.
- **`pnc-status` fractional bar**: only when `value` matches `n/m` (Task 15) — matches the spec's "unless the campaign already formats the value as n/m".
- Phases are independently green: Phase 1 (refactor), Phase 2 (picker-ready + CRT theme persists), Phase 3 (the surface), Phase 4 (e2e/docs).
