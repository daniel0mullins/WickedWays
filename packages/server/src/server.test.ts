import { describe, it, expect, afterEach } from "vitest";
import { WebSocket } from "ws";
import { parseServerMsg, type ServerMsg, type WireLogEntry } from "@wickedways/transport-shared";
import { createServer, type ServerHandle } from "./server.js";

let handle: ServerHandle | null = null;
afterEach(async () => {
  await handle?.close();
  handle = null;
});

/** Opens a ws client to the running server and resolves once it is open. */
function open(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve(ws));
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    ws.addEventListener("error", (e) => reject(e));
  });
}

/** Collects the next `n` parsed server messages from a socket. */
function collect(ws: WebSocket, n: number): Promise<ServerMsg[]> {
  return new Promise((resolve) => {
    const out: ServerMsg[] = [];
    const onMsg = (ev: { data: unknown }) => {
      const msg = parseServerMsg(JSON.parse(String(ev.data)));
      if (msg) out.push(msg);
      if (out.length >= n) {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
        ws.removeEventListener("message", onMsg as never);
        resolve(out);
      }
    };
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    ws.addEventListener("message", onMsg as never);
  });
}

const entry = (seq: number, baseSeq: number): WireLogEntry => ({
  seq, baseSeq, command: { kind: "noop" }, delta: { changed: [] },
});

describe("createServer", () => {
  it("acks a join with the current head", async () => {
    handle = await createServer({ port: 0, verifyToken: (t) => t || null });
    const a = await open(handle.port);
    const got = collect(a, 1);
    a.send(JSON.stringify({ t: "join", campaignId: "c1", token: "ada", fromSeq: 0 }));
    expect(await got).toEqual([{ t: "joined", head: 0 }]);
    a.close();
  });

  it("commits an append, acks the sender, and broadcasts the entry to all subscribers", async () => {
    handle = await createServer({ port: 0, verifyToken: (t) => t || null });
    const a = await open(handle.port);
    const b = await open(handle.port);
    a.send(JSON.stringify({ t: "join", campaignId: "c1", token: "ada", fromSeq: 0 }));
    b.send(JSON.stringify({ t: "join", campaignId: "c1", token: "bob", fromSeq: 0 }));
    await collect(a, 1); // joined
    await collect(b, 1); // joined

    const bEntry = collect(b, 1);
    const aReplies = collect(a, 2); // appendOk + own-entry broadcast
    a.send(JSON.stringify({ t: "append", campaignId: "c1", entry: entry(1, 0), actor: { kind: "gm" } }));

    expect(await bEntry).toEqual([{ t: "entry", entry: { ...entry(1, 0) } }]);
    const replies = await aReplies;
    expect(replies).toContainEqual({ t: "appendOk", seq: 1 });
    expect(replies).toContainEqual({ t: "entry", entry: { ...entry(1, 0) } });
    a.close();
    b.close();
  });

  it("rejects a stale-base append as a conflict reporting head", async () => {
    handle = await createServer({ port: 0, verifyToken: (t) => t || null });
    const a = await open(handle.port);
    a.send(JSON.stringify({ t: "join", campaignId: "c1", token: "ada", fromSeq: 0 }));
    await collect(a, 1);
    a.send(JSON.stringify({ t: "append", campaignId: "c1", entry: entry(1, 0), actor: { kind: "gm" } }));
    await collect(a, 2); // appendOk + entry
    const conflict = collect(a, 1);
    a.send(JSON.stringify({ t: "append", campaignId: "c1", entry: entry(2, 0), actor: { kind: "gm" } })); // stale base
    expect(await conflict).toEqual([{ t: "appendConflict", head: 1 }]);
    a.close();
  });

  it("backfills entries since fromSeq on join", async () => {
    handle = await createServer({ port: 0, verifyToken: (t) => t || null });
    const a = await open(handle.port);
    a.send(JSON.stringify({ t: "join", campaignId: "c1", token: "ada", fromSeq: 0 }));
    await collect(a, 1);
    a.send(JSON.stringify({ t: "append", campaignId: "c1", entry: entry(1, 0), actor: { kind: "gm" } }));
    a.send(JSON.stringify({ t: "append", campaignId: "c1", entry: entry(2, 1), actor: { kind: "gm" } }));
    await collect(a, 4); // 2x (appendOk + entry)

    const b = await open(handle.port);
    const bMsgs = collect(b, 3); // joined + 2 backfilled entries
    b.send(JSON.stringify({ t: "join", campaignId: "c1", token: "bob", fromSeq: 0 }));
    const msgs = await bMsgs;
    expect(msgs[0]).toEqual({ t: "joined", head: 2 });
    expect(msgs.slice(1)).toEqual([
      { t: "entry", entry: { ...entry(1, 0) } },
      { t: "entry", entry: { ...entry(2, 1) } },
    ]);
    a.close();
    b.close();
  });

  it("round-trips a snapshot and replies null when absent", async () => {
    handle = await createServer({ port: 0, verifyToken: (t) => t || null });
    const a = await open(handle.port);
    const none = collect(a, 1);
    a.send(JSON.stringify({ t: "getSnapshot", campaignId: "c1" }));
    expect(await none).toEqual([{ t: "snapshot", seq: 0, snapshot: null }]);

    a.send(JSON.stringify({ t: "join", campaignId: "c1", token: "ada", fromSeq: 0 }));
    await collect(a, 1); // joined
    a.send(JSON.stringify({ t: "putSnapshot", campaignId: "c1", seq: 2, snapshot: { tag: "two" } }));
    const got = collect(a, 1);
    a.send(JSON.stringify({ t: "getSnapshot", campaignId: "c1" }));
    expect(await got).toEqual([{ t: "snapshot", seq: 2, snapshot: { tag: "two" } }]);
    a.close();
  });

  it("replies error on malformed input without crashing the room", async () => {
    handle = await createServer({ port: 0, verifyToken: (t) => t || null });
    const a = await open(handle.port);
    const err = collect(a, 1);
    a.send("not json");
    expect(await err).toEqual([{ t: "error", message: "Invalid JSON" }]);
    a.close();
  });

  it("denies a join with an empty token and does not join the room", async () => {
    handle = await createServer({ port: 0, verifyToken: (t) => t || null });
    const a = await open(handle.port);
    const got = collect(a, 1);
    a.send(JSON.stringify({ t: "join", campaignId: "c1", token: "", fromSeq: 0 }));
    expect(await got).toEqual([{ t: "denied", reason: "authentication failed" }]);
    a.close();
  });

  it("denies an append before any join (not authenticated)", async () => {
    handle = await createServer({ port: 0, verifyToken: (t) => t || null });
    const a = await open(handle.port);
    const got = collect(a, 1);
    a.send(JSON.stringify({ t: "append", campaignId: "c1", entry: entry(1, 0), actor: { kind: "gm" } }));
    expect(await got).toEqual([{ t: "denied", reason: "not authenticated" }]);
    a.close();
  });
});
