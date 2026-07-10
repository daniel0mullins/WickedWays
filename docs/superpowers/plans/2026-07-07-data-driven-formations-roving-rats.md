# Data-Driven Formations + Roving Rats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`). The Rust descriptor build and the TS `descriptorToFormation` build must stay byte-identical after serialization — the differential spawn fixture (Task 6) is the real safety net; treat Tasks 1–6 as coupled around it.

**Goal:** Make formations authorable as data (a `Catalog.formations` descriptor table interpreted by the core, mirrored by the TS oracle), then add roving Rats to Hollow House — a farm mob (Health 2, natural attack `{Health,1}`) spawning as `rat-single`/`rat-pair`, dropping a `rat-tail` whose `onUse` restores +1 Sanity.

**Architecture:** New serde+ts-rs `MobSpec`/`FormationDescriptor` types; a `Catalog.formations` map threaded like `behaviors`; a `resolve_formation` seam (native-first, then descriptor) at the single `maybe_spawn` build call site; a TS `descriptorToFormation` that builds live `Mob`s byte-matching the Rust `CharacterSnapshot` build; the rat-tail heal via the existing `onUse` DSL.

**Spec:** `docs/superpowers/specs/2026-07-07-data-driven-formations-roving-rats-design.md`.

## Global Constraints

- **The differential gate is the authority.** The descriptor (data) is the single source; the Rust `CharacterSnapshot` build and the TS `descriptorToFormation` live-`Mob` build must serialize **byte-identically**. Divergences are fixed in the build code, never by editing a golden or `conformance/canonical-json.ts`.
- **Gotcha — key field:** the encounter table stores formations as `{ behaviorKey, weight }` (Rust `maybe_spawn` reads `f.get("behaviorKey")`; TS `EncounterTableSnapshot.formations`). Any lookup/validate keys on `behaviorKey`.
- **Gotcha — build asymmetry:** Rust `FormationBehavior::build → Vec<CharacterSnapshot>`; TS `Formation.build → IMob[]` (live). Parity holds only after serialization. `descriptorToFormation` must build a live `Mob` (like `conformance/fixtures/formation-shadow.ts` does with `new Mob({...})`).
- **Gotcha — not a BehaviorScript family:** `BehaviorScript` stays `Mechanic|Exit|Victory|Item`. Formations are a **separate** `Catalog.formations` map + `resolve_formation` (structurally mirrors `resolve_mechanic_op` but reads the new map).
- **Gotcha — assembler needs registry formations at boot:** `assembler.ts` validates `registry.formation(key)` and calls `addFormation` (which mints a sample via `build` and rejects key-drops). So the campaign **registry** must register `descriptorToFormation`'d behaviors, *and* the manifest must supply the raw descriptors for `Catalog.formations`.
- **Always-emit mob fields:** a spawned mob's snapshot must carry `base_escape_chance` (default 50), `material_drops` (default `{}`), `light_averse` (default false), `natural_attack` (default `{stat:"health",power:1}`) — matching `build_wraith` (`formations.rs:53-75`).
- **`no_std`:** new types + build stay `alloc`-only; `cargo build -p wickedways-core --no-default-features` passes. **Bindings:** `bindings:check` green. **Full gate:** `pnpm run checks:phase2` green.

---

## Task 1: `MobSpec` + `FormationDescriptor` types + `Catalog.formations` + bindings

**Files:**
- Create: `crates/wickedways-core/src/world/formation_descriptor.rs` (new module; add `pub mod formation_descriptor;` to `world/mod.rs`)
- Modify: `crates/wickedways-core/src/world/descriptor.rs` (`Catalog`, ~line 104-113)
- Modify: `crates/wickedways-core/src/stats.rs` (`export_typescript_bindings`, descriptor block ~72-74)
- Regenerate: `generated/bindings/MobSpec.ts`, `NaturalAttack.ts`, `FormationDescriptor.ts`, `Catalog.ts`

