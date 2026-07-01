# Sub-plan 4b: Combat Damage — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the TS engine's combat damage (`attack`, `takeDamage`, mitigation, weapon/armor durability, `#reconcile`, KO-via-damage) to the Rust core, byte-verified by the differential conformance gate.

**Architecture:** A new `world/combat.rs` adds `attack` (wired to a new `Command::Attack`) and internal `take_damage`/`reconcile`/`on_knock_out`/`set_durability`, reusing the existing `damage.rs` mitigation formula and the 4a `gate`/`record_fumble`. Base stats are promoted `i64 → f64` (spec §1) so fractional post-damage stats serialize and threshold-compare identically to the TS oracle — a change proven transparent to all existing goldens because the conformance comparator parses JSON to JS numbers (`10.0` == `10`).

**Tech Stack:** Rust `no_std` core (`alloc::`), serde 1, serde_json 1, ts-rs 10.1, wasm-pack (nodejs target), vitest 4, pnpm.

## Global Constraints

- **The differential gate is the authority.** Fix divergences in Rust source — NEVER by editing goldens or loosening `conformance/canonical-json.ts`.
- **Byte-exact IEEE-754.** All damage arithmetic is `f64` in the **same operation order** as TS. `stats[stat] -= dealt` is `f64` subtraction. `compute_mitigated_damage` (already present) is reused verbatim.
- **`no_std` core.** Combat code uses `alloc::` only. Verified by BUILD only: `cargo build -p wickedways-core --no-default-features`. **Unit tests are NOT `no_std`** — run them under default features: `cargo test -p wickedways-core`. (The per-task test commands below use default features. Do NOT run `cargo test --no-default-features` — it does not compile.)
- **Randomness only through the injected `rng`.** The sole rng draw in the combat path is the 4a Confused fizzle roll inside `gate`, drawn only when Confused is active. `take_damage`/`reconcile`/`apply_from_stats` are rng-free.
- **Symbol-seam discipline:** durability writes route through `World::set_durability`; never mutate `ItemSnapshot::Item.durability` elsewhere.
- **Branded IDs:** construct `CharacterId`/`ItemId` through their tuple constructors; never cast a raw `String` to silence the compiler beyond these constructors.
- **Illegal transitions throw `ProceduralViolation`** (KO / Panic-on-non-move blocks, dark-attack).
- **`modifier` stays `i64`** — cast to `f64` only where combined with stats.
- Full gate before "done": `pnpm run checks:phase3` = `cargo build -p wickedways-core --no-default-features && cargo test --workspace && pnpm run bindings:check && pnpm run test:conformance`.

## File Structure

**Create:**
- `crates/wickedways-core/src/world/combat.rs` — `attack`, `take_damage`, `reconcile`, `on_knock_out`, `set_durability`, `require_visible_target`, `natural_attack`, `transform_damage`, `equipped_resolved`, plus unit tests.
- `conformance/combat.test.ts` — differential gate (mirrors `conformance/afflictions.test.ts`).
- `conformance/fixtures/combat.gen.test.ts` — fixture generator (mirrors `conformance/fixtures/afflictions.gen.test.ts`).

**Modify:**
- `crates/wickedways-core/src/world/snapshot.rs:70-74` — `Stats` fields `i64 → f64`.
- `crates/wickedways-core/src/world/resolve.rs:119-143` — `effective_stat` return `i64 → f64`.
- `crates/wickedways-core/src/world/afflictions.rs:125-131,163-171` — `apply_from_stats`/`on_turn_start` stat params `i64 → f64`; thresholds → float literals.
- `crates/wickedways-core/src/world/turn.rs:70-74` — floor `.max(0)` → `.max(0.0)`.
- `crates/wickedways-core/src/world/history.rs:31` — `TakeDamage.amount` `i64 → f64`.
- `crates/wickedways-core/src/world/view.rs:47,97,98` — `ScopeEntity.health: Option<f64>`, `StatusView.health/sanity: f64`.
- `crates/wickedways-core/src/world/movement.rs:29` — `entity_ref_char` `fn` → `pub(crate) fn`.
- `crates/wickedways-core/src/world/command.rs:14-31,33-68` — `Command::Attack` variant + dispatch arm.
- `crates/wickedways-core/src/world/mod.rs:2-16` — add `mod combat;`.
- `crates/wickedways-core/src/world/test_support.rs:29,116` — `Stats` literals → `f64`.
- `conformance/fixtures/vitest.config.ts` — register `combat.gen.test.ts`.
- `README.md` — verify/refresh the combat & mitigation section.

**Fold-in carries (from the 4a final review), done in Task 1:**
- `view.rs:102-104` — stale ViewModel doc ("defeated deferred to sub-plan 4"): correct it.
- `items_actions.rs` — relabel `TODO(sub-plan 4)` → `TODO(sub-plan 4c)`.

---

### Task 1: `f64` stat promotion (behavior-neutral) + carry cleanups

Promote base stats and every value derived from them to `f64`, so fractional post-damage
stats round-trip byte-exactly. This task adds **no combat logic** — its acceptance is: the
crate compiles, `no_std` build passes, bindings stay drift-clean, and **every existing unit
test and conformance golden stays green**.

**Files:**
- Modify: `crates/wickedways-core/src/world/snapshot.rs:70-74`
- Modify: `crates/wickedways-core/src/world/resolve.rs:119-143`
- Modify: `crates/wickedways-core/src/world/afflictions.rs:125-153,163-171`
- Modify: `crates/wickedways-core/src/world/turn.rs:70-74`
- Modify: `crates/wickedways-core/src/world/history.rs:31`
- Modify: `crates/wickedways-core/src/world/view.rs:47,97-98` (+ doc at 102-104)
- Modify: `crates/wickedways-core/src/world/test_support.rs:29,116`
- Modify: `crates/wickedways-core/src/world/items_actions.rs` (TODO relabel only)
- Test: new test in `snapshot.rs` tests module

**Interfaces:**
- Produces:
  - `struct Stats { energy: f64, sanity: f64, health: f64 }`
  - `World::effective_stat(&self, &CharacterId, StatType, &Catalog) -> f64`
  - `Afflictions::apply_from_stats(&mut self, health: f64, sanity: f64, energy: f64, &BTreeSet<Status>)`
  - `Afflictions::on_turn_start(&mut self, health: f64, sanity: f64, energy: f64, &BTreeSet<Status>, &AfflictionConfig, &mut Rng)`
  - `ActionHistoryEntry::TakeDamage { round: i64, amount: f64, stat: StatType }`
  - `ScopeEntity.health: Option<f64>`, `StatusView { health: f64, sanity: f64, .. }`

- [ ] **Step 1: Write the failing test** (fractional stat survives snapshot round-trip)

Add to the `#[cfg(test)] mod tests` in `crates/wickedways-core/src/world/snapshot.rs`:

