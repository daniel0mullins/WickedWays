# Campaign Custom Mechanics — Design

**Status:** Approved (2026-06-22)
**Author:** Daniel Mullins (with Claude)

## Summary

The engine lets a campaign author plug in *content* (rooms, mobs, loot, recipes,
archetypes) and a narrow slice of *behavior* (victory-condition predicates, scene
scripts, encounter formations) through the registry. There is no way to author a
**campaign-scoped rule** — a doom clock that ticks each round, a sanity drain in dark
rooms, a ward that negates fire damage, a "rally" verb a player can spend an action
on.

This feature adds **custom mechanics**: opt-in, per-campaign rules registered by key,
carrying their own typed state, that react to turn-loop events and adjust combat math.
Mechanics are *pure* (they read a read-only view, mutate only their own namespaced
state, and return a curated `Effect[]` the engine applies), so they can never reach
raw engine state. The system is **inert unless a campaign opts in** via
`.useMechanic(key, config?)`, and it reuses the existing registry / by-key
serialization / symbol-seam patterns end to end.

## Goals

- A **single unified system** spanning four mechanic shapes: reactive round/turn/
  action rules, author-defined campaign-scoped state, combat-math adjustment, and
  author-defined player actions.
- **Opt-in per campaign** (React-Router-`future`-flag feel): naming a mechanic via
  `.useMechanic` turns it on and configures it inline; a campaign that names none
  behaves exactly as today.
- **Guardrails, in priority order** (from brainstorming):
  - **A — Integrity.** A mechanic can only act through a closed, clamped `Effect`
    vocabulary applied via the existing `Symbol` seams. No raw writes exist for it
    to call; magnitudes are clamped to legal ranges; state is namespaced so one
    mechanic cannot read or stomp another's.
  - **B — Determinism.** Hooks are pure functions of `(view, state, rng)`. The only
    sanctioned randomness is the injected campaign `rng`; the view exposes no clock
    or I/O. Authoritative-server replays stay byte-identical.
  - **D — Termination.** One non-reentrant collect-then-apply pass per event;
    applying effects never re-fires hooks; a per-event effect cap throws rather than
    looping.
  - **C — Balance.** Treated lightly: amounts are clamped, but there is no budget
    economy.
- **Serializable** the same way conditions are: behavior re-attaches from the
  registry by key; only typed state data is persisted.
- **Compile-time-checked keys and typed config**, consistent with `ConditionKeyOf`
  and branded ids.

## Non-Goals

- **No reducer short-circuiting (deferred).** Reactive hooks are batched and
  non-pre-emptive in v1; one reducer cannot cancel another's effects. Only
  *transformers* may short-circuit (see Decisions). A concrete reducer pre-emption
  case can revisit this later.
- **No "break-glass" effects in v1.** The `Effect` vocabulary excludes granting/
  destroying items, forging ownership, ending the campaign (victory conditions own
  win/lose), spawning mobs (mob authoring owns that), and adding new `Status`
  values (the `Status` enum stays fixed; mechanics influence afflictions only
  indirectly via the existing stat-derivation).
- **No second transformer beyond combat in v1.** The taxonomy leaves room for
  `modifyMitigation` / `modifyLootRoll` / `modifyEncounterChance`, but only
  `modifyDamage` ships now.
- **No unified single-damage-pipeline refactor.** Routing *all* damage (normal
  attacks included) through one effect-mediated chokepoint is a real engine
  improvement but a separable follow-up spec; this design stays compatible with it.
- **No mob-death / encounter-spawn hooks.** Those stay in mob authoring. (If they
  are not fully expressible there today, that is a separate gap, out of scope here.)
- **No hard determinism sandbox.** Purity is a *contract* (like conditions/scenes),
  enforced by giving hooks everything they need on `h`, documentation, and the
  existing ambient-randomness lint rule — not a runtime jail.
- **No mid-play opt-in mutation.** The mechanic set is static config fixed at
  authoring, like `rng` and the condition lists.

## Decisions (from brainstorming)

