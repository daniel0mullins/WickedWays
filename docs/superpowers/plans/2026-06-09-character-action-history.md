# Character Action History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every recorded action a character takes (attack, move, pick up, drop, take damage) is appended to a per-character `history`, with enough context to be meaningful, plus a `describeAction` helper that renders each entry as a readable line.

**Architecture:** Thread a typed per-action context object through `Character.recordAction` — the single choke point every recorded action already passes through. It stamps the current round and appends a `ActionHistoryEntry` to a private `#history`, exposed via a read-only `history` getter. As a prerequisite, `Room` and `Item` gain a required `name` so entries read with real names.

**Tech Stack:** TypeScript, Vitest. Tests run with `npx vitest run <path>` (single file) or `npm test` (all).

**Spec:** `docs/superpowers/specs/2026-06-09-character-action-history-design.md`

---

### Task 1: Add `name` to `Item`

**Files:**
- Modify: `src/lib/inventory.ts` (the `IItem` interface, the `Item` class, its constructor)
- Modify: `src/lib/inventory.test.ts` (the `makeItem` helper + a new assertion)
- Modify: `src/integration.test.ts` (the `makeWeapon` factory)

- [ ] **Step 1: Write the failing test**

In `src/lib/inventory.test.ts`, update the `makeItem` helper (around line 71) to pass a `name`, and add a `name` assertion to the existing constructor test (around line 84, alongside the `item.type` assertion).

Change the `new Item(...)` descriptor in `makeItem`:

```ts
  const item = new Item(
    { type: "weapon", recipe: { metal: 1 }, modifier: 2, stat: StatType.Health, name: "Rusty Sword" },
    properties,
    actions,
    events,
  );
```

Add to the `"assigns an id and the provided descriptor fields"` test:

```ts
      expect(item.name).toBe("Rusty Sword");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/inventory.test.ts -t "descriptor fields"`
Expected: FAIL — TypeScript error that `name` does not exist on the descriptor / `item.name` is not a property.

- [ ] **Step 3: Add `name` to the interface, class, and constructor**

In `src/lib/inventory.ts`, add `name: string;` to the `IItem` interface (after `id`):

```ts
export interface IItem {
  id: ItemId;
  name: string;
  type: ItemType;
```

Add `name: string;` to the `Item` class field block (after `id: ItemId;`):

```ts
export class Item implements IItem {
  id: ItemId;
  name: string;
  type: ItemType;
```

Add `name` to the constructor's first destructured argument and assign it:

```ts
  constructor(
    {
      type,
      recipe,
      modifier,
      stat,
      name,
    }: {
      type: ItemType;
      recipe: Recipe;
      modifier: number;
      stat: StatType;
      name: string;
    },
    properties: ItemProperties,
    actions: ItemActions,
    events: ItemEvents,
  ) {
    this.id = uuid() as ItemId;
    this.name = name;
    this.type = type;
```

- [ ] **Step 4: Update the other `new Item(...)` site**

In `src/integration.test.ts`, the `makeWeapon` factory (around line 18) — add `name` to its descriptor:

```ts
  return new Item(
    {
      type: "weapon",
      recipe: { metal: 1 },
      modifier,
      stat: StatType.Health,
      name: "Test Weapon",
    },
```

Also check `src/lib/inventory.test.ts` line ~263 for a second `new Item(` — add `name: "Test Item"` to its descriptor too.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/lib/inventory.test.ts src/integration.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/lib/inventory.ts src/lib/inventory.test.ts src/integration.test.ts
git commit -m "Add required name field to Item"
```

---

### Task 2: Add `name` to `Room`

**Files:**
- Modify: `src/lib/room.ts` (the `IRoom` interface, the `Room` class, its constructor)
- Modify: `src/test-utils.ts` (the `ExitsArg` type — its constructor-parameter index shifts)
- Modify: `src/lib/room.test.ts` (the `makeRoom` helper + a new assertion)
- Modify: `src/lib/character/mob.test.ts`, `src/integration.test.ts`, `src/utils/build-map.test.ts` (every `new Room(...)` site)

The new constructor signature is `constructor(name, description, loot, exits)` — `name` is prepended. Every existing `new Room(X, loot, exits)` becomes `new Room(name, X, loot, exits)`, keeping the existing first string as the `description` so existing description assertions still pass.

> **Critical:** `src/test-utils.ts` defines `export type ExitsArg = ConstructorParameters<typeof Room>[2];`. Today index `2` is `exits` (params: 0=description, 1=loot, 2=exits). After prepending `name` the params become 0=name, 1=description, 2=loot, 3=exits, so `ExitsArg` must change to index `3`. If you skip this, every `{} as ExitsArg` cast in the test suite silently resolves to the loot type and the suite fails to type-check.

- [ ] **Step 1: Write the failing test**

In `src/lib/room.test.ts`, update `makeRoom` (around line 29):

```ts
  return new Room("A Dim Room", "a dim room", loot, exits as ExitsArg);