```rust
#[test]
fn stats_roundtrip_fractional_value() {
    // Post-mitigation damage lands fractional bases (e.g. 7.5, 2.4). f64 must
    // preserve them across serialize/deserialize.
    let s = Stats { energy: 2.4, sanity: 0.5, health: 7.5 };
    let json = serde_json::to_string(&s).unwrap();
    let back: Stats = serde_json::from_str(&json).unwrap();
    assert_eq!(back, s);
    // Integer-valued stats still (de)serialize; serde emits `10.0`, which the
    // conformance comparator parses back to the JS number 10 (transparent).
    let whole: Stats = serde_json::from_str(r#"{"energy":5,"sanity":7,"health":10}"#).unwrap();
    assert_eq!(whole, Stats { energy: 5.0, sanity: 7.0, health: 10.0 });
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cargo test -p wickedways-core stats_roundtrip_fractional_value`
Expected: FAIL to compile (`Stats` fields are `i64`; `2.4` is not an integer).

- [ ] **Step 3: Promote `Stats` to `f64`**

In `crates/wickedways-core/src/world/snapshot.rs`, replace lines 68-74:

```rust
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub energy: f64,
    pub sanity: f64,
    pub health: f64,
}
```

Note: this deliberately diverges from the `base_escape_chance` convention (kept `i64` to
avoid `.0` in the wire form). Fractional damage forces `f64` here; the `.0` is harmless
because the conformance comparator parses both sides to JS numbers before comparing.

- [ ] **Step 4: Promote `effective_stat` to `f64`**

In `crates/wickedways-core/src/world/resolve.rs`, change the signature and body (lines 119-143):

```rust
    pub fn effective_stat(&self, character: &CharacterId, stat: StatType, cat: &Catalog) -> f64 {
        let Some(ch) = self.characters.get(character) else {
            return 0.0;
        };

        let base = match stat {
            StatType::Energy => ch.stats.energy,
            StatType::Sanity => ch.stats.sanity,
            StatType::Health => ch.stats.health,
        };

        // De-duplicate: a two-handed item occupies two slot-map entries.
        let equipped_ids: BTreeSet<&crate::world::ids::ItemId> =
            ch.equipment.values().collect();

        let bonus: i64 = equipped_ids
            .into_iter()
            .filter_map(|item_id| self.items.get(item_id))
            .filter_map(|snap| resolve_item(snap, cat).ok())
            .filter(|resolved| resolved.r#type == ItemType::Accessory && resolved.stat == stat)
            .map(|resolved| resolved.modifier)
            .sum();

        base + bonus as f64
    }
```

- [ ] **Step 5: Promote affliction stat params to `f64`**

In `crates/wickedways-core/src/world/afflictions.rs`, change `apply_from_stats` (lines 125-153) params and thresholds:

```rust
    pub fn apply_from_stats(
        &mut self,
        health: f64,
        sanity: f64,
        energy: f64,
        passive: &BTreeSet<Status>,
    ) {
        if health <= 0.0 {
            self.active.insert(Status::Ko, true);
            for s in CLEARABLE {
                self.clear_episode(s);
            }
            return;
        }
        self.active.insert(Status::Ko, false);

        self.resolve(Status::Panic, sanity <= 0.0, passive);
        self.resolve(Status::Fear, sanity > 0.0 && sanity < 5.0, passive);

        // Confused keeps a (0, 1] hold band so it doesn't flicker near the boundary.
        if energy <= 0.0 {
            self.resolve(Status::Confused, true, passive);
        } else if energy > 1.0 {
            self.resolve(Status::Confused, false, passive);
        } else if self.immune(Status::Confused, passive) {
            // (0, 1] hold band + immunity hysteresis (afflictions.ts:119-127).
            self.clear_episode(Status::Confused);
        }
    }
```

And change `on_turn_start` (lines 163-171) params `health: i64, sanity: i64, energy: i64` → `health: f64, sanity: f64, energy: f64` (body unchanged — it only forwards them to `apply_from_stats`).

- [ ] **Step 6: Float the `start_turn` floor**

In `crates/wickedways-core/src/world/turn.rs`, change lines 71-73:

```rust
            c.stats.health = c.stats.health.max(0.0);
            c.stats.sanity = c.stats.sanity.max(0.0);
            c.stats.energy = c.stats.energy.max(0.0);
```

- [ ] **Step 7: Float `TakeDamage.amount` and the view stat fields**

In `crates/wickedways-core/src/world/history.rs`, line 31:

```rust
    TakeDamage { round: i64, amount: f64, stat: StatType },
```

In `crates/wickedways-core/src/world/view.rs`: change `ScopeEntity.health` (line 47) to `pub health: Option<f64>,` and `StatusView` (lines 97-98) to `pub health: f64,` / `pub sanity: f64,`. Also fix the stale doc at `view.rs:102-104` — replace any "defeated deferred to sub-plan 4" text with a note that `defeated` shipped in 4a.

- [ ] **Step 8: Fix all compile sites the type change flags**

Run `cargo build -p wickedways-core` and fix each error. Known sites:
- `test_support.rs:29,116` → `stats: Stats { energy: 5.0, sanity: 5.0, health: 5.0 }`.
- `resolve.rs` tests: every `Stats { energy: N, .. }` literal → `N.0`; every `effective_stat(..) == N` assertion → `== N.0` (e.g. `assert_eq!(..., 8)` → `8.0`).
- `turn.rs` tests: `c.stats.sanity = 0` → `0.0`, `= -3` → `-3.0`, `c.stats.health = 0` → `0.0`; `assert_eq!(ch1.stats.sanity, 0)` → `0.0`.
- `afflictions.rs` tests: `apply_from_stats(0, 0, 0, ..)` → `(0.0, 0.0, 0.0, ..)`; `on_turn_start(10, 0, 5, ..)` → `(10.0, 0.0, 5.0, ..)`; all such calls.
- `view.rs` tests: `Stats { .. }` literals → `f64`; `assert_eq!(wraith.health, Some(3))` → `Some(3.0)`; status health/sanity asserts → `f64`.
- `history.rs` test `take_damage_entry_roundtrips`: `amount: 3` → `amount: 3.0`; `assert_eq!(v["amount"], 3)` → `assert_eq!(v["amount"], 3.0)` (serde_json `Value` implements `PartialEq<f64>`).

Fix any additional site the compiler reports (e.g. integration tests). Do not change any logic — only literal types and assertion literals.

- [ ] **Step 9: Relabel the deferred-TODO carry**

In `crates/wickedways-core/src/world/items_actions.rs`, change the `TODO(sub-plan 4)` comment(s) to `TODO(sub-plan 4c)` (mobs/encounters). Do not change code.

- [ ] **Step 10: Run the new test + full unit suite**

Run: `cargo test -p wickedways-core`
Expected: PASS (including `stats_roundtrip_fractional_value`). Zero failures.

- [ ] **Step 11: Verify `no_std` build + bindings + conformance (transparency)**

Run:
```bash
cargo build -p wickedways-core --no-default-features
pnpm run bindings:check
pnpm run test:conformance
```
Expected: no_std build OK; `bindings:check` clean (both `i64` and `f64` emit TS `number` — no drift); all conformance goldens green **unchanged** (the `f64` `.0` normalizes away on parse).

- [ ] **Step 12: Commit**

