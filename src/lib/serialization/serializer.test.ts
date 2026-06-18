import { describe, it, expect } from "vitest";
import { serializeCampaign, serializeCampaignWithIndex } from "./serializer";
import { buildSerializableCampaign } from "./roundtrip.test-helpers";

describe("serializeCampaignWithIndex", () => {
  it("returns a snapshot identical to serializeCampaign plus an index of every entity", () => {
    const { campaign } = buildSerializableCampaign();
    const { snapshot, index } = serializeCampaignWithIndex(campaign);
    expect(snapshot).toEqual(serializeCampaign(campaign));
    for (const r of snapshot.rooms) expect(index.has(r.id)).toBe(true);
    for (const c of snapshot.characters) expect(index.get(c.id)).toBeDefined();
    for (const it of snapshot.items) expect(index.has(it.id)).toBe(true);
    for (const l of snapshot.loot) expect(index.has(l.id)).toBe(true);
    for (const m of snapshot.materialCaches) expect(index.has(m.id)).toBe(true);
  });
});
