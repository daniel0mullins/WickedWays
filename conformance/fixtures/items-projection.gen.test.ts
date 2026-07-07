/**
 * Items-projection golden generator — run once to write the committed fixture files.
 *
 * Uses a bespoke inline campaign (NOT the shared seed or hollow-house campaigns)
 * with a weapon, accessory, usable consumable, key, and loot container.
 * The active PC (Ada) holds all four item types in inventory, with the accessory
 * equipped. Ben (inactive) is also present.
 *
 * Writes:
 *   - items-projection.start.snapshot.json   (serialized genesis state)
 *   - items-projection.catalog.json          ({ items, aliases } Rust Catalog shape)
 *   - items-projection.golden.json           ({ view: <3a ViewModel projected subset> })
 *
 * Run via:
 *   pnpm run fixtures:gen
 *
 * The main test:conformance gate excludes conformance/fixtures/** so this
 * generator never runs as part of the replay gate.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it } from "vitest";
import { authorTemplate } from "wickedways/lib/authoring/template-builder";
import { defineRegistry } from "wickedways/lib/authoring/registry";
import { startSession } from "wickedways/lib/authoring/orchestration";
import { serializeCampaign } from "wickedways/lib/serialization/serializer";
import { Item, ItemType, createKey } from "wickedways/lib/inventory";
import type { ItemId } from "wickedways/lib/inventory";
import { StatType } from "wickedways/lib/character/stats";
import { SlotKind } from "wickedways/lib/equipment";
import { Directions } from "wickedways/lib/room";
import { viewProjected } from "./gen-helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));

// ─── Item behavior keys ───────────────────────────────────────────────────────

const SWORD_KEY = "items/iron-sword";
const RING_KEY = "items/silver-ring";
const TONIC_KEY = "items/healing-tonic";
const CHEST_ITEM_KEY = "items/old-coin";

// ─── Aliases for the catalog ──────────────────────────────────────────────────

const ALIASES: Record<string, string[]> = {
  [SWORD_KEY]: ["sword", "iron sword", "blade"],
  [RING_KEY]: ["ring", "silver ring", "band"],
  [TONIC_KEY]: ["tonic", "healing tonic", "vial"],
  [CHEST_ITEM_KEY]: ["coin", "old coin"],
};

// ─── Item factories ───────────────────────────────────────────────────────────

const noop = () => {};

/**
 * A weapon: equippable (hand slot), has lore, has maxDurability, droppable absent (→ true).
 */
function makeIronSword(): Item {
  return new Item({
    descriptor: {
      behaviorKey: SWORD_KEY,
      name: "Iron Sword",
      type: ItemType.Weapon,
      recipe: { metal: 2 },
      modifier: 5,
      stat: StatType.Health,
      slot: SlotKind.Hand,
      maxDurability: 10,
      lore: "A well-worn blade, its edge still keen.",
    },
    properties: { equippable: true, equipped: false, destroyable: true, usable: false },
    actions: { pickUp: noop, equip: noop, unequip: noop, transfer: noop, use: noop, destroy: () => null },
    events: { onPickUp: noop },
  });
}

/**
 * An accessory: equippable (finger slot), has a stat modifier (Sanity +3).
 * This one gets equipped on the PC so equippedNames is non-empty.
 */
function makeSilverRing(): Item {
  return new Item({
    descriptor: {
      behaviorKey: RING_KEY,
      name: "Silver Ring",
      type: ItemType.Accessory,
      recipe: { metal: 1 },
      modifier: 3,
      stat: StatType.Sanity,
      slot: SlotKind.Finger,
    },
    properties: { equippable: true, equipped: false, destroyable: true, usable: false },
    actions: { pickUp: noop, equip: noop, unequip: noop, transfer: noop, use: noop, destroy: () => null },
    events: { onPickUp: noop },
  });
}

/**
 * A usable consumable: not equippable, usable:true, heals 4 health.
 */
function makeHealingTonic(): Item {
  return new Item({
    descriptor: {
      behaviorKey: TONIC_KEY,
      name: "Healing Tonic",
      type: ItemType.Consumable,
      recipe: { healing: 1 },
      modifier: 4,
      stat: StatType.Health,
    },
    properties: { equippable: false, equipped: false, destroyable: true, usable: true },
    actions: { pickUp: noop, equip: noop, unequip: noop, transfer: noop, use: noop, destroy: () => null },
    events: { onPickUp: noop },
  });
}

