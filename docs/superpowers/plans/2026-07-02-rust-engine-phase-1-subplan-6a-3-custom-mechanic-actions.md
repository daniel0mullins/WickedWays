# Sub-plan 6a-3: Custom Mechanic Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the last piece of the `MechanicOp` contract — custom actions (`useMechanicAction`) — as a native, gate-tested feature, and fold in the hygiene bundle 6a-2's review scheduled for the same files.

**Architecture:** A defaulted `MechanicOp::run_action` method; a `World::use_mechanic_action` that gates → invokes the op's action → applies effects → records the budgeted `mechanicAction` (tick + `on_action` + cap-check); a new `Command::MechanicAction`. Verified by unit tests + a differential fixture, with the `conformance:dread` TS shadow extracted to a shared module.

**Tech Stack:** Rust (`crates/wickedways-core`, `no_std` + `alloc`), TS oracle (`src/lib/`), vitest differential conformance gate (`conformance/`).

## Global Constraints

- **The conformance gate is the authority.** Divergences are fixed in Rust source (or a faithful fixture correction) — NEVER by editing goldens or `conformance/canonical-json.ts`.
- **`no_std` core.** New code uses `alloc::` only, never `std::`. Must build under `cargo build -p wickedways-core --no-default-features`.
- **Byte-exact vs the TS oracle:** `useMechanicAction` (character.ts:1095-1099) = gate (`attemptAction`, Confused fizzle → fumble) → `INVOKE_MECHANIC_ACTION` (campaign.ts:732-747: find mechanic→throw "not enabled", find action→throw "no action", 64-effect cap, apply effects) → `recordAction(this.useMechanicAction, {kind:"mechanicAction", mechanic, action})`. `useMechanicAction` **is budgeted** (`isActionMap.set(this.useMechanicAction, true)`, character.ts:503) → the record ticks the budget, dispatches `onAction`, cap-checks → `endTurn`. Cue order: the action's effect cues → the `mechanicAction` Action cue → `onAction` cues.
- **`cost` is v1-inert** (every custom action costs 1).
- **Error text is not gate-observable** (a `ProceduralViolation` aborts replay) — clear messages; exact wording need not match TS.
- **The conformance op stays feature-gated** (`#[cfg(any(test, feature = "conformance"))]`); absent from the default build.
- **No pre-existing golden churn:** existing fixtures issue no `MechanicAction` command, so their behavior is unchanged. The shared-shadow extraction (Task 3) MUST regenerate the existing `mechanics`/`mechanics-turnend` goldens **byte-identically** (behavior relocated, not changed). After each task, `git status --short conformance/fixtures` shows only intended changes.
- All rng via the injected ctx.
- Full gate: `pnpm run checks:phase3`; idempotence: `pnpm run fixtures:stable`; crate tests: `cargo test -p wickedways-core`.

## File Structure

- `crates/wickedways-core/src/world/mechanics/mod.rs` — `MechanicOp::run_action` trait method (Task 1).
- `crates/wickedways-core/src/world/mechanics/conformance.rs` — `conformance:dread`'s `brace` action (Task 1).
- `crates/wickedways-core/src/world/mechanics/dispatch.rs` — `World::use_mechanic_action` (Task 2); hygiene: `dispatch_action` comment + hoist actor-view guard (Task 4).
- `crates/wickedways-core/src/world/command.rs` — `Command::MechanicAction` + dispatch arm (Task 2).
- `conformance/fixtures/dread-shadow.ts` (new, shared TS shadow) + `mechanics-action.gen.test.ts` + `conformance/mechanics-action.test.ts` + `conformance/fixtures/vitest.config.ts`; edits to `mechanics.gen.test.ts` + `mechanics-turnend.gen.test.ts` to import the shared shadow (Task 3).
- `crates/wickedways-core/src/world/mechanics/view.rs` (unused `use super::*;` at :126) + `crates/wickedways-core/src/world/combat.rs` (unused `SceneSnapshot` import ~:739) — hygiene (Task 4).
- `README.md` (Task 4).

## Interfaces (used across tasks)

