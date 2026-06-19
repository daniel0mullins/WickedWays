# Comms Sub-Spec 3b — Seat Ownership / Auth / Presence — Design

**Date:** 2026-06-19
**Status:** Approved

## Problem

The engine is played asynchronously across multiple authenticated clients. Spec 2
gave the command/sync core and explicitly deferred "network authentication / seat
ownership (which connection controls which character)." Spec 3a built the real
WebSocket room server + `Table` coordinator + `WebSocketTransport` under a
**trusted-peers** model: a `join` carries an opaque, self-asserted `clientId` the
server ignores, and an `append` carries the command (with its `actorId`) as an
**opaque** payload the server never inspects — so **any connection can submit a
command as any actor**. The client-side resolver enforces game rules, but nothing
ties a *connection* to a *seat*, and the server does no re-validation.

3b closes that gap: authenticated identity, server-enforced seat ownership, and
presence.

## Where this sits

3b is the second sub-spec of the comms program (after 3a). It builds directly on
3a's server/`Table`/`WebSocketTransport` and replaces the trusted-peers model with
real seat ownership. Later: text chat (3c) and A/V over WebRTC (3d) reuse this
authenticated-identity + presence layer.

## Goal

Authenticated connections, a server-held membership model binding identities to
seats, server-side enforcement that a connection may only submit appends whose
**declared (envelope) actor** it owns, and a presence broadcast — all keeping the
engine pure and the server engine-agnostic (it reads only `actorId`/`gm` metadata +
membership, never command semantics). Because the server does not parse the opaque
command/delta, this stops impersonation by *label* but not a hostile seat-holder
forging a delta as another seat — see **The security boundary** and **Known
limitations**; full impersonation-resistance is the deferred authoritative server.

## Decisions

Settled during brainstorming:

- **Server-enforced ownership** (not identity-only, not full game authority). The
  server authenticates each connection and **rejects any append whose actor/seat
  the connection does not own**. To stay engine-agnostic, the append declares its
  actor at the **envelope** level; the server checks ownership without parsing the
  command.
- **Abstract injected verifier.** The server is constructed with a host-provided
  `verifyToken(token) → identity | null`. The engine defines the protocol (a token
  on `join`; the server calls the verifier) but **not** the token format or crypto.
  No crypto is baked into the pure-TS engine; tests use a fake verifier.
- **Server-held membership; self-service join + GM override.** The server owns a
  per-campaign `Membership` (`characterId → identity` seat owners + a `gmIdentity`)
  as first-class **protocol state**, separate from the opaque campaign payload, so it
  can enforce directly. The engine's `joinCampaign` is **self-service** (the joining
  player supplies their own new character snapshot — there is no `addPlayer`
  command), so seats are **self-claimed at join**: a `join`-actor append binds the
  new `characterId` to the connection's identity (only if that `characterId` is not
  already owned — preventing seat hijack). The GM-only control messages
  (`assignSeat`/`unassignSeat`/`transferGM`) are **admin override** — reassign a
  dropped player's seat, kick, hand off GM — not the primary path. Membership changes
  broadcast as presence.
- **Actor declared at the envelope.** The command's `actorId` is lifted to the
  append envelope (identity *metadata*, an id string — not game semantics), so the
  server has a server-visible actor to enforce against membership. The **honest**
  client's transport derives this envelope from the command, so the two agree. The
  server does **not** bind the envelope to the opaque `command`/`delta`, so a
  **hostile** client can desync them — see the boundary below.

## The security boundary 3b draws (and does not) — read this carefully

3b is **authentication + envelope-ownership**, not impersonation-proofing. An
adversarial review (2026-06-19) confirmed the precise boundary:

- **Enforced:** every connection authenticates (`verifyToken`), and every `append`
  must carry an **envelope `actor` naming a seat the connection owns** (or `gm`, or
  an unowned `join` id). An append whose envelope names an unowned seat — or from an
  unauthenticated connection — is `denied` before it can commit or broadcast.
- **NOT enforced — cross-seat impersonation by a seat-holder.** The server treats
  `command`/`delta` as opaque and replicas apply the **delta** verbatim. A hostile
  client that owns *any* one seat (or is GM) can send a truthful-looking envelope
  (its owned seat) wrapping a command/delta that mutates a *different* seat/entity
  (including `leaveCampaign`/GM-character actions). The server cannot detect this
  without parsing command semantics, which 3b refuses to do. So **"a connection
  cannot act as a seat it does not own" does NOT hold against a hostile client** —
  only against an honest one. Likewise the `join` bind trusts the envelope
  `characterId`, which a hostile client can decouple from the created character
  (seat-squat / membership-vs-state desync).
