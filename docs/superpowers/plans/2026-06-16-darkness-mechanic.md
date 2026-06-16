# Darkness Mechanic Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add darkness as an exploration/concealment mechanic — dark rooms conceal their contents until lit, block looting/harvesting/attacking while unlit, and host light-averse mobs that see in the dark but take amplified damage when lit.

**Architecture:** Darkness is an author-time `Room.dark` flag; the live `Room.isLit` getter is derived from a room-scoped `lightSources` collection plus any occupant carrying an equipped light. A shared, protected targeting gate on `Character` throws `ProceduralViolation` when an actor without `seesInDark` tries to attack/loot/harvest in an unlit room. Movement and light-management actions are never gated. Light vulnerability is a deterministic multiplier in `takeDamage`. All protected state (room light sources, item ownership) is mutated only through `Symbol` seams, matching the existing `inventory.ts` convention.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`, `NodeNext`), Vitest (co-located `*.test.ts`), no new runtime deps. No new randomness — everything here is deterministic.

**Spec:** `docs/superpowers/specs/2026-06-15-darkness-mechanic-design.md`

---

## File Structure

Files created or modified, and each one's responsibility:

- **`src/lib/inventory.ts`** (modify) — add `emitsLight?: boolean` to `IItem`/`Item`; add the two new room-light symbol seams `ADD_LIGHT_SOURCE` / `REMOVE_LIGHT_SOURCE` (centralized here per the existing seam convention).
- **`src/lib/room.ts`** (modify) — `dark` flag + getter; `lightSources` collection with symbol-gated mutation + read-only getter; `isLit` getter.
- **`src/lib/character/character.ts`** (modify) — `hasLight` getter; `seesInDark` getter (default `false`); `lightAverse` getter (default `false`); `placeLight`/`takeLight` free actions; the protected `requireVisibleTarget` gate; harvest gate; `takeDamage` light-vulnerability multiplier + `LIGHT_VULNERABILITY` constant; visibility cue on room enter and on light-state flips.
- **`src/lib/character/combatant.ts`** (modify) — attack targeting gate.
- **`src/lib/character/player-character.ts`** (modify) — loot-take targeting gate.
- **`src/lib/character/mob.ts`** (modify) — `lightAverse` option → `seesInDark` + `lightAverse` overrides.
- **`src/lib/presentation.ts`** (modify) — `visibility` cue variant.
- **`src/test-utils.ts`** (modify) — none required; tests use existing `makeGear`-style local factories (Task 1 extends the per-file `makeGear`).
- **`README.md`** (modify) — document the mechanic.
- Co-located `*.test.ts` for each modified source file, plus `src/integration.test.ts`.

**Shared identifiers (use these exact names across all tasks):**

| Identifier | Where | Signature |
|---|---|---|
| `emitsLight` | `IItem`/`Item` | `readonly emitsLight?: boolean` |
| `ADD_LIGHT_SOURCE` | `inventory.ts` | `Symbol("addLightSource")` |
| `REMOVE_LIGHT_SOURCE` | `inventory.ts` | `Symbol("removeLightSource")` |
| `Room.dark` | `room.ts` | `get dark(): boolean` |
| `Room.lightSources` | `room.ts` | `get lightSources(): ReadonlyMap<ItemId, IItem>` |
| `Room[ADD_LIGHT_SOURCE]` | `room.ts` | `(item: IItem): void` |
| `Room[REMOVE_LIGHT_SOURCE]` | `room.ts` | `(id: ItemId): void` |
| `Room.isLit` | `room.ts` | `get isLit(): boolean` |
| `Character.hasLight` | `character.ts` | `get hasLight(): boolean` |
| `Character.seesInDark` | `character.ts` | `get seesInDark(): boolean` (default `false`) |
| `Character.lightAverse` | `character.ts` | `protected get lightAverse(): boolean` (default `false`) |
| `Character.placeLight` | `character.ts` | `placeLight(item: IItem): void` (free) |
| `Character.takeLight` | `character.ts` | `takeLight(item: IItem): void` (free) |
| `Character.requireVisibleTarget` | `character.ts` | `protected requireVisibleTarget(verb: string): void` |
| `LIGHT_VULNERABILITY` | `character.ts` | `const LIGHT_VULNERABILITY = 1.5` |
| visibility cue | `presentation.ts` | `{ kind: "visibility"; room: EntityRef; lit: boolean }` |

**Run after every task:** `npm run checks` (lint + typecheck + test). Commit only when green.

---

### Task 1: `emitsLight` flag on items

**Files:**
- Modify: `src/lib/inventory.ts` (`IItem` interface ~line 236, `Item` field ~line 278, constructor descriptor ~lines 381/397/418)
- Modify: `src/lib/character/character.test.ts` (extend local `makeGear` factory ~line 104, add a test)
- Test: `src/lib/inventory.test.ts`

- [ ] **Step 1: Write the failing test**

In `src/lib/inventory.test.ts`, add inside the existing top-level `describe` (mirror the existing `makeDurable`/`new Item(...)` construction style already used in that file):

```ts
it("exposes emitsLight when set, and leaves it undefined otherwise", () => {
  const noop = () => {};
  const torch = new Item(
    {
      type: "weapon",
      recipe: { item: 1 },
      modifier: 0,
      stat: StatType.Health,
      name: "Torch",
      slot: SlotKind.Hand,
      emitsLight: true,
    },
    { equippable: true, equipped: false, destroyable: true, usable: false },
    { pickUp: noop, equip: noop, unequip: noop, transfer: noop, use: noop, destroy: () => null },
    { onPickUp: noop },
  );
  const rock = new Item(
    { type: "weapon", recipe: { item: 1 }, modifier: 0, stat: StatType.Health, name: "Rock" },
    { equippable: false, equipped: false, destroyable: true, usable: false },
    { pickUp: noop, equip: noop, unequip: noop, transfer: noop, use: noop, destroy: () => null },
    { onPickUp: noop },
  );

  expect(torch.emitsLight).toBe(true);
  expect(rock.emitsLight).toBeUndefined();
});
```

Ensure `SlotKind` is imported in the test (`import { SlotKind } from "./equipment";` — check the existing import block and add if missing).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/inventory.test.ts -t "emitsLight"`
Expected: FAIL — `emitsLight` does not exist on the `Item` constructor descriptor (TS error) / `torch.emitsLight` is `undefined`.

