/**
 * Byte-parity unit test for `descriptorToFormation`: the spawned mob's serialized
 * snapshot must match the shape the Rust `FormationDescriptor::build` +
 * `World::maybe_spawn` drop seeding emits (crates/wickedways-core/src/world/
 * formation_descriptor.rs, formations.rs). Locks the four parity contracts:
 * id scheme (pair `campaign-mob:rat#2`), drop ids (`…:drop#0`), `inventorySlots: 0`
 * base (→ slots widened to drops.len), and the always-emit mob fields.
 */
import { describe, it, expect } from "vitest";
import { Item, ItemType } from "wickedways/lib/inventory";
import { CampaignRegistry } from "wickedways/lib/serialization/registry";
import { StatType } from "wickedways/lib/character/stats";
import { SERIALIZE } from "wickedways/lib/serialization/symbols";
import type { ICampaign } from "wickedways/lib/campaign";
import { descriptorToFormation } from "./formations.js";
import type { FormationDescriptor } from "../../../generated/bindings/FormationDescriptor.ts";
import type { MobSpec } from "../../../generated/bindings/MobSpec.ts";

const noop = () => {};

// A bare campaign stub: Mob's constructor only stores the campaign and never
// calls back into it during construction (drops load via the inventory seam).
const stubCampaign = {} as unknown as ICampaign;

function registryWithTail(): CampaignRegistry {
  const registry = new CampaignRegistry();
  registry.registerItem(
    "items/tail",
    () =>
      new Item({
        descriptor: {
          behaviorKey: "items/tail",
          name: "Rat Tail",
          type: ItemType.Consumable,
          recipe: { item: 1 },
          modifier: 0,
          stat: StatType.Health,
        },
        properties: { equippable: false, equipped: false, destroyable: true, usable: false },
        actions: { pickUp: noop, equip: noop, unequip: noop, transfer: noop, use: noop, destroy: () => null },
        events: { onPickUp: noop },
      }),
  );
  return registry;
}

// A Rat spec mirroring the Rust `rat-formation` test (formations.rs) — one drop,
// escape 50, one action/round, dark-agnostic, empty material drops.
const ratSpec: MobSpec = {
  name: "Rat",
  stats: { energy: 3, sanity: 0, health: 4 },
  naturalAttack: { stat: "health", power: 1 },
  drops: ["items/tail"],
  baseEscapeChance: 50n,
  lightAverse: false,
  materialDrops: {},
  actionsPerRound: 1n,
};

describe("descriptorToFormation", () => {
  it("builds a pair with the Rust id scheme, drop ids, widened slots, and always-emit fields", () => {
    const descriptor: FormationDescriptor = { mobs: [ratSpec, ratSpec] };
    const mobs = descriptorToFormation(descriptor, registryWithTail()).build(stubCampaign);

    expect(mobs).toHaveLength(2);
    const s0 = mobs[0]![SERIALIZE]();
    const s1 = mobs[1]![SERIALIZE]();

    // Contract 1: deterministic id scheme (first plain, index ≥ 1 suffixed `#i+1`).
    expect(s0.id).toBe("campaign-mob:rat");
    expect(s1.id).toBe("campaign-mob:rat#2");

    // Contract 2 + 3: drops seeded with `{mobId}:drop#{j}` ids; slots widened
    // from the base of 0 to hold the single drop.
    expect(s0.inventory.slots).toBe(1);
    expect(s0.inventory.itemIds).toEqual(["campaign-mob:rat:drop#0"]);
    expect(s1.inventory.itemIds).toEqual(["campaign-mob:rat#2:drop#0"]);

    // The drop's ItemSnapshot comes straight from a fresh factory: no durability
    // (the descriptor has no maxDurability → field omitted), modifier from descriptor.
    expect(mobs[0]!.inventory.items[0]![SERIALIZE]()).toEqual({
      kind: "item",
      id: "campaign-mob:rat:drop#0",
      behaviorKey: "items/tail",
      modifier: 0,
    });

    // Contract 4 + always-emit mob fields: naturalAttack shape, escape, materials, light.
    expect(s0.naturalAttack).toEqual({ stat: "health", power: 1 });
    expect(s0.baseEscapeChance).toBe(50);
    expect(s0.materialDrops).toEqual({});
    expect(s0.lightAverse).toBe(false);
    expect(s0.actionsPerRound).toBe(1);
  });

  it("builds a drop-free mob at 0 slots without needing a registry", () => {
    const dropless: MobSpec = { ...ratSpec, drops: [] };
    const descriptor: FormationDescriptor = { mobs: [dropless] };
    const [mob] = descriptorToFormation(descriptor).build(stubCampaign);

    const snap = mob![SERIALIZE]();
    expect(snap.id).toBe("campaign-mob:rat");
    expect(snap.inventory.slots).toBe(0);
    expect(snap.inventory.itemIds).toEqual([]);
  });
});