- **NOT enforced — game legality** (turn order, affliction blocks…) — stays in the
  client-side resolver.

**Truly closing cross-seat impersonation requires the deferred
full-authoritative-server** (the server re-derives the delta from the command,
checking `commandActorId == envelope == owned seat`). Checking only
`command.actorId` is insufficient because the delta itself is forgeable. The server
reads only id metadata + the membership map, preserving the engine-agnostic property
and that promotion seam.

See **Known limitations** for the full deferred list.

## Architecture — components

The server gains an auth/membership layer alongside its 3a `Table` registry:

1. **`verifyToken` (injected)** — `(token: string) => Identity | null`, host-supplied
   at `createServer`. The only authentication primitive the engine knows; format and
   crypto are the host's. A throwing verifier is treated as a denial.
2. **`Membership`** — per campaign: `Map<CharacterId, Identity>` (seat owners) +
   `gmIdentity`. Created from a host-supplied seed at room creation; mutated only by
   GM control messages. Server-side protocol state, not in the campaign snapshot.
   Exposes ownership queries: `owns(identity, actor)`.
3. **Connection identity** — on `join`, the server runs `verifyToken`; on success the
   connection is bound to its `Identity` for its lifetime (replacing 3a's ignored
   `clientId`). An authenticated-but-seatless identity may join to **observe**; it
   simply cannot `append`.
4. **Enforcement gate** — before delegating an `append` to `Table.append`, the server
   checks `Membership.owns(connectionIdentity, append.actor)`. Control messages are
   gated on `connectionIdentity === gmIdentity`. Failures return `denied`.
5. **Presence** — a derived per-campaign view (seat owners + who is online + GM
   online), broadcast on connect / disconnect / assign / unassign / transferGM, and
   sent to a connection immediately after a successful `join`.

## Wire protocol changes (`transport-shared`)

```ts
// client → server (changes + additions)
type ClientMsg =
  | { t: "join";        campaignId; token: string; fromSeq: number }     // token replaces clientId
  | { t: "append";      campaignId; entry: WireLogEntry; actor: Actor }  // actor added
  | { t: "getSnapshot"; campaignId }
  | { t: "putSnapshot"; campaignId; seq; snapshot }
  // GM-only control messages (admin override)
  | { t: "assignSeat";   campaignId; characterId: string; identity: string }
  | { t: "unassignSeat"; campaignId; characterId: string }
  | { t: "transferGM";   campaignId; identity: string };

// `character` = act as an owned seat; `gm` = GM/lifecycle/NPC; `join` = self-claim a
// NEW seat (the joinCampaign append; the client surfaces the new character's id so
// the server can bind it to the connection's identity).
type Actor =
  | { kind: "character"; actorId: string }
  | { kind: "gm" }
  | { kind: "join"; characterId: string };

// server → client (additions)
type ServerMsg =
  | …existing 3a messages (joined, entry, appendOk, appendConflict, snapshot, error)…
  | { t: "denied";   reason: string }                              // well-formed but unauthorized
  | { t: "presence"; campaignId; seats: PresenceEntry[]; gm: { identity: string; online: boolean } };

type PresenceEntry = { characterId: string; owner: string | null; online: boolean };
```

`denied` is distinct from 3a's `error` (malformed input). `Identity` is an opaque
`string` chosen by the host's verifier.

## Bootstrapping & lifecycle

- **Room creation** seeds `Membership` with the designated `gmIdentity` (via
  `gmIdentityFor`). *(Implementation note: only `gmIdentity` is seeded — a channel
  for **pre-assigned seats** at room creation is **not** implemented; see Known
  limitations.)* The host owns room creation and the verifier, so it knows the GM.
- **Typical flow:** each player authenticates and `joinCampaign`s (a `join`-actor
  append that creates their character C and self-claims the seat — the server binds
  C → that identity) → the same player runs `selectArchetype` on C (a `character`-actor
  append, enforced by ownership) → GM `beginCampaign`. The GM uses the control
  messages only for admin override (reassign/kick/hand-off).
