# Material Economy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a party-wide raw-material pool on `Campaign`, fed by destroying items and harvesting single-use material caches, with engine-enforced anti-farming.

**Architecture:** Materials are pooled quantities (`MaterialMap = Partial<Record<ItemComponentType, number>>`), never inventory items, living on `Campaign`. A symbol-keyed internal deposit (`DEPOSIT_MATERIALS`) keeps minting off the public API; the only public grant is the idempotent `claimMaterials(claimId, …)`. World grants come from single-use `MaterialCache` entities placed in rooms and harvested by a co-located character. Spending (`withdrawMaterials`/`canAfford`) is built here for later sub-projects but not yet called.

**Tech Stack:** TypeScript (strict, NodeNext), Vitest, ESLint (typescript-eslint recommended + recommendedTypeChecked). Branded ids via `Brand<T, TBrand>`; engine-internal mutators via `Symbol`-keyed methods (the existing `CLAIM`/`HELD_BY` pattern).

**Spec:** `docs/superpowers/specs/2026-06-09-material-economy-design.md`

---

## File Structure

- `src/lib/inventory.ts` *(modify)* — add `MaterialMap` type + `DEPOSIT_MATERIALS` symbol; wire `Item.Destroy` to deposit its `recipe`.
- `src/lib/campaign.ts` *(modify)* — the pool: `#materials`/`#claims`, `materials` getter + throwing setter, `[DEPOSIT_MATERIALS]`, `claimMaterials`, `withdrawMaterials`, `canAfford`.
- `src/lib/material-cache.ts` *(create)* — `MaterialCache` (`MaterialCacheId`, `IMaterialCache`, `DEPLETE` symbol): a single-use harvestable pile.
- `src/lib/room.ts` *(modify)* — hold caches in `materials: Map<MaterialCacheId, IMaterialCache>` via a new constructor argument.
- `src/lib/character/character.ts` *(modify)* — `harvest(cache)`: co-located, idempotent, free.
- Tests live beside each source file (`*.test.ts`), plus a new `src/lib/material-cache.test.ts`.

**Build order rationale:** the pool API (Tasks 1–3) comes first because every inflow deposits into it. Destroy wiring (Task 4) and caches/harvest (Tasks 5–7) layer on top.

---

### Task 1: `MaterialMap` type, `DEPOSIT_MATERIALS` symbol, and the Campaign pool (deposit + read)

**Files:**
- Modify: `src/lib/inventory.ts`
- Modify: `src/lib/campaign.ts`
- Test: `src/lib/campaign.test.ts`

- [ ] **Step 1: Add the `MaterialMap` type and `DEPOSIT_MATERIALS` symbol to `inventory.ts`**

In `src/lib/inventory.ts`, immediately after the `Recipe` type (the `RequireAtLeastOne<…>` block), add:

```ts
/** A quantity of raw materials by component type; the currency of the party pool. */
export type MaterialMap = Partial<Record<ItemComponentType, number>>;
```

In `src/lib/inventory.ts`, immediately after the `HELD_BY` symbol definition, add:

```ts
/**
 * Symbol-keyed method that adds raw materials to the party's pool.
 *
 * Raw deposits are funnelled through this symbol so author/scene code cannot mint
 * materials at will (which would defeat anti-farming). Only engine internals — the
 * Item Destroy wrapper, {@link Character.harvest}, and {@link Campaign.claimMaterials}
 * — call it. There is no public "add materials" method.
 */
export const DEPOSIT_MATERIALS = Symbol("depositMaterials");
```

- [ ] **Step 2: Write the failing pool tests**

In `src/lib/campaign.test.ts`, add `DEPOSIT_MATERIALS` to the imports:

```ts
import { DEPOSIT_MATERIALS } from "./inventory";
```

Then add this describe block at the end of the top-level `describe("Campaign", …)` body (before its closing `});`):

