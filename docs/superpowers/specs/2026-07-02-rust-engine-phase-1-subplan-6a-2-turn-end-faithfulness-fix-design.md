# Rust Engine — Phase 1, Sub-plan 6a-2: Turn-End Faithfulness Fix (design)

## Context

We are re-authoring the TypeScript RPG engine (`src/`) as a Rust core
(`crates/wickedways-core`), verified byte-for-byte against the TS "oracle" by a differential
conformance gate. Sub-plan 6a landed the `MechanicOp` foundation (hook dispatch, effect
application, `modify_damage`, all turn/round/action fire-points). Its final whole-branch review
(Fable) returned "Ready to merge: Yes" but surfaced **two Important pre-existing divergences** —
inert before 6a, now **gate-observable** because mechanic hooks fire. They interlock, so this
sub-plan fixes them together with one differential fixture. This is the same *class* of work as
sub-plan 5's free-action cap-check (unconditional cap check on a non-budgeted action), extended
to `takeDamage` and to effect-target resolution.

The custom-mechanic-actions feature originally bundled under "6a-2" is split out to **6a-3**;
this sub-plan is the faithfulness fix only.

## The three interlocking changes

### 1. `take_damage` tail cap-check (Important-1)

TS `Character.takeDamage` (`src/lib/character/character.ts:930-971`) ends by routing through
`recordAction(this.takeDamage, { kind: "takeDamage", amount })`. `recordAction`'s cap check
(`character.ts:535-537`) sits **outside** the budgeted block, so it runs even for the non-budgeted
`takeDamage`: a target already at `actionsThisRound === actionsPerRound` fires `endTurn()` →
`#reconcile()` + `DISPATCH_TURN("end")`.

Rust `World::take_damage` (`crates/wickedways-core/src/world/combat.rs`) currently pushes the
`TakeDamage` history entry and cue inline and returns — no cap check. Pre-6a this was invisible
(a second reconcile is idempotent; `DISPATCH_TURN` was a no-op). 6a makes it observable: attacking
a target already at their action cap should fire that target's `on_turn_end` mechanic hook.

**Fix:** after the `TakeDamage` cue push, call
`self.record_action(target, /*budgeted*/ false, "takeDamage", cat, cues)?`. With `budgeted = false`,
`record_action` skips the increment and the `on_action` dispatch and runs only the cap check →
`end_turn` (this is the exact free-action cap-check path built in sub-plan 5 for the free fumble).
`take_damage` returns `Result<(), ProceduralViolation>`; its sole caller `attack` propagates with
`?`. (`take_damage` is internal-only — never a Command; the module doc states TS only calls it from
`attack`. Confirm no other caller when implementing.)

### 2. Party-only effect-target resolution (Important-2)

TS `applyEffect` (`src/lib/mechanics/apply.ts`) routes `Damage`/`Heal`/`AdjustStat`/`GrantImmunity`
through `campaign[FIND_CHARACTER](target)` (`campaign.ts:753-757`), which searches the **party
only** and **throws** `ProceduralViolation` when the target is absent. Rust `apply_effect` /
`adjust_stat` (`crates/wickedways-core/src/world/mechanics/dispatch.rs`) resolve the target from
`self.characters` (all characters, including mobs) and **silently no-op** on a missing id.

This is unreachable with the current `conformance:dread` op (it targets `party[0]`), so it is not
gate-observable in 6a — but it is the exact seam scripted (Rhai) mechanics will drive in 6b, and TS
documents it as a deliberate guardrail.

**Fix:** resolve the target of the four character-targeting effects against
`campaign.party_ids`; if the target is not a party member, return `ProceduralViolation` (matching
the TS throw). This makes `adjust_stat`, `apply_effect`, and `apply_all` fallible
(`Result<(), ProceduralViolation>`); the three dispatchers (`dispatch_round`/`dispatch_turn`/
`dispatch_action`) propagate with `?` (they already return `Result`). `Cue`/`Status` effects do not
target a character and are unchanged. The ripple is contained within `dispatch.rs`.

