/**
 * Sync putInLootBox-delta golden generator (Phase 2c, sub-project A2).
 *
 * Drives the TS sync `Authority` over a `putInLootBox` command and captures the authoritative
 * `{ seq, delta }`. The Rust `SyncAuthority` + `World::put_in_loot_box` must reproduce it (see
 * `crates/wickedways-assemble/tests/sync_gate.rs`). This is the first sync fixture that ships a
 * catalog — the Rust command resolves the moved item's descriptor by behaviour key.
 *
 * Campaign: assembled from an authoring template — one room (Hall) with an empty chest, one player
 * (Ada = GM) holding a Trinket. Ada stows the Trinket into the chest. No rng is drawn.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it } from "vitest";
import { defineRegistry } from "wickedways/lib/authoring/registry";
import { authorTemplate } from "wickedways/lib/authoring/template-builder";
import { assemble } from "wickedways/lib/authoring/assembler";
import { PlayerCharacter } from "wickedways/lib/character/player-character";
import { Item, ItemType } from "wickedways/lib/inventory";
import type { ItemId } from "wickedways/lib/inventory";
import type { CharacterId } from "wickedways/lib/character/character";
import { StatType } from "wickedways/lib/character/stats";
import { serializeCampaign } from "wickedways/lib/serialization/serializer";
import { Authority } from "wickedways/lib/sync/authority";
import type { Command } from "wickedways/lib/sync/types";
import { itemToCatalogEntry } from "./facade-catalog.ts";

const here = dirname(fileURLToPath(import.meta.url));
const TRINKET_KEY = "items/trinket";
const noop = () => {};

const makeTrinket = () =>
  new Item({
    descriptor: {
      behaviorKey: TRINKET_KEY, name: "Trinket", type: ItemType.Accessory,
      stat: StatType.Sanity, modifier: 0, recipe: { item: 1 },
    },
    properties: { equippable: false, equipped: false, destroyable: false, usable: false },
    actions: { pickUp: noop, equip: noop, unequip: noop, transfer: noop, use: noop, destroy: () => null },
    events: { onPickUp: noop },
  });

describe("generate sync-loot golden", () => {
  it("writes the genesis + catalog + putInLootBox delta golden", () => {
    const registry = defineRegistry({ items: { [TRINKET_KEY]: makeTrinket } });
    const template = authorTemplate("Sync Loot (conformance)", registry, {
      rng: () => 0.5, maxRounds: 20, baseEncounterChance: 0,
    })
      .archetype({
        id: "delver", name: "Delver",
        baseStats: { [StatType.Health]: 10, [StatType.Sanity]: 8, [StatType.Energy]: 8 },
      })
      .room("Hall", { description: "A stone hall." })
      .startRoom("Hall")
      .loot("chest", { room: "Hall", items: [], description: "An old chest." });

    const { campaign, rooms } = assemble(template.description, template.registry);
    const hall = rooms.get("Hall")!;

    const ada = new PlayerCharacter({ campaign, name: "Ada" });
    ada.id = "player:Ada" as CharacterId;
    ada.joinCampaign();
    ada.selectArchetype("delver" as never);
    ada.move(hall);

    const trinket = makeTrinket();
    trinket.id = `player:Ada:item#${TRINKET_KEY}` as ItemId;
    ada.addToInventory(trinket);

    campaign.gm = ada;
    campaign.beginCampaign();

    const genesis = serializeCampaign(campaign);
    const catalog = { items: { [TRINKET_KEY]: itemToCatalogEntry(makeTrinket()) }, aliases: {} };
    const chestId = genesis.loot[0]!.id;

    const commands: Command[] = [
      { kind: "putInLootBox", actorId: ada.id, lootId: chestId, itemIds: [trinket.id] },
    ];

    const auth = new Authority(genesis, { registry });
    const steps = commands.map((command) => {
      const res = auth.submit(command);
      if (!res.ok) throw new Error(`sync command '${command.kind}' denied: ${res.reason}`);
      return { command, seq: res.seq, delta: res.delta };
    });

    writeFileSync(join(here, "sync-loot.genesis.json"), JSON.stringify(genesis, null, 2) + "\n");
    writeFileSync(join(here, "sync-loot.catalog.json"), JSON.stringify(catalog, null, 2) + "\n");
    writeFileSync(
      join(here, "sync-loot.golden.json"),
      JSON.stringify({ commands, steps }, null, 2) + "\n",
    );

    console.log(`[sync-loot] steps=${steps.length}`);
  });
});
