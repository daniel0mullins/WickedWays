# Campaign Serialization — Design

**Date:** 2026-06-17
**Status:** Approved

## Problem

The engine needs to **serialize, store, and deserialize an entire campaign** so a
game can be saved and resumed. Today there is no serialization of any kind. The
obstacle is that a `Campaign` is mostly *code*, not data: scenes carry
`script`/`preconditions`, recipes carry `create()`, formations carry `build()`,
items carry action callbacks, characters carry an injected `rng`. None of that
survives `JSON.stringify`. The object graph is also densely circular
(character ↔ campaign, room ↔ occupants, item ↔ holder) and much of its state is
hidden behind private `#fields` and `Symbol`-keyed seams.

This spec covers **save/load on a single engine instance** — a full-campaign
snapshot that round-trips and lets play continue. It is the foundation for, but
does not include, multi-client synchronization.

## Goal

A self-contained snapshot of a live `Campaign` that can be written to storage as
plain data (JSON) and later rebuilt into a fully wired, playable `Campaign` —
with all cross-references, protected state, persisted scene state, and in-flight
turn budget intact.

## Decisions

Settled during brainstorming:

- **Self-contained data snapshot + behavior registry.** The snapshot is pure
  data describing every entity by ID. The non-serializable *behaviors* are
  supplied at restore from a **registry** keyed by stable strings. This was
  chosen over a "rerun a deterministic `buildCampaign()` and overlay state"
  approach because a self-contained snapshot does not depend on a specific
  builder version being present — only on behavior keys resolving.
- **The registry covers everything carrying author-supplied closures.** Mobs and
  characters rebuild their behavior from data (`Mob.escape` is class logic driven
  by `baseEscapeChance`; character action wiring is set in the constructor), so
  they need **no** registry key. But **non-key items** carry author-supplied
  `actions`/`events` closures (`use`, `onEquip`, …) — the only engine item factory
  is `createKey`, which builds no-op keys; every other `Item` is author-built — so
  items join the registry. The registry's four behavior-keyed types are: **scenes**
  (`{script, preconditions}`), **recipes** (`{create, materials|keys}`),
  **formations** (`{build}`), and **non-key items** (a factory `() => Item`).
- **Keys are exempt.** A key is fully defined by `{name, keyCode, consumeOnUse}`
  and is rebuilt with the engine's `createKey(...)` factory — no registry key, no
  `behaviorKey` on the snapshot.
- **IDs stay random for this spec.** A self-contained snapshot stores each
  entity's actual ID and restore reconstructs entities carrying those exact IDs,
  so save→load round-trips perfectly with the existing random UUIDs. Making IDs
  *agree across clients* is a synchronization concern and is out of scope here.
- **Symbol seams for serialize/hydrate.** Reading protected `#state` and writing
  it back on restore go through gated `Symbol`s (`SERIALIZE`/`HYDRATE`), matching
  the codebase convention — not public setters. Hydrate writes state directly,
  bypassing action budgets and lifecycle guards (restoring is not replaying).
- **Two-pass reconstruction.** Pass 1 instantiates every entity by ID into an
  `id → instance` index; pass 2 resolves stored ID references to wire the graph.
  Two passes handle the circular references cleanly.
- **Backward compatible.** Behavior-bearing constructors gain an *optional*
  `behaviorKey`. Inline construction (no key) keeps working for tests and
  non-persisted use. Serializing a campaign **requires** every reachable
  behavior-bearing entity to have a resolvable key; the serializer throws,
  naming the offender, when one is missing.
- **Transient wiring is re-injected, not serialized.** The `rng`,
  `#cueHandlers`, and character lifecycle `events` are wiring, not game state.
  They are supplied at restore exactly as at construction.

## Architecture

Four pieces:

1. **`CampaignRegistry`** — maps stable string keys to author-authored
   behaviors across four namespaces: scene behaviors (`{script, preconditions}`),
   recipe definitions (`{create, materials | keys}`), formation definitions
   (`{build}`), and item factories (`() => Item`). It is the author's single
   source for these behaviors: construction attaches keys, restore resolves them.
   **One registry per campaign definition** (not a global singleton), so separate
   games cannot collide on keys. The live `Campaign` does not need to hold the
   registry during play.

2. **Serializer module** (`src/lib/serialization/`) — walks the campaign graph
   and emits a plain-data snapshot; the matching deserializer rebuilds it. Owns
   graph traversal, reference→ID conversion, ordering, validation, and
   versioning. Public surface: `serializeCampaign(campaign): CampaignSnapshot`
   and `deserializeCampaign(data, { registry, rng }): Campaign`.

