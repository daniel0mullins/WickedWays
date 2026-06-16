# Required connections in `buildMap`

**Date:** 2026-06-15
**Status:** Approved, ready for planning

## Problem

`buildMap` (`src/utils/build-map.ts`) wires a set of rooms into a navigable map
via a randomized spanning tree plus optional extra loop edges. It guarantees
every room is reachable, but callers have no way to require that two specific
rooms end up **directly adjacent** (sharing an exit). Some maps need this — e.g.
a boss room that must sit next to its antechamber, or a shop that must open onto
the entrance hall.

Note the existing behavior already satisfies a related-sounding requirement:
rooms do **not** need an exit in every direction, and every room is already
reachable from every other. Those are invariants to preserve, not things to
change. The only new capability is forced direct adjacency between caller-named
room pairs.

## Goal

Let callers specify pairs of rooms that must share a direct exit, honored during
map construction, while keeping the existing reachability guarantee intact.

## API change

Add one optional field to `BuildMapOptions`:

```ts
export interface BuildMapOptions {
  rng?: () => number;
  extraConnections?: number;
  /**
   * Pairs of rooms that must share a direct exit. Laid down before the
   * spanning tree so they're (almost) always honored. Best-effort: a pair is
   * skipped if it can't be placed (same room, already adjacent, or no free
   * direction left on either room). Order within a pair is irrelevant; exits
   * are bidirectional.
   */
  requiredConnections?: [IRoom, IRoom][];
}
```

Pairs are `IRoom` objects, consistent with the existing `rooms: IRoom[]`
signature (the utility works with room objects, not branded ids).

"Connected" means **direct adjacency** — the two rooms share a single exit and
its opposite, so a player can walk straight from one into the other in one move.

## Algorithm

`buildMap` becomes three phases (was two):

1. **Required edges first.** For each pair in `requiredConnections`, call the
   existing `connect(a, b, rng)`. It is already best-effort: it returns `false`
   for same-room, already-adjacent, or saturated pairs, which we simply skip.
   Placing these first pins the guaranteed adjacencies before the spanning tree
   and extra edges compete for direction slots.

2. **Spanning tree over components.** Required edges may already connect several
   rooms, so the tree step changes from "grow one connected room at a time" to
   "merge components until one remains." Track connected components with
   union-find seeded from each room's current `exits`, then link any room not yet
   in the main component to a main-component room that has a free direction,
   unioning as we go. Every room remains reachable, and the number of *added*
   tree edges is minimal because required edges already count toward
   connectivity.

3. **Extra connections.** Unchanged. Runs last on whatever direction slots
   remain, best-effort as today.

## Edge cases

- **Empty / single-room map** (`rooms.length <= 1`): returned untouched, as
  today. `requiredConnections` is ignored in this case.
- **Pair already satisfied** by an earlier required pair: the second `connect`
  returns `false` and is harmlessly skipped.
- **Impossible pair** — same room twice, or a room asked to hold more required
  edges than its 8 free directions allow: silently skipped (best-effort). No
  throw.
- **Required cycle**: if required edges form a cycle, the finished map
  legitimately has more than `n - 1` edges. That is the caller's explicit
  request, not a defect.
- **Pathological density invariant**: in phase 2, if *every* room already in the
  main component were saturated (all 8 exits filled by required edges), a
  straggler room could not be linked and would be unreachable. This only occurs
  with pathologically dense `requiredConnections`. Consistent with the
  best-effort contract, we document this invariant rather than throw.

## Testing

Add to `src/utils/build-map.test.ts`, using a seeded `rng`:

- A required pair ends up directly adjacent — both rooms list each other in
  `exits`, on opposite compass directions.
- Multiple required pairs are all honored.
- Reachability still holds (every room reachable from any start) when required
  edges are present.
- An impossible required pair (same room; or a room over-subscribed past 8
  required edges) is skipped without throwing, and the rest of the map still
  builds and stays reachable.
- Required connections coexist correctly with `extraConnections`.
- Determinism: same rooms + same seed + same `requiredConnections` produce the
  same wiring.

## Documentation

- Update the `buildMap` TSDoc to describe `requiredConnections`.
- Update the README "Rooms, the map, and scenes" section to mention the new
  option and its best-effort, direct-adjacency semantics.

## Out of scope

- Locked-door / key-gated connections (still emulated via scene preconditions).
- Required *reachability* (already guaranteed by the spanning tree).
- Grouped/cluster connection semantics.
- Any change to the `Room` class itself; this is purely a `buildMap` change.