```bash
git add crates/wickedways-core conformance
git commit -m "refactor(core): promote stats i64->f64 for fractional combat damage (sub-plan 4b)

Base stats, effective_stat, affliction thresholds, TakeDamage.amount, and the
view stat fields become f64 so post-damage fractional stats serialize and
threshold-compare byte-exactly to the TS oracle. Behavior-neutral: transparent
to all goldens (comparator parses JSON numbers, 10.0 == 10). Also relabels the
sub-plan-4 TODO to 4c and fixes the stale defeated-view doc.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `set_durability` + `reconcile` + `on_knock_out` + `transform_damage`

The post-damage machinery: the durability write seam, the floor→afflictions→KO-transition
reconcile, the no-op KO hook (seam for 4c), and the no-op damage transform (seam for
sub-plan 6). Create `combat.rs` and register it.

**Files:**
- Create: `crates/wickedways-core/src/world/combat.rs`
- Modify: `crates/wickedways-core/src/world/mod.rs:13-15` (add `mod combat;`)
- Test: unit tests in `combat.rs`

**Interfaces:**
- Consumes: `World::effective_stat -> f64` (Task 1), `World::passive_immune`, `Afflictions::apply_from_stats`/`is_active`, `resolve_item`, `ItemSnapshot::Item { durability, .. }`.
- Produces:
  - `World::set_durability(&mut self, item: &ItemId, value: i64)`
  - `World::reconcile(&mut self, actor: &CharacterId, cat: &Catalog, cues: &mut Vec<PresentationCue>)`
  - `World::transform_damage(&self, amount: f64, target: &CharacterId, stat: StatType) -> f64` (returns `amount`)
  - private `World::on_knock_out(&mut self, actor, cat, cues)` (no-op)

- [ ] **Step 1: Register the module**

In `crates/wickedways-core/src/world/mod.rs`, add alongside the other private world modules (after line 13 `mod items_actions;`):

```rust
mod combat;
```

- [ ] **Step 2: Write failing tests**

Create `crates/wickedways-core/src/world/combat.rs`. Use exactly these imports (Tasks 3-4
extend the list) so this task compiles warning-free:

```rust
//! Combat damage — byte-exact port of `combatant.ts` `attack` (:49-93) and
//! `character.ts` `takeDamage` (:930-971), `#reconcile` (:330-340),
//! `#floorAndSnapshot` (:308-317), and `onKnockOut` (:342-347).
//!
//! `take_damage` is internal-only (never a Command — TS only calls it from `attack`).
//! The sole rng draw in the combat path is the 4a Confused fizzle in `gate`.
use alloc::vec::Vec;

use crate::presentation::PresentationCue;
use crate::stats::StatType;
use crate::world::descriptor::Catalog;
use crate::world::ids::{CharacterId, ItemId};
use crate::world::snapshot::ItemSnapshot;
use crate::world::World;

// (impl World block added in Step 4; take_damage/attack added in Tasks 3-4)

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world::afflictions::Status;
    use crate::world::descriptor::Catalog;
    use crate::world::ids::{CharacterId, ItemId};
    use crate::world::snapshot::ItemSnapshot;
    use crate::world::test_support::world_with_party;

    fn cid(s: &str) -> CharacterId { CharacterId(s.into()) }

    #[test]
    fn set_durability_writes_the_item() {
        let mut w = world_with_party(&["pc"], 10);
        let id = ItemId("sword".into());
        w.items.insert(id.clone(), ItemSnapshot::Item {
            id: id.clone(), behavior_key: "items/sword".into(),
            durability: Some(3), modifier: 2,
        });
        w.set_durability(&id, 2);
        match &w.items[&id] {
            ItemSnapshot::Item { durability, .. } => assert_eq!(*durability, Some(2)),
            _ => panic!("expected Item"),
        }
    }

    #[test]
    fn reconcile_floors_negative_base_and_latches_ko() {
        // health driven negative → reconcile floors base to 0 AND latches KO.
        let mut w = world_with_party(&["pc"], 10);
        let mut cues = Vec::new();
        if let Some(c) = w.characters.get_mut(&cid("pc")) { c.stats.health = -2.5; }
        w.reconcile(&cid("pc"), &Catalog::default(), &mut cues);
        let ch = w.characters.get(&cid("pc")).unwrap();
        assert_eq!(ch.stats.health, 0.0, "base health floored to 0");
        assert!(ch.afflictions.is_active(Status::Ko), "health<=0 latches KO");
    }

    #[test]
    fn reconcile_no_ko_when_health_positive() {
        let mut w = world_with_party(&["pc"], 10);
        let mut cues = Vec::new();
        // world_with_party sets 5/5/5 — healthy.
        w.reconcile(&cid("pc"), &Catalog::default(), &mut cues);
        assert!(!w.characters[&cid("pc")].afflictions.is_active(Status::Ko));
        assert!(cues.is_empty(), "base on_knock_out emits no cues");
    }

    #[test]
    fn transform_damage_is_identity() {
        let w = world_with_party(&["pc"], 10);
        assert_eq!(w.transform_damage(7.5, &cid("pc"), StatType::Health), 7.5);
    }
}
```

- [ ] **Step 3: Run to verify failure**

Run: `cargo test -p wickedways-core --lib world::combat`
Expected: FAIL to compile (`set_durability`, `reconcile`, `transform_damage` undefined).

- [ ] **Step 4: Implement the methods**

Insert this `impl World` block into `crates/wickedways-core/src/world/combat.rs` (between the imports and the `#[cfg(test)]` module):