3. **`SERIALIZE` / `HYDRATE` symbol seams** — each serializable class exposes a
   gated `[SERIALIZE]()` returning its own plain-data shape and a gated
   `[HYDRATE](data, ctx)` that reconstructs it. The serializer reaches protected
   `#state` (durability, scene `#state`, `#round`, occupants, `#origin`, …)
   through these seams. `ctx` carries the registry and the `id → instance` index.

4. **Two-pass reconstruction** — Pass 1: create every entity from its data,
   indexed by ID, behaviors looked up from the registry, `rng` injected. Pass 2:
   resolve all ID references to wire the graph (occupants, `currentRoom`, item
   holders, equipment, exits, party, gm, known recipes, encounter table).

## Snapshot shape

JSON, version-tagged:

```jsonc
{
  "schemaVersion": 1,
  "campaign": {
    "id": "...", "title": "...", "maxRounds": 20,
    "round": 4, "started": true, "finished": false,
    "activeCharacterIndex": 1,
    "actedThisRound": ["charId-a"],            // WeakMap → id list
    "materials": { "metal": 3, "healing": 1 },
    "claims": ["..."], "encountered": ["charId:mobId"],
    "knownRecipes": ["forge-sword"],           // registry keys (create() is a function)
    "archetypes": [{ "id": "scout", "name": "Scout", "statModifiers": { "energy": 1 },
                     "inventorySlots": 1, "immunities": [] }],  // pure data, no registry
    "gmId": "charId-a",
    "actionSounds": { "...": "assetRef" },
    "encounterTable": { "formations": [{ "behaviorKey": "crypt-pack", "weight": 3 }] }
  },
  "rooms": [{
    "id": "...", "name": "...", "description": "...",
    "exits": { "north": "roomId" }, "dark": false, "spawnModifier": 1,
    "occupantIds": ["..."], "lootIds": ["..."], "lightSourceIds": ["..."],
    "scenes": [{ "id": "...", "behaviorKey": "crypt-trap", "phase": "enter", "state": { } }],
    "presentation": null
  }],
  "characters": [{
    "kind": "player",                          // "player" | "mob"
    "id": "...", "name": "...", "stats": { "health": 8, "sanity": 5, "energy": 6 },
    "actionsPerRound": 3, "actionsThisRound": 1, "currentRoomId": "roomId",
    "inventory": { "slots": 5, "itemIds": ["..."], "keyIds": ["..."] },
    "equipment": { "weapon": "itemId" },
    "history": [ /* ActionHistoryEntry[] verbatim */ ],
    "archetypeImmunities": ["..."],
    "afflictions": {                            // full episode state (Status.* keys)
      "active": { "fear": true }, "turnsActive": { "fear": 2 },
      "shakenOff": ["panic"], "immunity": { "confused": 3 }
    },
    "archetypeId": "scout",                     // player-only, if selected
    // mob-only:
    "origin": "room", "baseEscapeChance": 25,
    "materialDrops": { "metal": 1 }, "lightAverse": true
  }],
  "items": [
    // non-key item: factory (by behaviorKey) reproduces all static config;
    // snapshot carries only id + key + mutable state
    { "id": "...", "behaviorKey": "healing-potion",
      "durability": 3, "equipped": false, "modifier": 0 },
    // key: rebuilt by the engine createKey() factory from its config (no behaviorKey)
    { "id": "...", "kind": "key",
      "name": "Brass Key", "keyCode": "crypt", "consumeOnUse": false }
  ],
  "loot": [{ "id": "...", "capacity": 4, "contentIds": ["..."], "presentation": null }],
  "codex": [ /* already-frozen CodexEntry data, verbatim */ ]
}
```

Notes:
- Item holder back-references (`HELD_BY`) are not stored on the item; they are
  re-established in pass 2 from each holder's `itemIds`/`keyIds` and `contentIds`.
- Item snapshots discriminate on `item.type === "key"`: a key carries
  `kind: "key"` plus its `createKey` config; every other item carries a
  `behaviorKey` and only its mutable state (the registered factory reproduces all
  static config).

## Data flow

**Serialize** — `serializeCampaign(campaign)`:
1. Validate: every reachable scene/recipe/formation has a `behaviorKey` that the
   author has registered; otherwise throw, naming the offender.