/**
 * A loot container item (old coin, placed in the chest).
 */
function makeOldCoin(): Item {
  return new Item({
    descriptor: {
      behaviorKey: CHEST_ITEM_KEY,
      name: "Old Coin",
      type: ItemType.Consumable,
      recipe: { item: 1 },
      modifier: 0,
      stat: StatType.Health,
    },
    properties: { equippable: false, equipped: false, destroyable: true, usable: false },
    actions: { pickUp: noop, equip: noop, unequip: noop, transfer: noop, use: noop, destroy: () => null },
    events: { onPickUp: noop },
  });
}

// ─── Registry ─────────────────────────────────────────────────────────────────

function buildItemRegistry() {
  return defineRegistry({
    items: {
      [SWORD_KEY]: makeIronSword,
      [RING_KEY]: makeSilverRing,
      [TONIC_KEY]: makeHealingTonic,
      [CHEST_ITEM_KEY]: makeOldCoin,
    },
  });
}

// ─── Catalog exporter ─────────────────────────────────────────────────────────

/**
 * Builds the catalog entry for one item in the Rust ItemDescriptor JSON shape.
 * All four inert fields (recipe, teaches, immunities, grantsImmunity) are always
 * emitted so Rust deserialization does not fail on missing required fields.
 */
function itemToCatalogEntry(item: Item): Record<string, unknown> {
  return {
    name: item.name,
    // type and slot must be lowercase strings — TS ItemType values are already lowercase
    type: item.type as string,
    stat: item.stat as string,
    modifier: item.modifier,
    properties: {
      equippable: item.properties.equippable,
      equipped: item.properties.equipped,
      destroyable: item.properties.destroyable,
      usable: item.properties.usable,
      // droppable: omit when absent (Rust skips_serializing_if = None)
      ...(item.properties.droppable !== undefined
        ? { droppable: item.properties.droppable }
        : {}),
    },
    // Optional descriptor fields — emit only when present
    ...(item.slot !== undefined ? { slot: item.slot as string } : {}),
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

/**
 * Instantiates every registered item factory and serializes to the Rust Catalog shape.
 * Returns { items: { behaviorKey: descriptor }, aliases: { behaviorKey: [...] } }.
 */
function buildCatalog(
  registry: ReturnType<typeof buildItemRegistry>,
  itemKeys: string[],
  aliases: Record<string, string[]>,
): { items: Record<string, unknown>; aliases: Record<string, string[]> } {
  const items: Record<string, unknown> = {};
  for (const key of itemKeys) {
    const factory = registry.item(key);
    const instance = factory();
    items[key] = itemToCatalogEntry(instance);
  }
  return { items, aliases };
}

// ─── Bespoke campaign builder ─────────────────────────────────────────────────

function buildItemsCampaign() {
  const registry = buildItemRegistry();

  const template = authorTemplate("Item Test (conformance)", registry, {
    rng: () => 0.5,
    maxRounds: 5,
    now: () => 0,
  })
    // Archetype: enough inventory slots (5 is default, but we need 3 items + key)
    // inventorySlots is a delta on base capacity (5). We add +1 = 6 total for comfort.
    .archetype({ id: "delver", name: "Delver", baseStats: { [StatType.Health]: 12, [StatType.Sanity]: 10 }, inventorySlots: 1 })
    .room("Hall", { description: "A stone hall." })
    .startRoom("Hall")
    // Place a loot container in the Hall with the old coin inside
    .loot("chest", { room: "Hall", items: [CHEST_ITEM_KEY], description: "An old chest." });

  const campaign = startSession(template, {
    players: [
      { name: "Ada", archetype: "delver" },
      { name: "Ben", archetype: "delver" },
    ],
    gm: 0,
  });

  return { campaign, registry };
}

// ─── Generator test ───────────────────────────────────────────────────────────

describe("generate items-projection golden", () => {
  it("writes the items-projection snapshot, catalog, and golden", () => {
    const { campaign, registry } = buildItemsCampaign();

    // ── Set up genesis state ───────────────────────────────────────────────────
    // Give the active PC (Ada) a weapon, accessory, consumable, and a key.
    // Then equip exactly the accessory (one equipped item → trivial equippedNames order).
    const pc = campaign.activeCharacter;

    // We must startTurn first so action budget is open for addToInventory + equip.
    pc.startTurn();

    // Create items — assign content-derived ids (player:<name>:item#<behaviorKey>)
    // so fixtures are stable across regeneration.
    const sword = makeIronSword();
    sword.id = `player:Ada:item#${SWORD_KEY}` as ItemId;
    const ring = makeSilverRing();
    ring.id = `player:Ada:item#${RING_KEY}` as ItemId;
    const tonic = makeHealingTonic();
    tonic.id = `player:Ada:item#${TONIC_KEY}` as ItemId;
    const key = createKey({ name: "Old Key", keyCode: "old", consumeOnUse: false });
    key.id = `player:Ada:item#key:old` as ItemId;

    // Add items (addToInventory records action but equip is also budgeted — use
    // withGateSuppressed-style: the real engine does startTurn once per turn;
    // equip is budget-free so we can call it after addToInventory in the same turn).
    pc.addToInventory([sword, ring, tonic]);
    pc.addToInventory(key); // keys bypass slot check

    // Equip exactly the ring (accessory). equip() is budget-counted, but startTurn
    // resets the budget; we already consumed addToInventory. The code in character.ts
    // shows equip() is a registered action. Let's check if we need another startTurn.
    // Based on character.ts line 686: equip uses attemptAction. Since addToInventory
    // already used one budget slot (actionsPerRound=3 by default), equip should still
    // be allowed. However, let's call startTurn again for safety (setup, not gated replay).
    // Actually: a PC's startTurn refreshes the budget. We already called startTurn once.
    // addToInventory is ONE action (regardless of batch). equip is another action.
    // With default actionsPerRound=3 we have budget left.
    pc.equip(ring);

    // ── Serialize the genesis snapshot ────────────────────────────────────────
    const startSnapshot = serializeCampaign(campaign);

    // ── Build catalog ─────────────────────────────────────────────────────────
    const itemKeys = [SWORD_KEY, RING_KEY, TONIC_KEY, CHEST_ITEM_KEY];
    const catalog = buildCatalog(registry, itemKeys, ALIASES);

    // ── Self-validate: catalog must be non-empty ───────────────────────────────
    if (Object.keys(catalog.items).length === 0) {
      throw new Error("Catalog items is empty — no item factories were exported.");
    }

    // Validate all four inert fields are present on each catalog item
    for (const [key, descriptor] of Object.entries(catalog.items)) {
      const d = descriptor as Record<string, unknown>;
      for (const field of ["recipe", "teaches", "immunities", "grantsImmunity"]) {
        if (!(field in d)) {
          throw new Error(`Catalog item '${key}' is missing required inert field '${field}'.`);
        }
      }
    }

    // ── Build the projected 3a view ───────────────────────────────────────────
    const projectedView = viewProjected(campaign, ALIASES);

    // ── Self-validate: inventory.items must be non-empty ──────────────────────
    if (projectedView.inventory.items.length === 0) {
      throw new Error("Projected view inventory.items is empty — PC has no items.");
    }

    // ── Validate Phase-2 parity fields are emitted (now DIFFED) ───────────────
    if (!("exits" in projectedView)) throw new Error("Projected view missing 'exits' field.");
    if (!("lockedDoors" in projectedView)) throw new Error("Projected view missing 'lockedDoors' field.");
    if (!("locationName" in (projectedView.status as object))) {
      throw new Error("Projected view status missing 'locationName'.");
    }

    // ── Write files ───────────────────────────────────────────────────────────
    writeFileSync(
      join(here, "items-projection.start.snapshot.json"),
      JSON.stringify(startSnapshot, null, 2) + "\n",
    );

    writeFileSync(
      join(here, "items-projection.catalog.json"),
      JSON.stringify(catalog, null, 2) + "\n",
    );

    writeFileSync(
      join(here, "items-projection.golden.json"),
      JSON.stringify({ view: projectedView }, null, 2) + "\n",
    );

    // ── Log summary for debugging ──────────────────────────────────────────────
    console.log(
      `[items-projection] catalog items: ${Object.keys(catalog.items).join(", ")}`,
    );
    console.log(
      `[items-projection] inventory items: ${projectedView.inventory.items.map((i) => (i as { name: string }).name).join(", ")}`,
    );
    console.log(
      `[items-projection] equippedNames: ${JSON.stringify(projectedView.inventory.equippedNames)}`,
    );
  });
});
