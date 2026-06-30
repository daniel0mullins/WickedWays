# Rust Engine Core — Phase 1, Sub-plan 2 (Turn Loop + Movement)

**Status:** Design approved, ready for implementation plan
**Date:** 2026-06-30

## Goal

Bring the id-keyed `World` from sub-plan 1 (World Foundation) to life: the **campaign turn
loop**, **player movement over behavior-free exits**, **lighting**, the **presentation cue model**,
and a **thin `ViewModel` slice**. This is the first sub-plan that *mutates* the `World` and the first
to run a **command-stream differential gate** (sub-plan 1 only round-tripped a static snapshot).

Parent specs:
- `docs/superpowers/specs/2026-06-30-rust-engine-core-design.md` (7 invariants, A2, migration phases)
- `docs/superpowers/specs/2026-06-30-rust-engine-phase-1-world-foundation-design.md` (id-keyed
  `World`, the 8-sub-plan decomposition, sub-plan 1 detail)

Sub-plan 1 is complete and merge-ready on `design/rust-engine-core` (commit `3955691`): the
id-keyed stores, serde snapshot structs (byte-compatible with the TS `serialization/types.ts`
format), single-pass `from_snapshot`/`to_snapshot`, and the static snapshot round-trip gate. This
builds directly on that `World`.

## Scope discovery (what reshaped this sub-plan)

The Phase 1 decomposition listed "exits, locked-door visibility" under sub-plan 2. Reading the real
campaign sources changed where one piece lands:

1. **`canPass` re-binds *campaign* behavior, so it is a registry (sub-plan 6) dependency — not
   sub-plan 2.** The `ExitSnapshot` stores only `behaviorKey?` + `state` (`Record<string, unknown>`);
   the precondition/script that `canPass`/`runScript` evaluate live in the **campaign**, keyed by
   `behaviorKey`, and are re-attached on hydrate via the registry. Hollow House's locked doors are a
   campaign-owned `doorBehavior(keyCode, name, opened)`
   (`packages/campaigns/src/hollow-house/content.ts`):

   ```ts
   preconditions: [(c, s) => s.unlocked || c.inventory.keys.some(k => k.keyCode === keyCode)],
   script: (_c, s) => { if (!s.unlocked) { s.unlocked = true; return opened; } },
   failMessage: `The ${name} won't budge — it's locked.`,
   ```

   Evaluating this in sub-plan 2 would require either putting campaign-specific logic inside the
   engine core (violates invariant 2, "engine-contained") or pulling sub-plan 6's registry forward.
   **Decision: `canPass`, the exits-vs-`lockedDoors` partition, keyed-door traversal, and scene
   execution all move to sub-plan 6.** This refines the sub-plan 1 design's statement that
   "exits/canPass" land in sub-plan 2 — `canPass` is a registry concern.

2. **Both conformance fixtures have zero scenes.** `seed.snapshot.json` and
   `hollow-house.snapshot.json` carry empty `scenes: []` on every room. Scene execution
   (`scene.playScene("enter"|"exit")`, also campaign behavior re-bound by `behaviorKey`) therefore
   touches nothing in the corpus and is deferred to sub-plan 6 at **zero conformance risk**.

3. **The seed campaign has 0 characters** — it is a world skeleton, with no party to advance or move.
   **Hollow House is the only viable command-stream driver** for this sub-plan: 2 characters, 9
   rooms, 8 exits (6 behavior-free, 2 keyed), 2 dark rooms. Movement stays richly testable across the
   6 behavior-free exits; only Landing→Study (West) and Landing→Attic (North) are keyed and excluded
   until sub-plan 6.

## In scope

### Turn loop (mirrors `src/lib/campaign.ts`)

State on a `Campaign`/`CampaignState` (the campaign-level fields already carried as plain data by
sub-plan 1, now made live):

- `round` (starts 0), `max_rounds`, `party: Vec<CharacterId>` (turn order),
  `active_character_index`, `acted_this_round` (per-party-member flag — model as a
  `BTreeSet<CharacterId>` of who has acted, reset each round, for deterministic iteration),
  `started: bool`, `outcome: CampaignOutcome`, `outcome_reason: Option<String>`.
