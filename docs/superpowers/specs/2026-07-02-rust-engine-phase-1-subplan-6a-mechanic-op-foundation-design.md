# Rust Engine — Phase 1, Sub-plan 6a: MechanicOp Foundation (design)

## Context

We are re-authoring the TypeScript RPG engine (`src/`) as a Rust core
(`crates/wickedways-core`), verified byte-for-byte against the TS "oracle" by a differential
conformance gate. Sub-plans through 5 ported the world/turn loop, items, afflictions, combat,
deterministic ids, mob defeat drops, and turn/round end. **Sub-plan 5 deliberately left every
mechanic dispatch point in `turn.rs` and `combat.rs` as a no-op** (onRoundStart/End,
onTurnStart/End, onAction, TRANSFORM_DAMAGE).

Sub-plan 6 fills the engine's **extension points** — mechanics, keyed exits, scenes, NPC
dialogue, encounter formations — all of which share one architecture in the TS oracle: behavior
lives in **author-registered closures rebound from a `CampaignRegistry` by key**; only
`{key, state}` is serialized. The differential gate replays from a pure snapshot + catalog +
seed, so it cannot reconstruct closures. Sub-plan 6 is therefore multi-spec. This spec is the
**first slice, 6a: the `MechanicOp` trait + registry and the reducer-driven hook/effect
machinery** (the roadmap's "A2 — data + first-party op registry").

Decisions taken during brainstorming:
- **Gate strategy (whole of sub-plan 6): the scripted-interpreter path.** The endgame is one Rust
  interpreter (`ScriptedMechanic`/Rhai) with the TS oracle eventually deleted. During the
  transition the gate still diffs Rust ↔ the TS oracle, and there is no Rhai in TS, so scripted
  conformance mechanics will use a **TS closure "shadow"** under the same key. That is a **6b**
  concern — 6a is native-only and needs no interpreter.
- **6a excludes custom mechanic actions** (`useMechanicAction`/`INVOKE_MECHANIC_ACTION`/a new
  `MechanicAction` command) → deferred to **6a-2**.
- **6a excludes `ScriptedMechanic`/Rhai** → **6b**.
- Keyed exits, scenes, NPC dialogue, spawning → **6c+**. Mob-AI turns are dropped entirely (the
  oracle has no turn driver or AI policy to port).

## What already exists (do not rebuild)

- `presentation.rs`: `PresentationCue::Mechanic { cue: MechanicCue }`, `PresentationCue::Status
  { fields: Vec<StatusField> }`, `MechanicCue { text?, sound? }`, `StatusField`,
  `ActionKind::MechanicAction` — the cue infrastructure is built ahead.
- `snapshot.rs`: `MechanicSnapshot { key, state }` and `campaign.mechanics:
  Vec<MechanicSnapshot>` round-trip already.
- `afflictions.rs`: `grant_immunity(&mut self, statuses: &[Status], turns: i64)`.
- `combat.rs`: `reconcile` (floors stats, re-applies afflictions, latches KO), and the
  `transform_damage` identity stub at the TRANSFORM_DAMAGE point (to be replaced).
- `turn.rs`: `begin_campaign`, `start_turn`, `end_turn` (calls reconcile, sub-plan 5),
  `record_action` (budget tick + unconditional cap check → `end_turn`, sub-plan 5),
  `next_player`/`end_round`.

## The TS contract being ported (authoritative source)

`src/lib/mechanics/{mechanic,dispatch,apply}.ts` + `campaign.ts`:

- **Hooks** (`mechanic.ts:165-178`): `initialState(config)` (required), `onRoundStart`,
  `onRoundEnd`, `onTurnStart`, `onTurnEnd`, `onAction`, `modifyDamage`. Each hook returns
  `Effect[] | void`; `modifyDamage` returns `number | { value; final: true }`.
- **Contexts**: `HookCtx { state (live mutable), view: CampaignView, rng, roll(n) }`; `TurnCtx`
  adds `actor: CharacterView`; `ActionCtx` adds `action: ActionDetail`.
- **Views** (`mechanic.ts:20-44,80-85`): `CampaignView { round, maxRounds, party:
  CharacterView[], rooms: RoomView[] }` — **`rooms` is always `[]` in v1** (`campaign.ts:684`).
  `CharacterView { id, name, health, sanity, energy, status[], roomId?, hasEquipped(itemKey),
  hasItem(itemKey) }` — the two predicates match on `item.behaviorKey` (`campaign.ts:663-674`).
  `DamageView { amount, target, stat, source }` — `source` is **always `undefined`**
  (`character.ts:952`).
- **Effect union** (`mechanic.ts:110-127`): `Damage{target,amount}`, `Heal{target,amount}`,
  `AdjustStat{target, stat: sanity|energy, delta}`, `GrantImmunity{target, turns}`,
  `Cue{cue: MechanicCue}`, `Status{fields: StatusField[]}`.
- **Dispatch** (`dispatch.ts:8-24`, `runReducers`): iterate mechanics in opt-in (array) order,
  collect each mechanic's effects (throw `ProceduralViolation` if one mechanic returns
  `> MAX_EFFECTS_PER_EVENT = 64`), then apply all queued effects in order (collect-then-apply).
  Applying effects must not re-enter dispatch.
