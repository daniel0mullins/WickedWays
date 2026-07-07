# Light-Tied Mob Initiative Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax. NOTE: the tasks are tightly coupled (oracle + core + goldens must move together), so inline execution is expected over subagent fan-out.

**Goal:** A time-advancing **move into a lit room does not provoke mob reactions** — a player who can see gets the drop on entry, removing the lit-room entry ambush. Nothing else in the combat model changes.

**Architecture:** Change the mob-reaction gate in the two orchestration layers in lockstep — Rust `World::submit` and the frozen gate oracle `conformance/fixtures/oracle-session.ts::execute` — then regenerate the facade goldens from the oracle and add differential coverage. The live `GameSession.execute` delegates to `Authority.submit`, so it inherits the fix.

**Tech Stack:** Rust (`wickedways-core`), TypeScript (Vitest differential conformance harness), `pnpm`.

**Spec:** `docs/superpowers/specs/2026-07-07-light-tied-mob-initiative-design.md`.

## Global Constraints

- **The differential gate is the authority.** This is a *deliberate oracle behavior change*: edit `oracle-session.ts`, then **regenerate** affected goldens from it (`fixtures:gen`) — never hand-edit a golden or `conformance/canonical-json.ts`. The Rust core must reproduce the regenerated goldens byte-for-byte.
- **Scope = one rule:** skip reactions ⟺ `advances && !(intent is Move && is_lit(current_room_after_move))`. No other combat behavior moves. Deferred (out of scope): dark "mob-first" reorder, dark flee parting shot, per-mob ambush knob.
- **`no_std`:** `submit.rs` change stays `alloc`-only; `cargo build -p wickedways-core --no-default-features` passes.
- **`is_lit`** already accounts for the player's equipped lantern, room light, and occupant-carried light — reuse it, add no new "has light" logic.
- **Full gate:** `pnpm run checks:phase2` green at the end.

---

## Task 1: Rust core — skip reactions on a move into a lit room

**Files:**
- Modify: `crates/wickedways-core/src/world/submit.rs` (`World::submit`, ~lines 142-168)
- Test: same file's `#[cfg(test)] mod tests`

- [ ] **Step 1: Write the failing tests**

Add to `submit.rs` tests, using the existing `world_for_submit` / `seat_test_mob` helpers:

```rust
#[test]
fn move_into_lit_room_with_mob_does_not_provoke_ambush() {
    // room1 is lit (world_with_pc_in_room sets dark:false). Seat a mob in room1,
    // put the PC in an adjacent room, then move in. No entry ambush; mob unharmed,
    // PC unhit.
    let mut w = world_for_submit();
    // Add a second lit room "room0" with a south exit into room1, move PC there first.
    // (Mirror the fixture setup used by other movement tests; if simpler, seat the
    // mob in room1 and move the PC out then back in.)
    seat_test_mob(&mut w, "wraith", "room1");
    // ...place PC in an adjacent lit room with an exit to room1...
    let (r, _) = submit_one(&mut w, Intent::Move { dir: /* toward room1 */ });
    assert_eq!(r.error, None);
    assert_eq!(r.mob_attacks, Some(Vec::new()), "lit entry must not provoke a mob swing");
}

#[test]
fn wait_in_lit_room_with_mob_still_provokes() {
    // Control: a NON-move advancing action still triggers reactions.
    let mut w = world_for_submit();
    seat_test_mob(&mut w, "wraith", "room1"); // PC already in room1 (lit)
    let (r, _) = submit_one(&mut w, Intent::Wait);
    assert_eq!(r.mob_attacks.as_ref().map(|v| v.len()), Some(1));
}
```

If constructing an adjacent room is awkward in the unit harness, assert the invariant directly instead: after a `Move` that lands the PC in a lit occupied room, `mob_attacks == Some(vec![])` and the mob's/PC's stats are unchanged; keep `wait_in_lit_room_with_mob_still_provokes` as the control. Use whatever `world_for_submit` exposes; match the existing movement-test setup in the crate.

- [ ] **Step 2: Run to verify failure**

Run: `cd crates/wickedways-core && cargo test --lib move_into_lit_room_with_mob wait_in_lit_room_with_mob`
Expected: the move test FAILS (today the entry provokes → non-empty `mob_attacks`).

