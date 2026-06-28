# Point-and-Click Play Surface for Hollow House

**Status:** Design approved, ready for implementation plan
**Date:** 2026-06-28

## Goal

Add a second, **point-and-click** `PlaySurface` for the Hollow House campaign: a visual room
scene where the player clicks exits, objects, loot, and mobs (via contextual verb menus) instead
of typing commands. Players **choose** between the existing CRT terminal and the new surface at
launch (the deferred surface-picker becomes real). The engine is untouched; the surface reuses the
runtime exactly as the CRT surface does.

## Background: current state

- A `PlaySurface` is `{ id, label, defaultTheme, mount(args) }`; the launcher hands a surface
  `{ app, session, manifest, themes, audio, onExit }`. The surface owns input→intent, the turn
  loop, rendering, and its control UI. The runtime owns the session, view models, cues, audio,
  save store.
- The CRT terminal (`@wickedways/play-surface-crt`) is the only surface today, built as Lit
  components + a controller (`mountTerminal`). `manifest.surface?: string` (default `crt-terminal`)
  designates one surface; `manifest.themes?: Theme[]` are passed to it; the surface-picker was
  explicitly deferred (`PlaySurface.label` exists "for future surface-picker UI").
- **Every game action is single-target or zero-noun** (`take`/`drop`/`attack`/`equip`/`unequip`/
  `use`/`open` take one noun; `go <dir>`, `look`, `inventory` take none). There is no two-noun
  targeting. Directions are the **8 compass bearings** (N/S/E/W + diagonals) — no up/down.
- The engine already exposes `presentation { image?, sound? }` on items, rooms, and characters
  (`AssetRef` = "image shown when the entity is rendered on the Play Surface"). `sound` is
  pre-resolved by the engine into cue audio. **No images are authored in Hollow House today**, and
  the `ViewModel` does not yet surface `image`.

## Architecture & packaging

**Consolidate into one package `@wickedways/play-surface`** with each surface a subpath export,
mirroring `@wickedways/campaigns`:

```jsonc
// packages/play-surface/package.json
"exports": { "./*": "./src/*/index.ts" }
```
→ `@wickedways/play-surface/crt` (`src/crt/index.ts`) and `@wickedways/play-surface/pnc`
(`src/pnc/index.ts`).

- `src/crt/` — today's CRT surface (components, controller, `surface.ts`, `parser`, `link-nouns`,
  `theme`/`CrtTheme`). `index.ts` exports `crtSurface`, `CrtTheme`, `applyTheme`, and re-exports
  `parse`/`Narrator` (the `@wickedways/campaigns` capstone/laudanum tests import those — they
  repoint `@wickedways/play-surface-crt` → `@wickedways/play-surface/crt`).
- `src/pnc/` — the new point-and-click surface. `index.ts` exports `pncSurface`, `PncTheme`,
  `applyPncTheme`.
- `src/shared/` — surface-agnostic presentation reused by both: **`Narrator`** (action/cue/examine/
  mob/room text) and **`map-view`** (`layoutMap`/`renderMapSvg`). Internal; imported relatively and
  re-exported through the surface barrels where external code needs them. No churn to `play-runtime`.

CRT-only stays in `src/crt/`: the parser, `link-nouns`, the CRT components, `CrtTheme`. The PnC
surface builds `Intent`s **directly** from menu clicks (a small `src/pnc/affordances.ts`), so it
does not need the parser.

**Dependency direction (acyclic):**
```
play-surface (crt, pnc) ──▶ play-runtime ──▶ wickedways (engine)
campaigns/hollow-house ─ import type ─▶ play-runtime + play-surface/{crt,pnc} (theme shapes)
shell (play) ──▶ play-runtime, play-surface/{crt,pnc}, campaigns
```
Engine and `@wickedways/seed` untouched. The consolidation is mostly mechanical moves of existing
CRT code into `src/crt/` + `src/shared/`, with importers repointed.

## The point-and-click surface (`src/pnc/`)

