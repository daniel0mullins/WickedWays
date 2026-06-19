import { describe, it, expect } from "vitest";
import type { WireLogEntry, ServerMsg } from "@wickedways/transport-shared";
import { Table, type Subscriber } from "./table.js";

const entry = (seq: number, baseSeq: number): WireLogEntry => ({
  seq, baseSeq, command: { kind: "noop" }, delta: { changed: [], created: [], removed: [] },
});

/** A fake participant that records the messages it receives. */
function recorder(): { sub: Subscriber; msgs: ServerMsg[] } {
  const msgs: ServerMsg[] = [];
  return { sub: (m) => msgs.push(m), msgs };
}

describe("Table", () => {
  it("acks a join with the current head", () => {
    const t = new Table();
    const a = recorder();
    t.join(a.sub, 0);
    expect(a.msgs).toEqual([{ t: "joined", head: 0 }]);
  });

  it("commits an append, acks the sender, and broadcasts the entry to all participants", () => {
    const t = new Table();
    const a = recorder();
    const b = recorder();
    t.join(a.sub, 0);
    t.join(b.sub, 0);
    a.msgs.length = 0;
    b.msgs.length = 0;

    expect(t.append(entry(1, 0), a.sub)).toEqual({ committed: true, seq: 1 });

    expect(a.msgs).toEqual([{ t: "appendOk", seq: 1 }, { t: "entry", entry: entry(1, 0) }]);
    expect(b.msgs).toEqual([{ t: "entry", entry: entry(1, 0) }]);
    expect(t.head()).toBe(1);
  });

  it("rejects a stale-base append as a conflict to the sender only", () => {
    const t = new Table();
    const a = recorder();
    const b = recorder();
    t.join(a.sub, 0);
    t.join(b.sub, 0);
    t.append(entry(1, 0), a.sub);
    a.msgs.length = 0;
    b.msgs.length = 0;

    expect(t.append(entry(2, 0), a.sub)).toEqual({ committed: false }); // stale base

    expect(a.msgs).toEqual([{ t: "appendConflict", head: 1 }]);
    expect(b.msgs).toEqual([]); // no broadcast
    expect(t.head()).toBe(1); // unchanged
  });

  it("backfills entries strictly after fromSeq on join", () => {
    const t = new Table();
    const a = recorder();
    t.join(a.sub, 0);
    t.append(entry(1, 0), a.sub);
    t.append(entry(2, 1), a.sub);

    const b = recorder();
    t.join(b.sub, 0);
    expect(b.msgs).toEqual([
      { t: "joined", head: 2 },
      { t: "entry", entry: entry(1, 0) },
      { t: "entry", entry: entry(2, 1) },
    ]);
  });

  it("does not broadcast to a participant that has left", () => {
    const t = new Table();
    const a = recorder();
    const b = recorder();
    t.join(a.sub, 0);
    t.join(b.sub, 0);
    t.leave(b.sub);
    b.msgs.length = 0;

    t.append(entry(1, 0), a.sub);
    expect(b.msgs).toEqual([]);
  });

  it("sends the latest snapshot, or seq 0 / null when absent; lower-seq puts do not overwrite", () => {
    const t = new Table();
    const a = recorder();
    t.sendSnapshot(a.sub);
    expect(a.msgs).toEqual([{ t: "snapshot", seq: 0, snapshot: null }]);

    t.putSnapshot(5, { tag: "five" });
    t.putSnapshot(3, { tag: "three" }); // ignored (lower seq)
    a.msgs.length = 0;
    t.sendSnapshot(a.sub);
    expect(a.msgs).toEqual([{ t: "snapshot", seq: 5, snapshot: { tag: "five" } }]);
  });
});
