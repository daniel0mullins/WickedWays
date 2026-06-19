# Comms Sub-Spec 3a — Client Shell + Real-Time Backend — Design

**Date:** 2026-06-18
**Status:** Approved

## Problem

The engine is meant to be played asynchronously across multiple browser clients.
Spec 1 gave full-campaign serialization; Spec 2 gave the transport-agnostic
synchronization core (`Command`, `Resolver`, `DeltaComputer`/`DeltaApplier`,
`SyncCoordinator`) plus a `SyncTransport` **interface** with only an in-process
implementation. Nothing yet runs in a browser, and there is no real backend over
which two clients converge.

This sub-spec builds the **foundation** that everything else in the comms program
sits on: a real browser client, a concrete `SyncTransport` over a self-hosted
WebSocket server, and a demonstration that two browser tabs converge on identical
game state over the wire.

## Where this sits

The original "serialization → sync → comms" decomposition made comms **Spec 3**.
Once we chose a real browser client with full WebRTC A/V, Spec 3 turned out to be
a multi-spec program of its own. The agreed decomposition:

- **3a (this spec)** — client shell + concrete real-time backend.
- **3b** — identity / seat-ownership / presence (closes the network-auth boundary
  Spec 2 deferred).
- **3c** — text chat over the 3a backend.
- **3d** — A/V via WebRTC: signaling over the 3a backend, peer connections, media.
- *(Parallel track)* — the real game UI / "Play Surface".

Dependency order is **3a → (3b, 3c) → 3d**. Nothing else can be built or tested
until 3a exists, because A/V signaling reuses the very backend 3a introduces.

## Goal

A runnable multiplayer client: a browser dev harness driving the real engine +
Spec 2 `SyncCoordinator` over a concrete `WebSocketTransport`, backed by a
self-hosted WS **room server** that enforces total ordering and compare-and-swap
and broadcasts to subscribers. The headline deliverable is **"open two tabs, act
in one, both reflect identical state."**

## Decisions

Settled during brainstorming:

- **Full A/V incl. WebRTC is the end goal**, which means a real browser client and
  a real backend — a deliberate departure from the engine's pure/transport-agnostic
  purity. The purity is preserved by keeping it behind a package boundary: the
  engine package never gains browser/server dependencies.