- `begin_campaign()`: marks started, dispatches round-start (mechanic hook — **no-op**, registry
  empty until sub-plan 6), drains any startup cues. Hollow House has no status mechanic, so startup
  cues are empty here.
- `next_player()`: assert running; mark active character acted; `index + 1`; if it wraps to
  `party.len()`, reset index to 0 and call `end_round()`; otherwise advance the index. (Does **not**
  auto-call `start_turn` — the surface drives that, matching the TS engine.)
- `end_round()`: assert running; assert **all** party members acted (else `ProceduralViolation`);
  dispatch round-end (no-op); `round += 1`; reset activity; **resolve outcome (timeout only, see
  below)**; if finished, `finish(...)` and return; else dispatch round-start (no-op).
- `start_turn(actor)` / `end_turn(actor)` on the character path: `start_turn` resets
  `actions_this_round = 0` then fires character events + affliction-turn-start + mechanic turn-start
  — **all no-ops in this sub-plan** (no afflictions until 4, no mechanics until 6, no registered
  character-event handlers at genesis). `end_turn` fires events + reconcile + mechanic turn-end —
  also no-ops.

### Outcome — timeout only

`end_round` resolves the outcome with a **minimal** resolver: `round >= max_rounds → "timed-out"`,
else `"ongoing"`. **Win/lose conditions are deferred to sub-plan 7.** On a non-`ongoing` result,
`finish(outcome, reason=None)` sets `outcome`/`finished` and emits the `resolution` cue
(`{ kind: "resolution", outcome, reason: None, narration: None }`). (Hollow House `max_rounds = 150`,
so a short conformance stream never times out; the path is unit-tested directly.)

### Movement (mirrors `src/lib/character/character.ts` `go`/`move`)

Over **behavior-free exits only** (no `behaviorKey`):

- `go(actor, direction)`:
  1. action gate — trivially passes (no afflictions until sub-plan 4) but **reserves the action
     budget**;
  2. require the actor is in a room (else `ProceduralViolation`);
  3. look up `room.exits[direction]`; if absent → emit `{ kind: "mechanic", cue: { text: "You can't
     go that way." } }` and return (no move, action not committed);
  4. **a behavior-free exit has no preconditions → always passable**; (a keyed exit is out of scope
     this sub-plan — the conformance stream never targets one; `go` toward a keyed exit returns a
     clear "unbound exit behavior" error and is exercised only in sub-plan 6);
  5. a behavior-free exit has no `passMessage`/`script`, so **no narration cue** is emitted;
  6. `move(actor, other_side)`.
- `move(actor, room)`:
  1. action gate (reserves budget);
  2. `enter_room`: if currently in a room, `exit_room` (remove from old room's occupants — scene
     firing deferred to 6); set `current_room`; `enter_room` (add to new room's occupants — scene
     firing deferred);
  3. if the destination is not lit → emit `{ kind: "visibility", room: {id,name}, lit: false }`;
  4. `record_action(move, ActionDetail::Move { room })` → ticks the budget, appends to history, and
     emits `{ kind: "action", action: "move", actor: {id,name}, sound: <presentation sound or none> }`.

**Action budget:** `go` and `move` are budgeted (`actions_per_round`, `actions_this_round`). Mirror
the TS `attemptAction`/`recordAction` reserve-then-commit semantics precisely — `actions_this_round`
is a snapshot field, so it must match the oracle byte-for-byte. The plan task transcribes the exact
gating/recording from `character.ts`.

### Lighting (mirrors `src/lib/room.ts` `isLit`)

`room.is_lit()`: `!dark` → lit; else lit iff any placed light source is not broken **or** any
occupant carries light. **Occupant-carried light needs an equipped light item (item behavior), which
lands in sub-plan 3** — so this sub-plan computes `is_lit = !dark || any(placed light not broken)`
and folds in the occupant-light term in sub-plan 3 (widening, like the ViewModel). Hollow House's
dark rooms have no placed light sources and (verified by the gate) no carried light at genesis, so
entering them emits the `visibility` lit:false cue.