**Interfaces produced:** `MobSpec`, `NaturalAttack`, `FormationDescriptor`, `Catalog.formations`.

- [ ] **Step 1: Define the descriptor types**

Create `formation_descriptor.rs`, modeling serde/ts-rs attrs on `ItemDescriptor` (`descriptor.rs:63-102`) and the field set on `build_wraith` (`formations.rs:53-75`):

```rust
//! Data-driven formation descriptors: a serializable mob template + a named
//! group of them. Interpreted by `resolve_formation`/`maybe_spawn` (both engines
//! build byte-identical snapshots). See the roving-Rats spec.
use alloc::string::String;
use alloc::vec::Vec;
use serde::{Deserialize, Serialize};
use serde_json::Value;
#[cfg(feature = "ts")]
use ts_rs::TS;

use crate::stats::StatType;
use crate::world::snapshot::Stats;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct NaturalAttack {
    pub stat: StatType,
    pub power: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct MobSpec {
    pub name: String,
    pub stats: Stats,
    pub natural_attack: NaturalAttack,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub drops: Vec<String>,
    pub base_escape_chance: i64,
    #[serde(default)]
    pub light_averse: bool,
    /// Default `{}`. `unknown` in TS.
    #[serde(default)]
    #[cfg_attr(feature = "ts", ts(type = "unknown"))]
    pub material_drops: Value,
    pub actions_per_round: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct FormationDescriptor {
    pub mobs: Vec<MobSpec>,
}
```

