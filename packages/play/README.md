# @wickedways/play

The **deploy shell** for the [`wickedways`](../../README.md) browser play experience.
It registers the available campaigns and surfaces, calls `bootLauncher`, and serves the
resulting SPA from nginx. All substantive logic lives in the three packages it depends on.

The engine itself (turn loop, combat, items, mobs, serialization) is documented in the
[root `README.md`](../../README.md). See [`packages/play-runtime/`](../play-runtime/) and
[`packages/play-surface-crt/`](../play-surface-crt/) for the runtime and CRT surface.

## Quick start

```bash
pnpm --filter @wickedways/play dev        # Vite dev server (hot reload) at http://localhost:5173
pnpm --filter @wickedways/play build      # production bundle → dist/
pnpm --filter @wickedways/play typecheck  # tsc --noEmit
pnpm --filter @wickedways/play test:e2e   # Playwright end-to-end playthrough
```

Unit tests (`*.test.ts`) run as part of the repo-wide `pnpm test`; the Playwright e2e suite
in `e2e/` is separate and driven by `test:e2e`.

## Package topology

The play layer is split into four workspace packages with a clear dependency direction:

```
@wickedways/play (deploy shell)
  ├── @wickedways/play-runtime    — surface-independent runtime + contracts
  ├── @wickedways/play-surface-crt — CRT terminal surface implementation
  └── @wickedways/campaigns        — per-campaign manifests (subpath exports)
        ├── /hollow-house
        └── /seed
```

| Package | Role |
|---------|------|
| `@wickedways/play-runtime` | `GameSession`, view models, `SaveStore`, `AudioRuntime`, the launcher (`bootLauncher`/`resolveCampaign`), and all contracts: `CampaignManifest`, `PlaySurface`/`SurfaceHandle`/`Theme`/`MountArgs`, audio contracts (`AudioDirector`/`SoundPack`/`CampaignAudio`/`SoundSpec`). Zero Hollow-House / CRT references. |
| `@wickedways/play-surface-crt` | The CRT terminal — the first `PlaySurface` implementation. Parser, narrator, map view, link-nouns, and a **Lit component tree** driven by `mountTerminal`. Also exports `CrtTheme`/`defaultCrtTheme`/`applyTheme` for campaigns that designate this surface. |
| `@wickedways/campaigns` | All player-facing campaigns under `src/<slug>/`, each exporting a `CampaignManifest`. Subpath-exported: `@wickedways/campaigns/hollow-house`, `@wickedways/campaigns/seed`. |
| `@wickedways/play` | **This package.** Thin deploy shell: `src/main.ts`, `index.html`, `Dockerfile`, `nginx.conf`, `e2e/`. Registers campaigns + surfaces and calls `bootLauncher`. |

### Source layout

| Path | Responsibility |
|------|----------------|
| `src/main.ts` | Entry point — imports the two campaigns and the CRT surface, then calls `bootLauncher`. |
| `e2e/` | Playwright end-to-end tests (winning playthrough, deep-link, theme switch, etc.). |
| `Dockerfile` | Multi-stage build (Node + nginx). Build context is the **repo root** (see Deployment). |
| `nginx.conf` | Static file serving with gzip, asset caching, and SPA fallback. |

The former `src/core/`, `src/audio/`, `src/text/`, and `src/campaign/` directories have been
**split out** into the packages above and no longer live here.

## How it works

The UI never touches engine internals directly. Each turn flows through a thin glue layer
that turns the live `Campaign` into a plain, serializable **view model**, and turns typed
commands into **intents** the session executes:

```
keypress ─▶ parse(input, viewModel) ─▶ ParseResult
                                         │
            ┌────────────────────────────┼─────────────────────────────┐
            ▼              ▼              ▼              ▼               ▼
          intent        query         examine          meta          error /
            │          (look/inv/    (no engine     (save/restore/   ambiguous
            │           exits/help)    call)            undo)         (printed)
            ▼
   session.execute(intent) ─▶ engine mutation ─▶ ExecuteResult { cues, error? }
            │
            ▼
   transcript ◀─ narrator.renderAction(intent, before, after) + narrator.renderCues(cues)
   HUD/status ◀─ refresh() reads session.view()  →  Here: / Carrying: / Exits: + status bar
```

