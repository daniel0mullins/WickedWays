import type { ChatPolicy } from "wickedways/lib/chat-policy";
import { applyReaction, type ChatMsg, type Identity } from "@wickedways/transport-shared";
import type { ChatStore, ReadMark } from "./chat-store.js";

/** Maximum chat body length (server-enforced). */
export const MAX_CHAT_BODY = 2000;

/** A refusal from a {@link Chat} operation (policy off, invalid body, not owner, missing). */
export type ChatDeny = { ok: false; reason: string };

const denied = (reason: string): ChatDeny => ({ ok: false, reason });

/**
 * One campaign's chat — a side-channel beside {@link Table}. Assigns the monotonic
 * per-campaign `chatSeq` (the message id), enforces {@link ChatPolicy} and whisper
 * visibility, and persists through a {@link ChatStore}. Engine-agnostic: it never
 * touches the game `Authority`. Callers (the server) route delivery using `msg.to`.
 */
export class Chat {
  readonly #campaignId: string;
  readonly #policy: ChatPolicy;
  readonly #store: ChatStore;
  readonly #now: () => number;
  #seq: number;

  private constructor(campaignId: string, policy: ChatPolicy, store: ChatStore, now: () => number, seq: number) {
    this.#campaignId = campaignId;
    this.#policy = policy;
    this.#store = store;
    this.#now = now;
    this.#seq = seq;
  }

  /** Builds a Chat, seeding `chatSeq` above the store's highest persisted id. */
  static async load(campaignId: string, policy: ChatPolicy, store: ChatStore, now: () => number): Promise<Chat> {
    const max = await store.maxId(campaignId);
    return new Chat(campaignId, policy, store, now, max);
  }

  /** This campaign's policy (the server reads it to gate routing of disabled features). */
  get policy(): ChatPolicy {
    return this.#policy;
  }

  /** Sends a room (`to` undefined) or whisper message. Returns the stamped msg, or a denial. */
  async send(from: Identity, body: string, to: Identity | undefined): Promise<ChatMsg | ChatDeny> {
    if (to !== undefined && !this.#policy.whisper) return denied("whispers are disabled");
    const trimmed = body.trim();
    if (trimmed.length === 0) return denied("empty message");
    if (body.length > MAX_CHAT_BODY) return denied("message too long");
    const msg: ChatMsg = { id: ++this.#seq, from, to, body, ts: this.#now() };
    await this.#store.append(this.#campaignId, msg);
    return msg;
  }

  /** The recent visible window + read marks for a joining identity. */
  async backfill(identity: Identity): Promise<{ msgs: ChatMsg[]; reads: ReadMark[] }> {
    const msgs = await this.#store.recent(this.#campaignId, identity, this.#policy.backfillWindow);
    const reads = this.#policy.readReceipts ? await this.#store.reads(this.#campaignId) : [];
    return { msgs, reads };
  }

  /** Older visible messages before a cursor (pagination). */
  history(identity: Identity, before: number): Promise<{ msgs: ChatMsg[]; more: boolean }> {
    return this.#store.page(this.#campaignId, identity, before, this.#policy.backfillWindow);
  }

  async edit(from: Identity, id: number, body: string): Promise<ChatMsg | ChatDeny> {
    if (!this.#policy.edit) return denied("editing is disabled");
    const msg = await this.#store.get(this.#campaignId, id);
    if (msg === null || msg.deleted) return denied("message not found");
    if (msg.from !== from) return denied("not your message");
    const trimmed = body.trim();
    if (trimmed.length === 0) return denied("empty message");
    if (body.length > MAX_CHAT_BODY) return denied("message too long");
    const updated: ChatMsg = { ...msg, body, editedTs: this.#now() };
    await this.#store.update(this.#campaignId, updated);
    return updated;
  }

  async remove(from: Identity, id: number): Promise<ChatMsg | ChatDeny> {
    if (!this.#policy.edit) return denied("deleting is disabled");
    const msg = await this.#store.get(this.#campaignId, id);
    if (msg === null || msg.deleted) return denied("message not found");
    if (msg.from !== from) return denied("not your message");
    const tomb: ChatMsg = { id: msg.id, from: msg.from, to: msg.to, body: "", ts: msg.ts, deleted: true };
    await this.#store.update(this.#campaignId, tomb);
    return tomb;
  }

  async react(identity: Identity, id: number, emoji: string, on: boolean): Promise<ChatMsg | ChatDeny> {
    if (!this.#policy.reactions) return denied("reactions are disabled");
    const msg = await this.#store.get(this.#campaignId, id);
    if (msg === null || msg.deleted) return denied("message not found");
    const updated: ChatMsg = { ...msg, reactions: applyReaction(msg.reactions, emoji, identity, on) };
    await this.#store.update(this.#campaignId, updated);
    return updated;
  }
}
