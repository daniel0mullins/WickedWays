# Rust Phase 2c — Sub-project C: the axum room server — Plan

**Date:** 2026-07-17
**Design:** [`docs/superpowers/specs/2026-07-14-rust-phase-2c-c-axum-room-server-design.md`](../specs/2026-07-14-rust-phase-2c-c-axum-room-server-design.md)
**Prereqs (all merged):** A0 (`sync::Command` + authorize), B MVP (`SyncAuthority` + `Delta` + log +
`Replica`/`SyncCoordinator`), the differential gate. The sync core is on `main` and exposes
everything C hosts (`wickedways_core::sync::{SyncAuthority, SubmitResult, LogEntry, Delta, Command}`).

## Goal

Port `packages/server/` to a Rust/axum room server crate that hosts a **native** `SyncAuthority` per
campaign, gates appends by seat ownership, persists durably, and speaks the existing
`transport-shared` wire protocol. Conventional server code — **no differential oracle**; correctness =
ported behavioral tests + wire parity + a two-client convergence e2e.

## New crate

`crates/wickedways-server` (new workspace member). Depends on `wickedways-core` with `features =
["std"]` (native, not wasm). External deps (registry reachable — verified with `cargo search`):

- `axum` (WebSocket upgrade via `axum::extract::ws`), `tokio` (`rt-multi-thread`, `macros`, `sync`),
- `serde` / `serde_json`,
- `rusqlite` (`bundled`) for the store, driven via `tokio::task::spawn_blocking` (rusqlite is sync;
  the per-campaign actor serializes access, so a blocking store call off the runtime is clean and
  mirrors the TS single-row upsert). `sqlx` (async sqlite) is the alternative if we prefer no
  blocking pool — decide in slice 1; rusqlite keeps the SQL identical to `sqlite-store.ts`.

## Global constraints

- **Panic-free room.** A malformed message, a throwing verifier, or a store error is a `denied`/
  `error` reply, never a task panic that drops other campaigns. Every `.await` that can fail is
  handled; no `unwrap` on network/store paths.
- **Server owns only the seat gate.** The authority re-derives every delta from the command; no
  client-supplied delta or actor envelope is trusted. `actor_of(command)` derives the seat.
- **Flush-before-ack.** A commit is persisted before it is acked/broadcast; a persist failure reverts
  (reload) and denies, so a client never sees an unpersisted commit.
- **Atomic seat+commit.** A join's seat-claim is written in the same `save` as its commit.
- **Fail-closed on schema drift.** Never overwrite a newer-schema record with a genesis.
- **Wire parity.** `ClientMsg`/`ServerMsg`/`WireLogEntry` serialize byte-identically to
  `packages/transport-shared/src/index.ts` (`t`-tagged, camelCase); `command`/`delta`/`snapshot`
  relayed opaquely except `submit`, which deserializes into `sync::Command` to derive the seat.

## Slices

### Slice 0 — crate skeleton
- Add `crates/wickedways-server` to the workspace; `Cargo.toml` with the deps above; an empty
  `lib.rs` + `main.rs` that compiles. Confirm `cargo build -p wickedways-server` fetches/builds in CI's
  environment before going further (the one environment risk to retire early).

### Slice 1 — wire types + `Membership` + `CampaignStore`/`SqliteStore`
- **`transport` module** (extractable to a shared crate when D lands): serde types mirroring
  `transport-shared` — `ClientMsg`, `ServerMsg`, `WireLogEntry`, `Actor`, presence/roster structs.
  `command`/`delta`/`snapshot` typed as `serde_json::Value` (opaque relay). Byte-shape tests vs the TS
  union (the `intent.rs` self-test pattern).
- **`Membership`** (port `membership.ts`): `gm_identity` + `seats: BTreeMap<CharacterId, Identity>`;
  `may_act(identity, actor)`, `claim`/`assign`/`unassign`/`transfer_gm`, `to_state`/`from_state`.
  `actor_of(command)` derives the seat from the command. Unit tests port `membership.test.ts`.
- **`CampaignStore`** trait (port `store.ts`) + `CampaignRecord {seq, snapshot, membership}` +
  `SqliteStore` (port `sqlite-store.ts`: WAL, single-row upsert, parameterized statements only).
  Contract test round-trips a record.