Time-advancing intents (`move`, `take`, `drop`, `use`, `attack`, `wait`, `talk`) tick the
round and snapshot the pre-state so a single level of **undo** is available; queries,
`examine`, and meta commands do not advance time.

## CRT surface: component architecture

The CRT surface renders through a **Lit component tree** driven by `mountTerminal`
(`packages/play-surface-crt/src/controller.ts`). `lit` (~5 KB, no build step) is a
declared dependency of both `play-runtime` (the `<campaign-menu>` picker) and
`play-surface-crt` (the terminal itself); the engine packages remain dependency-free.

**Why Lit?** Lit's template-based rendering with retained DOM cooperates with the
surface's imperatively-animated, append-only DOM — the typewriter, the growing transcript,
the focused input. A virtual-DOM library would fight those patterns; Lit leaves them alone.
The transcript is intentionally appended imperatively (outside Lit's reactive render) for
exactly this reason.

**Component tree.** `mountTerminal` builds this tree into the host `app` element:

```
<crt-housing>                   frame + CRT artifacts (scanlines, sweep); screen + bezel slots
  <crt-welcome slot="screen">   title card + start button; emits `enter`
  <crt-game    slot="screen">   game area; composes:
    <crt-transcript>            append-only typewriter scroll; noun chips emit `fill-input`
    <crt-hud>                   persistent loot / inventory / exits bar; noun chips emit `fill-input`
    <crt-status>                location name + campaign-defined stat readouts
    <crt-prompt>                focused command input; emits `command`
  <crt-bezel   slot="bezel">    audio toggle, soundpack/theme switchers, back button
```

The launcher (before a campaign is selected) renders `<campaign-menu>` from `play-runtime`;
it emits a `select` CustomEvent with `{ slug }` when the player chooses.

**Logic / view boundary.** `mountTerminal` owns all behavior: session, parser, narrator,
audio, map model, status cues, and the turn loop. The components are purely presentational.
Data flows **down** via reactive properties and method calls; intent flows **up** via
`composed` `CustomEvent`s:

| Event | Fired by | Handled by |
|-------|----------|------------|
| `enter` | `<crt-welcome>` | controller — starts the game |
| `command` | `<crt-prompt>` (via `<crt-game>`) | controller — parses + executes |
| `fill-input` | noun chips in `<crt-hud>` / `<crt-transcript>` | `<crt-game>` — fills the prompt |
| `toggle-audio` | `<crt-bezel>` | controller |
| `soundpack-change` | `<crt-bezel>` | controller |
| `theme-change` | `<crt-bezel>` | controller → `applyTheme` |
| `exit` | `<crt-bezel>` | controller → `onExit()` |
| `select` | `<campaign-menu>` | launcher → `bootLauncher` |

**Theming unchanged.** `CrtTheme`, `applyTheme`, and the `manifest.themes` contract are
unchanged. CSS custom properties (`--crt-*`) are applied on the app root and pierce shadow
boundaries, so switching a theme re-applies them with no component re-render. Theme
preference is in-memory (not persisted across page loads).

**Contracts unchanged.** `PlaySurface` / `MountArgs` / `SurfaceHandle` / `CampaignManifest`
are unchanged. `mount()` now builds the Lit tree; `unmount()` removes the housing element
and each component's `disconnectedCallback` handles its own cleanup (the old manual
interval and listener removal is gone).

## Campaign menu and deep-link

`bootLauncher` starts the play experience:

1. **`?campaign=<slug>`** — if present and matched, boots that campaign directly.
2. **No / unknown param** — shows the in-launcher campaign menu: a surface-independent
   picker (its own retro styling) listing each manifest's `title` and `blurb`.
   Keyboard and click both work.
