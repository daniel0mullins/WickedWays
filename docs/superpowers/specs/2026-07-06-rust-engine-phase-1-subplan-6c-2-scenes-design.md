# Rust Engine — Phase 1, Sub-plan 6c-2: Scenes (design)

## Context

We are re-authoring the TypeScript RPG engine (`src/`) as a Rust core (`crates/wickedways-core`),
verified byte-for-byte against the TS "oracle" by a differential conformance gate. Sub-plan 6a
built the `MechanicOp` registry + hook/effect machinery; 6a-2/6a-3 completed turn-end faithfulness
and custom mechanic actions; **6c-1 ported keyed exits** (the `ExitBehavior` trait + `exit_behavior(key)`
registry + a keyed `go` path). Sub-plan **6b (`ScriptedMechanic`/Rhai) is DEFERRED** to nearer the
Phase-2 hosted-tier cutover.

Sub-plan **6c** ports the remaining registry-bound behaviors the oracle has — keyed exits (6c-1),
**scenes (this spec, 6c-2)**, and encounter spawning (6c-3, which will fold the carried mob debts).
NPC dialogue is deferred out of Phase 1.

Today the Rust core has the *serialized data shape* of scenes (`SceneSnapshot { id, behavior_key,
phase, state }` in `world/snapshot.rs:47-54`, and `RoomSnapshot.scenes` in `world/snapshot.rs:90`),
but **zero behavior**: there is no `SceneBehavior` trait, no scene registry, and `move_to` never
fires scenes (`world/movement.rs:5,151` carry "deferred to sub-plan 6" stubs).

## Scope note: this sub-plan EXTENDS the oracle, then ports it

Unlike prior sub-plans (pure ports), 6c-2 has two parts:

1. **Extend the TS oracle** so scene scripts can emit cues. This capability was never implemented
   in the TS package (`ScriptFn` is `(r, state) => void`, `scene.ts:14`; `Room.enterRoom`/`exitRoom`
   discard `playScene`'s result, `room.ts:289,297`; git history shows no cue work added-then-reverted).
   It is a deliberate feature addition, decided during brainstorming.
2. **Port the extended contract to Rust**, gated by the differential harness (a matched TS-closure
   shadow + a native Rust impl under a shared `behaviorKey`, the same approach proven for mechanics
   and exits).

**No existing golden churns.** Every current fixture has `scenes: []`, so scene-less rooms collect
zero scene cues and emit an identical cue stream. Only the new scene fixture adds goldens.

## The contract being ported (extended)

### TS `Scene` today (authoritative source)

`Scene<TState>` (`src/lib/scene.ts:73-143`), serialized shape `SceneSnapshot { id, behaviorKey,
phase, state }` (`src/lib/serialization/types.ts:48-53`). Behavior is separated from state exactly
like `Exit`: the closures (`preconditions`, `script`) are rebound from the registry by `behaviorKey`
on hydrate (`hydrateScene`, `scene.ts:151-162`); only `state` (+ `id`, `behaviorKey`, `phase`)
serializes.

`SceneBehavior` (`src/lib/serialization/registry.ts:11-14`) is `{ preconditions, script }` — no
messages, and (today) a `void` script.

`playScene(phase, room)` (`scene.ts:135-142`): if `#triggerPhase === phase` and every precondition
passes, run `#script(room, #state)`. Preconditions receive `(room, Readonly<state>)`; the script
receives `(room, state)` mutable. **Preconditions and the script gate on the ROOM (and its
occupants), never the actor** — the triggering character is not passed to the scene.

Scenes fire from the room, driven by movement:
- `Room.enterRoom(character)` (`room.ts:287-290`): adds the occupant, **then** plays `"enter"` scenes.
- `Room.exitRoom(character)` (`room.ts:296-299`): plays `"exit"` scenes, **then** removes the occupant.
- `Character.#enterRoom(room)`: `oldRoom.exitRoom(this)` → set `#currentRoom` → `newRoom.enterRoom(this)`.
- `Character.move(room)` (`character.ts:1018-1032`): affliction/budget gate → `#enterRoom(room)` →
  dark-room visibility cue → `recordAction`. So scenes fire **inside `#enterRoom`, before the
  visibility cue and before `recordAction`/encounters**.

Occupant timing is load-bearing: during a room's **exit**-scenes the mover is **still** an occupant
of that room (removal happens after); during a room's **enter**-scenes the mover **is already** an
occupant (add happens before).

### The extension: scenes emit cues

Decided in brainstorming: **scenes may emit zero or more mechanic cues per firing** (return-value
mechanism, mirroring the 6c-1 Exit `runScript` precedent; **mechanic cue kind only**).

- `ScriptFn<TState>` becomes `(r: IRoom, state: TState) => MechanicCue[] | void`.
- `IScene.playScene` and `Scene.playScene` return `MechanicCue[]` (the script's cues, or `[]` when
  the scene does not fire or returns nothing).
- `SceneBehavior.script` return type becomes `MechanicCue[] | void`.
- `Room.enterRoom`/`exitRoom` **collect** each scene's cues and return `MechanicCue[]` (concatenated
  in `#scenes` push order).
