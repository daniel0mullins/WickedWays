# WickedWays as a Real-Life Tabletop — Design Brainstorm & Buildable Path

## Context

The goal is to use the WickedWays engine to drive a **physical tabletop session**. The
seed idea: an Arduino/SoC per **color e-ink tile**; tiles connect edge-to-edge to build
the dungeon map, and player pieces sit on top.

The happy discovery from exploring the codebase: **the engine is already architected for
this.** The browser play stack is a clean pull-model surface contract, so a physical
tabletop is "just another surface" — no engine changes are required for a first version.
This doc captures the brainstorm and recommends a hardware-free, CI-testable software
proof as the first concrete deliverable, since hardware can be specced here but not
assembled.

## What the engine already gives us (the seams)

- **Surface contract:** `PlaySurface` / `MountArgs` in `packages/play-runtime/src/surface.ts`.
  The CRT and point-and-click surfaces are two impls; a tabletop is a third sibling.
- **Input:** every action is an `Intent` object handed to `session.execute(intent)`
  (`packages/play-runtime/src/session.ts`, `packages/play-runtime/src/intent.ts`). The
  point-and-click surface (`packages/play-surface/src/pnc/affordances.ts`) already builds
  intents directly from state with **no text parser** — the model a hardware control mirrors.
  Intent kinds: `move / take / drop / use / attack / wait / talk / equip / unequip / open`.
- **Output:** `execute()` returns `PresentationCue[]`; `session.view()` returns a plain-JSON
  `ViewModel` DTO (`packages/play-runtime/src/viewmodel.ts`) — room, occupants, exits, loot,
  lit-state, HUD. No live engine object crosses the seam.
- **Cues are terse** (an `action` cue is just kind+actor). The Narrator
  (`packages/play-surface/src/shared/narrator.ts`) recovers meaning by **diffing two
  `ViewModel` snapshots**. A tile bridge must do the same to know what changed on which tile.
- **Map layout is solved:** `packages/play-runtime/src/map-model.ts` turns the topological
  compass graph into 2D grid coordinates incrementally (`DIRECTION_DELTA`); `layoutMap()` in
  `packages/play-surface/src/shared/map-view.ts` normalizes to a padded grid; `renderMapSvg()`
  draws it. Directions are 8-compass, **no up/down**, so a single-plane tile grid maps cleanly.
- **Key cues for hardware:** `visibility {room, lit}` = reveal/conceal trigger (e-ink lamp
  on/off); `encounter` / `resolution` / `status` = a ready-made physical-effects event bus.
  `status` cue fields carry `emphasis: "normal" | "warn" | "critical"`.

## The four brainstorm threads (all developed)

1. **Darkness = real light (signature feature).** Color e-ink is reflective — you literally
   can't see the room art without external light, so darkness is *physically real*, not
   simulated. Engine seams: `Room.dark`, `Room.isLit`, `emitsLight` items, carried vs placed
   light, the `visibility` cue, and the targeting gate (attack/loot/harvest throw in the dark).
   Hardware: per-tile white downlight + NFC-tagged "lantern" token; lighting a tile makes its
   e-ink readable. Light-averse mob ambush + 1.5× light-vulnerability all fall out of cues.
2. **Who is the GM (load-bearing fork).** (a) engine-as-GM appliance (no human GM; runtime
   `ProceduralViolation` becomes a red-tile "can't do that"); (b) human GM + director tablet
   (a GM `PlaySurface` variant with full ViewModel + Codex); (c) hybrid. Solo play is already
   supported (solo-GM reaction) and is the cheapest prototype.
3. **Physical horror feedback.** Sanity/Fear/Panic/Confused/KO are off-map, so give each seat
   a small e-ink/OLED dashboard (fed by `status` cue `emphasis`) + an RGB piece base (Fear =
   amber flicker, Panic = red strobe, KO = dark). Confused's 50% per-action fizzle is the best
   physical beat — a buzzer eats your turn while the table watches.