3. **On select** — sets `?campaign=<slug>` in the URL, resolves the campaign's designated
   surface, builds the `AudioRuntime`, starts a `GameSession`, and calls `surface.mount(...)`.
4. **"Back to menu" (`onExit`)** — unmounts the surface, clears `?campaign=`, and re-renders
   the picker. The in-game restart path uses the same callback.

`e2e/` tests cover: winning playthrough (via deep-link), menu navigation, and theme switching.

## `PlaySurface` contract

`@wickedways/play-runtime` defines the `PlaySurface` interface. The shell injects the
available surfaces into `bootLauncher`; the runtime selects the right one for each campaign.

```ts
interface PlaySurface {
  id: string;           // "crt-terminal" — matched against CampaignManifest.surface
  label: string;        // "CRT Terminal"
  defaultTheme: Theme;  // fallback when a campaign supplies no themes
  mount(args: MountArgs): SurfaceHandle;
}

interface MountArgs {
  app: HTMLElement;
  session: GameSession;
  manifest: CampaignManifest;
  themes: Theme[];      // manifest.themes ?? [surface.defaultTheme] — always non-empty
  audio: AudioRuntime;  // shared audio service for this session
  onExit(): void;       // "back to menu"
}

interface SurfaceHandle { unmount(): void }
```

The runtime owns session, view models, cues, audio, and save store. The **surface** owns
input→intent, the turn loop, DOM rendering, and its own control UI.

## Per-surface themes and theme switcher

A campaign supplies `CrtTheme[]` in `manifest.themes`; `themes[0]` is the default.
The CRT surface renders a **theme switcher** in the monitor bezel (beside audio controls)
that **auto-hides when fewer than two themes are present**, mirroring the soundpack switcher.
Switching re-applies palette, fonts, and effects live via CSS custom properties on the CRT
housing. Theme preference is **in-memory** (not persisted across page loads).

`CrtTheme` extends the base `Theme` with:

```ts
interface CrtTheme extends Theme {
  palette: { bg: string; fg: string; accent: string; warn: string; critical: string };
  fonts:   { body: string; display: string };
  effects: { scanlineIntensity: number; glow: number; flicker: number };
}
```

The Hollow House campaign ships two themes: `default` (current green-phosphor look) and
`haunted` (warm pinkish-red palette with heavier glow and flicker).

**Adding a theme.** Declare a `CrtTheme` in the campaign's `themes.ts` file and include it
in `manifest.themes`. No edits to the runtime or surface are needed.

## Campaign-defined status bar

The status bar is **campaign-defined and cue-driven** — neither the runtime nor the CRT
surface hard-codes any stat name.

1. A campaign's `statusBar` mechanic emits `{ kind: "status", fields: StatusField[] }`
   presentation cues at round start and after each turn's effects.
2. The CRT surface renders the most recent `StatusCue` payload into its HUD status area.
   Before the first emission the area is empty.
3. `StatusField` carries `{ label, value, emphasis? }` where `emphasis` maps to the active
   theme's palette (`"warn"` → `--crt-warn`, `"critical"` → `--crt-critical`).

The Hollow House emits `[{label:"Sanity", value:"12", emphasis:"warn"}, {label:"Round", value:"37/150"}]`.
A campaign that never emits a `StatusCue` (e.g. the seed demo) simply shows an empty bar.

## Audio

The play surface generates all sound via **procedural Web Audio synthesis** — no shipped audio
assets, no licensing or bundle-size concerns.

### Four-layer architecture

```
Engine PresentationCue + live campaign state
        │
        ▼   AudioDirector              ◀── campaign-owned (in CampaignManifest.audio)
AudioCue { type, entityId?, intensity? }   +  continuous tension(0..1)
        │
        ▼   SoundPack (one per audio theme)  ◀── campaign-owned
SoundSpec  ({ kind:'synth', voice } | { kind:'sample', asset, … })
        │
        ▼   AudioBackend               ◀── runtime-owned (SynthRenderer; SampleRenderer deferred)
Web Audio output
```

