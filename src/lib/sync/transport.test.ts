import { describe, it, expect } from "vitest";
import { InProcessTransport } from "./transport";
import type { LogEntry } from "./types";

const entry = (seq: number, baseSeq: number): LogEntry =>
  ({ seq, baseSeq, command: { kind: "nextPlayer" }, delta: { changed: [], created: [], removed: [] } });

describe("InProcessTransport", () => {
  it("accepts an append when baseSeq matches head and advances head", async () => {
    const t = new InProcessTransport();
    expect(t.head()).toBe(0);
    expect(await t.append(entry(1, 0))).toEqual({ ok: true });
    expect(t.head()).toBe(1);
  });

  it("rejects a stale append as a conflict and reports the current head", async () => {
    const t = new InProcessTransport();
    await t.append(entry(1, 0));
    expect(await t.append(entry(2, 0))).toEqual({ ok: false, conflict: true, head: 1 });
    expect(t.head()).toBe(1);
  });

  it("subscribe replays from the requested seq, then streams new entries in order", async () => {
    const t = new InProcessTransport();
    await t.append(entry(1, 0));
    await t.append(entry(2, 1));
    const seen: number[] = [];
    t.subscribe(2, (e) => seen.push(e.seq));
    expect(seen).toEqual([2]);
    await t.append(entry(3, 2));
    expect(seen).toEqual([2, 3]);
  });

  it("stores and loads the latest snapshot", () => {
    const t = new InProcessTransport();
    expect(t.loadSnapshot()).toBeNull();
    const snap = { schemaVersion: 1 } as never;
    t.putSnapshot(5, snap);
    expect(t.loadSnapshot()).toEqual({ seq: 5, snapshot: snap });
  });

  it("unsubscribe thunk stops delivery of subsequent entries", async () => {
    const t = new InProcessTransport();
    await t.append(entry(1, 0));
    const received: number[] = [];
    const unsub = t.subscribe(2, (e) => received.push(e.seq));
    // Nothing in [2..] yet — handler not called on subscribe.
    expect(received).toEqual([]);
    unsub();
    // Append after unsubscribe — handler must NOT fire.
    await t.append(entry(2, 1));
    expect(received).toEqual([]);
  });

  it("putSnapshot lower-seq guard: a stale put does not overwrite a higher checkpoint", () => {
    const t = new InProcessTransport();
    const snapA = { schemaVersion: 1, _tag: "A" } as never;
    const snapB = { schemaVersion: 1, _tag: "B" } as never;
    t.putSnapshot(5, snapA);
    t.putSnapshot(3, snapB); // lower seq — must not overwrite
    expect(t.loadSnapshot()).toEqual({ seq: 5, snapshot: snapA });
  });
});