Same logic/view split and Lit conventions as the CRT surface (no-decorator components, open shadow
roots, `composed` events, controller owns behavior). `mountPointAndClick(...)` returns a
`SurfaceHandle`.

### Layout

Single fixed layout (no layout toggle): a slim **top bar** (room name left, control cluster right),
a large **room scene** on the left, and a **right sidebar** stacking status, inventory, and a
scrolling narration log.

### Component tree

- **`<pnc-welcome>`** — title / intro / Enter (parity with CRT), then reveals the scene.
- **`<pnc-topbar>`** — room name + control cluster: audio toggle, theme `<select>`, soundpack
  `<select>` (auto-hide <2), 🗺 Map, ↩ Menu. Emits `toggle-audio` / `theme-change` /
  `soundpack-change` / `open-map` / `open-menu`.
- **`<pnc-scene>`** — the procedural room. Places hotspots from the `ViewModel`: **passable exits**
  on the 8 compass-bearing edges, **loot/items/mobs** as placed markers in the body, **locked
  doors** as dim, labeled, informational edge markers. Renders an entity's/room's
  `presentation.image` when present (see Image hook), procedural marker/background otherwise.
  Clicking a hotspot opens its action menu; exits (single-verb) `go` immediately.
- **`<pnc-action-menu>`** — contextual verb popup near the clicked hotspot; lists only that
  entity's valid verbs; a click emits `action`.
- **`<pnc-sidebar>`** composing:
  - **`<pnc-status>`** — the cue-driven `StatusField`s (Sanity, …) as readouts with `emphasis`
    coloring (optional fractional bar only when a value already reads `"n/m"`). Faithful to the
    campaign-defined/surface-renders model — not a hardcoded stat.
  - **`<pnc-inventory>`** — items + keys with `(equipped)` tags; each opens its own action menu
    (Examine / Equip·Unequip / Use / Drop).
  - **`<pnc-log>`** — append-only scrolling narration log (action results, cues, mob attacks,
    examine lore, room descriptions on entry). Plain text, instant; no typewriter, no clickable
    nouns (the scene is the click target).
- **`<pnc-menu>`** (overlay from ↩) — the system/meta actions that have no typed command in PnC:
  **Save · Restore · Undo · Restart · Fullscreen · Back to menu**.
- **`<pnc-map-overlay>`** — reuses the shared `renderMapSvg`; dismissed by click/key.

### Affordance map (`src/pnc/affordances.ts`)

A pure function of the `ViewModel`: for each hotspot/inventory entity, return its valid verbs as
**action descriptors**. Each descriptor is either an engine **`Intent`**
(`take`/`drop`/`attack`/`equip`/`unequip`/`use`/`open`/`move`) → `session.execute`, or the
**examine flow** (lore via `session.read`, else `Narrator.renderExamine`). Verb sets by kind/state:

- Passable exit → `Go` (`{kind:"move", dir}`), executed immediately on click.
- Locked door → informational only (no key targeting). Unlocking stays single-noun: using the
  matching **key** from the inventory (`{kind:"use", targetId}`) unlocks it.
- Occupant/mob → Examine, Attack.
- Loot → Examine, Open.
- Room item → Examine, Take.
- Inventory item → Examine, Equip (or Unequip if equipped), Use, Drop.

### Controller turn loop

Reuses the CRT controller's proven cue handling: on `action` → execute (or examine) → split
resolution vs step cues, `audio.playCue`, mob attacks, append narration to the log, `refresh()`
(scene/status/inventory + `audio.update` + `mapModel.observe`); on `move` → `mapModel.recordMove` +
re-render the scene for the new room; on `finished` → end state. The ↩ menu routes
save/restore/undo/restart/fullscreen/back. `unmount()` disposes audio and clears; components
self-teardown via `disconnectedCallback`.

### Image hook (support, defer art)