- `MechanicOp::run_action(&self, action_key: &str, cx: &mut ActionCtx) -> Option<Vec<Effect>>` (default `None`) — Task 1.
- `World::use_mechanic_action(&mut self, actor: &CharacterId, mechanic_key: &str, action_key: &str, cat: &Catalog, cues: &mut Vec<PresentationCue>) -> Result<(), ProceduralViolation>` — Task 2.
- `Command::MechanicAction { mechanic_key: String, action_key: String }` — Task 2.
- Existing (consumed): `self.gate(actor, is_move) -> GateVerdict`; `record_fumble(actor, action, budgeted, cat, cues) -> Result`; `record_action(actor, budgeted, action_kind, cat, cues) -> Result`; `apply_all(effects, cat, cues) -> Result`; `build_campaign_view(cat)`; `character_view(actor, cat) -> Option<CharacterView>`; `entity_ref_char(id) -> EntityRef`; `mechanic_op(key)`; `MAX_EFFECTS_PER_EVENT`; `ActionCtx`/`ActionView`/`HookCtx`; `ActionHistoryEntry::MechanicAction { round, mechanic, action }`; `ActionKind::MechanicAction`.

---

## Task 1: `run_action` trait method + `dread` brace action

**Files:**
- Modify: `crates/wickedways-core/src/world/mechanics/mod.rs` (trait)
- Modify: `crates/wickedways-core/src/world/mechanics/conformance.rs` (op + tests)

**Interfaces:**
- Produces: `MechanicOp::run_action(&self, action_key: &str, cx: &mut ActionCtx) -> Option<Vec<Effect>>` (default `None`); `conformance:dread` resolves `"brace"` → `[Cue, AdjustStat]`, else `None`.

- [ ] **Step 1: Write the failing tests**

Add to the `tests` module in `crates/wickedways-core/src/world/mechanics/conformance.rs`:

```rust
    #[test]
    fn brace_effects_heal_actor_sanity_with_cue() {
        use crate::world::ids::CharacterId;
        let fx = brace_effects(&CharacterId("pc".into()));
        assert_eq!(fx.len(), 2);
        assert!(matches!(&fx[0], Effect::Cue { cue } if cue.text.as_deref() == Some("You brace against the dread.")));
        assert!(matches!(&fx[1],
            Effect::AdjustStat { target, stat: StatType::Sanity, delta }
            if target == &CharacterId("pc".into()) && *delta == 1.0));
    }

    #[test]
    fn dread_default_run_action_returns_none_for_unknown_key() {
        // A dummy op with no actions returns None (the trait default).
        struct NoActions;
        impl MechanicOp for NoActions {
            fn init_state(&self, _c: &Value) -> Value { json!({}) }
        }
        // Unknown key on dread also yields None (only "brace" is defined) — verified
        // via brace_effects coverage above + the dispatch-level test in Task 2.
        assert!(NoActions.run_action("anything", &mut dummy_action_ctx()).is_none());
    }
```

Add a tiny `#[cfg(test)]` helper in the same module to build a throwaway `ActionCtx` for the default-None test (the default never touches the ctx, so a minimal one suffices):

```rust
    #[cfg(test)]
    fn dummy_action_ctx<'a>() -> crate::world::mechanics::ActionCtx<'a> {
        // The trait-default run_action ignores cx, so field values are irrelevant;
        // this only needs to type-check. If constructing ActionCtx here is awkward
        // (borrows), instead assert the default via a dispatch-level path in Task 2
        // and keep only `brace_effects_heal_actor_sanity_with_cue` here.
    }
```

Note: constructing an `ActionCtx` in a unit test requires live `&mut Value`/`&mut Rng`/`&CampaignView` borrows, which is awkward. If it fights the borrow checker, DROP the `dread_default_run_action_returns_none_for_unknown_key` test and its helper — the `None` path is covered at the dispatch level by Task 2's "no action" test (`use_mechanic_action` with a bogus action key → `Err`). Keep `brace_effects_heal_actor_sanity_with_cue` as the Task-1 unit test.

- [ ] **Step 2: Run to confirm failure**

Run: `cargo test -p wickedways-core conformance::tests::brace_effects`
Expected: compile error (`brace_effects` not defined) — the RED.

