# Rust Engine Phase 2a+2b — Single-Player WASM Cutover

**Status:** Design approved, ready for implementation plan
**Date:** 2026-07-06
**Branch:** `design/rust-engine-core`
**Master design:** [`2026-06-30-rust-engine-core-design.md`](./2026-06-30-rust-engine-core-design.md)

## Goal

Point the single-player game at the Rust/WASM core. Introduce a stateful `Authority`
handle in `wickedways-wasm` and rewire `@wickedways/play-runtime`'s `GameSession` to
delegate `execute`/`view`/`read`/`save`/`restore`/`undo` to it — validated through the
real CRT/PnC surfaces and gated on a differential conformance harness whose oracle is the
seeded `GameSession` itself. This is the master design's **Phase 2 cutover, single-player
half** (2a: the stateful WASM API + build split; 2b: the play-runtime cutover). Multiplayer
(`Replica`/`Delta`) is a separate later spec (2c).

## Scope

**In scope**

- **2a** — a stateful `#[wasm_bindgen] Authority` (owning `World + Catalog + opened + rng`),
  the ported `execute()` orchestration (turn-wrap + solo-GM mob reactions), an `Intent`
  boundary type, `MobAttack`/`ExecuteResult` outbound types, and the **conformance-feature
  build split** so `conformance:*` ops never ship.
- **2b** — `GameSession` delegates to the `Authority`; a browser-loadable (bundler-target)
  WASM build + one-time async engine init; the `session.campaign` live-object boundary
  violation is retired; new differential fixtures whose oracle is the seeded `GameSession`.

**Out of scope**

- Multiplayer `Replica`, `Delta` compute/apply, `SyncCoordinator` rewire (**2c**, own spec).
- Porting the authoring/`assemble`/`startSession` path or `PlayerCharacter` construction — TS
  authoring stays and produces the genesis.
- Deleting `src/lib/…` / the hand-rolled `serialization/` subsystem — **Phase 3**; the TS
  oracle must remain intact for the conformance gate.
- Migrating the boundary from JSON strings to `serde-wasm-bindgen` — a later isolated
  optimization; invariant 4 holds either way.
- Phase-1 carried nits (`sees_in_dark ≡ light_averse` decouple, the `resolve_condition`
  helper in `turn.rs`, etc.) unless a file is touched for cutover reasons anyway.

## Background: the orchestration gap

The conformance gate (Phase 1) drove the engine (`src/lib`) directly with raw `Command`s via
the stateless `replay_commands` WASM function. But the real single-player runtime does more
**above** the engine, inside `@wickedways/play-runtime`'s `GameSession` — logic the gate has
**never verified against Rust**:

- `execute(intent)` wraps each action as `startTurn → dispatch(intent) → runMobReactions() →
  nextPlayer`, snapshotting for undo when the action is time-advancing.
- **`runMobReactions()`** is a solo-GM turn driver: every live (non-KO) `Mob` sharing the
  active player's room strikes the player; the typed damage is derived from the player's
  effective-stat deltas; a downed player is not piled on. This decides game outcomes (damage,
  KO, round-end) and thus, per invariant 2, belongs in the core.
- `dispatch(intent)` maps the surface `Intent` to engine calls (mostly `targetId` lookups the
  Rust `Command` already resolves internally), plus `opened`-loot tracking.

The cutover therefore moves this orchestration **into the core**, where new differential
fixtures cover it.

## Current state (what exists)

- **`wickedways-wasm`** exposes only conformance free functions: `ping`, `mitigator`, `roll`,
  `mitigated_damage`, `roundtrip_snapshot`, `view_model`, and the stateless
  `replay_commands(start_snapshot, commands, catalog, seed)`. No stateful handle.
- **`wickedways-core`** has the full Phase-1 stateful engine: `World::from_snapshot`/
  `to_snapshot`, `begin_campaign` (turn.rs:24, fires round-0 `onRoundStart`), `start_turn`/
  `end_turn`/`next_player`/`end_campaign`, `go`/`take`/`drop`/`use`/`equip`/`unequip`/
  `attack`/`use_mechanic_action`, `attack` (used for mob strikes), `view`, `validate_mechanics`,
  `seed_rng`. `apply_command` dispatches the `Command` enum (already `target_id`-level and
  self-resolving).
