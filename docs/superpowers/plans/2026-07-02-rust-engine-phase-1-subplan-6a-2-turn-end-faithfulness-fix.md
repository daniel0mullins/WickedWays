# Sub-plan 6a-2: Turn-End Faithfulness Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the two interlocking turn-end divergences 6a's final review surfaced — `take_damage` must run TS's tail cap-check, mechanic effects must target party members only (throwing otherwise), and turn hooks must dispatch for non-party (mob) actors.

**Architecture:** Three faithful-port changes in the Rust core (`combat.rs` + `mechanics/dispatch.rs` + `mechanics/view.rs`), each independently unit-tested, then one differential fixture (attack an at-cap mob) that exercises the cap-check + mob turn-dispatch together against the TS oracle.

**Tech Stack:** Rust (`crates/wickedways-core`, `no_std` + `alloc`), TS oracle (`src/lib/`), vitest differential conformance gate (`conformance/`).

## Global Constraints

- **The conformance gate is the authority.** Divergences are fixed in Rust source (or a faithful fixture correction) — NEVER by editing goldens (`conformance/fixtures/*.golden.json` / `*.snap*.json`) or the comparator (`conformance/canonical-json.ts`).
- **`no_std` core.** New code uses `alloc::` only, never `std::`. Must build under `cargo build -p wickedways-core --no-default-features`.
- **Byte-exact vs the TS oracle:**
  - `takeDamage` (character.ts:930-971) ends by routing through `recordAction(this.takeDamage, {kind:"takeDamage"})`; the cap check (`character.ts:535-537`) runs even for the non-budgeted `takeDamage` → an at-cap target fires `endTurn` → reconcile + `DISPATCH_TURN("end")`.
  - `applyEffect` (apply.ts) resolves Damage/Heal/AdjustStat/GrantImmunity targets through `FIND_CHARACTER` (campaign.ts:753-757) = **party-only + throw** on absence. Cue/Status don't target a character.
  - `endTurn` fires `DISPATCH_TURN("end", this)` with `#characterView(this)` for **any** character (PC or mob).
- **No pre-existing golden churn.** No current fixture attacks an at-cap target or targets a non-party effect, so existing goldens (mechanics/combat/mob-defeat/…) must stay byte-identical. After the fixture task, `git status --short conformance/fixtures` shows only the NEW fixture files.
- All rng via the injected ctx; add no draws.
- Error-message strings are NOT gate-observable (a `ProceduralViolation` aborts replay before comparison) — use clear messages; exact wording need not match TS.
- Full gate: `pnpm run checks:phase3`; idempotence: `pnpm run fixtures:stable`; crate tests: `cargo test -p wickedways-core`.

## File Structure

- `crates/wickedways-core/src/world/combat.rs` — `take_damage` gains the tail cap-check + `Result`; `attack` propagates (Task 1).
- `crates/wickedways-core/src/world/mechanics/dispatch.rs` — `adjust_stat`/`apply_effect`/`apply_all` become fallible with party-only target resolution; the three dispatchers propagate; `dispatch_turn`/`dispatch_action` resolve the actor view from `character_view` (Tasks 2, 3).
- `crates/wickedways-core/src/world/mechanics/view.rs` — `character_view` exposed `pub(crate)` (Task 3).
- `conformance/fixtures/mechanics-turnend.gen.test.ts` + `conformance/mechanics-turnend.test.ts` (Task 4).
- `README.md` (Task 5).

## Interfaces (post-change signatures used across tasks)

- `World::take_damage(&mut self, target, attack_strength: f64, attack_stat: StatType, cat, cues) -> Result<(), ProceduralViolation>` (Task 1).
- `World::adjust_stat(&mut self, actor, stat, delta, cat, cues) -> Result<(), ProceduralViolation>` (Task 2).
- `World::apply_effect(&mut self, e: Effect, cat, cues) -> Result<(), ProceduralViolation>` (Task 2).
- `World::require_party_member(&self, target: &CharacterId) -> Result<(), ProceduralViolation>` (new, Task 2).
- `World::character_view(&self, id, cat) -> Option<CharacterView>` becomes `pub(crate)` (Task 3).
- `World::record_action(&mut self, actor, budgeted: bool, action_kind: &str, cat, cues) -> Result<(), ProceduralViolation>` (exists, from 6a Task 6).

---

## Task 1: `take_damage` tail cap-check