- [ ] **Step 3: Add the trait method**

In `crates/wickedways-core/src/world/mechanics/mod.rs`, add to the `MechanicOp` trait (after `modify_damage`):

```rust
    /// Run a named custom action (TS `CustomAction.run`). `None` = this op has no
    /// action under `action_key` (→ a `ProceduralViolation` at the invoke site,
    /// mirroring TS's "has no action" throw). `cost` is v1-inert (every action costs 1).
    fn run_action(&self, _action_key: &str, _cx: &mut ActionCtx) -> Option<Vec<Effect>> { None }
```

- [ ] **Step 4: Add dread's brace action**

In `crates/wickedways-core/src/world/mechanics/conformance.rs`, add `use crate::world::ids::CharacterId;` to the imports, add the free helper (next to `cap`):

```rust
/// Effects for the `conformance:dread` "brace" custom action: a cue plus a small
/// sanity heal on the bracing actor (a party member, so the party-only effect-target
/// check passes). Extracted as a free fn for direct unit testing.
fn brace_effects(actor: &CharacterId) -> Vec<Effect> {
    vec![
        cue("You brace against the dread."),
        Effect::AdjustStat { target: actor.clone(), stat: StatType::Sanity, delta: 1.0 },
    ]
}
```

and add the method to `impl MechanicOp for Dread` (after `modify_damage`):

```rust
    fn run_action(&self, action_key: &str, cx: &mut ActionCtx) -> Option<Vec<Effect>> {
        match action_key {
            "brace" => Some(brace_effects(&cx.actor.id)),
            _ => None,
        }
    }
```

- [ ] **Step 5: Run tests + no_std**

Run: `cargo test -p wickedways-core conformance::` and `cargo test -p wickedways-core mechanics::`
Expected: PASS.
Run: `cargo build -p wickedways-core --no-default-features` and `cargo build -p wickedways-core --features conformance`
Expected: both succeed.

- [ ] **Step 6: Commit**

```bash
git add crates/wickedways-core/src/world/mechanics/mod.rs crates/wickedways-core/src/world/mechanics/conformance.rs
git commit -m "feat(core): MechanicOp::run_action + conformance:dread brace action (sub-plan 6a-3)"
```

---

## Task 2: `use_mechanic_action` + `Command::MechanicAction`

**Files:**
- Modify: `crates/wickedways-core/src/world/mechanics/dispatch.rs` (`use_mechanic_action` + tests)
- Modify: `crates/wickedways-core/src/world/command.rs` (`Command::MechanicAction` + arm)

**Interfaces:**
- Consumes: `run_action` (Task 1); `gate`/`record_fumble`/`record_action`/`apply_all`/`build_campaign_view`/`character_view`/`entity_ref_char`/`mechanic_op`/`MAX_EFFECTS_PER_EVENT`.
- Produces: `World::use_mechanic_action(...) -> Result<(), ProceduralViolation>`; `Command::MechanicAction { mechanic_key, action_key }`.

- [ ] **Step 1: Write the failing tests**

Add to the `tests` module in `crates/wickedways-core/src/world/mechanics/dispatch.rs` (uses the `with_dread` helper that pushes a `conformance:dread` `MechanicSnapshot` onto `w.campaign.mechanics` — add it if not already in this module, mirroring `turn.rs`):