### Slice 2 — the `Table` actor + flush-before-ack
- **`Table`** = a per-campaign tokio task owning `SyncAuthority` + `Membership`, draining an mpsc queue
  of `{ Submit, Join, Leave, GetSnapshot, GmMutate, Broadcast }` messages strictly in order. This is
  the concurrency decision from the design: submit → persist → ack is atomic per campaign for free (no
  shared mutable state across `.await`), different campaigns run concurrently.
- `submit`: authority.submit → denied ⇒ reply denied to sender; else run `on_commit` (seat-claim for a
  join) → `persist()` (flush-before-ack; on failure `reload()` + deny) → ack sender `committed{seq,
  delta}`, broadcast `entry{seq,delta}` to the other participants.
- `join`/`leave`/`send_snapshot`/`broadcast`/`current_snapshot`/`head`/`replace_authority` port
  directly. Store I/O via `spawn_blocking`.
- Tests port `table.test.ts` (flush-before-ack, reload-on-persist-failure, backfill on join).

### Slice 3 — axum WS handler + connection lifecycle
- `create_server(opts) -> ServerHandle` over an axum `Router` with a `/ws` upgrade. Per connection: a
  `send` sink (serialize `ServerMsg` → text), auth state, a per-connection `peer_id`.
- Message arms (multiplayer only; chat/AV are **E**): `join` (verify_token ⇒ identity; reject second
  identity / double-join; `ensure_loaded` with inflight dedup + schema fail-closed; `table.join`; bump
  online; broadcast presence + roster), `submit` (auth; `may_act` gate; `on_commit` seat-claim for a
  join; `table.submit`), `getSnapshot` (read-only, pre-auth), `assignSeat`/`unassignSeat`/`transferGM`
  (GM-only; persist; broadcast presence). `close` → leave + presence/roster.
- Presence/roster/online maps as server state keyed by campaign.
- Tests port `server.test.ts` (auth gating, seat ownership, presence, backfill).

### Slice 4 — wire parity + two-client convergence e2e
- A Rust client (or an interop harness) exchanges the exact `ClientMsg`/`ServerMsg` bytes; assert
  shapes match `transport-shared`.
- Two `SyncCoordinator`s (from B) connect over a real WebSocket transport (a thin
  `SyncTransport`-over-axum-ws), one submits, both converge — the end-to-end proof C exists for.
- `main.rs` entry: reads `PORT`/`DB_PATH`/`GM_IDENTITY`; ephemeral (no `DB_PATH`) vs durable.

## Finalize

- README: add a "Rust room server" note under Multi-client sync; point D/E at the `/ws` endpoint and
  `ServerOptions` seam.
- `cargo test -p wickedways-server`, `cargo clippy -p wickedways-server`, `cargo test --workspace`,
  `pnpm run bindings:check`.
- Wire the server tests into CI. **Note:** the OAuth app cannot modify `.github/workflows/` from a
  push (hit this on the differential-gate PR). Either the user adds the `cargo test -p
  wickedways-server` CI line, or (simpler) the crate's tests ride along wherever a workflow-free hook
  runs them; flag this in the PR so the user can add the CI step.

## Notes / gotchas to watch

- **Async `SyncTransport`.** B's `SyncTransport` trait is synchronous (in-process). C's WebSocket
  transport is genuinely async; either widen the trait to return futures or give the client its own
  async transport that feeds a `SyncCoordinator`. Decide in slice 4; the in-process trait stays for
  single-player.
- **rusqlite is sync.** Keep store calls inside the actor via `spawn_blocking`, or switch to `sqlx`.
  Do not hold the authority lock across the blocking call — the actor owns the authority, so serialize
  by construction.
- **Wire types will be shared with D.** Start them as a `transport` module in the server crate; extract
  to `crates/wickedways-transport` when D needs them (avoid premature crate churn now).
- **Registry/genesis injection.** The TS server takes host callbacks (`verify_token`, `genesis_for`,
  `gm_identity_for`, `registry`). Mirror as `ServerOptions` fields (closures / trait objects). The
  Rust `SyncAuthority::new` takes a `World` + `Catalog`, so `genesis_for` yields a `CampaignSnapshot`
  and the host supplies the `Catalog`.
- **Chat/AV arms and their `ServerOptions` (chat_store, ice_servers, display_name_for) are E** — leave
  extension points in the message loop and options struct, don't implement them here.

## Next

After C: **D** (Dioxus web client over `/ws`, sharing the wire types) and **E** (chat/AV arms into C's
loop). The axum + Dioxus one-binary (per the PR-preview design) is the convergence point of C + D.
