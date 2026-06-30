# Rust Engine Core

**Status:** Design approved, ready for implementation plan
**Date:** 2026-06-30

## Goal

Re-author the game engine (`src/lib/...`) as a **Rust core** compiled to **WASM** (for the browser
and Node) and to **native** (for the server, and to keep an embedded target open later). The
TypeScript play surfaces, networking, and session hosting stay in TypeScript as thin shells over
the core.

The driver is *not* performance. It is that a large fraction of this engine's design is **manual
enforcement, in TypeScript, of guarantees Rust enforces natively** — ownership seams
(`CLAIM`/`HELD_BY`), lifecycle guards (`ProceduralViolation`), branded ids, a hand-rolled
hydration/serialization subsystem, and an injected-rng determinism discipline. Moving the core to
Rust turns those runtime disciplines into compile-time and language-level guarantees, gives one
deterministic implementation that runs identically on server and client, and unifies saves,
snapshots, and sync-deltas behind a single serde format.

This spec covers the **target architecture, the engine/host boundary, and the migration strategy**.
It does not enumerate the line-by-line port of every module — that belongs in the implementation
plan(s) that follow.

## Invariants

These are the standing rules the refactor must preserve. They are the acceptance criteria the
design is judged against.

1. **One source of truth for all typings.** Every type that crosses the boundary (`Intent`,
   `Command`, `ViewModel`, presentation cues, `Delta`, `CampaignSnapshot`, `LogEntry`) is defined
   **once**, in Rust, and the TypeScript form is generated from it.
2. **All engine concerns are contained completely within the engine.** Rules, state, legality,
   combat math, mechanics, delta computation, and serialization live in the core. Nothing that
   decides game outcomes lives in a host shell.
3. **Determinism is a hard contract.** The same seed + the same command sequence produces
   byte-identical cues and snapshots on every target (browser, Node, native) and in every role
   (authority and replica). No wall-clock, no ambient randomness, no platform-dependent numeric
   behavior in the core; every source of nondeterminism is injected (`rng`, and any clock). This
   is the keystone: it is simultaneously what makes the conformance-diff migration possible and
   what makes multiplayer replica convergence correct. The engine **enforces** this structurally
   for all first-party and hosted/scripted ops (one interpreter, in one core, on every peer). For
   self-hosted native plugins it cannot enforce purity of arbitrary Rust, so determinism becomes a
   **contract the plugin author must uphold** within their own deployment; a plugin that breaks it
   desyncs only that author's own game, never the canonical service.
4. **The boundary carries only serializable data — never live objects.** Across the WASM seam, in
   both directions, only plain serializable values cross. Surfaces and transport never hold an
   engine handle.
5. **The core is host-agnostic (`no_std`-friendly).** The engine crate assumes nothing about JS,
   the DOM, the web, threads, time, or I/O. Everything external — rng, clock, persistence,
   transport — is injected. This keeps the embedded door open and the core trivially testable.
6. **Engine emits intent; surfaces own presentation (bidirectional).** The engine never decides
   display text, color, layout, or which sound file plays — it emits cues and viewmodel data
   carrying asset *refs*. The surface never decides rules or legality. This is what keeps
   `parser.ts` and `narrator.ts` surface-side.
7. **Generated bindings are build artifacts, never hand-edited.** The TS types for boundary types
   are generated from the Rust types and CI fails if the checked-in output drifts from a fresh
   generation.

## Resolved design decisions

Settled during brainstorming; recorded here so they are not re-litigated, with rationale captured
in the relevant sections below.

