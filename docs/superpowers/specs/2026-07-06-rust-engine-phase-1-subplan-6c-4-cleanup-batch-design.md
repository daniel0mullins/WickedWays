# Rust Engine — Phase 1, Sub-plan 6c-4: Cleanup Batch (design)

## Context

We are re-authoring the TypeScript RPG engine (`src/`) as a Rust core (`crates/wickedways-core`),
verified byte-for-byte against the TS "oracle" by a differential conformance gate. Sub-plans 6c-1
(keyed exits), 6c-2 (scenes), and 6c-3 (encounter spawning) each deferred a small number of Minor
findings and one real fidelity bug to a consolidated cleanup pass. **6c-4 is that pass** — one
substantive fidelity fix plus the accumulated review Minors. No new engine feature; the differential
gate stays the authority and no existing golden may churn.

## Items (authoritative backlog)

### A. `deposit_materials` fractional-quantity fidelity (the one substantive fix)

Rust `World::deposit_materials` (`combat.rs:286-305`) reads material quantities with
`qty.as_i64().unwrap_or(0)` and the current pool value with `.as_i64().unwrap_or(0)`, storing
`json!(cur + add)` as an integer. TS `[DEPOSIT_MATERIALS]` (`campaign.ts:580-585`) does
`this.#materials[component] = (this.#materials[component] ?? 0) + qty` — adding the raw `number`
verbatim, fractional or not. So a fractional drop (e.g. `2.5`) is **silently dropped to 0** by Rust
(`2.5_f64` has no `as_i64`), diverging from TS which adds `2.5`.

Both sides store the pool as untyped JSON (Rust `materials: Value` `snapshot.rs:176`; TS
`#materials: MaterialMap`, number-valued). **Fix:** read both `qty` and `cur` via `as_f64()` (default
`0.0`) and store `json!(cur + add)` as f64.

**Churn-free (verified):** the differential comparator parses to JS numbers (`5.0 === 5`), TS already
emits floats, and every existing fixture's material pool holds whole numbers — so integer deposits
compare equal and no existing golden diverges. Only the new fractional fixture (B) exercises the
changed path.

### B. Fractional-material-drop differential fixture

A mob authored with a fractional `materialDrops` entry (e.g. `{ ectoplasm: 2.5 }`), defeated by the PC
→ the campaign materials pool receives `2.5`. Assert Rust replay ≡ TS oracle per step (the pool carries
`2.5`, plus the material codex entry). This is a genuine RED→GREEN: before the (A) fix the Rust replay
deposits `0` and the differential fails; after, it deposits `2.5` and passes. Modeled on the existing
`mob-defeat` fixture (which already defeats a mob and deposits materials), with a fractional drop qty.
No encounter formation registered (combat fixture — a formation would offset the rng stream, per the
6c-3 fixture rule). Uses the shared `structuralClone` for captures.

### C. 6c-2 Minors

1. **`scenes.rs::scene_behavior` block-form `#[cfg]`** — restructure to the block form used by
   `exits.rs::exit_behavior` / `formations.rs::formation` (a single `#[cfg(any(test, feature =
   "conformance"))]` `if key == …` block + `let _ = key; None`), so the three sibling registries read
   identically. Behavior unchanged (same values returned).
2. **`Room.enterRoom`/`exitRoom` concrete TSDoc** — the `IRoom` interface docs were updated in 6c-2 to
   mention the new `MechanicCue[]` return, but the concrete `Room` method docs (`room.ts:283-299`) were
   not. Add the return-value documentation.
3. **`fire_scenes` two-pass buffer clarifying comment** — the final 6c-2 review noted the two-pass
   `emitted` buffer (`movement.rs`) is NOT a pure-cosmetic candidate for direct-push: on the
   unregistered-key `Err` path, buffering drops earlier scenes' cues, whereas direct-push would emit
   them before the error. The path is unreachable through the gate (TS resolves a scene `behaviorKey`
   at hydrate, not at fire), and the move aborts either way, so it is unobservable — but "simplifying"
   would be a behavior change, not a cleanup. **Decision: leave the buffer, add a one-line comment**
   explaining it is intentional (no behavior change). No code change beyond the comment.

