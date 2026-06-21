import type { ChatMsg, Identity } from "@wickedways/transport-shared";

/** A per-identity read high-water mark (the highest `chatSeq` that identity has read). */
export interface ReadMark { identity: Identity; upTo: number }

/**
 * Durable, **unbounded** chat persistence for one server. Nothing is ever deleted;
 * `recent`/`page` bound only the working set. `recent`/`page` MUST apply whisper
 * visibility: a message is visible to `identity` iff it is room-wide (`to`
 * undefined) or `identity` is its `from` or `to`.
 */
export interface ChatStore {
  append(campaignId: string, msg: ChatMsg): Promise<void>;
  update(campaignId: string, msg: ChatMsg): Promise<void>;
  recent(campaignId: string, identity: Identity, limit: number): Promise<ChatMsg[]>;
  page(campaignId: string, identity: Identity, before: number, limit: number): Promise<{ msgs: ChatMsg[]; more: boolean }>;
  get(campaignId: string, id: number): Promise<ChatMsg | null>;
  maxId(campaignId: string): Promise<number>;
  setRead(campaignId: string, identity: Identity, upTo: number): Promise<void>;
  reads(campaignId: string): Promise<ReadMark[]>;
}

function visibleTo(msg: ChatMsg, identity: Identity): boolean {
  return msg.to === undefined || msg.from === identity || msg.to === identity;
}

/** In-memory {@link ChatStore} — the default when no durable store is supplied. */
export class InMemoryChatStore implements ChatStore {
  readonly #msgs = new Map<string, ChatMsg[]>();          // campaignId → ascending by id
  readonly #reads = new Map<string, Map<Identity, number>>();

  #list(campaignId: string): ChatMsg[] {
    let l = this.#msgs.get(campaignId);
    if (l === undefined) { l = []; this.#msgs.set(campaignId, l); }
    return l;
  }

  append(campaignId: string, msg: ChatMsg): Promise<void> {
    this.#list(campaignId).push(msg);
    return Promise.resolve();
  }

  update(campaignId: string, msg: ChatMsg): Promise<void> {
    const l = this.#list(campaignId);
    const i = l.findIndex((x) => x.id === msg.id);
    if (i >= 0) l[i] = msg;
    return Promise.resolve();
  }

  recent(campaignId: string, identity: Identity, limit: number): Promise<ChatMsg[]> {
    const visible = this.#list(campaignId).filter((x) => visibleTo(x, identity));
    return Promise.resolve(visible.slice(-limit));
  }

  page(campaignId: string, identity: Identity, before: number, limit: number): Promise<{ msgs: ChatMsg[]; more: boolean }> {
    const older = this.#list(campaignId).filter((x) => x.id < before && visibleTo(x, identity));
    const msgs = older.slice(-limit);
    return Promise.resolve({ msgs, more: older.length > msgs.length });
  }

  get(campaignId: string, id: number): Promise<ChatMsg | null> {
    return Promise.resolve(this.#list(campaignId).find((x) => x.id === id) ?? null);
  }

  maxId(campaignId: string): Promise<number> {
    const l = this.#list(campaignId);
    return Promise.resolve(l.length === 0 ? 0 : l[l.length - 1]!.id);
  }

  setRead(campaignId: string, identity: Identity, upTo: number): Promise<void> {
    let m = this.#reads.get(campaignId);
    if (m === undefined) { m = new Map(); this.#reads.set(campaignId, m); }
    m.set(identity, Math.max(upTo, m.get(identity) ?? 0));
    return Promise.resolve();
  }

  reads(campaignId: string): Promise<ReadMark[]> {
    const m = this.#reads.get(campaignId);
    return Promise.resolve(m ? [...m].map(([identity, upTo]) => ({ identity, upTo })) : []);
  }
}
