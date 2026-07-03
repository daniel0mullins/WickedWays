# Rust Engine — Phase 1, Sub-plan 6a-3: Custom Mechanic Actions (design)

## Context

We are re-authoring the TypeScript RPG engine (`src/`) as a Rust core
(`crates/wickedways-core`), verified byte-for-byte against the TS "oracle" by a differential
conformance gate. Sub-plan 6a built the `MechanicOp` foundation (hooks + `modify_damage` + effect
application); 6a-2 fixed turn-end faithfulness (takeDamage cap-check, party-only effect targets,
non-party actor turn dispatch). 6a-3 adds the **last piece of the `MechanicOp` contract — custom
actions** (TS `actions?: Record<ActionKey, CustomAction>`, invoked via `useMechanicAction`), and
folds in the hygiene bundle the 6a-2 final review scheduled for the same files.

## The TS contract being ported (authoritative source)

- `Mechanic.actions?: Record<ActionKey, CustomAction<State>>`; `CustomAction = { cost?: number;
  run(h: ActionCtx): Effect[] | void }` (`src/lib/mechanics/mechanic.ts:140-144`). **`cost` is
  accepted but v1-inert — every custom action costs exactly 1** via the standard budget path.
- `Character.useMechanicAction(mechanicKey, actionKey)` (`character.ts:1095-1099`):
  1. `if (!this.attemptAction(this.useMechanicAction, false)) return;` — gate (Confused fizzle →
     records a fumble and returns; Panic/Fear may hard-block/throw).
  2. `this.campaign[INVOKE_MECHANIC_ACTION](mechanicKey, actionKey, this);`
  3. `this.recordAction(this.useMechanicAction, { kind: "mechanicAction", mechanic: mechanicKey,
     action: actionKey });`
  `useMechanicAction` **is budgeted** — `isActionMap.set(this.useMechanicAction, true)`
  (`character.ts:503`) — so `recordAction` ticks the budget, dispatches `onAction`, and runs the
  cap-check → `endTurn` when the budget is exhausted.
- `Campaign[INVOKE_MECHANIC_ACTION](mechanicKey, actionKey, actor)` (`campaign.ts:732-747`): find
  the live mechanic by key (throw `ProceduralViolation` "not enabled" if absent); find
  `actions[actionKey]` (throw "no action" if absent); build `ActionCtx = { ...hookCtx, actor:
  characterView(actor), action: { kind: "mechanicAction", mechanic, action } }`; run
  `action.run(ctx)`; enforce the 64-effect cap (`MAX_EFFECTS_PER_EVENT`); apply the effects. (TS
  applies them in its own loop; for a single action's single list this is identical in order to
  collect-then-apply.)

So two hooks fire for one `useMechanicAction`: the action's own `run` (via INVOKE), then the
generic `onAction` (via `recordAction`, because the action is budgeted). Both are faithful.

## What already exists (do not rebuild)

- `ActionHistoryEntry::MechanicAction { round, mechanic, action }` (`history.rs:33`) and
  `ActionKind::MechanicAction` (`presentation.rs:74`).
- `ActionCtx { base: HookCtx, actor: CharacterView, action: ActionView }` and `ActionView { kind }`
  (`mechanics/mod.rs`, from 6a).
- `record_action(actor, budgeted, action_kind, cat, cues) -> Result` (6a Task 6): with
  `budgeted=true` it increments the budget, dispatches `on_action`, and cap-checks → `end_turn`.
- `apply_all` / `apply_effect` (party-only, fallible — 6a-2); `require_party_member`; the
  `self.gate(actor, is_move)` → `GateVerdict` path + `record_fumble(actor, action, budgeted, cat,
  cues)` (used by attack/take/etc.); `mechanic_op(key)`; the `conformance:dread` op
  (`#[cfg(any(test, feature = "conformance"))]`).

There is **no** `MechanicAction` command in `command.rs` yet, and `MechanicOp` has no custom-action
method.

## Design

### 1. `MechanicOp::run_action`

Add a defaulted trait method (`mechanics/mod.rs`):

```rust
/// Run a named custom action (TS `CustomAction.run`). `None` means this op has no
/// action under `action_key` (→ a `ProceduralViolation` at the invoke site,
/// mirroring TS's "has no action" throw). `cost` is v1-inert (every action costs 1).
fn run_action(&self, _action_key: &str, _cx: &mut ActionCtx) -> Option<Vec<Effect>> { None }
```

`conformance:dread` gains one action, `"brace"`, returning a small, observable effect list — e.g.
`[Cue "You brace against the dread.", AdjustStat { party[0], Sanity, +1 }]` — and `None` for any
other key (so the "no action" error path is testable). The exact effects are the byte-exact
contract mirrored by the TS shadow's `actions.brace`.

### 2. `World::use_mechanic_action`

New method mirroring TS `useMechanicAction` + `INVOKE_MECHANIC_ACTION`:

```rust
pub fn use_mechanic_action(
    &mut self,
    actor: &CharacterId,
    mechanic_key: &str,
    action_key: &str,
    cat: &Catalog,
    cues: &mut Vec<PresentationCue>,
) -> Result<(), ProceduralViolation>
```

Sequence:
1. **Gate** (`self.gate(actor, /*is_move*/ false)`): `Block(r)` → `Err(ProceduralViolation(r))`;
   `Fizzle` → `self.record_fumble(actor, "useMechanicAction", /*budgeted*/ true, cat, cues)?` then
   `return Ok(())`; `Allow` → continue. (Matches attack/take gating; `useMechanicAction` is
   budgeted so the fumble is budgeted.)