- **Caveat — in-engine-seeded characters start ownerless.** A character created
  *in-engine* (constructed directly, as `buildSeedCampaign` does — not via a
  `join`-actor append) has **no** `Membership` seat, so it cannot act until the GM
  `assignSeat`s it. The self-service self-claim only binds for characters created
  through a `join`-actor append.
- **GM layering:** `gmIdentity` is the *identity* with table authority (assign seats;
  issue `gm`/lifecycle/NPC + setup-on-behalf). It is **distinct** from the engine's
  in-game GM *character* (`transfer` etc.), which stays game-domain state. 3b does not
  couple them.

## Data flow

**Append:** client builds the `LogEntry` as in 3a and derives the `actor` envelope
from the command: a `joinCampaign` command → `{kind:"join", characterId}` (the new
character's id, read from the command's snapshot client-side); any other command
with a non-null `commandActorId` → `{kind:"character", actorId}`; otherwise (GM /
lifecycle / NPC) → `{kind:"gm"}`. It sends `{t:"append", entry, actor}` (the `token`
was presented at `join`). The server, having resolved the connection's `identity`:
- **`character`** → accept iff `Membership` says `identity` owns `actorId`; else `denied`.
- **`gm`** → accept iff `identity === gmIdentity`; else `denied`.
- **`join`** → accept for any authenticated identity **iff `characterId` is not
  already owned** (prevents hijacking an existing seat); on a committed append, bind
  `characterId → identity` in `Membership` and rebroadcast presence.

On accept, delegate to `Table.append` (3a CAS + broadcast) unchanged. A `denied`
append commits nothing and is not broadcast.

**Control message (GM):** server checks `identity === gmIdentity` → applies to
`Membership` → rebroadcasts `presence`. Non-GM → `denied`.

**Join:** `verifyToken(token)` → identity (or `denied`); subscribe via `Table.join`
(3a backfill); then send current `presence`.

## The `WebSocketTransport` change (client) + the one small engine change

Most of the work is client-side and interface-preserving, but surfacing a denied
append **does** require a small, bounded engine change (stated up front — not a
"zero engine changes" claim):

- **Engine change:** `AppendResult` gains a terminal `{ ok: false; denied: true;
  reason }` variant (alongside the existing `conflict`), and `SyncCoordinator.submit`
  handles it: a denied append means the resolver already advanced the local campaign
  but the server rejected the commit, so submit **rolls the local campaign back to
  `before`** (reusing the existing restore path) and returns a **terminal**
  `CommandResult` rejection — **no retry, no `#syncTo`** (nothing new committed on the
  server). This is analogous in size to 3a's async-seam change; `commandActorId` is
  reused unchanged.
