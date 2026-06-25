import { describe, it, expect } from "vitest";
import { defineRegistry } from "../authoring/registry";
import { authorTemplate } from "../authoring/template-builder";
import { startSession } from "../authoring/orchestration";
import { Item, ItemType } from "../inventory";
import { StatType } from "../character/stats";
import type { Mechanic, JsonObject } from "./mechanic";

const noop = () => {};
function makeProp(behaviorKey: string): Item {
  return new Item({
    descriptor: { behaviorKey, name: "Prop", type: ItemType.Consumable, recipe: { item: 1 }, modifier: 0, stat: StatType.Health },
    properties: { equippable: false, equipped: false, destroyable: true, usable: false },
    actions: { pickUp: noop, equip: noop, unequip: noop, transfer: noop, use: noop, destroy: () => null },
    events: { onPickUp: noop },
  });
}

describe("CharacterView.hasItem", () => {
  it("is true for a held item's behaviorKey and false otherwise", () => {
    const seen: { has: boolean; hasOther: boolean }[] = [];
    const probe: Mechanic<JsonObject> = {
      initialState: () => ({}),
      onTurnStart: (ctx) => {
        seen.push({ has: ctx.actor.hasItem("prop"), hasOther: ctx.actor.hasItem("nope") });
      },
    };
    const registry = defineRegistry({
      items: { prop: () => makeProp("prop") },
      mechanics: { probe },
    });
    const builder = authorTemplate("T", registry, { maxRounds: 5, baseEncounterChance: 0, rng: () => 0.5 })
      .room("Start", { description: "start" })
      .startRoom("Start")
      .loot("box", { room: "Start", items: ["prop"] })
      .useMechanic("probe");
    const campaign = startSession(builder, { players: [{ name: "P" }], gm: 0 });
    const pc = campaign.activeCharacter;
    const box = [...pc.currentRoom!.loot.values()][0]!;
    pc.openLootBox(box);
    pc.takeFromLootBox(box, box.contents.slice());
    pc.startTurn();
    expect(seen.at(-1)).toEqual({ has: true, hasOther: false });
  });
});
