# Rust Engine — Phase 1, Sub-plan 5: Turn/Round End (design)

## Context

We are re-authoring the TypeScript RPG engine (`src/`) as a Rust core
(`crates/wickedways-core`), verified byte-for-byte against the TS "oracle" by a
differential conformance gate. Prior sub-plans ported the world foundation, the
turn-loop/movement, the descriptor catalog + items projection, item actions,
afflictions/gating, combat damage, deterministic entity ids, and mob defeat drops.

The turn/round loop is *almost* complete on the Rust side, with one deliberate hole
left by the earlier turn-loop sub-plan:

- `World::end_turn` (`crates/wickedways-core/src/world/turn.rs:92`) is an **empty
  stub**. The `EndTurn` command variant is wired in `command.rs` but does nothing.
- The Rust core **never auto-ends a turn** when the per-round action budget is
  exhausted. TS `Character.recordAction` (`src/lib/character/character.ts:535`) calls
  `this.endTurn()` the instant `actionsThisRound === actionsPerRound`. That is the
  *primary* trigger of turn-end reconcile in the oracle.

TS `Character.endTurn()` (`character.ts:1066-1070`) does three things:
1. `events.onTurnEnd()` — character-event hub (not yet ported).
2. `#reconcile()` — RNG-free: floors base stats, re-applies affliction flags from
   effective stats, and latches KO (fires `onKnockOut` on the rising edge).
3. `campaign[DISPATCH_TURN]("end", this)` — mechanic `onTurnEnd` hooks.

Of these, **only `#reconcile()` belongs to sub-plan 5.** The character-event system
and the mechanic dispatch are already marked in-code as sub-plan 6 work.

### The observability wrinkle (why this is unit-tested, not gate-tested)

Under phase-1's command surface, turn-end reconcile of the **acting character** is a
pure no-op:

- Nothing changes the actor's *own* effective stats mid-turn. `attack` reconciles the
  **target**, not the actor; mobs do not take turns; stat-affecting consumables run
  through `onUse` character events, which are deferred to sub-plan 6.
- Base stats are already floored at `start_turn`; re-flooring positive values is inert.
- A PC's `on_knock_out` is a no-op, and the other two `endTurn` steps are deferred
  no-ops.

So `reconcile(actor)` at turn end emits no cue and produces no snapshot delta today.
The differential gate cannot see a difference. This mirrors the `sees_in_dark`
situation in sub-plan 4c-2 (faithful plumbing, not yet gate-observable), which we
chose to land now with unit-test coverage. **Decision: implement it now, unit-tested;
defer differential coverage to sub-plan 6**, where stat-changing-during-turn paths
(mechanics, `onUse` effects) first make turn-end reconcile observable.

## Design

### 1. Wire `end_turn` to `reconcile`

Change `World::end_turn` from `fn end_turn(&mut self, _actor: &CharacterId)` to
`fn end_turn(&mut self, actor: &CharacterId, cat: &Catalog, cues: &mut Vec<PresentationCue>)`
and have it call `self.reconcile(actor, cat, cues)`. `reconcile` already exists
(`combat.rs:44`) and does exactly the TS `#reconcile()` work (floor stats, re-apply
afflictions, latch KO on the rising edge).

Leave the existing deferred-work comments in place for the other two `endTurn` steps:
`events.onTurnEnd` → sub-plan 6; `DISPATCH_TURN("end")` → sub-plan 6.

Update the `EndTurn` dispatch in `command.rs` from
`world.end_turn(&actor)` to `world.end_turn(&actor, cat, cues)`.

### 2. Shared budget seam + auto-end-turn

Introduce a single seam mirroring TS `recordAction`'s budget half:

