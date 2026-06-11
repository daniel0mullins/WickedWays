# Status Effect Consequences Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the four statuses (KO, Panic, Fear, Confused) real mechanical consequences — action gating, self-clearing rolls, and two-source immunity — extracted into a dedicated `Afflictions` unit.

**Architecture:** A new `Afflictions` class (`src/lib/character/afflictions.ts`) owns the status matrix, per-turn clear rolls, shaken-off latches, and immunity timers. `Character` delegates to it and gates each action method at entry. Randomness flows through a new `roll()` dice primitive (`src/lib/dice.ts`). Immunity is authored declaratively via two new `Item` descriptor fields (`immunities`, `grantsImmunity`) — no factory.

**Tech Stack:** TypeScript, Vitest (`npm test` → `vitest run`; `expect`/`vi`), the existing branded-id + symbol-seam engine conventions.

**Spec:** `docs/superpowers/specs/2026-06-11-status-effect-consequences-design.md`

---

## Design decisions & spec deltas (review these first)

These were resolved during planning. They are implementation-level but a few touch observable API — confirm during plan review:

1. **`craft` return type becomes `IItem | null`.** A Confused fizzle must abort the craft, and craft returns an item, so the honest type is `IItem | null` (null = fumbled). `ICharacter.craft`, `Character.craft`, and call sites/tests update accordingly.
2. **Loot methods are gated.** `PlayerCharacter.takeFromLootBox` / `putInLootBox` consume actions (via internal `addToInventory`/`removeFromInventory`) and must respect Panic/Confused. They gate at their own top and run their internal inventory mutations under a gate-suppression guard so the gate fires exactly once (no double Confused roll, no partial box mutation). This extends the spec's gated set by these two methods.
3. **Re-entrancy via `#withGateSuppressed`.** The one pre-existing same-character composition (`Mob.escape` → `this.move`) plus the loot methods need the inner gated call to not re-gate. A private `#suppressGate` flag handles this uniformly.
4. **`rng` is held on `Afflictions`, injected at construction**, not passed per call. `onTurnStart(effective, passiveImmune)` and `gate(isMove)` read the held `rng`. (Spec sketched `onTurnStart(rng, …)`; holding it is cleaner and equivalent.)
5. **New `fumble` history kind** records a Confused fumble (`{ kind: "fumble"; action: string }`).
6. **Immunity timing is pinned by test** (see Task 6): a grant of `turns = N` keeps the status immune across the next `N` of the character's `startTurn` reconciliations; the timer is consumed once per turn at the end of `onTurnStart`.
7. **Existing-test determinism:** the new clear roll fires on `startTurn`. Tests that hold an active non-KO status across a `startTurn` must inject a deterministic `rng` so the status doesn't randomly clear. Task 6 includes an audit step.
8. **`use` is the always-allowed escape hatch, but it consumes the item via the *budgeted* `removeFromInventory`.** So `use` is NOT free — it ticks the budget today, and that's preserved. To keep `use` working while Panicked/Confused, the `Use` wrapper consumes through a new gate-suppressed seam `[CONSUME_VIA_USE]` (which records the drop and ticks the budget as before, but skips the affliction gate). `use` itself is never passed to `attemptAction`. **KO is the exception:** the `Use` wrapper explicitly throws if the holder is KO'd, since KO blocks everything.
9. **`transferKey` adds to the recipient before relinquishing from the giver**, so that if the recipient's (gated) `addToInventory` blocks, the key isn't lost from the giver. The giver's `transferKey` is gated on the giver; the recipient's receipt remains gated on the recipient.

---

## File map

- **Create** `src/lib/dice.ts` — `roll(sides, rng)` primitive.
- **Create** `src/lib/dice.test.ts`.
- **Create** `src/lib/character/afflictions.ts` — `Afflictions` class, `AfflictionConfig`, `DEFAULT_AFFLICTION_CONFIG`, `GateVerdict`.
- **Create** `src/lib/character/afflictions.test.ts`.
- **Modify** `src/lib/character/history.ts` — add `fumble` entry kind + `describeAction` case.
- **Modify** `src/lib/inventory.ts` — `GRANT_IMMUNITY` symbol; `immunities` / `grantsImmunity` descriptor fields; `Use` wrapper applies `grantsImmunity`.
- **Modify** `src/lib/character/character.ts` — delegate status to `Afflictions`; `rng`/config constructor option; `#reconcile`; `passiveImmunities`; `[GRANT_IMMUNITY]`; action gating helpers; gate every action method; `craft` → `IItem | null`.
- **Modify** `src/lib/character/combatant.ts` — gate `attack`.
- **Modify** `src/lib/character/mob.ts` — gate `escape` (and suppress the inner `move`).
- **Modify** `src/lib/character/player-character.ts` — gate `takeFromLootBox` / `putInLootBox` (suppress inner inventory calls).
- **Modify** `README.md` — document consequences, clearing, immunity.

---

## Task 1: Dice primitive

**Files:**
- Create: `src/lib/dice.ts`
- Test: `src/lib/dice.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/dice.test.ts
import { describe, expect, it } from "vitest";
import { roll } from "./dice";

describe("roll", () => {
  it("returns 1 for the bottom of the range", () => {
    expect(roll(6, () => 0)).toBe(1);
  });

  it("returns `sides` for the top of the range", () => {
    expect(roll(6, () => 0.999)).toBe(6);
    expect(roll(100, () => 0.999)).toBe(100);
  });

  it("defaults to a d100", () => {
    expect(roll(undefined, () => 0.5)).toBe(51);
  });

  it("never escapes [1, sides] across the unit interval", () => {
    for (const r of [0, 0.01, 0.25, 0.5, 0.75, 0.99, 0.999999]) {
      const v = roll(20, () => r);
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(20);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/dice.test.ts`
Expected: FAIL — `Cannot find module './dice'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/dice.ts
/**
 * Rolls a single die with `sides` faces, returning an integer in `[1, sides]`.
 *
 * The standard TTRPG die. Defaults to a d100 (percentile). `rng` is injectable
 * for deterministic tests and defaults to `Math.random`; it must yield a float in
 * `[0, 1)`.
 *
 * @param sides - Number of faces. Defaults to 100.
 * @param rng - Float source in `[0, 1)`. Defaults to `Math.random`.
 * @returns An integer in `[1, sides]`.
 */
export function roll(sides: number = 100, rng: () => number = Math.random): number {
  return Math.floor(rng() * sides) + 1;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/dice.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/dice.ts src/lib/dice.test.ts
git commit -m "feat: add roll() dice primitive (d100 default, injectable rng)"
```