```rust
impl World {
    /// Durability write seam (mirrors TS `SET_DURABILITY`). The ONLY place
    /// `ItemSnapshot::Item.durability` is mutated. No clamp — callers pass
    /// `durability - 1`, and only non-broken items (durability >= 1) ever wear.
    pub fn set_durability(&mut self, item: &ItemId, value: i64) {
        if let Some(ItemSnapshot::Item { durability, .. }) = self.items.get_mut(item) {
            *durability = Some(value);
        }
    }

    /// Custom-mechanics damage transform (TS `campaign[TRANSFORM_DAMAGE]`).
    /// Phase 1 has no mechanics → identity passthrough. Sub-plan 6 wires the
    /// mechanic registry here.
    pub fn transform_damage(&self, amount: f64, _target: &CharacterId, _stat: StatType) -> f64 {
        amount
    }

    /// Floor base stats, recompute afflictions from effective stats, and fire
    /// `on_knock_out` exactly once on a false→true KO transition. Byte-exact port
    /// of `character.ts` `#reconcile` (:330-340) + `#floorAndSnapshot` (:308-317).
    pub fn reconcile(&mut self, actor: &CharacterId, cat: &Catalog, cues: &mut Vec<PresentationCue>) {
        let was_ko = self
            .characters
            .get(actor)
            .map(|c| c.afflictions.is_active(crate::world::afflictions::Status::Ko))
            .unwrap_or(false);

        // #floorAndSnapshot: persistently clamp base stats to max(0.0, x).
        if let Some(c) = self.characters.get_mut(actor) {
            c.stats.health = c.stats.health.max(0.0);
            c.stats.sanity = c.stats.sanity.max(0.0);
            c.stats.energy = c.stats.energy.max(0.0);
        }
        // Effective snapshot (base + equipped-accessory bonuses) + passive immunities.
        let health = self.effective_stat(actor, StatType::Health, cat);
        let sanity = self.effective_stat(actor, StatType::Sanity, cat);
        let energy = self.effective_stat(actor, StatType::Energy, cat);
        let passive = self.passive_immune(actor, cat);
        if let Some(c) = self.characters.get_mut(actor) {
            c.afflictions.apply_from_stats(health, sanity, energy, &passive);
        }

        let is_ko = self
            .characters
            .get(actor)
            .map(|c| c.afflictions.is_active(crate::world::afflictions::Status::Ko))
            .unwrap_or(false);
        if !was_ko && is_ko {
            self.on_knock_out(actor, cat, cues);
        }
    }

    /// Hook fired once when KO newly latches during `reconcile`. Base behavior:
    /// none (mirrors base `Character.onKnockOut`). Sub-plan 4c overrides for
    /// `CharacterKind::Mob` to drop loot / record the encounter — hence `cues`
    /// is plumbed now.
    fn on_knock_out(&mut self, _actor: &CharacterId, _cat: &Catalog, _cues: &mut Vec<PresentationCue>) {
        // no-op (sub-plan 4c: Mob loot-drop override)
    }
}
```

These methods use only the Step-2 minimal imports (`effective_stat`/`passive_immune`/
`apply_from_stats` are called on `self`/`c.afflictions`, needing no new imports; `Status` is
referenced fully-qualified). Tasks 3-4 extend the import list.

- [ ] **Step 5: Run tests**

Run: `cargo test -p wickedways-core --lib world::combat`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add crates/wickedways-core/src/world/combat.rs crates/wickedways-core/src/world/mod.rs
git commit -m "feat(core): set_durability seam + reconcile + onKnockOut/transformDamage stubs (sub-plan 4b)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `take_damage`

Internal method: armor mitigation → identity transform → subtract (f64) → armor durability
wear → reconcile → non-budgeted `takeDamage` history/cue on the **target**. Byte-exact port
of `character.ts:930-971`.

**Files:**
- Modify: `crates/wickedways-core/src/world/combat.rs`
- Test: unit tests in `combat.rs`

**Interfaces:**
- Consumes: `set_durability`, `reconcile`, `transform_damage`, `effective_stat`, `compute_mitigated_damage`, `is_lit`, `entity_ref_char` (make `pub(crate)` — Step 1), `resolve_item`.
- Produces: `World::take_damage(&mut self, target: &CharacterId, attack_strength: f64, attack_stat: StatType, cat: &Catalog, cues: &mut Vec<PresentationCue>)`; private `World::equipped_resolved(&self, actor, cat) -> Vec<ResolvedItem>`.

- [ ] **Step 1: Expose `entity_ref_char` to the crate**

In `crates/wickedways-core/src/world/movement.rs:29`, change `fn entity_ref_char` to `pub(crate) fn entity_ref_char`.

- [ ] **Step 2: Write failing tests**

Add to the `mod tests` in `combat.rs`. These use a small catalog helper — add it to the test module:

```rust
    use crate::world::descriptor::{ItemDescriptor, ItemProperties, ItemType, SlotKind};
    use crate::stats::StatType;
    use alloc::collections::BTreeMap;
    use serde_json::json;

    fn armor_desc(stat: StatType, modifier: i64, max_dur: Option<i64>) -> ItemDescriptor {
        ItemDescriptor {
            name: "Test Armor".into(), r#type: ItemType::Armor, stat, modifier,
            properties: ItemProperties { equippable: true, equipped: false, destroyable: true, usable: false, droppable: None },
            slot: Some(SlotKind::Torso), two_handed: None, emits_light: None,
            max_durability: max_dur, lore: None, presentation: None, key_code: None,
            consume_on_use: None, recipe: json!({}), teaches: json!(null),
            immunities: json!([]), grants_immunity: json!(null),
        }
    }

    #[test]
    fn take_damage_no_armor_subtracts_mitigated_amount() {
        // attack_strength=5, no armor, mitigator = effective(Sanity) for Health damage.
        // world_with_party: health/sanity/energy = 5. mitigator(Health)=Sanity=5.
        // dealt = max(0,5-0) * max(0,10-5)*0.2 * 1 = 5 * 1.0 = 5.0 → health 5-5 = 0 → KO.
        let mut w = world_with_party(&["pc"], 10);
        let mut cues = Vec::new();
        w.take_damage(&cid("pc"), 5.0, StatType::Health, &Catalog::default(), &mut cues);
        let ch = w.characters.get(&cid("pc")).unwrap();
        assert_eq!(ch.stats.health, 0.0);
        assert!(ch.afflictions.is_active(Status::Ko));
        // history: takeDamage with fractional-capable amount, NOT budgeted.
        assert_eq!(ch.actions_this_round, 0, "takeDamage never ticks budget");
        match ch.history.last().unwrap() {
            ActionHistoryEntry::TakeDamage { amount, stat, .. } => {
                assert_eq!(*amount, 5.0);
                assert_eq!(*stat, StatType::Health);
            }
            other => panic!("expected TakeDamage, got {:?}", other),
        }
        // cue: takeDamage on the TARGET.
        match cues.last().unwrap() {
            PresentationCue::Action { action: ActionKind::TakeDamage, actor, sound: None } => {
                assert_eq!(actor.id, "pc");
            }
            other => panic!("expected takeDamage cue, got {:?}", other),
        }
    }

    #[test]
    fn take_damage_armor_reduces_and_wears() {
        // Equip armor(modifier=3, max_dur=2) defending Health. attack_strength=5.
        // armorSum=3 → mitigated_strength=max(0,5-3)=2; mult=(10-5)*0.2=1.0 → dealt=2.0.
        // health 5-2 = 3.0; armor durability 2 -> 1.
        let mut w = world_with_party(&["pc"], 10);
        let mut cues = Vec::new();
        let armor_id = ItemId("armor".into());
        let mut items = BTreeMap::new();
        items.insert("items/armor".to_string(), armor_desc(StatType::Health, 3, Some(2)));
        let cat = Catalog { items, aliases: BTreeMap::new() };
        w.items.insert(armor_id.clone(), ItemSnapshot::Item {
            id: armor_id.clone(), behavior_key: "items/armor".into(),
            durability: Some(2), modifier: 3,
        });
        w.characters.get_mut(&cid("pc")).unwrap().equipment.insert("torso".into(), armor_id.clone());

        w.take_damage(&cid("pc"), 5.0, StatType::Health, &cat, &mut cues);

        assert_eq!(w.characters[&cid("pc")].stats.health, 3.0);
        match &w.items[&armor_id] {
            ItemSnapshot::Item { durability, .. } => assert_eq!(*durability, Some(1), "armor wore 1"),
            _ => panic!(),
        }
    }

    #[test]
    fn take_damage_broken_armor_does_not_mitigate_or_wear() {
        // Armor at durability 0 is broken → excluded from armorSum AND from wear.
        let mut w = world_with_party(&["pc"], 10);
        let mut cues = Vec::new();
        let armor_id = ItemId("armor".into());
        let mut items = BTreeMap::new();
        items.insert("items/armor".to_string(), armor_desc(StatType::Health, 3, Some(2)));
        let cat = Catalog { items, aliases: BTreeMap::new() };
        w.items.insert(armor_id.clone(), ItemSnapshot::Item {
            id: armor_id.clone(), behavior_key: "items/armor".into(),
            durability: Some(0), modifier: 3,
        });
        w.characters.get_mut(&cid("pc")).unwrap().equipment.insert("torso".into(), armor_id.clone());

        w.take_damage(&cid("pc"), 5.0, StatType::Health, &cat, &mut cues);

        // No mitigation: dealt = 5 * (10-5)*0.2 = 5.0 → health 0.
        assert_eq!(w.characters[&cid("pc")].stats.health, 0.0);
        // Broken armor stays at 0 (no wear below 0).
        match &w.items[&armor_id] {
            ItemSnapshot::Item { durability, .. } => assert_eq!(*durability, Some(0)),
            _ => panic!(),
        }
    }