- **`WebSocketTransport`:** constructed with the `token`; sends it on `join` and on
  every **reconnect** (re-authentication); derives each append's `actor` envelope from
  the command — `joinCampaign → {kind:"join", characterId}` (id read from the
  command's `character` snapshot), else `commandActorId(command)` non-null →
  `{kind:"character", actorId}`, else `{kind:"gm"}`; maps a server `denied` append to
  the new `AppendResult` denied variant.
- On a `denied` **join/reconnect** (e.g. token expired), it stops and surfaces the
  denial — it cannot silently re-join.

## Presence

Per campaign the server maintains a derived view and broadcasts it on every change:
- Tracks live connections per identity, the seat map, each seat-owner's online
  status, and GM online status.
- An identity is `online` if **any** of its connections is live (multiple tabs =
  same identity; either can act; closing one keeps it online if another remains).
- **Minimal scope:** "who is here / which seats are filled and online." Rich
  indicators (typing, who-is-speaking, turn spotlight, cursors) are out of scope —
  they belong to 3c / 3d / the UI track.

## Persistence & reconnect

- `Membership` and presence are **in-memory** server state (like 3a's log), seeded at
  room creation and mutated by GM control messages. Durable cross-restart persistence
  is **out of scope**; a storage-interface seam is left for a later spec.
- Reconnect re-sends `join` with the `token`, so every reconnect re-authenticates. A
  reconnect whose token is now invalid/revoked → `denied`, surfaced to the client.

## Error handling

- **`denied { reason }`** — well-formed but unauthorized: bad token on join, append
  for an unowned seat (no commit, no broadcast), a control message from a non-GM, a
  reconnect with a revoked token.
- A `verifyToken` that **throws** is treated as `denied`; the room never crashes.
- A `denied` append surfaces to the submitting client as a terminal rejection (not a
  retryable CAS conflict).
- 3a's `error` (malformed input) is unchanged.

## Testing

- **Auth:** valid token joins; invalid/null → `denied`; throwing verifier → `denied`,
  room survives.
- **Ownership (headline anti-spoof):** append for an owned seat commits + broadcasts;
  append for an **unowned** seat → `denied`, **state unchanged on all replicas**
  (including the submitting client, whose local campaign is rolled back to `before`),
  and the submit returns a **terminal** rejection (no retry); `gm` action by
  `gmIdentity` accepted, by a non-GM → `denied`.
- **Self-claim join:** a `join`-actor append binds the new `characterId` to the
  joiner's identity (it can then act for that seat); a `join` whose `characterId` is
  already owned → `denied` (no hijack).
- **Membership (admin override):** GM `assignSeat` reassigns a seat to another
  identity; `unassignSeat` revokes (subsequent append `denied`); non-GM
  `assignSeat`/`unassignSeat`/`transferGM` → `denied`.
- **Presence:** connect / disconnect / assign broadcast the correct presence;
  multi-connection-per-identity online semantics (two connections, close one → still
  online).
- **3a integration:** two **authenticated owners** still converge byte-identically
  through the auth + ownership path; a spoof attempt is rejected and causes **no
  divergence**.
- **Reconnect re-auth:** valid token reconnects and reconverges; a revoked token on
  reconnect → `denied`.

## Known limitations (deep-review 2026-06-19 — deferred, not bugs to fix in 3b)

3b's enforcement is intentionally narrow (envelope-ownership, server stays
engine-agnostic). The adversarial review found the following; the **fixed** items
landed in 3b, the rest are deferred (most to the authoritative-server promotion):

- **FIXED in 3b — `putSnapshot` integrity.** The checkpoint late-joiners deserialize
  is now **GM-gated** and rejected if `seq > head`, so a non-GM/seatless client can
  no longer poison it. (`getSnapshot` remains pre-auth-readable — reading the
  snapshot is allowed; only writing is gated.)
- **FIXED in 3b — connection-identity binding.** A connection authenticates once; a
  second `join` with a different token, or a duplicate `join` to the same campaign,
  is now `denied` (previously corrupted presence's online accounting).
- **DEFERRED (authoritative server) — cross-seat impersonation.** A hostile
  seat-holder can forge a `delta` acting as another seat (the server can't bind the
  opaque payload to the envelope). See **The security boundary**.
- **DEFERRED (authoritative server) — `join` id binding.** The bound `characterId`
  trusts the envelope and may be decoupled from the created character (seat-squat).
- **DEFERRED — `transferGM` lockout.** A GM transferring GM to a never-connecting
  identity permanently bricks the table; no recovery seam in 3b.
- **DEFERRED — durable membership.** `Membership` is in-memory; a server restart
  wipes all seats (every non-GM player is `denied` until the GM re-`assignSeat`s;
  `gmIdentity` is reseeded from `gmIdentityFor`). Out-of-scope per persistence below;
  the blast radius is noted here.
- **DEFERRED — pre-assigned-seats channel** (promised at room creation, not
  implemented); **no per-identity seat cap**; **denied reconnect is terminal** (a
  transient denial kills the transport — reconstruct to recover); **unbounded
  server maps** (no prune-on-empty); a hostile server could inject `entry` frames
  during a denied handshake (no current honest trigger).

## Out of scope (later specs)

- **Full game-authority server** (resolver server-side — closes cross-seat
  impersonation and "cheating with your own seat"). The seam is preserved; the
  server is not promoted here.
- **Concrete token issuer / crypto** — the host supplies `verifyToken`.
- **Durable cross-restart persistence** of membership/log.
- **Rich presence** (typing / speaking / turn spotlight / cursors) — 3c / 3d / UI.
- **Rate-limiting / anti-abuse, multi-room federation.**
- **Text chat (3c), A/V (3d).**

## Docs

Per the living-documentation convention, the README "Multiplayer client" section
gains an auth/seat-ownership/presence subsection, and the new public surfaces
(`verifyToken`, `Membership`, the `Actor` envelope, `denied`/`presence`/control
messages) get TSDoc once implemented.