```rust
    #[test]
    fn use_mechanic_action_not_enabled_errors() {
        let mut w = world_with_party(&["pc"], 10); // no mechanics
        let mut cues = Vec::new();
        let r = w.use_mechanic_action(&cid("pc"), "conformance:dread", "brace", &Catalog::default(), &mut cues);
        assert!(r.is_err(), "invoking an action on a non-enabled mechanic must error");
    }

    #[test]
    fn use_mechanic_action_missing_action_errors() {
        let mut w = with_dread(world_with_party(&["pc"], 10));
        let mut cues = Vec::new();
        let r = w.use_mechanic_action(&cid("pc"), "conformance:dread", "nope", &Catalog::default(), &mut cues);
        assert!(r.is_err(), "invoking an undefined action key must error");
    }

    #[test]
    fn use_mechanic_action_brace_applies_effects_records_and_dispatches_on_action() {
        use crate::world::history::ActionHistoryEntry;
        let mut w = with_dread(world_with_party(&["pc"], 10)); // sanity 5, actions_per_round 2
        let mut cues = Vec::new();
        w.use_mechanic_action(&cid("pc"), "conformance:dread", "brace", &Catalog::default(), &mut cues).unwrap();
        let ch = w.characters.get(&cid("pc")).unwrap();
        // brace healed sanity +1
        assert_eq!(ch.stats.sanity, 6.0);
        // budgeted: one action ticked
        assert_eq!(ch.actions_this_round, 1);
        // MechanicAction history entry recorded
        assert!(ch.history.iter().any(|e| matches!(e,
            ActionHistoryEntry::MechanicAction { mechanic, action, .. }
            if mechanic == "conformance:dread" && action == "brace")));
        // cue order: brace mechanic cue, then the mechanicAction Action cue, then on_action
        let texts: Vec<Option<&str>> = cues.iter().map(|c| match c {
            PresentationCue::Mechanic { cue } => cue.text.as_deref(),
            _ => None,
        }).collect();
        assert!(texts.contains(&Some("You brace against the dread.")));
        assert!(texts.contains(&Some("The dread notices.")), "on_action fired for the budgeted mechanicAction");
        assert!(cues.iter().any(|c| matches!(c,
            PresentationCue::Action { action: crate::presentation::ActionKind::MechanicAction, .. })));
    }
```

- [ ] **Step 2: Run to confirm failure**

Run: `cargo test -p wickedways-core dispatch::tests::use_mechanic_action`
Expected: compile error (`use_mechanic_action` not defined).

- [ ] **Step 3: Implement `use_mechanic_action`**

In `crates/wickedways-core/src/world/mechanics/dispatch.rs`, add the imports it needs at the top of the file (merge with existing `use` lines):

```rust
use crate::presentation::ActionKind;
use crate::world::gate::GateVerdict;
use crate::world::history::ActionHistoryEntry;
use crate::world::mechanics::{ActionCtx, ActionView, HookCtx};
```

(Some of these may already be imported — do not duplicate.) Add the method inside `impl World`:

```rust
    /// Invoke a mechanic's custom action (TS `useMechanicAction` + `INVOKE_MECHANIC_ACTION`).
    /// Budgeted: gate → run the op's action → apply effects → record the `mechanicAction`
    /// (tick + `on_action` + cap-check → end_turn).
    pub fn use_mechanic_action(
        &mut self,
        actor: &CharacterId,
        mechanic_key: &str,
        action_key: &str,
        cat: &Catalog,
        cues: &mut Vec<PresentationCue>,
    ) -> Result<(), ProceduralViolation> {
        // 1. Gate (is_move = false, budgeted). Fizzle → budgeted fumble; block → err.
        match self.gate(actor, false) {
            GateVerdict::Block(r) => return Err(ProceduralViolation(r)),
            GateVerdict::Fizzle => {
                self.record_fumble(actor, "useMechanicAction", true, cat, cues)?;
                return Ok(());
            }
            GateVerdict::Allow => {}
        }

        // 2. Invoke the action (INVOKE_MECHANIC_ACTION).
        let idx = self
            .campaign
            .mechanics
            .iter()
            .position(|m| m.key == mechanic_key)
            .ok_or_else(|| ProceduralViolation(format!(
                "Mechanic '{}' is not enabled.", mechanic_key
            )))?;
        let op = mechanic_op(mechanic_key).ok_or_else(|| ProceduralViolation(format!(
            "Mechanic '{}' is not registered.", mechanic_key
        )))?;
        let view = self.build_campaign_view(cat);
        let actor_view = self.character_view(actor, cat).ok_or_else(|| ProceduralViolation(format!(
            "Actor '{}' not found.", actor.0
        )))?;
        let effects = {
            let rng = &mut self.rng;
            let m = &mut self.campaign.mechanics[idx];
            let mut cx = ActionCtx {
                base: HookCtx { state: &mut m.state, view: &view, rng },
                actor: actor_view,
                action: ActionView { kind: "mechanicAction".into() },
            };
            match op.run_action(action_key, &mut cx) {
                Some(e) => e,
                None => return Err(ProceduralViolation(format!(
                    "Mechanic '{}' has no action '{}'.", mechanic_key, action_key
                ))),
            }
        };
        if effects.len() > MAX_EFFECTS_PER_EVENT {
            return Err(ProceduralViolation(format!(
                "Mechanic '{}' emitted too many effects.", mechanic_key
            )));
        }
        self.apply_all(effects, cat, cues)?;

        // 3. Record the budgeted mechanicAction (history + cue, then tick + on_action + cap-check).
        let round = self.campaign.round;
        if let Some(c) = self.characters.get_mut(actor) {
            c.history.push(ActionHistoryEntry::MechanicAction {
                round,
                mechanic: mechanic_key.into(),
                action: action_key.into(),
            });
        }
        cues.push(PresentationCue::Action {
            action: ActionKind::MechanicAction,
            actor: self.entity_ref_char(actor),
            sound: None,
        });
        self.record_action(actor, true, "mechanicAction", cat, cues)
    }
```