### D. 6c-3 Minors

4. **`pub mod formations;` placement** — currently sits mid-list in `world/mod.rs` (between
   `mechanics` and `resolve`), breaking alpha order. Move it to its correct alphabetical position.
5. **sees-in-dark generator header typo** — `conformance/fixtures/sees-in-dark.gen.test.ts`'s header
   comment says `LightAversePlayer` where it means `SeesInDarkPlayer` (the class this file actually
   defines; `LightAversePlayer` is combat.gen's class). One-word doc fix.
6. **`spawn.gen` cue-capture `structuralClone` harmonize** — `spawn.gen.test.ts` captures cues via bare
   `drain()` while `sees-in-dark.gen.test.ts` wraps them in `structuralClone`. Cues are fresh objects
   per emission (no live-reference risk either way), but harmonize `spawn.gen` to `structuralClone` for
   consistency. Must regenerate `spawn.*` byte-identical (no golden churn).
7. **`maybe_spawn` missing-`visited`-key defensive fix** — if a hydrated `encounter_table` lacked a
   `visited` array entirely, the current mark push (`get_mut("visited").and_then(as_array_mut)`)
   silently no-ops, so the room would be re-checked on every entry (TS's `Set` always exists).
   Serialized snapshots always carry `visited`, so this is unreachable through the gate, but it is cheap
   insurance: **default-insert an empty `visited` array when absent** before the contains-check + push,
   so the mark always lands. Covered by a Rust unit test (an encounter_table with no `visited` key →
   after `maybe_spawn`, `visited` contains the room).

### E. DRY: extract `viewProjected` to `gen-helpers.ts`

The `viewProjected` helper (projects the full TS ViewModel to the Rust ViewModel subset: drops
top-level `exits`/`lockedDoors`, `status.locationName`, `room.image`) is duplicated verbatim across
~13 conformance generators. Extract it into `conformance/fixtures/gen-helpers.ts` (which already holds
`structuralClone`) and import it in every generator that has a copy. **Every golden must regenerate
byte-identically** — this is a pure DRY refactor, verified by `git status --short conformance/fixtures`
showing no golden/snapshot churn after `pnpm run fixtures:gen`.

## Non-goals / left as-is

- **Fractional formation weight** (`formations.rs` `as_i64()?` drop): the final 6c-3 review confirmed
  this is benign — TS `addFormation` rejects `weight <= 0` and fractional weights do not occur in
  engine-authored tables; the weighted-select fallback exactly mirrors TS `#select()`. No change.
- **`sees_in_dark ≡ light_averse` decoupling**: carried to the eventual sub-plan-6 mob-turn work, not
  6c-4 (it needs a modeling decision, not a cleanup).
- No README change: 6c-4 adds no user-facing mechanic (the `deposit_materials` fix restores existing
  documented behavior for fractional inputs).

## Testing & gate

- **Rust unit tests:** `deposit_materials` with a fractional qty (pool receives the float; a second
  deposit accumulates); `maybe_spawn` with an encounter_table missing `visited` (mark still lands).
- **Differential:** the new fractional-material-drop fixture (GREEN after the (A) fix).
- **No golden churn:** existing goldens unchanged; `git status --short conformance/fixtures` shows only
  the new fractional fixture (plus the `spawn.*` regen, which must be byte-identical). Full gate `pnpm
  run checks:phase3` EXIT 0 + `pnpm run fixtures:stable` EXIT 0.
- **`no_std`:** `alloc::` only; conformance behaviors stay feature-gated.

## Documentation

Per the standing convention, update relevant Rust/TS doc comments (items C.2, D.5) as part of the work.
No README change (see Non-goals).
