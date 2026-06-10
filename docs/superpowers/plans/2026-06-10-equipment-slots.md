# Equipment Slots & Handedness (④a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give characters explicit, single-occupancy equipment slots (head/torso/legs/feet, two wrists, two hands, two ring fingers per hand), validated `equip`/`unequip` with auto-swap, and two-handed weapons that span both hands — so equipped gear is bounded and can't be bypassed.

**Architecture:** A new `equipment.ts` module defines item slot **kinds** (`SlotKind`) and a character's named **slot positions** (`EquipmentSlot`) plus the `SLOT_KIND` map and the default humanoid slot set. Items gain a `slot` (kind) and `twoHanded` flag. `Item` exposes symbol-keyed low-level `[EQUIP]`/`[UNEQUIP]` methods (the `CLAIM`/`SET_DURABILITY` privileged-mutator pattern). `Character` tracks occupancy in a `Map<EquipmentSlot, IItem>` and exposes validated `equip(item, targetSlot?)` / `unequip(item)`. The public `item.actions.equip` wrapper routes *slotted* items through `Character.equip`, so capacity holds even via the item's own API. The combat filters (`attack`, `takeDamage`) are untouched — they read `properties.equipped`, which the seam keeps in sync, and are now naturally bounded.

**Tech Stack:** TypeScript (strict, NodeNext), Vitest, typescript-eslint (recommendedTypeChecked).

**Design spec:** `docs/superpowers/specs/2026-06-10-equipment-slots-design.md`

**Design note — the equip seam (no-bypass guarantee):** Per the spec, `item.actions.equip` is rerouted through `Character.equip` so slot capacity can't be bypassed even via the item's own API. A naive reroute loops forever (`item.actions.equip` → `holder.equip` → `item.actions.equip` …). To break it, `Item` gains symbol-keyed low-level `[EQUIP]`/`[UNEQUIP]` methods that do the *terminal* toggle (run the author behavior, flip `properties.equipped`, fire `onEquip`/`onUnequip`) and never route back out. The public `actions.equip` wrapper routes a **slotted** item to `holder.equip(this)`; `Character.equip` performs the terminal step via `item[EQUIP](this)`. **Slotless** items (the pre-existing equippables) keep the legacy inline toggle, so existing equip tests stay green. **Task 3** introduces the seam (pure refactor); **Task 4** wires `Character.equip` and the reroute.

This is sub-project **④a**. ④b (passive ring effects / effective-stat layer) is a separate plan that builds on this.

---

## File Structure

- `src/lib/equipment.ts` — **create.** `SlotKind`, `EquipmentSlot`, `SLOT_KIND`, `DEFAULT_EQUIPMENT_SLOTS`. Pure data, no deps.
- `src/lib/equipment.test.ts` — **create.** Unit-test the constants/mapping.
- `src/lib/inventory.ts` — **modify.** Add `accessory` `ItemType`; `slot?: SlotKind` and `twoHanded?: boolean` on `Item`; the `EQUIP`/`UNEQUIP` symbol seam; the slot-aware equip/unequip wrapper reroute.
- `src/lib/inventory.test.ts` — **modify.** Authoring of `slot`/`twoHanded`; the low-level seam.
- `src/lib/character/character.ts` — **modify.** Equipment map + validated `equip`/`unequip` + `equipment` getter on `ICharacter`/`Character`.
- `src/lib/character/character.test.ts` — **modify.** Equip/unequip/auto-swap/handedness + no-bypass.
- `src/lib/character/player-character.test.ts` — **modify.** The capping seam.

A note on running filtered tests: Vitest treats `-t` patterns as regex, so **do not** put `()` in a `-t` filter. The steps below run whole test files.

Commit footer for every commit:

```
Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
```

---

## Task 1: Slot types module (`equipment.ts`)

