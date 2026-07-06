# Sub-plan 6c-4: Cleanup Batch — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the `deposit_materials` fractional-quantity fidelity bug (with a differential fixture) and clear the accumulated 6c-2/6c-3 review Minors, with zero churn to existing goldens.

**Architecture:** One Rust fidelity fix (`as_i64`→`as_f64` for material quantities), a new fractional-material-drop differential fixture proving it, a bundle of Rust registry/doc minors, a bundle of TS/conformance doc minors, and a DRY extraction of the duplicated `viewProjected` generator helper into `gen-helpers.ts`.

**Tech Stack:** Rust `no_std` core (`crates/wickedways-core`) → WASM; TypeScript oracle (`src/lib/`); vitest differential harness (`conformance/`).

## Global Constraints

- **The differential conformance gate is the authority.** Never edit a golden or `conformance/canonical-json.ts` to force a pass.
- **No existing golden churn.** Every change here is either churn-free by construction (the `as_f64` fix compares equal for whole numbers) or a pure refactor that must regenerate byte-identical. After the final task, `git status --short conformance/fixtures` shows ONLY the new fractional fixture files.
- **`no_std` core:** `alloc::` only, never `std::`. Conformance behaviors stay `#[cfg(any(test, feature = "conformance"))]`.
- **Behavior-preserving refactors:** the registry block-form, `pub mod` placement, `viewProjected` extraction, and cue-capture harmonization must not change any emitted value.
- **Full gate:** `pnpm run checks:phase3` EXIT 0 and `pnpm run fixtures:stable` EXIT 0 before done.
- No README change (6c-4 adds no user-facing mechanic).

---

## File Structure

- `crates/wickedways-core/src/world/combat.rs` — `deposit_materials` f64 fix (Task 1).
- `conformance/fixtures/material-drop.gen.test.ts` + `conformance/material-drop.test.ts` + 3 json — fractional fixture (Task 2).
- `crates/wickedways-core/src/world/scenes.rs` — `scene_behavior` block-form (Task 3).
- `crates/wickedways-core/src/world/mod.rs` — `pub mod formations;` placement (Task 3).
- `crates/wickedways-core/src/world/formations.rs` — `maybe_spawn` missing-`visited` default-insert (Task 3).
- `crates/wickedways-core/src/world/movement.rs` — `fire_scenes` clarifying comment (Task 3).
- `src/lib/room.ts` — `enterRoom`/`exitRoom` concrete TSDoc (Task 4).
- `conformance/fixtures/sees-in-dark.gen.test.ts` — header typo + cue-capture harmonize (Task 4).
- `conformance/fixtures/gen-helpers.ts` — shared `viewProjected` (Task 5).
- All 14 `conformance/fixtures/*.gen.test.ts` — import shared `viewProjected`, drop local copies (Task 5).

---

## Task 1: `deposit_materials` f64 fidelity fix

**Files:**
- Modify: `crates/wickedways-core/src/world/combat.rs` (`deposit_materials` ~:293-299)
- Test: same file's `tests` module.

**Interfaces:** no signature change — `deposit_materials(&mut self, materials: &Value, by: Option<&str>, room: Option<&str>)` unchanged; only the numeric merge switches from `i64` to `f64`.

- [ ] **Step 1: Write the failing test**

Add to the `tests` module in `combat.rs`:

```rust
#[test]
fn deposit_materials_accumulates_fractional_quantities() {
    use crate::world::test_support::world_with_party;
    let mut w = world_with_party(&["pc"], 10);
    // first deposit: a fractional qty
    w.deposit_materials(&serde_json::json!({ "ectoplasm": 2.5 }), None, None);
    assert_eq!(w.campaign.materials["ectoplasm"], serde_json::json!(2.5));
    // second deposit accumulates as a float
    w.deposit_materials(&serde_json::json!({ "ectoplasm": 1.25 }), None, None);
    assert_eq!(w.campaign.materials["ectoplasm"], serde_json::json!(3.75));
    // whole-number deposits still work (mixed pool)
    w.deposit_materials(&serde_json::json!({ "bone": 2 }), None, None);
    assert_eq!(w.campaign.materials["bone"], serde_json::json!(2.0));
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p wickedways-core deposit_materials_accumulates_fractional_quantities`
Expected: FAIL — `2.5_f64.as_i64()` is `None` → the current code deposits `0`, so `materials["ectoplasm"]` is `0`, not `2.5`.