- `Character.#enterRoom` gathers the old room's exit-scene cues **then** the new room's enter-scene
  cues, and emits them (as `{ kind: "mechanic", cue: MechanicCue }`) into the move's cue stream —
  **before** the visibility cue and before `recordAction`.

`MechanicCue` is the existing `{ text?: string, sound?: string }` type (`src/lib/mechanics/mechanic`).
Existing TS scene/room unit tests get their signatures updated for the new return types; scene-less
behavior is unchanged (empty scene lists collect no cues).

## Design (Rust)

### 1. `SceneBehavior` trait + registry — new `crates/wickedways-core/src/world/scenes.rs`

Mirrors `world/exits.rs`. Object-safe, keyed by `behavior_key`:

```rust
use crate::presentation::MechanicCue;
use crate::world::mechanics::RoomView;
use serde_json::Value;
use alloc::vec::Vec;

/// A first-party scene behavior. `state` is the scene's serialized `Value`.
pub trait SceneBehavior: Sync {
    /// TS `preconditions.every` — read-only over the room view + scene state.
    fn can_play(&self, room: &RoomView, state: &Value) -> bool;
    /// TS `script` — runs on a matched phase + passing preconditions; may mutate its own
    /// `state`; returns the mechanic cues to emit (empty = none). Room-WRITE deferred.
    fn run_script(&self, room: &RoomView, state: &mut Value) -> Vec<MechanicCue>;
}

/// Resolve a first-party scene behavior by key. `None` for an unregistered key
/// (surfaced as a `ProceduralViolation` at the fire site).
pub fn scene_behavior(key: &str) -> Option<&'static dyn SceneBehavior> { … }
```

Differences from `ExitBehavior`: `run_script` returns `Vec<MechanicCue>` (not `Option<String>`);
there is no `can_pass`-vs-`run_script` split naming difference beyond `can_play`; there are no
pass/fail messages. Conformance impl behind `#[cfg(any(test, feature = "conformance"))]`.