1. **Two hook categories, not an exception.** *Reducers* react to events and return
   deferred `Effect[]` (round/turn/action). *Transformers* adjust an in-flight value
   and return it, engine-clamped (combat math). Combat is "the damage transformer,"
   the first member of the transformer category — not a special case.
2. **Pure hooks, mutable own-state, returned effects.** `h.state` is freely mutable
   (it is the mechanic's own namespaced JSON and cannot break engine invariants);
   world changes are expressed only as returned `Effect`s; `h.view` is read-only;
   randomness is `h.rng`/`h.roll(n)` only.
3. **Closed, clamped `Effect` union** is guardrail A's enforcement point. The applier
   is the only code that turns an effect into a state change, routing through the
   existing seams and clamping every magnitude.
4. **Typed, per-mechanic, key-namespaced state**, serialized by key exactly like
   conditions: behavior from the registry, data from the snapshot.
5. **Opt-in via `.useMechanic(key, config?)`**; opt-in **order is execution order**
   (reducer firing order and transformer chaining order), so authors control
   precedence by ordering.
6. **Transformer short-circuit via `final`.** A transformer may return
   `{ value, final: true }` to lock the value and halt the chain — the
   immunity/ward/override pattern. Because the ward is opted in first, it pre-empts
   downstream transformers. Every short-circuit emits an observable diagnostic cue,
   so suppression is never silent.
7. **Custom actions via one budgeted dispatcher.** Author-defined verbs run through a
   single `useMechanicAction` method registered once by identity in `isActionMap`, so
   they tick the per-round budget without violating the by-identity action contract.

---

## Architecture

### New unit: `src/lib/mechanics/mechanic.ts`

The public vocabulary: the `Mechanic` definition, the hook contexts, the `Effect`
union, and the custom-action shape. Type-heavy and dependency-light; no runtime
cycle (engine types imported `import type`).

```ts
import type { CharacterId } from "../brand.js";
import type { AssetRef } from "../presentation.js";
import type { Status } from "../status.js";

/** JSON-serializable value — the contract for all mechanic state and effect data. */
export type JsonValue =
  | null | boolean | number | string
  | JsonValue[] | { [k: string]: JsonValue };

/**
 * Read-only projection of campaign state handed to every hook. Exposes data, never
 * setters or symbol seams — guardrail A (a hook can read anything, mutate nothing
 * here). No clock / no I/O — guardrail B.
 */
export interface CampaignView {
  readonly round: number;
  readonly maxRounds: number;
  readonly party: readonly CharacterView[];
  readonly rooms: readonly RoomView[];
  // (further read-only projections added as hooks need them; never a live entity)
}

export interface CharacterView {
  readonly id: CharacterId;
  readonly name: string;
  readonly health: number;
  readonly maxHealth: number;
  readonly sanity: number;
  readonly energy: number;
  readonly status: readonly Status[];
  readonly roomId: string | undefined;
  /** True if the named equipment slot holds an item with this registry key. */
  hasEquipped(itemKey: string): boolean;
}

export interface RoomView {
  readonly id: string;
  readonly name: string;
  readonly lit: boolean;
  readonly occupantIds: readonly CharacterId[];
}

/** Context for round-level reducer hooks. `state` is this mechanic's own, mutable. */
export interface HookCtx<S> {
  state: S;
  readonly view: CampaignView;
  readonly rng: () => number;
  /** Integer in [1, n], drawn from the campaign rng (dice.ts `roll`). */
  roll(n: number): number;
}

/** Turn-level context: adds the acting character. */
export interface TurnCtx<S> extends HookCtx<S> {
  readonly actor: CharacterView;
}

/** A budgeted action that just resolved (for `onAction`). */
export type ActionEvent =
  | { kind: "move"; from: string | undefined; to: string }
  | { kind: "attack"; target: CharacterId }
  | { kind: "loot"; lootId: string }
  | { kind: "craft"; recipeKey: string };

/** Action-level context: adds the action that fired (or is being invoked). */
export interface ActionCtx<S> extends TurnCtx<S> {
  readonly action: ActionEvent;
}

/** The in-flight damage a transformer may adjust. */
export interface DamageView {
  readonly amount: number;
  readonly target: CharacterId;
  readonly source: CharacterId | undefined;
}

/** A transformer either returns the adjusted number, or locks it and halts the chain. */
export type TransformResult = number | { value: number; final: true };

/**
 * A presentation cue authored by a mechanic (narration / sound). Surface-agnostic,
 * plain data — rendered by the play surface, never formatted by the engine.
 */
export interface MechanicCue {
  readonly text?: string;
  readonly sound?: AssetRef;
}

/**
 * The closed set of state changes a mechanic may request. The applier
 * (`apply.ts`) is the ONLY code that realizes these, routing through the existing
 * symbol seams and clamping every magnitude — guardrail A. There is deliberately
 * no raw setter (`setHealth`, `setOwner`, …) in this union.
 */
export type Effect =
  | { kind: "damage"; target: CharacterId; amount: number }
  | { kind: "heal"; target: CharacterId; amount: number }
  | { kind: "adjustStat"; target: CharacterId; stat: "sanity" | "energy"; delta: number }
  | { kind: "grantImmunity"; target: CharacterId; turns: number }
  | { kind: "cue"; cue: MechanicCue };

/** An author-defined verb a player can spend an action on (hook 6). */
export interface CustomAction<S> {
  /** Action-budget cost; defaults to 1. */
  readonly cost?: number;
  run(h: ActionCtx<S>): Effect[] | void;
}

/**
 * A campaign-scoped custom rule. Registered by key in the registry; opted into per
 * campaign via `.useMechanic`. All hooks optional. `S` is the typed state; `Cfg` the
 * per-campaign config; `A` the union of custom-action keys.
 */
export interface Mechanic<S extends JsonValue, Cfg = void, A extends string = never> {
  /** Typed starting state; receives the per-campaign config. Called once, at authoring. */
  initialState(config: Cfg): S;

  // Reducers — react to events, return deferred effects, mutate own state in place.
  onRoundStart?(h: HookCtx<S>): Effect[] | void;
  onRoundEnd?(h: HookCtx<S>): Effect[] | void;
  onTurnStart?(h: TurnCtx<S>): Effect[] | void;
  onTurnEnd?(h: TurnCtx<S>): Effect[] | void;
  onAction?(h: ActionCtx<S>): Effect[] | void;

  // Transformer — adjusts in-flight damage; engine clamps the result; may short-circuit.
  modifyDamage?(d: DamageView, h: HookCtx<S>): TransformResult;

  // Custom verbs (hook 6).
  actions?: Record<A, CustomAction<S>>;
}
```

### Effect applier (`src/lib/mechanics/apply.ts`)

A pure-as-possible function that realizes one effect against the live campaign,
through the existing seams, clamping magnitudes. This is guardrail A's single
chokepoint — nothing else realizes an effect.

```ts
import { GRANT_IMMUNITY } from "../inventory.js";
import { EMIT_CUE } from "../presentation.js";

/** Realize one effect. Negative amounts are rejected (clamped to 0); positive ones
 *  are clamped to the target's legal bounds before touching state. */
export function applyEffect(campaign: Campaign, e: Effect): void {
  switch (e.kind) {
    case "damage": {
      const c = campaign[FIND_CHARACTER](e.target);
      c.takeDamage(clampToHealth(c, Math.max(0, e.amount))); // free action, existing seam
      break;
    }
    case "heal": {
      const c = campaign[FIND_CHARACTER](e.target);
      c[HEAL](clampToMaxHealth(c, Math.max(0, e.amount)));
      break;
    }
    case "adjustStat": {
      const c = campaign[FIND_CHARACTER](e.target);
      c[ADJUST_STAT](e.stat, clampStatDelta(c, e.stat, e.delta));
      break;
    }
    case "grantImmunity": {
      const c = campaign[FIND_CHARACTER](e.target);
      c[GRANT_IMMUNITY](Math.max(0, Math.trunc(e.turns)));
      break;
    }
    case "cue":
      campaign[EMIT_CUE]({ kind: "mechanic", cue: e.cue });
      break;
  }
}
```

`HEAL` / `ADJUST_STAT` / `FIND_CHARACTER` are new symbol seams (a small extension of
the existing `inventory.ts` seam family) where the engine lacks a safe internal
mutator today; `GRANT_IMMUNITY` and `EMIT_CUE` already exist. The applier is the only
caller permitted to import them for mechanic purposes.

### Dispatch (`src/lib/mechanics/dispatch.ts`)

Two routines, both pure of control flow beyond ordering:

```ts
/** Reducers: run every opted-in mechanic's hook (in opt-in order), collect ALL
 *  effects, then apply them in a single pass. Applying effects does NOT re-enter
 *  dispatch — guardrail D (no re-entrancy). Per-mechanic effect count is capped. */
export function runReducers<E>(
  mechanics: readonly LiveMechanic[],
  hook: (m: LiveMechanic) => Effect[] | void,
  campaign: Campaign,
): void {
  const queued: Effect[] = [];
  for (const m of mechanics) {
    const out = hook(m) ?? [];
    if (out.length > MAX_EFFECTS_PER_EVENT) {
      throw new ProceduralViolation(
        `Mechanic '${m.key}' emitted ${out.length} effects (cap ${MAX_EFFECTS_PER_EVENT}).`,
      );
    }
    queued.push(...out);
  }
  for (const e of queued) applyEffect(campaign, e);
}

/** Transformer chain: fold the value through each opted-in mechanic's transformer
 *  in opt-in order, clamping after each. A `final` result locks the value, halts the
 *  chain, and emits a diagnostic cue (observability for guardrail A). */
export function runDamageTransformers(
  mechanics: readonly LiveMechanic[],
  initial: DamageView,
  campaign: Campaign,
): number {
  let value = initial.amount;
  for (const m of mechanics) {
    if (!m.mechanic.modifyDamage) continue;
    const r = m.mechanic.modifyDamage({ ...initial, amount: value }, m.ctx());
    const next = clampDamage(typeof r === "number" ? r : r.value);
    if (typeof r === "object" && r.final) {
      campaign[EMIT_CUE]({ kind: "mechanic", cue: { text: `${m.key} fixed damage at ${next}.` } });
      return next;
    }
    value = next;
  }
  return value;
}
```

`MAX_EFFECTS_PER_EVENT` is a module constant (default 64) — a runaway backstop, not a
balance budget.

### `Campaign` changes (`src/lib/campaign.ts`)

**New private state**, written only through a `MECHANICS` symbol seam (so opted-in
mechanics cannot be forged post-construction):

```ts
#mechanics: LiveMechanic[] = []; // { key, mechanic, state } in opt-in order
```

A `LiveMechanic` pairs the registry behavior with its mutable state and a `ctx()`
factory that builds a fresh `HookCtx`/`TurnCtx`/`ActionCtx` over the read-only view +
the campaign `rng` for each invocation.

**Constructor option** (the injection point for both direct and authored
construction):

```ts
mechanics?: LiveMechanic[]; // copied; defaults to []
```

**Dispatch points** in the turn loop:

- `endRound()` — `runReducers(onRoundStart)` at the top (after `#assertRunning`),
  `runReducers(onRoundEnd)` at the tail **before** `resolveOutcome`, so a mechanic's
  final effects count toward win/loss that round.
- `Character.startTurn` / `endTurn` — `runReducers(onTurnStart/onTurnEnd)` for that
  actor, alongside the existing affliction ticks.
- The budgeted-action recording path — after a native action records, dispatch
  `runReducers(onAction)` with the `ActionEvent`.
- The damage path — `runDamageTransformers` adjusts the incoming amount before it is
  applied.

Dispatch is routed through a private `#dispatch*` helper behind the `MECHANICS` seam;
when `#mechanics` is empty every dispatch is a no-op, preserving today's behavior
exactly (the opt-in invariant).

### `Character` changes (`src/lib/character/character.ts`)

- `onTurnStart` / `onTurnEnd` / `onAction` dispatch calls (the character asks its
  campaign to run the reducers for `this`).
- `modifyDamage` chain applied in the damage-resolution path.
- **`useMechanicAction(mechanicKey, actionKey)`** — a single dispatcher registered
  **once by identity** in `isActionMap`, so it ticks the per-round budget like a
  native action. It looks up the opted-in mechanic + action, enforces the action's
  `cost`, runs it with an `ActionCtx`, and feeds the returned effects to the applier.
  Registering one stable method (rather than synthesizing a method per action) keeps
  the by-identity budget contract intact (`recordAction(fn)` ignores unregistered
  functions; we never detach-and-call).
- New `HEAL` / `ADJUST_STAT` seam methods (getter-exposed state, symbol-gated write),
  used only by the applier.

### Presentation cue (`src/lib/presentation.ts`)

Add a `mechanic` cue variant for both mechanic-authored cues and short-circuit
diagnostics:

```ts
export type PresentationCue =
  | /* …existing action | encounter | visibility | resolution… */
  | { kind: "mechanic"; cue: MechanicCue };
```

`presentation.ts` and `mechanic.ts` reference each other's types only via
`import type`, so the cycle is erased at runtime (consistent with `victory.ts`).

### Registry (`src/lib/serialization/registry.ts`)

`CampaignRegistry` gains a mechanics map mirroring conditions:

```ts
#mechanics = new Map<string, Mechanic<JsonValue, unknown, string>>();

registerMechanic(key: string, mechanic: Mechanic<JsonValue, unknown, string>): void {
  this.#mechanics.set(key, mechanic);
}

mechanic(key: string): Mechanic<JsonValue, unknown, string> {
  return this.#require(this.#mechanics.get(key), "mechanic", key);
}
```

### Typed authoring registry (`src/lib/authoring/registry.ts`)

```ts
declare const MECHANIC_KEYS: unique symbol;

export type TypedRegistry<
  IK extends string,
  RK extends string,
  CK extends string = never,
  MK extends string = never,
> = CampaignRegistry & {
  readonly [ITEM_KEYS]?: IK;
  readonly [RECIPE_KEYS]?: RK;
  readonly [CONDITION_KEYS]?: CK;
  readonly [MECHANIC_KEYS]?: MK;
};

export type MechanicKeyOf<R> =
  R extends { readonly [MECHANIC_KEYS]?: infer K extends string } ? K : string;
```

`defineRegistry` gains a fourth generic and a `mechanics?: M` def, registered via
`reg.registerMechanic`. The defaulted `MK = never` keeps every existing
`defineRegistry` / `TypedRegistry` call site compiling unchanged.

### Template builder & description (`src/lib/authoring/template-builder.ts`)

`TemplateBuilder` gains `MK` and `.useMechanic`. The config type is inferred from the
mechanic's `Cfg` so it is compile-checked per key (a typed-config mismatch is a
compile error):

