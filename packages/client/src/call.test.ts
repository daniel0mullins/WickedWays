// packages/client/src/call.test.ts
import { describe, it, expect, vi } from "vitest";
import { CallClient } from "./call.js";
import type { CallPeer } from "@wickedways/transport-shared";

function mockPeer() {
  return {
    setLocalDescription: vi.fn(() => Promise.resolve()),
    setRemoteDescription: vi.fn(() => Promise.resolve()),
    addIceCandidate: vi.fn(() => Promise.resolve()),
    createOffer: vi.fn(() => Promise.resolve({ type: "offer" })),
    createAnswer: vi.fn(() => Promise.resolve({ type: "answer" })),
    addTrack: vi.fn(),
    close: vi.fn(),
    localDescription: { type: "offer" },
    onicecandidate: null as ((ev: { candidate: unknown }) => void) | null,
    ontrack: null as ((ev: { streams: unknown[] }) => void) | null,
  };
}

const peer = (peerId: string, identity = peerId): CallPeer =>
  ({ peerId, identity, displayName: identity, muted: false, cameraOn: false });

function makeClient() {
  const created: ReturnType<typeof mockPeer>[] = [];
  const sent: { to: string; data: unknown }[] = [];
  const client = new CallClient({
    campaignId: "c",
    createPeer: () => { const p = mockPeer(); created.push(p); return p; },
    getLocalStream: () => Promise.resolve({ getTracks: () => [{ kind: "audio" }] }),
    sendSignal: (to, data) => sent.push({ to, data }),
    onRemoteStream: () => {},
    onPeers: () => {},
  });
  return { client, created, sent };
}

describe("CallClient", () => {
  it("creates a peer connection for each existing member on join", async () => {
    const { client, created } = makeClient();
    // self is p2 (impolite vs p1 since "p2" > "p1" => p2 is polite; p1 impolite). self=p2 here.
    await client.onCallJoined("p2", [peer("p1"), peer("p2")], []);
    expect(created.length).toBe(1);          // one PC, to the other member p1
    expect(client.peerIds()).toEqual(["p1"]);
  });

  it("the impolite peer (lesser id) sends an offer to a newly-appeared peer", async () => {
    const { client, sent } = makeClient();
    await client.onCallJoined("p1", [peer("p1")], []); // self p1, alone
    client.onPeersUpdate([peer("p1"), peer("p2")]);     // p2 appears; p1 < p2 => p1 impolite => p1 offers
    // allow the async negotiation microtask to flush
    await Promise.resolve();
    expect(sent.some((s) => s.to === "p2")).toBe(true);
  });

  it("routes an inbound signal to the matching peer connection", async () => {
    const { client, created } = makeClient();
    await client.onCallJoined("p2", [peer("p1"), peer("p2")], []);
    await client.onSignal("p1", { sdp: { type: "offer" } });
    expect(created[0]!.setRemoteDescription).toHaveBeenCalled();
  });

  it("leave() closes all peer connections", async () => {
    const { client, created } = makeClient();
    await client.onCallJoined("p2", [peer("p1"), peer("p2")], []);
    client.leave();
    expect(created[0]!.close).toHaveBeenCalled();
    expect(client.peerIds()).toEqual([]);
  });
});
