# NPC Dialogue System — Sub-plan 3: Scripted Scenes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`). The start-room firing (Task 3) is delicate — pristine genesis state, fire exactly once, both engines; gate it.

**Goal:** Data-driven `BehaviorScript::Scene` (`can_play` + `on_enter`/`on_exit` effect bodies → cues + effects), a scene effect channel in `fire_scenes`, and start-room enter-scene firing + cue surfacing at `begin_campaign`.

**Spec:** `docs/superpowers/specs/2026-07-08-scripted-scenes-design.md`. **Depends on Sub-plan 1** (`Effect::GiveItem`/`SetVisible`, `visible`).

## Global Constraints
- Differential gate authority; native `conformance:visit-counter` scene path unchanged (resolve native-first). `no_std`; `bindings:check`; `checks:phase2` green. `GameSession.start` sync.

---

## Task 1: `SceneScript` AST + `BehaviorScript::Scene` + validation + bindings
**Files:** `crates/wickedways-core/src/script/ast.rs` (`BehaviorScript` + a `SceneScript`, mirror `MechanicScript`/`MechanicHooks`); `crates/wickedways-core/src/script/mod.rs` (`validate_behavior`); `crates/wickedways-core/src/stats.rs` (ts export); bindings.

- [ ] Define `SceneScript { #[serde(default)] can_play: Option<Expr>, #[serde(default, skip_serializing_if=Option::is_none)] on_enter: Option<Vec<Stmt>>, #[serde(default, skip_serializing_if=Option::is_none)] on_exit: Option<Vec<Stmt>> }` (serde+ts-rs). Add `BehaviorScript::Scene { script: SceneScript }` (family `"scene"`).
- [ ] `validate_behavior` Scene arm: `can_play` via `check_expr` (predicate); `on_enter`/`on_exit` via `check_stmts(_, allow_pass=false, allow_emit=true)`. Register `SceneScript` in stats.rs export. Regen bindings, `bindings:check`.
- [ ] Tests (accept a valid scene; reject a Pass in a scene body). no_std. Commit.

## Task 2: `ScriptedScene` adapter + `resolve_scene` + scene effect channel in `fire_scenes`
**Files:** `crates/wickedways-core/src/script/ops.rs` (`ScriptedScene`); `crates/wickedways-core/src/world/scenes.rs` (`resolve_scene`, mirror `resolve_formation`); `crates/wickedways-core/src/world/movement.rs` (`fire_scenes` ~196-245); tests.

- [ ] Failing test: a room with a scripted scene (`on_enter` emitting a `Cue` + a `SetVisible`) — firing enter applies both (cue surfaces, target hidden); `can_play=false` skips; state `SetState` persists across fires.
- [ ] `ScriptedScene { script: &SceneScript }` with `can_play(&self, ctx) -> bool` (eval `can_play` predicate, default true) and `run(&self, on_enter|on_exit body, base, actor) -> Vec<Effect>` (build `Ctx` like `ScriptedMechanic::run_body` but with `rooms: RoomSource::World{..}` so scenes read the room, `actor` = the entering/exiting character, `state` = the scene's JSON state (Write)).
- [ ] `resolve_scene(key, cat) -> Option<ResolvedScene>` (`Native(&'static dyn SceneBehavior) | Scripted(&SceneScript)`), native-first then `catalog.behaviors`. Update `fire_scenes`: per attached `SceneSnapshot`, `resolve_scene` → native: existing cue path; scripted: if `can_play`, eval the phase body → `apply_all(effects)` (cap `MAX_EFFECTS_PER_EVENT`) using the scene's `&mut state`. `fire_scenes` already has `&mut self`/`cat`/`cues`; thread `rng` + the actor.
- [ ] Tests pass; native visit-counter path unchanged; no_std. Commit.

## Task 3: Start-room enter-scene firing + cue surfacing at `begin_campaign` (+ pristine genesis)
**Files:** `crates/wickedways-core/src/world/turn.rs` (`begin_campaign` ~23-30); the startup-cue capture (`take_startup_cues` / authority.rs); `packages/play-runtime/src/session.ts` (`boot` ~71-96) + `src/lib/authoring/orchestration.ts` (`startSession` ~72-87) — non-firing start placement; `conformance/fixtures/oracle-session.ts` (begin/startup mirror); tests.

- [ ] Failing differential-style test: a start-room `onEnter` scripted scene's cue appears in the **startup cues** at game start (not lost), fires exactly once, and its state is un-fired in genesis.
- [ ] **Pristine genesis:** change the TS boot start placement from `pc.move(startRoom)` (fires enter-scenes → lost cues + pre-mutated state) to a non-enter-firing placement (`[PLACE]`-style) so genesis scene state is pristine and nothing is lost. (Confirm `[PLACE]` sets `currentRoom` + occupant for a PC; mirror how mobs/NPCs are placed.) Regular later `move` still fires scenes.
- [ ] **Fire at begin:** in `begin_campaign` (after `started = true`, around the round-0 dispatch), fire the active player's **start room enter-scenes** via `fire_scenes(room, "enter", …)` into the same cue buffer `take_startup_cues` returns. Order vs the round-0 mechanic dispatch: pin it (likely enter-scenes before/after round-start — choose and gate). The oracle's begin/startup mirrors.
- [ ] `validate_mechanics`: add a loop validating every room's `SceneSnapshot.behaviorKey` resolves via `resolve_scene` (native or descriptor) — fail fast.
- [ ] Tests pass (start-room scene surfaces once); existing scene/movement tests green; no_std. Commit.

## Task 4: TS `scene({...})` builder + differential fixture
**Files:** `packages/campaigns/src/scripted/builders.ts` (`scene(...)`); `conformance/fixtures/scripted-scene.gen.test.ts` + replay + vitest.config; (catalog threading already flows scenes via `behaviors`).

- [ ] `scene({ canPlay?, onEnter?, onExit? })` builder emitting `{ family: "scene", script: {...} }` (mirror `mechanic(...)`); builder unit test.
- [ ] Scripted-scene differential fixture: a bespoke campaign whose **start room** has a scripted `onEnter` scene (cue + `SetState`) → assert the cue is in the startup cues + state advanced; plus a second room with an `onEnter` scene that emits an effect (`SetVisible` on a seeded occupant) + a `can_play` gate (fires while count<2, then stops) + an `onExit` cue. Drive the oracle; replay byte-identical (gates the effect channel, `can_play`, state, and start-room surfacing). Register the generator.
- [ ] `pnpm run wasm:build:conformance` + replay green. Commit.

## Task 5: Docs + gate
- [ ] README (scenes section): scenes authorable as data (`BehaviorScript::Scene`) with `can_play` + `on_enter`/`on_exit` emitting cues **and** effects; start-room onEnter scenes fire + surface at game start.
- [ ] `pnpm run checks:phase2` green. Commit.

## Self-Review
- Reuses the DSL effect body + `Effect::GiveItem`/`SetVisible` (Sub-plan 1) for scene effects. Native scenes untouched (resolve native-first). Start-room surfacing is the delicate bit — pristine genesis + fire-once-at-begin, gated. Consumed by Sub-plan 4 (caretaker intro is a data `onEnter` scene; a later scene could `SetVisible`-resurrect).
