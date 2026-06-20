# Victory Conditions — Design

**Status:** Approved (2026-06-19)
**Author:** Daniel Mullins (with Claude)

## Summary

The engine has no notion of *winning* or *losing* a campaign. A campaign tracks a
single `#finished` boolean, flipped either by a manual `endCampaign()` call or by
the silent `round >= maxRounds` auto-end inside `endRound()`. This feature adds
**victory conditions**: named predicate functions that are evaluated at the
conclusion of every round to resolve a campaign to an explicit outcome
(`won` / `lost` / `timed-out`), alongside the existing manual end (`ended`).

## Goals

- Let a campaign carry **lists** of win conditions and loss conditions.
- Evaluate them **at the conclusion of each round** and resolve the campaign to
  an explicit outcome.
- Keep conditions **serializable**: persisted by registry key and re-resolved to
  predicates on reload, exactly like `knownRecipes`.
- Make conditions **authorable** through the existing fluent template builder with
  compile-time-checked keys.
- Preserve backward-compatible behavior: `campaign.finished` still works; the
  `maxRounds` ceiling still ends the campaign (now as an explicit `timed-out`).

## Non-Goals

- No declarative condition DSL. Conditions are configuration-as-code predicates
  (the user explicitly chose predicate functions over declarative descriptors).
- No mid-play mutation of the condition lists. They are static config set at
  construction, like `rng` and `maxRounds`.
- No per-character or per-faction victory. A campaign resolves to one outcome.
- No GM-declared win/loss via `endCampaign(outcome)`. Manual end stays a single
  neutral `ended` outcome (can be revisited later).

## Decisions (from brainstorming)

1. **Outcome model:** win + loss + timeout — modeled as
   `ongoing | won | lost | timed-out | ended`.
2. **Condition form:** predicate functions `(campaign) => boolean`, re-attached by
   registry key on reload (the item-factory / recipe precedent).
3. **Multiplicity & precedence:** lists of named conditions (any-of). The **loss
   list is evaluated before the win list**; if any loss condition fires the
   outcome is `lost` even if a win condition also fires the same round.
4. **Manual end:** `endCampaign()` keeps its no-arg signature and produces the
   `ended` outcome — distinct from win/loss/timeout.
5. **Resolution cue:** a new presentation cue is emitted when the campaign
   resolves, so UIs get a push signal instead of polling.

---

## Architecture

### New unit: `src/lib/victory.ts`

A small, dependency-light module holding the outcome vocabulary and the pure
resolution function. Keeping resolution out of `campaign.ts` makes it
independently testable and keeps `campaign.ts` from growing.

```ts
import type { ICampaign } from "./campaign.js"; // type-only; no runtime cycle

/** How a campaign ended (or that it is still running). */
export type CampaignOutcome =
  | "ongoing"
  | "won"
  | "lost"
  | "timed-out"
  | "ended";

/** A named win/loss predicate. `key` is the registry key it was resolved from. */
export interface VictoryCondition {
  readonly key: string;
  readonly test: (campaign: ICampaign) => boolean;
}

/** The resolved result of a round-end evaluation. */
export interface OutcomeResult {
  readonly status: CampaignOutcome; // never "ended" — that is the manual path
  /** Registry key of the condition that fired (for "won"/"lost"). */
  readonly reason?: string;
}

/**
 * Pure round-end resolution. Loss conditions are evaluated before win
 * conditions; a maxRounds ceiling resolves to "timed-out" only if no
 * win/loss condition fired this round.
 */
export function resolveOutcome(input: {
  round: number;
  maxRounds: number;
  winConditions: readonly VictoryCondition[];
  loseConditions: readonly VictoryCondition[];
  campaign: ICampaign;
}): OutcomeResult {
  const { round, maxRounds, winConditions, loseConditions, campaign } = input;

  for (const c of loseConditions) {
    if (c.test(campaign)) return { status: "lost", reason: c.key };
  }
  for (const c of winConditions) {
    if (c.test(campaign)) return { status: "won", reason: c.key };
  }
  if (round >= maxRounds) return { status: "timed-out" };
  return { status: "ongoing" };
}
```

