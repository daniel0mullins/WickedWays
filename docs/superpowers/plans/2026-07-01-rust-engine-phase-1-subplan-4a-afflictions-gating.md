# Sub-plan 4a — Afflictions, Gating, seesInDark — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the turn-start affliction lifecycle, action gating, immunity, the `seesInDark` seam, and a seeded PRNG foundation to the Rust core — byte-identical to the TS oracle under differential conformance.

**Architecture:** Promote `afflictions` from an inert `serde_json::Value` to a typed, ts-rs-exported `Afflictions` struct; replace the partial `start_turn` stub with the full `onTurnStart` tick (the `[Panic, Fear, Confused]` roll frame); wire a shared block/fizzle gate into the gated commands mirroring TS `attemptAction`; introduce a transient seeded mulberry32 rng on the `World` (seed passed to `replay_commands`); un-defer the `defeated` view field.

**Tech Stack:** Rust (no_std core, `alloc`), serde 1 + serde_json 1, ts-rs 10.1, wasm-pack (nodejs target), vitest 4 (conformance), pnpm 9.15.6.

## Global Constraints

- **no_std core:** `crates/wickedways-core` builds with `--no-default-features`; use `alloc::` paths, never `std::`. New modules add `use alloc::...` as needed.
- **Determinism (invariant 3):** byte-identical output; canonical-JSON exact equality; `BTreeMap`/`BTreeSet` for deterministic order. All randomness goes through `roll(sides: u32, unit: f64) -> u32` in `dice.rs`, fed by the injected rng — never `std` rng, never `f64` ordering hacks.
- **RNG is transient, never serialized** (mirrors TS re-injecting `rng` on load): the `World`'s rng is a runtime field; it is NOT part of `CampaignSnapshot`; `to_snapshot` never emits it.
- **RNG draw order is the contract:** turn-start clear rolls happen `for s in [Panic, Fear, Confused]`, only for *active* clearables; the Confused fizzle roll happens in `gate` only when Confused is active. Reproduce this order exactly.
- **Serialized affliction shape (byte-for-byte vs `Afflictions[SERIALIZE]`):** `active` serializes **only true entries**; `turnsActive`/`shakenOff`/`immunity` carry **clearable keys only**; status keys are **lowercase** (`"panic"`,`"fear"`,`"confused"`,`"ko"`); empty collections are `{}`/`[]`, never absent.
- **Gating ≠ budgeting:** gating identity = "calls `attemptAction`"; budget identity = "registered in `isActionMap`". `Go`/`Take`/`Drop` are gated **and** budgeted; `Equip`/`Unequip` are gated **but budget-free**; `Use`/`Open` are ungated; `Use`'s consume is `withGateSuppressed`.
- **Block vs fizzle observable (vs `character.ts:421-434`):** block → `Err(ProceduralViolation(reason))` (no history/cue/budget); fizzle → record a `{kind:"fumble", action, round}` history entry **and** an `{kind:"action", action:"fumble", actor, sound}` cue unconditionally, tick the budget **only if the method is budgeted**, then skip the action body.
- **Isolation discipline (standing rule):** never modify `packages/seed`. When `fixtures:gen` clobbers a pre-existing fixture you did not intend to change, restore it with `git checkout --`. Commit only intended files.
- **Docs:** per CLAUDE.md, this is a Rust re-authoring of existing TS mechanics — no new game mechanic, so `README.md` needs no change; keep TSDoc/Rust doc-comments accurate.
- **`checks:phase3`** is the whole gate: `cargo build -p wickedways-core --no-default-features && cargo test --workspace && pnpm run bindings:check && pnpm run test:conformance`.

**Base:** `design/rust-engine-core` @ `8c43135` (spec commit; sub-plans 1+2+3a+3b complete).

**TS oracle (authoritative — mirror exactly):** `src/lib/character/afflictions.ts`, `src/lib/status.ts`, `src/lib/character/character.ts` (`attemptAction` 421-434, `recordAction` 515-538, `startTurn` 1075-1085, `#passiveImmunities` 322-327, `seesInDark` 251, `requireVisibleTarget` 266-271, `go` 1048/`move` 1019), `packages/play-runtime/src/viewmodel.ts` (`defeated` = `o.status.includes(Status.KO)` at :77), `src/lib/dice.ts` (`roll`), `conformance/seeded-rng.ts` (mulberry32).

## File Structure

- `crates/wickedways-core/src/world/rng.rs` — **new.** Transient seeded mulberry32 `Rng { a: u32 }` + `next_f64`.
- `crates/wickedways-core/src/world/afflictions.rs` — **new.** `Status` enum, `Afflictions` struct + config + all lifecycle methods (`apply_from_stats`, `on_turn_start`, `gate`, `grant_immunity`).
- `crates/wickedways-core/src/world/mod.rs` — add `rng: Rng` field + `pub mod rng; pub mod afflictions;`; seed helper; reachability unchanged.
- `crates/wickedways-core/src/world/snapshot.rs` — `afflictions: Value` → `Afflictions`; `archetype_immunities: Value` → `Vec<Status>`.
- `crates/wickedways-core/src/world/turn.rs` — rewrite `start_turn`; add `passive_immune` helper.
- `crates/wickedways-core/src/world/command.rs` — `apply_command` passes `cat` to `start_turn`; wires `gate` into the gated arms.
- `crates/wickedways-core/src/world/items_actions.rs` — wire `gate` into `take`/`drop`/`equip`/`unequip`; replace the hardcoded `sees_in_dark`.
- `crates/wickedways-core/src/world/movement.rs` — wire `gate` into `go`.
- `crates/wickedways-core/src/world/view.rs` — add `defeated: Option<bool>` to `ScopeEntity`; occupant/scope entries set it.
- `crates/wickedways-core/src/world/gate.rs` — **new.** `GateVerdict` + `World::gate` + `World::record_fumble` shared helper (or fold into `turn.rs`; keep it one focused file).
- `crates/wickedways-wasm/src/lib.rs` — `replay_commands` gains `seed: u32`; seed the World rng.
- `conformance/turn-movement.test.ts`, `conformance/items-actions.test.ts` — pass a seed to `replay_commands`.
- `conformance/fixtures/*.gen.test.ts` — `viewProjected` stops stripping `defeated`; regenerate goldens.
- `conformance/fixtures/afflictions.gen.test.ts` — **new.** The afflictions fixture generator.
- `conformance/afflictions.test.ts` — **new.** The differential gate.
- `conformance/fixtures/vitest.config.ts` — register the new generator.

---

### Task 1: Seeded RNG foundation

