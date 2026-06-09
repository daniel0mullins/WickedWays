# Key Items — Design

**Date:** 2026-06-09
**Status:** Approved (pending implementation plan)

## Summary

Add the concept of **key items** to Wicked Ways: specially designated story-progression
items that are stored "for free" (they never occupy an inventory slot), cannot be
destroyed, and can only move between characters by direct transfer (never dropped on the
ground or stowed in a loot box).

Keys progress the story by **hooking into the existing scene precondition system**. A key's
gameplay effect is not a built-in subsystem; it is whatever a scene author writes. A
precondition checks whether a key is present among a room's occupants, and the scene's own
script decides what that unlocks (open an exit, reveal loot, fire a story beat, etc.). The
engine ships the key item and the minimal public surface authors need — nothing more.

## Goals

- A key is a first-class, distinct kind of item.
- Keys are stored free: holding any number of keys never consumes an inventory slot and
  never blocks a normal pickup.
- Keys cannot be destroyed (no destroy-for-components).
- Keys are transfer-only: handed between characters, never dropped, never put in loot boxes.
- Keys integrate with scene preconditions so authors can gate scenes on key possession.
- Each key declares whether using it consumes it (`consumeOnUse`); the engine provides a
  sanctioned consumption path, and authors decide when to invoke it.

## Non-Goals

- No locked-exit subsystem, no changes to `Character.move`, no enforcement of exit
  traversal. "Locked doors" are author-written scenes, not an engine feature.
- No higher-level convenience helpers (`requiresKey`, `consumeKey` sugar, `keyGatedDoor`,
  etc.). Gating logic is left entirely to scene authors, composed from the public API.
- No changes to `room.ts`, `scene.ts`, or `history.ts`.

## Background — relevant existing structures

- **Inventory** (`inventory.ts`): `Inventory = { slots: number; items: IItem[] }`. Room is
  computed as `items.length < slots` in `Character.hasRoomForItem`
  (`character.ts:181-183`); `addToInventory` throws when full.
- **Item destruction** (`inventory.ts:272-278`): the `Destroy` action wrapper currently
  ignores `properties.destroyable` — destruction is not actually gated by the flag today.
- **Holders** (`inventory.ts`): `IItemHolder` exposes `hasRoomForItem` / `receiveItem` /
  `relinquishItem`. Items track their holder behind the `HELD_BY` symbol and are re-pointed
  only via the `CLAIM` symbol.
- **Transfer** (`inventory.ts:250-264`): the generic `Item.actions.transfer` moves an item
  by calling `holder.removeFromInventory(this)` (which records a `drop`) then
  `recipient.receiveItem(this)`.
- **Loot** (`loot.ts`): a separate holder; items can be stowed via `Loot.receiveItem` /
  `stowItem`, and `PlayerCharacter.putInLootBox` is the player-facing entry point.
- **Scenes** (`scene.ts:5-26`): `PreconditionFn = (r: IRoom) => boolean`; a scene fires on
  enter/exit only when `preconditions.every(fn => fn(room))` holds. Preconditions receive
  only the room and are expected to be side-effect-free (they may be evaluated more than
  once and for multiple scenes).
- **Rooms** (`room.ts`): `enterRoom` adds the character to `occupants` **before** playing
  `"enter"` scenes, so an entering character is visible to that scene's preconditions via
  `room.occupants`.

## Design decisions (resolved)

| Decision | Choice |
| --- | --- |
| How a key is designated | A distinct `ItemType` value `"key"` (not an orthogonal flag). |
| Storage model | Approach A — a dedicated `keys` compartment on the `Inventory` object, parallel to `items`. |
| Mobility | Transfer between characters only; no drop, no loot box. |
| Use semantics | Per-key `consumeOnUse` flag decides whether use removes the key. |
| Gating mechanism | Scene preconditions, via the existing `(room) => boolean` signature. No new subsystem. |
| Precondition subject | Possession by **any occupant** of the room satisfies a key check (fits the room-only signature; no change to `scene.ts`). |
| Consumption timing | Side-effect-free preconditions only *check*; consumption is an explicit step the author runs from a scene script via `Character.consumeKey`. |
| Build scope | Primitives only. No `requiresKey`/`consumeKey` sugar, no door convenience. |

## Detailed design

### 1. The key as an `ItemType`

In `inventory.ts`:

- Add `Key: "key"` to the `ItemType` const map.
- Add two optional, readonly key-specific fields to `IItem` / `Item`, populated only for
  keys:
  - `keyCode?: string` — the shared code a scene precondition matches on.
  - `consumeOnUse?: boolean` — whether the engine's consumption path removes the key.
- Add a `createKey` factory that centralizes the invariants:

  ```ts
  createKey({ name, keyCode, consumeOnUse }: {
    name: string;
    keyCode: string;
    consumeOnUse: boolean;
  }): Item
  ```

  It constructs an `Item` with `type: "key"`, `properties` of
  `{ equippable: false, equipped: false, destroyable: false, usable: false }`, a trivial
  recipe, `modifier: 0`, and the two key fields set. "A key cannot be destroyed" is
  therefore guaranteed at construction rather than left to the caller.

### 2. Enforce `destroyable`

The `Destroy` action wrapper (`inventory.ts:272-278`) is changed to **return `null` (no-op)
when `properties.destroyable` is false**, before invoking the supplied destroy behavior.
Keys are `destroyable: false`, so destroying one does nothing. This also retroactively makes
the existing flag meaningful for ordinary items; it is in scope because the key guarantee
depends on it.