```ts
useMechanic<K extends MK>(key: K, config?: ConfigOf<R, K>): this {
  if (this.description.mechanics.some((m) => m.key === key)) {
    throw new AuthoringError(`Mechanic '${key}' is already enabled.`); // dup guard
  }
  this.description.mechanics.push({ key, config });
  return this;
}
```

`CampaignTemplateDescription` gains:

```ts
mechanics: { key: string; config?: unknown }[]; // init []; opt-in ORDER preserved
```

### Assembler (`src/lib/authoring/assembler.ts`)

**Pass 1 (validate-all):** each mechanic key is checked against the registry,
accumulating into the existing `problems[]` / `AuthoringError` (duplicates already
rejected at `.useMechanic`):

```ts
for (const m of desc.mechanics) {
  try { registry.mechanic(m.key); }
  catch { problems.push(`useMechanic references unregistered mechanic key '${m.key}'.`); }
}
```

**Pass 2 (construct):** resolve each key to its `Mechanic`, call
`initialState(config)`, and pass the live list (in opt-in order) as a constructor
option:

```ts
const mechanics = desc.mechanics.map((m) => {
  const mechanic = registry.mechanic(m.key);
  return { key: m.key, mechanic, state: mechanic.initialState(m.config) };
});
new Campaign(/* …*/, { /* …*/, mechanics });
```