4. **E-ink persistence + dice seam.** E-ink holds its image unpowered and `serializeCampaign`
   captures full mid-turn state, so the board *remembers between game nights*. Save/restore
   already round-trips a per-surface `SurfaceState` payload — the place tile→room assignments
   live. All randomness flows through an injected `rng: () => number`, so physical dice can
   either **seed** the campaign (deterministic, save-compatible) or **supply** dramatic rolls.

## Two engine gaps the hardware surfaces (need a decision)

- **`placeLight` in the Intent set.** The Rust `Intent` union has no explicit
  `placeLight`/`takeLight`. Carried light maps to `equip` today, but "set a torch down to
  light a room you leave" may need an intent addition or a drop-of-a-light modeling. Confirm
  against the Rust core before committing to that interaction.
- **Dice-supply rng seam.** `rng` is an internal *pull* (many draws per action), not a
  "supply the result for this flagged roll" API. True per-action physical dice want a thin
  seam letting a specific draw consume a host-provided value. Seed-at-start needs no change.

## Recommended first deliverable — `@wickedways/tabletop` (software, hardware-free)

A new workspace package (under `packages/`, `@wickedways/tabletop`, following the
`packages/campaigns` tsconfig/package.json convention: `private`, `type: module`, exports to
`.ts` source, `workspace:*` deps on `wickedways` + `@wickedways/play-runtime`) that:

1. **Implements `PlaySurface`** (sibling to crt/pnc) so it boots through the existing launcher
   and `GameSession` — no engine changes for v1.
2. **Defines a narrow `DeviceTransport`** (out: tile-render / lamp / LED / audio commands;
   in: piece-move / button / lantern-placed events) with two implementations:
   - `SimulatorTransport` — renders a virtual tile grid in the browser (draggable pieces,
     tiles that go dark/lit, per-seat dashboards). Fully CI-testable, zero hardware.
   - `SerialTransport` / `WebSocketTransport` — the same protocol to real firmware later.
3. **Reuses `MapModel` → `layoutMap`** for tile placement, plus a **collision-resolution pass**
   (the derived embedding can drop two rooms on one cell).
4. **Diffs before/after `ViewModel`s** (Narrator-style) to compute per-tile updates, and maps
   inbound piece-move events → `Intent{move, dir}` via tile adjacency + the room graph,
   rejecting illegal moves (which the engine's preconditions already enforce).
5. Maps `visibility` → tile reveal, `encounter` → LED/audio, `status` → seat dashboards,
   `resolution` → endgame tile.

### Phasing

- **P1:** Simulator surface — prove cue/view → tile grid, drag → intent, dark/lit tiles, seat
  dashboards, all in a browser. (This is the whole buildable proof.)
- **P2:** `SerialTransport` to one ESP32 + one e-ink tile as hardware "hello world."
- **P3:** Scale to N tiles + NFC piece/lantern sensing; decide the two engine gaps above.

## Verification (for P1)

- `pnpm checks` (lint + typecheck + test) green, including new colocated `*.test.ts` for the
  transport protocol, the ViewModel-diff → tile-command mapping, and piece-move → Intent
  resolution (illegal-move rejection).
- Boot the simulator surface through the existing launcher against the Hollow House manifest
  (`packages/campaigns/src/hollow-house`) and drive a full loop by dragging pieces: verify
  reveal-on-light, encounter LEDs, a Panic/Confused dashboard state, and save→restore keeping
  tile assignments (per-surface `SurfaceState`).
- Per the repo convention, update `README.md` to document the new surface once it exists.

## Status / open question

This is still a **brainstorm converging toward a build** — not yet greenlit to implement.
Open decision: pick the first move — (a) converge to the P1 build plan above, (b) investigate
the two engine gaps first, (c) go deeper on physical form factor toward a BOM/spec, or
(d) keep brainstorming.