### 3. Mob (non-party) actor turn-hook dispatch (Minor-3, interlocks with change 1)

TS `Character.endTurn` fires `DISPATCH_TURN("end", this)` with `#characterView(this)` for **any**
character — PC or mob. Once change 1 makes `take_damage`'s cap check fire an at-cap **mob's**
`endTurn`, TS dispatches that mob's `on_turn_end`. Rust `dispatch_turn` / `dispatch_action`
currently build the actor view from `view.party.iter().find(|c| &c.id == actor)` — a mob is not in
`party_ids`, so it yields `None` and the hook is **skipped** (with a comment inaccurately claiming
"TS turn hooks always have the acting PlayerCharacter").

**Fix:** build the actor view via `self.character_view(actor, cat)` (expose the existing private
helper in `view.rs` as `pub(crate)`), which works for any character. The `HookCtx.view` /
`CampaignView.party` field stays party-only (matching TS `#campaignView`); only the `actor` field
of `TurnCtx`/`ActionCtx` changes source. Correct the stale comment. `dispatch_turn(Start)` for a
mob is unreachable in Phase 1 (mobs don't start turns), and `dispatch_action`'s actor is always the
active PC, so the observable case is `dispatch_turn(End)` via change 1 — but resolve the actor
uniformly for correctness and future mob turns.

## Testing

- **Differential fixture** (new `conformance/fixtures/*` + replay test, mirroring the 6a mechanics
  fixture): a single-PC party plus a mob seeded **at its action cap**
  (`actions_this_round == actions_per_round`, e.g. both `= 2`), with the `conformance:dread`
  mechanic enabled. The PC attacks the mob; the mob's `take_damage` cap check fires the mob's
  `end_turn` → `dread.on_turn_end` emits `"The dread recedes."` + reconcile. This exercises
  changes 1 and 3 together. Keep the attack from KO-ing the mob (or handle the drop) so the step is
  clean; the recorded step's cues must show the mob's turn-end mechanic cue.
- **Rust unit tests:** (a) `take_damage` on an at-cap target fires `end_turn` (observable via a
  pre-set negative base that reconcile floors, or via `actions`-state); on a below-cap target it
  does not. (b) `apply_effect` with a `Damage`/`AdjustStat`/`GrantImmunity` effect targeting a
  non-party id returns `ProceduralViolation` (change 2's error path); targeting a party member
  succeeds. (c) `dispatch_turn(End)` with a mob actor dispatches the op's `on_turn_end` (a mob in a
  world with a dread mechanic, `end_turn(mob)` → the recedes cue).
- **No golden churn on pre-existing fixtures:** the existing mechanics/combat/mob-defeat goldens
  must stay byte-identical (none of them attack an at-cap target or target a non-party effect).
  Confirm `git status --short conformance/fixtures` shows only the new fixture files after
  regeneration. Full gate `pnpm run checks:phase3` EXIT 0 and `pnpm run fixtures:stable` EXIT 0.

## Deferred

- Custom mechanic actions (`useMechanicAction` / `INVOKE_MECHANIC_ACTION` / a `MechanicAction`
  command) → **sub-plan 6a-3**.
- `ScriptedMechanic` + Rhai → **6b**. The 6b spec must additionally record, from 6a's review:
  the `AdjustStat` Health→Energy coercion (TS `apply.ts:25` coerces a Health target to Energy;
  Rust must align once scripts can emit arbitrary stat strings), the `CharacterView.status`
  ordering (Rust fixed `[Confused, Fear, Ko, Panic]` vs TS Map-insertion order), and this
  sub-plan's party-only `FIND_CHARACTER` semantics as the baseline scripts inherit.
- Keyed exits / scenes / NPC dialogue / spawning → **6c+**.
- Operational: split `wasm:build`'s always-on `conformance` feature before the Phase-2 cutover so
  the conformance op cannot ship.

## Documentation

Per the standing convention, update `README.md` (and relevant Rust doc comments) to note that
`takeDamage` participates in the turn-end cap check and that mechanic effects target party members
only (throwing otherwise), before the work is considered done.
