import { describe, it, expect } from "vitest";
import { defineRegistry } from "wickedways/lib/authoring/registry";
import { authorTemplate } from "wickedways/lib/authoring/template-builder";
import { Item, ItemType } from "wickedways/lib/inventory";
import { SlotKind } from "wickedways/lib/equipment";
import { StatType } from "wickedways/lib/character/stats";
import { Directions } from "wickedways/lib/room";
import type { CampaignSnapshot } from "wickedways/lib/serialization/types";
import { GameSession } from "./session.js";
import type { SaveStore, SaveSlot, SurfaceState } from "./savestore.js";

const SWORD_KEY = "items/test-sword";

function memoryStore(): SaveStore {
  const slots = new Map<string, { snapshot: CampaignSnapshot; surface?: SurfaceState; savedAt: number }>();
  return {
    list: (): Promise<SaveSlot[]> =>
      Promise.resolve([...slots.entries()].map(([slot, v]) => ({ slot, savedAt: v.savedAt }))),
    save: (slot, snapshot, savedAt, surface): Promise<void> => {
      slots.set(slot, { snapshot, surface, savedAt });
      return Promise.resolve();
    },
    load: (slot) => Promise.resolve(slots.get(slot) ?? null),
    delete: (slot): Promise<void> => {
      slots.delete(slot);
      return Promise.resolve();
    },
  };
}

function startSession() {
  const noop = () => {};
  const registry = defineRegistry({
    items: {
      [SWORD_KEY]: () =>
        new Item({
          descriptor: {
            behaviorKey: SWORD_KEY, name: "Sword", type: ItemType.Weapon,
            stat: StatType.Health, modifier: 3, slot: SlotKind.Hand,
            maxDurability: 5, recipe: { metal: 1 },
          },
          properties: { equippable: true, equipped: false, destroyable: true, usable: false },
          actions: { pickUp: noop, equip: noop, unequip: noop, transfer: noop, use: noop, destroy: () => null },
          events: { onPickUp: noop },
        }),
    },
  });
  const builder = authorTemplate("Session Test", registry, { maxRounds: 10, baseEncounterChance: 0 })
    .archetype({ id: "delver", name: "Delver", baseStats: {} })
    .room("Hall", { description: "A stone hall." })
    .room("Crypt", { description: "A crypt." })
    .startRoom("Hall")
    .exit("Hall", Directions.North, "Crypt")
    .exit("Crypt", Directions.South, "Hall")
    .loot("chest", { room: "Hall", items: [SWORD_KEY], description: "An old chest." });
  return GameSession.start({
    builder, registry, aliases: { [SWORD_KEY]: ["sword"] },
    playerName: "Tess", archetype: "delver",
    saveStore: memoryStore(), now: () => 0, seed: 0x5e551,
  });
}

describe("WASM-backed GameSession", () => {
  it("boots, views, and takes empty startup cues (no mechanics)", () => {
    const s = startSession();
    expect(s.takeStartupCues()).toEqual([]);
    const vm = s.view();
    expect(vm.room.name).toBe("Hall");
    expect(vm.status.locationName).toBe("Hall");
    expect(vm.exits.map((e) => e.dir)).toEqual([Directions.North]);
    expect(s.finished).toBe(false);
    expect(s.outcome).toBe("ongoing");
  });

  it("executes a move (advancing) and a talk rejection", () => {
    const s = startSession();
    const moved = s.execute({ kind: "move", dir: Directions.North });
    expect(moved.error).toBeUndefined();
    expect(moved.mobAttacks).toEqual([]);
    expect(s.view().room.name).toBe("Crypt");
    expect(s.view().status.turn).toBe(1); // single player: wrap advances the round
    const talk = s.execute({ kind: "talk", npcId: "nobody" });
    expect(talk.error).toBe("There's no one here to talk to.");
  });

  it("open (free) reveals loot without advancing; take auto-opens", () => {
    const s = startSession();
    const chestId = s.view().loot[0]!.id;
    const swordId = s.view().loot[0]!.contents[0]!.id;
    const opened = s.execute({ kind: "open", targetId: chestId });
    expect(opened.error).toBeUndefined();
    expect(s.view().status.turn).toBe(0);
    expect(s.view().loot[0]!.opened).toBe(true);
    const took = s.execute({ kind: "take", targetId: swordId });
    expect(took.error).toBeUndefined();
    expect(s.view().inventory.items.map((i) => i.name)).toEqual(["Sword"]);
  });

  it("save → restore round-trips; undo reverts an advancing action", async () => {
    const s = startSession();
    await s.save("slot-a");
    s.execute({ kind: "move", dir: Directions.North });
    expect(s.view().room.name).toBe("Crypt");
    expect(s.undo()).toBe(true);
    expect(s.view().room.name).toBe("Hall");
    expect(s.undo()).toBe(false); // stash consumed
    s.execute({ kind: "move", dir: Directions.North });
    const restored = await s.restore("slot-a");
    expect(restored.ok).toBe(true);
    expect(s.view().room.name).toBe("Hall");
    expect(s.view().status.turn).toBe(0);
  });

  it("restart re-boots a fresh world", () => {
    const s = startSession();
    s.execute({ kind: "move", dir: Directions.North });
    s.restart();
    expect(s.view().room.name).toBe("Hall");
    expect(s.view().status.turn).toBe(0);
    expect(s.undo()).toBe(false);
  });
});