### `Campaign` changes (`src/lib/campaign.ts`)

**New private state:**

```ts
#outcome: CampaignOutcome = "ongoing";
#outcomeReason: string | undefined = undefined;
#winConditions: VictoryCondition[] = [];
#loseConditions: VictoryCondition[] = [];
```

The old `#finished: boolean` is **removed**; its role is subsumed by `#outcome`.

**Constructor options** gain two fields (injection point for direct + authored
construction):

```ts
options: {
  rng?: () => number;
  baseEncounterChance?: number;
  actionSounds?: Partial<Record<ActionKind, AssetRef>>;
  winConditions?: VictoryCondition[];
  loseConditions?: VictoryCondition[];
}
```

stored as `this.#winConditions = [...(options.winConditions ?? [])]` (copied).

**New / changed getters:**

```ts
get outcome(): CampaignOutcome { return this.#outcome; }
get outcomeReason(): string | undefined { return this.#outcomeReason; }
get finished(): boolean { return this.#outcome !== "ongoing"; } // back-compat
```

**`#assertRunning()`** changes from checking `#finished` to checking
`this.#outcome !== "ongoing"` (and `#started`). Behavior is identical.

**Private `#finish(outcome, reason?)`** centralizes termination (sets
`#outcome`/`#outcomeReason`, emits the resolution cue). Both the public
`endCampaign()` and the round resolver funnel through it:

```ts
#finish(outcome: Exclude<CampaignOutcome, "ongoing">, reason?: string): void {
  this.#outcome = outcome;
  this.#outcomeReason = reason;
  this[EMIT_CUE]({ kind: "resolution", outcome, reason });
}

endCampaign(): void {
  this.#assertRunning();
  this.#finish("ended");
}
```

**`endRound()`** gets the hook at its tail. Current body:

```ts
endRound() {
  this.#assertRunning();
  const allPartyActed = this.party.every((c) => this.#actedThisRound.get(c));
  if (allPartyActed) {
    this.#round = this.#round + 1;
    if (this.#round >= this.maxRounds) {
      this.endCampaign();
    }
    this.#resetActivity();
  } else {
    throw new ProceduralViolation(/* ... */);
  }
}
```

becomes (the inline `maxRounds` end is folded into `resolveOutcome`):

```ts
endRound() {
  this.#assertRunning();
  const allPartyActed = this.party.every((c) => this.#actedThisRound.get(c));
  if (!allPartyActed) {
    throw new ProceduralViolation(
      "Attempted to end round before all characters have acted",
    );
  }
  this.#round = this.#round + 1;
  this.#resetActivity();
  const result = resolveOutcome({
    round: this.#round,
    maxRounds: this.maxRounds,
    winConditions: this.#winConditions,
    loseConditions: this.#loseConditions,
    campaign: this,
  });
  if (result.status !== "ongoing") {
    this.#finish(result.status, result.reason);
  }
}
```

Note: the maxRounds ceiling now resolves to `timed-out` instead of calling
`endCampaign()` (which would have produced `ended`). A win on the final round is
returned as `won` because `resolveOutcome` checks the condition lists before the
ceiling.

### Presentation cue (`src/lib/presentation.ts`)

Add a fourth cue variant:

```ts
export type PresentationCue =
  | { kind: "action"; action: ActionKind; actor: EntityRef; sound?: AssetRef }
  | { kind: "encounter"; mob: EntityRef; room: EntityRef; sound?: AssetRef }
  | { kind: "visibility"; room: EntityRef; lit: boolean }
  | { kind: "resolution"; outcome: CampaignOutcome; reason?: string };
```

Emitted exactly once per campaign, from `#finish`.

### Registry (`src/lib/serialization/registry.ts`)

`CampaignRegistry` gains a conditions map mirroring items:

```ts
#conditions = new Map<string, (campaign: ICampaign) => boolean>();

registerCondition(key: string, predicate: (campaign: ICampaign) => boolean): void {
  this.#conditions.set(key, predicate);
}

condition(key: string): (campaign: ICampaign) => boolean {
  return this.#require(this.#conditions.get(key), "condition", key);
}
```