- [ ] **Step 3: Implement `emitsLight`**

In `src/lib/inventory.ts`, four edits mirroring `twoHanded`:

1. In the `IItem` interface, after `readonly twoHanded?: boolean;` (~line 236):
```ts
  /** Light sources only: when active (carried or placed) this item lights its room. */
  readonly emitsLight?: boolean;
```
2. In the `Item` class field block, after `readonly twoHanded?: boolean;` (~line 278):
```ts
  readonly emitsLight?: boolean;
```
3. In the constructor destructure, after `twoHanded,` (~line 381):
```ts
      emitsLight,
```
   and in the descriptor type, after `twoHanded?: boolean;` (~line 397):
```ts
      emitsLight?: boolean;
```
4. In the constructor body, after `this.twoHanded = twoHanded;` (~line 418):
```ts
    this.emitsLight = emitsLight;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/inventory.test.ts -t "emitsLight"`
Expected: PASS

- [ ] **Step 5: Extend the `makeGear` test factory for later tasks**

In `src/lib/character/character.test.ts`, extend the local `makeGear` (~line 104) so later tasks can build light sources. Add `emitsLight?: boolean` and `maxDurability?: number` to its `opts` type and thread them into the descriptor:

```ts
function makeGear(opts: {
  type?: ItemDescriptor["type"];
  name?: string;
  slot?: ItemDescriptor["slot"];
  twoHanded?: boolean;
  stat?: StatType;
  modifier?: number;
  equippable?: boolean;
  usable?: boolean;
  immunities?: Status[];
  grantsImmunity?: { statuses: Status[]; turns: number };
  emitsLight?: boolean;
  maxDurability?: number;
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
      emitsLight: opts.emitsLight,
      maxDurability: opts.maxDurability,
    },
    { equippable: opts.equippable ?? true, equipped: false, destroyable: true, usable: opts.usable ?? false },
    { pickUp: noop, equip: noop, unequip: noop, transfer: noop, use: noop, destroy: () => null },
    { onPickUp: noop },
  );
}
```

- [ ] **Step 6: Run checks and commit**

```bash
npm run checks
git add src/lib/inventory.ts src/lib/inventory.test.ts src/lib/character/character.test.ts
git commit -m "feat: add emitsLight flag to items"
```

---

### Task 2: Room `dark` flag

**Files:**
- Modify: `src/lib/room.ts` (constructor ~lines 109–146, fields ~lines 72–81)
- Test: `src/lib/room.test.ts`

**Decision:** The `Room` constructor is positional. Add `dark` as a new trailing optional parameter after `presentation` (keeps all existing call sites valid). Authored `lightSources` is added in Task 3 as the next trailing parameter.

- [ ] **Step 1: Write the failing test**

In `src/lib/room.test.ts`, the local `makeRoom` helper (~line 31) is `new Room("A Dim Room", "a dim room", loot, exits as ExitsArg)`. Add a second helper and tests inside the `Room` describe:

```ts
function makeDarkRoom(): Room {
  return new Room(
    "Cellar",
    "a pitch-black cellar",
    [],
    {} as ExitsArg,
    [],          // materials
    1,           // spawnModifier
    [],          // mobs
    undefined,   // presentation
    true,        // dark
  );
}

describe("dark", () => {
  it("defaults to false", () => {
    expect(makeRoom().dark).toBe(false);
  });

  it("is true when authored dark", () => {
    expect(makeDarkRoom().dark).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/room.test.ts -t "dark"`
Expected: FAIL — `dark` argument not accepted / `room.dark` undefined.

- [ ] **Step 3: Implement the `dark` flag**

In `src/lib/room.ts`:

1. Add a private field in the field block (~line 81):
```ts
  #dark: boolean;
```
2. Add the constructor parameter after `presentation?: Presentation,` (~line 145):
```ts
    dark: boolean = false,
```
3. In the constructor body, assign it (near where `#presentation` is set):
```ts
    this.#dark = dark;
```
4. Add the getter (near the `occupants` getter, ~line 83):
```ts
  /** Author-time darkness flag. A dark room conceals its contents until lit. Fixed at authoring. */
  get dark(): boolean {
    return this.#dark;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/room.test.ts -t "dark"`
Expected: PASS

- [ ] **Step 5: Run checks and commit**

```bash
npm run checks
git add src/lib/room.ts src/lib/room.test.ts
git commit -m "feat: add author-time dark flag to Room"
```

---

### Task 3: Room `lightSources` collection + symbol seams

**Files:**
- Modify: `src/lib/inventory.ts` (new symbols, near `PLACE`/`SET_ORIGIN` ~line 203)
- Modify: `src/lib/room.ts` (field, getter, constructor param, two symbol-keyed methods)
- Test: `src/lib/room.test.ts`

- [ ] **Step 1: Write the failing test**

In `src/lib/room.test.ts` add (import the new symbols and a light-source item builder; build the item with `new Item(...)` in the same style as Task 1, or import a shared helper):

```ts
import { ADD_LIGHT_SOURCE, REMOVE_LIGHT_SOURCE, Item } from "../lib/inventory"; // adjust path to match this test's existing imports

function makeLight(): Item {
  const noop = () => {};
  return new Item(
    { type: "weapon", recipe: { item: 1 }, modifier: 0, stat: StatType.Health, name: "Candle", slot: SlotKind.Hand, emitsLight: true },
    { equippable: true, equipped: false, destroyable: true, usable: false },
    { pickUp: noop, equip: noop, unequip: noop, transfer: noop, use: noop, destroy: () => null },
    { onPickUp: noop },
  );
}

describe("lightSources", () => {
  it("can be authored with light sources present", () => {
    const candle = makeLight();
    const room = new Room("Hall", "a hall", [], {} as ExitsArg, [], 1, [], undefined, true, [candle]);
    expect(room.lightSources.get(candle.id)).toBe(candle);
  });

  it("is mutated only through the symbol seams", () => {
    const room = makeRoom();
    const candle = makeLight();
    room[ADD_LIGHT_SOURCE](candle);
    expect(room.lightSources.get(candle.id)).toBe(candle);
    room[REMOVE_LIGHT_SOURCE](candle.id);
    expect(room.lightSources.has(candle.id)).toBe(false);
  });

  it("does not expose a public setter for lightSources", () => {
    const room = makeRoom();
    // @ts-expect-error lightSources is read-only
    room.lightSources = new Map();
  });
});
```