(If `Stats` is not already `ts(export)`-friendly here, reuse it as-is — it's the same `Stats` a `CharacterSnapshot` uses, guaranteeing stat byte-parity. Confirm `material_drops` default is JSON `{}`; if `Value::default()` is `Null`, add `#[serde(default = "empty_object")]` returning `serde_json::json!({})`.)

- [ ] **Step 2: Add `Catalog.formations`**

In `descriptor.rs`, after the `behaviors` field (line ~112):

```rust
    /// Campaign-authored formation descriptors, keyed by encounter `behaviorKey`.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub formations: BTreeMap<String, crate::world::formation_descriptor::FormationDescriptor>,
```

- [ ] **Step 3: Register ts-rs exports**

In `stats.rs` `export_typescript_bindings`, near the descriptor block (`ItemDescriptor::export_all()`, ~line 74), add `NaturalAttack::export_all()`, `MobSpec::export_all()`, `FormationDescriptor::export_all()` (mirror the existing `.expect(...)` idiom) and the matching `use crate::world::formation_descriptor::{...}`.

- [ ] **Step 4: Parse tests + build + bindings**

Add a test mirroring `catalog_without_behaviors_still_parses` (descriptor.rs:148-157): a catalog JSON WITHOUT `formations` still parses (`formations` empty); a catalog WITH a `formations` map round-trips. Then:

```
cd crates/wickedways-core && cargo test --lib formation_descriptor descriptor:: && cargo build -p wickedways-core --no-default-features
cd ../.. && pnpm run bindings:gen && git add generated/bindings/ && pnpm run bindings:check
```
Expected: tests pass; no_std builds; new binding files created + `Catalog.ts` updated; `bindings:check` exits 0.

- [ ] **Step 5: Commit**

```bash
git add crates/wickedways-core/src/world/formation_descriptor.rs crates/wickedways-core/src/world/mod.rs crates/wickedways-core/src/world/descriptor.rs crates/wickedways-core/src/stats.rs generated/bindings/
git commit -m "feat(core): MobSpec + FormationDescriptor + Catalog.formations (data-driven formations)"
```

---

## Task 2: Descriptor build + `resolve_formation` seam + wire into `maybe_spawn`

**Files:**
- Modify: `crates/wickedways-core/src/world/formation_descriptor.rs` (add `build`)
- Modify: `crates/wickedways-core/src/world/formations.rs` (`resolve_formation`, and the `maybe_spawn` call site ~line 212)
- Test: `formations.rs` tests

**Interfaces produced:** `FormationDescriptor::build(&self) -> Vec<CharacterSnapshot>`; `ResolvedFormation` + `resolve_formation(key, cat)`.

- [ ] **Step 1: Write failing build + resolve tests**

In `formations.rs` tests (has `arm_encounter_table`, `seat_test_mob`, spawn-gate tests):

```rust
#[test]
fn descriptor_build_produces_snapshots_with_deterministic_ids() {
    use crate::world::formation_descriptor::{FormationDescriptor, MobSpec, NaturalAttack};
    use crate::stats::StatType;
    use crate::world::snapshot::Stats;
    let spec = MobSpec {
        name: "Rat".into(),
        stats: Stats { health: 2.0, sanity: 2.0, energy: 3.0 },
        natural_attack: NaturalAttack { stat: StatType::Health, power: 1.0 },
        drops: alloc::vec!["items/rat-tail".into()],
        base_escape_chance: 50,
        light_averse: false,
        material_drops: serde_json::json!({}),
        actions_per_round: 2,
    };
    let desc = FormationDescriptor { mobs: alloc::vec![spec.clone(), spec] };
    let built = desc.build();
    assert_eq!(built.len(), 2);
    assert_eq!(built[0].id.0, "campaign-mob:rat");
    assert_eq!(built[1].id.0, "campaign-mob:rat#2"); // distinct, deterministic
    assert_eq!(built[0].kind, crate::world::snapshot::CharacterKind::Mob);
    assert_eq!(built[0].natural_attack, Some(serde_json::json!({ "stat": "health", "power": 1.0 })));
    assert_eq!(built[0].base_escape_chance, Some(50));
}

#[test]
fn resolve_formation_prefers_native_then_descriptor() {
    use crate::world::descriptor::Catalog;
    use crate::world::formation_descriptor::FormationDescriptor;
    use alloc::collections::BTreeMap;
    let mut formations = BTreeMap::new();
    formations.insert("rat-single".to_string(), FormationDescriptor { mobs: alloc::vec![] });
    let cat = Catalog { formations, ..Default::default() };
    assert!(matches!(resolve_formation("rat-single", &cat), Some(ResolvedFormation::Descriptor(_))));
    assert!(resolve_formation("nope", &cat).is_none());
    // conformance:wraith stays native (test build has the cfg arm)
    assert!(matches!(resolve_formation("conformance:wraith", &cat), Some(ResolvedFormation::Native(_))));
}
```

- [ ] **Step 2: Run — verify failure** (`cargo test --lib descriptor_build_produces resolve_formation_prefers`). Expected: FAIL (items don't exist).

- [ ] **Step 3: Implement `build`**

In `formation_descriptor.rs`, add (mirroring `build_wraith`'s field set; id scheme = `campaign-mob:{name.to_lowercase()}` for index 0, `…#{index+1}` for index ≥ 1):

```rust
use crate::world::ids::CharacterId;
use crate::world::snapshot::{CharacterKind, CharacterSnapshot, InventorySnapshot};
use crate::world::afflictions::Afflictions;
use alloc::collections::BTreeMap;

impl FormationDescriptor {
    /// Build the mobs to spawn (rng-free, deterministic ids). `maybe_spawn` sets
    /// each mob's `current_room_id` + `origin="campaign"` afterward.
    pub fn build(&self) -> Vec<CharacterSnapshot> {
        self.mobs
            .iter()
            .enumerate()
            .map(|(i, m)| {
                let base = alloc::format!("campaign-mob:{}", m.name.to_lowercase());
                let id = if i == 0 { base } else { alloc::format!("{base}#{}", i + 1) };
                CharacterSnapshot {
                    kind: CharacterKind::Mob,
                    id: CharacterId(id),
                    name: m.name.clone(),
                    stats: m.stats.clone(),
                    actions_per_round: m.actions_per_round,
                    actions_this_round: 0,
                    current_room_id: None,
                    inventory: InventorySnapshot { slots: 0, item_ids: Vec::new(), key_ids: Vec::new() },
                    equipment: BTreeMap::new(),
                    history: Vec::new(),
                    archetype_immunities: Vec::new(),
                    afflictions: Afflictions::default(),
                    archetype_id: None,
                    origin: None,
                    base_escape_chance: Some(m.base_escape_chance),
                    material_drops: Some(m.material_drops.clone()),
                    light_averse: Some(m.light_averse),
                    natural_attack: Some(serde_json::json!({
                        "stat": m.natural_attack.stat, "power": m.natural_attack.power
                    })),
                    npc_behavior_key: None,
                }
            })
            .collect()
    }
}
```

**Drops:** confirm how a native mob's `drops` become loot on defeat — `on_knock_out` drops the mob's inventory `item_ids`. If `drops` must be seeded into `inventory.item_ids` (as item ids) for `on_knock_out` to drop them, seed them here (create item snapshots + push ids), matching how the authored `.mob({drops})` path seeds them. Inspect `combat.rs on_knock_out` + how `.mob(drops)` serializes drops into the genesis, and reproduce that seeding in `build` so a descriptor rat drops its `rat-tail` exactly like an authored mob. (This is the one place to verify against the drop path before finalizing `MobSpec.drops` handling.)

- [ ] **Step 4: Add `resolve_formation` + wire `maybe_spawn`**

In `formations.rs`, add after `formation(key)`:

```rust
pub enum ResolvedFormation<'a> {
    Native(&'static dyn FormationBehavior),
    Descriptor(&'a crate::world::formation_descriptor::FormationDescriptor),
}

pub fn resolve_formation<'a>(key: &str, cat: &'a Catalog) -> Option<ResolvedFormation<'a>> {
    if let Some(op) = formation(key) {
        return Some(ResolvedFormation::Native(op));
    }
    cat.formations.get(key).map(ResolvedFormation::Descriptor)
}
```

Then replace the `maybe_spawn` build site (`formations.rs:212-214`):

```rust
    let mobs = match resolve_formation(key, cat)
        .ok_or_else(|| ProceduralViolation(alloc::format!("Formation '{key}' is not registered.")))?
    {
        ResolvedFormation::Native(b) => {
            let view = self.build_campaign_view(cat);
            b.build(&view)
        }
        ResolvedFormation::Descriptor(d) => d.build(),
    };
```

(The rest of `maybe_spawn` — origin/room set, insert, occupant push, silent enter-scenes — is unchanged; it operates on the returned `Vec<CharacterSnapshot>`.)

- [ ] **Step 5: Run tests + no_std** (`cargo test --lib && cargo build -p wickedways-core --no-default-features`). Expected: new tests pass; existing spawn-gate + `conformance:wraith` tests still green (native path unchanged).

- [ ] **Step 6: Commit**

```bash
git add crates/wickedways-core/src/world/formation_descriptor.rs crates/wickedways-core/src/world/formations.rs
git commit -m "feat(core): descriptor formation build + resolve_formation seam in maybe_spawn"
```

---

## Task 3: `validate_mechanics` — formation-key validation

**Files:** Modify `crates/wickedways-core/src/world/mechanics/dispatch.rs` (`validate_mechanics`, ~282-326); test there.

- [ ] **Step 1: Failing test** — a world whose `encounter_table.formations` names an unregistered `behaviorKey` makes `validate_mechanics` return `Err(ProceduralViolation("Formation 'X' is not registered."))`; a descriptor-registered key passes.

- [ ] **Step 2: Run — verify failure.**

- [ ] **Step 3: Implement** — add a loop after the victory loop, reading the untyped encounter table exactly as `maybe_spawn` does (formations.rs:172-186):

```rust
        // Formation keys (encounter table is an untyped Value; read behaviorKey like maybe_spawn).
        if let Some(arr) = self.campaign.encounter_table.get("formations").and_then(|v| v.as_array()) {
            for f in arr {
                if let Some(key) = f.get("behaviorKey").and_then(|v| v.as_str()) {
                    if crate::world::formations::resolve_formation(key, cat).is_none() {
                        return Err(ProceduralViolation(format!("Formation '{key}' is not registered.")));
                    }
                }
            }
        }
```

- [ ] **Step 4: Run** (`cargo test --lib validate`). Expected: pass; existing validate tests green.

- [ ] **Step 5: Commit** (`git commit -m "feat(core): validate encounter-table formation keys resolve at load"`).

---

## Task 4: TS plumbing — `descriptorToFormation` + catalog threading + manifest field

**Files:**
- Create: a `descriptorToFormation` helper (place near the campaign authoring / a shared module importable by both `packages/campaigns` and the conformance fixtures — e.g. `packages/campaigns/src/formations.ts`).
- Modify: `packages/play-runtime/src/catalog.ts` (`catalogFromRegistry` — add `formations` param), `packages/play-runtime/src/session.ts` (thread `opts.formations`), `packages/play-runtime/src/manifest.ts` (`CampaignManifest.formations?`), `packages/play-runtime/src/launcher.ts` (pass `m.formations?.()`).
- Test: a builder/parity unit test in `packages/campaigns`.

**Interfaces produced:** `descriptorToFormation(desc): FormationBehavior`; `catalogFromRegistry(registry, aliases, behaviors, formations)`; `CampaignManifest.formations?: () => Record<string, FormationDescriptor>`.

- [ ] **Step 1: `descriptorToFormation` (byte-parity with Rust `build`)**

Write a helper that turns a `FormationDescriptor` (the ts-rs binding type) into a live-`Mob`-building `FormationBehavior`, mirroring `conformance/fixtures/formation-shadow.ts` (`new Mob({...})`) AND the Rust `build` field-for-field (esp. the id scheme `campaign-mob:${name.toLowerCase()}` + `#${i+1}` for i≥1, and the always-emit fields). Sketch:

```ts
import { Mob } from "wickedways/lib/character/mob";
import type { FormationBehavior } from "wickedways/lib/serialization/registry";
import type { FormationDescriptor } from "../../../generated/bindings/FormationDescriptor.ts";

export function descriptorToFormation(desc: FormationDescriptor): FormationBehavior {
  return {
    build: () =>
      desc.mobs.map((m, i) => {
        const base = `campaign-mob:${m.name.toLowerCase()}`;
        const id = i === 0 ? base : `${base}#${i + 1}`;
        const mob = new Mob({ /* name, stats, drops, naturalAttack, baseEscapeChance,
                                 lightAverse, materialDrops, actionsPerRound — match .mob() opts */ });
        // set the deterministic id exactly as formation-shadow.ts sets WRAITH_ID
        (mob as unknown as { id: string }).id = id; // use the real seam formation-shadow.ts uses
        return mob;
      }),
  };
}
```

Pin the `new Mob({...})` option shape + the id-set seam against `formation-shadow.ts` (it sets `mob.id = WRAITH_ID`) so the serialized snapshot matches `build_wraith`/`FormationDescriptor::build`.

- [ ] **Step 2: Thread `formations` through the catalog**

`catalog.ts` — add a 4th param mirroring `behaviors`:

```ts
export function catalogFromRegistry(
  registry: CampaignRegistry,
  aliases: Record<string, string[]>,
  behaviors: Record<string, BehaviorScript> = {},
  formations: Record<string, FormationDescriptor> = {},
): { items: ...; aliases: ...; behaviors: ...; formations: Record<string, FormationDescriptor> } {
  // ...unchanged item loop...
  return { items, aliases, behaviors, formations };
}
```

`session.ts:94` — pass `this.opts.formations ?? {}`; add `formations?: Record<string, FormationDescriptor>` to `SessionOptions`. `manifest.ts` — add `formations?: () => Record<string, FormationDescriptor>` (TSDoc mirroring the `behaviors` field). `launcher.ts:90-94` — add `formations: m.formations?.() ?? {}` to the `GameSession.start({...})` opts.

- [ ] **Step 3: Parity + typecheck**

Add a unit test asserting `descriptorToFormation(desc).build(campaign)` produces mobs whose serialized snapshot (via `serializeCampaign` or the mob's serialize) matches the expected fields/ids (esp. the pair `campaign-mob:rat#2`). Run `pnpm -r run typecheck`.

