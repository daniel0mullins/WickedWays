# Looting Interaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a player look inside a co-located loot box, take items out, and put items back, built on a shared `IItemHolder` abstraction so an item is always held by exactly one holder (a character or a box).

**Architecture:** Introduce `IItemHolder` (`holderKind`, `hasRoomForItem`, `receiveItem`, `relinquishItem`) implemented by both `Character` and `Loot`. An item's `heldBy` widens to a holder and is re-pointed only through a symbol-keyed `CLAIM` invoked by a holder's `receiveItem`. `Character.addToInventory`/`removeFromInventory` and `Loot.stowItem` are refactored onto these primitives; the player verbs (`openLootBox`, `takeFromLootBox`, `putInLootBox`) live on `PlayerCharacter` and reuse them.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`), Vitest, ESLint (typescript-eslint type-checked). Spec: `docs/superpowers/specs/2026-06-05-looting-interaction-design.md`.

**Conventions for every task:**
- Tests use Vitest (`import { describe, expect, it, vi } from "vitest"`).
- Run a single file with `npx vitest run <path>`.
- The full gate is `npm run checks` (lint → typecheck → test).
- Commit messages end with the `Co-Authored-By` trailer already used in this repo.
- Work happens on the existing `looting-interaction` branch.

---

## File Map

- `src/lib/inventory.ts` — add `IItemHolder`, `ItemHolder`, `CLAIM`; widen `Item.heldBy`; add `[CLAIM]` + `#characterHolder`; refactor `Item.actions`.
- `src/lib/character/character.ts` — `ICharacter extends IItemHolder`; add `holderKind`/`hasRoomForItem`/`receiveItem`/`relinquishItem`; refactor `addToInventory`/`removeFromInventory`.
- `src/lib/loot.ts` — `ILoot extends IItemHolder`; add the same holder surface; claim contents at construction; route `stowItem` through `receiveItem`.
- `src/lib/character/player-character.ts` — co-location guard; `openLootBox` (look), `takeFromLootBox`, `putInLootBox`; drop `openLootBox` from `isActionMap`.
- Tests: `src/lib/inventory.test.ts`, `src/lib/character/character.test.ts`, `src/lib/loot.test.ts`, `src/lib/character/player-character.test.ts`.

**Decision recorded during planning (deviation from spec §Layering):** `Item.actions.transfer`/`use` keep calling `holder.removeFromInventory(this)` rather than `relinquishItem`. `removeFromInventory` records an action; `relinquishItem` does not, so switching would silently change the action cost of using/transferring an item and break existing assertions. The unified-holder goal (symmetric `receiveItem`/`relinquishItem`, polymorphic `heldBy`) is fully met for the looting flow without that switch.

---

## Task 1: Holder abstraction core

Lands `IItemHolder` across `inventory.ts`, `character.ts`, and `loot.ts` together (they are mutually type-dependent through `heldBy`), with all affected unit tests updated. After this task the suite is green and `heldBy` correctly tracks whichever holder owns an item.

**Files:**
- Modify: `src/lib/inventory.ts`
- Modify: `src/lib/character/character.ts`
- Modify: `src/lib/loot.ts`
- Test: `src/lib/inventory.test.ts`, `src/lib/character/character.test.ts`, `src/lib/loot.test.ts`

- [ ] **Step 1: Update `inventory.test.ts` for the new holder semantics**

Replace the top helpers and the affected tests. `pickUp` no longer sets `heldBy`; an item becomes held by calling `CLAIM`. Mock holders now carry `holderKind`.

Change the imports at the top of `src/lib/inventory.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import type { ICharacter } from "./character/character";
import { StatType } from "./character/stats";
import { CLAIM, Item, type IItemHolder } from "./inventory";
import { ProceduralViolation } from "./util";
```

Replace the `HELD_BY`/`heldBy`/`makeHolder` block (lines 14-23) with:

```ts
// `HELD_BY` lives in the global symbol registry, so the test can read the
// private holder through the same key the class exposes it under.
const HELD_BY = Symbol.for("heldBy");
function heldBy(item: Item): IItemHolder | null {
  return (
    (item as unknown as Record<symbol, IItemHolder | null>)[HELD_BY] ?? null
  );
}

// A holder claims an item the same way `receiveItem` does internally.
function hold(item: Item, holder: IItemHolder): void {
  (item as unknown as Record<symbol, (h: IItemHolder | null) => void>)[CLAIM](
    holder,
  );
}

function makeHolder(): ICharacter {
  return {
    holderKind: "character",
    removeFromInventory: vi.fn(),
  } as unknown as ICharacter;
}
```

Replace the `pickUp` describe block (lines 92-103) — `pickUp` is now only the gameplay hook:

```ts
  describe("pickUp", () => {
    it("fires the underlying action and event without claiming the item", () => {
      const { item, actions, events } = makeItem();
      const holder = makeHolder();

      item.actions.pickUp(holder);

      expect(actions.pickUp).toHaveBeenCalledWith(holder);
      expect(events.onPickUp).toHaveBeenCalledWith(holder);
      // pickUp no longer sets heldBy; a holder's receiveItem does.
      expect(heldBy(item)).toBeNull();
    });
  });
```

In every other test that previously did `item.actions.pickUp(holder)` to make the item held, replace that call with `hold(item, holder)`. Concretely, in the `equip`, `unequip`, `use`, `transfer`, and `destroy` describe blocks change lines of the form `item.actions.pickUp(holder)` to `hold(item, holder)`. The `transfer` "moves the item" test keeps its assertions (`heldBy(item)` becomes `recipient`, and `holder.removeFromInventory` is called) because `transfer` still sets `heldBy` directly.

In the `optional events` test (lines 224-248) replace `item.actions.pickUp(holder)` with `hold(item, holder)` and keep the remaining assertions, but drop the `onPickUp` expectation line that depended on pickUp claiming (`expect(onPickUp).toHaveBeenCalledWith(holder)` becomes a direct `item.actions.pickUp(holder); expect(onPickUp).toHaveBeenCalledWith(holder);` before the equip call).

- [ ] **Step 2: Add holder-conformance tests to `character.test.ts`**

Append this describe block inside the top-level `describe("Character", …)` in `src/lib/character/character.test.ts` (before its closing `});`):

```ts
  describe("IItemHolder conformance", () => {
    it("identifies itself as a character holder", () => {
      expect(makeCharacter().holderKind).toBe("character");
    });

    it("reports room while under capacity and none when full", () => {
      const character = makeCharacter({ inventorySlots: 1 });
      expect(character.hasRoomForItem()).toBe(true);

      character.receiveItem(makeItem());
      expect(character.hasRoomForItem()).toBe(false);
    });

    it("receiveItem adds the item and records itself as the holder", () => {
      const character = makeCharacter();
      const item = makeItem();

      character.receiveItem(item);

      expect(character.inventory.items).toContain(item);
      expect(item[Symbol.for("heldBy")]).toBe(character);
    });

    it("relinquishItem removes the item from the inventory", () => {
      const character = makeCharacter();
      const item = makeItem();
      character.receiveItem(item);

      character.relinquishItem(item);

      expect(character.inventory.items).not.toContain(item);
    });
  });
```

Add `CLAIM` to this file's inventory import (change the existing `import { ... } from "../inventory";` line):

```ts
import { CLAIM, type IItem, type ItemId } from "../inventory";
```

The existing `makeItem` stub in this file (`{ id, actions: { pickUp: vi.fn() } }`) must also support `CLAIM`/`HELD_BY` so `receiveItem` works. Replace `makeItem` (lines 33-40) with:

```ts
let itemCounter = 0;
function makeItem(id?: string): IItem {
  const itemId = (id ?? `item-${++itemCounter}`) as ItemId;
  let holder: unknown = null;
  return {
    id: itemId,
    actions: { pickUp: vi.fn() },
    [CLAIM]: (h: unknown) => {
      holder = h;
    },
    get [Symbol.for("heldBy")]() {
      return holder;
    },
  } as unknown as IItem;
}
```

- [ ] **Step 3: Add holder-conformance tests to `loot.test.ts`**

