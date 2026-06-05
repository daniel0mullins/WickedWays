# Looting Interaction — Design

**Date:** 2026-06-05
**Status:** Approved, pending implementation plan

## Overview

Replace the placeholder `PlayerCharacter.openLootBox` (which returns the loot
box's live `contents` array and charges an action just to look) with a complete
looting interaction model: a player can **look** inside a co-located loot box,
**take** items out of it, and **put** items back into it.

The change introduces a shared `IItemHolder` abstraction so that an item is
always held by exactly one holder — a character or a loot box — and looting is
simply moving holdership between the two.

## Goals

- Looking is read-only and free; it never mutates the box or costs an action.
- Taking/putting move items between a player's inventory and a loot box, keeping
  both collections and each item's `heldBy` consistent.
- An item is always held by exactly one `IItemHolder` (or `null` before it is
  ever placed).
- Looting only works on a loot box in the player's current room.

## Locked Decisions

| Decision | Choice |
| --- | --- |
| Operations | look (read-only), take one, take many/all, put back |
| Action economy | One action per call; looking is free |
| Zero items moved | Costs no action (a no-op, like looking) |
| Partial failure (take/put can't fit all) | Best-effort: move what fits in request order, leave the rest, return what moved |
| Holder model | Unified `IItemHolder` interface implemented by `Character` and `Loot` |
| Co-location | look, take, and put all require the box to be in the player's current room |

## Architecture

### `IItemHolder` (defined in `inventory.ts`, beside `IItem`)

```ts
export interface IItemHolder {
  readonly holderKind: "character" | "loot";
  hasRoomForItem(): boolean;
  receiveItem(item: IItem): void;     // add to own collection + claim as holder
  relinquishItem(item: IItem): void;  // remove from own collection
}
```

- `Character implements IItemHolder`
  - `holderKind = "character"`
  - `hasRoomForItem()` → `inventory.items.length < inventory.slots`
  - `receiveItem` / `relinquishItem` manage `inventory.items`
- `Loot implements IItemHolder`
  - `holderKind = "loot"`
  - `hasRoomForItem()` → `contents.length < capacity`
  - `receiveItem` / `relinquishItem` manage `contents`

A move is always **relinquish from the old holder, then receive into the new
holder**. Because `heldBy` is no longer character-specific, `inventory.ts` drops
its current `import type { ICharacter }` (used only for the old `heldBy` type).

### `heldBy` becomes the holder

`Item`'s `#heldBy` widens from `ICharacter | null` to `IItemHolder | null`.

- `receiveItem` is the **only** path that re-points an item's `heldBy`. It does
  so through a symbol-keyed "claim" on `Item`, mirroring the existing
  `Symbol.for("heldBy")` getter idiom, so external code still cannot assign
  `heldBy` directly (the public `set heldBy` continues to throw).
- `Loot` claims its initial `contents` at construction and any item passed to
  `stowItem`, so a boxed item is always `heldBy` the box.

### Layering: low-level vs. high-level

`receiveItem` / `relinquishItem` are **low-level**: they manage only the
collection and `heldBy`. They fire **no events** and record **no actions**.

The higher-level methods own action-economy and gameplay events, and are
refactored to sit on top of the holder primitives:

- `Character.addToInventory` / `removeFromInventory` keep their current
  behavior (one action per call; `addToInventory` fires `pickUp`) but are
  implemented in terms of `receiveItem` / `relinquishItem`.
- `Item.actions.pickUp` **no longer sets `heldBy`** (the receiving holder does);
  it remains the gameplay/event hook (`pickUp` action + `onPickUp` event).
- `Item.actions.transfer` / `use` call `this.#heldBy.relinquishItem(this)`
  instead of `removeFromInventory`.

## Public API (on `PlayerCharacter`)

```ts
openLootBox(box: ILoot): readonly IItem[]
takeFromLootBox(box: ILoot, item: IItem | IItem[]): IItem[]
putInLootBox(box: ILoot, item: IItem | IItem[]): IItem[]
```

### `openLootBox` — look

1. Require co-location (see below); throw `ProceduralViolation` otherwise.
2. Return a **shallow copy** of `box.contents` typed `readonly IItem[]`.
   - Callers cannot add/remove from the box through it; the item objects
     themselves remain inspectable.
3. Records **no** action.

### `takeFromLootBox` — take (best-effort)

1. Require co-location; throw `ProceduralViolation` otherwise.
2. Normalize the argument to an array; keep only items actually in the box
   (matched by `id`).
3. `free = inventory.slots − inventory.items.length`; `toTake =
   present.slice(0, free)` in request order.
4. For each item in `toTake`: `box.relinquishItem(item)` then
   `this.receiveItem(item)`, and fire the item's `pickUp` gameplay hook.
5. If at least one item moved, record **one** action; if none moved, record
   none.
6. Return the items that moved.

"Take all" is `takeFromLootBox(box, [...box.contents])` — no separate method.

### `putInLootBox` — put back (best-effort)

1. Require co-location; throw `ProceduralViolation` otherwise.
2. Normalize to an array; keep only items actually in the player's inventory.
3. `free = box.capacity − box.contents.length`; `toPut = present.slice(0,
   free)`.
4. For each item in `toPut`: `this.relinquishItem(item)` then
   `box.receiveItem(item)`. No `pickUp` (the item is being stowed, not grabbed).
5. If at least one item moved, record **one** action; otherwise none.
6. Return the items that moved.

### Co-location check

A box is co-located when it is registered in the player's current room:

```ts
this.currentRoom?.loot.has(box.id) === true
```

If the player has no current room, or the box is not in it, the operation
throws `ProceduralViolation`. Applies to `look`, `take`, and `put`.

### Character-only item actions

`equip`, `unequip`, `use`, and `transfer` are meaningful only while a character
holds the item. Each guards on `this.#heldBy?.holderKind === "character"` and
no-ops otherwise (in addition to the existing "is held at all" guard).

## Behavior Changes / Blast Radius

- `openLootBox` stops recording an action and returns a `readonly` view instead
  of the live array. Existing tests that assert it is recordable / counts as an
  action are updated or removed.
- `Item.actions.pickUp` no longer mutates `heldBy`.
- `Item`'s `heldBy` type widens to `IItemHolder | null`.
- `Character` and `Loot` gain the `IItemHolder` surface.
- The co-location guard can make a flow throw where it previously would not, if
  a box is not in the player's room.

## Out of Scope

- No "take all" convenience method (the array form covers it).
- No quantity/stacking semantics — items are discrete objects.
- No holder-to-holder generalization of `transfer` beyond character→character.

## Testing Plan

- `IItemHolder` conformance for both `Character` and `Loot`
  (`hasRoomForItem`, `receiveItem`, `relinquishItem`, `holderKind`).
- `look`: returns a view that cannot mutate the box; costs no action; throws
  when the box is not co-located.
- `take`: single item; take-all best-effort capped by free slots; into a full
  inventory moves nothing and costs no action; an item not in the box is
  skipped; fires `pickUp`; records exactly one action when items move.
- `put`: single item; best-effort capped by box capacity; into a full box moves
  nothing and costs no action; an item not held is skipped; does **not** fire
  `pickUp`; records exactly one action when items move.
- `heldBy` flips correctly between character and box across take/put, and boxed
  items report the box as holder from construction.
- Character-only actions (`equip`/`use`/`transfer`) no-op while the item is
  box-held.
- Co-location: take/put/look all throw `ProceduralViolation` for a box in
  another room or when the player has no room.