**Files:**
- Create: `src/lib/equipment.ts`
- Test: `src/lib/equipment.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/equipment.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  DEFAULT_EQUIPMENT_SLOTS,
  EquipmentSlot,
  SLOT_KIND,
  SlotKind,
} from "./equipment";

describe("equipment slots", () => {
  it("maps every named slot to a kind", () => {
    for (const slot of Object.values(EquipmentSlot)) {
      expect(SLOT_KIND[slot]).toBeDefined();
    }
  });

  it("maps hands, wrists, and fingers to their kinds", () => {
    expect(SLOT_KIND[EquipmentSlot.LeftHand]).toBe(SlotKind.Hand);
    expect(SLOT_KIND[EquipmentSlot.RightHand]).toBe(SlotKind.Hand);
    expect(SLOT_KIND[EquipmentSlot.LeftWrist]).toBe(SlotKind.Wrist);
    expect(SLOT_KIND[EquipmentSlot.LeftIndexFinger]).toBe(SlotKind.Finger);
    expect(SLOT_KIND[EquipmentSlot.RightRingFinger]).toBe(SlotKind.Finger);
    expect(SLOT_KIND[EquipmentSlot.Head]).toBe(SlotKind.Head);
  });

  it("has the default humanoid slot set: 2 hands, 2 wrists, 4 fingers, 4 single body slots", () => {
    const slots = DEFAULT_EQUIPMENT_SLOTS;
    expect(slots).toHaveLength(12);
    const fingers = slots.filter((s) => SLOT_KIND[s] === SlotKind.Finger);
    const hands = slots.filter((s) => SLOT_KIND[s] === SlotKind.Hand);
    expect(fingers).toHaveLength(4); // two per hand
    expect(hands).toHaveLength(2);
    // No duplicates.
    expect(new Set(slots).size).toBe(slots.length);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/equipment.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Create the module**

Create `src/lib/equipment.ts` (mirrors the `const X = {...} as const; type X = ...` idiom used by `ItemType`/`StatType`):

```ts
/**
 * The kind of slot an item fits — the category, not a specific position. An item
 * declares its `slot` as one of these; a character has concrete named slots
 * ({@link EquipmentSlot}) of each kind.
 */
export const SlotKind = {
  Hand: "hand",
  Finger: "finger",
  Wrist: "wrist",
  Head: "head",
  Torso: "torso",
  Legs: "legs",
  Feet: "feet",
} as const;
export type SlotKind = (typeof SlotKind)[keyof typeof SlotKind];

/**
 * A character's discrete, named, single-occupancy equipment positions. Each holds
 * at most one item (a two-handed weapon spans both hands). Naming each position
 * explicitly — rather than pooling by capacity — lets a future spec remove an
 * individual slot (a lost finger or limb).
 */
export const EquipmentSlot = {
  Head: "head",
  Torso: "torso",
  Legs: "legs",
  Feet: "feet",
  LeftWrist: "leftWrist",
  RightWrist: "rightWrist",
  LeftHand: "leftHand",
  RightHand: "rightHand",
  LeftIndexFinger: "leftIndexFinger",
  LeftRingFinger: "leftRingFinger",
  RightIndexFinger: "rightIndexFinger",
  RightRingFinger: "rightRingFinger",
} as const;
export type EquipmentSlot = (typeof EquipmentSlot)[keyof typeof EquipmentSlot];

/** The kind each named slot belongs to. */
export const SLOT_KIND: Record<EquipmentSlot, SlotKind> = {
  [EquipmentSlot.Head]: SlotKind.Head,
  [EquipmentSlot.Torso]: SlotKind.Torso,
  [EquipmentSlot.Legs]: SlotKind.Legs,
  [EquipmentSlot.Feet]: SlotKind.Feet,
  [EquipmentSlot.LeftWrist]: SlotKind.Wrist,
  [EquipmentSlot.RightWrist]: SlotKind.Wrist,
  [EquipmentSlot.LeftHand]: SlotKind.Hand,
  [EquipmentSlot.RightHand]: SlotKind.Hand,
  [EquipmentSlot.LeftIndexFinger]: SlotKind.Finger,
  [EquipmentSlot.LeftRingFinger]: SlotKind.Finger,
  [EquipmentSlot.RightIndexFinger]: SlotKind.Finger,
  [EquipmentSlot.RightRingFinger]: SlotKind.Finger,
};

/**
 * The default humanoid set of named slots, in canonical fill order (used when
 * `equip` auto-assigns a free slot of a kind).
 */
