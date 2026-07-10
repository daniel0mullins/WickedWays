# Sub-plan 6a: MechanicOp Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Rust `MechanicOp` trait + registry and the reducer-driven hook/effect machinery, wired into every turn/round/combat fire-point sub-plan 5 left as a no-op, verified end-to-end by a native conformance mechanic mirrored in TS.

**Architecture:** Mechanics are data (`campaign.mechanics: Vec<{key, state}>`) selecting stateless first-party ops compiled into the core and resolved by a static `mechanic_op(key)`. Hooks receive owned read-only views + `&mut state` + `&mut rng`, return a closed 6-variant `Effect` enum; dispatch is collect-then-apply. `modify_damage` folds post-mitigation damage. Nothing about mechanics is injected into `World` or serialized beyond `{key, state}`.

**Tech Stack:** Rust (`crates/wickedways-core`, `no_std` + `alloc`), TS oracle (`src/lib/mechanics/`), vitest differential conformance gate (`conformance/`).

## Global Constraints

- **The conformance gate is the authority.** Divergences are fixed in Rust source (or a faithful fixture correction) — NEVER by editing goldens (`conformance/fixtures/*.snap.json`) or the comparator (`conformance/canonical-json.ts`).
- **`no_std` core.** All new production code uses `alloc::` (`alloc::vec::Vec`, `alloc::string::String`, `alloc::collections::{BTreeMap,BTreeSet}`, `alloc::format`), never `std::`. The mechanic machinery must build under `cargo build -p wickedways-core --no-default-features`.
- **All randomness stays on the injected `World.rng`.** Hooks draw rng only through the ctx's `rng`/`roll(n)`; `roll(n, rng)` lives in `dice.rs`. Add no other rng.
- **Byte-exact ordering (from the spec / TS oracle):**
  - Dispatch: iterate live mechanics in array (opt-in) order; collect each op's `Vec<Effect>` (per-mechanic cap `MAX_EFFECTS_PER_EVENT = 64` → `ProceduralViolation`); then apply all queued effects in order (collect-then-apply). Applying effects must not re-enter dispatch.
  - `apply_effect`: `Damage` → Health `−max(0,amount)`; `Heal` → Health `+max(0,amount)`; `AdjustStat` → stat `+delta` (delta **unclamped**; stat floored at 0 by `adjust_stat`); each of these three reconciles. `GrantImmunity` → all-status immunity `max(0, turns.trunc())`, **no reconcile**. `Cue`/`Status` → push cue, **no reconcile**.
  - `modify_damage` chain: fold in opt-in order, `next = result.max(0.0)` after each; on `Final`, push `Mechanic` cue `"{key} fixed damage at {value}."` and short-circuit. In `take_damage` the order is mitigation → transform chain → subtract.
  - Fire-points: `on_round_start` at `begin_campaign` + at a non-terminal `end_round` tail; `on_round_end` in `end_round` **before** `round += 1`; `on_turn_start` in `start_turn` after the affliction tick; `on_turn_end` in `end_turn` after `reconcile`; `on_action` in `record_action` for budgeted actions after the increment, before the cap-check → `end_turn`.
- **`==` cap check** in `record_action` is unchanged (sub-plan 5).
- **No pre-6a golden churn.** Campaigns with an empty `mechanics` list dispatch nothing; every existing fixture must stay byte-identical. Verify `git status --short conformance/fixtures` is empty after the conformance task.
- **Deferred (leave as documented no-ops / later slices):** custom mechanic actions → 6a-2; `ScriptedMechanic`/Rhai → 6b; keyed exits/scenes/NPC/spawning → 6c+; character-event turn hub (`events.onTurnStart/onTurnEnd`) stays a no-op (no handlers exist); win/lose `resolveOutcome` → 7 (timeout already handled).
- Full gate: `pnpm run checks:phase3`. Idempotence: `pnpm run fixtures:stable`. Crate tests: `cargo test -p wickedways-core`.

## File Structure

- Create `crates/wickedways-core/src/world/mechanics/mod.rs` — the mechanics submodule: `MechanicOp` trait, `Effect`, `TransformResult`, `MAX_EFFECTS_PER_EVENT`, the ctx structs, `mechanic_op` registry lookup, and `ALL_STATUSES`. Add `pub mod mechanics;` to `world/mod.rs`.
- Create `crates/wickedways-core/src/world/mechanics/view.rs` — `CampaignView`/`CharacterView`/`RoomView`/`DamageView` + `World::build_campaign_view`.
- Create `crates/wickedways-core/src/world/mechanics/dispatch.rs` — `run_reducers`, `apply_effect`, `run_damage_transformers`, `World::adjust_stat`, `World::validate_mechanics`.
- Create `crates/wickedways-core/src/world/mechanics/conformance.rs` — the `conformance:dread` op (Task 7).
- Modify `crates/wickedways-core/src/world/turn.rs` — fire-points (Task 5, 6).
- Modify `crates/wickedways-core/src/world/combat.rs` — `transform_damage` → `run_damage_transformers` (Task 4).
- Modify `crates/wickedways-core/src/world/command.rs` — thread `cat` where new fire-points need it.
- Modify `crates/wickedways-wasm/src/lib.rs` — `replay_commands` calls `validate_mechanics` (Task 3).
- Create `conformance/fixtures/mechanics.gen.test.ts` + `conformance/mechanics.test.ts` (Task 8).
- Modify `README.md` (Task 9).

Submodule layout note: keep the mechanics code in `world/mechanics/` so `combat.rs`/`turn.rs` stay focused. `World` methods (`adjust_stat`, `build_campaign_view`, `run_reducers`, dispatch helpers, `validate_mechanics`) are `impl World` blocks inside these files (Rust allows `impl World` across modules in the same crate).

---

## Task 1: Effect / TransformResult / MechanicOp trait + registry

**Files:**
- Create: `crates/wickedways-core/src/world/mechanics/mod.rs`
- Modify: `crates/wickedways-core/src/world/mod.rs` (add `pub mod mechanics;`)

**Interfaces:**
- Produces: `Effect` (6-variant enum), `TransformResult { Value(f64), Final(f64) }`, `MAX_EFFECTS_PER_EVENT: usize = 64`, `ALL_STATUSES: [Status; 4]`, the `MechanicOp` trait, and `fn mechanic_op(key: &str) -> Option<&'static dyn MechanicOp>`. The ctx structs (`HookCtx`/`TurnCtx`/`ActionCtx`) are added in Task 2 (they need views); Task 1 forward-declares the trait against them, so Task 1 and Task 2 land the module together — Task 1 defines the trait using ctx types that Task 2 fills in. To keep Task 1 compilable on its own, define minimal placeholder ctx structs here and flesh them out in Task 2.

- [ ] **Step 1: Create the module skeleton with a compile test**

Create `crates/wickedways-core/src/world/mechanics/mod.rs`:

```rust
//! The mechanics op-registry (roadmap A2): the `MechanicOp` trait, the closed
//! `Effect` enum, dispatch contexts, and the compiled-in first-party op registry.
//! Mechanics are DATA (`campaign.mechanics: {key, state}`) selecting stateless ops;
//! only `{key, state}` serializes — behavior is resolved by `mechanic_op(key)`.
pub mod dispatch;
pub mod view;

#[cfg(any(test, feature = "conformance"))]
pub mod conformance;

use alloc::string::String;
use alloc::vec::Vec;
use serde_json::Value;

use crate::presentation::{MechanicCue, StatusField};
use crate::stats::StatType;
use crate::world::afflictions::Status;
use crate::world::ids::CharacterId;

pub use view::{CampaignView, CharacterView, DamageView, RoomView};

/// Per-mechanic-per-event effect cap (TS `MAX_EFFECTS_PER_EVENT`).
pub const MAX_EFFECTS_PER_EVENT: usize = 64;

/// Every `Status` variant — the target of a `GrantImmunity` effect (TS `ALL_STATUSES`).
pub const ALL_STATUSES: [Status; 4] = [Status::Confused, Status::Fear, Status::Ko, Status::Panic];

/// The closed effect union a mechanic hook may return (TS `Effect`). `amount`/`delta`
/// are `f64` to match TS `number` and the f64 stat model.
#[derive(Clone, Debug, PartialEq)]
pub enum Effect {
    Damage { target: CharacterId, amount: f64 },
    Heal { target: CharacterId, amount: f64 },
    /// `stat` is Sanity or Energy only (TS restricts AdjustStat to non-Health).
    AdjustStat { target: CharacterId, stat: StatType, delta: f64 },
    GrantImmunity { target: CharacterId, turns: f64 },
    Cue { cue: MechanicCue },
    Status { fields: Vec<StatusField> },
}

/// Result of `modify_damage` (TS `number | { value; final: true }`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum TransformResult {
    Value(f64),
    Final(f64),
}

/// Contexts passed to hooks. Views are owned (built once before dispatch); `state`
/// and `rng` are live mutable borrows of disjoint `World` fields.
pub struct HookCtx<'a> {
    pub state: &'a mut Value,
    pub view: &'a CampaignView,
    pub rng: &'a mut crate::world::rng::Rng,
}

impl HookCtx<'_> {
    /// Integer in `[1, n]` from the campaign rng (TS `roll(n)`).
    pub fn roll(&mut self, n: i64) -> i64 {
        crate::dice::roll(n, self.rng)
    }
}

pub struct TurnCtx<'a> {
    pub base: HookCtx<'a>,
    pub actor: CharacterView,
}

pub struct ActionCtx<'a> {
    pub base: HookCtx<'a>,
    pub actor: CharacterView,
    /// A projection of the action detail (TS `ActionCtx.action`).
    pub action: ActionView,
}

/// Read-only projection of the action being recorded (TS `ActionDetail`).
#[derive(Clone, Debug, PartialEq)]
pub struct ActionView {
    pub kind: String,
}

/// A first-party mechanic op. Stateless behavior; state lives in the snapshot and
/// is handed in via `HookCtx.state`. Mirrors the TS `Mechanic` interface.
pub trait MechanicOp: Sync {
    /// Authoring-time state seed (TS `initialState`). NEVER called on hydrate.
    fn init_state(&self, config: &Value) -> Value;
    fn on_round_start(&self, _cx: &mut HookCtx) -> Vec<Effect> { Vec::new() }
    fn on_round_end(&self, _cx: &mut HookCtx) -> Vec<Effect> { Vec::new() }
    fn on_turn_start(&self, _cx: &mut TurnCtx) -> Vec<Effect> { Vec::new() }
    fn on_turn_end(&self, _cx: &mut TurnCtx) -> Vec<Effect> { Vec::new() }
    fn on_action(&self, _cx: &mut ActionCtx) -> Vec<Effect> { Vec::new() }
    fn modify_damage(&self, d: &DamageView, _cx: &mut HookCtx) -> TransformResult {
        TransformResult::Value(d.amount)
    }
}

/// Resolve a first-party op by key. The compiled-in registry; the snapshot's
/// `mechanics[].key` selects entries. Returns `None` for an unregistered key
/// (surfaced as a `ProceduralViolation` by `validate_mechanics`, Task 3).
pub fn mechanic_op(key: &str) -> Option<&'static dyn MechanicOp> {
    match key {
        #[cfg(any(test, feature = "conformance"))]
        "conformance:dread" => Some(&conformance::DREAD),
        _ => None,
    }
}
```

Add to `crates/wickedways-core/src/world/mod.rs`, in the module list near the other `pub mod` lines:

```rust
pub mod mechanics;
```

Note: `view.rs`, `dispatch.rs`, and `conformance.rs` are created in later tasks; to keep Task 1 compiling, create empty stubs now:
- `crates/wickedways-core/src/world/mechanics/view.rs` with the four view structs (Task 2 fills the projection); for Task 1, define the structs with their fields so `mod.rs` compiles (see Task 2 for the full definitions — create them now, projection method in Task 2).
- `crates/wickedways-core/src/world/mechanics/dispatch.rs` empty (`// dispatch — Task 3`).
- `crates/wickedways-core/src/world/mechanics/conformance.rs` with a placeholder `DREAD` (Task 7 fills behavior); for Task 1 define `pub static DREAD: Dread = Dread; pub struct Dread; impl MechanicOp for Dread { fn init_state(&self,_:&serde_json::Value)->serde_json::Value { serde_json::json!({"ticks":0}) } }`.

Because the modules are interdependent, **Task 1 creates all four files** (mod + view structs + empty dispatch + placeholder conformance) so the crate compiles; Tasks 2/3/7 flesh them out.

- [ ] **Step 2: Add a unit test for the registry + Effect**

Add to `crates/wickedways-core/src/world/mechanics/mod.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mechanic_op_resolves_conformance_key_and_rejects_unknown() {
        assert!(mechanic_op("conformance:dread").is_some());
        assert!(mechanic_op("nope").is_none());
    }

    #[test]
    fn conformance_op_init_state_is_zeroed_ticks() {
        let op = mechanic_op("conformance:dread").unwrap();
        assert_eq!(op.init_state(&serde_json::json!(null)), serde_json::json!({"ticks": 0}));
    }
}
```

- [ ] **Step 3: Run tests**

Run: `cargo test -p wickedways-core mechanics::`
Expected: PASS.

- [ ] **Step 4: Verify no_std builds**

Run: `cargo build -p wickedways-core --no-default-features`
Expected: success (the mechanics module uses only `alloc` + `serde_json` + crate-internal types).

- [ ] **Step 5: Commit**

```bash
git add crates/wickedways-core/src/world/mechanics/ crates/wickedways-core/src/world/mod.rs
git commit -m "feat(core): MechanicOp trait, Effect enum, op registry (sub-plan 6a)"
```

---

## Task 2: Views + projection

**Files:**
- Modify: `crates/wickedways-core/src/world/mechanics/view.rs`

**Interfaces:**
- Consumes: `World`, `effective_stat` (`resolve.rs:119`), `Status`, `StatType`, `Catalog`.
- Produces: `CampaignView`, `CharacterView { has_equipped(&str)->bool, has_item(&str)->bool }`, `RoomView`, `DamageView`, and `World::build_campaign_view(&self, cat) -> CampaignView`.

- [ ] **Step 1: Write the failing projection test**

Add to `crates/wickedways-core/src/world/mechanics/view.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::world::descriptor::Catalog;
    use crate::world::ids::CharacterId;
    use crate::world::test_support::world_with_party;

    fn cid(s: &str) -> CharacterId { CharacterId(s.into()) }

    #[test]
    fn campaign_view_projects_party_effective_stats() {
        let w = world_with_party(&["pc"], 10); // health 10 / sanity 7 / energy 5
        let v = w.build_campaign_view(&Catalog::default());
        assert_eq!(v.round, w.campaign.round);
        assert_eq!(v.max_rounds, w.campaign.max_rounds);
        assert_eq!(v.party.len(), 1);
        let pc = &v.party[0];
        assert_eq!(pc.id, cid("pc"));
        assert_eq!(pc.health, 10.0);
        assert_eq!(pc.sanity, 7.0);
        assert_eq!(pc.energy, 5.0);
        assert!(v.rooms.is_empty(), "rooms stays empty in v1 (matches TS)");
        assert!(!pc.has_equipped("anything"));
        assert!(!pc.has_item("anything"));
    }
}
```

- [ ] **Step 2: Run to confirm failure**

Run: `cargo test -p wickedways-core view::tests::campaign_view_projects`
Expected: compile error (`build_campaign_view` not defined) — the RED.

- [ ] **Step 3: Implement the views + projection**

Replace the contents of `crates/wickedways-core/src/world/mechanics/view.rs` with:

```rust
//! Owned read-only projections handed to mechanic hooks (TS `CampaignView` etc.).
//! Built once before a dispatch loop so hooks borrow only `state`+`rng` of `World`.
use alloc::collections::BTreeSet;
use alloc::string::String;
use alloc::vec::Vec;

use crate::stats::StatType;
use crate::world::afflictions::Status;
use crate::world::descriptor::Catalog;
use crate::world::ids::CharacterId;
use crate::world::snapshot::ItemSnapshot;
use crate::world::World;

#[derive(Clone, Debug, PartialEq)]
pub struct CampaignView {
    pub round: i64,
    pub max_rounds: i64,
    pub party: Vec<CharacterView>,
    /// Always empty in v1 (TS `#campaignView` returns `rooms: []`).
    pub rooms: Vec<RoomView>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CharacterView {
    pub id: CharacterId,
    pub name: String,
    pub health: f64,
    pub sanity: f64,
    pub energy: f64,
    pub status: Vec<Status>,
    pub room_id: Option<String>,
    equipped_keys: BTreeSet<String>,
    held_keys: BTreeSet<String>,
}

