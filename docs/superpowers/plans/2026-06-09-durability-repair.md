# Durability, Armor & Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give combat equipment numeric durability that wears with use, can be authored broken/worn, and is repaired from the party material pool — and give armor a real damage-mitigation role.

**Architecture:** Durability is item state on `Item` (a `maxDurability` field, a private current value, an `isBroken` getter, and a `Symbol`-keyed clamping setter following the existing `CLAIM`/`DEPOSIT_MATERIALS`/`DEPLETE` privileged-mutator pattern). Combat decrements it: `Combatant.attack` wears intact weapons and excludes broken ones; `Character.takeDamage` lets equipped armor soak raw attack strength and wears the armor that absorbed the blow. `Character.repair` restores an item to full for a proportional, material-pool cost.

**Tech Stack:** TypeScript (strict, NodeNext), Vitest, typescript-eslint (recommendedTypeChecked). Reuses the material economy on `Campaign` (`canAfford` / `withdrawMaterials`).

**Design spec:** `docs/superpowers/specs/2026-06-09-durability-repair-design.md`

---

## File Structure

- `src/lib/inventory.ts` — **modify.** Add the `SET_DURABILITY` symbol; add `maxDurability` / `durability` / `isBroken` to the `IItem` interface and `Item` class; thread `maxDurability` / `durability` through the constructor descriptor. Single source of durability state. (`createKey` needs no change — keys simply omit durability.)
- `src/lib/inventory.test.ts` — **modify.** Unit-test the durability data model and the clamping setter.
- `src/lib/character/combatant.ts` — **modify.** `attack` excludes broken weapons and wears the intact ones it swung.
- `src/lib/character/player-character.test.ts` — **modify.** Weapon-wear behavior through `attack`, plus the end-to-end durability seam (real `Item`s, real `Campaign`).
- `src/lib/character/character.ts` — **modify.** Armor mitigation + wear in `takeDamage`; new `Character.repair`; `repair` on the `ICharacter` interface; imports for `SET_DURABILITY`, `MaterialMap`, `typedEntries`.
- `src/lib/character/character.test.ts` — **modify.** Armor mitigation/wear tests and repair tests.

Each task is self-contained and ends with a green run + a commit. Run all commits with the footer:

```
Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
```

A note on running filtered tests: Vitest treats `-t` patterns as regex, so **do not** put `()` in a `-t` filter (it silently matches nothing). The steps below run whole test files.

---

## Task 1: Durability data model on `Item`

**Files:**
- Modify: `src/lib/inventory.ts`
- Test: `src/lib/inventory.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/inventory.test.ts`. First extend the import on line 5 to pull in `SET_DURABILITY`:

```ts
import { CLAIM, DEPOSIT_MATERIALS, Item, SET_DURABILITY, createKey, type IItemHolder } from "./inventory";
```

Then add this helper near the other factories (after `makeItem`, before `describe("Item", …)`), and a new `describe` block:

