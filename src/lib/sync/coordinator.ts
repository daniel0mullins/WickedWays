import { Campaign } from "../campaign";
import { ProceduralViolation } from "../util";
import { serializeCampaign, serializeCampaignWithIndex } from "../serialization/serializer";
import { deserializeCampaign } from "../serialization/deserializer";
import { EntityIndex } from "./entity-index";
import { Resolver } from "./resolver";
import { DeltaComputer } from "./delta-computer";
import { DeltaApplier } from "./delta-applier";
import type { SyncTransport } from "./transport";
import type { CampaignRegistry } from "../serialization/registry";
import type { CampaignSnapshot } from "../serialization/types";
import type { Command, CommandResult, LogEntry } from "./types";

/**
 * The client-resolves seam: resolves commands locally, appends `{command, delta}`
 * to the shared ordered transport under compare-and-swap, and applies inbound
 * remote deltas to the local replica. The only unit that changes for the future
 * authoritative-server topology.
 *
 * **Swappable campaign reference.** This coordinator OWNS the local campaign and
 * may replace the underlying instance on a rejection or CAS conflict (it rebuilds
 * from the pre-mutation snapshot via {@link deserializeCampaign}). Consumers must
 * always read current state through {@link SyncCoordinator.campaign} and must
 * never cache the reference across a {@link SyncCoordinator.submit} call.
 */
export class SyncCoordinator {
  #local: Campaign;
  readonly #registry: CampaignRegistry;
  readonly #transport: SyncTransport;
  readonly #rng: () => number;
  readonly #snapshotEvery: number;
  readonly #resolver = new Resolver();
  readonly #deltaComputer = new DeltaComputer();
  readonly #applier = new DeltaApplier();
  #lastApplied: number;
  #unsubscribe: (() => void) | null = null;

  constructor(opts: {
    campaign: Campaign;
    registry: CampaignRegistry;
    transport: SyncTransport;
    rng?: () => number;
    snapshotEvery?: number;
  }) {
    this.#local = opts.campaign;
    this.#registry = opts.registry;
    this.#transport = opts.transport;
    this.#rng = opts.rng ?? Math.random;
    this.#snapshotEvery = opts.snapshotEvery ?? 20;
    this.#lastApplied = this.#transport.head();
    if (this.#transport.loadSnapshot() === null) {
      this.#transport.putSnapshot(this.#lastApplied, serializeCampaign(this.#local));
    }
  }

  /** Joins an existing session from the transport's latest snapshot + deltas-since. */
  static join(opts: {
    registry: CampaignRegistry;
    transport: SyncTransport;
    rng?: () => number;
    snapshotEvery?: number;
  }): SyncCoordinator {
    const snap = opts.transport.loadSnapshot();
    if (snap === null) {
      throw new ProceduralViolation("Cannot join: transport has no snapshot to load.");
    }
    const rng = opts.rng ?? Math.random;
    const campaign = deserializeCampaign(snap.snapshot, { registry: opts.registry, rng });
    const coordinator = new SyncCoordinator({ ...opts, campaign });
    coordinator.#lastApplied = snap.seq;
    coordinator.#syncTo(opts.transport.head());
    return coordinator;
  }

  /**
   * The currently-owned local campaign. May be a NEW instance after a rejected or
   * conflicting {@link SyncCoordinator.submit}; never cache it across a submit.
   */
  get campaign(): Campaign {
    return this.#local;
  }

  /** Begins applying inbound remote entries. */
  start(): void {
    this.#unsubscribe = this.#transport.subscribe(this.#lastApplied + 1, (entry) => this.#onRemote(entry));
  }

  /** Stops applying inbound remote entries (inverse of {@link SyncCoordinator.start}). */
  stop(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
  }

  /**
   * Submits a command against the local campaign and, on success, appends it to
   * the transport under compare-and-swap.
   *
   * - `{ ok: true, seq, delta }` — accepted; `delta` reflects all changes.
   * - `{ ok: false, rejected: true, reason }` — illegal command (auth gate or engine
   *   constraint); the local campaign is atomically restored to its pre-call state.
   * - `{ ok: false, conflict: true, reason }` — CAS conflict (stale base); the
   *   campaign is rebuilt from `before` and fast-forwarded to the current head.
   *   The caller should retry.
   *
   * Always read {@link SyncCoordinator.campaign} after a call — a rejection or
   * conflict may have swapped in a new `Campaign` instance.
   */
  async submit(command: Command): Promise<CommandResult> {
    const auth = this.#resolver.authorize(this.#local, command);
    if (!auth.ok) return { ok: false, rejected: true, reason: auth.reason };

    const { snapshot: before, index: rawIndex } = serializeCampaignWithIndex(this.#local);
    try {
      this.#resolver.apply(this.#local, command, new EntityIndex(rawIndex));
    } catch (e) {
      if (e instanceof ProceduralViolation) {
        this.#restore(before);
        return { ok: false, rejected: true, reason: e.message };
      }
      throw e;
    }

    const after = serializeCampaign(this.#local);
    const delta = this.#deltaComputer.diff(before, after);
    const baseSeq = this.#transport.head();
    const seq = baseSeq + 1;
    // Advance #lastApplied BEFORE append so the synchronous self-notification
    // (InProcessTransport.append notifies subscribers inline) sees
    // `entry.seq <= #lastApplied` and genuinely skips our own entry — no reliance
    // on DeltaApplier idempotency. resolver.apply already advanced #local.
    this.#lastApplied = seq;
    const res = await this.#transport.append({ seq, baseSeq, command, delta });
    if (!res.ok) {
      // Roll #lastApplied back to baseSeq so #syncTo replays EVERY missed entry
      // from baseSeq+1..res.head — including the conflicting foreign entry — onto
      // the rebuilt-from-`before` campaign.
      this.#lastApplied = baseSeq;
      this.#restore(before);
      this.#syncTo(res.head);
      return { ok: false, conflict: true, reason: `Stale base ${baseSeq}; head is ${res.head}. Retry.` };
    }
    if (seq % this.#snapshotEvery === 0) {
      this.#transport.putSnapshot(seq, after);
    }
    return { ok: true, seq, delta };
  }

  #onRemote(entry: LogEntry): void {
    if (entry.seq <= this.#lastApplied) return; // already incorporated (incl. our own)
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

  #restore(before: CampaignSnapshot): void {
    this.#local = deserializeCampaign(before, { registry: this.#registry, rng: this.#rng });
  }
}