### Serialization (`src/lib/serialization/types.ts`, `campaign.ts`)

The mechanic's behavior is re-attached by key (like a condition predicate); only its
typed state is persisted.

- **Add** to `CampaignCoreSnapshot`:
  `mechanics: { key: string; state: JsonValue }[]`.
- `SCHEMA_VERSION` bumps **4 → 5**; `migrate` gains a `v4 → v5` step injecting
  `mechanics: []` (pre-existing snapshots had none and hydrate as inert).

`[SERIALIZE]()` writes `this.#mechanics.map((m) => ({ key: m.key, state: m.state }))`.
State must be `JsonValue`; this is validated best-effort at serialize time (a
non-serializable state throws a `ProceduralViolation` naming the mechanic) and
documented as the author contract.

`[HYDRATE_CATALOG](core, registry)` re-attaches behavior and restores state verbatim,
before any character hydrates (consistent with recipes/conditions). `initialState`
is **not** called on hydrate — only at first authoring:

```ts
this.#mechanics = core.mechanics.map((m) => ({
  key: m.key,
  mechanic: registry.mechanic(m.key), // ProceduralViolation if missing
  state: m.state,
}));
```

---

## Data flow

```
author: authorTemplate(title, registry)
          .useMechanic("doom-clock", { ratePerRound: 1, doomAt: 10 })  // typed config
          .useMechanic("fire-ward")                                     // transformer, opted first
  -> description.mechanics = [{ key, config }, …]  (opt-in ORDER = precedence)
  -> .build() -> assemble():
       pass 1: validate each key against registry.mechanic(key)
       pass 2: resolve to Mechanic, call initialState(config) -> LiveMechanic[]
  -> Campaign holds #mechanics behind the MECHANICS seam

play: endRound() -> runReducers(onRoundStart) -> … -> runReducers(onRoundEnd)
        -> resolveOutcome (mechanic effects this round already applied)
      startTurn/endTurn -> runReducers(onTurnStart/onTurnEnd, actor)
      native action records -> runReducers(onAction, event)
      player invokes useMechanicAction(key, actionKey) -> budget ticks -> effects applied
      incoming damage -> runDamageTransformers (chain in opt-in order; `final` halts + cue)
  -> every world change flows through applyEffect -> existing symbol seams, clamped

persist: [SERIALIZE] writes { key, state } per mechanic (NOT behavior)
reload:  deserializeCampaign(data, { registry, rng })
  -> [HYDRATE_CATALOG] re-attaches Mechanic by key, restores state verbatim
  -> behavior fresh from registry; doom: 7 intact; missing key -> ProceduralViolation
```