Borrow note: `view`/`actor_view` are owned (built before the `{ let rng = &mut self.rng; let m = &mut … }` block), so the block's two disjoint `&mut self` field borrows (`rng`, `campaign.mechanics[idx]`) don't conflict; `op` is `&'static`. All borrows drop before `apply_all`.

- [ ] **Step 4: Wire the command**

In `crates/wickedways-core/src/world/command.rs`, add to the `Command` enum:

```rust
    #[serde(rename_all = "camelCase")]
    MechanicAction { mechanic_key: String, action_key: String },
```

and to `apply_command`'s match:

```rust
        Command::MechanicAction { mechanic_key, action_key } =>
            world.use_mechanic_action(&actor, &mechanic_key, &action_key, cat, cues),
```

- [ ] **Step 5: Run tests + no_std + gate**

Run: `cargo test -p wickedways-core` — all green (incl. the 4 new tests).
Run: `cargo build -p wickedways-core --no-default-features` — success.
Run: `pnpm run test:conformance` then `git status --short conformance/fixtures` — conformance green, fixture status EMPTY (no fixture issues a MechanicAction yet).

- [ ] **Step 6: Commit**

```bash
git add crates/wickedways-core/src/world/mechanics/dispatch.rs crates/wickedways-core/src/world/command.rs
git commit -m "feat(core): use_mechanic_action + MechanicAction command (sub-plan 6a-3)"
```

---

## Task 3: Differential fixture + shared dread shadow

**Files:**
- Create: `conformance/fixtures/dread-shadow.ts` (shared TS shadow)
- Modify: `conformance/fixtures/mechanics.gen.test.ts` + `conformance/fixtures/mechanics-turnend.gen.test.ts` (import the shared shadow)
- Create: `conformance/fixtures/mechanics-action.gen.test.ts` + `conformance/mechanics-action.test.ts`
- Modify: `conformance/fixtures/vitest.config.ts`

**Interfaces:** consumes the TS oracle + harness; produces a golden the Rust WASM replay must match.

- [ ] **Step 1: Extract the shared shadow**

Read the `conformance:dread` `Mechanic` closure currently duplicated in `conformance/fixtures/mechanics.gen.test.ts` and `mechanics-turnend.gen.test.ts`. Create `conformance/fixtures/dread-shadow.ts` exporting it verbatim, ADDING the `brace` action so it matches the Rust op (`conformance.rs`):

```ts
// The conformance:dread mechanic — a TS "shadow" matching the Rust MechanicOp
// (crates/wickedways-core/src/world/mechanics/conformance.rs) byte-for-byte.
import type { Mechanic, Effect } from "../../src/lib/mechanics/mechanic";

export const dreadShadow: Mechanic<{ ticks: number }> = {
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
  actions: {
    brace: {
      run: (h) => [
        { kind: "cue", cue: { text: "You brace against the dread." } },
        { kind: "adjustStat", target: h.actor.id, stat: "sanity", delta: 1 },
      ],
    },
  },
};
```