The `makeItem` stub in `src/lib/loot.test.ts` must support `CLAIM`/`HELD_BY` because `Loot` now claims its contents. Replace its import line and `makeItem` (lines 1-19 region) with:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";

import { CLAIM, type IItem, type ItemId } from "./inventory";
import { Loot } from "./loot";
import { ContainerFullException, generateId } from "./util";

const HELD_BY = Symbol.for("heldBy");

// `Loot` reads each item's `id` and claims it as holder, so the stub supports
// the CLAIM symbol and the HELD_BY getter.
function makeItem(id: ItemId = generateId<ItemId>()): IItem {
  let holder: unknown = null;
  return {
    id,
    [CLAIM]: (h: unknown) => {
      holder = h;
    },
    get [HELD_BY]() {
      return holder;
    },
  } as unknown as IItem;
}
```

Append this describe block before the final `});` of `describe("Loot", …)`:

```ts
  describe("IItemHolder conformance", () => {
    it("identifies itself as a loot holder", () => {
      expect(new Loot("chest", []).holderKind).toBe("loot");
    });

    it("claims its initial contents as their holder", () => {
      const item = makeItem();
      const loot = new Loot("chest", [item]);

      expect(item[HELD_BY]).toBe(loot);
    });

    it("receiveItem stows the item and claims it", () => {
      const loot = new Loot("chest", []);
      const item = makeItem();

      loot.receiveItem(item);

      expect(loot.contents).toContain(item);
      expect(item[HELD_BY]).toBe(loot);
    });

    it("relinquishItem removes the item from contents", () => {
      const item = makeItem();
      const loot = new Loot("chest", [item]);

      loot.relinquishItem(item);

      expect(loot.contents).not.toContain(item);
    });

    it("reports no room once at capacity", () => {
      const loot = new Loot("chest", []); // capacity 2
      expect(loot.hasRoomForItem()).toBe(true);
      loot.stowItem(makeItem());
      loot.stowItem(makeItem());
      expect(loot.hasRoomForItem()).toBe(false);
    });
  });
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npx vitest run src/lib/inventory.test.ts src/lib/character/character.test.ts src/lib/loot.test.ts`
Expected: FAIL — `CLAIM`, `IItemHolder`, `holderKind`, `receiveItem`, `relinquishItem`, `hasRoomForItem` do not exist yet (compile / runtime errors).

- [ ] **Step 5: Implement the holder surface in `inventory.ts`**

Add the import beside the existing `ICharacter` type import (top of file):

```ts
import type { ILoot } from "./loot";
```

Add these declarations immediately above the `const HELD_BY = Symbol.for("heldBy");` line:

```ts
export interface IItemHolder {
  readonly holderKind: "character" | "loot";
  hasRoomForItem(): boolean;
  receiveItem(item: IItem): void;
  relinquishItem(item: IItem): void;
}

export type ItemHolder = ICharacter | ILoot;

// Re-pointing an item's holder is funnelled through this symbol-keyed method so
// external code cannot reassign `heldBy` directly (the public setter throws).
// Only a holder's `receiveItem` should call it.
export const CLAIM = Symbol("claimItem");
```

In `interface IItem`, change the `heldBy` line and add the claim member:

```ts
  readonly [HELD_BY]: ItemHolder | null;
  [CLAIM](holder: ItemHolder | null): void;
  actions: ItemActions;
```

In `class Item`, change the field, getter, setter, and add the claim method and the character-holder helper:

```ts
  #heldBy: ItemHolder | null = null;

  get [HELD_BY]() {
    return this.#heldBy;
  }

  set heldBy(_value: ItemHolder | null) {
    throw new ProceduralViolation("Cannot set 'heldBy' directly!");
  }

  [CLAIM](holder: ItemHolder | null) {
    this.#heldBy = holder;
  }

  // The character-only item actions (equip/unequip/use/transfer/destroy) operate
  // only while a character holds the item; box-held items make them no-ops.
  #characterHolder(): ICharacter | null {
    return this.#heldBy?.holderKind === "character" ? this.#heldBy : null;
  }
