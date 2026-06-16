# Required Connections in buildMap — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let callers of `buildMap` specify pairs of rooms that must share a direct exit, honored during map construction while every room stays reachable.

**Architecture:** Add an optional `requiredConnections: [IRoom, IRoom][]` field to `BuildMapOptions`. `buildMap` gains a phase before the spanning tree that lays down the required edges (best-effort, reusing the existing `connect` helper). The spanning-tree phase becomes component-aware via union-find so it merges the components those required edges create instead of assuming one room at a time. The extra-connections phase is unchanged.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`), Vitest. No new dependencies.

---

## Spec

See `docs/superpowers/specs/2026-06-15-required-connections-design.md`.

## File structure

- **Modify** `src/utils/build-map.ts` — add the option to `BuildMapOptions`, add required-edges phase, make the spanning tree component-aware. The `connect`, `areAdjacent`, `freeDirections`, `resolveExtraConnections`, and `shuffle` helpers are reused unchanged.
- **Modify** `src/utils/build-map.test.ts` — add a `requiredConnections` describe block.
- **Modify** `README.md` — extend the "Rooms, the map, and scenes" bullet about `buildMap`.

The whole feature lives in one small utility file; no decomposition needed.

---

### Task 1: Add `requiredConnections` option and component-aware spanning tree

**Files:**
- Modify: `src/utils/build-map.ts`
- Test: `src/utils/build-map.test.ts`

- [ ] **Step 1: Write the failing test**

Add this describe block to `src/utils/build-map.test.ts`, after the `extraConnections` block (before the `determinism` block). It asserts a single required pair ends up directly adjacent on opposite compass directions.

```ts
  describe("requiredConnections", () => {
    function directionBetween(a: IRoom, b: IRoom): string | undefined {
      for (const [dir, dest] of a.exits.entries()) {
        if (dest === b) return dir;
      }
      return undefined;
    }

    it("makes a required pair directly adjacent on opposite directions", () => {
      const rooms = makeRooms(12);
      const [a, b] = [rooms[0]!, rooms[7]!];

      buildMap(rooms, { rng: makeRng(42), requiredConnections: [[a, b]] });

      const dir = directionBetween(a, b);
      expect(dir).toBeDefined();
      expect(b.exits.get(OPPOSITE[dir!]! as keyof ExitsArg)).toBe(a);
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/utils/build-map.test.ts -t "makes a required pair directly adjacent"`
Expected: FAIL — `requiredConnections` is not yet an accepted option, so `a` and `b` are not guaranteed adjacent (`dir` is `undefined`).

- [ ] **Step 3: Add the option to the interface**

In `src/utils/build-map.ts`, add the field to `BuildMapOptions` (after `extraConnections`):

```ts
  /**
   * Pairs of rooms that must share a direct exit. Laid down before the
   * spanning tree so they're (almost) always honored. Best-effort: a pair is
   * skipped if it can't be placed (same room, already adjacent, or no free
   * direction left on either room). Order within a pair is irrelevant; exits
   * are bidirectional.
   */
  requiredConnections?: [IRoom, IRoom][];
```

- [ ] **Step 4: Lay down required edges and make the spanning tree component-aware**

In `src/utils/build-map.ts`, replace the body of `buildMap` from the `const { ... } = options;` line through the end of the spanning-tree `for` loop (i.e. everything before the `const extra = resolveExtraConnections(...)` line) with the following. The extra-connections block and `return rooms;` stay exactly as they are.

```ts
  const {
    rng = Math.random,
    extraConnections = 0,
    requiredConnections = [],
  } = options;

  if (rooms.length <= 1) {
    return rooms;
  }

  // Phase 1: honor required adjacencies first, before the tree and extras
  // compete for direction slots. connect() is best-effort: it returns false
  // for same-room, already-adjacent, or saturated pairs, which we skip.
  for (const [a, b] of requiredConnections) {
    connect(a, b, rng);
  }

  // Phase 2: spanning tree over the components the required edges created.
  // Union-find tracks which rooms are already mutually reachable so we only
  // add the filler edges needed to merge everything into one component.
  const parent = new Map<IRoom, IRoom>();
  const find = (room: IRoom): IRoom => {
    let root = room;
    while (parent.get(root) !== root) {
      root = parent.get(root)!;
    }
    let cursor = room;
    while (parent.get(cursor) !== root) {
      const next = parent.get(cursor)!;
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };
  const union = (a: IRoom, b: IRoom): void => {
    parent.set(find(a), find(b));
  };

  for (const room of rooms) {
    parent.set(room, room);
  }
  for (const room of rooms) {
    for (const neighbor of room.exits.values()) {
      union(room, neighbor);
    }
  }

  const order = shuffle(rooms, rng);
  const anchor = order[0]!;
  const connected: IRoom[] = order.filter((r) => find(r) === find(anchor));

  for (const room of order) {
    if (find(room) === find(anchor)) {
      continue;
    }
    const candidates = connected.filter((r) => freeDirections(r).length > 0);
    // Only empty if every room already in the main component is saturated,
    // which requires pathologically dense requiredConnections. Best-effort:
    // skip rather than throw (the straggler stays unreachable).
    if (candidates.length === 0) {
      continue;
    }
    const target = candidates[Math.floor(rng() * candidates.length)]!;
    if (connect(target, room, rng)) {
      union(target, room);
      for (const r of order) {
        if (find(r) === find(anchor) && !connected.includes(r)) {
          connected.push(r);
        }
      }
    }
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/utils/build-map.test.ts -t "makes a required pair directly adjacent"`
Expected: PASS

- [ ] **Step 6: Run the whole build-map suite to confirm no regressions**

Run: `npx vitest run src/utils/build-map.test.ts`
Expected: PASS — all existing spanning-tree, extraConnections, and determinism tests still green (with no `requiredConnections`, the union-find starts as all singletons and produces the same `n - 1` tree).

- [ ] **Step 7: Commit**

```bash
git add src/utils/build-map.ts src/utils/build-map.test.ts
git commit -m "feat: requiredConnections option in buildMap"
```

---

### Task 2: Edge-case and regression coverage

These exercise the behavior built in Task 1 — they guard the best-effort contract, reachability, and determinism. They should pass immediately against the Task 1 implementation.

**Files:**
- Test: `src/utils/build-map.test.ts`

- [ ] **Step 1: Add the coverage tests**

Add these `it` blocks inside the `requiredConnections` describe block created in Task 1.

```ts
    it("honors multiple required pairs at once", () => {
      const rooms = makeRooms(12);
      const pairs: [IRoom, IRoom][] = [
        [rooms[0]!, rooms[1]!],
        [rooms[2]!, rooms[3]!],
        [rooms[4]!, rooms[5]!],
      ];

      buildMap(rooms, { rng: makeRng(7), requiredConnections: pairs });

      for (const [a, b] of pairs) {
        expect([...a.exits.values()]).toContain(b);
        expect([...b.exits.values()]).toContain(a);
      }
    });

    it("keeps every room reachable with required edges present", () => {
      const rooms = makeRooms(12);

      buildMap(rooms, {
        rng: makeRng(3),
        requiredConnections: [
          [rooms[0]!, rooms[11]!],
          [rooms[5]!, rooms[6]!],
        ],
      });

      expect(reachableCount(rooms[0]!)).toBe(12);
    });

    it("skips a self-pair without throwing and still builds the map", () => {
      const rooms = makeRooms(12);

      expect(() =>
        buildMap(rooms, {
          rng: makeRng(9),
          requiredConnections: [[rooms[0]!, rooms[0]!]],
        }),
      ).not.toThrow();

      expect(rooms[0]!.exits.values()).not.toContain(rooms[0]!);
      expect(reachableCount(rooms[0]!)).toBe(12);
    });

    it("skips required edges beyond a room's 8-direction capacity", () => {
      // 10 partners all required-adjacent to one hub: at most 8 can attach.
      const rooms = makeRooms(11);
      const hub = rooms[0]!;
      const pairs = rooms.slice(1).map((r) => [hub, r] as [IRoom, IRoom]);

      buildMap(rooms, { rng: makeRng(11), requiredConnections: pairs });

      expect(hub.exits.size).toBeLessThanOrEqual(8);
      expect(reachableCount(rooms[0]!)).toBe(11);
    });

    it("coexists with extraConnections", () => {
      const rooms = makeRooms(12);

      buildMap(rooms, {
        rng: makeRng(5),
        requiredConnections: [[rooms[0]!, rooms[1]!]],
        extraConnections: 3,
      });

      expect([...rooms[0]!.exits.values()]).toContain(rooms[1]!);
      expect(reachableCount(rooms[0]!)).toBe(12);
      for (const room of rooms) {
        expect(room.exits.size).toBeLessThanOrEqual(8);
      }
    });

    it("is deterministic for the same seed and required pairs", () => {
      const build = () => {
        const rooms = makeRooms(15);
        return buildMap(rooms, {
          rng: makeRng(42),
          requiredConnections: [[rooms[0]!, rooms[9]!]],
          extraConnections: 2,
        });
      };

      expect(exitSignature(build())).toBe(exitSignature(build()));
    });
```

- [ ] **Step 2: Run the suite to verify all pass**

Run: `npx vitest run src/utils/build-map.test.ts`
Expected: PASS — all new and existing tests green.

- [ ] **Step 3: Commit**

```bash
git add src/utils/build-map.test.ts
git commit -m "test: edge cases for buildMap requiredConnections"
```

---

### Task 3: Documentation

**Files:**
- Modify: `src/utils/build-map.ts` (TSDoc on `buildMap`)
- Modify: `README.md`

- [ ] **Step 1: Update the `buildMap` TSDoc**

In `src/utils/build-map.ts`, the `buildMap` doc comment currently reads (second paragraph):

```
 * First lays down a random spanning tree so every room is reachable, then adds
 * up to {@link BuildMapOptions.extraConnections} loop/shortcut edges. Each
 * connection is bidirectional, using opposite compass directions, and respects
 * the eight available directions per room. The same `rooms` array is returned
 * (mutated); a single room or empty array is returned untouched.
```

Replace that paragraph with:

```
 * First lays down any {@link BuildMapOptions.requiredConnections} as direct
 * adjacencies, then a random spanning tree so every room is reachable, then up
 * to {@link BuildMapOptions.extraConnections} loop/shortcut edges. Each
 * connection is bidirectional, using opposite compass directions, and respects
 * the eight available directions per room. Required connections are best-effort:
 * an impossible pair (same room, already adjacent, or no free direction) is
 * skipped. The same `rooms` array is returned (mutated); a single room or empty
 * array is returned untouched.
```

- [ ] **Step 2: Update the README**

In `README.md`, the `buildMap` bullet under "Rooms, the map, and scenes" currently ends:

```
  8 exits. `extraConnections` adds loops/shortcuts (an absolute count, or a fraction of `n - 1`
  when between 0 and 1), and an injectable `rng` makes generation deterministic.
```

Replace that sentence with:

```
  8 exits. `extraConnections` adds loops/shortcuts (an absolute count, or a fraction of `n - 1`
  when between 0 and 1), `requiredConnections` pins specific room pairs as direct neighbors
  before the tree is laid down (best-effort: an impossible pair is skipped), and an injectable
  `rng` makes generation deterministic.
```

- [ ] **Step 3: Run the full checks**

Run: `npm run checks`
Expected: lint, typecheck, and the full test suite all pass.

- [ ] **Step 4: Commit**

```bash
git add src/utils/build-map.ts README.md
git commit -m "docs: document buildMap requiredConnections"
```

---

## Self-review notes

- **Spec coverage:** API field (Task 1 Step 3); required-edges-first phase (Task 1 Step 4, Phase 1); component-aware spanning tree (Task 1 Step 4, Phase 2); best-effort skip of impossible pairs (Task 2 self-pair + 8-capacity tests); reachability preserved (Task 2 reachability test); coexists with extraConnections (Task 2); determinism (Task 2); docs TSDoc + README (Task 3). All spec sections covered.
- **Types:** `requiredConnections?: [IRoom, IRoom][]` used consistently across interface, implementation, and tests. `find`/`union` are local consts typed `(room: IRoom) => IRoom` / `(a, b) => void`. `IRoom` is already imported in both files.
- **No placeholders:** every code step shows complete code and an exact command with expected result.
