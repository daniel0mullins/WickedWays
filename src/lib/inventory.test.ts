import { describe, expect, it, vi } from "vitest";

import type { ICharacter } from "./character/character";
import { StatType } from "./character/stats";
import { SlotKind } from "./equipment";
import { CLAIM, CONSUME_VIA_USE, DEPOSIT_MATERIALS, EQUIP, GRANT_IMMUNITY, Item, SET_DURABILITY, UNEQUIP, createKey, type IItem, type IItemHolder, type ItemProperties } from "./inventory";
import { ProceduralViolation } from "./util";
import type { CraftingRecipe, RecipeId } from "./crafting";
import type { Presentation } from "./presentation";
import { HYDRATE } from "./serialization/symbols";

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
    status: [],
    [GRANT_IMMUNITY]: vi.fn(),
    [CONSUME_VIA_USE]: vi.fn(),
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

function makeItem(propsOverride: Partial<ItemProperties> = {}) {
  const actions = makeActions();
  const events = makeEvents();
  const properties: ItemProperties = {
    equippable: true,
    equipped: false,
    destroyable: true,
    usable: true,
    ...propsOverride,
  };
  const item = new Item({
    descriptor: { type: "weapon", recipe: { metal: 1 }, modifier: 2, stat: StatType.Health, name: "Rusty Sword" },
    properties: properties,
    actions: actions,
    events: events,
  });
  return { item, actions, events, properties };
}

function makeDurable(maxDurability?: number, durability?: number) {
  return new Item({
    descriptor: {
      type: "weapon",
      recipe: { metal: 1 },
      modifier: 2,
      stat: StatType.Health,
      name: "Sword",
      maxDurability,
      durability,
    },
    properties: { equippable: true, equipped: false, destroyable: true, usable: true },
    actions: makeActions(),
    events: makeEvents(),
  });
}

