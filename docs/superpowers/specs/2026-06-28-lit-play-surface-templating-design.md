# Lit-Based Play Surface Templating

**Status:** Design approved, ready for implementation plan
**Date:** 2026-06-28

## Goal

Replace the imperative DOM construction in the browser play layer with a **declarative,
component-based view** authored in [Lit](https://lit.dev). Today the CRT surface is one ~955-line
`ui.ts` that does `root.innerHTML = "..."` once at mount and then hunts refs with `querySelector`
and mutates them imperatively per turn; the launcher menu chrome is hand-built the same way. The
result is hard to author, hard to read, and unscoped (one global CSS blob).

The goal is a **friendlier surface-authoring experience**: small, encapsulated components with
scoped styles, reactive properties for readouts, and a clean data-down / events-up boundary — while
leaving the engine and every existing contract untouched.

This is a **surface-internals refactor**, not a campaign-facing feature. It does, however, choose
Lit's web-component model deliberately so a *campaign-authored layout* story can be built on top
later (explicitly out of scope here).

## Decisions (locked during brainstorming)

- **Lit (components + `html\`\``)**, ~5KB, no build/compile step (plain Vite + TS), TypeScript-first.
- Confined to **`packages/play*`**. The engine (`src/lib`, `wickedways`) and `@wickedways/seed`
  take **zero** new deps and stay pure / node-only.
- **Full sweep:** convert the CRT surface (`play-surface-crt`) **and** the launcher/menu chrome
  (`play-runtime`).
- **Presentational components + plain controller.** A controller owns all behavior (session, turn
  loop, parser, audio, cues). Components are dumb: data flows **down** as reactive properties,
  intent flows **up** as `CustomEvent`s. No component imports `GameSession`/engine types.
- **Why Lit and not a virtual-DOM framework:** the surface has retained, imperatively-animated DOM
  (the typewriter mutating the newest line, the append-only transcript, the focused `<input>`).
  vdom diffing (React/Preact) fights that; Lit's template-based rendering with retained DOM and an
  imperative escape hatch cooperates with "this node is mine."

## Background: current state

(Confirmed by code exploration; see the swappable-campaigns design,
`2026-06-27-swappable-campaigns-design.md`, for the surrounding architecture.)

- `packages/play-runtime` — surface-independent runtime + all contracts (`PlaySurface`,
  `MountArgs`, `Theme`, `CampaignManifest`, cues, audio). `bootLauncher` builds the campaign menu
  chrome by hand.
- `packages/play-surface-crt` — the CRT terminal `PlaySurface`. `surface.ts` is a thin adapter
  delegating to `ui.ts`'s `mountTerminal()` (~955 lines): welcome screen, monitor housing/bezel,
  `#transcript` (append-only, typewriter on newest line, clickable nouns), `#hud` (Here/Carrying/
  Exits from the `ViewModel`), `#status` (campaign status fields from `StatusCue`), `#prompt-form`,
  and pure-CSS artifact overlays (scanlines/vignette/sweep). Theming is `CrtTheme`
  (palette/fonts/effects) applied as `--crt-*` CSS custom properties via `applyTheme()`.
- **No templating exists today** — all DOM is imperative TS.

## Architecture & component tree

A plain **controller** keeps all behavior; Lit is purely the view. Data flows **down** as reactive
properties; intent flows **up** as DOM `CustomEvent`s.

### CRT surface (`play-surface-crt`)

- **`TerminalController`** *(plain class, replaces `mountTerminal`)* — owns `session`, `Narrator`,
  the parser, `AudioRuntime`, `latestStatus`, the turn loop, and cue handling. Constructs the
  components, wires their events, pushes props after each turn. `PlaySurface.mount()` instantiates
  it; the returned `SurfaceHandle.unmount()` removes the host element.
- **`<crt-housing>`** — bezel + glass + the pure-CSS artifact overlays; slots for screen content and
  bezel controls. Mostly static.
- **`<crt-welcome>`** — title / intro / Enter button.
- **`<crt-bezel>`** — power LED, brand, audio toggle, soundpack `<select>`, theme `<select>`,
  back-to-menu. Switchers auto-hide with <2 options.
- **`<crt-transcript>`** — append-only log; **imperative API** (the one animated/growing region);
  owns the typewriter interval and clickable-noun delegation; tears down in `disconnectedCallback`.
- **`<crt-hud>`** — reactive `vm` property → Here / Carrying / Exits.
- **`<crt-status>`** — reactive `fields` property → campaign status readout with `emphasis`.
- **`<crt-prompt>`** — input form → emits the typed line.

### Launcher (`play-runtime`)

- **`<campaign-menu>`** — lists campaigns (`title`+`blurb`), keyboard + click select. `bootLauncher`
  constructs it instead of building chrome by hand.

**Rationale:** the controller stays node-testable (no DOM needed for game logic); each component is
small, encapsulated, and independently testable; the `PlaySurface`/`MountArgs` contract is
unchanged.

## Component contracts

Notation: **props** = reactive inputs (set by the controller); **events** = `CustomEvent`s fired up;
**methods** = imperative public API the controller calls. Components consume plain view DTOs only —
never `GameSession`/engine types.

### `<crt-welcome>`
- props: `title: string`, `intro: string`, `buttonText?: string`
- events: `enter` → controller starts the session / turn loop

### `<crt-bezel>`
- props: `audioEnabled: boolean`, `soundpacks: {id,label}[]`, `activeSoundpack: string`,
  `themes: Theme[]`, `activeTheme: string`
- events: `toggle-audio`, `soundpack-change` (`detail: {id}`), `theme-change` (`detail: {id}`),
  `exit`
- behavior: soundpack/theme `<select>`s render only when `.length >= 2` (auto-hide, as today)

### `<crt-hud>`
- props: `vm: ViewModel` (uses `loot`, `inventory`, `exits`)
- pure reactive render of Here / Carrying / Exits; no events

### `<crt-status>`
- props: `fields: readonly StatusField[]` (`{label, value, emphasis?: "normal"|"warn"|"critical"}`)
- empty/neutral before the first `StatusCue`; `emphasis` maps to theme palette
  (`critical → var(--crt-critical)`, `warn → var(--crt-warn)`, `normal → var(--crt-fg)`)

### `<crt-prompt>`
- props: `disabled: boolean` (true when `vm.finished`)
- events: `command` (`detail: {line: string}`)
- methods: `focus()`, `clear()` — controller calls after each submit

### `<crt-transcript>` — imperative API (append-only + animated, *not* a reactive render)
- methods: `print(lines: TranscriptLine[])` (instant), `type(line: TranscriptLine)` (typewriter on
  the newest line), `clear()`
- `TranscriptLine = { text: string; kind: "narrator" | "echo" | "cue" | "mob"; nouns?: NounSpan[] }`
  — `nouns` carry the clickable-noun ranges (from `link-nouns`)
- events: `noun` (`detail: {alias: string}`) → controller turns a clicked noun into input
- owns: the typewriter interval + click delegation; both torn down in `disconnectedCallback`

### `<campaign-menu>` (play-runtime)
- props: `campaigns: {slug,title,blurb}[]`
- events: `select` (`detail: {slug}`); handles arrow-key + click selection internally

### Reactivity & the typewriter (the one subtlety)

Lit's `render()` owns the DOM it produces, so the **growing/animated transcript is kept out of the
reactive template**. `<crt-transcript>` renders a single stable scroll container once, then
`print`/`type` **append child nodes imperatively** into it — Lit never re-renders over them, so the
typewriter mutating the newest line and the focused `<input>` are never clobbered. Everything else
(`<crt-hud>`, `<crt-status>`, `<crt-bezel>`) *is* a normal reactive `render()` off its props.

Per turn the controller does:
`session.execute(intent)` → `transcript.type(...)`/`print(...)` for narration+cues →
`hud.vm = view; status.fields = latestStatus; prompt.disabled = view.finished` → `prompt.focus()`.

## Theming, styling & shadow DOM

The existing theme mechanism survives unchanged and gets cleaner:

- **Shadow-DOM scoped styles, custom-property theming.** Each component declares scoped CSS via
  `static styles = css\`...\``, referencing the theme through `var(--crt-*)`. CSS custom properties
  inherit *through* shadow boundaries, so `applyTheme(host, theme)` keeps doing one thing — setting
  `--crt-bg`, `--crt-fg`, `--crt-accent`, `--crt-warn`, `--crt-critical`, `--crt-font-body`,
  `--crt-font-display`, `--crt-scanline`, `--crt-glow`, `--crt-flicker` on the host root. Every
  component restyles automatically. **`CrtTheme`, `applyTheme`, and the `manifest.themes` contract
  are untouched.**
- **Live theme switch needs no re-render.** Components read look-and-feel from custom properties,
  not bound props, so a `theme-change` event → `applyTheme(host, next)` recolors the whole tree
  instantly — no property assignment, no `render()` pass.
- **Fonts work across the shadow boundary.** `@fontsource/*` registers `@font-face` at the document
  level (side-effect import in the shell); `@font-face` is global and `font-family` inherits, so
  components use `var(--crt-font-body)`. No change to font loading.
- **CRT artifacts.** The scanline/vignette/sweep overlays move into `<crt-housing>`'s scoped styles,
  driven by `--crt-scanline` / `--crt-glow` / `--crt-flicker` (from `CrtTheme.effects`). The
  monolith's CSS stops being one global blob and gets distributed to the component that owns each
  piece, with no leakage between regions.

## Packaging & dependencies

- Add `lit` (^3) as a runtime dep of **`play-runtime`** (for `<campaign-menu>`) and
  **`play-surface-crt`** (for the CRT components). Confined to the `packages/play*` layer.
- Engine (`src/lib`, `wickedways`) and `@wickedways/seed` get **zero** new deps.
- No new shared base package; any trivial shared bit (e.g. a CSS reset) lives in `play-runtime`.
  YAGNI until it exists.

## Testing

- `vitest.config.ts` stays globally `environment: "node"`. **Component test files** opt into
  `happy-dom` via a per-file `// @vitest-environment happy-dom` docblock (add `happy-dom` as a
  devDep). Lit renders fine under happy-dom.
- **Pure logic stays node-tested:** `parser`, `narrator`, `link-nouns`, `intent`, `viewmodel`,
  `map-model`, audio mapping, **and `TerminalController`** (a plain class — test the turn loop with
  stub components). Only actual custom-element tests need happy-dom.
- **Playwright e2e is the real backstop:** the winning Hollow-House deep-link playthrough +
  menu-nav + theme-switch smokes stay green throughout and validate the genuine rendered DOM.

### New / moved tests

- Component tests (happy-dom): `<crt-status>` renders fields with correct `emphasis`; `<crt-hud>`
  renders Here/Carrying/Exits off a `ViewModel`; `<crt-bezel>` hides switchers with <2 options and
  emits the right events; `<crt-prompt>` emits `command` and clears/focuses; `<crt-transcript>`
  `print`/`type` append lines, the typewriter completes, `noun` click emits, teardown clears the
  interval; `<campaign-menu>` emits `select` on click + keyboard.
- `TerminalController` test (node, stub components): a turn drives `execute` → transcript/hud/status
  updates → prompt focus; `finished` disables the prompt; `unmount` tears down.
- Existing pure-logic tests are unaffected and stay node.

## Migration — incremental, `pnpm checks` green at every step

1. **Add deps + harness.** `lit` to both packages, `happy-dom` devDep; prove a trivial
   `<crt-status>` renders in a component test.
2. **Carve the controller.** Extract `TerminalController` from `mountTerminal` with components still
   stubbed by today's imperative DOM — establishes the data-down/events-up seam without visual
   change.
3. **Convert region-by-region**, deleting the matching imperative block as each lands:
   `<crt-status>` → `<crt-hud>` → `<crt-bezel>` → `<crt-prompt>` → `<crt-transcript>` (last; the
   typewriter/noun logic is the subtlest) → `<crt-welcome>` → `<crt-housing>`. `ui.ts` shrinks to
   the controller as regions migrate.
4. **Launcher chrome.** Convert `bootLauncher`'s hand-built menu to `<campaign-menu>` in
   `play-runtime`.
5. **Docs.** Update root `README.md` and `packages/play/README.md`: the component tree, the
   controller/components boundary, the Lit dependency and *why* (template-based, retained-DOM-
   friendly), and that theming / `CrtTheme` are unchanged.

## Contract impact: none

`PlaySurface`, `MountArgs`, `SurfaceHandle`, `CampaignManifest`, `CrtTheme`, and the cue/audio
contracts are all unchanged. `mount()` internally builds Lit components; `unmount()` removes the
host, and `disconnectedCallback` gives cleaner teardown than today's manual interval/listener
removal. **No engine changes.**

## Out of scope

- Campaign-authored layout (non-engineers shaping markup). Lit's web-component model *enables* it
  later, but this pass keeps components engineer-authored; no campaign-facing template API.
- A second `PlaySurface` implementation; the `scored` soundpack / `SampleRenderer`.
- Reactive state libraries / signals beyond Lit's built-in reactive properties.
- Any engine change — there are none.
