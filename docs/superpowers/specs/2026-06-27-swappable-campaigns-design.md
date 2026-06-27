# Swappable Campaigns & Play Surfaces

**Status:** Design approved, ready for implementation plan
**Date:** 2026-06-27

## Goal

Make **The Hollow House** self-contained so that it — and the surface it runs on — are modular and
swappable. Concretely, enable:

1. **Multiple campaigns** the player chooses between (an in-launcher menu + deep-link).
2. **Swappable play-surface implementations** — a campaign designates which `PlaySurface` it runs
   on (the CRT terminal is the first; the contract allows others later).
3. **Per-surface themes** the campaign supplies and the player can switch between live (e.g. a
   "haunted" horror reskin of the CRT terminal).

Adding a campaign, a theme, or a surface becomes a matter of dropping in a folder/object and
registering it — with **no edits to the generic runtime**.

## Background: current state

This is a packaging-and-contract refactor, not new mechanics. The play surface is **already
structurally generic**. Today everything lives in `packages/play`:

- `src/core/` (`session.ts`, `intent.ts`, `viewmodel.ts`, `savestore.ts`, `map-model.ts`) and the
  `src/audio/` subsystem are **content- and presentation-agnostic** — they drive a generic
  `Campaign` through view models, intents, and cues.
- `src/text/` (`parser.ts`, `narrator.ts`, `ui.ts`, `link-nouns.ts`, `map-view.ts`) is the **CRT
  terminal surface** — typed-command input and CRT DOM rendering.
- `src/campaign/` (`index.ts`, `content.ts`, `mechanics.ts`, `items.ts`, `ids.ts`) is **Hollow
  House only**.
- The engine (`wickedways`, `src/lib/...`) already provides the authoring primitives:
  `authorTemplate()` → `TemplateBuilder`, `CampaignRegistry`, `assemble()`.

The **entire** Hollow-House coupling into generic code is small:

1. `main.ts` imports six Hollow-House symbols and hardcodes the player name `"Heir"`.
2. `text/ui.ts` hardcodes the welcome button text `"Enter Hollow House"`.
3. Audio hardcodes **Sanity** as the tension stat (`AudioManager.update(view.status.sanity)`,
   `sanityToTension`), and the **status bar** hardcodes Sanity.

`main.ts` already threads `builder`, `registry`, `aliases`, `playerName`, `archetype`, `title`,
`intro` into `GameSession.start` / `mountTerminal`, so the seam is mostly present. There is a
precedent for a second, independent campaign: `@wickedways/seed` is an engine-only demo world
consumed by `server`/`client`.

## Target package topology

The single `@wickedways/play-surface` splits into a **surface-independent runtime** plus
**surface implementations**, with all campaigns consolidated into one package exposing per-campaign
subpath exports. The deploy shell stays put.