```

Update the existing `"assigns an id and the description"` test (around line 34) to also assert the name:

```ts
    expect(room.description).toBe("a dim room");
    expect(room.name).toBe("A Dim Room");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/room.test.ts -t "assigns an id"`
Expected: FAIL — `room.name` is not a property / argument count mismatch.

- [ ] **Step 3: Add `name` to the interface, class, and constructor**

In `src/lib/room.ts`, add `name: string;` to `IRoom` (after `id`):

```ts
export interface IRoom {
  id: RoomId;
  name: string;
  description: string;
```

Add `name: string;` to the `Room` class fields (after `id: RoomId;`):

```ts
export class Room implements IRoom {
  id: RoomId;
  name: string;
  description: string;
```

Update the constructor to take a leading `name` and assign it:

```ts
  constructor(
    name: string,
    description: string,
    loot: ILoot[],
    exits: Record<Direction, IRoom>,
  ) {
    this.id = generateId<RoomId>();
    this.name = name;
    this.description = description;
```

- [ ] **Step 4: Fix the `ExitsArg` type index in `src/test-utils.ts`**

```ts
export type ExitsArg = ConstructorParameters<typeof Room>[3];
```

- [ ] **Step 5: Update every other `new Room(...)` site**

Apply the rule `new Room(X, ...)` → `new Room(X, X, ...)` (name = description string) at each site below:

`src/utils/build-map.test.ts:12`:
```ts
    () => new Room("a room", "a room", [], {} as ExitsArg),
```

`src/lib/character/mob.test.ts` lines 57, 58, 71, 72, 94 — e.g.:
```ts
      const den = new Room("Den", "Den", [], {} as ExitsArg);
      const cave = new Room("Cave", "Cave", [], {} as ExitsArg);
      ...
      const sealed = new Room("Sealed", "Sealed", [], {} as ExitsArg);
```

`src/integration.test.ts` lines 52–54, 130, 153, 181 — e.g.:
```ts
      new Room("Entrance", "Entrance", [], {} as ExitsArg),
      new Room("Corridor", "Corridor", [], {} as ExitsArg),
      new Room("Vault", "Vault", [], {} as ExitsArg),
      ...
    const crypt = new Room("Crypt", "Crypt", [], {} as ExitsArg);
    ...
    const vault = new Room("Vault", "Vault", [chest], {} as ExitsArg);
    ...
    const hall = new Room("Trapped Hall", "Trapped Hall", [], {} as ExitsArg);
```

Confirm none remain: `grep -rn "new Room(" src` — every line must have two leading string args before the loot array.

- [ ] **Step 6: Run the full suite to verify it passes**

Run: `npm test`
Expected: PASS (all files)

- [ ] **Step 7: Commit**

```bash
git add src/lib/room.ts src/test-utils.ts src/lib/room.test.ts src/lib/character/mob.test.ts src/integration.test.ts src/utils/build-map.test.ts
git commit -m "Add required name field to Room"
```

---

### Task 3: Create the `history` module (types + `describeAction`)

**Files:**
- Create: `src/lib/character/history.ts`
- Create: `src/lib/character/history.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/character/history.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { describeAction, type ActionHistoryEntry } from "./history";
import { StatType } from "./stats";
import type { CharacterId } from "./character";
import type { RoomId } from "../room";
import type { ItemId } from "../inventory";

describe("describeAction", () => {
  it("describes an attack", () => {
    const entry: ActionHistoryEntry = {
      kind: "attack",
      round: 1,
      target: { id: "c1" as CharacterId, name: "Goblin" },
    };
    expect(describeAction(entry)).toBe("attacked Goblin");
  });

  it("describes a move", () => {
    const entry: ActionHistoryEntry = {
      kind: "move",
      round: 1,
      room: { id: "r1" as RoomId, name: "Library" },
    };
    expect(describeAction(entry)).toBe("moved to Library");
  });

  it("describes a pickUp", () => {
    const entry: ActionHistoryEntry = {
      kind: "pickUp",
      round: 1,
      items: [
        { id: "i1" as ItemId, name: "Sword" },
        { id: "i2" as ItemId, name: "Shield" },
      ],
    };
    expect(describeAction(entry)).toBe("picked up Sword, Shield");
  });

  it("describes a drop", () => {
    const entry: ActionHistoryEntry = {
      kind: "drop",
      round: 1,
      items: [{ id: "i1" as ItemId, name: "Sword" }],
    };
    expect(describeAction(entry)).toBe("dropped Sword");
  });

  it("describes damage taken", () => {
    const entry: ActionHistoryEntry = {
      kind: "takeDamage",
      round: 1,
      amount: 4,
      stat: StatType.Sanity,
    };
    expect(describeAction(entry)).toBe("took 4 sanity damage");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/character/history.test.ts`
Expected: FAIL — cannot find module `./history`.

- [ ] **Step 3: Implement `history.ts`**

Create `src/lib/character/history.ts`:

```ts
import type { ItemId } from "../inventory";
import type { RoomId } from "../room";
import type { CharacterId } from "./character";
import type { StatType } from "./stats";

export type ActionHistoryEntry =
  | { kind: "attack"; round: number; target: { id: CharacterId; name: string } }
  | { kind: "move"; round: number; room: { id: RoomId; name: string } }
  | { kind: "pickUp"; round: number; items: { id: ItemId; name: string }[] }
  | { kind: "drop"; round: number; items: { id: ItemId; name: string }[] }
  | { kind: "takeDamage"; round: number; amount: number; stat: StatType };

// The entry minus `round`; `round` is stamped by Character.recordAction.
type DistributiveOmit<T, K extends keyof T> = T extends unknown
  ? Omit<T, K>
  : never;
export type ActionDetail = DistributiveOmit<ActionHistoryEntry, "round">;

export function describeAction(entry: ActionHistoryEntry): string {
  switch (entry.kind) {
    case "attack":
      return `attacked ${entry.target.name}`;
    case "move":
      return `moved to ${entry.room.name}`;
    case "pickUp":
      return `picked up ${entry.items.map((i) => i.name).join(", ")}`;
    case "drop":
      return `dropped ${entry.items.map((i) => i.name).join(", ")}`;
    case "takeDamage":
      return `took ${entry.amount} ${entry.stat} damage`;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/character/history.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/character/history.ts src/lib/character/history.test.ts
git commit -m "Add action history types and describeAction helper"
```

---

### Task 4: Wire history into `Character` (`recordAction`, `#history`, `history` getter)

**Files:**
- Modify: `src/lib/character/character.ts` (interface `ICharacter`, class `Character`: add `#history`, `get history`, change `recordAction`, update 4 call sites)
- Modify: `src/lib/character/character.test.ts` (update the `makeItem`/`makeRoom` test doubles, update the two existing one-arg `recordAction` calls, add behavior tests)

This task changes the `recordAction` signature, so all of its call sites in `character.ts` must be updated in the same task to keep the build green. `Combatant.attack` is handled in Task 5 — between this task and that one the build will not compile, so do not run `npm test` (full suite) until Task 5; use the focused file run shown here.

> **Test doubles need names now.** `character.test.ts` uses fakes, not real `Item`/`Room`. After this change `move` reads `room.id`/`room.name` and inventory ops read `item.name`, so the fakes must supply them or entries record `undefined`.

- [ ] **Step 1: Update the test doubles and the existing `recordAction` tests**

In `src/lib/character/character.test.ts`, add `name` to the `makeItem` fake (around line 22) — give it a name equal to its id so assertions can round-trip:

```ts
function makeItem(id?: string): IItem {
  const itemId = (id ?? `item-${++itemCounter}`) as ItemId;
  let holder: unknown = null;
  return {
    id: itemId,
    name: itemId,
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

Give the `makeRoom` fake (around line 37) an `id` and `name`:

```ts
function makeRoom(): IRoom {
  return {
    id: "room-1" as RoomId,
    name: "Test Room",
    enterRoom: vi.fn(),
    exitRoom: vi.fn(),
  } as unknown as IRoom;
}
```

Update the two existing one-argument `recordAction` calls (around lines 405–406) to pass a detail, since `detail` is now required (the test only checks the counting branch, so any valid detail works):

```ts
      character.recordAction(function notAnAction() {}, {
        kind: "takeDamage",
        amount: 0,
        stat: StatType.Health,
      });
      character.recordAction(() => {}, {
        kind: "takeDamage",
        amount: 0,
        stat: StatType.Health,
      });
```

Add/extend imports at the top of the test file:

```ts
import type { IRoom, RoomId } from "../room";
import type { ICampaign } from "../campaign";
import type { ActionHistoryEntry } from "./history";
```

(`StatType` and `ItemId` are already imported in this file.)

- [ ] **Step 2: Write the failing behavior tests**

Add a new `describe` to `src/lib/character/character.test.ts`:

```ts
describe("action history", () => {
  it("records a move with the destination room id and name", () => {
    const character = makeCharacter();
    const room = makeRoom();
    character.move(room);
    expect(character.history).toHaveLength(1);
    expect(character.history[0]).toMatchObject({
      kind: "move",
      room: { id: room.id, name: room.name },
    });
  });

  it("records pickUp when adding to inventory and drop when removing", () => {
    const character = makeCharacter({ inventorySlots: 5 });
    const item = makeItem();
    character.addToInventory(item);
    character.removeFromInventory(item);
    expect(character.history.map((e) => e.kind)).toEqual(["pickUp", "drop"]);
    expect(character.history[0]).toMatchObject({
      kind: "pickUp",
      items: [{ id: item.id, name: item.name }],
    });
  });

  it("records takeDamage with the mitigated amount and stat", () => {
    // Sanity 5 mitigates Health: multiplier = (10 - 5) * 0.2 = 1, so 5 damage applies as 5.
    const character = makeCharacter({ stats: { [StatType.Sanity]: 5 } });
    character.takeDamage(5, StatType.Health);
    expect(character.history.at(-1)).toMatchObject({
      kind: "takeDamage",
      amount: 5,
      stat: StatType.Health,
    });
  });

  it("stamps each entry with the current campaign round", () => {
    const character = new Character(
      { round: 7 } as unknown as ICampaign,
      "Hero",
      makeStats(),
    );
    character.move(makeRoom());
    expect(character.history[0].round).toBe(7);
  });

  it("returns a read-only snapshot that cannot mutate internal state", () => {
    const character = makeCharacter();
    const room = makeRoom();
    character.move(room);
    const snapshot = character.history as ActionHistoryEntry[];
    snapshot.push({
      kind: "move",
      round: 99,
      room: { id: room.id, name: room.name },
    });
    expect(character.history).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/lib/character/character.test.ts -t "action history"`
Expected: FAIL — `character.history` is undefined / `recordAction` argument count.

- [ ] **Step 4: Add `#history`, the getter, and change `recordAction`**

In `src/lib/character/character.ts`, add the import (type-only to avoid a runtime cycle):

```ts
import type { ActionDetail, ActionHistoryEntry } from "./history";
```

Add to the `ICharacter` interface — a `history` getter and the new `recordAction` signature:

```ts
  get history(): readonly ActionHistoryEntry[];
```

and change:

```ts
  recordAction: (callingFn: ActionFn, detail: ActionDetail) => void;
```

In the `Character` class, add a private field (alongside the other `#` fields):

```ts
  #history: ActionHistoryEntry[] = [];
```

Add the getter (alongside the other public getters):

```ts
  get history(): readonly ActionHistoryEntry[] {
    return [...this.#history];
  }
```

Replace `recordAction`:

```ts
  recordAction(callingFn: ActionFn, detail: ActionDetail) {
    this.#history.push({
      ...detail,
      round: this.campaign.round,
    } as ActionHistoryEntry);

    if (this.isActionMap.get(callingFn)) {
      this.actionsThisRound = this.actionsThisRound + 1;
    }
    if (this.actionsThisRound === this.actionsPerRound) {
      this.endTurn();
    }
  }
```

- [ ] **Step 5: Update the four `recordAction` call sites in `character.ts`**

`addToInventory` (end of method):

```ts
    this.recordAction(this.addToInventory, {
      kind: "pickUp",
      items: items.map((i) => ({ id: i.id, name: i.name })),
    });
```

`removeFromInventory` (end of method):

```ts
    this.recordAction(this.removeFromInventory, {
      kind: "drop",
      items: items.map((i) => ({ id: i.id, name: i.name })),
    });
```

`takeDamage` — capture the applied amount before mutating, then record it:

```ts
  takeDamage(attackStrength: number, attackStat: StatType = StatType.Health) {
    const mitigator = this.stats[MitigatorStatType[attackStat]];
    const damageMultiplier = (MAX_STAT - mitigator) * MITIGATION_PER_POINT;
    const finalAttackStrength = attackStrength * damageMultiplier;

    this.stats[attackStat] = this.stats[attackStat] - finalAttackStrength;

    this.#resolveStatuses();
    this.recordAction(this.takeDamage, {
      kind: "takeDamage",
      amount: finalAttackStrength,
      stat: attackStat,
    });
  }
```

`move` (end of method):

```ts
    this.recordAction(this.move, {
      kind: "move",
      room: { id: room.id, name: room.name },
    });
```

- [ ] **Step 6: Run the focused tests to verify they pass**

Run: `npx vitest run src/lib/character/character.test.ts`
Expected: PASS (the `action history` describe and all pre-existing character tests).

> Do not run `npm test` yet — `Combatant.attack` still calls `recordAction` with one argument and will fail to type-check until Task 5.

- [ ] **Step 7: Commit**

```bash
git add src/lib/character/character.ts src/lib/character/character.test.ts
git commit -m "Record action history in Character.recordAction"
```

---

### Task 5: Update the remaining `recordAction` callers (`Combatant.attack` and `Mob.escape`)

After Task 4 changed `recordAction` to require a `detail`, TWO out-of-file public-API callers are left broken and must be wired here so the build type-checks again:
- `src/lib/character/combatant.ts` — `attack` calls `recordAction(this.attack)`.
- `src/lib/character/mob.ts` — `escape` calls `recordAction(this.escape)`. (This was missed in the original plan; surfaced by code review of Task 4.)

`escape` needs its own history kind. `escape()` already calls `this.move(destination)` (which records a `move` entry with the destination room), so the `escape` entry is minimal — no payload beyond `kind`/`round`.

There is no `combatant.test.ts`; `attack` is exercised in `player-character.test.ts` and `mob.test.ts`. The attack target is read from `c.id` / `c.name`, but `makeDefender` in `test-utils.ts` currently returns only `{ takeDamage }`, so it must gain an `id` and `name`.

**Files:**
- Modify: `src/lib/character/history.ts` (add the `escape` variant + `describeAction` case)
- Modify: `src/lib/character/history.test.ts` (add an `escape` describeAction test)
- Modify: `src/lib/character/combatant.ts` (the `recordAction` call in `attack`)
- Modify: `src/lib/character/mob.ts` (the `recordAction` call in `escape`)
- Modify: `src/test-utils.ts` (give `makeDefender` an `id` and `name`)
- Modify: `src/lib/character/player-character.test.ts` (add an attack history assertion)
- Modify: `src/lib/character/mob.test.ts` (add an escape history assertion)

- [ ] **Step 0a: Add the `escape` kind to `history.ts`**

In `src/lib/character/history.ts`, add a variant to `ActionHistoryEntry` (after the `drop` variant):

```ts
  | { kind: "escape"; round: number }
```

and a case to `describeAction` (before `takeDamage`):

```ts
    case "escape":
      return "escaped";
```

- [ ] **Step 0b: Add an `escape` describeAction test**

In `src/lib/character/history.test.ts`, add:

```ts
  it("describes an escape", () => {
    const entry: ActionHistoryEntry = { kind: "escape", round: 1 };
    expect(describeAction(entry)).toBe("escaped");
  });
```

- [ ] **Step 0c: Wire the `escape` call site**

In `src/lib/character/mob.ts`, change the final line of `escape`:

```ts
    this.recordAction(this.escape, { kind: "escape" });
```

In `src/lib/character/mob.test.ts`, add (inside a suitable describe, using the file's existing `makeMob` helper — a mob in a room with an exit so `escape` flees):

```ts
it("records an escape in history", () => {
  const den = new Room("Den", "Den", {} as ExitsArg /* see existing escape tests for setup */);
  // Reuse the file's existing escape-test setup verbatim; after escape(), assert:
  // expect(mob.history.some((e) => e.kind === "escape")).toBe(true);
});
```

> For the escape test, COPY the setup from the file's existing `describe("escape", ...)` test that successfully calls `mob.escape()` (it already builds a mob in a room wired with an exit). Then assert `expect(mob.history.some((e) => e.kind === "escape")).toBe(true);`. Do not invent new room wiring — reuse what already drives `escape()` in that file.

- [ ] **Step 1: Give `makeDefender` an id and name**

In `src/test-utils.ts`:

```ts
export function makeDefender(): ICharacter {
  return { id: "defender-1", name: "Goblin", takeDamage: vi.fn() } as unknown as ICharacter;
}
```

- [ ] **Step 2: Write the failing test**

In `src/lib/character/player-character.test.ts`, inside the existing `describe("attack", ...)` block, add (it uses the file's existing `makePc` and the imported `makeDefender`):

```ts
it("records the attack target in the attacker's history", () => {
  const pc = makePc();
  const defender = makeDefender();
  pc.attack(defender);
  expect(pc.history.at(-1)).toMatchObject({
    kind: "attack",
    target: { id: defender.id, name: defender.name },
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/lib/character/player-character.test.ts -t "records the attack target"`
Expected: FAIL — the build error from the one-argument `recordAction` call, or a missing history entry.

- [ ] **Step 4: Update the `recordAction` call in `attack`**

In `src/lib/character/combatant.ts`, change the final line of `attack`:

```ts
    this.recordAction(this.attack, {
      kind: "attack",
      target: { id: c.id, name: c.name },
    });
```

- [ ] **Step 5: Run the full suite to verify everything passes**

Run: `npm test`
Expected: PASS (all files — the build now type-checks end to end).

- [ ] **Step 6: Commit**

```bash
git add src/lib/character/history.ts src/lib/character/history.test.ts src/lib/character/combatant.ts src/lib/character/mob.ts src/test-utils.ts src/lib/character/player-character.test.ts src/lib/character/mob.test.ts
git commit -m "Record attack and escape in action history"
```

---

### Task 6: Verify loot-box take/put produce single history entries

**Files:**
- Modify: `src/lib/character/player-character.test.ts` (add assertions; no production change expected)

`takeFromLootBox` / `putInLootBox` reuse `addToInventory` / `removeFromInventory`, so they should already record exactly one `pickUp` / `drop`. This task locks that behavior with a test. The only production-adjacent change is giving the `makeLootItem` test fake a `name` (so the recorded `pickUp` carries a real name).

- [ ] **Step 1: Add `name` to the `makeLootItem` fake**

In `src/lib/character/player-character.test.ts`, the `makeLootItem` helper (around line 48) currently sets only `id`. Add a `name`:

```ts
function makeLootItem(id: string): IItem {
  let holder: unknown = null;
  return {
    id: id as ItemId,
    name: id,
    actions: { pickUp: vi.fn() },
    [CLAIM]: (h: unknown) => {
      holder = h;
    },
    get [HELD_BY]() {
      return holder;
    },
  } as unknown as IItem;
}
```

- [ ] **Step 2: Write the test**

Add a new `describe` to `src/lib/character/player-character.test.ts`, reusing `new Loot("chest", [...])`, `makeLootItem`, and `makePcInRoomWith` (the patterns already used in the existing loot tests):

```ts
describe("loot box history", () => {
  it("records a single pickUp when taking from a loot box", () => {
    const target = makeLootItem("a");
    const box = new Loot("chest", [target]);
    const pc = makePcInRoomWith(box);
    pc.takeFromLootBox(box, target);
    const pickUps = pc.history.filter((e) => e.kind === "pickUp");
    expect(pickUps).toHaveLength(1);
    expect(pickUps[0]).toMatchObject({ items: [{ id: target.id, name: target.name }] });
  });

  it("records a single drop when putting into a loot box", () => {
    const target = makeLootItem("a");
    const box = new Loot("chest", []);
    const pc = makePcInRoomWith(box, { inventorySlots: 5 });
    pc.addToInventory(target);
    const before = pc.history.length;
    pc.putInLootBox(box, target);
    const drops = pc.history.slice(before).filter((e) => e.kind === "drop");
    expect(drops).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run the tests**

Run: `npx vitest run src/lib/character/player-character.test.ts -t "loot box history"`
Expected: PASS. If it fails with more than one `pickUp`/`drop`, investigate the loot-box reuse path before changing anything.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/character/player-character.test.ts
git commit -m "Verify loot-box actions record single history entries"
```

---

## Final verification

- [ ] Run `npm test` — all pass.
- [ ] Run the type-checker / build if separate from tests (e.g. `npx tsc --noEmit` if configured) — no errors.
- [ ] `grep -rn "new Room(" src` and `grep -rn "new Item(" src` — confirm every site supplies the new `name` argument.
