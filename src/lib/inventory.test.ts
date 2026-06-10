import { describe, expect, it, vi } from "vitest";

import type { ICharacter } from "./character/character";
import { StatType } from "./character/stats";
import { CLAIM, DEPOSIT_MATERIALS, Item, createKey, type IItemHolder } from "./inventory";
import { ProceduralViolation } from "./util";

// `ItemProperties` is not exported, so we recover the shape the constructor
// expects straight from its parameter list.
type ItemPropsArg = ConstructorParameters<typeof Item>[1];

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
  (
    item as unknown as {
      [CLAIM]: (h: IItemHolder | null) => void;
    }
  )[CLAIM](holder);
}

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

function makeActions() {
  return {
    pickUp: vi.fn(),
    equip: vi.fn(),
    unequip: vi.fn(),
    transfer: vi.fn(),
    use: vi.fn(),
    destroy: vi.fn(),
  };
}

function makeEvents() {
  return {
    onPickUp: vi.fn(),
    onEquip: vi.fn(),
    onUnequip: vi.fn(),
    onUse: vi.fn(),
    onTransfer: vi.fn(),
    onDestroy: vi.fn(),
  };
}

function makeItem(propsOverride: Partial<ItemPropsArg> = {}) {
  const actions = makeActions();
  const events = makeEvents();
  const properties: ItemPropsArg = {
    equippable: true,
    equipped: false,
    destroyable: true,
    usable: true,
    ...propsOverride,
  };
  const item = new Item(
    { type: "weapon", recipe: { metal: 1 }, modifier: 2, stat: StatType.Health, name: "Rusty Sword" },
    properties,
    actions,
    events,
  );
  return { item, actions, events, properties };
}

