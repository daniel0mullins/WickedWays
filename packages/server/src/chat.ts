import type { ChatPolicy } from "wickedways/lib/chat-policy";
import type { ChatMsg, Identity } from "@wickedways/transport-shared";
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
}