## Error handling

- Unregistered mechanic key at authoring → `AuthoringError` at `assemble()` (batched).
- Duplicate `.useMechanic(key)` → `AuthoringError` at call time.
- Unregistered mechanic key at hydrate → registry `ProceduralViolation`
  (`No mechanic registered for key …`), matching conditions/scenes.
- A hook that emits more than `MAX_EFFECTS_PER_EVENT` effects → `ProceduralViolation`
  (runaway backstop, guardrail D).
- Non-`JsonValue` mechanic state at serialize → `ProceduralViolation` naming the
  mechanic.
- A hook that throws propagates out of the dispatch site — hooks are author code,
  expected to be total; we do not swallow their errors (matching condition predicates).
- Effect magnitudes are clamped, never rejected-by-throw, so a numerically extreme
  effect is bounded, not fatal (guardrail A favors integrity over author punishment).

## Testing

- **`mechanic.test.ts` / per-example-mechanic** (pure): feed a fake `view` + state +
  seeded `rng`; assert returned `Effect[]`, mutated state, and (for transformers) the
  returned number / `final`. No campaign needed — the payoff of pure hooks.
- **`apply.test.ts`**: each `Effect` kind mutates through its seam; `damage`/`heal`/
  `adjustStat` clamp to legal bounds; negative amounts clamp to 0; `grantImmunity`
  truncates; `cue` emits a `mechanic` presentation cue.
