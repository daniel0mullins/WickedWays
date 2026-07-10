/**
 * facade-undo golden — snapshot round-trips and undo semantics. undo reverts a
 * time-advancing action INCLUDING the mob reactions folded into its `pre`
 * snapshot (session.ts:127-133): take sword (Lurker strikes) → undo reverts both
 * the take and the strike. A second undo with the stash consumed returns
 * { ok: false }. A free op (equip) does NOT restash, so a following undo reverts
 * to the pre-take stash, past the equip. The rng stream CONTINUES across restore
 * on both sides (opts.rng closure survives deserialize ≡ Authority keeps its
 * Rng), so the re-take after undo draws the ADVANCED stream identically.
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
const SEED = 0xfacade8;
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

const ALIASES = { [SWORD_KEY]: ["sword", "blade"] };

describe("generate facade-undo golden", () => {
  it("writes genesis + catalog + per-op golden", () => {
    const rng = mulberry32(SEED);
    const registry = defineRegistry({ items: { [SWORD_KEY]: makeSword } });
    const template = authorTemplate("Facade Undo (conformance)", registry, {
      rng, maxRounds: 20, baseEncounterChance: 0,
    })
      .archetype({
        id: "delver", name: "Delver",
        baseStats: { [StatType.Health]: 20, [StatType.Sanity]: 8, [StatType.Energy]: 8 },
      })
      .room("Hall", { description: "A stone hall." })
      .room("Crypt", { description: "A dark-cornered crypt." })
      .startRoom("Hall")
      .exit("Hall", Directions.North, "Crypt")
      .loot("chest", { room: "Hall", items: [SWORD_KEY], description: "An old chest." })
      .mob("Lurker", { stats: { [StatType.Health]: 6, [StatType.Sanity]: 4, [StatType.Energy]: 4 }, room: "Hall" });

    const oracle = new OracleSession({
      builder: template, registry, aliases: ALIASES, playerName: "Ada", archetype: "delver", rng,
    });

    const swordId = oracle.view().loot[0]!.contents[0]!.id;

    const ops: FacadeOp[] = [
      { kind: "submit", intent: { kind: "take", targetId: swordId } },  // 0 advancing; Lurker strikes → stash
      { kind: "undo" },                                                  // 1 reverts take + strike
      { kind: "undo" },                                                  // 2 stash consumed → { ok: false }
      { kind: "submit", intent: { kind: "take", targetId: swordId } },  // 3 re-take on the advanced rng stream
      { kind: "submit", intent: { kind: "equip", targetId: swordId } }, // 4 FREE: does not restash
      { kind: "undo" },                                                  // 5 reverts to the pre-take-2 stash, past the equip
      { kind: "submit", intent: { kind: "wait" } },                     // 6 advancing in the restored state
    ];
    const steps = writeFacadeFixture(here, "facade-undo", SEED, oracle,
      { items: { [SWORD_KEY]: itemToCatalogEntry(makeSword()) }, aliases: ALIASES }, ops, template.description);

    // undo outcomes: ok, then not-ok (stash consumed), then ok.
    if ((steps[1]!.result as { ok: boolean }).ok !== true) throw new Error("first undo must succeed");
    if ((steps[2]!.result as { ok: boolean }).ok !== false) throw new Error("second undo must report ok:false");
    if ((steps[5]!.result as { ok: boolean }).ok !== true) throw new Error("undo after free equip must succeed");
    // After op 1 (undo), the sword is back in the chest (take reverted).
    const afterUndo = steps[1]!.view as { inventory: { items: unknown[] }; loot: { contents: unknown[] }[] };
    if (afterUndo.inventory.items.length !== 0) throw new Error("undo must remove the taken sword from inventory");
    if (afterUndo.loot[0]!.contents.length !== 1) throw new Error("undo must return the sword to the chest");
  });
});
