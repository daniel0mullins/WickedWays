# Command Layer + Multi-Client Sync — Design

**Date:** 2026-06-18
**Status:** Approved

## Problem

The engine is meant to be played asynchronously across multiple clients, which
must stay in agreement as a campaign is played. Spec 1 gave us full-campaign
serialization (`CampaignSnapshot`, `CampaignRegistry`,
`serializeCampaign`/`deserializeCampaign`). This spec adds the layer that keeps N
clients converged: a serializable **command** for every player/GM action, a
**resolver** that applies a command through the real engine and emits the state
change, and the ordering/late-join machinery to replicate it.

The engine is **turn-based with a single `activeCharacter`**, so there is no
concurrent mutation to reconcile — ordering is the only hard requirement, and no
CRDTs/operational-transforms are needed.

This is **Spec 2** of the serialization → sync → comms decomposition. Spec 3
(audio/video/text comms) is separate and brings the backend that the future
authoritative-server topology would reuse.

## Goal

A **transport-agnostic synchronization core**: define serializable commands,
resolve them authoritatively through the engine, broadcast the resulting
**entity-delta**, and let replica clients converge by patching state — with
single-writer/GM authorization, total ordering under races, atomic rejection, and
late-join from a Spec 1 snapshot. No concrete backend; the real transport is a
thin adapter wired up later.

## Decisions

Settled during brainstorming:

- **Command + entity-delta (not command-replay).** A player's action travels as a
  serializable **command** (intent) to the resolver. The resolver runs the **real
  engine**, then re-serializes the entities that changed and broadcasts that
  **delta**. Replica clients **apply the delta** and never run game logic — so
  there is **zero determinism/rng/id-replay burden**. (Command-replay was
  rejected: the engine has no single rng source and `generateId` is a global
  function, so making replicas re-execute deterministically would mean routing
  every rng draw — including the Confused fizzle gate on most actions — and every
  id-gen through one recordable source, a refactor where any missed site = silent
  divergence.)
- **Topology: client-resolves + shared store, built for smooth promotion to an
  authoritative server.** The acting client runs the resolver and appends
  `{command, delta}` to a shared ordered store that broadcasts. No game server
  today. The promotion path is preserved by one rule: **the resolver holds all
  authority** (engine `ProceduralViolation` guards + the single-writer/GM gate)
  and is not client-trusting, so the *same resolver code* becomes the server's
  authority later. Only the `SyncCoordinator` changes for the swap.
- **Scope: transport-agnostic core only.** Command schema, resolver, delta
  compute/apply, authorization gate, the id→instance resolution strategy,
  ordering + late-join, and a `SyncTransport` interface with an in-process
  implementation for tests. **No** concrete backend (Firestore/WebSocket) — that
  is a thin adapter, wired up alongside Spec 3.
- **NPCs are GM-issued commands.** Mobs are not in the party turn rotation, so mob
  actions (`escape`, mob attacks) and lifecycle (`beginCampaign`, `nextPlayer`)
  are authorized as **GM** commands, not turn-gated.
- **Reject ≠ fizzle.** An unauthorized/illegal command changes nothing and returns
  `{ rejected, reason }`. A Confused **fizzle** is a *legal* outcome — an accepted
  command whose delta carries the fumble.
- **Game authorization vs network authentication.** Spec 2 enforces game rules
  (turn order, GM-only, lifecycle state) given a claimed `actorId`. Proving a
  given connection may issue for that seat is a transport concern, deferred.

## Architecture — components

Seven independently-testable units (new dir `src/lib/sync/`):

1. **`Command`** — a serializable discriminated union over the action kinds + a
   live id→instance resolution. Every entity reference is an id; carries the
   `actorId` it acts for (or is a GM/lifecycle command). No live objects.
2. **`EntityIndex`** — `id → instance` resolution over the reachable-from-party
   graph. Built **transiently per command** from the same graph walk that produces
   the `before` snapshot (see Data flow), so it can never go stale. Covers
   characters, rooms, items, loot, material caches.
3. **`Resolver`** — `resolve(campaign, command, registry) → CommandResult`. Runs
   the authorization gate, resolves arg ids via `EntityIndex`, invokes the real
   engine action, and on success computes the delta; on auth/`ProceduralViolation`
   failure returns a rejection. Holds all authority; topology-independent.
4. **`DeltaComputer`** — diffs `before`/`after` per-entity snapshots (Spec 1
   `[SERIALIZE]`) into `{ changed, created, removed, campaignCore? }`.
5. **`DeltaApplier`** — applies a delta to a replica `Campaign` (drop removed;
   construct+hydrate created; re-apply changed onto existing instances; scoped
   pass-2 ref re-wire; apply campaignCore). Never runs game logic.