describe("Item", () => {
  describe("constructor", () => {
    it("assigns an id and the provided descriptor fields", () => {
      const { item } = makeItem();

      expect(typeof item.id).toBe("string");
      expect(item.id.length).toBeGreaterThan(0);
      expect(item.name).toBe("Rusty Sword");
      expect(item.type).toBe("weapon");
      expect(item.recipe).toEqual({ metal: 1 });
      expect(item.modifier).toBe(2);
      expect(item.stat).toBe(StatType.Health);
    });

    it("starts unheld", () => {
      expect(heldBy(makeItem().item)).toBeNull();
    });

    it("throws when heldBy is set directly", () => {
      const { item } = makeItem();

      expect(() => {
        (item as unknown as { heldBy: ICharacter | null }).heldBy = makeHolder();
      }).toThrow(ProceduralViolation);
    });
  });

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

  describe("equip", () => {
    it("equips a held item and fires the action and event", () => {
      const { item, actions, events } = makeItem();
      const holder = makeHolder();
      hold(item, holder);

      item.actions.equip(holder);

      expect(item.properties.equipped).toBe(true);
      expect(actions.equip).toHaveBeenCalledWith(holder);
      expect(events.onEquip).toHaveBeenCalledWith(holder);
    });

    it("does nothing when the item is not held", () => {
      const { item, actions, events } = makeItem();

      item.actions.equip(makeHolder());

      expect(item.properties.equipped).toBe(false);
      expect(actions.equip).not.toHaveBeenCalled();
      expect(events.onEquip).not.toHaveBeenCalled();
    });
  });

  describe("unequip", () => {
    it("unequips a held item and fires the action and event", () => {
      const { item, actions, events } = makeItem();
      const holder = makeHolder();
      hold(item, holder);
      item.actions.equip(holder);

      item.actions.unequip(holder);

      expect(item.properties.equipped).toBe(false);
      expect(actions.unequip).toHaveBeenCalledWith(holder);
      expect(events.onUnequip).toHaveBeenCalledWith(holder);
    });

    it("does nothing when the item is not held", () => {
      const { item, actions } = makeItem();

      item.actions.unequip(makeHolder());

      expect(actions.unequip).not.toHaveBeenCalled();
    });
  });

  describe("use", () => {
    it("fires the action and event then removes the item from the holder", () => {
      const { item, actions, events } = makeItem();
      const holder = makeHolder();
      hold(item, holder);

      item.actions.use(holder);

      expect(actions.use).toHaveBeenCalledWith(holder);
      expect(events.onUse).toHaveBeenCalledWith(holder);
      expect(holder.removeFromInventory).toHaveBeenCalledWith(item);
    });

    it("does nothing when the item is not held", () => {
      const { item, actions } = makeItem();

      item.actions.use(makeHolder());

      expect(actions.use).not.toHaveBeenCalled();
    });
  });

  describe("transfer", () => {
    it("removes the item from the sender and deposits it into the recipient", () => {
      const { item, actions, events } = makeItem();
      const holder = makeHolder();
      const recipient = makeHolder();
      hold(item, holder);

      item.actions.transfer(holder, recipient);

      expect(actions.transfer).toHaveBeenCalledWith(holder, recipient);
      expect(events.onTransfer).toHaveBeenCalledWith(holder, recipient);
      expect(holder.removeFromInventory).toHaveBeenCalledWith(item);
      // The recipient claims the item via its own receiveItem (which re-points
      // heldBy through CLAIM); transfer no longer writes heldBy directly.
      expect(recipient.receiveItem).toHaveBeenCalledWith(item);
    });

    it("throws and changes nothing when the recipient has no room", () => {
      const { item, actions, events } = makeItem();
      const holder = makeHolder();
      const recipient = makeHolder();
      (recipient.hasRoomForItem as ReturnType<typeof vi.fn>).mockReturnValue(
        false,
      );
      hold(item, holder);

      expect(() => item.actions.transfer(holder, recipient)).toThrow(
        ProceduralViolation,
      );
      expect(holder.removeFromInventory).not.toHaveBeenCalled();
      expect(recipient.receiveItem).not.toHaveBeenCalled();
      expect(actions.transfer).not.toHaveBeenCalled();
      expect(events.onTransfer).not.toHaveBeenCalled();
    });

    it("does nothing when the item is not held", () => {
      const { item, actions } = makeItem();
      const recipient = makeHolder();

      item.actions.transfer(makeHolder(), recipient);

      expect(actions.transfer).not.toHaveBeenCalled();
      expect(heldBy(item)).toBeNull();
    });
  });

  describe("destroy", () => {
    it("returns the components and forwards them to the event when held", () => {
      const { item, actions, events } = makeItem();
      const holder = makeHolder();
      hold(item, holder);
      const components = ["metal", "glass"];
      actions.destroy.mockReturnValue(components);

      const result = item.actions.destroy();

      expect(result).toBe(components);
      expect(actions.destroy).toHaveBeenCalledOnce();
      expect(events.onDestroy).toHaveBeenCalledWith(holder, components);
    });

    it("returns null and skips the action when not held", () => {
      const { item, actions, events } = makeItem();

      expect(item.actions.destroy()).toBeNull();
      expect(actions.destroy).not.toHaveBeenCalled();
      expect(events.onDestroy).not.toHaveBeenCalled();
    });
  });

  describe("destroy guard (destroyable=false)", () => {
    it("returns null and skips the action for a non-destroyable item", () => {
      const { item, actions, events } = makeItem({ destroyable: false });
      const holder = makeHolder();
      hold(item, holder);

      expect(item.actions.destroy()).toBeNull();
      expect(actions.destroy).not.toHaveBeenCalled();
      expect(events.onDestroy).not.toHaveBeenCalled();
    });
  });

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

      // A destroyed item must leave the inventory and be unhomed — not linger as
      // a ghost. Removal is silent (relinquish, not removeFromInventory): no
      // "drop" log and no action cost, since destroying is free and not a drop.
      expect(holder.relinquishItem).toHaveBeenCalledWith(item);
      expect(holder.removeFromInventory).not.toHaveBeenCalled();
      expect(heldBy(item)).toBeNull();
    });
  });

  describe("optional events", () => {
    it("works when only the required onPickUp event is supplied", () => {
      const actions = makeActions();
      const onPickUp = vi.fn();
      const item = new Item(
        {
          name: "Test Item",
          type: "consumable",
          recipe: { food: 1 },
          modifier: 0,
          stat: StatType.Health,
        },
        { equippable: true, equipped: false, destroyable: false, usable: true },
        actions,
        { onPickUp },
      );
      const holder = makeHolder();

      item.actions.pickUp(holder);
      expect(onPickUp).toHaveBeenCalledWith(holder);
      hold(item, holder);

      // No onEquip handler was provided, yet equipping must not throw.
      expect(() => item.actions.equip(holder)).not.toThrow();
      expect(item.properties.equipped).toBe(true);
      expect(actions.equip).toHaveBeenCalledWith(holder);
    });
  });
});

describe("createKey", () => {
  it("creates a key item with its code, consume flag, and no-destroy", () => {
    const key = createKey({
      name: "Vault Key",
      keyCode: "vault",
      consumeOnUse: false,
    });

    expect(key.type).toBe("key");
    expect(key.name).toBe("Vault Key");
    expect(key.keyCode).toBe("vault");
    expect(key.consumeOnUse).toBe(false);
    expect(key.properties.destroyable).toBe(false);
  });

  it("cannot be destroyed even when held by a character", () => {
    const key = createKey({ name: "Vault Key", keyCode: "vault", consumeOnUse: true });
    hold(key, makeHolder());

    expect(key.actions.destroy()).toBeNull();
  });
});
