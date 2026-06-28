# Lit-Based Play Surface Templating — Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development (fresh subagent per task, review between) or superpowers:executing-plans. Steps are TDD: write the failing test, watch it fail, implement, watch it pass, commit. Run `pnpm checks` before declaring any task done.

**Goal:** Replace the imperative DOM construction in the browser play layer with declarative, shadow-DOM Lit components driven by a plain controller — making the CRT surface and launcher chrome easier to author and maintain, with zero change to the engine or any public contract.

**Architecture:** A plain `TerminalController` owns all behavior (session, parse, turn loop, narrator, audio, map, cues). Lit components are presentational: data flows **down** via reactive properties / imperative methods, intent flows **up** via `composed, bubbles` `CustomEvent`s. Each component is an open-shadow-root `LitElement`; theming continues to ride on inherited CSS custom properties.

**Tech Stack:** TypeScript (strict, NodeNext), Lit 3 (no-decorator API), Vite, Vitest (`happy-dom` per-file docblock for component tests; `node` default), Playwright (e2e).

## Context

`packages/play-surface-crt/src/ui.ts` is a single ~955-line `mountTerminal()` that does `root.innerHTML = "…"` once, hunts refs with `querySelector`, and mutates them imperatively per turn. It also embeds ~370 lines of interdependent CSS and owns map/help overlays, restart-confirm, command history, fullscreen, save/restore/undo, the typewriter, clickable nouns, and reduced-motion handling. `packages/play-runtime/src/launcher.ts` hand-builds the campaign menu the same way. This is hard to author and unscoped. The approved spec (`docs/superpowers/specs/2026-06-28-lit-play-surface-templating-design.md`) chose **Lit components with shadow-DOM scoped styles** to fix this; the user confirmed shadow DOM for this first pass.

## Global Constraints

- **Lit 3, no-decorator API only.** Use `static properties = {…}`, `static styles = css\`…\``, and `customElements.define("tag", Class)`. Do **not** use `@customElement`/`@property` decorators (avoids tsconfig/decorator churn). Add a `declare global { interface HTMLElementTagNameMap { "tag": Class } }` block per component module so `document.createElement` is typed.
- **All custom-event names cross shadow boundaries:** dispatch with `{ bubbles: true, composed: true }`.
- **Open shadow roots only** (Lit default). Required so Playwright's selectors keep piercing.
- **Preserve these e2e hooks exactly** (do not rename): the input keeps `id="cmd"`; the transcript scroll container keeps `id="transcript"`; the HUD host keeps `id="hud"`; HUD exit links keep class `exit-link`; clickable nouns keep class `noun`; the welcome button text stays the campaign's `buttonText` (e.g. `"Enter Hollow House"`, role=button); the end-of-game line text stays `"— THE END —"`.
- **Engine untouched.** No edits under `src/lib/` or `wickedways`. `@wickedways/seed` unchanged.
- **Contracts unchanged:** `PlaySurface`, `MountArgs`, `SurfaceHandle`, `CampaignManifest`, `CrtTheme`, `applyTheme`, cue/audio contracts. `applyTheme(appRoot, theme)` keeps writing `--crt-*` to the app root; components read them through the shadow boundary (custom properties inherit).
- **Behavior parity:** every behavior in today's `ui.ts` must survive (see task list). `pnpm checks` and the Playwright e2e stay green at every commit.
- **Reuse, don't reinvent:** keep calling the existing `parse`, `Narrator`, `linkNouns`, `MapModel`, `layoutMap`, `renderMapSvg`, `AudioRuntime`, `GameSession`, `applyTheme`, `defaultCrtTheme`. Only the DOM-construction layer changes.

## File Structure

```
packages/play-surface-crt/src/
  styles.ts            NEW  globalTokensCss + ensureGlobalTokens(doc) — the :root token block + body reset, injected once
  components/
    crt-housing.ts     NEW  monitor frame, screen well, CRT artifact overlays; slots: "screen", "bezel"
    crt-bezel.ts       NEW  brand/vents/led + audio toggle + soundpack/theme selects + back button
    crt-welcome.ts     NEW  title/intro/enter button
    crt-prompt.ts      NEW  command input + caret + arrow-key history; emits "command"
    crt-status.ts      NEW  location + StatusField readout
    crt-hud.ts         NEW  Here/Carrying/Exits; emits "fill-input"
    crt-transcript.ts  NEW  append-only log + typewriter + noun linking; emits "fill-input"
    crt-game.ts        NEW  composition root: lays out transcript/hud/status/prompt + map/help overlay; consolidated API to the controller
  controller.ts        NEW  TerminalController — today's mountTerminal logic minus DOM construction
  surface.ts           MOD  crtSurface.mount delegates to controller.ts
  ui.ts                DEL  fully migrated into controller.ts + components/
  *.test.ts (existing parser/narrator/link-nouns/map-view unchanged)
  surface.test.ts      MOD  traverse shadow DOM via a deep-query helper

packages/play-runtime/src/
  components/campaign-menu.ts  NEW  campaign picker; emits "select"
  launcher.ts                  MOD  showMenu() renders <campaign-menu>

packages/play-surface-crt/package.json  MOD  add "lit": "^3"
packages/play-runtime/package.json      MOD  add "lit": "^3"
```

