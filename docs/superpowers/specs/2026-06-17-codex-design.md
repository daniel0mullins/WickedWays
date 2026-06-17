# In-Campaign Codex — Design

**Date:** 2026-06-17
**Status:** Approved, pending implementation plan

## Summary

An in-campaign **Codex**: a party-wide record of every distinct *kind* of mob,
inventory item, keyring key, room, recipe, and material type that any player
character in the party has encountered. It is consultable at any time, by any
player, as a read-only view on the campaign.

The Codex serves two purposes in equal measure:

- **Reference** — what a thing is (a mob's stats, an item's properties, a
  recipe's components).
- **Memory aid** — where and when the party first encountered it.

Discovery/completion tracking ("you've found 12 of 30 materials") is explicitly
**out of scope**; it is a separate, future *achievements* mechanic. The Codex
stores enough structured data (`firstSeen` stamps, per-kind snapshots) that an
achievements system could later read from it without changes here.

## Scope

**In scope:** a `Codex` class and entry types in a new `src/lib/codex.ts`; a
`campaign.codex` read accessor; recording hooks at the six encounter sites; a
`RECORD_ENCOUNTER` symbol seam; unit + integration tests; README and TSDoc
updates.

**Out of scope:** achievements/completion tracking; any UI; per-player views;
a full encounter *log* (we keep only first-encounter); persistence/serialization
(not yet a concern in the engine).

## Data model

The Codex lives on `Campaign` as private state (`#codex`), exposed read-only via
`campaign.codex`. This mirrors existing party-wide state on the campaign
(materials pool, known recipes, archetypes, the existing `#encountered` mob
set). It is a new module `src/lib/codex.ts` holding the `Codex` class plus entry
types; `Campaign` instantiates and owns exactly one.

### Entry envelope

Every entry shares a common envelope plus a kind-specific snapshot:

```ts
type CodexKind = "mob" | "item" | "key" | "room" | "recipe" | "material";

interface CodexEntry<TKind extends CodexKind, TSnapshot> {
  kind: TKind;
  key: string;                    // synthetic grouping key (per-kind, see below)
  snapshot: TSnapshot;            // deep-frozen descriptive fields, kind-specific
  firstSeen: {
    round: number;                // campaign.round at discovery
    characterId: CharacterId | undefined; // who first encountered it; undefined only for party-attributed material drops (see Materials)
    roomId: RoomId | undefined;   // where; undefined for non-spatial discoveries
  };
}
```

### Synthetic grouping keys and snapshots

Mobs and items are always *instances*, never templates, so the Codex tracks
distinct *kinds* via a synthetic grouping key. Re-encountering an existing key
is a no-op (first-write-wins; preserves the original `firstSeen`).

| Kind | Grouping key | Snapshot fields |
|------|-------------|-----------------|
| `mob` | `name` | `{ name, description?, stats: { health, sanity, energy } }` |
| `item` | `${type}:${name}` | `{ name, type, slot?, twoHanded?, emitsLight? }` |
| `key` | `${keyCode}:${name}` | `{ name, keyCode, consumeOnUse }` |
| `room` | `RoomId` | `{ name, description }` |
| `recipe` | `RecipeId` | `{ id, materials?, keys?, outputName }` |
| `material` | the `ItemComponentType` literal | `{ type }` |

Mob entries deliberately expose **full stats** (Health/Sanity/Energy) — a proper
bestiary. Keys are their own kind, separate from items, matching the
"regular inventory items vs. keyring items" distinction.

Snapshots are **deep-frozen** at capture so consumers cannot mutate Codex state
through a returned reference.

## Recording: hooks and tamper protection

### Symbol seam

Following the established protected-mutation pattern (`CLAIM`, `EQUIP`,
`DEPOSIT_MATERIALS`, etc. in `src/lib/inventory.ts`), export a single symbol:

```ts
export const RECORD_ENCOUNTER = Symbol("recordEncounter");
```

`Campaign` implements `[RECORD_ENCOUNTER](input)`. Only engine-internal code
(Character / Mob / Campaign methods) calls it; external/scene code cannot forge
entries. The method:

- **ignores** the call if the encountering character is not a current party
  member (a mob picking up an item never populates the Codex — only party player
  characters do); a party-attributed material drop with no `characterId` has no
  character to reject and so passes this guard;
- stamps `firstSeen` from `campaign.round`, the encountering character, and that
  character's current room;
- applies first-write-wins on the synthetic key.

The `Codex` class's own mutation method stays internal to the `codex.ts` module;
`campaign.codex` exposes reads only.

### Hook points

| Kind | Hook point | Notes |
|------|-----------|-------|
| `mob` | `Campaign[NOTE_ENCOUNTERS]` | Already fires once per (character, mob) on room entry; record the mob snapshot here, reusing existing dedup. |
| `room` | `PlayerCharacter.move` → room entry | The same successful move that triggers `NOTE_ENCOUNTERS`; record the entered room. |
| `item` | `Character.addToInventory` | On successful pickup, when the character is a party member. |
| `key` | `Character.addToInventory` (keyring) + `Character.transferKey` | Recorded when picked up *or* received from another player. |
| `recipe` | `Campaign.discoverRecipe` | Already idempotent by id; record there. |
| `material` | `Character.harvest` **and** mob-drop deposit | See below. |

### Materials attribution

Materials enter the party pool by two paths, and **both** record to the Codex:

- **Harvest** (`Character.harvest`) — attributed to the harvesting character;
  room = the harvester's current room.
- **Mob drop** on knock-out — attributed to the mob's defeater / active player,
  with room = the drop room. The active player is known at knock-out time.

If, in the drop path, no single player can be attributed, `firstSeen.characterId`
is `undefined` (party-attributed), with the room still recorded. This is the only
case where `characterId` is `undefined`.

## Read API

`campaign.codex` exposes:

```ts
campaign.codex.mobs       // CodexEntry<"mob", ...>[]      (sorted by name)
campaign.codex.items      // CodexEntry<"item", ...>[]
campaign.codex.keys       // CodexEntry<"key", ...>[]
campaign.codex.rooms      // CodexEntry<"room", ...>[]
campaign.codex.recipes    // CodexEntry<"recipe", ...>[]
campaign.codex.materials  // CodexEntry<"material", ...>[]
campaign.codex.all        // every entry across kinds
campaign.codex.get(kind, key)  // single entry or undefined
campaign.codex.size            // total entry count
```

All returns are frozen snapshots, per-kind lists sorted by entry name. Reading
is consultable any time by any player — a plain read off the campaign with no
turn cost and no action-budget tick. There is no per-player view: every player
sees the same party-wide Codex.

## Error handling

Recording is best-effort and silent: a non-party encounterer or a re-encounter
is a no-op, never a throw. This deliberately departs from the
`ProceduralViolation` convention because populating the Codex is passive
metadata, not a player-driven lifecycle action, and must never break the turn
loop (the same reasoning that sandboxes the presentation cue stream). The only
throwing path is genuinely malformed input through the symbol seam, which would
be an engine bug rather than an illegal game state.

## Testing

- **Unit** — co-located `src/lib/codex.test.ts` for the `Codex` class: record,
  dedup / first-write-wins, frozen snapshots, per-kind sorting, `get`, `size`.
- **Hook sites** — additions to the relevant existing hook-site tests asserting
  that each hook records the expected entry (and that non-party characters do
  not).
- **Integration** — additions to `src/integration.test.ts`: a scripted
  mini-campaign that enters a room, fights a mob, picks up an item, receives a
  key, learns a recipe, harvests a material, and takes a mob-drop material, then
  asserts the Codex contains exactly the expected entries across all six kinds
  with correct `firstSeen` stamps. Deterministic via the seeded `rng`.

## Documentation

Per the project convention, update `README.md` with a Codex section and add
TSDoc to the new public surface before the work is considered done.
