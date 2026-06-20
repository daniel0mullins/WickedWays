# Victory Conditions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve a campaign to an explicit outcome (`won`/`lost`/`timed-out`/`ended`) by evaluating author-defined predicate conditions at the conclusion of every round, with surface-agnostic outcome prose that survives serialization.

**Architecture:** A new pure module `src/lib/victory.ts` holds the outcome vocabulary and a pure `resolveOutcome` function. `Campaign` gains two lists of named `VictoryCondition` predicates (static config, injected via constructor options) plus conditionless-outcome prose, evaluates them at the tail of `endRound()`, and finishes through a single `#finish` path that emits a `resolution` presentation cue. Predicates re-attach by key from the `CampaignRegistry` on reload (the existing recipe/item-factory precedent); the prose serializes as plain data. The fluent authoring builder gains `.winWhen` / `.loseWhen` / `.onTimeout` / `.onEnd`.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`, NodeNext), Vitest, pnpm. Engine in `src/`.

## Global Constraints

- All randomness via injected `rng: () => number`; never call `Math.random()` directly in engine logic. (Victory conditions add no randomness.)
- Illegal lifecycle transitions throw `ProceduralViolation` (from `./util`). Keep this for already-resolved campaigns.
- Branded ids via helpers in `src/lib/brand.d.ts`; never cast raw strings to branded ids.
- Protected state uses exported `Symbol` seams — but victory conditions are **static config set at construction** (like `rng`/`maxRounds`), so they are injected via constructor options, NOT a runtime symbol seam. Do not add a public setter.
- `[SERIALIZE]` / `[HYDRATE]` / `[HYDRATE_CATALOG]` are symbol-keyed engine seams on `Campaign`; they may write private fields directly.
- TypeScript strictness: indexed access yields `T | undefined` — handle it; overrides carry `override`; underscore-prefixed args exempt from unused-vars.
- The `presentation.ts` ↔ `victory.ts` import relationship MUST be `import type` in both directions (all types, no values), so the cycle is erased at runtime.
- Predicates are author code expected to be total; do NOT wrap their calls in try/catch — a throwing predicate propagates out of `endRound()`.
- Loss list is evaluated **before** win list; a maxRounds ceiling resolves to `timed-out` only if no win/loss condition fired this round.
- Run `pnpm checks` (lint + typecheck + test) before declaring the branch done. Per-task, run the named test files plus `pnpm typecheck`.
- After the feature: update `README.md`, `docs-site/guide/data-model.md`, and TSDoc (standing project convention).

---

### Task 1: `victory.ts` — outcome vocabulary + pure resolver

**Files:**
- Create: `src/lib/victory.ts`
- Test: `src/lib/victory.test.ts`

**Interfaces:**
- Consumes: `ICampaign` (type) from `./campaign`; `AssetRef` (type) from `./presentation`.
- Produces:
  - `type CampaignOutcome = "ongoing" | "won" | "lost" | "timed-out" | "ended"`
  - `interface OutcomeNarration { readonly text?: string; readonly sound?: AssetRef }`
  - `interface VictoryCondition { readonly key: string; readonly test: (campaign: ICampaign) => boolean; readonly narration?: OutcomeNarration }`
  - `interface OutcomeResult { readonly status: CampaignOutcome; readonly condition?: VictoryCondition }`
  - `function resolveOutcome(input: { round: number; maxRounds: number; winConditions: readonly VictoryCondition[]; loseConditions: readonly VictoryCondition[]; campaign: ICampaign }): OutcomeResult`

- [ ] **Step 1: Write the failing test**

Create `src/lib/victory.test.ts`. A bare `{}` cast to `ICampaign` is a sufficient stub because the test predicates ignore their argument.

```ts
import { describe, it, expect } from "vitest";
import { resolveOutcome, type VictoryCondition } from "./victory";
import type { ICampaign } from "./campaign";

const campaign = {} as unknown as ICampaign;
const always = (key: string): VictoryCondition => ({ key, test: () => true });
const never = (key: string): VictoryCondition => ({ key, test: () => false });

