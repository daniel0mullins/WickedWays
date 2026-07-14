# Rust Phase 2c — Sub-project B: the Rust sync core (design)

**Date:** 2026-07-14
**Status:** design
**Program:** [`2026-07-14-rust-phase-2c-multiplayer-dioxus-program-design.md`](./2026-07-14-rust-phase-2c-multiplayer-dioxus-program-design.md) (sub-project **B**)
**Master design:** [`2026-06-30-rust-engine-core-design.md`](./2026-06-30-rust-engine-core-design.md) (§ Multiplayer: one core, two roles)
**Frozen oracle:** `src/lib/sync/*.ts` (8 modules, ~819 LOC) + its `.test.ts` behavioral goldens.

## Goal

Port the TypeScript sync layer (`src/lib/sync/`) to Rust: the **`Authority`** (authorize → apply →
diff → commit, plus the ordered append-log), the **`Delta`** diff/apply pair, the resolver
**authorize gate**, the **`Replica`** (delta application, never resolves), and the **transport**
seam. Gate it **differentially** against the frozen TS oracle so the Rust core produces identical
deltas, log sequencing, and replica convergence.

This is the layer that makes multiplayer possible; the axum server (C) hosts a Rust `Authority`, and
the Dioxus client (D) drives a Rust `Replica`. Per the master design's "one core, two roles," both
compile from the same crate, so replica convergence is structural, not a test target.

## The oracle's shape (what we mirror)

The TS authority computes deltas the simplest correct way: **serialize the campaign before, apply the
command, serialize after, and structurally diff the two snapshots.** No hand-maintained per-action
delta code. The Rust core already produces the same `CampaignSnapshot` (`World::to_snapshot`,
`world/snapshot.rs:233`) that G1/Phase-1 gated to byte-parity with the TS `serializeCampaign` — so a
snapshot-diff `Delta` in Rust inherits that parity for free.

The eight oracle modules and their Rust counterparts:

| TS module | Role | Rust counterpart |
| --- | --- | --- |
| `types.ts` | `Command` (actor-tagged union), `EntitySnapshot`, `Delta`, `LogEntry`, `CommandResult`, `SubmitResult`, classifiers | serde types in `wickedways-core` (`Command` is **sub-project A**; the rest are B) |
| `authority.ts` | `submit()` = authorize → apply(restore-on-violation) → diff → commit; ordered `LogEntry[]`; periodic checkpoint | `SyncAuthority` (native + WASM) |
| `resolver.ts` | `authorize()` game-rule gate + `apply()` id→instance dispatch | `Resolver::authorize` (B) + `apply_command` binding (A) |
| `entity-index.ts` | transient `id → live-instance` map over the party-reachable graph | internal id lookup in `World` (already exists) |
| `delta-computer.ts` | `diff(before, after)` → created/changed/removed | `DeltaComputer::diff` |
| `delta-applier.ts` | two-pass replica patch; never runs game logic / rng | `DeltaApplier::apply` |
| `coordinator.ts` | `SyncCoordinator` replica; submits, applies broadcasts, no optimistic mutation | `SyncCoordinator` (WASM `Replica` role) |
| `transport.ts` | `SyncTransport` interface + `InProcessTransport` | `SyncTransport` trait + `InProcessTransport` |

## Design

### Boundary types (B)

Mirror `types.ts` as serde types in `wickedways-core`, internally-tagged to reproduce the wire shape
1:1 (`#[serde(tag = "kind"/"type", rename_all = "camelCase")]`):

- **`EntitySnapshot`** — tagged union over `room`/`character`/`item`/`loot`/`materialCache`, each
  wrapping the corresponding `*Snapshot` already defined in `world/snapshot.rs`.
- **`Delta`** — `{ changed: Vec<EntitySnapshot>, created: Vec<EntitySnapshot>, removed: Vec<String>,
  campaign_core: Option<CampaignCoreDelta> }`; `CampaignCoreDelta = { core: CampaignCoreSnapshot,
  codex: Vec<CodexEntry> }`.