- [ ] **Step 4: Commit** (`git commit -m "feat(campaigns): descriptorToFormation + thread Catalog.formations through boot"`).

---

## Task 5: Hollow House content — Rats, rat-tail, enablement

**Files:** `packages/campaigns/src/hollow-house/` — `ids.ts` (new `Formations`, `Items.RatTail`), a rat-tail item factory (`items.ts`), `scripted.ts` (`ratTailScript` + register), a `hollowHouseFormations()` factory, `index.ts` (`buildHauntedHouseRegistry` formations + template `.formation`/`baseEncounterChance`/`spawnModifier`), `manifest.ts` (`formations: hollowHouseFormations`).

- [ ] **Step 1: rat-tail item + onUse**

Add `Items.RatTail` and a `ratTail()` factory (usable consumable, not equippable, not a key), and in `scripted.ts`:

```ts
export const ratTailScript = s.item({ onUse: [s.emit(s.adjust(s.actor, "sanity", s.lit(1)))] });
// register in hollowHouseBehaviors(): [Items.RatTail]: ratTailScript
```

- [ ] **Step 2: Rat descriptors + formations**

Define the rat `MobSpec` (Health 2 / Sanity 2 / Energy 3, `naturalAttack {stat:"health",power:1}`, `drops:[Items.RatTail]`, `baseEscapeChance:50`, `lightAverse:false`, `materialDrops:{}`, `actionsPerRound:` mob default) and:
- `hollowHouseFormations(): Record<string, FormationDescriptor>` → `{ [Formations.RatSingle]: { mobs:[rat] }, [Formations.RatPair]: { mobs:[rat, rat] } }`.
- `buildHauntedHouseRegistry`: add `formations: { [Formations.RatSingle]: descriptorToFormation(ratSingle), [Formations.RatPair]: descriptorToFormation(ratPair) }` (so the assembler validates + `addFormation` accepts — rat-tail is not a key, so the key-drop guard passes).
- `manifest.ts`: `formations: hollowHouseFormations`.