**Files:**
- Create: `crates/wickedways-core/src/world/rng.rs`
- Modify: `crates/wickedways-core/src/world/mod.rs` (add `pub mod rng;`, `rng` field, seed helper, construct in `from_snapshot`), `crates/wickedways-core/src/world/test_support.rs` (construct `rng` in any `World { … }` literal), `crates/wickedways-wasm/src/lib.rs` (`replay_commands` seed param), `conformance/turn-movement.test.ts`, `conformance/items-actions.test.ts`
- Test: `crates/wickedways-core/src/world/rng.rs` (unit), existing conformance gates (regression)

**Interfaces — Produces:**
- `pub struct Rng { a: u32 }` with `pub fn seeded(seed: u32) -> Rng`, `pub fn next_f64(&mut self) -> f64`.
- `World.rng: Rng` (public field); `World::from_snapshot` initializes `rng: Rng::seeded(0)`.
- `replay_commands(start_snapshot_json, commands_json, catalog_json, seed: u32) -> String` (seed is a new 4th param; wasm-bindgen exposes it as a JS `number`).

- [ ] **Step 1: Write the failing test** — `rng.rs` `#[cfg(test)]`. Compute the first 3 mulberry32 outputs for `seed = 1` from `conformance/seeded-rng.ts` by running it once (or hand-derive) and pin them. Example expected values for seed=1 (VERIFY against the TS impl before pinning — run `node -e` with the mulberry32 body): the test asserts the Rust sequence equals the TS sequence bit-for-bit.

```rust
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mulberry32_matches_ts_seed_1() {
        // Values produced by conformance/seeded-rng.ts mulberry32(1) — first 3 draws.
        // VERIFY with: node -e "$(cat conformance/seeded-rng.ts | sed 's/export //'); const r=mulberry32(1); console.log(r(),r(),r())"
        let mut rng = Rng::seeded(1);
        let got = [rng.next_f64(), rng.next_f64(), rng.next_f64()];
        // Replace these with the exact node-printed values (full f64 precision):
        let want = [/* v0 */, /* v1 */, /* v2 */];
        for (g, w) in got.iter().zip(want.iter()) {
            assert_eq!(g.to_bits(), w.to_bits(), "mulberry32 draw mismatch: {g} vs {w}");
        }
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p wickedways-core --no-default-features rng::tests`
Expected: FAIL (module/`Rng` not defined).

- [ ] **Step 3: Implement `rng.rs`**

```rust
//! Transient, seeded PRNG for the World. Bit-exact port of `conformance/seeded-rng.ts`
//! (mulberry32). NOT serialized — the TS engine re-injects `rng` on load; the conformance
//! harness seeds both sides identically via `replay_commands(.., seed)`.

/// mulberry32 state. All ops are u32 wrapping / logical shifts, matching JS `Math.imul`
/// (`wrapping_mul`), `>>>` (`>>` on u32), and `| 0` / `>>> 0` (u32 truncation).
#[derive(Clone, Debug, PartialEq)]
pub struct Rng {
    a: u32,
}

impl Rng {
    pub fn seeded(seed: u32) -> Rng {
        Rng { a: seed }
    }

    /// Advance and return the next float in [0, 1). Equivalent to the TS `mulberry32` closure.
    pub fn next_f64(&mut self) -> f64 {
        self.a = self.a.wrapping_add(0x6d2b_79f5);
        let mut t = (self.a ^ (self.a >> 15)).wrapping_mul(1 | self.a);
        t = (t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t))) ^ t;
        ((t ^ (t >> 14)) as f64) / 4_294_967_296.0
    }
}
```

- [ ] **Step 4: Fill in the pinned values and verify it passes**

Run this to get the exact values, paste them into the test's `want`:
`node -e "$(sed 's/export //' conformance/seeded-rng.ts); const r=mulberry32(1); console.log(r(),r(),r())"`
Then: `cargo test -p wickedways-core --no-default-features rng::tests`
Expected: PASS.

- [ ] **Step 5: Wire the `rng` field into `World`**

In `mod.rs`: add `pub mod rng;` near the other `pub mod` lines; `use rng::Rng;`. Add `pub rng: Rng,` to `struct World`. In `from_snapshot`, add `rng: Rng::seeded(0),` to the `World { … }` literal. Add a helper:

```rust
impl World {
    /// Re-seed the transient rng (conformance harness only; called after `from_snapshot`).
    pub fn seed_rng(&mut self, seed: u32) {
        self.rng = Rng::seeded(seed);
    }
}
```

In `test_support.rs`, add `rng: crate::world::rng::Rng::seeded(0),` to every `World { … }` struct literal (search for `World {`).

- [ ] **Step 6: Add the `seed` param to `replay_commands`**

In `crates/wickedways-wasm/src/lib.rs`, change the `replay_commands` signature to add `seed: u32` and seed the world right after `from_snapshot`:

```rust
#[wasm_bindgen]
pub fn replay_commands(
    start_snapshot_json: &str,
    commands_json: &str,
    catalog_json: &str,
    seed: u32,
) -> Result<String, JsValue> {
    // ... existing parse of snap/commands/catalog ...
    let mut world = World::from_snapshot(snap);
    world.seed_rng(seed);
    // ... rest unchanged ...
}
```

- [ ] **Step 7: Update the two existing conformance gates to pass a seed**

`conformance/turn-movement.test.ts` and `conformance/items-actions.test.ts` call `wasm.replay_commands(start, JSON.stringify(golden.commands), catalogJson)`. Add `, 0` as the 4th arg in both, and update the TS type annotation of the `replay_commands` binding to include `seed: number`. (These fixtures draw no rng, so their goldens are unchanged.)

- [ ] **Step 8: Verify existing gates still green + no_std build**

Run: `cargo build -p wickedways-core --no-default-features && cargo test --workspace && pnpm run test:conformance`
Expected: all PASS; conformance still 14 tests (unchanged goldens).

- [ ] **Step 9: Commit**

```bash
git add crates/wickedways-core/src/world/rng.rs crates/wickedways-core/src/world/mod.rs crates/wickedways-core/src/world/test_support.rs crates/wickedways-wasm/src/lib.rs conformance/turn-movement.test.ts conformance/items-actions.test.ts
git commit -m "feat(core): transient seeded mulberry32 rng + replay_commands seed param (sub-plan 4a)"
```

---

### Task 2: Typed `Afflictions` + `Status` model

