/**
 * facade-open-fail golden — carried-check A: the `opened`-timing on a take that
 * OPENS a fresh container then FAILS.
 *
 * TS GameSession.dispatch (session.ts:196-201) adds the container to `opened`
 * BEFORE takeFromLootBox. In a DARK room takeFromLootBox's requireVisibleTarget
 * throws "Cannot loot in the dark" AFTER the container was already marked opened,
 * so the failed take still leaves loot[0].opened === true. The Rust submit must
 * match: it marks `opened` BEFORE attempting `take`, so a failed-after-open take
 * still reveals the container. (Before the fix the Rust side inserted `opened`
 * only after `take` returned Ok, so a dark-room failure left it unopened — the
 * divergence this fixture pins.)
 */
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { describe, it } from "vitest";
import { defineRegistry } from "wickedways/lib/authoring/registry";
import { authorTemplate } from "wickedways/lib/authoring/template-builder";
import { Item, ItemType } from "wickedways/lib/inventory";
import { StatType } from "wickedways/lib/character/stats";
import { mulberry32 } from "../seeded-rng.ts";
import { itemToCatalogEntry } from "./facade-catalog.ts";
import { OracleSession } from "./oracle-session.ts";
import { writeFacadeFixture, type FacadeOp } from "./facade-gen.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SEED = 0xfacade9;
const RELIC_KEY = "items/facade-relic";

const noop = () => {};

const makeRelic = () =>
  new Item({
    descriptor: {
      behaviorKey: RELIC_KEY, name: "Relic", type: ItemType.Consumable,
      stat: StatType.Health, modifier: 0, recipe: { item: 1 },
    },
    properties: { equippable: false, equipped: false, destroyable: false, usable: false },
    actions: { pickUp: noop, equip: noop, unequip: noop, transfer: noop, use: noop, destroy: () => null },
    events: { onPickUp: noop },
  });

const ALIASES = { [RELIC_KEY]: ["relic"] };

describe("generate facade-open-fail golden", () => {
  it("writes genesis + catalog + per-op golden", () => {
    const rng = mulberry32(SEED);
    const registry = defineRegistry({ items: { [RELIC_KEY]: makeRelic } });
    const template = authorTemplate("Facade Open Fail (conformance)", registry, {
      rng, maxRounds: 20, baseEncounterChance: 0,
    })
      .archetype({
        id: "delver", name: "Delver",
        baseStats: { [StatType.Health]: 10, [StatType.Sanity]: 8, [StatType.Energy]: 8 },
      })
      // A DARK room: takeFromLootBox's requireVisibleTarget throws here.
      .room("Vault", { description: "A pitch-black vault.", dark: true })
      .startRoom("Vault")
      .loot("chest", { room: "Vault", items: [RELIC_KEY], description: "An unseen chest." });

    const oracle = new OracleSession({
      builder: template, registry, aliases: ALIASES, playerName: "Ada", archetype: "delver", rng,
    });

    const relicId = oracle.view().loot[0]!.contents[0]!.id;

    const ops: FacadeOp[] = [
      { kind: "submit", intent: { kind: "take", targetId: relicId } }, // dark: auto-open, then FAIL
      { kind: "submit", intent: { kind: "wait" } },                    // opened must persist into the next view
    ];
    const steps = writeFacadeFixture(here, "facade-open-fail", SEED, oracle,
      { items: { [RELIC_KEY]: itemToCatalogEntry(makeRelic()) }, aliases: ALIASES }, ops, template.description);

    const r0 = steps[0]!.result as { error?: string };
    if (r0.error !== "Cannot loot in the dark") {
      throw new Error(`step 0 expected dark-loot error, got ${JSON.stringify(r0)}`);
    }
    // The failed take still marked the container opened (opened-before-take).
    for (const [i, s] of steps.entries()) {
      const opened = (s.view as { loot: { opened: boolean }[] }).loot[0]!.opened;
      if (!opened) throw new Error(`step ${i}: a failed-after-open take must still reveal the container`);
    }
    // The relic never left the chest (the take failed).
    const contents = (steps[0]!.view as { loot: { contents: unknown[] }[] }).loot[0]!.contents;
    if (contents.length !== 1) throw new Error("failed take must leave the relic in the chest");
  });
});
