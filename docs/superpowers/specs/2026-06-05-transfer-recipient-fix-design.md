# Transfer Recipient Fix — Design

**Date:** 2026-06-05
**Status:** Approved, implementing

## Problem

`Item.actions.transfer` (in `src/lib/inventory.ts`) moves an item between
characters but does only two of the three things a move requires:

1. Removes the item from the sender (`holder.removeFromInventory(this)`). ✓
2. Re-points the item's `heldBy` to the recipient (`this.#heldBy = cc`). ✓
3. **Never adds the item to the recipient's `inventory.items`.** ✗

So after a transfer the item is in a contradictory state: `item.heldBy === cc`,
yet `cc.inventory.items` does not contain it. Anything that iterates the
recipient's inventory (capacity checks, the weapon scan in `attack`,
serialization) won't see it. Additionally, the raw `this.#heldBy = cc` write is
the one place that bypasses the `CLAIM` funnel every other holder change uses.

This behaviour predates the looting work; the unified `IItemHolder` model just
made it more visible (there is now a `receiveItem` primitive that is *the* way
an item should enter a holder, and transfer doesn't use it).

## Fix

Replace the raw re-point with `cc.receiveItem(this)`, and guard on the
recipient's capacity first so the operation is transactional.

```ts
[ItemAction.Transfer]: (_c, cc) => {
  const holder = this.#characterHolder();
  if (!holder) return;
  if (!cc.hasRoomForItem()) {
    throw new ProceduralViolation(
      "Attempted to transfer an item, but the recipient has no free inventory slots",
    );
  }
  actions[ItemAction.Transfer](holder, cc);
  events.onTransfer?.(holder, cc);
  holder.removeFromInventory(this);
  cc.receiveItem(this);
},
```

`receiveItem` both pushes the item into `cc.inventory.items` and re-points
`heldBy` through `CLAIM` — fixing the deposit gap and the `CLAIM` bypass in one
move.

## Decisions

- **Recipient full → throw `ProceduralViolation`.** Consistent with
  `addToInventory`'s overflow behaviour and the codebase's illegal-move pattern.
- **Transactional.** The capacity check runs before any mutation or event, so a
  full recipient leaves the sender's inventory, the item's `heldBy`, and the
  recipient untouched, and fires no `onTransfer`.
- **Action economy and events unchanged.** `holder.removeFromInventory(this)`
  still records exactly one action on the *sender*; `cc.receiveItem` is the
  low-level primitive (no recorded action, no `pickUp`), so the recipient is
  charged nothing and `onTransfer` remains the only event fired.

## Out of scope

- Transferring to self (`cc === holder`) is left as a harmless no-op-equivalent
  (remove then re-add); not special-cased.
- Best-effort/partial semantics do not apply — transfer moves a single item, so
  it either fits or throws.

## Testing

In the `transfer` block of `src/lib/inventory.test.ts`:

- Update the `makeHolder` mock to include `hasRoomForItem: vi.fn(() => true)`
  and `receiveItem: vi.fn()` (recipients now need the full holder surface).
- Rework the existing "moves the item" test to assert delegation:
  `holder.removeFromInventory` called with the item, `recipient.receiveItem`
  called with the item, and `actions.transfer`/`onTransfer` fired. (`heldBy`
  landing on the recipient is covered by `Character.receiveItem`'s own claim
  test.)
- Add a full-recipient test: `hasRoomForItem` → `false`; expect `transfer` to
  throw `ProceduralViolation` and that `removeFromInventory`, `receiveItem`,
  `actions.transfer`, and `onTransfer` were **not** called (transactional).
- Keep the existing "does nothing when the item is not held" test.

Both branches of the new capacity guard are exercised, keeping coverage at 100%.
