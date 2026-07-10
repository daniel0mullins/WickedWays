/**
 * facade-legality golden — the intent-level legality guards that live in TS
 * GameSession.dispatch (session.ts:179-256), NOT in the engine Command handlers.
 * Every error case returns the EXACT TS string (and, being an error, omits the
 * mobAttacks key). Covers the drop-required guard (droppable: false Locket) and
 * the already-dead attack guard (health-1 Wraith).
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
const SEED = 0xfacade7;
const SWORD_KEY = "items/facade-sword";
const LOCKET_KEY = "items/facade-locket";

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

const makeLocket = () =>
  new Item({
    descriptor: {
      behaviorKey: LOCKET_KEY, name: "Locket", type: ItemType.Accessory,
      stat: StatType.Sanity, modifier: 0, droppable: false, recipe: { item: 1 },
    },
    properties: { equippable: false, equipped: false, destroyable: false, usable: false, droppable: false },
    actions: { pickUp: noop, equip: noop, unequip: noop, transfer: noop, use: noop, destroy: () => null },
    events: { onPickUp: noop },
  });

const ALIASES = { [SWORD_KEY]: ["sword", "blade"], [LOCKET_KEY]: ["locket"] };

describe("generate facade-legality golden", () => {
  it("writes genesis + catalog + per-op golden", () => {
    const rng = mulberry32(SEED);
    const registry = defineRegistry({ items: { [SWORD_KEY]: makeSword, [LOCKET_KEY]: makeLocket } });
    const template = authorTemplate("Facade Legality (conformance)", registry, {
      rng, maxRounds: 20, baseEncounterChance: 0,
    })
      .archetype({
        id: "delver", name: "Delver",
        baseStats: { [StatType.Health]: 20, [StatType.Sanity]: 8, [StatType.Energy]: 8 },
      })
      .room("Hall", { description: "A stone hall." })
      .startRoom("Hall")
      .loot("chest", { room: "Hall", items: [SWORD_KEY, LOCKET_KEY], description: "An old chest." })
      .mob("Wraith", { stats: { [StatType.Health]: 1, [StatType.Sanity]: 4, [StatType.Energy]: 4 }, room: "Hall" });

    const oracle = new OracleSession({
      builder: template, registry, aliases: ALIASES, playerName: "Ada", archetype: "delver", rng,
    });

    const vm = oracle.view();
    const locketId = vm.loot[0]!.contents.find((c) => c.name === "Locket")!.id;

    const ops: FacadeOp[] = [
      { kind: "submit", intent: { kind: "open", targetId: "nope" } },     // 0
      { kind: "submit", intent: { kind: "take", targetId: "nope" } },     // 1
      { kind: "submit", intent: { kind: "drop", targetId: "nope" } },     // 2
      { kind: "submit", intent: { kind: "equip", targetId: "nope" } },    // 3
      { kind: "submit", intent: { kind: "use", targetId: "nope" } },      // 4
      { kind: "submit", intent: { kind: "unequip", targetId: "nope" } },  // 5
      { kind: "submit", intent: { kind: "attack", targetId: "nope" } },   // 6
      { kind: "submit", intent: { kind: "take", targetId: locketId } },   // 7 succeeds (advancing; wraith may strike)
      { kind: "submit", intent: { kind: "drop", targetId: locketId } },   // 8 droppable:false
      { kind: "submit", intent: { kind: "attack", targetId: "mob:Wraith" } }, // 9 KOs (health 1)
      { kind: "submit", intent: { kind: "attack", targetId: "mob:Wraith" } }, // 10 already dead
    ];
    const steps = writeFacadeFixture(here, "facade-legality", SEED, oracle,
      { items: { [SWORD_KEY]: itemToCatalogEntry(makeSword()), [LOCKET_KEY]: itemToCatalogEntry(makeLocket()) }, aliases: ALIASES },
      ops, template.description);

    const wantErrors: Record<number, string> = {
      0: "There's nothing like that to open here.",
      1: "You don't see that here.",
      2: "You aren't carrying that.",
      3: "You aren't carrying that.",
      4: "You aren't carrying that.",
      5: "That isn't equipped.",
      6: "There's nothing like that to attack here.",
      8: "You can't bring yourself to part with the Locket.",
      10: "The Wraith is already dead.",
    };
    for (const [i, want] of Object.entries(wantErrors)) {
      const got = (steps[Number(i)]!.result as { error?: string }).error;
      if (got !== want) throw new Error(`step ${i}: expected "${want}", got "${got}"`);
    }
  });
});
