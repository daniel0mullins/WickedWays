import { Item, ItemType, createKey } from "wickedways/lib/inventory";
import { StatType } from "wickedways/lib/character/stats";
import { ADJUST_STAT } from "wickedways/lib/mechanics/symbols";
import { SlotKind } from "wickedways/lib/equipment";
import { Items, Keys } from "./ids.js";
import { JOURNAL_LORE } from "./content.js";

const noop = () => {};

export const lantern = (): Item =>
  new Item({
    descriptor: { behaviorKey: Items.Lantern, name: "Brass Lantern", type: ItemType.Weapon, recipe: { item: 1 }, modifier: 0, stat: StatType.Health, slot: SlotKind.Hand, emitsLight: true },
    properties: { equippable: true, equipped: false, destroyable: true, usable: false },
    actions: { pickUp: noop, equip: noop, unequip: noop, transfer: noop, use: noop, destroy: () => null },
    events: { onPickUp: noop },
  });

export const journal = (): Item =>
  new Item({
    descriptor: { behaviorKey: Items.Journal, name: "Water-Stained Journal", type: ItemType.Consumable, recipe: { item: 1 }, modifier: 0, stat: StatType.Health, lore: JOURNAL_LORE },
    // The journal is the win item (carry it to the attic) — it must not be dropped.
    properties: { equippable: false, equipped: false, destroyable: true, usable: false, droppable: false },
    actions: { pickUp: noop, equip: noop, unequip: noop, transfer: noop, use: noop, destroy: () => null },
    events: { onPickUp: noop },
  });

export const poker = (): Item =>
  new Item({
    descriptor: { behaviorKey: Items.Poker, name: "Iron Fire-Poker", type: ItemType.Weapon, recipe: { metal: 1 }, modifier: 5, stat: StatType.Health, slot: SlotKind.Hand, maxDurability: 8 },
    properties: { equippable: true, equipped: false, destroyable: true, usable: false },
    actions: { pickUp: noop, equip: noop, unequip: noop, transfer: noop, use: noop, destroy: () => null },
    events: { onPickUp: noop },
  });

export const laudanum = (): Item =>
  new Item({
    descriptor: { behaviorKey: Items.Laudanum, name: "Vial of Laudanum", type: ItemType.Consumable, recipe: { healing: 1 }, modifier: 6, stat: StatType.Sanity },
    properties: { equippable: false, equipped: false, destroyable: true, usable: true },
    actions: {
      pickUp: noop, equip: noop, unequip: noop, transfer: noop,
      // The engine consumes a usable item but never auto-applies its modifier/stat,
      // so the heal lives here. `this` is the vial, so the descriptor stays the
      // single source of truth; the stat seam floors at 0 (no upper cap).
      use(holder) { holder[ADJUST_STAT](this.stat, this.modifier); },
      destroy: () => null,
    },
    events: { onPickUp: noop },
  });

export const ratTail = (): Item =>
  new Item({
    descriptor: { behaviorKey: Items.RatTail, name: "Rat Tail", type: ItemType.Consumable, recipe: { item: 1 }, modifier: 1, stat: StatType.Sanity },
    // A grisly little tonic: usable consumable (NOT equippable, NOT a key), so it
    // is a legal formation drop (the encounter-table key-drop guard passes). As
    // with laudanum, the engine consumes the item but never auto-applies its
    // modifier/stat, so the +1 Sanity heal lives in `use` (oracle for ratTailScript).
    properties: { equippable: false, equipped: false, destroyable: true, usable: true },
    actions: {
      pickUp: noop, equip: noop, unequip: noop, transfer: noop,
      use(holder) { holder[ADJUST_STAT](this.stat, this.modifier); },
      destroy: () => null,
    },
    events: { onPickUp: noop },
  });

export const brassKey = (): Item => createKey({ name: "Brass Key", keyCode: "brass", consumeOnUse: false });
export const ironKey = (): Item => createKey({ name: "Iron Key", keyCode: "iron", consumeOnUse: false });

export const ITEM_FACTORIES: Record<string, () => Item> = {
  [Items.Lantern]: lantern,
  [Items.Journal]: journal,
  [Items.Poker]: poker,
  [Items.Laudanum]: laudanum,
  [Items.RatTail]: ratTail,
  [Keys.Brass]: brassKey,
  [Keys.Iron]: ironKey,
};
