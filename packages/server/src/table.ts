import type { WireLogEntry, ServerMsg } from "@wickedways/transport-shared";

/** A connected participant: receives ordered server messages for one {@link Table}. */
export type Subscriber = (msg: ServerMsg) => void;

/**
 * The server-side coordinator for one campaign's session — the virtual tabletop.
 * Owns the ordered CAS log, the latest snapshot, and the participant set, and
 * emits ordered messages through {@link Subscriber} callbacks (never raw sockets),
 * so it is fully unit-testable without `ws`. The server is the ordering authority:
 * an append commits iff its `baseSeq` equals the current head, the committed `seq`
 * is stamped as `head + 1`, and the entry is broadcast to every participant.
 * Entirely engine-agnostic — entries and snapshots are opaque. Named `Table`
 * (not `Room`) to avoid colliding with the engine's game-location `Room`.
 */
export class Table {
  #log: WireLogEntry[] = [];
  #snapshot: { seq: number; snapshot: unknown } | null = null;
  #participants = new Set<Subscriber>();

  /** Highest committed seq (0 when empty). */
  head(): number {
    const last = this.#log[this.#log.length - 1];
    return last === undefined ? 0 : last.seq;
  }

  /** Registers a participant, acks with the current head, then backfills entries after `fromSeq`. */
  join(sub: Subscriber, fromSeq: number): void {
    this.#participants.add(sub);
    sub({ t: "joined", head: this.head() });
    for (const e of this.#log) if (e.seq >= fromSeq + 1) sub({ t: "entry", entry: e });
  }

  /** Removes a participant (e.g. on disconnect). */
  leave(sub: Subscriber): void {
    this.#participants.delete(sub);
  }

  /**
   * Compare-and-swap append from `sender`. On success: acks `sender` with
   * `appendOk{seq}` and broadcasts the committed `entry` to all participants
   * (including `sender`). On a stale base: replies `appendConflict{head}` to
   * `sender` only, changing nothing.
   */
  append(entry: WireLogEntry, sender: Subscriber): { committed: true; seq: number } | { committed: false } {
    const head = this.head();
    if (entry.baseSeq !== head) {
      sender({ t: "appendConflict", head });
      return { committed: false };
    }
    const seq = head + 1;
    const committed: WireLogEntry = { ...entry, seq };
    this.#log.push(committed);
    sender({ t: "appendOk", seq });
    for (const p of this.#participants) p({ t: "entry", entry: committed });
    return { committed: true, seq };
  }

  /** Sends the latest checkpoint to `requester` (seq 0 / null when absent). */
  sendSnapshot(requester: Subscriber): void {
    const snap = this.#snapshot;
    requester(
      snap === null
        ? { t: "snapshot", seq: 0, snapshot: null }
        : { t: "snapshot", seq: snap.seq, snapshot: snap.snapshot },
    );
  }

  /** Stores a checkpoint at `seq` (last-writer-wins for `seq >=` the stored one). */
  putSnapshot(seq: number, snapshot: unknown): void {
    if (this.#snapshot === null || seq >= this.#snapshot.seq) {
      this.#snapshot = { seq, snapshot };
    }
  }
}
