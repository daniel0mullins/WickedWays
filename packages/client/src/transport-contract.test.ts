import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WebSocket } from "ws";
import { InProcessTransport, type SyncTransport } from "wickedways/lib/sync/transport";
import type { LogEntry } from "wickedways/lib/sync/types";
import type { CampaignSnapshot } from "wickedways/lib/serialization/types";
import { createServer, type ServerHandle } from "@wickedways/server";
import { WebSocketTransport, type WebSocketFactory } from "./websocket-transport.js";

const entry = (seq: number, baseSeq: number): LogEntry =>
  ({ seq, baseSeq, command: { kind: "nextPlayer" }, delta: { changed: [], created: [], removed: [] } }) as unknown as LogEntry;
const snap = (): CampaignSnapshot => ({ schemaVersion: 1 }) as unknown as CampaignSnapshot;

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

function inProcessBackend(): Backend {
  // One shared store; every "client" is a handle on the same instance (Spec 2 model).
  const shared = new InProcessTransport();
  return { connect: () => Promise.resolve(shared), teardown: () => Promise.resolve() };
}

function webSocketBackend(): Backend {
  const nodeFactory: WebSocketFactory = (url) => new WebSocket(url);
  let handle: ServerHandle | null = null;
  const transports: WebSocketTransport[] = [];
  return {
    async connect() {
      handle ??= await createServer({ port: 0, verifyToken: (t) => t || null, gmIdentityFor: () => "c0" });
      const t = await WebSocketTransport.connect({
        url: `ws://127.0.0.1:${handle.port}`,
        campaignId: "contract",
        token: `c${transports.length}`,
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

    it("commits an append at head+1 and advances head", async () => {
      const a = await backend.connect();
      expect(await a.append(entry(1, 0))).toEqual({ ok: true });
      await until(() => a.head() === 1);
    });

    it("rejects a stale-base append as a conflict reporting head", async () => {
      const a = await backend.connect();
      await a.append(entry(1, 0));
      await until(() => a.head() === 1);
      expect(await a.append(entry(1, 0))).toEqual({ ok: false, conflict: true, head: 1 });
    });

    it("delivers appended entries to a subscriber on the same backend", async () => {
      const a = await backend.connect();
      const b = await backend.connect();
      const seen: number[] = [];
      b.subscribe(1, (e) => seen.push(e.seq));
      await a.append(entry(1, 0));
      await until(() => seen.includes(1));
      expect(seen).toEqual([1]);
    });

    it("returns ordered entries from entriesSince", async () => {
      const a = await backend.connect();
      await a.append(entry(1, 0));
      await until(() => a.head() === 1);
      await a.append(entry(2, 1));
      await until(() => a.head() === 2);
      await a.append(entry(3, 2));
      await until(() => a.head() === 3);
      expect(a.entriesSince(2).map((e) => e.seq)).toEqual([2, 3]);
    });

    it("round-trips a snapshot to a client that connects afterward", async () => {
      const a = await backend.connect();
      // Append twice so head reaches 2 before writing the checkpoint.
      // The server requires seq <= head (GM-gate), so the snapshot must come after
      // the entries it covers; await both commits for a causal ordering guarantee.
      await a.append(entry(1, 0));
      await a.append(entry(2, 1));
      a.putSnapshot(2, snap());
      expect(a.loadSnapshot()).toEqual({ seq: 2, snapshot: snap() });
      // The server processes one socket's messages in order, so awaiting a committed
      // append guarantees the earlier putSnapshot was applied before c connects —
      // a causal guarantee, not a timing race.
      await a.append(entry(3, 2));
      const c = await backend.connect();
      expect(c.loadSnapshot()?.seq).toBe(2);
    });
  });
}

runContract("InProcessTransport", inProcessBackend);
runContract("WebSocketTransport", webSocketBackend);
