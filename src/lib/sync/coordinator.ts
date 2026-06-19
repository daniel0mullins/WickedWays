import { Campaign } from "../campaign";
import { ProceduralViolation } from "../util";
import { deserializeCampaign } from "../serialization/deserializer";
import { DeltaApplier } from "./delta-applier";
import type { SyncTransport } from "./transport";
import type { CampaignRegistry } from "../serialization/registry";
import type { Command, CommandResult, LogEntry } from "./types";

/**
 * A replica of a campaign synchronized against an authoritative transport. Submits
 * commands to the authority (in-process or the room server) and applies the
 * authoritative deltas it broadcasts back. The coordinator never resolves commands
 * itself and never optimistically mutates — state changes only when an authoritative
 * delta arrives, so there is no rollback and no CAS conflict.
 *
 * **Swappable campaign reference.** The coordinator owns the local replica; read
 * current state through {@link SyncCoordinator.campaign} and never cache the
 * reference across a {@link SyncCoordinator.submit} call.
 */
export class SyncCoordinator {
  #local: Campaign;
  readonly #registry: CampaignRegistry;
  readonly #transport: SyncTransport;
  readonly #rng: () => number;
  readonly #applier = new DeltaApplier();
  #lastApplied: number;
  #unsubscribe: (() => void) | null = null;

  private constructor(opts: {
    campaign: Campaign;
    registry: CampaignRegistry;
    transport: SyncTransport;
    rng: () => number;
    lastApplied: number;
  }) {
    this.#local = opts.campaign;
    this.#registry = opts.registry;
    this.#transport = opts.transport;
    this.#rng = opts.rng;
    this.#lastApplied = opts.lastApplied;
  }

  /** Builds a replica from the transport's latest snapshot + deltas-since. */
  static join(opts: {
    registry: CampaignRegistry;
    transport: SyncTransport;
    rng?: () => number;
  }): SyncCoordinator {
    const snap = opts.transport.loadSnapshot();
    if (snap === null) {
      throw new ProceduralViolation("Cannot join: transport has no snapshot to load.");
    }
    const rng = opts.rng ?? Math.random;
    const campaign = deserializeCampaign(snap.snapshot, { registry: opts.registry, rng });
    const coordinator = new SyncCoordinator({
      campaign,
      registry: opts.registry,
      transport: opts.transport,
      rng,
      lastApplied: snap.seq,
    });
    coordinator.#syncTo(opts.transport.head());
    return coordinator;
  }

  /** The currently-owned local replica. Never cache it across a {@link SyncCoordinator.submit}. */
  get campaign(): Campaign {
    return this.#local;
  }

  /** Begins applying inbound authoritative entries. */
  start(): void {
    this.#unsubscribe = this.#transport.subscribe(this.#lastApplied + 1, (entry) => this.#onRemote(entry));
  }

  /** Stops applying inbound entries (inverse of {@link SyncCoordinator.start}). */
  stop(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
  }

  /**
   * Submits a command to the authority. On success the authoritative delta has
   * already been applied to the local replica (via the subscription) by the time
   * this resolves.
   *
   * - `{ ok: true, seq, delta }` — committed.
   * - `{ ok: false, rejected: true, reason }` — the authority denied the command
   *   (auth gate, engine constraint, or a lost connection); the local replica is
   *   untouched and reconverges from the authority's broadcast.
   */
  async submit(command: Command): Promise<CommandResult> {
    const res = await this.#transport.submit(command);
    if (!res.ok) return { ok: false, rejected: true, reason: res.reason };
    if (this.#lastApplied < res.seq) {
      // Defensive: if the subscription has not yet delivered our entry (e.g. the
      // coordinator was never started), fast-forward now so callers see the commit.
      this.#syncTo(this.#transport.head());
    }
    return { ok: true, seq: res.seq, delta: res.delta };
  }

  #onRemote(entry: LogEntry): void {
    if (entry.seq <= this.#lastApplied) return; // already incorporated
    if (entry.seq !== this.#lastApplied + 1) {
      this.#syncTo(this.#transport.head()); // heal a gap
      return;
    }
    this.#applier.apply(this.#local, entry.delta, { registry: this.#registry, rng: this.#rng });
    this.#lastApplied = entry.seq;
  }

  #syncTo(targetHead: number): void {
    for (const entry of this.#transport.entriesSince(this.#lastApplied + 1)) {
      if (entry.seq > targetHead) break;
      if (entry.seq !== this.#lastApplied + 1) continue;
      this.#applier.apply(this.#local, entry.delta, { registry: this.#registry, rng: this.#rng });
      this.#lastApplied = entry.seq;
    }
  }
}