- [ ] **Step 3: Implement the skip**

In `World::submit`, capture the move-ness before `intent` is consumed by `dispatch_intent`, and gate `run_mob_reactions`:

```rust
let advances = is_time_advancing(&intent);
let is_move = matches!(intent, Intent::Move { .. });
let outcome: Result<Option<Vec<MobAttack>>, ProceduralViolation> = (|| {
    let actor = self.active_character_id()?;
    if advances {
        self.start_turn(&actor, cat, &mut cues)?;
    }
    self.dispatch_intent(&actor, intent, cat, opened, &mut cues)?;
    // Light-tied initiative (v1): a time-advancing MOVE into a LIT room does not
    // provoke mob reactions — a player who can see gets the drop on entry.
    // (spec: docs/superpowers/specs/2026-07-07-light-tied-mob-initiative-design.md)
    let entered_lit = is_move
        && self
            .characters
            .get(&actor)
            .and_then(|c| c.current_room_id.clone())
            .map(|rid| self.is_lit(&rid, cat))
            .unwrap_or(false);
    let mob_attacks = if advances && !entered_lit {
        self.run_mob_reactions(&actor, cat, &mut cues)
    } else {
        Vec::new()
    };
    if advances {
        self.next_player(cat, &mut cues)?;
    }
    Ok(Some(mob_attacks))
})();
```

Confirm `is_lit`'s real signature (`self.is_lit(&RoomId, &Catalog) -> bool`, per `combat.rs`/`movement.rs`) and adjust if it differs.

- [ ] **Step 4: Verify pass + no_std + no regressions**

Run: `cd crates/wickedways-core && cargo test --lib && cargo build -p wickedways-core --no-default-features && cargo clippy -p wickedways-core --all-targets 2>&1 | grep -v "failed to parse serde attribute" | grep "^warning: [a-z]" || echo "clippy clean"`
Expected: all pass; existing `run_mob_reactions`/`submit` tests still green (they use `wait`/`attack`, not moves into occupied rooms — unaffected).

- [ ] **Step 5: Commit**

```bash
git add crates/wickedways-core/src/world/submit.rs
git commit -m "feat(core): no mob ambush when entering a lit room (light-tied initiative)"
```

---

## Task 2: TS gate oracle — mirror the skip + regenerate goldens

**Files:**
- Modify: `conformance/fixtures/oracle-session.ts` (`execute`, line 98)
- Regenerate: any facade `*.golden.json` whose stream moves into a lit occupied room

- [ ] **Step 1: Mirror the rule in the oracle**

Replace `oracle-session.ts:98`:

```ts
const mobAttacks = advances ? this.runMobReactions() : [];
```

with:

```ts
// Light-tied initiative (v1): a time-advancing MOVE into a LIT room does not
// provoke a reaction — a player who can see gets the drop on entry (mirrors the
// Rust World::submit gate; spec 2026-07-07-light-tied-mob-initiative-design.md).
const enteredLit =
  intent.kind === "move" && (this.campaign.activeCharacter.currentRoom?.isLit ?? false);
const mobAttacks = advances && !enteredLit ? this.runMobReactions() : [];
```

(`dispatch(intent)` on line 94 has already moved the PC, so `activeCharacter.currentRoom` is the destination. `Room.isLit` is the TS equivalent of `is_lit`.)

- [ ] **Step 2: Regenerate + inspect the golden diff**

Run: `pnpm run fixtures:gen && git status --short conformance/fixtures/`
Expected: only facade goldens that actually move into a lit occupied room change; the change is limited to that step losing its entry `mobAttacks` entry (and downstream snapshot/view deltas from the un-dealt damage). **Read the diff** — if a golden changes in any other way, stop and investigate. If NO existing golden moves into a lit occupied room, expect zero churn here (the new coverage comes in Task 3).

- [ ] **Step 3: Verify the gate replays green**

Run: `pnpm run wasm:build:conformance && pnpm vitest run --config conformance/vitest.config.ts`
Expected: PASS — Rust `submit` (Task 1) reproduces the regenerated oracle goldens byte-for-byte.

- [ ] **Step 4: Commit**

```bash
git add conformance/fixtures/oracle-session.ts conformance/fixtures/*.golden.json
git commit -m "test(conformance): oracle mirrors lit-entry no-ambush; regenerate facade goldens"
```

