import { describe, it, expect } from "vitest";
import { Campaign } from "../campaign";
import { PlayerCharacter } from "../character/player-character";
import { Room } from "../room";
import { StatType } from "../character/stats";
import type { ArchetypeId } from "../archetype";
import type { ExitsArg } from "../../test-utils";
import { serializeCampaign } from "./serializer";
import { deserializeCampaign } from "./deserializer";
import { CampaignRegistry } from "./registry";

function makeStats() {
  return {
    [StatType.Health]: 10,
    [StatType.Sanity]: 10,
    [StatType.Energy]: 10,
  };
}

function buildCampaign() {
  const campaign = new Campaign("Crypt", 10, [], { rng: () => 0.5 });
  campaign.registerArchetype({
    id: "delver" as ArchetypeId,
    name: "Delver",
    statModifiers: { [StatType.Health]: 2 },
  });
  const start = new Room("Start", "the entrance", [], {} as ExitsArg);
  const pc = new PlayerCharacter(campaign, "Ada", makeStats());
  pc.joinCampaign();
  campaign.gm = pc; // the engine's real GM-assignment API (setter, not setGM)
  pc.selectArchetype("delver" as ArchetypeId);
  pc.move(start);
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
});
