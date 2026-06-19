import { describe, it, expect, afterEach } from "vitest";
import { WebSocket } from "ws";
import { createServer, type ServerHandle } from "@wickedways/server";
import type { LogEntry } from "wickedways/lib/sync/types";
import { WebSocketTransport, type WebSocketFactory } from "./websocket-transport.js";

const nodeFactory: WebSocketFactory = (url) => new WebSocket(url);

let handle: ServerHandle | null = null;
const transports: WebSocketTransport[] = [];
afterEach(async () => {
  for (const t of transports) t.close();
  transports.length = 0;
  await handle?.close();
  handle = null;
});

async function connect(campaignId: string, token: string): Promise<WebSocketTransport> {
  const t = await WebSocketTransport.connect({
    url: `ws://127.0.0.1:${handle!.port}`,
    campaignId,
    token,
    factory: nodeFactory,
  });
  transports.push(t);
  return t;
}

const entry = (seq: number, baseSeq: number): LogEntry =>
  ({ seq, baseSeq, command: { kind: "nextPlayer" }, delta: { changed: [], created: [], removed: [] } }) as unknown as LogEntry;

describe("WebSocketTransport", () => {
  it("connects warm at head 0 with no snapshot", async () => {
    handle = await createServer({ port: 0, verifyToken: (t) => t || null, gmIdentityFor: () => "gm" });
    const a = await connect("c1", "a");
    expect(a.head()).toBe(0);
    expect(a.loadSnapshot()).toBeNull();
  });

  it("appends under CAS and reflects the committed entry in its own mirror", async () => {
    handle = await createServer({ port: 0, verifyToken: (t) => t || null, gmIdentityFor: () => "gm" });
    const a = await connect("c1", "gm");
    const res = await a.append(entry(1, 0));
    expect(res).toEqual({ ok: true });
    expect(a.head()).toBe(1);
    expect(a.entriesSince(1).map((e) => e.seq)).toEqual([1]);
  });

  it("delivers a peer's committed entry to a subscriber", async () => {
    handle = await createServer({ port: 0, verifyToken: (t) => t || null, gmIdentityFor: () => "gm" });
    const a = await connect("c1", "gm");
    const b = await connect("c1", "b");
    const seen: number[] = [];
    b.subscribe(b.head() + 1, (e) => seen.push(e.seq));
    await a.append(entry(1, 0));
    await vi_tick();
    expect(seen).toEqual([1]);
    expect(b.head()).toBe(1);
  });

  it("reports a CAS conflict and brings the mirror up to head before resolving", async () => {
    handle = await createServer({ port: 0, verifyToken: (t) => t || null, gmIdentityFor: () => "gm" });
    const a = await connect("c1", "gm");
    const b = await connect("c1", "gm"); // same identity as a, both are GM
    await a.append(entry(1, 0)); // commits seq 1; b receives it via broadcast
    await vi_tick();
    // b still thinks base 0 is current and submits against it -> conflict
    const res = await b.append(entry(1, 0));
    expect(res).toEqual({ ok: false, conflict: true, head: 1 });
    expect(b.entriesSince(1).map((e) => e.seq)).toEqual([1]); // foreign entry present
  });

  it("late-joins from a stored snapshot and backfills entries since", async () => {
    handle = await createServer({ port: 0, verifyToken: (t) => t || null, gmIdentityFor: () => "gm" });
    const a = await connect("c1", "gm");
    a.putSnapshot(0, { schemaVersion: 1, tag: "seed" } as never);
    await a.append(entry(1, 0));
    await a.append(entry(2, 1));
    await vi_tick();

    const b = await connect("c1", "b");
    expect(b.loadSnapshot()).toEqual({ seq: 0, snapshot: { schemaVersion: 1, tag: "seed" } });
    expect(b.head()).toBe(2);
    expect(b.entriesSince(1).map((e) => e.seq)).toEqual([1, 2]);
  });
});

/** Flush microtasks + a macrotask so broadcast messages are delivered. */
function vi_tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 10));
}
