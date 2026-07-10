/**
 * two-pc genesis fixture generator.
 *
 * The ONLY pre-begin MULTI-PC oracle. The 16 other pre-begin goldens are all
 * single-PC (or player-less); `combat.start.snapshot.json` carries two PCs but is
 * `started: true`, so `assemble()` cannot reproduce it. This generates a pre-begin
 * two-PC genesis through the REAL TS engine (generation, not golden-editing) so the
 * assembler's `seat_party` can be byte-gated at `party.len() == 2`.
 *
 * It also carries construct-branch coverage no other fixture exercises:
 *   * a MATERIAL CACHE in the start room (`MaterialCacheSnapshot.contents`),
 *   * a ROOM LIGHT (a light item authored via `room(..., { lights })`),
 *   * a ONE-WAY exit (A -> C),
 *   * a two-way DIAGONAL exit (A <-> B, `northeast`/`southwest`), covering
 *     `reverse_direction` for diagonals.
 * The generated golden byte-gates construct's output for each.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it } from "vitest";
import { defineRegistry } from "wickedways/lib/authoring/registry";
import { authorTemplate } from "wickedways/lib/authoring/template-builder";
import { Item, ItemType } from "wickedways/lib/inventory";
import { SlotKind } from "wickedways/lib/equipment";
import { StatType } from "wickedways/lib/character/stats";
import { catalogFromRegistry } from "../../packages/play-runtime/src/catalog.ts";
import { stripRng } from "./facade-gen.ts";
import { twoPcGenesis } from "./two-pc-session.ts";

const here = dirname(fileURLToPath(import.meta.url));
const TORCH_KEY = "items/two-pc-torch";

const noop = () => {};

// Room light source: a light-emitting accessory placed as a room light (not held).
const makeTorch = () =>
  new Item({
    descriptor: {
      behaviorKey: TORCH_KEY,
      name: "Torch",
      type: ItemType.Accessory,
      stat: StatType.Sanity,
      modifier: 0,
      slot: SlotKind.Hand,
      emitsLight: true,
      recipe: { item: 1 },
    },
    properties: { equippable: true, equipped: false, destroyable: false, usable: false },
    actions: { pickUp: noop, equip: noop, unequip: noop, transfer: noop, use: noop, destroy: () => null },
    events: { onPickUp: noop },
  });

describe("generate two-pc genesis golden", () => {
  it("writes description + catalog + pre-begin two-PC genesis", () => {
    const registry = defineRegistry({ items: { [TORCH_KEY]: makeTorch } });
    const template = authorTemplate("Two PC (conformance)", registry, {
      maxRounds: 20,
      baseEncounterChance: 0,
    })
      .archetype({
        id: "delver",
        name: "Delver",
        baseStats: { [StatType.Health]: 10, [StatType.Sanity]: 8, [StatType.Energy]: 8 },
      })
      // Start room A carries the room light AND the material cache.
      .room("A", { description: "A vaulted antechamber.", lights: [TORCH_KEY] })
      .room("B", { description: "A slanted gallery." })
      .room("C", { description: "A one-way oubliette." })
      .startRoom("A")
      // Two-way DIAGONAL exit A <-> B (covers reverse_direction for diagonals).
      .exit("A", "northeast", "B")
      // One-way exit A -> C (covers the oneWay branch: no reverse leg in C).
      .exit("A", "south", "C", { oneWay: true })
      // Material cache in the start room (covers caches / MaterialCacheSnapshot).
      .cache("Vein", { room: "A", materials: { metal: 3, glass: 2 } });

    const genesis = twoPcGenesis(template, [
      { name: "Ada", archetype: "delver" },
      { name: "Ben", archetype: "delver" },
    ]);

    writeFileSync(
      join(here, "two-pc.description.json"),
      JSON.stringify(stripRng(template.description), null, 2) + "\n",
    );
    writeFileSync(
      join(here, "two-pc.catalog.json"),
      JSON.stringify(catalogFromRegistry(registry, /* aliases */ {}, {}, {}), null, 2) + "\n",
    );
    writeFileSync(
      join(here, "two-pc.genesis.json"),
      JSON.stringify(genesis, null, 2) + "\n",
    );
  });
});
