// packages/client/src/call.ts
// DOM-free: no RTCPeerConnection / navigator references — those come in only through
// the injected createPeer / getLocalStream seams wired by main.ts.
import type { CallPeer, PeerId } from "@wickedways/transport-shared";

/** The subset of RTCPeerConnection CallClient uses, so tests can inject a mock. */
export interface RtcPeerLike {
  setLocalDescription(desc?: unknown): Promise<void>;
  setRemoteDescription(desc: unknown): Promise<void>;
  addIceCandidate(c: unknown): Promise<void>;
  createOffer(): Promise<unknown>;
  createAnswer(): Promise<unknown>;
  addTrack(track: unknown, stream: unknown): void;
  close(): void;
  localDescription: unknown;
  onicecandidate: ((ev: { candidate: unknown }) => void) | null;
  ontrack: ((ev: { streams: unknown[] }) => void) | null;
}

/** Injected seams for `CallClient` — kept as an interface so tests substitute mocks. */
export interface CallClientOpts {
  campaignId: string;
  /** prod: (cfg) => new RTCPeerConnection({ iceServers: cfg }) */
  createPeer: (iceServers: unknown[]) => RtcPeerLike;
  /** prod: () => navigator.mediaDevices.getUserMedia(...) */
  getLocalStream: () => Promise<{ getTracks(): unknown[] }>;
  /** wired to the socket */
  sendSignal: (to: PeerId, data: unknown) => void;
  /** attach to a <video>/<audio> tile */
  onRemoteStream: (peerId: PeerId, stream: unknown) => void;
  /** re-render roster */
  onPeers: (peers: CallPeer[]) => void;
}

/**
 * Browser-side WebRTC mesh coordinator. Manages one `RTCPeerConnection` per other
 * call participant (full mesh), implements perfect-negotiation (polite/impolite role
 * from lexicographic `peerId` comparison), and drives local media via injected seams
 * so the class is unit-testable without a real browser.
 *
 * Wire up by calling `onCallJoined` when the server sends `callJoined`,
 * `onPeersUpdate` on every `callPeers` update, and `onSignal` on every relayed
 * `signal`. Call `leave` to tear down all connections and stop local tracks.
 */
export class CallClient {
  readonly #opts: CallClientOpts;
  #self: PeerId = "";
  #local: { getTracks(): unknown[] } | null = null;
  #peers = new Map<PeerId, RtcPeerLike>();
  #iceServers: unknown[] = [];

  constructor(opts: CallClientOpts) {
    this.#opts = opts;
  }

  async onCallJoined(selfPeerId: PeerId, peers: CallPeer[], iceServers: unknown[]): Promise<void> {
    this.#self = selfPeerId;
    this.#iceServers = iceServers;
    this.#local = await this.#opts.getLocalStream();
    for (const p of peers) {
      if (p.peerId !== selfPeerId) {
        this.#ensurePeer(p.peerId, iceServers);
      }
    }
  }

  onPeersUpdate(peers: CallPeer[]): void {
    this.#opts.onPeers(peers);

    const incoming = new Set(peers.map((p) => p.peerId));

    // Create PCs for newly-appeared non-self peers
    for (const p of peers) {
      if (p.peerId === this.#self) continue;
      const isNew = !this.#peers.has(p.peerId);
      this.#ensurePeer(p.peerId, this.#iceServers);
      if (isNew && this.#impoliteTo(p.peerId)) {
        // Kick off offer asynchronously (impolite = lesser id = offerer)
        void this.#sendOffer(p.peerId);
      }
    }

    // Close PCs for departed peers
    for (const [id, pc] of this.#peers) {
      if (!incoming.has(id)) {
        pc.close();
        this.#peers.delete(id);
      }
    }
  }

  async onSignal(from: PeerId, data: unknown): Promise<void> {
    // NOTE: makingOffer/ignoreOffer collision-rollback (perfect-negotiation glare handling) is
    // intentionally omitted. The deterministic single-offerer role (impolite = lesser peerId)
    // avoids glare for the initial offer exchange. Mid-call renegotiation — e.g. adding a video
    // track when the user toggles the camera on — can still glare and is out of scope for the
    // audio-baseline. A future video-upgrade path should add proper glare handling here.
    const pc = this.#ensurePeer(from, this.#iceServers);
    const d = data as { sdp?: unknown; candidate?: unknown };

    if (d.sdp !== undefined) {
      await pc.setRemoteDescription(d.sdp);
      // If the remote sent an offer, we answer
      const sdpObj = d.sdp as { type?: string };
      if (sdpObj.type === "offer") {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.#opts.sendSignal(from, { sdp: answer });
      }
    }

    if (d.candidate !== undefined) {
      await pc.addIceCandidate(d.candidate);
    }
  }

  leave(): void {
    for (const pc of this.#peers.values()) {
      pc.close();
    }
    this.#peers.clear();
    if (this.#local) {
      for (const track of this.#local.getTracks()) {
        const t = track as { stop?: () => void };
        t.stop?.();
      }
      this.#local = null;
    }
  }

  peerIds(): PeerId[] {
    return [...this.#peers.keys()];
  }

  // ── private ──────────────────────────────────────────────────────────────

  #ensurePeer(other: PeerId, iceServers: unknown[]): RtcPeerLike {
    const existing = this.#peers.get(other);
    if (existing !== undefined) return existing;

    const pc = this.#opts.createPeer(iceServers);

    // Add local tracks
    if (this.#local) {
      for (const track of this.#local.getTracks()) {
        pc.addTrack(track, this.#local);
      }
    }

    // Wire ICE candidate forwarding
    pc.onicecandidate = (ev) => {
      if (ev.candidate !== null && ev.candidate !== undefined) {
        this.#opts.sendSignal(other, { candidate: ev.candidate });
      }
    };

    // Wire remote track handler
    pc.ontrack = (ev) => {
      this.#opts.onRemoteStream(other, ev.streams[0] ?? null);
    };

    this.#peers.set(other, pc);
    return pc;
  }

  /** The impolite peer is the one with the lexicographically-lesser id; it is the offerer. */
  #impoliteTo(other: PeerId): boolean {
    return this.#self < other;
  }

  async #sendOffer(other: PeerId): Promise<void> {
    const pc = this.#peers.get(other);
    if (!pc) return;
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.#opts.sendSignal(other, { sdp: offer });
  }
}