**Files:**
- Create: `crates/wickedways-core/src/world/afflictions.rs`
- Modify: `crates/wickedways-core/src/world/mod.rs` (`pub mod afflictions;`), `crates/wickedways-core/src/world/snapshot.rs` (field type changes + ts-rs export list), `crates/wickedways-core/src/stats.rs` or wherever ts-rs bindings are registered (add `Status`, `Afflictions` to the export test)
- Test: `crates/wickedways-core/src/world/afflictions.rs` (serialize-shape + round-trip), `pnpm run bindings:check`

**Interfaces — Produces:**
- `pub enum Status { Panic, Fear, Confused, Ko }` — `#[serde(rename_all = "lowercase")]` → `"panic"`,`"fear"`,`"confused"`,`"ko"`. Ord/PartialOrd derived so it's a `BTreeMap` key.
- `pub struct Afflictions { active: BTreeMap<Status,bool>, turns_active: BTreeMap<Status,i64>, shaken_off: Vec<Status>, immunity: BTreeMap<Status,i64> }` with custom serialize so `active` emits only-true entries.
- `pub struct AfflictionConfig { clear: BTreeMap<Status, ClearOdds>, confused_fail_chance: i64 }`, `pub struct ClearOdds { base: i64, increment: i64 }`, `pub fn default_affliction_config() -> AfflictionConfig`.
- `CharacterSnapshot.afflictions: Afflictions`; `CharacterSnapshot.archetype_immunities: Vec<Status>`.
- `pub const CLEARABLE: [Status; 3] = [Status::Panic, Status::Fear, Status::Confused];`

- [ ] **Step 1: Write the failing serialize-shape test**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normal_character_serializes_empty_shape() {
        let a = Afflictions::default();
        assert_eq!(serde_json::to_value(&a).unwrap(),
            json!({ "active": {}, "turnsActive": {}, "shakenOff": [], "immunity": {} }));
    }

    #[test]
    fn active_serializes_only_true_entries_lowercase() {
        let mut a = Afflictions::default();
        a.set_active(Status::Panic, true);
        a.set_active(Status::Fear, false); // must NOT appear
        let v = serde_json::to_value(&a).unwrap();
        assert_eq!(v["active"], json!({ "panic": true }));
    }

    #[test]
    fn round_trips_through_snapshot_shape() {
        let src = json!({ "active": { "confused": true }, "turnsActive": { "confused": 2 },
            "shakenOff": ["fear"], "immunity": { "panic": 3 } });
        let a: Afflictions = serde_json::from_value(src.clone()).unwrap();
        assert_eq!(serde_json::to_value(&a).unwrap(), src);
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p wickedways-core --no-default-features afflictions::tests`
Expected: FAIL (module not defined).

- [ ] **Step 3: Implement the data model in `afflictions.rs`**

Implement `Status`, `ClearOdds`, `AfflictionConfig` + `default_affliction_config()` (Fear{40,30}, Panic{20,20}, Confused{15,15}, `confused_fail_chance: 50`), and `Afflictions` with a **custom `Serialize`** that emits `active` with only-true entries (or model `active` as it is and use a serialize helper). Simplest faithful approach — store `active` as `BTreeMap<Status,bool>` but serialize via a wrapper:

```rust
use alloc::collections::BTreeMap;
use alloc::vec::Vec;
use serde::{Deserialize, Serialize, Serializer};
#[cfg(feature = "ts")] use ts_rs::TS;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "lowercase")]
pub enum Status { Panic, Fear, Confused, Ko }

pub const CLEARABLE: [Status; 3] = [Status::Panic, Status::Fear, Status::Confused];

#[derive(Clone, Debug, PartialEq, Default)]
pub struct Afflictions {
    active: BTreeMap<Status, bool>,
    turns_active: BTreeMap<Status, i64>,
    shaken_off: Vec<Status>,
    immunity: BTreeMap<Status, i64>,
}

// Serialize `active` with only-true entries; everything else straight through.
impl Serialize for Afflictions {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let active_true: BTreeMap<Status, bool> =
            self.active.iter().filter(|(_, &on)| on).map(|(&k, &v)| (k, v)).collect();
        let mut st = s.serialize_struct("Afflictions", 4)?;
        st.serialize_field("active", &active_true)?;
        st.serialize_field("turnsActive", &self.turns_active)?;
        st.serialize_field("shakenOff", &self.shaken_off)?;
        st.serialize_field("immunity", &self.immunity)?;
        st.end()
    }
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AfflictionsWire {
    #[serde(default)] active: BTreeMap<Status, bool>,
    #[serde(default)] turns_active: BTreeMap<Status, i64>,
    #[serde(default)] shaken_off: Vec<Status>,
    #[serde(default)] immunity: BTreeMap<Status, i64>,
}
impl<'de> Deserialize<'de> for Afflictions {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let w = AfflictionsWire::deserialize(d)?;
        Ok(Afflictions { active: w.active, turns_active: w.turns_active,
            shaken_off: w.shaken_off, immunity: w.immunity })
    }
}
```

> **ts-rs note:** because `Afflictions` uses a hand-written `Serialize`/`Deserialize`, give it a manual `#[cfg(feature="ts")] impl TS` or a `#[derive(TS)]` on a mirror type — whichever keeps `bindings:check` producing `{ active: Record<..>, turnsActive: Record<..>, shakenOff: Status[], immunity: Record<..> }`. Verify the emitted `.ts` matches TS `AfflictionsSnapshot` (`src/lib/serialization/types.ts`). If a hand impl is fiddly, model `active` as a plain field and instead filter false entries at the `World` boundary before serialize — but the differential gate is the authority on shape.

Add accessor/mutator methods used by tests + later tasks: `set_active`, `is_active`, `list()`, plus the lifecycle methods stubbed (filled in Task 3/4).

- [ ] **Step 4: Verify shape tests pass**

Run: `cargo test -p wickedways-core --no-default-features afflictions::tests`
Expected: PASS.

- [ ] **Step 5: Change the snapshot field types**

In `snapshot.rs`, change:
```rust
    pub archetype_immunities: Vec<crate::world::afflictions::Status>,
    pub afflictions: crate::world::afflictions::Afflictions,
```
Add `pub mod afflictions;` to `mod.rs`. Fix any construction sites (`test_support.rs`, inline snapshot fixtures in `snapshot.rs` tests) that built these as `Value` — replace `serde_json::json!({...})` / `Value::Array` with `Afflictions::default()` and `Vec::new()`. The existing JSON fixtures with `"afflictions":{"active":{},...}` and `"archetypeImmunities":[]` still deserialize into the typed forms (verify).

- [ ] **Step 6: Regenerate + check bindings**

Run: `pnpm run bindings:check`
Expected: `Afflictions.ts` + `Status.ts` appear (or update) and match the TS `AfflictionsSnapshot`/`Status` shape; git diff is clean after regen (commit the new binding files). If drift, fix the Rust `#[ts(...)]`/serde attrs until the emitted TS matches.

