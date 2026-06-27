# Swappable Campaigns & Play Surfaces — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make campaigns and play surfaces modular and swappable — a `CampaignManifest` + `PlaySurface` contract, an in-launcher campaign menu + deep-link, campaign-owned cue-driven audio and status bar, and per-surface themes — so the play package can ship multiple campaigns the player chooses between.

**Architecture:** Split `packages/play` into a surface-independent `@wickedways/play-runtime` (session glue, contracts, audio engine, launcher) and `@wickedways/play-surface-crt` (the CRT terminal as the first `PlaySurface`). Consolidate campaigns into `@wickedways/campaigns` with per-campaign subpath exports. The work proceeds **feature-first inside the current single package** (keeping `pnpm checks` green) and **splits the packages last**.

**Tech Stack:** TypeScript (strict, `NodeNext`), pnpm workspaces, Vite (play SPA), Vitest (`node` env, co-located `*.test.ts`), Playwright (e2e). Engine consumed from source via `wickedways/lib/*` subpath exports.

## Global Constraints

- **TS strictness:** `strict` + `noUncheckedIndexedAccess` + `noImplicitOverride`, `NodeNext`. Indexed access yields `T | undefined` — handle it. Overrides carry `override`. Underscore-prefixed args are unused-exempt.
- **Determinism:** no `Date.now()`/`Math.random()`/`new Date()` in engine or runtime logic. Randomness via injected `rng: () => number`; clock via injected `now: () => number`. Audio pitch variation is derived deterministically (`detuneFactor(id)`), never random.
- **Protected state via Symbol seams** (`src/lib/inventory.ts`, `EMIT_CUE` in `src/lib/presentation.ts`) — do not add public mutable fields for forgeable state.
- **Branded IDs** via helpers — never cast raw `string` to a branded id.
- **Illegal transitions throw `ProceduralViolation`.**
- **Engine cue/effect sets are intentionally closed** — the only engine edits in this plan are the additive status-cue support in Task 1.
- **Co-located tests:** `foo.ts` ↔ `foo.test.ts`. Run the whole gate with `pnpm checks` (lint + typecheck + test). Vitest discovers `packages/*/src/**/*.test.ts` automatically.
- **Docs are living:** update `README.md` (root) + `packages/play/README.md` + TSDoc before done (Task 16).
- **Naming (verbatim):** packages `@wickedways/play-runtime`, `@wickedways/play-surface-crt`, `@wickedways/campaigns`; subpaths `@wickedways/campaigns/hollow-house`, `@wickedways/campaigns/seed`; surface id `"crt-terminal"`; campaign slugs `"hollow-house"`, `"seed"`; deep-link param `?campaign=<slug>`.

---

## File Structure (end state)

```
src/lib/presentation.ts                 (MOD) + StatusField, + {kind:"status"} cue
src/lib/mechanics/mechanic.ts           (MOD) + EffectKind.Status, + Effect arm
src/lib/mechanics/apply.ts              (MOD) + applier case

packages/play-runtime/                  (NEW pkg) surface-independent runtime + contracts
  src/contracts/manifest.ts             CampaignManifest, AliasMap
  src/contracts/surface.ts              PlaySurface, SurfaceHandle, Theme
  src/contracts/audio.ts                SoundSpec, SynthVoice, AudioCue, BaseAudioCue,
                                        AudioDirector, SoundPack, AmbientDirective, CampaignAudio
  src/session.ts                        GameSession (moved from play/core)
  src/intent.ts  viewmodel.ts  savestore.ts  map-model.ts   (moved)
  src/audio/engine.ts                   AudioEngine (moved synth.ts)
  src/audio/ambient.ts                  AmbientBed (moved)
  src/audio/renderer.ts                 SynthRenderer, SampleRenderer (stub)
  src/audio/default-pack.ts             defaultChiptunePack, defaultDirector
  src/audio/audio-runtime.ts            AudioRuntime (was AudioManager)
  src/launcher.ts                       bootLauncher (menu + deep-link)
  src/index.ts                          barrel of contracts + GameSession + bootLauncher + audio helpers

packages/play-surface-crt/              (NEW pkg) the CRT terminal PlaySurface
  src/surface.ts                        crtSurface: PlaySurface (was mountTerminal)
  src/parser.ts  narrator.ts  ui.ts  link-nouns.ts  map-view.ts   (moved from play/text)
  src/theme.ts                          CrtTheme, defaultCrtTheme, applyTheme
  src/index.ts                          export crtSurface, CrtTheme

packages/campaigns/                     (NEW pkg) all campaigns
  package.json                          exports { "./*": "./src/*/index.ts" }
  src/hollow-house/                      (moved from play/campaign) + manifest.ts, audio.ts, themes.ts, status.ts
  src/seed/index.ts                      thin manifest wrapping @wickedways/seed

packages/play/                          (KEEP) thin deploy shell
  src/main.ts                           imports campaigns + surfaces → bootLauncher
  e2e/playthrough.spec.ts               (MOD) deep-link + menu + theme tests
```

---

## PHASE 0 — Engine: first-class status cue

### Task 1: Add `EffectKind.Status` + `status` PresentationCue + applier wiring

**Files:**
- Modify: `src/lib/presentation.ts`
- Modify: `src/lib/mechanics/mechanic.ts`
- Modify: `src/lib/mechanics/apply.ts`
- Test: `src/lib/mechanics/apply.test.ts` (add a case; create the file if absent)

**Interfaces:**
- Produces: `StatusField { label: string; value: string; emphasis?: "normal" | "warn" | "critical" }` (exported from `presentation.ts`); `PresentationCue` gains `| { kind: "status"; fields: readonly StatusField[] }`; `EffectKind.Status === "status"`; `Effect` gains `| { kind: typeof EffectKind.Status; fields: readonly StatusField[] }`.

- [ ] **Step 1: Write the failing test**

Add to `src/lib/mechanics/apply.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { defineRegistry } from "../authoring/registry.js";
import { authorTemplate } from "../authoring/template-builder.js";
import { assemble } from "../authoring/assembler.js";
import { applyEffect } from "./apply.js";
import { EffectKind } from "./mechanic.js";
import type { PresentationCue } from "../presentation.js";

describe("applyEffect — status", () => {
  it("emits a status PresentationCue carrying the fields", () => {
    const registry = defineRegistry({ items: {} });
    const builder = authorTemplate("t", registry).room("R", { description: "r" }).startRoom("R");
    const { campaign } = assemble(builder.description, builder.registry);
    const cues: PresentationCue[] = [];
    campaign.onCue((c) => cues.push(c));

    applyEffect(campaign, {
      kind: EffectKind.Status,
      fields: [{ label: "Sanity", value: "12", emphasis: "warn" }],
    });

    expect(cues).toEqual([
      { kind: "status", fields: [{ label: "Sanity", value: "12", emphasis: "warn" }] },
    ]);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `pnpm vitest run src/lib/mechanics/apply.test.ts -t "status"`
Expected: FAIL — `EffectKind.Status` is `undefined` / type error on the `status` cue kind.

- [ ] **Step 3: Add `StatusField` + the `status` cue variant**

In `src/lib/presentation.ts`, after the `EntityRef` interface add:

```ts
/** One labelled readout in a campaign-defined status bar. */
export interface StatusField {
  label: string;
  value: string;
  emphasis?: "normal" | "warn" | "critical";
}
```

and add a variant to the `PresentationCue` union:

```ts
  | { kind: "mechanic"; cue: MechanicCue }
  | { kind: "status"; fields: readonly StatusField[] };
```

- [ ] **Step 4: Add `EffectKind.Status` + the `Effect` arm**

In `src/lib/mechanics/mechanic.ts`, import the type and extend the sets:

```ts
import type { AssetRef, StatusField } from "../presentation";
```

Add to `EffectKind`:

```ts
  Cue: "cue",
  Status: "status",
} as const;
```

Add to the `Effect` union:

```ts
  | { kind: typeof EffectKind.Cue; cue: MechanicCue }
  | { kind: typeof EffectKind.Status; fields: readonly StatusField[] };
```

- [ ] **Step 5: Wire the applier**

In `src/lib/mechanics/apply.ts`, add a case after `EffectKind.Cue`:

```ts
    case EffectKind.Status:
      campaign[EMIT_CUE]({ kind: "status", fields: e.fields });
      break;
```

- [ ] **Step 6: Run the test, verify it passes**

Run: `pnpm vitest run src/lib/mechanics/apply.test.ts -t "status"`
Expected: PASS

- [ ] **Step 7: Full gate + commit**

Run: `pnpm checks`
Expected: PASS (additive change; existing cue switches ignore the new kind).

```bash
git add src/lib/presentation.ts src/lib/mechanics/mechanic.ts src/lib/mechanics/apply.ts src/lib/mechanics/apply.test.ts
git commit -m "feat(engine): add EffectKind.Status + status presentation cue"
```

---

## PHASE 1 — `CampaignManifest` + boot via manifest (in-place)

### Task 2: Introduce `CampaignManifest`, a Hollow House manifest, and boot through it

**Files:**
- Create: `packages/play/src/core/manifest.ts`
- Create: `packages/play/src/campaign/manifest.ts`
- Create: `packages/play/src/campaign/manifest.test.ts`
- Modify: `packages/play/src/text/ui.ts` (add `buttonText` to `meta`)
- Modify: `packages/play/src/main.ts`

**Interfaces:**
- Consumes: `hauntedHouseTemplate`, `buildHauntedHouseRegistry`, `ALIASES`, `TITLE`, `INTRO` from `./campaign/index.js`; `Archetypes` from `./campaign/ids.js`; `GameSession.start`, `mountTerminal`.
- Produces: `CampaignManifest` (in `core/manifest.ts`); `hollowHouse: CampaignManifest` (in `campaign/manifest.ts`). `mountTerminal` meta becomes `{ title: string; intro: string; buttonText?: string }`.

- [ ] **Step 1: Write the failing test**

Create `packages/play/src/campaign/manifest.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { hollowHouse } from "./manifest.js";

