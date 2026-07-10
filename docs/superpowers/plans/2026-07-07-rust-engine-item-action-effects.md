# Item-Action Effects (scripted `onUse` / `onRead`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give items author-defined `onUse` / `onRead` behavior in the Rust core by extending the existing scripted-ops DSL with an `Item` behavior family, so a used/read item can emit effects (e.g. laudanum restoring Sanity) — gated byte-for-byte against the hand-written TypeScript item closures.

**Architecture:** Items already look up their `ItemDescriptor` in `Catalog.items[behavior_key]`. We add a parallel, optional lookup in `Catalog.behaviors[behavior_key]` for a new `BehaviorScript::Item { script: ItemScript }` carrying `on_use` / `on_read` effect bodies. A `ScriptedItem` adapter (mirroring `ScriptedMechanic`) interprets those bodies into `Vec<Effect>`, which flow through the *existing* collect-then-apply pipeline. `use_item` fires `on_use` at the TS-faithful position (after the usable/KO guards, before `grantsImmunity` + consume); `read_item` fires `on_read` before emitting the lore cue. A new `Command::Read` makes `on_read` reachable from the conformance replay harness.

**Tech Stack:** Rust (`wickedways-core` `no_std`+`alloc`, `wickedways-wasm`), `serde` + `ts-rs` for the AST/bindings, TypeScript (campaign authoring builders + Vitest differential conformance harness), `pnpm`.

## Why this design (context for the implementer)

The single-player cutover cannot descriptor-drive item effects: `healing-tonic` (`modifier:4, stat:Health, usable`, `use: noop`) and `laudanum` (`modifier:6, stat:Sanity, usable`, `use` adjusts the stat) serialize to **byte-identical** descriptors, yet the committed `items-actions` golden `use`s the tonic with health *unchanged*. An unconditional descriptor→apply would churn the tonic. So item effects must be a per-item **script hook**, present only on items whose author closure actually does something. `healing-tonic` gets no `Item` script → no effect → the existing golden stays green untouched, proving non-churn. This is Option B from the design decision (scripted `onUse` via the DSL); it also gives the read hook (`onRead`).

## Global Constraints

Every task's requirements implicitly include this section. Values are copied verbatim from the DSL spec (`docs/superpowers/specs/2026-07-06-rust-engine-scripted-ops-dsl-design.md`) and `CLAUDE.md`.

