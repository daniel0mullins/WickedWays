# Crafting — Design

**Date:** 2026-06-09
**Status:** Approved (pending implementation plan)

## Context — the larger crafting effort

This is **sub-project ② of three** of the crafting feature:

1. **Material economy** *(done — PR #14)* — a party-wide raw-material pool plus its inflows
   and spend API (`canAfford` / `withdrawMaterials`).
2. **Crafting** *(this spec)* — turn known recipes into items: raw materials → regular items,
   and keys → higher-tier keys, with party-wide recipe discovery.
3. **Durability & repair** *(later spec)* — broken state, wear-and-tear, and repair.

Crafting **depends on** sub-project ① (it spends from the pool) and on the existing key
system from PR #13 (`createKey`, `consumeKey`, the free keyring). This branch is stacked on
`feature/material-economy`; once ① merges, it rebases onto `main`.

## Summary

Add **crafting** to Wicked Ways: a recipe turns inputs into an output item. A
**`CraftingRecipe`** is a first-class object — an id, an input cost, and a `create()` factory
for the output. There are two tracks, mirroring how the engine already separates regular items
from keys:

- **Item track:** cost is raw **materials** (spent from the party pool); the output is a
  regular `Item` that occupies an inventory slot.
- **Key track:** cost is **keys** (held in the crafter's keyring); the output is a key
  (`createKey`), stored for free.

Recipes a party can craft live party-wide on `Campaign` in `#knownRecipes`. A recipe becomes
known three ways: **seeded at campaign construction**, **discovered by picking up** an item
that teaches it (`item.teaches`), or granted by the **`discoverRecipe(recipe)`** script
primitive. Crafting is **free** (no action cost), and validates all-or-nothing before spending.

**Recipe-only items** (obtainable *only* by crafting) need no engine concept: an author
teaches the recipe via a findable **blueprint** item and simply never spawns the output.

## Goals

- A first-class `CraftingRecipe`: `id`, input cost (materials *or* keys), and a `create()`
  output factory.
- Two structurally-separated tracks: materials → regular item (slot); keys → key (free).
- Party-wide known recipes on `Campaign`, **seeded at construction** and grown by pickup
  discovery and a script primitive.
- `Character.craft(recipeId)` — free, all-or-nothing (a failed craft mutates nothing).
- Recipe-only items supported purely as an authoring pattern (blueprint + un-spawned output).

## Non-Goals

- No durability, broken state, wear-and-tear, or repair (sub-project ③).
- No workbenches / craft-location requirement, no tech-tree gating beyond "is the recipe
  known", no crafting UI.
- No engine `recipeOnly` flag — recipe-only is an authoring pattern, not enforced.
- No quantity/batch argument on `craft` — one call crafts one output (call it again to make
  more; it's free anyway).
- No changes to `scene.ts`, `history.ts`, `loot.ts`, `room.ts`, or `material-cache.ts`.

## Background — relevant existing structures

- **`MaterialMap`** (`inventory.ts`): `Partial<Record<ItemComponentType, number>>` — the pool
  currency, and an item recipe's material cost.
- **Pool API** (`campaign.ts`, from ①): `canAfford(mats)` and `withdrawMaterials(mats)` (throws
  if short, deletes zeroed components). Crafting's item track calls these.
- **Keys** (`inventory.ts` / `character.ts`, from PR #13): `createKey({...})` builds a free,
  un-droppable key with a `keyCode`; the keyring is `inventory.keys`; `consumeKey(key)` spends
  one. Crafting's key track consumes held keys and produces a key via `createKey`.
- **`Item` / `IItem`** (`inventory.ts`): items already carry optional readonly key fields
  (`keyCode`, `consumeOnUse`); `teaches` is added the same way. The `Item` constructor takes a
  descriptor object.
- **Holder primitives** (`character.ts`): `receiveItem(item)` places + claims an item (keys →
  keyring, others → `items`) **without** recording an action; `hasRoomForItem()` is
  `items.length < slots`. `addToInventory` is the action-recording pickup entry point (fires
  `pickUp`, records one `pickUp`, ticks the budget).
- **`Campaign`** (`campaign.ts`): holds party-wide state; constructor is
  `constructor(title, maxRounds = 100)`. Already imports `MaterialMap` from `inventory.ts`.

## Design decisions (resolved)

| Decision | Choice |
| --- | --- |
| Recipe model | First-class `CraftingRecipe` objects (id, inputs, `create()` factory). |
| Input tracks | Item recipes cost **materials**; key recipes cost **keys**. Never mixed. |
| Recipe storage | Recipes **travel with** the teaching item / seed list; no central pre-registry. |
| Known recipes | Party-wide on `Campaign` (`#knownRecipes`), seeded at construction. |
| Discovery trigger | **Picking up** an item that carries `teaches` (plus a script primitive). |
| Recipe id | Author-chosen **branded** `RecipeId` (`Brand<string, "RecipeId">`), cast at the authoring boundary. |
| Craft action cost | **Free** — no budget tick, not recorded in history. |
| Output destination | The crafter's own inventory (keyring for keys, a slot for items). |
| Full inventory | Item-track craft throws if the crafter has no free slot. |
| Recipe-only items | Authoring pattern (blueprint teaches it, output never spawned). No flag. |
| Atomicity | Validate everything (known + affordable + slot/keys) **before** spending. |

## Detailed design

### 1. The `CraftingRecipe` type

New module `crafting.ts` (a small, focused file in the `material-cache.ts` / `status.ts`
mould):

```ts
/**
 * Author-chosen recipe identifier (semantic, like a key's code, but branded so a
 * stray `string` can't be passed where a recipe id is expected). Authors cast
 * their literal at the boundary: `"iron-sword" as RecipeId`.
 */
export type RecipeId = Brand<string, "RecipeId">;

/** A quantity of keys a key recipe consumes, matched by code. */
export type KeyCost = { keyCode: string; qty: number };

/**
 * A crafting recipe: an id, an input cost, and a factory for the output. Two
 * shapes, mirroring the engine's item/key split — `materials` recipes produce a
 * regular slotted item; `keys` recipes produce a (free) key.
 */
export type CraftingRecipe =
  | { id: RecipeId; materials: MaterialMap; create: () => IItem }
  | { id: RecipeId; keys: KeyCost[]; create: () => IItem };
```

`crafting.ts` imports `Brand` from `./brand` and `IItem` / `MaterialMap` from `inventory.ts`
**type-only**, so the inventory↔crafting reference (items carry `teaches?: CraftingRecipe`) is a
compile-time-only cycle — erased at runtime, no import loop. Craft logic discriminates with
`"materials" in recipe`.

### 2. Items can teach a recipe

In `inventory.ts`, add an optional readonly field to `IItem` and `Item` (exactly like the
existing `keyCode` / `consumeOnUse`):

```ts
/** A recipe this item imparts to the party when picked up. */
readonly teaches?: CraftingRecipe;
```

The `Item` constructor descriptor accepts and assigns `teaches`. Any item can carry it: a
normal craftable teaches its own recipe; a **blueprint** is just an item whose `teaches` points
at a recipe whose output the author never spawns.

### 3. Known recipes on `Campaign`

`Campaign` gains:

```ts
#knownRecipes: Map<RecipeId, CraftingRecipe>;   // seeded in the constructor

/** Read-only view of the recipes the party can currently craft. */
get knownRecipes(): ReadonlyMap<RecipeId, CraftingRecipe>;

/** Whether the party knows `recipeId`. */
knows(recipeId: RecipeId): boolean;

/**
 * Marks a recipe known to the whole party. Idempotent by id — the first
 * definition for an id wins; later calls with that id are ignored.
 */
discoverRecipe(recipe: CraftingRecipe): void;
```

The constructor gains an optional third parameter that seeds the map:

```ts
constructor(title: string, maxRounds: number = 100, knownRecipes: CraftingRecipe[] = []) {
  ...
  this.#knownRecipes = new Map();
  for (const recipe of knownRecipes) this.discoverRecipe(recipe);
}
```

`discoverRecipe` no-ops when `#knownRecipes.has(recipe.id)` (dedupe by id, like
`claimMaterials`). `knownRecipes` is exposed read-only (a `ReadonlyMap`); there is no setter.

### 4. Discovery on pickup

`Character.addToInventory` already receives each item and fires its `pickUp`. Extend it so that,
per item, **after** the pickup, a taught recipe is discovered:

```ts
if (current.teaches) {
  this.campaign.discoverRecipe(current.teaches);
}
```

Because `addToInventory` is the shared pickup path, this also fires when taking an item from a
loot box (`takeFromLootBox` → `addToInventory`). Discovery is party-wide because `#knownRecipes`
lives on the shared `Campaign`.

### 5. `Character.craft`

```ts
/** Crafts the output of a known recipe into this character's inventory. Free. */
craft(recipeId: RecipeId): IItem;
```

Algorithm (validate fully before mutating — all-or-nothing):

1. `const recipe = this.campaign.knownRecipes.get(recipeId);` — throw `ProceduralViolation`
   ("Cannot craft an undiscovered recipe") if absent.
2. **Item track** (`"materials" in recipe`):
   - throw if `!this.campaign.canAfford(recipe.materials)` ("Not enough materials to craft").
   - throw if `!this.hasRoomForItem()` ("No inventory slot for the crafted item").
   - `this.campaign.withdrawMaterials(recipe.materials);`
   - `const output = recipe.create(); this.receiveItem(output); return output;`
3. **Key track** (else):
   - For each `{ keyCode, qty }`, verify the keyring holds ≥ `qty` keys with that code; if any
     is short, throw ("Missing required keys to craft") **before** consuming anything.
   - Consume the matched keys (`consumeKey` on each).
   - `const output = recipe.create(); this.receiveItem(output); return output;` (a key →
     keyring, free).

`receiveItem` (not `addToInventory`) is used so crafting records **no** action and is free; the
crafted item's `pickUp` does not fire (crafting is not a pickup). The slot check for the item
track is done explicitly up front since `receiveItem` itself is unchecked.

## Public API surface (additions)

- `crafting.ts` *(new)*: `RecipeId`, `KeyCost`, `CraftingRecipe`.
- `inventory.ts`: `IItem.teaches?` / `Item.teaches?` (readonly) + constructor wiring.
- `campaign.ts`: `Campaign.knownRecipes` getter; `Campaign.knows`; `Campaign.discoverRecipe`;
  the constructor's `knownRecipes` seed parameter.
- `character.ts`: `Character.craft`; discovery wiring in `addToInventory`.

## Files touched

- **`crafting.ts`** *(new)* — `RecipeId`, `KeyCost`, `CraftingRecipe`.
- **`inventory.ts`** — `teaches` field on `IItem` / `Item` + constructor.
- **`campaign.ts`** — `#knownRecipes`, `knownRecipes` getter, `knows`, `discoverRecipe`,
  constructor seed parameter.
- **`character.ts`** — `craft`; `addToInventory` discovery wiring.
- **`scene.ts`, `history.ts`, `loot.ts`, `room.ts`, `material-cache.ts`** — **unchanged**.
- **Tests** — see below.

All new declarations carry TSDoc matching the surrounding codebase style.

## Testing

Vitest specs mirroring the existing style:

- **Recipe type / discovery primitive:** `discoverRecipe` makes `knows(id)` true; re-discovering
  the same id is a no-op (first definition wins); `knownRecipes` is read-only.
- **Constructor seeding:** `new Campaign(title, maxRounds, [recipe])` → `knows(recipe.id)`.
- **Pickup discovery:** picking up an item whose `teaches` is set makes the campaign know the
  recipe; taking it from a loot box does the same; an item with no `teaches` discovers nothing.
- **Craft — item track:** crafting a known materials-recipe withdraws exactly its materials and
  places the produced item in `inventory.items`; throws when undiscovered, when the pool can't
  afford it (pool unchanged), or when the inventory has no free slot (pool unchanged).
- **Craft — key track:** crafting a known key-recipe consumes the required held keys and places
  the produced key in the keyring (free); throws when the crafter is short a key, and consumes
  nothing in that case.
- **Free:** `craft` records no history entry and does not tick the action budget.
- **Recipe-only pattern:** a blueprint item (output never spawned) teaches a recipe on pickup;
  the party can then craft the output, which is otherwise unobtainable.

## Risks / edge cases

- **Type-only inventory↔crafting cycle:** `Item.teaches` references `CraftingRecipe`, which
  references `IItem`. Both imports are `type`-only and erased at runtime, so there is no module
  cycle. Keep them `type`-only.
- **`craft` bypasses `pickUp`/history by design:** using `receiveItem` keeps crafting free, but
  means the crafted item's `onPickUp` hook does not run. Intended — crafting is not a pickup. An
  author who needs setup-on-create should put it in the recipe's `create()` factory.
- **Recipe id collisions:** `discoverRecipe` dedupes by id, so two different recipe objects
  sharing an id will silently resolve to the first one seen. Ids are the author's namespace,
  like `keyCode`s.
- **Atomicity:** both tracks fully validate (known + affordable + slot / all keys present)
  before any spend, so a rejected craft leaves the pool, keyring, and inventory untouched.
- **Key-track partial-match selection:** when the keyring holds more keys of a code than the
  recipe needs, the engine consumes an arbitrary `qty` of them; which specific instances are
  spent is not author-controllable (matches how `consumeKey` already treats interchangeable
  keys).