---

## Task 3: Differential fixture — lit-entry-no-ambush (+ dark control)

**Files:**
- Create: `conformance/fixtures/lit-entry.gen.test.ts` (generator)
- Create: `conformance/lit-entry.test.ts` (replay)
- Modify: `conformance/fixtures/vitest.config.ts` (register the generator)
- Generated (committed): `conformance/fixtures/lit-entry.{start.snapshot,catalog,golden}.json`

- [ ] **Step 1: Write the generator**

Model it on the existing facade generators (read one first — e.g. `conformance/fixtures/facade-*.gen.test.ts` — for the genesis-snapshot + oracle-drive + per-step capture shape). Build a bespoke campaign with:
- Two **lit** rooms A→B; a live normal mob seated in B; the PC starts in A with a weapon equipped.
- A third **dark** room C (adjacent to A) holding a **light-averse** mob (reuse the `conformance` sees-in-dark/light-averse mob the existing sees-in-dark fixture uses).

Command stream (drive `oracle-session.ts`, capture `{command, cues, snapshot, view}` per step):
1. `move` A→B (lit, occupied) → **assert this step's `mobAttacks` is empty** (the feature).
2. `attack` the mob in B → assert it trades (mob counters) — control that co-located combat still reacts.
3. (separate leg / fresh session) `move` A→C (dark) with the light-averse mob → **assert this step's `mobAttacks` is non-empty** (dark entry still ambushes) — the scope control.

Self-validate by throwing if step 1 has any mobAttack or step 3 has none. Write the three JSON files via the shared `buildCatalog`/serialize helpers.

- [ ] **Step 2: Register + generate**

Add `"conformance/fixtures/lit-entry.gen.test.ts"` to `conformance/fixtures/vitest.config.ts` `include`, then:
Run: `pnpm run fixtures:gen`
Expected: PASS; three `lit-entry.*.json` written; self-validation holds.

- [ ] **Step 3: Write the replay harness**

Create `conformance/lit-entry.test.ts` modeled on `conformance/scripted-mechanics.test.ts`: load the three files, `wasm.replay_commands(...)`, assert per-step `cues`/`snapshot`/`view` via `canonicalize`.

- [ ] **Step 4: Run the replay**

Run: `pnpm run wasm:build:conformance && pnpm vitest run --config conformance/vitest.config.ts lit-entry`
Expected: PASS — Rust reproduces the lit-entry (no ambush) and dark-entry (ambush) steps byte-for-byte. A divergence is a real Rust/oracle mismatch — fix the core, never the golden.

- [ ] **Step 5: Commit**

```bash
git add conformance/fixtures/lit-entry.gen.test.ts conformance/fixtures/lit-entry.*.json conformance/lit-entry.test.ts conformance/fixtures/vitest.config.ts
git commit -m "test(conformance): lit-entry-no-ambush differential fixture (+ dark control)"
```

---

## Task 4: Docs + full gate

**Files:**
- Modify: `README.md` (the combat / mob-reaction section)

- [ ] **Step 1: Document the rule**

In the README section covering combat / solo-GM mob reactions, note the initiative rule: mobs strike back after a player's time-advancing action while co-located, **except** that entering a lit room does not provoke a swing (a player who can see gets the drop); dark-dwelling mobs still ambush.

- [ ] **Step 2: Full gate**

Run: `pnpm run checks:phase2`
Expected: PASS end-to-end (no_std build, workspace tests, bindings, both wasm builds, purity check, conformance incl. the new + regenerated fixtures, typechecks, vitest).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: light-tied mob initiative (no ambush entering a lit room)"
```

## Self-Review

- **Spec coverage:** the one rule (Task 1 core + Task 2 oracle), regenerated goldens (Task 2), differential coverage incl. the dark scope-control (Task 3), docs + gate (Task 4). ✅
- **Placeholder scan:** the only soft spots are "match the existing fixture/helper shape" pointers (Tasks 1 & 3) — these direct the implementer to real files to mirror, not undefined work.
- **Consistency:** the skip predicate is identical in Rust (`is_move && is_lit`) and TS (`intent.kind === "move" && currentRoom.isLit`); `mob_attacks == Some(vec![])` on skip matches the empty-success contract both sides.