- [ ] **Step 7: Full build + existing gates**

Run: `cargo build -p wickedways-core --no-default-features && cargo test --workspace && pnpm run test:conformance`
Expected: PASS (the type promotion is byte-identical for existing snapshots).

- [ ] **Step 8: Commit**

```bash
git add crates/wickedways-core/src/world/afflictions.rs crates/wickedways-core/src/world/mod.rs crates/wickedways-core/src/world/snapshot.rs crates/wickedways-core/src/world/test_support.rs generated/bindings
git commit -m "feat(core): typed Afflictions + Status model (promote from inert Value) (sub-plan 4a)"
```

---

### Task 3: `apply_from_stats` + `on_turn_start` tick (the RNG frame)

**Files:**
- Modify: `crates/wickedways-core/src/world/afflictions.rs` (lifecycle methods), `crates/wickedways-core/src/world/turn.rs` (rewrite `start_turn`, add `passive_immune` helper), `crates/wickedways-core/src/world/command.rs` (`apply_command` StartTurn passes `cat`)
- Test: `afflictions.rs` (threshold + roll-order + immunity unit tests), `turn.rs` (start_turn integration)

**Interfaces — Consumes:** `Rng` (Task 1), `Status`/`Afflictions`/`AfflictionConfig`/`CLEARABLE` (Task 2), `roll` (`dice.rs`), `effective_stat` (`resolve.rs`).
**Produces:**
- `Afflictions::apply_from_stats(&mut self, health: i64, sanity: i64, energy: i64, passive_immune: &BTreeSet<Status>)`
- `Afflictions::on_turn_start(&mut self, health: i64, sanity: i64, energy: i64, passive_immune: &BTreeSet<Status>, config: &AfflictionConfig, rng: &mut Rng)`
- `World::start_turn(&mut self, actor: &CharacterId, cat: &Catalog)` (signature gains `cat`)
- `World::passive_immune(&self, actor: &CharacterId, cat: &Catalog) -> BTreeSet<Status>`

- [ ] **Step 1: Write failing `apply_from_stats` threshold tests**

```rust
#[test]
fn ko_when_health_le_zero_clears_clearables() {
    let mut a = Afflictions::default();
    a.set_active(Status::Panic, true);
    a.apply_from_stats(0, 0, 0, &BTreeSet::new());
    assert!(a.is_active(Status::Ko));
    assert!(!a.is_active(Status::Panic)); // cleared under KO
}
#[test]
fn panic_when_sanity_le_zero_fear_in_band() {
    let mut a = Afflictions::default();
    a.apply_from_stats(5, 0, 5, &BTreeSet::new());
    assert!(a.is_active(Status::Panic));
    let mut b = Afflictions::default();
    b.apply_from_stats(5, 3, 5, &BTreeSet::new()); // 0<sanity<5 → Fear
    assert!(b.is_active(Status::Fear) && !b.is_active(Status::Panic));
}
#[test]
fn confused_energy_bands_and_immunity_hysteresis() {
    let mut a = Afflictions::default();
    a.apply_from_stats(5, 5, 0, &BTreeSet::new()); // energy<=0 → Confused
    assert!(a.is_active(Status::Confused));
    a.apply_from_stats(5, 5, 2, &BTreeSet::new()); // energy>1 → clear
    assert!(!a.is_active(Status::Confused));
}
#[test]
fn passive_immunity_clears_episode() {
    let mut a = Afflictions::default();
    let immune: BTreeSet<Status> = [Status::Panic].into_iter().collect();
    a.apply_from_stats(5, 0, 5, &immune); // sanity<=0 but immune → no Panic
    assert!(!a.is_active(Status::Panic));
}
```

- [ ] **Step 2: Run to verify fail** — `cargo test -p wickedways-core --no-default-features afflictions::tests::` → FAIL.

- [ ] **Step 3: Implement `apply_from_stats` + helpers** (mirror `afflictions.ts:95-130`)

```rust
impl Afflictions {
    fn immune(&self, s: Status, passive: &BTreeSet<Status>) -> bool {
        passive.contains(&s) || self.immunity.get(&s).copied().unwrap_or(0) > 0
    }
    fn clear_episode(&mut self, s: Status) {
        self.active.insert(s, false);
        self.shaken_off.retain(|x| *x != s);
        self.turns_active.insert(s, 0);
    }
    fn resolve(&mut self, s: Status, below: bool, passive: &BTreeSet<Status>) {
        if self.immune(s, passive) || !below { self.clear_episode(s); return; }
        let v = !self.shaken_off.contains(&s);
        self.active.insert(s, v);
    }
    pub fn apply_from_stats(&mut self, health: i64, sanity: i64, energy: i64,
                            passive: &BTreeSet<Status>) {
        if health <= 0 {
            self.active.insert(Status::Ko, true);
            for s in CLEARABLE { self.clear_episode(s); }
            return;
        }
        self.active.insert(Status::Ko, false);
        self.resolve(Status::Panic, sanity <= 0, passive);
        self.resolve(Status::Fear, sanity > 0 && sanity < 5, passive);
        if energy <= 0 {
            self.resolve(Status::Confused, true, passive);
        } else if energy > 1 {
            self.resolve(Status::Confused, false, passive);
        } else if self.immune(Status::Confused, passive) {
            self.clear_episode(Status::Confused); // (0,1] hold band + immunity hysteresis
        }
    }
}
```

- [ ] **Step 4: Verify threshold tests pass** — `cargo test … afflictions::tests` → PASS.

- [ ] **Step 5: Write failing `on_turn_start` roll-order test** (seeded rng; two active clearables prove `[Panic, Fear]` order)

```rust
#[test]
fn on_turn_start_rolls_clearables_in_panic_fear_confused_order() {
    // Seed chosen so the first draw clears Panic and the second does not clear Fear
    // (or vice versa) — pick a seed and assert turns_active increments for BOTH active
    // clearables and that exactly 2 draws were consumed (Confused inactive → no draw).
    let mut a = Afflictions::default();
    a.set_active(Status::Panic, true);
    a.set_active(Status::Fear, true);
    let cfg = default_affliction_config();
    let mut rng = Rng::seeded(1);
    a.on_turn_start(10, /*sanity*/ 0, /*energy*/ 5, &BTreeSet::new(), &cfg, &mut rng);
    assert_eq!(a.turns_active_of(Status::Panic), 1);
    assert_eq!(a.turns_active_of(Status::Fear), 1);
    // Confused was inactive → its counter stays 0 and no draw was taken for it.
    assert_eq!(a.turns_active_of(Status::Confused), 0);
}
#[test]
fn on_turn_start_decrements_immunity_after_reconcile() {
    let mut a = Afflictions::default();
    a.grant_immunity(&[Status::Panic], 2); // Task 4 provides grant_immunity
    let cfg = default_affliction_config();
    let mut rng = Rng::seeded(1);
    a.on_turn_start(10, 0, 5, &BTreeSet::new(), &cfg, &mut rng);
    assert_eq!(a.immunity_of(Status::Panic), 1); // 2 → 1
}
```

