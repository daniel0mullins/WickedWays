# Rust Phase 2c — Sub-project C: the axum room server (design)

**Date:** 2026-07-14
**Status:** design
**Program:** [`2026-07-14-rust-phase-2c-multiplayer-dioxus-program-design.md`](./2026-07-14-rust-phase-2c-multiplayer-dioxus-program-design.md) (sub-project **C**)
**Depends on:** A (the actor-tagged `Command` union + `command_actor_id`) and B (the `SyncAuthority`, `Delta`, log).
**Ports:** `packages/server/src/{server,table,membership,store,sqlite-store,main}.ts` (~800 LOC) + the wire
protocol `packages/transport-shared/src/index.ts`.
**Fullstack target:** [`2026-07-10-pr-preview-deployments-design.md`](./2026-07-10-pr-preview-deployments-design.md) (one axum + Dioxus binary, `/ws` upgrade).

## Goal

Port the authoritative WebSocket room server to Rust/axum: per-campaign `Table`s hosting a **native**
`SyncAuthority` (B), the seat-ownership `Membership` gate, durable persistence, presence/roster, and
the connection lifecycle. The server links `wickedways-core` **directly** (native, not WASM) and, per
the fullstack design, lives in the same axum binary that serves the Dioxus web app (D) — the WebSocket
endpoint is an axum WS upgrade on a route (`/ws`).

Scope note: the message loop the TS server runs also carries the **chat and A/V** arms. Those are
**sub-project E**; C builds the server skeleton + the multiplayer command arms (join / submit /
getSnapshot / assignSeat / unassignSeat / transferGM) + presence/roster, and leaves the chat/call arms
as an extension point E fills in.

## The pieces to port

| TS file | Role | Rust counterpart |
| --- | --- | --- |
| `table.ts` | per-campaign coordinator over one `Authority`; participant set; flush-before-ack `submit`; `join`/`leave`/`broadcast`/`sendSnapshot`/`persist`/`reload` | `Table` (a per-campaign async **actor** — see Concurrency) |
| `membership.ts` | seat→identity map + GM identity; `mayAct`; `claim`/`assign`/`unassign`/`transferGM`; `toState`/`fromState` | `Membership` (plain struct, server-owned) |
| `store.ts` | `CampaignStore` (atomic `load`/`save`), `CampaignRecord {seq, snapshot, membership}`, `MembershipState` | `CampaignStore` trait + records |
| `sqlite-store.ts` | `node:sqlite` WAL single-row upsert per campaign | `SqliteStore` over `rusqlite` (or `sqlx`), same schema |
| `server.ts` | `createServer(opts)`; `ws` server; lazy per-campaign load with inflight dedup; connection auth + message switch; presence/roster/online bookkeeping | axum WS handler + a `Server` state struct |
| `transport-shared/index.ts` | `ClientMsg`/`ServerMsg`/`WireLogEntry`/presence/roster arms | serde types in a shared crate |

## Design

### The wire types

Reproduce `transport-shared` as serde types (internally tagged on `t`, camelCase). The key nuance: TS
relays `command`/`delta`/`snapshot` as **opaque `unknown`** — but the server *does* deserialize
`command` into the concrete `Command` to derive the acting seat (`actorOf`, `server.ts:46`) and gate
it. So in Rust the `submit` arm deserializes into A's `Command`; everything else stays opaque relay.
`WireLogEntry { seq, base_seq, command, delta }` carries B's `Delta`.

### `Table` — the per-campaign coordinator

Port `table.ts`: wraps a `SyncAuthority`, holds the participant set, and on `submit`:

1. `authority.submit(command)` → denied ⇒ reply `denied` to sender only.
2. run `on_commit` (the seat-claim for a join) **after** the in-memory commit, **before** persist, so
   the seat is written in the same atomic `save`.
3. **flush-before-ack**: `persist()`; on failure `reload()` (revert campaign + membership to the last
   durable record) and reply `denied`.
4. ack `sender` with `committed{seq, delta}`; broadcast `entry{seq, delta}` to every **other**
   participant.

`join(sub, from_seq)` acks `joined{head}` then backfills `entry` for `entries_since(from_seq+1)`.
`send_snapshot`, `broadcast`, `current_snapshot`, `head`, `replace_authority` port directly.

### `Membership` — the seat gate (server-only)

Port `membership.ts` verbatim: `gm_identity` + `seats: Map<CharacterId, Identity>`; `may_act(identity,
actor)` (character ⇒ seat owner matches; gm ⇒ identity is GM; join ⇒ seat unowned); `claim` (self
join) vs `assign` (GM override) kept distinct; `transfer_gm`; `to_state`/`from_state`. This is the
**human↔seat ownership** layer the A spec deferred here — it is server protocol state, **never** in the
campaign snapshot, so the server enforces appends without reading opaque payloads.

`actor_of(command)` (`server.ts:46`) derives the seat from the command itself — join ⇒ `{join,
characterId}`, else `command_actor_id` ⇒ `{character, actorId}` or `{gm}` — so there is no
client-supplied actor envelope to forge.

