import { describe, expect, it, vi } from "vitest";

import type { ICharacter } from "./character/character";
import { StatType } from "./character/stats";
import { Item } from "./inventory";
import { ProceduralViolation } from "./util";

// `ItemActions`/`ItemEvents`/`ItemProperties` are not exported, so we recover
// the shapes the constructor expects straight from its parameter list.
type ItemPropsArg = ConstructorParameters<typeof Item>[1];
type ItemActionsArg = ConstructorParameters<typeof Item>[2];
type ItemEventsArg = ConstructorParameters<typeof Item>[3];

// `HELD_BY` lives in the global symbol registry, so the test can read the
// private holder through the same key the class exposes it under.
const HELD_BY = Symbol.for("heldBy");
function heldBy(item: Item): ICharacter | null {
  return (item as unknown as Record<symbol, ICharacter | null>)[HELD_BY] ?? null;
}

function makeHolder(): ICharacter {
  return { removeFromInventory: vi.fn() } as unknown as ICharacter;
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
    { type: "weapon", recipe: { metal: 1 }, modifier: 2, stat: StatType.Health },
    properties,
    actions as unknown as ItemActionsArg,
    events as unknown as ItemEventsArg,
  );
  return { item, actions, events, properties };
}

describe("Item", () => {
  describe("constructor", () => {
    it("assigns an id and the provided descriptor fields", () => {
      const { item } = makeItem();

      expect(typeof item.id).toBe("string");
      expect(item.id.length).toBeGreaterThan(0);
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
    it("records the holder and fires the underlying action and event", () => {
      const { item, actions, events } = makeItem();
      const holder = makeHolder();

      item.actions.pickUp(holder);

      expect(heldBy(item)).toBe(holder);
      expect(actions.pickUp).toHaveBeenCalledWith(holder);
      expect(events.onPickUp).toHaveBeenCalledWith(holder);
    });
  });

  describe("equip", () => {
    it("equips a held item and fires the action and event", () => {
      const { item, actions, events } = makeItem();
      const holder = makeHolder();
      item.actions.pickUp(holder);

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
      item.actions.pickUp(holder);
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
      item.actions.pickUp(holder);

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
    it("moves the item from the holder to the recipient", () => {
      const { item, actions, events } = makeItem();
      const holder = makeHolder();
      const recipient = makeHolder();
      item.actions.pickUp(holder);

      item.actions.transfer(holder, recipient);

      expect(actions.transfer).toHaveBeenCalledWith(holder, recipient);
      expect(events.onTransfer).toHaveBeenCalledWith(holder, recipient);
      expect(holder.removeFromInventory).toHaveBeenCalledWith(item);
      expect(heldBy(item)).toBe(recipient);
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
      item.actions.pickUp(holder);
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

  describe("optional events", () => {
    it("works when only the required onPickUp event is supplied", () => {
      const actions = makeActions();
      const onPickUp = vi.fn();
      const item = new Item(
        {
          type: "consumable",
          recipe: { food: 1 },
          modifier: 0,
          stat: StatType.Health,
        },
        { equippable: true, equipped: false, destroyable: false, usable: true },
        actions as unknown as ItemActionsArg,
        { onPickUp } as unknown as ItemEventsArg,
      );
      const holder = makeHolder();

      item.actions.pickUp(holder);
      expect(onPickUp).toHaveBeenCalledWith(holder);

      // No onEquip handler was provided, yet equipping must not throw.
      expect(() => item.actions.equip(holder)).not.toThrow();
      expect(item.properties.equipped).toBe(true);
      expect(actions.equip).toHaveBeenCalledWith(holder);
    });
  });
});
