/**
 * Items-actions golden generator — run once to write the committed fixture files.
 *
 * Drives a bespoke item campaign through an item-action COMMAND STREAM
 * (startTurn → take → equip → equip(second slot kind) → unequip → use → drop →
 * open → nextPlayer cycles), capturing per-step { command, cues, snapshot, view }.
 * The engine is driven DIRECTLY (as turn-movement does — NOT GameSession.execute):
 * pc.takeFromLootBox / pc.equip / pc.unequip / item.actions.use /
 * pc.removeFromInventory / pc.openLootBox — while mirroring GameSession's `opened`
 * set (Open adds; Take auto-adds the container it took from).
 *
 * Writes:
 *   - items-actions.start.snapshot.json   (serialized genesis state, pre-command)
 *   - items-actions.catalog.json          ({ items, aliases } Rust Catalog shape)
 *   - items-actions.golden.json           ({ commands, steps:[{command,cues,snapshot,view}] })
 *
 * Run via:
 *   pnpm run fixtures:gen
 *
 * The main test:conformance gate excludes conformance/fixtures/** so this
 * generator never runs as part of the replay gate.
 *
 * Interface contract with the Rust replay (Task 7): each object in
 * `golden.commands` deserializes into the Rust `Command` enum
 * (#[serde(tag="kind", rename_all="camelCase")]):
 *   { "kind": "startTurn" } | { "kind": "nextPlayer" }
 *   { "kind": "take"|"equip"|"unequip"|"use"|"drop", "targetId": "<ITEM id>" }
 *   { "kind": "open", "targetId": "<LOOT container id>" }
 * The TS driver resolves `targetId` → the live IItem/ILoot by id.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import { authorTemplate } from "wickedways/lib/authoring/template-builder";
import { defineRegistry } from "wickedways/lib/authoring/registry";
import { startSession } from "wickedways/lib/authoring/orchestration";
import { serializeCampaign } from "wickedways/lib/serialization/serializer";
import { Item, ItemType } from "wickedways/lib/inventory";
import { StatType } from "wickedways/lib/character/stats";
import { SlotKind } from "wickedways/lib/equipment";
import { Directions } from "wickedways/lib/room";
import type { PresentationCue } from "wickedways/lib/presentation";
import type { IItem } from "wickedways/lib/inventory";
import type { ILoot } from "wickedways/lib/loot";
import { viewProjected } from "./gen-helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));

// ─── Item behavior keys ───────────────────────────────────────────────────────

const SWORD_KEY = "items/iron-sword";
const RING_KEY = "items/silver-ring";
const TONIC_KEY = "items/healing-tonic";
const COIN_KEY = "items/old-coin";
const RELIC_KEY = "items/dusty-relic";

// ─── Aliases for the catalog ──────────────────────────────────────────────────

const ALIASES: Record<string, string[]> = {
  [SWORD_KEY]: ["sword", "iron sword", "blade"],
  [RING_KEY]: ["ring", "silver ring", "band"],
  [TONIC_KEY]: ["tonic", "healing tonic", "vial"],
  [COIN_KEY]: ["coin", "old coin"],
  [RELIC_KEY]: ["relic", "dusty relic"],
};

// ─── Item factories ───────────────────────────────────────────────────────────

const noop = () => {};

/** A weapon: equippable (hand slot), has lore + maxDurability. Equip #1. */
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

/** An accessory: equippable (finger slot) — a DIFFERENT slot kind from the sword. Equip #2. */
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

/** A usable consumable: not equippable, usable:true, heals 4 health. Use path. */
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

