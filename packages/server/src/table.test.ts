import { describe, it, expect, vi } from "vitest";
import { Authority } from "wickedways/lib/sync/authority";
import { Table } from "./table.js";
import { demoGenesis, buildSeedRegistry } from "@wickedways/seed";

function table() {
  return new Table(new Authority(demoGenesis(), { registry: buildSeedRegistry(), rng: () => 0.5 }));
}

describe("Table", () => {
  it("acks the submitter with committed and broadcasts entry to others", async () => {
    const t = table();
    const sender = vi.fn();
    const other = vi.fn();
    t.join(other, 0);
    t.join(sender, 0);
    other.mockClear();
    const res = await t.submit({ kind: "nextPlayer" }, sender);
    expect(res).toEqual({ committed: true, seq: 1 });
    expect(sender).toHaveBeenCalledWith(expect.objectContaining({ t: "committed", seq: 1 }));
    expect(other).toHaveBeenCalledWith(expect.objectContaining({ t: "entry" }));
  });

  it("denies an illegal command to the sender only", async () => {
    const t = table();
    const sender = vi.fn();
    const res = await t.submit({ kind: "move", actorId: "nobody" as never, roomId: "nowhere" as never }, sender);
    expect(res).toEqual({ committed: false });
    expect(sender).toHaveBeenCalledWith(expect.objectContaining({ t: "denied" }));
    expect(t.head()).toBe(0);
  });

  it("persists before acking, then broadcasts (flush-before-ack)", async () => {
    const t = table(); // existing helper building a Table from an Authority(demoGenesis())
    const order: string[] = [];
    t.setDurability({ persist: () => { order.push("persist"); return Promise.resolve(); }, reload: () => Promise.resolve() });
    const sender = vi.fn(() => order.push("ack"));
    await t.submit({ kind: "nextPlayer" }, sender);
    expect(order).toEqual(["persist", "ack"]); // persisted before the committed ack
  });

  it("rolls back and denies when persist fails; head unchanged", async () => {
    const t = table();
    t.setDurability({ persist: () => Promise.reject(new Error("disk full")), reload: () => Promise.resolve() });
    const sender = vi.fn();
    const res = await t.submit({ kind: "nextPlayer" }, sender);
    expect(res).toEqual({ committed: false });
    expect(sender).toHaveBeenCalledWith(expect.objectContaining({ t: "denied" }));
    expect(t.head()).toBe(0); // no commit acked; reload (no-op here) leaves head at genesis
  });
});
