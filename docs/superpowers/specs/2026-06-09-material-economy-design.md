# Material Economy — Design

**Date:** 2026-06-09
**Status:** Approved (pending implementation plan)

## Context — the larger crafting effort

This is **sub-project ① of three** that together make up the crafting feature. The
three pieces share one substrate (raw materials) but are otherwise independent and
separately shippable:

1. **Material economy** *(this spec)* — a party-wide material pool, the ways
   materials flow into it, and the pool API the other two consume.
2. **Crafting** *(later spec)* — keys → higher-tier keys (free → free) and raw
   materials → regular items (pool → a slotted item), plus party-wide recipe
   discovery and the craft action model.
3. **Durability & repair** *(later spec)* — a `broken` attribute and wear-and-tear
   on items, with repair spending pool materials.

Sub-projects ② and ③ both **spend** materials by calling this pool's `withdraw` /
`canAfford`. This spec delivers the pool and its inflows only; it does **not**
implement any spending, crafting, or durability behavior.

## Summary

Add a **party-wide raw-material pool** to Wicked Ways. Raw materials are the existing
`ItemComponentType` values (`metal`, `glass`, `electronics`, `healing`, `food`,
`item`). They are stored "for free" — they never occupy an inventory slot — and they
belong to the whole party rather than to any one character. Materials flow in from two
sources: **destroying an item** (which deposits the item's own `recipe`) and
**harvesting a material cache** found in the world. A symbol-keyed internal deposit and
a single-use cache + claim-id model make grants **once-only**, so players cannot farm
materials by repeating a scene or re-harvesting a pile.

## Goals

- A single party-wide pool of raw materials, living on `Campaign`, readable by any
  member and mutated only through a controlled API.
- Materials never occupy an inventory slot (they are pooled quantities, not items).
- Destroying an item deposits its `recipe` materials into the pool. `recipe` becomes
  the single source of truth for both scrap-yield and (later) craft-cost.
- Materials can also be granted directly from the world: single-use **material
  caches** placed in rooms, harvested by a co-located character.
- Anti-farming is enforced by the engine, not by author discipline: every grant path
  is once-only.
- A spend/affordability API (`withdrawMaterials` / `canAfford`) for sub-projects ② and
  ③ to call. (This spec defines them; it does not call them.)

## Non-Goals

- No crafting, no recipe discovery (sub-project ②).
- No broken state, wear-and-tear, or repair (sub-project ③).
- No per-character material stores. Materials are exclusively party-wide.
- No material-respawn / regeneration. A depleted cache stays depleted; a claimed grant
  stays claimed. "Once" means once for the whole campaign.
- No changes to how `modifier` / item effectiveness work.

## Background — relevant existing structures

- **`ItemComponentType`** (`inventory.ts:23-32`): `metal | glass | electronics |
  healing | food | item`. The vocabulary of raw materials.
- **`Recipe`** (`inventory.ts:35-37`): `RequireAtLeastOne<{ [k in ItemComponentType]:
  number }>` — an item's material makeup. Already present on every `IItem` as
  `recipe`. Today it is used only descriptively; this spec makes it the deposit a
  destroyed item yields.
- **`Item.Destroy` wrapper** (`inventory.ts:287-295`): already honors
  `properties.destroyable` and already has the destroying `holder` (a character) in
  scope. Today its yield (`ItemComponentType[] | null`) is returned to the caller and
  discarded. This spec routes the yield into the party pool instead.
- **`CLAIM` / `HELD_BY` symbols** (`inventory.ts:122-130`): the codebase's established
  pattern for exposing an engine-internal mutation while keeping it off the public API
  (the public setter throws). The internal material deposit follows the same pattern.
- **`Campaign`** (`campaign.ts`): owns `party: IPlayerCharacter[]` and the round
  counter. The natural home for party-wide state. Characters reach it via
  `Character.campaign` (`character.ts:118-120`).
- **`Room` / `Loot`** (`room.ts`, `loot.ts`): rooms hold loot containers in
  `loot: Map<LootId, ILoot>`. Material caches mirror this with a parallel
  `materials: Map<MaterialCacheId, MaterialCache>`.
- **Action budget** (`character.ts:261-273`): `recordAction` ticks the per-round
  counter only when the calling fn is registered in `isActionMap`. Material-economy
  actions are deliberately **free** — they are not registered, so they never tick the
  budget.

## Design decisions (resolved)

| Decision | Choice |
| --- | --- |
| Pool ownership | Party-wide, on `Campaign`. No per-character stores. |
| Material vocabulary | The existing `ItemComponentType` values; no new component kinds. |
| Storage shape | Pooled quantities (`Partial<Record<ItemComponentType, number>>`), never inventory items. |
| Destroy → pool | Destroying an item deposits its own `recipe` quantities. `recipe` is the single source of truth. |
| World grants | Single-use `MaterialCache` entities placed in rooms, harvested by a co-located character. |
| Script grants | `claimMaterials(claimId, mats)` — idempotent by `claimId`; repeats are ignored. |
| Raw deposit visibility | Internal only, via a symbol-keyed method. No public "just add materials" call. |
| Anti-farming | Engine-enforced: caches deplete (idempotent harvest); claims dedupe by id. |
| Action cost | Harvesting and destroying are both **free** (not budgeted actions). |

## Detailed design

### 1. The material map type

In `inventory.ts`, alongside `Recipe`:

```ts
/** A quantity of raw materials by component type; the currency of the party pool. */
export type MaterialMap = Partial<Record<ItemComponentType, number>>;
```

`Recipe` (`RequireAtLeastOne<…>`) is assignable to `MaterialMap`, so an item's
`recipe` can be deposited directly.

### 2. The internal deposit symbol

In `inventory.ts`, alongside `CLAIM` / `HELD_BY`:

```ts
/**
 * Symbol-keyed method that adds raw materials to the party pool.
 *
 * Raw deposits are funnelled through this symbol so external/author code cannot
 * mint materials at will (which would defeat anti-farming). Only engine internals
 * — the Item Destroy wrapper, Character.harvest, and Campaign.claimMaterials —
 * call it. There is no public "add materials" method.
 */
export const DEPOSIT_MATERIALS = Symbol("depositMaterials");
```

It is defined in `inventory.ts` (not `campaign.ts`) to keep it importable by `Item`
without a circular dependency, matching where `CLAIM` lives.

### 3. The pool on `Campaign`

`Campaign` gains:

```ts
#materials: MaterialMap;          // pooled quantities, starts {}
#claims: Set<string>;             // claim ids already granted

/** Read-only view of the party's raw-material pool. */
get materials(): Readonly<MaterialMap>;

/** Engine-internal raw deposit (adds quantities). See {@link DEPOSIT_MATERIALS}. */
[DEPOSIT_MATERIALS](mats: MaterialMap): void;

/**
 * Grants materials once per claimId. The first call with a given id deposits and
 * records the id; later calls with the same id are ignored. The farm-proof public
 * grant for scene/quest scripts that have no physical cache.
 */
claimMaterials(claimId: string, mats: MaterialMap): void;

/** Removes materials from the pool. @throws ProceduralViolation if the pool is short. */
withdrawMaterials(mats: MaterialMap): void;

/** Whether the pool currently holds at least `mats`. */
canAfford(mats: MaterialMap): boolean;
```

- `[DEPOSIT_MATERIALS]` sums each component into `#materials`.
- `claimMaterials` is a no-op when `#claims.has(claimId)`; otherwise it records the id
  and calls `[DEPOSIT_MATERIALS]`.
- `canAfford` returns `true` iff every component in `mats` is present in `#materials`
  at ≥ the requested quantity.
- `withdrawMaterials` throws `ProceduralViolation` if `!canAfford(mats)`; otherwise it
  subtracts, deleting entries that reach 0. **Defined here for ② and ③; not called in
  this spec.**

The setter for `materials` throws (mirroring `Room.occupants` / `Item.heldBy`) so the
pool cannot be replaced wholesale.

### 4. Destroy → pool

The `Item.Destroy` wrapper (`inventory.ts:287-295`) is extended so that, when an item
is actually destroyed (it is held by a character and is `destroyable`), it deposits its
`recipe` into the party pool before returning:

```ts
[ItemAction.Destroy]: () => {
  const holder = this.#characterHolder();
  if (!holder) return null;
  if (!this.properties.destroyable) return null;
  const components = actions[ItemAction.Destroy]();
  holder.campaign[DEPOSIT_MATERIALS](this.recipe);   // <- new: yield -> party pool
  events.onDestroy?.(holder, components);
  return components;
},
```

`holder` is an `ICharacter`, which exposes `campaign`. Destroy stays **free** (it does
not route through `recordAction`, unchanged from today). Destroying is not a farm
vector: it consumes the item, and later crafting that item will cost at least its
`recipe`, so a destroy/craft loop is net-neutral at best.

### 5. Material caches

A lightweight, single-use world entity. New file `material-cache.ts` (mirroring the
small, focused modules already in `lib`):

```ts
export type MaterialCacheId = Brand<string, "MaterialCacheId">;

export interface IMaterialCache {
  id: MaterialCacheId;
  /** Whether this cache has already been harvested. */
  get depleted(): boolean;
  /** The materials still available to harvest ({} once depleted). */
  get contents(): Readonly<MaterialMap>;
  /**
   * Empties the cache, returning what it held. Idempotent: a depleted cache
   * returns {} and changes nothing. For Character.harvest internals only.
   */
  [DEPLETE](): MaterialMap;
}
```

- Constructed with a `MaterialMap` of contents; `depleted` starts `false`.
- `[DEPLETE]()` (symbol-keyed, like `CLAIM`) returns the contents and flips `depleted`
  to `true`; a second call returns `{}`. This makes harvest idempotent and keeps the
  state transition off the public API.

Rooms hold caches parallel to loot. `IRoom` / `Room` gain:

```ts
/** Material caches present in the room, keyed by id. */
materials: Map<MaterialCacheId, IMaterialCache>;
```

populated from a new constructor argument (defaulting to empty), exactly as `loot` is.

### 6. Harvesting

`Character` gains:

```ts
/**
 * Harvests a material cache in the character's current room into the party pool.
 * Idempotent: harvesting an already-depleted cache deposits nothing. Free — does
 * not consume a budgeted action.
 *
 * @throws ProceduralViolation if the cache is not in the character's current room.
 */
harvest(cache: IMaterialCache): void;
```

Behavior:
1. Co-location check: the cache must be in `this.currentRoom?.materials`, else
   `ProceduralViolation` (mirrors `PlayerCharacter.putInLootBox`'s `#requireCoLocated`).
2. `const got = cache[DEPLETE]();` — `{}` if already harvested.
3. `this.campaign[DEPOSIT_MATERIALS](got);`
4. No `recordAction` call — harvesting is free.

A depleted cache is left in the room (it simply yields nothing further); a re-firing
scene that calls `harvest` again is therefore safe with no author guard. Authors who
want a scene to fire only while a cache is full can still gate on `!cache.depleted`,
mirroring the key-items precondition idiom.

## Public API surface (additions)

- `inventory.ts`: `MaterialMap`; `DEPOSIT_MATERIALS` symbol.
- `campaign.ts`: `Campaign.materials` getter; `Campaign[DEPOSIT_MATERIALS]`;
  `Campaign.claimMaterials`; `Campaign.withdrawMaterials`; `Campaign.canAfford`.
- `material-cache.ts` *(new)*: `MaterialCacheId`, `IMaterialCache`, `MaterialCache`,
  `DEPLETE` symbol.
- `room.ts`: `Room.materials` map + constructor argument.
- `character.ts`: `Character.harvest`.

## Files touched

- **`inventory.ts`** — `MaterialMap` type; `DEPOSIT_MATERIALS` symbol; `Item.Destroy`
  wrapper deposits `recipe`.
- **`campaign.ts`** — pool field + claims set; `materials` getter/throwing setter;
  `[DEPOSIT_MATERIALS]`; `claimMaterials`; `withdrawMaterials`; `canAfford`.
- **`material-cache.ts`** *(new)* — `MaterialCache` + `DEPLETE` symbol.
- **`room.ts`** — `materials` map and constructor wiring.
- **`character.ts`** — `harvest`.
- **`scene.ts`, `history.ts`, `loot.ts`, `player-character.ts`** — **unchanged**.
- **Tests** — see below.

All new declarations carry TSDoc matching the surrounding codebase style.

## Testing

Vitest specs mirroring the existing style:

- **Pool basics:** a new campaign's `materials` is empty; `[DEPOSIT_MATERIALS]` sums
  quantities across multiple deposits; the `materials` setter throws.
- **Affordability / withdraw:** `canAfford` is true only when every component meets the
  requested quantity; `withdrawMaterials` subtracts and removes zeroed entries;
  withdrawing more than the pool holds throws `ProceduralViolation` and leaves the pool
  unchanged.
- **Claim dedupe:** `claimMaterials("x", …)` deposits once; a second call with `"x"` is
  ignored; a different id deposits again.
- **Destroy → pool:** destroying a `destroyable` item deposits exactly its `recipe`
  into its campaign's pool; destroying a non-destroyable item (e.g. a key) deposits
  nothing; a box-held item's destroy is still a no-op and deposits nothing.
- **Cache harvest:** harvesting a cache in the character's room deposits its contents
  and marks it depleted; a second harvest deposits nothing (idempotent); harvesting a
  cache not in the current room throws `ProceduralViolation`.
- **Free actions:** neither `harvest` nor destroy advances the per-round action budget
  (no extra `pickUp`/budget tick recorded).

## Risks / edge cases

- **`Item` importing from `campaign`:** avoided by defining `DEPOSIT_MATERIALS` in
  `inventory.ts`; `Item` only calls `holder.campaign[DEPOSIT_MATERIALS](…)` through the
  already-imported `ICharacter` type.
- **Destroy yield semantics change:** the old `ItemComponentType[]` return is preserved
  for existing callers; the pool deposit is additive and uses `recipe`. Audit any test
  asserting the old discarded-yield behavior.
- **Claim-id collisions:** two unrelated grants sharing a `claimId` means the second is
  silently skipped. Claim ids are the author's responsibility to keep unique, the same
  way scene/precondition keys are.
- **Depleted caches linger in the room:** intentional — keeps harvest idempotent and
  lets scenes gate on `!cache.depleted`. They can be removed by authors if desired (no
  engine removal path is added here).
