import { describe, it, expect } from "vitest";
import { Authority } from "./authority";
import { serializeCampaign } from "../serialization/serializer";
import { buildStartedCampaign } from "../serialization/roundtrip.test-helpers";

describe("Authority", () => {
  it("commits a legal command and returns a seq + delta", () => {
    const { campaign, registry } = buildStartedCampaign();
    const authority = new Authority(serializeCampaign(campaign), { registry, rng: () => 0.5 });
    expect(authority.head()).toBe(0);
    const res = authority.submit({ kind: "nextPlayer" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.seq).toBe(1);
      expect(res.delta).toBeDefined();
    }
    expect(authority.head()).toBe(1);
    expect(authority.entriesSince(1)).toHaveLength(1);
  });

  it("denies an unauthorized command without advancing head", () => {
    const { campaign, registry } = buildStartedCampaign();
    const authority = new Authority(serializeCampaign(campaign), { registry, rng: () => 0.5 });
    // A turn-action by a non-active character is rejected by Resolver.authorize.
    const res = authority.submit({ kind: "move", actorId: "not-a-real-id" as never, roomId: "nowhere" as never });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/turn|begun|active/i);
    expect(authority.head()).toBe(0);
  });

  it("restores state when apply throws ProceduralViolation (no half-mutation, head unchanged)", () => {
    const { campaign, registry } = buildStartedCampaign();
    const genesis = serializeCampaign(campaign);
    const authority = new Authority(genesis, { registry, rng: () => 0.5 });
    // Construct a command that passes authorize but throws in apply: a `use` of an
    // item the active actor does not hold (Resolver.apply throws ProceduralViolation).
    const active = campaign.activeCharacter;
    const res = authority.submit({ kind: "use", actorId: active.id, itemId: "ghost-item" as never });
    expect(res.ok).toBe(false);
    expect(authority.head()).toBe(0);
    // Snapshot still equals genesis (state intact).
    expect(authority.loadSnapshot()).toEqual({ seq: 0, snapshot: genesis });
  });

  it("checkpoints every `snapshotEvery` commits", () => {
    const { campaign, registry } = buildStartedCampaign();
    const authority = new Authority(serializeCampaign(campaign), { registry, rng: () => 0.5, snapshotEvery: 2 });
    authority.submit({ kind: "nextPlayer" });
    expect(authority.loadSnapshot().seq).toBe(0); // not yet
    authority.submit({ kind: "nextPlayer" });
    expect(authority.loadSnapshot().seq).toBe(2); // checkpoint taken at seq 2
  });
});