```ts
  describe("material pool", () => {
    it("starts empty", () => {
      expect(new Campaign("Materials").materials).toEqual({});
    });

    it("sums deposits by component", () => {
      const campaign = new Campaign("Materials");

      campaign[DEPOSIT_MATERIALS]({ metal: 2 });
      campaign[DEPOSIT_MATERIALS]({ metal: 3, glass: 1 });

      expect(campaign.materials).toEqual({ metal: 5, glass: 1 });
    });

    it("exposes a copy that cannot mutate the pool", () => {
      const campaign = new Campaign("Materials");
      campaign[DEPOSIT_MATERIALS]({ metal: 2 });

      (campaign.materials as Record<string, number>).metal = 99;

      expect(campaign.materials).toEqual({ metal: 2 });
    });

    it("throws when materials is assigned directly", () => {
      const campaign = new Campaign("Materials");

      expect(() => {
        (campaign as unknown as { materials: unknown }).materials = {};
      }).toThrow(ProceduralViolation);
    });
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/lib/campaign.test.ts -t "material pool"`
Expected: FAIL — `campaign[DEPOSIT_MATERIALS]` is not a function / `materials` is undefined (type error or runtime).

- [ ] **Step 4: Implement the pool on `Campaign`**

In `src/lib/campaign.ts`, update the imports:

```ts
import { DEPOSIT_MATERIALS, type MaterialMap } from "./inventory";
```

and add `typedEntries` to the existing `util` import so it reads:

```ts
import { generateId, ProceduralViolation, typedEntries } from "./util";
```

In the `ICampaign` interface, add to the `### Properties` section (e.g. just after `title`):

```ts
  /** Read-only view of the party's shared raw-material pool. */
  get materials(): Readonly<MaterialMap>;
  /** Adds raw materials to the pool. Engine-internal; see {@link DEPOSIT_MATERIALS}. */
  [DEPOSIT_MATERIALS](mats: MaterialMap): void;
```

In the `Campaign` class, add a private field beside the other `#` fields:

```ts
  #materials: MaterialMap = {};
```

Add the getter and throwing setter beside the other getters (e.g. after the `round` getter):

```ts
  get materials(): Readonly<MaterialMap> {
    return { ...this.#materials };
  }

  /**
   * Guards against replacing the pool wholesale.
   * @throws {@link ProceduralViolation} always — deposit via the engine-internal
   *   {@link DEPOSIT_MATERIALS} or {@link Campaign.claimMaterials}.
   */
  set materials(_value: MaterialMap) {
    throw new ProceduralViolation("Cannot set 'materials' directly");
  }
```

Add the deposit method (e.g. after the `transfer` method):

```ts
  /**
   * Adds raw materials to the party pool, summing by component. Engine-internal:
   * the Item Destroy wrapper, {@link Character.harvest}, and
   * {@link Campaign.claimMaterials} are its only callers.
   *
   * @param mats - Quantities to add, by component type.
   */
  [DEPOSIT_MATERIALS](mats: MaterialMap) {
    for (const [component, qty] of typedEntries(mats)) {
      if (qty === undefined) continue;
      this.#materials[component] = (this.#materials[component] ?? 0) + qty;
    }
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/lib/campaign.test.ts -t "material pool"`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/lib/inventory.ts src/lib/campaign.ts src/lib/campaign.test.ts
git commit -m "feat: add party material pool with internal deposit

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Campaign `canAfford` and `withdrawMaterials` (the spend API)

**Files:**
- Modify: `src/lib/campaign.ts`
- Test: `src/lib/campaign.test.ts`

- [ ] **Step 1: Write the failing spend tests**

In `src/lib/campaign.test.ts`, add this describe block after the `material pool` block:

```ts
  describe("canAfford / withdrawMaterials", () => {
    function stocked(): Campaign {
      const campaign = new Campaign("Materials");
      campaign[DEPOSIT_MATERIALS]({ metal: 5, glass: 2 });
      return campaign;
    }

    it("affords amounts within the pool", () => {
      expect(stocked().canAfford({ metal: 5, glass: 1 })).toBe(true);
    });

    it("does not afford amounts beyond the pool", () => {
      expect(stocked().canAfford({ metal: 6 })).toBe(false);
      expect(stocked().canAfford({ electronics: 1 })).toBe(false);
    });

    it("subtracts withdrawn materials and removes zeroed components", () => {
      const campaign = stocked();

      campaign.withdrawMaterials({ metal: 5, glass: 1 });

      expect(campaign.materials).toEqual({ glass: 1 });
    });

    it("throws and leaves the pool unchanged when short", () => {
      const campaign = stocked();

      expect(() => campaign.withdrawMaterials({ metal: 6 })).toThrow(
        ProceduralViolation,
      );
      expect(campaign.materials).toEqual({ metal: 5, glass: 2 });
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/campaign.test.ts -t "canAfford"`
Expected: FAIL — `campaign.canAfford` / `campaign.withdrawMaterials` is not a function.

