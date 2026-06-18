import type { LogEntry } from "./types";
import type { CampaignSnapshot } from "../serialization/types";

export type AppendResult = { ok: true } | { ok: false; conflict: true; head: number };

/**
 * The ordered, broadcast store the sync core appends to and reads from. The
 * in-process implementation drives tests; a real backend (Firestore/WebSocket)
 * is a thin adapter wired up later — only this interface and the
 * {@link SyncCoordinator} need know the difference.
 */
export interface SyncTransport {
  /** Highest accepted seq (0 when empty). */
  head(): number;
  /** Compare-and-swap append: succeeds iff `entry.baseSeq === head()`. */
  append(entry: LogEntry): AppendResult;
  /** Entries with `seq >= fromSeq`, in order. */
  entriesSince(fromSeq: number): LogEntry[];
  /** Replays from `fromSeq`, then streams new entries; returns an unsubscribe thunk. */
  subscribe(fromSeq: number, handler: (entry: LogEntry) => void): () => void;
  /** The latest checkpoint, or null if none. */
  loadSnapshot(): { seq: number; snapshot: CampaignSnapshot } | null;
  /** Stores a checkpoint at `seq`. */
  putSnapshot(seq: number, snapshot: CampaignSnapshot): void;
}

/** In-memory {@link SyncTransport}: an ordered log + a single latest snapshot. */
export class InProcessTransport implements SyncTransport {
  private log: LogEntry[] = [];
  private subscribers = new Set<(entry: LogEntry) => void>();
  private snapshot: { seq: number; snapshot: CampaignSnapshot } | null = null;

  head(): number {
    return this.log.length === 0 ? 0 : this.log[this.log.length - 1]!.seq;
  }

  append(entry: LogEntry): AppendResult {
    const head = this.head();
    if (entry.baseSeq !== head) {
      return { ok: false, conflict: true, head };
    }
    this.log.push(entry);
    for (const handler of this.subscribers) handler(entry);
    return { ok: true };
  }

  entriesSince(fromSeq: number): LogEntry[] {
    return this.log.filter((e) => e.seq >= fromSeq);
  }

  subscribe(fromSeq: number, handler: (entry: LogEntry) => void): () => void {
    for (const e of this.entriesSince(fromSeq)) handler(e);
    this.subscribers.add(handler);
    return () => this.subscribers.delete(handler);
  }

  loadSnapshot(): { seq: number; snapshot: CampaignSnapshot } | null {
    return this.snapshot;
  }

  putSnapshot(seq: number, snapshot: CampaignSnapshot): void {
    if (this.snapshot === null || seq >= this.snapshot.seq) {
      this.snapshot = { seq, snapshot };
    }
  }
}
