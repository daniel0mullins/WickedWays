import type { Authority } from "wickedways/lib/sync/authority";
import type { Command } from "wickedways/lib/sync/types";
import type { CampaignSnapshot } from "wickedways/lib/serialization/types";
import type { WireLogEntry, ServerMsg } from "@wickedways/transport-shared";

/** A connected participant: receives ordered server messages for one {@link Table}. */
export type Subscriber = (msg: ServerMsg) => void;

/**
 * The server-side coordinator for one campaign's session — the virtual tabletop.
 * Wraps the engine {@link Authority} (the single source of truth) and the
 * participant set, emitting ordered messages through {@link Subscriber} callbacks.
 * The submitter receives `committed{seq,delta}`; every other participant receives
 * `entry{seq,delta}`. When durability hooks are set, a commit is persisted BEFORE
 * it is acked/broadcast (flush-before-ack); a persist failure rolls the campaign
 * back via `reload` and denies the submitter. Named `Table` (not `Room`) to avoid
 * colliding with the engine's game-location `Room`.
 */
export class Table {
  #authority: Authority;
  #participants = new Set<Subscriber>();
  #persist: () => Promise<void> = () => Promise.resolve();
  #reload: () => Promise<void> = () => Promise.resolve();

  constructor(authority: Authority) {
    this.#authority = authority;
  }

  /** Installs the durability hooks (no-ops until set; the ephemeral path never sets them). */
  setDurability(hooks: { persist: () => Promise<void>; reload: () => Promise<void> }): void {
    this.#persist = hooks.persist;
    this.#reload = hooks.reload;
  }

  /** Swaps in a rebuilt authority (used by `reload` after a persist failure). */
  replaceAuthority(authority: Authority): void {
    this.#authority = authority;
  }

  /** Highest committed seq (0 when empty). Delegates to the authority — single source of truth. */
  head(): number {
    return this.#authority.head();
  }

  /** The authority's current head snapshot (what `persist` writes). */
  currentSnapshot(): CampaignSnapshot {
    return this.#authority.loadSnapshot().snapshot;
  }

  /** Writes the current durable record (no-op without hooks). */
  persist(): Promise<void> {
    return this.#persist();
  }

  /** Rebuilds the authority/membership from the last durable record (no-op without hooks). */
  reload(): Promise<void> {
    return this.#reload();
  }

  /** Registers a participant, acks the current head, then backfills entries after `fromSeq`. */
  join(sub: Subscriber, fromSeq: number): void {
    this.#participants.add(sub);
    sub({ t: "joined", head: this.head() });
    for (const e of this.#authority.entriesSince(fromSeq + 1)) {
      sub({ t: "entry", entry: e as unknown as WireLogEntry });
    }
  }

  /** Removes a participant (e.g. on disconnect). */
  leave(sub: Subscriber): void {
    this.#participants.delete(sub);
  }

  /**
   * Resolves a command through the authority. `onCommit` (if given) runs AFTER the
   * in-memory commit and BEFORE persistence, so a seat-claim it performs is written
   * in the SAME atomic `save` as the commit. On commit: persist (flush-before-ack),
   * then ack `sender` with `committed` and broadcast `entry` to every OTHER
   * participant. On a persist failure: `reload` (discarding the un-persisted commit
   * and any `onCommit` mutation) and reply `denied` to `sender` only. On an
   * authority denial: reply `denied` to `sender` only.
   */
  async submit(
    command: Command,
    sender: Subscriber,
    onCommit?: () => void,
  ): Promise<{ committed: true; seq: number } | { committed: false }> {
    const res = this.#authority.submit(command);
    if (!res.ok) {
      sender({ t: "denied", reason: res.reason });
      return { committed: false };
    }
    onCommit?.();
    try {
      await this.#persist();
    } catch {
      await this.#reload(); // revert campaign + membership to the last durable record
      sender({ t: "denied", reason: "could not persist; retry" });
      return { committed: false };
    }
    const entry: WireLogEntry = { seq: res.seq, baseSeq: res.seq - 1, command, delta: res.delta };
    sender({ t: "committed", seq: res.seq, delta: res.delta });
    for (const p of this.#participants) if (p !== sender) p({ t: "entry", entry });
    return { committed: true, seq: res.seq };
  }

  /** Sends the authority's latest checkpoint to `requester`. */
  sendSnapshot(requester: Subscriber): void {
    const snap = this.#authority.loadSnapshot();
    requester({ t: "snapshot", seq: snap.seq, snapshot: snap.snapshot });
  }

  /** Sends a server message to every current participant (used for presence). */
  broadcast(msg: ServerMsg): void {
    for (const p of this.#participants) p(msg);
  }
}
