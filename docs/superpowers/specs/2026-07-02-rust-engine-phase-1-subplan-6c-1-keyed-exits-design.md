# Rust Engine — Phase 1, Sub-plan 6c-1: Keyed Exits (design)

## Context

We are re-authoring the TypeScript RPG engine (`src/`) as a Rust core (`crates/wickedways-core`),
verified byte-for-byte against the TS "oracle" by a differential conformance gate. Sub-plan 6a
built the `MechanicOp` registry + hook/effect machinery; 6a-2/6a-3 completed turn-end faithfulness
and custom mechanic actions. Sub-plan **6b (`ScriptedMechanic`/Rhai) is DEFERRED** to nearer the
Phase-2 hosted-tier cutover (a feasibility spike found it host-owns determinism and adds no
gate-testable engine behavior).

Sub-plan **6c** ports the remaining registry-bound behaviors the oracle actually has — keyed
exits, scenes, encounter spawning — using the same native-registry + matched-behavior approach
proven for mechanics. It decomposes into **6c-1 keyed exits** (this spec), **6c-2 scenes**, and
**6c-3 encounter spawning** (which will fold the carried mob debts). **NPC dialogue is deferred out
of Phase 1** (an out-of-band string query with no cues / no core state for the gate to diff).

Today `movement.rs` `go` traverses behavior-free exits but returns
`Err("keyed-exit traversal is out of scope until sub-plan 6")` for any exit with a `behavior_key`
(`movement.rs:84-88`). 6c-1 replaces that stub with registry-driven exit evaluation.

## The TS contract being ported (authoritative source)

`Character.go(direction)` (`src/lib/character/character.ts`):
1. `if (!this.attemptAction(this.go, true)) return;` — affliction gate (budgeted).
2. no room → `ProceduralViolation`.
3. `exit = here.exits.get(direction)`; if `undefined` → emit `{kind:"mechanic", cue:{text:"You can't go that way."}}` and return.
4. `if (!exit.canPass(this))` → if `exit.failMessage`, emit it as a `mechanic` cue; **return without moving**.
5. `line = exit.runScript(this) ?? exit.passMessage`; if `line` truthy, emit it as a `mechanic` cue.
6. `this.withGateSuppressed(() => this.move(exit.otherSide(here)))` — move to the far endpoint (gate already ran in step 1, so the inner move is gate-suppressed).

`Exit` (`src/lib/exit.ts`): `canPass(character) = preconditions.every(p => p(character, #state))`;
`runScript(character)` runs the optional `#script(character, #state)`, may mutate `#state`, returns
`string | void`; `passMessage`/`failMessage` are static strings; `otherSide(from)` returns the
other endpoint. `ExitBehavior { preconditions, script?, passMessage?, failMessage? }` is the
registry entry; `#state` is mutated only via the `SET_EXIT_STATE` symbol seam and is the only
serialized part (behavior rebinds from the registry by `behaviorKey`).

`ExitSnapshot` (Rust, `snapshot.rs`) already round-trips:
`{ id, endpoint_ids: [RoomId; 2], behavior_key: Option<String>, name: Option<String>, state: Value }`.

## Design

### 1. `ExitBehavior` trait + registry

A native, object-safe trait keyed by `behavior_key` (mirroring `mechanic_op`):

```rust
pub trait ExitBehavior: Sync {
    /// TS `canPass` = all preconditions pass. Read-only over the actor view + exit state.
    fn can_pass(&self, actor: &CharacterView, state: &Value) -> bool;
    /// TS `runScript`: run on a successful pass; may mutate `state`; returns a one-time
    /// narration line (TS `string | void`).
    fn run_script(&self, _actor: &CharacterView, _state: &mut Value) -> Option<String> { None }
    fn pass_message(&self) -> Option<&str> { None }
    fn fail_message(&self) -> Option<&str> { None }
}

/// Resolve a first-party exit behavior by key (compiled-in; conformance-gated test impls behind
/// `#[cfg(any(test, feature = "conformance"))]`, same pattern as `mechanic_op`).
pub fn exit_behavior(key: &str) -> Option<&'static dyn ExitBehavior> { … }
```

Lives in a new `crates/wickedways-core/src/world/exits.rs` (or `mechanics/`-adjacent module). The
`CharacterView` type is reused from `mechanics::view` — its `has_item(behaviorKey)` /
`has_equipped(behaviorKey)` predicates are exactly how a keyed door checks the actor holds the key.

### 2. `go` keyed-exit path

Replace the `Err` stub in `movement.rs` `go`. After resolving `exit` and finding
`exit.behavior_key == Some(key)`:

```rust
let behavior = exit_behavior(key)
    .ok_or_else(|| ProceduralViolation(format!("Exit behavior '{key}' is not registered.")))?;