### Cue model (mirrors `src/lib/presentation.ts`)

Define the full discriminated union `PresentationCue` (ts-rs generated, serde byte-compatible with
the TS `kind`-tagged shape) with all six variants:

```
action     { action: ActionKind, actor: EntityRef, sound: Option<AssetRef> }
encounter  { mob: EntityRef, room: EntityRef, sound: Option<AssetRef> }   // emitted in sub-plan 4
visibility { room: EntityRef, lit: bool }
resolution { outcome: CampaignOutcome, reason: Option<String>, narration: Option<OutcomeNarration> }
mechanic   { cue: MechanicCue }
status     { fields: Vec<StatusField> }                                    // emitted in sub-plan 6
```

Supporting types: `EntityRef { id, name }`, `StatusField { label, value, emphasis? }`, `MechanicCue
{ text?, sound? }`, `OutcomeNarration { text?, sound? }`, `CampaignOutcome` enum
(`ongoing|won|lost|timed-out|ended`), `ActionKind` (the `ActionDetail` discriminant —
`attack|move|pickUp|drop|escape|takeDamage|fumble|mechanicAction`). `AssetRef` is an opaque
serde-passthrough (`serde_json::Value` or `String`, matched to the TS shape).

This sub-plan **emits** only `action`, `visibility`, `resolution`, and `mechanic`; `encounter` and
`status` are defined-but-unemitted (their producers land in 4 and 6). A **drainable cue buffer**
accumulates emitted cues during a command and is cleared at the start of each command — mirroring
`GameSession`'s `execute`/`takeStartupCues` buffer semantics.

### Thin ViewModel slice (mirrors `packages/play-runtime/src/viewmodel.ts`)

Build only the fields derivable without behavior, with a parity gate:

- `room { id, name, description, is_lit }`
- `occupants: [{ id, name, kind: "occupant" }]` (no `health`/`defeated` — those need `effectiveStat`
  and status, sub-plan 4; no `image` — that is runtime presentation)
- `status { turn, max_turns }`, `outcome`, `finished`

**Deferred ViewModel fields (widen as dependencies land):** `exits`/`lockedDoors` via `canPass` → 6;
`loot`/`inventory`/`scope` and item display (`aliases`/`equippable`/`usable`/`hasLore`/`droppable`)
→ 3; `health`/`defeated`/`sanity` via `effectiveStat` → 4; `image`/`aliases` (presentation/registry)
→ 6. The Rust `view()` signature matches the TS one in shape (campaign + aliases + opened-loot) but
only populates the thin slice now.

## Command-stream differential gate (new harness, reusable for 3–8)

This sub-plan introduces the **command-stream** gate (sub-plan 1 was static round-trip):

