import { describe, it, expect } from "vitest";
import { InProcessTransport } from "./transport";
import type { LogEntry } from "./types";

const entry = (seq: number, baseSeq: number): LogEntry =>
  ({ seq, baseSeq, command: { kind: "nextPlayer" }, delta: { changed: [], created: [], removed: [] } });

describe("InProcessTransport", () => {
  it("accepts an append when baseSeq matches head and advances head", () => {
    const t = new InProcessTransport();
    expect(t.head()).toBe(0);
    expect(t.append(entry(1, 0))).toEqual({ ok: true });
    expect(t.head()).toBe(1);
  });

  it("rejects a stale append as a conflict and reports the current head", () => {
    const t = new InProcessTransport();
    t.append(entry(1, 0));
    expect(t.append(entry(2, 0))).toEqual({ ok: false, conflict: true, head: 1 });
    expect(t.head()).toBe(1);
  });

  it("subscribe replays from the requested seq, then streams new entries in order", () => {
    const t = new InProcessTransport();
    t.append(entry(1, 0));
    t.append(entry(2, 1));
    const seen: number[] = [];
    t.subscribe(2, (e) => seen.push(e.seq));
    expect(seen).toEqual([2]);
    t.append(entry(3, 2));
    expect(seen).toEqual([2, 3]);
  });

  it("stores and loads the latest snapshot", () => {
    const t = new InProcessTransport();
    expect(t.loadSnapshot()).toBeNull();
    const snap = { schemaVersion: 1 } as never;
    t.putSnapshot(5, snap);
    expect(t.loadSnapshot()).toEqual({ seq: 5, snapshot: snap });
  });
});
