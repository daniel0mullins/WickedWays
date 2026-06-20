# Durable Persistence — Design

> Comms program follow-up. Closes the "durable membership / campaign persistence"
> item deferred by sub-spec 3b and the authoritative-server spec: today any server
> restart wipes every in-progress campaign and all seat ownership back to genesis.

**Status:** approved (pending user review), ready for implementation planning
**Date:** 2026-06-19
**Builds on:** Spec 1 (serialization — `serializeCampaign`/`deserializeCampaign`, `CampaignSnapshot`, `schemaVersion`), 3a (room server + `Table`), 3b (`Membership` seat ownership), authoritative-server (the server holds an `Authority` per campaign).

---

## Goal

Persist each campaign's authoritative state and its seat ownership so a server
restart (crash, reboot, or deploy) **resumes exactly where it left off** — same
campaign state, same seq, same seats — and persist the client's identity so a
page reload **keeps its seat**.

## Background: what is lost today

- The server's per-campaign `Authority` holds the live campaign + committed log +
  checkpoint **in memory**. On restart, `genesisFor(id)` rebuilds only the
  *genesis* — all play progress is gone.
- `Membership` (seat → identity + GM identity) is **in-memory**; restart loses
  every seat claim and GM assignment.
- `client/main.ts` mints `crypto.randomUUID()` as the token **on every page
  load**, so even a reload (no server restart) becomes a *new identity* and loses
  its seat.
- Presence (online counts) is ephemeral and correctly **not** persisted.

## Decisions (locked during brainstorming)

1. **Scope.** v1 = server durability (`Authority` snapshot + `Membership`) **plus**
   client identity persistence. Client *state* caching (warm-start / offline read)
   is **deferred** to a later optimization spec.
2. **Persistence model — snapshot-every-commit, flush-before-ack.** The server
   persists the campaign's **full snapshot on every commit** (free: `Authority.submit`
   already serializes the after-state for the diff), written **before** the server
   acks `committed` / broadcasts `entry`, so "acked ⟹ durable." No write-ahead log,
   no compaction, no delta replay on restart — restore is a single
   `deserializeCampaign`, the same hot path every client join already exercises.
   A future WAL adapter can swap in behind the port if campaign size / throughput
   ever demands it; this is not a one-way door.
3. **Host-injected `CampaignStore` port** (same shape as `verifyToken` /
   `gmIdentityFor` / `genesisFor`), with an **atomic** `load`/`save` of the whole
   campaign record. Persistence is **opt-in**: no store injected ⇒ today's
   ephemeral behavior (tests and single-player unchanged).
4. **Reference adapter — SQLite via Node's built-in `node:sqlite`.** A single DB
   file; snapshot + membership written in **one transaction** per `save`, so they
   can never disagree across a crash. WAL mode. Zero external dependencies.
5. **Client identity** is persisted in `localStorage` (dev-harness token); real
   deployments source the token from an auth flow (host concern).

---

## Architecture

```
commit:  Authority.submit (in-memory) ──► await store.save(id, {seq, snapshot, membership})
                                          ──► send committed + broadcast entry   (flush-before-ack)
load:    store.load(id) ?─► resume Authority @ persisted seq + Membership
                         └─► (null) genesisFor(id) + fresh Membership
```

The `Authority` stays a pure in-memory unit. The server (via `Table`) orchestrates
all I/O. The single-player in-process path uses `InProcessTransport` (not `Table`),
so it is entirely unaffected — single-player persistence is out of scope.

### `CampaignStore` port (`packages/server/src/store.ts`)

```ts
/** One campaign's full durable state, written atomically. */
export interface CampaignRecord {
  seq: number;                  // the committed head this snapshot represents
  snapshot: CampaignSnapshot;   // engine snapshot (carries schemaVersion)
  membership: MembershipState;  // seat ownership at this seq
}

/** Server-side serializable form of a Membership. */
export interface MembershipState {
  gmIdentity: string;
  seats: [characterId: string, identity: string][];
}

/** Host-injected durable store for campaign records. Implementations MUST make
 *  `save` atomic (a torn/partial write must never be observable by `load`). */
export interface CampaignStore {
  load(campaignId: string): Promise<CampaignRecord | null>;
  save(campaignId: string, record: CampaignRecord): Promise<void>;
}
```

Every durable write — a commit **or** a seat change — calls `save` with the full
current record (`{ seq: authority.head(), snapshot: authority.loadSnapshot().snapshot,
membership: m.toState() }`). Re-writing the snapshot on a rare seat-only change is
one extra small write; negligible. Because snapshot and membership are always
written together atomically, they can never disagree across a crash.

### `SqliteStore` reference adapter (`packages/server/src/sqlite-store.ts`)

```ts
import { DatabaseSync } from "node:sqlite";
// table: campaigns(campaignId TEXT PRIMARY KEY, seq INTEGER, snapshot TEXT, membership TEXT, updatedAt INTEGER)
// PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;
```