Verify the exact import paths + `Mechanic`/`Effect`/`ActionCtx` types against `src/lib/mechanics/mechanic.ts` (the `run` handler receives an `ActionCtx` with `actor`; adjust the closure param typing to match the real types). The pre-`brace` fields must be byte-identical to the existing duplicated shadow.

- [ ] **Step 2: Point the two existing gen fixtures at the shared shadow**

In `mechanics.gen.test.ts` and `mechanics-turnend.gen.test.ts`, delete the inline `conformance:dread` shadow closure and `import { dreadShadow } from "./dread-shadow";`, registering `dreadShadow` where the inline closure was registered.

- [ ] **Step 3: Regenerate + verify the two existing goldens are byte-identical**

Run the fixture-gen command (per `package.json`, e.g. `pnpm run fixtures:gen`).
Run: `git status --short conformance/fixtures`
Expected: the two existing goldens (`mechanics.golden.json`, `mechanics-turnend.golden.json`) are **unchanged** (`git diff --stat` shows no change to them) — the shadow behavior was only relocated, and the new `brace` action is not exercised by those fixtures. If either golden changed, STOP and investigate (the extraction altered behavior).

- [ ] **Step 4: Author the custom-action fixture**

Create `conformance/fixtures/mechanics-action.gen.test.ts` (fixed SEED, single-PC party, `conformance:dread` enabled via `dreadShadow`), driving one command: `{ kind: "mechanicAction", mechanicKey: "conformance:dread", actionKey: "brace" }`. Record per-step cues+snapshot+view with the standard harness capture. The step's cues must be, in order: `mechanic "You brace against the dread." → action mechanicAction (actor player) → mechanic "The dread notices."`; the snapshot shows the PC's sanity +1 and `actionsThisRound` ticked. Add hard self-validation throws (assert the brace cue, the mechanicAction action cue, and the on_action cue are present in that order, and sanity increased).

