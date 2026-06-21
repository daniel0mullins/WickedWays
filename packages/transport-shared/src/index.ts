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
 * The actor a command is authorized as. This is a server-internal type consumed by
 * `Membership.mayAct`; the server derives it from the command via `actorOf` rather
 * than reading it from the wire envelope. `character` = an owned seat; `gm` =
 * GM/lifecycle/NPC; `join` = self-claim a NEW seat (the joinCampaign command).
 */
export type Actor =
  | { kind: "character"; actorId: string }
  | { kind: "gm" }
  | { kind: "join"; characterId: string };

/** Messages a client sends to the room server. */
export type ClientMsg =
  | { t: "join"; campaignId: string; token: string; fromSeq: number }
  | { t: "submit"; campaignId: string; command: unknown }
  | { t: "getSnapshot"; campaignId: string }
  | { t: "assignSeat"; campaignId: string; characterId: string; identity: string }
  | { t: "unassignSeat"; campaignId: string; characterId: string }
  | { t: "transferGM"; campaignId: string; identity: string }
  | { t: "chatSend"; campaignId: string; body: string; to?: Identity }
  | { t: "chatHistory"; campaignId: string; before: number }
  | { t: "chatEdit"; campaignId: string; id: number; body: string }
  | { t: "chatDelete"; campaignId: string; id: number }
  | { t: "chatReact"; campaignId: string; id: number; emoji: string; on: boolean }
  | { t: "chatRead"; campaignId: string; upTo: number }
  | { t: "typing"; campaignId: string; to?: Identity };

/** One seat's presence: its owner (or null if unclaimed) and whether that owner is online. */
export interface PresenceEntry { characterId: string; owner: string | null; online: boolean }

/** One emoji reaction on a message: the emoji and the identities who reacted with it. */
export interface ChatReaction { emoji: string; by: Identity[] }

/**
 * A chat message as carried on the wire. `id` is the server-assigned per-campaign
 * `chatSeq` (monotonic). `from` is the server-stamped, unforgeable sender identity.
 * `to` present ⇒ a whisper visible only to `from` and `to`.
 */
export interface ChatMsg {
  id: number;
  from: Identity;
  to?: Identity;
  body: string;
  ts: number;
  editedTs?: number;
  deleted?: boolean;
  reactions?: ChatReaction[];
}

/** One player's roster entry: stable identity, host display name, and online state. */
export interface PlayerEntry { identity: Identity; displayName: string; online: boolean }

/** Messages the room server sends to a client. */
export type ServerMsg =
  | { t: "joined"; head: number }
  | { t: "entry"; entry: WireLogEntry }
  | { t: "committed"; seq: number; delta: unknown }
  | { t: "snapshot"; seq: number; snapshot: unknown }
  | { t: "denied"; reason: string }
  | { t: "error"; message: string }
  | { t: "presence"; campaignId: string; seats: PresenceEntry[]; gm: { identity: string; online: boolean } }
  | { t: "chat"; msg: ChatMsg }
  | { t: "chatHistory"; campaignId: string; msgs: ChatMsg[]; more: boolean }
  | { t: "players"; campaignId: string; players: PlayerEntry[] }
  | { t: "chatEdited"; campaignId: string; id: number; body: string; editedTs: number }
  | { t: "chatDeleted"; campaignId: string; id: number }
  | { t: "chatReact"; campaignId: string; id: number; emoji: string; identity: Identity; on: boolean }
  | { t: "chatReads"; campaignId: string; marks: { identity: Identity; upTo: number }[] }
  | { t: "typing"; campaignId: string; from: Identity; to?: Identity };

/**
 * Pure helper: returns a NEW reactions array with `identity` toggled in `emoji`'s `by[]`.
 * `on: true` adds `identity` if absent; `on: false` removes it. Drops emoji entries whose
 * `by` becomes empty. Never mutates the input array or its entries.
 */
export function applyReaction(
  reactions: ChatReaction[] | undefined,
  emoji: string,
  identity: Identity,
  on: boolean,
): ChatReaction[] {
  const base = (reactions ?? []).map((r) => ({ emoji: r.emoji, by: [...r.by] }));
  const entry = base.find((r) => r.emoji === emoji);
  if (on) {
    if (entry === undefined) base.push({ emoji, by: [identity] });
    else if (!entry.by.includes(identity)) entry.by.push(identity);
  } else if (entry !== undefined) {
    entry.by = entry.by.filter((i) => i !== identity);
  }
  return base.filter((r) => r.by.length > 0);
}

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

function isChatMsg(x: unknown): x is ChatMsg {
  return isObj(x) && typeof x.id === "number" && typeof x.from === "string"
    && typeof x.body === "string" && typeof x.ts === "number"
    && (x.to === undefined || typeof x.to === "string");
}

function isPlayerEntry(x: unknown): x is PlayerEntry {
  return isObj(x) && typeof x.identity === "string"
    && typeof x.displayName === "string" && typeof x.online === "boolean";
}