- **`AudioDirector`** (campaign-owned) translates engine `PresentationCue`s into discrete
  `AudioCue`s and computes continuous tension (0–1) from the live campaign. Stateful factory
  (`createDirector()` called per boot/restart); closes over session-level state (e.g. the
  high-water-mark sanity for tension normalization).
- **`SoundPack`** (campaign-owned) maps `AudioCue`s to `SoundSpec`s and controls the ambient
  bed via `ambient(tension)`. The runtime ships `defaultChiptunePack` covering every
  `BaseAudioCue`; campaigns spread/override it.
- **`SoundSpec`** — `{ kind: "synth", voice }` for procedural synthesis (active);
  `{ kind: "sample", … }` for decoded audio assets (deferred — the arm exists so samples
  can be added without touching the contracts).
- **`AudioRuntime`** (runtime-owned service) — the integration seam: `playCue(cue, view)`,
  `playMobAttack(atk)`, `noteError()`, `update(campaign)` (recomputes tension via the
  director), `setEnabled(on)`, plus `soundpacks` / `setSoundpack(id)`.

Omit `audio` from `CampaignManifest` to get the flat ambient bed + default chiptune SFX only.

### Soundpack switcher

The CRT surface renders a soundpack switcher that **auto-hides when fewer than two packs
are present** (mirrors the theme switcher). Preference is **in-memory** only.

The Hollow House ships one pack: `defaultChiptunePack`. A second "scored" pack (with real
audio assets via `SampleRenderer`) is architecturally deferred.

### Master audio toggle

A single mute button in the monitor bezel controls all audio (ambient + SFX together). Audio
starts **muted** on every page load and never plays without a user gesture — the toggle click
is the gesture that resumes the `AudioContext`. If `AudioContext` is unavailable or blocked,
the runtime no-ops gracefully; the game is unaffected.

### Integration seams

```
cue from session.execute()       →  AudioRuntime.playCue(cue, view)
mob strike from runMobReactions  →  AudioRuntime.playMobAttack(atk)
rejected command / error         →  AudioRuntime.noteError()
each turn in refresh()           →  AudioRuntime.update(campaign)
toggle click                     →  AudioRuntime.setEnabled(on)
soundpack switcher               →  AudioRuntime.setSoundpack(id)
```

No `Math.random` is used — pitch variation is derived deterministically from actor/entity id
hashes (`detuneFactor` in `cue-sound.ts`).

### Feedback model

The engine emits terse `PresentationCue`s — an `action` cue carries only the action *kind*
and actor, **not** the affected item's name or damage dealt. So confirmation text for
inventory-class actions (`take`/`drop`/`open`/`equip`/`unequip`/`use`/`wait`) and for combat
is synthesized in `Narrator.renderAction(intent, before, after)`, which reads names, item
details, and occupant **health** out of the before/after view models. `attack` reports the
damage dealt (`before.health − after.health`), announces a kill when the target becomes
`defeated`, and notes a glancing blow when nothing lands; `move` returns no synthetic line —
the room re-render speaks for it. Mechanic, encounter, visibility, and resolution cues are
rendered by `Narrator.renderCues`. `status` cues are handled in the HUD, not the transcript.

Defeated mobs are a `defeated` (KO) status, not removal — the engine keeps them in the room.
The play surface treats them as gone: they drop out of `You see …`, and re-attacking a corpse
is rejected (`"The Revenant is already dead."`). Their dropped loot (`"<name>'s remains"`)
still appears in the HUD to collect.

