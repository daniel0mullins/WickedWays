# Combatant Base Class Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the shared `attack` into a new `Combatant` base class, reparent `PlayerCharacter` and `Mob` onto it, and complete `Mob` (escape) so the project typechecks.

**Architecture:** A new `abstract class Combatant extends Character` holds `attack` (moved verbatim from `PlayerCharacter`) and registers it as a recordable action. `PlayerCharacter` and `Mob` both extend `Combatant`; `NonPlayerCharacter` stays on `Character`. `Mob.escape()` flees to an adjacent room using existing primitives.

**Tech Stack:** TypeScript, Vitest. Tests: `npm test`. Full gate: `npm run checks` (lint + typecheck + test).

---

## File Structure

- **Create** `src/lib/character/combatant.ts` — `ICombatant` interface + `abstract class Combatant extends Character` with the shared `attack` and its action registration.
- **Modify** `src/lib/character/player-character.ts` — extend `Combatant`, drop the local `attack` (now inherited), prune now-unused imports.
- **Modify** `src/lib/character/mob.ts` — extend `Combatant`, drop the `attack` interface line, implement `escape`, register it.
- **Create** `src/lib/character/mob.test.ts` — unit tests for `Mob` (inherited attack + escape).
- The existing `src/lib/character/player-character.test.ts` is the regression gate for the `attack` extraction and must stay green **unmodified**.

Reference facts (verified against current source — do not guess):

- `Character` constructor is `(campaign, name, stats, inventorySlots = 5, actionsPerRound = 3)`. It registers `addToInventory`/`removeFromInventory` in `isActionMap` and exposes `recordAction(fn)`, which increments the action counter only when `isActionMap.get(fn)` is `true`, and calls `endTurn()` when the count reaches `actionsPerRound`.
- `recordAction` keys off the exact function reference. A method defined on `Combatant` and accessed as `this.attack` from any subclass instance resolves to `Combatant.prototype.attack` — the same reference registered in the constructor — so `isActionMap.get(this.attack)` is `true`.
- `Character.move(room)` calls `recordAction(this.move)`. `Mob` does **not** register `move`, so `move()` inside `escape()` performs the real room transition without counting as an action — `escape` is the counted action.
- `Room` constructor's 3rd arg is typed as a full `Record<Direction, IRoom>`; a bare `{}` fails `tsc`. Existing tests use a `type ExitsArg = ConstructorParameters<typeof Room>[2]` alias and write `{} as ExitsArg` (see `src/lib/room.test.ts`). `Room.addExit(direction, room)` adds a one-way exit; directions are strings like `"north"`.
- `mob.ts` is currently an untracked work-in-progress that fails `tsc` (`TS2420: Class 'Mob' incorrectly implements interface 'IMob'` — missing `attack`, `escape`). It will be committed as part of Task 2.

---

## Task 1: Create `Combatant` and reparent `PlayerCharacter`

This is a behavior-preserving refactor. The existing `player-character.test.ts` `attack` suite is the safety net — it must stay green **without edits**.

**Files:**
- Create: `src/lib/character/combatant.ts`
- Modify: `src/lib/character/player-character.ts`

- [ ] **Step 1: Create `src/lib/character/combatant.ts`**

```ts
import { ICampaign } from "../campaign";
import { typedEntries } from "../util";
import { Character, ICharacter } from "./character";
import { Stats, StatType } from "./stats";

export interface ICombatant extends ICharacter {
  attack: <C extends ICharacter>(c: C) => void;
}

export abstract class Combatant extends Character implements ICombatant {
  constructor(
    campaign: ICampaign,
    name: string,
    stats: Stats,
    inventorySlots: number = 5,
    actionsPerRound: number = 3,
  ) {
    super(campaign, name, stats, inventorySlots, actionsPerRound);
    this.isActionMap.set(this.attack, true);
  }

  attack(c: ICharacter) {
    // Find the equipped weapon(s)
    const weapons = this.inventory.items.filter(
      (item) => item.properties.equipped && item.type === "weapon",
    );

    const attackMatrix: Record<StatType, number> = {
      // If there are no equipped weapons, do an unarmed attack against defender health
      [StatType.Health]: weapons.length === 0 ? 1 : 0,
      [StatType.Energy]: 0,
      [StatType.Sanity]: 0,
    };

    // Fill up the attack matrix with a single loop
    weapons.forEach((weapon) => {
      attackMatrix[weapon.stat] += weapon.modifier;
    });

    // Inflict the damage for each stat type to the defender
    for (const [stat, strength] of typedEntries(attackMatrix)) {
      if (strength > 0) {
        c.takeDamage(strength, stat);
      }
    }
    this.recordAction(this.attack);
  }
}
```

- [ ] **Step 2: Reparent `PlayerCharacter` onto `Combatant`**

Replace the entire contents of `src/lib/character/player-character.ts` with:

```ts
import { ICampaign } from "../campaign";
import { IItem } from "../inventory";
import { ILoot } from "../loot";
import { ProceduralViolation } from "../util";
import { Combatant, ICombatant } from "./combatant";
import { Stats } from "./stats";

export interface IPlayerCharacter extends ICombatant {
  joinCampaign: () => void;
  openLootBox: (lootBox: ILoot) => readonly IItem[];
  takeFromLootBox: (lootBox: ILoot, item: IItem | IItem[]) => IItem[];
  putInLootBox: (lootBox: ILoot, item: IItem | IItem[]) => IItem[];
}

export class PlayerCharacter extends Combatant implements IPlayerCharacter {
  constructor(
    campaign: ICampaign,
    name: string,
    stats: Stats,
    inventorySlots: number = 5,
  ) {
    super(campaign, name, stats, inventorySlots);

    this.isActionMap.set(this.move, true);
  }

  joinCampaign() {
    const { party } = this.campaign;
    if (!party.includes(this)) {
      party.push(this);
    }
  }

  #requireCoLocated(lootBox: ILoot) {
    if (!this.currentRoom?.loot.has(lootBox.id)) {
      throw new ProceduralViolation(
        "Cannot interact with a loot box that is not in the current room",
      );
    }
  }

  openLootBox(lootBox: ILoot): readonly IItem[] {
    this.#requireCoLocated(lootBox);
    return [...lootBox.contents];
  }

  takeFromLootBox(lootBox: ILoot, item: IItem | IItem[]): IItem[] {
    this.#requireCoLocated(lootBox);
    // Reuse removeItems + addToInventory rather than the raw holder primitives:
    // addToInventory already fires pickUp and records exactly one action.
    const requested = Array.isArray(item) ? item : [item];
    const present = requested.filter((requestedItem) =>
      lootBox.contents.some((boxItem) => boxItem.id === requestedItem.id),
    );
    const free = this.inventory.slots - this.inventory.items.length;
    const toTake = present.slice(0, free);
    const removed = lootBox.removeItems(toTake.map((taken) => taken.id));
    if (removed.length > 0) {
      this.addToInventory(removed);
    }
    return removed;
  }

  putInLootBox(lootBox: ILoot, item: IItem | IItem[]): IItem[] {
    this.#requireCoLocated(lootBox);
    // Reuse removeFromInventory + stowItem rather than the raw holder primitives:
    // removeFromInventory records exactly one action; stowItem re-claims the box as holder.
    const requested = Array.isArray(item) ? item : [item];
    const present = requested.filter((requestedItem) =>
      this.inventory.items.some((held) => held.id === requestedItem.id),
    );
    const free = lootBox.capacity - lootBox.contents.length;
    const toPut = present.slice(0, free);
    if (toPut.length > 0) {
      this.removeFromInventory(toPut);
      for (const putItem of toPut) {
        lootBox.stowItem(putItem);
      }
    }
    return toPut;
  }
}
```

(`attack` and its `isActionMap.set(this.attack, …)` are gone — inherited from `Combatant`. The `./character` import is dropped entirely: `PlayerCharacter` no longer references `Character` or `ICharacter` directly.)

- [ ] **Step 3: Run the existing PlayerCharacter test suite (regression gate)**

Run: `npm test -- src/lib/character/player-character.test.ts`
Expected: PASS (31 tests). In particular "registers move and attack as recordable actions" and the whole `describe("attack", …)` block still pass — `pc.attack` now resolves to `Combatant.prototype.attack`, registered by `Combatant`'s constructor.

- [ ] **Step 4: Typecheck and lint the two files**

Run: `npx tsc --noEmit`
Expected: the ONLY remaining error is the pre-existing `src/lib/character/mob.ts(11,…): error TS2420` (Mob not yet reparented). `combatant.ts` and `player-character.ts` must produce no errors. (Task 2 clears the mob error.)

Run: `npx eslint src/lib/character/combatant.ts src/lib/character/player-character.ts`
Expected: no issues.

- [ ] **Step 5: Commit**

```bash
git add src/lib/character/combatant.ts src/lib/character/player-character.ts
git commit -m "Extract attack into a Combatant base class"
```

---

## Task 2: Reparent `Mob` and implement `escape`

