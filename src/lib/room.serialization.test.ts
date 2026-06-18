import { describe, it, expect } from "vitest";
import { Room } from "./room";
import { Loot } from "./loot";
import { Item, ItemType, StatType } from "./inventory";
import { SERIALIZE, HYDRATE } from "./serialization/symbols";
import { constructBareRoom } from "./room";
import { hydrateLoot } from "./loot";
import { hydrateItem } from "./inventory";
import { CampaignRegistry } from "./serialization/registry";
import { HydrateContext } from "./serialization/context";
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
});
