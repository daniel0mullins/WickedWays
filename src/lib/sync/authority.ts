import { Campaign } from "../campaign";
import { ProceduralViolation } from "../util";
import { serializeCampaign, serializeCampaignWithIndex } from "../serialization/serializer";
import { deserializeCampaign } from "../serialization/deserializer";
import { EntityIndex } from "./entity-index";
import { Resolver } from "./resolver";
import { DeltaComputer } from "./delta-computer";
import type { CampaignRegistry } from "../serialization/registry";
import type { CampaignSnapshot } from "../serialization/types";
import type { Command, LogEntry, SubmitResult } from "./types";

/**
 * The single authority over a campaign's state. Holds the live {@link Campaign},
 * the committed ordered log, and the latest checkpoint. {@link Authority.submit}
 * authorizes, applies, diffs, and commits a command — re-deriving the delta from
 * the command itself, so callers never supply a delta. Used both in-process
 * (single-player, behind {@link InProcessTransport}) and on the room server
 * (multiplayer): the same authority, two host sites.
 */
export class Authority {
  #campaign: Campaign;
  #log: LogEntry[] = [];
  #snapshot: { seq: number; snapshot: CampaignSnapshot };
  readonly #registry: CampaignRegistry;
  readonly #rng: () => number;
  readonly #snapshotEvery: number;
  readonly #startSeq: number;
  readonly #resolver = new Resolver();
  readonly #deltaComputer = new DeltaComputer();

  constructor(
    genesis: CampaignSnapshot,
    opts: { registry: CampaignRegistry; rng?: () => number; snapshotEvery?: number; startSeq?: number },
  ) {
    this.#registry = opts.registry;
    this.#rng = opts.rng ?? Math.random;
    this.#snapshotEvery = opts.snapshotEvery ?? 20;
    this.#startSeq = opts.startSeq ?? 0;
    this.#campaign = deserializeCampaign(genesis, { registry: this.#registry, rng: this.#rng });
    this.#snapshot = { seq: this.#startSeq, snapshot: genesis };
  }

  /** Highest committed seq (0 when empty). */
  head(): number {
    const last = this.#log[this.#log.length - 1];
    return last === undefined ? this.#startSeq : last.seq;
  }

  /** The latest checkpoint (the genesis snapshot until the first `snapshotEvery` commit). */
  loadSnapshot(): { seq: number; snapshot: CampaignSnapshot } {
    return this.#snapshot;
  }

  /** Committed entries with `seq >= fromSeq`, in order. */
  entriesSince(fromSeq: number): LogEntry[] {
    return this.#log.filter((e) => e.seq >= fromSeq);
  }

  /**
   * Authorize → apply (restoring from the pre-call snapshot on a
   * {@link ProceduralViolation}) → diff → commit. Returns the committed
   * `{ seq, delta }` or a terminal denial; the authoritative state is never left
   * half-mutated.
   */
  submit(command: Command): SubmitResult {
    const auth = this.#resolver.authorize(this.#campaign, command);
    if (!auth.ok) return { ok: false, denied: true, reason: auth.reason };

    const { snapshot: before, index: rawIndex } = serializeCampaignWithIndex(this.#campaign);
    try {
      this.#resolver.apply(this.#campaign, command, new EntityIndex(rawIndex));
    } catch (e) {
      if (e instanceof ProceduralViolation) {
        this.#campaign = deserializeCampaign(before, { registry: this.#registry, rng: this.#rng });
        return { ok: false, denied: true, reason: e.message };
      }
      throw e;
    }

    const after = serializeCampaign(this.#campaign);
    const delta = this.#deltaComputer.diff(before, after);
    const seq = this.head() + 1;
    this.#log.push({ seq, baseSeq: seq - 1, command, delta });
    if (seq % this.#snapshotEvery === 0) this.#snapshot = { seq, snapshot: after };
    return { ok: true, seq, delta };
  }
}