### Typed authoring registry (`src/lib/authoring/registry.ts`)

```ts
declare const CONDITION_KEYS: unique symbol;

export type TypedRegistry<
  IK extends string,
  RK extends string,
  CK extends string = never,
> = CampaignRegistry & {
  readonly [ITEM_KEYS]?: IK;
  readonly [RECIPE_KEYS]?: RK;
  readonly [CONDITION_KEYS]?: CK;
};

export type ConditionKeyOf<R> =
  R extends { readonly [CONDITION_KEYS]?: infer K extends string } ? K : string;
```

`defineRegistry` gains a third generic `C extends Record<string, (campaign: ICampaign) => boolean>`
and a `conditions?: C` def, registered via `reg.registerCondition`. The defaulted
`CK = never` keeps every existing `TypedRegistry<IK, RK>` / `defineRegistry` call
site compiling unchanged.

### Template builder & description (`src/lib/authoring/template-builder.ts`)

`TemplateBuilder<IK, RK, CK extends string = never>` gains:

```ts
winWhen(key: CK): this {
  this.description.winConditions.push(key);
  return this;
}
loseWhen(key: CK): this {
  this.description.loseConditions.push(key);
  return this;
}
```

`CampaignTemplateDescription` gains `winConditions: string[]` and
`loseConditions: string[]` (initialized `[]`). `authorTemplate`'s return type
threads the registry's `ConditionKeyOf` through as `CK`.

### Assembler (`src/lib/authoring/assembler.ts`)

**Pass 1 (validate-all):** each win/loss key is checked against the registry,
accumulating into the existing `problems[]` / `AuthoringError`:

```ts
const requireConditionKey = (k: string, ctx: string) => {
  try { registry.condition(k); }
  catch { problems.push(`${ctx} references unregistered condition key '${k}'.`); }
};
for (const k of desc.winConditions) requireConditionKey(k, "winWhen");
for (const k of desc.loseConditions) requireConditionKey(k, "loseWhen");
```

**Pass 2 (construct):** resolve keys to `VictoryCondition` records and pass them
as constructor options:

```ts
const winConditions = desc.winConditions.map((k) => ({ key: k, test: registry.condition(k) }));
const loseConditions = desc.loseConditions.map((k) => ({ key: k, test: registry.condition(k) }));
const campaign = new Campaign(desc.title, desc.opts.maxRounds ?? 100, [], {
  rng: desc.opts.rng,
  baseEncounterChance: desc.opts.baseEncounterChance,
  winConditions,
  loseConditions,
});
```

### Serialization (`src/lib/serialization/types.ts`, `campaign.ts`)

`CampaignCoreSnapshot`:

- **Remove** `finished: boolean`.
- **Add** `outcome: CampaignOutcome`.
- **Add** `winConditionKeys: string[]` and `loseConditionKeys: string[]`.
- **Add** `outcomeReason?: string`.

`SCHEMA_VERSION` bumps **1 → 2**. The durable-persistence layer already
fails-closed on schema mismatch, so pre-existing v1 snapshots are rejected rather
than mis-hydrated (acceptable for the current pre-release stage).

`[SERIALIZE]()` writes:

```ts
outcome: this.#outcome,
outcomeReason: this.#outcomeReason,
winConditionKeys: this.#winConditions.map((c) => c.key),
loseConditionKeys: this.#loseConditions.map((c) => c.key),
```

`[HYDRATE_CATALOG](core, registry)` re-resolves predicates (before any character
hydrates, consistent with how it already restores recipes):

```ts
this.#winConditions = core.winConditionKeys.map((k) => ({ key: k, test: registry.condition(k) }));
this.#loseConditions = core.loseConditionKeys.map((k) => ({ key: k, test: registry.condition(k) }));
```

`[HYDRATE](core, ctx)` restores `this.#outcome = core.outcome` and
`this.#outcomeReason = core.outcomeReason` (replacing the old `this.#finished = core.finished`).

---

## Data flow

