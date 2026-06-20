import { describe, it, expect, afterEach } from "vitest";
import { SqliteStore } from "./sqlite-store.js";
import type { CampaignRecord } from "./store.js";

function record(seq: number): CampaignRecord {
  return {
    seq,
    snapshot: { schemaVersion: 1 } as unknown as CampaignRecord["snapshot"],
    membership: { gmIdentity: "gm", seats: [["ada", "ident-ada"]] },
  };
}

describe("SqliteStore", () => {
  let store: SqliteStore | null = null;
  afterEach(() => { store?.close(); store = null; });

  it("returns null for an unknown campaign", async () => {
    store = new SqliteStore(":memory:");
    expect(await store.load("nope")).toBeNull();
  });

  it("round-trips a record", async () => {
    store = new SqliteStore(":memory:");
    await store.save("demo", record(3));
    expect(await store.load("demo")).toEqual(record(3));
  });

  it("upserts: a second save for the same id wins", async () => {
    store = new SqliteStore(":memory:");
    await store.save("demo", record(3));
    await store.save("demo", record(4));
    expect((await store.load("demo"))?.seq).toBe(4);
  });
});
