import { describe, it, expect } from "vitest";
import { Authority } from "./authority";
import { InProcessTransport } from "./transport";
import { serializeCampaign } from "../serialization/serializer";
import { buildStartedCampaign } from "../serialization/roundtrip.test-helpers";

describe("InProcessTransport", () => {
  function setup() {
    const { campaign, registry } = buildStartedCampaign();
    const authority = new Authority(serializeCampaign(campaign), { registry, rng: () => 0.5 });
    return new InProcessTransport(authority);
  }

  it("commits a submitted command and exposes it via head/entriesSince", async () => {
    const t = setup();
    expect(t.head()).toBe(0);
    const res = await t.submit({ kind: "nextPlayer" });
    expect(res.ok).toBe(true);
    expect(t.head()).toBe(1);
    expect(t.entriesSince(1)).toHaveLength(1);
  });

  it("fans a committed entry out to subscribers", async () => {
    const t = setup();
    const seen: number[] = [];
    t.subscribe(1, (e) => seen.push(e.seq));
    await t.submit({ kind: "nextPlayer" });
    expect(seen).toEqual([1]);
  });

  it("returns a denial without committing", async () => {
    const t = setup();
    const res = await t.submit({ kind: "move", actorId: "nobody" as never, roomId: "nowhere" as never });
    expect(res.ok).toBe(false);
    expect(t.head()).toBe(0);
  });
});
