import { describe, it, expect } from "vitest";
import { Room } from "./room";
import { Loot } from "./loot";
import { Item, ItemType, StatType, ADD_LIGHT_SOURCE } from "./inventory";
import { SERIALIZE, HYDRATE } from "./serialization/symbols";
import { constructBareRoom } from "./room";
import { hydrateLoot } from "./loot";
import { hydrateItem } from "./inventory";
import { CampaignRegistry } from "./serialization/registry";
import { HydrateContext } from "./serialization/context";
import { SlotKind } from "./equipment";
import type { ExitsArg } from "../test-utils";

function potionFactory() {
  return new Item(
    {
      type: ItemType.Consumable,
      recipe: { healing: 1 },
      modifier: 0,
      stat: StatType.Health,
      name: "Healing Potion",
      behaviorKey: "healing-potion",
    },
    { equippable: false, equipped: false, destroyable: true, usable: true },
    { pickUp: () => {}, equip: () => {}, unequip: () => {}, transfer: () => {}, use: () => {}, destroy: () => null },
    { onPickUp: () => {} },
  );
}

function torchFactory() {
  const noop = () => {};
  return new Item(
    {
      type: ItemType.Weapon,
      recipe: { item: 1 },
      modifier: 0,
      stat: StatType.Health,
      name: "Torch",
      slot: SlotKind.Hand,
      emitsLight: true,
      behaviorKey: "torch",
    },
    { equippable: true, equipped: false, destroyable: true, usable: false },
    { pickUp: noop, equip: noop, unequip: noop, transfer: noop, use: noop, destroy: () => null },
    { onPickUp: noop },
  );
}

describe("Room serialization", () => {
  it("round-trips exits, loot, dark, and resolves references", () => {
    const reg = new CampaignRegistry();
    reg.registerItem("healing-potion", potionFactory);
    const ctx = new HydrateContext(reg, () => 0.5);

    const potion = potionFactory();
    const chest = new Loot("Chest", [potion]);
    const north = new Room("North", "n", [], {} as ExitsArg);
    const start = new Room("Start", "s", [chest], { north } as unknown as ExitsArg, [], 1, [], undefined, true);

    const startSnap = start[SERIALIZE]();
    expect(startSnap).toMatchObject({ dark: true, lootIds: [chest.id], exits: { north: north.id } });

    // pass 1: bare rooms + contents indexed
    const startBare = constructBareRoom(startSnap);
    const northBare = constructBareRoom(north[SERIALIZE]());
    ctx.put(startBare.id, startBare);
    ctx.put(northBare.id, northBare);
    hydrateItem(potion[SERIALIZE](), ctx);
    hydrateLoot(chest[SERIALIZE](), ctx);

    // pass 2: wire
    startBare[HYDRATE](startSnap, ctx);
    expect(startBare.id).toBe(start.id);
    expect(startBare.isLit).toBe(false); // dark restored
    expect(startBare.exits.get("north")!.id).toBe(north.id);
    expect([...startBare.loot.keys()]).toEqual([chest.id]);
  });

  it("round-trips a placed light source into the room's lightSources and reflects isLit", () => {
    const reg = new CampaignRegistry();
    reg.registerItem("torch", torchFactory);
    const ctx = new HydrateContext(reg, () => 0.5);

    const torch = torchFactory();
    // Place the torch in a dark room via ADD_LIGHT_SOURCE (the same seam Room[HYDRATE] uses).
    const dark = new Room("Dark Chamber", "pitch black", [], {} as ExitsArg, [], 1, [], undefined, true);
    dark[ADD_LIGHT_SOURCE](torch);
    expect(dark.isLit).toBe(true); // sanity: torch lights the dark room

    const darkSnap = dark[SERIALIZE]();
    expect(darkSnap.lightSourceIds).toContain(torch.id);

    // Mini two-pass hydration.
    const darkBare = constructBareRoom(darkSnap);
    ctx.put(darkBare.id, darkBare);
    hydrateItem(torch[SERIALIZE](), ctx);

    darkBare[HYDRATE](darkSnap, ctx);
    expect(darkBare.lightSources.has(torch.id as never)).toBe(true);
    expect(darkBare.isLit).toBe(true); // light source was restored
  });
});
