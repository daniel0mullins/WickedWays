# Campaign Custom Mechanics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add opt-in, per-campaign custom mechanics — registry-keyed rules with typed namespaced state that react to turn-loop events (reducers) and adjust combat damage (a transformer), acting only through a closed, clamped `Effect` vocabulary.

**Architecture:** A `Mechanic` is a pure definition registered by key (like conditions). Reducer hooks return `Effect[]` realized by a single clamping applier through symbol seams; the combat transformer returns an engine-clamped number and may short-circuit. State is a JSON object mutated in place and serialized by key. Campaigns opt in via `.useMechanic(key, config?)`; opt-in order is execution order.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`, NodeNext), Vitest, pnpm. Engine lives in `src/lib/`.

## Global Constraints

- **Guardrail A (integrity):** mechanics never reach raw state; all world changes go through the closed `Effect` union, applied via symbol seams, magnitudes clamped (lower-floored at 0, matching the engine's existing stat floor).
- **Guardrail B (determinism):** hooks are pure `(view, state, rng)`; the only randomness is the injected campaign `rng` (via `roll(n, rng)` from `src/lib/dice.ts`); the view exposes no clock/IO.
- **Guardrail D (termination):** one non-reentrant collect-then-apply pass per event; the applier never re-fires hooks; `MAX_EFFECTS_PER_EVENT = 64` per mechanic per event, exceeding throws `ProceduralViolation`.
- **Opt-in:** a campaign that names no mechanics behaves exactly as today; every dispatch is a no-op when `#mechanics` is empty.
- **Serialize by key:** behavior re-attaches from the registry on hydrate; only typed state data is persisted. Missing key on hydrate → `ProceduralViolation` (matching conditions).
- **Conventions:** branded ids via helpers (never cast raw strings); illegal transitions throw `ProceduralViolation`; protected writes behind exported `Symbol`s; underscore-prefixed args exempt from unused-vars; co-locate `foo.test.ts` with `foo.ts`.
- **Commit trailer:** end every commit message with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

### Refinements to the spec (discovered during planning)

These adjust the spec's illustrative sketches to fit the real engine; they preserve the spec's decisions:

1. **One stat seam, raw (unmitigated) application.** `damage`/`heal`/`adjustStat` all route through a single new `ADJUST_STAT(stat, delta)` character seam that floors the stat at 0 and reconciles afflictions — **not** through `takeDamage` (which applies armor/mitigation math). Mechanic-dealt damage is raw and predictable; mitigation-style interception is the transformer's job. No upper clamp in v1 (a balance/guardrail-C concern, deferred).
2. **`DamageView` carries `stat: StatType`, not an element.** The engine has no "fire"/element type; damage is keyed by `StatType` (Health/Sanity/Energy). Transformers discriminate on `stat` and on `view` (e.g. "while the ward is equipped"). `source` is `undefined` in the `takeDamage` path (it receives no attacker).
3. **`ActionCtx.action` reuses the engine's `ActionDetail`** rather than a parallel `ActionEvent` union (DRY).
4. **Mechanic state must be a JSON *object*** (`JsonObject`), so in-place mutation through `h.state` (a live reference) persists.
5. **No `MECHANICS` field-seam.** `#mechanics` is a private field set only in the constructor and `[HYDRATE_CATALOG]`; that is already unforgeable. New seams added instead: `ADJUST_STAT`, `FIND_CHARACTER`, and dispatch entry points `DISPATCH_TURN`/`DISPATCH_ACTION`/`TRANSFORM_DAMAGE`/`INVOKE_MECHANIC_ACTION`.
6. **`CharacterView` is leaner** (no `maxHealth`): `id`, `name`, `health`, `sanity`, `energy`, `status`, `roomId`, `hasEquipped(key)`.
7. A new `ActionKind`/`ActionDetail` member `mechanicAction` is added so custom actions flow through the existing `recordAction` budget + cue path.

---

### Task 1: Mechanic core types + `mechanic` presentation cue

**Files:**
- Create: `src/lib/mechanics/mechanic.ts`
- Create: `src/lib/mechanics/mechanic.test.ts`
- Modify: `src/lib/presentation.ts:28-32` (add the `mechanic` cue variant)

**Interfaces:**
- Produces: `JsonValue`, `JsonObject`, `CampaignView`, `CharacterView`, `RoomView`, `HookCtx<S>`, `TurnCtx<S>`, `ActionCtx<S>`, `DamageView`, `TransformResult`, `MechanicCue`, `Effect`, `CustomAction<S>`, `Mechanic<S, Cfg, A>`, `LiveMechanic`, `MAX_EFFECTS_PER_EVENT`.
- Consumes: `CharacterId` (`src/lib/character/character.ts`), `StatType` (`src/lib/character/stats.ts`), `Status` (`src/lib/status.ts`), `AssetRef` (`src/lib/presentation.ts`), `ActionDetail` (the action-history detail type; confirm its export — see step 1). All as `import type`.

- [ ] **Step 1: Locate `ActionDetail` and `StatType` exports**

Run: `grep -rn "ActionDetail" src/lib/character | head` and `grep -rn "export.*StatType" src/lib/character/stats.ts`
Expected: confirm the `ActionDetail` union (used by `recordAction(callingFn, detail)`) and `StatType` enum/const are exported. Note their import paths for the type-only imports below.

- [ ] **Step 2: Write the failing test**

```ts
// src/lib/mechanics/mechanic.test.ts
import { describe, it, expect } from "vitest";
import type { Mechanic, JsonObject } from "./mechanic.js";

interface DoomState extends JsonObject { doom: number }

const doomClock: Mechanic<DoomState, { rate: number }> = {
  initialState: (cfg) => ({ doom: 0 }),
  onRoundEnd: (h) => {
    h.state.doom += 1;
    return h.state.doom >= 10 ? [{ kind: "cue", cue: { text: "Doom!" } }] : [];
  },
};

describe("Mechanic typing", () => {
  it("constructs initial state from config and mutates own state", () => {
    const state = doomClock.initialState({ rate: 1 });
    expect(state).toEqual({ doom: 0 });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run src/lib/mechanics/mechanic.test.ts`
Expected: FAIL — `Cannot find module './mechanic.js'`.

- [ ] **Step 4: Write `mechanic.ts`**

