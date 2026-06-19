import { describe, it, expect, vi } from "vitest";
import { Authority } from "wickedways/lib/sync/authority";
import { Table } from "./table.js";
import { demoGenesis, buildSeedRegistry } from "@wickedways/seed";

function table() {
  return new Table(new Authority(demoGenesis(), { registry: buildSeedRegistry(), rng: () => 0.5 }));
}

describe("Table", () => {
  it("acks the submitter with committed and broadcasts entry to others", () => {
    const t = table();
    const sender = vi.fn();
    const other = vi.fn();
    t.join(other, 0);
    t.join(sender, 0);
    other.mockClear();
    const res = t.submit({ kind: "nextPlayer" }, sender);
    expect(res).toEqual({ committed: true, seq: 1 });
    expect(sender).toHaveBeenCalledWith(expect.objectContaining({ t: "committed", seq: 1 }));
    expect(other).toHaveBeenCalledWith(expect.objectContaining({ t: "entry" }));
  });

  it("denies an illegal command to the sender only", () => {
    const t = table();
    const sender = vi.fn();
    const res = t.submit({ kind: "move", actorId: "nobody" as never, roomId: "nowhere" as never }, sender);
    expect(res).toEqual({ committed: false });
    expect(sender).toHaveBeenCalledWith(expect.objectContaining({ t: "denied" }));
    expect(t.head()).toBe(0);
  });
});