- [ ] **Step 3: Implement `canAfford` and `withdrawMaterials`**

In `src/lib/campaign.ts`, add to the `ICampaign` interface `### Methods` section:

```ts
  /** Whether the pool currently holds at least `mats`. */
  canAfford: (mats: MaterialMap) => boolean;
  /** Removes materials from the pool. Throws if the pool is short. */
  withdrawMaterials: (mats: MaterialMap) => void;
```

In the `Campaign` class, add after the `[DEPOSIT_MATERIALS]` method:

```ts
  /**
   * @param mats - Quantities to test against the pool.
   * @returns Whether every requested component is present at ≥ the requested amount.
   */
  canAfford(mats: MaterialMap): boolean {
    return (
      typedEntries(mats) as Array<[keyof MaterialMap, number | undefined]>
    ).every(
      ([component, qty]) =>
        qty === undefined || (this.#materials[component] ?? 0) >= qty,
    );
  }

  /**
   * Spends materials from the pool, removing any component that reaches zero. The
   * pool is checked up front, so a failed withdrawal leaves it unchanged.
   *
   * @param mats - Quantities to remove, by component type.
   * @throws {@link ProceduralViolation} if the pool cannot cover `mats`.
   */
  withdrawMaterials(mats: MaterialMap) {
    if (!this.canAfford(mats)) {
      throw new ProceduralViolation("Insufficient materials in the party pool.");
    }
    for (const [component, qty] of typedEntries(mats) as Array<
      [keyof MaterialMap, number | undefined]
    >) {
      if (qty === undefined) continue;
      const remaining = (this.#materials[component] ?? 0) - qty;
      if (remaining > 0) {
        this.#materials[component] = remaining;
      } else {
        delete this.#materials[component];
      }
    }
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/campaign.test.ts -t "canAfford"`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/campaign.ts src/lib/campaign.test.ts
git commit -m "feat: add material pool spend API (canAfford/withdraw)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Campaign `claimMaterials` (idempotent script grant)

**Files:**
- Modify: `src/lib/campaign.ts`
- Test: `src/lib/campaign.test.ts`

- [ ] **Step 1: Write the failing claim tests**

In `src/lib/campaign.test.ts`, add this describe block after the `canAfford / withdrawMaterials` block:

```ts
  describe("claimMaterials", () => {
    it("deposits on the first claim of an id", () => {
      const campaign = new Campaign("Materials");

      campaign.claimMaterials("vault-stash", { metal: 3 });

      expect(campaign.materials).toEqual({ metal: 3 });
    });

    it("ignores a repeated claim id", () => {
      const campaign = new Campaign("Materials");

      campaign.claimMaterials("vault-stash", { metal: 3 });
      campaign.claimMaterials("vault-stash", { metal: 3 });

      expect(campaign.materials).toEqual({ metal: 3 });
    });

    it("deposits again for a different id", () => {
      const campaign = new Campaign("Materials");

      campaign.claimMaterials("a", { metal: 3 });
      campaign.claimMaterials("b", { metal: 2 });

      expect(campaign.materials).toEqual({ metal: 5 });
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/campaign.test.ts -t "claimMaterials"`
Expected: FAIL — `campaign.claimMaterials` is not a function.

- [ ] **Step 3: Implement `claimMaterials`**

In `src/lib/campaign.ts`, add to the `ICampaign` interface `### Methods` section:

```ts
  /** Grants materials once per `claimId`; later calls with the same id are ignored. */
  claimMaterials: (claimId: string, mats: MaterialMap) => void;
```

In the `Campaign` class, add a private field beside `#materials`:

```ts
  #claims: Set<string> = new Set<string>();
```

Add the method after `withdrawMaterials`:

```ts
  /**
   * Grants materials once per `claimId`. The first call with a given id deposits
   * and records the id; later calls with the same id are no-ops. The farm-proof
   * public grant for scene/quest scripts that have no physical cache.
   *
   * @param claimId - A stable id identifying this one-time grant.
   * @param mats - Quantities to grant on the first claim.
   */
  claimMaterials(claimId: string, mats: MaterialMap) {
    if (this.#claims.has(claimId)) {
      return;
    }
    this.#claims.add(claimId);
    this[DEPOSIT_MATERIALS](mats);
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/campaign.test.ts -t "claimMaterials"`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/campaign.ts src/lib/campaign.test.ts
git commit -m "feat: add idempotent claimMaterials grant

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Destroy deposits its recipe into the party pool (and removes the item)

