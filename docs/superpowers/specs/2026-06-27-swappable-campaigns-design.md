# Swappable Campaigns on a Reusable Play Surface

**Status:** Design approved, ready for implementation plan
**Date:** 2026-06-27

## Goal

Make **The Hollow House** self-contained so that it — and its play surface — are modular and
swappable, enabling the play surface to **ship multiple campaigns** the player chooses between.

The end state: a player loads the play surface, picks a campaign from an in-CRT menu (or
deep-links to one), and plays it. Adding a new campaign is a matter of dropping in a folder and
registering its manifest — no edits to the generic play surface.

## Background: current state

The play surface is **already structurally generic**; this is a packaging-and-contract refactor,
not new mechanics. Today everything lives in `packages/play`:

- `src/core/` (`session.ts`, `intent.ts`, `viewmodel.ts`, `savestore.ts`, `map-model.ts`),
  `src/text/` (`parser.ts`, `narrator.ts`, `ui.ts`, `link-nouns.ts`, `map-view.ts`), and
  `src/audio/` (`audio-manager.ts`, `synth.ts`, `ambient.ts`, `cue-sound.ts`, `tension.ts`) are
  **content-agnostic** — they drive a generic `Campaign` through view models and intents.
- `src/campaign/` (`index.ts`, `content.ts`, `mechanics.ts`, `items.ts`, `ids.ts`) is **Hollow
  House only**.
- The engine (`wickedways` package, `src/lib/...`) already provides the campaign-authoring
  primitives: `authorTemplate()` → `TemplateBuilder`, `CampaignRegistry`, `assemble()`.

The **entire** Hollow-House coupling into generic code is:

1. `packages/play/src/main.ts` imports six Hollow-House symbols (`hauntedHouseTemplate`,
   `buildHauntedHouseRegistry`, `ALIASES`, `TITLE`, `INTRO`, `Archetypes.Heir`) and hardcodes the
   player name `"Heir"`.
2. `packages/play/src/text/ui.ts` hardcodes the welcome button text `"Enter Hollow House"`.
3. The audio subsystem hardcodes **Sanity** as the tension stat
   (`AudioManager.update(view.status.sanity)`, `sanityToTension`).

`main.ts` already threads `builder`, `registry`, `aliases`, `playerName`, `archetype`, `title`,
and `intro` into `GameSession.start` / `mountTerminal` — so the seam is 80% present. There is a
precedent for a second, independent campaign: `@wickedways/seed` is an engine-only demo world
consumed by `server`/`client`.

## Target package topology

Chosen approach: a reusable **play-surface library** plus a single **campaigns package** whose
campaigns are exposed via per-campaign subpath exports. The deploy shell stays put.

