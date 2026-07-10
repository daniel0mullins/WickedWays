# NPC Dialogue System — Sub-plan 3: Hollow House Caretaker — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`). This sub-plan is authoring + one composed fixture; the machinery is built + gated by Sub-plans 1-2.

**Goal:** The caretaker experience in Hollow House: on game start you're introduced to a caretaker in the Foyer; `examine caretaker` describes them; `talk to caretaker` hands over the cellar key and the caretaker vanishes; the Foyer→Cellar corridor becomes a keyed door the cellar key opens.

**Spec:** `docs/superpowers/specs/2026-07-08-hollow-house-caretaker-design.md`. **Depends on Sub-plans 1-3** (visibility, talk/dialogue, `GiveItem`/`SetVisible`, NPC `holds` seeding, `examine`-description, **data-driven scenes with effects + start-room onEnter firing**).

## Global Constraints
- Authoring-first: no new engine mechanics (all in Sub-plans 1-3). Differential gate authority. `checks:phase2` green (incl. the updated capstone + manifest-boot + the new fixture).

## The auto-intro (a real onEnter scene)
The caretaker intro is a **data-driven `onEnter` scene** on the Foyer (Sub-plan 3): because the Foyer is the start room, Sub-plan 3's `begin_campaign` start-room enter-scene firing surfaces its cue at game start. Authored via the `scene({ onEnter: [...] })` builder and registered in `hollowHouseBehaviors()` — no per-scene engine code. (The scene emits cues only here; the machinery also allows scene effects like `SetVisible`, e.g. a future "resurrect" scene.)

---

## Task 1: Keyed Foyer→Cellar door + cellar key
**Files:** `packages/campaigns/src/hollow-house/ids.ts` (`Keys.Cellar`, `ExitBehaviors.CellarDoor`); `packages/campaigns/src/hollow-house/items.ts` (cellar-key factory via `createKey`); `packages/campaigns/src/hollow-house/content.ts` (`doorBehavior`); `packages/campaigns/src/hollow-house/index.ts` (exits map + the exit declaration ~line 105); `scripted.ts` (the scripted door twin in `hollowHouseBehaviors()`); tests.

- [ ] Add `cellar-key` (`createKey({ name: "Cellar Key", keyCode: "cellar", consumeOnUse: false })`) and register the factory.
- [ ] Add `[ExitBehaviors.CellarDoor]: doorBehavior("cellar", "cellar door", "<opened line>")` to `buildHauntedHouseRegistry`'s `exits` map; add its scripted twin to `hollowHouseBehaviors()` (mirror `doorScript` for study/attic).
- [ ] Convert the free corridor `.exit(Foyer, South, Cellar).exit(Cellar, North, Foyer)` (index.ts:105) to a **single** keyed declaration: `.exit(Rooms.Foyer, Directions.South, Rooms.Cellar, { behaviorKey: ExitBehaviors.CellarDoor, name: "cellar door", initialState: { unlocked: false } })` (declare ONCE — a reverse decl shadows the behaviorKey).
- [ ] Test: without the cellar key the door is locked (appears in `lockedDoors`, move fails with the fail message); with the key, first pass unlocks (opened line) + moves. Typecheck. Commit.

## Task 2: The caretaker NPC (dialogue + description) + the Foyer intro scene — authoring
**Files:** `ids.ts` (`Npcs.Caretaker` behavior key + `Scenes.CaretakerIntro` key); `scripted.ts` (`caretakerScript = npc({...})` + `caretakerIntroScene = scene({...})` + register both in `hollowHouseBehaviors()`); `index.ts` (`.npc(...)` seeding with `holds: [Keys.Cellar]` + attach the intro scene to the Foyer); `manifest.ts` (already threads behaviors/formations); tests + manifest-boot.

- [ ] Author `caretakerScript = npc({ description: "<physical description>", default: dialogueEntry({ match: <bare/default>, response: "<hand-off line>", effects: [giveItem(caretaker, actor, Keys.Cellar), setVisible(caretaker, false)], once: true }), dialogue: [ /* optional lore prompts, e.g. dialogueFuzzy(["cellar"]) → hint */ ] })`. (Bare `talk` triggers the hand-off per the design; the `once` latch prevents re-giving; after `SetVisible(false)` the caretaker is unreachable anyway.)
- [ ] Author `caretakerIntroScene = scene({ onEnter: [ emit(cue("<intro narration>")) ] })` (Sub-plan 3's `scene(...)` builder) — attach it to the **Foyer** (the start room), so Sub-plan 3's `begin_campaign` start-room enter-scene firing surfaces the cue at game start. (Cue-only here; effects are available if wanted.) Register both scripts in `hollowHouseBehaviors()` by their behavior keys; attach the scene to the Foyer room in the template (`.room(Rooms.Foyer, { ..., scenes: [Scenes.CaretakerIntro] })` or the real scene-attach API — confirm against how scenes attach to rooms).
- [ ] Seed the NPC: `.npc("Caretaker", { stats: <minimal>, room: Rooms.Foyer, behavior: Npcs.Caretaker, holds: [Keys.Cellar] })` (Sub-plan 1's `holds`). The NPC's `npc_behavior_key` → `caretakerScript`.
- [ ] Run `pnpm -r typecheck` + `manifest-boot.test.ts` (boots HH through the Authority — validates the caretaker's `npc_behavior_key`, the intro scene key, the door + formation threading, and the bigint catalog path). If `scripted.test.ts` asserts a behavior-key count, update it. Commit.

## Task 3: Capstone update + composed caretaker differential fixture
**Files:** `packages/play/src/core/capstone.test.ts` (winning path); a new `conformance/fixtures/caretaker.gen.test.ts` + replay + vitest.config registration.

- [ ] Update the capstone winning path (capstone.test.ts): before the `s // Foyer → Cellar` step (~line 194), insert `talk to caretaker` (receive the cellar key); the Foyer→Cellar move now emits the cellar-door opened line. Assert the caretaker intro cue appears in the startup cues, and the caretaker is gone after the hand-off. The full win still asserts `outcome === "won"`.
- [ ] Composed differential fixture: drive the HH oracle (or a facade over it) through — startup (intro cue) → `examine caretaker` (description cue) → `talk caretaker` (hand-off: cellar key received, caretaker `visible:false`, response cue) → `talk caretaker` again / `examine caretaker` (gone) → `move` Foyer→Cellar (locked before the key would've failed; with the key, unlocked + opened line). Assert byte-identical Rust↔oracle. Register the generator; replay green.
- [ ] Commit.

## Task 4: README + full gate
- [ ] README (Characters / NPCs section): NPCs (visible flag, `examine` description, `talk` dialogue non-advancing, dialogue effects), and the Hollow House caretaker (intro, cellar-key hand-off, keyed cellar door).
- [ ] `pnpm run checks:phase2` green end-to-end (incl. capstone, manifest-boot, caretaker fixture, both wasm builds, bindings, typechecks). Commit.

## Self-Review
- The caretaker is authored data (NPC dialogue script + intro mechanic + door script + key/holds + keyed exit) atop Sub-plans 1-2 — zero new engine code. The auto-intro uses the round-0-mechanic path (surfaces via startup cues) rather than a discarded start-room scene. The capstone gains one `talk` step; the cellar is gated by the caretaker's key while the Revenant/iron-key/attic win is otherwise unchanged.