- **Campaigns are data; ops are extensible at two trust tiers ("A2 + extensibility").** Campaign
  structure is declarative data; mechanics are ops selected by key from a Rust-defined registry and
  parameterized by config. Extensibility has **two tiers**: **(1) hosted / untrusted** — authors
  submit campaigns (structure + sandboxed scripts) to the canonical service, and a built-in
  `ScriptedMechanic` op interprets those scripts under a deterministic, capability-limited sandbox;
  **(2) self-hosted / native** — the `MechanicOp` trait + registry is a public, stable extension
  point; authors depend on the `wickedways-core` crate, implement native Rust ops, compile their own
  core (native + WASM), and run their own deployment, accepting full responsibility for determinism
  and safety. **Third-party native code never runs on the canonical service.** See
  [Extensibility](#extensibility-third-party-ops).
- **One core, two roles ("Option 1").** A single Rust crate serves both the **authority** role
  (server + single-player: resolves commands, computes deltas) and the **replica** role
  (multiplayer client: applies deltas, projects view models). The client runs the same core as a
  WASM replica. See [Multiplayer](#multiplayer-one-core-two-roles).
- **Saves, snapshots, and sync-deltas share one versioned serde format.** The hand-rolled
  `serialization/` subsystem (`[HYDRATE]` symbols, `HydrateContext`, `constructBare*`) is replaced
  by `#[derive(Serialize, Deserialize)]`.
- **Parity-gated cutover.** No consumer points at the Rust core until it passes the conformance
  gate for its scope. See [Migration](#migration-strategy).
- **Type generation via `ts-rs`; boundary marshalling via `serde-wasm-bindgen`.** JSON-string
  marshalling is an acceptable first cut (turn-based has no perf pressure); `serde-wasm-bindgen`
  is the target for ergonomics. Either way the boundary stays serializable-only (invariant 4).

## Background: current state

The boundary the surfaces consume is **already a serializable-DTO message bus**, which is why this
migration is tractable. Two exploration passes established the following.

**The play boundary (`packages/play-runtime`).** Surfaces talk to a `GameSession` facade:
`execute(intent) → { cues, mobAttacks }`, `view() → ViewModel`, `read(itemId)`,
`takeStartupCues()`, `save/restore/undo()`. Everything crossing is plain data: `Intent` (a tagged
union) in; `ViewModel` (plain DTO of `ScopeEntity[]`, room, exits, status) and
`PresentationCue[]` out. Surfaces never call methods on a live `Item` or `Character`. Cues are
**buffered and returned** from `execute()` (via the engine's `[EMIT_CUE]` seam), not pushed to a
live callback — which is exactly the shape a synchronous WASM call wants.

**The one boundary violation to fix.** The CRT controller calls
`audio.update(session.campaign)` — the single place a surface reaches into a live engine object.
This must be re-expressed as DTO state (an audio field on the `ViewModel`, or driven off the
`sound?: AssetRef` already carried on cues), because `session.campaign` will not be a live JS
object after the migration. This is invariant 4's concrete debt.

**The mechanics framework (`src/lib/mechanics`).** A "mechanic" is an object with **6 fixed hook
points** (`onRoundStart/End`, `onTurnStart/End`, `onAction`, `modifyDamage`) returning effects from
a **closed set of 6 kinds** (`Damage`, `Heal`, `AdjustStat`, `GrantImmunity`, `Cue`, `Status`). A
mechanic sees only a **read-only `CampaignView`**, persists a plain JSON state object, and **cannot**
mutate engine state directly, read privileged state, schedule, talk to other mechanics, or spawn
objects. All five real mechanics (3 in Hollow House, 2 in tests) fit one shape: trigger → condition
→ emit effect(s) → optionally mutate own JSON state. Selection is already a keyed registry
(`registerMechanic(key, impl)` + `.useMechanic(key, config)`). This is the evidence behind A2: the
system is **already** a fixed registry of parameterized ops, written in TS.

**The sync subsystem (`src/lib/sync` + `packages/{client,server,transport-shared}`).**
Server-authoritative, single source of truth, strict replica convergence (no optimistic updates).
The **wire protocol treats `command` and `delta` as `unknown`** — the networking layer is already
game-logic-agnostic. The authoritative loop is authorize → apply → diff → commit; the client holds
a live replica and applies authoritative deltas.

## Target architecture

### Workspace topology

A new Rust core crate (plus its WASM binding crate) sits beneath the existing TS packages. The TS
packages keep their names and public shapes; their *internals* become thin wrappers over the core.

| Unit | Language | Role |
|---|---|---|
| `wickedways-core` **(new crate, published)** | Rust, `no_std`-friendly | The engine: entity model, campaign turn loop, combat/mitigation, items/equipment/durability, loot/crafting, status/afflictions, mobs/encounters, codex, the mechanics op-registry, the authority/resolver/delta logic, and one serde serialization format. All randomness/time injected. Knows nothing about JS or the web. Exposes the public `MechanicOp` trait + registry as a **stable extension point** for self-hosters, and ships a sandboxed scripting interpreter behind a built-in `ScriptedMechanic` op (gated by a `scripting` cargo feature so `no_std`/embedded builds can drop it). |
| `wickedways-wasm` **(new crate)** | Rust → WASM | The binding layer: `wasm-bindgen` exports for the authority and replica roles, `serde-wasm-bindgen` marshalling, and `ts-rs` derives that emit the TS type declarations. Native builds skip this crate. |
| `wickedways` (TS package) | TS (generated + binding) | Becomes (a) the **generated** boundary types (from `ts-rs`) and (b) the loaded WASM module plus a low-level binding exposing the `Authority`/`Replica` handles. `src/lib/...` engine source is deleted at end of migration. |
| `@wickedways/play-runtime` | TS | `GameSession` facade (delegating `execute`/`view`/`save` to the `wickedways` WASM binding), audio runtime, launcher, contracts. Imports generated boundary types. Unchanged in public shape. |
| `@wickedways/play-surface*` | TS (Lit) | CRT + PnC surfaces, `parser.ts`, `narrator.ts`. **Unchanged** — they already speak DTOs. |
| `@wickedways/campaigns` | data + thin loader | Campaigns become declarative data validated against the Rust schema, plus a tiny loader. Hosted-tier campaigns may include sandboxed scripts (content-hashed + authority-pinned). (Authoring-format detail in implementation plan.) |
| `transport-shared`, `client/websocket-transport`, `server/*` | TS | **Unchanged.** Wire stays opaque; server hosts the native/WASM authority; client hosts the WASM replica. |

### What moves to Rust vs stays TS

| Moves to **Rust core** | Stays **TypeScript** |
|---|---|
| Entity model: character hierarchy, rooms, exits, items, equipment, loot, material caches, codex | Lit components, controllers, themes |
| Campaign turn loop, victory/outcome resolution | `parser.ts` (command string → `Intent`), `narrator.ts` (cues → text) |
| Combat, mitigation math, dice (`roll`), stats | Audio runtime (fed DTO cues + viewmodel) |
| Status effects, afflictions, immunity | Launcher, surface picker, save-store persistence (bytes in/out) |
| Mechanics framework + op registry (A2) | `SyncTransport` interface + `InProcessTransport`, `SyncCoordinator` (thin wrappers over WASM) |
| Authority, resolver (authorize + dispatch), delta compute/apply, entity index | `transport-shared` wire protocol, `websocket-transport`, `server/*` (table, membership, chat, A/V, persistence) |
| Serialization (saves = snapshots = deltas), one serde format | Generated boundary `.d.ts` (artifact, not authored) |

### Boundary types (single source of truth)

Defined once in `wickedways-core`, `#[derive(Serialize, Deserialize, TS)]`, generated to TS:

- **Inbound:** `Intent` (single-player), `Command` (multiplayer) — internally-tagged enums
  (`#[serde(tag = "kind")]`) that reproduce today's `{ kind, ... }` discriminated unions 1:1.
- **Outbound:** `ViewModel` (+ `ScopeEntity`, `ExitView`, …), `PresentationCue` (the 6-variant cue
  union), `Delta` (+ `EntitySnapshot`), `CampaignSnapshot`, `LogEntry`, `SubmitResult`.

The wire layer (`transport-shared`) continues to treat `command`/`delta` as opaque; only the engine
and the surfaces import the generated types.

## Component design

### The core crate shape

`wickedways-core` exposes a small surface, role-shaped:

```rust
// Authority role: server + single-player. Resolves commands, mutates state, computes deltas.
impl Authority {
    fn new(genesis: CampaignSnapshot, opts: AuthorityOpts /* rng seed, registry */) -> Self;
    fn submit(&mut self, command: &Command) -> SubmitResult; // authorize → apply → diff → commit
    fn view(&self) -> ViewModel;
    fn head(&self) -> u64;
    fn snapshot(&self) -> CampaignSnapshot;
    fn entries_since(&self, from_seq: u64) -> Vec<LogEntry>;
}

// Replica role: multiplayer client. Applies authoritative deltas, projects views. Never resolves.
impl Replica {
    fn from_snapshot(snap: CampaignSnapshot, opts: ReplicaOpts) -> Self;
    fn apply(&mut self, delta: &Delta);
    fn view(&self) -> ViewModel;
}
```

Single-player is the authority role with an `InProcessTransport`-equivalent wrapper; `GameSession`
delegates `execute(intent)` to a local `Authority`. The giant TS `resolver` switch becomes a
`match` on the `Command`/`Intent` enum inside `submit`; `EntityIndex` becomes internal id-lookup;
the three TS files (`authority`/`resolver`/`entity-index`) collapse into one cohesive module.

### Mechanics: A2 (data + first-party op registry)

The 6-hook / 6-effect / read-only-view contract becomes a Rust trait; ops are first-party `impl`s
registered by key. Campaigns select and configure them as data — never code.

```rust
trait MechanicOp {
    fn init_state(&self, config: &Config) -> State;          // State: serde JSON value
    fn on_round_start(&self, cx: &HookCtx) -> Vec<Effect> { vec![] }
    fn on_turn_start(&self, cx: &TurnCtx) -> Vec<Effect> { vec![] }
    fn on_action(&self, cx: &ActionCtx) -> Vec<Effect> { vec![] }
    fn modify_damage(&self, d: DamageView, cx: &HookCtx) -> TransformResult { d.into() }
    // … on_round_end, on_turn_end, custom actions
}
```

`HookCtx` exposes only the read-only `CampaignView` + injected `rng`. `Effect` is the closed
6-variant enum. The five known future-blockers (spawn object, privileged reads, scheduling,
inter-mechanic comms, non-effect mutation) are handled by **extending the `Effect`/hook enum or
adding an op** — a controlled engine change. Authors extend the *set of ops* through the two tiers
described next; they never widen the capability surface an op is handed.

### Extensibility: third-party ops

Third parties extend the engine through the **same `MechanicOp` registry**, at two tiers split by
the trust boundary. The capability contract (read-only `CampaignView` + injected `rng` in, `Effect`s
out) is **identical** at both tiers — extensibility changes *who authors an op*, never *what an op
can reach*.

**Tier 1 — hosted / untrusted (scripting).** The canonical service ships one built-in op,
`ScriptedMechanic`, that interprets author-submitted scripts (Rhai) against the op contract.
Untrusted strangers submit campaigns = declarative structure data + scripts. Safety properties:

- **Sandbox by construction** — the script can call only the curated API the host registers (the
  `CampaignView` accessors + `Effect` constructors). No filesystem, network, clock, or host access.
- **Determinism is structural** — the interpreter is pure Rust compiled into the one core, so the
  server authority and every browser replica interpret identically. Bounded by an operation-count
  limit (and call-depth / allocation limits) so a script cannot hang or exhaust a peer.
- **Version-lock** — submitted scripts are content-hashed; the authority pins the op-set for a
  campaign, and clients verify they hold byte-identical script definitions before joining. Combined
  with "same core build on every peer," replicas cannot diverge.

This is the only third-party code the canonical service ever executes.

**Tier 2 — self-hosted / native (Rust plugin).** The `MechanicOp` trait + registry is a public,
stable, documented API in the published `wickedways-core` crate. An author depends on the crate,
implements native ops, registers them, and compiles **their own** core — native for their server
**and** WASM for their players' browsers — then runs their own deployment.

- **Power with owned risk** — native ops are arbitrary Rust, so they can do more than a script, but
  the engine cannot enforce their purity. Per invariant 3, determinism is a **contract the author
  upholds**; if they break it, only *their own* deployment desyncs or corrupts saves.
- **Never on the canonical service** — the user's hosted service runs only the canonical build
  (first-party ops + `ScriptedMechanic`); it never loads third-party native code. The trust problem
  is therefore structurally absent, not mitigated.
- **Distribution is the author's** — "same compiled core on server + clients" is something the
  self-hoster controls within their deployment, exactly as the canonical service does for its own.

Deeper modification than the op registry (new entity types, new hook points, new `Effect` kinds) is
possible because self-hosters have the source — but that is *forking*, not a supported plugin API.
The **supported** native extension surface is the `MechanicOp` registry.

### Multiplayer: one core, two roles

The wire format is serialized Rust types; the transport relays them opaquely (unchanged). Because
**the same crate compiles to both sides**, replica convergence is structural: there is one
implementation of hydration, delta application, and view projection, so the client cannot diverge
from the server. Determinism (invariant 3) makes this a guarantee rather than a test target.

- **Server:** native `wickedways-core` `Authority` (or WASM in Node). `Table.submit` calls
  `authority.submit(command)`; broadcasts the resulting `Delta` over the existing protocol.
- **Client:** WASM `Replica`. `SyncCoordinator` loads the snapshot into a `Replica`, applies
  inbound deltas, and projects `ViewModel`s for the surfaces. It never resolves commands locally.

### Data flow

**Single-player render/action loop (unchanged for the surface):**
```
player input → parser → Intent → GameSession.execute(intent)
  → [WASM] Authority.submit → cues buffered + state mutated
  → ExecuteResult { cues } → narrator renders, GameSession.view() → ViewModel → Lit render
```

**Multiplayer:**
```
client: Intent → Command → coordinator.submit → transport → server
server: Authority.submit → Delta → broadcast (opaque)
client: transport → coordinator → [WASM] Replica.apply(delta) → Replica.view() → ViewModel → render
```

## Determinism & the conformance harness

Determinism is both an invariant and the migration's safety mechanism. A **differential harness**
drives the legacy TS engine (the oracle) and the new Rust core with the **same seed and the same
command sequence**, then asserts the emitted cues and resulting `CampaignSnapshot` are identical.

- **Golden transcripts (floor):** the existing test corpus + `integration.test.ts` scenarios are
  recorded as `(seed, commands) → (cues, snapshot)` fixtures and replayed against the Rust core.
- **Generative differential fuzz (breadth):** random *legal* command sequences are generated and
  fed to both engines; the harness diffs **step-by-step** and reports the **first** diverging
  action, not just the end state.

A scope is "done" only when both pass. These fixtures survive as permanent regression tests against
the Rust core after the TS engine is deleted.

## Migration strategy

Parallel build with the TS engine as a behavioral oracle; cut over at the `GameSession`/`Authority`
seam once conformance is green. The engine is one tightly-coupled mutable object graph, so the
*stateful* core is ported as a unit (subsystem-by-subsystem-across-the-boundary is infeasible — it
would force whole-world serialization on every cross-subsystem call).

- **Phase 0 — Toolchain & pure leaf math.** Stand up `wickedways-core` + `wickedways-wasm`, the
  `ts-rs` generation pipeline, the `serde-wasm-bindgen` boundary, and the differential harness.
  Port the **pure** leaves first — `dice` (`roll`), mitigation/combat math, `stats` — and diff them
  against the TS equivalents. Proves the build, type generation, and harness end-to-end at low risk.
- **Phase 1 — Stateful core.** Port the entity model, turn loop, items/equipment/loot/crafting,
  status/afflictions, mobs, codex, victory, the mechanics op-registry (A2), and the
  authority/resolver/delta logic. Gate continuously on the conformance corpus. The TS engine keeps
  shipping throughout.
- **Phase 2 — Cutover.** Point `GameSession` at the WASM core first (**single-player**), validate
  through the real surfaces, then enable the **multiplayer** authority (server) + replica (client)
  roles. Each cutover gated on green conformance for its scope.
- **Phase 3 — Delete the oracle.** Remove `src/lib/...` and the hand-rolled `serialization/`
  subsystem. Keep the transcripts as regression fixtures. Update `README.md` and TSDoc per the
  project's living-docs convention.

## Testing strategy

- **Rust unit + property tests** in the core (`proptest` on mitigation/durability/loot invariants:
  e.g. mitigated damage ≥ 0, durability ≤ max, loot rolls always resolve to a valid entry).
- **Doctests** in the core so documented examples compile and run (reinforces the living-docs
  convention — examples that go stale break the build).
- **Differential conformance** (above) as the cross-engine gate during migration.
- **`cargo-fuzz`** on the save/snapshot/delta deserializer and on command streams.
- **Existing TS surface/e2e tests** continue to run against the WASM-backed `GameSession`,
  unchanged, as the integration check that the boundary behaves.

## Non-goals (for this effort)

- **Embedded/Arduino delivery.** Invariant 5 keeps the core `no_std`-friendly so the door stays
  open, but shipping to a microcontroller is out of scope here.
- **Sandboxed WASM op modules.** The two supported extension tiers are scripting (hosted) and
  native Rust plugins (self-hosted). WASM-module ops remain a documented future escape hatch — and
  would likely run `wasmi` on *both* server and client to preserve determinism — but are not built
  now.
- **Federation across deployments.** Each deployment (the canonical service or a self-hosted fork)
  is its own world; cross-deployment play or campaign sharing is out of scope.
- **Rewriting the surfaces, transport, or server.** They stay TS and keep their shapes.
- **Performance optimization.** Correctness, determinism, and containment are the goals; speed is
  incidental.

## Risks & open questions

- **Object-graph ergonomics in Rust.** The campaign is a cyclic graph (room ↔ occupants ↔
  characters ↔ items). The port will need an index/handle or arena representation rather than
  pointer-rich references. To resolve in the implementation plan; the existing `EntityIndex` and
  id-based serialization suggest an id-handle model is already the natural fit.
- **Authoring-format specifics.** A2 settles "campaigns are data"; the concrete format (RON/JSON,
  schema, validation, and how Hollow House's existing content/mechanics are expressed) is a plan
  detail.
- **`serde-wasm-bindgen` vs JSON-string marshalling.** Start with whichever lands the harness
  fastest; both satisfy invariant 4.
- **Generated-binding drift enforcement.** CI must run `ts-rs` generation and fail on diff
  (invariant 7) — a concrete CI step to specify in the plan.
- **Scripting sandbox surface (Tier 1).** The exact API exposed to scripts, the operation/
  call-depth/allocation limits, the script submission + content-hashing + authority-pinning flow,
  and `no_std` feature-gating of the interpreter are plan details. The chosen language (Rhai) is a
  recommendation, not yet locked.
- **Native-plugin determinism is unenforceable (Tier 2).** The engine cannot guarantee a native
  plugin is pure; this is a documented author contract, not an engine-enforced property. The plan
  should specify what diagnostics (if any) help authors catch nondeterminism (e.g. a self-diff
  conformance tool authors can run against their own ops).