```rust
// on World (pub(crate)); the single seam for a budgeted action's budget tick.
pub(crate) fn record_action(
    &mut self,
    actor: &CharacterId,
    cat: &Catalog,
    cues: &mut Vec<PresentationCue>,
) {
    if let Some(c) = self.characters.get_mut(actor) {
        c.actions_this_round += 1;
    }
    let at_cap = self
        .characters
        .get(actor)
        .map(|c| c.actions_this_round == c.actions_per_round)
        .unwrap_or(false);
    if at_cap {
        self.end_turn(actor, cat, cues);
    }
}
```

- Remove the 5 inline `actions_this_round += 1` statements:
  `combat.rs:258` (attack), `gate.rs:89` (conditional fumble), `items_actions.rs:261`
  (take), `items_actions.rs:525` (drop/consume), `movement.rs:240` (go).
- Call `record_action` at the **tail of each budgeted action, after that action's
  `Action` cue has been pushed.** For `gate.rs`, call it inside the existing
  `if budgeted { … }` branch (fumbles can be free); the other four sites are always
  budgeted, so call unconditionally.
- Use `==` for the cap check, exactly matching TS `===` (an overshoot won't
  re-trigger).

**Why after the cue:** TS emits the `action` cue in `recordAction` *before* calling
`endTurn()`, so any reconcile-driven cues follow the action cue in a step's cue array.
Placing `record_action` after the cue push preserves that order for when reconcile
becomes observable (sub-plan 6). It is inert today but faithful.

**No re-entrancy risk:** `reconcile` never ticks the budget, so `record_action →
end_turn → reconcile` cannot loop. In phase 1 only PCs act, and PC `on_knock_out`
is a no-op.

### 3. No golden changes

Because `end_turn → reconcile` emits nothing under phase-1's surface (no self-stat
mutation; PC `on_knock_out` no-op; the other two `endTurn` steps deferred), every
existing fixture stays byte-identical — including fixtures where a PC reaches their
action cap (the triggered reconcile is a no-op). The conformance gate
(`pnpm run checks:phase3`) is the regression guard. **No new differential fixture is
authored in this sub-plan.**

## Testing

Rust unit tests in `turn.rs` (and/or `combat.rs` where `reconcile` tests live):

1. **`end_turn` runs reconcile** — construct an actor with a negative base stat
   (bypassing the `start_turn` floor), call `end_turn`, assert the base is floored to
   0 and KO is latched (matches the existing `reconcile_floors_negative_base_and_latches_ko`
   expectation, reached via `end_turn`).
2. **Budget exhaustion auto-fires `end_turn`** — actor with `actions_per_round = 2`,
   `actions_this_round = 1`, and a pre-set negative base; one `record_action` tick
   reaches the cap → assert the base got floored (proves `end_turn → reconcile` fired)
   and `actions_this_round == 2`.
3. **Non-exhausting tick does not fire `end_turn`** — actor with `actions_per_round = 3`,
   one `record_action` tick → assert the pre-set negative base is *unchanged* (reconcile
   did not run) and `actions_this_round == 1`.
4. **Real command path** — a budgeted action (e.g. `go`) with `actions_per_round = 1`
   drives `record_action` and triggers the turn-end reconcile.

Plus the full gate: `pnpm run checks:phase3` must stay EXIT 0 with **no golden diffs**,
and `pnpm run fixtures:stable` EXIT 0.

## Deferred (unchanged in-code markers)

- `events.onTurnEnd()` (character-event hub) → **sub-plan 6**.
- All mechanic `DISPATCH_TURN` / `dispatchRound` hooks (`onTurnStart/End`,
  `onRoundStart/End`, `onAction`) → **sub-plan 6**.
- Full win/lose `resolveOutcome` at round end → **sub-plan 7** (the `max_rounds`
  timeout → `TimedOut` is already implemented in `end_round`).
- Differential (gate) coverage of turn-end reconcile → **sub-plan 6**, once a
  stat-changing-during-turn path exists to make it observable.

## Documentation

Per the standing convention, update `README.md` (and relevant TSDoc) to note the
turn-end reconcile and budget-exhaustion auto-end-turn parity before the work is
considered done.
