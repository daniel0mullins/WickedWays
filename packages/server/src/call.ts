import type { AvPolicy } from "wickedways/lib/av-policy";
import type { CallPeer, PeerId, Identity } from "@wickedways/transport-shared";

/** A refusal from a {@link Call} operation (A/V off, call full, video not allowed). */
export type CallDeny = { ok: false; reason: string };

const denied = (reason: string): CallDeny => ({ ok: false, reason });

interface PeerState { identity: Identity; muted: boolean; cameraOn: boolean }

/**
 * One campaign's A/V call membership — the table channel. Tracks which `peerId`s
 * are in the call and each peer's mute/camera state, enforces {@link AvPolicy}
 * (enabled + maxParticipants are hard gates; video is validated here), and builds
 * the {@link CallPeer} roster. Engine- and socket-agnostic: the server owns signal
 * relay and delivery; `Call` is pure state.
 */
export class Call {
  readonly #policy: AvPolicy;
  readonly #displayName: (id: Identity) => string;
  readonly #peers = new Map<PeerId, PeerState>();

  constructor(policy: AvPolicy, displayName: (id: Identity) => string) {
    this.#policy = policy;
    this.#displayName = displayName;
  }

  get policy(): AvPolicy {
    return this.#policy;
  }

  has(peerId: PeerId): boolean {
    return this.#peers.has(peerId);
  }

  identityOf(peerId: PeerId): Identity | undefined {
    return this.#peers.get(peerId)?.identity;
  }

  roster(): CallPeer[] {
    return [...this.#peers].map(([peerId, s]) => ({
      peerId, identity: s.identity, displayName: this.#displayName(s.identity), muted: s.muted, cameraOn: s.cameraOn,
    }));
  }

  /** Adds `peerId` to the call (audio on, muted off, camera off). Returns the roster, or a denial. */
  join(peerId: PeerId, identity: Identity): CallPeer[] | CallDeny {
    if (!this.#policy.enabled) return denied("A/V is disabled");
    if (this.#peers.has(peerId)) return this.roster(); // idempotent re-join
    if (this.#peers.size >= this.#policy.maxParticipants) return denied("call is full");
    this.#peers.set(peerId, { identity, muted: false, cameraOn: false });
    return this.roster();
  }

  /** Removes `peerId`; returns whether it was a member. */
  leave(peerId: PeerId): boolean {
    return this.#peers.delete(peerId);
  }

  /** Updates a member's mute/camera state. Denies `cameraOn` when video is not allowed. */
  setState(peerId: PeerId, muted: boolean, cameraOn: boolean): CallPeer[] | CallDeny {
    const s = this.#peers.get(peerId);
    if (s === undefined) return denied("not in the call");
    if (cameraOn && !this.#policy.video) return denied("video is disabled");
    s.muted = muted;
    s.cameraOn = cameraOn;
    return this.roster();
  }
}
