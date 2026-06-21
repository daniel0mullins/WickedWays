import { describe, it, expect } from "vitest";
import { Campaign } from "../campaign";
import { DEFAULT_CHAT_POLICY } from "../chat-policy";
import { serializeCampaign } from "./serializer";
import { migrate } from "./deserializer";
import { SCHEMA_VERSION } from "./types";
import type { CampaignSnapshot } from "./types";

describe("chatPolicy serialization", () => {
  it("defaults to DEFAULT_CHAT_POLICY and survives a snapshot", () => {
    const c = new Campaign("T", 10);
    expect(c.chatPolicy).toEqual(DEFAULT_CHAT_POLICY);
    const snap = serializeCampaign(c, { rootRooms: [] });
    expect(snap.schemaVersion).toBe(SCHEMA_VERSION);
    expect(snap.campaign.chatPolicy).toEqual(DEFAULT_CHAT_POLICY);
  });

  it("carries an explicit policy", () => {
    const policy = { ...DEFAULT_CHAT_POLICY, enabled: false, whisper: false };
    const c = new Campaign("T", 10, [], { chatPolicy: policy });
    expect(serializeCampaign(c, { rootRooms: [] }).campaign.chatPolicy).toEqual(policy);
  });

  it("migrate() upgrades a v2 snapshot by injecting the default policy", () => {
    const v2 = { schemaVersion: 2, campaign: {} as Record<string, unknown> } as unknown as CampaignSnapshot;
    const out = migrate(v2);
    expect(out.schemaVersion).toBe(4);
    expect(out.campaign.chatPolicy).toEqual(DEFAULT_CHAT_POLICY);
  });
});
