import { describe, it, expect } from "vitest";
import { Item, ItemType, StatType, createKey, STASH_DROP } from "./inventory";
import { Loot } from "./loot";
import { SERIALIZE } from "./serialization/symbols";
import { hydrateLoot } from "./loot";
import { hydrateItem } from "./inventory";
import { CampaignRegistry } from "./serialization/registry";
import { HydrateContext } from "./serialization/context";

function potionFactory() {
  return new Item({
    descriptor: {
      type: ItemType.Consumable,
      recipe: { healing: 1 },
      modifier: 0,
      stat: StatType.Health,
      name: "Healing Potion",
    },
    properties: { equippable: false, equipped: false, destroyable: true, usable: true },
    actions: { pickUp: () => {}, equip: () => {}, unequip: () => {}, transfer: () => {}, use: () => {}, destroy: () => null },
    events: { onPickUp: () => {} },
  });
}

describe("Loot serialization", () => {
  it("round-trips a loot box and resolves its contents by id", () => {
    const reg = new CampaignRegistry();
    reg.registerItem("healing-potion", potionFactory);
    const ctx = new HydrateContext(reg, () => 0.5);

    const potion = potionFactory();
    (potion as { behaviorKey?: string }).behaviorKey = "healing-potion";
    const loot = new Loot({ description: "Chest", contents: [potion] });

    const snap = loot[SERIALIZE]();
    expect(snap.contentIds).toEqual([potion.id]);

    hydrateItem(potion[SERIALIZE](), ctx); // contents hydrated first (deserializer ordering)
    const restored = hydrateLoot(snap, ctx);
    expect(restored.id).toBe(loot.id);
    expect(restored.contents.map((i) => i.id)).toEqual([potion.id]);
  });

  it("restores capacity from the snapshot", () => {
    const ctx = new HydrateContext(new CampaignRegistry(), () => 0.5);
    const loot = new Loot({ description: "Big chest", contents: [] });
    // capacity starts at 0 + 2 = 2
    const snap = loot[SERIALIZE]();
    expect(snap.capacity).toBe(2);

    const restored = hydrateLoot(snap, ctx);
    expect(restored.capacity).toBe(2);
  });

  it("round-trips a loot box containing a key (STASH_DROP path)", () => {
    const ctx = new HydrateContext(new CampaignRegistry(), () => 0.5);

    const key = createKey({ name: "Brass Key", keyCode: "brass", consumeOnUse: false });
    const loot = new Loot({ description: "Chest", contents: [] });
    loot[STASH_DROP](key);

    const snap = loot[SERIALIZE]();
    expect(snap.contentIds).toContain(key.id);

    hydrateItem(key[SERIALIZE](), ctx); // key must be indexed before the loot
    const restored = hydrateLoot(snap, ctx);
    expect(restored.contents.map((i) => i.id)).toContain(key.id);
  });
});