- [ ] **Step 3: Apply the f64 fix**

In `combat.rs` `deposit_materials`, change the additive-merge loop (~:294-298) from:

```rust
            for (component, qty) in obj {
                let add = qty.as_i64().unwrap_or(0);
                let cur = pool.get(component).and_then(|v| v.as_i64()).unwrap_or(0);
                pool.insert(component.clone(), json!(cur + add));
            }
```

to:

```rust
            for (component, qty) in obj {
                // TS `#materials[c] = (#materials[c] ?? 0) + qty` adds the raw number,
                // fractional or not — read both sides as f64 (matching MaterialMap's
                // `number` values). `as_i64` would silently drop a fractional qty to 0.
                let add = qty.as_f64().unwrap_or(0.0);
                let cur = pool.get(component).and_then(|v| v.as_f64()).unwrap_or(0.0);
                pool.insert(component.clone(), json!(cur + add));
            }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p wickedways-core deposit_materials_accumulates_fractional_quantities`
Expected: PASS.

- [ ] **Step 5: Full crate tests + no_std (churn guard)**

Run: `cargo test -p wickedways-core && cargo build -p wickedways-core --no-default-features`
Expected: PASS + SUCCESS. Existing tests that deposit whole-number materials still pass (`json!(2.0)` compares as a JSON number; the crate's own assertions use `as_f64`/`as_i64` consistently or exact `json!` — if any existing unit test asserts `json!(2)` (integer) against the now-`json!(2.0)` (float) pool value and fails, update that assertion to `json!(2.0)`, since serde_json treats `2` and `2.0` as distinct `Value`s — note this is a Rust-unit-test concern only; the differential comparator parses to JS numbers where `2 === 2.0`).

- [ ] **Step 6: Commit**

```bash
git add crates/wickedways-core/src/world/combat.rs
git commit -m "fix(core): deposit_materials adds fractional quantities as f64 (6c-4)"
```

---

## Task 2: Fractional-material-drop differential fixture

**Files:**
- Create: `conformance/fixtures/material-drop.gen.test.ts`, `conformance/material-drop.test.ts`, and the 3 generated json (`material-drop.start.snapshot.json`, `material-drop.catalog.json`, `material-drop.golden.json`).
- Modify: `conformance/fixtures/vitest.config.ts` (add `material-drop.gen.test.ts`).

**Interfaces:** Consumes the Task 1 f64 fix (compiled into the wasm via `pnpm run wasm:build`).

- [ ] **Step 1: Create the generator**

Create `conformance/fixtures/material-drop.gen.test.ts`, modeled closely on `conformance/fixtures/mob-defeat.gen.test.ts` (which already authors a mob with `materialDrops: { item: 2 }`, moves the PC into the mob's room, and attacks it to KO — depositing materials). Change exactly one thing that matters: author the defeated mob with a **fractional** `materialDrops` entry, e.g.:

```ts
.mob("Ghoul", {
  // ...same stats/room as mob-defeat...
  materialDrops: { ectoplasm: 2.5 },
  drops: [RELIC_KEY],
})
```

Keep the rest of the mob-defeat structure (a `drops` relic → `mob:Ghoul:remains` box; the PC attacks the Ghoul to KO with the same two-attack command stream). **Register no encounter formation** (baseEncounterChance 0, as mob-defeat does — a combat fixture whose rng draws are value-dependent must not let a formation offset the stream). Use `structuralClone` for the start snapshot and every per-step snapshot/view capture.

Self-validation (hard throws): after the KO step, the campaign materials pool has `ectoplasm === 2.5` (a fractional float, NOT 0 and NOT 2), and a `material` codex entry for `ectoplasm` exists. State in the file header that this fixture is the differential proof of the 6c-4 `deposit_materials` f64 fix (RED before it: Rust would deposit 0).

- [ ] **Step 2: Generate the golden**

Add `material-drop.gen.test.ts` to `conformance/fixtures/vitest.config.ts`'s include list, then run: `pnpm run fixtures:gen`
Expected: self-validation passes; `material-drop.*` json files written. The golden's final-step snapshot carries `"ectoplasm": 2.5` in the campaign materials pool.

- [ ] **Step 3: Create the replay test + run the differential**

Create `conformance/material-drop.test.ts` (copy `conformance/keyed-exit.test.ts`, swap basenames to `material-drop`).

Run: `pnpm run wasm:build && pnpm run test:conformance`
Expected: the `material-drop` differential is GREEN (the Task 1 f64 fix makes Rust deposit `2.5`, matching the TS golden) and all existing conformance tests still pass. If the differential fails with Rust depositing `0`, Task 1's fix is not in the wasm — rebuild. Never edit the golden.

- [ ] **Step 4: Confirm no other fixture churned**

Run: `git status --short conformance/fixtures`
Expected: only the new `material-drop.*` files and the `vitest.config.ts` edit.

- [ ] **Step 5: Commit**

```bash
git add conformance/fixtures/material-drop.gen.test.ts conformance/material-drop.test.ts conformance/fixtures/material-drop.start.snapshot.json conformance/fixtures/material-drop.catalog.json conformance/fixtures/material-drop.golden.json conformance/fixtures/vitest.config.ts
git commit -m "test(conformance): fractional material-drop differential fixture (6c-4)"
```

---

## Task 3: Rust registry/doc minors

**Files:**
- Modify: `crates/wickedways-core/src/world/scenes.rs` (`scene_behavior` ~:22-28)
- Modify: `crates/wickedways-core/src/world/mod.rs` (`pub mod formations;` ~:12)
- Modify: `crates/wickedways-core/src/world/formations.rs` (`maybe_spawn` visited block ~:139-152 + a test)
- Modify: `crates/wickedways-core/src/world/movement.rs` (`fire_scenes` comment)

**Interfaces:** none new — behavior-preserving except the `maybe_spawn` defensive default-insert (unreachable via the gate).

- [ ] **Step 1: `scenes.rs` block-form `#[cfg]`**