```

Replace the entire `this.actions = { … };` assignment in the constructor with:

```ts
    this.actions = {
      [ItemAction.PickUp]: (c) => {
        actions[ItemAction.PickUp](c);
        events.onPickUp(c);
      },
      [ItemAction.Equip]: () => {
        const holder = this.#characterHolder();
        if (!holder) return;
        actions[ItemAction.Equip](holder);
        this.properties.equipped = true;
        events.onEquip?.(holder);
      },
      [ItemAction.Unequip]: () => {
        const holder = this.#characterHolder();
        if (!holder) return;
        actions[ItemAction.Unequip](holder);
        this.properties.equipped = false;
        events.onUnequip?.(holder);
      },
      [ItemAction.Transfer]: (_c, cc) => {
        const holder = this.#characterHolder();
        if (!holder) return;
        actions[ItemAction.Transfer](holder, cc);
        events.onTransfer?.(holder, cc);
        holder.removeFromInventory(this);
        this.#heldBy = cc;
      },
      [ItemAction.Use]: () => {
        const holder = this.#characterHolder();
        if (!holder) return;
        actions[ItemAction.Use](holder);
        events.onUse?.(holder);
        holder.removeFromInventory(this);
      },
      [ItemAction.Destroy]: () => {
        const holder = this.#characterHolder();
        if (!holder) return null;
        const components = actions[ItemAction.Destroy]();
        events.onDestroy?.(holder, components);
        return components;
      },
    };