### Persistence

Port `store.ts` + `sqlite-store.ts`: `CampaignStore` trait with atomic `save`, `CampaignRecord {seq,
snapshot, membership}`, single-row-per-campaign WAL upsert (the existing schema, already audited
injection-safe — parameterized statements only). With a store, `snapshot_every = 1` so
`current_snapshot()` is always fresh for `save`; without one the server is ephemeral (the PR-preview
default). Schema-version mismatch **fails closed** (`server.ts:95`) — refuse to resume rather than
overwrite a record with a genesis.

### Connection lifecycle (the axum handler)

Port the `server.ts` message switch for the multiplayer arms:

- **`join`** — `verify_token` ⇒ identity (a throwing/erroring verifier denies, never crashes the room);
  reject a second identity on one connection / double-join; `ensure_loaded` (lazy build from persisted
  record or `genesis_for`, with **inflight dedup** so concurrent joins don't double-load); `table.join`;
  bump online; broadcast presence + roster.
- **`submit`** — require auth; `may_act` gate; for a join, pass `on_commit = claim(seat)`; `table.submit`.
- **`getSnapshot`** — read-only, pre-auth allowed (unchanged boundary); `null` snapshot on unknown.
- **`assignSeat` / `unassignSeat` / `transferGM`** — GM-only; mutate `Membership`; persist (reload+deny
  on failure); broadcast presence.
- **`close`** — `table.leave`; decrement online; broadcast presence + roster.

Presence/roster/online maps port as server state keyed by campaign. Host-injected options
(`ServerOptions`): `verify_token`, `gm_identity_for`, `registry`, `genesis_for`, `rng`, `store`,
`display_name_for` (+ the chat/call/ICE options land with E).

### Concurrency — the one place Rust must be *more* careful than TS

The TS server is safe by accident of the single-threaded event loop: its persist thunk reads
`t.head()` / `t.currentSnapshot()` at execution time, and the code itself flags the hazard
(`server.ts:110-113`): *"A genuinely-async CampaignStore would need per-campaign submit serialization
to avoid one submit's persist thunk capturing a later seq/snapshot written by a concurrent submit."*
Under tokio with a real async SQLite store, that genuinely-async case **is** the norm.

**Decision: model each `Table` as a per-campaign actor.** One tokio task owns the campaign's
`SyncAuthority` + `Membership` and processes an mpsc queue of `{command, sender, respond}` messages
strictly in order; connection handlers send to that queue and await the reply. This gives
submit→persist→ack atomicity per campaign for free (no shared mutable state held across an `.await`,
no interleaving), while different campaigns run concurrently. It is the idiomatic Rust answer to the
TS comment and the cleanest expression of "the authority is the single source of truth." (A per-
campaign async `Mutex` around submit+persist is the simpler fallback if the actor rewrite is too heavy
for the first slice — but the actor model is the recommended target.)

## The oracle / gate

C has **no differential oracle** — it is conventional server code. Correctness is proven by:

1. **Ported behavioral tests** — `server.test.ts` (~485 LOC), `table.test.ts`, `membership.test.ts`
   re-expressed as Rust integration tests: auth gating, seat ownership, flush-before-ack, reload on
   persist failure, schema-version fail-closed, presence/roster, backfill on join.
2. **Wire parity** — a Rust client (or the existing TS client in an interop test) exchanges the exact
   `ClientMsg`/`ServerMsg` bytes; the message shapes match `transport-shared`.
3. **End-to-end** — two participants join a campaign, submit commands, and both converge (the server's
   `SyncAuthority` + broadcast deltas drive each client's `Replica`).

## Constraints held

- **Server owns only the seat gate** — the authority re-derives every delta from the command; no
  client-supplied delta or actor envelope is trusted.
- **Flush-before-ack durability** — a commit is persisted before it is acked/broadcast; a persist
  failure reverts and denies, so a client never sees an unpersisted commit.
- **Atomic seat+commit** — a join's seat-claim is written in the same `save` as its commit (closes the
  orphaned-character window).
- **Fail-closed on schema drift** — never overwrite a newer-schema record with a genesis.
- **Panic-free room** — a malformed message, a throwing verifier, or a store error is a `denied`/
  `error` reply, never a task panic that drops other campaigns.

## What this unblocks / boundary with D and E

- **D (Dioxus web client)** — connects to this server's `/ws`, drives a `Replica` over the wire; the
  same axum binary serves D's assets.
- **E (chat/AV)** — slots its `chatSend`/`callJoin`/`signal`/… arms and `Chat`/`Call` state into the
  message loop and `ServerOptions` this sub-project establishes.

## Next step

Sequence C after A0 + B's MVP (the server needs a working `SyncAuthority` to host). Plan C's slices:
(1) wire types + `Membership` + `CampaignStore`/`SqliteStore`; (2) the `Table` actor + flush-before-ack;
(3) the axum WS handler + join/submit/getSnapshot/GM arms + presence/roster; (4) the ported
integration test suite. Then D (client) and E (chat/AV) proceed against it.