`presentation.image` is a designed Play-Surface affordance. **In scope:** an *additive* mapping in
`packages/play-runtime/src/viewmodel.ts` surfaces `image?: AssetRef` onto `ScopeEntity` and the room
view from `entity.presentation?.image` / `room.presentation?.image` (the engine already exposes
`.presentation`; this is not an engine change). The PnC scene renders the image when present (as a
direct URL/path), procedural fallback otherwise. The CRT surface ignores the new field (additive).
`presentation.sound` needs nothing new — it already flows through the cue/audio path.
**Out of scope:** authoring artwork for Hollow House, and any asset-bundling/key-resolution pipeline
beyond treating `AssetRef` as a URL/path. Hollow House renders fully procedural in this project; any
campaign that sets `presentation.image` lights up immediately.

## Surface-picker infrastructure

**1. Manifest: surfaces become a list with per-surface themes.** Replace singular
`surface?`/`themes?` with:
```ts
interface SurfaceChoice { id: string; themes?: readonly Theme[] }  // themes are that surface's shape
interface CampaignManifest {
  // …
  surfaces?: readonly SurfaceChoice[];  // ordered; [0] is default. Omit → [{ id: shell default = "crt-terminal" }]
}
```
Hollow House lists `[{ id:"crt-terminal", themes:[crtDefault, crtHaunted] }, { id:"point-and-click",
themes:[pncDefault, pncHaunted] }]`. Seed omits `surfaces` → one default CRT surface, picker
skipped. Themes stay correctly typed per surface (a `CrtTheme` never reaches the PnC surface).

**2. Launcher flow.** `bootLauncher` already receives the registered `surfaces: PlaySurface[]`:
- Campaign menu → select a campaign (unchanged `<campaign-menu>`).
- If that campaign's `surfaces.length >= 2` → show the **surface picker**; on pick, resolve the
  surface, take that choice's `themes ?? [surface.defaultTheme]`, build the `AudioRuntime`, start the
  session, `surface.mount(...)`.
