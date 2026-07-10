# Sub-plan 6c-2: Scenes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add scene cue emission to the TS oracle, then port the full scene contract (registry-bound `SceneBehavior` fired on room enter/exit during movement) to the Rust core, verified by a new differential conformance fixture.

**Architecture:** Extend the TS `Scene`/`SceneBehavior`/`Room`/`Character` so a scene's `script` returns `MechanicCue[]` that thread up through `enterRoom`/`exitRoom` → `#enterRoom` → `move` and emit before the visibility cue. Then mirror that in Rust: a native `SceneBehavior` trait resolved by `behavior_key` (like `ExitBehavior`), a `RoomView` read channel, and a `fire_scenes` helper wired into `move_to` at the exact TS occupant-timing points. Gate it with a matched TS-closure shadow + native Rust impl under a shared key.

**Tech Stack:** TypeScript (oracle, `src/lib/`), Rust `no_std` core (`crates/wickedways-core`) compiled to WASM, vitest differential harness (`conformance/`).

## Global Constraints

- **The differential conformance gate is the authority.** Divergences are fixed in Rust source (or a faithful fixture correction) — NEVER by editing goldens or loosening `conformance/canonical-json.ts`.
- **No existing golden churn.** Every current fixture has `scenes: []`; scene-less rooms must collect zero cues and emit identically. `git status --short conformance/fixtures` after the final task shows only the new `scene.*` fixture files (plus the new shared `gen-helpers.ts` and the keyed-exit refactor, whose golden must be byte-identical).
- **`no_std` core:** `alloc::` only, never `std::`. All conformance ops/behaviors behind `#[cfg(any(test, feature = "conformance"))]`, absent from the default build. Verify `cargo build -p wickedways-core --no-default-features` succeeds.
- **Scenes emit mechanic cues only.** A scene's `run_script` returns `Vec<MechanicCue>` (empty = none); each is emitted as `PresentationCue::Mechanic { cue }`.
- **Cue ordering in a move:** `[old-room exit-scene cues…, new-room enter-scene cues…, visibility?, move action cue, turn-end cues, encounter cues]`. Scene cues come before the visibility cue.
- **Occupant timing is load-bearing:** exit-phase scenes fire while the mover is STILL an occupant of the old room (before removal); enter-phase scenes fire while the mover IS already an occupant of the new room (after the add).
- **Illegal ops throw `ProceduralViolation`:** an unregistered scene `behavior_key` at fire time → `Err(ProceduralViolation)` (mirrors TS `registry.scene()`'s `#require` throw).
- **Branded IDs:** generate/convert through helpers; never cast a raw `String` into a branded id.
- **Full gate:** `pnpm run checks:phase3` EXIT 0 and `pnpm run fixtures:stable` EXIT 0 before done.
- **Docs:** update `README.md` + Rust/TS doc comments to document scenes before the work is considered done.

---

## File Structure

- `src/lib/scene.ts` — `ScriptFn` and `playScene` return `MechanicCue[] | void` / `MechanicCue[]`.
- `src/lib/serialization/registry.ts` — `SceneBehavior.script` returns `MechanicCue[] | void`.
- `src/lib/room.ts` — `enterRoom`/`exitRoom` collect and return `MechanicCue[]`.
- `src/lib/character/character.ts` — `#enterRoom` returns collected cues; `move` emits them before the visibility cue; `[PLACE]` discards them.
- `crates/wickedways-core/src/world/mechanics/view.rs` — `RoomView` gains `occupants: Vec<CharacterView>`; new `World::room_view` builder.
- `crates/wickedways-core/src/world/scenes.rs` — NEW: `SceneBehavior` trait, `scene_behavior(key)` registry, `conformance::VisitCounter`.
- `crates/wickedways-core/src/world/mod.rs` — register `pub mod scenes;`.
- `crates/wickedways-core/src/world/movement.rs` — new `fire_scenes` helper; wire it into `move_to`; module doc-comment update; folded cleanup (dedup test, hoist far-endpoint triple).
- `crates/wickedways-core/src/world/exits.rs` — folded cleanup: registry `#[cfg]` restructure.
- `conformance/fixtures/gen-helpers.ts` — NEW: shared structural deep-copy capture helper.
- `conformance/fixtures/scene-shadow.ts` — NEW: TS `SceneBehavior` shadow of the Rust conformance behavior.
- `conformance/fixtures/scene.gen.test.ts` — NEW: golden generator (writes `scene.start.snapshot.json`, `scene.catalog.json`, `scene.golden.json`).
- `conformance/scene.test.ts` — NEW: differential replay test.
- `conformance/fixtures/keyed-exit.gen.test.ts` — folded cleanup: use the shared `gen-helpers.ts`.
- `README.md` — document scenes.

---

## Task 1: TS oracle — scene cue emission

**Files:**
- Modify: `src/lib/scene.ts` (`ScriptFn` type ~:14; `IScene.playScene` ~:55; `Scene.playScene` ~:135-142)
- Modify: `src/lib/serialization/registry.ts` (import ~:8; `SceneBehavior` ~:11-14)
- Modify: `src/lib/room.ts` (import ~:7; `IRoom.enterRoom`/`exitRoom` ~:92-94; `Room.enterRoom`/`exitRoom` ~:287-299)
- Modify: `src/lib/character/character.ts` (`#enterRoom` ~:991-997; `move` ~:1018-1032)
- Test: `src/lib/scene.test.ts`, `src/lib/room.test.ts`

**Interfaces:**
- Produces:
  - `type ScriptFn<TState> = (r: IRoom, state: TState) => MechanicCue[] | void`
  - `Scene.playScene(phase, room): MechanicCue[]` and `IScene.playScene: (phase, room) => MechanicCue[]`
  - `SceneBehavior.script: (room: IRoom, state: never) => MechanicCue[] | void`
  - `Room.enterRoom(character): MechanicCue[]`, `Room.exitRoom(character): MechanicCue[]` (and the `IRoom` signatures)
  - `Character.#enterRoom(room): MechanicCue[]` (private; `move` emits the returned cues as `{ kind: "mechanic", cue }` before the visibility cue; `[PLACE]` discards them)
- `MechanicCue` is `{ text?: string; sound?: AssetRef }` from `src/lib/mechanics/mechanic`.

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/scene.test.ts`:

```ts
import { Scene } from "./scene";
import type { MechanicCue } from "./mechanics/mechanic";
import type { IRoom } from "./room";

describe("Scene cue emission", () => {
  const roomStub = { name: "Cell", occupants: [{}] } as unknown as IRoom;

  it("returns the script's cues when the phase matches and preconditions pass", () => {
    const scene = new Scene<{ n: number }>({
      phase: "enter",
      preconditions: [(_r, s) => s.n < 2],
      script: (_r, s): MechanicCue[] => {
        s.n += 1;
        return [{ text: `stir ${s.n}` }];
      },
      initialState: { n: 0 },
      behaviorKey: "test/counter",
    });
    expect(scene.playScene("enter", roomStub)).toEqual([{ text: "stir 1" }]);
    expect(scene.playScene("enter", roomStub)).toEqual([{ text: "stir 2" }]);
    // precondition now false (n === 2): no fire, no cue, no mutation
    expect(scene.playScene("enter", roomStub)).toEqual([]);
  });

  it("returns [] when the phase does not match", () => {
    const scene = new Scene({
      phase: "enter",
      preconditions: [],
      script: (): MechanicCue[] => [{ text: "should not fire" }],
      behaviorKey: "test/x",
    });
    expect(scene.playScene("exit", roomStub)).toEqual([]);
  });

  it("returns [] when the script returns void", () => {
    const scene = new Scene({
      phase: "enter",
      preconditions: [],
      script: () => {
        /* void */
      },
      behaviorKey: "test/void",
    });
    expect(scene.playScene("enter", roomStub)).toEqual([]);
  });
});
```

Add to `src/lib/room.test.ts` (a room collects and concatenates its scenes' cues in registration order):

```ts
import type { MechanicCue } from "./mechanics/mechanic";

it("enterRoom collects enter-scene cues in registration order; exitRoom collects exit-scene cues", () => {
  const room = makeTestRoom(); // existing helper in this file
  const character = makeTestCharacter(); // existing helper
  const mkScene = (phase: "enter" | "exit", text: string) =>
    new Scene({
      phase,
      preconditions: [],
      script: (): MechanicCue[] => [{ text }],
      behaviorKey: `test/${text}`,
    });
  room.registerScene(mkScene("enter", "a"));
  room.registerScene(mkScene("exit", "x"));
  room.registerScene(mkScene("enter", "b"));

  expect(room.enterRoom(character)).toEqual([{ text: "a" }, { text: "b" }]);
  expect(room.exitRoom(character)).toEqual([{ text: "x" }]);
});
```

> If `makeTestRoom`/`makeTestCharacter` do not exist under those names in `room.test.ts`, use whatever room/character construction the surrounding tests in that file already use — match the file's existing pattern.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/lib/scene.test.ts src/lib/room.test.ts`
Expected: FAIL — `playScene`/`enterRoom`/`exitRoom` currently return `void`, so `.toEqual([...])` fails (or a type error surfaces under typecheck).

- [ ] **Step 3: Extend `scene.ts`**

Add the import near the top of `src/lib/scene.ts`:

```ts
import type { MechanicCue } from "./mechanics/mechanic.js";
```

Change `ScriptFn` (~:14):

```ts
/** The scripted effect a scene runs against the room it fired in; may mutate the
 *  scene's persisted state, and returns the mechanic cues to emit (or nothing). */
type ScriptFn<TState> = (r: IRoom, state: TState) => MechanicCue[] | void;
```

Change the `IScene.playScene` signature (~:55):

```ts
  playScene: (phase: TriggerPhase, room: IRoom) => MechanicCue[];
```

Change `Scene.playScene` (~:135-142) to return the cues:

```ts
  playScene(phase: TriggerPhase, room: IRoom): MechanicCue[] {
    if (
      this.#triggerPhase === phase &&
      this.preconditions.every((fn) => fn(room, this.#state))
    ) {
      return this.#script(room, this.#state) ?? [];
    }
    return [];
  }
```

- [ ] **Step 4: Extend `registry.ts`**

In `src/lib/serialization/registry.ts`, add `MechanicCue` to the existing mechanic import (~:8):

```ts
import type { Mechanic, JsonObject, MechanicCue } from "../mechanics/mechanic.js";
```

Change `SceneBehavior` (~:11-14):

```ts
export interface SceneBehavior {
  preconditions: ((room: IRoom, state: never) => boolean)[];
  script: (room: IRoom, state: never) => MechanicCue[] | void;
}
```

- [ ] **Step 5: Extend `room.ts`**

Add the import near the top of `src/lib/room.ts`:

```ts
import type { MechanicCue } from "./mechanics/mechanic.js";
```

Change the `IRoom` signatures (~:91-94):

```ts
  /** Records a character as present and plays any `"enter"` scenes; returns their cues. */
  enterRoom: (character: ICharacter) => MechanicCue[];
  /** Plays any `"exit"` scenes (returning their cues) then removes the character. */
  exitRoom: (character: ICharacter) => MechanicCue[];
```

Change `Room.enterRoom`/`exitRoom` (~:287-299) — occupant timing preserved (enter: add THEN play; exit: play THEN remove):

```ts
  enterRoom(character: ICharacter): MechanicCue[] {
    this.#occupants.set(character.id, character);
    return this.#scenes.flatMap((scene) => scene.playScene("enter", this));
  }

  exitRoom(character: ICharacter): MechanicCue[] {
    const cues = this.#scenes.flatMap((scene) => scene.playScene("exit", this));
    this.#occupants.delete(character.id);
    return cues;
  }
```

- [ ] **Step 6: Extend `character.ts`**

Add the import (match the file's existing import style; the mechanic types live at `../mechanics/mechanic`):

```ts
import type { MechanicCue } from "../mechanics/mechanic.js";
```

Change `#enterRoom` (~:991-997) to collect and return cues (exit-room cues first, then enter-room cues):

```ts
  #enterRoom(room: IRoom): MechanicCue[] {
    const cues: MechanicCue[] = [];
    if (this.#currentRoom) {
      cues.push(...this.#currentRoom.exitRoom(this));
    }
    this.#currentRoom = room;
    cues.push(...room.enterRoom(this));
    return cues;
  }
```

Change `move` (~:1018-1032) to emit the scene cues before the visibility cue:

```ts
  move(room: IRoom) {
    if (!this.attemptAction(this.move, true)) return;
    const sceneCues = this.#enterRoom(room);
    for (const cue of sceneCues) {
      this.campaign[EMIT_CUE]({ kind: "mechanic", cue });
    }
    if (!room.isLit) {
      this.campaign[EMIT_CUE]({
        kind: "visibility",
        room: { id: room.id, name: room.name },
        lit: false,
      });
    }
    this.recordAction(this.move, {
      kind: "move",
      room: { id: room.id, name: room.name },
    });
  }
```

`[PLACE]` (~:979-982) is unchanged — it calls `this.#enterRoom(room)` as a statement and discards the returned cues (mob seating stays silent; scenes still fire + mutate state, matching today's behavior). Confirm it still reads `this.#enterRoom(room);`.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm vitest run src/lib/scene.test.ts src/lib/room.test.ts`
Expected: PASS.

- [ ] **Step 8: Typecheck + full TS suite (no regressions)**

Run: `pnpm typecheck && pnpm vitest run src/`
Expected: PASS. (Existing scene/room/character tests that ignore the new return values still pass; scene-less behavior is unchanged.)

- [ ] **Step 9: Commit**

```bash
git add src/lib/scene.ts src/lib/serialization/registry.ts src/lib/room.ts src/lib/character/character.ts src/lib/scene.test.ts src/lib/room.test.ts
git commit -m "feat(scene): scene scripts emit mechanic cues (oracle extension for 6c-2)"
```

---

## Task 2: Rust — `RoomView.occupants` + `room_view` builder

**Files:**
- Modify: `crates/wickedways-core/src/world/mechanics/view.rs` (`RoomView` ~:43-49; add builder; add test)

**Interfaces:**
- Consumes: existing `CharacterView`, `World::character_view`, `World::is_lit`.
- Produces:
  - `RoomView` gains `pub occupants: Vec<CharacterView>` (keeps existing `id`, `name`, `lit`, `occupant_ids`).
  - `World::room_view(&self, room_id: &RoomId, cat: &Catalog) -> Option<RoomView>` — `None` if the room is missing; occupants projected in `occupant_ids` order via `character_view`.

- [ ] **Step 1: Write the failing test**

Add to the `tests` module in `crates/wickedways-core/src/world/mechanics/view.rs`:

```rust
#[test]
fn room_view_projects_lit_and_occupants() {
    use crate::world::ids::RoomId;
    // world_two_rooms seats "pc" (Heir) in "start" (lit); "next" may be dark.
    let w = crate::world::test_support::world_two_rooms(/*next_dark=*/true);
    let cat = Catalog::default();
    let start = w.room_view(&RoomId("start".into()), &cat).expect("start room");
    assert_eq!(start.id, "start");
    assert!(start.lit);
    assert_eq!(start.occupant_ids, alloc::vec!["pc".to_string()]);
    assert_eq!(start.occupants.len(), 1);
    assert_eq!(start.occupants[0].id, cid("pc"));

    let next = w.room_view(&RoomId("next".into()), &cat).expect("next room");
    assert!(!next.lit); // dark, no light sources
    assert!(next.occupants.is_empty());

    assert!(w.room_view(&RoomId("nope".into()), &cat).is_none());
}
```

> `world_two_rooms` and its seated `pc` are used across `movement.rs` tests; confirm the seated occupant id/name against `test_support.rs` and adjust the exact strings if they differ.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p wickedways-core room_view_projects_lit_and_occupants`
Expected: FAIL — `room_view` does not exist and `RoomView` has no `occupants` field.

- [ ] **Step 3: Add the field and builder**

In `crates/wickedways-core/src/world/mechanics/view.rs`, extend `RoomView` (~:43-49):

```rust
#[derive(Clone, Debug, PartialEq)]
pub struct RoomView {
    pub id: String,
    pub name: String,
    pub lit: bool,
    pub occupant_ids: Vec<String>,
    /// Occupants as views (TS `room.occupants`), projected in `occupant_ids` order.
    pub occupants: Vec<CharacterView>,
}
```

Add the builder inside `impl World` (next to `build_campaign_view`):

```rust
    /// Owned projection of a single room for scene hooks (TS `room` handed to
    /// scene preconditions/scripts). `occupants` are projected in `occupant_ids`
    /// order via `character_view`. `None` if the room is absent.
    pub fn room_view(&self, room_id: &RoomId, cat: &Catalog) -> Option<RoomView> {
        let r = self.rooms.get(room_id)?;
        let occupant_ids: Vec<String> = r.occupant_ids.iter().map(|id| id.0.clone()).collect();
        let occupants: Vec<CharacterView> = r
            .occupant_ids
            .iter()
            .filter_map(|id| self.character_view(id, cat))
            .collect();
        Some(RoomView {
            id: room_id.0.clone(),
            name: r.name.clone(),
            lit: self.is_lit(room_id),
            occupant_ids,
            occupants,
        })
    }
```

Add the `RoomId` import to the file's `use` block if not already present:

```rust
use crate::world::ids::RoomId;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p wickedways-core room_view_projects_lit_and_occupants`
Expected: PASS.

- [ ] **Step 5: Confirm no other `RoomView` literal broke**

Run: `cargo test -p wickedways-core`
Expected: PASS. (`CampaignView.rooms` is built as `Vec::new()`, so adding a field to `RoomView` breaks no existing literal.)

- [ ] **Step 6: Commit**

```bash
git add crates/wickedways-core/src/world/mechanics/view.rs
git commit -m "feat(core): RoomView.occupants + World::room_view builder (6c-2)"
```

---

## Task 3: Rust — `SceneBehavior` trait + registry + conformance behavior

**Files:**
- Create: `crates/wickedways-core/src/world/scenes.rs`
- Modify: `crates/wickedways-core/src/world/mod.rs` (add `pub mod scenes;`)

**Interfaces:**
- Consumes: `RoomView` (Task 2), `MechanicCue` (`crate::presentation`).
- Produces:
  - `pub trait SceneBehavior: Sync { fn can_play(&self, room: &RoomView, state: &Value) -> bool; fn run_script(&self, room: &RoomView, state: &mut Value) -> Vec<MechanicCue>; }`
  - `pub fn scene_behavior(key: &str) -> Option<&'static dyn SceneBehavior>`
  - `conformance::VisitCounter` / `conformance::VISIT_COUNTER` under key `"conformance:visit-counter"`; helpers `visit_can_play(state, occupied) -> bool` and `visit_run_script(room_name, state) -> Vec<MechanicCue>`.

- [ ] **Step 1: Write the failing test — create `scenes.rs` with tests only**

Create `crates/wickedways-core/src/world/scenes.rs`:

```rust
//! Scene behaviors: a native `SceneBehavior` trait resolved by `behavior_key`
//! (mirrors `exit_behavior`). Behavior is compiled-in; only the scene's `state`
//! serializes. Byte-exact port of the TS `Scene` / `SceneBehavior` contract,
//! extended (6c-2) so a scene script emits mechanic cues.
use alloc::string::String;
use alloc::vec::Vec;
use serde_json::Value;

use crate::presentation::MechanicCue;
use crate::world::mechanics::RoomView;

/// A first-party scene behavior. `state` is the scene's serialized `Value`.
pub trait SceneBehavior: Sync {
    /// TS `preconditions.every` — read-only over the room view + scene state.
    fn can_play(&self, room: &RoomView, state: &Value) -> bool;
    /// TS `script` — runs on a matched phase + passing preconditions; may mutate
    /// its own `state`; returns the mechanic cues to emit (empty = none).
    fn run_script(&self, room: &RoomView, state: &mut Value) -> Vec<MechanicCue>;
}

/// Resolve a first-party scene behavior by key. `None` for an unregistered key
/// (surfaced as a `ProceduralViolation` at the fire site).
pub fn scene_behavior(key: &str) -> Option<&'static dyn SceneBehavior> {
    match key {
        #[cfg(any(test, feature = "conformance"))]
        "conformance:visit-counter" => Some(&conformance::VISIT_COUNTER),
        _ => None,
    }
}

#[cfg(any(test, feature = "conformance"))]
pub mod conformance {
    use super::*;
    use serde_json::json;

    /// Behavior-logic-free helpers (testable without a `RoomView`).

    /// Fires while `state.count < 3` AND the room is occupied.
    pub fn visit_can_play(state: &Value, occupied: bool) -> bool {
        let count = state.get("count").and_then(|v| v.as_i64()).unwrap_or(0);
        count < 3 && occupied
    }

    /// Increments `state.count` and returns one cue naming the room + new count.
    pub fn visit_run_script(room_name: &str, state: &mut Value) -> Vec<MechanicCue> {
        let count = state.get("count").and_then(|v| v.as_i64()).unwrap_or(0) + 1;
        state["count"] = json!(count);
        alloc::vec![MechanicCue {
            text: Some(alloc::format!("The {room_name} stirs (visit {count}).")),
            sound: None,
        }]
    }

    pub struct VisitCounter;
    pub static VISIT_COUNTER: VisitCounter = VisitCounter;

    impl SceneBehavior for VisitCounter {
        fn can_play(&self, room: &RoomView, state: &Value) -> bool {
            visit_can_play(state, !room.occupants.is_empty())
        }
        fn run_script(&self, room: &RoomView, state: &mut Value) -> Vec<MechanicCue> {
            visit_run_script(&room.name, state)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn registry_resolves_visit_counter_and_rejects_unknown() {
        assert!(scene_behavior("conformance:visit-counter").is_some());
        assert!(scene_behavior("nope").is_none());
    }

    #[test]
    fn can_play_gates_on_count_and_occupancy() {
        assert!(conformance::visit_can_play(&json!({ "count": 0 }), true));
        assert!(conformance::visit_can_play(&json!({}), true)); // missing count → 0
        assert!(!conformance::visit_can_play(&json!({ "count": 3 }), true)); // capped
        assert!(!conformance::visit_can_play(&json!({ "count": 0 }), false)); // empty room
    }

    #[test]
    fn run_script_increments_and_emits_named_cue() {
        let mut s = json!({ "count": 1 });
        let cues = conformance::visit_run_script("Crypt", &mut s);
        assert_eq!(s["count"], json!(2));
        assert_eq!(cues.len(), 1);
        assert_eq!(cues[0].text.as_deref(), Some("The Crypt stirs (visit 2)."));
    }
}
```

- [ ] **Step 2: Register the module and run the test to verify it fails first**

Add to `crates/wickedways-core/src/world/mod.rs` next to `pub mod exits;`:

```rust
pub mod scenes;
```

Run: `cargo test -p wickedways-core scenes::`
Expected: PASS actually is not what we want first — since this task's code and tests are written together, instead run the compile+test once: if any assertion or signature is wrong it FAILS; iterate until PASS. (This module is self-contained; TDD here is "write test + impl together, red only if a helper is mis-specified".)

- [ ] **Step 3: Run the module tests to verify they pass**

Run: `cargo test -p wickedways-core scenes::`
Expected: PASS (3 tests).

- [ ] **Step 4: Verify `no_std` (conformance behavior absent from default build)**

Run: `cargo build -p wickedways-core --no-default-features`
Expected: SUCCESS. (`conformance` module is `#[cfg(any(test, feature = "conformance"))]`, so it compiles out.)

- [ ] **Step 5: Commit**

```bash
git add crates/wickedways-core/src/world/scenes.rs crates/wickedways-core/src/world/mod.rs
git commit -m "feat(core): SceneBehavior trait + registry + conformance:visit-counter (6c-2)"
```

---

## Task 4: Rust — fire scenes on move

**Files:**
- Modify: `crates/wickedways-core/src/world/movement.rs` (module doc ~:1-7; `move_to` ~:143-301; add `fire_scenes`; add tests)

**Interfaces:**
- Consumes: `scene_behavior` (Task 3), `World::room_view` (Task 2).
- Produces: `World::fire_scenes(&mut self, room_id: &RoomId, phase: &str, cat: &Catalog, cues: &mut Vec<PresentationCue>) -> Result<(), ProceduralViolation>` (private to the crate; called from `move_to`).

- [ ] **Step 1: Write the failing tests**

Add to the `tests` module in `crates/wickedways-core/src/world/movement.rs`. These use a helper that attaches a `conformance:visit-counter` scene to a room in the two-room world:

```rust
/// Attach a `conformance:visit-counter` scene to `room` with the given phase and
/// starting count. Mirrors how RoomSnapshot carries scenes.
fn attach_scene(w: &mut crate::world::World, room: &str, phase: &str, count: i64) {
    use crate::world::snapshot::SceneSnapshot;
    if let Some(r) = w.rooms.get_mut(&rid(room)) {
        r.scenes.push(SceneSnapshot {
            id: alloc::format!("{room}-{phase}-scene"),
            behavior_key: "conformance:visit-counter".into(),
            phase: phase.into(),
            state: serde_json::json!({ "count": count }),
        });
    }
}

#[test]
fn enter_scene_fires_after_occupant_add_and_emits_cue_before_visibility() {
    let mut w = world_two_rooms(/*next_dark=*/true); // dark → a visibility cue follows
    attach_scene(&mut w, "next", "enter", 0);
    let mut cues = Vec::new();
    w.go(&cid("pc"), Direction::North, &Catalog::default(), &mut cues).unwrap();

    // scene mutated its own state (count 0 → 1), mover was an occupant when it fired
    let scene = &w.rooms[&rid("next")].scenes[0];
    assert_eq!(scene.state["count"], serde_json::json!(1));

    // cue order: scene mechanic cue BEFORE the visibility cue BEFORE the move action cue
    let mech = cues.iter().position(|c| matches!(c,
        PresentationCue::Mechanic { cue } if cue.text.as_deref() == Some("The Next stirs (visit 1)."))).unwrap();
    let vis = cues.iter().position(|c| matches!(c, PresentationCue::Visibility { .. })).unwrap();
    let mv = cues.iter().position(|c| matches!(c, PresentationCue::Action { action: ActionKind::Move, .. })).unwrap();
    assert!(mech < vis && vis < mv, "scene cue precedes visibility precedes move; got {cues:?}");
}

#[test]
fn exit_scene_fires_before_occupant_removal() {
    let mut w = world_two_rooms(false);
    attach_scene(&mut w, "start", "exit", 0);
    let mut cues = Vec::new();
    w.go(&cid("pc"), Direction::North, &Catalog::default(), &mut cues).unwrap();
    // exit scene on the departed room fired (count 0 → 1)
    assert_eq!(w.rooms[&rid("start")].scenes[0].state["count"], serde_json::json!(1));
    // its cue is the FIRST cue (before any enter/visibility/move cue for the new room)
    assert!(matches!(&cues[0],
        PresentationCue::Mechanic { cue } if cue.text.as_deref() == Some("The Start stirs (visit 1).")));
}

#[test]
fn exit_scene_then_enter_scene_ordering_in_one_move() {
    let mut w = world_two_rooms(false);
    attach_scene(&mut w, "start", "exit", 0);
    attach_scene(&mut w, "next", "enter", 0);
    let mut cues = Vec::new();
    w.go(&cid("pc"), Direction::North, &Catalog::default(), &mut cues).unwrap();
    let exit_idx = cues.iter().position(|c| matches!(c,
        PresentationCue::Mechanic { cue } if cue.text.as_deref() == Some("The Start stirs (visit 1)."))).unwrap();
    let enter_idx = cues.iter().position(|c| matches!(c,
        PresentationCue::Mechanic { cue } if cue.text.as_deref() == Some("The Next stirs (visit 1)."))).unwrap();
    assert!(exit_idx < enter_idx, "old-room exit-scene cue precedes new-room enter-scene cue");
}

#[test]
fn scene_precondition_cap_stops_firing() {
    let mut w = world_two_rooms(false);
    attach_scene(&mut w, "next", "enter", 3); // already at the cap
    let mut cues = Vec::new();
    w.go(&cid("pc"), Direction::North, &Catalog::default(), &mut cues).unwrap();
    // no mutation, no scene cue
    assert_eq!(w.rooms[&rid("next")].scenes[0].state["count"], serde_json::json!(3));
    assert!(!cues.iter().any(|c| matches!(c,
        PresentationCue::Mechanic { cue } if cue.text.as_deref().map(|t| t.contains("stirs")).unwrap_or(false))));
}

#[test]
fn unregistered_scene_behavior_key_errors() {
    let mut w = world_two_rooms(false);
    if let Some(r) = w.rooms.get_mut(&rid("next")) {
        r.scenes.push(crate::world::snapshot::SceneSnapshot {
            id: "bad".into(), behavior_key: "nope:unregistered".into(),
            phase: "enter".into(), state: serde_json::json!({}),
        });
    }
    let mut cues = Vec::new();
    assert!(w.go(&cid("pc"), Direction::North, &Catalog::default(), &mut cues).is_err());
}
```

> Confirm the room display names in `world_two_rooms` are "Start"/"Next" (used in the cue text assertions). If they differ, update the expected cue strings to match `r.name`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p wickedways-core -- enter_scene_fires exit_scene_fires exit_scene_then_enter scene_precondition_cap unregistered_scene`
Expected: FAIL — scenes are never fired; `fire_scenes` does not exist.

- [ ] **Step 3: Add `fire_scenes` and wire it into `move_to`**

In `crates/wickedways-core/src/world/movement.rs`, add the helper inside `impl World` (above `move_to`):

```rust
    /// Fire every scene of the given `phase` registered on `room_id`, in snapshot
    /// order. Each firing may mutate its own `state` and returns mechanic cues,
    /// pushed onto `cues` as `PresentationCue::Mechanic`. Mirrors TS
    /// `Room.enterRoom`/`exitRoom` → `scene.playScene(phase, room)`.
    ///
    /// An unregistered `behavior_key` on a matching-phase scene →
    /// `Err(ProceduralViolation)` (mirrors TS `registry.scene()`'s `#require`).
    fn fire_scenes(
        &mut self,
        room_id: &RoomId,
        phase: &str,
        cat: &Catalog,
        cues: &mut Vec<PresentationCue>,
    ) -> Result<(), ProceduralViolation> {
        // Skip the view build for the common scene-less / no-matching-phase case.
        let has_match = self
            .rooms
            .get(room_id)
            .map(|r| r.scenes.iter().any(|s| s.phase == phase))
            .unwrap_or(false);
        if !has_match {
            return Ok(());
        }
        let view = self
            .room_view(room_id, cat)
            .ok_or_else(|| ProceduralViolation("scene room missing".into()))?;
        let room = self
            .rooms
            .get_mut(room_id)
            .ok_or_else(|| ProceduralViolation("scene room missing".into()))?;
        let mut emitted: Vec<MechanicCue> = Vec::new();
        for scene in room.scenes.iter_mut() {
            if scene.phase != phase {
                continue;
            }
            let behavior = crate::world::scenes::scene_behavior(&scene.behavior_key).ok_or_else(
                || {
                    ProceduralViolation(alloc::format!(
                        "Scene behavior '{}' is not registered.",
                        scene.behavior_key
                    ))
                },
            )?;
            if behavior.can_play(&view, &scene.state) {
                emitted.extend(behavior.run_script(&view, &mut scene.state));
            }
        }
        for cue in emitted {
            cues.push(PresentationCue::Mechanic { cue });
        }
        Ok(())
    }
```

Add the needed imports to `movement.rs`'s `use` block:

```rust
use crate::presentation::MechanicCue;
```

Wire exit-scene firing at the top of `move_to` — fire BEFORE the `retain` (mover still an occupant). Replace the existing exit block (~:150-158):

```rust
        // Exit old room — fire exit-phase scenes first (mover still an occupant),
        // then retain all occupants that are not the actor. Mirrors TS
        // `Room.exitRoom` (play "exit" scenes → delete occupant).
        if let Some(prev) =
            self.characters.get(actor).and_then(|c| c.current_room_id.clone())
        {
            self.fire_scenes(&prev, "exit", cat, cues)?;
            if let Some(r) = self.rooms.get_mut(&prev) {
                r.occupant_ids.retain(|id| id != actor);
            }
        }
```

Wire enter-scene firing after the occupant push and BEFORE the visibility cue. Insert immediately after the enter-room push block (~:160-168), before the `if !self.is_lit(&room)` block:

```rust
        // Fire enter-phase scenes now that the actor is an occupant of `room`,
        // BEFORE the visibility cue. Mirrors TS `Room.enterRoom` (add occupant →
        // play "enter" scenes) inside `#enterRoom`, which runs before `move`'s
        // visibility cue.
        self.fire_scenes(&room, "enter", cat, cues)?;
```

Update the module doc-comment (~:5): replace the "Scenes are NOT fired (deferred to sub-plan 6)." line with:

```rust
//! Scenes fire on room enter/exit via the `SceneBehavior` registry
//! (`crate::world::scenes::scene_behavior`, sub-plan 6c-2): exit-phase scenes of
//! the departed room fire before the occupant is removed, enter-phase scenes of
//! the entered room fire after the occupant is added and before the visibility
//! cue. An unregistered scene `behavior_key` surfaces as `Err(ProceduralViolation)`.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p wickedways-core -- enter_scene_fires exit_scene_fires exit_scene_then_enter scene_precondition_cap unregistered_scene`
Expected: PASS (5 tests).

- [ ] **Step 5: Full crate tests (no regression) + `no_std`**

Run: `cargo test -p wickedways-core && cargo build -p wickedways-core --no-default-features`
Expected: PASS + SUCCESS.

- [ ] **Step 6: Commit**

```bash
git add crates/wickedways-core/src/world/movement.rs
git commit -m "feat(core): fire scenes on move (enter/exit, cues before visibility) (6c-2)"
```

---

## Task 5: Conformance — shared gen-helper + scene differential fixture

**Files:**
- Create: `conformance/fixtures/gen-helpers.ts`
- Create: `conformance/fixtures/scene-shadow.ts`
- Create: `conformance/fixtures/scene.gen.test.ts` (writes `scene.start.snapshot.json`, `scene.catalog.json`, `scene.golden.json`)
- Create: `conformance/scene.test.ts`

**Interfaces:**
- Consumes: the extended TS oracle (Task 1); the Rust conformance behavior (Task 3) compiled under `--features conformance` (already enabled by `wasm:build`).
- Produces: `structuralClone<T>(v: T): T` in `gen-helpers.ts`; the `scene.*` fixture files; a passing differential replay.

- [ ] **Step 1: Create the shared gen-helper**

Create `conformance/fixtures/gen-helpers.ts`:

```ts
/**
 * Shared helpers for golden generators.
 *
 * `structuralClone` deep-copies a serialized value at capture time. `Exit` and
 * `Scene` `[SERIALIZE]` return their `state` by LIVE reference, so a later
 * command that mutates that state would retroactively corrupt the snapshots
 * recorded for earlier steps unless each capture is deep-copied.
 */
export function structuralClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
```

- [ ] **Step 2: Create the TS scene shadow**

Create `conformance/fixtures/scene-shadow.ts`:

```ts
/**
 * TS "shadow" of the Rust `conformance:visit-counter` SceneBehavior
 * (crates/wickedways-core/src/world/scenes.rs), reproduced byte-for-byte:
 *   can_play:   state.count (default 0) < 3  AND  the room is occupied
 *   run_script: count = (state.count ?? 0) + 1; state.count = count;
 *               emit one cue: `The ${room.name} stirs (visit ${count}).`
 */
import type { SceneBehavior } from "wickedways/lib/serialization/registry";
import type { MechanicCue } from "wickedways/lib/mechanics/mechanic";

export const VISIT_COUNTER_KEY = "conformance:visit-counter";

export const visitCounterShadow: SceneBehavior = {
  preconditions: [
    (room, state) =>
      ((state as { count?: number }).count ?? 0) < 3 && room.occupants.length > 0,
  ],
  script: (room, state): MechanicCue[] => {
    const s = state as { count?: number };
    const count = (s.count ?? 0) + 1;
    s.count = count;
    return [{ text: `The ${room.name} stirs (visit ${count}).` }];
  },
};
```

- [ ] **Step 3: Create the golden generator**

Create `conformance/fixtures/scene.gen.test.ts`. Model it on `keyed-exit.gen.test.ts` (catalog exporter, viewModel projection, cue drain) but with a scene registry, three rooms, and the command stream below. Use `structuralClone` from `gen-helpers.ts` for every capture and the start snapshot.

Map + fixture facts (state them in the file's header comment):
- Rooms: **Foyer** (lit, start room, NO scenes) → North → **Chamber** (lit; enter-scene + exit-scene) → North → **Crypt** (lit; enter-scene + exit-scene). Exits auto-reverse (South returns).
- Start room is scene-free so the setup `pc.move(startRoom)` fires no scene; every scene mutation below is caused by a captured command.
- Single PC "Mara"; `maxRounds` 10; `baseEncounterChance` 0; no formations → no rng draws.
- Budget 3/round; the stream uses ≤2 budgeted `go`s per round so no turn auto-ends mid-stream.

Command stream (each `go` = 1 budgeted action):

```ts
const commands: Command[] = [
  // Round 0: Foyer → Chamber → Crypt
  { kind: "startTurn" },
  { kind: "go", dir: Directions.North }, // Foyer→Chamber: Chamber.enter 0→1  ["The Chamber stirs (visit 1)."]
  { kind: "go", dir: Directions.North }, // Chamber→Crypt: Chamber.exit 0→1, Crypt.enter 0→1  (ordered)
  { kind: "nextPlayer" },                // single-PC wrap → endRound → round 1
  // Round 1: Crypt → Chamber → Crypt
  { kind: "startTurn" },
  { kind: "go", dir: Directions.South }, // Crypt→Chamber: Crypt.exit 0→1, Chamber.enter 1→2
  { kind: "go", dir: Directions.North }, // Chamber→Crypt: Chamber.exit 1→2, Crypt.enter 1→2
  { kind: "nextPlayer" },                // round 2
  // Round 2: Crypt → Chamber → Crypt
  { kind: "startTurn" },
  { kind: "go", dir: Directions.South }, // Crypt→Chamber: Crypt.exit 1→2, Chamber.enter 2→3
  { kind: "go", dir: Directions.North }, // Chamber→Crypt: Chamber.exit 2→3, Crypt.enter 2→3
  { kind: "nextPlayer" },                // round 3
  // Round 3: cap reached — Chamber.enter/Crypt.enter/exit all at 3 → no fire, no cue
  { kind: "startTurn" },
  { kind: "go", dir: Directions.South }, // Crypt→Chamber: Crypt.exit 2→3, Chamber.enter 3 (capped: no fire)
  { kind: "go", dir: Directions.North }, // Chamber→Crypt: Chamber.exit 3 (capped), Crypt.enter 3 (capped): NO scene cues
];
```

Registry + template (scene attach via `template.scene(room, key, { phase })`):

```ts
import { visitCounterShadow, VISIT_COUNTER_KEY } from "./scene-shadow.ts";
import { structuralClone } from "./gen-helpers.ts";

function buildSceneRegistry() {
  return defineRegistry({
    scenes: { [VISIT_COUNTER_KEY]: visitCounterShadow },
  });
}

// ...authorTemplate(...)
//   .room("Foyer", { description: "A dusty foyer." })
//   .room("Chamber", { description: "A cold chamber." })
//   .room("Crypt", { description: "A silent crypt." })
//   .startRoom("Foyer")
//   .exit("Foyer", Directions.North, "Chamber")
//   .exit("Chamber", Directions.North, "Crypt")
//   .scene("Chamber", VISIT_COUNTER_KEY, { phase: "enter", initialState: { count: 0 } })
//   .scene("Chamber", VISIT_COUNTER_KEY, { phase: "exit",  initialState: { count: 0 } })
//   .scene("Crypt",   VISIT_COUNTER_KEY, { phase: "enter", initialState: { count: 0 } })
//   .scene("Crypt",   VISIT_COUNTER_KEY, { phase: "exit",  initialState: { count: 0 } });
```

Catalog: this fixture registers no items, so `catalog = { items: {}, aliases: {} }`. (Confirm the Rust `Catalog` deserializes an empty `items` map — `Catalog::default()` in tests is empty, so an empty catalog is valid.)

Self-validation (hard throws) to include — assert the exact ordered mechanic-cue texts per step and the per-room scene counts, e.g.:

```ts
expectMechanicTexts(1, ["The Chamber stirs (visit 1)."]);
expectMechanicTexts(2, ["The Chamber stirs (visit 1).", "The Crypt stirs (visit 1)."]);
expectMechanicTexts(5, ["The Crypt stirs (visit 1).", "The Chamber stirs (visit 2)."]);
expectMechanicTexts(6, ["The Chamber stirs (visit 2).", "The Crypt stirs (visit 2)."]);
expectMechanicTexts(9,  ["The Crypt stirs (visit 2).", "The Chamber stirs (visit 3)."]);
expectMechanicTexts(10, ["The Chamber stirs (visit 3).", "The Crypt stirs (visit 3)."]);
expectMechanicTexts(13, ["The Crypt stirs (visit 3)."]); // Chamber.enter capped at 3 → no cue
expectMechanicTexts(14, []);                              // Chamber.exit + Crypt.enter both capped
```

Also assert, from the final step's snapshot, the four scene counts: Chamber.enter = 3, Chamber.exit = 3, Crypt.enter = 3, Crypt.exit = 3. Read them by locating each room in `snapshot.rooms` and its `scenes[]` by `phase`.

Use `structuralClone(serializeCampaign(campaign))` for both the start snapshot and each per-step `snapshot` capture (the scene `state` counts change every step — without the clone every step would show the final counts). Write `scene.start.snapshot.json`, `scene.catalog.json`, `scene.golden.json`.

- [ ] **Step 4: Generate the golden**

Run: `pnpm run fixtures:gen`
Expected: the generator's self-validation throws all pass; three `scene.*` files written under `conformance/fixtures/`. If a self-validation throw fires, the expected counts/cue-order above are the source of truth — fix the generator, not the assertions, unless a genuine oracle behavior differs (then reconcile the assertions to the real oracle).

- [ ] **Step 5: Create the differential replay test**

Create `conformance/scene.test.ts` (copy the shape of `conformance/keyed-exit.test.ts`, swapping the fixture basenames):

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { canonicalize } from "./canonical-json.ts";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const wasm = require("../crates/wickedways-wasm/pkg/wickedways_wasm.js") as {
  replay_commands: (s: string, c: string, cat: string, seed: number) => string;
};

const start = readFileSync(join(here, "fixtures/scene.start.snapshot.json"), "utf8");
const catalogJson = readFileSync(join(here, "fixtures/scene.catalog.json"), "utf8");
const golden = JSON.parse(
  readFileSync(join(here, "fixtures/scene.golden.json"), "utf8"),
) as {
  seed: number;
  commands: unknown[];
  steps: Array<{ command: unknown; cues: unknown; snapshot: unknown; view: unknown }>;
};

describe("scene differential conformance", () => {
  it("Rust replay matches the TS oracle per step (cues + snapshot + view)", () => {
    const out = JSON.parse(
      wasm.replay_commands(start, JSON.stringify(golden.commands), catalogJson, golden.seed),
    ) as Array<{ command: unknown; cues: unknown; snapshot: unknown; view: unknown }>;
    expect(out.length).toBe(golden.steps.length);
    out.forEach((step, i) => {
      const want = golden.steps[i]!;
      expect(canonicalize(step.cues), `step ${i} cues`).toEqual(canonicalize(want.cues));
      expect(canonicalize(step.snapshot), `step ${i} snapshot`).toEqual(canonicalize(want.snapshot));
      expect(canonicalize(step.view), `step ${i} view`).toEqual(canonicalize(want.view));
    });
  });
});
```

- [ ] **Step 6: Build the wasm and run the differential test**

Run: `pnpm run wasm:build && pnpm run test:conformance`
Expected: PASS — the new `scene` differential test is GREEN and all existing conformance tests still pass. If the scene test diverges, fix the Rust source (Tasks 3-4) or a faithful fixture error — never the golden or comparator.

- [ ] **Step 7: Commit**

```bash
git add conformance/fixtures/gen-helpers.ts conformance/fixtures/scene-shadow.ts conformance/fixtures/scene.gen.test.ts conformance/scene.test.ts conformance/fixtures/scene.start.snapshot.json conformance/fixtures/scene.catalog.json conformance/fixtures/scene.golden.json
git commit -m "test(conformance): scene enter/exit + cue differential fixture (6c-2)"
```

---

## Task 6: Folded 6c-1 cleanup + docs + full gate

**Files:**
- Modify: `conformance/fixtures/keyed-exit.gen.test.ts` (use shared `structuralClone`)
- Modify: `crates/wickedways-core/src/world/exits.rs` (registry `#[cfg]` restructure)
- Modify: `crates/wickedways-core/src/world/movement.rs` (dedup a test; hoist the far-endpoint triple in `go`)
- Modify: `README.md` (document scenes; fix the 6c-1 "if any" wording)

**Interfaces:** none new — refactors that preserve behavior + docs.

- [ ] **Step 1: keyed-exit generator uses the shared helper**

In `conformance/fixtures/keyed-exit.gen.test.ts`, import `structuralClone` from `./gen-helpers.ts` and replace the two inline `JSON.parse(JSON.stringify(...))` deep-copies (the start snapshot ~:343-345 and the per-step capture ~:439-444) with `structuralClone(...)`. Behavior is identical.

- [ ] **Step 2: Regenerate and prove the keyed-exit golden is byte-identical**

Run: `pnpm run fixtures:gen && git status --short conformance/fixtures/keyed-exit.golden.json conformance/fixtures/keyed-exit.start.snapshot.json`
Expected: NO changes reported for the keyed-exit golden/snapshot (the refactor is behavior-preserving). If they changed, the refactor altered capture semantics — revert to identical output.

- [ ] **Step 3: exits.rs registry `#[cfg]` restructure**

In `crates/wickedways-core/src/world/exits.rs`, move the per-arm `#[cfg(any(test, feature = "conformance"))]` off the individual match arm and gate a single conformance-arms block instead, mirroring the structure `scenes.rs::scene_behavior` uses, so both registries read the same way. Keep `exit_behavior` returning the same values.

```rust
pub fn exit_behavior(key: &str) -> Option<&'static dyn ExitBehavior> {
    #[cfg(any(test, feature = "conformance"))]
    if key == "conformance:keyed-door" {
        return Some(&conformance::KEYED_DOOR);
    }
    let _ = key;
    None
}
```

- [ ] **Step 4: movement.rs — dedup test + hoist the far-endpoint triple**

Remove the duplicate unregistered-key test: `movement.rs` has both `go_through_a_keyed_exit_with_unregistered_behavior_key_errors` and `keyed_exit_unregistered_key_errors` (identical intent). Delete `go_through_a_keyed_exit_with_unregistered_behavior_key_errors` (the one that uses `make_north_exit_keyed("study-door")`), keeping `keyed_exit_unregistered_key_errors`.

In `go`, the `a`/`b`/`dest` far-endpoint computation appears twice (the keyed branch ~:100-102 and the behavior-free branch ~:129-131). Hoist it to a single computation before the `if let Some(key) = exit.behavior_key…` branch, and use `dest` in both paths:

```rust
        // Far endpoint (shared by the keyed and behavior-free paths).
        let a = exit.endpoint_ids[0].clone();
        let b = exit.endpoint_ids[1].clone();
        let dest = if a == here { b } else { a };

        if let Some(key) = exit.behavior_key.clone() {
            // …can_pass / run_script… then:
            return self.move_to(actor, dest, cat, cues);
        }
        self.move_to(actor, dest, cat, cues)
```

Ensure the `exit` immutable borrow used for `endpoint_ids` is released before the keyed branch's `self.exits.get_mut(&exit_id)` (compute `a`/`b`/`dest` from the borrow, then drop it — `dest` is owned `RoomId`s).

- [ ] **Step 5: Run the Rust tests + no_std**

Run: `cargo test -p wickedways-core && cargo build -p wickedways-core --no-default-features`
Expected: PASS + SUCCESS (one fewer test after the dedup; all scene + exit tests green).

- [ ] **Step 6: Document scenes in the README**

In `README.md`, add scene documentation near the exits/keyed-exit section: the `SceneBehavior` registry (`can_play` / `run_script`), the enter/exit trigger and occupant timing (exit-scenes before the mover leaves the room's occupancy; enter-scenes after it joins), the mechanic-cue emission channel (emitted before the visibility cue), and the `move` firing order. Also fix the 6c-1 "if any" wording flagged in that review (locate the keyed-exit paragraph and correct the phrasing so it reads cleanly).

- [ ] **Step 7: Full gate**

Run: `pnpm run checks:phase3 && pnpm run fixtures:stable`
Expected: BOTH EXIT 0.

- [ ] **Step 8: Confirm only intended fixture changes**

Run: `git status --short conformance/fixtures`
Expected: only the new `scene.*` files and `gen-helpers.ts` (plus the keyed-exit generator edit) — the keyed-exit golden/snapshot and every other existing golden are unchanged.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor+docs(6c-2): fold 6c-1 cleanup, document scenes, full gate green"
```

---

## Self-Review

**Spec coverage:**
- Oracle extension (scene cues) → Task 1. ✅
- `SceneBehavior` trait + `scene_behavior` registry → Task 3. ✅
- `RoomView` read channel (`occupants`) + builder → Task 2. ✅
- `fire_scenes` wiring + occupant timing + cue ordering → Task 4. ✅
- Conformance `visit-counter` + differential fixture (cues + snapshot state) → Task 5. ✅
- Structural deep-copy gen-helper prerequisite → Task 5 (created), Task 6 (keyed-exit adopts it). ✅
- Folded 6c-1 cleanup (a gen-helper, b cfg restructure, c dedup test, d hoist triple, e README wording) → Tasks 5-6. ✅
- Deferred/carried (room-write channel, `[PLACE]`/spawn scene firing → 6c-3, `validate_scenes`) → not implemented by design; `[PLACE]` discards cues in Task 1 Step 6 and is noted. ✅
- Docs → Task 6 Step 6. ✅
- No golden churn + full gate → Task 6 Steps 7-8. ✅

**Placeholder scan:** every code step carries complete code; the two "confirm names against `test_support.rs` / `world_two_rooms`" notes are verification guards, not placeholders (exact strings are given, with a fallback rule).

**Type consistency:** `MechanicCue` used consistently (`{ text?, sound? }`); `SceneBehavior.run_script -> Vec<MechanicCue>` (Rust) / `script -> MechanicCue[] | void` (TS); `scene_behavior(key) -> Option<&'static dyn SceneBehavior>`; `room_view(room_id, cat) -> Option<RoomView>`; `fire_scenes(room_id, phase, cat, cues) -> Result<(), ProceduralViolation>`. Registry key `"conformance:visit-counter"` matches between `scenes.rs`, `scene-shadow.ts`, and the generator.
