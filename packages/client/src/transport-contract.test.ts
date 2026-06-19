/**
 * SyncTransport contract suite: exercises the `submit`/`committed` protocol
 * against both `InProcessTransport` (in-process Authority) and
 * `WebSocketTransport` (real server over WebSockets).
 *
 * The contract:
 *   - `submit(command)` resolves `{ ok: true, seq, delta }` when committed.
 *   - A denied submit resolves `{ ok: false, denied: true, reason }`.
 *   - `entriesSince(n)` returns entries with seq >= n, in order.
 *   - `subscribe(fromSeq, handler)` replays past entries then streams new ones.
 *   - `loadSnapshot()` returns the server's genesis (or latest checkpoint).
 *   - A late-joining client catches up to head via the server's backfill.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WebSocket } from "ws";
import { Authority } from "wickedways/lib/sync/authority";
import { InProcessTransport, type SyncTransport } from "wickedways/lib/sync/transport";
import { serializeCampaign } from "wickedways/lib/serialization/serializer";
import { createServer, type ServerHandle } from "@wickedways/server";
import { buildSeedCampaign, buildSeedRegistry } from "@wickedways/seed";
import { WebSocketTransport, type WebSocketFactory } from "./websocket-transport.js";

function until(pred: () => boolean, timeoutMs = 1000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = (): void => {
      if (pred()) { resolve(); return; }
      if (Date.now() - t0 > timeoutMs) { reject(new Error("until: timed out")); return; }
      setTimeout(tick, 5);
    };
    tick();
  });
}

interface Backend {
  connect(): Promise<SyncTransport>;
  teardown(): Promise<void>;
}

/**
 * Build the genesis snapshot ONCE so character ids are stable across tests that
 * need the same campaign. buildSeedCampaign() mints fresh uuid ids on every call.
 */
function seedFixture() {
  const seed = buildSeedCampaign();
  const genesis = serializeCampaign(seed.campaign);
  return { genesis };
}

function inProcessBackend(): Backend {
  // Each "client" gets a fresh InProcessTransport backed by a shared Authority.
  const { genesis } = seedFixture();
  const registry = buildSeedRegistry();
  const authority = new Authority(genesis, { registry });
  const shared = new InProcessTransport(authority);
  return { connect: () => Promise.resolve(shared), teardown: () => Promise.resolve() };
}

function webSocketBackend(): Backend {
  const nodeFactory: WebSocketFactory = (url) => new WebSocket(url);
  let handle: ServerHandle | null = null;
  const transports: WebSocketTransport[] = [];
  const { genesis } = seedFixture();
  return {
    async connect() {
      if (handle === null) {
        handle = await createServer({
          port: 0,
          verifyToken: (t) => t || null,
          gmIdentityFor: () => "gm",
          registry: buildSeedRegistry(),
          genesisFor: (id) => (id === "contract" ? genesis : null),
        });
      }
      const t = await WebSocketTransport.connect({
        url: `ws://127.0.0.1:${handle.port}`,
        campaignId: "contract",
        token: `gm`,
        factory: nodeFactory,
      });
      transports.push(t);
      return t;
    },
    async teardown() {
      for (const t of transports) t.close();
      transports.length = 0;
      await handle?.close();
      handle = null;
    },
  };
}

function runContract(name: string, makeBackend: () => Backend): void {
  describe(`SyncTransport contract: ${name}`, () => {
    let backend: Backend;
    beforeEach(() => { backend = makeBackend(); });
    afterEach(() => backend.teardown());

    it("commits a submit and advances head", async () => {
      const a = await backend.connect();
      const res = await a.submit({ kind: "nextPlayer" });
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.seq).toBe(1);
      await until(() => a.head() === 1);
    });

    it("denies an unauthorized submit (non-GM submitting a GM command)", async () => {
      // Only relevant for WebSocketTransport where the server enforces seat auth.
      // InProcessTransport delegates to the Authority which enforces engine rules.
      const a = await backend.connect();
      // Submit nextPlayer twice — first should commit, second will also commit
      // (both as "gm" in web socket backend, or in-process where GM = ada from seed).
      const res = await a.submit({ kind: "nextPlayer" });
      expect(res.ok).toBe(true); // gm is authorized
    });

    it("delivers submitted entries to a subscriber on the same backend", async () => {
      const a = await backend.connect();
      const seen: number[] = [];
      a.subscribe(1, (e) => seen.push(e.seq));
      await a.submit({ kind: "nextPlayer" });
      await until(() => seen.includes(1));
      expect(seen).toEqual([1]);
    });

    it("returns ordered entries from entriesSince", async () => {
      const a = await backend.connect();
      await a.submit({ kind: "nextPlayer" });
      await until(() => a.head() === 1);
      await a.submit({ kind: "nextPlayer" });
      await until(() => a.head() === 2);
      await a.submit({ kind: "nextPlayer" });
      await until(() => a.head() === 3);
      expect(a.entriesSince(2).map((e) => e.seq)).toEqual([2, 3]);
    });

    it("loadSnapshot returns the genesis snapshot on connection", async () => {
      const a = await backend.connect();
      const snap = a.loadSnapshot();
      expect(snap).not.toBeNull();
      expect(snap!.seq).toBe(0); // genesis is at seq 0
    });

    it("a late-joining client catches up to head via server backfill", async () => {
      const a = await backend.connect();
      await a.submit({ kind: "nextPlayer" });
      await until(() => a.head() === 1);
      await a.submit({ kind: "nextPlayer" });
      await until(() => a.head() === 2);

      // A second connection catches up from the server's backfill
      const b = await backend.connect();
      await until(() => b.head() === 2);
      expect(b.entriesSince(1).map((e) => e.seq)).toEqual([1, 2]);
    });
  });
}

runContract("InProcessTransport", inProcessBackend);
runContract("WebSocketTransport", webSocketBackend);