/** A plain, droppable consumable (droppable absent → true). Drop target. */
function makeOldCoin(): Item {
  return new Item({
    descriptor: {
      behaviorKey: COIN_KEY,
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

/** A relic living in the DARK-room chest — its take must throw (visibility gate). */
function makeDustyRelic(): Item {
  return new Item({
    descriptor: {
      behaviorKey: RELIC_KEY,
      name: "Dusty Relic",
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
      [COIN_KEY]: makeOldCoin,
      [RELIC_KEY]: makeDustyRelic,
    },
  });
}

// ─── Catalog exporter (verbatim from items-projection.gen.test.ts) ────────────

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

/**
 * Rooms:
 *   - Hall   (lit, start room) — holds "chest" with sword/ring/tonic/coin.
 *   - Cellar (dark:true)       — holds "cryptbox" with the relic (dark-take block).
 * Players: Ada (active) + Ben. rng: () => 0.5, maxRounds: 10 (headroom).
 * Archetype inventorySlots +5 → 10 total (base 5) so no full-inventory take.
 */
function buildItemsActionsCampaign() {
  const registry = buildItemRegistry();

  const template = authorTemplate("Item Actions (conformance)", registry, {
    rng: () => 0.5,
    maxRounds: 10,
    now: () => 0,
  })
    .archetype({
      id: "delver",
      name: "Delver",
      baseStats: { [StatType.Health]: 12, [StatType.Sanity]: 10 },
      inventorySlots: 5,
    })
    .room("Hall", { description: "A stone hall." })
    .room("Cellar", { description: "A pitch-black cellar.", dark: true })
    .startRoom("Hall")
    .exit("Hall", Directions.South, "Cellar")
    .exit("Cellar", Directions.North, "Hall")
    .loot("chest", {
      room: "Hall",
      items: [SWORD_KEY, RING_KEY, TONIC_KEY, COIN_KEY],
      description: "An old chest.",
    })
    .loot("cryptbox", {
      room: "Cellar",
      items: [RELIC_KEY],
      description: "A cobwebbed strongbox.",
    });

  const campaign = startSession(template, {
    players: [
      { name: "Ada", archetype: "delver" },
      { name: "Ben", archetype: "delver" },
    ],
    gm: 0,
  });

  return { campaign, registry };
}

// ─── Command types ─────────────────────────────────────────────────────────────
//
// Each stored command serializes to exactly the Rust `Command` shape:
//   { kind: "startTurn" } | { kind: "nextPlayer" }
//   { kind: "take"|"equip"|"unequip"|"use"|"drop"|"open", targetId }
// The driver resolves targetId → the live IItem / ILoot by id.

type Command =
  | { kind: "startTurn" }
  | { kind: "nextPlayer" }
  | { kind: "take"; targetId: string }
  | { kind: "equip"; targetId: string }
  | { kind: "unequip"; targetId: string }
  | { kind: "use"; targetId: string }
  | { kind: "drop"; targetId: string }
  | { kind: "open"; targetId: string };

// ─── Generator test ───────────────────────────────────────────────────────────

describe("generate items-actions golden", () => {
  it("writes the items-actions snapshot, catalog, and golden", () => {
    const { campaign, registry } = buildItemsActionsCampaign();

    // ── Resolve the live item / loot ids from the campaign ──────────────────────
    const hall = campaign.activeCharacter.currentRoom!;
    const chest = [...hall.loot.values()][0]!;
    // Map behaviorKey → the live item id inside the Hall chest.
    const idByKey = new Map<string, string>();
    for (const it of chest.contents) {
      if (it.behaviorKey) idByKey.set(it.behaviorKey, it.id);
    }
    const SWORD_ID = idByKey.get(SWORD_KEY)!;
    const RING_ID = idByKey.get(RING_KEY)!;
    const TONIC_ID = idByKey.get(TONIC_KEY)!;
    const COIN_ID = idByKey.get(COIN_KEY)!;
    const CHEST_ID = chest.id as unknown as string;

    // Sanity: all five ids resolved.
    for (const [label, id] of [
      ["sword", SWORD_ID], ["ring", RING_ID], ["tonic", TONIC_ID],
      ["coin", COIN_ID], ["chest", CHEST_ID],
    ] as const) {
      if (!id) throw new Error(`Failed to resolve ${label} id from the Hall chest.`);
    }

    // ── Write the genesis snapshot (pre-command state) ──────────────────────────
    const start = serializeCampaign(campaign);

    // ── Build the catalog ───────────────────────────────────────────────────────
    const itemKeys = [SWORD_KEY, RING_KEY, TONIC_KEY, COIN_KEY, RELIC_KEY];
    const catalog = buildCatalog(registry, itemKeys, ALIASES);
    if (Object.keys(catalog.items).length === 0) {
      throw new Error("Catalog items is empty — no item factories were exported.");
    }
    for (const [key, descriptor] of Object.entries(catalog.items)) {
      const d = descriptor as Record<string, unknown>;
      for (const field of ["recipe", "teaches", "immunities", "grantsImmunity"]) {
        if (!(field in d)) {
          throw new Error(`Catalog item '${key}' is missing required inert field '${field}'.`);
        }
      }
    }

    // ── Cue capture (drain buffer) ──────────────────────────────────────────────
    let buf: PresentationCue[] = [];
    campaign.onCue((c: PresentationCue) => buf.push(c));
    const drain = () => {
      const out = buf;
      buf = [];
      return out;
    };

    // ── `opened` set mirroring GameSession (Open adds; Take auto-adds) ──────────
    const opened = new Set<string>();

    // ── The deterministic command stream ────────────────────────────────────────
    //
    // Budgeted actions (take/use/drop) cost 1 each; the PC budget is 3/round and
    // is refreshed by startTurn. equip/unequip/open are FREE. We cycle turns
    // (Ada → Ben → Ada) so no budgeted action is dropped by budget exhaustion.
    //
    // Round 0, Ada: startTurn; take sword; take ring; take tonic   (3 budgeted)
    //   nextPlayer → Ben; startTurn; nextPlayer → round 1
    // Round 1, Ada: startTurn; take coin (1); equip sword (free);
    //               equip ring (free, DIFFERENT slot kind → multi-equip);
    //               unequip ring (free); use tonic (1); drop coin (1)  (3 budgeted)
    //   nextPlayer → Ben; startTurn; nextPlayer → round 2
    // Round 2, Ada: startTurn; open chest (re-open, free)
    //   nextPlayer → Ben; startTurn; nextPlayer → round 3
    const commands: Command[] = [
      // Round 0, Ada
      { kind: "startTurn" },
      { kind: "take", targetId: SWORD_ID },
      { kind: "take", targetId: RING_ID },
      { kind: "take", targetId: TONIC_ID },
      { kind: "nextPlayer" }, // → Ben
      // Round 0, Ben
      { kind: "startTurn" },
      { kind: "nextPlayer" }, // → round 1, Ada

      // Round 1, Ada
      { kind: "startTurn" },
      { kind: "take", targetId: COIN_ID }, // budgeted
      { kind: "equip", targetId: SWORD_ID }, // free — hand slot
      { kind: "equip", targetId: RING_ID }, // free — finger slot → 2 equipped (multi-equip)
      { kind: "unequip", targetId: RING_ID }, // free — back to 1 equipped
      { kind: "use", targetId: TONIC_ID }, // budgeted — consumes tonic
      { kind: "drop", targetId: COIN_ID }, // budgeted — coin leaves inventory
      { kind: "nextPlayer" }, // → Ben
      // Round 1, Ben
      { kind: "startTurn" },
      { kind: "nextPlayer" }, // → round 2, Ada

      // Round 2, Ada
      { kind: "startTurn" },
      { kind: "open", targetId: CHEST_ID }, // free — re-open the Hall chest
      { kind: "nextPlayer" }, // → Ben
      // Round 2, Ben
      { kind: "startTurn" },
      { kind: "nextPlayer" }, // → round 3
    ];

    // ── Drive the engine directly, capturing per-step state ─────────────────────
    const pcNow = () => campaign.activeCharacter;

    const findHeld = (id: string): IItem => {
      const it = pcNow().inventory.items.find((i) => i.id === id);
      if (!it) throw new Error(`Item ${id} not held by active PC.`);
      return it;
    };
    const findEquipped = (id: string): IItem => {
      const it = [...pcNow().equipment.values()].find((i) => i.id === id);
      if (!it) throw new Error(`Item ${id} not equipped on active PC.`);
      return it;
    };
    const findInLoot = (id: string): { loot: ILoot; item: IItem } => {
      const room = pcNow().currentRoom!;
      for (const loot of room.loot.values()) {
        const item = loot.contents.find((i) => i.id === id);
        if (item) return { loot, item };
      }
      throw new Error(`Item ${id} not found in any co-located loot container.`);
    };
    const findLoot = (id: string): ILoot => {
      const room = pcNow().currentRoom!;
      const loot = [...room.loot.values()].find((l) => (l.id as unknown as string) === id);
      if (!loot) throw new Error(`Loot ${id} not found in current room.`);
      return loot;
    };

    const steps = commands.map((cmd) => {
      switch (cmd.kind) {
        case "startTurn":
          pcNow().startTurn();
          break;
        case "nextPlayer":
          campaign.nextPlayer();
          break;
        case "take": {
          const { loot, item } = findInLoot(cmd.targetId);
          if (!opened.has(loot.id as unknown as string)) {
            pcNow().openLootBox(loot);
            opened.add(loot.id as unknown as string);
          }
          pcNow().takeFromLootBox(loot, [item]);
          break;
        }
        case "equip":
          pcNow().equip(findHeld(cmd.targetId));
          break;
        case "unequip":
          pcNow().unequip(findEquipped(cmd.targetId));
          break;
        case "use":
          findHeld(cmd.targetId).actions.use(pcNow());
          break;
        case "drop":
          pcNow().removeFromInventory([findHeld(cmd.targetId)]);
          break;
        case "open": {
          const loot = findLoot(cmd.targetId);
          pcNow().openLootBox(loot);
          opened.add(loot.id as unknown as string);
          break;
        }
      }
      return {
        command: cmd,
        cues: drain(),
        snapshot: serializeCampaign(campaign),
        view: viewProjected(campaign, ALIASES, opened),
      };
    });

    // ── Dark-room take-block (NOT a diffed step; kept out of commands/steps) ────
    // Move Ada into the Cellar (dark) and attempt to take the relic. The
    // visibility gate (!is_lit && !seesInDark) must throw ProceduralViolation
    // BEFORE mutating state, so this is safe to attempt on the live campaign.
    // We assert the throw, then discard — nothing downstream depends on it.
    {
      // It is Ada's turn again after the final nextPlayer wrapped to round 3?
      // No — the last recorded command left Ben having ended his turn (→ round 3,
      // Ada active but no startTurn recorded). Give Ada a fresh turn purely to
      // open her action budget for the (doomed) take attempt.
      const ada = campaign.activeCharacter;
      ada.startTurn();
      // Walk south into the dark Cellar via the authored exit.
      ada.go(Directions.South);
      const cellar = ada.currentRoom!;
      if (cellar.name !== "Cellar") {
        throw new Error(`Expected to reach the Cellar, got "${cellar.name}".`);
      }
      const cryptbox = [...cellar.loot.values()][0]!;
      const relic = cryptbox.contents[0]!;
      expect(() => ada.takeFromLootBox(cryptbox, [relic])).toThrow();
      // Drain any cues the doomed attempt produced so they never leak into a step.
      drain();
    }

    // ── Self-validation ─────────────────────────────────────────────────────────
    const equipSteps = steps.filter((s) => s.command.kind === "equip");
    if (equipSteps.length === 0) {
      throw new Error("Golden has no equip step.");
    }

    const maxEquipped = Math.max(
      ...steps.map((s) => (s.view.inventory.equippedNames as unknown[]).length),
    );
    if (maxEquipped < 2) {
      throw new Error(
        `Expected at least one step with >=2 equippedNames (multi-equip), max was ${maxEquipped}.`,
      );
    }

    // The dark-take assertion above (expect(...).toThrow()) is the dark-room check.

    // Inventory reflects the taken item: after the take of the sword, some step
    // must show the sword in inventory.items.
    const swordEverHeld = steps.some((s) =>
      (s.view.inventory.items as Array<{ name?: unknown }>).some((i) => i.name === "Iron Sword"),
    );
    if (!swordEverHeld) throw new Error("Taken Iron Sword never appeared in inventory.");

    // The used consumable is gone: the final step's inventory must not contain the tonic.
    const finalStep = steps[steps.length - 1]!;
    const tonicStillHeld = (finalStep.view.inventory.items as Array<{ name?: unknown }>).some(
      (i) => i.name === "Healing Tonic",
    );
    if (tonicStillHeld) throw new Error("Used Healing Tonic is still in inventory (should be consumed).");

    // The dropped item left inventory: the final step must not contain the coin.
    const coinStillHeld = (finalStep.view.inventory.items as Array<{ name?: unknown }>).some(
      (i) => i.name === "Old Coin",
    );
    if (coinStillHeld) throw new Error("Dropped Old Coin is still in inventory (should be dropped).");

    // ── Write files ───────────────────────────────────────────────────────────
    writeFileSync(
      join(here, "items-actions.start.snapshot.json"),
      JSON.stringify(start, null, 2) + "\n",
    );
    writeFileSync(
      join(here, "items-actions.catalog.json"),
      JSON.stringify(catalog, null, 2) + "\n",
    );
    writeFileSync(
      join(here, "items-actions.golden.json"),
      JSON.stringify({ commands, steps }, null, 2) + "\n",
    );

    // ── Debug summary ───────────────────────────────────────────────────────────
    console.log(
      `[items-actions] item ids: sword=${SWORD_ID} ring=${RING_ID} tonic=${TONIC_ID} coin=${COIN_ID} chest=${CHEST_ID}`,
    );
    console.log(
      `[items-actions] max equippedNames per step: ${maxEquipped}`,
    );
    console.log(
      `[items-actions] equippedNames on multi-equip step: ${JSON.stringify(
        steps.find((s) => (s.view.inventory.equippedNames as unknown[]).length >= 2)?.view.inventory.equippedNames,
      )}`,
    );
  });
});