let actor_view = self.character_view(actor, cat)
    .ok_or_else(|| ProceduralViolation("actor not found".into()))?;

// canPass
if !behavior.can_pass(&actor_view, &exit.state) {
    if let Some(fail) = behavior.fail_message() {
        cues.push(PresentationCue::Mechanic { cue: MechanicCue { text: Some(fail.into()), sound: None } });
    }
    return Ok(()); // blocked — no move
}

// runScript(state, mutating) ?? passMessage
let line = {
    let ex = self.exits.get_mut(&exit_id).expect("exit present");
    behavior.run_script(&actor_view, &mut ex.state)
}.or_else(|| behavior.pass_message().map(|s| s.to_string()));
if let Some(l) = line {
    cues.push(PresentationCue::Mechanic { cue: MechanicCue { text: Some(l), sound: None } });
}

// move to the far endpoint (gate already ran at the top of `go`)
let dest = far_endpoint(exit, &here); // the endpoint_ids entry != here
return self.move_to(actor, dest, cat, cues);
```

Notes: `actor_view` is owned (built before the `get_mut` borrow); the far endpoint is computed from
`endpoint_ids` (the behavior-free path already does this). The `state` write inside `run_script` via
`self.exits.get_mut(&exit_id).state` is the Rust equivalent of TS `SET_EXIT_STATE`. Order matches
TS: canPass → (fail cue | runScript-or-passMessage cue) → move.

### 3. Conformance behavior + differential fixture

A `conformance:keyed-door` `ExitBehavior` (feature/test-gated), mirrored by a TS closure under the
same key:
- `can_pass` = `state["unlocked"] == true || actor.has_item("<keyBehaviorKey>")`.
- `run_script` = if not already unlocked **and** the actor has the key: set `state["unlocked"] = true`
  and return `Some("The door unlocks.")`; else `None`.
- `pass_message` = `"You pass through."`; `fail_message` = `"The door is locked."`.

Differential fixture (`keyed-exit.gen.test.ts` + replay test): a two-room map joined by a
`conformance:keyed-door` exit, and a PC. Command sequence proving:
1. PC (no key) `go` toward the door → `"The door is locked."` cue, PC stays in the room.
2. PC acquires/holds the key, `go` again → `"The door unlocks."` cue (runScript), PC moves to the
   far room, `state.unlocked == true` persisted in the snapshot.
3. (Optional) a later traversal → `"You pass through."` (passMessage, runScript returns `None`).

Use the shared-shadow pattern (a small TS exit-behavior closure) so the gate diffs Rust-native vs
TS-closure per step (cues + snapshot exit state + view).

### 4. Testing

- **Rust unit tests:** `can_pass` true/false gating; blocked path emits `fail_message` and does not
  move (room unchanged); `run_script` mutates `state` (unlocked flips) and returns the narration;
  `pass_message` fallback when `run_script` returns `None`; unknown `behavior_key` → `ProceduralViolation`.
- **Differential fixture** (above) exercising all three traversal outcomes.
- **No pre-existing golden churn:** existing fixtures have no keyed exits, so the new keyed path is
  unreachable for them. Full gate `pnpm run checks:phase3` EXIT 0 + `pnpm run fixtures:stable`
  EXIT 0; `git status --short conformance/fixtures` shows only the new fixture files.
- `no_std` (`alloc::` only; conformance behavior feature-gated, absent from the default build).

## Deferred

- **ViewModel `exits` / `lockedDoors`** — presentation projection of a room's available exits and
  which are locked. It would churn the per-step `view` goldens and needs a coordinated TS-view
  change, and keyed-exit *traversal* is fully gate-testable via cues + exit-state snapshot without
  it. Split to a separate small view-widening slice (or fold into a later ViewModel pass), not 6c-1.
- Scenes → **6c-2**; encounter spawning (+ carried mob debts) → **6c-3**; NPC dialogue → out of
  Phase 1.

## Documentation

Per the standing convention, update `README.md` (and relevant Rust doc comments) to document
keyed-exit traversal (the `ExitBehavior` registry, the `can_pass`/`run_script`/pass&fail-message
contract, the `go` evaluation order) before the work is considered done.