Change `scene_behavior` (`scenes.rs:22-28`) from the per-match-arm `#[cfg]` form to the block form used by `exits.rs`/`formations.rs`:

```rust
pub fn scene_behavior(key: &str) -> Option<&'static dyn SceneBehavior> {
    #[cfg(any(test, feature = "conformance"))]
    if key == "conformance:visit-counter" {
        return Some(&conformance::VISIT_COUNTER);
    }
    let _ = key;
    None
}
```

- [ ] **Step 2: `pub mod formations;` placement**

In `crates/wickedways-core/src/world/mod.rs`, move `pub mod formations;` (currently line 12, between `mechanics` and `resolve`) to its correct alphabetical position among the `pub mod` block — between `exits;` (line 7) and `gate;` (line 8):

```rust
pub mod exits;
pub mod formations;
pub mod gate;
```

and delete the misplaced `pub mod formations;` line that was between `mechanics;` and `resolve;`.

- [ ] **Step 3: `maybe_spawn` missing-`visited` defensive fix — write the failing test**

Add to `formations.rs`'s spawn-tests module:

```rust
#[test]
fn maybe_spawn_marks_visited_even_when_visited_key_absent() {
    let mut w = world_two_rooms(false);
    // encounter table with NO "visited" key at all
    w.campaign.encounter_table = serde_json::json!({ "baseChance": 0, "formations": [] });
    let _ = w.maybe_spawn(&rid("next"), &Catalog::default()).unwrap();
    // the mark must still land: "visited" now exists and contains "next"
    let visited = w.campaign.encounter_table.get("visited").and_then(|v| v.as_array());
    assert!(visited.is_some(), "visited array should be created when absent");
    assert!(visited.unwrap().iter().any(|v| v.as_str() == Some("next")));
}
```