describe("durability", () => {
  it("defaults current durability to maxDurability when not authored", () => {
    const item = makeDurable(10);
    expect(item.maxDurability).toBe(10);
    expect(item.durability).toBe(10);
    expect(item.isBroken).toBe(false);
  });

  it("honors an authored starting durability", () => {
    expect(makeDurable(10, 4).durability).toBe(4);
  });

  it("clamps an authored durability into [0, maxDurability]", () => {
    expect(makeDurable(10, 99).durability).toBe(10);
    expect(makeDurable(10, -5).durability).toBe(0);
  });

  it("is broken when durability reaches 0", () => {
    const item = makeDurable(10, 0);
    expect(item.isBroken).toBe(true);
  });

  it("has no durability when maxDurability is omitted", () => {
    const item = makeDurable();
    expect(item.maxDurability).toBeUndefined();
    expect(item.durability).toBeUndefined();
    expect(item.isBroken).toBe(false);
  });

  it("clamps the privileged setter to [0, maxDurability]", () => {
    const item = makeDurable(5);
    item[SET_DURABILITY](3);
    expect(item.durability).toBe(3);
    item[SET_DURABILITY](-2);
    expect(item.durability).toBe(0);
    item[SET_DURABILITY](99);
    expect(item.durability).toBe(5);
  });

  it("is a no-op setter on an item with no durability", () => {
    const item = makeDurable();
    item[SET_DURABILITY](3);
    expect(item.durability).toBeUndefined();
  });

  it("leaves keys without durability", () => {
    const key = createKey({ name: "Brass Key", keyCode: "brass", consumeOnUse: false });
    expect(key.maxDurability).toBeUndefined();
    expect(key.durability).toBeUndefined();
    expect(key.isBroken).toBe(false);
  });
});

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

  describe("presentation", () => {
    it("exposes supplied presentation and is undefined when omitted", () => {
      const pres: Presentation = { image: "sword.png" };
      const withPres = new Item({
        descriptor: { type: "weapon", recipe: { metal: 1 }, modifier: 2, stat: StatType.Health, name: "Rusty Sword", presentation: pres },
        properties: { equippable: true, equipped: false, destroyable: true, usable: true },
        actions: makeActions(),
        events: makeEvents(),
      });
      const without = new Item({
        descriptor: { type: "weapon", recipe: { metal: 1 }, modifier: 2, stat: StatType.Health, name: "Plain Sword" },
        properties: { equippable: true, equipped: false, destroyable: true, usable: true },
        actions: makeActions(),
        events: makeEvents(),
      });
      expect(withPres.presentation).toBe(pres);
      expect(without.presentation).toBeUndefined();
    });
  });

  it("exposes emitsLight when set, and leaves it undefined otherwise", () => {
    const noop = () => {};
    const torch = new Item({
      descriptor: {
        type: "weapon",
        recipe: { item: 1 },
        modifier: 0,
        stat: StatType.Health,
        name: "Torch",
        slot: SlotKind.Hand,
        emitsLight: true,
      },
      properties: { equippable: true, equipped: false, destroyable: true, usable: false },
      actions: { pickUp: noop, equip: noop, unequip: noop, transfer: noop, use: noop, destroy: () => null },
      events: { onPickUp: noop },
    });
    const rock = new Item({
      descriptor: { type: "weapon", recipe: { item: 1 }, modifier: 0, stat: StatType.Health, name: "Rock" },
      properties: { equippable: false, equipped: false, destroyable: true, usable: false },
      actions: { pickUp: noop, equip: noop, unequip: noop, transfer: noop, use: noop, destroy: () => null },
      events: { onPickUp: noop },
    });

    expect(torch.emitsLight).toBe(true);
    expect(rock.emitsLight).toBeUndefined();
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

  describe("equip seam", () => {
    it("EQUIP runs the behavior, toggles equipped, and fires onEquip", () => {
      const { item, actions, events } = makeItem();
      const holder = makeHolder();

      item[EQUIP](holder);

      expect(item.properties.equipped).toBe(true);
      expect(actions.equip).toHaveBeenCalledWith(holder);
      expect(events.onEquip).toHaveBeenCalledWith(holder);
    });

    it("UNEQUIP runs the behavior, clears equipped, and fires onUnequip", () => {
      const { item, actions, events } = makeItem();
      const holder = makeHolder();
      item[EQUIP](holder);

      item[UNEQUIP](holder);

      expect(item.properties.equipped).toBe(false);
      expect(actions.unequip).toHaveBeenCalledWith(holder);
      expect(events.onUnequip).toHaveBeenCalledWith(holder);
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
      expect(holder[CONSUME_VIA_USE]).toHaveBeenCalledWith(item);
    });

    it("runs author behaviors with `this` bound to the item (so a behavior can read its own item)", () => {
      const holder = makeHolder();
      const seen: Record<string, unknown> = {};
      const item = new Item({
        descriptor: { type: "consumable", recipe: { healing: 1 }, modifier: 4, stat: StatType.Sanity, name: "Tonic" },
        properties: { equippable: false, equipped: false, destroyable: true, usable: true },
        actions: {
          pickUp() { seen.pickUp = this; },
          equip: () => {}, unequip: () => {}, transfer: () => {},
          use() { seen.use = this; },
          destroy: () => null,
        },
        events: { onPickUp: () => {} },
      });
      hold(item, holder);

      item.actions.pickUp(holder);
      item.actions.use(holder);

      expect(seen.pickUp).toBe(item);
      expect(seen.use).toBe(item);
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
      const item = new Item({
        descriptor: {
          name: "Test Item",
          type: "consumable",
          recipe: { food: 1 },
          modifier: 0,
          stat: StatType.Health,
        },
        properties: { equippable: true, equipped: false, destroyable: false, usable: true },
        actions: actions,
        events: { onPickUp },
      });
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

describe("equipment slots", () => {
  it("exposes an authored slot kind and twoHanded flag", () => {
    const item = new Item({
      descriptor: {
        type: "weapon",
        recipe: { metal: 1 },
        modifier: 3,
        stat: StatType.Health,
        name: "Greatsword",
        slot: "hand",
        twoHanded: true,
      },
      properties: { equippable: true, equipped: false, destroyable: true, usable: false },
      actions: makeActions(),
      events: makeEvents(),
    });

    expect(item.slot).toBe("hand");
    expect(item.twoHanded).toBe(true);
  });

  it("leaves slot and twoHanded undefined when not authored", () => {
    const item = new Item({
      descriptor: {
        type: "consumable",
        recipe: { healing: 1 },
        modifier: 0,
        stat: StatType.Health,
        name: "Potion",
      },
      properties: { equippable: false, equipped: false, destroyable: true, usable: true },
      actions: makeActions(),
      events: makeEvents(),
    });

    expect(item.slot).toBeUndefined();
    expect(item.twoHanded).toBeUndefined();
  });

  it("accepts the accessory item type", () => {
    const ring = new Item({
      descriptor: {
        type: "accessory",
        recipe: { metal: 1 },
        modifier: 2,
        stat: StatType.Sanity,
        name: "Ring of Calm",
        slot: "finger",
      },
      properties: { equippable: true, equipped: false, destroyable: true, usable: false },
      actions: makeActions(),
      events: makeEvents(),
    });

    expect(ring.type).toBe("accessory");
    expect(ring.slot).toBe("finger");
  });
});

describe("teaches", () => {
  const recipe: CraftingRecipe = {
    id: "iron-sword" as RecipeId,
    materials: { metal: 1 },
    create: () => ({ name: "Iron Sword" }) as unknown as IItem,
  };

  it("exposes the recipe an item teaches", () => {
    const item = new Item({
      descriptor: {
        type: "weapon",
        recipe: { metal: 1 },
        modifier: 1,
        stat: StatType.Health,
        name: "Blueprint",
        teaches: recipe,
      },
      properties: { equippable: false, equipped: false, destroyable: true, usable: false },
      actions: makeActions(),
      events: makeEvents(),
    });

    expect(item.teaches).toBe(recipe);
  });

  it("defaults teaches to undefined", () => {
    expect(makeItem().item.teaches).toBeUndefined();
  });
});

it("Item[HYDRATE] updates durability and modifier in place, preserving identity", () => {
  const item = makeDurable(10, 10);
  item.behaviorKey = "items/sword";
  item.modifier = 0;
  const before = item;
  item[HYDRATE]({ kind: "item", id: item.id, behaviorKey: "items/sword", durability: 3, modifier: 2 });
  expect(item).toBe(before);            // same instance
  expect(item.durability).toBe(3);
  expect(item.modifier).toBe(2);
  // idempotent
  item[HYDRATE]({ kind: "item", id: item.id, behaviorKey: "items/sword", durability: 3, modifier: 2 });
  expect(item.durability).toBe(3);
});

describe("item lore + read", () => {
  const noop = () => {};

  it("exposes descriptor lore, or undefined when unset", () => {
    const withLore = new Item({
      descriptor: { type: "consumable", recipe: { item: 1 }, modifier: 0, stat: StatType.Health, name: "Journal", lore: "Once, the orchard bloomed." },
      properties: { equippable: false, equipped: false, destroyable: true, usable: false },
      actions: { pickUp: noop, equip: noop, unequip: noop, transfer: noop, use: noop, destroy: () => null },
      events: { onPickUp: noop },
    });
    expect(withLore.lore).toBe("Once, the orchard bloomed.");
    expect(makeItem().item.lore).toBeUndefined();
  });

  it("read runs the author read action and fires onRead, without consuming", () => {
    const read = vi.fn();
    const onRead = vi.fn();
    const item = new Item({
      descriptor: { type: "consumable", recipe: { item: 1 }, modifier: 0, stat: StatType.Health, name: "Journal", lore: "..." },
      properties: { equippable: false, equipped: false, destroyable: true, usable: false },
      actions: { pickUp: noop, equip: noop, unequip: noop, transfer: noop, use: noop, destroy: () => null, read },
      events: { onPickUp: noop, onRead },
    });
    const holder = makeHolder();
    hold(item, holder);

    item.actions.read?.(holder);

    expect(read).toHaveBeenCalledTimes(1);
    expect(onRead).toHaveBeenCalledTimes(1);
    expect((holder as unknown as { [CONSUME_VIA_USE]: ReturnType<typeof vi.fn> })[CONSUME_VIA_USE]).not.toHaveBeenCalled();
  });
});