- **Apply** (`apply.ts:16-40`): `Damage` → `[ADJUST_STAT](Health, -max(0,amount))`;
  `Heal` → `[ADJUST_STAT](Health, +max(0,amount))`; `AdjustStat` → `[ADJUST_STAT](stat, delta)`
  (**delta sign passed through unclamped**; `[ADJUST_STAT]` floors the resulting stat at 0);
  `GrantImmunity` → `[GRANT_IMMUNITY](ALL_STATUSES, max(0, trunc(turns)))`; `Cue` → emit
  `{kind:"mechanic", cue}`; `Status` → emit `{kind:"status", fields}`. `[ADJUST_STAT]`
  (`character.ts:359-362`) is `stats[stat] = max(0, stats[stat]+delta); #reconcile()` — so
  Damage/Heal/AdjustStat each reconcile; GrantImmunity/Cue/Status do **not**.
- **modifyDamage chain** (`campaign.ts:722-730`, `dispatch.ts:29-48`): fold post-mitigation
  damage through each mechanic's `modifyDamage` in opt-in order; `next = max(0, result)` after
  each step; on a `final` result, emit `{kind:"mechanic", cue:{text: "${key} fixed damage at
  ${value}."}}` (value = the clamped `next`) and short-circuit. In `takeDamage` the order is
  **built-in mitigation → mechanic transform chain → subtract** (`character.ts:931-955`);
  mechanic-emitted Damage effects (via `applyEffect`) bypass this chain.
- **Fire-points**: `onRoundStart` at `beginCampaign` end (`campaign.ts:445`) and at the end of a
  non-terminal `endRound` (`campaign.ts:500`); `onRoundEnd` in `endRound` **before** `#round++`
  (`campaign.ts:486-488`); `onTurnStart` in `startTurn` after the affliction tick
  (`character.ts:1083`); `onTurnEnd` in `endTurn` after `#reconcile()` (`character.ts:1069`);
  `onAction` in `recordAction` for **budgeted** actions, after the budget increment and before
  the cap-check `endTurn` (`character.ts:530-537`).
- **Serialize/hydrate**: `[SERIALIZE]` emits `mechanics: {key, state}[]` (deep-cloned; throws on
  non-serializable state, `campaign.ts:922-928`). `[HYDRATE_CATALOG]` rebinds
  `{key, mechanic: registry.mechanic(key), state}` (`campaign.ts:959-963`) — `registry.mechanic`
  throws on an unknown key; `initialState` is NOT called on hydrate.

## Design

### 1. The op registry

A Rust trait, object-safe, with defaulted hooks:

```rust
pub trait MechanicOp {
    fn init_state(&self, config: &serde_json::Value) -> serde_json::Value; // authoring only
    fn on_round_start(&self, cx: &mut HookCtx) -> Vec<Effect> { Vec::new() }
    fn on_round_end(&self,   cx: &mut HookCtx) -> Vec<Effect> { Vec::new() }
    fn on_turn_start(&self,  cx: &mut TurnCtx) -> Vec<Effect> { Vec::new() }
    fn on_turn_end(&self,    cx: &mut TurnCtx) -> Vec<Effect> { Vec::new() }
    fn on_action(&self,      cx: &mut ActionCtx) -> Vec<Effect> { Vec::new() }
    fn modify_damage(&self, d: &DamageView, cx: &mut HookCtx) -> TransformResult {
        TransformResult::Value(d.amount)
    }
}
```