- `length < 2` → skip the picker, mount the sole surface (today's path).
- **Deep-links:** `?campaign=hollow-house&surface=point-and-click` boots straight onto that surface;
  `?campaign=…` alone with ≥2 surfaces shows the picker; picking sets `?surface=<id>` (history).
- **Back navigation:** the picker's "back" returns to the campaign menu; `onExit` from a running
  surface returns to the campaign menu and clears `?campaign=`/`?surface=`/`?theme=`.

**3. `<surface-picker>` component** (`play-runtime/src/components/`, mirrors `<campaign-menu>`):
prop `surfaces: {id,label,description?}[]`, emits `select {id}`, click + Arrow/Enter, self-contained
surface-independent styles. Add an optional **`description?: string`** to the `PlaySurface` contract
(CRT: "Typed retro terminal"; PnC: "Point-and-click scene"); the picker falls back to `label`.

## Theming (`PncTheme`) & persistence

The PnC surface defines its own theme shape, parallel to `CrtTheme`:
```ts
interface PncTheme extends Theme {
  palette: { bg: string; panel: string; ink: string; accent: string; warn: string; critical: string; hotspot: string };
  fonts:   { body: string; display: string };
  scene:   { vignette: number; grain: number; fog?: number };   // atmospheric params, no assets
}
```
`applyPncTheme(root, theme)` writes `--pnc-*` CSS custom properties on the app root (mirrors
`applyTheme`/`--crt-*`); components read them via `var()`, inherited through shadow boundaries; the
🎨 switcher renders from `themes` and auto-hides with <2. A small token module seeds the `--pnc-*`
defaults (mirrors the CRT `styles.ts`). Hollow House ships `pncDefault` (neutral) and `pncHaunted`
(darker, eerie display font, heavier fog/grain, red criticals) — parameter sets, no art.

**Theme persists across reload via the URL.** Two small optional `MountArgs` additions:
`initialThemeId?: string` (read from `?theme=` on boot — the surface applies
`themes.find(id === initialThemeId) ?? themes[0]`) and `onThemeChange?(id: string): void` (the
surface fires it on a switch; the launcher writes `?theme=<id>`). The **CRT surface adopts these too**,
so its theme also survives reload. Theme ids are surface-scoped: a stale id under a different
`?surface=` falls back to that surface's default.

## Save state (decided)

The chosen **surface and theme are NOT serialized into the save state.** The save is engine/campaign
state plus a **surface-agnostic** extension blob (the shared `MapModel`). Restore loads campaign
state into the *currently-mounted* surface; the surface is chosen at launch (picker + `?surface=`)
and the theme lives in `?theme=`. The only requirement: both surfaces read/write the **same shared
map blob**, so a save made on one surface restores cleanly on the other. (If genuinely
surface-specific save data is ever needed, tag it by surface id and have surfaces ignore a foreign
blob — not needed now.)

## Implementation phases

Each keeps `pnpm checks` + e2e green; the refactor lands before the new surface.

1. **Consolidate the package.** Rename `play-surface-crt` → `@wickedways/play-surface`; move CRT code
   to `src/crt/`, extract `Narrator` + `map-view` to `src/shared/`; add the subpath `exports`;
   repoint importers (shell `main.ts`, the `@wickedways/campaigns` capstone/laudanum tests). Pure
   mechanical refactor, behavior identical.
2. **Picker infrastructure.** Manifest `surfaces: SurfaceChoice[]` + per-surface themes;
   `MountArgs.initialThemeId`/`onThemeChange` + `PlaySurface.description`; launcher
   campaign→surface→mount flow with `?surface=`/`?theme=`; `<surface-picker>`. Migrate Hollow House
   (CRT choice + themes) and seed (omits). Still one real surface, but picker-ready, and CRT theme
   now survives reload — a self-contained shippable step.
3. **The point-and-click surface.** `src/pnc/`: `affordances.ts`, the components, the controller,
   `PncTheme`/`applyPncTheme` + tokens, the `ViewModel` `image?` mapping. Register `pncSurface` in
   the shell; Hollow House adds the `point-and-click` surface choice with `pncDefault`/`pncHaunted`.
4. **e2e + docs.** Playwright: pick point-and-click from the picker → win Hollow House via clicks;
   theme persists across reload; deep-link `?surface=`/`?theme=`; back-to-menu. Update root +
   `packages/play` READMEs.

## Testing

- **Affordance map** — pure-function unit tests (node): each entity kind/state → its exact verb set
  and `Intent`/examine descriptors; the critical-path winning verbs covered.
- **Components** — happy-dom shadow-DOM tests: scene places hotspots from a `ViewModel` (exits by
  compass bearing, loot/items/mobs, locked-doors informational) and renders `image` when present;
  action-menu lists only valid verbs and emits the right action; status renders cue fields with
  emphasis; inventory tags equipped + opens menus; log appends; map overlay opens/dismisses.
- **Controller** — node/happy-dom turn-loop test with stub session/audio: an action executes,
  cues/mob-attacks order correctly, refresh updates scene/status/inventory, `finished` ends, the ↩
  menu's save/restore/undo/restart route correctly.
- **Picker/launcher** — campaign with ≥2 surfaces shows the picker; pick mounts the right surface
  with its themes; `?surface=`/`?theme=` deep-links; back-to-menu; <2 surfaces skips the picker.
- **Save portability** — a save written on one surface restores cleanly on the other (shared map
  blob).
- **e2e** — the picker → point-and-click win playthrough, theme-persist-across-reload, deep-link.

## Out of scope

- Illustrated/painted backgrounds and any art **authoring** or asset-bundling/key-resolution
  pipeline (the surface *supports* `presentation.image` as a URL/path; it ships no art and renders
  procedurally for Hollow House).
- A layout toggle / second layout (single fixed layout).
- A third surface; new audio packs; the sample renderer.
- Cross-session persistence beyond the URL; surface-specific save data.
- A literal fractional sanity bar unless the campaign already formats the value as `n/m`.
- Engine changes (the `ViewModel` `image?` mapping lives in `play-runtime`, not the engine).