(If `grant_immunity` is not yet present, set `immunity` directly via a test-only setter and move the immunity-decrement test to Task 4.)

- [ ] **Step 6: Implement `on_turn_start`** (mirror `afflictions.ts:132-151`)

```rust
impl Afflictions {
    pub fn on_turn_start(&mut self, health: i64, sanity: i64, energy: i64,
                         passive: &BTreeSet<Status>, config: &AfflictionConfig,
                         rng: &mut Rng) {
        for s in CLEARABLE {
            if !self.active.get(&s).copied().unwrap_or(false) { continue; }
            let turns = self.turns_active.get(&s).copied().unwrap_or(0) + 1;
            self.turns_active.insert(s, turns);
            let odds = &config.clear[&s];
            let p = (odds.base + odds.increment * (turns - 1)).clamp(0, 100);
            if (roll(100, rng.next_f64()) as i64) <= p { self.shaken_off.push(s); }
        }
        self.apply_from_stats(health, sanity, energy, passive);
        let keys: Vec<Status> = self.immunity.keys().copied().collect();
        for s in keys {
            let remaining = self.immunity[&s];
            if remaining <= 1 { self.immunity.remove(&s); }
            else { self.immunity.insert(s, remaining - 1); }
        }
    }
}
```

> Note: `shaken_off` is a set in TS; here it is a `Vec`. Guard against duplicate pushes if a status could roll twice in one episode (it cannot within one `on_turn_start`, but `clear_episode` removes it, so a fresh episode re-adds cleanly). Keep `shaken_off` deduped; serialize order = push order (differential gate confirms; comparator may sort it like `equippedNames` if it diverges).

- [ ] **Step 7: Rewrite `World::start_turn`** — delete the JSON-mutation stub entirely.

```rust
pub fn start_turn(&mut self, actor: &CharacterId, cat: &Catalog) {
    // Effective stats + passive immunities computed first (immutable borrows).
    let health = self.effective_stat(actor, StatType::Health, cat);
    let sanity = self.effective_stat(actor, StatType::Sanity, cat);
    let energy = self.effective_stat(actor, StatType::Energy, cat);
    let passive = self.passive_immune(actor, cat);
    let config = default_affliction_config();
    // Disjoint mutable borrows of self.characters and self.rng.
    let rng = &mut self.rng;
    if let Some(c) = self.characters.get_mut(actor) {
        c.actions_this_round = 0;
        c.afflictions.on_turn_start(health, sanity, energy, &passive, &config, rng);
    }
    // character events + DISPATCH_TURN("start"): no-ops until sub-plan 6.
}
```