```ts
// src/lib/mechanics/mechanic.ts
import type { CharacterId } from "../character/character.js";
import type { StatType } from "../character/stats.js";
import type { Status } from "../status.js";
import type { AssetRef } from "../presentation.js";
import type { ActionDetail } from "../character/character.js"; // adjust path per Step 1

/** Runaway backstop: max effects one mechanic may emit for a single event. */
export const MAX_EFFECTS_PER_EVENT = 64;

export type JsonValue =
  | null | boolean | number | string
  | JsonValue[] | { [k: string]: JsonValue };
export type JsonObject = { [k: string]: JsonValue };

/** Read-only projection handed to hooks. No setters, no clock, no IO. */
export interface CampaignView {
  readonly round: number;
  readonly maxRounds: number;
  readonly party: readonly CharacterView[];
  readonly rooms: readonly RoomView[];
}
export interface CharacterView {
  readonly id: CharacterId;
  readonly name: string;
  readonly health: number;
  readonly sanity: number;
  readonly energy: number;
  readonly status: readonly Status[];
  readonly roomId: string | undefined;
  /** True if an equipped item was registered under this registry key. */
  hasEquipped(itemKey: string): boolean;
}
export interface RoomView {
  readonly id: string;
  readonly name: string;
  readonly lit: boolean;
  readonly occupantIds: readonly CharacterId[];
}

export interface HookCtx<S extends JsonObject> {
  /** This mechanic's own state — a live reference; mutate in place. */
  state: S;
  readonly view: CampaignView;
  readonly rng: () => number;
  /** Integer in [1, n], drawn from the campaign rng. */
  roll(n: number): number;
}
export interface TurnCtx<S extends JsonObject> extends HookCtx<S> {
  readonly actor: CharacterView;
}
export interface ActionCtx<S extends JsonObject> extends TurnCtx<S> {
  readonly action: ActionDetail;
}

export interface DamageView {
  readonly amount: number;
  readonly target: CharacterId;
  readonly stat: StatType;
  readonly source: CharacterId | undefined;
}
/** A transformer returns the adjusted amount, or locks it and halts the chain. */
export type TransformResult = number | { value: number; final: true };

export interface MechanicCue {
  readonly text?: string;
  readonly sound?: AssetRef;
}

/** The closed set of state changes a mechanic may request (guardrail A). */
export type Effect =
  | { kind: "damage"; target: CharacterId; amount: number }
  | { kind: "heal"; target: CharacterId; amount: number }
  | { kind: "adjustStat"; target: CharacterId; stat: "sanity" | "energy"; delta: number }
  | { kind: "grantImmunity"; target: CharacterId; turns: number }
  | { kind: "cue"; cue: MechanicCue };

export interface CustomAction<S extends JsonObject> {
  /** Action-budget cost; defaults to 1. */
  readonly cost?: number;
  run(h: ActionCtx<S>): Effect[] | void;
}

export interface Mechanic<
  S extends JsonObject,
  Cfg = void,
  A extends string = never,
> {
  initialState(config: Cfg): S;
  onRoundStart?(h: HookCtx<S>): Effect[] | void;
  onRoundEnd?(h: HookCtx<S>): Effect[] | void;
  onTurnStart?(h: TurnCtx<S>): Effect[] | void;
  onTurnEnd?(h: TurnCtx<S>): Effect[] | void;
  onAction?(h: ActionCtx<S>): Effect[] | void;
  modifyDamage?(d: DamageView, h: HookCtx<S>): TransformResult;
  actions?: Record<A, CustomAction<S>>;
}

/** A registered mechanic paired with its live (mutable) state, in opt-in order. */
export interface LiveMechanic {
  readonly key: string;
  readonly mechanic: Mechanic<JsonObject, unknown, string>;
  state: JsonObject;
}
```

- [ ] **Step 5: Add the `mechanic` cue variant to `presentation.ts`**

In `src/lib/presentation.ts:28-32`, extend the union (import the type):

```ts
import type { MechanicCue } from "./mechanics/mechanic.js";

export type PresentationCue =
  | { kind: "action"; action: ActionKind; actor: EntityRef; sound?: AssetRef }
  | { kind: "encounter"; mob: EntityRef; room: EntityRef; sound?: AssetRef }
  | { kind: "visibility"; room: EntityRef; lit: boolean }
  | { kind: "resolution"; outcome: CampaignOutcome; reason?: string; narration?: OutcomeNarration }
  | { kind: "mechanic"; cue: MechanicCue };
```

`mechanic.ts` and `presentation.ts` reference each other only via `import type`, so the cycle erases at runtime (matching `victory.ts`).

- [ ] **Step 6: Run tests + typecheck**

Run: `pnpm vitest run src/lib/mechanics/mechanic.test.ts && pnpm typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add src/lib/mechanics/mechanic.ts src/lib/mechanics/mechanic.test.ts src/lib/presentation.ts
git commit -m "$(printf 'feat(mechanics): core Mechanic/Effect types + mechanic cue\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 2: `ADJUST_STAT` character seam + `FIND_CHARACTER` campaign seam

**Files:**
- Create: `src/lib/mechanics/symbols.ts`
- Modify: `src/lib/character/character.ts` (add the `ADJUST_STAT` method; register nothing in `isActionMap`)
- Modify: `src/lib/campaign.ts` (add the `FIND_CHARACTER` method)
- Modify: `src/lib/character/character.test.ts` (new test for `ADJUST_STAT`)
- Modify: `src/lib/campaign.test.ts` (new test for `FIND_CHARACTER`)

**Interfaces:**
- Produces: `ADJUST_STAT`, `FIND_CHARACTER` symbols; `Character[ADJUST_STAT](stat: StatType, delta: number): void`; `Campaign[FIND_CHARACTER](id: CharacterId): IPlayerCharacter`.
- Consumes: `StatType`, `CharacterId`, `ProceduralViolation`, `Character.#reconcile()`/`stats`.

- [ ] **Step 1: Create the seam symbols module**

```ts
// src/lib/mechanics/symbols.ts
/** Symbol-keyed seams for the custom-mechanics subsystem (mirrors inventory.ts). */
export const ADJUST_STAT = Symbol("ADJUST_STAT");
export const FIND_CHARACTER = Symbol("FIND_CHARACTER");
export const DISPATCH_TURN = Symbol("DISPATCH_TURN");
export const DISPATCH_ACTION = Symbol("DISPATCH_ACTION");
export const TRANSFORM_DAMAGE = Symbol("TRANSFORM_DAMAGE");
export const INVOKE_MECHANIC_ACTION = Symbol("INVOKE_MECHANIC_ACTION");
```

- [ ] **Step 2: Write the failing `ADJUST_STAT` test**

```ts
// src/lib/character/character.test.ts (add)
import { ADJUST_STAT } from "../mechanics/symbols.js";
import { StatType } from "./stats.js";

it("ADJUST_STAT floors a stat at 0 and reconciles", () => {
  const c = makePlayer(); // existing test-utils factory
  const before = c.effectiveStat(StatType.Sanity);
  c[ADJUST_STAT](StatType.Sanity, -(before + 5));
  expect(c.effectiveStat(StatType.Sanity)).toBe(0); // floored, never negative
});
```

(Use whatever player factory the suite already uses; see `src/test-utils.ts`.)

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm vitest run src/lib/character/character.test.ts -t "ADJUST_STAT"`
Expected: FAIL — `c[ADJUST_STAT] is not a function`.

- [ ] **Step 4: Implement `ADJUST_STAT` on `Character`**

Near the existing `[GRANT_IMMUNITY]` method (`character.ts:316`), add (import the symbol + `StatType`):

```ts
import { ADJUST_STAT } from "../mechanics/symbols.js";

/**
 * Mechanics seam: apply a raw, unmitigated delta to a base stat, floored at 0,
 * then reconcile afflictions. The ONLY mechanic-facing stat mutator; magnitudes
 * are pre-clamped by the applier. Unforgeable (symbol-keyed).
 */
[ADJUST_STAT](stat: StatType, delta: number): void {
  this.stats[stat] = Math.max(0, this.stats[stat] + delta);
  this.#reconcile();
}
```

- [ ] **Step 5: Write the failing `FIND_CHARACTER` test**

```ts
// src/lib/campaign.test.ts (add)
import { FIND_CHARACTER } from "./mechanics/symbols.js";

it("FIND_CHARACTER resolves a party member by id and throws otherwise", () => {
  const { campaign, player } = makeStartedCampaign(); // existing helper
  expect(campaign[FIND_CHARACTER](player.id)).toBe(player);
  expect(() => campaign[FIND_CHARACTER]("nope" as never)).toThrow(/No party character/);
});
```

- [ ] **Step 6: Implement `FIND_CHARACTER` on `Campaign`**

```ts
import { FIND_CHARACTER } from "./mechanics/symbols.js";
import { ProceduralViolation } from "./errors.js"; // use the existing import

[FIND_CHARACTER](id: CharacterId): IPlayerCharacter {
  const c = this.party.find((p) => p.id === id);
  if (!c) throw new ProceduralViolation(`No party character for id '${id}'.`);
  return c;
}
```

- [ ] **Step 7: Run tests + typecheck, then commit**

Run: `pnpm vitest run src/lib/character/character.test.ts src/lib/campaign.test.ts && pnpm typecheck`
Expected: PASS.

```bash
git add src/lib/mechanics/symbols.ts src/lib/character/character.ts src/lib/campaign.ts src/lib/character/character.test.ts src/lib/campaign.test.ts
git commit -m "$(printf 'feat(mechanics): ADJUST_STAT + FIND_CHARACTER symbol seams\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 3: Effect applier