---

## Task 2: Afflictions unit — state & reconciliation

**Files:**
- Create: `src/lib/character/afflictions.ts`
- Test: `src/lib/character/afflictions.test.ts`

Reconciliation (`applyFromStats`) is pure: given effective stats and a passive-immunity set, it sets each flag using the latch / shaken-off / immunity / KO-precedence rules. No RNG here.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/character/afflictions.test.ts
import { describe, expect, it } from "vitest";
import { Status } from "../status";
import { StatType, type Stats } from "./stats";
import { Afflictions } from "./afflictions";

const NONE = new Set<Status>();
// effective-stat snapshot helper (keys are StatType values)
const stats = (health: number, sanity: number, energy: number): Stats => ({
  [StatType.Health]: health,
  [StatType.Sanity]: sanity,
  [StatType.Energy]: energy,
});

describe("Afflictions.applyFromStats", () => {
  it("starts normal", () => {
    const a = new Afflictions(() => 0.5);
    expect(a.isNormal).toBe(true);
    expect(a.list).toEqual([]);
  });

  it("latches Panic at sanity <= 0 and Fear in (0, 5)", () => {
    const a = new Afflictions(() => 0.5);
    a.applyFromStats(stats(10, 0, 10), NONE);
    expect(a.list).toEqual([Status.Panic]);

    a.applyFromStats(stats(10, 3, 10), NONE);
    expect(a.list).toEqual([Status.Fear]);

    a.applyFromStats(stats(10, 5, 10), NONE);
    expect(a.isNormal).toBe(true);
  });

  it("sets Confused at energy <= 0 with a (0, 1] hold band", () => {
    const a = new Afflictions(() => 0.5);
    a.applyFromStats(stats(10, 10, 0), NONE);
    expect(a.list).toEqual([Status.Confused]);
    // hold band: stays Confused
    a.applyFromStats(stats(10, 10, 1), NONE);
    expect(a.list).toEqual([Status.Confused]);
    // above the band: clears
    a.applyFromStats(stats(10, 10, 2), NONE);
    expect(a.isNormal).toBe(true);
  });

  it("KO wipes the other statuses", () => {
    const a = new Afflictions(() => 0.5);
    a.applyFromStats(stats(10, 0, 0), NONE); // Panic + Confused
    a.applyFromStats(stats(0, 0, 0), NONE); // KO
    expect(a.list).toEqual([Status.KO]);
  });

  it("passive immunity suppresses a status and resets its episode", () => {
    const a = new Afflictions(() => 0.5);
    a.applyFromStats(stats(10, 0, 10), new Set([Status.Panic]));
    expect(a.isNormal).toBe(true);
    // immunity lifts, stat still depleted -> applies fresh
    a.applyFromStats(stats(10, 0, 10), NONE);
    expect(a.list).toEqual([Status.Panic]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/character/afflictions.test.ts`
Expected: FAIL — `Cannot find module './afflictions'`.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/character/afflictions.ts
import { roll } from "../dice";
import { Status } from "../status";
import type { Stats } from "./stats";

/** The three non-KO statuses that self-clear and can be immunized. */
const CLEARABLE = [Status.Panic, Status.Fear, Status.Confused] as const;
type Clearable = (typeof CLEARABLE)[number];

/** Per-status clear odds (percent, vs a d100) and the Confused fizzle chance. */
export type AfflictionConfig = {
  clear: Record<Clearable, { base: number; increment: number }>;
  confusedFailChance: number;
};

export const DEFAULT_AFFLICTION_CONFIG: AfflictionConfig = {
  clear: {
    [Status.Fear]: { base: 40, increment: 30 },
    [Status.Panic]: { base: 20, increment: 20 },
    [Status.Confused]: { base: 15, increment: 15 },
  },
  confusedFailChance: 50,
};

/** The outcome of gating an attempted action. */
export type GateVerdict =
  | { kind: "allow" }
  | { kind: "fizzle" }
  | { kind: "block"; reason: string };

const clamp = (n: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, n));

/**
 * Owns a character's status lifecycle: which statuses are active, how long each
 * has been latched (for the increasing clear odds), which were "shaken off" early
 * while their stat is still depleted, and timed immunity counters. All randomness
 * (clear rolls, Confused fizzle) goes through the injected `rng` via {@link roll}.
 */
export class Afflictions {
  #rng: () => number;
  #config: AfflictionConfig;
  #active = new Map<Status, boolean>();
  #turnsActive = new Map<Clearable, number>();
  #shakenOff = new Set<Clearable>();
  #immunity = new Map<Clearable, number>();

  constructor(
    rng: () => number = Math.random,
    config: AfflictionConfig = DEFAULT_AFFLICTION_CONFIG,
  ) {
    this.#rng = rng;
    this.#config = config;
    for (const s of [Status.KO, ...CLEARABLE]) this.#active.set(s, false);
  }

  /** The currently-active statuses. */
  get list(): Status[] {
    return [...this.#active.entries()]
      .filter(([, on]) => on)
      .map(([s]) => s);
  }

  /** Whether no status is active. */
  get isNormal(): boolean {
    return [...this.#active.values()].every((on) => !on);
  }

  #immune(s: Clearable, passiveImmune: Set<Status>): boolean {
    return passiveImmune.has(s) || (this.#immunity.get(s) ?? 0) > 0;
  }

  // Drop a status out of its current episode entirely.
  #clearEpisode(s: Clearable) {
    this.#active.set(s, false);
    this.#shakenOff.delete(s);
    this.#turnsActive.set(s, 0);
  }

  // below = stat is past the affliction threshold this resolution.
  #resolve(s: Clearable, below: boolean, passiveImmune: Set<Status>) {
    if (this.#immune(s, passiveImmune) || !below) {
      this.#clearEpisode(s);
      return;
    }
    this.#active.set(s, !this.#shakenOff.has(s));
  }

  /**
   * Recomputes every flag from the current effective stats. Pure: no RNG, no timer
   * mutation. `passiveImmune` is the set of equipment-conferred immunities.
   */
  applyFromStats(effective: Stats, passiveImmune: Set<Status>) {
    if (effective.health <= 0) {
      this.#active.set(Status.KO, true);
      for (const s of CLEARABLE) this.#clearEpisode(s);
      return;
    }
    this.#active.set(Status.KO, false);

    this.#resolve(Status.Panic, effective.sanity <= 0, passiveImmune);
    this.#resolve(
      Status.Fear,
      effective.sanity > 0 && effective.sanity < 5,
      passiveImmune,
    );

    // Confused keeps a (0, 1] hold band so it doesn't flicker near the boundary.
    if (effective.energy <= 0) {
      this.#resolve(Status.Confused, true, passiveImmune);
    } else if (effective.energy > 1) {
      this.#resolve(Status.Confused, false, passiveImmune);
    } else if (this.#immune(Status.Confused, passiveImmune)) {
      this.#clearEpisode(Status.Confused);
    }
  }

  /**
   * Grants timed immunity to `statuses` for `turns` of the character's turns
   * (refreshing to the longer). KO is never immunizable and is ignored. Resets the
   * episode for each granted status so it restarts fresh when immunity lapses.
   */
  grantImmunity(statuses: Status[], turns: number) {
    for (const s of statuses) {
      if (s === Status.KO) continue;
      const clearable = s as Clearable;
      this.#immunity.set(
        clearable,
        Math.max(this.#immunity.get(clearable) ?? 0, turns),
      );
      this.#clearEpisode(clearable);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/character/afflictions.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/character/afflictions.ts src/lib/character/afflictions.test.ts
git commit -m "feat: Afflictions unit — stat-derived status reconciliation with latch/immunity"
```

---

## Task 3: Afflictions — clearing rolls & immunity tick (`onTurnStart`)

**Files:**
- Modify: `src/lib/character/afflictions.ts`
- Test: `src/lib/character/afflictions.test.ts`

`onTurnStart` runs once per the character's turn: increment `turnsActive` and roll each active non-KO status (success → shaken off), reconcile, then consume one turn of each immunity timer.

- [ ] **Step 1: Write the failing test**

```ts
// append to src/lib/character/afflictions.test.ts
describe("Afflictions.onTurnStart", () => {
  it("clears a latched status when the d100 roll succeeds (Fear: 40% turn 1)", () => {
    // roll = floor(0.39 * 100) + 1 = 40 <= 40 -> clears
    const a = new Afflictions(() => 0.39);
    a.applyFromStats(stats(10, 3, 10), NONE); // Fear
    a.onTurnStart(stats(10, 3, 10), NONE);
    expect(a.isNormal).toBe(true);
  });

  it("keeps the status when the roll fails, and the chance rises next turn", () => {
    // roll = 41 > 40 (turn 1 Fear), then 41 <= 70 (turn 2) -> clears
    const a = new Afflictions(() => 0.4);
    a.applyFromStats(stats(10, 3, 10), NONE);
    a.onTurnStart(stats(10, 3, 10), NONE);
    expect(a.list).toEqual([Status.Fear]); // survives turn 1
    a.onTurnStart(stats(10, 3, 10), NONE);
    expect(a.isNormal).toBe(true); // clears turn 2
  });

  it("stays shaken off even though the stat is still depleted", () => {
    const a = new Afflictions(() => 0); // roll = 1, always clears
    a.applyFromStats(stats(10, 3, 10), NONE);
    a.onTurnStart(stats(10, 3, 10), NONE);
    a.applyFromStats(stats(10, 3, 10), NONE); // reconcile with stat still low
    expect(a.isNormal).toBe(true);
  });

  it("never rolls KO away", () => {
    const a = new Afflictions(() => 0); // would clear anything rollable
    a.applyFromStats(stats(0, 10, 10), NONE);
    a.onTurnStart(stats(0, 10, 10), NONE);
    expect(a.list).toEqual([Status.KO]);
  });

  it("timed immunity covers exactly N turns then lapses", () => {
    const a = new Afflictions(() => 0.999); // rolls never clear (roll = 100)
    a.grantImmunity([Status.Panic], 2);
    a.applyFromStats(stats(10, 0, 10), NONE); // immune -> normal

    a.onTurnStart(stats(10, 0, 10), NONE); // turn 1: immune
    expect(a.isNormal).toBe(true);
    a.onTurnStart(stats(10, 0, 10), NONE); // turn 2: immune
    expect(a.isNormal).toBe(true);
    a.onTurnStart(stats(10, 0, 10), NONE); // turn 3: lapsed -> Panic
    expect(a.list).toEqual([Status.Panic]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/character/afflictions.test.ts`
Expected: FAIL — `a.onTurnStart is not a function`.

- [ ] **Step 3: Add `onTurnStart` to `Afflictions`**

Insert this method into the `Afflictions` class (e.g. after `applyFromStats`):

```ts
  /**
   * The per-turn time step: roll each active non-KO status for an early clear
   * (chance rises with `turnsActive`), reconcile, then consume one turn of each
   * immunity timer. A status immune this turn is covered before its timer ticks,
   * so a grant of `N` covers the next `N` turns.
   */
  onTurnStart(effective: Stats, passiveImmune: Set<Status>) {
    for (const s of CLEARABLE) {
      if (!this.#active.get(s)) continue;
      const turns = (this.#turnsActive.get(s) ?? 0) + 1;
      this.#turnsActive.set(s, turns);
      const { base, increment } = this.#config.clear[s];
      const p = clamp(base + increment * (turns - 1), 0, 100);
      if (roll(100, this.#rng) <= p) this.#shakenOff.add(s);
    }

    this.applyFromStats(effective, passiveImmune);

    for (const [s, remaining] of [...this.#immunity.entries()]) {
      if (remaining <= 1) this.#immunity.delete(s);
      else this.#immunity.set(s, remaining - 1);
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/character/afflictions.test.ts`
Expected: PASS (10 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/lib/character/afflictions.ts src/lib/character/afflictions.test.ts
git commit -m "feat: Afflictions.onTurnStart — clearing rolls and immunity tick-down"
```

---

## Task 4: Afflictions — action gating (`gate`)

**Files:**
- Modify: `src/lib/character/afflictions.ts`
- Test: `src/lib/character/afflictions.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// append to src/lib/character/afflictions.test.ts
describe("Afflictions.gate", () => {
  it("allows everything when normal", () => {
    const a = new Afflictions(() => 0.5);
    expect(a.gate(true)).toEqual({ kind: "allow" });
    expect(a.gate(false)).toEqual({ kind: "allow" });
  });

  it("KO blocks every action", () => {
    const a = new Afflictions(() => 0.5);
    a.applyFromStats(stats(0, 10, 10), NONE);
    expect(a.gate(true).kind).toBe("block");
    expect(a.gate(false).kind).toBe("block");
  });

  it("Panic blocks non-move but allows move", () => {
    const a = new Afflictions(() => 0.5);
    a.applyFromStats(stats(10, 0, 10), NONE);
    expect(a.gate(false).kind).toBe("block");
    expect(a.gate(true).kind).toBe("allow");
  });

  it("Fear blocks move but allows others", () => {
    const a = new Afflictions(() => 0.5);
    a.applyFromStats(stats(10, 3, 10), NONE);
    expect(a.gate(true).kind).toBe("block");
    expect(a.gate(false).kind).toBe("allow");
  });

  it("Confused fizzles on a failed roll, allows on a passed roll", () => {
    // confusedFailChance 50: roll <= 50 -> fizzle
    const fizzle = new Afflictions(() => 0.49); // roll 50
    fizzle.applyFromStats(stats(10, 10, 0), NONE);
    expect(fizzle.gate(false).kind).toBe("fizzle");

    const pass = new Afflictions(() => 0.5); // roll 51
    pass.applyFromStats(stats(10, 10, 0), NONE);
    expect(pass.gate(false).kind).toBe("allow");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/character/afflictions.test.ts`
Expected: FAIL — `a.gate is not a function`.

- [ ] **Step 3: Add `gate` to `Afflictions`**

```ts
  /**
   * Verdict for an attempted action. Hard blocks (KO, Panic-on-non-move,
   * Fear-on-move) come first; an active Confused then rolls a fizzle. `use` is
   * never gated by the caller, so it never reaches here.
   */
  gate(isMove: boolean): GateVerdict {
    if (this.#active.get(Status.KO)) {
      return { kind: "block", reason: "Cannot act while KO'd." };
    }
    if (this.#active.get(Status.Panic) && !isMove) {
      return { kind: "block", reason: "Panicked: can only move." };
    }
    if (this.#active.get(Status.Fear) && isMove) {
      return { kind: "block", reason: "Too afraid to move." };
    }
    if (this.#active.get(Status.Confused)) {
      if (roll(100, this.#rng) <= this.#config.confusedFailChance) {
        return { kind: "fizzle" };
      }
    }
    return { kind: "allow" };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/character/afflictions.test.ts`
Expected: PASS (15 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/lib/character/afflictions.ts src/lib/character/afflictions.test.ts
git commit -m "feat: Afflictions.gate — block/fizzle verdicts for action gating"
```

---

## Task 5: `fumble` history kind

**Files:**
- Modify: `src/lib/character/history.ts`
- Test: `src/lib/character/history.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// append to src/lib/character/history.test.ts (it already imports describeAction
// from "./history" and uses vitest's describe/it/expect)
it("describes a fumble", () => {
  expect(
    describeAction({ kind: "fumble", round: 2, action: "attack" }),
  ).toBe("fumbled attack");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/character/history.test.ts`
Expected: FAIL — type error / no `fumble` case.

- [ ] **Step 3: Extend the union and `describeAction`**

In `src/lib/character/history.ts`, add to the `ActionHistoryEntry` union (after the `takeDamage` member):

```ts
  | { kind: "takeDamage"; round: number; amount: number; stat: StatType }
  | { kind: "fumble"; round: number; action: string };
```

And add a case to `describeAction`'s switch:

```ts
    case "takeDamage":
      return `took ${entry.amount} ${entry.stat} damage`;
    case "fumble":
      return `fumbled ${entry.action}`;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/character/history.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/character/history.ts src/lib/character/history.test.ts
git commit -m "feat: add fumble action-history kind"
```

---

## Task 6: Wire Afflictions into Character + immunity seam & fields

This is the integration task. It swaps Character's status internals for `Afflictions`, adds the `rng`/config constructor option, threads effective stats + passive immunity into reconciliation, and lands the immunity authoring end-to-end (symbol seam, Item fields, `Use` wrapper).

**Files:**
- Modify: `src/lib/inventory.ts`
- Modify: `src/lib/character/character.ts`
- Modify: `src/lib/character/combatant.ts`, `player-character.ts`, `mob.ts` (constructor option pass-through only)
- Test: `src/lib/character/character.test.ts`

- [ ] **Step 1: Add the `GRANT_IMMUNITY` symbol and Item immunity fields (`inventory.ts`)**

Near the other exported seam symbols in `src/lib/inventory.ts` (e.g. alongside `EQUIP`/`UNEQUIP`):

```ts
/**
 * Symbol-keyed seam used to grant timed status immunity to a character holder.
 * Only the item `Use` path calls it, keeping grants unforgeable by stray code.
 */
export const GRANT_IMMUNITY = Symbol("GRANT_IMMUNITY");

/**
 * Symbol-keyed seam the item `Use` path uses to consume the item. It removes the
 * item with affliction gating suppressed (use is the always-allowed escape hatch)
 * while preserving the existing drop record and budget tick.
 */
export const CONSUME_VIA_USE = Symbol("CONSUME_VIA_USE");
```

Import `Status` at the top of `inventory.ts`:

```ts
import { Status } from "./status";
```

Add to the `IItem` interface (near `teaches`):

```ts
  /** Statuses this item confers immunity to while equipped (passive immunity). */
  readonly immunities?: Status[];
  /** On use, grants timed immunity to these statuses for `turns` of the holder's turns. */
  readonly grantsImmunity?: { statuses: Status[]; turns: number };
```

Add both to the constructor descriptor destructure, the descriptor type, and assignment (mirroring `teaches`):

```ts
// in the destructured params:
      teaches,
      immunities,
      grantsImmunity,
// in the param type:
      teaches?: CraftingRecipe;
      immunities?: Status[];
      grantsImmunity?: { statuses: Status[]; turns: number };
// in the constructor body, alongside `this.teaches = teaches;`:
    this.immunities = immunities;
    this.grantsImmunity = grantsImmunity;
```

Declare the public readonly fields on the class (near `readonly teaches?`):

```ts
  readonly immunities?: Status[];
  readonly grantsImmunity?: { statuses: Status[]; turns: number };
```

- [ ] **Step 2: Apply `grantsImmunity` in the `Use` wrapper (`inventory.ts`)**

Update the `[ItemAction.Use]` wrapper (currently lines ~414–420) to apply a timed grant after the authored use, before the item is consumed:

```ts
      [ItemAction.Use]: () => {
        const holder = this.#characterHolder();
        if (!holder) return;
        // `use` is the always-allowed escape hatch UNDER Panic/Fear/Confused, but
        // a KO'd character can do nothing at all — including use an item.
        if (holder.status.includes(Status.KO)) {
          throw new ProceduralViolation("Cannot use items while KO'd.");
        }
        actions[ItemAction.Use](holder);
        events.onUse?.(holder);
        if (this.grantsImmunity) {
          holder[GRANT_IMMUNITY](
            this.grantsImmunity.statuses,
            this.grantsImmunity.turns,
          );
        }
        // Consume via the gate-suppressed seam so a Panicked/Confused holder can
        // still use the item; this still records the drop and ticks the budget.
        holder[CONSUME_VIA_USE](this);
      },
```

(`holder[GRANT_IMMUNITY]` and `holder[CONSUME_VIA_USE]` typecheck once Step 4 declares them on `ICharacter`.)

- [ ] **Step 3a: Extend the test helpers in `character.test.ts`**

Add `import { SlotKind } from "../equipment";` (the file already imports `EquipmentSlot`, `Status`, `StatType`, `Item`).

Extend `makeGear`'s options + descriptor so it can author immunity items (add to the `opts` type and the descriptor/properties passed to `new Item`):

```ts
function makeGear(opts: {
  type?: ItemDescriptor["type"];
  name?: string;
  slot?: ItemDescriptor["slot"];
  twoHanded?: boolean;
  stat?: StatType;
  modifier?: number;
  equippable?: boolean;
  usable?: boolean;                 // NEW
  immunities?: Status[];            // NEW
  grantsImmunity?: { statuses: Status[]; turns: number }; // NEW
}): Item {
  const noop = () => {};
  return new Item(
    {
      type: opts.type ?? "armor",
      recipe: { metal: 1 },
      modifier: opts.modifier ?? 1,
      stat: opts.stat ?? StatType.Health,
      name: opts.name ?? "Gear",
      slot: opts.slot,
      twoHanded: opts.twoHanded,
      immunities: opts.immunities,
      grantsImmunity: opts.grantsImmunity,
    },
    { equippable: opts.equippable ?? true, equipped: false, destroyable: true, usable: opts.usable ?? false },
    { pickUp: noop, equip: noop, unequip: noop, transfer: noop, use: noop, destroy: () => null },
    { onPickUp: noop },
  );
}
```

Extend `makeCharacter` to forward an injectable `rng` (add `rng?: () => number` to its `opts` and pass an options object to the constructor):

```ts
function makeCharacter(opts: {
  stats?: Partial<Stats>;
  inventorySlots?: number;
  actionsPerRound?: number;
  rng?: () => number;               // NEW
} = {}) {
  return new Character(
    makeCampaign(),
    "Hero",
    makeStats(opts.stats),
    opts.inventorySlots,
    opts.actionsPerRound,
    { rng: opts.rng },
  );
}
```

- [ ] **Step 3b: Write the failing tests (`character.test.ts`)**

```ts
describe("status consequences — wiring & immunity", () => {
  it("derives Panic from depleted sanity (unchanged surface)", () => {
    const c = makeCharacter({ stats: { [StatType.Sanity]: 0 }, rng: () => 0.999 });
    c.takeDamage(0, StatType.Sanity); // forces a reconcile
    expect(c.status).toEqual([Status.Panic]);
  });

  it("passive immunity: an equipped ward (modifier 0) suppresses Panic", () => {
    const c = makeCharacter({ stats: { [StatType.Sanity]: 0 }, rng: () => 0.999 });
    const ward = makeGear({
      type: "accessory", slot: SlotKind.Finger, stat: StatType.Sanity,
      modifier: 0, immunities: [Status.Panic],
    });
    c.addToInventory(ward);
    c.equip(ward);
    c.takeDamage(0, StatType.Sanity); // reconcile
    expect(c.isNormal).toBe(true);

    c.unequip(ward);
    c.takeDamage(0, StatType.Sanity); // reconcile -> reapplies
    expect(c.status).toEqual([Status.Panic]);
  });

  it("timed immunity: using a consumable grants N turns via the seam", () => {
    const c = makeCharacter({ stats: { [StatType.Sanity]: 0 }, rng: () => 0.999 });
    const tonic = makeGear({
      type: "consumable", equippable: false, usable: true, modifier: 0,
      stat: StatType.Sanity, grantsImmunity: { statuses: [Status.Panic], turns: 2 },
    });
    c.addToInventory(tonic);
    tonic.actions.use();   // applies immunity, then consumes
    c.endTurn();           // reconcile while immune
    expect(c.isNormal).toBe(true);
  });
});
```

- [ ] **Step 4: Replace Character's status internals (`character.ts`)**

Imports: drop `Status, StatusMatrix` from `../status` if no longer referenced directly (keep `Status` — it's used in types), add the afflictions + symbol imports:

```ts
import { Status } from "../status";
import {
  Afflictions,
  AfflictionConfig,
  DEFAULT_AFFLICTION_CONFIG,
} from "./afflictions";
import {
  CLAIM, CONSUME_VIA_USE, DEPOSIT_MATERIALS, EQUIP, GRANT_IMMUNITY, IItem,
  IItemHolder, Inventory, MaterialMap, SET_DURABILITY, UNEQUIP,
} from "../inventory";
```

Replace the `#status: StatusMatrix;` field with:

```ts
  #afflictions: Afflictions;
```

Delete `#resetStatuses()` and `#resolveStatuses()`. Replace the `isNormal` / `status` getters:

```ts
  get isNormal() {
    return this.#afflictions.isNormal;
  }

  get status() {
    return this.#afflictions.list;
  }
```

Add a private reconcile + an effective-stats snapshot + passive-immunity collector:

```ts
  // Effective-stat snapshot (base floored at 0, plus equipped-accessory bonuses).
  #effectiveSnapshot(): Stats {
    this.stats[StatType.Health] = Math.max(0, this.stats[StatType.Health]);
    this.stats[StatType.Sanity] = Math.max(0, this.stats[StatType.Sanity]);
    this.stats[StatType.Energy] = Math.max(0, this.stats[StatType.Energy]);
    return {
      [StatType.Health]: this.effectiveStat(StatType.Health),
      [StatType.Sanity]: this.effectiveStat(StatType.Sanity),
      [StatType.Energy]: this.effectiveStat(StatType.Energy),
    };
  }

  /** Statuses currently immunized by equipped, intact gear (passive immunity). */
  passiveImmunities(): Set<Status> {
    const set = new Set<Status>();
    for (const item of this.#inventory.items) {
      if (!item.properties.equipped || item.isBroken || !item.immunities) continue;
      for (const s of item.immunities) set.add(s);
    }
    return set;
  }

  #reconcile() {
    this.#afflictions.applyFromStats(
      this.#effectiveSnapshot(),
      this.passiveImmunities(),
    );
  }

  /** Grants timed status immunity. Engine-internal: only the item Use path calls it. */
  [GRANT_IMMUNITY](statuses: Status[], turns: number) {
    this.#afflictions.grantImmunity(statuses, turns);
  }

  // Set while a gated action is mid-flight so a nested same-character gated call
  // (escape -> move, loot -> add/remove, use -> remove) doesn't re-gate/re-roll.
  #suppressGate = false;

  /** Runs `fn` with affliction gating suppressed (same-character composition only). */
  protected withGateSuppressed<T>(fn: () => T): T {
    const prev = this.#suppressGate;
    this.#suppressGate = true;
    try {
      return fn();
    } finally {
      this.#suppressGate = prev;
    }
  }

  /**
   * Consumes an item on behalf of the item `Use` path: removes it with gating
   * suppressed (use is always allowed) while keeping the drop record + budget tick.
   */
  [CONSUME_VIA_USE](item: IItem) {
    this.withGateSuppressed(() => this.removeFromInventory(item));
  }
```

In the constructor, add the option and build `Afflictions` (replace the `#status` init + `#resetStatuses()` call):

```ts
  constructor(
    campaign: ICampaign,
    name: string,
    stats: Stats,
    inventorySlots: number = 5,
    actionsPerRound: number = 3,
    options: { rng?: () => number; afflictionConfig?: AfflictionConfig } = {},
  ) {
    // ... existing assignments ...
    this.#afflictions = new Afflictions(
      options.rng,
      options.afflictionConfig ?? DEFAULT_AFFLICTION_CONFIG,
    );
    // remove: this.#status = new Map(...); this.#resetStatuses();
    this.isActionMap.set(this.addToInventory, true);
    this.isActionMap.set(this.removeFromInventory, true);
  }
```

Swap the three `#resolveStatuses()` calls for `#reconcile()`:
- in `takeDamage` (was `this.#resolveStatuses();` before `recordAction`),
- in `endTurn`,
- and replace the `#resolveStatuses()` in `startTurn` with the affliction turn-step:

```ts
  endTurn() {
    this.events.onTurnEnd();
    this.#reconcile();
  }

  startTurn() {
    this.actionsThisRound = 0;
    this.events.onTurnStart();
    this.#afflictions.onTurnStart(
      this.#effectiveSnapshot(),
      this.passiveImmunities(),
    );
  }
```

Declare both seams on the `ICharacter` interface (near the other method members):

```ts
  /** Grants timed status immunity; engine-internal (item Use path only). */
  [GRANT_IMMUNITY]: (statuses: Status[], turns: number) => void;
  /** Consumes an item for the Use path, gating suppressed; engine-internal. */
  [CONSUME_VIA_USE]: (item: IItem) => void;
```

Also import `CONSUME_VIA_USE` in the `ICharacter`/`inventory` import group shown above (already included).

- [ ] **Step 5: Thread the constructor option through subclasses**

`combatant.ts` — widen the constructor and forward:

```ts
  constructor(
    campaign: ICampaign,
    name: string,
    stats: Stats,
    inventorySlots: number = 5,
    actionsPerRound: number = 3,
    options: { rng?: () => number; afflictionConfig?: AfflictionConfig } = {},
  ) {
    super(campaign, name, stats, inventorySlots, actionsPerRound, options);
    this.isActionMap.set(this.attack, true);
  }
```

Add the import in `combatant.ts`: `import type { AfflictionConfig } from "./afflictions";`

`player-character.ts` — accept options and forward (keeping default actionsPerRound):

```ts
  constructor(
    campaign: ICampaign,
    name: string,
    stats: Stats,
    inventorySlots: number = 5,
    options: { rng?: () => number; afflictionConfig?: AfflictionConfig } = {},
  ) {
    super(campaign, name, stats, inventorySlots, 3, options);
    this.isActionMap.set(this.move, true);
  }
```

Add `import type { AfflictionConfig } from "./afflictions";` to `player-character.ts`.

`mob.ts` — add options after `drops` and forward:

```ts
  constructor(
    campaign: ICampaign,
    name: string,
    stats: Stats,
    inventorySlots: number = 2,
    actionsPerRound: number = 2,
    drops: IItem[],
    options: { rng?: () => number; afflictionConfig?: AfflictionConfig } = {},
  ) {
    const _inventorySlots = Math.max(inventorySlots, drops.length);
    super(campaign, name, stats, _inventorySlots, actionsPerRound, options);
    this.isActionMap.set(this.escape, true);
  }
```

Add `import type { AfflictionConfig } from "./afflictions";` to `mob.ts`.

- [ ] **Step 6: Determinism audit of existing tests**

Run the full suite:

Run: `npm test`

At this stage only the clear roll is new (gating arrives in Task 7). Some existing tests deplete a non-KO stat and then call `startTurn`, expecting the status to persist; the new clear roll (default `Math.random`) can now clear it, making them flaky. For each such failing/flaky test, inject a non-clearing rng via the helper: `makeCharacter({ stats, rng: () => 0.999 })` (a d100 of 100 only clears at a guaranteed turn), or pass `{ rng: () => 0.999 }` to the relevant constructor directly. Do not change assertions — only inject determinism.

Expected after fixes: the previously-green tests pass deterministically, and the Step-3 tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/lib/inventory.ts src/lib/character/character.ts \
  src/lib/character/combatant.ts src/lib/character/player-character.ts \
  src/lib/character/mob.ts src/lib/character/character.test.ts
git commit -m "feat: Character delegates status to Afflictions; passive + timed immunity"
```

---

## Task 7: Action gating across Character and subclasses

Add the gate helpers and apply them at the entry of every gated method. `block` throws `ProceduralViolation`; `fizzle` records a fumble (budget ticks only for budgeted actions, via `recordAction`) and aborts.

**Files:**
- Modify: `src/lib/character/character.ts`, `combatant.ts`, `mob.ts`, `player-character.ts`
- Test: `src/lib/character/character.test.ts`

- [ ] **Step 1: Write the failing tests (`character.test.ts`)**

Character-level gating in `character.test.ts` (base `Character` has `move`, `addToInventory`, `craft`, `equip`):

```ts
describe("status consequences — gating", () => {
  it("KO blocks a recordable action", () => {
    const c = makeCharacter({ stats: { [StatType.Health]: 0 }, rng: () => 0.999 });
    c.takeDamage(0); // reconcile -> KO
    expect(() => c.addToInventory(makeItem())).toThrow(/KO/);
  });

  it("Panic blocks non-move actions but allows move", () => {
    const c = makeCharacter({ stats: { [StatType.Sanity]: 0 }, rng: () => 0.999 });
    c.takeDamage(0, StatType.Sanity); // Panic
    expect(() => c.addToInventory(makeItem())).toThrow(/Panicked/);
    expect(() => c.move(makeRoom())).not.toThrow();
  });

  it("Fear blocks move but allows other actions", () => {
    const c = makeCharacter({ stats: { [StatType.Sanity]: 3 }, rng: () => 0.999 });
    c.takeDamage(0, StatType.Sanity); // Fear
    expect(() => c.move(makeRoom())).toThrow(/afraid/);
    expect(() => c.addToInventory(makeItem())).not.toThrow();
  });

  it("Confused fizzle records a fumble (rng 0 => roll 1 <= 50)", () => {
    const c = makeCharacter({ stats: { [StatType.Energy]: 0 }, rng: () => 0 });
    c.takeDamage(0, StatType.Energy); // Confused
    c.addToInventory(makeItem());      // attempt -> fizzles, records a fumble
    expect(c.history.at(-1)?.kind).toBe("fumble");
  });

  it("KO blocks use, but Panic does not", () => {
    const ko = makeCharacter({ stats: { [StatType.Health]: 0 }, rng: () => 0.999 });
    const tonicA = makeGear({ type: "consumable", equippable: false, usable: true, modifier: 0 });
    ko.addToInventory(tonicA); // added while still normal (no reconcile yet)
    ko.takeDamage(0);          // reconcile -> KO
    expect(() => tonicA.actions.use()).toThrow(/KO/);

    const panicked = makeCharacter({ stats: { [StatType.Sanity]: 0 }, rng: () => 0.999 });
    const tonicB = makeGear({ type: "consumable", equippable: false, usable: true, modifier: 0,
      grantsImmunity: { statuses: [Status.Panic], turns: 1 } });
    panicked.addToInventory(tonicB);
    panicked.takeDamage(0, StatType.Sanity); // Panic
    expect(() => tonicB.actions.use()).not.toThrow();
  });
});
```

> **`attack` / `escape` / loot gating** live in `player-character.test.ts` and `mob.test.ts`. Mirror the pattern above using those files' existing helpers (extend them to forward `rng` exactly as `makeCharacter` does). For example, in `mob.test.ts`: a Panicked mob's `attack` throws `/Panicked/`; a mob's `escape` calls `move` internally under `withGateSuppressed`, so a normal mob's escape still moves, and a Feared mob's `escape` (non-move) is allowed while its internal `move` is suppressed.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/character/character.test.ts`
Expected: FAIL — actions are not yet gated (no throw / no fumble).

- [ ] **Step 3: Add the `attemptAction` gate helper to `Character`**

`#suppressGate` and `withGateSuppressed` already exist (added in Task 6). Add only the gate entry point. It reads the private `#suppressGate` and `#afflictions`, so it lives in `character.ts`:

```ts
  /**
   * Gates an attempted action against active afflictions. Throws on a hard block;
   * on a Confused fizzle records a fumble (which ticks the budget when `callingFn`
   * is a budgeted action) and returns false; otherwise returns true.
   */
  protected attemptAction(callingFn: ActionFn, isMove: boolean): boolean {
    if (this.#suppressGate) return true;
    const verdict = this.#afflictions.gate(isMove);
    if (verdict.kind === "block") {
      throw new ProceduralViolation(verdict.reason);
    }
    if (verdict.kind === "fizzle") {
      this.recordAction(callingFn, { kind: "fumble", action: callingFn.name });
      return false;
    }
    return true;
  }
```

- [ ] **Step 4: Gate the Character action methods**

Add a guard as the first statement of each method. Use `isMove = true` only for `move`.

`move`:
```ts
  move(room: IRoom) {
    if (!this.attemptAction(this.move, true)) return;
    // ... existing body ...
  }
```

`addToInventory`, `removeFromInventory`, `equip`, `unequip`, `repair`, `transferKey` — same pattern with `isMove = false` and the method's own identity, e.g.:
```ts
  addToInventory(item: IItem | IItem[]) {
    if (!this.attemptAction(this.addToInventory, false)) return;
    // ... existing body ...
  }
```
```ts
  removeFromInventory(item: IItem | IItem[]) {
    if (!this.attemptAction(this.removeFromInventory, false)) return;
    // ...
  }
```
```ts
  equip(item: IItem, targetSlot?: EquipmentSlot) {
    if (!this.attemptAction(this.equip, false)) return;
    // ...
  }
```
```ts
  unequip(item: IItem) {
    if (!this.attemptAction(this.unequip, false)) return;
    // ...
  }
```
```ts
  repair(item: IItem) {
    if (!this.attemptAction(this.repair, false)) return;
    // ...
  }
```
```ts
  transferKey(key: IItem, recipient: ICharacter) {
    if (!this.attemptAction(this.transferKey, false)) return;
    const held = this.#inventory.keys.some((k) => k.id === key.id);
    if (!held) {
      throw new ProceduralViolation(
        "Attempted to transfer a key the character is not holding.",
      );
    }
    // Add to the recipient FIRST, then relinquish: if the recipient's gated
    // addToInventory blocks (e.g. KO'd ally), the key is not lost from the giver.
    recipient.addToInventory(key);
    this.relinquishItem(key);
  }
```

`craft` — returns a value, so return `null` on fizzle, and change the signature:
```ts
  craft(recipeId: RecipeId): IItem | null {
    if (!this.attemptAction(this.craft, false)) return null;
    // ... existing body unchanged ...
  }
```
Update the `ICharacter.craft` member to `craft: (recipeId: RecipeId) => IItem | null;` and its TSDoc. Fix any in-repo caller/test that assumes a non-null return (search: `.craft(`).

> Not gated (leave as-is): `harvest`, `consumeKey`, `receiveItem`/`relinquishItem` (holder primitives), `takeDamage`, `effectiveStat`.

- [ ] **Step 5: Gate `attack` (combatant.ts) and `escape` (mob.ts)**

`combatant.ts`:
```ts
  attack(c: ICharacter) {
    if (!this.attemptAction(this.attack, false)) return;
    // ... existing body ...
  }
```

`mob.ts` — gate `escape`, and suppress the inner `move` so it isn't re-gated:
```ts
  escape() {
    if (!this.attemptAction(this.escape, false)) return;
    const exits = [...(this.currentRoom?.exits.values() ?? [])];
    const destination = exits[0];
    if (destination) {
      this.withGateSuppressed(() => this.move(destination));
    }
    this.recordAction(this.escape, { kind: "escape" });
  }
```

- [ ] **Step 6: Gate the loot methods (player-character.ts)**

Gate at the top and suppress the internal inventory mutation so the gate fires once:

```ts
  takeFromLootBox(lootBox: ILoot, item: IItem | IItem[]): IItem[] {
    if (!this.attemptAction(this.takeFromLootBox, false)) return [];
    this.#requireCoLocated(lootBox);
    const requested = Array.isArray(item) ? item : [item];
    const present = requested.filter((requestedItem) =>
      lootBox.contents.some((boxItem) => boxItem.id === requestedItem.id),
    );
    const free = this.inventory.slots - this.inventory.items.length;
    const toTake = present.slice(0, free);
    const removed = lootBox.removeItems(toTake.map((taken) => taken.id));
    if (removed.length > 0) {
      this.withGateSuppressed(() => this.addToInventory(removed));
    }
    return removed;
  }

  putInLootBox(lootBox: ILoot, item: IItem | IItem[]): IItem[] {
    if (!this.attemptAction(this.putInLootBox, false)) return [];
    this.#requireCoLocated(lootBox);
    const requested = Array.isArray(item) ? item : [item];
    if (requested.some((i) => i.type === "key")) {
      throw new ProceduralViolation("Keys cannot be stored in a loot container.");
    }
    const present = requested.filter((requestedItem) =>
      this.inventory.items.some((held) => held.id === requestedItem.id),
    );
    const free = lootBox.capacity - lootBox.contents.length;
    const toPut = present.slice(0, free);
    if (toPut.length > 0) {
      this.withGateSuppressed(() => this.removeFromInventory(toPut));
      for (const putItem of toPut) {
        lootBox.stowItem(putItem);
      }
    }
    return toPut;
  }
```

`attemptAction`/`withGateSuppressed` are `protected` on `Character`, so they're accessible here. `openLootBox` is a read — leave it ungated.

- [ ] **Step 7: Run tests and audit for gating-induced failures**

Run: `npm test`

Gating is now live, so any existing test that afflicts a character (depletes a stat to a status) and then performs a gated action will now throw or fizzle. For each such failure, decide intent: if the test wasn't about gating, adjust it so the character isn't afflicted when it acts (e.g. act before depleting, or use a different stat), or assert the new throw if that's the correct behavior. Do not weaken a real assertion to hide a genuine gate.

Expected after fixes: PASS, including the Step-1 gating tests and the full existing suite.

- [ ] **Step 8: Commit**

```bash
git add src/lib/character/
git commit -m "feat: gate actions on status (block/fizzle); craft returns IItem | null"
```

---

## Task 8: Docs and full verification

**Files:**
- Modify: `README.md`
- Test: full suite + typecheck + lint

- [ ] **Step 1: Update the README "Status effects" section**

Replace the current status-effects description with the consequences: KO (no actions, even `use`; clears on revival), Panic (move/use only), Fear (no move), Confused (any gated action may fizzle and still costs it). Document the per-turn d100 clear roll for the three non-KO statuses (Fear 40/+30, Panic 20/+20, Confused 15/+15; Confused fizzle 50%), and the two immunity sources (`immunities` while equipped; `grantsImmunity` on use for N turns; KO never immunizable). Note the injectable `rng` constructor option.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors. (Confirm `craft`'s `IItem | null` ripples are resolved.)

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: clean.

- [ ] **Step 4: Full test suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: document status consequences, clearing rolls, and immunity"
```

---

## Verification checklist (spec coverage)

- KO blocks all actions incl. `use`; clears on Health > 0 — Tasks 4, 6, 7.
- Panic = move/use only; Fear = no move; Confused = fizzle-and-cost — Tasks 4, 7.
- KO wipes the other statuses — Tasks 2, 6.
- Per-status increasing d100 clear roll while stat depleted; shaken-off latch — Tasks 1, 3.
- Stat recovery still clears immediately (episode over) — Task 2.
- Passive immunity (`immunities`, equipped & intact) — Tasks 6.
- Timed immunity (`grantsImmunity` on use, N turns, refresh-to-longer, KO ignored) — Tasks 3, 6.
- Both sources combine; episode restarts fresh on lapse — Tasks 2, 3, 6.
- Declarative descriptor fields, no factory — Task 6.
- Injectable `rng` routed through the `roll()` primitive — Tasks 1–4, 6.
- Tests: `dice.test.ts`, `afflictions.test.ts`, `character.test.ts` additions, `history.test.ts` — Tasks 1–7.