- [ ] **Step 4: Run it to verify it fails**

Run: `cargo test -p wickedways-core maybe_spawn_marks_visited_even_when_visited_key_absent`
Expected: FAIL — the current `get_mut("visited").and_then(as_array_mut)` no-ops when the key is absent, so `visited` is never created.

- [ ] **Step 5: Apply the default-insert**

In `formations.rs` `maybe_spawn`, replace the mark-visited block (~:150-152):

```rust
        if let Some(arr) = self.campaign.encounter_table.get_mut("visited").and_then(|v| v.as_array_mut()) {
            arr.push(serde_json::Value::String(room.0.clone()));
        }
```

with a form that creates the array when absent:

```rust
        // Mark visited, creating the array if a hydrated table lacked the key
        // (serialized snapshots always carry `visited`; this is defensive parity
        // with TS's always-present `Set`).
        if let Some(obj) = self.campaign.encounter_table.as_object_mut() {
            let arr = obj
                .entry("visited")
                .or_insert_with(|| serde_json::Value::Array(alloc::vec::Vec::new()));
            if let Some(a) = arr.as_array_mut() {
                a.push(serde_json::Value::String(room.0.clone()));
            }
        }
```

- [ ] **Step 6: `fire_scenes` clarifying comment**

In `movement.rs` `fire_scenes`, add a one-line comment above the two-pass `emitted` buffer explaining it is intentional (no code change):

```rust
        // Collect cues into a local buffer and push after the loop. Intentional:
        // on the unregistered-key `Err` path this drops earlier scenes' cues, but
        // the whole move aborts (`?`) so the cue stream is discarded anyway — a
        // direct-push would be a behavior change, not a cleanup. (Unreachable via
        // the gate: TS resolves a scene behaviorKey at hydrate, not at fire.)
        let mut emitted: Vec<MechanicCue> = Vec::new();
```

(Match the existing `let mut emitted` line; add the comment directly above it.)

- [ ] **Step 7: Run the tests + no_std**

Run: `cargo test -p wickedways-core && cargo build -p wickedways-core --no-default-features`
Expected: PASS + SUCCESS (the new visited test passes; `scene_behavior`/`formations` still resolve their conformance keys; all existing tests green).

- [ ] **Step 8: Commit**

```bash
git add crates/wickedways-core/src/world/scenes.rs crates/wickedways-core/src/world/mod.rs crates/wickedways-core/src/world/formations.rs crates/wickedways-core/src/world/movement.rs
git commit -m "refactor(core): scene registry block-form, formations mod placement, maybe_spawn visited default-insert, fire_scenes comment (6c-4)"
```

---

## Task 4: TS + conformance doc minors

**Files:**
- Modify: `src/lib/room.ts` (`enterRoom`/`exitRoom` concrete method docs ~:283-299)
- Modify: `conformance/fixtures/sees-in-dark.gen.test.ts` (header typo + cue-capture harmonize)

**Interfaces:** none — documentation + a churn-free capture harmonization.

- [ ] **Step 1: `Room.enterRoom`/`exitRoom` TSDoc**

In `src/lib/room.ts`, update the concrete method doc comments (the `IRoom` interface docs were already updated in 6c-2; these are the class-method docs ~:283-299) to document the return value:

```ts
  /**
   * Adds `character` to the room's occupants and plays every `"enter"` scene,
   * returning the mechanic cues those scenes emitted (in registration order).
   * @param character - The character entering the room.
   */
  enterRoom(character: ICharacter): MechanicCue[] { /* unchanged body */ }

  /**
   * Plays every `"exit"` scene (returning the mechanic cues they emitted, in
   * registration order) and then removes `character` from the occupants.
   * @param character - The character leaving the room.
   */
  exitRoom(character: ICharacter): MechanicCue[] { /* unchanged body */ }
```

(Only the doc comment changes; leave the method bodies exactly as they are.)

- [ ] **Step 2: sees-in-dark header typo + cue-capture harmonize**

