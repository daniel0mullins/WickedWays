# buildMap — Random Connected Map Generator

**Date:** 2026-06-05
**Status:** Approved

## Purpose

Take an array of already-constructed `IRoom`s and randomly wire them into a
single, fully-connected map by populating each room's `exits`. The result is a
procedurally generated dungeon in which every room is reachable from every other
room.

This lives in [src/utils/build-map.ts](../../../src/utils/build-map.ts).

## Domain Context

Rooms form a graph via `exits: Map<Direction, IRoom>` (see
[src/lib/room.ts](../../../src/lib/room.ts)). There are 8 compass directions
forming 4 opposite pairs:

- North ↔ South
- East ↔ West
- Northeast ↔ SouthWest
- Northwest ↔ Southeast

Each room has at most 8 exit slots (one per direction). Exits are added via the
existing mutable `room.addExit(direction, room)` method.

## Public API

```ts
interface BuildMapOptions {
  /** 0..1 random source. Default: Math.random. Inject for deterministic tests. */
  rng?: () => number;
  /** Loop/shortcut control beyond the spanning tree. Default: 0. */
  extraConnections?: number;
}

export function buildMap(rooms: IRoom[], options?: BuildMapOptions): IRoom[];
```

`buildMap` **mutates** the passed rooms (via `addExit`), consistent with the
existing mutable `Room` API, and returns the same array for chaining.

### `extraConnections` semantics

- Integer ≥ 1 → absolute number of extra edges to attempt.
- Value in `(0, 1)` → fraction of `(n - 1)` (e.g. `0.5` ≈ half as many loop
  edges as spanning-tree corridors).
- `0` (default) → pure maze: exactly one path between any two rooms.

Extra edges that cannot find a compatible room pair are skipped silently.

## Algorithm

1. **Guard.** `rooms.length <= 1` → return the array unchanged (nothing to
   connect).
2. **Spanning tree (connectivity).** Walk rooms in shuffled order. Connect each
   newly visited room to a random room already in the connected set. This
   produces exactly `n - 1` corridors and guarantees every room is reachable.
   Targets are chosen from connected rooms that still have a free slot so
   connectivity never stalls.
3. **Extra connections (loops).** Resolve `extraConnections` to a target count,
   then add that many edges between random room pairs that are not already
   directly connected, creating shortcuts and loops.

### `connect(a, b)` helper

- Picks a random direction `d` that is free on `a` whose opposite is free on
  `b`.
- Calls `a.addExit(d, b)` and `b.addExit(opposite(d), a)` — bidirectional.
- Refuses self-connection (`a === b`) and re-connecting an already-adjacent
  pair.
- Tries the remaining free directions before giving up; returns whether it
  succeeded.

## Edge Cases

- Empty array → returns `[]`.
- Single room → returned unchanged, no exits.
- A room whose 8 slots fill up simply receives no further edges.

## Testing

Vitest with an injected deterministic `rng`:

- **Exact structure:** with a fixed `rng`, assert the produced edge set.
- **Invariants** (over random and seeded runs):
  - Every room is reachable via BFS over `exits` (full connectivity).
  - All exits are bidirectional with correct opposite directions.
  - No room exceeds 8 exits.
  - No self-loops.
  - `extraConnections: 0` produces exactly `n - 1` undirected edges.
  - Empty / single-room inputs behave per edge cases above.