### 3. The keyring (Approach A)

Extend the inventory shape:

```ts
export type Inventory = { slots: number; items: IItem[]; keys: IItem[] };
```

All routing lives inside the holder (`Character`):

- `receiveItem(item)` — pushes to `keys` when `item.type === "key"`, else to `items`; claims
  ownership via `CLAIM` as before.
- `relinquishItem(item)` — removes the item from whichever compartment currently holds it.
- `hasRoomForItem()` — **unchanged**; it concerns only `items`, so keys never occupy a slot
  and never block a normal pickup.
- `addToInventory(item | items)` — per item: a key bypasses the slot check and lands in the
  keyring; a non-key keeps the existing slot-checked path that throws when full. Still
  records a single `pickUp`. This doubles as the **grant path**: because keys cannot live in
  loot boxes, a scene script or NPC reward gives a character a key by calling
  `addToInventory(key)`.

The `keys` array is publicly readable through the existing `inventory` getter, which is the
surface scene authors use to write key preconditions.

### 4. Mobility — transfer-only

Guards are placed where each illegal move would occur:

- **Cannot be dropped:** `removeFromInventory` (the recorded `drop` action) throws
  `ProceduralViolation` when handed a key.
- **Cannot be stowed in loot:** `Loot.receiveItem` and `PlayerCharacter.putInLootBox` reject
  keys with `ProceduralViolation`.
- **Can be transferred between characters:** a dedicated
  `Character.transferKey(key, recipient)` moves the key keyring → keyring (`relinquish` on
  the giver, `receiveItem` on the recipient) and records a `pickUp` on the recipient. Keys
  deliberately do **not** use the generic `Item.actions.transfer` path — that path routes
  through `removeFromInventory`, which now rejects keys, so a stray generic transfer fails
  loudly and points the author at `transferKey`.

### 5. Gating via scene preconditions

No engine subsystem. With the public surface above, an author writes a key gate as an
ordinary scene precondition:

```ts
preconditions: [
  (room) => room.occupants.some(c =>
    c.inventory.keys.some(k => k.keyCode === "vault")),
]
```

The scene's `script` then performs whatever the key unlocks (e.g. `room.addExit(...)`, reveal
loot, advance a story flag). The engine has no opinion about what a key does.

### 6. Sanctioned consumption path

Because `removeFromInventory` rejects keys, authors cannot remove a spent key with the
existing API. Add a public method:

```ts
Character.consumeKey(key: IItem): void
```

It removes the key from the keyring and clears its holder (`CLAIM(null)`). This is the
deliberate exception to "keys are un-droppable": gating logic may spend a one-shot key, while
the player still cannot toss it. `consumeOnUse` remains a readable hint on the key that an
author's script consults before deciding to call `consumeKey`; the engine does not act on the
flag automatically.

## Public API surface (additions)

- `ItemType.Key` (`"key"`).
- `IItem.keyCode?: string`, `IItem.consumeOnUse?: boolean`.
- `createKey(descriptor): Item`.
- `Inventory.keys: IItem[]`.
- `Character.transferKey(key, recipient): void`.
- `Character.consumeKey(key): void`.

## Files touched

- **`inventory.ts`** — `ItemType.Key`; `keyCode` / `consumeOnUse` fields; `createKey`
  factory; `Destroy` wrapper honors `destroyable`; `Inventory.keys`; receive/relinquish
  routing; `removeFromInventory` rejects keys.
- **`character.ts`** — keyring initialization; `addToInventory` routing; `transferKey`;
  `consumeKey`.
- **`loot.ts`** — reject keys in `receiveItem` (and any stow path).
- **`player-character.ts`** — reject keys in `putInLootBox`.
- **`room.ts`, `scene.ts`, `history.ts`** — **unchanged**.
- **Tests** — see below.

All new declarations carry TSDoc matching the surrounding codebase style.

## Testing

Vitest specs mirroring the existing test style:

- **Key creation:** `createKey` yields `type: "key"`, `destroyable: false`, and the supplied
  `keyCode` / `consumeOnUse`.
- **Free storage:** filling `items` to `slots` still permits adding multiple keys; a normal
  pickup still throws when `items` is full, while key grants never throw.
- **Destroy guard:** destroying a key is a no-op / returns `null`; an ordinary
  `destroyable: false` item likewise cannot be destroyed.
- **Mobility:** dropping a key throws; stowing a key in a loot box throws; `transferKey`
  moves a key between keyrings and records a recipient `pickUp`.
- **Gating:** a scene with an occupant-key precondition does not fire without the key and
  fires once an occupant holds it.
- **Consumption:** `consumeKey` removes the key from the keyring and clears its holder; a
  subsequent precondition check no longer passes.

## Risks / edge cases

- **`destroyable` behavior change** affects any existing item created with
  `destroyable: false` that previously could still be destroyed. Audit existing tests for
  reliance on the old (unenforced) behavior.
- **Generic transfer of a key** now fails via the drop guard rather than silently working;
  this is intended, but any existing code calling `item.actions.transfer` on a key must move
  to `transferKey`.
- **Multiple occupants holding the same key code:** an author's precondition is satisfied by
  any one of them; `consumeKey` operates on a specific key instance the author selects, so
  there is no ambiguity in the engine — selection is the author's responsibility.