```ts
function makeDurable(maxDurability?: number, durability?: number) {
  return new Item(
    {
      type: "weapon",
      recipe: { metal: 1 },
      modifier: 2,
      stat: StatType.Health,
      name: "Sword",
      maxDurability,
      durability,
    },
    { equippable: true, equipped: false, destroyable: true, usable: true },
    makeActions(),
    makeEvents(),
  );
}

describe("durability", () => {
  it("defaults current durability to maxDurability when not authored", () => {
    const item = makeDurable(10);
    expect(item.maxDurability).toBe(10);
    expect(item.durability).toBe(10);
    expect(item.isBroken).toBe(false);
  });

  it("honors an authored starting durability", () => {
    expect(makeDurable(10, 4).durability).toBe(4);
  });

  it("clamps an authored durability into [0, maxDurability]", () => {
    expect(makeDurable(10, 99).durability).toBe(10);
    expect(makeDurable(10, -5).durability).toBe(0);
  });

  it("is broken when durability reaches 0", () => {
    const item = makeDurable(10, 0);
    expect(item.isBroken).toBe(true);
  });

  it("has no durability when maxDurability is omitted", () => {
    const item = makeDurable();
    expect(item.maxDurability).toBeUndefined();
    expect(item.durability).toBeUndefined();
    expect(item.isBroken).toBe(false);
  });

  it("clamps the privileged setter to [0, maxDurability]", () => {
    const item = makeDurable(5);
    item[SET_DURABILITY](3);
    expect(item.durability).toBe(3);
    item[SET_DURABILITY](-2);
    expect(item.durability).toBe(0);
    item[SET_DURABILITY](99);
    expect(item.durability).toBe(5);
  });

  it("is a no-op setter on an item with no durability", () => {
    const item = makeDurable();
    item[SET_DURABILITY](3);
    expect(item.durability).toBeUndefined();
  });

  it("leaves keys without durability", () => {
    const key = createKey({ name: "Brass Key", keyCode: "brass", consumeOnUse: false });
    expect(key.maxDurability).toBeUndefined();
    expect(key.durability).toBeUndefined();
    expect(key.isBroken).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/inventory.test.ts`
Expected: FAIL — `SET_DURABILITY` is not exported and `maxDurability` / `durability` / `isBroken` don't exist.

- [ ] **Step 3: Implement the data model**

In `src/lib/inventory.ts`, add the symbol after the `DEPOSIT_MATERIALS` declaration (after line 143):

```ts
/**
 * Symbol-keyed setter for an item's current durability.
 *
 * Durability is read publicly but written only through this symbol, so wear
 * (combat) and repair are the sole mutation paths. The setter clamps to
 * `[0, maxDurability]`; on an item with no durability it is a no-op. Follows the
 * same privileged-mutator pattern as {@link CLAIM} and {@link DEPOSIT_MATERIALS}.
 */
export const SET_DURABILITY = Symbol("setDurability");
```

In the `IItem` interface, add these members (after `consumeOnUse`, before `[HELD_BY]`, around line 160):

```ts
  /** Max durability for equipment that wears; absent for items without durability. */
  readonly maxDurability?: number;
  /** Current durability in `[0, maxDurability]`; absent when the item has no durability. */
  readonly durability?: number;
  /** True when the item has durability and it has reached 0. */
  readonly isBroken: boolean;
  /** Sets durability, clamped to `[0, maxDurability]`; engine-internal. See {@link SET_DURABILITY}. */
  [SET_DURABILITY](value: number): void;
```

In the `Item` class, add fields/getters just after the `readonly consumeOnUse?: boolean;` field (above the `#heldBy` block, around line 188-190):

```ts
  readonly maxDurability?: number;
  #durability?: number;

  get durability(): number | undefined {
    return this.#durability;
  }

  get isBroken(): boolean {
    return this.maxDurability !== undefined && this.#durability === 0;
  }

  [SET_DURABILITY](value: number) {
    if (this.maxDurability === undefined) return;
    this.#durability = Math.max(0, Math.min(this.maxDurability, value));
  }
```

Extend the constructor descriptor. Add `maxDurability` and `durability` to both the destructure and its inline type (the object at lines 226-242):

```ts
  constructor(
    {
      type,
      recipe,
      modifier,
      stat,
      name,
      keyCode,
      consumeOnUse,
      maxDurability,
      durability,
    }: {
      type: ItemType;
      recipe: Recipe;
      modifier: number;
      stat: StatType;
      name: string;
      keyCode?: string;
      consumeOnUse?: boolean;
      maxDurability?: number;
      durability?: number;
    },
    properties: ItemProperties,
    actions: ItemActions,
    events: ItemEvents,
  ) {
```

And in the constructor body, after `this.consumeOnUse = consumeOnUse;` (line 255), initialize durability (defaulting to full, clamping an authored value):

