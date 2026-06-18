import { describe, it, expect } from "vitest";
import { StatType } from "../character/stats";
import { serializeCampaign } from "./serializer";
import { deserializeCampaign } from "./deserializer";
import { CampaignRegistry } from "./registry";
import { Item } from "../inventory";
import type { IItem } from "../inventory";
import { SlotKind } from "../equipment";
import { buildSerializableCampaign } from "./roundtrip.test-helpers";

function makeTorch(): Item {
  const noop = () => {};
  return new Item(
    {
      type: "weapon",
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

function buildCampaign() {
  const { campaign } = buildSerializableCampaign();
  const pc = campaign.party[0]!;
  const start = pc.currentRoom!;
  return { campaign, start, pc };
}

describe("campaign round-trip", () => {
  it("serializes and restores a campaign that keeps playing", () => {
    const { campaign, pc, start } = buildCampaign();
    const snap = serializeCampaign(campaign);
    expect(snap.schemaVersion).toBe(1);

    const restored = deserializeCampaign(snap, {
      registry: new CampaignRegistry(),
      rng: () => 0.5,
    });
    expect(restored.title).toBe("Crypt");
    expect(restored.party.map((p) => p.name)).toEqual(["Ada"]);
    expect(restored.party[0]!.id).toBe(pc.id);
    expect(restored.id).toBe(campaign.id);
    expect(restored.gm?.id).toBe(pc.id);
    // archetype restored via the catalog (catalog-before-instances ordering)
    expect(restored.party[0]!.archetype?.id).toBe("delver");
    // current room restored and re-indexed
    expect(restored.party[0]!.currentRoom?.id).toBe(start.id);

    // KEEPS PLAYING: begin and advance a full round without throwing.
    expect(() => restored.beginCampaign()).not.toThrow();
    expect(restored.started).toBe(true);
    expect(() => restored.nextPlayer()).not.toThrow();
    expect(restored.round).toBe(1);
  });

  it("serializes an already-started campaign and restores started state + playability", () => {
    const { campaign } = buildCampaign();
    campaign.beginCampaign();
    expect(campaign.started).toBe(true);

    const snap = serializeCampaign(campaign);
    expect(snap.campaign.started).toBe(true);

    const restored = deserializeCampaign(snap, {
      registry: new CampaignRegistry(),
      rng: () => 0.5,
    });
    // started flag survived the round-trip.
    expect(restored.started).toBe(true);
    // Can advance the already-started campaign without throwing.
    expect(() => restored.nextPlayer()).not.toThrow();
    expect(restored.round).toBe(1);
  });

  it("rejects a dangling reference and an unknown version", () => {
    const { campaign } = buildCampaign();
    const snap = serializeCampaign(campaign);

    const broken = structuredClone(snap);
    broken.campaign.partyIds = ["nope"];
    expect(() =>
      deserializeCampaign(broken, { registry: new CampaignRegistry() }),
    ).toThrow(/dangling/);

    expect(() =>
      deserializeCampaign(
        { ...snap, schemaVersion: 7 },
        { registry: new CampaignRegistry() },
      ),
    ).toThrow(/schemaVersion/);
  });

  it("captures and restores a light source placed in a room", () => {
    const { campaign, pc, start } = buildCampaign();
    const torch = makeTorch();
    pc.addToInventory(torch);
    pc.placeLight(torch); // now held only by the room, not by any inventory
    expect(start.lightSources.has(torch.id as never)).toBe(true);

    const snap = serializeCampaign(campaign);
    // The placed light must be captured, or hydration would dangle.
    expect(snap.items.some((i) => i.id === torch.id)).toBe(true);

    const registry = new CampaignRegistry();
    registry.registerItem("torch", makeTorch);
    const restored = deserializeCampaign(snap, { registry, rng: () => 0.5 });

    const restoredRoom = restored.party[0]!.currentRoom!;
    const lights = [...restoredRoom.lightSources.values()] as IItem[];
    expect(lights.map((l) => l.id)).toContain(torch.id);
    expect(restoredRoom.isLit).toBe(true);
  });
});
