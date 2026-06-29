import { describe, it, expect } from "vitest";
import { Campaign } from "wickedways/lib/campaign";
import { PlayerCharacter } from "wickedways/lib/character/player-character";
import { Mob } from "wickedways/lib/character/mob";
import { Room } from "wickedways/lib/room";
import { Item } from "wickedways/lib/inventory";
import { Loot } from "wickedways/lib/loot";
import { StatType } from "wickedways/lib/character/stats";
import { view } from "./viewmodel.js";

const stats = {
  [StatType.Health]: 10,
  [StatType.Sanity]: 10,
  [StatType.Energy]: 10,
};

function makeItem(name: string, image?: string): Item {
  return new Item({
    descriptor: {
      name,
      type: "consumable",
      recipe: { item: 1 },
      modifier: 0,
      stat: StatType.Health,
      ...(image !== undefined ? { presentation: { image } } : {}),
    },
    properties: { equippable: false, equipped: false, destroyable: false, usable: false },
    actions: {
      pickUp: () => {},
      equip: () => {},
      unequip: () => {},
      transfer: () => {},
      use: () => {},
      destroy: () => null,
    },
    events: { onPickUp: () => {} },
  });
}

function makeKey(name: string, image?: string): Item {
  return new Item({
    descriptor: {
      name,
      type: "key",
      recipe: { item: 1 },
      modifier: 0,
      stat: StatType.Health,
      keyCode: "test-code",
      consumeOnUse: false,
      ...(image !== undefined ? { presentation: { image } } : {}),
    },
    properties: { equippable: false, equipped: false, destroyable: false, usable: false },
    actions: {
      pickUp: () => {},
      equip: () => {},
      unequip: () => {},
      transfer: () => {},
      use: () => {},
      destroy: () => null,
    },
    events: { onPickUp: () => {} },
  });
}

describe("view() — presentation.image mapping", () => {
  it("surfaces presentation.image on occupant, loot-content item, inventory item, key, and room", () => {
    const campaign = new Campaign({ title: "Test" });
    const pc = new PlayerCharacter({ campaign, name: "Hero" });
    pc.joinCampaign();
    campaign.gm = pc;

    const room = new Room({
      name: "Crypt",
      description: "Dark crypt",
      presentation: { image: "crypt.png" },
    });

    const mob = new Mob({
      campaign,
      name: "Wraith",
      stats,
      drops: [],
      presentation: { image: "wraith.png" },
    });

    const invItem = makeItem("Lantern", "lantern.png");
    const key = makeKey("Iron Key", "iron-key.png");
    const lootItem = makeItem("Tome", "tome.png");
    const chest = new Loot({ description: "old chest", contents: [lootItem] });
    room.addLoot(chest);

    pc.move(room);
    mob.move(room);
    pc.receiveItem(invItem);
    pc.receiveItem(key);

    const vm = view(campaign, {});

    expect(vm.room.image).toBe("crypt.png");
    expect(vm.occupants[0]!.image).toBe("wraith.png");
    expect(vm.inventory.items[0]!.image).toBe("lantern.png");
    expect(vm.inventory.keys[0]!.image).toBe("iron-key.png");
    // Inventory capacity is surfaced for the slot-numbered panel (PC default: 5).
    expect(vm.inventory.slots).toBe(5);
    expect(vm.loot[0]!.contents[0]!.image).toBe("tome.png");
  });

  it("leaves image undefined when presentation is absent", () => {
    const campaign = new Campaign({ title: "Test" });
    const pc = new PlayerCharacter({ campaign, name: "Hero" });
    pc.joinCampaign();
    campaign.gm = pc;

    const room = new Room({ name: "Hall", description: "Empty hall" });
    const mob = new Mob({ campaign, name: "Shade", stats, drops: [] });
    const invItem = makeItem("Torch");

    pc.move(room);
    mob.move(room);
    pc.receiveItem(invItem);

    const vm = view(campaign, {});

    expect(vm.room.image).toBeUndefined();
    expect(vm.occupants[0]!.image).toBeUndefined();
    expect(vm.inventory.items[0]!.image).toBeUndefined();
  });
});
