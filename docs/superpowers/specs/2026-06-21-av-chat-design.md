# Comms Sub-Spec 3d — A/V Chat (WebRTC) — Design

**Date:** 2026-06-21
**Status:** Approved (pending user review)

## Problem

The comms program decomposed into `3a` (client shell + real-time backend), `3b`
(identity / seat-ownership / presence), `3c` (text chat), and `3d` (A/V via
WebRTC). `3a`, `3b`, and `3c` shipped: a real WebSocket room server authenticates
each connection to an opaque `Identity`, owns per-campaign `Membership` and
presence, runs an `Authority`, persists durably, and now relays player-to-player
text chat with a player roster.

Players can type but not talk. This sub-spec adds **audio/video** — the "virtual
tabletop" voice (and optional video) channel — over the same backend, completing
the comms program. It is the spec the whole program was aimed at: `3a` chose a real
browser client and self-hosted backend precisely so A/V signaling could reuse it.

## Where this sits

Dependency order is `3a → (3b, 3c) → 3d`; all prerequisites are merged. A/V
signaling reuses the `3a` WebSocket backend and the `3b`/`3c` identity + roster +
`displayNameFor` seams. `3d` is the terminal comms sub-spec; the real Play Surface
call UI is a separate track that consumes this protocol.

## Core decisions

Settled during brainstorming:

- **Full-mesh P2P.** Every call participant opens a direct, encrypted
  `RTCPeerConnection` to every other. The server **only relays signaling** (SDP /
  ICE) and tracks call membership — it never sees media. This matches the
  engine's self-hosted, media-agnostic, dumb-relay ethos and needs zero media
  infrastructure. Practical ceiling ~4–6 participants (each peer uploads its
  stream N−1 times), which fits a tabletop party. An SFU was rejected: it would
  require operating a real media server and put media through the backend,
  breaking the architecture.
- **Audio baseline + opt-in video.** Voice is on by default when a participant
  joins the call (mutable); video is opt-in per participant. One mesh carries both
  track kinds. Per-participant **mute** and **camera on/off** controls.
- **One campaign-wide call.** A single A/V "table channel" per campaign — like
  sitting around the same table. Any authenticated connection may join/leave;
  everyone in the call meshes with everyone else. Private breakout calls are out of
  scope.
- **Host-supplied ICE; STUN default, TURN pluggable.** The host supplies the
  `iceServers` list on `ServerOptions` (a new config seam alongside `verifyToken` /
  `genesisFor` / `displayNameFor`), defaulting to a public STUN server. The server
  **delivers it to clients on `callJoined`** so a single host config point drives
  every client's `RTCPeerConnection`. TURN (the relay fallback for the minority
  behind symmetric NAT) is supported via config, but **operating** a TURN server is
  out of scope — the host plugs one in if needed. Honest about the symmetric-NAT
  minority who otherwise fail to connect.
- **Per-connection peer identity.** WebRTC endpoints are per-connection, not
  per-identity: two browser tabs on the same identity are two peers. Signaling is
  therefore addressed by a server-assigned opaque **`peerId`** (one per socket),
  with the call roster mapping `peerId → identity` for display names.
- **Authored `AvPolicy`, server-enforced where observable.** A per-campaign policy
  authored on the template and carried in the snapshot gates A/V; single-player
  ships it off.

## Authored policy — `AvPolicy`

Mirrors `ChatPolicy`. An engine-side **data** type (the engine never acts on it; the
comms server reads it to gate the call, the client reads it to gate UI):

```ts
interface AvPolicy {
  enabled: boolean;        // master; false ⇒ no call subsystem for this campaign
  video: boolean;          // whether cameras are allowed (vs an audio-only table)
  maxParticipants: number; // hard cap on simultaneous call members (protects the mesh)
}
```