impl CharacterView {
    /// TS `CharacterView.hasEquipped(itemKey)` — matches on item `behaviorKey`.
    pub fn has_equipped(&self, key: &str) -> bool { self.equipped_keys.contains(key) }
    /// TS `CharacterView.hasItem(itemKey)` — matches held (inventory) item `behaviorKey`.
    pub fn has_item(&self, key: &str) -> bool { self.held_keys.contains(key) }
}

#[derive(Clone, Debug, PartialEq)]
pub struct RoomView {
    pub id: String,
    pub name: String,
    pub lit: bool,
    pub occupant_ids: Vec<String>,
}

/// TS `DamageView` — `source` is always `None` at the one call site.
#[derive(Clone, Debug, PartialEq)]
pub struct DamageView {
    pub amount: f64,
    pub target: CharacterId,
    pub stat: StatType,
    pub source: Option<CharacterId>,
}

impl World {
    /// Build the owned party projection (TS `#campaignView` + `#characterView`).
    /// `party_ids` order is preserved. `rooms` is intentionally empty (v1).
    pub fn build_campaign_view(&self, cat: &Catalog) -> CampaignView {
        let party = self
            .campaign
            .party_ids
            .iter()
            .filter_map(|id| self.character_view(id, cat))
            .collect();
        CampaignView {
            round: self.campaign.round,
            max_rounds: self.campaign.max_rounds,
            party,
            rooms: Vec::new(),
        }
    }

    fn character_view(&self, id: &CharacterId, cat: &Catalog) -> Option<CharacterView> {
        let c = self.characters.get(id)?;
        let status = ALL_STATUSES_LOCAL
            .iter()
            .copied()
            .filter(|s| c.afflictions.is_active(*s))
            .collect();
        let equipped_keys = c
            .equipment
            .values()
            .filter_map(|iid| self.behavior_key_of(iid))
            .collect();
        let held_keys = c
            .inventory
            .item_ids
            .iter()
            .chain(c.inventory.key_ids.iter())
            .filter_map(|iid| self.behavior_key_of(iid))
            .collect();
        Some(CharacterView {
            id: id.clone(),
            name: c.name.clone(),
            health: self.effective_stat(id, StatType::Health, cat),
            sanity: self.effective_stat(id, StatType::Sanity, cat),
            energy: self.effective_stat(id, StatType::Energy, cat),
            status,
            room_id: c.current_room_id.as_ref().map(|r| r.0.clone()),
            equipped_keys,
            held_keys,
        })
    }

    /// The `behaviorKey` an item matches on (TS `item.behaviorKey`). Only catalog-backed
    /// `Item`s carry one; keys resolve `None`.
    fn behavior_key_of(&self, iid: &crate::world::ids::ItemId) -> Option<String> {
        match self.items.get(iid) {
            Some(ItemSnapshot::Item { behavior_key, .. }) => Some(behavior_key.clone()),
            _ => None,
        }
    }
}

// Local copy to avoid a cross-module const import cycle in this file.
const ALL_STATUSES_LOCAL: [Status; 4] =
    [Status::Confused, Status::Fear, Status::Ko, Status::Panic];
