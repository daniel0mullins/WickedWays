# Sub-plan 6c-1: Keyed Exits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the keyed-exit `Err` stub in `go` with registry-driven exit evaluation (`can_pass` → fail-message, `run_script` ?? pass-message, then move), faithful to TS `go(direction)` + the `Exit` contract, verified by a differential fixture.

**Architecture:** A native `ExitBehavior` trait resolved by `behavior_key` via a compiled-in `exit_behavior(key)` registry (mirroring `mechanic_op`), with a feature-gated `conformance:keyed-door` behavior for the gate. `go`'s keyed branch builds the actor `CharacterView` (reused from 6a's mechanics::view), evaluates the behavior, mutates exit `state` on a successful script, and delegates the actual move to `move_to`.

**Tech Stack:** Rust (`crates/wickedways-core`, `no_std` + `alloc`), TS oracle (`src/lib/`), vitest differential conformance gate (`conformance/`).

## Global Constraints

- **The conformance gate is the authority.** Divergences are fixed in Rust source (or a faithful fixture correction) — NEVER by editing goldens or `conformance/canonical-json.ts`.
- **`no_std` core.** New code uses `alloc::` only, never `std::`. Must build under `cargo build -p wickedways-core --no-default-features`. The conformance behavior is behind `#[cfg(any(test, feature = "conformance"))]` — absent from the default build.
- **Byte-exact vs the TS oracle** (`go(direction)`, character.ts): no exit → `"You can't go that way."` (already done); keyed exit → if `!can_pass` emit `fail_message` (if any) as a `Mechanic` cue and DO NOT move; else `line = run_script(state) ?? pass_message`, emit `line` as a `Mechanic` cue if present, then move to the far endpoint. Order: canPass → (fail | script/pass) cue → move.
- **`SET_EXIT_STATE`:** the exit's `state` is mutated only via `self.exits.get_mut(&exit_id).state` inside `run_script`.
- **Error text is not gate-observable** (a `ProceduralViolation` aborts replay) — clear messages; exact wording need not match TS.
- **No pre-existing golden churn:** existing fixtures have no keyed exits, so the keyed path is unreachable for them. After the fixture task, `git status --short conformance/fixtures` shows only the new fixture files.
- **ViewModel `exits`/`lockedDoors` are OUT OF SCOPE** for 6c-1 (deferred — would churn the view goldens). Do not touch the view projection.
- All rng via the injected ctx (keyed exits draw no rng).
- Full gate: `pnpm run checks:phase3`; idempotence: `pnpm run fixtures:stable`; crate tests: `cargo test -p wickedways-core`.

## File Structure

- Create `crates/wickedways-core/src/world/exits.rs` — `ExitBehavior` trait, `exit_behavior(key)` registry, the `conformance:keyed-door` behavior + door-logic free helpers, unit tests. Add `pub mod exits;` to `world/mod.rs`.
- Modify `crates/wickedways-core/src/world/movement.rs` — `go`'s keyed-exit branch (replace the `Err` stub) + unit tests.
- Create `conformance/fixtures/keyed-exit.gen.test.ts` + `conformance/keyed-exit.test.ts` + edit `conformance/fixtures/vitest.config.ts`.
- Modify `README.md`.

## Interfaces

- `ExitBehavior` (trait): `can_pass(&self, actor: &CharacterView, state: &Value) -> bool`; `run_script(&self, actor: &CharacterView, state: &mut Value) -> Option<String>` (default `None`); `pass_message(&self) -> Option<&str>` (default `None`); `fail_message(&self) -> Option<&str>` (default `None`).
- `exit_behavior(key: &str) -> Option<&'static dyn ExitBehavior>`.
- Consumes: `CharacterView` + `World::character_view(&self, id, cat) -> Option<CharacterView>` (pub(crate), from 6a-2; `has_item(behaviorKey)` predicate); `World::move_to(actor, room, cat, cues) -> Result`; `ExitSnapshot { id, endpoint_ids: [RoomId;2], behavior_key: Option<String>, name, state: Value }`; `PresentationCue::Mechanic { cue: MechanicCue { text, sound } }`.

---

## Task 1: `ExitBehavior` trait + registry + `conformance:keyed-door`

**Files:**
- Create: `crates/wickedways-core/src/world/exits.rs`
- Modify: `crates/wickedways-core/src/world/mod.rs` (add `pub mod exits;`)

**Interfaces:**
- Produces: the `ExitBehavior` trait, `exit_behavior(key)`, and `conformance:keyed-door` (behind `#[cfg(any(test, feature = "conformance"))]`), which unlocks when the actor holds the item with behavior key `"brass-key"`.