export const DEFAULT_EQUIPMENT_SLOTS: readonly EquipmentSlot[] = [
  EquipmentSlot.Head,
  EquipmentSlot.Torso,
  EquipmentSlot.Legs,
  EquipmentSlot.Feet,
  EquipmentSlot.LeftWrist,
  EquipmentSlot.RightWrist,
  EquipmentSlot.LeftHand,
  EquipmentSlot.RightHand,
  EquipmentSlot.LeftIndexFinger,
  EquipmentSlot.LeftRingFinger,
  EquipmentSlot.RightIndexFinger,
  EquipmentSlot.RightRingFinger,
];
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/equipment.test.ts` → PASS.
Then `npx tsc --noEmit` and `npx eslint src/lib/equipment.ts src/lib/equipment.test.ts` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/equipment.ts src/lib/equipment.test.ts
git commit -m "$(cat <<'EOF'
feat: equipment slot kinds and named character slots

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Item slot fields + `accessory` type (`inventory.ts`)

**Files:**
- Modify: `src/lib/inventory.ts`
- Test: `src/lib/inventory.test.ts`

- [ ] **Step 1: Write the failing tests**

In `src/lib/inventory.test.ts`, add to the existing `describe("Item", …)` area a new block (the file already imports `Item`, `StatType`, and has `makeActions`/`makeEvents`):

```ts
  describe("equipment slots", () => {
    it("exposes an authored slot kind and twoHanded flag", () => {
      const item = new Item(
        {
          type: "weapon",
          recipe: { metal: 1 },
          modifier: 3,
          stat: StatType.Health,
          name: "Greatsword",
          slot: "hand",
          twoHanded: true,
        },
        { equippable: true, equipped: false, destroyable: true, usable: false },
        makeActions(),
        makeEvents(),
      );

      expect(item.slot).toBe("hand");
      expect(item.twoHanded).toBe(true);
    });

    it("leaves slot and twoHanded undefined when not authored", () => {
      const item = new Item(
        {
          type: "consumable",
          recipe: { healing: 1 },
          modifier: 0,
          stat: StatType.Health,
          name: "Potion",
        },
        { equippable: false, equipped: false, destroyable: true, usable: true },
        makeActions(),
        makeEvents(),
      );

      expect(item.slot).toBeUndefined();
      expect(item.twoHanded).toBeUndefined();
    });

    it("accepts the accessory item type", () => {
      const ring = new Item(
        {
          type: "accessory",
          recipe: { metal: 1 },
          modifier: 2,
          stat: StatType.Sanity,
          name: "Ring of Calm",
          slot: "finger",
        },
        { equippable: true, equipped: false, destroyable: true, usable: false },
        makeActions(),
        makeEvents(),
      );

      expect(ring.type).toBe("accessory");
      expect(ring.slot).toBe("finger");
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/inventory.test.ts`
Expected: FAIL — `slot`/`twoHanded` are not accepted by the constructor and `"accessory"` is not an `ItemType`.

- [ ] **Step 3: Implement in `src/lib/inventory.ts`**

(a) Add the import at the top (after the existing imports):

```ts
import type { SlotKind } from "./equipment";
```

(b) Add `Accessory` to the `ItemType` map:

```ts
const ItemType = {
  Consumable: "consumable",
  Armor: "armor",
  Weapon: "weapon",
  Throwable: "throwable",
  Accessory: "accessory",
  Key: "key",
} as const;
```

(c) In the `IItem` interface, add (after the durability members, before `teaches`):

```ts
  /** The kind of slot this item equips into; absent ⇒ not slot-equippable. */
  readonly slot?: SlotKind;
  /** Weapons only: occupies both hand slots when equipped. */
  readonly twoHanded?: boolean;
```

(d) In the `Item` class, add the fields (next to `readonly teaches?`):

```ts
  readonly slot?: SlotKind;
  readonly twoHanded?: boolean;
```

(e) Extend the constructor descriptor — add `slot` and `twoHanded` to the destructure and its inline type:

```ts
      teaches,
      maxDurability,
      durability,
      slot,
      twoHanded,
    }: {
      type: ItemType;
      recipe: Recipe;
      modifier: number;
      stat: StatType;
      name: string;
      keyCode?: string;
      consumeOnUse?: boolean;
      teaches?: CraftingRecipe;
      maxDurability?: number;
      durability?: number;
      slot?: SlotKind;
      twoHanded?: boolean;
    },
```

(f) In the constructor body, assign them (after `this.#durability = …`):

```ts
    this.slot = slot;
    this.twoHanded = twoHanded;
```

(g) Add two `@param` lines to the constructor TSDoc (near the other descriptor params):

```ts
   * @param descriptor.slot - The {@link SlotKind} this item equips into (optional).
   * @param descriptor.twoHanded - Weapons only: occupies both hands when equipped.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/inventory.test.ts` → PASS.
Then `npx tsc --noEmit` and `npx eslint src/lib/inventory.ts src/lib/inventory.test.ts` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/inventory.ts src/lib/inventory.test.ts
git commit -m "$(cat <<'EOF'
feat: item slot kind, twoHanded flag, and accessory type

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: The `EQUIP`/`UNEQUIP` low-level seam (`inventory.ts`)

Extract the equip/unequip behavior into symbol-keyed low-level methods that the public
wrappers delegate to. This is **behavior-preserving** — `item.actions.equip()` still does
exactly what it did — but it gives `Character.equip` (Task 4) a terminal entry point to call,
breaking the wrapper↔character recursion.

**Files:**
- Modify: `src/lib/inventory.ts`
- Test: `src/lib/inventory.test.ts`

- [ ] **Step 1: Write the failing test**

In `src/lib/inventory.test.ts`, extend the inventory import to add `EQUIP`/`UNEQUIP`:

```ts
import { CLAIM, DEPOSIT_MATERIALS, EQUIP, Item, SET_DURABILITY, UNEQUIP, createKey, type IItem, type IItemHolder } from "./inventory";
```

Add a `describe` block (uses the existing `makeItem`/`makeHolder` helpers):

```ts
  describe("equip seam", () => {
    it("EQUIP runs the behavior, toggles equipped, and fires onEquip", () => {
      const { item, actions, events } = makeItem();
      const holder = makeHolder();

      item[EQUIP](holder);

      expect(item.properties.equipped).toBe(true);
      expect(actions.equip).toHaveBeenCalledWith(holder);
      expect(events.onEquip).toHaveBeenCalledWith(holder);
    });

    it("UNEQUIP runs the behavior, clears equipped, and fires onUnequip", () => {
      const { item, actions, events } = makeItem();
      const holder = makeHolder();
      item[EQUIP](holder);

      item[UNEQUIP](holder);

      expect(item.properties.equipped).toBe(false);
      expect(actions.unequip).toHaveBeenCalledWith(holder);
      expect(events.onUnequip).toHaveBeenCalledWith(holder);
    });
  });
```

(The pre-existing `describe("equip")` / `describe("unequip")` tests at the top of the file must
keep passing unchanged.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/inventory.test.ts`
Expected: FAIL — `EQUIP`/`UNEQUIP` are not exported.

- [ ] **Step 3: Implement in `src/lib/inventory.ts`**

(a) Add the symbols (after the `SET_DURABILITY` declaration):

```ts
/**
 * Symbol-keyed low-level equip/unequip. They run the item's author equip/unequip
 * behavior, toggle `properties.equipped`, and fire the matching event — the
 * terminal step, with no slot validation. Only {@link Character.equip}/`unequip`
 * and the item's own action wrapper call them. Same privileged-mutator pattern as
 * {@link CLAIM} and {@link SET_DURABILITY}.
 */
export const EQUIP = Symbol("equipItem");
export const UNEQUIP = Symbol("unequipItem");
```

(b) In the `IItem` interface, add (near the `[SET_DURABILITY]` declaration):

```ts
  /** Low-level equip: runs behavior, sets `equipped`, fires `onEquip`. See {@link EQUIP}. */
  [EQUIP](holder: ICharacter): void;
  /** Low-level unequip: runs behavior, clears `equipped`, fires `onUnequip`. See {@link UNEQUIP}. */
  [UNEQUIP](holder: ICharacter): void;
```

(c) In the `Item` class, add private fields to hold the equip/unequip behavior + events
(the other wrappers keep using the constructor closures; these fields let the symbol methods
reach the same callbacks):

```ts
  #equipBehavior: ItemActionEvent;
  #unequipBehavior: ItemActionEvent;
  #onEquip?: ItemActionEvent;
  #onUnequip?: ItemActionEvent;
```

In the constructor (after the durability init), capture them:

```ts
    this.#equipBehavior = actions[ItemAction.Equip];
    this.#unequipBehavior = actions[ItemAction.Unequip];
    this.#onEquip = events.onEquip;
    this.#onUnequip = events.onUnequip;
```

Add the methods (after the `#characterHolder()` method):

```ts
  [EQUIP](holder: ICharacter) {
    this.#equipBehavior(holder);
    this.properties.equipped = true;
    this.#onEquip?.(holder);
  }

  [UNEQUIP](holder: ICharacter) {
    this.#unequipBehavior(holder);
    this.properties.equipped = false;
    this.#onUnequip?.(holder);
  }
```

(d) Change the public equip/unequip wrappers to delegate to the seam (behavior identical):

```ts
      [ItemAction.Equip]: () => {
        const holder = this.#characterHolder();
        if (!holder) return;
        this[EQUIP](holder);
      },
      [ItemAction.Unequip]: () => {
        const holder = this.#characterHolder();
        if (!holder) return;
        this[UNEQUIP](holder);
      },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/inventory.test.ts` → PASS (new seam tests + the pre-existing
equip/unequip wrapper tests).
Then `npx tsc --noEmit` and `npx eslint src/lib/inventory.ts src/lib/inventory.test.ts` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/inventory.ts src/lib/inventory.test.ts
git commit -m "$(cat <<'EOF'
refactor: extract low-level EQUIP/UNEQUIP seam on Item

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Character equipment slots + validated equip + reroute

Add the character-side equipment map and validated `equip`/`unequip`, then reroute the public
item wrapper so a **slotted** item routes through `Character.equip` (no bypass). Slotless items
keep the legacy inline toggle.

**Files:**
- Modify: `src/lib/character/character.ts`, `src/lib/inventory.ts`
- Test: `src/lib/character/character.test.ts`

- [ ] **Step 1: Write the failing tests**

In `src/lib/character/character.test.ts`, add the import:

```ts
import { EquipmentSlot } from "../equipment";
```

Add a real-`Item` gear helper at **module scope, next to `makeDurable`**. **Reuse the existing
`ItemDescriptor` type alias** already defined in this file (from ③) — do NOT redeclare it (if
it is missing, add `type ItemDescriptor = ConstructorParameters<typeof Item>[0];` once):

```ts
function makeGear(opts: {
  type?: ItemDescriptor["type"];
  name?: string;
  slot?: ItemDescriptor["slot"];
  twoHanded?: boolean;
  stat?: StatType;
  modifier?: number;
  equippable?: boolean;
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
    },
    { equippable: opts.equippable ?? true, equipped: false, destroyable: true, usable: false },
    { pickUp: noop, equip: noop, unequip: noop, transfer: noop, use: noop, destroy: () => null },
    { onPickUp: noop },
  );
}
```

Add the `describe("equip", …)` block:

```ts
  describe("equip", () => {
    function heroWith(...items: Item[]) {
      const character = new Character(new Campaign("Equip"), "Hero", makeStats());
      for (const item of items) character.inventory.items.push(item);
      return character;
    }

    it("equips an item into a free named slot of its kind", () => {
      const helm = makeGear({ type: "armor", slot: "head", name: "Helm" });
      const hero = heroWith(helm);

      hero.equip(helm);

      expect(helm.properties.equipped).toBe(true);
      expect(hero.equipment.get(EquipmentSlot.Head)).toBe(helm);
    });

    it("auto-assigns rings to the first free finger, then the next", () => {
      const r1 = makeGear({ type: "accessory", slot: "finger", name: "R1" });
      const r2 = makeGear({ type: "accessory", slot: "finger", name: "R2" });
      const hero = heroWith(r1, r2);

      hero.equip(r1);
      hero.equip(r2);

      expect(hero.equipment.get(EquipmentSlot.LeftIndexFinger)).toBe(r1);
      expect(hero.equipment.get(EquipmentSlot.LeftRingFinger)).toBe(r2);
    });

    it("honors an explicit target slot", () => {
      const ring = makeGear({ type: "accessory", slot: "finger", name: "R" });
      const hero = heroWith(ring);

      hero.equip(ring, EquipmentSlot.RightRingFinger);

      expect(hero.equipment.get(EquipmentSlot.RightRingFinger)).toBe(ring);
    });

    it("auto-swaps the occupant of a single-capacity slot", () => {
      const helmA = makeGear({ type: "armor", slot: "head", name: "A" });
      const helmB = makeGear({ type: "armor", slot: "head", name: "B" });
      const hero = heroWith(helmA, helmB);
      hero.equip(helmA);

      hero.equip(helmB);

      expect(hero.equipment.get(EquipmentSlot.Head)).toBe(helmB);
      expect(helmA.properties.equipped).toBe(false);
      expect(hero.inventory.items).toContain(helmA); // displaced, still held
    });

    it("fills all four fingers, then auto-swaps the first", () => {
      const rings = [0, 1, 2, 3, 4].map((n) =>
        makeGear({ type: "accessory", slot: "finger", name: `R${n}` }),
      );
      const hero = heroWith(...rings);
      rings.forEach((r) => hero.equip(r));

      const equipped = rings.filter((r) => r.properties.equipped);
      expect(equipped).toHaveLength(4); // only four finger slots
      expect(rings[0]!.properties.equipped).toBe(false); // first displaced
    });

    it("a two-handed weapon occupies both hands and displaces them", () => {
      const sword = makeGear({ type: "weapon", slot: "hand", name: "1H-A" });
      const dagger = makeGear({ type: "weapon", slot: "hand", name: "1H-B" });
      const greatsword = makeGear({ type: "weapon", slot: "hand", twoHanded: true, name: "2H" });
      const hero = heroWith(sword, dagger, greatsword);
      hero.equip(sword);
      hero.equip(dagger); // both hands now full

      hero.equip(greatsword);

      expect(hero.equipment.get(EquipmentSlot.LeftHand)).toBe(greatsword);
      expect(hero.equipment.get(EquipmentSlot.RightHand)).toBe(greatsword);
      expect(sword.properties.equipped).toBe(false);
      expect(dagger.properties.equipped).toBe(false);
    });

    it("equipping a one-handed weapon displaces a worn two-handed weapon", () => {
      const greatsword = makeGear({ type: "weapon", slot: "hand", twoHanded: true, name: "2H" });
      const dagger = makeGear({ type: "weapon", slot: "hand", name: "1H" });
      const hero = heroWith(greatsword, dagger);
      hero.equip(greatsword);

      hero.equip(dagger, EquipmentSlot.LeftHand);

      expect(hero.equipment.get(EquipmentSlot.LeftHand)).toBe(dagger);
      expect(hero.equipment.has(EquipmentSlot.RightHand)).toBe(false);
      expect(greatsword.properties.equipped).toBe(false);
    });

    it("unequip clears the slot and leaves the item in inventory", () => {
      const helm = makeGear({ type: "armor", slot: "head", name: "Helm" });
      const hero = heroWith(helm);
      hero.equip(helm);

      hero.unequip(helm);

      expect(helm.properties.equipped).toBe(false);
      expect(hero.equipment.has(EquipmentSlot.Head)).toBe(false);
      expect(hero.inventory.items).toContain(helm);
    });

    it("throws for an unheld / non-equippable / slot-less item and a bad target", () => {
      const hero = heroWith();
      const unheld = makeGear({ type: "armor", slot: "head" });
      expect(() => hero.equip(unheld)).toThrow(ProceduralViolation);

      const notEquippable = makeGear({ type: "armor", slot: "head", equippable: false });
      hero.inventory.items.push(notEquippable);
      expect(() => hero.equip(notEquippable)).toThrow(ProceduralViolation);

      const slotless = makeGear({ type: "consumable", slot: undefined });
      hero.inventory.items.push(slotless);
      expect(() => hero.equip(slotless)).toThrow(ProceduralViolation);

      const ring = makeGear({ type: "accessory", slot: "finger" });
      hero.inventory.items.push(ring);
      expect(() => hero.equip(ring, EquipmentSlot.Head)).toThrow(ProceduralViolation);
    });

    it("throws when unequipping an item that is not equipped", () => {
      const helm = makeGear({ type: "armor", slot: "head" });
      const hero = heroWith(helm);
      expect(() => hero.unequip(helm)).toThrow(ProceduralViolation);
    });

    it("records no history (free actions)", () => {
      const helm = makeGear({ type: "armor", slot: "head" });
      const hero = heroWith(helm);
      const before = hero.history.length;
      hero.equip(helm);
      hero.unequip(helm);
      expect(hero.history.length).toBe(before);
    });

    it("equipping via the item's own action still validates the slot (no bypass)", () => {
      const hero = new Character(new Campaign("Equip"), "Hero", makeStats());
      const helm = makeGear({ type: "armor", slot: "head", name: "Helm" });
      hero.addToInventory(helm); // claims the item to the hero (sets its holder)

      helm.actions.equip(hero); // public low-level entry → routes to hero.equip

      expect(hero.equipment.get(EquipmentSlot.Head)).toBe(helm);
      expect(helm.properties.equipped).toBe(true);
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/character/character.test.ts`
Expected: FAIL — `equip`/`unequip`/`equipment` do not exist.

- [ ] **Step 3: Implement**

In `src/lib/character/character.ts`:

(a) Add `EQUIP`/`UNEQUIP` to the inventory import and import the equipment module:

```ts
import { CLAIM, DEPOSIT_MATERIALS, EQUIP, IItem, IItemHolder, Inventory, MaterialMap, SET_DURABILITY, UNEQUIP } from "../inventory";
import {
  DEFAULT_EQUIPMENT_SLOTS,
  EquipmentSlot,
  SLOT_KIND,
} from "../equipment";
```

(b) In the `ICharacter` interface, add (after `repair`):

```ts
  /** The character's currently filled equipment slots (named slot → item). */
  get equipment(): ReadonlyMap<EquipmentSlot, IItem>;
  /** Equips a held item into a named slot of its kind, auto-swapping conflicts (free). */
  equip: (item: IItem, targetSlot?: EquipmentSlot) => void;
  /** Removes an equipped item from its slot(s) (free). */
  unequip: (item: IItem) => void;
```

(c) In the `Character` class private properties (next to `#inventory`):

```ts
  #equipment: Map<EquipmentSlot, IItem> = new Map();
  #slots: readonly EquipmentSlot[] = DEFAULT_EQUIPMENT_SLOTS;
```

(d) Add a getter (next to `get inventory()`):

```ts
  get equipment(): ReadonlyMap<EquipmentSlot, IItem> {
    return this.#equipment;
  }
```

(e) Add the methods (place after `repair`). They are **free** (no `recordAction`, not in
`isActionMap`):

```ts
  /**
   * Equips a held item into one of the character's named slots of the item's
   * slot kind. Auto-assigns the first free slot of that kind (or the named
   * `targetSlot`), displacing whatever is there (the displaced item stays in
   * inventory, unequipped). A two-handed weapon spans both hand slots. Free — no
   * budgeted action, no history.
   *
   * @throws {@link ProceduralViolation} if the item is not held, not equippable,
   *   has no slot kind, the character has no slot of that kind, or `targetSlot`
   *   does not fit the item.
   */
  equip(item: IItem, targetSlot?: EquipmentSlot) {
    if (!this.#inventory.items.some((i) => i.id === item.id)) {
      throw new ProceduralViolation("Cannot equip an item the character is not holding.");
    }
    if (!item.properties.equippable) {
      throw new ProceduralViolation("Item is not equippable.");
    }
    if (item.slot === undefined) {
      throw new ProceduralViolation("Item has no equipment slot.");
    }
    // Re-equipping a worn item: free its current slot(s) first.
    if (item.properties.equipped) {
      this.unequip(item);
    }

    // Two-handed weapons span both hands.
    if (item.type === "weapon" && item.twoHanded) {
      for (const hand of [EquipmentSlot.LeftHand, EquipmentSlot.RightHand]) {
        const occupant = this.#equipment.get(hand);
        if (occupant) this.unequip(occupant);
      }
      this.#equipment.set(EquipmentSlot.LeftHand, item);
      this.#equipment.set(EquipmentSlot.RightHand, item);
      item[EQUIP](this);
      return;
    }

    const eligible = this.#slots.filter((s) => SLOT_KIND[s] === item.slot);
    if (eligible.length === 0) {
      throw new ProceduralViolation("Character has no slot for this item.");
    }

    let slot: EquipmentSlot;
    if (targetSlot !== undefined) {
      if (!eligible.includes(targetSlot)) {
        throw new ProceduralViolation("Target slot does not fit this item.");
      }
      slot = targetSlot;
    } else {
      // First free eligible slot in canonical order, else displace the first.
      slot = eligible.find((s) => !this.#equipment.has(s)) ?? eligible[0]!;
    }

    const occupant = this.#equipment.get(slot);
    if (occupant && occupant.id !== item.id) {
      this.unequip(occupant); // auto-swap (a 2H occupant frees both hands)
    }
    this.#equipment.set(slot, item);
    item[EQUIP](this);
  }

  /**
   * Removes an equipped item from every slot it occupies (a two-handed weapon
   * occupies two). Free — no budgeted action, no history.
   *
   * @throws {@link ProceduralViolation} if the item is not held or not equipped.
   */
  unequip(item: IItem) {
    if (!this.#inventory.items.some((i) => i.id === item.id)) {
      throw new ProceduralViolation("Cannot unequip an item the character is not holding.");
    }
    if (!item.properties.equipped) {
      throw new ProceduralViolation("Item is not equipped.");
    }
    for (const slot of [...this.#equipment.keys()]) {
      if (this.#equipment.get(slot)?.id === item.id) {
        this.#equipment.delete(slot);
      }
    }
    item[UNEQUIP](this);
  }
```

(f) **Reroute the item wrapper** in `src/lib/inventory.ts` so a slotted item routes through
the validated path (slotless items keep the legacy inline toggle from Task 3):

```ts
      [ItemAction.Equip]: () => {
        const holder = this.#characterHolder();
        if (!holder) return;
        if (this.slot !== undefined) {
          holder.equip(this);
          return;
        }
        this[EQUIP](holder);
      },
      [ItemAction.Unequip]: () => {
        const holder = this.#characterHolder();
        if (!holder) return;
        if (this.slot !== undefined) {
          holder.unequip(this);
          return;
        }
        this[UNEQUIP](holder);
      },
```

Notes for the implementer:
- `item[EQUIP](this)` / `item[UNEQUIP](this)` are the terminal low-level methods from Task 3 —
  they run the item's behavior, toggle `properties.equipped`, and fire the event. `Character.equip`
  performs validation + slot bookkeeping around them; calling them (not `actions.equip`) is what
  avoids the wrapper↔character loop.
- The combat filters in `combatant.ts`/`character.ts` are unchanged — they read
  `properties.equipped`, which these methods keep in sync, and are now bounded by the slot count.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/character/character.test.ts` → PASS.
Then the whole suite to catch the reroute's effect on existing equip tests:
`npx vitest run src/lib/inventory.test.ts` (the pre-existing slotless equip tests must stay green).
Then `npx tsc --noEmit` and `npx eslint src/lib/character/character.ts src/lib/inventory.ts src/lib/character/character.test.ts` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/character/character.ts src/lib/inventory.ts src/lib/character/character.test.ts
git commit -m "$(cat <<'EOF'
feat: Character.equip/unequip with named slots; route item equip through it

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Capping regression + integration seam

**Files:**
- Test: `src/lib/character/player-character.test.ts`

Prove the headline outcome — equipping is now bounded, so combat can't be fed more weapons
than hands — and an end-to-end equip flow.

- [ ] **Step 1: Write the tests** (these pass once Tasks 1–4 are in, like an integration seam)

In `src/lib/character/player-character.test.ts`, add a real-`Item` hand-weapon helper at
module scope:

```ts
function makeHandWeapon(opts: { modifier?: number; twoHanded?: boolean; name?: string }): Item {
  const noop = () => {};
  return new Item(
    {
      type: "weapon",
      recipe: { metal: 1 },
      modifier: opts.modifier ?? 2,
      stat: StatType.Health,
      name: opts.name ?? "Blade",
      slot: "hand",
      twoHanded: opts.twoHanded,
    },
    { equippable: true, equipped: false, destroyable: true, usable: false },
    { pickUp: noop, equip: noop, unequip: noop, transfer: noop, use: noop, destroy: () => null },
    { onPickUp: noop },
  );
}
```

Then a `describe("equipment seam", …)` block:

```ts
  describe("equipment seam", () => {
    it("caps attack at hand count — a third weapon displaces one", () => {
      const campaign = new Campaign("Seam");
      const hero = new PlayerCharacter(campaign, "Hero", makeStats());
      const a = makeHandWeapon({ modifier: 2, name: "A" });
      const b = makeHandWeapon({ modifier: 2, name: "B" });
      const c = makeHandWeapon({ modifier: 2, name: "C" });
      [a, b, c].forEach((w) => hero.inventory.items.push(w));

      hero.equip(a);
      hero.equip(b); // both hands full
      hero.equip(c); // displaces the occupant of the first hand

      const equippedWeapons = hero.inventory.items.filter((w) => w.properties.equipped);
      expect(equippedWeapons).toHaveLength(2); // never three

      // attack sums exactly the two equipped weapons (2 + 2 = 4 to Health)
      const defender = makeDefender();
      hero.attack(defender);
      expect(defender.takeDamage).toHaveBeenCalledWith(4, StatType.Health);
    });

    it("a two-handed weapon yields a single-weapon attack", () => {
      const campaign = new Campaign("Seam");
      const hero = new PlayerCharacter(campaign, "Hero", makeStats());
      const greatsword = makeHandWeapon({ modifier: 5, twoHanded: true, name: "2H" });
      hero.inventory.items.push(greatsword);
      hero.equip(greatsword);

      const defender = makeDefender();
      hero.attack(defender);

      // Only the one weapon contributes (both hands are the same item).
      expect(defender.takeDamage).toHaveBeenCalledTimes(1);
      expect(defender.takeDamage).toHaveBeenCalledWith(5, StatType.Health);
    });
  });
```

(Confirm the import line includes `Item`, `Campaign`, `StatType`, `makeDefender`, `makeStats` —
all already imported in this file from ③; add `Item` to the inventory import if it isn't there.)

- [ ] **Step 2: Run the tests**

Run: `npx vitest run src/lib/character/player-character.test.ts` → PASS. If the third-weapon test
fails, equip didn't cap — fix the implementation, not the test.

- [ ] **Step 3: Full suite + static checks**

```
npm run checks
```
Expected: eslint clean, `tsc --noEmit` clean, all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/lib/character/player-character.test.ts
git commit -m "$(cat <<'EOF'
test: equipment seam — slots cap weapons fed to attack

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Done (④a)

After Task 5: `feature/equipment-slots` holds the spec plus five feature commits. Hand off to
**superpowers:finishing-a-development-branch** (Push & open PR against `main`). Then ④b (passive
ring effects / effective-stat layer) gets its own plan on a fresh branch.