An unregistered `behavior_key` at fire time → `Err(ProceduralViolation)` (mirrors TS
`registry.scene()`'s `#require` throw; same treatment as the exit path). This is the design's only
error case.

### 2. Read channel — `RoomView`

Reuse the existing `RoomView` (`world/mechanics/view.rs:43-49`; currently never constructed —
`CampaignView.rooms` is always `Vec::new()`). Extend it with `occupants: Vec<CharacterView>` so a
scene precondition/script can inspect occupants exactly as TS `room.occupants` allows (presence,
held keys, status). Adding the field is zero-churn (no `RoomView` literal exists today).

Add a builder `World::room_view(&self, room_id: &RoomId, cat: &Catalog) -> Option<RoomView>` that
projects `id`, `name`, `lit` (via `is_lit`), `occupant_ids`, and `occupants` (each via the existing
`character_view`). Built **owned** before any `get_mut`, so the mutable scene-state borrow does not
conflict.

### 3. Firing wiring in `move_to` — exact TS ordering

Replace the two "deferred to sub-plan 6" stubs (`movement.rs:5,151`). A helper:

```rust
fn fire_scenes(
    &mut self,
    room_id: &RoomId,
    phase: &str, // "enter" | "exit"
    cat: &Catalog,
    cues: &mut Vec<PresentationCue>,
) -> Result<(), ProceduralViolation>
```

builds `room_view(room_id, cat)` once (owned), then iterates `rooms.get_mut(room_id).scenes.iter_mut()`,
skips scenes whose `phase != phase`, resolves `scene_behavior(&scene.behavior_key)` (unregistered →
`Err`), and on `can_play(&view, &scene.state)` runs `run_script(&view, &mut scene.state)` and pushes
each returned `MechanicCue` as `PresentationCue::Mechanic { cue }` in order. Scene iteration order =
snapshot `scenes` order (TS `#scenes` push order).

Insertion points in `move_to`, matching TS occupant timing precisely:
- **Exit-phase scenes of the old room** fire **before** the `occupant_ids.retain` (mover still an
  occupant). Call `fire_scenes(&prev, "exit", …)` at the top of `move_to`, guarded by the same
  `current_room_id` lookup that drives the retain.
- **Enter-phase scenes of the new room** fire **after** the occupant `push` and **before** the
  visibility cue. Call `fire_scenes(&room, "enter", …)` immediately after the push.

`fire_scenes` returns `Result`; `move_to` propagates with `?`. Scene firing is kind-agnostic (fires
for any mover, like TS). Resulting cue order for a move:
`[old-room exit-scene cues…, new-room enter-scene cues…, visibility? , move action cue, turn-end cues, encounter cues]`.

### 4. Conformance behavior + differential fixture

A `conformance:visit-counter` `SceneBehavior` (feature/test-gated), mirrored by a TS closure under
the same key:
- `can_play` = `state.count < 3` (state gate) **and** `!room.occupants.is_empty()` (exercises the
  room-read channel; trivially true while a mover is present).
- `run_script` = increment `state.count`, then return a single
  `MechanicCue { text: Some("The room stirs (visit {count}).".into()), sound: None }` where `{count}`
  is the **post-increment** value (ties the cue to the mutated state).

Differential fixture (`scene.gen.test.ts` + replay test): a two-room map (A, B). **Both** rooms carry
an `"enter"` scene and an `"exit"` scene, all `conformance:visit-counter`, each with independent
`state`. A PC ping-pongs A→B→A→B… . The command sequence proves:
- **enter firing** and **exit firing** (both phases run);
- **phase discrimination** (an `"enter"` scene does not fire on exit, and vice versa);
- **ordered cue stream** per step (old-room exit-scene cue precedes new-room enter-scene cue,
  and both precede the move action cue);
- **state persistence across visits** (each scene's `count` climbs on repeat visits);
- **precondition gating** (each scene's `count` caps at 3, after which it neither mutates nor emits);
- the **room-read channel** (the `!occupants.is_empty()` precondition).

Because scenes now emit cues **and** persist state, the gate diffs Rust-native vs TS-closure on
**both** the per-step ordered cues **and** the per-step `SceneSnapshot.state` in the room snapshots.

**Prerequisite (folds the deferred 6c-1 cleanup):** `Scene[SERIALIZE]` (like `Exit`) returns `state`
by **live reference**, so the generator must **structurally deep-copy** scene state at each capture
step — otherwise every golden step would show the final counts. Extract a shared
`conformance/fixtures/gen-helpers.ts` with a structural deep-copy capture and use it here.

### 5. Folded 6c-1 cleanup batch

Batched into 6c-2 (its own task, plus the gen-helper which is a scene prerequisite):
- **(a)** shared `conformance/fixtures/gen-helpers.ts` with **structural** deep-copy capture (used by
  the scene fixture; prerequisite, not optional).
- **(b)** registry `#[cfg]`-per-arm restructure — apply a clean structure in `scenes.rs`, tidy the
  per-arm `#[cfg]` in `exits.rs::exit_behavior`.
- **(c)** dedup the duplicate movement unregistered-key test (`movement.rs` has both
  `go_through_a_keyed_exit_with_unregistered_behavior_key_errors` and
  `keyed_exit_unregistered_key_errors`; keep one).
- **(d)** hoist the far-endpoint `a`/`b`/`dest` triple in `go` (computed twice — the keyed branch and
  the behavior-free branch).
- **(e)** README "if any" wording fix from the 6c-1 review.

### 6. Testing

- **Rust unit tests:** registry resolve/reject; `can_play` true/false on both channels (state gate,
  occupants gate); phase discrimination; `run_script` mutates `state` and returns the expected cue
  with the post-increment count; precondition gating stops mutation **and** cue emission at the cap;
  exit-before-removal / enter-after-add occupant timing (a precondition reading occupants sees the
  mover); unknown `behavior_key` → `ProceduralViolation`; cue ordering within a firing batch.
- **TS unit tests:** update `scene.test.ts` / `room.test.ts` for the new return types; add a case
  asserting a scene's returned cues propagate through `enterRoom`/`exitRoom` and land in the move's
  cue stream before the visibility cue.
- **Differential fixture** (above) exercising all outcomes across cues + snapshot state.
- **No pre-existing golden churn:** existing fixtures have no scenes; `git status --short
  conformance/fixtures` shows only the new scene fixture files. Full gate `pnpm run checks:phase3`
  EXIT 0 + `pnpm run fixtures:stable` EXIT 0.
- **`no_std`:** `alloc::` only; conformance behavior feature-gated, absent from the default build
  (`cargo build -p wickedways-core --no-default-features`).

## Deferred / carried

- **Scene room-WRITE channel** — a scene can read the room + write its own state + emit cues, but
  cannot yet mutate the room itself. Deferred with a design note; if a real scene needs it, it wants
  a room-effect channel like 6a mechanics.
- **`[PLACE]`/spawn-path enter-scene firing** — 6c-3 (encounter spawning) must also fire enter-scenes
  when seating mobs; noted for 6c-3.
- **Optional `validate_scenes`** (parallel to `validate_mechanics`) — deferred unless a call site
  needs it.
- Carried mob debts (`sees_in_dark` differential coverage, mob-with-equipped-item/key drop fixture,
  `deposit_materials` non-numeric-qty one-liner) remain 6c-3.

## Documentation

Per the standing convention, update `README.md` (and relevant Rust/TS doc comments) to document
scenes: the `SceneBehavior` registry, the `can_play`/`run_script` contract, the enter/exit trigger
+ occupant timing, the new cue-emission channel (mechanic cues, emitted before the visibility cue),
and the `move_to` firing order — before the work is considered done.