- Constructed with a DB file path: `new SqliteStore(path)`.
- `save` runs one transaction: `BEGIN; INSERT … ON CONFLICT(campaignId) DO UPDATE …; COMMIT;`
  storing `snapshot`/`membership` as `JSON.stringify`'d TEXT columns. WAL +
  `synchronous = NORMAL` is crash-safe (the DB never corrupts; only the last
  transaction can be lost on a hard power loss — acceptable; `synchronous = FULL`
  is available for stricter durability).
- `load` reads the row, `JSON.parse`s the columns, returns `CampaignRecord | null`.
- `node:sqlite`'s API is **synchronous** (`DatabaseSync`); the adapter wraps the
  sync calls in resolved promises to satisfy the async port. The per-commit write
  briefly blocks the event loop — negligible at turn-based command rates with
  small blobs.
- `node:sqlite` is **experimental** (Node ≥ 22.5; the repo runs v22.18). It emits
  an experimental-feature warning; tests suppress it (see Global Constraints).
- `close()` for teardown (tests / shutdown).

### Server wiring (`packages/server/src/{server,table}.ts`)

- `createServer` gains optional `store?: CampaignStore`.
- **Loading is async-but-once; steady-state access stays sync.** A new
  `ensureLoaded(id): Promise<Table | null>` does the one-time
  `const rec = await store?.load(id)` → `const genesis = rec?.snapshot ??
  genesisFor(id)` (null ⇒ unknown campaign), builds the `Authority` from `genesis`
  **resuming at `rec?.seq ?? 0`** (see §"Authority seq-continuity") and the
  `Membership` from `rec?.membership` (via `Membership.fromState`) or
  `new Membership(gmIdentityFor(id))`, caches the `Table`, and returns it. Only the
  two handlers that can be a campaign's *first* contact — `getSnapshot` (pre-auth
  handshake) and `join` — `await ensureLoaded(id)`. Every other handler (`submit`,
  the seat-control messages, presence, close) uses the **synchronous** cached
  `tables.get(id)`, which is guaranteed present because a client must `join`
  (which loads) before it can do anything else. This contains the new `async` to
  the load path instead of rippling `await` through presence/close.
- `Table` holds a campaign-scoped `persist()` thunk (supplied by the server;
  writes `{ seq: authority.head(), snapshot: authority.loadSnapshot().snapshot,
  membership: m.toState() }` via `store.save`) and a `reload()` thunk (rebuilds
  its `Authority` + `Membership` from `store.load` — used only on persist failure).
- `Table.submit` becomes **async**: `authority.submit` → on commit, `try { await
  this.#persist() }` → **then** send `committed` + broadcast `entry`. **On a
  persist failure** the in-memory `Authority` is now ahead of durable, so the
  commit is **rolled back**: `await this.#reload()` (discarding the un-persisted
  commit by rebuilding from the last durable record) and the submitter receives
  `denied` ("could not persist; retry") — nothing is broadcast, so no replica ever
  sees a non-durable commit and in-memory stays equal to durable. On an authority
  *denial* (illegal command) nothing is persisted or sent, as today.
- Seat changes — the committed-`join` `claim`, and the GM `assign`/`unassign`/
  `transferGM` handlers — each `await` a persist of the full record after mutating
  `Membership` (a persist failure there is surfaced as `denied`/`error` and the
  membership mutation is reverted via `reload`).
- The server's ws message handler already runs async, so the added `await`s on the
  load and submit paths are free.

### Authority seq-continuity (the one engine change)

Snapshot-only persistence **discards the delta log**, so a restored `Authority`
holds only the head snapshot and must **resume at the persisted seq `K`**, not
reset to 0. Otherwise a client that reconnects at `head = K` would see the
server's next commit as `seq 1 (≤ K)`, drop it as a duplicate, and **diverge**.

Change: `Authority`'s constructor gains an optional `startSeq?: number` (default
`0`). `head()` returns `startSeq` when the log is empty; the first post-restore
commit is `startSeq + 1`; `#snapshot` initializes to `{ seq: startSeq, snapshot:
genesis }`. Three lines, no other engine surface affected. Reconnecting clients
stay consistent because the handshake already serves the current full snapshot
first (`getSnapshot`) and then deltas-since (here, empty).

This is the *only* engine change — far smaller than a WAL restore-from-log path.

### `Membership` persistence (`packages/server/src/membership.ts`)

Add `toState(): MembershipState` (`{ gmIdentity: this.#gmIdentity, seats:
this.seats() }`) and `static fromState(state: MembershipState): Membership`
(seed `#gmIdentity`, populate `#seats`). Pure serialization; no behavior change.

### Client identity persistence (`packages/client/src/main.ts`)

Replace `const clientId = crypto.randomUUID()` with a persisted value:

```ts
const STORAGE_KEY = "wickedways:identity";
let clientId = localStorage.getItem(STORAGE_KEY);
if (clientId === null) { clientId = crypto.randomUUID(); localStorage.setItem(STORAGE_KEY, clientId); }
```

A reload now reuses the identity and keeps its (now durable) seat. Real
deployments obtain the token from an auth flow; this is the dev-harness behavior.

## Crash consistency

- `save` is **atomic** (one SQLite transaction), so snapshot and membership can
  never disagree — the orphaned-character window that separate writes would create
  is closed.
- **Flush-before-ack**: a command is acked only after its record is durable. A
  crash before the write completes means the command was never acked — the client
  knows it is unconfirmed and the server resumes at the prior record. No
  acked-but-lost commits.
- WAL `synchronous = NORMAL` keeps the DB crash-safe; only a hard power loss can
  drop the very last transaction (`synchronous = FULL` available if required).

## Schema versioning

Persisted snapshots carry `schemaVersion`. On `load`, a snapshot whose
`schemaVersion` does not match the engine's current version **fails closed** — the
server refuses to resume that campaign and logs an error, rather than silently
mis-hydrating. Schema migrations are deferred to a later spec.

## Backward compatibility

- No `store` injected ⇒ nothing is persisted (today's behavior). All existing
  server / convergence / auth tests run with no store and are unaffected.
- The genesis path is unchanged when the store has no record for a campaign yet.
- Single-player (in-process) is untouched (no `Table`, no `store`).

## Testing

- **`SqliteStore` round-trip:** `save` then `load` returns the identical record;
  `load` of an unknown id returns `null`; a second `save` upserts (last write
  wins by `campaignId`); snapshot + membership are written atomically (a `save`
  that throws mid-transaction leaves the prior row intact).
- **Server resume across restart:** drive a campaign + seat claims through one
  `createServer` (shared `SqliteStore`), close it, start a **new** `createServer`
  on the same store → campaign state, seats, and `head()` are intact and seq is
  continuous (the next commit is `K+1`, and a reconnecting client converges).
- **Flush-before-ack + persist-failure rollback:** with a store whose `save`
  rejects, a `submit` emits **no** `committed` and broadcasts **no** `entry`; the
  submitter receives `denied`; and the campaign rolls back so the server's
  `head()` and state equal the last durable record (a subsequent legal command
  commits at the same seq it would have, proving the failed command left no
  residue). A reconnecting client converges to the rolled-back state.
- **Authority `startSeq`:** an `Authority` built with `startSeq: K` reports
  `head() === K`, its first commit is `K+1`, and `loadSnapshot().seq === K`.
- **Client identity:** a simulated reload (same `localStorage`) reuses the
  identity; a cleared store generates a fresh one.
- **Schema mismatch:** `load` of a record whose `schemaVersion` differs from the
  engine's fails closed (campaign refused, error logged), no mis-hydration.
- All persistence tests suppress the `node:sqlite` experimental warning so output
  stays pristine.

## Explicitly out of scope (deferred)

- **Client state caching** (browser snapshot cache, warm-start, offline read,
  `fromSeq` resume across reloads) — a later optimization spec.
- **WAL persistence adapter** — swappable behind the same port if scale demands.
- **Multi-instance / locking** — a single server instance owns a campaign's
  record; concurrent writers are out of scope.
- **Schema migrations** of persisted data (v1 fails closed on mismatch).
- **Persisting single-player in-process campaigns** (a client-side save concern).

## Global constraints (for the plan)

- **Node ≥ 22.5** required for `node:sqlite`; the repo runs v22.18. Document the
  floor in `packages/server` (`engines` field) and the harness.
- Persistence is **opt-in** via an injected `store`; the default `createServer`
  with no store must behave exactly as today.
- The `node:sqlite` experimental warning must be suppressed in tests (e.g.
  `NODE_OPTIONS=--no-warnings` for the persistence test files, or filtering the
  specific warning) so test output is pristine.
- No rng change. TypeScript strict + `noUncheckedIndexedAccess` + `NodeNext`.
  Illegal lifecycle transitions throw `ProceduralViolation`.

## Files (anticipated)

- Create: `packages/server/src/store.ts` (port + `CampaignRecord`/`MembershipState`),
  `packages/server/src/sqlite-store.ts` (+ tests for each).
- Modify: `packages/server/src/server.ts` (async `tableFor` load-or-genesis;
  `store` option; persist on seat changes), `packages/server/src/table.ts`
  (async `submit` persist-before-ack), `packages/server/src/membership.ts`
  (`toState`/`fromState`), `packages/server/src/main.ts` (wire a `SqliteStore`),
  `packages/server/package.json` (`engines.node`).
- Modify: `src/lib/sync/authority.ts` (`startSeq`) + `authority.test.ts`.
- Modify: `packages/client/src/main.ts` (persist identity).
- Update: `README.md` (durable persistence + the Node floor + opt-in store).
