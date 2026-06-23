import { describe, it, expect } from "vitest";
import { StatType } from "../character/stats";
import { serializeCampaign } from "./serializer";
import { deserializeCampaign } from "./deserializer";
import { CampaignRegistry } from "./registry";
import { Item } from "../inventory";
import type { IItem } from "../inventory";
import { SlotKind } from "../equipment";
import { buildSerializableCampaign, makeStats } from "./roundtrip.test-helpers";
import { Campaign } from "../campaign";
import { PlayerCharacter } from "../character/player-character";
import { Room } from "../room";
import type { ArchetypeId } from "../archetype";
import type { ExitsArg } from "../../test-utils";
import { authorTemplate } from "../authoring/template-builder";
import { defineRegistry } from "../authoring/registry";
import type { JsonObject, Mechanic } from "../mechanics/mechanic";

/**
 * Builds a minimal started campaign with the given mechanics enabled.
 * Each entry is [mechanicKey, config]. The campaign has one party member
 * who is also the GM, so a single `completeRound` call ends the round.
 */
function startMinimal(
  reg: CampaignRegistry,
  mechanics: [string, unknown][],
): { campaign: Campaign } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let builder: any = authorTemplate("Mini", reg as any)
    .room("start", { description: "the start" })
    .startRoom("start")
    .archetype({ id: "hero", name: "Hero", statModifiers: {} });
  for (const [key, config] of mechanics) {
    builder = builder.useMechanic(key, config);
  }
  const campaign = builder.build() as Campaign;
  // Add a single player who is also the GM so we can begin.
  const pc = new PlayerCharacter(campaign, "Solo", makeStats());
  pc.joinCampaign();
  campaign.gm = pc;
  pc.selectArchetype("hero" as ArchetypeId);
  campaign.beginCampaign();
  return { campaign };
}

/** Advances a single-player campaign through one complete round. */
function completeRound(campaign: Campaign): void {
  campaign.nextPlayer(); // sole player acted → endRound fires
}

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
    expect(snap.schemaVersion).toBe(5);

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

  it("round-trips a resolved outcome, re-attaching the predicate and restoring prose", () => {
    // Build a started solo campaign with a win condition, drive it to a win.
    const registry = new CampaignRegistry();
    registry.registerCondition("w", () => true);

    const campaign = new Campaign("Crypt", 10, [], {
      rng: () => 0.5,
      winConditions: [{ key: "w", test: () => true, narration: { text: "You win." } }],
    });
    campaign.registerArchetype({
      id: "delver" as ArchetypeId,
      name: "Delver",
      statModifiers: { [StatType.Health]: 2 },
    });
    const start = new Room("Start", "the entrance", [], {} as ExitsArg);
    const pc = new PlayerCharacter(campaign, "Ada", makeStats());
    pc.joinCampaign();
    campaign.gm = pc;
    pc.selectArchetype("delver" as ArchetypeId);
    pc.move(start);
    campaign.beginCampaign();
    campaign.nextPlayer(); // closes round -> resolves win
    expect(campaign.outcome).toBe("won");

    const snap = serializeCampaign(campaign);
    const restored = deserializeCampaign(snap, { registry });
    expect(restored.outcome).toBe("won");
    expect(restored.outcomeReason).toBe("w");
    expect(restored.outcomeNarration).toEqual({ text: "You win." });
  });
});

interface DoomState extends JsonObject { doom: number }

const doomMechanic: Mechanic<DoomState> = {
  initialState: () => ({ doom: 0 }),
  onRoundEnd: (h) => { h.state.doom += 1; return []; },
};

describe("mechanic serialization round-trip", () => {
  it("round-trips mechanic state by key and re-attaches behavior", () => {
    const reg = defineRegistry({
      items: {},
      mechanics: { doom: doomMechanic },
    });
    const { campaign } = startMinimal(reg, [["doom", undefined]]);
    completeRound(campaign);              // doom -> 1
    const snap = serializeCampaign(campaign);
    const back = deserializeCampaign(snap, { registry: reg });
    // behavior fresh from registry; state intact: a second round makes doom 2
    completeRound(back);
    const snap2 = serializeCampaign(back);
    expect(snap2.campaign.mechanics).toContainEqual({ key: "doom", state: { doom: 2 } });
  });

  it("rejects a snapshot whose mechanic key is not registered", () => {
    const reg = defineRegistry({ items: {}, mechanics: { doom: { initialState: () => ({}) } } });
    const { campaign } = startMinimal(reg, [["doom", undefined]]);
    const snap = serializeCampaign(campaign);
    const bare = defineRegistry({ items: {} });
    expect(() => deserializeCampaign(snap, { registry: bare })).toThrow(/No mechanic registered/);
  });
});