```
author: authorTemplate(title, registry).winWhen("all-bosses-down").loseWhen("party-wiped")
  -> description.winConditions / loseConditions hold the keys
  -> .build() -> assemble():
       pass 1: validate keys against registry.condition(key)
       pass 2: resolve to VictoryCondition[], pass via constructor options
  -> Campaign holds #winConditions / #loseConditions

play: ...nextPlayer() until last party member -> endRound()
  -> round++, resetActivity()
  -> resolveOutcome(): loss list, then win list, then maxRounds
  -> non-ongoing -> #finish(status, reason): set #outcome, emit "resolution" cue

persist: [SERIALIZE] writes outcome + condition KEYS (not predicates)
reload:  deserializeCampaign(data, { registry, rng })
  -> [HYDRATE_CATALOG] re-resolves keys -> predicates via registry.condition
  -> [HYDRATE] restores #outcome
```

## Error handling

- An author referencing an unregistered condition key fails at `assemble()` time
  with `AuthoringError` (batched with all other validation problems).
- A snapshot referencing an unregistered condition key fails at hydrate with the
  registry's existing `ProceduralViolation` (`No condition registered for key …`).
- Calling `endCampaign()` / `endRound()` on an already-resolved campaign throws
  `ProceduralViolation` via `#assertRunning()`, unchanged.
- A predicate that throws propagates out of `endRound()` — predicates are author
  code and expected to be total; we do not swallow their errors.

## Testing

- **`victory.test.ts`** (pure resolver): loss-before-win precedence; both-fire →
  `lost`; win on final round → `won` (not `timed-out`); empty lists + ceiling →
  `timed-out`; empty lists, under ceiling → `ongoing`; `reason` carries the firing
  key.
- **`campaign.test.ts`**: `endRound()` resolves `won`/`lost`/`timed-out`; `outcome`
  + `outcomeReason` getters; `finished` derived; `endCampaign()` → `ended`;
  resolution cue emitted exactly once; `#assertRunning` blocks post-resolution
  turns.
- **Registry / authoring**: `defineRegistry({ conditions })` types `CK`;
  `.winWhen` / `.loseWhen` compile-checked; assembler rejects unknown keys.
- **Serialization round-trip**: a campaign with conditions → `serializeCampaign` →
  `deserializeCampaign` re-attaches predicates and they still fire; the
  `authoring/roundtrip.test.ts` gains a victory-condition case.
- **Integration** (`integration.test.ts`): a full template-authored campaign won
  by reaching a target room.

## Documentation

- `README.md`: new "Victory conditions" mechanics section (outcome vocabulary,
  round-end evaluation order, authoring via `.winWhen`/`.loseWhen`).
- `docs-site/guide/data-model.md`: the live-campaign ER diagram gains the campaign
  `outcome` field and a `VictoryCondition` relationship; the template diagram gains
  win/loss condition-key references.
- TSDoc on `CampaignOutcome`, `VictoryCondition`, `resolveOutcome`, the new getters,
  `registerCondition`, `.winWhen`/`.loseWhen`.

## File map

| File | Change |
| --- | --- |
| `src/lib/victory.ts` | **new** — `CampaignOutcome`, `VictoryCondition`, `OutcomeResult`, `resolveOutcome` |
| `src/lib/victory.test.ts` | **new** — pure resolver tests |
| `src/lib/campaign.ts` | outcome state, constructor opts, getters, `#finish`, `endRound` hook, serialize/hydrate |
| `src/lib/presentation.ts` | `resolution` cue variant |
| `src/lib/serialization/types.ts` | `CampaignCoreSnapshot` fields, `SCHEMA_VERSION` 1→2 |
| `src/lib/serialization/registry.ts` | `registerCondition` / `condition` |
| `src/lib/authoring/registry.ts` | `CONDITION_KEYS`, `ConditionKeyOf`, `defineRegistry` conditions |
| `src/lib/authoring/template-builder.ts` | `.winWhen` / `.loseWhen`, description fields, `CK` param |
| `src/lib/authoring/assembler.ts` | validate + resolve condition keys |
| `README.md`, `docs-site/guide/data-model.md` | mechanics + diagram updates |