- **`dispatch.test.ts`**: reducers run in opt-in order; collect-then-apply means
  applying effects never re-fires a hook (no re-entrancy); exceeding the per-event cap
  throws; transformer chain folds in opt-in order; `final` halts the chain, locks the
  value, and emits the diagnostic cue.
- **`character.test.ts`**: `useMechanicAction` ticks the action budget (counts against
  the round like a native action) and honors `cost`; turn/action dispatch fires at the
  right points.
- **Authoring / registry**: `defineRegistry({ mechanics })` types `MK`;
  `.useMechanic` key + config compile-checked (type-level test); duplicate rejected;
  assembler batches unknown-key problems.
- **Serialization round-trip** (`authoring/roundtrip.test.ts` + serialization suite):
  a campaign mid-mechanic (`doom: 7`) → `serializeCampaign` → `deserializeCampaign`
  restores state intact with behavior re-bound; missing registry key →
  `ProceduralViolation`; the `v4 → v5` migration injects `mechanics: []`.
- **Determinism** (`integration.test.ts`): same seed → byte-identical effect sequence
  across two runs (the authoritative-server replay guarantee).
- **Integration** (`integration.test.ts`): a template opting into a doom-clock + a
  fire-ward transformer, run several rounds through the real session lifecycle —
  assert state ticks each round, the ward pre-empts fire damage (and the next
  transformer never runs), and the whole campaign survives a serialize/hydrate cycle
  with state and behavior intact.