6. **`SyncTransport` (interface)** — `append(entry)`, `subscribe(fromSeq, handler)`,
   `loadSnapshot()`, `putSnapshot(seq, snapshot)`. An in-process implementation
   drives the tests and models CAS + total ordering.
7. **`SyncCoordinator` (the seam)** — `submit(command)`. Client-resolves wiring:
   resolve locally → on accept `append({seq, baseSeq, command, delta})`; inbound
   remote entries → `DeltaApplier`. The only unit that changes for the future
   authoritative-server swap.

## Command schema

```ts
type Command =
  // turn-actions — a PlayerCharacter, only legal on its turn
  | { kind: "move";   actorId: CharacterId; roomId: RoomId }
  | { kind: "attack"; actorId: CharacterId; targetId: CharacterId }
  | { kind: "equip";  actorId: CharacterId; itemId: ItemId; slot?: EquipmentSlot }
  | { kind: "unequip"; actorId: CharacterId; itemId: ItemId }
  | { kind: "craft";  actorId: CharacterId; recipeId: RecipeId }
  | { kind: "repair"; actorId: CharacterId; itemId: ItemId }
  | { kind: "pickUp"; actorId: CharacterId; itemIds: ItemId[] }
  | { kind: "drop";   actorId: CharacterId; itemIds: ItemId[] }
  | { kind: "takeFromLootBox"; actorId: CharacterId; lootId: LootId; itemIds: ItemId[] }
  | { kind: "putInLootBox";    actorId: CharacterId; lootId: LootId; itemIds: ItemId[] }
  | { kind: "transferKey"; actorId: CharacterId; itemId: ItemId; recipientId: CharacterId }
  | { kind: "consumeKey";  actorId: CharacterId; itemId: ItemId }
  | { kind: "use";        actorId: CharacterId; itemId: ItemId }
  | { kind: "placeLight"; actorId: CharacterId; itemId: ItemId }
  | { kind: "takeLight";  actorId: CharacterId; itemId: ItemId }
  | { kind: "harvest";    actorId: CharacterId; cacheId: MaterialCacheId }
  // setup — pre-start, on your own character
  | { kind: "selectArchetype"; actorId: CharacterId; archetypeId: ArchetypeId }
  | { kind: "joinCampaign";    actorId: CharacterId }
  // GM / lifecycle / NPC — issued by the GM
  | { kind: "beginCampaign" } | { kind: "endCampaign" }
  | { kind: "nextPlayer" } | { kind: "addPlayer"; characterId: CharacterId }
  | { kind: "leaveCampaign"; characterId: CharacterId } | { kind: "transferGM"; characterId: CharacterId }
  | { kind: "mobEscape"; mobId: CharacterId }
  | { kind: "mobAttack"; mobId: CharacterId; targetId: CharacterId };

type LogEntry = { seq: number; baseSeq: number; command: Command; delta: Delta };

type CommandResult =
  | { ok: true; delta: Delta }
  | { ok: false; rejected: true; reason: string };

type Delta = {
  changed: EntitySnapshot[];     // existing entities whose snapshot differs
  created: EntitySnapshot[];     // new entities (crafted item, spawned mob, drop box)
  removed: string[];             // ids no longer present
  campaignCore?: CampaignCoreSnapshot; // present iff campaign-level fields changed
};
```

`EntitySnapshot` is a tagged per-entity snapshot (`{ type, data }`) reusing Spec
1's `RoomSnapshot`/`CharacterSnapshot`/`ItemSnapshot`/`LootSnapshot`/
`MaterialCacheSnapshot`, so the applier can dispatch by `type`.

## Authorization gate (in `Resolver`)

- **Turn-action** → accepted only if `campaign.started && !campaign.finished &&
  command.actorId === campaign.activeCharacter.id`. This is the single-writer rule.
- **Setup** (`selectArchetype`, `joinCampaign`) → only before `started`, on an
  existing character.
- **GM/lifecycle/NPC** → only when the campaign has a valid GM and the lifecycle
  state permits it (e.g. `nextPlayer` requires `started`). The command asserts GM
  authority; *verifying the issuing connection is actually the GM* is the deferred
  authentication boundary — in the trusted-peers model the GM client self-asserts,
  and the future server re-checks it.
- After the gate passes, the engine's own `ProceduralViolation` guards catch the
  rest (affliction blocks, full inventory, unknown recipe, insufficient
  materials…), each turning into a rejection.
- **Replicas do not re-authorize.** Authorization runs once, at resolve time, on
  the resolving authority; replicas trust the ordered log and only apply deltas.

## Data flow

**Submit (client-resolves):** `SyncCoordinator.submit(command)`
1. `before = serializeCampaign(local)` — one reachable-from-party graph walk that
   also yields the transient `EntityIndex` (id→live-instance).