```ts
    this.maxDurability = maxDurability;
    this.#durability =
      maxDurability === undefined
        ? undefined
        : Math.max(0, Math.min(maxDurability, durability ?? maxDurability));
```

Add a `@param` line in the constructor TSDoc (near the existing `@param descriptor.*` lines):

```ts
   * @param descriptor.maxDurability - Max durability for equipment that wears (optional).
   * @param descriptor.durability - Starting durability; defaults to `maxDurability`.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/inventory.test.ts`
Expected: PASS (new `durability` block green, existing Item tests still green).

- [ ] **Step 5: Commit**

```bash
git add src/lib/inventory.ts src/lib/inventory.test.ts
git commit -m "$(cat <<'EOF'
feat: numeric durability on items (maxDurability, isBroken, setter)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Weapon wear + broken exclusion in `Combatant.attack`

**Files:**
- Modify: `src/lib/character/combatant.ts`
- Test: `src/lib/character/player-character.test.ts`

- [ ] **Step 1: Write the failing tests**

In `src/lib/character/player-character.test.ts`, extend the inventory import (line 7) to bring in `Item` and `SET_DURABILITY`:

```ts
import { CLAIM, HELD_BY, Item, SET_DURABILITY, createKey } from "../inventory";
```

Add a real-`Item` weapon helper near `makeWeapon` (after line 35):

```ts
function makeDurableWeapon(opts: {
  modifier?: number;
  stat?: StatType;
  maxDurability: number;
  durability?: number;
  equipped?: boolean;
}): Item {
  const noop = () => {};
  return new Item(
    {
      type: "weapon",
      recipe: { metal: 2 },
      modifier: opts.modifier ?? 3,
      stat: opts.stat ?? StatType.Health,
      name: "Sword",
      maxDurability: opts.maxDurability,
      durability: opts.durability,
    },
    { equippable: true, equipped: opts.equipped ?? true, destroyable: true, usable: false },
    { pickUp: noop, equip: noop, unequip: noop, transfer: noop, use: noop, destroy: () => null },
    { onPickUp: noop },
  );
}
```

Add a `describe` block inside the existing `describe("attack", …)` group (place it right after the existing attack tests, before that block closes):

```ts
    describe("weapon durability", () => {
      it("wears an equipped durable weapon by one per attack", () => {
        const pc = makePc();
        const weapon = makeDurableWeapon({ modifier: 3, maxDurability: 3 });
        pc.inventory.items.push(weapon);
        const defender = makeDefender();

        pc.attack(defender);

        expect(defender.takeDamage).toHaveBeenCalledWith(3, StatType.Health);
        expect(weapon.durability).toBe(2);
      });

      it("breaks a weapon that reaches 0, after its hit lands", () => {
        const pc = makePc();
        const weapon = makeDurableWeapon({ modifier: 3, maxDurability: 1 });
        pc.inventory.items.push(weapon);
        const defender = makeDefender();

        pc.attack(defender);

        expect(defender.takeDamage).toHaveBeenCalledWith(3, StatType.Health);
        expect(weapon.isBroken).toBe(true);
      });

      it("a broken weapon contributes nothing (falls back to unarmed)", () => {
        const pc = makePc();
        pc.inventory.items.push(
          makeDurableWeapon({ modifier: 3, maxDurability: 1, durability: 0 }),
        );
        const defender = makeDefender();

        pc.attack(defender);

        expect(defender.takeDamage).toHaveBeenCalledTimes(1);
        expect(defender.takeDamage).toHaveBeenCalledWith(1, StatType.Health);
      });

      it("does not wear a non-durable weapon", () => {
        const pc = makePc();
        pc.inventory.items.push(makeWeapon({ modifier: 2, stat: StatType.Health }));
        const defender = makeDefender();

        expect(() => pc.attack(defender)).not.toThrow();
        expect(defender.takeDamage).toHaveBeenCalledWith(2, StatType.Health);
      });

      it("wears each equipped durable weapon independently", () => {
        const pc = makePc();
        const a = makeDurableWeapon({ modifier: 2, stat: StatType.Health, maxDurability: 4 });
        const b = makeDurableWeapon({ modifier: 1, stat: StatType.Health, maxDurability: 4 });
        pc.inventory.items.push(a, b);
        const defender = makeDefender();

        pc.attack(defender);

        expect(a.durability).toBe(3);
        expect(b.durability).toBe(3);
      });
    });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/character/player-character.test.ts`
Expected: FAIL — broken weapons still contribute, and durable weapons don't wear yet.

- [ ] **Step 3: Implement**

In `src/lib/character/combatant.ts`, add the import (after line 1):

```ts
import { SET_DURABILITY } from "../inventory";
```

Replace the body of `attack` (lines 37-65) with:

```ts
  attack(c: ICharacter) {
    // Only intact (non-broken) equipped weapons fight; broken ones contribute nothing.
    const weapons = this.inventory.items.filter(
      (item) => item.properties.equipped && item.type === "weapon" && !item.isBroken,
    );

    const attackMatrix: Record<StatType, number> = {
      // If there are no usable weapons, do an unarmed attack against defender health
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

    // Each weapon that swung wears one point (non-durable weapons are untouched).
    weapons.forEach((weapon) => {
      if (weapon.maxDurability !== undefined) {
        weapon[SET_DURABILITY]((weapon.durability ?? 0) - 1);
      }
    });

    this.recordAction(this.attack, {
      kind: "attack",
      target: { id: c.id, name: c.name },
    });
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/character/player-character.test.ts`
Then: `npx vitest run src/lib/character/mob.test.ts` (Mob inherits `attack`; its unarmed test must stay green).
Expected: PASS for both.

- [ ] **Step 5: Commit**

```bash
git add src/lib/character/combatant.ts src/lib/character/player-character.test.ts
git commit -m "$(cat <<'EOF'
feat: weapons wear on attack and break; broken weapons are inert

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Armor mitigation + wear in `Character.takeDamage`

**Files:**
- Modify: `src/lib/character/character.ts`
- Test: `src/lib/character/character.test.ts`

- [ ] **Step 1: Write the failing tests**

In `src/lib/character/character.test.ts`, extend the inventory import (line 3) to bring in `Item` and `SET_DURABILITY`:

```ts
import { CLAIM, Item, SET_DURABILITY, createKey, type IItem, type ItemId } from "../inventory";
```

Add a real-`Item` durable-gear helper near the top of the file (after the `makeItem` helper, before `describe("Character", …)`):

```ts
type ItemDescriptor = ConstructorParameters<typeof Item>[0];
function makeDurable(opts: {
  type?: ItemDescriptor["type"];
  stat?: StatType;
  modifier?: number;
  recipe?: ItemDescriptor["recipe"];
  maxDurability?: number;
  durability?: number;
  equipped?: boolean;
} = {}): Item {
  const noop = () => {};
  return new Item(
    {
      type: opts.type ?? "weapon",
      recipe: opts.recipe ?? { metal: 1 },
      modifier: opts.modifier ?? 2,
      stat: opts.stat ?? StatType.Health,
      name: "Gear",
      maxDurability: opts.maxDurability,
      durability: opts.durability,
    },
    { equippable: true, equipped: opts.equipped ?? true, destroyable: true, usable: false },
    { pickUp: noop, equip: noop, unequip: noop, transfer: noop, use: noop, destroy: () => null },
    { onPickUp: noop },
  );
}
```

Add a `describe` block inside the existing `describe("takeDamage", …)` group (after its existing tests):

```ts
    describe("armor", () => {
      // Sanity 5 makes the Health multiplier exactly 1: (10 - 5) * 0.2 = 1,
      // so post-mitigation damage equals the raw strength after armor soak.
      it("reduces raw strength by equipped matching armor before the multiplier", () => {
        const character = makeCharacter({ stats: { [StatType.Sanity]: 5 } });
        character.inventory.items.push(
          makeDurable({ type: "armor", stat: StatType.Health, modifier: 2, maxDurability: 5 }),
        );

        character.takeDamage(5, StatType.Health);

        // raw = max(0, 5 - 2) = 3; final = 3 * 1 = 3; health 10 - 3 = 7
        expect(character.stats[StatType.Health]).toBeCloseTo(7);
      });

      it("does not mitigate when the armor defends a different stat", () => {
        const character = makeCharacter({ stats: { [StatType.Sanity]: 5 } });
        character.inventory.items.push(
          makeDurable({ type: "armor", stat: StatType.Energy, modifier: 4, maxDurability: 5 }),
        );

        character.takeDamage(5, StatType.Health);

        expect(character.stats[StatType.Health]).toBeCloseTo(5);
      });

      it("does not mitigate with broken armor", () => {
        const character = makeCharacter({ stats: { [StatType.Sanity]: 5 } });
        character.inventory.items.push(
          makeDurable({ type: "armor", stat: StatType.Health, modifier: 2, maxDurability: 5, durability: 0 }),
        );

        character.takeDamage(5, StatType.Health);

        expect(character.stats[StatType.Health]).toBeCloseTo(5);
      });

      it("sums multiple matching armor pieces", () => {
        const character = makeCharacter({ stats: { [StatType.Sanity]: 5 } });
        character.inventory.items.push(
          makeDurable({ type: "armor", stat: StatType.Health, modifier: 2, maxDurability: 5 }),
          makeDurable({ type: "armor", stat: StatType.Health, modifier: 1, maxDurability: 5 }),
        );

        character.takeDamage(5, StatType.Health);

        // raw = max(0, 5 - 3) = 2; final 2; health 10 - 2 = 8
        expect(character.stats[StatType.Health]).toBeCloseTo(8);
      });

      it("wears equipped matching armor by one when it absorbs a hit", () => {
        const armor = makeDurable({ type: "armor", stat: StatType.Health, modifier: 2, maxDurability: 5 });
        const character = makeCharacter({ stats: { [StatType.Sanity]: 5 } });
        character.inventory.items.push(armor);

        character.takeDamage(5, StatType.Health);

        expect(armor.durability).toBe(4);
      });
    });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/character/character.test.ts`
Expected: FAIL — armor is not consulted yet, so mitigation tests fail.

- [ ] **Step 3: Implement**

In `src/lib/character/character.ts`, add `SET_DURABILITY` to the inventory import (line 3):

```ts
import { CLAIM, DEPOSIT_MATERIALS, IItem, IItemHolder, Inventory, SET_DURABILITY } from "../inventory";
```

Replace the body of `takeDamage` (lines 407-420) with:

```ts
  takeDamage(attackStrength: number, attackStat: StatType = StatType.Health) {
    // Equipped, intact armor defending this stat soaks raw strength first,
    // mirroring how attacking weapons add to it.
    const armor = this.#inventory.items.filter(
      (item) =>
        item.properties.equipped &&
        item.type === "armor" &&
        !item.isBroken &&
        item.stat === attackStat,
    );
    const armorSum = armor.reduce((sum, piece) => sum + piece.modifier, 0);
    const mitigatedStrength = Math.max(0, attackStrength - armorSum);

    const mitigator = this.stats[MitigatorStatType[attackStat]];
    const damageMultiplier = (MAX_STAT - mitigator) * MITIGATION_PER_POINT;
    const finalAttackStrength = mitigatedStrength * damageMultiplier;

    this.stats[attackStat] = this.stats[attackStat] - finalAttackStrength;

    // Each contributing armor piece wears for the blow it helped absorb.
    armor.forEach((piece) => {
      if (piece.maxDurability !== undefined) {
        piece[SET_DURABILITY]((piece.durability ?? 0) - 1);
      }
    });

    this.#resolveStatuses();
    this.recordAction(this.takeDamage, {
      kind: "takeDamage",
      amount: finalAttackStrength,
      stat: attackStat,
    });
  }
```

Update the `takeDamage` TSDoc (lines 399-402) so the formula reflects armor. Replace the sentence beginning "The damage taken is …" with:

```ts
   * Equipped, non-broken armor whose `stat` matches `attackStat` first subtracts
   * its `modifier` from the raw strength (floored at 0); the remainder is then
   * `* (MAX_STAT - mitigator) * 0.2`, where the mitigator is the stat that defends
   * `attackStat` (see {@link MitigatorStatType}). Contributing armor wears one point.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/character/character.test.ts`
Expected: PASS — new `armor` block green; the existing armor-less `takeDamage` tests stay green (`armorSum` 0 ⇒ unchanged math).

- [ ] **Step 5: Commit**

```bash
git add src/lib/character/character.ts src/lib/character/character.test.ts
git commit -m "$(cat <<'EOF'
feat: armor mitigates raw attack strength and wears when it absorbs a hit

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `Character.repair`

**Files:**
- Modify: `src/lib/character/character.ts`
- Test: `src/lib/character/character.test.ts`

- [ ] **Step 1: Write the failing tests**

In `src/lib/character/character.test.ts`, add a `describe("repair", …)` block (a sibling of `describe("takeDamage", …)`). It uses a real `Campaign` so the material plumbing runs, and the `makeDurable` helper added in Task 3:

```ts
  describe("repair", () => {
    it("restores a damaged held item to full for a proportional, debited cost", () => {
      const campaign = new Campaign("Repair");
      const character = new Character(campaign, "Hero", makeStats());
      const weapon = makeDurable({ recipe: { metal: 4 }, maxDurability: 10, durability: 3 });
      character.inventory.items.push(weapon);
      campaign.claimMaterials("seed", { metal: 5 });

      character.repair(weapon);

      // missing 7 of 10 -> ceil(4 * 7 / 10) = ceil(2.8) = 3 metal
      expect(weapon.durability).toBe(10);
      expect(campaign.materials).toEqual({ metal: 2 });
    });

    it("charges the full recipe to fully restore a broken item", () => {
      const campaign = new Campaign("Repair");
      const character = new Character(campaign, "Hero", makeStats());
      const weapon = makeDurable({ recipe: { metal: 4 }, maxDurability: 10, durability: 0 });
      character.inventory.items.push(weapon);
      campaign.claimMaterials("seed", { metal: 4 });

      character.repair(weapon);

      // missing 10 of 10 -> ceil(4 * 10 / 10) = 4 metal (the whole recipe).
      // withdrawMaterials deletes a component that reaches 0, so the pool is empty.
      expect(weapon.durability).toBe(10);
      expect(campaign.materials).toEqual({});
    });

    it("throws and spends nothing for an item the character is not holding", () => {
      const campaign = new Campaign("Repair");
      const character = new Character(campaign, "Hero", makeStats());
      const weapon = makeDurable({ recipe: { metal: 4 }, maxDurability: 10, durability: 3 });
      campaign.claimMaterials("seed", { metal: 5 });

      expect(() => character.repair(weapon)).toThrow(ProceduralViolation);
      expect(campaign.materials).toEqual({ metal: 5 });
    });

    it("throws for an item that has no durability", () => {
      const campaign = new Campaign("Repair");
      const character = new Character(campaign, "Hero", makeStats());
      const plain = makeDurable({ recipe: { metal: 1 } }); // no maxDurability
      character.inventory.items.push(plain);

      expect(() => character.repair(plain)).toThrow(ProceduralViolation);
    });

    it("throws for an item that is not damaged", () => {
      const campaign = new Campaign("Repair");
      const character = new Character(campaign, "Hero", makeStats());
      const weapon = makeDurable({ recipe: { metal: 4 }, maxDurability: 10 }); // full
      character.inventory.items.push(weapon);

      expect(() => character.repair(weapon)).toThrow(ProceduralViolation);
    });

    it("throws and spends nothing when the pool cannot afford the cost", () => {
      const campaign = new Campaign("Repair");
      const character = new Character(campaign, "Hero", makeStats());
      const weapon = makeDurable({ recipe: { metal: 4 }, maxDurability: 10, durability: 0 });
      character.inventory.items.push(weapon);
      campaign.claimMaterials("seed", { metal: 1 }); // need 4

      expect(() => character.repair(weapon)).toThrow(ProceduralViolation);
      expect(campaign.materials).toEqual({ metal: 1 });
      expect(weapon.durability).toBe(0);
    });

    it("does not consume an action (records no history)", () => {
      const campaign = new Campaign("Repair");
      const character = new Character(campaign, "Hero", makeStats());
      const weapon = makeDurable({ recipe: { metal: 4 }, maxDurability: 10, durability: 3 });
      character.inventory.items.push(weapon);
      campaign.claimMaterials("seed", { metal: 5 });

      const before = character.history.length;
      character.repair(weapon);

      expect(character.history.length).toBe(before);
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/character/character.test.ts`
Expected: FAIL — `repair` does not exist.

- [ ] **Step 3: Implement**

In `src/lib/character/character.ts`:

Add `MaterialMap` to the inventory import (the line edited in Task 3):

```ts
import { CLAIM, DEPOSIT_MATERIALS, IItem, IItemHolder, Inventory, MaterialMap, SET_DURABILITY } from "../inventory";
```

Add `typedEntries` to the util import (line 8):

```ts
import { generateId, ProceduralViolation, typedEntries } from "../util";
```

Add `repair` to the `ICharacter` interface, right after the `takeDamage` declaration (line 83):

```ts
  /** Restores a damaged, durability-bearing held item to full for a proportional material cost (free). */
  repair: (item: IItem) => void;
```

Add the method to the `Character` class. Place it right after `consumeKey` (after line 355):

```ts
  /**
   * Restores a damaged, durability-bearing item to full durability, paying a
   * material cost proportional to the missing fraction (`ceil(recipe[c] * missing
   * / maxDurability)` per component) from the party pool. Free — it does not
   * consume a budgeted action or record history.
   *
   * @param item - A held item that has durability and is below full.
   * @throws {@link ProceduralViolation} if the item is not held, has no
   *   durability, is already at full, or the party cannot afford the cost.
   */
  repair(item: IItem) {
    const held = this.#inventory.items.some((i) => i.id === item.id);
    if (!held) {
      throw new ProceduralViolation(
        "Cannot repair an item the character is not holding",
      );
    }
    if (item.maxDurability === undefined || item.durability === undefined) {
      throw new ProceduralViolation("Cannot repair an item that has no durability");
    }
    if (item.durability >= item.maxDurability) {
      throw new ProceduralViolation("Cannot repair an item that is not damaged");
    }

    const missing = item.maxDurability - item.durability;
    const cost: MaterialMap = {};
    for (const [component, qty] of typedEntries(item.recipe) as Array<
      [keyof MaterialMap, number | undefined]
    >) {
      if (qty === undefined) continue;
      cost[component] = Math.ceil((qty * missing) / item.maxDurability);
    }

    if (!this.campaign.canAfford(cost)) {
      throw new ProceduralViolation("Not enough materials to repair");
    }
    this.campaign.withdrawMaterials(cost);
    item[SET_DURABILITY](item.maxDurability);
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/character/character.test.ts`
Expected: PASS (all 7 repair tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/character/character.ts src/lib/character/character.test.ts
git commit -m "$(cat <<'EOF'
feat: Character.repair restores durability for a proportional pool cost

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Durability integration seam

**Files:**
- Test: `src/lib/character/player-character.test.ts`

A single end-to-end test that exercises all three pieces together: a weapon wears and breaks in combat, armor on the defender mitigates and wears over the same fight, the weapon is repaired from a stocked pool, and it fights effectively again.

- [ ] **Step 1: Write the failing test**

In `src/lib/character/player-character.test.ts`, add a durable-armor helper next to `makeDurableWeapon` (from Task 2):

```ts
function makeDurableArmor(opts: {
  modifier?: number;
  stat?: StatType;
  maxDurability: number;
  durability?: number;
  equipped?: boolean;
}): Item {
  const noop = () => {};
  return new Item(
    {
      type: "armor",
      recipe: { metal: 1 },
      modifier: opts.modifier ?? 2,
      stat: opts.stat ?? StatType.Health,
      name: "Plate",
      maxDurability: opts.maxDurability,
      durability: opts.durability,
    },
    { equippable: true, equipped: opts.equipped ?? true, destroyable: true, usable: false },
    { pickUp: noop, equip: noop, unequip: noop, transfer: noop, use: noop, destroy: () => null },
    { onPickUp: noop },
  );
}
```

Then add a top-level `describe` block (a sibling of `describe("PlayerCharacter", …)`, or inside it — match the file's structure; place it after the `attack` group):

```ts
  describe("durability seam", () => {
    it("a weapon breaks in combat, is repaired, and fights again while armor wears", () => {
      const campaign = new Campaign("Seam");
      const hero = new PlayerCharacter(campaign, "Hero", makeStats());
      const weapon = makeDurableWeapon({ modifier: 3, stat: StatType.Health, maxDurability: 1 });
      hero.inventory.items.push(weapon);

      // Defender is a real Character so its takeDamage runs armor mitigation/wear.
      // Sanity 5 makes the Health multiplier exactly 1.
      const defender = new Character(campaign, "Ogre", makeStats({ [StatType.Sanity]: 5 }));
      const armor = makeDurableArmor({ modifier: 2, stat: StatType.Health, maxDurability: 5 });
      defender.inventory.items.push(armor);

      // Swing 1: weapon mod 3 vs armor mod 2 -> raw 1 -> final 1. Weapon breaks; armor wears.
      const start = defender.stats[StatType.Health];
      hero.attack(defender);
      expect(defender.stats[StatType.Health]).toBeCloseTo(start - 1);
      expect(weapon.isBroken).toBe(true);
      expect(armor.durability).toBe(4);

      // Swing 2: broken weapon -> unarmed 1; armor fully soaks it (raw max(0, 1 - 2) = 0).
      const mid = defender.stats[StatType.Health];
      hero.attack(defender);
      expect(defender.stats[StatType.Health]).toBeCloseTo(mid);
      expect(armor.durability).toBe(3);

      // Repair from a stocked pool, then swing effectively again.
      campaign.claimMaterials("seed", { metal: 2 });
      hero.repair(weapon);
      expect(weapon.isBroken).toBe(false);

      hero.attack(defender);
      expect(defender.stats[StatType.Health]).toBeCloseTo(mid - 1);
    });
  });
```

- [ ] **Step 2: Run the test to verify it passes**

Because Tasks 1-4 already implement the behavior, this seam test should pass once written. Run:
`npx vitest run src/lib/character/player-character.test.ts`
Expected: PASS. If it fails, the failure pinpoints a cross-method integration gap to fix before committing.

- [ ] **Step 3: Full suite + static checks**

```
npm run checks
```
Expected: eslint clean, `tsc --noEmit` clean, all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/lib/character/player-character.test.ts
git commit -m "$(cat <<'EOF'
test: durability seam — break in combat, repair, fight again

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Done

After Task 5: `feature/durability` (off `main`) holds the spec plus five feature commits. Hand off to **superpowers:finishing-a-development-branch** (Push & open PR against `main`). Equipment slots & handedness remain deferred to sub-project ④.