- [ ] **Step 3: Enable roving**

In `hauntedHouseTemplate()`: change `baseEncounterChance: 0` → `20`; add `.formation(Formations.RatSingle, { weight: 3 })`, `.formation(Formations.RatPair, { weight: 1 })`; add a modest `spawnModifier` (e.g. `1`) to Hall/Kitchen/Parlor/Landing rooms. (Cellar/Nursery/Foyer keep default/0 or rely on occupant-suppression.)

- [ ] **Step 4: Verify boot + typecheck**

The manifest-boot guard (`packages/play/src/core/manifest-boot.test.ts`) now exercises the formation-threaded boot. Run it + `pnpm -r run typecheck` + the campaigns unit tests. If `scripted.test.ts` asserts a behavior-key count, update it for the new `rat-tail` key.

- [ ] **Step 5: Commit** (`git commit -m "feat(campaigns): roving Rats + rat-tail (onUse +1 Sanity) in Hollow House"`).

---

## Task 6: Differential fixtures — descriptor spawn + rat-tail onUse

**Files:**
- Create: `conformance/fixtures/formation-descriptor.gen.test.ts` + `conformance/formation-descriptor.test.ts`
- Create: `conformance/fixtures/rat-tail.gen.test.ts` + `conformance/rat-tail.test.ts` (or fold rat-tail into an existing item-onUse fixture)
- Modify: `conformance/fixtures/vitest.config.ts`