| Package | Role |
|---|---|
| `@wickedways/play-runtime` **(new)** | Surface-independent browser runtime + all contracts. Holds `GameSession` glue (`session`, `intent`, `viewmodel`, `savestore`, `map-model`), the **audio engine** (backends, ambient bed, default chiptune pack) exposed as an `AudioRuntime` service, the **campaign registry + launcher** (menu/deep-link orchestration), and the contract types: `CampaignManifest`, `PlaySurface`, `Theme`, the presentation cues (`StatusCue`/`AudioCue`), `SoundSpec`, `AudioDirector`, `SoundPack`. **Zero** Hollow-House / Sanity / CRT references. |
| `@wickedways/play-surface-crt` **(new)** | The CRT terminal — the first `PlaySurface` implementation. Today's `text/` (`parser`, `narrator`, `ui`, `link-nouns`, `map-view`) plus the CRT theme shape (`CrtTheme`: palette/fonts/effects) and a generic default theme. Depends on `play-runtime`. |
| `@wickedways/campaigns` **(new)** | All player-facing campaigns, one folder per campaign under `src/<slug>/`, each exporting a `CampaignManifest`. Subpath-exported via `"exports": { "./*": "./src/*/index.ts" }` → `@wickedways/campaigns/hollow-house`, `@wickedways/campaigns/seed` (mirrors the engine's `wickedways/lib/*`). |
| `@wickedways/play` *(stays)* | The thin **deploy shell**: `main.ts`, `index.html`, `Dockerfile`, `nginx.conf`, `e2e/`. Registers the available surfaces + campaigns and calls `bootLauncher`. **Coolify Dockerfile path unchanged** (`packages/play/Dockerfile`). |
| `@wickedways/seed` *(unchanged)* | Stays the **engine-only** demo world consumed by `server`/`client`. Not moved. |
| `server` / `client` / `transport-shared` | Untouched (already zero Hollow-House coupling). |

### Dependency direction (acyclic)

```
@wickedways/play  ──▶  play-runtime, play-surface-crt, campaigns/{hollow-house,seed}
play-surface-crt  ──▶  play-runtime  ──▶  wickedways (engine)
campaigns         ──▶  wickedways (engine);  import type ──▶ play-runtime (+ play-surface-crt theme shape)
campaigns/seed    ──▶  @wickedways/seed  ──▶  wickedways (engine)
```

`play-runtime` defines the `PlaySurface` contract but never imports a concrete surface — the shell
injects the available surfaces into `bootLauncher`. `campaigns` depends on the engine for content
and is **type-only** on the runtime (for `CampaignManifest`/cue/director types) and on a surface's
theme shape (a campaign that designates the CRT surface may `import type { CrtTheme }`). All
type-only, so campaign code stays node-testable and DOM-free. No cycles.

### The seed wrapper seam

`@wickedways/campaigns/seed` is a **thin wrapper**: it imports the seed template/registry from
`@wickedways/seed` and dresses them as a `CampaignManifest`. The seed **content is not moved** —
keeping the server's dependency graph away from a UI runtime. So `@wickedways/seed` is the demo
*world*; `@wickedways/campaigns/seed` is its *presentation*. The seed manifest omits `audio` and
`themes`, exercising the flat-bed / default-theme / empty-status-bar paths.

## Contracts

All defined in `@wickedways/play-runtime`.

### `CampaignManifest`

```ts
interface CampaignManifest {
  // identity & menu presentation
  slug: string;        // "hollow-house" — registry key + ?campaign= value
  title: string;       // "The Hollow House"
  blurb: string;       // one/two-line description for the launcher menu
  intro: string;       // welcome-screen body
  buttonText?: string; // "Enter Hollow House" (defaults to `Enter ${title}`)

  // engine wiring — factories, because `restart` re-boots from them
  builder: () => TemplateBuilder<string, string>;
  registry: () => CampaignRegistry;
  aliases: AliasMap;
  playerName: string;
  archetype: string;   // archetype id

  // surface & themes
  surface?: string;    // PlaySurface id; default = shell's default surface ("crt-terminal")
  themes?: Theme[];    // campaign-supplied themes for that surface; themes[0] = default; player switches

  // audio; omit → flat bed + generic SFX only
  audio?: CampaignAudio;
}
```

`builder`/`registry` are **factories** because `GameSession.restart` re-boots the world from them.
There is no `tensionStat`/`theme`-id field: peril-as-sound and look-and-feel are campaign-supplied
content (`audio`, `themes`), mirroring each other.

### `PlaySurface`

A surface takes a live `GameSession` and renders/drives it. The runtime owns the session, view
models, cues, audio, and savestore; the **surface owns input → intent, the turn loop, rendering,
and its own control UI** (mute, soundpack switcher, theme switcher).

```ts
interface PlaySurface {
  id: string;            // "crt-terminal"
  label: string;         // "CRT Terminal"
  defaultTheme: Theme;   // used when a campaign supplies no themes

  mount(args: {
    app: HTMLElement;
    session: GameSession;
    manifest: CampaignManifest;
    themes: Theme[];     // non-empty; launcher passes manifest.themes ?? [defaultTheme]
    audio: AudioRuntime; // shared audio service built by the launcher from manifest.audio
    onExit(): void;      // "back to menu" — launcher unmounts and shows the menu
  }): SurfaceHandle;
}

interface SurfaceHandle { unmount(): void }
```

### `Theme`

A theme's concrete shape is **surface-specific**; the runtime keeps it loosely typed and each
surface defines its own. The CRT surface defines `CrtTheme`.

```ts
interface Theme { id: string; label: string }          // runtime-level base
interface CrtTheme extends Theme {                      // defined by play-surface-crt
  palette: { bg: string; fg: string; accent: string; warn: string; critical: string; /* … */ };
  fonts: { body: string; display: string };
  effects: { scanlineIntensity: number; glow: number; flicker?: number };
}
```

A campaign that designates the CRT surface supplies `CrtTheme[]` in `manifest.themes`. Themes are
**content**, like soundpacks — surface = capability, campaign = content.

## Launcher & boot flow

`@wickedways/play-runtime` exports the launcher; the shell wires it:

```ts
function bootLauncher(
  app: HTMLElement,
  reg: { campaigns: CampaignManifest[]; surfaces: PlaySurface[] },
  opts: { saveStore: SaveStore; now: () => number },
): void;
```

Behavior:

1. **Read `?campaign=<slug>`.** Match → **deep-link**: boot that campaign directly, skip the menu.
2. **No / unknown param → in-launcher campaign menu** — runtime-level chrome (its own retro
   styling, surface-independent since the surface isn't known until a campaign is chosen). Lists
   each manifest's `title` + `blurb`; keyboard + click to select.
3. **On select:** set `?campaign=<slug>` (history). Resolve the campaign's `surface`
   (`manifest.surface ?? "crt-terminal"`) against the injected surfaces; build the `AudioRuntime`
   from `manifest.audio` (using runtime backends + default chiptune pack); `GameSession.start({
   builder: m.builder(), registry: m.registry(), … })`; then `surface.mount({ app, session,
   manifest, themes: m.themes ?? [surface.defaultTheme], audio, onExit })`.
4. **`onExit` ("back to menu")** unmounts the surface (`handle.unmount()`), clears `?campaign=`,
   and re-shows the menu. The game-over "play again" path can route here too.

## Audio architecture

The campaign owns **what is heard**; the surface owns **how controls appear**; the runtime owns
**how sound is produced**; a swappable **theme** (soundpack) sits between so players can switch e.g.
*chiptune* ↔ *fully scored*. Four layers:

```
Engine PresentationCue  + live campaign state
        │
        ▼   AudioDirector              ◀── campaign-owned
AudioCue { type: 'strike' | 'dread-swell' | 'music-box' | … , entityId?, intensity? }
   + continuous tension(0..1)
        │
        ▼   SoundPack (one per theme)  ◀── campaign-owned (runtime ships a default chiptune pack)
SoundSpec  ({ kind:'synth', voice } | { kind:'sample', asset, gain?, pan? })
        │
        ▼   AudioBackend               ◀── runtime-owned (SynthRenderer now; SampleRenderer later)
Web Audio output
```

### Contracts

```ts
type SoundSpec =
  | { kind: "synth"; voice: SynthVoice }
  | { kind: "sample"; asset: AudioBuffer | string; gain?: number; pan?: number };

type BaseAudioCue =
  | "strike" | "death" | "pickup" | "drop" | "move"
  | "light" | "encounter" | "win" | "lose" | "error";
interface AudioCue { type: BaseAudioCue | (string & {}); entityId?: string; intensity?: number }

interface AudioDirector {
  react(cue: PresentationCue, view: ViewModel): AudioCue[]; // discrete events
  tension(campaign: ICampaign): number;                     // continuous 0..1, drives the bed
}

interface SoundPack {
  id: string; label: string;                    // "chiptune" / "Chiptune"
  voice(cue: AudioCue): SoundSpec | null;        // discrete cue → sound (null = silent)
  ambient(tension: number): AmbientDirective;     // how THIS theme renders the bed at a tension
}

interface CampaignAudio {
  createDirector(): AudioDirector;  // stateful: closes over the tension high-water-mark
  soundpacks: SoundPack[];          // [chiptune, scored?]; soundpacks[0] is the default
}
```

The runtime exposes an `AudioRuntime` service (built by the launcher from `manifest.audio`):
`playCue`, `playMobAttack`, `noteError`, `update(campaign)` (recomputes tension via the director),
`setEnabled`, plus `soundpacks`/`setSoundpack`. The **surface** drives it through the turn loop and
renders the controls (mute, soundpack switcher) in its own UI.

### Ownership rationale

- **Director is campaign-owned** — "what is worth hearing, and what is dreadful" is campaign
  knowledge, consistent with how campaigns already ship behavior functions (`dread`,
  `makeStoryteller`, conditions, door behaviors). Hollow House's `sanityToTension`/`cue-sound`
  logic moves here.
- **`createDirector()` is a stateful factory** because tension normalizes against the session
  **high-water-mark** sanity — that state belongs with the campaign. Mirrors `makeStoryteller(lore)`.
- **SoundPacks are campaign-owned** because the `AudioCue` vocabulary is campaign-defined; a theme
  is a *rendering* of it. The runtime ships a **default chiptune pack** over `BaseAudioCue` so a
  low-effort campaign (or one omitting `audio`) still gets SFX for free; campaigns spread/override
  it: `{ ...defaultChiptunePack, voice: c => mine(c) ?? defaultChiptunePack.voice(c) }`.
- **Theme is the swappable axis**, independent of campaign flavor: the same tension signal renders
  as a detuned drone in chiptune vs. crossfaded stems in "scored" — which is why theme can't live
  in the director.

### Scope (audio)

Build the **full 4-layer architecture**, ship only chiptune: port `cue-sound.ts` + `tension.ts`
into Hollow House's `AudioDirector` + a chiptune `SoundPack`; `synth.ts` → `SynthRenderer`;
`ambient.ts` stays as the bed driven by `SoundPack.ambient(tension)`. The soundpack switcher (in
the surface UI) **auto-hides with <2 packs**. `SampleRenderer` + a real `scored` pack (with assets)
are **deferred** — the `{ kind: "sample" }` arm exists so they can be added without touching
contracts. Active-pack preference is in-memory (like the existing mute toggle).

## Status bar: campaign-defined, cue-driven

Today the status bar hardcodes Sanity. Instead, the **campaign defines what the status bar shows
and pushes updates via cues** — the same "campaign owns presentation, surface renders what it's
handed" philosophy as the audio and themes. Neither the runtime nor a surface holds stat-specific
knowledge.

The channel is a **status presentation cue** carrying the full bar state as an ordered field list:

```ts
interface StatusField { label: string; value: string; emphasis?: "normal" | "warn" | "critical" }
interface StatusCue  { kind: "status"; fields: StatusField[] }   // a PresentationCue variant
```

- The campaign **emits a `StatusCue`** (typically from its mechanics — `dread` already runs each
  round) at **boot** and **whenever a displayed value changes**. The payload *is* the declaration:
  the campaign sets both the fields and their values each emission. Hollow House emits e.g.
  `[{label:"Sanity", value:"12", emphasis:"warn"}, {label:"Round", value:"37/150"}]`.
- The **surface renders the most recent `StatusCue`** into its status area; before any status cue
  it is empty/neutral. `emphasis` maps to the active theme's styling (`critical` → the theme's
  `critical` palette color).
- This **removes the `view.status.sanity` read** entirely. Generic HUD rows (`Here:`/`Carrying:`/
  `Exits:`) stay pull-based from the `ViewModel`; only the stat readout becomes campaign-driven.
- The **audio director** independently reads tension off the live `ICampaign`, so no per-stat
  assumption leaks anywhere in the runtime or surface.

A campaign emitting no `StatusCue` (e.g. seed) shows an empty status bar — consistent with omitting
`audio`/`themes`.

## Theming (CRT surface)

The CRT surface defines `CrtTheme` (palette/fonts/effects) and ships a **generic default theme**
used when a campaign supplies none. A campaign supplies `CrtTheme[]` in `manifest.themes`;
`themes[0]` is the default; the surface renders a **theme switcher** (in the bezel, beside the
audio controls) that **auto-hides with <2 themes**, mirroring the soundpack switcher. Switching
re-applies palette/fonts/effects live (CSS custom properties on the CRT housing); `StatusCue`
`emphasis` and any themed copy follow.

### Scope (themes)

Build the theme mechanism + switcher. Prove it by shipping **two** Hollow-House CRT themes: the
current look as `default`, plus a **`haunted`** horror reskin (different palette, heavier
glow/flicker, eerie display font) — cheap, since a theme is palette/fonts/effect params with **no
new assets**. A genuinely different second *surface implementation* is **deferred** (the
`PlaySurface` contract is in place so one can be added later, like the scored audio pack). Theme
preference is in-memory.

## Testing & migration

Incremental; each step keeps `pnpm checks` green:

1. **Contracts + boot inside current `play`.** Introduce `CampaignManifest`, `PlaySurface`,
   `Theme`, the cue/audio contracts, and `bootLauncher`; prove Hollow House boots through the
   manifest on the existing CRT (treated as the one surface). Replace the `main.ts` hardcoding, the
   `ui.ts` button string, the Sanity audio read, and the Sanity status bar.
2. **Split `@wickedways/play-runtime` from `@wickedways/play-surface-crt`.** Move surface-
   independent code (`core/`, `audio/`, contracts, launcher) to the runtime; CRT code (`text/`) to
   the surface package; define + implement `PlaySurface`; CRT exposes `CrtTheme` + default theme.
3. **Add `@wickedways/campaigns`.** Move `campaign/` → `campaigns/src/hollow-house/`, add its
   `manifest.ts`, `AudioDirector`, chiptune pack, and `default`/`haunted` themes. Configure subpath
   exports.
4. **Add `campaigns/seed` + the menu.** Wrap `@wickedways/seed`; shell registers both campaigns and
   the CRT surface; verify the picker, deep-link, theme switch, and back-to-menu.
5. **Docs.** Update `README.md` (root) and `packages/play/README.md`.

### Tests

- **Move with code:** existing unit tests follow their modules (session/viewmodel/intent/map/audio
  mapping → `play-runtime`; parser/narrator/link-nouns/map-view → `play-surface-crt`; campaign
  wiring → `campaigns/hollow-house`).
- **New:**
  - **Launcher/registry:** deep-link `?campaign=hollow-house` resolves; unknown slug → menu; menu
    select boots the campaign on its **designated surface**; `onExit` unmounts and re-shows the menu.
  - **PlaySurface lifecycle:** mount returns a handle; `unmount()` tears down cleanly; switching
    campaigns mounts the right surface.
  - **AudioDirector** (Hollow House): tension curve incl. high-water-mark normalization; engine cue
    → audio cue mapping.
  - **SoundPack** mapping: default chiptune pack covers every `BaseAudioCue`; campaign overrides win.
  - **Theme:** switcher hidden with <2 themes; switching applies the theme; default theme used when
    a campaign supplies none.
  - **Status bar:** a `StatusCue` renders fields in order with correct `emphasis`; the latest cue
    replaces the previous; no cue → empty bar.
  - **No-audio / no-status / no-theme campaign** (seed): boots with flat bed, generic SFX, default
    theme, empty status bar, both switchers hidden.
- **e2e:** keep the winning Hollow-House playthrough green by **deep-linking**
  `?campaign=hollow-house`; add a menu-navigation test (menu → select → play → back to menu) and a
  theme-switch smoke test.

## Documentation (definition of done)

Per the project's standing convention:

- Root `README.md`: document the `CampaignManifest`, `PlaySurface`, and `Theme` contracts and the
  authoring story (add a campaign = a folder + manifest; add a theme = a `CrtTheme` in the manifest;
  add a surface = implement `PlaySurface` + register in the shell).
- `packages/play/README.md`: update the source-layout/topology for the runtime + surface + campaigns
  split; document the `PlaySurface` contract, the 4-layer audio architecture, the cue-driven
  campaign-defined status bar, per-surface themes + the theme switcher, and the campaign menu +
  deep-link.
- TSDoc on `CampaignManifest`, `PlaySurface`, `Theme`, `bootLauncher`, and the audio contracts.

## Out of scope

- Authoring brand-new campaign content (the seed wrapper is the second menu entry).
- A second `PlaySurface` implementation (contract only; CRT is the sole surface for now).
- The `scored` soundpack, `SampleRenderer`, and any shipped audio assets (architecture only).
- Renaming or moving `@wickedways/seed`, `server`, `client`, or the Coolify deploy config.
- Persisting audio/theme/mute preferences (all stay in-memory).