In `conformance/fixtures/sees-in-dark.gen.test.ts`:
- Fix the header comment that says `LightAversePlayer` where it means `SeesInDarkPlayer` (the class this file defines) — replace that one word.
- Standardize the cue capture: cue objects are fresh per emission (no live-reference risk), so the convention across generators is a bare `cues: drain()`. If this file wraps its cue capture in `structuralClone` (`cues: structuralClone(drain())`), change it to `cues: drain()`. Leave the `snapshot:` and `view:` captures as `structuralClone(...)` (those DO hold live-reference state). This must keep the `sees-in-dark` golden byte-identical.

- [ ] **Step 3: Typecheck + regenerate + churn check**

Run: `pnpm typecheck && pnpm run fixtures:gen && git status --short conformance/fixtures`
Expected: typecheck passes; `git status` shows NO change to `sees-in-dark.golden.json` / `sees-in-dark.start.snapshot.json` (the cue-capture harmonize is byte-identical). If `sees-in-dark.*` changed, the harmonize altered output — investigate (it should not).

- [ ] **Step 4: TS suite (room doc change is comment-only)**

Run: `pnpm vitest run src/lib/room.test.ts`
Expected: PASS (doc-only change).

- [ ] **Step 5: Commit**

```bash
git add src/lib/room.ts conformance/fixtures/sees-in-dark.gen.test.ts
git commit -m "docs(6c-4): Room enter/exitRoom return TSDoc; sees-in-dark header + cue-capture harmonize"
```

---

## Task 5: Extract `viewProjected` to `gen-helpers.ts`

**Files:**
- Modify: `conformance/fixtures/gen-helpers.ts` (add shared `viewProjected`)
- Modify: all 14 `conformance/fixtures/*.gen.test.ts` that define a local `viewProjected` (delete the local copy + its now-unused `EMPTY_ALIASES` where present; import the shared one)

**Interfaces:**
- Produces: `viewProjected(campaign: Campaign, aliases?: Record<string, string[]>, opened?: ReadonlySet<string>)` in `gen-helpers.ts` — the projection body is identical across all 14 generators; the only per-generator variation today is which args are passed, so **default params** (`aliases = {}`, `opened = new Set()`) make one helper a drop-in at every existing call site with NO call-site edits.

- [ ] **Step 1: Add the shared helper to `gen-helpers.ts`**

Append to `conformance/fixtures/gen-helpers.ts`:

```ts
import type { Campaign } from "wickedways/lib/campaign";
import { view } from "../../packages/play-runtime/src/viewmodel.ts";

/**
 * Project the full TS ViewModel to the exact Rust ViewModel subset for goldens:
 * drop top-level `exits`/`lockedDoors` (never emitted here), `status.locationName`,
 * and `room.image`. Extracted from the per-generator copies — the body was identical
 * across all of them; the only variation was how `aliases`/`opened` were supplied,
 * so these default to empty (matching the generators that hardcoded empties).
 */
export function viewProjected(
  campaign: Campaign,
  aliases: Record<string, string[]> = {},
  opened: ReadonlySet<string> = new Set(),
) {
  const full = view(campaign, aliases, opened);
  const { image: _roomImage, ...roomRest } = full.room as { image?: unknown; [k: string]: unknown };
  const { locationName: _locName, ...statusRest } = full.status as { locationName?: unknown; [k: string]: unknown };
  return {
    room: roomRest,
    occupants: full.occupants,
    loot: full.loot,
    inventory: full.inventory,
    scope: full.scope,
    status: statusRest,
    outcome: full.outcome,
    finished: full.finished,
  };
}
```

> Confirm the `view` import path (`../../packages/play-runtime/src/viewmodel.ts`) matches what the generators currently use; copy it verbatim from one of them.

- [ ] **Step 2: Replace the local copies in all 14 generators**

