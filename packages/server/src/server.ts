import { WebSocketServer, type WebSocket } from "ws";
import { parseClientMsg, type ServerMsg, type Identity, type PresenceEntry, type Actor, type ChatMsg } from "@wickedways/transport-shared";
import { Authority } from "wickedways/lib/sync/authority";
import { commandActorId, isJoinCommand, type Command } from "wickedways/lib/sync/types";
import type { CampaignRegistry } from "wickedways/lib/serialization/registry";
import type { CampaignSnapshot } from "wickedways/lib/serialization/types";
import { SCHEMA_VERSION } from "wickedways/lib/serialization/types";
import { Table, type Subscriber } from "./table.js";
import { Membership } from "./membership.js";
import type { CampaignStore } from "./store.js";
import { Chat } from "./chat.js";
import { InMemoryChatStore, type ChatStore } from "./chat-store.js";

/** A running room server. */
export interface ServerHandle {
  port: number;
  close(): Promise<void>;
}

/** Options for {@link createServer}. */
export interface ServerOptions {
  port?: number;
  /** Host-supplied verifier: returns the connection's identity, or null to deny. */
  verifyToken: (token: string) => Identity | null;
  /** Host-supplied: the designated GM identity for a campaign (seeds its Membership). */
  gmIdentityFor: (campaignId: string) => Identity;
  /** Host-built registry, identical to the clients' (the Authority hydrates with it). */
  registry: CampaignRegistry;
  /** Host-supplied genesis for a campaign, or null to reject it as unknown. */
  genesisFor: (campaignId: string) => CampaignSnapshot | null;
  /** Optional rng for every campaign's Authority (defaults to Math.random). */
  rng?: () => number;
  /** Optional durable store; when omitted the server is ephemeral (today's behavior). */
  store?: CampaignStore;
  /** Optional display-name resolver for the `players` roster broadcast. Defaults to the identity string. */
  displayNameFor?: (identity: Identity) => string;
  /** Optional chat store; when omitted an in-memory store is used. */
  chatStore?: ChatStore;
}

/** Derives the seat an append acts as, read straight from the command (no client-supplied envelope). */
function actorOf(command: Command): Actor {
  if (isJoinCommand(command)) return { kind: "join", characterId: command.character.id };
  const actorId = commandActorId(command);
  return actorId === null ? { kind: "gm" } : { kind: "character", actorId };
}

function schemaMatches(snapshot: CampaignSnapshot): boolean {
  return snapshot.schemaVersion === SCHEMA_VERSION;
}

/**
 * Starts an authoritative WebSocket room server. Each campaign is backed by an
 * {@link Authority} (built lazily from the host's `genesisFor`) that re-derives
 * every delta from the submitted command. Clients send commands only; the server
 * computes and broadcasts the authoritative delta. The only server-owned gate is
 * seat ownership, checked against the actor the server reads from the command
 * itself — no client-supplied actor envelope exists to forge or desync.
 *
 * Each connection authenticates on `join` (the host's `verifyToken`); writes
 * (`submit`) require an authenticated connection.
 */