- [ ] **Step 1: Descriptor spawn fixture**

Model on `conformance/fixtures/spawn.gen.test.ts` + `formation-shadow.ts` + `conformance/spawn.test.ts`, but drive a **data descriptor** instead of the native shadow:
- Register the formations via `defineRegistry({ items:{...rat-tail...}, formations: { "rat-single": descriptorToFormation(ratSingle), "rat-pair": descriptorToFormation(ratPair) } })`.
- Build the catalog WITH `formations` (the raw descriptors) — extend the fixture's `buildCatalog` to emit `formations` into `*.catalog.json` (so the Rust replay resolves them via `catalog.formations`).
- Deterministic setup (per the spawn fixture's rng rule): thresholds 0/100 + weights that deterministically select each formation, so outcomes are roll-value-independent. Cover BOTH a single-rat spawn and a two-rat spawn; assert (self-validation) the pair's two ids are `campaign-mob:rat` and `campaign-mob:rat#2`.
- Register the generator in `conformance/fixtures/vitest.config.ts` (near the `spawn.gen.test.ts` entry).
- Replay (`conformance/formation-descriptor.test.ts`): `replay_commands(...)` byte-equal per step. Run `pnpm run wasm:build:conformance && pnpm vitest run --config conformance/vitest.config.ts formation-descriptor`. Divergence → fix the Rust or TS `build`, never the golden.

- [ ] **Step 2: rat-tail onUse coverage**

A small fixture (or extend an item-onUse fixture): PC holds a rat-tail, `use` it → +1 Sanity, consumed. Oracle = the item's TS `use` closure (or the descriptor-driven onUse — mirror the laudanum-use fixture). Register + replay green.

- [ ] **Step 3: Confirm zero unrelated golden churn** (`git status conformance/fixtures`), then **Commit** (`git commit -m "test(conformance): descriptor-formation spawn + rat-tail onUse fixtures"`).

---

## Task 7: Docs + full gate

- [ ] **Step 1:** README — in **Mob encounters & loot** / **Roving formations**, document that formations can be authored as data (`Catalog.formations` descriptors: `MobSpec`/`FormationDescriptor`) resolved native-first-then-descriptor; note Hollow House's roving Rats + the rat-tail (+1 Sanity on use).
- [ ] **Step 2:** `pnpm run checks:phase2` — green end-to-end (no_std, workspace tests, `bindings:check`, both wasm builds, purity, conformance incl. new fixtures, typechecks, vitest).
- [ ] **Step 3:** Commit (`git commit -m "docs: data-driven formations + roving Rats"`).

## Self-Review

- **Spec coverage:** data-driven formation types + catalog (T1), build + resolve seam (T2), validate (T3), TS parity plumbing (T4), rat content + enablement (T5), differential spawn + onUse gate (T6), docs + gate (T7). ✅
- **Gotchas encoded:** `behaviorKey` key field (T2/T3), live-Mob-vs-snapshot parity via `descriptorToFormation` (T4/T6), separate `formations` map not a `BehaviorScript` (T1/T2), untyped encounter `Value` reads (T3), assembler-needs-registry-formations (T4/T5). ✅
- **Consistency:** id scheme `campaign-mob:{name.toLowerCase()}[#{i+1}]` identical in Rust `build` (T2) and TS `descriptorToFormation` (T4); asserted in both unit tests and the spawn fixture (T6).
- **Open verification (called out in T2 Step 3):** exactly how `MobSpec.drops` must be seeded so `on_knock_out` drops the rat-tail — the implementer confirms against the authored `.mob({drops})` path before finalizing.
