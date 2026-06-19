import { describe, it, expect, afterEach } from "vitest";
import { WebSocket } from "ws";
import { parseServerMsg, type ServerMsg } from "@wickedways/transport-shared";
import { buildSeedCampaign, buildSeedRegistry } from "@wickedways/seed";
import { serializeCampaign } from "wickedways/lib/serialization/serializer";
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

/**
 * Build the genesis snapshot ONCE so every test that acts as a specific seat uses
 * the same character ids. buildSeedCampaign() mints fresh uuid character ids on every
 * call; serializeCampaign preserves ids, so the server's Authority gets exactly those
 * seats.
 *
 * The seed campaign has beginCampaign() called: Ada is the active character (can move
 * to "Next"); after nextPlayer, Ben is active.
 */
function seedFixture() {
  const seed = buildSeedCampaign();
  const genesis = serializeCampaign(seed.campaign);
  const adaId = seed.campaign.activeCharacter.id;
  const benId = seed.campaign.party.find((p) => p.id !== adaId)!.id;
  const nextRoomId = genesis.rooms.find((r) => r.name === "Next")!.id;
  return { genesis, adaId, benId, nextRoomId };
}

/** Standard server opts for most tests, using a given genesis snapshot. */
function serverOpts(genesis: ReturnType<typeof seedFixture>["genesis"]) {
  return {
    port: 0 as const,
    verifyToken: (t: string) => t || null,
    gmIdentityFor: () => "gm" as const,
    registry: buildSeedRegistry(),
    genesisFor: (id: string) => (id === "demo" ? genesis : null),
  };
}

