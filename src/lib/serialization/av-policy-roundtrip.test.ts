import { describe, it, expect } from "vitest";
import { Campaign } from "../campaign";
import { DEFAULT_AV_POLICY } from "../av-policy";
import { serializeCampaign } from "./serializer";
import { migrate } from "./deserializer";
import { SCHEMA_VERSION } from "./types";
import type { CampaignSnapshot } from "./types";

describe("avPolicy serialization", () => {
  it("defaults to DEFAULT_AV_POLICY and survives a snapshot", () => {
    const c = new Campaign("T", 10);
    expect(c.avPolicy).toEqual(DEFAULT_AV_POLICY);
    const snap = serializeCampaign(c, { rootRooms: [] });
    expect(snap.schemaVersion).toBe(SCHEMA_VERSION);
    expect(snap.campaign.avPolicy).toEqual(DEFAULT_AV_POLICY);
  });

  it("carries an explicit policy", () => {
    const policy = { ...DEFAULT_AV_POLICY, enabled: false, video: false };
    const c = new Campaign("T", 10, [], { avPolicy: policy });
    expect(serializeCampaign(c, { rootRooms: [] }).campaign.avPolicy).toEqual(policy);
  });

  it("migrate() upgrades a v3 snapshot by injecting the default policy", () => {
    const v3 = { schemaVersion: 3, campaign: {} as Record<string, unknown> } as unknown as CampaignSnapshot;
    const out = migrate(v3);
    expect(out.schemaVersion).toBe(5);
    expect(out.campaign.avPolicy).toEqual(DEFAULT_AV_POLICY);
  });
});