```

- [ ] **Step 3: Run to verify failure**

Run: `cargo test -p wickedways-core --lib world::combat`
Expected: FAIL to compile (`take_damage` undefined).

- [ ] **Step 4: Implement `equipped_resolved` + `take_damage`**

Extend the import list at the top of `combat.rs` to add what this task needs:

```rust
use alloc::collections::BTreeSet;
use crate::damage::{compute_mitigated_damage, DamageInput};
use crate::presentation::ActionKind;
use crate::stats::StatType;               // (already present)
use crate::world::descriptor::ItemType;
use crate::world::history::ActionHistoryEntry;
use crate::world::resolve::{resolve_item, ResolvedItem};
```

Add these methods to the `impl World` block in `combat.rs`:

```rust
    /// Resolve a character's equipped items (de-duplicating two-handed items that
    /// occupy two slots), mirroring `effective_stat`'s equipped-set derivation.
    fn equipped_resolved(&self, actor: &CharacterId, cat: &Catalog) -> Vec<ResolvedItem> {
        let Some(ch) = self.characters.get(actor) else { return Vec::new() };
        let equipped_ids: BTreeSet<&ItemId> = ch.equipment.values().collect();
        equipped_ids
            .into_iter()
            .filter_map(|id| self.items.get(id))
            .filter_map(|snap| resolve_item(snap, cat).ok())
            .collect()
    }

    /// Apply an incoming hit to `target`'s `attack_stat` after armor + mitigation,
    /// wear contributing armor, reconcile, and record a NON-budgeted `takeDamage`.
    /// Byte-exact port of `character.ts` `takeDamage` (:930-971). Internal only.
    pub fn take_damage(
        &mut self,
        target: &CharacterId,
        attack_strength: f64,
        attack_stat: StatType,
        cat: &Catalog,
        cues: &mut Vec<PresentationCue>,
    ) {
        // Equipped, non-broken armor defending this stat soaks raw strength first.
        let equipped = self.equipped_resolved(target, cat);
        let armor: Vec<&ResolvedItem> = equipped
            .iter()
            .filter(|r| r.r#type == ItemType::Armor && !r.is_broken && r.stat == attack_stat)
            .collect();
        let armor_sum: i64 = armor.iter().map(|r| r.modifier).sum();
        // Snapshot the wear list (owned) NOW so the immutable borrow of `equipped`
        // ends before the mutable stat write below.
        let worn: Vec<(ItemId, i64)> = armor
            .iter()
            .filter(|r| r.max_durability.is_some())
            .map(|r| (ItemId(r.id.clone()), r.durability.unwrap_or(0) - 1))
            .collect();

        let mitigator = self.effective_stat(target, attack_stat.mitigator(), cat);
        let light_averse = self
            .characters
            .get(target)
            .and_then(|c| c.light_averse)
            .unwrap_or(false);
        let room_lit = self
            .characters
            .get(target)
            .and_then(|c| c.current_room_id.clone())
            .map(|rid| self.is_lit(&rid))
            .unwrap_or(false);

        let final_strength = compute_mitigated_damage(DamageInput {
            attack_strength,
            armor_sum: armor_sum as f64,
            mitigator,
            light_averse,
            room_lit,
        });
        let dealt = self.transform_damage(final_strength, target, attack_stat);

        // Subtract from the base stat (no clamp here — reconcile floors it).
        if let Some(c) = self.characters.get_mut(target) {
            match attack_stat {
                StatType::Health => c.stats.health -= dealt,
                StatType::Sanity => c.stats.sanity -= dealt,
                StatType::Energy => c.stats.energy -= dealt,
            }
        }

        // Each contributing armor piece wears one point.
        for (id, val) in worn {
            self.set_durability(&id, val);
        }

        self.reconcile(target, cat, cues);

        // Record takeDamage — NOT budgeted (takeDamage is absent from isActionMap).
        let round = self.campaign.round;
        if let Some(c) = self.characters.get_mut(target) {
            c.history.push(ActionHistoryEntry::TakeDamage {
                round,
                amount: dealt,
                stat: attack_stat,
            });
        }
        cues.push(PresentationCue::Action {
            action: ActionKind::TakeDamage,
            actor: self.entity_ref_char(target),
            sound: None,
        });
    }
```

- [ ] **Step 5: Run tests**

Run: `cargo test -p wickedways-core --lib world::combat`
Expected: PASS (all combat tests, including the 3 new `take_damage` tests).

- [ ] **Step 6: Commit**

```bash
git add crates/wickedways-core/src/world/combat.rs crates/wickedways-core/src/world/movement.rs
git commit -m "feat(core): take_damage (mitigation + armor wear + reconcile, non-budgeted) (sub-plan 4b)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `attack` + `Command::Attack` + dispatch

The budgeted, affliction-gated, dark-checked attack action: weapon matrix (fixed
`[Health, Energy, Sanity]` order) with natural-attack fallback, per-stat `take_damage`,
weapon wear, and a budgeted `attack` history/cue on the attacker. Byte-exact port of
`combatant.ts:49-93`.

**Files:**
- Modify: `crates/wickedways-core/src/world/combat.rs`
- Modify: `crates/wickedways-core/src/world/command.rs:14-31,33-68`
- Test: unit tests in `combat.rs`

**Interfaces:**
- Consumes: `gate` → `GateVerdict`, `record_fumble`, `require_visible_target` (new, Step 4), `natural_attack` (new, Step 4), `equipped_resolved`, `take_damage`, `set_durability`, `entity_ref_char`, `is_lit`, `sees_in_dark`.
- Produces:
  - `World::attack(&mut self, actor: &CharacterId, target: &CharacterId, cat: &Catalog, cues: &mut Vec<PresentationCue>) -> Result<(), ProceduralViolation>`
  - `Command::Attack { target_id: String }` (serde `{ "kind": "attack", "targetId": "..." }`)

- [ ] **Step 1: Write failing tests**

Add to `mod tests` in `combat.rs` a weapon helper and attack tests:

```rust
    fn weapon_desc(stat: StatType, modifier: i64, max_dur: Option<i64>) -> ItemDescriptor {
        ItemDescriptor {
            name: "Test Weapon".into(), r#type: ItemType::Weapon, stat, modifier,
            properties: ItemProperties { equippable: true, equipped: false, destroyable: true, usable: false, droppable: None },
            slot: Some(SlotKind::Hand), two_handed: None, emits_light: None,
            max_durability: max_dur, lore: None, presentation: None, key_code: None,
            consume_on_use: None, recipe: json!({}), teaches: json!(null),
            immunities: json!([]), grants_immunity: json!(null),
        }
    }

    /// Two-PC world (ada attacks ben). Returns (world, empty catalog). Callers
    /// rebind `w` as mutable. require_visible_target passes here: is_lit returns
    /// true for a missing/None current room, so no dark block.
    fn duel_world() -> (World, Catalog) {
        let w = world_with_party(&["ada", "ben"], 10);
        (w, Catalog::default())
    }

    #[test]
    fn attack_with_weapon_deals_damage_wears_weapon_and_ticks_budget() {
        // ada equips weapon(Health, modifier=5, max_dur=3). ben health 5.
        // ben.takeDamage(5, Health): mitigator(Sanity)=5 → dealt=5*1.0=5 → ben health 0, KO.
        let (mut w, _c) = duel_world();
        let mut cues = Vec::new();
        let wpn = ItemId("axe".into());
        let mut items = BTreeMap::new();
        items.insert("items/axe".to_string(), weapon_desc(StatType::Health, 5, Some(3)));
        let cat = Catalog { items, aliases: BTreeMap::new() };
        w.items.insert(wpn.clone(), ItemSnapshot::Item {
            id: wpn.clone(), behavior_key: "items/axe".into(), durability: Some(3), modifier: 5,
        });
        w.characters.get_mut(&cid("ada")).unwrap().equipment.insert("hand".into(), wpn.clone());

        w.attack(&cid("ada"), &cid("ben"), &cat, &mut cues).unwrap();

        assert_eq!(w.characters[&cid("ben")].stats.health, 0.0);
        assert!(w.characters[&cid("ben")].afflictions.is_active(Status::Ko));
        // weapon wore 3 -> 2
        match &w.items[&wpn] {
            ItemSnapshot::Item { durability, .. } => assert_eq!(*durability, Some(2)),
            _ => panic!(),
        }
        // attacker budget ticked; target's did not.
        assert_eq!(w.characters[&cid("ada")].actions_this_round, 1);
        assert_eq!(w.characters[&cid("ben")].actions_this_round, 0);
        // attacker recorded an Attack; last cue is the attack cue on the attacker.
        assert!(matches!(w.characters[&cid("ada")].history.last().unwrap(),
            ActionHistoryEntry::Attack { .. }));
        match cues.last().unwrap() {
            PresentationCue::Action { action: ActionKind::Attack, actor, sound: None } =>
                assert_eq!(actor.id, "ada"),
            other => panic!("expected attack cue, got {:?}", other),
        }
    }

    #[test]
    fn attack_unarmed_uses_natural_attack_default_1_health() {
        // No weapon → natural attack (Health, 1). ben health 5 → dealt=1*1.0=1 → 4.0.
        let (mut w, cat) = duel_world();
        let mut cues = Vec::new();
        w.attack(&cid("ada"), &cid("ben"), &cat, &mut cues).unwrap();
        assert_eq!(w.characters[&cid("ben")].stats.health, 4.0);
    }

    #[test]
    fn attack_ko_actor_is_blocked() {
        let (mut w, cat) = duel_world();
        let mut cues = Vec::new();
        w.characters.get_mut(&cid("ada")).unwrap().afflictions.set_active(Status::Ko, true);
        let err = w.attack(&cid("ada"), &cid("ben"), &cat, &mut cues).unwrap_err();
        assert_eq!(err.0, "Cannot act while KO'd.");
        // blocked before any damage.
        assert_eq!(w.characters[&cid("ben")].stats.health, 5.0);
    }

    #[test]
    fn attack_command_dispatches() {
        use crate::world::command::{apply_command, Command};
        let (mut w, cat) = duel_world();
        let mut opened = BTreeSet::new();
        let mut cues = Vec::new();
        // active character is index 0 = "ada".
        apply_command(&mut w, Command::Attack { target_id: "ben".into() }, &cat, &mut opened, &mut cues).unwrap();
        assert_eq!(w.characters[&cid("ben")].stats.health, 4.0); // unarmed natural 1
    }
```

Note: `duel_world` leaves an unused `mut` on `w` in this snippet only if you drop the mutation — keep the `let mut w` and return it; the helper is used mutably by callers.

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p wickedways-core --lib world::combat`
Expected: FAIL to compile (`attack` and `Command::Attack` undefined).

- [ ] **Step 3: Extend imports for Task 4**

Add to the top of `combat.rs`:

```rust
use alloc::format;
use crate::error::ProceduralViolation;
use crate::world::gate::GateVerdict;
use crate::world::history::TargetRef;
```

- [ ] **Step 4: Implement `require_visible_target`, `natural_attack`, `attack`**

Add to the `impl World` block in `combat.rs`:

```rust
    /// Throw if the actor cannot see (unlit room and not `sees_in_dark`).
    /// Mirrors `character.ts` `requireVisibleTarget` (:266-271): checks only the
    /// actor's own visibility, not the target's location.
    fn require_visible_target(&self, actor: &CharacterId, verb: &str) -> Result<(), ProceduralViolation> {
        if let Some(ch) = self.characters.get(actor) {
            if let Some(room_id) = &ch.current_room_id {
                if !self.is_lit(room_id) && !self.sees_in_dark(actor) {
                    return Err(ProceduralViolation(format!("Cannot {verb} in the dark")));
                }
            }
        }
        Ok(())
    }

    /// The actor's unarmed strike (stat + power). Default `{ Health, 1 }`, parsed
    /// from the `natural_attack` snapshot field. Mirrors `combatant.ts` `naturalAttack`
    /// (:37-39) / `DEFAULT_NATURAL_ATTACK` (:13). Mob overrides land in sub-plan 4c.
    fn natural_attack(&self, actor: &CharacterId) -> (StatType, f64) {
        #[derive(serde::Deserialize)]
        struct NaturalAttackJson { stat: StatType, power: f64 }
        let default = (StatType::Health, 1.0);
        let Some(ch) = self.characters.get(actor) else { return default };
        let Some(v) = &ch.natural_attack else { return default };
        match serde_json::from_value::<NaturalAttackJson>(v.clone()) {
            Ok(na) => (na.stat, na.power),
            Err(_) => default,
        }
    }

    /// Attack `target`. Gated (affliction) then dark-checked; each equipped
    /// non-broken weapon adds its modifier to its stat (else a natural strike);
    /// damage lands per stat in [Health, Energy, Sanity] order; weapons wear one
    /// point; a budgeted `attack` is recorded. Byte-exact port of `combatant.ts`
    /// `attack` (:49-93).
    pub fn attack(
        &mut self,
        actor: &CharacterId,
        target: &CharacterId,
        cat: &Catalog,
        cues: &mut Vec<PresentationCue>,
    ) -> Result<(), ProceduralViolation> {
        // 1. Affliction gate (attack is a non-move, budgeted action).
        match self.gate(actor, false) {
            GateVerdict::Block(reason) => return Err(ProceduralViolation(reason)),
            GateVerdict::Fizzle => {
                self.record_fumble(actor, "attack", true, cues);
                return Ok(());
            }
            GateVerdict::Allow => {}
        }
        // 2. Dark check (after the gate, matching TS order).
        self.require_visible_target(actor, "attack")?;

        // 3. Equipped, non-broken weapons.
        let equipped = self.equipped_resolved(actor, cat);
        let weapons: Vec<&ResolvedItem> = equipped
            .iter()
            .filter(|r| r.r#type == ItemType::Weapon && !r.is_broken)
            .collect();

        // 4. Attack matrix in fixed order [Health, Energy, Sanity].
        let mut matrix: [(StatType, f64); 3] = [
            (StatType::Health, 0.0),
            (StatType::Energy, 0.0),
            (StatType::Sanity, 0.0),
        ];
        if weapons.is_empty() {
            let (nstat, npow) = self.natural_attack(actor);
            for e in matrix.iter_mut() {
                if e.0 == nstat {
                    e.1 += npow;
                }
            }
        } else {
            for w in &weapons {
                for e in matrix.iter_mut() {
                    if e.0 == w.stat {
                        e.1 += w.modifier as f64;
                    }
                }
            }
        }

        // Snapshot the weapon wear list (owned) before the &mut self calls below.
        let worn: Vec<(ItemId, i64)> = weapons
            .iter()
            .filter(|r| r.max_durability.is_some())
            .map(|r| (ItemId(r.id.clone()), r.durability.unwrap_or(0) - 1))
            .collect();

        // 5. Inflict damage per stat with strength > 0, in matrix order.
        for (stat, strength) in matrix {
            if strength > 0.0 {
                self.take_damage(target, strength, stat, cat, cues);
            }
        }

        // 6. Each weapon that swung wears one point (after damage).
        for (id, val) in worn {
            self.set_durability(&id, val);
        }

        // 7. Record the budgeted attack on the attacker.
        let round = self.campaign.round;
        let target_name = self
            .characters
            .get(target)
            .map(|c| c.name.clone())
            .unwrap_or_default();
        if let Some(c) = self.characters.get_mut(actor) {
            c.actions_this_round += 1;
            c.history.push(ActionHistoryEntry::Attack {
                round,
                target: TargetRef { id: target.clone(), name: target_name },
            });
        }
        cues.push(PresentationCue::Action {
            action: ActionKind::Attack,
            actor: self.entity_ref_char(actor),
            sound: None,
        });
        Ok(())
    }
```

- [ ] **Step 5: Add `Command::Attack` + dispatch**

In `crates/wickedways-core/src/world/command.rs`, add the import (line 9 area):

```rust
use crate::world::ids::{CharacterId, ItemId};
```

Add the variant to the `Command` enum (after the `Use` variant, before the closing brace):

```rust
    #[serde(rename_all = "camelCase")]
    Attack { target_id: String },
```

Add the dispatch arm in `apply_command`'s match (after the `Open` arm):

```rust
        Command::Attack { target_id } => {
            world.attack(&actor, &CharacterId(target_id), cat, cues)
        }
```

- [ ] **Step 6: Run tests**

Run: `cargo test -p wickedways-core --lib world::combat`
Expected: PASS (all combat tests incl. the 4 attack tests).

Then the full crate: `cargo test -p wickedways-core`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add crates/wickedways-core/src/world/combat.rs crates/wickedways-core/src/world/command.rs
git commit -m "feat(core): attack action + Command::Attack (gate + dark + weapon matrix + wear, budgeted) (sub-plan 4b)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Combat conformance fixture (`combat.gen.test.ts`)

Author a bespoke PC-vs-PC combat campaign whose command stream exercises fractional damage,
armor/weapon durability wear (including breaking → natural-attack fallback), the light
vulnerability branch, reconcile flooring, KO transition, damage-driven affliction latching,
and budget behavior; then generate `combat.{start.snapshot,catalog,golden}.json`.

**This task mirrors the existing `conformance/fixtures/afflictions.gen.test.ts` harness.**
Read that file first — reuse its structure verbatim (assemble world; construct both
`PlayerCharacter`s injecting a single shared `mulberry32(SEED)`; capture cues via the
campaign `EMIT_CUE` sink; record `{command, cues, snapshot, view}` per driven engine call;
write the three JSON files). Only the campaign content, command stream, seed, and
self-validation assertions below are new.

**Files:**
- Create: `conformance/fixtures/combat.gen.test.ts`
- Modify: `conformance/fixtures/vitest.config.ts` (register the new generator)

**Campaign content (all authored in the generator):**
- One **lit** room `Hall` (`dark: false`).
- Catalog items:
  - `items/axe` — `type: "weapon"`, `stat: "health"`, `modifier: 3`, `maxDurability: 2`.
  - `items/cleaver` — `type: "weapon"`, `stat: "sanity"`, `modifier: 4`, `maxDurability: 5` (a second weapon, so a multi-stat attack pins the `[Health, Energy, Sanity]` order).
  - `items/vest` — `type: "armor"`, `stat: "health"`, `modifier: 1`, `maxDurability: 2`.
  - `items/charm` — `type: "accessory"`, `stat: "sanity"`, `modifier: 2` (Ben's mitigator/effective-stat contributor).
- **Ada** (index 0, gm) — attacker. Stats high enough to stay affliction-free the whole run (e.g. `health: 10, sanity: 10, energy: 10`). Equips `axe` + `cleaver` (two hands). `presentation` omitted (no sound).
- **Ben** (index 1) — target. `light_averse: true`. Stats chosen so damage drives him through Fear/Panic and to KO (e.g. `health: 6, sanity: 6, energy: 10`). Equips `vest` (torso) + `charm` (finger). `presentation` omitted.
- `baseEncounterChance: 0`; no dark rooms, no exits (no movement rng).

**Command stream (drive the engine directly, record each as a `Command`):**
Author a sequence over a few rounds that, by construction, produces:
1. `startTurn`(Ada) → `attack`(Ben) → `nextPlayer` → `startTurn`(Ben) → `nextPlayer`, repeated. Ada's two-weapon attack hits **Health (axe, 3)** and **Sanity (cleaver, 4)** each turn; Ben's `vest` mitigates Health, `charm` raises his effective Sanity (the Health-damage mitigator).
2. The **light-vulnerability** branch fires on Ben (he is `light_averse` in a lit room) → the `×1.5` multiplier yields **fractional** `dealt` (assert at least one non-integer base stat appears in a snapshot).
3. `vest` wears each Health hit and **breaks** (durability 2→1→0); once broken it stops mitigating (assert a later hit deals more).
4. `axe` wears and **breaks** (2→1→0); the following Ada attack has only `cleaver` intact — and to exercise the natural-attack fallback, include one attack where BOTH weapons are broken (drive `cleaver` to 0 too), so Ada falls back to the **natural attack (Health, 1)** (assert that turn's damage equals the unarmed strike).
5. Ben's sanity crosses into `(0,5)` → **Fear** latches via reconcile; his health reaches `0` → **KO** transition (`defeated: true` in Ada's view; `on_knock_out` no-op).
6. Budget: each Ada `attack` shows `actionsThisRound` incrementing on Ada; Ben's `takeDamage`s never tick Ben's budget.

**Seed:** brute-force search seeds `1..500` (as in the afflictions fixture) for the first
seed under which the driven stream yields the intended timeline (Ben's start-turn clear rolls
do not prematurely shake off the afflictions the assertions require, and the KO lands on the
planned turn). Record it as `SEED` and in the golden.

**Determinism note:** the ONLY rng draws are Ben's start-turn clear rolls once he is
afflicted (Ada is affliction-free → her attack gate never draws; no movement/encounters).
The single shared `mulberry32(SEED)` injected into both PCs + campaign is exactly the Rust
`World.rng` sequence.

- [ ] **Step 1: Author the generator**

Create `conformance/fixtures/combat.gen.test.ts` following the afflictions template and the
content/stream/seed above. Register it in `conformance/fixtures/vitest.config.ts`.

- [ ] **Step 2: Add self-validation assertions (a throw fails generation)**

Inside the generator, after building the golden, assert every required event is present so a
mis-authored stream fails loudly:

```ts
// (a) at least one fractional base stat somewhere (proves the f64 damage path)
const anyFractional = golden.steps.some((s) =>
  ["health", "sanity", "energy"].some((k) =>
    s.snapshot.characters.some((c: any) => !Number.isInteger(c.stats[k]))));
if (!anyFractional) throw new Error("fixture must produce a fractional stat");

// (b) an armor piece breaks (durability reaches 0)
const armorBroke = golden.steps.some((s) =>
  s.snapshot.items.some((i: any) => i.behaviorKey === "items/vest" && i.durability === 0));
if (!armorBroke) throw new Error("fixture must break the vest");

// (c) a natural-attack fallback turn (both weapons broken)
//     assert a takeDamage of exactly the unarmed 1-Health strike after both weapons break
// (d) Ben reaches KO (defeated in Ada's view)
const koSeen = golden.steps.some((s) =>
  s.view.occupants?.some((o: any) => o.defeated === true));
if (!koSeen) throw new Error("fixture must KO Ben");

// (e) Fear latches on Ben at some step
const fearSeen = golden.steps.some((s) =>
  s.snapshot.characters.some((c: any) => c.afflictions?.active?.fear === true));
if (!fearSeen) throw new Error("fixture must latch Fear on Ben");
```

(Author assertion (c) concretely against the recorded `takeDamage` history/step for the
both-weapons-broken turn.)

- [ ] **Step 3: Generate the fixtures**

Run: `pnpm run fixtures:gen`
Expected: writes `conformance/fixtures/combat.start.snapshot.json`, `combat.catalog.json`,
`combat.golden.json`; no self-validation throw.

- [ ] **Step 4: Verify isolation**

Run: `git status --porcelain`
Expected: ONLY `conformance/fixtures/combat.gen.test.ts`, the three `combat.*.json` files,
and `conformance/fixtures/vitest.config.ts` are new/modified. If any other fixture
(`turn-movement.*`, `items-*.*`, `afflictions.*`, `seed.*`, `hollow-house.*`) churned,
restore it: `git checkout -- <path>`. No `packages/seed` change.

- [ ] **Step 5: Commit**

```bash
git add conformance/fixtures/combat.gen.test.ts conformance/fixtures/vitest.config.ts \
  conformance/fixtures/combat.start.snapshot.json conformance/fixtures/combat.catalog.json \
  conformance/fixtures/combat.golden.json
git commit -m "test(conformance): combat command stream + golden (sub-plan 4b)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Combat differential gate (`combat.test.ts`) + docs

Wire the Rust replay against the combat golden, step-by-step, and refresh the README.

**Files:**
- Create: `conformance/combat.test.ts`
- Modify: `README.md` (combat/mitigation section)

**Interfaces:**
- Consumes: `replay_commands(start, JSON.stringify(commands), catalog, seed)` (WASM — unchanged; `Command::Attack` flows through `apply_command`), the `combat.*.json` fixtures, `canonicalize` from `conformance/canonical-json.ts`.

- [ ] **Step 1: Write the differential test**

Create `conformance/combat.test.ts`, mirroring `conformance/afflictions.test.ts` exactly but
pointing at the `combat.*` fixtures and passing `golden.seed`:

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

const start = readFileSync(join(here, "fixtures/combat.start.snapshot.json"), "utf8");
const catalogJson = readFileSync(join(here, "fixtures/combat.catalog.json"), "utf8");
const golden = JSON.parse(
  readFileSync(join(here, "fixtures/combat.golden.json"), "utf8"),
) as {
  seed: number;
  commands: unknown[];
  steps: Array<{ command: unknown; cues: unknown; snapshot: unknown; view: unknown }>;
};

describe("combat differential conformance", () => {
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

- [ ] **Step 2: Run the differential gate**

Run: `pnpm run test:conformance`
Expected: PASS — all suites including `combat differential conformance`. If combat diverges,
**fix the Rust source in `combat.rs`** (the divergent step index localizes it); do NOT edit
the golden or the comparator.

- [ ] **Step 3: Refresh the README**

In `README.md`, confirm the combat/mitigation section reflects the shipped behavior: the
mitigation formula (`max(0, strength - armorSum) × max(0, 10 - mitigator) × 0.2 ×
(lightAverse&&lit ? 1.5 : 1)`), the `MitigatorStatType` cycle (Energy←Health←Sanity←Energy),
weapon-on-attack / armor-on-takeDamage durability wear, broken items neither dealing nor
mitigating, and KO-via-damage firing `onKnockOut`. Add only what is missing — do not
duplicate existing prose.

- [ ] **Step 4: Full gate**

Run: `pnpm run checks:phase3`
Expected: EXIT 0 — no_std build clean, `cargo test --workspace` green, bindings drift-clean,
all conformance suites green.

- [ ] **Step 5: Commit**

```bash
git add conformance/combat.test.ts README.md
git commit -m "test(conformance): combat differential gate + README combat refresh (sub-plan 4b)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Notes for the executor

- **Divergences are Rust bugs.** When the gate (Task 6) is red, the failing step index points
  at the mechanic; fix `combat.rs`. The afflictions gate caught real fidelity bugs the
  implementer missed in 4a — expect the same value here.
- **Draw-order discipline:** the only combat rng is the 4a Confused fizzle in `gate`. If a
  conformance snapshot's rng-dependent affliction diverges, suspect a stray draw or a missed
  one — not a math bug.
- **Borrow ordering** in `take_damage`/`attack`: the owned `worn` list is collected while the
  `equipped`/`armor`/`weapons` immutable borrows are live, then those borrows end before any
  `get_mut`/`set_durability`/`take_damage` (&mut self) call. Preserve that ordering.
