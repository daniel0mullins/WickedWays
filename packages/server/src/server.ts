import { WebSocketServer, type WebSocket } from "ws";
import { parseClientMsg, type ServerMsg, type Identity } from "@wickedways/transport-shared";
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
}

/**
 * Starts a WebSocket server: a thin adapter over a `Map<campaignId, Table>` plus an
 * auth layer. Each connection authenticates on `join` (the host's `verifyToken`);
 * writes (`append`/`putSnapshot`) require an authenticated connection. The server
 * never parses command/delta/snapshot semantics. (Seat-ownership enforcement and the
 * GM control messages are added in Task 4.)
 */
export function createServer(opts: ServerOptions): Promise<ServerHandle> {
  const tables = new Map<string, Table>();
  const tableFor = (id: string): Table => {
    let t = tables.get(id);
    if (t === undefined) { t = new Table(); tables.set(id, t); }
    return t;
  };

  const memberships = new Map<string, Membership>();
  const membershipFor = (id: string): Membership => {
    let m = memberships.get(id);
    if (m === undefined) { m = new Membership(opts.gmIdentityFor(id)); memberships.set(id, m); }
    return m;
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
          if (id === null) {
            send({ t: "denied", reason: "authentication failed" });
            return;
          }
          identity = id;
          tableFor(msg.campaignId).join(send, msg.fromSeq);
          joined.add(msg.campaignId);
          break;
        }
        case "append": {
          if (identity === null) { send({ t: "denied", reason: "not authenticated" }); break; }
          const m = membershipFor(msg.campaignId);
          if (!m.mayAct(identity, msg.actor)) { send({ t: "denied", reason: "not authorized for this seat" }); break; }
          const result = tableFor(msg.campaignId).append(msg.entry, send);
          if (msg.actor.kind === "join" && result.committed) {
            m.claim(msg.actor.characterId, identity); // self-service seat claim, on commit
            // Task 5 broadcasts presence here.
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
          // Task 5 broadcasts presence here.
          break;
        }
        case "getSnapshot":
          tableFor(msg.campaignId).sendSnapshot(send); // read-only observation, pre-auth allowed
          break;
        case "putSnapshot":
          if (identity === null) {
            send({ t: "denied", reason: "not authenticated" });
            break;
          }
          tableFor(msg.campaignId).putSnapshot(msg.seq, msg.snapshot);
          break;
      }
    });

    ws.on("close", () => {
      for (const id of joined) tables.get(id)?.leave(send);
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