- **Authored on the template.** `authoring/description.ts` gains an optional
  `av?: AvPolicy`; the assembler validates it (`maxParticipants >= 1`). Authoring
  default for a multiplayer template: `{ enabled: true, video: true,
  maxParticipants: 6 }`; a single-player template ships `{ enabled: false, … }`.
- **Serialized into the snapshot.** `serialization/types.ts` carries `avPolicy` on
  `CampaignCoreSnapshot`. `SCHEMA_VERSION` bumps **3 → 4**; `migrate()` adds a
  `v3 → v4` step supplying a default `AvPolicy`. (Consistent with the `ChatPolicy`
  v2→v3 precedent; the authoritative server continues to fail closed on a
  schema mismatch for previously-persisted records.)
- **Server enforcement (what is observable):**
  - `enabled` and `maxParticipants` are **hard gates** — the server owns call
    membership, so it denies `callJoin` when A/V is off or the call is full.
  - `video` is **client-enforced and state-validated**: the client will not add a
    video track when `!policy.video`, and the server rejects an `avState` claiming
    `cameraOn` under `!policy.video`. Because media is P2P and opaque to the server,
    it cannot inspect actual tracks — a malicious trusted peer could still send
    video. This is the same trusted-peers boundary as the rest of the stack (the
    authoritative-game-server promotion does not extend to media).
- **Client awareness:** the client hydrates the snapshot and reads `avPolicy` to
  gate the call UI (hide the call panel when disabled, hide the camera button when
  `!video`). The server enforces independently.

## Peer model & call membership (server)

A new per-campaign **`Call`** component in `packages/server`, beside `Table` and the
chat plumbing. It holds:

- the **call-set**: the `peerId`s currently in this campaign's call;
- per-peer state: `{ peerId, identity, muted, cameraOn }`.

On connect, the server assigns each socket an opaque `peerId` (unique per
connection; distinct from `identity`). A **call roster** entry is
`{ peerId, identity, displayName, muted, cameraOn }` — `displayName` via the
existing `displayNameFor(identity)` seam. The server enforces `AvPolicy.enabled`
and `maxParticipants` on `callJoin`, and cleans a peer out of the call-set on
`callLeave` or socket close (broadcasting the updated roster either way).

## Wire protocol (`transport-shared`)

Signaling `data` is **opaque** to the server (relayed verbatim between `peerId`s),
exactly as chat/game payloads are opaque.

```ts
type PeerId = string;
interface CallPeer { peerId: PeerId; identity: Identity; displayName: string; muted: boolean; cameraOn: boolean }

// client → server
| { t: "callJoin";  campaignId: string }
| { t: "callLeave"; campaignId: string }
| { t: "signal";    campaignId: string; to: PeerId; data: unknown }   // SDP offer/answer / ICE candidate
| { t: "avState";   campaignId: string; muted: boolean; cameraOn: boolean }

// server → client
| { t: "callJoined"; campaignId: string; selfPeerId: PeerId; peers: CallPeer[]; iceServers: unknown[] } // ack + who is already in + ICE config
| { t: "callPeers";  campaignId: string; peers: CallPeer[] }                      // membership / state updates
| { t: "signal";     campaignId: string; from: PeerId; data: unknown }           // relayed inbound signaling
| { t: "denied";     reason: string }                                            // A/V disabled, or call full
```

`parseClientMsg` / `parseServerMsg` gain hand-rolled validators for each variant
(the existing chat/presence parsers are the idiom; `data` passes through as
`unknown`).

## Connection & negotiation (client)

A new **`CallClient`** (`packages/client`) wraps the browser WebRTC API behind a
small seam (so it is unit-testable against a mock):

- On `callJoin`, the server returns `callJoined { selfPeerId, peers }`. The
  **newcomer initiates** an offer to each already-present peer; subsequent joiners
  do likewise toward the newcomer via the `callPeers` update.
- **Perfect-negotiation** resolves glare (simultaneous offers): each peer pair
  derives a polite/impolite role from a deterministic `peerId` comparison — the
  standard browser pattern — so an offer collision is handled without deadlock.
