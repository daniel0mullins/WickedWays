/**
 * The wire protocol shared by the comms client and room server. `command`,
 * `delta`, and `snapshot` are **opaque** (`unknown`) here: the server relays and
 * orders them without understanding the engine, so this package has no engine
 * dependency.
 */

/** A log entry as carried on the wire (Spec 2's `LogEntry` with opaque payloads). */
export interface WireLogEntry {
  seq: number;
  baseSeq: number;
  command: unknown;
  delta: unknown;
}

/** Messages a client sends to the room server. */
export type ClientMsg =
  | { t: "join"; campaignId: string; clientId: string; fromSeq: number }
  | { t: "append"; campaignId: string; entry: WireLogEntry }
  | { t: "getSnapshot"; campaignId: string }
  | { t: "putSnapshot"; campaignId: string; seq: number; snapshot: unknown };

/** Messages the room server sends to a client. */
export type ServerMsg =
  | { t: "joined"; head: number }
  | { t: "entry"; entry: WireLogEntry }
  | { t: "appendOk"; seq: number }
  | { t: "appendConflict"; head: number }
  | { t: "snapshot"; seq: number; snapshot: unknown }
  | { t: "error"; message: string };

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

function isWireLogEntry(x: unknown): x is WireLogEntry {
  return isObj(x) && typeof x.seq === "number" && typeof x.baseSeq === "number" && "command" in x && "delta" in x;
}

/** Validates an inbound client message; returns it narrowed, or `null` if malformed. */
export function parseClientMsg(raw: unknown): ClientMsg | null {
  if (!isObj(raw) || typeof raw.t !== "string") return null;
  switch (raw.t) {
    case "join":
      return typeof raw.campaignId === "string" && typeof raw.clientId === "string" && typeof raw.fromSeq === "number"
        ? { t: "join", campaignId: raw.campaignId, clientId: raw.clientId, fromSeq: raw.fromSeq }
        : null;
    case "append":
      return typeof raw.campaignId === "string" && isWireLogEntry(raw.entry)
        ? { t: "append", campaignId: raw.campaignId, entry: raw.entry }
        : null;
    case "getSnapshot":
      return typeof raw.campaignId === "string" ? { t: "getSnapshot", campaignId: raw.campaignId } : null;
    case "putSnapshot":
      return typeof raw.campaignId === "string" && typeof raw.seq === "number" && "snapshot" in raw
        ? { t: "putSnapshot", campaignId: raw.campaignId, seq: raw.seq, snapshot: raw.snapshot }
        : null;
    default:
      return null;
  }
}

/** Validates an inbound server message; returns it narrowed, or `null` if malformed. */
export function parseServerMsg(raw: unknown): ServerMsg | null {
  if (!isObj(raw) || typeof raw.t !== "string") return null;
  switch (raw.t) {
    case "joined":
      return typeof raw.head === "number" ? { t: "joined", head: raw.head } : null;
    case "entry":
      return isWireLogEntry(raw.entry) ? { t: "entry", entry: raw.entry } : null;
    case "appendOk":
      return typeof raw.seq === "number" ? { t: "appendOk", seq: raw.seq } : null;
    case "appendConflict":
      return typeof raw.head === "number" ? { t: "appendConflict", head: raw.head } : null;
    case "snapshot":
      return typeof raw.seq === "number" && "snapshot" in raw
        ? { t: "snapshot", seq: raw.seq, snapshot: raw.snapshot }
        : null;
    case "error":
      return typeof raw.message === "string" ? { t: "error", message: raw.message } : null;
    default:
      return null;
  }
}
