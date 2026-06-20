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
6. **Outcome prose is authored content, not a UI concern.** Each win/loss
   condition carries optional surface-agnostic narration (text + optional sound),
   and the template can set fallback narration for the conditionless `timed-out`
   and `ended` outcomes. Prose lives at the **template** layer (per-campaign
   content), never the registry (reusable behavior) — the same predicate can carry
   different prose in different campaigns. It travels with the campaign definition
   so a text terminal and an AR headset render the *same* canonical ending; the
   surface decides only *how*.

---

## Architecture

### New unit: `src/lib/victory.ts`

A small, dependency-light module holding the outcome vocabulary and the pure
resolution function. Keeping resolution out of `campaign.ts` makes it
independently testable and keeps `campaign.ts` from growing.

```ts
import type { ICampaign } from "./campaign.js"; // type-only; no runtime cycle
import type { AssetRef } from "./presentation.js";

/** How a campaign ended (or that it is still running). */
export type CampaignOutcome =
  | "ongoing"
  | "won"
  | "lost"
  | "timed-out"
  | "ended";

/**
 * Surface-agnostic authored prose for an outcome. Plain data — it serializes
 * natively (unlike a predicate) and any play surface renders it however it
 * likes. `sound` reuses the engine's existing asset-reference convention.
 */
export interface OutcomeNarration {
  readonly text?: string;
  readonly sound?: AssetRef;
}

/**
 * A named win/loss predicate plus its authored prose. `key` is the registry
 * key the `test` was resolved from; `narration` is per-campaign content.
 */
export interface VictoryCondition {
  readonly key: string;
  readonly test: (campaign: ICampaign) => boolean;
  readonly narration?: OutcomeNarration;
}

/** The resolved result of a round-end evaluation. */
export interface OutcomeResult {
  readonly status: CampaignOutcome; // never "ended" — that is the manual path
  /** The condition that fired (for "won"/"lost"); absent for "timed-out". */
  readonly condition?: VictoryCondition;
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
    if (c.test(campaign)) return { status: "lost", condition: c };
  }
  for (const c of winConditions) {
    if (c.test(campaign)) return { status: "won", condition: c };
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
#timeoutNarration: OutcomeNarration | undefined = undefined;
#endedNarration: OutcomeNarration | undefined = undefined;
```

The old `#finished: boolean` is **removed**; its role is subsumed by `#outcome`.

**Constructor options** gain the conditions and the conditionless-outcome prose
(injection point for direct + authored construction):

```ts
options: {
  rng?: () => number;
  baseEncounterChance?: number;
  actionSounds?: Partial<Record<ActionKind, AssetRef>>;
  winConditions?: VictoryCondition[];
  loseConditions?: VictoryCondition[];
  timeoutNarration?: OutcomeNarration;
  endedNarration?: OutcomeNarration;
}
```

stored as `this.#winConditions = [...(options.winConditions ?? [])]` (copied).

**New / changed getters:**

```ts
get outcome(): CampaignOutcome { return this.#outcome; }
get outcomeReason(): string | undefined { return this.#outcomeReason; } // firing key
get finished(): boolean { return this.#outcome !== "ongoing"; } // back-compat

/**
 * The authored prose for the resolved outcome, available to ANY play surface
 * whether it listens to the resolution cue or polls. Derived, so a reloaded
 * finished campaign reports the same prose: for won/lost it is the firing
 * condition's narration (found by `#outcomeReason`); for timed-out/ended it is
 * the template fallback.
 */