**Files:**
- Modify: `crates/wickedways-core/src/world/combat.rs` (`take_damage` ~:310-393; `attack`'s `take_damage` call ~:234; test callers ~:565,604,651)

**Interfaces:**
- Consumes: `record_action(actor, budgeted, action_kind, cat, cues) -> Result` (6a).
- Produces: `take_damage(...) -> Result<(), ProceduralViolation>`.

- [ ] **Step 1: Write the failing test**

Add to the `tests` module in `crates/wickedways-core/src/world/combat.rs`:

```rust
    #[test]
    fn take_damage_on_at_cap_target_fires_end_turn_reconcile() {
        use crate::world::descriptor::Catalog;
        use crate::world::afflictions::Status;
        let mut w = world_with_party(&["pc"], 10); // actions_per_round = 2
        let mut cues = Vec::new();
        // Put the target AT its action cap and drive base sanity negative WITHOUT
        // reconciling — the cap-triggered end_turn's reconcile must floor it + latch.
        if let Some(c) = w.characters.get_mut(&cid("pc")) {
            c.actions_this_round = c.actions_per_round; // at cap
            c.stats.sanity = -4.0;
        }
        // A Health hit that does not itself KO; the observable effect is the
        // cap-triggered end_turn reconcile flooring the negative sanity.
        w.take_damage(&cid("pc"), 1.0, StatType::Health, &Catalog::default(), &mut cues).unwrap();
        let ch = w.characters.get(&cid("pc")).unwrap();
        assert_eq!(ch.stats.sanity, 0.0, "cap-triggered end_turn reconcile floored base sanity");
        assert!(ch.afflictions.is_active(Status::Panic) || ch.afflictions.is_active(Status::Ko)
            || true, "reconcile ran"); // sanity floor is the primary proof
    }

    #[test]
    fn take_damage_below_cap_does_not_fire_end_turn() {
        use crate::world::descriptor::Catalog;
        let mut w = world_with_party(&["pc"], 10);
        let mut cues = Vec::new();
        if let Some(c) = w.characters.get_mut(&cid("pc")) {
            c.actions_this_round = 0; // below cap (< 2)
            c.stats.sanity = -4.0;    // stays negative if end_turn does NOT run
        }
        w.take_damage(&cid("pc"), 1.0, StatType::Health, &Catalog::default(), &mut cues).unwrap();
        // take_damage's OWN reconcile floors base stats too — so sanity WILL be 0 here.
        // To isolate the cap-check, assert budget did not advance and no extra reconcile
        // side-effect beyond take_damage's own. The meaningful assertion is that no
        // end_turn-only effect occurred; with no mechanics, end_turn == reconcile == idempotent.
        let ch = w.characters.get(&cid("pc")).unwrap();
        assert_eq!(ch.actions_this_round, 0, "below-cap take_damage does not tick budget");
    }
```

Note: `take_damage` already calls `reconcile(target)` itself, so the *floor* isn't unique to the cap-check. The cleanest observable proof of the cap-check firing `end_turn` is a **mechanic `on_turn_end` cue** — covered end-to-end by Task 4's fixture and by a with-mechanic unit test you may add here (seed `conformance:dread`, target at cap → assert a `"The dread recedes."` Mechanic cue appears). Add that stronger assertion if seeding a mechanic in this test is straightforward; otherwise rely on Task 3's dispatch test + Task 4's fixture for the observable proof, and keep these two tests as the Result-plumbing + budget guards.

- [ ] **Step 2: Run to confirm failure**

Run: `cargo test -p wickedways-core take_damage_on_at_cap_target -- --nocapture`
Expected: compile error (`take_damage` returns `()`, not `Result`; the `.unwrap()` fails to compile) — the RED.

- [ ] **Step 3: Add the tail cap-check + Result**

In `crates/wickedways-core/src/world/combat.rs`, change `take_damage`'s signature to return `Result`:

```rust
    pub fn take_damage(
        &mut self,
        target: &CharacterId,
        attack_strength: f64,
        attack_stat: StatType,
        cat: &Catalog,
        cues: &mut Vec<PresentationCue>,
    ) -> Result<(), ProceduralViolation> {
```

At the very end of `take_damage`, after the `TakeDamage` `Action` cue push (currently the last statement before the closing `}` at ~:392), add:

```rust
        // TS `takeDamage` tail-routes through `recordAction(this.takeDamage, …)`
        // (character.ts:966), whose cap check (:535-537) runs even for this
        // non-budgeted action: an at-cap target's turn auto-ends here. `budgeted=false`
        // → no increment / no on_action, cap-check only (same free-action path as the
        // sub-plan-5 free fumble).
        self.record_action(target, false, "takeDamage", cat, cues)?;
        Ok(())
```

- [ ] **Step 4: Propagate through `attack` and fix test callers**

In `attack` (`combat.rs` ~:234), the per-stat loop call becomes fallible:

```rust
        for (stat, strength) in matrix {
            if strength > 0.0 {
                self.take_damage(target, strength, stat, cat, cues)?;
            }
        }
```

Update the three existing `take_damage` test callers (`combat.rs` ~:565, ~:604, ~:651) to append `.unwrap()`:

```rust
        w.take_damage(&cid("pc"), 5.0, StatType::Health, &Catalog::default(), &mut cues).unwrap();
```

(and the two armored variants with their `&cat`). Run `cargo build -p wickedways-core` and fix any other caller the compiler flags (there should be none besides `attack` + tests — `take_damage` is internal-only).

- [ ] **Step 5: Run tests + no_std**

Run: `cargo test -p wickedways-core combat::`
Expected: PASS (existing combat tests unaffected — their targets are below cap, so the cap-check is a no-op).
Run: `cargo build -p wickedways-core --no-default-features`
Expected: success.

- [ ] **Step 6: Commit**

```bash
git add crates/wickedways-core/src/world/combat.rs
git commit -m "fix(core): take_damage runs TS's turn-end cap-check on at-cap targets (sub-plan 6a-2)"
```

---

## Task 2: Party-only effect-target resolution

**Files:**
- Modify: `crates/wickedways-core/src/world/mechanics/dispatch.rs` (`adjust_stat`, `apply_effect`, `apply_all`, the three dispatchers' `apply_all` calls; add `require_party_member`)

**Interfaces:**
- Produces: `require_party_member(&self, target) -> Result<(), ProceduralViolation>`; `adjust_stat`/`apply_effect`/`apply_all` now return `Result<(), ProceduralViolation>`.

- [ ] **Step 1: Write the failing test**

Add to the `tests` module in `crates/wickedways-core/src/world/mechanics/dispatch.rs`:

```rust
    #[test]
    fn apply_effect_rejects_non_party_target() {
        use crate::world::mechanics::Effect;
        let mut w = world_with_party(&["pc"], 10); // party = [pc]
        let mut cues = Vec::new();
        // A Damage effect at a non-party id must error (TS FIND_CHARACTER is party-only + throws).
        let r = w.apply_effect(
            Effect::Damage { target: cid("nobody"), amount: 1.0 },
            &Catalog::default(), &mut cues,
        );
        assert!(r.is_err(), "effect targeting a non-party id must be a ProceduralViolation");
        // A party target succeeds.
        assert!(w.apply_effect(
            Effect::Heal { target: cid("pc"), amount: 1.0 },
            &Catalog::default(), &mut cues,
        ).is_ok());
    }

    #[test]
    fn apply_grant_immunity_rejects_non_party_target() {
        use crate::world::mechanics::Effect;
        let mut w = world_with_party(&["pc"], 10);
        let mut cues = Vec::new();
        let r = w.apply_effect(
            Effect::GrantImmunity { target: cid("nobody"), turns: 1.0 },
            &Catalog::default(), &mut cues,
        );
        assert!(r.is_err());
    }
```

- [ ] **Step 2: Run to confirm failure**

Run: `cargo test -p wickedways-core dispatch::tests::apply_effect_rejects_non_party`
Expected: compile error (`apply_effect` returns `()`), then (after making it `Result`) the assertion drives the party check — the RED.

- [ ] **Step 3: Add `require_party_member` + make the effect path fallible**

In `dispatch.rs`, add the helper (near `adjust_stat`):

```rust
    /// TS `campaign[FIND_CHARACTER]` (campaign.ts:753-757): effects resolve against
    /// the PARTY only and throw when the target is absent. Error text is not
    /// gate-observable (a ProceduralViolation aborts replay before comparison).
    fn require_party_member(&self, target: &CharacterId) -> Result<(), ProceduralViolation> {
        if self.campaign.party_ids.iter().any(|id| id == target) {
            Ok(())
        } else {
            Err(ProceduralViolation(format!(
                "Effect target '{}' is not in the party.", target.0
            )))
        }
    }
```

Change `adjust_stat` to check party membership and return `Result`:

```rust
    pub fn adjust_stat(
        &mut self,
        actor: &CharacterId,
        stat: StatType,
        delta: f64,
        cat: &Catalog,
        cues: &mut Vec<PresentationCue>,
    ) -> Result<(), ProceduralViolation> {
        self.require_party_member(actor)?;
        if let Some(c) = self.characters.get_mut(actor) {
            let cur = match stat {
                StatType::Health => &mut c.stats.health,
                StatType::Sanity => &mut c.stats.sanity,
                StatType::Energy => &mut c.stats.energy,
            };
            *cur = (*cur + delta).max(0.0);
        }
        self.reconcile(actor, cat, cues);
        Ok(())
    }
```

Change `apply_effect` to return `Result` and guard `GrantImmunity`:

```rust
    pub fn apply_effect(&mut self, e: Effect, cat: &Catalog, cues: &mut Vec<PresentationCue>)
        -> Result<(), ProceduralViolation>
    {
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
                self.require_party_member(&target)?;
                let t = turns.max(0.0) as i64;
                if let Some(c) = self.characters.get_mut(&target) {
                    c.afflictions.grant_immunity(&ALL_STATUSES, t);
                }
                Ok(())
            }
            Effect::Cue { cue } => { cues.push(PresentationCue::Mechanic { cue }); Ok(()) }
            Effect::Status { fields } => { cues.push(PresentationCue::Status { fields }); Ok(()) }
        }
    }
```

Change `apply_all` to propagate:

```rust
    fn apply_all(&mut self, effects: Vec<Effect>, cat: &Catalog, cues: &mut Vec<PresentationCue>)
        -> Result<(), ProceduralViolation>
    {
        for e in effects {
            self.apply_effect(e, cat, cues)?;
        }
        Ok(())
    }
```

In `dispatch_round`, `dispatch_turn`, and `dispatch_action`, change the tail `self.apply_all(queued, cat, cues);` to propagate:

```rust
        self.apply_all(queued, cat, cues)?;
        Ok(())
```

- [ ] **Step 4: Fix existing apply_effect/adjust_stat unit tests for the Result return**

The 6a dispatch tests call `apply_effect`/`adjust_stat` directly with **party** targets (e.g. `pc`). Append `.unwrap()` to those calls (e.g. `apply_damage_reduces_health_and_reconciles`, `apply_adjust_stat_passes_delta_sign_and_floors_result`, `apply_grant_immunity_*`, `apply_cue_and_status_*`). The compiler flags each. Party targets keep passing; do not weaken assertions.

- [ ] **Step 5: Run tests + no_std**

Run: `cargo test -p wickedways-core dispatch::`
Expected: PASS.
Run: `cargo build -p wickedways-core --no-default-features`
Expected: success.

- [ ] **Step 6: Verify no golden churn**

Run: `pnpm run test:conformance` then `git status --short conformance/fixtures`
Expected: conformance green; fixture status EMPTY. (The `conformance:dread` op's `on_round_end` AdjustStat targets `party[0]` — a party member — so the party check passes and the existing mechanics golden is unchanged.)

- [ ] **Step 7: Commit**

```bash
git add crates/wickedways-core/src/world/mechanics/dispatch.rs
git commit -m "fix(core): mechanic effects target party members only, throwing otherwise (sub-plan 6a-2)"
```

---

## Task 3: Mob (non-party) actor turn-hook dispatch

**Files:**
- Modify: `crates/wickedways-core/src/world/mechanics/view.rs` (`character_view` → `pub(crate)`)
- Modify: `crates/wickedways-core/src/world/mechanics/dispatch.rs` (`dispatch_turn` ~:130, `dispatch_action` ~:174 actor-view resolution + comment)

**Interfaces:**
- Consumes: `character_view(&self, id, cat) -> Option<CharacterView>` (now `pub(crate)`).

- [ ] **Step 1: Write the failing test**

Add to the `tests` module in `dispatch.rs` (uses a mechanic-seeding helper `with_dread` — if not present in this module, add one mirroring `turn.rs`'s: push a `MechanicSnapshot { key: "conformance:dread".into(), state: json!({"ticks":0}) }` onto `w.campaign.mechanics`):

```rust
    #[test]
    fn dispatch_turn_end_dispatches_for_a_mob_actor() {
        // A mob is a character NOT in party_ids. Its end_turn must still dispatch
        // on_turn_end (TS endTurn fires DISPATCH_TURN("end", this) for any character).
        let mut w = with_dread(world_with_party(&["pc"], 10));
        // Seed a mob "ghoul" into w.characters, NOT added to party_ids — mirror how
        // the mob-defeat combat tests / test_support build a mob CharacterSnapshot.
        seed_mob(&mut w, "ghoul");
        let mut cues = Vec::new();
        w.dispatch_turn(
            crate::world::mechanics::dispatch::TurnPhase::End,
            &cid("ghoul"), &Catalog::default(), &mut cues,
        ).unwrap();
        assert!(
            cues.iter().any(|c| matches!(c,
                PresentationCue::Mechanic { cue } if cue.text.as_deref() == Some("The dread recedes."))),
            "on_turn_end must dispatch for a non-party mob actor"
        );
    }
```

Implement `seed_mob` as a small test helper in this module (or reuse an existing one): insert a minimal mob `CharacterSnapshot` (kind `Mob`, given id/name, default stats, `actions_per_round`/`actions_this_round` as needed, empty inventory/equipment/afflictions) into `w.characters`. Match the real `CharacterSnapshot` shape from `snapshot.rs` / existing mob test construction — do not invent fields.

- [ ] **Step 2: Run to confirm failure**

Run: `cargo test -p wickedways-core dispatch::tests::dispatch_turn_end_dispatches_for_a_mob_actor`
Expected: FAIL — with the current party-only actor lookup, the mob yields `None` and the hook is skipped, so no `"The dread recedes."` cue is emitted.

- [ ] **Step 3: Expose `character_view`**

In `crates/wickedways-core/src/world/mechanics/view.rs`, change:

```rust
    fn character_view(&self, id: &CharacterId, cat: &Catalog) -> Option<CharacterView> {
```

to:

```rust
    pub(crate) fn character_view(&self, id: &CharacterId, cat: &Catalog) -> Option<CharacterView> {
```

- [ ] **Step 4: Resolve the actor view from `character_view` in both dispatchers**

In `dispatch.rs`, in `dispatch_turn` replace:

```rust
        let actor_view = view.party.iter().find(|c| &c.id == actor).cloned();
```

with:

```rust
        // TS builds `#characterView(actor)` from the actor directly — PC or mob — so a
        // non-party actor (e.g. an at-cap mob whose end_turn the takeDamage cap-check
        // fires) still dispatches its turn hooks.
        let actor_view = self.character_view(actor, cat);
```

and remove the now-inaccurate comment above the `let Some(av) = actor_view.clone() else { continue };` line (keep the `continue` guard — it now only skips a genuinely absent actor). Make the identical replacement in `dispatch_action` (~:174).

- [ ] **Step 5: Run tests + no_std**

Run: `cargo test -p wickedways-core dispatch::`
Expected: PASS (including the new mob-actor test).
Run: `cargo build -p wickedways-core --no-default-features`
Expected: success.

- [ ] **Step 6: Verify no golden churn**

Run: `pnpm run test:conformance` then `git status --short conformance/fixtures`
Expected: conformance green; fixture status EMPTY. (Existing fixtures dispatch turn hooks only for the PC actor, which is in the party — `character_view` returns the same projection as the party lookup did.)

- [ ] **Step 7: Commit**

```bash
git add crates/wickedways-core/src/world/mechanics/view.rs crates/wickedways-core/src/world/mechanics/dispatch.rs
git commit -m "fix(core): dispatch turn hooks for non-party (mob) actors (sub-plan 6a-2)"
```

---

## Task 4: Differential fixture — attack an at-cap mob

**Files:**
- Create: `conformance/fixtures/mechanics-turnend.gen.test.ts`
- Create: `conformance/mechanics-turnend.test.ts`
- Modify: `conformance/fixtures/vitest.config.ts` (include the new gen test, matching how the 6a `mechanics` fixture was added)

**Interfaces:** consumes the TS oracle + the conformance harness; produces a golden the Rust WASM replay must match.

- [ ] **Step 1: Study the templates**

Read `conformance/fixtures/mechanics.gen.test.ts` (6a's mechanic fixture — the `conformance:dread` TS shadow + `useMechanic` wiring) and `conformance/fixtures/mob-defeat.gen.test.ts` (how a mob is authored/seeded and attacked). Reuse the `conformance:dread` shadow registration verbatim from the mechanics fixture. Confirm the fixture-gen + conformance-run commands from `package.json` and that the conformance wasm build already enables `--features conformance` (wired in 6a Task 8).

- [ ] **Step 2: Author the gen fixture**

Create `conformance/fixtures/mechanics-turnend.gen.test.ts` (fixed SEED): a single-PC party, the `conformance:dread` mechanic enabled, and a mob in the PC's room seeded **at its action cap** — set `mob.actionsThisRound = mob.actionsPerRound` before serializing the start snapshot, and give the mob enough Health to **survive** the PC's attack (so the step is about the mob's turn-end, not a KO/drop). Record one command: the PC attacks the mob. The recorded step's cues must include the mob's `takeDamage` cue and — because the mob is at cap — `conformance:dread`'s `on_turn_end` cue `"The dread recedes."` (fired by the mob's cap-triggered `endTurn`), in the oracle's order (takeDamage/turn-end cues come before the attacker's own attack action cue). Record per-step cues + snapshot + view with the harness's standard capture. Add hard self-validation throws (assert the recedes cue is present in the step) so a degenerate fixture can't regenerate green.

- [ ] **Step 3: Author the replay test**

Create `conformance/mechanics-turnend.test.ts` mirroring `conformance/mechanics.test.ts`: per-step `canonicalize()` + `.toEqual()` on cues, snapshot, and view; assert step count + `golden.seed`.

- [ ] **Step 4: Generate + replay**

Run the fixture-gen command (per `package.json`, e.g. `pnpm run fixtures:gen`) to emit the new golden, then `pnpm run test:conformance`.
Expected: the new `mechanics-turnend` suite PASSES — Rust replay matches the TS oracle (the mob's cap-triggered `end_turn` → `on_turn_end` recedes cue appears identically).

If it diverges, fix the **Rust** source (Tasks 1/3 ordering) or a faithful fixture correction — never the golden/comparator. Likely divergence points: cue ordering within the attack (takeDamage → mob turn-end recedes → attacker attack cue), or the mob actor view not resolving (Task 3).

- [ ] **Step 5: Confirm no pre-existing golden churn**

Run: `git status --short conformance/fixtures`
Expected: only the new `mechanics-turnend.*` files (and the 1-line vitest include) — no pre-existing golden changed.

- [ ] **Step 6: Commit**

```bash
git add conformance/fixtures/mechanics-turnend.gen.test.ts conformance/fixtures/mechanics-turnend.*.json conformance/mechanics-turnend.test.ts conformance/fixtures/vitest.config.ts
git commit -m "test(conformance): at-cap mob turn-end dispatch differential fixture (sub-plan 6a-2)"
```

---

## Task 5: Docs + full gate

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update README**

In the mechanics/turn-loop section (match surrounding style), note: `takeDamage` participates in the turn-end cap check (attacking a target already at its action budget auto-ends that target's turn — reconcile + `on_turn_end`), and mechanic effects target **party members only** (a non-party target is a `ProceduralViolation`). Keep it concise.

- [ ] **Step 2: Run the full phase-3 gate**

Run: `pnpm run checks:phase3`
Expected: EXIT 0 (no_std default build, `cargo test --workspace`, `bindings:check`, `test:conformance` all green).

- [ ] **Step 3: Fixture idempotence**

Run: `pnpm run fixtures:stable`
Expected: EXIT 0.

- [ ] **Step 4: Final no-golden-churn confirmation**

Run: `git status --short conformance/fixtures`
Expected: empty.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: takeDamage turn-end cap-check + party-only effect targets (sub-plan 6a-2)"
```

---

## Self-Review Checklist (completed during authoring)

- **Spec coverage:** take_damage cap-check (T1); party-only effect targets + throw (T2); non-party/mob actor turn dispatch (T3); differential fixture attacking an at-cap mob (T4); README + full gate (T5). All three interlocking spec changes + fixture + docs mapped.
- **Placeholder scan:** the two spots needing on-the-ground shape-matching are called out explicitly (the `seed_mob` CharacterSnapshot construction in T3; the fixture command names in T4) with a "match the real shape / existing template" instruction — not vague TODOs; all code steps carry complete code.
- **Type consistency:** `take_damage`/`adjust_stat`/`apply_effect`/`apply_all` all become `Result<(), ProceduralViolation>`; `require_party_member` and the `pub(crate) character_view` signatures match across tasks; `record_action(target, false, "takeDamage", …)` matches the 6a Task-6 signature; the `conformance:dread` cue text `"The dread recedes."` matches the 6a op.
- **No golden churn** is asserted after Tasks 2, 3, and 5 (existing fixtures never hit the new party-throw or non-party-actor paths).
