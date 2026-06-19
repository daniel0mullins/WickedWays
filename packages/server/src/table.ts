import type { Authority } from "wickedways/lib/sync/authority";
import type { Command } from "wickedways/lib/sync/types";
import type { WireLogEntry, ServerMsg } from "@wickedways/transport-shared";

/** A connected participant: receives ordered server messages for one {@link Table}. */
export type Subscriber = (msg: ServerMsg) => void;

/**
 * The server-side coordinator for one campaign's session — the virtual tabletop.
 * Wraps the engine {@link Authority} (the single source of truth) and the
 * participant set, emitting ordered messages through {@link Subscriber} callbacks.
 * The submitter receives `committed{seq,delta}`; every other participant receives
 * `entry{seq,delta}`. Named `Table` (not `Room`) to avoid colliding with the
 * engine's game-location `Room`.
 */
export class Table {
  readonly #authority: Authority;
  #participants = new Set<Subscriber>();

  constructor(authority: Authority) {
    this.#authority = authority;
  }

  /** Highest committed seq (0 when empty). */
  head(): number {
    return this.#authority.head();
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
   * Resolves a command through the authority. On commit: acks `sender` with
   * `committed{seq,delta}` and broadcasts `entry{seq,delta}` to every OTHER
   * participant. On denial: replies `denied{reason}` to `sender` only.
   */
  submit(command: Command, sender: Subscriber): { committed: true; seq: number } | { committed: false } {
    const res = this.#authority.submit(command);
    if (!res.ok) {
      sender({ t: "denied", reason: res.reason });
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