1. **TS oracle harness:** load Hollow House → `beginCampaign` → run a scripted command sequence and
   dump, per step, `{ command, cues, snapshot, viewThin }` to a committed golden file. The sequence
   uses only: `startTurn`, `go` over **behavior-free exits** (e.g. Foyer↔Parlor↔Landing↔Nursery and
   neighbors), `nextPlayer` including at least one full round wrap, and one `go` at a wall (the "You
   can't go that way." path). It must enter at least one **dark room** (the lit:false visibility cue).
2. **Rust replay:** a minimal `apply_command(world, command) -> cues` dispatch (a small command enum:
   `StartTurn`, `EndTurn`, `Go(direction)`, `NextPlayer`) — **not** the full authorize/dispatch/delta
   pipeline (that is sub-plan 8). The WASM conformance entrypoint loads the snapshot, replays the
   command list, and returns the per-step `{ cues, snapshot, viewThin }`.
3. **Comparison:** per step, `cues` and `snapshot` must match the golden file **byte-for-byte under
   canonical (key-sorted) JSON**, reusing `conformance/canonical-json.ts`; the thin `viewThin` must
   match its golden too. Extend the canonical comparator if a newly-mutated field needs set-semantic
   sorting (see the carried note below).

The golden file is generated by an **isolated** generator config (as with sub-plan 1's
`conformance/fixtures/vitest.config.ts`) so the main gate **reads** the committed golden and never
regenerates it — the self-referential-gate bug caught in sub-plan 1 must not recur.

## Testing

- **Rust unit tests:** `next_player` wrap → `end_round`; `end_round` asserts all-acted (throws
  otherwise); timeout resolution at `round == max_rounds` emits the `resolution` cue; `go` wall →
  `mechanic` "You can't go that way."; `go`/`move` over a behavior-free exit updates occupancy +
  `current_room` + budget and emits the `action` (+ dark-room `visibility`) cue; `is_lit` truth
  table; cue-buffer drain semantics; each `PresentationCue` variant serde round-trips
  byte-compatibly.
- **Differential conformance:** the Hollow-House command-stream gate above (cues + snapshot + thin
  view), exact-equality canonical JSON (invariant 3).
- **ts-rs binding drift:** the new `PresentationCue` (and supporting) types regenerate cleanly and
  the `bindings:check` drift gate stays green.

## Non-goals (this sub-plan)

- **No `canPass`, no exits-vs-`lockedDoors` partition, no keyed-door traversal, no scene execution**
  (all sub-plan 6 — registry re-binds campaign behavior).
- **No win/lose conditions** (sub-plan 7); only timeout outcome.
- **No afflictions / status / combat / mobs / encounter cues** (sub-plan 4).
- **No items / loot / crafting / inventory ViewModel** (sub-plan 3).
- **No mechanics op-registry, no `status` cue emission** (sub-plan 6).
- **No authority / authorize / delta / full Intent dispatch** (sub-plan 8) — the `apply_command`
  shim is a conformance driver, not the authority pipeline.
- **No WASM cutover** — consumers still run the TS engine (Phase 2).

## Carried notes (from sub-plan 1 review) to honor here

- **Set-semantic fields switch from `Vec` to `BTreeSet`.** `occupant_ids` becomes set-semantic this
  sub-plan (`Room.occupants` is the one serialized set movement mutates; `acted_this_round` is
  runtime-only and never serialized, so it carries no comparator concern). When `occupant_ids`
  switches, **revisit the canonical comparator's order-preserving-vs-id-sorted partition** in
  `conformance/canonical-json.ts`: a `BTreeSet` emits sorted, so the comparator must sort the
  `occupantIds` snapshot arrays (or the TS oracle must emit them sorted) to diff clean. Resolve this
  explicitly in the plan.
- **Comparator number-normalization.** The JS comparator's `JSON.parse` normalizes `50.0`→`50`,
  which masked a byte-divergence in sub-plan 1. The new command-stream gate introduces integer
  counters (`round`, `actions_this_round`) — keep them integer-typed (`i64`/`u32`) so no fractional
  representation can arise, and consider tightening the comparator to catch int-boundary drift.

## Risks & open questions

- **Action-budget fidelity.** `actions_this_round` is a snapshot field; the reserve-then-commit
  semantics of `attemptAction`/`recordAction` (including the "reserved-but-not-committed" wall case)
  must be transcribed exactly or snapshots diverge. Plan task: read `character.ts` `attemptAction`/
  `recordAction` first and mirror the tick points.
- **Occupancy ordering.** `Room.occupants` is a `Map` in TS (insertion order) but becomes
  `BTreeSet<CharacterId>` in Rust (sorted). The snapshot's `occupantIds` array order must be made
  to agree on both sides via the comparator (see carried note). Decide the canonicalization in the
  plan.
- **Startup cue emptiness.** Confirm via the oracle that `beginCampaign` on Hollow House emits no
  cues (no status mechanic); if any appear, they belong to a deferred subsystem and the stream/gate
  must account for them.
- **`AssetRef`/`presentation` sound on the action cue.** The `move` action cue carries an optional
  sound resolved from the actor's presentation (runtime descriptor, not snapshot). Confirm Hollow
  House party members carry no action sound at genesis (so the cue's `sound` is `None`); otherwise
  the sound source is a registry/presentation concern and the cue's `sound` field defers.
