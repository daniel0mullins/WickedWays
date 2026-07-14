# Rust Phase 2c — Multiplayer port + Dioxus web client (program design)

**Date:** 2026-07-14
**Status:** design (program umbrella)
**Predecessor:** G2 TOML author + full Hollow House re-author (capstone), merged via PR #68.
**Master design:** [`2026-06-30-rust-engine-core-design.md`](./2026-06-30-rust-engine-core-design.md)
**Program table origin:** [`2026-07-09-rust-campaign-assembler-design.md`](./2026-07-09-rust-campaign-assembler-design.md) (§ Program context, the A–F breakdown)
**Deployment consumer:** [`2026-07-10-pr-preview-deployments-design.md`](./2026-07-10-pr-preview-deployments-design.md)

## Context

The Rust migration has finished its **single-player** half. The engine (`wickedways-core`), the
assembler (`wickedways-assemble`, G1), the TOML author (`wickedways-author`, G2 + the byte-for-byte
Hollow House capstone), and the Phase-2 single-player WASM cutover all exist and are gated. What is
**still entirely TypeScript** is the multiplayer stack: the sync layer (`src/lib/sync/`), the room
server (`packages/server/`), the multiplayer client (`packages/client/`), and chat/AV.

The master roadmap named this remaining work **Phase 2c** but only ever described it as "a separate
later spec (2c)." The assembler design later decomposed 2c into sub-projects **A–F** with a Dioxus
client — but as a bullet list inside another document, not a standalone program spec, and written
before the single-player cutover had landed (so its A row is now stale). This document is the missing
**Phase 2c program design**: it sets the endgame, reconciles the A–F breakdown against what the
cutover already delivered, fixes the shared architecture and invariants, sequences the sub-projects,
and leaves each one ready to be spec'd → planned → implemented on its own.

Two scoping decisions bound this program:

1. **This is the umbrella, not a sub-project dive.** Each of A–F gets its own spec/plan/impl cycle;
   this document coordinates them.
2. **Dioxus is web-first.** The client target for this program is the Dioxus **web** app served by
   the axum fullstack binary. Native desktop packaging is **deferred to a later phase** — noted here
   because it diverges from the assembler design, which cited native desktop clients as the *deciding
   constraint* for choosing Dioxus over egui. That rationale still holds (Dioxus keeps the door open),
   but native is out of scope for 2c.

## Endgame & decisions already taken

- **Rust everywhere** — engine, server, and client. TypeScript survives **only** as a frozen
  conformance oracle until the goldens replay against Rust, then is deleted (step F).
- **One client, Dioxus.** DOM/CSS carryover keeps the campaign-owned theming that the CRT and
  point-and-click surfaces rely on. Web-first now; native desktop later.
- **Campaign assembly is both** a CLI (authoring, CI validation) and a runtime library call
  (modding) over one crate — delivered in G1/G2.
- **Behavior surface = TOML + a small expression language**, compiling to the fixed `BehaviorScript`
  AST — delivered in G2.

## Architecture

### One core, two roles

The same `wickedways-core` crate compiles to both sides of the wire, so replica convergence is
**structural**, not a test target: there is one implementation of hydration, delta application, and
view projection.

- **`Authority`** (server + single-player) — resolves commands, mutates state, computes deltas.
  Native on the server (or WASM-in-Node during transition); WASM in the single-player runtime.
- **`Replica`** (multiplayer client) — applies authoritative deltas and projects views. Never
  resolves commands locally (no optimistic mutation, no rollback).

### The fullstack shape

Per the PR-preview design, the server target is a single **axum + Dioxus-fullstack** binary on one
`PORT` that both serves the Dioxus web app (bundled WASM + static assets) and handles the multiplayer
**WebSocket** endpoint (e.g. `/ws`) via an axum WS upgrade. The browser opens its socket
**same-origin** (`wss://<host>/ws`, scheme/host derived from `window.location`). Default store is
ephemeral in-memory. Landing this binary is what **unblocks the deferred PR-preview deployment work**.

### The boundary stays opaque and serializable

The wire layer (`packages/transport-shared`) already treats `command`/`delta`/`snapshot` as **opaque**
payloads — the server orders and relays them without engine knowledge. The Rust port preserves that:
only the engine and the surfaces know the concrete `Command`/`Delta`/`ViewModel` types; the transport
relays bytes. The seam is serializable-only (master-design invariant 4), via serde + ts-rs generated
boundary types.

## Current-state reconciliation

The single-player cutover moved more into the core than the original A–F table assumed. This changes
what each sub-project actually has to build.