describe("hollowHouse manifest", () => {
  it("declares identity + factories that build fresh each call", () => {
    expect(hollowHouse.slug).toBe("hollow-house");
    expect(hollowHouse.title).toBe("The Hollow House");
    expect(hollowHouse.blurb.length).toBeGreaterThan(0);
    expect(hollowHouse.playerName).toBe("Heir");
    expect(hollowHouse.archetype).toBe("heir");
    // factories return new instances
    expect(hollowHouse.builder()).not.toBe(hollowHouse.builder());
    expect(hollowHouse.registry()).not.toBe(hollowHouse.registry());
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `pnpm vitest run packages/play/src/campaign/manifest.test.ts`
Expected: FAIL — `./manifest.js` not found.

- [ ] **Step 3: Define the `CampaignManifest` type**

Create `packages/play/src/core/manifest.ts`:

```ts
import type { TemplateBuilder } from "wickedways/lib/authoring/template-builder";
import type { CampaignRegistry } from "wickedways/lib/serialization/registry";

export type AliasMap = Record<string, string[]>;

/** Everything the launcher needs to present and boot one campaign. */
export interface CampaignManifest {
  slug: string;
  title: string;
  blurb: string;
  intro: string;
  buttonText?: string;
  /** Fresh builder per boot/restart. */
  builder: () => TemplateBuilder<string, string>;
  /** Fresh registry per boot. */
  registry: () => CampaignRegistry;
  aliases: AliasMap;
  playerName: string;
  archetype: string;
  // surface, themes, and audio are added in later tasks.
}
```

- [ ] **Step 4: Author the Hollow House manifest**

Create `packages/play/src/campaign/manifest.ts`:

```ts
import type { CampaignManifest } from "../core/manifest.js";
import { hauntedHouseTemplate, buildHauntedHouseRegistry, ALIASES, TITLE, INTRO } from "./index.js";
import { Archetypes } from "./ids.js";

export const hollowHouse: CampaignManifest = {
  slug: "hollow-house",
  title: TITLE,
  blurb: "A nine-room haunted estate. Reach the attic with the journal before the dark takes your mind.",
  intro: INTRO,
  buttonText: "Enter Hollow House",
  builder: hauntedHouseTemplate,
  registry: buildHauntedHouseRegistry,
  aliases: ALIASES,
  playerName: "Heir",
  archetype: Archetypes.Heir,
};
```

- [ ] **Step 5: Run the test, verify it passes**

Run: `pnpm vitest run packages/play/src/campaign/manifest.test.ts`
Expected: PASS

- [ ] **Step 6: Thread `buttonText` through the terminal**

In `packages/play/src/text/ui.ts`, change the `mountTerminal` signature:

```ts
export function mountTerminal(
  root: HTMLElement,
  session: GameSession,
  meta: { title: string; intro: string; buttonText?: string },
): void {
```

Find the welcome-screen button literal `"Enter Hollow House"` and replace with:

```ts
meta.buttonText ?? `Enter ${meta.title}`
```

- [ ] **Step 7: Boot from the manifest in `main.ts`**

Replace `packages/play/src/main.ts` body with:

```ts
import "@fontsource/vt323";
import "@fontsource/silkscreen";
import { GameSession } from "./core/session.js";
import { LocalStorageSaveStore } from "./core/savestore.js";
import { hollowHouse } from "./campaign/manifest.js";
import { mountTerminal } from "./text/ui.js";

const app = document.getElementById("app");
if (app) {
  const m = hollowHouse;
  const session = GameSession.start({
    builder: m.builder(),
    registry: m.registry(),
    aliases: m.aliases,
    playerName: m.playerName,
    archetype: m.archetype,
    saveStore: new LocalStorageSaveStore(),
    now: () => Date.now(),
  });
  mountTerminal(app, session, { title: m.title, intro: m.intro, buttonText: m.buttonText });
}
```

- [ ] **Step 8: Full gate + commit**

Run: `pnpm checks`
Expected: PASS

```bash
git add packages/play/src/core/manifest.ts packages/play/src/campaign/manifest.ts packages/play/src/campaign/manifest.test.ts packages/play/src/text/ui.ts packages/play/src/main.ts
git commit -m "feat(play): boot Hollow House through a CampaignManifest"
```

---

## PHASE 2 — Cue-driven, campaign-defined status bar (in-place)

### Task 3: Hollow House emits a status cue; the terminal renders it

**Files:**
- Create: `packages/play/src/campaign/status.ts`
- Create: `packages/play/src/campaign/status.test.ts`
- Modify: `packages/play/src/campaign/ids.ts` (add `Mechanics.StatusBar`)
- Modify: `packages/play/src/campaign/index.ts` (register + use the mechanic)
- Modify: `packages/play/src/text/ui.ts` (render status cue; drop `vm.status.sanity` read)

**Interfaces:**
- Consumes: `Mechanic`, `EffectKind`, `StatusField`, `TurnCtx`/`HookCtx` from the engine; `StatType` from `wickedways/lib/character/stats`.
- Produces: `statusBar: Mechanic<JsonObject>` (in `campaign/status.ts`); the terminal tracks the latest `{ kind: "status" }` cue and renders it.

- [ ] **Step 1: Write the failing test**

Create `packages/play/src/campaign/status.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { EffectKind } from "wickedways/lib/mechanics/mechanic";
import { statusBar } from "./status.js";

function ctx(sanity: number, round: number) {
  return {
    state: {},
    rng: () => 0.5,
    roll: () => 1,
    view: { round, maxRounds: 150, party: [], rooms: [] },
    actor: { id: "pc", name: "Heir", health: 12, sanity, energy: 5, status: [], roomId: "R",
      hasEquipped: () => false, hasItem: () => false },
  } as never;
}

describe("statusBar mechanic", () => {
  it("emits a status effect with Sanity + Round fields, escalating emphasis", () => {
    const effects = statusBar.onTurnEnd!(ctx(2, 37)) ?? [];
    expect(effects).toEqual([
      { kind: EffectKind.Status, fields: [
        { label: "Sanity", value: "2", emphasis: "critical" },
        { label: "Round", value: "37/150" },
      ] },
    ]);
  });

  it("warns in the mid band and stays normal when healthy", () => {
    const warn = statusBar.onTurnEnd!(ctx(5, 1)) ?? [];
    expect((warn[0] as { fields: { emphasis?: string }[] }).fields[0]!.emphasis).toBe("warn");
    const ok = statusBar.onTurnEnd!(ctx(12, 1)) ?? [];
    expect((ok[0] as { fields: { emphasis?: string }[] }).fields[0]!.emphasis).toBe("normal");
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `pnpm vitest run packages/play/src/campaign/status.test.ts`
Expected: FAIL — `./status.js` not found.

- [ ] **Step 3: Implement the `statusBar` mechanic**

Create `packages/play/src/campaign/status.ts`:

```ts
import { EffectKind, type Mechanic, type JsonObject, type TurnCtx, type HookCtx } from "wickedways/lib/mechanics/mechanic";
import type { Effect } from "wickedways/lib/mechanics/mechanic";
import type { StatusField } from "wickedways/lib/presentation";

function emphasisFor(sanity: number): StatusField["emphasis"] {
  if (sanity <= 3) return "critical";
  if (sanity <= 6) return "warn";
  return "normal";
}

function fields(sanity: number, round: number, maxRounds: number): Effect[] {
  return [{
    kind: EffectKind.Status,
    fields: [
      { label: "Sanity", value: String(sanity), emphasis: emphasisFor(sanity) },
      { label: "Round", value: `${round}/${maxRounds}` },
    ],
  }];
}

/** Pushes a campaign-defined status readout (Sanity + Round) to the play surface. */
export const statusBar: Mechanic<JsonObject> = {
  initialState: () => ({}),
  // Initial paint at round start (party may be empty pre-boot → emit nothing).
  onRoundStart: (h: HookCtx<JsonObject>) => {
    const pc = h.view.party[0];
    return pc ? fields(pc.sanity, h.view.round, h.view.maxRounds) : [];
  },
  // After each turn's effects (e.g. dread), so values are current.
  onTurnEnd: (h: TurnCtx<JsonObject>) =>
    fields(h.actor.sanity, h.view.round, h.view.maxRounds),
};
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `pnpm vitest run packages/play/src/campaign/status.test.ts`
Expected: PASS

- [ ] **Step 5: Register + enable the mechanic**

In `packages/play/src/campaign/ids.ts`, extend `Mechanics`:

```ts
export const Mechanics = { Dread: "dread", Storyteller: "storyteller", StatusBar: "status-bar" } as const;
```

In `packages/play/src/campaign/index.ts`: import `statusBar`, register it, and enable it. Add the import near the others:

```ts
import { statusBar } from "./status.js";
```

In `buildHauntedHouseRegistry`'s `mechanics` object add:

```ts
    mechanics: { [Mechanics.Dread]: dread, [Mechanics.Storyteller]: makeStoryteller(LORE), [Mechanics.StatusBar]: statusBar },
```

In `hauntedHouseTemplate`, after the existing `.useMechanic(...)` calls add:

```ts
    .useMechanic(Mechanics.StatusBar)
```

- [ ] **Step 6: Render the status cue in the terminal (drop the Sanity read)**

In `packages/play/src/text/ui.ts`:
- Add a module-scoped latest-status holder updated whenever a `{ kind: "status" }` cue is seen. After `session.execute`/`read`/initial boot, scan returned cues for `cue.kind === "status"` and store `cue.fields` in a `let latestStatus: readonly StatusField[] = []`.
- Replace the status-bar render line. Change:

```ts
`${vm.status.locationName}  ·  turn ${vm.status.turn}/${vm.status.maxTurns}  ·  Sanity ${vm.status.sanity}`
```

to a render derived from `latestStatus`:

```ts
[vm.status.locationName, ...latestStatus.map((f) => `${f.label} ${f.value}`)].join("  ·  ")
```

and apply `emphasis` to styling (add a CSS class per field where `emphasis === "critical"` / `"warn"`). Import the type at the top: `import type { StatusField } from "wickedways/lib/presentation";`.

> Note: the location still comes from the view model (generic HUD). Only the stat readouts come from the campaign cue. Before any status cue, `latestStatus` is `[]` and the bar shows just the location.

- [ ] **Step 7: Full gate + commit**

Run: `pnpm checks`
Expected: PASS

```bash
git add packages/play/src/campaign/status.ts packages/play/src/campaign/status.test.ts packages/play/src/campaign/ids.ts packages/play/src/campaign/index.ts packages/play/src/text/ui.ts
git commit -m "feat(play): campaign-defined cue-driven status bar"
```

---

## PHASE 3 — Audio re-architecture (in-place)

### Task 4: `SoundSpec` union + `SynthVoice` rename + `SynthRenderer`/`SampleRenderer`

**Files:**
- Create: `packages/play/src/audio/contracts.ts`
- Create: `packages/play/src/audio/renderer.ts`
- Create: `packages/play/src/audio/renderer.test.ts`
- Modify: `packages/play/src/audio/cue-sound.ts` (rename exported `SoundSpec` → `SynthVoice`)
- Modify: `packages/play/src/audio/synth.ts` (`AudioEngine.play(voice: SynthVoice)`)

**Interfaces:**
- Produces: `SynthVoice` (the old `SoundSpec` shape: `{ source: Waveform | "noise"; freq; endFreq?; duration; gain; attack }`); `SoundSpec = { kind: "synth"; voice: SynthVoice } | { kind: "sample"; asset: AudioBuffer | string; gain?: number; pan?: number }`; `Renderer { render(spec: SoundSpec): void }`; `SynthRenderer implements Renderer` (renders the `synth` arm via `AudioEngine`); `SampleRenderer implements Renderer` (no-op stub for `sample`).

- [ ] **Step 1: Write the failing test**

Create `packages/play/src/audio/renderer.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { SynthRenderer, SampleRenderer } from "./renderer.js";
import type { SynthVoice } from "./cue-sound.js";

describe("SynthRenderer", () => {
  it("plays the voice of a synth SoundSpec through the engine", () => {
    const play = vi.fn();
    const r = new SynthRenderer({ play } as never);
    const voice: SynthVoice = { source: "square", freq: 440, duration: 0.1, gain: 0.2, attack: 0.01 };
    r.render({ kind: "synth", voice });
    expect(play).toHaveBeenCalledWith(voice);
  });
  it("ignores sample specs for now (deferred)", () => {
    const play = vi.fn();
    new SynthRenderer({ play } as never).render({ kind: "sample", asset: "x" });
    expect(play).not.toHaveBeenCalled();
  });
});

describe("SampleRenderer", () => {
  it("is a no-op stub (scored audio deferred)", () => {
    expect(() => new SampleRenderer().render({ kind: "sample", asset: "x" })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm vitest run packages/play/src/audio/renderer.test.ts`
Expected: FAIL — `./renderer.js` not found.

- [ ] **Step 3: Rename `SoundSpec` → `SynthVoice` in `cue-sound.ts`**

In `packages/play/src/audio/cue-sound.ts` rename the interface `SoundSpec` to `SynthVoice` and update its references in that file (`soundForCue(): SynthVoice | null`, `soundForMobAttack(): SynthVoice`, `errorSound(): SynthVoice`). In `packages/play/src/audio/synth.ts` update `AudioEngine.play(spec: SoundSpec)` → `play(voice: SynthVoice)` and its import.

- [ ] **Step 4: Define the `SoundSpec` union + renderers**

Create `packages/play/src/audio/contracts.ts`:

```ts
import type { SynthVoice } from "./cue-sound.js";

export type SoundSpec =
  | { kind: "synth"; voice: SynthVoice }
  | { kind: "sample"; asset: AudioBuffer | string; gain?: number; pan?: number };

export interface Renderer { render(spec: SoundSpec): void }
```

Create `packages/play/src/audio/renderer.js` source `renderer.ts`:

```ts
import type { AudioEngine } from "./synth.js";
import type { Renderer, SoundSpec } from "./contracts.js";

/** Renders the `synth` arm of a SoundSpec through the procedural engine. */
export class SynthRenderer implements Renderer {
  constructor(private readonly engine: AudioEngine) {}
  render(spec: SoundSpec): void {
    if (spec.kind === "synth") this.engine.play(spec.voice);
    // sample specs are deferred (handled by SampleRenderer once built)
  }
}

/** Stub for scored/sample playback — deferred (architecture only). */
export class SampleRenderer implements Renderer {
  render(_spec: SoundSpec): void { /* deferred: scored audio assets + buffer playback */ }
}
```

- [ ] **Step 5: Run, verify pass**

Run: `pnpm vitest run packages/play/src/audio/renderer.test.ts`
Expected: PASS

- [ ] **Step 6: Full gate + commit**

Run: `pnpm checks`
Expected: PASS (audio-manager still compiles; it constructs an `AudioEngine` and calls `play` with what `soundForCue` returns — now typed `SynthVoice`).

```bash
git add packages/play/src/audio/contracts.ts packages/play/src/audio/renderer.ts packages/play/src/audio/renderer.test.ts packages/play/src/audio/cue-sound.ts packages/play/src/audio/synth.ts
git commit -m "refactor(play): SoundSpec union + SynthVoice rename + renderers"
```

---

### Task 5: Audio cue vocabulary, director/pack contracts, and the default chiptune pack

**Files:**
- Modify: `packages/play/src/audio/contracts.ts` (add cue/director/pack types)
- Create: `packages/play/src/audio/default-pack.ts`
- Create: `packages/play/src/audio/default-pack.test.ts`

**Interfaces:**
- Consumes: `PresentationCue` (engine), `ViewModel` (`core/viewmodel`), `ICampaign` (engine), `MobAttack` (`core/session`), `SoundSpec`, `soundForCue`/`soundForMobAttack`/`errorSound` (`cue-sound`).
- Produces (in `contracts.ts`):
  - `type BaseAudioCue = "strike" | "death" | "pickup" | "drop" | "move" | "light" | "encounter" | "win" | "lose" | "error"`
  - `interface AudioCue { type: BaseAudioCue | (string & {}); entityId?: string; intensity?: number }`
  - `interface AudioDirector { react(cue: PresentationCue, view: ViewModel): AudioCue[]; tension(campaign: ICampaign): number }`
  - `type AmbientDirective = { bedTension: number }`
  - `interface SoundPack { id: string; label: string; voice(cue: AudioCue): SoundSpec | null; ambient(tension: number): AmbientDirective }`
  - `interface CampaignAudio { createDirector(): AudioDirector; soundpacks: SoundPack[] }`
- Produces (in `default-pack.ts`): `defaultChiptunePack: SoundPack`; `defaultDirector(): AudioDirector` (maps engine cues to base AudioCues; tension always 0).

- [ ] **Step 1: Write the failing test**

Create `packages/play/src/audio/default-pack.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { defaultChiptunePack, defaultDirector } from "./default-pack.js";
import type { AudioCue, BaseAudioCue } from "./contracts.js";

const BASE: BaseAudioCue[] = ["strike","death","pickup","drop","move","light","encounter","win","lose","error"];

describe("defaultChiptunePack", () => {
  it("returns a synth SoundSpec for every base cue", () => {
    for (const type of BASE) {
      const spec = defaultChiptunePack.voice({ type } as AudioCue);
      expect(spec, type).not.toBeNull();
      expect(spec!.kind).toBe("synth");
    }
  });
  it("maps tension straight through to bed tension", () => {
    expect(defaultChiptunePack.ambient(0.7)).toEqual({ bedTension: 0.7 });
  });
});

describe("defaultDirector", () => {
  it("translates an action attack cue into a strike AudioCue and reports zero tension", () => {
    const d = defaultDirector();
    const cues = d.react({ kind: "action", action: "attack", actor: { id: "m", name: "Wraith" } }, {} as never);
    expect(cues.some((c) => c.type === "strike")).toBe(true);
    expect(d.tension({} as never)).toBe(0);
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm vitest run packages/play/src/audio/default-pack.test.ts`
Expected: FAIL — `./default-pack.js` not found.

- [ ] **Step 3: Add the cue/director/pack contracts**

Append to `packages/play/src/audio/contracts.ts`:

```ts
import type { PresentationCue } from "wickedways/lib/presentation";
import type { ICampaign } from "wickedways/lib/campaign";
import type { ViewModel } from "../core/viewmodel.js";

export type BaseAudioCue =
  | "strike" | "death" | "pickup" | "drop" | "move"
  | "light" | "encounter" | "win" | "lose" | "error";

export interface AudioCue { type: BaseAudioCue | (string & {}); entityId?: string; intensity?: number }

export interface AudioDirector {
  react(cue: PresentationCue, view: ViewModel): AudioCue[];
  tension(campaign: ICampaign): number;
}

export type AmbientDirective = { bedTension: number };

export interface SoundPack {
  id: string;
  label: string;
  voice(cue: AudioCue): SoundSpec | null;
  ambient(tension: number): AmbientDirective;
}

export interface CampaignAudio {
  createDirector(): AudioDirector;
  soundpacks: SoundPack[];
}
```

- [ ] **Step 4: Implement the default director + chiptune pack**

Create `packages/play/src/audio/default-pack.ts`. The director reuses today's cue→sound *trigger* logic to decide which base cue fires; the pack wraps the existing `SynthVoice` mapping into `{ kind: "synth" }`.

```ts
import { soundForCue, soundForMobAttack, errorSound, type SynthVoice } from "./cue-sound.js";
import type { AudioCue, AudioDirector, SoundPack, SoundSpec } from "./contracts.js";

// Maps an engine PresentationCue to base AudioCue(s). Mirrors the prior soundForCue triggers.
function cuesFor(cue: Parameters<AudioDirector["react"]>[0]): AudioCue[] {
  switch (cue.kind) {
    case "action":
      switch (cue.action) {
        case "attack": case "takeDamage": return [{ type: "strike", entityId: cue.actor.id }];
        case "pickUp": return [{ type: "pickup", entityId: cue.actor.id }];
        case "drop": return [{ type: "drop", entityId: cue.actor.id }];
        case "move": return [{ type: "move", entityId: cue.actor.id }];
        default: return [];
      }
    case "encounter": return [{ type: "encounter", entityId: cue.mob.id }];
    case "visibility": return [{ type: "light" }];
    case "resolution": return [{ type: cue.outcome === "victory" ? "win" : "lose" }];
    default: return [];
  }
}

// Base cue → SynthVoice. Re-uses the original cue-sound voices by reconstructing a
// representative PresentationCue, so the chiptune timbre is unchanged.
function voiceFor(cue: AudioCue): SynthVoice | null {
  switch (cue.type) {
    case "strike": return soundForMobAttack({ name: "", stat: "sanity" as never, amount: 1 });
    case "error": return errorSound();
    case "pickup": return soundForCue({ kind: "action", action: "pickUp", actor: { id: cue.entityId ?? "", name: "" } });
    case "drop": return soundForCue({ kind: "action", action: "drop", actor: { id: cue.entityId ?? "", name: "" } });
    case "move": return soundForCue({ kind: "action", action: "move", actor: { id: cue.entityId ?? "", name: "" } });
    case "light": return soundForCue({ kind: "visibility", room: { id: "", name: "" }, lit: true });
    case "encounter": return soundForCue({ kind: "encounter", mob: { id: cue.entityId ?? "", name: "" }, room: { id: "", name: "" } });
    case "death": return soundForMobAttack({ name: "", stat: "sanity" as never, amount: 1 });
    case "win": return soundForCue({ kind: "resolution", outcome: "victory" });
    case "lose": return soundForCue({ kind: "resolution", outcome: "defeat" });
    default: return null;
  }
}

export const defaultChiptunePack: SoundPack = {
  id: "chiptune",
  label: "Chiptune",
  voice: (cue): SoundSpec | null => {
    const v = voiceFor(cue);
    return v ? { kind: "synth", voice: v } : null;
  },
  ambient: (t) => ({ bedTension: t }),
};

export function defaultDirector(): AudioDirector {
  return { react: (cue) => cuesFor(cue), tension: () => 0 };
}
```

> If any reconstructed cue above does not type-check against the engine's `ActionKind`/outcome literals, adjust to the exact literals returned by `soundForCue` (check `cue-sound.ts`); the goal is byte-identical chiptune output to the pre-refactor mapping.

- [ ] **Step 5: Run, verify pass**

Run: `pnpm vitest run packages/play/src/audio/default-pack.test.ts`
Expected: PASS

- [ ] **Step 6: Full gate + commit**

Run: `pnpm checks`
Expected: PASS

```bash
git add packages/play/src/audio/contracts.ts packages/play/src/audio/default-pack.ts packages/play/src/audio/default-pack.test.ts
git commit -m "feat(play): audio cue vocabulary, director/pack contracts, default chiptune pack"
```

---

### Task 6: Hollow House `AudioDirector` (custom cues + sanity tension)

**Files:**
- Create: `packages/play/src/campaign/audio.ts`
- Create: `packages/play/src/campaign/audio.test.ts`

**Interfaces:**
- Consumes: `AudioDirector`, `AudioCue` (`audio/contracts`); `defaultDirector` (`audio/default-pack`); `sanityToTension` (`audio/tension`); `StatType`, `ICampaign` (engine).
- Produces: `createHollowHouseDirector(): AudioDirector` (delegates `react` to the default mapping; `tension` reads the party's Sanity against a session high-water-mark closure); `hollowHouseAudio: CampaignAudio` (`{ createDirector: createHollowHouseDirector, soundpacks: [defaultChiptunePack] }`).

- [ ] **Step 1: Write the failing test**

Create `packages/play/src/campaign/audio.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createHollowHouseDirector } from "./audio.js";

function campaignWithSanity(s: number) {
  return { party: [{ effectiveStat: () => s }] } as never;
}

describe("Hollow House AudioDirector tension", () => {
  it("is calm (0) at the high-water baseline and rises as sanity falls", () => {
    const d = createHollowHouseDirector();
    expect(d.tension(campaignWithSanity(16))).toBe(0);     // sets baseline 16
    expect(d.tension(campaignWithSanity(8))).toBeCloseTo(0.5, 5);
    expect(d.tension(campaignWithSanity(0))).toBe(1);
  });
  it("keeps the baseline as the max seen (recovering sanity lowers tension, never the baseline)", () => {
    const d = createHollowHouseDirector();
    d.tension(campaignWithSanity(10));                      // baseline 10
    d.tension(campaignWithSanity(20));                      // baseline rises to 20
    expect(d.tension(campaignWithSanity(10))).toBeCloseTo(0.5, 5);
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm vitest run packages/play/src/campaign/audio.test.ts`
Expected: FAIL — `./audio.js` not found.

- [ ] **Step 3: Implement the director + campaign audio**

Create `packages/play/src/campaign/audio.ts`:

```ts
import { StatType } from "wickedways/lib/character/stats";
import type { ICampaign } from "wickedways/lib/campaign";
import type { AudioDirector, CampaignAudio } from "../audio/contracts.js";
import { defaultDirector, defaultChiptunePack } from "../audio/default-pack.js";
import { sanityToTension } from "../audio/tension.js";

/** Discrete cues use the base mapping; tension is sanity vs. a session high-water-mark. */
export function createHollowHouseDirector(): AudioDirector {
  const base = defaultDirector();
  let baseline = 0; // high-water-mark sanity seen this session
  return {
    react: base.react,
    tension: (c: ICampaign) => {
      const sanity = c.party[0]?.effectiveStat(StatType.Sanity) ?? 0;
      baseline = Math.max(baseline, sanity);
      return sanityToTension(sanity, baseline);
    },
  };
}

export const hollowHouseAudio: CampaignAudio = {
  createDirector: createHollowHouseDirector,
  soundpacks: [defaultChiptunePack],
};
```

- [ ] **Step 4: Run, verify pass**

Run: `pnpm vitest run packages/play/src/campaign/audio.test.ts`
Expected: PASS

- [ ] **Step 5: Full gate + commit**

Run: `pnpm checks`
Expected: PASS

```bash
git add packages/play/src/campaign/audio.ts packages/play/src/campaign/audio.test.ts
git commit -m "feat(play): Hollow House AudioDirector (sanity tension + base cues)"
```

---

### Task 7: `AudioRuntime` + manifest `audio` + soundpack switcher

**Files:**
- Create: `packages/play/src/audio/audio-runtime.ts`
- Create: `packages/play/src/audio/audio-runtime.test.ts`
- Modify: `packages/play/src/core/manifest.ts` (add `audio?: CampaignAudio`)
- Modify: `packages/play/src/campaign/manifest.ts` (set `audio: hollowHouseAudio`)
- Modify: `packages/play/src/text/ui.ts` (use `AudioRuntime`; render soundpack switcher when ≥2 packs)
- Delete: `packages/play/src/audio/audio-manager.ts` (+ its test) once replaced

**Interfaces:**
- Consumes: `CampaignAudio`, `AudioDirector`, `SoundPack`, `Renderer`, `AmbientDirective` (`audio/contracts`); `defaultDirector`, `defaultChiptunePack` (`audio/default-pack`); `SynthRenderer`, `SampleRenderer` (`audio/renderer`); `AudioEngine` (`synth`), `AmbientBed` (`ambient`); `PresentationCue`, `ICampaign`, `ViewModel`, `MobAttack`.
- Produces: `class AudioRuntime` with `static forCampaign(audio: CampaignAudio | undefined, deps?): AudioRuntime`; methods `get enabled`, `setEnabled(on)`, `playCue(cue, view)`, `playMobAttack(atk)`, `noteError()`, `update(campaign)`, `soundpacks: { id; label }[]`, `setSoundpack(id)`.

- [ ] **Step 1: Write the failing test**

Create `packages/play/src/audio/audio-runtime.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { AudioRuntime } from "./audio-runtime.js";
import { defaultChiptunePack } from "./default-pack.js";

function deps() {
  return {
    render: vi.fn(),
    bed: { setTension: vi.fn(), start: vi.fn(), stop: vi.fn(), get running() { return true; } },
    engine: { resume: () => true, suspend: () => {}, close: () => {}, get context() { return {} as never; }, play: vi.fn() },
  };
}

describe("AudioRuntime", () => {
  it("routes a cue through director → active pack → renderer when enabled", () => {
    const d = deps();
    const rt = AudioRuntime.forCampaign(undefined, d as never);
    rt.setEnabled(true);
    rt.playCue({ kind: "action", action: "move", actor: { id: "pc", name: "" } }, {} as never);
    expect(d.render).toHaveBeenCalledTimes(1);
    expect((d.render.mock.calls[0]![0] as { kind: string }).kind).toBe("synth");
  });
  it("stays silent when disabled", () => {
    const d = deps();
    const rt = AudioRuntime.forCampaign(undefined, d as never);
    rt.playCue({ kind: "action", action: "move", actor: { id: "pc", name: "" } }, {} as never);
    expect(d.render).not.toHaveBeenCalled();
  });
  it("exposes the campaign soundpacks for the switcher", () => {
    const d = deps();
    const rt = AudioRuntime.forCampaign({ createDirector: () => ({ react: () => [], tension: () => 0 }), soundpacks: [defaultChiptunePack] }, d as never);
    expect(rt.soundpacks).toEqual([{ id: "chiptune", label: "Chiptune" }]);
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm vitest run packages/play/src/audio/audio-runtime.test.ts`
Expected: FAIL — `./audio-runtime.js` not found.

- [ ] **Step 3: Implement `AudioRuntime`**

Create `packages/play/src/audio/audio-runtime.ts`:

```ts
import type { PresentationCue } from "wickedways/lib/presentation";
import type { ICampaign } from "wickedways/lib/campaign";
import type { ViewModel } from "../core/viewmodel.js";
import type { MobAttack } from "../core/session.js";
import type { AudioDirector, CampaignAudio, Renderer, SoundPack } from "./contracts.js";
import { defaultChiptunePack, defaultDirector } from "./default-pack.js";
import { SynthRenderer } from "./renderer.js";
import { AudioEngine } from "./synth.js";
import { AmbientBed } from "./ambient.js";
import { soundForMobAttack, errorSound } from "./cue-sound.js";

interface AudioDeps { render: Renderer["render"]; bed: AmbientBed; engine: AudioEngine }

export class AudioRuntime {
  #enabled = false;
  private constructor(
    private readonly deps: AudioDeps,
    private readonly director: AudioDirector,
    private readonly packs: SoundPack[],
    private active: SoundPack,
  ) {}

  static forCampaign(audio: CampaignAudio | undefined, deps?: Partial<AudioDeps>): AudioRuntime {
    const engine = deps?.engine ?? new AudioEngine();
    const bed = deps?.bed ?? new AmbientBed();
    const renderer = deps?.render ?? ((spec) => new SynthRenderer(engine).render(spec));
    const director = audio ? audio.createDirector() : defaultDirector();
    const packs = audio?.soundpacks?.length ? audio.soundpacks : [defaultChiptunePack];
    return new AudioRuntime({ render: renderer, bed, engine }, director, packs, packs[0]!);
  }

  get enabled(): boolean { return this.#enabled; }
  setEnabled(on: boolean): void {
    this.#enabled = on;
    if (on) { this.deps.engine.resume(); if (!this.deps.bed.running) this.deps.bed.start(this.deps.engine.context!); }
    else { this.deps.bed.stop(); this.deps.engine.suspend(); }
  }

  get soundpacks(): { id: string; label: string }[] { return this.packs.map((p) => ({ id: p.id, label: p.label })); }
  setSoundpack(id: string): void { const p = this.packs.find((x) => x.id === id); if (p) this.active = p; }

  playCue(cue: PresentationCue, view: ViewModel): void {
    if (!this.#enabled) return;
    for (const ac of this.director.react(cue, view)) {
      const spec = this.active.voice(ac);
      if (spec) this.deps.render(spec);
    }
  }
  playMobAttack(_atk: MobAttack): void {
    if (!this.#enabled) return;
    this.deps.render({ kind: "synth", voice: soundForMobAttack(_atk) });
  }
  noteError(): void { if (this.#enabled) this.deps.render({ kind: "synth", voice: errorSound() }); }

  update(campaign: ICampaign): void {
    if (!this.#enabled) return;
    const directive = this.active.ambient(this.director.tension(campaign));
    this.deps.bed.setTension(directive.bedTension);
  }
}
```

- [ ] **Step 4: Run, verify pass**

Run: `pnpm vitest run packages/play/src/audio/audio-runtime.test.ts`
Expected: PASS

- [ ] **Step 5: Add `audio` to the manifest + Hollow House**

In `packages/play/src/core/manifest.ts` add the import and field:

```ts
import type { CampaignAudio } from "../audio/contracts.js";
// in CampaignManifest:
  audio?: CampaignAudio;
```

In `packages/play/src/campaign/manifest.ts` import and set it:

```ts
import { hollowHouseAudio } from "./audio.js";
// in the object:
  audio: hollowHouseAudio,
```

- [ ] **Step 6: Switch the terminal to `AudioRuntime`**

In `packages/play/src/text/ui.ts`:
- Replace `new AudioManager()` with `AudioRuntime.forCampaign(meta.audio)` — thread the manifest's `audio` into `mountTerminal` meta: extend meta to `{ title; intro; buttonText?; audio?: CampaignAudio }` and pass `audio: m.audio` from `main.ts`.
- Replace `audio.update(vm.status.sanity)` with `audio.update(session.campaign)` — the runtime now reads tension off the live campaign. Expose the campaign: add a getter `get campaign(): Campaign { return this.campaign; }` to `GameSession` (it currently holds `private campaign`). (If a getter already exists, reuse it.)
- Replace `audio.playCue(cue)` calls with `audio.playCue(cue, vm)`.
- Add a **soundpack switcher** in the bezel next to the mute button: render a small selector listing `audio.soundpacks`; on change call `audio.setSoundpack(id)`. **Hide it when `audio.soundpacks.length < 2`.**
- Remove the `import { AudioManager }` line; add `import { AudioRuntime } from "../audio/audio-runtime.js"; import type { CampaignAudio } from "../audio/contracts.js";`.

In `packages/play/src/main.ts` pass `audio: m.audio` in the `mountTerminal` meta.

- [ ] **Step 7: Delete the old `AudioManager`**

```bash
git rm packages/play/src/audio/audio-manager.ts
# remove packages/play/src/audio/audio-manager.test.ts if present (its behavior is now covered by audio-runtime.test.ts)
git rm packages/play/src/audio/audio-manager.test.ts 2>/dev/null || true
```

Grep for any remaining `AudioManager` references and update them: `grep -rn "AudioManager" packages/play/src`.

- [ ] **Step 8: Full gate + commit**

Run: `pnpm checks`
Expected: PASS

```bash
git add -A packages/play/src
git commit -m "feat(play): AudioRuntime + campaign audio + soundpack switcher"
```

---

## PHASE 4 — `PlaySurface` + `Theme` + launcher (in-place)

### Task 8: `PlaySurface`/`Theme` contracts; wrap the terminal as `crtSurface`

**Files:**
- Create: `packages/play/src/core/surface.ts` (`PlaySurface`, `SurfaceHandle`, `Theme`)
- Create: `packages/play/src/text/theme.ts` (`CrtTheme`, `defaultCrtTheme`, `applyTheme`)
- Create: `packages/play/src/text/surface.ts` (`crtSurface: PlaySurface`)
- Create: `packages/play/src/text/surface.test.ts`
- Modify: `packages/play/src/text/ui.ts` (`mountTerminal` returns a teardown; accept `onExit`, `themes`, `audio`)

**Interfaces:**
- Produces:
  - `interface SurfaceHandle { unmount(): void }`
  - `interface Theme { id: string; label: string }`
  - `interface PlaySurface { id: string; label: string; defaultTheme: Theme; mount(args: MountArgs): SurfaceHandle }`
  - `interface MountArgs { app: HTMLElement; session: GameSession; manifest: CampaignManifest; themes: Theme[]; audio: AudioRuntime; onExit(): void }`
  - `crtSurface: PlaySurface` with `id: "crt-terminal"`, `defaultTheme: defaultCrtTheme`.
  - `interface CrtTheme extends Theme { palette: {...}; fonts: {...}; effects: {...} }`, `applyTheme(root: HTMLElement, theme: CrtTheme): void`.

- [ ] **Step 1: Write the failing test**

Create `packages/play/src/text/surface.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { crtSurface } from "./surface.js";

describe("crtSurface", () => {
  it("identifies as crt-terminal with a default theme", () => {
    expect(crtSurface.id).toBe("crt-terminal");
    expect(crtSurface.defaultTheme.id).toBeTruthy();
  });
  it("mount returns a handle whose unmount clears the container", () => {
    const app = document.createElement("div");
    const session = { view: () => ({ status: {}, room: {}, exits: [], lockedDoors: [], occupants: [], loot: [], inventory: { items: [], keys: [], equippedNames: [] }, scope: [], finished: false, outcome: "" }), finished: false } as never;
    const audio = { setEnabled: () => {}, enabled: false, soundpacks: [], playCue: () => {}, playMobAttack: () => {}, noteError: () => {}, update: () => {}, setSoundpack: () => {} } as never;
    const handle = crtSurface.mount({ app, session, manifest: { title: "T", intro: "", buttonText: "Go" } as never, themes: [crtSurface.defaultTheme], audio, onExit: vi.fn() });
    expect(typeof handle.unmount).toBe("function");
    handle.unmount();
    expect(app.childElementCount).toBe(0);
  });
});
```

> This test runs in `node`; add `// @vitest-environment jsdom` as the file's first line so `document` exists. (Vitest supports per-file environment via that comment.)

- [ ] **Step 2: Run, verify fail**

Run: `pnpm vitest run packages/play/src/text/surface.test.ts`
Expected: FAIL — `./surface.js` not found.

- [ ] **Step 3: Define the surface/theme contracts**

Create `packages/play/src/core/surface.ts`:

```ts
import type { GameSession } from "./session.js";
import type { CampaignManifest } from "./manifest.js";
import type { AudioRuntime } from "../audio/audio-runtime.js";

export interface Theme { id: string; label: string }
export interface SurfaceHandle { unmount(): void }

export interface MountArgs {
  app: HTMLElement;
  session: GameSession;
  manifest: CampaignManifest;
  themes: Theme[];
  audio: AudioRuntime;
  onExit(): void;
}

export interface PlaySurface {
  id: string;
  label: string;
  defaultTheme: Theme;
  mount(args: MountArgs): SurfaceHandle;
}
```

- [ ] **Step 4: Define the CRT theme + applier**

Create `packages/play/src/text/theme.ts`:

```ts
import type { Theme } from "../core/surface.js";

export interface CrtTheme extends Theme {
  palette: { bg: string; fg: string; accent: string; warn: string; critical: string };
  fonts: { body: string; display: string };
  effects: { scanlineIntensity: number; glow: number; flicker: number };
}

export const defaultCrtTheme: CrtTheme = {
  id: "default",
  label: "Default",
  palette: { bg: "#0b0e0a", fg: "#9be89b", accent: "#d7ffd7", warn: "#e8d36b", critical: "#e86b6b" },
  fonts: { body: "'VT323', monospace", display: "'Silkscreen', monospace" },
  effects: { scanlineIntensity: 0.25, glow: 0.6, flicker: 0.0 },
};

/** Applies a theme to the CRT housing via CSS custom properties. */
export function applyTheme(root: HTMLElement, theme: CrtTheme): void {
  const s = root.style;
  s.setProperty("--crt-bg", theme.palette.bg);
  s.setProperty("--crt-fg", theme.palette.fg);
  s.setProperty("--crt-accent", theme.palette.accent);
  s.setProperty("--crt-warn", theme.palette.warn);
  s.setProperty("--crt-critical", theme.palette.critical);
  s.setProperty("--crt-font-body", theme.fonts.body);
  s.setProperty("--crt-font-display", theme.fonts.display);
  s.setProperty("--crt-scanline", String(theme.effects.scanlineIntensity));
  s.setProperty("--crt-glow", String(theme.effects.glow));
  s.setProperty("--crt-flicker", String(theme.effects.flicker));
}
```

> Then update `ui.ts`'s CRT styling to read these CSS variables (`var(--crt-bg)` etc.) instead of hardcoded colors/fonts, so theming takes effect. Keep the current values as the defaults (they match `defaultCrtTheme`).

- [ ] **Step 5: Wrap the terminal as a `PlaySurface`**

First, make `mountTerminal` return a teardown and accept the new args. In `packages/play/src/text/ui.ts` change the signature to:

```ts
export function mountTerminal(
  root: HTMLElement,
  session: GameSession,
  meta: { title: string; intro: string; buttonText?: string; audio: AudioRuntime; themes: Theme[]; onExit(): void },
): SurfaceHandle {
```

- Use `meta.audio` directly (don't construct an `AudioRuntime` inside; the launcher builds it).
- Apply the initial theme: `applyTheme(root, (meta.themes[0] as CrtTheme) ?? defaultCrtTheme)`.
- Render the **theme switcher** in the bezel listing `meta.themes` (hide when `meta.themes.length < 2`); on change call `applyTheme(root, theme)`.
- Add a **"back to menu"** control in the bezel that calls `meta.onExit()`.
- At the end, return `{ unmount() { root.replaceChildren(); /* remove listeners/intervals */ } }`.

Create `packages/play/src/text/surface.ts`:

```ts
import type { PlaySurface, MountArgs, SurfaceHandle } from "../core/surface.js";
import { defaultCrtTheme } from "./theme.js";
import { mountTerminal } from "./ui.js";

export const crtSurface: PlaySurface = {
  id: "crt-terminal",
  label: "CRT Terminal",
  defaultTheme: defaultCrtTheme,
  mount(args: MountArgs): SurfaceHandle {
    return mountTerminal(args.app, args.session, {
      title: args.manifest.title,
      intro: args.manifest.intro,
      buttonText: args.manifest.buttonText,
      audio: args.audio,
      themes: args.themes,
      onExit: args.onExit,
    });
  },
};
```

- [ ] **Step 6: Run, verify pass**

Run: `pnpm vitest run packages/play/src/text/surface.test.ts`
Expected: PASS

- [ ] **Step 7: Full gate + commit**

Run: `pnpm checks`
Expected: PASS

```bash
git add -A packages/play/src
git commit -m "feat(play): PlaySurface + Theme contracts; wrap terminal as crtSurface"
```

---

### Task 9: `bootLauncher` (menu + deep-link), `surface`/`themes` on the manifest

**Files:**
- Create: `packages/play/src/core/launcher.ts`
- Create: `packages/play/src/core/launcher.test.ts`
- Modify: `packages/play/src/core/manifest.ts` (add `surface?`, `themes?`)
- Modify: `packages/play/src/main.ts` (use `bootLauncher`)

**Interfaces:**
- Consumes: `CampaignManifest`, `PlaySurface`, `Theme`, `GameSession`, `AudioRuntime`, `SaveStore`.
- Produces:
  - `manifest.surface?: string`, `manifest.themes?: Theme[]`.
  - `function resolveCampaign(slug: string | null, campaigns: CampaignManifest[]): CampaignManifest | null` (exported for testing).
  - `function bootLauncher(app: HTMLElement, reg: { campaigns: CampaignManifest[]; surfaces: PlaySurface[] }, opts: { saveStore: SaveStore; now: () => number; locationSearch?: string }): void`.

- [ ] **Step 1: Write the failing test**

Create `packages/play/src/core/launcher.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { resolveCampaign } from "./launcher.js";
import type { CampaignManifest } from "./manifest.js";

const mk = (slug: string): CampaignManifest => ({ slug, title: slug, blurb: "", intro: "", builder: (() => ({})) as never, registry: (() => ({})) as never, aliases: {}, playerName: "p", archetype: "a" });

describe("resolveCampaign", () => {
  const all = [mk("hollow-house"), mk("seed")];
  it("resolves an exact slug", () => { expect(resolveCampaign("seed", all)?.slug).toBe("seed"); });
  it("returns null for an unknown slug (→ menu)", () => { expect(resolveCampaign("nope", all)).toBeNull(); });
  it("returns null for no slug (→ menu)", () => { expect(resolveCampaign(null, all)).toBeNull(); });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm vitest run packages/play/src/core/launcher.test.ts`
Expected: FAIL — `./launcher.js` not found.

- [ ] **Step 3: Add `surface`/`themes` to the manifest**

In `packages/play/src/core/manifest.ts` add the import and fields:

```ts
import type { Theme } from "./surface.js";
// in CampaignManifest:
  surface?: string;
  themes?: Theme[];
```

- [ ] **Step 4: Implement the launcher**

Create `packages/play/src/core/launcher.ts`:

```ts
import type { CampaignManifest } from "./manifest.js";
import type { PlaySurface, SurfaceHandle } from "./surface.js";
import type { SaveStore } from "./savestore.js";
import { GameSession } from "./session.js";
import { AudioRuntime } from "../audio/audio-runtime.js";

export function resolveCampaign(slug: string | null, campaigns: CampaignManifest[]): CampaignManifest | null {
  if (!slug) return null;
  return campaigns.find((c) => c.slug === slug) ?? null;
}

interface BootOpts { saveStore: SaveStore; now: () => number; locationSearch?: string }

export function bootLauncher(
  app: HTMLElement,
  reg: { campaigns: CampaignManifest[]; surfaces: PlaySurface[] },
  opts: BootOpts,
): void {
  let handle: SurfaceHandle | null = null;

  const launch = (m: CampaignManifest): void => {
    const surface = reg.surfaces.find((s) => s.id === (m.surface ?? "crt-terminal")) ?? reg.surfaces[0]!;
    const url = new URL(window.location.href);
    url.searchParams.set("campaign", m.slug);
    window.history.replaceState(null, "", url);
    const session = GameSession.start({
      builder: m.builder(), registry: m.registry(), aliases: m.aliases,
      playerName: m.playerName, archetype: m.archetype, saveStore: opts.saveStore, now: opts.now,
    });
    const audio = AudioRuntime.forCampaign(m.audio);
    handle = surface.mount({
      app, session, manifest: m,
      themes: m.themes && m.themes.length ? m.themes : [surface.defaultTheme],
      audio,
      onExit: () => { handle?.unmount(); handle = null; const u = new URL(window.location.href); u.searchParams.delete("campaign"); window.history.replaceState(null, "", u); showMenu(); },
    });
  };

  const showMenu = (): void => {
    app.replaceChildren();
    const menu = document.createElement("div");
    menu.className = "launcher-menu";
    for (const m of reg.campaigns) {
      const btn = document.createElement("button");
      btn.className = "launcher-entry";
      btn.innerHTML = `<span class="launcher-title">${m.title}</span><span class="launcher-blurb">${m.blurb}</span>`;
      btn.addEventListener("click", () => launch(m));
      menu.appendChild(btn);
    }
    app.appendChild(menu);
  };

  const search = opts.locationSearch ?? window.location.search;
  const slug = new URLSearchParams(search).get("campaign");
  const deep = resolveCampaign(slug, reg.campaigns);
  if (deep) launch(deep); else showMenu();
}
```

> Style `.launcher-menu`/`.launcher-entry` with the runtime's retro aesthetic (reuse the CRT housing look via the same CSS variables). Keyboard selection (number keys / arrows+enter) can be added here.

- [ ] **Step 5: Run, verify pass**

Run: `pnpm vitest run packages/play/src/core/launcher.test.ts`
Expected: PASS

- [ ] **Step 6: Boot via the launcher in `main.ts`**

Replace `packages/play/src/main.ts`:

```ts
import "@fontsource/vt323";
import "@fontsource/silkscreen";
import { bootLauncher } from "./core/launcher.js";
import { LocalStorageSaveStore } from "./core/savestore.js";
import { hollowHouse } from "./campaign/manifest.js";
import { crtSurface } from "./text/surface.js";

const app = document.getElementById("app");
if (app) {
  bootLauncher(app, { campaigns: [hollowHouse], surfaces: [crtSurface] }, {
    saveStore: new LocalStorageSaveStore(),
    now: () => Date.now(),
  });
}
```

- [ ] **Step 7: Full gate + commit**

Run: `pnpm checks`
Expected: PASS

```bash
git add -A packages/play/src
git commit -m "feat(play): bootLauncher with campaign menu + deep-link"
```

---

### Task 10: Theme switcher proof — Hollow House `default` + `haunted` themes

**Files:**
- Create: `packages/play/src/campaign/themes.ts`
- Create: `packages/play/src/campaign/themes.test.ts`
- Modify: `packages/play/src/campaign/manifest.ts` (set `surface: "crt-terminal"`, `themes`)

**Interfaces:**
- Consumes: `CrtTheme`, `defaultCrtTheme` (`text/theme`).
- Produces: `hauntedCrtTheme: CrtTheme`; `hollowHouseThemes: CrtTheme[] = [defaultCrtTheme, hauntedCrtTheme]`.

- [ ] **Step 1: Write the failing test**

Create `packages/play/src/campaign/themes.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { hollowHouseThemes, hauntedCrtTheme } from "./themes.js";

describe("Hollow House themes", () => {
  it("ships two distinct themes, default first", () => {
    expect(hollowHouseThemes).toHaveLength(2);
    expect(hollowHouseThemes[0]!.id).toBe("default");
    expect(hollowHouseThemes[1]!.id).toBe("haunted");
  });
  it("the haunted theme is a darker, heavier-glow reskin", () => {
    expect(hauntedCrtTheme.palette.fg).not.toBe(hollowHouseThemes[0]!.palette.fg);
    expect(hauntedCrtTheme.effects.glow).toBeGreaterThan(hollowHouseThemes[0]!.effects.glow);
    expect(hauntedCrtTheme.effects.flicker).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm vitest run packages/play/src/campaign/themes.test.ts`
Expected: FAIL — `./themes.js` not found.

- [ ] **Step 3: Author the themes**

Create `packages/play/src/campaign/themes.ts`:

```ts
import { defaultCrtTheme, type CrtTheme } from "../text/theme.js";

export const hauntedCrtTheme: CrtTheme = {
  id: "haunted",
  label: "Haunted",
  palette: { bg: "#080406", fg: "#c08a8a", accent: "#f0d0d0", warn: "#d98a4b", critical: "#ff3b3b" },
  fonts: { body: "'VT323', monospace", display: "'Silkscreen', monospace" },
  effects: { scanlineIntensity: 0.4, glow: 0.9, flicker: 0.15 },
};

export const hollowHouseThemes: CrtTheme[] = [defaultCrtTheme, hauntedCrtTheme];
```

- [ ] **Step 4: Run, verify pass**

Run: `pnpm vitest run packages/play/src/campaign/themes.test.ts`
Expected: PASS

- [ ] **Step 5: Wire themes into the manifest**

In `packages/play/src/campaign/manifest.ts` import and set:

```ts
import { hollowHouseThemes } from "./themes.js";
// in the object:
  surface: "crt-terminal",
  themes: hollowHouseThemes,
```

- [ ] **Step 6: Manual smoke (dev server)**

Run: `pnpm --filter @wickedways/play dev`, open `http://localhost:5174`, deep-link `?campaign=hollow-house`, confirm a **Haunted** option appears in the theme switcher and that selecting it visibly reskins the CRT.

- [ ] **Step 7: Full gate + commit**

Run: `pnpm checks`
Expected: PASS

```bash
git add packages/play/src/campaign/themes.ts packages/play/src/campaign/themes.test.ts packages/play/src/campaign/manifest.ts
git commit -m "feat(play): Hollow House default + haunted CRT themes"
```

---

## PHASE 5 — Package split (mechanical)

> Each task is a relocation: `git mv` the files, update import specifiers, add a `package.json`/`tsconfig.json` mirroring the `@wickedways/seed` package (and `@wickedways/play`'s `tsconfig.json`), then run `pnpm install` and `pnpm checks`. Vitest auto-discovers `packages/*/src/**/*.test.ts`, so tests move with the code. After each move, fix imports with a repo-wide grep until typecheck is clean.

### Task 11: Extract `@wickedways/play-runtime`

**Files:**
- Create: `packages/play-runtime/package.json`, `packages/play-runtime/tsconfig.json`, `packages/play-runtime/src/index.ts`
- Move (`git mv`): `packages/play/src/core/{session,intent,viewmodel,savestore,map-model,manifest,surface,launcher}.ts` (+ their `*.test.ts`) → `packages/play-runtime/src/`; `packages/play/src/audio/{synth.ts→engine.ts, ambient,contracts,renderer,default-pack,audio-runtime,cue-sound,tension}.ts` (+ tests) → `packages/play-runtime/src/audio/`.

**Interfaces:**
- Produces: package `@wickedways/play-runtime` exporting (via `src/index.ts`) `GameSession`, `bootLauncher`, `resolveCampaign`, the contracts (`CampaignManifest`, `AliasMap`, `PlaySurface`, `SurfaceHandle`, `Theme`, `MountArgs`), all audio contracts + `AudioRuntime`, `defaultChiptunePack`, `defaultDirector`, and the view/intent/savestore types.

- [ ] **Step 1: Scaffold the package**

Create `packages/play-runtime/package.json`:

```json
{
  "name": "@wickedways/play-runtime",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "typecheck": "tsc --noEmit" },
  "dependencies": { "wickedways": "workspace:*" },
  "devDependencies": { "@types/node": "^22.10.0" }
}
```

Create `packages/play-runtime/tsconfig.json` (copy `packages/play/tsconfig.json` verbatim).

- [ ] **Step 2: Move the files**

```bash
mkdir -p packages/play-runtime/src/audio
git mv packages/play/src/core/session.ts packages/play-runtime/src/session.ts
git mv packages/play/src/core/session.test.ts packages/play-runtime/src/session.test.ts 2>/dev/null || true
git mv packages/play/src/core/intent.ts packages/play-runtime/src/intent.ts
git mv packages/play/src/core/viewmodel.ts packages/play-runtime/src/viewmodel.ts
git mv packages/play/src/core/viewmodel.test.ts packages/play-runtime/src/viewmodel.test.ts 2>/dev/null || true
git mv packages/play/src/core/savestore.ts packages/play-runtime/src/savestore.ts
git mv packages/play/src/core/map-model.ts packages/play-runtime/src/map-model.ts
git mv packages/play/src/core/map-model.test.ts packages/play-runtime/src/map-model.test.ts 2>/dev/null || true
git mv packages/play/src/core/manifest.ts packages/play-runtime/src/manifest.ts
git mv packages/play/src/core/surface.ts packages/play-runtime/src/surface.ts
git mv packages/play/src/core/launcher.ts packages/play-runtime/src/launcher.ts
git mv packages/play/src/core/launcher.test.ts packages/play-runtime/src/launcher.test.ts
git mv packages/play/src/audio/synth.ts packages/play-runtime/src/audio/engine.ts
for f in ambient contracts renderer default-pack audio-runtime cue-sound tension; do
  git mv packages/play/src/audio/$f.ts packages/play-runtime/src/audio/$f.ts 2>/dev/null || true
  git mv packages/play/src/audio/$f.test.ts packages/play-runtime/src/audio/$f.test.ts 2>/dev/null || true
done
```

- [ ] **Step 3: Fix imports**

- `synth.ts` was renamed to `engine.ts`: update `import ... from "./synth.js"` → `"./engine.js"` across the audio files (`grep -rn "synth.js" packages/play-runtime/src`).
- Cross-module imports that were `../core/x.js` from audio become `../x.js` (e.g. in `audio-runtime.ts`, `default-pack.ts`: `../core/viewmodel.js` → `../viewmodel.js`, `../core/session.js` → `../session.js`).
- `surface.ts`/`launcher.ts`/`manifest.ts` imported `../audio/...` — now `./audio/...`.

Run: `grep -rn "\.\./core/\|/synth\.js\|\./core/" packages/play-runtime/src` and fix each.

- [ ] **Step 4: Write the barrel**

Create `packages/play-runtime/src/index.ts`:

```ts
export { GameSession } from "./session.js";
export type { SessionOptions, ExecuteResult, MobAttack } from "./session.js";
export { bootLauncher, resolveCampaign } from "./launcher.js";
export { isTimeAdvancing } from "./intent.js";
export type { Intent } from "./intent.js";
export { view } from "./viewmodel.js";
export type { ViewModel, ScopeEntity, ExitView, LockedDoorView, LootView } from "./viewmodel.js";
export { LocalStorageSaveStore } from "./savestore.js";
export type { SaveStore, SaveSlot, SurfaceState } from "./savestore.js";
export type { CampaignManifest, AliasMap } from "./manifest.js";
export type { PlaySurface, SurfaceHandle, Theme, MountArgs } from "./surface.js";
export { AudioRuntime } from "./audio/audio-runtime.js";
export { defaultChiptunePack, defaultDirector } from "./audio/default-pack.js";
export { SynthRenderer, SampleRenderer } from "./audio/renderer.js";
export { AudioEngine } from "./audio/engine.js";
export { AmbientBed } from "./audio/ambient.js";
export type { SoundSpec, SynthVoice, AudioCue, BaseAudioCue, AudioDirector, SoundPack, AmbientDirective, CampaignAudio } from "./audio/contracts.js";
export { sanityToTension } from "./audio/tension.js";
export { soundForCue, soundForMobAttack, errorSound, detuneFactor } from "./audio/cue-sound.js";
export type { MapModel } from "./map-model.js";
```

> Note: `SynthVoice` is declared in `cue-sound.ts`; re-export it from there in `contracts.ts` (`export type { SynthVoice } from "./cue-sound.js";`) so the barrel line above resolves, OR adjust the barrel to export `SynthVoice` from `./audio/cue-sound.js`.

- [ ] **Step 5: Point the remaining play imports at the package, install, gate**

The files still in `packages/play/src` (the `text/` surface + `campaign/`) import from `./core/...`/`../core/...`/`../audio/...`. Temporarily they'll be moved in Tasks 12–13; for now add `@wickedways/play-runtime` to `packages/play/package.json` dependencies and rewrite those imports to `@wickedways/play-runtime`.

```bash
# in packages/play/package.json dependencies add:  "@wickedways/play-runtime": "workspace:*"
pnpm install
grep -rln "core/session\|core/viewmodel\|core/intent\|core/savestore\|core/map-model\|core/manifest\|core/surface\|core/launcher\|audio/audio-runtime\|audio/contracts\|audio/cue-sound\|audio/tension\|audio/default-pack\|audio/renderer\|audio/ambient\|audio/synth" packages/play/src
# rewrite each of those import specifiers to "@wickedways/play-runtime"
```

- [ ] **Step 6: Gate + commit**

Run: `pnpm checks`
Expected: PASS

```bash
git add -A
git commit -m "refactor: extract @wickedways/play-runtime"
```

---

### Task 12: Extract `@wickedways/play-surface-crt`

**Files:**
- Create: `packages/play-surface-crt/package.json`, `tsconfig.json`, `src/index.ts`
- Move: `packages/play/src/text/{parser,narrator,ui,link-nouns,map-view,theme,surface}.ts` (+ tests) → `packages/play-surface-crt/src/`.

**Interfaces:**
- Produces: package `@wickedways/play-surface-crt` exporting `crtSurface: PlaySurface`, `CrtTheme`, `defaultCrtTheme`, `applyTheme`. Depends on `@wickedways/play-runtime` + `wickedways` + the fontsource packages.

- [ ] **Step 1: Scaffold**

`packages/play-surface-crt/package.json`:

```json
{
  "name": "@wickedways/play-surface-crt",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "typecheck": "tsc --noEmit" },
  "dependencies": {
    "@fontsource/silkscreen": "^5.2.8",
    "@fontsource/vt323": "^5.2.7",
    "@wickedways/play-runtime": "workspace:*",
    "wickedways": "workspace:*"
  }
}
```

`tsconfig.json`: copy `packages/play/tsconfig.json`.

- [ ] **Step 2: Move files**

```bash
mkdir -p packages/play-surface-crt/src
for f in parser narrator ui link-nouns map-view theme surface; do
  git mv packages/play/src/text/$f.ts packages/play-surface-crt/src/$f.ts 2>/dev/null || true
  git mv packages/play/src/text/$f.test.ts packages/play-surface-crt/src/$f.test.ts 2>/dev/null || true
done
```

- [ ] **Step 3: Fix imports**

Rewrite engine + runtime imports: anything `../core/*` or `../audio/*` or `@wickedways/play-runtime` stays/becomes `@wickedways/play-runtime`. `grep -rn "\.\./core\|\.\./audio\|/core/\|/audio/" packages/play-surface-crt/src` and rewrite to `@wickedways/play-runtime`.

- [ ] **Step 4: Barrel**

`packages/play-surface-crt/src/index.ts`:

```ts
export { crtSurface } from "./surface.js";
export { defaultCrtTheme, applyTheme } from "./theme.js";
export type { CrtTheme } from "./theme.js";
```

- [ ] **Step 5: Gate + commit**

Add `"@wickedways/play-surface-crt": "workspace:*"` to `packages/play/package.json`; rewrite `packages/play/src/main.ts` + `campaign/themes.ts` imports of `../text/...` to `@wickedways/play-surface-crt`. Then:

```bash
pnpm install
pnpm checks
git add -A
git commit -m "refactor: extract @wickedways/play-surface-crt"
```

---

### Task 13: Extract `@wickedways/campaigns` (hollow-house) with subpath exports

**Files:**
- Create: `packages/campaigns/package.json`, `tsconfig.json`
- Move: `packages/play/src/campaign/*` → `packages/campaigns/src/hollow-house/*` (rename `index.ts` stays; `manifest.ts` becomes the subpath entry — re-export the manifest from `hollow-house/index.ts`).

**Interfaces:**
- Produces: `@wickedways/campaigns` with `exports: { "./*": "./src/*/index.ts" }`; `@wickedways/campaigns/hollow-house` exports `{ hollowHouse }` (the `CampaignManifest`). Depends on `wickedways`, type-only on `@wickedways/play-runtime` and `@wickedways/play-surface-crt`.

- [ ] **Step 1: Scaffold**

`packages/campaigns/package.json`:

```json
{
  "name": "@wickedways/campaigns",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "exports": { "./*": "./src/*/index.ts" },
  "scripts": { "typecheck": "tsc --noEmit" },
  "dependencies": {
    "wickedways": "workspace:*",
    "@wickedways/play-runtime": "workspace:*",
    "@wickedways/play-surface-crt": "workspace:*",
    "@wickedways/seed": "workspace:*"
  }
}
```

`tsconfig.json`: copy `packages/play/tsconfig.json`.

- [ ] **Step 2: Move the Hollow House content**

```bash
mkdir -p packages/campaigns/src/hollow-house
git mv packages/play/src/campaign/* packages/campaigns/src/hollow-house/
```

In `packages/campaigns/src/hollow-house/index.ts`, append a re-export so the subpath entry exposes the manifest:

```ts
export { hollowHouse } from "./manifest.js";
```

- [ ] **Step 3: Fix imports**

Rewrite runtime/surface imports inside `hollow-house/` to the packages: `../core/manifest.js` → `@wickedways/play-runtime`; `../audio/contracts.js` → `@wickedways/play-runtime`; `../audio/default-pack.js` / `tension.js` → `@wickedways/play-runtime`; `../text/theme.js` → `@wickedways/play-surface-crt`. Convert manifest/theme/audio imports of runtime types to `import type` where only types are used. `grep -rn "\.\./core\|\.\./audio\|\.\./text" packages/campaigns/src` and fix.

- [ ] **Step 4: Repoint the shell**

In `packages/play/package.json` add `"@wickedways/campaigns": "workspace:*"`. In `packages/play/src/main.ts` change `import { hollowHouse } from "./campaign/manifest.js";` → `import { hollowHouse } from "@wickedways/campaigns/hollow-house";`.

- [ ] **Step 5: Install, gate, commit**

```bash
pnpm install
pnpm checks
git add -A
git commit -m "refactor: extract @wickedways/campaigns with hollow-house subpath"
```

---

### Task 14: Add `@wickedways/campaigns/seed` + register both in the shell

**Files:**
- Create: `packages/campaigns/src/seed/index.ts`
- Create: `packages/campaigns/src/seed/index.test.ts`
- Modify: `packages/play/src/main.ts` (register both campaigns)

**Interfaces:**
- Consumes: `seedTemplate`, `buildSeedRegistry` from `@wickedways/seed`; `CampaignManifest` (type) from `@wickedways/play-runtime`.
- Produces: `@wickedways/campaigns/seed` exporting `seed: CampaignManifest` (slug `"seed"`, no `audio`, no `themes`).

- [ ] **Step 1: Write the failing test**

Create `packages/campaigns/src/seed/index.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { seed } from "./index.js";

describe("seed campaign manifest", () => {
  it("wraps the seed world with no audio/themes (flat-bed path)", () => {
    expect(seed.slug).toBe("seed");
    expect(seed.audio).toBeUndefined();
    expect(seed.themes).toBeUndefined();
    expect(typeof seed.builder).toBe("function");
    expect(typeof seed.registry).toBe("function");
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm vitest run packages/campaigns/src/seed/index.test.ts`
Expected: FAIL — `./index.js` not found.

- [ ] **Step 3: Implement the wrapper**

Create `packages/campaigns/src/seed/index.ts`:

```ts
import { seedTemplate, buildSeedRegistry } from "@wickedways/seed";
import type { CampaignManifest } from "@wickedways/play-runtime";

export const seed: CampaignManifest = {
  slug: "seed",
  title: "Seed Demo",
  blurb: "A tiny two-room demo world — the minimal campaign used to exercise the engine.",
  intro: "A bare proving ground. Look around, take what you find, and step through the door.",
  buttonText: "Enter Demo",
  builder: seedTemplate,
  registry: buildSeedRegistry,
  aliases: {},
  playerName: "Tester",
  archetype: "",
};
```

> If the seed world requires a specific archetype/player name, read `packages/seed/src/index.ts` and set them; otherwise the engine defaults apply (archetype `""` is treated as "no archetype" by `GameSession.boot`, which only selects when `archetype !== undefined` — pass `archetype: ""`? Confirm `selectArchetype("")` is valid; if not, make `archetype` optional in the manifest and omit it here, and have the launcher pass `archetype: m.archetype || undefined`).

- [ ] **Step 4: Run, verify pass**

Run: `pnpm vitest run packages/campaigns/src/seed/index.test.ts`
Expected: PASS

- [ ] **Step 5: Register both campaigns in the shell**

In `packages/play/src/main.ts`:

```ts
import { hollowHouse } from "@wickedways/campaigns/hollow-house";
import { seed } from "@wickedways/campaigns/seed";
import { crtSurface } from "@wickedways/play-surface-crt";
import { bootLauncher } from "@wickedways/play-runtime";
import { LocalStorageSaveStore } from "@wickedways/play-runtime";

const app = document.getElementById("app");
if (app) {
  bootLauncher(app, { campaigns: [hollowHouse, seed], surfaces: [crtSurface] }, {
    saveStore: new LocalStorageSaveStore(),
    now: () => Date.now(),
  });
}
```

- [ ] **Step 6: Manual smoke**

Run: `pnpm --filter @wickedways/play dev`; confirm the menu lists **The Hollow House** and **Seed Demo**, each boots, and "back to menu" returns.

- [ ] **Step 7: Gate + commit**

Run: `pnpm checks`
Expected: PASS

```bash
git add -A
git commit -m "feat(campaigns): seed campaign + two-entry launcher menu"
```

---

## PHASE 6 — e2e + docs

### Task 15: Update Playwright e2e (deep-link, menu, theme switch)

**Files:**
- Modify: `packages/play/e2e/playthrough.spec.ts`

**Interfaces:**
- Consumes: the running dev/preview server; deep-link `?campaign=hollow-house`.

- [ ] **Step 1: Deep-link the existing winning playthrough**

In `packages/play/e2e/playthrough.spec.ts`, change the initial navigation to deep-link straight into Hollow House so the existing run is unchanged:

```ts
await page.goto("/?campaign=hollow-house");
```

(Keep the rest of the winning playthrough — welcome → loot → combat → save/undo → win — as-is.)

- [ ] **Step 2: Add a menu-navigation test**

Append:

```ts
test("campaign menu lists entries, enters one, and returns", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("The Hollow House")).toBeVisible();
  await expect(page.getByText("Seed Demo")).toBeVisible();
  await page.getByRole("button", { name: /Hollow House/ }).click();
  await expect(page.getByRole("button", { name: /Enter Hollow House/ })).toBeVisible();
  // back to menu
  await page.getByRole("button", { name: /menu/i }).click();
  await expect(page.getByText("Seed Demo")).toBeVisible();
});
```

- [ ] **Step 3: Add a theme-switch smoke test**

```ts
test("theme switcher reskins the CRT", async ({ page }) => {
  await page.goto("/?campaign=hollow-house");
  await page.getByRole("button", { name: /Enter Hollow House/ }).click();
  const housing = page.locator("[data-crt-housing]"); // add this attribute to the CRT root in ui.ts
  const before = await housing.evaluate((el) => getComputedStyle(el).getPropertyValue("--crt-fg"));
  await page.getByRole("combobox", { name: /theme/i }).selectOption("haunted");
  const after = await housing.evaluate((el) => getComputedStyle(el).getPropertyValue("--crt-fg"));
  expect(after).not.toBe(before);
});
```

> Add `data-crt-housing` to the CRT root element and `aria-label="theme"`/`aria-label="back to menu"` to the switcher/back controls in `ui.ts` so these selectors resolve.

- [ ] **Step 4: Run e2e**

Run: `pnpm --filter @wickedways/play test:e2e`
Expected: PASS (all three tests).

- [ ] **Step 5: Commit**

```bash
git add packages/play/e2e/playthrough.spec.ts packages/play-surface-crt/src/ui.ts
git commit -m "test(play): e2e for deep-link, menu nav, theme switch"
```

---

### Task 16: Documentation

**Files:**
- Modify: `README.md` (root)
- Modify: `packages/play/README.md`
- Modify: TSDoc on the new contracts (`manifest.ts`, `surface.ts`, `launcher.ts`, `audio/contracts.ts`)

- [ ] **Step 1: Root README — authoring story**

Add a "Swappable campaigns & play surfaces" section documenting: the `CampaignManifest` contract; how to add a campaign (a folder under `packages/campaigns/src/<slug>/` exporting a manifest, registered in `packages/play/src/main.ts`); how to add a theme (a `CrtTheme` in `manifest.themes`); how to add a surface (implement `PlaySurface` + register in the shell). Reference the spec.

- [ ] **Step 2: `packages/play/README.md` — topology + architecture**

Rewrite the "Source layout" / "How it works" sections for the new package split (`play-runtime`, `play-surface-crt`, `campaigns`, `play` shell). Document: the `PlaySurface` contract; the 4-layer audio architecture (director → soundpack → SoundSpec → backend) and the soundpack switcher; the cue-driven campaign-defined status bar (`StatusCue`); per-surface themes + the theme switcher; the campaign menu + `?campaign=` deep-link. Update the Deployment section note (Dockerfile context is still the repo root; bundle now pulls three workspace packages).

- [ ] **Step 3: TSDoc**

Add TSDoc comments to `CampaignManifest`, `PlaySurface`, `Theme`, `bootLauncher`, `AudioDirector`, `SoundPack`, `CampaignAudio`, and the `status` cue / `StatusField` in `presentation.ts`.

- [ ] **Step 4: Gate + commit**

Run: `pnpm checks`
Expected: PASS

```bash
git add README.md packages/play/README.md packages/play-runtime/src packages/play-surface-crt/src src/lib/presentation.ts
git commit -m "docs: document swappable campaigns, surfaces, themes, and audio"
```

---

## Self-Review

**Spec coverage:**
- Topology (`play-runtime`/`play-surface-crt`/`campaigns`/`play` shell, seed untouched) → Tasks 11–14. ✓
- `CampaignManifest` (factories, surface, themes, audio) → Tasks 2, 7, 9, 10. ✓
- `PlaySurface`/`Theme`/`SurfaceHandle` + `bootLauncher` (menu + deep-link) → Tasks 8, 9. ✓
- Audio 4-layer (director/pack/SoundSpec/backend), default chiptune pack, switcher, SampleRenderer deferred → Tasks 4–7. ✓
- Status bar first-class cue (engine change) → Tasks 1, 3. ✓
- Per-surface themes + proof (`default`+`haunted`) + switcher → Tasks 8, 10. ✓
- Seed wrapper as 2nd campaign → Task 14. ✓
- Tests (launcher/lifecycle/director/pack/theme/status/no-audio) + e2e → throughout + Task 15. ✓
- Docs → Task 16. ✓
- Engine changes confined to Task 1. ✓

**Placeholder scan:** No "TBD"/"implement later". The two `>`-noted risk checks (Task 5 literal reconciliation, Task 14 seed archetype) are explicit, bounded verifications with a defined fallback, not deferred work.

**Type consistency:** `SynthVoice` (renamed from old `SoundSpec`) and the new `SoundSpec` union are introduced together in Task 4 and used consistently in Tasks 5–7 and the barrel (Task 11). `CampaignManifest` grows monotonically (Tasks 2 → 7 `audio` → 9 `surface`/`themes`) with no field renames. `AudioRuntime.forCampaign`, `playCue(cue, view)`, `update(campaign)`, `soundpacks`, `setSoundpack` match across Tasks 7–9. `crtSurface`/`MountArgs`/`SurfaceHandle` match across Tasks 8–9 and the launcher.