**Files:**
- Create: `src/lib/character/mob.test.ts`
- Modify: `src/lib/character/mob.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/character/mob.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import type { ICampaign } from "../campaign";
import type { IItem } from "../inventory";

import { Room } from "../room";
import { Combatant } from "./combatant";
import { type ICharacter } from "./character";
import { Mob } from "./mob";
import { StatType, type Stats } from "./stats";

type ExitsArg = ConstructorParameters<typeof Room>[2];

function makeStats(overrides: Partial<Stats> = {}): Stats {
  return {
    [StatType.Health]: 10,
    [StatType.Sanity]: 10,
    [StatType.Energy]: 10,
    ...overrides,
  };
}

function makeCampaign(): ICampaign {
  return {} as ICampaign;
}

function makeMob(opts: { actionsPerRound?: number; drops?: IItem[] } = {}) {
  return new Mob(
    makeCampaign(),
    "Goblin",
    makeStats(),
    2,
    opts.actionsPerRound ?? 2,
    opts.drops ?? [],
  );
}

function makeDefender(): ICharacter {
  return { takeDamage: vi.fn() } as unknown as ICharacter;
}

describe("Mob", () => {
  describe("constructor", () => {
    it("is a Combatant", () => {
      expect(makeMob()).toBeInstanceOf(Combatant);
    });

    it("registers attack and escape as recordable actions", () => {
      const mob = makeMob();

      expect(mob.isActionMap.get(mob.attack)).toBe(true);
      expect(mob.isActionMap.get(mob.escape)).toBe(true);
    });
  });

  describe("attack", () => {
    it("makes a 1-point unarmed health attack inherited from Combatant", () => {
      const mob = makeMob();
      const defender = makeDefender();

      mob.attack(defender);

      expect(defender.takeDamage).toHaveBeenCalledTimes(1);
      expect(defender.takeDamage).toHaveBeenCalledWith(1, StatType.Health);
    });
  });

  describe("escape", () => {
    it("flees to an adjacent room", () => {
      const mob = makeMob();
      const den = new Room("Den", [], {} as ExitsArg);
      const cave = new Room("Cave", [], {} as ExitsArg);
      den.addExit("north", cave);
      mob.move(den);

      mob.escape();

      expect(mob.currentRoom).toBe(cave);
      expect(cave.occupants).toContain(mob);
      expect(den.occupants).not.toContain(mob);
    });

    it("records escape as an action", () => {
      const mob = makeMob({ actionsPerRound: 1 });
      const den = new Room("Den", [], {} as ExitsArg);
      const cave = new Room("Cave", [], {} as ExitsArg);
      den.addExit("north", cave);
      mob.move(den);
      mob.startTurn(); // reset the (no-op) action count from move()
      const onTurnEnd = vi.spyOn(mob.events, "onTurnEnd");

      mob.escape();

      expect(onTurnEnd).toHaveBeenCalledTimes(1);
    });

    it("does not throw and still records when the mob is in no room", () => {
      const mob = makeMob({ actionsPerRound: 1 });
      const onTurnEnd = vi.spyOn(mob.events, "onTurnEnd");

      expect(() => mob.escape()).not.toThrow();
      expect(mob.currentRoom).toBeNull();
      expect(onTurnEnd).toHaveBeenCalledTimes(1);
    });

    it("does not move when the current room has no exits", () => {
      const mob = makeMob();
      const sealed = new Room("Sealed", [], {} as ExitsArg);
      mob.move(sealed);

      mob.escape();

      expect(mob.currentRoom).toBe(sealed);
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/lib/character/mob.test.ts`
Expected: FAIL — `Mob` is not a `Combatant` and `mob.escape` does not exist yet (and the file does not typecheck).

- [ ] **Step 3: Reparent `Mob` and implement `escape`**

Replace the entire contents of `src/lib/character/mob.ts` with:

```ts
import { ICampaign } from "../campaign";
import { IItem } from "../inventory";
import { Combatant, ICombatant } from "./combatant";
import { Stats } from "./stats";

export interface IMob extends ICombatant {
  escape: () => void;
}

export class Mob extends Combatant implements IMob {
  constructor(
    campaign: ICampaign,
    name: string,
    stats: Stats,
    inventorySlots: number = 2,
    actionsPerRound: number = 2,
    drops: IItem[],
  ) {
    const _inventorySlots = Math.max(inventorySlots, drops.length);
    super(campaign, name, stats, _inventorySlots, actionsPerRound);

    this.isActionMap.set(this.escape, true);
  }

  escape() {
    // Flee through the first available exit. The move() transition fires the
    // room's exit/enter scenes; because Mob does not register `move`, that
    // call does not consume an action — `escape` is the recorded action.
    const exits = [...(this.currentRoom?.exits.values() ?? [])];
    const destination = exits[0];
    if (destination) {
      this.move(destination);
    }
    this.recordAction(this.escape);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- src/lib/character/mob.test.ts`
Expected: PASS (all `Mob` tests).

- [ ] **Step 5: Typecheck and lint**

Run: `npx tsc --noEmit`
Expected: NO errors (the previous `mob.ts` TS2420 is now resolved — `attack` is inherited and `escape` is implemented).

Run: `npx eslint src/lib/character/mob.ts src/lib/character/mob.test.ts`
Expected: no issues.

- [ ] **Step 6: Commit**

```bash
git add src/lib/character/mob.ts src/lib/character/mob.test.ts
git commit -m "Reparent Mob onto Combatant and implement escape"
```

---

## Task 3: Full verification gate

**Files:** none (verification only)

- [ ] **Step 1: Run the complete checks**

Run: `npm run checks`
Expected: `eslint` clean, `tsc --noEmit` clean, and all tests pass (campaign, player-character, mob, integration, and the rest).

- [ ] **Step 2: If anything fails, fix it and re-run**

Address any failure surfaced above, then re-run `npm run checks` until clean. Commit any fixes:

```bash
git add -A
git commit -m "Fix lint/type/test issues from Combatant extraction"
```