function isReadMark(x: unknown): x is { identity: Identity; upTo: number } {
  return isObj(x) && typeof x.identity === "string" && typeof x.upTo === "number";
}

/** Validates an inbound client message; returns it narrowed, or `null` if malformed. */
export function parseClientMsg(raw: unknown): ClientMsg | null {
  if (!isObj(raw) || typeof raw.t !== "string") return null;
  switch (raw.t) {
    case "join":
      return typeof raw.campaignId === "string" && typeof raw.token === "string" && typeof raw.fromSeq === "number"
        ? { t: "join", campaignId: raw.campaignId, token: raw.token, fromSeq: raw.fromSeq }
        : null;
    case "submit":
      return typeof raw.campaignId === "string" && "command" in raw
        ? { t: "submit", campaignId: raw.campaignId, command: raw.command }
        : null;
    case "getSnapshot":
      return typeof raw.campaignId === "string" ? { t: "getSnapshot", campaignId: raw.campaignId } : null;
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
    case "chatSend":
      return typeof raw.campaignId === "string" && typeof raw.body === "string"
        && (raw.to === undefined || typeof raw.to === "string")
        ? { t: "chatSend", campaignId: raw.campaignId, body: raw.body, to: raw.to }
        : null;
    case "chatHistory":
      return typeof raw.campaignId === "string" && typeof raw.before === "number"
        ? { t: "chatHistory", campaignId: raw.campaignId, before: raw.before }
        : null;
    case "chatEdit":
      return typeof raw.campaignId === "string" && typeof raw.id === "number" && typeof raw.body === "string"
        ? { t: "chatEdit", campaignId: raw.campaignId, id: raw.id, body: raw.body }
        : null;
    case "chatDelete":
      return typeof raw.campaignId === "string" && typeof raw.id === "number"
        ? { t: "chatDelete", campaignId: raw.campaignId, id: raw.id }
        : null;
    case "chatReact":
      return typeof raw.campaignId === "string" && typeof raw.id === "number"
        && typeof raw.emoji === "string" && typeof raw.on === "boolean"
        ? { t: "chatReact", campaignId: raw.campaignId, id: raw.id, emoji: raw.emoji, on: raw.on }
        : null;
    case "chatRead":
      return typeof raw.campaignId === "string" && typeof raw.upTo === "number"
        ? { t: "chatRead", campaignId: raw.campaignId, upTo: raw.upTo }
        : null;
    case "typing":
      return typeof raw.campaignId === "string" && (raw.to === undefined || typeof raw.to === "string")
        ? { t: "typing", campaignId: raw.campaignId, to: raw.to }
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
    case "committed":
      return typeof raw.seq === "number" && "delta" in raw ? { t: "committed", seq: raw.seq, delta: raw.delta } : null;
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
    case "chat":
      return isChatMsg(raw.msg) ? { t: "chat", msg: raw.msg } : null;
    case "chatHistory":
      return typeof raw.campaignId === "string" && Array.isArray(raw.msgs) && raw.msgs.every(isChatMsg)
        && typeof raw.more === "boolean"
        ? { t: "chatHistory", campaignId: raw.campaignId, msgs: raw.msgs, more: raw.more }
        : null;
    case "players":
      return typeof raw.campaignId === "string" && Array.isArray(raw.players) && raw.players.every(isPlayerEntry)
        ? { t: "players", campaignId: raw.campaignId, players: raw.players }
        : null;
    case "chatEdited":
      return typeof raw.campaignId === "string" && typeof raw.id === "number"
        && typeof raw.body === "string" && typeof raw.editedTs === "number"
        ? { t: "chatEdited", campaignId: raw.campaignId, id: raw.id, body: raw.body, editedTs: raw.editedTs }
        : null;
    case "chatDeleted":
      return typeof raw.campaignId === "string" && typeof raw.id === "number"
        ? { t: "chatDeleted", campaignId: raw.campaignId, id: raw.id }
        : null;
    case "chatReact":
      return typeof raw.campaignId === "string" && typeof raw.id === "number"
        && typeof raw.emoji === "string" && typeof raw.identity === "string" && typeof raw.on === "boolean"
        ? { t: "chatReact", campaignId: raw.campaignId, id: raw.id, emoji: raw.emoji, identity: raw.identity, on: raw.on }
        : null;
    case "chatReads":
      return typeof raw.campaignId === "string" && Array.isArray(raw.marks) && raw.marks.every(isReadMark)
        ? { t: "chatReads", campaignId: raw.campaignId, marks: raw.marks }
        : null;
    case "typing":
      return typeof raw.campaignId === "string" && typeof raw.from === "string"
        && (raw.to === undefined || typeof raw.to === "string")
        ? { t: "typing", campaignId: raw.campaignId, from: raw.from, to: raw.to }
        : null;
    default:
      return null;
  }
}
