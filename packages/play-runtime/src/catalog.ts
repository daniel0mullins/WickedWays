/**
 * Registry → Rust `Catalog` JSON ({ items: { behaviorKey: ItemDescriptor },
 * aliases, behaviors }). The per-item body mirrors the conformance catalog
 * exporter byte-for-byte — the descriptor shape is what wickedways-core
 * deserializes.
 */
import type { CampaignRegistry } from "wickedways/lib/serialization/registry";
import type { Item } from "wickedways/lib/inventory";
import type { BehaviorScript } from "../../../generated/bindings/BehaviorScript.ts";

export function itemToCatalogEntry(item: Item): Record<string, unknown> {
  return {
    name: item.name,
    // type and slot must be lowercase strings — TS ItemType values are already lowercase
    type: item.type,
    stat: item.stat,
    modifier: item.modifier,
    properties: {
      equippable: item.properties.equippable,
      equipped: item.properties.equipped,
      destroyable: item.properties.destroyable,
      usable: item.properties.usable,
      // droppable: omit when absent (Rust skip_serializing_if = None)
      ...(item.properties.droppable !== undefined
        ? { droppable: item.properties.droppable }
        : {}),
    },
    // Optional descriptor fields — emit only when present
    ...(item.slot !== undefined ? { slot: item.slot } : {}),
    ...(item.twoHanded !== undefined ? { twoHanded: item.twoHanded } : {}),
    ...(item.emitsLight !== undefined ? { emitsLight: item.emitsLight } : {}),
    ...(item.maxDurability !== undefined ? { maxDurability: item.maxDurability } : {}),
    ...(item.lore !== undefined ? { lore: item.lore } : {}),
    ...(item.presentation !== undefined ? { presentation: item.presentation } : {}),
    ...(item.keyCode !== undefined ? { keyCode: item.keyCode } : {}),
    ...(item.consumeOnUse !== undefined ? { consumeOnUse: item.consumeOnUse } : {}),
    // ── Inert fields — REQUIRED in the Rust ItemDescriptor; always emit ──
    recipe: item.recipe,
    teaches: item.teaches ?? null,
    immunities: item.immunities ?? null,
    grantsImmunity: item.grantsImmunity ?? null,
  };
}

export function catalogFromRegistry(
  registry: CampaignRegistry,
  aliases: Record<string, string[]>,
  behaviors: Record<string, BehaviorScript> = {},
): { items: Record<string, unknown>; aliases: Record<string, string[]>; behaviors: Record<string, BehaviorScript> } {
  const items: Record<string, unknown> = {};
  for (const key of registry.itemKeys) {
    items[key] = itemToCatalogEntry(registry.item(key)());
  }
  return { items, aliases, behaviors };
}
