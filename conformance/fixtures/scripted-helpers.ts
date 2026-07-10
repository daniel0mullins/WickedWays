/**
 * Catalog exporter for the scripted-ops generators: identical to the
 * itemToCatalogEntry/buildCatalog pair in mechanics.gen.test.ts:125-167 (copied
 * verbatim from there), plus a `behaviors` slot so the Rust side can resolve
 * scripted keys from `Catalog.behaviors`.
 */
import type { Item } from "wickedways/lib/inventory";
import type { BehaviorScript } from "../../packages/campaigns/src/scripted/builders.ts";

export function itemToCatalogEntry(item: Item): Record<string, unknown> {
  return {
    name: item.name,
    type: item.type,
    stat: item.stat,
    modifier: item.modifier,
    properties: {
      equippable: item.properties.equippable,
      equipped: item.properties.equipped,
      destroyable: item.properties.destroyable,
      usable: item.properties.usable,
      ...(item.properties.droppable !== undefined
        ? { droppable: item.properties.droppable }
        : {}),
    },
    ...(item.slot !== undefined ? { slot: item.slot } : {}),
    ...(item.twoHanded !== undefined ? { twoHanded: item.twoHanded } : {}),
    ...(item.emitsLight !== undefined ? { emitsLight: item.emitsLight } : {}),
    ...(item.maxDurability !== undefined ? { maxDurability: item.maxDurability } : {}),
    ...(item.lore !== undefined ? { lore: item.lore } : {}),
    ...(item.presentation !== undefined ? { presentation: item.presentation } : {}),
    ...(item.keyCode !== undefined ? { keyCode: item.keyCode } : {}),
    ...(item.consumeOnUse !== undefined ? { consumeOnUse: item.consumeOnUse } : {}),
    recipe: item.recipe,
    teaches: item.teaches ?? null,
    immunities: item.immunities ?? null,
    grantsImmunity: item.grantsImmunity ?? null,
  };
}

export function buildCatalog(
  itemFactories: Record<string, () => Item>,
  itemKeys: string[],
  aliases: Record<string, string[]>,
  behaviors: Record<string, BehaviorScript>,
): { items: Record<string, unknown>; aliases: Record<string, string[]>;
     behaviors: Record<string, BehaviorScript> } {
  const items: Record<string, unknown> = {};
  for (const key of itemKeys) {
    items[key] = itemToCatalogEntry(itemFactories[key]!());
  }
  return { items, aliases, behaviors };
}