export function createServer(opts: ServerOptions): Promise<ServerHandle> {
  const memberships = new Map<string, Membership>();
  const membershipFor = (id: string): Membership => {
    let m = memberships.get(id);
    if (m === undefined) { m = new Membership(opts.gmIdentityFor(id)); memberships.set(id, m); }
    return m;
  };

  const tables = new Map<string, Table>();
  // Inflight load promises — deduplicate concurrent ensureLoaded calls for the same campaign.
  const loading = new Map<string, Promise<Table | null>>();

  // With a store, snapshot-on-every-commit so `currentSnapshot()` is always fresh for `save`.
  // Without a store, use the Authority default (20) so snapshot seq ≠ head seq,
  // letting late-joining clients receive entries (not just a snapshot) from `join` backfill.
  const snapshotEvery = opts.store !== undefined ? 1 : undefined;

  const buildAuthority = (_id: string, seq: number, genesis: CampaignSnapshot): Authority =>
    new Authority(genesis, { registry: opts.registry, rng: opts.rng, snapshotEvery, startSeq: seq });

  const ensureLoaded = (id: string): Promise<Table | null> => {
    const cached = tables.get(id);
    if (cached !== undefined) return Promise.resolve(cached);
    const inflight = loading.get(id);
    if (inflight !== undefined) return inflight;
    const p = (async (): Promise<Table | null> => {
      try {
        const rec = opts.store ? await opts.store.load(id) : null;
        if (rec !== null && !schemaMatches(rec.snapshot)) {
          console.error(`[persistence] campaign ${id}: snapshot schemaVersion ${rec.snapshot.schemaVersion} != current; refusing to resume (migration required)`);
          return null; // fail closed — do NOT build a genesis Table (that would overwrite the record)
        }
        const genesis = rec?.snapshot ?? opts.genesisFor(id);
        if (genesis === null) { return null; }
        const authority = buildAuthority(id, rec?.seq ?? 0, genesis);
        // Restore persisted membership when resuming; otherwise use whatever membership was set
        // by messages that arrived while we were awaiting the load (or seed a fresh one).
        if (rec) memberships.set(id, Membership.fromState(rec.membership));
        else if (!memberships.has(id)) memberships.set(id, new Membership(opts.gmIdentityFor(id)));
        const t = new Table(authority);
        const store = opts.store;
        if (store !== undefined) {
          t.setDurability({
            // NOTE: the thunk reads t.head()/t.currentSnapshot() at execution time. This is
            // correct for a synchronous store (each submit serialises naturally). A genuinely-
            // async CampaignStore would need per-campaign submit serialization to avoid one
            // submit's persist thunk capturing a later seq/snapshot written by a concurrent submit.
            persist: () =>
              store.save(id, { seq: t.head(), snapshot: t.currentSnapshot(), membership: membershipFor(id).toState() }),
            reload: async () => {
              const r = await store.load(id);
              const fresh = r?.snapshot ?? opts.genesisFor(id);
              if (fresh === null) return;
              t.replaceAuthority(buildAuthority(id, r?.seq ?? 0, fresh));
              memberships.set(id, r ? Membership.fromState(r.membership) : new Membership(opts.gmIdentityFor(id)));
            },
          });
        }
        tables.set(id, t);
        return t;
      } finally {
        // Always remove the inflight promise — whether the load succeeded, returned null,
        // or rejected. A rejection must not stay cached; a later ensureLoaded call should
        // re-attempt the load rather than returning the same rejected promise.
        loading.delete(id);
      }
    })();
    loading.set(id, p);
    return p;
  };

  const online = new Map<string, Map<Identity, number>>();
  const bump = (campaignId: string, id: Identity, delta: number): void => {
    let map = online.get(campaignId);
    if (map === undefined) { map = new Map(); online.set(campaignId, map); }
    const n = (map.get(id) ?? 0) + delta;
    if (n <= 0) map.delete(id); else map.set(id, n);
  };
  const presenceOf = (campaignId: string): ServerMsg => {
    const m = membershipFor(campaignId);
    const onlineMap = online.get(campaignId);
    const isOnline = (id: Identity): boolean => (onlineMap?.get(id) ?? 0) > 0;
    const seats: PresenceEntry[] = m.seats().map(([characterId, owner]) => ({ characterId, owner, online: isOnline(owner) }));
    return { t: "presence", campaignId, seats, gm: { identity: m.gmIdentity, online: isOnline(m.gmIdentity) } };
  };
  const broadcastPresence = (campaignId: string): void => tables.get(campaignId)?.broadcast(presenceOf(campaignId));

  const chatStore: ChatStore = opts.chatStore ?? new InMemoryChatStore();
  const chats = new Map<string, Chat>();
  const subsByIdentity = new Map<string, Map<Identity, Set<Subscriber>>>();

  const indexSub = (campaignId: string, id: Identity, sub: Subscriber, add: boolean): void => {
    let m = subsByIdentity.get(campaignId);
    if (m === undefined) { m = new Map(); subsByIdentity.set(campaignId, m); }
    let set = m.get(id);
    if (set === undefined) { set = new Set(); m.set(id, set); }
    if (add) set.add(sub);
    else { set.delete(sub); if (set.size === 0) m.delete(id); }
  };

  const sendToIdentity = (campaignId: string, id: Identity, msg: ServerMsg): void => {
    for (const sub of subsByIdentity.get(campaignId)?.get(id) ?? []) sub(msg);
  };

  const chatFor = async (campaignId: string): Promise<Chat | null> => {
    const cached = chats.get(campaignId);
    if (cached !== undefined) return cached;
    const t = tables.get(campaignId);
    if (t === undefined) return null;
    const policy = t.currentSnapshot().campaign.chatPolicy;
    const chat = await Chat.load(campaignId, policy, chatStore, Date.now);
    chats.set(campaignId, chat);
    return chat;
  };

  const rosterOf = (campaignId: string): ServerMsg => {
    const m = membershipFor(campaignId);
    const ids = new Set<Identity>([m.gmIdentity, ...m.seats().map(([, owner]) => owner)]);
    for (const id of subsByIdentity.get(campaignId)?.keys() ?? []) ids.add(id);
    const onlineMap = online.get(campaignId);
    const name = (id: Identity): string => opts.displayNameFor?.(id) ?? id;
    return {
      t: "players",
      campaignId,
      players: [...ids].map((identity) => ({
        identity,
        displayName: name(identity),
        online: (onlineMap?.get(identity) ?? 0) > 0,
      })),
    };
  };
  const broadcastRoster = (campaignId: string): void =>
    tables.get(campaignId)?.broadcast(rosterOf(campaignId));

  const deliverChat = (campaignId: string, msg: ChatMsg): void => {
    if (msg.to === undefined) {
      tables.get(campaignId)?.broadcast({ t: "chat", msg });
      return;
    }
    sendToIdentity(campaignId, msg.from, { t: "chat", msg });
    if (msg.to !== msg.from) sendToIdentity(campaignId, msg.to, { t: "chat", msg });
  };

  const deliverChatUpdate = (campaignId: string, audience: ChatMsg, serverMsg: ServerMsg): void => {
    if (audience.to === undefined) { tables.get(campaignId)?.broadcast(serverMsg); return; }
    sendToIdentity(campaignId, audience.from, serverMsg);
    if (audience.to !== audience.from) sendToIdentity(campaignId, audience.to, serverMsg);
  };

  const verify = (token: string): Identity | null => {
    try {
      return opts.verifyToken(token);
    } catch {
      return null; // a throwing verifier denies; the room never crashes
    }
  };

  const wss = new WebSocketServer({ port: opts.port ?? 0 });

  wss.on("connection", (ws: WebSocket) => {
    const send: Subscriber = (msg: ServerMsg) => ws.send(JSON.stringify(msg));
    const joined = new Set<string>();
    let identity: Identity | null = null;

    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    ws.on("message", async (data: { toString(): string }) => {
      let raw: unknown;
      try {
        raw = JSON.parse(data.toString());
      } catch {
        send({ t: "error", message: "Invalid JSON" });
        return;
      }
      const msg = parseClientMsg(raw);
      if (msg === null) {
        send({ t: "error", message: "Malformed message" });
        return;
      }

      switch (msg.t) {
        case "join": {
          const id = verify(msg.token);
          if (id === null) { send({ t: "denied", reason: "authentication failed" }); return; }
          if (identity !== null && id !== identity) { send({ t: "denied", reason: "different identity on one connection" }); break; }
          if (joined.has(msg.campaignId)) { send({ t: "denied", reason: "already joined this campaign" }); break; }
          // Set identity before the async load so that messages arriving while we await
          // (e.g. assignSeat bursts) see this connection as authenticated.
          const prevIdentity = identity;
          identity = id;
          let t: Table | null;
          try {
            t = await ensureLoaded(msg.campaignId);
          } catch {
            // A store load failure is treated the same as "campaign not found".
            identity = prevIdentity;
            send({ t: "denied", reason: "unknown campaign" });
            break;
          }
          if (t === null) { identity = prevIdentity; send({ t: "denied", reason: "unknown campaign" }); break; }
          t.join(send, msg.fromSeq);
          joined.add(msg.campaignId);
          bump(msg.campaignId, id, 1);
          broadcastPresence(msg.campaignId);
          indexSub(msg.campaignId, id, send, true);
          const chat = await chatFor(msg.campaignId);
          if (chat !== null && chat.policy.enabled) {
            const { msgs, reads } = await chat.backfill(id);
            for (const cm of msgs) send({ t: "chat", msg: cm });
            if (chat.policy.readReceipts && reads.length > 0) {
              send({ t: "chatReads", campaignId: msg.campaignId, marks: reads });
            }
          }
          broadcastRoster(msg.campaignId);
          break;
        }
        case "submit": {
          if (identity === null) { send({ t: "denied", reason: "not authenticated" }); break; }
          const t = tables.get(msg.campaignId);
          if (t === undefined) { send({ t: "denied", reason: "unknown campaign" }); break; }
          const m = membershipFor(msg.campaignId);
          const command = msg.command as Command;
          const actor = actorOf(command);
          if (!m.mayAct(identity, actor)) { send({ t: "denied", reason: "not authorized for this seat" }); break; }
          const claimerId = identity;
          // For a join, claim the seat as `onCommit` so it is written in the SAME
          // atomic persist as the commit (closes the orphaned-character window).
          const onCommit =
            actor.kind === "join" ? () => m.claim(actor.characterId, claimerId) : undefined;
          const result = await t.submit(command, send, onCommit);
          if (actor.kind === "join" && result.committed) broadcastPresence(msg.campaignId);
          break;
        }
        case "assignSeat":
        case "unassignSeat":
        case "transferGM": {
          if (identity === null) { send({ t: "denied", reason: "not authenticated" }); break; }
          const m = membershipFor(msg.campaignId);
          if (identity !== m.gmIdentity) { send({ t: "denied", reason: "GM only" }); break; }
          if (msg.t === "assignSeat") m.assign(msg.characterId, msg.identity);
          else if (msg.t === "unassignSeat") m.unassign(msg.characterId);
          else m.transferGM(msg.identity);
          const t = tables.get(msg.campaignId);
          if (t !== undefined) {
            try { await t.persist(); }
            catch { await t.reload(); send({ t: "denied", reason: "could not persist; retry" }); break; }
          }
          broadcastPresence(msg.campaignId);
          break;
        }
        case "getSnapshot": {
          let t: Table | null;
          try {
            t = await ensureLoaded(msg.campaignId);
          } catch {
            // A store load failure is treated the same as "campaign not found".
            send({ t: "snapshot", seq: 0, snapshot: null });
            break;
          }
          if (t === null) { send({ t: "snapshot", seq: 0, snapshot: null }); break; }
          t.sendSnapshot(send); // read-only; pre-auth allowed (unchanged 3b boundary)
          break;
        }
        case "chatSend": {
          if (identity === null) { send({ t: "denied", reason: "not authenticated" }); break; }
          const chat = await chatFor(msg.campaignId);
          if (chat === null || !chat.policy.enabled) { send({ t: "denied", reason: "chat disabled" }); break; }
          const res = await chat.send(identity, msg.body, msg.to);
          if ("ok" in res) { send({ t: "denied", reason: res.reason }); break; }
          deliverChat(msg.campaignId, res);
          break;
        }
        case "chatHistory": {
          if (identity === null) { send({ t: "denied", reason: "not authenticated" }); break; }
          const chat = await chatFor(msg.campaignId);
          if (chat === null || !chat.policy.enabled) { send({ t: "denied", reason: "chat disabled" }); break; }
          const { msgs, more } = await chat.history(identity, msg.before);
          send({ t: "chatHistory", campaignId: msg.campaignId, msgs, more });
          break;
        }
        case "chatEdit": {
          if (identity === null) { send({ t: "denied", reason: "not authenticated" }); break; }
          const chat = await chatFor(msg.campaignId);
          if (chat === null || !chat.policy.enabled) { send({ t: "denied", reason: "chat disabled" }); break; }
          const res = await chat.edit(identity, msg.id, msg.body);
          if ("ok" in res) { send({ t: "denied", reason: res.reason }); break; }
          deliverChatUpdate(msg.campaignId, res, { t: "chatEdited", campaignId: msg.campaignId, id: res.id, body: res.body, editedTs: res.editedTs! });
          break;
        }
        case "chatDelete": {
          if (identity === null) { send({ t: "denied", reason: "not authenticated" }); break; }
          const chat = await chatFor(msg.campaignId);
          if (chat === null || !chat.policy.enabled) { send({ t: "denied", reason: "chat disabled" }); break; }
          const res = await chat.remove(identity, msg.id);
          if ("ok" in res) { send({ t: "denied", reason: res.reason }); break; }
          deliverChatUpdate(msg.campaignId, res, { t: "chatDeleted", campaignId: msg.campaignId, id: res.id });
          break;
        }
        case "chatReact": {
          if (identity === null) { send({ t: "denied", reason: "not authenticated" }); break; }
          const chat = await chatFor(msg.campaignId);
          if (chat === null || !chat.policy.enabled) { send({ t: "denied", reason: "chat disabled" }); break; }
          const res = await chat.react(identity, msg.id, msg.emoji, msg.on);
          if ("ok" in res) { send({ t: "denied", reason: res.reason }); break; }
          deliverChatUpdate(msg.campaignId, res, { t: "chatReact", campaignId: msg.campaignId, id: res.id, emoji: msg.emoji, identity, on: msg.on });
          break;
        }
        case "chatRead": {
          if (identity === null) { send({ t: "denied", reason: "not authenticated" }); break; }
          const chat = await chatFor(msg.campaignId);
          if (chat === null || !chat.policy.enabled) { send({ t: "denied", reason: "chat disabled" }); break; }
          const marks = await chat.read(identity, msg.upTo);
          if ("ok" in marks) { send({ t: "denied", reason: marks.reason }); break; }
          tables.get(msg.campaignId)?.broadcast({ t: "chatReads", campaignId: msg.campaignId, marks });
          break;
        }
      }
    });

    ws.on("close", () => {
      for (const id of joined) {
        tables.get(id)?.leave(send);
        if (identity !== null) { bump(id, identity, -1); indexSub(id, identity, send, false); }
        broadcastPresence(id);
        broadcastRoster(id);
      }
    });
  });

  return new Promise((resolve) => {
    wss.on("listening", () => {
      const addr = wss.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : (opts.port ?? 0);
      resolve({
        port,
        close: () =>
          new Promise<void>((res, rej) => {
            for (const client of wss.clients) client.terminate();
            wss.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
  });
}
