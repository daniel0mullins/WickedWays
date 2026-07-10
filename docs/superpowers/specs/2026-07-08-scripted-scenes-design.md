# NPC Dialogue System — Sub-plan 3: Scripted Scenes (data-driven, with effects)

**Status:** Design approved, ready for implementation plan
**Date:** 2026-07-08
**Branch:** `design/rust-engine-core`
**Part of:** the NPC dialogue system. Inserted between Sub-plan 2 (dialogue) and the caretaker content (now Sub-plan 4). Depends on Sub-plan 1's `Effect::GiveItem`/`SetVisible`.
**Related:** the scripted-ops DSL, data-driven formations/items (the "first-party content as data" precedent), the Phase-1 native scene system (6c-2).

## Goal

Make scenes **first-class scripted behaviors authored as data**: a `BehaviorScript::Scene` family whose `on_enter`/`on_exit` bodies produce **cues AND effects** (via the DSL effect pipeline), gated by a `can_play` predicate over the scene's own state. And make a **start-room `onEnter` scene actually fire and surface its cues at game start** (today it fires at TS boot before genesis and its cues are discarded; the Rust core never re-fires it). This unlocks room-scoped intros that display at game start and scenes that mutate state (e.g. `SetVisible` to resurrect an NPC).

## Background

Scenes today are **native-only** and **cue-only**: `SceneBehavior { can_play(room, state) -> bool; run_script(room, state) -> Vec<MechanicCue> }`, resolved by `scene_behavior(key)` (conformance `visit-counter` only), fired from `fire_scenes` in `move_to` (exit + enter) and on formation spawn. Rooms attach scenes via `RoomSnapshot.scenes: Vec<SceneSnapshot>` (`behaviorKey` + JSON `state`). The TS twin: `SceneBehavior { script: (room, state) => MechanicCue[] | void }`. **Start-room timing (confirmed):** the start-room enter-scene fires during TS boot (`pc.move(startRoom)`) *before* genesis serialization; its cues go to the TS cue buffer and are never captured (`takeStartupCues` returns only `begin_campaign`'s round-0 dispatch cues); the scene's *state* mutation is baked into genesis; the Rust core never fires it. So a start-room scene shows nothing today.

## Scope

1. **`BehaviorScript::Scene` family (data-driven).** A `SceneScript { can_play: Expr /*predicate, default true*/, on_enter?: Vec<Stmt>, on_exit?: Vec<Stmt> }`. `on_enter`/`on_exit` are **effect bodies** (`Vec<Stmt>` → `Vec<Effect>`) — the same DSL effect body mechanics use — so they can `Emit(Cue …)`, `Emit(SetVisible …)`, `Emit(GiveItem …)`, and `SetState(…)` on the scene's own JSON state. Resolved (like formations) native-first-then-descriptor: `scene_behavior(key)` native, else `catalog.behaviors[key]` as `BehaviorScript::Scene`.
2. **Scene effect channel.** `fire_scenes` gains the ability to evaluate a scripted scene's body into `Vec<Effect>` and run them through the existing collect-then-apply pipeline (cues + `SetVisible`/`GiveItem`/state), capped at `MAX_EFFECTS_PER_EVENT`. Native scenes keep their cue-only path (resolved as `Native`). The scene `Ctx` gets: the room (`RoomSource`), the scene's `state` (read/write), the injected `rng`, and the **entering/exiting character as `actor`** (so a scene can target the enterer / read occupants).
3. **Start-room enter-scene firing + cue surfacing at `begin_campaign`.** Leave the start-room scene **pristine in genesis** (the TS boot places the PC via a non-scene-firing placement so no boot-time firing / no lost cues / no pre-mutated state), then `begin_campaign` (core, run by the Authority) fires the **start room's enter-scenes** for the active player and captures their cues into the **startup cues** (`take_startup_cues`). Fired exactly once (pristine → first firing). The TS oracle mirrors (its begin/startup fires + surfaces the same). Regular `move_to` enter/exit firing is unchanged.

## Architecture

- **AST:** `SceneScript` + `BehaviorScript::Scene { script }` (serde `family="scene"`, ts-rs), mirroring `MechanicScript`'s hook-body shape (`on_enter`/`on_exit` are `Option<Vec<Stmt>>` effect bodies; `can_play` is an `Expr` predicate). `validate_behavior` gains a `Scene` arm.
- **Adapter/seam:** a `ScriptedScene` adapter (mirrors `ScriptedMechanic`) with `can_play(...) -> bool` and `run(phase, ctx) -> Vec<Effect>`. A `resolve_scene(key, cat)` (native-first, then `catalog.behaviors`), used at every `fire_scenes` site. `validate_mechanics` extends to validate every room's scene `behaviorKey` resolves.
- **`fire_scenes`:** for each attached scene, resolve → if `can_play` → run the phase body → for a scripted scene apply the returned `Vec<Effect>` (cues surface, `SetVisible`/`GiveItem`/state apply); for a native scene push its cues as today. It already runs at `move_to` (exit before occupant retain, enter after push) and formation spawn; add the `begin_campaign` start-room enter call.
- **Boot pristine-state:** the TS boot (`session.ts boot` / `orchestration startSession`) places the starting PC via a **non-enter-firing** placement (`[PLACE]`-style) instead of `pc.move(startRoom)`, so genesis carries un-fired scene state and no cues are lost. `begin_campaign` (Rust + oracle) owns the one-time start-room enter firing.
- **TS oracle:** `oracle-session.ts`'s begin/startup + `fire_scenes` equivalent run the same data-driven scene interpreter (or the shared matcher/eval), byte-identical.

## Determinism & the gate

- Deterministic: predicate + ordered effect body + serialized scene state + injected rng.
- **Gate coverage:** a scripted-scene differential fixture — `on_enter` emitting a cue + a `SetState` + an effect (e.g. `SetVisible`), `can_play` gating (fires while `count < N`), `on_exit`, and **the start-room scene firing once at game start with its cue in the startup cues** (byte-identical Rust↔oracle). The existing native `visit-counter` scene fixture stays green (native path unchanged); if its start-room handling shifts, regenerate its golden (expected, additive).
- `no_std`, `bindings:check` (new AST types), `checks:phase2` green.

## Non-goals

- Not migrating the native `conformance:visit-counter` to data (native stays, resolved first).
- No scene scheduling beyond enter/exit + the start-room-at-begin firing.
- The caretaker content (Sub-plan 4) consumes this; no HH content here.

## Invariant check

- **Gate is authority** — scripted scenes diffed Rust↔oracle; start-room surfacing gated; fixes in interpreter/AST, never goldens. ✅
- **Determinism / `no_std`** — pure eval, serialized state, alloc-only. ✅
- **First-party as data** — scenes join mechanic/exit/victory/item/npc/formation as authorable catalog data, with an effect channel. ✅
