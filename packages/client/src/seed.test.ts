import { describe, it, expect } from "vitest";
import { serializeCampaign } from "wickedways/lib/serialization/serializer";
import { deserializeCampaign } from "wickedways/lib/serialization/deserializer";
import { buildSeedCampaign, buildSeedRegistry } from "./seed.js";

describe("seed", () => {
  it("builds a started campaign with an active character", () => {
    const { campaign } = buildSeedCampaign();
    expect(campaign.started).toBe(true);
    expect(campaign.activeCharacter).toBeDefined();
  });

  it("round-trips through serialize/deserialize with the seed registry", () => {
    const { campaign } = buildSeedCampaign();
    const snap = serializeCampaign(campaign);
    const restored = deserializeCampaign(snap, { registry: buildSeedRegistry(), rng: () => 0.5 });
    expect(serializeCampaign(restored)).toEqual(snap);
  });
});