```

- [ ] **Step 6: Implement the holder surface in `character.ts`**

Change the inventory import (line 3) to pull in the new members:

```ts
import { CLAIM, IItem, IItemHolder, Inventory } from "../inventory";
```

Make `ICharacter` extend the holder interface and pin its `holderKind`. Change the interface header and add the discriminant near the other properties:

```ts
export interface ICharacter extends IItemHolder {
  // ### Properties
  id: CharacterId;
  name: string;
  stats: Stats;
  actionsPerRound: number;
  readonly holderKind: "character";
  readonly isActionMap: WeakMap<ActionFn, boolean>;
```

(The `hasRoomForItem`/`receiveItem`/`relinquishItem` signatures are inherited from `IItemHolder`.)

In `class Character`, add the discriminant property near the other public properties:

```ts
  readonly holderKind = "character" as const;
```

Replace the private `#canAddToInventory` method with the public holder methods:

```ts
  hasRoomForItem() {
    return this.#inventory.items.length < this.#inventory.slots;
  }

  receiveItem(item: IItem) {
    this.#inventory.items.push(item);
    item[CLAIM](this);
  }

  relinquishItem(item: IItem) {
    this.#inventory.items = this.#inventory.items.filter(
      (current) => current.id !== item.id,
    );
  }
```

Replace `addToInventory` with:

```ts
  addToInventory(item: IItem | IItem[]) {
    const items = Array.isArray(item) ? item : [item];
    for (const current of items) {
      if (this.hasRoomForItem()) {
        this.receiveItem(current);
        current.actions.pickUp(this);
      } else {
        throw new ProceduralViolation(
          "Attempted to add to inventory, but character doesn't have enough slots!",
        );
      }
    }
    this.recordAction(this.addToInventory);
  }
```

Replace `removeFromInventory` with:

```ts
  removeFromInventory(item: IItem | IItem[]) {
    const items = Array.isArray(item) ? item : [item];
    for (const current of items) {
      const held = this.#inventory.items.some((i) => i.id === current.id);
      if (!held) {
        throw new ProceduralViolation(
          "Attempted to remove an item from inventory, but the item was not in the character's inventory!",
        );
      }
      this.relinquishItem(current);
    }
    this.recordAction(this.removeFromInventory);
  }
```

- [ ] **Step 7: Implement the holder surface in `loot.ts`**

Change the inventory import (line 2) to:

```ts
import { CLAIM, IItem, IItemHolder, ItemId } from "./inventory";
```

Make `ILoot` extend the holder interface and pin `holderKind`:

```ts
export interface ILoot extends IItemHolder {
  id: LootId;
  description: string;
  contents: IItem[];
  removeItems: (itemId: ItemId | ItemId[]) => IItem[];
  stowItem: (item: IItem) => void;
  readonly holderKind: "loot";
  readonly capacity: number;
}
```

In `class Loot`, add the discriminant and claim the contents in the constructor:

```ts
  readonly holderKind = "loot" as const;
```

Append to the constructor body (after `this.#capacity = contents.length + 2;`):

```ts
    for (const item of contents) {
      item[CLAIM](this);
    }
```

Add the holder methods and route `stowItem` through `receiveItem` (replace the existing `stowItem`):

```ts
  hasRoomForItem() {
    return this.contents.length < this.#capacity;
  }

  receiveItem(item: IItem) {
    this.contents.push(item);
    item[CLAIM](this);
  }

  relinquishItem(item: IItem) {
    const index = this.contents.findIndex((value) => value.id === item.id);
    if (index !== -1) {
      this.contents.splice(index, 1);
    }
  }

  stowItem(item: IItem) {
    if (this.hasRoomForItem()) {
      this.receiveItem(item);
    } else {
      throw new ContainerFullException(this.id);
    }
  }
```

- [ ] **Step 8: Run the gate**

Run: `npm run checks`
Expected: PASS — lint clean, typecheck clean, all tests pass.

- [ ] **Step 9: Commit**

```bash
git add src/lib/inventory.ts src/lib/character/character.ts src/lib/loot.ts \
  src/lib/inventory.test.ts src/lib/character/character.test.ts src/lib/loot.test.ts
git commit -m "$(cat <<'EOF'
Add IItemHolder abstraction for items

Characters and loot boxes both implement receiveItem/relinquishItem/
hasRoomForItem; an item's heldBy is a holder, re-pointed only via a
symbol-keyed CLAIM. addToInventory/removeFromInventory/stowItem now build
on these primitives.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `openLootBox` becomes a free, read-only look

**Files:**
- Modify: `src/lib/character/player-character.ts`
- Test: `src/lib/character/player-character.test.ts`

- [ ] **Step 1: Add the look + co-location test helpers and tests**

In `src/lib/character/player-character.test.ts`, add imports:

```ts
import type { IRoom } from "../room";
import { Loot } from "../loot";
import { ProceduralViolation } from "../util";
import { CLAIM } from "../inventory";
```

Add a richer item factory and a room helper near the existing factories (the existing `makeWeapon`/`makeLoot` stay for the attack tests):

```ts
const HELD_BY = Symbol.for("heldBy");

// Item stub that supports the holder plumbing (CLAIM + HELD_BY) and pickUp,
// so it works with a real Loot box and with addToInventory.
function makeLootItem(id: string): IItem {
  let holder: unknown = null;
  return {
    id: id as ItemId,
    actions: { pickUp: vi.fn() },
    [CLAIM]: (h: unknown) => {
      holder = h;
    },
    get [HELD_BY]() {
      return holder;
    },
  } as unknown as IItem;
}

// A room whose loot map contains `box`, so the player can be co-located with it.
function makeRoomWith(box: Loot): IRoom {
  return {
    loot: new Map([[box.id, box]]),
    enterRoom: vi.fn(),
    exitRoom: vi.fn(),
  } as unknown as IRoom;
}

// Build a player already standing in a room that holds the box.
function makePcInRoomWith(
  box: Loot,
  opts: { inventorySlots?: number; actionsPerRound?: number } = {},
) {
  const pc = new PlayerCharacter(
    makeCampaign(),
    "Hero",
    makeStats(),
    opts.inventorySlots,
  );
  if (opts.actionsPerRound !== undefined) {
    pc.actionsPerRound = opts.actionsPerRound;
  }
  pc.move(makeRoomWith(box)); // sets currentRoom
  pc.startTurn(); // reset the action count consumed by move()
  return pc;
}
```

Add the look tests:

```ts
  describe("openLootBox", () => {
    it("returns the contents of a co-located loot box", () => {
      const contents = [makeLootItem("a"), makeLootItem("b")];
      const box = new Loot("chest", contents);
      const pc = makePcInRoomWith(box);

      expect(pc.openLootBox(box)).toEqual(contents);
    });

    it("returns a view that cannot mutate the box", () => {
      const box = new Loot("chest", [makeLootItem("a")]);
      const pc = makePcInRoomWith(box);

      const view = pc.openLootBox(box) as IItem[];
      view.push(makeLootItem("x"));

      expect(box.contents).toHaveLength(1);
    });

    it("does not cost an action", () => {
      const box = new Loot("chest", [makeLootItem("a")]);
      const pc = makePcInRoomWith(box, { actionsPerRound: 1 });
      const onTurnEnd = vi.spyOn(pc.events, "onTurnEnd");

      pc.openLootBox(box);

      expect(onTurnEnd).not.toHaveBeenCalled();
    });

    it("throws when the box is not in the player's room", () => {
      const box = new Loot("chest", [makeLootItem("a")]);
      const pc = new PlayerCharacter(makeCampaign(), "Hero", makeStats());

      expect(() => pc.openLootBox(box)).toThrow(ProceduralViolation);
    });
  });
```

Remove the two now-invalid expectations about `openLootBox` in the existing tests: in the constructor test `registers move, attack, and openLootBox as recordable actions`, delete the `expect(pc.isActionMap.get(pc.openLootBox)).toBe(true);` line (rename the test to `registers move and attack as recordable actions`). Delete the existing `describe("openLootBox", …)` block (lines 205-226) that asserts it returns the live contents and counts as an action — it is replaced by the block above.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/character/player-character.test.ts`
Expected: FAIL — `openLootBox` still records an action and returns the live array; co-location guard absent.

- [ ] **Step 3: Implement look + co-location guard**

In `src/lib/character/player-character.ts`, update the imports:

```ts
import { ICampaign } from "../campaign";
import { IItem } from "../inventory";
import { ILoot } from "../loot";
import { typedEntries, ProceduralViolation } from "../util";
import { Character, ICharacter } from "./character";
import { Stats, StatType } from "./stats";
```

Update the interface members:

```ts
export interface IPlayerCharacter extends ICharacter {
  attack: <C extends ICharacter>(c: C) => void;
  openLootBox: (lootBox: ILoot) => readonly IItem[];
  takeFromLootBox: (lootBox: ILoot, item: IItem | IItem[]) => IItem[];
  putInLootBox: (lootBox: ILoot, item: IItem | IItem[]) => IItem[];
}
```

In the constructor, remove the `openLootBox` registration so looking is free:

```ts
    this.isActionMap.set(this.move, true);
    this.isActionMap.set(this.attack, true);
```

Add the guard helper and replace `openLootBox`:

```ts
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
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/lib/character/player-character.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the gate and commit**

```bash
npm run checks
git add src/lib/character/player-character.ts src/lib/character/player-character.test.ts
git commit -m "$(cat <<'EOF'
Make openLootBox a free, co-located read-only look

openLootBox now requires the box to be in the player's current room,
returns a shallow read-only view of the contents, and no longer records
an action.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `takeFromLootBox`

**Files:**
- Modify: `src/lib/character/player-character.ts`
- Test: `src/lib/character/player-character.test.ts`

- [ ] **Step 1: Write the take tests**

Append to `src/lib/character/player-character.test.ts`:

```ts
  describe("takeFromLootBox", () => {
    it("moves a specific item from the box into the inventory", () => {
      const target = makeLootItem("a");
      const box = new Loot("chest", [target, makeLootItem("b")]);
      const pc = makePcInRoomWith(box);

      const taken = pc.takeFromLootBox(box, target);

      expect(taken).toEqual([target]);
      expect(pc.inventory.items).toContain(target);
      expect(box.contents).not.toContain(target);
      expect(target.actions.pickUp).toHaveBeenCalledWith(pc);
      expect(target[HELD_BY]).toBe(pc);
    });

    it("takes only what fits, leaving the rest in the box", () => {
      const items = [makeLootItem("a"), makeLootItem("b"), makeLootItem("c")];
      const box = new Loot("chest", items);
      const pc = makePcInRoomWith(box, { inventorySlots: 2 });

      const taken = pc.takeFromLootBox(box, items);

      expect(taken).toHaveLength(2);
      expect(pc.inventory.items).toHaveLength(2);
      expect(box.contents).toHaveLength(1);
    });

    it("takes nothing and costs no action when the inventory is full", () => {
      const box = new Loot("chest", [makeLootItem("a")]);
      const pc = makePcInRoomWith(box, { inventorySlots: 1, actionsPerRound: 1 });
      pc.addToInventory(makeLootItem("filler")); // fills the single slot, ends turn
      pc.startTurn(); // fresh turn for the assertion
      const onTurnEnd = vi.spyOn(pc.events, "onTurnEnd");

      const taken = pc.takeFromLootBox(box, box.contents[0]!);

      expect(taken).toEqual([]);
      expect(onTurnEnd).not.toHaveBeenCalled();
    });

    it("skips an item that is not in the box", () => {
      const box = new Loot("chest", [makeLootItem("a")]);
      const pc = makePcInRoomWith(box);

      expect(pc.takeFromLootBox(box, makeLootItem("ghost"))).toEqual([]);
    });

    it("records exactly one action when items move", () => {
      const box = new Loot("chest", [makeLootItem("a"), makeLootItem("b")]);
      const pc = makePcInRoomWith(box, { actionsPerRound: 1 });
      const onTurnEnd = vi.spyOn(pc.events, "onTurnEnd");

      pc.takeFromLootBox(box, box.contents.slice());

      expect(onTurnEnd).toHaveBeenCalledTimes(1);
    });

    it("throws when the box is not co-located", () => {
      const box = new Loot("chest", [makeLootItem("a")]);
      const pc = new PlayerCharacter(makeCampaign(), "Hero", makeStats());

      expect(() => pc.takeFromLootBox(box, box.contents[0]!)).toThrow(
        ProceduralViolation,
      );
    });
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/character/player-character.test.ts -t takeFromLootBox`
Expected: FAIL — `takeFromLootBox` does not exist.

- [ ] **Step 3: Implement `takeFromLootBox`**

Add to `class PlayerCharacter` (after `openLootBox`):

```ts
  takeFromLootBox(lootBox: ILoot, item: IItem | IItem[]): IItem[] {
    this.#requireCoLocated(lootBox);
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
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/lib/character/player-character.test.ts -t takeFromLootBox`
Expected: PASS.

- [ ] **Step 5: Run the gate and commit**

```bash
npm run checks
git add src/lib/character/player-character.ts src/lib/character/player-character.test.ts
git commit -m "$(cat <<'EOF'
Add takeFromLootBox best-effort taking

Moves co-located loot into the inventory up to the free slot count,
firing pickUp and recording one action when at least one item moves.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `putInLootBox`

**Files:**
- Modify: `src/lib/character/player-character.ts`
- Test: `src/lib/character/player-character.test.ts`

- [ ] **Step 1: Write the put tests**

Append to `src/lib/character/player-character.test.ts`:

```ts
  describe("putInLootBox", () => {
    it("moves a held item into the box", () => {
      const box = new Loot("chest", []); // capacity 2
      const pc = makePcInRoomWith(box, { actionsPerRound: 99 });
      const item = makeLootItem("a");
      pc.addToInventory(item);

      const put = pc.putInLootBox(box, item);

      expect(put).toEqual([item]);
      expect(box.contents).toContain(item);
      expect(pc.inventory.items).not.toContain(item);
      expect(item[HELD_BY]).toBe(box);
    });

    it("puts only what fits, leaving the rest in the inventory", () => {
      const box = new Loot("chest", [makeLootItem("x")]); // capacity 3, 1 used
      const pc = makePcInRoomWith(box, { inventorySlots: 5, actionsPerRound: 99 });
      const held = [makeLootItem("a"), makeLootItem("b"), makeLootItem("c")];
      pc.addToInventory(held);

      const put = pc.putInLootBox(box, held);

      expect(put).toHaveLength(2); // box had room for 2 more
      expect(box.contents).toHaveLength(3);
      expect(pc.inventory.items).toHaveLength(1);
    });

    it("puts nothing and costs no action when the box is full", () => {
      const box = new Loot("chest", [makeLootItem("x"), makeLootItem("y")]); // full (cap 2)
      const pc = makePcInRoomWith(box, { inventorySlots: 5, actionsPerRound: 1 });
      const item = makeLootItem("a");
      pc.addToInventory(item);
      pc.startTurn();
      const onTurnEnd = vi.spyOn(pc.events, "onTurnEnd");

      const put = pc.putInLootBox(box, item);

      expect(put).toEqual([]);
      expect(onTurnEnd).not.toHaveBeenCalled();
    });

    it("skips an item the player is not holding", () => {
      const box = new Loot("chest", []);
      const pc = makePcInRoomWith(box);

      expect(pc.putInLootBox(box, makeLootItem("ghost"))).toEqual([]);
    });

    it("records exactly one action when items move", () => {
      const box = new Loot("chest", []);
      const pc = makePcInRoomWith(box, { inventorySlots: 5, actionsPerRound: 99 });
      const item = makeLootItem("a");
      pc.addToInventory(item);
      pc.startTurn();
      pc.actionsPerRound = 1;
      const onTurnEnd = vi.spyOn(pc.events, "onTurnEnd");

      pc.putInLootBox(box, item);

      expect(onTurnEnd).toHaveBeenCalledTimes(1);
    });

    it("throws when the box is not co-located", () => {
      const box = new Loot("chest", []);
      const pc = new PlayerCharacter(makeCampaign(), "Hero", makeStats());

      expect(() => pc.putInLootBox(box, makeLootItem("a"))).toThrow(
        ProceduralViolation,
      );
    });
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/character/player-character.test.ts -t putInLootBox`
Expected: FAIL — `putInLootBox` does not exist.

- [ ] **Step 3: Implement `putInLootBox`**

Add to `class PlayerCharacter` (after `takeFromLootBox`):

```ts
  putInLootBox(lootBox: ILoot, item: IItem | IItem[]): IItem[] {
    this.#requireCoLocated(lootBox);
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
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/lib/character/player-character.test.ts -t putInLootBox`
Expected: PASS.

- [ ] **Step 5: Run the full gate and commit**

Run: `npm run checks`
Expected: PASS — full suite green.

```bash
git add src/lib/character/player-character.ts src/lib/character/player-character.test.ts
git commit -m "$(cat <<'EOF'
Add putInLootBox best-effort stowing

Moves held items into a co-located box up to its remaining capacity,
recording one action when at least one item moves.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**Spec coverage:**
- Operations look/take/take-many/put → Tasks 2, 3, 4 (take-many covered by the array form in Task 3). ✓
- One action per call; looking free → Task 2 (drop registration), Tasks 3/4 (single inner `addToInventory`/`removeFromInventory`). ✓
- Zero items moved → no action → guarded by `removed.length > 0` (Task 3) and `toPut.length > 0` (Task 4). ✓
- Best-effort partial moves → `slice(0, free)` in Tasks 3 and 4. ✓
- Unified `IItemHolder` on `Character` and `Loot` → Task 1. ✓
- `heldBy` is a holder, claimed via `CLAIM`, boxed items claimed at construction → Task 1. ✓
- Co-location for look/take/put → `#requireCoLocated` (Tasks 2-4). ✓
- Character-only actions guard via `holderKind` → Task 1 (`#characterHolder`). ✓
- Behavior changes (openLootBox free/readonly; pickUp stops claiming) → Tasks 1 and 2, with the matching test updates called out. ✓
- Out-of-scope `transfer` stays character-only → preserved in Task 1; the recorded deviation keeps `transfer`/`use` on `removeFromInventory`. ✓

**Placeholder scan:** No TBD/TODO. The only "placeholder" mention is the explicitly-discarded marker line in Task 1 Step 2, immediately followed by the real factory — the engineer uses the second block. All code steps contain full code.

**Type consistency:** `CLAIM`, `IItemHolder`, `ItemHolder`, `holderKind`, `hasRoomForItem`, `receiveItem`, `relinquishItem` are introduced in Task 1 and reused with identical names/signatures in Tasks 2-4. `openLootBox` return type `readonly IItem[]` matches between interface and implementation. `takeFromLootBox`/`putInLootBox` signatures match between the `IPlayerCharacter` interface (Task 2) and the implementations (Tasks 3-4).