`happy-dom` is already a devDependency (used by `surface.test.ts`'s `// @vitest-environment happy-dom` docblock) — no test-config change needed.

## CSS distribution map (where each block from `ui.ts` `applyStyles` goes)

- **`styles.ts` `globalTokensCss` (document-level, injected once):** the entire `:root { … }` custom-property block (both `--crt-*` defaults and the derived `--color-*`/`--font-*`/`--plastic*` aliases), `*,*::before,*::after{box-sizing}`, and `body{margin:0;background:#0a0a0c}`. These inherit into every shadow root.
- **`crt-housing` `static styles`:** `.backdrop`, `.monitor`, `.monitor-screen`, `.screen`, `.crt-overlay`, `.crt-sweep`, `@keyframes crt-flicker`, `@keyframes crt-sweep`, and the `@media (prefers-reduced-motion: reduce)` rules for `.crt-overlay`/`.crt-sweep`. Template wraps a `<slot name="screen">` inside `.screen` and a `<slot name="bezel">` inside `.monitor`.
- **`crt-bezel` `static styles`:** `.monitor-bezel-bottom`, `.monitor-brand`, `.monitor-vents`, `.monitor-led`, `.monitor-btn` (+ `svg`, `:hover/:active/:focus-visible`, the `[aria-pressed]` icon states), `.monitor-btn-text`, `.monitor-select` (+ `:focus-visible`). `:host { position:absolute; left:0; right:0; bottom:0; height:clamp(28px,5vmin,52px); display:flex; align-items:center; gap:14px; padding:0 clamp(22px,4vmin,48px) }` (the old `.monitor-bezel-bottom` positioning).
- **`crt-welcome` `static styles`:** `.welcome` (+ `[hidden]`), `.welcome-title`, `.welcome-intro`, `.enter-btn` (+ `:hover/:focus-visible/:active`), `@keyframes enter-bloom`, reduced-motion `.enter-btn`. `:host { position:absolute; inset:0; z-index:2 }`.
- **`crt-game` `static styles`:** `.game-container` layout, `.transcript`, `.block`, `.line` (+ `.echo/.error/.end`), `.room-name`, `.hud`* , `.status`* , `.prompt`/`.caret`/`#cmd`* , overlay (`.overlay`, `.overlay-frame`, `.overlay-legend`, `.help-list`, `.help-row`, all `.map-svg …` rules). `:host { display:flex; flex-direction:column; flex:1; min-height:0 }`.
  - *Move the region-specific rules into their owning leaf component instead* (`.hud*`→`crt-hud`, `.status*`→`crt-status`, `.prompt/.caret/#cmd`→`crt-prompt`, `.transcript/.block/.line/.room-name`→`crt-transcript`, `.noun`→both `crt-hud` and `crt-transcript`). `crt-game` keeps only the flex layout that arranges the host elements and the overlay styles.

## Component contracts (props **down**, events **up**, methods imperative)

- **`crt-status`** — props `location: string`, `fields: readonly StatusField[]`. Renders `location` then ` · label value` per field; `emphasis === "critical" → class status-critical`, `"warn" → status-warn`.
- **`crt-hud`** — host `id="hud"`; props `vm: ViewModel`, `clickableNouns: string[]`. Renders Here/Carrying/Exits (port `refresh()` lines 220–292). Loot/Carrying use `linkNouns` for `.noun` spans; exits render `.exit-link` (passable) / `.exit-locked`. Noun click and exit click dispatch `fill-input` `{detail:{value}}` (noun→`examine <noun>`, exit→`go <dir>`).
- **`crt-prompt`** — input `id="cmd"`; prop `disabled: boolean`; owns its own arrow-key history array. Methods: `setValue(v)`, `clear()`, `focusInput()`, `getValue()`. Submit dispatches `command` `{detail:{line}}` with the trimmed value and clears.
- **`crt-transcript`** — scroll container `id="transcript"`; prop `clickableNouns: string[]`. Methods: `print(lines: string[], cls?: string)`, `printRoom(parts: RoomParts)` (header instant `.room-name`, description typewriter unless `prefers-reduced-motion`, body instant — port lines 305–355), `flush()` (complete active typewriter), `clear()`. Owns the single active-typewriter interval; clears it in `disconnectedCallback`. Noun click dispatches `fill-input` `{detail:{value:"examine <noun>"}}`. `RoomParts` = `Narrator.renderRoomParts` return: `{ header: string; description: string | null; body: string[]; firstVisit: boolean }`.
- **`crt-bezel`** — props `audioEnabled: boolean`, `soundpacks: {id,label}[]`, `activeSoundpack: string`, `themes: {id,label}[]`, `activeTheme: string`. Soundpack/theme `<select>`s render only when `length >= 2`. Events: `toggle-audio`, `soundpack-change {id}`, `theme-change {id}`, `exit`. `aria-pressed`/title/icon reflect `audioEnabled`.
- **`crt-welcome`** — props `title`, `intro`, `buttonText?`. Button label = `buttonText ?? \`Enter ${title}\``. Click dispatches `enter`.
- **`crt-game`** — composition root; builds `crt-transcript`/`crt-hud`/`crt-status`/`crt-prompt` in its shadow + an overlay host. Getter `transcript` (the `crt-transcript`). Methods: `setHud(vm, nouns)`, `setStatus(location, fields)`, `setPromptDisabled(b)`, `focusInput()`, `openMap(svg: SVGElement)`, `openHelp(rows: string[])`, `closeOverlay()`, `clearTranscript()`. Internally listens for `fill-input` from hud/transcript → sets prompt value + focuses; re-exposes the prompt's `command` event (it already bubbles+composes, so the controller listens on the `crt-game` element). Owns the overlay’s window `keydown`-capture dismissal and removes it in `disconnectedCallback`.
- **`campaign-menu`** (play-runtime) — prop `campaigns: {slug,title,blurb}[]`. Renders one `.launcher-entry` button per campaign (`.launcher-title` + `.launcher-blurb`); supports click and Arrow/Enter keyboard selection. Dispatches `select {slug}`. Minimal own shadow styles (today the menu is unstyled, so any reasonable styling is net-additive).

## Tasks (dependency order; each ends green + a commit)

1. **Add Lit + smoke test.** Add `"lit": "^3"` to both `package.json`s; `pnpm install`. Write a throwaway component test that defines a trivial `LitElement` (no-decorator) and asserts it renders into `document.body` under `// @vitest-environment happy-dom`. Confirms Lit + happy-dom work. Commit.
2. **`styles.ts`.** Extract the `:root` token block + reset into `globalTokensCss` and `ensureGlobalTokens(doc = document)` (idempotent via a guard `<style id="crt-global-tokens">`). Unit-test idempotency (two calls → one style element). Commit.
3. **`crt-status`** (TDD: render location+fields, emphasis classes). Commit.
4. **`crt-prompt`** (TDD: submit emits `command` trimmed + clears; arrow keys recall history; `disabled` reflected). Commit.
5. **`crt-hud`** (TDD: Here omitted when no loot; Carrying shows equipped tag + "nothing"; exits link vs locked; noun/exit click → `fill-input`). Reuse `linkNouns`. Commit.
6. **`crt-transcript`** (TDD with `vi.useFakeTimers()`: `print` appends `.block`/`.line` with cls; `printRoom` types description over intervals, `flush` completes immediately, reduced-motion renders instantly; noun click → `fill-input`; `clear` empties; `disconnectedCallback` clears the interval). Commit.
7. **`crt-bezel`** (TDD: selects hidden with <2; each control fires its event; `aria-pressed` tracks `audioEnabled`). Commit.
8. **`crt-welcome`** (TDD: renders title/intro/button text; click emits `enter`). Commit.
9. **`crt-housing`** (TDD: renders the frame; projects `slot="screen"` and `slot="bezel"`; carries the artifact-overlay + reduced-motion styles). Commit.
10. **`crt-game`** (TDD in happy-dom: composes the four regions; `setHud`/`setStatus`/`setPromptDisabled` forward; `openMap`/`openHelp` show the overlay and a window keydown closes it; `fill-input` from a child sets the prompt; `command` bubbles out of the host; `disconnectedCallback` removes the keydown listener). Commit.
11. **`TerminalController`** (`controller.ts`). Port the whole of `mountTerminal` minus DOM construction: build `crt-housing` + slotted `crt-welcome`/`crt-game`/`crt-bezel`; `applyTheme(appRoot, themes[0])`; `ensureGlobalTokens()`. Keep verbatim the logic for `handle()` (error/ambiguous/query/examine/meta/intent incl. restart-confirm, fullscreen, audio verb, map, save/restore/undo), `absorbStatusCues`, `computeClickableNouns`, `refresh()` (now `game.setStatus(vm.status.locationName, latestStatus)`, `game.setHud(vm, nouns)`, `audio.update(session.campaign)`, `mapModel.observe(vm)`), `printRoom` (→ `game.transcript.printRoom(parts)`), `startGame`, map/help (→ `game.openMap(renderMapSvg(layoutMap(mapModel)))` / `game.openHelp(narrator.renderQuery("help", view))`). Wire events: welcome `enter`→`startGame`; bezel `toggle-audio`/`soundpack-change`/`theme-change`/`exit`; game `command`→`onSubmit`. `unmount()`: remove `crt-housing` (Lit `disconnectedCallback` tears down per-component timers/listeners), `audio.dispose()`, `appRoot.replaceChildren()`. Export a `mountTerminal`-shaped function returning `SurfaceHandle` so `surface.ts` stays a thin adapter. Controller test (happy-dom + a stub session/audio like `surface.test.ts`): a move turn updates transcript/hud/status; `finished` disables prompt and prints `— THE END —`; `restart` confirm clears + reprints; `map` opens an overlay; `unmount` disposes audio and clears the app. Commit.
12. **Rewire `surface.ts` + rewrite `surface.test.ts`.** `crtSurface.mount` calls the controller. Add a `deepQuery(root, selector)` test helper that walks `shadowRoot`s (happy-dom `querySelector` does **not** pierce). Rewrite the four existing tests (identity; mount→handle, unmount clears `app`; unmount disposes audio; unmount removes the overlay keydown listener — submit `map` by deep-querying `#cmd`/`#prompt-form`). Commit.
13. **Delete `ui.ts`.** Remove the file and any remaining imports/`applyStyles` references. `pnpm checks` green. Commit.
14. **`campaign-menu` + launcher.** Build the component (TDD: renders entries; click and Arrow/Enter emit `select`). Change `bootLauncher.showMenu()` to append a `<campaign-menu>` with `campaigns` set and a `select` listener calling `launch(resolveCampaign(slug,…))`. Keep `resolveCampaign`, deep-link, and `onExit` flow intact. Update/extend the launcher unit test. Commit.
15. **Docs.** Update root `README.md` and `packages/play/README.md`: the component tree, the controller/components (logic/view) boundary, the new `lit` dependency and *why* (template-based, retained-DOM-friendly), and that theming/`CrtTheme` are unchanged. Commit.

## Verification

- **Unit/component:** `pnpm vitest run packages/play-surface-crt` and `pnpm vitest run packages/play-runtime` — every new component test green; ported parser/narrator/link-nouns/map-view tests still green.
- **Whole suite + types + lint:** `pnpm checks` green (this is the gate before any task is "done").
- **e2e (the real backstop):** `pnpm --filter @wickedways/play exec playwright test` (or the repo's e2e script). The deep-link Hollow-House winning playthrough, the exit-link/noun fill tests, the welcome-start test, and the theme-switch smoke must pass unchanged — they validate that Playwright still pierces the open shadow roots and that `#cmd`/`#transcript`/`#hud .noun`/`.exit-link`/`— THE END —` hooks survived.
- **Manual parity:** `pnpm --filter @wickedways/play dev`, open the app: welcome → Enter → play a few turns (move, examine a noun via click, take loot), toggle audio, switch theme (haunted), open `map` and `help` (any key closes), `restart` (confirm), and Back-to-menu → menu renders via `<campaign-menu>` → re-enter. Confirm the CRT artifacts, typewriter, and reduced-motion behavior look identical to `main`.

## Risks / watch-outs

- **Shadow-piercing in tests:** happy-dom `querySelector` does not pierce; always traverse `shadowRoot` (the `deepQuery` helper). Playwright *does* pierce open roots — keep roots open.
- **Custom-property inheritance:** verify `--color-*` aliases (defined in `globalTokensCss`) resolve inside shadow styles; they must be in the document `:root`, not a component, so they inherit everywhere.
- **Event crossing:** any event the controller listens for must be `composed: true` (else it won't leave the shadow tree).
- **Nested-shadow depth for `#cmd`:** input sits in `crt-prompt` ⊂ `crt-game` ⊂ housing slot. Confirm Playwright resolves it early (Task 12 e2e run) before completing the migration.