**Files:**
- Modify: `src/lib/inventory.ts:287-295` (the `Item.Destroy` action wrapper)
- Test: `src/lib/inventory.test.ts`

> **Note:** This task also fixes a pre-existing bug folded in during review — `Item.Destroy`
> never removed the destroyed item from its holder, leaving a "ghost" (still in the inventory
> list, `heldBy` still set). The fix removes it **silently** via `relinquishItem` + `CLAIM(null)`
> — not `removeFromInventory` — so destroying logs no `"drop"` and stays free, consistent with
> the "destroy is free" decision.

- [ ] **Step 1: Update the test holder stub and write the failing deposit tests**

In `src/lib/inventory.test.ts`, add `DEPOSIT_MATERIALS` to the inventory import so it reads:

```ts
import { CLAIM, DEPOSIT_MATERIALS, Item, createKey, type IItemHolder } from "./inventory";
```

Replace the existing `makeHolder` helper with one that carries a campaign stub (the Destroy wrapper now reads `holder.campaign`):

```ts
function makeHolder(): ICharacter {
  return {
    holderKind: "character",
    removeFromInventory: vi.fn(),
    relinquishItem: vi.fn(),
    hasRoomForItem: vi.fn(() => true),
    receiveItem: vi.fn(),
    campaign: { [DEPOSIT_MATERIALS]: vi.fn() },
  } as unknown as ICharacter;
}
```

Add this describe block after the existing `describe("destroy guard (destroyable=false)", …)` block:

```ts
describe("destroy deposits recipe into the party pool", () => {
  it("deposits the item's recipe when destroyed", () => {
    const { item, actions } = makeItem({ destroyable: true });
    const holder = makeHolder();
    hold(item, holder);

    item.actions.destroy();

    // The core action must run for the deposit to be legitimate.
    expect(actions.destroy).toHaveBeenCalled();
    expect(holder.campaign[DEPOSIT_MATERIALS]).toHaveBeenCalledWith(item.recipe);
  });

  it("deposits nothing for a non-destroyable item", () => {
    const { item } = makeItem({ destroyable: false });
    const holder = makeHolder();
    hold(item, holder);

    item.actions.destroy();

    expect(holder.campaign[DEPOSIT_MATERIALS]).not.toHaveBeenCalled();
  });

  it("deposits nothing when the item is not held", () => {
    const { item, actions } = makeItem({ destroyable: true });

    // Unheld: the wrapper short-circuits to null before the underlying destroy
    // runs, so the deposit line (which follows it) is never reached.
    expect(item.actions.destroy()).toBeNull();
    expect(actions.destroy).not.toHaveBeenCalled();
  });

  it("removes the destroyed item from the holder and unhomes it", () => {
    const { item } = makeItem({ destroyable: true });
    const holder = makeHolder();
    hold(item, holder);

    item.actions.destroy();

    expect(holder.relinquishItem).toHaveBeenCalledWith(item);
    expect(holder.removeFromInventory).not.toHaveBeenCalled();
    expect(heldBy(item)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/inventory.test.ts -t "deposits recipe"`
Expected: FAIL — `holder.campaign[DEPOSIT_MATERIALS]` was not called (the wrapper does not deposit yet).

- [ ] **Step 3: Wire the Destroy wrapper to deposit and remove the item**

In `src/lib/inventory.ts`, change the `[ItemAction.Destroy]` wrapper so it deposits the item's `recipe` into the holder's campaign pool, then removes the consumed item from the holder:

```ts
      [ItemAction.Destroy]: () => {
        const holder = this.#characterHolder();
        if (!holder) return null;
        // A non-destroyable item (e.g. a key) cannot be broken down.
        if (!this.properties.destroyable) return null;
        const components = actions[ItemAction.Destroy]();
        // Scrapping returns the item's makeup to the party pool; `recipe` is the
        // single source of truth for both scrap-yield and (later) craft-cost.
        holder.campaign[DEPOSIT_MATERIALS](this.recipe);
        events.onDestroy?.(holder, components);
        // The item is consumed: pull it from the holder and unhome it so it does
        // not linger as a ghost. Removal is silent — relinquishItem, not
        // removeFromInventory — so destroying logs no "drop" and stays free.
        holder.relinquishItem(this);
        this[CLAIM](null);
        return components;
      },
```