- **`LogEntry`** — `{ seq: u64, base_seq: u64, command: Command, delta: Delta }`.
- **`CommandResult`** / **`SubmitResult`** — the two verdict unions (the coordinator's `rejected` vs.
  the authority's `denied` split is preserved verbatim).

`Command` itself and the classifiers (`is_turn_action` / `is_setup_command` / `is_gm_command` /
`is_join_command` / `command_actor_id`) belong to **sub-project A** (see Dependency below); B consumes
them.

### `DeltaComputer::diff`

A direct port. For each of the five collections (`rooms`, `characters`, `items`, `loot`,
`material_caches`), iterate the **`after` array in order**, look each entity up in a `before`-by-id
map, and classify: absent in `before` → `created`; present but not structurally equal → `changed`;
then a second pass over `before` ids not in `after` → `removed`. `campaign_core` is attached only when
`campaign` or `codex` differ.

**Byte-parity note (the program's flagged risk).** The TS diff detects "changed" via
`JSON.stringify(b) !== JSON.stringify(a)` and pushes entities in `after`-array order. In Rust we get
the *same classification* with **structural equality** on the snapshot types (`PartialEq`), provided:
(1) we iterate `after` in array order (so the delta arrays are ordered identically), and (2) the
snapshot serialization is canonical — which it already is, because serde serializes struct fields in
declaration order and `to_snapshot` is gated to TS parity. We therefore **do not** replicate JS
`JSON.stringify` semantics; we rely on the existing snapshot-parity guarantee plus after-order
iteration. This is the single most important correctness argument in B and gets its own gate (below).

### `SyncAuthority`

Port `authority.ts` onto `World`:

```
submit(command) -> SubmitResult:
  auth = Resolver::authorize(&world, &command)      // A-owned gate
  if !auth.ok: return denied(auth.reason)
  before = world.to_snapshot()                       // pre-image
  match apply_command(&mut world, &command, ...):    // A-owned dispatch
    Err(ProceduralViolation) => world = World::from_snapshot(before); return denied(msg)
    Ok(()) => {}
  after = world.to_snapshot()
  delta = DeltaComputer::diff(&before, &after)
  seq = head + 1
  log.push(LogEntry { seq, base_seq: seq-1, command, delta })
  if seq % snapshot_every == 0 { checkpoint = (seq, after) }
  committed(seq, delta)
```

Restore-on-violation exactly mirrors the oracle: a rejected apply re-hydrates `world` from the
pre-image so the authoritative state is never half-mutated (the Rust path is cheaper — no full
`deserializeCampaign`, just `from_snapshot(before)`). `head()`, `load_snapshot()`, and
`entries_since(from_seq)` match the oracle. Constructor opts: `snapshot_every` (default 20),
`start_seq` (default 0), the injected `rng`.

**Naming:** call it **`SyncAuthority`** to disambiguate from the single-player engine `Authority`
(`wickedways-wasm/src/authority.rs`) — the program design flags this collision explicitly.

### `Resolver::apply` reuse

The oracle's `resolver.apply` resolves arg ids to live instances then invokes engine actions. In Rust
the engine already resolves ids internally (`apply_command` in `world/command.rs` takes ids and looks
them up), so B does **not** need a separate `EntityIndex` type — `World`'s internal lookup is the
index. B's job is only the **authorize gate** (`Resolver::authorize`), a pure function of
`(world, command)` returning `AuthResult = Ok | Err(reason)`, porting the started/finished/active-actor
/ setup / join / GM branches verbatim from `resolver.ts:30`.

### `DeltaApplier::apply` (the `Replica` path)

Port the two-pass applier. The Rust core already has hydrate/`from_snapshot` machinery; the applier
patches a replica `World` in place:

1. **Pass 1** — construct `created` entities in id-resolvable order (item → materialCache → loot →
   room → character), and re-hydrate ref-free `changed` ones (item, materialCache) in place.
2. **Pass 2** — wire cross-references for created ∪ changed loot/rooms/characters.
3. **`campaign_core`** — apply catalog, core, codex (carry the applier's ordering caveat re:
   `HYDRATE_CATALOG` vs. character hydrate as a code comment).
4. **`removed`** — a near-no-op; removal is effected by the changed holder's collection reset.

Never runs game logic, never draws rng — replicas trust the ordered log. This is the operation that
makes "one implementation, structural convergence" real.

### `SyncCoordinator` + transport

Port `coordinator.ts` and `transport.ts`:

- **`SyncTransport`** trait — `head()`, `submit(cmd) -> SubmitResult`, `entries_since(from)`,
  `subscribe(from, handler) -> unsubscribe`, `load_snapshot()`.
- **`InProcessTransport`** — wraps a `SyncAuthority`, fans committed entries to subscribers. This is
  the single-player / test host; the WebSocket transport is sub-project D (client) / C (server).
- **`SyncCoordinator`** — owns the local replica `World`; `join` hydrates from the transport's
  snapshot + deltas-since; `submit` forwards to the transport and fast-forwards on the returned seq;
  `#on_remote` / `#sync_to` apply in-order and heal gaps by re-syncing to head. No optimistic
  mutation, no rollback.

The async surface: `submit` is `async` in TS. For the in-process/native path it can be synchronous;
the trait should express `submit` as returning a future (or a `Result` for in-process) so the
WebSocket transport in C/D can be genuinely async. Model it to match how the WASM `Replica` will be
driven from JS.

## Dependency on sub-project A

B cannot be *fully* exercised without A, because the differential gate submits real commands. The
exact A surface B needs:

- **The actor-tagged `Command` union** (mirror `src/lib/sync/types.ts:20`) + classifiers
  (`command_actor_id`, `is_turn_action`, …). This is a **hard prerequisite** even for the MVP.
- **Engine-action bindings** for each command kind. The core already supports a *subset*: `move`(go),
  `attack`, `equip`, `unequip`, `use`, `pickUp`/`drop`(take/drop_item), `beginCampaign`,
  `endCampaign`, `nextPlayer`. It is **missing**: `craft`, `repair`, `harvest`, `takeFromLootBox`,
  `putInLootBox`, `transferKey`, `consumeKey`, `placeLight`, `takeLight`, `selectArchetype`,
  `leaveCampaign`, `transferGM`, `mobEscape` (verified against `crates/wickedways-core/src/world/`).

### MVP framing — B proceeds on the supported subset

B does **not** wait for all of A. Stand the entire sync core up against the **command subset the core
already supports**, gated against the frozen oracle restricted to those commands, then let A widen the
vocabulary and the gate grows with it. Concretely: the minimal A-prereq (the `Command` union + the
authorize gate) lands first; B builds `SyncAuthority`/`Delta`/`Replica`/transport on top and is
gated over move/attack/equip/unequip/use/pickUp/drop/begin/end/nextPlayer; the remaining ~13 engine
actions arrive in A-remainder and each simply extends the same differential corpus.

## The differential gate

The acceptance criterion is byte-parity with the frozen TS oracle, using the established conformance
pattern (record TS-oracle output as committed goldens; replay in Rust):

1. **Delta goldens.** For a corpus of `(genesis, command)` pairs, the TS `DeltaComputer.diff` /
   `Authority.submit` output (the `Delta` JSON) is committed as the oracle; the Rust `SyncAuthority`
   must reproduce it — same `created`/`changed`/`removed` membership **and order**, same
   `campaignCore` presence.
2. **Log & sequencing.** A recorded command *sequence* against a genesis yields a `LogEntry[]`
   (seq/baseSeq/delta) the Rust authority must reproduce entry-for-entry, including the
   restore-on-violation cases (a denied command advances nothing).
3. **Replica convergence.** Applying the Rust authority's own deltas through the Rust `DeltaApplier`
   into a fresh replica must yield a `to_snapshot()` **identical** to the authority's — the structural
   convergence guarantee, checked as a snapshot equality after each step.
4. **Authorize parity.** The `authorize` verdict (ok / denied + reason) for each command matches
   `resolver.ts` across the started/finished/active-actor/setup/join/GM branches.

The existing sync `.test.ts` (authority/resolver/coordinator/delta-computer/delta-applier/
entity-index/transport/types) are the behavioral spec these goldens are derived from. Follow the G2
oracle convention (a TS twin emits committed JSON; the Rust twin must match) and wire the gate into
the workspace test run.

## Constraints held

- **No `compile()`/engine signature churn** beyond adding the sync module; the single-player
  `Authority` (WASM) is untouched.
- **Serializable-only seam** (invariant 4) — `Command`/`Delta`/`LogEntry` cross the wire as
  serde/ts-rs generated types; the transport relays them opaquely.
- **Determinism** — the applier draws no rng; the authority's rng is the injected stream, so a replay
  is bit-reproducible.
- **Panic-free on hostile input** — a malformed/illegal command is a `denied` `SubmitResult` or an
  `authorize` rejection, never a panic (carried from the G2 author boundary discipline; the
  restore-on-violation path guarantees no half-mutation).
- **The frozen oracle is deleted LAST (program step F)** — never within B. B is gated *against*
  `src/lib/sync/`, so removing it here would blind the port.

## What this unblocks

- **C (axum server)** — hosts a `SyncAuthority` behind a WebSocket `/ws` upgrade; `Table` +
  `Membership` sit on top.
- **D (Dioxus client)** — drives a WASM `Replica`/`SyncCoordinator` over a WebSocket transport.

## Next step

Write the **sub-project A** spec (or the minimal A-prereq: the actor-tagged `Command` union +
authorize gate + engine-action bindings for the supported subset) so B's MVP has its prerequisite,
then plan B's slices: (1) boundary types + `DeltaComputer` + delta goldens; (2) `SyncAuthority` +
log/sequencing gate; (3) `DeltaApplier` + convergence gate; (4) `SyncCoordinator` +
`InProcessTransport`.
