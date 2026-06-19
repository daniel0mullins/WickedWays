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
    handle = await createServer({ port: 0, verifyToken: (t) => t || null, gmIdentityFor: () => "gm" });
    const a = await open(handle.port);
    const got = collect(a, 1);
    a.send(JSON.stringify({ t: "join", campaignId: "c1", token: "ada", fromSeq: 0 }));
    expect(await got).toEqual([{ t: "joined", head: 0 }]);
    a.close();
  });

  it("commits an append, acks the sender, and broadcasts the entry to all subscribers", async () => {
    handle = await createServer({ port: 0, verifyToken: (t) => t || null, gmIdentityFor: () => "gm" });
    const a = await open(handle.port);
    const b = await open(handle.port);
    a.send(JSON.stringify({ t: "join", campaignId: "c1", token: "gm", fromSeq: 0 }));
    b.send(JSON.stringify({ t: "join", campaignId: "c1", token: "bob", fromSeq: 0 }));
    // a gets: joined + presence(gm) + presence(gm+bob); b gets: joined + presence(gm+bob)
    await collect(a, 3); // joined + 2 presences
    await collect(b, 2); // joined + presence

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
    handle = await createServer({ port: 0, verifyToken: (t) => t || null, gmIdentityFor: () => "gm" });
    const a = await open(handle.port);
    a.send(JSON.stringify({ t: "join", campaignId: "c1", token: "gm", fromSeq: 0 }));
    await collect(a, 2); // joined + presence
    a.send(JSON.stringify({ t: "append", campaignId: "c1", entry: entry(1, 0), actor: { kind: "gm" } }));
    await collect(a, 2); // appendOk + entry
    const conflict = collect(a, 1);
    a.send(JSON.stringify({ t: "append", campaignId: "c1", entry: entry(2, 0), actor: { kind: "gm" } })); // stale base
    expect(await conflict).toEqual([{ t: "appendConflict", head: 1 }]);
    a.close();
  });

  it("backfills entries since fromSeq on join", async () => {
    handle = await createServer({ port: 0, verifyToken: (t) => t || null, gmIdentityFor: () => "gm" });
    const a = await open(handle.port);
    a.send(JSON.stringify({ t: "join", campaignId: "c1", token: "gm", fromSeq: 0 }));
    // joined + presence; then 2x (appendOk + entry) = 6 total but presence(gm) is first
    // Drain enough to ensure both appends committed before b joins
    await collect(a, 2); // joined + presence
    a.send(JSON.stringify({ t: "append", campaignId: "c1", entry: entry(1, 0), actor: { kind: "gm" } }));
    a.send(JSON.stringify({ t: "append", campaignId: "c1", entry: entry(2, 1), actor: { kind: "gm" } }));
    await collect(a, 4); // appendOk(1) + entry(1) + appendOk(2) + entry(2)

    const b = await open(handle.port);
    const bMsgs = collect(b, 3); // joined + 2 backfilled entries (presence is 4th, not collected here)
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
    handle = await createServer({ port: 0, verifyToken: (t) => t || null, gmIdentityFor: () => "gm" });
    const a = await open(handle.port);
    const none = collect(a, 1);
    a.send(JSON.stringify({ t: "getSnapshot", campaignId: "c1" }));
    expect(await none).toEqual([{ t: "snapshot", seq: 0, snapshot: null }]);

    a.send(JSON.stringify({ t: "join", campaignId: "c1", token: "ada", fromSeq: 0 }));
    await collect(a, 2); // joined + presence
    a.send(JSON.stringify({ t: "putSnapshot", campaignId: "c1", seq: 2, snapshot: { tag: "two" } }));
    const got = collect(a, 1);
    a.send(JSON.stringify({ t: "getSnapshot", campaignId: "c1" }));
    expect(await got).toEqual([{ t: "snapshot", seq: 2, snapshot: { tag: "two" } }]);
    a.close();
  });

  it("replies error on malformed input without crashing the room", async () => {
    handle = await createServer({ port: 0, verifyToken: (t) => t || null, gmIdentityFor: () => "gm" });
    const a = await open(handle.port);
    const err = collect(a, 1);
    a.send("not json");
    expect(await err).toEqual([{ t: "error", message: "Invalid JSON" }]);
    a.close();
  });

  it("denies a join with an empty token and does not join the room", async () => {
    handle = await createServer({ port: 0, verifyToken: (t) => t || null, gmIdentityFor: () => "gm" });
    const a = await open(handle.port);
    const got = collect(a, 1);
    a.send(JSON.stringify({ t: "join", campaignId: "c1", token: "", fromSeq: 0 }));
    expect(await got).toEqual([{ t: "denied", reason: "authentication failed" }]);
    a.close();
  });

  it("denies an append before any join (not authenticated)", async () => {
    handle = await createServer({ port: 0, verifyToken: (t) => t || null, gmIdentityFor: () => "gm" });
    const a = await open(handle.port);
    const got = collect(a, 1);
    a.send(JSON.stringify({ t: "append", campaignId: "c1", entry: entry(1, 0), actor: { kind: "gm" } }));
    expect(await got).toEqual([{ t: "denied", reason: "not authenticated" }]);
    a.close();
  });

  it("denies an append whose seat the connection does not own", async () => {
    handle = await createServer({ port: 0, verifyToken: (t) => t || null, gmIdentityFor: () => "gm" });
    const a = await open(handle.port);
    a.send(JSON.stringify({ t: "join", campaignId: "c1", token: "ada", fromSeq: 0 }));
    await collect(a, 2); // joined + presence
    const denied = collect(a, 1);
    // "ada" does not own character "cBen"
    a.send(JSON.stringify({ t: "append", campaignId: "c1", entry: entry(1, 0), actor: { kind: "character", actorId: "cBen" } }));
    expect(await denied).toEqual([{ t: "denied", reason: "not authorized for this seat" }]);
    a.close();
  });

  it("self-service join binds the seat; a second join for it is denied (no hijack)", async () => {
    handle = await createServer({ port: 0, verifyToken: (t) => t || null, gmIdentityFor: () => "gm" });
    const a = await open(handle.port);
    a.send(JSON.stringify({ t: "join", campaignId: "c1", token: "ada", fromSeq: 0 }));
    await collect(a, 2); // joined + presence
    // ada self-claims character "cAda" via a join-actor append
    // collect all 3 replies at once: appendOk + entry + presence(seat claim)
    // ws may deliver all 3 in one TCP segment; chaining collect(2) then collect(1) would race
    const ok = collect(a, 3); // appendOk + entry + presence from claim
    a.send(JSON.stringify({ t: "append", campaignId: "c1", entry: entry(1, 0), actor: { kind: "join", characterId: "cAda" } }));
    const okMsgs = await ok;
    expect(okMsgs).toContainEqual({ t: "appendOk", seq: 1 });
    // now ada owns cAda and can act as it
    const act = collect(a, 2); // appendOk + entry (no presence for character actor)
    a.send(JSON.stringify({ t: "append", campaignId: "c1", entry: entry(2, 1), actor: { kind: "character", actorId: "cAda" } }));
    await act;
    // ben cannot hijack cAda via join
    const b = await open(handle.port);
    b.send(JSON.stringify({ t: "join", campaignId: "c1", token: "ben", fromSeq: 0 }));
    await collect(b, 4); // joined + backfill entries 1 and 2 + presence
    const hijack = collect(b, 1);
    b.send(JSON.stringify({ t: "append", campaignId: "c1", entry: entry(2, 2), actor: { kind: "join", characterId: "cAda" } }));
    expect(await hijack).toEqual([{ t: "denied", reason: "not authorized for this seat" }]);
    a.close(); b.close();
  });

  it("gm actions require the GM identity; non-GM control messages are denied", async () => {
    handle = await createServer({ port: 0, verifyToken: (t) => t || null, gmIdentityFor: () => "gm" });
    const g = await open(handle.port);
    g.send(JSON.stringify({ t: "join", campaignId: "c1", token: "gm", fromSeq: 0 }));
    await collect(g, 2); // joined + presence
    const gmOk = collect(g, 2); // appendOk + entry
    g.send(JSON.stringify({ t: "append", campaignId: "c1", entry: entry(1, 0), actor: { kind: "gm" } }));
    await gmOk;

    const p = await open(handle.port);
    p.send(JSON.stringify({ t: "join", campaignId: "c1", token: "ada", fromSeq: 0 }));
    await collect(p, 3); // joined + backfill entry + presence
    const denyGm = collect(p, 1);
    p.send(JSON.stringify({ t: "append", campaignId: "c1", entry: entry(2, 1), actor: { kind: "gm" } }));
    expect(await denyGm).toEqual([{ t: "denied", reason: "not authorized for this seat" }]);
    const denyCtl = collect(p, 1);
    p.send(JSON.stringify({ t: "assignSeat", campaignId: "c1", characterId: "cX", identity: "ada" }));
    expect(await denyCtl).toEqual([{ t: "denied", reason: "GM only" }]);
    g.close(); p.close();
  });

  it("broadcasts presence on join, seat-claim, and disconnect", async () => {
    handle = await createServer({ port: 0, verifyToken: (t) => t || null, gmIdentityFor: () => "gm" });
    const g = await open(handle.port);
    const gMsgs = collect(g, 2); // joined + presence
    g.send(JSON.stringify({ t: "join", campaignId: "c1", token: "gm", fromSeq: 0 }));
    const got = await gMsgs;
    expect(got).toContainEqual({ t: "presence", campaignId: "c1", seats: [], gm: { identity: "gm", online: true } });

    // ada joins + self-claims cAda -> presence shows the seat owned + online
    // Set up g's collector BEFORE a's join to avoid the cross-socket race
    // g gets: presence(ada joined) + entry(1) + presence(cAda claimed) = 3 msgs total
    const a = await open(handle.port);
    const claimP = collect(g, 3); // must start listening before a sends join
    const aMsgs = collect(a, 2); // joined + presence
    a.send(JSON.stringify({ t: "join", campaignId: "c1", token: "ada", fromSeq: 0 }));
    await aMsgs;
    // drain a's messages from join then send the claim append
    a.send(JSON.stringify({ t: "append", campaignId: "c1", entry: entry(1, 0), actor: { kind: "join", characterId: "cAda" } }));
    const after = await claimP;
    expect(after).toContainEqual({ t: "presence", campaignId: "c1", seats: [{ characterId: "cAda", owner: "ada", online: true }], gm: { identity: "gm", online: true } });
    g.close(); a.close();
  });

  it("an identity stays online while any of its connections is live", async () => {
    handle = await createServer({ port: 0, verifyToken: (t) => t || null, gmIdentityFor: () => "gm" });
    const g = await open(handle.port);
    g.send(JSON.stringify({ t: "join", campaignId: "c1", token: "gm", fromSeq: 0 }));
    await collect(g, 2); // joined + presence(gm only)
    const a1 = await open(handle.port);
    // Set up g's collector before a1's join to avoid cross-socket race
    const gA1Presence = collect(g, 1); // g gets presence(gm+ada) when a1 joins
    a1.send(JSON.stringify({ t: "join", campaignId: "c1", token: "ada", fromSeq: 0 }));
    await collect(a1, 2); // joined + presence
    await gA1Presence;
    const a2 = await open(handle.port);
    // Set up g's collector before a2's join to avoid cross-socket race
    const gA2Presence = collect(g, 1); // g gets presence(gm+ada x2) when a2 joins
    a2.send(JSON.stringify({ t: "join", campaignId: "c1", token: "ada", fromSeq: 0 }));
    await collect(a2, 2); // joined + presence
    await gA2Presence;
    // assign a seat to ada so presence has an entry to report online state for
    const gAssignPresence = collect(g, 1); // presence from assignSeat
    g.send(JSON.stringify({ t: "assignSeat", campaignId: "c1", characterId: "cAda", identity: "ada" }));
    await gAssignPresence;
    const afterClose = collect(g, 1); // presence after a1 closes
    a1.close();
    const p = await afterClose;
    expect(p).toEqual([{ t: "presence", campaignId: "c1", seats: [{ characterId: "cAda", owner: "ada", online: true }], gm: { identity: "gm", online: true } }]); // still online via a2
    g.close(); a2.close();
  });

  it("GM assignSeat lets the assigned identity act; unassign revokes", async () => {
    handle = await createServer({ port: 0, verifyToken: (t) => t || null, gmIdentityFor: () => "gm" });
    const g = await open(handle.port);
    g.send(JSON.stringify({ t: "join", campaignId: "c1", token: "gm", fromSeq: 0 }));
    await collect(g, 2); // joined + presence
    g.send(JSON.stringify({ t: "assignSeat", campaignId: "c1", characterId: "cAda", identity: "ada" }));
    await collect(g, 1); // presence from assignSeat

    const a = await open(handle.port);
    a.send(JSON.stringify({ t: "join", campaignId: "c1", token: "ada", fromSeq: 0 }));
    await collect(a, 2); // joined + presence
    const ok = collect(a, 2); // appendOk + entry
    a.send(JSON.stringify({ t: "append", campaignId: "c1", entry: entry(1, 0), actor: { kind: "character", actorId: "cAda" } }));
    await ok; // ada can act as cAda

    // unassignSeat broadcasts presence to all participants (g + a); then a's denied append follows
    g.send(JSON.stringify({ t: "unassignSeat", campaignId: "c1", characterId: "cAda" }));
    await collect(a, 1); // presence from unassignSeat
    const denied = collect(a, 1);
    a.send(JSON.stringify({ t: "append", campaignId: "c1", entry: entry(2, 1), actor: { kind: "character", actorId: "cAda" } }));
    expect(await denied).toEqual([{ t: "denied", reason: "not authorized for this seat" }]);
    g.close(); a.close();
  });
});