(`DEPOSIT_MATERIALS` and `CLAIM` are already defined in this file from Task 1 / earlier; no new import needed. `holder.campaign` is typed `ICampaign`, which declares `[DEPOSIT_MATERIALS]`; `relinquishItem` comes from `IItemHolder`.)

- [ ] **Step 4: Run the full inventory suite to verify it passes (and existing destroy tests still pass)**

Run: `npx vitest run src/lib/inventory.test.ts`
Expected: PASS — the four new tests plus all pre-existing `Item`/`createKey` tests (the updated `makeHolder` keeps the existing `destroy` and `createKey` tests green).

- [ ] **Step 5: Commit**

```bash
git add src/lib/inventory.ts src/lib/inventory.test.ts
git commit -m "feat: destroy deposits item recipe into the party pool

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: `MaterialCache` — a single-use harvestable pile

**Files:**
- Create: `src/lib/material-cache.ts`
- Test: `src/lib/material-cache.test.ts`

- [ ] **Step 1: Write the failing cache tests**

Create `src/lib/material-cache.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { DEPLETE, MaterialCache } from "./material-cache";

describe("MaterialCache", () => {
  it("assigns an id and starts undepleted with the given contents", () => {
    const cache = new MaterialCache({ metal: 3, glass: 1 });

    expect(typeof cache.id).toBe("string");
    expect(cache.id.length).toBeGreaterThan(0);
    expect(cache.depleted).toBe(false);
    expect(cache.contents).toEqual({ metal: 3, glass: 1 });
  });

  it("copies the contents so later mutation of the source is ignored", () => {
    const source = { metal: 3 };
    const cache = new MaterialCache(source);

    source.metal = 99;

    expect(cache.contents).toEqual({ metal: 3 });
  });

  it("yields its contents and marks itself depleted on the first deplete", () => {
    const cache = new MaterialCache({ metal: 3 });

    expect(cache[DEPLETE]()).toEqual({ metal: 3 });
    expect(cache.depleted).toBe(true);
    expect(cache.contents).toEqual({});
  });

  it("yields nothing on a second deplete", () => {
    const cache = new MaterialCache({ metal: 3 });

    cache[DEPLETE]();

    expect(cache[DEPLETE]()).toEqual({});
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/material-cache.test.ts`
Expected: FAIL — cannot resolve `./material-cache` (module does not exist yet).

- [ ] **Step 3: Implement `MaterialCache`**

Create `src/lib/material-cache.ts`:

```ts
import { Brand } from "./brand";
import { MaterialMap } from "./inventory";
import { generateId } from "./util";

/** Unique identifier for a {@link MaterialCache}. */
export type MaterialCacheId = Brand<string, "MaterialCacheId">;

/**
 * Symbol-keyed method that empties a cache, returning what it held.
 *
 * Depletion is funnelled through this symbol so the one-way "harvested" state
 * transition cannot be driven from outside; only {@link Character.harvest} calls
 * it.
 */
export const DEPLETE = Symbol("depleteCache");

/**
 * A single-use pile of raw materials placed in a room. Harvesting empties it; a
 * depleted cache yields nothing further, which is what makes a re-firing scene's
 * repeated harvest a safe no-op (anti-farming).
 */
export interface IMaterialCache {
  id: MaterialCacheId;
  /** Whether this cache has already been harvested. */
  get depleted(): boolean;
  /** The materials still available to harvest (`{}` once depleted). */
  get contents(): Readonly<MaterialMap>;
  /**
   * Empties the cache and returns what it held. Idempotent: a depleted cache
   * returns `{}` and changes nothing. For {@link Character.harvest} only.
   */
  [DEPLETE](): MaterialMap;
}

/**
 * Default {@link IMaterialCache} implementation. Contents are copied on
 * construction so the caller's object cannot mutate the cache afterwards.
 */
export class MaterialCache implements IMaterialCache {
  id: MaterialCacheId;

  #contents: MaterialMap;
  #depleted = false;

  get depleted() {
    return this.#depleted;
  }

  get contents(): Readonly<MaterialMap> {
    return { ...this.#contents };
  }

  /** @param contents - The materials this cache yields when harvested. */
  constructor(contents: MaterialMap) {
    this.id = generateId<MaterialCacheId>();
    this.#contents = { ...contents };
  }

  [DEPLETE](): MaterialMap {
    if (this.#depleted) {
      return {};
    }
    this.#depleted = true;
    const yielded = this.#contents;
    this.#contents = {};
    return yielded;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/material-cache.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/material-cache.ts src/lib/material-cache.test.ts
git commit -m "feat: add single-use MaterialCache

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Rooms hold material caches

**Files:**
- Modify: `src/lib/room.ts`
- Test: `src/lib/room.test.ts`

- [ ] **Step 1: Write the failing room tests**

In `src/lib/room.test.ts`, add the cache import below the existing imports:

```ts
import { MaterialCache } from "./material-cache";
```

Add these tests inside the `describe("constructor", …)` block (after the existing loot/exits tests):

```ts
    it("keys the materials map by each cache's id", () => {
      const first = new MaterialCache({ metal: 1 });
      const second = new MaterialCache({ glass: 2 });
      const room = new Room("A Dim Room", "a dim room", [], {} as ExitsArg, [
        first,
        second,
      ]);

      expect(room.materials.size).toBe(2);
      expect(room.materials.get(first.id)).toBe(first);
      expect(room.materials.get(second.id)).toBe(second);
    });

    it("defaults to no material caches", () => {
      expect(makeRoom().materials.size).toBe(0);
    });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/room.test.ts -t "materials"`
Expected: FAIL — `room.materials` is undefined (and the 5-arg constructor call is a type error).

- [ ] **Step 3: Add `materials` to `Room`**

In `src/lib/room.ts`, add the import below the existing imports:

```ts
import type { IMaterialCache, MaterialCacheId } from "./material-cache";
```

In the `IRoom` interface, add after the `loot` property:

```ts
  /** Material caches present in the room, keyed by id. */
  materials: Map<MaterialCacheId, IMaterialCache>;
```

In the `Room` class, add the public field beside `loot`:

```ts
  materials: Map<MaterialCacheId, IMaterialCache>;
```

Change the constructor signature to accept caches (new last parameter, defaulted so existing 4-arg callers are unaffected):

```ts
  constructor(
    name: string,
    description: string,
    loot: ILoot[],
    exits: Record<Direction, IRoom>,
    materials: IMaterialCache[] = [],
  ) {
```

Add a `@param` line to the constructor's TSDoc:

```ts
   * @param materials - Material caches initially present in the room.
```

In the constructor body, after the loop that fills `this.loot`, build the materials map:

```ts
    this.materials = new Map<MaterialCacheId, IMaterialCache>();
    for (const cache of materials) {
      this.materials.set(cache.id, cache);
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/room.test.ts`
Expected: PASS — the two new tests plus all existing Room tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/room.ts src/lib/room.test.ts
git commit -m "feat: rooms hold material caches

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: `Character.harvest`

**Files:**
- Modify: `src/lib/character/character.ts`
- Test: `src/lib/character/character.test.ts`

- [ ] **Step 1: Write the failing harvest tests**

In `src/lib/character/character.test.ts`, add these imports below the existing ones:

```ts
import { Campaign } from "../campaign";
import { Room } from "../room";
import { MaterialCache } from "../material-cache";
import type { ExitsArg } from "../../test-utils";
```

Add this describe block inside the top-level `describe("Character", …)` body (e.g. at the end, before its closing `});`):

```ts
  describe("harvest", () => {
    function setup() {
      const campaign = new Campaign("Materials");
      const character = new Character(campaign, "Hero", makeStats());
      const cache = new MaterialCache({ metal: 3, glass: 1 });
      const room = new Room("Vault", "a vault", [], {} as ExitsArg, [cache]);
      character.move(room);
      return { campaign, character, cache };
    }

    it("deposits a co-located cache into the party pool and depletes it", () => {
      const { campaign, character, cache } = setup();

      character.harvest(cache);

      expect(campaign.materials).toEqual({ metal: 3, glass: 1 });
      expect(cache.depleted).toBe(true);
    });

    it("is idempotent: a second harvest deposits nothing more", () => {
      const { campaign, character, cache } = setup();

      character.harvest(cache);
      character.harvest(cache);

      expect(campaign.materials).toEqual({ metal: 3, glass: 1 });
    });

    it("throws when the cache is not in the current room", () => {
      const { character } = setup();
      const stray = new MaterialCache({ metal: 9 });

      expect(() => character.harvest(stray)).toThrow(ProceduralViolation);
    });

    it("does not consume an action (records no history)", () => {
      const { character, cache } = setup();
      const before = character.history.length;

      character.harvest(cache);

      expect(character.history.length).toBe(before);
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/character/character.test.ts -t "harvest"`
Expected: FAIL — `character.harvest` is not a function.

- [ ] **Step 3: Implement `harvest`**

In `src/lib/character/character.ts`, add `DEPOSIT_MATERIALS` to the inventory import so it reads:

```ts
import { CLAIM, DEPOSIT_MATERIALS, IItem, IItemHolder, Inventory } from "../inventory";
```

Add the cache import below the existing imports:

```ts
import { DEPLETE, type IMaterialCache } from "../material-cache";
```

In the `ICharacter` interface `### Methods` section, add:

```ts
  /** Harvests a co-located material cache into the party pool (free; idempotent). */
  harvest: (cache: IMaterialCache) => void;
```

In the `Character` class, add the method (e.g. after `transferKey`):

```ts
  /**
   * Harvests a material cache in the character's current room into the party
   * pool. Idempotent: harvesting an already-depleted cache deposits nothing. Free
   * — it does not consume a budgeted action.
   *
   * @param cache - A cache present in the character's current room.
   * @throws {@link ProceduralViolation} if the cache is not in the current room.
   */
  harvest(cache: IMaterialCache) {
    if (!this.#currentRoom?.materials.has(cache.id)) {
      throw new ProceduralViolation(
        "Cannot harvest a material cache that is not in the current room",
      );
    }
    this.campaign[DEPOSIT_MATERIALS](cache[DEPLETE]());
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/character/character.test.ts -t "harvest"`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/character/character.ts src/lib/character/character.test.ts
git commit -m "feat: add Character.harvest for material caches

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Final verification

- [ ] **Run the full check suite**

Run: `npm run checks`
Expected: lint clean, typecheck clean, all tests pass (the existing suite plus the new material-economy tests).

If anything fails, fix it before considering the sub-project complete.

---

## Self-Review (author checklist — already run)

**1. Spec coverage:**
- Party-wide pool on `Campaign` → Task 1. ✅
- Materials never occupy a slot (pooled quantities) → `MaterialMap`, Task 1. ✅
- Destroy deposits `recipe`; `recipe` = single source of truth → Task 4. ✅
- World grants via single-use caches harvested by a co-located character → Tasks 5–7. ✅
- Engine-enforced anti-farming (symbol-keyed deposit + idempotent caches + claim-id dedupe) → Tasks 1 (`DEPOSIT_MATERIALS`), 3 (`claimMaterials`), 5/7 (cache depletion). ✅
- Spend/affordability API for ②/③, defined-not-called → Task 2. ✅
- Harvest and destroy are free (no budget tick) → Task 4 (destroy unchanged off `recordAction`), Task 7 (harvest records nothing; asserted). ✅

**2. Placeholder scan:** No TBD/TODO; every code step shows complete code. ✅

**3. Type consistency:** `MaterialMap` used identically across Campaign, MaterialCache, Character. `DEPOSIT_MATERIALS` defined in `inventory.ts` (Task 1), consumed by Campaign (1/3), Item (4), Character (7). `DEPLETE` defined in `material-cache.ts` (5), consumed by Character (7). `MaterialCacheId`/`IMaterialCache` defined in Task 5, consumed by Room (6) and Character (7). Constructor arg added to `Room` (6) is last + defaulted, so `test-utils.ExitsArg` (`ConstructorParameters<typeof Room>[3]`) is unchanged. ✅

**4. Circular-import check:** `campaign.ts` gains a runtime import of `DEPOSIT_MATERIALS` from `inventory.ts`; `inventory.ts` has no runtime import of `campaign.ts` (only type-only `ICharacter`/`ILoot`), so no cycle. `material-cache.ts` runtime-depends only on `util` (`generateId`); `room.ts` imports it type-only. ✅