| Package | Role |
|---|---|
| `@wickedways/play-surface` **(new)** | The reusable UI library. Today's `core/`, `text/`, `audio/`, **plus** the `CampaignManifest` and audio contracts, the campaign registry + picker UI, the audio backends, the default chiptune pack, and the `bootPlaySurface(app, campaigns, opts)` entry. **Zero** Hollow-House / Sanity references. |
| `@wickedways/campaigns` **(new)** | All player-facing campaigns. One folder per campaign under `src/<slug>/`, each exporting a `CampaignManifest`. Subpath-exported via `"exports": { "./*": "./src/*/index.ts" }`, so `@wickedways/campaigns/hollow-house` and `@wickedways/campaigns/seed` resolve straight from source (mirrors the engine's `wickedways/lib/*`). |
| `@wickedways/play` *(stays)* | The thin **deploy shell**: `main.ts`, `index.html`, `Dockerfile`, `nginx.conf`, `e2e/`. Imports the campaign subpaths, calls `bootPlaySurface(app, [hollowHouse, seed])`. The **Coolify Dockerfile path is unchanged** (`packages/play/Dockerfile`), so deploy config does not move. |
| `@wickedways/seed` *(unchanged)* | Stays the **engine-only** demo world consumed by `server`/`client`. Not moved. |
| `server` / `client` / `transport-shared` | Untouched (already zero Hollow-House coupling). |

### Dependency direction (acyclic)

```
@wickedways/play  ──▶  @wickedways/campaigns/{hollow-house,seed}
       │                        │  (import type)        │
       └────────▶  @wickedways/play-surface  ◀──────────┘
                                                         │
@wickedways/campaigns/seed  ──▶  @wickedways/seed  ──▶  wickedways (engine)
@wickedways/campaigns       ──▶  wickedways (engine)
```

`play-surface` never imports `campaigns`. `campaigns` depends on the engine for content and on
`play-surface` **type-only** (`import type { CampaignManifest, ViewModel, AudioCue, SoundPack }`),
so it stays node-testable and pulls no DOM into the campaign code. No cycles.

### The seed wrapper seam

`@wickedways/campaigns/seed` is a **thin wrapper**: it imports the existing seed template/registry
from `@wickedways/seed` and dresses them as a `CampaignManifest`. The seed **content is not
moved** — keeping the server's dependency graph away from a UI library. So `@wickedways/seed` is
the demo *world*; `@wickedways/campaigns/seed` is its *presentation* as a selectable campaign.
The seed manifest omits the `audio` block, exercising the flat-bed / no-tension path.

## The `CampaignManifest` contract

One object replaces the hand-wired imports in `main.ts`. Exported (as a type) from
`@wickedways/play-surface`.

```ts
interface CampaignManifest {
  // identity & menu presentation
  slug: string;        // "hollow-house" — registry key + ?campaign= value
  title: string;       // "The Hollow House"
  blurb: string;       // one/two-line description for the picker menu
  intro: string;       // welcome-screen body
  buttonText?: string; // "Enter Hollow House" (defaults to `Enter ${title}`)

  // engine wiring — factories, because `restart` re-boots from them
  builder: () => TemplateBuilder<string, string>;
  registry: () => CampaignRegistry;
  aliases: AliasMap;
  playerName: string;
  archetype: string;   // archetype id

  // optional audio (see Audio section); omit → flat bed + generic SFX only
  audio?: CampaignAudio;
}
```

`builder` and `registry` are **factories** because `GameSession.restart` re-boots the world from
them (a fresh build per boot/restart, matching today's `hauntedHouseTemplate()` call).

There is no `tensionStat` field — peril-as-sound is campaign-owned (see Audio).

## Selection & boot flow

`@wickedways/play-surface` exports:

```ts
function bootPlaySurface(
  app: HTMLElement,
  campaigns: CampaignManifest[],
  opts: { saveStore: SaveStore; now: () => number },
): void;
```

Behavior:

1. **Read `?campaign=<slug>`.** If it matches a manifest → **deep-link**: boot that campaign
   directly, skip the menu.
2. **No / unknown param → in-CRT campaign menu.** Rendered into the same CRT housing, lists each
   manifest's `title` + `blurb`; keyboard (number / arrows + enter) and click to select.
3. **On select:** set `?campaign=<slug>` (history, so deep-links and refresh are stable),
   `GameSession.start({ builder: m.builder(), registry: m.registry(), aliases, playerName,
   archetype, saveStore, now })`, then `mountTerminal(app, session, { title, intro, buttonText })`
   and wire audio from `m.audio`.
4. **"Back to menu"** affordance returns to step 2 and clears `?campaign=`. On game end, the
   "play again" path can also offer the menu.

The picker is a new small surface in the library (`src/menu/`), reusing the CRT
housing/overlay styling already in `ui.ts`. When the menu is shown for a single-campaign list it
still renders (one entry) — but a deep-link build that passes one manifest with a matching param
goes straight in.

## Audio architecture

The campaign owns **what is heard**; the surface owns **how it is produced**; a swappable
**theme** (soundpack) sits between them so players can switch e.g. *chiptune* ↔ *fully scored*.
Four layers, three owners:

```
Engine PresentationCue  + live campaign state
        │
        ▼   AudioDirector              ◀── campaign-owned
AudioCue { type: 'strike' | 'dread-swell' | 'music-box' | … , entityId?, intensity? }
   + continuous tension(0..1)
        │
        ▼   SoundPack (one per theme)  ◀── campaign-owned (surface ships a default chiptune pack)
SoundSpec  ({ kind:'synth', voice } | { kind:'sample', asset, gain?, pan? })
        │
        ▼   AudioBackend               ◀── surface-owned (SynthRenderer now; SampleRenderer later)
Web Audio output
```

### Contracts (in `@wickedways/play-surface`)

```ts
// surface-owned rendering vocabulary the backends understand
type SoundSpec =
  | { kind: "synth"; voice: SynthVoice }                       // procedural (chiptune)
  | { kind: "sample"; asset: AudioBuffer | string; gain?: number; pan?: number }; // scored stems

// base semantic vocabulary the surface derives from engine PresentationCues;
// campaigns may add their own string-typed cues on top
type BaseAudioCue =
  | "strike" | "death" | "pickup" | "drop" | "move"
  | "light" | "encounter" | "win" | "lose" | "error";
interface AudioCue { type: BaseAudioCue | (string & {}); entityId?: string; intensity?: number }

// campaign-owned: turns engine events + state into audio cues (incl. custom) + continuous tension
interface AudioDirector {
  react(cue: PresentationCue, view: ViewModel): AudioCue[]; // discrete events
  tension(campaign: ICampaign): number;                     // continuous 0..1, drives the bed
}

// campaign-owned theme; surface ships a default chiptune pack covering BaseAudioCue
interface SoundPack {
  id: string;            // "chiptune"
  label: string;         // "Chiptune" (shown in the switcher)
  voice(cue: AudioCue): SoundSpec | null;       // discrete cue → sound (null = silent)
  ambient(tension: number): AmbientDirective;   // how THIS theme renders the bed at a tension
}

// manifest audio block
interface CampaignAudio {
  createDirector(): AudioDirector; // stateful: closes over the tension high-water-mark
  soundpacks: SoundPack[];         // [chiptune, scored?]; soundpacks[0] is the default
}
```

### Ownership rationale

- **Director is campaign-owned** because "what is worth hearing, and what is dreadful" is campaign
  knowledge — consistent with how campaigns already ship behavior functions (`dread`,
  `makeStoryteller`, condition predicates, door behaviors). Hollow House's
  `sanityToTension`/`cue-sound` logic moves here.
- **The director is a stateful factory** (`createDirector()`) because tension is normalized
  against the session **high-water-mark** sanity — that state belongs with the campaign, not the
  surface. Mirrors the existing `makeStoryteller(lore)` pattern.
- **SoundPacks are campaign-owned** because the `AudioCue` vocabulary is campaign-defined; a theme
  is a *rendering* of that vocabulary. The surface ships a **default chiptune pack** covering the
  `BaseAudioCue` set so a low-effort campaign (or one that omits `audio`) still gets sensible SFX
  for free; campaigns spread/override it: `{ ...defaultChiptunePack, voice: c => mine(c) ??
  defaultChiptunePack.voice(c) }`.
- **The theme is the swappable axis** independent of campaign flavor: the *same* tension signal
  renders as a detuned drone in chiptune and as crossfaded stems in "scored" — which is exactly
  why theme cannot live in the director.

### Scope for this work (audio)

Build the **full 4-layer architecture and seam**, but ship only the chiptune theme:

- Port today's `cue-sound.ts` + `tension.ts` into Hollow House's `AudioDirector` and a Hollow
  House **chiptune** `SoundPack`. `synth.ts` becomes the `SynthRenderer` backend. `ambient.ts`
  stays as the bed driven by `SoundPack.ambient(tension)`.
- The manifest carries `soundpacks[]`; `AudioManager` tracks an **active pack** and exposes a
  switch.
- A **player-facing theme switcher** in the monitor bezel appears **only when 2+ packs** exist
  (auto-hidden with one pack). Active-pack preference is in-memory (consistent with the existing
  mute toggle).
- `SampleRenderer` and an actual `scored` pack (with audio assets) are **deferred** — the
  `{ kind: "sample" }` arm of `SoundSpec` and the switcher are in place so they can be added
  later without touching the contracts.

Cue→sound for the **base vocabulary** stays universal via the default chiptune pack regardless of
whether a campaign supplies `audio`.

## Status bar: campaign-defined, cue-driven

Today the status bar hardcodes Sanity. Instead, the **campaign defines what the status bar shows
and pushes updates via cues** — the same "campaign owns presentation, surface renders what it's
handed" philosophy as the audio. The play surface holds **no** stat-specific knowledge.

The channel is a **status presentation cue** carrying the full bar state as an ordered field list:

```ts
interface StatusField { label: string; value: string; emphasis?: "normal" | "warn" | "critical" }
interface StatusCue  { kind: "status"; fields: StatusField[] }   // a PresentationCue variant
```

- The campaign **emits a `StatusCue`** (typically from its mechanics — `dread` already runs every
  round) at **boot** and **whenever a displayed value changes**. The cue payload *is* the
  declaration: the campaign sets both the fields shown and their values each emission. Hollow House
  emits e.g. `[{label:"Sanity", value:"12", emphasis:"warn"}, {label:"Round", value:"37/150"}]`.
- The **surface renders the most recent `StatusCue`** into the status bar; before any status cue
  it is empty/neutral. `emphasis` maps to styling (e.g. `critical` → red).
- This **removes the surface's `view.status.sanity` read** entirely. The generic HUD rows
  (`Here:` / `Carrying:` / `Exits:`) stay pull-based from the `ViewModel` as today; only the stat
  readout becomes campaign-driven.
- The **audio director** independently reads tension off the live `ICampaign` (engine-typed, like
  the mechanics), so no per-stat assumption leaks into the surface there either.

A campaign that emits no `StatusCue` (e.g. seed) simply shows an empty status bar — consistent
with omitting the `audio` block.

## Testing & migration

Incremental, each step keeps `pnpm checks` green:

1. **Manifest + boot inside current `play`.** Introduce `CampaignManifest`, `bootPlaySurface`, and
   the audio contracts in place; prove Hollow House boots through the manifest (no package moves
   yet). Replace the `main.ts` hardcoding and the `ui.ts` button string.
2. **Split out `@wickedways/play-surface`.** Move `core/`, `text/`, `audio/`, the contracts, the
   menu, and `bootPlaySurface` into the library package. Update imports.
3. **Split out `@wickedways/campaigns`.** Move `campaign/` → `campaigns/src/hollow-house/`, add its
   `manifest.ts`, director, and chiptune pack. Configure subpath exports.
4. **Add `campaigns/seed` + the menu.** Wrap `@wickedways/seed` as a manifest; shell registers
   both; verify the picker and deep-link.
5. **Docs.** Update `README.md` (root) and `packages/play/README.md`.

### Tests

- **Move with code:** existing unit tests follow their modules (parser/narrator/viewmodel/session/
  map/audio mapping → `play-surface`; campaign wiring → `campaigns/hollow-house`).
- **New:**
  - Campaign **registry / boot**: deep-link `?campaign=hollow-house` resolves; unknown slug falls
    to the menu; menu select boots the chosen campaign.
  - **AudioDirector** (Hollow House): tension curve incl. high-water-mark normalization; engine
    cue → audio cue mapping.
  - **SoundPack** mapping: base-vocabulary default chiptune pack covers every `BaseAudioCue`;
    campaign overrides win, fall through to default otherwise.
  - **Status bar**: a `StatusCue` renders its fields in order with the right `emphasis` styling;
    the latest cue replaces the previous; no cue → empty bar.
  - **No-audio / no-status campaign** (seed): boots with flat bed + generic SFX, switcher hidden,
    empty status bar.
- **e2e:** keep the winning Hollow-House playthrough green by **deep-linking**
  `?campaign=hollow-house` (preserves the existing run unchanged); add one menu-navigation test
  (menu → select → into a campaign → back to menu).

## Documentation (definition of done)

Per the project's standing convention, before the work is "done":

- Root `README.md`: document the `CampaignManifest` contract and the campaign-authoring story
  (how to add a campaign = add a folder + manifest, register in the shell).
- `packages/play/README.md`: update the source-layout table for the new package split, document
  the 4-layer audio architecture (director / soundpack / SoundSpec / backend), the cue-driven
  campaign-defined status bar, the campaign menu + deep-link, and the (single-pack) theme switcher.
- TSDoc on `CampaignManifest`, `bootPlaySurface`, and the audio contracts.

## Out of scope

- Authoring brand-new campaign content (the seed wrapper is the second menu entry).
- The `scored` soundpack, `SampleRenderer`, and any shipped audio assets (architecture only).
- Renaming or moving `@wickedways/seed`, `server`, `client`, or the Coolify deploy config.
- Persisting the audio theme/mute preference (stays in-memory).
