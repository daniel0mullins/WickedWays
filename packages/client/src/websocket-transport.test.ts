import { describe, it, expect, afterEach } from "vitest";
import { WebSocket } from "ws";
import { createServer, type ServerHandle } from "@wickedways/server";
import { buildSeedCampaign, buildSeedRegistry } from "@wickedways/seed";
import { serializeCampaign } from "wickedways/lib/serialization/serializer";
import { WebSocketTransport, type WebSocketFactory } from "./websocket-transport.js";

const nodeFactory: WebSocketFactory = (url) => new WebSocket(url);

/**
 * Build the genesis snapshot ONCE so character ids are stable across tests that
 * need to act as specific seats. buildSeedCampaign() mints fresh uuid character
 * ids on every call; serializeCampaign preserves ids.
 */
function seedFixture() {
  const seed = buildSeedCampaign();
  const genesis = serializeCampaign(seed.campaign);
  const adaId = seed.campaign.activeCharacter.id;
  const benId = seed.campaign.party.find((p) => p.id !== adaId)!.id;
  return { genesis, adaId, benId };
}

function serverOpts(genesis: ReturnType<typeof seedFixture>["genesis"]) {
  return {
    port: 0 as const,
    verifyToken: (t: string) => t || null,
    gmIdentityFor: () => "gm" as const,
    registry: buildSeedRegistry(),
    genesisFor: (id: string) => (id === "demo" ? genesis : null),
  };
}

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

describe("WebSocketTransport", () => {
  it("connects warm at head 0 with the genesis snapshot", async () => {
    const { genesis } = seedFixture();
    handle = await createServer(serverOpts(genesis));
    const a = await connect("demo", "gm");
    expect(a.head()).toBe(0);
    // The server provides the genesis snapshot on getSnapshot
    expect(a.loadSnapshot()).not.toBeNull();
    expect(a.loadSnapshot()!.seq).toBe(0);
  });

  it("resolves submit when the server commits, applying the delta to the mirror", async () => {
    const { genesis } = seedFixture();
    handle = await createServer(serverOpts(genesis));
    const a = await connect("demo", "gm");
    const res = await a.submit({ kind: "nextPlayer" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.seq).toBe(1);
    expect(a.head()).toBe(1);
    expect(a.entriesSince(1).map((e) => e.seq)).toEqual([1]);
  });

  it("delivers a peer's committed entry to a subscriber", async () => {
    const { genesis } = seedFixture();
    handle = await createServer(serverOpts(genesis));
    const a = await connect("demo", "gm");
    const b = await connect("demo", "b");
    const seen: number[] = [];
    b.subscribe(b.head() + 1, (e) => seen.push(e.seq));
    await a.submit({ kind: "nextPlayer" });
    await vi_tick();
    expect(seen).toEqual([1]);
    expect(b.head()).toBe(1);
  });

  it("denies a submit for an unauthorized seat and reports the reason", async () => {
    const { genesis } = seedFixture();
    handle = await createServer(serverOpts(genesis));
    const a = await connect("demo", "gm");
    // Connect as "gm" but then try submitting a GM command with a non-GM token
    const b = await connect("demo", "notgm");
    const res = await b.submit({ kind: "nextPlayer" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.denied).toBe(true);
      expect(res.reason).toMatch(/not authorized/);
    }
    // GM's state is unaffected
    expect(a.head()).toBe(0);
  });

  it("late-joins from the server's genesis snapshot and backfills entries since", async () => {
    const { genesis } = seedFixture();
    handle = await createServer(serverOpts(genesis));
    const a = await connect("demo", "gm");
    await a.submit({ kind: "nextPlayer" });
    await a.submit({ kind: "nextPlayer" });
    await vi_tick();

    const b = await connect("demo", "b");
    // The server provides the genesis snapshot (seq 0); b backfills entries 1 and 2
    expect(b.loadSnapshot()).not.toBeNull();
    expect(b.head()).toBe(2);
    expect(b.entriesSince(1).map((e) => e.seq)).toEqual([1, 2]);
  });
});

/** Flush microtasks + a macrotask so broadcast messages are delivered. */
function vi_tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 10));
}