- [ ] **Step 1: Create the module + failing tests**

Create `crates/wickedways-core/src/world/exits.rs`:

```rust
//! Keyed-exit behaviors: a native `ExitBehavior` trait resolved by `behavior_key`
//! (mirrors `mechanic_op`). Behavior is compiled-in; only the exit's `state`
//! serializes. Byte-exact port of the TS `Exit` / `ExitBehavior` contract.
use alloc::string::String;
use serde_json::Value;

use crate::world::mechanics::CharacterView;

/// A first-party exit behavior. `state` is the exit's serialized `Value`.
pub trait ExitBehavior: Sync {
    /// TS `canPass` — all preconditions pass (read-only).
    fn can_pass(&self, actor: &CharacterView, state: &Value) -> bool;
    /// TS `runScript` — run on a successful pass; may mutate `state`; returns a
    /// one-time narration line (TS `string | void`).
    fn run_script(&self, _actor: &CharacterView, _state: &mut Value) -> Option<String> { None }
    fn pass_message(&self) -> Option<&str> { None }
    fn fail_message(&self) -> Option<&str> { None }
}

/// Resolve a first-party exit behavior by key. `None` for an unregistered key
/// (surfaced as a `ProceduralViolation` at the `go` call site).
pub fn exit_behavior(key: &str) -> Option<&'static dyn ExitBehavior> {
    match key {
        #[cfg(any(test, feature = "conformance"))]
        "conformance:keyed-door" => Some(&conformance::KEYED_DOOR),
        _ => None,
    }
}

#[cfg(any(test, feature = "conformance"))]
pub mod conformance {
    use super::*;
    use serde_json::json;

    /// The item behavior key that unlocks the conformance door.
    pub const DOOR_KEY: &str = "brass-key";

    /// Door-logic free helpers (testable without constructing a `CharacterView`).
    pub fn door_can_pass(state: &Value, has_key: bool) -> bool {
        state.get("unlocked").and_then(|v| v.as_bool()).unwrap_or(false) || has_key
    }
    /// Returns the narration (and mutates `state.unlocked = true`) iff the door was
    /// locked and the actor holds the key; otherwise `None`.
    pub fn door_run_script(state: &mut Value, has_key: bool) -> Option<String> {
        let unlocked = state.get("unlocked").and_then(|v| v.as_bool()).unwrap_or(false);
        if !unlocked && has_key {
            state["unlocked"] = json!(true);
            Some(String::from("The door unlocks."))
        } else {
            None
        }
    }

    pub struct KeyedDoor;
    pub static KEYED_DOOR: KeyedDoor = KeyedDoor;

    impl ExitBehavior for KeyedDoor {
        fn can_pass(&self, actor: &CharacterView, state: &Value) -> bool {
            door_can_pass(state, actor.has_item(DOOR_KEY))
        }
        fn run_script(&self, actor: &CharacterView, state: &mut Value) -> Option<String> {
            door_run_script(state, actor.has_item(DOOR_KEY))
        }
        fn pass_message(&self) -> Option<&str> { Some("You pass through.") }
        fn fail_message(&self) -> Option<&str> { Some("The door is locked.") }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn registry_resolves_keyed_door_and_rejects_unknown() {
        assert!(exit_behavior("conformance:keyed-door").is_some());
        assert!(exit_behavior("nope").is_none());
    }

    #[test]
    fn door_can_pass_when_unlocked_or_holding_key() {
        assert!(!conformance::door_can_pass(&json!({ "unlocked": false }), false));
        assert!(conformance::door_can_pass(&json!({ "unlocked": false }), true)); // has key
        assert!(conformance::door_can_pass(&json!({ "unlocked": true }), false)); // already unlocked
    }

    #[test]
    fn door_run_script_unlocks_once_with_key() {
        let mut s = json!({ "unlocked": false });
        assert_eq!(conformance::door_run_script(&mut s, true).as_deref(), Some("The door unlocks."));
        assert_eq!(s["unlocked"], json!(true));
        // already unlocked → no narration, no change
        assert_eq!(conformance::door_run_script(&mut s, true), None);
        // locked but no key → no narration, stays locked
        let mut locked = json!({ "unlocked": false });
        assert_eq!(conformance::door_run_script(&mut locked, false), None);
        assert_eq!(locked["unlocked"], json!(false));
    }
}
```

Add `pub mod exits;` to `crates/wickedways-core/src/world/mod.rs` in the module list.

Note: confirm `CharacterView` is importable as `crate::world::mechanics::CharacterView` and that `has_item(&self, key: &str) -> bool` is its public predicate (from 6a Task 2). If the re-export path differs, use the actual one.