Add the `passive_immune` helper in `turn.rs` (mirror `character.ts:322-327` — equipped, non-broken items' `immunities` ∪ `archetype_immunities`):

```rust
pub fn passive_immune(&self, actor: &CharacterId, cat: &Catalog) -> BTreeSet<Status> {
    let mut set = BTreeSet::new();
    if let Some(ch) = self.characters.get(actor) {
        for item_id in ch.equipment.values() {
            if let Some(snap) = self.items.get(item_id) {
                if let Ok(resolved) = resolve_item(snap, cat) {
                    if resolved.is_broken { continue; }
                    // `immunities` is an inert Value on the descriptor — parse to Vec<Status>.
                    if let Ok(list) = serde_json::from_value::<Vec<Status>>(resolved.immunities.clone()) {
                        for s in list { set.insert(s); }
                    }
                }
            }
        }
        for s in &ch.archetype_immunities { set.insert(*s); }
    }
    set
}
```

> Confirm `ResolvedItem` exposes `immunities` (a `Value`) and `is_broken`; if `immunities` is not on `ResolvedItem`, read it from the catalog descriptor via `cat.items.get(&behavior_key)`. Match the TS filter (`!equipped || isBroken || !immunities` → skip) exactly.

- [ ] **Step 8: Update `apply_command` StartTurn arm** to pass `cat`: `Command::StartTurn => { world.start_turn(&actor, cat); Ok(()) }`. Update all other `start_turn(` call sites (tests) to pass a catalog (`&Catalog::default()` where no items).

- [ ] **Step 9: Verify all tests pass** — `cargo test -p wickedways-core --no-default-features` → PASS.

- [ ] **Step 10: Commit**

```bash
git add crates/wickedways-core/src/world/afflictions.rs crates/wickedways-core/src/world/turn.rs crates/wickedways-core/src/world/command.rs
git commit -m "feat(core): affliction turn-start tick — clear rolls + apply_from_stats + immunity (sub-plan 4a)"
```

---

### Task 4: `grant_immunity` + `use`-path wiring

**Files:**
- Modify: `crates/wickedways-core/src/world/afflictions.rs` (`grant_immunity`), `crates/wickedways-core/src/world/items_actions.rs` (`use_item` grants before consuming)
- Test: `afflictions.rs` (grant semantics), `items_actions.rs` (use grants + consumes)

**Interfaces — Produces:** `Afflictions::grant_immunity(&mut self, statuses: &[Status], turns: i64)`.

- [ ] **Step 1: Write failing grant tests** (mirror `afflictions.ts:177-190`)

```rust
#[test]
fn grant_immunity_refreshes_to_max_and_resets_episode() {
    let mut a = Afflictions::default();
    a.set_active(Status::Panic, true);
    a.grant_immunity(&[Status::Panic], 3);
    assert_eq!(a.immunity_of(Status::Panic), 3);
    assert!(!a.is_active(Status::Panic)); // episode reset
    a.grant_immunity(&[Status::Panic], 1);
    assert_eq!(a.immunity_of(Status::Panic), 3); // max(3,1)
}
#[test]
fn grant_immunity_ignores_ko() {
    let mut a = Afflictions::default();
    a.grant_immunity(&[Status::Ko], 5);
    assert_eq!(a.immunity_of(Status::Ko), 0);
}
```

- [ ] **Step 2: Run to verify fail** — FAIL.

- [ ] **Step 3: Implement `grant_immunity`**

```rust
pub fn grant_immunity(&mut self, statuses: &[Status], turns: i64) {
    for &s in statuses {
        if s == Status::Ko { continue; }
        let cur = self.immunity.get(&s).copied().unwrap_or(0);
        self.immunity.insert(s, cur.max(turns));
        self.clear_episode(s);
    }
}
```

- [ ] **Step 4: Verify grant tests pass** — PASS.

- [ ] **Step 5: Write failing `use_item` grant test** — a usable item whose descriptor has `grantsImmunity: { statuses:["panic"], turns: 2 }`; after `use_item` the actor has immunity[Panic]==2 and the item is consumed (removed + drop history, per 3b).

```rust
#[test]
fn use_item_with_grants_immunity_grants_then_consumes() {
    // Build a world with the actor holding a usable "tonic" whose catalog descriptor
    // carries grantsImmunity {statuses:[panic], turns:2}. Call use_item.
    // Assert: actor.afflictions.immunity[Panic]==2 AND the tonic left inventory.
    // (See items_actions.rs existing use_item tests for the world/cat scaffold.)
}
```

- [ ] **Step 6: Wire `use_item`** — before the consume tail, if the resolved descriptor's `grants_immunity` is present, parse `{ statuses: Vec<Status>, turns: i64 }` and call `grant_immunity` on the actor's afflictions:

```rust
// in use_item, after usable check, before consume_from_inventory:
if let Ok(gi) = serde_json::from_value::<GrantsImmunity>(resolved.grants_immunity.clone()) {
    if let Some(ch) = self.characters.get_mut(actor) {
        ch.afflictions.grant_immunity(&gi.statuses, gi.turns);
    }
}
// where: #[derive(Deserialize)] struct GrantsImmunity { statuses: Vec<Status>, turns: i64 }
```

> `grants_immunity` is `json!(null)` when absent, so `from_value::<GrantsImmunity>` fails cleanly → skip. Confirm the TS `grantsImmunity` shape in the item descriptor (`inventory.ts:622-626`) is `{ statuses, turns }` and match field names.

- [ ] **Step 7: Verify + full suite** — `cargo test -p wickedways-core --no-default-features` → PASS.

- [ ] **Step 8: Commit**

```bash
git add crates/wickedways-core/src/world/afflictions.rs crates/wickedways-core/src/world/items_actions.rs
git commit -m "feat(core): grant_immunity + use-path grantsImmunity wiring (sub-plan 4a)"
```

---

### Task 5: Action gating (block/fizzle) wired into commands

**Files:**
- Create: `crates/wickedways-core/src/world/gate.rs` (`GateVerdict`, `World::gate`, `World::record_fumble`)
- Modify: `crates/wickedways-core/src/world/mod.rs` (`pub mod gate;`), `movement.rs` (`go` gates), `items_actions.rs` (`take`/`drop`/`equip`/`unequip` gate), `command.rs` (dispatch already passes actor/cues — no change beyond calling the gated mutators)
- Test: `gate.rs` (verdict precedence + fizzle observable), and per-mutator gate tests

**Interfaces — Produces:**
- `pub enum GateVerdict { Allow, Fizzle, Block(String) }`
- `World::gate(&mut self, actor: &CharacterId, is_move: bool) -> GateVerdict` (draws rng only for the Confused branch)
- `World::record_fumble(&mut self, actor: &CharacterId, action: &str, budgeted: bool, cues: &mut Vec<PresentationCue>)` — pushes a `{kind:"fumble", action, round}` history entry, emits an `action`/`fumble` cue, and ticks the budget iff `budgeted`.

- [ ] **Step 1: Write failing gate-precedence tests**

```rust
#[test]
fn gate_ko_blocks_everything() {
    let mut w = /* world; actor KO */;
    assert!(matches!(w.gate(&actor, false), GateVerdict::Block(_)));
    assert!(matches!(w.gate(&actor, true), GateVerdict::Block(_)));
}
#[test]
fn gate_panic_blocks_non_move_allows_move() {
    // actor Panic: gate(false) → Block; gate(true) → Allow
}
#[test]
fn gate_fear_blocks_move_allows_non_move() {
    // actor Fear: gate(true) → Block; gate(false) → Allow
}
#[test]
fn gate_confused_fizzles_per_roll() {
    // actor Confused, seed chosen so roll(100)<=50 → Fizzle; another seed → Allow
}
```

- [ ] **Step 2: Run to verify fail** — FAIL.

- [ ] **Step 3: Implement `gate.rs`** (mirror `afflictions.ts:158-175` + `character.ts:421-434`, `515-538`)

```rust
pub enum GateVerdict { Allow, Fizzle, Block(alloc::string::String) }

impl World {
    pub fn gate(&mut self, actor: &CharacterId, is_move: bool) -> GateVerdict {
        let (ko, panic, fear, confused) = match self.characters.get(actor) {
            Some(c) => (c.afflictions.is_active(Status::Ko),
                        c.afflictions.is_active(Status::Panic),
                        c.afflictions.is_active(Status::Fear),
                        c.afflictions.is_active(Status::Confused)),
            None => return GateVerdict::Allow,
        };
        if ko { return GateVerdict::Block("Cannot act while KO'd.".into()); }
        if panic && !is_move { return GateVerdict::Block("Panicked: can only move.".into()); }
        if fear && is_move { return GateVerdict::Block("Too afraid to move.".into()); }
        if confused {
            let cfg = default_affliction_config();
            if (roll(100, self.rng.next_f64()) as i64) <= cfg.confused_fail_chance {
                return GateVerdict::Fizzle;
            }
        }
        GateVerdict::Allow
    }

    pub fn record_fumble(&mut self, actor: &CharacterId, action: &str, budgeted: bool,
                         cues: &mut Vec<PresentationCue>) {
        let round = self.campaign.round;
        if let Some(c) = self.characters.get_mut(actor) {
            c.history.push(/* ActionHistoryEntry fumble { action, round } — match history.rs */);
            if budgeted { c.actions_this_round += 1; }
        }
        cues.push(/* PresentationCue::Action { action: "fumble", actor{id,name}, sound } */);
        // NOTE: match the exact cue + history shapes the existing take/drop paths emit.
    }
}
```

> Pin the `fumble` history variant + the `action`/`fumble` cue shape against `history.rs`/`presentation.rs` and the existing `record`-equivalent in `items_actions.rs`. The action label is the TS method name — for our commands use the TS names: `Go`→`"go"`, `Take`→`"takeFromLootBox"`, `Drop`→`"removeFromInventory"`, `Equip`→`"equip"`, `Unequip`→`"unequip"` (VERIFY each against `callingFn.name` at the corresponding `attemptAction(this.X, ..)` site).

- [ ] **Step 4: Verify gate tests pass** — PASS.

- [ ] **Step 5: Wire the gate into each mutator** — at the TOP of each, before the existing body:

```rust
// go (movement.rs), is_move = true, budgeted:
match self.gate(actor, true) {
    GateVerdict::Block(r) => return Err(ProceduralViolation(r)),
    GateVerdict::Fizzle => { self.record_fumble(actor, "go", true, cues); return Ok(()); }
    GateVerdict::Allow => {}
}
// take (items_actions.rs), is_move = false, budgeted → record_fumble(.., "takeFromLootBox", true, ..)
// drop_item, is_move = false, budgeted → "removeFromInventory", true
// equip, is_move = false, NOT budgeted → "equip", false
// unequip, is_move = false, NOT budgeted → "unequip", false
// use_item, open: NO gate (unchanged).
```

Take returns `LootId` — on fizzle it must return `Ok`-equivalent without a LootId. Adjust `take`'s signature handling: the fizzle path should short-circuit before the loot lookup. Since `apply_command`'s `Take` arm uses the returned `LootId` to update `opened`, have `take` return `Result<Option<LootId>, _>` OR keep `Result<LootId,_>` and handle fizzle by returning a sentinel — cleanest: change `take` to `Result<Option<LootId>, ProceduralViolation>` (None on fizzle) and update the `apply_command` `Take` arm to `if let Some(lid) = ... { opened.insert(lid.0); }`.

- [ ] **Step 6: Write per-command gate integration tests** — e.g. a Panicked actor's `Take` returns `Err`; a Confused actor's `Take` (seed→fizzle) records a fumble, ticks budget, and does not move the item; a Confused `Equip` (seed→fizzle) records a fumble but does NOT tick budget.

- [ ] **Step 7: Verify + full suite** — `cargo test --workspace` → PASS.

- [ ] **Step 8: Commit**

```bash
git add crates/wickedways-core/src/world/gate.rs crates/wickedways-core/src/world/mod.rs crates/wickedways-core/src/world/movement.rs crates/wickedways-core/src/world/items_actions.rs crates/wickedways-core/src/world/command.rs
git commit -m "feat(core): affliction action gating (block/fizzle) wired into commands (sub-plan 4a)"
```

---

### Task 6: `seesInDark` seam + `defeated` view un-deferral

**Files:**
- Modify: `crates/wickedways-core/src/world/items_actions.rs` (`sees_in_dark`), `crates/wickedways-core/src/world/view.rs` (`ScopeEntity.defeated` + occupant/scope wiring), `conformance/fixtures/turn-movement.gen.test.ts`, `conformance/fixtures/items-projection.gen.test.ts`, `conformance/fixtures/items-actions.gen.test.ts` (stop stripping `defeated`)
- Test: `view.rs` (defeated), regenerate all goldens

**Interfaces — Produces:** `World::sees_in_dark(&self, actor: &CharacterId) -> bool` (returns `false` in 4a); `ScopeEntity.defeated: Option<bool>`.

- [ ] **Step 1: Write failing `defeated` view test** — a world with an occupant who is KO → that occupant's `ScopeEntity.defeated == Some(true)`; a healthy occupant → `Some(false)`; an item entity → `None`.

- [ ] **Step 2: Run to verify fail** — FAIL.

- [ ] **Step 3: Add `defeated` to `ScopeEntity` + `sees_in_dark`**

In `view.rs`, add to `ScopeEntity`:
```rust
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub defeated: Option<bool>,
```
Add a helper `World::is_ko(&self, id: &CharacterId) -> bool` = `characters[id].afflictions.is_active(Status::Ko)`. In the occupant builder set `defeated: Some(self.is_ko(id))`; in the loot/item/key/container builders set `defeated: None`. The `scope` occupant entries must also set `defeated: Some(...)` (they mirror the occupant entities — check how `scope` reuses/rebuilds occupants and match `viewmodel.ts` where scope occupants carry defeated).

In `items_actions.rs`, replace `let sees_in_dark = false;` with `let sees_in_dark = self.sees_in_dark(actor);`, and add:
```rust
impl World {
    /// Base characters never see in the dark. Mob `lightAverse` override → sub-plan 4c.
    pub fn sees_in_dark(&self, _actor: &CharacterId) -> bool { false }
}
```

- [ ] **Step 4: Verify view test passes** — PASS.

- [ ] **Step 5: Stop stripping `defeated` in the generators** — in each of the three `*.gen.test.ts`, the `projectScopeEntity` helper strips `defeated`. Change it to KEEP `defeated` (remove the destructure that drops it). The Rust view now emits `defeated` on occupants (Some) and omits it elsewhere (None → skipped), matching TS occupants (which set `defeated`) and TS items (which don't).

- [ ] **Step 6: Regenerate all goldens**

Run: `pnpm run fixtures:gen`
Then `git status`: the only changed committed fixtures should be the goldens/snapshots whose occupants now carry `defeated` (turn-movement, items-projection, items-actions). Confirm the diff is ONLY added `defeated` fields on occupant/scope entities — no other change. Restore anything unexpected with `git checkout --`. Never touch `packages/seed`.

- [ ] **Step 7: bindings + full gate**

Run: `pnpm run bindings:check && pnpm run checks:phase3`
Expected: `ScopeEntity.ts` gains `defeated?: boolean`; all gates green.

- [ ] **Step 8: Commit**

```bash
git add crates/wickedways-core/src/world/view.rs crates/wickedways-core/src/world/items_actions.rs generated/bindings conformance/fixtures/turn-movement.gen.test.ts conformance/fixtures/items-projection.gen.test.ts conformance/fixtures/items-actions.gen.test.ts conformance/fixtures/*.golden.json conformance/fixtures/*.start.snapshot.json
git commit -m "feat(core): seesInDark seam + defeated view un-deferral; regen goldens (sub-plan 4a)"
```

---

### Task 7: Conformance — afflictions fixture generator

**Files:**
- Create: `conformance/fixtures/afflictions.gen.test.ts`
- Modify: `conformance/fixtures/vitest.config.ts` (register), `package.json` (no change expected)
- Create (committed by the generator): `conformance/fixtures/afflictions.{start.snapshot,catalog,golden}.json`

**Interfaces — Produces:** an afflictions golden `{ seed, commands, steps:[{command, cues, snapshot, view}] }` driven directly against the engine oracle, seeded with `mulberry32(SEED)`.

- [ ] **Step 1: Build the campaign + genesis state** — mirror `items-actions.gen.test.ts` structure. Use `import { mulberry32 } from "../seeded-rng.ts"` and `const SEED = <pick>; rng: mulberry32(SEED)`. Author a campaign with: an active player whose starting stats put `sanity=0` (→Panic) and `energy=0` (→Confused) after the first `apply_from_stats`; a second player seeded with `health<=0` (→KO); a usable item whose descriptor carries `grantsImmunity: { statuses:["panic"], turns: 2 }`. Serialize the start snapshot BEFORE any `startTurn` (so no rng is drawn pre-snapshot).

- [ ] **Step 2: Drive the stream + capture** — command stream (engine-direct, per the established pattern): `startTurn` (ticks afflictions, rolls clears) repeated across several turns to exercise `turnsActive` growth + a clear (`shakenOff`) + immunity decrement; a `use` of the immunity item (grant→clear); gated actions under affliction: a `go`/`take` that BLOCKS (Panic non-move / Fear move / KO), and a `take` that FIZZLES (Confused, seed-dependent). Capture `{command, cues, snapshot, view}` per step (view via the un-stripped `viewProjected` — `defeated` now present). Maintain `opened` as before.

- [ ] **Step 3: Self-validate (throw if any false)** — assert the golden contains: ≥1 step with an active affliction in `snapshot.afflictions.active`; ≥1 `shakenOff` entry; an immunity grant that cleared an episode (immunity>0 then active=false); ≥1 `block` (a `ProceduralViolation` thrown — assert via `expect().toThrow`, not a recorded step); ≥1 `fumble` cue/history (fizzle); ≥1 occupant with `defeated:true` (KO). Record `SEED` in the golden.

- [ ] **Step 4: Register + generate + isolate**

Add `"conformance/fixtures/afflictions.gen.test.ts"` to `conformance/fixtures/vitest.config.ts` `include`. Run `pnpm run fixtures:gen`. `git status` must show ONLY the new `afflictions.*` files (+ the config edit). Restore any clobbered pre-existing fixture with `git checkout --`. Run `fixtures:gen` twice → golden byte-stable.

- [ ] **Step 5: Commit**

```bash
git add conformance/fixtures/afflictions.gen.test.ts conformance/fixtures/vitest.config.ts conformance/fixtures/afflictions.start.snapshot.json conformance/fixtures/afflictions.catalog.json conformance/fixtures/afflictions.golden.json
git commit -m "test(conformance): afflictions command stream + golden (sub-plan 4a)"
```

---

### Task 8: Differential afflictions gate + full verify

**Files:**
- Create: `conformance/afflictions.test.ts`
- Modify: `conformance/canonical-json.ts` (only if `shakenOff` order diverges — sanctioned sort, like `equippedNames`)
- Test: `pnpm run checks:phase3`

**Interfaces — Consumes:** `replay_commands(start, commands, catalog, seed)` (Task 1), the committed `afflictions.*` fixtures (Task 7), `canonicalize`.

- [ ] **Step 1: Write the gate** — mirror `conformance/items-actions.test.ts`: load `afflictions.{start.snapshot,catalog,golden}.json`, call `wasm.replay_commands(start, JSON.stringify(golden.commands), catalogJson, golden.seed)`, assert `out.length === golden.steps.length`, per step `canonicalize`-compare `{cues, snapshot, view}`.

- [ ] **Step 2: Run** — `pnpm run wasm:build && pnpm run test:conformance`. Expected: PASS (15 tests now).

- [ ] **Step 3: If it fails on `snapshot.afflictions.shakenOff` array ORDER only** — `shakenOff` is an unordered set; add `"shakenOff"` to the `canonical-json.ts` sort list (same treatment as `equippedNames`). Document it. Do NOT sort any semantically-ordered field.

- [ ] **Step 4: If any OTHER field diverges** — it is a real fidelity bug in Tasks 2-5 (wrong roll order/count, wrong threshold, wrong cue/history shape, wrong budget tick, wrong `active`/`immunity`/`defeated`). Diagnose the exact step + field (Rust vs golden), fix in the **Rust source** (note loudly, cite the TS oracle), rebuild wasm, re-run. Do NOT loosen the comparator or edit the golden. A diverging number is a real value bug (not an i64/bigint wire issue).

- [ ] **Step 5: Full gate** — `pnpm run checks:phase3` end-to-end. All green. `git status` clean.

- [ ] **Step 6: Commit**

```bash
git add conformance/afflictions.test.ts conformance/canonical-json.ts
git commit -m "test(conformance): afflictions differential gate (sub-plan 4a)"
```

---

## Self-Review

**Spec coverage:** typed `Afflictions`/`Status` (T2) ✓; `start_turn` rewrite / `onTurnStart` roll frame (T3) ✓; `apply_from_stats` thresholds + hysteresis (T3) ✓; immunity decrement (T3) + `grant_immunity` + use-path `grantsImmunity` (T4) ✓; `passiveImmune` from archetype ∪ equipped `immunities` (T3) ✓; action gating block/fizzle + per-command policy (T5) ✓; `seesInDark` seam (T6) ✓; `defeated` view un-deferral (T6) ✓; seeded PRNG foundation + `replay_commands` seed (T1) ✓; conformance fixture + gate (T7, T8) ✓. Non-goals (attack/takeDamage/durability→4b; mobs/escape/encounters/room-BFS→4c; mechanic hooks→6; `is_lit` equipped-light widening) are in no task ✓.

**Placeholder scan:** the two intentionally-empty spots are the mulberry32 `want` values (T1 Step 1/4 — filled from a `node` command shown in-step) and the fumble history/cue shapes (T5 Step 3 — pinned against `history.rs`/`presentation.rs`, which the implementer must read). Both are marked with the exact command/file to resolve them, not left vague. No "add error handling"-style gaps.

**Type consistency:** `Status`/`Afflictions`/`AfflictionConfig`/`CLEARABLE` (T2) used consistently in T3-T6; `Rng`/`seed`/`next_f64` (T1) used in T3/T5; `start_turn(&mut self, actor, cat)` new signature (T3) rippled to `apply_command` (T3 Step 8) and tests; `GateVerdict`/`gate`/`record_fumble` (T5) consistent; `take` return type change to `Option<LootId>` (T5 Step 5) rippled to `apply_command`. `replay_commands` 4-arg (T1) rippled to both existing gates (T1 Step 7) and the new gate (T8).

**Sequencing (green at each task):** T1 (rng + replay sig) updates both existing gates atomically; T2 (type promotion) is byte-identical; T6 (defeated) regenerates the three affected goldens atomically; every task ends green. T3→T4 order lets T3's immunity-decrement test defer to T4 if `grant_immunity` isn't present yet (noted in T3 Step 5).