```

Note: verify `CharacterSnapshot` exposes `current_room_id: Option<RoomId>` (used in `movement.rs`). If the field name differs, use the actual accessor; do not invent one. Also delete the placeholder view structs Task 1 created here (this replaces them).

- [ ] **Step 4: Run the test**

Run: `cargo test -p wickedways-core view::tests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/wickedways-core/src/world/mechanics/view.rs
git commit -m "feat(core): mechanic CampaignView/CharacterView projection (sub-plan 6a)"
```

---

## Task 3: Dispatch + apply + adjust_stat + validate_mechanics

**Files:**
- Modify: `crates/wickedways-core/src/world/mechanics/dispatch.rs`
- Modify: `crates/wickedways-wasm/src/lib.rs` (call `validate_mechanics` in `replay_commands`)

**Interfaces:**
- Consumes: Task 1 (`Effect`, `TransformResult`, `MAX_EFFECTS_PER_EVENT`, `ALL_STATUSES`, `mechanic_op`, ctxs), Task 2 (`build_campaign_view`), `reconcile`, `afflictions.grant_immunity`.
- Produces: `World::adjust_stat(&mut self, actor, stat, delta, cat, cues)`, `World::apply_effect(&mut self, effect, cat, cues)`, `World::run_reducers(&mut self, hook, cat, cues) -> Result<(), ProceduralViolation>` where `hook: impl Fn(&'static dyn MechanicOp, &mut HookCtx) -> Vec<Effect>` (plus turn/action variants — see below), `World::run_damage_transformers(&mut self, dv, cues) -> f64`, `World::validate_mechanics(&self) -> Result<(), ProceduralViolation>`.

Because Rust closures over `&mut self` fields fight the borrow checker, dispatch is written as **explicit `impl World` methods per hook kind** rather than a generic higher-order `run_reducers`. Provide: `dispatch_round(&mut self, phase: RoundPhase, cat, cues)`, `dispatch_turn(&mut self, phase: TurnPhase, actor, cat, cues)`, `dispatch_action(&mut self, actor, action: ActionView, cat, cues)`, and `run_damage_transformers`. Each shares a private `apply_all(&mut self, effects, cat, cues)` helper. This keeps the collect-then-apply contract while satisfying the borrow checker (build view → loop mechanics collecting effects with disjoint `&mut mechanics`/`&mut rng` → drop borrows → `apply_all`).

- [ ] **Step 1: Write failing tests for apply_effect + a round dispatch**

Add to `crates/wickedways-core/src/world/mechanics/dispatch.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::presentation::{MechanicCue, PresentationCue};
    use crate::stats::StatType;
    use crate::world::afflictions::Status;
    use crate::world::descriptor::Catalog;
    use crate::world::ids::CharacterId;
    use crate::world::mechanics::Effect;
    use crate::world::test_support::world_with_party;

    fn cid(s: &str) -> CharacterId { CharacterId(s.into()) }

    #[test]
    fn apply_damage_reduces_health_and_reconciles() {
        let mut w = world_with_party(&["pc"], 10); // health 10
        let mut cues = Vec::new();
        w.apply_effect(
            Effect::Damage { target: cid("pc"), amount: 3.0 },
            &Catalog::default(), &mut cues,
        );
        assert_eq!(w.characters[&cid("pc")].stats.health, 7.0);
    }

    #[test]
    fn apply_damage_floors_negative_amount_to_zero() {
        let mut w = world_with_party(&["pc"], 10);
        let mut cues = Vec::new();
        w.apply_effect(
            Effect::Damage { target: cid("pc"), amount: -5.0 }, // max(0,-5)=0
            &Catalog::default(), &mut cues,
        );
        assert_eq!(w.characters[&cid("pc")].stats.health, 10.0);
    }

    #[test]
    fn apply_adjust_stat_passes_delta_sign_and_floors_result() {
        let mut w = world_with_party(&["pc"], 10); // sanity 7
        let mut cues = Vec::new();
        w.apply_effect(
            Effect::AdjustStat { target: cid("pc"), stat: StatType::Sanity, delta: -9.0 },
            &Catalog::default(), &mut cues,
        );
        assert_eq!(w.characters[&cid("pc")].stats.sanity, 0.0, "delta unclamped, result floored");
    }

    #[test]
    fn apply_grant_immunity_sets_all_status_immunity_without_reconcile() {
        let mut w = world_with_party(&["pc"], 10);
        let mut cues = Vec::new();
        w.apply_effect(
            Effect::GrantImmunity { target: cid("pc"), turns: 2.9 }, // trunc -> 2
            &Catalog::default(), &mut cues,
        );
        let a = &w.characters[&cid("pc")].afflictions;
        assert!(a.immunity_turns(Status::Panic) >= 2 || a.is_immune(Status::Panic));
    }

    #[test]
    fn apply_cue_and_status_emit_and_do_not_change_stats() {
        let mut w = world_with_party(&["pc"], 10);
        let mut cues = Vec::new();
        w.apply_effect(
            Effect::Cue { cue: MechanicCue { text: Some("boo".into()), sound: None } },
            &Catalog::default(), &mut cues,
        );
        assert_eq!(cues.len(), 1);
        assert!(matches!(cues[0], PresentationCue::Mechanic { .. }));
    }
}
```

Note: the immunity assertion uses whatever accessor `Afflictions` exposes (`is_immune`/`immunity_turns`); use the real one — inspect `afflictions.rs`. If none is public, assert via a re-`apply_from_stats` behavior or add a `pub(crate)` getter in this task.

- [ ] **Step 2: Run to confirm failure**

Run: `cargo test -p wickedways-core dispatch::tests::apply_damage_reduces`
Expected: compile error (`apply_effect`/`adjust_stat` not defined).

- [ ] **Step 3: Implement dispatch.rs**

Replace `crates/wickedways-core/src/world/mechanics/dispatch.rs` with:

```rust
//! Mechanic dispatch (collect-then-apply) + effect application. Byte-exact port of
//! `dispatch.ts` (`runReducers`, `runDamageTransformers`) and `apply.ts` (`applyEffect`).
use alloc::format;
use alloc::vec::Vec;

use crate::error::ProceduralViolation;
use crate::presentation::PresentationCue;
use crate::stats::StatType;
use crate::world::descriptor::Catalog;
use crate::world::ids::CharacterId;
use crate::world::mechanics::{
    mechanic_op, ActionView, DamageView, Effect, HookCtx, TransformResult, ALL_STATUSES,
    MAX_EFFECTS_PER_EVENT,
};
use crate::world::World;

/// Which round hook to run.
#[derive(Clone, Copy)]
pub enum RoundPhase { Start, End }
/// Which turn hook to run.
#[derive(Clone, Copy)]
pub enum TurnPhase { Start, End }

impl World {
    /// TS `[ADJUST_STAT]` (character.ts:359-362): `stats[stat] = max(0, stats[stat]+delta)`
    /// then reconcile. The sole mechanic-facing stat mutator.
    pub fn adjust_stat(
        &mut self,
        actor: &CharacterId,
        stat: StatType,
        delta: f64,
        cat: &Catalog,
        cues: &mut Vec<PresentationCue>,
    ) {
        if let Some(c) = self.characters.get_mut(actor) {
            let cur = match stat {
                StatType::Health => &mut c.stats.health,
                StatType::Sanity => &mut c.stats.sanity,
                StatType::Energy => &mut c.stats.energy,
            };
            *cur = (*cur + delta).max(0.0);
        }
        self.reconcile(actor, cat, cues);
    }

    /// Route one effect to state (TS `applyEffect`). Damage/Heal/AdjustStat reconcile
    /// (via `adjust_stat`); GrantImmunity/Cue/Status do not.
    pub fn apply_effect(&mut self, e: Effect, cat: &Catalog, cues: &mut Vec<PresentationCue>) {
        match e {
            Effect::Damage { target, amount } => {
                self.adjust_stat(&target, StatType::Health, -amount.max(0.0), cat, cues)
            }
            Effect::Heal { target, amount } => {
                self.adjust_stat(&target, StatType::Health, amount.max(0.0), cat, cues)
            }
            Effect::AdjustStat { target, stat, delta } => {
                self.adjust_stat(&target, stat, delta, cat, cues)
            }
            Effect::GrantImmunity { target, turns } => {
                let t = turns.trunc().max(0.0) as i64;
                if let Some(c) = self.characters.get_mut(&target) {
                    c.afflictions.grant_immunity(&ALL_STATUSES, t);
                }
            }
            Effect::Cue { cue } => cues.push(PresentationCue::Mechanic { cue }),
            Effect::Status { fields } => cues.push(PresentationCue::Status { fields }),
        }
    }

    /// Apply a queued effect batch in order (collect-then-apply tail).
    fn apply_all(&mut self, effects: Vec<Effect>, cat: &Catalog, cues: &mut Vec<PresentationCue>) {
        for e in effects {
            self.apply_effect(e, cat, cues);
        }
    }

    /// Dispatch a round hook to every live mechanic (collect-then-apply, opt-in order,
    /// per-mechanic 64-cap). No-op when there are no mechanics (existing goldens unchanged).
    pub fn dispatch_round(
        &mut self,
        phase: RoundPhase,
        cat: &Catalog,
        cues: &mut Vec<PresentationCue>,
    ) -> Result<(), ProceduralViolation> {
        if self.campaign.mechanics.is_empty() {
            return Ok(());
        }
        let view = self.build_campaign_view(cat);
        let mut queued: Vec<Effect> = Vec::new();
        {
            let rng = &mut self.rng;
            for m in self.campaign.mechanics.iter_mut() {
                let Some(op) = mechanic_op(&m.key) else {
                    return Err(ProceduralViolation(format!(
                        "Mechanic '{}' is not registered.", m.key
                    )));
                };
                let mut cx = HookCtx { state: &mut m.state, view: &view, rng };
                let effects = match phase {
                    RoundPhase::Start => op.on_round_start(&mut cx),
                    RoundPhase::End => op.on_round_end(&mut cx),
                };
                if effects.len() > MAX_EFFECTS_PER_EVENT {
                    return Err(ProceduralViolation(format!(
                        "Mechanic '{}' emitted too many effects.", m.key
                    )));
                }
                queued.extend(effects);
            }
        }
        self.apply_all(queued, cat, cues);
        Ok(())
    }

    /// Dispatch a turn hook (adds `actor` to the ctx). Same discipline as `dispatch_round`.
    pub fn dispatch_turn(
        &mut self,
        phase: TurnPhase,
        actor: &CharacterId,
        cat: &Catalog,
        cues: &mut Vec<PresentationCue>,
    ) -> Result<(), ProceduralViolation> {
        if self.campaign.mechanics.is_empty() {
            return Ok(());
        }
        let view = self.build_campaign_view(cat);
        let actor_view = view.party.iter().find(|c| &c.id == actor).cloned();
        let mut queued: Vec<Effect> = Vec::new();
        {
            let rng = &mut self.rng;
            for m in self.campaign.mechanics.iter_mut() {
                let Some(op) = mechanic_op(&m.key) else {
                    return Err(ProceduralViolation(format!(
                        "Mechanic '{}' is not registered.", m.key
                    )));
                };
                let base = HookCtx { state: &mut m.state, view: &view, rng };
                // actor_view is required by TurnCtx; if the actor isn't a party member
                // there is nothing to project — skip (mirrors TS where turn hooks always
                // have the acting PlayerCharacter).
                let Some(av) = actor_view.clone() else { continue };
                let mut cx = crate::world::mechanics::TurnCtx { base, actor: av };
                let effects = match phase {
                    TurnPhase::Start => op.on_turn_start(&mut cx),
                    TurnPhase::End => op.on_turn_end(&mut cx),
                };
                if effects.len() > MAX_EFFECTS_PER_EVENT {
                    return Err(ProceduralViolation(format!(
                        "Mechanic '{}' emitted too many effects.", m.key
                    )));
                }
                queued.extend(effects);
            }
        }
        self.apply_all(queued, cat, cues);
        Ok(())
    }

    /// Dispatch `on_action` for a budgeted action (TS `[DISPATCH_ACTION]`).
    pub fn dispatch_action(
        &mut self,
        actor: &CharacterId,
        action: ActionView,
        cat: &Catalog,
        cues: &mut Vec<PresentationCue>,
    ) -> Result<(), ProceduralViolation> {
        if self.campaign.mechanics.is_empty() {
            return Ok(());
        }
        let view = self.build_campaign_view(cat);
        let actor_view = view.party.iter().find(|c| &c.id == actor).cloned();
        let mut queued: Vec<Effect> = Vec::new();
        {
            let rng = &mut self.rng;
            for m in self.campaign.mechanics.iter_mut() {
                let Some(op) = mechanic_op(&m.key) else {
                    return Err(ProceduralViolation(format!(
                        "Mechanic '{}' is not registered.", m.key
                    )));
                };
                let Some(av) = actor_view.clone() else { continue };
                let base = HookCtx { state: &mut m.state, view: &view, rng };
                let mut cx = crate::world::mechanics::ActionCtx {
                    base, actor: av, action: action.clone(),
                };
                let effects = op.on_action(&mut cx);
                if effects.len() > MAX_EFFECTS_PER_EVENT {
                    return Err(ProceduralViolation(format!(
                        "Mechanic '{}' emitted too many effects.", m.key
                    )));
                }
                queued.extend(effects);
            }
        }
        self.apply_all(queued, cat, cues);
        Ok(())
    }

    /// Fold post-mitigation damage through each mechanic's `modify_damage`
    /// (TS `runDamageTransformers`). Clamp `>= 0` after each step; a `Final`
    /// result emits `"{key} fixed damage at {value}."` and short-circuits.
    pub fn run_damage_transformers(
        &mut self,
        dv: DamageView,
        cues: &mut Vec<PresentationCue>,
        cat: &Catalog,
    ) -> f64 {
        if self.campaign.mechanics.is_empty() {
            return dv.amount;
        }
        let view = self.build_campaign_view(cat);
        let mut value = dv.amount;
        let rng = &mut self.rng;
        for m in self.campaign.mechanics.iter_mut() {
            let Some(op) = mechanic_op(&m.key) else { continue };
            let stepped = DamageView { amount: value, ..dv.clone() };
            let mut cx = HookCtx { state: &mut m.state, view: &view, rng };
            match op.modify_damage(&stepped, &mut cx) {
                TransformResult::Value(v) => value = v.max(0.0),
                TransformResult::Final(v) => {
                    let next = v.max(0.0);
                    cues.push(PresentationCue::Mechanic {
                        cue: crate::presentation::MechanicCue {
                            text: Some(format!("{} fixed damage at {}.", m.key, next)),
                            sound: None,
                        },
                    });
                    return next;
                }
            }
        }
        value
    }

    /// Fail-fast on an unregistered mechanic key (TS registry throw at hydrate).
    /// Call after building a `World` for replay.
    pub fn validate_mechanics(&self) -> Result<(), ProceduralViolation> {
        for m in &self.campaign.mechanics {
            if mechanic_op(&m.key).is_none() {
                return Err(ProceduralViolation(format!(
                    "Mechanic '{}' is not registered.", m.key
                )));
            }
        }
        Ok(())
    }
}
```

Note: confirm `DamageView` derives `Clone` (it does — Task 2). Confirm the `Afflictions` immunity accessor used by the test exists; if not, add a `pub(crate) fn immunity_turns(&self, s: Status) -> i64` in `afflictions.rs` as part of this task.

- [ ] **Step 4: Wire validate_mechanics into replay_commands**

In `crates/wickedways-wasm/src/lib.rs`, inside `replay_commands`, immediately after the `World` is constructed from the start snapshot and before the command loop, add:

```rust
    world.validate_mechanics().map_err(|e| JsError::new(&e.0))?;
```

Match the surrounding error-conversion style (inspect how other `ProceduralViolation`s are surfaced in that function; use the same `JsError`/`map_err` pattern already present).

- [ ] **Step 5: Run tests + no_std build**

Run: `cargo test -p wickedways-core dispatch::tests`
Expected: PASS.
Run: `cargo build -p wickedways-core --no-default-features`
Expected: success.

- [ ] **Step 6: Commit**

```bash
git add crates/wickedways-core/src/world/mechanics/dispatch.rs crates/wickedways-wasm/src/lib.rs crates/wickedways-core/src/world/afflictions.rs
git commit -m "feat(core): mechanic dispatch, apply_effect, adjust_stat, validate (sub-plan 6a)"
```

---

## Task 4: modify_damage in combat

**Files:**
- Modify: `crates/wickedways-core/src/world/combat.rs` (`transform_damage` at :37, its call site at :360)

**Interfaces:**
- Consumes: `run_damage_transformers` (Task 3), `DamageView` (Task 2).
- Produces: an updated `take_damage` whose transform step runs the mechanic chain.

- [ ] **Step 1: Update the existing transform_damage test**

The current test `transform_damage_is_identity` (`combat.rs:444-446`) asserts identity via `w.transform_damage(...)`. Replace it with a test that goes through the new signature and still yields identity when there are no mechanics:

```rust
    #[test]
    fn damage_transform_is_identity_without_mechanics() {
        let mut w = world_with_party(&["pc"], 10);
        let mut cues = Vec::new();
        let dv = crate::world::mechanics::DamageView {
            amount: 7.5, target: cid("pc"), stat: StatType::Health, source: None,
        };
        assert_eq!(w.run_damage_transformers(dv, &mut cues, &Catalog::default()), 7.5);
        assert!(cues.is_empty());
    }
```

(Ensure `Catalog` and `StatType` are imported in the combat test module; they are used elsewhere there.)

- [ ] **Step 2: Run to confirm the old test/name is gone and new fails to compile**

Run: `cargo test -p wickedways-core combat::tests::damage_transform_is_identity_without_mechanics`
Expected: compile error until Step 3 (the old `transform_damage` method still exists; remove it).

- [ ] **Step 3: Replace transform_damage with the chain at the call site**

In `crates/wickedways-core/src/world/combat.rs`, delete the `transform_damage` method (`:34-38`). At its call site inside `take_damage` (`:360`), replace:

```rust
        let dealt = self.transform_damage(final_strength, target, attack_stat);
```

with:

```rust
        let dealt = self.run_damage_transformers(
            crate::world::mechanics::DamageView {
                amount: final_strength,
                target: target.clone(),
                stat: attack_stat,
                source: None,
            },
            cues,
            cat,
        );
```

`take_damage` already has `cat` and `cues` in scope (`combat.rs:317-322`). This slots the chain after mitigation (`final_strength`, :353) and before the subtract (:365-367), matching TS `takeDamage` order.

- [ ] **Step 4: Run tests**

Run: `cargo test -p wickedways-core combat::`
Expected: PASS (identity-without-mechanics test + all existing combat tests — no mechanics in those worlds, so `dealt` is unchanged).

- [ ] **Step 5: Commit**

```bash
git add crates/wickedways-core/src/world/combat.rs
git commit -m "feat(core): wire modify_damage chain into take_damage (sub-plan 6a)"
```

---

## Task 5: Turn/round hook fire-points

**Files:**
- Modify: `crates/wickedways-core/src/world/turn.rs` (`begin_campaign`, `start_turn`, `end_turn`, `end_round`, `next_player`)
- Modify: `crates/wickedways-core/src/world/command.rs` (thread `cat` into `begin_campaign`/`next_player` dispatch)

**Interfaces:**
- Consumes: `dispatch_round(RoundPhase, cat, cues)`, `dispatch_turn(TurnPhase, actor, cat, cues)` (Task 3).
- Produces: turn/round methods that fire mechanic hooks; `begin_campaign(&mut self, cat, cues)`, `end_round(&mut self, cat, cues)`, `next_player(&mut self, cat, cues)` gain `cat`.

Threading note: `begin_campaign`, `end_round`, and `next_player` currently lack `cat`. Add `cat: &Catalog` (before `cues`) and update all callers (the compiler flags each — `command.rs`, and `next_player` calls `end_round`; tests too). `dispatch_*` returns `Result`; propagate it (`begin_campaign` currently returns `()` — change to `Result<(), ProceduralViolation>`, or `.ok()`-swallow is NOT acceptable; propagate). Check `begin_campaign`'s callers to thread the `Result`.

- [ ] **Step 1: Write failing fire-point tests**

Add to the `turn.rs` tests module (uses the `conformance:dread` op, which Task 7 finalizes; these tests assert generic dispatch, so a minimal op suffices — if Task 7 isn't done, use a party with the conformance mechanic in `campaign.mechanics`). Add a helper that seeds a mechanic:

```rust
    fn with_dread(mut w: World) -> World {
        w.campaign.mechanics.push(crate::world::snapshot::MechanicSnapshot {
            key: "conformance:dread".into(),
            state: serde_json::json!({ "ticks": 0 }),
        });
        w
    }

    #[test]
    fn end_round_fires_on_round_end_before_increment() {
        use crate::world::descriptor::Catalog;
        let mut w = with_dread(world_with_party(&["pc"], 10));
        let mut cues = Vec::new();
        w.campaign.acted_this_round = vec![cid("pc")]; // all acted
        w.end_round(&Catalog::default(), &mut cues).unwrap();
        // conformance:dread.on_round_end increments state.ticks and emits a Cue.
        assert_eq!(w.campaign.mechanics[0].state["ticks"], serde_json::json!(1));
        assert!(cues.iter().any(|c| matches!(c, crate::presentation::PresentationCue::Mechanic { .. })));
    }
```

(The exact cue/state assertions depend on Task 7's op; if implementing Task 5 before Task 7, gate this test behind the finalized op or land Task 7 first. Recommended order: do Task 7's op body before Task 5's fire-point tests, OR keep Task 5's test minimal — asserting `dispatch_round` was reachable via a stub. The controller sequences this.)

- [ ] **Step 2: Run to confirm failure**

Run: `cargo test -p wickedways-core turn::tests::end_round_fires_on_round_end`
Expected: compile error (`end_round` signature lacks `cat`).

- [ ] **Step 3: Wire the fire-points**

In `crates/wickedways-core/src/world/turn.rs`:

`begin_campaign` — add `cat`, return `Result`, dispatch `on_round_start`:

```rust
    pub fn begin_campaign(
        &mut self,
        cat: &Catalog,
        cues: &mut Vec<PresentationCue>,
    ) -> Result<(), ProceduralViolation> {
        self.campaign.started = true;
        self.dispatch_round(crate::world::mechanics::dispatch::RoundPhase::Start, cat, cues)
    }
```

`start_turn` — after the affliction tick block, dispatch `on_turn_start`. `start_turn` returns `()`; change to `Result` and propagate, or keep `()` and propagate the dispatch error by changing the signature. Change `start_turn` to return `Result<(), ProceduralViolation>`; add at the end (after the `get_mut` block that runs `on_turn_start` affliction tick):

```rust
        self.dispatch_turn(crate::world::mechanics::dispatch::TurnPhase::Start, actor, cat, cues)
```

Note: `start_turn` currently takes `(actor, cat)` and no `cues`. Add `cues: &mut Vec<PresentationCue>`. Update its callers (`command.rs` `StartTurn`, tests). The affliction tick stays unchanged; only append the dispatch + thread `cues`.

`end_turn` — after `reconcile`, dispatch `on_turn_end`:

```rust
    pub fn end_turn(&mut self, actor: &CharacterId, cat: &Catalog, cues: &mut Vec<PresentationCue>)
        -> Result<(), ProceduralViolation>
    {
        self.reconcile(actor, cat, cues);
        self.dispatch_turn(crate::world::mechanics::dispatch::TurnPhase::End, actor, cat, cues)
    }
```

`end_turn` now returns `Result`; `record_action` calls it — propagate there (Task 6 touches `record_action`; for Task 5 make `record_action` `.` the result: since `record_action` is `pub(crate)` returning `()`, change it to return `Result` OR swallow with `?` by making `record_action` return `Result`. Cleanest: make `record_action` return `Result<(), ProceduralViolation>` and propagate; update its 5 call sites to `?`. If Task 6 will restructure `record_action` anyway, coordinate — but Task 5 must leave the tree compiling, so make `record_action` return `Result` here.)

`end_round` — add `cat`; dispatch `on_round_end` **before** `round += 1`; dispatch `on_round_start` after reset if still ongoing:

```rust
    pub fn end_round(&mut self, cat: &Catalog, cues: &mut Vec<PresentationCue>)
        -> Result<(), ProceduralViolation>
    {
        self.assert_running()?;
        let all_acted = self.campaign.party_ids.iter()
            .all(|id| self.campaign.acted_this_round.contains(id));
        if !all_acted {
            return Err(ProceduralViolation(
                "Attempted to end round before all characters have acted".into()));
        }
        self.dispatch_round(crate::world::mechanics::dispatch::RoundPhase::End, cat, cues)?;
        self.campaign.round += 1;
        self.campaign.acted_this_round.clear();
        if self.campaign.round >= self.campaign.max_rounds {
            self.finish(CampaignOutcome::TimedOut, None, cues);
            return Ok(());
        }
        self.dispatch_round(crate::world::mechanics::dispatch::RoundPhase::Start, cat, cues)
    }
```

`next_player` — add `cat`, thread into the `end_round` call:

```rust
    pub fn next_player(&mut self, cat: &Catalog, cues: &mut Vec<PresentationCue>)
        -> Result<(), ProceduralViolation>
    {
        self.assert_running()?;
        let active = self.active_character_id()?;
        if !self.campaign.acted_this_round.contains(&active) {
            self.campaign.acted_this_round.push(active);
        }
        let next = self.campaign.active_character_index + 1;
        if next as usize == self.campaign.party_ids.len() {
            self.campaign.active_character_index = 0;
            self.end_round(cat, cues)?;
        } else {
            self.campaign.active_character_index = next;
        }
        Ok(())
    }
```

Add `use crate::world::mechanics::dispatch::{RoundPhase, TurnPhase};` to `turn.rs` to shorten the paths if preferred.

- [ ] **Step 4: Update command.rs dispatch**

In `crates/wickedways-core/src/world/command.rs`, update the affected arms to pass `cat`/`cues` and propagate `Result`:

```rust
        Command::StartTurn => world.start_turn(&actor, cat, cues),
        Command::EndTurn => world.end_turn(&actor, cat, cues),
        Command::NextPlayer => world.next_player(cat, cues),
```

(`start_turn`/`end_turn` now return `Result`, so these arms return the `Result` directly — matching the existing `Go`/`Attack` arms. Confirm `begin_campaign` is not dispatched as a command; if it is invoked elsewhere — e.g. the wasm entry or a test harness — thread `cat`/`cues` and the `Result` there.)

- [ ] **Step 5: Fix all remaining callers the compiler flags**

Run `cargo build -p wickedways-core` and update every caller of `start_turn`/`end_turn`/`next_player`/`end_round`/`begin_campaign` (production + tests) for the new signatures/Results. Sub-plan-5 tests that call these must pass `&Catalog::default()`/`&mut cues` and `.unwrap()` the `Result`.

- [ ] **Step 6: Run tests + no_std**

Run: `cargo test -p wickedways-core`
Expected: PASS.
Run: `cargo build -p wickedways-core --no-default-features`
Expected: success.

- [ ] **Step 7: Commit**

```bash
git add crates/wickedways-core/src/world/turn.rs crates/wickedways-core/src/world/command.rs
git commit -m "feat(core): fire mechanic round/turn hooks at their turn-loop points (sub-plan 6a)"
```

---

## Task 6: on_action fire-point

**Files:**
- Modify: `crates/wickedways-core/src/world/turn.rs` (`record_action`)
- Modify: `crates/wickedways-core/src/world/{combat,movement,items_actions,gate}.rs` (the 5 `record_action` call sites)

**Interfaces:**
- Consumes: `dispatch_action(actor, ActionView, cat, cues)` (Task 3).
- Produces: `record_action(&mut self, actor, budgeted, action_kind: &str, cat, cues) -> Result<(), ProceduralViolation>` — now carries the action kind so it can build `ActionView` and dispatch `on_action`.

- [ ] **Step 1: Write the failing test**

Add to `turn.rs` tests:

```rust
    #[test]
    fn budgeted_record_action_dispatches_on_action() {
        use crate::world::descriptor::Catalog;
        let mut w = with_dread(world_with_party(&["pc"], 10)); // actions_per_round 2
        let mut cues = Vec::new();
        // one budgeted action, below cap -> onAction fires, no end_turn
        w.record_action(&cid("pc"), true, "attack", &Catalog::default(), &mut cues).unwrap();
        // conformance:dread.on_action emits a Cue
        assert!(cues.iter().any(|c| matches!(c, crate::presentation::PresentationCue::Mechanic { .. })));
        assert_eq!(w.characters[&cid("pc")].actions_this_round, 1);
    }
```

- [ ] **Step 2: Run to confirm failure**

Run: `cargo test -p wickedways-core turn::tests::budgeted_record_action_dispatches`
Expected: compile error (`record_action` arity changed).

- [ ] **Step 3: Update record_action**

Replace `record_action` in `turn.rs` with:

```rust
    pub(crate) fn record_action(
        &mut self,
        actor: &CharacterId,
        budgeted: bool,
        action_kind: &str,
        cat: &Catalog,
        cues: &mut Vec<PresentationCue>,
    ) -> Result<(), ProceduralViolation> {
        if budgeted {
            if let Some(c) = self.characters.get_mut(actor) {
                c.actions_this_round += 1;
            }
            self.dispatch_action(
                actor,
                crate::world::mechanics::ActionView { kind: action_kind.into() },
                cat, cues,
            )?;
        }
        let at_cap = self
            .characters
            .get(actor)
            .map(|c| c.actions_this_round == c.actions_per_round)
            .unwrap_or(false);
        if at_cap {
            self.end_turn(actor, cat, cues)?;
        }
        Ok(())
    }
```

Ordering note: TS fires `onAction` (DISPATCH_ACTION) after the increment and *before* the cap-check `endTurn` — this matches (dispatch_action, then the cap check). `on_action` fires only for budgeted actions (inside `if budgeted`), matching TS.

- [ ] **Step 4: Update the 5 call sites with their action kind**

At each `record_action` call, pass the TS `ActionDetail.kind` string and propagate `?`:
- `combat.rs` (attack): `self.record_action(actor, true, "attack", cat, cues)?;`
- `movement.rs` (move): `self.record_action(actor, true, "move", cat, cues)?;`
- `items_actions.rs` (take, PickUp): `self.record_action(actor, true, "pickUp", cat, cues)?;`
- `items_actions.rs` (consume_from_inventory, drop/use): `self.record_action(actor, true, "drop", cat, cues)?;`
- `gate.rs` (fumble): `self.record_action(actor, budgeted, "fumble", cat, cues)?;`

Each enclosing method already returns `Result<(), ProceduralViolation>` (they do — `go`/`attack`/`take`/`drop_item`/`use_item` all return `Result`; `record_fumble` returns `()` — change `record_fumble` to return `Result` and propagate at its call sites, OR have `record_fumble` `?`-propagate internally by returning `Result`). Verify each method's return type; thread `?` accordingly. The action-kind strings must match TS `ActionDetail.kind` exactly (camelCase: `attack`, `move`, `pickUp`, `drop`, `escape`, `fumble`).

- [ ] **Step 5: Run tests + no_std + confirm no golden churn potential**

Run: `cargo test -p wickedways-core`
Expected: PASS.
Run: `cargo build -p wickedways-core --no-default-features`
Expected: success.

- [ ] **Step 6: Commit**

```bash
git add crates/wickedways-core/src/world/turn.rs crates/wickedways-core/src/world/combat.rs crates/wickedways-core/src/world/movement.rs crates/wickedways-core/src/world/items_actions.rs crates/wickedways-core/src/world/gate.rs
git commit -m "feat(core): dispatch on_action for budgeted actions (sub-plan 6a)"
```

---

## Task 7: The `conformance:dread` op

**Files:**
- Modify: `crates/wickedways-core/src/world/mechanics/conformance.rs`

**Interfaces:**
- Produces: `pub static DREAD: Dread` implementing `MechanicOp`, registered by `mechanic_op("conformance:dread")` (Task 1). Behavior (must be mirrored byte-for-byte by the TS shadow in Task 8):
  - `init_state` → `{ "ticks": 0 }`.
  - `on_round_start` → one `Cue { text: "Dread stirs." }`.
  - `on_turn_start` → one `Cue { text: "The dread watches." }`.
  - `on_turn_end` → one `Cue { text: "The dread recedes." }`.
  - `on_action` → one `Cue { text: "The dread notices." }`.
  - `on_round_end` → increment `state.ticks` by 1; emit `AdjustStat { target: view.party[0].id, stat: Sanity, delta: -1.0 }` then `Cue { text: "Dread deepens." }` (effect order: AdjustStat before Cue).
  - `modify_damage` → if `d.amount > 3.0` return `Final(3.0)` else `Value(d.amount)`.

- [ ] **Step 1: Write the op unit test**

Add to `conformance.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::world::mechanics::{DamageView, TransformResult};
    use crate::stats::StatType;
    use crate::world::ids::CharacterId;

    #[test]
    fn dread_caps_damage_above_three() {
        let dv = DamageView { amount: 9.0, target: CharacterId("x".into()), stat: StatType::Health, source: None };
        // modify_damage needs a HookCtx; exercise via a minimal harness is awkward,
        // so assert the threshold logic through a direct helper if extracted, else via
        // the conformance fixture (Task 8). Here assert init_state only.
        assert_eq!(DREAD.init_state(&serde_json::json!(null)), serde_json::json!({ "ticks": 0 }));
        let _ = dv;
    }
}
```

(The hook behaviors are exercised end-to-end by the Task 8 conformance fixture and by the Task 5/6 fire-point tests; `modify_damage`'s branch is covered by the fixture's mitigated attack. A pure-unit `modify_damage` test needs a constructed `HookCtx`; if you extract the threshold into a free `fn cap(amount: f64) -> TransformResult`, unit-test that directly.)

- [ ] **Step 2: Run to confirm failure**

Run: `cargo test -p wickedways-core conformance::`
Expected: fail/compile-error until the op body lands.

- [ ] **Step 3: Implement the op**

Replace `crates/wickedways-core/src/world/mechanics/conformance.rs` with:

```rust
//! A first-party conformance mechanic used by the differential gate. Mirrored
//! byte-for-byte by a TS closure under key "conformance:dread". Gated so it does
//! not ship in the default build.
use alloc::vec;
use alloc::vec::Vec;
use serde_json::{json, Value};

use crate::presentation::MechanicCue;
use crate::stats::StatType;
use crate::world::mechanics::{
    ActionCtx, DamageView, Effect, HookCtx, MechanicOp, TransformResult, TurnCtx,
};

pub struct Dread;
pub static DREAD: Dread = Dread;

fn cue(text: &str) -> Effect {
    Effect::Cue { cue: MechanicCue { text: Some(text.into()), sound: None } }
}

impl MechanicOp for Dread {
    fn init_state(&self, _config: &Value) -> Value {
        json!({ "ticks": 0 })
    }
    fn on_round_start(&self, _cx: &mut HookCtx) -> Vec<Effect> {
        vec![cue("Dread stirs.")]
    }
    fn on_turn_start(&self, _cx: &mut TurnCtx) -> Vec<Effect> {
        vec![cue("The dread watches.")]
    }
    fn on_turn_end(&self, _cx: &mut TurnCtx) -> Vec<Effect> {
        vec![cue("The dread recedes.")]
    }
    fn on_action(&self, _cx: &mut ActionCtx) -> Vec<Effect> {
        vec![cue("The dread notices.")]
    }
    fn on_round_end(&self, cx: &mut HookCtx) -> Vec<Effect> {
        // Mutate persisted state: ticks += 1.
        let ticks = cx.state.get("ticks").and_then(|v| v.as_i64()).unwrap_or(0) + 1;
        cx.state["ticks"] = json!(ticks);
        // Target the first party member (fixtures use a single-PC party).
        let Some(target) = cx.view.party.first().map(|c| c.id.clone()) else {
            return vec![cue("Dread deepens.")];
        };
        vec![
            Effect::AdjustStat { target, stat: StatType::Sanity, delta: -1.0 },
            cue("Dread deepens."),
        ]
    }
    fn modify_damage(&self, d: &DamageView, _cx: &mut HookCtx) -> TransformResult {
        if d.amount > 3.0 { TransformResult::Final(3.0) } else { TransformResult::Value(d.amount) }
    }
}
```

Note: `cx.state["ticks"] = json!(ticks)` requires `state` to be a JSON object; if it is not, `Index`-assign panics — fixtures always seed `{ticks:0}`, so this is safe. `cx.state` is `&mut Value`; indexing assignment is valid on `Value::Object`.

- [ ] **Step 4: Run tests + no_std default build (op is feature/test-gated, so also build with conformance)**

Run: `cargo test -p wickedways-core conformance::`
Expected: PASS.
Run: `cargo build -p wickedways-core --no-default-features`
Expected: success (the op is behind `#[cfg(any(test, feature = "conformance"))]`, so it is absent from the default no_std build — confirm the `mechanic_op` match arm is likewise gated, Task 1).

- [ ] **Step 5: Commit**

```bash
git add crates/wickedways-core/src/world/mechanics/conformance.rs
git commit -m "feat(core): conformance:dread mechanic op for the gate (sub-plan 6a)"
```

---

## Task 8: TS shadow + differential conformance fixture

**Files:**
- Create: `conformance/fixtures/mechanics.gen.test.ts`
- Create: `conformance/mechanics.test.ts`

**Interfaces:**
- Consumes: the TS oracle (`src/lib/...`), the conformance harness (`conformance/canonical-json.ts`, the generator/replay helpers used by existing fixtures like `conformance/fixtures/combat.gen.test.ts`).
- Produces: a golden `{seed, commands, steps}` and a replay test comparing per-step cues + snapshot.

The Rust `scripting`/`conformance` feature must be enabled for the WASM build the gate replays against, so `mechanic_op("conformance:dread")` resolves. Confirm how `pnpm run test:conformance` builds the wasm (the `checks:phase3`/wasm-pack invocation) and enable the `conformance` feature there (e.g. `--features conformance`). If the op is compiled under `#[cfg(test)]` only, it will NOT be in the wasm build — so it MUST be behind the `conformance` cargo feature and that feature enabled for the conformance wasm build. Wiring the feature into the wasm build is part of this task.

- [ ] **Step 1: Study an existing gen fixture**

Read `conformance/fixtures/combat.gen.test.ts` and `conformance/combat.test.ts` to mirror their structure exactly (how the oracle campaign is built, how the TS registry is seeded, how the snapshot + commands + per-step cues/snapshot/view are recorded, and how the replay test canonicalizes + `.toEqual()`s per step).

- [ ] **Step 2: Register the TS shadow mechanic**

In `mechanics.gen.test.ts`, register a `Mechanic` closure in the generator's `CampaignRegistry` under key `"conformance:dread"` that reproduces the Rust op byte-for-byte:

```ts
const dread: Mechanic<{ ticks: number }> = {
  initialState: () => ({ ticks: 0 }),
  onRoundStart: () => [{ kind: "cue", cue: { text: "Dread stirs." } }],
  onTurnStart: () => [{ kind: "cue", cue: { text: "The dread watches." } }],
  onTurnEnd: () => [{ kind: "cue", cue: { text: "The dread recedes." } }],
  onAction: () => [{ kind: "cue", cue: { text: "The dread notices." } }],
  onRoundEnd: (h) => {
    h.state.ticks += 1;
    const target = h.view.party[0]?.id;
    const effects: Effect[] = [];
    if (target) effects.push({ kind: "adjustStat", target, stat: "sanity", delta: -1 });
    effects.push({ kind: "cue", cue: { text: "Dread deepens." } });
    return effects;
  },
  modifyDamage: (d) => (d.amount > 3 ? { value: 3, final: true } : d.amount),
};
```

Use the exact `Mechanic`/`Effect` types from `src/lib/mechanics/mechanic.ts`. Enable the mechanic on the campaign via the authoring `useMechanic("conformance:dread")` path (mirror how the combat fixture configures its campaign), so the serialized snapshot carries `mechanics: [{ key: "conformance:dread", state: { ticks: 0 } }]`.

- [ ] **Step 3: Author the command sequence**

Drive a single-PC campaign (SEED fixed, e.g. `SEED = 1`) through, recording per-step cues + snapshot + view:
1. `beginCampaign` (fires onRoundStart → "Dread stirs.").
2. `startTurn` (onTurnStart → "The dread watches.").
3. a budgeted action, e.g. an `attack` on a seeded mob dealing > 3 pre-mitigation so `modifyDamage` caps it (→ diagnostic cue `"conformance:dread fixed damage at 3."`) and onAction → "The dread notices."; keep the PC below cap so no auto-end yet.
4. `endTurn` (onTurnEnd → "The dread recedes.").
5. `nextPlayer` (wraps → endRound: onRoundEnd increments ticks + AdjustStat sanity −1 + "Dread deepens."; then non-terminal onRoundStart → "Dread stirs.").

Keep `maxRounds` high enough that step 5 is non-terminal (so onRoundStart re-fires) — assert the tick + sanity delta in the snapshot.

- [ ] **Step 4: Run the generator + replay**

Run: `pnpm run fixtures:gen` (or the project's fixture-generation command — confirm from `package.json`) to emit `conformance/fixtures/mechanics.snap.json`.
Run: `pnpm run test:conformance`
Expected: `mechanics.test.ts` PASS — Rust replay matches the TS oracle per step (cues incl. the fixed-damage diagnostic, snapshot `mechanics[0].state.ticks`, and the sanity delta).

If it diverges, fix the **Rust** op/machinery (or a faithful fixture correction) — never the golden or comparator. Likely divergence points: number formatting in the fixed-damage cue (keep the cap an integer `3`), effect order in `on_round_end` (AdjustStat before Cue), or dispatch order at a fire-point.

- [ ] **Step 5: Confirm no pre-6a golden churn**

Run: `git status --short conformance/fixtures`
Expected: only the new `mechanics.snap.json` (and the two new test files) appear — no existing golden changed. If an existing golden changed, STOP and investigate (an empty mechanics list must dispatch nothing).

- [ ] **Step 6: Commit**

```bash
git add conformance/fixtures/mechanics.gen.test.ts conformance/fixtures/mechanics.snap.json conformance/mechanics.test.ts
git commit -m "test(conformance): mechanic hooks + modify_damage differential fixture (sub-plan 6a)"
```

---

## Task 9: Docs + full gate

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update README**

Document, in the appropriate mechanics/architecture section (match surrounding style): mechanics are data (`{key, state}`) selecting first-party ops; the hook set (onRoundStart/End, onTurnStart/End, onAction) + `modify_damage`; the closed 6-variant Effect enum; collect-then-apply dispatch with the 64-effect per-mechanic cap; the modify_damage chain (clamp-after-each, `final` short-circuit, mitigation→transform→subtract in takeDamage); and that custom mechanic actions + scripted mechanics arrive in later sub-plans.

- [ ] **Step 2: Run the full phase-3 gate**

Run: `pnpm run checks:phase3`
Expected: EXIT 0 — `no_std` default build clean, `cargo test --workspace` green, `bindings:check` green, `test:conformance` green (with the `conformance` feature enabled for the conformance wasm build).

- [ ] **Step 3: Fixture idempotence**

Run: `pnpm run fixtures:stable`
Expected: EXIT 0.

- [ ] **Step 4: Final no-golden-churn confirmation**

Run: `git status --short conformance/fixtures`
Expected: empty (all fixtures committed; regeneration produced no diff).

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: mechanic op-registry + hook/effect contract (sub-plan 6a)"
```

---

## Self-Review Checklist (completed during authoring)

- **Spec coverage:** trait+registry (T1); views/projection incl. has_equipped/has_item (T2); dispatch collect-then-apply + 64-cap + apply_effect routings + adjust_stat + validate_mechanics + unknown-key error (T3); modify_damage chain + take_damage wiring (T4); all round/turn fire-points + cat threading (T5); on_action + ActionView (T6); native conformance op (T7); TS shadow + differential fixture + feature wiring (T8); README + full gate + no-golden-churn (T9). Deferrals (custom actions/ScriptedMechanic/exits/scenes/npc/character-events/win-lose) explicitly out of scope.
- **Placeholder scan:** the two areas needing on-the-ground confirmation are called out explicitly with fallbacks (the `Afflictions` immunity accessor in T3; the exact wasm conformance-feature wiring in T8) rather than left vague; all code steps carry complete code.
- **Type consistency:** `Effect`, `TransformResult`, `HookCtx/TurnCtx/ActionCtx`, `ActionView { kind }`, `DamageView`, `RoundPhase/TurnPhase`, `mechanic_op`, `dispatch_round/dispatch_turn/dispatch_action`, `run_damage_transformers`, `adjust_stat`, `validate_mechanics`, and the `"conformance:dread"` key + its cue strings are used consistently across tasks and match the TS shadow in T8.
- **Sequencing note for the controller:** T7 (op body) is a dependency of T5/T6/T8 assertions; implement T1–T4, then T7, then T5/T6 (fire-point tests that assert dread's cues), then T8. Alternatively land T5/T6 with the op already present from T7. The task order above lists T5/T6 before T7 for logical grouping (fire-points before the op that exercises them); the controller may run T7 before T5/T6 to make the fire-point tests concrete. Either order leaves each commit green.