(Add `StatType`, `SlotKind`, `Item` imports to the test file if not already present.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/room.test.ts -t "lightSources"`
Expected: FAIL — symbols / getter / authored param don't exist.

- [ ] **Step 3: Add the symbol seams**

In `src/lib/inventory.ts`, after the `SET_ORIGIN` symbol (~line 203):

```ts
/**
 * Symbol-keyed method that adds a light source to a room's `lightSources`.
 * Only {@link Character.placeLight} and room authoring call it.
 */
export const ADD_LIGHT_SOURCE = Symbol("addLightSource");

/**
 * Symbol-keyed method that removes a light source from a room's `lightSources`.
 * Only {@link Character.takeLight} calls it.
 */
export const REMOVE_LIGHT_SOURCE = Symbol("removeLightSource");
```

- [ ] **Step 4: Implement the collection on `Room`**

In `src/lib/room.ts`:

1. Import the symbols (extend the existing `./inventory` import — note `SET_ORIGIN`/`PLACE` are already imported there):
```ts
import { ADD_LIGHT_SOURCE, REMOVE_LIGHT_SOURCE, IItem, ItemId, /* ...existing... */ } from "./inventory";
```
2. Add a private field (~line 81):
```ts
  #lightSources: Map<ItemId, IItem>;
```
3. Add the constructor parameter after `dark` (~line 146):
```ts
    lightSources: IItem[] = [],
```
4. In the constructor body, build the map (next to the `loot`/`materials` map construction):
```ts
    this.#lightSources = new Map<ItemId, IItem>();
    for (const light of lightSources) {
      this.#lightSources.set(light.id, light);
    }
```
5. Add the read-only getter and the two symbol-keyed mutators (near the `dark` getter):
```ts
  /** Active placed light sources resident in this room, keyed by item id. Read-only. */
  get lightSources(): ReadonlyMap<ItemId, IItem> {
    return this.#lightSources;
  }

  [ADD_LIGHT_SOURCE](item: IItem) {
    this.#lightSources.set(item.id, item);
  }

  [REMOVE_LIGHT_SOURCE](id: ItemId) {
    this.#lightSources.delete(id);
  }
```
6. If `IRoom` is declared in this file (it is — `room.ts` defines the interface), add to it:
```ts
  get lightSources(): ReadonlyMap<ItemId, IItem>;
  [ADD_LIGHT_SOURCE](item: IItem): void;
  [REMOVE_LIGHT_SOURCE](id: ItemId): void;
  get dark(): boolean;   // if not already added in Task 2's IRoom edit
```

> Note: in Task 2, also add `get dark(): boolean;` to the `IRoom` interface if the typecheck flags it. Add interface members as the compiler requires them.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/lib/room.test.ts -t "lightSources"`
Expected: PASS

- [ ] **Step 6: Run checks and commit**

```bash
npm run checks
git add src/lib/inventory.ts src/lib/room.ts src/lib/room.test.ts
git commit -m "feat: add symbol-gated lightSources collection to Room"
```

---

### Task 4: `Character.hasLight`

**Files:**
- Modify: `src/lib/character/character.ts` (add getter near `currentRoom` getter ~line 195; import `EquipmentSlot` from `../equipment` if not present)
- Test: `src/lib/character/character.test.ts`

- [ ] **Step 1: Write the failing test**

In `src/lib/character/character.test.ts`, using `makeCharacter` and the extended `makeGear`:

```ts
describe("hasLight", () => {
  it("is false with nothing equipped", () => {
    expect(makeCharacter().hasLight).toBe(false);
  });

  it("is true with an equipped, non-broken light in a hand", () => {
    const hero = makeCharacter();
    const torch = makeGear({ name: "Torch", slot: SlotKind.Hand, emitsLight: true });
    hero.addToInventory(torch);
    hero.equip(torch, EquipmentSlot.LeftHand);
    expect(hero.hasLight).toBe(true);
  });

  it("is false when the only light is broken", () => {
    const hero = makeCharacter();
    const torch = makeGear({ name: "Torch", slot: SlotKind.Hand, emitsLight: true, maxDurability: 1 });
    hero.addToInventory(torch);
    hero.equip(torch, EquipmentSlot.LeftHand);
    torch[SET_DURABILITY](0);
    expect(hero.hasLight).toBe(false);
  });
});
```

Ensure `EquipmentSlot`, `SlotKind`, `SET_DURABILITY` are imported in the test.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/character/character.test.ts -t "hasLight"`
Expected: FAIL — `hasLight` does not exist.

- [ ] **Step 3: Implement `hasLight`**

In `src/lib/character/character.ts`, add near the `currentRoom` getter (~line 197). The `equipment` getter (`ReadonlyMap<EquipmentSlot, IItem>`) already exists:

```ts
  /** True when the character has an equipped, non-broken light source in a hand slot. */
  get hasLight(): boolean {
    for (const slot of [EquipmentSlot.LeftHand, EquipmentSlot.RightHand]) {
      const item = this.equipment.get(slot);
      if (item?.emitsLight && !item.isBroken) return true;
    }
    return false;
  }
```

Add to the `ICharacter` interface (in `character.ts`): `get hasLight(): boolean;`. Import `EquipmentSlot` from `../equipment` if not already imported.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/character/character.test.ts -t "hasLight"`
Expected: PASS

- [ ] **Step 5: Run checks and commit**

```bash
npm run checks
git add src/lib/character/character.ts src/lib/character/character.test.ts
git commit -m "feat: add Character.hasLight getter"
```

---

### Task 5: Room `isLit` getter

**Files:**
- Modify: `src/lib/room.ts` (add `isLit` getter near `dark`)
- Test: `src/lib/room.test.ts`

`isLit`:
- A non-`dark` room is always lit.
- A `dark` room is lit iff any non-broken item is in `lightSources`, **or** any occupant `hasLight`.

- [ ] **Step 1: Write the failing test**

In `src/lib/room.test.ts`:

```ts
describe("isLit", () => {
  it("a non-dark room is always lit, even with nothing", () => {
    expect(makeRoom().isLit).toBe(true);
  });

  it("a dark room with nothing is unlit", () => {
    expect(makeDarkRoom().isLit).toBe(false);
  });

  it("a dark room lit by a placed light source is lit", () => {
    const room = makeDarkRoom();
    const candle = makeLight();
    room[ADD_LIGHT_SOURCE](candle);
    expect(room.isLit).toBe(true);
  });

  it("a dark room is not lit by a broken placed light source", () => {
    const room = makeDarkRoom();
    const candle = makeLight();   // build with maxDurability so it can break
    // Use a durable light: makeLight() variant with maxDurability: 1, then SET_DURABILITY(0)
    // (build inline with new Item({ ...emitsLight: true, maxDurability: 1 }) and break it)
    // See note below for the exact construction.
    expect(room.isLit).toBe(false); // replaced by the broken-light assertion below
  });

  it("a dark room is lit by an occupant carrying an equipped light", () => {
    const room = makeDarkRoom();
    const hero = makeLitHero();   // a Character with an equipped emitsLight item; see note
    room.enterRoom(hero);
    expect(room.isLit).toBe(true);
  });

  it("goes dark again when the carried light's holder leaves", () => {
    const room = makeDarkRoom();
    const hero = makeLitHero();
    room.enterRoom(hero);
    room.exitRoom(hero);
    expect(room.isLit).toBe(false);
  });
});
```

**Construction notes for this test** (keep the test self-contained — `room.test.ts` currently builds lightweight rooms; for the occupant cases it needs a real `Character`):
- For the broken-placed-light case, build the light with durability: replace `makeLight()` with a local `makeBrokenLight()` that does `new Item({ ..., emitsLight: true, maxDurability: 1 }, ...)`, then `light[SET_DURABILITY](0)` before adding.
- For occupant cases, add a `makeLitHero()` helper that constructs a `Character` (import `Character`, `makeCampaign`, `makeStats`), gives it a hand-slot `emitsLight` item, and equips it — mirror the `makeGear`/`equip` pattern from `character.test.ts`. Co-locate these helpers at the top of the `isLit` describe.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/room.test.ts -t "isLit"`
Expected: FAIL — `isLit` does not exist.

- [ ] **Step 3: Implement `isLit`**

In `src/lib/room.ts`, add near the `dark` getter:

```ts
  /**
   * Whether the room is currently lit. A non-dark room is always lit. A dark room
   * is lit iff it holds a non-broken placed light source, or an occupant carries
   * an equipped, non-broken light.
   */
  get isLit(): boolean {
    if (!this.#dark) return true;
    for (const light of this.#lightSources.values()) {
      if (!light.isBroken) return true;
    }
    return this.occupants.some((occupant) => occupant.hasLight);
  }
```

Add `get isLit(): boolean;` to the `IRoom` interface.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/room.test.ts -t "isLit"`
Expected: PASS

- [ ] **Step 5: Run checks and commit**

```bash
npm run checks
git add src/lib/room.ts src/lib/room.test.ts
git commit -m "feat: add Room.isLit derived getter"
```

---

### Task 6: `placeLight` / `takeLight` (free actions)

**Files:**
- Modify: `src/lib/character/character.ts` (two new methods near `harvest` ~line 692; uses `receiveItem`/`relinquishItem` primitives ~lines 340/352, `CLAIM`, `ADD_LIGHT_SOURCE`/`REMOVE_LIGHT_SOURCE`)
- Test: `src/lib/character/character.test.ts`

These are **free** actions — do **not** call `attemptAction`/`recordAction`, so they never tick the budget (matching `equip`/`unequip` which are free, and unlike the budgeted `addToInventory`/`removeFromInventory`). Use the low-level holder primitives:
- `placeLight`: `this.relinquishItem(item)` (removes from inventory, holder untouched), then `currentRoom[ADD_LIGHT_SOURCE](item)`, then `item[CLAIM](null)` (a `Room` is not a valid `ItemHolder` — `ItemHolder = ICharacter | ILoot`).
- `takeLight`: `currentRoom[REMOVE_LIGHT_SOURCE](item.id)`, then `this.receiveItem(item)` (pushes to inventory and calls `item[CLAIM](this)`).

- [ ] **Step 1: Write the failing test**

```ts
describe("placeLight / takeLight", () => {
  it("placeLight moves a held light into the room", () => {
    const hero = makeCharacter();
    const room = makeRealDarkRoom();   // a real Room authored dark; see note
    room.enterRoom(hero);
    (hero as unknown as { setRoom: (r: IRoom) => void }); // hero must be co-located; see note
    const torch = makeGear({ name: "Torch", slot: SlotKind.Hand, emitsLight: true });
    hero.addToInventory(torch);

    hero.placeLight(torch);

    expect(room.lightSources.get(torch.id)).toBe(torch);
    expect(hero.inventory.items.some((i) => i.id === torch.id)).toBe(false);
    expect(room.isLit).toBe(true);
  });

  it("takeLight moves a placed light back into inventory and re-darkens", () => {
    const hero = makeCharacter();
    const room = makeRealDarkRoom();
    room.enterRoom(hero);
    const torch = makeGear({ name: "Torch", slot: SlotKind.Hand, emitsLight: true });
    hero.addToInventory(torch);
    hero.placeLight(torch);

    hero.takeLight(torch);

    expect(room.lightSources.has(torch.id)).toBe(false);
    expect(hero.inventory.items.some((i) => i.id === torch.id)).toBe(true);
    expect(room.isLit).toBe(false);
  });

  it("placeLight throws for a non-light item", () => {
    const hero = makeCharacter();
    const room = makeRealDarkRoom();
    room.enterRoom(hero);
    const rock = makeGear({ name: "Rock", emitsLight: false });
    hero.addToInventory(rock);
    expect(() => hero.placeLight(rock)).toThrow(ProceduralViolation);
  });

  it("placeLight throws when the character holds no such item", () => {
    const hero = makeCharacter();
    const room = makeRealDarkRoom();
    room.enterRoom(hero);
    const torch = makeGear({ name: "Torch", slot: SlotKind.Hand, emitsLight: true });
    expect(() => hero.placeLight(torch)).toThrow(ProceduralViolation);
  });

  it("takeLight throws when the light is not in the room", () => {
    const hero = makeCharacter();
    const room = makeRealDarkRoom();
    room.enterRoom(hero);
    const torch = makeGear({ name: "Torch", slot: SlotKind.Hand, emitsLight: true });
    expect(() => hero.takeLight(torch)).toThrow(ProceduralViolation);
  });

  it("placeLight is a free action (no budget tick)", () => {
    const hero = makeCharacter({ actionsPerRound: 1 });
    const room = makeRealDarkRoom();
    room.enterRoom(hero);
    const torch = makeGear({ name: "Torch", slot: SlotKind.Hand, emitsLight: true });
    hero.addToInventory(torch);
    hero.placeLight(torch);
    hero.takeLight(torch);
    // Budget untouched: a budgeted action still succeeds afterwards.
    expect(() => hero.placeLight(torch)).not.toThrow();
  });
});
```

**Construction note:** `makeCharacter` builds a `Character` but does not place it in a room; `currentRoom` is set via the `PLACE` seam / room entry path. Add a `makeRealDarkRoom()` helper that returns a real `Room` (authored `dark: true`) and ensure the hero's `currentRoom` points at it. The cleanest co-location: call `room.enterRoom(hero)` **and** set the hero's room through the existing room-entry path used elsewhere in `character.test.ts` (search the test file for how other tests set `currentRoom` — e.g. a `placeInRoom`/`PLACE` helper — and reuse it). `placeLight`/`takeLight` read `this.currentRoom`, so the hero must have `currentRoom === room`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/character/character.test.ts -t "placeLight"`
Expected: FAIL — methods don't exist.

- [ ] **Step 3: Implement `placeLight` / `takeLight`**

In `src/lib/character/character.ts`, add near `harvest` (~line 692). Capture lit-state for the visibility cue (Task 9 wires the cue; here just leave the mutation correct — the cue emission is added in Task 9):

```ts
  /**
   * Moves an emitsLight item the character holds into the current room's light
   * sources, where it stays lit regardless of occupancy. Free action (no budget tick).
   *
   * @throws {@link ProceduralViolation} if the item is not an emitsLight item the
   *   character holds, or the character is not in a room.
   */
  placeLight(item: IItem) {
    const room = this.#currentRoom;
    if (!room) {
      throw new ProceduralViolation("Cannot place a light while not in a room");
    }
    if (!item.emitsLight) {
      throw new ProceduralViolation("Cannot place a non-light item as a light source");
    }
    if (!this.#inventory.items.some((i) => i.id === item.id)) {
      throw new ProceduralViolation("Cannot place a light the character does not hold");
    }
    this.relinquishItem(item);
    room[ADD_LIGHT_SOURCE](item);
    item[CLAIM](null);
  }

  /**
   * Moves a placed light source from the current room back into the character's
   * inventory. Free action (no budget tick).
   *
   * @throws {@link ProceduralViolation} if the item is not in the room's light sources.
   */
  takeLight(item: IItem) {
    const room = this.#currentRoom;
    if (!room || !room.lightSources.has(item.id)) {
      throw new ProceduralViolation("Cannot take a light that is not in the room");
    }
    room[REMOVE_LIGHT_SOURCE](item.id);
    this.receiveItem(item);
  }
```

Add `placeLight(item: IItem): void;` and `takeLight(item: IItem): void;` to the `ICharacter` interface. Import `ADD_LIGHT_SOURCE`, `REMOVE_LIGHT_SOURCE`, `CLAIM` from `../inventory` (CLAIM is likely already imported).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/character/character.test.ts -t "placeLight"`
Expected: PASS

- [ ] **Step 5: Run checks and commit**

```bash
npm run checks
git add src/lib/character/character.ts src/lib/character/character.test.ts
git commit -m "feat: add free placeLight/takeLight actions"
```

---

### Task 7: `seesInDark` + the targeting gate (attack / loot / harvest)

**Files:**
- Modify: `src/lib/character/character.ts` (`seesInDark` getter, `requireVisibleTarget` gate, harvest gate)
- Modify: `src/lib/character/combatant.ts` (attack gate ~line 40)
- Modify: `src/lib/character/player-character.ts` (loot-take gate ~line 159)
- Test: `src/lib/character/combatant.test.ts`, `character.test.ts`, `player-character.test.ts`

The gate rule: in a room where `isLit` is `false`, an actor may not attack/loot/harvest unless `seesInDark` is `true`. Movement and light actions are never gated.

- [ ] **Step 1: Write the failing tests**

In `src/lib/character/combatant.test.ts` (uses real `Combatant`/`Mob`; mirror existing attack tests):

```ts
describe("darkness targeting gate", () => {
  it("attack throws in an unlit room for an actor without seesInDark", () => {
    const { attacker, defender, room } = makeDarkCombat(); // helper: both in an authored dark room, no light
    expect(room.isLit).toBe(false);
    expect(() => attacker.attack(defender)).toThrow(ProceduralViolation);
  });

  it("a seesInDark mob may attack in the dark", () => {
    const { attacker, defender } = makeDarkCombat({ attackerSeesInDark: true });
    expect(() => attacker.attack(defender)).not.toThrow();
  });

  it("once the room is lit, attack is allowed", () => {
    const { attacker, defender, room, candle } = makeDarkCombat();
    room[ADD_LIGHT_SOURCE](candle);
    expect(() => attacker.attack(defender)).not.toThrow();
  });

  it("movement and light actions are never gated by darkness", () => {
    const { attacker, room } = makeDarkCombat();
    const torch = makeGear({ name: "Torch", slot: SlotKind.Hand, emitsLight: true });
    attacker.addToInventory(torch);
    expect(() => attacker.placeLight(torch)).not.toThrow();
    expect(room.isLit).toBe(true);
  });
});
```

In `character.test.ts`, a harvest-gate test:

```ts
it("harvest throws in an unlit room without seesInDark", () => {
  const { hero, room, cache } = makeDarkHarvest(); // hero co-located in a dark room with a material cache
  expect(() => hero.harvest(cache)).toThrow(ProceduralViolation);
});
```

In `player-character.test.ts`, a loot-gate test:

```ts
it("takeFromLootBox throws in an unlit room without seesInDark", () => {
  const { player, lootBox, item } = makeDarkLoot(); // player co-located in a dark room with a loot box
  expect(() => player.takeFromLootBox(lootBox, item)).toThrow(ProceduralViolation);
});
```

Add the `makeDarkCombat` / `makeDarkHarvest` / `makeDarkLoot` helpers at the top of each test file, building a real authored-dark `Room`, placing the actor(s) in it (reuse each file's existing room-placement pattern), and (for `makeDarkCombat`) exposing a pre-built `candle` light item.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/character/combatant.test.ts -t "darkness targeting" && npx vitest run -t "unlit room"`
Expected: FAIL — gate not implemented; attacks/harvest/loot currently succeed in the dark.

- [ ] **Step 3: Implement `seesInDark` + the gate on `Character`**

In `src/lib/character/character.ts`, add near `hasLight`:

```ts
  /** Whether this actor can act (attack/loot/harvest) in an unlit room. Default false; light-averse mobs override. */
  get seesInDark(): boolean {
    return false;
  }

  /**
   * Throws if the actor is in an unlit room and cannot see in the dark. Targeting
   * actions (attack/loot/harvest) call this; movement and light actions do not.
   *
   * @param verb - The blocked action, for the error message.
   */
  protected requireVisibleTarget(verb: string) {
    const room = this.#currentRoom;
    if (room && !room.isLit && !this.seesInDark) {
      throw new ProceduralViolation(`Cannot ${verb} in the dark`);
    }
  }
```

Add `get seesInDark(): boolean;` to the `ICharacter` interface.

In `harvest` (~line 692), add the gate as the first line of the method body (before the co-location check):

```ts
  harvest(cache: IMaterialCache) {
    this.requireVisibleTarget("harvest");
    if (!this.#currentRoom?.materials.has(cache.id)) {
      // ...existing...
```

- [ ] **Step 4: Implement the attack gate**

In `src/lib/character/combatant.ts`, in `attack` (~line 39), add the gate immediately after the `attemptAction` guard:

```ts
  attack(c: ICharacter) {
    if (!this.attemptAction(this.attack, false)) return;
    this.requireVisibleTarget("attack");
    // ...existing weapon/damage logic...
```

- [ ] **Step 5: Implement the loot gate**

In `src/lib/character/player-character.ts`, in `takeFromLootBox` (~line 157), add the gate after the `attemptAction` guard and before `#requireCoLocated`:

```ts
  takeFromLootBox(lootBox: ILoot, item: IItem | IItem[]): IItem[] {
    if (!this.attemptAction(this.takeFromLootBox, false)) return [];
    this.requireVisibleTarget("loot");
    this.#requireCoLocated(lootBox);
    // ...existing...
```

> Gate only `takeFromLootBox` (the loot *action*). Leave `openLootBox` ungated — viewing/data is a renderer concern per the spec's "block targeting, not hide data" principle.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/lib/character/combatant.test.ts src/lib/character/character.test.ts src/lib/character/player-character.test.ts`
Expected: PASS

- [ ] **Step 7: Run checks and commit**

```bash
npm run checks
git add src/lib/character/character.ts src/lib/character/combatant.ts src/lib/character/player-character.ts src/lib/character/combatant.test.ts src/lib/character/character.test.ts src/lib/character/player-character.test.ts
git commit -m "feat: gate attack/loot/harvest behind room light"
```

---

### Task 8: Light-averse mobs + light vulnerability

**Files:**
- Modify: `src/lib/character/mob.ts` (constructor option, field, `seesInDark` + `lightAverse` overrides)
- Modify: `src/lib/character/character.ts` (`lightAverse` getter default, `LIGHT_VULNERABILITY` constant, `takeDamage` multiplier)
- Test: `src/lib/character/mob.test.ts`

- [ ] **Step 1: Write the failing test**

In `src/lib/character/mob.test.ts`:

```ts
describe("light-averse mob", () => {
  it("seesInDark is true", () => {
    const mob = makeMob({ lightAverse: true });
    expect(mob.seesInDark).toBe(true);
  });

  it("defaults to not light-averse", () => {
    expect(makeMob().seesInDark).toBe(false);
  });

  it("takes LIGHT_VULNERABILITY-amplified damage while its room is lit", () => {
    const litRoom = makeNonDarkRoom();       // non-dark => always lit
    const mob = makeMob({ lightAverse: true });
    placeIn(mob, litRoom);                    // reuse the file's room-placement helper
    const before = mob.stats[StatType.Health];
    mob.takeDamage(10, StatType.Health);      // no armor/mitigation => raw 10 * 1.5 = 15
    expect(before - mob.stats[StatType.Health]).toBeCloseTo(15);
  });

  it("takes normal damage while its room is dark", () => {
    const darkRoom = makeAuthoredDarkRoom();  // dark, no light => unlit
    const mob = makeMob({ lightAverse: true });
    placeIn(mob, darkRoom);
    const before = mob.stats[StatType.Health];
    mob.takeDamage(10, StatType.Health);
    expect(before - mob.stats[StatType.Health]).toBeCloseTo(10);
  });

  it("a non-light-averse defender is unaffected by room lit state", () => {
    const litRoom = makeNonDarkRoom();
    const mob = makeMob();                     // not light-averse
    placeIn(mob, litRoom);
    const before = mob.stats[StatType.Health];
    mob.takeDamage(10, StatType.Health);
    expect(before - mob.stats[StatType.Health]).toBeCloseTo(10);
  });
});
```

Use a mob with **no armor and a mitigator stat that yields a 1.0 damage multiplier** so the raw arithmetic is predictable — check `mob.test.ts` for how existing `takeDamage` tests neutralize mitigation (they set the mitigator stat to the value that makes `MAX_STAT - mitigator` produce a ×1 multiplier) and reuse that setup in `makeMob`'s stats. The assertions above assume mitigation is neutral (×1), so only the light multiplier moves the number.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/character/mob.test.ts -t "light-averse"`
Expected: FAIL — `lightAverse` option and the multiplier don't exist.

- [ ] **Step 3: Add the `lightAverse` default + constant + multiplier on `Character`**

In `src/lib/character/character.ts`:

1. Define the constant near the other damage constants (`MAX_STAT`, `MITIGATION_PER_POINT`):
```ts
/** Damage multiplier applied to a light-averse creature while its room is lit. */
export const LIGHT_VULNERABILITY = 1.5;
```
2. Add the default getter near `seesInDark`:
```ts
  /** Whether this actor takes amplified damage while its room is lit. Default false; light-averse mobs override. */
  protected get lightAverse(): boolean {
    return false;
  }
```
3. In `takeDamage` (~lines 728–761), apply the multiplier to `finalAttackStrength` **after** armor + stat mitigation and **before** it is subtracted from the stat. Change:
```ts
    const finalAttackStrength = mitigatedStrength * damageMultiplier;

    this.stats[attackStat] = this.stats[attackStat] - finalAttackStrength;
```
to:
```ts
    const lightMultiplier =
      this.lightAverse && this.#currentRoom?.isLit ? LIGHT_VULNERABILITY : 1;
    const finalAttackStrength = mitigatedStrength * damageMultiplier * lightMultiplier;

    this.stats[attackStat] = this.stats[attackStat] - finalAttackStrength;
```

- [ ] **Step 4: Override on `Mob`**

In `src/lib/character/mob.ts`:

1. Add `lightAverse?: boolean` to the constructor options object (the `options: CharacterOptions & { baseEscapeChance?: number; materialDrops?: MaterialMap }` type at ~line 56):
```ts
    options: CharacterOptions & {
      baseEscapeChance?: number;
      materialDrops?: MaterialMap;
      lightAverse?: boolean;
    } = {},
```
2. Add a private field and assign it in the constructor (near `#baseEscapeChance`):
```ts
  #lightAverse: boolean;
  // in constructor body:
  this.#lightAverse = options.lightAverse ?? false;
```
3. Override both getters (place after the constructor):
```ts
  override get seesInDark(): boolean {
    return this.#lightAverse;
  }

  protected override get lightAverse(): boolean {
    return this.#lightAverse;
  }
```

(`noImplicitOverride` requires the `override` keyword — both base members exist on `Character`.)

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/lib/character/mob.test.ts -t "light-averse"`
Expected: PASS

- [ ] **Step 6: Run checks and commit**

```bash
npm run checks
git add src/lib/character/mob.ts src/lib/character/character.ts src/lib/character/mob.test.ts
git commit -m "feat: light-averse mobs see in dark and take amplified damage when lit"
```

---

### Task 9: Visibility presentation cue

**Files:**
- Modify: `src/lib/presentation.ts` (add `visibility` variant to `PresentationCue` ~lines 27–29)
- Modify: `src/lib/character/character.ts` (emit on room enter in `[PLACE]` ~line 769; emit on light-state flip in `equip`/`unequip`/`placeLight`/`takeLight`)
- Test: `src/lib/presentation.test.ts` (type-level / shape), `src/lib/character/character.test.ts` (emission)

- [ ] **Step 1: Write the failing test**

In `src/lib/character/character.test.ts`, capture cues via a spy campaign. Build a `Character` with a `makeCampaign()` whose `[EMIT_CUE]` is a `vi.fn()` so emissions are observable (extend the local campaign stub or wrap it):

```ts
describe("visibility cue", () => {
  it("entering an unlit room emits { kind: 'visibility', lit: false }", () => {
    const cues: PresentationCue[] = [];
    const hero = makeCharacterWithCueSink(cues);   // campaign[EMIT_CUE] pushes into `cues`
    const room = makeAuthoredDarkRoom();
    hero.moveTo(room);                             // reuse the file's room-entry/PLACE helper
    expect(cues).toContainEqual(
      expect.objectContaining({ kind: "visibility", lit: false }),
    );
  });

  it("placing a light in a dark room emits { lit: true }", () => {
    const cues: PresentationCue[] = [];
    const hero = makeCharacterWithCueSink(cues);
    const room = makeAuthoredDarkRoom();
    hero.moveTo(room);
    const torch = makeGear({ name: "Torch", slot: SlotKind.Hand, emitsLight: true });
    hero.addToInventory(torch);
    cues.length = 0;                                // ignore the enter cue
    hero.placeLight(torch);
    expect(cues).toContainEqual(
      expect.objectContaining({ kind: "visibility", lit: true }),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/character/character.test.ts -t "visibility cue"`
Expected: FAIL — no cue emitted; `visibility` is not a valid `PresentationCue`.

- [ ] **Step 3: Add the cue variant**

In `src/lib/presentation.ts`, extend the union (~lines 27–29):

```ts
export type PresentationCue =
  | { kind: "action"; action: ActionKind; actor: EntityRef; sound?: AssetRef }
  | { kind: "encounter"; mob: EntityRef; room: EntityRef; sound?: AssetRef }
  | { kind: "visibility"; room: EntityRef; lit: boolean };
```

- [ ] **Step 4: Emit on room enter**

In `src/lib/character/character.ts`, in the `[PLACE]` method (~lines 769–775), after `room.enterRoom(this);`:

```ts
  [PLACE](room: IRoom) {
    if (this.#currentRoom) {
      this.#currentRoom.exitRoom(this);
    }
    this.#currentRoom = room;
    room.enterRoom(this);
    if (!room.isLit) {
      this.campaign[EMIT_CUE]({
        kind: "visibility",
        room: { id: room.id, name: room.name },
        lit: false,
      });
    }
  }
```

- [ ] **Step 5: Emit on light-state flip**

Add a private helper and call it from `equip`, `unequip`, `placeLight`, `takeLight`:

```ts
  /** Emits a visibility cue if a dark room's lit state changed across a light action. */
  #emitVisibilityIfFlipped(room: IRoom | undefined, wasLit: boolean) {
    if (room && room.dark && room.isLit !== wasLit) {
      this.campaign[EMIT_CUE]({
        kind: "visibility",
        room: { id: room.id, name: room.name },
        lit: room.isLit,
      });
    }
  }
```

- In `placeLight`/`takeLight`: capture `const wasLit = room.isLit;` at the top (after resolving `room`), and call `this.#emitVisibilityIfFlipped(room, wasLit);` at the end (after the mutation).
- In `equip`/`unequip`: after the `attemptAction` guard, capture `const room = this.#currentRoom; const wasLit = room?.isLit ?? true;`, and after the existing `item[EQUIP]/[UNEQUIP]` call, `this.#emitVisibilityIfFlipped(room, wasLit);`. (Only `emitsLight` items in a hand will flip a dark room, so this is a no-op otherwise.)

Confirm `EMIT_CUE` is imported from `../presentation` (it is used elsewhere in `character.ts`).

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run src/lib/character/character.test.ts -t "visibility cue"`
Expected: PASS

- [ ] **Step 7: Run checks and commit**

```bash
npm run checks
git add src/lib/presentation.ts src/lib/character/character.ts src/lib/character/character.test.ts
git commit -m "feat: emit visibility cue on dark-room enter and light flips"
```

---

### Task 10: Integration test + README

**Files:**
- Modify: `src/integration.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Write the integration test**

In `src/integration.test.ts`, add an end-to-end scenario (use the real `Campaign`/`Room`/`PlayerCharacter`/`Mob` construction already used by that suite):

```ts
describe("darkness mechanic", () => {
  it("a dark room conceals targeting until lit, then exposes a vulnerable light-averse mob", () => {
    // 1. Author a dark room containing a light-averse mob and a loot box.
    // 2. Party enters (cue: visibility lit:false).
    // 3. Attacking the mob / taking loot throws ProceduralViolation (room unlit).
    // 4. The mob (seesInDark) CAN attack the party in the dark.
    // 5. A party member equips a torch (or places a candle) -> room.isLit true (cue: visibility lit:true).
    // 6. Now the mob is targetable; it takes LIGHT_VULNERABILITY-amplified damage.
    // Assert each transition with expect(...).toThrow / not.toThrow and the damage delta.
  });
});
```

Fill in each numbered step with concrete construction mirroring the rest of `integration.test.ts` (it already builds campaigns, rooms, and characters). Assert: unlit-room loot/attack throw `ProceduralViolation`; the light-averse mob attacks successfully while unlit; after lighting, the party's attack lands and the damage delta reflects `× LIGHT_VULNERABILITY`.

- [ ] **Step 2: Run the integration test**

Run: `npx vitest run src/integration.test.ts -t "darkness"`
Expected: PASS

- [ ] **Step 3: Document the mechanic in README**

In `README.md`, add a "Darkness & light" section near the room/exploration material. Cover: author-time `dark` rooms; light sources (`emitsLight`) active when carried (equipped in a hand) or placed (`Room.lightSources`); `placeLight`/`takeLight` as free actions; `Room.isLit` derivation; the targeting gate (attack/loot/harvest blocked in unlit rooms unless `seesInDark`); light-averse mobs (`lightAverse` → see in dark + `LIGHT_VULNERABILITY` ×1.5 damage when lit); the `visibility` presentation cue and that concealing description/occupant/loot lists is a renderer concern driven by cues. Note the non-goals (no fuel/burn-down, exits always visible, players need light).

- [ ] **Step 4: Final full verification**

Run: `npm run checks`
Expected: lint + typecheck + full test suite all green.

- [ ] **Step 5: Commit**

```bash
git add src/integration.test.ts README.md
git commit -m "test: darkness integration + docs"
```

---

## Self-Review

**1. Spec coverage** — every spec section maps to a task:
- §1 Room darkness → Task 2.
- §2 Light sources & illumination (`emitsLight`, `lightSources`, `placeLight`/`takeLight`, symbol seam) → Tasks 1, 3, 6.
- §3 Lit state (`isLit`, `hasLight`) → Tasks 4, 5.
- §4 Vision & targeting gate (`seesInDark`, attack/loot/harvest) → Task 7.
- §5 Light-averse mobs (`lightAverse`, `LIGHT_VULNERABILITY` in `takeDamage`) → Task 8.
- §6 Presentation cues (`visibility` variant, enter + flip emission) → Task 9.
- Conventions (symbol seams, `ProceduralViolation`, free actions, no RNG, branded `ItemId`) → honored in Tasks 3/6 (seams), 6/7 (throws), 6 (free actions), 8 (no RNG), 3 (`ItemId` keying).
- Testing matrix (§Testing) → distributed across the per-task tests + Task 10 integration.

**2. Placeholder scan** — the integration test (Task 10) and several "construction note" helpers are described rather than fully coded, because they must reuse each test file's *existing* room-placement/campaign-stub patterns, which differ per file and shouldn't be reinvented. Each such note names the exact existing helper to mirror and the exact assertions required. All production-code steps contain complete code.

**3. Type consistency** — names are fixed in the Shared Identifiers table and used verbatim throughout: `emitsLight`, `ADD_LIGHT_SOURCE`/`REMOVE_LIGHT_SOURCE`, `dark`, `lightSources`, `isLit`, `hasLight`, `seesInDark`, `lightAverse`, `placeLight`/`takeLight`, `requireVisibleTarget`, `LIGHT_VULNERABILITY`, and the `{ kind: "visibility"; room: EntityRef; lit: boolean }` cue. `ItemHolder = ICharacter | ILoot` (a `Room` is not a holder) is why a placed light is `CLAIM(null)`, consistent between Task 6's code and rationale.

**Open implementation choices (low-risk, decided here):**
- `Room` gains `dark` and authored `lightSources` as **trailing positional** constructor params (matches the existing all-positional constructor; no call-site churn).
- The targeting gate is one **protected** `Character.requireVisibleTarget(verb)` reused by `Combatant.attack`, `Character.harvest`, and `PlayerCharacter.takeFromLootBox` (DRY).
- Only `takeFromLootBox` is gated, not `openLootBox` — viewing is data (renderer concern), taking is targeting.
