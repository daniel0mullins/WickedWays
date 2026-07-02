# Sub-plan 5: Turn/Round End Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Rust core a faithful turn-end: `end_turn` reconciles the actor, and a budgeted action auto-ends the turn the moment the action budget is exhausted — mirroring TS `Character.endTurn` + the budget half of `recordAction`.

**Architecture:** `World::end_turn` calls the already-present `World::reconcile` (RNG-free: floors base stats, re-applies affliction flags, latches KO on the rising edge). A single new `pub(crate) fn record_action` seam ticks `actions_this_round` and calls `end_turn` when it reaches `actions_per_round`. The five inline budget-tick sites are replaced by tail calls to `record_action` placed **after** each action's cue, matching TS `recordAction` order. `Catalog` is threaded into the four action paths that don't yet carry it (`go`, `move_to`, `record_fumble`, `consume_from_inventory`) because `reconcile` needs it.

**Tech Stack:** Rust (`crates/wickedways-core`, `no_std` core), TypeScript oracle (`src/`), vitest differential conformance gate (`conformance/`).

## Global Constraints

- **The differential conformance gate is the authority.** Divergences are fixed in Rust source (or a faithful fixture correction) — NEVER by editing goldens (`conformance/fixtures/*.snap.json`) or the comparator (`conformance/canonical-json.ts`).
- **`no_std` core.** Production code uses `alloc::` (`alloc::vec::Vec`, `alloc::string::String`, `alloc::format`), never `std::`. Unit tests run under default features.
- **This sub-plan changes NO goldens.** Turn-end reconcile is a no-op under phase-1's command surface (nothing mutates the actor's own stats mid-turn; PC `on_knock_out` is a no-op; the other two `endTurn` steps are deferred). Every existing fixture must stay byte-identical. Any golden diff is a bug to investigate, not to accept.
- **All randomness stays on the injected `World.rng`.** `reconcile` and `end_turn` draw no rng; do not add any.
- **Cap check uses `==`** exactly matching TS `actionsThisRound === actionsPerRound`.
- **Deferred (leave existing in-code comments intact):** `events.onTurnEnd` and all mechanic `DISPATCH_TURN`/`dispatchRound` hooks → sub-plan 6; full win/lose `resolveOutcome` → sub-plan 7 (the `max_rounds` timeout is already handled in `end_round`); differential coverage of turn-end reconcile → sub-plan 6.
- Full gate command: `pnpm run checks:phase3`. Idempotence check: `pnpm run fixtures:stable`. Crate unit tests: `cargo test -p wickedways-core`.

---

## File Structure

- `crates/wickedways-core/src/world/turn.rs` — `end_turn` gains a body + signature (`cat`, `cues`); new `record_action` seam; new unit tests.
- `crates/wickedways-core/src/world/command.rs` — `EndTurn` dispatch passes `cat` + `cues`.
- `crates/wickedways-core/src/world/combat.rs` — `attack` migrates its budget tick to `record_action`; its `record_fumble` call gains `cat`.
- `crates/wickedways-core/src/world/gate.rs` — `record_fumble` gains `cat`; budgeted-fumble tick migrates to `record_action`; `Catalog` import; test callers updated.
- `crates/wickedways-core/src/world/movement.rs` — `go` + `move_to` gain `cat`; budget tick migrates to `record_action`; `Catalog` import; test callers updated; new command-path unit test.
- `crates/wickedways-core/src/world/items_actions.rs` — `consume_from_inventory` gains `cat`; `take` + `consume_from_inventory` budget ticks migrate to `record_action`; `record_fumble` calls gain `cat`.
- `README.md` — turn-loop section notes the turn-end reconcile + auto-end-turn parity.

---

## Task 1: Wire `end_turn` to `reconcile`