## Documentation

- `README.md`: a new "Custom mechanics" section under the mechanics chapters —
  the reducer/transformer taxonomy, the opt-in model (`.useMechanic`), the `Effect`
  vocabulary and clamping, the three guardrails (integrity / determinism /
  termination), transformer short-circuit precedence, and custom actions against the
  budget.
- `docs-site/guide/data-model.md`: the live-campaign ER diagram gains the campaign
  `mechanics` relationship (live `Mechanic` + namespaced state); the template diagram
  gains the `useMechanic` refs (key + config).
- TSDoc on `Mechanic`, the hook contexts, `Effect`, `CustomAction`, `MechanicKeyOf`,
  `registerMechanic`, `.useMechanic`, and `useMechanicAction`.
- The authoring guide documents writing a mechanic, the purity/JSON-state contract,
  and opt-in order as precedence.

## File map

| File | Change |
| --- | --- |
| `src/lib/mechanics/mechanic.ts` | **new** — `Mechanic`, hook contexts, `Effect`, `CustomAction`, `DamageView`, `TransformResult`, `MechanicCue`, `JsonValue` |
| `src/lib/mechanics/mechanic.test.ts` | **new** — pure hook + example-mechanic tests |
| `src/lib/mechanics/apply.ts` | **new** — clamping effect applier (the guardrail-A chokepoint) |
| `src/lib/mechanics/apply.test.ts` | **new** — per-effect + clamping tests |
| `src/lib/mechanics/dispatch.ts` | **new** — `runReducers` (collect-then-apply, capped) + `runDamageTransformers` (chain + `final`) |
| `src/lib/mechanics/dispatch.test.ts` | **new** — ordering, non-reentrancy, cap, short-circuit tests |
| `src/lib/campaign.ts` | `#mechanics` behind `MECHANICS` seam; constructor opt; dispatch in `endRound`; serialize/hydrate |
| `src/lib/character/character.ts` | turn/action dispatch points; `modifyDamage` chain; `useMechanicAction` dispatcher in `isActionMap`; `HEAL`/`ADJUST_STAT` seams |
| `src/lib/presentation.ts` | `mechanic` cue variant |
| `src/lib/serialization/types.ts` | `CampaignCoreSnapshot.mechanics`; `SCHEMA_VERSION` 4→5; `migrate` v4→v5 |
| `src/lib/serialization/registry.ts` | `registerMechanic` / `mechanic` |
| `src/lib/authoring/registry.ts` | `MECHANIC_KEYS`, `MechanicKeyOf`, `defineRegistry` mechanics + `ConfigOf` |
| `src/lib/authoring/template-builder.ts` | `.useMechanic`, `MK` param, description field, dup guard |
| `src/lib/authoring/description.ts` | `mechanics: { key, config }[]` |
| `src/lib/authoring/assembler.ts` | validate keys (pass 1); resolve + `initialState` (pass 2) |
| `README.md`, `docs-site/guide/data-model.md` | mechanics section + diagram updates |