| Capability | Status in Rust today | Where |
| --- | --- | --- |
| Engine `Command` vocabulary (actions + lifecycle ops) | ✅ built — but single-seat, no actor id, and only live behind the conformance-gated `replay_commands` harness | `crates/wickedways-core/src/world/command.rs` |
| Party + turn/round loop (`party_ids`, `active_character_index`, `acted_this_round`, `next_player`/`end_round`) | ✅ built — but a **solo-GM, one-human** model | `crates/wickedways-core/src/world/turn.rs` |
| WASM `Authority` (`submit(Intent)`, `view`, `snapshot`/`restore`, cues) | ✅ built — single-player, returns `ExecuteResult` (cues), **no delta/log** | `crates/wickedways-wasm/src/authority.rs` |
| **Networked seats** (character↔identity ownership, join/leave/GM, gating by remote identity) | ❌ absent | — |
| **Actor-tagged command union** (every turn-action carries `actorId`; setup/GM/mob arms) | ❌ absent (the *real* multiplayer union is TS `src/lib/sync/types.ts`) | — |
| `Delta` (state diff), append-log / `LogEntry` / `entries_since`, `Replica`, `SubmitResult` | ❌ absent anywhere in `crates/` | — |
| Room server, chat, A/V, persistence | ❌ TypeScript (`packages/server`), running the **TS sync `Authority`**, not the Rust WASM one | — |

**Two `Command` types — do not conflate.** The core `Command` (`command.rs`, and the `intent.rs`
header that documents the split) is *internal single-seat dispatch*. The genuine multiplayer command
protocol is the TS `Command` union in `src/lib/sync/types.ts`, where every turn-action carries an
`actorId` and there are additional `selectArchetype` / `joinCampaign` / `leaveCampaign` / `transferGM`
/ `mobEscape` / `mobAttack` / `beginCampaign` arms. Sub-project A is about *that* union and the seat
model behind it — not re-deriving the action vocabulary, which already exists.

## Sub-project decomposition (A–F)

Each row is its own spec → plan → implementation cycle. "Oracle" is what proves correctness.

| # | Sub-project | Scope | Oracle | Done when |
| --- | --- | --- | --- | --- |
| **A** | **Networked multi-seat** | Actor-tagged `Command` union; seat↔identity ownership; join/leave/GM transfer; command gating by remote identity. Builds on the existing core party/turn loop and action vocabulary. | TS `Campaign` + `src/lib/sync/types.ts` classifiers (`isTurnAction`/`isSetupCommand`/`isGmCommand`/`commandActorId`) | The seat/ownership model + actor-tagged commands resolve identically to the TS authorize path |
| **B** | **Rust sync core** | `Authority` (authorize → apply → diff → commit) + ordered append-log; `Delta` (diff/apply pair); resolver **authorize gate**; `Replica`; transport trait. | **Frozen `src/lib/sync/*.ts`** (~819 LOC, 8 files) + its `.test.ts` behavioral goldens | Differential: same seed + command sequence → identical `Delta`s, log, and projected `ViewModel` as the TS oracle |
| **C** | **axum room server** | Per-campaign `Table` over a Rust `Authority`; `Membership` (seats/presence); WebSocket relay; SQLite persistence; flush-before-ack commit. | Conventional: `server.test.ts` / `table.test.ts` / `membership.test.ts` + wire parity vs `transport-shared` | The Rust server passes the ported server/table/membership tests and speaks the existing wire protocol |
| **D** | **Dioxus web client** | Reproduce `packages/client` multiplayer wiring (`websocket-transport`, coordinator use) **and** re-render the CRT + point-and-click surfaces (retiring the Lit surfaces at parity) + launcher/save/audio glue. **Native desktop deferred.** | e2e + visual parity against the Lit surfaces | The Dioxus web app reaches multiplayer + single-player parity with the Lit/TS client |
| **E** | **Chat + A/V** | Port server-side `Chat`/`Call` (relay-only signalling) + client `ChatClient`/`CallClient` (WebRTC full mesh). | Conventional: chat/call tests + wire parity | Chat + A/V work end-to-end over the Rust server / Dioxus client |
| **F** | **Retire TypeScript** | Delete `src/lib/…` (engine oracle) + `src/lib/sync/` (sync oracle) + the ported `packages/*`. | — | The frozen oracles are gone and only Rust remains; all goldens still pass against Rust |

### The frozen sync oracle (B, in detail)

`src/lib/sync/` is the single source of truth B must reproduce:

- `authority.ts` — `submit()` = authorize → apply → diff → commit; holds the live `Campaign`, an
  ordered `LogEntry[]`, and a periodic snapshot; snapshots *before* apply and restores on
  `ProceduralViolation` so state never half-mutates.