**Files:**
- Modify: `crates/wickedways-core/src/world/turn.rs:92-94` (the `end_turn` stub)
- Modify: `crates/wickedways-core/src/world/command.rs:45` (`EndTurn` dispatch)
- Test: `crates/wickedways-core/src/world/turn.rs` (tests module, ~line 148)

**Interfaces:**
- Consumes: `World::reconcile(&mut self, actor: &CharacterId, cat: &Catalog, cues: &mut Vec<PresentationCue>)` (exists, `combat.rs:44`).
- Produces: `World::end_turn(&mut self, actor: &CharacterId, cat: &Catalog, cues: &mut Vec<PresentationCue>)` — used by Task 2's `record_action` and by `command.rs`.

- [ ] **Step 1: Write the failing test**

Add to the `tests` module in `crates/wickedways-core/src/world/turn.rs`:

```rust
    #[test]
    fn end_turn_runs_reconcile_floors_and_latches_ko() {
        use crate::world::afflictions::Status;
        use crate::world::descriptor::Catalog;
        let mut w = world_with_party(&["pc"], 10);
        let mut cues = Vec::new();
        // Drive base health negative WITHOUT start_turn's floor, so we can prove
        // end_turn's reconcile floors it and latches KO.
        if let Some(c) = w.characters.get_mut(&cid("pc")) {
            c.stats.health = -3.0;
        }
        w.end_turn(&cid("pc"), &Catalog::default(), &mut cues);
        let ch = w.characters.get(&cid("pc")).unwrap();
        assert_eq!(ch.stats.health, 0.0, "end_turn reconcile floors base health");
        assert!(ch.afflictions.is_active(Status::Ko), "end_turn reconcile latches KO");
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p wickedways-core end_turn_runs_reconcile -- --nocapture`
Expected: **compile error** — `end_turn` currently takes only `(_actor)`, so the 3-arg call does not type-check.

- [ ] **Step 3: Change the `end_turn` signature + body**

In `crates/wickedways-core/src/world/turn.rs`, replace:

```rust
    pub fn end_turn(&mut self, _actor: &CharacterId) {
        // character events + reconcile + mechanic turn-end: no-ops this sub-plan.
    }
```

with:

```rust
    /// End `actor`'s turn. Mirrors TS `Character.endTurn` (character.ts:1066-1070):
    /// `events.onTurnEnd()` (sub-plan 6), `#reconcile()`, `DISPATCH_TURN("end")`
    /// (sub-plan 6). Only the reconcile lands in sub-plan 5 — it floors base stats,
    /// re-applies affliction flags from effective stats, and latches KO on the
    /// rising edge. RNG-free.
    pub fn end_turn(&mut self, actor: &CharacterId, cat: &Catalog, cues: &mut Vec<PresentationCue>) {
        // character events (events.onTurnEnd): no-op until sub-plan 6.
        self.reconcile(actor, cat, cues);
        // mechanic DISPATCH_TURN("end"): no-op until sub-plan 6.
    }
```

`Catalog` and `PresentationCue` are already imported in `turn.rs`.

- [ ] **Step 4: Update the `EndTurn` command dispatch**

In `crates/wickedways-core/src/world/command.rs`, replace:

```rust
        Command::EndTurn => { world.end_turn(&actor); Ok(()) }
```

with:

```rust
        Command::EndTurn => { world.end_turn(&actor, cat, cues); Ok(()) }
