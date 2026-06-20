import { describe, it, expect } from "vitest";
import { serializeCampaign, serializeCampaignWithIndex } from "./serializer";
import { buildSerializableCampaign } from "./roundtrip.test-helpers";
import { Campaign } from "../campaign";
import { Room } from "../room";
import type { ExitsArg } from "../../test-utils";

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

  it("rootRooms: a room with no party member is absent without rootRooms, present with rootRooms", () => {
    const campaign = new Campaign("Test", 10, [], { rng: () => 0.5 });
    const orphan = new Room("Orphan", "a lonely chamber", [], {} as ExitsArg);

    // Without rootRooms: no party, no rooms reachable → empty rooms array
    const snapWithout = serializeCampaign(campaign);
    expect(snapWithout.rooms.length).toBe(0);

    // With rootRooms: the orphan room is seeded into BFS → appears in snapshot
    const snapWith = serializeCampaign(campaign, { rootRooms: [orphan] });
    expect(snapWith.rooms.length).toBe(1);
    expect(snapWith.rooms[0]!.id).toBe(orphan.id);
  });
});