get outcomeNarration(): OutcomeNarration | undefined {
  switch (this.#outcome) {
    case "timed-out": return this.#timeoutNarration;
    case "ended": return this.#endedNarration;
    case "won": case "lost": {
      const list = this.#outcome === "won" ? this.#winConditions : this.#loseConditions;
      return list.find((c) => c.key === this.#outcomeReason)?.narration;
    }
    default: return undefined; // ongoing
  }
}
```

**`#assertRunning()`** changes from checking `#finished` to checking
`this.#outcome !== "ongoing"` (and `#started`). Behavior is identical.

**Private `#finish(outcome, condition?)`** centralizes termination (sets
`#outcome`/`#outcomeReason`, emits the resolution cue carrying the resolved
narration). Both the public `endCampaign()` and the round resolver funnel through
it. The narration on the cue is derived through the `outcomeNarration` getter, so
cue-driven and polling surfaces always agree:

```ts
#finish(outcome: Exclude<CampaignOutcome, "ongoing">, condition?: VictoryCondition): void {
  this.#outcome = outcome;
  this.#outcomeReason = condition?.key;
  this[EMIT_CUE]({
    kind: "resolution",
    outcome,
    reason: condition?.key,
    narration: this.outcomeNarration,
  });
}

endCampaign(): void {
  this.#assertRunning();
  this.#finish("ended"); // narration resolves to #endedNarration
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
    this.#finish(result.status, result.condition);
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
  | { kind: "resolution"; outcome: CampaignOutcome; reason?: string; narration?: OutcomeNarration };
```

Emitted exactly once per campaign, from `#finish`. The `narration` is the authored
`OutcomeNarration` (text + optional sound) for the resolved outcome — the surface
renders it; the engine never formats it. `AssetRef` (the cue's existing sound
convention) is reused, so `OutcomeNarration` introduces no new presentation type.

`presentation.ts` imports `CampaignOutcome`/`OutcomeNarration` from `victory.ts`,
and `victory.ts` imports `AssetRef` from `presentation.ts`. Both directions must be
`import type` so the cycle is erased at runtime (these are all types, never values).

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

`TemplateBuilder<IK, RK, CK extends string = never>` gains the condition methods
(key compile-checked against `CK`; prose optional) and the two conditionless-outcome
fallbacks:

```ts
winWhen(key: CK, narration?: OutcomeNarration): this {
  this.description.winConditions.push({ key, narration });
  return this;
}
loseWhen(key: CK, narration?: OutcomeNarration): this {
  this.description.loseConditions.push({ key, narration });
  return this;
}
onTimeout(narration: OutcomeNarration): this {
  this.description.timeoutNarration = narration;
  return this;
}
onEnd(narration: OutcomeNarration): this {
  this.description.endedNarration = narration;
  return this;
}
```

`CampaignTemplateDescription` gains:

```ts
winConditions: { key: string; narration?: OutcomeNarration }[]; // init []
loseConditions: { key: string; narration?: OutcomeNarration }[]; // init []
timeoutNarration?: OutcomeNarration;
endedNarration?: OutcomeNarration;
```

`authorTemplate`'s return type threads the registry's `ConditionKeyOf` through as
`CK`. Prose is plain authored content, so it is stored verbatim in the description —
only the `key` is registry-validated.

### Assembler (`src/lib/authoring/assembler.ts`)

**Pass 1 (validate-all):** each win/loss key is checked against the registry,
accumulating into the existing `problems[]` / `AuthoringError`:

```ts
const requireConditionKey = (k: string, ctx: string) => {
  try { registry.condition(k); }
  catch { problems.push(`${ctx} references unregistered condition key '${k}'.`); }
};
for (const c of desc.winConditions) requireConditionKey(c.key, "winWhen");
for (const c of desc.loseConditions) requireConditionKey(c.key, "loseWhen");
```

**Pass 2 (construct):** resolve keys to `VictoryCondition` records (carrying the
authored narration verbatim) and pass them, plus the conditionless-outcome prose,
as constructor options:

```ts
const winConditions = desc.winConditions.map((c) => ({
  key: c.key, test: registry.condition(c.key), narration: c.narration,
}));
const loseConditions = desc.loseConditions.map((c) => ({
  key: c.key, test: registry.condition(c.key), narration: c.narration,
}));
const campaign = new Campaign(desc.title, desc.opts.maxRounds ?? 100, [], {
  rng: desc.opts.rng,
  baseEncounterChance: desc.opts.baseEncounterChance,
  winConditions,
  loseConditions,
  timeoutNarration: desc.timeoutNarration,
  endedNarration: desc.endedNarration,
});
```

### Serialization (`src/lib/serialization/types.ts`, `campaign.ts`)

`CampaignCoreSnapshot`. The predicate is behavior (re-attached by key); the
narration is content (persisted verbatim). So each stored condition is
`{ key: string; narration?: OutcomeNarration }` — its `test` is dropped and
re-resolved on hydrate, its prose survives directly:

- **Remove** `finished: boolean`.
- **Add** `outcome: CampaignOutcome`.
- **Add** `outcomeReason?: string`.
- **Add** `winConditions: { key: string; narration?: OutcomeNarration }[]`.
- **Add** `loseConditions: { key: string; narration?: OutcomeNarration }[]`.
- **Add** `timeoutNarration?: OutcomeNarration` and `endedNarration?: OutcomeNarration`.

`OutcomeNarration` is plain JSON data (`text?: string`, `sound?: AssetRef`), so it
needs no special serialization. `SCHEMA_VERSION` bumps **1 → 2**. The
durable-persistence layer already fails-closed on schema mismatch, so pre-existing
v1 snapshots are rejected rather than mis-hydrated (acceptable for the current
pre-release stage).

`[SERIALIZE]()` writes:

```ts
outcome: this.#outcome,
outcomeReason: this.#outcomeReason,
winConditions: this.#winConditions.map((c) => ({ key: c.key, narration: c.narration })),
loseConditions: this.#loseConditions.map((c) => ({ key: c.key, narration: c.narration })),
timeoutNarration: this.#timeoutNarration,
endedNarration: this.#endedNarration,
```

`[HYDRATE_CATALOG](core, registry)` re-resolves predicates by key while restoring
the persisted prose (before any character hydrates, consistent with how it already
restores recipes):

```ts
this.#winConditions = core.winConditions.map((c) => ({
  key: c.key, test: registry.condition(c.key), narration: c.narration,
}));
this.#loseConditions = core.loseConditions.map((c) => ({
  key: c.key, test: registry.condition(c.key), narration: c.narration,
}));
this.#timeoutNarration = core.timeoutNarration;
this.#endedNarration = core.endedNarration;
```

`[HYDRATE](core, ctx)` restores `this.#outcome = core.outcome` and
`this.#outcomeReason = core.outcomeReason` (replacing the old `this.#finished = core.finished`).

---

## Data flow

```
author: authorTemplate(title, registry)
          .winWhen("all-bosses-down", { text: "The seal shatters..." })
          .loseWhen("party-wiped", { text: "Darkness takes you." })
          .onTimeout({ text: "Dawn breaks; the ritual completes without you." })
  -> description holds { key, narration } records + timeout/ended prose
  -> .build() -> assemble():
       pass 1: validate KEYS against registry.condition(key) (prose unchecked)
       pass 2: resolve to VictoryCondition[] (test by key, narration verbatim),
               pass conditions + timeout/ended prose via constructor options
  -> Campaign holds #winConditions / #loseConditions / #timeout+#endedNarration

play: ...nextPlayer() until last party member -> endRound()
  -> round++, resetActivity()
  -> resolveOutcome(): loss list, then win list, then maxRounds -> firing condition
  -> non-ongoing -> #finish(status, condition): set #outcome/#outcomeReason,
       emit "resolution" cue carrying the resolved OutcomeNarration
  -> any surface reads campaign.outcomeNarration (poll) or the cue (push)

persist: [SERIALIZE] writes outcome + condition { key, narration } (NOT predicates)
reload:  deserializeCampaign(data, { registry, rng })
  -> [HYDRATE_CATALOG] re-resolves keys -> predicates; restores prose verbatim
  -> [HYDRATE] restores #outcome -> outcomeNarration reports the same ending
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
- Narration is never validated (it is free authored content). A condition with a
  valid key but no prose simply resolves with `outcomeNarration === undefined`, and
  surfaces fall back to their own generic text.

## Testing

- **`victory.test.ts`** (pure resolver): loss-before-win precedence; both-fire →
  `lost`; win on final round → `won` (not `timed-out`); empty lists + ceiling →
  `timed-out`; empty lists, under ceiling → `ongoing`; the result's `condition`
  carries the firing condition (and thus its narration).
- **`campaign.test.ts`**: `endRound()` resolves `won`/`lost`/`timed-out`; `outcome`
  + `outcomeReason` getters; `finished` derived; `endCampaign()` → `ended`;
  `outcomeNarration` returns the firing condition's prose for won/lost and the
  fallback for timed-out/ended; the resolution cue is emitted exactly once and
  carries that same narration; `#assertRunning` blocks post-resolution turns.
- **Registry / authoring**: `defineRegistry({ conditions })` types `CK`;
  `.winWhen` / `.loseWhen` compile-checked; `.onTimeout` / `.onEnd` set fallbacks;
  assembler rejects unknown keys (but accepts any prose).
- **Serialization round-trip**: a campaign with conditions + prose →
  `serializeCampaign` → `deserializeCampaign` re-attaches predicates (they still
  fire) AND restores narration verbatim (`outcomeNarration` matches pre-reload);
  the `authoring/roundtrip.test.ts` gains a victory-condition case.
- **Integration** (`integration.test.ts`): a full template-authored campaign won
  by reaching a target room, asserting the authored win prose surfaces.

## Documentation

- `README.md`: new "Victory conditions" mechanics section (outcome vocabulary,
  round-end evaluation order, authoring via `.winWhen`/`.loseWhen`/`.onTimeout`/
  `.onEnd`, and the content-vs-presentation stance on outcome prose).
- `docs-site/guide/data-model.md`: the live-campaign ER diagram gains the campaign
  `outcome` field and a `VictoryCondition` relationship (with `narration`); the
  template diagram gains win/loss condition records and the prose fallbacks.
- TSDoc on `CampaignOutcome`, `OutcomeNarration`, `VictoryCondition`,
  `resolveOutcome`, the new getters (incl. `outcomeNarration`), `registerCondition`,
  and `.winWhen`/`.loseWhen`/`.onTimeout`/`.onEnd`.

## File map

| File | Change |
| --- | --- |
| `src/lib/victory.ts` | **new** — `CampaignOutcome`, `OutcomeNarration`, `VictoryCondition`, `OutcomeResult`, `resolveOutcome` |
| `src/lib/victory.test.ts` | **new** — pure resolver tests |
| `src/lib/campaign.ts` | outcome + narration state, constructor opts, getters (incl. `outcomeNarration`), `#finish`, `endRound` hook, serialize/hydrate |
| `src/lib/presentation.ts` | `resolution` cue variant (carries `OutcomeNarration`) |
| `src/lib/serialization/types.ts` | `CampaignCoreSnapshot` fields (condition `{key,narration}` records + prose fallbacks), `SCHEMA_VERSION` 1→2 |
| `src/lib/serialization/registry.ts` | `registerCondition` / `condition` |
| `src/lib/authoring/registry.ts` | `CONDITION_KEYS`, `ConditionKeyOf`, `defineRegistry` conditions |
| `src/lib/authoring/template-builder.ts` | `.winWhen` / `.loseWhen` / `.onTimeout` / `.onEnd`, description fields, `CK` param |
| `src/lib/authoring/assembler.ts` | validate + resolve condition keys, carry narration |
| `README.md`, `docs-site/guide/data-model.md` | mechanics + diagram updates |