**Files:**
- Create: `src/lib/mechanics/apply.ts`
- Create: `src/lib/mechanics/apply.test.ts`

**Interfaces:**
- Produces: `applyEffect(campaign: Campaign, e: Effect): void`.
- Consumes: `Effect` (Task 1); `Campaign[FIND_CHARACTER]`, `Character[ADJUST_STAT]` (Task 2); `GRANT_IMMUNITY` (`src/lib/inventory.ts`); `EMIT_CUE` (`src/lib/presentation.ts`); `StatType`, `Status`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/mechanics/apply.test.ts
import { describe, it, expect } from "vitest";
import { applyEffect } from "./apply.js";
import { StatType } from "../character/stats.js";

describe("applyEffect", () => {
  it("damage floors the target's health at 0 and never goes negative", () => {
    const { campaign, player } = makeStartedCampaign();
    applyEffect(campaign, { kind: "damage", target: player.id, amount: 9999 });
    expect(player.effectiveStat(StatType.Health)).toBe(0);
  });

  it("rejects negative amounts by clamping to 0 (no healing via damage)", () => {
    const { campaign, player } = makeStartedCampaign();
    const before = player.effectiveStat(StatType.Health);
    applyEffect(campaign, { kind: "damage", target: player.id, amount: -5 });
    expect(player.effectiveStat(StatType.Health)).toBe(before);
  });

  it("emits a mechanic cue", () => {
    const { campaign } = makeStartedCampaign();
    const cues: unknown[] = [];
    campaign.onCue((c) => cues.push(c));
    applyEffect(campaign, { kind: "cue", cue: { text: "tick" } });
    expect(cues).toContainEqual({ kind: "mechanic", cue: { text: "tick" } });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/lib/mechanics/apply.test.ts`
Expected: FAIL — `Cannot find module './apply.js'`.

- [ ] **Step 3: Implement `apply.ts`**

```ts
// src/lib/mechanics/apply.ts
import type { Campaign } from "../campaign.js";
import type { Effect } from "./mechanic.js";
import { StatType } from "../character/stats.js";
import { Status } from "../status.js";
import { ADJUST_STAT, FIND_CHARACTER } from "./symbols.js";
import { GRANT_IMMUNITY } from "../inventory.js";
import { EMIT_CUE } from "../presentation.js";

const ALL_STATUSES: Status[] = Object.values(Status);

/**
 * Realize one effect against the live campaign — the single chokepoint where a
 * mechanic's intent becomes state. Routes through symbol seams; clamps every
 * magnitude (lower-floored at 0). Guardrail A.
 */
export function applyEffect(campaign: Campaign, e: Effect): void {
  switch (e.kind) {
    case "damage":
      campaign[FIND_CHARACTER](e.target)[ADJUST_STAT](StatType.Health, -Math.max(0, e.amount));
      break;
    case "heal":
      campaign[FIND_CHARACTER](e.target)[ADJUST_STAT](StatType.Health, Math.max(0, e.amount));
      break;
    case "adjustStat": {
      const stat = e.stat === "sanity" ? StatType.Sanity : StatType.Energy;
      campaign[FIND_CHARACTER](e.target)[ADJUST_STAT](stat, e.delta);
      break;
    }
    case "grantImmunity":
      campaign[FIND_CHARACTER](e.target)[GRANT_IMMUNITY](ALL_STATUSES, Math.max(0, Math.trunc(e.turns)));
      break;
    case "cue":
      campaign[EMIT_CUE]({ kind: "mechanic", cue: e.cue });
      break;
  }
}
```

- [ ] **Step 4: Run tests + typecheck, then commit**

Run: `pnpm vitest run src/lib/mechanics/apply.test.ts && pnpm typecheck`
Expected: PASS.

```bash
git add src/lib/mechanics/apply.ts src/lib/mechanics/apply.test.ts
git commit -m "$(printf 'feat(mechanics): clamping effect applier\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 4: Dispatch (reducers + damage transformers)

**Files:**
- Create: `src/lib/mechanics/dispatch.ts`
- Create: `src/lib/mechanics/dispatch.test.ts`

**Interfaces:**
- Produces:
  - `runReducers(mechanics: readonly LiveMechanic[], hook: (m: LiveMechanic) => Effect[] | void, apply: (e: Effect) => void): void`
  - `runDamageTransformers(mechanics: readonly LiveMechanic[], initial: DamageView, ctxFor: (m: LiveMechanic) => HookCtx<JsonObject>, onFinal: (key: string, value: number) => void): number`
- Consumes: `LiveMechanic`, `Effect`, `DamageView`, `HookCtx`, `JsonObject`, `MAX_EFFECTS_PER_EVENT` (Task 1); `ProceduralViolation`.
- Note: takes `apply`/`ctxFor`/`onFinal` callbacks so `dispatch.ts` never imports `Campaign` (no cycle).

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/mechanics/dispatch.test.ts
import { describe, it, expect } from "vitest";
import { runReducers, runDamageTransformers } from "./dispatch.js";
import { MAX_EFFECTS_PER_EVENT } from "./mechanic.js";
import type { LiveMechanic } from "./mechanic.js";

const live = (key: string, mechanic: object): LiveMechanic =>
  ({ key, mechanic: mechanic as never, state: {} });

describe("runReducers", () => {
  it("collects all effects, then applies once in opt-in order", () => {
    const applied: string[] = [];
    const ms = [
      live("a", { onRoundEnd: () => [{ kind: "cue", cue: { text: "a" } }] }),
      live("b", { onRoundEnd: () => [{ kind: "cue", cue: { text: "b" } }] }),
    ];
    runReducers(ms, (m) => m.mechanic.onRoundEnd?.({} as never), (e) =>
      applied.push(e.kind === "cue" ? (e.cue.text ?? "") : e.kind));
    expect(applied).toEqual(["a", "b"]);
  });

  it("throws when one mechanic exceeds the per-event cap", () => {
    const ms = [live("flood", {
      onRoundEnd: () => Array.from({ length: MAX_EFFECTS_PER_EVENT + 1 },
        () => ({ kind: "cue", cue: {} })),
    })];
    expect(() => runReducers(ms, (m) => m.mechanic.onRoundEnd?.({} as never), () => {}))
      .toThrow(/cap/);
  });
});

describe("runDamageTransformers", () => {
  const dv = { amount: 10, target: "t" as never, stat: 0 as never, source: undefined };
  const ctx = () => ({}) as never;

  it("chains transforms in opt-in order, clamping at 0", () => {
    const ms = [
      live("dbl", { modifyDamage: (d: { amount: number }) => d.amount * 2 }),
      live("sub", { modifyDamage: (d: { amount: number }) => d.amount - 100 }),
    ];
    expect(runDamageTransformers(ms, dv, ctx, () => {})).toBe(0); // (10*2)-100 -> clamp 0
  });

  it("`final` halts the chain, locks the value, and signals onFinal", () => {
    let finalKey = "";
    const ms = [
      live("ward", { modifyDamage: () => ({ value: 0, final: true }) }),
      live("dbl", { modifyDamage: (d: { amount: number }) => d.amount + 999 }),
    ];
    expect(runDamageTransformers(ms, dv, ctx, (k) => { finalKey = k; })).toBe(0);
    expect(finalKey).toBe("ward");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/lib/mechanics/dispatch.test.ts`
Expected: FAIL — `Cannot find module './dispatch.js'`.

- [ ] **Step 3: Implement `dispatch.ts`**

```ts
// src/lib/mechanics/dispatch.ts
import type { DamageView, Effect, HookCtx, JsonObject, LiveMechanic } from "./mechanic.js";
import { MAX_EFFECTS_PER_EVENT } from "./mechanic.js";
import { ProceduralViolation } from "../errors.js";

/** Run every mechanic's reducer hook (opt-in order), collect ALL effects, then
 *  apply them in a single pass. Applying effects must not re-enter dispatch —
 *  guardrail D (no re-entrancy). Per-mechanic effect count is capped. */
export function runReducers(
  mechanics: readonly LiveMechanic[],
  hook: (m: LiveMechanic) => Effect[] | void,
  apply: (e: Effect) => void,
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
  for (const e of queued) apply(e);
}

/** Fold an incoming damage value through each mechanic's transformer (opt-in
 *  order), clamping at 0 after each. A `final` result locks the value, halts the
 *  chain, and signals `onFinal` (for the diagnostic cue). */
export function runDamageTransformers(
  mechanics: readonly LiveMechanic[],
  initial: DamageView,
  ctxFor: (m: LiveMechanic) => HookCtx<JsonObject>,
  onFinal: (key: string, value: number) => void,
): number {
  let value = initial.amount;
  for (const m of mechanics) {
    const fn = m.mechanic.modifyDamage;
    if (!fn) continue;
    const r = fn({ ...initial, amount: value }, ctxFor(m));
    const next = Math.max(0, typeof r === "number" ? r : r.value);
    if (typeof r === "object" && r.final) {
      onFinal(m.key, next);
      return next;
    }
    value = next;
  }
  return value;
}
```

- [ ] **Step 4: Run tests + typecheck, then commit**

Run: `pnpm vitest run src/lib/mechanics/dispatch.test.ts && pnpm typecheck`
Expected: PASS.

```bash
git add src/lib/mechanics/dispatch.ts src/lib/mechanics/dispatch.test.ts
git commit -m "$(printf 'feat(mechanics): reducer + damage-transformer dispatch\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 5: Registry + typed authoring registry

**Files:**
- Modify: `src/lib/serialization/registry.ts:28-94` (`registerMechanic` / `mechanic`)
- Modify: `src/lib/authoring/registry.ts:1-49` (`MECHANIC_KEYS`, `MechanicKeyOf`, `ConfigOf`, `defineRegistry` mechanics)
- Modify: `src/lib/serialization/registry.test.ts` and `src/lib/authoring/registry.test.ts`

**Interfaces:**
- Produces: `CampaignRegistry.registerMechanic(key, mechanic)` / `CampaignRegistry.mechanic(key): Mechanic<JsonObject, unknown, string>`; `MechanicKeyOf<R>`; `ConfigOf<R, K>`; `defineRegistry({ ..., mechanics? })` with a 4th generic and `MECHANIC_KEYS` brand.
- Consumes: `Mechanic`, `JsonObject` (Task 1); `#require` (existing).

- [ ] **Step 1: Write the failing registry test**

```ts
// src/lib/serialization/registry.test.ts (add)
it("registers and resolves a mechanic by key; throws on miss", () => {
  const reg = new CampaignRegistry();
  const m = { initialState: () => ({}) };
  reg.registerMechanic("doom", m as never);
  expect(reg.mechanic("doom")).toBe(m);
  expect(() => reg.mechanic("nope")).toThrow(/No mechanic registered/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/lib/serialization/registry.test.ts -t "mechanic"`
Expected: FAIL — `reg.registerMechanic is not a function`.

- [ ] **Step 3: Add the mechanics map to `CampaignRegistry`**

In `serialization/registry.ts`, mirror the conditions map:

```ts
import type { Mechanic, JsonObject } from "../mechanics/mechanic.js";

#mechanics = new Map<string, Mechanic<JsonObject, unknown, string>>();

registerMechanic(key: string, mechanic: Mechanic<JsonObject, unknown, string>): void {
  this.#mechanics.set(key, mechanic);
}

mechanic(key: string): Mechanic<JsonObject, unknown, string> {
  return this.#require(this.#mechanics.get(key), "mechanic", key);
}
```

- [ ] **Step 4: Write the failing typed-registry test**

```ts
// src/lib/authoring/registry.test.ts (add)
import { defineRegistry } from "./registry.js";
import type { MechanicKeyOf } from "./registry.js";

it("threads mechanic keys into the phantom type", () => {
  const reg = defineRegistry({
    items: {},
    mechanics: { "doom-clock": { initialState: () => ({ doom: 0 }) } },
  });
  // type-level: MechanicKeyOf<typeof reg> is "doom-clock"
  const k: MechanicKeyOf<typeof reg> = "doom-clock";
  expect(reg.mechanic(k)).toBeDefined();
});
```

- [ ] **Step 5: Extend `authoring/registry.ts`**

```ts
import type { Mechanic, JsonObject } from "../mechanics/mechanic.js";

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

/** The Cfg type of the mechanic registered under key K in registry R. */
export type ConfigOf<R, K extends string> =
  R extends { mechanicConfigs?: infer M }
    ? K extends keyof M ? M[K] : unknown
    : unknown;
```

Update `defineRegistry`'s signature to add the 4th generic and the `mechanics` def, and register each:

```ts
export function defineRegistry<
  I extends Record<string, () => Item>,
  R extends Record<string, CraftingRecipe> = Record<string, never>,
  C extends Record<string, (campaign: ICampaign) => boolean> = Record<string, never>,
  M extends Record<string, Mechanic<JsonObject, unknown, string>> = Record<string, never>,
>(defs: {
  items: I;
  recipes?: R;
  scenes?: Record<string, SceneBehavior>;
  formations?: Record<string, FormationBehavior>;
  conditions?: C;
  mechanics?: M;
}): TypedRegistry<keyof I & string, keyof R & string, keyof C & string, keyof M & string> {
  const reg = new CampaignRegistry();
  // ...existing item/recipe/scene/formation/condition registration...
  for (const [key, mechanic] of Object.entries(defs.mechanics ?? {})) reg.registerMechanic(key, mechanic);
  return reg as TypedRegistry<keyof I & string, keyof R & string, keyof C & string, keyof M & string>;
}
```

Note: `ConfigOf` resolution from the registry generics is best-effort; if threading the per-key `Cfg` through `MK` proves awkward in TS, fall back to `config?: unknown` on `.useMechanic` (Task 6) and document that mechanic configs are validated at `initialState`. Keep the key (`MK`) compile-checked regardless.

- [ ] **Step 6: Run tests + typecheck, then commit**

Run: `pnpm vitest run src/lib/serialization/registry.test.ts src/lib/authoring/registry.test.ts && pnpm typecheck`
Expected: PASS; all existing `defineRegistry` call sites still compile (the `MK = never` default).

```bash
git add src/lib/serialization/registry.ts src/lib/authoring/registry.ts src/lib/serialization/registry.test.ts src/lib/authoring/registry.test.ts
git commit -m "$(printf 'feat(mechanics): registry + typed MechanicKeyOf\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 6: Authoring opt-in (`.useMechanic`) + assembler

**Files:**
- Modify: `src/lib/authoring/description.ts:70-101` (add `mechanics` field)
- Modify: `src/lib/authoring/template-builder.ts:30, 142-145, 198-204` (`.useMechanic`, `MK` param, init `mechanics: []`)
- Modify: `src/lib/authoring/assembler.ts:27-126` (validate keys pass 1; construct via `initialState` pass 2; pass to constructor)
- Modify: `src/lib/authoring/assembler.test.ts` (or the authoring test that covers `assemble`)

**Interfaces:**
- Produces: `CampaignTemplateDescription.mechanics: { key: string; config?: unknown }[]`; `TemplateBuilder.useMechanic<K extends MK>(key: K, config?: ConfigOf<R, K>): this`; assembler resolves to `LiveMechanic[]`.
- Consumes: `registry.mechanic(key)` (Task 5); `LiveMechanic` (Task 1); `AuthoringError`, `problems[]` (existing).

- [ ] **Step 1: Add the description field**

In `authoring/description.ts`, add to `CampaignTemplateDescription`:

```ts
/** Opted-in custom mechanics: registry keys + optional per-campaign config.
 *  Order is preserved and is the reducer/transformer execution order. */
mechanics: { key: string; config?: unknown }[];
```

Initialize it to `[]` wherever the description is constructed in `TemplateBuilder`'s constructor (alongside `winConditions: []`).

- [ ] **Step 2: Write the failing builder/assembler tests**

```ts
// src/lib/authoring/assembler.test.ts (add)
it("opts a mechanic in and constructs its initial state in order", () => {
  const reg = defineRegistry({
    items: {},
    mechanics: { doom: { initialState: (c: { start: number }) => ({ doom: c.start }) } },
  });
  const campaign = authorTemplate("T", reg)
    .room("start").startAt("start")
    .useMechanic("doom", { start: 3 })
    .build();
  // mechanic state is live on the campaign (asserted indirectly via a round in Task 7);
  // here just assert build() succeeds and serialization carries it (Task 9).
  expect(campaign.title).toBe("T");
});

it("rejects an unknown mechanic key at assemble time", () => {
  const reg = defineRegistry({ items: {} });
  const b = authorTemplate("T", reg).room("s").startAt("s");
  // @ts-expect-error unknown key
  expect(() => b.useMechanic("ghost").build()).toThrow(/unregistered mechanic key/);
});

it("rejects a duplicate useMechanic", () => {
  const reg = defineRegistry({ items: {}, mechanics: { doom: { initialState: () => ({}) } } });
  const b = authorTemplate("T", reg).room("s").startAt("s").useMechanic("doom");
  expect(() => b.useMechanic("doom")).toThrow(/already enabled/);
});
```

(Adjust the room/startAt builder calls to match the suite's existing minimal-template helper.)

- [ ] **Step 3: Run to verify they fail**

Run: `pnpm vitest run src/lib/authoring/assembler.test.ts -t "mechanic"`
Expected: FAIL — `.useMechanic is not a function`.

- [ ] **Step 4: Implement `.useMechanic`**

In `template-builder.ts`, add `MK extends string = never` as the 4th generic on the class and thread it from `authorTemplate` via `MechanicKeyOf<R>`. Add:

```ts
useMechanic<K extends MK>(key: K, config?: ConfigOf<R, K>): this {
  if (this.description.mechanics.some((m) => m.key === key)) {
    throw new AuthoringError([`Mechanic '${key}' is already enabled.`]);
  }
  this.description.mechanics.push({ key, config });
  return this;
}
```

`authorTemplate`'s return type becomes `TemplateBuilder<ItemKeyOf<R>, RecipeKeyOf<R>, ConditionKeyOf<R>, MechanicKeyOf<R>>`. (`R` is captured for `ConfigOf`; if `ConfigOf` is left as `unknown` per Task 5's fallback, `config?: unknown` is fine and the key stays checked.)

- [ ] **Step 5: Validate + construct in the assembler**

In `assembler.ts` pass 1 (next to the condition-key validation):

```ts
const seenMech = new Set<string>();
for (const m of desc.mechanics) {
  if (seenMech.has(m.key)) problems.push(`useMechanic key '${m.key}' is duplicated.`);
  seenMech.add(m.key);
  try { registry.mechanic(m.key); }
  catch { problems.push(`useMechanic references unregistered mechanic key '${m.key}'.`); }
}
```

In pass 2 (before `new Campaign(...)`), build the live list and pass it as a constructor option:

```ts
const mechanics = desc.mechanics.map((m) => {
  const mechanic = registry.mechanic(m.key);
  return { key: m.key, mechanic, state: mechanic.initialState(m.config) };
});
// ...add `mechanics,` to the existing `new Campaign(desc.title, ..., { ... })` options object.
```

- [ ] **Step 6: Run tests + typecheck, then commit**

Run: `pnpm vitest run src/lib/authoring && pnpm typecheck`
Expected: PASS. (The `new Campaign` option is added in Task 7; until then, type the option as optional so this compiles — or sequence Task 7's constructor change first if executing strictly in order. If running tasks in number order, add the `mechanics?` constructor option stub in this step's `Campaign` edit.)

```bash
git add src/lib/authoring/description.ts src/lib/authoring/template-builder.ts src/lib/authoring/assembler.ts src/lib/authoring/assembler.test.ts
git commit -m "$(printf 'feat(mechanics): .useMechanic opt-in + assembler validation\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 7: Campaign integration — state, ctx, round hooks, dispatch entry points

**Files:**
- Modify: `src/lib/campaign.ts` (private `#mechanics` + `#rng`; constructor option; `#characterView`/`#hookCtx`/`#dispatchRound`; `endRound`/`beginCampaign` wiring; `[DISPATCH_TURN]`/`[DISPATCH_ACTION]`/`[TRANSFORM_DAMAGE]`/`[INVOKE_MECHANIC_ACTION]` seam methods)
- Modify: `src/lib/campaign.test.ts`

**Interfaces:**
- Produces (all symbol-keyed, from `mechanics/symbols.ts`):
  - `Campaign[DISPATCH_TURN](phase: "start" | "end", actor: IPlayerCharacter): void`
  - `Campaign[DISPATCH_ACTION](detail: ActionDetail, actor: IPlayerCharacter): void`
  - `Campaign[TRANSFORM_DAMAGE](dv: DamageView): number`
  - `Campaign[INVOKE_MECHANIC_ACTION](mechanicKey: string, actionKey: string, actor: IPlayerCharacter): void`
  - constructor option `mechanics?: LiveMechanic[]`.
- Consumes: `runReducers`/`runDamageTransformers` (Task 4), `applyEffect` (Task 3), `LiveMechanic`/`CampaignView`/`HookCtx`/`DamageView` (Task 1), `roll` (`dice.ts`), `Status`/`StatType`/`EMIT_CUE`.

- [ ] **Step 1: Add `#mechanics`, `#rng`, and the constructor option**

In `campaign.ts`, near `#winConditions`:

```ts
#mechanics: LiveMechanic[] = [];
#rng: () => number = Math.random;
```

Add `mechanics?: LiveMechanic[];` to the constructor `options` type, and in the body:

```ts
this.#rng = options.rng ?? Math.random;
this.#mechanics = [...(options.mechanics ?? [])];
```

(Place `this.#rng` assignment before the `EncounterTable` construction and reuse it: `new EncounterTable(this.#rng, ...)`.)

- [ ] **Step 2: Add the view + ctx builders (private)**

```ts
import { roll } from "./dice.js";
import type { CampaignView, CharacterView, HookCtx, JsonObject, LiveMechanic, DamageView } from "./mechanics/mechanic.js";

#characterView(c: IPlayerCharacter): CharacterView {
  return {
    id: c.id,
    name: c.name,
    health: c.effectiveStat(StatType.Health),
    sanity: c.effectiveStat(StatType.Sanity),
    energy: c.effectiveStat(StatType.Energy),
    status: [...c.status], // c.status: readonly Status[] (verify the getter name)
    roomId: c.currentRoom?.id, // verify the room getter name
    hasEquipped: (key) =>
      c.inventory.items.some((i) => i.properties.equipped && i.originKey === key),
    // ^ relies on item origin (SET_ORIGIN). If items lack an `originKey` getter,
    //   add one exposing the registry key recorded at creation.
  };
}

#campaignView(): CampaignView {
  return {
    round: this.#round,
    maxRounds: this.maxRounds,
    party: this.party.map((p) => this.#characterView(p)),
    rooms: [], // populate from the campaign's room set if/when a room getter exists
  };
}

#hookCtx(m: LiveMechanic): HookCtx<JsonObject> {
  const view = this.#campaignView();
  return { state: m.state, view, rng: this.#rng, roll: (n) => roll(n, this.#rng) };
}
```

(`#campaignView()` is rebuilt per dispatch event — cheap, and keeps the view a snapshot. `rooms` may stay `[]` in v1 if the campaign exposes no room collection; the round/turn/action/damage use cases here read `party`. Wire `rooms` if a getter exists.)

- [ ] **Step 3: Add `#dispatchRound` and wire `endRound` / `beginCampaign`**

```ts
import { runReducers, runDamageTransformers } from "./mechanics/dispatch.js";
import { applyEffect } from "./mechanics/apply.js";

#dispatchRound(hook: "onRoundStart" | "onRoundEnd"): void {
  if (this.#mechanics.length === 0) return;
  runReducers(
    this.#mechanics,
    (m) => m.mechanic[hook]?.(this.#hookCtx(m)),
    (e) => applyEffect(this, e),
  );
}
```

Update `endRound()` (`campaign.ts:407`) so `onRoundEnd` fires **before** `resolveOutcome` and `onRoundStart` fires for the next round only when still ongoing:

```ts
endRound() {
  this.#assertRunning();
  const allPartyActed = this.party.every((c) => this.#actedThisRound.get(c));
  if (!allPartyActed) {
    throw new ProceduralViolation("Attempted to end round before all characters have acted");
  }
  this.#dispatchRound("onRoundEnd");            // effects count toward this round's outcome
  this.#round = this.#round + 1;
  this.#resetActivity();
  const result = resolveOutcome({
    round: this.#round, maxRounds: this.maxRounds,
    winConditions: this.#winConditions, loseConditions: this.#loseConditions, campaign: this,
  });
  if (result.status !== "ongoing") { this.#finish(result.status, result.condition); return; }
  this.#dispatchRound("onRoundStart");          // start of the new round
}
```

In `beginCampaign()`, add `this.#dispatchRound("onRoundStart");` as the final statement (round 1's start).

- [ ] **Step 4: Add the seam methods for character-triggered dispatch**

```ts
import { DISPATCH_TURN, DISPATCH_ACTION, TRANSFORM_DAMAGE, INVOKE_MECHANIC_ACTION } from "./mechanics/symbols.js";
import { EMIT_CUE } from "./presentation.js";
import { MAX_EFFECTS_PER_EVENT } from "./mechanics/mechanic.js";
import type { ActionDetail } from "./character/character.js"; // verify export path

[DISPATCH_TURN](phase: "start" | "end", actor: IPlayerCharacter): void {
  if (this.#mechanics.length === 0) return;
  const hook = phase === "start" ? "onTurnStart" : "onTurnEnd";
  const actorView = this.#characterView(actor);
  runReducers(this.#mechanics,
    (m) => m.mechanic[hook]?.({ ...this.#hookCtx(m), actor: actorView }),
    (e) => applyEffect(this, e));
}

[DISPATCH_ACTION](detail: ActionDetail, actor: IPlayerCharacter): void {
  if (this.#mechanics.length === 0) return;
  const actorView = this.#characterView(actor);
  runReducers(this.#mechanics,
    (m) => m.mechanic.onAction?.({ ...this.#hookCtx(m), actor: actorView, action: detail }),
    (e) => applyEffect(this, e));
}

[TRANSFORM_DAMAGE](dv: DamageView): number {
  if (this.#mechanics.length === 0) return dv.amount;
  return runDamageTransformers(this.#mechanics, dv,
    (m) => this.#hookCtx(m),
    (key, value) => this[EMIT_CUE]({ kind: "mechanic", cue: { text: `${key} fixed damage at ${value}.` } }));
}

[INVOKE_MECHANIC_ACTION](mechanicKey: string, actionKey: string, actor: IPlayerCharacter): void {
  const m = this.#mechanics.find((x) => x.key === mechanicKey);
  if (!m) throw new ProceduralViolation(`Mechanic '${mechanicKey}' is not enabled.`);
  const action = m.mechanic.actions?.[actionKey];
  if (!action) throw new ProceduralViolation(`Mechanic '${mechanicKey}' has no action '${actionKey}'.`);
  const ctx = {
    ...this.#hookCtx(m),
    actor: this.#characterView(actor),
    action: { kind: "mechanicAction", mechanic: mechanicKey, action: actionKey } as ActionDetail,
  };
  const effects = action.run(ctx) ?? [];
  if (effects.length > MAX_EFFECTS_PER_EVENT) {
    throw new ProceduralViolation(`Mechanic action '${mechanicKey}.${actionKey}' emitted too many effects.`);
  }
  for (const e of effects) applyEffect(this, e);
}
```

- [ ] **Step 5: Write a campaign-level test (round hooks fire + transform)**

```ts
// src/lib/campaign.test.ts (add)
import { TRANSFORM_DAMAGE } from "./mechanics/symbols.js";

it("fires onRoundEnd reducers before outcome resolution", () => {
  const reg = defineRegistry({
    items: {},
    mechanics: { doom: { initialState: () => ({ n: 0 }),
      onRoundEnd: (h) => { h.state.n += 1; return [{ kind: "cue", cue: { text: `n=${h.state.n}` } }]; } } },
  });
  const { campaign } = startMinimal(reg, [["doom", undefined]]); // helper authoring + begin
  const cues: unknown[] = [];
  campaign.onCue((c) => cues.push(c));
  completeRound(campaign); // helper: act with all party, then endRound()
  expect(cues).toContainEqual({ kind: "mechanic", cue: { text: "n=1" } });
});

it("TRANSFORM_DAMAGE applies a ward short-circuit", () => {
  const reg = defineRegistry({
    items: {},
    mechanics: { ward: { initialState: () => ({}), modifyDamage: () => ({ value: 0, final: true }) } },
  });
  const { campaign, player } = startMinimal(reg, [["ward", undefined]]);
  expect(campaign[TRANSFORM_DAMAGE]({ amount: 10, target: player.id, stat: StatType.Health, source: undefined })).toBe(0);
});
```

(Use/extend the suite's existing campaign-bootstrap helpers; `startMinimal`/`completeRound` are illustrative names — match what `campaign.test.ts` already provides.)

- [ ] **Step 6: Run + commit**

Run: `pnpm vitest run src/lib/campaign.test.ts && pnpm typecheck`
Expected: PASS.

```bash
git add src/lib/campaign.ts src/lib/campaign.test.ts
git commit -m "$(printf 'feat(mechanics): campaign state, round hooks, dispatch seams\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 8: Character integration — turn/action dispatch, damage transform, custom actions

**Files:**
- Modify: `src/lib/character/character.ts` (`startTurn`/`endTurn` turn dispatch; `recordAction` action dispatch for budgeted actions; `takeDamage` transform; `useMechanicAction` + `isActionMap` registration)
- Modify: `src/lib/presentation.ts` (add `"mechanicAction"` to `ActionKind`) and the `ActionDetail` union (add the `mechanicAction` member — locate per Task 1 Step 1)
- Modify: `src/lib/character/character.test.ts`

**Interfaces:**
- Produces: `Character.useMechanicAction(mechanicKey: string, actionKey: string): void` (budgeted, registered by identity in `isActionMap`); `ActionKind` gains `"mechanicAction"`; `ActionDetail` gains `{ kind: "mechanicAction"; mechanic: string; action: string }`.
- Consumes: `Campaign[DISPATCH_TURN]`/`[DISPATCH_ACTION]`/`[TRANSFORM_DAMAGE]`/`[INVOKE_MECHANIC_ACTION]` (Task 7); `attemptAction`/`recordAction` (existing).

- [ ] **Step 1: Extend `ActionKind` and `ActionDetail`**

Add `"mechanicAction"` to the `ActionKind` union (in `presentation.ts`, where `ActionKind` is declared), and add a matching member to the `ActionDetail` union:

```ts
// ActionDetail union (wherever it's declared)
| { kind: "mechanicAction"; mechanic: string; action: string }
```

- [ ] **Step 2: Wire turn dispatch into `startTurn` / `endTurn`**

```ts
import { DISPATCH_TURN, DISPATCH_ACTION, TRANSFORM_DAMAGE, INVOKE_MECHANIC_ACTION } from "../mechanics/symbols.js";

startTurn() {
  this.actionsThisRound = 0;
  this.events.onTurnStart();
  this.#afflictions.onTurnStart(this.#floorAndSnapshot(), this.#passiveImmunities());
  this.campaign[DISPATCH_TURN]("start", this as unknown as IPlayerCharacter);
}

endTurn() {
  this.events.onTurnEnd();
  this.#reconcile();
  this.campaign[DISPATCH_TURN]("end", this as unknown as IPlayerCharacter);
}
```

- [ ] **Step 3: Wire `onAction` dispatch into `recordAction` (budgeted only)**

Update the tail of `recordAction` (`character.ts:484-505`):

```ts
const budgeted = this.isActionMap.get(callingFn) === true;
if (budgeted) {
  this.actionsThisRound = this.actionsThisRound + 1;
  this.campaign[DISPATCH_ACTION]({ ...detail, round: this.campaign.round }, this as unknown as IPlayerCharacter);
}
if (this.actionsThisRound === this.actionsPerRound) {
  this.endTurn();
}
```

(`onAction` fires only for budgeted actions, after the budget ticks and before any auto-`endTurn`. The applier never calls `recordAction`, so this cannot re-enter — guardrail D.)

- [ ] **Step 4: Insert the damage transformer into `takeDamage`**

In `takeDamage` (`character.ts:879-914`), replace the stat-application line:

```ts
// was: this.stats[attackStat] = this.stats[attackStat] - finalAttackStrength;
const dealt = this.campaign[TRANSFORM_DAMAGE]({
  amount: finalAttackStrength, target: this.id, stat: attackStat, source: undefined,
});
this.stats[attackStat] = this.stats[attackStat] - dealt;
```

And record the actually-dealt amount:

```ts
this.recordAction(this.takeDamage, { kind: "takeDamage", amount: dealt, stat: attackStat });
```

- [ ] **Step 5: Write the failing `useMechanicAction` test**

```ts
// src/lib/character/character.test.ts (add)
it("useMechanicAction runs the verb, applies effects, and ticks the action budget", () => {
  const reg = defineRegistry({
    items: {},
    mechanics: { rally: { initialState: () => ({}),
      actions: { shout: { run: (h) => [{ kind: "heal", target: h.actor.id, amount: 0 }] } } } },
  });
  const { player } = startMinimal(reg, [["rally", undefined]]);
  const before = player.actionsThisRound;
  player.useMechanicAction("rally", "shout");
  expect(player.actionsThisRound).toBe(before + 1); // counted against the round
});
```

- [ ] **Step 6: Implement `useMechanicAction` and register it**

In the `Character` constructor, near `this.isActionMap.set(this.move, true)`:

```ts
this.isActionMap.set(this.useMechanicAction, true);
```

Add the method:

```ts
useMechanicAction(mechanicKey: string, actionKey: string): void {
  if (!this.attemptAction(this.useMechanicAction, false)) return; // status-gated, not a move
  this.campaign[INVOKE_MECHANIC_ACTION](mechanicKey, actionKey, this as unknown as IPlayerCharacter);
  this.recordAction(this.useMechanicAction, { kind: "mechanicAction", mechanic: mechanicKey, action: actionKey });
}
```

(v1 treats every custom action as cost 1 via the standard budget path. The `cost` field on `CustomAction` is accepted by the type and reserved for a later enhancement; document it as cost-1-only for now to avoid the strict-equality budget-skip hazard in `recordAction`.)

- [ ] **Step 7: Run targeted + full suite, then commit**

Run: `pnpm vitest run src/lib/character/character.test.ts && pnpm checks`
Expected: PASS; full lint+typecheck+test green.

```bash
git add src/lib/character/character.ts src/lib/presentation.ts src/lib/character/character.test.ts
git commit -m "$(printf 'feat(mechanics): character turn/action/damage dispatch + custom actions\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 9: Serialization (snapshot field, schema 4→5, round-trip)

**Files:**
- Modify: `src/lib/serialization/types.ts:13, 94-125` (`SCHEMA_VERSION` 4→5; `mechanics` field on `CampaignCoreSnapshot`)
- Modify: `src/lib/serialization/deserializer.ts:75-94` (`migrate` v4→v5)
- Modify: `src/lib/campaign.ts` (`[SERIALIZE]` writes mechanics; `[HYDRATE_CATALOG]` re-attaches by key)
- Modify: `src/lib/serialization/roundtrip.test.ts` (or the serialization suite)

**Interfaces:**
- Produces: `CampaignCoreSnapshot.mechanics: { key: string; state: JsonValue }[]`; `SCHEMA_VERSION = 5`; migrate step injecting `mechanics: []`.
- Consumes: `registry.mechanic(key)` (Task 5); `#mechanics` (Task 7).

- [ ] **Step 1: Write the failing round-trip test**

```ts
// src/lib/serialization/roundtrip.test.ts (add)
it("round-trips mechanic state by key and re-attaches behavior", () => {
  const reg = defineRegistry({
    items: {},
    mechanics: { doom: { initialState: () => ({ doom: 0 }),
      onRoundEnd: (h) => { h.state.doom += 1; return []; } } },
  });
  const { campaign } = startMinimal(reg, [["doom", undefined]]);
  completeRound(campaign);              // doom -> 1
  const snap = serializeCampaign(campaign);
  const back = deserializeCampaign(snap, { registry: reg });
  // behavior fresh from registry; state intact: a second round makes doom 2
  completeRound(back);
  const snap2 = serializeCampaign(back);
  expect(snap2.campaign.mechanics).toContainEqual({ key: "doom", state: { doom: 2 } });
});

it("rejects a snapshot whose mechanic key is not registered", () => {
  const reg = defineRegistry({ items: {}, mechanics: { doom: { initialState: () => ({}) } } });
  const { campaign } = startMinimal(reg, [["doom", undefined]]);
  const snap = serializeCampaign(campaign);
  const bare = defineRegistry({ items: {} });
  expect(() => deserializeCampaign(snap, { registry: bare })).toThrow(/No mechanic registered/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/lib/serialization/roundtrip.test.ts -t "mechanic"`
Expected: FAIL — `mechanics` is undefined on the snapshot.

- [ ] **Step 3: Add the snapshot field + bump the schema version**

In `serialization/types.ts`:

```ts
export const SCHEMA_VERSION = 5;
```

Add to `CampaignCoreSnapshot`:

```ts
/** Opted-in mechanics: registry key + serialized state. Behavior re-attaches by key. */
mechanics: { key: string; state: JsonValue }[];
```

(Import `JsonValue` from `../mechanics/mechanic.js`.)

- [ ] **Step 4: Add the migrate step**

In `deserializer.ts` `migrate()`, before the final version check:

```ts
// v4 → v5: custom mechanics introduced in schema 5. Pre-mechanics campaigns
// have none and hydrate inert (preserving the opt-in invariant).
if (data.schemaVersion === 4) {
  data.campaign.mechanics = [];
  data.schemaVersion = 5;
}
```

- [ ] **Step 5: Serialize + hydrate the mechanics**

In `campaign.ts` `[SERIALIZE]()`, add to the returned object (validate JSON-serializability best-effort):

```ts
mechanics: this.#mechanics.map((m) => ({ key: m.key, state: m.state })),
```

In `[HYDRATE_CATALOG](core, registry)`, after the conditions are re-attached:

```ts
this.#mechanics = core.mechanics.map((m) => ({
  key: m.key,
  mechanic: registry.mechanic(m.key), // ProceduralViolation if missing
  state: m.state as JsonObject,
}));
```

(`initialState` is **not** called on hydrate — only at authoring. State restores verbatim.)

- [ ] **Step 6: Run serialization suite + full checks, then commit**

Run: `pnpm vitest run src/lib/serialization && pnpm checks`
Expected: PASS. Confirm pre-existing snapshot fixtures still load (the v4→v5 migration covers them).

```bash
git add src/lib/serialization/types.ts src/lib/serialization/deserializer.ts src/lib/campaign.ts src/lib/serialization/roundtrip.test.ts
git commit -m "$(printf 'feat(mechanics): serialize mechanic state by key (schema v5)\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 10: Integration + determinism test

**Files:**
- Modify: `src/integration.test.ts`

**Interfaces:**
- Consumes: the whole feature end-to-end via `authorTemplate(...).useMechanic(...).build()` + the real session lifecycle.

- [ ] **Step 1: Write the integration test (doom-clock + fire-ward + determinism)**

```ts
// src/integration.test.ts (add)
import { mulberry32 } from "./test-utils.js"; // or the seeded rng the suite already uses

function buildScenario(seed: number) {
  const reg = defineRegistry({
    items: { ward: () => makeArmorItem("ward") }, // an equippable item registered as "ward"
    mechanics: {
      doom: {
        initialState: (cfg: { doomAt: number }) => ({ doom: 0, doomAt: cfg.doomAt }),
        onRoundEnd: (h) => {
          h.state.doom += 1;
          return h.state.doom >= h.state.doomAt
            ? [{ kind: "cue", cue: { text: "The doom clock strikes." } }]
            : [];
        },
      },
      "fire-ward": {
        initialState: () => ({}),
        // Negates all health damage while the ward is equipped; opted in FIRST so it pre-empts.
        modifyDamage: (d, h) =>
          h.view.party.some((p) => p.id === d.target && p.hasEquipped("ward"))
            ? { value: 0, final: true }
            : d.amount,
      },
    },
  });
  return authorTemplate("Crypt", reg, { rng: mulberry32(seed) })
    .room("start").startAt("start")
    .useMechanic("fire-ward")               // first => precedence
    .useMechanic("doom", { doomAt: 3 })
    .build();
}

it("ticks a doom clock, pre-empts warded damage, and survives serialize/hydrate", () => {
  const campaign = buildScenario(1);
  // ...add a player, begin, equip the ward, complete rounds via the real lifecycle...
  // assert: warded player takes 0 from a damaging action; doom cue fires on round 3;
  // serialize -> deserialize -> doom state preserved and behavior still fires.
});

it("is deterministic: same seed => identical cue/effect sequence", () => {
  const a = runFullScenario(buildScenario(7)); // helper collecting the cue log
  const b = runFullScenario(buildScenario(7));
  expect(a).toEqual(b);
});
```

Flesh out the lifecycle calls and the `makeArmorItem`/`runFullScenario` helpers to match the patterns already in `src/integration.test.ts` and `src/test-utils.ts`. The assertions must verify: (a) doom state increments per round and the cue fires at the threshold; (b) the ward transformer returns `final` and zeroes damage to the equipped player; (c) a serialize→hydrate cycle preserves `doom` and re-binds behavior; (d) two same-seed runs produce identical cue logs.

- [ ] **Step 2: Run + full checks, then commit**

Run: `pnpm vitest run src/integration.test.ts && pnpm checks`
Expected: PASS.

```bash
git add src/integration.test.ts
git commit -m "$(printf 'test(mechanics): end-to-end doom-clock + ward + determinism\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 11: Documentation

**Files:**
- Modify: `README.md` (new "Custom mechanics" section)
- Modify: `docs-site/guide/data-model.md` (ER diagrams)
- Modify: TSDoc across `src/lib/mechanics/*.ts`, `registerMechanic`, `.useMechanic`, `useMechanicAction`
- Modify: the authoring guide page under `docs-site/guide/`

- [ ] **Step 1: README "Custom mechanics" section**

Add a section under the mechanics chapters covering: the reducer/transformer taxonomy; opt-in via `.useMechanic(key, config?)` with opt-in order = precedence; the closed `Effect` vocabulary and clamping applier; the three guardrails (integrity / determinism / termination); transformer `final` short-circuit; custom actions via the budgeted `useMechanicAction`; and the by-key serialization. State the v1 exclusions verbatim from the spec's Non-Goals (no item-grant/campaign-end effects, no reducer short-circuit, no element-typed damage).

- [ ] **Step 2: Data-model diagrams**

In `docs-site/guide/data-model.md`, add the campaign↔`Mechanic`(+ namespaced state) relationship to the live-campaign ER diagram, and the `useMechanic` refs (key + config) to the template diagram. Validate both Mermaid blocks render.

- [ ] **Step 3: TSDoc**

Ensure TSDoc on `Mechanic`, the hook contexts, `Effect`, `CustomAction`, `MechanicKeyOf`, `registerMechanic`, `.useMechanic`, and `useMechanicAction` (the purity/JSON-object-state contract, opt-in-order precedence, and the clamping/short-circuit rules).

- [ ] **Step 4: Authoring guide**

Add an authoring-guide subsection: writing a mechanic, the purity + JSON-object-state contract, opt-in order, and a worked doom-clock example.

- [ ] **Step 5: Build docs, run full checks, commit**

Run: `pnpm docs:build && pnpm checks`
Expected: docs build clean; full suite green.

```bash
git add README.md docs-site/guide/data-model.md docs-site/guide/*.md src/lib/mechanics
git commit -m "$(printf 'docs(mechanics): README, data-model, TSDoc, authoring guide\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Self-Review (completed)

**Spec coverage:** unified system (reducers + transformer + custom actions + typed state) ✅ Tasks 1,3,4,7,8; opt-in/config ✅ Tasks 5,6; guardrail A (closed Effect union + clamping applier + seams) ✅ Tasks 1,2,3; guardrail B (injected rng, pure ctx) ✅ Tasks 1,7; guardrail D (collect-then-apply, cap, non-reentrancy) ✅ Task 4; transformer `final` short-circuit + observable cue ✅ Tasks 1,4,7; typed namespaced state + by-key serialization + schema v5 migrate ✅ Task 9; authoring `.useMechanic` + validation ✅ Task 6; docs ✅ Task 11; integration + determinism ✅ Task 10. Reducer short-circuit correctly **absent** (deferred per Non-Goals).

**Type consistency:** `LiveMechanic { key, mechanic, state }` used identically in Tasks 1/4/6/7/9; `Effect` kinds match between `mechanic.ts`, `apply.ts`, and tests; dispatch signatures (`runReducers`/`runDamageTransformers`) match between Task 4 definition and Task 7 call sites; symbols (`ADJUST_STAT`, `FIND_CHARACTER`, `DISPATCH_TURN`, `DISPATCH_ACTION`, `TRANSFORM_DAMAGE`, `INVOKE_MECHANIC_ACTION`) defined once in `mechanics/symbols.ts` (Task 2) and consumed in Tasks 3/7/8.

**Implementer verification notes (not placeholders):** the few getter names that must be confirmed against current code are flagged inline with "verify": `ActionDetail` export path, `c.status` / `c.currentRoom` getter names, item `originKey` (SET_ORIGIN), `attemptAction` signature, and the `ActionKind`/`ActionDetail` declaration sites. These are real lookups in-repo, with concrete code given for each.
