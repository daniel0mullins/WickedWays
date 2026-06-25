import { Item, ItemType, createKey, type ItemDescriptor } from "wickedways/lib/inventory";
import { StatType } from "wickedways/lib/character/stats";
import { SlotKind } from "wickedways/lib/equipment";
import { Items, Keys } from "./ids.js";

const noop = () => {};

export function makeItem(
  descriptor: ItemDescriptor,
  props: { equippable?: boolean; usable?: boolean } = {},
): Item {
  return new Item({
    descriptor,
    properties: { equippable: props.equippable ?? false, equipped: false, destroyable: true, usable: props.usable ?? false },
    actions: { pickUp: noop, equip: noop, unequip: noop, transfer: noop, use: noop, destroy: () => null },
    events: { onPickUp: noop },
  });
}

export const lantern = (): Item =>
  makeItem(
    { behaviorKey: Items.Lantern, name: "Brass Lantern", type: ItemType.Weapon, recipe: { item: 1 }, modifier: 0, stat: StatType.Health, slot: SlotKind.Hand, emitsLight: true },
    { equippable: true },
  );

export const journal = (): Item =>
  makeItem({ behaviorKey: Items.Journal, name: "Water-Stained Journal", type: ItemType.Consumable, recipe: { item: 1 }, modifier: 0, stat: StatType.Health });

export const poker = (): Item =>
  makeItem(
    { behaviorKey: Items.Poker, name: "Iron Fire-Poker", type: ItemType.Weapon, recipe: { metal: 1 }, modifier: 5, stat: StatType.Health, slot: SlotKind.Hand, maxDurability: 8 },
    { equippable: true },
  );

export const laudanum = (): Item =>
  makeItem({ behaviorKey: Items.Laudanum, name: "Vial of Laudanum", type: ItemType.Consumable, recipe: { healing: 1 }, modifier: 6, stat: StatType.Sanity }, { usable: true });

export const brassKey = (): Item => createKey({ name: "Brass Key", keyCode: "brass", consumeOnUse: false });
export const ironKey = (): Item => createKey({ name: "Iron Key", keyCode: "iron", consumeOnUse: false });

export const ITEM_FACTORIES: Record<string, () => Item> = {
  [Items.Lantern]: lantern,
  [Items.Journal]: journal,
  [Items.Poker]: poker,
  [Items.Laudanum]: laudanum,
  [Keys.Brass]: brassKey,
  [Keys.Iron]: ironKey,
};