Study how a command is issued to the oracle in `mechanics.gen.test.ts` (it may need a `useMechanicAction` call on the character or a resolver command — mirror the existing command-recording mechanism; confirm the generator's command type supports `mechanicAction`).

- [ ] **Step 5: Author the replay test**

Create `conformance/mechanics-action.test.ts` mirroring `conformance/mechanics.test.ts` (per-step `canonicalize()` + `.toEqual()` on cues/snapshot/view + step count + `golden.seed`).

- [ ] **Step 6: Add to vitest config**

Add `mechanics-action.gen.test.ts` to `conformance/fixtures/vitest.config.ts` (mirror the existing entries).

- [ ] **Step 7: Generate + replay**

Run the gen command, then `pnpm run test:conformance`.
Expected: the new `mechanics-action` suite PASSES (Rust replay matches the oracle). If it diverges, fix the RUST source (Task 1/2) or a faithful fixture correction — never a golden/comparator. Likely divergence: cue ordering (brace effects → mechanicAction cue → on_action) or the shadow `brace` not matching the Rust `brace_effects`.

- [ ] **Step 8: Confirm churn is only intended files**

Run: `git status --short conformance/fixtures`
Expected: new `dread-shadow.ts`, `mechanics-action.*` files + the vitest include; the two pre-existing goldens unchanged.

- [ ] **Step 9: Commit**

```bash
git add conformance/fixtures/dread-shadow.ts conformance/fixtures/mechanics.gen.test.ts conformance/fixtures/mechanics-turnend.gen.test.ts conformance/fixtures/mechanics-action.gen.test.ts conformance/fixtures/mechanics-action.*.json conformance/mechanics-action.test.ts conformance/fixtures/vitest.config.ts
git commit -m "test(conformance): custom mechanic action fixture + shared dread shadow (sub-plan 6a-3)"
```

---

## Task 4: Hygiene bundle + docs + full gate

**Files:**
- Modify: `crates/wickedways-core/src/world/mechanics/dispatch.rs` (`dispatch_action` comment + hoist actor-view guard in both dispatchers)
- Modify: `crates/wickedways-core/src/world/mechanics/view.rs` (remove unused `use super::*;` at :126)
- Modify: `crates/wickedways-core/src/world/combat.rs` (drop unused `SceneSnapshot` from the ~:739 import)
- Modify: `README.md`

- [ ] **Step 1: Fix the `dispatch_action` comment**

In `dispatch.rs`, the comment above `dispatch_action`'s `character_view` call was copy-pasted from `dispatch_turn` and refers to "turn hooks"; change it to say it dispatches `on_action` for the (possibly non-party) actor.

- [ ] **Step 2: Hoist the actor-view guard in both dispatchers**

In `dispatch_turn` and `dispatch_action`, replace the pattern:

```rust
        let actor_view = self.character_view(actor, cat);
        ...
            let Some(av) = actor_view.clone() else { continue };
```

with a single early return above the mechanic loop:

```rust
        let Some(actor_view) = self.character_view(actor, cat) else { return Ok(()); };
```

and use `actor_view.clone()` directly when constructing each `TurnCtx`/`ActionCtx` (no per-iteration `let Some(...) else continue`). Behavior is unchanged: an absent actor means nothing to dispatch (previously every iteration `continue`d; now one early `Ok(())`).

- [ ] **Step 3: Remove the two unused imports**

- `crates/wickedways-core/src/world/mechanics/view.rs:126` — delete the unused `use super::*;` in the test module.
- `crates/wickedways-core/src/world/combat.rs` (~:739) — change `use crate::world::snapshot::{RoomSnapshot, SceneSnapshot};` to `use crate::world::snapshot::RoomSnapshot;` (only `RoomSnapshot` is used).

- [ ] **Step 4: Run the crate suite + confirm warning-free**

Run: `cargo test -p wickedways-core` — all green.
Run: `cargo build -p wickedways-core --tests 2>&1 | grep "unused import"` — expect NO output (both warnings gone).
Run: `cargo build -p wickedways-core --no-default-features` — success.

- [ ] **Step 5: Update README**

In the mechanics section (match surrounding style), document custom mechanic actions: an op may expose named actions (`run_action`); a player invokes one via the `MechanicAction` command / `useMechanicAction`, which is a budgeted action — it runs the action's effects, records a `mechanicAction`, ticks the budget, and dispatches `on_action`. Keep it concise.

- [ ] **Step 6: Full gate**

Run: `pnpm run checks:phase3` — EXIT 0.
Run: `pnpm run fixtures:stable` — EXIT 0.
Run: `git status --short conformance/fixtures` — empty.

- [ ] **Step 7: Commit**

```bash
git add crates/wickedways-core/src/world/mechanics/dispatch.rs crates/wickedways-core/src/world/mechanics/view.rs crates/wickedways-core/src/world/combat.rs README.md
git commit -m "chore(core): custom-action docs + 6a-2 hygiene bundle (sub-plan 6a-3)"
```

---

## Self-Review Checklist (completed during authoring)

- **Spec coverage:** `run_action` trait + dread brace (T1); `use_mechanic_action` + `MechanicAction` command (T2); differential fixture + shared shadow extraction (T3); hygiene bundle (dispatch_action comment, hoist guard, 2 unused imports) + README + gate (T4). Deferrals (Rhai→6b, exits/scenes/npc→6c+, cost>1) noted.
- **Placeholder scan:** the one awkward spot (constructing an `ActionCtx` for a pure unit test) is called out with an explicit fallback (drop that test; the None path is covered at dispatch level in T2) rather than left vague; all other code steps carry complete code.
- **Type consistency:** `run_action(action_key: &str, cx: &mut ActionCtx) -> Option<Vec<Effect>>`, `use_mechanic_action(...)`, `Command::MechanicAction { mechanic_key, action_key }`, `brace_effects`, and the `"brace"`/`"You brace against the dread."` strings match between the Rust op (T1), the invoke path (T2), and the TS shadow (T3). The `record_action(actor, true, "mechanicAction", …)` call matches the 6a signature.
- **No golden churn:** T2 asserts existing fixtures unchanged (no MechanicAction issued); T3 explicitly verifies the shared-shadow extraction regenerates the two existing goldens byte-identically; T4 confirms the final gate + empty fixture status.