First-party (and conformance) ops are **compiled into the core** and resolved by a static
lookup `fn mechanic_op(key: &str) -> Option<&'static dyn MechanicOp>`. Ops are stateless
behavior, so — unlike `rng` — the registry needs no injection into `World` and no serde. The
snapshot's `campaign.mechanics: Vec<{key, state}>` selects/configures ops as data. On hydrate,
each `{key, state}` is paired with `mechanic_op(key)`; an unknown key is a `ProceduralViolation`
(mirroring the TS registry throw). `init_state(config)` runs only at authoring, never on hydrate.

The single conformance op is registered under a shared key on both sides: a TS closure
`Mechanic` in the generator's `CampaignRegistry`, and a Rust `impl MechanicOp`. (Feature-gating
of conformance-only ops so they do not ship — e.g. `#[cfg(any(test, feature = "conformance"))]`
vs. treating the op as a genuine first-party mechanic — is a plan detail.)

### 2. Contexts, views, Effect enum

- `HookCtx { state: &mut Value, view: &CampaignView, rng: &mut Rng }` with a `roll(n)` method
  (`roll(n, rng)`); `TurnCtx` adds `actor: CharacterView`; `ActionCtx` adds `action` (a
  projection of the action detail).
- `CampaignView { round: i64, max_rounds: i64, party: Vec<CharacterView>, rooms: Vec<RoomView> }`
  built as an **owned projection** before the dispatch loop. `rooms` is always empty (matches TS
  v1). `CharacterView { id, name, health: f64, sanity: f64, energy: f64, status: Vec<Status>,
  room_id: Option<..>, equipped_keys: BTreeSet<String>, held_keys: BTreeSet<String> }` — the
  behavior-key sets are precomputed at projection time (resolving items via the catalog once),
  and `has_equipped(key)`/`has_item(key)` are set lookups needing no catalog at call time.
  `DamageView { amount: f64, target: CharacterId, stat: StatType, source: Option<CharacterId> }`
  (`source` always `None`).
- `Effect` (closed enum): `Damage { target, amount: f64 }`, `Heal { target, amount: f64 }`,
  `AdjustStat { target, stat: StatType /* Sanity|Energy */, delta: f64 }`,
  `GrantImmunity { target, turns: i64 }`, `Cue { cue: MechanicCue }`,
  `Status { fields: Vec<StatusField> }`.
- `TransformResult { Value(f64), Final(f64) }`; `MAX_EFFECTS_PER_EVENT = 64`.

