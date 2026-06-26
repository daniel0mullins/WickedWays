import { describe, it, expect, beforeEach } from "vitest";
import { LocalStorageSaveStore } from "./savestore.js";
import type { CampaignSnapshot } from "wickedways/lib/serialization/types";

class MemStorage {
  m = new Map<string, string>();
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  get length() { return this.m.size; }
}

const snap = { schemaVersion: 5, campaign: { title: "x" } } as unknown as CampaignSnapshot;

describe("LocalStorageSaveStore", () => {
  let store: LocalStorageSaveStore;
  beforeEach(() => { store = new LocalStorageSaveStore(new MemStorage() as unknown as Storage); });

  it("round-trips a snapshot (no surface)", async () => {
    await store.save("slot1", snap, 1000);
    expect(await store.load("slot1")).toEqual({ snapshot: snap, surface: undefined });
  });

  it("round-trips a surface payload alongside the snapshot", async () => {
    const surface = { map: { rooms: [], edges: [], stubs: [], currentId: null } };
    await store.save("slot1", snap, 1000, surface);
    expect(await store.load("slot1")).toEqual({ snapshot: snap, surface });
  });
  it("lists saved slots with timestamps", async () => {
    await store.save("a", snap, 1000);
    await store.save("b", snap, 2000);
    expect((await store.list()).map((s) => s.slot).sort()).toEqual(["a", "b"]);
  });
  it("returns null for a missing slot and deletes", async () => {
    expect(await store.load("ghost")).toBeNull();
    await store.save("c", snap, 1);
    await store.delete("c");
    expect(await store.load("c")).toBeNull();
  });
});