```

(`cat` and `cues` are already parameters of `apply_command`.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `cargo test -p wickedways-core end_turn_runs_reconcile`
Expected: PASS.

- [ ] **Step 6: Run the whole crate test suite**

Run: `cargo test -p wickedways-core`
Expected: all tests PASS (existing `EndTurn`-command behavior is unchanged for callers that pass no-op-reconcile actors).

- [ ] **Step 7: Commit**

```bash
git add crates/wickedways-core/src/world/turn.rs crates/wickedways-core/src/world/command.rs
git commit -m "feat(core): end_turn reconciles the actor (sub-plan 5)"
```

---

## Task 2: `record_action` seam + auto-end-turn on budget exhaustion

**Files:**
- Modify: `crates/wickedways-core/src/world/turn.rs` (add `record_action`, add unit tests)
- Modify: `crates/wickedways-core/src/world/combat.rs:258` (attack tick) + `combat.rs:193` (record_fumble call)
- Modify: `crates/wickedways-core/src/world/gate.rs:70` (`record_fumble` signature), `gate.rs:89` (tick), `gate.rs` imports + test callers
- Modify: `crates/wickedways-core/src/world/movement.rs:43` (`go`), `:105` (`move_to`), `:240` (tick), `:53` (record_fumble call), imports + test callers
- Modify: `crates/wickedways-core/src/world/items_actions.rs:261` (take tick), `:509` (`consume_from_inventory` signature), `:525` (tick), `record_fumble` calls (`:75,:301,:447,:571`), `consume_from_inventory` calls (`:606,:685`)

**Interfaces:**
- Consumes: `World::end_turn(actor, cat, cues)` (Task 1); `World::reconcile` (exists).
- Produces: `World::record_action(&mut self, actor: &CharacterId, cat: &Catalog, cues: &mut Vec<PresentationCue>)` — ticks `actions_this_round += 1`, then calls `end_turn` when `actions_this_round == actions_per_round`.
- New param on existing fns (all take `cat: &Catalog` as the last param before `cues`):
  - `World::go(actor, dir, cat, cues)`
  - `World::move_to(actor, room, cat, cues)`
  - `World::record_fumble(actor, action, budgeted, cat, cues)`
  - `World::consume_from_inventory(actor, target, item_name, cat, cues)`

- [ ] **Step 1: Write the failing helper tests**

Add to the `tests` module in `crates/wickedways-core/src/world/turn.rs`:

```rust
    #[test]
    fn record_action_auto_ends_turn_at_cap() {
        use crate::world::afflictions::Status;
        use crate::world::descriptor::Catalog;
        let mut w = world_with_party(&["pc"], 10); // actions_per_round = 2
        let mut cues = Vec::new();
        if let Some(c) = w.characters.get_mut(&cid("pc")) {
            c.actions_this_round = 1; // one below cap
            c.stats.health = -3.0;    // reconcile will floor this iff it runs
        }
        w.record_action(&cid("pc"), &Catalog::default(), &mut cues); // 1 -> 2 == cap
        let ch = w.characters.get(&cid("pc")).unwrap();
        assert_eq!(ch.actions_this_round, 2);
        assert_eq!(ch.stats.health, 0.0, "cap reached -> end_turn -> reconcile floored base");
        assert!(ch.afflictions.is_active(Status::Ko));
    }

    #[test]
    fn record_action_below_cap_does_not_end_turn() {
        use crate::world::descriptor::Catalog;
        let mut w = world_with_party(&["pc"], 10); // actions_per_round = 2
        let mut cues = Vec::new();
        if let Some(c) = w.characters.get_mut(&cid("pc")) {
            c.actions_this_round = 0;
            c.stats.health = -3.0; // stays negative iff reconcile does NOT run
        }
        w.record_action(&cid("pc"), &Catalog::default(), &mut cues); // 0 -> 1 < cap
        let ch = w.characters.get(&cid("pc")).unwrap();
        assert_eq!(ch.actions_this_round, 1);
        assert_eq!(ch.stats.health, -3.0, "below cap: no reconcile, base untouched");
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p wickedways-core record_action -- --nocapture`
Expected: **compile error** — `record_action` does not exist yet.

- [ ] **Step 3: Add the `record_action` seam**

In `crates/wickedways-core/src/world/turn.rs`, immediately after `end_turn`, add:

```rust
    /// Single seam for a budgeted action's budget tick — the budget half of TS
    /// `Character.recordAction` (character.ts:530-536): increment
    /// `actions_this_round`, and when it reaches `actions_per_round`, auto-end the
    /// turn (which reconciles the actor). Call at the TAIL of each budgeted action,
    /// AFTER its `Action` cue is pushed, so any reconcile cues follow the action cue.
    pub(crate) fn record_action(
        &mut self,
        actor: &CharacterId,
        cat: &Catalog,
        cues: &mut Vec<PresentationCue>,
    ) {
        if let Some(c) = self.characters.get_mut(actor) {
            c.actions_this_round += 1;
        }
        let at_cap = self
            .characters
            .get(actor)
            .map(|c| c.actions_this_round == c.actions_per_round)
            .unwrap_or(false);
        if at_cap {
            self.end_turn(actor, cat, cues);
        }
    }
```

- [ ] **Step 4: Run the helper tests to verify they pass**

Run: `cargo test -p wickedways-core record_action`
Expected: PASS. (The crate as a whole will NOT yet compile if you have already changed call sites — do the migrations in Steps 5-9 next, then re-run.)

- [ ] **Step 5: Migrate the `attack` tick (combat.rs)**

In `crates/wickedways-core/src/world/combat.rs`, in the `attack` budget block (~`:257-263`), remove the `c.actions_this_round += 1;` line so the block only pushes history:

```rust
        if let Some(c) = self.characters.get_mut(actor) {
            c.history.push(ActionHistoryEntry::Attack {
                round,
                target: TargetRef { id: target.clone(), name: target_name },
            });
        }
```

Then, immediately after the Attack `Action` cue push and before `Ok(())` (~`:267`), add:

```rust
        self.record_action(actor, cat, cues);
        Ok(())
```

Also update the fizzle path (`combat.rs:193`) to pass `cat`:

```rust
                self.record_fumble(actor, "attack", true, cat, cues);
```

- [ ] **Step 6: Thread `cat` into `record_fumble` and migrate its budgeted tick (gate.rs)**

In `crates/wickedways-core/src/world/gate.rs`, add the import near the top:

```rust
use crate::world::descriptor::Catalog;
```

Change the `record_fumble` signature (`:70`) to take `cat` before `cues`:

```rust
    pub fn record_fumble(
        &mut self,
        actor: &CharacterId,
        action: &str,
        budgeted: bool,
        cat: &Catalog,
        cues: &mut Vec<PresentationCue>,
    ) {
```

Remove the inline tick from the borrow block (`:88-90`) so it only records the fumble history:

```rust
        if let Some(c) = self.characters.get_mut(actor) {
            c.history.push(ActionHistoryEntry::Fumble {
                round,
                action: action.into(),
            });
        }
```

Then, after the Fumble `Action` cue push (just before the closing `}` of `record_fumble`, ~`:97`), add the budgeted auto-end:

```rust
        if budgeted {
            self.record_action(actor, cat, cues);
        }
```

Update the two test callers in `gate.rs` (`:201`, `:226`) to pass `&Catalog::default()`:

```rust
        w.record_fumble(&actor, "takeFromLootBox", true, &Catalog::default(), &mut cues);
```
```rust
        w.record_fumble(&actor, "equip", false, &Catalog::default(), &mut cues);
```

- [ ] **Step 7: Thread `cat` into `go`/`move_to` and migrate the move tick (movement.rs)**

In `crates/wickedways-core/src/world/movement.rs`, add the import near the top:

```rust
use crate::world::descriptor::Catalog;
```

Add `cat` to both signatures:

```rust
    pub fn go(
        &mut self,
        actor: &CharacterId,
        dir: Direction,
        cat: &Catalog,
        cues: &mut Vec<PresentationCue>,
    ) -> Result<(), ProceduralViolation> {
```
```rust
    pub fn move_to(
        &mut self,
        actor: &CharacterId,
        room: RoomId,
        cat: &Catalog,
        cues: &mut Vec<PresentationCue>,
    ) -> Result<(), ProceduralViolation> {
```

Inside `go`, update the fizzle call (`:53`) and the `move_to` call (`:95`) to pass `cat`:

```rust
                self.record_fumble(actor, "go", true, cat, cues);
```
```rust
        self.move_to(actor, dest, cat, cues)
```

In `move_to`, remove the `c.actions_this_round += 1;` line from the budget block (`:240`) so it only pushes history:

```rust
        if let Some(c) = self.characters.get_mut(actor) {
            c.history.push(ActionHistoryEntry::Move {
                round,
                room: RoomRef { id: room.clone(), name: room_name.clone() },
            });
        }
```

Then, at the tail of `move_to` — after the encounter-cues `for` loop and immediately before `Ok(())` (~`:256`) — add:

```rust
        self.record_action(actor, cat, cues);
        Ok(())
```

Update the `go` test callers in `movement.rs` (`:313, :336, :354, :367, :383`) to pass `&Catalog::default()`, e.g.:

```rust
        w.go(&cid("pc"), Direction::North, &Catalog::default(), &mut cues).unwrap();
```

and add `use crate::world::descriptor::Catalog;` to the `movement.rs` tests module (`super::*` re-exports the file's imports, so this is already available — no extra import needed once the top-level `use` is added).

- [ ] **Step 8: Thread `cat` into `consume_from_inventory` and migrate its tick + the `take` tick (items_actions.rs)**

In `crates/wickedways-core/src/world/items_actions.rs`:

Change the `consume_from_inventory` signature (`:509`) to take `cat` before `cues`:

```rust
    fn consume_from_inventory(
        &mut self,
        actor: &CharacterId,
        target: &ItemId,
        item_name: &str,
        cat: &Catalog,
        cues: &mut Vec<PresentationCue>,
    ) -> Result<(), ProceduralViolation> {
```

Remove `ch.actions_this_round += 1;` from the `consume_from_inventory` borrow block (`:525`) so it retains + records history only:

```rust
            ch.inventory.item_ids.retain(|id| id != target);
            ch.history.push(ActionHistoryEntry::Drop {
                round,
                items: vec![ItemRef { id: target.clone(), name: item_name.to_string() }],
            });
            ch.name.clone()
```

At the tail of `consume_from_inventory` — after the Drop `Action` cue push, before `Ok(())` — add:

```rust
        self.record_action(actor, cat, cues);
        Ok(())
```

Update the two `consume_from_inventory` call sites (`:606` in `use_item`, `:685` in the other use path) to pass `cat`:

```rust
        self.consume_from_inventory(actor, target, &resolved.name.clone(), cat, cues)
```

In `take`, remove `ch.actions_this_round += 1;` from the borrow block (`:261`) so it only records `PickUp` history:

```rust
            ch.history.push(ActionHistoryEntry::PickUp {
                round,
                items: vec![ItemRef { id: target.clone(), name: resolved.name.clone() }],
            });
```

At the tail of `take` — after the PickUp `Action` cue push, before `Ok(Some(loot_id))` — add:

```rust
        self.record_action(actor, cat, cues);
        Ok(Some(loot_id))
```

Update the four `record_fumble` calls in `items_actions.rs` (`:75, :301, :447, :571`) to pass `cat`, e.g.:

```rust
                self.record_fumble(actor, "takeFromLootBox", false, cat, cues);
```

(All four of `take`, `equip`, `unequip`, and the drop path already have `cat` in scope.)

- [ ] **Step 9: Add the real-command-path test (movement.rs)**

Add to the `tests` module in `crates/wickedways-core/src/world/movement.rs`:

```rust
    #[test]
    fn budgeted_go_at_cap_triggers_turn_end_reconcile() {
        use crate::world::afflictions::Status;
        use crate::world::descriptor::Catalog;
        let mut w = world_two_rooms(false);
        let mut cues = Vec::new();
        if let Some(c) = w.characters.get_mut(&cid("pc")) {
            c.actions_per_round = 1; // next action exhausts the budget
            c.stats.health = -3.0;   // reconcile floors this iff turn-end runs
        }
        w.go(&cid("pc"), Direction::North, &Catalog::default(), &mut cues).unwrap();
        let ch = w.characters.get(&cid("pc")).unwrap();
        assert_eq!(ch.actions_this_round, 1);
        assert_eq!(ch.stats.health, 0.0, "cap-reaching move auto-ends turn -> reconcile floored base");
        assert!(ch.afflictions.is_active(Status::Ko));
    }
```

- [ ] **Step 10: Compile + run the full crate suite**

Run: `cargo test -p wickedways-core`
Expected: all tests PASS. Fix any remaining call sites the compiler flags (missing `cat` argument) until it is green. Pay attention to the existing budget-assertion tests (`items_actions.rs` "take should tick budget", `combat.rs` attack budget, `gate.rs` "budgeted fumble ticks budget", `movement.rs` `actions_this_round == 1`) — they must still pass because `record_action` still increments the budget.

- [ ] **Step 11: Verify the conformance gate is unchanged (no golden churn)**

Run: `pnpm run test:conformance`
Expected: PASS, all fixtures green.

Run: `git status --short conformance/fixtures`
Expected: **empty output** — no golden file changed. If any golden changed, STOP and investigate: turn-end reconcile must be a no-op under the current fixtures; a diff means an unintended cue/state emission (e.g. `record_action` placed before the action cue).

- [ ] **Step 12: Commit**

```bash
git add crates/wickedways-core/src/world/
git commit -m "feat(core): auto-end turn on budget exhaustion via record_action seam (sub-plan 5)"
```

---

## Task 3: Documentation + full gate

**Files:**
- Modify: `README.md` (turn-loop section)

**Interfaces:** none (docs + verification only).

- [ ] **Step 1: Update README**

In `README.md`, find the campaign turn-loop section (search for the turn/round description). Add a sentence documenting the parity, matching the surrounding prose style. Content to convey:

> A character's turn ends either explicitly (the `endTurn` command) or automatically the moment a budgeted action brings `actionsThisRound` up to `actionsPerRound`. Ending a turn reconciles the character — base stats are floored, affliction flags recomputed from effective stats, and knock-out latched — mirroring `Character.endTurn`. (Character `onTurnEnd` events and mechanic turn-end hooks arrive in a later sub-plan.)

- [ ] **Step 2: Run the full phase-3 gate**

Run: `pnpm run checks:phase3`
Expected: EXIT 0 — `no_std` build clean, `cargo test --workspace` green, `bindings:check` green, `test:conformance` green.

- [ ] **Step 3: Verify fixture idempotence**

Run: `pnpm run fixtures:stable`
Expected: EXIT 0 (regeneration produces no diff — the 4c-1 idempotence still holds).

- [ ] **Step 4: Final no-golden-change confirmation**

Run: `git status --short conformance/fixtures`
Expected: empty output.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: turn-end reconcile + auto-end-turn parity (sub-plan 5)"
```

---

## Self-Review Checklist (completed during authoring)

- **Spec coverage:** end_turn→reconcile (Task 1); auto-end-turn + shared seam (Task 2); no-golden-change guarantee verified (Task 2 Step 11, Task 3 Step 4); unit tests for reconcile-on-end / cap-fires / below-cap-no-fire / real-command-path (Tasks 1-2); README/TSDoc parity (Task 3); deferrals left as in-code comments (Task 1 Step 3). All spec sections mapped.
- **Placeholder scan:** none — every code step shows complete code.
- **Type consistency:** `record_action(actor, cat, cues)`, `end_turn(actor, cat, cues)`, and the four `cat`-threaded signatures use consistent names across all tasks; `Status::Ko`, `is_active`, `Catalog::default()`, `world_with_party`, `world_two_rooms`, `cid` match existing test helpers.
