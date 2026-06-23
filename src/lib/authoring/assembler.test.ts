import { describe, it, expect } from "vitest";
import { assemble } from "./assembler";
import { AuthoringError } from "./errors";
import { defineRegistry } from "./registry";
import { authorTemplate } from "./template-builder";
import { Directions } from "../room";
import { StatType } from "../character/stats";
import { Item } from "../inventory";
import { serializeCampaign } from "../serialization/serializer";
import type { CampaignTemplateDescription } from "./description";

const makeCoin = () => new Item({
  descriptor: { type: "consumable", recipe: { item: 1 }, modifier: 0, stat: StatType.Health, name: "Coin", behaviorKey: "coin-item" },
  properties: { equippable: false, equipped: false, destroyable: true, usable: false },
  actions: { pickUp: () => {}, equip: () => {}, unequip: () => {}, transfer: () => {}, use: () => {}, destroy: () => null },
  events: { onPickUp: () => {} },
});
const registry = defineRegistry({ items: { "coin-item": makeCoin } });
const stats = () => ({ [StatType.Health]: 10, [StatType.Sanity]: 10, [StatType.Energy]: 10 });

function baseDesc(over: Partial<CampaignTemplateDescription> = {}): CampaignTemplateDescription {
  return {
    title: "Crypt", opts: { rng: () => 0.5, maxRounds: 10 },
    archetypes: [], rooms: [{ name: "start", description: "the entrance" }, { name: "next", description: "next" }],
    startRoom: "start", exits: [{ from: "start", direction: Directions.North, to: "next" }],
    mobs: [], loot: [], caches: [], recipes: [], materials: [], winConditions: [], loseConditions: [], mechanics: [], ...over,
  };
}

describe("useMechanic authoring", () => {
  it("opts a mechanic in and constructs its initial state in order", () => {
    const reg = defineRegistry({
      items: {},
      mechanics: { doom: { initialState: (c: { start: number }) => ({ doom: c.start }) } },
    });
    const campaign = authorTemplate("T", reg)
      .room("start", { description: "entry" })
      .startRoom("start")
      .useMechanic("doom", { start: 3 })
      .build();
    expect(campaign.title).toBe("T");
  });

  it("rejects an unknown mechanic key at assemble time", () => {
    const reg = defineRegistry({ items: {} });
    const b = authorTemplate("T", reg).room("s", { description: "s" }).startRoom("s");
    // unknown key — the compile-time union is `never` so any call is technically invalid;
    // we cast to bypass the type gate and verify the runtime assembler rejects it.
    expect(() => (b as unknown as { useMechanic(k: string): typeof b }).useMechanic("ghost").build()).toThrow(/unregistered mechanic key/);
  });

  it("rejects a duplicate useMechanic", () => {
    const reg = defineRegistry({ items: {}, mechanics: { doom: { initialState: () => ({}) } } });
    const b = authorTemplate("T", reg).room("s", { description: "s" }).startRoom("s").useMechanic("doom");
    expect(() => b.useMechanic("doom")).toThrow(/already enabled/);
  });
});

describe("assemble", () => {
  it("constructs a player-less, not-begun campaign with rooms + exit", () => {
    const { campaign, rooms } = assemble(baseDesc(), registry);
    expect(campaign.started).toBe(false);
    expect(campaign.party.length).toBe(0);          // no players
    expect(rooms.get("start")!.exits.get(Directions.North)).toBe(rooms.get("next"));
    expect(serializeCampaign(campaign)).toBeDefined(); // serializable
  });

  it("places a mob's drops + a loot box's items from registry keys", () => {
    const { rooms } = assemble(baseDesc({
      mobs: [{ name: "goblin", stats: stats(), room: "next", drops: ["coin-item"] }],
      loot: [{ name: "chest", room: "next", items: ["coin-item"] }],
    }), registry);
    const next = rooms.get("next")!;
    // mob carries the drop in its inventory
    const goblin = next.occupants[0]!;
    expect(goblin.inventory.items.length).toBeGreaterThanOrEqual(1);
    // loot chest has the item
    const chest = [...next.loot.values()][0]!;
    expect(chest.contents.length).toBeGreaterThanOrEqual(1);
  });

  it("collects ALL validation problems into one AuthoringError", () => {
    let err: AuthoringError | null = null;
    try {
      assemble(baseDesc({
        exits: [{ from: "start", direction: Directions.North, to: "nowhere" }], // dangling room
        rooms: [{ name: "start", description: "x" }, { name: "start", description: "dup" }], // duplicate
        startRoom: "ghost", // unknown
      }), registry);
    } catch (e) { err = e as AuthoringError; }
    expect(err).toBeInstanceOf(AuthoringError);
    expect(err!.problems.length).toBeGreaterThanOrEqual(3); // all collected, not fail-fast
  });
});
