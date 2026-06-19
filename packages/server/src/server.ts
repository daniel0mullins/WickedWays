import { WebSocketServer, type WebSocket } from "ws";
import { parseClientMsg, type ServerMsg } from "@wickedways/transport-shared";
import { Table, type Subscriber } from "./table.js";

/** A running room server. */
export interface ServerHandle {
  port: number;
  close(): Promise<void>;
}

/**
 * Starts a WebSocket server: a thin adapter over a `Map<campaignId, Table>`. Each
 * connection becomes a {@link Subscriber} that JSON-serializes messages to its
 * socket; all ordering, acking, and broadcast live in {@link Table}. The server
 * never inspects `command`/`delta`/`snapshot` payloads.
 */
export function createServer(opts: { port?: number } = {}): Promise<ServerHandle> {
  const tables = new Map<string, Table>();
  const tableFor = (id: string): Table => {
    let t = tables.get(id);
    if (t === undefined) { t = new Table(); tables.set(id, t); }
    return t;
  };

  const wss = new WebSocketServer({ port: opts.port ?? 0 });

  wss.on("connection", (ws: WebSocket) => {
    const send: Subscriber = (msg: ServerMsg) => ws.send(JSON.stringify(msg));
    const joined = new Set<string>();

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
        case "join":
          tableFor(msg.campaignId).join(send, msg.fromSeq);
          joined.add(msg.campaignId);
          break;
        case "append":
          tableFor(msg.campaignId).append(msg.entry, send);
          break;
        case "getSnapshot":
          tableFor(msg.campaignId).sendSnapshot(send);
          break;
        case "putSnapshot":
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