2. Walk the graph; each entity emits `[SERIALIZE]()` with references as IDs.
3. Assemble the top-level snapshot with `schemaVersion`.
4. Return the data object (the caller stringifies / stores it).

**Restore** — `deserializeCampaign(data, { registry, rng })`:
1. Check `schemaVersion`; run `migrate(data)` to upgrade older snapshots; reject
   unknown/newer versions with a clear message.
2. **Pass 1:** instantiate every entity by ID via `[HYDRATE]`, behaviors from the
   registry, `rng` injected — into an `id → instance` index.
3. **Pass 2:** resolve all ID references to wire the graph (occupants,
   `currentRoom`, item holders, equipment, exits, party, gm, known recipes,
   encounter table).
4. Restore each character's afflictions in full via the hydrate seam (no
   reconcile-from-stats pass).
5. Return a live `Campaign`, ready to continue play.

## Correctness edges

- **Afflictions are restored in full, not recomputed.** `Afflictions` carries
  episode state that is **not** derivable from stats — `#active`, `#turnsActive`
  (drives clear odds), `#shakenOff`, and `#immunity` (timed). All four are
  serialized and restored verbatim through a new `Afflictions` hydrate seam, so a
  load reproduces the exact in-flight affliction situation. (`archetypeImmunities`,
  a separate `Character` field of passive immunities, is also serialized verbatim.)
  Stats are restored directly; no reconcile-from-stats pass is needed.
- **Codex gets a hydrate seam.** `Codex.record()` only accepts live encounter
  *events* and re-derives snapshots, which is wrong for restore. A new gated seam
  injects the already-frozen `CodexEntry` data directly, preserving each entry's
  original `firstSeen` stamp.
- **Mid-turn fidelity.** `actionsThisRound` and `actedThisRound` are serialized,
  so a save taken mid-turn resumes with the correct remaining budget and turn
  order — not only at clean round boundaries.
- **Recipe/formation definitions live in the registry, keyed.** The registry
  entry holds the whole authored definition (recipe `{create, materials|keys}`,
  formation `{build}`). The snapshot stores only the key; for the encounter
  table it also stores per-formation `weight` (table composition).
- **Integrity is fail-fast.** On restore, a `behaviorKey` absent from the supplied
  registry throws ("no behavior '…'"); a reference ID that does not resolve in
  pass 2 throws ("dangling … id"). No silent partial restores.
- **Versioning seam now, migrations later.** `schemaVersion` is an integer; restore
  runs `migrate(data)` before hydrate. v1 ships the gate only (reject
  unknown/newer versions); the migration chain grows as the schema evolves.

## Testing

- **Round-trip per entity type:** a campaign exercising rooms+exits, players,
  mobs, items with durability, equipped gear, keys, loot, scenes with persisted
  `#state`, known recipes, materials pool, and codex entries — serialize →
  deserialize → assert structural and value equality, including resolved
  cross-refs (occupants, holders, equipment, `currentRoom`).
- **Circular refs survive:** after restore, `character.campaign === campaign`,
  `room.occupants` contains the same character instances, item holder back-refs
  resolve.
- **Mid-turn fidelity:** save with a partial budget, restore, assert the active
  character's remaining actions and the round/turn pointer match.
- **Affliction fidelity:** a character with an active, multi-turn affliction
  (non-zero `turnsActive`), a shaken-off status, and a timed immunity restores
  with all four affliction maps identical — not recomputed from stats.
- **Behavior reattach:** a restored scene's `script` fires and mutates its
  restored `#state`; a restored non-key item's author `use` effect still fires; a
  restored key opens its lock; a restored recipe crafts; a restored formation
  spawns.
- **Fail-fast:** serialize throws when a reachable scene/recipe/formation/non-key
  item lacks a `behaviorKey`; deserialize throws on an unknown key, on a dangling
  reference, and on an unknown `schemaVersion`.
- **Full integration:** round-trip a campaign, then *continue playing* it
  (advance a turn, craft, move) and assert it behaves identically to one that was
  never serialized.

## Out of scope

Deferred to later specs (synchronization, communication):

- **Deltas / patches** — only full snapshots here.
- **The command/intent log** and resolved-effect broadcast.
- **Cross-client ID agreement** and **deterministic / seeded rng**.
- **Any transport** (backend store, server, peers, signaling).

## Docs

Per the project's living-documentation convention, the README and the relevant
TSDoc must describe campaign serialization, the registry, and the `behaviorKey`
authoring requirement once implemented.