- **The differential conformance gate is the authority.** Divergences are fixed in the AST or the interpreter, **never** by editing a golden or `conformance/canonical-json.ts`. `conformance/canonical-json.ts` is edit-forbidden.
- **The TS oracle closures stay.** Do **not** delete or alter the hand-written TS item closures (e.g. `laudanum`'s `use(holder){ holder[ADJUST_STAT](this.stat, this.modifier); }` in `packages/campaigns/src/hollow-house/items.ts:44`). They remain the gate oracle until Phase 3. The scripted hook is authored *alongside* the closure and must reproduce it exactly.
- **Determinism is a hard contract.** The interpreter stays pure: only the injected `rng`, no clock, deterministic iteration, f64 restricted to IEEE-754-identical ops. Item hooks get the same `Ctx` shape as mechanic hooks.
- **`no_std`-friendly.** `crates/wickedways-core/src/script/` is `alloc`-only. `cargo build -p wickedways-core --no-default-features` must pass.
- **Generated bindings are artifacts.** New AST TS types come from `ts-rs`; `pnpm run bindings:check` must pass (regenerate + commit `generated/bindings/`).
- **Item hook bodies are effect bodies** (`allow_pass = false, allow_emit = true`), identical to mechanic hooks. There is no per-item script state in v1: the hook `Ctx` uses a throwaway `state` and `RoomSource::None`.
- **TS-faithful ordering.** `onUse` fires after the `usable` + KO guards and **before** `grantsImmunity`+consume (`src/lib/inventory.ts:620-630`). `onRead` fires **before** the lore cue (`src/lib/character/character.ts:788-790`).
- **Illegal operations throw `ProceduralViolation`** with verbatim TS message shapes; branded IDs go through their helpers (`CLAUDE.md`).
- **Full gate:** `pnpm run checks:phase2` must be green at the end. That script is (root `package.json:33`):
  ```
  cargo build -p wickedways-core --no-default-features && cargo test --workspace && pnpm run bindings:check && pnpm run wasm:build && node scripts/assert-no-conformance.mjs && pnpm run wasm:build:web && pnpm run test:conformance && pnpm run typecheck && pnpm -r run typecheck && pnpm run test
  ```

---

## File Structure

Files created or modified, by responsibility:

**Rust core (`crates/wickedways-core/src/`)**
- `script/ast.rs` — add `ItemScript` struct + `BehaviorScript::Item` variant (AST + serde + ts-rs).
- `script/mod.rs` — add the `Item` arm to `validate_behavior`.
- `script/ops.rs` — add the `ScriptedItem` adapter (`run_use` / `run_read`).
- `world/mechanics/dispatch.rs` — extend `validate_mechanics` with an item-script validation loop; expose the effect cap.
- `world/items_actions.rs` — fire `on_use` inside `use_item`.
- `world/submit.rs` — fire `on_read` inside `read_item`.
- `world/command.rs` — add `Command::Read { target_id }` → `read_item`.
- `stats.rs` — register `ItemScript` in the ts-rs export test.

**TS authoring (`packages/campaigns/src/`)**
- `scripted/builders.ts` — add the `item({ onUse?, onRead? })` builder.
- `hollow-house/scripted.ts` — author `laudanumScript` and register it in `hollowHouseBehaviors()`.

**Conformance (`conformance/`)**
- `fixtures/laudanum-use.gen.test.ts` — new golden generator (real Hollow House laudanum, oracle = its TS closure).
- `laudanum-use.test.ts` — new replay test.
- `fixtures/read-effects.gen.test.ts` — new golden generator (synthetic read-closure item).
- `read-effects.test.ts` — new replay test.
- `fixtures/vitest.config.ts` — register the two new `*.gen.test.ts` files in the `include` list.

**Docs**
- `README.md` + relevant TSDoc — document the scripted item hooks.

---

## Task 1: `ItemScript` AST + `BehaviorScript::Item` variant + validation + bindings

**Files:**
- Modify: `crates/wickedways-core/src/script/ast.rs` (near `BehaviorScript`, lines ~215-227)
- Modify: `crates/wickedways-core/src/script/mod.rs` (`validate_behavior`, lines ~17-41)
- Modify: `crates/wickedways-core/src/stats.rs` (`export_typescript_bindings`, lines ~96-113)
- Test: Rust unit tests in `crates/wickedways-core/src/script/mod.rs` (`#[cfg(test)]`)
- Regenerate: `generated/bindings/ItemScript.ts` (new) + `generated/bindings/BehaviorScript.ts` (updated)

**Interfaces:**
- Produces: `crate::script::ast::ItemScript { on_use: Option<Vec<Stmt>>, on_read: Option<Vec<Stmt>> }` and `BehaviorScript::Item { script: ItemScript }`. Later tasks match on this variant and read `script.on_use` / `script.on_read`.

- [ ] **Step 1: Write the failing validation test**

Add to the existing `#[cfg(test)] mod tests` in `crates/wickedways-core/src/script/mod.rs` (create the module if absent, mirroring how `ast`/`ops` tests are structured):

```rust
#[test]
fn validate_accepts_item_script_with_effect_bodies() {
    use crate::script::ast::{BehaviorScript, EffectTemplate, Expr, ItemScript, Stmt};
    use crate::script::value::Value;
    use crate::stats::StatType;
    let b = BehaviorScript::Item {
        script: ItemScript {
            on_use: Some(alloc::vec![Stmt::Emit {
                effect: EffectTemplate::AdjustStat {
                    target: Expr::Actor,
                    stat: StatType::Sanity,
                    delta: Expr::Lit { value: Value::Number(6.0) },
                },
            }]),
            on_read: None,
        },
    };
    assert!(validate_behavior("items/laudanum", &b).is_ok());
}

#[test]
fn validate_rejects_pass_in_item_body() {
    use crate::script::ast::{BehaviorScript, Expr, ItemScript, Stmt};
    use crate::script::value::Value;
    // `Pass` is script-body-only (exit run_script); an item body is an effect
    // body, so a Pass statement must be rejected at load (allow_pass = false).
    let b = BehaviorScript::Item {
        script: ItemScript {
            on_use: Some(alloc::vec![Stmt::Pass { value: Expr::Lit { value: Value::Str("x".into()) } }]),
            on_read: None,
        },
    };
    assert!(validate_behavior("items/bad", &b).is_err());
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd crates/wickedways-core && cargo test --lib script::`
Expected: FAIL — `ItemScript` / `BehaviorScript::Item` do not exist (compile error).

- [ ] **Step 3: Add the `ItemScript` struct and `Item` variant to `ast.rs`**

In `crates/wickedways-core/src/script/ast.rs`, immediately before the `BehaviorScript` enum (currently at lines ~219-227), add:

```rust
/// An item's author-defined behavior: effect bodies fired when the item is
/// used or read. Both are effect bodies (`Vec<Stmt>`, `allow_pass=false`),
/// identical in shape to mechanic hook bodies. Absent hook = no-op.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct ItemScript {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub on_use: Option<Vec<Stmt>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub on_read: Option<Vec<Stmt>>,
}
```

Then add the variant to `BehaviorScript` (keep the existing `Mechanic`/`Exit`/`Victory` arms; append):

```rust
    Item { script: ItemScript },
```

- [ ] **Step 4: Add the `Item` arm to `validate_behavior`**

In `crates/wickedways-core/src/script/mod.rs`, the `validate_behavior` match on `BehaviorScript` (lines ~19-41) currently handles `Mechanic`/`Exit`/`Victory`. Add, mirroring the `Mechanic` arm's per-hook `check_stmts(body, false, true)` calls:

```rust
        BehaviorScript::Item { script } => {
            if let Some(body) = &script.on_use {
                check_stmts(key, body, false, true)?;
            }
            if let Some(body) = &script.on_read {
                check_stmts(key, body, false, true)?;
            }
            Ok(())
        }
```

(Match the exact `check_stmts` signature/argument order used by the `Mechanic` arm — the Explore report cites `check_stmts(body, allow_pass=false, allow_emit=true)`; use whatever the real signature is, including the `key` argument if the existing arms pass it.)

- [ ] **Step 5: Register `ItemScript` in the ts-rs export**

In `crates/wickedways-core/src/stats.rs`, the `export_typescript_bindings` test's scripted-DSL block (lines ~96-113) imports the AST types and calls `::export_all()`. Add `ItemScript` to the `use crate::script::ast::{...}` import list, and add before the final `BehaviorScript::export_all()` line:

```rust
    ItemScript::export_all().unwrap();
```

(Follow the exact call form the neighboring lines use — e.g. if they are `MechanicScript::export_all().unwrap();`, match that.)

- [ ] **Step 6: Run tests + no_std build to verify they pass**

Run: `cd crates/wickedways-core && cargo test --lib script:: && cargo build -p wickedways-core --no-default-features`
Expected: PASS (both new tests) and the no_std build succeeds.

- [ ] **Step 7: Regenerate and verify bindings**

Run (from repo root): `pnpm run bindings:check`
Expected: `bindings:gen` writes `generated/bindings/ItemScript.ts` and updates `generated/bindings/BehaviorScript.ts` (now including the `item` family); then `git diff --exit-code generated/bindings` will FAIL because the new/changed files are untracked/modified. Stage them, then re-run to confirm clean:
```bash
git add generated/bindings/ItemScript.ts generated/bindings/BehaviorScript.ts
pnpm run bindings:check   # now exits 0 (clean diff)
```

- [ ] **Step 8: Commit**

```bash
git add crates/wickedways-core/src/script/ast.rs crates/wickedways-core/src/script/mod.rs crates/wickedways-core/src/stats.rs generated/bindings/
git commit -m "feat(script): add BehaviorScript::Item (onUse/onRead) AST + validation"
```

---

## Task 2: `ScriptedItem` adapter (interpreter binding)

**Files:**
- Modify: `crates/wickedways-core/src/script/ops.rs` (add after `ScriptedMechanic`, near line ~92)
- Test: Rust unit tests in `crates/wickedways-core/src/script/ops.rs` (`#[cfg(test)]`)

**Interfaces:**
- Consumes: `ItemScript` (Task 1); the existing `eval_effects`, `Ctx`, `CtxState`, `RoomSource` from `crate::script::eval`; `HookCtx`, `CharacterView`, `Effect` from `crate::world::mechanics`.
- Produces: `crate::script::ops::ScriptedItem<'a> { script: &'a ItemScript }` with `fn run_use(&self, base: &mut HookCtx, actor: &CharacterView) -> Vec<Effect>` and `fn run_read(&self, base: &mut HookCtx, actor: &CharacterView) -> Vec<Effect>`. Tasks 3/4 call these.

- [ ] **Step 1: Write the failing adapter tests**

Add to (or create) the `#[cfg(test)] mod tests` in `crates/wickedways-core/src/script/ops.rs`. The test builds a minimal `CampaignView` + `CharacterView` + rng, runs a one-effect `on_use` body, and asserts the produced `Effect`. Use the same construction the existing `ScriptedMechanic` tests use for `HookCtx` — read the neighboring tests in this file / `dispatch.rs:938-945` (`build_campaign_view` / `character_view`) for the exact helper names, and mirror them. Sketch:

```rust
#[test]
fn scripted_item_on_use_emits_adjust_stat_for_actor() {
    use crate::script::ast::{EffectTemplate, Expr, ItemScript, Stmt};
    use crate::script::value::Value;
    use crate::stats::StatType;
    use crate::world::mechanics::{Effect, HookCtx};
    use crate::world::test_support::world_with_party;
    use crate::world::descriptor::Catalog;

    let w = world_with_party(&["pc"], 10);
    let cat = Catalog::default();
    let view = w.build_campaign_view(&cat);
    let actor = w.character_view(&crate::world::ids::CharacterId("pc".into()), &cat).unwrap();

    let script = ItemScript {
        on_use: Some(alloc::vec![Stmt::Emit {
            effect: EffectTemplate::AdjustStat {
                target: Expr::Actor,
                stat: StatType::Sanity,
                delta: Expr::Lit { value: Value::Number(6.0) },
            },
        }]),
        on_read: None,
    };

    let mut rng = crate::world::rng::Rng::seeded(0);
    let mut state = serde_json::Value::Null;
    let mut base = HookCtx { state: &mut state, view: &view, rng: &mut rng };
    let effects = ScriptedItem { script: &script }.run_use(&mut base, &actor);

    assert_eq!(effects.len(), 1);
    match &effects[0] {
        Effect::AdjustStat { target, stat, delta } => {
            assert_eq!(target.0, "pc");
            assert_eq!(*stat, StatType::Sanity);
            assert!((*delta - 6.0).abs() < 1e-9);
        }
        other => panic!("expected AdjustStat, got {other:?}"),
    }
}

#[test]
fn scripted_item_absent_hook_is_noop() {
    use crate::script::ast::ItemScript;
    use crate::world::mechanics::HookCtx;
    use crate::world::test_support::world_with_party;
    use crate::world::descriptor::Catalog;

    let w = world_with_party(&["pc"], 10);
    let cat = Catalog::default();
    let view = w.build_campaign_view(&cat);
    let actor = w.character_view(&crate::world::ids::CharacterId("pc".into()), &cat).unwrap();
    let script = ItemScript { on_use: None, on_read: None };
    let mut rng = crate::world::rng::Rng::seeded(0);
    let mut state = serde_json::Value::Null;
    let mut base = HookCtx { state: &mut state, view: &view, rng: &mut rng };
    assert!(ScriptedItem { script: &script }.run_read(&mut base, &actor).is_empty());
}
```

If `build_campaign_view` / `character_view` are not `pub` for tests, use whatever the existing `ScriptedMechanic` tests use (or the `dispatch.rs` tests' helpers). Adjust imports to the real module paths.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd crates/wickedways-core && cargo test --lib script::ops`
Expected: FAIL — `ScriptedItem` does not exist.

- [ ] **Step 3: Implement `ScriptedItem`**

In `crates/wickedways-core/src/script/ops.rs`, after the `impl MechanicOp for ScriptedMechanic` block (line ~92), add. This mirrors `ScriptedMechanic::run_body` (ops.rs:23-43) exactly — same `Ctx` shape, `RoomSource::None`, throwaway/`Write` state:

```rust
/// An item's `on_use` / `on_read` hooks, bound to a borrowed `ItemScript`.
/// Built per fire-point in `use_item` / `read_item`. Item hooks see the actor
/// (holder), the campaign view, and the injected rng — the same power as a
/// mechanic `on_action` hook, minus per-item script state (v1 has none, so the
/// `Ctx` state is a throwaway) and rooms (`RoomSource::None`).
pub struct ScriptedItem<'a> {
    pub script: &'a crate::script::ast::ItemScript,
}

impl ScriptedItem<'_> {
    fn run_body(
        &self,
        body: Option<&Vec<Stmt>>,
        base: &mut HookCtx,
        actor: &CharacterView,
    ) -> Vec<Effect> {
        let Some(body) = body else { return Vec::new() };
        let mut cx = Ctx {
            view: Some(base.view),
            state: CtxState::Write(base.state),
            actor: Some(actor),
            action: None,
            damage: None,
            element: None,
            rng: Some(base.rng),
            rooms: RoomSource::None,
        };
        eval_effects(body, &mut cx)
    }

    pub fn run_use(&self, base: &mut HookCtx, actor: &CharacterView) -> Vec<Effect> {
        self.run_body(self.script.on_use.as_ref(), base, actor)
    }

    pub fn run_read(&self, base: &mut HookCtx, actor: &CharacterView) -> Vec<Effect> {
        self.run_body(self.script.on_read.as_ref(), base, actor)
    }
}
```

Ensure the `use` imports at the top of `ops.rs` cover `CharacterView` (already imported for the other adapters) and `crate::script::ast::{ItemScript, Stmt}` — `Stmt` and `MechanicScript` are already imported; add `ItemScript`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd crates/wickedways-core && cargo test --lib script::ops && cargo build -p wickedways-core --no-default-features`
Expected: PASS + no_std build clean.

- [ ] **Step 5: Commit**

```bash
git add crates/wickedways-core/src/script/ops.rs
git commit -m "feat(script): add ScriptedItem adapter (onUse/onRead → effects)"
```

---

## Task 3: Fire `on_use` inside `use_item`

**Files:**
- Modify: `crates/wickedways-core/src/world/items_actions.rs` (`use_item`, lines 618-685)
- Modify: `crates/wickedways-core/src/world/mechanics/dispatch.rs` (make the effect cap reachable, if not already)
- Test: `crates/wickedways-core/src/world/items_actions.rs` (`#[cfg(test)] mod tests`)

**Interfaces:**
- Consumes: `ScriptedItem` (Task 2); `BehaviorScript::Item` (Task 1); existing `self.build_campaign_view`, `self.character_view`, `self.apply_all`, `self.rng`, `MAX_EFFECTS_PER_EVENT`.
- Produces: `use_item` applies an item's `on_use` effects at the TS-faithful position. No signature change.

- [ ] **Step 1: Write the failing integration test**

Add to `crates/wickedways-core/src/world/items_actions.rs` tests. Build a catalog with a usable "potion" item whose `behaviors` entry carries an `on_use` emitting `AdjustStat(Actor, Sanity, +6)`, hold it on a PC with sanity below max, `use_item`, assert sanity rose by 6 and the item was consumed. Mirror the existing `use_item_*` tests' catalog/world helpers (lines ~688-745 show the descriptor/`ItemSnapshot` construction; note `Catalog { items, aliases, behaviors }`):

```rust
#[test]
fn use_item_runs_scripted_on_use_before_consume() {
    use crate::script::ast::{BehaviorScript, EffectTemplate, Expr, ItemScript, Stmt};
    use crate::script::value::Value;
    use crate::world::mechanics::PresentationCue; // if needed for cues Vec
    let mut w = world_with_party(&["pc"], 10);
    let pc = cid("pc");
    // sanity 4 so +6 is observable and uncapped
    w.characters.get_mut(&pc).unwrap().stats.sanity = 4.0;

    let mut items = alloc::collections::BTreeMap::new();
    items.insert("items/potion".to_string(), /* usable consumable descriptor:
        properties.usable = true, consume_on_use = Some(true), stat/modifier
        irrelevant to the script. Copy the `items/herb` descriptor shape from the
        submit.rs cat_with_items helper. */ herb_like_usable_descriptor());
    let mut behaviors = alloc::collections::BTreeMap::new();
    behaviors.insert("items/potion".to_string(), BehaviorScript::Item {
        script: ItemScript {
            on_use: Some(alloc::vec![Stmt::Emit { effect: EffectTemplate::AdjustStat {
                target: Expr::Actor, stat: crate::stats::StatType::Sanity,
                delta: Expr::Lit { value: Value::Number(6.0) },
            }}]),
            on_read: None,
        },
    });
    let cat = Catalog { items, aliases: alloc::collections::BTreeMap::new(), behaviors };

    w.items.insert(iid("item-potion"), ItemSnapshot::Item {
        id: iid("item-potion"), behavior_key: "items/potion".into(),
        durability: None, modifier: 0,
    });
    w.characters.get_mut(&pc).unwrap().inventory.item_ids.push(iid("item-potion"));

    let mut cues = alloc::vec::Vec::new();
    w.use_item(&pc, &iid("item-potion"), &cat, &mut cues).unwrap();

    assert_eq!(w.characters[&pc].stats.sanity, 10.0, "onUse restored +6 sanity");
    assert!(!w.characters[&pc].inventory.item_ids.contains(&iid("item-potion")),
        "the item was still consumed");
}
```

Write the small `herb_like_usable_descriptor()` local helper (or inline the descriptor) copying the `items/herb` `ItemDescriptor` from `submit.rs`'s `cat_with_items` (lines 546-557): `usable: true`, `consume_on_use: Some(true)`, all inert JSON fields present.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd crates/wickedways-core && cargo test --lib use_item_runs_scripted_on_use`
Expected: FAIL — sanity stays 4.0 (the `on_use` script is not yet fired).

- [ ] **Step 3: Ensure the effect cap is reachable**

`MAX_EFFECTS_PER_EVENT` is defined in `crates/wickedways-core/src/world/mechanics/dispatch.rs`. If it is not already `pub(crate)`, make it so (`pub(crate) const MAX_EFFECTS_PER_EVENT: usize = ...;`) so `items_actions.rs` can reference it. If it is already reachable, skip.

- [ ] **Step 4: Fire `on_use` in `use_item`**

In `crates/wickedways-core/src/world/items_actions.rs`, inside `use_item`, **after** the KO guard block (ends line ~664) and **before** the `grantsImmunity` block (starts line ~666). `item_snap` is already an owned clone (line 643), so its `behavior_key` is safe to borrow across `&mut self` calls; `cat` is a separate immutable param:

```rust
        // 2c. Author use-behaviour (scripted onUse). In TS this is
        //     `actions[Use].call(holder)` + the `onUse` event, which run AFTER the
        //     usable/KO guards and BEFORE grantsImmunity + consume
        //     (src/lib/inventory.ts:620-627). Absent script = no-op.
        if let crate::world::snapshot::ItemSnapshot::Item { behavior_key, .. } = &item_snap {
            if let Some(crate::script::ast::BehaviorScript::Item { script }) =
                cat.behaviors.get(behavior_key)
            {
                let view = self.build_campaign_view(cat);
                if let Some(actor_view) = self.character_view(actor, cat) {
                    let effects = {
                        let rng = &mut self.rng;
                        let mut state = serde_json::Value::Null; // no per-item script state (v1)
                        let mut base = crate::world::mechanics::HookCtx {
                            state: &mut state,
                            view: &view,
                            rng,
                        };
                        crate::script::ops::ScriptedItem { script }.run_use(&mut base, &actor_view)
                    };
                    if effects.len()
                        > crate::world::mechanics::dispatch::MAX_EFFECTS_PER_EVENT
                    {
                        return Err(ProceduralViolation(alloc::format!(
                            "Item '{}' emitted too many effects.",
                            behavior_key
                        )));
                    }
                    self.apply_all(effects, cat, cues)?;
                }
            }
        }
```

Adjust the path to `MAX_EFFECTS_PER_EVENT` / `HookCtx` / `build_campaign_view` / `character_view` / `apply_all` to the real module paths (the same ones `use_mechanic_action` uses in `dispatch.rs:358-387`). Add any needed `use` imports at the top of `items_actions.rs`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd crates/wickedways-core && cargo test --lib && cargo build -p wickedways-core --no-default-features`
Expected: PASS (new test + all existing `use_item_*` tests unchanged — no item in those catalogs has a behaviors entry, so `on_use` is a no-op there).

- [ ] **Step 6: Commit**

```bash
git add crates/wickedways-core/src/world/items_actions.rs crates/wickedways-core/src/world/mechanics/dispatch.rs
git commit -m "feat(core): fire scripted onUse effects inside use_item"
```

---

## Task 4: `Command::Read` + fire `on_read` inside `read_item`

**Files:**
- Modify: `crates/wickedways-core/src/world/command.rs` (`Command` enum lines 14-36, `apply_command` lines 38-80)
- Modify: `crates/wickedways-core/src/world/submit.rs` (`read_item`, lines 314-340)
- Test: `crates/wickedways-core/src/world/submit.rs` (`#[cfg(test)] mod tests`), and a `command.rs` deserialization test

**Interfaces:**
- Consumes: `ScriptedItem::run_read` (Task 2); `BehaviorScript::Item` (Task 1); `World::read_item`.
- Produces: `Command::Read { target_id: String }` (serde `{ "kind": "read", "targetId": "..." }`) dispatching to `read_item`; `read_item` applies `on_read` effects before the lore cue. Task 7's replay fixture consumes `Command::Read`.

- [ ] **Step 1: Write the failing tests**

(a) In `command.rs` tests, a deserialization round-trip:

```rust
#[test]
fn read_command_deserializes() {
    let c: Command = serde_json::from_value(serde_json::json!({
        "kind": "read", "targetId": "item-note"
    })).unwrap();
    assert!(matches!(c, Command::Read { target_id } if target_id == "item-note"));
}
```

(b) In `submit.rs` tests, an integration test: an item with lore AND an `on_read` emitting `AdjustStat(Actor, Sanity, -2)`. Read it; assert sanity dropped by 2 **and** the lore cue was emitted, with the stat change ordered before the lore cue (i.e. read `read_item` produces the lore `Mechanic` cue and the stat is already adjusted). Mirror the existing `read_item_*` tests (submit.rs:712-744) and `cat_with_items` (add a behaviors entry):

```rust
#[test]
fn read_item_runs_scripted_on_read_before_lore_cue() {
    use crate::script::ast::{BehaviorScript, EffectTemplate, Expr, ItemScript, Stmt};
    use crate::script::value::Value;
    let mut w = world_for_submit();
    let pc = cid("pc");
    w.characters.get_mut(&pc).unwrap().stats.sanity = 7.0;

    // Build a catalog: the herb (has lore "Bitter leaves.") + an on_read script.
    let mut cat = cat_with_items();
    cat.behaviors.insert("items/herb".to_string(), BehaviorScript::Item {
        script: ItemScript {
            on_use: None,
            on_read: Some(alloc::vec![Stmt::Emit { effect: EffectTemplate::AdjustStat {
                target: Expr::Actor, stat: StatType::Sanity, delta: Expr::Lit { value: Value::Number(-2.0) },
            }}]),
        },
    });

    // Move the herb into inventory, then read it.
    let mut opened = BTreeSet::new();
    w.submit(Intent::Take { target_id: "item-herb".into() }, &cat, &mut opened);
    let mut cues = Vec::new();
    w.read_item(&pc, &iid("item-herb"), &cat, &mut cues).unwrap();

    assert_eq!(w.characters[&pc].stats.sanity, 5.0, "onRead drained 2 sanity");
    // The lore cue is still emitted (and after the stat change).
    assert!(cues.iter().any(|c| matches!(c,
        PresentationCue::Mechanic { cue } if cue.text.as_deref() == Some("Bitter leaves."))));
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd crates/wickedways-core && cargo test --lib read_command_deserializes read_item_runs_scripted_on_read`
Expected: FAIL — `Command::Read` doesn't exist; sanity unchanged.

- [ ] **Step 3: Add `Command::Read` + dispatch arm**

In `crates/wickedways-core/src/world/command.rs`, add to the `Command` enum (mirror the `Use { target_id }` variant's serde shape — the enum is `#[serde(tag="kind", rename_all="camelCase")]`, so `Read` serializes as `"read"` and `target_id` as `targetId`):

```rust
    Read { target_id: String },
```

In `apply_command`, add the arm (mirror the `Use` arm at lines ~61-63):

```rust
        Command::Read { target_id } => {
            world.read_item(&actor, &ItemId(target_id), cat, cues)
        }
```

Ensure `actor` is resolved the same way the `Use` arm resolves it (reuse the existing active-actor binding in `apply_command`).

- [ ] **Step 4: Fire `on_read` in `read_item`**

In `crates/wickedways-core/src/world/submit.rs`, `read_item` (lines 314-340). Currently: held check → get snap → `resolve_item` → if lore, push cue. Restructure so the `on_read` effects apply **before** the lore cue (TS `Character.read` runs the read closure, then emits lore — `character.ts:788-790`). Because the effect application needs `&mut self` while the snapshot borrow is immutable, capture the behavior key first:

```rust
        // Capture behavior_key (for on_read) + resolve for lore, dropping the
        // snapshot borrow before we mutate self.
        let behavior_key = match self.items.get(item) {
            Some(crate::world::snapshot::ItemSnapshot::Item { behavior_key, .. }) => {
                Some(behavior_key.clone())
            }
            _ => None,
        };
        let snap = self
            .items
            .get(item)
            .ok_or_else(|| ProceduralViolation("Item snapshot not found.".into()))?;
        let resolved = resolve_item(snap, cat)?;
        let lore = resolved.lore.clone();

        // Author read-behaviour (scripted onRead): runs BEFORE the lore cue
        // (src/lib/character/character.ts:788-790). Absent script = no-op.
        if let Some(key) = &behavior_key {
            if let Some(crate::script::ast::BehaviorScript::Item { script }) =
                cat.behaviors.get(key)
            {
                let view = self.build_campaign_view(cat);
                if let Some(actor_view) = self.character_view(actor, cat) {
                    let effects = {
                        let rng = &mut self.rng;
                        let mut state = serde_json::Value::Null;
                        let mut base = crate::world::mechanics::HookCtx {
                            state: &mut state, view: &view, rng,
                        };
                        crate::script::ops::ScriptedItem { script }.run_read(&mut base, &actor_view)
                    };
                    if effects.len() > crate::world::mechanics::dispatch::MAX_EFFECTS_PER_EVENT {
                        return Err(ProceduralViolation(alloc::format!(
                            "Item '{}' emitted too many effects.", key
                        )));
                    }
                    self.apply_all(effects, cat, cues)?;
                }
            }
        }

        if let Some(lore) = lore {
            cues.push(PresentationCue::Mechanic {
                cue: MechanicCue { text: Some(lore), sound: None },
            });
        }
        Ok(())
```

Replace the current `resolve_item` + lore-cue tail (submit.rs:329-339) with the above. Keep the earlier held-check unchanged (lines 321-328). Add any needed imports.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd crates/wickedways-core && cargo test --lib && cargo build -p wickedways-core --no-default-features`
Expected: PASS (new tests + existing `read_item_*` tests unchanged — `cat_with_items` has no behaviors entry for the herb, so `on_read` is a no-op and the lore cue still fires exactly as before).

- [ ] **Step 6: Commit**

```bash
git add crates/wickedways-core/src/world/command.rs crates/wickedways-core/src/world/submit.rs
git commit -m "feat(core): add Command::Read + fire scripted onRead before lore cue"
```

---

## Task 5: TS `item(...)` builder + author + register laudanum's `onUse`

**Files:**
- Modify: `packages/campaigns/src/scripted/builders.ts` (add `item` builder near the `mechanic`/`exit`/`victory` builders, lines ~87-114)
- Modify: `packages/campaigns/src/hollow-house/scripted.ts` (add `laudanumScript`; register in `hollowHouseBehaviors()`, lines ~108-121)
- Test: `packages/campaigns/src/scripted/builders.test.ts` (or the existing scripted builder test file — co-locate)

**Interfaces:**
- Consumes: the regenerated `BehaviorScript` / `ItemScript` TS bindings (Task 1); the `emit`/`adjust`/`actor`/`lit` builders already in `builders.ts`.
- Produces: `item({ onUse?, onRead? })` returning `{ family: "item", script: { onUse?, onRead? } }` typed as `BehaviorScript`; `laudanumScript`; `hollowHouseBehaviors()[Items.Laudanum]` populated.

- [ ] **Step 1: Write the failing builder test**

In the scripted builders test file, assert the emitted AST shape:

```ts
import { item, emit, adjust, actor, lit } from "wickedways-campaigns/scripted/builders"; // match the real import path
import { StatType } from "wickedways/lib/character/stats";

it("item() emits an item-family BehaviorScript with onUse", () => {
  const b = item({ onUse: [emit(adjust(actor, StatType.Sanity, lit(6)))] });
  expect(b).toEqual({
    family: "item",
    script: { onUse: [{ kind: "emit", effect: { kind: "adjustStat", target: { kind: "actor" }, stat: "sanity", delta: { kind: "lit", value: 6 } } }] },
  });
});
```

Match the exact shapes the existing `mechanic(...)` test asserts (the `emit`/`adjust` builders already produce `{ kind: "emit", effect: {...} }` and `{ kind: "adjustStat", ... }` per `builders.ts:67,77-78`). Confirm `StatType.Sanity` serializes to `"sanity"`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/campaigns/src/scripted/builders.test.ts`
Expected: FAIL — `item` is not exported.

- [ ] **Step 3: Add the `item` builder**

In `packages/campaigns/src/scripted/builders.ts`, after the `victory(...)` builder (lines ~111-114), add (mirror the `mechanic` builder's `family`/`script` return shape, and import the `ItemScript` binding type):

```ts
export function item(spec: {
  onUse?: Stmt[];
  onRead?: Stmt[];
}): BehaviorScript {
  const script: ItemScript = {};
  if (spec.onUse !== undefined) script.onUse = spec.onUse;
  if (spec.onRead !== undefined) script.onRead = spec.onRead;
  return { family: "item", script };
}
```

Add `ItemScript` to the bindings import at the top of the file (alongside `BehaviorScript`, `MechanicScript`, etc.). Use the real `Stmt` type name already imported for the other builders.

- [ ] **Step 4: Author `laudanumScript` + register it**

In `packages/campaigns/src/hollow-house/scripted.ts`, add near the other scripts (e.g. after `dreadScript`):

```ts
// Mirrors laudanum's TS closure (items.ts:44):
//   use(holder) { holder[ADJUST_STAT](this.stat, this.modifier); }
// i.e. +6 Sanity on use. The closure stays the gate oracle; this reproduces it.
export const laudanumScript = item({
  onUse: [emit(adjust(actor, StatType.Sanity, lit(6)))],
});
```

Ensure `item`, `emit`, `adjust`, `actor`, `lit` are imported from `./builders` (or wherever the other scripts import their builders), and `StatType` from the character stats module, and `Items` from `./ids.js`. Then add to `hollowHouseBehaviors()` (lines ~108-121):

```ts
    [Items.Laudanum]: laudanumScript,
```

- [ ] **Step 5: Run the builder test + typecheck**

Run:
```bash
pnpm vitest run packages/campaigns/src/scripted/builders.test.ts
pnpm -r run typecheck
```
Expected: PASS + typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add packages/campaigns/src/scripted/builders.ts packages/campaigns/src/hollow-house/scripted.ts packages/campaigns/src/scripted/builders.test.ts
git commit -m "feat(campaigns): item() builder + laudanum onUse script"
```

---

## Task 6: Laudanum-use differential fixture (real Hollow House oracle)

**Files:**
- Create: `conformance/fixtures/laudanum-use.gen.test.ts` (generator)
- Create: `conformance/laudanum-use.test.ts` (replay)
- Modify: `conformance/fixtures/vitest.config.ts` (add the generator to `include`)
- Generated (committed): `conformance/fixtures/laudanum-use.start.snapshot.json`, `.catalog.json`, `.golden.json`

**Interfaces:**
- Consumes: the real `laudanum` factory (`packages/campaigns/src/hollow-house/items.ts`), `hollowHouseBehaviors()` (now with `laudanumScript`, Task 5), `buildCatalog` (`conformance/fixtures/scripted-helpers.ts:40-52`), `wasm.replay_commands`.
- Produces: a golden proving the scripted `onUse` reproduces laudanum's TS `use` closure byte-for-byte.

- [ ] **Step 1: Write the generator**

Create `conformance/fixtures/laudanum-use.gen.test.ts`, modeled on `conformance/fixtures/scripted-mechanics.gen.test.ts` (read it in full first). Requirements:
- Import the **real** `laudanum` factory from `packages/campaigns/src/hollow-house/items.ts` and `Items` from its `ids.js`; import `hollowHouseBehaviors` from `packages/campaigns/src/hollow-house/scripted.ts`.
- Build a bespoke campaign (`authorTemplate` + `defineRegistry({ items: { [Items.Laudanum]: laudanum } })` + `startSession`) with:
  - one archetype whose base **Sanity is 4** (so +6 → 10 is observable and exercises the uncapped-up direction — the direction dread's −1 fixture does not cover),
  - one lit room holding a chest that contains the laudanum,
  - `rng: () => 0.5`, `now: () => 0`, `maxRounds` with headroom.
- Command stream (all budgeted actions after a `startTurn`): `startTurn`, `take <laudanum id>`, `use <laudanum id>`.
- Drive the TS oracle exactly as `scripted-mechanics.gen.test.ts` / `items-actions.gen.test.ts` do: `startTurn` → `pc.startTurn()`; `take` → open+`takeFromLootBox`; `use` → `findHeld(id).actions.use(pcNow())` (this runs the real closure → +6 Sanity).
- Capture per step `{ command, cues: drain(), snapshot: serializeCampaign(campaign), view: viewProjected(...) }`.
- Build the catalog via `buildCatalog(itemFactories, itemKeys, aliases, hollowHouseBehaviors())` so `catalog.behaviors[Items.Laudanum]` carries `laudanumScript`.
- **Self-validation** (the generator must fail loudly if it isn't exercising the effect): assert that some step's `view` shows Sanity increased by 6 relative to the pre-use step, and that the final step's inventory no longer contains the laudanum (consumed).
- Write `laudanum-use.start.snapshot.json`, `laudanum-use.catalog.json`, `laudanum-use.golden.json` (`{ seed, commands, steps }` — match `scripted-mechanics`'s golden shape, including `seed`).

- [ ] **Step 2: Register the generator + generate the golden**

Add `"conformance/fixtures/laudanum-use.gen.test.ts"` to the `include` array in `conformance/fixtures/vitest.config.ts`. Then:

Run: `pnpm run fixtures:gen`
Expected: PASS (self-validation holds); three `laudanum-use.*.json` files written under `conformance/fixtures/`.

- [ ] **Step 3: Write the replay test**

Create `conformance/laudanum-use.test.ts`, modeled on `conformance/scripted-mechanics.test.ts` (read it first — 37 lines). It loads the three JSON files, calls `wasm.replay_commands(startSnapshot, JSON.stringify(golden.commands), catalogJson, golden.seed)`, and asserts per-step `canonicalize(actual.cues) === canonicalize(expected.cues)` (and snapshot + view) for every step. The wasm bridge is `require("../crates/wickedways-wasm/pkg/wickedways_wasm.js").replay_commands`.

- [ ] **Step 4: Build the conformance wasm + run the replay**

Run:
```bash
pnpm run wasm:build:conformance
pnpm vitest run --config conformance/vitest.config.ts laudanum-use
```
Expected: PASS — the scripted `onUse` (`+6` via `Effect::AdjustStat`) matches the oracle closure byte-for-byte.

**If it diverges:** the fix goes in the Rust interpreter / apply path (per the Global Constraints), **not** the golden. The most likely divergence is the uncapped-up `AdjustStat` direction (dread only exercises `−1`); check `adjust_stat` (dispatch.rs:42-61) against the TS `ADJUST_STAT` semantics for `+N`.

- [ ] **Step 5: Commit**

```bash
git add conformance/fixtures/laudanum-use.gen.test.ts conformance/fixtures/laudanum-use.*.json conformance/laudanum-use.test.ts conformance/fixtures/vitest.config.ts
git commit -m "test(conformance): laudanum onUse differential fixture (real HH oracle)"
```

---

## Task 7: Synthetic `onRead` differential fixture

**Files:**
- Create: `conformance/fixtures/read-effects.gen.test.ts` (generator)
- Create: `conformance/read-effects.test.ts` (replay)
- Modify: `conformance/fixtures/vitest.config.ts` (add the generator to `include`)
- Generated (committed): `conformance/fixtures/read-effects.start.snapshot.json`, `.catalog.json`, `.golden.json`

**Interfaces:**
- Consumes: the `item(...)` builder (Task 5); `Command::Read` (Task 4); `buildCatalog`; `wasm.replay_commands`.
- Produces: a golden proving scripted `onRead` reproduces a TS read closure and that the read effect is ordered before the lore cue.

**Note on the oracle:** No first-party Hollow House item has a non-noop `read` closure (they only carry lore), so this fixture uses a **synthetic** item with an authored `read` action closure — the same synthetic-item approach `items-actions.gen.test.ts` uses. This is the intended shape; call it out in a file-header comment.

- [ ] **Step 1: Write the generator**

Create `conformance/fixtures/read-effects.gen.test.ts`, modeled on `scripted-mechanics.gen.test.ts` and `items-actions.gen.test.ts`:
- Define a synthetic "Cursed Note" item factory: `type: Consumable`, `usable: false`, has `lore: "The ink writhes."`, and a `read` action closure that drains Sanity:
  ```ts
  import { ADJUST_STAT } from "wickedways/lib/mechanics/symbols";
  // ...
  actions: {
    pickUp: noop, equip: noop, unequip: noop, transfer: noop, use: noop,
    read: (holder) => holder[ADJUST_STAT](StatType.Sanity, -2),
    destroy: () => null,
  },
  ```
  (Confirm the `Item` `actions` object accepts a `read` entry — `ItemAction.Read` exists in `src/lib/inventory.ts`. If the type requires it, include all action keys.)
- Author the matching scripted behavior with the builder:
  ```ts
  const NOTE_KEY = "items/cursed-note";
  const behaviors = { [NOTE_KEY]: item({ onRead: [emit(adjust(actor, StatType.Sanity, lit(-2)))] }) };
  ```
- Build a bespoke campaign: archetype Sanity 7, a lit room with a chest containing the note.
- Command stream: `startTurn`, `take <note id>`, `read <note id>`.
- Drive the oracle: `read` → `pcNow().read(findHeld(id))` (runs the read closure → −2 Sanity, then emits the lore cue via `Character.read`).
- Capture per step `{ command, cues, snapshot, view }`.
- Build the catalog via `buildCatalog(itemFactories, [NOTE_KEY], aliases, behaviors)`.
- **Self-validation:** assert a step's `view` shows Sanity dropped by 2, and that the read step's `cues` include the lore mechanic cue (`"The ink writhes."`).
- Write the three `read-effects.*.json` files. Ensure the stored `commands` include `{ kind: "read", targetId: <note id> }` so the Rust replay deserializes into `Command::Read`.

- [ ] **Step 2: Register + generate**

Add `"conformance/fixtures/read-effects.gen.test.ts"` to `conformance/fixtures/vitest.config.ts` `include`. Then:

Run: `pnpm run fixtures:gen`
Expected: PASS; three `read-effects.*.json` files written.

- [ ] **Step 3: Write the replay test**

Create `conformance/read-effects.test.ts`, modeled on `conformance/scripted-mechanics.test.ts`: load the JSON, `replay_commands(...)`, assert per-step `cues`/`snapshot`/`view` via `canonicalize`.

- [ ] **Step 4: Build + run the replay**

Run:
```bash
pnpm run wasm:build:conformance
pnpm vitest run --config conformance/vitest.config.ts read-effects
```
Expected: PASS — scripted `onRead` drains Sanity **before** the lore cue, matching the oracle. A divergence in ordering means the `on_read` apply must move before the lore-cue push in `read_item` (Task 4) — fix in Rust, not the golden.

- [ ] **Step 5: Commit**

```bash
git add conformance/fixtures/read-effects.gen.test.ts conformance/fixtures/read-effects.*.json conformance/read-effects.test.ts conformance/fixtures/vitest.config.ts
git commit -m "test(conformance): synthetic onRead differential fixture"
```

---

## Task 8: Documentation + full `checks:phase2` gate

**Files:**
- Modify: `README.md` (the items / use+read section)
- Modify: relevant TSDoc (the `item(...)` builder in `packages/campaigns/src/scripted/builders.ts`; the hollow-house `scripted.ts` header)

**Interfaces:** none (docs + gate only).

- [ ] **Step 1: Update the README**

Per the project's standing convention (`CLAUDE.md`: "update `README.md` before considering the work done"), document that item `use`/`read` behavior can be authored as scripted `onUse` / `onRead` effect hooks (the `Item` behavior family), interpreted by the Rust core and gated against the TS closures. Add it to the section that already covers items / usable consumables / the DSL behavior families. Note the ordering contract (onUse after usable/KO guards, before grantsImmunity+consume; onRead before the lore cue) and that laudanum is the first dogfooded example.

- [ ] **Step 2: Add/curate TSDoc**

Ensure the `item(...)` builder and `laudanumScript` carry TSDoc explaining the hook semantics and the "closure stays the oracle" relationship.

- [ ] **Step 3: Run the full gate**

Run: `pnpm run checks:phase2`
Expected: PASS end-to-end — including `cargo build --no-default-features` (no_std), `cargo test --workspace`, `bindings:check` (bindings committed in Task 1), both wasm builds, `assert-no-conformance.mjs`, `test:conformance` (all fixtures incl. the two new ones), and the TS typecheck + vitest suites.

If `bindings:check` fails here, the Task-1 regenerated bindings were not committed — regenerate (`pnpm run bindings:gen`), stage `generated/bindings/`, and re-run.

- [ ] **Step 4: Commit**

```bash
git add README.md packages/campaigns/src/scripted/builders.ts packages/campaigns/src/hollow-house/scripted.ts
git commit -m "docs: document scripted item onUse/onRead hooks"
```

---

## Self-Review

**1. Spec coverage** (against the Option-B decision + DSL spec invariants):
- Scripted `onUse` → Tasks 1-3, 5, 6. ✅
- Scripted `onRead` → Tasks 1, 2, 4, 7. ✅
- No descriptor churn on noop items (`healing-tonic`) → guaranteed: items without a `behaviors` entry are no-ops; the existing `items-actions` golden is untouched and re-run by `test:conformance` in Task 8. ✅
- Gate is the authority; oracle closures retained → Global Constraints + Tasks 5-7 (closure kept, script authored alongside). ✅
- Determinism / `no_std` / bindings artifacts → Global Constraints, verified every task (no_std build) + Task 1 (bindings) + Task 8 (full gate). ✅
- TS-faithful ordering → Tasks 3 (onUse position) + 4 (onRead-before-lore). ✅

**2. Placeholder scan:** No "TBD"/"handle appropriately". Two intentional "match the real signature/helper names" notes (Task 1 `check_stmts` arg order; Task 2/3 `build_campaign_view`/`character_view`/`MAX_EFFECTS_PER_EVENT` paths) point the implementer at the exact existing call sites (`dispatch.rs:358-387`, `script/mod.rs`) to copy — these are lookups, not undefined work.

**3. Type consistency:** `ItemScript { on_use, on_read }` (Rust) ↔ `{ onUse, onRead }` (serde camelCase → TS binding) ↔ `item({ onUse, onRead })` (builder). `BehaviorScript::Item { script }` (Rust) ↔ `{ family: "item", script }` (serde tag `family`). `Effect::AdjustStat { target, stat, delta }` matches `EffectTemplate::AdjustStat { target, stat, delta }`. `Command::Read { target_id }` ↔ `{ kind: "read", targetId }`. Consistent across tasks.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-07-rust-engine-item-action-effects.md`. Two execution options:

1. **Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session with batch checkpoints.

Which approach?