- `resolver.ts` — `authorize()` (the game-rule gate: started/finished/active-actor/GM/setup checks →
  `{ok}` / `{ok:false, reason}`) + `apply()` (resolve arg ids to live instances, invoke engine
  actions). Deeper validation is deferred to the engine's own `ProceduralViolation` guards.
- `entity-index.ts` — transient `id → live-instance` map over the party-reachable graph.
- `delta-computer.ts` — `diff(before, after)`: per-collection created/changed/removed classification
  over two full `CampaignSnapshot`s.
- `delta-applier.ts` — `apply(replica, delta)`: two-pass patch (construct in id-resolvable order, then
  wire cross-references); never runs game logic, never draws rng.
- `coordinator.ts` — `SyncCoordinator`, the replica: submits to a transport, applies broadcast deltas,
  never optimistically mutates.
- `transport.ts` — `SyncTransport` interface + `InProcessTransport` (single-process). The WebSocket
  transport lives in `packages/client`.

## Sequencing & the critical constraint

`src/lib/sync/` is the **only** oracle for `Authority`, `Delta`, and the resolver's authorize gate.
Therefore **deleting the TS sync layer must be step F (last)** — never folded into B. If B deletes its
own oracle it is ported blind. Precedent: `conformance/fixtures/oracle-session.ts` is a frozen copy of
the pre-cutover `GameSession` kept alive precisely so the cutover could be gated against it.

Rough order: **A → B → C → D → E → F.** A and B are tightly coupled (the seat/command model and the
sync core) and may share a spec boundary; C depends on B; D depends on C's wire protocol; E can
overlap D once the server relay (C) exists; F is terminal and only runs once every golden replays
against Rust.

## Invariants held

- **Determinism is both an invariant and the safety mechanism.** The differential harness drives the
  frozen TS oracle and the Rust core with the same seed + command sequence and asserts identical cues,
  deltas, and resulting `CampaignSnapshot`. A scope is "done" only when it passes.
- **Structural convergence.** One crate on both sides ⇒ one implementation of hydrate/apply/view ⇒ the
  replica cannot diverge from the authority.
- **Serializable-only seam** (invariant 4) — no live-object boundary; JSON/serde across the wire.
- **Panic-free author boundary** carried forward from G2 (hostile campaign input yields `CompileError`,
  never a panic).

## Risks / open questions

- **Delta byte-parity vs `JSON.stringify` ordering.** `DeltaComputer.diff` classifies "changed" by
  `JSON.stringify` inequality, and `Chat.react` detects change the same way. The Rust port must
  preserve serialization field order (or move to structural/field-level equality) or its deltas will
  differ from the oracle even when semantically identical. This is the single biggest parity hazard in
  B/E — call it out in B's spec.
- **Delta shape: faithful port vs. master-design variant.** The master design sketched folding delta
  computation into `Authority.submit → SubmitResult { delta }`. The **decision for 2c is the faithful
  frozen-oracle port**: mirror the TS snapshot-diff `Delta` format so B is gated byte-for-byte against
  `src/lib/sync/`. A cleaner `SubmitResult`-integrated design, if wanted, is a *post-F* refactor once
  the oracle is gone.
- **The two-`Authority` naming hazard.** "Authority" means the single-player WASM engine handle
  (`authority.rs`) **and** the multiplayer sync authority (`src/lib/sync/authority.ts`). Specs and code
  must disambiguate (e.g. `SyncAuthority` vs the engine `Authority`) to avoid wiring the wrong one.
- **Client surface scope.** How much of `play-runtime` (audio subtree, themes, savestore, launcher)
  carries into Dioxus vs. is rebuilt is a D-spec question; the CRT + PnC visual parity bar is the
  constraint.

## Out of scope / what remains

- **Native desktop** Dioxus packaging — deferred to a later phase.
- The **throwaway Dioxus spike** (one CRT-styled screen, web + native, validating CSS carryover and
  the native link) — no spec, no plan, deleted after; nothing here depends on its outcome.
- **PR-preview deployments** — already specced; unblocked (not performed) when the axum + Dioxus
  fullstack server lands on `main`.
- The PHP marketing page (`landing/`).

## Next step

Write the **sub-project B** spec (Rust sync core) — or a combined **A+B** spec if the seat/command
model and the sync core are taken together — via the `writing-plans` flow. A's core primitives (action
vocabulary, party/turn loop) already exist, so the first real implementation work is the actor-tagged
command union + seat model (A) feeding the `Delta`/log/`Replica` layer (B), gated against the frozen
`src/lib/sync/` oracle.
