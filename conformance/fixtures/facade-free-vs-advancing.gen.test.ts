/**
 * facade-free-vs-advancing golden — proves equip/open do NOT trigger
 * startTurn/reactions/nextPlayer, and move/wait DO (round increments,
 * mob strikes land only on advancing ops).
 */
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { describe, it } from "vitest";
import { defineRegistry } from "wickedways/lib/authoring/registry";
import { authorTemplate } from "wickedways/lib/authoring/template-builder";
import { Item, ItemType } from "wickedways/lib/inventory";
import { SlotKind } from "wickedways/lib/equipment";
import { StatType } from "wickedways/lib/character/stats";
import { Directions } from "wickedways/lib/room";
import { mulberry32 } from "../seeded-rng.ts";
import { itemToCatalogEntry } from "./facade-catalog.ts";
import { OracleSession } from "./oracle-session.ts";
import { writeFacadeFixture, type FacadeOp } from "./facade-gen.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SEED = 0xfacade2;
const SWORD_KEY = "items/facade-sword";

const noop = () => {};

const makeSword = () =>
  new Item({
    descriptor: {
      behaviorKey: SWORD_KEY, name: "Sword", type: ItemType.Weapon,
      stat: StatType.Health, modifier: 3, slot: SlotKind.Hand,
      maxDurability: 5, recipe: { metal: 1 },
    },
    properties: { equippable: true, equipped: false, destroyable: true, usable: false },
    actions: { pickUp: noop, equip: noop, unequip: noop, transfer: noop, use: noop, destroy: () => null },
    events: { onPickUp: noop },
  });

describe("generate facade-free-vs-advancing golden", () => {
  it("writes genesis + catalog + per-op golden", () => {
    const rng = mulberry32(SEED);
    const registry = defineRegistry({ items: { [SWORD_KEY]: makeSword } });
    const template = authorTemplate("Facade Free vs Advancing (conformance)", registry, {
      rng, maxRounds: 20, baseEncounterChance: 0,
    })
      .archetype({ id: "delver", name: "Delver", baseStats: {} })
      .room("Hall", { description: "A stone hall." })
      .room("Crypt", { description: "A dark-cornered crypt." })
      .startRoom("Hall")
      .exit("Hall", Directions.North, "Crypt")
      .loot("chest", { room: "Hall", items: [SWORD_KEY], description: "An old chest." })
      .mob("Lurker", { stats: { [StatType.Health]: 5, [StatType.Sanity]: 4, [StatType.Energy]: 4 }, room: "Hall" });

    const oracle = new OracleSession({
      builder: template, registry, aliases: { [SWORD_KEY]: ["sword", "blade"] },
      playerName: "Ada", archetype: "delver", rng,
    });

    // Resolve authored ids from the oracle view (loot content ids are engine-assigned).
    const vm = oracle.view();
    const chestId = vm.loot[0]!.id;
    const swordId = vm.loot[0]!.contents[0]!.id;

    const ops: FacadeOp[] = [
      { kind: "submit", intent: { kind: "open", targetId: chestId } },   // FREE: no reaction, round 0
      { kind: "submit", intent: { kind: "take", targetId: swordId } },   // advancing: Lurker strikes, round 1
      { kind: "submit", intent: { kind: "equip", targetId: swordId } },  // FREE: no reaction, round 1
      { kind: "submit", intent: { kind: "wait" } },                       // advancing no-op: reactions + wrap
      { kind: "submit", intent: { kind: "move", dir: Directions.North } },// advancing: leaves the mob behind
      { kind: "submit", intent: { kind: "wait" } },                       // advancing in empty room: no attacks
    ];
    writeFacadeFixture(here, "facade-free-vs-advancing", SEED,
      oracle, { items: { [SWORD_KEY]: itemToCatalogEntry(makeSword()) }, aliases: { [SWORD_KEY]: ["sword", "blade"] } }, ops);
  });
});