- The server relays `offer → answer → ICE` by `peerId` (`signal {to}` →
  `signal {from}`).
- `getUserMedia` acquires the local audio track (and video when the user enables
  the camera and `policy.video`). `CallClient` attaches inbound `MediaStream`s to
  per-peer `<audio>`/`<video>` tiles. Mute / camera toggles flip the local track's
  `enabled` flag and broadcast `avState`; the server fans the new state out via
  `callPeers`.
- **Optional** client-side "who's speaking": an audio-level meter on local/remote
  streams highlights the active speaker. Purely client-side; no server role.

## Minimal dev harness

The existing Vite + vanilla-TS client harness gains a minimal **call panel**, gated
behind `snapshot.campaign.avPolicy.enabled`: a "join/leave call" button, a grid of
per-peer tiles (display name + `<audio>`, plus `<video>` when `policy.video`), and
mute / camera toggles (camera button hidden when `!policy.video`). Harness glue, not
the real Play Surface.

## Error handling

- **A/V disabled / call full** → `denied` with reason; the room never crashes.
- **`avState` with `cameraOn` under `!policy.video`** → rejected (state ignored / `denied`).
- **Signal to an unknown/absent `peerId`** → dropped (the target may have just left);
  never crashes the room.
- **Socket close** → the peer is removed from the call-set and the roster
  re-broadcast, so remaining peers tear down that `RTCPeerConnection`.
- **ICE failure** (e.g. symmetric NAT, no TURN configured) → surfaced in the
  client as a failed peer tile; other peers are unaffected. Documented as the
  known symmetric-NAT limitation.
- **Media permission denied** (`getUserMedia` rejected) → the client stays in the
  call without a local track (listen-only) and surfaces the error.

## Testing

- **Headless signaling-relay tests** (Node, real `ws`): two/three fake peers
  exchanging opaque signaling blobs — `callJoin`/`callLeave` membership, `signal`
  routed **only** to the addressed `peerId` (never broadcast), `maxParticipants`
  cap denial, `enabled`-gate denial, `avState` fan-out and `cameraOn`-under-
  `!video` rejection, roster on join/leave/close. The server needs no browser.
- **`Call` unit tests**: call-set membership, roster construction, policy
  enforcement, peer cleanup on leave/close.
- **`CallClient` unit tests** against a **mocked `RTCPeerConnection`** (injected via
  the seam): offer/answer/ICE flow, polite/impolite role assignment, peer
  add/remove lifecycle, track attach, mute/camera `avState` emission.
- **`AvPolicy` serialization round-trip + migration** (engine), and assembler
  validation tests.
- **Documented manual two-tab browser smoke**: open two client tabs, join the call,
  verify each hears the other, enabling a camera shows video, mute/camera state
  reflects across tiles. Real-media end-to-end is a documented manual smoke (not
  automated), consistent with `3a`.

## Out of scope (later specs / tracks)

- **SFU / server-side mixing or recording**, screen-share, simulcast / bandwidth
  adaptation.
- **Private breakout calls** (a subset of players); only the campaign-wide call
  ships here.
- **Operating a TURN server** — config-pluggable only; the host runs one if needed.
- **Rich "who's speaking"/turn-spotlight beyond optional client audio-levels**, and
  the broader rich-presence spec.
- **The real Play Surface call UI**, mobile, and performance tuning for large
  parties.

## Docs

Per the living-documentation convention, once implemented: the README's multiplayer
section gains an "A/V chat" subsection (mesh topology, `AvPolicy`, ICE config, the
signaling protocol, the symmetric-NAT/TURN caveat, and the manual smoke); the new
public surfaces (`AvPolicy`, the signaling wire protocol, `Call`, `CallClient`, the
`iceServers` host seam) get TSDoc; and the `AvPolicy` authoring field is documented
in the authoring guide.