- **`GameSession`** (`packages/play-runtime/src/session.ts`) is fully TS-engine-backed:
  `boot()` → `assemble` + `PlayerCharacter` setup + `campaign.beginCampaign()`; `execute` →
  `serializeCampaign` (undo) + `startTurn`/`dispatch`/`runMobReactions`/`nextPlayer`; `view`,
  `read`, `save`/`restore`/`undo` via `serialize`/`deserializeCampaign`.
- `wasm:build` compiles **with `--features conformance` always on** (`--target nodejs`), which
  registers the `conformance:*` mechanic ops / exit / scene / formation / victory behaviors.
- The **one boundary violation**: the CRT controller calls `audio.update(session.campaign)`
  — the single place a surface reaches into a live engine object (master design invariant 4).

## Component design

### 2a — `Authority` (stateful WASM handle)

A new stateful handle in `wickedways-wasm`. JSON-string marshalling throughout (the proven
`replay_commands` path). All game state lives inside; only serializable JSON crosses the seam.

```rust
#[wasm_bindgen]
pub struct Authority {
    world: World,
    catalog: Catalog,
    opened: BTreeSet<String>,   // loot containers revealed this session
    // rng lives in `world` (seeded, advances continuously across submits)
}

#[wasm_bindgen]
impl Authority {
    /// genesis_json = a PRE-begin CampaignSnapshot (assembled + PC placed, not yet begun).
    /// Runs: from_snapshot → validate_mechanics → seed_rng(seed) → begin_campaign
    /// (buffering the round-0 onRoundStart cues into the startup buffer).
    #[wasm_bindgen(constructor)]
    pub fn new(genesis_json: &str, catalog_json: &str, seed: u32) -> Result<Authority, JsValue>;

    /// Opening cues emitted during begin_campaign; returns and clears the buffer.
    pub fn take_startup_cues(&mut self) -> Result<String, JsValue>;   // PresentationCue[] JSON

    /// The full ported execute() flow. Returns ExecuteResult JSON {cues, mobAttacks?, error?}.
    pub fn submit(&mut self, intent_json: &str) -> Result<String, JsValue>;

    pub fn view(&self) -> Result<String, JsValue>;                    // ViewModel JSON

    /// Free, non-time-advancing read of a held item's lore. Returns PresentationCue[] JSON.
    pub fn read(&mut self, item_id: &str) -> Result<String, JsValue>;

    pub fn snapshot(&self) -> Result<String, JsValue>;               // CampaignSnapshot JSON
    pub fn restore(&mut self, snapshot_json: &str) -> Result<(), JsValue>;  // rehydrate in place

    pub fn finished(&self) -> bool;
    pub fn outcome(&self) -> String;
}
```

**`submit` — the ported `execute()` flow (in the core).** Runs entirely inside
`wickedways-core` (a new `World`-level method the WASM `submit` delegates to, so it is
unit-testable off-WASM):

1. Parse `Intent`. Classify time-advancing via a core `is_time_advancing(intent)` (the port
   of `intent.ts`'s `TIME_ADVANCING` set: `move`/`take`/`drop`/`use`/`attack`/`wait`/`talk`
   advance; `open`/`equip`/`unequip` are free).
2. If advancing: `start_turn(active)`.
3. Dispatch the intent to the matching engine op (`move`→`go`, `take`/`drop`/`use`/`equip`/
   `unequip`/`attack`/`open` → the existing `Command` handlers; `wait` → no-op; `talk` →
   `ProceduralViolation("There's no one here to talk to.")`). `open` inserts into `opened`;
   `take` inserts the returned loot id (matching `apply_command`).
4. If advancing: `run_mob_reactions(active, cat, cues)` → collect `Vec<MobAttack>`.
5. If advancing: `next_player(cat, cues)`.
6. Return `ExecuteResult { cues, mob_attacks }`. A `ProceduralViolation` thrown anywhere in
   3–5 is caught and returned as `ExecuteResult { cues, error }` (matching TS `execute`); any
   non-procedural error propagates.