**Mob aggression.** The session acts as the *solo GM*: after any time-advancing action, each
live (non-KO) mob in the player's current room strikes back via the engine's `mob.attack(pc)`
(`session.runMobReactions`). Entering a mob's room costs you; fleeing out that turn is safe;
the killing blow draws no retaliation. The damage and its **stat** are read from the player's
effective-stat deltas and surfaced as typed feedback — *"The Wraith claws at your mind — you
lose 3 Sanity."* In the Hollow House, both mobs attack **Sanity** (the haunt preys on the
mind); the Heir's Energy is tuned to 5 so the Sanity-damage multiplier is 1.0 and a mob's
`power` lands as whole points (see the mitigation note in the engine README — Health attacks
can't land on the Sanity-16 Heir, so the threat is wholly a sanity drain). A mob can kill the
player: a fatal blow drops Sanity to 0 and the round's outcome check ends the game.

The persistent bottom **HUD** (`Here:` loot, `Carrying:` inventory, `Exits:`) is redrawn from
`session.view()` every turn, so inventory and location state are always visible without a
query.

## Command vocabulary

| Category | Commands |
|----------|----------|
| Move | `n` `s` `e` `w` `ne` `nw` `se` `sw` (and full names), `go <dir>`, `walk <dir>` |
| Look | `look` / `l`, `examine` / `x` / `read` `<thing>` |
| Items | `take` / `get`, `drop`, `equip` / `wear` / `wield` / `light`, `unequip` / `remove` / `extinguish`, `use`, `open <container>` |
| Combat | `attack` / `kill` / `hit` `<foe>` |
| Query | `inventory` / `i` / `inv`, `exits`, `help` / `?` |
| Meta | `save`, `restore` / `load`, `undo`, `restart`, `wait` / `z`, `map` |

Nouns resolve against everything currently in scope — room occupants, loot containers and
their contents, and carried items/keys — by name or alias (aliases defined per campaign in
the manifest's `aliases` map). An unambiguous substring match is accepted; multiple matches
prompt a "which do you mean?" disambiguation.

**Reading items.** `examine`/`read`/`x <item>` reveals a held item's `lore` (its backstory
text) when it has any, falling back to the generic look line otherwise. This routes through
the engine's free, non-consuming `Character.read` (see `session.read`), so reading never
spends a turn or consumes the item.

**Restart.** `restart` re-boots the campaign to a fresh opening state (new world, start room,
turn 0, empty inventory). Because it wipes all progress with no undo, it **confirms first**:
the first `restart` prompts, a second `restart` performs it, and any other command cancels.
Saved games are untouched, and `restart` works after the game has ended (the natural "play
again"). It re-runs `GameSession.restart` from the stored builder/registry factories.

**Fog-of-war map.** `map` opens a vector SVG map inside the CRT screen showing only the
rooms you have explored, built from the directions you have traveled. The current room is
highlighted with a glowing accent border; each room is labeled with its name; locked doors
render as dashed lines; unexplored exits branch out as `?` stubs; and rooms where a mob was
defeated show a `✕` marker. Any keypress dismisses the overlay. The map persists across
`save`/`restore` — it travels in the save envelope's opaque `surface` payload alongside
other UI state — and is cleared on `restart`. Internal seam: `MapModel` (populated
incrementally via `refresh` on each turn and `handle` on each move) → `layoutMap` (grid
placement from compass directions) → `renderMapSvg` (produces the SVG string embedded in
the overlay).

## The campaigns

### The Hollow House (`@wickedways/campaigns/hollow-house`)

A nine-room haunted estate played as the **Heir** archetype.

- **Goal:** reach the **Attic** carrying the **journal** (found in the Foyer drawer).
- **Lose** if Sanity hits 0, the party is downed, or the 150-round clock runs out.
- **Dread:** Sanity drains by 1 each round unless a lit **lantern** is equipped.
- **Keyed doors:** the **brass key** (dropped by the Wraith in the Nursery) opens the Study;
  the **iron key** (dropped by the Revenant in the Cellar) opens the Attic. Walk into a locked
  door while carrying its key to open it.
- **Storyteller:** entering a room while carrying the journal reveals a one-time lore fragment.
- **Audio:** sanity-driven chiptune ambient + SFX via the default chiptune pack.
- **Themes:** `default` (green phosphor) and `haunted` (warm pinkish-red, heavier glow/flicker).

See `packages/campaigns/src/hollow-house/` for the full room graph, loot, mobs, and conditions.

### Seed Demo (`@wickedways/campaigns/seed`)

A minimal engine-exercise world (a few rooms, a recipe, the `delver` archetype). Omits
`audio`, `themes`, and status mechanics — exercises the flat-bed / default-theme /
empty-status-bar paths. Both switchers (theme, soundpack) are auto-hidden.

The campaign content lives in `@wickedways/seed` (the engine-only demo world); this entry
is a thin `CampaignManifest` wrapper that presents it in the launcher.

## Adding a campaign

1. Create a folder `packages/campaigns/src/<slug>/`.
2. Export a `CampaignManifest` as a named export from its `index.ts`:
   ```ts
   export const myCampaign: CampaignManifest = {
     slug: "my-campaign",
     title: "My Campaign",
     blurb: "Short description for the launcher menu.",
     intro: "Welcome-screen body text.",
     builder: myTemplate,       // () => TemplateBuilder
     registry: myRegistry,      // () => CampaignRegistry
     aliases: {},
     playerName: "Hero",
     archetype: "fighter",
     // audio, surface, themes are optional
   };
   ```
3. Register it in `packages/play/src/main.ts`:
   ```ts
   import { myCampaign } from "@wickedways/campaigns/my-campaign";
   bootLauncher(app, { campaigns: [hollowHouse, seed, myCampaign], surfaces: [crtSurface] }, …);
   ```

## Adding a surface

1. Implement the `PlaySurface` interface in a new package (e.g. `@wickedways/play-surface-foo`):
   ```ts
   export const fooSurface: PlaySurface = {
     id: "foo",
     label: "Foo Surface",
     defaultTheme: { id: "default", label: "Default" },
     mount({ app, session, themes, audio, onExit }): SurfaceHandle {
       // render, subscribe to cues, drive the turn loop …
       return { unmount() { /* teardown */ } };
     },
   };
   ```
2. Register it in `packages/play/src/main.ts` alongside the existing surfaces.
3. Point a campaign at it via `manifest.surface = "foo"`.

## Testing

- **Unit** — co-located `*.test.ts` in each package covering the parser, narrator, view model,
  session, save store, audio, and campaign wiring.
- **End-to-end** — `e2e/playthrough.spec.ts` drives a full winning run in a real browser
  (welcome screen → loot → combat → save/undo → win), plus checks the clickable-exit and
  clickable-noun affordances. Run with `pnpm --filter @wickedways/play test:e2e`.

## Deployment (Coolify)

The play surface ships as a static bundle served by nginx, built by the multi-stage
[`Dockerfile`](./Dockerfile). Because the SPA bundles `wickedways`, `play-runtime`,
`play-surface-crt`, and `campaigns` straight from TypeScript source through the pnpm
workspace, **the Docker build context is the repo root** (not this package directory) and
there is no separate engine build step.

Build/run locally to mirror production:

```bash
# from the repo root
docker build -f packages/play/Dockerfile -t wickedways-play .
docker run --rm -p 8080:80 wickedways-play   # → http://localhost:8080
```

Coolify is configured for Git-push auto-deploy from this repository. Create/point the
application at these settings:

| Setting | Value |
|---------|-------|
| Build Pack | **Dockerfile** |
| Dockerfile Location | `/packages/play/Dockerfile` |
| Base Directory (build context) | `/` |
| Ports Exposed | `80` |
| Source | this GitHub repo, deploy on push |

No environment variables or runtime config are needed — the game is fully client-side.
Asset caching, gzip, and the SPA fallback live in [`nginx.conf`](./nginx.conf).