2. `Resolver`: authorize; resolve arg ids via `EntityIndex`; invoke the engine
   action.
   - **Reject** (auth fail / `ProceduralViolation`): **restore `local` from
     `before`** (Spec 1 `deserializeCampaign`), return `{ ok:false, reason }`. No
     append, no broadcast.
   - **Accept:** the engine has advanced `local`. `after =
     serializeCampaign(local)`. `delta = DeltaComputer.diff(before, after)`.
3. `transport.append({ seq: head+1, baseSeq: head, command, delta })` — a
   **compare-and-swap**: rejected as a conflict if `baseSeq !== head`. On conflict,
   the local state is already advanced, so the coordinator **rolls local back to
   `before`**, re-syncs to the new head (apply missed deltas), and the caller may
   retry the command.
4. On accepted append, periodically `putSnapshot` a checkpoint (configurable
   cadence).

**Receive (replica):** `transport.subscribe(fromSeq, …)` delivers entries in
`seq` order → `DeltaApplier.apply(local, entry.delta)`:
1. Drop `removed` ids (detach + deregister).
2. `created`: construct via the per-entity bare-constructor + `[HYDRATE]`, index.
3. `changed`: **re-apply the snapshot onto the existing instance** via its
   (idempotent) `[HYDRATE]` — identity must stay stable because other entities
   hold references.
4. Scoped **pass-2**: re-wire references among created+changed via the replica
   index.
5. Apply `campaignCore` (round, activeCharacterIndex, materials, …).

**Late-join / reload:** `transport.loadSnapshot()` → `deserializeCampaign(…,
{registry})` at seq S → `subscribe(S+1)` → apply deltas.

## Required touch-up to Spec 1: idempotent `[HYDRATE]`

Spec 1's `[HYDRATE]` seams push into arrays/maps assuming a freshly-constructed
instance; the `DeltaApplier` re-applies them onto **existing** instances, so each
seam must **reset its collections at the top of `[HYDRATE]`** before filling
(inventory items/keys, equipment map, occupants, scenes, light sources, exits,
loot/materials maps, affliction maps, etc.). Small, principled, and it makes the
seams re-runnable — exactly what delta-apply needs.

## Error handling

- **Rejection** (auth/illegal): no state change (atomic restore-from-before),
  `{ ok:false, reason }` surfaced to the issuing client; nothing broadcast.
- **Conflict** (CAS): local rolled back to `before`, re-synced to the new head;
  caller may retry. Rare under turn-based single-writer.
- **Fizzle** (Confused): an *accepted* entry whose delta carries the fumble.
- **Gap / out-of-order delivery:** replica buffers and/or `loadSnapshot` +
  resubscribe to heal.

## Testing

- **Per-action delta round-trip:** resolve on A, apply delta to B (same base),
  assert B equals A — for each command kind.
- **Two-client convergence (headline):** drive a representative mix (move, attack,
  craft — assert B receives the *same* minted ItemId, takeFromLootBox, equip, a
  Confused fizzle, a mob escape, a spawn) through the coordinator on A; assert
  `serializeCampaign(A) === serializeCampaign(B)` after every command.
- **Replica never rolls (invariant):** inject a throwing rng into the replica;
  applying deltas must never call it.
- **Authorization/single-writer:** non-active actor → rejected; non-GM
  lifecycle/NPC → rejected; setup-after-start → rejected; active actor → accepted;
  rejections leave state unchanged.
- **Atomicity:** a command that throws mid-action → rejected *and* resolver
  campaign byte-identical to before.
- **CAS/concurrency:** two entries sharing a `baseSeq` → second conflicts; after
  refetch + re-resolve it succeeds; final state converges.
- **Idempotent `[HYDRATE]`:** re-applying a "changed" delta on an existing instance
  doesn't duplicate collection entries.
- **Created/removed:** craft (created item, correct id + registry behavior),
  consumeKey/destroy (removed from replica + index), mob-defeat drop box (created
  loot).
- **Late-join:** N commands → checkpoint → fresh replica `loadSnapshot` + apply
  deltas-since → converges.

## Out of scope (later specs / integration)

- **Concrete transport/backend** (Firestore/Supabase/WebSocket) — a thin
  `SyncTransport` adapter, wired alongside Spec 3.
- **Network authentication / seat ownership** (which connection controls which
  character) — transport concern.
- **The authoritative-server topology itself** — the seam is built for it, but the
  server is not implemented here.
- **A/V/text comms** — Spec 3.
- **Optimistic UI / rollback animation niceties** beyond the atomic
  restore-on-reject — presentation concern.

## Docs

Per the living-documentation convention, the README gains a "Multiplayer sync"
section and the public `sync/` surface (`Command`, `SyncCoordinator`, `Resolver`,
`SyncTransport`, `Delta`) gets TSDoc once implemented.