- **Self-hosted WS room server**, not a managed store or a Durable-Object platform.
  Portable, fully testable headless in CI (Node client ↔ Node server), the exact
  shape of `SyncTransport`, and the natural future home for both the authoritative
  resolver (Spec 2's promotion seam) and the WebRTC signaling relay (3d).
- **The 3a server is a dumb ordered-log relay, not a game server.** The client
  still resolves locally via Spec 2's `SyncCoordinator` (client-resolves topology);
  the server enforces only CAS on `seq`, stores the log + snapshots per room in
  memory, and broadcasts. It **does not depend on the engine** — it handles opaque
  blobs keyed by `campaignId`. The authoritative-server promotion (resolver moves
  server-side) is a later spec; this preserves that seam exactly.
- **Minimal dev harness, no UI framework.** Vanilla TS, just enough to prove
  convergence. The UI-framework choice belongs to the parallel Play Surface track,
  not the sync foundation.
- **pnpm workspaces monorepo.** Better fit than npm for a library + apps: shared
  store, strict resolution (enforces the engine never pulls in `ws`/DOM deps),
  first-class workspaces. A one-time npm → pnpm migration is part of this spec.
- **Trusted-peers identity carries over from Spec 2.** The network layer does no
  seat validation in 3a; a client declares an opaque `clientId` on join and the
  server relays. Proving a connection may act for a seat is **3b**.
- **One small Spec-2 change: the append/submit seam goes async.** Spec 2's
  `SyncTransport.append` and `SyncCoordinator.submit` are synchronous, which only
  works for an in-memory transport — a real WebSocket CAS verdict (`appendOk` vs
  `appendConflict`) arrives over the network asynchronously. So
  `SyncTransport.append` becomes `Promise<AppendResult>` and
  `SyncCoordinator.submit` becomes `Promise<CommandResult>`. `InProcessTransport`
  and the existing Spec-2 tests take trivial `await`s; the mirror-served sync reads
  (`head`, `entriesSince`, `loadSnapshot`, `subscribe`, `putSnapshot`) stay
  synchronous. The optimistic-local-CAS alternative was rejected: it needs a new
  coordinator rollback API anyway and opens a silent-divergence window in the
  foundation layer.

## Architecture — workspace layout

```
wickedways/                 # pnpm workspaces root (engine stays here)
  src/lib/…                 # the pure engine — UNCHANGED, still the root package
  src/lib/sync/…            # Spec 2 — the SyncTransport interface lives here
  packages/
    transport-shared/       # tiny pkg: the WS wire-message types shared by client+server
    server/                 # Node + ws: in-memory rooms, CAS log, snapshot store, broadcast
    client/                 # Vite + vanilla TS: WebSocketTransport + minimal dev harness
  pnpm-workspace.yaml
```

- `transport-shared` depends on nothing (re-exports `LogEntry`/`CampaignSnapshot`
  types from the engine purely as types, or redeclares the minimal wire shapes).
- `server/` depends only on `transport-shared` — engine-agnostic.
- `client/` depends on the engine (`SyncCoordinator`, `Command`, `SyncTransport`,
  serialization) **and** `transport-shared`.

pnpm's strictness is the guard that the engine package never accidentally imports
browser or server dependencies.

## The room server

One process hosts many **rooms** keyed by `campaignId`. Each room holds, in
memory:

- `log: LogEntry[]` — ordered, append-only (`LogEntry` = Spec 2's
  `{ seq, baseSeq, command, delta }`, opaque to the server).
- `head: number` — highest committed `seq`.
- `snapshots: Map<number, CampaignSnapshot>` — checkpoints clients `putSnapshot`
  (opaque JSON to the server).
- `subscribers: Set<WebSocket>` — connected clients.

**CAS rule (the one invariant the server enforces):** an append carrying
`baseSeq` commits as `seq = head + 1` **iff** `baseSeq === head`; otherwise it is
rejected as a conflict and the client is told the current `head` so it can
re-sync. This is the server-side half of Spec 2's compare-and-swap — identical
semantics to `InProcessTransport`, now over the wire. Ordering needs no locking:
a single Node event loop serializes appends per room.

A **storage-interface seam** abstracts the per-room log/snapshot store (in-memory
implementation in 3a) so a later spec can back it with a DB without touching the
protocol. Durable cross-restart persistence is out of scope here.

## Wire protocol (`transport-shared`)

A JSON discriminated union in each direction:

```ts
// client → server
type ClientMsg =
  | { t: "join";        campaignId: string; clientId: string; fromSeq: number }
  | { t: "append";      campaignId: string; entry: LogEntry }   // entry.baseSeq drives CAS
  | { t: "getSnapshot"; campaignId: string }                    // latest checkpoint for late-join
  | { t: "putSnapshot"; campaignId: string; seq: number; snapshot: CampaignSnapshot };

// server → client
type ServerMsg =
  | { t: "joined";         head: number }                       // ack; backfill follows
  | { t: "entry";          entry: LogEntry }                    // ordered delivery (backfill + live)
  | { t: "appendOk";       seq: number }                        // your append committed at seq
  | { t: "appendConflict"; head: number }                       // CAS failed; current head
  | { t: "snapshot";       seq: number; snapshot: CampaignSnapshot | null }
  | { t: "error";          message: string };
```

On `join`, the server replays `log[fromSeq+1 …]` as ordered `entry` messages
(backfill), then live-broadcasts every newly committed `entry` to all room
subscribers.

## The concrete `WebSocketTransport` (client)

A class in `client/` implementing Spec 2's `SyncTransport` interface, which keeps
a **warm local mirror** of the log/head/snapshot (fed by the WS subscription) so
every synchronous read is served locally. The one engine change is the async
`append`/`submit` seam (above):

- `append(entry): Promise<AppendResult>` → send `{t:"append"}`, await
  `appendOk`/`appendConflict`. A conflict surfaces to the coordinator exactly as
  the in-process transport does today (the coordinator already rolls back to
  `before`, re-syncs, and lets the caller retry — Spec 2 behavior, now awaited).
- `subscribe(fromSeq, handler)` → send `{t:"join", fromSeq}`; route every inbound
  `entry` to `handler` in `seq` order, with a buffer-and-order guard that drops
  duplicates and holds gaps.
- `loadSnapshot()` → `{t:"getSnapshot"}` → resolve the returned snapshot (or
  `null`).
- `putSnapshot(seq, snapshot)` → fire `{t:"putSnapshot"}`.
- **Reconnect/heal:** on socket drop, reconnect and re-`join` from
  `lastAppliedSeq`; the server backfills the gap. If the gap predates the earliest
  retained entry, fall back to `getSnapshot` + resubscribe (Spec 2's gap-heal
  path).

The crucial property: **the `SyncTransport` interface is the seam.** Spec 2's
`InProcessTransport` and this `WebSocketTransport` are interchangeable — which is
what makes the shared contract suite below possible.

## Identity & room-join (trust-based)

3a keeps Spec 2's trusted-peers model. Game authorization (turn/GM gate) already
lives in the resolver and runs client-side at resolve time. The network layer adds
only the minimum:

- On `join`, a client declares an opaque `clientId` and the `campaignId`. The
  server does **no** validation that this client may act for any seat — it relays.
  A malicious client could forge an append; that is acceptable under trusted-peers
  and is exactly the boundary **3b** closes.
- `clientId` is plumbing for later presence (3b) and harness tab labels. It is
  **not** the in-game `actorId` (one client may control several characters / the
  GM seat).

## Minimal dev harness (`client/`)

Vite + vanilla TS, no UI framework. One HTML page that:

- Connects a `WebSocketTransport` to the room server and drives a real engine
  `Campaign` + `SyncCoordinator`.
- Provides buttons for a representative command mix (e.g. `move`, `attack`,
  `nextPlayer`, `pickUp`) so two tabs can act on each other.
- Renders synced state as **text** — active character, round, a log of applied
  `seq`s, and the `serializeCampaign(local)` JSON/hash — enough to *see*
  convergence, not to play prettily. The real Play Surface is the parallel track.
- Ships with a tiny hardcoded starting campaign (reuse the engine's existing
  test-campaign builders / a small seed) so there is something to act on.

## Testing

- **Shared `SyncTransport` contract suite.** A parametrized vitest suite asserting
  the transport contract — ordered delivery, CAS conflict on stale `baseSeq`,
  backfill-from-seq, snapshot round-trip — run against **both**
  `InProcessTransport` (Spec 2) and the new `WebSocketTransport` + server. This is
  the headline safety net: it proves the real backend is behaviorally identical to
  the in-process transport Spec 2 already trusts.
- **Node integration tests.** Boot the real `ws` server on an ephemeral port;
  connect two Node `WebSocketTransport` clients; drive Spec 2's two-client
  convergence scenario (move / attack / craft / Confused fizzle / spawn) and assert
  `serializeCampaign(A) === serializeCampaign(B)` after each command — now over a
  real socket.
- **Reconnect/backfill test.** Drop client B's socket mid-session, commit entries
  on A, reconnect B, assert it backfills and converges. Plus a snapshot-fallback
  variant: the gap predates the retained log → `getSnapshot` heals.
- **CI.** Update `checks.yml` (and `docs.yml` as needed) to pnpm and run every
  workspace's tests. Browser two-tab convergence is a **documented manual smoke**,
  not automated; Playwright e2e is out of scope for 3a.

## Error handling

- **CAS conflict:** server `appendConflict{head}` → transport surfaces it → Spec 2
  coordinator rolls back to `before`, re-syncs, caller may retry. Unchanged engine
  behavior.
- **Disconnect/gap:** reconnect + re-`join` from `lastAppliedSeq`; backfill, or
  snapshot-fallback if the gap predates the retained log.
- **Malformed message / unknown room:** server replies `{t:"error"}` and ignores;
  it never crashes the room.
- **Restart:** in-memory rooms are lost on server restart (durable persistence out
  of scope). The storage-interface seam leaves room to back it with a DB later
  without protocol changes.

## Out of scope (later sub-specs / tracks)

- **Seat-ownership / network auth & presence** — 3b.
- **Text chat** — 3c.
- **A/V / WebRTC signaling & media** — 3d (reuses this backend).
- **Authoritative-server promotion** (resolver moves server-side) — later spec; the
  seam is built for it here.
- **Durable cross-restart persistence**, the real game UI / Play Surface,
  TURN/STUN, horizontal scaling / multi-node fan-out.

## Docs

Per the living-documentation convention, the README gains a "Running the
multiplayer client" / monorepo section, and the new public surfaces
(`WebSocketTransport`, the wire protocol, the room server) get TSDoc once
implemented. The npm → pnpm command changes are reflected in `CLAUDE.md` and the
docs.