2. **Invoke**: locate the live mechanic in `campaign.mechanics` by `key == mechanic_key` (else
   `ProceduralViolation` "Mechanic '<key>' is not enabled."); resolve `mechanic_op(key)`; build the
   owned `CampaignView` + actor `CharacterView` (`character_view`); then split-borrow the target
   mechanic's `state` + `self.rng`, build `ActionCtx { base: HookCtx { state, view, rng }, actor,
   action: ActionView { kind: "mechanicAction".into() } }`, call
   `op.run_action(action_key, &mut cx)`; `None` → `ProceduralViolation` "Mechanic '<key>' has no
   action '<action_key>'."; if `effects.len() > MAX_EFFECTS_PER_EVENT` → `ProceduralViolation`;
   drop the borrows; `self.apply_all(effects, cat, cues)?`.
3. **Record**: push `ActionHistoryEntry::MechanicAction { round, mechanic, action }`; emit
   `PresentationCue::Action { action: ActionKind::MechanicAction, actor: entity_ref, sound: None }`;
   then `self.record_action(actor, /*budgeted*/ true, "mechanicAction", cat, cues)?` (tick +
   `on_action` dispatch + cap-check → `end_turn`).

Order note: the action's effect cues (from step 2) precede the `mechanicAction` action cue (step 3),
which precedes the `on_action` cues (inside `record_action`) — matching TS
(`INVOKE_MECHANIC_ACTION` applies effects, then `recordAction` emits the action cue + dispatches
`onAction`). Error text is not gate-observable (a `ProceduralViolation` aborts replay).

### 3. Command wiring

Add to `command.rs`:

```rust
#[serde(rename_all = "camelCase")]
MechanicAction { mechanic_key: String, action_key: String },
```

and dispatch it in `apply_command`:

```rust
Command::MechanicAction { mechanic_key, action_key } =>
    world.use_mechanic_action(&actor, &mechanic_key, &action_key, cat, cues),
```

### 4. Hygiene bundle (6a-2 final review — same files)

- **`dispatch_action` comment:** the actor-view comment copy-pasted from `dispatch_turn` says
  "still dispatches its turn hooks"; in `dispatch_action` it dispatches `on_action`. Fix the wording.
- **Shared dread shadow:** the `conformance:dread` TS shadow closure is duplicated verbatim in
  `mechanics.gen.test.ts` and `mechanics-turnend.gen.test.ts`; 6a-3 adds a third fixture. Extract it
  to `conformance/fixtures/dread-shadow.ts` (exporting the `Mechanic` closure, now including the
  `brace` action) and import it from all three gen fixtures.
- **Hoist the actor-view guard:** in `dispatch_turn`/`dispatch_action`, the `let Some(av) =
  actor_view … else { continue }` is inside the per-mechanic loop though `actor_view` is loop-
  invariant; hoist the None-check above the loop (early-return `Ok(())` when the actor can't be
  projected) so it is computed/checked once.
- **Unused-import warnings:** remove the unused `use super::*;` at `mechanics/view.rs:126` and drop
  `SceneSnapshot` from the `combat.rs:739` import (only `RoomSnapshot` is used) for a pristine build.

## Testing

- **Rust unit tests:** `run_action("brace")` returns the expected effects; `run_action("nope")`
  → `None`. `use_mechanic_action`: (a) not-enabled mechanic key → `Err`; (b) enabled mechanic,
  missing action key → `Err`; (c) happy path → effects applied + `MechanicAction` history entry +
  `Action` cue + budget ticked by 1 + `on_action` fired (assert `conformance:dread`'s
  "The dread notices." cue appears after the action's own cues); (d) gate fizzle (Confused actor)
  → records a fumble, does not invoke the action.
- **Differential fixture** (`mechanics-action.gen.test.ts` + replay test, using the shared
  `dread-shadow.ts`): a single-PC party with `conformance:dread` enabled issues a
  `MechanicAction { "conformance:dread", "brace" }` command. The step's cues (brace effect cues →
  `mechanicAction` action cue → "The dread notices.") + snapshot (sanity +1, budget ticked, mechanic
  state) + view match the TS oracle. Hard self-validation in the generator.
- **No golden churn** on pre-existing fixtures (they issue no `MechanicAction` command); after the
  task, `git status --short conformance/fixtures` shows only the new fixture files. Full gate
  `pnpm run checks:phase3` EXIT 0 and `pnpm run fixtures:stable` EXIT 0. The shared-shadow
  extraction must regenerate the existing mechanics/mechanics-turnend goldens **identically** (the
  shadow behavior is unchanged) — verify those goldens stay byte-identical.

## Deferred

- `ScriptedMechanic` + Rhai → **6b**. Its spec must record (from 6a's review) the `AdjustStat`
  Health→Energy coercion (`apply.ts:25`), the `CharacterView.status` ordering, and the party-only
  `FIND_CHARACTER` baseline — all now load-bearing seams scripts will hit. Also split
  `wasm:build`'s always-on `conformance` feature before the Phase-2 cutover.
- Keyed exits / scenes / NPC dialogue / spawning → **6c+**.
- Custom-action `cost` > 1 → future (v1 is always 1).

## Documentation

Per the standing convention, update `README.md` (and relevant Rust doc comments) to document custom
mechanic actions (the `run_action` op method, the `MechanicAction` command, the budgeted
invoke→record flow) before the work is considered done.