**Intent-level legality guards.** `GameSession.dispatch` today throws several surface-facing
`ProceduralViolation` messages that are *not* in the engine's `Command` handlers — they move
into the core `submit` dispatch and must match the TS strings **exactly** (the fixtures
verify them): drop of a required item (`droppable === false`) →
`` `You can't bring yourself to part with the ${name}.` ``; `open`/`take`/`drop`/`equip`/
`use`/`attack` on a missing target → the same messages TS raises ("There's nothing like that
to open here.", "You aren't carrying that.", "You don't see that here.", "That isn't
equipped.", "There's nothing like that to attack here."); attacking a KO'd target →
`` `The ${name} is already dead.` ``. Where the existing `Command` handler already produces
the message, reuse it; where the guard lived only in `dispatch`, port it into the core.

**`run_mob_reactions` (new core solo-GM driver).** Faithful port of `GameSession.runMobReactions`:

- If the active character has no current room or is `Status::KO`, return empty.
- For each occupant of the room (snapshot of the occupant id list, in the same order the TS
  iterates `[...room.occupants]`): skip the active character, non-`Mob`s, and KO'd mobs.
- Capture the player's effective `Health`/`Sanity`/`Energy` before; call `mob.attack(player)`
  (reuse the existing `attack` path); on `ProceduralViolation` (afflicted/blocked mob), skip;
  capture after; for each of `Health`/`Sanity`/`Energy`, if `before - after > 0` push a
  `MobAttack { name, stat, amount }`.
- Break once the player is `Status::KO` (don't pile on a downed player).

**New boundary types (generated via `ts-rs`, invariant 1 & 7).**

- `Intent` — internally-tagged (`#[serde(tag="kind", rename_all="camelCase")]`) reproducing
  `packages/play-runtime/src/intent.ts` 1:1: `move{dir}`, `take/drop/open/equip/unequip/use/
  attack{targetId}`, `talk{npcId, prompt?}`, `wait`. (Distinct from the existing `Command`,
  which additionally carries the internal lifecycle ops `startTurn`/`endTurn`/`nextPlayer`/
  `endCampaign`/`mechanicAction` and has no `wait`/`talk`. `Command` stays the
  internal/multiplayer representation.)
- `MobAttack { name: String, stat: StatType, amount: f64 }` — mirrors the TS `MobAttack`
  (`amount` is a stat delta; stats are `f64` per sub-plan 4b).
- `ExecuteResult { cues: Vec<PresentationCue>, #[serde(skip_serializing_if=...)] mob_attacks,
  #[serde(skip_serializing_if=...)] error }` — mirrors the TS `ExecuteResult`.

The generated `.d.ts` for these replaces the hand-written types in `play-runtime` (`Intent`,
`MobAttack`, `ExecuteResult`) so there is one source of truth. The `bindings:check` CI step
fails if the checked-in output drifts.

**Lifecycle: core-begins.** `Authority::new` takes the **pre-begin** genesis snapshot and runs
`begin_campaign` itself, so the *core* is the single source of the opening status cues (the
status mechanic's `onRoundStart`). TS `boot()` serializes the assembled + PC-placed campaign
*before* calling `beginCampaign`. This keeps one cue source and one lifecycle owner and is
directly conformance-verifiable (`begin_campaign` parity is already exercised by Phase-1
unit tests; the new fixtures cover it end-to-end).

### 2a — conformance-feature build split (hard prerequisite)

`conformance:*` registries (mechanic ops, exit/scene/formation/victory behaviors) are gated
`#[cfg(any(test, feature = "conformance"))]`. The shipped `Authority` must not carry them.

- Keep `Authority` (and the free functions the real runtime needs) available in the **default**
  (no-conformance) build. Keep `replay_commands` + the conformance free functions available
  under the **conformance** feature.
- Two npm build scripts: `wasm:build` (default features — the real runtime build; **no**
  `--features conformance`) and `wasm:build:conformance` (`--features conformance` — the gate).
- `test:conformance` uses `wasm:build:conformance`. The shipped browser/runtime build uses
  `wasm:build`. `checks:phase2` verifies the default build compiles and exposes `Authority`
  without any `conformance:*` symbol.

### 2b — `GameSession` cutover

`GameSession` keeps its **exact public shape** (`start`, `execute`, `view`, `read`, `save`,
`restore`, `undo`, `restart`, `takeStartupCues`, `finished`, `outcome`, and — see below — a
retired `campaign` getter). Surfaces, audio, and the launcher are otherwise untouched.

- **`boot()`**: still `assemble(builder.description, builder.registry)` + `PlayerCharacter`
  setup (`joinCampaign`, `selectArchetype`, `move` to start room, set `gm`) in TS. Then
  `serializeCampaign(campaign)` **before** `beginCampaign` to get the pre-begin genesis, build
  the catalog JSON (`{ items, aliases }`), and construct `new Authority(genesis, catalog, seed)`.
  `takeStartupCues()` reads from the handle.
- **`execute(intent)`** → `JSON.parse(authority.submit(JSON.stringify(intent)))`. The TS
  `dispatch`/`runMobReactions`/turn-wrap/undo-serialize block is deleted; undo is handled via
  `snapshot()` (below).
- **`view()`** → `JSON.parse(authority.view())`; **`read(id)`** → `authority.read(id)`.
- **`opened`** loot moves into the `Authority` (the core already mutates it during `take`/
  `open`), so `view()` no longer threads it; `GameSession` drops its `opened` field.
- **`save(slot, surface)`** → persist `authority.snapshot()` to the `SaveStore` (unchanged
  store interface).
- **`restore(slot)`** / **`undo()`** → `authority.restore(snapshot)`. **Undo stays host-side**:
  before an advancing `submit`, stash `authority.snapshot()`; `undo()` = `restore(stashed)`.
  (`GameSession` keeps the `undoSnapshot` field; it just holds JSON now.)
- **`restart()`** → re-run `boot()` (fresh `Authority`), clear undo. Unchanged in effect.

**The `campaign` live-object boundary fix (invariant 4).** Post-cutover `session.campaign` is
not a live JS object. The one consumer, `audio.update(session.campaign)` in the CRT
controller, is re-expressed as DTO state: the audio runtime is fed the data it needs from the
`ViewModel` (a field carrying what `audio.update` read — e.g. tension inputs) or off the
`sound?: AssetRef` already on cues. The `campaign` getter is removed from `GameSession`. This
is the single surface-adjacent change in 2b.

### 2b — WASM loading (browser + Node)

`play-runtime` is consumed in **two environments**: the browser (via Vite, in `@wickedways/
play` — Playwright e2e + shipped app) and Node (vitest happy-dom unit tests + the conformance
harness). wasm-pack targets differ:

- Add a **bundler-target** default build (`wasm-pack build … --target bundler`) that Vite can
  import for the browser surfaces.
- Keep a **nodejs-target** build for the conformance harness and play-runtime Node unit tests.
- Bundler/web targets require async initialization. The launcher (`bootLauncher`) gains a
  one-time `await initEngine()` before the first `mountSurface`; once resolved, the WASM module
  is loaded and **`GameSession.start` stays synchronous** (it constructs an `Authority` against
  the already-initialized module). No `GameSession`/surface signature goes async.

## Data flow

**Single-player action loop (surface unchanged):**
```
input → parser → Intent → GameSession.execute(intent)
  → JSON → [WASM] Authority.submit
      → is_time_advancing? startTurn → dispatch(intent) → runMobReactions → nextPlayer
      → cues buffered, mobAttacks collected
  → ExecuteResult { cues, mobAttacks } (JSON)
  → narrator renders cues; GameSession.view() → ViewModel → Lit render
```
Save/undo ride `snapshot()`/`restore()`. Only serializable JSON crosses the seam (invariant 4).

## Error handling

- **Gameplay (`ProceduralViolation`) inside `submit`** — caught in the core, returned as
  `ExecuteResult.error` with the same message TS produced (e.g. "You aren't carrying that.",
  "There's no one here to talk to."). The surface renders the error line exactly as today.
- **Load/construct failures** — `Authority::new` and `restore` return `Result`; a genuine
  failure (malformed snapshot, mechanic validation failure) surfaces as a thrown JS error, not
  an `ExecuteResult`. These are not reachable through normal play.
- **Non-procedural panics** — propagate as JS exceptions, matching today's `execute` (which
  rethrows anything that is not a `ProceduralViolation`).

## Conformance & testing strategy

The differential gate remains the authority; divergences are fixed in Rust source, never by
editing goldens or the comparator.

- **New oracle = the seeded `GameSession`.** New differential fixtures drive the **facade**
  (`GameSession.execute`) with a seeded rng as the oracle, and `Authority.submit` as the
  replica, comparing `{cues, mobAttacks, snapshot, view}` step-by-step. This is the first
  coverage of `runMobReactions` + the turn-wrap. A new WASM replay entry point (or a thin
  `Authority`-driven harness) records the per-step output. Fixture coverage (per the
  "comprehensive" bar used in Phase 1):
  - **mob-reaction combat** — player in a room with a live mob; a time-advancing action draws
    the mob's strike; assert `mobAttacks` + resulting stats/cues (rng-dependent — a genuine
    draw-consuming exchange).
  - **KO-stops-piling** — multiple mobs; player downed mid-loop; remaining mobs don't strike.
  - **afflicted mob skipped** — a blocked mob's `ProceduralViolation` is swallowed, others act.
  - **free vs time-advancing** — `equip`/`open` do NOT trigger `startTurn`/reactions/`nextPlayer`;
    `move`/`wait` do.
  - **`wait`** — advancing no-op still runs reactions + `nextPlayer`.
  - **`talk`** — returns `ExecuteResult.error` ("There's no one here to talk to."), no state change.
  - **loot open + take (Intent path)** — `open` (free, non-advancing) marks the container
    revealed; `take` auto-opens if needed, moves the item, and advances the turn — covering the
    `dispatch`→loot path and the `opened`-set ownership move into the `Authority`.
  - **intent-level legality errors** — drop of a required (`droppable:false`) item, and a
    missing-target `open`/`take`/`equip`/`use`/`attack`, each return the exact TS
    `ExecuteResult.error` string with no state change.
  - **save → restore → undo** — snapshot round-trips; undo reverts a time-advancing action
    (including mob reactions, matching the pre-action snapshot).
  - **startup cues** — `take_startup_cues` matches the TS boot cue buffer (core-begins parity).
- **Existing raw-engine gate stays green**, unchanged, under the conformance-feature build.
- **Existing surface/e2e + play-runtime unit tests** run against the WASM-backed `GameSession`
  unchanged — the integration proof that the boundary behaves through the real surfaces.
- **`checks:phase2`** extended to: default-feature `Authority` build compiles and exposes no
  `conformance:*` symbol; both wasm targets build; `bindings:check` covers the new `Intent`/
  `MobAttack`/`ExecuteResult`; the full conformance suite (raw-engine + new facade fixtures)
  passes; `no_std` core still builds `--no-default-features`.

## Risks & open questions

- **rng parity between facade oracle and `Authority`.** Live play uses a nondeterministic rng
  (real `Math.random`); the gate must seed both sides identically. The oracle `GameSession`
  takes an injected seeded `rng`; the `Authority` is constructed with the same integer seed and
  its internal `seed_rng`. The fixtures must confirm the two rng streams line up across the
  turn-wrap (start_turn / mob attacks / next_player draw order) — the same draw-order care the
  Phase-1 fixtures already exercise.
- **`begin_campaign` pre-begin snapshot validity.** The genesis serialized *before*
  `beginCampaign` must round-trip and drive `begin_campaign` to byte-identical round-0 cues.
  Verified by the startup-cues fixture; if a pre-begin snapshot proves ill-formed, fall back to
  the alternative (TS begins, hands a post-begin snapshot + startup cues) — recorded here as the
  contingency, not the plan.
- **Audio DTO shape.** The exact `ViewModel` field (or cue-derived signal) that replaces
  `audio.update(session.campaign)` must carry everything `audio.update` currently reads; a plan
  detail requiring a read of the audio runtime's `update` inputs.
- **Bundler vs Node wasm loading in one package.** `play-runtime` importing a bundler-target
  build for the browser while its Node unit tests need the nodejs target — the plan must define
  how the module is selected per environment (conditional import / test alias) without forking
  `GameSession`.

## Invariant check (master design)

- **1 (one source of truth for typings)** — `Intent`/`MobAttack`/`ExecuteResult` become
  generated from Rust; hand-written TS copies deleted. ✅
- **2 (engine concerns in the engine)** — `runMobReactions` + turn-wrap move into the core. ✅
- **3 (determinism)** — rng lives in the handle, advances continuously, re-seeded on the gate;
  no wall-clock/ambient randomness added. ✅
- **4 (boundary carries only serializable data)** — JSON only; `session.campaign` live-object
  leak retired. ✅
- **5 (`no_std`-friendly core)** — `Authority` lives in `wickedways-wasm`; the ported `submit`/
  `run_mob_reactions` core logic stays `alloc`-only and behind no new `std` dependency;
  `--no-default-features` still builds. ✅
- **6 (engine emits intent; surfaces own presentation)** — cues/viewmodel unchanged; parser/
  narrator stay surface-side. ✅
- **7 (generated bindings never hand-edited)** — `bindings:check` covers the new types. ✅