In EACH of these files, delete the local `function viewProjected(...) { … }` definition and add `viewProjected` to the import from `./gen-helpers.ts` (which most already import `structuralClone` from). Where a generator also defined a now-unused `const EMPTY_ALIASES = {}` (only `scene.gen.test.ts`, `spawn.gen.test.ts`, `turn-movement.gen.test.ts`), delete that const too. **Do not touch the call sites** — they already pass the correct args:
- 3-arg `viewProjected(campaign, ALIASES, opened)`: afflictions, combat, items-actions, keyed-exit, mechanics, mechanics-action, mechanics-turnend, mob-defeat, mob-drop, sees-in-dark
- 2-arg `viewProjected(campaign, ALIASES)`: items-projection
- 1-arg `viewProjected(campaign)`: scene, spawn, turn-movement

The default params make all three forms produce byte-identical output to today.

Files: `afflictions.gen.test.ts`, `combat.gen.test.ts`, `items-actions.gen.test.ts`, `items-projection.gen.test.ts`, `keyed-exit.gen.test.ts`, `mechanics.gen.test.ts`, `mechanics-action.gen.test.ts`, `mechanics-turnend.gen.test.ts`, `mob-defeat.gen.test.ts`, `mob-drop.gen.test.ts`, `scene.gen.test.ts`, `sees-in-dark.gen.test.ts`, `spawn.gen.test.ts`, `turn-movement.gen.test.ts`.

> Also add `material-drop.gen.test.ts` (from Task 2) to this list — it too should import the shared helper rather than carry a 15th copy.

- [ ] **Step 3: Typecheck + regenerate byte-identical**

Run: `pnpm typecheck && pnpm run fixtures:gen`
Expected: typecheck passes; generators run.

- [ ] **Step 4: Prove NO golden churn**

Run: `git status --short conformance/fixtures`
Expected: NO `*.golden.json` / `*.start.snapshot.json` / `*.catalog.json` changes — only the `.gen.test.ts` source edits. If ANY golden changed, a call site's effective args differed from the shared helper's defaults — reconcile so output is byte-identical (do not accept churn).

- [ ] **Step 5: Full gate**

Run: `pnpm run checks:phase3 && pnpm run fixtures:stable`
Expected: BOTH EXIT 0.

- [ ] **Step 6: Commit**

```bash
git add conformance/fixtures/gen-helpers.ts conformance/fixtures/*.gen.test.ts
git commit -m "refactor(conformance): extract shared viewProjected into gen-helpers.ts (6c-4)"
```

---

## Self-Review

**Spec coverage:**
- `deposit_materials` f64 fix → Task 1; fractional fixture → Task 2. ✅
- 6c-2 minors: `scenes.rs` block-form → Task 3; `Room` TSDoc → Task 4; `fire_scenes` comment → Task 3. ✅
- 6c-3 minors: `pub mod formations` placement → Task 3; missing-`visited` default-insert → Task 3; sees-in-dark header typo → Task 4; `spawn.gen` cue harmonize → folded into Task 4's "standardize cue capture" (the convention is bare `drain()`; the fixture that wraps it gets unwrapped). ✅
- `viewProjected` extraction → Task 5. ✅
- Non-goals (fractional formation weight, `sees_in_dark≡light_averse`) → not implemented, per spec. ✅
- No README change → consistent with spec. ✅

**Note on the spawn.gen cue-harmonize item:** the 6c-3 review flagged `spawn.gen` using bare `drain()` while `sees-in-dark` wraps cues in `structuralClone`. Cues are fresh per-emission (no live-ref risk), so the correct convention is bare `drain()` (the majority); Task 4 removes the redundant wrap from `sees-in-dark` rather than adding a redundant wrap to `spawn`. Both are byte-identical; the plan standardizes on the simpler, majority form.

**Placeholder scan:** every code step carries complete code; the fixture task references `mob-defeat.gen.test.ts` to mirror with the one concrete change (fractional `materialDrops`) spelled out.

**Type consistency:** `deposit_materials` signature unchanged; `viewProjected(campaign, aliases?, opened?)` default-param signature matches all three existing call-site arities; `MechanicCue[]` return types on `Room.enterRoom`/`exitRoom` match the 6c-2 implementation.