**Borrow model:** build the owned `CampaignView` from `&self` first; then split disjoint mutable
borrows of `self.campaign.mechanics` and `self.rng`; iterate mechanics calling
`op.hook(&mut ctx)` (mutating only that mechanic's `state` + `rng`, collecting effects); drop the
borrows; then apply the collected effects to `self` (mutating characters, reconciling). This
mirrors TS collect-then-apply and satisfies the borrow checker.

### 3. Dispatch + apply

- `run_reducers(&mut self, hook_fn, cat, cues)`: the loop above; per-mechanic 64-effect cap →
  `ProceduralViolation`; collect-then-apply in order.
- `apply_effect(&mut self, effect, cat, cues)`: the six routings above. Add a new
  `World::adjust_stat(actor, stat, delta, cat, cues)` helper = `stats[stat] = max(0.0,
  stats[stat] + delta); reconcile(actor, cat, cues)` (TS `[ADJUST_STAT]`). `GrantImmunity` →
  `afflictions.grant_immunity(ALL_STATUSES, max(0, turns.trunc() as i64))` with no reconcile,
  where `ALL_STATUSES` is the full `Status` variant list. `Cue`/`Status` push the existing
  `PresentationCue::Mechanic`/`PresentationCue::Status` variants.
- `run_damage_transformers(&mut self, damage_view, cues) -> f64`: fold through each live
  mechanic's `modify_damage`, `next = (result).max(0.0)` after each; on `Final`, push a
  `Mechanic` cue `format!("{} fixed damage at {}.", key, value)` and return immediately.
  **Byte-exactness note:** the cue embeds the number via display formatting; keep conformance
  values simple integers so Rust `{}` and TS `${}` render identically (e.g. `5`, not `5.5e0`).

### 4. Fire-point wiring (replacing sub-plan-5 no-ops)

- `turn.rs::begin_campaign`: dispatch `on_round_start`.
- `turn.rs::start_turn`: dispatch `on_turn_start` after the affliction tick.
- `turn.rs::end_turn`: dispatch `on_turn_end` after `reconcile` (sub-plan 5's fixed ordering —
  reconcile before the mechanic hook — now becomes observable).
- `turn.rs::end_round`: dispatch `on_round_end` **before** `round += 1`; after round++/reset, if
  the campaign is still ongoing (timeout check only, per sub-plan 5), dispatch `on_round_start`.
- `turn.rs::record_action`: for budgeted actions, dispatch `on_action` after the budget increment
  and before the cap-check → `end_turn`. This requires threading the **action detail** into
  `record_action` so it can build `ActionCtx.action`; the five call sites already construct their
  history detail and will pass it through.
- `combat.rs::take_damage`: replace the identity `transform_damage` with `run_damage_transformers`,
  slotted after built-in mitigation and before the stat subtract.

### 5. Character-event turn hub

TS `Character.endTurn`/`startTurn` also fire `events.onTurnEnd()`/`onTurnStart()` (the
`events.ts` hub). Item events (onEquip/onUse/…) are already handled in the item-actions port;
the **turn** events have **no registered handlers anywhere in `src/lib`**, so they are invisible
to the gate. 6a leaves them as documented no-ops (unchanged from sub-plan 5).

## Testing

- **Rust unit tests**: `run_reducers` order + 64-cap; each `apply_effect` routing (Damage/Heal
  reconcile via Health; AdjustStat unclamped-delta-then-floor + reconcile; GrantImmunity all-status
  no-reconcile; Cue/Status emission); `run_damage_transformers` fold with clamp-after-each and
  `Final` short-circuit + diagnostic cue; unknown-key hydrate → `ProceduralViolation`; each
  fire-point invokes dispatch (a stub op records that it was called with the right ctx).
- **Differential conformance fixture**: a campaign with one conformance mechanic (native TS
  closure + Rust op under a shared key) driven through: a full round (onRoundStart at begin,
  onTurnStart/onTurnEnd across the turn, onAction on a budgeted action, onRoundEnd + next
  onRoundStart at round wrap) and a mitigated attack exercising `modify_damage`. The op exercises
  several effect kinds (e.g. an AdjustStat drain + a Cue on round end, and a damage cap via a
  `Final` `modify_damage`). The gate compares cues + snapshot (mechanic `state`, stat effects)
  per step. This makes sub-plan 5's turn-end reconcile and the two fixed orderings gate-observable.
- **Full gate**: `pnpm run checks:phase3` EXIT 0 (`no_std` build with the default feature set —
  the mechanic machinery must be `no_std`/`alloc`-clean; `cargo test --workspace`;
  `bindings:check`; `test:conformance`) and `pnpm run fixtures:stable` EXIT 0. Pre-6a goldens
  (campaigns with no mechanics) must stay byte-identical — an empty mechanic list dispatches
  nothing.

## Deferred (explicit)

- Custom mechanic actions (`useMechanicAction`/`INVOKE_MECHANIC_ACTION`/`MechanicAction` command)
  → **6a-2**.
- `ScriptedMechanic` + Rhai + the `scripting` feature + TS closure shadows for scripted
  conformance mechanics → **6b**.
- Keyed exits, scenes, NPC dialogue, encounter spawning → **6c+**; mob-AI turns dropped (nothing
  to port).
- Character-event turn hub (`events.onTurnStart/onTurnEnd`) stays a no-op (no handlers exist).
- Full win/lose `resolveOutcome` at round end → **sub-plan 7** (timeout → `TimedOut` already
  handled).

## Documentation

Per the standing convention, update `README.md` (and relevant Rust doc comments) to document the
mechanic op-registry, the hook/effect contract, and the fire-points before the work is considered
done.
