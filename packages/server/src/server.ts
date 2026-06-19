import { WebSocketServer, type WebSocket } from "ws";
import { parseClientMsg, type ServerMsg, type Identity } from "@wickedways/transport-shared";
import { Table, type Subscriber } from "./table.js";

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
        case "append":
          if (identity === null) {
            send({ t: "denied", reason: "not authenticated" });
            break;
          }
          // Task 4 inserts the ownership check on msg.actor here.
          tableFor(msg.campaignId).append(msg.entry, send);
          break;
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
