import { WebSocketServer, type WebSocket } from "ws";
import { parseClientMsg, type ServerMsg, type Identity, type PresenceEntry, type Actor } from "@wickedways/transport-shared";
import { Authority } from "wickedways/lib/sync/authority";
import { commandActorId, isJoinCommand, type Command } from "wickedways/lib/sync/types";
import type { CampaignRegistry } from "wickedways/lib/serialization/registry";
import type { CampaignSnapshot } from "wickedways/lib/serialization/types";
import { Table, type Subscriber } from "./table.js";
import { Membership } from "./membership.js";

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
}

/** Derives the seat an append acts as, read straight from the command (no client-supplied envelope). */
function actorOf(command: Command): Actor {
  if (isJoinCommand(command)) return { kind: "join", characterId: command.character.id };
  const actorId = commandActorId(command);
  return actorId === null ? { kind: "gm" } : { kind: "character", actorId };
}

/**
 * Starts a WebSocket server: a thin adapter over a `Map<campaignId, Table>` plus an
 * auth layer. Each connection authenticates on `join` (the host's `verifyToken`);
 * writes (`submit`) require an authenticated connection. The server derives the actor
 * from the command itself — no client-supplied actor envelope.
 */
export function createServer(opts: ServerOptions): Promise<ServerHandle> {
  const tables = new Map<string, Table>();
  const tableFor = (id: string): Table | null => {
    let t = tables.get(id);
    if (t === undefined) {
      const genesis = opts.genesisFor(id);
      if (genesis === null) return null;
      const authority = new Authority(genesis, { registry: opts.registry, rng: opts.rng });
      t = new Table(authority);
      tables.set(id, t);
    }
    return t;
  };

  const memberships = new Map<string, Membership>();
  const membershipFor = (id: string): Membership => {
    let m = memberships.get(id);
    if (m === undefined) { m = new Membership(opts.gmIdentityFor(id)); memberships.set(id, m); }
    return m;
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
  const broadcastPresence = (campaignId: string): void => tableFor(campaignId)?.broadcast(presenceOf(campaignId));

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

    ws.on("message", (data: { toString(): string }) => {
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
          const t = tableFor(msg.campaignId);
          if (t === null) { send({ t: "denied", reason: "unknown campaign" }); break; }
          identity = id;
          t.join(send, msg.fromSeq);
          joined.add(msg.campaignId);
          bump(msg.campaignId, id, 1);
          broadcastPresence(msg.campaignId);
          break;
        }
        case "submit": {
          if (identity === null) { send({ t: "denied", reason: "not authenticated" }); break; }
          const t = tableFor(msg.campaignId);
          if (t === null) { send({ t: "denied", reason: "unknown campaign" }); break; }
          const m = membershipFor(msg.campaignId);
          const command = msg.command as Command;
          const actor = actorOf(command);
          if (!m.mayAct(identity, actor)) { send({ t: "denied", reason: "not authorized for this seat" }); break; }
          const result = t.submit(command, send);
          if (actor.kind === "join" && result.committed) {
            m.claim(actor.characterId, identity); // self-service seat claim, on commit
            broadcastPresence(msg.campaignId);
          }
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
          broadcastPresence(msg.campaignId);
          break;
        }
        case "getSnapshot": {
          const t = tableFor(msg.campaignId);
          if (t === null) { send({ t: "snapshot", seq: 0, snapshot: null }); break; }
          t.sendSnapshot(send); // read-only; pre-auth allowed (unchanged 3b boundary)
          break;
        }
      }
    });

    ws.on("close", () => {
      for (const id of joined) {
        tables.get(id)?.leave(send);
        if (identity !== null) bump(id, identity, -1);
        broadcastPresence(id);
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
