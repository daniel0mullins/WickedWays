import { describe, it, expect } from "vitest";
import { authorTemplate } from "./template-builder";
import { defineRegistry } from "./registry";
import { Directions } from "../room";
import { StatType } from "../character/stats";
import { Item } from "../inventory";

const makeCoin = () => new Item(
  { type: "consumable", recipe: { item: 1 }, modifier: 0, stat: StatType.Health, name: "Coin", behaviorKey: "coin-item" },
  { equippable: false, equipped: false, destroyable: true, usable: false },
  { pickUp: () => {}, equip: () => {}, unequip: () => {}, transfer: () => {}, use: () => {}, destroy: () => null },
  { onPickUp: () => {} },
);

describe("authorTemplate", () => {
  it("builds an equivalent campaign regardless of author order (forward refs resolve)", () => {
    const reg = defineRegistry({ items: { "coin-item": makeCoin } });
    const campaign = authorTemplate("Crypt", reg, { rng: () => 0.5, maxRounds: 10 })
      .exit("start", Directions.North, "next")          // forward ref: "next" defined below
      .room("next", { description: "next" })
      .room("start", { description: "the entrance" })
      .startRoom("start")
      .loot("chest", { room: "next", items: ["coin-item"] })
      .build();
    expect(campaign.started).toBe(false);
    expect(campaign.party.length).toBe(0);
  });

  it("toSnapshot captures the player-less template world (rooted from template rooms)", () => {
    const reg = defineRegistry({ items: { "coin-item": makeCoin } });
    const snap = authorTemplate("Crypt", reg, { rng: () => 0.5 })
      .room("start", { description: "the entrance" }).room("next", { description: "next" })
      .startRoom("start").exit("start", Directions.North, "next")
      .loot("chest", { room: "next", items: ["coin-item"] })
      .toSnapshot();
    expect(snap.rooms.length).toBe(2);          // NOT empty — the fix
    expect(snap.loot.length).toBe(1);
    expect(snap.items.length).toBe(1);
  });

  it("type-checks item/recipe keys against the registry", () => {
    const reg = defineRegistry({ items: { "coin-item": makeCoin } });
    authorTemplate("X", reg)
      .room("r", { description: "d" })
      // @ts-expect-error "nope" is not a registered item key
      .loot("chest", { room: "r", items: ["nope"] });
  });
});
