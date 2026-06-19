import { Authority } from "./authority";
import type { Command, LogEntry, SubmitResult } from "./types";
import type { CampaignSnapshot } from "../serialization/types";

export type { SubmitResult } from "./types";

/**
 * The ordered, broadcast surface the {@link SyncCoordinator} submits commands to
 * and reads entries from. The in-process implementation wraps an {@link Authority}
 * directly; the WebSocket implementation forwards to the room server. Only this
 * interface and the coordinator need know the difference.
 */
export interface SyncTransport {
  /** Highest committed seq (0 when empty). */
  head(): number;
  /** Submit a command to the authority; resolves with the committed delta or a denial. */
  submit(command: Command): Promise<SubmitResult>;
  /** Entries with `seq >= fromSeq`, in order. */
  entriesSince(fromSeq: number): LogEntry[];
  /** Replays from `fromSeq`, then streams new entries; returns an unsubscribe thunk. */
  subscribe(fromSeq: number, handler: (entry: LogEntry) => void): () => void;
  /** The latest checkpoint, or null if none is known yet. */
  loadSnapshot(): { seq: number; snapshot: CampaignSnapshot } | null;
}

/** In-process {@link SyncTransport}: wraps an {@link Authority} and fans committed entries out to subscribers. */
export class InProcessTransport implements SyncTransport {
  readonly #authority: Authority;
  #subscribers = new Set<(entry: LogEntry) => void>();

  constructor(authority: Authority) {
    this.#authority = authority;
  }

  head(): number {
    return this.#authority.head();
  }

  submit(command: Command): Promise<SubmitResult> {
    const res = this.#authority.submit(command);
    if (res.ok) {
      const entry: LogEntry = { seq: res.seq, baseSeq: res.seq - 1, command, delta: res.delta };
      for (const handler of this.#subscribers) handler(entry);
    }
    return Promise.resolve(res);
  }

  entriesSince(fromSeq: number): LogEntry[] {
    return this.#authority.entriesSince(fromSeq);
  }

  subscribe(fromSeq: number, handler: (entry: LogEntry) => void): () => void {
    for (const e of this.#authority.entriesSince(fromSeq)) handler(e);
    this.#subscribers.add(handler);
    return () => this.#subscribers.delete(handler);
  }

  loadSnapshot(): { seq: number; snapshot: CampaignSnapshot } {
    return this.#authority.loadSnapshot();
  }
}
