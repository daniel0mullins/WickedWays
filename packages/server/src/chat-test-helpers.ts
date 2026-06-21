/**
 * Test helpers for server chat integration tests. Vitest-free so they can be
 * imported in any test file without side-effects on the test runner.
 */
import { WebSocket } from "ws";
import { parseServerMsg, type ServerMsg } from "@wickedways/transport-shared";
import { buildSeedCampaign, buildSeedRegistry } from "@wickedways/seed";
import { serializeCampaign } from "wickedways/lib/serialization/serializer";
import { DEFAULT_CHAT_POLICY } from "wickedways/lib/chat-policy";
import { createServer, type ServerHandle } from "./server.js";
import { InMemoryChatStore, type ChatStore } from "./chat-store.js";

const TOKEN_MAP: Record<string, string> = {
  tokenA: "idA",
  tokenB: "idB",
  tokenC: "idC",
};

/** A connected test client with typed helpers. */
export interface ChatTestClient {
  /** Send a raw JSON-serialisable message. */
  send(msg: object): void;
  /**
   * Resolves with the next buffered (or incoming) message that satisfies `pred`.
   * Scans already-buffered messages first, so ordering across helpers is stable.
   */
  next(pred: (m: ServerMsg) => boolean): Promise<ServerMsg>;
  /**
   * Returns `true` if no message matching `pred` arrives within `ms` milliseconds,
   * `false` if one does arrive (or is already buffered).
   */
  noneWithin(ms: number, pred: (m: ServerMsg) => boolean): Promise<boolean>;
}

export interface MakeChatTestServerResult {
  handle: ServerHandle;
}

/**
 * Builds a test server wired to the seed campaign at `campaignId = "campaign1"`.
 * Tokens tokenA→idA, tokenB→idB, tokenC→idC; GM is always idA.
 */
export async function makeChatTestServer(opts: {
  store?: ChatStore;
  chatEnabled?: boolean;
}): Promise<MakeChatTestServerResult> {
  const { campaign } = buildSeedCampaign();
  const genesis = serializeCampaign(campaign);
  // Override chatPolicy based on chatEnabled flag.
  const chatPolicy =
    opts.chatEnabled === false
      ? { ...DEFAULT_CHAT_POLICY, enabled: false }
      : { ...DEFAULT_CHAT_POLICY };
  const genesisWithPolicy: typeof genesis = {
    ...genesis,
    campaign: { ...genesis.campaign, chatPolicy },
  };

  const handle = await createServer({
    port: 0,
    verifyToken: (token: string) => TOKEN_MAP[token] ?? null,
    gmIdentityFor: () => "idA",
    registry: buildSeedRegistry(),
    genesisFor: (id: string) => (id === "campaign1" ? genesisWithPolicy : null),
    chatStore: opts.store ?? new InMemoryChatStore(),
    displayNameFor: (id) => id.toUpperCase(),
  });

  return { handle };
}

/**
 * Opens a WebSocket connection, sends join, then waits for `joined` + `presence` +
 * `players` before resolving. Any backfill chat messages sent between `presence` and
 * `players` are kept in the pending queue so that subsequent `next()` calls see them.
 */
export async function connectClient(
  handle: ServerHandle,
  token: string,
  campaignId: string,
): Promise<ChatTestClient> {
  const ws = new WebSocket(`ws://127.0.0.1:${handle.port}`);
  const pending: ServerMsg[] = [];
  const waiters: Array<{
    pred: (m: ServerMsg) => boolean;
    resolve: (m: ServerMsg) => void;
  }> = [];

  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    ws.addEventListener("error", (e) => reject(e));
  });

  ws.addEventListener("message", (ev: { data: unknown }) => {
    const raw = parseServerMsg(JSON.parse(String(ev.data)));
    if (raw === null) return;
    // Walk waiters and hand the message to the first one whose predicate matches.
    for (let i = 0; i < waiters.length; i++) {
      const w = waiters[i]!;
      if (w.pred(raw)) {
        waiters.splice(i, 1);
        w.resolve(raw);
        return;
      }
    }
    pending.push(raw);
  });

  const next = (pred: (m: ServerMsg) => boolean): Promise<ServerMsg> => {
    // Check already-buffered messages first.
    const idx = pending.findIndex(pred);
    if (idx !== -1) {
      const msg = pending.splice(idx, 1)[0]!;
      return Promise.resolve(msg);
    }
    return new Promise((resolve) => {
      waiters.push({ pred, resolve });
    });
  };

  const noneWithin = (ms: number, pred: (m: ServerMsg) => boolean): Promise<boolean> => {
    return new Promise((resolve) => {
      // Already buffered → found immediately.
      const buffIdx = pending.findIndex(pred);
      if (buffIdx !== -1) {
        resolve(false);
        return;
      }

      // Register a waiter; if the timer fires first it removes the waiter and resolves true.
      let waiterEntry: { pred: (m: ServerMsg) => boolean; resolve: (m: ServerMsg) => void } | null =
        null;

      const timer = setTimeout(() => {
        if (waiterEntry !== null) {
          const idx = waiters.indexOf(waiterEntry);
          if (idx !== -1) waiters.splice(idx, 1);
        }
        resolve(true);
      }, ms);

      const resolveOnMatch = (_m: ServerMsg): void => {
        clearTimeout(timer);
        resolve(false);
      };

      waiterEntry = { pred, resolve: resolveOnMatch };
      waiters.push(waiterEntry);
    });
  };

  const send = (msg: object): void => {
    ws.send(JSON.stringify(msg));
  };

  // Send join and drain the setup burst: joined → presence → players.
  // Any backfill chat messages that land between presence and players are left in
  // `pending` so subsequent next() calls find them cleanly.
  ws.send(JSON.stringify({ t: "join", token, campaignId, fromSeq: 0 }));
  await next((m) => m.t === "joined");
  await next((m) => m.t === "presence");
  await next((m) => m.t === "players");

  return { send, next, noneWithin };
}