describe("resolveOutcome", () => {
  it("returns ongoing when no condition fires and the ceiling is not reached", () => {
    const r = resolveOutcome({ round: 3, maxRounds: 10, winConditions: [never("w")], loseConditions: [never("l")], campaign });
    expect(r).toEqual({ status: "ongoing" });
  });

  it("resolves won when a win condition fires, carrying the firing condition", () => {
    const win = always("all-bosses-down");
    const r = resolveOutcome({ round: 3, maxRounds: 10, winConditions: [win], loseConditions: [never("l")], campaign });
    expect(r.status).toBe("won");
    expect(r.condition).toBe(win);
  });

  it("resolves lost and evaluates loss before win when both fire", () => {
    const lose = always("party-wiped");
    const r = resolveOutcome({ round: 3, maxRounds: 10, winConditions: [always("w")], loseConditions: [lose], campaign });
    expect(r.status).toBe("lost");
    expect(r.condition).toBe(lose);
  });

  it("resolves timed-out at the ceiling only when no condition fires", () => {
    const r = resolveOutcome({ round: 10, maxRounds: 10, winConditions: [never("w")], loseConditions: [never("l")], campaign });
    expect(r).toEqual({ status: "timed-out" });
  });

  it("prefers a win on the final round over the timeout", () => {
    const win = always("escape");
    const r = resolveOutcome({ round: 10, maxRounds: 10, winConditions: [win], loseConditions: [never("l")], campaign });
    expect(r.status).toBe("won");
    expect(r.condition).toBe(win);
  });

  it("returns the first firing condition in list order", () => {
    const first = always("a");
    const second = always("b");
    const r = resolveOutcome({ round: 1, maxRounds: 10, winConditions: [first, second], loseConditions: [], campaign });
    expect(r.condition).toBe(first);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/lib/victory.test.ts`
Expected: FAIL — `Cannot find module './victory'` / `resolveOutcome is not a function`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/victory.ts`:

```ts
import type { ICampaign } from "./campaign";
import type { AssetRef } from "./presentation";

/** How a campaign ended, or that it is still running. */
export type CampaignOutcome =
  | "ongoing"
  | "won"
  | "lost"
  | "timed-out"
  | "ended";

/**
 * Surface-agnostic authored prose for an outcome. Plain data — it serializes
 * natively (unlike a predicate) and any play surface renders it however it
 * likes. `sound` reuses the engine's existing {@link AssetRef} convention, so
 * no new presentation type is introduced.
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
  /** Never "ended" — that is the manual {@link ICampaign.endCampaign} path. */
  readonly status: CampaignOutcome;
  /** The condition that fired (for "won"/"lost"); absent otherwise. */
  readonly condition?: VictoryCondition;
}

/**
 * Pure round-end resolution. Loss conditions are evaluated before win
 * conditions; the maxRounds ceiling resolves to "timed-out" only if no
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

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/lib/victory.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/victory.ts src/lib/victory.test.ts
git commit -m "feat(victory): outcome vocabulary and pure round-end resolver"
```

---

### Task 2: `CampaignRegistry` condition registration

**Files:**
- Modify: `src/lib/serialization/registry.ts:28-84`
- Test: `src/lib/serialization/registry.test.ts` (create if absent)

**Interfaces:**
- Consumes: `ICampaign` (type, already imported in this file); `ProceduralViolation` (already imported).
- Produces, on `CampaignRegistry`:
  - `registerCondition(key: string, predicate: (campaign: ICampaign) => boolean): void`
  - `condition(key: string): (campaign: ICampaign) => boolean` — throws `ProceduralViolation` `No condition registered for key '<key>'.` if absent.

- [ ] **Step 1: Write the failing test**

Create (or append to) `src/lib/serialization/registry.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { CampaignRegistry } from "./registry";
import type { ICampaign } from "../campaign";

describe("CampaignRegistry conditions", () => {
  it("registers and resolves a condition predicate by key", () => {
    const reg = new CampaignRegistry();
    const pred = (_c: ICampaign) => true;
    reg.registerCondition("all-bosses-down", pred);
    expect(reg.condition("all-bosses-down")).toBe(pred);
  });

  it("throws a ProceduralViolation for an unregistered condition key", () => {
    const reg = new CampaignRegistry();
    expect(() => reg.condition("missing")).toThrow(/No condition registered for key 'missing'\./);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/lib/serialization/registry.test.ts`
Expected: FAIL — `reg.registerCondition is not a function`.

- [ ] **Step 3: Add the conditions map, registrar, and lookup**

In `src/lib/serialization/registry.ts`, add the field alongside the others (after line 32 `#items = ...`):

```ts
  #conditions = new Map<string, (campaign: ICampaign) => boolean>();
```

Add the registrar after `registerItem` (after line 63):

```ts
  /**
   * Registers a victory/defeat predicate under `key`.
   * Must match the condition key referenced by a campaign template / snapshot.
   */
  registerCondition(key: string, predicate: (campaign: ICampaign) => boolean): void {
    this.#conditions.set(key, predicate);
  }
```

Add the lookup after `item(...)` (after line 76):

```ts
  condition(key: string): (campaign: ICampaign) => boolean {
    return this.#require(this.#conditions.get(key), "condition", key);
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/lib/serialization/registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/serialization/registry.ts src/lib/serialization/registry.test.ts
git commit -m "feat(serialization): register and resolve victory-condition predicates by key"
```

---

### Task 3: Campaign outcome state, round-end resolution, cue, and serialization

This task couples campaign behavior with its serialize/hydrate seams and the snapshot type, because removing `#finished` forces all three to change together.

**Files:**
- Modify: `src/lib/presentation.ts:27-30` (add the `resolution` cue)
- Modify: `src/lib/serialization/types.ts:10` (SCHEMA_VERSION) and `:91-109` (`CampaignCoreSnapshot`)
- Modify: `src/lib/campaign.ts` — imports (`:10-25`), `ICampaign` (`:52-75`), fields (`:135-143`), getters (`:172-179`), `#assertRunning` (`:224-231`), constructor (`:239-271`), `endCampaign` (`:305-308`), `endRound` (`:317-331`), `[SERIALIZE]` (`:617-639`), `[HYDRATE_CATALOG]` (`:646-656`), `[HYDRATE]` (`:664-687`)
- Modify (test helper): `src/lib/sync/delta-computer.test.ts:8-28` (`baseCore`)
- Modify (test helper): `src/lib/serialization/roundtrip.test.ts:41` (schemaVersion expectation)
- Test: `src/lib/campaign.test.ts` (append a victory-conditions describe block)
- Test: `src/lib/serialization/roundtrip.test.ts` (append an outcome round-trip test)

**Interfaces:**
- Consumes: `resolveOutcome`, `CampaignOutcome`, `OutcomeNarration`, `VictoryCondition` from `./victory` (Task 1); `registry.condition(key)` from `CampaignRegistry` (Task 2).
- Produces:
  - Constructor `options` gains `winConditions?: VictoryCondition[]`, `loseConditions?: VictoryCondition[]`, `timeoutNarration?: OutcomeNarration`, `endedNarration?: OutcomeNarration`.
  - Getters `get outcome(): CampaignOutcome`, `get outcomeReason(): string | undefined`, `get outcomeNarration(): OutcomeNarration | undefined`; `get finished(): boolean` now derived.
  - `PresentationCue` gains `{ kind: "resolution"; outcome: CampaignOutcome; reason?: string; narration?: OutcomeNarration }`.
  - `CampaignCoreSnapshot`: removes `finished`; adds `outcome`, `outcomeReason?`, `winConditions: { key: string; narration?: OutcomeNarration }[]`, `loseConditions: { key: string; narration?: OutcomeNarration }[]`, `timeoutNarration?`, `endedNarration?`. `SCHEMA_VERSION` → `2`.

- [ ] **Step 1: Add the `resolution` cue variant**

In `src/lib/presentation.ts`, add a type-only import at the top (after line 1):

```ts
import type { CampaignOutcome, OutcomeNarration } from "./victory";
```

Extend the `PresentationCue` union (currently lines 27-30) — add the fourth member:

```ts
export type PresentationCue =
  | { kind: "action"; action: ActionKind; actor: EntityRef; sound?: AssetRef }
  | { kind: "encounter"; mob: EntityRef; room: EntityRef; sound?: AssetRef }
  | { kind: "visibility"; room: EntityRef; lit: boolean }
  | { kind: "resolution"; outcome: CampaignOutcome; reason?: string; narration?: OutcomeNarration };
```

- [ ] **Step 2: Update the snapshot type and bump the schema version**

In `src/lib/serialization/types.ts`, add a type-only import (after line 8):

```ts
import type { CampaignOutcome, OutcomeNarration } from "../victory";
```

Change line 10:

```ts
export const SCHEMA_VERSION = 2;
```

Replace the `CampaignCoreSnapshot` interface body (lines 91-109) — remove `finished`, add the outcome/condition/prose fields:

```ts
export interface CampaignCoreSnapshot {
  id: string;
  title: string;
  maxRounds: number;
  round: number;
  started: boolean;
  outcome: CampaignOutcome;
  outcomeReason?: string;
  /** Win conditions as { registry key, authored prose } — the predicate is re-attached by key. */
  winConditions: { key: string; narration?: OutcomeNarration }[];
  /** Loss conditions as { registry key, authored prose }. */
  loseConditions: { key: string; narration?: OutcomeNarration }[];
  /** Fallback prose for the conditionless `timed-out` outcome. */
  timeoutNarration?: OutcomeNarration;
  /** Fallback prose for the conditionless `ended` (manual) outcome. */
  endedNarration?: OutcomeNarration;
  activeCharacterIndex: number;
  partyIds: string[];
  actedThisRound: string[];
  gmId: string | null;
  materials: MaterialMap;
  claims: string[];
  encountered: string[];
  knownRecipes: string[]; // registry keys
  archetypes: Archetype[]; // pure data
  actionSounds: Partial<Record<ActionKind, AssetRef>>;
  encounterTable: EncounterTableSnapshot;
}
```

- [ ] **Step 3: Update campaign imports and fields**

In `src/lib/campaign.ts`, extend the victory import. Add after line 25:

```ts
import { resolveOutcome } from "./victory";
import type { CampaignOutcome, OutcomeNarration, VictoryCondition } from "./victory";
```

Replace the two lifecycle-state fields (lines 135-136, `#started = false;` / `#finished = false;`). Keep `#started`, drop `#finished`, add the outcome + condition + prose fields:

```ts
  #started = false;
  #outcome: CampaignOutcome = "ongoing";
  #outcomeReason: string | undefined = undefined;
  #winConditions: VictoryCondition[] = [];
  #loseConditions: VictoryCondition[] = [];
  #timeoutNarration: OutcomeNarration | undefined = undefined;
  #endedNarration: OutcomeNarration | undefined = undefined;
```

- [ ] **Step 4: Replace the `finished` getter with derived outcome getters**

Replace lines 176-179 (the `finished` getter) with:

```ts
  /** The resolved outcome, or "ongoing" while the campaign is still in play. */
  get outcome(): CampaignOutcome {
    return this.#outcome;
  }

  /** Registry key of the win/loss condition that fired, if any. */
  get outcomeReason(): string | undefined {
    return this.#outcomeReason;
  }

  /**
   * Authored prose for the resolved outcome, available to any play surface
   * whether it listens to the resolution cue or polls. Derived, so a reloaded
   * finished campaign reports the same ending.
   */
  get outcomeNarration(): OutcomeNarration | undefined {
    switch (this.#outcome) {
      case "timed-out":
        return this.#timeoutNarration;
      case "ended":
        return this.#endedNarration;
      case "won":
      case "lost": {
        const list = this.#outcome === "won" ? this.#winConditions : this.#loseConditions;
        return list.find((c) => c.key === this.#outcomeReason)?.narration;
      }
      default:
        return undefined; // ongoing
    }
  }

  /** Whether the campaign has ended (won, lost, timed out, or manually ended). */
  get finished(): boolean {
    return this.#outcome !== "ongoing";
  }
```

- [ ] **Step 5: Update `#assertRunning` to check the outcome**

Replace the body of `#assertRunning` (lines 224-231):

```ts
  #assertRunning() {
    if (!this.#started) {
      throw new ProceduralViolation("Campaign has not begun");
    }
    if (this.#outcome !== "ongoing") {
      throw new ProceduralViolation("Campaign has already finished");
    }
  }
```

- [ ] **Step 6: Accept the new constructor options**

Extend the constructor `options` type (lines 243-247) and store the new fields. The options object becomes:

```ts
    options: {
      rng?: () => number;
      baseEncounterChance?: number;
      actionSounds?: Partial<Record<ActionKind, AssetRef>>;
      winConditions?: VictoryCondition[];
      loseConditions?: VictoryCondition[];
      timeoutNarration?: OutcomeNarration;
      endedNarration?: OutcomeNarration;
    } = {},
```

In the constructor body, after `this.#actionSounds = options.actionSounds ?? {};` (line 266) add:

```ts
    this.#winConditions = [...(options.winConditions ?? [])];
    this.#loseConditions = [...(options.loseConditions ?? [])];
    this.#timeoutNarration = options.timeoutNarration;
    this.#endedNarration = options.endedNarration;
```

- [ ] **Step 7: Add `#finish`, route `endCampaign` through it, and resolve in `endRound`**

Replace `endCampaign` (lines 305-308) with a `#finish` helper plus the public method:

```ts
  // Centralized termination: set the outcome, record the firing key, and emit a
  // single resolution cue carrying the resolved prose. The only writer of #outcome.
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

  /**
   * Manually ends a running campaign with the `ended` outcome (a deliberate GM
   * stop, distinct from a win/loss/timeout).
   * @throws {@link ProceduralViolation} if the campaign is not currently running.
   */
  endCampaign() {
    this.#assertRunning();
    this.#finish("ended");
  }
```

Replace `endRound` (lines 317-331) — fold the maxRounds ceiling into `resolveOutcome`:

```ts
  /**
   * Advances to the next round once every party member has acted, then resolves
   * the campaign against its victory conditions and the maxRounds ceiling.
   *
   * @throws {@link ProceduralViolation} if not running, or if called before all
   *   characters have acted this round.
   */
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

- [ ] **Step 8: Add the outcome getters to the `ICampaign` interface**

In the `ICampaign` interface, replace the `finished` getter declaration (lines 54-55) with:

```ts
  /** Whether the campaign has ended (won, lost, timed out, or manually ended). */
  get finished(): boolean;
  /** The resolved outcome, or "ongoing" while still in play. */
  get outcome(): CampaignOutcome;
  /** Registry key of the win/loss condition that fired, if any. */
  get outcomeReason(): string | undefined;
  /** Authored prose for the resolved outcome (text + optional sound), if any. */
  get outcomeNarration(): OutcomeNarration | undefined;
```

- [ ] **Step 9: Update `[SERIALIZE]` to write outcome + condition keys + prose**

In `[SERIALIZE]` (lines 617-639), replace the `finished: this.#finished,` line with:

```ts
      outcome: this.#outcome,
      outcomeReason: this.#outcomeReason,
      winConditions: this.#winConditions.map((c) => ({ key: c.key, narration: c.narration })),
      loseConditions: this.#loseConditions.map((c) => ({ key: c.key, narration: c.narration })),
      timeoutNarration: this.#timeoutNarration,
      endedNarration: this.#endedNarration,
```

- [ ] **Step 10: Re-resolve predicates + restore prose in `[HYDRATE_CATALOG]`, restore outcome in `[HYDRATE]`**

In `[HYDRATE_CATALOG]` (lines 646-656), after the recipe loop (after line 655 `}`) and before the closing brace, add:

```ts
    this.#winConditions = core.winConditions.map((c) => ({
      key: c.key,
      test: registry.condition(c.key),
      narration: c.narration,
    }));
    this.#loseConditions = core.loseConditions.map((c) => ({
      key: c.key,
      test: registry.condition(c.key),
      narration: c.narration,
    }));
    this.#timeoutNarration = core.timeoutNarration;
    this.#endedNarration = core.endedNarration;
```

In `[HYDRATE]` (lines 664-687), replace `this.#finished = core.finished;` (line 667) with:

```ts
    this.#outcome = core.outcome;
    this.#outcomeReason = core.outcomeReason;
```

- [ ] **Step 11: Fix the hand-built snapshot helper in `delta-computer.test.ts`**

In `src/lib/sync/delta-computer.test.ts`, in `baseCore()` (lines 9-27) replace `finished: false,` (line 15) with:

```ts
    outcome: "ongoing",
    winConditions: [],
    loseConditions: [],
```

- [ ] **Step 12: Update the schemaVersion expectation in `roundtrip.test.ts`**

In `src/lib/serialization/roundtrip.test.ts`, change line 41 from `expect(snap.schemaVersion).toBe(1);` to:

```ts
    expect(snap.schemaVersion).toBe(2);
```

- [ ] **Step 13: Write the campaign behavior tests**

Append to `src/lib/campaign.test.ts` a describe block. Use the file's existing helpers for building a started campaign (`makeRng`, `assignNeutralArchetype`, the existing player/PC construction pattern — read the top of `campaign.test.ts` and mirror how other tests build a 1-PC started campaign). The conditions are injected via constructor options. Reference shape:

```ts
import { resolveOutcome } from "./victory"; // only if needed; tests below drive Campaign directly
import { EMIT_CUE } from "./presentation";
import type { PresentationCue } from "./presentation";
import type { VictoryCondition } from "./victory";

describe("victory conditions", () => {
  // Build a started 1-PC campaign whose single player has already acted, so a
  // single nextPlayer() closes the round. Mirror the existing started-campaign
  // setup in this file (party of one, GM = that PC, neutral archetype, begin).
  function startedSoloCampaign(opts?: {
    winConditions?: VictoryCondition[];
    loseConditions?: VictoryCondition[];
    timeoutNarration?: { text?: string };
    endedNarration?: { text?: string };
  }): Campaign {
    const campaign = new Campaign("T", 5, [], { rng: makeRng(1), ...opts });
    const pc = /* construct a PlayerCharacter as elsewhere in this file */;
    campaign.party.push(pc);
    campaign.gm = pc;
    assignNeutralArchetype(campaign, pc);
    campaign.beginCampaign();
    return campaign;
  }

  it("resolves won when a win condition fires at round end, with prose", () => {
    const win: VictoryCondition = { key: "w", test: () => true, narration: { text: "You win." } };
    const campaign = startedSoloCampaign({ winConditions: [win] });
    campaign.nextPlayer(); // closes round 0 -> round 1, resolves
    expect(campaign.outcome).toBe("won");
    expect(campaign.outcomeReason).toBe("w");
    expect(campaign.outcomeNarration).toEqual({ text: "You win." });
    expect(campaign.finished).toBe(true);
  });

  it("evaluates loss before win", () => {
    const campaign = startedSoloCampaign({
      winConditions: [{ key: "w", test: () => true }],
      loseConditions: [{ key: "l", test: () => true, narration: { text: "You die." } }],
    });
    campaign.nextPlayer();
    expect(campaign.outcome).toBe("lost");
    expect(campaign.outcomeNarration).toEqual({ text: "You die." });
  });

  it("resolves timed-out at maxRounds with the fallback prose", () => {
    const campaign = new Campaign("T", 1, [], { rng: makeRng(1), timeoutNarration: { text: "Dawn breaks." } });
    const pc = /* build + begin a solo campaign as above, but maxRounds = 1 */;
    // ...begin, then close one round:
    campaign.nextPlayer();
    expect(campaign.outcome).toBe("timed-out");
    expect(campaign.outcomeNarration).toEqual({ text: "Dawn breaks." });
  });

  it("emits exactly one resolution cue carrying the outcome and prose", () => {
    const cues: PresentationCue[] = [];
    const win: VictoryCondition = { key: "w", test: () => true, narration: { text: "Victory!" } };
    const campaign = startedSoloCampaign({ winConditions: [win] });
    campaign.onCue((c) => cues.push(c));
    campaign.nextPlayer();
    const resolutions = cues.filter((c) => c.kind === "resolution");
    expect(resolutions).toHaveLength(1);
    expect(resolutions[0]).toEqual({ kind: "resolution", outcome: "won", reason: "w", narration: { text: "Victory!" } });
  });

  it("ends manually with the ended outcome and prose", () => {
    const campaign = startedSoloCampaign({ endedNarration: { text: "Session over." } });
    campaign.endCampaign();
    expect(campaign.outcome).toBe("ended");
    expect(campaign.outcomeNarration).toEqual({ text: "Session over." });
  });

  it("blocks turn advances after resolution", () => {
    const campaign = startedSoloCampaign({ winConditions: [{ key: "w", test: () => true }] });
    campaign.nextPlayer();
    expect(() => campaign.endRound()).toThrow(/already finished/);
  });
});
```

NOTE TO IMPLEMENTER: the `/* construct a PlayerCharacter */` placeholders mean "copy the exact started-campaign construction already used by neighboring tests in `campaign.test.ts`" — do not invent a new construction path. The asserted values above (keys `"w"`/`"l"`, prose strings, `maxRounds` 1 and 5) are the exact values to use.

- [ ] **Step 14: Write the outcome serialization round-trip test**

Append to `src/lib/serialization/roundtrip.test.ts`. Build a campaign with a registered condition, drive it to a win, serialize, deserialize with a registry that has the condition, and assert the outcome + prose survive and the predicate is re-attached. Mirror the file's existing `buildSerializableCampaign` / serialize+deserialize pattern:

```ts
it("round-trips a resolved outcome, re-attaching the predicate and restoring prose", () => {
  const registry = new CampaignRegistry(); // plus whatever item/recipe registration the existing helper needs
  registry.registerCondition("w", () => true);
  // Build a started solo campaign with the win condition, drive nextPlayer() to win.
  // (Reuse the file's started-campaign helper; inject winConditions via constructor options.)
  // const campaign = ...; campaign.nextPlayer();
  expect(campaign.outcome).toBe("won");

  const snap = serializeCampaign(campaign);
  const restored = deserializeCampaign(snap, { registry });
  expect(restored.outcome).toBe("won");
  expect(restored.outcomeReason).toBe("w");
  expect(restored.outcomeNarration).toEqual({ text: "You win." });
});
```

NOTE TO IMPLEMENTER: register `"w"` as `() => true` and author its narration `{ text: "You win." }` via the constructor `winConditions` option. If the existing helper does not expose a started campaign, build one inline mirroring `campaign.test.ts`.

- [ ] **Step 15: Run the touched test files**

Run: `pnpm vitest run src/lib/campaign.test.ts src/lib/serialization/roundtrip.test.ts src/lib/sync/delta-computer.test.ts src/lib/victory.test.ts`
Expected: PASS.

- [ ] **Step 16: Typecheck the whole engine**

Run: `pnpm typecheck`
Expected: no errors. (Confirms `sync/resolver.ts`'s `campaign.finished` reads still compile against the derived getter, and no other consumer referenced the removed `finished` snapshot field.)

- [ ] **Step 17: Commit**

```bash
git add src/lib/presentation.ts src/lib/serialization/types.ts src/lib/campaign.ts src/lib/campaign.test.ts src/lib/serialization/roundtrip.test.ts src/lib/sync/delta-computer.test.ts
git commit -m "feat(campaign): resolve outcomes at round end with persisted victory conditions"
```

---

### Task 4: Typed authoring registry — conditions

**Files:**
- Modify: `src/lib/authoring/registry.ts`
- Test: `src/lib/authoring/registry.test.ts` (create if absent)

**Interfaces:**
- Consumes: `CampaignRegistry.registerCondition` (Task 2); `ICampaign` (type).
- Produces:
  - `TypedRegistry<IK extends string, RK extends string, CK extends string = never>` (third, defaulted param).
  - `ConditionKeyOf<R>`.
  - `defineRegistry(defs: { items; recipes?; scenes?; formations?; conditions? })` now infers and carries `CK = keyof C & string`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/authoring/registry.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { defineRegistry } from "./registry";
import type { ICampaign } from "../campaign";

describe("defineRegistry conditions", () => {
  it("registers condition predicates on the underlying registry", () => {
    const reg = defineRegistry({
      items: {},
      conditions: { "all-bosses-down": (_c: ICampaign) => true },
    });
    expect(reg.condition("all-bosses-down")(/* campaign */ {} as ICampaign)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/lib/authoring/registry.test.ts`
Expected: FAIL — `conditions` not accepted / not registered.

- [ ] **Step 3: Add the phantom key, the helper type, and the third generic**

Replace `src/lib/authoring/registry.ts` in full:

```ts
import { CampaignRegistry, type SceneBehavior, type FormationBehavior } from "../serialization/registry";
import type { Item } from "../inventory";
import type { CraftingRecipe } from "../crafting";
import type { ICampaign } from "../campaign";

declare const ITEM_KEYS: unique symbol;
declare const RECIPE_KEYS: unique symbol;
declare const CONDITION_KEYS: unique symbol;

/** A {@link CampaignRegistry} whose item/recipe/condition key literals are carried in the type (phantom — no runtime field). */
export type TypedRegistry<IK extends string, RK extends string, CK extends string = never> = CampaignRegistry & {
  readonly [ITEM_KEYS]?: IK;
  readonly [RECIPE_KEYS]?: RK;
  readonly [CONDITION_KEYS]?: CK;
};

/** The registered item-factory key union of a {@link TypedRegistry} (falls back to `string`). */
export type ItemKeyOf<R> = R extends { readonly [ITEM_KEYS]?: infer K extends string } ? K : string;
/** The registered recipe key union of a {@link TypedRegistry} (falls back to `string`). */
export type RecipeKeyOf<R> = R extends { readonly [RECIPE_KEYS]?: infer K extends string } ? K : string;
/** The registered condition key union of a {@link TypedRegistry} (falls back to `string`). */
export type ConditionKeyOf<R> = R extends { readonly [CONDITION_KEYS]?: infer K extends string } ? K : string;

/**
 * Defines a campaign registry from a const map of behaviors. Builds a normal
 * runtime {@link CampaignRegistry} (consumed unchanged by the server / Authority /
 * serialization) but returns it typed as a {@link TypedRegistry} carrying the
 * inferred item/recipe/condition key literals, so the builder can compile-time-check
 * every key argument.
 */
export function defineRegistry<
  I extends Record<string, () => Item>,
  R extends Record<string, CraftingRecipe> = Record<string, never>,
  C extends Record<string, (campaign: ICampaign) => boolean> = Record<string, never>,
>(defs: {
  items: I;
  recipes?: R;
  scenes?: Record<string, SceneBehavior>;
  formations?: Record<string, FormationBehavior>;
  conditions?: C;
}): TypedRegistry<keyof I & string, keyof R & string, keyof C & string> {
  const reg = new CampaignRegistry();
  for (const [key, factory] of Object.entries(defs.items)) reg.registerItem(key, factory);
  for (const [key, recipe] of Object.entries(defs.recipes ?? {})) reg.registerRecipe(key, recipe);
  for (const [key, scene] of Object.entries(defs.scenes ?? {})) reg.registerScene(key, scene);
  for (const [key, formation] of Object.entries(defs.formations ?? {})) reg.registerFormation(key, formation);
  for (const [key, predicate] of Object.entries(defs.conditions ?? {})) reg.registerCondition(key, predicate);
  return reg as TypedRegistry<keyof I & string, keyof R & string, keyof C & string>;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/lib/authoring/registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck (confirms existing `TypedRegistry<IK, RK>` call sites still compile via the defaulted `CK`)**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/authoring/registry.ts src/lib/authoring/registry.test.ts
git commit -m "feat(authoring): defineRegistry conditions with typed condition keys"
```

---

### Task 5: Template builder, description, and assembler — authoring conditions

**Files:**
- Modify: `src/lib/authoring/description.ts:67-86` (`CampaignTemplateDescription`)
- Modify: `src/lib/authoring/template-builder.ts` (class generics `:29`, description init `:37-49`, new methods, `authorTemplate` `:169-175`)
- Modify: `src/lib/authoring/assembler.ts` (validation `:60-84`, construction `:89-92`)
- Test: `src/lib/authoring/victory.test.ts` (create) and append a case to `src/lib/authoring/roundtrip.test.ts`

**Interfaces:**
- Consumes: `VictoryCondition`/`OutcomeNarration` (Task 1); constructor options `winConditions`/`loseConditions`/`timeoutNarration`/`endedNarration` (Task 3); `ConditionKeyOf` + typed registry (Task 4); `registry.condition(key)` (Task 2).
- Produces: builder methods `.winWhen(key, narration?)`, `.loseWhen(key, narration?)`, `.onTimeout(narration)`, `.onEnd(narration)`; `authorTemplate` returns `TemplateBuilder<ItemKeyOf<R>, RecipeKeyOf<R>, ConditionKeyOf<R>>`.

- [ ] **Step 1: Extend `CampaignTemplateDescription`**

In `src/lib/authoring/description.ts`, add a type-only import (after line 4):

```ts
import type { OutcomeNarration } from "../victory";
```

Add fields to `CampaignTemplateDescription` (after the `recipes` field, line 83):

```ts
  /** Win conditions: registry condition keys + optional authored prose. */
  winConditions: { key: string; narration?: OutcomeNarration }[];
  /** Loss conditions: registry condition keys + optional authored prose. */
  loseConditions: { key: string; narration?: OutcomeNarration }[];
  /** Fallback prose for the conditionless `timed-out` outcome. */
  timeoutNarration?: OutcomeNarration;
  /** Fallback prose for the conditionless `ended` (manual) outcome. */
  endedNarration?: OutcomeNarration;
```

- [ ] **Step 2: Write the failing builder/assembler tests**

Create `src/lib/authoring/victory.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { authorTemplate } from "./template-builder";
import { defineRegistry } from "./registry";
import { AuthoringError } from "./errors";
import type { ICampaign } from "../campaign";

const registry = defineRegistry({
  items: {},
  conditions: {
    "reached-exit": (c: ICampaign) => c.round >= 1,
    "party-wiped": (_c: ICampaign) => false,
  },
});

describe("authoring victory conditions", () => {
  it("attaches win/loss conditions and outcome prose to the built campaign", () => {
    const campaign = authorTemplate("Escape", registry)
      .room("start", { description: "the cell" })
      .startRoom("start")
      .winWhen("reached-exit", { text: "You slip into the night." })
      .loseWhen("party-wiped", { text: "The dark swallows you." })
      .onTimeout({ text: "Dawn finds you still trapped." })
      .onEnd({ text: "The tale is set aside." })
      .build();

    // Drive to a win: a player-less template has no party, so assert via a
    // resolved campaign requires a session; here we assert the conditions exist
    // by serializing and checking the snapshot carries the keys + prose.
    const snap = authorTemplate("Escape", registry)
      .room("start", { description: "the cell" })
      .startRoom("start")
      .winWhen("reached-exit", { text: "You slip into the night." })
      .toSnapshot();
    expect(snap.campaign.winConditions).toEqual([{ key: "reached-exit", narration: { text: "You slip into the night." } }]);
    expect(campaign.title).toBe("Escape");
  });

  it("rejects an unregistered condition key at assemble time", () => {
    expect(() =>
      authorTemplate("Bad", registry)
        .room("start", { description: "x" })
        .startRoom("start")
        // @ts-expect-error unknown condition key is a compile error too
        .winWhen("nope")
        .build(),
    ).toThrow(AuthoringError);
  });
});
```

NOTE: The `toSnapshot()` assertion exercises that conditions reach the snapshot through `[SERIALIZE]`. The negative test relies on the assembler's runtime guard AND `@ts-expect-error` documents the compile-time guard.

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run src/lib/authoring/victory.test.ts`
Expected: FAIL — `.winWhen is not a function`.

- [ ] **Step 4: Add the builder generics, description init, and methods**

In `src/lib/authoring/template-builder.ts`:

Add type-only import (after line 10):

```ts
import type { ItemKeyOf, RecipeKeyOf, ConditionKeyOf } from "./registry";
import type { OutcomeNarration } from "../victory";
```

(Replace the existing `import type { ItemKeyOf, RecipeKeyOf } from "./registry";` line with the first line above.)

Change the class declaration (line 29) to add `CK`:

```ts
export class TemplateBuilder<IK extends string, RK extends string, CK extends string = never> {
```

In the constructor's `this.description = { ... }` initializer (lines 37-49), add the new fields after `materials: [],`:

```ts
      winConditions: [],
      loseConditions: [],
      timeoutNarration: undefined,
      endedNarration: undefined,
```

Add the four methods after `recipe` (after line 134):

```ts
  /** Add a win condition (registry key) with optional surface-agnostic prose. */
  winWhen(key: CK, narration?: OutcomeNarration): this {
    this.description.winConditions.push({ key, narration });
    return this;
  }

  /** Add a loss condition (registry key) with optional surface-agnostic prose. */
  loseWhen(key: CK, narration?: OutcomeNarration): this {
    this.description.loseConditions.push({ key, narration });
    return this;
  }

  /** Set the fallback prose shown when the campaign times out at maxRounds. */
  onTimeout(narration: OutcomeNarration): this {
    this.description.timeoutNarration = narration;
    return this;
  }

  /** Set the fallback prose shown when the GM manually ends the campaign. */
  onEnd(narration: OutcomeNarration): this {
    this.description.endedNarration = narration;
    return this;
  }
```

Update `authorTemplate` (lines 169-175) to thread `ConditionKeyOf`:

```ts
export function authorTemplate<R extends CampaignRegistry>(
  title: string,
  registry: R,
  opts?: { rng?: () => number; maxRounds?: number; baseEncounterChance?: number },
): TemplateBuilder<ItemKeyOf<R>, RecipeKeyOf<R>, ConditionKeyOf<R>> {
  return new TemplateBuilder<ItemKeyOf<R>, RecipeKeyOf<R>, ConditionKeyOf<R>>(title, registry, opts);
}
```

- [ ] **Step 5: Validate + resolve conditions in the assembler**

In `src/lib/authoring/assembler.ts`, add the condition-key validation in Pass 1, after the recipe validation loop (after line 84, before `if (problems.length > 0)`):

```ts
  const requireConditionKey = (k: string, ctx: string) => {
    try {
      registry.condition(k);
    } catch {
      problems.push(`${ctx} references unregistered condition key '${k}'.`);
    }
  };
  for (const c of desc.winConditions) requireConditionKey(c.key, "winWhen");
  for (const c of desc.loseConditions) requireConditionKey(c.key, "loseWhen");
```

In Pass 2, replace the `Campaign` construction (lines 89-92) so it resolves and passes the conditions + prose:

```ts
  const winConditions = desc.winConditions.map((c) => ({
    key: c.key,
    test: registry.condition(c.key),
    narration: c.narration,
  }));
  const loseConditions = desc.loseConditions.map((c) => ({
    key: c.key,
    test: registry.condition(c.key),
    narration: c.narration,
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

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm vitest run src/lib/authoring/victory.test.ts`
Expected: PASS.

- [ ] **Step 7: Add an authoring round-trip case**

Append to `src/lib/authoring/roundtrip.test.ts` a test that authors a template with a win condition + prose, takes `.toSnapshot()`, and deserializes it with the same registry, asserting the predicate re-attaches and the prose survives:

```ts
it("round-trips an authored template's victory conditions and prose", () => {
  const registry = defineRegistry({
    items: {},
    conditions: { "reached-exit": (_c) => true },
  });
  const snap = authorTemplate("Escape", registry)
    .room("start", { description: "the cell" })
    .startRoom("start")
    .winWhen("reached-exit", { text: "Free at last." })
    .toSnapshot();

  const restored = deserializeCampaign(snap, { registry });
  expect(restored.outcome).toBe("ongoing"); // template not yet played
  // The predicate re-attached: serialize again and the key survives.
  const re = serializeCampaign(restored, { rootRooms: [/* template has rooms; reuse the helper pattern */] });
  expect(re.campaign.winConditions).toEqual([{ key: "reached-exit", narration: { text: "Free at last." } }]);
});
```

NOTE TO IMPLEMENTER: a deserialized player-less campaign re-serializes empty unless `rootRooms` is supplied (see `serializer.ts` remarks). If supplying `rootRooms` is awkward here, instead assert re-attachment by checking `restored.outcomeNarration` after driving a session, OR simply assert that `deserializeCampaign` does not throw (which proves `registry.condition("reached-exit")` resolved). Keep the assertion you can make cleanly; the key requirement is that deserialize re-attaches the predicate by key without throwing.

- [ ] **Step 8: Run the authoring tests**

Run: `pnpm vitest run src/lib/authoring/`
Expected: PASS.

- [ ] **Step 9: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add src/lib/authoring/description.ts src/lib/authoring/template-builder.ts src/lib/authoring/assembler.ts src/lib/authoring/victory.test.ts src/lib/authoring/roundtrip.test.ts
git commit -m "feat(authoring): winWhen/loseWhen/onTimeout/onEnd with validated condition keys"
```

---

### Task 6: Integration test + documentation

**Files:**
- Test: `src/integration.test.ts` (append)
- Modify: `README.md` (new mechanics section)
- Modify: `docs-site/guide/data-model.md` (both ER diagrams)

**Interfaces:**
- Consumes: the full authoring + outcome stack from Tasks 1-5.

- [ ] **Step 1: Write an integration test for an authored campaign reaching a win**

Append to `src/integration.test.ts` a test that authors a template with a win condition keyed to a game state (e.g. the active player's room), starts a session with a player, plays until the condition holds, ends the round, and asserts `campaign.outcome === "won"` and the authored prose surfaces. Mirror the existing integration-test setup for building/starting a campaign with a player (read the top of `src/integration.test.ts` for the established `startSession`/join/begin pattern). Use a condition like:

```ts
// win when the (only) player is in the "exit" room
conditions: { "reached-exit": (c: ICampaign) => c.party[0]?.currentRoom?.name === "exit" }
```

Drive the player to the `exit` room, then close the round via `nextPlayer()`/`endRound()` (whichever the established pattern uses), and assert:

```ts
expect(campaign.outcome).toBe("won");
expect(campaign.outcomeReason).toBe("reached-exit");
expect(campaign.outcomeNarration?.text).toBe("You escape into the night.");
```

NOTE TO IMPLEMENTER: author the win narration as `{ text: "You escape into the night." }`. Use the exact room name `"exit"` in both the room definition and the predicate.

- [ ] **Step 2: Run the integration test**

Run: `pnpm vitest run src/integration.test.ts`
Expected: PASS.

- [ ] **Step 3: Add the README mechanics section**

In `README.md`, add a "Victory conditions" section near the campaign-turn-loop / lifecycle material. Cover, in prose consistent with the file's existing voice:
- The outcome vocabulary: `ongoing` / `won` / `lost` / `timed-out` / `ended`, and that `finished` is now derived (`outcome !== "ongoing"`).
- Round-end evaluation: at the conclusion of every round, loss conditions are checked before win conditions; the `maxRounds` ceiling resolves to `timed-out` only if nothing else fired.
- Conditions are predicate functions re-attached by registry key on reload (like recipes/item factories), injected as static config.
- Outcome prose is authored **content** (surface-agnostic `text` + optional `sound`), not a UI concern — it travels with the campaign definition and reaches every play surface via the `resolution` presentation cue and the derived `campaign.outcomeNarration`.
- Authoring: `.winWhen(key, prose?)`, `.loseWhen(key, prose?)`, `.onTimeout(prose)`, `.onEnd(prose)`.

- [ ] **Step 4: Update the data-model diagrams**

In `docs-site/guide/data-model.md`:
- **Live campaign instance diagram:** add an `outcome` (and `outcomeReason`) attribute to the `Campaign` entity, and a `VictoryCondition` entity related to `Campaign` (win/loss), with attributes `key` and `narration`.
- **Campaign template diagram:** add win/loss condition records referencing condition keys, and note the `timeout`/`ended` prose fallbacks. Keep the existing "content by name, behaviors by typed key" framing — conditions are behavior-by-key with prose-as-content.
- Update the surrounding prose if it enumerates campaign fields.

- [ ] **Step 5: Validate the Mermaid diagrams render**

Use the Mermaid validation tool on each `erDiagram` block (the diagrams render client-side, so a docs build does not validate syntax). Confirm both report `valid: true`. If the validation tool is unavailable, run `pnpm docs:build` and confirm it completes without error.

- [ ] **Step 6: Run the full checks**

Run: `pnpm checks`
Expected: lint + typecheck + test all pass.

- [ ] **Step 7: Verify the workspace packages still typecheck**

The snapshot type changed (`SCHEMA_VERSION`, `CampaignCoreSnapshot`), and `packages/server` + `packages/seed` consume `CampaignSnapshot` / `SCHEMA_VERSION` from the engine. Confirm they still compile.

Run: `pnpm -r run typecheck`
Expected: all workspace packages typecheck (no errors). If `packages/server` or `packages/seed` reference the removed `finished` snapshot field or construct a `CampaignCoreSnapshot` literal, fix those call sites to use `outcome` + empty condition lists. (Expected: no such references exist — the server passes snapshots through opaquely and the seed authors via the builder — but verify rather than assume.)

- [ ] **Step 8: Commit**

```bash
git add src/integration.test.ts README.md docs-site/guide/data-model.md
git commit -m "docs(victory): mechanics section, data-model diagrams, and integration test"
```

---

## Self-Review

**Spec coverage:**
- Outcome model (won/lost/timed-out/ended) → Task 1 (vocab) + Task 3 (state, `#finish`, `endRound`). ✓
- Predicate conditions re-attached by key → Task 2 (registry) + Task 3 (`[HYDRATE_CATALOG]`). ✓
- Lists, loss-before-win, maxRounds→timed-out → Task 1 (`resolveOutcome`) + Task 3 tests. ✓
- Constructor-option injection (no symbol seam) → Task 3 Step 6. ✓
- Outcome prose as authored content, per-condition + timeout/ended fallbacks → Task 1 (`OutcomeNarration`) + Task 3 (storage/getter/cue) + Task 5 (builder/assembler). ✓
- Resolution cue carrying narration → Task 3 Steps 1, 7, 13. ✓
- `outcomeNarration` derived getter (poll parity with cue) → Task 3 Step 4. ✓
- Serialization (keys + prose; predicate dropped/re-resolved; SCHEMA_VERSION 1→2) → Task 3 Steps 2, 9, 10. ✓
- `defineRegistry` conditions + typed `CK` + `ConditionKeyOf` → Task 4. ✓
- Builder `.winWhen`/`.loseWhen`/`.onTimeout`/`.onEnd`; assembler validate+resolve → Task 5. ✓
- Type-only `presentation` ↔ `victory` cycle → Global Constraints + Task 1/Task 3 imports. ✓
- Ripple: `sync/resolver.ts` `campaign.finished` (derived getter keeps it working) → Task 3 Step 16 verifies. Test helpers `baseCore` + roundtrip schemaVersion → Task 3 Steps 11-12. ✓
- README + data-model + TSDoc → TSDoc inline in Tasks 1-5; README + diagrams in Task 6. ✓
- Integration test → Task 6 Step 1. ✓

**Placeholder scan:** The `/* construct a PlayerCharacter */` and `rootRooms` notes are explicit "copy the neighboring pattern" instructions with exact values named, not vague TODOs — acceptable because the exact construction already exists in the named test files and inventing a parallel path would be worse.

**Type consistency:** `CampaignOutcome`, `OutcomeNarration`, `VictoryCondition`, `OutcomeResult` (with `condition`, not `reason`) are defined in Task 1 and used identically in Tasks 3/5. Snapshot stores `{ key, narration }` records (Task 3 type) and the same shape is produced by `[SERIALIZE]` and consumed by `[HYDRATE_CATALOG]` (Task 3) and the assembler/description (Task 5). `registerCondition`/`condition` names match across Tasks 2, 4, 5. `TypedRegistry`'s third param `CK = never` defaulted so existing two-arg uses compile (Task 4). ✓