describe("createServer", () => {
  it("acks a join with the current head", async () => {
    const { genesis } = seedFixture();
    handle = await createServer(serverOpts(genesis));
    const a = await open(handle.port);
    const got = collect(a, 1);
    a.send(JSON.stringify({ t: "join", campaignId: "demo", token: "gm", fromSeq: 0 }));
    expect(await got).toEqual([{ t: "joined", head: 0 }]);
    a.close();
  });

  it("commits a submit, acks the sender with committed, and broadcasts entry to others", async () => {
    const { genesis } = seedFixture();
    handle = await createServer(serverOpts(genesis));
    const a = await open(handle.port);
    const b = await open(handle.port);
    a.send(JSON.stringify({ t: "join", campaignId: "demo", token: "gm", fromSeq: 0 }));
    b.send(JSON.stringify({ t: "join", campaignId: "demo", token: "bob", fromSeq: 0 }));
    // a gets: joined + presence(gm) + presence(gm+bob); b gets: joined + presence(gm+bob)
    await collect(a, 3);
    await collect(b, 2);

    const bEntry = collect(b, 1);
    const aReplies = collect(a, 1); // committed
    a.send(JSON.stringify({ t: "submit", campaignId: "demo", command: { kind: "nextPlayer" } }));

    const replies = await aReplies;
    expect(replies[0]).toMatchObject({ t: "committed", seq: 1 });
    expect(await bEntry).toEqual([expect.objectContaining({ t: "entry" })]);
    a.close();
    b.close();
  });

  it("denies join for an unknown campaign", async () => {
    const { genesis } = seedFixture();
    handle = await createServer(serverOpts(genesis));
    const a = await open(handle.port);
    const got = collect(a, 1);
    a.send(JSON.stringify({ t: "join", campaignId: "unknown-campaign", token: "gm", fromSeq: 0 }));
    expect(await got).toEqual([{ t: "denied", reason: "unknown campaign" }]);
    a.close();
  });

  it("backfills entries since fromSeq on join", async () => {
    const { genesis } = seedFixture();
    handle = await createServer(serverOpts(genesis));
    const a = await open(handle.port);
    a.send(JSON.stringify({ t: "join", campaignId: "demo", token: "gm", fromSeq: 0 }));
    await collect(a, 2); // joined + presence
    a.send(JSON.stringify({ t: "submit", campaignId: "demo", command: { kind: "nextPlayer" } }));
    a.send(JSON.stringify({ t: "submit", campaignId: "demo", command: { kind: "nextPlayer" } }));
    await collect(a, 2); // committed(1) + committed(2)

    const b = await open(handle.port);
    // b gets: joined(head=2) + entry(1) + entry(2) + presence
    const bMsgs = collect(b, 3);
    b.send(JSON.stringify({ t: "join", campaignId: "demo", token: "bob", fromSeq: 0 }));
    const msgs = await bMsgs;
    expect(msgs[0]).toEqual({ t: "joined", head: 2 });
    expect(msgs[1]).toMatchObject({ t: "entry" });
    expect(msgs[2]).toMatchObject({ t: "entry" });
    a.close();
    b.close();
  });

  it("getSnapshot returns a snapshot", async () => {
    const { genesis } = seedFixture();
    handle = await createServer(serverOpts(genesis));
    const a = await open(handle.port);
    const got = collect(a, 1);
    a.send(JSON.stringify({ t: "getSnapshot", campaignId: "demo" }));
    const msgs = await got;
    expect(msgs[0]).toMatchObject({ t: "snapshot", seq: 0 });
    a.close();
  });

  it("replies error on malformed input without crashing the room", async () => {
    const { genesis } = seedFixture();
    handle = await createServer(serverOpts(genesis));
    const a = await open(handle.port);
    const err = collect(a, 1);
    a.send("not json");
    expect(await err).toEqual([{ t: "error", message: "Invalid JSON" }]);
    a.close();
  });

  it("denies a join with an empty token and does not join the room", async () => {
    const { genesis } = seedFixture();
    handle = await createServer(serverOpts(genesis));
    const a = await open(handle.port);
    const got = collect(a, 1);
    a.send(JSON.stringify({ t: "join", campaignId: "demo", token: "", fromSeq: 0 }));
    expect(await got).toEqual([{ t: "denied", reason: "authentication failed" }]);
    a.close();
  });

  it("denies a submit before any join (not authenticated)", async () => {
    const { genesis } = seedFixture();
    handle = await createServer(serverOpts(genesis));
    const a = await open(handle.port);
    const got = collect(a, 1);
    a.send(JSON.stringify({ t: "submit", campaignId: "demo", command: { kind: "nextPlayer" } }));
    expect(await got).toEqual([{ t: "denied", reason: "not authenticated" }]);
    a.close();
  });

  it("non-GM identity is denied when submitting a GM command (nextPlayer)", async () => {
    const { genesis } = seedFixture();
    handle = await createServer(serverOpts(genesis));
    const b = await open(handle.port);
    b.send(JSON.stringify({ t: "join", campaignId: "demo", token: "ben", fromSeq: 0 }));
    await collect(b, 2); // joined + presence
    const denied = collect(b, 1);
    // "ben" is not the GM, so submitting a GM command (nextPlayer) is denied via seat check
    b.send(JSON.stringify({ t: "submit", campaignId: "demo", command: { kind: "nextPlayer" } }));
    expect(await denied).toEqual([{ t: "denied", reason: "not authorized for this seat" }]);
    b.close();
  });

  it("character seat anti-impersonation: non-owner submitting with Ada's actorId is denied", async () => {
    const { genesis, adaId } = seedFixture();
    handle = await createServer(serverOpts(genesis));
    const b = await open(handle.port);
    b.send(JSON.stringify({ t: "join", campaignId: "demo", token: "ben", fromSeq: 0 }));
    await collect(b, 2); // joined + presence
    const denied = collect(b, 1);
    // "ben" has no seat assignment; acting as Ada's character should be denied
    b.send(JSON.stringify({ t: "submit", campaignId: "demo", command: { kind: "move", actorId: adaId, roomId: "anywhere" } }));
    expect(await denied).toEqual([{ t: "denied", reason: "not authorized for this seat" }]);
    b.close();
  });

  it("gm actions require the GM identity; non-GM control messages are denied", async () => {
    const { genesis } = seedFixture();
    handle = await createServer(serverOpts(genesis));
    const g = await open(handle.port);
    g.send(JSON.stringify({ t: "join", campaignId: "demo", token: "gm", fromSeq: 0 }));
    await collect(g, 2); // joined + presence
    const gmOk = collect(g, 1); // committed
    g.send(JSON.stringify({ t: "submit", campaignId: "demo", command: { kind: "nextPlayer" } }));
    await gmOk;

    const p = await open(handle.port);
    p.send(JSON.stringify({ t: "join", campaignId: "demo", token: "ada", fromSeq: 0 }));
    await collect(p, 3); // joined + backfill entry + presence
    const denyGm = collect(p, 1);
    // "ada" is not the GM, so submitting a GM command (nextPlayer) is denied
    p.send(JSON.stringify({ t: "submit", campaignId: "demo", command: { kind: "nextPlayer" } }));
    expect(await denyGm).toEqual([{ t: "denied", reason: "not authorized for this seat" }]);
    const denyCtl = collect(p, 1);
    p.send(JSON.stringify({ t: "assignSeat", campaignId: "demo", characterId: "cX", identity: "ada" }));
    expect(await denyCtl).toEqual([{ t: "denied", reason: "GM only" }]);
    g.close(); p.close();
  });

  it("broadcasts presence on join and disconnect", async () => {
    const { genesis } = seedFixture();
    handle = await createServer(serverOpts(genesis));
    const g = await open(handle.port);
    const gMsgs = collect(g, 2); // joined + presence
    g.send(JSON.stringify({ t: "join", campaignId: "demo", token: "gm", fromSeq: 0 }));
    const got = await gMsgs;
    expect(got).toContainEqual({ t: "presence", campaignId: "demo", seats: [], gm: { identity: "gm", online: true } });
    g.close();
  });

  it("an identity stays online while any of its connections is live", async () => {
    const { genesis } = seedFixture();
    handle = await createServer(serverOpts(genesis));
    const g = await open(handle.port);
    g.send(JSON.stringify({ t: "join", campaignId: "demo", token: "gm", fromSeq: 0 }));
    await collect(g, 2); // joined + presence(gm only)
    const a1 = await open(handle.port);
    // Set up g's collector before a1's join
    const gA1Presence = collect(g, 1);
    a1.send(JSON.stringify({ t: "join", campaignId: "demo", token: "ada", fromSeq: 0 }));
    await collect(a1, 2); // joined + presence
    await gA1Presence;
    const a2 = await open(handle.port);
    // Set up g's collector before a2's join
    const gA2Presence = collect(g, 1);
    a2.send(JSON.stringify({ t: "join", campaignId: "demo", token: "ada", fromSeq: 0 }));
    await collect(a2, 2); // joined + presence
    await gA2Presence;
    // assign a seat to ada so presence has an entry to report online state for
    const gAssignPresence = collect(g, 1); // presence from assignSeat
    g.send(JSON.stringify({ t: "assignSeat", campaignId: "demo", characterId: "cAda", identity: "ada" }));
    await gAssignPresence;
    const afterClose = collect(g, 1); // presence after a1 closes
    a1.close();
    const p = await afterClose;
    // ada still online via a2
    expect(p).toEqual([{ t: "presence", campaignId: "demo", seats: [{ characterId: "cAda", owner: "ada", online: true }], gm: { identity: "gm", online: true } }]);
    g.close(); a2.close();
  });

  it("second join on same connection is rejected: same campaign or different identity", async () => {
    const { genesis } = seedFixture();
    handle = await createServer(serverOpts(genesis));
    const a = await open(handle.port);
    a.send(JSON.stringify({ t: "join", campaignId: "demo", token: "ada", fromSeq: 0 }));
    await collect(a, 2); // joined + presence

    // Second join to the SAME campaign on the same connection → denied
    const sameAgain = collect(a, 1);
    a.send(JSON.stringify({ t: "join", campaignId: "demo", token: "ada", fromSeq: 0 }));
    expect(await sameAgain).toEqual([{ t: "denied", reason: "already joined this campaign" }]);

    // Join with a DIFFERENT token/identity on the same connection → denied
    const diffId = collect(a, 1);
    a.send(JSON.stringify({ t: "join", campaignId: "demo", token: "bob", fromSeq: 0 }));
    expect(await diffId).toEqual([{ t: "denied", reason: "different identity on one connection" }]);
    a.close();
  });

  it("GM assignSeat lets the assigned identity act; unassign revokes", async () => {
    const { genesis, adaId, nextRoomId } = seedFixture();
    handle = await createServer(serverOpts(genesis));
    const g = await open(handle.port);
    g.send(JSON.stringify({ t: "join", campaignId: "demo", token: "gm", fromSeq: 0 }));
    await collect(g, 2); // joined + presence
    g.send(JSON.stringify({ t: "assignSeat", campaignId: "demo", characterId: adaId, identity: "ada" }));
    await collect(g, 1); // presence from assignSeat

    const a = await open(handle.port);
    a.send(JSON.stringify({ t: "join", campaignId: "demo", token: "ada", fromSeq: 0 }));
    await collect(a, 2); // joined + presence

    // Ada is the active character on genesis; she can move to "Next"
    const ok = collect(a, 1); // committed
    a.send(JSON.stringify({ t: "submit", campaignId: "demo", command: { kind: "move", actorId: adaId, roomId: nextRoomId } }));
    await ok; // ada can act as adaId

    // unassignSeat broadcasts presence to all participants (g + a)
    g.send(JSON.stringify({ t: "unassignSeat", campaignId: "demo", characterId: adaId }));
    await collect(a, 1); // presence from unassignSeat
    // Now ada's seat is revoked — same command should be denied
    const denied = collect(a, 1);
    a.send(JSON.stringify({ t: "submit", campaignId: "demo", command: { kind: "move", actorId: adaId, roomId: nextRoomId } }));
    expect(await denied).toEqual([{ t: "denied", reason: "not authorized for this seat" }]);
    g.close(); a.close();
  });

  it("GM transferGM hands the GM role to another identity", async () => {
    const { genesis } = seedFixture();
    handle = await createServer(serverOpts(genesis));
    const g = await open(handle.port);
    g.send(JSON.stringify({ t: "join", campaignId: "demo", token: "gm", fromSeq: 0 }));
    await collect(g, 2); // joined + presence

    // Transfer GM to "new-gm"
    g.send(JSON.stringify({ t: "transferGM", campaignId: "demo", identity: "new-gm" }));
    await collect(g, 1); // presence broadcast

    // Old GM can no longer submit GM commands
    const oldDenied = collect(g, 1);
    g.send(JSON.stringify({ t: "submit", campaignId: "demo", command: { kind: "nextPlayer" } }));
    expect(await oldDenied).toEqual([{ t: "denied", reason: "not authorized for this seat" }]);

    // New GM can submit GM commands
    const ng = await open(handle.port);
    ng.send(JSON.stringify({ t: "join", campaignId: "demo", token: "new-gm", fromSeq: 0 }));
    await collect(ng, 2); // joined + presence
    const newOk = collect(ng, 1);
    ng.send(JSON.stringify({ t: "submit", campaignId: "demo", command: { kind: "nextPlayer" } }));
    expect(await newOk).toMatchObject([{ t: "committed", seq: 1 }]);
    g.close(); ng.close();
  });
});
