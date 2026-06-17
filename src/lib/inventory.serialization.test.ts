import { describe, it, expect } from "vitest";
import { Item, createKey, SET_DURABILITY, ItemType, StatType } from "./inventory";
import { SERIALIZE } from "./serialization/symbols";
import { hydrateItem } from "./inventory";
import { CampaignRegistry } from "./serialization/registry";
import { HydrateContext } from "./serialization/context";

function potionFactory() {
  return new Item(
    { type: ItemType.Consumable, recipe: { healing: 1 }, modifier: 2, stat: StatType.Health,
      name: "Healing Potion", maxDurability: 3, durability: 3 },
    { equippable: false, equipped: false, destroyable: true, usable: true },
    { pickUp: () => {}, equip: () => {}, unequip: () => {}, transfer: () => {},
      use: () => {}, destroy: () => null },
    { onPickUp: () => {} },
  );
}

describe("Item serialization", () => {
  it("round-trips a non-key item by behaviorKey, preserving mutable state", () => {
    const reg = new CampaignRegistry();
    reg.registerItem("healing-potion", potionFactory);
    const ctx = new HydrateContext(reg, () => 0.5);

    const item = potionFactory();
    (item as { behaviorKey?: string }).behaviorKey = "healing-potion"; // set via constructor in Step 3
    item[SET_DURABILITY](1);
    item.modifier = 4;

    const snap = item[SERIALIZE]();
    expect(snap).toMatchObject({ kind: "item", behaviorKey: "healing-potion", durability: 1, modifier: 4 });

    const restored = hydrateItem(snap, ctx);
    expect(restored.id).toBe(item.id);
    expect(restored.durability).toBe(1);
    expect(restored.modifier).toBe(4);
    expect(restored.name).toBe("Healing Potion");
  });

  it("round-trips a key via createKey config", () => {
    const ctx = new HydrateContext(new CampaignRegistry(), () => 0.5);
    const key = createKey({ name: "Brass Key", keyCode: "crypt", consumeOnUse: false });
    const snap = key[SERIALIZE]();
    expect(snap).toMatchObject({ kind: "key", keyCode: "crypt", consumeOnUse: false });
    const restored = hydrateItem(snap, ctx);
    expect(restored.id).toBe(key.id);
    expect(restored.keyCode).toBe("crypt");
  });

  it("throws when a non-key item lacks a behaviorKey", () => {
    const item = potionFactory(); // no behaviorKey
    expect(() => item[SERIALIZE]()).toThrow(/behaviorKey/);
  });
});