- [ ] **Step 2: Run to confirm the tests exist and pass**

Run: `cargo test -p wickedways-core exits::`
Expected: PASS (5 assertions across 3 tests). If it fails to compile on `CharacterView` import, fix the path.

- [ ] **Step 3: Verify both build profiles**

Run: `cargo build -p wickedways-core --no-default-features` and `cargo build -p wickedways-core --features conformance`
Expected: both succeed (the `conformance:keyed-door` module + registry arm are absent from the default build).

- [ ] **Step 4: Commit**

```bash
git add crates/wickedways-core/src/world/exits.rs crates/wickedways-core/src/world/mod.rs
git commit -m "feat(core): ExitBehavior trait + registry + conformance:keyed-door (sub-plan 6c-1)"
```

---

## Task 2: `go` keyed-exit path

**Files:**
- Modify: `crates/wickedways-core/src/world/movement.rs` (`go`'s keyed-exit branch ~:84-88; tests)

**Interfaces:**
- Consumes: `exit_behavior(key)` (Task 1); `character_view`; `move_to`.

- [ ] **Step 1: Write the failing tests**

Add to the `tests` module in `crates/wickedways-core/src/world/movement.rs`. Use `world_two_rooms(false)` + `make_north_exit_keyed("conformance:keyed-door")` (test_support helper marks the north exit behavior-keyed) and set the exit's initial `state`. Seed a `"brass-key"` item into the PC's inventory for the with-key case (mirror how existing item tests seed `world.items` + `inventory.item_ids` with an `ItemSnapshot::Item { behavior_key: "brass-key", .. }`).

```rust
    #[test]
    fn keyed_exit_blocked_without_key_emits_fail_and_does_not_move() {
        use crate::world::descriptor::Catalog;
        let mut w = world_two_rooms(false);
        w.make_north_exit_keyed("conformance:keyed-door"); // marks the north exit keyed
        // set locked initial state on that exit
        for ex in w.exits.values_mut() { if ex.behavior_key.is_some() { ex.state = serde_json::json!({ "unlocked": false }); } }
        let start_room = w.characters[&cid("pc")].current_room_id.clone();
        let mut cues = Vec::new();
        w.go(&cid("pc"), Direction::North, &Catalog::default(), &mut cues).unwrap();
        // did not move
        assert_eq!(w.characters[&cid("pc")].current_room_id, start_room);
        // fail message emitted
        assert!(cues.iter().any(|c| matches!(c,
            PresentationCue::Mechanic { cue } if cue.text.as_deref() == Some("The door is locked."))));
    }

    #[test]
    fn keyed_exit_with_key_unlocks_moves_and_persists_state() {
        use crate::world::descriptor::Catalog;
        let mut w = world_two_rooms(false);
        w.make_north_exit_keyed("conformance:keyed-door");
        for ex in w.exits.values_mut() { if ex.behavior_key.is_some() { ex.state = serde_json::json!({ "unlocked": false }); } }
        seed_held_item(&mut w, "pc", "brass-key"); // helper: item with behavior_key "brass-key" in pc inventory
        let start_room = w.characters[&cid("pc")].current_room_id.clone();
        let mut cues = Vec::new();
        w.go(&cid("pc"), Direction::North, &Catalog::default(), &mut cues).unwrap();
        // moved to the far room
        assert_ne!(w.characters[&cid("pc")].current_room_id, start_room);
        // unlock narration emitted
        assert!(cues.iter().any(|c| matches!(c,
            PresentationCue::Mechanic { cue } if cue.text.as_deref() == Some("The door unlocks."))));
        // state persisted
        assert!(w.exits.values().any(|ex| ex.state.get("unlocked") == Some(&serde_json::json!(true))));
    }

    #[test]
    fn keyed_exit_unregistered_key_errors() {
        use crate::world::descriptor::Catalog;
        let mut w = world_two_rooms(false);
        w.make_north_exit_keyed("nope:not-registered");
        let mut cues = Vec::new();
        assert!(w.go(&cid("pc"), Direction::North, &Catalog::default(), &mut cues).is_err());
    }
```

Implement `seed_held_item(&mut World, char_id, behavior_key)` as a small `#[cfg(test)]` helper in this module (insert an `ItemSnapshot::Item { id, behavior_key, .. }` into `w.items` and push its id onto the character's `inventory.item_ids`) — match the real `ItemSnapshot::Item` shape from `snapshot.rs`. If a suitable helper already exists in `test_support`, reuse it.

- [ ] **Step 2: Run to confirm failure**

Run: `cargo test -p wickedways-core movement::tests::keyed_exit -- --nocapture`
Expected: FAIL — the keyed-exit `Err` stub currently returns an error for all three (the block/unlock assertions fail; the unregistered test passes only incidentally). This is the RED.

- [ ] **Step 3: Replace the keyed-exit stub**

In `crates/wickedways-core/src/world/movement.rs` `go`, replace the stub:

```rust
        // A behavior-keyed exit needs the registry (sub-plan 6) to evaluate canPass.
        if exit.behavior_key.is_some() {
            return Err(ProceduralViolation(
                "keyed-exit traversal is out of scope until sub-plan 6".into(),
            ));
        }
```

with (mirrors TS `go` steps 4-6):

```rust
        if let Some(key) = exit.behavior_key.clone() {
            let behavior = crate::world::exits::exit_behavior(&key).ok_or_else(|| {
                ProceduralViolation(format!("Exit behavior '{key}' is not registered."))
            })?;
            let actor_view = self
                .character_view(actor, cat)
                .ok_or_else(|| ProceduralViolation("actor not found".into()))?;
            // endpoints (compute now; immutable read before the get_mut below)
            let a = exit.endpoint_ids[0].clone();
            let b = exit.endpoint_ids[1].clone();
            let dest = if a == here { b } else { a };

            // canPass
            if !behavior.can_pass(&actor_view, &exit.state) {
                if let Some(fail) = behavior.fail_message() {
                    cues.push(PresentationCue::Mechanic {
                        cue: MechanicCue { text: Some(fail.into()), sound: None },
                    });
                }
                return Ok(()); // blocked — no move
            }
            // runScript(state) ?? passMessage
            let line = {
                let ex = self.exits.get_mut(&exit_id).expect("exit present");
                behavior.run_script(&actor_view, &mut ex.state)
            }
            .or_else(|| behavior.pass_message().map(|s| s.to_string()));
            if let Some(l) = line {
                cues.push(PresentationCue::Mechanic {
                    cue: MechanicCue { text: Some(l), sound: None },
                });
            }
            return self.move_to(actor, dest, cat, cues);
        }
```

Notes: `exit` is an immutable borrow used to read `behavior_key`/`endpoint_ids`/`state` for `can_pass`; clone the key and endpoints first, then the `get_mut(&exit_id)` for `run_script` takes a fresh mutable borrow (the earlier immutable borrow has ended). `exit_id` and `here` are already bound above in `go`. Confirm `MechanicCue` and `format!` are imported in `movement.rs` (add `use alloc::format;` if missing).

- [ ] **Step 4: Run tests + no_std**

Run: `cargo test -p wickedways-core movement::` then full `cargo test -p wickedways-core`
Expected: PASS.
Run: `cargo build -p wickedways-core --no-default-features`
Expected: success.

- [ ] **Step 5: Commit**

```bash
git add crates/wickedways-core/src/world/movement.rs
git commit -m "feat(core): registry-driven keyed-exit traversal in go (sub-plan 6c-1)"
```

---

## Task 3: Differential fixture + TS exit-behavior shadow

**Files:**
- Create: `conformance/fixtures/keyed-exit.gen.test.ts` + `conformance/keyed-exit.test.ts`
- Modify: `conformance/fixtures/vitest.config.ts`

**Interfaces:** consumes the TS oracle authoring layer (`.exit(from, dir, to, { behaviorKey, initialState })` + `registerExit`) + the conformance harness; produces a golden the Rust WASM replay must match.

- [ ] **Step 1: Study templates**

Read `conformance/fixtures/turn-movement.gen.test.ts` (how rooms + exits + `go` commands are built and recorded) and `src/lib/authoring/roundtrip.test.ts` around the `ironDoorBehavior: ExitBehavior` example (:293-315) for how a keyed exit + its `ExitBehavior` are authored and registered. Confirm the fixture-gen + conformance-run commands from `package.json`; the conformance wasm build already enables `--features conformance`.

- [ ] **Step 2: Author the TS exit-behavior shadow + fixture**

Create `conformance/fixtures/keyed-exit.gen.test.ts` (fixed SEED). Register a `conformance:keyed-door` `ExitBehavior` closure reproducing the Rust behavior byte-for-byte:

```ts
const keyedDoor: ExitBehavior = {
  preconditions: [(character, state) =>
    (state as { unlocked?: boolean }).unlocked === true || character.hasItem("brass-key")],
  script: (character, state) => {
    const s = state as { unlocked?: boolean };
    if (!s.unlocked && character.hasItem("brass-key")) { s.unlocked = true; return "The door unlocks."; }
    return undefined;
  },
  passMessage: "You pass through.",
  failMessage: "The door is locked.",
};
```

(Use the exact `ExitBehavior` / `hasItem` API from `src/lib/exit.ts` + the character interface — adjust the closure signatures to the real types.) Build a two-room map joined north by an exit authored with `{ behaviorKey: "conformance:keyed-door", initialState: { unlocked: false } }`, register `keyedDoor`, and place a PC in the start room plus a `"brass-key"` item the PC can hold. Record a command sequence with per-step cues+snapshot+view proving:
1. `go` North with NO key held → step cue `"The door is locked."`, PC still in the start room, exit `state.unlocked` still false.
2. PC holding the key, `go` North → step cue `"The door unlocks."`, PC now in the far room, exit `state.unlocked == true` in the snapshot.
3. (If a return path exists / re-entering) `go` back through → `"You pass through."` (script returns undefined once unlocked).

Add hard self-validation throws in the generator (assert each step's cue + the room move + the persisted `unlocked` flag).

- [ ] **Step 3: Author the replay test**

Create `conformance/keyed-exit.test.ts` mirroring an existing replay test (e.g. `conformance/mechanics.test.ts`): per-step `canonicalize()` + `.toEqual()` on cues, snapshot, and view; assert step count + `golden.seed`.

- [ ] **Step 4: Add to vitest config + generate + replay**

Add `keyed-exit.gen.test.ts` to `conformance/fixtures/vitest.config.ts`. Run the gen command, then `pnpm run test:conformance`.
Expected: the new `keyed-exit` suite PASSES. If it diverges, fix the RUST source (Task 2) or a faithful fixture correction — never a golden/comparator. Likely divergence: the TS shadow's precondition/script not matching the Rust door logic exactly (unlock-once semantics, message strings), or cue ordering.

- [ ] **Step 5: Confirm churn is only new files**

Run: `git status --short conformance/fixtures`
Expected: only the new `keyed-exit.*` files + the 1-line vitest include; no pre-existing golden changed.

- [ ] **Step 6: Commit**

```bash
git add conformance/fixtures/keyed-exit.gen.test.ts conformance/fixtures/keyed-exit.*.json conformance/keyed-exit.test.ts conformance/fixtures/vitest.config.ts
git commit -m "test(conformance): keyed-exit traversal differential fixture (sub-plan 6c-1)"
```

---

## Task 4: Docs + full gate

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update README**

In the map/movement (or mechanics) section (match surrounding style), document keyed exits: an exit may carry a `behaviorKey` resolving to a native `ExitBehavior` (`can_pass` / `run_script` / pass & fail messages); `go` evaluates it — a blocked exit emits its fail message and does not move, a passable one runs its script (which may mutate the exit's persisted `state` and yield a one-time narration, falling back to the pass message) and then moves. Note ViewModel `exits`/`lockedDoors` remain deferred.

- [ ] **Step 2: Full gate**

Run: `pnpm run checks:phase3`
Expected: EXIT 0.
Run: `pnpm run fixtures:stable`
Expected: EXIT 0.
Run: `git status --short conformance/fixtures`
Expected: empty.

Report the actual exit codes / summary lines as evidence. If a gate fails, STOP and report verbatim (do not force green by editing goldens).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: keyed-exit traversal + ExitBehavior registry (sub-plan 6c-1)"
```

---

## Self-Review Checklist (completed during authoring)

- **Spec coverage:** ExitBehavior trait + registry + conformance:keyed-door (T1); `go` keyed path with canPass→fail / runScript??passMessage / move + SET_EXIT_STATE (T2); differential fixture + TS shadow (T3); README + gate (T4). ViewModel exits/lockedDoors explicitly deferred.
- **Placeholder scan:** the two setup spots that depend on real helpers (`make_north_exit_keyed` shape; `seed_held_item` / item seeding; the exact TS `ExitBehavior`/`hasItem` types) are called out to match the real code, not left vague; all code steps carry complete code.
- **Type consistency:** `ExitBehavior` methods, `exit_behavior(key)`, `conformance:keyed-door` key, `"brass-key"` item key, and the cue strings (`"The door is locked."`, `"The door unlocks."`, `"You pass through."`) match across the Rust behavior (T1), the `go` path (T2), and the TS shadow (T3). `character_view`/`CharacterView.has_item` match the 6a-2 interface.
- **No golden churn:** existing fixtures have no keyed exits (keyed path unreachable); T3 asserts only new fixture files; T4 confirms the gate + empty fixture status.
