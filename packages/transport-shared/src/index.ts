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

/** An authenticated identity, opaque to the engine (chosen by the host's verifier). */
export type Identity = string;

/**
 * The actor an append acts as, declared at the envelope so the server can enforce
 * ownership without parsing the opaque command. `character` = an owned seat; `gm` =
 * GM/lifecycle/NPC; `join` = self-claim a NEW seat (the joinCampaign append; the
 * client surfaces the new character's id).
 */
export type Actor =
  | { kind: "character"; actorId: string }
  | { kind: "gm" }
  | { kind: "join"; characterId: string };

/** Messages a client sends to the room server. */
export type ClientMsg =
  | { t: "join"; campaignId: string; token: string; fromSeq: number }
  | { t: "append"; campaignId: string; entry: WireLogEntry; actor: Actor }
  | { t: "getSnapshot"; campaignId: string }
  | { t: "putSnapshot"; campaignId: string; seq: number; snapshot: unknown }
  | { t: "assignSeat"; campaignId: string; characterId: string; identity: string }
  | { t: "unassignSeat"; campaignId: string; characterId: string }
  | { t: "transferGM"; campaignId: string; identity: string };

/** One seat's presence: its owner (or null if unclaimed) and whether that owner is online. */
export interface PresenceEntry { characterId: string; owner: string | null; online: boolean }

/** Messages the room server sends to a client. */
export type ServerMsg =
  | { t: "joined"; head: number }
  | { t: "entry"; entry: WireLogEntry }
  | { t: "appendOk"; seq: number }
  | { t: "appendConflict"; head: number }
  | { t: "snapshot"; seq: number; snapshot: unknown }
  | { t: "denied"; reason: string }
  | { t: "error"; message: string }
  | { t: "presence"; campaignId: string; seats: PresenceEntry[]; gm: { identity: string; online: boolean } };

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

function isWireLogEntry(x: unknown): x is WireLogEntry {
  return isObj(x) && typeof x.seq === "number" && typeof x.baseSeq === "number" && "command" in x && "delta" in x;
}

function isPresenceEntry(x: unknown): x is PresenceEntry {
  return isObj(x) && typeof x.characterId === "string"
    && (x.owner === null || typeof x.owner === "string") && typeof x.online === "boolean";
}

function isActor(x: unknown): x is Actor {
  if (!isObj(x)) return false;
  if (x.kind === "character") return typeof x.actorId === "string";
  if (x.kind === "gm") return true;
  if (x.kind === "join") return typeof x.characterId === "string";
  return false;
}

/** Validates an inbound client message; returns it narrowed, or `null` if malformed. */
export function parseClientMsg(raw: unknown): ClientMsg | null {
  if (!isObj(raw) || typeof raw.t !== "string") return null;
  switch (raw.t) {
    case "join":
      return typeof raw.campaignId === "string" && typeof raw.token === "string" && typeof raw.fromSeq === "number"
        ? { t: "join", campaignId: raw.campaignId, token: raw.token, fromSeq: raw.fromSeq }
        : null;
    case "append":
      return typeof raw.campaignId === "string" && isWireLogEntry(raw.entry) && isActor(raw.actor)
        ? { t: "append", campaignId: raw.campaignId, entry: raw.entry, actor: raw.actor }
        : null;
    case "getSnapshot":
      return typeof raw.campaignId === "string" ? { t: "getSnapshot", campaignId: raw.campaignId } : null;
    case "putSnapshot":
      return typeof raw.campaignId === "string" && typeof raw.seq === "number" && "snapshot" in raw
        ? { t: "putSnapshot", campaignId: raw.campaignId, seq: raw.seq, snapshot: raw.snapshot }
        : null;
    case "assignSeat":
      return typeof raw.campaignId === "string" && typeof raw.characterId === "string" && typeof raw.identity === "string"
        ? { t: "assignSeat", campaignId: raw.campaignId, characterId: raw.characterId, identity: raw.identity }
        : null;
    case "unassignSeat":
      return typeof raw.campaignId === "string" && typeof raw.characterId === "string"
        ? { t: "unassignSeat", campaignId: raw.campaignId, characterId: raw.characterId }
        : null;
    case "transferGM":
      return typeof raw.campaignId === "string" && typeof raw.identity === "string"
        ? { t: "transferGM", campaignId: raw.campaignId, identity: raw.identity }
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
    case "denied":
      return typeof raw.reason === "string" ? { t: "denied", reason: raw.reason } : null;
    case "error":
      return typeof raw.message === "string" ? { t: "error", message: raw.message } : null;
    case "presence":
      return typeof raw.campaignId === "string" && Array.isArray(raw.seats) && raw.seats.every(isPresenceEntry)
        && isObj(raw.gm) && typeof raw.gm.identity === "string" && typeof raw.gm.online === "boolean"
        ? { t: "presence", campaignId: raw.campaignId, seats: raw.seats, gm: { identity: raw.gm.identity, online: raw.gm.online } }
        : null;
    default:
      return null;
  }
}
