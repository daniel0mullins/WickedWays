/**
 * facade-loot golden — the Intent loot path + the `opened`-set ownership proof.
 *
 * A chest in Hall holds a lore-bearing Journal and a Sword. The op stream walks
 * open (free reveal) → take journal (auto-open of an already-open container,
 * advancing) → read journal (lore cue, free) → take sword → drop sword
 * (advancing) → read the dropped sword (not held → []). The loot[0].opened flag
 * in each step view must match on both sides at every step. The read of the
 * lore-bearing Journal also gives positive parity for read_item's lore cue
 * (carried-check B: the only read output the data-driven core can reproduce).
 */
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { describe, it } from "vitest";
import { defineRegistry } from "wickedways/lib/authoring/registry";
import { authorTemplate } from "wickedways/lib/authoring/template-builder";
import { Item, ItemType } from "wickedways/lib/inventory";
import { SlotKind } from "wickedways/lib/equipment";
import { StatType } from "wickedways/lib/character/stats";
import { mulberry32 } from "../seeded-rng.ts";
import { itemToCatalogEntry } from "./facade-catalog.ts";
import { OracleSession } from "./oracle-session.ts";
import { writeFacadeFixture, type FacadeOp } from "./facade-gen.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SEED = 0xfacade6;
const JOURNAL_KEY = "items/facade-journal";
const SWORD_KEY = "items/facade-sword";

const noop = () => {};

const makeJournal = () =>
  new Item({
    descriptor: {
      behaviorKey: JOURNAL_KEY, name: "Journal", type: ItemType.Consumable,
      stat: StatType.Health, modifier: 0, lore: "The pages are damp.", recipe: { item: 1 },
    },
    properties: { equippable: false, equipped: false, destroyable: false, usable: false },
    actions: { pickUp: noop, equip: noop, unequip: noop, transfer: noop, use: noop, destroy: () => null },
    events: { onPickUp: noop },
  });

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

const ALIASES = { [JOURNAL_KEY]: ["journal", "book"], [SWORD_KEY]: ["sword", "blade"] };

describe("generate facade-loot golden", () => {
  it("writes genesis + catalog + per-op golden", () => {
    const rng = mulberry32(SEED);
    const registry = defineRegistry({ items: { [JOURNAL_KEY]: makeJournal, [SWORD_KEY]: makeSword } });
    const template = authorTemplate("Facade Loot (conformance)", registry, {
      rng, maxRounds: 20, baseEncounterChance: 0,
    })
      .archetype({
        id: "delver", name: "Delver",
        baseStats: { [StatType.Health]: 10, [StatType.Sanity]: 8, [StatType.Energy]: 8 },
      })
      .room("Hall", { description: "A stone hall." })
      .startRoom("Hall")
      .loot("chest", { room: "Hall", items: [JOURNAL_KEY, SWORD_KEY], description: "An old chest." });

    const oracle = new OracleSession({
      builder: template, registry, aliases: ALIASES, playerName: "Ada", archetype: "delver", rng,
    });

    // Resolve engine-assigned ids from the oracle view.
    const vm = oracle.view();
    const chestId = vm.loot[0]!.id;
    const journalId = vm.loot[0]!.contents.find((c) => c.name === "Journal")!.id;
    const swordId = vm.loot[0]!.contents.find((c) => c.name === "Sword")!.id;

    const ops: FacadeOp[] = [
      { kind: "submit", intent: { kind: "open", targetId: chestId } },  // FREE reveal → opened
      { kind: "submit", intent: { kind: "take", targetId: journalId } }, // advancing; container already open
      { kind: "read", itemId: journalId },                                // lore cue, free
      { kind: "submit", intent: { kind: "take", targetId: swordId } },   // advancing
      { kind: "submit", intent: { kind: "drop", targetId: swordId } },   // advancing; sword back on the floor
      { kind: "read", itemId: swordId },                                  // not held → []
    ];
    const steps = writeFacadeFixture(here, "facade-loot", SEED, oracle,
      { items: { [JOURNAL_KEY]: itemToCatalogEntry(makeJournal()), [SWORD_KEY]: itemToCatalogEntry(makeSword()) }, aliases: ALIASES },
      ops);

    // opened must be set from the very first op and stay set thereafter.
    for (const [i, s] of steps.entries()) {
      const opened = (s.view as { loot: { opened: boolean }[] }).loot[0]!.opened;
      if (!opened) throw new Error(`step ${i}: chest must be opened`);
    }
    // The lore read surfaced a cue; the not-held read surfaced none.
    const readJournal = steps[2]!.result as unknown[];
    if (readJournal.length !== 1) throw new Error("read journal must emit the lore cue");
    const readSword = steps[5]!.result as unknown[];
    if (readSword.length !== 0) throw new Error("read of a not-held item must be []");
  });
});
